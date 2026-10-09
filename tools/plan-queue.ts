#!/usr/bin/env -S npx tsx
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  assembleNearbyContext,
  buildPartialRefreshPrompt,
  parseQueueAnalysisEdges,
} from '../shared/lib/queue-partial-refresh.ts';
import { runTool } from '../shared/lib/tool-runner.ts';
import { getBacklog, type LinearIssue } from '../shared/lib/linear.ts';
import {
  planTaskDependencies,
  TaskDependencyPlannerError,
  type DependencyEdge,
  type PlanResult,
} from '../shared/lib/task-dependency-planner.ts';
import {
  cachedEdgesToDependencyEdges,
  computeBacklogDiff,
  computeTaskFingerprint,
  getCacheStats,
  loadCache,
  mergeEdges,
  pruneCache,
  retainPreviousFingerprints,
  saveCache,
  type CacheFile,
  type FingerprintableTask,
} from '../shared/lib/task-dependency-plan-cache.ts';
import {
  parseBacklogJson,
  extractEdgesFromBacklog,
  buildQueuePlan,
  compareTaskIds,
  type BacklogRecord,
  type QueuePlan,
} from '../shared/lib/plan-queue-utils.ts';
import { toKebabCase } from '../shared/lib/string-utils.ts';
import { getQueuePlannerConfig } from '../shared/lib/config.ts';
import type { GroundedPlanResult } from '../shared/lib/grounded-planner.ts';
import {
  buildInferenceReport,
  isInCooldown,
  planInferenceRefresh,
  recordInferenceFailure,
  recordInferenceSuccess,
  type InferenceRefreshPlan,
  type QueueInferenceState,
} from '../shared/lib/queue-inference-status.ts';

const queueAnalysisPromptPath = fileURLToPath(new URL('./prompts/queue-analysis.md', import.meta.url));
// HOK-3179: no fixed per-attempt timeout any more. The absolute classifier
// deadline (monitor watchdog minus grace) is the only cap; the first capable
// candidate gets the whole remaining budget. Fixed 25s caps starved every
// candidate when a cold Haiku start plus the (then 46 KB) prompt took ~50s.
const QUEUE_CLASSIFIER_DEADLINE_GRACE_MS = 1_500;
// Bounded output (HOK-3179): a well-formed "edges only" reply fits well under
// 1 KB in practice. The 4.4 k-token runs observed on 2026-10-08 were reasoning
// slop; this cap keeps a model that over-produces from blowing the budget on
// its own output.
const QUEUE_CLASSIFIER_MAX_OUTPUT_TOKENS = 1_024;

function renderPreview(queuePlan: QueuePlan, records: BacklogRecord[]): string {
  const titleById = new Map(records.map((record) => [record.id, record.title ?? '']));
  const task = (id: string) => (titleById.get(id) ? `${id} - ${titleById.get(id)}` : id);
  const section = <T>(heading: string, items: T[], render: (item: T) => string) =>
    [heading, ...(items.length === 0 ? ['(none)'] : items.map(render))].join('\n');

  return [
    section('Available Now', queuePlan.availableNow, (id) => `- ${task(id)}`),
    section('Queued After Dependencies', queuePlan.queuedAfterDependencies, (item) => `- ${task(item.taskId)} (after: ${item.ancestors.join(', ')})`),
    section('Avoid Running Together', queuePlan.avoidRunningTogether, (group) => `- ${group.join(', ')}`),
    section('Needs Triage', queuePlan.needsTriage, (record) => `- ${record.edge.to} (${record.reason}: ${record.detail ?? `${record.edge.from}->${record.edge.to}`})`),
  ].join('\n\n');
}

function renderGroundedPreview(grounded: GroundedPlanResult): string {
  const { waves, stats } = grounded;
  const reason = (r: GroundedPlanResult['waves']['deferrals'][number]['reasons'][number]) =>
    `${r.kind === 'after' ? 'after' : 'conflicts with'} ${r.taskId}${r.verdict && r.verdict !== 'conflict' ? ` [${r.verdict}]` : ''}${r.evidence ? `: ${r.evidence}` : ''}`;
  return [
    'Grounded Waves',
    ...(waves.waves.length === 0 ? ['(none)'] : waves.waves.map((wave) => `- wave ${wave.index}: ${wave.taskIds.join(', ')}`)),
    '',
    'Grounded Deferrals',
    ...(waves.deferrals.length === 0
      ? ['(none)']
      : waves.deferrals.map((deferral) => `- ${deferral.taskId} → wave ${deferral.wave} (${deferral.reasons.map(reason).join('; ')})`)),
    '',
    `grounded: tasks=${stats.tasks} touchSetCacheHits=${stats.touchSetCacheHits} pairsScored=${stats.pairsScored} ` +
      `pairsSentToLlm=${stats.pairsSentToLlm} verdictCacheHits=${stats.verdictCacheHits} llmMs=${stats.llmCallMs} totalMs=${stats.totalMs}`,
  ].join('\n');
}

async function loadBacklogFromLinear(projectName?: string): Promise<BacklogRecord[]> {
  const blockers = (issue: LinearIssue) =>
    (issue.inverseRelations?.nodes ?? [])
      .filter(
        (relation) =>
          relation.type === 'blocks' &&
          relation.issue?.identifier &&
          relation.issue.completedAt == null &&
          relation.issue.canceledAt == null,
      )
      .map((relation) => relation.issue!.identifier)
      .sort(compareTaskIds);
  const blockingRelationIds = (issue: LinearIssue) =>
    (issue.relations?.nodes ?? [])
      .filter(
        (relation) =>
          relation.type === 'blocks' &&
          relation.relatedIssue?.identifier &&
          relation.relatedIssue.completedAt == null &&
          relation.relatedIssue.canceledAt == null,
      )
      .map((relation) => relation.relatedIssue!.identifier)
      .sort(compareTaskIds)
      .filter((identifier, index, all) => identifier !== all[index - 1]);

  return (await getBacklog(projectName)).map((issue) => ({
    id: issue.identifier,
    title: issue.title,
    description: issue.description,
    labels: issue.labels.nodes.map((label) => label.name).sort((a, b) => a.localeCompare(b)),
    priority: issue.priority ?? null,
    priorityLabel: issue.priorityLabel ?? null,
    estimate: issue.estimate ?? null,
    state: issue.state.name,
    dueDate: issue.dueDate ?? null,
    projectMilestone: issue.projectMilestone ?? null,
    blocks: blockingRelationIds(issue),
    dependsOn: blockers(issue),
  }));
}

function readBacklogFile(path: string): BacklogRecord[] {
  try {
    return parseBacklogJson(readFileSync(path, 'utf8'), path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code) {
      throw new Error(`Failed to read backlog file ${path}: ${(error as Error).message}`);
    }
    throw error;
  }
}

function plannerInputMissing(message: string): Error {
  return new Error(`planner_input_missing: ${message}`);
}

function readBacklogStdin(): BacklogRecord[] {
  let raw: string;
  try {
    raw = readFileSync(0, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const codeLabel = code ? ` (${code})` : '';
    throw plannerInputMissing(`failed to read stdin${codeLabel}: ${(error as Error).message}`);
  }

  if (raw.trim() === '') {
    throw plannerInputMissing('stdin was empty');
  }

  return parseBacklogJson(raw, 'stdin');
}

function toCacheTask(record: BacklogRecord): FingerprintableTask {
  return {
    id: record.id,
    title: record.title,
    description: record.description,
    labels: record.labels,
    priority: record.priority,
    estimate: record.estimate,
    state: record.state,
    dueDate: record.dueDate,
    projectMilestone: record.projectMilestone,
    blocks: record.blocks,
  };
}

function dedupeDependencyEdges(edges: DependencyEdge[]): DependencyEdge[] {
  const deduped = new Map<string, DependencyEdge>();

  for (const edge of edges) {
    const key = `${edge.type}\u0000${edge.from}\u0000${edge.to}`;
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, edge);
      continue;
    }

    if (existing.source === 'explicit') continue;
    if (edge.source === 'explicit') {
      deduped.set(key, edge);
    }
  }

  // HOK-3179: when an explicit `depends_on` relation reverses a cached inferred
  // one (explicit A→B, cached B→A), the explicit relation is current ground
  // truth. Drop the stale inferred reversal so it does not create a false cycle
  // or push the task into needsTriage.
  const explicitDirected = new Set<string>();
  for (const edge of deduped.values()) {
    if (edge.source === 'explicit' && edge.type === 'depends_on') {
      explicitDirected.add(`${edge.from}\u0000${edge.to}`);
    }
  }
  for (const [key, edge] of deduped) {
    if (edge.source !== 'inferred' || edge.type !== 'depends_on') continue;
    const reverseKey = `${edge.to}\u0000${edge.from}`;
    if (explicitDirected.has(reverseKey)) {
      deduped.delete(key);
    }
  }

  return [...deduped.values()].sort((a, b) => {
    const typeCompare = a.type.localeCompare(b.type);
    if (typeCompare !== 0) return typeCompare;
    const fromCompare = compareTaskIds(a.from, b.from);
    if (fromCompare !== 0) return fromCompare;
    return compareTaskIds(a.to, b.to);
  });
}

function parseQueueClassifierDeadline(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!/^[0-9]+$/.test(value)) {
    throw new Error('--queue-classifier-deadline-ms must be an epoch-millisecond integer');
  }

  const deadlineMs = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
    throw new Error('--queue-classifier-deadline-ms must be a positive safe integer');
  }

  return deadlineMs;
}

function writeInferenceReport(path: string, report: ReturnType<typeof buildInferenceReport>): void {
  try {
    writeFileSync(path, `${JSON.stringify(report)}\n`, 'utf8');
  } catch (error) {
    process.stderr.write(`plan-queue: failed to write inference report ${path}: ${(error as Error).message}\n`);
  }
}

runTool({
  name: 'plan-queue',
  description: 'Plan read-only task dependency queues from backlog JSON',
  options: {
    'backlog-file': { type: 'string', description: 'Read backlog JSON array from a file' },
    stdin: { type: 'boolean', description: 'Read backlog JSON array from stdin' },
    project: { type: 'string', description: 'Fetch backlog from Linear project name' },
    'cache-key': { type: 'string', description: 'Cache key slug for file/stdin backlog modes' },
    'no-cache': { type: 'boolean', description: 'Disable task dependency cache reads and writes' },
    'refresh-missing-cache': { type: 'boolean', description: 'Run queue analysis when the cache has no fingerprints yet' },
    'no-infer': { type: 'boolean', description: 'Plan from cache + explicit relations only; never call the classifier or write the cache (HOK-3179)' },
    'queue-classifier-deadline-ms': { type: 'string', description: 'Internal: absolute classifier deadline in epoch milliseconds' },
    'inference-report-file': { type: 'string', description: 'Internal: write a queue inference status JSON report to this path' },
    json: { type: 'boolean', description: 'Emit queuePlan JSON' },
    preview: { type: 'boolean', description: 'Emit human-readable preview' },
  },
  examples: [
    'npx tsx tools/plan-queue.ts --backlog-file fixtures/plan-queue/backlog-basic.json --json',
    'cat backlog.json | npx tsx tools/plan-queue.ts --stdin --preview',
    'npx tsx tools/plan-queue.ts --project "My Project" --json --preview',
  ],
  async run({ args }) {
    const sources = [args['backlog-file'], args.stdin, args.project].filter(Boolean);
    if (sources.length !== 1) throw new Error('Usage: provide exactly one input source: --backlog-file <path>, --stdin, or --project <name>');

    const cacheKey = args.project
      ? toKebabCase(args.project)
      : typeof args['cache-key'] === 'string'
      ? toKebabCase(args['cache-key'])
      : args['cache-key'];
    const shouldUseCache = !args['no-cache'] && typeof cacheKey === 'string' && cacheKey.length > 0;
    const noInfer = args['no-infer'] === true;
    const queueClassifierDeadlineMs = parseQueueClassifierDeadline(args['queue-classifier-deadline-ms']);
    const records = args['backlog-file']
      ? readBacklogFile(args['backlog-file'])
      : args.stdin
      ? readBacklogStdin()
      : await loadBacklogFromLinear(args.project);
    const fingerprintTasks = records.map(toCacheTask);
    let cacheBeforePrune: CacheFile | undefined = undefined;
    if (shouldUseCache) {
      try {
        cacheBeforePrune = loadCache(process.cwd(), cacheKey);
      } catch (error) {
        process.stderr.write(`plan-queue: invalid cache key "${cacheKey}": ${(error as Error).message}\n`);
        process.exit(2);
      }
    }
    const cacheAfterPrune = cacheBeforePrune ? pruneCache(cacheBeforePrune, fingerprintTasks) : undefined;
    const explicitEdges = extractEdgesFromBacklog(records);
    const backlogDiff = cacheBeforePrune ? computeBacklogDiff(cacheBeforePrune.fingerprints, fingerprintTasks) : undefined;
    const nowMs = Date.now();
    const previousFingerprints = cacheBeforePrune?.fingerprints ?? {};
    const pendingCount = backlogDiff ? backlogDiff.added.length + backlogDiff.changed.length : 0;
    const inferencePlan: InferenceRefreshPlan = noInfer
      ? { kind: 'none', skipReason: 'no_changes' }
      : cacheBeforePrune
      ? planInferenceRefresh({
        state: cacheBeforePrune.inference,
        previousFingerprintCount: Object.keys(previousFingerprints).length,
        pendingCount,
        recordCount: records.length,
        refreshMissing: args['refresh-missing-cache'] === true,
        nowMs,
      })
      : { kind: 'none', skipReason: 'cache_disabled' };
    let inferenceState: QueueInferenceState | undefined = cacheBeforePrune?.inference;
    const recordIds = records.map((record) => record.id);

    let cacheToSave = cacheAfterPrune;
    let inferredEdges: DependencyEdge[] = cacheAfterPrune ? cachedEdgesToDependencyEdges(cacheAfterPrune.edges) : [];

    if (cacheAfterPrune && inferencePlan.kind === 'none' && pendingCount > 0) {
      // Pending tasks were not analyzed (cooldown, or no refresh requested):
      // keep their old fingerprints so a later run still sees them as pending.
      cacheToSave = { ...cacheAfterPrune, fingerprints: retainPreviousFingerprints(previousFingerprints, recordIds) };
    }

    const plannerMode = getQueuePlannerConfig(process.cwd()).mode;
    let grounded: GroundedPlanResult | undefined;
    let reportPlan: InferenceRefreshPlan = inferencePlan;

    if (plannerMode === 'grounded') {
      // HOK-3131: grounded mode replaces legacy whole-backlog classification.
      // Legacy fingerprints are not advanced, so switching back to legacy
      // still sees every task as pending.
      const { createGroundedLlm, runGroundedPlanning } = await import('../shared/lib/grounded-planner.ts');
      // HOK-3179: --no-infer must never hit the LLM. Treat it like a cooldown so
      // runGroundedPlanning plans from cached touch-sets/verdicts only.
      const coolingDown = noInfer || isInCooldown(cacheBeforePrune?.inference, nowMs);
      grounded = await runGroundedPlanning(
        records.map((record, index) => ({
          ...record,
          priority: typeof record.priority === 'number' ? record.priority : null,
          fingerprint: computeTaskFingerprint(fingerprintTasks[index]),
        })),
        {
          repoDir: process.cwd(),
          cache: cacheAfterPrune ?? {},
          explicitEdges,
          ...(coolingDown
            ? {}
            : {
              llm: createGroundedLlm({
                repoDir: process.cwd(),
                ...(queueClassifierDeadlineMs === undefined
                  ? {}
                  : {
                    deadlineMs: queueClassifierDeadlineMs,
                    deadlineGraceMs: QUEUE_CLASSIFIER_DEADLINE_GRACE_MS,
                  }),
              }),
            }),
          warn: (message) => process.stderr.write(`plan-queue: ${message}\n`),
        },
      );
      inferredEdges = grounded.edges;
      const nowIso = new Date().toISOString();
      if (coolingDown) {
        reportPlan = { kind: 'none', skipReason: 'cooldown' };
      } else if (!grounded.llm.orderingOk) {
        inferenceState = recordInferenceFailure(inferenceState, { error: new Error(grounded.llm.error ?? 'grounded ordering failed'), nowIso });
        reportPlan = { kind: 'full', skipReason: null };
      } else {
        inferenceState = recordInferenceSuccess({ model: grounded.llm.model ?? inferenceState?.lastModel ?? null, nowIso });
        reportPlan = grounded.llm.orderingAttempted ? { kind: 'full', skipReason: null } : { kind: 'none', skipReason: 'no_changes' };
      }
      if (cacheAfterPrune) {
        cacheToSave = {
          ...cacheAfterPrune,
          fingerprints: retainPreviousFingerprints(previousFingerprints, recordIds),
          touchSets: grounded.cache.touchSets,
          groundedVerdicts: grounded.cache.groundedVerdicts,
          ...(inferenceState ? { inference: inferenceState } : {}),
        };
      }
      const { stats } = grounded;
      process.stderr.write(
        `plan-queue: grounded planner: tasks=${stats.tasks} pairsScored=${stats.pairsScored} ` +
          `pairsSentToLlm=${stats.pairsSentToLlm} edges=${grounded.edges.length} waves=${grounded.waves.waves.length}\n`,
      );
    } else if (inferencePlan.kind !== 'none' && cacheAfterPrune && backlogDiff) {
      const isFullRefresh = inferencePlan.kind === 'full';
      const changedTaskIds = isFullRefresh
        ? new Set(recordIds)
        : new Set([...backlogDiff.added, ...backlogDiff.changed]);
      const removedTaskIds = isFullRefresh
        ? new Set<string>()
        : new Set([...backlogDiff.completed, ...backlogDiff.removed]);
      const contextTaskIds = isFullRefresh
        ? [...recordIds].sort(compareTaskIds)
        : assembleNearbyContext({ changedTaskIds, allBacklog: records });
      const taskById = new Map(records.map((record) => [record.id, record]));
      const contextTasks = contextTaskIds
        .map((taskId) => taskById.get(taskId))
        .filter((record): record is BacklogRecord => record !== undefined);
      try {
        const [{ callLLM }, { loadPromptTemplate }] = await Promise.all([
          import('../shared/lib/llm-cli.ts'),
          import('../shared/lib/prompt-utils.ts'),
        ]);
        const promptTemplate = await loadPromptTemplate(queueAnalysisPromptPath);
        const prompt = buildPartialRefreshPrompt({
          changedTaskIds,
          contextTasks,
          template: promptTemplate,
        });
        const llmResult = await callLLM(prompt, {
          taskType: 'classify',
          repoDir: process.cwd(),
          maxOutputTokens: QUEUE_CLASSIFIER_MAX_OUTPUT_TOKENS,
          ...(queueClassifierDeadlineMs === undefined
            ? {}
            : {
              fallbackDeadlineMs: queueClassifierDeadlineMs,
              fallbackDeadlineGraceMs: QUEUE_CLASSIFIER_DEADLINE_GRACE_MS,
            }),
        });
        const currentFingerprints = Object.fromEntries(fingerprintTasks.map((t) => [t.id, computeTaskFingerprint(t)]));
        const fingerprintMap = new Map([...Object.entries(cacheAfterPrune.fingerprints), ...Object.entries(currentFingerprints)]);
        const freshEdges = parseQueueAnalysisEdges(llmResult.text, changedTaskIds, fingerprintMap);
        const mergedCachedEdges = mergeEdges(cacheAfterPrune.edges, freshEdges, { changedTaskIds, removedTaskIds });
        inferredEdges = cachedEdgesToDependencyEdges(mergedCachedEdges);
        inferenceState = recordInferenceSuccess({ model: llmResult.model ?? null, nowIso: new Date().toISOString() });
        cacheToSave = {
          ...cacheAfterPrune,
          edges: mergedCachedEdges,
          fingerprints: currentFingerprints,
          inference: inferenceState,
        };
      } catch (error) {
        const refreshKind = isFullRefresh ? 'initial refresh' : 'partial refresh';
        process.stderr.write(`plan-queue: ${refreshKind} failed, falling back to cached edges: ${(error as Error).message}\n`);
        inferenceState = recordInferenceFailure(inferenceState, { error, nowIso: new Date().toISOString() });
        // Persist the failure (and its cooldown) without advancing fingerprints,
        // so the tasks that were never classified are retried.
        cacheToSave = {
          ...cacheAfterPrune,
          fingerprints: retainPreviousFingerprints(previousFingerprints, recordIds),
          inference: inferenceState,
        };
      }
    }

    const edges = dedupeDependencyEdges([...explicitEdges, ...inferredEdges]);
    let result: PlanResult;
    try {
      result = planTaskDependencies(records, edges, { triageUnknownEndpoints: true });
    } catch (error) {
      if (error instanceof TaskDependencyPlannerError) throw new Error(`Planner failed (${error.code}): ${error.message}`);
      throw error;
    }

    const queuePlan = buildQueuePlan(edges, result);
    const emitJson = args.json || !args.preview;
    if (emitJson) process.stdout.write(`${JSON.stringify(queuePlan, null, 2)}\n`);
    if (args.preview) {
      (emitJson ? process.stderr : process.stdout).write(`${renderPreview(queuePlan, records)}\n`);
      if (grounded) {
        (emitJson ? process.stderr : process.stdout).write(`\n${renderGroundedPreview(grounded)}\n`);
      }
      if (cacheBeforePrune && cacheAfterPrune) {
        const cacheStats = getCacheStats(cacheBeforePrune, cacheAfterPrune);
        process.stderr.write(`cache: hits=0 misses=0 pruned=${cacheStats.totalEdges - cacheStats.retainedEdges}\n`);
      }
    }
    if (cacheToSave && cacheKey && !noInfer) {
      // HOK-3179: --no-infer runs are picker-synchronous reads. They never
      // mutate the cache; the inference-enabled background refresh owns writes.
      await saveCache(process.cwd(), cacheKey, cacheToSave);
    }
    if (typeof args['inference-report-file'] === 'string' && args['inference-report-file'].length > 0) {
      writeInferenceReport(args['inference-report-file'], buildInferenceReport({
        state: inferenceState,
        inferredEdgeCount: edges.filter((edge) => edge.source === 'inferred').length,
        plan: reportPlan,
        nowMs: Date.now(),
      }));
    }
  },
});
