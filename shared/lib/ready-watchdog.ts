import { appendFile, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { loadTraceContext, appendTraceEvent } from './trace-event.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  getReadyFailureClassifierConfig,
  getReadyRemediationConfig,
  getReadyVerificationConfig,
  getReadyWatchdogConfig,
  getChallengeEvalHardFailureRetryMaxAttempts,
  type ReadyWatchdogConfig,
} from './config.ts';
import { classifyCiFailure, type CiFailureCategory } from './ci-failure-classifier.ts';
import { enrichFailingChecks as enrichFailingChecksDefault } from './ci-log-fetcher.ts';
import { classifyFailure } from './failure-policy.ts';
import { errorMessage } from './error-utils.ts';
import { appendObserverFinding } from './observer-findings.ts';
import { resolveSessionCapabilities } from './config.ts';
import {
  classifyCheckReadError,
  normalizeStatusCheckRollup,
  type NormalizedCheckSummary,
} from './pr-ci-status.ts';
import { normalizeJobs, type MillJob, type WorkflowStateLike } from './job-tracker.ts';
import { updateBranchWithBase, type BranchBaseUpdateResult } from './promotion-controller.ts';
import { escapeShellArg } from './shell-utils.ts';
import { mutateJsonState } from './state-mutex.ts';
import { readStageResult, updateStageResult, type ReadyArtifacts, type StageResult } from './stage-result.ts';
import {
  writeMarker,
  clearMarker,
  readMarker,
  validateMarker,
  buildStaleMarkerFinding,
  type MarkerHandle,
} from './transient-marker.ts';
import { readChallengeComparisons, type StoredChallengeComparison } from './challenge-comparison.ts';
import {
  classifyChallengeState,
  evaluateSiblingLiveness,
  getSiblingBranch,
  listRemoteTaskBranches,
  loadWorkflowStateChallengeData,
  probeSiblingProgress,
  type ChallengeGate,
  type TaskEvalState,
  type UnresolvableReason,
} from './tend-challenge-gate.ts';
import {
  getTaskProgress as defaultGetTaskProgress,
  type TaskProgress,
} from './task-progress.ts';

const execFileAsync = promisify(execFile);
const MAX_AUTO_UPDATE_ATTEMPTS = 3;
const FAILING_CHECK_STABILITY_THRESHOLD = 2;
const WAVEMILL_TOOLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools');
const READY_WATCHDOG_TOOL_PATH = path.join(WAVEMILL_TOOLS_DIR, 'ready-watchdog.ts');
const CHALLENGE_PAIR_RESOLVER_TOOL_PATH = path.join(WAVEMILL_TOOLS_DIR, 'resolve-orphan-challenge-pair.ts');
const READY_WATCHDOG_UNCONFIRMED_ENTRY_TTL_MS = 48 * 60 * 60 * 1000;
let readyWatchdogUnconfirmedEntryTtlMsForTest: number | null = null;

export type ReadyWatchdogClassificationKind =
  | 'fresh'
  | 'auto-update'
  | 'disconnected-remediation'
  | 'stuck'
  | 'waiting-on-ci'
  | 'stable-failing-safe'
  | 'waiting-on-eval-comparison'
  | 'waiting-on-merge-lane'
  | 'needs-user';

export function setReadyWatchdogUnconfirmedEntryTtlMsForTest(ttlMs: number | null): void {
  readyWatchdogUnconfirmedEntryTtlMsForTest = ttlMs;
}

/**
 * A PR in the merge lane (queueState 'ready-stale', 'merge-candidate', or
 * 'ready' with a completed result) is idle on purpose: it already passed ready
 * and is waiting its turn to merge. We only escalate such a PR to needs-user
 * once it has been idle for this multiple of the idle threshold without the
 * lane advancing, which indicates the queue itself is stalled rather than this
 * PR simply waiting.
 */
const MERGE_LANE_STALL_ESCALATE_MULTIPLIER = 3;

export interface ReadyTaskSnapshot {
  issueId: string;
  slug: string;
  branch: string;
  worktree: string;
  prNumber: number;
  controllerPhase: string;
  controllerUpdatedAt: string | null;
  currentAgent: string;
  currentModel: string;
  challengePairId: string | null;
  readyStateDir: string;
  readyResult: StageResult | null;
  readyArtifacts: ReadyArtifacts | null;
  readyResultStatus: string | null;
  readyVerdict: ReadyArtifacts['verdict'] | null;
  readyAttentionDetail: string | null;
  hasNeedsAttention: boolean;
  hasConflictMarker: boolean;
  remediationLaunchHead: string | null;
  currentHead: string | null;
  remediationPaneActive: boolean | null;
  worktreeMergeState: WorktreeMergeState;
  relevantJobs: MillJob[];
  lastProgressAt: string | null;
  idleMinutes: number | null;
  backstageHealth: BackstageHealthState | null;
}

export interface BackstageHealthState {
  updatedAt: string | null;
  status: string;
  detail: string | null;
  restartAttemptCount: number | null;
  lastRestartAttemptAt: string | null;
  executorPaneId: string | null;
}

export interface WorktreeMergeState {
  mergeHead: string | null;
  unmergedPaths: string[];
  stagedPaths: string[];
  unstagedPaths: string[];
  untrackedPaths: string[];
  rawStatus: string[];
  inspectError?: string;
}

export { normalizeStatusCheckRollup, type NormalizedCheckSummary } from './pr-ci-status.ts';

export interface GitHubPRTruth {
  state: string;
  mergeable: string;
  mergeStateStatus: string;
  url?: string;
  headRefName?: string;
  baseRefName?: string;
  checks: NormalizedCheckSummary[];
  checkReadError?: {
    reason: string;
    errorType: 'command-failed' | 'timeout' | 'malformed-json' | 'network' | 'unknown';
  };
}

export interface ReadyWatchdogClassification {
  kind: ReadyWatchdogClassificationKind;
  detail: string;
  recoveryCommand?: string;
  autoRecoverable?: boolean;
  remediationCategories?: string[];
  consecutiveFailurePolls?: number;
  autoRemediable?: boolean;
  ciFailureCategory?: CiFailureCategory;
  failingJob?: string;
  localCommand?: string;
  logExcerpt?: string;
}

interface ReadyTaskClassificationConfig extends ReadyWatchdogConfig {
  localCommandMap?: Record<string, string>;
  remediationLogMaxBytes?: number;
  /**
   * HOK-3102: whether the tend merge lane is active in this session. When
   * false, the BEHIND → `auto-update` classification is skipped; the
   * operator merges (which brings its own base). Defaults to true to
   * preserve pre-HOK-3102 semantics on legacy callers.
   */
  mergeLaneActive?: boolean;
}

export interface ReadyWatchdogAuditRecord {
  timestamp: string;
  taskId: string;
  slug: string;
  prNumber: number;
  classification: Exclude<ReadyWatchdogClassificationKind, 'fresh'>;
  action: string;
  detail: string;
  recoveryCommand?: string;
  error?: string;
}

export interface ReadyWatchdogStateEntry {
  issueId: string;
  slug: string;
  prNumber: number;
  classification: Exclude<ReadyWatchdogClassificationKind, 'fresh'>;
  displayLabel: string;
  detail: string;
  action: string;
  recoveryCommand?: string;
  updatedAt: string;
  idleMinutes: number | null;
  lastProgressAt: string | null;
  currentHeadSha?: string | null;
  prStateKey?: string;
  detailFingerprint?: string;
  classificationSince?: string;
  lastConfirmedAt?: string;
  autoUpdateAttempts?: number;
  lastAutoUpdateError?: string;
  lastReportedAction?: string;
  remediationCategories?: string[];
  consecutiveFailurePolls?: number;
  failingChecksFingerprint?: string;
  failingChecksObservedCount?: number;
  lastLoggedAt?: string;
  lastLoggedFingerprint?: string;
  lastLoggedClassification?: Exclude<ReadyWatchdogClassificationKind, 'fresh'>;
  lastLoggedAction?: string;
  transientFailureCount?: number;
  transientFailureHead?: string;
  lastCiFailureCategory?: CiFailureCategory;
  lastFailingJob?: string;
  lastLocalCommand?: string;
  terminal?: boolean;
  terminalReason?: string;
  terminalAttempts?: number;
  terminalHeadSha?: string | null;
  lastTerminalAt?: string;
}

export interface ReadyWatchdogStateFile {
  updatedAt: string;
  tasks: Record<string, ReadyWatchdogStateEntry>;
}

export type ReadyWatchdogReapReason =
  | 'resolved'
  | 'absent-from-workflow'
  | 'non-ready'
  | 'terminal'
  | 'invalid-task'
  | 'unconfirmed-expired';

export interface ReadyWatchdogReapedEntry {
  issueId: string;
  classification: Exclude<ReadyWatchdogClassificationKind, 'fresh'>;
  reason: ReadyWatchdogReapReason;
  classificationSince?: string;
  lastConfirmedAt?: string;
  updatedAt?: string;
}

export interface TickReadyWatchdogResult {
  updatedAt: string;
  findings: ReadyWatchdogStateEntry[];
  reaped: ReadyWatchdogReapedEntry[];
}

export interface ReadyWatchdogDeps {
  readWorkflowState: (stateFile: string) => Promise<WorkflowStateLike>;
  fetchGitHubTruth: (prNumber: number, repoDir: string) => Promise<GitHubPRTruth>;
  enrichFailingChecks: (
    checks: NormalizedCheckSummary[],
    options: { repoDir: string; maxBytes: number },
  ) => Promise<NormalizedCheckSummary[]>;
  getCurrentHead: (worktree: string) => Promise<string | null>;
  getWorktreeMergeState: (worktree: string) => Promise<WorktreeMergeState>;
  isTaskPaneActive: (task: WorkflowTaskRecord) => Promise<boolean | null>;
  /**
   * HOK-3101: the shared task-progress primitive. computeLastProgressAt
   * delegates through this so hook, commit and worktree evidence contribute
   * to `lastProgressAt` — not only `task.updated` (which is transition-only,
   * HOK-3087). isTaskPaneActive also consults `agentIdle` so an idle REPL
   * (HOK-3095 (a)) does not count as active.
   */
  getTaskProgress: (task: WorkflowTaskRecord, options: {
    session: string;
    repoDir: string;
    worktree: string;
    stateDir: string;
    readyResult: StageResult | null;
    readyResultFile: string;
    now: Date;
  }) => TaskProgress | null;
  /**
   * HOK-3128: progress probe for a PR's tracked no-PR challenge sibling, so the
   * watchdog and the tend gate share the `sibling-stalled` rule.
   */
  getSiblingProgress: (repoDir: string, sibling: TaskEvalState, now: Date, session: string) => TaskProgress | null;
  resumeResolvedConflictRemediation: (
    snapshot: ReadyTaskSnapshot,
    githubTruth: GitHubPRTruth,
    repoDir: string,
  ) => Promise<ResolvedConflictResumeResult>;
  updateBehindBranch: (
    snapshot: ReadyTaskSnapshot,
    githubTruth: GitHubPRTruth,
    repoDir: string,
  ) => Promise<BranchBaseUpdateResult>;
  launchReadyRemediation: (
    snapshot: ReadyTaskSnapshot,
    failedCheckSummary: string,
    failedCheckNames: string[],
    attemptNumber: number,
    maxAttempts: number,
    repoDir: string,
    readyWatchdogToolPath: string,
  ) => Promise<ReadyRemediationLaunchResult>;
  now: () => Date;
}

export interface ResolvedConflictResumeResult {
  status: 'completed' | 'failed';
  detail: string;
}

export interface ReadyRemediationLaunchResult {
  status: 'launched' | 'skipped-in-flight' | 'skipped-backoff' | 'skipped-max-attempts' | 'failed';
  detail: string;
  attemptNumber: number;
  launchHead?: string;
}

export interface TickReadyWatchdogOptions {
  repoDir: string;
  stateFile: string;
  config?: ReadyWatchdogConfig;
  issueFilter?: string;
  forceRecover?: boolean;
  readyWatchdogToolPath?: string;
  deps?: Partial<ReadyWatchdogDeps>;
  /**
   * HOK-3101: wavemill session id, used to look up per-task hook and status
   * files when the primitive gathers evidence. Defaults to
   * `$WAVEMILL_SESSION` or `wavemill`.
   */
  session?: string;
}

export interface WorkflowTaskRecord extends Record<string, unknown> {
  slug?: string;
  branch?: string;
  worktree?: string;
  pr?: string | number;
  phase?: string;
  status?: string;
  updated?: string;
  agent?: string;
  model?: string;
  challengePairId?: string;
  windowId?: string;
}

const defaultDeps: ReadyWatchdogDeps = {
  async readWorkflowState(stateFile) {
    return JSON.parse(await readFile(stateFile, 'utf-8')) as WorkflowStateLike;
  },
  async fetchGitHubTruth(prNumber, repoDir) {
    let stdout = '';
    try {
      const result = await execFileAsync(
        'gh',
        [
          'pr',
          'view',
          String(prNumber),
          '--json',
          'state,mergeable,mergeStateStatus,statusCheckRollup,url,headRefName,baseRefName',
        ],
        {
          cwd: repoDir,
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024,
        },
      );
      stdout = result.stdout;
    } catch (error) {
      return {
        state: '',
        mergeable: 'UNKNOWN',
        mergeStateStatus: 'UNKNOWN',
        checks: [],
        checkReadError: classifyCheckReadError(error),
      };
    }

    try {
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      return {
        state: String(parsed.state ?? ''),
        mergeable: String(parsed.mergeable ?? ''),
        mergeStateStatus: String(parsed.mergeStateStatus ?? ''),
        url: typeof parsed.url === 'string' ? parsed.url : undefined,
        headRefName: typeof parsed.headRefName === 'string' ? parsed.headRefName : undefined,
        baseRefName: typeof parsed.baseRefName === 'string' ? parsed.baseRefName : undefined,
        checks: normalizeStatusCheckRollup(parsed.statusCheckRollup),
      };
    } catch (error) {
      return {
        state: '',
        mergeable: 'UNKNOWN',
        mergeStateStatus: 'UNKNOWN',
        checks: [],
        checkReadError: {
          errorType: 'malformed-json',
          reason: `gh pr view returned malformed JSON: ${errorMessage(error)}`,
        },
      };
    }
  },
  async enrichFailingChecks(checks, options) {
    return enrichFailingChecksDefault(checks, options);
  },
  async getCurrentHead(worktree) {
    try {
      const { stdout } = await execFileAsync('git', ['-C', worktree, 'rev-parse', 'HEAD'], {
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
      });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  },
  async getWorktreeMergeState(worktree) {
    return inspectWorktreeMergeState(worktree);
  },
  async isTaskPaneActive(task) {
    const target = typeof task.windowId === 'string' && task.windowId.trim()
      ? task.windowId.trim()
      : null;
    if (!target) {
      return null;
    }

    try {
      const { stdout } = await execFileAsync(
        'tmux',
        ['display-message', '-p', '-t', target, '#{pane_dead}|#{pane_current_command}|#{pane_pid}'],
        {
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024,
        },
      );
      const [paneDead, command, panePid] = stdout.trim().split('|');
      if (paneDead === '1') {
        return false;
      }
      // HOK-3101 / HOK-3095 (a): an idle agent REPL sitting in a live pane
      // is NOT active — it is the agent's own settled Stop state. Consult
      // the shared primitive before reporting active.
      const issue = typeof task.slug === 'string' ? String(task.slug) : undefined;
      // We cannot reach the primitive from here because we do not have the
      // repo dir / session; the composed classifyReadyTask() path threads it
      // through and overrides `remediationPaneActive` when agentIdle=true
      // (see snapshotReadyTask). This default kept its previous semantics
      // to preserve behaviour for callers that do not supply a session.
      if (command && !['bash', 'zsh', 'fish', 'sh'].includes(command)) {
        return true;
      }
      if (panePid && /^\d+$/.test(panePid)) {
        try {
          const { stdout: childStdout } = await execFileAsync('pgrep', ['-P', panePid], {
            encoding: 'utf-8',
            maxBuffer: 1024 * 1024,
          });
          return childStdout.trim().length > 0;
        } catch {
          return false;
        }
      }
      void issue;
      return false;
    } catch {
      return null;
    }
  },
  getTaskProgress(task, { session, worktree, readyResult, readyResultFile, now }) {
    // HOK-3101: default IO-based composition. Tests stub the whole dep.
    if (!worktree || !task.slug) return null;
    try {
      const issue = typeof (task as { issueId?: string }).issueId === 'string'
        ? (task as { issueId?: string }).issueId!
        : String(task.slug ?? '');
      if (!issue) return null;
      const extra: TaskProgress['sources'] = [];
      if (readyResult?.startedAt) extra.push({ kind: 'transition', at: readyResult.startedAt, detail: 'ready.startedAt' });
      if (readyResult?.finishedAt) extra.push({ kind: 'transition', at: readyResult.finishedAt, detail: 'ready.finishedAt' });
      const readyMtime = fileMtimeIso(readyResultFile);
      if (readyMtime) extra.push({ kind: 'transition', at: readyMtime, detail: 'ready-result.mtime' });
      return defaultGetTaskProgress({
        issue,
        session,
        task: task as never,
        worktree,
        phase: typeof task.phase === 'string' ? task.phase : 'ready',
        extraTransitionSources: extra,
        now,
      });
    } catch {
      return null;
    }
  },
  getSiblingProgress(repoDir, sibling, now, session) {
    return probeSiblingProgress(repoDir, sibling, now, (opts) => defaultGetTaskProgress({ ...opts, session }));
  },
  async resumeResolvedConflictRemediation(snapshot, githubTruth) {
    const baseBranch = githubTruth.baseRefName || 'base branch';
    try {
      await execFileAsync('git', ['-C', snapshot.worktree, 'commit', '-m', `fix: Resolve merge conflicts with ${baseBranch}`], {
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
      });
      await execFileAsync('git', ['-C', snapshot.worktree, 'push', 'origin', snapshot.branch], {
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
      });
      return {
        status: 'completed',
        detail: `Committed and pushed resolved conflict remediation for PR #${snapshot.prNumber}.`,
      };
    } catch (error) {
      return {
        status: 'failed',
        detail: `Could not commit/push resolved conflict remediation for PR #${snapshot.prNumber}: ${errorMessage(error)}`,
      };
    }
  },
  async updateBehindBranch(snapshot, githubTruth) {
    const branch = githubTruth.headRefName || snapshot.branch;
    const baseBranch = githubTruth.baseRefName;
    if (!baseBranch) {
      return {
        status: 'unknown-failed',
        detail: `cannot determine the base branch for PR #${snapshot.prNumber}`,
      };
    }

    return updateBranchWithBase(branch, baseBranch, snapshot.worktree);
  },
  async launchReadyRemediation(snapshot, failedCheckSummary, failedCheckNames, attemptNumber, maxAttempts, repoDir, readyWatchdogToolPath) {
    try {
      const { stdout } = await execFileAsync(
        'npx',
        [
          'tsx',
          readyWatchdogToolPath,
          '--repo-dir',
          repoDir,
          '--launch-remediation',
          snapshot.issueId,
          '--failed-check-summary',
          failedCheckSummary,
          '--failed-check-names-json',
          JSON.stringify(failedCheckNames),
          '--attempt-number',
          String(attemptNumber),
          '--max-attempts',
          String(maxAttempts),
        ],
        {
          cwd: repoDir,
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024,
        },
      );
      return JSON.parse(stdout) as ReadyRemediationLaunchResult;
    } catch (error) {
      return {
        status: 'failed',
        detail: `Ready watchdog could not launch remediation tool: ${errorMessage(error)}`,
        attemptNumber,
      };
    }
  },
  now: () => new Date(),
};

async function inspectWorktreeMergeState(worktree: string): Promise<WorktreeMergeState> {
  const state: WorktreeMergeState = {
    mergeHead: null,
    unmergedPaths: [],
    stagedPaths: [],
    unstagedPaths: [],
    untrackedPaths: [],
    rawStatus: [],
  };

  try {
    const { stdout } = await execFileAsync('git', ['-C', worktree, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'], {
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
    });
    state.mergeHead = stdout.trim() || null;
  } catch {
    state.mergeHead = null;
  }

  try {
    const { stdout } = await execFileAsync('git', ['-C', worktree, 'status', '--porcelain=v1', '-z'], {
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
    });
    // In `--porcelain=v1 -z`, each entry is `XY <path>\0`. Rename/copy entries
    // additionally emit the original path as a separate trailing `<path>\0`
    // token with no status code, which must be consumed rather than parsed.
    const entries = stdout.split('\0');
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) {
        continue;
      }
      const rawCode = entry.slice(0, 2);
      const pathName = entry.slice(3);
      state.rawStatus.push(`${rawCode} ${pathName}`);

      const [indexStatus, worktreeStatus] = rawCode;
      if (indexStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'R' || worktreeStatus === 'C') {
        // Skip the original-path token that follows a rename/copy entry.
        i += 1;
      }
      const isUnmerged = indexStatus === 'U'
        || worktreeStatus === 'U'
        || rawCode === 'AA'
        || rawCode === 'DD';
      if (isUnmerged) {
        state.unmergedPaths.push(pathName);
        continue;
      }
      if (rawCode === '??') {
        state.untrackedPaths.push(pathName);
        continue;
      }
      if (indexStatus && indexStatus !== ' ' && indexStatus !== '?' && indexStatus !== '!') {
        state.stagedPaths.push(pathName);
      }
      if (worktreeStatus && worktreeStatus !== ' ' && worktreeStatus !== '?' && worktreeStatus !== '!') {
        state.unstagedPaths.push(pathName);
      }
    }
  } catch (error) {
    state.inspectError = errorMessage(error);
  }

  return state;
}

function summarizeChecks(checks: NormalizedCheckSummary[]): {
  failures: string[];
  pending: string[];
  successes: number;
} {
  const failures: string[] = [];
  const pending: string[] = [];
  let successes = 0;

  for (const check of checks) {
    if (check.status === 'failure') {
      failures.push(`${check.name} (${check.rawStatus || 'FAILURE'})`);
    } else if (check.status === 'pending') {
      pending.push(`${check.name} (${check.rawStatus || 'PENDING'})`);
    } else if (['success', 'neutral', 'skipped'].includes(check.status)) {
      successes += 1;
    }
  }

  return { failures, pending, successes };
}

function buildFailingChecksFingerprint(checks: NormalizedCheckSummary[]): string | undefined {
  const fingerprint = checks
    .filter((check) => check.status === 'failure')
    .map((check) => `${check.name.trim().toLowerCase()}:${(check.rawStatus || 'FAILURE').trim().toLowerCase()}`)
    .sort()
    .join(',');
  return fingerprint || undefined;
}

function displayLabel(kind: Exclude<ReadyWatchdogClassificationKind, 'fresh'>): string {
  if (kind === 'auto-update') return 'auto update';
  if (kind === 'disconnected-remediation') return 'disconnected remediation';
  if (kind === 'waiting-on-ci') return 'waiting on CI';
  if (kind === 'stable-failing-safe') return 'stable failing safe';
  if (kind === 'waiting-on-eval-comparison') return 'waiting on eval/comparison';
  if (kind === 'waiting-on-merge-lane') return 'waiting on merge lane';
  if (kind === 'needs-user') return 'needs user';
  return 'stuck';
}

function classifyFailingChecks(
  failures: string[],
  safeCategories: string[],
): { kind: 'stable-failing-safe'; remediableNames: string[] } | { kind: 'waiting-on-ci' } {
  const normalizedCategories = safeCategories.map((category) => category.trim().toLowerCase()).filter(Boolean);
  const remediableNames = failures.filter((failure) => normalizedCategories.some((category) => {
    const lower = failure.toLowerCase();
    if (category === 'type') {
      return lower.includes('type') || lower.includes('typecheck');
    }
    if (category === 'test') {
      return lower.includes('test') || lower.includes('unit') || lower.includes('shell');
    }
    if (category === 'migration-chain') {
      return lower.includes('migration-chain') || lower.includes('migration chain');
    }
    return lower.includes(category);
  }));

  if (failures.length > 0 && remediableNames.length === failures.length) {
    return { kind: 'stable-failing-safe', remediableNames };
  }

  return { kind: 'waiting-on-ci' };
}

function readyStateDir(worktree: string, slug: string): string {
  for (const dir of ['features', 'bugs']) {
    const candidate = path.join(worktree, dir, slug);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return path.join(worktree, 'features', slug);
}

function readAttentionDetail(stateDir: string): string | null {
  const file = path.join(stateDir, '.needs-attention');
  if (!existsSync(file)) {
    return null;
  }

  try {
    const content = readFileSync(file, 'utf-8');
    try {
      const parsed = JSON.parse(content) as { schemaVersion?: unknown; reason?: unknown };
      if (parsed?.schemaVersion === 1 && typeof parsed.reason === 'string') {
        return parsed.reason.trim() || null;
      }
    } catch {
      // Legacy plain-text marker.
    }
    return content.split(/\r?\n/, 1)[0]?.trim() || null;
  } catch {
    return null;
  }
}

function parseIsoDate(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isUnconfirmedGitHubTruth(githubTruth: GitHubPRTruth | null): boolean {
  return githubTruth === null
    || Boolean(githubTruth.checkReadError)
    || !String(githubTruth.state || '').trim()
    || githubTruth.mergeable === 'UNKNOWN'
    || githubTruth.mergeStateStatus === 'UNKNOWN';
}

function lastConfirmationDate(entry: ReadyWatchdogStateEntry): Date | null {
  return parseIsoDate(entry.lastConfirmedAt)
    ?? parseIsoDate(entry.classificationSince)
    ?? parseIsoDate(entry.updatedAt);
}

function unconfirmedEntryExpired(entry: ReadyWatchdogStateEntry, now: Date): boolean {
  const confirmedAt = lastConfirmationDate(entry);
  if (!confirmedAt) {
    return false;
  }
  const ttlMs = readyWatchdogUnconfirmedEntryTtlMsForTest ?? READY_WATCHDOG_UNCONFIRMED_ENTRY_TTL_MS;
  return now.getTime() - confirmedAt.getTime() >= ttlMs;
}

function buildReapedEntry(
  entry: ReadyWatchdogStateEntry,
  reason: ReadyWatchdogReapReason,
): ReadyWatchdogReapedEntry {
  return {
    issueId: entry.issueId,
    classification: entry.classification,
    reason,
    classificationSince: entry.classificationSince,
    lastConfirmedAt: entry.lastConfirmedAt,
    updatedAt: entry.updatedAt,
  };
}

function fileMtimeIso(file: string): string | null {
  if (!existsSync(file)) {
    return null;
  }
  try {
    return statSync(file).mtime.toISOString();
  } catch {
    return null;
  }
}

function computeLastProgressAt(
  task: WorkflowTaskRecord,
  readyResult: StageResult | null,
  readyResultFile: string,
  taskProgress: TaskProgress | null,
): string | null {
  // HOK-3101: prefer the shared primitive so hook, commit and worktree
  // evidence contribute — not only transitions. The ready-specific inputs
  // (ready result mtime, its startedAt/finishedAt) are still folded in
  // through extraTransitionSources when the caller composes the primitive.
  const candidates = [
    taskProgress?.lastProgressAt ?? null,
    task.updated,
    readyResult?.finishedAt ?? null,
    readyResult?.startedAt ?? null,
    fileMtimeIso(readyResultFile),
  ]
    .map((v) => (typeof v === 'string' ? parseIsoDate(v) : v))
    .filter((value): value is Date => value !== null)
    .sort((a, b) => b.getTime() - a.getTime());

  return candidates[0]?.toISOString() ?? null;
}

function computeIdleMinutes(lastProgressAt: string | null, now: Date): number | null {
  const parsed = parseIsoDate(lastProgressAt);
  if (!parsed) {
    return null;
  }
  return Math.max(0, Math.floor((now.getTime() - parsed.getTime()) / 60_000));
}

function hasRunningEvalOrComparison(snapshot: ReadyTaskSnapshot): boolean {
  return snapshot.relevantJobs.some((job) => job.status === 'running');
}

function isCleanMergeState(githubTruth: GitHubPRTruth): boolean {
  return githubTruth.state === 'OPEN'
    && githubTruth.mergeable === 'MERGEABLE'
    && ['CLEAN', 'HAS_HOOKS'].includes(githubTruth.mergeStateStatus);
}

function hasLocalMergeResidue(state: WorktreeMergeState): boolean {
  return state.mergeHead !== null
    || state.unmergedPaths.length > 0
    || state.stagedPaths.length > 0
    || state.unstagedPaths.length > 0;
}

function canSafelyResumeResolvedMerge(snapshot: ReadyTaskSnapshot): boolean {
  const state = snapshot.worktreeMergeState;
  return snapshot.hasConflictMarker
    && snapshot.readyResultStatus === 'running'
    && snapshot.remediationPaneActive === false
    && snapshot.remediationLaunchHead !== null
    && snapshot.currentHead !== null
    && snapshot.remediationLaunchHead === snapshot.currentHead
    && state.mergeHead !== null
    && state.inspectError === undefined
    && state.unmergedPaths.length === 0
    && state.stagedPaths.length > 0
    && state.unstagedPaths.length === 0;
}

function disconnectedMergeResidueDetected(snapshot: ReadyTaskSnapshot): boolean {
  if (!snapshot.hasConflictMarker || snapshot.readyResultStatus !== 'running') {
    return false;
  }
  if (snapshot.remediationPaneActive === true) {
    return false;
  }
  return hasLocalMergeResidue(snapshot.worktreeMergeState);
}

function summarizeMergeState(state: WorktreeMergeState): string {
  const parts = [
    `MERGE_HEAD=${state.mergeHead ? state.mergeHead.slice(0, 12) : 'absent'}`,
    `unmerged=${state.unmergedPaths.length ? state.unmergedPaths.join(',') : 'none'}`,
    `staged=${state.stagedPaths.length ? state.stagedPaths.join(',') : 'none'}`,
    `unstaged=${state.unstagedPaths.length ? state.unstagedPaths.join(',') : 'none'}`,
  ];
  if (state.untrackedPaths.length > 0) {
    parts.push(`untracked=${state.untrackedPaths.join(',')}`);
  }
  if (state.inspectError) {
    parts.push(`inspectError=${state.inspectError}`);
  }
  return parts.join('; ');
}

function nextCommandForMergeState(snapshot: ReadyTaskSnapshot): string {
  const worktree = escapeShellArg(snapshot.worktree);
  if (snapshot.worktreeMergeState.unmergedPaths.length > 0) {
    return `cd ${worktree} && git status --short && git diff --check`;
  }
  if (!snapshot.worktreeMergeState.mergeHead) {
    return `cd ${worktree} && git status --short`;
  }
  return `cd ${worktree} && git status --short && git commit -m ${escapeShellArg('fix: Resolve merge conflicts')} && git push origin ${escapeShellArg(snapshot.branch)}`;
}

function readBackstageHealth(repoDir: string): BackstageHealthState | null {
  const healthPath = path.join(repoDir, '.wavemill', 'backstage-health.json');
  if (!existsSync(healthPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(healthPath, 'utf-8')) as Record<string, unknown>;
    return {
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
      status: typeof parsed.status === 'string' ? parsed.status : 'unknown',
      detail: typeof parsed.detail === 'string' ? parsed.detail : null,
      restartAttemptCount: typeof parsed.restartAttemptCount === 'number' ? parsed.restartAttemptCount : null,
      lastRestartAttemptAt: typeof parsed.lastRestartAttemptAt === 'string' ? parsed.lastRestartAttemptAt : null,
      executorPaneId: typeof parsed.executorPaneId === 'string' ? parsed.executorPaneId : null,
    };
  } catch {
    return null;
  }
}

function isBehindMergeState(githubTruth: GitHubPRTruth): boolean {
  return githubTruth.state === 'OPEN'
    && githubTruth.mergeable === 'MERGEABLE'
    && githubTruth.mergeStateStatus === 'BEHIND';
}

function buildPrStateKey(githubTruth: GitHubPRTruth | null): string | undefined {
  if (!githubTruth) {
    return undefined;
  }

  return [githubTruth.state, githubTruth.mergeable, githubTruth.mergeStateStatus]
    .map((value) => String(value || '').trim().toUpperCase())
    .join('|');
}

function normalizeDetailFingerprint(detail: string): string {
  return detail.trim().replace(/\s+/g, ' ');
}

/** Stable fingerprint for watchdog entries that ignores volatile idle-minute counts in merge-lane details. */
function buildReadyWatchdogFingerprint(input: {
  classification: Exclude<ReadyWatchdogClassificationKind, 'fresh'>;
  detail: string;
}): string {
  // Strip volatile "idle Nm" and "waited Nm" tokens from merge-lane details so
  // the fingerprint stays stable across ticks that only differ in elapsed minutes.
  if (
    input.classification === 'waiting-on-merge-lane' ||
    (input.classification === 'needs-user' && /\b(?:idle|waited)\s+\d+m\b/i.test(input.detail))
  ) {
    return normalizeDetailFingerprint(
      input.detail
        .replace(/\bidle\s+\d+m\b/gi, 'idle Xm')
        .replace(/\bwaited\s+\d+m\b/gi, 'waited Xm'),
    );
  }
  return normalizeDetailFingerprint(input.detail);
}

function getReportIntervalSeconds(): number {
  const DEFAULT = 3600;
  const raw = process.env.WAVEMILL_READY_WATCHDOG_REPORT_INTERVAL_SECONDS;
  if (!raw) {
    return DEFAULT;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT;
  }
  return parsed;
}

/**
 * Determines whether a watchdog finding should be emitted (logged to the control
 * pane and appended to the audit JSONL). Separates "is the state materially
 * different from the last logged entry" from "has time elapsed enough to remind".
 *
 * Suppression rule: when classification, action, and stable fingerprint all match
 * the last logged entry AND action is "reported", suppress until the report
 * interval has elapsed.
 */
function shouldEmitReadyWatchdogFinding(
  prior: ReadyWatchdogStateEntry | undefined,
  next: ReadyWatchdogStateEntry,
  now: Date,
  reportIntervalSeconds: number,
): boolean {
  // No prior logged record (first ever tick or old state file without lastLogged* fields).
  if (!prior || !prior.lastLoggedAt) {
    return true;
  }

  // Classification changed since last logged entry.
  if (prior.lastLoggedClassification !== next.classification) {
    return true;
  }

  // Action changed since last logged entry.
  if (prior.lastLoggedAction !== next.action) {
    return true;
  }

  // Stable fingerprint changed since last logged entry.
  if (prior.lastLoggedFingerprint !== next.detailFingerprint) {
    return true;
  }

  // Other material changes from non-volatile structured fields. Monotonic
  // counters are intentionally excluded: their threshold effects are surfaced
  // through classification/action/detail changes above, and comparing raw
  // increments would bypass the rate-limit branch below.
  if (prior.prStateKey !== next.prStateKey) return true;
  if (prior.autoUpdateAttempts !== next.autoUpdateAttempts) return true;
  if (prior.lastAutoUpdateError !== next.lastAutoUpdateError) return true;
  if (prior.recoveryCommand !== next.recoveryCommand) return true;
  if (JSON.stringify(prior.remediationCategories ?? []) !== JSON.stringify(next.remediationCategories ?? [])) return true;
  if (prior.failingChecksFingerprint !== next.failingChecksFingerprint) return true;
  if (prior.transientFailureCount !== next.transientFailureCount) return true;
  if (prior.transientFailureHead !== next.transientFailureHead) return true;
  if (prior.lastCiFailureCategory !== next.lastCiFailureCategory) return true;
  if (prior.lastFailingJob !== next.lastFailingJob) return true;
  if (prior.lastLocalCommand !== next.lastLocalCommand) return true;
  if (prior.terminal !== next.terminal) return true;
  if (prior.terminalReason !== next.terminalReason) return true;
  if (prior.terminalAttempts !== next.terminalAttempts) return true;
  if (prior.terminalHeadSha !== next.terminalHeadSha) return true;

  // Same classification/action/fingerprint: rate-limit repeated "reported" findings.
  if (next.action === 'reported') {
    const lastLoggedDate = parseIsoDate(prior.lastLoggedAt);
    if (!lastLoggedDate) {
      return true; // unparseable timestamp — emit to be safe
    }
    const elapsedSeconds = (now.getTime() - lastLoggedDate.getTime()) / 1000;
    return elapsedSeconds >= reportIntervalSeconds;
  }

  // No material change and not a rate-limited action: suppress.
  return false;
}

function makeRecoveryCommand(repoDir: string, stateFile: string, issueId: string, readyWatchdogToolPath: string): string {
  return [
    'npx',
    'tsx',
    escapeShellArg(readyWatchdogToolPath),
    '--repo-dir',
    escapeShellArg(repoDir),
    '--state-file',
    escapeShellArg(stateFile),
    '--recover',
    escapeShellArg(issueId),
    '--json',
  ].join(' ');
}

export function classifyReadyTask(
  snapshot: ReadyTaskSnapshot,
  githubTruth: GitHubPRTruth | null,
  now: Date,
  config: ReadyTaskClassificationConfig,
  prior?: ReadyWatchdogStateEntry,
  challengeGate?: ChallengeGate,
): ReadyWatchdogClassification {
  const normalizedConfig = {
    enabled: true,
    thresholdMinutes: 10,
    autoRecover: true,
    timeoutSeconds: 30,
    stableFailureConsecutivePolls: 2,
    stableFailureEscalateAfterPolls: 4,
    safeRemediationCategories: ['lint', 'type', 'test', 'build', 'migration-chain', 'alembic'],
    localCommandMap: {},
    remediationLogMaxBytes: 20_000,
    ...config,
  };
  if (snapshot.lastProgressAt === null || snapshot.idleMinutes === null) {
    return {
      kind: 'needs-user',
      detail: 'Ready watchdog could not determine the last local progress timestamp.',
    };
  }

  if (snapshot.idleMinutes < normalizedConfig.thresholdMinutes) {
    return {
      kind: 'fresh',
      detail: `Ready stage idle for ${snapshot.idleMinutes}m, below threshold.`,
    };
  }

  if (hasRunningEvalOrComparison(snapshot)) {
    const runningComparison = snapshot.relevantJobs.find((job) => job.status === 'running' && job.kind === 'comparison');
    if (runningComparison) {
      return {
        kind: 'waiting-on-eval-comparison',
        detail: `PR #${snapshot.prNumber} is waiting for the challenge comparison job for pair ${runningComparison.pairId ?? snapshot.challengePairId ?? 'unknown'} to finish.`,
      };
    }
    const runningJobs = snapshot.relevantJobs
      .filter((job) => job.status === 'running')
      .map((job) => `${job.kind}:${job.id}`);
    return {
      kind: 'waiting-on-eval-comparison',
      detail: `Background jobs still running: ${runningJobs.join(', ')}.`,
    };
  }

  if (canSafelyResumeResolvedMerge(snapshot)) {
    return {
      kind: 'disconnected-remediation',
      detail: `Conflict remediation worker exited after resolving conflicts for PR #${snapshot.prNumber}; ${summarizeMergeState(snapshot.worktreeMergeState)}.`,
      autoRecoverable: true,
    };
  }

  if (disconnectedMergeResidueDetected(snapshot)) {
    const paneState = snapshot.remediationPaneActive === null ? 'unknown' : 'inactive';
    return {
      kind: 'needs-user',
      detail: `Conflict remediation worker is ${paneState} and the worktree is unsafe to mutate automatically for PR #${snapshot.prNumber}: ${summarizeMergeState(snapshot.worktreeMergeState)}. Next command: ${nextCommandForMergeState(snapshot)}`,
    };
  }

  if (!githubTruth) {
    return {
      kind: 'needs-user',
      detail: 'Ready watchdog could not read GitHub PR state.',
    };
  }

  if (githubTruth.checkReadError) {
    return {
      kind: 'waiting-on-ci',
      detail: `Required GitHub check status could not be read for PR #${snapshot.prNumber} (${githubTruth.checkReadError.errorType}): ${githubTruth.checkReadError.reason}`,
      autoRemediable: false,
    };
  }

  if (githubTruth.state !== 'OPEN') {
    return {
      kind: 'needs-user',
      detail: `PR #${snapshot.prNumber} is ${githubTruth.state.toLowerCase()}, so ready cannot advance automatically.`,
    };
  }

  if (githubTruth.mergeable === 'CONFLICTING' || githubTruth.mergeStateStatus === 'DIRTY') {
    return {
      kind: 'needs-user',
      detail: `PR #${snapshot.prNumber} has real merge conflicts on GitHub.`,
    };
  }

  if (githubTruth.mergeable === 'UNKNOWN' || githubTruth.mergeStateStatus === 'UNKNOWN') {
    return {
      kind: 'needs-user',
      detail: `GitHub mergeability for PR #${snapshot.prNumber} is still unknown.`,
    };
  }

  if (isBehindMergeState(githubTruth)) {
    // HOK-3102: without a merge lane (no tend), auto-updating a BEHIND branch
    // is preparing for a merge nobody will do. Fall through to the checks
    // below and let the operator update the branch when they merge.
    if (normalizedConfig.mergeLaneActive !== false) {
      return {
        kind: 'auto-update',
        detail: `PR #${snapshot.prNumber} is mergeable but behind ${githubTruth.baseRefName ?? 'its base branch'}.`,
      };
    }
  }

  const checkSummary = summarizeChecks(githubTruth.checks);
  if (checkSummary.failures.length > 0) {
    const detail = `Failing checks: ${checkSummary.failures.join(', ')}.`;
    if (checkSummary.pending.length > 0) {
      return {
        kind: 'waiting-on-ci',
        detail,
        consecutiveFailurePolls: 1,
        autoRemediable: false,
      };
    }

    const prStateKey = buildPrStateKey(githubTruth);
    const sameFailureState = prior !== undefined
      && prior.prStateKey === prStateKey
      && prior.detailFingerprint === normalizeDetailFingerprint(detail)
      && ['waiting-on-ci', 'stable-failing-safe', 'needs-user'].includes(prior.classification);
    const consecutiveFailurePolls = sameFailureState
      ? (prior.consecutiveFailurePolls ?? 1) + 1
      : 1;
    const ciClassifications = githubTruth.checks
      .filter((check) => check.status === 'failure')
      .map((check) => classifyCiFailure(check, {
        localCommandMap: normalizedConfig.localCommandMap,
        logMaxBytes: normalizedConfig.remediationLogMaxBytes,
      }));
    const primaryClassification = ciClassifications[0];
    const allDeterministic = ciClassifications.length > 0
      && ciClassifications.every((classification) => classification.category === 'deterministic-local');
    const allTransient = ciClassifications.length > 0
      && ciClassifications.every((classification) => classification.category === 'transient-infra');
    // HOK-3176: only an allowlisted cause parks at once — a GitHub-only gate
    // (approval, branch protection) is `operator-gate`. An unrecognised failure
    // is retried: CI is re-polled here and the monitor's failed-ready-recheck
    // bucket re-runs Ready; it escalates only once the same failure has held
    // for stableFailureEscalateAfterPolls polls.
    const policyDecisions = ciClassifications.map((classification) => classifyFailure({
      stage: 'ready',
      failureKind: classification.category === 'github-only' ? 'operator-gate' : undefined,
      ciCategory: classification.category,
      detail: classification.reason,
    }));
    const operatorGated = policyDecisions.some((decision) => decision.class === 'terminal');
    const unrecognisedStable = ciClassifications.some((classification) => classification.category === 'unknown')
      && consecutiveFailurePolls >= normalizedConfig.stableFailureEscalateAfterPolls;

    if (operatorGated || unrecognisedStable) {
      const reasons = ciClassifications.map((classification) => classification.reason).join(' ');
      const held = operatorGated ? '' : ` Unrecognised failure held for ${consecutiveFailurePolls} polls.`;
      return {
        kind: 'needs-user',
        detail: `Failing checks require operator attention: ${checkSummary.failures.join(', ')}. ${reasons}${held}`,
        consecutiveFailurePolls,
        ciFailureCategory: primaryClassification?.category,
        failingJob: primaryClassification?.failingJob,
        localCommand: primaryClassification?.localCommand,
        logExcerpt: primaryClassification?.logExcerpt,
      };
    }

    if (allTransient) {
      return {
        kind: 'waiting-on-ci',
        detail: `Transient CI failure observed: ${checkSummary.failures.join(', ')}. ${ciClassifications.map((classification) => classification.reason).join(' ')}`,
        consecutiveFailurePolls,
        autoRemediable: false,
        ciFailureCategory: 'transient-infra',
        failingJob: primaryClassification?.failingJob,
        localCommand: primaryClassification?.localCommand,
        logExcerpt: primaryClassification?.logExcerpt,
      };
    }

    if (allDeterministic
      && consecutiveFailurePolls >= normalizedConfig.stableFailureConsecutivePolls) {
      const commands = [...new Set(ciClassifications.map((classification) => classification.localCommand).filter(Boolean))].join('; ');
      return {
        kind: 'stable-failing-safe',
        detail: `${detail} Local replay: ${commands}.`,
        remediationCategories: ciClassifications.map((classification) => classification.failingJob),
        consecutiveFailurePolls,
        autoRemediable: true,
        ciFailureCategory: 'deterministic-local',
        failingJob: primaryClassification?.failingJob,
        localCommand: primaryClassification?.localCommand,
        logExcerpt: primaryClassification?.logExcerpt,
      };
    }

    const legacyFailureClassification = classifyFailingChecks(
      checkSummary.failures,
      normalizedConfig.safeRemediationCategories,
    );

    if (legacyFailureClassification.kind === 'waiting-on-ci'
      && consecutiveFailurePolls >= normalizedConfig.stableFailureEscalateAfterPolls) {
      return {
        kind: 'needs-user',
        detail: `Failing checks remained unsafe for automatic remediation: ${checkSummary.failures.join(', ')}.`,
        consecutiveFailurePolls,
      };
    }

    return {
      kind: 'waiting-on-ci',
      detail,
      consecutiveFailurePolls,
      autoRemediable: false,
      ciFailureCategory: primaryClassification?.category,
      failingJob: primaryClassification?.failingJob,
      localCommand: primaryClassification?.localCommand,
      logExcerpt: primaryClassification?.logExcerpt,
    };
  }

  if (checkSummary.pending.length > 0) {
    return {
      kind: 'waiting-on-ci',
      detail: `Checks still pending: ${checkSummary.pending.join(', ')}.`,
    };
  }

  if (isCleanMergeState(githubTruth) && checkSummary.successes > 0) {
    // A PR in the merge lane is idle on purpose: it already passed ready and is
    // waiting its turn to merge. Re-running its ready checks does nothing useful
    // — it's the queue, not the PR, that hasn't advanced — and "recovering" it
    // resets the ready clock, which re-arms this very check ~every threshold
    // minutes (observed: one PR auto-recovered 30 times while clean and green).
    // Treat normal lane-waiting as benign; only escalate to needs-user once the
    // wait is long enough to signal the lane itself is stalled.
    //
    // Three queue states represent legitimate lane-waiting:
    //   ready-stale      — passed ready, main advanced before it was selected
    //   merge-candidate  — selected as the next PR to merge, waiting for the merge
    //   ready (completed)— passed ready against the current base, not yet selected
    const queueState = snapshot.readyArtifacts?.queueState;
    const inMergeLane = queueState === 'ready-stale'
      || queueState === 'merge-candidate'
      || (queueState === 'ready' && snapshot.readyResultStatus === 'completed');

    if (inMergeLane) {
      // Before reporting a merge-lane wait, check if the tend challenge gate would block
      // this PR. A PR blocked by a missing challenge comparison will never be selected by
      // the merge controller, so reporting waiting-on-merge-lane is misleading.
      if (challengeGate?.kind === 'pair-unresolved' || challengeGate?.kind === 'pair-unresolvable') {
        return classifyMergeLaneChallengeBlocker(snapshot, challengeGate, config);
      }

      const escalateMinutes = normalizedConfig.thresholdMinutes * MERGE_LANE_STALL_ESCALATE_MULTIPLIER;
      if (snapshot.idleMinutes >= escalateMinutes) {
        const backstageHealth = snapshot.backstageHealth;
        if (
          backstageHealth?.status === 'missing-tend-loop'
          || backstageHealth?.status === 'stalled'
          || backstageHealth?.status === 'needs-user'
        ) {
          const stalled = backstageHealth.status === 'stalled';
          const backstageDetail = backstageHealth.detail ?? (
            stalled
              ? 'Backstage tend loop heartbeat is stale.'
              : 'Backstage tend loop executor is missing.'
          );
          return {
            kind: 'needs-user',
            detail: `${stalled ? 'Stalled tend loop' : 'Missing tend loop'}: ${backstageDetail} PR #${snapshot.prNumber} has waited ${snapshot.idleMinutes}m for its merge turn without an active merge executor.`,
          };
        }
        return {
          kind: 'needs-user',
          detail: `Merge lane appears stalled: PR #${snapshot.prNumber} passed ready and has waited ${snapshot.idleMinutes}m for its merge turn without the lane advancing.`,
        };
      }
      return {
        kind: 'waiting-on-merge-lane',
        detail: `PR #${snapshot.prNumber} passed ready and is waiting its turn in the merge lane (idle ${snapshot.idleMinutes}m).`,
      };
    }

    const remediationInFlight = snapshot.hasConflictMarker
      && snapshot.readyResultStatus === 'running'
      && snapshot.remediationLaunchHead !== null
      && snapshot.currentHead !== null
      && snapshot.remediationLaunchHead === snapshot.currentHead;

    return {
      kind: 'stuck',
      detail: `Local ready state has been idle for ${snapshot.idleMinutes}m while PR #${snapshot.prNumber} is clean and green.`,
      autoRecoverable: !remediationInFlight,
    };
  }

  if (githubTruth.checks.length === 0) {
    return {
      kind: 'needs-user',
      detail: `PR #${snapshot.prNumber} is open but GitHub reported no status checks.`,
    };
  }

  return {
    kind: 'needs-user',
    detail: `PR #${snapshot.prNumber} is blocked by merge state ${githubTruth.mergeStateStatus || githubTruth.mergeable}.`,
  };
}

function classifyMergeLaneChallengeBlocker(
  snapshot: ReadyTaskSnapshot,
  challengeGate: Extract<ChallengeGate, { kind: 'pair-unresolved' | 'pair-unresolvable' }>,
): ReadyWatchdogClassification {
  const pairLabel = challengeGate.otherPr ? ` (pair PR #${challengeGate.otherPr})` : '';
  if (challengeGate.kind === 'pair-unresolved') {
    if (challengeGate.reason === 'pair-unresolved:comparison-in-progress') {
      return {
        kind: 'waiting-on-eval-comparison',
        detail: `PR #${snapshot.prNumber} is waiting for the challenge comparison job for pair ${challengeGate.pairId}${pairLabel} to finish.`,
      };
    }
    return {
      kind: 'waiting-on-eval-comparison',
      detail: `PR #${snapshot.prNumber} is blocked from merging: challenge pair ${challengeGate.pairId}${pairLabel} has no comparison record (${challengeGate.reason}). The merge controller will not select this PR until the challenge comparison exists or challenge metadata is cleared.`,
    };
  }

  const recoveryCommand = buildChallengePairRecoveryCommand(snapshot, challengeGate.pairId, challengeGate.reason);
  if (challengeGate.reason === 'orphan-sibling') {
    return {
      kind: 'needs-user',
      detail: `PR #${snapshot.prNumber} is blocked from merging: challenge pair ${challengeGate.pairId}${pairLabel} has no discoverable sibling task/PR/branch, so no comparison can be produced.`,
      recoveryCommand,
    };
  }
  if (challengeGate.reason === 'sibling-eval-hard-failed') {
    return {
      kind: 'needs-user',
      detail: `PR #${snapshot.prNumber} is blocked from merging: challenge pair ${challengeGate.pairId}${pairLabel} cannot produce a comparison because one side exhausted challenge eval hard-failure retries.`,
      recoveryCommand,
    };
  }
  if (challengeGate.reason === 'sibling-challenge-aborted') {
    return {
      kind: 'needs-user',
      detail: `PR #${snapshot.prNumber} is blocked from merging: challenge pair ${challengeGate.pairId}${pairLabel} cannot produce a comparison because one arm hit a terminal launch failure and was quarantined.`,
      recoveryCommand,
    };
  }
  if (challengeGate.reason === 'sibling-stalled') {
    return {
      kind: 'needs-user',
      detail: `PR #${snapshot.prNumber} is blocked from merging: challenge pair ${challengeGate.pairId}${pairLabel} cannot produce a comparison because one arm has shown no agent progress for ≥30m without opening a PR (agent exited or stalled).`,
      recoveryCommand,
    };
  }
  if (challengeGate.reason === 'both-challenge-aborted') {
    return {
      kind: 'needs-user',
      detail: `PR #${snapshot.prNumber} is blocked from merging: challenge pair ${challengeGate.pairId}${pairLabel} cannot produce a comparison because both arms were quarantined after a terminal launch failure.`,
      recoveryCommand,
    };
  }
  return {
    kind: 'needs-user',
    detail: `PR #${snapshot.prNumber} is blocked from merging: challenge pair ${challengeGate.pairId}${pairLabel} cannot produce a comparison because both sides exhausted challenge eval hard-failure retries.`,
    recoveryCommand,
  };
}

function buildChallengePairRecoveryCommand(
  snapshot: ReadyTaskSnapshot,
  pairId: string,
  reason: UnresolvableReason,
): string {
  return [
    'npx',
    'tsx',
    escapeShellArg(CHALLENGE_PAIR_RESOLVER_TOOL_PATH),
    '--pair-id',
    escapeShellArg(pairId),
    '--reason',
    escapeShellArg(reason),
    '--repo-dir',
    escapeShellArg(path.resolve(snapshot.worktree, '..', '..')),
    '--dry-run',
  ].join(' ');
}

async function buildSnapshot(
  issueId: string,
  task: WorkflowTaskRecord,
  jobs: Record<string, MillJob>,
  now: Date,
  repoDir: string,
  deps: ReadyWatchdogDeps,
  session: string,
): Promise<ReadyTaskSnapshot | null> {
  const slug = task.slug;
  const branch = task.branch;
  const worktree = task.worktree;
  const prNumber = Number(task.pr);

  if (!slug || !branch || !worktree || !Number.isFinite(prNumber) || prNumber <= 0) {
    return null;
  }

  const stateDir = readyStateDir(worktree, slug);
  const readyResultFile = path.join(stateDir, '.ready-result.json');
  const readyResult = await readStageResult(stateDir, 'ready');
  const readyArtifacts = readyResult?.artifacts?.type === 'ready'
    ? readyResult.artifacts
    : null;

  const relevantJobs = Object.values(jobs).filter((job) => {
    if (job.status !== 'running') {
      return false;
    }

    if (job.issueId === issueId) {
      return true;
    }

    if (task.challengePairId && job.pairId === task.challengePairId) {
      return true;
    }

    return Array.isArray(job.prNumbers) && job.prNumbers.includes(prNumber);
  });

  // HOK-3101: the shared task-progress primitive supplies hook/commit/worktree
  // evidence and an agentIdle fact that a live pane cannot override.
  const taskProgress = deps.getTaskProgress(task, {
    session,
    repoDir,
    worktree,
    stateDir,
    readyResult,
    readyResultFile,
    now,
  });
  const lastProgressAt = computeLastProgressAt(task, readyResult, readyResultFile, taskProgress);
  // HOK-3101 / HOK-3095 (a): if the pane is live but the agent's own record
  // is idle, the pane is holding an idle REPL — do not report active.
  let paneActive = await deps.isTaskPaneActive(task);
  if (paneActive === true && taskProgress?.agentIdle) {
    paneActive = false;
  }

  return {
    issueId,
    slug,
    branch,
    worktree,
    prNumber,
    controllerPhase: String(task.phase ?? ''),
    controllerUpdatedAt: typeof task.updated === 'string' ? task.updated : null,
    currentAgent: String(task.agent ?? ''),
    currentModel: String(task.model ?? ''),
    challengePairId: typeof task.challengePairId === 'string' ? task.challengePairId : null,
    readyStateDir: stateDir,
    readyResult,
    readyArtifacts,
    readyResultStatus: readyResult?.status ?? null,
    readyVerdict: readyArtifacts?.verdict ?? null,
    readyAttentionDetail: readAttentionDetail(stateDir),
    hasNeedsAttention: existsSync(path.join(stateDir, '.needs-attention')),
    hasConflictMarker: existsSync(path.join(stateDir, '.conflict-detected')),
    remediationLaunchHead: readyArtifacts?.remediationLaunchHead ?? readyArtifacts?.launchHead ?? null,
    currentHead: await deps.getCurrentHead(worktree),
    remediationPaneActive: paneActive,
    worktreeMergeState: await deps.getWorktreeMergeState(worktree),
    relevantJobs,
    lastProgressAt,
    idleMinutes: computeIdleMinutes(lastProgressAt, now),
    backstageHealth: readBackstageHealth(repoDir),
  };
}

async function recoverReadyState(
  snapshot: ReadyTaskSnapshot,
  githubTruth: GitHubPRTruth,
  stateFile: string,
  deps: ReadyWatchdogDeps,
  note = 'Ready watchdog cleared stale local state and queued a re-check.',
): Promise<void> {
  clearMarker({ path: path.join(snapshot.readyStateDir, '.needs-attention'), kind: 'ready-attention' });
  clearMarker({ path: path.join(snapshot.readyStateDir, '.conflict-detected'), kind: 'ready-conflict' });
  await rm(path.join(snapshot.readyStateDir, '.conflict-attention-head'), { force: true });
  await rm(path.join(snapshot.readyStateDir, '.conflict-attention-reported'), { force: true });

  const priorArtifacts = snapshot.readyArtifacts ?? { type: 'ready' } as ReadyArtifacts;
  const nextArtifacts: ReadyArtifacts = {
    ...priorArtifacts,
    type: 'ready',
    prNumber: snapshot.prNumber,
    verdict: 'pending',
    mergeConflict: githubTruth.mergeStateStatus,
  };
  delete nextArtifacts.remediationLaunchHead;
  delete nextArtifacts.launchHead;

  await updateStageResult(snapshot.readyStateDir, 'ready', {
    status: 'running',
    finishedAt: null,
    agent: snapshot.currentAgent,
    model: snapshot.currentModel,
    notes: note,
    artifacts: nextArtifacts,
  });

  await mutateJsonState<WorkflowStateLike>(stateFile, (current) => {
    const tasks = { ...(current.tasks ?? {}) };
    const existingTask = typeof tasks[snapshot.issueId] === 'object' && tasks[snapshot.issueId] !== null
      ? tasks[snapshot.issueId] as Record<string, unknown>
      : {};
    tasks[snapshot.issueId] = {
      ...existingTask,
      updated: deps.now().toISOString(),
    };
    return {
      ...current,
      tasks,
      updated: deps.now().toISOString(),
    };
  });
}

async function writeReadyAttention(snapshot: ReadyTaskSnapshot, detail: string): Promise<void> {
  const firstLine = detail.split(/\r?\n/, 1)[0]?.trim() || detail;
  const markerPath = path.join(snapshot.readyStateDir, '.needs-attention');
  const headSha = snapshot.currentHead || 'unknown';
  writeMarker(
    { path: markerPath, kind: 'ready-attention' },
    { headSha, reason: firstLine },
  );
}

async function writeAuditRecord(repoDir: string, record: ReadyWatchdogAuditRecord): Promise<void> {
  const auditPath = path.join(repoDir, '.wavemill', 'ready-watchdog.jsonl');
  await appendFile(auditPath, `${JSON.stringify(record)}\n`, 'utf-8');
}

async function loadPriorWatchdogState(repoDir: string): Promise<ReadyWatchdogStateFile | null> {
  const statePath = path.join(repoDir, '.wavemill', 'ready-watchdog-state.json');
  try {
    const content = await readFile(statePath, 'utf-8');
    return JSON.parse(content) as ReadyWatchdogStateFile;
  } catch {
    return null;
  }
}

function appendMarkerLifecycleFinding(repoDir: string, finding: ReturnType<typeof buildStaleMarkerFinding>): void {
  if (!finding) {
    return;
  }
  // HOK-3102: gated on `resolveSessionCapabilities(repoDir).observer` via the
  // shared helper. With the observer off, this is a no-op.
  const normalized = {
    subsystem: finding.subsystem,
    title: finding.title,
    body: finding.body,
    severity: finding.severity ?? 'warning',
    context: finding.context,
  };
  appendObserverFinding(repoDir, normalized);
}

async function filterValidWatchdogEntries(
  repoDir: string,
  findings: ReadyWatchdogStateEntry[],
): Promise<ReadyWatchdogStateEntry[]> {
  const retained: ReadyWatchdogStateEntry[] = [];

  for (const entry of findings) {
    const recordedSha = entry.terminalHeadSha ?? entry.transientFailureHead;
    const currentHead = entry.currentHeadSha;
    if (!recordedSha || !currentHead) {
      retained.push(entry);
      continue;
    }

    const markerPath = path.join(repoDir, '.wavemill', 'ready-watchdog-state', `${entry.issueId}.json`);
    const markerHandle: MarkerHandle = { path: markerPath, kind: 'ready-watchdog-classification' };
    const existingMarker = readMarker(markerHandle);
    if (
      existingMarker.status !== 'present' ||
      existingMarker.payload.headSha !== recordedSha ||
      existingMarker.payload.reason !== entry.classification
    ) {
      writeMarker(markerHandle, {
        headSha: recordedSha,
        reason: entry.classification,
        detail: {
          issueId: entry.issueId,
          prNumber: entry.prNumber,
          action: entry.action,
        },
      });
    }

    const validation = await validateMarker(markerHandle, {
      currentHead,
      deriveCondition: (payload) => payload.reason === entry.classification,
    });

    if (validation.status === 'valid') {
      retained.push(entry);
      continue;
    }

    appendMarkerLifecycleFinding(
      repoDir,
      buildStaleMarkerFinding(markerHandle, validation, {
        repo: repoDir,
        prNumber: entry.prNumber,
        taskId: entry.issueId,
      }),
    );
    clearMarker(markerHandle);
  }

  return retained;
}

async function writeStateFile(repoDir: string, findings: ReadyWatchdogStateEntry[], now: Date): Promise<void> {
  const statePath = path.join(repoDir, '.wavemill', 'ready-watchdog-state.json');
  const validFindings = await filterValidWatchdogEntries(repoDir, findings);
  await mutateJsonState<ReadyWatchdogStateFile>(
    statePath,
    () => ({
      updatedAt: now.toISOString(),
      tasks: Object.fromEntries(validFindings.map((entry) => [entry.issueId, entry])),
    }),
    {
      createIfMissing: true,
      initial: {
        updatedAt: now.toISOString(),
        tasks: {},
      },
    },
  );
}

function buildFindingEntry(input: {
  issueId: string;
  snapshot: ReadyTaskSnapshot;
  classification: Exclude<ReadyWatchdogClassificationKind, 'fresh'>;
  detail: string;
  action: string;
  now: Date;
  recoveryCommand?: string;
  githubTruth?: GitHubPRTruth | null;
  autoUpdateAttempts?: number;
  lastAutoUpdateError?: string;
  remediationCategories?: string[];
  consecutiveFailurePolls?: number;
  failingChecksFingerprint?: string;
  failingChecksObservedCount?: number;
  transientFailureCount?: number;
  transientFailureHead?: string;
  lastCiFailureCategory?: CiFailureCategory;
  lastFailingJob?: string;
  lastLocalCommand?: string;
  terminal?: boolean;
  terminalReason?: string;
  terminalAttempts?: number;
  terminalHeadSha?: string | null;
}): ReadyWatchdogStateEntry {
  return {
    issueId: input.issueId,
    slug: input.snapshot.slug,
    prNumber: input.snapshot.prNumber,
    classification: input.classification,
    displayLabel: displayLabel(input.classification),
    detail: input.detail,
    action: input.action,
    recoveryCommand: input.recoveryCommand,
    updatedAt: input.now.toISOString(),
    idleMinutes: input.snapshot.idleMinutes,
    lastProgressAt: input.snapshot.lastProgressAt,
    currentHeadSha: input.snapshot.currentHead,
    prStateKey: buildPrStateKey(input.githubTruth ?? null),
    detailFingerprint: buildReadyWatchdogFingerprint({ classification: input.classification, detail: input.detail }),
    autoUpdateAttempts: input.autoUpdateAttempts,
    lastAutoUpdateError: input.lastAutoUpdateError,
    lastReportedAction: input.action,
    remediationCategories: input.remediationCategories,
    consecutiveFailurePolls: input.consecutiveFailurePolls,
    failingChecksFingerprint: input.failingChecksFingerprint,
    failingChecksObservedCount: input.failingChecksObservedCount,
    transientFailureCount: input.transientFailureCount,
    transientFailureHead: input.transientFailureHead,
    lastCiFailureCategory: input.lastCiFailureCategory,
    lastFailingJob: input.lastFailingJob,
    lastLocalCommand: input.lastLocalCommand,
    terminal: input.terminal,
    terminalReason: input.terminalReason,
    terminalAttempts: input.terminalAttempts,
    terminalHeadSha: input.terminalHeadSha,
    lastTerminalAt: input.terminal ? input.now.toISOString() : undefined,
  };
}

function withClassificationSince(
  prior: ReadyWatchdogStateEntry | undefined,
  entry: ReadyWatchdogStateEntry,
  now: Date,
): ReadyWatchdogStateEntry {
  const unchanged = prior
    && prior.classification === entry.classification
    && typeof prior.classificationSince === 'string'
    && prior.classificationSince.length > 0;

  return {
    ...entry,
    classificationSince: unchanged ? prior.classificationSince : now.toISOString(),
    lastConfirmedAt: now.toISOString(),
  };
}

function buildExhaustedAutoUpdateEntry(
  issueId: string,
  snapshot: ReadyTaskSnapshot,
  githubTruth: GitHubPRTruth,
  attempts: number,
  lastError: string,
  now: Date,
): ReadyWatchdogStateEntry {
  return buildFindingEntry({
    issueId,
    snapshot,
    classification: 'needs-user',
    detail: `Auto-update exhausted after ${attempts} attempts: ${lastError}`,
    action: 'needs-user',
    now,
    githubTruth,
    autoUpdateAttempts: attempts,
    lastAutoUpdateError: lastError,
  });
}

function evaluateVerificationArtifact(snapshot: ReadyTaskSnapshot): 'inactive' | 'fresh' | 'awaiting' {
  if (!snapshot.remediationLaunchHead || !snapshot.currentHead || snapshot.remediationLaunchHead === snapshot.currentHead) {
    return 'inactive';
  }

  const artifactPath = path.join(snapshot.readyStateDir, `.verification-artifact-${snapshot.currentHead}.json`);
  if (!existsSync(artifactPath)) {
    try {
      const protocolPresent = readdirSync(snapshot.readyStateDir)
        .some((entry) => /^\.verification-artifact-.+\.json$/.test(entry));
      return protocolPresent ? 'awaiting' : 'inactive';
    } catch {
      return 'inactive';
    }
  }

  try {
    const parsed = JSON.parse(readFileSync(artifactPath, 'utf-8')) as Record<string, unknown>;
    const artifactHead = typeof parsed.headSha === 'string'
      ? parsed.headSha
      : typeof parsed.head === 'string'
        ? parsed.head
        : null;
    const timestamp = typeof parsed.timestamp === 'string'
      ? parsed.timestamp
      : typeof parsed.createdAt === 'string'
        ? parsed.createdAt
        : null;
    const artifactTime = parseIsoDate(timestamp);
    const pushTime = parseIsoDate(snapshot.readyResult?.startedAt ?? null);
    if (artifactHead && artifactHead !== snapshot.currentHead) {
      return 'awaiting';
    }
    if (pushTime && artifactTime && artifactTime < pushTime) {
      return 'awaiting';
    }
    return 'fresh';
  } catch {
    return 'awaiting';
  }
}

function buildRemediationPayloadSummary(classification: ReadyWatchdogClassification, fallbackSummary: string): string {
  if (classification.ciFailureCategory !== 'deterministic-local') {
    return fallbackSummary;
  }

  const parts = [
    fallbackSummary,
    `category: deterministic-local`,
    classification.failingJob ? `failingJob: ${classification.failingJob}` : '',
    classification.localCommand ? `localCommand: ${classification.localCommand}` : '',
    classification.logExcerpt ? `logExcerpt:\n${classification.logExcerpt}` : '',
  ].filter(Boolean);
  return parts.join('\n');
}

/** Classify a failure for reconciliation purposes (REQ-F3: distinct categories for retry/LLM decisions). */
export function classifyForReconciliation(options: {
  mergeStatus?: string;
  failedCheckSummary?: string;
  checksRun?: number;
  checksPassed?: number;
}): 'stale_base_clean' | 'ci_transient' | 'ci_deterministic_safe' | 'merge_conflict' | 'ambiguous' {
  const { mergeStatus, failedCheckSummary = '', checksRun = 0, checksPassed = 0 } = options;

  if (mergeStatus === 'CONFLICTED') {
    return 'merge_conflict';
  }

  if (!failedCheckSummary || checksRun === 0) {
    return 'stale_base_clean';
  }

  const summary = failedCheckSummary.toLowerCase();
  if (
    summary.includes('timeout') ||
    summary.includes('transient') ||
    summary.includes('temporary') ||
    summary.includes('intermittent')
  ) {
    return 'ci_transient';
  }

  if (summary.includes('conflicted') || summary.includes('merge')) {
    return 'merge_conflict';
  }

  if (checksRun > 0 && checksPassed < checksRun) {
    return 'ci_deterministic_safe';
  }

  return 'ambiguous';
}

/** Emit a ready-phase trace event from the feature directory — best-effort, never throws. */
function emitReadyTraceEvent(
  featureDir: string,
  event: 'check_passed' | 'check_failed' | 'remediation_started' | 'remediation_completed',
  status: 'ok' | 'failed',
  meta?: Record<string, unknown>,
): void {
  const ctx = loadTraceContext(featureDir);
  if (!ctx) {
    return;
  }
  appendTraceEvent(ctx, { phase: 'ready', event, status, meta }).catch(() => undefined);
}

export async function tickReadyWatchdog(options: TickReadyWatchdogOptions): Promise<TickReadyWatchdogResult> {
  const deps: ReadyWatchdogDeps = {
    ...defaultDeps,
    ...(options.deps ?? {}),
  };
  const now = deps.now();
  // HOK-3101: session id used by the shared task-progress primitive to
  // resolve per-task hook and status file paths.
  const session = options.session ?? process.env.WAVEMILL_SESSION ?? 'wavemill';
  const config = {
    ...getReadyWatchdogConfig(options.repoDir),
    ...(options.config ?? {}),
  };
  const newFindings: ReadyWatchdogStateEntry[] = [];
  const reaped: ReadyWatchdogReapedEntry[] = [];

  if (!config.enabled && !options.forceRecover) {
    await writeStateFile(options.repoDir, [], now);
    return { updatedAt: now.toISOString(), findings: newFindings, reaped };
  }

  const priorState = await loadPriorWatchdogState(options.repoDir);
  const priorTasks = priorState?.tasks ?? {};
  const nextTasks = { ...priorTasks };
  const remediationConfig = getReadyRemediationConfig(options.repoDir);
  const failureClassifierConfig = getReadyFailureClassifierConfig(options.repoDir);
  const verificationConfig = getReadyVerificationConfig(options.repoDir);
  // HOK-3102: BEHIND → auto-update is merge-lane prep. Skip it when no tend
  // is running (mergeExecutor !== 'tend').
  let mergeLaneActive = true;
  try {
    mergeLaneActive = resolveSessionCapabilities(options.repoDir, { readHealth: false }).mergeExecutor === 'tend';
  } catch {
    // If the resolver fails, keep pre-3102 behavior (mergeLaneActive=true).
  }
  const readyWatchdogToolPath = options.readyWatchdogToolPath ?? READY_WATCHDOG_TOOL_PATH;
  const workflowState = await deps.readWorkflowState(options.stateFile);
  const tasks = workflowState.tasks ?? {};
  const jobs = normalizeJobs(workflowState);
  const activeReadyIssueIds = new Set<string>();
  const inactiveReasons = new Map<string, ReadyWatchdogReapReason>();
  const reapTask = (issueId: string, reason: ReadyWatchdogReapReason): void => {
    const priorEntry = nextTasks[issueId];
    if (priorEntry) {
      reaped.push(buildReapedEntry(priorEntry, reason));
      delete nextTasks[issueId];
    }
  };

  // Load challenge gate data once per tick so classifyReadyTask can detect
  // challenge PRs that tend would block even when GitHub shows them as clean/green.
  const challengeWorkflowState = loadWorkflowStateChallengeData(options.repoDir);
  const challengePairMap = challengeWorkflowState.challengePairMap;
  const challengeEvalRetryMax = getChallengeEvalHardFailureRetryMaxAttempts(options.repoDir);
  const remoteTaskBranches = new Set(
    Object.values(tasks).some((task) => typeof (task as WorkflowTaskRecord).challengePairId === 'string')
      ? listRemoteTaskBranches(options.repoDir)
      : [],
  );
  let tickChallengeComparisons: StoredChallengeComparison[] = [];
  try {
    tickChallengeComparisons = readChallengeComparisons(path.join(options.repoDir, '.wavemill', 'evals'));
  } catch {
    // Missing or unreadable file: treat as no comparisons — consistent with tend behavior.
  }

  // Build the set of all ready-phase PR numbers for challenge gate "other PR" resolution.
  const allReadyPrNumbers = new Set<number>();
  for (const rawTask of Object.values(tasks)) {
    const t = rawTask as WorkflowTaskRecord;
    if (t.phase === 'ready') {
      const pr = Number(t.pr);
      if (Number.isFinite(pr) && pr > 0) {
        allReadyPrNumbers.add(pr);
      }
    }
  }

  for (const [issueId, rawTask] of Object.entries(tasks)) {
    const task = rawTask as WorkflowTaskRecord;
    if (task.phase !== 'ready') {
      if (!options.issueFilter) {
        inactiveReasons.set(issueId, 'non-ready');
        reapTask(issueId, 'non-ready');
      }
      continue;
    }
    if (task.status === 'merged' || task.status === 'completed-external') {
      if (!options.issueFilter) {
        inactiveReasons.set(issueId, 'terminal');
        reapTask(issueId, 'terminal');
      }
      continue;
    }
    if (options.issueFilter && issueId !== options.issueFilter) {
      continue;
    }

    activeReadyIssueIds.add(issueId);

    const snapshot = await buildSnapshot(issueId, task, jobs, now, options.repoDir, deps, session);
    if (!snapshot) {
      reapTask(issueId, 'invalid-task');
      continue;
    }

    let githubTruth: GitHubPRTruth | null = null;
    let classification: ReadyWatchdogClassification | null = null;
    const prior = priorTasks[issueId];

    if (verificationConfig.gatingEnabled) {
      const verificationState = evaluateVerificationArtifact(snapshot);
      if (verificationState === 'awaiting') {
        let entry = buildFindingEntry({
          issueId,
          snapshot,
          classification: 'waiting-on-ci',
          detail: `Awaiting fresh controller verification artifact for head ${snapshot.currentHead ?? 'unknown'} before polling CI again after remediation.`,
          action: 'awaiting-verification',
          now,
          lastCiFailureCategory: prior?.lastCiFailureCategory,
          lastFailingJob: prior?.lastFailingJob,
          lastLocalCommand: prior?.lastLocalCommand,
        });
        entry = withClassificationSince(prior, entry, now);
        if (shouldEmitReadyWatchdogFinding(prior, entry, now, getReportIntervalSeconds())) {
          entry = {
            ...entry,
            lastLoggedAt: now.toISOString(),
            lastLoggedFingerprint: entry.detailFingerprint,
            lastLoggedClassification: entry.classification,
            lastLoggedAction: entry.action,
          };
          newFindings.push(entry);
          await writeAuditRecord(options.repoDir, {
            timestamp: now.toISOString(),
            taskId: issueId,
            slug: snapshot.slug,
            prNumber: snapshot.prNumber,
            classification: entry.classification,
            action: entry.action,
            detail: entry.detail,
            recoveryCommand: entry.recoveryCommand,
          });
        } else {
          entry = {
            ...entry,
            lastLoggedAt: prior?.lastLoggedAt,
            lastLoggedFingerprint: prior?.lastLoggedFingerprint,
            lastLoggedClassification: prior?.lastLoggedClassification,
            lastLoggedAction: prior?.lastLoggedAction,
          };
        }
        nextTasks[issueId] = entry;
        continue;
      }
    }

    // Compute the challenge gate for this PR if it has a challenge pair. Passes null
    // for PR metadata because workflow-state challenge pairs are sufficient to detect
    // the pair-unresolved:no-comparison case that the watchdog needs to surface.
    const siblingLiveness = snapshot.challengePairId
      ? evaluateSiblingLiveness({
          repoDir: options.repoDir,
          hasSiblingBranch: Boolean(
            getSiblingBranch(snapshot.branch) && remoteTaskBranches.has(getSiblingBranch(snapshot.branch) as string),
          ),
          openPrNumbers: allReadyPrNumbers,
          pairState: challengeWorkflowState.taskStateByPair.get(snapshot.challengePairId),
          side: challengePairMap.get(snapshot.prNumber)?.role ?? 'primary',
          nowMs: now.getTime(),
          getSiblingProgress: (repoDir, sibling, probeNow) => deps.getSiblingProgress(repoDir, sibling, probeNow, session),
        })
      : undefined;
    const challengeGate: ChallengeGate | undefined = snapshot.challengePairId
      ? classifyChallengeState(
          snapshot.prNumber,
          null,
          challengePairMap,
          tickChallengeComparisons,
          true,
          allReadyPrNumbers,
          {
            activeJobsByPair: challengeWorkflowState.activeJobsByPair,
            taskStateByPair: challengeWorkflowState.taskStateByPair,
            evalHardFailureRetryMax: challengeEvalRetryMax,
            siblingLive: siblingLiveness?.live ?? false,
            siblingStalled: siblingLiveness?.stalled ?? false,
            nowMs: () => now.getTime(),
          },
        )
      : undefined;

    try {
      githubTruth = await deps.fetchGitHubTruth(snapshot.prNumber, options.repoDir);
      if (githubTruth.checks.some((check) => check.status === 'failure')) {
        try {
          githubTruth = {
            ...githubTruth,
            checks: await deps.enrichFailingChecks(githubTruth.checks, {
              repoDir: options.repoDir,
              maxBytes: failureClassifierConfig.remediationLogMaxBytes,
            }),
          };
        } catch {
          // Log enrichment is best-effort; classification can still proceed with
          // the statusCheckRollup fields GitHub already returned.
        }
      }
      if (isUnconfirmedGitHubTruth(githubTruth)) {
        if (prior && unconfirmedEntryExpired(prior, now)) {
          reapTask(issueId, 'unconfirmed-expired');
        }
        continue;
      }
      classification = classifyReadyTask(
        snapshot,
        githubTruth,
        now,
        {
          ...config,
          localCommandMap: failureClassifierConfig.localCommandMap,
          remediationLogMaxBytes: failureClassifierConfig.remediationLogMaxBytes,
          mergeLaneActive,
        },
        prior,
        challengeGate,
      );
    } catch {
      if (prior && unconfirmedEntryExpired(prior, now)) {
        reapTask(issueId, 'unconfirmed-expired');
      }
      continue;
    }

    if (!classification) {
      continue;
    }

    const failingChecksFingerprint = buildFailingChecksFingerprint(githubTruth?.checks ?? []);
    const failingChecksObservedCount = failingChecksFingerprint
      ? prior?.failingChecksFingerprint === failingChecksFingerprint
        ? (prior.failingChecksObservedCount ?? 0) + 1
        : 1
      : 0;
    if (classification.kind === 'fresh') {
      reapTask(issueId, 'resolved');
      continue;
    }

    let entry: ReadyWatchdogStateEntry | null = null;

    if (classification.kind === 'auto-update' && githubTruth) {
      const attempts = prior?.autoUpdateAttempts ?? 0;
      const lastError = prior?.lastAutoUpdateError;

      if (attempts >= MAX_AUTO_UPDATE_ATTEMPTS && lastError) {
        entry = buildExhaustedAutoUpdateEntry(
          issueId,
          snapshot,
          githubTruth,
          attempts,
          lastError,
          now,
        );
      } else {
        const updateResult = await deps.updateBehindBranch(snapshot, githubTruth, options.repoDir);
        if (updateResult.status === 'success') {
          await recoverReadyState(
            snapshot,
            githubTruth,
            options.stateFile,
            deps,
            'Ready watchdog updated the PR branch with the latest base and queued a re-check.',
          );
          reapTask(issueId, 'resolved');
          continue;
        }

        const nextAttempts = attempts + 1;
        if (updateResult.status === 'conflict' || updateResult.status === 'dirty-worktree') {
          entry = buildFindingEntry({
            issueId,
            snapshot,
            classification: 'needs-user',
            detail: `Auto-update could not proceed for PR #${snapshot.prNumber}: ${updateResult.detail}`,
            action: 'needs-user',
            now,
            githubTruth,
            autoUpdateAttempts: nextAttempts,
            lastAutoUpdateError: updateResult.detail,
          });
        } else if (nextAttempts >= MAX_AUTO_UPDATE_ATTEMPTS) {
          entry = buildExhaustedAutoUpdateEntry(
            issueId,
            snapshot,
            githubTruth,
            nextAttempts,
            updateResult.detail,
            now,
          );
        } else {
          entry = buildFindingEntry({
            issueId,
            snapshot,
            classification: 'auto-update',
            detail: `Auto-update attempt ${nextAttempts}/${MAX_AUTO_UPDATE_ATTEMPTS} failed for PR #${snapshot.prNumber}: ${updateResult.detail}`,
            action: 'auto-update-failed',
            now,
            githubTruth,
            autoUpdateAttempts: nextAttempts,
            lastAutoUpdateError: updateResult.detail,
          });
        }
      }
    } else if (classification.kind === 'disconnected-remediation' && githubTruth) {
      const resumeResult = await deps.resumeResolvedConflictRemediation(snapshot, githubTruth, options.repoDir);
      if (resumeResult.status === 'completed') {
        await recoverReadyState(
          snapshot,
          githubTruth,
          options.stateFile,
          deps,
          `${resumeResult.detail} Ready checks will be re-polled.`,
        );
        entry = buildFindingEntry({
          issueId,
          snapshot,
          classification: 'disconnected-remediation',
          detail: resumeResult.detail,
          action: 'completed-conflict-remediation',
          now,
          githubTruth,
        });
      } else {
        const detail = `${resumeResult.detail}. Git state: ${summarizeMergeState(snapshot.worktreeMergeState)}. Next command: ${nextCommandForMergeState(snapshot)}`;
        await writeReadyAttention(snapshot, detail);
        entry = buildFindingEntry({
          issueId,
          snapshot,
          classification: 'needs-user',
          detail,
          action: 'needs-user',
          now,
          githubTruth,
        });
      }
    } else {
      let action = 'reported';
      let recoveryCommand = classification.recoveryCommand;
      if (classification.kind === 'needs-user' && disconnectedMergeResidueDetected(snapshot)) {
        await writeReadyAttention(snapshot, classification.detail);
        action = 'needs-user';
      }
      if (
        (classification.kind === 'waiting-on-ci' || classification.kind === 'stable-failing-safe')
        && githubTruth
      ) {
        if (classification.ciFailureCategory === 'transient-infra') {
          const sameTransientHead = prior?.transientFailureHead === snapshot.currentHead
            && prior?.lastCiFailureCategory === 'transient-infra';
          const transientFailureCount = sameTransientHead ? (prior?.transientFailureCount ?? 0) + 1 : 1;
          if (transientFailureCount <= failureClassifierConfig.transientRetryBudget) {
            action = 'waiting-on-ci-transient';
            classification = {
              ...classification,
              detail: `${classification.detail} Retrying without remediation (${transientFailureCount}/${failureClassifierConfig.transientRetryBudget}).`,
            };
          } else {
            action = 'transient-retry-exhausted';
            classification = {
              ...classification,
              kind: 'needs-user',
              detail: `Transient CI failure budget exhausted after ${transientFailureCount - 1}/${failureClassifierConfig.transientRetryBudget} retries for PR #${snapshot.prNumber}: ${classification.detail}`,
            };
            await writeReadyAttention(snapshot, classification.detail);
          }
        } else if (classification.ciFailureCategory === 'deterministic-local') {
          const attempts = snapshot.readyArtifacts?.remediationAttempts ?? 0;
          if (failingChecksObservedCount < FAILING_CHECK_STABILITY_THRESHOLD) {
            action = 'waiting-on-ci-stabilizing';
            classification = {
              ...classification,
              detail: `Failing checks remain unstable (${failingChecksObservedCount}/${FAILING_CHECK_STABILITY_THRESHOLD}): ${classification.detail}`,
            };
          } else if (!remediationConfig.enabled) {
            action = 'reported';
          } else if (attempts >= remediationConfig.maxAttempts) {
            action = 'remediation-exhausted';
            classification = {
              ...classification,
              detail: `Ready remediation capped at ${attempts}/${remediationConfig.maxAttempts} attempts for PR #${snapshot.prNumber}.`,
            };
            await writeReadyAttention(snapshot, classification.detail);
          } else if (
            snapshot.remediationLaunchHead
            && snapshot.currentHead
            && snapshot.remediationLaunchHead === snapshot.currentHead
          ) {
            action = 'remediation-in-flight';
            classification = {
              ...classification,
              detail: `Ready remediation is already running for PR #${snapshot.prNumber} at ${snapshot.currentHead}.`,
            };
          } else {
            const checkSummary = summarizeChecks(githubTruth.checks);
            const failedCheckNames = githubTruth.checks
              .filter((check) => check.status === 'failure')
              .map((check) => check.name);
            const failedCheckSummary = buildRemediationPayloadSummary(
              classification,
              checkSummary.failures.join(', '),
            );
            const launchResult = await deps.launchReadyRemediation(
              snapshot,
              failedCheckSummary,
              failedCheckNames,
              attempts + 1,
              remediationConfig.maxAttempts,
              options.repoDir,
              readyWatchdogToolPath,
            );

            if (launchResult.status === 'launched') {
              action = 'launched-remediation';
            } else if (launchResult.status === 'skipped-in-flight') {
              action = 'remediation-in-flight';
            } else if (launchResult.status === 'skipped-backoff') {
              action = 'remediation-backoff';
            } else if (launchResult.status === 'skipped-max-attempts') {
              action = 'remediation-exhausted';
            } else {
              action = 'remediation-launch-failed';
            }

            classification = {
              ...classification,
              detail: launchResult.detail,
            };
          }
        }
      } else if (classification.kind === 'stuck') {
        recoveryCommand = makeRecoveryCommand(options.repoDir, options.stateFile, issueId, readyWatchdogToolPath);
        const canRecover = (options.forceRecover || config.autoRecover)
          && classification.autoRecoverable
          && githubTruth !== null;

        if (canRecover && githubTruth) {
          await recoverReadyState(snapshot, githubTruth, options.stateFile, deps);
          action = options.forceRecover ? 'manual-recovery' : 'auto-recovered';
        } else {
          action = 'recovery-command';
        }
      }

      entry = buildFindingEntry({
        issueId,
        snapshot,
        classification: classification.kind,
        detail: classification.detail,
        action,
        now,
        recoveryCommand,
        githubTruth,
        remediationCategories: classification.remediationCategories,
        consecutiveFailurePolls: classification.consecutiveFailurePolls,
        failingChecksFingerprint,
        failingChecksObservedCount,
        transientFailureCount: classification.ciFailureCategory === 'transient-infra'
          ? (action === 'waiting-on-ci-transient' || action === 'transient-retry-exhausted'
              ? (prior?.transientFailureHead === snapshot.currentHead && prior?.lastCiFailureCategory === 'transient-infra'
                  ? (prior?.transientFailureCount ?? 0) + 1
                  : 1)
              : prior?.transientFailureCount)
          : undefined,
        transientFailureHead: classification.ciFailureCategory === 'transient-infra' ? snapshot.currentHead ?? undefined : undefined,
        lastCiFailureCategory: classification.ciFailureCategory,
        lastFailingJob: classification.failingJob,
        lastLocalCommand: classification.localCommand,
        terminal: action === 'remediation-exhausted',
        terminalReason: action === 'remediation-exhausted' ? 'remediation-attempts-exhausted' : undefined,
        terminalAttempts: action === 'remediation-exhausted' ? snapshot.readyArtifacts?.remediationAttempts ?? 0 : undefined,
        terminalHeadSha: action === 'remediation-exhausted' ? snapshot.currentHead : undefined,
      });
    }

    if (!entry) {
      continue;
    }

    entry = withClassificationSince(prior, entry, now);
    const reportIntervalSeconds = getReportIntervalSeconds();
    if (shouldEmitReadyWatchdogFinding(prior, entry, now, reportIntervalSeconds)) {
      entry = {
        ...entry,
        lastLoggedAt: now.toISOString(),
        lastLoggedFingerprint: entry.detailFingerprint,
        lastLoggedClassification: entry.classification,
        lastLoggedAction: entry.action,
      };
      newFindings.push(entry);
      await writeAuditRecord(options.repoDir, {
        timestamp: now.toISOString(),
        taskId: issueId,
        slug: snapshot.slug,
        prNumber: snapshot.prNumber,
        classification: entry.classification,
        action: entry.action,
        detail: entry.detail,
        recoveryCommand: entry.recoveryCommand,
      });

      // Emit trace events for emitted findings (HOK-2259) — best-effort
      const traceAction = entry.action;
      const traceKind = entry.classification;
      const traceMeta = { prNumber: snapshot.prNumber, slug: snapshot.slug, detail: entry.detail };
      if (traceAction === 'launched-remediation') {
        emitReadyTraceEvent(snapshot.readyStateDir, 'remediation_started', 'ok', traceMeta);
      } else if (traceKind === 'waiting-on-merge-lane') {
        emitReadyTraceEvent(snapshot.readyStateDir, 'check_passed', 'ok', traceMeta);
      } else if (
        traceAction === 'remediation-exhausted'
        || (traceKind === 'needs-user' && prior?.classification === 'waiting-on-ci')
      ) {
        emitReadyTraceEvent(snapshot.readyStateDir, 'remediation_completed', 'failed', traceMeta);
      } else if (traceKind === 'needs-user' || traceAction === 'reported') {
        emitReadyTraceEvent(snapshot.readyStateDir, 'check_failed', 'failed', {
          ...traceMeta,
          classification: traceKind,
          action: traceAction,
        });
      }
    } else {
      // Suppressed: carry over lastLogged* fields from prior state so future
      // ticks continue to compare against the last actual emission, not the
      // stale prior-tick snapshot.
      entry = {
        ...entry,
        lastLoggedAt: prior?.lastLoggedAt,
        lastLoggedFingerprint: prior?.lastLoggedFingerprint,
        lastLoggedClassification: prior?.lastLoggedClassification,
        lastLoggedAction: prior?.lastLoggedAction,
      };
    }
    nextTasks[issueId] = entry;
  }

  if (!options.issueFilter) {
    for (const issueId of Object.keys(nextTasks)) {
      if (!activeReadyIssueIds.has(issueId)) {
        reapTask(issueId, inactiveReasons.get(issueId) ?? 'absent-from-workflow');
      }
    }
  }

  await writeStateFile(options.repoDir, Object.values(nextTasks), now);
  return {
    updatedAt: now.toISOString(),
    findings: newFindings,
    reaped,
  };
}
