/**
 * In-flight touch-set overlap engine (HOK-3306, picker 3/9).
 *
 * The queue planner sees only the backlog. In-flight tasks (coding, review,
 * ready, merge-queued, or still-planning) do not appear in the planner's
 * input, so a backlog candidate whose predicted touch set overlaps a running
 * task's actual diff would otherwise be offered for launch and collide at
 * tend time. The monitor passes each in-flight task's touch set to the picker
 * through `plan-queue.ts --in-flight-file`; this module synthesizes
 * `sharedSurfaceConflicts` edges from the overlap so the existing
 * `selectLaunchSet` adjacency path holds the candidate with
 * `conflicts_with_in_flight`.
 *
 * Append-only registries and lock files are filtered on both sides to avoid
 * false positives (every merge touches `.wavemill/registry/*`).
 */

import { readFileSync } from 'node:fs';
import { compareTaskIds, type ConflictEdge, type QueuePlan } from './plan-queue-utils.ts';

/** One in-flight task's touch set, as consumed by the picker and plan-queue. */
export interface InFlightTouchSet {
  /** Task id, e.g. "HOK-3230". */
  id: string;
  /** Open PR number for the task; absent for planning or very early coding. */
  prNumber?: number;
  /** Repo-relative paths, sorted and deduped. */
  files: string[];
  /** Worktree HEAD this touch set was computed at (provenance). */
  headSha?: string;
  /** Where `files` came from — actual diff vs predicted (planning phase). */
  source: 'actual' | 'predicted';
  /** Workflow phase at computation time ("coding" | "review" | ... ). */
  phase?: string;
  /**
   * HOK-3373: `'unknown'` when the task's worktree did not resolve to a
   * registered worktree (`task-worktree-resolver`); `files` is then empty and
   * means nothing. See `InFlightTask.touchSet`.
   */
  touchSet?: 'known' | 'unknown';
}

/**
 * Paths ignored on both sides of the overlap check. These are append-only
 * registry files and lock files that every merge inherently touches; naming
 * them a conflict would hold every pair of tasks.
 *
 * File-level stub for 3/9 — region-level mapping to functions lives in 4/9.
 */
export const DEFAULT_IGNORE_PATTERNS: readonly string[] = [
  '.wavemill/registry/',
  '.wavemill/evals/',
  '.wavemill/manifests/',
  '.wavemill/side-effect-ledger.jsonl',
  '.wavemill/invariant-violations.jsonl',
  '.wavemill/state-schema-violations.jsonl',
  '.wavemill/condition-reconcile.jsonl',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
];

/**
 * True when `path` matches any pattern. A pattern that ends with `/` is a
 * directory prefix (every path under it is ignored); otherwise it's an exact
 * match or basename hit.
 */
export function isIgnoredPath(
  path: string,
  patterns: readonly string[] = DEFAULT_IGNORE_PATTERNS,
): boolean {
  for (const pattern of patterns) {
    if (pattern.endsWith('/')) {
      if (path.startsWith(pattern)) return true;
      continue;
    }
    if (path === pattern) return true;
    // Match basename for lock files written at any depth.
    const slash = path.lastIndexOf('/');
    if (slash >= 0 && path.slice(slash + 1) === pattern) return true;
  }
  return false;
}

/** Filter out ignored paths; preserves input order. */
export function filterIgnoredFiles(
  files: readonly string[],
  patterns: readonly string[] = DEFAULT_IGNORE_PATTERNS,
): string[] {
  return files.filter((f) => !isIgnoredPath(f, patterns));
}

/**
 * Sorted intersection of two file sets after dropping ignored paths. Empty
 * when every overlapping path is ignored.
 */
export function findFileOverlap(
  candidateFiles: readonly string[],
  inFlightFiles: readonly string[],
  ignorePatterns: readonly string[] = DEFAULT_IGNORE_PATTERNS,
): string[] {
  if (candidateFiles.length === 0 || inFlightFiles.length === 0) return [];
  const inFlightSet = new Set(filterIgnoredFiles(inFlightFiles, ignorePatterns));
  if (inFlightSet.size === 0) return [];
  const result = new Set<string>();
  for (const candidate of filterIgnoredFiles(candidateFiles, ignorePatterns)) {
    if (inFlightSet.has(candidate)) result.add(candidate);
  }
  return [...result].sort();
}

/**
 * Parse an in-flight touch-set JSON file. Returns an array; throws with the
 * path on malformed rows so soft-failing callers can log and fall through.
 */
export function parseInFlightFile(path: string): InFlightTouchSet[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`Failed to read in-flight file ${path}: ${(error as Error).message}`);
  }
  return parseInFlightJson(raw, path);
}

/** Pure JSON → InFlightTouchSet[] parser (shared with the TS tool runner). */
export function parseInFlightJson(raw: string, source: string): InFlightTouchSet[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse in-flight JSON from ${source}: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`In-flight JSON from ${source} must be an array`);
  }
  const result: InFlightTouchSet[] = [];
  for (let index = 0; index < parsed.length; index++) {
    const row = parsed[index];
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw new Error(`In-flight row at index ${index} in ${source} must be an object`);
    }
    const record = row as Record<string, unknown>;
    if (typeof record.id !== 'string' || record.id.trim() === '') {
      throw new Error(`In-flight row at index ${index} in ${source} must have a non-empty string id`);
    }
    const files = normalizeFiles(record.files, index, source);
    const entry: InFlightTouchSet = {
      id: record.id,
      files,
      source: record.source === 'predicted' ? 'predicted' : 'actual',
    };
    if (typeof record.prNumber === 'number' && Number.isFinite(record.prNumber)) {
      entry.prNumber = record.prNumber;
    }
    if (typeof record.headSha === 'string' && record.headSha.length > 0) {
      entry.headSha = record.headSha;
    }
    if (typeof record.phase === 'string' && record.phase.length > 0) {
      entry.phase = record.phase;
    }
    if (record.touchSet === 'unknown') entry.touchSet = 'unknown';
    result.push(entry);
  }
  return result;
}

function normalizeFiles(raw: unknown, index: number, source: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`In-flight row at index ${index} in ${source} must have a files array`);
  }
  const out = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string' || value.length === 0) continue;
    out.add(value);
  }
  return [...out].sort();
}

/**
 * Augment a queue plan by synthesizing `sharedSurfaceConflicts` edges from
 * the intersection of each backlog candidate's predicted touch set and each
 * in-flight task's actual (or predicted-planning) touch set.
 *
 * Pure: no I/O, deterministic ordering, pre-existing edges preserved, and a
 * duplicate `(candidate, in-flight)` pair unions files without duplication.
 */
export function augmentPlanWithInFlight(
  plan: QueuePlan,
  inFlight: readonly InFlightTouchSet[],
  candidateTouchSets: ReadonlyMap<string, readonly string[]>,
  options: { ignorePatterns?: readonly string[] } = {},
): QueuePlan {
  const ignore = options.ignorePatterns ?? DEFAULT_IGNORE_PATTERNS;
  const inFlightById = new Map<string, InFlightTouchSet>();
  for (const task of inFlight) inFlightById.set(task.id, task);

  const existingEdges = plan.sharedSurfaceConflicts ?? [];
  // Index pre-existing edges by their unordered pair for in-place augmentation.
  const edgeByPair = new Map<string, ConflictEdge>();
  const orderedEdges: ConflictEdge[] = [];
  for (const edge of existingEdges) {
    const [a, b] = compareTaskIds(edge.a, edge.b) <= 0 ? [edge.a, edge.b] : [edge.b, edge.a];
    const key = `${a}\u0000${b}`;
    const normalized: ConflictEdge = { ...edge, a, b, files: [...(edge.files ?? [])] };
    edgeByPair.set(key, normalized);
    orderedEdges.push(normalized);
  }

  for (const [candidateId, candidateFiles] of candidateTouchSets.entries()) {
    const candidateFiltered = filterIgnoredFiles(candidateFiles, ignore);
    if (candidateFiltered.length === 0) continue;
    for (const task of inFlight) {
      const overlap = findFileOverlap(candidateFiltered, task.files, ignore);
      if (overlap.length === 0) continue;
      const [a, b] = compareTaskIds(candidateId, task.id) <= 0
        ? [candidateId, task.id]
        : [task.id, candidateId];
      const key = `${a}\u0000${b}`;
      const existing = edgeByPair.get(key);
      if (existing) {
        const merged = new Set<string>(existing.files);
        for (const f of overlap) merged.add(f);
        existing.files = [...merged].sort();
        continue;
      }
      const synthesized: ConflictEdge = {
        a,
        b,
        files: overlap,
        source: 'inferred',
      };
      edgeByPair.set(key, synthesized);
      orderedEdges.push(synthesized);
    }
  }

  // In-flight tasks are not backlog candidates, so they will never appear in
  // candidateTouchSets. The synthesized edge pairs each one with the backlog
  // id — enough for selectLaunchSet's adjacency check — and keeps edge order
  // stable (compareTaskIds, like buildSharedSurfaceConflicts).
  const sortedEdges = [...orderedEdges].sort((x, y) =>
    compareTaskIds(x.a, y.a) || compareTaskIds(x.b, y.b),
  );
  // Preserve inFlightById for callers that want to inspect it later.
  void inFlightById;

  return { ...plan, sharedSurfaceConflicts: sortedEdges };
}
