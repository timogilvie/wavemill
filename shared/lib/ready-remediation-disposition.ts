/**
 * HOK-3322 / HOK-3386 — Ready remediation reads the one stage-agent disposition.
 *
 * "Has the Ready remediation agent (CI fix or conflict resolver) settled?" is
 * the same question every agent stage answers, and it is decided in one place:
 * `decideStageAgentDisposition` in `stage-agent-disposition.ts`. This module
 * owns only what is specific to Ready:
 *
 * - {@link readReadyRemediationLaunch} is the one reader of remediation launch
 *   identity: which sub-stage is running (`ready-remediation` for a CI fix,
 *   `conflict-resolution` for the resolver) and the head it was launched
 *   against — the conflict resolver's condition-keyed `.conflict-remediation.json`
 *   (HOK-3273), else the `ready-remediation` bounded-retry bucket head
 *   (HOK-2924; the JSON `remediationLaunchHead` mirror is for dashboards only).
 * - {@link evaluateReadyRemediationDisposition} maps that identity onto the
 *   shared decision. Launch time and session come from the stage's
 *   session-ownership row (HOK-3328), read by the shared module.
 * - {@link gatherReadyTaskProgress} composes progress through the shared
 *   `gatherStageTaskProgress`, so the remediation agent's own owned-session
 *   transcript counts as agent evidence. Before this, Ready read only the
 *   `/tmp` hook file: a host reboot cleared it and the disposition held a
 *   settled agent `in-flight` forever (2026-11-05, HOK-3415).
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

import { join } from 'node:path';
import { createStateDirRetry } from './bounded-retry.ts';
import {
  evaluateStageAgentDisposition,
  gatherStageTaskProgress,
  type StageAgentDisposition,
  type StageAgentProgress,
} from './stage-agent-disposition.ts';
import type { TaskProgress } from './task-progress.ts';
import { readMarker } from './transient-marker.ts';
import type { StageResult } from './stage-result.ts';
import type { TaskRecord } from './workflow-state.ts';

export type ReadyRemediationKind = 'ci' | 'conflict';

/** The stage-agent sub-stage each remediation kind runs as. */
export type ReadyRemediationStage = 'ready-remediation' | 'conflict-resolution';

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
  stage: ReadyRemediationStage;
  launchHead: string;
}

export interface ReadyRemediationDisposition {
  kind: ReadyRemediationDispositionKind;
  /** Short and greppable, e.g. `agent-idle-after-launch`. */
  reason: string;
  remediation: ReadyRemediationKind | null;
  launchHead: string | null;
  currentHead: string | null;
  /** The remediation launch's session-ownership time; null when none was recorded. */
  launchedAt: string | null;
}

/** The task-progress fields the shared decision reads. */
export type ReadyRemediationProgress = StageAgentProgress;

type ReadyResultView = Pick<StageResult, 'status' | 'startedAt' | 'artifacts'>;

const CONFLICT_REMEDIATION_MARKER = '.conflict-remediation.json';

const REMEDIATION_STAGE: Record<ReadyRemediationKind, ReadyRemediationStage> = {
  ci: 'ready-remediation',
  conflict: 'conflict-resolution',
};

// Only `readKey` is used; the attempt ceiling belongs to the launch sites.
const readyRemediationBucket = createStateDirRetry('ready-remediation', { maxAttempts: 1 });

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Which remediation a running Ready record describes. Same predicate as the
 * monitor's `conflict_remediation_awaiting_ready`: the running record the
 * resolver launch wrote carries `mergeConflict: CONFLICTED`.
 */
function remediationKind(readyResult: Pick<StageResult, 'artifacts'> | null): ReadyRemediationKind {
  const mergeConflict = (readyResult?.artifacts as { mergeConflict?: unknown } | undefined)?.mergeConflict;
  return mergeConflict === 'CONFLICTED' ? 'conflict' : 'ci';
}

function conflictLaunchHead(stateDir: string): string | null {
  const marker = readMarker({ path: join(stateDir, CONFLICT_REMEDIATION_MARKER), kind: 'conflict-remediation' });
  if (marker.status !== 'present') return null;
  return nonEmpty(marker.payload.detail?.launchHead) ?? nonEmpty(marker.payload.headSha);
}

/**
 * The one reader of Ready remediation launch identity. Returns null when Ready
 * is not running or nothing was launched.
 *
 * - Conflict: the condition-keyed marker is still present; the reconciler
 *   expires it once the head moves.
 * - CI: the `ready-remediation` bucket head.
 */
export function readReadyRemediationLaunch(
  stateDir: string,
  readyResult: ReadyResultView | null,
): ReadyRemediationLaunch | null {
  if (readyResult?.status !== 'running') return null;
  const remediation = remediationKind(readyResult);

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
  return { remediation, stage: REMEDIATION_STAGE[remediation], launchHead };
}

export interface EvaluateReadyRemediationDispositionOptions {
  stateDir: string;
  readyResult: ReadyResultView | null;
  currentHead: string | null;
  /** Called only when liveness decides the outcome (same-head running launch). */
  getProgress: () => ReadyRemediationProgress | null;
}

/**
 * Read Ready's launch identity and decide through the shared stage-agent
 * disposition. Progress is gathered lazily by the shared module: only a
 * running launch at the current head needs liveness, so the monitor's hot pass
 * never probes the pane for an inactive or advanced task.
 */
export function evaluateReadyRemediationDisposition(
  opts: EvaluateReadyRemediationDispositionOptions,
): ReadyRemediationDisposition {
  const launch = readReadyRemediationLaunch(opts.stateDir, opts.readyResult);
  if (!launch) {
    return {
      kind: 'inactive',
      reason: opts.readyResult?.status === 'running' ? 'no-launch' : 'not-running',
      remediation: null,
      launchHead: null,
      currentHead: opts.currentHead,
      launchedAt: null,
    };
  }
  const disposition = evaluateStageAgentDisposition({
    stateDir: opts.stateDir,
    stage: launch.stage,
    stageResult: opts.readyResult,
    currentHead: opts.currentHead,
    launchHead: launch.launchHead,
    getProgress: opts.getProgress,
  });
  return readyDispositionFromStage(disposition, launch, opts.currentHead);
}

/**
 * Map the shared stage-agent disposition onto Ready's action contract. Pure;
 * the fixture table runs through it.
 *
 * The one Ready-specific rule: a remediation agent parked at a recognised
 * blocking prompt keeps the head (`in-flight`). The shared decision calls it
 * `settled` because its actor escalates once and keeps the stage alive
 * (`_stage_disposition_act` rc 2); Ready's `settled` action is "re-run Ready",
 * which would relaunch remediation behind an agent waiting on a menu choice
 * (HOK-3322). The reason keeps the prompt id.
 */
export function readyDispositionFromStage(
  disposition: Pick<StageAgentDisposition, 'kind' | 'reason' | 'blockingPrompt' | 'launch'>,
  launch: ReadyRemediationLaunch,
  currentHead: string | null,
): ReadyRemediationDisposition {
  const parkedAtPrompt = disposition.kind === 'settled' && disposition.blockingPrompt !== null;
  return {
    kind: parkedAtPrompt ? 'in-flight' : disposition.kind,
    reason: disposition.reason,
    remediation: launch.remediation,
    launchHead: launch.launchHead,
    currentHead,
    launchedAt: disposition.launch.launchedAt,
  };
}

export interface GatherReadyTaskProgressOptions {
  issue: string;
  session: string;
  worktree: string;
  /** The ready state dir (`<worktree>/features/<slug>`). */
  stateDir: string;
  task?: Pick<TaskRecord, 'updated' | 'branch' | 'slug' | 'worktree' | 'status' | 'phase' | 'lifecycle'>;
  readyResult: Pick<StageResult, 'startedAt' | 'finishedAt' | 'artifacts'> | null;
  /** Pane target for the blocking-prompt matcher and background-work probe. */
  paneText?: string;
  panePid?: number | null;
  now?: Date;
}

/**
 * Compose the task-progress primitive for a Ready task through the shared
 * stage-agent gatherer, as the remediation sub-stage the ready record
 * describes. The monitor CLI and the watchdog both gather through here, so
 * they decide on identical evidence.
 */
export function gatherReadyTaskProgress(opts: GatherReadyTaskProgressOptions): TaskProgress {
  return gatherStageTaskProgress({
    issue: opts.issue,
    session: opts.session,
    worktree: opts.worktree,
    stateDir: opts.stateDir,
    stage: REMEDIATION_STAGE[remediationKind(opts.readyResult)],
    task: opts.task,
    stageResult: opts.readyResult,
    paneText: opts.paneText,
    panePid: opts.panePid,
    now: opts.now,
  });
}
