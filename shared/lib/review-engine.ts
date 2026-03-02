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
// Module-level cache
// ────────────────────────────────────────────────────────────────

let _promptTemplate: string | null = null;

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
 * Caches the template after first load to avoid redundant disk reads.
 */
function loadPromptTemplate(): string {
  // Return cached template if available
  if (_promptTemplate) {
    return _promptTemplate;
  }

  // Load and cache template
  const promptPath = join(__dirname, '../../tools/prompts/review.md');
  if (!existsSync(promptPath)) {
    throw new Error(
      `Review prompt template not found at: ${promptPath}\n` +
      `  This is likely a repository installation issue.\n` +
      `  Troubleshooting:\n` +
      `    - Verify the tools/prompts/ directory exists\n` +
      `    - Check that review.md is present in that directory\n` +
      `    - If running from a symlinked install, verify symlinks are correct`
    );
  }

  try {
    _promptTemplate = readFileSync(promptPath, 'utf-8');
  } catch (error) {
    throw new Error(
      `Failed to read review prompt template at: ${promptPath}\n` +
      `  Error: ${(error as Error).message}\n` +
      `  Possible causes:\n` +
      `    - File permissions issue\n` +
      `    - File is corrupted\n` +
      `  Troubleshooting: Run 'cat ${promptPath}' to verify file is readable`
    );
  }

  return _promptTemplate;
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
// Response Validation
// ────────────────────────────────────────────────────────────────

/**
 * Check if response looks like JSON before attempting to parse.
 * Returns true if response appears to be valid JSON format.
 *
 * This is a quick heuristic check to detect conversational responses
 * before expensive parsing attempts.
 */
function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();

  // Check if it starts with { and ends with }
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return false;
  }

  // Quick heuristic: conversational responses usually have these patterns
  const conversationalPatterns = [
    /^(Sure|Ok|Okay|Let me|I'll|I will|Here's|Here is)/i,
    /I (will|would|can|cannot|should|have)/i,
    /(Based on|Looking at|After reviewing)/i,
  ];

  for (const pattern of conversationalPatterns) {
    if (pattern.test(trimmed)) {
      return false;
    }
  }

  return true;
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
  let parsed: any;

  try {
    parsed = parseJsonFromLLM<any>(responseText);
  } catch (error) {
    // Enhanced error message with response preview
    const preview = responseText.substring(0, 500);
    throw new Error(
      `Failed to parse review response: ${(error as Error).message}\n\n` +
      `First 500 chars of LLM response:\n${preview}\n\n` +
      `This usually means the LLM returned conversational text instead of JSON. ` +
      `Try running with --verbose to see the full response.`
    );
  }

  // Validate structure
  if (!parsed.verdict || !['ready', 'not_ready'].includes(parsed.verdict)) {
    const preview = responseText.substring(0, 500);
    throw new Error(
      `Invalid verdict in response: ${parsed.verdict}\n\n` +
      `First 500 chars of LLM response:\n${preview}`
    );
  }

  if (!Array.isArray(parsed.codeReviewFindings)) {
    const preview = responseText.substring(0, 500);
    throw new Error(
      `Missing or invalid codeReviewFindings array\n\n` +
      `First 500 chars of LLM response:\n${preview}`
    );
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
// Retry Logic
// ────────────────────────────────────────────────────────────────

/**
 * Run review with automatic retry for malformed responses.
 *
 * This wrapper implements a two-attempt strategy:
 * 1. First attempt with normal prompt
 * 2. If response is conversational or unparseable, retry with stricter prompt
 *
 * @param prompt - Filled review prompt
 * @param context - Review context
 * @param repoDir - Repository directory
 * @param model - Model to use
 * @param timeout - Timeout in milliseconds
 * @param maxRetries - Max retries for LLM calls
 * @param options - Review options
 * @param attempt - Current attempt number (internal)
 * @returns ReviewResult
 */
async function runReviewWithRetry(
  prompt: string,
  context: ReviewContext,
  repoDir: string,
  model: string,
  timeout: number,
  maxRetries: number,
  options: ReviewEngineOptions,
  attempt: number = 1
): Promise<ReviewResult> {
  const maxAttempts = 2;

  // Invoke LLM
  const responseText = await invokeLLMWithRetry(prompt, model, timeout, maxRetries);

  // Show raw response in verbose mode
  if (options.verbose) {
    console.error(`=== LLM Response (raw, attempt ${attempt}) ===`);
    console.error(responseText.substring(0, 2000));
    if (responseText.length > 2000) {
      console.error(`\n... (${responseText.length - 2000} more characters)`);
    }
    console.error('');
  }

  // Pre-validate response format
  if (!looksLikeJson(responseText)) {
    if (attempt < maxAttempts) {
      console.error(`⚠️  LLM returned conversational response (attempt ${attempt}/${maxAttempts})`);
      if (options.verbose) {
        console.error('Response preview:', responseText.substring(0, 200));
      }
      console.error('Retrying with stricter prompt...\n');

      // Retry with stricter prompt
      const strictPrompt =
        'CRITICAL: Respond with ONLY valid JSON. No text before or after. Start with { and end with }.\n\n' +
        prompt +
        '\n\nREMINDER: Return ONLY the JSON object. No explanations.';

      return runReviewWithRetry(
        strictPrompt,
        context,
        repoDir,
        model,
        timeout,
        maxRetries,
        options,
        attempt + 1
      );
    } else {
      throw new Error(
        'LLM returned conversational text instead of JSON after 2 attempts.\n' +
        `Response preview: ${responseText.substring(0, 300)}\n\n` +
        `Possible causes:\n` +
        `  - Model is not following JSON format instructions\n` +
        `  - Network issues caused incomplete response\n` +
        `  - Context is too large for the model\n\n` +
        `Troubleshooting:\n` +
        `  - Run with --verbose to see full LLM response\n` +
        `  - Try a different model: REVIEW_MODEL=claude-opus-4-6 npx tsx tools/review-changes.ts\n` +
        `  - Break changes into smaller PRs if diff is very large\n` +
        `  - Check your network connection and retry`
      );
    }
  }

  // Parse response
  try {
    return parseReviewResponse(responseText, context);
  } catch (error) {
    if (attempt < maxAttempts) {
      console.error(`⚠️  Failed to parse JSON (attempt ${attempt}/${maxAttempts})`);
      if (options.verbose) {
        console.error('Error:', (error as Error).message);
      }
      console.error('Retrying with stricter prompt...\n');

      // Retry with stricter prompt
      const strictPrompt =
        'CRITICAL: Respond with ONLY valid JSON. No text before or after. Start with { and end with }.\n\n' +
        prompt +
        '\n\nREMINDER: Return ONLY the JSON object. No explanations.';

      return runReviewWithRetry(
        strictPrompt,
        context,
        repoDir,
        model,
        timeout,
        maxRetries,
        options,
        attempt + 1
      );
    }
    throw error;
  }
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

  // Run review with retry logic
  const result = await runReviewWithRetry(
    prompt,
    context,
    repoDir,
    model,
    timeout,
    maxRetries,
    options,
    1
  );

  return result;
}
