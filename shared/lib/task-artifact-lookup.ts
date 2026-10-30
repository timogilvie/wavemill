/**
 * One stage-artifact lookup (HOK-2891).
 *
 * "Where are this task's stage results and sibling artifacts?" is answered
 * here, once, for every reader. The lookup walks a fixed probe order (live
 * worktree feature dirs, then the per-issue archive directory) and joins the
 * SAME file name in both branches — there is no dual-name reader. Archive
 * writers (`archive_stage_artifacts`) keep the live basename, so what readers
 * ask for is what the archive holds.
 *
 * Readers that must only see live data (writers, in-stage readers) stay on
 * `getResultFilePath(featureDir, stage)` + an explicit `existsSync` check;
 * the preflight guard `tools/check-stage-artifact-lookup.ts` prevents a new
 * reader from drifting back to a private live→archive fallback.
 */
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { loadWavemillConfig } from './config.ts';
import { resolveRouteArtifactArchiveDir } from './evals-paths.ts';
import { resolveFromMainRepo } from './git-utils.ts';

export interface ResolveTaskArtifactOptions {
  /** Linear issue id (e.g. `HOK-2891`, `HOK-2891_c`). Required for archive resolution. */
  issueId: string;
  /** Feature slug. Required for live resolution; the probe runs features/<slug> and bugs/<slug>. */
  slug?: string;
  /** File name joined into every candidate directory (e.g. `.coding-result.json`). */
  artifactName: string;
  /** The active worktree directory, when the caller already has it. */
  worktreeDir?: string;
  /** Main-repo root; defaults to `resolveFromMainRepo` from CWD. */
  repoDir?: string;
}

export interface ResolvedTaskArtifact {
  /** Absolute path to the resolved artifact. */
  path: string;
  /** Which branch of the probe matched. */
  source: 'live' | 'archive';
  /** The live feature directory containing the artifact (set when source === 'live'). */
  featureDir?: string;
  /** The archive directory containing the artifact (set when source === 'archive'). */
  archiveDir?: string;
}

export interface ResolvedTaskArtifactDirs {
  /** Live feature dirs that exist on disk for this slug (features/ and bugs/, both roots). */
  liveFeatureDirs: string[];
  /** Archive dir, or null when the issueId has no archive yet. */
  archiveDir: string | null;
}

/**
 * Return the probe order of candidate directories for a task's artifacts.
 *
 * The probe is deterministic and the only source of truth for "where could
 * this task's artifacts live". The live branch (`liveFeatureDirs`) always
 * comes before the archive branch (`archiveDir`); callers that want strictly
 * live data iterate only `liveFeatureDirs`.
 *
 * Only directories that actually exist on disk are returned.
 */
export function resolveTaskArtifactDirs(
  opts: Omit<ResolveTaskArtifactOptions, 'artifactName'>,
): ResolvedTaskArtifactDirs {
  const repoDir = opts.repoDir ? resolve(opts.repoDir) : resolve(process.cwd());

  // Live candidates — features/<slug> and bugs/<slug> under each root we might find.
  const liveRoots: string[] = [];
  if (opts.worktreeDir) {
    liveRoots.push(resolve(opts.worktreeDir));
  }
  if (opts.slug) {
    const config = loadWavemillConfig(repoDir);
    const worktreeRoot = config.mill?.worktreeRoot ?? 'worktrees';
    const slugWorktree = resolveFromMainRepo(join(worktreeRoot, opts.slug), repoDir);
    liveRoots.push(slugWorktree);
    // Fall back to the main repo itself (non-worktree layouts).
    liveRoots.push(repoDir);
  }

  const liveFeatureDirs: string[] = [];
  const seen = new Set<string>();
  if (opts.slug) {
    for (const root of liveRoots) {
      for (const dir of ['features', 'bugs']) {
        const candidate = join(root, dir, opts.slug);
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        if (existsSync(candidate)) {
          liveFeatureDirs.push(candidate);
        }
      }
    }
  }

  // Archive candidate — one per issueId.
  let archiveDir: string | null = null;
  if (opts.issueId) {
    const resolved = resolveRouteArtifactArchiveDir(opts.issueId, repoDir);
    if (resolved && existsSync(resolved)) {
      archiveDir = resolved;
    }
  }

  return { liveFeatureDirs, archiveDir };
}

/**
 * Resolve a task's artifact to one absolute path. Live before archive, with
 * features/ probed before bugs/ at each root. Returns `null` when no probe
 * site contains `artifactName`.
 *
 * The archive branch joins `artifactName` as-is — the archiver writes the
 * live basename (HOK-2891), so a reader that asks for `.coding-result.json`
 * reads it in both places.
 */
export function resolveTaskArtifact(
  opts: ResolveTaskArtifactOptions,
): ResolvedTaskArtifact | null {
  if (!opts.artifactName || basename(opts.artifactName) !== opts.artifactName) {
    throw new Error(
      `resolveTaskArtifact: artifactName must be a basename (got ${JSON.stringify(opts.artifactName)})`,
    );
  }

  const dirs = resolveTaskArtifactDirs(opts);

  for (const featureDir of dirs.liveFeatureDirs) {
    const candidate = join(featureDir, opts.artifactName);
    if (existsSync(candidate)) {
      return { path: candidate, source: 'live', featureDir };
    }
  }

  if (dirs.archiveDir) {
    const candidate = join(dirs.archiveDir, opts.artifactName);
    if (existsSync(candidate)) {
      return { path: candidate, source: 'archive', archiveDir: dirs.archiveDir };
    }
  }

  return null;
}
