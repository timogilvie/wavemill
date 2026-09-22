import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { mutateJsonState } from './state-mutex.ts';

export type JsonRecord = Record<string, unknown>;

export interface WorkflowState {
  session?: string;
  tasks?: Record<string, JsonRecord>;
  terminalTaskHistory?: JsonRecord;
  terminalTaskTombstones?: Record<string, TerminalTaskTombstone>;
  [key: string]: unknown;
}

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
  | 'refused'
  | 'already-reaped'
  | 'not-terminal'
  | 'executed';

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
}

export interface CleanupOptions {
  repoDir: string;
  stateFile?: string;
  issue?: string;
  inbox?: boolean;
  execute?: boolean;
  abandon?: boolean;
  json?: boolean;
  out?: string;
  baseBranch?: string;
  deps?: CleanupDeps;
}

const terminalStatuses = new Set(['merged', 'complete', 'completed', 'completed-external', 'closed', 'done', 'aborted', 'error', 'superseded']);
const issuePattern = /^[A-Z][A-Z0-9]+-[0-9]+(_c)?$/;

export const defaultCleanupDeps: CleanupDeps = {
  git(args, cwd) {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  },
  gh(args, cwd) {
    return execFileSync('gh', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  },
  classify(request, repoDir) {
    try {
      const script = [
        'set -euo pipefail',
        `source "${join(repoDir, 'shared/lib/wavemill-common.sh').replace(/"/g, '\\"')}"`,
        `wavemill_classify_task_cleanup "${(request.worktreeDir || '').replace(/"/g, '\\"')}" "${request.taskBranch.replace(/"/g, '\\"')}" "${request.baseBranch.replace(/"/g, '\\"')}" "classify" "${(request.issue || '').replace(/"/g, '\\"')}" "${(request.pr || '').replace(/"/g, '\\"')}"`,
      ].join('\n');
      const output = execFileSync('bash', ['-lc', script], { cwd: repoDir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
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
    const script = [
      'set -euo pipefail',
      `source "${join(context.repoDir, 'shared/lib/wavemill-common.sh').replace(/"/g, '\\"')}"`,
      `source "${join(context.repoDir, 'shared/lib/terminal-reconciler.sh').replace(/"/g, '\\"')}"`,
      `cleanup_completed_task "${decision.issue.replace(/"/g, '\\"')}" "${decision.slug.replace(/"/g, '\\"')}" "operator terminal inbox cleanup"`,
    ].join('\n');
    const env = {
      ...process.env,
      REPO_DIR: context.repoDir,
      STATE_FILE: context.stateFile,
      SESSION: context.session,
      BASE_BRANCH: context.baseBranch,
      WORKTREE_ROOT: dirname(decision.worktree || context.repoDir),
      WAVEMILL_CLEANUP_ABANDON_ISSUE: context.abandon ? decision.issue : '',
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

export function readWorkflowState(path: string): WorkflowState {
  if (!existsSync(path)) return { tasks: {} };
  return JSON.parse(readFileSync(path, 'utf-8')) as WorkflowState;
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

function collectGitEvidence(repoDir: string, task: JsonRecord | undefined, branch: string, worktree: string, baseBranch: string, deps: CleanupDeps): GitEvidence {
  const worktreeExists = Boolean(worktree && existsSync(worktree));
  let dirtyStatus = '';
  let worktreeDirty: boolean | 'unknown' = false;
  if (worktreeExists) {
    const status = safeGit(deps, ['-C', worktree, 'status', '--porcelain', '--untracked-files=all'], repoDir);
    if (status === undefined) {
      worktreeDirty = 'unknown';
    } else {
      dirtyStatus = status.trim();
      worktreeDirty = dirtyStatus.length > 0;
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
  return role === 'primary' ? `${pairId}_c` : pairId;
}

function findHistoricalTask(state: WorkflowState, issue: string): JsonRecord | undefined {
  const history = state.terminalTaskHistory;
  if (!history || typeof history !== 'object' || Array.isArray(history)) return undefined;
  const tasks = (history as JsonRecord).tasks;
  if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) return undefined;
  const value = (tasks as Record<string, unknown>)[issue];
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function siblingPr(state: WorkflowState, task: JsonRecord | undefined, issue: string): string {
  const role = taskString(task, 'challengeRole');
  const pairId = taskString(task, 'challengePairId');
  const key = siblingKey(issue, role, pairId);
  if (!key) return '';
  return taskString(state.tasks?.[key], 'pr') || taskString(findHistoricalTask(state, key), 'prNumber') || taskString(findHistoricalTask(state, key), 'pr');
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
  await mutateJsonState<WorkflowState>(stateFile, (state) => {
    const next = state ?? {};
    const key = tombstoneKey(tombstone);
    next.terminalTaskTombstones = { ...(next.terminalTaskTombstones ?? {}), [key]: tombstone };
    const history = next.terminalTaskHistory && typeof next.terminalTaskHistory === 'object' && !Array.isArray(next.terminalTaskHistory)
      ? { ...next.terminalTaskHistory }
      : {};
    const tasks = history.tasks && typeof history.tasks === 'object' && !Array.isArray(history.tasks) ? { ...history.tasks as JsonRecord } : {};
    tasks[tombstone.issue] = tombstone;
    history.tasks = tasks;
    if (tombstone.challengePairId) {
      const pairs = history.challengePairs && typeof history.challengePairs === 'object' && !Array.isArray(history.challengePairs) ? { ...history.challengePairs as JsonRecord } : {};
      const priorPair = pairs[tombstone.challengePairId];
      const pair = priorPair && typeof priorPair === 'object' && !Array.isArray(priorPair) ? { ...priorPair as JsonRecord } : {};
      pair[tombstone.challengeRole || tombstone.issue] = tombstone;
      pairs[tombstone.challengePairId] = pair;
      history.challengePairs = pairs;
    }
    next.terminalTaskHistory = history;
    return next;
  });
}

export function decideTerminalTask(
  state: WorkflowState,
  issue: string,
  repoDir: string,
  baseBranch: string,
  deps: CleanupDeps = defaultCleanupDeps,
  allowAbandon = false,
): TerminalInboxDecision {
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
  const pr = fetchPr(repoDir, prNumber, task, deps);
  const git = collectGitEvidence(repoDir, task, branch, worktree, taskString(launchContract(task), 'baseBranch') || baseBranch, deps);
  const challengeRole = taskString(task, 'challengeRole');
  const challengePairId = taskString(task, 'challengePairId');
  const sibPr = siblingPr(state, task, issue);
  const sibEvidence = sibPr ? fetchPr(repoDir, sibPr, state.tasks?.[siblingKey(issue, challengeRole, challengePairId)] ?? findHistoricalTask(state, siblingKey(issue, challengeRole, challengePairId)), deps) : unknownPr();
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
  if (git.worktreeDirty === true || git.worktreeDirty === 'unknown') {
    decision.refusalReason = git.worktreeDirty === 'unknown' ? 'worktree_status_unreadable' : 'dirty_worktree';
    return decision;
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
    decision.refusalReason = git.patchEquivalent === false ? 'unique_local_patch' : 'merged_delivery_unverified';
    return decision;
  }
  if (pr.state === 'CLOSED' && !pr.mergedAt) {
    if (!challengeRole || !challengePairId || !sibPr || sibEvidence.state !== 'MERGED') {
      decision.refusalReason = 'closed_loser_sibling_not_merged';
      return decision;
    }
    if (!git.remoteContainsHead && (!pr.headRefOid || pr.headRefOid !== git.localHeadSha)) {
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
  const initial = readWorkflowState(stateFile);
  const issues = options.inbox ? discoverTerminalInboxIssues(initial) : [options.issue ?? ''];
  if (!options.inbox && (!options.issue || !issuePattern.test(options.issue))) {
    throw new Error('cleanup requires either inbox or a valid issue id');
  }

  const decisions: TerminalInboxDecision[] = [];
  for (const issue of issues) {
    if (!issue) continue;
    const state = readWorkflowState(stateFile);
    const decision = decideTerminalTask(state, issue, repoDir, baseBranch, deps, options.abandon === true && !options.inbox);
    const now = deps.now();
    if (options.execute || options.out) {
      writeDecisionArtifact(repoDir, decision, now, options.out && issues.length === 1 ? options.out : undefined);
    }
    if (options.execute && (decision.status === 'would-reap' || decision.status === 'would-abandon-loser')) {
      const task = state.tasks?.[issue];
      if (!task) throw new Error(`task ${issue} disappeared before execution`);
      const tombstone = buildTerminalTaskTombstone(decision, task, 'cleanup-terminal-inbox', options.inbox ? 'cleanup inbox --execute' : `cleanup ${issue} --execute`, now);
      await writeTerminalTaskTombstone(stateFile, tombstone);
      deps.cleanup(decision, {
        repoDir,
        stateFile,
        baseBranch,
        session: initial.session ?? process.env.SESSION ?? 'wavemill',
        abandon: options.abandon === true && !options.inbox,
      });
      decisions.push({ ...decision, status: 'executed' });
    } else {
      decisions.push(decision);
    }
  }
  return decisions;
}

export function formatTerminalInboxDecisions(decisions: TerminalInboxDecision[], execute: boolean): string {
  const lines = ['action\tissue\tpr\tbranch\treason'];
  for (const decision of decisions) {
    const action = execute && (decision.status === 'would-reap' || decision.status === 'would-abandon-loser') ? 'execute' : decision.status;
    lines.push([
      action,
      decision.issue,
      decision.prNumber ? `#${decision.prNumber}` : '-',
      decision.branch || '-',
      decision.refusalReason || '-',
    ].join('\t'));
  }
  const counts = decisions.reduce<Record<string, number>>((acc, decision) => {
    acc[decision.status] = (acc[decision.status] ?? 0) + 1;
    return acc;
  }, {});
  lines.push(`summary\t${Object.entries(counts).map(([status, count]) => `${status}=${count}`).join(',') || 'none'}`);
  return lines.join('\n');
}
