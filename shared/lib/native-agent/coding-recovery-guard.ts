/**
 * HOK-3128 dirty-handoff recovery guard (HOK-3145 enforcement, HOK-3514).
 *
 * When wavemill's monitor relaunches the coding agent after a dirty tree with
 * ".coding-recovery-instruction.md" present, this guard narrows the tool menu
 * to: read tools (so it can inspect what's dirty), git_add/git_commit and
 * discard_owned_path, the completion markers, and status updates. It decides
 * nothing about individual paths: the intended-file tracker behind those three
 * tools is the one authority on which dirty path the agent may commit or
 * discard, and the `.coding-complete` completion gate decides when it may
 * finish. Any other tool call is denied with a reason naming the way out.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readTaskDirtyPaths } from '../worktree-dirty-status.ts';

export interface CodingRecoveryGuard {
  dirtyPaths: string[];
  featureDir: string;
  worktreePath: string;
  evaluate(call: { name: string; args: Record<string, unknown> }): { allow: true } | { allow: false; reason: string };
}

/** Read tools, status, and the tracker-backed commit/discard tools — never deny these. */
const ALWAYS_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'list_files',
  'search_text',
  'git_status',
  'git_diff',
  'git_diff_stat',
  'git_log',
  'update_status',
  'code_search',
  'ast_find',
  'git_add',
  'git_commit',
  'discard_owned_path',
]);

/** Allow-list used in the system prompt. */
export const RECOVERY_MODE_ALLOWED_TOOLS: readonly string[] = [
  'read_file', 'list_files', 'search_text', 'git_status', 'git_diff',
  'git_diff_stat', 'git_log', 'git_add', 'git_commit', 'discard_owned_path',
  'create_marker', 'write_artifact', 'update_status',
];

const RECOVERY_INSTRUCTION_FILE = '.coding-recovery-instruction.md';
const COMPLETION_MARKERS = ['.coding-complete', '.coding-blocked-completion.json'];

function denialReason(toolName: string): string {
  return (
    `recovery_mode_denied: ${toolName} is not allowed during dirty-handoff recovery. `
    + 'Commit (git_add + git_commit) or discard (discard_owned_path) each dirty path, '
    + 'then create_marker .coding-complete.'
  );
}

export function readCodingRecoveryGuard(
  featureDir: string,
  worktreePath: string,
): CodingRecoveryGuard | null {
  if (!existsSync(path.join(featureDir, RECOVERY_INSTRUCTION_FILE))) return null;
  const dirty = readTaskDirtyPaths({ worktree: worktreePath, slug: path.basename(featureDir) });
  return buildGuard({ featureDir, worktreePath, dirtyPaths: dirty.paths });
}

export function buildGuard(input: {
  featureDir: string;
  worktreePath: string;
  dirtyPaths: readonly string[];
}): CodingRecoveryGuard {
  const { featureDir, worktreePath } = input;
  const markerPaths = new Set(COMPLETION_MARKERS.map((name) => path.resolve(featureDir, name)));

  const isCompletionMarkerPath = (rawPath: string): boolean => {
    const abs = path.resolve(worktreePath, rawPath);
    const rel = path.relative(worktreePath, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
    return markerPaths.has(abs);
  };

  return {
    dirtyPaths: [...input.dirtyPaths],
    featureDir,
    worktreePath,
    evaluate(call) {
      const name = call.name;
      if (ALWAYS_ALLOWED_TOOLS.has(name)) return { allow: true };

      if (name === 'create_marker' || name === 'write_artifact') {
        const rawPath = typeof call.args?.path === 'string' ? call.args.path : '';
        if (rawPath && isCompletionMarkerPath(rawPath)) return { allow: true };
        return {
          allow: false,
          reason:
            `recovery_mode_denied: ${name} is only allowed for `
            + `.coding-complete or .coding-blocked-completion.json during recovery.`,
        };
      }

      return { allow: false, reason: denialReason(name) };
    },
  };
}
