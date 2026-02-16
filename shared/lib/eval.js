// Shared eval module — LLM judge for scoring autonomous task execution.
// Builds on the eval-schema (HOK-697) types and rubric.

import { readFile } from 'fs/promises';
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { tmpdir } from 'os';
import { getScoreBand } from './eval-schema.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';
const DEFAULT_PROVIDER = 'claude-cli';
const SUPPORTED_PROVIDERS = ['claude-cli', 'anthropic'];
const SCHEMA_VERSION = '1.0.0';
const MAX_RETRIES = 2;
const TIMEOUT_MS = 120_000;

/**
 * Load judge config from .wavemill-config.json.
 * Returns { model, provider } with defaults applied.
 * Validates provider against supported list.
 */
function loadJudgeConfig() {
  let configModel = DEFAULT_MODEL;
  let configProvider = DEFAULT_PROVIDER;

  const configPath = resolve('.wavemill-config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (config.eval?.judge?.model) {
        configModel = config.eval.judge.model;
      }
      if (config.eval?.judge?.provider) {
        configProvider = config.eval.judge.provider;
      }
    } catch {
      // Malformed config — use defaults
    }
  }

  // Validate provider
  if (!SUPPORTED_PROVIDERS.includes(configProvider)) {
    throw new Error(
      `Invalid eval judge provider: "${configProvider}". Supported providers: ${SUPPORTED_PROVIDERS.join(', ')}`
    );
  }

  // Validate model is non-empty
  if (typeof configModel !== 'string' || configModel.trim().length === 0) {
    throw new Error('Invalid eval judge model: model must be a non-empty string.');
  }

  return { model: configModel, provider: configProvider };
}

/**
 * @typedef {Object} InterventionMeta
 * @property {string} description - What the intervention was
 * @property {string} [severity] - 'minor' | 'major'
 */

/**
 * @typedef {Object} EvalInput
 * @property {string} taskPrompt - The original task description
 * @property {string} prReviewOutput - PR review text / diff summary
 * @property {InterventionMeta[]} [interventions] - Optional intervention metadata
 * @property {string} [interventionText] - Pre-formatted structured intervention text for the judge (overrides interventions list formatting)
 * @property {string} [issueId] - Linear issue ID (e.g. HOK-698)
 * @property {string} [prUrl] - Pull request URL
 * @property {number} [timeSeconds] - Wall-clock time for task completion
 * @property {Record<string, unknown>} [metadata] - Extra metadata to pass through
 */

let _promptTemplate = null;

async function loadPromptTemplate() {
  if (_promptTemplate) return _promptTemplate;
  const promptPath = join(__dirname, '../../tools/prompts/eval-judge.md');
  _promptTemplate = await readFile(promptPath, 'utf-8');
  return _promptTemplate;
}

function buildJudgePrompt(template, taskPrompt, prReviewOutput, interventions, interventionText) {
  let finalInterventionText;
  if (interventionText) {
    // Use pre-formatted structured intervention text (from intervention-detector)
    finalInterventionText = interventionText;
  } else if (interventions && interventions.length > 0) {
    // Fall back to legacy flat list format
    finalInterventionText = interventions
      .map((i, idx) => `${idx + 1}. [${i.severity || 'unknown'}] ${i.description}`)
      .join('\n');
  } else {
    finalInterventionText = 'No interventions recorded.';
  }

  return template
    .replace('{{TASK_PROMPT}}', taskPrompt)
    .replace('{{PR_REVIEW_OUTPUT}}', prReviewOutput)
    .replace('{{INTERVENTION_METADATA}}', finalInterventionText);
}

async function callClaude(prompt, model) {
  // Use the claude CLI (and the user's subscription) instead of a raw API key.
  // Write prompt to a temp file to avoid shell argument-length limits.
  const tmpFile = join(tmpdir(), `wavemill-eval-${Date.now()}.txt`);
  try {
    writeFileSync(tmpFile, prompt, 'utf-8');
    const raw = execSync(
      `claude -p --output-format json --model "${model}" < "${tmpFile}"`,
      { encoding: 'utf-8', timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, shell: '/bin/bash', env: { ...process.env, CLAUDECODE: '' } }
    );

    let text = '';
    let usage = null;
    let costUsd = undefined;
    try {
      const data = JSON.parse(raw);
      text = (data.result || '').trim();
      if (data.usage) {
        const u = data.usage;
        const inputTokens = (u.input_tokens || 0)
          + (u.cache_creation_input_tokens || 0)
          + (u.cache_read_input_tokens || 0);
        const outputTokens = u.output_tokens || 0;
        usage = {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        };
      }
      // Use the CLI's authoritative cost (accounts for cache pricing tiers)
      if (typeof data.total_cost_usd === 'number') {
        costUsd = data.total_cost_usd;
      }
    } catch {
      // If JSON parse fails, treat the entire output as text (fallback)
      text = raw.trim();
    }

    if (!text) {
      throw new Error('Empty response from claude CLI');
    }

    return { text, usage, costUsd };
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

/**
 * Load the pricing table from .wavemill-config.json.
 * Returns a map of model ID to { inputCostPerMTok, outputCostPerMTok }.
 */
function loadPricingTable() {
  const configPath = resolve('.wavemill-config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (config.eval?.pricing && typeof config.eval.pricing === 'object') {
        return config.eval.pricing;
      }
    } catch {
      // Malformed config — return empty
    }
  }
  return {};
}

/**
 * Compute estimated cost in USD from token usage and a pricing table.
 * Returns undefined if the model is not found in the pricing table.
 *
 * @param {string} modelId
 * @param {{ inputTokens: number, outputTokens: number }} usage
 * @param {Record<string, { inputCostPerMTok: number, outputCostPerMTok: number }>} pricingTable
 * @returns {number | undefined}
 */
function computeCost(modelId, usage, pricingTable) {
  if (!usage || !pricingTable) return undefined;

  const pricing = pricingTable[modelId];
  if (!pricing) return undefined;

  const inputCost = (usage.inputTokens * pricing.inputCostPerMTok) / 1_000_000;
  const outputCost = (usage.outputTokens * pricing.outputCostPerMTok) / 1_000_000;
  return inputCost + outputCost;
}

function parseJudgeResponse(raw) {
  // Strip markdown code fences if present
  let cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();

  // If the response has preamble before the JSON, extract the first { ... } block
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    cleaned = jsonMatch[0];
  }

  const parsed = JSON.parse(cleaned);

  if (typeof parsed.score !== 'number' || parsed.score < 0 || parsed.score > 1) {
    throw new Error(`Invalid score: ${parsed.score}. Must be a number between 0 and 1.`);
  }

  if (typeof parsed.rationale !== 'string' || parsed.rationale.trim().length === 0) {
    throw new Error('Rationale must be a non-empty string.');
  }

  if (!Array.isArray(parsed.interventionFlags)) {
    parsed.interventionFlags = [];
  }

  return {
    score: parsed.score,
    rationale: parsed.rationale.trim(),
    interventionFlags: parsed.interventionFlags,
  };
}

/**
 * Evaluate a task execution using an LLM judge.
 *
 * Returns an EvalRecord (as defined in eval-schema.ts) populated with
 * the judge's score, rationale, and the derived score band.
 *
 * @param {EvalInput} input
 * @returns {Promise<import('./eval-schema.ts').EvalRecord>}
 */
export async function evaluateTask(input, { _callFn } = {}) {
  const {
    taskPrompt,
    prReviewOutput,
    interventions = [],
    interventionText,
    issueId,
    prUrl,
    timeSeconds = 0,
    metadata = {},
  } = input;

  // Resolve judge model: env var > config file > default
  const judgeConfig = loadJudgeConfig();
  const model = process.env.EVAL_MODEL || judgeConfig.model;
  const provider = judgeConfig.provider;
  const pricingTable = loadPricingTable();

  const template = await loadPromptTemplate();
  const prompt = buildJudgePrompt(template, taskPrompt, prReviewOutput, interventions, interventionText);

  const callFn = _callFn || callClaude;
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response;
    try {
      response = await callFn(prompt, model);
    } catch (err) {
      // Do not retry on timeout or network errors — only on parse failures
      throw err;
    }

    try {
      const { score, rationale, interventionFlags } = parseJudgeResponse(response.text);
      const band = getScoreBand(score);

      const tokenUsage = response.usage || undefined;
      // Prefer the CLI's authoritative cost; fall back to pricing table estimate
      const estimatedCost = response.costUsd !== undefined
        ? response.costUsd
        : computeCost(model, tokenUsage, pricingTable);

      return {
        id: randomUUID(),
        schemaVersion: SCHEMA_VERSION,
        originalPrompt: taskPrompt,
        modelId: model,
        modelVersion: model,
        judgeModel: model,
        judgeProvider: provider,
        score,
        scoreBand: band.label,
        timeSeconds,
        timestamp: new Date().toISOString(),
        interventionRequired: interventions.length > 0,
        interventionCount: interventions.length,
        interventionDetails: interventions.map((i) => i.description),
        rationale,
        ...(issueId && { issueId }),
        ...(prUrl && { prUrl }),
        ...(tokenUsage && { tokenUsage }),
        ...(estimatedCost !== undefined && { estimatedCost }),
        metadata: { ...metadata, interventionFlags },
      };
    } catch (parseErr) {
      lastError = parseErr;
      // Retry on parse failures
    }
  }

  throw new Error(
    `Failed to parse LLM judge response after ${MAX_RETRIES + 1} attempts. Last error: ${lastError.message}`
  );
}
