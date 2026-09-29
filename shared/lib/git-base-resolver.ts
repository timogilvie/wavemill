import { escapeShellArg, execShellCommand } from './shell-utils.ts';

export interface ResolveDefaultBaseRefDeps {
  execShellCommand: typeof execShellCommand;
}

const defaultDeps: ResolveDefaultBaseRefDeps = {
  execShellCommand,
};

/**
 * Strip `refs/remotes/` so a fully-qualified remote-tracking ref becomes its
 * `origin/<name>` short form. Bare names and other prefixes are returned
 * unchanged. Empty input returns null.
 */
function stripRefsRemotesPrefix(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/^refs\/remotes\//, '');
}

/**
 * Resolve the default base branch for this repository. Prefers the remote's
 * `origin/HEAD` symbolic ref, returning the short `origin/<name>` form so
 * `git` resolves comparisons against the *remote-tracking* branch rather than
 * a possibly-stale local branch of the same short name (HOK-3090).
 *
 * Falls back to `init.defaultBranch` (a name, not a guarantee that a ref
 * exists), then to the bare literal `main`. Bare names are handed on to
 * `resolveOriginFirstRef` by callers, which normalizes them if `origin/<b>`
 * resolves.
 */
export function resolveDefaultBaseRef(
  repoDir: string,
  deps: ResolveDefaultBaseRefDeps = defaultDeps,
): string | null {
  try {
    const headRef = stripRefsRemotesPrefix(String(
      deps.execShellCommand('git symbolic-ref refs/remotes/origin/HEAD', {
        cwd: repoDir,
        encoding: 'utf-8',
      }),
    ));
    if (headRef) {
      return headRef;
    }
  } catch {
    // Ignore probe failures (missing symbolic ref, non-git dir, etc.) and fall through.
  }

  try {
    const configured = stripRefsRemotesPrefix(String(
      deps.execShellCommand('git config --get init.defaultBranch', {
        cwd: repoDir,
        encoding: 'utf-8',
      }),
    ));
    if (configured) {
      return configured;
    }
  } catch (error) {
    if (/command not found|enoent/i.test(String(error))) {
      return null;
    }
  }

  return 'main';
}

export type OriginFirstResolutionKind = 'remote' | 'local' | 'explicit';

export interface OriginFirstResolution {
  ref: string;
  kind: OriginFirstResolutionKind;
}

export interface ResolveOriginFirstRefDeps {
  execShellCommand: typeof execShellCommand;
}

/**
 * Normalize a base/integration reference so base-relative comparisons target
 * the remote-tracking branch `origin/<b>` even when a stale local branch of
 * the same name exists (HOK-3090). Never fetches; callers that need
 * freshness must run the fetch themselves.
 *
 * Rules:
 *   - explicit inputs (`origin/…`, `refs/…`, or a 40-hex SHA) pass through
 *     unchanged with `kind: 'explicit'`
 *   - bare names return `origin/<b>` when `refs/remotes/origin/<b>` resolves
 *     (`kind: 'remote'`), otherwise fall back to the bare name
 *     (`kind: 'local'`).
 */
export function resolveOriginFirstRef(
  repoDir: string,
  ref: string,
  deps: ResolveOriginFirstRefDeps = defaultDeps,
): OriginFirstResolution {
  const trimmed = ref.trim();
  if (!trimmed) {
    return { ref, kind: 'explicit' };
  }
  if (
    trimmed.startsWith('origin/')
    || trimmed.startsWith('refs/')
    || /^[0-9a-fA-F]{40}$/.test(trimmed)
  ) {
    return { ref: trimmed, kind: 'explicit' };
  }

  try {
    deps.execShellCommand(
      `git rev-parse --verify --quiet ${escapeShellArg(`refs/remotes/origin/${trimmed}^{commit}`)}`,
      { cwd: repoDir, encoding: 'utf-8' },
    );
    return { ref: `origin/${trimmed}`, kind: 'remote' };
  } catch {
    return { ref: trimmed, kind: 'local' };
  }
}
