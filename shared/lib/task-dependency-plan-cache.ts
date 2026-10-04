import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DependencyEdge } from './task-dependency-planner.ts';
import { mutateJsonState, StateLockTimeoutError } from './state-mutex.ts';
import { normalizeInferenceState, type QueueInferenceState } from './queue-inference-status.ts';

export const CACHE_SCHEMA_VERSION = 1;
const CACHE_WRITE_TIMEOUT_MS = 5000;

export interface CachedEdge {
  from: string;
  to: string;
  fromFingerprint: string;
  toFingerprint: string;
  kind: 'inferred';
  type?: 'depends_on' | 'shared_surface';
  label?: string;
  confidence?: number;
  classifiedAt: string;
}

/** Grounded-planner pair verdict (HOK-3131). `must_precede`/`should_precede` mean `a` before `b`. */
export type GroundedVerdictKind = 'must_precede' | 'should_precede' | 'conflict' | 'independent';

export const GROUNDED_VERDICT_KINDS: readonly GroundedVerdictKind[] = ['must_precede', 'should_precede', 'conflict', 'independent'];

/** Cached touch set for one task, valid while the task fingerprint matches. */
export interface CachedTouchSet {
  fingerprint: string;
  computedAt: string;
  entries: Array<{ path: string; source: 'explicit' | 'resolved' | 'predicted'; symbols?: string[] }>;
}

/** Cached LLM ordering verdict for one task pair, valid while both fingerprints match. */
export interface CachedGroundedVerdict {
  a: string;
  b: string;
  aFingerprint: string;
  bFingerprint: string;
  verdict: GroundedVerdictKind;
  evidence?: string;
  classifiedAt: string;
}

/** Touch sets older than this are recomputed even when the task is unchanged (the repo moved). */
export const TOUCH_SET_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface CacheFile {
  schemaVersion: 1;
  projectSlug: string;
  updatedAt: string;
  fingerprints: Record<string, string>;
  edges: CachedEdge[];
  /**
   * Classifier bookkeeping (HOK-3130). Optional and additive: caches written
   * before it existed load without it and derive to inference status `never`.
   */
  inference?: QueueInferenceState;
  /**
   * Grounded planner touch sets keyed by task ID (HOK-3131). Optional and
   * additive; a malformed block is dropped on load without discarding edges.
   */
  touchSets?: Record<string, CachedTouchSet>;
  /** Grounded planner pair verdicts (HOK-3131). Optional and additive. */
  groundedVerdicts?: CachedGroundedVerdict[];
}

export interface FingerprintableTask {
  id: string;
  title?: unknown;
  description?: unknown;
  labels?: unknown;
  priority?: unknown;
  estimate?: unknown;
  state?: unknown;
  dueDate?: unknown;
  projectMilestone?: unknown;
  blocks?: unknown;
}

export interface BacklogDiff {
  added: string[];
  changed: string[];
  completed: string[];
  removed: string[];
}

interface CacheStats {
  totalEdges: number;
  retainedEdges: number;
}

function emptyCache(projectSlug: string): CacheFile {
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    projectSlug,
    updatedAt: new Date(0).toISOString(),
    fingerprints: {},
    edges: [],
  };
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .slice()
    .sort((a, b) => a.localeCompare(b));
}

function normalizeState(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;

  const name = (value as { name?: unknown }).name;
  if (typeof name === 'string') return name;

  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}

function normalizeProjectMilestone(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const name = normalizeString(value.name);
  const targetDate = normalizeString(value.targetDate);
  return { name, targetDate };
}

function canonicalizeTask(task: FingerprintableTask): Record<string, unknown> {
  return {
    blocks: normalizeStringArray(task.blocks),
    description: normalizeString(task.description),
    dueDate: normalizeString(task.dueDate),
    estimate: task.estimate ?? null,
    id: task.id,
    labels: normalizeStringArray(task.labels),
    priority: task.priority ?? null,
    projectMilestone: normalizeProjectMilestone(task.projectMilestone),
    state: normalizeState(task.state),
    title: normalizeString(task.title),
  };
}

function sortedRecord<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]])) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCachedEdge(value: unknown): value is CachedEdge {
  if (!isRecord(value)) return false;
  return (
    value.kind === 'inferred' &&
    typeof value.from === 'string' &&
    typeof value.to === 'string' &&
    typeof value.fromFingerprint === 'string' &&
    typeof value.toFingerprint === 'string' &&
    typeof value.classifiedAt === 'string' &&
    (value.type === undefined || value.type === 'depends_on' || value.type === 'shared_surface') &&
    (value.label === undefined || typeof value.label === 'string') &&
    (value.confidence === undefined || typeof value.confidence === 'number')
  );
}

function isCacheFile(value: unknown): value is CacheFile {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== CACHE_SCHEMA_VERSION) return false;
  if (typeof value.projectSlug !== 'string' || typeof value.updatedAt !== 'string') return false;
  if (!isRecord(value.fingerprints) || !Array.isArray(value.edges)) return false;
  if (Object.values(value.fingerprints).some((fingerprint) => typeof fingerprint !== 'string')) return false;
  return value.edges.every(isCachedEdge);
}

const TOUCH_SOURCES = new Set(['explicit', 'resolved', 'predicted']);

function isCachedTouchSet(value: unknown): value is CachedTouchSet {
  if (!isRecord(value)) return false;
  if (typeof value.fingerprint !== 'string' || typeof value.computedAt !== 'string' || !Array.isArray(value.entries)) return false;
  return value.entries.every(
    (entry) =>
      isRecord(entry) &&
      typeof entry.path === 'string' &&
      TOUCH_SOURCES.has(entry.source as string) &&
      (entry.symbols === undefined || (Array.isArray(entry.symbols) && entry.symbols.every((symbol) => typeof symbol === 'string'))),
  );
}

function isCachedGroundedVerdict(value: unknown): value is CachedGroundedVerdict {
  if (!isRecord(value)) return false;
  return (
    typeof value.a === 'string' &&
    typeof value.b === 'string' &&
    typeof value.aFingerprint === 'string' &&
    typeof value.bFingerprint === 'string' &&
    typeof value.classifiedAt === 'string' &&
    (GROUNDED_VERDICT_KINDS as readonly unknown[]).includes(value.verdict) &&
    (value.evidence === undefined || typeof value.evidence === 'string')
  );
}

/**
 * Validate the optional `inference` block on its own: a malformed block is
 * dropped (status falls back to `never`) instead of discarding the whole
 * cache and its edges.
 */
function withNormalizedInference(cache: CacheFile): CacheFile {
  const { inference: rawInference, ...rest } = cache as CacheFile & { inference?: unknown };
  if (rawInference === undefined) return rest;
  const inference = normalizeInferenceState(rawInference);
  if (!inference) {
    console.warn('[task-dep-cache] dropping malformed inference block');
    return rest;
  }
  return { ...rest, inference };
}

/**
 * Validate the optional grounded-planner blocks (HOK-3131) the same way:
 * malformed entries are dropped individually, a malformed container is
 * dropped whole, and the legacy cache is never discarded because of them.
 */
function withNormalizedGrounded(cache: CacheFile): CacheFile {
  const { touchSets: rawTouchSets, groundedVerdicts: rawVerdicts, ...rest } = cache as CacheFile & {
    touchSets?: unknown;
    groundedVerdicts?: unknown;
  };
  const result: CacheFile = rest;

  if (rawTouchSets !== undefined) {
    if (!isRecord(rawTouchSets)) {
      console.warn('[task-dep-cache] dropping malformed touchSets block');
    } else {
      const valid = Object.entries(rawTouchSets).filter(([, value]) => isCachedTouchSet(value)) as Array<[string, CachedTouchSet]>;
      if (valid.length !== Object.keys(rawTouchSets).length) {
        console.warn('[task-dep-cache] dropping malformed touchSets entries');
      }
      result.touchSets = Object.fromEntries(valid);
    }
  }

  if (rawVerdicts !== undefined) {
    if (!Array.isArray(rawVerdicts)) {
      console.warn('[task-dep-cache] dropping malformed groundedVerdicts block');
    } else {
      const valid = rawVerdicts.filter(isCachedGroundedVerdict);
      if (valid.length !== rawVerdicts.length) {
        console.warn('[task-dep-cache] dropping malformed groundedVerdicts entries');
      }
      result.groundedVerdicts = valid;
    }
  }

  return result;
}

function validateProjectSlug(projectSlug: string): void {
  if (projectSlug.includes('/') || projectSlug.includes('\\') || projectSlug.includes('..')) {
    throw new Error(`Invalid project slug for task dependency cache: ${projectSlug}`);
  }
}

export function getTaskDependencyCachePath(repoDir: string, projectSlug: string): string {
  validateProjectSlug(projectSlug);
  return join(repoDir, '.wavemill', 'cache', 'task-dependency-plans', `${projectSlug}.json`);
}

export function computeTaskFingerprint(task: FingerprintableTask): string {
  const payload = JSON.stringify(sortedRecord(canonicalizeTask(task)));
  return createHash('sha256').update(payload).digest('hex');
}

export function loadCache(rawRepoDir: string, projectSlug: string): CacheFile {
  const cachePath = getTaskDependencyCachePath(rawRepoDir, projectSlug);
  try {
    const raw = JSON.parse(readFileSync(cachePath, 'utf8')) as unknown;
    if (!isCacheFile(raw)) {
      console.warn(`[task-dep-cache] dropping unreadable cache: invalid shape in ${cachePath}`);
      return emptyCache(projectSlug);
    }
    if (raw.projectSlug !== projectSlug) {
      console.warn(`[task-dep-cache] dropping unreadable cache: project slug mismatch in ${cachePath}`);
      return emptyCache(projectSlug);
    }
    return withNormalizedGrounded(withNormalizedInference(raw));
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code;
    if (errno === 'ENOENT') return emptyCache(projectSlug);
    if (error instanceof SyntaxError) {
      console.warn(`[task-dep-cache] dropping unreadable cache: invalid JSON in ${cachePath}`);
      return emptyCache(projectSlug);
    }
    console.warn(`[task-dep-cache] dropping unreadable cache: ${(error as Error).message}`);
    return emptyCache(projectSlug);
  }
}

export function pruneCache(cache: CacheFile, currentBacklog: FingerprintableTask[]): CacheFile {
  const fingerprints = Object.fromEntries(currentBacklog.map((task) => [task.id, computeTaskFingerprint(task)]));
  const edges = cache.edges.filter(
    (edge) => fingerprints[edge.from] === edge.fromFingerprint && fingerprints[edge.to] === edge.toFingerprint,
  );

  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    projectSlug: cache.projectSlug,
    updatedAt: cache.updatedAt,
    fingerprints,
    edges,
    ...(cache.inference ? { inference: cache.inference } : {}),
    ...(cache.touchSets ? { touchSets: pruneTouchSets(cache.touchSets, fingerprints) } : {}),
    ...(cache.groundedVerdicts ? { groundedVerdicts: pruneGroundedVerdicts(cache.groundedVerdicts, fingerprints) } : {}),
  };
}

/** Keep touch sets whose task is still in the backlog with an unchanged fingerprint. */
export function pruneTouchSets(
  touchSets: Record<string, CachedTouchSet>,
  fingerprints: Record<string, string>,
): Record<string, CachedTouchSet> {
  return Object.fromEntries(
    Object.entries(touchSets).filter(([taskId, entry]) => fingerprints[taskId] === entry.fingerprint),
  );
}

/** Keep verdicts whose two tasks are still in the backlog with unchanged fingerprints. */
export function pruneGroundedVerdicts(
  verdicts: CachedGroundedVerdict[],
  fingerprints: Record<string, string>,
): CachedGroundedVerdict[] {
  return verdicts.filter(
    (verdict) => fingerprints[verdict.a] === verdict.aFingerprint && fingerprints[verdict.b] === verdict.bFingerprint,
  );
}

/**
 * Cached touch set for a task, or undefined when missing, stale (fingerprint
 * changed) or older than {@link TOUCH_SET_TTL_MS}.
 */
export function lookupTouchSet(
  cache: Pick<CacheFile, 'touchSets'>,
  taskId: string,
  fingerprint: string,
  nowMs: number,
): CachedTouchSet | undefined {
  const entry = cache.touchSets?.[taskId];
  if (!entry || entry.fingerprint !== fingerprint) return undefined;
  const computedMs = Date.parse(entry.computedAt);
  if (!Number.isFinite(computedMs) || nowMs - computedMs > TOUCH_SET_TTL_MS) return undefined;
  return entry;
}

/** Cached verdict for an unordered task pair whose fingerprints still match. */
export function lookupGroundedVerdict(
  cache: Pick<CacheFile, 'groundedVerdicts'>,
  taskX: string,
  taskY: string,
  fingerprintX: string,
  fingerprintY: string,
): CachedGroundedVerdict | undefined {
  return cache.groundedVerdicts?.find(
    (verdict) =>
      (verdict.a === taskX && verdict.b === taskY && verdict.aFingerprint === fingerprintX && verdict.bFingerprint === fingerprintY) ||
      (verdict.a === taskY && verdict.b === taskX && verdict.aFingerprint === fingerprintY && verdict.bFingerprint === fingerprintX),
  );
}

/**
 * Previous fingerprints restricted to tasks still in the backlog.
 *
 * Used whenever tasks are pending but were not analyzed (classifier failure
 * or cooldown): keeping the old fingerprint — or none, for a new task — keeps
 * them in the next run's diff so they are retried instead of silently being
 * marked analyzed (HOK-3130).
 */
export function retainPreviousFingerprints(
  previous: Record<string, string>,
  currentTaskIds: Iterable<string>,
): Record<string, string> {
  const retained: Record<string, string> = {};
  for (const taskId of currentTaskIds) {
    if (Object.prototype.hasOwnProperty.call(previous, taskId)) {
      retained[taskId] = previous[taskId];
    }
  }
  return retained;
}

export function getCacheStats(before: CacheFile, after: CacheFile): CacheStats {
  return {
    totalEdges: before.edges.length,
    retainedEdges: after.edges.length,
  };
}

export function computeBacklogDiff(
  prevFingerprints: Record<string, string>,
  currentTasks: FingerprintableTask[],
  isCompletedTask?: (taskId: string) => boolean,
): BacklogDiff {
  const added: string[] = [];
  const changed: string[] = [];
  const completed: string[] = [];
  const removed: string[] = [];
  const currentTaskIds = new Set<string>();

  for (const task of currentTasks) {
    currentTaskIds.add(task.id);
    const nextFingerprint = computeTaskFingerprint(task);
    const prevFingerprint = prevFingerprints[task.id];
    if (prevFingerprint === undefined) {
      added.push(task.id);
      continue;
    }
    if (prevFingerprint !== nextFingerprint) {
      changed.push(task.id);
    }
  }

  for (const taskId of Object.keys(prevFingerprints).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    if (currentTaskIds.has(taskId)) continue;
    if (isCompletedTask?.(taskId) === true) {
      completed.push(taskId);
      continue;
    }
    removed.push(taskId);
  }

  added.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  changed.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  return { added, changed, completed, removed };
}

export function mergeEdges(
  cachedEdges: CachedEdge[],
  freshEdges: CachedEdge[],
  opts: { changedTaskIds: Set<string>; removedTaskIds: Set<string> },
): CachedEdge[] {
  const retained = cachedEdges.filter(
    (edge) =>
      !opts.removedTaskIds.has(edge.from) &&
      !opts.removedTaskIds.has(edge.to) &&
      !opts.changedTaskIds.has(edge.from) &&
      !opts.changedTaskIds.has(edge.to),
  );

  const validFresh: CachedEdge[] = [];
  for (const edge of freshEdges) {
    if (!opts.changedTaskIds.has(edge.from) && !opts.changedTaskIds.has(edge.to)) {
      console.warn(`[task-dep-cache] dropping fresh edge outside changed scope: ${edge.from}->${edge.to}`);
      continue;
    }
    if (opts.removedTaskIds.has(edge.from) || opts.removedTaskIds.has(edge.to)) {
      continue;
    }
    validFresh.push(edge);
  }

  const deduped = new Map<string, CachedEdge>();
  for (const edge of [...retained, ...validFresh]) {
    const key = `${edge.type ?? 'depends_on'}\u0000${edge.from}\u0000${edge.to}`;
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, edge);
      continue;
    }

    if (existing.classifiedAt <= edge.classifiedAt) {
      deduped.set(key, edge);
    }
  }

  return [...deduped.values()].sort((a, b) => {
    const fromCompare = a.from.localeCompare(b.from, undefined, { numeric: true });
    if (fromCompare !== 0) return fromCompare;
    return a.to.localeCompare(b.to, undefined, { numeric: true });
  });
}

export function cachedEdgesToDependencyEdges(edges: CachedEdge[]): DependencyEdge[] {
  return edges.map((edge) => ({
    from: edge.from,
    to: edge.to,
    type: edge.type ?? 'depends_on',
    source: 'inferred',
    ...(typeof edge.label === 'string' && edge.label.length > 0 ? { reason: edge.label } : {}),
  }));
}

export function lookupEdge(
  cache: CacheFile,
  fromId: string,
  toId: string,
  fromFingerprint: string,
  toFingerprint: string,
): CachedEdge | undefined {
  return cache.edges.find(
    (edge) =>
      (
        edge.from === fromId &&
        edge.to === toId &&
        edge.fromFingerprint === fromFingerprint &&
        edge.toFingerprint === toFingerprint
      ) ||
      (
        edge.from === toId &&
        edge.to === fromId &&
        edge.fromFingerprint === toFingerprint &&
        edge.toFingerprint === fromFingerprint
      ),
  );
}

export function recordEdge(cache: CacheFile, edge: CachedEdge): CacheFile {
  return {
    ...cache,
    edges: [...cache.edges, edge],
  };
}

export async function saveCache(repoDir: string, projectSlug: string, cache: CacheFile): Promise<void> {
  let cachePath: string;
  try {
    cachePath = getTaskDependencyCachePath(repoDir, projectSlug);
  } catch (error) {
    console.warn(`[task-dep-cache] ${(error as Error).message}`);
    return;
  }

  try {
    await mutateJsonState<CacheFile>(
      cachePath,
      () => ({
        ...cache,
        schemaVersion: CACHE_SCHEMA_VERSION,
        projectSlug,
        updatedAt: new Date().toISOString(),
      }),
      { createIfMissing: true, initial: cache, timeoutMs: CACHE_WRITE_TIMEOUT_MS },
    );
  } catch (error) {
    if (error instanceof StateLockTimeoutError) {
      console.warn(`[task-dep-cache] cache write skipped after lock timeout: ${cachePath}`);
      return;
    }
    console.warn(`[task-dep-cache] cache write failed: ${(error as Error).message}`);
  }
}
