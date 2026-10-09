import type { CachedEdge } from './task-dependency-plan-cache.ts';

export interface QueueRefreshTask {
  id: string;
  title?: string;
  description?: string | null;
  labels?: string[];
  priority?: number | null;
  blocks?: string[];
  dependsOn?: string[];
}

/**
 * Per-task description budget in the queue-analysis prompt (HOK-3130, lowered
 * HOK-3179). Wavemill descriptions are full task packets; dependency cues live
 * in the title and the first paragraph. The old 1 500-char cap bloated the
 * prompt to ~46 KB and pushed every classifier candidate past its budget.
 */
export const QUEUE_ANALYSIS_DESCRIPTION_MAX_CHARS = 400;

/**
 * Hard upper bound on the full queue-analysis prompt (HOK-3179). Guards the
 * budget against regressions in description length, number of context tasks,
 * or future field additions. Enforced in {@link buildPartialRefreshPrompt}.
 */
export const QUEUE_ANALYSIS_PROMPT_MAX_BYTES = 32_000;

const DESCRIPTION_TRUNCATION_SUFFIX = '…[truncated]';

function truncateDescription(description: string, maxChars: number = QUEUE_ANALYSIS_DESCRIPTION_MAX_CHARS): string {
  if (description.length <= maxChars) return description;
  return `${description.slice(0, maxChars).trimEnd()}${DESCRIPTION_TRUNCATION_SUFFIX}`;
}

interface AssembleNearbyContextInput {
  changedTaskIds: Iterable<string>;
  allBacklog: QueueRefreshTask[];
  topN?: number;
}

interface BuildPartialRefreshPromptInput {
  changedTaskIds: Iterable<string>;
  contextTasks: QueueRefreshTask[];
  template: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareTaskIds(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

function fillTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

function normalizeStateName(state: QueueRefreshTask['state']): string {
  if (typeof state === 'string') return state;
  if (state && typeof state.name === 'string') return state.name;
  return '';
}

function formatTask(task: QueueRefreshTask, descriptionMaxChars: number = QUEUE_ANALYSIS_DESCRIPTION_MAX_CHARS): string {
  const description = typeof task.description === 'string' ? truncateDescription(task.description.trim(), descriptionMaxChars) : '';
  return [
    `- id: ${task.id}`,
    `  title: ${task.title ?? ''}`,
    `  priority: ${task.priority ?? 'null'}`,
    `  labels: ${JSON.stringify((task.labels ?? []).slice().sort((a, b) => a.localeCompare(b)))}`,
    `  dependsOn: ${JSON.stringify((task.dependsOn ?? []).slice().sort(compareTaskIds))}`,
    `  blocks: ${JSON.stringify((task.blocks ?? []).slice().sort(compareTaskIds))}`,
    `  description: ${JSON.stringify(description)}`,
  ].join('\n');
}

export function assembleNearbyContext({ changedTaskIds, allBacklog, topN = 10 }: AssembleNearbyContextInput): string[] {
  const changed = new Set(changedTaskIds);
  const tasksById = new Map(allBacklog.map((task) => [task.id, task]));
  const selected = new Set<string>();
  const changedLabels = new Set<string>();
  const changedRelations = new Set<string>();

  for (const taskId of changed) {
    if (!tasksById.has(taskId)) continue;
    selected.add(taskId);
    for (const label of tasksById.get(taskId)?.labels ?? []) changedLabels.add(label);
    changedRelations.add(taskId);
    for (const relationId of tasksById.get(taskId)?.blocks ?? []) changedRelations.add(relationId);
    for (const relationId of tasksById.get(taskId)?.dependsOn ?? []) changedRelations.add(relationId);
  }

  for (const task of allBacklog) {
    if ((task.labels ?? []).some((label) => changedLabels.has(label))) {
      selected.add(task.id);
    }

    const relatedIds = [...(task.blocks ?? []), ...(task.dependsOn ?? [])];
    if (relatedIds.some((relationId) => changedRelations.has(relationId)) || changedRelations.has(task.id)) {
      selected.add(task.id);
    }
  }

  const topBacklog = allBacklog
    .slice()
    .sort((a, b) => {
      const aPriority = typeof a.priority === 'number' ? a.priority : Number.POSITIVE_INFINITY;
      const bPriority = typeof b.priority === 'number' ? b.priority : Number.POSITIVE_INFINITY;
      if (aPriority !== bPriority) return aPriority - bPriority;
      return compareTaskIds(a.id, b.id);
    })
    .slice(0, Math.max(0, topN));
  for (const task of topBacklog) selected.add(task.id);

  for (const task of allBacklog) {
    const stateName = normalizeStateName(task.state).toLowerCase();
    if (stateName.includes('progress') || stateName.includes('review') || stateName.includes('started')) {
      selected.add(task.id);
    }
  }

  return [...selected].sort(compareTaskIds);
}

export function buildPartialRefreshPrompt({ changedTaskIds, contextTasks, template }: BuildPartialRefreshPromptInput): string {
  const sortedContext = contextTasks
    .slice()
    .sort((a, b) => compareTaskIds(a.id, b.id));
  const changedIdsJson = JSON.stringify([...changedTaskIds].sort(compareTaskIds));

  let prompt = fillTemplate(template, {
    CHANGED_TASK_IDS: changedIdsJson,
    CONTEXT_TASKS: sortedContext.map((task) => formatTask(task)).join('\n'),
  });

  if (Buffer.byteLength(prompt, 'utf8') > QUEUE_ANALYSIS_PROMPT_MAX_BYTES) {
    // Defense in depth (HOK-3179): if any input (new fields, many tasks) blows
    // past the budget, trim descriptions further rather than send a prompt we
    // know will time out. Shrink in halving steps until it fits or we hit zero.
    let descriptionCap = Math.max(0, Math.floor(QUEUE_ANALYSIS_DESCRIPTION_MAX_CHARS / 2));
    while (Buffer.byteLength(prompt, 'utf8') > QUEUE_ANALYSIS_PROMPT_MAX_BYTES && descriptionCap >= 0) {
      prompt = fillTemplate(template, {
        CHANGED_TASK_IDS: changedIdsJson,
        CONTEXT_TASKS: sortedContext.map((task) => formatTask(task, descriptionCap)).join('\n'),
      });
      if (descriptionCap === 0) break;
      descriptionCap = Math.floor(descriptionCap / 2);
    }
  }

  return prompt;
}

const FENCE = '```';

/**
 * Tolerate exactly one outer ```json fence (HOK-3130).
 *
 * Claude Haiku answers the queue-analysis prompt as a fenced block, and
 * `llm-cli` strips everything before the first `{`, which leaves only a
 * trailing fence. Both shapes are unwrapped. Anything else that contains a
 * fence (several blocks, prose around the block) is still rejected.
 */
function unwrapSingleJsonFence(text: string): string {
  if (!text.includes(FENCE)) return text;

  const full = text.match(/^```(?:json)?[ \t]*\n([\s\S]*?)\n?```$/i);
  if (full && !full[1].includes(FENCE)) {
    return full[1].trim();
  }

  if (!text.startsWith(FENCE) && text.endsWith(FENCE)) {
    const body = text.slice(0, -FENCE.length);
    if (!body.includes(FENCE)) return body.trim();
  }

  throw new Error('Queue analysis output contains markdown fence');
}

export function parseQueueAnalysisEdges(
  raw: string,
  changedTaskIds: Set<string>,
  fingerprintMap: Map<string, string>,
): CachedEdge[] {
  if (raw.startsWith('\uFEFF')) {
    throw new Error('Queue analysis output contains UTF-8 BOM');
  }

  const trimmed = unwrapSingleJsonFence(raw.trim());

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Queue analysis output is not valid JSON: ${(error as Error).message}`);
  }

  if (!isRecord(parsed)) {
    throw new Error('Queue analysis output must be a JSON object');
  }

  const keys = Object.keys(parsed).sort();
  if (keys.length !== 1 || keys[0] !== 'edges') {
    throw new Error('Queue analysis output must contain exactly: edges');
  }
  if (!Array.isArray(parsed.edges)) {
    throw new Error('Queue analysis output field edges must be an array');
  }

  const classifiedAt = new Date().toISOString();
  const edges: CachedEdge[] = [];
  for (const edge of parsed.edges) {
    if (!isRecord(edge)) continue;
    if (typeof edge.from !== 'string' || typeof edge.to !== 'string') continue;
    if (edge.type !== 'depends_on' && edge.type !== 'shared_surface') continue;

    if (!changedTaskIds.has(edge.from) && !changedTaskIds.has(edge.to)) {
      console.warn(`[queue-analysis] dropping edge outside changed scope: ${edge.from}->${edge.to}`);
      continue;
    }

    const fromFingerprint = fingerprintMap.get(edge.from);
    const toFingerprint = fingerprintMap.get(edge.to);
    if (!fromFingerprint || !toFingerprint) {
      console.warn(`[queue-analysis] dropping edge with missing fingerprint: ${edge.from}->${edge.to}`);
      continue;
    }

    edges.push({
      from: edge.from,
      to: edge.to,
      fromFingerprint,
      toFingerprint,
      kind: 'inferred',
      type: edge.type,
      label: typeof edge.reason === 'string' ? edge.reason : undefined,
      classifiedAt,
    });
  }

  return edges.sort((a, b) => {
    const fromCompare = compareTaskIds(a.from, b.from);
    if (fromCompare !== 0) return fromCompare;
    return compareTaskIds(a.to, b.to);
  });
}
