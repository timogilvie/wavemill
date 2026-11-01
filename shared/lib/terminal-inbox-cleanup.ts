import {
  TASK_ID_RE,
  challengerTaskKey,
  isChallengerTaskId,
  parseTaskId,
  resolveLinearIssueId,
} from './task-identity.ts';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveTaskResidue, type ArchiveTaskResidueResult } from './task-residue-archive.ts';
import { filterWorktreeDirtyStatus } from './worktree-dirty-status.ts';
import {
  appendTombstoneToArchive,
  compactHotRecord,
  enforceHotStateByteCap,
  DEFAULT_BYTE_CAP,
} from './state-archive.ts';
import {
  mutateWorkflowState,
  readWorkflowState as readCanonicalWorkflowState,
  type WorkflowState,
} from './workflow-state.ts';

export type { WorkflowState };

/**
 * Wavemill's own shell libraries. These ship with the wavemill install, so
 * resolve them next to this module, never under the milled repo's dir.
 */
export const WAVEMILL_COMMON_SCRIPT = fileURLToPath(new URL('./wavemill-common.sh', import.meta.url));
export const TERMINAL_RECONCILER_SCRIPT = fileURLToPath(new URL('./terminal-reconciler.sh', import.meta.url));

export type JsonRecord = Record<string, unknown>;

export interface TerminalTaskTombstone {
  schemaVersion: 1;
  issue: string;
  slug: string;
  branch: string;
  worktree: string;
  prNumber: string;
  workflowOutcome: string;
  resourceDisposition: string;
  challengePairId: string;
  challengeRole: string;
  runEpoch: string;
  attempt: string;
  /** HOK-3373: the settled run's identity; survives hot-state compaction. */
  runId?: string;
  /** HOK-3373: the Linear state that landed for this run (no re-sync after reap). */
  linearSyncedState?: string;
  actor: string;
  command: string;
  createdAt: string;
  decisionStatus: string;
  decisionReason: string;
  task: JsonRecord;
  pr?: PrEvidence;
}

export interface PrEvidence {
  number: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED' | 'UNKNOWN';
  mergedAt: string;
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  mergeCommitOid: string;
}

export interface GitEvidence {
  worktreeExists: boolean;
  worktreeDirty: boolean | 'unknown';
  dirtyStatus: string;
  localBranchExists: boolean;
  localHeadSha: string;
  remoteHeadSha: string;
  remoteContainsHead: boolean;
  commitsAhead: number | null;
  patchEquivalent: boolean | 'unknown';
  patchUniqueCount: number | null;
  patchEquivalentCount: number | null;
  patchError?: string;
  worktreeIdentity?: string;
  verifiedTopLevel?: string;
  classifierVerdict?: string;
}

export type TerminalInboxStatus =
  | 'would-reap'
  | 'would-abandon-loser'
  | 'would-abandon-aborted'
  | 'would-archive-and-reap'
  | 'refused'
  | 'already-reaped'
  | 'not-terminal'
  | 'kept'
  | 'executed';

/**
 * HOK-3201: refusals that live on terminal, delivered arms and are safe to
 * convert into archive-and-reap. The unattended inbox executor retries each
 * such refusal with `archiveAndReap: true` so no human has to run the command.
 */
export const INBOX_AUTO_ARCHIVE_REFUSALS: ReadonlySet<string> = new Set([
  'unique_local_patch',
  'closed_loser_head_unpublished',
  'aborted_pr_less_requires_abandon',
]);

export interface TerminalInboxDecision {
  issue: string;
  slug: string;
  branch: string;
  worktree: string;
  prNumber: string;
  status: TerminalInboxStatus;
  refusalReason: string;
  workflowOutcome: string;
  resourceDisposition: string;
  challengeRole: string;
  challengePairId: string;
  /**
   * HOK-3209: how the sibling-identity resolver sourced the pair metadata.
   * `task-metadata` — both `challengeRole` and `challengePairId` were present on the row.
   * `inferred-from-task-id` — the row's pair fields were null; identity was derived
   *   from the task ID itself (via the task-identity helpers) and a sibling PR was found.
   * `none` — either the task ID did not parse, or inference ran but no sibling PR
   *   turned up anywhere, so the row is treated as unpaired.
   */
  pairEvidence: 'task-metadata' | 'inferred-from-task-id' | 'none';
  siblingPrNumber: string;
  siblingPrState: string;
  pr: PrEvidence;
  git: GitEvidence;
  pane: {
    windowId: string;
    paneState: string;
    paneReleased: boolean;
    intendedAction: 'release' | 'none';
  };
  intendedActions: string[];
  /** HOK-3201: operator-set hold (`keep` short-circuits auto-reap). Empty when no hold is set. */
  cleanupHold?: string;
  /** HOK-3160: when archive-and-reap executes, the resulting archive path. */
  archive?: {
    path: string;
    diffPath: string;
    bundlePath?: string;
    untrackedCount: number;
  };
}

export interface ClassifyRequest {
  worktreeDir?: string;
  taskBranch: string;
  baseBranch: string;
  issue?: string;
  pr?: string;
}

export interface ClassifyEvidence {
  classification: string;
  verificationReason: string;
  worktreeIdentity: string;
  verifiedTopLevel: string;
  cleanupAuthority: string;
  patchEquivalenceScope: string;
  orphanIndependentPaths?: string;
}

export interface CleanupDeps {
  git(args: string[], cwd: string): string;
  gh(args: string[], cwd: string): string;
  classify?(request: ClassifyRequest, repoDir: string): ClassifyEvidence;
  cleanup(decision: TerminalInboxDecision, context: CleanupExecuteContext): void;
  now(): string;
}

export interface CleanupExecuteContext {
  repoDir: string;
  stateFile: string;
  baseBranch: string;
  session: string;
  abandon: boolean;
  /** HOK-3160: cleanup entered via `--archive-and-reap`; the worktree residue has already been archived. */
  archiveAndReap?: boolean;
  /** Directory holding wavemill-common.sh / terminal-reconciler.sh. Defaults to the wavemill install; tests inject stubs. */
  wavemillLibDir?: string;
}

export interface CleanupOptions {
  repoDir: string;
  stateFile?: string;
  issue?: string;
  inbox?: boolean;
  execute?: boolean;
  abandon?: boolean;
  /** HOK-3160: archive the worktree's residue to `.wavemill/evals/artifacts/<ID>/retired-arm-residue/` before reaping. Requires a delivered task (merged PR, or retired arm with a merged/closed sibling, or a PR-less aborted arm). */
  archiveAndReap?: boolean;
  json?: boolean;
  out?: string;
  baseBranch?: string;
  deps?: CleanupDeps;
}

const terminalStatuses = new Set(['merged', 'complete', 'completed', 'completed-external', 'closed', 'done', 'aborted', 'error', 'superseded']);
const issuePattern = TASK_ID_RE;

export const defaultCleanupDeps: CleanupDeps = {
  git(args, cwd) {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  },
  gh(args, cwd) {
    return execFileSync('gh', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  },
  classify(request, repoDir) {
    try {
      const script = 'set -euo pipefail\nsource "$WAVEMILL_COMMON_SCRIPT"\nwavemill_classify_task_cleanup "$WAVEMILL_CLASSIFY_WORKTREE" "$WAVEMILL_CLASSIFY_BRANCH" "$WAVEMILL_CLASSIFY_BASE" classify "$WAVEMILL_CLASSIFY_ISSUE" "$WAVEMILL_CLASSIFY_PR"';
      const env = {
        ...process.env,
        REPO_DIR: repoDir,
        STATE_FILE: statePath(repoDir),
        BASE_BRANCH: request.baseBranch,
        WORKTREE_ROOT: request.worktreeDir ? dirname(request.worktreeDir) : dirname(repoDir),
        WAVEMILL_COMMON_SCRIPT,
        WAVEMILL_CLASSIFY_WORKTREE: request.worktreeDir || '',
        WAVEMILL_CLASSIFY_BRANCH: request.taskBranch,
        WAVEMILL_CLASSIFY_BASE: request.baseBranch,
        WAVEMILL_CLASSIFY_ISSUE: request.issue || '',
        WAVEMILL_CLASSIFY_PR: request.pr || '',
      };
      const output = execFileSync('bash', ['-lc', script], { cwd: repoDir, env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
      const evidence = JSON.parse(output.trim()) as ClassifyEvidence;
      return evidence;
    } catch (error) {
      return {
        classification: 'retain_unverifiable',
        verificationReason: 'classifier_unavailable',
        worktreeIdentity: '',
        verifiedTopLevel: '',
        cleanupAuthority: '',
        patchEquivalenceScope: '',
      };
    }
  },
  cleanup(decision, context) {
    // HOK-3160: when archive-and-reap executes, reset the worktree so the
    // shell cleanup's dirty-worktree refusal sees a clean tree. The residue
    // was already archived under .wavemill/evals/artifacts/<ID>/ in the
    // previous step; nothing is lost by resetting here. A PR-less arm also
    // needs abandon authority to delete the unpushed head.
    if (context.archiveAndReap && decision.worktree && existsSync(decision.worktree)) {
      try {
        execFileSync('git', ['-C', decision.worktree, 'reset', '--hard', 'HEAD'], { stdio: 'ignore' });
        execFileSync('git', ['-C', decision.worktree, 'clean', '-fdx'], { stdio: 'ignore' });
      } catch {
        // Fall through: the shell cleanup will refuse and retain. The archive
        // directory on disk still carries the inspectable residue.
      }
    }
    const script = [
      'set -euo pipefail',
      'log() { if [[ "$#" -gt 0 && "$1" == "debug" ]]; then shift; fi; printf "%s\\n" "$*" >&2; }',
      'log_warn() { printf "WARN: %s\\n" "$*" >&2; }',
      `source "${(context.wavemillLibDir ? join(context.wavemillLibDir, 'wavemill-common.sh') : WAVEMILL_COMMON_SCRIPT).replace(/"/g, '\\"')}"`,
      `source "${(context.wavemillLibDir ? join(context.wavemillLibDir, 'terminal-reconciler.sh') : TERMINAL_RECONCILER_SCRIPT).replace(/"/g, '\\"')}"`,
      `cleanup_completed_task "${decision.issue.replace(/"/g, '\\"')}" "${decision.slug.replace(/"/g, '\\"')}" "operator terminal inbox cleanup"`,
    ].join('\n');
    const abandon = context.abandon || (context.archiveAndReap === true && !decision.prNumber);
    const env = {
      ...process.env,
      REPO_DIR: context.repoDir,
      STATE_FILE: context.stateFile,
      SESSION: context.session,
      BASE_BRANCH: context.baseBranch,
      WORKTREE_ROOT: dirname(decision.worktree || context.repoDir),
      WAVEMILL_CLEANUP_ABANDON_ISSUE: abandon ? decision.issue : '',
      WAVEMILL_TERMINAL_INBOX_CLEANUP: '1',
    };
    execFileSync('bash', ['-lc', script], { cwd: context.repoDir, env, stdio: 'inherit' });
  },
  now() {
    return new Date().toISOString();
  },
};

export function statePath(repoDir: string, explicit?: string): string {
  return explicit ? (isAbsolute(explicit) ? explicit : resolve(repoDir, explicit)) : join(repoDir, '.wavemill', 'workflow-state.json');
}

/**
 * A missing state file is an empty inbox; an unreadable one fails closed so a
 * corrupt file never reads as "nothing to protect".
 */
function readCleanupState(path: string): WorkflowState {
  if (!existsSync(path)) return { tasks: {} };
  const state = readCanonicalWorkflowState(path);
  if (!state) throw new Error(`workflow state at ${path} is not a readable JSON object`);
  return state;
}

function taskString(task: JsonRecord | undefined, key: string): string {
  const value = task?.[key];
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' ? value : '';
}

function taskBoolean(task: JsonRecord | undefined, key: string): boolean {
  return task?.[key] === true;
}

function lifecycle(task: JsonRecord | undefined): JsonRecord {
  const value = task?.lifecycle;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

/**
 * HOK-3201: operator-set hold on a terminal task. When
 * `lifecycle.retention.hold === 'keep'` the inbox never auto-reaps the task,
 * independent of whether its residue is unpublished. Returns `''` when no
 * hold is set.
 */
function retentionHold(task: JsonRecord | undefined): string {
  const retention = lifecycle(task).retention;
  if (!retention || typeof retention !== 'object' || Array.isArray(retention)) return '';
  const hold = (retention as JsonRecord).hold;
  return typeof hold === 'string' ? hold : '';
}

function launchContract(task: JsonRecord | undefined): JsonRecord {
  const value = lifecycle(task).launchContract;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function deliveryEvidence(task: JsonRecord | undefined): JsonRecord {
  const value = lifecycle(task).deliveryEvidence;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function workflowOutcome(task: JsonRecord | undefined): string {
  const explicit = taskString(lifecycle(task), 'workflowOutcome');
  if (explicit) return explicit;
  const status = taskString(task, 'status');
  const phase = taskString(task, 'phase');
  if (status === 'merged' || phase === 'done') return 'merged';
  if (['closed', 'complete', 'completed', 'completed-external', 'done', 'superseded'].includes(status) || ['closed', 'superseded'].includes(phase)) return 'closed';
  if (status === 'aborted' || phase === 'aborted') return 'aborted';
  if (status === 'error' || phase === 'error') return 'error';
  return 'active';
}

function resourceDisposition(task: JsonRecord | undefined): string {
  return taskString(lifecycle(task), 'resourceDisposition') || (workflowOutcome(task) === 'active' ? 'allocated' : 'verification-required');
}

function isTerminalTask(task: JsonRecord | undefined): boolean {
  if (!task) return false;
  const status = taskString(task, 'status');
  const phase = taskString(task, 'phase');
  return workflowOutcome(task) !== 'active' || terminalStatuses.has(status) || terminalStatuses.has(phase);
}

function normalizePrState(state: string, mergedAt: string): PrEvidence['state'] {
  if (mergedAt) return 'MERGED';
  if (state === 'MERGED' || state === 'CLOSED' || state === 'OPEN') return state;
  return 'UNKNOWN';
}

function parsePr(output: string, fallbackPr: string): PrEvidence {
  const parsed = JSON.parse(output) as JsonRecord;
  const mergeCommit = parsed.mergeCommit && typeof parsed.mergeCommit === 'object' ? parsed.mergeCommit as JsonRecord : {};
  const mergedAt = taskString(parsed, 'mergedAt');
  const state = normalizePrState(taskString(parsed, 'state'), mergedAt);
  return {
    number: taskString(parsed, 'number') || fallbackPr,
    state,
    mergedAt,
    headRefOid: taskString(parsed, 'headRefOid'),
    headRefName: taskString(parsed, 'headRefName'),
    baseRefName: taskString(parsed, 'baseRefName'),
    mergeCommitOid: taskString(mergeCommit, 'oid'),
  };
}

function unknownPr(prNumber = ''): PrEvidence {
  return { number: prNumber, state: 'UNKNOWN', mergedAt: '', headRefOid: '', headRefName: '', baseRefName: '', mergeCommitOid: '' };
}

function fetchPr(repoDir: string, prNumber: string, task: JsonRecord | undefined, deps: CleanupDeps): PrEvidence {
  if (!prNumber) return unknownPr();
  try {
    return parsePr(deps.gh(['pr', 'view', prNumber, '--json', 'number,state,mergedAt,headRefOid,headRefName,baseRefName,mergeCommit'], repoDir), prNumber);
  } catch {
    const evidence = deliveryEvidence(task);
    return {
      number: prNumber,
      state: normalizePrState(taskString(evidence, 'prState'), taskString(evidence, 'prMergedAt')),
      mergedAt: taskString(evidence, 'prMergedAt'),
      headRefOid: taskString(evidence, 'prHeadSha') || taskString(evidence, 'prHeadRefOid'),
      headRefName: taskString(evidence, 'prHeadRefName'),
      baseRefName: taskString(evidence, 'prBaseBranch'),
      mergeCommitOid: taskString(evidence, 'mergeSha'),
    };
  }
}

function safeGit(deps: CleanupDeps, args: string[], cwd: string): string | undefined {
  try {
    return deps.git(args, cwd);
  } catch {
    return undefined;
  }
}

function collectGitEvidence(repoDir: string, task: JsonRecord | undefined, branch: string, worktree: string, baseBranch: string, deps: CleanupDeps, checkWorktreeStatus = true): GitEvidence {
  const worktreeExists = Boolean(worktree && existsSync(worktree));
  let dirtyStatus = '';
  let worktreeDirty: boolean | 'unknown' = false;
  if (worktreeExists && checkWorktreeStatus) {
    const status = safeGit(deps, ['-C', worktree, 'status', '--porcelain', '--untracked-files=all'], repoDir);
    if (status === undefined) {
      worktreeDirty = 'unknown';
    } else {
      // Share the shell helper's exact filter (HOK-3088) so cleanup and the
      // observer never disagree on whether the tree still holds real work.
      const filtered = filterWorktreeDirtyStatus(status);
      dirtyStatus = filtered.join('\n');
      worktreeDirty = filtered.length > 0;
    }
  }

  const localBranchExists = Boolean(branch && safeGit(deps, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repoDir) !== undefined);
  const localHeadSha = localBranchExists ? (safeGit(deps, ['rev-parse', '--verify', `${branch}^{commit}`], repoDir)?.trim() ?? '') : '';
  const remoteHeadSha = branch ? (safeGit(deps, ['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`], repoDir)?.trim() ?? '') : '';
  let remoteContainsHead = false;
  if (localHeadSha && remoteHeadSha) {
    if (remoteHeadSha === localHeadSha) {
      remoteContainsHead = true;
    } else {
      remoteContainsHead = safeGit(deps, ['merge-base', '--is-ancestor', localHeadSha, remoteHeadSha], repoDir) !== undefined;
    }
  }

  let commitsAhead: number | null = null;
  const ahead = branch ? safeGit(deps, ['rev-list', '--count', `origin/${baseBranch}..${branch}`], repoDir) : undefined;
  if (ahead !== undefined && /^\d+$/.test(ahead.trim())) commitsAhead = Number(ahead.trim());

  let patchEquivalent: boolean | 'unknown' = 'unknown';
  let patchUniqueCount: number | null = null;
  let patchEquivalentCount: number | null = null;
  let patchError: string | undefined;
  if (branch && localBranchExists && commitsAhead !== null) {
    const cherry = safeGit(deps, ['cherry', `origin/${baseBranch}`, branch], repoDir);
    if (cherry === undefined) {
      patchError = 'git_cherry_failed';
    } else {
      const lines = cherry.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      patchUniqueCount = lines.filter((line) => line.startsWith('+')).length;
      patchEquivalentCount = lines.filter((line) => line.startsWith('-')).length;
      patchEquivalent = patchUniqueCount === 0;
    }
  }

  return { worktreeExists, worktreeDirty, dirtyStatus, localBranchExists, localHeadSha, remoteHeadSha, remoteContainsHead, commitsAhead, patchEquivalent, patchUniqueCount, patchEquivalentCount, patchError };
}

function siblingKey(issue: string, role: string, pairId: string): string {
  if (!pairId || !role) return '';
  return role === 'primary' ? challengerTaskKey(pairId) : pairId;
}

function findHistoricalTask(state: WorkflowState, issue: string): JsonRecord | undefined {
  const history = state.terminalTaskHistory;
  if (!history || typeof history !== 'object' || Array.isArray(history)) return undefined;
  const tasks = (history as JsonRecord).tasks;
  if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) return undefined;
  const value = (tasks as Record<string, unknown>)[issue];
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined;
}

/**
 * HOK-3209: sibling-identity resolution. For well-formed rows (both pair fields
 * present) this preserves the previous `siblingKey` logic verbatim. For rows
 * that lost their pair metadata — the HOK-3150_c shape — the role and pair ID
 * are derived from the task ID through the canonical task-identity helpers
 * (never inline `_c` parsing, per HOK-3118).
 *
 * The resolver returns a tentative `pairEvidence` of `'inferred-from-task-id'`
 * for inferred rows; the caller downgrades to `'none'` when the subsequent
 * sibling-PR lookup finds no evidence a sibling actually exists.
 */
interface SiblingIdentity {
  sibKey: string;
  role: 'primary' | 'challenger' | '';
  pairId: string;
  pairEvidence: TerminalInboxDecision['pairEvidence'];
}

function resolveSiblingIdentity(task: JsonRecord | undefined, issue: string): SiblingIdentity {
  const recordedRole = taskString(task, 'challengeRole');
  const recordedPair = taskString(task, 'challengePairId');
  if (recordedRole && recordedPair) {
    return {
      sibKey: siblingKey(issue, recordedRole, recordedPair),
      role: recordedRole === 'primary' || recordedRole === 'challenger' ? recordedRole : '',
      pairId: recordedPair,
      pairEvidence: 'task-metadata',
    };
  }
  const parsed = parseTaskId(issue);
  if (!parsed) {
    return { sibKey: '', role: '', pairId: '', pairEvidence: 'none' };
  }
  if (parsed.role === 'challenger') {
    // Challenger task ID → sibling is the primary with the base Linear ID.
    const resolved = resolveLinearIssueId(issue, task);
    const linearId = resolved.ok ? resolved.linearId : parsed.linearId;
    return {
      sibKey: linearId,
      role: 'challenger',
      pairId: parsed.linearId,
      pairEvidence: 'inferred-from-task-id',
    };
  }
  // Primary task ID → sibling is the challenger with the `_c` suffix. The
  // pair ID is the base Linear ID either way.
  return {
    sibKey: challengerTaskKey(parsed.linearId),
    role: 'primary',
    pairId: parsed.linearId,
    pairEvidence: 'inferred-from-task-id',
  };
}

/**
 * HOK-3209: enumerate candidate sibling branch names for the `gh pr list`
 * fallback. Prefers slug-level transformation of the current task's slug
 * (strip or append `-challenger`), then falls back to the lowercased sibling
 * task key patterns. Both touches operate on slugs / branch strings, never on
 * issue IDs — the HOK-3118 preflight exempts those sites.
 */
function siblingBranchCandidates(sibKey: string, taskSlug: string, taskRole: 'primary' | 'challenger' | ''): string[] {
  const candidates: string[] = [];
  const CHALLENGER_SLUG_SUFFIX = '-challenger';
  if (taskSlug) {
    if (taskRole === 'challenger' && taskSlug.endsWith(CHALLENGER_SLUG_SUFFIX)) {
      candidates.push(`task/${taskSlug.slice(0, -CHALLENGER_SLUG_SUFFIX.length)}`);
    } else if (taskRole === 'primary') {
      candidates.push(`task/${taskSlug}${CHALLENGER_SLUG_SUFFIX}`);
    }
  }
  // Fall back to lowercased task-key patterns. We do not try to differentiate
  // primary vs challenger here beyond adding the `-challenger` suffix for a
  // challenger sibling, because the sibling's actual slug is unknown.
  if (sibKey) {
    const base = sibKey.toLowerCase();
    const challengerShape = isChallengerTaskId(sibKey);
    if (challengerShape) {
      candidates.push(`task/${base}-challenger`);
    } else {
      candidates.push(`task/${base}`);
    }
  }
  // Dedupe, preserving order.
  const seen = new Set<string>();
  return candidates.filter((branch) => {
    if (seen.has(branch)) return false;
    seen.add(branch);
    return true;
  });
}

/**
 * HOK-3209: expanded sibling-PR lookup. Ordered chain:
 *   1. `state.tasks[sibKey].pr`
 *   2. `terminalTaskHistory.tasks[sibKey]` (existing historical fallback)
 *   3. `terminalTaskTombstones[*]` whose `issue === sibKey`
 *   4. `terminalTaskHistory.challengePairs[*]` entries matching `sibKey`
 *   5. `gh pr list --head task/<slug>` by branch prefix (only when pair
 *      metadata was inferred — well-formed rows never pay the extra round-trip)
 */
function findSiblingPr(
  state: WorkflowState,
  identity: SiblingIdentity,
  taskSlug: string,
  repoDir: string,
  deps: CleanupDeps,
): string {
  const sibKey = identity.sibKey;
  if (!sibKey) return '';

  // 1. Live state row for the sibling.
  const livePr = taskString(state.tasks?.[sibKey], 'pr');
  if (livePr) return livePr;

  // 2. Historical task record keyed by issue.
  const historical = findHistoricalTask(state, sibKey);
  const historicalPr = taskString(historical, 'prNumber') || taskString(historical, 'pr');
  if (historicalPr) return historicalPr;

  // 3. Scan tombstones for one whose `issue` matches the sibling key.
  const tombstones = state.terminalTaskTombstones;
  if (tombstones && typeof tombstones === 'object' && !Array.isArray(tombstones)) {
    for (const value of Object.values(tombstones)) {
      if (value && typeof value === 'object' && (value as TerminalTaskTombstone).issue === sibKey) {
        const tombstonePr = taskString(value as unknown as JsonRecord, 'prNumber');
        if (tombstonePr) return tombstonePr;
      }
    }
  }

  // 4. Scan terminalTaskHistory.challengePairs for inner records matching sibKey.
  const history = state.terminalTaskHistory;
  if (history && typeof history === 'object' && !Array.isArray(history)) {
    const pairs = (history as JsonRecord).challengePairs;
    if (pairs && typeof pairs === 'object' && !Array.isArray(pairs)) {
      for (const pair of Object.values(pairs as Record<string, unknown>)) {
        if (!pair || typeof pair !== 'object' || Array.isArray(pair)) continue;
        for (const inner of Object.values(pair as Record<string, unknown>)) {
          if (!inner || typeof inner !== 'object' || Array.isArray(inner)) continue;
          const record = inner as JsonRecord;
          if (taskString(record, 'issue') !== sibKey) continue;
          const pairPr = taskString(record, 'prNumber') || taskString(record, 'pr');
          if (pairPr) return pairPr;
        }
      }
    }
  }

  // 5. Last resort: ask gh. Only when the row's pair metadata was inferred —
  // a well-formed row that reached this point simply has no sibling.
  if (identity.pairEvidence === 'inferred-from-task-id') {
    const candidates = siblingBranchCandidates(sibKey, taskSlug, identity.role);
    for (const branch of candidates) {
      try {
        const output = deps.gh(['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number', '--limit', '1'], repoDir);
        const parsed = JSON.parse(output);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const entry = parsed[0] as JsonRecord;
          const number = taskString(entry, 'number');
          if (number) return number;
        }
      } catch {
        // Any gh failure (missing CLI, auth, network, no match) → treat as no sibling.
        continue;
      }
    }
  }
  return '';
}

export function buildTerminalTaskTombstone(
  decision: TerminalInboxDecision,
  task: JsonRecord,
  actor: string,
  command: string,
  now: string,
): TerminalTaskTombstone {
  const contract = launchContract(task);
  return {
    schemaVersion: 1,
    issue: decision.issue,
    slug: decision.slug,
    branch: decision.branch,
    worktree: decision.worktree,
    prNumber: decision.prNumber,
    workflowOutcome: decision.workflowOutcome,
    resourceDisposition: decision.resourceDisposition,
    challengePairId: decision.challengePairId,
    challengeRole: decision.challengeRole,
    runEpoch: taskString(contract, 'runEpoch'),
    attempt: taskString(task, 'attempt'),
    ...(taskString(task, 'runId') ? { runId: taskString(task, 'runId') } : {}),
    ...(taskString(task, 'linearSyncedState') ? { linearSyncedState: taskString(task, 'linearSyncedState') } : {}),
    actor,
    command,
    createdAt: now,
    decisionStatus: decision.status,
    decisionReason: decision.refusalReason,
    task,
    pr: decision.pr.number ? decision.pr : undefined,
  };
}

export function tombstoneKey(tombstone: Pick<TerminalTaskTombstone, 'issue' | 'prNumber' | 'runEpoch' | 'attempt' | 'branch'>): string {
  return [tombstone.issue, tombstone.prNumber || tombstone.branch || 'no-pr', tombstone.runEpoch || 'no-epoch', tombstone.attempt || 'no-attempt']
    .join('|');
}

export async function writeTerminalTaskTombstone(
  stateFile: string,
  tombstone: TerminalTaskTombstone,
): Promise<void> {
  // 1. Append full tombstone to archive (HOK-3203)
  const stateDir = dirname(dirname(stateFile));
  appendTombstoneToArchive(stateDir, tombstone as unknown as Record<string, unknown>);

  // 2. Write compact form to hot state (HOK-3203)
  const compactTombstone = compactHotRecord(tombstone as unknown as Record<string, unknown>) as unknown as TerminalTaskTombstone;

  await mutateWorkflowState(stateFile, (state) => {
    const next = state ?? {};
    const key = tombstoneKey(tombstone);
    next.terminalTaskTombstones = { ...(next.terminalTaskTombstones ?? {}), [key]: compactTombstone };
    const history = next.terminalTaskHistory && typeof next.terminalTaskHistory === 'object' && !Array.isArray(next.terminalTaskHistory)
      ? { ...next.terminalTaskHistory }
      : {};
    const tasks = history.tasks && typeof history.tasks === 'object' && !Array.isArray(history.tasks) ? { ...history.tasks as JsonRecord } : {};
    tasks[tombstone.issue] = compactTombstone;
    history.tasks = tasks;
    if (tombstone.challengePairId) {
      const pairs = history.challengePairs && typeof history.challengePairs === 'object' && !Array.isArray(history.challengePairs) ? { ...history.challengePairs as JsonRecord } : {};
      const priorPair = pairs[tombstone.challengePairId];
      const pair = priorPair && typeof priorPair === 'object' && !Array.isArray(priorPair) ? { ...priorPair as JsonRecord } : {};
      pair[tombstone.challengeRole || tombstone.issue] = compactTombstone;
      pairs[tombstone.challengePairId] = pair;
      history.challengePairs = pairs;
    }
    next.terminalTaskHistory = history;
    return next;
  });

  // 3. Enforce byte cap (HOK-3203)
  const byteCap = parseInt(process.env.WAVEMILL_HOT_STATE_BYTE_CAP ?? '', 10) || DEFAULT_BYTE_CAP;
  const result = enforceHotStateByteCap({ stateFile, byteCap, keepFloor: 10 });
  if (result.warning) {
    console.warn(result.warning);
  }
}

/**
 * HOK-3373 ownership proof for the absent-resources reap: the key of another
 * active row that names the same PR number or worktree path, or `''` when the
 * resources belong to this row alone.
 */
export function otherRowOwningResources(state: WorkflowState, issue: string, prNumber: string, worktree: string): string {
  for (const [key, other] of Object.entries(state.tasks ?? {})) {
    if (key === issue || !other || typeof other !== 'object') continue;
    const otherPr = taskString(other as JsonRecord, 'pr');
    const otherWorktree = taskString(other as JsonRecord, 'worktree');
    if (prNumber && otherPr === prNumber) return key;
    if (worktree && otherWorktree === worktree) return key;
  }
  return '';
}

/**
 * HOK-3160: an arm is "delivered" when the PR merged, when a retired sibling
 * carries a merged/closed PR, or when the arm is PR-less and
 * explicitly abandoned. Only delivered arms are archive-and-reap eligible.
 */
function isDelivered(pr: PrEvidence, siblingPrState: string, challengeRole: string, allowAbandon: boolean): boolean {
  if (pr.state === 'MERGED') return true;
  if (pr.state === 'CLOSED' && !pr.mergedAt && challengeRole && (siblingPrState === 'MERGED' || siblingPrState === 'CLOSED')) return true;
  // PR-less abandon is only delivered when the operator asked for it.
  if (!pr.number && allowAbandon) return true;
  return false;
}

/**
 * HOK-3312: a task's lifecycle is terminal when no stage still owns it. For
 * terminal lifecycles the pane is finished by definition, and delivered
 * residue (dirt or an extra unmerged commit on top of a MERGED PR) is
 * archived instead of retained. The allowlist matches the plan's enumeration
 * ('merged | closed | completed | aborted | error | superseded'); unknown
 * values are treated as non-terminal so a mislabelled task never triggers
 * premature archive-and-reap.
 */
const TERMINAL_WORKFLOW_OUTCOMES = new Set([
  'merged',
  'closed',
  'completed',
  'aborted',
  'error',
  'superseded',
]);
function isTerminalLifecycle(task: JsonRecord | undefined, pr: PrEvidence): boolean {
  if (pr.state === 'MERGED') return true;
  const outcome = workflowOutcome(task);
  return outcome !== undefined && TERMINAL_WORKFLOW_OUTCOMES.has(outcome);
}

export interface DecideTerminalTaskOptions {
  deps?: CleanupDeps;
  allowAbandon?: boolean;
  archiveAndReap?: boolean;
  /**
   * HOK-3312: the monitor's terminal-cleanup caller sets this. It forces
   * `archiveAndReap=true` and collapses the "live_agent" / "dirty_worktree"
   * refusals a terminal-lifecycle task cannot reach by construction into
   * `would-archive-and-reap`.
   */
  monitorConsumer?: boolean;
}

export function decideTerminalTask(
  state: WorkflowState,
  issue: string,
  repoDir: string,
  baseBranch: string,
  depsOrOptions: CleanupDeps | DecideTerminalTaskOptions = defaultCleanupDeps,
  allowAbandonArg = false,
  archiveAndReapArg = false,
): TerminalInboxDecision {
  // Back-compat: the positional (deps, allowAbandon, archiveAndReap) signature
  // and the options-bag signature are both accepted. The deps shape carries
  // `git` as a function; the options bag never does.
  const hasDepsShape = depsOrOptions !== undefined
    && typeof (depsOrOptions as CleanupDeps).git === 'function'
    && typeof (depsOrOptions as CleanupDeps).gh === 'function';
  const options: DecideTerminalTaskOptions = hasDepsShape
    ? { deps: depsOrOptions as CleanupDeps, allowAbandon: allowAbandonArg, archiveAndReap: archiveAndReapArg }
    : (depsOrOptions as DecideTerminalTaskOptions);
  const deps = options.deps ?? defaultCleanupDeps;
  const monitorConsumer = options.monitorConsumer === true;
  const allowAbandon = options.allowAbandon ?? false;
  const archiveAndReap = monitorConsumer || (options.archiveAndReap ?? false);
  const task = state.tasks?.[issue];
  if (!task) {
    throw new Error(`task ${issue} is not present in workflow state`);
  }
  const slug = taskString(task, 'slug') || basename(taskString(task, 'worktree')) || issue.toLowerCase();
  const branch = taskString(task, 'branch') || `task/${slug}`;
  const worktree = taskString(task, 'worktree');
  const prNumber = taskString(task, 'pr') || taskString(deliveryEvidence(task), 'prNumber');
  const outcome = workflowOutcome(task);
  const disposition = resourceDisposition(task);
  const hold = retentionHold(task);
  // HOK-3201: a `keep` hold short-circuits every remote fetch so the dashboard
  // can render the kept list without any gh/git cost.
  if (hold === 'keep') {
    const recordedRole = taskString(task, 'challengeRole');
    const recordedPair = taskString(task, 'challengePairId');
    return {
      issue,
      slug,
      branch,
      worktree,
      prNumber,
      status: 'kept',
      refusalReason: 'kept_by_operator',
      workflowOutcome: outcome,
      resourceDisposition: disposition,
      challengeRole: recordedRole,
      challengePairId: recordedPair,
      pairEvidence: recordedRole && recordedPair ? 'task-metadata' : 'none',
      siblingPrNumber: '',
      siblingPrState: '',
      pr: unknownPr(prNumber),
      git: { worktreeExists: false, worktreeDirty: 'unknown', dirtyStatus: '', localBranchExists: false, localHeadSha: '', remoteHeadSha: '', remoteContainsHead: false, commitsAhead: null, patchEquivalent: 'unknown', patchUniqueCount: null, patchEquivalentCount: null },
      pane: { windowId: taskString(task, 'windowId'), paneState: taskString(task, 'paneState') || 'active', paneReleased: taskBoolean(task, 'paneReleased') || taskString(task, 'paneState') === 'released', intendedAction: 'none' },
      intendedActions: [],
      cleanupHold: hold,
    };
  }
  const pr = fetchPr(repoDir, prNumber, task, deps);
  const effectiveBase = taskString(launchContract(task), 'baseBranch') || baseBranch;
  let classified: ClassifyEvidence | undefined;
  if (deps.classify && outcome !== 'active' && pr.state === 'MERGED') {
    try {
      classified = deps.classify({ worktreeDir: worktree, taskBranch: branch, baseBranch: effectiveBase, issue, pr: prNumber }, repoDir);
    } catch {
      classified = { classification: 'retain_unverifiable', verificationReason: 'classifier_unavailable', worktreeIdentity: '', verifiedTopLevel: '', cleanupAuthority: '', patchEquivalenceScope: '' };
    }
  }
  const git = collectGitEvidence(repoDir, task, branch, worktree, effectiveBase, deps, !classified);
  if (classified) {
    git.worktreeIdentity = classified.worktreeIdentity;
    git.verifiedTopLevel = classified.verifiedTopLevel;
    git.classifierVerdict = classified.classification;
  }
  // HOK-3209: resolve the sibling identity through the task-identity helpers
  // when `challengeRole` / `challengePairId` are missing from the row, then run
  // the expanded PR lookup chain. The merged (stored || inferred) values are
  // threaded through every downstream path — isDelivered, the CLOSED-no-merged
  // refusal, the recorded decision — so a row rebuilt from a stub can still
  // retire once its merged sibling is found. A row that cannot find a sibling
  // via inference downgrades to `pairEvidence: 'none'` and keeps the pair
  // fields empty, so a bare primary is still refused exactly as today.
  const recordedRole = taskString(task, 'challengeRole');
  const recordedPair = taskString(task, 'challengePairId');
  const identity = resolveSiblingIdentity(task, issue);
  const sibPr = findSiblingPr(state, identity, slug, repoDir, deps);
  let challengeRole = recordedRole;
  let challengePairId = recordedPair;
  let pairEvidence: TerminalInboxDecision['pairEvidence'] = identity.pairEvidence;
  if (identity.pairEvidence === 'inferred-from-task-id') {
    if (sibPr) {
      challengeRole = recordedRole || identity.role;
      challengePairId = recordedPair || identity.pairId;
    } else {
      // No evidence of a real sibling: don't fabricate pair metadata.
      pairEvidence = 'none';
    }
  }
  const sibEvidence = sibPr
    ? fetchPr(repoDir, sibPr, state.tasks?.[identity.sibKey] ?? findHistoricalTask(state, identity.sibKey), deps)
    : unknownPr();
  const paneReleased = taskBoolean(task, 'paneReleased') || taskString(task, 'paneState') === 'released';

  const decision: TerminalInboxDecision = {
    issue,
    slug,
    branch,
    worktree,
    prNumber,
    status: 'refused',
    refusalReason: '',
    workflowOutcome: outcome,
    resourceDisposition: disposition,
    challengeRole,
    challengePairId,
    pairEvidence,
    siblingPrNumber: sibPr,
    siblingPrState: sibEvidence.state,
    pr,
    git,
    pane: {
      windowId: taskString(task, 'windowId'),
      paneState: taskString(task, 'paneState') || 'active',
      paneReleased,
      intendedAction: paneReleased ? 'none' : 'release',
    },
    intendedActions: [],
    cleanupHold: hold,
  };

  if (disposition === 'reaped') {
    decision.status = 'already-reaped';
    decision.refusalReason = 'resources_already_reaped';
    return decision;
  }
  if (!isTerminalTask(task) || outcome === 'active' || pr.state === 'OPEN') {
    decision.status = outcome === 'active' ? 'not-terminal' : 'refused';
    decision.refusalReason = pr.state === 'OPEN' ? 'pr_open' : 'workflow_active';
    return decision;
  }
  if (pr.baseRefName && pr.baseRefName !== effectiveBase) {
    decision.refusalReason = 'pr_base_mismatch';
    return decision;
  }
  if (classified) {
    // HOK-3373 positive-evidence reap for absent resources: delivery is
    // proven (we only classify a MERGED PR on a non-active run), the shell
    // verdict proves nothing unpublished remains locally (no local branch, no
    // live worktree), and ownership is proven here: no other row claims this
    // PR or worktree. A surviving remote branch never blocks removal.
    if (classified.classification === 'safe_resources_absent') {
      const owner = otherRowOwningResources(state, issue, prNumber, worktree);
      if (owner) {
        decision.refusalReason = `resources_owned_by:${owner}`;
        return decision;
      }
      decision.status = 'would-reap';
      decision.intendedActions = ['archive-artifacts', 'release-pane', 'write-tombstone', 'remove-active-task-row'];
      return decision;
    }
    if (['safe_ancestor', 'safe_terminal_pr_head', 'safe_patch_equivalent_pr', 'safe_content_equivalent_pr'].includes(classified.classification)) {
      decision.status = 'would-reap';
      decision.intendedActions = ['archive-artifacts', 'release-pane', 'write-tombstone', 'remove-local-worktree', 'remove-local-branch', 'remove-active-task-row'];
    } else {
      decision.refusalReason = classified.verificationReason || classified.classification || 'classifier_unavailable';
    }
    return decision;
  }
  if (git.worktreeDirty === true || git.worktreeDirty === 'unknown') {
    // HOK-3160: with --archive-and-reap, a delivered arm with real dirt still
    // reaps — the dirt gets archived to .wavemill/evals/artifacts/<ID>/
    // retired-arm-residue/ before any destructive step. Unreadable status
    // stays fail-closed: we cannot archive what we cannot inspect.
    if (archiveAndReap && git.worktreeDirty === true && isDelivered(pr, sibEvidence.state, challengeRole, allowAbandon)) {
      decision.status = 'would-archive-and-reap';
      decision.refusalReason = '';
      decision.intendedActions = ['archive-residue', 'archive-artifacts', 'release-pane', 'write-tombstone', 'remove-local-worktree', 'remove-local-branch', 'remove-active-task-row'];
      return decision;
    }
    // HOK-3312: for the monitor consumer, a terminal-lifecycle task with real
    // dirt is already delivered by lifecycle — archive residue and reap. A
    // worktree whose status is unreadable still fails closed.
    if (monitorConsumer && git.worktreeDirty === true && isTerminalLifecycle(task, pr)) {
      decision.status = 'would-archive-and-reap';
      decision.refusalReason = '';
      decision.intendedActions = ['archive-residue', 'archive-artifacts', 'release-pane', 'write-tombstone', 'remove-local-worktree', 'remove-local-branch', 'remove-active-task-row'];
      return decision;
    }
    decision.refusalReason = git.worktreeDirty === 'unknown' ? 'worktree_status_unreadable' : 'dirty_worktree';
    return decision;
  }
  if (!prNumber && (outcome === 'aborted' || outcome === 'error')) {
    return decidePrLessAbortedArm(decision, git, allowAbandon, archiveAndReap);
  }
  if (!prNumber || pr.state === 'UNKNOWN') {
    decision.refusalReason = 'pr_state_unverifiable';
    return decision;
  }
  if (pr.baseRefName && pr.baseRefName !== (taskString(launchContract(task), 'baseBranch') || baseBranch)) {
    decision.refusalReason = 'pr_base_mismatch';
    return decision;
  }
  if (pr.state === 'MERGED') {
    if (!git.localBranchExists || git.commitsAhead === 0 || git.localHeadSha === pr.headRefOid || git.patchEquivalent === true) {
      decision.status = 'would-reap';
      decision.refusalReason = '';
      decision.intendedActions = ['archive-artifacts', 'release-pane', 'write-tombstone', 'remove-local-worktree', 'remove-local-branch', 'remove-active-task-row'];
      return decision;
    }
    // HOK-3201: a merged arm whose local branch carries a non-equivalent extra
    // commit (self-review residue, HOK-3177 shape) is delivered: with
    // archiveAndReap we snapshot the unpublished patch to the residue archive
    // and reap. Without the flag, surface the refusal for operator review.
    if (archiveAndReap && git.patchEquivalent === false && isDelivered(pr, sibEvidence.state, challengeRole, allowAbandon)) {
      decision.status = 'would-archive-and-reap';
      decision.refusalReason = '';
      decision.intendedActions = ['archive-residue', 'archive-artifacts', 'release-pane', 'write-tombstone', 'remove-local-worktree', 'remove-local-branch', 'remove-active-task-row'];
      return decision;
    }
    decision.refusalReason = git.patchEquivalent === false ? 'unique_local_patch' : 'merged_delivery_unverified';
    return decision;
  }
  if (pr.state === 'CLOSED' && !pr.mergedAt) {
    if (!challengeRole || !challengePairId || !sibPr || sibEvidence.state !== 'MERGED') {
      decision.refusalReason = 'closed_loser_sibling_not_merged';
      return decision;
    }
    if (!git.remoteContainsHead && (!pr.headRefOid || pr.headRefOid !== git.localHeadSha)) {
      // HOK-3201: a losing challenger with an unpushed head is delivered via
      // its MERGED sibling. With archiveAndReap we snapshot the discarded
      // branch tip to the residue archive instead of waiting on an operator.
      if (archiveAndReap && isDelivered(pr, sibEvidence.state, challengeRole, allowAbandon)) {
        decision.status = 'would-archive-and-reap';
        decision.refusalReason = '';
        decision.intendedActions = ['archive-residue', 'archive-artifacts', 'release-pane', 'write-tombstone', 'remove-local-worktree', 'remove-local-branch', 'retain-remote-branch', 'remove-active-task-row'];
        return decision;
      }
      decision.refusalReason = 'closed_loser_head_unpublished';
      return decision;
    }
    if (!allowAbandon) {
      decision.refusalReason = 'closed_loser_requires_abandon';
      return decision;
    }
    decision.status = 'would-abandon-loser';
    decision.refusalReason = '';
    decision.intendedActions = ['archive-artifacts', 'release-pane', 'write-tombstone', 'remove-local-worktree', 'remove-local-branch', 'retain-remote-branch', 'remove-active-task-row'];
    return decision;
  }

  decision.refusalReason = `unsupported_pr_state_${pr.state.toLowerCase()}`;
  return decision;
}

/**
 * HOK-3089: a PR-less aborted/errored arm. Work that is already delivered or
 * published (no local branch, nothing ahead of base, or the remote carries the
 * head) is reaped like any delivered task. An unpublished head needs explicit
 * operator `--abandon`; the shell cleanup then archives the head to
 * `refs/archive/wavemill/<issue>` before deleting anything (it fails closed if
 * that push fails), which is the same path the monitor takes once the arm's
 * sibling PR has merged. The caller has already refused dirty worktrees.
 */
function decidePrLessAbortedArm(decision: TerminalInboxDecision, git: GitEvidence, allowAbandon: boolean, archiveAndReap: boolean): TerminalInboxDecision {
  const reapActions = ['archive-artifacts', 'release-pane', 'write-tombstone', 'remove-local-worktree', 'remove-local-branch', 'remove-active-task-row'];
  if (!git.localBranchExists || git.commitsAhead === 0 || git.remoteContainsHead) {
    decision.status = 'would-reap';
    decision.intendedActions = reapActions;
    return decision;
  }
  if (!allowAbandon) {
    // HOK-3201: a PR-less aborted arm with unpublished commits is delivered —
    // its work was discarded by abort, nothing is lost by archiving to disk.
    // archiveAndReap implies abandon authority inside cleanupTerminalInbox,
    // which satisfies HOK-3089's "no silent discard" rule via the archive.
    if (archiveAndReap) {
      decision.status = 'would-archive-and-reap';
      decision.intendedActions = ['archive-residue', 'archive-unpublished-head', ...reapActions];
      return decision;
    }
    decision.refusalReason = 'aborted_pr_less_requires_abandon';
    return decision;
  }
  decision.status = 'would-abandon-aborted';
  decision.intendedActions = ['archive-unpublished-head', ...reapActions];
  return decision;
}

function isExecutable(status: TerminalInboxStatus): boolean {
  return (
    status === 'would-reap'
    || status === 'would-abandon-loser'
    || status === 'would-abandon-aborted'
    || status === 'would-archive-and-reap'
  );
}

/**
 * HOK-3160: when the decision calls for archive-and-reap, archive the
 * worktree residue BEFORE the destructive shell cleanup. Returns the
 * archive result; the caller must retain the task if `success` is false.
 */
function runArchiveResidueStep(decision: TerminalInboxDecision, context: CleanupExecuteContext): ArchiveTaskResidueResult {
  return archiveTaskResidue({
    issue: decision.issue,
    worktree: decision.worktree,
    repoDir: context.repoDir,
    branch: decision.branch,
    baseBranch: context.baseBranch,
    prNumber: decision.prNumber,
  });
}

/**
 * HOK-3201: set or clear the operator-driven `keep` hold on a terminal task.
 * A `keep` hold short-circuits every decision in `decideTerminalTask`, so the
 * unattended cleanup never auto-reaps the task even once its only residue is
 * dirt or an unpushed commit.
 *
 * `hold: 'keep'` sets `lifecycle.retention.hold = 'keep'` and records who/why.
 * `hold: null` clears the hold (and the retention metadata when the retention
 * block has no other content).
 *
 * The write is atomic through `mutateWorkflowState`; callers must emit the
 * operator event (`keep` / `unkeep`) separately so the HOK-3172 reconciler
 * and the monitor cadence throttle wake up on the next tick.
 */
export interface SetKeepHoldOptions {
  issue: string;
  repoDir: string;
  stateFile?: string;
  hold: 'keep' | null;
  reason?: string;
  actor?: string;
  now?(): string;
}

export interface SetKeepHoldResult {
  issue: string;
  hold: 'keep' | '';
  reason: string;
}

export async function setTerminalTaskKeepHold(options: SetKeepHoldOptions): Promise<SetKeepHoldResult> {
  const repoDir = resolve(options.repoDir);
  const stateFile = statePath(repoDir, options.stateFile);
  if (!existsSync(stateFile)) {
    throw new Error(`workflow state file not found: ${stateFile}`);
  }
  const now = (options.now ?? (() => new Date().toISOString()))();
  const actor = options.actor ?? 'operator';
  const reason = options.reason ?? '';
  await mutateWorkflowState(stateFile, (state) => {
    const next = state ?? {};
    const tasks = next.tasks ?? {};
    if (!tasks[options.issue]) {
      throw new Error(`task ${options.issue} is not present in workflow state`);
    }
    const task = { ...(tasks[options.issue] as JsonRecord) };
    const lifecycleObj = (task.lifecycle && typeof task.lifecycle === 'object' && !Array.isArray(task.lifecycle))
      ? { ...(task.lifecycle as JsonRecord) }
      : {};
    const retention = (lifecycleObj.retention && typeof lifecycleObj.retention === 'object' && !Array.isArray(lifecycleObj.retention))
      ? { ...(lifecycleObj.retention as JsonRecord) }
      : {};
    if (options.hold === 'keep') {
      retention.hold = 'keep';
      retention.setBy = actor;
      retention.setAt = now;
      if (reason) retention.reason = reason;
      lifecycleObj.retention = retention;
    } else {
      // Clear every field this helper writes on `keep`. A pre-existing
      // retention.reason set by another code path (e.g.
      // set_task_lifecycle_disposition) survives only when the previous
      // state had no `setBy` — i.e. the reason was not written by us.
      const operatorOwned = typeof retention.setBy === 'string' && retention.setBy.length > 0;
      delete retention.hold;
      delete retention.setBy;
      delete retention.setAt;
      if (operatorOwned) {
        delete retention.reason;
      }
      if (Object.keys(retention).length === 0) {
        delete lifecycleObj.retention;
      } else {
        lifecycleObj.retention = retention;
      }
    }
    task.lifecycle = lifecycleObj;
    task.updated = now;
    tasks[options.issue] = task;
    next.tasks = tasks;
    return next;
  });
  return {
    issue: options.issue,
    hold: options.hold === 'keep' ? 'keep' : '',
    reason: options.hold === 'keep' ? reason : '',
  };
}


export function discoverTerminalInboxIssues(state: WorkflowState): string[] {
  return Object.entries(state.tasks ?? {})
    .filter(([, task]) => isTerminalTask(task) && resourceDisposition(task) !== 'reaped')
    .map(([issue]) => issue)
    .sort();
}

export function writeDecisionArtifact(repoDir: string, decision: TerminalInboxDecision, now: string, out?: string): string {
  const dir = out ? dirname(resolve(repoDir, out)) : join(repoDir, '.wavemill', 'terminal-inbox-cleanup');
  mkdirSync(dir, { recursive: true });
  const safeNow = now.replace(/[:.]/g, '-');
  const path = out ? resolve(repoDir, out) : join(dir, `${decision.issue}-${safeNow}.json`);
  writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, createdAt: now, decision }, null, 2)}\n`, 'utf-8');
  return path;
}

export async function cleanupTerminalInbox(options: CleanupOptions): Promise<TerminalInboxDecision[]> {
  const deps = options.deps ?? defaultCleanupDeps;
  const repoDir = resolve(options.repoDir);
  const stateFile = statePath(repoDir, options.stateFile);
  const baseBranch = options.baseBranch ?? 'auto/integration';
  const initial = readCleanupState(stateFile);
  const issues = options.inbox ? discoverTerminalInboxIssues(initial) : [options.issue ?? ''];
  if (!options.inbox && (!options.issue || !issuePattern.test(options.issue))) {
    throw new Error('cleanup requires either inbox or a valid issue id');
  }

  const decisions: TerminalInboxDecision[] = [];
  // HOK-3201: when the unattended monitor calls the inbox executor it wants
  // every refusal that lives on a terminal, delivered arm to auto-promote to
  // archive-and-reap. The dry-run surface (no --execute) keeps the original
  // refusal reasons so operators can still inspect them.
  const inboxExecute = options.inbox === true && options.execute === true;
  for (const issue of issues) {
    if (!issue) continue;
    const state = readCleanupState(stateFile);
    const archiveAndReap = options.archiveAndReap === true && !options.inbox;
    // HOK-3160: --archive-and-reap implies the abandon authority a PR-less
    // arm needs; the residue archive includes a bundle of its unpublished
    // commits so the HOK-3089 "no silent discard" rule still holds.
    const abandon = (options.abandon === true || archiveAndReap) && !options.inbox;
    let decision = decideTerminalTask(state, issue, repoDir, baseBranch, deps, abandon, archiveAndReap);
    // HOK-3201: convert a safe refusal into archive-and-reap for the
    // unattended inbox path. Grant abandon authority here too, so the
    // archive step owns the unpublished-head rescue the same way
    // `--abandon` does for an operator.
    if (inboxExecute && decision.status === 'refused' && INBOX_AUTO_ARCHIVE_REFUSALS.has(decision.refusalReason)) {
      const retry = decideTerminalTask(state, issue, repoDir, baseBranch, deps, true, true);
      if (retry.status === 'would-archive-and-reap') {
        decision = retry;
      }
    }
    const now = deps.now();
    if (options.execute || options.out) {
      writeDecisionArtifact(repoDir, decision, now, options.out && issues.length === 1 ? options.out : undefined);
    }
    if (options.execute && isExecutable(decision.status)) {
      const task = state.tasks?.[issue];
      if (!task) throw new Error(`task ${issue} disappeared before execution`);
      // HOK-3201: an inbox-execute that promoted a refusal to
      // would-archive-and-reap also needs the executor context to carry the
      // archive flag so the destructive cleanup resets the dirty tree first
      // and takes abandon authority for a PR-less head.
      const decisionArchives = decision.status === 'would-archive-and-reap';
      const context: CleanupExecuteContext = {
        repoDir,
        stateFile,
        baseBranch,
        session: initial.session ?? process.env.SESSION ?? 'wavemill',
        abandon: abandon || decisionArchives,
        archiveAndReap: archiveAndReap || decisionArchives,
      };
      // HOK-3160: run the archive step FIRST. A failure retains the task:
      // the destructive cleanup and the tombstone are skipped.
      if (decision.status === 'would-archive-and-reap') {
        const archiveResult = runArchiveResidueStep(decision, context);
        if (!archiveResult.success) {
          decisions.push({ ...decision, status: 'refused', refusalReason: archiveResult.failureReason || 'archive_failed' });
          continue;
        }
        decision.archive = {
          path: archiveResult.archivePath,
          diffPath: archiveResult.diffPath,
          bundlePath: archiveResult.bundlePath,
          untrackedCount: archiveResult.untrackedCount,
        };
      }
      const tombstone = buildTerminalTaskTombstone(decision, task, 'cleanup-terminal-inbox', options.inbox ? 'cleanup inbox --execute' : `cleanup ${issue} --execute`, now);
      await writeTerminalTaskTombstone(stateFile, tombstone);
      deps.cleanup(decision, context);
      decisions.push({ ...decision, status: 'executed' });
    } else {
      decisions.push(decision);
    }
  }
  return decisions;
}

/**
 * HOK-3160: the stable 24h hard-ceiling fingerprint. Any terminal task that
 * remained retained for more than 24h after delivery is collapsed into a
 * single `needs decision` cleanup row suggesting `--archive-and-reap`.
 */
export const CLEANUP_CEILING_HOURS = 24;

function deliveryTimestamp(decision: TerminalInboxDecision): number | undefined {
  if (decision.pr.state === 'MERGED' && decision.pr.mergedAt) {
    const parsed = Date.parse(decision.pr.mergedAt);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export interface FormatterContext {
  /** `now` injection for deterministic tests. Defaults to `Date.now`. */
  nowMs?(): number;
}

function isDeliveredAndArchived(decision: TerminalInboxDecision): boolean {
  if (decision.status !== 'already-reaped' && decision.status !== 'executed') return false;
  return decision.resourceDisposition === 'reaped';
}

function isAwaitingConfirm(decision: TerminalInboxDecision): boolean {
  return decision.status === 'refused' && decision.resourceDisposition === 'verification-required' && decision.pr.state === 'MERGED';
}

function retainedBeyondCeiling(decision: TerminalInboxDecision, nowMs: number): boolean {
  if (decision.status !== 'refused') return false;
  const delivered = deliveryTimestamp(decision);
  if (delivered === undefined) return false;
  const hoursSinceDelivery = (nowMs - delivered) / (1000 * 60 * 60);
  return hoursSinceDelivery > CLEANUP_CEILING_HOURS;
}

export function formatTerminalInboxDecisions(
  decisions: TerminalInboxDecision[],
  execute: boolean,
  context: FormatterContext = {},
): string {
  const nowMs = (context.nowMs ?? (() => Date.now()))();
  const lines = ['action\tissue\tpr\tbranch\treason'];
  let archivedCount = 0;
  let awaitingConfirmCount = 0;
  let ceilingCount = 0;
  for (const decision of decisions) {
    if (isDeliveredAndArchived(decision)) {
      archivedCount += 1;
      continue;
    }
    if (isAwaitingConfirm(decision)) {
      awaitingConfirmCount += 1;
      lines.push([
        'merged-awaiting-confirm',
        decision.issue,
        decision.prNumber ? `#${decision.prNumber}` : '-',
        decision.branch || '-',
        'close-to-finish',
      ].join('\t'));
      continue;
    }
    if (retainedBeyondCeiling(decision, nowMs)) {
      ceilingCount += 1;
      lines.push([
        'needs-decision',
        decision.issue,
        decision.prNumber ? `#${decision.prNumber}` : '-',
        decision.branch || '-',
        `wavemill cleanup ${decision.issue} --archive-and-reap --execute`,
      ].join('\t'));
      continue;
    }
    const action = execute && isExecutable(decision.status) ? 'execute' : decision.status;
    lines.push([
      action,
      decision.issue,
      decision.prNumber ? `#${decision.prNumber}` : '-',
      decision.branch || '-',
      decision.refusalReason || '-',
    ].join('\t'));
  }
  if (archivedCount > 0) {
    lines.push(`aggregate\t${archivedCount} task${archivedCount === 1 ? '' : 's'} delivered and archived`);
  }
  const counts = decisions.reduce<Record<string, number>>((acc, decision) => {
    acc[decision.status] = (acc[decision.status] ?? 0) + 1;
    return acc;
  }, {});
  if (awaitingConfirmCount > 0) counts['merged-awaiting-confirm'] = awaitingConfirmCount;
  if (ceilingCount > 0) counts['needs-decision'] = ceilingCount;
  lines.push(`summary\t${Object.entries(counts).map(([status, count]) => `${status}=${count}`).join(',') || 'none'}`);
  return lines.join('\n');
}
