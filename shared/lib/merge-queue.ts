import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mutateJsonState } from './state-mutex.ts';
import { readValidTendAttemptFact } from './tend-attempt-fact.ts';

/**
 * The only declared list of Ready `queueState` values (HOK-3453). The monitor
 * (`shared/lib/wavemill-monitor.sh`) is the sole writer; every value it writes
 * must appear here — `tools/check-queue-state.ts` fails preflight otherwise —
 * and `shared/schemas/stage-result.schema.json` declares the same enum.
 *
 * - `ready`           — Ready passed against the current base; tend may select it.
 * - `ready-stale`     — Ready passed, then main (or the PR head) moved before selection.
 * - `merge-candidate` — tend selected the PR as the next one to merge.
 * - `merge-needed`    — Ready passed but the session has no tend merge consumer
 *                       (HOK-3102); a person must merge, or tend must be enabled,
 *                       after which the monitor re-runs Ready.
 *
 * An absent value is not a state: shell readers derive `ready` for a completed
 * pass/warn result through `ready_result_queue_state` (wavemill-common.sh).
 */
export const MERGE_QUEUE_STATES = ['ready', 'ready-stale', 'merge-candidate', 'merge-needed'] as const;
export type MergeQueueState = (typeof MERGE_QUEUE_STATES)[number];

export function isMergeQueueState(value: unknown): value is MergeQueueState {
  return typeof value === 'string' && (MERGE_QUEUE_STATES as readonly string[]).includes(value);
}

/**
 * Where a Ready-passed PR sits relative to the merge lane:
 *
 * - `tend-lane`      — a tend consumer owns it (`ready` on a completed result,
 *                      `ready-stale`, `merge-candidate`); waiting is expected.
 * - `merge-needed`   — it cleared Ready but no merge consumer exists; nothing
 *                      will advance it without a person (or tend arriving).
 * - `not-in-lane`    — anything else, including absent/unknown values and a
 *                      `ready` value on a result that is not completed.
 *
 * The one answer to "is this PR in the merge lane?"; readers branch on the
 * position by name rather than comparing queue-state literals.
 */
export type MergeLanePosition = 'tend-lane' | 'merge-needed' | 'not-in-lane';

export function mergeLanePosition(queueState: unknown, readyStatus: string | undefined): MergeLanePosition {
  if (!isMergeQueueState(queueState)) return 'not-in-lane';
  switch (queueState) {
    case 'merge-needed':
      return 'merge-needed';
    case 'ready':
      return readyStatus === 'completed' ? 'tend-lane' : 'not-in-lane';
    case 'ready-stale':
    case 'merge-candidate':
      return 'tend-lane';
  }
}
export type MergeQueueCiConclusion = 'pass' | 'fail' | 'pending' | 'unknown' | 'none';

export interface MergeQueueCiState {
  conclusion: MergeQueueCiConclusion;
  headSha?: string;
  /** GitHub's 3-way mergeability read for the PR head (`MERGEABLE`/`CONFLICTING`/`UNKNOWN`). */
  mergeable?: string;
  mergeStateStatus?: string;
  observedAt?: string;
  failing?: string[];
  observed?: number;
  required?: number;
}

export interface MergeQueuePr {
  issue: string;
  slug: string;
  prNumber: number;
  branch: string;
  readyBaseSha?: string;
  queueState?: MergeQueueState;
  changedFiles?: string[];
  readyAt?: string;
  unblocksCount?: number;
  candidatePromotedAt?: string;
  candidateLastProgressAt?: string;
  mergeRetryInProgressUntil?: string;
  candidateSkippedAt?: string;
  workflowStatus?: string;
  prState?: string;
  ci?: MergeQueueCiState;
  /**
   * Live GitHub labels observed for the PR at planner input construction. When
   * the label read succeeded these are authoritative — a saved Ready pass and
   * green CI never override a current tend-refusal label such as `wm:blocked`
   * (HOK-3111). Undefined means the label read failed; the planner fails
   * closed and marks the PR excluded in that case.
   */
  labels?: string[];
  /**
   * When tend recorded a rebase conflict for this PR head and base
   * (`.tend-attempt-result.json`, HOK-3316), the fact's `writtenAt`. Filled by
   * the caller from the fact store — see {@link withTendRebaseConflictFacts} —
   * so the planner never reads files. Only a fact newer than the Ready pass
   * invalidates the verdict (once per fact).
   */
  tendRebaseConflictAt?: string;
  /** Progress-only telemetry mirrored from the lane-progress record (HOK-2919). */
  lastProgressAt?: string;
  laneWaitSeconds?: number;
  laneHoldSeconds?: number;
  rebaseCount?: number;
  ciRestartCount?: number;
}

/**
 * Planner input a caller (the monitor's merge-queue tick) builds: the PR plus
 * where its tend merge-attempt fact lives and the integration tip this pass
 * observed. {@link withTendRebaseConflictFacts} consumes the two extra fields
 * and drops them, so {@link planMergeQueueTick} only ever sees a
 * {@link MergeQueuePr}.
 */
export interface MergeQueueSelectPr extends MergeQueuePr {
  /** Task state dir holding the tend merge-attempt fact (`.tend-attempt-result.json`). */
  stateDir?: string;
  /** Live integration-branch tip this pass read; absent when the read failed. */
  integrationBaseSha?: string;
}

/**
 * Named state transitions that count as real merge-lane progress for a PR.
 * Ordinary poll ticks must never be recorded — only these transitions update
 * `lastProgressAt` (HOK-2919 progress-vs-liveness).
 */
export type LaneProgressEvent =
  | 'lane-entered'
  | 'merge-attempt'
  | 'rebase'
  | 'ci-restart'
  | 'stale-base-refresh'
  | 'retry-scheduled'
  | 'merged';

/**
 * Durable per-PR lane residence telemetry. Written by the tend process (which
 * performs rebases, CI restarts, and merges) and mirrored into the merge-queue
 * ready artifacts by the mill monitor so both views can explain queue
 * residence. Also the data source for HOK-2936's reconciliation capsule.
 */
export interface LaneProgressRecord {
  prNumber: number;
  /** First time any lane event was recorded for this PR (lane entry). */
  enteredLaneAt?: string;
  /** Timestamp of the most recent real state transition (never a poll tick). */
  lastProgressAt?: string;
  lastEvent?: LaneProgressEvent;
  /** Seconds between lane entry and the most recent progress event. */
  laneHoldSeconds?: number;
  /** Seconds between ready verdict and lane entry, when readyAt is known. */
  laneWaitSeconds?: number;
  rebaseCount?: number;
  ciRestartCount?: number;
  mergeAttemptCount?: number;
}

/** Directory holding all per-PR strict-lane state (retry budget, progress). */
export function mergeLaneStateDir(prNumber: number | string, repoDir: string): string {
  return join(repoDir, '.wavemill', 'merge-lane', String(prNumber));
}

export function laneProgressPath(prNumber: number | string, repoDir: string): string {
  return join(mergeLaneStateDir(prNumber, repoDir), 'progress.json');
}

/**
 * Record one lane-progress event for a PR. Uses the shared JSON state mutex so
 * concurrent tend/monitor writers serialize. Counter fields only move on their
 * matching events; `lastProgressAt` moves on every recorded event.
 */
export async function recordLaneProgress(
  prNumber: number,
  repoDir: string,
  event: LaneProgressEvent,
  options: { now?: string; readyAt?: string } = {},
): Promise<LaneProgressRecord> {
  const now = options.now ?? new Date().toISOString();
  return mutateJsonState<LaneProgressRecord>(
    laneProgressPath(prNumber, repoDir),
    (current) => {
      const record: LaneProgressRecord = { ...(current ?? { prNumber }) };
      record.prNumber = prNumber;
      if (!record.enteredLaneAt) {
        record.enteredLaneAt = now;
        const readyAtMs = timestampMs(options.readyAt);
        const enteredMs = timestampMs(now);
        if (readyAtMs > 0 && enteredMs >= readyAtMs) {
          record.laneWaitSeconds = Math.round((enteredMs - readyAtMs) / 1000);
        }
      }
      record.lastProgressAt = now;
      record.lastEvent = event;
      const enteredMs = timestampMs(record.enteredLaneAt);
      const nowMs = timestampMs(now);
      if (enteredMs > 0 && nowMs >= enteredMs) {
        record.laneHoldSeconds = Math.round((nowMs - enteredMs) / 1000);
      }
      if (event === 'rebase' || event === 'stale-base-refresh') {
        record.rebaseCount = (record.rebaseCount ?? 0) + 1;
      }
      if (event === 'ci-restart' || event === 'stale-base-refresh') {
        record.ciRestartCount = (record.ciRestartCount ?? 0) + 1;
      }
      if (event === 'merge-attempt') {
        record.mergeAttemptCount = (record.mergeAttemptCount ?? 0) + 1;
      }
      return record;
    },
    { createIfMissing: true, initial: { prNumber } },
  );
}

/** Read the lane-progress record, or null when absent/unreadable. */
export function readLaneProgress(prNumber: number | string, repoDir: string): LaneProgressRecord | null {
  const path = laneProgressPath(prNumber, repoDir);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as LaneProgressRecord).prNumber !== 'number') {
      return null;
    }
    return parsed as LaneProgressRecord;
  } catch {
    return null;
  }
}

export const TERMINAL_WORKFLOW_STATUSES = new Set(['merged', 'completed-external', 'aborted']);

export function isTerminalWorkflowStatus(status?: string): boolean {
  return typeof status === 'string' && TERMINAL_WORKFLOW_STATUSES.has(status);
}

export function isClosedOrMergedPrState(prState?: string): boolean {
  if (typeof prState !== 'string' || prState === '') return false;
  const normalized = prState.toLowerCase();
  return normalized === 'merged' || normalized === 'closed';
}

export function isSelectableMergeQueuePr(pr: Pick<MergeQueuePr, 'workflowStatus' | 'prState'>): boolean {
  if (isTerminalWorkflowStatus(pr.workflowStatus)) return false;
  if (isClosedOrMergedPrState(pr.prState)) return false;
  return true;
}

function timestampMs(value?: string): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Why a passed Ready verdict no longer holds (HOK-3513). One cause per PR,
 * checked in this order by {@link readyVerdictInvalidation}:
 *
 * - `ci-failing`           — live required checks failed.
 * - `conflict`             — GitHub reports the PR head cannot merge into its
 *                            base (`CONFLICTING` / `DIRTY`).
 * - `tend-rebase-conflict` — tend recorded a rebase failure for this exact
 *                            (head, base) after Ready passed (HOK-3316): GitHub
 *                            can read MERGEABLE while tend's per-commit rebase
 *                            conflicts.
 */
export type ReadyInvalidationCause = 'ci-failing' | 'conflict' | 'tend-rebase-conflict';

/** True only from a POSITIVE GitHub read: a conflict, never an unknown state. */
function isConflictingMergeState(ci?: MergeQueueCiState): boolean {
  if (!ci) return false;
  return ci.mergeable === 'CONFLICTING' || ci.mergeStateStatus === 'DIRTY';
}

/**
 * The one answer to "does this passed Ready verdict still hold?" (HOK-3513).
 *
 * A Ready pass is a claim about a live PR, so the monitor withdraws it when the
 * live PR is red OR cannot merge. Returning a cause means the caller must write
 * the failed verdict (the monitor's `invalidate_ready_verdict`) and let the
 * existing failed-Ready path re-run Ready — whose CONFLICTED branch is the only
 * conflict resolver. Returning null means the pass stands (or the evidence is
 * not positive enough to withdraw it: `UNKNOWN`, an absent mergeability read or
 * a CI read error never invalidate).
 */
export function readyVerdictInvalidation(
  pr: Pick<MergeQueuePr, 'ci' | 'readyAt' | 'tendRebaseConflictAt'>,
): ReadyInvalidationCause | null {
  if (pr.ci?.conclusion === 'fail') return 'ci-failing';
  if (isConflictingMergeState(pr.ci)) return 'conflict';
  const factAt = timestampMs(pr.tendRebaseConflictAt);
  if (factAt > 0) {
    const readyAt = timestampMs(pr.readyAt);
    // Once per fact: a fact written before the pass finished was already seen by
    // that pass (Ready reports CONFLICTED and launches the resolver itself).
    if (readyAt <= 0 || factAt > readyAt) return 'tend-rebase-conflict';
  }
  return null;
}

/**
 * Fill each PR's `tendRebaseConflictAt` from its task's tend merge-attempt fact.
 * Fact validity (recorded head === live head, recorded base === live base) is
 * `readValidTendAttemptFact` / `tendAttemptFactHolds`'s decision, never
 * re-derived here. Only a `rebase` fact is a conflict: the other phases surface
 * as CI, handoff or worktree failures with their own dispositions.
 */
export function withTendRebaseConflictFacts(prs: readonly MergeQueueSelectPr[]): MergeQueuePr[] {
  return prs.map(({ stateDir, integrationBaseSha, ...pr }) => {
    if (!stateDir || !pr.ci?.headSha) return pr;
    const fact = readValidTendAttemptFact(stateDir, {
      prHeadSha: pr.ci.headSha,
      integrationBaseSha,
    });
    return fact?.phase === 'rebase' ? { ...pr, tendRebaseConflictAt: fact.writtenAt } : pr;
  });
}

/**
 * CI is green only when the live conclusion passed AND the PR can merge. The
 * conflict half is {@link isConflictingMergeState} — the one conflict read,
 * shared with {@link readyVerdictInvalidation} — so "conflicted" is written
 * once; `BLOCKED` (a required gate) and `UNSTABLE` stay non-green without
 * withdrawing the verdict.
 */
export function isCiGreen(pr: Pick<MergeQueuePr, 'ci'>): boolean {
  if (pr.ci?.conclusion !== 'pass') return false;
  const mergeStateStatus = pr.ci.mergeStateStatus ?? '';
  if (['BLOCKED', 'UNSTABLE'].includes(mergeStateStatus)) return false;
  return !isConflictingMergeState(pr.ci);
}

export interface MergeQueueConfigResolved {
  enabled: boolean;
  maxConcurrentCandidates: number;
  stuckTimeoutSeconds: number;
  conflictGroupingEnabled: boolean;
  skipCooldownSeconds: number;
}

export interface MergeQueueExclusion {
  issue: string;
  prNumber?: number;
  headSha?: string;
  reason: string;
  blockingLabel?: string;
  nextAction?: string;
}

/** One passed Ready verdict the planner withdrew, with the live fact that did it. */
export interface ReadyVerdictInvalidationRecord {
  issue: string;
  prNumber: number;
  headSha?: string;
  cause: ReadyInvalidationCause;
}

export interface MergeQueueTickPlan {
  stuckIssues: string[];
  selectedIssues: string[];
  /**
   * Passed Ready verdicts the live PR has withdrawn (HOK-3513): red CI, a
   * GitHub conflict, or a tend rebase conflict at the live (head, base). The
   * monitor rewrites each as a failed Ready result through
   * `invalidate_ready_verdict`; the planner has already dropped them from
   * every other list. The decision is {@link readyVerdictInvalidation}.
   */
  invalidatedIssues: ReadyVerdictInvalidationRecord[];
  /**
   * PRs that are excluded from candidate accounting because tend will refuse
   * to consume them (e.g. carry `wm:blocked`) or because live label state
   * could not be read. Excluded PRs never enter `selectedIssues`, and are
   * ignored for stuck/invalidated accounting so a `wm:blocked` PR does not
   * bounce between promote and demote (HOK-3111).
   */
  excludedIssues: MergeQueueExclusion[];
}

/**
 * Labels a PR may carry that make it non-consumable by tend. If any of these
 * are present, the merge queue must not promote the PR to `merge-candidate`.
 */
export const TEND_REFUSAL_LABELS = new Set<string>(['wm:blocked']);

/**
 * Classify whether the merge queue may treat this PR as a candidate. When the
 * label read failed (labels undefined) we fail closed: the PR is excluded
 * rather than silently promoted based on stale label knowledge.
 */
export function classifyMergeQueueConsumability(
  pr: Pick<MergeQueuePr, 'labels'>,
): { consumable: true } | { consumable: false; blockingLabel?: string; reason: string; nextAction?: string } {
  if (pr.labels === undefined) {
    return {
      consumable: false,
      reason: 'live labels unknown',
      nextAction: 'retry label fetch',
    };
  }
  for (const label of pr.labels) {
    if (TEND_REFUSAL_LABELS.has(label)) {
      return {
        consumable: false,
        blockingLabel: label,
        reason: `carries ${label}`,
        nextAction: label === 'wm:blocked' ? 'clear wm:blocked (tend resolution)' : `clear ${label}`,
      };
    }
  }
  return { consumable: true };
}

function overlaps(left?: string[], right?: string[]): boolean {
  const leftKnown = Array.isArray(left) && left.length > 0;
  const rightKnown = Array.isArray(right) && right.length > 0;
  if (!leftKnown && !rightKnown) return true;
  if (!leftKnown || !rightKnown) return false;
  const rightSet = new Set(right);
  return left.some((file) => rightSet.has(file));
}

function comparePriority(left: MergeQueuePr, right: MergeQueuePr): number {
  const unblocksDelta = (right.unblocksCount ?? 0) - (left.unblocksCount ?? 0);
  if (unblocksDelta !== 0) return unblocksDelta;

  const leftFileCount = left.changedFiles?.length ?? Number.MAX_SAFE_INTEGER;
  const rightFileCount = right.changedFiles?.length ?? Number.MAX_SAFE_INTEGER;
  if (leftFileCount !== rightFileCount) return leftFileCount - rightFileCount;

  const readyDelta = timestampMs(left.readyAt) - timestampMs(right.readyAt);
  if (readyDelta !== 0) return readyDelta;

  return left.issue.localeCompare(right.issue);
}

export function isCandidateStuck(
  candidate: Pick<MergeQueuePr, 'candidateLastProgressAt' | 'candidatePromotedAt' | 'mergeRetryInProgressUntil' | 'lastProgressAt'>,
  now: string,
  config: Pick<MergeQueueConfigResolved, 'stuckTimeoutSeconds'>,
): boolean {
  if (timestampMs(candidate.mergeRetryInProgressUntil) > timestampMs(now)) {
    return false;
  }
  // lastProgressAt is tend's lane-progress stamp (rebases, CI restarts,
  // stale-base refreshes). A candidate tend is actively recovering must not be
  // demoted as stuck by the independent queue process (HOK-2919).
  const lastProgress = Math.max(
    timestampMs(candidate.candidateLastProgressAt),
    timestampMs(candidate.lastProgressAt),
  ) || timestampMs(candidate.candidatePromotedAt);
  if (lastProgress <= 0) return false;
  return timestampMs(now) - lastProgress >= config.stuckTimeoutSeconds * 1000;
}

function coolingDown(pr: MergeQueuePr, now: string, config: Pick<MergeQueueConfigResolved, 'skipCooldownSeconds'>): boolean {
  if (!pr.candidateSkippedAt) return false;
  if (config.skipCooldownSeconds <= 0) return false;
  const skippedAt = timestampMs(pr.candidateSkippedAt);
  if (skippedAt <= 0) return false;
  return timestampMs(now) - skippedAt < config.skipCooldownSeconds * 1000;
}

export function selectMergeCandidates(options: {
  readyPrs: MergeQueuePr[];
  activeCandidates: MergeQueuePr[];
  now: string;
  config: MergeQueueConfigResolved;
}): MergeQueuePr[] {
  const { readyPrs, activeCandidates, now, config } = options;
  const selected = activeCandidates
    .filter(isSelectableMergeQueuePr)
    .filter(isCiGreen)
    .sort(comparePriority)
    .slice(0, config.maxConcurrentCandidates);
  const selectedIssues = new Set(selected.map((pr) => pr.issue));

  const eligible = readyPrs
    .filter(isSelectableMergeQueuePr)
    .filter(isCiGreen)
    .filter((pr) => !selectedIssues.has(pr.issue))
    .filter((pr) => !coolingDown(pr, now, config))
    .sort(comparePriority);

  for (const pr of eligible) {
    if (selected.length >= config.maxConcurrentCandidates) break;
    if (config.conflictGroupingEnabled && selected.some((candidate) => overlaps(candidate.changedFiles, pr.changedFiles))) {
      continue;
    }
    selected.push(pr);
    selectedIssues.add(pr.issue);
  }

  return selected;
}

export function planMergeQueueTick(options: {
  readyPrs: MergeQueuePr[];
  now: string;
  config: MergeQueueConfigResolved;
}): MergeQueueTickPlan {
  const { readyPrs, now, config } = options;
  const selectablePrs = readyPrs.filter(isSelectableMergeQueuePr);

  // HOK-3513: a passed verdict is withdrawn by live PR state before anything
  // else is decided. This runs over every selectable PR — not just candidates —
  // and before label exclusion, because invalidation is about the verdict, not
  // about whether tend can consume the PR (a conflicted PR already carries
  // wm:blocked, and an excluded PR must still have its verdict withdrawn).
  // Invalidated PRs are then dropped from every later list.
  const invalidatedIssues: ReadyVerdictInvalidationRecord[] = [];
  const invalidatedIssueSet = new Set<string>();
  for (const pr of selectablePrs) {
    const cause = readyVerdictInvalidation(pr);
    if (!cause) continue;
    invalidatedIssueSet.add(pr.issue);
    invalidatedIssues.push({
      issue: pr.issue,
      prNumber: pr.prNumber,
      ...(pr.ci?.headSha ? { headSha: pr.ci.headSha } : {}),
      cause,
    });
  }

  // HOK-3111: split tend-refusal PRs (e.g. wm:blocked) out before any
  // candidate/stuck accounting so they never enter promote/demote cycles.
  const excludedIssues: MergeQueueExclusion[] = [];
  const excludedIssueSet = new Set<string>();
  const consumablePrs: MergeQueuePr[] = [];
  for (const pr of selectablePrs) {
    if (invalidatedIssueSet.has(pr.issue)) continue;
    const verdict = classifyMergeQueueConsumability(pr);
    if (verdict.consumable) {
      consumablePrs.push(pr);
      continue;
    }
    excludedIssueSet.add(pr.issue);
    excludedIssues.push({
      issue: pr.issue,
      prNumber: pr.prNumber,
      headSha: pr.ci?.headSha,
      reason: verdict.reason,
      blockingLabel: verdict.blockingLabel,
      nextAction: verdict.nextAction,
    });
  }

  const stuckIssues = consumablePrs
    .filter((pr) => pr.queueState === 'merge-candidate')
    .filter((pr) => isCandidateStuck(pr, now, config))
    .map((pr) => pr.issue);

  const activeCandidates = consumablePrs
    .filter((pr) => pr.queueState === 'merge-candidate')
    .filter((pr) => !stuckIssues.includes(pr.issue));
  const eligibleReadyPrs = consumablePrs.filter((pr) => !stuckIssues.includes(pr.issue));

  const selectedIssues = selectMergeCandidates({
    readyPrs: eligibleReadyPrs,
    activeCandidates,
    now,
    config,
  })
    .filter((pr) => !excludedIssueSet.has(pr.issue))
    .map((pr) => pr.issue);

  return { stuckIssues, selectedIssues, invalidatedIssues, excludedIssues };
}
