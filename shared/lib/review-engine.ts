/**
 * Review Engine - Core code review logic
 *
 * Provides a unified review interface for both PR reviews and local change reviews.
 * Handles configuration loading, template filling, LLM invocation with retry,
 * and response parsing.
 *
 * @module review-engine
 */

import {
  type ReviewContext,
  type DesignContext,
} from './review-context-gatherer.ts';
import type { BlastRadius } from './blast-radius.ts';
import {
  callLLM,
  ensureClaudeAvailable,
  ensureCodexAvailable,
  parseJsonFromLLM,
  type LLMCallOptions,
  type LLMCallResult,
} from './llm-cli.ts';
import { fillPromptSlots } from './prompt-utils.ts';
import { getNativeAgentConfig, loadWavemillConfig } from './config.ts';
import { isLaunchableForStage, type StageLaunchability } from './stage-launchability.ts';
import { REVIEW_MAX_OUTPUT_TOKENS } from './native-agent/output-limits.ts';
import {
  NATIVE_CONTEXT_WINDOW_EXCEEDED_CATEGORY,
  REVIEW_MODEL_UNLAUNCHABLE_FAILURE_CATEGORY,
} from './stage-result.ts';
import { ClaudeCliAdapter, claudeCliReportedModelMatches } from './model-adapters/claude-cli-adapter.ts';
import { CodexCliAdapter } from './model-adapters/codex-cli-adapter.ts';
import type { AdapterError, TransportAdapter } from './model-adapters/transport-adapter.ts';
import type { ReviewProgressReporter } from './review-progress.ts';
import type { OperatingMode } from './operating-mode.ts';
import { loadPromptResourceSync, resolveRuntimeResource } from './resource-retrieval.ts';
import type { runNativeReview as runNativeReviewFn } from './native-agent/review.ts';
import { buildExecutedIdentity, type ExecutedIdentity } from './challenge-execution-contract.ts';

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
  /** Protected screenshot/diff artifacts supporting this finding. */
  artifactRefs?: string[];
  /** Personas that flagged this finding */
  reviewers?: ReviewerPersona[];
  /**
   * The reviewer investigated this finding and proved it invalid (HOK-2932).
   * The finding is kept for audit but stops counting toward the verdict.
   * Only honored when `dismissalJustification` is non-blank.
   */
  dismissed?: boolean;
  /** Why the finding is invalid. Required for a dismissal to count. */
  dismissalJustification?: string;
  /** Verification the reviewer ran (e.g. a git/test command and its result). */
  dismissalEvidence?: string;
  /**
   * Supporting evidence for the finding itself (e.g. a cited excerpt, log
   * line, or command output) — distinct from `dismissalEvidence`, which
   * proves a finding invalid rather than substantiating it (HOK-2969).
   */
  evidence?: string;
  /** The reviewer's suggested remediation, when offered (HOK-2969). */
  proposedFix?: string;
}

/** A dismissal only counts with a non-blank justification; anything else stays blocking. */
export function isDismissedFinding(finding: ReviewFinding): boolean {
  return finding.dismissed === true
    && typeof finding.dismissalJustification === 'string'
    && finding.dismissalJustification.trim() !== '';
}

/** True when the finding counts toward a `not_ready` verdict. */
export function isBlockingFinding(finding: ReviewFinding): boolean {
  return finding.severity === 'blocker' && !isDismissedFinding(finding);
}

export interface ReviewResult {
  verdict: 'ready' | 'not_ready' | 'error';
  codeReviewFindings: ReviewFinding[];
  uiFindings?: ReviewFinding[];
  needsStrongerReviewer?: boolean;
  strongerReviewerReason?: string;
  failureCategory?: string;
  reviewToolError?: string;
  /**
   * Identity of the model that actually performed this review's substantive
   * analysis, with pin/fallback/conflict status (HOK-2969, Arbiter P2.4f).
   * Populated by native review producers; absent for legacy shell-review
   * results, where the requested model is always what ran directly.
   */
  substantiveAnalysisIdentity?: ExecutedIdentity;
  metadata?: {
    branch: string;
    files: string[];
    hasUiChanges: boolean;
    designContextAvailable: boolean;
    uiVerificationRun: boolean;
    deniedTools?: Array<{ tool: string; reason: string; message: string }>;
    effectiveNativeTimeoutMs?: number;
    nativeTimeoutAttempt?: number;
    nativeTimeoutBaseMs?: number;
    nativeTimeoutMaxMs?: number;
    nativeTimeoutMultiplier?: number;
    reviewInputDiffBytes?: number;
    reviewInputTaskPacketBytes?: number;
    reviewInputFileCount?: number;
    nativeLoopStopReason?: string;
    /** Canonical provider that performed the native review (HOK-3064). */
    reviewProvider?: string;
    /** Canonical `native-<provider>` agent identity for the native review (HOK-3064). */
    reviewAgent?: string;
    /**
     * The base the review diff was computed against (HOK-3166). Set by
     * `reviewChanges` for three-dot reviews; absent for `sinceCommit` reviews.
     * `reviewedBase` (tip of `ref`) is comparable to the PR's `baseRefOid`.
     */
    diffBase?: {
      requestedRef: string;
      ref: string;
      kind: 'remote' | 'local' | 'explicit';
      fetch: 'fetched' | 'failed' | 'skipped';
      reviewedBase: string | null;
      mergeBaseSha: string | null;
      reviewedHead: string | null;
      reviewedFileCount: number;
    };
  };
}

export interface ReviewEngineOptions {
  /**
   * The model that must perform the substantive analysis (the routed reviewer
   * or a challenge pin). When set, the executor is chosen per model through
   * `resolveModelAgent` and the review fails closed (no fallback ladder, no
   * different native model) when that model cannot run (HOK-3247). When
   * unset, the legacy executor is used: the native pool when native review is
   * opted in, otherwise `eval.judge.model` via its CLI.
   */
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
  /** Progress reporter for milestone/status events */
  reporter?: ReviewProgressReporter;
  /** Skip Claude CLI preflight when a caller already performed it */
  skipClaudePreflight?: boolean;
  /** Operating mode controls degraded/scoped review behavior */
  operatingMode?: OperatingMode;
  /** Feature directory for stage-result cleanup reporting when review runs natively */
  featureDir?: string;
  /** Repository/session context passed through to native loop telemetry. */
  repoDir?: string;
  session?: string;
  issue?: string;
  nativeTimeoutAttempt?: number;
}

interface JudgeConfig {
  model: string;
  provider: string;
}

interface Config {
  judge: JudgeConfig;
}

interface NativeReviewModule {
  runNativeReview: typeof runNativeReviewFn;
}

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'claude-sonnet-5';
const DEFAULT_PROVIDER = 'claude-cli';
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes (claude -p with JSON output is slow)
const DEFAULT_MAX_RETRIES = 1;
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
function getPersonaPromptPath(persona: ReviewerPersona, operatingMode: OperatingMode = 'normal'): string {
  return resolveRuntimeResource({
    kind: 'prompt',
    role: 'reviewer',
    persona,
    operatingMode,
  }).path;
}

function loadPersonaPromptTemplate(
  persona: ReviewerPersona,
  operatingMode: OperatingMode = 'normal'
): string {
  const promptPath = getPersonaPromptPath(persona, operatingMode);

  // Return cached template if available (avoids redundant disk I/O)
  if (_promptTemplateCache.has(promptPath)) {
    return _promptTemplateCache.get(promptPath)!;
  }

  const promptResource = loadPromptResourceSync({
    kind: 'prompt',
    role: 'reviewer',
    persona,
    operatingMode,
  });

  if (!promptResource.content) {
    throw new Error(
      `Failed to load prompt template for reviewer: ${persona}. ` +
      `Expected file at ${promptPath}. ` +
      `Please ensure the prompt file exists and is readable.`
    );
  }

  const template = promptResource.content;
  _promptTemplateCache.set(promptPath, template);
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
  hasUiChanges: boolean,
  operatingMode: OperatingMode = 'normal'
): ReviewerPersona[] {
  if (operatingMode !== 'normal') {
    return ['general'];
  }

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
 * Guidance block injected at the top of the review prompt when the PR touches
 * mill-core paths (HOK-3238). The three bullets map directly to the HOK-3212
 * incident mode: fixture provenance, the end-to-end journey, and
 * condition-marker / bounded-retry latches.
 */
export const HIGH_BLAST_RADIUS_GUIDANCE = `---

## HIGH BLAST RADIUS — Mill-core change

This PR touches mill-core paths (monitor, tend, merge-labels, reconciler,
state writers, ready stage). Before returning your verdict you MUST:

1. **Fixture provenance** — every new test fixture under \`tests/\`,
   \`shared/lib/*.fixtures*\`, or \`tests/fixtures/\` must declare where it
   came from (a repro from a prior incident, a hand-authored case, or a
   replay of production). A fixture whose provenance you cannot name is
   a blocker.
2. **Journey check** — the mill's end-to-end \`happy-path\` journey must
   still cover the changed path. If the PR is likely to change
   plan→code→review→ready→tend→merge semantics, note which journey the
   change exercises; if none does, flag it as \`blocker\`.
   Journey command: \`bash tests/journeys/run-journeys.sh happy-path\`.
3. **Latch check** — any new condition-keyed marker must declare
   \`--expires-on\`; any new relaunch path must go through \`bounded-retry\`.
`;

/**
 * Fill the prompt template with context.
 *
 * Substitutes:
 * - {{DIFF}}
 * - {{PLAN_CONTEXT}}
 * - {{TASK_PACKET_CONTEXT}}
 * - {{DESIGN_CONTEXT}}
 * - {{HIGH_BLAST_RADIUS_GUIDANCE}}
 */
export function fillReviewPromptTemplate(
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

  // HOK-3238: a `high` blast radius injects a mandatory journey/fixture
  // provenance / latch-check preamble. Any other value (including missing)
  // is treated as `normal` and the slot stays empty.
  const highBlastRadiusGuidance = context.blastRadius === 'high'
    ? HIGH_BLAST_RADIUS_GUIDANCE
    : '';

  return fillPromptSlots(template, {
    DIFF: diff,
    PLAN_CONTEXT: plan,
    TASK_PACKET_CONTEXT: taskPacket,
    DESIGN_CONTEXT: designContext,
    HIGH_BLAST_RADIUS_GUIDANCE: highBlastRadiusGuidance,
  });
}

// ────────────────────────────────────────────────────────────────
// LLM Invocation
// ────────────────────────────────────────────────────────────────

/**
 * How the CLI analysis call is made (HOK-3247).
 *
 * `failClosed` is set when a specific reviewer was requested: the call then
 * runs only that model on its own executable. Leaving `taskType` unset and
 * passing an empty `fallbackModels` keeps `callLLM` off the quota fallback
 * ladder, which would otherwise walk to other models (and drop ones the
 * transport cannot serve). `taskType: 'review'` drives nothing else in
 * `llm-cli.ts` — classifier isolation keys on `classify` only — so omitting it
 * loses no non-ladder behaviour.
 */
export interface ReviewCliCall {
  provider: 'claude' | 'codex';
  failClosed: boolean;
}

/** Result of one CLI analysis call, with the evidence needed for identity. */
interface ReviewLLMResponse {
  text: string;
  provider: LLMCallResult['provider'];
  /** Model id the CLI was invoked with (the ladder candidate when one ran). */
  invokedModel: string;
  /** Model id the CLI's own output reported, when it reports one. */
  reportedModel?: string;
  fallbackChain?: LLMCallResult['fallbackChain'];
}

/**
 * Invoke LLM with retry logic.
 */
async function invokeLLMWithRetry(
  prompt: string,
  model: string,
  timeout: number,
  maxRetries: number,
  options: ReviewEngineOptions,
  reviewer: ReviewerPersona,
  llmAttempt: number,
  cli: ReviewCliCall = { provider: 'claude', failClosed: false },
  adapter?: TransportAdapter,
): Promise<ReviewLLMResponse> {
  // If adapter is provided, use it for invocation (HOK-3248)
  if (adapter) {
    const adapterResult = await adapter.invoke(prompt, {
      timeout,
      maxRetries,
      signal: options.signal,
    });

    if (adapterResult.error) {
      throw new ReviewCliContextWindowExceededError(adapterResult.error.message);
    }

    return {
      text: adapterResult.text,
      provider: cli.provider,
      invokedModel: model,
      ...(adapterResult.reportedModel !== 'unverified' ? { reportedModel: adapterResult.reportedModel } : {}),
    };
  }

  // Fallback: use callLLM directly (for backward compatibility)
  const ladder: Pick<LLMCallOptions, 'taskType' | 'fallbackModels'> = cli.failClosed
    ? { fallbackModels: [] }
    : { taskType: 'review' };
  const result = await reviewEngineDeps.callLLM(prompt, {
    provider: cli.provider,
    mode: 'stream',
    model,
    ...ladder,
    timeout,
    maxBuffer: 50 * 1024 * 1024, // 50MB for large diffs
    retry: true,
    maxRetries,
    observer: {
      onAttemptStart: async (event) => {
        await options.reporter?.emit({
          event: 'llm_call_start',
          message: 'Calling Claude API',
          reviewer,
          attempt: llmAttempt,
          maxAttempts: 2,
          provider: event.provider,
          model: event.model,
          details: { transportAttempt: event.attempt, transportMaxAttempts: event.maxAttempts },
        });
      },
      onAttemptSlow: async (event) => {
        await options.reporter?.emit({
          event: 'llm_call_slow',
          level: 'warn',
          message: 'Claude API call is still running',
          reviewer,
          attempt: llmAttempt,
          maxAttempts: 2,
          provider: event.provider,
          model: event.model,
          elapsedMs: event.elapsedMs,
          details: { transportAttempt: event.attempt, transportMaxAttempts: event.maxAttempts },
        });
      },
      onAttemptError: async (event) => {
        await options.reporter?.emit({
          event: 'llm_call_error',
          level: event.willRetry ? 'warn' : 'error',
          message: 'Claude API call failed',
          reviewer,
          attempt: llmAttempt,
          maxAttempts: 2,
          provider: event.provider,
          model: event.model,
          elapsedMs: event.elapsedMs,
          details: {
            error: event.error,
            transportAttempt: event.attempt,
            transportMaxAttempts: event.maxAttempts,
          },
        });
      },
      onRetry: async (event) => {
        await options.reporter?.emit({
          event: 'llm_call_retry',
          level: 'warn',
          message: `Retrying Claude API call after ${event.delayMs}ms`,
          reviewer,
          attempt: llmAttempt,
          maxAttempts: 2,
          provider: event.provider,
          model: event.model,
          details: {
            previousError: event.error,
            nextTransportAttempt: event.nextAttempt,
            transportMaxAttempts: event.maxAttempts,
          },
        });
      },
      onAttemptComplete: async (event) => {
        await options.reporter?.emit({
          event: 'llm_call_complete',
          message: 'Claude API call completed',
          reviewer,
          attempt: llmAttempt,
          maxAttempts: 2,
          provider: event.provider,
          model: event.model,
          elapsedMs: event.elapsedMs,
          details: { transportAttempt: event.attempt, transportMaxAttempts: event.maxAttempts },
        });
      },
    },
  });

  return {
    text: result.text,
    provider: result.provider,
    invokedModel: result.model && result.model !== '(default)' ? result.model : model,
    ...(result.reportedModel ? { reportedModel: result.reportedModel } : {}),
    ...(result.fallbackChain?.length ? { fallbackChain: result.fallbackChain } : {}),
  };
}

/**
 * Executed identity of a CLI analysis call (HOK-3247, HOK-3248).
 *
 * Pinned only when the CLI's own output reported the model that served the
 * turn (the claude CLI's `modelUsage`) and it is the requested model. A model
 * the CLI did not report (codex `exec --json` reports none) is recorded as
 * unverified (`source: 'derived'`, never pinned). The id-normalisation rule
 * for claude lives in `model-adapters/claude-cli-adapter.ts`.
 */
export function buildCliAnalysisIdentity(input: {
  requestedModel: string;
  response: Pick<ReviewLLMResponse, 'provider' | 'invokedModel' | 'reportedModel' | 'fallbackChain'>;
}): ExecutedIdentity {
  const { response } = input;
  const agent = response.provider === 'codex' ? 'codex-cli' : 'claude-cli';
  const fallbackReason = response.fallbackChain?.length
    ? `fallback_ladder:${response.fallbackChain.map((step) => `${step.model}=${step.reason}`).join(',')}`
    : undefined;
  // Only treat reportedModel as verified if it's not the 'unverified' sentinel
  const isReportedModelVerified = response.reportedModel && response.reportedModel !== 'unverified';
  if (isReportedModelVerified) {
    const resolvedModel =
      response.provider === 'codex'
        ? response.reportedModel
        : claudeCliReportedModelMatches(response.reportedModel, response.invokedModel)
          ? response.invokedModel
          : response.reportedModel;
    return buildExecutedIdentity({
      role: 'substantive_analysis',
      requestedModel: input.requestedModel,
      resolvedModel,
      agent,
      source: 'artifact',
      fallbackReason,
    });
  }
  return buildExecutedIdentity({
    role: 'substantive_analysis',
    requestedModel: input.requestedModel,
    resolvedModel: response.invokedModel,
    agent,
    source: 'derived',
    fallbackReason,
    verified: false,
  });
}

/**
 * Combine per-persona analysis identities. Personas that resolved different
 * models record a conflict (never pinned).
 */
function combineAnalysisIdentities(identities: ExecutedIdentity[]): ExecutedIdentity | undefined {
  const [first, ...rest] = identities;
  if (!first) return undefined;
  const other = rest.find((identity) => identity.resolvedModel !== first.resolvedModel);
  if (other) {
    return {
      ...first,
      pinned: false,
      conflict: {
        otherSource: other.source,
        otherResolvedModel: other.resolvedModel,
        detail: 'review personas were analysed by different models',
      },
    };
  }
  return { ...first, pinned: identities.every((identity) => identity.pinned) };
}

// ────────────────────────────────────────────────────────────────
// CLI context-window pre-check (HOK-3247, HOK-3248)
// ────────────────────────────────────────────────────────────────

/**
 * Build the transport adapter for a CLI review call. The adapter owns the
 * context-window limit, the CLI-harness token overhead, and the preflight
 * refusal (HOK-3248). Review-engine never re-derives these.
 */
function buildCliReviewAdapter(
  provider: ReviewCliCall['provider'],
  model: string,
  repoDir: string,
  failClosed: boolean,
): TransportAdapter {
  const common = { model, repoDir, reservedOutputTokens: REVIEW_MAX_OUTPUT_TOKENS, failClosed };
  return provider === 'codex' ? new CodexCliAdapter(common) : new ClaudeCliAdapter(common);
}

class ReviewCliContextWindowExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewCliContextWindowExceededError';
  }
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
export function looksLikeJson(text: string): boolean {
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
export function parseNativeReviewResponse(
  responseText: string,
  context: ReviewContext,
  operatingMode: OperatingMode = 'normal'
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

  // Findings may cite protected screenshot/diff artifacts. Treat model output
  // as untrusted: malformed refs are omitted without invalidating the review.
  const sanitizeArtifactRefs = (findings: ReviewFinding[]) => {
    for (const finding of findings) {
      if (finding.artifactRefs === undefined) continue;
      if (!Array.isArray(finding.artifactRefs)) {
        delete finding.artifactRefs;
        continue;
      }
      finding.artifactRefs = finding.artifactRefs.filter(
        (ref): ref is string => typeof ref === 'string' && /^artifact:\/\/[a-f0-9]{64}$/.test(ref),
      );
    }
  };
  sanitizeArtifactRefs(parsed.codeReviewFindings);
  if (Array.isArray(parsed.uiFindings)) sanitizeArtifactRefs(parsed.uiFindings);

  // Reject dismissals lacking a non-blank justification: the finding stays
  // blocking rather than being waved through (HOK-2932, fail closed).
  const rejectUnjustifiedDismissals = (findings: ReviewFinding[]) => {
    for (const finding of findings) {
      if (finding.dismissed === true && !isDismissedFinding(finding)) {
        delete finding.dismissed;
        delete finding.dismissalJustification;
      }
    }
  };
  rejectUnjustifiedDismissals(parsed.codeReviewFindings);
  if (Array.isArray(parsed.uiFindings)) {
    rejectUnjustifiedDismissals(parsed.uiFindings);
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

  if (operatingMode !== 'normal' && typeof parsed.needs_stronger_reviewer === 'boolean') {
    result.needsStrongerReviewer = parsed.needs_stronger_reviewer;
  }

  if (operatingMode !== 'normal' && typeof parsed.stronger_reviewer_reason === 'string') {
    result.strongerReviewerReason = parsed.stronger_reviewer_reason;
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
  persona: ReviewerPersona,
  attempt: number = 1,
  cli: ReviewCliCall = { provider: 'claude', failClosed: false },
  adapter?: TransportAdapter,
): Promise<ReviewResult> {
  const maxAttempts = 2;

  // Invoke LLM
  const response = await invokeLLMWithRetry(
    prompt,
    model,
    timeout,
    maxRetries,
    options,
    persona,
    attempt,
    cli,
    adapter,
  );
  const responseText = response.text;

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
      await options.reporter?.emit({
        event: 'response_retry',
        level: 'warn',
        message: 'Claude returned non-JSON output; retrying with stricter prompt',
        reviewer: persona,
        attempt,
        maxAttempts,
      });
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
        persona,
        attempt + 1,
        cli,
        adapter,
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
        `  - Try a different model: REVIEW_MODEL=claude-opus-4-8 npx tsx tools/review-changes.ts\n` +
        `  - Break changes into smaller PRs if diff is very large\n` +
        `  - Check your network connection and retry`
      );
    }
  }

  // Parse response
  try {
    await options.reporter?.emit({
      event: 'response_parsing',
      message: 'Parsing Claude response',
      reviewer: persona,
      attempt,
      maxAttempts,
    });
    return {
      ...parseNativeReviewResponse(responseText, context, options.operatingMode ?? 'normal'),
      substantiveAnalysisIdentity: buildCliAnalysisIdentity({ requestedModel: model, response }),
    };
  } catch (error) {
    if (attempt < maxAttempts) {
      await options.reporter?.emit({
        event: 'response_retry',
        level: 'warn',
        message: 'Failed to parse Claude JSON response; retrying with stricter prompt',
        reviewer: persona,
        attempt,
        maxAttempts,
      });
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
        persona,
        attempt + 1,
        cli,
        adapter,
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

      // A dismissal only survives merging when every duplicate is dismissed;
      // one reviewer standing by the finding keeps it blocking.
      if (!isDismissedFinding(finding) && isDismissedFinding(existing)) {
        delete existing.dismissed;
        delete existing.dismissalJustification;
        delete existing.dismissalEvidence;
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
  options: ReviewEngineOptions,
  cli: ReviewCliCall = { provider: 'claude', failClosed: false },
): Promise<ReviewResult> {
  // Load persona-specific template
  const template = loadPersonaPromptTemplate(persona, options.operatingMode ?? 'normal');

  // Design persona needs design context, others skip it
  const skipDesignContext = persona !== 'design';
  const prompt = fillReviewPromptTemplate(template, context, skipDesignContext);

  const adapter = reviewEngineDeps.buildCliReviewAdapter(cli.provider, model, repoDir, cli.failClosed);
  const refusal: AdapterError | undefined = adapter.preflight(prompt);
  if (refusal) {
    throw new ReviewCliContextWindowExceededError(refusal.message);
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
    persona,
    1,
    cli,
    adapter,
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
/** The launcher's own resolver for the review phase (HOK-3142 parity). */
function resolveReviewAgent(model: string, repoDir: string): StageLaunchability {
  return isLaunchableForStage(model, 'review', { repoDir });
}

const reviewEngineDeps = {
  callLLM,
  buildCliReviewAdapter,
  ensureClaudeAvailable,
  ensureCodexAvailable,
  filterEnabledPersonas,
  isNativeReviewOptedIn,
  loadConfig,
  async loadNativeReviewModule(): Promise<NativeReviewModule> {
    return import('./native-agent/review.ts');
  },
  resolveReviewAgent,
  runPersonaReview,
};

export function isNativeReviewOptedIn(repoDir: string): boolean {
  const config = getNativeAgentConfig(repoDir);
  return config.enabled === true && (config.allowedPhases ?? []).includes('review');
}

/**
 * Where a review's substantive analysis runs (HOK-3247).
 *
 * - `cli`: the claude or codex executable, chosen by `resolveModelAgent`
 *   (Anthropic → claude, OpenAI → codex). `failClosed` = a specific reviewer
 *   was requested, so no fallback ladder.
 * - `native`: `runNativeReview`; `model` pins exactly one native provider
 *   entry, or is undefined for the legacy unpinned pool.
 * - `unlaunchable`: a requested model that cannot run the review.
 */
export type ReviewDispatch =
  | { kind: 'cli'; provider: ReviewCliCall['provider']; model: string; failClosed: boolean }
  | { kind: 'native'; model?: string }
  | { kind: 'unlaunchable'; model: string; reason: string; diagnostic: string; agent?: string };

/**
 * Choose the executor for a review per model, through the single resolver
 * the launcher and router use (`resolveModelAgent`, via
 * `isLaunchableForStage`). Anthropic and OpenAI models never reach the
 * native/OpenRouter path, even when native review is opted in.
 *
 * With no requested model the legacy behaviour is kept: the native pool when
 * native review is opted in, otherwise `judgeModel` on its own CLI (claude
 * when the resolver does not place it on claude or codex, as before).
 */
export function resolveReviewDispatch(input: {
  repoDir: string;
  requestedModel?: string;
  judgeModel: () => string;
}): ReviewDispatch {
  const requested = input.requestedModel?.trim();
  if (!requested) {
    if (reviewEngineDeps.isNativeReviewOptedIn(input.repoDir)) {
      return { kind: 'native' };
    }
    const judgeModel = input.judgeModel();
    const judge = reviewEngineDeps.resolveReviewAgent(judgeModel, input.repoDir);
    const provider = judge.ok === true && (judge.agent === 'claude' || judge.agent === 'codex')
      ? judge.agent
      : 'claude';
    return { kind: 'cli', provider, model: judgeModel, failClosed: false };
  }

  const resolution = reviewEngineDeps.resolveReviewAgent(requested, input.repoDir);
  if (resolution.ok === false) {
    return {
      kind: 'unlaunchable',
      model: requested,
      reason: resolution.reason,
      diagnostic: resolution.diagnostic,
    };
  }
  const agent = resolution.agent;
  if (agent === 'claude' || agent === 'codex') {
    return { kind: 'cli', provider: agent, model: requested, failClosed: true };
  }
  if (agent === 'native-openai' || agent === 'native-openrouter') {
    if (!reviewEngineDeps.isNativeReviewOptedIn(input.repoDir)) {
      return {
        kind: 'unlaunchable',
        model: requested,
        agent,
        reason: 'native-review-not-opted-in',
        diagnostic:
          `${requested} resolves to ${agent}, but native review is not opted in for this repo ` +
          '(nativeAgent.enabled with "review" in nativeAgent.allowedPhases)',
      };
    }
    return { kind: 'native', model: requested };
  }
  return {
    kind: 'unlaunchable',
    model: requested,
    agent,
    reason: 'unsupported-review-agent',
    diagnostic: `${requested} resolves to agent ${agent}, which cannot run review analysis`,
  };
}

function reviewResultMetadata(context: ReviewContext): NonNullable<ReviewResult['metadata']> {
  return {
    branch: context.metadata.branch,
    files: context.metadata.files,
    hasUiChanges: context.metadata.hasUiChanges,
    designContextAvailable: context.designContext !== null,
    uiVerificationRun: false,
  };
}

/**
 * Typed fail-closed result for a requested reviewer that cannot run
 * (HOK-3247). `verdict: "error"` makes it retryable review infrastructure;
 * `review-runner.ts` re-shapes it for challenge pins (see
 * REVIEW_MODEL_UNLAUNCHABLE_FAILURE_CATEGORY).
 */
function reviewModelUnlaunchableResult(
  context: ReviewContext,
  dispatch: Extract<ReviewDispatch, { kind: 'unlaunchable' }>,
): ReviewResult {
  const detail =
    `review-model-unlaunchable: model=${dispatch.model}` +
    `${dispatch.agent ? ` agent=${dispatch.agent}` : ''} reason=${dispatch.reason}: ${dispatch.diagnostic}`;
  return {
    verdict: 'error',
    codeReviewFindings: [],
    failureCategory: REVIEW_MODEL_UNLAUNCHABLE_FAILURE_CATEGORY,
    reviewToolError: detail,
    substantiveAnalysisIdentity: buildExecutedIdentity({
      role: 'substantive_analysis',
      requestedModel: dispatch.model,
      resolvedModel: 'unresolved',
      ...(dispatch.agent ? { agent: dispatch.agent } : {}),
      source: 'derived',
      fallbackReason: 'review_model_unlaunchable',
    }),
    metadata: reviewResultMetadata(context),
  };
}

export async function runReview(
  context: ReviewContext,
  repoDir: string,
  options: ReviewEngineOptions = {}
): Promise<ReviewResult> {
  const dispatch = resolveReviewDispatch({
    repoDir,
    requestedModel: options.model,
    judgeModel: () => reviewEngineDeps.loadConfig(repoDir).judge.model,
  });

  if (dispatch.kind === 'unlaunchable') {
    await options.reporter?.emit({
      event: 'error',
      level: 'error',
      message: `Reviewer ${dispatch.model} cannot run this review (${dispatch.reason})`,
      details: { model: dispatch.model, agent: dispatch.agent ?? null, reason: dispatch.reason },
    });
    return reviewModelUnlaunchableResult(context, dispatch);
  }

  if (dispatch.kind === 'native') {
    const nativeReview = await reviewEngineDeps.loadNativeReviewModule();
    return nativeReview.runNativeReview(context, repoDir, {
      ...options,
      model: dispatch.model,
    });
  }

  const cli: ReviewCliCall = { provider: dispatch.provider, failClosed: dispatch.failClosed };

  // Determine effective settings (options override config)
  const model = dispatch.model;
  const timeout = options.timeout || DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const operatingMode = options.operatingMode ?? 'normal';

  // Determine reviewers to run (default: ['general'])
  const requestedReviewers = options.reviewers || ['general'];
  const enabledReviewers = reviewEngineDeps.filterEnabledPersonas(
    requestedReviewers,
    repoDir,
    context.metadata.hasUiChanges,
    operatingMode
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
    console.error(`Executor: ${cli.provider} CLI${cli.failClosed ? ' (pinned, no fallback)' : ''}`);
    console.error(`Timeout: ${timeout}ms`);
    console.error(`Max retries: ${maxRetries}`);
    console.error(`Operating mode: ${operatingMode}`);
    console.error(`Requested reviewers: ${requestedReviewers.join(', ')}`);
    console.error(`Enabled reviewers: ${enabledReviewers.join(', ')}`);
    console.error(`Design context available: ${context.designContext !== null}`);
    console.error(`UI changes detected: ${context.metadata.hasUiChanges}`);
    console.error('');
  }

  // Pre-flight check: verify the executor's CLI is available
  // Skip if SKIP_PREFLIGHT_CHECK=1 is set (for testing)
  if (!options.skipClaudePreflight && !process.env.SKIP_PREFLIGHT_CHECK) {
    if (options.verbose) {
      console.error('=== Pre-Flight Check ===');
    }

    const ensureAvailable = cli.provider === 'codex'
      ? reviewEngineDeps.ensureCodexAvailable
      : reviewEngineDeps.ensureClaudeAvailable;
    await ensureAvailable({
      verbose: options.verbose,
      reporter: options.reporter,
    });

    if (options.verbose) {
      console.error(`✓ ${cli.provider} CLI is available and working\n`);
    }
  }

  // Run each persona review in sequence
  const results: ReviewResult[] = [];

  for (const persona of enabledReviewers) {
    if (options.verbose) {
      console.error(`\n=== Running ${persona} reviewer ===`);
    }

    await options.reporter?.emit({
      event: 'reviewer_start',
      message: `Running ${persona} reviewer`,
      reviewer: persona,
    });

    let result: ReviewResult;
    try {
      result = await reviewEngineDeps.runPersonaReview(
        persona,
        context,
        repoDir,
        model,
        timeout,
        maxRetries,
        options,
        cli,
      );
    } catch (error) {
      if (error instanceof ReviewCliContextWindowExceededError) {
        // Reuses the native category so the monitor's HOK-2964 context-window
        // recovery (stale-base rebuild / larger-context reroute) applies. The
        // `native-` prefix is a naming wart: the category now covers CLI
        // reviewers too; it is not renamed because recovery keys on it.
        return {
          verdict: 'error',
          codeReviewFindings: [],
          failureCategory: NATIVE_CONTEXT_WINDOW_EXCEEDED_CATEGORY,
          reviewToolError: error.message,
          substantiveAnalysisIdentity: buildExecutedIdentity({
            role: 'substantive_analysis',
            requestedModel: model,
            resolvedModel: model,
            agent: `${cli.provider}-cli`,
            source: 'derived',
            fallbackReason: 'context_window_preflight_refused',
            verified: false,
          }),
          metadata: reviewResultMetadata(context),
        };
      }
      throw error;
    }

    results.push(result);

    if (options.verbose) {
      console.error(`${persona} reviewer complete: ${result.codeReviewFindings.length} code findings, ${result.uiFindings?.length || 0} UI findings`);
    }

    await options.reporter?.emit({
      event: 'reviewer_complete',
      message: `${persona} reviewer finished`,
      reviewer: persona,
      details: {
        codeFindings: result.codeReviewFindings.length,
        uiFindings: result.uiFindings?.length || 0,
      },
    });
  }

  // Aggregate findings from all reviewers
  const allCodeFindings = results.flatMap(r => r.codeReviewFindings);
  const allUiFindings = results.flatMap(r => r.uiFindings || []);
  const strongerReviewerReason = results
    .map(result => result.strongerReviewerReason?.trim())
    .find((reason): reason is string => Boolean(reason));

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

  // Determine overall verdict. Dismissed blockers are kept for audit but do
  // not count toward the verdict (HOK-2932).
  const hasBlockers =
    deduplicatedCodeFindings.some(isBlockingFinding) ||
    deduplicatedUiFindings.some(isBlockingFinding);
  const rawBlockerCount =
    deduplicatedCodeFindings.filter(f => f.severity === 'blocker').length +
    deduplicatedUiFindings.filter(f => f.severity === 'blocker').length;
  const dismissedBlockerCount =
    deduplicatedCodeFindings.filter(f => f.severity === 'blocker' && isDismissedFinding(f)).length +
    deduplicatedUiFindings.filter(f => f.severity === 'blocker' && isDismissedFinding(f)).length;

  if (options.verbose) {
    console.error(`\n=== Review Complete ===`);
    console.error(`Total code findings: ${deduplicatedCodeFindings.length} (${deduplicatedCodeFindings.filter(f => f.severity === 'blocker').length} blockers)`);
    console.error(`Total UI findings: ${deduplicatedUiFindings.length} (${deduplicatedUiFindings.filter(f => f.severity === 'blocker').length} blockers)`);
    if (dismissedBlockerCount > 0) {
      console.error(`Dismissed blockers: ${dismissedBlockerCount} (with justification; kept for audit)`);
    }
    console.error(`Verdict: ${hasBlockers ? 'NOT READY' : 'READY'}`);
    console.error('');
  }

  await options.reporter?.emit({
    event: 'review_complete',
    message: hasBlockers ? 'Review completed with blocker findings' : 'Review completed successfully',
    details: {
      verdict: hasBlockers ? 'not_ready' : 'ready',
      codeFindings: deduplicatedCodeFindings.length,
      uiFindings: deduplicatedUiFindings.length,
      blockers: rawBlockerCount,
      dismissedBlockers: dismissedBlockerCount,
    },
  });

  const finalResult: ReviewResult = {
    verdict: hasBlockers ? 'not_ready' : 'ready',
    codeReviewFindings: deduplicatedCodeFindings,
    uiFindings: deduplicatedUiFindings.length > 0 ? deduplicatedUiFindings : undefined,
    // Built from what each CLI call reported, never from the requested id
    // alone (HOK-3247): a model the CLI did not report stays unverified.
    substantiveAnalysisIdentity: combineAnalysisIdentities(
      results
        .map((result) => result.substantiveAnalysisIdentity)
        .filter((identity): identity is ExecutedIdentity => Boolean(identity)),
    ) ?? buildExecutedIdentity({
      role: 'substantive_analysis',
      requestedModel: model,
      resolvedModel: model,
      agent: `${cli.provider}-cli`,
      source: 'derived',
      verified: false,
    }),
    metadata: {
      branch: context.metadata.branch,
      files: context.metadata.files,
      hasUiChanges: context.metadata.hasUiChanges,
      designContextAvailable: context.designContext !== null,
      uiVerificationRun: deduplicatedUiFindings.length > 0,
    },
  };

  if (operatingMode !== 'normal') {
    finalResult.needsStrongerReviewer = results.some(result => result.needsStrongerReviewer === true);
    if (strongerReviewerReason) {
      finalResult.strongerReviewerReason = strongerReviewerReason;
    }
  }

  return finalResult;
}

export const reviewEngineTestUtils = {
  fillReviewPromptTemplate,
  getPersonaPromptPath,
  isNativeReviewOptedIn,
  loadPersonaPromptTemplate,
  looksLikeJson,
  parseNativeReviewResponse,
  setLoadNativeReviewModule(loader: typeof reviewEngineDeps.loadNativeReviewModule) {
    reviewEngineDeps.loadNativeReviewModule = loader;
  },
  setRunPersonaReview(fn: typeof reviewEngineDeps.runPersonaReview) {
    reviewEngineDeps.runPersonaReview = fn;
  },
  /** HOK-3247 seams: the CLI transport, the review-phase resolver, and native opt-in. */
  setCallLLM(fn: typeof reviewEngineDeps.callLLM) {
    reviewEngineDeps.callLLM = fn;
  },
  setResolveReviewAgent(fn: typeof reviewEngineDeps.resolveReviewAgent) {
    reviewEngineDeps.resolveReviewAgent = fn;
  },
  setIsNativeReviewOptedIn(fn: typeof reviewEngineDeps.isNativeReviewOptedIn) {
    reviewEngineDeps.isNativeReviewOptedIn = fn;
  },
  setBuildCliReviewAdapter(fn: typeof reviewEngineDeps.buildCliReviewAdapter) {
    reviewEngineDeps.buildCliReviewAdapter = fn;
  },
  resetDeps() {
    reviewEngineDeps.callLLM = callLLM;
    reviewEngineDeps.buildCliReviewAdapter = buildCliReviewAdapter;
    reviewEngineDeps.isNativeReviewOptedIn = isNativeReviewOptedIn;
    reviewEngineDeps.loadNativeReviewModule = async () => import('./native-agent/review.ts');
    reviewEngineDeps.resolveReviewAgent = resolveReviewAgent;
    reviewEngineDeps.runPersonaReview = runPersonaReview;
  },
};
