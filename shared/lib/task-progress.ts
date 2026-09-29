/**
 * HOK-3101 — one task-progress/liveness evidence primitive shared by observer,
 * monitor stage-owner, ready-watchdog, reconciler pane release, and dashboard.
 *
 * A dozen decision sites each inferred "is this task alive or stalled" from
 * whichever signal was closest at hand. That created four families of bugs:
 *   (a) an idle agent REPL counted as a live process;
 *   (b) the monitor's own polling subprocesses counted as the task;
 *   (c) a stale `.tasks[id].updated` was treated as the last progress time
 *       even though it only changes on transitions;
 *   (d) a monitor-written hook overwrote the agent's own record.
 *
 * This module builds one primitive that turns raw evidence into
 * `TaskProgress` — `lastProgressAt`, an ordered `sources[]`, the agent's own
 * `agentState`, `agentIdle`, `terminal`, `terminalIdle`, `stalled`, an optional
 * `blockingPrompt`, plus a rough `agentProcessLive` fact that is NEVER a
 * source of progress.
 *
 * Design invariants pinned by the tests:
 *   1. Pane or process existence is never progress.
 *   2. Monitor or controller writes are never agent evidence.
 *   3. An agent's own idle/Stop survives later monitor writes; it is revoked
 *      only by a later agent work event.
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

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

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
  | 'transition'  // Stage startedAt/finishedAt, task.updated, or caller extras.
  | 'terminal';   // Merged/closed PR or terminal lifecycle evidence.

export interface ProgressSource {
  kind: ProgressSourceKind;
  /** ISO timestamp of the evidence. */
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
  agentState: HookState | null;
  agentRecord: HookRecord | null;
  controllerState: HookState | null;
  agentIdle: boolean;
  terminal: boolean;
  terminalIdle: boolean;
  /** Non-progress liveness fact. `null` means "not probed". */
  agentProcessLive: boolean | null;
  stalled: boolean;
  stallMinutes: number;
  blockingPrompt?: BlockingPrompt | null;
}

// ── Pure derivation inputs ───────────────────────────────────────────────────

export interface TaskProgressGatherOptions {
  issue: string;
  session?: string;
  /** Task record from workflow-state.json (only used fields are optional). */
  task?: {
    updated?: string;
    branch?: string;
    slug?: string;
    worktree?: string;
    status?: string;
    phase?: string;
    lifecycle?: {
      deliveryEvidence?: { prState?: string; prNumber?: string | number };
      workflowOutcome?: string;
      resourceDisposition?: string;
    };
  };
  worktree?: string;
  featureDir?: string;
  /**
   * Active phase name; when set, `<featureDir>/.<phase>-result.json` is
   * used as the launch anchor for the commit / status-file / transition
   * sources, and the coding-launch anchor for `status-file`.
   */
  phase?: string;
  /**
   * Extra caller-supplied timestamps that count as `transition` progress
   * (e.g. ready-watchdog's stage result mtime).
   */
  extraTransitionSources?: ProgressSource[];
  /** Optional pane text for the blocking-prompt matcher. */
  paneText?: string;
  /** Optional pane-process liveness fact; not a progress source. */
  agentProcessLive?: boolean | null;
  /** For gather IO: override the default `/tmp` hook path. */
  hookFilePath?: string;
  /** For gather IO: override the default status file path. */
  statusFilePath?: string;
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
  /** newest mtime among tracked/untracked worktree paths, ISO. */
  worktreeMtimeAt: string | null;
  worktreeMtimePath?: string;
  /** status-file mtime, ISO. */
  statusFileMtimeAt: string | null;
  /** transitions the caller wants counted (stage finishedAt, task.updated, ready). */
  transitionSources: ProgressSource[];
  /** PR / lifecycle evidence for `terminal`. */
  terminal: {
    prState?: string | null;
    prNumber?: string | number | null;
    lifecycleOutcome?: string | null;
    at?: string | null;
  };
  agentProcessLive: boolean | null;
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
 * Argv patterns that identify wavemill's own controller processes. A match
 * here means the process is NEVER counted as agent evidence (HOK-3095 (b)).
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

function pushSource(list: ProgressSource[], src: ProgressSource | null): void {
  if (!src) return;
  const at = parseIsoToMs(src.at);
  if (at === null) return;
  list.push(src);
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

  // (2) commit. Only when strictly newer than launch anchor.
  const launchMs = parseIsoToMs(inputs.launchAt);
  const commitMs = parseIsoToMs(inputs.latestCommitAt);
  if (commitMs !== null && (launchMs === null || commitMs > launchMs)) {
    sources.push({ kind: 'commit', at: new Date(commitMs).toISOString() });
  }

  // (3) worktree. Only when strictly newer than launch anchor (a base commit
  //     from before the launch does not count as progress).
  const wtMs = parseIsoToMs(inputs.worktreeMtimeAt);
  if (wtMs !== null && (launchMs === null || wtMs > launchMs)) {
    sources.push({
      kind: 'worktree',
      at: new Date(wtMs).toISOString(),
      ...(inputs.worktreeMtimePath ? { detail: inputs.worktreeMtimePath } : {}),
    });
  }

  // (4) status-file. Only when strictly newer than launch + 5s grace. The
  //     launcher's `working` write happens within a couple of seconds of
  //     `startedAt` so we treat launch..launch+5s as "not progress".
  const statusMs = parseIsoToMs(inputs.statusFileMtimeAt);
  if (statusMs !== null && (launchMs === null || statusMs > launchMs + LAUNCH_STATUS_GRACE_SECONDS * 1000)) {
    sources.push({ kind: 'status-file', at: new Date(statusMs).toISOString() });
  }

  // (5) transitions supplied by the caller (stage startedAt/finishedAt,
  //     task.updated, ready-watchdog stage result mtime).
  for (const src of inputs.transitionSources) {
    pushSource(sources, src);
  }

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
  const agentIdle = (agentRec !== null && agentRec.state === 'idle') || historyIdle;
  const terminalIdle = terminal && (agentIdle || inputs.agentProcessLive === false);

  // Attention states are never "stalled" — the agent has already declared it
  // is waiting on a human.
  const suppressedState = agentStateFresh
    && ['waiting', 'approval-needed', 'blocked', 'policy-denied'].includes(agentStateFresh);
  const overThreshold = progressAgeMinutes !== null && progressAgeMinutes > stallMinutes;

  const stalled = !terminal && overThreshold && !suppressedState;

  return {
    issue: inputs.issue,
    computedAt: new Date(nowMs).toISOString(),
    lastProgressAt,
    progressAgeMinutes,
    sources,
    agentState: agentStateFresh,
    agentRecord: agentRec,
    controllerState: controllerFresh,
    agentIdle,
    terminal,
    terminalIdle,
    agentProcessLive: inputs.agentProcessLive,
    stalled,
    stallMinutes,
    blockingPrompt: inputs.blockingPrompt,
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
    if (state !== 'idle') continue;
    if (writer === 'monitor') continue;
    if (event && CONTROLLER_HOOK_EVENTS.has(event)) continue;
    // A missing event or an idle event whose name is a known settled event.
    const IDLE_EVENTS = new Set(['Stop', 'process_exit', 'stream_end', 'process_idle']);
    if (event && !IDLE_EVENTS.has(event) && !CONTROLLER_HOOK_EVENTS.has(event)) {
      // Unknown idle event kind; still trust it (it is an idle state) unless
      // it looks like a controller event.
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
 * Read the stage `<featureDir>/.<phase>-result.json` and pluck out the
 * launchAt (`startedAt`) plus the transition sources (`startedAt`,
 * `finishedAt`, `updated`).
 */
function readStageResult(featureDir: string | undefined, phase: string | undefined): {
  launchAt: string | null;
  transitions: ProgressSource[];
} {
  if (!featureDir || !phase) return { launchAt: null, transitions: [] };
  const file = join(featureDir, `.${phase}-result.json`);
  const result = readJsonTolerant<Record<string, unknown>>(file);
  if (result.status !== 'ok') return { launchAt: null, transitions: [] };
  const value = result.value;
  const launchAt = stringField(value.startedAt) ?? null;
  const transitions: ProgressSource[] = [];
  if (launchAt) transitions.push({ kind: 'transition', at: launchAt, detail: `${phase}.startedAt` });
  const finishedAt = stringField(value.finishedAt);
  if (finishedAt) transitions.push({ kind: 'transition', at: finishedAt, detail: `${phase}.finishedAt` });
  const updated = stringField(value.updated);
  if (updated) transitions.push({ kind: 'transition', at: updated, detail: `${phase}.updated` });
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

  const transitionSources: ProgressSource[] = [...stageTransitions];
  if (opts.task?.updated) {
    transitionSources.push({ kind: 'transition', at: opts.task.updated, detail: 'task.updated' });
  }
  for (const s of opts.extraTransitionSources ?? []) {
    transitionSources.push(s);
  }

  const prState = opts.task?.lifecycle?.deliveryEvidence?.prState ?? null;
  const prNumber = opts.task?.lifecycle?.deliveryEvidence?.prNumber ?? null;
  const outcome = opts.task?.lifecycle?.workflowOutcome ?? null;
  const terminalAt = opts.task?.updated ?? null;

  const blockingPrompt = matchBlockingPromptFromPaneText(opts.paneText);

  return {
    issue: opts.issue,
    hookFile,
    terminalHistoryIdleAt: historyIdleAt,
    latestCommitAt,
    launchAt,
    worktreeMtimeAt: wt.at,
    worktreeMtimePath: wt.path,
    statusFileMtimeAt,
    transitionSources,
    terminal: {
      prState,
      prNumber,
      lifecycleOutcome: outcome,
      at: terminalAt,
    },
    agentProcessLive: opts.agentProcessLive ?? null,
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
 */
export function progressCacheIsFresh(payload: TaskProgress, maxAgeSeconds: number, now: Date = new Date()): boolean {
  const computedAtMs = parseIsoToMs(payload.computedAt);
  if (computedAtMs === null) return false;
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
