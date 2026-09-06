#!/usr/bin/env -S npx tsx

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mutateJsonState } from '../shared/lib/state-mutex.ts';
import { getIncidentConfig, getMillConfig, getObserverLinearConfig, type ObserverLinearConfig } from '../shared/lib/config.ts';
import { detectIncidentsForRepo, detectIncidentsForTask } from '../shared/lib/wavemill-incident-detector.ts';
import { IncidentStore } from '../shared/lib/wavemill-incident-store.ts';
import type { IncidentRecord } from '../shared/lib/wavemill-incident-model.ts';
import { syncIncident, type SyncResult } from '../shared/lib/incident-to-linear-synchronizer.ts';
import { drainIncidentQueue, enqueueIncidentSync } from '../shared/lib/incident-linear-retry-queue.ts';
import { acquireObserverLock } from '../shared/lib/tend-singleton.ts';
import { countRejectedEvalRecords, listRejectedEvalRecords } from '../shared/lib/eval-rejected-store.ts';
import { renderObserverStatus } from '../shared/lib/observer-status-renderer.ts';
import {
  detectGlobalConfigIntegrity,
  detectRepoConfigIntegrity,
  type ConfigIntegrityIssue,
} from '../shared/lib/config-integrity.ts';
import { normalizeTaskLifecycle, type TaskLifecycleState } from '../shared/lib/task-lifecycle.ts';

type Severity = 'urgent' | 'high' | 'medium' | 'low';
type Category = 'stuck' | 'crash' | 'warning' | 'ux' | 'operational';
type Confidence = 'high' | 'medium' | 'low';
const DEFAULT_OBSERVER_PANE_TITLE = 'Wavemill Observer';
const READY_RECHECK_LOOP_THRESHOLD = 3;
const READY_RECHECK_LOOP_URGENT_THRESHOLD = 6;
const MODEL_DOWNGRADE_THRESHOLD = 3;
// terminal-task-parked severity floors: age escalation never triggers below these,
// even with a very small --stale-minutes.
const TERMINAL_PARKED_HIGH_FLOOR_MINUTES = 60;
const TERMINAL_PARKED_URGENT_FLOOR_MINUTES = 24 * 60;
const RESIDUE_COMMIT_SUBJECT_LIMIT = 5;
const PR_CREATE_FAILED_PATTERN = /pull request create failed:?\s*(.*)/i;

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
  incidentsDryRun: boolean;
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
  /** Test seam: pre-captured pane text. When absent, tmux capture-pane is used. */
  capturedText?: string;
}

interface ProcessRow {
  pid: number;
  ppid: number;
  stat: string;
  elapsedSeconds: number;
  command: string;
}

interface TaskState {
  issue: string;
  slug?: string;
  phase?: string;
  status?: string;
  pr?: string;
  worktree?: string;
  branch?: string;
  baseBranch?: string;
  updated?: string;
  agent?: string;
  challengeRole?: string;
  challengePairId?: string;
  executionOwner?: string;
  paneState?: string;
  lifecycle?: TaskLifecycleState | Record<string, unknown>;
}

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

interface RepoSnapshot {
  session: string;
  repoDir: string;
  workflowStatePath?: string;
  millLogPath?: string;
  queueHealthPath?: string;
  queueHealth?: any;
  tasks: TaskState[];
  stateMtime?: string;
  logMtime?: string;
}

interface ObserverSnapshot {
  timestamp: string;
  sessions: string[];
  panes: Pane[];
  processes: ProcessRow[];
  repos: RepoSnapshot[];
  findings: Finding[];
  incidents?: IncidentRecord[];
  incidentSync?: IncidentSyncSnapshot;
}

interface IncidentSyncSnapshot {
  totalProcessed: number;
  created: number;
  updated: number;
  failed: number;
  skipped: number;
  queued: number;
  retryProcessed: number;
  retrySucceeded: number;
  retryFailed: number;
  results: SyncResult[];
  errors: Array<{ fingerprint: string; action: string; reason: string; nextRetry?: string }>;
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
  --incidents-dry-run    Preview incident Linear actions without writes
  --incidents-replay <fingerprint>
                         Re-sync one incident fingerprint and bypass update cooldown
  --incidents-policy <json>
                         Override observer.linear.policies for this run
  --linear-team <key>    Linear team key/name/id for filed issues
  --linear-project <id>  Optional Linear project id/name for filed issues
  --linear-label <name>  Optional Linear label name to attach
  --dry-run              Do not create Linear issues
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
  const result = run('tmux', ['list-sessions', '-F', '#{session_name}'], 5_000);
  if (!result.ok) {
    return [];
  }
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

function listPanes(): Pane[] {
  const format = [
    '#{session_name}',
    '#{window_index}',
    '#{pane_index}',
    '#{window_name}',
    '#{pane_active}',
    '#{pane_pid}',
    '#{pane_current_command}',
    '#{pane_title}',
  ].join('\t');
  const result = run('tmux', ['list-panes', '-a', '-F', format], 5_000);
  if (!result.ok) {
    return [];
  }
  return result.stdout.split('\n').filter(Boolean).map((line) => {
    const [session, windowIndex, paneIndex, windowName, active, pid, command, title] = line.split('\t');
    return {
      session,
      windowIndex,
      paneIndex,
      windowName,
      active: active === '1',
      pid: Number.parseInt(pid, 10) || 0,
      command: command || '',
      title: title || '',
    };
  });
}

function sessionEnv(session: string): Record<string, string> {
  const result = run('tmux', ['show-environment', '-t', session], 5_000);
  const env: Record<string, string> = {};
  if (!result.ok) {
    return env;
  }
  for (const line of result.stdout.split('\n')) {
    if (!line || line.startsWith('-')) continue;
    const index = line.indexOf('=');
    if (index === -1) continue;
    env[line.slice(0, index)] = line.slice(index + 1);
  }
  return env;
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

function readWorkflowTasks(stateFile: string): TaskState[] {
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
    const tasks = parsed?.tasks;
    if (!tasks || typeof tasks !== 'object') return [];
    return Object.entries(tasks).map(([issue, value]) => {
      const task = (value ?? {}) as Record<string, unknown>;
      return {
        issue,
        slug: stringValue(task.slug),
        phase: stringValue(task.phase),
        status: stringValue(task.status),
        pr: stringValue(task.pr),
        worktree: stringValue(task.worktree),
        branch: stringValue(task.branch),
        baseBranch: stringValue(task.baseBranch),
        updated: stringValue(task.updated),
        agent: stringValue(task.agent),
        challengeRole: stringValue(task.challengeRole),
        challengePairId: stringValue(task.challengePairId),
        executionOwner: stringValue(task.executionOwner),
        paneState: stringValue(task.paneState),
        lifecycle: task.lifecycle && typeof task.lifecycle === 'object' && !Array.isArray(task.lifecycle)
          ? task.lifecycle as TaskLifecycleState | Record<string, unknown>
          : undefined,
      };
    });
  } catch {
    return [];
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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
    repos.push({
      session,
      repoDir,
      workflowStatePath: existsSync(workflowStatePath) ? workflowStatePath : undefined,
      millLogPath,
      queueHealthPath: existsSync(queueHealthPath) ? queueHealthPath : undefined,
      queueHealth,
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
    repos.push({
      session,
      repoDir,
      workflowStatePath: existsSync(workflowStatePath) ? workflowStatePath : undefined,
      millLogPath,
      queueHealthPath: existsSync(queueHealthPath) ? queueHealthPath : undefined,
      queueHealth,
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
  idPrefix: 'coding-marker-ignored' | 'plan-marker-ignored';
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
  task: TaskState,
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
    ],
    recommendation: stateNewerThanMarker ? config.stateAliveRecommendation : config.staleRecommendation,
  };
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
    for (const issue of detectRepoConfigIntegrity(repo.repoDir)) {
      findings.push(configIntegrityFinding(issue, repo.session, repo.repoDir));
    }

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

      const ageMinutes = task.updated ? (now - Date.parse(task.updated)) / 60000 : stateAgeMinutes;
      const watchedPhase = task.phase === 'planning' || task.phase === 'coding' || task.phase === 'review' || task.phase === 'ready';
      if (watchedPhase && ageMinutes !== undefined && Number.isFinite(ageMinutes) && ageMinutes > options.staleMinutes) {
        const expectedWindow = task.slug ? `${task.issue}-${task.slug}` : task.issue;
        const liveEvidence = taskHasLiveExecutionEvidence(repo, task, snapshot.panes, snapshot.processes);
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
              `worktree=${task.worktree}`,
            ],
            recommendation: 'Treat this as orphaned active state: terminalize or remove the workflow-state entry after confirming no cleanup resources remain.',
          });
        } else if (!liveEvidence) {
          findings.push({
            id: `stale-active-task-no-live-process-${repo.session}-${task.issue}`,
            severity: 'high',
            category: 'stuck',
            confidence: 'high',
            session: repo.session,
            repoDir: repo.repoDir,
            issue: task.issue,
            title: `${task.issue} is stale in ${task.phase} with no live pane or process evidence`,
            evidence: [
              `status=${task.status ?? 'unknown'}`,
              `phase=${task.phase ?? 'unknown'}`,
              `updated=${task.updated ?? repo.stateMtime ?? 'unknown'}`,
              `ageMinutes=${Math.round(ageMinutes)}`,
              `expectedWindow=${expectedWindow}`,
              `worktree=${task.worktree ?? 'unknown'}`,
            ],
            recommendation: 'Inspect the task state and quarantine/cleanup path; if the process is gone, terminalize and clean the task instead of leaving it active.',
          });
        } else {
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
            ],
            recommendation: 'Inspect the task pane and hook state. If the agent is parked at a prompt or waiting after reporting completion, send a narrow recovery instruction; stop a child process only when it is conclusively wedged.',
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
        }),
        buildMarkerIgnoredFinding(repo, task, featureDir, now, options, {
          phase: 'planning',
          markerName: '.plan-approved',
          idPrefix: 'plan-marker-ignored',
          titlePhase: 'planning',
          staleRecommendation: 'The monitor should launch coding. Check for a hung monitor child process or blocking external command before restarting the session.',
          stateAliveRecommendation: 'The monitor should launch coding. It is still writing workflow state but has not advanced this task — inspect its poll branch and this task\'s hook file before restarting anything.',
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
    const repoBaseBranch = observerBaseBranch(repo.repoDir);
    for (const task of repo.tasks) {
      const ageMinutes = taskAgeMinutes(task, repo, now);
      // The stale age gate doubles as protection against phase-handoff false
      // positives: a healthy handoff briefly has no live agent but keeps
      // task.updated fresh.
      if (ageMinutes === undefined || !Number.isFinite(ageMinutes) || ageMinutes <= options.staleMinutes) continue;

      const normalized = normalizedLifecycle(task);
      const isTerminal = taskHasTerminalResidueStatus(task);
      const liveEvidence = taskHasLiveExecutionEvidence(repo, task, snapshot.panes, snapshot.processes);
      // Active tasks with a live agent are healthy; terminal tasks are inspected
      // even when their window still holds a live (abandoned) agent session.
      if (!isTerminal && liveEvidence) continue;

      const branch = taskBranch(task);
      const baseBranch = task.baseBranch || repoBaseBranch;
      const paneResidue = taskPaneResidue(repo, task, snapshot.panes);
      const residue = branch ? inspectTaskBranchResidue(repo.repoDir, branch, baseBranch) : undefined;
      const worktreePresent = task.worktree ? existsSync(task.worktree) : false;
      const unpushedCommits = residue?.unpushedCommits;
      const confirmedWorkAtRisk = (unpushedCommits ?? 0) > 0 && residue?.remoteBranch === 'absent';

      const firesUnpushed = !liveEvidence && residue !== undefined && confirmedWorkAtRisk;
      const terminalResiduePresent = worktreePresent || paneResidue.present || (residue?.localBranchExists ?? false);
      const firesTerminalParked = isTerminal && terminalResiduePresent;
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

      if (firesTerminalParked) {
        const ageLabel = formatParkedAge(ageMinutes);
        const workLoss = (unpushedCommits ?? 0) > 0;
        const reapAction = `set ${task.issue} phase=aborted (or run \`wavemill mill abort ${task.issue}\`) and let the mill reap the worktree and window - never remove the worktree manually while the mill loop is live`;
        findings.push({
          id: `terminal-task-parked-${repo.session}-${task.issue}`,
          severity: terminalParkedSeverity(ageMinutes, options.staleMinutes, residue),
          category: 'operational',
          confidence: 'high',
          session: repo.session,
          repoDir: repo.repoDir,
          issue: task.issue,
          title: workLoss
            ? `${task.issue} terminal task parked for ${ageLabel} with ${unpushedCommits} unpushed commit${unpushedCommits === 1 ? '' : 's'} at risk`
            : `${task.issue} terminal task parked for ${ageLabel} with allocated residue`,
          evidence: [
            ...stateEvidence,
            `updated=${task.updated ?? repo.stateMtime ?? 'unknown'}`,
            `ageMinutes=${Math.round(ageMinutes)}`,
            paneResidue.present
              ? `tmuxWindow=present(${paneResidue.live ? 'live' : 'exited'}) targets=${paneResidue.targets.join(',')}`
              : 'tmuxWindow=absent',
            task.worktree ? `worktree=${worktreePresent ? 'present' : 'absent'}:${task.worktree}` : 'worktree=none',
            branch ? `branch=${branch} localBranch=${residue?.localBranchExists ? 'present' : 'absent'}` : 'branch=unknown',
            `baseBranch=${baseBranch}`,
            `aheadOfBase=${residue?.aheadOfBase ?? 'unknown'}`,
            `remoteBranch=${residue?.remoteBranch ?? 'unknown'}`,
            `unpushedCommits=${unpushedCommits ?? 'unknown'}`,
            ...(workLoss ? ['potentialWorkLoss=true'] : []),
            ...(residue?.commitSubjects.map((subject) => `commit=${subject}`) ?? []),
            prEvidence,
          ],
          recommendation: workLoss
            ? `Recover the work first: push ${branch} to origin and open or update a PR against ${baseBranch}, or explicitly abandon the branch. Then ${reapAction}.`
            : `Nothing on the branch is at risk; ${reapAction}.`,
        });
      }
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
        repoBaseBranch,
      ));
    }
    for (const task of repo.tasks) {
      if (prCreateReportedIssues.has(task.issue)) continue;
      const artifactText = readTaskReviewArtifactText(task);
      const artifactMatch = artifactText?.match(PR_CREATE_FAILED_PATTERN);
      if (artifactMatch) {
        prCreateReportedIssues.add(task.issue);
        findings.push(prCreateFailedFinding(repo, task.issue, artifactMatch[0], 'review-artifact', 'high', 1, repoBaseBranch));
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
          repoBaseBranch,
        ));
        break;
      }
    }

    const genericLogFindings = new Map<string, AggregatedMillLogFinding>();
    for (const line of logLines) {
      const parsed = parseMillLogLine(line);
      if (!parsed) continue;
      if (prCreateFailedLines.has(line)) continue;
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

    // Analyze queue-health degradation
    if (queueHealthDegraded) {
      const reason = repo.queueHealth.degradationReason || 'unknown';
      const episodeStartedAt = repo.queueHealth.episodeStartedAt || 'unknown';
      const failureCount = repo.queueHealth.failureCount || 1;
      const severity = failureCount >= 5 ? 'high' : failureCount >= 3 ? 'medium' : 'low';

      findings.push({
        id: `queue-health-degraded-${repo.session}-${hashText(episodeStartedAt)}`,
        severity,
        category: 'warning',
        confidence: 'high',
        session: repo.session,
        repoDir: repo.repoDir,
        title: `Queue planning degraded: ${reason}`,
        evidence: [
          `episodeStartedAt=${episodeStartedAt}`,
          `reason=${reason}`,
          `failureCount=${failureCount}`,
          `backoffSeconds=${repo.queueHealth.retryBackoffSeconds || 0}`,
          `lastAttemptAt=${repo.queueHealth.lastAttemptAt || 'unknown'}`,
          ...(repo.queueHealth.planner ? [
            `plannerPid=${repo.queueHealth.planner.pid || 'unknown'}`,
            `plannerOwner=${repo.queueHealth.planner.cancellationOwner || 'unknown'}`,
          ] : []),
          ...(repo.queueHealth.diagnostics?.stderrExcerpt ? [
            `stderr=${repo.queueHealth.diagnostics.stderrExcerpt}`,
          ] : []),
        ],
        recommendation: `Dependency-aware queue planning is unavailable. Flat fallback is active. Inspect the queue planner lifecycle and dependency graph. If this persists, file a diagnostic ticket with the queue-health snapshot.`,
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

function parseReadyRecheckLine(line: string): ReadyRecheckLogEntry | null {
  const match = line.match(/(\S+)\s+\u2192\s+Re-running failed ready checks for PR #(\d+)/)
    ?? line.match(/\b([A-Z][A-Z0-9]*-\d+(?:_[A-Za-z0-9]+)?):\s+refusing ready phase for PR #(\d+)/i);
  if (!match) return null;
  return {
    line,
    issue: match[1],
    pr: match[2],
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
    || status === 'aborted';
}

function normalizedLifecycle(task: TaskState) {
  return normalizeTaskLifecycle(task);
}

function taskWorkflowIsTerminal(task: TaskState): boolean {
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
function taskPaneResidue(repo: RepoSnapshot, task: TaskState, panes: Pane[]): PaneResidue {
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

function taskHasLiveExecutionEvidence(repo: RepoSnapshot, task: TaskState, panes: Pane[], processes: ProcessRow[]): boolean {
  if (taskPaneResidue(repo, task, panes).live) {
    return true;
  }

  return processes.some((row) => {
    const command = row.command;
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
function taskHasTerminalResidueStatus(task: TaskState): boolean {
  return taskWorkflowIsTerminal(task) || terminalStatus(task.status) || task.status === 'error' || task.phase === 'error';
}

function taskBranch(task: TaskState): string | undefined {
  if (task.branch) return task.branch;
  return task.slug ? `task/${task.slug}` : undefined;
}

function taskAgeMinutes(task: TaskState, repo: RepoSnapshot, now: number): number | undefined {
  const updatedMs = task.updated ? Date.parse(task.updated) : NaN;
  if (Number.isFinite(updatedMs)) return (now - updatedMs) / 60000;
  const stateMs = repo.stateMtime ? Date.parse(repo.stateMtime) : NaN;
  if (Number.isFinite(stateMs)) return (now - stateMs) / 60000;
  return undefined;
}

function observerBaseBranch(repoDir: string): string {
  try {
    return getMillConfig(repoDir).baseBranch || 'auto/integration';
  } catch {
    return 'auto/integration';
  }
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

/** Best-effort PR state evidence; a failed gh call reports unknown, never throws. */
function taskPrEvidence(repoDir: string, task: TaskState): string {
  if (!task.pr) return 'pr=none';
  const result = run('gh', ['pr', 'view', task.pr, '--json', 'state,url,baseRefName'], 8_000, repoDir);
  if (!result.ok) return `pr=#${task.pr} state=unknown`;
  try {
    const parsed = JSON.parse(result.stdout) as { state?: unknown; baseRefName?: unknown };
    const state = typeof parsed.state === 'string' && parsed.state ? parsed.state : 'unknown';
    const base = typeof parsed.baseRefName === 'string' && parsed.baseRefName ? ` base=${parsed.baseRefName}` : '';
    return `pr=#${task.pr} state=${state}${base}`;
  } catch {
    return `pr=#${task.pr} state=unknown`;
  }
}

function terminalParkedSeverity(ageMinutes: number, staleMinutes: number, residue: BranchResidue | undefined): Severity {
  let severity: Severity = 'medium';
  if (ageMinutes > Math.max(TERMINAL_PARKED_HIGH_FLOOR_MINUTES, staleMinutes * 6)) severity = 'high';
  if (ageMinutes > Math.max(TERMINAL_PARKED_URGENT_FLOOR_MINUTES, staleMinutes * 24)) severity = 'urgent';
  if ((residue?.unpushedCommits ?? 0) > 0) {
    // Unpushed work turns housekeeping into potential work loss: at least high,
    // urgent when the remote branch is confirmed absent (nothing else holds the commits).
    if (residue?.remoteBranch === 'absent') return 'urgent';
    if (severity === 'medium') return 'high';
  }
  return severity;
}

function formatParkedAge(ageMinutes: number): string {
  const rounded = Math.round(ageMinutes);
  if (rounded < 120) return `${rounded}m`;
  const hours = Math.floor(rounded / 60);
  const minutes = rounded % 60;
  return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
}

/** Match a raw diagnostic line to a task by branch, slug, or issue key. */
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
  const target = `${pane.session}:${pane.windowIndex}.${pane.paneIndex}`;
  const result = run('tmux', ['capture-pane', '-p', '-S', '-200', '-t', target], 5_000);
  return result.ok ? result.stdout : undefined;
}

function readTaskReviewArtifactText(task: TaskState): string | undefined {
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
            severity: jsonFinding.severity || 'warning',
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
  const partial = {
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

async function reconcileIncidents(snapshot: ObserverSnapshot, options: ObserverOptions): Promise<ObserverSnapshot> {
  const incidents: IncidentRecord[] = [];
  if (!options.incidentDetector) {
    return { ...snapshot, incidents };
  }

  for (const repo of snapshot.repos) {
    let incidentConfig: ReturnType<typeof getIncidentConfig>;
    try {
      incidentConfig = getIncidentConfig(repo.repoDir);
    } catch (error) {
      addConfigDegradedFindingIfMissing(snapshot.findings, repo, error, 'incident reconciliation');
      continue;
    }
    if (incidentConfig.enabled === false) continue;
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
    try {
      for (const task of repo.tasks) {
        if (!task.issue || taskWorkflowIsTerminal(task)) continue;
        const taskPath = resolveTaskArtifactDir(repo.repoDir, task);
        if (!taskPath) continue;
        const detected = detectIncidentsForTask(
          taskPath,
          task.issue,
          { repoDir: repo.repoDir, session: repo.session, now: new Date(snapshot.timestamp) },
          options.dependencyThreshold ?? incidentConfig.detection?.dependencyThreshold ?? 3,
        );
        candidates.push(...detected);
      }

      candidates.push(...detectIncidentsForRepo(
        repo.repoDir,
        { repoDir: repo.repoDir, session: repo.session, now: new Date(snapshot.timestamp) },
        options.dependencyThreshold ?? incidentConfig.detection?.dependencyThreshold ?? 3,
      ));
    } catch (error) {
      cycleComplete = false;
      addConfigDegradedFindingIfMissing(snapshot.findings, repo, error, 'incident detection');
    }

    const freshFingerprints: string[] = [];
    for (const incident of dedupeIncidentCandidates(candidates, store)) {
      try {
        const { record: stored, freshEvent } = await store.upsertDetailed(incident);
        if (freshEvent) freshFingerprints.push(stored.fingerprint);
        incidents.push(stored);
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
      try {
        await store.runResolutionSweep(freshFingerprints);
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

  const uniqueIncidents = dedupeIncidents(incidents);
  return {
    ...snapshot,
    findings: dedupeFindings([...snapshot.findings, ...uniqueIncidents.map(convertIncidentToFinding)]),
    incidents: uniqueIncidents,
  };
}

function resolveTaskArtifactDir(repoDir: string, task: TaskState): string | null {
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
  return {
    ...config,
    enabled: config.enabled,
    detectionOnly: config.detectionOnly || options.incidentsDryRun,
    project: options.linearProject ?? config.project,
    team: options.linearTeam ?? config.team,
    label: options.linearLabel ?? config.label,
    policies,
  };
}

function emptyIncidentSyncSnapshot(): IncidentSyncSnapshot {
  return {
    totalProcessed: 0,
    created: 0,
    updated: 0,
    failed: 0,
    skipped: 0,
    queued: 0,
    retryProcessed: 0,
    retrySucceeded: 0,
    retryFailed: 0,
    results: [],
    errors: [],
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
    try {
      if (!config.detectionOnly) {
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

    const incidents = options.incidentsReplay
      ? [await store.getIncident(options.incidentsReplay)].filter((incident): incident is IncidentRecord => incident !== null)
      : await store.getIncidents();
    const incidentsForPass = config.detectionOnly || options.incidentsReplay
      ? incidents
      : incidents.slice(0, config.maxIncidentsPerPass);
    if (!config.detectionOnly && !options.incidentsReplay && incidentsForPass.length < incidents.length) {
      summary.skipped += incidents.length - incidentsForPass.length;
    }
    for (const incident of incidentsForPass) {
      const result = await syncIncident({
        incident,
        store,
        config,
        dryRun: options.incidentsDryRun,
        replay: options.incidentsReplay === incident.fingerprint,
        now: new Date(snapshot.timestamp),
        retryQueue: {
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
      });
      collectSyncResult(summary, result);
    }
  }
  return { ...snapshot, incidentSync: summary };
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
      lines.push(`  [${incident.lifecycle}/${incident.category}] ${incident.rootCauseClass}: ${incident.summary}`);
      lines.push(`  action: ${incident.operatorAction}`);
    }
  }
  if (snapshot.incidentSync) {
    const sync = snapshot.incidentSync;
    lines.push('');
    lines.push(`Incident Linear sync: processed=${sync.totalProcessed} created=${sync.created} updated=${sync.updated} queued=${sync.queued} skipped=${sync.skipped} failed=${sync.failed}`);
    if (sync.retryProcessed > 0) {
      lines.push(`Incident retry queue: processed=${sync.retryProcessed} succeeded=${sync.retrySucceeded} failed=${sync.retryFailed}`);
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
      const observed = await syncIncidentsToLinear(await reconcileIncidents(observe(options), options), options);
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
