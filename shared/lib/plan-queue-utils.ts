import type { DependencyEdge, PlanResult, TriageRecord } from './task-dependency-planner.ts';

export type BacklogRecord = {
  id: string;
  title?: string;
  dependsOn?: string[];
  sharedSurface?: string[];
  [key: string]: unknown;
};

export interface ConflictEdge {
  a: string;
  b: string;
  files: string[];
  evidence?: string;
  source?: 'inferred' | 'explicit';
}

export type QueuePlan = {
  availableNow: string[];
  queuedAfterDependencies: Array<{ taskId: string; ancestors: string[] }>;
  avoidRunningTogether: string[][];
  sharedSurfaceConflicts?: ConflictEdge[];
  needsTriage: TriageRecord[];
};

export type TaskWithScore = {
  id: string;
  score: number;
  priority?: number;
  touchSetKnown?: boolean;
  operatorHoldReason?: string;
};

export type WaveSelection = {
  wave: string[];
  deferred: string[];
};

export type HoldReason =
  | 'depends_on'
  | 'conflicts_with_selected'
  | 'conflicts_with_in_flight'
  | 'slots_full'
  | 'touch_set_unknown'
  | 'operator_hold';

export type HeldTaskDetail =
  | { kind: 'depends_on'; blockedBy: string[] }
  | { kind: 'conflicts_with_selected'; taskId: string; files: string[] }
  | { kind: 'conflicts_with_in_flight'; taskId: string; prNumber?: number; files: string[] }
  | { kind: 'slots_full' }
  | { kind: 'touch_set_unknown' }
  | { kind: 'operator_hold'; note?: string };

export interface HeldTask {
  id: string;
  reason: HoldReason;
  detail: HeldTaskDetail;
}

export interface InFlightTask {
  id: string;
  prNumber?: number;
  files?: string[];
}

export interface LaunchSet {
  launchNext: string[];
  held: HeldTask[];
  slotsFull: string[];
}

export const compareTaskIds = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

export function parseBacklogJson(raw: string, source: string): BacklogRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse backlog JSON from ${source}: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`Backlog JSON from ${source} must be an array`);

  return parsed.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`Backlog record at index ${index} must be an object`);
    }
    const record = item as BacklogRecord;
    if (typeof record.id !== 'string' || record.id.trim() === '') {
      throw new Error(`Backlog record at index ${index} must have a non-empty string id`);
    }
    for (const key of ['dependsOn', 'sharedSurface'] as const) {
      const value = record[key];
      if (value !== undefined && (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || id.trim() === ''))) {
        throw new Error(`${key} for ${record.id} must be an array of non-empty strings`);
      }
    }
    return record;
  });
}

export function extractEdgesFromBacklog(records: BacklogRecord[]): DependencyEdge[] {
  return records.flatMap((record) => [
    ...(record.dependsOn ?? []).map((dependency) => ({
      type: 'depends_on' as const,
      from: dependency,
      to: record.id,
      source: 'explicit' as const,
    })),
    ...(record.sharedSurface ?? []).map((peer) => ({
      type: 'shared_surface' as const,
      from: record.id,
      to: peer,
      source: 'explicit' as const,
    })),
  ]);
}

export function clusterSharedSurface(edges: DependencyEdge[]): string[][] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const current = parent.get(id) ?? id;
    if (current === id) {
      parent.set(id, id);
      return id;
    }
    const root = find(current);
    parent.set(id, root);
    return root;
  };

  for (const edge of edges) {
    if (edge.type !== 'shared_surface') continue;
    const rootA = find(edge.from);
    const rootB = find(edge.to);
    if (rootA !== rootB) parent.set(rootB, rootA);
  }

  const groups = new Map<string, string[]>();
  for (const id of parent.keys()) groups.set(find(id), [...(groups.get(find(id)) ?? []), id]);
  return [...groups.values()]
    .map((group) => group.sort(compareTaskIds))
    .filter((group) => group.length > 1)
    .sort((a, b) => compareTaskIds(a[0] ?? '', b[0] ?? ''));
}

export function buildSharedSurfaceConflicts(edges: DependencyEdge[]): ConflictEdge[] {
  const byKey = new Map<string, ConflictEdge>();
  for (const edge of edges) {
    if (edge.type !== 'shared_surface') continue;
    if (edge.from === edge.to) continue;
    const [a, b] = compareTaskIds(edge.from, edge.to) <= 0 ? [edge.from, edge.to] : [edge.to, edge.from];
    const key = `${a}\u0000${b}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.files = [...new Set([...existing.files, ...(edge.files ?? [])])].sort();
      // Prefer explicit source over inferred when deduplicating.
      if (!existing.source && edge.source) existing.source = edge.source;
      if (!existing.evidence && edge.reason) existing.evidence = edge.reason;
      continue;
    }
    const conflict: ConflictEdge = { a, b, files: [...new Set(edge.files ?? [])].sort() };
    if (edge.reason) conflict.evidence = edge.reason;
    if (edge.source) conflict.source = edge.source;
    byKey.set(key, conflict);
  }
  return [...byKey.values()].sort((x, y) => compareTaskIds(x.a, y.a) || compareTaskIds(x.b, y.b));
}

export function buildQueuePlan(edges: DependencyEdge[], result: PlanResult): QueuePlan {
  const normalizeId = (id: string) => id.trim().toUpperCase();
  const knownTaskIds = new Set(result.queues.map((queue) => normalizeId(queue.taskId)));
  const externalBlockersByTask = new Map<string, Set<string>>();

  const displayableTriage = result.triage.filter((record) => {
    if (record.reason === 'duplicate') {
      return false;
    }
    if (
      record.reason === 'unknown_endpoint' &&
      record.edge.type === 'depends_on' &&
      knownTaskIds.has(normalizeId(record.edge.to)) &&
      !knownTaskIds.has(normalizeId(record.edge.from))
    ) {
      const taskId = normalizeId(record.edge.to);
      if (!externalBlockersByTask.has(taskId)) {
        externalBlockersByTask.set(taskId, new Set<string>());
      }
      externalBlockersByTask.get(taskId)?.add(record.edge.from);
      return false;
    }
    return true;
  });

  const triagedTaskIds = new Set(displayableTriage.flatMap((record) => [record.edge.from, record.edge.to]).map(normalizeId));
  const queues = result.queues.filter((queue) => !triagedTaskIds.has(normalizeId(queue.taskId)));
  const availableNow = queues
    .filter((queue) => queue.ancestors.length === 0 && !externalBlockersByTask.has(normalizeId(queue.taskId)))
    .map((queue) => queue.taskId);
  const queuedAfterDependencies = queues
    .map((queue) => {
      const hiddenBlockers = externalBlockersByTask.get(normalizeId(queue.taskId)) ?? new Set<string>();
      const ancestors = [...new Set([...queue.ancestors, ...hiddenBlockers])];
      return { taskId: queue.taskId, ancestors };
    })
    .filter((queue) => queue.ancestors.length > 0);
  const nonTriagedEdges = edges.filter((edge) => !triagedTaskIds.has(normalizeId(edge.from)) && !triagedTaskIds.has(normalizeId(edge.to)));
  return {
    availableNow,
    queuedAfterDependencies,
    avoidRunningTogether: clusterSharedSurface(nonTriagedEdges),
    sharedSurfaceConflicts: buildSharedSurfaceConflicts(nonTriagedEdges),
    needsTriage: displayableTriage,
  };
}

/**
 * Pairwise greedy launch-set selector (HOK-3303).
 *
 * Returns `{ launchNext, held, slotsFull }`. Every task in `plan.availableNow`
 * appears in exactly one of the three arrays; every `held` entry carries one
 * primary `HoldReason` and a matching structured `detail` the picker UI (2/9),
 * decision log (8/9) and auto-launch (9/9) all consume unchanged.
 *
 * Why pairwise, not clustered: a chain `A~B~C` where B is the hub must not
 * collapse `A` and `C` into the same no-run cluster. Each `ConflictEdge` in
 * `plan.sharedSurfaceConflicts` blocks only its two endpoints from running
 * together.
 */
export function selectLaunchSet(
  plan: QueuePlan,
  scoredTasks: TaskWithScore[],
  options: { freeSlots: number; inFlight?: InFlightTask[] },
): LaunchSet {
  if (!Array.isArray(plan.availableNow)) {
    throw new TypeError('Queue plan must include availableNow');
  }
  if (!Number.isInteger(options.freeSlots) || options.freeSlots < 0) {
    throw new RangeError('freeSlots must be a non-negative integer');
  }

  const metaById = new Map<string, TaskWithScore>();
  for (const task of scoredTasks) metaById.set(task.id, task);

  const blockedBy = new Map<string, string[]>();
  for (const entry of plan.queuedAfterDependencies ?? []) {
    if (entry.ancestors.length > 0) blockedBy.set(entry.taskId, [...entry.ancestors]);
  }

  const conflictAdj = new Map<string, Array<{ peer: string; files: string[] }>>();
  for (const edge of plan.sharedSurfaceConflicts ?? []) {
    const files = [...(edge.files ?? [])];
    const addAdj = (from: string, to: string) => {
      const list = conflictAdj.get(from) ?? [];
      list.push({ peer: to, files });
      conflictAdj.set(from, list);
    };
    addAdj(edge.a, edge.b);
    addAdj(edge.b, edge.a);
  }

  const inFlightById = new Map<string, InFlightTask>();
  for (const task of options.inFlight ?? []) {
    inFlightById.set(task.id, task);
  }

  const universe = plan.availableNow.map((id) => {
    const meta = metaById.get(id);
    return {
      id,
      score: meta?.score ?? 0,
      priority: meta?.priority ?? 0,
      touchSetKnown: meta?.touchSetKnown !== false,
      operatorHoldReason: meta?.operatorHoldReason,
    };
  });

  universe.sort((x, y) => {
    if (y.score !== x.score) return y.score - x.score;
    if (y.priority !== x.priority) return y.priority - x.priority;
    return compareTaskIds(x.id, y.id);
  });

  const launchNext: string[] = [];
  const held: HeldTask[] = [];
  const slotsFull: string[] = [];
  const selectedSet = new Set<string>();

  for (const task of universe) {
    if (task.operatorHoldReason !== undefined) {
      const detail: HeldTaskDetail =
        task.operatorHoldReason.length > 0
          ? { kind: 'operator_hold', note: task.operatorHoldReason }
          : { kind: 'operator_hold' };
      held.push({ id: task.id, reason: 'operator_hold', detail });
      continue;
    }

    if (!task.touchSetKnown) {
      held.push({ id: task.id, reason: 'touch_set_unknown', detail: { kind: 'touch_set_unknown' } });
      continue;
    }

    const ancestors = blockedBy.get(task.id);
    if (ancestors && ancestors.length > 0) {
      held.push({
        id: task.id,
        reason: 'depends_on',
        detail: { kind: 'depends_on', blockedBy: [...ancestors] },
      });
      continue;
    }

    const adj = conflictAdj.get(task.id) ?? [];

    // In-flight conflict wins over selected-conflict so the operator sees the
    // more durable reason first.
    const inFlightMatches = adj
      .filter((entry) => inFlightById.has(entry.peer))
      .sort((p, q) => compareTaskIds(p.peer, q.peer));
    if (inFlightMatches.length > 0) {
      const match = inFlightMatches[0]!;
      const inflight = inFlightById.get(match.peer)!;
      const files = mergeFiles(match.files, inflight.files);
      const detail: HeldTaskDetail = inflight.prNumber !== undefined
        ? { kind: 'conflicts_with_in_flight', taskId: match.peer, prNumber: inflight.prNumber, files }
        : { kind: 'conflicts_with_in_flight', taskId: match.peer, files };
      held.push({ id: task.id, reason: 'conflicts_with_in_flight', detail });
      continue;
    }

    const selectedMatch = adj.find((entry) => selectedSet.has(entry.peer));
    if (selectedMatch) {
      held.push({
        id: task.id,
        reason: 'conflicts_with_selected',
        detail: {
          kind: 'conflicts_with_selected',
          taskId: selectedMatch.peer,
          files: [...selectedMatch.files],
        },
      });
      continue;
    }

    if (launchNext.length < options.freeSlots) {
      launchNext.push(task.id);
      selectedSet.add(task.id);
      continue;
    }

    slotsFull.push(task.id);
  }

  return { launchNext, held, slotsFull };
}

function mergeFiles(edgeFiles: string[], otherFiles: string[] | undefined): string[] {
  if (!otherFiles || otherFiles.length === 0) return [...edgeFiles];
  const set = new Set<string>(edgeFiles);
  for (const f of otherFiles) set.add(f);
  return [...set].sort();
}

/**
 * @deprecated Use {@link selectLaunchSet}. Kept for one release so the shell
 * compat path (`invoke_first_wave_helper` → `select-wave.ts`) keeps producing
 * `{ wave, deferred }` while the picker epic lands. Reads only
 * `sharedSurfaceConflicts`; `buildQueuePlan` populates it alongside the
 * preview-only `avoidRunningTogether` clusters.
 */
export function selectFirstWave(
  plan: QueuePlan,
  scoredTasks: TaskWithScore[],
  opts: { maxParallel: number }
): WaveSelection {
  if (!Array.isArray(plan.availableNow)) {
    throw new TypeError('Queue plan must include availableNow');
  }
  if (!Number.isInteger(opts.maxParallel) || opts.maxParallel < 0) {
    throw new RangeError('maxParallel must be a non-negative integer');
  }
  // Preserve the historical "no capacity → defer in input order" behaviour that
  // shell callers rely on for the Wave 1 preview rendering.
  if (opts.maxParallel === 0) {
    return { wave: [], deferred: [...plan.availableNow] };
  }
  const set = selectLaunchSet(plan, scoredTasks, {
    freeSlots: opts.maxParallel,
    inFlight: [],
  });
  const deferred = [...set.held.map((h) => h.id), ...set.slotsFull];
  return { wave: set.launchNext, deferred };
}
