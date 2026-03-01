/**
 * Review Engine - Core code review logic
 *
 * Provides a unified review interface for both PR reviews and local change reviews.
 * Handles configuration loading, template filling, LLM invocation with retry,
 * and response parsing.
 *
 * @module review-engine
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  type ReviewContext,
  type DesignContext,
} from './review-context-gatherer.ts';
import { callClaude, parseJsonFromLLM } from './llm-cli.ts';
import { loadWavemillConfig } from './config.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface ReviewFinding {
  severity: 'blocker' | 'warning';
  location: string;
  category: string;
  description: string;
}

export interface ReviewResult {
  verdict: 'ready' | 'not_ready';
  codeReviewFindings: ReviewFinding[];
  uiFindings?: ReviewFinding[];
  metadata?: {
    branch: string;
    files: string[];
    hasUiChanges: boolean;
    designContextAvailable: boolean;
    uiVerificationRun: boolean;
  };
}

export interface ReviewEngineOptions {
  /** Review model override (uses config if not specified) */
  model?: string;
  /** Timeout override in milliseconds (uses config default if not specified) */
  timeout?: number;
  /** Max retries (default: 2) */
  maxRetries?: number;
  /** Skip UI verification even if design context exists */
  skipUi?: boolean;
  /** Verbose logging */
  verbose?: boolean;
}

interface JudgeConfig {
  model: string;
  provider: string;
}

interface Config {
  judge: JudgeConfig;
}

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';
const DEFAULT_PROVIDER = 'claude-cli';
const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes
const DEFAULT_MAX_RETRIES = 2;
const SUPPORTED_PROVIDERS = ['claude-cli', 'anthropic'];

// ────────────────────────────────────────────────────────────────
// Configuration
// ────────────────────────────────────────────────────────────────

/**
 * Load judge configuration from .wavemill-config.json.
 * Falls back to defaults if not found or malformed.
 */
function loadConfig(repoDir: string): Config {
  const config = loadWavemillConfig(repoDir);

  const configModel = config.eval?.judge?.model || DEFAULT_MODEL;
  const configProvider = config.eval?.judge?.provider || DEFAULT_PROVIDER;

  // Validate provider
  if (!SUPPORTED_PROVIDERS.includes(configProvider)) {
    throw new Error(
      `Invalid review judge provider: "${configProvider}". Supported: ${SUPPORTED_PROVIDERS.join(', ')}`
    );
  }

  return {
    judge: { model: configModel, provider: configProvider },
  };
}

// ────────────────────────────────────────────────────────────────
// Prompt Template
// ────────────────────────────────────────────────────────────────

/**
 * Load the review prompt template from tools/prompts/review.md
 */
function loadPromptTemplate(): string {
  const promptPath = join(__dirname, '../../tools/prompts/review.md');
  if (!existsSync(promptPath)) {
    throw new Error(`Review prompt template not found at: ${promptPath}`);
  }
  return readFileSync(promptPath, 'utf-8');
}

/**
 * Format design context for the prompt.
 */
function formatDesignContext(ctx: DesignContext): string {
  const parts: string[] = [];

  if (ctx.designGuide) {
    parts.push('### Design Guide\n\n' + ctx.designGuide);
  }

  if (ctx.tailwindConfig) {
    parts.push('### Tailwind Config (Theme)\n\n```js\n' + ctx.tailwindConfig + '\n```');
  }

  if (ctx.componentLibrary) {
    parts.push(`### Component Library\n\n${ctx.componentLibrary}`);
  }

  if (ctx.cssVariables) {
    parts.push('### CSS Variables\n\n```css\n' + ctx.cssVariables + '\n```');
  }

  if (ctx.designTokens) {
    parts.push('### Design Tokens\n\n```json\n' + ctx.designTokens + '\n```');
  }

  if (ctx.storybook) {
    parts.push('### Storybook\n\nStorybook is configured in this repository.');
  }

  return parts.length > 0 ? parts.join('\n\n') : 'No design artifacts found.';
}

/**
 * Fill the prompt template with context.
 *
 * Substitutes:
 * - {{DIFF}}
 * - {{PLAN_CONTEXT}}
 * - {{TASK_PACKET_CONTEXT}}
 * - {{DESIGN_CONTEXT}}
 */
function fillPromptTemplate(
  template: string,
  context: ReviewContext,
  skipDesignContext: boolean
): string {
  const diff = context.diff || '(No diff available)';
  const plan = context.plan || 'No plan document provided.';
  const taskPacket = context.taskPacket || 'No task packet provided.';

  // Design context handling:
  // - If skipDesignContext is true OR designContext is null, set to null (which tells LLM to skip UI review)
  // - Otherwise, format design context for the prompt
  let designContext: string;
  if (skipDesignContext || context.designContext === null) {
    designContext = 'null';
  } else {
    designContext = formatDesignContext(context.designContext);
  }

  return template
    .replace('{{DIFF}}', diff)
    .replace('{{PLAN_CONTEXT}}', plan)
    .replace('{{TASK_PACKET_CONTEXT}}', taskPacket)
    .replace('{{DESIGN_CONTEXT}}', designContext);
}

// ────────────────────────────────────────────────────────────────
// LLM Invocation
// ────────────────────────────────────────────────────────────────

/**
 * Invoke LLM with retry logic.
 */
async function invokeLLMWithRetry(
  prompt: string,
  model: string,
  timeout: number,
  maxRetries: number
): Promise<string> {
  const result = await callClaude(prompt, {
    mode: 'sync',
    model,
    timeout,
    maxBuffer: 50 * 1024 * 1024, // 50MB for large diffs
    retry: true,
    maxRetries,
  });

  return result.text;
}

// ────────────────────────────────────────────────────────────────
// Response Parsing
// ────────────────────────────────────────────────────────────────

/**
 * Parse the LLM's JSON response into a ReviewResult.
 *
 * Expected format:
 * {
 *   "verdict": "ready" | "not_ready",
 *   "codeReviewFindings": [...],
 *   "uiFindings": [...]  // optional
 * }
 */
function parseReviewResponse(
  responseText: string,
  context: ReviewContext
): ReviewResult {
  const parsed = parseJsonFromLLM<any>(responseText);

  // Validate structure
  if (!parsed.verdict || !['ready', 'not_ready'].includes(parsed.verdict)) {
    throw new Error(`Invalid verdict in response: ${parsed.verdict}`);
  }

  if (!Array.isArray(parsed.codeReviewFindings)) {
    throw new Error('Missing or invalid codeReviewFindings array');
  }

  const result: ReviewResult = {
    verdict: parsed.verdict as 'ready' | 'not_ready',
    codeReviewFindings: parsed.codeReviewFindings,
    metadata: {
      branch: context.metadata.branch,
      files: context.metadata.files,
      hasUiChanges: context.metadata.hasUiChanges,
      designContextAvailable: context.designContext !== null,
      uiVerificationRun: false,
    },
  };

  // Include UI findings if present
  if (parsed.uiFindings && Array.isArray(parsed.uiFindings)) {
    result.uiFindings = parsed.uiFindings;
    if (result.metadata) {
      result.metadata.uiVerificationRun = true;
    }
  }

  return result;
}

// ────────────────────────────────────────────────────────────────
// Main Entry Point
// ────────────────────────────────────────────────────────────────

/**
 * Run review on provided context.
 *
 * Core engine that handles:
 * 1. Configuration loading
 * 2. Template loading and filling
 * 3. LLM invocation with retry
 * 4. Response parsing
 *
 * @param context - Review context (diff, task packet, plan, design context)
 * @param repoDir - Repository directory for config loading
 * @param options - Optional overrides for model, timeout, retry behavior
 * @returns ReviewResult with verdict and findings
 */
export async function runReview(
  context: ReviewContext,
  repoDir: string,
  options: ReviewEngineOptions = {}
): Promise<ReviewResult> {
  // Load configuration
  const config = loadConfig(repoDir);

  // Determine effective settings (options override config)
  const model = options.model || config.judge.model;
  const timeout = options.timeout || DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const skipDesignContext = options.skipUi === true;

  if (options.verbose) {
    console.error('=== Review Engine Configuration ===');
    console.error(`Model: ${model}`);
    console.error(`Timeout: ${timeout}ms`);
    console.error(`Max retries: ${maxRetries}`);
    console.error(`Skip UI: ${skipDesignContext}`);
    console.error(`Design context available: ${context.designContext !== null}`);
    console.error(`UI changes detected: ${context.metadata.hasUiChanges}`);
    console.error('');
  }

  // Load prompt template
  const template = loadPromptTemplate();

  // Fill prompt
  const prompt = fillPromptTemplate(template, context, skipDesignContext);

  if (options.verbose) {
    console.error('=== Review Prompt ===');
    console.error(prompt.substring(0, 500) + '...');
    console.error('');
  }

  // Invoke LLM
  if (options.verbose) {
    console.error(`Invoking ${model}...`);
  }

  const responseText = await invokeLLMWithRetry(prompt, model, timeout, maxRetries);

  if (options.verbose) {
    console.error('=== LLM Response ===');
    console.error(responseText);
    console.error('');
  }

  // Parse response
  const result = parseReviewResponse(responseText, context);

  return result;
}
