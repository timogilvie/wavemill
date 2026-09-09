/**
 * Stage Result — Controller-Owned Stage Result Artifacts (HOK-1192)
 *
 * Defines the schema and I/O helpers for per-stage result files written by
 * the orchestrator. Each stage (planning, coding, review, ready) gets a
 * `.{stage}-result.json` file in the feature directory.
 *
 * Key design rules:
 * - Only the orchestrator writes these files — agents never modify them
 * - Writes are atomic (temp file + rename) to prevent partial JSON
 * - Reads never throw — they return null for missing or malformed files
 * - The schema is additive — old files without `artifacts`/`failureReason`/cleanup/planning outcome fields remain valid
 *
 * @module stage-result
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { CodingArtifacts } from './native-agent/coding-artifacts.ts';
export type { CodingArtifacts } from './native-agent/coding-artifacts.ts';
import { validateSeamArtifactValue } from './seam-artifacts.ts';
import type { CleanupDecision, CleanupReport, TreeState } from './native-agent/cleanup.ts';
export type { CleanupDecision, CleanupReport, TreeState } from './native-agent/cleanup.ts';
import type { ReadyRemediationDecision } from './native-agent/workflow-tools/ready-remediation.ts';
export type { ReadyRemediationDecision } from './native-agent/workflow-tools/ready-remediation.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/** Status values for controller-owned stage result files. */
export type StageStatus = 'running' | 'awaiting_user' | 'completed' | 'aborted' | 'failed';

/** Stage names used in result file naming. */
export type StageName = 'planning' | 'coding' | 'review' | 'ready';

/** Valid stage names for runtime validation. */
const VALID_STAGES: readonly StageName[] = ['planning', 'coding', 'review', 'ready'] as const;

/** Valid status values for runtime validation. */
const VALID_STATUSES: readonly StageStatus[] = ['running', 'awaiting_user', 'completed', 'aborted', 'failed'] as const;

// ── Per-stage artifact types ──

/** Configured execution bounds for native planning. */
export interface PlanningExecutionBounds {
  maxTurns?: number;
  maxToolCalls?: number;
  maxWallClockMs?: number;
}

/** Observed execution usage for native planning. */
export interface PlanningExecutionUsage {
  turnsCompleted?: number;
  toolCallsExecuted?: number;
  wallClockMs?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCostUsd?: number;
}

/** Prompt registry reference used by native planning. */
export interface PlanningPromptRef {
  id: string;
  version: string;
}

/** Artifacts produced during the planning stage. */
export interface PlanningArtifacts {
  type: 'planning';
  planFile?: string;
  taskPacketFile?: string;
  transcriptFile?: string;
  validationError?: string;
  /** Configured native planning bounds, when available. */
  bounds?: PlanningExecutionBounds;
  /** Observed native planning usage, when available. */
  usage?: PlanningExecutionUsage;
  /** True when native planning produced a valid final plan artifact. */
  planArtifactValid?: boolean;
  /** True when native planning reached the approval-ready state. */
  approvalReady?: boolean;
  /** Prompt registry/provenance reference for the planning prompt. */
  promptRef?: PlanningPromptRef;
}

/** Artifacts produced during the review stage. */
export type ReviewOutcomeVerdict = 'ready' | 'not_ready' | 'error';
/**
 * The review scope guard could not evaluate scope (tool/git failure) — an
 * infrastructure condition, never evidence of a scope violation (HOK-2889).
 */
export const REVIEW_SCOPE_UNVERIFIABLE_FAILURE_CATEGORY = 'review-scope-unverifiable';
/**
 * The reviewed diff (at the current head/base) exceeds the reviewer's context
 * window. Bounded infrastructure recovery (HOK-2964): a stale-base rebuild or
 * a larger-context reroute may still resolve it, so it must never be treated
 * as a terminal code-defect solely because verdict=not_ready.
 */
export const NATIVE_CONTEXT_WINDOW_EXCEEDED_CATEGORY = 'native-context-window-exceeded';
/**
 * Typed provider billing/credit exhaustion (e.g. OpenRouter 402), matching
 * the `provider-credit-exhausted` kind from provider-error-classifier.ts and
 * arm-failure-taxonomy.ts. Recoverable once provider health returns
 * (HOK-2964 REQ-F5) — never collapsed into generic `native-review-failed`.
 */
export const PROVIDER_CREDIT_EXHAUSTED_CATEGORY = 'provider-credit-exhausted';
export const INFRA_REVIEW_FAILURE_CATEGORIES = [
  'native-runtime-unavailable',
  'native-review-prompt-missing',
  REVIEW_SCOPE_UNVERIFIABLE_FAILURE_CATEGORY,
  NATIVE_CONTEXT_WINDOW_EXCEEDED_CATEGORY,
  PROVIDER_CREDIT_EXHAUSTED_CATEGORY,
] as const;
export type InfrastructureReviewFailureCategory = typeof INFRA_REVIEW_FAILURE_CATEGORIES[number];

/**
 * A blocker the reviewer found, investigated, and disproved (HOK-2932).
 * Dismissals are auditable: the finding keeps its identity and the dismissal
 * requires a non-blank justification. The ready gate only credits entries
 * validated by {@link isValidBlockerDismissal}; anything else fails closed.
 */
export interface DismissedReviewBlocker {
  location?: string;
  category?: string;
  description?: string;
  /** Why the finding is invalid. Required and non-blank for the dismissal to count. */
  justification?: string;
  /** Verification the reviewer ran (e.g. a git/test command and its result). */
  evidence?: string;
}

export interface ReviewArtifacts {
  type: 'review';
  prNumber?: number;
  prUrl?: string;
  findingsCount?: number;
  blockingIssues?: number;
  /** Final self-review tool process exit code. */
  exitCode?: number;
  /** Final self-review outcome. Missing verdicts do not pass readiness. */
  verdict?: ReviewOutcomeVerdict;
  /** Number of self-review tool iterations attempted. */
  iterations?: number;
  /** Final raw blocker count reported by self-review (kept for audit; the gate uses the effective count). */
  blockerCount?: number;
  /** Final warning count reported by self-review. */
  warningCount?: number;
  /** Blockers the reviewer investigated and disproved, each with a justification. */
  dismissedBlockers?: DismissedReviewBlocker[];
  /** Review tool failure summary when the final run errored. */
  reviewToolError?: string;
  /** Retryable infrastructure category when review could not run meaningfully. */
  failureCategory?: string;
  /** Structured diagnostics captured for review tool failures. */
  diagnostics?: Record<string, unknown>;
  /** Head SHA reviewed for this artifact; a later head makes it stale (HOK-2964). */
  reviewHeadSha?: string;
}

export interface ReviewOutcome {
  exitCode?: number;
  verdict?: ReviewOutcomeVerdict;
  iterations?: number;
  blockerCount?: number;
  warningCount?: number;
  dismissedBlockers?: DismissedReviewBlocker[];
  reviewToolError?: string;
  failureCategory?: string;
  diagnostics?: Record<string, unknown>;
}

/** Artifacts produced during the ready stage. */
export interface ReadyArtifacts {
  type: 'ready';
  verdict?: 'pass' | 'fail' | 'warn' | 'pending';
  checksRun?: number;
  checksPassed?: number;
  mergeConflict?: string;
  prNumber?: number;
  readyLabelsUpdated?: boolean;
  launchHead?: string;
  remediationAttempts?: number;
  remediationLaunchHead?: string;
  remediationFailures?: string[];
  /** Main branch HEAD SHA at the time readiness passed; used to detect staleness. */
  readyBaseSha?: string;
  readyHeadSha?: string;
  ciConclusion?: string;
  requiredContexts?: string[];
  requiredSource?: string;
  queueState?: 'ready' | 'ready-stale' | 'merge-candidate';
  staleAt?: string;
  staleBaseSha?: string;
  targetBaseSha?: string;
  candidatePromotedAt?: string;
  candidateLastProgressAt?: string;
  mergeRetryInProgressUntil?: string;
  candidateSkippedAt?: string;
  candidateSkipReason?: string;
  lastCiConclusion?: string;
  lastCiHeadSha?: string;
  lastCiObservedAt?: string;
  lastCiSummary?: string;
  ciInvalidatedAt?: string;
  ciInvalidationReason?: string;
  ciFailingChecks?: string[];
  changedFiles?: string[];
  unblocksCount?: number;
  transientMergeabilityAttempts?: number;
  crossPrGuard?: {
    source: 'cross-pr-revert-guard';
    status: 'blocked' | 'tool-error' | 'passed';
    checkedHeadSha?: string;
    reason?: string;
    result?: unknown;
    toolError?: unknown;
  };
  /** Per-edit-path guardrail decision for stale-base / merge-conflict remediation (HOK-2361). */
  remediationDecision?: ReadyRemediationDecision;
}

/** Pending human approval metadata surfaced by approval-needed stage results. */
export interface ApprovalRequestArtifact {
  requestId: string;
  riskReason: string;
  argSummary?: string;
  expiresAt?: number;
}

/** Discriminated union of all stage artifact types. */
export type StageArtifacts = (
  | PlanningArtifacts
  | CodingArtifacts
  | ReviewArtifacts
  | ReadyArtifacts
) & {
  /** Present when a stage is paused in an approval-needed runtime state. */
  approvalRequest?: ApprovalRequestArtifact;
};

/**
 * Structure of a `.<stage>-result.json` file written by the orchestrator.
 *
 * Fields `artifacts` and `failureReason` are optional for backward
 * compatibility with files created before HOK-1192.
 */
export interface StageResult {
  stage: StageName;
  status: StageStatus;
  startedAt: string;
  finishedAt: string | null;
  agent: string;
  model: string;
  notes: string;
  artifacts?: StageArtifacts;
  failureReason?: string | null;
  finalTreeState?: TreeState;
  cleanupDecision?: CleanupDecision;
  cleanupReport?: CleanupReport;
  /** Previous terminal attempts preserved when recovery starts a fresh run. */
  history?: StageResultHistoryEntry[];
}

export type StageResultHistoryEntry = Pick<
  StageResult,
  'status' | 'agent' | 'model' | 'startedAt' | 'finishedAt' | 'notes'
> & {
  error?: string;
  failureReason?: string | null;
};

/** All stage result files found in a feature directory. */
export interface StageResultMap {
  planning?: StageResult;
  coding?: StageResult;
  review?: StageResult;
  ready?: StageResult;
}

// ────────────────────────────────────────────────────────────────
// Path Helpers
// ────────────────────────────────────────────────────────────────

/**
 * Get the file path for a stage result file.
 *
 * @param featureDir - Absolute path to the feature directory
 * @param stage - Stage name
 * @returns Absolute path to `<featureDir>/.<stage>-result.json`
 */
export function getResultFilePath(featureDir: string, stage: StageName): string {
  return path.join(featureDir, `.${stage}-result.json`);
}

// ────────────────────────────────────────────────────────────────
// Read Helpers
// ────────────────────────────────────────────────────────────────

/**
 * Read a single stage result file.
 *
 * Returns `null` when the file is missing, empty, or contains invalid JSON.
 * Validates that the `stage` field in the file matches the requested stage.
 * Never throws.
 *
 * @param featureDir - Absolute path to the feature directory
 * @param stage - Stage name to read
 * @returns Parsed StageResult or null
 */
export async function readStageResult(
  featureDir: string,
  stage: StageName,
): Promise<StageResult | null> {
  const resultPath = getResultFilePath(featureDir, stage);
  try {
    const content = await fs.readFile(resultPath, 'utf-8');
    if (!content.trim()) {
      process.stderr.write(`stage-result: empty file at ${resultPath}\n`);
      return null;
    }
    const parsed = JSON.parse(content) as StageResult;
    const validation = validateSeamArtifactValue<StageResult>('stage-result', parsed);
    if (!validation.ok) {
      process.stderr.write(
        `stage-result: invalid ${resultPath}: ${formatSeamErrors(validation.errors)}\n`,
      );
      return null;
    }
    if (validation.value.stage !== stage) {
      process.stderr.write(
        `stage-result: invalid ${resultPath}: INVALID_STAGE at $.stage: expected '${stage}', got '${validation.value.stage}'\n`,
      );
      return null;
    }
    return validation.value;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    process.stderr.write(`stage-result: failed to read ${resultPath}: ${err}\n`);
    return null;
  }
}

/**
 * Read all stage result files from a feature directory.
 *
 * Looks for `.planning-result.json`, `.coding-result.json`, etc.
 * Invalid or missing files are silently skipped.
 *
 * @param featureDir - Absolute path to the feature directory
 * @returns Map of stage name to result (only populated stages included)
 */
export async function readAllStageResults(featureDir: string): Promise<StageResultMap> {
  const results: StageResultMap = {};

  for (const stage of VALID_STAGES) {
    const result = await readStageResult(featureDir, stage);
    if (result) {
      results[stage] = result;
    }
  }

  return results;
}

// ────────────────────────────────────────────────────────────────
// Review Outcome Helpers
// ────────────────────────────────────────────────────────────────

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function reviewVerdict(value: unknown): ReviewOutcomeVerdict | undefined {
  return value === 'ready' || value === 'not_ready' || value === 'error'
    ? value
    : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Normalize a raw `dismissedBlockers` value. Non-array input returns undefined;
 * non-object entries are preserved as empty records so they fail validation
 * (and therefore the gate) instead of silently disappearing.
 */
function extractDismissedBlockers(value: unknown): DismissedReviewBlocker[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) => {
    const record = objectRecord(entry);
    if (!record) return {};
    return {
      location: optionalString(record.location),
      category: optionalString(record.category),
      description: optionalString(record.description),
      justification: optionalString(record.justification),
      evidence: optionalString(record.evidence),
    };
  });
}

/**
 * Extract explicit final self-review evidence from either review artifact shape:
 * the shell path writes top-level `{type:"review", ...}` artifacts, while the
 * native path historically wrote nested `{review:{...}}` artifacts.
 */
export function extractReviewOutcome(result: StageResult | null | undefined): ReviewOutcome | null {
  const artifacts = objectRecord(result?.artifacts);
  if (!artifacts) return null;

  if (artifacts.type === 'review') {
    const blockerCount = finiteNumber(artifacts.blockerCount) ?? finiteNumber(artifacts.blockingIssues);
    const warningCount = finiteNumber(artifacts.warningCount);
    return {
      exitCode: finiteNumber(artifacts.exitCode),
      verdict: reviewVerdict(artifacts.verdict),
      iterations: finiteNumber(artifacts.iterations),
      blockerCount,
      warningCount,
      dismissedBlockers: extractDismissedBlockers(artifacts.dismissedBlockers),
      reviewToolError: typeof artifacts.reviewToolError === 'string' ? artifacts.reviewToolError : undefined,
      failureCategory: typeof artifacts.failureCategory === 'string' ? artifacts.failureCategory : undefined,
      diagnostics: objectRecord(artifacts.diagnostics),
    };
  }

  const nested = objectRecord(artifacts.review);
  if (nested) {
    const blockerCount = finiteNumber(nested.blockerCount) ?? finiteNumber(nested.blockingCount);
    const warningCount = finiteNumber(nested.warningCount);
    return {
      exitCode: finiteNumber(nested.exitCode),
      verdict: reviewVerdict(nested.verdict),
      iterations: finiteNumber(nested.iterations),
      blockerCount,
      warningCount,
      dismissedBlockers: extractDismissedBlockers(nested.dismissedBlockers),
      reviewToolError: typeof nested.reviewToolError === 'string' ? nested.reviewToolError : undefined,
      failureCategory: typeof nested.failureCategory === 'string' ? nested.failureCategory : undefined,
      diagnostics: objectRecord(nested.diagnostics),
    };
  }

  return null;
}

export function isInfrastructureReviewFailure(
  input: StageResult | ReviewArtifacts | ReviewOutcome | null | undefined,
): boolean {
  if (!input) return false;
  const outcome = isStageResultLike(input)
    ? extractReviewOutcome(input)
    : input as ReviewArtifacts | ReviewOutcome;
  if (!outcome) return false;
  const failureCategory = typeof outcome.failureCategory === 'string' ? outcome.failureCategory : undefined;
  if (
    failureCategory
    && (INFRA_REVIEW_FAILURE_CATEGORIES as readonly string[]).includes(failureCategory)
  ) {
    return true;
  }
  return outcome.verdict === 'error'
    && typeof outcome.reviewToolError === 'string'
    && outcome.reviewToolError.trim() !== '';
}

function isStageResultLike(value: unknown): value is StageResult {
  const record = objectRecord(value);
  return record?.stage === 'review' && typeof record.status === 'string';
}

/** A dismissal only counts when it carries a non-blank justification. */
export function isValidBlockerDismissal(
  dismissal: DismissedReviewBlocker | null | undefined,
): boolean {
  return typeof dismissal?.justification === 'string' && dismissal.justification.trim() !== '';
}

/**
 * Effective (undismissed) blocker count, derived from the auditable dismissal
 * entries — never from an unexplained count. Fails closed: any malformed entry
 * or dismissals exceeding the raw count yields no credit (raw count returned).
 * Returns undefined when no raw blocker count was recorded.
 */
export function reviewEffectiveBlockerCount(
  outcome: ReviewOutcome | ReviewArtifacts | null | undefined,
): number | undefined {
  const raw = finiteNumber(outcome?.blockerCount);
  if (raw === undefined) return undefined;
  const dismissals = outcome?.dismissedBlockers;
  if (!Array.isArray(dismissals) || dismissals.length === 0) return raw;
  if (!dismissals.every(isValidBlockerDismissal)) return raw;
  if (dismissals.length > raw) return raw;
  return raw - dismissals.length;
}

/**
 * Readiness rule shared by every gate consumer (HOK-2932):
 * - Legacy pass: exit 0, verdict `ready`, zero raw blockers — unchanged.
 * - Ready with dismissals: exit 0, verdict `ready`, every raw blocker validly dismissed.
 * - Dismissed not_ready: exit 1, verdict `not_ready`, at least one raw blocker,
 *   and every one of them validly dismissed with a justification.
 * Anything else — malformed dismissal, count mismatch, remaining blocker — fails.
 */
export function reviewOutcomePassesReadyGate(outcome: ReviewOutcome | null | undefined): boolean {
  if (!outcome) return false;
  if (typeof outcome.iterations !== 'number' || outcome.iterations < 1) return false;
  const raw = outcome.blockerCount;
  if (typeof raw !== 'number') return false;
  const effective = reviewEffectiveBlockerCount(outcome);
  if (effective !== 0) return false;
  if (outcome.exitCode === 0 && outcome.verdict === 'ready') return true;
  return outcome.exitCode === 1
    && outcome.verdict === 'not_ready'
    && raw >= 1
    && (outcome.dismissedBlockers?.length ?? 0) === raw;
}

/**
 * Strict readiness predicate. A completed review stage is not enough; readiness
 * requires a recorded successful final self-review run with zero *effective*
 * blockers — either none were found, or every one was auditably dismissed.
 */
export function reviewResultPassed(result: StageResult | null | undefined): boolean {
  if (result?.status !== 'completed') return false;
  return reviewOutcomePassesReadyGate(extractReviewOutcome(result));
}

// ────────────────────────────────────────────────────────────────
// Write Helpers
// ────────────────────────────────────────────────────────────────

/**
 * Write a stage result file atomically.
 *
 * Creates the feature directory if it doesn't exist. Writes to a temporary
 * file first, then renames to the final path to prevent partial JSON on crash.
 *
 * @param featureDir - Absolute path to the feature directory
 * @param result - Complete StageResult to write
 */
export async function writeStageResult(
  featureDir: string,
  result: StageResult,
): Promise<void> {
  await fs.mkdir(featureDir, { recursive: true });

  const validation = validateSeamArtifactValue('stage-result', result);
  if (!validation.ok) {
    throw new Error(`Invalid stage result: ${formatSeamErrors(validation.errors)}`);
  }

  const resultPath = getResultFilePath(featureDir, result.stage);
  const tmpPath = path.join(featureDir, `.tmp-${result.stage}-result.json`);

  const json = JSON.stringify(result, null, 2) + '\n';
  await fs.writeFile(tmpPath, json, 'utf-8');
  await fs.rename(tmpPath, resultPath);
}

/**
 * Update a stage result file with a partial patch.
 *
 * Reads the existing file (if any), merges the patch on top, and writes
 * the result atomically. If no existing file exists, the patch is written
 * as a new result (requires at minimum `stage` and `status` in the patch).
 *
 * The `startedAt` field from the existing result is preserved unless
 * explicitly overridden in the patch.
 *
 * @param featureDir - Absolute path to the feature directory
 * @param stage - Stage name to update
 * @param patch - Partial StageResult fields to merge
 */
export async function updateStageResult(
  featureDir: string,
  stage: StageName,
  patch: Partial<StageResult>,
): Promise<void> {
  const existing = await readStageResult(featureDir, stage);

  const merged: StageResult = {
    stage,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    agent: '',
    model: '',
    notes: '',
    ...existing,
    ...patch,
    stage, // always enforce stage from argument, not patch
  };

  await writeStageResult(featureDir, merged);
}

export async function writeStageResultWithHistory(
  featureDir: string,
  stage: StageName,
  patch: Partial<StageResult>,
): Promise<void> {
  const existing = await readStageResult(featureDir, stage);
  const now = new Date().toISOString();
  const existingHistory = existing?.history ?? [];
  const shouldArchive = existing?.status === 'failed' || existing?.status === 'aborted';
  const historyEntry: StageResultHistoryEntry[] = shouldArchive && existing
    ? [{
      status: existing.status,
      agent: existing.agent,
      model: existing.model,
      startedAt: existing.startedAt,
      finishedAt: existing.finishedAt,
      notes: existing.notes,
      ...(existing.failureReason !== undefined ? { failureReason: existing.failureReason } : {}),
    }]
    : [];

  const result: StageResult = {
    stage,
    status: 'running',
    startedAt: now,
    finishedAt: null,
    agent: '',
    model: '',
    notes: '',
    ...patch,
    stage,
    status: patch.status ?? 'running',
    startedAt: patch.startedAt ?? now,
    finishedAt: patch.finishedAt ?? null,
    history: [...existingHistory, ...historyEntry],
  };

  await writeStageResult(featureDir, result);
}

// ────────────────────────────────────────────────────────────────
// Validation Helpers (for CLI)
// ────────────────────────────────────────────────────────────────

/** Check if a string is a valid stage name. */
export function isValidStage(value: string): value is StageName {
  return (VALID_STAGES as readonly string[]).includes(value);
}

/** Check if a string is a valid stage status. */
export function isValidStatus(value: string): value is StageStatus {
  return (VALID_STATUSES as readonly string[]).includes(value);
}

function formatSeamErrors(errors: readonly { code: string; path: string; message: string }[]): string {
  return errors.map((error) => `${error.code} at ${error.path}: ${error.message}`).join('; ');
}
