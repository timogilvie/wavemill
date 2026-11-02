/**
 * task-worktree-resolver — the one answer to "which git worktree does this
 * task's current run own?" (HOK-3373).
 *
 * The HOK-2595 incident: a settled task's long-gone worktree path was
 * recreated as a plain directory by a marker write, and
 * `compute-in-flight-touch-set.ts` ran `git -C <path>` there. Git walked up
 * to the main checkout, so the task "touched" all 1,827 files of `main` and
 * the picker held every candidate for three days.
 *
 * The resolver returns the registered worktree for the current run or says
 * why there is none. Only `registered` permits `git -C <path>`; every other
 * status is **unknown** to its caller (the picker holds it as an unknown
 * touch set, HOK-3307), never "touches nothing" and never "the repo".
 *
 * Statuses:
 * - `registered` — the path is a git worktree of `repoDir` whose top level is
 *   the path itself (no fall-through to a parent checkout).
 * - `missing`    — the row names a path that does not exist.
 * - `invalid`    — the path exists but is not its own worktree of `repoDir`
 *   (no `.git` entry, a different top level, or another repository).
 * - `protected`  — the path is the main checkout (or `/`, or empty-ish).
 * - `none`       — the row has no worktree, or there is no row.
 *
 * The shell twin is `task-worktree-resolver.sh` (`task_worktree_resolve`,
 * `task_worktree_path_status`).
 *
 * @module task-worktree-resolver
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { execArgvCommand } from './shell-utils.ts';
import { readWorkflowState, type WorkflowState } from './workflow-state.ts';

export type WorktreeStatus = 'registered' | 'missing' | 'invalid' | 'protected' | 'none';

export interface ResolvedWorktree {
  issue: string;
  /** The path the row names (`null` when it names none). */
  path: string | null;
  status: WorktreeStatus;
  /** The row's run id (`null` for legacy rows or no row). */
  runId: string | null;
  /** Why the path is not `registered` (diagnostics only). */
  detail?: string;
}

/** Injected git runner for tests; returns trimmed stdout or `null` on failure. */
export type GitProbe = (cwd: string, args: string[]) => string | null;

const defaultGit: GitProbe = (cwd, args) => {
  const result = execArgvCommand('git', ['-C', cwd, ...args]);
  return result.exitCode === 0 ? result.stdout.trim() : null;
};

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function resolveAgainst(cwd: string, path: string): string {
  return real(isAbsolute(path) ? path : join(cwd, path));
}

/**
 * Classify one task path against `repoDir`. Cheap checks first: a path with
 * no `.git` entry is never handed to git, so a recreated plain directory can
 * never fall through to the enclosing checkout.
 */
export function taskWorktreePathStatus(
  repoDir: string,
  path: string | null | undefined,
  git: GitProbe = defaultGit,
): { status: WorktreeStatus; detail?: string } {
  if (typeof path !== 'string' || path.trim() === '') return { status: 'none' };
  const target = resolve(path);
  if (target === '/' || real(target) === real(repoDir)) return { status: 'protected', detail: 'main_checkout' };
  if (!existsSync(target)) return { status: 'missing' };
  try {
    if (!statSync(target).isDirectory()) return { status: 'invalid', detail: 'not_a_directory' };
  } catch {
    return { status: 'missing' };
  }
  if (!existsSync(join(target, '.git'))) return { status: 'invalid', detail: 'no_git_entry' };
  const topLevel = git(target, ['rev-parse', '--show-toplevel']);
  if (!topLevel) return { status: 'invalid', detail: 'not_a_worktree' };
  if (real(topLevel) !== real(target)) return { status: 'invalid', detail: `toplevel_mismatch:${topLevel}` };
  const common = git(target, ['rev-parse', '--git-common-dir']);
  const repoCommon = git(repoDir, ['rev-parse', '--git-common-dir']);
  if (!common || !repoCommon) return { status: 'invalid', detail: 'common_dir_unresolvable' };
  if (resolveAgainst(target, common) !== resolveAgainst(repoDir, repoCommon)) {
    return { status: 'invalid', detail: 'other_repository' };
  }
  return { status: 'registered' };
}

/**
 * Resolve `issue`'s worktree from workflow state (or a pre-read `state`).
 * A settled row resolves like any other; callers decide what a settled run
 * means for them (the picker excludes it from the in-flight set).
 */
export function resolveTaskWorktree(
  repoDir: string,
  issue: string,
  options: { state?: WorkflowState | null; git?: GitProbe } = {},
): ResolvedWorktree {
  const state = options.state !== undefined
    ? options.state
    : readWorkflowState(join(repoDir, '.wavemill', 'workflow-state.json'));
  const task = state?.tasks?.[issue];
  if (!task) return { issue, path: null, status: 'none', runId: null };
  const path = typeof task.worktree === 'string' && task.worktree.length > 0 ? task.worktree : null;
  const runId = typeof task.runId === 'string' && task.runId.length > 0 ? task.runId : null;
  const { status, detail } = taskWorktreePathStatus(repoDir, path, options.git);
  return { issue, path, status, runId, ...(detail ? { detail } : {}) };
}
