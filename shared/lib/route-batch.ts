import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getHokusaiRouterConfig } from './config.ts';
import {
  lookupExpandedRouteCache,
  readExpandedPacketContent,
  recordExpandedRouteCache,
  type ExpandedPacketFiles,
} from './expanded-route-cache.ts';
import { getCurrentOperatingMode, type OperatingMode } from './operating-mode.ts';
import { resolveEffectiveModel } from './model-resolution.ts';
import { readQuotaSnapshot } from './quota-state.ts';
import { upgradeRouteModelSuccessors } from './route-model-successors.ts';
import {
  buildRouteProvenance,
  withExpandedRouteMetadata,
  withResolvedRouteBudget,
  withRouteProvenance,
  type RouteInputKind,
  type RouteSource,
} from './route-artifact.ts';
import { appendRouteDecision, buildRouteDecision, recordRouteDecision } from './route-decision.ts';
import { loadStageAwareRouterContext, type StageAwareRouterContext } from './stage-aware-router.ts';
import {
  readTaskPromptFromFile,
  routeWorkflow,
  routeWorkflowAutoWithContext,
  routeWorkflowDegraded,
  routeWorkflowDegradedWithContext,
  routeWorkflowHokusai,
  routeWorkflowStageAwareWithContext,
  withPreEscalationRoute,
  type RouteWorkflowOptions,
  type WorkflowRouteDecision,
} from './workflow-router.ts';

export interface RouteBatchTask {
  issueId?: string;
  prompt: string;
  file?: string;
  source?: RouteSource;
  inputKind?: RouteInputKind;
  modelSelector?: string;
  parentResolvedModel?: string;
  workspaceSelector?: string;
  /**
   * Feature artifact directory. When set, the route decision (HOK-3098) is
   * appended to its routing.jsonl and keyed off its trace context.
   */
  featureDir?: string;
}

type RouteBatchTaskInput = {
  issueId?: string;
  prompt?: string;
  file?: string;
  source?: RouteSource;
  inputKind?: RouteInputKind;
  modelSelector?: string;
  parentResolvedModel?: string;
  workspaceSelector?: string;
  featureDir?: string;
};

export interface RouteBatchPlanTask {
  issue?: string;
  issueId?: string;
  taskPacketFile?: string;
  prompt?: string;
  model?: string;
  parentResolvedModel?: string;
}

export interface RouteBatchOptions extends RouteWorkflowOptions {
  repoDir?: string;
  mode?: 'auto' | 'stage-aware' | 'heuristic' | 'hokusai';
  operatingMode?: OperatingMode;
  source?: RouteSource;
  inputKind?: RouteInputKind;
  parentResolvedModel?: string;
}

export interface RouteBatchResult {
  task: RouteBatchTask;
  decision: WorkflowRouteDecision;
}

export interface ExpandedRouteTask extends ExpandedPacketFiles {
  issueId: string;
  slug?: string;
  featureDir?: string;
  outputFile?: string;
}

export interface ExpandedRouteTaskResult {
  input: ExpandedRouteTask;
  outputFile: string;
  packet_hash?: string;
  cache_hit: boolean;
  route_source?: 'batch' | 'single' | 'cache';
  decision?: WorkflowRouteDecision;
  error?: string;
}

export interface RouteExpandedPacketsOptions extends RouteBatchOptions {
  routeBatchImpl?: (
    tasks: RouteBatchTaskInput[],
    options?: RouteBatchOptions,
  ) => Promise<RouteBatchResult[]>;
}

function resolveWavemillRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function getWavemillAdditionalEvalPaths(repoDir: string): string[] {
  const wavemillRoot = resolveWavemillRoot();
  if (resolve(repoDir) === resolve(wavemillRoot)) {
    return [];
  }

  const additionalEvalsPaths: string[] = [];
  const aggregatedPath = resolve(wavemillRoot, '.wavemill/evals/aggregated-evals.jsonl');
  const backfilledPath = resolve(wavemillRoot, '.wavemill/evals/aggregated-evals.backfilled.jsonl');

  if (existsSync(aggregatedPath)) {
    additionalEvalsPaths.push(aggregatedPath);
  }
  if (existsSync(backfilledPath)) {
    additionalEvalsPaths.push(backfilledPath);
  }

  return additionalEvalsPaths;
}

export function resolveRouteBatchTask(task: RouteBatchTaskInput): RouteBatchTask {
  const featureDir = task.featureDir ? { featureDir: task.featureDir } : {};
  if (task.file) {
    return {
      issueId: task.issueId,
      file: task.file,
      prompt: readTaskPromptFromFile(task.file),
      source: task.source,
      inputKind: task.inputKind,
      modelSelector: task.modelSelector,
      parentResolvedModel: task.parentResolvedModel,
      workspaceSelector: task.workspaceSelector,
      ...featureDir,
    };
  }

  if (typeof task.prompt === 'string') {
    return {
      issueId: task.issueId,
      prompt: task.prompt,
      source: task.source,
      inputKind: task.inputKind,
      modelSelector: task.modelSelector,
      parentResolvedModel: task.parentResolvedModel,
      workspaceSelector: task.workspaceSelector,
      ...featureDir,
    };
  }

  throw new Error(`Task${task.issueId ? ` ${task.issueId}` : ''} is missing both prompt and file`);
}

export function tasksFromPlan(plan: unknown): RouteBatchTask[] {
  const items = Array.isArray(plan)
    ? plan
    : Array.isArray((plan as { tasks?: unknown[] })?.tasks)
      ? (plan as { tasks: unknown[] }).tasks
      : null;

  if (!items) {
    throw new Error('Plan input must be an array or an object with a tasks array');
  }

  return items.map((task, index) => {
    if (!task || typeof task !== 'object') {
      throw new Error(`Plan task at index ${index} is not an object`);
    }

    const planTask = task as RouteBatchPlanTask;
    return resolveRouteBatchTask({
      issueId: planTask.issueId || planTask.issue,
      prompt: planTask.prompt,
      file: planTask.taskPacketFile,
      source: 'expanded',
      inputKind: 'task-packet',
      modelSelector: planTask.model,
      parentResolvedModel: planTask.parentResolvedModel,
      workspaceSelector: planTask.model,
    });
  });
}

function buildRouteBatchWorkflowOptions(options: RouteBatchOptions): RouteBatchOptions {
  const repoDir = options.repoDir || process.cwd();
  return {
    ...options,
    repoDir,
    additionalEvalsPaths: options.additionalEvalsPaths ?? getWavemillAdditionalEvalPaths(repoDir),
  };
}

function shouldLoadStageAwareContext(
  mode: NonNullable<RouteBatchOptions['mode']>,
  repoDir: string,
): boolean {
  if (mode === 'stage-aware') {
    return true;
  }

  if (mode !== 'auto') {
    return false;
  }

  return !Boolean(getHokusaiRouterConfig(repoDir).endpoint);
}

async function routeTaskInBatch(
  prompt: string,
  options: RouteBatchOptions,
  operatingMode: OperatingMode | undefined,
  stageAwareContext: StageAwareRouterContext | undefined,
): Promise<WorkflowRouteDecision> {
  const mode = options.mode || 'auto';

  if (mode === 'heuristic') {
    return routeWorkflow(prompt, options);
  }

  if (mode === 'stage-aware') {
    if (!stageAwareContext) {
      throw new Error('Stage-aware context was not prepared for stage-aware batch routing');
    }
    return routeWorkflowStageAwareWithContext(prompt, options, stageAwareContext);
  }

  if (mode === 'hokusai') {
    return routeWorkflowHokusai(prompt, options);
  }

  if (operatingMode === 'constrained' || operatingMode === 'survival') {
    if (!stageAwareContext) {
      return routeWorkflowDegraded(prompt, options, operatingMode);
    }
    return routeWorkflowDegradedWithContext(prompt, options, operatingMode, stageAwareContext);
  }

  return routeWorkflowAutoWithContext(prompt, options, {
    operatingMode,
    stageAwareContext,
  });
}

/**
 * Mints the route decision for a freshly routed task (HOK-3098). With a
 * feature dir the decision is keyed off the task traceId and appended to
 * routing.jsonl; without one a UUID-keyed record is embedded in the route
 * artifact so the launch path can persist it once the feature dir exists.
 * Best-effort: never throws and never blocks routing.
 */
async function mintRouteDecision(
  decision: WorkflowRouteDecision,
  featureDir: string | undefined,
): Promise<WorkflowRouteDecision> {
  try {
    const record = featureDir
      ? await recordRouteDecision(featureDir, decision)
      : buildRouteDecision(decision);
    return record ? { ...decision, routeDecision: record } : decision;
  } catch {
    return decision;
  }
}

export async function routeBatch(
  tasks: RouteBatchTaskInput[],
  options: RouteBatchOptions = {},
): Promise<RouteBatchResult[]> {
  const resolvedOptions = buildRouteBatchWorkflowOptions(options);
  const repoDir = resolvedOptions.repoDir || process.cwd();
  const mode = resolvedOptions.mode || 'auto';
  const resolvedTasks = tasks.map((task) => resolveRouteBatchTask(task));

  let operatingMode: OperatingMode | undefined;
  if (mode === 'auto') {
    operatingMode = resolvedOptions.operatingMode ?? getCurrentOperatingMode(repoDir);
  }

  const stageAwareContext = shouldLoadStageAwareContext(mode, repoDir)
    ? loadStageAwareRouterContext(resolvedOptions)
    : undefined;

  const results: RouteBatchResult[] = [];
  for (const task of resolvedTasks) {
    const routedDecision = await routeTaskInBatch(task.prompt, resolvedOptions, operatingMode, stageAwareContext);
    // Pin the decided route before workspace selectors override the coder, so
    // `recommended` never reflects a post-routing override.
    let decision = withResolvedRouteBudget(await mintRouteDecision(
      withPreEscalationRoute(routedDecision),
      task.featureDir,
    ), {
      explicitMaxCostUsd: resolvedOptions.maxCostUsd,
      repoDir,
    });
    const requestedModelSelector = task.modelSelector ?? task.workspaceSelector;
    if (requestedModelSelector) {
      const resolvedModel = resolveEffectiveModel({
        workspaceSelector: requestedModelSelector,
        parentResolvedModelId: task.parentResolvedModel ?? resolvedOptions.parentResolvedModel,
        policyContext: {
          taskType: 'coding',
          difficulty: 'moderate',
          quotaState: readQuotaSnapshot(repoDir),
          repoDir,
        },
      });
      decision = {
        ...decision,
        coder: resolvedModel.resolved,
      };
    }
    const source = task.source
      || resolvedOptions.source
      || (mode === 'heuristic' ? 'heuristic-fallback' : task.file ? 'expanded' : 'live');
    const inputKind = task.inputKind
      || resolvedOptions.inputKind
      || (mode === 'heuristic' ? 'heuristic' : task.file ? 'task-packet' : 'issue');

    const provenance = buildRouteProvenance({
      source,
      inputKind,
      inputPath: task.file || '',
      inputBytes: mode === 'heuristic' ? undefined : task.prompt,
      routerMode: operatingMode ?? getCurrentOperatingMode(repoDir),
    });
    results.push({ task, decision: withRouteProvenance(decision, provenance) });
  }

  return results;
}

interface PreparedExpandedRouteTask extends ExpandedRouteTask {
  outputFile: string;
  prompt: string;
  provenancePath: string;
  packet_hash: string;
  key: string;
}

function expandedRouteTaskKey(task: ExpandedRouteTask, index: number): string {
  return task.issueId || task.outputFile || task.featureDir || task.packetFile || `expanded-${index}`;
}

function resolveExpandedRouteOutputFile(task: ExpandedRouteTask): string {
  if (task.outputFile) {
    return task.outputFile;
  }
  if (task.featureDir) {
    return resolve(task.featureDir, '.post-expansion-route.json');
  }
  if (task.packetFile) {
    return resolve(dirname(task.packetFile), '.post-expansion-route.json');
  }
  if (task.headerFile) {
    return resolve(dirname(task.headerFile), '.post-expansion-route.json');
  }
  throw new Error(`Expanded route task ${task.issueId} is missing outputFile and featureDir`);
}

async function routeExpandedTaskSet(
  tasks: PreparedExpandedRouteTask[],
  options: RouteExpandedPacketsOptions,
): Promise<Map<string, WorkflowRouteDecision>> {
  if (tasks.length === 0) {
    return new Map();
  }

  const router = options.routeBatchImpl ?? routeBatch;
  const resolvedOptions = buildRouteBatchWorkflowOptions(options);
  const results = await router(
    tasks.map((task) => ({
      issueId: task.issueId,
      prompt: task.prompt,
      file: task.provenancePath,
      source: 'expanded',
      inputKind: 'task-packet',
      ...(task.featureDir ? { featureDir: task.featureDir } : {}),
    })),
    resolvedOptions,
  );

  const decisions = new Map<string, WorkflowRouteDecision>();
  for (const result of results) {
    const key = tasks.find((task) => task.issueId === result.task.issueId && task.provenancePath === result.task.file)?.key;
    if (key) {
      decisions.set(key, result.decision);
    }
  }
  return decisions;
}

export async function routeExpandedPackets(
  tasks: ExpandedRouteTask[],
  options: RouteExpandedPacketsOptions = {},
): Promise<ExpandedRouteTaskResult[]> {
  const resolvedOptions = buildRouteBatchWorkflowOptions(options);
  const repoDir = resolvedOptions.repoDir || process.cwd();
  const mode = resolvedOptions.mode || 'auto';
  const operatingMode = mode === 'auto'
    ? (resolvedOptions.operatingMode ?? getCurrentOperatingMode(repoDir))
    : (resolvedOptions.operatingMode ?? getCurrentOperatingMode(repoDir));

  const prepared: PreparedExpandedRouteTask[] = tasks.map((task, index) => {
    const content = readExpandedPacketContent(task);
    return {
      ...task,
      prompt: content.prompt,
      provenancePath: content.provenancePath,
      packet_hash: content.hash,
      outputFile: resolveExpandedRouteOutputFile(task),
      key: expandedRouteTaskKey(task, index),
    };
  });

  const results = new Map<string, ExpandedRouteTaskResult>();
  const misses: PreparedExpandedRouteTask[] = [];

  for (const task of prepared) {
    const cached = lookupExpandedRouteCache(repoDir, task.packet_hash, operatingMode);
    if (!cached) {
      misses.push(task);
      continue;
    }

    const cachedDecision = upgradeRouteModelSuccessors(withResolvedRouteBudget(cached.decision, {
      explicitMaxCostUsd: resolvedOptions.maxCostUsd,
      repoDir,
    }), repoDir);
    // A cache hit replays an earlier decision rather than making a new one:
    // carry its record forward (idempotent on decision_id).
    if (task.featureDir && cachedDecision.routeDecision) {
      await appendRouteDecision(task.featureDir, cachedDecision.routeDecision);
    }
    results.set(task.key, {
      input: task,
      outputFile: task.outputFile,
      packet_hash: task.packet_hash,
      cache_hit: true,
      route_source: 'cache',
      decision: withExpandedRouteMetadata(cachedDecision, {
        cache_hit: true,
        route_source: 'cache',
        packet_hash: task.packet_hash,
      }),
    });
  }

  const recordFreshDecision = async (
    task: PreparedExpandedRouteTask,
    decision: WorkflowRouteDecision,
    routeSource: 'batch' | 'single',
  ): Promise<void> => {
    const budgetedDecision = upgradeRouteModelSuccessors(withResolvedRouteBudget(decision, {
      explicitMaxCostUsd: resolvedOptions.maxCostUsd,
      repoDir,
    }), repoDir);
    const decorated = withExpandedRouteMetadata(budgetedDecision, {
      cache_hit: false,
      route_source: routeSource,
      packet_hash: task.packet_hash,
    });
    await recordExpandedRouteCache(repoDir, {
      packet_hash: task.packet_hash,
      decision: decorated,
      operating_mode: operatingMode,
      recorded_at: new Date().toISOString(),
      input_version: '1',
    });
    results.set(task.key, {
      input: task,
      outputFile: task.outputFile,
      packet_hash: task.packet_hash,
      cache_hit: false,
      route_source: routeSource,
      decision: decorated,
    });
  };

  const routeIndividually = async (tasksToRoute: PreparedExpandedRouteTask[]): Promise<void> => {
    for (const task of tasksToRoute) {
      try {
        const singleMap = await routeExpandedTaskSet([task], resolvedOptions);
        const decision = singleMap.get(task.key);
        if (!decision) {
          results.set(task.key, {
            input: task,
            outputFile: task.outputFile,
            packet_hash: task.packet_hash,
            cache_hit: false,
            error: `Routing returned no decision for ${task.issueId}`,
          });
          continue;
        }
        await recordFreshDecision(task, decision, 'single');
      } catch (error) {
        results.set(task.key, {
          input: task,
          outputFile: task.outputFile,
          packet_hash: task.packet_hash,
          cache_hit: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  if (misses.length === 1) {
    await routeIndividually(misses);
  } else if (misses.length > 1) {
    try {
      const batchDecisions = await routeExpandedTaskSet(misses, resolvedOptions);
      const missingFromBatch = misses.filter((task) => !batchDecisions.has(task.key));
      for (const task of misses) {
        const decision = batchDecisions.get(task.key);
        if (!decision) {
          continue;
        }
        await recordFreshDecision(task, decision, 'batch');
      }
      if (missingFromBatch.length > 0) {
        await routeIndividually(missingFromBatch);
      }
    } catch {
      await routeIndividually(misses);
    }
  }

  return prepared.map((task) => results.get(task.key) ?? {
    input: task,
    outputFile: task.outputFile,
    packet_hash: task.packet_hash,
    cache_hit: false,
    error: `Routing returned no result for ${task.issueId}`,
  });
}
