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

const _promptTemplateCache = new Map<string, string>();

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export type ReviewerPersona = 'general' | 'security' | 'performance' | 'correctness' | 'design';

export interface ReviewFinding {
  severity: 'blocker' | 'warning';
  location: string;
  category: string;
  description: string;
  /** Personas that flagged this finding */
  reviewers?: ReviewerPersona[];
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
  /** List of reviewer personas to run (default: ['general']) */
  reviewers?: ReviewerPersona[];
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
// Prompt Template Loading
// ────────────────────────────────────────────────────────────────

/**
 * Load persona-specific review prompt template from tools/prompts/review-{persona}.md
 * Caches templates after first load to avoid redundant disk reads.
 *
 * @param persona - Reviewer persona (general, security, performance, correctness, design)
 * @returns Prompt template string
 */
function loadPersonaPromptTemplate(persona: ReviewerPersona): string {
  // Return cached template if available
  if (_promptTemplateCache.has(persona)) {
    return _promptTemplateCache.get(persona)!;
  }

  // Load and cache template
  const promptPath = join(__dirname, `../../tools/prompts/review-${persona}.md`);
  if (!existsSync(promptPath)) {
    throw new Error(
      `Review prompt template not found for persona "${persona}" at: ${promptPath}\n` +
      `  This is likely a repository installation issue.\n` +
      `  Troubleshooting:\n` +
      `    - Verify the tools/prompts/ directory exists\n` +
      `    - Check that review-${persona}.md is present in that directory\n` +
      `    - If running from a symlinked install, verify symlinks are correct`
    );
  }

  let template: string;
  try {
    template = readFileSync(promptPath, 'utf-8');
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

  _promptTemplateCache.set(persona, template);
  return template;
}

/**
 * Filter reviewer personas based on config and context.
 *
 * - Design persona requires ui.creativeDirection: true in config
 * - Design persona requires UI changes in diff
 *
 * @param requested - Personas requested by caller
 * @param repoDir - Repository directory for config loading
 * @param hasUiChanges - Whether diff includes UI file changes
 * @returns Filtered list of enabled personas
 */
function filterEnabledPersonas(
  requested: ReviewerPersona[],
  repoDir: string,
  hasUiChanges: boolean
): ReviewerPersona[] {
  const config = loadWavemillConfig(repoDir);

  return requested.filter(persona => {
    if (persona === 'design') {
      // Design persona requires ui.creativeDirection: true
      if (!config.ui?.creativeDirection) {
        return false;
      }
      // Design persona requires UI changes
      if (!hasUiChanges) {
        return false;
      }
    }
    return true;
  });
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
  let trimmed = text.trim();

  // Strip markdown code fences if present
  // Handles: ```json { ... } ```, ``` { ... } ```, and { ... } ``` (trailing fence only)
  if (trimmed.startsWith('```')) {
    trimmed = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  } else if (trimmed.endsWith('```')) {
    trimmed = trimmed.replace(/\s*```\s*$/, '').trim();
  }

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
// Finding Deduplication
// ────────────────────────────────────────────────────────────────

/**
 * Calculate text similarity score using word overlap.
 * Returns value between 0 (no overlap) and 1 (identical).
 */
function similarityScore(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 3));

  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
  return (2 * intersection.size) / (wordsA.size + wordsB.size);
}

/**
 * Deduplicate findings across multiple reviewers.
 *
 * Findings are considered duplicates if:
 * - Same location (file:line)
 * - Same category
 * - Similar description (>70% word overlap)
 *
 * When merging duplicates:
 * - Keep first description encountered
 * - Combine reviewers from all duplicates
 * - Upgrade severity to 'blocker' if any duplicate is a blocker
 *
 * @param findings - Array of findings from multiple reviewers
 * @returns Deduplicated findings with reviewer attribution
 */
function deduplicateFindings(findings: ReviewFinding[]): ReviewFinding[] {
  const merged: ReviewFinding[] = [];

  for (const finding of findings) {
    // Look for existing finding with same location and similar description
    const existing = merged.find(f =>
      f.location === finding.location &&
      f.category === finding.category &&
      similarityScore(f.description, finding.description) > 0.7
    );

    if (existing) {
      // Merge: combine reviewers, upgrade severity if needed
      const existingReviewers = existing.reviewers || [];
      const newReviewers = finding.reviewers || [];
      existing.reviewers = [...existingReviewers, ...newReviewers];

      // Upgrade to blocker if any reviewer flagged as blocker
      if (finding.severity === 'blocker') {
        existing.severity = 'blocker';
      }
    } else {
      // New finding
      merged.push({ ...finding });
    }
  }

  return merged;
}

// ────────────────────────────────────────────────────────────────
// Single Persona Review
// ────────────────────────────────────────────────────────────────

/**
 * Run review for a single persona.
 *
 * @param persona - Reviewer persona to run
 * @param context - Review context
 * @param repoDir - Repository directory
 * @param model - Model to use
 * @param timeout - Timeout in milliseconds
 * @param maxRetries - Max retries for LLM calls
 * @param options - Review options
 * @returns ReviewResult with findings tagged with this persona
 */
async function runPersonaReview(
  persona: ReviewerPersona,
  context: ReviewContext,
  repoDir: string,
  model: string,
  timeout: number,
  maxRetries: number,
  options: ReviewEngineOptions
): Promise<ReviewResult> {
  // Load persona-specific template
  const template = loadPersonaPromptTemplate(persona);

  // Design persona needs design context, others skip it
  const skipDesignContext = persona !== 'design';
  const prompt = fillPromptTemplate(template, context, skipDesignContext);

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

  // Tag all findings with this persona
  result.codeReviewFindings.forEach(f => {
    f.reviewers = [persona];
  });

  if (result.uiFindings) {
    result.uiFindings.forEach(f => {
      f.reviewers = [persona];
    });
  }

  return result;
}

// ────────────────────────────────────────────────────────────────
// Main Entry Point
// ────────────────────────────────────────────────────────────────

/**
 * Run review on provided context with support for multiple reviewer personas.
 *
 * Core engine that handles:
 * 1. Configuration loading
 * 2. Filtering enabled personas (respects ui.creativeDirection for design persona)
 * 3. Running review for each persona
 * 4. Deduplicating findings across personas
 * 5. Aggregating results
 *
 * @param context - Review context (diff, task packet, plan, design context)
 * @param repoDir - Repository directory for config loading
 * @param options - Optional overrides for model, timeout, reviewers, etc.
 * @returns ReviewResult with deduplicated findings and persona attribution
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

  // Determine reviewers to run (default: ['general'])
  const requestedReviewers = options.reviewers || ['general'];
  const enabledReviewers = filterEnabledPersonas(
    requestedReviewers,
    repoDir,
    context.metadata.hasUiChanges
  );

  if (enabledReviewers.length === 0) {
    throw new Error(
      'No reviewers enabled. Check configuration and UI changes. ' +
      'Design persona requires ui.creativeDirection: true and UI file changes.'
    );
  }

  if (options.verbose) {
    console.error('=== Review Engine Configuration ===');
    console.error(`Model: ${model}`);
    console.error(`Timeout: ${timeout}ms`);
    console.error(`Max retries: ${maxRetries}`);
    console.error(`Requested reviewers: ${requestedReviewers.join(', ')}`);
    console.error(`Enabled reviewers: ${enabledReviewers.join(', ')}`);
    console.error(`Design context available: ${context.designContext !== null}`);
    console.error(`UI changes detected: ${context.metadata.hasUiChanges}`);
    console.error('');
  }

  // Run each persona review in sequence
  const results: ReviewResult[] = [];

  for (const persona of enabledReviewers) {
    if (options.verbose) {
      console.error(`\n=== Running ${persona} reviewer ===`);
    }

    const result = await runPersonaReview(
      persona,
      context,
      repoDir,
      model,
      timeout,
      maxRetries,
      options
    );

    results.push(result);

    if (options.verbose) {
      console.error(`${persona} reviewer complete: ${result.codeReviewFindings.length} code findings, ${result.uiFindings?.length || 0} UI findings`);
    }
  }

  // Aggregate findings from all reviewers
  const allCodeFindings = results.flatMap(r => r.codeReviewFindings);
  const allUiFindings = results.flatMap(r => r.uiFindings || []);

  // Deduplicate findings
  const deduplicatedCodeFindings = deduplicateFindings(allCodeFindings);
  const deduplicatedUiFindings = deduplicateFindings(allUiFindings);

  // Sort findings: blockers first, then by location
  const sortFindings = (findings: ReviewFinding[]) => {
    findings.sort((a, b) => {
      // Blockers before warnings
      if (a.severity !== b.severity) {
        return a.severity === 'blocker' ? -1 : 1;
      }
      // Then alphabetically by location
      return a.location.localeCompare(b.location);
    });
  };

  sortFindings(deduplicatedCodeFindings);
  sortFindings(deduplicatedUiFindings);

  // Determine overall verdict
  const hasBlockers =
    deduplicatedCodeFindings.some(f => f.severity === 'blocker') ||
    deduplicatedUiFindings.some(f => f.severity === 'blocker');

  if (options.verbose) {
    console.error(`\n=== Review Complete ===`);
    console.error(`Total code findings: ${deduplicatedCodeFindings.length} (${deduplicatedCodeFindings.filter(f => f.severity === 'blocker').length} blockers)`);
    console.error(`Total UI findings: ${deduplicatedUiFindings.length} (${deduplicatedUiFindings.filter(f => f.severity === 'blocker').length} blockers)`);
    console.error(`Verdict: ${hasBlockers ? 'NOT READY' : 'READY'}`);
    console.error('');
  }

  return {
    verdict: hasBlockers ? 'not_ready' : 'ready',
    codeReviewFindings: deduplicatedCodeFindings,
    uiFindings: deduplicatedUiFindings.length > 0 ? deduplicatedUiFindings : undefined,
    metadata: {
      branch: context.metadata.branch,
      files: context.metadata.files,
      hasUiChanges: context.metadata.hasUiChanges,
      designContextAvailable: context.designContext !== null,
      uiVerificationRun: deduplicatedUiFindings.length > 0,
    },
  };
}
