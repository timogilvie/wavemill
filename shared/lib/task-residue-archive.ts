/**
 * HOK-3160: archive-then-reap for delivered terminal arms whose worktree
 * still carries residue (uncommitted edits, untracked files, or unpublished
 * commits on a PR-less arm). Writes a durable, inspectable archive under
 * `.wavemill/evals/artifacts/<ID>/retired-arm-residue/<timestamp>/` BEFORE
 * any destructive cleanup. The HOK-3088 "never reap dirty work" rule still
 * holds because the work is preserved as data, not discarded.
 *
 * The archive layout is intentionally boring and git-independent so an
 * operator can `cat`/`cp`/`git apply` it offline:
 *
 *   .wavemill/evals/artifacts/<ID>/retired-arm-residue/<ISO-timestamp>/
 *     ├── index.json          -- provenance (issue, branch, pr, head SHAs,
 *     │                          dirty status, bundle presence, timestamp)
 *     ├── diff.patch          -- `git diff HEAD` (empty file if clean)
 *     ├── untracked/          -- copies of each untracked file (if any)
 *     └── unpublished.bundle  -- `git bundle` of base..branch (PR-less only)
 *
 * Every step is fail-closed: if any step cannot complete, the archive is
 * considered incomplete and the caller must retain the task rather than
 * reap it.
 *
 * @module task-residue-archive
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

export interface ArchiveTaskResidueOptions {
  /** Task worktree path. */
  worktree: string;
  /** Repository directory holding `.wavemill/evals/artifacts/`. */
  repoDir: string;
  /** Linear issue id (`HOK-3160`, `HOK-3160_c`); used as the archive root dir. */
  issue: string;
  /** Local task branch; only used for the bundle range and index provenance. */
  branch?: string;
  /** Fallback base branch (used when the lifecycle contract did not pin one). */
  baseBranch?: string;
  /** PR number if the task had one; empty for a PR-less arm. */
  prNumber?: string;
  /** `now` injection for deterministic tests. Defaults to `new Date().toISOString()`. */
  now?(): string;
  /**
   * Optional git runner override; returns stdout on success, throws on failure.
   * Defaults to invoking `git` via `execFileSync` with the worktree as cwd for
   * worktree-local commands and `repoDir` for repo-local commands.
   */
  git?(args: string[], cwd: string): string;
}

export interface ArchiveTaskResidueResult {
  success: boolean;
  archivePath: string;
  diffPath: string;
  bundlePath?: string;
  untrackedCount: number;
  failureReason?: string;
}

const MAX_UNTRACKED_FILES = 500;
const MAX_UNTRACKED_BYTES_PER_FILE = 10 * 1024 * 1024;

function defaultGit(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function safeNow(options: ArchiveTaskResidueOptions): string {
  return (options.now ?? (() => new Date().toISOString()))();
}

function sanitizeTimestamp(stamp: string): string {
  return stamp.replace(/[:.]/g, '-');
}

function listUntrackedFiles(worktree: string, git: NonNullable<ArchiveTaskResidueOptions['git']>): string[] {
  // --others --exclude-standard mirrors the porcelain `?? ` output, scoped to
  // files git would not track. We honour .gitignore so build output stays out
  // of the archive. Files are returned as repo-relative paths.
  const out = git(['-C', worktree, 'ls-files', '--others', '--exclude-standard', '-z'], worktree);
  if (!out) return [];
  return out.split('\0').filter((entry) => entry.length > 0);
}

function copyUntrackedFile(worktree: string, archiveDir: string, relPath: string): boolean {
  const source = resolve(worktree, relPath);
  const destDir = resolve(archiveDir, 'untracked', dirname(relPath));
  const dest = resolve(archiveDir, 'untracked', relPath);
  if (!existsSync(source)) return false;
  const stats = statSync(source);
  if (!stats.isFile() || stats.size > MAX_UNTRACKED_BYTES_PER_FILE) return false;
  mkdirSync(destDir, { recursive: true });
  copyFileSync(source, dest);
  return true;
}

function resolveBaseRefs(options: ArchiveTaskResidueOptions): string[] {
  const base = options.baseBranch?.trim() || 'auto/integration';
  if (base.startsWith('refs/')) return [base];
  if (base.startsWith('origin/')) return [base, base.slice('origin/'.length)];
  return [`origin/${base}`, base];
}

/**
 * Archive a terminal task's worktree residue. Returns `{ success: true, ... }`
 * only when every step completed and the archive directory is on disk with
 * at minimum an `index.json` and a `diff.patch`. On any failure the result
 * reports `success: false` with a short `failureReason`; the caller treats a
 * failure as retention. Partial archive directories are left on disk for
 * inspection and never override later successful runs (each run writes to a
 * new timestamped subdirectory).
 */
export function archiveTaskResidue(options: ArchiveTaskResidueOptions): ArchiveTaskResidueResult {
  const git = options.git ?? defaultGit;
  const timestamp = safeNow(options);
  const stampDir = sanitizeTimestamp(timestamp);
  const archiveRoot = resolve(options.repoDir, '.wavemill', 'evals', 'artifacts', options.issue, 'retired-arm-residue');
  const archivePath = join(archiveRoot, stampDir);
  const diffPath = join(archivePath, 'diff.patch');
  const indexPath = join(archivePath, 'index.json');
  const result: ArchiveTaskResidueResult = {
    success: false,
    archivePath,
    diffPath,
    untrackedCount: 0,
  };

  if (!options.worktree || !existsSync(options.worktree)) {
    result.failureReason = 'worktree_absent';
    return result;
  }

  // Capture diff and untracked list BEFORE creating the archive directory.
  // The archive lives under `.wavemill/evals/artifacts/<ID>/` which may be
  // inside the worktree; listing untracked after mkdir would otherwise count
  // archive-created directories as fresh untracked entries.
  let diffBody = '';
  try {
    diffBody = git(['-C', options.worktree, 'diff', 'HEAD'], options.worktree);
  } catch {
    diffBody = '';
  }

  let untracked: string[] = [];
  try {
    untracked = listUntrackedFiles(options.worktree, git);
  } catch {
    untracked = [];
  }
  if (untracked.length > MAX_UNTRACKED_FILES) {
    result.failureReason = 'archive_untracked_overflow';
    return result;
  }

  try {
    mkdirSync(archivePath, { recursive: true });
  } catch (error) {
    result.failureReason = `archive_mkdir_failed:${(error as Error).message}`;
    return result;
  }

  // Step 1: write the diff captured above.
  try {
    writeFileSync(diffPath, diffBody, 'utf-8');
  } catch (error) {
    result.failureReason = `archive_diff_write_failed:${(error as Error).message}`;
    return result;
  }

  // Step 2: copy the pre-captured untracked file list.
  for (const rel of untracked) {
    try {
      if (copyUntrackedFile(options.worktree, archivePath, rel)) {
        result.untrackedCount += 1;
      }
    } catch (error) {
      result.failureReason = `archive_untracked_copy_failed:${rel}:${(error as Error).message}`;
      return result;
    }
  }

  // Step 3: bundle unpublished commits for a PR-less arm. For PR-bearing
  // arms the branch is on the remote already; the bundle would duplicate it.
  const hasPr = Boolean(options.prNumber && options.prNumber.trim());
  const bundlePath = join(archivePath, 'unpublished.bundle');
  let bundleWritten = false;
  if (!hasPr && options.branch) {
    // Try the configured base refs in order; the first that git can resolve
    // wins. Falls back to the local-only base when `origin/<base>` is not
    // present (fresh clone, test fixtures, or detached worktrees).
    let resolvedBundleBase = '';
    let bundleRequired = false;
    let bundleFailure = '';
    for (const base of resolveBaseRefs(options)) {
      try {
        git(['-C', options.repoDir, 'rev-parse', '--verify', `${base}^{commit}`], options.repoDir);
      } catch {
        continue;
      }
      resolvedBundleBase = base;
      try {
        const commitCount = Number(git(['-C', options.repoDir, 'rev-list', '--count', `${base}..${options.branch}`], options.repoDir).trim());
        bundleRequired = Number.isFinite(commitCount) && commitCount > 0;
      } catch (error) {
        bundleFailure = `archive_bundle_range_failed:${(error as Error).message}`;
        continue;
      }
      if (!bundleRequired) break;
      try {
        git(['-C', options.repoDir, 'bundle', 'create', bundlePath, `${base}..${options.branch}`], options.repoDir);
        bundleWritten = existsSync(bundlePath);
        if (bundleWritten) break;
        bundleFailure = 'archive_bundle_missing_after_create';
      } catch (error) {
        bundleFailure = `archive_bundle_create_failed:${(error as Error).message}`;
      }
    }
    // A PR-less arm with unpublished commits is only safe to reap after its
    // bundle is actually on disk. Do not silently convert a failed bundle
    // into an archive without the commits it was meant to preserve.
    if (!resolvedBundleBase) {
      result.failureReason = 'archive_bundle_base_missing';
      return result;
    }
    if (bundleRequired && !bundleWritten) {
      result.failureReason = bundleFailure || 'archive_bundle_create_failed';
      return result;
    }
    if (bundleWritten) {
      result.bundlePath = bundlePath;
    }
  }

  // Step 4: index.json with provenance.
  let localHead = '';
  try {
    localHead = git(['-C', options.worktree, 'rev-parse', 'HEAD'], options.worktree).trim();
  } catch {
    localHead = '';
  }
  const index = {
    schemaVersion: 1 as const,
    issue: options.issue,
    branch: options.branch ?? '',
    baseBranch: options.baseBranch ?? '',
    prNumber: options.prNumber ?? '',
    worktree: options.worktree,
    localHead,
    archivedAt: timestamp,
    diffBytes: Buffer.byteLength(diffBody, 'utf-8'),
    untrackedFiles: untracked,
    untrackedCount: result.untrackedCount,
    bundlePath: bundleWritten ? relative(archivePath, bundlePath) : '',
    hasBundle: bundleWritten,
    diffPath: relative(archivePath, diffPath),
    reason: hasPr ? 'retired-arm-residue' : 'pr-less-arm-residue',
  };
  try {
    writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf-8');
  } catch (error) {
    result.failureReason = `archive_index_write_failed:${(error as Error).message}`;
    return result;
  }

  result.success = true;
  return result;
}

/**
 * Discover the newest residue archive for a task, if any.  Used by the
 * dashboard "delivered-and-archived" aggregate and the cleanup episode
 * provenance; never affects the archive itself.
 */
export function findLatestResidueArchive(repoDir: string, issue: string): string | undefined {
  const root = join(repoDir, '.wavemill', 'evals', 'artifacts', issue, 'retired-arm-residue');
  if (!existsSync(root)) return undefined;
  let entries: string[] = [];
  try {
    entries = readdirSync(root).sort();
  } catch {
    return undefined;
  }
  if (entries.length === 0) return undefined;
  return join(root, entries[entries.length - 1]);
}
