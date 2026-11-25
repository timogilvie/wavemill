import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
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
import { readWorktreeStatusEntries } from '../../worktree-dirty-status.ts';
import type { ToolDescriptor, WavemillToolResult } from './types.ts';

export type DiscardOwnedPathOutcome =
  | { ok: true; path: string; action: 'restored' | 'unlinked' | 'already_clean' }
  | { ok: false; path: string; reason: 'invalid_path' | 'not_owned' | 'status_unreadable' | 'no_worktree' | 'git_failed'; message: string };

export interface IntendedFileTracker {
  record(paths: readonly string[]): void;
  isIntended(path: string): boolean;
  list(): string[];
  recordCommit(): number;
  readonly commitCount: number;
  /** Capture the dirty-path state before a command tool call runs. */
  snapshotCommand(callId: string): void;
  /** Record every path the command created or changed since its snapshot. */
  recordCommandDelta(callId: string): string[];
  /** The one discard: restore an owned tracked path to HEAD, or unlink an owned untracked file. */
  discard(path: string): DiscardOwnedPathOutcome;
}

/** Command tools whose worktree delta is recorded as owned (HOK-3514). */
export const COMMAND_PROVENANCE_TOOLS: ReadonlySet<string> = new Set(['run_tests', 'run_format']);

interface AfterToolCallContext {
  toolCall: { name: string; id?: string };
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
  const git = (args: string[]) => execFileSync('git', ['-C', worktree, ...args],
    { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const headNow = () => {
    if (!context) return '';
    const [top, head] = git(['rev-parse', '--show-toplevel', 'HEAD']).trim().split('\n');
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
  const commandSnapshots = new Map<string, Map<string, string>>();
  const dirtyDigests = (): Map<string, string> | null => {
    const entries = readWorktreeStatusEntries(worktree);
    if (entries === null) return null;
    return new Map(entries.map((entry) => [entry.path, digest(entry.path) ?? 'unsafe']));
  };
  const inHead = (path: string): boolean => {
    try { git(['cat-file', '-e', `HEAD:${path}`]); return true; } catch { return false; }
  };
  const forget = (path: string) => { intended.delete(path); persist(); };

  const tracker: IntendedFileTracker = {
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
    snapshotCommand(callId) {
      if (!context) return;
      const before = dirtyDigests();
      if (before) commandSnapshots.set(callId, before);
    },
    recordCommandDelta(callId) {
      const before = commandSnapshots.get(callId);
      commandSnapshots.delete(callId);
      if (!context || !before) return [];
      const after = dirtyDigests();
      if (!after) return [];
      // The before/after delta is the evidence, never the command string:
      // pre-existing dirt the command left untouched is not claimed.
      const changed = [...after].filter(([path, hash]) => before.get(path) !== hash).map(([path]) => path);
      if (changed.length > 0) tracker.record(changed);
      return changed.filter((path) => tracker.isIntended(path));
    },
    discard(candidate) {
      const normalized = normalizeTrackedPath(candidate);
      if (!normalized) {
        return { ok: false, path: String(candidate), reason: 'invalid_path', message: `'${candidate}' is not a repository-relative path.` };
      }
      if (!context) {
        return { ok: false, path: normalized, reason: 'no_worktree', message: 'No worktree is bound to this tracker.' };
      }
      const entries = readWorktreeStatusEntries(worktree);
      if (entries === null) {
        return { ok: false, path: normalized, reason: 'status_unreadable', message: 'git status could not be read.' };
      }
      const entry = entries.find((candidateEntry) => candidateEntry.path === normalized);
      if (!entry) {
        forget(normalized);
        return { ok: true, path: normalized, action: 'already_clean' };
      }
      let owned = false;
      try { owned = tracker.isIntended(normalized); } catch { owned = false; }
      if (!owned) {
        return {
          ok: false,
          path: normalized,
          reason: 'not_owned',
          message: `'${normalized}' was not created or changed by this task's tools, or changed after it was recorded; it cannot be discarded.`,
        };
      }
      try {
        if (entry.code === '??') {
          unlinkSync(resolve(worktree, normalized));
          forget(normalized);
          return { ok: true, path: normalized, action: 'unlinked' };
        }
        if (inHead(normalized)) {
          git(['restore', '--source=HEAD', '--staged', '--worktree', '--', normalized]);
        } else {
          git(['rm', '-q', '--cached', '--ignore-unmatch', '--', normalized]);
          if (digest(normalized) !== 'deleted') unlinkSync(resolve(worktree, normalized));
        }
        forget(normalized);
        return { ok: true, path: normalized, action: 'restored' };
      } catch (error) {
        return { ok: false, path: normalized, reason: 'git_failed', message: error instanceof Error ? error.message : String(error) };
      }
    },
  };
  return tracker;
}

export async function intendedFilesAfterToolCall(
  context: AfterToolCallContext,
  tracker: IntendedFileTracker,
): Promise<void> {
  if (COMMAND_PROVENANCE_TOOLS.has(context.toolCall.name) && context.toolCall.id) {
    tracker.recordCommandDelta(context.toolCall.id);
    return;
  }

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

export interface DiscardOwnedPathParams {
  paths: string[];
}

export type DiscardOwnedPathDetails =
  | { ok: true; tool: 'discard_owned_path'; outcomes: DiscardOwnedPathOutcome[] }
  | { ok: false; tool: 'discard_owned_path'; error: 'invalid_input' | 'discard_refused'; message: string; outcomes: DiscardOwnedPathOutcome[] };

/**
 * `discard_owned_path`: the native coder's only way to throw away a dirty
 * path. It goes through the tracker, so only paths this task's tools created
 * or changed (and that have not changed since) can be restored or removed.
 */
export function createDiscardOwnedPathTool(
  tracker: IntendedFileTracker,
): ToolDescriptor<DiscardOwnedPathParams, DiscardOwnedPathDetails> {
  return {
    metadata: {
      name: 'discard_owned_path',
      description: 'Discard dirty paths this task created or changed: restore a tracked file to HEAD, or delete an untracked file.',
      class: 'mutation',
      allowedPhases: ['coding'],
      executionMode: 'sequential',
      outputCapPolicy: { strategy: 'none' },
    },
    parameters: {
      type: 'object',
      properties: { paths: { type: 'array', items: { type: 'string' }, minItems: 1 } },
      required: ['paths'],
      additionalProperties: false,
    },
    async execute(_toolCallId, params): Promise<WavemillToolResult<DiscardOwnedPathDetails>> {
      if (!Array.isArray(params.paths) || params.paths.length === 0 || params.paths.some((p) => typeof p !== 'string')) {
        const message = 'paths must be a non-empty array of strings';
        return { content: [{ type: 'text', text: message }], details: { ok: false, tool: 'discard_owned_path', error: 'invalid_input', message, outcomes: [] } };
      }
      const outcomes = params.paths.map((candidate) => tracker.discard(candidate));
      const lines = outcomes.map((outcome) => (outcome.ok
        ? `${outcome.path}: ${outcome.action}`
        : `${outcome.path}: refused (${outcome.reason}) ${outcome.message}`));
      const refused = outcomes.filter((outcome) => !outcome.ok);
      const details: DiscardOwnedPathDetails = refused.length === 0
        ? { ok: true, tool: 'discard_owned_path', outcomes }
        : { ok: false, tool: 'discard_owned_path', error: 'discard_refused', message: lines.join('\n'), outcomes };
      return { content: [{ type: 'text', text: lines.join('\n') }], details };
    },
  };
}
