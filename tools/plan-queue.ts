#!/usr/bin/env -S npx tsx
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { runTool } from '../shared/lib/tool-runner.ts';
import { getBacklog, type LinearIssue } from '../shared/lib/linear.ts';
import {
  planTaskDependencies,
  TaskDependencyPlannerError,
  type DependencyEdge,
  type PlanResult,
} from '../shared/lib/task-dependency-planner.ts';
import {
  computeTaskFingerprint,
  getCacheStats,
  loadCache,
  pruneCache,
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
import type { GroundedPlanResult } from '../shared/lib/grounded-planner.ts';
import {
  buildInferenceReport,
  isInCooldown,
  recordInferenceFailure,
  recordInferenceSuccess,
  type InferenceRefreshPlan,
  type QueueInferenceState,
} from '../shared/lib/queue-inference-status.ts';

// HOK-3179: no fixed per-attempt timeout any more. The absolute classifier
// deadline (monitor watchdog minus grace) is the only cap; the first capable
// candidate gets the whole remaining budget.
const QUEUE_CLASSIFIER_DEADLINE_GRACE_MS = 1_500;

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
    `${r.kind === 'after' ? 'after' : 'conflicts with'} ${r.taskId}${r.verdict ? ` [${r.verdict}]` : ''}${r.evidence ? `: ${r.evidence}` : ''}${r.files?.length ? ` (shared: ${r.files.join(', ')})` : ''}`;
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

function parseQueueClassifierBudget(args: Record<string, unknown>): number | undefined {
  const budgetMs = args['queue-classifier-budget-ms'];
  const legacyDeadline = args['queue-classifier-deadline-ms'];
  if (budgetMs !== undefined) {
    if (!/^[0-9]+$/.test(String(budgetMs))) throw new Error('--queue-classifier-budget-ms must be a millisecond integer');
    const budget = Number.parseInt(String(budgetMs), 10);
    if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error('--queue-classifier-budget-ms must be a positive safe integer');
    return Date.now() + budget;
  }
  if (legacyDeadline !== undefined) {
    if (!/^[0-9]+$/.test(String(legacyDeadline))) throw new Error('--queue-classifier-deadline-ms must be an epoch-millisecond integer');
    const deadlineMs = Number.parseInt(String(legacyDeadline), 10);
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw new Error('--queue-classifier-deadline-ms must be a positive safe integer');
    return deadlineMs;
  }
  return undefined;
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
    'queue-classifier-deadline-ms': { type: 'string', description: 'Internal: absolute classifier deadline in epoch milliseconds (deprecated, use --queue-classifier-budget-ms)' },
    'queue-classifier-budget-ms': { type: 'string', description: 'Internal: relative classifier budget in milliseconds from now (HOK-3202)' },
    'inference-report-file': { type: 'string', description: 'Internal: write a queue inference status JSON report to this path' },
    'in-flight-file': { type: 'string', description: 'Read in-flight tasks + touch sets from a JSON file (HOK-3306)' },
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
    const queueClassifierDeadlineMs = parseQueueClassifierBudget(args);
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
    const nowMs = Date.now();
    let inferenceState: QueueInferenceState | undefined = cacheBeforePrune?.inference;

    let cacheToSave = cacheAfterPrune;
    let inferredEdges: DependencyEdge[] = [];

    // HOK-3307: grounded planner is the only planner path; legacy classifier deleted.
    let grounded: GroundedPlanResult | undefined;
    let reportPlan: InferenceRefreshPlan = { kind: 'none', skipReason: 'cache_disabled' };

    {
      const { createGroundedLlm, runGroundedPlanning } = await import('../shared/lib/grounded-planner.ts');
      // HOK-3179: --no-infer must never hit the LLM. Treat it like a cooldown so
      // runGroundedPlanning plans from cached touch-sets/verdicts only.
      const coolingDown = noInfer || isInCooldown(cacheBeforePrune?.inference, nowMs);
      grounded = await runGroundedPlanning(
        records.map((record, index) => ({
          ...record,
          priority: typeof record.priority === 'number' ? record.priority : null,
          fingerprint: computeTaskFingerprint(fingerprintTasks[index]!),
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
    // HOK-3307: attach per-task touch-set status from grounded planner so
    // selectLaunchSet can hold 'unknown' tasks.
    if (grounded) {
      queuePlan.touchSetStatus = grounded.touchSetStatus;
    }
    // HOK-3306: augment the plan with synthesized shared-surface edges between
    // backlog candidates (via the cached grounded touch sets) and in-flight
    // tasks (actual diffs computed off the monitor hot path). Soft-fail on
    // malformed input — a broken in-flight file must not take down the picker.
    let planToEmit: QueuePlan = queuePlan;
    const inFlightPath = args['in-flight-file'];
    if (typeof inFlightPath === 'string' && inFlightPath.length > 0) {
      try {
        const { parseInFlightFile, augmentPlanWithInFlight } = await import(
          '../shared/lib/in-flight-touch-sets.ts'
        );
        const inFlight = parseInFlightFile(inFlightPath);
        const candidateTouchSets = new Map<string, readonly string[]>();
        for (const [taskId, cached] of Object.entries(cacheAfterPrune?.touchSets ?? {})) {
          candidateTouchSets.set(
            taskId,
            (cached.entries ?? []).map((entry) => entry.path),
          );
        }
        planToEmit = augmentPlanWithInFlight(queuePlan, inFlight, candidateTouchSets);
      } catch (error) {
        process.stderr.write(
          `plan-queue: ignoring malformed in-flight file ${inFlightPath}: ${(error as Error).message}\n`,
        );
      }
    }
    const emitJson = args.json || !args.preview;
    if (emitJson) process.stdout.write(`${JSON.stringify(planToEmit, null, 2)}\n`);
    if (args.preview) {
      (emitJson ? process.stderr : process.stdout).write(`${renderPreview(planToEmit, records)}\n`);
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
    // HOK-3179: --no-infer runs never write inference reports. Background
    // refresh runs own report writes.
    if (!noInfer && typeof args['inference-report-file'] === 'string' && args['inference-report-file'].length > 0) {
      writeInferenceReport(args['inference-report-file'], buildInferenceReport({
        state: inferenceState,
        inferredEdgeCount: edges.filter((edge) => edge.source === 'inferred').length,
        plan: reportPlan,
        nowMs: Date.now(),
      }));
    }
  },
});
