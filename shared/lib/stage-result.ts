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
import { resolveTaskArtifact } from './task-artifact-lookup.ts';
import type { CleanupDecision, CleanupReport, TreeState } from './native-agent/cleanup.ts';
import type { PiRuntimeVersions } from './native-agent/pi-runtime-version.ts';
export type { CleanupDecision, CleanupReport, TreeState } from './native-agent/cleanup.ts';
import type { ReadyRemediationDecision } from './native-agent/workflow-tools/ready-remediation.ts';
export type { ReadyRemediationDecision } from './native-agent/workflow-tools/ready-remediation.ts';
import type { ReviewExecutedIdentitySet } from './challenge-execution-contract.ts';
export type { ReviewExecutedIdentitySet, ExecutedIdentity, ExecutedIdentityRole } from './challenge-execution-contract.ts';
import { challengeModelIdsEquivalent } from './challenge-comparison.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/** Status values for controller-owned stage result files. */
export type StageStatus = 'running' | 'awaiting_user' | 'completed' | 'aborted' | 'failed';

/** Stage names used in result file naming. */
export type StageName = 'planning' | 'coding' | 'review' | 'ready';

/** How the orchestrator resolved execution identity for a stage result. */
export type StageExecutionEvidenceStatus = 'direct' | 'missing' | 'contradicted' | 'inherited';

/** Stable reason a stage result cannot be used for model-quality attribution. */
export type ModelAttributionIneligibleReason =
  | 'stage_not_completed'
  | 'missing_execution_evidence'
  | 'execution_contradicted'
  | 'runtime_fallback'
  /**
   * HOK-3143: the provider substituted a different concrete model than the
   * one certified for this run (either an alias target drift or a non-alias
   * substitution). Attribution would mis-credit the certified identity.
   */
  | 'provider_substitution';

/** Durable execution-truth evidence for stage result model attribution. */
export interface StageExecutionEvidence {
  /** Evidence state: direct runtime evidence, absent evidence, contradiction, or inherited pre-fork evidence. */
  status: StageExecutionEvidenceStatus;
  /** Producer/source that supplied the evidence, for example native-runtime or stage-result-cli. */
  source?: string;
  /** Optional human-readable diagnostic context. Not a model-quality target. */
  detail?: string;
  /** Timestamp at which the evidence stamp was produced. */
  recordedAt?: string;
  /**
   * Provider-reported model id (HOK-3143), when the run captured one from a
   * live provider response. Absent for scripted/test runs or when the provider
   * returned no `response.model`.
   */
  providerReportedModel?: string;
  /** The wire id originally sent to the provider (useful when it is an alias). */
  requestedWireId?: string;
  /** Pinned certified target that the reported model was compared against. */
  certifiedTarget?: string;
  /** Verdict from the runtime provider-identity check. */
  identityVerdict?: 'match' | 'alias-resolved' | 'mismatch' | 'unverifiable' | 'absent';
  /** Transport provider name (e.g. `openrouter`). */
  transportProvider?: string;
  /**
   * Upstream provider name from the provider's response (e.g. "Google AI Studio").
   * Not yet populated — Pi 0.79.8 drops this field (plan D4); follow-up to
   * capture it when the SDK exposes it.
   */
  upstreamProvider?: string;
  /** Provider response id corroborating the reported model. */
  responseId?: string;
  /**
   * Installed Pi runtime versions that ran this stage (HOK-3164). Native token
   * and cost profiles shift across Pi upgrades, so analysis keys on this
   * rather than run dates. Absent for non-native agents and pre-HOK-3164 rows.
   */
  piRuntimeVersions?: PiRuntimeVersions;
}

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

/**
 * Observed execution usage for a native stage run (planning, coding, review).
 *
 * The cache fields (HOK-3260) are projected from the per-turn provider usage
 * the native loop already reads for cost — not a second counter. They are the
 * cache numbers the SDK cost summaries (HOK-3076 / HOK-3077) read; legacy
 * `workflowCost` gets no parallel copy.
 */
export interface StageExecutionUsage {
  turnsCompleted?: number;
  toolCallsExecuted?: number;
  wallClockMs?: number;
  /** Uncached input tokens (excludes cache reads and writes). */
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCostUsd?: number;
  /** Cache-read tokens summed over every turn. */
  cacheReadTokens?: number;
  /** Cache-write (creation) tokens summed over every turn. */
  cacheWriteTokens?: number;
  /**
   * `cacheRead / (input + cacheRead + cacheWrite)` over turns 2..n; null when
   * the run had fewer than two turns with usage. Absent on legacy artifacts.
   */
  cacheHitRate?: number | null;
  /** Transport provider the loop called (e.g. `anthropic`, `openrouter`). */
  providerRoute?: string;
}

/** @deprecated Use {@link StageExecutionUsage}; kept for one release (HOK-3260). */
export type PlanningExecutionUsage = StageExecutionUsage;

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
  usage?: StageExecutionUsage;
  /** True when native planning produced a valid final plan artifact. */
  planArtifactValid?: boolean;
  /** True when native planning reached the approval-ready state. */
  approvalReady?: boolean;
  /** Prompt registry/provenance reference for the planning prompt. */
  promptRef?: PlanningPromptRef;
  /**
   * HOK-3129: true when launchNativePlanning executed exactly one bounded
   * repair turn after a format-only validation reason (missing_title,
   * missing_release_readiness, etc). Absent on legacy artifacts and on
   * runs that short-circuited before the validator.
   */
  repairAttempted?: boolean;
  /**
   * HOK-3129: true when the initial plan was emitted in a single assistant
   * turn with zero tool calls — a quality signal (the plan was written
   * without reading the repo). Absent on legacy artifacts.
   */
  zeroToolCallPlan?: boolean;
}

/** Artifacts produced during the review stage. */
export type ReviewOutcomeVerdict = 'ready' | 'not_ready' | 'error';
/**
 * The review scope guard could not evaluate scope (tool/git failure) — an
 * infrastructure condition, never evidence of a scope violation (HOK-2889).
 */
export const REVIEW_SCOPE_UNVERIFIABLE_FAILURE_CATEGORY = 'review-scope-unverifiable';
/**
 * The review's changed-file set is a strict superset of the PR's own file
 * list at the same head — the diff base is stale, so reviewing would flag
 * other PRs' merged code (HOK-3166). Infrastructure, never a code defect: a
 * retry re-fetches `origin/<base>`, which is the remedy.
 */
export const REVIEW_SCOPE_MISMATCH_FAILURE_CATEGORY = 'review-scope-mismatch';
/**
 * Even the budgeted review input (HOK-3249) exceeds the reviewer's context
 * window — the code alone is too large. Infrastructure, never a code defect
 * (even with verdict=not_ready); the failure policy (HOK-3176) classifies it
 * as terminal `context-window-exceeded`, so it escalates instead of retrying.
 */
export const NATIVE_CONTEXT_WINDOW_EXCEEDED_CATEGORY = 'native-context-window-exceeded';
/**
 * Typed provider billing/credit exhaustion (e.g. OpenRouter 402), matching
 * the `provider-credit-exhausted` kind from provider-error-classifier.ts and
 * arm-failure-taxonomy.ts. Recoverable once provider health returns
 * (HOK-2964 REQ-F5) — never collapsed into generic `native-review-failed`.
 */
export const PROVIDER_CREDIT_EXHAUSTED_CATEGORY = 'provider-credit-exhausted';
export const NATIVE_REVIEW_TIMEOUT_CATEGORY = 'native-review-timeout';
/**
 * The native reviewer delivered an unparseable or empty final message
 * (HOK-3169). This is a model-protocol / infra failure, not a substantive
 * verdict — the reviewer never produced a usable `ready` / `not_ready`
 * decision — so it must route through the bounded `review-infra-recovery`
 * bucket rather than terminalizing the Ready gate.
 */
export const NATIVE_REVIEW_MALFORMED_RESPONSE_CATEGORY = 'native-review-malformed-response';
/**
 * The native reviewer's input diff was empty (zero bytes) at review time
 * (HOK-3169). Running the model on an empty diff invites it to improvise a
 * non-verdict (surfacing later as `native-review-malformed-response`); the
 * short-circuit returns this typed infra failure before the model is called
 * so the bounded recovery path can retry once the diff is populated (e.g.
 * after a stale-base rebuild).
 */
export const REVIEW_SCOPE_EMPTY_FAILURE_CATEGORY = 'review-scope-empty';
/**
 * The requested reviewer model cannot run the review's substantive analysis
 * (HOK-3247): `resolveModelAgent` refused it for the review phase, it resolves
 * to a native agent while native review is not opted in for the repo, or no
 * ready native provider serves exactly that model. The review fails closed
 * instead of silently analysing with a different model.
 *
 * Classified by result shape rather than by a static list entry, because the
 * right class depends on who pinned the model:
 * - routed (non-challenge) reviewer — `verdict: "error"`: retryable
 *   infrastructure. A re-certification or reroute can make the model
 *   launchable, so the bounded `review-infra-recovery` bucket retries it and
 *   escalates to needs-user with evidence (HOK-3176: not terminal-allowlisted).
 * - challenge-pinned reviewer — `verdict: "not_ready"` with a blocker
 *   (`review-runner.ts`): the pin is frozen by the route invariant (HOK-3156),
 *   so a retry cannot change it; this is a harness fault and Ready's
 *   review-gate refusal retires the arm as
 *   `invalid_challenge:review-identity-mismatch` (HOK-3154).
 * See {@link isInfrastructureReviewFailure} and the monitor's
 * `review_result_infra_failure` / `review_refused_challenge_cause`.
 */
export const REVIEW_MODEL_UNLAUNCHABLE_FAILURE_CATEGORY = 'review-model-unlaunchable';
export const INFRA_REVIEW_FAILURE_CATEGORIES = [
  'native-runtime-unavailable',
  'native-review-prompt-missing',
  REVIEW_SCOPE_UNVERIFIABLE_FAILURE_CATEGORY,
  REVIEW_SCOPE_MISMATCH_FAILURE_CATEGORY,
  REVIEW_SCOPE_EMPTY_FAILURE_CATEGORY,
  NATIVE_CONTEXT_WINDOW_EXCEEDED_CATEGORY,
  PROVIDER_CREDIT_EXHAUSTED_CATEGORY,
  NATIVE_REVIEW_TIMEOUT_CATEGORY,
  NATIVE_REVIEW_MALFORMED_RESPONSE_CATEGORY,
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

/** Disposition of a structured review finding within an iteration record. */
export type ReviewFindingDisposition = 'open' | 'fixed' | 'dismissed' | 'wont_fix';

/**
 * One structured finding persisted for a review iteration (HOK-2969).
 *
 * This is the local, task-owned evidence record — it is never sent across
 * the Hokusai privacy boundary. Only derived counts/booleans cross that
 * boundary (see `hokusai-schema.ts`).
 */
export interface ReviewFindingRecord {
  location: string;
  category: string;
  severity: 'blocker' | 'warning';
  description: string;
  /** Verification the reviewer performed (e.g. a command and its observed result). */
  evidence?: string;
  /** The reviewer's suggested remediation, when offered. */
  proposedFix?: string;
  disposition: ReviewFindingDisposition;
  /** Required, non-blank when `disposition` is `dismissed` (HOK-2932). */
  dismissalJustification?: string;
  dismissalEvidence?: string;
}

/** A reproduction/test command the reviewer ran and its observed result. */
export interface ReviewCommandRecord {
  command: string;
  exitCode?: number;
  output?: string;
}

/**
 * The reviewer-authored delta relative to the shared challenge fork commit,
 * anchored by SHA rather than embedding the raw diff (kept local-only).
 */
export interface ReviewerDeltaRecord {
  /** Commit both challenge arms shared before diverging. */
  forkCommit?: string;
  /** Head SHA this iteration reviewed. */
  reviewedHeadSha?: string;
  /** Head SHA after remediation for this iteration, if any commits were made. */
  remediatedHeadSha?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
}

/**
 * One `review_changes` run's complete local evidence: findings, commands,
 * and the reviewer's own delta relative to the fork point. Iterations are
 * append-only — a rerun never overwrites a prior iteration's evidence
 * (HOK-2969).
 */
export interface ReviewIterationRecord {
  /** 1-based iteration number within this arm's review stage. */
  iteration: number;
  recordedAt: string;
  verdict?: ReviewOutcomeVerdict;
  findings: ReviewFindingRecord[];
  /** Reproduction/test commands executed during this iteration, if any. */
  commands?: ReviewCommandRecord[];
  reviewerDelta?: ReviewerDeltaRecord;
  headSha?: string;
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
  /**
   * Complete per-iteration local evidence, append-only across reruns
   * (HOK-2969). Populated by native review producers; absent on artifacts
   * written before this field existed.
   */
  reviewIterations?: ReviewIterationRecord[];
  /**
   * Orchestrator, substantive-analysis, and remediation identities executed
   * for this review stage, including fallback/conflict status (HOK-2969).
   */
  reviewExecutedIdentity?: ReviewExecutedIdentitySet;
  /** Native substantive-analysis loop usage, when a native reviewer ran (HOK-3260). */
  usage?: StageExecutionUsage;
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
  /**
   * Legacy display model. New attribution readers must use `executedModel`
   * and `modelAttributionEligible`; this field may be launch intent on
   * shell-written artifacts kept for backward-compatible diagnostics.
   */
  model: string;
  /** Model requested by routing/launch, retained for diagnostics. */
  intendedModel?: string | null;
  /** Model proven to have executed, or null/absent when durable evidence is missing. */
  executedModel?: string | null;
  /** Evidence/provenance used to decide `executedModel`. */
  executionEvidence?: StageExecutionEvidence;
  /** True only when this stage can emit model-quality attribution. */
  modelAttributionEligible?: boolean;
  /** Stable reason when `modelAttributionEligible` is false. */
  modelAttributionIneligibleReason?: ModelAttributionIneligibleReason;
  notes: string;
  artifacts?: StageArtifacts;
  failureReason?: string | null;
  finalTreeState?: TreeState;
  cleanupDecision?: CleanupDecision;
  cleanupReport?: CleanupReport;
  /** Previous terminal attempts preserved when recovery starts a fresh run. */
  history?: StageResultHistoryEntry[];
  /**
   * Set to `"inherited"` when the artifact was carried across a challenge
   * fork rather than produced by a run in this arm's worktree (HOK-2811,
   * Arbiter P2.4a). Absent on any locally produced artifact.
   */
  source?: 'inherited';
}

export type StageResultHistoryEntry = Pick<
  StageResult,
  'status' | 'agent' | 'model' | 'intendedModel' | 'executedModel' | 'startedAt' | 'finishedAt' | 'notes'
> & {
  error?: string;
  failureReason?: string | null;
  modelAttributionEligible?: boolean;
  modelAttributionIneligibleReason?: ModelAttributionIneligibleReason;
};

/** All stage result files found in a feature directory. */
export interface StageResultMap {
  planning?: StageResult;
  coding?: StageResult;
  review?: StageResult;
  ready?: StageResult;
}

export interface ExecutionTruthFieldsInput {
  status: StageStatus;
  flags: Record<string, string>;
  existing: StageResult | null;
  now: string;
  /**
   * HOK-3369: ISO timestamp of the stage's latest launch row in
   * `.session-ownership.jsonl`. When provided and greater than the existing
   * evidence's `recordedAt`, the evidence is treated as belonging to a prior
   * attempt and is replaced on completion. Callers that cannot read ownership
   * (resolver throws, legacy state, non-ownership stages like `ready`) should
   * leave it null — the merge rule then keeps existing evidence.
   */
  latestLaunchAt?: string | null;
  /**
   * HOK-3369: true when this write is a fresh launch (the CLI's
   * `write-with-history` subcommand). A new attempt resets evidence to
   * `missing` because any carried-over evidence belongs to a prior run.
   */
  newAttempt?: boolean;
  /**
   * HOK-3369: optional repo root for the registry-backed model equivalence
   * check (`challengeModelIdsEquivalent`). Omitted callers get the default
   * registry (which currently ignores repo dir).
   */
  repoDir?: string;
}

export type ExecutionTruthFields = Pick<
  StageResult,
  'intendedModel' | 'executedModel' | 'executionEvidence' | 'modelAttributionEligible' | 'modelAttributionIneligibleReason'
>;

function nullableModel(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === 'null') return null;
  return trimmed;
}

function boolFlag(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function validEvidenceStatus(value: string | undefined): value is StageExecutionEvidenceStatus {
  return value === 'direct' || value === 'missing' || value === 'contradicted' || value === 'inherited';
}

/**
 * HOK-3369: predicate for the one merge rule in {@link executionTruthFields}.
 *
 * A later stage-result write with no new evidence must never downgrade an
 * existing `direct` / `inherited` record. The exceptions are explicit
 * evidence flags (D3.1) and a fresh attempt (D3.2) — either the caller
 * passed `newAttempt: true`, or the stage's latest launch row post-dates the
 * existing evidence's `recordedAt` (so that evidence belongs to a prior run).
 *
 * Returns the kept evidence block or null. The block is kept whole —
 * `recordedAt` is NOT restamped, because the superseded check depends on it.
 */
function keptEvidence(
  input: ExecutionTruthFieldsInput,
): { evidence: StageExecutionEvidence; executedModel: string | null } | null {
  const existing = input.existing;
  if (!existing) return null;
  const existingEvidence = existing.executionEvidence;
  if (!existingEvidence) return null;
  // Only direct and inherited evidence is kept across writes. A prior
  // `missing` or `contradicted` carries nothing worth preserving.
  if (existingEvidence.status !== 'direct' && existingEvidence.status !== 'inherited') return null;
  // Explicit evidence flags replace existing evidence (D3.1).
  if (input.flags['executed-model'] !== undefined) return null;
  if (input.flags['execution-evidence-status'] !== undefined) return null;
  if (input.flags['execution-evidence-source'] !== undefined) return null;
  // Detail is descriptive, not new execution evidence. In particular,
  // `stage-result-cli update --execution-evidence-detail …` must not erase
  // a prior direct provider-response record (HOK-3322 operator recovery).
  // A fresh launch attempt resets evidence (D3.2).
  if (input.newAttempt) return null;
  // Superseded by a later launch row (D3.2).
  if (input.latestLaunchAt && existingEvidence.recordedAt) {
    const launchMs = Date.parse(input.latestLaunchAt);
    const recordedMs = Date.parse(existingEvidence.recordedAt);
    if (Number.isFinite(launchMs) && Number.isFinite(recordedMs) && launchMs > recordedMs) {
      return null;
    }
  }
  return { evidence: existingEvidence, executedModel: existing.executedModel ?? null };
}

/**
 * Compute the execution-truth and attribution-eligibility block for a stage result.
 *
 * This function intentionally never infers `executedModel` from launch intent:
 * callers must pass direct execution evidence, or the result remains
 * attribution-ineligible with `missing_execution_evidence`.
 *
 * HOK-3369 — the merge rule: a later write with no new evidence keeps
 * existing `direct` / `inherited` evidence as a whole block (including
 * `recordedAt`). Only explicit evidence flags or a new launch attempt
 * (`newAttempt: true`, or `latestLaunchAt > existing.recordedAt`) replace it.
 * Model-attribution eligibility uses `challengeModelIdsEquivalent` so two
 * spellings of the same registry entry (`kimi-k2-thinking` vs
 * `moonshotai/kimi-k2-thinking`) do not spuriously flag `runtime_fallback`.
 */
export function executionTruthFields(input: ExecutionTruthFieldsInput): ExecutionTruthFields {
  const flagModel = nullableModel(input.flags.model);
  const intendedModel = nullableModel(input.flags['intended-model'])
    ?? flagModel
    ?? input.existing?.intendedModel
    ?? (input.flags.model === undefined ? input.existing?.model : undefined)
    ?? null;

  const kept = keptEvidence(input);
  const explicitExecuted = nullableModel(input.flags['executed-model']);

  let executedModel: string | null;
  let executionEvidence: StageExecutionEvidence;

  if (kept) {
    // D3.3: keep the existing evidence block as-is. `recordedAt` is NOT
    // restamped — rule D3.2 (superseded by a later launch) depends on it.
    executedModel = kept.executedModel;
    executionEvidence = kept.evidence;
  } else {
    const explicitEvidenceStatus = input.flags['execution-evidence-status'];
    if (explicitEvidenceStatus !== undefined && !validEvidenceStatus(explicitEvidenceStatus)) {
      throw new Error(`invalid --execution-evidence-status '${explicitEvidenceStatus}'`);
    }
    executedModel = explicitExecuted ?? null;
    const evidenceStatus = explicitEvidenceStatus
      ?? (executedModel ? 'direct' : 'missing');
    const evidenceSource = input.flags['execution-evidence-source']
      ?? (executedModel ? 'stage-result-cli' : 'unknown');
    executionEvidence = {
      status: evidenceStatus,
      source: evidenceSource,
      ...(input.flags['execution-evidence-detail'] !== undefined
        ? { detail: input.flags['execution-evidence-detail'] }
        : {}),
      recordedAt: input.now,
    };
  }

  let modelAttributionEligible = boolFlag(input.flags['model-attribution-eligible']);
  let modelAttributionIneligibleReason: ModelAttributionIneligibleReason | undefined;
  if (modelAttributionEligible === undefined) {
    if (input.status !== 'completed') {
      modelAttributionEligible = false;
      modelAttributionIneligibleReason = 'stage_not_completed';
    } else if (!executedModel) {
      modelAttributionEligible = false;
      modelAttributionIneligibleReason = 'missing_execution_evidence';
    } else if (executionEvidence.status === 'contradicted') {
      modelAttributionEligible = false;
      modelAttributionIneligibleReason = 'execution_contradicted';
    } else if (
      intendedModel
      && !challengeModelIdsEquivalent(intendedModel, executedModel, input.repoDir)
    ) {
      // HOK-3321 / HOK-3369: two spellings of the same registry entry
      // are not a runtime fallback.
      modelAttributionEligible = false;
      modelAttributionIneligibleReason = 'runtime_fallback';
    } else {
      modelAttributionEligible = true;
      modelAttributionIneligibleReason = undefined;
    }
  } else if (modelAttributionEligible) {
    // HOK-3369: an explicit true always clears the reason (JSON drops it).
    modelAttributionIneligibleReason = undefined;
  } else {
    modelAttributionIneligibleReason = input.existing?.modelAttributionIneligibleReason
      ?? (!executedModel ? 'missing_execution_evidence' : 'execution_contradicted');
  }

  // HOK-3369 D4: always return the reason key. When eligible it is
  // `undefined`, which `updateStageResult`'s spread uses to clear a stale
  // reason, and JSON.stringify drops it from the written file.
  return {
    intendedModel,
    executedModel,
    executionEvidence,
    modelAttributionEligible,
    modelAttributionIneligibleReason,
  };
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

/** Options for {@link readStageResult}. */
export interface ReadStageResultOptions {
  /** Absolute path to the feature directory holding `.{stage}-result.json`. */
  featureDir: string;
  /** Which stage's result to read. */
  stage: StageName;
}

/**
 * Options for the task-identity form of {@link readStageResult} / {@link readAllStageResults}.
 *
 * Lets the invariant resolver `task-artifact-lookup.ts` decide live-vs-archive
 * (HOK-2891). Callers that already have a resolved `featureDir` keep using the
 * {@link ReadStageResultOptions} shape.
 */
export interface ReadStageResultByTaskOptions {
  /** Linear issue id (`HOK-2891`, `HOK-2891_c`); required for the archive branch. */
  issueId: string;
  /** Feature slug; required for the live branch. */
  slug?: string;
  /** Which stage's result to read. */
  stage: StageName;
  /** The active worktree directory, when the caller already has it. */
  worktreeDir?: string;
  /** Main-repo root; defaults to `resolveFromMainRepo` from CWD. */
  repoDir?: string;
}

function isTaskIdentityOptions(
  value: ReadStageResultOptions | ReadStageResultByTaskOptions | string,
): value is ReadStageResultByTaskOptions {
  return typeof value === 'object' && value !== null && 'issueId' in value;
}

/**
 * Read a single stage result file.
 *
 * Returns `null` when the file is missing, empty, or contains invalid JSON.
 * Validates that the `stage` field in the file matches the requested stage.
 * Never throws.
 *
 * HOK-3242: takes an options object so a swapped-argument call
 * (`readStageResult({ featureDir: 'ready', stage: '/some/path' })`) is a
 * type error. Positional callers (`readStageResult(featureDir, 'ready')`)
 * are still accepted for backward compatibility — the overload maps them
 * to the object form.
 *
 * @param options - { featureDir, stage }
 * @returns Parsed StageResult or null
 */
export function readStageResult(options: ReadStageResultOptions): Promise<StageResult | null>;
export function readStageResult(options: ReadStageResultByTaskOptions): Promise<StageResult | null>;
export function readStageResult(featureDir: string, stage: StageName): Promise<StageResult | null>;
export async function readStageResult(
  optionsOrFeatureDir: ReadStageResultOptions | ReadStageResultByTaskOptions | string,
  maybeStage?: StageName,
): Promise<StageResult | null> {
  let resultPath: string;
  let stage: StageName;
  if (typeof optionsOrFeatureDir === 'string') {
    stage = maybeStage as StageName;
    resultPath = getResultFilePath(optionsOrFeatureDir, stage);
  } else if (isTaskIdentityOptions(optionsOrFeatureDir)) {
    stage = optionsOrFeatureDir.stage;
    const resolved = resolveTaskArtifact({
      issueId: optionsOrFeatureDir.issueId,
      slug: optionsOrFeatureDir.slug,
      artifactName: `.${stage}-result.json`,
      worktreeDir: optionsOrFeatureDir.worktreeDir,
      repoDir: optionsOrFeatureDir.repoDir,
    });
    if (!resolved) return null;
    resultPath = resolved.path;
  } else {
    stage = optionsOrFeatureDir.stage;
    resultPath = getResultFilePath(optionsOrFeatureDir.featureDir, stage);
  }
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
export async function readAllStageResults(featureDir: string): Promise<StageResultMap>;
export async function readAllStageResults(
  options: Omit<ReadStageResultByTaskOptions, 'stage'>,
): Promise<StageResultMap>;
export async function readAllStageResults(
  featureDirOrOptions: string | Omit<ReadStageResultByTaskOptions, 'stage'>,
): Promise<StageResultMap> {
  const results: StageResultMap = {};
  const isByTask = typeof featureDirOrOptions !== 'string';

  for (const stage of VALID_STAGES) {
    const result = isByTask
      ? await readStageResult({ ...(featureDirOrOptions as Omit<ReadStageResultByTaskOptions, 'stage'>), stage })
      : await readStageResult({ featureDir: featureDirOrOptions as string, stage });
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
  // A challenge-pinned unlaunchable reviewer is recorded as not_ready (harness
  // fault, never retried); every other shape of this category is retryable
  // infrastructure (HOK-3247).
  if (failureCategory === REVIEW_MODEL_UNLAUNCHABLE_FAILURE_CATEGORY && outcome.verdict !== 'not_ready') {
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
// Review Evidence Helpers (HOK-2969)
// ────────────────────────────────────────────────────────────────

/**
 * Read the review iteration array off an existing artifacts value, tolerating
 * legacy/malformed shapes by treating anything that is not an array as "no
 * prior iterations" rather than throwing.
 */
export function existingReviewIterations(
  artifacts: ReviewArtifacts | StageArtifacts | null | undefined,
): ReviewIterationRecord[] {
  const candidate = (artifacts as ReviewArtifacts | undefined)?.reviewIterations;
  return Array.isArray(candidate) ? candidate : [];
}

/**
 * Compute the next 1-based iteration number for a review artifact.
 */
export function nextReviewIterationNumber(
  artifacts: ReviewArtifacts | StageArtifacts | null | undefined,
): number {
  const prior = existingReviewIterations(artifacts);
  return prior.reduce((max, entry) => Math.max(max, entry.iteration), 0) + 1;
}

/**
 * Append (or idempotently replace) one iteration's evidence onto the prior
 * iteration list. Reruns of the same iteration number replace that entry in
 * place; every other prior iteration is preserved — a rerun must never
 * silently drop earlier direct evidence (HOK-2969).
 */
export function appendReviewIteration(
  existing: ReviewArtifacts | StageArtifacts | null | undefined,
  iteration: ReviewIterationRecord,
): ReviewIterationRecord[] {
  const prior = existingReviewIterations(existing).filter((entry) => entry.iteration !== iteration.iteration);
  return [...prior, iteration].sort((a, b) => a.iteration - b.iteration);
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
  const existing = await readStageResult({ featureDir, stage });

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
  const existing = await readStageResult({ featureDir, stage });
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
      intendedModel: existing.intendedModel,
      executedModel: existing.executedModel,
      modelAttributionEligible: existing.modelAttributionEligible,
      modelAttributionIneligibleReason: existing.modelAttributionIneligibleReason,
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
