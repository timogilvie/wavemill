import type { DependencyEdge, PlanResult, TriageRecord } from './task-dependency-planner.ts';
import { extractProseDependencies, parseTaskId } from './task-identity.ts';
import {
  evaluateRecordedTaskSize,
  parseSizeSection,
  type SizeReason,
  type TaskSizeLimits,
} from './task-size.ts';

export type BacklogRecord = {
  id: string;
  title?: string;
  dependsOn?: string[];
  sharedSurface?: string[];
  description?: string;
  parentId?: string;
  labels?: string[];
  [key: string]: unknown;
};

/** A warning about unmet preconditions or unresolved prose references. */
export type PlanWarning = {
  taskId: string;
  kind: 'prose_reference_unresolved' | 'prose_reference_ambiguous' | 'subjective_precondition';
  message: string;
  evidence?: string;
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
  /**
   * Per-task touch-set prediction quality (HOK-3307). When a task's status is
   * `'unknown'`, `selectLaunchSet` holds it with `touch_set_unknown`. Absence
   * of a task's ID means the caller did not compute grounded touch sets for it
   * (e.g. cache-only run), which is treated conservatively as `unknown`.
   *
   * Only populated by the grounded planner path; absent otherwise.
   */
  touchSetStatus?: Record<string, 'predicted' | 'empty-confirmed' | 'unknown'>;
  /** Operator holds from the `wm:hold` label. Maps task ID to optional hold note. */
  operatorHolds?: Record<string, { note?: string }>;
  /**
   * Size holds from packet §12 (HOK-3469). A task whose recorded estimate is
   * over the current limits, or a `wm:split` parent, is held with
   * `oversized_task` unless it carries `wm:size-override`.
   */
  sizeHolds?: Record<string, SizeHold>;
  /** Plan warnings for unmet preconditions or unresolved references. */
  planWarnings?: PlanWarning[];
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
  | 'operator_hold'
  | 'oversized_task';

/** A recorded size hold (HOK-3469): the numbers from packet §12 plus the proposal. */
export type SizeHold = {
  reasons: SizeReason[];
  addedLines: number | null;
  fileCount: number;
  coreFiles: string[];
  /** Proposed slice titles, in order. */
  slices: string[];
  /** Slice issue ids recorded after the operator accepted the proposal. */
  accepted?: string[];
};

export type HeldTaskDetail =
  | { kind: 'depends_on'; blockedBy: string[] }
  | { kind: 'conflicts_with_selected'; taskId: string; files: string[] }
  | { kind: 'conflicts_with_in_flight'; taskId: string; prNumber?: number; files: string[]; touchSetUnknown?: true }
  | { kind: 'slots_full' }
  | { kind: 'touch_set_unknown' }
  | { kind: 'operator_hold'; note?: string }
  | {
    kind: 'oversized_task';
    reasons: SizeReason[];
    addedLines?: number;
    fileCount: number;
    coreFiles?: string[];
    slices: string[];
    accepted?: string[];
  };

export interface HeldTask {
  id: string;
  reason: HoldReason;
  detail: HeldTaskDetail;
}

export interface InFlightTask {
  id: string;
  prNumber?: number;
  files?: string[];
  /**
   * HOK-3373: `'unknown'` when the monitor could not resolve the task's
   * worktree to a registered git worktree of the current run (missing,
   * recreated as a plain directory, or another checkout). An unknown
   * in-flight touch set is never "touches nothing": every candidate is held
   * against it until the worktree resolves or the run settles (a settled run
   * is excluded from the in-flight set entirely).
   */
  touchSet?: 'known' | 'unknown';
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

/** Extract prose-written dependency edges from backlog records. */
export function extractProseEdges(records: BacklogRecord[]): { edges: DependencyEdge[]; warnings: PlanWarning[] } {
  const edges: DependencyEdge[] = [];
  const warnings: PlanWarning[] = [];
  const allIds = new Set(records.map((r) => r.id));

  // Index siblings by parent for series code resolution
  const byParent = new Map<string, BacklogRecord[]>();
  const siblingSeriesIndex = new Map<string | undefined, Map<string, BacklogRecord[]>>();

  for (const record of records) {
    const parentId = record.parentId ?? undefined;
    if (!byParent.has(parentId)) byParent.set(parentId, []);
    byParent.get(parentId)!.push(record);

    if (!siblingSeriesIndex.has(parentId)) siblingSeriesIndex.set(parentId, new Map());
  }

  // Build series code index (first token of title = series code, e.g., "B2: ...")
  for (const [parentId, siblings] of byParent) {
    const index = siblingSeriesIndex.get(parentId)!;
    for (const sibling of siblings) {
      const title = sibling.title ?? '';
      const match = /^([A-Z]\d{1,3}):/.exec(title);
      if (match) {
        const code = match[1];
        if (!index.has(code)) index.set(code, []);
        index.get(code)!.push(sibling);
      }
    }
  }

  // Extract prose dependencies from each record
  for (const record of records) {
    const proseRefs = extractProseDependencies(record.description);

    for (const ref of proseRefs) {
      let targetId: string | null = null;

      if (ref.kind === 'issue') {
        // Issue ID reference
        const parsed = parseTaskId(ref.target);
        if (parsed) {
          targetId = parsed.taskId;
          if (!allIds.has(targetId)) {
            warnings.push({
              taskId: record.id,
              kind: 'prose_reference_unresolved',
              message: `Unresolved prose reference: "${ref.verb} ${ref.target}" references unknown task`,
              evidence: ref.evidence,
            });
            continue;
          }
        } else {
          warnings.push({
            taskId: record.id,
            kind: 'prose_reference_unresolved',
            message: `Invalid prose reference: "${ref.verb} ${ref.target}" is not a valid issue ID`,
            evidence: ref.evidence,
          });
          continue;
        }
      } else if (ref.kind === 'series') {
        // Series code reference
        if (!record.parentId) {
          warnings.push({
            taskId: record.id,
            kind: 'prose_reference_unresolved',
            message: `Unresolved prose reference: "${ref.verb} ${ref.target}" is a series code but task has no parent`,
            evidence: ref.evidence,
          });
          continue;
        }

        const seriesIndex = siblingSeriesIndex.get(record.parentId) ?? new Map();
        const matches = seriesIndex.get(ref.target) ?? [];

        if (matches.length === 0) {
          warnings.push({
            taskId: record.id,
            kind: 'prose_reference_unresolved',
            message: `Unresolved prose reference: "${ref.verb} ${ref.target}" does not match any sibling`,
            evidence: ref.evidence,
          });
          continue;
        }

        if (matches.length > 1) {
          warnings.push({
            taskId: record.id,
            kind: 'prose_reference_ambiguous',
            message: `Ambiguous prose reference: "${ref.verb} ${ref.target}" matches ${matches.length} siblings`,
            evidence: ref.evidence,
          });
          continue;
        }

        targetId = matches[0]!.id;

        // Self-reference check
        if (targetId === record.id) {
          warnings.push({
            taskId: record.id,
            kind: 'prose_reference_unresolved',
            message: `Invalid prose reference: "${ref.verb} ${ref.target}" references itself`,
            evidence: ref.evidence,
          });
          continue;
        }
      }

      if (targetId) {
        // Check for duplicate edge
        const duplicate = edges.some(
          (e) => e.type === 'depends_on' && e.from === targetId && e.to === record.id && e.source === 'prose',
        );
        if (!duplicate) {
          edges.push({
            type: 'depends_on',
            from: targetId,
            to: record.id,
            source: 'prose',
            reason: ref.evidence,
          });
        }
      }
    }
  }

  return { edges, warnings };
}

/** Extract operator holds from the `wm:hold` label. */
export function extractOperatorHolds(records: BacklogRecord[]): Record<string, { note?: string }> {
  const holds: Record<string, { note?: string }> = {};
  for (const record of records) {
    if (record.labels?.includes('wm:hold')) {
      holds[record.id] = { note: undefined }; // Note is not set — no per-issue label comment yet
    }
  }
  return holds;
}

export const SIZE_OVERRIDE_LABEL = 'wm:size-override';
export const SPLIT_LABEL = 'wm:split';

function reasonsForHold(
  parsed: ReturnType<typeof parseSizeSection>,
  limits: TaskSizeLimits,
): SizeReason[] {
  if (!parsed) return [];
  return evaluateRecordedTaskSize(
    {
      addedLines: parsed.addedLines,
      fileCount: parsed.files.length,
      coreFiles: parsed.coreFiles,
    },
    limits,
  ).reasons;
}

/**
 * Extract size holds from packet §12 (HOK-3469).
 *
 * A task is held when its recorded estimate is over the current limits, or
 * when it is a `wm:split` parent (its work is already split and the parent
 * must never launch). `wm:size-override` releases a single task's hold. This
 * is the only size-hold derivation; the picker consumes the result.
 */
export function extractSizeHolds(
  records: BacklogRecord[],
  limits: TaskSizeLimits,
): Record<string, SizeHold> {
  const holds: Record<string, SizeHold> = {};
  for (const record of records) {
    const labels = record.labels ?? [];
    const split = labels.includes(SPLIT_LABEL);
    // The override releases an estimate-based hold only. A split parent is
    // held because its work already became sub-issues, not because of its
    // size, so it never launches.
    if (!split && labels.includes(SIZE_OVERRIDE_LABEL)) continue;

    const parsed = parseSizeSection(record.description ?? '');
    if (!parsed && !split) continue;

    const reasons = reasonsForHold(parsed, limits);
    if (!split && reasons.length === 0) continue;

    holds[record.id] = {
      reasons,
      addedLines: parsed?.addedLines ?? null,
      fileCount: parsed?.files.length ?? 0,
      coreFiles: parsed?.coreFiles ?? [],
      slices: (parsed?.slices ?? []).map((slice) => slice.title),
      ...(parsed?.accepted && parsed.accepted.length > 0 ? { accepted: [...parsed.accepted] } : {}),
    };
  }
  return holds;
}

/** Build the structured `oversized_task` detail from a recorded hold. */
export function sizeHoldDetail(hold: SizeHold): HeldTaskDetail {
  return {
    kind: 'oversized_task',
    reasons: [...hold.reasons],
    ...(hold.addedLines !== null ? { addedLines: hold.addedLines } : {}),
    fileCount: hold.fileCount,
    ...(hold.coreFiles.length > 0 ? { coreFiles: [...hold.coreFiles] } : {}),
    slices: [...hold.slices],
    ...(hold.accepted && hold.accepted.length > 0 ? { accepted: [...hold.accepted] } : {}),
  };
}

/** Extract plan warnings for unmet preconditions when no blocker or hold is in place. */
export function extractPlanWarnings(
  records: BacklogRecord[],
  blockedTaskIds: Set<string>,
  operatorHolds: Record<string, { note?: string }>,
  sizeHolds: Record<string, SizeHold> = {},
): PlanWarning[] {
  const warnings: PlanWarning[] = [];
  const preconditionPatterns = [/\bremoval criterion\b/i, /\bdecide\b/i, /\bafter \d+ days?\b/i];

  const seenTaskIds = new Set<string>();

  for (const record of records) {
    if (blockedTaskIds.has(record.id) || operatorHolds[record.id] || sizeHolds[record.id]) {
      continue; // Task is already blocked or held
    }

    if (seenTaskIds.has(record.id)) {
      continue; // Already warned about this task
    }

    const text = record.description ?? '';
    for (const pattern of preconditionPatterns) {
      const match = pattern.exec(text);
      if (match) {
        warnings.push({
          taskId: record.id,
          kind: 'subjective_precondition',
          message: `Unmet precondition: task description mentions "${match[0]}"`,
          evidence: text.substring(Math.max(0, match.index - 50), Math.min(text.length, match.index + match[0].length + 50)),
        });
        seenTaskIds.add(record.id);
        break;
      }
    }
  }

  return warnings;
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
  const unknownInFlightTasks = [...inFlightById.values()]
    .filter((task) => task.touchSet === 'unknown')
    .sort((p, q) => compareTaskIds(p.id, q.id));

  const universe = plan.availableNow.map((id) => {
    const meta = metaById.get(id);
    // Precedence: operator_hold > plan.touchSetStatus === 'unknown' > meta.touchSetKnown.
    // When touchSetStatus is present but the task has no entry, treat conservatively
    // as unknown (the plan was computed but this task was missed).
    const planStatus = plan.touchSetStatus?.[id];
    let touchSetKnown: boolean;
    if (planStatus !== undefined) {
      touchSetKnown = planStatus !== 'unknown';
    } else if (plan.touchSetStatus !== undefined) {
      // touchSetStatus map present but this task absent — conservatively unknown
      touchSetKnown = false;
    } else {
      // No touchSetStatus on plan (non-grounded path) — fall back to meta
      touchSetKnown = meta?.touchSetKnown !== false;
    }
    // Operator hold precedence: plan.operatorHolds > meta.operatorHoldReason
    const planHold = plan.operatorHolds?.[id];
    const operatorHoldReason = planHold ? (planHold.note ?? '') : meta?.operatorHoldReason;
    return {
      id,
      score: meta?.score ?? 0,
      priority: meta?.priority ?? 0,
      touchSetKnown,
      operatorHoldReason,
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

    // HOK-3469: a recorded size hold outranks touch-set uncertainty. Held rows
    // are never offered for launch.
    const sizeHold = plan.sizeHolds?.[task.id];
    if (sizeHold) {
      held.push({ id: task.id, reason: 'oversized_task', detail: sizeHoldDetail(sizeHold) });
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

    // HOK-3373: an in-flight task whose touch set is unknown can overlap
    // anything, so no candidate is provably disjoint from it (HOK-3307's
    // "unknown is never safe", applied to the in-flight side).
    const unknownInFlight = unknownInFlightTasks[0];
    if (unknownInFlight) {
      const detail: HeldTaskDetail = unknownInFlight.prNumber !== undefined
        ? { kind: 'conflicts_with_in_flight', taskId: unknownInFlight.id, prNumber: unknownInFlight.prNumber, files: [], touchSetUnknown: true }
        : { kind: 'conflicts_with_in_flight', taskId: unknownInFlight.id, files: [], touchSetUnknown: true };
      held.push({ id: task.id, reason: 'conflicts_with_in_flight', detail });
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
