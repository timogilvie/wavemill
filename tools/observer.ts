#!/usr/bin/env -S npx tsx
import { isJobBackedIncident, readAuthoritativeWorkflowJobs, reconcileIncidentForFiling } from '../shared/lib/incident-filing-reconciler.ts';
import { ISSUE_ID_RE } from '../shared/lib/task-identity.ts';

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mutateJsonState, mutateJsonStateSync } from '../shared/lib/state-mutex.ts';
import {
  termCapture,
  termListPanes,
  termListSessions,
  termPaneHandle,
  termSessionEnv,
} from '../shared/lib/terminal-backend.ts';
import {
  getIncidentConfig,
  getMillConfig,
  getObserverAlertsConfig,
  getObserverAutoFixConfig,
  getObserverLinearConfig,
  loadWavemillConfig,
  resolveObserverLinearModeSource,
  resolveSessionCapabilities,
  type ObserverAlertsConfig,
  type ObserverAutoFixConfig,
  type ObserverLinearConfig,
  type SessionCapabilities,
} from '../shared/lib/config.ts';
import { measureBranchBaseDistance, updateBranchWithBase } from '../shared/lib/promotion-controller.ts';
import {
  appendAutoFixActionRecords,
  runObserverAutoFixes,
  type AutoFixCandidateFinding,
  type AutoFixDeps,
  type AutoFixRepoContext,
  type AutoFixTask,
} from '../shared/lib/observer-auto-fix.ts';
import {
  detectDesktopPlatform,
  runObserverAlerts,
  sendDesktopNotification,
  sendPushNotification,
  type AlertFinding,
  type AlertJournal,
} from '../shared/lib/observer-alerts.ts';
import { abortTaskInState } from '../shared/lib/task-abort.ts';
import { getResultFilePath, type ReadyArtifacts, type StageResult } from '../shared/lib/stage-result.ts';
import { detectIncidentsForRepo, detectIncidentsForTask } from '../shared/lib/wavemill-incident-detector.ts';
import { buildTendCandidates } from '../shared/lib/wavemill-incident-tend-candidates.ts';
import { evaluateRecoveryPredicate } from '../shared/lib/wavemill-incident-recovery.ts';
import {
  OBSERVER_SNAPSHOT_SCHEMA_VERSION,
  incidentChainEvidenceLines,
  projectRemediationProposals,
  supersedeGenericFindings,
  type RemediationProposalProjection,
} from '../shared/lib/wavemill-incident-projection.ts';
import { IncidentStore } from '../shared/lib/wavemill-incident-store.ts';
import { createIncidentDraft, type IncidentRecord, type IncidentRootCauseClass } from '../shared/lib/wavemill-incident-model.ts';
import { createLookupBudget, syncIncident, syncIncidentLifecycle, type LifecycleSyncResult, type SyncResult } from '../shared/lib/incident-to-linear-synchronizer.ts';
import {
  appendShadowRecord,
  buildShadowAuditRecord,
  updateShadowCounters,
  type ShadowAuditRecord,
} from '../shared/lib/observer-shadow-audit.ts';
import { drainIncidentQueue, enqueueIncidentSync } from '../shared/lib/incident-linear-retry-queue.ts';
import { acquireObserverLock } from '../shared/lib/tend-singleton.ts';
import { countRejectedEvalRecords, listRejectedEvalRecords } from '../shared/lib/eval-rejected-store.ts';
import { renderObserverStatus } from '../shared/lib/observer-status-renderer.ts';
import {
  detectGlobalConfigIntegrity,
  detectRepoConfigIntegrity,
  type ConfigIntegrityIssue,
} from '../shared/lib/config-integrity.ts';
import { normalizeTaskLifecycle, type CleanupEpisode } from '../shared/lib/task-lifecycle.ts';
import {
  deriveQueueAlertProjection,
  type QueueAlertProjection,
} from '../shared/lib/queue-inference-status.ts';
import { readWorkflowState, workflowTaskEntries, type TaskRecord } from '../shared/lib/workflow-state.ts';
import { resolveEffectiveTaskConfig, type EffectiveTaskConfig } from '../shared/lib/effective-task-config.ts';
import {
  getTaskProgress,
  isWavemillControllerProcess,
  matchInteractivePromptSignature as taskProgressMatchInteractivePromptSignature,
  normalizeInteractivePromptText as taskProgressNormalizeInteractivePromptText,
  INTERACTIVE_PROMPT_SIGNATURES as TASK_PROGRESS_INTERACTIVE_PROMPT_SIGNATURES,
  type HookState,
  type TaskProgress,
} from '../shared/lib/task-progress.ts';
import { readWorktreeDirtyStatus, type WorktreeDirtyStatus } from '../shared/lib/worktree-dirty-status.ts';

type Severity = 'urgent' | 'high' | 'medium' | 'low';
const SEVERITIES: readonly Severity[] = ['urgent', 'high', 'medium', 'low'];
// Common non-canonical severities emitted by producers that predate the typed
// union (HOK-3239: tend wrote 'warning'/'info', which fell out of
// findingCounts and alert ranking).
const SEVERITY_ALIASES: Readonly<Record<string, Severity>> = {
  critical: 'urgent',
  fatal: 'urgent',
  error: 'high',
  warning: 'medium',
  warn: 'medium',
  info: 'low',
  informational: 'low',
  debug: 'low',
};

/**
 * Coerce an ingested (untyped) severity to a member of `Severity`.
 *
 * Canonical values pass through; known aliases map to their nearest rank
 * (case-insensitive); missing or unknown values fall back to `'medium'` — the
 * finding stays visible in `findingCounts` but does not trip alerts at the
 * default `minSeverity: 'high'`. Never returns a value outside the union, so
 * `Record<Severity, number>` counters and `SEVERITY_RANK` lookups stay total.
 */
export function normalizeFindingSeverity(raw: unknown): Severity {
  if (typeof raw !== 'string') return 'medium';
  const value = raw.trim().toLowerCase();
  const canonical = SEVERITIES.find((severity) => severity === value);
  if (canonical) return canonical;
  return SEVERITY_ALIASES[value] ?? 'medium';
}

type Category = 'stuck' | 'crash' | 'warning' | 'ux' | 'operational';
type Confidence = 'high' | 'medium' | 'low';
const DEFAULT_OBSERVER_PANE_TITLE = 'Wavemill Observer';
const READY_RECHECK_LOOP_THRESHOLD = 3;
const READY_RECHECK_LOOP_URGENT_THRESHOLD = 6;
const MODEL_DOWNGRADE_THRESHOLD = 3;
// HOK-3244 REQ-F4 / HOK-3210: the mill log tends to repeat a single [status]
// line when a monitor-level loop is spinning without state change (the HOK-3210
// pattern was 67 recreated-window status lines for one task). The generic log
// scan only reads error/warn, so these loops are invisible. Threshold picked
// to clear ordinary startup chatter — a healthy session has 1–2 copies of any
// given status line in a 240-line window.
const REPEATED_STATUS_THRESHOLD = 10;
const REPEATED_STATUS_URGENT_THRESHOLD = 20;
// terminal-task-parked severity floors: age escalation never triggers below these,
// even with a very small --stale-minutes.
const TERMINAL_PARKED_HIGH_FLOOR_MINUTES = 60;
const TERMINAL_PARKED_URGENT_FLOOR_MINUTES = 24 * 60;
const RESIDUE_COMMIT_SUBJECT_LIMIT = 5;
// Active-task unpublished work only becomes an operator condition once the
// task has demonstrably stalled; below this age it is normal in-flight coding.
const STALLED_ACTIVE_UNPUBLISHED_MINUTES = 120;
const PR_CREATE_FAILED_PATTERN = /pull request create failed:?\s*(.*)/i;

// HOK-3096: state-based detector thresholds. These read git/filesystem/config
// state directly rather than mill log lines, so they catch stalls that never
// produce an error/warn log message.
/** A merge-candidate older than this with no active merge consumer is stuck. */
const CANDIDATE_STUCK_MINUTES = 15;
/** Promotions to merge-candidate on the same head within the window below this many times is churn. */
const CANDIDATE_CHURN_THRESHOLD = 3;
const CANDIDATE_CHURN_WINDOW_MINUTES = 30;
/** An exhausted retry sentinel quiet for this long with no newer commit/progress is abandoned. */
const EXHAUSTED_RETRY_QUIET_MINUTES = 10;
/** An active branch more than this many commits behind its base has drifted. */
const BEHIND_BASE_THRESHOLD_COMMITS = 5;

// HOK-3045: closed catalog of interactive agent lifecycle prompts that block
// a task pane. HOK-3101 moved the catalog into shared/lib/task-progress.ts so
// the primitive can surface `blockingPrompt` and the observer can re-use it
// for the incident detector. Adding a new signature must include positive and
// negative fixtures in both `task-progress.test.ts` and `observer.test.ts`.
type InteractivePromptSignature = typeof TASK_PROGRESS_INTERACTIVE_PROMPT_SIGNATURES[number];
const INTERACTIVE_PROMPT_SIGNATURES = TASK_PROGRESS_INTERACTIVE_PROMPT_SIGNATURES;

interface ObserverOptions {
  loop: boolean;
  once: boolean;
  json: boolean;
  compact: boolean;
  intervalSeconds: number;
  staleMinutes: number;
  hungMinutes: number;
  fileLinear: boolean;
  fileIncidents: boolean;
  dryRun: boolean;
  autoFixDryRun: boolean;
  incidentsDryRun: boolean;
  incidentsShadow?: boolean;
  incidentsMode?: 'off' | 'offline' | 'shadow' | 'live';
  incidentsReplay?: string;
  incidentsPolicy?: string;
  linearTeam?: string;
  linearProject?: string;
  linearLabel?: string;
  maxLogLines: number;
  printPrompt: boolean;
  repoDir?: string;
  session?: string;
  serviceMode?: boolean;
  incidentDetector: boolean;
  dependencyThreshold?: number;
}

interface Pane {
  session: string;
  windowIndex: string;
  paneIndex: string;
  windowName: string;
  active: boolean;
  pid: number;
  command: string;
  title: string;
  /** Test seam: pre-captured pane text. When absent, the terminal backend's capture is used. */
  capturedText?: string;
}

interface ProcessRow {
  pid: number;
  ppid: number;
  stat: string;
  elapsedSeconds: number;
  command: string;
}

/**
 * A workflow-state task as the observer sees it: keyed by `issue`, with the
 * read fields taken from {@link TaskRecord} and empty strings normalized to
 * undefined. `pr` is normalized to a string.
 */
type ObservedTask = Pick<
  TaskRecord,
  | 'slug' | 'phase' | 'status' | 'worktree' | 'branch' | 'updated' | 'agent'
  | 'challengeRole' | 'challengePairId' | 'challengeAborted' | 'evalCompleted'
  | 'executionOwner' | 'paneState' | 'lifecycle'
> & {
  issue: string;
  pr?: string;
};

interface Finding {
  id: string;
  severity: Severity;
  category: Category;
  confidence: Confidence;
  session?: string;
  repoDir?: string;
  issue?: string;
  title: string;
  evidence: string[];
  recommendation: string;
  linearIssueUrl?: string;
  occurrenceCount?: number;
  groupedUnder?: string;
  /**
   * Event-style finding that exists for exactly one observer pass (ingested
   * from `observer-findings.jsonl`, which is truncated after reading; the
   * producer dedups per condition). Alerts skip `persistMinutes` for these,
   * since a one-pass finding can never satisfy a persistence window
   * (HOK-3239).
   */
  oneShot?: boolean;
}

interface ReadyWatchdogLogEntry {
  line: string;
  issue: string;
  label: string;
  action: string;
  detail: string;
}

interface ReadyRecheckLogEntry {
  line: string;
  issue: string;
  pr: string;
}

type MillLogLevel = 'error' | 'warn' | 'status' | 'debug' | 'info' | string;

interface MillLogLine {
  raw: string;
  timestamp: string;
  level: MillLogLevel;
  message: string;
}

interface AggregatedMillLogFinding {
  level: 'error' | 'warn';
  normalizedMessage: string;
  lines: string[];
}

interface ModelDowngradeLogEntry {
  line: string;
  stage: string;
  model: string;
  fallback: string;
}

/**
 * A typed coding launch refusal (HOK-3142). `action` is what the monitor did:
 * `rerouted` (coder substituted), `needs-user` (terminalized with the certify
 * command), `retry` (transient resolver failure), or `retry-loop` for the
 * pre-HOK-3142 `Coding launch blocked: [agent-resolution] …` form, which the
 * monitor relaunched on every tick.
 */
interface LaunchRefusalLogEntry {
  line: string;
  issue: string;
  model: string;
  provider: string;
  reason: string;
  certification: string;
  action: string;
  substitute?: string;
  certify?: string;
}

interface RepoSnapshot {
  session: string;
  repoDir: string;
  workflowStatePath?: string;
  millLogPath?: string;
  queueHealthPath?: string;
  queueHealth?: any;
  /** HOK-3207: path to .wavemill/monitor-timing.json, if present. */
  monitorTimingPath?: string;
  /** HOK-3207: parsed .wavemill/monitor-timing.json (undefined on parse errors). */
  monitorTiming?: any;
  tasks: ObservedTask[];
  stateMtime?: string;
  logMtime?: string;
}

interface ObserverSnapshot {
  /** Machine-readable schema id of the `--json` snapshot (HOK-2595); additive changes keep `/1`. */
  schemaVersion?: typeof OBSERVER_SNAPSHOT_SCHEMA_VERSION;
  timestamp: string;
  sessions: string[];
  panes: Pane[];
  processes: ProcessRow[];
  repos: RepoSnapshot[];
  findings: Finding[];
  incidents?: IncidentRecord[];
  /** Typed, validated remediation proposals from non-resolved incidents; never authorization. */
  remediationProposals?: RemediationProposalProjection[];
  /** Proposals dropped because they failed `validateRemediationProposal`. */
  remediationProposalErrors?: number;
  /** Incidents resolved this tick because their recovery predicate held. */
  recoveredIncidents?: Array<{ fingerprint: string; rootCauseClass: IncidentRootCauseClass; reason: string; evidence?: string }>;
  incidentSync?: IncidentSyncSnapshot;
}

interface IncidentSyncShadowSnapshot {
  eligible: number;
  proposedCreate: number;
  proposedUpdate: number;
  noOp: number;
  skipRecovered: number;
  ambiguous: number;
  redactionFailures: number;
  correlationCollisions: number;
  mutationAttempts: number;
  auditPath?: string;
  countersPath?: string;
  lookupBudgetUsed?: number;
  lookupBudgetMax?: number;
  lookupBudgetExhausted?: boolean;
}

interface IncidentSyncSnapshot {
  mode?: 'off' | 'offline' | 'shadow' | 'live';
  totalProcessed: number;
  created: number;
  updated: number;
  failed: number;
  skipped: number;
  queued: number;
  retryProcessed: number;
  retrySucceeded: number;
  retryFailed: number;
  /** Lifecycle transition sync counters (HOK-3035). */
  lifecycleSynced: number;
  lifecycleFailed: number;
  lifecycleRetried: number;
  lifecycleResults: LifecycleSyncResult[];
  results: SyncResult[];
  errors: Array<{ fingerprint: string; action: string; reason: string; nextRetry?: string }>;
  shadow?: IncidentSyncShadowSnapshot;
  /**
   * HOK-3243: per-class incident counts dropped before Linear filing by
   * `observer.linear.suppress.classes`. Still counted in `skipped`.
   */
  suppressedByClass?: Partial<Record<IncidentRootCauseClass, number>>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_INTERVAL_SECONDS = 120;
const DEFAULT_STALE_MINUTES = 10;
const DEFAULT_HUNG_MINUTES = 10;

function usage(): string {
  return `Wavemill Observer

Usage:
  wavemill observer [options]

Options:
  --once                 Run one observation pass and exit (default)
  --loop                 Watch continuously
  --interval <seconds>   Loop interval (default: ${DEFAULT_INTERVAL_SECONDS})
  --json                 Emit JSON snapshots
  --compact              One line per actionable finding; rolls up log-scrape noise
  --file-linear          Create Linear issues for high-confidence findings
  --file-incidents       Create/update Linear issues for confirmed deduplicated incidents
  --incidents-dry-run    Preview incident Linear actions without writes (alias for --incidents-mode=offline)
  --incidents-shadow     Shadow-audit incident Linear actions (bounded reads, zero mutations)
  --incidents-mode <off|offline|shadow|live>
                         Explicit incident sync mode. Overrides legacy dry-run/enabled flags.
  --incidents-replay <fingerprint>
                         Re-sync one incident fingerprint and bypass update cooldown
  --incidents-policy <json>
                         Override observer.linear.policies for this run
  --linear-team <key>    Linear team key/name/id for filed issues
  --linear-project <id>  Optional Linear project id/name for filed issues
  --linear-label <name>  Optional Linear label name to attach
  --dry-run              Suppress legacy --file-linear writes (does not gate
                         auto-fix; use --autofix-dry-run for that).
  --autofix-dry-run      Preview auto-fix actions without applying them.
  --stale-minutes <n>    State/log/marker stale threshold (default: ${DEFAULT_STALE_MINUTES})
  --hung-minutes <n>     Child process hung threshold (default: ${DEFAULT_HUNG_MINUTES})
  --max-log-lines <n>    Recent mill log lines to inspect (default: 240)
  --repo-dir <path>      Limit service observation to one repository
  --session <name>       Limit service observation to one tmux session
  --no-incident-detector Disable repo-local incident reconciliation
  --dependency-threshold <n>
                         Consecutive dependency observations before incident escalation
  --print-prompt         Print the recommended long-running Codex prompt
  --help                 Show this help
`;
}

export function parseArgs(argv: string[]): ObserverOptions {
  const options: ObserverOptions = {
    loop: false,
    once: true,
    json: false,
    compact: false,
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    staleMinutes: DEFAULT_STALE_MINUTES,
    hungMinutes: DEFAULT_HUNG_MINUTES,
    fileLinear: false,
    fileIncidents: false,
    dryRun: false,
    autoFixDryRun: false,
    incidentsDryRun: false,
    maxLogLines: 240,
    printPrompt: false,
    serviceMode: process.env.WAVEMILL_OBSERVER_SERVICE === '1',
    incidentDetector: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      i += 1;
      return value;
    };

    if (arg === '--help' || arg === '-h') {
      process.stdout.write(usage());
      process.exit(0);
    } else if (arg === '--once') {
      options.once = true;
      options.loop = false;
    } else if (arg === '--loop') {
      options.loop = true;
      options.once = false;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--compact') {
      options.compact = true;
    } else if (arg === '--file-linear') {
      options.fileLinear = true;
    } else if (arg === '--file-incidents') {
      options.fileIncidents = true;
    } else if (arg === '--incidents-dry-run') {
      options.incidentsDryRun = true;
      options.fileIncidents = true;
    } else if (arg === '--incidents-shadow') {
      options.incidentsShadow = true;
      options.fileIncidents = true;
    } else if (arg === '--incidents-mode') {
      options.incidentsMode = parseIncidentsMode(next());
      options.fileIncidents = true;
    } else if (arg.startsWith('--incidents-mode=')) {
      options.incidentsMode = parseIncidentsMode(arg.slice('--incidents-mode='.length));
      options.fileIncidents = true;
    } else if (arg === '--incidents-replay') {
      options.incidentsReplay = next();
      options.fileIncidents = true;
    } else if (arg.startsWith('--incidents-replay=')) {
      options.incidentsReplay = arg.slice('--incidents-replay='.length);
      options.fileIncidents = true;
    } else if (arg === '--incidents-policy') {
      options.incidentsPolicy = next();
      options.fileIncidents = true;
    } else if (arg.startsWith('--incidents-policy=')) {
      options.incidentsPolicy = arg.slice('--incidents-policy='.length);
      options.fileIncidents = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--autofix-dry-run') {
      options.autoFixDryRun = true;
    } else if (arg === '--print-prompt') {
      options.printPrompt = true;
    } else if (arg === '--no-incident-detector') {
      options.incidentDetector = false;
    } else if (arg === '--interval') {
      options.intervalSeconds = parsePositiveInt(next(), arg);
    } else if (arg.startsWith('--interval=')) {
      options.intervalSeconds = parsePositiveInt(arg.slice('--interval='.length), '--interval');
    } else if (arg === '--stale-minutes') {
      options.staleMinutes = parsePositiveInt(next(), arg);
    } else if (arg.startsWith('--stale-minutes=')) {
      options.staleMinutes = parsePositiveInt(arg.slice('--stale-minutes='.length), '--stale-minutes');
    } else if (arg === '--hung-minutes') {
      options.hungMinutes = parsePositiveInt(next(), arg);
    } else if (arg.startsWith('--hung-minutes=')) {
      options.hungMinutes = parsePositiveInt(arg.slice('--hung-minutes='.length), '--hung-minutes');
    } else if (arg === '--max-log-lines') {
      options.maxLogLines = parsePositiveInt(next(), arg);
    } else if (arg.startsWith('--max-log-lines=')) {
      options.maxLogLines = parsePositiveInt(arg.slice('--max-log-lines='.length), '--max-log-lines');
    } else if (arg === '--dependency-threshold') {
      options.dependencyThreshold = parsePositiveInt(next(), arg);
    } else if (arg.startsWith('--dependency-threshold=')) {
      options.dependencyThreshold = parsePositiveInt(arg.slice('--dependency-threshold='.length), '--dependency-threshold');
    } else if (arg === '--repo-dir') {
      options.repoDir = resolve(next());
    } else if (arg.startsWith('--repo-dir=')) {
      options.repoDir = resolve(arg.slice('--repo-dir='.length));
    } else if (arg === '--session') {
      options.session = next();
    } else if (arg.startsWith('--session=')) {
      options.session = arg.slice('--session='.length);
    } else if (arg === '--linear-team') {
      options.linearTeam = next();
    } else if (arg.startsWith('--linear-team=')) {
      options.linearTeam = arg.slice('--linear-team='.length);
    } else if (arg === '--linear-project') {
      options.linearProject = next();
    } else if (arg.startsWith('--linear-project=')) {
      options.linearProject = arg.slice('--linear-project='.length);
    } else if (arg === '--linear-label') {
      options.linearLabel = next();
    } else if (arg.startsWith('--linear-label=')) {
      options.linearLabel = arg.slice('--linear-label='.length);
    } else {
      throw new Error(`Unknown observer option: ${arg}`);
    }
  }

  if (options.serviceMode && options.fileLinear) {
    throw new Error('--file-linear is not allowed when WAVEMILL_OBSERVER_SERVICE=1');
  }

  return options;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseIncidentsMode(value: string): 'off' | 'offline' | 'shadow' | 'live' {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'off' || normalized === 'offline' || normalized === 'shadow' || normalized === 'live') {
    return normalized;
  }
  throw new Error(`--incidents-mode must be off|offline|shadow|live, got ${JSON.stringify(value)}`);
}

function run(command: string, args: string[], timeoutMs = 10_000, cwd?: string): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(command, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
    });
    return { ok: true, stdout, stderr: '' };
  } catch (error: any) {
    return {
      ok: false,
      stdout: error.stdout?.toString() ?? '',
      stderr: error.stderr?.toString() ?? error.message ?? String(error),
    };
  }
}

function shell(command: string, timeoutMs = 10_000): { ok: boolean; stdout: string; stderr: string } {
  return run('/bin/bash', ['-lc', command], timeoutMs);
}

function parseElapsed(value: string): number {
  const parts = value.trim().split('-');
  let days = 0;
  let time = parts[0];
  if (parts.length === 2) {
    days = Number.parseInt(parts[0], 10) || 0;
    time = parts[1];
  }
  const nums = time.split(':').map((part) => Number.parseInt(part, 10) || 0);
  if (nums.length === 3) {
    return days * 86400 + nums[0] * 3600 + nums[1] * 60 + nums[2];
  }
  if (nums.length === 2) {
    return days * 86400 + nums[0] * 60 + nums[1];
  }
  return days * 86400 + (nums[0] || 0);
}

function listSessions(): string[] {
  return termListSessions({ timeoutMs: 5_000 });
}

function listPanes(): Pane[] {
  return termListPanes({ timeoutMs: 5_000 }).map((row) => ({
    session: row.session,
    windowIndex: row.windowIndex,
    paneIndex: row.paneIndex,
    windowName: row.windowName,
    active: row.active,
    pid: row.pid,
    command: row.currentCommand,
    title: row.title,
  }));
}

function sessionEnv(session: string): Record<string, string> {
  return termSessionEnv(session, { timeoutMs: 5_000 });
}

function processRows(): ProcessRow[] {
  const result = shell("ps -axo pid=,ppid=,stat=,etime=,command= | sed -n '1,20000p'", 10_000);
  if (!result.ok) {
    return [];
  }
  return result.stdout.split('\n').map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
    if (!match) return null;
    return {
      pid: Number.parseInt(match[1], 10),
      ppid: Number.parseInt(match[2], 10),
      stat: match[3],
      elapsedSeconds: parseElapsed(match[4]),
      command: truncate(match[5], 800),
    };
  }).filter((row): row is ProcessRow => row !== null);
}

function filterRelevantProcesses(rows: ProcessRow[], panes: Pane[]): ProcessRow[] {
  const byParent = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const children = byParent.get(row.ppid) ?? [];
    children.push(row);
    byParent.set(row.ppid, children);
  }

  const relevant = new Set<number>();
  const queue: number[] = [];
  for (const pane of panes) {
    if (pane.pid > 0) {
      relevant.add(pane.pid);
      queue.push(pane.pid);
    }
  }
  for (const row of rows) {
    if (isWavemillProcess(row.command)) {
      relevant.add(row.pid);
      queue.push(row.pid);
      if (row.ppid > 0) relevant.add(row.ppid);
    }
  }

  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const child of byParent.get(parent) ?? []) {
      if (relevant.has(child.pid)) continue;
      relevant.add(child.pid);
      queue.push(child.pid);
    }
  }

  return rows.filter((row) => relevant.has(row.pid));
}

function isWavemillProcess(command: string): boolean {
  return /wavemill|\/tmp\/wavemill-monitor|tend\.ts|observer\.ts|plan-queue\.ts|ready-watchdog|tmux attach -t wavemill/.test(command);
}

function readWorkflowTasks(stateFile: string): ObservedTask[] {
  return workflowTaskEntries(readWorkflowState(stateFile)).map(([issue, task]) => ({
    issue,
    slug: stringValue(task.slug),
    phase: stringValue(task.phase),
    status: stringValue(task.status),
    pr: stringValue(task.pr),
    worktree: stringValue(task.worktree),
    branch: stringValue(task.branch),
    updated: stringValue(task.updated),
    agent: stringValue(task.agent),
    challengeRole: stringValue(task.challengeRole),
    challengePairId: stringValue(task.challengePairId),
    challengeAborted: stringValue(task.challengeAborted),
    evalCompleted: task.evalCompleted === true,
    executionOwner: stringValue(task.executionOwner) as TaskRecord['executionOwner'],
    paneState: stringValue(task.paneState) as TaskRecord['paneState'],
    lifecycle: task.lifecycle && typeof task.lifecycle === 'object' && !Array.isArray(task.lifecycle)
      ? task.lifecycle
      : undefined,
  }));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function taskCleanupEpisode(task: ObservedTask): CleanupEpisode | undefined {
  const lifecycle = task.lifecycle && typeof task.lifecycle === 'object' && !Array.isArray(task.lifecycle)
    ? task.lifecycle as Record<string, unknown>
    : undefined;
  const episode = lifecycle?.cleanupEpisode;
  if (!episode || typeof episode !== 'object' || Array.isArray(episode)) return undefined;
  const record = episode as Record<string, unknown>;
  if (typeof record.fingerprint !== 'string' || typeof record.disposition !== 'string') return undefined;
  return record as CleanupEpisode;
}

type ResidueDisposition =
  | 'retained-by-policy'
  | 'unpublished-at-risk'
  | 'squash-delivered'
  | 'dirty-worktree'
  | 'verification-unavailable'
  | 'already-reaped'
  | 'transient'
  | 'clean'
  | 'residue-retained';

interface ClassifiedResidue {
  disposition: ResidueDisposition;
  severity?: Severity;
  suppressResidueFinding: boolean;
  recommendation: string;
  evidence: string[];
}

function lifecycleRecord(task: ObservedTask): Record<string, unknown> {
  return task.lifecycle && typeof task.lifecycle === 'object' && !Array.isArray(task.lifecycle)
    ? task.lifecycle as Record<string, unknown>
    : {};
}

function taskDeliveryEvidence(task: ObservedTask): Record<string, unknown> {
  const delivery = lifecycleRecord(task).deliveryEvidence;
  return delivery && typeof delivery === 'object' && !Array.isArray(delivery) ? delivery as Record<string, unknown> : {};
}

function evidenceString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function deliveryEvidenceProvesMerged(task: ObservedTask): boolean {
  const evidence = taskDeliveryEvidence(task);
  const state = evidenceString(evidence.prState)?.toUpperCase();
  return Boolean(evidenceString(evidence.mergeSha) && (!state || state === 'MERGED'));
}

// HOK-3088: cap the number of dirty-status paths inlined into a finding so a
// very large delta stays readable without hiding the fact that more work exists.
const DIRTY_WORKTREE_PATH_LIMIT = 8;

function renderDirtyWorktreeRecommendation(task: ObservedTask, worktreeDirty: WorktreeDirtyStatus): string {
  if (worktreeDirty.state === 'unreadable') {
    return `Observer could not read ${task.worktree ?? 'the task worktree'}'s git status. Inspect the worktree by hand before terminalizing cleanup; do not abort or reap while the risk state is unknown.`;
  }
  return `The worktree still holds uncommitted or untracked work that is not on any branch. Recover it first: commit and push the task branch and open or update a draft PR, or copy the files off the worktree, before terminalizing cleanup. Never run \`wavemill mill abort ${task.issue}\` while the tree is dirty - the reap deletes these files.`;
}

function renderCleanupRecommendation(disposition: ResidueDisposition, task: ObservedTask, config: EffectiveTaskConfig, residue?: BranchResidue, worktreeDirty?: WorktreeDirtyStatus): string {
  const branch = residue?.branch ?? taskBranch(task) ?? task.branch ?? 'the task branch';
  const base = config.baseBranch.value;
  const policy = config.remoteBranchDeletionPolicy?.value;
  switch (disposition) {
    case 'squash-delivered':
      return `Delivery evidence proves the PR merged; no branch recreation is needed. Let cleanup finish under the recorded branch deletion policy.`;
    case 'already-reaped':
      return `Cleanup evidence says resources were reaped already; no operator action is needed unless fresh task state appears.`;
    case 'retained-by-policy':
      return `The recorded cleanup policy does not authorize deleting ${branch}; leave it retained or update the policy through the normal controller path after verification.`;
    case 'dirty-worktree':
      if (worktreeDirty && (worktreeDirty.state === 'dirty' || worktreeDirty.state === 'unreadable')) {
        return renderDirtyWorktreeRecommendation(task, worktreeDirty);
      }
      return taskCleanupEpisode(task)?.requiredOperatorAction ?? `Inspect ${branch}'s worktree, commit or discard local changes, then run wavemill cleanup ${task.issue} --dry-run again.`;
    case 'transient':
      return taskCleanupEpisode(task)?.requiredOperatorAction ?? `Wait for the scheduled cleanup retry, then inspect cleanup evidence if it remains unchanged.`;
    case 'verification-unavailable':
      return `Observer could not verify ${branch} against ${base}. Fetch remote evidence and inspect cleanup state before treating commits as lost.`;
    case 'unpublished-at-risk':
      return `Recover the work first: push ${branch} to origin and open or update a PR against ${base}, or explicitly abandon the branch, before terminalizing cleanup.`;
    case 'residue-retained':
      return taskCleanupEpisode(task)?.requiredOperatorAction ?? `Run wavemill cleanup ${task.issue} --dry-run and follow the recorded cleanup disposition for ${branch}; do not recreate a branch unless delivery evidence is absent and recovery requires it.`;
    case 'clean':
    default:
      if (policy?.allowed === false) return `No work is ahead of ${base}; keep retained resources only if the recorded policy requires it.`;
      return `No branch work is ahead of ${base}; let the mill reap any remaining local resources through the normal cleanup path.`;
  }
}

/**
 * HOK-3088: read the worktree's dirty status through the shared predicate.
 * A missing worktree reports `absent` (safe to treat as clean by callers that
 * already know the worktree has been reaped). A git failure reports
 * `unreadable` and callers must not treat that as clean.
 */
function inspectTaskWorktreeDirty(worktree: string | undefined): WorktreeDirtyStatus {
  if (!worktree) return { state: 'absent', lines: [], raw: '' };
  return readWorktreeDirtyStatus({ worktree });
}

function dirtyWorktreeEvidence(worktreeDirty: WorktreeDirtyStatus): string[] {
  if (worktreeDirty.state === 'clean' || worktreeDirty.state === 'absent') return [];
  if (worktreeDirty.state === 'unreadable') {
    return ['worktreeDirty=unreadable', 'potentialWorkLoss=true'];
  }
  const shown = worktreeDirty.lines.slice(0, DIRTY_WORKTREE_PATH_LIMIT);
  const evidence: string[] = [
    'worktreeDirty=true',
    'potentialWorkLoss=true',
    `dirtyPathCount=${worktreeDirty.lines.length}`,
    ...shown.map((line) => `dirtyPath=${line}`),
  ];
  if (worktreeDirty.lines.length > shown.length) {
    evidence.push(`dirtyPathTruncated=${worktreeDirty.lines.length - shown.length}`);
  }
  return evidence;
}

function classifyResidue(task: ObservedTask, config: EffectiveTaskConfig, residue?: BranchResidue, worktreeDirty?: WorktreeDirtyStatus): ClassifiedResidue {
  const episode = taskCleanupEpisode(task);
  const delivery = taskDeliveryEvidence(task);
  const evidence: string[] = [
    `effectiveBaseBranch=${config.baseBranch.value}`,
    `baseBranchSource=${config.baseBranch.source}`,
  ];
  if (config.baseBranch.driftFromRepoConfig !== undefined) {
    evidence.push(`repoConfigBaseBranch=${config.baseBranch.driftFromRepoConfig}`);
  }
  if (evidenceString(delivery.mergeSha)) evidence.push(`deliveryMergeSha=${delivery.mergeSha}`);
  if (evidenceString(delivery.prHeadSha)) evidence.push(`deliveryPrHeadSha=${delivery.prHeadSha}`);
  if (episode?.fingerprint) evidence.push(`cleanupFingerprint=${episode.fingerprint}`);
  if (episode?.disposition) evidence.push(`cleanupDisposition=${episode.disposition}`);
  if (residue?.baseRef) evidence.push(`comparedAgainst=${residue.baseRef}`);
  if (residue?.aheadOfBase !== undefined) evidence.push(`aheadOfEffectiveBase=${residue.aheadOfBase}`);
  const dirtyEvidence = worktreeDirty ? dirtyWorktreeEvidence(worktreeDirty) : [];
  evidence.push(...dirtyEvidence);

  // HOK-3088: the branch-only shortcut (aheadOfBase==0 or unpushedCommits==0)
  // used to fall through to `clean`, so a task at base with a dirty tree got
  // "nothing at risk" advice. A dirty (or unreadable) tree takes precedence
  // over every branch-derived disposition except the ones that already prove
  // the work is safely elsewhere (squash-delivered, already-reaped).
  const worktreeAtRisk = worktreeDirty?.state === 'dirty' || worktreeDirty?.state === 'unreadable';

  let disposition: ResidueDisposition = 'verification-unavailable';
  if (deliveryEvidenceProvesMerged(task)) {
    disposition = 'squash-delivered';
  } else if (episode?.disposition === 'reaped') {
    disposition = 'already-reaped';
  } else if (worktreeAtRisk) {
    // Same at-risk verdict as cleanup's `dirty_worktree` refusal in
    // shared/lib/terminal-inbox-cleanup.ts, via the shared filter helper.
    disposition = 'dirty-worktree';
  } else if (config.remoteBranchDeletionPolicy?.value.allowed === false) {
    disposition = 'retained-by-policy';
  } else if (episode?.disposition === 'needs-user' && /dirty/i.test(`${episode.failureClass} ${episode.lastOutcome ?? ''} ${episode.requiredOperatorAction ?? ''} ${JSON.stringify(episode.fingerprintInputs ?? {})}`)) {
    disposition = 'dirty-worktree';
  } else if (episode?.disposition === 'transient') {
    disposition = 'transient';
  } else if (episode && episode.disposition !== 'pending' && episode.disposition !== 'reaping') {
    disposition = 'residue-retained';
  } else if (residue?.aheadOfBase === 0 || residue?.unpushedCommits === 0) {
    disposition = 'clean';
  } else if ((residue?.unpushedCommits ?? 0) > 0 && residue?.remoteBranch === 'absent') {
    disposition = 'unpublished-at-risk';
  } else if (residue && residue.remoteBranch === 'unknown') {
    disposition = 'verification-unavailable';
  }

  const suppressResidueFinding = disposition === 'squash-delivered'
    || disposition === 'already-reaped'
    || disposition === 'retained-by-policy'
    || disposition === 'transient'
    || disposition === 'residue-retained';
  const severity: Severity | undefined = disposition === 'unpublished-at-risk'
    ? 'urgent'
    : disposition === 'verification-unavailable'
      ? 'medium'
      : disposition === 'dirty-worktree'
        ? (worktreeAtRisk ? 'urgent' : 'high')
        : undefined;

  return {
    disposition,
    severity,
    suppressResidueFinding,
    evidence: [`residueDisposition=${disposition}`, ...evidence],
    recommendation: renderCleanupRecommendation(disposition, task, config, residue, worktreeDirty),
  };
}

function resolveObserverTaskConfig(repo: RepoSnapshot, issue: string, task?: ObservedTask): EffectiveTaskConfig {
  return resolveEffectiveTaskConfig({
    repoDir: repo.repoDir,
    issue,
    stateFile: repo.workflowStatePath,
    ...(task ? { taskState: task as unknown as Record<string, unknown> } : {}),
  });
}

function observerBaseBranchForIssue(repo: RepoSnapshot, issue?: string): string {
  if (issue) {
    const task = repo.tasks.find((candidate) => candidate.issue === issue);
    return resolveObserverTaskConfig(repo, issue, task).baseBranch.value;
  }
  try {
    return resolveEffectiveTaskConfig({ repoDir: repo.repoDir, issue: '__repo__', stateFile: repo.workflowStatePath }).baseBranch.value;
  } catch {
    return 'main';
  }
}

function effectiveConfigDriftFinding(repo: RepoSnapshot, task: ObservedTask, config: EffectiveTaskConfig): Finding | undefined {
  const evidence: string[] = [];
  if (config.baseBranch.driftFromRepoConfig !== undefined) {
    evidence.push(`baseBranch=${config.baseBranch.value}`);
    evidence.push(`baseBranchSource=${config.baseBranch.source}`);
    evidence.push(`repoConfigBaseBranch=${config.baseBranch.driftFromRepoConfig}`);
  }
  if (config.requireConfirm.driftFromRepoConfig !== undefined) {
    evidence.push(`requireConfirm=${config.requireConfirm.value}`);
    evidence.push(`requireConfirmSource=${config.requireConfirm.source}`);
    evidence.push(`repoConfigRequireConfirm=${config.requireConfirm.driftFromRepoConfig}`);
  }
  if (evidence.length === 0) return undefined;
  return {
    id: `config-drift-${repo.session}-${task.issue}-${hashText(evidence.join('|'))}`,
    severity: 'low',
    category: 'operational',
    confidence: 'high',
    session: repo.session,
    repoDir: repo.repoDir,
    issue: task.issue,
    title: `${task.issue} uses task-specific effective configuration`,
    evidence: ['informational=true', ...evidence],
    recommendation: 'No recovery is required when this matches the launch contract or runtime snapshot; status shows the effective value and its source.',
  };
}

function cleanupRootCause(disposition: ResidueDisposition): IncidentRootCauseClass | undefined {
  switch (disposition) {
    case 'residue-retained':
    case 'retained-by-policy': return 'cleanup_retained_by_policy';
    case 'unpublished-at-risk': return 'cleanup_unpublished_at_risk';
    case 'transient':
    case 'verification-unavailable': return 'cleanup_verification_unavailable';
    case 'dirty-worktree': return 'cleanup_dirty_worktree';
    default: return undefined;
  }
}

function cleanupEvidenceKey(task: ObservedTask, config: EffectiveTaskConfig, residue?: BranchResidue): string {
  const delivery = taskDeliveryEvidence(task);
  const episode = taskCleanupEpisode(task);
  return [
    config.baseBranch.value,
    delivery.mergeSha ?? delivery.prHeadSha ?? residue?.aheadOfBase ?? 'no-head-evidence',
    episode?.fingerprint ?? 'no-cleanup-fingerprint',
  ].join(':');
}

function detectCleanupIncidentsForRepo(repo: RepoSnapshot, timestamp: string, progressLookup?: (task: ObservedTask) => TaskProgress | undefined): IncidentRecord[] {
  const incidents: IncidentRecord[] = [];
  const parsedNow = Date.parse(timestamp);
  const now = Number.isFinite(parsedNow) ? parsedNow : Date.now();
  const lookup = progressLookup ?? makeProgressLookup(repo, now);
  for (const task of repo.tasks) {
    const config = resolveObserverTaskConfig(repo, task.issue, task);
    const branch = taskBranch(task);
    const residue = branch ? inspectTaskBranchResidue(repo.repoDir, branch, config.baseBranch.value) : undefined;
    const worktreeDirty = inspectTaskWorktreeDirty(task.worktree);
    const classified = classifyResidue(task, config, residue, worktreeDirty);
    const rootCauseClass = cleanupRootCause(classified.disposition);
    // Cleanup incidents require terminal lifecycle evidence or a persisted
    // cleanup episode. An ordinary active coding branch that is ahead and not
    // yet pushed is delivery risk, not cleanup failure (HOK-2972).
    const hasCleanupContext = taskHasTerminalResidueStatus(task) || Boolean(taskCleanupEpisode(task));
    if (rootCauseClass && !hasCleanupContext && classified.disposition === 'unpublished-at-risk') {
      // HOK-3087: prefer the shared primitive's progress age so hook/commit
      // activity on an active task rescues it from the stall incident. The
      // transition-only `taskAgeMinutes` remains the fallback when the
      // primitive has no evidence yet.
      const progress = lookup(task);
      const primitiveAge = progress?.progressAgeMinutes ?? null;
      const fallbackAge = taskAgeMinutes(task, repo, now, lookup);
      const ageMinutes = primitiveAge !== null && Number.isFinite(primitiveAge) ? primitiveAge : fallbackAge;
      if (ageMinutes !== undefined && Number.isFinite(ageMinutes) && ageMinutes > STALLED_ACTIVE_UNPUBLISHED_MINUTES) {
        const progressEvidence: string[] = [];
        if (progress?.lastProgressAt) progressEvidence.push(`lastProgressAt=${progress.lastProgressAt}`);
        if (progress?.sources.length) progressEvidence.push(`progressSources=${progress.sources.map((s) => s.kind).join(',')}`);
        incidents.push(createIncidentDraft({
          taskId: task.issue,
          session: repo.session,
          category: 'configuration_operator_condition',
          severity: 'medium',
          confidence: 'high',
          lifecycle: 'observed',
          rootCauseClass: 'active_unpublished_work_stalled',
          summary: `${task.issue} active task has unpublished commits and has not progressed for ${Math.round(ageMinutes)}m.`,
          operatorAction: `Inspect why ${task.issue} stalled, then let it finish or push ${branch ?? 'the task branch'} to origin. The work is not cleanup residue; do not terminalize or reap it.`,
          evidence: [{
            type: 'workflow_state',
            source: repo.workflowStatePath ?? join(repo.repoDir, '.wavemill', 'workflow-state.json'),
            timestamp,
            redactedData: [`ageMinutes=${Math.round(ageMinutes)}`, ...progressEvidence, ...classified.evidence].join(' '),
            key: `stalled-active-unpublished:${task.issue}:${branch ?? 'no-branch'}`,
          }],
          metadata: { disposition: classified.disposition, effectiveBaseBranch: config.baseBranch.value },
        }));
      }
    }
    if (rootCauseClass && hasCleanupContext) {
      const key = `cleanup:${task.issue}:${classified.disposition}:${cleanupEvidenceKey(task, config, residue)}`;
      incidents.push(createIncidentDraft({
        taskId: task.issue,
        session: repo.session,
        category: classified.disposition === 'verification-unavailable'
          ? 'configuration_operator_condition'
          : 'stale_orphaned_state',
        severity: findingSeverityToIncidentSeverity(classified.severity ?? 'low'),
        confidence: 'high',
        lifecycle: 'observed',
        rootCauseClass,
        summary: `${task.issue} cleanup disposition is ${classified.disposition}.`,
        operatorAction: classified.recommendation,
        evidence: [{
          type: 'workflow_state',
          source: repo.workflowStatePath ?? join(repo.repoDir, '.wavemill', 'workflow-state.json'),
          timestamp: taskCleanupEpisode(task)?.firstAttemptAt ?? task.updated ?? repo.stateMtime ?? timestamp,
          redactedData: [...classified.evidence, ...(residue ? [`unpushedCommits=${residue.unpushedCommits ?? 'unknown'}`, ...residue.commitSubjects.map((subject) => `commit=${subject}`)] : []), ...dirtyWorktreeEvidence(worktreeDirty)].join(' '),
          key,
        }],
        metadata: {
          disposition: classified.disposition,
          effectiveBaseBranch: config.baseBranch.value,
          cleanupFingerprint: taskCleanupEpisode(task)?.fingerprint,
        },
      }));
    }
    // Launch-contract drift on a terminal/superseded record is intentional
    // historical provenance: the immutable contract simply predates the current
    // repo config. It stays visible in status/finding provenance but must not
    // sit in the actionable incident list forever (HOK-1309). Once the task is
    // terminal these candidates stop, so any existing incident resolves under
    // the normal consecutive-missed-cycle aging contract.
    const driftIsHistorical = taskHasTerminalResidueStatus(task);
    if (!driftIsHistorical && config.baseBranch.driftFromRepoConfig !== undefined) {
      incidents.push(createIncidentDraft({
        taskId: task.issue,
        session: repo.session,
        category: 'configuration_operator_condition',
        severity: 'info',
        confidence: 'high',
        lifecycle: 'observed',
        rootCauseClass: 'config_drift_base_branch',
        summary: `${task.issue} effective base branch differs from repository config.`,
        operatorAction: 'No recovery is required for intentional launch/runtime overrides; inspect status provenance if the value is unexpected.',
        evidence: [{
          type: 'workflow_state',
          source: repo.workflowStatePath ?? join(repo.repoDir, '.wavemill', 'workflow-state.json'),
          timestamp,
          redactedData: `baseBranch=${config.baseBranch.value} source=${config.baseBranch.source} repoConfig=${config.baseBranch.driftFromRepoConfig}`,
          key: `config-drift-base:${task.issue}:${config.baseBranch.value}:${config.baseBranch.driftFromRepoConfig}`,
        }],
        metadata: { effectiveBaseBranch: config.baseBranch.value, repoConfigBaseBranch: config.baseBranch.driftFromRepoConfig },
      }));
    }
    if (!driftIsHistorical && config.requireConfirm.driftFromRepoConfig !== undefined) {
      incidents.push(createIncidentDraft({
        taskId: task.issue,
        session: repo.session,
        category: 'configuration_operator_condition',
        severity: 'info',
        confidence: 'high',
        lifecycle: 'observed',
        rootCauseClass: 'config_drift_confirm',
        summary: `${task.issue} effective confirmation policy differs from repository config.`,
        operatorAction: 'No recovery is required for intentional launch/runtime overrides; inspect status provenance if the value is unexpected.',
        evidence: [{
          type: 'workflow_state',
          source: repo.workflowStatePath ?? join(repo.repoDir, '.wavemill', 'workflow-state.json'),
          timestamp,
          redactedData: `requireConfirm=${config.requireConfirm.value} source=${config.requireConfirm.source} repoConfig=${config.requireConfirm.driftFromRepoConfig}`,
          key: `config-drift-confirm:${task.issue}:${config.requireConfirm.value}:${config.requireConfirm.driftFromRepoConfig}`,
        }],
        metadata: { effectiveRequireConfirm: config.requireConfirm.value, repoConfigRequireConfirm: config.requireConfirm.driftFromRepoConfig },
      }));
    }
  }
  return incidents;
}

function findingSeverityToIncidentSeverity(severity: Severity): IncidentRecord['severity'] {
  if (severity === 'urgent') return 'critical';
  if (severity === 'high') return 'high';
  if (severity === 'medium') return 'medium';
  return 'low';
}

/**
 * Parked/terminal-arm incidents (HOK-2927). HOK-2911's pane findings for this
 * class were ephemeral: 67 urgent firings over 2h13m never persisted, deduped,
 * or reached anyone. These detectors mirror the finding gates but emit
 * incident records so fingerprint dedup, occurrence counting, threshold
 * escalation, and the evidence log all apply. Evidence timestamps deliberately
 * use the observer poll timestamp (not artifact mtimes): each poll of a
 * still-parked arm is a distinct occurrence, so occurrenceCount records how
 * long the condition persisted. Evidence *keys* stay stable across polls, so
 * every poll lands on the same fingerprint and re-running the observer over an
 * unchanged repo never creates a new record.
 */
function detectParkedArmIncidents(
  repo: RepoSnapshot,
  snapshot: Pick<ObserverSnapshot, 'panes' | 'processes'>,
  options: ObserverOptions,
  timestamp: string,
): IncidentRecord[] {
  const incidents: IncidentRecord[] = [];
  const parsedNow = Date.parse(timestamp);
  const now = Number.isFinite(parsedNow) ? parsedNow : Date.now();
  const progressLookup = makeProgressLookup(repo, now);

  for (const task of repo.tasks) {
    if (!task.issue) continue;

    // Stage markers the mill has not acted on (mirrors buildMarkerIgnoredFinding gates).
    if (task.worktree && task.slug && !taskWorkflowIsTerminal(task)) {
      const featureDir = join(task.worktree, 'features', task.slug);
      for (const stage of [
        { phase: 'coding', markerName: '.coding-complete' },
        { phase: 'planning', markerName: '.plan-approved' },
      ] as const) {
        if (task.phase !== stage.phase) continue;
        const markerPath = join(featureDir, stage.markerName);
        if (!existsSync(markerPath)) continue;
        const marker = statMarker(markerPath, now);
        if (!marker || marker.ageMs / 60000 <= options.staleMinutes) continue;

        const uncommitted = stage.phase === 'coding' ? readCodingUncommittedOutput(featureDir) : null;
        const launchRefusal = stage.phase === 'planning' ? readCodingLaunchRefusalSentinel(featureDir) : null;
        if (launchRefusal) {
          // HOK-3142: the monitor terminalized a refused coding launch; the
          // recorded reason names the model and the certify command.
          incidents.push(createIncidentDraft({
            taskId: task.issue,
            session: repo.session,
            category: 'stale_orphaned_state',
            severity: 'high',
            confidence: 'high',
            lifecycle: 'observed',
            rootCauseClass: 'coding_launch_refused',
            summary: `${task.issue} is parked at ${stage.markerName}: ${truncate(launchRefusal.reason, 240)}`,
            operatorAction: launchRefusal.reason,
            evidence: [{
              type: 'workflow_state',
              source: launchRefusal.path,
              timestamp,
              redactedData: `bucket=${launchRefusal.bucket} marker=${stage.markerName} markerAgeMinutes=${Math.round(marker.ageMs / 60000)}`,
              key: `coding-launch-refused:${task.issue}:${launchRefusal.bucket}`,
            }],
            metadata: { markerPath, markerMtime: marker.mtimeIso, stage: stage.phase, bucket: launchRefusal.bucket },
          }));
        } else if (uncommitted) {
          // The mill parked this arm on purpose (dirty tree); the missing piece
          // is an operator commit, not a monitor repair.
          incidents.push(createIncidentDraft({
            taskId: task.issue,
            session: repo.session,
            category: 'stale_orphaned_state',
            severity: 'high',
            confidence: 'high',
            lifecycle: 'observed',
            rootCauseClass: 'arm_parked_awaiting_operator_commit',
            summary: `${task.issue} coding is parked awaiting an operator commit: ${truncate(uncommitted.summary ?? CODING_UNCOMMITTED_DEFAULT_SUMMARY, 200)}`,
            operatorAction: buildParkedCommitRecommendation(uncommitted, task.worktree),
            evidence: [{
              type: 'workflow_state',
              source: join(featureDir, '.coding-uncommitted-output.json'),
              timestamp,
              redactedData: [
                `reason=${uncommitted.reason ?? 'coding_output_not_committed'}`,
                `firstDirtyPath=${uncommitted.firstDirtyPath ?? 'unknown'}`,
                `marker=${stage.markerName}`,
                `markerAgeMinutes=${Math.round(marker.ageMs / 60000)}`,
              ].join(' '),
              key: `parked-coding:${task.issue}:${uncommitted.firstDirtyPath ?? 'unknown'}`,
            }],
            metadata: { markerPath, markerMtime: marker.mtimeIso, uncommittedReason: uncommitted.reason },
          }));
        } else {
          incidents.push(createIncidentDraft({
            taskId: task.issue,
            session: repo.session,
            category: 'stale_orphaned_state',
            severity: 'high',
            confidence: 'medium',
            lifecycle: 'observed',
            rootCauseClass: 'stage_marker_not_advanced',
            summary: `${task.issue} has not advanced past ${stage.markerName} in ${stage.phase}.`,
            operatorAction: 'The mill has not acted on this stage marker. Inspect the monitor poll branch, this task\'s hook file, and any hung monitor child process before restarting anything.',
            evidence: [{
              type: 'workflow_state',
              source: markerPath,
              timestamp,
              redactedData: `marker=${stage.markerName} phase=${task.phase} markerAgeMinutes=${Math.round(marker.ageMs / 60000)}`,
              key: `marker-not-advanced:${task.issue}:${stage.phase}`,
            }],
            metadata: { markerPath, markerMtime: marker.mtimeIso, stage: stage.phase },
          }));
        }
      }
    }


  }

  // pr-create-failed diagnostics (mirrors the finding sources: mill log first,
  // then review artifacts, then volatile pane scrollback).
  const logLines = repo.millLogPath ? tailLines(repo.millLogPath, options.maxLogLines) : [];
  const prCreateReportedIssues = new Set<string>();
  const prCreateLogGroups = new Map<string, { lines: string[]; issue?: string }>();
  for (const line of logLines) {
    if (!PR_CREATE_FAILED_PATTERN.test(line)) continue;
    const issue = matchTaskIssueInText(repo, line);
    const key = issue ?? hashText(normalizeMillLogFingerprintMessage(line));
    const group = prCreateLogGroups.get(key) ?? { lines: [], issue };
    group.lines.push(line);
    prCreateLogGroups.set(key, group);
  }
  for (const [groupKey, group] of prCreateLogGroups) {
    if (group.issue) prCreateReportedIssues.add(group.issue);
    incidents.push(prCreateFailedIncident(
      repo,
      group.issue,
      group.lines[group.lines.length - 1],
      repo.millLogPath ?? 'mill-log',
      'high',
      timestamp,
      groupKey,
    ));
  }
  for (const task of repo.tasks) {
    if (prCreateReportedIssues.has(task.issue)) continue;
    const artifactText = readTaskReviewArtifactText(task);
    const artifactMatch = artifactText?.match(PR_CREATE_FAILED_PATTERN);
    if (artifactMatch && task.worktree && task.slug) {
      prCreateReportedIssues.add(task.issue);
      incidents.push(prCreateFailedIncident(
        repo,
        task.issue,
        artifactMatch[0],
        join(task.worktree, 'features', task.slug, '.review-result.json'),
        'high',
        timestamp,
        task.issue,
      ));
      continue;
    }
    for (const pane of taskPaneResidue(repo, task, snapshot.panes).panes) {
      const paneText = capturePaneText(pane);
      const paneMatch = paneText?.match(PR_CREATE_FAILED_PATTERN);
      if (!paneMatch) continue;
      prCreateReportedIssues.add(task.issue);
      incidents.push(prCreateFailedIncident(
        repo,
        task.issue,
        paneMatch[0],
        `pane:${pane.session}:${pane.windowIndex}.${pane.paneIndex}`,
        'medium',
        timestamp,
        task.issue,
      ));
      break;
    }
  }

  return incidents;
}

/**
 * One incident per issue (or per normalized message when no issue matches),
 * keyed independently of the evidence source so a mill-log observation and a
 * pane observation of the same failure share a fingerprint.
 */
function prCreateFailedIncident(
  repo: RepoSnapshot,
  issue: string | undefined,
  rawText: string,
  source: string,
  confidence: IncidentRecord['confidence'],
  timestamp: string,
  key: string,
): IncidentRecord {
  const baseBranch = observerBaseBranchForIssue(repo, issue);
  const raw = truncate(rawText.trim(), 300);
  const translation = translatePrCreateFailure(rawText, baseBranch);
  return createIncidentDraft({
    taskId: issue ?? null,
    session: repo.session,
    category: 'stale_orphaned_state',
    severity: 'high',
    confidence,
    lifecycle: 'observed',
    rootCauseClass: 'pr_create_failed',
    summary: issue
      ? `${issue} failed to create its PR and the arm's work never reached GitHub.`
      : 'A mill arm failed to create its PR and its work never reached GitHub.',
    operatorAction: `Push the task branch to origin and re-create the PR against ${baseBranch}, or explicitly abandon the arm. Check \`git rev-list --count ${baseBranch}..<branch>\` locally before trusting the raw GitHub error text.`,
    evidence: [{
      type: 'log_excerpt',
      source,
      timestamp,
      redactedData: translation ? `raw=${raw} translation=${translation}` : `raw=${raw}`,
      key: `pr-create-failed:${key}`,
    }],
    metadata: { baseBranch },
  });
}

function snapshotRepos(sessions: string[], options: ObserverOptions): RepoSnapshot[] {
  const repos: RepoSnapshot[] = [];
  const seen = new Set<string>();
  if (options.repoDir) {
    const session = options.session || sessions[0] || process.env.WAVEMILL_SESSION || 'unknown';
    const repoDir = options.repoDir;
    const stateDir = join(repoDir, '.wavemill');
    const workflowStatePath = join(stateDir, 'workflow-state.json');
    const queueHealthPath = join(stateDir, 'queue-health.json');
    const monitorTimingPath = join(stateDir, 'monitor-timing.json');
    const logDir = join(stateDir, 'logs');
    const millLogPath = findNewestMillLog(logDir, session);
    let queueHealth: any;
    if (existsSync(queueHealthPath)) {
      try {
        queueHealth = JSON.parse(readFileSync(queueHealthPath, 'utf-8'));
      } catch {
        queueHealth = undefined;
      }
    }
    let monitorTiming: any;
    if (existsSync(monitorTimingPath)) {
      try {
        monitorTiming = JSON.parse(readFileSync(monitorTimingPath, 'utf-8'));
      } catch {
        monitorTiming = undefined;
      }
    }
    repos.push({
      session,
      repoDir,
      workflowStatePath: existsSync(workflowStatePath) ? workflowStatePath : undefined,
      millLogPath,
      queueHealthPath: existsSync(queueHealthPath) ? queueHealthPath : undefined,
      queueHealth,
      monitorTimingPath: existsSync(monitorTimingPath) ? monitorTimingPath : undefined,
      monitorTiming,
      tasks: existsSync(workflowStatePath) ? readWorkflowTasks(workflowStatePath) : [],
      stateMtime: existsSync(workflowStatePath) ? statSync(workflowStatePath).mtime.toISOString() : undefined,
      logMtime: millLogPath && existsSync(millLogPath) ? statSync(millLogPath).mtime.toISOString() : undefined,
    });
    return repos;
  }

  for (const session of sessions) {
    const env = sessionEnv(session);
    const repoDir = env.WAVEMILL_MILL_ACTIVE || env.REPO_DIR;
    if (!repoDir || seen.has(`${session}:${repoDir}`)) continue;
    seen.add(`${session}:${repoDir}`);
    const stateDir = join(repoDir, '.wavemill');
    const workflowStatePath = join(stateDir, 'workflow-state.json');
    const queueHealthPath = join(stateDir, 'queue-health.json');
    const monitorTimingPath = join(stateDir, 'monitor-timing.json');
    const logDir = join(stateDir, 'logs');
    const millLogPath = findNewestMillLog(logDir, session);
    let queueHealth: any;
    if (existsSync(queueHealthPath)) {
      try {
        queueHealth = JSON.parse(readFileSync(queueHealthPath, 'utf-8'));
      } catch {
        queueHealth = undefined;
      }
    }
    let monitorTiming: any;
    if (existsSync(monitorTimingPath)) {
      try {
        monitorTiming = JSON.parse(readFileSync(monitorTimingPath, 'utf-8'));
      } catch {
        monitorTiming = undefined;
      }
    }
    repos.push({
      session,
      repoDir,
      workflowStatePath: existsSync(workflowStatePath) ? workflowStatePath : undefined,
      millLogPath,
      queueHealthPath: existsSync(queueHealthPath) ? queueHealthPath : undefined,
      queueHealth,
      monitorTimingPath: existsSync(monitorTimingPath) ? monitorTimingPath : undefined,
      monitorTiming,
      tasks: existsSync(workflowStatePath) ? readWorkflowTasks(workflowStatePath) : [],
      stateMtime: existsSync(workflowStatePath) ? statSync(workflowStatePath).mtime.toISOString() : undefined,
      logMtime: millLogPath && existsSync(millLogPath) ? statSync(millLogPath).mtime.toISOString() : undefined,
    });
  }
  return repos;
}

function findNewestMillLog(logDir: string, session: string): string | undefined {
  if (!existsSync(logDir)) return undefined;
  const candidates = readdirSync(logDir)
    .filter((name) => name.startsWith('mill-') && name.endsWith('.log'))
    .map((name) => join(logDir, name))
    .filter((path) => existsSync(path));
  const sessionLog = join(logDir, `mill-${session}.log`);
  if (existsSync(sessionLog)) return sessionLog;
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0];
}

function tailLines(path: string, count: number): string[] {
  try {
    const text = readFileSync(path, 'utf8');
    return text.split('\n').slice(-count).filter(Boolean);
  } catch {
    return [];
  }
}

interface MarkerIgnoredConfig {
  phase: 'coding' | 'planning';
  markerName: '.coding-complete' | '.plan-approved';
  idPrefix: 'coding-marker-ignored' | 'plan-marker-ignored' | 'coding-complete-in-planning';
  titlePhase: string;
  /** Used when the mill has not written state since the marker appeared. */
  staleRecommendation: string;
  /**
   * Used when workflow-state.json is newer than the marker. The mill is
   * demonstrably alive but has not advanced this task, so the finding still
   * fires — a newer state file must not suppress it. In a multi-task mill,
   * state is rewritten constantly for other tasks, so suppressing here would
   * hide a genuinely wedged task indefinitely.
   */
  stateAliveRecommendation: string;
  /**
   * Overrides both recommendations when the mill has deliberately parked the
   * task on uncommitted coding output (HOK-2927). Without this branch the
   * urgent finding blamed the monitor's poll branch while the monitor was
   * correctly refusing to advance a dirty tree.
   */
  parkedRecommendation?: (artifact: CodingUncommittedOutput, worktree: string | undefined) => string;
}

const CODING_UNCOMMITTED_DEFAULT_SUMMARY = 'coding completed marker detected, but review cannot start until the coding output is committed';
const CODING_UNCOMMITTED_DEFAULT_ACTION = 'Commit the coding output, then retry review.';

interface CodingUncommittedOutput {
  summary?: string;
  action?: string;
  reason?: string;
  firstDirtyPath?: string;
}

/**
 * Read the mill's dirty-tree parking artifact. Returns null when the artifact
 * is absent, empty, or malformed — callers degrade to the generic
 * marker-not-advanced treatment rather than throwing.
 */
function readCodingUncommittedOutput(featureDir: string): CodingUncommittedOutput | null {
  const artifactPath = join(featureDir, '.coding-uncommitted-output.json');
  if (!existsSync(artifactPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const field = (name: string): string | undefined =>
      typeof parsed[name] === 'string' && (parsed[name] as string).trim().length > 0
        ? (parsed[name] as string).trim()
        : undefined;
    return {
      summary: field('summary'),
      action: field('action'),
      reason: field('reason'),
      firstDirtyPath: field('firstDirtyPath'),
    };
  } catch {
    return null;
  }
}

function buildParkedCommitRecommendation(artifact: CodingUncommittedOutput, worktree: string | undefined): string {
  const summary = artifact.summary ?? CODING_UNCOMMITTED_DEFAULT_SUMMARY;
  const action = artifact.action ?? CODING_UNCOMMITTED_DEFAULT_ACTION;
  return `Coding parked awaiting operator commit: ${summary}. ${action} The monitor is deliberately holding this task on a dirty tree - do not restart it; run \`git status\` in ${worktree ?? 'the task worktree'} first.`;
}

function statMarker(path: string, now: number): { mtimeMs: number; ageMs: number; mtimeIso: string } | undefined {
  try {
    const stat = statSync(path);
    return {
      mtimeMs: stat.mtimeMs,
      ageMs: Math.max(0, now - stat.mtimeMs),
      mtimeIso: stat.mtime.toISOString(),
    };
  } catch {
    return undefined;
  }
}

function buildMarkerIgnoredFinding(
  repo: RepoSnapshot,
  task: ObservedTask,
  featureDir: string,
  now: number,
  options: ObserverOptions,
  config: MarkerIgnoredConfig,
): Finding | null {
  if (task.phase !== config.phase) return null;
  const markerPath = join(featureDir, config.markerName);
  if (!existsSync(markerPath)) return null;

  const marker = statMarker(markerPath, now);
  if (!marker) return null;

  const markerAgeMinutes = marker.ageMs / 60000;
  if (markerAgeMinutes <= options.staleMinutes) return null;

  const stateMtimeMs = repo.stateMtime ? Date.parse(repo.stateMtime) : NaN;
  const stateNewerThanMarker = Number.isFinite(stateMtimeMs) && stateMtimeMs > marker.mtimeMs;

  const markerAgeSeconds = Math.floor(marker.ageMs / 1000);
  const markerAgeTitleMinutes = Math.round(markerAgeMinutes);

  const parkedArtifact = config.parkedRecommendation ? readCodingUncommittedOutput(featureDir) : null;
  const recommendation = parkedArtifact && config.parkedRecommendation
    ? config.parkedRecommendation(parkedArtifact, task.worktree)
    : stateNewerThanMarker
      ? config.stateAliveRecommendation
      : config.staleRecommendation;

  return {
    id: `${config.idPrefix}-${task.issue}`,
    severity: 'urgent',
    category: 'stuck',
    confidence: 'high',
    session: repo.session,
    repoDir: repo.repoDir,
    issue: task.issue,
    title: `${task.issue} is still in ${config.titlePhase} ${markerAgeTitleMinutes} minutes after ${config.markerName} appeared`,
    evidence: [
      `statePhase=${task.phase}`,
      `marker=${markerPath}`,
      `markerMtime=${marker.mtimeIso}`,
      `markerAgeSeconds=${markerAgeSeconds}`,
      `stateMtime=${repo.stateMtime ?? 'unknown'}`,
      `stateNewerThanMarker=${stateNewerThanMarker}`,
      `worktree=${task.worktree}`,
      ...(parkedArtifact ? ['parkedOnUncommittedOutput=true'] : []),
    ],
    recommendation,
  };
}

// HOK-3207: raise a sustained-slow-pass incident when monitor-timing p50
// has been over warnMs for ≥ 1 h. Driven by slowSinceAt / p50Ms in
// monitor-timing.json, which the shell recorder updates on every pass.
// Hysteresis in the recorder means slowSinceAt is only set while p50 is
// above warnMs, so recovery (p50 drops below warnMs) clears the finding
// naturally — no explicit clear path is needed.
const SUSTAINED_SLOW_PASS_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
// HOK-3207: default warn threshold (15 000 ms). MUST be kept in sync with
// WAVEMILL_MONITOR_PASS_WARN_MS in shared/lib/wavemill-monitor.sh (currently 15000 ms).
const DEFAULT_MONITOR_WARN_MS = 15_000;

// HOK-3314: the former `QUEUE_INFERENCE_STUCK_THRESHOLD=5` lives in
// `queueAlertSeverityForCount` now. One severity ladder, one finding path.

export function detectSustainedSlowPasses(
  repo: RepoSnapshot,
  now: number,
): Finding[] {
  const timing = repo.monitorTiming;
  if (!timing || typeof timing !== 'object') return [];
  const slowSinceAt = typeof timing.slowSinceAt === 'string' ? timing.slowSinceAt : null;
  if (!slowSinceAt) return [];
  const sinceMs = Date.parse(slowSinceAt);
  if (!Number.isFinite(sinceMs)) return [];
  const sustainedMs = now - sinceMs;
  if (sustainedMs < SUSTAINED_SLOW_PASS_THRESHOLD_MS) return [];
  const warnMs = typeof timing.warnMs === 'number' ? timing.warnMs : DEFAULT_MONITOR_WARN_MS;
  const p50 = typeof timing.p50Ms === 'number' ? timing.p50Ms : 0;
  // Defensive: the recorder clears slowSinceAt when p50 drops below warnMs,
  // but a race (observer reads an older timing file than the recorder just
  // wrote) could still land here. Treat a current p50 at/under warnMs as
  // recovered.
  if (p50 <= warnMs) return [];
  const slowestSteps: Array<{ name: string; ms: number }> = Array.isArray(timing.slowestSteps)
    ? timing.slowestSteps
        .filter((s: any) => s && typeof s.name === 'string' && typeof s.ms === 'number')
        .slice(0, 3)
    : [];
  const topSummary = slowestSteps.map((s) => `${s.name}:${s.ms}ms`).join(',') || 'none';
  const sustainedMinutes = Math.round(sustainedMs / 60_000);
  return [{
    id: `monitor-sustained-slow-pass-${repo.session}`,
    severity: 'high',
    category: 'operational',
    confidence: 'high',
    session: repo.session,
    repoDir: repo.repoDir,
    title: `Monitor pass p50 ${p50}ms over warnMs ${warnMs}ms for ${sustainedMinutes} min`,
    evidence: [
      `p50Ms=${p50}`,
      `warnMs=${warnMs}`,
      `slowSinceAt=${slowSinceAt}`,
      `sustainedMinutes=${sustainedMinutes}`,
      `topSteps=${topSummary}`,
      `source=${repo.monitorTimingPath ?? 'unknown'}`,
    ],
    recommendation: `Investigate the top slow steps (${topSummary}) in shared/lib/wavemill-monitor.sh; attach a 24h monitor-timing.json sample to the perf issue before closing.`,
  }];
}

// HOK-3314: `detectQueueInferenceStuck` is retired. The queue-health finding
// emitted below is severity-ladder-driven by `deriveQueueAlertProjection`,
// which fires `high` on the same ≥5 consecutive-failure threshold the old
// stuck-detector enforced — one id, one deduplicated alert.

/**
 * HOK-3244 (REQ-F2): run a best-effort detector, converting any throw into a
 * surfaced finding instead of silently dropping the detector's output. Empty
 * catches used to hide a broken detector until an operator spot-checked why
 * the observer stopped reporting a class of condition. The finding names the
 * detector so the fix target is unambiguous.
 */
export function runDetector(
  name: string,
  repo: Pick<RepoSnapshot, 'session' | 'repoDir'>,
  fn: () => Finding[],
  findings: Finding[],
): void {
  try {
    findings.push(...fn());
  } catch (err) {
    const errorName = err instanceof Error ? err.name : 'Error';
    const message = err instanceof Error ? err.message : String(err);
    findings.push({
      id: `observer-detector-error-${name}-${repo.session}-${hashText(repo.repoDir ?? 'unknown')}`,
      severity: 'medium',
      category: 'operational',
      confidence: 'high',
      session: repo.session,
      repoDir: repo.repoDir,
      title: `Observer detector ${name} threw ${errorName}`,
      evidence: [
        `detector=${name}`,
        `errorName=${errorName}`,
        `message=${message.slice(0, 500)}`,
      ],
      recommendation: `Inspect tools/observer.ts ${name}; a throwing detector hides the rest of its findings until repaired. See HOK-3244.`,
    });
  }
}

export function buildFindings(snapshot: Omit<ObserverSnapshot, 'findings'>, options: ObserverOptions): Finding[] {
  const findings: Finding[] = [];
  const now = Date.now();
  const processByParent = new Map<number, ProcessRow[]>();
  const processByPid = new Map<number, ProcessRow>();
  for (const row of snapshot.processes) {
    processByPid.set(row.pid, row);
    const list = processByParent.get(row.ppid) ?? [];
    list.push(row);
    processByParent.set(row.ppid, list);
  }
  const observerPaneTitle = process.env.WAVEMILL_BACKSTAGE_OBSERVER_PANE_TITLE ?? DEFAULT_OBSERVER_PANE_TITLE;

  for (const issue of detectGlobalConfigIntegrity()) {
    findings.push(configIntegrityFinding(issue, snapshot.sessions[0] ?? 'global'));
  }

  for (const repo of snapshot.repos) {
    // HOK-3101: memoized per-repo task-progress lookup shared by every
    // detector below. `taskAgeMinutes` and `taskHasLiveExecutionEvidence`
    // read from it so a full task-progress computation happens at most once
    // per task per observation cycle.
    const progressLookup = makeProgressLookup(repo, now);
    for (const issue of detectRepoConfigIntegrity(repo.repoDir)) {
      findings.push(configIntegrityFinding(issue, repo.session, repo.repoDir));
    }

    // HOK-3096: state-based detectors. Each is independently best-effort —
    // one throwing (e.g. a git/gh call blowing up in an unexpected way) must
    // never drop findings from the other detectors or the rest of the pass.
    // HOK-3244: a throw now surfaces an `observer-detector-error-<name>`
    // finding instead of a silent empty catch, so a broken detector is
    // visible instead of silently withholding its class of findings.
    runDetector('stuck-merge-candidates', repo, () => {
      const sessionCapabilities = resolveSessionCapabilities(repo.repoDir);
      return detectStuckMergeCandidates(repo, now, sessionCapabilities);
    }, findings);
    runDetector('exhausted-retries', repo, () => detectExhaustedRetries(repo, now, progressLookup), findings);
    runDetector('branch-behind-base', repo, () => detectBranchBehindBase(repo, now), findings);
    // HOK-3207: sustained slow passes (p50 > warnMs for ≥ 1 h) and
    // stuck queue inference (consecutiveFailures ≥ 5). Each has a stable
    // `id`, so `selectAlertsToSend` dedupes repeat findings and recovery
    // (slowSinceAt cleared, failures reset) naturally retracts them.
    runDetector('sustained-slow-passes', repo, () => detectSustainedSlowPasses(repo, now), findings);
    // HOK-3314: the former `queue-inference-stuck` detector is retired; the
    // single queue-health finding below (built from `deriveQueueAlertProjection`)
    // emits the same high-severity alert at ≥5 consecutive failures.

    const rejectedEvalCount = countRejectedEvalRecords(repo.repoDir);
    if (rejectedEvalCount > 0) {
      const [newestRejectedEval] = listRejectedEvalRecords(repo.repoDir, { limit: 1 });
      findings.push({
        id: `eval-rejected-records-${repo.session}-${hashText(repo.repoDir)}`,
        severity: 'medium',
        category: 'warning',
        confidence: 'high',
        session: repo.session,
        repoDir: repo.repoDir,
        title: `${rejectedEvalCount} eval record${rejectedEvalCount === 1 ? '' : 's'} rejected during write-time validation`,
        evidence: [
          `count=${rejectedEvalCount}`,
          `newest=${newestRejectedEval ? basename(newestRejectedEval) : 'unknown'}`,
        ],
        recommendation: 'Inspect .wavemill/evals/rejected/ and fix the path producing write-time validation failures.',
      });
    }

    const observerPanes = snapshot.panes.filter((pane) => pane.session === repo.session && pane.title === observerPaneTitle);
    const observerPanePids = new Set(observerPanes.map((pane) => pane.pid).filter((pid) => pid > 0));
    const observerLoopRows = snapshot.processes.filter((row) => {
      if (!/observer\.ts/.test(row.command) || !/--loop/.test(row.command)) {
        return false;
      }
      if (new RegExp(`--session\\s+${escapeRegExp(repo.session)}\\b`).test(row.command) || row.command.includes(`session=${repo.session}`)) {
        return true;
      }
      let cursor: ProcessRow | undefined = row;
      for (let depth = 0; cursor && depth < 20; depth += 1) {
        if (observerPanePids.has(cursor.pid)) {
          return true;
        }
        cursor = processByPid.get(cursor.ppid);
      }
      return false;
    });
    const observerLoopPidSet = new Set(observerLoopRows.map((row) => row.pid));
    const observerLoopRoots = observerLoopRows.filter((row) => !observerLoopPidSet.has(row.ppid));
    const observerInstanceCount = Math.max(observerPanes.length, observerLoopRoots.length);
    if (observerInstanceCount > 1) {
      findings.push({
        id: `duplicate-observer-${repo.session}`,
        severity: 'high',
        category: 'operational',
        confidence: 'high',
        session: repo.session,
        repoDir: repo.repoDir,
        title: `${observerInstanceCount} Observer loops are running for session ${repo.session} (expected 1)`,
        evidence: [
          `panes=${observerPanes.map((pane) => `${pane.windowIndex}.${pane.paneIndex}`).join(', ') || 'none'}`,
          `rootPids=${observerLoopRoots.map((row) => row.pid).join(', ') || 'none'}`,
        ],
        recommendation: 'Kill all but one Observer pane; the backstage watchdog reconciles duplicates on its next pass and observer --loop now refuses to start beside a live lock holder.',
      });
    }

    const monitorProcesses = snapshot.processes.filter((row) =>
      row.command.includes('wavemill-monitor.sh')
      || (row.command.includes('/tmp/wavemill-monitor.sh') && row.command.includes(repo.repoDir) === false)
    );
    const activeTasks = repo.tasks.filter((task) => !taskWorkflowIsTerminal(task));
    const logAgeMinutes = repo.logMtime ? (now - Date.parse(repo.logMtime)) / 60000 : undefined;
    const stateAgeMinutes = repo.stateMtime ? (now - Date.parse(repo.stateMtime)) / 60000 : undefined;

    if (activeTasks.length > 0 && logAgeMinutes !== undefined && logAgeMinutes > options.staleMinutes) {
      findings.push({
        id: `stale-log-${repo.session}-${basename(repo.repoDir)}`,
        severity: 'high',
        category: 'stuck',
        confidence: 'medium',
        session: repo.session,
        repoDir: repo.repoDir,
        title: `Mill log has not updated for ${Math.round(logAgeMinutes)} minutes while tasks are active`,
        evidence: [
          `repo=${repo.repoDir}`,
          `log=${repo.millLogPath}`,
          `logMtime=${repo.logMtime}`,
          `activeTasks=${activeTasks.map((task) => `${task.issue}:${task.phase ?? 'unknown'}`).join(', ')}`,
        ],
        recommendation: 'Inspect monitor process children for hung git/gh/network calls, then restart or nudge only the blocked child if safe.',
      });
    }

    if (activeTasks.length > 0 && stateAgeMinutes !== undefined && stateAgeMinutes > options.staleMinutes) {
      findings.push({
        id: `stale-state-${repo.session}-${basename(repo.repoDir)}`,
        severity: 'high',
        category: 'stuck',
        confidence: 'medium',
        session: repo.session,
        repoDir: repo.repoDir,
        title: `Workflow state has not updated for ${Math.round(stateAgeMinutes)} minutes while tasks are active`,
        evidence: [
          `state=${repo.workflowStatePath}`,
          `stateMtime=${repo.stateMtime}`,
          `activeTasks=${activeTasks.map((task) => `${task.issue}:${task.phase ?? 'unknown'}`).join(', ')}`,
        ],
        recommendation: 'Compare task marker files with workflow-state.json and verify the monitor loop is still progressing.',
      });
    }

    for (const task of repo.tasks) {
      if (taskWorkflowIsTerminal(task)) continue;

      // HOK-3101 / HOK-3087: use the primitive's progressAgeMinutes, which
      // folds hook/commit/status/worktree/transition evidence together, so a
      // healthy task with recent activity is not falsely flagged as stale.
      // `taskAgeMinutes` (transition-only) is the safe fallback when the
      // primitive has no evidence yet.
      const progress = progressLookup(task);
      const primitiveAge = progress?.progressAgeMinutes ?? null;
      const fallbackAge = task.updated ? (now - Date.parse(task.updated)) / 60000 : stateAgeMinutes;
      const ageMinutes = primitiveAge !== null && Number.isFinite(primitiveAge) ? primitiveAge : fallbackAge;
      const watchedPhase = task.phase === 'planning' || task.phase === 'coding' || task.phase === 'review' || task.phase === 'ready';
      if (watchedPhase && ageMinutes !== undefined && Number.isFinite(ageMinutes) && ageMinutes > options.staleMinutes) {
        const expectedWindow = task.slug ? `${task.issue}-${task.slug}` : task.issue;
        const liveEvidence = taskHasLiveExecutionEvidence(repo, task, snapshot.panes, snapshot.processes, progressLookup);
        if (task.worktree && !existsSync(task.worktree)) {
          findings.push({
            id: `stale-active-task-missing-worktree-${repo.session}-${task.issue}`,
            severity: 'high',
            category: 'stuck',
            confidence: 'high',
            session: repo.session,
            repoDir: repo.repoDir,
            issue: task.issue,
            title: `${task.issue} is non-terminal in ${task.phase} but its worktree is missing`,
            evidence: [
              `status=${task.status ?? 'unknown'}`,
              `phase=${task.phase ?? 'unknown'}`,
              `updated=${task.updated ?? repo.stateMtime ?? 'unknown'}`,
              `ageMinutes=${Math.round(ageMinutes)}`,
              `lastProgressAt=${progress?.lastProgressAt ?? 'never'}`,
              `worktree=${task.worktree}`,
            ],
            recommendation: 'Treat this as orphaned active state: terminalize or remove the workflow-state entry after confirming no cleanup resources remain.',
          });
        } else if (!liveEvidence) {
          // HOK-3095: the agent's own settled hook (idle at its prompt, or
          // waiting on a human) outranks a surviving pane/process, so name it
          // rather than claiming the process is gone.
          const settledState = progress?.agentIdle ? 'idle' : progress?.agentRecord?.state ?? null;
          const settled = settledState !== null && SETTLED_AGENT_STATES.has(settledState);
          findings.push({
            id: `stale-active-task-no-live-process-${repo.session}-${task.issue}`,
            severity: 'high',
            category: 'stuck',
            confidence: 'high',
            session: repo.session,
            repoDir: repo.repoDir,
            issue: task.issue,
            title: settled
              ? `${task.issue} is stale in ${task.phase}: agent is ${settledState} with no progress`
              : `${task.issue} is stale in ${task.phase} with no live pane or process evidence`,
            evidence: [
              `status=${task.status ?? 'unknown'}`,
              `phase=${task.phase ?? 'unknown'}`,
              `updated=${task.updated ?? repo.stateMtime ?? 'unknown'}`,
              `ageMinutes=${Math.round(ageMinutes)}`,
              `lastProgressAt=${progress?.lastProgressAt ?? 'never'}`,
              `expectedWindow=${expectedWindow}`,
              `worktree=${task.worktree ?? 'unknown'}`,
              ...(settled ? [`agentRecordState=${settledState}`] : []),
            ],
            recommendation: settled
              ? 'The agent settled without advancing the task. Inspect its pane and hook: resolve the prompt it is waiting on or send a narrow recovery instruction; if the task is finished or abandoned, terminalize and clean it instead of leaving it active.'
              : 'Inspect the task state and quarantine/cleanup path; if the process is gone, terminalize and clean the task instead of leaving it active.',
          });
        } else {
          const progressEvidence: string[] = [];
          if (progress?.lastProgressAt) progressEvidence.push(`lastProgressAt=${progress.lastProgressAt}`);
          if (progress?.sources.length) progressEvidence.push(`sources=${progress.sources.map((s) => s.kind).join(',')}`);
          if (progress?.agentState) progressEvidence.push(`agentState=${progress.agentState}`);
          if (progress?.agentIdle) progressEvidence.push('agentIdle=true');
          if (progress?.blockingPrompt) progressEvidence.push(`blockingPrompt=${progress.blockingPrompt.id}`);
          findings.push({
            id: `stale-active-task-live-process-${repo.session}-${task.issue}`,
            severity: 'high',
            category: 'stuck',
            confidence: 'medium',
            session: repo.session,
            repoDir: repo.repoDir,
            issue: task.issue,
            title: `${task.issue} has live pane or process residue but has not progressed in ${task.phase}`,
            evidence: [
              `status=${task.status ?? 'unknown'}`,
              `phase=${task.phase ?? 'unknown'}`,
              `updated=${task.updated ?? repo.stateMtime ?? 'unknown'}`,
              `ageMinutes=${Math.round(ageMinutes)}`,
              `expectedWindow=${expectedWindow}`,
              `worktree=${task.worktree ?? 'unknown'}`,
              ...progressEvidence,
            ],
            recommendation: 'Inspect the task pane and hook state. If the agent is parked at a prompt or waiting after reporting completion, send a narrow recovery instruction; stop a child process only when it is conclusively wedged.',
          });
        }
      }

      // HOK-3101 / HOK-3069: a coding task can go silent for 30m+ with no
      // hook, no commits, no worktree changes and only the launcher's
      // `working` status write (which we ignore during the 5s grace after
      // `startedAt`). The pane is still alive (Codex sits at an interactive
      // menu), but nothing is progressing. Pane/process existence never
      // rescues this — it is the whole point of the primitive.
      if (task.phase === 'coding' && !taskWorkflowIsTerminal(task)) {
        const progress = progressLookup(task);
        if (progress?.stalled) {
          const sourceList = progress.sources.length > 0
            ? progress.sources.map((s) => s.kind).join(',')
            : 'none';
          const noProgressDetail = progress.sources.length === 0
            ? ' — no hook, commit, worktree or post-launch status progress since coding launched'
            : '';
          const blockingDetail = progress.blockingPrompt
            ? ` blockingPrompt=${progress.blockingPrompt.id}`
            : '';
          findings.push({
            id: `coding-task-stalled-${repo.session}-${task.issue}`,
            severity: 'high',
            category: 'stuck',
            confidence: 'medium',
            session: repo.session,
            repoDir: repo.repoDir,
            issue: task.issue,
            title: `${task.issue} coding has not progressed for ${progress.progressAgeMinutes ?? '?'} minutes${noProgressDetail}`,
            evidence: [
              `phase=${task.phase ?? 'unknown'}`,
              `progressAgeMinutes=${progress.progressAgeMinutes ?? 'unknown'}`,
              `lastProgressAt=${progress.lastProgressAt ?? 'never'}`,
              `sources=${sourceList}`,
              `agentState=${progress.agentState ?? 'unknown'}`,
              `worktree=${task.worktree ?? 'unknown'}`,
              ...(progress.blockingPrompt ? [`blockingPrompt=${progress.blockingPrompt.id}`] : []),
            ],
            recommendation: progress.blockingPrompt
              ? progress.blockingPrompt.detail
              : `Inspect the ${task.issue} task pane. If the agent is hung or paused at a prompt, resolve or relaunch it; pane/process existence alone is not evidence the agent is making progress.${blockingDetail}`,
          });
        }
      }

      if (!task.worktree || !task.slug || taskWorkflowIsTerminal(task)) continue;
      const featureDir = join(task.worktree, 'features', task.slug);
      const markerFindings = [
        buildMarkerIgnoredFinding(repo, task, featureDir, now, options, {
          phase: 'coding',
          markerName: '.coding-complete',
          idPrefix: 'coding-marker-ignored',
          titlePhase: 'coding',
          staleRecommendation: 'The monitor should advance this to review. Check for a hung monitor child process before restarting the session.',
          stateAliveRecommendation: 'The monitor should advance this to review. It is still writing workflow state but has not advanced this task — inspect its poll branch and this task\'s hook file before restarting anything.',
          parkedRecommendation: buildParkedCommitRecommendation,
        }),
        buildMarkerIgnoredFinding(repo, task, featureDir, now, options, {
          phase: 'planning',
          markerName: '.plan-approved',
          idPrefix: 'plan-marker-ignored',
          titlePhase: 'planning',
          staleRecommendation: 'The monitor should launch coding. Check for a hung monitor child process or blocking external command before restarting the session.',
          stateAliveRecommendation: 'The monitor should launch coding. It is still writing workflow state but has not advanced this task — inspect its poll branch and this task\'s hook file before restarting anything.',
        }),
        // HOK-3244 REQ-F5 / HOK-3211: a `.coding-complete` marker while the
        // task's phase is still `planning` is a leaked marker — plan
        // re-approval archived the agent's prior `.coding-complete` and the
        // mill failed to clear it on the relaunch. The healthy plan→code
        // transition flips `phase` to `coding` within one tick, so the
        // staleMinutes gate keeps that brief window from firing.
        buildMarkerIgnoredFinding(repo, task, featureDir, now, options, {
          phase: 'planning',
          markerName: '.coding-complete',
          idPrefix: 'coding-complete-in-planning',
          titlePhase: 'planning',
          staleRecommendation: 'A .coding-complete marker is present while the task is still in planning (HOK-3211 symptom). Archive the leaked marker (`mv <feature_dir>/.coding-complete <feature_dir>/.coding-complete.archived-<timestamp>`) and let the mill re-plan, or touch `.plan-approved` to restore the handoff — whichever matches the current intent.',
          stateAliveRecommendation: 'A .coding-complete marker is present while the task is still in planning (HOK-3211 symptom). The mill is still writing state but has not acted on this stage transition — archive the leaked marker (`mv <feature_dir>/.coding-complete <feature_dir>/.coding-complete.archived-<timestamp>`) before relaunching planning, or touch `.plan-approved` to restore the handoff.',
        }),
      ];
      for (const finding of markerFindings) {
        if (finding) findings.push(finding);
      }
    }

    // Residue detectors: terminal arms parked with allocated resources, and
    // exited arms whose commits exist only locally. Both run for terminal-status
    // tasks — the terminalStatus() skips above are exactly where parked work
    // used to die silently (HOK-2911/HOK-2912).
    for (const task of repo.tasks) {
      const effectiveConfig = resolveObserverTaskConfig(repo, task.issue, task);
      const driftFinding = effectiveConfigDriftFinding(repo, task, effectiveConfig);
      if (driftFinding) findings.push(driftFinding);


      const ageMinutes = taskAgeMinutes(task, repo, now, progressLookup);
      // The stale age gate doubles as protection against phase-handoff false
      // positives: a healthy handoff briefly has no live agent but keeps
      // task.updated fresh.
      if (ageMinutes === undefined || !Number.isFinite(ageMinutes) || ageMinutes <= options.staleMinutes) continue;

      const normalized = normalizedLifecycle(task);
      const isTerminal = taskHasTerminalResidueStatus(task);
      if (isTerminal) continue; // The cleanup disposition above is the terminal resource authority.
      const liveEvidence = taskHasLiveExecutionEvidence(repo, task, snapshot.panes, snapshot.processes, progressLookup);
      // Active tasks with a live agent are healthy; terminal tasks are inspected
      // even when their window still holds a live (abandoned) agent session.
      if (!isTerminal && liveEvidence) continue;

      const branch = taskBranch(task);
      const baseBranch = effectiveConfig.baseBranch.value;
      const paneResidue = taskPaneResidue(repo, task, snapshot.panes);
      const residue = branch ? inspectTaskBranchResidue(repo.repoDir, branch, baseBranch) : undefined;
      const worktreeDirty = inspectTaskWorktreeDirty(task.worktree);
      const classified = classifyResidue(task, effectiveConfig, residue, worktreeDirty);
      if (classified.suppressResidueFinding && !isTerminal) continue;
      const worktreePresent = task.worktree ? existsSync(task.worktree) : false;
      const unpushedCommits = residue?.unpushedCommits;
      const confirmedWorkAtRisk = classified.disposition === 'unpublished-at-risk';
      const worktreeAtRisk = worktreeDirty.state === 'dirty' || worktreeDirty.state === 'unreadable';

      const firesUnpushed = !liveEvidence && residue !== undefined && confirmedWorkAtRisk && !classified.suppressResidueFinding;
      const terminalResiduePresent = worktreePresent || paneResidue.present || (residue?.localBranchExists ?? false);
      const firesTerminalParked = isTerminal && terminalResiduePresent && !classified.suppressResidueFinding;
      if (!firesUnpushed && !firesTerminalParked) continue;

      const prEvidence = taskPrEvidence(repo.repoDir, task);
      const stateEvidence = [
        `status=${task.status ?? 'unknown'}`,
        `phase=${task.phase ?? 'unknown'}`,
        `workflowOutcome=${normalized.lifecycle.workflowOutcome}`,
        `resourceDisposition=${normalized.lifecycle.resourceDisposition}`,
        `branchDeletionAuthorized=${normalized.branchDeletionAuthorized}`,
      ];

      if (firesUnpushed && residue) {
        findings.push({
          id: `arm-died-with-unpushed-work-${repo.session}-${task.issue}`,
          severity: 'urgent',
          category: 'crash',
          confidence: 'high',
          session: repo.session,
          repoDir: repo.repoDir,
          issue: task.issue,
          title: `${task.issue} arm exited with ${unpushedCommits} unpushed commit${unpushedCommits === 1 ? '' : 's'} on ${residue.branch}`,
          evidence: [
            ...stateEvidence,
            ...classified.evidence,
            `branch=${residue.branch}`,
            `baseBranch=${baseBranch} comparedAgainst=${residue.baseRef ?? 'unknown'}`,
            `commitsAheadOfBase=${residue.aheadOfBase ?? 'unknown'}`,
            'remoteBranch=absent',
            `unpushedCommits=${unpushedCommits}`,
            ...residue.commitSubjects.map((subject) => `commit=${subject}`),
            'liveExecutionEvidence=false',
            prEvidence,
          ],
          recommendation: `These commits exist only locally and are unrecoverable once the worktree and branch are reaped. Push ${residue.branch} to origin and open a PR against ${baseBranch}, or explicitly abandon the branch, before terminalizing cleanup.`,
        });
      }


    }

    const cleanupStore = new IncidentStore(join(repo.repoDir, '.wavemill', 'incidents'));
    for (const incident of detectCleanupIncidentsForRepo(repo, new Date(now).toISOString(), progressLookup)) {
      if (!incident.rootCauseClass.startsWith('cleanup_')) continue;
      findings.push(convertIncidentToFinding({ ...incident, fingerprint: cleanupStore.computeFingerprint(incident) }));
    }
    const logLines = repo.millLogPath ? tailLines(repo.millLogPath, options.maxLogLines) : [];
    const queueHealthDegraded = repo.queueHealth?.status === 'degraded';
    const repeatedReadyWatchdogLines = new Set<string>();
    const modelDowngradeLines = new Set<string>();
    const readyWatchdogEntries = logLines.map(parseReadyWatchdogLine).filter((entry): entry is ReadyWatchdogLogEntry => entry !== null);
    const readyWatchdogGroups = new Map<string, ReadyWatchdogLogEntry[]>();
    for (const entry of readyWatchdogEntries) {
      const key = `${entry.issue}\0${entry.label}\0${entry.action}`;
      const group = readyWatchdogGroups.get(key) ?? [];
      group.push(entry);
      readyWatchdogGroups.set(key, group);
    }
    for (const group of readyWatchdogGroups.values()) {
      if (group.length < 3) continue;
      for (const entry of group) repeatedReadyWatchdogLines.add(entry.line);
      const latest = group[group.length - 1];
      findings.push({
        id: `repeated-ready-watchdog-${repo.session}-${latest.issue}-${hashText(`${latest.action}:${latest.detail}`)}`,
        severity: group.length >= 5 ? 'urgent' : 'high',
        category: 'stuck',
        confidence: 'high',
        session: repo.session,
        repoDir: repo.repoDir,
        issue: latest.issue,
        title: `${latest.issue} repeatedly triggers ready watchdog ${latest.action}`,
        evidence: [
          `occurrences=${group.length}`,
          `action=${latest.action}`,
          `detail=${latest.detail}`,
          ...group.slice(-4).map((entry) => entry.line),
        ],
        recommendation: 'Treat this as a stuck ready/integration handoff. Inspect the backstage tend loop and workflow state, then file or fix the Wavemill defect if it is not resolved by a narrow operational nudge.',
      });
    }

    const readyRecheckLines = new Set<string>();
    const readyRecheckGroups = new Map<string, ReadyRecheckLogEntry[]>();
    for (const line of logLines) {
      const entry = parseReadyRecheckLine(line);
      if (!entry) continue;
      const key = `${entry.issue}\0${entry.pr}`;
      const group = readyRecheckGroups.get(key) ?? [];
      group.push(entry);
      readyRecheckGroups.set(key, group);
    }
    for (const group of readyRecheckGroups.values()) {
      if (group.length < READY_RECHECK_LOOP_THRESHOLD) continue;
      for (const entry of group) readyRecheckLines.add(entry.line);
      const latest = group[group.length - 1];
      const failureReason = readReadyFailureReason(repo, latest.issue);
      findings.push({
        id: `ready-recheck-loop-${repo.session}-${latest.issue}-${latest.pr}`,
        severity: group.length >= READY_RECHECK_LOOP_URGENT_THRESHOLD ? 'urgent' : 'high',
        category: 'stuck',
        confidence: 'high',
        session: repo.session,
        repoDir: repo.repoDir,
        issue: latest.issue,
        title: `${latest.issue} has re-run failed ready checks ${group.length} times for PR #${latest.pr} without progressing`,
        evidence: [
          `occurrences=${group.length}`,
          `pr=#${latest.pr}`,
          `failureReason=${failureReason ?? 'unknown (no .ready-result.json failureReason)'}`,
          ...group.slice(-4).map((entry) => entry.line),
        ],
        recommendation: 'The failed-ready re-check has no retry ceiling or backoff, so a deterministic gate failure loops forever and the PR never reaches the merge lane. Resolve the gate named in failureReason, or terminalize the task. An identical reason repeating every cycle is a Wavemill defect, not a transient failure.',
        occurrenceCount: group.length,
      });
    }

    const launchRefusalLines = new Set<string>();
    const launchRefusalGroups = new Map<string, LaunchRefusalLogEntry[]>();
    for (const line of logLines) {
      const entry = parseLaunchRefusalLine(line);
      if (!entry) continue;
      const key = `${entry.issue}\0${entry.model}`;
      const group = launchRefusalGroups.get(key) ?? [];
      group.push(entry);
      launchRefusalGroups.set(key, group);
    }
    for (const group of launchRefusalGroups.values()) {
      for (const entry of group) launchRefusalLines.add(entry.line);
      findings.push(launchRefusalFinding(repo, group));
    }

    const modelDowngradeGroups = new Map<string, ModelDowngradeLogEntry[]>();
    for (const line of logLines) {
      const entry = parseModelDowngradeLine(line);
      if (!entry) continue;
      const key = `${entry.stage}\0${entry.model}\0${entry.fallback}`;
      const group = modelDowngradeGroups.get(key) ?? [];
      group.push(entry);
      modelDowngradeGroups.set(key, group);
    }
    for (const group of modelDowngradeGroups.values()) {
      if (group.length < MODEL_DOWNGRADE_THRESHOLD) continue;
      for (const entry of group) modelDowngradeLines.add(entry.line);
      const latest = group[group.length - 1];
      findings.push({
        id: `model-downgrade-${repo.session}-${hashText(`${latest.stage}:${latest.model}:${latest.fallback}`)}`,
        severity: 'high',
        category: 'warning',
        confidence: 'high',
        session: repo.session,
        repoDir: repo.repoDir,
        title: `Invalid ${latest.stage} model '${latest.model}' repeatedly fell back to '${latest.fallback}'`,
        evidence: [
          `occurrences=${group.length}`,
          `stage=${latest.stage}`,
          `model=${latest.model}`,
          `fallback=${latest.fallback}`,
          ...group.slice(-4).map((entry) => entry.line),
        ],
        recommendation: 'Treat this as a silent correctness regression: the selected model failed validation and each launch used the fallback. Check config integrity first, then repair the selector.',
        occurrenceCount: group.length,
      });
    }

    // pr-create-failed: surface `pull request create failed` diagnostics from
    // the mill log, review artifacts, and (as a last resort) captured pane
    // output, with a translation of GitHub's misleading blank-sha errors.
    const prCreateFailedLines = new Set<string>();
    const prCreateReportedIssues = new Set<string>();
    const prCreateLogGroups = new Map<string, { lines: string[]; issue?: string }>();
    for (const line of logLines) {
      if (!PR_CREATE_FAILED_PATTERN.test(line)) continue;
      prCreateFailedLines.add(line);
      const issue = matchTaskIssueInText(repo, line);
      const key = issue ?? hashText(normalizeMillLogFingerprintMessage(line));
      const group = prCreateLogGroups.get(key) ?? { lines: [], issue };
      group.lines.push(line);
      prCreateLogGroups.set(key, group);
    }
    for (const group of prCreateLogGroups.values()) {
      if (group.issue) prCreateReportedIssues.add(group.issue);
      findings.push(prCreateFailedFinding(
        repo,
        group.issue,
        group.lines[group.lines.length - 1],
        'mill-log',
        'high',
        group.lines.length,
        observerBaseBranchForIssue(repo, group.issue),
      ));
    }
    for (const task of repo.tasks) {
      if (prCreateReportedIssues.has(task.issue)) continue;
      const artifactText = readTaskReviewArtifactText(task);
      const artifactMatch = artifactText?.match(PR_CREATE_FAILED_PATTERN);
      if (artifactMatch) {
        prCreateReportedIssues.add(task.issue);
        findings.push(prCreateFailedFinding(repo, task.issue, artifactMatch[0], 'review-artifact', 'high', 1, observerBaseBranchForIssue(repo, task.issue)));
        continue;
      }
      for (const pane of taskPaneResidue(repo, task, snapshot.panes).panes) {
        const paneText = capturePaneText(pane);
        const paneMatch = paneText?.match(PR_CREATE_FAILED_PATTERN);
        if (!paneMatch) continue;
        prCreateReportedIssues.add(task.issue);
        // Pane scrollback is volatile, so this source only earns medium confidence.
        findings.push(prCreateFailedFinding(
          repo,
          task.issue,
          paneMatch[0],
          `pane:${pane.session}:${pane.windowIndex}.${pane.paneIndex}`,
          'medium',
          1,
          observerBaseBranchForIssue(repo, task.issue),
        ));
        break;
      }
    }

    // HOK-3244 REQ-F4 / HOK-3210: repeated-[status]-line detector. The generic
    // log scan below only reads error/warn, so a monitor-level status loop
    // (e.g. "Recreated tmux window for HOK-9999" repeated 67 times) is
    // otherwise invisible. Grouping key is the normalized message, not
    // consecutive position — one looping writer repeats the same line whether
    // or not other sources interleave with it.
    const repeatedStatusGroups = new Map<string, { normalizedMessage: string; lines: string[] }>();
    for (const line of logLines) {
      const parsed = parseMillLogLine(line);
      if (!parsed || parsed.level !== 'status') continue;
      if (isAgentBoxOutputMessage(parsed.message)) continue;
      const normalizedMessage = normalizeMillLogFingerprintMessage(parsed.message);
      if (!normalizedMessage) continue;
      const group = repeatedStatusGroups.get(normalizedMessage) ?? { normalizedMessage, lines: [] };
      group.lines.push(line);
      repeatedStatusGroups.set(normalizedMessage, group);
    }
    for (const group of repeatedStatusGroups.values()) {
      if (group.lines.length < REPEATED_STATUS_THRESHOLD) continue;
      const latestLine = group.lines[group.lines.length - 1];
      findings.push({
        id: `repeated-status-${repo.session}-${hashText(group.normalizedMessage)}`,
        severity: group.lines.length >= REPEATED_STATUS_URGENT_THRESHOLD ? 'high' : 'medium',
        category: 'stuck',
        confidence: 'high',
        session: repo.session,
        repoDir: repo.repoDir,
        title: 'Mill log repeats a status line without state change',
        evidence: [
          `occurrences=${group.lines.length}`,
          `normalizedMessage=${group.normalizedMessage}`,
          ...group.lines.slice(-4),
        ],
        recommendation: 'A repeated [status] line usually means a monitor-level loop is firing on every pass without state change. Inspect the mill log and the relevant task state; a repeated line that names a task is often a window/pane/reap loop.',
        occurrenceCount: group.lines.length,
      });
    }

    const genericLogFindings = new Map<string, AggregatedMillLogFinding>();
    for (const line of logLines) {
      const parsed = parseMillLogLine(line);
      if (!parsed) continue;
      if (prCreateFailedLines.has(line)) continue;
      if (launchRefusalLines.has(line)) continue;
      if (isAgentBoxOutputMessage(parsed.message)) continue;
      if (parsed.level !== 'error' && parsed.level !== 'warn') continue;
      if (parsed.level === 'warn') {
        if (repeatedReadyWatchdogLines.has(line)) continue;
        if (readyRecheckLines.has(line)) continue;
        if (modelDowngradeLines.has(line)) continue;
        if (queueHealthDegraded && /queue analysis unavailable/i.test(parsed.message)) continue;
      }

      const normalizedMessage = normalizeMillLogFingerprintMessage(parsed.message);
      const key = `${parsed.level}\0${normalizedMessage}`;
      const grouped = genericLogFindings.get(key) ?? {
        level: parsed.level,
        normalizedMessage,
        lines: [],
      };
      grouped.lines.push(line);
      genericLogFindings.set(key, grouped);
    }

    for (const grouped of genericLogFindings.values()) {
      const latestLine = grouped.lines[grouped.lines.length - 1];
      const evidence = [
        `occurrences=${grouped.lines.length}`,
        `normalizedMessage=${grouped.normalizedMessage}`,
        latestLine,
      ];
      if (grouped.lines.length > 1) {
        const firstLine = grouped.lines[0];
        if (firstLine !== latestLine) evidence.push(`first=${firstLine}`);
      }
      if (grouped.level === 'error') {
        findings.push({
          id: `log-error-${repo.session}-${hashText(grouped.normalizedMessage)}`,
          severity: 'high',
          category: 'crash',
          confidence: 'high',
          session: repo.session,
          repoDir: repo.repoDir,
          title: 'Recent mill log contains an error-level event',
          evidence,
          recommendation: 'Inspect surrounding log context and file a bug if this is not a task-local failure.',
          occurrenceCount: grouped.lines.length,
        });
      } else {
        findings.push({
          id: `log-warning-${repo.session}-${hashText(grouped.normalizedMessage)}`,
          severity: 'low',
          category: 'warning',
          confidence: 'high',
          session: repo.session,
          repoDir: repo.repoDir,
          title: 'Recent mill log contains a warning',
          evidence,
          recommendation: 'Watch for repeated occurrences. File an issue if the warning repeats or blocks progression.',
          occurrenceCount: grouped.lines.length,
        });
      }
    }

    // HOK-3314: single queue-alert projection replaces the four private
    // severity/episode derivations (observer queue-health finding, stuck
    // detector, DependencyHealthDetector queue arm, and shell renderers).
    if (queueHealthDegraded) {
      const projection: QueueAlertProjection = deriveQueueAlertProjection({
        queueHealth: repo.queueHealth,
        nowMs: now,
        observerCycleComplete: true,
      });
      const reason = repo.queueHealth.degradationReason || 'unknown';
      const inferenceUnavailable = projection.status === 'degraded-inference';
      const episode = projection.episode;
      const episodeKey = episode?.id ?? 'unknown';
      findings.push({
        id: `queue-health-degraded-${repo.session}-${hashText(episodeKey)}`,
        severity: episode?.severity ?? 'low',
        category: 'warning',
        confidence: 'high',
        session: repo.session,
        repoDir: repo.repoDir,
        title: `Queue planning degraded: ${reason}`,
        evidence: [
          `episodeId=${episodeKey}`,
          `episodeStartedAt=${episode?.startedAt ?? 'unknown'}`,
          `projectionStatus=${projection.status}`,
          `reason=${reason}`,
          `consecutiveFailedAttempts=${episode?.consecutiveFailedAttempts ?? 0}`,
          `latestFailureAt=${episode?.latestFailureAt ?? 'unknown'}`,
          `latestSuccessAt=${episode?.latestSuccessAt ?? 'unknown'}`,
          `nextAction=${projection.nextAction}`,
          `backoffSeconds=${repo.queueHealth.retryBackoffSeconds || 0}`,
          ...(repo.queueHealth.planner ? [
            `plannerPid=${repo.queueHealth.planner.pid || 'unknown'}`,
            `plannerOwner=${repo.queueHealth.planner.cancellationOwner || 'unknown'}`,
          ] : []),
          ...(repo.queueHealth.diagnostics?.stderrExcerpt ? [
            `stderr=${repo.queueHealth.diagnostics.stderrExcerpt}`,
          ] : []),
          ...(inferenceUnavailable ? [
            `inferenceStatus=${repo.queueHealth.inferenceStatus || 'unknown'}`,
            `inferredEdgeCount=${repo.queueHealth.inferredEdgeCount ?? 'unknown'}`,
            ...(repo.queueHealth.inference?.error ? [`inferenceError=${repo.queueHealth.inference.error}`] : []),
          ] : []),
          ...projection.evidenceWarnings.map((warning) => `evidenceWarning=${warning}`),
        ],
        recommendation: projection.summary + (inferenceUnavailable
          ? ' — check the [classifier] lines in the mill log and the Claude CLI login.'
          : ' — inspect queue-health diagnostics and dependency planner inputs.'),
      });
    }

    for (const monitor of monitorProcesses) {
      const children = processByParent.get(monitor.pid) ?? [];
      for (const child of children) {
        if (child.elapsedSeconds < options.hungMinutes * 60) continue;
        if (!/\b(git|gh|curl|npx|node|claude|codex)\b/.test(child.command)) continue;
        findings.push({
          id: `hung-child-${child.pid}`,
          severity: 'urgent',
          category: 'stuck',
          confidence: 'high',
          session: repo.session,
          repoDir: repo.repoDir,
          title: `Monitor child process appears hung for ${Math.round(child.elapsedSeconds / 60)} minutes`,
          evidence: [
            `monitorPid=${monitor.pid}`,
            `childPid=${child.pid}`,
            `elapsedSeconds=${child.elapsedSeconds}`,
            `command=${child.command}`,
          ],
          recommendation: 'If the command is conclusively blocking the monitor, terminate only the child process and verify the monitor resumes.',
        });
      }
    }
  }

  for (const pane of snapshot.panes) {
    if (/dead/i.test(pane.command) || /Pane is dead/i.test(pane.title)) {
      findings.push({
        id: `dead-pane-${pane.session}-${pane.windowIndex}-${pane.paneIndex}`,
        severity: 'medium',
        category: 'ux',
        confidence: 'medium',
        session: pane.session,
        title: `Pane ${pane.session}:${pane.windowIndex}.${pane.paneIndex} may be dead`,
        evidence: [
          `window=${pane.windowName}`,
          `command=${pane.command}`,
          `title=${pane.title}`,
        ],
        recommendation: 'Confirm with tmux capture-pane and let the monitor respawn it if it is a control pane.',
      });
    }
  }

  // Read and merge observer-findings.jsonl from shell marker_emit_finding calls
  const markerFindings = readObserverFindingsJsonl(snapshot.repos);
  findings.push(...markerFindings);

  return correlateConfigIntegrityFindings(dedupeFindings(findings));
}

function configIntegrityFinding(issue: ConfigIntegrityIssue, session: string, repoDir?: string): Finding {
  const location = issue.line && issue.column ? ` at line ${issue.line} column ${issue.column}` : '';
  const filename = basename(issue.file);
  const schemaImpact = filename === 'wavemill-config.schema.json'
    ? ' - every TS entrypoint will exit 1'
    : '';
  return {
    id: `config-integrity-${session}-${hashText(`${repoDir ?? 'global'}:${issue.file}:${issue.kind}`)}`,
    severity: 'urgent',
    category: 'crash',
    confidence: 'high',
    session,
    repoDir,
    title: `${filename} ${configIntegrityTitleVerb(issue.kind)}${location}${schemaImpact}`,
    evidence: [
      `file=${issue.file}`,
      `kind=${issue.kind}`,
      ...(issue.position !== undefined ? [`position=${issue.position}`] : []),
      ...(issue.line !== undefined ? [`line=${issue.line}`] : []),
      ...(issue.column !== undefined ? [`column=${issue.column}`] : []),
      ...(issue.excerpt ? [`excerpt=${issue.excerpt}`] : []),
      `error=${issue.message}`,
    ],
    recommendation: filename === 'config.json'
      ? 'Repair the user-level wavemill config JSON. Runtime currently tolerates this file, but the corruption should be fixed before it hides other config symptoms.'
      : 'Repair the named config/schema file at the reported location. Treat model-validation, ready-watchdog, and eval failures in this tick as probable downstream effects until this is fixed.',
  };
}

function configIntegrityTitleVerb(kind: ConfigIntegrityIssue['kind']): string {
  if (kind === 'parse-error') return 'is malformed';
  if (kind === 'schema-compile-error') return 'does not compile as a JSON schema';
  if (kind === 'schema-missing') return 'is missing';
  return 'fails schema validation';
}

function parseReadyWatchdogLine(line: string): ReadyWatchdogLogEntry | null {
  const match = line.match(/ready watchdog:\s+(\S+)\s+(.+?)\s+\(([^)]+)\)\s+-\s+(.+)$/i);
  if (!match) return null;
  return {
    line,
    issue: match[1],
    label: match[2],
    action: match[3],
    detail: match[4],
  };
}

const READY_RECHECK_REFUSAL_RE = new RegExp(`\\b(${ISSUE_ID_RE.source.slice(1, -1)}(?:_[A-Za-z0-9]+)?):\\s+refusing ready phase for PR #(\\d+)`, 'i');

function parseReadyRecheckLine(line: string): ReadyRecheckLogEntry | null {
  const match = line.match(/(\S+)\s+\u2192\s+Re-running failed ready checks for PR #(\d+)/)
    ?? line.match(READY_RECHECK_REFUSAL_RE);
  if (!match) return null;
  return {
    line,
    issue: match[1],
    pr: match[2],
  };
}

const CODING_LAUNCH_REFUSAL_BUCKETS = ['coding-launch-refused', 'coding-launch-resolver'] as const;

/** First terminalized coding-launch refusal sentinel in a feature dir (HOK-3142). */
function readCodingLaunchRefusalSentinel(featureDir: string): { bucket: string; path: string; reason: string } | null {
  for (const bucket of CODING_LAUNCH_REFUSAL_BUCKETS) {
    const path = join(featureDir, `.retry-${bucket}-exhausted`);
    if (!existsSync(path)) continue;
    try {
      const reason = readFileSync(path, 'utf-8').trim();
      return { bucket, path, reason: reason || `coding launch refused (${bucket})` };
    } catch {
      return { bucket, path, reason: `coding launch refused (${bucket})` };
    }
  }
  return null;
}

const LAUNCH_REFUSAL_TAG = '[launch-refusal]';
const LEGACY_LAUNCH_REFUSAL_RE = /(\S+)\s+\u2192\s+Coding launch blocked:\s+\[agent-resolution\]/;

function launchRefusalField(message: string, key: string): string | undefined {
  if (key === 'certify') {
    const quoted = message.match(/\bcertify="([^"]*)"/);
    const value = quoted?.[1]?.trim();
    return value && value !== 'unavailable' ? value : undefined;
  }
  const match = message.match(new RegExp(`(?:^|\\s)${key}=(\\S+)`));
  return match?.[1];
}

/**
 * Parse a coding launch refusal from the mill log: the structured
 * `[launch-refusal] issue=… model=… reason=… certification=… action=… certify="…"`
 * line (HOK-3142, logged at warn), or the legacy
 * `<issue> → Coding launch blocked: [agent-resolution] model=… certify="…"`
 * line, which pre-HOK-3142 monitors wrote at `[info]` on every retry tick.
 */
export function parseLaunchRefusalLine(line: string): LaunchRefusalLogEntry | null {
  const parsed = parseMillLogLine(line);
  const message = parsed?.message ?? line;
  let issue: string | undefined;
  let action: string | undefined;
  if (message.includes(LAUNCH_REFUSAL_TAG)) {
    issue = launchRefusalField(message, 'issue');
    action = launchRefusalField(message, 'action');
  } else {
    const legacy = message.match(LEGACY_LAUNCH_REFUSAL_RE);
    if (!legacy) return null;
    issue = legacy[1];
    action = 'retry-loop';
  }
  const model = launchRefusalField(message, 'model');
  if (!issue || !model) return null;
  const substitute = launchRefusalField(message, 'substitute');
  const certify = launchRefusalField(message, 'certify');
  return {
    line,
    issue,
    model,
    provider: launchRefusalField(message, 'provider') ?? 'unknown',
    reason: launchRefusalField(message, 'reason') ?? 'unknown',
    certification: launchRefusalField(message, 'certification') ?? 'unknown',
    action: action ?? 'unknown',
    ...(substitute ? { substitute } : {}),
    ...(certify ? { certify } : {}),
  };
}

function launchRefusalFinding(repo: RepoSnapshot, group: LaunchRefusalLogEntry[]): Finding {
  const latest = group[group.length - 1];
  const certify = [...group].reverse().find((entry) => entry.certify)?.certify;
  const terminal = group.some((entry) => entry.action === 'needs-user');
  const looping = group.some((entry) => entry.action === 'retry-loop' || entry.action === 'retry');
  const allRerouted = group.every((entry) => entry.action === 'rerouted');
  const severity: Finding['severity'] = terminal
    ? 'urgent'
    : allRerouted
      ? 'low'
      : looping && group.length >= MODEL_DOWNGRADE_THRESHOLD ? 'urgent' : 'high';
  const cause = `${latest.reason}${latest.certification !== 'unknown' ? `:${latest.certification}` : ''}`;
  const title = allRerouted
    ? `${latest.issue} coder ${latest.model} was refused at launch (${cause}) and re-routed to ${latest.substitute ?? 'a substitute'}`
    : `${latest.issue} coding launch refused: ${latest.model} is not launchable for coding (${cause})`;
  const recommendation = allRerouted
    ? `Informational: the router guard or launch-refusal reroute substituted the coder. Certify ${latest.model} for coding if it should stay routable${certify ? `: ${certify}` : '.'}`
    : certify
      ? `Run: ${certify}. Then clear the refusal sentinel (rm <feature_dir>/.retry-coding-launch-refused-*) so the task relaunches coding. A refusal for this reason never clears on retry.`
      : `The launch gate refuses ${latest.model} for coding (${cause}) and no certify command was recorded. Re-route the coder or fix the model's registry entry, then clear the refusal sentinel.`;
  return {
    id: `launch-refused-${repo.session}-${latest.issue}-${latest.model.replace(/[^A-Za-z0-9._-]/g, '_')}`,
    severity,
    category: 'stuck',
    confidence: 'high',
    session: repo.session,
    repoDir: repo.repoDir,
    issue: latest.issue,
    title,
    evidence: [
      `occurrences=${group.length}`,
      `model=${latest.model}`,
      `provider=${latest.provider}`,
      `reason=${latest.reason}`,
      `certification=${latest.certification}`,
      `action=${latest.action}`,
      ...(latest.substitute ? [`substitute=${latest.substitute}`] : []),
      `certify=${certify ?? 'unavailable'}`,
      ...group.slice(-4).map((entry) => entry.line),
    ],
    recommendation,
    occurrenceCount: group.length,
  };
}

function parseModelDowngradeLine(line: string): ModelDowngradeLogEntry | null {
  const parsed = parseMillLogLine(line);
  if (!parsed) return null;
  const match = parsed.message.match(/Invalid\s+(\S+)\s+model\s+'([^']+)'(?:\s+looks like a depth tag)?;\s+using\s+'([^']+)'/i);
  if (!match) return null;
  return {
    line,
    stage: match[1],
    model: match[2],
    fallback: match[3],
  };
}

function readReadyFailureReason(repo: RepoSnapshot, issue: string): string | undefined {
  const task = repo.tasks?.find((candidate) => candidate.issue === issue);
  if (!task?.worktree || !task.slug) return undefined;
  const featureDir = join(task.worktree, 'features', task.slug);
  const attentionPath = join(featureDir, '.needs-attention');
  if (existsSync(attentionPath)) {
    try {
      const attention = readFileSync(attentionPath, 'utf-8').trim();
      if (attention) return attention;
    } catch {
      // Fall through to the structured result when the advisory cannot be read.
    }
  }

  const resultPath = join(featureDir, '.ready-result.json');
  if (!existsSync(resultPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(resultPath, 'utf-8')) as {
      failureReason?: unknown;
      notes?: unknown;
      artifacts?: { failureReason?: unknown; lastCiSummary?: unknown };
    };
    const candidates = [
      parsed.failureReason,
      parsed.artifacts?.failureReason,
      parsed.artifacts?.lastCiSummary,
      parsed.notes,
    ];
    const reason = candidates.find((candidate) => typeof candidate === 'string' && candidate.trim());
    return typeof reason === 'string' ? reason.trim() : undefined;
  } catch {
    return undefined;
  }
}

function parseMillLogLine(line: string): MillLogLine | null {
  const match = line.match(/^(\d{2}:\d{2}:\d{2})\s+\[([^\]]+)\]\s?(.*)$/);
  if (!match) return null;
  return {
    raw: line,
    timestamp: match[1],
    level: match[2].trim().toLowerCase(),
    message: match[3],
  };
}

function isAgentBoxOutputMessage(message: string): boolean {
  return /^\s*│/.test(message);
}

function normalizeMillLogFingerprintMessage(message: string): string {
  return message
    .replace(/\b(pid|ppid|processPid|plannerPid|monitorPid|childPid)=\d+\b/gi, '$1=<pid>')
    .replace(/\b(pid|ppid|process|planner|monitor|child)\s+\d+\b/gi, '$1 <pid>')
    .replace(/(?:\/private)?\/tmp\/[^\s'",)]+/g, '<tmp>')
    .replace(/\/var\/folders\/[^\s'",)]+\/T\/[^\s'",)]+/g, '<tmp>')
    .replace(/\s+/g, ' ')
    .trim();
}

function terminalStatus(status?: string): boolean {
  return status === 'merged'
    || status === 'complete'
    || status === 'completed'
    || status === 'completed-external'
    || status === 'closed'
    || status === 'done'
    || status === 'aborted'
    || status === 'superseded'
    || status === 'replaced';
}

function normalizedLifecycle(task: ObservedTask) {
  return normalizeTaskLifecycle(task);
}

function taskWorkflowIsTerminal(task: ObservedTask): boolean {
  return normalizedLifecycle(task).lifecycle.workflowOutcome !== 'active';
}

interface PaneResidue {
  present: boolean;
  live: boolean;
  targets: string[];
  panes: Pane[];
}

/**
 * Panes that still belong to a task: its expected window, or a pane whose
 * title references the issue/worktree. `live` distinguishes a running agent
 * from a window that has fallen back to a shell or a dead pane.
 */
function taskPaneResidue(repo: RepoSnapshot, task: ObservedTask, panes: Pane[]): PaneResidue {
  const expectedWindow = task.slug ? `${task.issue}-${task.slug}` : task.issue;
  const matching = panes.filter((pane) => {
    if (pane.session !== repo.session) return false;
    return pane.windowName === expectedWindow
      || pane.windowName === task.issue
      || (task.slug ? pane.windowName === task.slug : false)
      || pane.title.includes(task.issue)
      || (task.worktree ? pane.title.includes(task.worktree) : false);
  });
  return {
    present: matching.length > 0,
    live: matching.some((pane) => !/dead|exited/i.test(`${pane.command} ${pane.title}`)),
    targets: matching.map((pane) => `${pane.session}:${pane.windowIndex}.${pane.paneIndex}`),
    panes: matching,
  };
}

/**
 * HOK-3095: an agent record in one of these states is the agent's own
 * settled declaration that it is not working — parked at its prompt
 * (`idle`) or waiting on a human (`waiting`, `approval-needed`, `blocked`,
 * `policy-denied`). Its live pane and its own launch process are then an
 * idle REPL, not execution. The primitive suppresses `stalled` for the
 * attention states; the observer instead treats them as "not live" so a
 * prompt parked past `staleMinutes` still surfaces. Kept here because it is
 * observer policy, not a primitive invariant.
 */
const SETTLED_AGENT_STATES: ReadonlySet<HookState> = new Set<HookState>([
  'idle',
  'waiting',
  'approval-needed',
  'blocked',
  'policy-denied',
]);

/**
 * True when there is evidence that the task is executing right now.
 *
 * HOK-3095: progress, not process existence, decides. Callers have already
 * applied the stale age gate (the primitive's `progressAgeMinutes`, which
 * folds hook/commit/status-file/transition evidence together); this answers
 * which stale finding fires and whether residue detectors treat the arm as
 * still running.
 *
 * 1. A fresh (TTL-bound) agent-written `working` hook is live.
 * 2. The agent's own settled record (idle / attention state, untimed so a
 *    `waiting` hook from hours ago still counts) is NOT live, whatever pane
 *    or process still carries the task's name.
 * 3. With no agent signal at all (fresh launch, hookless agent), fall back to
 *    pane residue or a matching process — excluding the monitor's own
 *    polling children (`tools/*.ts`, monitor subprocesses), whose argv names
 *    the worktree but which are not the task.
 */
function taskHasLiveExecutionEvidence(
  repo: RepoSnapshot,
  task: ObservedTask,
  panes: Pane[],
  processes: ProcessRow[],
  progressLookup?: (task: ObservedTask) => TaskProgress | undefined,
): boolean {
  const progress = progressLookup ? progressLookup(task) : undefined;
  if (progress?.agentState === 'working') return true;
  if (progress?.agentIdle) return false;
  const agentRecordState = progress?.agentRecord?.state;
  if (agentRecordState && SETTLED_AGENT_STATES.has(agentRecordState)) return false;

  if (taskPaneResidue(repo, task, panes).live) return true;

  return processes.some((row) => {
    const command = row.command;
    if (isWavemillControllerProcess(command)) return false;
    return command.includes(task.issue)
      || (task.slug ? command.includes(task.slug) : false)
      || (task.worktree ? command.includes(task.worktree) : false);
  });
}

/**
 * Terminal residue statuses: everything terminalStatus() covers plus
 * status/phase "error". HOK-2911 observed error arms parked with live
 * worktrees and unpushed commits; they must not be exempt from residue checks.
 */
function taskHasTerminalResidueStatus(task: ObservedTask): boolean {
  return taskWorkflowIsTerminal(task) || terminalStatus(task.status) || task.status === 'error' || task.phase === 'error';
}

function taskBranch(task: ObservedTask): string | undefined {
  if (task.branch) return task.branch;
  return task.slug ? `task/${task.slug}` : undefined;
}

/**
 * HOK-3101: memoized per-cycle task-progress cache. `task.updated` only
 * changes on transitions, so the old `taskAgeMinutes` reported healthy tasks
 * as stale (HOK-3087). The primitive derives progress from hook, commit,
 * worktree, status-file and transition evidence, and it treats pane/process
 * existence as separate from progress.
 *
 * Multiple detectors call this per task per cycle; each cycle uses a fresh
 * WeakMap keyed on the task record so gather IO (git log, git status, stat)
 * happens at most once per task.
 */
function makeProgressLookup(repo: RepoSnapshot, now: number): (task: ObservedTask) => TaskProgress | undefined {
  const cache = new WeakMap<ObservedTask, TaskProgress>();
  const nowDate = new Date(now);
  return (task) => {
    const cached = cache.get(task);
    if (cached) return cached;
    if (!task.issue) return undefined;
    try {
      const result = getTaskProgress({
        issue: task.issue,
        session: repo.session,
        task: task as never,
        worktree: task.worktree,
        phase: task.phase,
        now: nowDate,
      });
      cache.set(task, result);
      return result;
    } catch {
      return undefined;
    }
  };
}

function taskAgeMinutes(
  task: ObservedTask,
  repo: RepoSnapshot,
  now: number,
  _progressLookup?: (task: ObservedTask) => TaskProgress | undefined,
): number | undefined {
  // HOK-3101 note: `taskAgeMinutes` intentionally keeps the semantics that
  // existing residue and stale-active detectors pin — it is the age of the
  // task record (`task.updated` or the state-file mtime), not of the newest
  // git evidence. The primitive's `lastProgressAt` is used SEPARATELY by
  // the coding-stall detector and enriches other findings with source
  // evidence; it must not shorten the age gate here or terminal-parked and
  // died-with-unpushed-work findings never fire on fixtures whose git tree
  // was created moments before the test runs.
  const updatedMs = task.updated ? Date.parse(task.updated) : NaN;
  if (Number.isFinite(updatedMs)) return (now - updatedMs) / 60000;
  const stateMs = repo.stateMtime ? Date.parse(repo.stateMtime) : NaN;
  if (Number.isFinite(stateMs)) return (now - stateMs) / 60000;
  return undefined;
}

type RemoteBranchState = 'present' | 'absent' | 'unknown';

interface BranchResidue {
  branch: string;
  localBranchExists: boolean;
  /** The base ref the ahead count was computed against, when it succeeded. */
  baseRef?: string;
  /** Commits on the branch that are not in the base branch; undefined = unknown. */
  aheadOfBase?: number;
  remoteBranch: RemoteBranchState;
  /** Commits at risk of loss if the branch is reaped; undefined = unknown. */
  unpushedCommits?: number;
  /** Subjects of at-risk commits, newest first, capped. */
  commitSubjects: string[];
}

function gitRefExists(repoDir: string, ref: string): boolean {
  return run('git', ['-C', repoDir, 'show-ref', '--verify', '--quiet', ref], 8_000).ok;
}

function gitRevListCount(repoDir: string, range: string): number | undefined {
  const result = run('git', ['-C', repoDir, 'rev-list', '--count', range], 8_000);
  if (!result.ok) return undefined;
  const count = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(count) && count >= 0 ? count : undefined;
}

function gitCommitSubjects(repoDir: string, range: string, limit: number): string[] {
  const result = run('git', ['-C', repoDir, 'log', '--format=%s', '-n', String(limit), range], 8_000);
  if (!result.ok) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((subject) => truncate(subject, 120));
}

/**
 * Best-effort inspection of a task branch's recoverable state. Every git
 * failure degrades to "unknown" rather than throwing, and the network-touching
 * ls-remote only runs when local commits are actually ahead of base and no
 * remote-tracking ref can answer the question locally.
 */
function inspectTaskBranchResidue(repoDir: string, branch: string, baseBranch: string): BranchResidue {
  const residue: BranchResidue = {
    branch,
    localBranchExists: gitRefExists(repoDir, `refs/heads/${branch}`),
    remoteBranch: 'unknown',
    commitSubjects: [],
  };
  if (!residue.localBranchExists) return residue;

  let baseRef = `origin/${baseBranch}`;
  let ahead = gitRevListCount(repoDir, `${baseRef}..${branch}`);
  if (ahead === undefined) {
    baseRef = baseBranch;
    ahead = gitRevListCount(repoDir, `${baseRef}..${branch}`);
  }
  residue.aheadOfBase = ahead;
  if (ahead !== undefined) residue.baseRef = baseRef;

  if (gitRefExists(repoDir, `refs/remotes/origin/${branch}`)) {
    residue.remoteBranch = 'present';
    residue.unpushedCommits = gitRevListCount(repoDir, `origin/${branch}..${branch}`);
    if ((residue.unpushedCommits ?? 0) > 0) {
      residue.commitSubjects = gitCommitSubjects(repoDir, `origin/${branch}..${branch}`, RESIDUE_COMMIT_SUBJECT_LIMIT);
    }
    return residue;
  }

  // No local remote-tracking ref. Confirming remote absence needs a network
  // call, so only pay for it when there is something at risk.
  if (ahead === undefined) return residue;
  if (ahead === 0) {
    residue.unpushedCommits = 0;
    return residue;
  }

  const lsRemote = run('git', ['-C', repoDir, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`], 8_000);
  if (!lsRemote.ok) return residue; // network/auth failure: never claim work loss on unknown
  if (lsRemote.stdout.trim().length > 0) {
    // Pushed at some point but never fetched here; the local delta is unknowable without a fetch.
    residue.remoteBranch = 'present';
    return residue;
  }
  residue.remoteBranch = 'absent';
  residue.unpushedCommits = ahead;
  residue.commitSubjects = gitCommitSubjects(repoDir, `${baseRef}..${branch}`, RESIDUE_COMMIT_SUBJECT_LIMIT);
  return residue;
}

/** One `gh pr view` worth of PR facts; `labels` is undefined when they could not be read. */
interface PrView {
  state?: string;
  baseRefName?: string;
  labels?: string[];
}

/** Best-effort single `gh pr view` read; a failed/unparseable call returns undefined, never throws. */
function defaultReadPrView(repoDir: string, pr: string): PrView | undefined {
  const result = run('gh', ['pr', 'view', pr, '--json', 'state,baseRefName,labels'], 8_000, repoDir);
  if (!result.ok) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as { state?: unknown; baseRefName?: unknown; labels?: unknown };
    return {
      state: typeof parsed.state === 'string' && parsed.state ? parsed.state : undefined,
      baseRefName: typeof parsed.baseRefName === 'string' && parsed.baseRefName ? parsed.baseRefName : undefined,
      labels: Array.isArray(parsed.labels)
        ? (parsed.labels as Array<{ name?: unknown }>)
          .map((label) => (typeof label?.name === 'string' ? label.name : undefined))
          .filter((name): name is string => Boolean(name))
        : undefined,
    };
  } catch {
    return undefined;
  }
}

function formatPrEvidence(pr: string, view: PrView | undefined): string {
  const base = view?.baseRefName ? ` base=${view.baseRefName}` : '';
  return `pr=#${pr} state=${view?.state ?? 'unknown'}${base}`;
}

/** Best-effort PR state evidence; a failed gh call reports unknown, never throws. */
function taskPrEvidence(repoDir: string, task: ObservedTask): string {
  if (!task.pr) return 'pr=none';
  return formatPrEvidence(task.pr, defaultReadPrView(repoDir, task.pr));
}

// ---------------------------------------------------------------------------
// HOK-3096: state-based detectors — stuck merge candidates, abandoned
// exhausted retries, and branches that have drifted far behind their base.
// Every input here is git/filesystem/config state, never a log line, so
// these catch stalls the log-based detectors above cannot see.
// ---------------------------------------------------------------------------

function gitRevParse(repoDir: string, ref: string): string | undefined {
  const result = run('git', ['-C', repoDir, 'rev-parse', ref], 8_000);
  return result.ok ? result.stdout.trim() : undefined;
}

/**
 * Resolve a task's ready-stage state directory, mirroring `ready_state_dir`
 * in `wavemill-monitor.sh`: prefer an existing `features/<slug>` or
 * `bugs/<slug>` directory under the task's worktree, then under the repo
 * checkout (tests often run with `worktree === repoDir`), falling back to
 * `features/<slug>` under the worktree when neither exists yet.
 */
function resolveTaskStateDir(repoDir: string, task: ObservedTask): string | undefined {
  if (!task.slug) return undefined;
  const bases = [task.worktree, repoDir].filter((base): base is string => Boolean(base));
  for (const base of bases) {
    for (const kind of ['features', 'bugs'] as const) {
      const candidate = join(base, kind, task.slug);
      if (existsSync(candidate)) return candidate;
    }
  }
  const fallbackBase = task.worktree ?? repoDir;
  return join(fallbackBase, 'features', task.slug);
}

/** Best-effort sync read of `.ready-result.json`'s artifacts. Never throws. */
function readReadyArtifacts(stateDir: string): { artifacts: ReadyArtifacts; mtimeMs: number } | undefined {
  const resultPath = getResultFilePath(stateDir, 'ready');
  try {
    const stat = statSync(resultPath);
    const parsed = JSON.parse(readFileSync(resultPath, 'utf8')) as Partial<StageResult> | null;
    if (!parsed || typeof parsed !== 'object' || parsed.stage !== 'ready') return undefined;
    const artifacts = parsed.artifacts as ReadyArtifacts | undefined;
    if (!artifacts || typeof artifacts !== 'object' || artifacts.type !== 'ready') return undefined;
    return { artifacts, mtimeMs: stat.mtimeMs };
  } catch {
    return undefined;
  }
}

interface CandidateChurnEntry {
  at: string;
}

interface CandidateChurnRecord {
  headSha: string;
  entries: CandidateChurnEntry[];
}

type CandidateChurnJournal = Record<string, CandidateChurnRecord>;

function candidateChurnJournalPath(repoDir: string): string {
  return join(repoDir, '.wavemill', 'observer-candidate-churn.json');
}

/**
 * Record a merge-candidate promotion event and return the number of distinct
 * promotions recorded for `issue` on `headSha` within the churn window.
 *
 * `demote_merge_candidate` nulls out `candidatePromotedAt` in
 * `.ready-result.json`, so a fresh non-null value appearing while
 * `queueState` is `merge-candidate` means the lane promoted this issue again
 * — i.e. it was demoted and re-promoted since the last distinct value was
 * seen. Counting distinct `candidatePromotedAt` values on the same head is
 * therefore a direct measure of promote/demote churn (REQ-F2).
 *
 * Entries older than the churn window, and the whole record when the head
 * SHA changed (new work superseded the churn), are pruned. The journal is
 * observer-private bookkeeping: a write failure is swallowed and simply
 * costs this cycle's churn count, never the rest of the pass (D4).
 */
function recordCandidateChurnPromotion(
  repoDir: string,
  issue: string,
  headSha: string,
  promotedAt: string,
  now: number,
): number {
  try {
    const path = candidateChurnJournalPath(repoDir);
    const cutoffMs = now - CANDIDATE_CHURN_WINDOW_MINUTES * 60_000;
    const next = mutateJsonStateSync<CandidateChurnJournal>(
      path,
      (current) => {
        const journal: CandidateChurnJournal = current && typeof current === 'object' ? current : {};
        const existing = journal[issue];
        const record: CandidateChurnRecord = existing && existing.headSha === headSha
          ? { headSha, entries: [...existing.entries] }
          : { headSha, entries: [] };
        if (!record.entries.some((entry) => entry.at === promotedAt)) {
          record.entries.push({ at: promotedAt });
        }
        record.entries = record.entries.filter((entry) => {
          const ms = Date.parse(entry.at);
          return Number.isFinite(ms) && ms >= cutoffMs;
        });
        return { ...journal, [issue]: record };
      },
      { createIfMissing: true, initial: {} },
    );
    return next[issue]?.entries.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * The monitor's HOK-3111 per-(PR, head) promote/demote journal at
 * `<repoDir>/.wavemill/merge-queue-transitions.json`, keyed `${pr}:${head}`.
 * `escalated` latches once `promoteDemoteCycles` crosses the monitor's
 * escalation threshold and only resets on a new head.
 */
interface MergeQueueTransitionRecord {
  head?: string;
  lastTransition?: string;
  promoteDemoteCycles?: number;
  escalated?: boolean;
  updatedAt?: string;
}

type MergeQueueTransitions = Record<string, MergeQueueTransitionRecord>;

/** Best-effort read of the monitor's transition journal. Never throws. */
function defaultReadMergeQueueTransitions(repoDir: string): MergeQueueTransitions | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(repoDir, '.wavemill', 'merge-queue-transitions.json'), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as MergeQueueTransitions : undefined;
  } catch {
    return undefined;
  }
}

interface StuckCandidateDeps {
  readPrView?: (repoDir: string, pr: string) => PrView | undefined;
  readMergeQueueTransitions?: (repoDir: string) => MergeQueueTransitions | undefined;
}

/**
 * Detector 1 (REQ-F1, REQ-F2): a task sitting in `queueState:
 * 'merge-candidate'` with no active merge consumer — or with a consumer but
 * no `wm:ready` label on its PR, so the consumer will never pick it up
 * (HOK-3240) — or one that keeps churning promote/demote on the same head
 * without ever landing.
 *
 * Cost: at most one `gh pr view` per merge-candidate task per pass; the
 * label gate and the PR evidence line share the same read.
 */
export function detectStuckMergeCandidates(
  repo: RepoSnapshot,
  now: number,
  caps: SessionCapabilities,
  deps: StuckCandidateDeps = {},
): Finding[] {
  const readPrView = deps.readPrView ?? defaultReadPrView;
  const readMergeQueueTransitions = deps.readMergeQueueTransitions ?? defaultReadMergeQueueTransitions;
  const findings: Finding[] = [];
  let transitions: MergeQueueTransitions | undefined | null = null;
  for (const task of repo.tasks) {
    if (taskWorkflowIsTerminal(task)) continue;
    const stateDir = resolveTaskStateDir(repo.repoDir, task);
    if (!stateDir) continue;
    const ready = readReadyArtifacts(stateDir);
    if (!ready || ready.artifacts.queueState !== 'merge-candidate') continue;
    const artifacts = ready.artifacts;
    const headSha = artifacts.readyHeadSha ?? artifacts.launchHead ?? 'unknown';

    let prView: PrView | undefined | null = null;
    const taskPrView = (pr: string): PrView | undefined => {
      if (prView === null) prView = readPrView(repo.repoDir, pr);
      return prView;
    };
    const prEvidence = (): string => (task.pr ? formatPrEvidence(task.pr, taskPrView(task.pr)) : 'pr=none');

    if (artifacts.candidatePromotedAt) {
      const promotions = recordCandidateChurnPromotion(repo.repoDir, task.issue, headSha, artifacts.candidatePromotedAt, now);
      // HOK-3240: the 30-minute window misses the lane's real 16-21 min
      // promote/demote cadence, so also honour the monitor's durable
      // per-(PR, head) escalation latch.
      let transitionRecord: MergeQueueTransitionRecord | undefined;
      if (task.pr) {
        if (transitions === null) transitions = readMergeQueueTransitions(repo.repoDir);
        transitionRecord = transitions?.[`${task.pr}:${artifacts.lastCiHeadSha ?? headSha}`];
      }
      const durablyEscalated = transitionRecord?.escalated === true;
      if (promotions >= CANDIDATE_CHURN_THRESHOLD || durablyEscalated) {
        findings.push({
          id: `merge-candidate-churn-${repo.session}-${task.issue}`,
          severity: 'high',
          category: 'stuck',
          confidence: 'high',
          session: repo.session,
          repoDir: repo.repoDir,
          issue: task.issue,
          title: durablyEscalated && promotions < CANDIDATE_CHURN_THRESHOLD
            ? `${task.issue} merge candidate is in an escalated promote/demote loop on the same head`
            : `${task.issue} merge candidate has been promoted ${promotions} times on the same head in ${CANDIDATE_CHURN_WINDOW_MINUTES} minutes`,
          evidence: [
            `promotions=${promotions}`,
            `windowMinutes=${CANDIDATE_CHURN_WINDOW_MINUTES}`,
            `durablyEscalated=${durablyEscalated}`,
            ...(transitionRecord ? [`cyclesRecorded=${transitionRecord.promoteDemoteCycles ?? 'unknown'}`] : []),
            `headSha=${headSha}`,
            `candidatePromotedAt=${artifacts.candidatePromotedAt}`,
            `lastSkipReason=${artifacts.candidateSkipReason ?? 'unknown'}`,
            prEvidence(),
          ],
          recommendation: 'The merge lane keeps promoting and demoting this candidate on the same head without it ever landing. Inspect why it keeps getting demoted (flaky CI, base churn, a stuck health check) instead of letting the lane spin indefinitely.',
        });
      }
    }

    const candidateSinceIso = artifacts.candidateLastProgressAt ?? artifacts.candidatePromotedAt;
    const candidateSinceMs = candidateSinceIso ? Date.parse(candidateSinceIso) : NaN;
    const ageMinutes = Number.isFinite(candidateSinceMs)
      ? (now - candidateSinceMs) / 60_000
      : (now - ready.mtimeMs) / 60_000;
    // D2: mergeExecutor/mergeQueue gate the finding; health is advisory
    // evidence only, never gating (HOK-3102).
    const hasConsumer = caps.mergeExecutor === 'tend' && caps.mergeQueue;
    if (ageMinutes <= CANDIDATE_STUCK_MINUTES) continue;
    // HOK-3240: with a consumer active, the candidate is still stuck when its
    // PR lacks `wm:ready` (the consumer never picks it up). An unreadable
    // label set never fires — we do not flag on unverified data.
    const labels = hasConsumer && task.pr ? taskPrView(task.pr)?.labels : undefined;
    const prLacksReadyLabel = labels !== undefined && !labels.includes('wm:ready');
    if (!hasConsumer || prLacksReadyLabel) {
      findings.push({
        id: `stuck-merge-candidate-${repo.session}-${task.issue}`,
        severity: 'high',
        category: 'stuck',
        confidence: 'high',
        session: repo.session,
        repoDir: repo.repoDir,
        issue: task.issue,
        title: hasConsumer
          ? `${task.issue} is stuck in merge-candidate: PR #${task.pr} has no wm:ready label`
          : `${task.issue} is stuck in merge-candidate with no active merge consumer`,
        evidence: [
          `queueState=${artifacts.queueState}`,
          `candidatePromotedAt=${artifacts.candidatePromotedAt ?? 'unknown'}`,
          `ageMinutes=${Math.round(ageMinutes)}`,
          `mergeExecutor=${caps.mergeExecutor} (${caps.reasons.mergeExecutor})`,
          `mergeQueue=${caps.mergeQueue}`,
          `tendHealth=${caps.health.tend ?? 'unknown'} (advisory)`,
          `headSha=${headSha}`,
          `targetBaseSha=${artifacts.targetBaseSha ?? 'unknown'}`,
          `prLacksReadyLabel=${prLacksReadyLabel}`,
          `gateReason=${hasConsumer ? 'pr-lacks-wm-ready' : 'no-consumer'}`,
          prEvidence(),
        ],
        recommendation: hasConsumer
          ? `Task is in merge-candidate but PR #${task.pr} has no wm:ready label, so the merge consumer will never pick it up. The merge-label reconciler (HOK-3181/HOK-3212) is responsible for setting it — investigate why deriveMergeLabel() does not yield wm:ready for this task (a manual label is overwritten by the reconciler).`
          : task.pr
            ? `Task is stuck in merge-candidate with no active merge consumer. Consider enabling integration (integration.enabled + useMillSession) or merging PR #${task.pr} manually.`
            : 'Task is stuck in merge-candidate with no active merge consumer. Consider enabling integration (integration.enabled + useMillSession) or merging manually.',
      });
    }
  }
  return findings;
}

interface RetryExhaustionSentinel {
  bucket: string;
  path: string;
  mtimeMs: number;
  reason: string;
}

/**
 * Scan a task state directory for retry-exhausted sentinels (HOK-2924). Never
 * throws. Matches both the standard `.retry-<bucket>-exhausted` shape and the
 * legacy `.failed-ready-recheck-exhausted` shape — `_bounded_retry_prefix`
 * drops the `.retry-` prefix for that single bucket for upgrade compatibility
 * (bounded-retry.sh:44). Without the extra match, the detector silently misses
 * every failed-ready-recheck exhaustion (HOK-3244 REQ-F3).
 */
function listExhaustedRetrySentinels(stateDir: string): RetryExhaustionSentinel[] {
  let entries: string[];
  try {
    entries = readdirSync(stateDir);
  } catch {
    return [];
  }
  const sentinels: RetryExhaustionSentinel[] = [];
  for (const name of entries) {
    let bucket: string | undefined;
    if (name === '.failed-ready-recheck-exhausted') {
      bucket = 'failed-ready-recheck';
    } else {
      const match = /^\.retry-(.+)-exhausted$/.exec(name);
      if (match) bucket = match[1];
    }
    if (!bucket) continue;
    const path = join(stateDir, name);
    try {
      const stat = statSync(path);
      const reason = readFileSync(path, 'utf8').trim();
      sentinels.push({ bucket, path, mtimeMs: stat.mtimeMs, reason });
    } catch {
      // Unreadable sentinel: skip rather than report on data we cannot verify.
    }
  }
  return sentinels;
}

/**
 * Resolve the per-bucket file prefix used by `shared/lib/bounded-retry.sh`:
 * `.retry-<bucket>-` for every bucket, with the sole exception of
 * `failed-ready-recheck`, whose storage keeps its pre-HOK-2924 names
 * (`.failed-ready-recheck-*`) for upgrade compatibility.
 */
function retryBucketPrefix(bucket: string): string {
  return bucket === 'failed-ready-recheck' ? '.failed-ready-recheck-' : `.retry-${bucket}-`;
}

/**
 * True when the bucket's retry budget is still keyed to the branch's current
 * tip — i.e. the exhaustion sentinel is still relevant. `bounded-retry.sh`
 * resets the whole bucket (including the exhausted sentinel) on a new head
 * SHA, so a mismatched key means the budget is already about to clear itself
 * and firing here would be a false positive. Absent key file or an
 * unresolvable tip is treated as "still relevant" — the detector never
 * suppresses on information it cannot verify.
 */
function exhaustedRetryStillKeyed(stateDir: string, bucket: string, repoDir: string, branch: string | undefined): boolean {
  const headFile = join(stateDir, `${retryBucketPrefix(bucket)}head`);
  if (!existsSync(headFile)) return true;
  let storedHead: string | undefined;
  try {
    storedHead = readFileSync(headFile, 'utf8').split('\n')[0]?.trim();
  } catch {
    return true;
  }
  if (!storedHead || !branch) return true;
  const tip = gitRevParse(repoDir, branch);
  if (!tip) return true;
  return storedHead === tip;
}

function lastCommitEpochMs(repoDir: string, branch: string): number | undefined {
  const result = run('git', ['-C', repoDir, 'log', '-1', '--format=%ct', branch], 8_000);
  if (!result.ok) return undefined;
  const seconds = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

/**
 * Detector 2 (REQ-F3): a bounded-retry bucket (HOK-2924) has terminalized
 * with an `.retry-<bucket>-exhausted` sentinel, and nothing — a new commit,
 * or agent/operator progress per the HOK-3101 primitive — has happened since.
 */
export function detectExhaustedRetries(
  repo: RepoSnapshot,
  now: number,
  progressLookup: (task: ObservedTask) => TaskProgress | undefined,
): Finding[] {
  const findings: Finding[] = [];
  for (const task of repo.tasks) {
    if (taskWorkflowIsTerminal(task)) continue;
    const stateDir = resolveTaskStateDir(repo.repoDir, task);
    if (!stateDir) continue;
    const sentinels = listExhaustedRetrySentinels(stateDir);
    if (sentinels.length === 0) continue;

    const branch = taskBranch(task);
    const progress = progressLookup(task);
    const lastProgressMs = progress?.lastProgressAt ? Date.parse(progress.lastProgressAt) : NaN;
    const lastCommitMs = branch ? lastCommitEpochMs(repo.repoDir, branch) : undefined;

    for (const sentinel of sentinels) {
      const ageMinutes = (now - sentinel.mtimeMs) / 60_000;
      if (ageMinutes < EXHAUSTED_RETRY_QUIET_MINUTES) continue;
      if (!exhaustedRetryStillKeyed(stateDir, sentinel.bucket, repo.repoDir, branch)) continue;
      if (lastCommitMs !== undefined && lastCommitMs > sentinel.mtimeMs) continue;
      if (Number.isFinite(lastProgressMs) && lastProgressMs > sentinel.mtimeMs) continue;

      findings.push({
        id: `exhausted-retry-abandoned-${repo.session}-${task.issue}-${sentinel.bucket}`,
        severity: 'high',
        category: 'stuck',
        confidence: 'high',
        session: repo.session,
        repoDir: repo.repoDir,
        issue: task.issue,
        title: `${task.issue} abandoned: Exhausted retries: ${truncate(sentinel.reason, 160)}`,
        evidence: [
          `bucket=${sentinel.bucket}`,
          `sentinel=${sentinel.path}`,
          `sentinelReason=${sentinel.reason}`,
          `sentinelAgeMinutes=${Math.round(ageMinutes)}`,
          `lastCommitAt=${lastCommitMs !== undefined ? new Date(lastCommitMs).toISOString() : 'unknown'}`,
          `lastProgressAt=${progress?.lastProgressAt ?? 'never'}`,
          branch ? `branch=${branch}` : 'branch=unknown',
          taskPrEvidence(repo.repoDir, task),
        ],
        recommendation: `Fix the recorded cause (${truncate(sentinel.reason, 160)}), then push a new commit to ${branch ?? 'the task branch'} to reset the ${sentinel.bucket} retry budget, or abort the task. Never just delete the sentinel — the underlying cause is still unresolved. observer.autoFix.resetReadyRecheckBudget (HOK-3097) can reset the budget once the head or base SHA has changed.`,
      });
    }
  }
  return findings;
}

/**
 * Pure severity rule for Detector 3 (REQ-F5, D6): `medium` by default, raised
 * to `high` when the PR is ready to merge. Labels win when known; when they
 * are unknown (no PR, or the `gh` call failed), the ready-stage `queueState`
 * is a state-based fallback with the same meaning — `ready`, `ready-stale`,
 * and `merge-candidate` all mean the PR has cleared the ready gate.
 */
export function behindBaseSeverity(context: { hasReadyLabel?: boolean; queueState?: string }): Severity {
  const elevated = context.hasReadyLabel === true
    || (context.hasReadyLabel === undefined
      && (context.queueState === 'ready' || context.queueState === 'ready-stale' || context.queueState === 'merge-candidate'));
  return elevated ? 'high' : 'medium';
}

/** Best-effort PR label read; a failed/missing gh call reports unknown (undefined), never throws. */
function defaultReadPrLabels(repoDir: string, pr: string): string[] | undefined {
  return defaultReadPrView(repoDir, pr)?.labels;
}

interface BranchBehindBaseDeps {
  readPrLabels?: (repoDir: string, pr: string) => string[] | undefined;
}

/**
 * Detector 3 (REQ-F4, REQ-F5): an active task branch has drifted more than
 * `BEHIND_BASE_THRESHOLD_COMMITS` commits behind its effective base branch.
 * Reuses the HOK-3092 behind-base predicate (`measureBranchBaseDistance`);
 * never fetches (D5), so this reads whatever `origin/<base>` the mill's own
 * fetch cadence has already made current.
 */
export function detectBranchBehindBase(
  repo: RepoSnapshot,
  now: number,
  deps: BranchBehindBaseDeps = {},
): Finding[] {
  const readPrLabels = deps.readPrLabels ?? defaultReadPrLabels;
  const findings: Finding[] = [];
  for (const task of repo.tasks) {
    if (taskWorkflowIsTerminal(task)) continue;
    const watchedPhase = task.phase === 'coding' || task.phase === 'review' || task.phase === 'ready';
    if (!watchedPhase) continue;
    const branch = taskBranch(task);
    if (!branch || !gitRefExists(repo.repoDir, `refs/heads/${branch}`)) continue;

    const effectiveConfig = resolveObserverTaskConfig(repo, task.issue, task);
    const baseBranch = effectiveConfig.baseBranch.value;
    const distance = measureBranchBaseDistance(branch, baseBranch, repo.repoDir);
    if (distance.behindBase === undefined || distance.behindBase <= BEHIND_BASE_THRESHOLD_COMMITS) continue;

    const stateDir = resolveTaskStateDir(repo.repoDir, task);
    const ready = stateDir ? readReadyArtifacts(stateDir) : undefined;
    const queueState = ready?.artifacts.queueState;

    let hasReadyLabel: boolean | undefined;
    if (task.pr) {
      const labels = readPrLabels(repo.repoDir, task.pr);
      if (labels) hasReadyLabel = labels.includes('wm:ready');
    }

    const severity = behindBaseSeverity({ hasReadyLabel, queueState });
    findings.push({
      id: `branch-behind-base-${repo.session}-${task.issue}`,
      severity,
      category: 'operational',
      confidence: 'high',
      session: repo.session,
      repoDir: repo.repoDir,
      issue: task.issue,
      title: `${task.issue} branch ${branch} is ${distance.behindBase} commits behind ${baseBranch}`,
      evidence: [
        `behindBase=${distance.behindBase}`,
        `aheadOfBase=${distance.aheadOfBase ?? 'unknown'}`,
        `baseRef=${distance.baseRef ?? 'unknown'}`,
        `threshold=${BEHIND_BASE_THRESHOLD_COMMITS}`,
        `queueState=${queueState ?? 'unknown'}`,
        `wmReadyLabel=${hasReadyLabel === undefined ? 'unknown' : hasReadyLabel}`,
        taskPrEvidence(repo.repoDir, task),
      ],
      recommendation: `Update ${branch} from ${baseBranch} (\`npx tsx tools/update-branch-with-base.ts --worktree ${task.worktree ?? '<worktree>'} --branch ${branch} --base ${baseBranch}\`) before it drifts further; merge conflicts only get worse with distance. observer.autoFix.updateBranchFromBase (HOK-3097) can apply this fix automatically.`,
    });
  }
  return findings;
}

function matchTaskIssueInText(repo: RepoSnapshot, text: string): string | undefined {
  // Longest issue key first so HOK-1234_c lines never match HOK-1234.
  const tasks = [...repo.tasks].sort((a, b) => b.issue.length - a.issue.length);
  for (const task of tasks) {
    const branch = taskBranch(task);
    if (branch && text.includes(branch)) return task.issue;
    if (task.slug && text.includes(task.slug)) return task.issue;
    if (text.includes(task.issue)) return task.issue;
  }
  return undefined;
}

function capturePaneText(pane: Pane): string | undefined {
  if (pane.capturedText !== undefined) return pane.capturedText;
  const target = termPaneHandle(pane.session, pane.windowIndex, pane.paneIndex);
  return termCapture(target, { lines: 200, timeoutMs: 5_000 }) ?? undefined;
}

/**
 * HOK-3101 re-exports normalizeInteractivePromptText and
 * matchInteractivePromptSignature from shared/lib/task-progress.ts so that
 * observer.test.ts's existing imports keep working. The single implementation
 * lives in the primitive; the observer no longer duplicates it.
 */
export const normalizeInteractivePromptText = taskProgressNormalizeInteractivePromptText;
export const matchInteractivePromptSignature = taskProgressMatchInteractivePromptSignature;

/**
 * HOK-3045: emit an incident when a task-correlated pane is parked at a known
 * interactive agent lifecycle prompt. Only nonterminal task panes are
 * inspected, and each pane's text is captured at most once per cycle.
 * Evidence carries only the signature id and choice count — never the raw
 * capture — so persisted incidents cannot leak prompt content, transcripts,
 * paths, tokens, or user identifiers.
 */
function detectInteractivePromptBlockedIncidents(
  repo: RepoSnapshot,
  snapshot: Pick<ObserverSnapshot, 'panes'>,
  timestamp: string,
): IncidentRecord[] {
  const incidents: IncidentRecord[] = [];
  for (const task of repo.tasks) {
    if (!task.issue) continue;
    if (taskWorkflowIsTerminal(task)) continue;
    const residue = taskPaneResidue(repo, task, snapshot.panes);
    if (!residue.present) continue;
    // Inspect each correlated pane at most once per observation cycle.
    for (const pane of residue.panes) {
      const paneText = capturePaneText(pane);
      const signature = matchInteractivePromptSignature(paneText);
      if (!signature) continue;
      const paneTarget = `${pane.session}:${pane.windowIndex}.${pane.paneIndex}`;
      const evidenceKey = `interactive-prompt:${task.issue}:${signature.id}`;
      incidents.push(createIncidentDraft({
        taskId: task.issue,
        session: repo.session,
        category: 'configuration_operator_condition',
        severity: 'high',
        confidence: 'high',
        lifecycle: 'observed',
        rootCauseClass: 'agent_interactive_prompt_blocked',
        summary: `${task.issue} task pane is parked at an interactive ${signature.agent} prompt (${signature.id}).`,
        operatorAction: signature.operatorAction,
        evidence: [{
          type: 'hook_status',
          source: `pane:${paneTarget}`,
          timestamp,
          redactedData: `agent=${signature.agent} prompt=${signature.id}${signature.choiceCount ? ` choices=${signature.choiceCount}` : ''}`,
          key: evidenceKey,
        }],
        metadata: {
          promptSignatureId: signature.id,
          promptAgent: signature.agent,
          paneTarget,
          // Captured for the current-truth resolution gate — the incident may
          // not auto-resolve until this task advances past this timestamp or
          // becomes terminal (HOK-3045).
          observedTaskUpdatedAt: task.updated ?? null,
        },
      }));
      // A task pane's signature only matches once per pane per cycle; a second
      // match on the same pane would produce a duplicate fingerprint anyway.
      break;
    }
  }
  return incidents;
}

/**
 * Gate for the incident-store resolution sweep (HOK-3045): interactive-prompt
 * incidents must not auto-resolve on absence while their correlated task is
 * still nonterminal and has not advanced past the last observation. This
 * mirrors the current-truth reconciliation contract from HOK-3032.
 */
function canResolveInteractivePromptByAbsence(
  record: IncidentRecord,
  repo: RepoSnapshot,
): boolean {
  if (record.rootCauseClass !== 'agent_interactive_prompt_blocked') return true;
  const taskId = record.taskId;
  if (!taskId) return true;
  const task = repo.tasks.find((candidate) => candidate.issue === taskId);
  if (!task) return true; // task went away → nothing to protect
  if (taskWorkflowIsTerminal(task) || taskHasTerminalResidueStatus(task)) return true;
  const observedAt = typeof record.metadata?.observedTaskUpdatedAt === 'string'
    ? Date.parse(record.metadata.observedTaskUpdatedAt)
    : NaN;
  const currentAt = task.updated ? Date.parse(task.updated) : NaN;
  if (!Number.isFinite(observedAt) || !Number.isFinite(currentAt)) return false;
  return currentAt > observedAt;
}

function readTaskReviewArtifactText(task: ObservedTask): string | undefined {
  if (!task.worktree || !task.slug) return undefined;
  const artifactPath = join(task.worktree, 'features', task.slug, '.review-result.json');
  if (!existsSync(artifactPath)) return undefined;
  try {
    return readFileSync(artifactPath, 'utf8').slice(0, 65_536);
  } catch {
    return undefined;
  }
}

/**
 * Plain-language reading of GitHub's PR-create errors. The raw messages
 * actively mislead: "No commits between main and task/..." means the branch
 * has no remote ref, not that the agent produced nothing.
 */
function translatePrCreateFailure(text: string, baseBranch: string): string | undefined {
  if (/Head sha can't be blank|Head ref must be a branch/i.test(text)) {
    return 'the head branch was never pushed to origin, so GitHub has no ref for it - "No commits between ..." here means "no remote branch", not "the agent did nothing"';
  }
  if (/Base sha can't be blank|No commits between/i.test(text)) {
    return `base/head comparison failed - verify the PR targets the configured base branch (${baseBranch}) and that the head branch is pushed`;
  }
  return undefined;
}

function prCreateFailedFinding(
  repo: RepoSnapshot,
  issue: string | undefined,
  rawText: string,
  source: string,
  confidence: Confidence,
  occurrences: number,
  baseBranch: string,
): Finding {
  const raw = truncate(rawText.trim(), 300);
  const translation = translatePrCreateFailure(rawText, baseBranch);
  return {
    id: `pr-create-failed-${repo.session}-${issue ?? hashText(raw)}`,
    severity: 'high',
    category: 'crash',
    confidence,
    session: repo.session,
    repoDir: repo.repoDir,
    issue,
    title: issue
      ? `${issue} failed to create its PR and the arm's work never reached GitHub`
      : 'A mill arm failed to create its PR and its work never reached GitHub',
    evidence: [
      `source=${source}`,
      `occurrences=${occurrences}`,
      `raw=${raw}`,
      ...(translation ? [`translation=${translation}`] : []),
      `baseBranch=${baseBranch}`,
    ],
    recommendation: `Push the task branch to origin and re-create the PR against ${baseBranch}, or explicitly abandon the arm. Do not trust the raw GitHub error text when deciding whether work exists - check \`git rev-list --count ${baseBranch}..<branch>\` locally first.`,
    occurrenceCount: occurrences,
  };
}

function hashText(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function escapeRegExp(value: string): string {
  const specialChars = /[.*+?^${}()|[\]\\]/g;
  return value.replace(specialChars, (match) => `\\${match}`);
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function readObserverFindingsJsonl(repos: RepoRow[]): Finding[] {
  const findings: Finding[] = [];

  for (const repo of repos) {
    const findingsFile = join(repo.repoDir, '.wavemill', 'observer-findings.jsonl');
    try {
      const content = readFileSync(findingsFile, 'utf-8');
      const lines = content.split('\n').filter((line: string) => line.trim().length > 0);

      for (const line of lines) {
        try {
          const jsonFinding = JSON.parse(line);
          findings.push({
            id: `marker-${jsonFinding.context?.markerPath ?? 'unknown'}-${jsonFinding.context?.markerKind ?? 'unknown'}`,
            severity: normalizeFindingSeverity(jsonFinding.severity),
            category: jsonFinding.subsystem || 'marker-lifecycle',
            confidence: 'high',
            session: repo.session,
            repoDir: repo.repoDir,
            title: jsonFinding.title,
            evidence: [
              ...(jsonFinding.body ? [`detail=${jsonFinding.body}`] : []),
              ...(jsonFinding.context ? Object.entries(jsonFinding.context).map(([k, v]) => `${k}=${v}`) : []),
            ],
            recommendation: typeof jsonFinding.recommendation === 'string' && jsonFinding.recommendation.length > 0
              ? jsonFinding.recommendation
              : 'Marker was stale or contradicted and was cleared. This should not happen; check marker lifecycle on re-derivation paths.',
            oneShot: true,
          });
        } catch {
          // Ignore malformed JSONL lines
        }
      }

      // Truncate the file after reading to keep it from growing unbounded
      rmSync(findingsFile, { force: true });
    } catch {
      // File doesn't exist yet, that's fine
    }
  }

  return findings;
}

function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.id}:${finding.repoDir ?? ''}:${finding.issue ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function correlateConfigIntegrityFindings(findings: Finding[]): Finding[] {
  const next = findings.map((finding) => ({ ...finding, evidence: [...finding.evidence] }));
  const configByRepo = new Map<string, Finding>();
  for (const finding of next) {
    if (finding.id.startsWith('config-integrity-') && finding.repoDir && !configByRepo.has(finding.repoDir)) {
      configByRepo.set(finding.repoDir, finding);
    }
  }

  const downstreamByParent = new Map<string, Finding[]>();
  for (const finding of next) {
    if (finding.id.startsWith('config-integrity-') || !finding.repoDir) continue;
    const parent = configByRepo.get(finding.repoDir);
    if (!parent || !isConfigIntegrityDownstreamFinding(finding)) continue;
    finding.groupedUnder = parent.id;
    finding.evidence.push(`probableRootCause=config-integrity (${parent.evidence.find((line) => line.startsWith('file='))?.slice(5) ?? parent.id})`);
    const list = downstreamByParent.get(parent.id) ?? [];
    list.push(finding);
    downstreamByParent.set(parent.id, list);
  }

  for (const [parentId, children] of downstreamByParent) {
    const parent = next.find((finding) => finding.id === parentId);
    if (!parent) continue;
    const downstreamCount = children.reduce((sum, child) => sum + (child.occurrenceCount ?? 1), 0);
    parent.evidence.push(`downstreamCount=${downstreamCount}`);
    for (const child of children.slice(0, 8)) {
      parent.evidence.push(`downstream=${child.id} (x${child.occurrenceCount ?? 1})`);
    }
  }

  return next;
}

function isConfigIntegrityDownstreamFinding(finding: Finding): boolean {
  if (finding.id.startsWith('model-downgrade-')) return true;
  if (finding.id.startsWith('repeated-ready-watchdog-')) {
    return finding.evidence.some((line) => /Unexpected (non-whitespace|token|end of JSON)|Failed to parse .*wavemill-config|Config validation failed/i.test(line));
  }
  if (!/^log-(error|warning)-/.test(finding.id)) return false;
  const text = `${finding.title}\n${finding.evidence.join('\n')}`;
  return /Unexpected (non-whitespace|token|end of JSON)|Failed to parse .*wavemill-config|Config validation failed|failed validation \(model selector is not valid|Invalid \S+ model '[^']+'(?: looks like a depth tag)?; using '[^']+'|ready watchdog tick failed|Post-completion eval: failed/i.test(text);
}

function observe(options: ObserverOptions): ObserverSnapshot {
  const sessions = listSessions().filter((session) => !options.session || session === options.session);
  const panes = listPanes().filter((pane) => !options.session || pane.session === options.session);
  const processes = filterRelevantProcesses(processRows(), panes);
  const repos = snapshotRepos(sessions, options);
  const partial: Omit<ObserverSnapshot, 'findings'> = {
    schemaVersion: OBSERVER_SNAPSHOT_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    sessions,
    panes,
    processes,
    repos,
  };
  return {
    ...partial,
    findings: buildFindings(partial, options),
  };
}

export async function reconcileIncidents(snapshot: ObserverSnapshot, options: ObserverOptions): Promise<ObserverSnapshot> {
  const incidents: IncidentRecord[] = [];
  if (!options.incidentDetector) {
    return { ...snapshot, incidents };
  }
  const incidentsByRepo = new Map<string, IncidentRecord[]>();
  const jobsByRepo = new Map<string, ReturnType<typeof readAuthoritativeWorkflowJobs>>();
  const recoveredIncidents: NonNullable<ObserverSnapshot['recoveredIncidents']> = [];

  for (const repo of snapshot.repos) {
    let incidentConfig: ReturnType<typeof getIncidentConfig>;
    try {
      incidentConfig = getIncidentConfig(repo.repoDir);
    } catch (error) {
      addConfigDegradedFindingIfMissing(snapshot.findings, repo, error, 'incident reconciliation');
      continue;
    }
    if (incidentConfig.enabled === false) continue;
    const jobTruth = readAuthoritativeWorkflowJobs(repo.repoDir);
    jobsByRepo.set(repo.repoDir, jobTruth);
    const storeDir = incidentConfig.store?.directory ?? '.wavemill/incidents';
    const store = new IncidentStore(
      isAbsolute(storeDir) ? storeDir : join(repo.repoDir, storeDir),
      {
        escalationThreshold: options.dependencyThreshold ?? incidentConfig.detection?.dependencyThreshold ?? 3,
        maxEvidencePerRecord: incidentConfig.detection?.maxEvidencePerRecord ?? 50,
        resolutionAfterCycles: incidentConfig.detection?.resolutionAfterCycles ?? 5,
      },
    );

    // The resolution sweep only runs after a fully successful detection cycle:
    // a detector or persistence failure must not resolve incidents by absence.
    let cycleComplete = true;
    const candidates: IncidentRecord[] = [];
    const tendCandidates = buildTendCandidates({
      repoDir: repo.repoDir,
      now: new Date(snapshot.timestamp),
      findings: snapshot.findings,
      tasks: repo.tasks,
    });
    try {
      const detectorContext = { repoDir: repo.repoDir, session: repo.session, now: new Date(snapshot.timestamp), tendCandidates, jobTruth };
      for (const task of repo.tasks) {
        if (!task.issue || taskWorkflowIsTerminal(task)) continue;
        const taskPath = resolveTaskArtifactDir(repo.repoDir, task);
        if (!taskPath) continue;
        const detected = detectIncidentsForTask(
          taskPath,
          task.issue,
          detectorContext,
          options.dependencyThreshold ?? incidentConfig.detection?.dependencyThreshold ?? 3,
        );
        candidates.push(...detected);
      }

      candidates.push(...detectIncidentsForRepo(
        repo.repoDir,
        detectorContext,
        options.dependencyThreshold ?? incidentConfig.detection?.dependencyThreshold ?? 3,
      ));

      candidates.push(...detectParkedArmIncidents(repo, snapshot, options, snapshot.timestamp));
      candidates.push(...detectCleanupIncidentsForRepo(repo, snapshot.timestamp));
      candidates.push(...detectInteractivePromptBlockedIncidents(repo, snapshot, snapshot.timestamp));
    } catch (error) {
      cycleComplete = false;
      addConfigDegradedFindingIfMissing(snapshot.findings, repo, error, 'incident detection');
    }

    const freshFingerprints: string[] = [];
    const observedFingerprints = new Set<string>();
    const repoIncidents: IncidentRecord[] = [];
    incidentsByRepo.set(repo.repoDir, repoIncidents);
    for (const incident of dedupeIncidentCandidates(candidates, store)) {
      try {
        const { record: stored, freshEvent } = await store.upsertDetailed(incident);
        if (freshEvent) freshFingerprints.push(stored.fingerprint);
        observedFingerprints.add(stored.fingerprint);
        incidents.push(stored);
        repoIncidents.push(stored);
      } catch (error) {
        cycleComplete = false;
        snapshot.findings.push({
          id: `incident-store-error-${repo.session}-${hashText(repo.repoDir)}`,
          severity: 'high',
          category: 'operational',
          confidence: 'high',
          session: repo.session,
          repoDir: repo.repoDir,
          issue: incident.taskId ?? undefined,
          title: 'Observer could not persist Wavemill incident state',
          evidence: [`error=${error instanceof Error ? error.message : String(error)}`],
          recommendation: 'Inspect .wavemill/incidents permissions and malformed state files; incident detection is read-only but persistence is required for deduplication.',
        });
      }
    }

    if (cycleComplete) {
      // Recovery predicates (HOK-2595): an open correlated incident that was
      // not re-observed this cycle resolves as soon as its declared progress
      // condition holds (new review attempt, head change, comparison), rather
      // than waiting out the absence sweep. Missing evidence never resolves.
      try {
        const jobs = jobTruth;
        for (const record of await store.getIncidents()) {
          const current = reconcileIncidentForFiling(record, repo.repoDir, jobs);
          const jobBacked = isJobBackedIncident(record);
          if (!jobBacked && observedFingerprints.has(record.fingerprint)) continue;
          const recovery = jobBacked
            ? { satisfied: current.outcome === 'recovered' || current.outcome === 'superseded', reason: `current_disposition:${current.outcome}`, evidence: JSON.stringify(current.evidence) }
            : evaluateRecoveryPredicate(record, repo.repoDir);
          if (jobBacked && !recovery.satisfied && !observedFingerprints.has(record.fingerprint)) {
            incidents.push(record);
            repoIncidents.push(record);
            observedFingerprints.add(record.fingerprint);
          }
          if (!recovery.satisfied || !recovery.reason) continue;
          const resolved = await store.autoResolve(record.fingerprint, { reason: recovery.reason });
          if (resolved) {
            recoveredIncidents.push({
              fingerprint: resolved.fingerprint,
              rootCauseClass: resolved.rootCauseClass,
              reason: recovery.reason,
              ...(recovery.evidence ? { evidence: recovery.evidence } : {}),
            });
          }
        }
      } catch (error) {
        snapshot.findings.push({
          id: `incident-recovery-error-${repo.session}-${hashText(repo.repoDir)}`,
          severity: 'medium',
          category: 'operational',
          confidence: 'high',
          session: repo.session,
          repoDir: repo.repoDir,
          title: 'Observer could not evaluate incident recovery predicates',
          evidence: [`error=${error instanceof Error ? error.message : String(error)}`],
          recommendation: 'Inspect .wavemill/incidents permissions and malformed state files; correlated incidents will still resolve through the absence sweep.',
        });
      }
      try {
        // HOK-3314: separate observed-presence from fresh-event. An unchanged
        // condition observed every cycle used to accrue missedCycles and
        // auto-resolve after 5 polls (hence `recurrence.count=19` with
        // nothing structural changed). Passing `observed` keeps it active.
        await store.runResolutionSweep(
          { fresh: freshFingerprints, observed: observedFingerprints },
          (record) => !isJobBackedIncident(record) && canResolveInteractivePromptByAbsence(record, repo),
        );
      } catch (error) {
        snapshot.findings.push({
          id: `incident-sweep-error-${repo.session}-${hashText(repo.repoDir)}`,
          severity: 'medium',
          category: 'operational',
          confidence: 'high',
          session: repo.session,
          repoDir: repo.repoDir,
          title: 'Observer could not run the incident resolution sweep',
          evidence: [`error=${error instanceof Error ? error.message : String(error)}`],
          recommendation: 'Inspect .wavemill/incidents permissions and malformed state files; stale incidents will not auto-resolve until the sweep succeeds.',
        });
      }
    }
  }

  const uniqueIncidents = dedupeIncidents(incidents).filter((record) => {
    if (!isJobBackedIncident(record)) return true;
    const repoDir = snapshot.repos.find((repo) => repo.session === record.session)?.repoDir;
    if (!repoDir) return true;
    const current = reconcileIncidentForFiling(record, repoDir, jobsByRepo.get(repoDir));
    return current.outcome === 'confirmed_active' || current.outcome === 'needs_inspection';
  });
  // A specific causal chain supersedes the generic stale-task advice for the
  // same repo/issue; without one the generic finding is untouched.
  let findings = snapshot.findings;
  for (const [repoDir, repoIncidents] of incidentsByRepo) {
    const repoFindings = findings.filter((finding) => finding.repoDir === repoDir);
    const rewritten = supersedeGenericFindings(repoFindings, repoIncidents);
    const replacement = new Map(repoFindings.map((finding, index) => [finding, rewritten[index]] as const));
    findings = findings.map((finding) => replacement.get(finding) ?? finding);
  }
  const projection = projectRemediationProposals(uniqueIncidents);
  return {
    ...snapshot,
    schemaVersion: OBSERVER_SNAPSHOT_SCHEMA_VERSION,
    findings: dedupeFindings([...findings, ...uniqueIncidents.map(convertIncidentToFinding)]),
    incidents: uniqueIncidents,
    remediationProposals: projection.proposals,
    remediationProposalErrors: projection.errors,
    recoveredIncidents,
  };
}

function resolveTaskArtifactDir(repoDir: string, task: ObservedTask): string | null {
  const candidates = [
    task.worktree && task.slug ? join(task.worktree, 'features', task.slug) : null,
    task.slug ? join(repoDir, 'features', task.slug) : null,
    task.worktree ?? null,
  ].filter((candidate): candidate is string => candidate !== null);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function convertIncidentToFinding(incident: IncidentRecord): Finding {
  return {
    id: `incident-${incident.fingerprint}`,
    severity: incidentSeverityToFindingSeverity(incident.severity, incident.lifecycle),
    category: incidentCategoryToFindingCategory(incident.category),
    confidence: incidentConfidenceToFindingConfidence(incident.confidence),
    session: incident.session ?? undefined,
    issue: incident.taskId ?? undefined,
    title: incident.summary,
    evidence: [
      `incident=${incident.fingerprint}`,
      `rootCause=${incident.rootCauseClass}`,
      `lifecycle=${incident.lifecycle}`,
      `occurrences=${incident.occurrenceCount}`,
      ...incidentChainEvidenceLines(incident),
      ...incident.evidence.slice(-2).map((evidence) => `${evidence.type}:${basename(evidence.source)} ${evidence.redactedData}`),
    ],
    recommendation: incident.operatorAction,
  };
}

function incidentSeverityToFindingSeverity(severity: IncidentRecord['severity'], lifecycle: IncidentRecord['lifecycle']): Severity {
  if (severity === 'critical') return 'urgent';
  if (severity === 'high') return lifecycle === 'active' ? 'urgent' : 'high';
  if (severity === 'medium') return 'medium';
  return 'low';
}

function incidentCategoryToFindingCategory(category: IncidentRecord['category']): Category {
  if (category === 'product_defect') return 'crash';
  if (category === 'stale_orphaned_state' || category === 'model_task_harness_outcome') return 'stuck';
  if (category === 'configuration_operator_condition') return 'operational';
  return 'warning';
}

function incidentConfidenceToFindingConfidence(confidence: IncidentRecord['confidence']): Confidence {
  if (confidence === 'definite' || confidence === 'high') return 'high';
  if (confidence === 'medium') return 'medium';
  return 'low';
}

function dedupeIncidents(incidents: IncidentRecord[]): IncidentRecord[] {
  const byFingerprint = new Map<string, IncidentRecord>();
  for (const incident of incidents) {
    byFingerprint.set(incident.fingerprint, incident);
  }
  return [...byFingerprint.values()].sort((a, b) => Date.parse(b.lastObservedAt) - Date.parse(a.lastObservedAt));
}

function dedupeIncidentCandidates(candidates: IncidentRecord[], store: IncidentStore): IncidentRecord[] {
  const byFingerprint = new Map<string, IncidentRecord>();
  for (const candidate of candidates) {
    const normalized = {
      ...candidate,
      taskId: candidate.taskId ?? null,
      evidence: candidate.evidence,
      metadata: candidate.metadata ?? {},
    };
    const fingerprint = store.computeFingerprint(normalized);
    const existing = byFingerprint.get(fingerprint);
    if (!existing) {
      byFingerprint.set(fingerprint, normalized);
      continue;
    }
    byFingerprint.set(fingerprint, {
      ...existing,
      severity: maxIncidentSeverity(existing.severity, normalized.severity),
      confidence: maxIncidentConfidence(existing.confidence, normalized.confidence),
      summary: normalized.summary,
      operatorAction: normalized.operatorAction,
      evidence: dedupeIncidentEvidence([...existing.evidence, ...normalized.evidence]),
      metadata: {
        ...existing.metadata,
        ...normalized.metadata,
      },
    });
  }
  return [...byFingerprint.values()];
}

function dedupeIncidentEvidence(evidence: IncidentRecord['evidence']): IncidentRecord['evidence'] {
  const byKey = new Map<string, IncidentRecord['evidence'][number]>();
  for (const item of evidence) {
    byKey.set(`${item.type}:${item.source}:${item.key ?? ''}:${item.timestamp}:${item.redactedData}`, item);
  }
  return [...byKey.values()];
}

function maxIncidentSeverity(a: IncidentRecord['severity'], b: IncidentRecord['severity']): IncidentRecord['severity'] {
  const order: IncidentRecord['severity'][] = ['info', 'low', 'medium', 'high', 'critical'];
  return order.indexOf(b) > order.indexOf(a) ? b : a;
}

function maxIncidentConfidence(a: IncidentRecord['confidence'], b: IncidentRecord['confidence']): IncidentRecord['confidence'] {
  const order: IncidentRecord['confidence'][] = ['low', 'medium', 'high', 'definite'];
  return order.indexOf(b) > order.indexOf(a) ? b : a;
}

function mergeObserverLinearConfig(config: ObserverLinearConfig, options: ObserverOptions): ObserverLinearConfig {
  let policies = config.policies;
  if (options.incidentsPolicy) {
    const parsed = JSON.parse(options.incidentsPolicy) as Partial<ObserverLinearConfig['policies']>;
    policies = {
      product_defect: { ...policies.product_defect, ...(parsed.product_defect ?? {}) },
      model_task_harness_outcome: { ...policies.model_task_harness_outcome, ...(parsed.model_task_harness_outcome ?? {}) },
      external_transient_dependency: { ...policies.external_transient_dependency, ...(parsed.external_transient_dependency ?? {}) },
      configuration_operator_condition: { ...policies.configuration_operator_condition, ...(parsed.configuration_operator_condition ?? {}) },
      stale_orphaned_state: { ...policies.stale_orphaned_state, ...(parsed.stale_orphaned_state ?? {}) },
    };
  }
  // Resolve effective mode: explicit CLI mode wins; --incidents-shadow forces
  // shadow; --incidents-dry-run remains an alias for offline; otherwise the
  // config-derived mode stands. CLI live still requires enabled=true in
  // config so this task cannot accidentally flip live filing on.
  let mode = config.mode;
  if (options.incidentsMode) {
    mode = options.incidentsMode;
  } else if (options.incidentsShadow) {
    mode = 'shadow';
  } else if (options.incidentsDryRun) {
    mode = 'offline';
  }
  if (options.serviceMode) {
    // Fail-closed enforcement for the managed Backstage service. These guards
    // are defense-in-depth behind the deterministic command builder: even if an
    // unsafe invocation reaches the process it can never mutate Linear.
    //
    // A generic --dry-run protects only the legacy --file-linear path; it is
    // never the incident-sync safety control. Live filing in the service must
    // be requested explicitly via --incidents-mode=live — a bare
    // --file-incidents can never silently select live.
    if (mode === 'live' && options.incidentsMode !== 'live') {
      mode = 'shadow';
    }
    // Live still requires the legacy enabled interlock; downgrade rather than
    // throw so the managed pane never enters a crash/respawn loop.
    if (mode === 'live' && !config.enabled) {
      mode = 'shadow';
    }
    // A missing credential fails closed to off (no reads, no restart storm)
    // without ever exposing the key itself.
    if ((mode === 'live' || mode === 'shadow') && !process.env.LINEAR_API_KEY) {
      mode = 'off';
    }
  } else if (mode === 'live' && !config.enabled) {
    throw new Error('observer: incidents-mode=live requires observer.linear.enabled=true in config');
  }
  return {
    ...config,
    enabled: config.enabled,
    detectionOnly: config.detectionOnly || options.incidentsDryRun || mode === 'offline',
    mode,
    project: options.linearProject ?? config.project,
    team: options.linearTeam ?? config.team,
    label: options.linearLabel ?? config.label,
    policies,
  };
}

function emptyIncidentSyncSnapshot(mode?: IncidentSyncSnapshot['mode']): IncidentSyncSnapshot {
  return {
    mode,
    totalProcessed: 0,
    created: 0,
    updated: 0,
    failed: 0,
    skipped: 0,
    queued: 0,
    retryProcessed: 0,
    retrySucceeded: 0,
    retryFailed: 0,
    lifecycleSynced: 0,
    lifecycleFailed: 0,
    lifecycleRetried: 0,
    lifecycleResults: [],
    results: [],
    errors: [],
  };
}

function emptyShadowSnapshot(): IncidentSyncShadowSnapshot {
  return {
    eligible: 0,
    proposedCreate: 0,
    proposedUpdate: 0,
    noOp: 0,
    skipRecovered: 0,
    ambiguous: 0,
    redactionFailures: 0,
    correlationCollisions: 0,
    mutationAttempts: 0,
  };
}

function collectSyncResult(summary: IncidentSyncSnapshot, result: SyncResult): void {
  summary.totalProcessed += 1;
  summary.results.push(result);
  if (result.status === 'created') summary.created += 1;
  else if (result.status === 'updated') summary.updated += 1;
  else if (result.status === 'queued') summary.queued += 1;
  else if (result.status === 'failed') summary.failed += 1;
  else summary.skipped += 1;
  if (result.status === 'failed' || result.status === 'queued') {
    summary.errors.push({
      fingerprint: result.fingerprint,
      action: result.action,
      reason: result.reason ?? 'unknown',
      nextRetry: result.nextRetryAt,
    });
  }
  if (summary.shadow && result.shadowPlan) {
    summary.shadow.eligible += 1;
    switch (result.action) {
      case 'create':
        summary.shadow.proposedCreate += 1;
        break;
      case 'update_comment':
        summary.shadow.proposedUpdate += 1;
        break;
      case 'no_op':
        summary.shadow.noOp += 1;
        break;
      case 'skip_recovered':
        summary.shadow.skipRecovered += 1;
        break;
      case 'unknown_needs_lookup':
        summary.shadow.ambiguous += 1;
        break;
    }
    const summary_ = result.shadowPlan.redactionSummary;
    if (summary_.redactionEnabled && summary_.markersFound.length === 0
        && (result.shadowPlan.plannedBody || result.shadowPlan.plannedCommentBody)) {
      // A shadow record with redaction enabled but no markers means either
      // there was nothing to redact (normal) or the redactor silently failed.
      // We only surface this when redaction is enabled and there is a body
      // that contains a suspicious raw pattern; a naive check follows.
      const combined = `${result.shadowPlan.plannedBody ?? ''}\n${result.shadowPlan.plannedCommentBody ?? ''}`;
      if (/(api[_-]?key|token|secret|password|credential|private[_-]?key)\s*[=:]\s*\S+/i.test(combined)
          || /Bearer\s+[A-Za-z0-9._~+/=-]+/i.test(combined)) {
        summary.shadow.redactionFailures += 1;
      }
    }
    if (result.shadowPlan.correlationTarget.candidateCount > 1) {
      summary.shadow.correlationCollisions += 1;
    }
  }
}

function incidentStoreForRepo(repo: RepoSnapshot, options: ObserverOptions): IncidentStore | null {
  const incidentConfig = getIncidentConfig(repo.repoDir);
  if (incidentConfig.enabled === false) return null;
  const storeDir = incidentConfig.store?.directory ?? '.wavemill/incidents';
  return new IncidentStore(
    isAbsolute(storeDir) ? storeDir : join(repo.repoDir, storeDir),
    {
      escalationThreshold: options.dependencyThreshold ?? incidentConfig.detection?.dependencyThreshold ?? 3,
      maxEvidencePerRecord: incidentConfig.detection?.maxEvidencePerRecord ?? 50,
      resolutionAfterCycles: incidentConfig.detection?.resolutionAfterCycles ?? 5,
    },
  );
}

export async function syncIncidentsToLinear(snapshot: ObserverSnapshot, options: ObserverOptions): Promise<ObserverSnapshot> {
  if (!options.fileIncidents && !options.incidentsReplay) return snapshot;
  const summary = emptyIncidentSyncSnapshot();
  for (const repo of snapshot.repos) {
    let store: IncidentStore | null;
    let config: ObserverLinearConfig;
    try {
      store = incidentStoreForRepo(repo, options);
      if (!store) continue;
      config = mergeObserverLinearConfig(getObserverLinearConfig(repo.repoDir), options);
    } catch (error) {
      summary.errors.push({
        fingerprint: `config-${hashText(repo.repoDir)}`,
        action: 'skipped',
        reason: error instanceof Error ? error.message : String(error),
      });
      addConfigDegradedFindingIfMissing(snapshot.findings, repo, error, 'incident Linear sync');
      continue;
    }
    // Record the strictest mode encountered across repos on the snapshot.
    summary.mode = summary.mode ? maxObserverLinearMode(summary.mode, config.mode) : config.mode;
    // Fail-closed: in the managed service an `off` mode (including one
    // downgraded from live/shadow by the enforcement above, e.g. a missing
    // credential) performs neither Linear reads nor mutations — even if
    // --file-incidents was supplied. Nothing below this point may run for an
    // off managed repo. (CLI off retains its legacy dry accounting.)
    if (options.serviceMode && config.mode === 'off') {
      continue;
    }
    const shadowMode = config.mode === 'shadow';
    if (shadowMode && !summary.shadow) {
      summary.shadow = emptyShadowSnapshot();
    }
    try {
      if (!config.detectionOnly && !shadowMode) {
        const retry = await drainIncidentQueue({
          repoDir: repo.repoDir,
          queuePath: config.retryQueuePath,
          store,
          config,
          maxEntries: config.maxRetryEntriesPerPass,
          now: new Date(snapshot.timestamp),
          log: console,
        });
        summary.retryProcessed += retry.processed;
        summary.retrySucceeded += retry.succeeded;
        summary.retryFailed += retry.failed;
      }
    } catch (error) {
      summary.errors.push({
        fingerprint: 'retry-queue',
        action: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    const incidentsRaw = options.incidentsReplay
      ? [await store.getIncident(options.incidentsReplay)].filter((incident): incident is IncidentRecord => incident !== null)
      : await store.getIncidents();
    // HOK-3243: drop suppressed classes before cap/filing so noisy lifecycle
    // classes never consume the per-pass budget. The incidents still land in
    // `.wavemill/incidents/` for local analysis; only Linear filing is
    // skipped. An explicit `--incidents-replay` on a suppressed fingerprint
    // bypasses the filter so operators can still re-sync by hand.
    const suppressedClasses = new Set(config.suppress.classes);
    const perClassSuppressed: Partial<Record<IncidentRootCauseClass, number>> = {};
    const incidents: IncidentRecord[] = [];
    for (const incident of incidentsRaw) {
      if (!options.incidentsReplay && suppressedClasses.has(incident.rootCauseClass)) {
        perClassSuppressed[incident.rootCauseClass] =
          (perClassSuppressed[incident.rootCauseClass] ?? 0) + 1;
        continue;
      }
      incidents.push(incident);
    }
    const perClassSuppressedCount = Object.values(perClassSuppressed).reduce(
      (sum, count) => sum + (count ?? 0),
      0,
    );
    if (perClassSuppressedCount > 0) {
      summary.skipped += perClassSuppressedCount;
      summary.suppressedByClass = { ...(summary.suppressedByClass ?? {}) };
      for (const [className, count] of Object.entries(perClassSuppressed)) {
        const key = className as IncidentRootCauseClass;
        summary.suppressedByClass[key] =
          (summary.suppressedByClass[key] ?? 0) + (count ?? 0);
      }
    }
    // Per-pass cap fix: only the fully offline mode bypasses the cap; shadow
    // and live both honour maxIncidentsPerPass so a shadow trial cannot make
    // an unbounded number of correlation searches per pass.
    const bypassCap = (config.mode === 'offline' || (config.detectionOnly && config.mode !== 'shadow')) || Boolean(options.incidentsReplay);
    const incidentsForPass = bypassCap
      ? incidents
      : incidents.slice(0, config.maxIncidentsPerPass);
    if (!bypassCap && incidentsForPass.length < incidents.length) {
      summary.skipped += incidents.length - incidentsForPass.length;
    }
    const lookupBudget = shadowMode
      ? createLookupBudget(config.shadow.maxLookupsPerPass)
      : undefined;
    // Mutation attempts always resolve to zero in a healthy shadow pass —
    // the read-only wrapper's counter is checked in-process and syncIncident
    // throws on the first attempt. The counter is kept here so any future
    // path that swallows the throw still surfaces a non-zero value.
    const mutationAttemptsThisPass = 0;
    const shadowRecords: ShadowAuditRecord[] = [];
    for (const incident of incidentsForPass) {
      const result = await syncIncident({
        incident,
        store,
        config,
        dryRun: options.incidentsDryRun || shadowMode,
        shadow: shadowMode,
        replay: options.incidentsReplay === incident.fingerprint,
        now: new Date(snapshot.timestamp),
        retryQueue: shadowMode ? undefined : {
          enqueueIncidentSync: (input) => enqueueIncidentSync({
            repoDir: repo.repoDir,
            queuePath: config.retryQueuePath,
            incidentFingerprint: input.incidentFingerprint,
            linearAction: input.linearAction,
            linearIssueId: input.linearIssueId,
            lastError: input.lastError,
            now: input.now,
          }),
        },
        repoDir: repo.repoDir,
        lookupBudget,
      });
      collectSyncResult(summary, result);
      if (shadowMode && result.shadowPlan) {
        const record = buildShadowAuditRecord(result.shadowPlan, {
          recordedAt: snapshot.timestamp,
          repoDir: repo.repoDir,
          session: repo.session,
          mutationAttempts: 0,
        });
        shadowRecords.push(record);
        try {
          appendShadowRecord(
            config.shadow.auditPath,
            record,
            { maxEntries: config.shadow.maxEntries, maxAgeDays: config.shadow.maxAgeDays, now: new Date(snapshot.timestamp) },
            repo.repoDir,
          );
        } catch (error) {
          summary.errors.push({
            fingerprint: result.fingerprint,
            action: 'shadow-audit',
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    // Lifecycle transition sync (HOK-3035): resolved/archived/recurrent linked
    // records are excluded from getIncidents(), so fetch them separately. A
    // degraded detection cycle (config load failure) must not resolve or close.
    const cycleComplete = !snapshot.findings.some(
      (finding) => finding.repoDir === repo.repoDir && finding.id.startsWith('config-integrity-'),
    );
    try {
      const lifecyclePending = await store.getLifecyclePendingIncidents();
      const lifecycleForPass = bypassCap ? lifecyclePending : lifecyclePending.slice(0, config.maxIncidentsPerPass);
      for (const incident of lifecycleForPass) {
        const lifecycleResult = await syncIncidentLifecycle({
          incident,
          store,
          config,
          dryRun: options.incidentsDryRun || shadowMode,
          shadow: shadowMode,
          cycleComplete,
          now: new Date(snapshot.timestamp),
          repoDir: repo.repoDir,
          retryQueue: shadowMode ? undefined : {
            enqueueLifecycleSync: (input) => enqueueIncidentSync({
              repoDir: repo.repoDir,
              queuePath: config.retryQueuePath,
              incidentFingerprint: input.incidentFingerprint,
              linearAction: 'lifecycle',
              linearIssueId: input.linearIssueId,
              lifecycleKind: input.lifecycleKind,
              transitionRevision: input.transitionRevision,
              lastError: input.lastError,
              now: input.now,
            }),
          },
        });
        summary.lifecycleResults.push(lifecycleResult);
        if (lifecycleResult.status === 'synced') summary.lifecycleSynced += 1;
        else if (lifecycleResult.status === 'failed') summary.lifecycleFailed += 1;
        else if (lifecycleResult.status === 'queued') summary.lifecycleRetried += 1;
      }
    } catch (error) {
      summary.errors.push({
        fingerprint: 'lifecycle-sync',
        action: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    if (shadowMode) {
      if (summary.shadow) {
        summary.shadow.mutationAttempts += mutationAttemptsThisPass;
        summary.shadow.auditPath = config.shadow.auditPath;
        summary.shadow.countersPath = config.shadow.countersPath;
        if (lookupBudget) {
          summary.shadow.lookupBudgetUsed = lookupBudget.used;
          summary.shadow.lookupBudgetMax = lookupBudget.max;
          summary.shadow.lookupBudgetExhausted = lookupBudget.exhausted;
        }
      }
      try {
        await updateShadowCounters(
          config.shadow.countersPath,
          {
            eligible: shadowRecords.length,
            proposedCreate: shadowRecords.filter((r) => r.action === 'create').length,
            proposedUpdate: shadowRecords.filter((r) => r.action === 'update_comment').length,
            noOp: shadowRecords.filter((r) => r.action === 'no_op').length,
            skipRecovered: shadowRecords.filter((r) => r.action === 'skip_recovered').length,
            skip: shadowRecords.filter((r) => r.action === 'skip').length,
            failed: shadowRecords.filter((r) => r.action === 'failed').length,
            correlationCollisions: shadowRecords.filter((r) => r.correlationTarget.candidateCount > 1).length,
            mutationAttempts: mutationAttemptsThisPass,
          },
          { lastRunAt: snapshot.timestamp, lastAuditPath: config.shadow.auditPath },
          repo.repoDir,
        );
      } catch (error) {
        summary.errors.push({
          fingerprint: 'shadow-counters',
          action: 'shadow-audit',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return { ...snapshot, incidentSync: summary };
}

function maxObserverLinearMode(a: IncidentSyncSnapshot['mode'], b: IncidentSyncSnapshot['mode']): IncidentSyncSnapshot['mode'] {
  const order = ['off', 'offline', 'shadow', 'live'] as const;
  const ai = order.indexOf(a ?? 'off');
  const bi = order.indexOf(b ?? 'off');
  return order[Math.max(ai, bi)];
}

/**
 * HOK-3097: apply opt-in observer self-repair actions. Returns the snapshot
 * unchanged when the master switch is off (byte-identical no-op). Appends
 * action records to `<incidentStoreDir>/actions.jsonl` and `low`/`medium`
 * findings to the snapshot for the dashboard.
 */
export async function applyAutoFixes(
  snapshot: ObserverSnapshot,
  options: ObserverOptions,
): Promise<ObserverSnapshot> {
  const now = new Date(snapshot.timestamp);
  for (const repo of snapshot.repos) {
    let config: ObserverAutoFixConfig;
    try {
      config = getObserverAutoFixConfig(repo.repoDir);
    } catch (error) {
      addConfigDegradedFindingIfMissing(snapshot.findings, repo, error, 'observer auto-fix');
      continue;
    }
    if (!config.enabled) continue;

    let incidentStoreDir: string;
    try {
      const incidentConfig = getIncidentConfig(repo.repoDir);
      const storeDir = incidentConfig.store?.directory ?? '.wavemill/incidents';
      incidentStoreDir = isAbsolute(storeDir) ? storeDir : join(repo.repoDir, storeDir);
    } catch {
      incidentStoreDir = join(repo.repoDir, '.wavemill', 'incidents');
    }

    const progressByIssue = new Map<string, TaskProgress>();
    const progressLookup = makeProgressLookup(repo, now.getTime());
    for (const task of repo.tasks) {
      const progress = progressLookup(task);
      if (progress) progressByIssue.set(task.issue, progress);
    }

    const context: AutoFixRepoContext = {
      repoDir: repo.repoDir,
      session: repo.session,
      workflowStatePath: repo.workflowStatePath,
      effectiveBaseBranch: (task) => observerBaseBranchForIssue(repo, task.issue),
      resolveTaskStateDir: (task) => resolveTaskStateDir(repo.repoDir, task as ObservedTask),
      incidentStoreDir,
    };

    const deps: AutoFixDeps = {
      git: (args, cwd) => {
        const result = execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
        return typeof result === 'string' ? result : String(result);
      },
      gh: (args, cwd) => {
        const result = run('gh', args, 20_000, cwd);
        return result;
      },
      updateBranchWithBase: (branch, baseBranch, worktree) => updateBranchWithBase(branch, baseBranch, worktree),
      readWorktreeDirtyStatus: (worktree) => readWorktreeDirtyStatus({ worktree }),
      getProgress: (task) => progressByIssue.get(task.issue),
      abortTaskInState: (stateFile, issue, reason) => abortTaskInState(stateFile, issue, reason).then(() => undefined),
    };

    const candidateFindings: AutoFixCandidateFinding[] = snapshot.findings
      .filter((f) => f.repoDir === repo.repoDir)
      .map((f) => ({ id: f.id, issue: f.issue, severity: f.severity }));

    const tasks = repo.tasks.map((task): AutoFixTask => ({
      issue: task.issue,
      slug: task.slug,
      phase: task.phase,
      status: task.status,
      pr: task.pr,
      worktree: task.worktree,
      branch: task.branch,
      challengeRole: task.challengeRole,
      challengePairId: task.challengePairId,
      challengeAborted: task.challengeAborted,
      evalCompleted: task.evalCompleted,
    }));

    try {
      const { records, findings } = await runObserverAutoFixes({
        repo: context,
        tasks,
        findings: candidateFindings,
        config,
        deps,
        now,
        dryRun: options.autoFixDryRun,
      });
      // Record planned records in dry-run mode too so operators can preview;
      // either way the write happens via the same append path.
      if (records.length > 0) {
        appendAutoFixActionRecords(incidentStoreDir, records);
      }
      snapshot.findings.push(...findings);
    } catch (error) {
      snapshot.findings.push({
        id: `observer-auto-fix-error-${repo.session}-${hashText(repo.repoDir)}`,
        severity: 'medium',
        category: 'operational',
        confidence: 'high',
        session: repo.session,
        repoDir: repo.repoDir,
        title: 'Observer auto-fix pass failed',
        evidence: [`error=${error instanceof Error ? error.message : String(error)}`],
        recommendation: 'Inspect the observer log; auto-fix is off until the error clears.',
      });
    }
  }
  return snapshot;
}

/**
 * HOK-3097: send desktop/push notifications for urgent/high findings that
 * persist past the configured threshold. Journal persisted at
 * `.wavemill/observer/alert-state.json`.
 */
export async function sendAlerts(
  snapshot: ObserverSnapshot,
  _options: ObserverOptions,
): Promise<ObserverSnapshot> {
  const now = new Date(snapshot.timestamp);
  for (const repo of snapshot.repos) {
    let config: ObserverAlertsConfig;
    try {
      config = getObserverAlertsConfig(repo.repoDir);
    } catch (error) {
      addConfigDegradedFindingIfMissing(snapshot.findings, repo, error, 'observer alerts');
      continue;
    }
    if (!config.enabled) continue;

    const journalPath = join(repo.repoDir, '.wavemill', 'observer', 'alert-state.json');
    const findings: AlertFinding[] = snapshot.findings
      .filter((f) => f.repoDir === repo.repoDir)
      .map((f) => ({
        id: f.id,
        severity: f.severity,
        title: f.title,
        recommendation: f.recommendation,
        issue: f.issue,
        repoDir: f.repoDir,
        session: f.session,
        ...(f.oneShot ? { oneShot: true } : {}),
      }));

    try {
      const result = await runObserverAlerts({
        findings,
        config,
        now,
        deps: {
          loadJournal: () => {
            if (!existsSync(journalPath)) return { findings: {} };
            try {
              const parsed = JSON.parse(readFileSync(journalPath, 'utf8')) as AlertJournal;
              return parsed && typeof parsed === 'object' ? parsed : { findings: {} };
            } catch {
              return { findings: {} };
            }
          },
          writeJournal: (next) => {
            try {
              mutateJsonStateSync<AlertJournal>(
                journalPath,
                () => next,
                { createIfMissing: true, initial: { findings: {} } },
              );
            } catch {
              // non-fatal
            }
          },
          sendDesktop: (title, body) => sendDesktopNotification(title, body, detectDesktopPlatform(process.platform)),
          sendPush: (url, format, payload) => sendPushNotification(url, format, payload),
          redact: (text) => redactObserverText(text),
        },
      });
      for (const failure of result.sendFailures) {
        snapshot.findings.push({
          id: `observer-alert-send-failed-${repo.session}-${hashText(failure.findingId + failure.detail)}`,
          severity: 'low',
          category: 'operational',
          confidence: 'high',
          session: repo.session,
          repoDir: repo.repoDir,
          title: `Observer alert send failed for ${failure.findingId}`,
          evidence: [`findingId=${failure.findingId}`, `detail=${failure.detail}`],
          recommendation: 'Verify the push URL and desktop notification tooling; alerts are best-effort.',
        });
      }
    } catch (error) {
      snapshot.findings.push({
        id: `observer-alert-error-${repo.session}-${hashText(repo.repoDir)}`,
        severity: 'low',
        category: 'operational',
        confidence: 'high',
        session: repo.session,
        repoDir: repo.repoDir,
        title: 'Observer alerts pass failed',
        evidence: [`error=${error instanceof Error ? error.message : String(error)}`],
        recommendation: 'Inspect the observer log; alerts are off until the error clears.',
      });
    }
  }
  return snapshot;
}

function addConfigDegradedFindingIfMissing(findings: Finding[], repo: RepoSnapshot, error: unknown, operation: string): void {
  if (findings.some((finding) => finding.repoDir === repo.repoDir && finding.id.startsWith('config-integrity-'))) {
    return;
  }
  findings.push({
    id: `config-integrity-degraded-${repo.session}-${hashText(`${repo.repoDir}:${operation}`)}`,
    severity: 'medium',
    category: 'operational',
    confidence: 'high',
    session: repo.session,
    repoDir: repo.repoDir,
    title: `Observer skipped ${operation} because wavemill config failed to load`,
    evidence: [`repo=${repo.repoDir}`, `error=${error instanceof Error ? error.message : String(error)}`],
    recommendation: 'Repair wavemill config/schema integrity. Observer degraded mode kept config-independent detectors running.',
  });
}

interface BackstageHealthFile {
  updatedAt?: string;
  services?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

export function redactObserverText(value: string): string {
  return value
    .replace(/(LINEAR_API_KEY|OPENAI_API_KEY|OPENROUTER_API_KEY|GH_TOKEN|GITHUB_TOKEN|ANTHROPIC_API_KEY)=\S+/gi, '$1=[redacted]')
    .replace(/(api[_-]?key|token|secret|password)=\S+/gi, '$1=[redacted]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]+/gi, '$1 [redacted]')
    .replace(/(prompt|transcript)=.+/gi, '$1=[redacted]');
}

function redactFinding(finding: Finding): Finding {
  return {
    ...finding,
    title: redactObserverText(finding.title),
    evidence: finding.evidence.map(redactObserverText).filter((line) => !/\b(full prompt|transcript path|conversation transcript)\b/i.test(line)),
    recommendation: redactObserverText(finding.recommendation),
  };
}

function redactSnapshot(snapshot: ObserverSnapshot): ObserverSnapshot {
  return {
    ...snapshot,
    processes: snapshot.processes.map((row) => ({ ...row, command: redactObserverText(row.command) })),
    findings: snapshot.findings.map(redactFinding),
  };
}

export async function writeServiceHeartbeat(snapshot: ObserverSnapshot, options: ObserverOptions): Promise<void> {
  if (!options.serviceMode || !options.repoDir) return;
  const healthPath = join(options.repoDir, '.wavemill', 'backstage-health.json');
  const counts = snapshot.findings.reduce<Record<Severity, number>>((acc, finding) => {
    acc[finding.severity] += 1;
    return acc;
  }, { urgent: 0, high: 0, medium: 0, low: 0 });

  await mutateJsonState<BackstageHealthFile>(
    healthPath,
    (current) => {
      const next = { ...(current ?? {}) };
      const services = { ...(next.services ?? {}) };
      const existing = { ...(services.observer ?? {}) };
      // Surface config source and credential readiness (boolean only — the key
      // itself is never read into or written from this health file).
      let configSource: string | undefined;
      try {
        const linear = loadWavemillConfig(options.repoDir).observer?.linear;
        configSource = resolveObserverLinearModeSource(linear);
      } catch {
        configSource = undefined;
      }
      const credentialReady = Boolean(process.env.LINEAR_API_KEY);
      const lastError = snapshot.incidentSync?.errors?.[snapshot.incidentSync.errors.length - 1];
      const incidentSyncSummary = snapshot.incidentSync ? {
        mode: snapshot.incidentSync.mode ?? 'off',
        configSource,
        credentialReady,
        lastRunAt: snapshot.timestamp,
        totalProcessed: snapshot.incidentSync.totalProcessed,
        created: snapshot.incidentSync.created,
        updated: snapshot.incidentSync.updated,
        skipped: snapshot.incidentSync.skipped,
        failed: snapshot.incidentSync.failed,
        queued: snapshot.incidentSync.queued,
        retryProcessed: snapshot.incidentSync.retryProcessed,
        retryFailed: snapshot.incidentSync.retryFailed,
        lastFailure: lastError
          ? { action: lastError.action, reason: redactObserverText(lastError.reason) }
          : undefined,
        lifecycleSynced: snapshot.incidentSync.lifecycleSynced,
        lifecycleFailed: snapshot.incidentSync.lifecycleFailed,
        lifecycleRetried: snapshot.incidentSync.lifecycleRetried,
        suppressedByClass: snapshot.incidentSync.suppressedByClass,
        shadow: snapshot.incidentSync.shadow ? {
          eligible: snapshot.incidentSync.shadow.eligible,
          proposedCreate: snapshot.incidentSync.shadow.proposedCreate,
          proposedUpdate: snapshot.incidentSync.shadow.proposedUpdate,
          noOp: snapshot.incidentSync.shadow.noOp,
          skipRecovered: snapshot.incidentSync.shadow.skipRecovered,
          ambiguous: snapshot.incidentSync.shadow.ambiguous,
          redactionFailures: snapshot.incidentSync.shadow.redactionFailures,
          correlationCollisions: snapshot.incidentSync.shadow.correlationCollisions,
          mutationAttempts: snapshot.incidentSync.shadow.mutationAttempts,
          auditPath: snapshot.incidentSync.shadow.auditPath,
          countersPath: snapshot.incidentSync.shadow.countersPath,
          lookupBudgetUsed: snapshot.incidentSync.shadow.lookupBudgetUsed,
          lookupBudgetMax: snapshot.incidentSync.shadow.lookupBudgetMax,
          lookupBudgetExhausted: snapshot.incidentSync.shadow.lookupBudgetExhausted,
        } : undefined,
      } : undefined;
      services.observer = {
        ...existing,
        status: 'healthy',
        detail: `observer heartbeat: findings urgent=${counts.urgent} high=${counts.high} medium=${counts.medium} low=${counts.low}`,
        heartbeatAt: snapshot.timestamp,
        updatedAt: snapshot.timestamp,
        restartAttemptCount: 0,
        lastRestartAttemptAt: null,
        session: options.session ?? snapshot.sessions[0] ?? null,
        repoDir: options.repoDir,
        findingCounts: counts,
        incidentSync: incidentSyncSummary,
      };
      next.updatedAt = snapshot.timestamp;
      next.services = services;
      return next;
    },
    { createIfMissing: true, initial: {} },
  );
}

export function compactSnapshotForRender(snapshot: ObserverSnapshot): ObserverSnapshot {
  const downstreamCounts = countGroupedFindings(snapshot.findings);
  const findings = snapshot.findings
    .filter((finding) => !finding.groupedUnder)
    .map((finding) => {
      const downstreamCount = downstreamCounts.get(finding.id) ?? 0;
      if (downstreamCount === 0) return finding;
      return { ...finding, title: `${finding.title} (+${downstreamCount} downstream)` };
    });
  return { ...snapshot, findings };
}

function renderSummary(snapshot: ObserverSnapshot): string {
  const activeTasks = snapshot.repos.flatMap((repo) => repo.tasks.filter((task) => !taskWorkflowIsTerminal(task)));
  const counts: Record<Severity, number> = { urgent: 0, high: 0, medium: 0, low: 0 };
  for (const finding of snapshot.findings) {
    counts[finding.severity] += 1;
  }
  const lines = [
    `Wavemill Observer ${snapshot.timestamp}`,
    `Sessions inspected: ${snapshot.sessions.length || 0}`,
    `Repos inspected: ${snapshot.repos.length || 0}`,
    `Active tasks: ${activeTasks.length}`,
    `Findings: urgent=${counts.urgent} high=${counts.high} medium=${counts.medium} low=${counts.low}`,
  ];
  const downstreamCounts = countGroupedFindings(snapshot.findings);
  const visibleFindings = snapshot.findings.filter((finding) => !finding.groupedUnder);
  for (const finding of visibleFindings.slice(0, 20)) {
    lines.push('');
    lines.push(`[${finding.severity}/${finding.category}/${finding.confidence}] ${finding.title}`);
    if (finding.session) lines.push(`  session: ${finding.session}`);
    if (finding.repoDir) lines.push(`  repo: ${finding.repoDir}`);
    if (finding.issue) lines.push(`  issue: ${finding.issue}`);
    for (const item of finding.evidence.slice(0, 4)) {
      lines.push(`  evidence: ${item}`);
    }
    const downstreamCount = downstreamCounts.get(finding.id) ?? 0;
    if (downstreamCount > 0) {
      lines.push(`  downstream: ${downstreamCount} finding(s) grouped under this root cause`);
    }
    lines.push(`  recommendation: ${finding.recommendation}`);
    if (finding.linearIssueUrl) lines.push(`  linear: ${finding.linearIssueUrl}`);
  }
  if (visibleFindings.length > 20) {
    lines.push('');
    lines.push(`... ${visibleFindings.length - 20} additional finding(s) omitted from text summary`);
  }
  if (snapshot.incidents && snapshot.incidents.length > 0) {
    lines.push('');
    lines.push(`Incidents: ${snapshot.incidents.length}`);
    for (const incident of snapshot.incidents.slice(0, 8)) {
      lines.push(`  [${incident.lifecycle}/${incident.category}/${incident.confidence}] ${incident.rootCauseClass}: ${incident.summary}`);
      const chain = Array.isArray(incident.metadata?.causalChain) ? incident.metadata.causalChain : [];
      if (chain.length > 0) lines.push(`  cause: ${chain.map((entry) => entry.cause).join(' → ')}`);
      lines.push(`  action: ${incident.operatorAction}`);
    }
  }
  if (snapshot.remediationProposals && snapshot.remediationProposals.length > 0) {
    lines.push('');
    lines.push(`Remediation proposals (not authorization): ${snapshot.remediationProposals.length}${snapshot.remediationProposalErrors ? ` (${snapshot.remediationProposalErrors} invalid dropped)` : ''}`);
    for (const item of snapshot.remediationProposals.slice(0, 8)) {
      const target = item.proposal.target;
      const targetText = target?.prNumber ? ` PR #${target.prNumber}` : '';
      lines.push(`  ${item.proposal.kind}@${item.proposal.schemaVersion}${targetText} [${item.issue ?? 'repo'}] allowed=${(item.proposal.allowedActions ?? []).join(',') || 'none'}`);
    }
  }
  if (snapshot.recoveredIncidents && snapshot.recoveredIncidents.length > 0) {
    lines.push('');
    lines.push(`Recovered incidents: ${snapshot.recoveredIncidents.length}`);
    for (const item of snapshot.recoveredIncidents.slice(0, 8)) {
      lines.push(`  ${item.rootCauseClass} ${item.fingerprint.slice(0, 16)} ${item.reason}${item.evidence ? ` (${item.evidence})` : ''}`);
    }
  }
  if (snapshot.incidentSync) {
    const sync = snapshot.incidentSync;
    lines.push('');
    lines.push(`Incident Linear sync${sync.mode ? ` (mode=${sync.mode})` : ''}: processed=${sync.totalProcessed} created=${sync.created} updated=${sync.updated} queued=${sync.queued} skipped=${sync.skipped} failed=${sync.failed}`);
    if (sync.retryProcessed > 0) {
      lines.push(`Incident retry queue: processed=${sync.retryProcessed} succeeded=${sync.retrySucceeded} failed=${sync.retryFailed}`);
    }
    if (sync.shadow) {
      const s = sync.shadow;
      lines.push(`Incident Linear shadow: eligible=${s.eligible} proposedCreate=${s.proposedCreate} proposedUpdate=${s.proposedUpdate} noOp=${s.noOp} skipRecovered=${s.skipRecovered} ambiguous=${s.ambiguous} redactionFailures=${s.redactionFailures} correlationCollisions=${s.correlationCollisions} mutationAttempts=${s.mutationAttempts}`);
    }
    for (const result of sync.results.slice(0, 8)) {
      lines.push(`  ${result.action}: ${result.fingerprint.slice(0, 16)} ${result.issueId ?? ''} ${result.reason ?? ''}`.trimEnd());
    }
  }
  return `${lines.join('\n')}\n`;
}

function countGroupedFindings(findings: Finding[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const finding of findings) {
    if (!finding.groupedUnder) continue;
    counts.set(finding.groupedUnder, (counts.get(finding.groupedUnder) ?? 0) + 1);
  }
  return counts;
}

function readEnvFile(cwd = process.cwd()): Record<string, string> {
  const envPath = resolve(cwd, '.env');
  if (!existsSync(envPath)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    value = value.replace(/^['"]|['"]$/g, '');
    env[key] = value;
  }
  return env;
}

async function linearGraphql<T>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await response.json() as { data?: T; errors?: Array<{ message: string }> };
  if (!response.ok || json.errors?.length) {
    throw new Error(json.errors?.map((error) => error.message).join('; ') || `Linear HTTP ${response.status}`);
  }
  return json.data as T;
}

async function resolveLinearTeam(apiKey: string, requested?: string): Promise<string> {
  const data = await linearGraphql<{ teams: { nodes: Array<{ id: string; key: string; name: string }> } }>(
    apiKey,
    `query Teams { teams(first: 50) { nodes { id key name } } }`,
    {},
  );
  const teams = data.teams.nodes;
  const found = requested
    ? teams.find((team) => team.id === requested || team.key === requested || team.name === requested)
    : teams[0];
  if (!found) {
    throw new Error(`Linear team not found: ${requested ?? '(first team)'}`);
  }
  return found.id;
}

async function resolveLinearProject(apiKey: string, requested?: string): Promise<string | undefined> {
  if (!requested) return undefined;
  const data = await linearGraphql<{ projects: { nodes: Array<{ id: string; name: string }> } }>(
    apiKey,
    `query Projects { projects(first: 100) { nodes { id name } } }`,
    {},
  );
  const project = data.projects.nodes.find((node) => node.id === requested || node.name === requested);
  if (!project) {
    throw new Error(`Linear project not found: ${requested}`);
  }
  return project.id;
}

async function resolveLinearLabel(apiKey: string, requested?: string): Promise<string | undefined> {
  if (!requested) return undefined;
  const data = await linearGraphql<{ issueLabels: { nodes: Array<{ id: string; name: string }> } }>(
    apiKey,
    `query Labels { issueLabels(first: 100) { nodes { id name } } }`,
    {},
  );
  const label = data.issueLabels.nodes.find((node) => node.id === requested || node.name === requested);
  if (!label) {
    throw new Error(`Linear label not found: ${requested}`);
  }
  return label.id;
}

async function fileLinearIssues(snapshot: ObserverSnapshot, options: ObserverOptions): Promise<void> {
  if (options.dryRun || !options.fileLinear) return;
  const env = { ...readEnvFile(resolve(__dirname, '..')), ...readEnvFile(process.cwd()), ...process.env };
  const apiKey = env.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error('LINEAR_API_KEY not found in environment or .env');
  }
  const teamId = await resolveLinearTeam(apiKey, options.linearTeam);
  const projectId = await resolveLinearProject(apiKey, options.linearProject);
  const labelId = await resolveLinearLabel(apiKey, options.linearLabel);
  const actionable = snapshot.findings.filter((finding) =>
    finding.confidence === 'high' && (finding.severity === 'urgent' || finding.severity === 'high')
  );
  for (const finding of actionable) {
    const body = [
      `Severity: ${finding.severity}`,
      `Category: ${finding.category}`,
      `Confidence: ${finding.confidence}`,
      finding.session ? `Session: ${finding.session}` : undefined,
      finding.repoDir ? `Repo: ${finding.repoDir}` : undefined,
      finding.issue ? `Issue: ${finding.issue}` : undefined,
      '',
      'Evidence:',
      ...finding.evidence.map((item) => `- ${item}`),
      '',
      `Recommendation: ${finding.recommendation}`,
      '',
      `Detected at: ${snapshot.timestamp}`,
    ].filter((line): line is string => line !== undefined).join('\n');
    const data = await linearGraphql<{ issueCreate: { issue: { url: string } } }>(
      apiKey,
      `mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) { issue { url } }
      }`,
      {
        input: {
          teamId,
          title: `[observer] ${finding.title}`.slice(0, 250),
          description: body,
          ...(projectId ? { projectId } : {}),
          ...(labelId ? { labelIds: [labelId] } : {}),
        },
      },
    );
    finding.linearIssueUrl = data.issueCreate.issue.url;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function observerPrompt(): string {
  const wavemillDir = resolve(__dirname, '..');
  return `You are the Wavemill Observer.

Run \`wavemill observer --json --once\` every few minutes and use its findings as the authoritative structured snapshot.

Act conservatively:
- If a finding identifies a conclusively hung child process blocking the monitor, terminate only that child and verify recovery.
- If the root cause is a clear Wavemill code defect, fix it in ${wavemillDir}, add tests, commit, push, and open a PR targeting auto/integration.
- Otherwise create a Linear issue with the evidence from the observer output.
- Never kill a whole tmux session, reset worktrees, or modify active task work unless explicitly instructed.

Detection-only unless observer.autoFix is enabled; the observer's own fixes are logged in .wavemill/incidents/actions.jsonl.

Report after each loop: sessions inspected, active tasks, findings by severity, action taken, and next check time.
`;
}

async function main(): Promise<void> {
  let options: ObserverOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error: any) {
    process.stderr.write(`Error: ${error.message}\n\n${usage()}`);
    process.exit(1);
  }

  if (options.printPrompt) {
    process.stdout.write(observerPrompt());
    return;
  }

  const lock = options.loop
    ? acquireObserverLock({
        repoDir: options.repoDir ?? process.cwd(),
        session: options.session,
      })
    : undefined;

  if (lock?.outcome === 'skipped') {
    process.stderr.write(`observer: another loop already holds the lock${lock.holderPid ? ` (pid ${lock.holderPid})` : ''}; exiting\n`);
    return;
  }

  try {
    do {
      const reconciled = await reconcileIncidents(observe(options), options);
      const fixed = await applyAutoFixes(reconciled, options);
      const alerted = await sendAlerts(fixed, options);
      const observed = await syncIncidentsToLinear(alerted, options);
      const snapshot = options.serviceMode ? redactSnapshot(observed) : observed;
      await writeServiceHeartbeat(snapshot, options);
      await fileLinearIssues(snapshot, options);
      if (options.json) {
        process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
      } else if (options.compact) {
        process.stdout.write(renderObserverStatus(compactSnapshotForRender(snapshot), { width: process.stdout.columns ?? 100 }));
      } else {
        process.stdout.write(renderSummary(snapshot));
      }
      if (!options.loop) break;
      await sleep(options.intervalSeconds * 1000);
    } while (true);
  } finally {
    lock?.release();
  }
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`observer failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
