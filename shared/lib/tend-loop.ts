import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { mutateJsonState } from './state-mutex.ts';
import { executeMerge, formatStatusLine, selectNextCandidate, type BlockedCandidate, type MergeExecutionResult, type TendDecision } from './tend-controller.ts';
import { WM_LABELS } from './pr-state-labels.ts';
import type { StatusRenderer } from './tend-status-renderer.ts';
import { computeBackoffDelayMs, isTransientError } from './transient-retry.ts';

export const TEND_LOOP_INTERVAL_MS = 60_000;
export const TEND_LOOP_ERROR_BACKOFF_BASE_MS = 30_000;
// Keep this below BACKSTAGE_TEND_HEARTBEAT_STALE_SECONDS in wavemill-mill.sh.
export const TEND_LOOP_ERROR_BACKOFF_MAX_MS = 120_000;
export const TEND_MAX_CONSECUTIVE_UNKNOWN_FAILURES = 3;
// Consecutive merge-lane-held skips before the loop starts emitting an explicit
// stall warning (~3 minutes at the 60 s poll interval). Without this the
// deadlock is invisible: the stream keeps reporting health=ok with a
// merging-#N / skipped-#N pair every poll.
export const TEND_LANE_STALL_WARN_ITERATIONS = 3;
// Progress-vs-liveness thresholds (HOK-2919 / consolidated HOK-2910): a lane
// that reports eligible=0, blocked>0, action=idle for this many consecutive
// polls is stalled, no matter how healthily it keeps polling. ~30 minutes at
// the 60 s interval for the high-severity finding, ~2 hours for urgent.
export const TEND_IDLE_STALL_HIGH_ITERATIONS = 30;
export const TEND_IDLE_STALL_URGENT_ITERATIONS = 120;
// Independent green-ready detector (REQ-F4 of HOK-2910): a PR carrying
// wm:ready that stays unmerged this long is a finding on its own, regardless
// of tend's reported health. Re-emitted at most once per this interval.
export const TEND_READY_UNMERGED_WARN_MS = 30 * 60_000;

export type TendLoopErrorClass = 'transient' | 'terminal' | 'unknown';

export interface TendLoopExit {
  reason: 'halted' | 'terminal-error' | 'unknown-error-budget-exhausted';
  error?: unknown;
  lastMergedPR: number | null;
}

export interface TendLoopDeps {
  selectNextCandidate: typeof selectNextCandidate;
  executeMerge: typeof executeMerge;
  writePollHeartbeat: typeof writeTendPollHeartbeatBestEffort;
  writeFailureState: typeof writeTendFailureStateBestEffort;
  /** Best-effort observer-findings JSONL emitter; must never fail the loop. */
  emitObserverFinding: (repoDir: string, finding: MergeLaneObserverFinding) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  log: (line: string) => void;
  random: () => number;
}

/** JSONL finding shape consumed by tools/observer.ts readObserverFindingsJsonl. */
export interface MergeLaneObserverFinding {
  subsystem: string;
  title: string;
  body?: string;
  severity?: string;
  recommendation?: string;
  context?: Record<string, unknown>;
}

/** 'progressing' | 'idle' (empty lane) | 'stalled' (blocked lane, no movement). */
export type TendProgressState = 'progressing' | 'idle' | 'stalled';
export type TendLaneCondition = 'progressing' | 'no-eligible' | 'needs-user-hold' | 'idle-blocked-stall';

export interface TendLoopOptions {
  repoDir: string;
  renderer: StatusRenderer;
  deps?: Partial<TendLoopDeps>;
  intervalMs?: number;
  errorBackoffBaseMs?: number;
  errorBackoffMaxMs?: number;
  maxConsecutiveUnknownFailures?: number;
}

interface BackstageHealthFile {
  updatedAt?: string;
  status?: string;
  detail?: string | null;
  restartAttemptCount?: number;
  lastRestartAttemptAt?: string | null;
  executorPaneId?: string | null;
  services?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

const TERMINAL_ERROR_PATTERNS = [
  /integration branch not configured/i,
  /invalid (?:integration|PR) branch name/i,
  /tend-singleton:/i,
  /was not found in eligible candidates/i,
];

interface TendPollMetadata {
  iteration: number;
  pollStartedAt: string;
  pollCompletedAt: string | null;
}

export function statusActionForResult(status: MergeExecutionResult['status'], prNumber: number): string {
  return status === 'merged' ? `merged-#${prNumber}` : `${status}-#${prNumber}`;
}

/**
 * Format the explicit merge-lane stall warning emitted when the same lane
 * holder blocks candidate merges for TEND_LANE_STALL_WARN_ITERATIONS or more
 * consecutive polls. Kept as an exported pure helper so the format (a
 * greppable signal and a future observer-detector hook) is directly testable.
 */
export function formatLaneStallWarning(options: {
  holders: number[];
  candidate: number;
  consecutive: number;
}): string {
  const holder = options.holders.length > 0
    ? options.holders.map((prNumber) => `#${prNumber}`).join(',')
    : 'unknown';
  return `warn=merge-lane-stalled holder=${holder} candidate=#${options.candidate} consecutive=${options.consecutive}`;
}

/**
 * Greppable status-stream warning for the idle-blocked stall (HOK-2919): the
 * lane holds blocked PRs, nothing is eligible, and the loop keeps idling.
 */
export function formatIdleStallWarning(options: {
  blocked: BlockedCandidate[];
  consecutive: number;
  severity: 'high' | 'urgent';
}): string {
  const blockedList = options.blocked.length > 0
    ? options.blocked.map((candidate) => `#${candidate.number}(${candidate.reason})`).join(',')
    : 'unknown';
  return `warn=merge-lane-idle-stalled severity=${options.severity} blocked=${blockedList} consecutive=${options.consecutive}`;
}

function describeBlockedCandidate(candidate: BlockedCandidate): string {
  const labels = candidate.labels && candidate.labels.length > 0 ? candidate.labels.join(',') : '(unknown)';
  return `PR #${candidate.number} (${candidate.headBranch}) labels=[${labels}] gate=${candidate.reason}`;
}

/**
 * Progress-driven stalled-lane finding (REQ-F1..F3 of consolidated HOK-2910).
 * Names each blocked PR, its labels, and the specific gate holding it so the
 * finding is actionable without re-deriving the lane state.
 */
export function buildMergeLaneStalledFinding(options: {
  decision: TendDecision;
  consecutive: number;
  severity: 'high' | 'urgent';
  now: string;
}): MergeLaneObserverFinding {
  const blocked = options.decision.blocked;
  const first = blocked[0];
  return {
    subsystem: 'merge-lane',
    title: `Merge lane stalled: ${blocked.length} blocked PR${blocked.length === 1 ? '' : 's'}, 0 eligible for ${options.consecutive} consecutive polls`,
    body: [
      `tend reported eligible=0 blocked=${blocked.length} action=idle for ${options.consecutive} consecutive polls; `
      + 'the loop is alive but the lane is not draining.',
      ...blocked.map((candidate) => describeBlockedCandidate(candidate)),
    ].join('\n'),
    severity: options.severity,
    recommendation: 'Inspect the named gate for each blocked PR (challenge pair, wm:blocked label, missing review '
      + 'verdict, stale base) and unstick the lane; liveness alone is not health.',
    context: {
      markerPath: `merge-lane/idle-stall/${first ? `#${first.number}` : 'none'}`,
      markerKind: 'merge-lane-idle-stall',
      consecutivePolls: options.consecutive,
      blockedCount: blocked.length,
      blockedPrs: blocked.map((candidate) => candidate.number).join(','),
      firstBlockedPr: first?.number ?? null,
      firstBlockedLabels: first?.labels?.join(',') ?? '',
      firstBlockedGate: first?.reason ?? '',
      observedAt: options.now,
    },
  };
}

/**
 * Independent long-wait detector: a wm:ready PR that stays unmerged past the
 * threshold is a finding on its own, regardless of what tend's health reports
 * say (REQ-F4 of consolidated HOK-2910).
 */
export function buildReadyPrUnmergedFinding(options: {
  candidate: BlockedCandidate;
  waitedMs: number;
  now: string;
}): MergeLaneObserverFinding {
  const waitedMinutes = Math.round(options.waitedMs / 60_000);
  return {
    subsystem: 'merge-lane',
    title: `wm:ready PR #${options.candidate.number} unmerged for ${waitedMinutes} minutes`,
    body: `${describeBlockedCandidate(options.candidate)} has carried wm:ready for ~${waitedMinutes} minutes without `
      + 'merging. Its ready verdict implies green CI, so the named gate is what holds it.',
    severity: options.waitedMs >= 2 * TEND_READY_UNMERGED_WARN_MS ? 'urgent' : 'high',
    recommendation: 'Resolve the named gate or canonicalize labels with tools/set-pr-ready-label.ts if the gate is stale.',
    context: {
      markerPath: `merge-lane/ready-unmerged/#${options.candidate.number}`,
      markerKind: 'merge-lane-ready-unmerged',
      prNumber: options.candidate.number,
      labels: options.candidate.labels?.join(',') ?? '',
      gate: options.candidate.reason,
      waitedMinutes,
      observedAt: options.now,
    },
  };
}

/** Default best-effort JSONL append into .wavemill/observer-findings.jsonl. */
export function emitObserverFindingBestEffort(repoDir: string, finding: MergeLaneObserverFinding): void {
  try {
    const wavemillDir = join(repoDir, '.wavemill');
    mkdirSync(wavemillDir, { recursive: true });
    appendFileSync(join(wavemillDir, 'observer-findings.jsonl'), `${JSON.stringify(finding)}\n`, 'utf-8');
  } catch (error) {
    console.error(`tend: failed to emit observer finding: ${errorMessage(error)}`);
  }
}

export async function runTendLoop(options: TendLoopOptions): Promise<TendLoopExit> {
  const deps = tendLoopDeps(options.deps);
  const intervalMs = options.intervalMs ?? TEND_LOOP_INTERVAL_MS;
  const maxUnknown = options.maxConsecutiveUnknownFailures ?? TEND_MAX_CONSECUTIVE_UNKNOWN_FAILURES;
  let lastMergedPR: number | null = null;
  let consecutiveFailures = 0;
  let consecutiveUnknown = 0;
  let lastError: string | null = null;
  let lastErrorAt: string | null = null;
  let iteration = 0;
  let laneStallStreak = 0;
  // Progress-vs-liveness state (HOK-2919): progress is a real state change —
  // a merge, a retry-refresh, or the lane's PR set/gates changing — never a
  // successful poll by itself.
  let idleBlockedStreak = 0;
  let lastProgressAt = deps.now().toISOString();
  let lastDecisionSignature: string | null = null;
  const readyUnmergedTracker = new Map<number, { firstSeenMs: number; lastEmittedMs: number }>();

  const noteDecisionProgress = (decision: TendDecision, at: string): boolean => {
    const signature = decisionSignature(decision);
    const progressed = lastDecisionSignature !== null && signature !== lastDecisionSignature;
    if (progressed) {
      lastProgressAt = at;
    }
    lastDecisionSignature = signature;
    return progressed;
  };

  const trackReadyUnmerged = (decision: TendDecision, at: string): void => {
    const nowMs = Date.parse(at);
    const openReadyBlocked = new Set<number>();
    for (const candidate of decision.blocked) {
      if (!candidate.labels?.includes(WM_LABELS.ready)) {
        continue;
      }
      // A gate that already names failing/pending checks means CI is not
      // green; the ready-unmerged finding is specifically about green PRs.
      if (/checks-failing|checks-pending|ready-failed/.test(candidate.reason)) {
        continue;
      }
      openReadyBlocked.add(candidate.number);
      const entry = readyUnmergedTracker.get(candidate.number) ?? { firstSeenMs: nowMs, lastEmittedMs: 0 };
      readyUnmergedTracker.set(candidate.number, entry);
      const waitedMs = nowMs - entry.firstSeenMs;
      if (waitedMs >= TEND_READY_UNMERGED_WARN_MS && nowMs - entry.lastEmittedMs >= TEND_READY_UNMERGED_WARN_MS) {
        entry.lastEmittedMs = nowMs;
        deps.emitObserverFinding(options.repoDir, buildReadyPrUnmergedFinding({ candidate, waitedMs, now: at }));
      }
    }
    for (const prNumber of [...readyUnmergedTracker.keys()]) {
      if (!openReadyBlocked.has(prNumber)) {
        readyUnmergedTracker.delete(prNumber);
      }
    }
  };

  while (true) {
    iteration += 1;
    const pollStartedAt = deps.now().toISOString();
    let pollCompletedAt: string | null = null;

    try {
      const decision = await deps.selectNextCandidate({ repoDir: options.repoDir });
      pollCompletedAt = deps.now().toISOString();
      const pollMetadata = { iteration, pollStartedAt, pollCompletedAt };
      const decisionProgressed = noteDecisionProgress(decision, pollCompletedAt);
      trackReadyUnmerged(decision, pollCompletedAt);

      if (decision.nextPR === null) {
        // A changed lane signature (PRs entering/leaving, gates changing) is
        // real state movement and restarts the stall count; only an unchanged
        // blocked lane accumulates toward the stall thresholds.
        idleBlockedStreak = decision.blocked.length === 0
          ? 0
          : decisionProgressed ? 1 : idleBlockedStreak + 1;
        const progressState: TendProgressState = idleBlockedStreak >= TEND_IDLE_STALL_HIGH_ITERATIONS
          ? 'stalled'
          : decision.blocked.length > 0 ? 'progressing' : 'idle';
        const laneCondition: TendLaneCondition = decision.blocked.length === 0
          ? 'no-eligible'
          : idleBlockedStreak >= TEND_IDLE_STALL_HIGH_ITERATIONS ? 'idle-blocked-stall' : 'needs-user-hold';

        options.renderer.write(formatStatusLine(decision, {
          action: 'idle',
          lastPR: lastMergedPR,
          ...pollMetadata,
        }));

        if (idleBlockedStreak >= TEND_IDLE_STALL_HIGH_ITERATIONS) {
          const severity = idleBlockedStreak >= TEND_IDLE_STALL_URGENT_ITERATIONS ? 'urgent' : 'high';
          options.renderer.write(formatIdleStallWarning({
            blocked: decision.blocked,
            consecutive: idleBlockedStreak,
            severity,
          }));
          if (idleBlockedStreak === TEND_IDLE_STALL_HIGH_ITERATIONS || idleBlockedStreak === TEND_IDLE_STALL_URGENT_ITERATIONS) {
            deps.emitObserverFinding(options.repoDir, buildMergeLaneStalledFinding({
              decision,
              consecutive: idleBlockedStreak,
              severity,
              now: pollCompletedAt,
            }));
          }
        }

        consecutiveFailures = 0;
        consecutiveUnknown = 0;
        lastError = null;
        lastErrorAt = null;
        laneStallStreak = 0;
        await deps.writePollHeartbeat(options.repoDir, {
          failureCount: consecutiveFailures,
          lastError,
          lastErrorAt,
          timestamp: pollCompletedAt,
          lastProgressAt,
          progressState,
          laneCondition,
          laneEvidenceId: decisionEvidenceId(decision),
          ...pollMetadata,
        });
        await deps.sleep(intervalMs);
        continue;
      }

      idleBlockedStreak = 0;
      const candidate = decision.eligible.find((item) => item.number === decision.nextPR);
      if (!candidate) {
        throw new Error(`tend: selected PR #${decision.nextPR} was not found in eligible candidates`);
      }

      options.renderer.write(formatStatusLine(decision, {
        action: `merging-#${candidate.number}`,
        lastPR: lastMergedPR,
        ...pollMetadata,
      }));
      consecutiveFailures = 0;
      consecutiveUnknown = 0;
      lastError = null;
      lastErrorAt = null;
      await deps.writePollHeartbeat(options.repoDir, {
        failureCount: consecutiveFailures,
        lastError,
        lastErrorAt,
        timestamp: pollCompletedAt,
        lastProgressAt,
        progressState: 'progressing',
        laneCondition: 'progressing',
        laneEvidenceId: decisionEvidenceId(decision),
        ...pollMetadata,
      });

      const result = await deps.executeMerge(candidate, { repoDir: options.repoDir });
      if (result.status === 'merged') {
        lastMergedPR = result.prNumber;
      }
      if (result.status === 'merged' || result.status === 'retried') {
        lastProgressAt = deps.now().toISOString();
      }

      options.renderer.write(formatStatusLine(decision, {
        action: statusActionForResult(result.status, result.prNumber),
        lastPR: lastMergedPR,
        ...pollMetadata,
      }));

      if (result.status === 'skipped' && result.phase === 'merge-lane-held') {
        laneStallStreak += 1;
        if (laneStallStreak >= TEND_LANE_STALL_WARN_ITERATIONS) {
          options.renderer.write(formatLaneStallWarning({
            holders: result.heldBy ?? [],
            candidate: result.prNumber,
            consecutive: laneStallStreak,
          }));
        }
      } else {
        laneStallStreak = 0;
      }

      if (result.haltLoop) {
        options.renderer.finalize();
        return { reason: 'halted', lastMergedPR };
      }

      await deps.sleep(intervalMs);
    } catch (error) {
      const classification = classifyTendLoopError(error);
      if (classification === 'terminal') {
        await deps.writeFailureState(options.repoDir, {
          failureCount: consecutiveFailures + 1,
          lastError: `terminal: ${truncateOneLine(errorMessage(error), 200)}`,
          lastErrorAt: deps.now().toISOString(),
          timestamp: deps.now().toISOString(),
          iteration,
          pollStartedAt,
          pollCompletedAt,
          status: 'unhealthy',
          detail: 'backstage tend loop hit a terminal error',
        });
        throw error;
      }

      consecutiveFailures += 1;
      laneStallStreak = 0;
      if (classification === 'unknown') {
        consecutiveUnknown += 1;
      } else {
        consecutiveUnknown = 0;
      }

      if (consecutiveUnknown >= maxUnknown) {
        options.renderer.write(formatLoopErrorLine({
          classification,
          consecutiveFailures,
          retryInMs: 0,
          lastPR: lastMergedPR,
          message: errorMessage(error),
          iteration,
          pollStartedAt,
          pollCompletedAt,
        }));
        throw error;
      }

      const retryInMs = tendLoopBackoffMs(consecutiveFailures, {
        baseMs: options.errorBackoffBaseMs ?? TEND_LOOP_ERROR_BACKOFF_BASE_MS,
        maxMs: options.errorBackoffMaxMs ?? TEND_LOOP_ERROR_BACKOFF_MAX_MS,
        random: deps.random,
      });
      lastError = `${classification}: ${truncateOneLine(errorMessage(error), 200)}`;
      lastErrorAt = deps.now().toISOString();
      options.renderer.write(formatLoopErrorLine({
        classification,
        consecutiveFailures,
        retryInMs,
        lastPR: lastMergedPR,
        message: errorMessage(error),
        iteration,
        pollStartedAt,
        pollCompletedAt,
      }));
      if (classification === 'unknown') {
        deps.log(`tend: unknown loop error: ${errorStack(error)}`);
      }
      await deps.writeFailureState(options.repoDir, {
        failureCount: consecutiveFailures,
        lastError,
        lastErrorAt,
        timestamp: deps.now().toISOString(),
        iteration,
        pollStartedAt,
        pollCompletedAt,
        status: classification === 'transient' ? 'degraded' : 'unhealthy',
        detail: `backstage tend loop poll failed (${classification})`,
      });
      await deps.sleep(retryInMs);
    }
  }
}

/**
 * Stable signature of a decision's lane state. A change between polls means
 * the lane's PR set or gates moved — real state movement, unlike a poll tick.
 */
function decisionSignature(decision: TendDecision): string {
  const eligible = decision.eligible.map((candidate) => candidate.number).sort((a, b) => a - b);
  const blocked = decision.blocked
    .map((candidate) => `${candidate.number}:${candidate.reason}`)
    .sort();
  return JSON.stringify({ eligible, blocked });
}

function decisionEvidenceId(decision: TendDecision): string {
  return createHash('sha256').update(decisionSignature(decision)).digest('hex').slice(0, 12);
}

export function classifyTendLoopError(error: unknown): TendLoopErrorClass {
  if (isTransientError(error)) {
    return 'transient';
  }
  if (error instanceof TypeError || error instanceof ReferenceError || error instanceof RangeError) {
    return 'terminal';
  }
  const message = errorMessage(error);
  if (TERMINAL_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
    return 'terminal';
  }
  return 'unknown';
}

export function tendLoopBackoffMs(
  consecutiveFailures: number,
  options: { baseMs?: number; maxMs?: number; random?: () => number } = {},
): number {
  return computeBackoffDelayMs(consecutiveFailures, {
    baseMs: options.baseMs ?? TEND_LOOP_ERROR_BACKOFF_BASE_MS,
    maxMs: options.maxMs ?? TEND_LOOP_ERROR_BACKOFF_MAX_MS,
    random: options.random,
  });
}

export function formatLoopErrorLine(options: {
  classification: TendLoopErrorClass;
  consecutiveFailures: number;
  retryInMs: number;
  lastPR: number | null;
  message: string;
  iteration?: number;
  pollStartedAt?: string;
  pollCompletedAt?: string | null;
}): string {
  const retrySeconds = Math.ceil(options.retryInMs / 1000);
  const last = typeof options.lastPR === 'number' ? `#${options.lastPR}` : 'none';
  const parts = [
    typeof options.iteration === 'number' ? `iter=${options.iteration}` : null,
    options.pollStartedAt ? `poll_started=${options.pollStartedAt}` : null,
    options.pollCompletedAt ? `poll_completed=${options.pollCompletedAt}` : null,
    `error=${options.classification}`,
    `consecutive=${options.consecutiveFailures}`,
    `retry_in=${retrySeconds}s`,
    `last=${last}`,
    `detail=${truncateOneLine(options.message, 200)}`,
  ];
  return parts.filter((part): part is string => part !== null).join(' ');
}

export async function writeTendHeartbeat(
  repoDir: string,
  timestamp: string,
  health: {
    failureCount: number;
    lastError: string | null;
    lastErrorAt: string | null;
    iteration?: number;
    pollStartedAt?: string;
    pollCompletedAt?: string | null;
    /** Last real state change (merge/retry/lane movement), not the last tick. */
    lastProgressAt?: string;
    progressState?: TendProgressState;
    laneCondition?: TendLaneCondition;
    laneEvidenceId?: string;
  },
): Promise<void> {
  const healthPath = join(repoDir, '.wavemill', 'backstage-health.json');
  await mutateJsonState<BackstageHealthFile>(
    healthPath,
    (current) => {
      const next = { ...(current ?? {}) };
      const services = { ...(next.services ?? {}) };
      const existing = { ...(services.tend ?? {}) };
      const detail = health.progressState === 'stalled'
        ? 'backstage tend loop is alive but the merge lane is not progressing'
        : 'backstage tend loop is running';
      services.tend = {
        ...existing,
        status: 'healthy',
        detail,
        heartbeatAt: timestamp,
        lastSuccessfulPollAt: timestamp,
        updatedAt: timestamp,
        repoDir,
        failureCount: health.failureCount,
        lastError: health.lastError,
        lastErrorAt: health.lastErrorAt,
        iteration: health.iteration,
        pollStartedAt: health.pollStartedAt,
        pollCompletedAt: health.pollCompletedAt ?? timestamp,
        ...(health.lastProgressAt !== undefined ? { lastProgressAt: health.lastProgressAt } : {}),
        ...(health.progressState !== undefined ? { progressState: health.progressState } : {}),
        ...(health.laneCondition !== undefined ? { laneCondition: health.laneCondition } : {}),
        ...(health.laneEvidenceId !== undefined ? { laneEvidenceId: health.laneEvidenceId } : {}),
      };
      next.updatedAt = timestamp;
      next.status = 'healthy';
      next.detail = detail;
      next.services = services;
      return next;
    },
    { createIfMissing: true, initial: {} },
  );
}

export async function writeTendFailureState(
  repoDir: string,
  timestamp: string,
  health: {
    status: 'degraded' | 'unhealthy';
    detail: string;
    failureCount: number;
    lastError: string | null;
    lastErrorAt: string | null;
    iteration?: number;
    pollStartedAt?: string;
    pollCompletedAt?: string | null;
  },
): Promise<void> {
  const healthPath = join(repoDir, '.wavemill', 'backstage-health.json');
  await mutateJsonState<BackstageHealthFile>(
    healthPath,
    (current) => {
      const next = { ...(current ?? {}) };
      const services = { ...(next.services ?? {}) };
      const existing = { ...(services.tend ?? {}) };
      services.tend = {
        ...existing,
        status: health.status,
        detail: health.detail,
        updatedAt: timestamp,
        repoDir,
        failureCount: health.failureCount,
        lastError: health.lastError,
        lastErrorAt: health.lastErrorAt,
        iteration: health.iteration,
        pollStartedAt: health.pollStartedAt,
        pollCompletedAt: health.pollCompletedAt ?? null,
      };
      next.updatedAt = timestamp;
      next.status = health.status;
      next.detail = health.detail;
      next.services = services;
      return next;
    },
    { createIfMissing: true, initial: {} },
  );
}

export async function writeTendPollHeartbeatBestEffort(
  repoDir: string,
  options: {
    failureCount?: number;
    lastError?: string | null;
    lastErrorAt?: string | null;
    timestamp?: string;
    iteration?: number;
    pollStartedAt?: string;
    pollCompletedAt?: string | null;
    lastProgressAt?: string;
    progressState?: TendProgressState;
    laneCondition?: TendLaneCondition;
    laneEvidenceId?: string;
  } = {},
): Promise<void> {
  try {
    await writeTendHeartbeat(
      repoDir,
      options.timestamp ?? new Date().toISOString(),
      {
        failureCount: options.failureCount ?? 0,
        lastError: options.lastError ?? null,
        lastErrorAt: options.lastErrorAt ?? null,
        iteration: options.iteration,
        pollStartedAt: options.pollStartedAt,
        pollCompletedAt: options.pollCompletedAt,
        lastProgressAt: options.lastProgressAt,
        progressState: options.progressState,
        laneCondition: options.laneCondition,
        laneEvidenceId: options.laneEvidenceId,
      },
    );
  } catch (error) {
    console.error(`tend: failed to write heartbeat: ${errorMessage(error)}`);
  }
}

export async function writeTendFailureStateBestEffort(
  repoDir: string,
  options: {
    status?: 'degraded' | 'unhealthy';
    detail?: string;
    failureCount?: number;
    lastError?: string | null;
    lastErrorAt?: string | null;
    timestamp?: string;
    iteration?: number;
    pollStartedAt?: string;
    pollCompletedAt?: string | null;
  } = {},
): Promise<void> {
  try {
    await writeTendFailureState(
      repoDir,
      options.timestamp ?? new Date().toISOString(),
      {
        status: options.status ?? 'unhealthy',
        detail: options.detail ?? 'backstage tend loop poll failed',
        failureCount: options.failureCount ?? 0,
        lastError: options.lastError ?? null,
        lastErrorAt: options.lastErrorAt ?? null,
        iteration: options.iteration,
        pollStartedAt: options.pollStartedAt,
        pollCompletedAt: options.pollCompletedAt,
      },
    );
  } catch (error) {
    console.error(`tend: failed to write failure state: ${errorMessage(error)}`);
  }
}

function tendLoopDeps(overrides: Partial<TendLoopDeps> | undefined): TendLoopDeps {
  return {
    selectNextCandidate,
    executeMerge,
    writePollHeartbeat: writeTendPollHeartbeatBestEffort,
    writeFailureState: writeTendFailureStateBestEffort,
    emitObserverFinding: emitObserverFindingBestEffort,
    sleep,
    now: () => new Date(),
    log: (line) => console.error(line),
    random: Math.random,
    ...overrides,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateOneLine(message: string, maxLength: number): string {
  const oneLine = message.replace(/\s+/g, ' ').trim();
  return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength - 3)}...` : oneLine;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStack(error: unknown): string {
  return error instanceof Error && error.stack ? error.stack : errorMessage(error);
}
