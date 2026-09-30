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

/** Untracked observer-findings artifact the controller writes at the worktree root. */
export const WAVEMILL_CONTROLLER_OBSERVER_ARTIFACT = '.wavemill/observer-findings.jsonl';

/** Prompt-registry log older native-agent runs wrote at the worktree root. */
export const WAVEMILL_PROMPT_REGISTRY_ARTIFACT = 'prompt-registry.jsonl';

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
  const observerLine = `?? ${WAVEMILL_CONTROLLER_OBSERVER_ARTIFACT}`;
  const registryUntracked = `?? ${WAVEMILL_PROMPT_REGISTRY_ARTIFACT}`;
  const registryModified = ` M ${WAVEMILL_PROMPT_REGISTRY_ARTIFACT}`;
  return rawPorcelain
    .split('\n')
    .filter((line) => line.length > 0)
    .filter((line) => line !== observerLine && line !== registryUntracked && line !== registryModified);
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
  const stdout = git(['-C', worktree, 'status', '--porcelain', '--untracked-files=all'], worktree);
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
