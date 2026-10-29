export type EdgeType = 'depends_on' | 'shared_surface';

export interface TaskInput {
  id: string;
  [key: string]: unknown;
}

export interface DependencyEdge {
  type: EdgeType;
  from: string;
  to: string;
  source?: 'inferred' | 'explicit';
  reason?: string;
  files?: string[];
}

export type TriageReason = 'unknown_endpoint' | 'self_loop' | 'duplicate' | 'cycle_participant';

export interface TriageRecord {
  edge: DependencyEdge;
  reason: TriageReason;
  detail?: string;
}

export interface Wave {
  index: number;
  taskIds: string[];
}

export interface DependencyQueue {
  taskId: string;
  ancestors: string[];
}

export interface PlanResult {
  waves: Wave[];
  queues: DependencyQueue[];
  triage: TriageRecord[];
}

export interface PlanOptions {
  triageUnknownEndpoints?: boolean;
}

type PlannerErrorCode = 'unknown_endpoint' | 'cycle' | 'duplicate_task_id' | 'internal';

interface PlannerErrorOptions {
  code: PlannerErrorCode;
  message: string;
  cycle?: string[];
  offendingEdge?: DependencyEdge;
}

export class TaskDependencyPlannerError extends Error {
  readonly code: PlannerErrorCode;
  readonly cycle?: string[];
  readonly offendingEdge?: DependencyEdge;

  constructor(options: PlannerErrorOptions) {
    super(options.message);
    this.name = 'TaskDependencyPlannerError';
    this.code = options.code;
    this.cycle = options.cycle;
    this.offendingEdge = options.offendingEdge;
  }
}

interface NormalizedResult {
  cleanEdges: DependencyEdge[];
  triage: TriageRecord[];
  taskIds: string[];
}

const TASK_ID_COMPARATOR = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });

function validateAndNormalize(
  inputs: TaskInput[],
  edges: DependencyEdge[],
  options?: PlanOptions,
): NormalizedResult {
  const taskIdSet = new Set<string>();
  for (const input of inputs) {
    if (taskIdSet.has(input.id)) {
      throw new TaskDependencyPlannerError({
        code: 'duplicate_task_id',
        message: `Duplicate task id: ${input.id}`,
      });
    }
    taskIdSet.add(input.id);
  }

  const triage: TriageRecord[] = [];
  const cleanEdges: DependencyEdge[] = [];
  const seenEdgeKeys = new Set<string>();

  for (const edge of edges) {
    if (edge.from === edge.to) {
      triage.push({ edge, reason: 'self_loop', detail: `Self-loop on ${edge.from}` });
      continue;
    }

    const edgeKey = `${edge.type}\u0000${edge.from}\u0000${edge.to}`;
    if (seenEdgeKeys.has(edgeKey)) {
      triage.push({ edge, reason: 'duplicate', detail: `Duplicate edge ${edge.type}:${edge.from}->${edge.to}` });
      continue;
    }

    const fromKnown = taskIdSet.has(edge.from);
    const toKnown = taskIdSet.has(edge.to);
    if (!fromKnown || !toKnown) {
      if (options?.triageUnknownEndpoints === true) {
        triage.push({ edge, reason: 'unknown_endpoint', detail: `Unknown endpoint in ${edge.from}->${edge.to}` });
        continue;
      }

      throw new TaskDependencyPlannerError({
        code: 'unknown_endpoint',
        message: `Edge references unknown task id: ${edge.from}->${edge.to}`,
        offendingEdge: edge,
      });
    }

    seenEdgeKeys.add(edgeKey);
    cleanEdges.push(edge);
  }

  return {
    cleanEdges,
    triage,
    taskIds: [...taskIdSet].sort(TASK_ID_COMPARATOR),
  };
}

function extractCyclePath(stack: string[], backTarget: string): string[] {
  const startIndex = stack.lastIndexOf(backTarget);
  if (startIndex < 0) {
    return [backTarget];
  }
  return [...stack.slice(startIndex), backTarget];
}

function detectCycles(taskIds: string[], edges: DependencyEdge[]): void {
  const adjacency = new Map<string, string[]>();
  for (const taskId of taskIds) {
    adjacency.set(taskId, []);
  }

  for (const edge of edges) {
    if (edge.type !== 'depends_on') {
      continue;
    }
    adjacency.get(edge.from)?.push(edge.to);
  }

  for (const neighbors of adjacency.values()) {
    neighbors.sort(TASK_ID_COMPARATOR);
  }

  const color = new Map<string, 0 | 1 | 2>();
  for (const taskId of taskIds) {
    color.set(taskId, 0);
  }

  for (const startTask of taskIds) {
    if (color.get(startTask) !== 0) {
      continue;
    }

    const nodeStack: string[] = [];
    const frameStack: Array<{ node: string; nextIndex: number }> = [{ node: startTask, nextIndex: 0 }];
    color.set(startTask, 1);
    nodeStack.push(startTask);

    while (frameStack.length > 0) {
      const frame = frameStack[frameStack.length - 1];
      const neighbors = adjacency.get(frame.node);
      if (!neighbors) {
        throw new TaskDependencyPlannerError({
          code: 'internal',
          message: `Missing adjacency list for task ${frame.node}`,
        });
      }

      if (frame.nextIndex >= neighbors.length) {
        color.set(frame.node, 2);
        frameStack.pop();
        nodeStack.pop();
        continue;
      }

      const neighbor = neighbors[frame.nextIndex];
      frame.nextIndex++;

      const neighborColor = color.get(neighbor);
      if (neighborColor === undefined) {
        throw new TaskDependencyPlannerError({
          code: 'internal',
          message: `Unknown task in graph traversal: ${neighbor}`,
        });
      }

      if (neighborColor === 1) {
        throw new TaskDependencyPlannerError({
          code: 'cycle',
          message: `Dependency cycle detected: ${extractCyclePath(nodeStack, neighbor).join(' -> ')}`,
          cycle: extractCyclePath(nodeStack, neighbor),
        });
      }

      if (neighborColor === 0) {
        color.set(neighbor, 1);
        frameStack.push({ node: neighbor, nextIndex: 0 });
        nodeStack.push(neighbor);
      }
    }
  }
}

function packWaves(taskIds: string[], edges: DependencyEdge[]): Wave[] {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const taskId of taskIds) {
    inDegree.set(taskId, 0);
    adjacency.set(taskId, []);
  }

  for (const edge of edges) {
    if (edge.type !== 'depends_on') {
      continue;
    }

    adjacency.get(edge.from)?.push(edge.to);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  for (const neighbors of adjacency.values()) {
    neighbors.sort(TASK_ID_COMPARATOR);
  }

  let frontier = taskIds.filter((taskId) => (inDegree.get(taskId) ?? 0) === 0).sort(TASK_ID_COMPARATOR);
  const waves: Wave[] = [];
  let processed = 0;
  let waveIndex = 0;

  while (frontier.length > 0) {
    waves.push({ index: waveIndex, taskIds: [...frontier] });
    processed += frontier.length;

    const nextFrontier: string[] = [];
    for (const taskId of frontier) {
      const neighbors = adjacency.get(taskId);
      if (!neighbors) {
        throw new TaskDependencyPlannerError({
          code: 'internal',
          message: `Missing adjacency list for task ${taskId}`,
        });
      }

      for (const dependent of neighbors) {
        const nextDegree = (inDegree.get(dependent) ?? 0) - 1;
        inDegree.set(dependent, nextDegree);
        if (nextDegree === 0) {
          nextFrontier.push(dependent);
        }
      }
    }

    frontier = nextFrontier.sort(TASK_ID_COMPARATOR);
    waveIndex++;
  }

  if (processed !== taskIds.length) {
    throw new TaskDependencyPlannerError({
      code: 'internal',
      message: 'Failed to topologically pack all tasks after cycle validation',
    });
  }

  return waves;
}

function deriveQueues(taskIds: string[], waves: Wave[], edges: DependencyEdge[]): DependencyQueue[] {
  const predecessors = new Map<string, string[]>();
  for (const taskId of taskIds) {
    predecessors.set(taskId, []);
  }

  for (const edge of edges) {
    if (edge.type !== 'depends_on') {
      continue;
    }
    predecessors.get(edge.to)?.push(edge.from);
  }

  for (const pred of predecessors.values()) {
    pred.sort(TASK_ID_COMPARATOR);
  }

  const waveIndexByTask = new Map<string, number>();
  for (const wave of waves) {
    for (const taskId of wave.taskIds) {
      waveIndexByTask.set(taskId, wave.index);
    }
  }

  const queues: DependencyQueue[] = [];
  for (const taskId of taskIds) {
    const ancestorSet = new Set<string>();
    const stack = [...(predecessors.get(taskId) ?? [])];

    while (stack.length > 0) {
      const candidate = stack.pop();
      if (!candidate || ancestorSet.has(candidate)) {
        continue;
      }

      ancestorSet.add(candidate);
      for (const parent of predecessors.get(candidate) ?? []) {
        if (!ancestorSet.has(parent)) {
          stack.push(parent);
        }
      }
    }

    const ancestors = [...ancestorSet].sort((a, b) => {
      const aWave = waveIndexByTask.get(a);
      const bWave = waveIndexByTask.get(b);

      if (aWave === undefined || bWave === undefined) {
        throw new TaskDependencyPlannerError({
          code: 'internal',
          message: `Missing wave index for ancestor ordering: ${a} or ${b}`,
        });
      }

      if (aWave !== bWave) {
        return aWave - bWave;
      }

      return TASK_ID_COMPARATOR(a, b);
    });

    queues.push({ taskId, ancestors });
  }

  return queues.sort((a, b) => TASK_ID_COMPARATOR(a.taskId, b.taskId));
}

export function planTaskDependencies(
  inputs: TaskInput[],
  edges: DependencyEdge[],
  options?: PlanOptions,
): PlanResult {
  const { cleanEdges, triage, taskIds } = validateAndNormalize(inputs, edges, options);
  detectCycles(taskIds, cleanEdges);
  const waves = packWaves(taskIds, cleanEdges);
  const queues = deriveQueues(taskIds, waves, cleanEdges);

  return {
    waves,
    queues,
    triage,
  };
}
