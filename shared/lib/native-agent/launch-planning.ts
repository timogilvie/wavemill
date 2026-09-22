import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import type { AgentMessage, AgentTurn, Message } from './messages.ts';
import type { AgentContext, WavemillLoopConfig } from './loop.ts';
import { runWavemillLoop } from './loop.ts';
import { classifyProviderError } from './provider-error-classifier.ts';
import { DEFAULT_MAX_OUTPUT_TOKENS } from './output-limits.ts';
import {
  assertOpenRouterBalanceSufficient,
  capOpenRouterMaxTokensForBalance,
} from './openrouter-credits-guard.ts';
import {
  buildNativeProviderResolutionFailureMessage,
  getNativeProviderApiKey,
  resolveNativeAgentProviders,
  type ReadyNativeProviderEntry,
} from './providers.ts';
import { TranscriptWriter } from './transcript.ts';
import { SessionStreamWriter, resolveSessionEventStreamPath } from './session-stream.ts';
import type { SessionStreamConfig } from './loop.ts';
import { createReadOnlyTools, READ_ONLY_PATH_FIELDS } from './tools/read-only.ts';
import { createGitTools, gitAfterToolCall } from './tools/git.ts';
import { createArtifactTools } from './tools/artifacts.ts';
import { createToolRegistry } from './tools/registry.ts';
import type { AgentTool } from './tools/pi-adapter.ts';
import type { ToolDescriptor, ToolMetadata, WavemillToolResult } from './tools/types.ts';
import {
  createLaunchMenuProvider,
  formatMenuDenials,
} from './tools/menu-resolver.ts';
import { inferCertificationSnapshotForPhase } from './tools/certification-snapshot.ts';
import { loadWavemillConfig } from '../config.ts';
import { loadNativePhasePrompt, registerAndRecordNativeProvenance } from './prompts.ts';
import { isTaskPacketContent } from '../task-packet-utils.ts';
import { createCleanupTracker, runCleanup, type CleanupReason } from './cleanup.ts';
import { updateStageResult } from '../stage-result.ts';
import {
  equivalentOpenRouterModelIds,
  type NormalizedPricing,
} from '../openrouter-catalog.ts';
import { getNativeAgentConfig, getNativeContextManagementConfig } from '../config.ts';
import {
  resolveNativePlanningLimits,
  toLoopBudget,
  validateFinalPlanningArtifact,
  type PlanningFailureReason,
} from './planning-guards.ts';
import { computeModelCost, loadPricingTable } from '../workflow-cost.ts';

const DEFAULT_HELPER_TIMEOUT_MS = 12 * 60 * 1000;
const HELPER_STDERR_TAIL_CHARS = 2000;

type HookState = 'working' | 'idle' | 'error';

interface PlanningOutcomeArtifacts {
  bounds: {
    maxTurns: number;
    maxToolCalls: number;
    maxWallClockMs: number;
  };
  usage: {
    turnsCompleted: number;
    toolCallsExecuted: number;
    wallClockMs: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCostUsd?: number;
  };
  promptRef: {
    id: string;
    version: string;
  };
}

export interface LaunchNativePlanningOptions {
  session: string;
  issue: string;
  slug: string;
  wtDir: string;
  repoDir: string;
  phase?: 'planning' | 'coding' | 'review';
  planDepth?: string;
  operatingMode?: string;
  branch?: string;
  baseBranch?: string;
  title?: string;
  issueContext?: string;
  linearIssue?: string;
  resolvedModel?: string;
  taskPacketPath?: string;
  routeOutputPath?: string;
  planPath?: string;
  approvalMarkerPath?: string;
  migrationMarkerPath?: string;
  hookPath?: string;
  providerEntries?: readonly ReadyNativeProviderEntry[];
  loopModelOverride?: WavemillLoopConfig['model'];
  registryMetadataOverride?: readonly ToolMetadata[];
  extraDescriptors?: readonly ToolDescriptor[];
  runTsxCommand?: (args: string[]) => string;
  onAwaitingUserStagePublished?: () => void | Promise<void>;
  signal?: AbortSignal;
}

function writeHookStatus(
  hookPath: string,
  state: HookState,
  event: string,
  detail: string,
  agent: string,
): void {
  const tmpPath = `${hookPath}.tmp.${process.pid}.${Date.now()}`;
  let base: Record<string, unknown> = {};
  if (existsSync(hookPath)) {
    try {
      base = JSON.parse(readFileSync(hookPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      base = {};
    }
  }
  const payload = {
    ...base,
    state,
    event,
    agent,
    timestamp: Math.floor(Date.now() / 1000),
    ...(detail !== '' ? { detail } : {}),
  };
  mkdirSync(dirname(hookPath), { recursive: true });
  writeFileSync(tmpPath, `${JSON.stringify(payload)}\n`, 'utf-8');
  renameSync(tmpPath, hookPath);
}

function writeTextStatus(session: string, issue: string, text: string): void {
  if (!session || !issue) {
    return;
  }
  const statusPath = `/tmp/${session}-${issue}-status.txt`;
  try {
    writeFileSync(statusPath, `${text}\n`, 'utf-8');
  } catch {
    // The hook JSON is the source of truth; this plain text file is best-effort.
  }
}

function helperTimeoutMs(): number {
  const raw = process.env.WAVEMILL_NATIVE_PLANNING_HELPER_TIMEOUT_MS;
  if (!raw) {
    return DEFAULT_HELPER_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HELPER_TIMEOUT_MS;
}

function formatTsxCommand(args: string[]): string {
  return `npx tsx ${args.map((arg) => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(' ')}`;
}

export function describeNativePlanningHelperFailure(error: unknown, args: string[], timeoutMs: number): Error {
  const err = error as Error & {
    code?: string;
    signal?: NodeJS.Signals;
    killed?: boolean;
    status?: number | null;
    stderr?: Buffer | string | null;
  };
  const command = formatTsxCommand(args);
  const message = err instanceof Error ? err.message : String(error);
  const timedOut = err.code === 'ETIMEDOUT'
    || err.signal === 'SIGTERM'
    || err.killed === true
    || /ETIMEDOUT|timed out/i.test(message);

  if (timedOut) {
    return new Error(`Native planning helper timed out after ${timeoutMs}ms: ${command}`);
  }

  const stderr = typeof err.stderr === 'string'
    ? err.stderr
    : Buffer.isBuffer(err.stderr)
      ? err.stderr.toString('utf-8')
      : '';
  const stderrTail = stderr.trim().slice(-HELPER_STDERR_TAIL_CHARS);
  const status = typeof err.status === 'number' ? `exit ${err.status}` : 'failed';
  const detail = stderrTail ? `: ${stderrTail}` : message ? `: ${message}` : '';
  return new Error(`Native planning helper ${status}: ${command}${detail}`);
}

function execTsx(repoDir: string, args: string[]): string {
  const timeoutMs = helperTimeoutMs();
  try {
    return execFileSync('npx', ['tsx', ...args], {
      cwd: repoDir,
      encoding: 'utf-8',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
    });
  } catch (error) {
    throw describeNativePlanningHelperFailure(error, args, timeoutMs);
  }
}

function ensureTaskPacket(
  repoDir: string,
  issue: string,
  linearIssue: string | undefined,
  taskPacketPath: string,
  runTsxCommand: (args: string[]) => string,
): void {
  const existing = existsSync(taskPacketPath) ? readFileSync(taskPacketPath, 'utf-8') : '';
  if (existing.trim() !== '' && isTaskPacketContent(existing)) {
    return;
  }
  if (materializeTaskPacketFromSelectedTask(taskPacketPath)) {
    return;
  }

  const expandIssue = normalizeLinearIssueIdentifier(linearIssue) ?? normalizeLinearIssueIdentifier(issue);
  if (!expandIssue) {
    throw new Error(`Cannot expand task packet for invalid Linear issue identifier: ${issue}`);
  }

  runTsxCommand([
    'tools/expand-issue.ts',
    expandIssue,
    '--output',
    taskPacketPath,
    '--repo-path',
    repoDir,
  ]);
}

function materializeTaskPacketFromSelectedTask(taskPacketPath: string): boolean {
  const selectedTaskPath = join(dirname(taskPacketPath), 'selected-task.json');
  if (!existsSync(selectedTaskPath)) {
    return false;
  }

  let data: unknown;
  try {
    data = JSON.parse(readFileSync(selectedTaskPath, 'utf-8')) as unknown;
  } catch {
    return false;
  }

  if (!data || typeof data !== 'object') {
    return false;
  }

  const record = data as Record<string, unknown>;
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const description = typeof record.description === 'string' ? record.description.trim() : '';
  const content = [title, description].filter((part) => part.length > 0).join('\n\n').trim();
  if (content === '' || !isTaskPacketContent(content)) {
    return false;
  }

  atomicWriteText(taskPacketPath, content);
  return true;
}

function normalizeLinearIssueIdentifier(issue: string | undefined): string | null {
  const trimmed = issue?.trim();
  if (!trimmed) {
    return null;
  }
  const direct = trimmed.match(/^[A-Z][A-Z0-9]*-[0-9]+$/);
  if (direct) {
    return trimmed;
  }
  const challenger = trimmed.match(/^([A-Z][A-Z0-9]*-[0-9]+)_c$/);
  if (challenger?.[1]) {
    return challenger[1];
  }
  const url = trimmed.match(/^https?:\/\/linear\.app\/[^/]+\/issue\/([A-Z][A-Z0-9]*-[0-9]+)(?:[/?#].*)?$/);
  return url?.[1] ?? null;
}

function routeTaskPacket(
  taskPacketPath: string,
  routeOutputPath: string,
  repoDir: string,
  runTsxCommand: (args: string[]) => string,
): void {
  runTsxCommand([
    'tools/route-task.ts',
    '--json',
    '--file',
    taskPacketPath,
    '--output',
    routeOutputPath,
    '--repo-dir',
    repoDir,
    '--source',
    'expanded',
    '--input-kind',
    'task-packet',
  ]);
}

function maybeWriteMigrationMarker(taskPacketPath: string, migrationMarkerPath: string): void {
  const packet = readFileSync(taskPacketPath, 'utf-8');
  if (/\b(alembic|migration|schema)\b/i.test(packet)) {
    writeFileSync(migrationMarkerPath, '', 'utf-8');
  } else if (existsSync(migrationMarkerPath)) {
    rmSync(migrationMarkerPath, { force: true });
  }
}

function buildUserPrompt(options: {
  slug: string;
  title?: string;
  issue: string;
  planDepth: string;
  operatingMode: string;
  branch?: string;
  baseBranch?: string;
  issueContext?: string;
  taskPacket: string;
}): string {
  return [
    `Issue: ${options.issue}`,
    `Slug: ${options.slug}`,
    `Title: ${options.title || options.issue}`,
    `Plan depth: ${options.planDepth}`,
    `Operating mode: ${options.operatingMode}`,
    `Branch: ${options.branch || ''}`,
    `Base branch: ${options.baseBranch || ''}`,
    '',
    'Produce the planning artifact as final markdown only.',
    'The final response will be written directly to features/<slug>/plan.md.',
    'Include a "## Release Readiness" section.',
    'Use read-only tools only.',
    '',
    options.issueContext ? `Issue Context:\n${options.issueContext.trim()}\n` : '',
    'Task Packet:',
    options.taskPacket.trim(),
  ].filter(Boolean).join('\n');
}

function findFinalAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if ((message as { role?: string }).role !== 'assistant') {
      continue;
    }
    const content = ((message as AgentTurn).content ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('')
      .trim();
    if (content !== '') {
      return content;
    }
  }
  return '';
}

function findFinalAssistantErrorMessage(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if ((message as { role?: string }).role !== 'assistant') {
      continue;
    }
    const errorMessage = (message as AgentTurn).errorMessage?.trim();
    if (errorMessage) {
      return errorMessage;
    }
  }
  return '';
}

function providerErrorPrefix(result: { providerError?: { kind: string } }, errorMessage: string): string {
  return result.providerError?.kind ?? classifyProviderError(errorMessage).kind;
}

function atomicWriteText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, content.endsWith('\n') ? content : `${content}\n`, 'utf-8');
  renameSync(tmpPath, path);
}

function clearApprovalMarkerCreatedDuringPlanning(approvalMarkerPath: string): void {
  rmSync(approvalMarkerPath, { force: true });
}

function clearRejectedPlanningArtifacts(planPath: string, approvalMarkerPath: string): void {
  rmSync(planPath, { force: true });
  rmSync(approvalMarkerPath, { force: true });
}

function defaultHookPath(session: string, issue: string): string {
  return `/tmp/wavemill-${session}-${issue}.hook`;
}

function canonicalNativeModelIds(modelId: string | undefined): Set<string> {
  const trimmed = modelId?.trim();
  if (!trimmed) {
    return new Set();
  }

  return new Set(equivalentOpenRouterModelIds(trimmed));
}

function selectReadyProvider(
  providerEntries: readonly ReadyNativeProviderEntry[],
  resolvedModel: string | undefined,
): ReadyNativeProviderEntry | undefined {
  const requestedIds = canonicalNativeModelIds(resolvedModel);
  if (requestedIds.size === 0) {
    return providerEntries[0];
  }

  return providerEntries.find((entry) => {
    const entryIds = canonicalNativeModelIds(entry.modelId);
    if (entry.model.name) {
      for (const id of canonicalNativeModelIds(entry.model.name)) {
        entryIds.add(id);
      }
    }
    return [...requestedIds].some((id) => entryIds.has(id));
  });
}

function formatReadyProviderList(providerEntries: readonly ReadyNativeProviderEntry[]): string {
  if (providerEntries.length === 0) {
    return 'none';
  }
  return providerEntries
    .map((entry) => `${entry.providerName}:${entry.modelId}`)
    .join(', ');
}

function normalizedPricingFromModel(model: WavemillLoopConfig['model']): NormalizedPricing {
  const cost = (model as { cost?: { input?: unknown; output?: unknown } }).cost;
  const inputPerMTok = typeof cost?.input === 'number' && Number.isFinite(cost.input) && cost.input > 0
    ? cost.input
    : null;
  const outputPerMTok = typeof cost?.output === 'number' && Number.isFinite(cost.output) && cost.output > 0
    ? cost.output
    : null;
  return { inputPerMTok, outputPerMTok };
}

function cleanupReasonForStopReason(stopReason: string): CleanupReason | null {
  if (stopReason === 'aborted') {
    return 'aborted';
  }
  if (stopReason === 'wall_clock_limit') {
    return 'timeout';
  }
  return null;
}

function planningFailureReasonForStopReason(stopReason: string): PlanningFailureReason | null {
  switch (stopReason) {
    case 'turn_limit':
    case 'tool_call_limit':
    case 'wall_clock_limit':
    case 'tool_stagnation':
    case 'aborted':
    case 'error':
      return stopReason;
    default:
      return null;
  }
}

function buildPlanningOutcomeArtifacts(input: {
  repoDir: string;
  modelId: string;
  planningLimits: ReturnType<typeof resolveNativePlanningLimits>;
  result: {
    turnsCompleted: number;
    toolCallsExecuted: number;
    wallClockMs: number;
    totalInputTokens: number;
    totalOutputTokens: number;
  };
  promptRef: { id: string; version: string };
}): PlanningOutcomeArtifacts {
  let totalCostUsd: number | undefined;
  try {
    const pricing = loadPricingTable(input.repoDir)[input.modelId];
    if (pricing) {
      totalCostUsd = computeModelCost({
        inputTokens: input.result.totalInputTokens,
        outputTokens: input.result.totalOutputTokens,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      }, pricing);
    }
  } catch {
    totalCostUsd = undefined;
  }

  return {
    bounds: {
      maxTurns: input.planningLimits.maxTurns,
      maxToolCalls: input.planningLimits.maxToolCalls,
      maxWallClockMs: input.planningLimits.maxWallClockMs,
    },
    usage: {
      turnsCompleted: input.result.turnsCompleted,
      toolCallsExecuted: input.result.toolCallsExecuted,
      wallClockMs: input.result.wallClockMs,
      totalInputTokens: input.result.totalInputTokens,
      totalOutputTokens: input.result.totalOutputTokens,
      ...(typeof totalCostUsd === 'number' && Number.isFinite(totalCostUsd) ? { totalCostUsd } : {}),
    },
    promptRef: {
      id: input.promptRef.id,
      version: input.promptRef.version,
    },
  };
}

function makeTranscriptPath(repoDir: string, session: string, issue: string): string {
  const safeIssue = issue.replace(/[^A-Za-z0-9._-]+/g, '-');
  const baseDir = process.env.WAVEMILL_RUN_DIR
    ? join(process.env.WAVEMILL_RUN_DIR, 'native-sessions')
    : join(repoDir, '.wavemill', 'runs', session, 'native-sessions');
  mkdirSync(baseDir, { recursive: true });
  return join(baseDir, `planning-${safeIssue}.jsonl`);
}

export async function launchNativePlanning(options: LaunchNativePlanningOptions): Promise<{
  planPath: string;
  approvalMarkerPath: string;
  hookPath: string;
  provider: string;
  model: string;
  stopReason: string;
  transcriptPath: string;
}> {
  const phase = options.phase ?? 'planning';
  assert.equal(phase, 'planning', 'launchNativePlanning only supports the planning phase');

  const featureDir = join(options.wtDir, 'features', options.slug);
  const taskPacketPath = options.taskPacketPath ?? join(featureDir, 'task-packet.md');
  const routeOutputPath = options.routeOutputPath ?? join(featureDir, '.post-expansion-route.json');
  const planPath = options.planPath ?? join(featureDir, 'plan.md');
  const approvalMarkerPath = options.approvalMarkerPath ?? join(featureDir, '.plan-approved');
  const migrationMarkerPath = options.migrationMarkerPath ?? join(featureDir, '.migration-detected');
  const hookPath = options.hookPath ?? defaultHookPath(options.session, options.issue);
  const planDepth = options.planDepth ?? 'light';
  const operatingMode = options.operatingMode ?? 'normal';
  const runTsxCommand = options.runTsxCommand ?? ((args: string[]) => execTsx(options.repoDir, args));

  writeHookStatus(hookPath, 'working', 'launch_native_planning', options.loopModelOverride?.name ?? 'native', 'native');

  try {
    mkdirSync(featureDir, { recursive: true });
    writeHookStatus(hookPath, 'working', 'prepare_task_packet', taskPacketPath, 'native');
    ensureTaskPacket(options.repoDir, options.issue, options.linearIssue, taskPacketPath, runTsxCommand);
    writeHookStatus(hookPath, 'working', 'route_task_packet', routeOutputPath, 'native');
    routeTaskPacket(taskPacketPath, routeOutputPath, options.repoDir, runTsxCommand);
    maybeWriteMigrationMarker(taskPacketPath, migrationMarkerPath);

    const descriptors = [
      ...createReadOnlyTools(options.wtDir),
      ...createGitTools(options.wtDir),
      ...createArtifactTools(options.wtDir),
      ...(options.extraDescriptors ?? []),
    ];
    const registry = createToolRegistry(descriptors);
    const registryMetadata = options.registryMetadataOverride ?? registry.list();

    const providerEntries = options.providerEntries
      ?? resolveNativeAgentProviders(options.repoDir, { phase: 'planning' });
    const readyProviders = providerEntries.filter(
      (entry): entry is ReadyNativeProviderEntry => entry.status === 'ready',
    );
    const readyProvider = selectReadyProvider(readyProviders, options.resolvedModel);

    if (options.resolvedModel?.trim() && readyProviders.length > 0 && !readyProvider && !options.loopModelOverride) {
      throw new Error(
        `Native planning requested model "${options.resolvedModel.trim()}", but no ready native provider matched it. `
        + `Ready providers: ${formatReadyProviderList(readyProviders)}. `
        + 'Run wavemill native-agent models report --json to inspect current artifact eligibility.',
      );
    }

    if (!readyProvider && !options.loopModelOverride) {
      throw new Error(buildNativeProviderResolutionFailureMessage('planning', providerEntries));
    }

    const taskPacket = readFileSync(taskPacketPath, 'utf-8');
    const { content: systemPrompt, promptRef } = loadNativePhasePrompt(options.repoDir, {
      // Only phase-allowed tools are callable; the policy layer denies the rest.
      tools: registryMetadata.filter((meta) => meta.allowedPhases.includes('planning')),
      phase: 'planning',
    });
    const apiKey = readyProvider ? getNativeProviderApiKey(readyProvider) : undefined;
    const model = options.loopModelOverride ?? {
      ...readyProvider!.model,
      headers: {
        ...(readyProvider!.model.headers ?? {}),
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
    };
    const modelName = model.name ?? model.id;
    const requestedModelName = options.resolvedModel?.trim() || modelName;
    const transcriptPath = makeTranscriptPath(options.repoDir, options.session, options.issue);
    const transcriptWriter = new TranscriptWriter({
      sessionId: `${options.session}-planning-${options.issue}`,
      model: modelName,
      api: model.api,
      provider: model.provider,
      worktreePath: options.wtDir,
      gitBranch: options.branch,
      path: transcriptPath,
    });

    // Construct session stream configuration
    const planningNativeSessionId = `${options.session}-planning-${options.issue}`;
    const eventStreamPath = resolveSessionEventStreamPath(planningNativeSessionId, options.repoDir);
    const sessionStreamConfig: SessionStreamConfig = {
      sessionId: planningNativeSessionId,
      traceId: options.session,
      phase: 'planning',
      eventStreamPath,
      repoDir: options.repoDir,
      initialConfigDigest: `model:${model.provider}:${modelName}`,
    };

    registerAndRecordNativeProvenance({
      sessionId: options.session,
      phase: 'planning',
      provider: model.provider,
      model: modelName,
      api: model.api,
      tools: registryMetadata.map((meta) => ({ name: meta.name, class: meta.class })),
      promptRef,
      repoDir: options.repoDir,
    });

    writeHookStatus(hookPath, 'working', 'run_native_model', modelName, 'native');

    const cleanupTracker = createCleanupTracker();
    const planningLimits = resolveNativePlanningLimits(getNativeAgentConfig(options.repoDir).planning);
    const menuLaunchProvider = createLaunchMenuProvider({
      phase: 'planning',
      config: loadWavemillConfig(options.repoDir),
      certification: inferCertificationSnapshotForPhase({
        phase: 'planning',
        readyProviderPresent: Boolean(readyProvider),
        loopModelOverridePresent: Boolean(options.loopModelOverride),
      }),
      descriptors,
    });
    if (menuLaunchProvider.initialMenu.denials.length > 0) {
      const formatted = formatMenuDenials(menuLaunchProvider.initialMenu.denials);
      if (formatted) {
        console.warn(`[native-planning] menu denials:\n${formatted}`);
      }
    }
    const context: AgentContext = {
      systemPrompt,
      messages: [{
        role: 'user',
        content: buildUserPrompt({
          slug: options.slug,
          title: options.title,
          issue: options.issue,
          planDepth,
          operatingMode,
          branch: options.branch,
          baseBranch: options.baseBranch,
          issueContext: options.issueContext,
          taskPacket,
        }),
        timestamp: 0,
      }],
      tools: menuLaunchProvider.providerToolsForContext as AgentTool<unknown, unknown>[],
    };
    const pricing = normalizedPricingFromModel(model);
    const effectiveMaxTokens = model.provider === 'openrouter' && !options.loopModelOverride
      ? capOpenRouterMaxTokensForBalance({
        requestedMaxTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        pricing,
        repoDir: options.repoDir,
      }) ?? DEFAULT_MAX_OUTPUT_TOKENS
      : DEFAULT_MAX_OUTPUT_TOKENS;
    if (model.provider === 'openrouter' && !options.loopModelOverride) {
      assertOpenRouterBalanceSufficient({
        repoDir: options.repoDir,
        model: modelName,
        pricing,
        reservedOutputTokens: effectiveMaxTokens,
      });
    }

    const result = await runWavemillLoop({
      model,
      context,
      maxTokens: effectiveMaxTokens,
      contextManagement: getNativeContextManagementConfig(options.repoDir),
      convertToLlm: (messages) => messages as unknown as Message[],
      afterToolCall: gitAfterToolCall,
      signal: options.signal,
      promptSizeLog: options.repoDir ? {
        repoDir: options.repoDir,
        stage: 'planning',
        session: options.session,
        issue: options.issue,
      } : undefined,
      toolPolicy: {
        phase: 'planning',
        worktreePath: options.wtDir,
        registry: registryMetadata,
        config: {
          pathFieldsByTool: READ_ONLY_PATH_FIELDS,
        },
      },
      onEvent: (event) => {
        transcriptWriter.handleEvent(event);
      },
      sessionStreamConfig,
      menuProvider: menuLaunchProvider.menuProvider,
      budget: toLoopBudget(planningLimits),
    });
    const planningOutcomeArtifacts = buildPlanningOutcomeArtifacts({
      repoDir: options.repoDir,
      modelId: modelName,
      planningLimits,
      result,
      promptRef,
    });

    const cleanupReason = cleanupReasonForStopReason(result.stopReason);
    let cleanupPatch: Record<string, unknown> = {};
    if (cleanupReason) {
      const cleanupReport = await runCleanup(cleanupTracker, {
        worktreePath: options.wtDir,
        reason: cleanupReason,
      });
      cleanupPatch = {
        finalTreeState: cleanupReport.finalTreeState,
        cleanupDecision: cleanupReport.cleanupDecision,
        cleanupReport,
      };
    }

    const stopFailureReason = planningFailureReasonForStopReason(result.stopReason);
    if (stopFailureReason) {
      const providerError = result.stopReason === 'error'
        ? findFinalAssistantErrorMessage(result.messages)
        : '';
      const providerFailureReason = providerError
        ? `${providerErrorPrefix(result, providerError)}: ${providerError}`
        : '';
      clearRejectedPlanningArtifacts(planPath, approvalMarkerPath);
      await updateStageResult(featureDir, 'planning', {
        status: stopFailureReason === 'aborted' ? 'aborted' : 'failed',
        finishedAt: new Date().toISOString(),
        agent: 'native',
        model: modelName,
        intendedModel: requestedModelName,
        executedModel: null,
        executionEvidence: {
          status: 'contradicted',
          source: 'native-runtime',
          detail: providerFailureReason || stopFailureReason,
          recordedAt: new Date().toISOString(),
        },
        modelAttributionEligible: false,
        modelAttributionIneligibleReason: 'execution_contradicted',
        notes: `Native planning rejected before approval: ${stopFailureReason}.`,
        artifacts: {
          type: 'planning',
          taskPacketFile: relative(options.wtDir, taskPacketPath),
          transcriptFile: transcriptPath,
          ...planningOutcomeArtifacts,
          planArtifactValid: false,
          approvalReady: false,
        },
        failureReason: providerFailureReason || stopFailureReason,
        ...cleanupPatch,
      });
      throw new Error(providerFailureReason
        ? `Native planning failed: ${providerFailureReason}`
        : `Native planning rejected before approval: ${stopFailureReason}`);
    }

    const rawFinalText = findFinalAssistantText(result.messages);
    if (rawFinalText.trim() === '') {
      const providerError = findFinalAssistantErrorMessage(result.messages);
      clearRejectedPlanningArtifacts(planPath, approvalMarkerPath);
      await updateStageResult(featureDir, 'planning', {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        agent: 'native',
        model: modelName,
        intendedModel: requestedModelName,
        executedModel: null,
        executionEvidence: {
          status: 'contradicted',
          source: 'native-runtime',
          detail: providerError || 'empty_final_plan',
          recordedAt: new Date().toISOString(),
        },
        modelAttributionEligible: false,
        modelAttributionIneligibleReason: 'execution_contradicted',
        notes: providerError
          ? `Native planning failed: ${providerError}`
          : `Native planning completed without a final plan (stopReason=${result.stopReason})`,
        artifacts: {
          type: 'planning',
          taskPacketFile: relative(options.wtDir, taskPacketPath),
          transcriptFile: transcriptPath,
          ...planningOutcomeArtifacts,
          planArtifactValid: false,
          approvalReady: false,
        },
        failureReason: providerError ? 'error' : 'empty_final_plan',
      });
      throw new Error(providerError
        ? `Native planning failed: ${providerErrorPrefix(result, providerError)}: ${providerError}`
        : `Native planning completed without a final plan (stopReason=${result.stopReason})`);
    }
    const validation = validateFinalPlanningArtifact(rawFinalText);
    if (!validation.valid) {
      clearRejectedPlanningArtifacts(planPath, approvalMarkerPath);
      await updateStageResult(featureDir, 'planning', {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        agent: 'native',
        model: modelName,
        intendedModel: requestedModelName,
        executedModel: null,
        executionEvidence: {
          status: 'contradicted',
          source: 'native-runtime',
          detail: validation.reason ?? 'invalid',
          recordedAt: new Date().toISOString(),
        },
        modelAttributionEligible: false,
        modelAttributionIneligibleReason: 'execution_contradicted',
        notes: `Native planning final artifact rejected: ${validation.reason ?? 'invalid'}.`,
        artifacts: {
          type: 'planning',
          taskPacketFile: relative(options.wtDir, taskPacketPath),
          transcriptFile: transcriptPath,
          validationError: validation.reason ?? 'invalid',
          ...planningOutcomeArtifacts,
          planArtifactValid: false,
          approvalReady: false,
        },
        failureReason: 'invalid_final_plan',
      });
      throw new Error(`Native planning final artifact rejected: ${validation.reason ?? 'invalid'}`);
    }
    const finalText = rawFinalText;

    clearApprovalMarkerCreatedDuringPlanning(approvalMarkerPath);
    atomicWriteText(planPath, finalText);
    await updateStageResult(featureDir, 'planning', {
      status: 'awaiting_user',
      finishedAt: null,
      agent: 'native',
      model: modelName,
      intendedModel: requestedModelName,
      executedModel: modelName,
      executionEvidence: {
        status: 'direct',
        source: 'native-runtime',
        recordedAt: new Date().toISOString(),
      },
      modelAttributionEligible: false,
      modelAttributionIneligibleReason: 'stage_not_completed',
      notes: 'Native planning ready for approval',
      artifacts: {
        type: 'planning',
        planFile: relative(options.wtDir, planPath),
        taskPacketFile: relative(options.wtDir, taskPacketPath),
        ...planningOutcomeArtifacts,
        planArtifactValid: true,
        approvalReady: true,
      },
      failureReason: null,
    });
    await options.onAwaitingUserStagePublished?.();
    writeHookStatus(hookPath, 'idle', 'process_exit', 'planning_awaiting_user', 'native');
    writeTextStatus(options.session, options.issue, 'awaiting plan approval');

    return {
      planPath,
      approvalMarkerPath,
      hookPath,
      provider: model.provider,
      model: modelName,
      stopReason: result.stopReason,
      transcriptPath,
    };
  } catch (err) {
    writeHookStatus(hookPath, 'error', 'process_exit', (err as Error).message, 'native');
    writeTextStatus(options.session, options.issue, 'planning error');
    throw err;
  }
}
