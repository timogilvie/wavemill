import { join, resolve } from 'node:path';
import { loadWavemillConfig } from './config.ts';
import { resolveFromMainRepo } from './git-utils.ts';
import { resolveWavemillInstallDir } from './native-agent/install-paths.ts';

// Re-export so existing callers of `evals-paths` keep working — HOK-3100
// consolidates the implementation under native-agent/install-paths.ts.
export { resolveWavemillInstallDir };

const DEFAULT_EVALS_DIR = '.wavemill/evals';

export interface ResolvedEvalsDir {
  /** Absolute path to the evals directory. */
  dir: string;
  /** True when the path came from .wavemill-config.json. */
  fromConfig: boolean;
}

/**
 * Resolve the evals directory with worktree awareness.
 *
 * Resolution order:
 * 1. Explicit `dir` override
 * 2. `config.eval.evalsDir` from `.wavemill-config.json`
 * 3. Default: `.wavemill/evals`
 */
export function resolveEvalsDir(
  dir?: string,
  repoDir?: string,
): ResolvedEvalsDir {
  if (dir) {
    return { dir: resolve(dir), fromConfig: false };
  }

  const config = loadWavemillConfig(repoDir);
  if (config.eval?.evalsDir) {
    return {
      dir: resolveFromMainRepo(config.eval.evalsDir, repoDir),
      fromConfig: true,
    };
  }

  return {
    dir: resolveFromMainRepo(DEFAULT_EVALS_DIR, repoDir),
    fromConfig: false,
  };
}

export function resolveRejectedEvalsDir(
  dir?: string,
  repoDir?: string,
): ResolvedEvalsDir {
  const resolved = resolveEvalsDir(dir, repoDir);
  return {
    dir: join(resolved.dir, 'rejected'),
    fromConfig: resolved.fromConfig,
  };
}

export function resolveRouteArtifactArchiveDir(
  issueId: string | undefined,
  repoDir?: string,
): string | undefined {
  if (!issueId) {
    return undefined;
  }
  return resolve(resolveEvalsDir(undefined, repoDir).dir, 'artifacts', issueId);
}

/**
 * Resolve the global aggregated evals path.
 *
 * Resolution order:
 * 1. `WAVEMILL_AGGREGATED_EVALS_PATH` env override (test hook)
 * 2. <wavemill-install>/.wavemill/evals/aggregated-evals.jsonl
 */
export function resolveGlobalAggregatedEvalsPath(): string {
  if (process.env.WAVEMILL_AGGREGATED_EVALS_PATH) {
    return process.env.WAVEMILL_AGGREGATED_EVALS_PATH;
  }
  return join(resolveWavemillInstallDir(), '.wavemill', 'evals', 'aggregated-evals.jsonl');
}
