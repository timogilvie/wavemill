// Shared eval module — LLM judge for scoring autonomous task execution.
// Builds on the eval-schema (HOK-697) types and rubric.

import { readFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { randomUUID } from 'crypto';
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { getScoreBand } from './eval-schema.ts';
import { callClaude, parseJsonFromLLM } from './llm-cli.ts';
import { getEvalConfig } from './config.ts';
import { loadPricingTable } from './workflow-cost.ts';

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
  const evalConfig = getEvalConfig();
  const configModel = evalConfig.judge?.model || DEFAULT_MODEL;
  const configProvider = evalConfig.judge?.provider || DEFAULT_PROVIDER;

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
 * @property {InterventionMeta[]} [interventions] - Optional intervention metadata (legacy format)
 * @property {import('./eval-schema.ts').InterventionRecord[]} [interventionRecords] - Structured intervention events (new format)
 * @property {string} [interventionText] - Pre-formatted structured intervention text for the judge (overrides interventions list formatting)
 * @property {string} [issueId] - Linear issue ID (e.g. HOK-698)
 * @property {string} [prUrl] - Pull request URL
 * @property {number} [timeSeconds] - Wall-clock time for task completion
 * @property {import('./eval-schema.ts').RoutingDecision} [routingDecision] - Routing decision metadata (HOK-775)
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

async function callClaudeWithRetry(prompt, model) {
  const result = await callClaude(prompt, {
    mode: 'sync',
    model,
    timeout: TIMEOUT_MS, // 120000
    maxBuffer: 10 * 1024 * 1024,
    retry: true,
    maxRetries: MAX_RETRIES, // 2
  });

  return {
    text: result.text,
    usage: result.usage,
    costUsd: result.costUsd,
  };
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
  const parsed = parseJsonFromLLM(raw);

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
 * @param {import('./eval-schema.ts').Outcomes} [outcomes] - Optional pre-collected outcome components
 * @param {Object} [options] - Optional configuration
 * @param {Function} [options._callFn] - Override for the LLM call function (testing)
 * @returns {Promise<import('./eval-schema.ts').EvalRecord>}
 */
export async function evaluateTask(input, outcomes = undefined, options = {}) {
  const { _callFn } = options;
  const {
    taskPrompt,
    prReviewOutput,
    interventions = [],
    interventionRecords,
    interventionText,
    issueId,
    prUrl,
    timeSeconds = 0,
    routingDecision,
    metadata = {},
  } = input;

  // Determine which intervention format to use
  // If interventionRecords provided, prefer it; else use legacy interventions
  const hasStructuredInterventions = interventionRecords && interventionRecords.length > 0;
  const interventionsToUse = hasStructuredInterventions ? interventionRecords : interventions;
  const interventionCount = hasStructuredInterventions
    ? interventionRecords.length
    : interventions.length;

  // Resolve judge model: env var > config file > default
  const judgeConfig = loadJudgeConfig();
  const model = process.env.EVAL_MODEL || judgeConfig.model;
  const provider = judgeConfig.provider;
  const pricingTable = loadPricingTable();

  const template = await loadPromptTemplate();
  const prompt = buildJudgePrompt(template, taskPrompt, prReviewOutput, interventions, interventionText);

  const callFn = _callFn || callClaudeWithRetry;

  // Call Claude (with retry built-in)
  const response = await callFn(prompt, model);

  // Parse response
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
    interventionRequired: interventionCount > 0,
    interventionCount,
    interventionDetails: hasStructuredInterventions
      ? interventionRecords.map((i) => i.note)
      : interventions.map((i) => i.description),
    ...(hasStructuredInterventions && { interventions: interventionRecords }),
    rationale,
    ...(issueId && { issueId }),
    ...(prUrl && { prUrl }),
    ...(tokenUsage && { tokenUsage }),
    ...(estimatedCost !== undefined && { estimatedCost }),
    ...(outcomes && { outcomes }),
    ...(routingDecision && { routingDecision }),
    metadata: { ...metadata, interventionFlags },
  };
}
