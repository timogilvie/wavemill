#!/usr/bin/env -S npx tsx
/**
 * Compute the actual (or predicted-planning) touch set for one in-flight task
 * worktree (HOK-3306, picker 3/9). The monitor's async job runner wraps this
 * tool and publishes its output as a condition-keyed result marker so the
 * picker never spawns `git diff` on the hot pass.
 *
 * Modes:
 *   coding | review | ready | merge-queued (default)  → actual diff
 *     Union of (merge-base..HEAD), unstaged, staged, and untracked tracked
 *     files; filtered through DEFAULT_IGNORE_PATTERNS for a sanity pass.
 *
 *   planning  → predicted touch set
 *     Reads task-packet*.md if present and runs
 *     predictTouchSetDeterministic. Empty when no packet exists yet.
 *
 * The runner is responsible for defending against mid-run head moves; this
 * tool just prints the touch set as a JSON array to stdout.
 *
 * HOK-3373: the worktree must resolve to a registered git worktree of the
 * milled repo (`task-worktree-resolver.ts`). Anything else exits 3 with no
 * output: `git -C <plain dir>` walks up to the enclosing checkout, which is
 * how one dead task once "touched" every file of main (HOK-2595). The
 * monitor treats a non-registered worktree as an unknown touch set.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import { execArgvCommand } from '../shared/lib/shell-utils.ts';
import { taskWorktreePathStatus } from '../shared/lib/task-worktree-resolver.ts';
import {
  filterIgnoredFiles,
  DEFAULT_IGNORE_PATTERNS,
} from '../shared/lib/in-flight-touch-sets.ts';
import {
  createGitRepoProbe,
  predictTouchSetDeterministic,
} from '../shared/lib/touch-set-predictor.ts';

/** Exit status for "worktree is not a registered task worktree". */
const UNRESOLVED_WORKTREE_EXIT_CODE = 3;

const CODE_PRODUCING_PHASES = new Set(['coding', 'review', 'ready', 'merge-queued', '']);

// Both git helpers below run only after run() resolved the path as a
// registered worktree (HOK-3373).
function runGit(worktree: string, args: string[]): string[] {
  // allow-settled-attempt: worktree resolved `registered` by taskWorktreePathStatus in run()
  const result = execArgvCommand('git', ['-C', worktree, ...args]);
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function computeMergeBase(worktree: string, base: string): string | null {
  // allow-settled-attempt: worktree resolved `registered` by taskWorktreePathStatus in run()
  const result = execArgvCommand('git', ['-C', worktree, 'merge-base', base, 'HEAD']);
  if (result.exitCode !== 0) return null;
  const sha = result.stdout.trim();
  return sha.length > 0 ? sha : null;
}

function actualTouchSet(worktree: string, base: string): string[] {
  const mergeBase = computeMergeBase(worktree, base);
  const files = new Set<string>();
  if (mergeBase) {
    for (const path of runGit(worktree, ['diff', '--name-only', `${mergeBase}..HEAD`])) {
      files.add(path);
    }
  }
  for (const path of runGit(worktree, ['diff', '--name-only', 'HEAD'])) files.add(path);
  for (const path of runGit(worktree, ['diff', '--name-only', '--cached'])) files.add(path);
  for (const path of runGit(worktree, ['ls-files', '--others', '--exclude-standard'])) {
    files.add(path);
  }
  return filterIgnoredFiles([...files].sort(), DEFAULT_IGNORE_PATTERNS);
}

function readTaskPacket(featureDir: string): string | null {
  const packet = join(featureDir, 'task-packet.md');
  if (existsSync(packet)) {
    try {
      return readFileSync(packet, 'utf8');
    } catch {
      return null;
    }
  }
  const header = join(featureDir, 'task-packet-header.md');
  const details = join(featureDir, 'task-packet-details.md');
  if (existsSync(header) && existsSync(details)) {
    try {
      return `${readFileSync(header, 'utf8')}\n${readFileSync(details, 'utf8')}`;
    } catch {
      return null;
    }
  }
  return null;
}

function predictedTouchSet(worktree: string, featureDir: string, taskId: string): string[] {
  const text = readTaskPacket(featureDir);
  if (!text) return [];
  const probe = createGitRepoProbe(worktree);
  const touch = predictTouchSetDeterministic(
    { id: taskId, title: taskId, description: text },
    probe,
  );
  const files = touch.entries.map((entry) => entry.path);
  return filterIgnoredFiles([...new Set(files)].sort(), DEFAULT_IGNORE_PATTERNS);
}

runTool({
  name: 'compute-in-flight-touch-set',
  description: 'Compute the actual (or predicted-planning) touch set for one in-flight task worktree',
  options: {
    'worktree-dir': { type: 'string', description: 'The task worktree' },
    'base-branch': { type: 'string', description: 'Integration base to diff against' },
    'head-sha': { type: 'string', description: 'Expected HEAD sha (defensive; the runner re-checks)' },
    'feature-dir': { type: 'string', description: 'Task feature dir (for planning-phase packets)' },
    phase: { type: 'string', description: 'Workflow phase (coding | review | ready | merge-queued | planning)' },
    'task-id': { type: 'string', description: 'Task id (for predicted touch sets)' },
    'repo-dir': { type: 'string', description: 'Milled repo the worktree must belong to (default: $WAVEMILL_MILLED_REPO_DIR, $REPO_DIR, cwd)' },
  },
  examples: [
    'npx tsx tools/compute-in-flight-touch-set.ts --worktree-dir /path/to/wt --base-branch main',
  ],
  async run({ args }) {
    const worktree = args['worktree-dir'];
    if (typeof worktree !== 'string' || worktree.length === 0) {
      throw new Error('--worktree-dir is required');
    }
    const base = typeof args['base-branch'] === 'string' && args['base-branch'].length > 0
      ? args['base-branch']
      : 'main';
    const phase = typeof args.phase === 'string' ? args.phase : '';
    const repoDir = (typeof args['repo-dir'] === 'string' && args['repo-dir'])
      || process.env.WAVEMILL_MILLED_REPO_DIR
      || process.env.REPO_DIR
      || process.cwd();
    const resolved = taskWorktreePathStatus(repoDir, worktree);
    if (resolved.status !== 'registered') {
      process.stderr.write(
        `compute-in-flight-touch-set: ${worktree} is ${resolved.status}${resolved.detail ? ` (${resolved.detail})` : ''}; touch set unknown\n`,
      );
      process.exitCode = UNRESOLVED_WORKTREE_EXIT_CODE;
      return;
    }

    let files: string[] = [];
    if (phase === 'planning') {
      const featureDir = typeof args['feature-dir'] === 'string' ? args['feature-dir'] : '';
      const taskId = typeof args['task-id'] === 'string' ? args['task-id'] : 'in-flight-task';
      if (featureDir) files = predictedTouchSet(worktree, featureDir, taskId);
    } else if (CODE_PRODUCING_PHASES.has(phase)) {
      files = actualTouchSet(worktree, base);
    } else {
      // Unknown phase: fall back to actual-diff mode.
      files = actualTouchSet(worktree, base);
    }
    process.stdout.write(`${JSON.stringify(files)}\n`);
  },
});
