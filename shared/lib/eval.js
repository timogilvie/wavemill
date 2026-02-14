// Shared eval module — LLM judge for scoring autonomous task execution.
// Builds on the eval-schema (HOK-697) types and rubric.

import { readFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getScoreBand } from './eval-schema.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';
const SCHEMA_VERSION = '1.0.0';
const MAX_RETRIES = 2;
const TIMEOUT_MS = 30_000;

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

function buildJudgePrompt(template, taskPrompt, prReviewOutput, interventions) {
  let interventionText = 'No interventions recorded.';
  if (interventions && interventions.length > 0) {
    interventionText = interventions
      .map((i, idx) => `${idx + 1}. [${i.severity || 'unknown'}] ${i.description}`)
      .join('\n');
  }

  return template
    .replace('{{TASK_PROMPT}}', taskPrompt)
    .replace('{{PR_REVIEW_OUTPUT}}', prReviewOutput)
    .replace('{{INTERVENTION_METADATA}}', interventionText);
}

async function callClaude(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY environment variable is required');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.EVAL_MODEL || DEFAULT_MODEL,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Anthropic API error (${res.status}): ${body}`);
    }

    const data = await res.json();
    const text = data.content?.[0]?.text;
    if (!text) {
      throw new Error('Empty response from Anthropic API');
    }
    return text;
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseJudgeResponse(raw) {
  // Strip markdown code fences if present
  const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();

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
export async function evaluateTask(input) {
  const {
    taskPrompt,
    prReviewOutput,
    interventions = [],
    issueId,
    prUrl,
    timeSeconds = 0,
    metadata = {},
  } = input;

  const model = process.env.EVAL_MODEL || DEFAULT_MODEL;
  const template = await loadPromptTemplate();
  const prompt = buildJudgePrompt(template, taskPrompt, prReviewOutput, interventions);

  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let raw;
    try {
      raw = await callClaude(prompt);
    } catch (err) {
      // Do not retry on timeout or network errors — only on parse failures
      throw err;
    }

    try {
      const { score, rationale, interventionFlags } = parseJudgeResponse(raw);
      const band = getScoreBand(score);

      return {
        id: randomUUID(),
        schemaVersion: SCHEMA_VERSION,
        originalPrompt: taskPrompt,
        modelId: model,
        modelVersion: model,
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
