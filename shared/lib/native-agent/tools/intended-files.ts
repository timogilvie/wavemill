import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { mutateJsonStateSync } from '../../state-mutex.ts';
import type { AstTransformApplySuccessDetails } from './ast-transform.ts';
import type { ApplyPatchDetails } from './apply-patch-tool.ts';
import type {
  CodingMutationDetails,
  CreateMarkerDetails,
  WriteArtifactDetails,
} from './mutation-tools.ts';
import { normalizePatchPath } from '../patch-contract.ts';

export interface IntendedFileTracker {
  record(paths: readonly string[]): void;
  isIntended(path: string): boolean;
  list(): string[];
  recordCommit(): number;
  readonly commitCount: number;
}

interface AfterToolCallContext {
  toolCall: { name: string };
  result: { details: unknown };
}

export interface IntendedFileContext {
  worktreePath: string;
  taskId: string;
  statePath: string;
}

interface OwnershipRecord {
  version: 1;
  worktree: string;
  taskId: string;
  head: string;
  files: Record<string, string>;
}

/** One ownership authority for fresh and recovered native coding processes. */
export function createIntendedFileTracker(context?: IntendedFileContext): IntendedFileTracker {
  const intended = new Map<string, string>();
  const worktree = context ? realpathSync(context.worktreePath) : '';
  const headNow = () => {
    if (!context) return '';
    const [top, head] = execFileSync('git', ['-C', worktree, 'rev-parse', '--show-toplevel', 'HEAD'],
      { encoding: 'utf8', timeout: 5000 }).trim().split('\n');
    if (realpathSync(top) !== worktree || !head) throw new Error('Native intended-file worktree identity changed');
    return head;
  };
  let head = headNow();
  const digest = (path: string): string | null => {
    if (!context) return '';
    const absolute = resolve(worktree, path);
    try {
      // Reject symlinks and escaping parents; deletion is a first-class mutation.
      const parent = realpathSync(resolve(absolute, '..'));
      const parentRelative = relative(worktree, parent);
      if (parentRelative === '..' || parentRelative.startsWith('../')) return null;
      try { if (!lstatSync(absolute).isFile()) return null; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'deleted'; throw error; }
      return createHash('sha256').update(readFileSync(absolute)).digest('hex');
    } catch { return null; }
  };
  if (context && existsSync(context.statePath)) {
    try {
      const record = JSON.parse(readFileSync(context.statePath, 'utf8')) as OwnershipRecord;
      if (record.version === 1 && record.taskId === context.taskId && record.worktree === worktree
        && record.head === head && record.files && typeof record.files === 'object' && !Array.isArray(record.files)) {
        for (const [path, hash] of Object.entries(record.files)) {
          const normalized = normalizeTrackedPath(path);
          if (normalized === path && typeof hash === 'string' && digest(path) === hash) intended.set(path, hash);
        }
      }
    } catch (error) {
      console.warn(`Native intended-file provenance could not be loaded; preserved files remain unstaged: ${error}`);
    }
  }
  const persist = () => {
    if (!context) return;
    mutateJsonStateSync<OwnershipRecord>(context.statePath, () => ({
      version: 1, taskId: context.taskId, worktree, head, files: Object.fromEntries(intended),
    }), { createIfMissing: true, initial: { version: 1, taskId: context.taskId, worktree, head, files: {} } });
  };
  let commits = 0;

  return {
    record(paths) {
      const currentHead = headNow();
      if (head !== currentHead) { intended.clear(); head = currentHead; }
      for (const candidate of paths) {
        const normalized = normalizeTrackedPath(candidate);
        if (normalized) {
          const hash = digest(normalized);
          if (hash !== null) intended.set(normalized, hash);
        }
      }
      persist();
    },
    isIntended(candidate) {
      const normalized = normalizeTrackedPath(candidate);
      return normalized !== null && headNow() === head && intended.has(normalized)
        && digest(normalized) === intended.get(normalized);
    },
    list() {
      return [...intended.keys()].sort((left, right) => left.localeCompare(right));
    },
    recordCommit() {
      commits += 1;
      head = headNow();
      persist();
      return commits;
    },
    get commitCount() {
      return commits;
    },
  };
}

export async function intendedFilesAfterToolCall(
  context: AfterToolCallContext,
  tracker: IntendedFileTracker,
): Promise<void> {
  if (context.toolCall.name === 'apply_patch' || context.toolCall.name === 'ast_transform_apply') {
    const raw = context.result.details as ApplyPatchDetails | AstTransformApplySuccessDetails | undefined;
    const details = raw?.ok && raw.tool === 'ast_transform_apply' ? raw.result : raw as ApplyPatchDetails | undefined;
    if (details?.ok) {
      tracker.record(details.changedFiles);
    }
    return;
  }

  if (context.toolCall.name === 'write_artifact' || context.toolCall.name === 'create_marker') {
    const details = context.result.details as
      | WriteArtifactDetails
      | CreateMarkerDetails
      | CodingMutationDetails
      | undefined;
    if (details?.ok && 'resolvedPath' in details) {
      tracker.record([details.resolvedPath]);
    }
  }
}

function normalizeTrackedPath(candidate: string): string | null {
  if (typeof candidate !== 'string') {
    return null;
  }
  return normalizePatchPath(candidate.replace(/\\/g, '/'));
}
