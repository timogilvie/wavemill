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

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
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
 * The main checkout a linked worktree belongs to, read from the worktree's
 * `.git` pointer file (`gitdir: <main>/.git/worktrees/<name>`). No git spawn:
 * this runs on the monitor's hot pass. Null for a main checkout, a missing
 * directory, or anything unreadable.
 */
function mainCheckoutOf(worktreePath: string): string | null {
  try {
    const pointer = readFileSync(join(worktreePath, '.git'), 'utf8');
    const gitDir = /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim();
    if (!gitDir) return null;
    const absolute = isAbsolute(gitDir) ? gitDir : resolve(worktreePath, gitDir);
    const marker = `${join('.git', 'worktrees')}`;
    const at = absolute.lastIndexOf(marker);
    return at > 0 ? resolve(absolute.slice(0, at)) : null;
  } catch {
    return null;
  }
}

/**
 * Directories whose `.wavemill/runs/` may hold a DeepSeek-provider home for
 * work done in `worktreePath`.
 *
 * The launcher (`agent_deepseek_state_dir`) writes the home under the milled
 * repo — the main checkout — not under the task worktree, so the worktree
 * alone never finds it. The main checkout is found three ways because the
 * worktree is often gone by the time cost is read (post-merge eval): its
 * `.git` pointer while it exists, the `<repo>/worktrees/<slug>` layout, and
 * the mill's own repo-dir environment.
 */
function deepSeekRunRoots(worktreePath: string): string[] {
  const worktree = resolve(worktreePath);
  const roots = [
    worktree,
    mainCheckoutOf(worktree),
    dirname(worktree),
    dirname(dirname(worktree)),
    process.env.WAVEMILL_MILLED_REPO_DIR,
    process.env.REPO_DIR,
  ];
  return [...new Set(roots.filter((root): root is string => Boolean(root)).map((root) => resolve(root)))];
}

/**
 * Every Claude projects directory that may hold sessions for a worktree: the
 * user's own, plus one per DeepSeek-provider run home under
 * `<root>/.wavemill/runs/<run>/providers/deepseek/home/`, for each root in
 * {@link deepSeekRunRoots}. Every candidate is keyed by the worktree's own
 * encoded path, so a wider search cannot pick up another task's sessions.
 */
export function resolveProjectsDirs(worktreePath: string): string[] {
  const encoded = encodeProjectDir(worktreePath);
  const dirs = [resolveProjectsDir(worktreePath)];

  for (const root of deepSeekRunRoots(worktreePath)) {
    const runsDir = join(root, '.wavemill', 'runs');
    if (!existsSync(runsDir)) continue;

    try {
      for (const runEntry of readdirSync(runsDir, { withFileTypes: true })) {
        if (!runEntry.isDirectory()) continue;
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
      // An unreadable runs directory contributes nothing; keep the others.
    }
  }

  return [...new Set(dirs)];
}
