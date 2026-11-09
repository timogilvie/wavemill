/**
 * HOK-3101 — one task-progress/liveness evidence primitive shared by observer,
 * monitor stage-owner, ready-watchdog, reconciler pane release, and dashboard.
 *
 * A dozen decision sites each inferred "is this task alive or stalled" from
 * whichever signal was closest at hand. That created four families of bugs:
 *   (a) an idle agent REPL counted as a live process;
 *   (b) the monitor's own polling subprocesses counted as the task;
 *   (c) FIXED (HOK-3422): `task.updated` and stage-result `startedAt` /
 *       `finishedAt` / mtimes are controller writes. They no longer contribute
 *       to `lastProgressAt` or `stalled`; the controller-move time is now a
 *       separate derived `lastTransitionAt` on `TaskProgress` that readers
 *       consume when they want "when did the controller last move this task"
 *       (reliability metrics, dashboard, ready watchdog).
 *   (d) a monitor-written hook overwrote the agent's own record.
 *
 * This module builds one primitive that turns raw evidence into
 * `TaskProgress` — `lastProgressAt`, an ordered `sources[]`, the agent's own
 * `agentState`, `agentIdle`, `terminal`, `terminalIdle`, `stalled`, an optional
 * `blockingPrompt`, plus a rough `agentProcessLive` fact that is NEVER a
 * source of progress.
 *
 * HOK-3426: `agentExited` is the ONE "the launched stage agent exited" fact —
 * derived from a RECORDED exit: a HOK-3359 controller-termination record, the
 * launcher's `agent-exit` record (the launcher is the agent process's parent
 * and the only surface that sees a hard-killed agent's exit), or the
 * launch-recorded window slot reporting dead (`term_is_dead`) — never from
 * `agentProcessLive`. Stage dispositions settle on it; the descendant count
 * remains only the HOK-3374 background-work input and a diagnostic.
 * `terminalIdle` keeps its existing pane-count fast path and is not an exit
 * decision.
 *
 * Design invariants pinned by the tests:
 *   1. Pane or process existence is never progress.
 *   2. Monitor or controller writes are never agent evidence. In particular,
 *      stage-result `startedAt` / `finishedAt` / `updated` and `task.updated`
 *      are controller timestamps (HOK-3422): they feed only `lastTransitionAt`,
 *      never `lastProgressAt` or `stalled`.
 *   3. An agent's own idle/Stop survives later monitor writes; it is revoked
 *      only by a later agent work event.
 *
 * Stall-clock anchor (HOK-3422): `stalled` fires when `(now − anchor) >
 * stallMinutes`, where `anchor = lastProgressAt ?? launchAt`. The launch
 * anchor is the stage's session-ownership `launchedAt` (HOK-3328) when
 * supplied through `launchAtOverride`, else the stage-result `startedAt`. A
 * controller-owned wait (no agent was ever launched — e.g. a Ready CI wait
 * with no remediation launch row) has no anchor, so `stalled` is always false.
 *
 * A fourth, orthogonal category (HOK-3359): the one stage-agent teardown
 * (`shared/lib/stage-teardown.sh` `stage_agent_teardown`) records that the
 * CONTROLLER ended an agent as a `writer=controller, kind=controller-
 * termination` entry in `.terminal-history.jsonl`. This is an EXIT FACT —
 * neither progress (it never becomes `lastProgressAt` or a `sources[]`
 * entry, so invariant 1 holds) nor the monitor-write-as-evidence invariant 2
 * is bent (it is a distinct writer, `controller`, not `monitor`): it only
 * makes `agentIdle` true via `readTerminalHistoryIdleAt`, so a controller-
 * killed agent is reported exited rather than stuck at its last `working`
 * hook state.
 *
 * The implementation is split so tests can target the pure decision:
 *   - `deriveTaskProgress(inputs, opts)` is pure.
 *   - `gatherTaskProgressInputs(gatherOpts)` does IO (hook, history, git, stat).
 *   - `getTaskProgress(opts)` composes both.
 *
 * The shell CLI (`tools/task-progress.ts`) is a thin wrapper over
 * `getTaskProgress`; the shell entry point (`shared/lib/task-progress.sh`)
 * spawns it and caches per-task JSON, so the dashboard's 2s refresh never
 * spawns tsx.
 *
 * @module task-progress
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  isPendingSessionRef,
  readOwnershipRows,
  type OwnershipKind,
  type OwnershipStage,
  type SessionOwnershipRow,
} from './session-ownership.ts';
import { codexSessionsRoot, resolveCodexLaunchNonces } from './codex-rollout-resolver.ts';
import { resolveProjectsDirs } from './wavemill-session-paths.ts';
import { termIsDead } from './terminal-backend.ts';
import type { TaskRecord } from './workflow-state.ts';

// ── Hook contract ────────────────────────────────────────────────────────────

/** Hook TTL used by the "current state" reader. Progress is untimed. */
export const HOOK_TTL_SECONDS = 300;

/**
 * Recognized hook states. Unknown states are silently dropped by
 * `wavemill_hook_write`, so a well-formed hook file always contains one of
 * these or nothing at all.
 */
export type HookState =
  | 'working'
  | 'idle'
  | 'waiting'
  | 'blocked'
  | 'approval-needed'
  | 'policy-denied'
  | 'error';

/** Hook writer identity (HOK-3101). Legacy hooks have no writer field. */
export type HookWriter = 'agent' | 'monitor';

/** Compact snapshot of one hook record (either top-level or preserved). */
export interface HookRecord {
  state: HookState | null;
  event: string;
  detail?: string;
  agent: string;
  timestamp: number;
}

/** Read-only view of the raw hook file JSON, tolerant of missing fields. */
export interface HookFile {
  /** Top-level state (whoever wrote the hook last). */
  top: HookRecord | null;
  /** Top-level writer, or 'agent' for legacy hooks whose event is not a controller event. */
  writer: HookWriter;
  /** Preserved last-agent record, if any (from `.agentRecord` or a legacy agent write). */
  agentRecord: HookRecord | null;
  /** Wall-clock epoch of the top record, used for TTL freshness. */
  topTimestamp: number;
  /** Optional `next_action` hint written by controllers. */
  nextAction?: string;
}

/**
 * Controller events (HOK-3101). Any hook whose event is one of these is
 * treated as a controller write even when the `writer` field is absent
 * (legacy hooks written before this primitive shipped).
 *
 * IMPORTANT: keep in sync with:
 *   - shared/hooks/wavemill-hook-protocol.sh
 *   - shared/lib/task-progress.sh
 * The shell parity test in tests/task-progress.test.sh pins all three lists.
 */
export const CONTROLLER_HOOK_EVENTS: ReadonlySet<string> = new Set([
  'pr_merged',
  'pr_closed_unmerged',
  'operator_abort',
  'recovery_failure',
  'review_complete',
  'ready_complete',
  'pr_opened',
  'blocked_completion_liveness',
  'premature_plan_approval',
  'recovery_contract_unavailable',
  'planning_rejection_notify_failed',
  'NoPR',
  'worktree-setup',
  'challenge_resolved_winner',
  'challenge_invalid',
  'challenge_no_comparison',
  'challenge_stale_evidence',
  'challenge_pair_recovery',
]);

// ── Progress sources ─────────────────────────────────────────────────────────

export type ProgressSourceKind =
  | 'hook'        // Latest agent-written hook record (any state except idle).
  | 'commit'      // Newest task-branch commit after launch.
  | 'worktree'    // Newest mtime among tracked/untracked worktree paths.
  | 'status-file' // Status-file mtime after launch + 5s.
  | 'native-session' // Newest agent-issued native session-stream event (HOK-3381).
  | 'owned-session'  // Newest agent-issued event in the owned harness transcript (HOK-3386).
  | 'terminal';   // Merged/closed PR or terminal lifecycle evidence.

export interface ProgressSource {
  kind: ProgressSourceKind;
  /** ISO timestamp of the evidence. */
  at: string;
  /** Short human-readable detail, safe for logs. */
  detail?: string;
}

/**
 * HOK-3422: a controller-authored transition timestamp (stage `startedAt` /
 * `finishedAt` / `updated`, `task.updated`, caller-supplied extras). Readers
 * that want "when did the controller last move this task" consume
 * {@link TaskProgress.lastTransitionAt}. It is NEVER a progress source and
 * never contributes to `lastProgressAt` / `stalled` (invariant 2).
 */
export interface TransitionInput {
  /** ISO timestamp of the controller-authored move. */
  at: string;
  /** Short human-readable detail, safe for logs. */
  detail?: string;
}

export interface BlockingPrompt {
  id: string;
  agent: 'codex' | 'claude' | 'generic';
  detail: string;
}

/**
 * HOK-3426: which recorded surface answered "the launched stage agent exited".
 * - `controller-termination` — a HOK-3359 `stage_agent_teardown` record.
 * - `launcher` — the launcher's `agent-exit` record (the agent process's
 *   parent observed its exit status: the only surface that sees a hard-killed
 *   agent, whose harness never writes an idle hook).
 * - `terminal-backend` — `term_is_dead` on the launch-recorded window slot
 *   (the whole slot exited).
 */
export type AgentExitedSource = 'terminal-backend' | 'controller-termination' | 'launcher';

/**
 * HOK-3426: the one "this stage's agent has exited" fact. It is derived from a
 * RECORDED exit (controller termination, the launcher's own observation, or the
 * launch-recorded slot reporting dead) — never from a pane descendant count. A
 * stage settles on this fact; `agentProcessLive` is only a
 * background-work/diagnostic input.
 */
export interface AgentExitedFact {
  /** ISO timestamp of the recorded exit (gather time for `terminal-backend`). */
  at: string;
  source: AgentExitedSource;
}

/**
 * The result of one task-progress computation. `stalled` is the primary
 * "attention needed" signal; it is intentionally the only decision the
 * observer / monitor / dashboard need to consume.
 */
export interface TaskProgress {
  issue: string;
  computedAt: string;
  lastProgressAt: string | null;
  progressAgeMinutes: number | null;
  sources: ProgressSource[];
  /**
   * HOK-3422: newest ISO among controller-authored transition timestamps
   * (stage `startedAt` / `finishedAt` / `updated`, `task.updated`, caller
   * extras). Separate from `lastProgressAt`: readers that want "when did the
   * controller last move this task" (reliability metrics, dashboard, ready
   * watchdog) consume this field. NEVER feeds `stalled`.
   */
  lastTransitionAt: string | null;
  agentState: HookState | null;
  agentRecord: HookRecord | null;
  controllerState: HookState | null;
  agentIdle: boolean;
  terminal: boolean;
  terminalIdle: boolean;
  /** Non-progress liveness fact. `null` means "not probed". */
  agentProcessLive: boolean | null;
  /**
   * HOK-3426: the one "the launched stage agent has exited" fact, or `null`
   * when no exit was recorded. Derived from the launcher's `agent-exit`
   * record, the launch-recorded window slot (`term_is_dead`), or a HOK-3359
   * controller-termination record — NEVER from the pane descendant count
   * (`agentProcessLive`). This is what a stage disposition settles on.
   */
  agentExited: AgentExitedFact | null;
  /**
   * HOK-3137: whether a live descendant of the agent process that started
   * after it (a background task) was found in the agent's subtree.
   * `null` means "not probed" (no `panePid` was supplied). NEVER a progress
   * source (invariant 1) — it only suppresses `stalled` while the agent is
   * idle.
   */
  agentBackgroundLive: boolean | null;
  /** Bounded, log-safe evidence backing `agentBackgroundLive`. */
  backgroundProcesses: { pid: number; command: string }[];
  stalled: boolean;
  stallMinutes: number;
  blockingPrompt?: BlockingPrompt | null;
  /**
   * HOK-3386: ISO time of the agent's own terminal `task_complete` / `Stop`
   * event in its owned session transcript, when the launched stage's harness
   * wrote one. Agent evidence, invariant 2 is preserved (the transcript is
   * agent-written). Null when no such event was seen, or no stage is active.
   */
  ownedSessionIdleAt?: string | null;
  /** Harness that authored the owned-session evidence, when any. */
  ownedSessionHarness?: 'claude-code' | 'codex' | null;
}

// ── Pure derivation inputs ───────────────────────────────────────────────────

export interface TaskProgressGatherOptions {
  issue: string;
  session?: string;
  /** Task record from workflow-state.json (only the fields read here). */
  task?: Pick<TaskRecord, 'updated' | 'branch' | 'slug' | 'worktree' | 'status' | 'phase' | 'lifecycle' | 'windowId'>;
  worktree?: string;
  featureDir?: string;
  /**
   * Active phase name; when set, `<featureDir>/.<phase>-result.json` is
   * used as the launch anchor for the commit / status-file / transition
   * sources, and the coding-launch anchor for `status-file`.
   */
  phase?: string;
  /**
   * HOK-3422: extra caller-supplied controller-authored timestamps (e.g. the
   * stage-result mtime). Feed {@link TaskProgress.lastTransitionAt} only —
   * never `lastProgressAt` / `stalled` (invariant 2: controller writes are
   * never agent evidence).
   */
  extraTransitionInputs?: TransitionInput[];
  /**
   * HOK-3422: optional override for the derived `launchAt` input. When
   * supplied, replaces the stage-result's `startedAt` as the stall-clock
   * anchor. Callers pass the stage's `session-ownership.launchedAt` (HOK-3328)
   * so the clock ticks from the moment the agent was launched, not from the
   * stage-result write that the controller rewrites on every tick.
   */
  launchAtOverride?: string | null;
  /** Optional pane text for the blocking-prompt matcher. */
  paneText?: string;
  /**
   * HOK-3426: the phase a controller-termination record must name to be this
   * gather's exit fact. A record for another phase is never evidence about
   * this stage (the coding pane's quarantine must not settle review). When
   * `undefined`, `phase` (if supplied) is used; a record with no recorded
   * phase always counts, because unrelated teardown paths do not stamp one.
   */
  agentExitPhase?: string | null;
  /**
   * HOK-3426: the stage's launch time (ISO). A controller-termination older
   * than the launch belongs to an earlier attempt and never settles this one.
   * `undefined` means no time filter; `null` means no agent was ever launched,
   * so no controller termination can be this stage's exit. Only a non-empty
   * ISO string arms the terminal-backend slot probe (a launch is known); the
   * HOK-3206 hot-pass callers leave this unset and never pay for the probe.
   */
  agentExitSince?: string | null;
  /** Optional pane-process liveness fact; not a progress source. */
  agentProcessLive?: boolean | null;
  /**
   * HOK-3137: optional pane root pid (the pane's shell, or the agent itself
   * when it is the pane root). When supplied, `gatherTaskProgressInputs`
   * resolves the agent pid from it structurally and probes the agent's own
   * subtree for live background work (see `collectAgentBackgroundWork`).
   * Absent → `agentBackgroundLive` is `null` ("not probed").
   */
  panePid?: number | null;
  /** HOK-3137: override for the background-work start-lag threshold (seconds). */
  backgroundWorkLagSeconds?: number;
  /** For gather IO: override the default `/tmp` hook path. */
  hookFilePath?: string;
  /** For gather IO: override the default status file path. */
  statusFilePath?: string;
  /**
   * HOK-3381: repository directory used to locate the native session stream
   * (`<repoDir>/.wavemill/runs/<session>/native-sessions/<phase>-<issue>.jsonl`).
   * Defaults to `process.cwd()`; `WAVEMILL_RUN_DIR` takes precedence, matching
   * the native launchers' transcript layout.
   */
  repoDir?: string;
  /** HOK-3381: explicit native session-stream (transcript) path override. */
  nativeSessionPath?: string;
  /**
   * HOK-3386: the stage whose owned session transcript (Claude Code / Codex)
   * should be read as agent evidence. Defaults to {@link phase} when that is a
   * canonical stage (`planning | coding | review`); callers for
   * ready-remediation / conflict-resolution pass this explicitly. `null`
   * disables the owned-session probe.
   */
  stageForOwnedSession?: 'planning' | 'coding' | 'review' | 'ready-remediation' | 'conflict-resolution' | null;
  /** HOK-3386: state directory for the session-ownership file; defaults to {@link featureDir}. */
  ownershipStateDir?: string;
}

export interface TaskProgressDeriveOptions {
  now?: Date;
  stallMinutes?: number;
}

export interface TaskProgressInputs {
  issue: string;
  hookFile: HookFile | null;
  /** ISO time of the archived agent idle event (Stop / process_exit / stream_end), if any. */
  terminalHistoryIdleAt: string | null;
  /** newest commit ISO time on the task branch, absolute wall clock. */
  latestCommitAt: string | null;
  /** stage launch ISO time (e.g. `.coding-result.json.startedAt`). */
  launchAt: string | null;
  /**
   * HOK-3422: true only when the caller explicitly knows no agent was ever
   * launched for this disposition (`launchAtOverride: null` — a
   * `ready-remediation` / `conflict-resolution` sub-stage with no
   * session-ownership row), as opposed to `launchAt` simply being unresolved
   * (e.g. a legacy archive replay with no recorded launch marker). Set, it
   * stops the commit/worktree/status-file/native-session/owned-session
   * filters from vacuously admitting stale evidence left over from an earlier
   * stage — there is no anchor to compare it against, so pre-existing
   * evidence must never be reported as current progress.
   */
  launchKnownAbsent?: boolean;
  /** newest mtime among tracked/untracked worktree paths, ISO. */
  worktreeMtimeAt: string | null;
  worktreeMtimePath?: string;
  /** status-file mtime, ISO. */
  statusFileMtimeAt: string | null;
  /**
   * HOK-3381: ISO time of the newest agent-issued event in the native session
   * stream. The stream is written only by the agent's own loop, so its events
   * are agent evidence (invariant 2 is preserved: the monitor never writes it).
   */
  nativeSessionLastEventAt?: string | null;
  /**
   * HOK-3386: agent evidence from the stage's owned session transcript
   * (Claude Code `.jsonl` or Codex rollout). The transcript is agent-written,
   * so its last-event time is progress and a terminal stop event is an agent
   * idle record (invariant 2 preserved). Null when the stage does not launch
   * through such a transcript, or the launch is pre-grace.
   */
  ownedSession?: {
    lastEventAtMs: number | null;
    agentIdleAtMs: number | null;
    harness: 'claude-code' | 'codex';
  } | null;
  /**
   * HOK-3422: controller-authored timestamps for the derived
   * {@link TaskProgress.lastTransitionAt}. Never contributes to `sources[]`,
   * `lastProgressAt`, or `stalled` (invariant 2).
   */
  transitionInputs: TransitionInput[];
  /** PR / lifecycle evidence for `terminal`. */
  terminal: {
    prState?: string | null;
    prNumber?: string | number | null;
    lifecycleOutcome?: string | null;
    at?: string | null;
  };
  agentProcessLive: boolean | null;
  /** HOK-3426: the one recorded exit fact, or `null` when no exit was seen. */
  agentExited: AgentExitedFact | null;
  /** HOK-3137: background-work probe result, or `null` when not probed. */
  backgroundWork: AgentBackgroundWorkResult | null;
  blockingPrompt: BlockingPrompt | null;
}

// ── Tolerant JSON reader ─────────────────────────────────────────────────────

type JsonReadResult<T> =
  | { status: 'missing' }
  | { status: 'ok'; value: T }
  | { status: 'malformed'; reason: string };

function readJsonTolerant<T = Record<string, unknown>>(filePath: string): JsonReadResult<T> {
  if (!existsSync(filePath)) return { status: 'missing' };
  try {
    const content = readFileSync(filePath, 'utf-8');
    if (!content.trim()) return { status: 'malformed', reason: 'file is empty' };
    const parsed = JSON.parse(content) as T;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { status: 'malformed', reason: 'top-level value is not an object' };
    }
    return { status: 'ok', value: parsed };
  } catch (err) {
    return { status: 'malformed', reason: err instanceof Error ? err.message : String(err) };
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stateField(value: unknown): HookState | null {
  const s = stringField(value);
  if (!s) return null;
  switch (s) {
    case 'working':
    case 'idle':
    case 'waiting':
    case 'blocked':
    case 'approval-needed':
    case 'policy-denied':
    case 'error':
      return s;
    default:
      return null;
  }
}

// ── Hook read + writer classification ────────────────────────────────────────

/**
 * Classify the writer of a hook record. Explicit `writer` field wins; then a
 * hook whose event is a known controller event is treated as monitor; a hook
 * whose event is empty and state is `working` (the recovery replay in
 * wavemill-monitor.sh:7632) is also treated as monitor. Everything else is an
 * agent write.
 */
export function isControllerHookRecord(record: {
  writer?: string;
  event?: string;
  state?: string | null;
}): boolean {
  if (record.writer === 'monitor') return true;
  if (record.writer === 'agent') return false;
  const event = record.event ?? '';
  if (event.length > 0 && CONTROLLER_HOOK_EVENTS.has(event)) return true;
  if (event.length === 0 && record.state === 'working') return true;
  return false;
}

/**
 * Extract the effective HookFile view. Missing/malformed → null; the caller
 * treats null as "no hook evidence".
 */
export function readHookFile(hookPath: string): HookFile | null {
  const result = readJsonTolerant<Record<string, unknown>>(hookPath);
  if (result.status !== 'ok') return null;
  const value = result.value;
  const topState = stateField(value.state);
  const topEvent = stringField(value.event) ?? '';
  const topAgent = stringField(value.agent) ?? '';
  const topDetail = stringField(value.detail);
  const topTs = numberField(value.timestamp) ?? 0;
  const rawWriter = stringField(value.writer);
  const top: HookRecord | null = topState !== null || topTs > 0
    ? {
        state: topState,
        event: topEvent,
        agent: topAgent,
        timestamp: topTs,
        ...(topDetail ? { detail: topDetail } : {}),
      }
    : null;
  const controller = isControllerHookRecord({
    writer: rawWriter,
    event: topEvent,
    state: topState,
  });
  const writer: HookWriter = controller ? 'monitor' : 'agent';
  const agentRecordObj = objectField(value.agentRecord);
  let agentRecord: HookRecord | null = null;
  if (agentRecordObj) {
    const s = stateField(agentRecordObj.state);
    const ts = numberField(agentRecordObj.timestamp) ?? 0;
    if (s !== null || ts > 0) {
      agentRecord = {
        state: s,
        event: stringField(agentRecordObj.event) ?? '',
        agent: stringField(agentRecordObj.agent) ?? '',
        timestamp: ts,
        ...(stringField(agentRecordObj.detail) ? { detail: stringField(agentRecordObj.detail)! } : {}),
      };
    }
  }
  // Legacy fallback: a hook without .agentRecord but whose top-level is an
  // agent write is itself the agent record.
  if (!agentRecord && !controller && top) {
    agentRecord = top;
  }
  return {
    top,
    writer,
    agentRecord,
    topTimestamp: topTs,
    nextAction: stringField(value.next_action),
  };
}

/**
 * The agent's current state — from the preserved agentRecord (fresh only,
 * TTL-bound). Monitor writes are excluded. Returns null when the agent
 * record is older than the TTL, or absent.
 */
export function selectAgentRecord(hook: HookFile | null): HookRecord | null {
  return hook?.agentRecord ?? null;
}

/**
 * True when the agent's own last hook state is a settled-idle event. The
 * archived .terminal-history.jsonl is folded in by the gather step, not here,
 * so this operates on hook evidence alone.
 */
export function agentRecordIsIdle(record: HookRecord | null): boolean {
  if (!record || record.state !== 'idle') return false;
  // Any settled idle event counts; specific event names are advisory.
  return true;
}

// ── Blocking-prompt matcher (HOK-3045 extension) ─────────────────────────────

export interface InteractivePromptSignature {
  id: string;
  agent: 'codex' | 'claude' | 'generic';
  requiredTokens: string[];
  exclusionTokens?: string[];
  choiceCount?: number;
  operatorAction: string;
}

const INTERACTIVE_PROMPT_MATCH_INPUT_LIMIT = 8_000;

/**
 * Closed catalog of interactive agent lifecycle prompts. Extend it in place
 * with new signatures; adding one requires positive and negative fixtures in
 * `task-progress.test.ts` and `observer.test.ts`.
 */
export const INTERACTIVE_PROMPT_SIGNATURES: InteractivePromptSignature[] = [
  {
    id: 'codex_model_retirement',
    agent: 'codex',
    requiredTokens: ['retires on', 'try new model', 'use existing model'],
    exclusionTokens: ['function ', 'const ', '@Test', 'describe('],
    choiceCount: 2,
    operatorAction:
      'Codex is parked at its model-retirement chooser. Inspect the task pane and pick either "Try new model" or "Use existing model"; the observer will not press keys on your behalf.',
  },
  {
    // HOK-3101 / HOK-3069: interactive codex CLI vs desktop-app daemon version
    // mismatch produces a two-choice menu including "Cannot use the background
    // server ... > 2. Cancel". #1508 landed --no-daemon in the launcher, but
    // any pre-fix or externally launched Codex can still hit it.
    id: 'codex_daemon_version_mismatch',
    agent: 'codex',
    requiredTokens: ['cannot use the background server', 'cancel'],
    exclusionTokens: ['function ', 'const ', '@Test', 'describe('],
    choiceCount: 2,
    operatorAction:
      'Codex CLI cannot talk to the background daemon (version mismatch). Cancel the menu and relaunch with --no-daemon (#1508), or upgrade the CLI to match the desktop app.',
  },
];

export function normalizeInteractivePromptText(input: string | undefined): string {
  if (!input) return '';
  const bounded = input.length > INTERACTIVE_PROMPT_MATCH_INPUT_LIMIT
    ? input.slice(-INTERACTIVE_PROMPT_MATCH_INPUT_LIMIT)
    : input;
  return bounded
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function matchInteractivePromptSignature(paneText: string | undefined): InteractivePromptSignature | undefined {
  const normalized = normalizeInteractivePromptText(paneText);
  if (!normalized) return undefined;
  for (const signature of INTERACTIVE_PROMPT_SIGNATURES) {
    const allRequiredPresent = signature.requiredTokens.every((token) =>
      normalized.includes(token.toLowerCase()),
    );
    if (!allRequiredPresent) continue;
    const hasExclusion = (signature.exclusionTokens ?? []).some((token) =>
      normalized.includes(token.toLowerCase()),
    );
    if (hasExclusion) continue;
    return signature;
  }
  return undefined;
}

// ── Controller process exclusion ────────────────────────────────────────────

/**
 * Argv patterns that identify wavemill's own controller processes. Scoped to
 * HOK-3101 invariant 2 — hook writes and process trees that are NOT under the
 * agent (tools/observer.ts pane filtering, plus the shell twin in
 * shared/lib/task-progress.sh). A match there is NEVER agent evidence.
 *
 * FORBIDDEN inside `deriveAgentBackgroundWork` (HOK-3374): background work is
 * decided by process ownership only — a descendant of the agent process that
 * started after it. When a controller-named process IS a child of the agent
 * (the agent itself ran `npx tsx tools/plan-queue.test.ts`), it is the
 * agent's work. Enforced by the AGENT_BACKGROUND_WORK_GUARD preflight guard
 * (shared/lib/agent-background-work-guard.ts, run by
 * tools/check-agent-background-work.ts).
 *
 * IMPORTANT: keep in sync with the WAVEMILL_CONTROLLER_PROCESS_REGEX in
 * shared/lib/task-progress.sh. The shell tests exercise the same fixtures
 * through both.
 */
const WAVEMILL_CONTROLLER_PROCESS_REGEX =
  /(wavemill-monitor|\/tmp\/wavemill-[^\s]*monitor|\btools\/[A-Za-z0-9_.-]+\.ts\b|\btend\.ts\b|\bobserver\.ts\b|\bready-watchdog\b|\bpr-ci-status\.ts\b|\bplan-queue\.ts\b|tmux attach -t wavemill|wavemill-hook-protocol|wavemill-common\.sh)/;

export function isWavemillControllerProcess(command: string): boolean {
  return WAVEMILL_CONTROLLER_PROCESS_REGEX.test(command);
}

// ── Background-work detection (HOK-3137) ─────────────────────────────────────
//
// An agent that launches a long-running background task (a test suite via
// `run_in_background`, `sleep 30 &`, …) writes its Stop hook and goes idle
// while that child is still running. Invariant 1 (pane/process existence is
// never progress) still holds: a live descendant never becomes a progress
// `source` or moves `lastProgressAt`. It only suppresses `stalled` while the
// agent is idle (see `deriveTaskProgress`), so `coding_stage_owner_lost` stops
// firing on a healthy agent that is waiting on its own work.
//
// The rule (HOK-3374, replacing the HOK-3222 command-name classifier): build
// the agent's process subtree from one `ps` snapshot and count a descendant
// as the agent's work iff it is a descendant of the agent process and started
// at least `minChildLagSeconds` after the agent. No command names, no
// basename checks: a descendant of the agent is the agent's work whatever it
// is named (the incident's `bash tests/run-related.sh`), and the mill's own
// processes are never descendants of the agent. The lag floor is measured
// against the AGENT's etime, so session-startup services (stdio MCP servers,
// IDE helpers) that start within seconds of the agent are excluded while a
// mid-session background task is not. If the agent itself died, its pid is
// gone from the snapshot and the answer is `live: false` — its children
// reparent away, so a genuinely abandoned agent is still owner-lost-able.

export interface PaneProcess {
  pid: number;
  ppid: number;
  /** Seconds since the process started, or null if `ps` output was unparsable. */
  etimeSeconds: number | null;
  command: string;
}

export interface AgentBackgroundWorkResult {
  live: boolean;
  /** Bounded, log-safe evidence of the agent's live background descendants. */
  processes: { pid: number; command: string }[];
}

const DEFAULT_BG_CHILD_LAG_SECONDS = 30;
const BACKGROUND_EVIDENCE_LIMIT = 5;
const BACKGROUND_COMMAND_TRUNCATE_LENGTH = 200;

/** `ps etime` shapes: `ss`, `mm:ss`, `hh:mm:ss`, `dd-hh:mm:ss`. */
function parseEtimeToSeconds(etime: string): number | null {
  const trimmed = etime.trim();
  const withDays = trimmed.match(/^(\d+)-(\d+):(\d+):(\d+)$/);
  if (withDays) {
    const [, d, h, m, s] = withDays.map(Number);
    return ((d * 24 + h) * 60 + m) * 60 + s;
  }
  const parts = trimmed.split(':');
  if (parts.length === 3 || parts.length === 2 || parts.length === 1) {
    const nums = parts.map((p) => Number(p));
    if (nums.some((n) => !Number.isFinite(n))) return null;
    return nums.reduce((acc, n) => acc * 60 + n, 0);
  }
  return null;
}

/**
 * Parse `ps -axo pid=,ppid=,etime=,command=` output. Pure; tolerant of
 * unparsable rows (skipped, never thrown).
 */
export function parsePsSnapshot(psOutput: string): PaneProcess[] {
  const result: PaneProcess[] = [];
  for (const rawLine of psOutput.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    result.push({
      pid,
      ppid,
      etimeSeconds: parseEtimeToSeconds(match[3]),
      command: match[4].trim(),
    });
  }
  return result;
}

/**
 * Pure derivation of the one background-work decision (HOK-3137, HOK-3374)
 * over one `ps` snapshot. `agentPid` is the agent's own pid — the IO wrapper
 * (`collectAgentBackgroundWork`) resolves it structurally from the pane
 * root.
 *
 * Ownership rule, and the only rule: a process is the agent's background work
 * iff it is a descendant of `agentPid` in the snapshot and started at least
 * `minChildLagSeconds` after the agent. No command names, no basename
 * checks (HOK-3222). The lag floor is measured against the agent's etime, so
 * a mid-session background task qualifies while session-startup services do
 * not. The agent itself is never its own evidence, and an agent that is
 * missing from the snapshot (dead, children reparented) is `live: false`.
 */
export function deriveAgentBackgroundWork(
  processes: PaneProcess[],
  agentPid: number,
  opts: { minChildLagSeconds?: number } = {},
): AgentBackgroundWorkResult {
  const minChildLagSeconds = opts.minChildLagSeconds ?? DEFAULT_BG_CHILD_LAG_SECONDS;

  const byPid = new Map<number, PaneProcess>();
  for (const p of processes) byPid.set(p.pid, p);
  const childrenByPpid = new Map<number, PaneProcess[]>();
  for (const p of processes) {
    const list = childrenByPpid.get(p.ppid) ?? [];
    list.push(p);
    childrenByPpid.set(p.ppid, list);
  }

  const root = byPid.get(agentPid);
  if (!root) return { live: false, processes: [] };
  const agentEtime = root.etimeSeconds;

  // One BFS over the agent's subtree (inclusive). Every descendant that
  // passes the lag floor is the agent's work — ownership decides, not names.
  const visited = new Set<number>([agentPid]);
  const queue: number[] = [agentPid];
  const evidence: { pid: number; command: string }[] = [];
  let live = false;
  while (queue.length > 0) {
    const pid = queue.shift()!;
    for (const child of childrenByPpid.get(pid) ?? []) {
      if (visited.has(child.pid)) continue;
      visited.add(child.pid);
      if (agentEtime !== null && child.etimeSeconds !== null) {
        const lagSeconds = agentEtime - child.etimeSeconds;
        if (lagSeconds >= minChildLagSeconds) {
          live = true;
          if (evidence.length < BACKGROUND_EVIDENCE_LIMIT) {
            evidence.push({ pid: child.pid, command: child.command.slice(0, BACKGROUND_COMMAND_TRUNCATE_LENGTH) });
          }
        }
      }
      queue.push(child.pid);
    }
  }

  return { live, processes: evidence };
}

/**
 * Pure: does the pane root process still have a live descendant at all (any
 * command, no lag floor)? This is the original HOK-3101/HOK-2963 fast-death
 * signal (mirrors `mill_pane_has_live_blocking_process` in
 * wavemill-common.sh): a pane whose root process is gone, or whose root
 * process has zero children, has lost its agent — any deeper descendant
 * necessarily traces through a direct child, so checking direct children is
 * sufficient. `agentProcessLive` is NEVER a progress source (invariant 1);
 * it only backstops `stalled`'s fast path when the agent process has
 * genuinely exited, instead of waiting out the full stall threshold.
 */
export function deriveAgentProcessLive(processes: PaneProcess[], panePid: number): boolean {
  if (!processes.some((p) => p.pid === panePid)) return false;
  return processes.some((p) => p.ppid === panePid);
}

function resolveMinChildLagSeconds(override?: number): number {
  if (typeof override === 'number' && Number.isFinite(override) && override >= 0) return override;
  const envVal = process.env.WAVEMILL_BG_CHILD_LAG_SECONDS;
  if (envVal !== undefined) {
    const parsed = Number.parseFloat(envVal);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_BG_CHILD_LAG_SECONDS;
}

/**
 * Structurally resolve which process in the pane subtree is the agent: walk
 * down from `panePid` and pick the longest-running descendant that has
 * children of its own. In the production pane (a shell the agent was typed
 * into) that is the agent — it is older than its own background children and
 * it is what owns them. Structural only: no command names.
 */
function resolveAgentPid(processes: PaneProcess[], panePid: number): number {
  const childrenByPpid = new Map<number, PaneProcess[]>();
  for (const p of processes) {
    const list = childrenByPpid.get(p.ppid) ?? [];
    list.push(p);
    childrenByPpid.set(p.ppid, list);
  }

  let bestPid = -1;
  let bestEtime = -1;
  const visited = new Set<number>([panePid]);
  const queue: number[] = [panePid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    for (const child of childrenByPpid.get(pid) ?? []) {
      if (visited.has(child.pid)) continue;
      visited.add(child.pid);
      const hasChildren = (childrenByPpid.get(child.pid) ?? []).length > 0;
      if (hasChildren && child.etimeSeconds !== null && child.etimeSeconds > bestEtime) {
        bestEtime = child.etimeSeconds;
        bestPid = child.pid;
      }
      queue.push(child.pid);
    }
  }
  return bestPid > 0 ? bestPid : panePid;
}

export interface PaneProcessSignals {
  /** `null` means "not probed" (bad panePid, missing `ps`, unparsable output). */
  agentProcessLive: boolean | null;
  backgroundWork: AgentBackgroundWorkResult | null;
}

/**
 * IO: snapshot `ps` once and derive both pane-process facts from it —
 * `agentProcessLive` (does the pane root have any live descendant at all)
 * and `backgroundWork` (does the resolved agent have a live, lagged
 * descendant). One snapshot serves both so a disposition check never pays
 * for `ps -axo` twice. Fail-safe: any error returns both facts `null`
 * ("not probed"), never throws.
 */
export function collectPaneProcessSignals(
  panePid: number,
  opts: { minChildLagSeconds?: number } = {},
): PaneProcessSignals {
  if (!Number.isFinite(panePid) || panePid <= 0) return { agentProcessLive: null, backgroundWork: null };
  const psOutput = safeExecFile('ps', ['-axo', 'pid=,ppid=,etime=,command=']);
  if (psOutput === null) return { agentProcessLive: null, backgroundWork: null };
  try {
    const processes = parsePsSnapshot(psOutput);
    const agentPid = resolveAgentPid(processes, panePid);
    const backgroundWork = deriveAgentBackgroundWork(processes, agentPid, {
      minChildLagSeconds: resolveMinChildLagSeconds(opts.minChildLagSeconds),
    });
    const agentProcessLive = deriveAgentProcessLive(processes, panePid);
    return { agentProcessLive, backgroundWork };
  } catch {
    return { agentProcessLive: null, backgroundWork: null };
  }
}

/**
 * IO: snapshot `ps` once, resolve the agent pid from the pane root (see
 * `resolveAgentPid`), and derive background-work evidence for the agent.
 * Fail-safe: any error (missing `ps`, unparsable output) returns `null`
 * ("not probed"), never throws.
 */
export function collectAgentBackgroundWork(
  panePid: number,
  opts: { minChildLagSeconds?: number } = {},
): AgentBackgroundWorkResult | null {
  return collectPaneProcessSignals(panePid, opts).backgroundWork;
}

// ── Pure derivation ──────────────────────────────────────────────────────────

const DEFAULT_STALL_MINUTES = 30;
const LAUNCH_STATUS_GRACE_SECONDS = 5;

function parseIsoToMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function tsToIso(secondsOrMs: number, secondsSuspected = false): string {
  const ms = secondsSuspected || secondsOrMs < 1e12 ? secondsOrMs * 1000 : secondsOrMs;
  return new Date(ms).toISOString();
}

/**
 * The pure decision: build a TaskProgress from already-gathered evidence.
 *
 * Tests target this function; the a–d families of bugs are all pinned here.
 */
export function deriveTaskProgress(
  inputs: TaskProgressInputs,
  opts: TaskProgressDeriveOptions = {},
): TaskProgress {
  const nowMs = (opts.now ?? new Date()).getTime();
  const stallMinutes = opts.stallMinutes ?? DEFAULT_STALL_MINUTES;

  const sources: ProgressSource[] = [];

  // (1) hook. Only the agent's own last record counts, and only when it is not
  //     `idle` — an idle record is the agent's settled state, not progress.
  const agentRec = inputs.hookFile ? selectAgentRecord(inputs.hookFile) : null;
  if (agentRec && agentRec.state && agentRec.state !== 'idle' && agentRec.timestamp > 0) {
    sources.push({
      kind: 'hook',
      at: tsToIso(agentRec.timestamp, true),
      detail: `${agentRec.state}${agentRec.event ? `:${agentRec.event}` : ''}`,
    });
  }

  // (2) commit. Only when strictly newer than launch anchor — unless there is
  //     no anchor at all. A merely *unresolved* launch time (e.g. legacy
  //     archive replay with no recorded launch marker) still lets evidence
  //     stand on its own; but when the caller explicitly knows no agent was
  //     ever launched for this disposition (HOK-3422: `launchKnownAbsent`,
  //     set for a `ready-remediation` / `conflict-resolution` sub-stage with
  //     no session-ownership row), there is nothing to compare staleness
  //     against, so evidence left over from an earlier stage must never be
  //     admitted as progress — admitting it unconditionally would resurrect
  //     the exact false-stall this field exists to prevent.
  const launchMs = parseIsoToMs(inputs.launchAt);
  const admitWithoutAnchor = launchMs === null && inputs.launchKnownAbsent !== true;
  const commitMs = parseIsoToMs(inputs.latestCommitAt);
  if (commitMs !== null && (admitWithoutAnchor || (launchMs !== null && commitMs > launchMs))) {
    sources.push({ kind: 'commit', at: new Date(commitMs).toISOString() });
  }

  // (3) worktree. Only when strictly newer than launch anchor (a base commit
  //     from before the launch does not count as progress; see (2) for the
  //     no-anchor rationale).
  const wtMs = parseIsoToMs(inputs.worktreeMtimeAt);
  if (wtMs !== null && (admitWithoutAnchor || (launchMs !== null && wtMs > launchMs))) {
    sources.push({
      kind: 'worktree',
      at: new Date(wtMs).toISOString(),
      ...(inputs.worktreeMtimePath ? { detail: inputs.worktreeMtimePath } : {}),
    });
  }

  // (4) status-file. Only when strictly newer than launch + 5s grace. The
  //     launcher's `working` write happens within a couple of seconds of
  //     `startedAt` so we treat launch..launch+5s as "not progress" (see (2)
  //     for the no-anchor rationale).
  const statusMs = parseIsoToMs(inputs.statusFileMtimeAt);
  if (
    statusMs !== null
    && (admitWithoutAnchor || (launchMs !== null && statusMs > launchMs + LAUNCH_STATUS_GRACE_SECONDS * 1000))
  ) {
    sources.push({ kind: 'status-file', at: new Date(statusMs).toISOString() });
  }

  // (4b) native session stream (HOK-3381). Agent-issued loop events
  //      (`tool_started` / `tool_result` / assistant turns) are the agent's
  //      own work; a native coder deep inside a long `run_tests` keeps
  //      appending them while the hook stays quiet. See (2) for the no-anchor
  //      rationale.
  const nativeMs = parseIsoToMs(inputs.nativeSessionLastEventAt ?? null);
  if (nativeMs !== null && (admitWithoutAnchor || (launchMs !== null && nativeMs > launchMs))) {
    sources.push({ kind: 'native-session', at: new Date(nativeMs).toISOString() });
  }

  // (4c) owned session transcript (HOK-3386). Claude Code / Codex stage
  //      transcripts are agent-written; their last-event time is progress
  //      and a terminal stop event is an agent idle record (folded into
  //      `agentIdle` below with the same semantics as `terminalHistoryIdleAt`).
  //      See (2) for the no-anchor rationale.
  const ownedMs = inputs.ownedSession?.lastEventAtMs ?? null;
  if (ownedMs !== null && (admitWithoutAnchor || (launchMs !== null && ownedMs > launchMs))) {
    sources.push({ kind: 'owned-session', at: new Date(ownedMs).toISOString() });
  }

  // (5) HOK-3422: controller-authored transition timestamps are no longer a
  //     progress source. They feed `lastTransitionAt` below, which is derived
  //     independently of `sources[]` and never contributes to `stalled`.

  // (6) terminal.
  const terminalPrState = inputs.terminal.prState ?? null;
  const terminalOutcome = inputs.terminal.lifecycleOutcome ?? null;
  const terminal = terminalPrState === 'MERGED' || terminalPrState === 'CLOSED'
    || terminalOutcome === 'merged' || terminalOutcome === 'closed' || terminalOutcome === 'aborted';
  if (terminal && inputs.terminal.at) {
    sources.push({ kind: 'terminal', at: inputs.terminal.at, detail: terminalPrState ?? terminalOutcome ?? undefined });
  }

  // Sort newest-first, most-progressy first.
  sources.sort((a, b) => (parseIsoToMs(b.at)! - parseIsoToMs(a.at)!));

  const lastProgressMs = sources.length > 0 ? parseIsoToMs(sources[0].at)! : null;
  const lastProgressAt = lastProgressMs !== null ? new Date(lastProgressMs).toISOString() : null;
  const progressAgeMinutes = lastProgressMs !== null
    ? Math.max(0, Math.floor((nowMs - lastProgressMs) / 60_000))
    : null;

  // HOK-3422: `lastTransitionAt` is the newest controller-authored move time,
  // derived from `transitionInputs` independently of `sources[]`. Readers that
  // want "when did the controller last move this task" (reliability metrics,
  // dashboard, ready watchdog) use this field. It NEVER feeds `stalled`.
  let lastTransitionMs: number | null = null;
  for (const t of inputs.transitionInputs) {
    const ms = parseIsoToMs(t.at);
    if (ms === null) continue;
    if (lastTransitionMs === null || ms > lastTransitionMs) lastTransitionMs = ms;
  }
  const lastTransitionAt = lastTransitionMs !== null ? new Date(lastTransitionMs).toISOString() : null;

  // Freshness gate for `agentState` (the agent's own state right now).
  const agentStateFresh = agentRec && agentRec.timestamp > 0
    && (nowMs - agentRec.timestamp * 1000) < HOOK_TTL_SECONDS * 1000
    ? agentRec.state
    : null;

  const controllerFresh = inputs.hookFile && inputs.hookFile.writer === 'monitor'
    && inputs.hookFile.top
    && inputs.hookFile.topTimestamp > 0
    && (nowMs - inputs.hookFile.topTimestamp * 1000) < HOOK_TTL_SECONDS * 1000
    ? inputs.hookFile.top.state
    : null;

  const historyIdle = !!inputs.terminalHistoryIdleAt;
  // HOK-3386: an owned-session idle event is agent-written (invariant 2
  // holds) and lets a Codex stage with no hook adapter reach `agentIdle` once
  // its rollout carries a `task_complete` event.
  const ownedIdleMs = inputs.ownedSession?.agentIdleAtMs ?? null;
  const ownedIdleValid = ownedIdleMs !== null && (launchMs === null || ownedIdleMs >= launchMs);
  const agentIdle = (agentRec !== null && agentRec.state === 'idle') || historyIdle || ownedIdleValid;
  const terminalIdle = terminal && (agentIdle || inputs.agentProcessLive === false);

  // Attention states are never "stalled" — the agent has already declared it
  // is waiting on a human.
  const suppressedState = agentStateFresh
    && ['waiting', 'approval-needed', 'blocked', 'policy-denied'].includes(agentStateFresh);

  // HOK-3422: the stall clock's anchor is the newest agent-written evidence,
  // else the launch time. A stage launched 40 min ago with zero agent evidence
  // (incident 2026-11-05: host reboot cleared the `/tmp` hook, no transcript
  // events after launch) is stalled from the launch anchor. A controller-owned
  // wait (no launch; Ready CI wait with no remediation agent) has no anchor,
  // so `stalled` is always false.
  const stallAnchorMs = lastProgressMs ?? launchMs;
  const stallThresholdMs = stallMinutes * 60_000;
  const overThreshold = stallAnchorMs !== null
    && (nowMs - stallAnchorMs) > stallThresholdMs;

  // HOK-3137: an idle agent with a live background task is not stalled — it
  // is waiting on its own work, not abandoned. Scoped to `agentIdle` so
  // non-idle stall detection (HOK-3069) is unaffected, and process existence
  // still never becomes a progress source (invariant 1: no new source kind,
  // no lastProgressAt contribution above).
  const agentBackgroundLive = inputs.backgroundWork ? inputs.backgroundWork.live : null;
  const backgroundWorkSuppresses = agentIdle && agentBackgroundLive === true;

  const stalled = !terminal && overThreshold && !suppressedState && !backgroundWorkSuppresses;

  return {
    issue: inputs.issue,
    computedAt: new Date(nowMs).toISOString(),
    lastProgressAt,
    progressAgeMinutes,
    sources,
    lastTransitionAt,
    agentState: agentStateFresh,
    agentRecord: agentRec,
    controllerState: controllerFresh,
    agentIdle,
    terminal,
    terminalIdle,
    agentProcessLive: inputs.agentProcessLive,
    // HOK-3426: the one exit fact. `terminalIdle` above still reads the pane
    // descendant count as a diagnostic; a stage settles only on this field.
    agentExited: inputs.agentExited,
    agentBackgroundLive,
    backgroundProcesses: inputs.backgroundWork?.processes ?? [],
    stalled,
    stallMinutes,
    blockingPrompt: inputs.blockingPrompt,
    ownedSessionIdleAt: ownedIdleValid && ownedIdleMs !== null ? new Date(ownedIdleMs).toISOString() : null,
    ownedSessionHarness: inputs.ownedSession?.harness ?? null,
  };
}

// ── Gather (IO) ──────────────────────────────────────────────────────────────

function safeStatMtimeIso(path: string): string | null {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}

function safeExecFile(cmd: string, args: string[], cwd?: string): string | null {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function readLatestCommitAt(worktree: string): string | null {
  const out = safeExecFile('git', ['-C', worktree, 'log', '-1', '--format=%ct', 'HEAD']);
  if (!out) return null;
  const ct = Number.parseInt(out.trim(), 10);
  if (!Number.isFinite(ct)) return null;
  return new Date(ct * 1000).toISOString();
}

interface WorktreeMtime {
  at: string | null;
  path?: string;
}

/**
 * Newest mtime among tracked/untracked worktree paths. Bounded to 200 rows so
 * a huge dirty tree cannot blow the primitive's per-call budget.
 *
 * Excludes:
 *   - `.wavemill/**` (prompt-registry telemetry; HOK-3095 / #1507);
 *   - `features/<slug>/.*` (stage results and markers written by the
 *     monitor, not the agent);
 *   - `.git/**` (git plumbing, not agent work).
 */
function isControllerWorktreePath(relPath: string, featureSlug?: string): boolean {
  if (relPath.startsWith('.wavemill/') || relPath === '.wavemill' || relPath === '.wavemill/') return true;
  if (relPath.startsWith('.git/')) return true;
  if (!featureSlug) return false;
  const featPrefix = `features/${featureSlug}/`;
  const bugPrefix = `bugs/${featureSlug}/`;
  if (!(relPath.startsWith(featPrefix) || relPath.startsWith(bugPrefix))) return false;
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  // features/<slug>/plan.md and features/<slug>/task-packet-*.md are
  // agent-edited. Only skip the controller dotfiles.
  return base.startsWith('.');
}

function readWorktreeMtime(worktree: string, featureSlug?: string): WorktreeMtime {
  const out = safeExecFile('git', ['-C', worktree, 'status', '--porcelain', '-z']);
  if (!out) return { at: null };
  // -z separates records by NUL, with a two-char status prefix per record.
  const rows = out.split('\0').filter((line) => line.length > 0).slice(0, 200);
  let bestMs: number | null = null;
  let bestPath: string | undefined;

  const considerFile = (relPath: string): void => {
    if (isControllerWorktreePath(relPath, featureSlug)) return;
    const absPath = join(worktree, relPath);
    try {
      const s = statSync(absPath);
      const ms = s.mtimeMs;
      if (bestMs === null || ms > bestMs) {
        bestMs = ms;
        bestPath = relPath;
      }
    } catch {
      // File may have been removed between status and stat; skip.
    }
  };

  for (const row of rows) {
    if (row.length <= 3) continue;
    const relPath = row.slice(3);
    // Untracked directory entries (`features/`) — git shows only the top
    // path when everything underneath is untracked. Recurse one level so
    // we do not count a directory mtime that reflects only controller
    // writes (HOK-3101: monitor writes never count as agent progress).
    if (relPath.endsWith('/')) {
      if (isControllerWorktreePath(relPath, featureSlug)) continue;
      try {
        const absDir = join(worktree, relPath);
        for (const entry of readdirSync(absDir, { withFileTypes: true })) {
          const childPath = relPath + entry.name + (entry.isDirectory() ? '/' : '');
          if (entry.isDirectory()) {
            if (isControllerWorktreePath(childPath, featureSlug)) continue;
            try {
              for (const grand of readdirSync(join(absDir, entry.name), { withFileTypes: true })) {
                if (grand.isDirectory()) continue;
                considerFile(childPath + grand.name);
              }
            } catch {
              // skip
            }
          } else {
            considerFile(childPath);
          }
        }
      } catch {
        // skip
      }
      continue;
    }
    considerFile(relPath);
  }
  if (bestMs === null) return { at: null };
  return { at: new Date(bestMs).toISOString(), path: bestPath };
}

/**
 * Newest archived idle terminal event for this task, from
 * `<featureDir>/.terminal-history.jsonl`. This is the fallback for
 * HOK-3089 pt 3: after `wavemill_terminalize_hook_for_issue` archives the
 * agent's `idle:Stop`, the top-level hook is a monitor `pr_merged` write.
 * Any settled-idle event on any agent counts.
 */
function readTerminalHistoryIdleAt(historyPath: string): string | null {
  if (!existsSync(historyPath)) return null;
  let content: string;
  try {
    content = readFileSync(historyPath, 'utf-8');
  } catch {
    return null;
  }
  const lines = content.split('\n').filter((l) => l.length > 0);
  let bestMs: number | null = null;
  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = objectField(entry.payload);
    if (!payload) continue;
    // HOK-3089 pt 3 fix: any agent, any settled-idle event kind.
    const state = stringField(payload.state);
    const event = stringField(payload.event);
    const writer = stringField(payload.writer);
    const kind = stringField(payload.kind);
    // HOK-3359: a controller-termination entry is an exit fact the
    // controller recorded after ending the agent itself — it counts as
    // settled-idle unconditionally, independent of the state/event
    // classification above (which exists for the agent's OWN records).
    const isControllerTermination = writer === 'controller' && kind === 'controller-termination';
    if (!isControllerTermination) {
      if (state !== 'idle') continue;
      if (writer === 'monitor') continue;
      if (event && CONTROLLER_HOOK_EVENTS.has(event)) continue;
    }
    const ts = numberField(payload.timestamp);
    if (ts === undefined) continue;
    const ms = ts * 1000;
    if (bestMs === null || ms > bestMs) bestMs = ms;
  }
  if (bestMs === null) return null;
  return new Date(bestMs).toISOString();
}

/**
 * HOK-3426: newest recorded exit entry for one stage, from
 * `<featureDir>/.terminal-history.jsonl`. Unlike {@link
 * readTerminalHistoryIdleAt} this NEVER counts an agent-written idle Stop: an
 * exit record is written by the surface that OBSERVED the launched process
 * end — the controller (HOK-3359 `controller-termination`) or the launcher
 * that spawned it (`agent-exit`, `wavemill_hook_write_agent_exit`) — while an
 * agent's `idle:Stop` is agent evidence, not an exit.
 *
 * Scoping:
 * - `phase` filters to records naming that phase (or naming none, since some
 *   controller teardown paths do not stamp one) — the coding pane's
 *   quarantine must never settle review.
 * - `since` excludes records older than the current attempt's launch.
 * - `since === null` means "no agent was launched", so no exit record can be
 *   this stage's exit and the source is disabled.
 */
function readExitRecordAt(
  historyPath: string,
  match: { writer: string; kind: string },
  opts: { phase?: string | null; since?: string | null },
): string | null {
  if (opts.since === null) return null;
  if (!existsSync(historyPath)) return null;
  let content: string;
  try {
    content = readFileSync(historyPath, 'utf-8');
  } catch {
    return null;
  }
  const sinceMs = opts.since ? parseIsoToMs(opts.since) : null;
  const lines = content.split('\n').filter((l) => l.length > 0);
  let bestMs: number | null = null;
  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = objectField(entry.payload);
    if (!payload) continue;
    if (stringField(payload.writer) !== match.writer) continue;
    if (stringField(payload.kind) !== match.kind) continue;
    const entryPhase = stringField(payload.phase) ?? null;
    if (opts.phase !== undefined && entryPhase !== null && entryPhase !== opts.phase) continue;
    const ts = numberField(payload.timestamp);
    if (ts === undefined) continue;
    const ms = ts * 1000;
    // `payload.timestamp` has second precision (the hook protocol writes epoch
    // seconds) while `since` carries milliseconds: a record in the launch's own
    // second must still settle that attempt, otherwise an agent that exits
    // sub-second after launch is missed until the stall clock. The 999 ms slack
    // can only admit a same-second record; a same-phase relaunch never starts
    // that fast.
    if (sinceMs !== null && ms + 999 < sinceMs) continue;
    if (bestMs === null || ms > bestMs) bestMs = ms;
  }
  if (bestMs === null) return null;
  return new Date(bestMs).toISOString();
}

/**
 * Resolve the native session-stream path for a task, matching the native
 * launchers' transcript layout (`makeTranscriptPath` in launch-coding.ts):
 * `WAVEMILL_RUN_DIR/native-sessions/<phase>-<issue>.jsonl` when set, else
 * `<repoDir>/.wavemill/runs/<session>/native-sessions/<phase>-<issue>.jsonl`.
 */
function resolveNativeSessionPath(opts: TaskProgressGatherOptions, session: string): string | null {
  if (opts.nativeSessionPath) return opts.nativeSessionPath;
  if (!opts.phase) return null;
  const safeIssue = opts.issue.replace(/[^A-Za-z0-9._-]+/g, '-');
  const baseDir = process.env.WAVEMILL_RUN_DIR
    ? join(process.env.WAVEMILL_RUN_DIR, 'native-sessions')
    : join(opts.repoDir ?? process.cwd(), '.wavemill', 'runs', session, 'native-sessions');
  return join(baseDir, `${opts.phase}-${safeIssue}.jsonl`);
}

/**
 * ISO time of the newest event in a native session stream, read from the
 * file's tail without loading the whole transcript. Returns `null` on any
 * failure: a missing or unparsable stream is simply absent evidence.
 */
function readNativeSessionLastEventAt(path: string | null): string | null {
  if (!path) return null;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size === 0) return null;
    const fd = openSync(path, 'r');
    try {
      const len = Math.min(stat.size, 64 * 1024);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, stat.size - len);
      const lines = buf.toString('utf8').split('\n').filter((line) => line.trim().length > 0);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
          const event = JSON.parse(lines[index]) as { timestamp?: unknown };
          const ts = numberField(event.timestamp);
          if (ts !== undefined && ts > 0) return new Date(ts).toISOString();
        } catch {
          // The first line of the tail window may be a partial record; skip.
        }
      }
      return null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

// ── HOK-3386: owned session transcript as agent evidence ───────────────────
//
// A launched stage records exactly one session-ownership row before its agent
// starts (HOK-3328): harness, kind, stage, launchedAt, cwd. The agent's own
// transcript — Claude Code's `~/.claude/projects/<slug>/<sessionRef>.jsonl`,
// Codex's `rollout-...jsonl` — is written on every tool_result and the final
// stop. Those writes are agent-written, so their last timestamp is progress
// and a terminal stop event is an idle record. This folds that transcript
// into the progress primitive for `claude-code` and `codex` harnesses; native
// stages stay on their existing session-stream reader.

/** Stage names a stage-agent disposition reads. */
export type StageAgentStage = 'planning' | 'coding' | 'review' | 'ready-remediation' | 'conflict-resolution';

const OWNED_SESSION_MTIME_SLACK_MS = 60_000;
const OWNED_SESSION_TAIL_BYTES = 64 * 1024;

const STAGE_TO_OWNERSHIP_KIND: Record<StageAgentStage, readonly OwnershipKind[]> = {
  planning: ['planning'],
  coding: ['coding'],
  review: ['review'],
  'ready-remediation': ['ready-remediation'],
  'conflict-resolution': ['conflict-resolution'],
};

export interface OwnedStageLaunch {
  sessionRef: string;
  harness: 'claude-code' | 'codex';
  launchedAt: string;
  cwd?: string;
  kind: OwnershipKind;
  stage?: OwnershipStage;
  attemptId: string;
}

/**
 * Newest `launch` ownership row whose kind maps to `stage`, filtered to
 * claude-code or codex harnesses. Native rows are ignored here — the native
 * session stream reader (HOK-3381) already covers them.
 */
export function readOwnedStageLaunch(stateDir: string, stage: StageAgentStage): OwnedStageLaunch | null {
  const kinds = new Set<OwnershipKind>(STAGE_TO_OWNERSHIP_KIND[stage]);
  let best: SessionOwnershipRow | null = null;
  let bestMs = -Infinity;
  for (const row of readOwnershipRows(stateDir)) {
    if (!kinds.has(row.kind)) continue;
    if (row.harness !== 'claude-code' && row.harness !== 'codex') continue;
    const ms = Date.parse(row.launchedAt);
    if (!Number.isFinite(ms) || ms <= bestMs) continue;
    bestMs = ms;
    best = row;
  }
  if (!best) return null;
  return {
    sessionRef: best.sessionRef,
    harness: best.harness as 'claude-code' | 'codex',
    launchedAt: best.launchedAt,
    ...(best.cwd ? { cwd: best.cwd } : {}),
    kind: best.kind,
    ...(best.stage ? { stage: best.stage } : {}),
    attemptId: best.attemptId,
  };
}

/** Resolve the pending nonce of a Codex row to a real thread id, or return null. */
function resolveCodexSessionRef(launch: OwnedStageLaunch): string | null {
  if (!isPendingSessionRef(launch.sessionRef)) return launch.sessionRef;
  // Build a minimal row for the resolver (same shape it takes).
  const minimalRow: SessionOwnershipRow = {
    sessionRef: launch.sessionRef,
    harness: 'codex',
    kind: launch.kind,
    model: '',
    launchedAt: launch.launchedAt,
    attemptId: launch.attemptId,
    ...(launch.cwd ? { cwd: launch.cwd } : {}),
    ...(launch.stage ? { stage: launch.stage } : {}),
  };
  try {
    const resolved = resolveCodexLaunchNonces([minimalRow]);
    return resolved.get(launch.sessionRef) ?? null;
  } catch {
    return null;
  }
}

/**
 * Candidate transcript paths for a launch. For Claude Code, the path depends
 * on the cwd slug plus the sessionRef; for Codex, the rollout is named by
 * its (resolved) thread id, nested under a date tree.
 */
export function resolveOwnedSessionTranscriptPath(launch: OwnedStageLaunch): string | null {
  if (launch.harness === 'claude-code') {
    if (!launch.cwd) return null;
    const dirs = resolveProjectsDirs(launch.cwd);
    for (const dir of dirs) {
      const candidate = join(dir, `${launch.sessionRef}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }
  // codex
  const threadId = resolveCodexSessionRef(launch);
  if (!threadId) return null;
  const root = codexSessionsRoot();
  if (!existsSync(root)) return null;
  // Rollout name: `rollout-<date>-<threadId>.jsonl`, nested by year/month/day.
  const stack: string[] = [root];
  const launchMs = Date.parse(launch.launchedAt);
  const minMtimeMs = Number.isFinite(launchMs) ? launchMs - OWNED_SESSION_MTIME_SLACK_MS : -Infinity;
  let depth = 0;
  while (stack.length > 0 && depth < 2000) {
    depth += 1;
    const dir = stack.shift()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl') && entry.name.includes(threadId)) {
        try {
          if (statSync(full).mtimeMs >= minMtimeMs) return full;
        } catch {
          // skip
        }
      }
    }
  }
  return null;
}

interface OwnedSessionTail {
  lastEventAtMs: number | null;
  agentIdleAtMs: number | null;
}

/**
 * Tail the transcript and parse the last few events. Returns an idle
 * timestamp when the trailing stop-shaped event is present. The reader is
 * tolerant: an unparsable tail line is skipped, and any error yields nulls.
 */
export function readOwnedSessionTail(path: string, harness: 'claude-code' | 'codex'): OwnedSessionTail {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size === 0) return { lastEventAtMs: null, agentIdleAtMs: null };
    const fd = openSync(path, 'r');
    try {
      const len = Math.min(st.size, OWNED_SESSION_TAIL_BYTES);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, st.size - len);
      const lines = buf.toString('utf8').split('\n').filter((l) => l.trim().length > 0);
      if (lines.length === 0) return { lastEventAtMs: null, agentIdleAtMs: null };

      let lastEventAtMs: number | null = null;
      let agentIdleAtMs: number | null = null;
      // Walk forward so chronology is preserved: the last parseable timestamp
      // is `lastEventAtMs`; a stop-shaped event sets `agentIdleAtMs` to the
      // event's own timestamp.
      for (let i = 0; i < lines.length; i += 1) {
        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(lines[i]) as Record<string, unknown>;
        } catch {
          continue; // tail head can be a truncated record
        }
        const tsIso = stringField(entry.timestamp);
        const atMs = tsIso ? Date.parse(tsIso) : NaN;
        if (Number.isFinite(atMs)) lastEventAtMs = atMs;

        if (harness === 'codex') {
          if (entry.type === 'event_msg') {
            const payload = objectField(entry.payload);
            const pType = payload ? stringField(payload.type) : null;
            if (pType === 'task_complete' || pType === 'agent_turn_complete'
              || pType === 'response_complete' || pType === 'response.completed') {
              if (Number.isFinite(atMs)) agentIdleAtMs = atMs;
            }
          }
        } else {
          // claude-code
          if (entry.type === 'Stop' || entry.type === 'stop_hook_event') {
            if (Number.isFinite(atMs)) agentIdleAtMs = atMs;
          }
          if (entry.type === 'system') {
            const subtype = stringField(entry.subtype);
            if (subtype === 'stop_hook_summary' || subtype === 'turn_duration') {
              if (Number.isFinite(atMs)) agentIdleAtMs = atMs;
            }
          }
        }
      }
      return { lastEventAtMs, agentIdleAtMs };
    } finally {
      closeSync(fd);
    }
  } catch {
    return { lastEventAtMs: null, agentIdleAtMs: null };
  }
}

/**
 * Resolve the stage's owned launch, load its transcript tail, and return the
 * owned-session evidence shape consumed by {@link deriveTaskProgress}. Any
 * failure returns `null`: no owned-session evidence is a legitimate state,
 * and the derivation then falls back to the hook / commit / worktree sources.
 */
export function readOwnedStageTranscript(
  stateDir: string,
  stage: StageAgentStage,
): { lastEventAtMs: number | null; agentIdleAtMs: number | null; harness: 'claude-code' | 'codex' } | null {
  const launch = readOwnedStageLaunch(stateDir, stage);
  if (!launch) return null;
  const path = resolveOwnedSessionTranscriptPath(launch);
  if (!path) return null;
  // Defensive bound: a file whose mtime predates the launch (minus clock
  // slack) cannot be this launch's transcript.
  try {
    const launchMs = Date.parse(launch.launchedAt);
    const mtimeMs = statSync(path).mtimeMs;
    if (Number.isFinite(launchMs) && mtimeMs + OWNED_SESSION_MTIME_SLACK_MS < launchMs) {
      return null;
    }
  } catch {
    // Unreadable stat: skip.
  }
  const tail = readOwnedSessionTail(path, launch.harness);
  return { ...tail, harness: launch.harness };
}

/**
 * Read the stage `<featureDir>/.<phase>-result.json` and pluck out the
 * launchAt (`startedAt`) plus the controller-authored transition inputs
 * (`startedAt`, `finishedAt`, `updated`).
 *
 * HOK-3422: the three timestamps feed only `lastTransitionAt`; they never
 * contribute to `lastProgressAt` / `stalled` (invariant 2).
 */
function readStageResult(featureDir: string | undefined, phase: string | undefined): {
  launchAt: string | null;
  transitions: TransitionInput[];
} {
  if (!featureDir || !phase) return { launchAt: null, transitions: [] };
  const file = join(featureDir, `.${phase}-result.json`);
  const result = readJsonTolerant<Record<string, unknown>>(file);
  if (result.status !== 'ok') return { launchAt: null, transitions: [] };
  const value = result.value;
  const launchAt = stringField(value.startedAt) ?? null;
  const transitions: TransitionInput[] = [];
  if (launchAt) transitions.push({ at: launchAt, detail: `${phase}.startedAt` });
  const finishedAt = stringField(value.finishedAt);
  if (finishedAt) transitions.push({ at: finishedAt, detail: `${phase}.finishedAt` });
  const updated = stringField(value.updated);
  if (updated) transitions.push({ at: updated, detail: `${phase}.updated` });
  return { launchAt, transitions };
}

/**
 * Gather all raw evidence for one task. Every source is optional; a missing
 * source is simply absent from the derived `sources` list.
 */
export function gatherTaskProgressInputs(opts: TaskProgressGatherOptions): TaskProgressInputs {
  const session = opts.session ?? process.env.WAVEMILL_SESSION ?? 'wavemill';
  const hookPath = opts.hookFilePath ?? `/tmp/wavemill-${session}-${opts.issue}.hook`;
  const hookFile = readHookFile(hookPath);

  const worktree = opts.worktree ?? opts.task?.worktree;
  const featureDir = opts.featureDir
    ?? (worktree && opts.task?.slug ? join(worktree, 'features', opts.task.slug) : undefined);

  const historyIdleAt = featureDir
    ? readTerminalHistoryIdleAt(join(featureDir, '.terminal-history.jsonl'))
    : null;

  const latestCommitAt = worktree ? readLatestCommitAt(worktree) : null;

  const { launchAt, transitions: stageTransitions } = readStageResult(featureDir, opts.phase);

  const wt = worktree
    ? readWorktreeMtime(worktree, opts.task?.slug)
    : { at: null };

  const statusFilePath = opts.statusFilePath ?? `/tmp/${session}-${opts.issue}-status.txt`;
  const statusFileMtimeAt = safeStatMtimeIso(statusFilePath);

  const nativeSessionLastEventAt = readNativeSessionLastEventAt(resolveNativeSessionPath(opts, session));

  // HOK-3386: pick the stage for the owned-session probe. `stageForOwnedSession
  // = null` disables; otherwise fall back to a canonical stage derived from
  // `phase` when it names one.
  let ownedSessionStage: StageAgentStage | null = null;
  if (opts.stageForOwnedSession === null) {
    ownedSessionStage = null;
  } else if (opts.stageForOwnedSession) {
    ownedSessionStage = opts.stageForOwnedSession;
  } else if (opts.phase === 'planning' || opts.phase === 'coding' || opts.phase === 'review') {
    ownedSessionStage = opts.phase;
  }
  const ownershipDir = opts.ownershipStateDir ?? featureDir;
  const ownedSession = ownedSessionStage && ownershipDir
    ? readOwnedStageTranscript(ownershipDir, ownedSessionStage)
    : null;

  // HOK-3422: controller-authored transition timestamps feed only
  // `lastTransitionAt`. They never land in `sources[]` / `lastProgressAt`
  // (invariant 2: controller writes are never agent evidence).
  const transitionInputs: TransitionInput[] = [...stageTransitions];
  if (opts.task?.updated) {
    transitionInputs.push({ at: opts.task.updated, detail: 'task.updated' });
  }
  for (const s of opts.extraTransitionInputs ?? []) {
    transitionInputs.push(s);
  }

  // HOK-3422: prefer the caller's launch anchor (e.g. the stage's
  // session-ownership `launchedAt`) over the stage-result `startedAt`. The
  // stage-result is controller-rewritten on every tick, so anchoring the
  // stall clock to it drifts with the controller's writes; the ownership row
  // is set once, before the agent starts, and never updates.
  const launchAtResolved = opts.launchAtOverride !== undefined
    ? opts.launchAtOverride
    : launchAt;
  // HOK-3422: an explicit `launchAtOverride: null` means the caller has
  // positively established that no agent was ever launched for this
  // disposition (vs. `launchAt` merely being unresolved) — see
  // `TaskProgressInputs.launchKnownAbsent`.
  const launchKnownAbsent = opts.launchAtOverride === null;

  const prState = opts.task?.lifecycle?.deliveryEvidence?.prState ?? null;
  const prNumber = opts.task?.lifecycle?.deliveryEvidence?.prNumber ?? null;
  const outcome = opts.task?.lifecycle?.workflowOutcome ?? null;
  const terminalAt = opts.task?.updated ?? null;

  const blockingPrompt = matchBlockingPromptFromPaneText(opts.paneText);

  // HOK-3386: a caller-supplied `agentProcessLive` wins (Ready's own probe);
  // otherwise derive both pane-process facts from one `ps` snapshot so every
  // stage disposition gets the HOK-2963 fast-death signal, not just the
  // background-work one.
  const paneSignals = opts.panePid != null
    ? collectPaneProcessSignals(opts.panePid, { minChildLagSeconds: opts.backgroundWorkLagSeconds })
    : { agentProcessLive: null, backgroundWork: null };
  const backgroundWork = paneSignals.backgroundWork;
  const agentProcessLive = opts.agentProcessLive ?? paneSignals.agentProcessLive;

  // HOK-3426: the ONE exit fact, from a RECORDED exit only, in this order:
  //   1. a controller termination (HOK-3359) — the controller recorded that it
  //      ended the launched agent;
  //   2. an `agent-exit` record — the launcher, which is the agent process's
  //      parent, recorded the process's own exit status (this is the only
  //      surface that sees a hard-killed agent's exit; the pane shell outlives
  //      the agent, so the pane is not the record);
  //   3. the launched slot's handle — the window id recorded at launch —
  //      reporting dead through the terminal backend (the whole slot exited).
  // The pane descendant count (`agentProcessLive`) is never consulted here: a
  // name-resolved or freshly recreated pane can be the wrong pane or the right
  // pane before its agent forked, which is how a live reviewer was stamped
  // `failed` in the 2026-11-05 incident.
  const exitPhase = opts.agentExitPhase !== undefined ? opts.agentExitPhase : opts.phase;
  const exitScope = { phase: exitPhase, since: opts.agentExitSince };
  const historyPath = featureDir ? join(featureDir, '.terminal-history.jsonl') : null;
  const controllerTerminationAt = historyPath
    ? readExitRecordAt(historyPath, { writer: 'controller', kind: 'controller-termination' }, exitScope)
    : null;
  const launcherExitAt = historyPath
    ? readExitRecordAt(historyPath, { writer: 'launcher', kind: 'agent-exit' }, exitScope)
    : null;
  const windowId = opts.task?.windowId;
  // Only probe the slot when no record already answered AND an explicit,
  // non-null launch time was supplied. The probe is a terminal-backend spawn
  // (up to 3s): only the stage-disposition gather, which already talks to the
  // terminal backend, passes `agentExitSince`, so the HOK-3206 hot-pass paths
  // (dashboard, monitor tick) never pay for it. `since === null` means no agent
  // of this stage was launched, so a dead slot is not an exit of one. A stale
  // handle (a reaped or recreated window id) is unreadable, and
  // `termIsDead` reports `null` for an unreadable target — never `true` — so a
  // replaced window cannot fake an exit.
  const slotDead = typeof opts.agentExitSince === 'string' && opts.agentExitSince.length > 0
    && !controllerTerminationAt && !launcherExitAt
    && !!windowId && termIsDead(windowId, { timeoutMs: 3000 }) === true;
  const agentExited: AgentExitedFact | null = controllerTerminationAt
    ? { at: controllerTerminationAt, source: 'controller-termination' }
    : launcherExitAt
      ? { at: launcherExitAt, source: 'launcher' }
      : slotDead
        ? { at: new Date().toISOString(), source: 'terminal-backend' }
        : null;

  return {
    issue: opts.issue,
    hookFile,
    terminalHistoryIdleAt: historyIdleAt,
    latestCommitAt,
    launchAt: launchAtResolved,
    launchKnownAbsent,
    worktreeMtimeAt: wt.at,
    worktreeMtimePath: wt.path,
    statusFileMtimeAt,
    nativeSessionLastEventAt,
    ownedSession,
    transitionInputs,
    terminal: {
      prState,
      prNumber,
      lifecycleOutcome: outcome,
      at: terminalAt,
    },
    agentProcessLive,
    agentExited,
    backgroundWork,
    blockingPrompt,
  };
}

function matchBlockingPromptFromPaneText(paneText?: string): BlockingPrompt | null {
  const sig = matchInteractivePromptSignature(paneText);
  if (!sig) return null;
  return { id: sig.id, agent: sig.agent, detail: sig.operatorAction };
}

/** Gather + derive in one call. */
export function getTaskProgress(
  opts: TaskProgressGatherOptions & TaskProgressDeriveOptions,
): TaskProgress {
  const inputs = gatherTaskProgressInputs(opts);
  return deriveTaskProgress(inputs, { now: opts.now, stallMinutes: opts.stallMinutes });
}

// ── Ancillary export used by the CLI's cache read ────────────────────────────

/**
 * Verify a cached progress payload is not older than `maxAgeSeconds`. This is
 * cheap (one Date.parse and one comparison) so the dashboard can call it
 * on every refresh.
 *
 * `inputsChangedAtMs` (the hook file's mtime) invalidates a cache computed
 * before the agent's latest event: an agent that wrote `Stop` after the cache
 * was computed must not read as `working` for the rest of the window — the
 * HOK-3128 dirty-handoff relaunch waited out the full 60s on exactly that.
 */
export function progressCacheIsFresh(
  payload: TaskProgress,
  maxAgeSeconds: number,
  now: Date = new Date(),
  inputsChangedAtMs?: number | null,
): boolean {
  const computedAtMs = parseIsoToMs(payload.computedAt);
  if (computedAtMs === null) return false;
  if (typeof inputsChangedAtMs === 'number' && inputsChangedAtMs > computedAtMs) return false;
  return (now.getTime() - computedAtMs) / 1000 < maxAgeSeconds;
}

/**
 * Public helper for TS callers that only need the age (minutes) of the
 * agent's most recent progress, using the shared derivation. Returns `null`
 * when we have no evidence to age against.
 */
export function progressAgeMinutesFor(inputs: TaskProgressInputs, now: Date = new Date()): number | null {
  return deriveTaskProgress(inputs, { now }).progressAgeMinutes;
}

// ── Tool-call progress rule (HOK-3381) ──────────────────────────────────────
//
// The one in-loop "is this agent making progress?" decision, shared by the
// native coding and planning loops. It replaces the deleted
// `ToolStagnationTracker` (exact call signature + identical output hash,
// which only tripped on byte-identical repeats) and the command tools'
// rerun-after-timeout command-string key.
//
// A call is "no progress" when, since the *same selection* last ran, the
// worktree content is unchanged (tracked-file diff, never mtime; test logs
// under `.wavemill/` never count — see `trackedContentFingerprint` in
// shared/lib/native-agent/worktree-fingerprint.ts) AND the run produced the
// same result (pass / fail / timeout for command tools, an output digest for
// read-only tools). The key is the selection, not the command text, so a
// changed `timeoutMs`, a wrapper, or a renamed log file does not evade it,
// and a smaller selection after a timeout is new information, not a loop.

/** Keys stripped from tool args before building a selection key: they change the call's budget, not what it selects. */
const SELECTION_VOLATILE_ARG_KEYS: ReadonlySet<string> = new Set(['timeoutMs', 'maxOutputBytes']);

function stableStringifyForKey(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringifyForKey).join(',') + ']';
  }
  const record = value as Record<string, unknown>;
  const pairs = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringifyForKey(record[key])}`);
  return '{' + pairs.join(',') + '}';
}

/**
 * Normalized selection key for one tool call: the tool name plus its
 * arguments with volatile budget fields (`timeoutMs`, `maxOutputBytes`)
 * removed, so raising a timeout never makes a repeat look like a new call.
 */
export function toolSelectionKey(name: string, args: unknown): string {
  if (args !== null && args !== undefined && typeof args === 'object' && !Array.isArray(args)) {
    const filtered: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
      if (!SELECTION_VOLATILE_ARG_KEYS.has(key)) filtered[key] = value;
    }
    return `${name}:${stableStringifyForKey(filtered)}`;
  }
  return `${name}:${stableStringifyForKey(args ?? {})}`;
}

/**
 * Normalized result key for one tool call. Command-shaped results (the
 * native `run_tests` / `run_format` details) collapse to their outcome —
 * `timeout`, `exit:<code>`, or `rejected:<error>` — so two slow runs of the
 * same failing selection compare equal even when their output differs in
 * timings. Everything else digests the observable result.
 */
export function toolCallResultKey(outcome: { isError?: boolean; content?: unknown; details?: unknown }): string {
  const details = outcome.details;
  if (details !== null && details !== undefined && typeof details === 'object' && !Array.isArray(details)) {
    const d = details as Record<string, unknown>;
    if (d.ok === false && typeof d.error === 'string') return `rejected:${d.error}`;
    if (d.status === 'timed_out' || d.timedOut === true) return 'timeout';
    if (d.status === 'completed' || typeof d.exitCode === 'number' || d.exitCode === null) {
      return `exit:${d.exitCode === null ? 'signal' : String(d.exitCode ?? 'unknown')}`;
    }
  }
  const digest = createHash('sha256')
    .update(stableStringifyForKey({
      isError: outcome.isError === true,
      content: outcome.content ?? null,
      details: details ?? null,
    }))
    .digest('hex')
    .slice(0, 16);
  return `output:${digest}`;
}

export interface ToolCallProgressPolicy {
  /** Total calls of one selection before stagnation can trip (was `maxRepeatedSignatureCalls`). */
  maxRepeatedSelectionCalls: number;
  /** Consecutive no-progress calls of one selection that trip stagnation (was `maxNoNovelProgressCalls`). */
  maxNoProgressCalls: number;
}

export interface ToolCallProgressObservation {
  /** From {@link toolSelectionKey}: what the call selected, not its text. */
  selectionKey: string;
  /** Tracked worktree content fingerprint ('' when the caller has none, e.g. planning). */
  worktreeFingerprint: string;
  /** From {@link toolCallResultKey}: the run's observable outcome. */
  resultKey: string;
}

export interface ToolCallProgressDecision {
  /** True when this call added no information over the selection's previous run. */
  noProgress: boolean;
  /** True when the policy's thresholds are both met: stop via `tool_stagnation`. */
  stagnant: boolean;
  selectionKey: string;
  repeatedCalls: number;
  noProgressCalls: number;
}

interface ToolCallProgressState {
  repeatedCalls: number;
  noProgressCalls: number;
  lastFingerprint: string;
  lastResultKey: string;
}

/**
 * The one tool-call progress tracker (HOK-3381). Decision sites must consume
 * this — never a private stagnation counter (enforced by the HOK-3101 guard,
 * `tools/check-hook-ttl.ts`).
 */
export class ToolCallProgressTracker {
  private readonly policy: ToolCallProgressPolicy;
  private readonly bySelection = new Map<string, ToolCallProgressState>();

  constructor(policy: ToolCallProgressPolicy) {
    this.policy = policy;
  }

  record(observation: ToolCallProgressObservation): ToolCallProgressDecision {
    const previous = this.bySelection.get(observation.selectionKey);
    const repeatedCalls = (previous?.repeatedCalls ?? 0) + 1;
    const noProgress = previous !== undefined
      && previous.lastFingerprint === observation.worktreeFingerprint
      && previous.lastResultKey === observation.resultKey;
    const noProgressCalls = noProgress ? previous.noProgressCalls + 1 : 0;
    this.bySelection.set(observation.selectionKey, {
      repeatedCalls,
      noProgressCalls,
      lastFingerprint: observation.worktreeFingerprint,
      lastResultKey: observation.resultKey,
    });
    return {
      noProgress,
      stagnant: repeatedCalls >= this.policy.maxRepeatedSelectionCalls
        && noProgressCalls >= this.policy.maxNoProgressCalls,
      selectionKey: observation.selectionKey,
      repeatedCalls,
      noProgressCalls,
    };
  }
}
