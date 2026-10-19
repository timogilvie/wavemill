import { join } from 'node:path';
import { errorMessage } from './error-utils.ts';
import { listRemoteTaskBranches } from './tend-challenge-gate.ts';
import { execArgvCommand } from './shell-utils.ts';
import { readWorkflowState, workflowTaskEntries } from './workflow-state.ts';

export interface PrRef {
  number: number;
  state: string;
  mergedAt?: string | null;
  url?: string | null;
}

export interface StaleBranchDeps {
  listRemoteTaskBranches(repoDir: string): string[];
  listPullRequestsForBranch(branch: string, repoDir: string): PrRef[];
  localBranchExists(branch: string, repoDir: string): boolean;
  worktreeBranches(repoDir: string): Set<string>;
  activeWorkflowBranches(repoDir: string): Set<string>;
  deleteRemoteBranch(branch: string, repoDir: string): void;
}

export type StaleBranchStatus =
  | 'stale-merged'
  | 'closed-unmerged'
  | 'open-pr'
  | 'no-pr'
  | 'local-live';

export interface StaleBranchRecord {
  branch: string;
  status: StaleBranchStatus;
  prs: PrRef[];
  reasons: string[];
}

export interface StaleBranchCleanupOptions {
  execute?: boolean;
  includeClosed?: boolean;
}

export interface StaleBranchCleanupResult {
  deleted: string[];
  skipped: StaleBranchRecord[];
  failed: Array<{ branch: string; error: string }>;
}

const defaultDeps: StaleBranchDeps = {
  listRemoteTaskBranches,
  listPullRequestsForBranch: defaultListPullRequestsForBranch,
  localBranchExists: defaultLocalBranchExists,
  worktreeBranches: defaultWorktreeBranches,
  activeWorkflowBranches: defaultActiveWorkflowBranches,
  deleteRemoteBranch: defaultDeleteRemoteBranch,
};

export function auditStaleTaskBranches(
  repoDir: string,
  deps: Partial<StaleBranchDeps> = {},
): StaleBranchRecord[] {
  const resolvedDeps = { ...defaultDeps, ...deps };
  const localBranches = new Set<string>();
  const worktreeBranches = resolvedDeps.worktreeBranches(repoDir);
  const activeBranches = resolvedDeps.activeWorkflowBranches(repoDir);

  const records = resolvedDeps.listRemoteTaskBranches(repoDir)
    .filter((branch) => branch.startsWith('task/'))
    .sort((a, b) => a.localeCompare(b))
    .map((branch): StaleBranchRecord => {
      const reasons: string[] = [];
      if (resolvedDeps.localBranchExists(branch, repoDir)) {
        localBranches.add(branch);
      }
      const prs = resolvedDeps.listPullRequestsForBranch(branch, repoDir);
      const locallyLive = localBranches.has(branch)
        || worktreeBranches.has(branch)
        || activeBranches.has(branch);

      if (locallyLive) {
        if (localBranches.has(branch)) reasons.push('local branch exists');
        if (worktreeBranches.has(branch)) reasons.push('branch is checked out in a worktree');
        if (activeBranches.has(branch)) reasons.push('branch is active in workflow state');
        return { branch, status: 'local-live', prs, reasons };
      }

      if (prs.some((pr) => pr.state === 'OPEN')) {
        return { branch, status: 'open-pr', prs, reasons: ['open PR exists'] };
      }
      if (prs.length === 0) {
        return { branch, status: 'no-pr', prs, reasons: ['no PR found for branch'] };
      }
      if (prs.some(isMergedPr)) {
        return { branch, status: 'stale-merged', prs, reasons: ['merged PR and no local liveness'] };
      }
      if (prs.every((pr) => pr.state === 'CLOSED')) {
        return { branch, status: 'closed-unmerged', prs, reasons: ['all PRs are closed without merge'] };
      }
      return { branch, status: 'no-pr', prs, reasons: ['no merged or open PR found'] };
    });

  return records;
}

export function cleanupStaleTaskBranches(
  records: StaleBranchRecord[],
  options: StaleBranchCleanupOptions,
  deps: Pick<StaleBranchDeps, 'deleteRemoteBranch'>,
  repoDir = process.cwd(),
): StaleBranchCleanupResult {
  const result: StaleBranchCleanupResult = { deleted: [], skipped: [], failed: [] };
  const deleteStatuses = new Set<StaleBranchStatus>(['stale-merged']);
  if (options.includeClosed === true) {
    deleteStatuses.add('closed-unmerged');
  }

  for (const record of records) {
    if (!record.branch.startsWith('task/') || !deleteStatuses.has(record.status)) {
      result.skipped.push(record);
      continue;
    }
    if (options.execute !== true) {
      result.skipped.push(record);
      continue;
    }
    try {
      deps.deleteRemoteBranch(record.branch, repoDir);
      result.deleted.push(record.branch);
    } catch (error) {
      result.failed.push({ branch: record.branch, error: errorMessage(error) });
    }
  }

  return result;
}

export function cleanupAuditedStaleTaskBranches(
  repoDir: string,
  records: StaleBranchRecord[],
  options: StaleBranchCleanupOptions = {},
  deps: Partial<StaleBranchDeps> = {},
): StaleBranchCleanupResult {
  return cleanupStaleTaskBranches(records, options, { ...defaultDeps, ...deps }, repoDir);
}

function isMergedPr(pr: PrRef): boolean {
  return pr.state === 'MERGED' || Boolean(pr.mergedAt);
}

function defaultListPullRequestsForBranch(branch: string, repoDir: string): PrRef[] {
  const result = execArgvCommand('gh', [
    'pr',
    'list',
    '--head',
    branch,
    '--state',
    'all',
    '--json',
    'number,state,mergedAt,url',
  ], { cwd: repoDir, encoding: 'utf-8' });
  if (result.exitCode !== 0 || result.failed) {
    throw new Error(`failed to list PRs for ${branch}: ${result.stderr || result.stdout || result.exitCode}`);
  }
  return JSON.parse(result.stdout || '[]') as PrRef[];
}

function defaultLocalBranchExists(branch: string, repoDir: string): boolean {
  const result = execArgvCommand('git', [
    'show-ref',
    '--verify',
    '--quiet',
    `refs/heads/${branch}`,
  ], { cwd: repoDir, encoding: 'utf-8', stdio: 'pipe' });
  if (result.failed) {
    throw new Error('git is not available');
  }
  return result.exitCode === 0;
}

function defaultWorktreeBranches(repoDir: string): Set<string> {
  const result = execArgvCommand('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoDir,
    encoding: 'utf-8',
  });
  if (result.exitCode !== 0 || result.failed) {
    throw new Error(`failed to list worktrees: ${result.stderr || result.stdout || result.exitCode}`);
  }
  const branches = new Set<string>();
  for (const line of result.stdout.split('\n')) {
    const match = /^branch refs\/heads\/(.+)$/.exec(line.trim());
    if (match) branches.add(match[1]);
  }
  return branches;
}

function defaultActiveWorkflowBranches(repoDir: string): Set<string> {
  const branches = new Set<string>();
  for (const [, task] of workflowTaskEntries(readWorkflowState(join(repoDir, '.wavemill', 'workflow-state.json')))) {
    if (typeof task.branch === 'string' && task.branch.length > 0) {
      branches.add(task.branch);
    }
  }
  return branches;
}

function defaultDeleteRemoteBranch(branch: string, repoDir: string): void {
  const result = execArgvCommand('git', ['push', 'origin', '--delete', branch], {
    cwd: repoDir,
    encoding: 'utf-8',
  });
  if (result.exitCode !== 0 || result.failed) {
    throw new Error(result.stderr || result.stdout || `git push exited ${result.exitCode}`);
  }
}
