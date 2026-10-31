/**
 * Feature State — per-feature outcome materialization (HOK-2258)
 *
 * Derives a compact, machine-readable outcome view from existing workflow
 * artifacts: stage result files, route lifecycle artifacts, blocked-completion
 * records, workflow-state.json, and eval records.
 *
 * Design rules:
 * - Read model only: does not replace workflow-state.json or stage result files.
 * - Worktree artifacts take precedence over archived copies for active tasks.
 * - Missing or malformed artifacts degrade gracefully with null/unknown fields.
 * - No phase transitions or controller/monitor behavior depends on this artifact.
 *
 * @module feature-state
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  extractReviewOutcome,
  readAllStageResults,
  reviewEffectiveBlockerCount,
  reviewResultPassed,
  type StageName,
  type StageResult,
  type StageResultMap,
} from './stage-result.ts';
import {
  buildRouteLifecycleProvenance,
  readRouteLifecycleArtifacts,
  type RouteLifecycleProvenance,
} from './route-artifact.ts';
import {
  getBlockedCompletionPath,
  readBlockedCompletion,
  type BlockedCompletion,
  type BlockedCompletionBlockingReason,
} from './blocked-completion.ts';
import { resolveRouteArtifactArchiveDir } from './evals-paths.ts';

// ────────────────────────────────────────────────────────────────
// Schema version
// ────────────────────────────────────────────────────────────────

export const FEATURE_STATE_SCHEMA_VERSION = '1.0';
export const FEATURE_STATE_FILENAME = 'feature-state.json';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/** Normalized lifecycle phase for the current task. */
export type CurrentPhase =
  | 'planning'
  | 'coding'
  | 'review'
  | 'ready'
  | 'done'
  | 'aborted'
  | 'unknown';

/** Normalized workflow state within a phase. */
export type NormalizedState =
  | 'running'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'awaiting_user'
  | 'approval_needed'
  | 'unknown';

/** Stable machine-readable blocker codes. */
export type BlockerCode =
  | 'ci_failed'
  | 'merge_conflict'
  | 'review_blocking_issue'
  | 'ready_failed'
  | 'coding_blocked'
  | 'baseline_tests_failing'
  | 'repo_verification_blocked'
  | 'environment_blocked'
  | 'stage_failed'
  | 'workflow_aborted'
  | 'unknown_blocker';

/** Stable machine-readable failure reason codes. */
export type FailureReasonCode =
  | 'stage_failed'
  | 'ready_failed'
  | 'ci_failed'
  | 'workflow_aborted'
  | 'coding_blocked'
  | 'review_rejected'
  | 'unknown_failure';

/** A blocker with a stable code and optional details. */
export interface BlockerRecord {
  code: BlockerCode;
  detail?: string;
  stage?: StageName;
}

/** Evidence record for a specific check/signal. */
export interface EvidenceRecord {
  kind:
    | 'ci_check'
    | 'ready_check'
    | 'review_verdict'
    | 'stage_completion'
    | 'legacy_marker'
    | 'blocked_completion'
    | 'eval_outcome';
  label: string;
  status: 'pass' | 'fail' | 'unknown';
  detail?: string;
  timestamp?: string;
}

/** Summary of a single workflow stage. */
export interface StageSummary {
  status: string;
  agent?: string;
  model?: string;
  startedAt?: string;
  finishedAt?: string | null;
  durationSeconds?: number;
  notes?: string;
  failureReason?: string | null;
  artifactSummary?: Record<string, unknown>;
}

/** Contract (task packet/plan) provenance metadata. */
export interface ContractProvenance {
  planFile?: string;
  planHash?: string;
  taskPacketFile?: string;
  taskPacketHash?: string;
}

/** Summary of where each artifact was sourced from. */
export interface ArtifactSources {
  stagesFromWorktree: boolean;
  stagesFromArchive: boolean;
  routeFromWorktree: boolean;
  routeFromArchive: boolean;
  evalRecordUsed: boolean;
}

/** Final outcome summary. */
export interface FeatureOutcome {
  /** True if the task reached a terminal state (done or aborted). */
  completed: boolean;
  /** True if the PR was merged. */
  merged: boolean | null;
  /** True if CI passed. */
  ciPassed: boolean | null;
  /** True if review stage completed without blocking issues. */
  reviewPassed: boolean | null;
  /** True if the ready check verdict was 'pass'. */
  readyPassed: boolean | null;
  /** True if any human intervention was detected. */
  manualIntervention: boolean | null;
  /** Number of distinct human interventions. */
  interventionCount: number | null;
  /** True if the PR was reverted post-merge. */
  reverted: boolean | null;
  /** Eval judge score (0–1), from the latest matching eval record. */
  evalScore: number | null;
  /** Total workflow cost in USD, from eval record when available. */
  costUsd: number | null;
  /** Total wall-clock duration in seconds across all stages. */
  durationSeconds: number | null;
}

/** Complete per-feature outcome view. */
export interface FeatureState {
  /** Schema version for forward compatibility. */
  schemaVersion: string;
  /** ISO 8601 timestamp when this artifact was derived. */
  derivedAt: string;
  // ── Identity ──
  issueId: string | null;
  slug: string | null;
  branch: string | null;
  prNumber: number | null;
  prUrl: string | null;
  // ── Phase tracking ──
  currentPhase: CurrentPhase;
  normalizedState: NormalizedState;
  // ── Provenance ──
  contract: ContractProvenance | null;
  route: RouteLifecycleProvenance | null;
  // ── Stage summaries ──
  stages: {
    planning: StageSummary | null;
    coding: StageSummary | null;
    review: StageSummary | null;
    ready: StageSummary | null;
  };
  // ── Evidence array ──
  evidence: EvidenceRecord[];
  // ── Failure signals ──
  blockers: BlockerRecord[];
  failureReason: FailureReasonCode | null;
  // ── Final outcome ──
  outcome: FeatureOutcome;
  // ── Metadata ──
  artifactSources: ArtifactSources;
}

// ────────────────────────────────────────────────────────────────
// Options
// ────────────────────────────────────────────────────────────────

/** Options for deriving a feature state. */
export interface DeriveFeatureStateOptions {
  /**
   * Absolute path to the feature directory (e.g. `<repo>/features/<slug>`).
   * Required if the worktree is still present.
   */
  featureDir?: string;

  /**
   * Absolute path to the eval archive directory for this issue.
   * Typically `.wavemill/evals/artifacts/<issueId>/`.
   * Used as fallback when featureDir is absent or missing files.
   */
  archiveDir?: string;

  /**
   * Issue identifier (e.g. 'HOK-2258'). Used to look up eval records
   * and derive archive paths when archiveDir is not explicit.
   */
  issueId?: string;

  /**
   * Slug for this feature (e.g. 'my-feature-slug').
   * Populated in the output; not required for artifact resolution.
   */
  slug?: string;

  /**
   * Branch name for this feature.
   */
  branch?: string;

  /**
   * PR number if known.
   */
  prNumber?: number;

  /**
   * PR URL if known.
   */
  prUrl?: string;

  /**
   * Optional eval record override. When provided, skips reading from the
   * eval JSONL file and uses the supplied record directly for outcome fields.
   */
  evalRecord?: {
    score?: number;
    interventionRequired?: boolean;
    interventionCount?: number;
    workflowCost?: number;
    timeSeconds?: number | null;
    outcomes?: {
      delivery?: { merged?: boolean };
    };
    prUrl?: string;
  };

  /**
   * Repository root directory. Used to resolve archive dirs from config
   * when archiveDir is not provided.
   */
  repoDir?: string;
}

// ────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────

function safeReadJsonSync(filePath: string): Record<string, unknown> | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    if (!content.trim()) return null;
    const parsed = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function fileHash(filePath: string): string | undefined {
  try {
    const content = readFileSync(filePath);
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return undefined;
  }
}

function resolveIsoToSeconds(start: unknown, end: unknown): number | undefined {
  if (typeof start !== 'string' || typeof end !== 'string') return undefined;
  const s = Date.parse(start);
  const e = Date.parse(end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return undefined;
  return Math.max(0, (e - s) / 1000);
}

function toStageSummary(result: StageResult): StageSummary {
  const summary: StageSummary = {
    status: result.status,
    ...(result.agent ? { agent: result.agent } : {}),
    ...(result.model ? { model: result.model } : {}),
    ...(result.startedAt ? { startedAt: result.startedAt } : {}),
    ...(typeof result.finishedAt !== 'undefined' ? { finishedAt: result.finishedAt } : {}),
    ...(result.notes ? { notes: result.notes } : {}),
    ...(typeof result.failureReason !== 'undefined' ? { failureReason: result.failureReason } : {}),
  };

  const duration = resolveIsoToSeconds(result.startedAt, result.finishedAt);
  if (typeof duration === 'number') {
    summary.durationSeconds = duration;
  }

  if (result.artifacts) {
    const { type: _type, ...rest } = result.artifacts as Record<string, unknown>;
    if (Object.keys(rest).length > 0) {
      summary.artifactSummary = rest;
    }
  }

  return summary;
}

/**
 * Return true when a stage result's artifacts carry pending approval metadata
 * (HOK-2364). The approvalRequest field is set by the native agent when it
 * writes a stage result in the approval_needed state.
 */
function hasApprovalNeededArtifact(result: StageResult): boolean {
  if (!result.artifacts) return false;
  const req = result.artifacts.approvalRequest;
  return typeof req?.requestId === 'string' && typeof req.riskReason === 'string';
}

function readLegacyMarkers(featureDir: string): { codingComplete: boolean; planApproved: boolean; aborted: boolean } {
  const check = (f: string): boolean => existsSync(path.join(featureDir, f));
  return {
    codingComplete: check('.coding-complete'),
    planApproved: check('.plan-approved'),
    aborted: check('.workflow-aborted'),
  };
}

function deriveLegacyStageSummary(
  markers: ReturnType<typeof readLegacyMarkers>,
  stage: StageName,
): StageSummary | null {
  if (stage === 'planning' && markers.planApproved) {
    return { status: 'completed', notes: 'derived from .plan-approved marker' };
  }
  if (stage === 'coding' && markers.codingComplete) {
    return { status: 'completed', notes: 'derived from .coding-complete marker' };
  }
  return null;
}

/**
 * Determine current phase and normalized state from stage results and legacy markers.
 */
function derivePhaseAndState(
  stages: StageResultMap,
  markers: ReturnType<typeof readLegacyMarkers>,
  blockedCompletion: BlockedCompletion | null,
): { currentPhase: CurrentPhase; normalizedState: NormalizedState } {
  if (markers.aborted) {
    return { currentPhase: 'aborted', normalizedState: 'aborted' };
  }

  // Walk from latest to earliest to find current phase
  const phaseOrder: StageName[] = ['ready', 'review', 'coding', 'planning'];

  for (const phase of phaseOrder) {
    const result = stages[phase];
    if (!result) continue;

    let normalized: NormalizedState;
    switch (result.status) {
      case 'completed': normalized = 'completed'; break;
      case 'failed': normalized = 'failed'; break;
      case 'aborted': normalized = 'aborted'; break;
      case 'awaiting_user':
        // Distinguish human-approval pause from generic awaiting_user (HOK-2364).
        normalized = hasApprovalNeededArtifact(result) ? 'approval_needed' : 'awaiting_user';
        break;
      case 'running': normalized = 'running'; break;
      default: normalized = 'unknown';
    }

    let currentPhase: CurrentPhase = phase;
    // If ready completed, the task is done
    if (phase === 'ready' && result.status === 'completed') {
      currentPhase = 'done';
      normalized = 'completed';
    }

    return { currentPhase, normalizedState: normalized };
  }

  // No stage results — try legacy markers
  if (markers.codingComplete) {
    return { currentPhase: 'coding', normalizedState: 'completed' };
  }
  if (markers.planApproved) {
    return { currentPhase: 'planning', normalizedState: 'completed' };
  }
  if (blockedCompletion?.implementationComplete) {
    return { currentPhase: 'coding', normalizedState: 'completed' };
  }

  return { currentPhase: 'unknown', normalizedState: 'unknown' };
}

function deriveBlockers(
  stages: StageResultMap,
  blockedCompletion: BlockedCompletion | null,
  markers: ReturnType<typeof readLegacyMarkers>,
): BlockerRecord[] {
  const blockers: BlockerRecord[] = [];

  if (markers.aborted) {
    blockers.push({ code: 'workflow_aborted' });
  }

  for (const stage of ['planning', 'coding', 'review', 'ready'] as StageName[]) {
    const result = stages[stage];
    if (!result) continue;
    if (result.status === 'failed' || result.status === 'aborted') {
      if (stage === 'ready') {
        blockers.push({ code: 'ready_failed', stage, detail: result.failureReason ?? undefined });
      } else if (stage === 'coding') {
        blockers.push({ code: 'coding_blocked', stage, detail: result.failureReason ?? undefined });
      } else {
        blockers.push({ code: 'stage_failed', stage, detail: result.failureReason ?? undefined });
      }
    }

    // Detect CI/merge conflict from ready artifacts
    if (stage === 'ready' && result.artifacts?.type === 'ready') {
      const artifacts = result.artifacts as { type: 'ready'; mergeConflict?: string; verdict?: string };
      if (artifacts.mergeConflict) {
        blockers.push({ code: 'merge_conflict', stage: 'ready', detail: artifacts.mergeConflict });
      }
      if (artifacts.verdict === 'fail') {
        const alreadyHasReady = blockers.some((b) => b.code === 'ready_failed');
        if (!alreadyHasReady) {
          blockers.push({ code: 'ready_failed', stage: 'ready' });
        }
      }
    }
  }

  if (blockedCompletion) {
    const reasonMap: Record<BlockedCompletionBlockingReason, BlockerCode> = {
      repo_verification_blocked: 'repo_verification_blocked',
      environment_blocked: 'environment_blocked',
      baseline_tests_failing: 'baseline_tests_failing',
    };
    const code = reasonMap[blockedCompletion.blockingReason] ?? 'coding_blocked';
    const alreadyHas = blockers.some((b) => b.code === code);
    if (!alreadyHas) {
      blockers.push({ code, stage: 'coding', detail: blockedCompletion.evidence });
    }
  }

  return blockers;
}

function deriveFailureReason(
  stages: StageResultMap,
  blockers: BlockerRecord[],
  markers: ReturnType<typeof readLegacyMarkers>,
): FailureReasonCode | null {
  if (markers.aborted) return 'workflow_aborted';

  // Check stages in phase order for the first failure
  for (const stage of ['planning', 'coding', 'review', 'ready'] as StageName[]) {
    const result = stages[stage];
    if (!result) continue;
    if (result.status === 'failed') {
      if (stage === 'ready') return 'ready_failed';
      if (stage === 'coding') return 'coding_blocked';
      if (stage === 'review') return 'review_rejected';
      return 'stage_failed';
    }
    if (result.status === 'aborted') return 'workflow_aborted';
  }

  // Infer from blocker codes
  if (blockers.some((b) => b.code === 'ci_failed')) return 'ci_failed';
  if (blockers.some((b) => b.code === 'ready_failed')) return 'ready_failed';
  if (blockers.some((b) => b.code === 'workflow_aborted')) return 'workflow_aborted';
  if (blockers.some((b) => b.code === 'coding_blocked')) return 'coding_blocked';

  return null;
}

function deriveEvidence(
  stages: StageResultMap,
  blockedCompletion: BlockedCompletion | null,
  markers: ReturnType<typeof readLegacyMarkers>,
  evalRecord: DeriveFeatureStateOptions['evalRecord'],
): EvidenceRecord[] {
  const evidence: EvidenceRecord[] = [];

  // Stage completion evidence
  for (const stage of ['planning', 'coding', 'review', 'ready'] as StageName[]) {
    const result = stages[stage];
    if (!result) continue;

    let status: EvidenceRecord['status'];
    if (result.status === 'completed') status = 'pass';
    else if (result.status === 'failed' || result.status === 'aborted') status = 'fail';
    else status = 'unknown';

    evidence.push({
      kind: 'stage_completion',
      label: `${stage}_stage`,
      status,
      timestamp: result.finishedAt ?? result.startedAt,
      ...(result.failureReason ? { detail: result.failureReason } : {}),
    });

    // Ready check sub-evidence
    if (stage === 'ready' && result.artifacts?.type === 'ready') {
      const artifacts = result.artifacts as { type: 'ready'; verdict?: string; checksRun?: number; checksPassed?: number; mergeConflict?: string };
      if (typeof artifacts.verdict === 'string') {
        evidence.push({
          kind: 'ready_check',
          label: 'ready_verdict',
          status: artifacts.verdict === 'pass' ? 'pass' : artifacts.verdict === 'fail' ? 'fail' : 'unknown',
          detail: artifacts.verdict,
          timestamp: result.finishedAt ?? undefined,
        });
      }
      if (artifacts.mergeConflict) {
        evidence.push({
          kind: 'ready_check',
          label: 'merge_conflict',
          status: 'fail',
          detail: artifacts.mergeConflict,
        });
      }
    }

    // Review verdict evidence
    if (stage === 'review') {
      const outcome = extractReviewOutcome(result);
      const passed = reviewResultPassed(result);
      const failed = result.status === 'completed' && !passed;
      const dismissedCount = outcome?.dismissedBlockers?.length ?? 0;
      const effectiveCount = reviewEffectiveBlockerCount(outcome);
      const detail = outcome
        ? [
            `exitCode=${typeof outcome.exitCode === 'number' ? outcome.exitCode : 'missing'}`,
            `verdict=${outcome.verdict ?? 'missing'}`,
            `iterations=${typeof outcome.iterations === 'number' ? outcome.iterations : 'missing'}`,
            typeof outcome.blockerCount === 'number' ? `blockers=${outcome.blockerCount}` : '',
            dismissedCount > 0 ? `dismissedBlockers=${dismissedCount}` : '',
            dismissedCount > 0 && typeof effectiveCount === 'number' ? `effectiveBlockers=${effectiveCount}` : '',
            typeof outcome.warningCount === 'number' ? `warnings=${outcome.warningCount}` : '',
            outcome.reviewToolError ? `error=${outcome.reviewToolError}` : '',
          ].filter(Boolean).join(', ')
        : 'review outcome missing';
      evidence.push({
        kind: 'review_verdict',
        label: 'review_verdict',
        status: passed ? 'pass' : failed || result.status === 'failed' ? 'fail' : 'unknown',
        detail,
        timestamp: result.finishedAt ?? undefined,
      });
    }
  }

  // Legacy marker evidence
  if (markers.codingComplete && !stages.coding) {
    evidence.push({
      kind: 'legacy_marker',
      label: '.coding-complete',
      status: 'pass',
    });
  }
  if (markers.planApproved && !stages.planning) {
    evidence.push({
      kind: 'legacy_marker',
      label: '.plan-approved',
      status: 'pass',
    });
  }
  if (markers.aborted) {
    evidence.push({
      kind: 'legacy_marker',
      label: '.workflow-aborted',
      status: 'fail',
    });
  }

  // Blocked completion evidence
  if (blockedCompletion) {
    evidence.push({
      kind: 'blocked_completion',
      label: 'blocked_completion',
      status: blockedCompletion.implementationComplete ? 'pass' : 'fail',
      detail: `${blockedCompletion.blockingReason}: ${blockedCompletion.evidence}`,
    });
  }

  // Eval outcome evidence
  if (evalRecord?.score !== undefined) {
    evidence.push({
      kind: 'eval_outcome',
      label: 'eval_score',
      status: evalRecord.score >= 0.5 ? 'pass' : 'fail',
      detail: `score=${evalRecord.score}`,
    });
  }
  if (evalRecord?.outcomes?.delivery?.merged === true) {
    evidence.push({
      kind: 'eval_outcome',
      label: 'merged',
      status: 'pass',
    });
  }

  return evidence;
}

function deriveOutcome(
  stages: StageResultMap,
  blockers: BlockerRecord[],
  markers: ReturnType<typeof readLegacyMarkers>,
  evalRecord: DeriveFeatureStateOptions['evalRecord'],
  currentPhase: CurrentPhase,
): FeatureOutcome {
  const completed = currentPhase === 'done' || currentPhase === 'aborted' || !!evalRecord;

  // Merged: eval record is authoritative; otherwise infer from delivery stage
  let merged: boolean | null = null;
  if (evalRecord?.outcomes?.delivery?.merged !== undefined) {
    merged = evalRecord.outcomes.delivery.merged ?? null;
  }

  // ciPassed: from ready artifacts or eval
  let ciPassed: boolean | null = null;
  const readyResult = stages.ready;
  if (readyResult?.artifacts?.type === 'ready') {
    const artifacts = readyResult.artifacts as { type: 'ready'; verdict?: string };
    if (typeof artifacts.verdict === 'string') {
      ciPassed = artifacts.verdict === 'pass' || artifacts.verdict === 'warn';
    }
  }

  // reviewPassed: explicit final review outcome passed the strict readiness gate
  let reviewPassed: boolean | null = null;
  const reviewResult = stages.review;
  if (reviewResult) {
    if (reviewResult.status === 'completed') {
      reviewPassed = reviewResultPassed(reviewResult);
    } else if (reviewResult.status === 'failed') {
      reviewPassed = false;
    }
  }

  // readyPassed: ready verdict pass
  let readyPassed: boolean | null = null;
  if (readyResult?.artifacts?.type === 'ready') {
    const artifacts = readyResult.artifacts as { type: 'ready'; verdict?: string };
    if (typeof artifacts.verdict === 'string') {
      readyPassed = artifacts.verdict === 'pass';
    }
  }

  // manualIntervention / interventionCount from eval record
  let manualIntervention: boolean | null = null;
  let interventionCount: number | null = null;
  if (evalRecord) {
    if (typeof evalRecord.interventionRequired === 'boolean') {
      manualIntervention = evalRecord.interventionRequired;
    }
    if (typeof evalRecord.interventionCount === 'number') {
      interventionCount = evalRecord.interventionCount;
    }
  }

  const evalScore = typeof evalRecord?.score === 'number' ? evalRecord.score : null;
  const costUsd = typeof evalRecord?.workflowCost === 'number' ? evalRecord.workflowCost : null;

  // durationSeconds: sum of stage durations, or eval timeSeconds
  let durationSeconds: number | null = null;
  if (typeof evalRecord?.timeSeconds === 'number') {
    durationSeconds = evalRecord.timeSeconds;
  } else {
    let total = 0;
    let hasAny = false;
    for (const stage of ['planning', 'coding', 'review'] as StageName[]) {
      const result = stages[stage];
      if (!result) continue;
      const dur = resolveIsoToSeconds(result.startedAt, result.finishedAt);
      if (typeof dur === 'number') {
        total += dur;
        hasAny = true;
      }
    }
    if (hasAny) durationSeconds = total;
  }

  return {
    completed,
    merged,
    ciPassed,
    reviewPassed,
    readyPassed,
    manualIntervention,
    interventionCount,
    reverted: null,
    evalScore,
    costUsd,
    durationSeconds,
  };
}

function readContractProvenance(featureDir: string | undefined, archiveDir: string | undefined): ContractProvenance | null {
  const planCandidates: string[] = [];
  const packetCandidates: string[] = [];

  if (featureDir) {
    planCandidates.push(path.join(featureDir, 'plan.md'));
    packetCandidates.push(
      path.join(featureDir, 'task-packet.md'),
      path.join(featureDir, 'task-packet-header.md'),
    );
  }
  if (archiveDir) {
    planCandidates.push(path.join(archiveDir, 'plan.md'));
    packetCandidates.push(path.join(archiveDir, 'task-packet.md'));
  }

  const provenance: ContractProvenance = {};

  for (const candidate of planCandidates) {
    if (existsSync(candidate)) {
      provenance.planFile = candidate;
      provenance.planHash = fileHash(candidate);
      break;
    }
  }

  for (const candidate of packetCandidates) {
    if (existsSync(candidate)) {
      provenance.taskPacketFile = candidate;
      provenance.taskPacketHash = fileHash(candidate);
      break;
    }
  }

  return Object.keys(provenance).length > 0 ? provenance : null;
}

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/**
 * Derive a FeatureState from existing workflow artifacts.
 *
 * Resolution order for each artifact class:
 * 1. featureDir (active worktree)
 * 2. archiveDir (`.wavemill/evals/artifacts/<issueId>/`)
 * 3. evalRecord override (final outcome fields only)
 *
 * Never throws. Returns a fully-typed object with null/unknown for any
 * artifact that is missing or malformed.
 */
export async function deriveFeatureState(opts: DeriveFeatureStateOptions): Promise<FeatureState> {
  const { featureDir, issueId, slug, branch, evalRecord } = opts;

  // Resolve archive dir
  const archiveDir = opts.archiveDir
    ?? (issueId ? resolveRouteArtifactArchiveDir(issueId, opts.repoDir) : undefined);

  // Track artifact sources
  const sources: ArtifactSources = {
    stagesFromWorktree: false,
    stagesFromArchive: false,
    routeFromWorktree: false,
    routeFromArchive: false,
    evalRecordUsed: !!evalRecord,
  };

  // ── Stage results ──
  // HOK-2891: live featureDir wins when it carries stage files; otherwise fall
  // through to the one resolver, which probes feature/bug roots under the
  // caller's worktreeDir (and repoDir), then the per-issue archive.
  let stages: StageResultMap = {};
  let legacyMarkers = { codingComplete: false, planApproved: false, aborted: false };

  const liveFeatureDirExists = Boolean(featureDir && existsSync(featureDir));
  if (liveFeatureDirExists) {
    legacyMarkers = readLegacyMarkers(featureDir!);
    stages = await readAllStageResults(featureDir!);
    if (Object.keys(stages).length > 0) {
      sources.stagesFromWorktree = true;
    }
  }

  if (Object.keys(stages).length === 0 && issueId) {
    // featureDir layout is `.../<worktreeDir>/features/<slug>` or `.../<worktreeDir>/bugs/<slug>`.
    const worktreeDir = featureDir ? path.dirname(path.dirname(featureDir)) : undefined;
    stages = await readAllStageResults({
      issueId,
      slug,
      worktreeDir,
      repoDir: opts.repoDir,
    });
    if (Object.keys(stages).length > 0) {
      if (archiveDir && existsSync(archiveDir)) {
        sources.stagesFromArchive = true;
      } else {
        sources.stagesFromWorktree = true;
      }
    }
  }

  // Caller-supplied archiveDir that lies outside the resolver's probe (e.g.
  // tests pointing at a tmp dir): read it directly.
  if (Object.keys(stages).length === 0 && archiveDir && existsSync(archiveDir)) {
    stages = await readAllStageResults(archiveDir);
    if (Object.keys(stages).length > 0) {
      sources.stagesFromArchive = true;
    }
  }

  // ── Route lifecycle ──
  const routeArtifacts = readRouteLifecycleArtifacts(
    featureDir && existsSync(featureDir) ? featureDir : undefined,
    archiveDir && existsSync(archiveDir) ? archiveDir : undefined,
  );
  const routeProvenance = buildRouteLifecycleProvenance(routeArtifacts);

  if (routeArtifacts.active || routeArtifacts.expanded || routeArtifacts.bootstrap) {
    if (featureDir && existsSync(featureDir)) {
      sources.routeFromWorktree = true;
    } else if (archiveDir) {
      sources.routeFromArchive = true;
    }
  }

  // ── Blocked completion ──
  let blockedCompletion: BlockedCompletion | null = null;
  if (featureDir && existsSync(featureDir)) {
    const blockedPath = getBlockedCompletionPath(featureDir);
    if (existsSync(blockedPath)) {
      const result = await readBlockedCompletion(blockedPath);
      if (result.ok) {
        blockedCompletion = result.value;
      }
    }
  }

  // ── Stage summaries ──
  const stageSummaries: FeatureState['stages'] = {
    planning: stages.planning
      ? toStageSummary(stages.planning)
      : deriveLegacyStageSummary(legacyMarkers, 'planning'),
    coding: stages.coding
      ? toStageSummary(stages.coding)
      : deriveLegacyStageSummary(legacyMarkers, 'coding'),
    review: stages.review ? toStageSummary(stages.review) : null,
    ready: stages.ready ? toStageSummary(stages.ready) : null,
  };

  // ── Phase / state ──
  const { currentPhase, normalizedState } = derivePhaseAndState(stages, legacyMarkers, blockedCompletion);

  // ── Blockers ──
  const blockers = deriveBlockers(stages, blockedCompletion, legacyMarkers);

  // ── Failure reason ──
  const failureReason = deriveFailureReason(stages, blockers, legacyMarkers);

  // ── Evidence ──
  const evidence = deriveEvidence(stages, blockedCompletion, legacyMarkers, evalRecord);

  // ── Contract provenance ──
  const contract = readContractProvenance(featureDir, archiveDir);

  // ── Identity ──
  // Prefer explicit opts; fall back to PR URL from eval record
  const resolvedPrUrl = opts.prUrl ?? evalRecord?.prUrl ?? null;
  const resolvedPrNumber = opts.prNumber ?? null;

  // ── Outcome ──
  const outcome = deriveOutcome(stages, blockers, legacyMarkers, evalRecord, currentPhase);

  return {
    schemaVersion: FEATURE_STATE_SCHEMA_VERSION,
    derivedAt: new Date().toISOString(),
    issueId: issueId ?? null,
    slug: slug ?? null,
    branch: branch ?? null,
    prNumber: resolvedPrNumber,
    prUrl: resolvedPrUrl,
    currentPhase,
    normalizedState,
    contract,
    route: routeProvenance,
    stages: stageSummaries,
    evidence,
    blockers,
    failureReason,
    outcome,
    artifactSources: sources,
  };
}

/**
 * Write a feature state artifact to `features/<slug>/feature-state.json`.
 *
 * Writes atomically via a temp file rename. Creates the directory if needed.
 * @returns The path where the artifact was written.
 */
export async function materializeFeatureState(
  featureState: FeatureState,
  targetPath: string,
): Promise<string> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  const tmpPath = path.join(
    tmpdir(),
    `.tmp-feature-state-${process.pid}-${Date.now()}.json`,
  );
  const json = JSON.stringify(featureState, null, 2) + '\n';

  await fs.writeFile(tmpPath, json, 'utf-8');
  await fs.rename(tmpPath, targetPath);

  return targetPath;
}

/**
 * Derive and write `feature-state.json` to a given feature directory.
 *
 * Convenience wrapper around `deriveFeatureState` + `materializeFeatureState`.
 * @returns The written FeatureState and the path it was written to.
 */
export async function deriveAndMaterialize(
  opts: DeriveFeatureStateOptions,
  outputDir: string,
): Promise<{ state: FeatureState; path: string }> {
  const state = await deriveFeatureState(opts);
  const targetPath = path.join(outputDir, FEATURE_STATE_FILENAME);
  await materializeFeatureState(state, targetPath);
  return { state, path: targetPath };
}
