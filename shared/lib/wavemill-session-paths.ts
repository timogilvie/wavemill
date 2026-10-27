/**
 * Session-file discovery for a Wavemill worktree (HOK-3077): where Claude
 * Code (and the DeepSeek-provider Claude home under `.wavemill/runs/`) write
 * the transcripts of work done in a worktree.
 *
 * This is the Wavemill-only half of the cost join — which sessions belong to
 * a task. Pricing and aggregation live elsewhere (`pricing/`, the SDK bridge).
 *
 * @module wavemill-session-paths
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

/** Claude Code caps project directory names at this many characters. */
export const CLAUDE_PROJECT_DIR_MAX_LENGTH = 200;

/** Java-style 32-bit string hash, as Claude Code uses for truncated names. */
function javaStringHash(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * Derive the Claude projects directory name from a worktree absolute path.
 *
 * Claude Code replaces every non-alphanumeric character with `-`, e.g.
 *   /Users/tim/worktrees/my-feature → -Users-tim-worktrees-my-feature
 * Names longer than 200 characters are cut to 200 and suffixed with
 * `-<base36 hash of the raw path>`. Without that rule, task worktrees with
 * long slugs never matched their sessions, so executed-model evidence and
 * session cost came back missing.
 *
 * @param worktreePath - Absolute path to the worktree
 * @returns The encoded project directory name
 */
export function encodeProjectDir(worktreePath: string): string {
  const absolute = resolve(worktreePath);
  const encoded = absolute.replace(/[^a-zA-Z0-9]/g, '-');
  if (encoded.length <= CLAUDE_PROJECT_DIR_MAX_LENGTH) {
    return encoded;
  }
  const suffix = Math.abs(javaStringHash(absolute)).toString(36);
  return `${encoded.slice(0, CLAUDE_PROJECT_DIR_MAX_LENGTH)}-${suffix}`;
}

/**
 * Resolve the full path to the Claude projects directory for a worktree.
 *
 * @param worktreePath - Absolute path to the worktree
 * @returns Full path to `~/.claude/projects/<encoded-path>/`
 */
export function resolveProjectsDir(worktreePath: string): string {
  const encoded = encodeProjectDir(worktreePath);
  return join(homedir(), '.claude', 'projects', encoded);
}

/**
 * Every Claude projects directory that may hold sessions for a worktree: the
 * user's own, plus one per DeepSeek-provider run home under
 * `<worktree>/.wavemill/runs/<run>/providers/deepseek/home/`.
 */
export function resolveProjectsDirs(worktreePath: string): string[] {
  const encoded = encodeProjectDir(worktreePath);
  const dirs = [resolveProjectsDir(worktreePath)];
  const runsDir = join(resolve(worktreePath), '.wavemill', 'runs');

  if (!existsSync(runsDir)) {
    return dirs;
  }

  try {
    for (const runEntry of readdirSync(runsDir, { withFileTypes: true })) {
      if (!runEntry.isDirectory()) {
        continue;
      }

      const providerProjectsDir = join(
        runsDir,
        runEntry.name,
        'providers',
        'deepseek',
        'home',
        '.claude',
        'projects',
        encoded,
      );
      if (existsSync(providerProjectsDir)) {
        dirs.push(providerProjectsDir);
      }
    }
  } catch {
    return dirs;
  }

  return [...new Set(dirs)];
}
