/**
 * Observer auto-fix engine (HOK-3097).
 *
 * Three narrowly scoped repair actions the observer may apply once an
 * operator opts in per repo:
 *
 *   1. `update-branch-from-base`: when a blocked ready/review task sits
 *      behind its base, merge `origin/<base>` into its worktree branch
 *      (through HOK-3092's {@link updateBranchWithBase}) and push.
 *   2. `reset-ready-budget`: clear the exhausted `failed-ready-recheck` or
 *      `pending-ready-recheck` bounded-retry bucket once the head or base
 *      SHA has changed since the budget ran out.
 *   3. `forfeit-stuck-challenge-arm`: abort a terminally stuck arm whose
 *      sibling has `evalCompleted`, and close its PR, so the pair resolves
 *      as `sibling-challenge-aborted` and the survivor can merge.
 *
 * Every applied, failed, skipped, or planned action is appended as one line
 * to `<incidentStoreDir>/actions.jsonl` (`"kind":"observer-auto-fix"`), so
 * operators can grep the log for a complete history.
 *
 * Every applied fix also emits a `low` finding so the dashboard surfaces it.
 * A skip caused by a dirty tree, a working agent, or an unknown-progress
 * target emits a `medium` finding too.
 *
 * Business logic is injected through {@link AutoFixDeps} so decisions can be
 * unit-tested without real git, gh, or state mutex.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  ObserverAutoFixConfig,
} from './config.ts';
import type { BranchBaseUpdateResult } from './promotion-controller.ts';
import type { WorktreeDirtyStatus } from './worktree-dirty-status.ts';
import type { TaskProgress } from './task-progress.ts';
import type { ReadyArtifacts, StageResult } from './stage-result.ts';
import { isInfrastructureReviewFailure, getResultFilePath } from './stage-result.ts';
import type { StateDirRetry, BoundedRetryDecision } from './bounded-retry.ts';
import { createStateDirRetry } from './bounded-retry.ts';

// ── Public types ────────────────────────────────────────────────────────────

export type AutoFixKind =
  | 'update-branch-from-base'
  | 'reset-ready-budget'
  | 'forfeit-stuck-challenge-arm';

export type AutoFixOutcome = 'applied' | 'skipped' | 'failed' | 'planned';

export type AutoFixSkipReason =
  | 'disabled'
  | 'not-applicable'
  | 'agent-working'
  | 'dirty-tree'
  | 'progress-unknown'
  | 'stage-running'
  | 'retry-budget'
  | 'no-candidate';

export interface AutoFixActionRecord {
  kind: 'observer-auto-fix';
  fix: AutoFixKind;
  outcome: AutoFixOutcome;
  issue: string;
  at: string;
  repoDir: string;
  session?: string;
  reason?: AutoFixSkipReason | string;
  evidence?: string[];
  bucket?: string;
  detail?: string;
  headBefore?: string;
  headAfter?: string;
  baseSha?: string;
  fastForwarded?: boolean;
  prClosed?: boolean;
  conflictingFiles?: string[];
}

export interface AutoFixFinding {
  id: string;
  severity: 'urgent' | 'high' | 'medium' | 'low';
  category: 'operational' | 'stuck' | 'warning';
  confidence: 'high' | 'medium' | 'low';
  session?: string;
  repoDir?: string;
  issue?: string;
  title: string;
  evidence: string[];
  recommendation: string;
}

/** The structural subset of observer `TaskState` the auto-fix engine reads. */
export interface AutoFixTask {
  issue: string;
  slug?: string;
  phase?: string;
  status?: string;
  pr?: string;
  worktree?: string;
  branch?: string;
  baseBranch?: string;
  challengeRole?: string;
  challengePairId?: string;
  challengeAborted?: string;
  evalCompleted?: boolean;
}

/** One observer finding that selects a candidate for auto-fix. */
export interface AutoFixCandidateFinding {
  id: string;
  issue?: string;
  severity: string;
  evidenceKeys?: Record<string, string | undefined>;
}

/** Context the engine needs for one repo pass. */
export interface AutoFixRepoContext {
  repoDir: string;
  session: string;
  /** Workflow state file path (for the forfeit abort writer). */
  workflowStatePath?: string;
  /** Effective base branch per issue (defaults to the task's `baseBranch`). */
  effectiveBaseBranch(task: AutoFixTask): string;
  /** Resolve a per-task state dir (ready-stage sentinels + journal). */
  resolveTaskStateDir(task: AutoFixTask): string | undefined;
  /** Observer-journal path for head-only budgets (default: `.wavemill/observer/auto-fix-state.json`). */
  journalPath?: string;
  /** Incident store directory (default: `.wavemill/incidents`). */
  incidentStoreDir: string;
}

/** Injectable dependencies for testability. */
export interface AutoFixDeps {
  /** Shell command runner. Returns stdout; throws on failure. */
  git(args: string[], cwd: string): string;
  /** gh invoker. Returns `{ ok, stdout, stderr }`. */
  gh(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string };
  /** Update branch with origin/<base>. Reuses HOK-3092. */
  updateBranchWithBase(branch: string, baseBranch: string, worktree: string): BranchBaseUpdateResult;
  /** Read a task's dirty-worktree status (HOK-3088). */
  readWorktreeDirtyStatus(worktree: string): WorktreeDirtyStatus;
  /** HOK-3101 progress primitive; return `undefined` on failure. */
  getProgress(task: AutoFixTask): TaskProgress | undefined;
  /** Workflow-state abort (shared/lib/task-abort.ts). */
  abortTaskInState(stateFile: string, issue: string, reason: string): Promise<void>;
  /** Reusable bounded-retry ops per bucket (defaults use `createStateDirRetry`). */
  retries?: {
    updateBranch?: StateDirRetry;
    resetBudget?: StateDirRetry;
    forfeit?: StateDirRetry;
  };
}

/** Options for `runObserverAutoFixes`. */
export interface RunAutoFixOptions {
  repo: AutoFixRepoContext;
  tasks: AutoFixTask[];
  findings: AutoFixCandidateFinding[];
  config: ObserverAutoFixConfig;
  deps: AutoFixDeps;
  now: Date;
  dryRun?: boolean;
}

export interface AutoFixRunResult {
  records: AutoFixActionRecord[];
  findings: AutoFixFinding[];
}

// ── Precondition gate ───────────────────────────────────────────────────────

/** The buckets reset-ready-budget targets. */
export const READY_RECHECK_BUCKETS = ['failed-ready-recheck', 'pending-ready-recheck'] as const;

export type ReadyRecheckBucket = typeof READY_RECHECK_BUCKETS[number];

export interface PreconditionResult {
  ok: boolean;
  reason?: AutoFixSkipReason;
  evidence: string[];
}

const DIRTY_WORKTREE_PATH_LIMIT = 8;

function dirtyEvidenceLines(status: WorktreeDirtyStatus): string[] {
  if (status.state === 'clean' || status.state === 'absent') return [];
  if (status.state === 'unreadable') return ['worktreeDirty=unreadable'];
  const shown = status.lines.slice(0, DIRTY_WORKTREE_PATH_LIMIT);
  const evidence: string[] = [
    'worktreeDirty=true',
    `dirtyPathCount=${status.lines.length}`,
    ...shown.map((line) => `dirtyPath=${line}`),
  ];
  if (status.lines.length > shown.length) {
    evidence.push(`dirtyPathTruncated=${status.lines.length - shown.length}`);
  }
  return evidence;
}

function readReadyArtifacts(stateDir: string): { artifacts: ReadyArtifacts; status: string } | undefined {
  const path = getResultFilePath(stateDir, 'ready');
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StageResult> | null;
    if (!parsed || typeof parsed !== 'object' || parsed.stage !== 'ready') return undefined;
    const artifacts = parsed.artifacts as ReadyArtifacts | undefined;
    if (!artifacts || typeof artifacts !== 'object' || artifacts.type !== 'ready') return undefined;
    return { artifacts, status: parsed.status ?? '' };
  } catch {
    return undefined;
  }
}

/** D2: shared precondition gate; applied to every mutating fix. */
export function checkAutoFixPreconditions(
  task: AutoFixTask,
  deps: AutoFixDeps,
  stateDir: string | undefined,
): PreconditionResult {
  if (!task.worktree) {
    return { ok: false, reason: 'not-applicable', evidence: ['worktree=none'] };
  }
  if (!task.branch) {
    return { ok: false, reason: 'not-applicable', evidence: ['branch=none'] };
  }
  if (task.phase === 'aborted' || task.status === 'aborted') {
    return { ok: false, reason: 'not-applicable', evidence: [`phase=${task.phase ?? ''}`, `status=${task.status ?? ''}`] };
  }

  // HOK-3101 progress primitive.
  const progress = deps.getProgress(task);
  if (!progress) {
    return { ok: false, reason: 'progress-unknown', evidence: ['progress=unknown'] };
  }
  if (progress.agentState === 'working'
    || progress.agentBackgroundLive === true
    || (progress.agentRecord?.state === 'working')
    || progress.blockingPrompt) {
    return {
      ok: false,
      reason: 'agent-working',
      evidence: [
        `agentState=${progress.agentState ?? 'unknown'}`,
        `agentBackgroundLive=${progress.agentBackgroundLive ?? 'unknown'}`,
        progress.blockingPrompt ? `blockingPrompt=${progress.blockingPrompt.id}` : 'blockingPrompt=none',
      ],
    };
  }

  // HOK-3088 at-risk predicate: unreadable / dirty / absent all skip.
  const dirty = deps.readWorktreeDirtyStatus(task.worktree);
  if (dirty.state !== 'clean') {
    return { ok: false, reason: 'dirty-tree', evidence: dirtyEvidenceLines(dirty) };
  }

  // Avoid racing an in-flight ready stage.
  if (stateDir) {
    const ready = readReadyArtifacts(stateDir);
    if (ready && ready.status === 'running') {
      return { ok: false, reason: 'stage-running', evidence: [`readyStageStatus=running`] };
    }
  }

  return { ok: true, evidence: [] };
}

// ── Candidate selection ─────────────────────────────────────────────────────

function findingAgeMinutes(stateDir: string | undefined, nowMs: number): number | undefined {
  if (!stateDir) return undefined;
  const readyPath = getResultFilePath(stateDir, 'ready');
  if (!existsSync(readyPath)) return undefined;
  try {
    const stat = statSync(readyPath);
    return (nowMs - stat.mtimeMs) / 60_000;
  } catch {
    return undefined;
  }
}

function retentinelMtimeMs(stateDir: string | undefined, bucket: string): number | undefined {
  if (!stateDir) return undefined;
  const name = bucket === 'failed-ready-recheck'
    ? '.failed-ready-recheck-exhausted'
    : `.retry-${bucket}-exhausted`;
  const path = join(stateDir, name);
  if (!existsSync(path)) return undefined;
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

function readyStageIsBlocked(stateDir: string | undefined): boolean {
  if (!stateDir) return false;
  const ready = readReadyArtifacts(stateDir);
  if (!ready) return false;
  return ready.status === 'failed' || ready.status === 'awaiting_user';
}

function reviewFailedWithInfra(stateDir: string | undefined): boolean {
  if (!stateDir) return false;
  const path = getResultFilePath(stateDir, 'review');
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as StageResult | null;
    if (!parsed || parsed.stage !== 'review') return false;
    return isInfrastructureReviewFailure(parsed);
  } catch {
    return false;
  }
}

function tryGit(deps: AutoFixDeps, args: string[], cwd: string): string | undefined {
  try {
    return deps.git(args, cwd).trim();
  } catch {
    return undefined;
  }
}

function worktreeHead(deps: AutoFixDeps, worktree: string): string | undefined {
  return tryGit(deps, ['-C', worktree, 'rev-parse', 'HEAD'], worktree);
}

function remoteBaseSha(deps: AutoFixDeps, worktree: string, baseBranch: string): string | undefined {
  return tryGit(deps, ['-C', worktree, 'rev-parse', `origin/${baseBranch}`], worktree);
}

function remoteBranchSha(deps: AutoFixDeps, worktree: string, branch: string): string | undefined {
  return tryGit(deps, ['-C', worktree, 'rev-parse', `origin/${branch}`], worktree);
}

function remoteBranchIsAheadOfLocal(
  deps: AutoFixDeps,
  worktree: string,
  branch: string,
): boolean {
  const head = worktreeHead(deps, worktree);
  const remote = remoteBranchSha(deps, worktree, branch);
  if (!head || !remote || head === remote) return false;
  // HEAD is an ancestor of origin/<branch> → ff is possible.
  try {
    deps.git(
      ['-C', worktree, 'merge-base', '--is-ancestor', 'HEAD', `origin/${branch}`],
      worktree,
    );
    return true;
  } catch {
    return false;
  }
}

function behindBaseCount(
  deps: AutoFixDeps,
  worktree: string,
  branch: string,
  base: string,
): number | undefined {
  const raw = tryGit(deps, ['-C', worktree, 'rev-list', '--count', `${branch}..origin/${base}`], worktree);
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

// ── Journal for head-only reset candidates ──────────────────────────────────

interface AutoFixJournalEntry {
  baseSha: string;
  seenAt: string;
  sentinelMtime: number;
}

interface AutoFixJournal {
  resetReadyBudget?: Record<string, AutoFixJournalEntry>;
}

function journalKey(stateDir: string, bucket: string): string {
  return `${stateDir}|${bucket}`;
}

async function recordJournalBaseline(
  deps: AutoFixDeps,
  journalPath: string,
  key: string,
  entry: AutoFixJournalEntry,
): Promise<void> {
  // Lazy import to avoid pulling node:fs/fsync details into tests.
  const { mutateJsonStateSync } = await import('./state-mutex.ts');
  try {
    mutateJsonStateSync<AutoFixJournal>(
      journalPath,
      (current) => {
        const next: AutoFixJournal = current ?? {};
        const bucket = { ...(next.resetReadyBudget ?? {}) };
        if (!bucket[key] || bucket[key].sentinelMtime !== entry.sentinelMtime) {
          bucket[key] = entry;
        }
        next.resetReadyBudget = bucket;
        return next;
      },
      { createIfMissing: true, initial: {} as AutoFixJournal },
    );
  } catch {
    // Journal write failure costs only this cycle (D4).
  }
}

function readJournalEntry(
  journalPath: string,
  key: string,
): AutoFixJournalEntry | undefined {
  if (!existsSync(journalPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(journalPath, 'utf8')) as AutoFixJournal | null;
    return parsed?.resetReadyBudget?.[key];
  } catch {
    return undefined;
  }
}

// ── Action record log ───────────────────────────────────────────────────────

function appendActionRecord(dir: string, record: AutoFixActionRecord): void {
  try {
    mkdirSync(dir, { recursive: true });
    const line = `${JSON.stringify(record)}\n`;
    appendFileSync(join(dir, 'actions.jsonl'), line, { encoding: 'utf8' });
  } catch {
    // Logging must never fail the pass.
  }
}

export function appendAutoFixActionRecords(dir: string, records: AutoFixActionRecord[]): void {
  for (const record of records) appendActionRecord(dir, record);
}

// ── Fix: update-branch-from-base ────────────────────────────────────────────

interface UpdateBranchCandidate {
  mode: 'merge-base' | 'ff-only';
  task: AutoFixTask;
  stateDir: string | undefined;
  base: string;
  behindBase?: number;
  headBefore: string;
  baseSha?: string;
}

function pickUpdateBranchCandidate(
  task: AutoFixTask,
  findings: AutoFixCandidateFinding[],
  context: AutoFixRepoContext,
  deps: AutoFixDeps,
  config: ObserverAutoFixConfig,
  nowMs: number,
): UpdateBranchCandidate | undefined {
  if (!task.worktree || !task.branch) return undefined;
  const stateDir = context.resolveTaskStateDir(task);
  const base = context.effectiveBaseBranch(task);
  if (!base) return undefined;

  const applicablePhase = task.phase === 'ready' || task.phase === 'review';
  if (!applicablePhase) return undefined;

  const headBefore = worktreeHead(deps, task.worktree);
  if (!headBefore) return undefined;

  // Fast-forward mode: origin/<branch> is strictly ahead of local HEAD.
  if (remoteBranchIsAheadOfLocal(deps, task.worktree, task.branch)) {
    return {
      mode: 'ff-only',
      task,
      stateDir,
      base,
      headBefore,
    };
  }

  // Candidate from a finding + quietMinutes gate.
  const hasBehindBaseFinding = findings.some((f) => f.issue === task.issue && f.id.startsWith('branch-behind-base-'));
  const hasExhaustedRetry = findings.some((f) => f.issue === task.issue && f.id.startsWith('exhausted-retry-abandoned-'));
  const hasReviewInfra = reviewFailedWithInfra(stateDir);
  const blockedByReady = readyStageIsBlocked(stateDir);
  const findingAge = findingAgeMinutes(stateDir, nowMs);

  if (!hasBehindBaseFinding && !hasExhaustedRetry && !hasReviewInfra && !blockedByReady) return undefined;
  if (findingAge !== undefined && findingAge < config.quietMinutes) return undefined;

  const behind = behindBaseCount(deps, task.worktree, task.branch, base);
  if (behind === undefined || behind < 1) return undefined;
  const baseSha = remoteBaseSha(deps, task.worktree, base);
  return {
    mode: 'merge-base',
    task,
    stateDir,
    base,
    behindBase: behind,
    headBefore,
    baseSha,
  };
}

function applyFfOnly(
  candidate: UpdateBranchCandidate,
  deps: AutoFixDeps,
  context: AutoFixRepoContext,
  now: Date,
  dryRun: boolean,
): { record: AutoFixActionRecord; finding?: AutoFixFinding } {
  const task = candidate.task;
  const base: Omit<AutoFixActionRecord, 'outcome' | 'reason'> = {
    kind: 'observer-auto-fix',
    fix: 'update-branch-from-base',
    issue: task.issue,
    at: now.toISOString(),
    repoDir: context.repoDir,
    session: context.session,
    detail: 'ff-only (origin/branch ahead of worktree HEAD)',
    headBefore: candidate.headBefore,
  };

  if (dryRun) {
    return {
      record: { ...base, outcome: 'planned', reason: 'dry-run' },
    };
  }

  try {
    deps.git(
      ['-C', task.worktree!, 'merge', '--ff-only', `origin/${task.branch!}`],
      task.worktree!,
    );
  } catch (err) {
    return {
      record: { ...base, outcome: 'failed', reason: (err as Error).message },
      finding: {
        id: `observer-auto-fix-failed-update-branch-from-base-${task.issue}`,
        severity: 'high',
        category: 'operational',
        confidence: 'high',
        session: context.session,
        repoDir: context.repoDir,
        issue: task.issue,
        title: `${task.issue} fast-forward from origin/${task.branch} failed`,
        evidence: [`error=${(err as Error).message}`, `branch=${task.branch ?? 'unknown'}`],
        recommendation: 'Inspect the worktree and reconcile origin/<branch> with the local branch manually.',
      },
    };
  }

  const headAfter = worktreeHead(deps, task.worktree!) ?? '';
  return {
    record: { ...base, outcome: 'applied', headAfter, fastForwarded: true },
    finding: {
      id: `observer-auto-fix-applied-update-branch-from-base-${task.issue}-${headAfter.slice(0, 7)}`,
      severity: 'low',
      category: 'operational',
      confidence: 'high',
      session: context.session,
      repoDir: context.repoDir,
      issue: task.issue,
      title: `${task.issue} worktree fast-forwarded to origin/${task.branch}`,
      evidence: [`headBefore=${candidate.headBefore}`, `headAfter=${headAfter}`, `mode=ff-only`],
      recommendation: 'No action needed; observer auto-fix log is in .wavemill/incidents/actions.jsonl.',
    },
  };
}

function applyUpdateBranchMerge(
  candidate: UpdateBranchCandidate,
  deps: AutoFixDeps,
  context: AutoFixRepoContext,
  retry: StateDirRetry,
  config: ObserverAutoFixConfig,
  now: Date,
  dryRun: boolean,
): { record: AutoFixActionRecord; finding?: AutoFixFinding } {
  const task = candidate.task;
  const base: Omit<AutoFixActionRecord, 'outcome' | 'reason'> = {
    kind: 'observer-auto-fix',
    fix: 'update-branch-from-base',
    issue: task.issue,
    at: now.toISOString(),
    repoDir: context.repoDir,
    session: context.session,
    bucket: retry.bucket,
    headBefore: candidate.headBefore,
    baseSha: candidate.baseSha,
    detail: `merge origin/${candidate.base} into ${task.branch} (behind=${candidate.behindBase ?? '?'})`,
  };

  const stateDir = candidate.stateDir;
  if (!stateDir) {
    return { record: { ...base, outcome: 'skipped', reason: 'not-applicable' } };
  }

  if (dryRun) {
    return { record: { ...base, outcome: 'planned' } };
  }

  let decision: BoundedRetryDecision;
  try {
    decision = retry.gate(stateDir, candidate.headBefore, candidate.baseSha);
  } catch (err) {
    return { record: { ...base, outcome: 'skipped', reason: `retry-budget: ${(err as Error).message}` } };
  }
  if (decision !== 'proceed') {
    return { record: { ...base, outcome: 'skipped', reason: `retry-budget: ${decision}` } };
  }

  try {
    retry.increment(stateDir, candidate.headBefore, candidate.baseSha);
  } catch {
    // Non-fatal: the gate already decided proceed; losing one increment just
    // means the budget runs one attempt longer.
  }

  const result = deps.updateBranchWithBase(task.branch!, candidate.base, task.worktree!);

  if (result.status === 'success') {
    const headAfter = worktreeHead(deps, task.worktree!) ?? '';
    const remote = remoteBranchSha(deps, task.worktree!, task.branch!) ?? '';
    const fastForwarded = headAfter !== '' && headAfter === remote;
    return {
      record: {
        ...base,
        outcome: 'applied',
        headAfter,
        fastForwarded,
      },
      finding: {
        id: `observer-auto-fix-applied-update-branch-from-base-${task.issue}-${headAfter.slice(0, 7)}`,
        severity: 'low',
        category: 'operational',
        confidence: 'high',
        session: context.session,
        repoDir: context.repoDir,
        issue: task.issue,
        title: `${task.issue} branch ${task.branch} updated from origin/${candidate.base}`,
        evidence: [
          `headBefore=${candidate.headBefore}`,
          `headAfter=${headAfter}`,
          `baseSha=${candidate.baseSha ?? 'unknown'}`,
          `behindBase=${candidate.behindBase ?? 'unknown'}`,
          `fastForwarded=${fastForwarded}`,
        ],
        recommendation: 'No action needed; observer auto-fix log is in .wavemill/incidents/actions.jsonl.',
      },
    };
  }

  if (result.status === 'conflict') {
    const files = result.conflictingFiles ?? [];
    const reason = `merge-conflict: ${files.slice(0, 5).join(',') || 'unknown files'}`;
    try {
      retry.markExhausted(stateDir, reason);
    } catch {
      // Mark-exhausted failure doesn't block the finding.
    }
    return {
      record: {
        ...base,
        outcome: 'failed',
        reason,
        conflictingFiles: files,
      },
      finding: {
        id: `observer-auto-fix-failed-update-branch-from-base-${task.issue}`,
        severity: 'high',
        category: 'operational',
        confidence: 'high',
        session: context.session,
        repoDir: context.repoDir,
        issue: task.issue,
        title: `${task.issue} merging origin/${candidate.base} into ${task.branch} conflicts`,
        evidence: [
          `conflictingFiles=${files.join(',') || 'unknown'}`,
          `baseSha=${candidate.baseSha ?? 'unknown'}`,
          `bucket=${retry.bucket}`,
        ],
        recommendation: 'Resolve the merge conflict in the worktree manually, commit, and push. The retry budget is exhausted until the task head changes.',
      },
    };
  }

  if (result.status === 'dirty-worktree') {
    return { record: { ...base, outcome: 'skipped', reason: 'dirty-tree', detail: result.detail } };
  }

  return {
    record: {
      ...base,
      outcome: 'failed',
      reason: `${result.status}: ${result.detail}`,
    },
    finding: {
      id: `observer-auto-fix-failed-update-branch-from-base-${task.issue}`,
      severity: 'medium',
      category: 'operational',
      confidence: 'medium',
      session: context.session,
      repoDir: context.repoDir,
      issue: task.issue,
      title: `${task.issue} update-from-base failed: ${result.status}`,
      evidence: [`status=${result.status}`, `detail=${result.detail}`],
      recommendation: `Review the failure (${result.status}). Retry budget key is (head=${candidate.headBefore}, base=${candidate.baseSha ?? 'unknown'}).`,
    },
  };
}

// ── Fix: reset-ready-budget ─────────────────────────────────────────────────

interface ResetBudgetCandidate {
  bucket: ReadyRecheckBucket;
  task: AutoFixTask;
  stateDir: string;
  storedHead: string;
  storedBase: string;
  currentHead: string;
  currentBase: string;
  sentinelMtime: number;
}

async function pickResetBudgetCandidate(
  task: AutoFixTask,
  context: AutoFixRepoContext,
  deps: AutoFixDeps,
  bucket: ReadyRecheckBucket,
  getRetry: () => StateDirRetry,
  now: Date,
): Promise<ResetBudgetCandidate | undefined> {
  const stateDir = context.resolveTaskStateDir(task);
  if (!stateDir || !task.worktree || !task.branch) return undefined;
  const sentinelMtime = retentinelMtimeMs(stateDir, bucket);
  if (sentinelMtime === undefined) return undefined;

  const retry = getRetry();
  if (!retry.isExhausted(stateDir)) return undefined;

  const stored = retry.readKey(stateDir);
  if (!stored.head) return undefined;

  const currentHead = worktreeHead(deps, task.worktree);
  if (!currentHead) return undefined;
  const base = context.effectiveBaseBranch(task);
  const currentBase = base ? remoteBaseSha(deps, task.worktree, base) : undefined;

  // Head changed: candidate.
  if (currentHead !== stored.head) {
    return {
      bucket,
      task,
      stateDir,
      storedHead: stored.head,
      storedBase: stored.base,
      currentHead,
      currentBase: currentBase ?? '',
      sentinelMtime,
    };
  }

  // Base changed in a two-line key.
  if (stored.base && currentBase && stored.base !== currentBase) {
    return {
      bucket,
      task,
      stateDir,
      storedHead: stored.head,
      storedBase: stored.base,
      currentHead,
      currentBase,
      sentinelMtime,
    };
  }

  // Head-only key: fall back to the observer journal.
  if (!stored.base && currentBase) {
    const journalPath = context.journalPath ?? join(context.repoDir, '.wavemill', 'observer', 'auto-fix-state.json');
    const key = journalKey(stateDir, bucket);
    const existing = readJournalEntry(journalPath, key);
    if (!existing || existing.sentinelMtime !== sentinelMtime) {
      // First time we see this sentinel; record baseline.
      await recordJournalBaseline(deps, journalPath, key, {
        baseSha: currentBase,
        seenAt: now.toISOString(),
        sentinelMtime,
      });
      return undefined;
    }
    if (existing.baseSha && existing.baseSha !== currentBase) {
      return {
        bucket,
        task,
        stateDir,
        storedHead: stored.head,
        storedBase: '',
        currentHead,
        currentBase,
        sentinelMtime,
      };
    }
  }

  return undefined;
}

function applyResetBudget(
  candidate: ResetBudgetCandidate,
  deps: AutoFixDeps,
  context: AutoFixRepoContext,
  retry: StateDirRetry,
  now: Date,
  dryRun: boolean,
): { record: AutoFixActionRecord; finding?: AutoFixFinding } {
  const base: Omit<AutoFixActionRecord, 'outcome' | 'reason'> = {
    kind: 'observer-auto-fix',
    fix: 'reset-ready-budget',
    issue: candidate.task.issue,
    at: now.toISOString(),
    repoDir: context.repoDir,
    session: context.session,
    bucket: candidate.bucket,
    detail: `clear ${candidate.bucket} (storedHead=${candidate.storedHead} currentHead=${candidate.currentHead})`,
    headBefore: candidate.storedHead,
    headAfter: candidate.currentHead,
    baseSha: candidate.currentBase,
  };

  if (dryRun) {
    return { record: { ...base, outcome: 'planned' } };
  }

  let decision: BoundedRetryDecision;
  try {
    decision = retry.gate(candidate.stateDir, candidate.currentHead, candidate.currentBase);
  } catch (err) {
    return { record: { ...base, outcome: 'skipped', reason: `retry-budget: ${(err as Error).message}` } };
  }
  if (decision !== 'proceed') {
    return { record: { ...base, outcome: 'skipped', reason: `retry-budget: ${decision}` } };
  }
  try {
    retry.increment(candidate.stateDir, candidate.currentHead, candidate.currentBase);
  } catch {
    // non-fatal
  }

  // Clear the target bucket (candidate.bucket), not our own observer bucket.
  const bucketOps = createStateDirRetry(candidate.bucket, { maxAttempts: 1 });
  try {
    bucketOps.clear(candidate.stateDir);
  } catch (err) {
    return {
      record: { ...base, outcome: 'failed', reason: `clear-failed: ${(err as Error).message}` },
      finding: {
        id: `observer-auto-fix-failed-reset-ready-budget-${candidate.task.issue}`,
        severity: 'medium',
        category: 'operational',
        confidence: 'medium',
        session: context.session,
        repoDir: context.repoDir,
        issue: candidate.task.issue,
        title: `${candidate.task.issue} reset-ready-budget failed`,
        evidence: [`bucket=${candidate.bucket}`, `error=${(err as Error).message}`],
        recommendation: 'Inspect the state directory permissions and clear the bucket manually.',
      },
    };
  }

  return {
    record: { ...base, outcome: 'applied' },
    finding: {
      id: `observer-auto-fix-applied-reset-ready-budget-${candidate.task.issue}-${candidate.currentHead.slice(0, 7)}`,
      severity: 'low',
      category: 'operational',
      confidence: 'high',
      session: context.session,
      repoDir: context.repoDir,
      issue: candidate.task.issue,
      title: `${candidate.task.issue} ${candidate.bucket} retry budget reset`,
      evidence: [
        `bucket=${candidate.bucket}`,
        `storedHead=${candidate.storedHead}`,
        `currentHead=${candidate.currentHead}`,
        `storedBase=${candidate.storedBase || 'none'}`,
        `currentBase=${candidate.currentBase || 'unknown'}`,
      ],
      recommendation: 'No action needed; observer auto-fix log is in .wavemill/incidents/actions.jsonl.',
    },
  };
}

// ── Fix: forfeit-stuck-challenge-arm ────────────────────────────────────────

interface StuckArmEvidence {
  bucket?: string;
  reviewInfra?: boolean;
  sentinelMtime?: number;
  reviewMtime?: number;
  lastHeadMtime?: number;
  lastProgressAt?: string | null;
  reason: string;
}

function assessStuckArm(
  task: AutoFixTask,
  context: AutoFixRepoContext,
  deps: AutoFixDeps,
  stuckHours: number,
  nowMs: number,
): StuckArmEvidence | undefined {
  if (!task.pr || !task.branch || !task.worktree) return undefined;
  if (task.challengeAborted) return undefined;
  if (task.phase === 'aborted' || task.status === 'aborted') return undefined;

  const stateDir = context.resolveTaskStateDir(task);
  if (!stateDir) return undefined;

  const stuckMs = stuckHours * 60 * 60 * 1000;
  const buckets: Array<{ bucket: string; mtime: number }> = [];
  for (const bucket of ['ready-remediation', 'failed-ready-recheck', 'pending-ready-recheck']) {
    const mtime = retentinelMtimeMs(stateDir, bucket);
    if (mtime !== undefined) buckets.push({ bucket, mtime });
  }

  const reviewPath = getResultFilePath(stateDir, 'review');
  let reviewMtime: number | undefined;
  let reviewInfra = false;
  if (existsSync(reviewPath)) {
    try {
      reviewMtime = statSync(reviewPath).mtimeMs;
    } catch {
      reviewMtime = undefined;
    }
    reviewInfra = reviewFailedWithInfra(stateDir);
  }

  if (buckets.length === 0 && !reviewInfra) return undefined;

  // No new head for `stuckHours`.
  let lastHead: number | undefined;
  try {
    const raw = tryGit(deps, ['-C', task.worktree!, 'log', '-1', '--format=%ct', `origin/${task.branch}`], task.worktree!)
      ?? tryGit(deps, ['-C', task.worktree!, 'log', '-1', '--format=%ct', task.branch], task.worktree!);
    if (raw) {
      const secs = Number.parseInt(raw, 10);
      if (Number.isFinite(secs)) lastHead = secs * 1000;
    }
  } catch {
    lastHead = undefined;
  }

  const progress = deps.getProgress(task);
  const lastProgressMs = progress?.lastProgressAt ? Date.parse(progress.lastProgressAt) : NaN;

  const sentinelMtime = buckets.length > 0
    ? Math.max(...buckets.map((b) => b.mtime))
    : undefined;

  const timestamps = [
    lastHead,
    sentinelMtime,
    reviewMtime,
    Number.isFinite(lastProgressMs) ? lastProgressMs : undefined,
  ].filter((t): t is number => typeof t === 'number' && Number.isFinite(t));
  if (timestamps.length === 0) return undefined;
  const newest = Math.max(...timestamps);
  if (nowMs - newest < stuckMs) return undefined;

  const bucket = buckets.length > 0 ? buckets.reduce((a, b) => (b.mtime > a.mtime ? b : a)).bucket : undefined;
  return {
    bucket,
    reviewInfra: reviewInfra || undefined,
    sentinelMtime,
    reviewMtime,
    lastHeadMtime: lastHead,
    lastProgressAt: progress?.lastProgressAt ?? null,
    reason: bucket
      ? `exhausted:${bucket}`
      : reviewInfra
        ? 'review:not_ready:infra'
        : 'unknown',
  };
}

async function applyForfeit(
  task: AutoFixTask,
  sibling: AutoFixTask,
  stuck: StuckArmEvidence,
  context: AutoFixRepoContext,
  deps: AutoFixDeps,
  retry: StateDirRetry,
  stateDir: string,
  now: Date,
  dryRun: boolean,
): Promise<{ record: AutoFixActionRecord; finding?: AutoFixFinding }> {
  const reason = `observer-auto-forfeit: ${stuck.reason}; sibling ${sibling.issue} evalCompleted`;
  const base: Omit<AutoFixActionRecord, 'outcome' | 'reason'> = {
    kind: 'observer-auto-fix',
    fix: 'forfeit-stuck-challenge-arm',
    issue: task.issue,
    at: now.toISOString(),
    repoDir: context.repoDir,
    session: context.session,
    bucket: retry.bucket,
    detail: reason,
  };

  if (dryRun) {
    return { record: { ...base, outcome: 'planned', reason } };
  }

  if (!context.workflowStatePath) {
    return { record: { ...base, outcome: 'skipped', reason: 'not-applicable: no workflow state path' } };
  }

  let decision: BoundedRetryDecision;
  try {
    decision = retry.gate(stateDir, '', '');
  } catch (err) {
    return { record: { ...base, outcome: 'skipped', reason: `retry-budget: ${(err as Error).message}` } };
  }
  if (decision !== 'proceed') {
    return { record: { ...base, outcome: 'skipped', reason: `retry-budget: ${decision}` } };
  }
  try {
    retry.increment(stateDir, '', '');
  } catch {
    // non-fatal
  }

  try {
    await deps.abortTaskInState(context.workflowStatePath, task.issue, reason);
  } catch (err) {
    return {
      record: { ...base, outcome: 'failed', reason: `abort-failed: ${(err as Error).message}` },
      finding: {
        id: `observer-auto-fix-failed-forfeit-stuck-challenge-arm-${task.issue}`,
        severity: 'high',
        category: 'operational',
        confidence: 'high',
        session: context.session,
        repoDir: context.repoDir,
        issue: task.issue,
        title: `${task.issue} forfeit abort failed`,
        evidence: [`error=${(err as Error).message}`, `sibling=${sibling.issue}`],
        recommendation: 'Inspect workflow state and abort the stuck arm manually.',
      },
    };
  }

  let prClosed = false;
  const prResult = deps.gh(['pr', 'close', task.pr!, '--comment', reason], context.repoDir);
  if (prResult.ok) {
    prClosed = true;
  }

  return {
    record: {
      ...base,
      outcome: 'applied',
      reason,
      prClosed,
    },
    finding: {
      id: `observer-auto-fix-applied-forfeit-stuck-challenge-arm-${task.issue}`,
      severity: prClosed ? 'low' : 'medium',
      category: 'operational',
      confidence: 'high',
      session: context.session,
      repoDir: context.repoDir,
      issue: task.issue,
      title: `${task.issue} forfeited as stuck challenge arm; sibling ${sibling.issue} wins`,
      evidence: [
        `stuckReason=${stuck.reason}`,
        `sibling=${sibling.issue}`,
        `prClosed=${prClosed}`,
        prResult.ok ? '' : `prCloseError=${prResult.stderr || prResult.stdout}`,
      ].filter((line) => line.length > 0),
      recommendation: prClosed
        ? 'No action needed; observer auto-fix log is in .wavemill/incidents/actions.jsonl.'
        : `Close PR #${task.pr} manually; the state abort already resolves the pair.`,
    },
  };
}

// ── Main runner ─────────────────────────────────────────────────────────────

function skipRecord(
  task: AutoFixTask,
  fix: AutoFixKind,
  gate: PreconditionResult,
  context: AutoFixRepoContext,
  now: Date,
): AutoFixActionRecord {
  return {
    kind: 'observer-auto-fix',
    fix,
    outcome: 'skipped',
    issue: task.issue,
    at: now.toISOString(),
    repoDir: context.repoDir,
    session: context.session,
    reason: gate.reason ?? 'not-applicable',
    evidence: gate.evidence,
  };
}

function skipFinding(
  task: AutoFixTask,
  fix: AutoFixKind,
  gate: PreconditionResult,
  context: AutoFixRepoContext,
): AutoFixFinding | undefined {
  if (gate.reason !== 'agent-working' && gate.reason !== 'dirty-tree' && gate.reason !== 'progress-unknown') {
    return undefined;
  }
  return {
    id: `observer-auto-fix-skipped-${fix}-${task.issue}`,
    severity: 'medium',
    category: 'operational',
    confidence: 'high',
    session: context.session,
    repoDir: context.repoDir,
    issue: task.issue,
    title: `${task.issue} auto-fix ${fix} skipped (${gate.reason})`,
    evidence: gate.evidence,
    recommendation: gate.reason === 'dirty-tree'
      ? 'Commit or stash the dirty paths before the observer can safely update the branch.'
      : gate.reason === 'agent-working'
        ? 'Wait for the agent to idle before the observer can act.'
        : 'Progress primitive could not read the task; investigate the hook or state files.',
  };
}

export async function runObserverAutoFixes(options: RunAutoFixOptions): Promise<AutoFixRunResult> {
  const { repo, tasks, findings, config, deps, now, dryRun = false } = options;
  const records: AutoFixActionRecord[] = [];
  const outFindings: AutoFixFinding[] = [];

  if (!config.enabled) {
    return { records, findings: outFindings };
  }

  const updateRetry = deps.retries?.updateBranch ?? createStateDirRetry('observer-update-branch', { maxAttempts: config.updateBranchFromBase.maxAttempts });
  const resetRetry = deps.retries?.resetBudget ?? createStateDirRetry('observer-ready-budget-reset', { maxAttempts: 1 });
  const forfeitRetry = deps.retries?.forfeit ?? createStateDirRetry('observer-forfeit-arm', { maxAttempts: 1 });

  const mutatedThisPass = new Set<string>();
  const nowMs = now.getTime();

  // Fix 1: update-branch-from-base (also ff-only).
  if (config.updateBranchFromBase.enabled) {
    for (const task of tasks) {
      const stateDir = repo.resolveTaskStateDir(task);
      const gate = checkAutoFixPreconditions(task, deps, stateDir);
      if (!gate.ok) {
        // Only emit a candidate-less skip record if the task actually matched a
        // behind-base finding or an exhausted retry sentinel.
        const matched = findings.some((f) => f.issue === task.issue
          && (f.id.startsWith('branch-behind-base-') || f.id.startsWith('exhausted-retry-abandoned-')));
        if (!matched) continue;
        records.push(skipRecord(task, 'update-branch-from-base', gate, repo, now));
        const finding = skipFinding(task, 'update-branch-from-base', gate, repo);
        if (finding) outFindings.push(finding);
        continue;
      }

      const candidate = pickUpdateBranchCandidate(task, findings, repo, deps, config, nowMs);
      if (!candidate) continue;

      const applied = candidate.mode === 'ff-only'
        ? applyFfOnly(candidate, deps, repo, now, dryRun)
        : applyUpdateBranchMerge(candidate, deps, repo, updateRetry, config, now, dryRun);
      records.push(applied.record);
      if (applied.finding) outFindings.push(applied.finding);
      if (applied.record.outcome === 'applied') mutatedThisPass.add(task.issue);
    }
  }

  // Fix 2: reset-ready-budget.
  if (config.resetReadyRecheckBudget.enabled) {
    for (const task of tasks) {
      const stateDir = repo.resolveTaskStateDir(task);
      const gate = checkAutoFixPreconditions(task, deps, stateDir);
      if (!gate.ok) {
        const matched = findings.some((f) => f.issue === task.issue && f.id.startsWith('exhausted-retry-abandoned-'));
        if (!matched) continue;
        records.push(skipRecord(task, 'reset-ready-budget', gate, repo, now));
        const finding = skipFinding(task, 'reset-ready-budget', gate, repo);
        if (finding) outFindings.push(finding);
        continue;
      }
      for (const bucket of READY_RECHECK_BUCKETS) {
        const ops = createStateDirRetry(bucket, { maxAttempts: 1 });
        const candidate = await pickResetBudgetCandidate(task, repo, deps, bucket, () => ops, now);
        if (!candidate) continue;
        const applied = applyResetBudget(candidate, deps, repo, resetRetry, now, dryRun);
        records.push(applied.record);
        if (applied.finding) outFindings.push(applied.finding);
      }
    }
  }

  // Fix 3: forfeit-stuck-challenge-arm.
  if (config.forfeitStuckChallengeArm.enabled) {
    const byPair = new Map<string, AutoFixTask[]>();
    for (const task of tasks) {
      if (!task.challengePairId) continue;
      const list = byPair.get(task.challengePairId) ?? [];
      list.push(task);
      byPair.set(task.challengePairId, list);
    }
    for (const [, arms] of byPair) {
      if (arms.length !== 2) continue;
      const stuckInfo = arms.map((arm) => ({
        arm,
        stuck: assessStuckArm(arm, repo, deps, config.forfeitStuckChallengeArm.stuckHours, nowMs),
      }));
      const stuckArms = stuckInfo.filter((s) => s.stuck);
      if (stuckArms.length === 0) continue;
      if (stuckArms.length === 2) {
        outFindings.push({
          id: `challenge-pair-both-stuck-${arms[0].challengePairId}`,
          severity: 'high',
          category: 'stuck',
          confidence: 'high',
          session: repo.session,
          repoDir: repo.repoDir,
          issue: arms[0].issue,
          title: `Challenge pair ${arms[0].challengePairId} has both arms stuck`,
          evidence: arms.map((a) => `arm=${a.issue}`),
          recommendation: 'Inspect both arms by hand; neither can be forfeited while both are stuck.',
        });
        continue;
      }
      const stuckArmEntry = stuckArms[0];
      const sibling = stuckInfo.find((s) => s.arm.issue !== stuckArmEntry.arm.issue)!.arm;
      if (sibling.evalCompleted !== true) continue;
      if (!sibling.pr) continue;
      if (mutatedThisPass.has(stuckArmEntry.arm.issue)) continue;

      const stateDir = repo.resolveTaskStateDir(stuckArmEntry.arm);
      const gate = checkAutoFixPreconditions(stuckArmEntry.arm, deps, stateDir);
      if (!gate.ok) {
        records.push(skipRecord(stuckArmEntry.arm, 'forfeit-stuck-challenge-arm', gate, repo, now));
        const finding = skipFinding(stuckArmEntry.arm, 'forfeit-stuck-challenge-arm', gate, repo);
        if (finding) outFindings.push(finding);
        continue;
      }
      if (!stateDir) continue;
      const applied = await applyForfeit(
        stuckArmEntry.arm,
        sibling,
        stuckArmEntry.stuck!,
        repo,
        deps,
        forfeitRetry,
        stateDir,
        now,
        dryRun,
      );
      records.push(applied.record);
      if (applied.finding) outFindings.push(applied.finding);
    }
  }

  return { records, findings: outFindings };
}
