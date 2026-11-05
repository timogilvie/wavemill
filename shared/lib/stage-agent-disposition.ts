/**
 * HOK-3386 — the one stage-agent in-flight/settled decision.
 *
 * Before this module, "is this stage's agent still working, or has it settled
 * without a result?" was answered differently per stage (coding:
 * `coding_stage_owner_lost` / `coding_stage_stalled`; Ready remediation:
 * `evaluateReadyRemediationDisposition`; planning and review: nothing). The
 * 2026-11-02 incident (three Codex review stages that stopped 1.5–2h without
 * the mill noticing) proved the gap: a running `.review-result.json` is a
 * fact about the launch, not liveness.
 *
 * This module generalises the Ready disposition into a decision every agent
 * stage reads:
 *
 *   - {@link readStageAgentLaunch} resolves launch identity from the
 *     per-stage `session-ownership` row (HOK-3328). Ready wraps this to layer
 *     the conflict-remediation marker's `launchHead` on top.
 *   - {@link decideStageAgentDisposition} is pure. Liveness comes only from
 *     the shared task-progress primitive (HOK-3101), including the HOK-3386
 *     owned-session transcript source.
 *
 * The decision is in-flight when the agent is still working (hook, owned
 * transcript, native stream, blocking prompt, background work, operator
 * approval wait); settled when the agent's own idle/error record has landed,
 * when the process exited, when the stall threshold has elapsed, or when a
 * recognised blocking prompt is present (the caller escalates once, it never
 * holds). `inactive` means no stage is running; `advanced` means the launch
 * head is behind the current head (CI-remediation case).
 *
 * `evidenceConfidence` is the HOK-3277 input: `high` for a direct observation
 * (agent record / owned-session idle / process exit / stalled), `low` for a
 * legitimate wait (approval, background work, blocking prompt), `unknown`
 * when the probe did not run or no stage launched.
 *
 * Enforced by `tools/check-ready-remediation-disposition.ts` (extended, not
 * replaced). Ready remediation decides here too: the Ready module
 * (`ready-remediation-disposition.ts`) only reads Ready's launch identity
 * (sub-stage and launch head) and maps the result onto Ready's actions.
 *
 * @module stage-agent-disposition
 */

import { basename, join } from 'node:path';
import { statSync } from 'node:fs';
import { readOwnershipRows, type OwnershipKind, type OwnershipStage } from './session-ownership.ts';
import { resolveTaskArtifact } from './task-artifact-lookup.ts';
import {
  getTaskProgress,
  type BlockingPrompt,
  type HookState,
  type ProgressSource,
  type StageAgentStage,
  type TaskProgress,
} from './task-progress.ts';
import { getResultFilePath, type StageName, type StageResult } from './stage-result.ts';
import type { TaskRecord } from './workflow-state.ts';

export type { StageAgentStage };

export type StageAgentDispositionKind = 'inactive' | 'advanced' | 'in-flight' | 'settled';

export type StageAgentEvidenceConfidence = 'high' | 'low' | 'unknown';

export type StageAgentWaitingOn =
  | { kind: 'operator'; detail?: string }
  | { kind: 'background'; detail?: string }
  | { kind: 'approval'; detail?: string };

export interface StageAgentLaunch {
  sessionRef: string;
  harness: 'claude-code' | 'codex' | 'native';
  launchedAt: string;
  attemptId: string;
  kind: OwnershipKind;
  stage?: OwnershipStage;
}

export interface StageAgentDisposition {
  kind: StageAgentDispositionKind;
  reason: string;
  stage: StageAgentStage;
  stageStatus: string | null;
  hasCompletionArtifact: boolean;
  hasResultVerdict: boolean;
  blockingPrompt: BlockingPrompt | null;
  waitingOn: StageAgentWaitingOn | null;
  evidenceConfidence: StageAgentEvidenceConfidence;
  launch: {
    launchedAt: string | null;
    attemptId: string | null;
    sessionRef: string | null;
    headSha: string | null;
    harness: 'claude-code' | 'codex' | 'native' | null;
  };
  currentHead: string | null;
}

export type StageAgentProgress = Pick<
  TaskProgress,
  | 'agentRecord'
  | 'agentState'
  | 'agentIdle'
  | 'agentProcessLive'
  | 'agentBackgroundLive'
  | 'blockingPrompt'
  | 'stalled'
  | 'ownedSessionIdleAt'
  | 'terminal'
>;

export interface StageAgentDispositionInput {
  stage: StageAgentStage;
  stageStatus: string | null;
  /** Completion marker present (e.g. `.coding-complete`) OR terminal status. */
  hasCompletionArtifact: boolean;
  /** Stage-result verdict present (status != `running` and non-null). */
  hasResultVerdict: boolean;
  launch: StageAgentLaunch | null;
  currentHead: string | null;
  launchHead: string | null;
  progress: StageAgentProgress | null;
}

const LIVE_AGENT_STATES: ReadonlySet<HookState> = new Set<HookState>([
  'working',
  'waiting',
  'approval-needed',
  'blocked',
  'policy-denied',
]);

const SETTLED_AGENT_STATES: ReadonlySet<HookState> = new Set<HookState>(['idle', 'error']);

const STAGE_TO_KINDS: Record<StageAgentStage, readonly OwnershipKind[]> = {
  planning: ['planning'],
  coding: ['coding'],
  review: ['review'],
  'ready-remediation': ['ready-remediation'],
  'conflict-resolution': ['conflict-resolution'],
};

function isoToEpochSeconds(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function isoToMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Newest `launch` session-ownership row for this stage. Returns null when no
 * such row exists (the launch happened outside the recorded path, or the
 * stage has not run yet).
 */
export function readStageAgentLaunch(stateDir: string, stage: StageAgentStage): StageAgentLaunch | null {
  const kinds = new Set<OwnershipKind>(STAGE_TO_KINDS[stage]);
  let bestMs = -Infinity;
  let best: StageAgentLaunch | null = null;
  for (const row of readOwnershipRows(stateDir)) {
    if (!kinds.has(row.kind)) continue;
    const ms = Date.parse(row.launchedAt);
    if (!Number.isFinite(ms) || ms <= bestMs) continue;
    bestMs = ms;
    best = {
      sessionRef: row.sessionRef,
      harness: row.harness,
      launchedAt: row.launchedAt,
      attemptId: row.attemptId,
      kind: row.kind,
      ...(row.stage ? { stage: row.stage } : {}),
    };
  }
  return best;
}

function waitingFromAgentState(state: HookState | null): StageAgentWaitingOn | null {
  switch (state) {
    case 'approval-needed':
      return { kind: 'approval', detail: 'approval-needed' };
    case 'waiting':
      return { kind: 'operator', detail: 'waiting' };
    case 'blocked':
      return { kind: 'operator', detail: 'blocked' };
    case 'policy-denied':
      return { kind: 'operator', detail: 'policy-denied' };
    default:
      return null;
  }
}

/**
 * Pure decision. Rules, in order (mirrors the Ready disposition, with the
 * three HOK-3386 additions marked):
 *
 * 1. Stage not running → `inactive` (`not-running`).
 * 2. HOK-3386: an explicit approval status is `inactive` (`awaiting-approval`);
 *    the workflow-state approval gate owns it.
 * 3. No launch row → `inactive` (`no-launch`) when nothing was ever
 *    recorded; else `in-flight` with `evidenceConfidence: 'unknown'`
 *    (`progress-unavailable`) to hold the arm.
 * 4. Launch head present + current head known + they differ → `advanced`
 *    (`head-moved`). CI remediation mostly.
 * 5. Probe failed → `in-flight` (`progress-unavailable`, unknown evidence).
 * 6. HOK-3386: the task's own PR/lifecycle evidence is already terminal
 *    (merged/closed/aborted) → `inactive` (`task-terminal`, high confidence).
 *    A stage whose status lags the task's true outcome is never acted on.
 * 7. HOK-3386: `blockingPrompt` → `settled` (`blocking-prompt:<id>`). The
 *    caller escalates once; it does NOT hold.
 * 8. Background live → `in-flight` (`background-work`, low confidence).
 * 9. Agent record at/after launch:
 *    - live state → `in-flight` (`agent-<state>`); fresh `waiting`/
 *      `approval-needed` carry a `waitingOn`.
 *    - settled state → `settled` (`agent-<state>-after-launch`, high).
 * 10. HOK-3386: owned-session idle (agent's own transcript stop event) at/
 *    after launch → `settled` (`agent-idle-after-launch`, high).
 * 11. Process exited → `settled` (`agent-exited`, high).
 * 12. Stalled → `settled` (`agent-stalled`, high).
 * 13. Else → `in-flight` (`awaiting-agent-evidence`, unknown).
 */
export function decideStageAgentDisposition(input: StageAgentDispositionInput): StageAgentDisposition {
  const base = {
    stage: input.stage,
    stageStatus: input.stageStatus,
    hasCompletionArtifact: input.hasCompletionArtifact,
    hasResultVerdict: input.hasResultVerdict,
    blockingPrompt: input.progress?.blockingPrompt ?? null,
    launch: {
      launchedAt: input.launch?.launchedAt ?? null,
      attemptId: input.launch?.attemptId ?? null,
      sessionRef: input.launch?.sessionRef ?? null,
      headSha: input.launchHead,
      harness: input.launch?.harness ?? null,
    },
    currentHead: input.currentHead,
  };
  const result = (
    kind: StageAgentDispositionKind,
    reason: string,
    extra: Partial<StageAgentDisposition> = {},
  ): StageAgentDisposition => ({
    ...base,
    kind,
    reason,
    waitingOn: null,
    evidenceConfidence: 'unknown',
    ...extra,
  });

  if (input.stageStatus === 'awaiting_user') {
    return result('inactive', 'awaiting-approval', {
      waitingOn: { kind: 'approval', detail: 'awaiting_user' },
      evidenceConfidence: 'low',
    });
  }
  if (input.stageStatus !== 'running') return result('inactive', 'not-running');

  if (!input.launch) {
    return result('inactive', 'no-launch');
  }

  if (input.launchHead && input.currentHead && input.launchHead !== input.currentHead) {
    return result('advanced', 'head-moved', { evidenceConfidence: 'high' });
  }

  if (!input.progress) {
    return result('in-flight', 'progress-unavailable');
  }

  if (input.progress.terminal) {
    return result('inactive', 'task-terminal', { evidenceConfidence: 'high' });
  }

  const prompt = input.progress.blockingPrompt;
  if (prompt) {
    return result('settled', `blocking-prompt:${prompt.id}`, {
      waitingOn: { kind: 'operator', detail: prompt.detail },
      evidenceConfidence: 'low',
    });
  }

  if (input.progress.agentBackgroundLive === true) {
    return result('in-flight', 'background-work', {
      waitingOn: { kind: 'background' },
      evidenceConfidence: 'low',
    });
  }

  const record = input.progress.agentRecord;
  const launchedEpoch = isoToEpochSeconds(input.launch.launchedAt);
  if (record?.state && launchedEpoch !== null && record.timestamp >= launchedEpoch) {
    if (LIVE_AGENT_STATES.has(record.state)) {
      return result('in-flight', `agent-${record.state}`, {
        waitingOn: waitingFromAgentState(record.state),
        evidenceConfidence: record.state === 'working' ? 'high' : 'low',
      });
    }
    if (SETTLED_AGENT_STATES.has(record.state)) {
      return result('settled', `agent-${record.state}-after-launch`, { evidenceConfidence: 'high' });
    }
  }

  // HOK-3386: an owned-session stop event (Codex task_complete, Claude Code
  // stop_hook_summary) at/after launch is an agent idle record. This is the
  // path a Codex interactive stage reaches — it has no hook adapter, so the
  // agent's own rollout is the only agent evidence.
  const ownedIdleMs = isoToMs(input.progress.ownedSessionIdleAt ?? null);
  const launchMs = isoToMs(input.launch.launchedAt);
  if (ownedIdleMs !== null && (launchMs === null || ownedIdleMs >= launchMs)) {
    return result('settled', 'agent-idle-after-launch', { evidenceConfidence: 'high' });
  }

  if (input.progress.agentProcessLive === false) {
    return result('settled', 'agent-exited', { evidenceConfidence: 'high' });
  }

  if (input.progress.stalled) {
    return result('settled', 'agent-stalled', { evidenceConfidence: 'high' });
  }

  return result('in-flight', 'awaiting-agent-evidence');
}

// ── Side-effectful entry point (reads the result + composes the progress) ──

export interface EvaluateStageAgentDispositionOptions {
  stateDir: string;
  stage: StageAgentStage;
  stageResult: Pick<StageResult, 'status' | 'startedAt' | 'artifacts'> | null;
  currentHead: string | null;
  /** Launch head from the caller's launch reader (Ready wraps this). */
  launchHead?: string | null;
  /** Called only when liveness decides the outcome. */
  getProgress: () => StageAgentProgress | null;
  /** The feature dir completion marker; defaults to `<stateDir>/.<stage>-complete`. */
  completionMarkerPath?: string;
}

/**
 * Candidate completion-artifact paths for a stage, in no particular order —
 * any one existing means the agent produced its output and settling is a
 * legitimate handoff, not an abandonment.
 *
 * Planning's agent-produced artifact is `plan.md`, not `.plan-approved`
 * (approval is a later HUMAN action, not agent evidence): checking only
 * `.plan-approved` here raced the monitor's own plan.md → `awaiting_user`
 * transition (same tick, but file existence is cheaper and unconditional),
 * so a planning agent that wrote plan.md and exited — the normal, expected
 * handoff to a human — could be declared `agent-exited` with no result and
 * sent through the stage-failure relaunch path before the monitor's own
 * reconciliation ever ran.
 */
function completionMarkerPathsForStage(stateDir: string, stage: StageAgentStage): string[] {
  switch (stage) {
    case 'planning':
      return [join(stateDir, 'plan.md'), join(stateDir, '.plan-approved')];
    case 'coding':
      return [join(stateDir, '.coding-complete')];
    case 'review':
      return [join(stateDir, '.review-complete')];
    default:
      return [join(stateDir, `.${stage}-complete`)];
  }
}

function stageHasCompletionArtifact(
  stateDir: string,
  stage: StageAgentStage,
  stageResult: Pick<StageResult, 'status'> | null,
  markerPath?: string,
): boolean {
  const candidates = markerPath ? [markerPath] : completionMarkerPathsForStage(stateDir, stage);
  for (const candidate of candidates) {
    try {
      statSync(candidate);
      return true;
    } catch {
      // Not present; try the next candidate.
    }
  }
  const terminalStatuses = new Set(['completed', 'failed', 'aborted', 'awaiting_user']);
  return !!stageResult?.status && terminalStatuses.has(stageResult.status);
}

function stageHasResultVerdict(stageResult: Pick<StageResult, 'status'> | null): boolean {
  if (!stageResult?.status) return false;
  return stageResult.status !== 'running';
}

/**
 * Compose: read launch identity, decide. Progress is gathered lazily — only a
 * same-head running launch needs liveness. A throwing probe is a failed probe
 * (`progress-unavailable`).
 */
export function evaluateStageAgentDisposition(
  opts: EvaluateStageAgentDispositionOptions,
): StageAgentDisposition {
  const launch = readStageAgentLaunch(opts.stateDir, opts.stage);
  const stageStatus = opts.stageResult?.status ?? null;
  const hasCompletionArtifact = stageHasCompletionArtifact(opts.stateDir, opts.stage, opts.stageResult, opts.completionMarkerPath);
  const hasResultVerdict = stageHasResultVerdict(opts.stageResult);
  const launchHead = opts.launchHead ?? null;

  const input: StageAgentDispositionInput = {
    stage: opts.stage,
    stageStatus,
    hasCompletionArtifact,
    hasResultVerdict,
    launch,
    currentHead: opts.currentHead,
    launchHead,
    progress: null,
  };
  const withoutProgress = decideStageAgentDisposition(input);
  if (withoutProgress.reason !== 'progress-unavailable') return withoutProgress;
  try {
    return decideStageAgentDisposition({ ...input, progress: opts.getProgress() });
  } catch {
    return withoutProgress;
  }
}

// ── Progress gatherer for agent stages (Ready's gatherReadyTaskProgress delegates here) ──

export interface GatherStageTaskProgressOptions {
  issue: string;
  session: string;
  worktree: string;
  stateDir: string;
  stage: StageAgentStage;
  task?: Pick<TaskRecord, 'updated' | 'branch' | 'slug' | 'worktree' | 'status' | 'phase' | 'lifecycle'>;
  stageResult: Pick<StageResult, 'startedAt' | 'finishedAt'> | null;
  paneText?: string;
  panePid?: number | null;
  now?: Date;
}

function stageResultArtifactName(stage: StageAgentStage): string | null {
  switch (stage) {
    case 'planning':
    case 'coding':
    case 'review':
      return basename(getResultFilePath('', stage as StageName));
    default:
      return null;
  }
}

function fileMtimeIso(file: string): string | null {
  try {
    return statSync(file).mtime.toISOString();
  } catch {
    return null;
  }
}

/**
 * Compose task-progress for an agent stage. The stage result's
 * start/finish/mtime are transitions (HOK-3422 retires those), and the
 * HOK-3386 owned-session probe is wired through `stageForOwnedSession`.
 */
export function gatherStageTaskProgress(opts: GatherStageTaskProgressOptions): TaskProgress {
  const transitions: ProgressSource[] = [];
  if (opts.stageResult?.startedAt) {
    transitions.push({ kind: 'transition', at: opts.stageResult.startedAt, detail: `${opts.stage}.startedAt` });
  }
  if (opts.stageResult?.finishedAt) {
    transitions.push({ kind: 'transition', at: opts.stageResult.finishedAt, detail: `${opts.stage}.finishedAt` });
  }
  const artifactName = stageResultArtifactName(opts.stage);
  if (artifactName) {
    const resolved = resolveTaskArtifact({
      issueId: opts.issue,
      slug: opts.task?.slug ?? basename(opts.stateDir),
      artifactName,
      worktreeDir: opts.worktree,
    });
    if (resolved) {
      const mtime = fileMtimeIso(resolved.path);
      if (mtime) transitions.push({ kind: 'transition', at: mtime, detail: `${opts.stage}-result.mtime` });
    }
  }

  return getTaskProgress({
    issue: opts.issue,
    session: opts.session,
    task: opts.task,
    worktree: opts.worktree,
    featureDir: opts.stateDir,
    phase: opts.stage === 'planning' || opts.stage === 'coding' || opts.stage === 'review' ? opts.stage : 'ready',
    stageForOwnedSession: opts.stage,
    ownershipStateDir: opts.stateDir,
    extraTransitionSources: transitions,
    paneText: opts.paneText,
    panePid: opts.panePid,
    now: opts.now,
  });
}
