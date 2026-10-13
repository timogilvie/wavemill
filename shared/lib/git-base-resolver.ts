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

/** Default bound on the review's `git fetch origin <base>` (HOK-3166). */
export const ORIGIN_FETCH_TIMEOUT_MS = 15_000;

/**
 * Opt-out for the review's network fetch (offline runs, tests, sandboxes).
 * When set to `1`, `resolveReviewDiffBase` resolves against whatever
 * `origin/<b>` the worktree already has.
 */
export const REVIEW_SKIP_FETCH_ENV = 'WAVEMILL_REVIEW_SKIP_FETCH';

export type OriginFetchOutcome = 'fetched' | 'failed' | 'skipped';

/**
 * Map a base reference to the branch name to fetch from `origin`, or null
 * when the reference is not an origin branch (a SHA, `refs/tags/…`, another
 * remote's `refs/remotes/<r>/…`) and fetching would be meaningless.
 */
function originFetchTarget(ref: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed || /^[0-9a-fA-F]{40}$/.test(trimmed)) {
    return null;
  }
  if (trimmed.startsWith('refs/heads/')) {
    return trimmed.slice('refs/heads/'.length);
  }
  if (trimmed.startsWith('refs/remotes/origin/')) {
    return trimmed.slice('refs/remotes/origin/'.length);
  }
  if (trimmed.startsWith('refs/')) {
    return null;
  }
  if (trimmed.startsWith('origin/')) {
    return trimmed.slice('origin/'.length);
  }
  return trimmed;
}

/** Same validation the review scope guard applies before fetching. */
function isFetchableBranchName(branch: string): boolean {
  return branch !== '' && !branch.startsWith('-') && !branch.includes('..');
}

/**
 * Best-effort `git fetch --quiet origin <branch>` so `refs/remotes/origin/<b>`
 * reflects the remote before a base-relative comparison (HOK-3166).
 *
 * Accepts a bare name, `origin/<b>`, `refs/heads/<b>` or
 * `refs/remotes/origin/<b>`. The fetch is bounded by `execSync`'s own
 * `timeout` option — not `timeout(1)`, which macOS does not ship, so a
 * `command -v timeout` guard silently skips the fetch on the mill host.
 * Credential prompts are disabled so a misconfigured remote fails fast.
 *
 * @returns true when the fetch succeeded; false on any failure or an
 *   unfetchable name. Never throws.
 */
export function fetchOriginBranch(
  repoDir: string,
  branch: string,
  deps: ResolveOriginFirstRefDeps = defaultDeps,
  timeoutMs: number = ORIGIN_FETCH_TIMEOUT_MS,
): boolean {
  const target = originFetchTarget(branch);
  if (!target || !isFetchableBranchName(target)) {
    return false;
  }
  try {
    deps.execShellCommand(`git fetch --quiet origin ${escapeShellArg(target)}`, {
      cwd: repoDir,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: timeoutMs,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return true;
  } catch {
    return false;
  }
}

/** The base a review diff was actually computed against (HOK-3166). */
export interface ReviewDiffBase {
  /** What the caller passed, e.g. `auto/integration`. */
  requestedRef: string;
  /** What git diffs against, e.g. `origin/auto/integration`. */
  ref: string;
  /** How `ref` was derived from `requestedRef` (see `resolveOriginFirstRef`). */
  kind: OriginFirstResolutionKind;
  /** Whether `origin/<b>` was refreshed before resolving. */
  fetch: OriginFetchOutcome;
  /** Tip of `ref`, comparable to a PR's `baseRefOid`; null when unresolvable. */
  baseSha: string | null;
  /** `git merge-base <ref> HEAD` — the diff's real starting point; null when unresolvable. */
  mergeBaseSha: string | null;
}

function revParseCommit(
  repoDir: string,
  ref: string,
  deps: ResolveOriginFirstRefDeps,
): string | null {
  try {
    const sha = String(deps.execShellCommand(
      `git rev-parse --verify --quiet ${escapeShellArg(`${ref}^{commit}`)}`,
      { cwd: repoDir, encoding: 'utf-8', stdio: 'pipe' },
    )).trim();
    return sha || null;
  } catch {
    return null;
  }
}

function mergeBaseWithHead(
  repoDir: string,
  ref: string,
  deps: ResolveOriginFirstRefDeps,
): string | null {
  try {
    const sha = String(deps.execShellCommand(
      `git merge-base ${escapeShellArg(ref)} HEAD`,
      { cwd: repoDir, encoding: 'utf-8', stdio: 'pipe' },
    )).trim();
    return sha || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the base a self-review should diff against (HOK-3166).
 *
 * A bare base name such as `auto/integration` resolves in a task worktree to
 * the *local* branch, which nothing keeps current. Once the task branch has
 * merged a newer `origin/<b>`, `git diff <b>...HEAD` starts at the stale local
 * tip, so every integration commit since then appears as part of the PR and
 * the reviewer flags (and agents edit) other PRs' merged code.
 *
 * Steps: fetch `origin <b>` once (best-effort, bounded; skipped for SHAs,
 * non-origin refs, or when `WAVEMILL_REVIEW_SKIP_FETCH=1`), normalize via
 * `resolveOriginFirstRef` (HOK-3090), then record the base tip and the
 * merge-base with HEAD for logging.
 *
 * Never throws: in a non-git directory, or when the ref does not resolve, the
 * SHAs are null and the subsequent `getGitDiff` reports its descriptive error.
 */
export function resolveReviewDiffBase(
  repoDir: string,
  targetBranch: string,
  deps: ResolveOriginFirstRefDeps = defaultDeps,
): ReviewDiffBase {
  let fetch: OriginFetchOutcome;
  if (process.env[REVIEW_SKIP_FETCH_ENV] === '1' || !originFetchTarget(targetBranch)) {
    fetch = 'skipped';
  } else {
    fetch = fetchOriginBranch(repoDir, targetBranch, deps) ? 'fetched' : 'failed';
  }

  const resolved = resolveOriginFirstRef(repoDir, targetBranch, deps);
  return {
    requestedRef: targetBranch,
    ref: resolved.ref,
    kind: resolved.kind,
    fetch,
    baseSha: revParseCommit(repoDir, resolved.ref, deps),
    mergeBaseSha: mergeBaseWithHead(repoDir, resolved.ref, deps),
  };
}
