/**
 * LLM-based model router — loads a DSPy-optimized artifact (system prompt +
 * few-shot examples) and calls Haiku to classify tasks for routing.
 *
 * Falls back gracefully (returns null) when no artifact exists or the LLM
 * call fails, allowing the heuristic router to take over.
 *
 * @module llm-router
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { execShellCommand } from './shell-utils.ts';
import { resolveWavemillAssetPath } from './native-agent/install-paths.ts';
import type { PromptCharacteristics, TaskType, ModelRecommendation } from './model-router.ts';
import { resolveAgent } from './model-router.ts';
import {
  recordRuntimeResourceSelection,
  resolveRuntimeResource,
  type RuntimeResourceSelection,
} from './resource-selection.ts';

// ────────────────────────────────────────────────────────────────
// Artifact Types
// ────────────────────────────────────────────────────────────────

export interface FewShotExample {
  task_prompt: string;
  repo_name: string;
  task_type_hint: string;
  available_models: string;
  recommended_model: string;
  recommended_agent: string;
  confidence: string;
  risk_flags: string[];
  cost_estimate: string;
  reasoning: string;
}

export interface SelectorArtifact {
  version: string;
  created_at: string;
  optimizer: string;
  teacher_model: string;
  runtime_model: string;
  system_prompt: string;
  few_shot_examples: FewShotExample[];
  model_candidates: string[];
  metadata: Record<string, unknown>;
}

export interface LLMRoutingResponse {
  recommended_model: string;
  recommended_agent: string;
  confidence: string;
  risk_flags: string[];
  cost_estimate: string;
  reasoning: string;
}

export interface LLMRouterOptions {
  repoDir?: string;
  repoName?: string;
  agentMap?: Record<string, string>;
  defaultAgent?: string;
  models?: string[];
  artifactPath?: string;
  llmModel?: string;
  llmProvider?: 'openai' | 'anthropic';
}

export interface LoadedSelectorArtifact {
  artifact: SelectorArtifact;
  selection: RuntimeResourceSelection;
}

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

const DEFAULT_ARTIFACT_PATH = 'dspy/artifacts/optimized-selector.json';
const DEFAULT_RUNTIME_MODEL = 'gpt-4o-mini';
const DEFAULT_PROVIDER = 'openai';
const TIMEOUT_MS = 15_000;
const MAX_PROMPT_LENGTH = 2000;

// ────────────────────────────────────────────────────────────────
// Artifact Loading
// ────────────────────────────────────────────────────────────────

/**
 * Load the DSPy-optimized selector artifact.
 * Returns null if the file doesn't exist or is malformed.
 */
export function loadArtifact(
  repoDir?: string,
  artifactPath?: string,
): SelectorArtifact | null {
  return loadArtifactWithSelection(repoDir, artifactPath)?.artifact || null;
}

export function loadArtifactWithSelection(
  repoDir?: string,
  artifactPath?: string,
): LoadedSelectorArtifact | null {
  const selection = artifactPath
    ? {
        surface: 'router' as const,
        variant: 'baseline' as const,
        requestedVariant: 'baseline' as const,
        resourceRef: null,
        uri: artifactPath,
        fallbackApplied: false,
      }
    : resolveRuntimeResource('router', { repoDir });
  const path = resolveWavemillAssetPath(
    artifactPath || selection.uri || DEFAULT_ARTIFACT_PATH,
  );
  if (!existsSync(path)) return null;

  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    if (!data.system_prompt || !Array.isArray(data.few_shot_examples)) {
      return null;
    }
    if (!artifactPath) {
      recordRuntimeResourceSelection(selection, {
        repoDir,
        phase: process.env.WAVEMILL_PHASE || 'unknown',
      });
    }
    return {
      artifact: data as SelectorArtifact,
      selection: {
        ...selection,
        ...(selection.uri ? {} : { uri: artifactPath || DEFAULT_ARTIFACT_PATH }),
      },
    };
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────
// Prompt Construction
// ────────────────────────────────────────────────────────────────

/**
 * Build the LLM prompt from artifact + current task.
 *
 * Format: system instruction, few-shot examples as input/output pairs,
 * then the current task as the final query.
 */
export function buildRoutingPrompt(
  artifact: SelectorArtifact,
  taskPrompt: string,
  repoName: string,
  taskTypeHint: TaskType,
  availableModels: string[],
): string {
  const parts: string[] = [];

  // System instruction (optimized by DSPy)
  parts.push(artifact.system_prompt);
  parts.push('');

  // Few-shot examples
  for (const ex of artifact.few_shot_examples) {
    parts.push('--- Example ---');
    parts.push(`Task: ${ex.task_prompt.slice(0, 500)}`);
    parts.push(`Repo: ${ex.repo_name}`);
    parts.push(`Type: ${ex.task_type_hint}`);
    parts.push(`Available Models: ${ex.available_models}`);
    parts.push('');
    parts.push('Decision:');
    parts.push(JSON.stringify({
      recommended_model: ex.recommended_model,
      recommended_agent: ex.recommended_agent,
      confidence: ex.confidence,
      risk_flags: ex.risk_flags,
      cost_estimate: ex.cost_estimate,
      reasoning: ex.reasoning,
    }));
    parts.push('');
  }

  // Current task
  parts.push('--- Current Task ---');
  parts.push(`Task: ${taskPrompt.slice(0, MAX_PROMPT_LENGTH)}`);
  parts.push(`Repo: ${repoName}`);
  parts.push(`Type: ${taskTypeHint}`);
  parts.push(`Available Models: ${availableModels.join(',')}`);
  parts.push('');
  parts.push('Decision (respond with JSON only):');

  return parts.join('\n');
}

// ────────────────────────────────────────────────────────────────
// LLM Calling
// ────────────────────────────────────────────────────────────────

/** Type for the injectable call function (for testing). */
export type CallFn = (prompt: string, model: string) => string;

/**
 * Call the OpenAI chat completions API synchronously.
 *
 * Uses a child process with inline Node.js to perform the async fetch,
 * keeping the main router interface synchronous.
 */
function callOpenAI(prompt: string, model: string): string {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not set — required for LLM router');
  }

  // Use a child process to make the async API call synchronously.
  // Pass data via env vars to avoid shell quoting issues with large prompts.
  const script = [
    `const resp = await fetch('https://api.openai.com/v1/chat/completions', {`,
    `  method: 'POST',`,
    `  headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env._ROUTER_KEY },`,
    `  body: JSON.stringify({ model: process.env._ROUTER_MODEL, messages: [{ role: 'user', content: process.env._ROUTER_PROMPT }], temperature: 0, max_tokens: 1000 }),`,
    `  signal: AbortSignal.timeout(${TIMEOUT_MS}),`,
    `});`,
    `if (!resp.ok) { process.stderr.write('OpenAI API ' + resp.status + ': ' + await resp.text()); process.exit(1); }`,
    `const data = await resp.json();`,
    `process.stdout.write(data.choices[0].message.content);`,
  ].join('\n');

  const raw = execShellCommand('node --input-type=module', {
    input: script,
    encoding: 'utf-8',
    timeout: TIMEOUT_MS + 5000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, _ROUTER_KEY: apiKey, _ROUTER_MODEL: model, _ROUTER_PROMPT: prompt },
  }) as string;

  return raw.trim();
}

/**
 * Default LLM call: routes to the configured provider.
 */
function defaultCallFn(prompt: string, model: string, provider?: string): string {
  return callOpenAI(prompt, model);
}

/**
 * Parse the LLM's JSON response, stripping markdown fences if present.
 */
export function parseRoutingResponse(text: string): LLMRoutingResponse | null {
  const cleaned = text
    .replace(/^```json?\n?/m, '')
    .replace(/\n?```$/m, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed.recommended_model) return null;
    return {
      recommended_model: parsed.recommended_model,
      recommended_agent: parsed.recommended_agent || '',
      confidence: parsed.confidence || 'low',
      risk_flags: Array.isArray(parsed.risk_flags) ? parsed.risk_flags : [],
      cost_estimate: parsed.cost_estimate || 'unknown',
      reasoning: parsed.reasoning || '',
    };
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────
// Main Entry Point
// ────────────────────────────────────────────────────────────────

/**
 * Derive the repo name from its directory path.
 */
function deriveRepoName(repoDir?: string): string {
  return basename(resolve(repoDir || '.'));
}

/**
 * Normalize confidence value to the expected enum.
 */
function normalizeConfidence(value: string): 'high' | 'medium' | 'low' {
  const v = value.toLowerCase();
  if (v === 'high') return 'high';
  if (v === 'medium') return 'medium';
  return 'low';
}

/**
 * Get a model recommendation using the LLM-based router.
 *
 * Returns null if the artifact is missing or the LLM call fails,
 * signaling the caller to fall back to the heuristic router.
 *
 * @param prompt - The task prompt text
 * @param characteristics - Pre-analyzed prompt characteristics
 * @param options - Configuration options
 * @param _callFn - Injectable call function (for testing)
 */
export function recommendModelLLM(
  prompt: string,
  characteristics: PromptCharacteristics,
  options: LLMRouterOptions = {},
  _callFn?: CallFn,
): ModelRecommendation | null {
  // 1. Load artifact
  const loaded = loadArtifactWithSelection(options.repoDir, options.artifactPath);
  if (!loaded) return null;
  const artifact = loaded.artifact;

  // 2. Determine available models
  const availableModels = options.models?.length
    ? options.models
    : artifact.model_candidates;

  // 3. Determine repo name
  const repoName = options.repoName || deriveRepoName(options.repoDir);

  // 4. Build prompt
  const routingPrompt = buildRoutingPrompt(
    artifact,
    prompt,
    repoName,
    characteristics.taskType,
    availableModels,
  );

  // 5. Call LLM
  const provider = options.llmProvider || DEFAULT_PROVIDER;
  const runtimeModel = options.llmModel || DEFAULT_RUNTIME_MODEL;
  const callFn = _callFn || ((p: string, m: string) => defaultCallFn(p, m, provider));

  let responseText: string;
  try {
    responseText = callFn(routingPrompt, runtimeModel);
  } catch {
    return null;
  }

  // 6. Parse response
  const response = parseRoutingResponse(responseText);
  if (!response) return null;

  // 7. Validate model selection
  if (!availableModels.includes(response.recommended_model)) {
    return null;
  }

  // 8. Build ModelRecommendation
  const agentMap = options.agentMap || {};
  const defaultAgent = options.defaultAgent || 'claude';

  return {
    recommendedModel: response.recommended_model,
    recommendedAgent:
      response.recommended_agent ||
      resolveAgent(response.recommended_model, agentMap, defaultAgent, undefined, 'coding'),
    confidence: normalizeConfidence(response.confidence),
    reasoning: `[LLM Router] ${response.reasoning}`,
    taskType: characteristics.taskType,
    promptCharacteristics: characteristics,
    candidates: [],
    insufficientData: false,
    riskFlags: response.risk_flags,
    costEstimate: response.cost_estimate,
    routingMode: 'llm',
    resourceSelections: [loaded.selection],
  };
}
