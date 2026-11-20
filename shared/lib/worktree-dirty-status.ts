/**
 * Worktree dirty-status classifier (HOK-3088)
 *
 * A single at-risk predicate shared between the observer and cleanup so the
 * two cannot disagree about whether a terminal task worktree still holds
 * uncommitted or untracked work. Mirrors the shell helper
 * `wavemill_worktree_dirty_status` in `wavemill-common.sh`: reads porcelain
 * status with all untracked files and filters only the exact
 * controller-owned artifacts (the observer findings log and the root
 * prompt-registry log). Every other tracked or untracked change - including
 * anything else under .wavemill/ - remains a cleanup blocker.
 *
 * An unreadable git status is reported explicitly so callers can fail closed
 * rather than treating it as clean.
 *
 * @module worktree-dirty-status
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { filterMillOwnedDirtyStatus } from './mill-owned-paths.ts';

export type WorktreeDirtyState = 'clean' | 'dirty' | 'unreadable' | 'absent';

export interface WorktreeDirtyStatus {
  /** Filtered vs. absent vs. clean vs. unreadable. */
  state: WorktreeDirtyState;
  /** Filtered porcelain lines, one per real change. Empty when clean/absent/unreadable. */
  lines: string[];
  /** Filtered porcelain output as a single joined string, for evidence rendering. */
  raw: string;
}

/**
 * Filter raw `git status --porcelain --untracked-files=all` output the same
 * way the shell helper does: drop only the untracked observer-findings
 * artifact and either an untracked or unstaged-modification of the root
 * prompt-registry log. Any leading/trailing empty lines are stripped.
 */
export function filterWorktreeDirtyStatus(rawPorcelain: string): string[] {
  return filterMillOwnedDirtyStatus(rawPorcelain);
}

type GitRunner = (args: string[], cwd: string) => string | undefined;

const defaultGitRunner: GitRunner = (args, cwd) => {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 8_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return undefined;
  }
};

export interface ReadWorktreeDirtyStatusOptions {
  /** Worktree path to inspect. */
  worktree: string;
  /**
   * Optional git runner override; returns stdout on success and undefined on
   * failure. Used by cleanup callers that already have a shared `deps.git`
   * wrapper and by unit tests that stub git out.
   */
  git?: GitRunner;
}

/** The one porcelain read (all untracked files) both views share. */
function readPorcelain(worktree: string, git: GitRunner, extra: string[]): string | undefined {
  return git(['-C', worktree, 'status', '--porcelain', ...extra, '--untracked-files=all'], worktree);
}

/**
 * Read the filtered porcelain status of a worktree. A missing directory
 * reports `absent`; a git failure reports `unreadable`. Callers that must
 * fail closed (e.g. never generate a destructive recommendation when risk
 * cannot be verified) should treat `unreadable` and `absent` the same as
 * `dirty` for decision-making. `absent` is safe to treat as `clean` only
 * when the caller already knows the worktree has been reaped.
 */
export function readWorktreeDirtyStatus(options: ReadWorktreeDirtyStatusOptions): WorktreeDirtyStatus {
  const { worktree, git = defaultGitRunner } = options;
  if (!worktree || !existsSync(worktree)) {
    return { state: 'absent', lines: [], raw: '' };
  }
  const stdout = readPorcelain(worktree, git, []);
  if (stdout === undefined) {
    return { state: 'unreadable', lines: [], raw: '' };
  }
  const lines = filterWorktreeDirtyStatus(stdout);
  return {
    state: lines.length > 0 ? 'dirty' : 'clean',
    lines,
    raw: lines.join('\n'),
  };
}

/** One porcelain entry: the two-letter XY code and the repo-relative path. */
export interface WorktreeStatusEntry {
  code: string;
  path: string;
}

/**
 * Read `git status --porcelain -z --untracked-files=all` as structured
 * entries. NUL-delimited output needs no unquoting, and a rename or copy
 * reports its destination path (the source is consumed and dropped).
 * Returns null when git cannot be read, so callers can fail closed.
 */
export function readWorktreeStatusEntries(worktree: string, git: GitRunner = defaultGitRunner): WorktreeStatusEntry[] | null {
  if (!worktree || !existsSync(worktree)) return null;
  const stdout = readPorcelain(worktree, git, ['-z']);
  if (stdout === undefined) return null;
  const fields = stdout.split('\0');
  const entries: WorktreeStatusEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    entries.push({ code, path: field.slice(3) });
    if (code[0] === 'R' || code[0] === 'C') index += 1;
  }
  return entries;
}

/**
 * TypeScript twin of `wavemill_owned_dirty_path` (wavemill-monitor.sh): the
 * Wavemill-owned generated/runtime paths a coding handoff never has to commit.
 * Keep the two in step until HOK-3503's single mill-output list replaces both.
 */
export function isWavemillOwnedDirtyPath(path: string, slug: string): boolean {
  if (path === '.claude/settings.local.json') return true;
  if (path.startsWith('.wavemill/')) return true;
  if (path === '.wavemill-config.local.json') return true;
  if (path === 'prompt-registry.jsonl') return true;
  const prefix = `features/${slug}/`;
  if (!slug || !path.startsWith(prefix)) return false;
  const rest = path.slice(prefix.length);
  if (rest.startsWith('.')) return true;
  return rest === 'plan.md' || /^task-packet.*\.md$/.test(rest) || rest === 'challenge-intent.json'
    || rest === 'selected-task.json' || rest === 'trace.jsonl' || rest === 'routing.jsonl';
}

export type TaskDirtyPaths =
  | { state: 'readable'; paths: string[] }
  | { state: 'unreadable'; paths: [] };

/**
 * The task's dirty paths: every porcelain entry except Wavemill-owned output.
 * This is what a coding handoff must commit or discard before it may finish.
 */
export function readTaskDirtyPaths(options: { worktree: string; slug: string; git?: GitRunner }): TaskDirtyPaths {
  const entries = readWorktreeStatusEntries(options.worktree, options.git);
  if (entries === null) return { state: 'unreadable', paths: [] };
  const paths = [...new Set(entries.map((entry) => entry.path))]
    .filter((path) => !isWavemillOwnedDirtyPath(path.replace(/\/$/, ''), options.slug))
    .sort((left, right) => left.localeCompare(right));
  return { state: 'readable', paths };
}
