/**
 * One PR-to-task / task-to-stateDir resolver (HOK-3242).
 *
 * Before this module every lookup site (merge-labels, tend
 * `resolveReadyStateDir`, `resolveEffectiveBaseBranchForPr`,
 * `taskStateAuthorizesRemoteBranchDeletion`) rolled its own loop over
 * `workflowTaskEntries(state)` and returned `null` / `[]` / `continue` /
 * `fallbackBase` on a miss with no record. HOK-3212's bug class — the
 * reconciler read `prNumber` / `headSha` fields no writer sets, so every
 * lookup silently missed and no PR ever got `wm:ready` — survived precisely
 * because the misses were silent.
 *
 * This resolver takes an already-loaded {@link WorkflowState} (callers that
 * have already read it get to reuse the state; the file I/O stays at the
 * read site), performs the match, and on every miss emits exactly one
 * structured log line and returns a {@link LookupMiss} with a stable
 * {@link LookupMissReason}. Decision-level call sites thread that reason
 * into their own output (`tend-controller.getInitialBlockReason` surfaces it
 * in place of the generic `ready-failed:not-ready`).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  workflowTaskEntries,
  type TaskRecord,
  type WorkflowState,
} from './workflow-state.ts';

/** Resolved task record + the two derivations most callers want. */
export interface ResolvedTaskLocation {
  taskId: string;
  task: TaskRecord;
  slug: string;
  worktree: string;
  /**
   * Absolute path to the feature directory holding `.{stage}-result.json`.
   * Picked by `existsSync` in order: `<worktree>/features/<slug>`,
   * `<worktree>/bugs/<slug>`; falls back to `features/<slug>` when neither
   * exists yet so downstream reads see ENOENT cleanly (matches
   * `merge-labels.findTaskInState`'s historical behaviour).
   */
  featureDir: string;
  /** Alias of {@link featureDir}, named for tend callers that read it as a state dir. */
  stateDir: string;
  /** Parsed PR number, or 0 when the row has no PR yet. */
  prNumber: number;
}

/** The lookup key, included in miss logs so a reader can grep by it. */
export type LookupKey =
  | { kind: 'pr'; prNumber: number }
  | { kind: 'task'; taskId: string }
  | { kind: 'branch'; branch: string };

/** Stable reason tokens so the surfaced blocked-candidate reason stays greppable. */
export type LookupMissReason =
  | 'state-unavailable'
  | 'no-task-matched'
  | 'no-worktree-or-slug'
  | 'no-feature-dir';

export interface LookupMiss {
  reason: LookupMissReason;
  key: LookupKey;
  /** Call site identifier, included in the log line. */
  site: string;
  detail?: string;
}

export interface ResolveLogger {
  warn(msg: string, meta?: unknown): void;
}

export interface ResolveOptions {
  /** Call site identifier (e.g. `tend.deleteBranchAfterMerge`). */
  site: string;
  /** Defaults to `console.warn`. */
  logger?: ResolveLogger;
}

export interface ResolvePrOptions extends ResolveOptions {
  /**
   * Secondary task-key match used by tend's `resolveReadyStateDir`: when the
   * PR number does not match any row but the metadata carried a task id, that
   * id matches too.
   */
  fallbackTaskKey?: string;
  /**
   * Secondary branch match used by tend's `resolveEffectiveBaseBranchForPr`:
   * when the PR number does not match any row but a row's `branch` field
   * equals this value, that row matches too. Collapsing the cascade into one
   * lookup keeps the miss log to a single structured line instead of two.
   */
  fallbackBranch?: string;
}

export type ResolveResult =
  | { location: ResolvedTaskLocation; miss: null }
  | { location: null; miss: LookupMiss };

const DEFAULT_LOGGER: ResolveLogger = {
  warn(msg, meta) {
    if (meta !== undefined) {
      console.warn(msg, typeof meta === 'string' ? meta : JSON.stringify(meta));
    } else {
      console.warn(msg);
    }
  },
};

function keyText(key: LookupKey): string {
  switch (key.kind) {
    case 'pr':
      return `pr:${key.prNumber}`;
    case 'task':
      return `task:${key.taskId}`;
    case 'branch':
      return `branch:${key.branch}`;
  }
}

function emitMiss(
  logger: ResolveLogger | undefined,
  reason: LookupMissReason,
  key: LookupKey,
  site: string,
  detail?: string,
): LookupMiss {
  const effectiveLogger = logger ?? DEFAULT_LOGGER;
  const detailText = detail ? ` detail=${detail}` : '';
  effectiveLogger.warn(
    `[pr-task-resolver] miss site=${site} key=${keyText(key)} reason=${reason}${detailText}`,
    { site, key, reason, ...(detail ? { detail } : {}) },
  );
  return { reason, key, site, ...(detail ? { detail } : {}) };
}

function parsePr(task: TaskRecord): number {
  const value = task.pr;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/**
 * Pick `features/<slug>` when it exists, else `bugs/<slug>`, else fall back
 * to `features/<slug>` so downstream reads get a clean ENOENT. Returns an
 * empty string when either `worktree` or `slug` is missing.
 */
function deriveFeatureDir(worktree: string, slug: string): string {
  if (!worktree || !slug) return '';
  const featuresPath = join(worktree, 'features', slug);
  const bugsPath = join(worktree, 'bugs', slug);
  if (existsSync(featuresPath)) return featuresPath;
  if (existsSync(bugsPath)) return bugsPath;
  return featuresPath;
}

function buildLocation(taskId: string, task: TaskRecord): ResolvedTaskLocation | { missReason: Exclude<LookupMissReason, 'state-unavailable' | 'no-task-matched'> } {
  const slug = typeof task.slug === 'string' ? task.slug : '';
  const worktree = typeof task.worktree === 'string' ? task.worktree : '';
  if (!slug || !worktree) {
    return { missReason: 'no-worktree-or-slug' };
  }
  const featureDir = deriveFeatureDir(worktree, slug);
  if (!featureDir) {
    return { missReason: 'no-feature-dir' };
  }
  return {
    taskId,
    task,
    slug,
    worktree,
    featureDir,
    stateDir: featureDir,
    prNumber: parsePr(task),
  };
}

function stateHasTasks(state: WorkflowState | null | undefined): boolean {
  return workflowTaskEntries(state).length > 0;
}

/**
 * Resolve a task location by PR number. The optional `fallbackTaskKey`
 * lets a caller match on the task id when the PR number has not been
 * recorded in state yet (tend `resolveReadyStateDir`).
 */
export function resolvePrTask(
  prNumber: number,
  state: WorkflowState | null,
  options: ResolvePrOptions,
): ResolveResult {
  const key: LookupKey = { kind: 'pr', prNumber };
  if (!state || !stateHasTasks(state)) {
    return { location: null, miss: emitMiss(options.logger, 'state-unavailable', key, options.site) };
  }

  const fallbackTaskKey = options.fallbackTaskKey;
  const fallbackBranch = options.fallbackBranch;
  for (const [taskId, task] of workflowTaskEntries(state)) {
    const matchesPr = Number.isFinite(prNumber) && prNumber > 0 && parsePr(task) === prNumber;
    const matchesTaskKey = typeof fallbackTaskKey === 'string' && fallbackTaskKey.length > 0 && taskId === fallbackTaskKey;
    const matchesBranch = typeof fallbackBranch === 'string'
      && fallbackBranch.length > 0
      && typeof task.branch === 'string'
      && task.branch === fallbackBranch;
    if (!matchesPr && !matchesTaskKey && !matchesBranch) continue;

    const built = buildLocation(taskId, task);
    if ('missReason' in built) {
      return { location: null, miss: emitMiss(options.logger, built.missReason, key, options.site, `taskId=${taskId}`) };
    }
    return { location: built, miss: null };
  }

  return { location: null, miss: emitMiss(options.logger, 'no-task-matched', key, options.site) };
}

/** Resolve a task location by its workflow-state key (`HOK-123` / `HOK-123_c`). */
export function resolveTaskLocation(
  taskId: string,
  state: WorkflowState | null,
  options: ResolveOptions,
): ResolveResult {
  const key: LookupKey = { kind: 'task', taskId };
  if (!state || !stateHasTasks(state)) {
    return { location: null, miss: emitMiss(options.logger, 'state-unavailable', key, options.site) };
  }

  for (const [candidateId, task] of workflowTaskEntries(state)) {
    if (candidateId !== taskId) continue;
    const built = buildLocation(candidateId, task);
    if ('missReason' in built) {
      return { location: null, miss: emitMiss(options.logger, built.missReason, key, options.site, `taskId=${taskId}`) };
    }
    return { location: built, miss: null };
  }

  return { location: null, miss: emitMiss(options.logger, 'no-task-matched', key, options.site) };
}

/** Resolve a task location by `task.branch`. Fails closed callers rely on this. */
export function resolveBranchTask(
  branch: string,
  state: WorkflowState | null,
  options: ResolveOptions,
): ResolveResult {
  const key: LookupKey = { kind: 'branch', branch };
  if (!state || !stateHasTasks(state)) {
    return { location: null, miss: emitMiss(options.logger, 'state-unavailable', key, options.site) };
  }

  for (const [taskId, task] of workflowTaskEntries(state)) {
    if (typeof task.branch !== 'string' || task.branch !== branch) continue;
    const built = buildLocation(taskId, task);
    if ('missReason' in built) {
      return { location: null, miss: emitMiss(options.logger, built.missReason, key, options.site, `taskId=${taskId}`) };
    }
    return { location: built, miss: null };
  }

  return { location: null, miss: emitMiss(options.logger, 'no-task-matched', key, options.site) };
}
