/**
 * HOK-3322 — the one Ready remediation disposition.
 *
 * "Is Ready remediation still in flight?" was answered at five sites from two
 * facts alone — `.ready-result.json` says `running` and the remediation launch
 * head equals the current head. When a remediation agent reran flaky CI
 * without committing (2026-10-26, PR #1720), both facts stayed true after the
 * agent settled, and the monitor held the arm forever: nothing on that path
 * consulted liveness. A running artifact and a matching launch SHA are facts
 * about the launch, not about the agent.
 *
 * This module is the single decision the monitor (through
 * `tools/ready-remediation-disposition.ts`) and the ready-watchdog (in
 * process) consume:
 *
 * - {@link readReadyRemediationLaunch} is the one reader of launch identity:
 *   the conflict resolver's condition-keyed `.conflict-remediation.json`
 *   (HOK-3273), else the `ready-remediation` bounded-retry bucket head
 *   (HOK-2924 — the bucket is the source of truth, the JSON
 *   `remediationLaunchHead` mirror is for dashboards only). The launch time is
 *   the session-ownership row written before the child starts (HOK-3328).
 * - {@link decideReadyRemediationDisposition} is pure. Liveness comes only
 *   from the shared task-progress primitive (HOK-3101): the agent's own hook
 *   record, a blocking prompt, live background work, `stalled`.
 * - {@link gatherReadyTaskProgress} is the one way both callers compose the
 *   primitive for a Ready task, so they decide on identical evidence.
 *
 * `settled` never means "Ready passed": it only lets the controller run its
 * own Ready check (`launch_ready_phase` → `ready.ts`), which publishes the
 * handoff only for green current-head checks and otherwise charges the
 * existing `ready-remediation` bucket. No marker, bucket, flag or terminal
 * cause is added here.
 *
 * Enforced by `tools/check-ready-remediation-disposition.ts`.
 *
 * @module ready-remediation-disposition
 */

import { statSync } from 'node:fs';
import { join } from 'node:path';
import { createStateDirRetry } from './bounded-retry.ts';
import { readOwnershipRows, type OwnershipKind } from './session-ownership.ts';
import {
  getTaskProgress,
  type HookState,
  type ProgressSource,
  type TaskProgress,
} from './task-progress.ts';
import { readMarker } from './transient-marker.ts';
import type { StageResult } from './stage-result.ts';
import type { TaskRecord } from './workflow-state.ts';

export type ReadyRemediationKind = 'ci' | 'conflict';

export type ReadyRemediationDispositionKind =
  /** Ready is not running, or no remediation was launched. */
  | 'inactive'
  /** The head moved past the launch head: condition expiry and the pending re-check own it. */
  | 'advanced'
  /** The remediation agent still owns the head. Hold. */
  | 'in-flight'
  /** The agent settled at the launch head: the controller re-runs Ready. */
  | 'settled';

export interface ReadyRemediationLaunch {
  remediation: ReadyRemediationKind;
  launchHead: string;
  /** ISO launch time (ownership row, else the ready result's startedAt); null when unknown. */
  launchedAt: string | null;
}

export interface ReadyRemediationDisposition {
  kind: ReadyRemediationDispositionKind;
  /** Short and greppable, e.g. `agent-idle-after-launch`. */
  reason: string;
  remediation: ReadyRemediationKind | null;
  launchHead: string | null;
  currentHead: string | null;
  launchedAt: string | null;
}

/** The task-progress fields the decision reads. */
export type ReadyRemediationProgress = Pick<
  TaskProgress,
  'agentRecord' | 'agentProcessLive' | 'agentBackgroundLive' | 'blockingPrompt' | 'stalled'
>;

export interface ReadyRemediationDispositionInput {
  readyStatus: string | null;
  launch: ReadyRemediationLaunch | null;
  currentHead: string | null;
  /** `null` when the probe failed. */
  progress: ReadyRemediationProgress | null;
}

const CONFLICT_REMEDIATION_MARKER = '.conflict-remediation.json';

/** Agent states that mean the agent still owns the head (or waits on an operator). */
const LIVE_AGENT_STATES: ReadonlySet<HookState> = new Set<HookState>([
  'working',
  'waiting',
  'approval-needed',
  'blocked',
  'policy-denied',
]);

/** Agent states that end the agent's turn. */
const SETTLED_AGENT_STATES: ReadonlySet<HookState> = new Set<HookState>(['idle', 'error']);

const OWNERSHIP_KIND: Record<ReadyRemediationKind, OwnershipKind> = {
  ci: 'ready-remediation',
  conflict: 'conflict-resolution',
};

// Only `readKey` is used; the attempt ceiling belongs to the launch sites.
const readyRemediationBucket = createStateDirRetry('ready-remediation', { maxAttempts: 1 });

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function isoToEpochSeconds(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function conflictLaunchHead(stateDir: string): string | null {
  const marker = readMarker({ path: join(stateDir, CONFLICT_REMEDIATION_MARKER), kind: 'conflict-remediation' });
  if (marker.status !== 'present') return null;
  return nonEmpty(marker.payload.detail?.launchHead) ?? nonEmpty(marker.payload.headSha);
}

/** Newest ownership row of `kind`, or null when none was recorded. */
function latestLaunchedAt(stateDir: string, kind: OwnershipKind): string | null {
  let latest: { at: string; ms: number } | null = null;
  for (const row of readOwnershipRows(stateDir)) {
    if (row.kind !== kind) continue;
    const ms = Date.parse(row.launchedAt);
    if (Number.isFinite(ms) && (!latest || ms > latest.ms)) latest = { at: row.launchedAt, ms };
  }
  return latest?.at ?? null;
}

/**
 * The one reader of Ready remediation launch identity. Returns null when Ready
 * is not running or nothing was launched.
 *
 * - Conflict: the running ready result carries `mergeConflict: CONFLICTED`
 *   (written when the resolver launched) and the condition-keyed marker is
 *   still present; the reconciler expires the marker once the head moves.
 * - CI: the `ready-remediation` bucket head.
 *
 * `launchedAt` is the newest matching session-ownership row. The ready
 * result's `startedAt` is only a fallback: a later pending rewrite of the
 * result restamps it, which would make a settled agent look pre-launch.
 */
export function readReadyRemediationLaunch(
  stateDir: string,
  readyResult: Pick<StageResult, 'status' | 'startedAt' | 'artifacts'> | null,
): ReadyRemediationLaunch | null {
  if (readyResult?.status !== 'running') return null;
  // Same predicate as the monitor's conflict_remediation_awaiting_ready: the
  // running record the resolver launch wrote, whatever its artifact typing.
  const mergeConflict = (readyResult.artifacts as { mergeConflict?: unknown } | undefined)?.mergeConflict;
  const remediation: ReadyRemediationKind = mergeConflict === 'CONFLICTED' ? 'conflict' : 'ci';

  let launchHead: string | null;
  if (remediation === 'conflict') {
    launchHead = conflictLaunchHead(stateDir);
  } else {
    try {
      launchHead = nonEmpty(readyRemediationBucket.readKey(stateDir).head);
    } catch {
      launchHead = null;
    }
  }
  if (!launchHead) return null;

  return {
    remediation,
    launchHead,
    launchedAt: latestLaunchedAt(stateDir, OWNERSHIP_KIND[remediation]) ?? nonEmpty(readyResult.startedAt),
  };
}

/**
 * The pure decision. Rules, in order:
 *
 * 1. Ready not running, or no launch → `inactive`.
 * 2. Launch head ≠ current head → `advanced`.
 * 3. Probe failed → `in-flight` (fail safe; the watchdog still reports).
 * 4. A blocking prompt or live background work → `in-flight`: the agent is
 *    waiting on an operator or on its own task (HOK-3137).
 * 5. The agent's own record (never a monitor write, HOK-3101) written at or
 *    after the launch: a live state → `in-flight`; `idle`/`error` →
 *    `settled`. A record from before the launch is the previous stage's
 *    agent, and an unknown launch time attributes no record.
 * 6. The agent process exited → `settled`.
 * 7. `stalled` → `settled`: no agent evidence and no progress past the
 *    threshold, so execution is uncertain and the controller's bounded
 *    re-check takes over instead of a latch.
 * 8. Otherwise → `in-flight` until the agent reports.
 */
export function decideReadyRemediationDisposition(
  input: ReadyRemediationDispositionInput,
): ReadyRemediationDisposition {
  const { readyStatus, launch, currentHead, progress } = input;
  const base = {
    remediation: launch?.remediation ?? null,
    launchHead: launch?.launchHead ?? null,
    currentHead,
    launchedAt: launch?.launchedAt ?? null,
  };
  const result = (kind: ReadyRemediationDispositionKind, reason: string): ReadyRemediationDisposition => ({
    kind,
    reason,
    ...base,
  });

  if (readyStatus !== 'running') return result('inactive', 'not-running');
  if (!launch) return result('inactive', 'no-launch');
  if (launch.launchHead !== currentHead) return result('advanced', 'head-moved');
  if (!progress) return result('in-flight', 'progress-unavailable');
  if (progress.blockingPrompt) return result('in-flight', 'blocking-prompt');
  if (progress.agentBackgroundLive === true) return result('in-flight', 'background-work');

  const record = progress.agentRecord;
  const launchedEpoch = isoToEpochSeconds(launch.launchedAt);
  if (record?.state && launchedEpoch !== null && record.timestamp >= launchedEpoch) {
    if (LIVE_AGENT_STATES.has(record.state)) return result('in-flight', `agent-${record.state}`);
    if (SETTLED_AGENT_STATES.has(record.state)) return result('settled', `agent-${record.state}-after-launch`);
  }

  if (progress.agentProcessLive === false) return result('settled', 'agent-exited');
  if (progress.stalled) return result('settled', 'agent-stalled');
  return result('in-flight', 'awaiting-agent-evidence');
}

export interface EvaluateReadyRemediationDispositionOptions {
  stateDir: string;
  readyResult: Pick<StageResult, 'status' | 'startedAt' | 'artifacts'> | null;
  currentHead: string | null;
  /** Called only when liveness decides the outcome (same-head running launch). */
  getProgress: () => ReadyRemediationProgress | null;
}

/**
 * Read the launch and decide. Progress is gathered lazily: only a running
 * launch at the current head needs liveness, so the monitor's hot pass never
 * probes the pane for an inactive or advanced task. A throwing probe is a
 * failed probe (`progress-unavailable`).
 */
export function evaluateReadyRemediationDisposition(
  opts: EvaluateReadyRemediationDispositionOptions,
): ReadyRemediationDisposition {
  const input: ReadyRemediationDispositionInput = {
    readyStatus: opts.readyResult?.status ?? null,
    launch: readReadyRemediationLaunch(opts.stateDir, opts.readyResult),
    currentHead: opts.currentHead,
    progress: null,
  };
  const withoutProgress = decideReadyRemediationDisposition(input);
  if (withoutProgress.reason !== 'progress-unavailable') return withoutProgress;
  try {
    return decideReadyRemediationDisposition({ ...input, progress: opts.getProgress() });
  } catch {
    return withoutProgress;
  }
}

function fileMtimeIso(file: string): string | null {
  try {
    return statSync(file).mtime.toISOString();
  } catch {
    return null;
  }
}

export interface GatherReadyTaskProgressOptions {
  issue: string;
  session: string;
  worktree: string;
  /** The ready state dir (`<worktree>/features/<slug>`). */
  stateDir: string;
  task?: Pick<TaskRecord, 'updated' | 'branch' | 'slug' | 'worktree' | 'status' | 'phase' | 'lifecycle'>;
  readyResult: Pick<StageResult, 'startedAt' | 'finishedAt'> | null;
  /** Pane target for the blocking-prompt matcher and background-work probe. */
  paneText?: string;
  panePid?: number | null;
  now?: Date;
}

/**
 * Compose the task-progress primitive for a Ready task. The ready result's
 * start/finish/mtime are transitions, as every Ready liveness reader has
 * counted them; the monitor CLI and the watchdog both gather through here.
 */
export function gatherReadyTaskProgress(opts: GatherReadyTaskProgressOptions): TaskProgress {
  const transitions: ProgressSource[] = [];
  if (opts.readyResult?.startedAt) {
    transitions.push({ kind: 'transition', at: opts.readyResult.startedAt, detail: 'ready.startedAt' });
  }
  if (opts.readyResult?.finishedAt) {
    transitions.push({ kind: 'transition', at: opts.readyResult.finishedAt, detail: 'ready.finishedAt' });
  }
  const readyMtime = fileMtimeIso(join(opts.stateDir, '.ready-result.json'));
  if (readyMtime) transitions.push({ kind: 'transition', at: readyMtime, detail: 'ready-result.mtime' });

  return getTaskProgress({
    issue: opts.issue,
    session: opts.session,
    task: opts.task,
    worktree: opts.worktree,
    featureDir: opts.stateDir,
    phase: 'ready',
    extraTransitionSources: transitions,
    paneText: opts.paneText,
    panePid: opts.panePid,
    now: opts.now,
  });
}
