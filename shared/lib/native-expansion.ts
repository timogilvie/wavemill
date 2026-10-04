import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path, { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Message } from './native-agent/messages.ts';
import type { AgentContext, HeartbeatEvent, WavemillLoopConfig } from './native-agent/loop.ts';
import { runWavemillLoop } from './native-agent/loop.ts';
import { TranscriptWriter, parseTranscriptJsonl } from './native-agent/transcript.ts';
import {
  buildNativeProviderResolutionFailureMessage,
  getNativeProviderApiKey,
  resolveNativeAgentProviders,
  type ReadyNativeProviderEntry,
} from './native-agent/providers.ts';
import { createReadOnlyTools, READ_ONLY_PATH_FIELDS } from './native-agent/tools/read-only.ts';
import { createGitTools, gitAfterToolCall } from './native-agent/tools/git.ts';
import { createToolRegistry, type ToolRegistry } from './native-agent/tools/registry.ts';
import { toPiAgentTool } from './native-agent/tools/pi-adapter.ts';
import { fillPromptTemplate } from './prompt-utils.ts';
import { buildScopeConstraintContext, type OperatingMode } from './scope-shrinker.ts';
import { isValidTaskPacket } from './task-packet-utils.ts';
import { logPromptUsage } from './prompt-registry.ts';
import { registerNativeRuntime } from './resource-adapters/native-runtime-adapter.ts';
import { recordUse } from './resource-manifest.ts';
import { nativeAgentTypeForProvider, type ModelRegistry } from './model-registry.ts';
import { getMaxCostUsd, getNativeContextManagementConfig } from './config.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NATIVE_PHASE_PROMPT_PATH = resolve(__dirname, '../../tools/prompts/native-read-only-phase.md');

export interface NativeExpansionOptions {
  promptTemplate: string;
  issueContext: string;
  codebaseContext: string;
  mode: OperatingMode;
  repoDir: string;
  issueId?: string;
  env?: Record<string, string | undefined>;
  registry?: ModelRegistry;
  modelOverride?: WavemillLoopConfig['model'];
  toolRegistryOverride?: ToolRegistry;
}

export interface NativeExpansionMetadata {
  agent: 'native-openai' | 'native-openrouter';
  model: string;
  provider: 'openai' | 'openrouter';
  api: string;
  transcriptPath: string;
  cost: number;
  durationMs: number;
  stopReason: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  deniedToolCalls: ReadonlyArray<{ tool: string; reason: string }>;
}

export interface NativeExpansionResult {
  text: string;
  native: NativeExpansionMetadata;
}

type NativeExpansionUnavailableKind = 'missing_key' | 'uncertified' | 'no_providers';

export class NativeExpansionUnavailableError extends Error {
  readonly kind: NativeExpansionUnavailableKind;

  constructor(kind: NativeExpansionUnavailableKind, message: string) {
    super(message);
    this.name = 'NativeExpansionUnavailableError';
    this.kind = kind;
  }
}

function makeToolRegistry(repoDir: string): ToolRegistry {
  return createToolRegistry([
    ...createReadOnlyTools(repoDir),
    ...createGitTools(repoDir),
  ]);
}

function buildSessionId(options: Pick<NativeExpansionOptions, 'env' | 'issueId'>): string {
  const explicit = options.env?.WAVEMILL_SESSION ?? process.env.WAVEMILL_SESSION;
  if (explicit && explicit.trim()) {
    return explicit.trim();
  }
  return `expansion-${options.issueId ?? 'issue'}-${Date.now()}`;
}

function makeTranscriptPath(repoDir: string, sessionId: string): string {
  return path.join(
    repoDir,
    '.wavemill',
    'runs',
    sessionId,
    'native-sessions',
    `expansion-${sessionId}.jsonl`,
  );
}

function loadNativePhasePrompt(repoDir: string) {
  let content = [
    'You are a read-only native planning agent.',
    'Use only the provided read-only tools.',
    'Do not modify files.',
  ].join('\n');

  try {
    if (existsSync(NATIVE_PHASE_PROMPT_PATH)) {
      content = readFileSync(NATIVE_PHASE_PROMPT_PATH, 'utf-8');
    }
  } catch (error) {
    console.warn(`[native-expansion] Failed to load native phase prompt: ${(error as Error).message}`);
  }

  const promptRef = logPromptUsage(NATIVE_PHASE_PROMPT_PATH, content, { repoDir });
  return { content, promptRef };
}

function registerNativeProvenance(input: {
  repoDir: string;
  sessionId: string;
  promptRef: ReturnType<typeof logPromptUsage>;
  provider: NativeExpansionMetadata['provider'];
  model: string;
  api: string;
  tools: readonly { name: string; class: string }[];
}): void {
  try {
    const refs = registerNativeRuntime({
      phase: 'task-expansion',
      provider: input.provider,
      model: input.model,
      api: input.api,
      tools: input.tools,
      promptRef: input.promptRef ?? undefined,
      repoDir: input.repoDir,
    });
    if (refs.runtime) recordUse(input.sessionId, 'task-expansion', refs.runtime, input.repoDir);
    if (refs.toolSet) recordUse(input.sessionId, 'task-expansion', refs.toolSet, input.repoDir);
  } catch (error) {
    console.warn(`[native-expansion] Failed to register provenance: ${(error as Error).message}`);
  }
}

function resolveReadyProvider(options: NativeExpansionOptions): ReadyNativeProviderEntry {
  const entries = resolveNativeAgentProviders(options.repoDir, {
    env: options.env,
    phase: 'task-expansion',
    registry: options.registry,
  });

  if (entries.length === 0) {
    throw new NativeExpansionUnavailableError(
      'no_providers',
      buildNativeProviderResolutionFailureMessage('task expansion', [])
    );
  }

  const ready = entries.find((entry): entry is ReadyNativeProviderEntry => entry.status === 'ready');
  if (ready) {
    return ready;
  }

  const unavailable = entries.find((entry) => entry.status === 'unavailable');
  if (unavailable) {
    throw new NativeExpansionUnavailableError(
      'missing_key',
      buildNativeProviderResolutionFailureMessage('task expansion', entries)
    );
  }

  const uncertified = entries.find((entry) => entry.status === 'uncertified');
  if (uncertified) {
    throw new NativeExpansionUnavailableError(
      'uncertified',
      buildNativeProviderResolutionFailureMessage('task expansion', entries)
    );
  }

  throw new NativeExpansionUnavailableError(
    'no_providers',
    buildNativeProviderResolutionFailureMessage('task expansion', entries)
  );
}

function extractAssistantText(result: Awaited<ReturnType<typeof runWavemillLoop>>): string {
  for (let index = result.messages.length - 1; index >= 0; index -= 1) {
    const message = result.messages[index];
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      continue;
    }
    const text = message.content
      .filter((content): content is { type: 'text'; text: string } => content.type === 'text')
      .map((content) => content.text)
      .join('');
    if (text.trim()) {
      return text;
    }
  }
  return '';
}

function extractAssistantErrorMessage(result: Awaited<ReturnType<typeof runWavemillLoop>>): string {
  for (let index = result.messages.length - 1; index >= 0; index -= 1) {
    const message = result.messages[index];
    if (message.role !== 'assistant') {
      continue;
    }
    const errorMessage = (message as { errorMessage?: string }).errorMessage?.trim();
    if (errorMessage) {
      return errorMessage;
    }
  }
  return '';
}

function extractDeniedToolCalls(transcriptPath: string): ReadonlyArray<{ tool: string; reason: string }> {
  const events = parseTranscriptJsonl(readFileSync(transcriptPath, 'utf-8'));
  return events
    .filter((event): event is Extract<typeof event, { type: 'tool_result' }> => event.type === 'tool_result')
    .filter((event) => event.isError === true && /^(phase_denied|path_denied):/.test(event.content))
    .map((event) => ({
      tool: event.toolName,
      reason: event.content,
    }));
}

function buildHeartbeatHandler(repoDir: string, env?: Record<string, string | undefined>) {
  const session = env?.WAVEMILL_SESSION ?? process.env.WAVEMILL_SESSION;
  const issue = env?.WAVEMILL_ISSUE ?? process.env.WAVEMILL_ISSUE;
  if (!session || !issue) {
    return undefined;
  }

  return (event: HeartbeatEvent): void => {
    try {
      execFileSync('bash', ['-lc', [
        `source ${JSON.stringify(resolve(__dirname, 'wavemill-common.sh'))}`,
        `if declare -F wavemill_hook_write >/dev/null 2>&1; then`,
        `  wavemill_hook_write ${JSON.stringify(event.state)} ${JSON.stringify(event.event)} ${JSON.stringify(event.detail ?? '')} ${JSON.stringify(event.agent)} || true`,
        'fi',
      ].join('\n')], {
        cwd: repoDir,
        env: {
          ...process.env,
          ...env,
          WAVEMILL_SESSION: session,
          WAVEMILL_ISSUE: issue,
        },
        stdio: 'ignore',
      });
    } catch {
      // Best-effort only.
    }
  };
}

export function getNativeExpansionSidecarPath(outputFile: string): string {
  const parsed = path.parse(outputFile);
  const basePath = path.join(parsed.dir, parsed.name);
  return `${basePath}.native.json`;
}

export async function writeNativeExpansionSidecar(
  outputFile: string,
  metadata: NativeExpansionMetadata,
): Promise<string> {
  const sidecarPath = getNativeExpansionSidecarPath(outputFile);
  await fs.mkdir(path.dirname(sidecarPath), { recursive: true });
  await fs.writeFile(sidecarPath, JSON.stringify(metadata, null, 2) + '\n', 'utf-8');
  return sidecarPath;
}

export async function runNativeExpansion(options: NativeExpansionOptions): Promise<NativeExpansionResult> {
  const provider = resolveReadyProvider(options);
  const registry = options.toolRegistryOverride ?? makeToolRegistry(options.repoDir);
  const allTools = registry.getTools();
  const allMeta = registry.list();
  const phaseTools = registry.getTools({ phase: 'planning' });
  const phaseMeta = registry.list({ phase: 'planning' });
  if (phaseMeta.length === 0) {
    throw new Error('Native task expansion refused: empty read-only tool allow-list for planning phase.');
  }

  const sessionId = buildSessionId(options);
  const transcriptPath = makeTranscriptPath(options.repoDir, sessionId);
  const apiKey = getNativeProviderApiKey(provider);
  const model = options.modelOverride ?? {
    ...provider.model,
    headers: {
      ...(provider.model.headers ?? {}),
      Authorization: `Bearer ${apiKey}`,
    },
  };

  const systemPrompt = fillPromptTemplate(options.promptTemplate, {
    ISSUE_CONTEXT: options.issueContext,
    CODEBASE_CONTEXT: options.codebaseContext,
    DEGRADED_MODE_CONTEXT: buildScopeConstraintContext(options.mode),
  });

  const context: AgentContext = {
    systemPrompt,
    messages: [{
      role: 'user',
      content: 'Generate the task packet exactly as instructed in the system prompt. Output only the markdown.',
      timestamp: 0,
    }],
    tools: allTools.map((tool) => toPiAgentTool(tool)),
  };

  const writer = new TranscriptWriter({
    sessionId,
    model: provider.modelId,
    api: model.api,
    provider: provider.providerName,
    path: transcriptPath,
    worktreePath: options.repoDir,
  });

  const { promptRef } = loadNativePhasePrompt(options.repoDir);
  registerNativeProvenance({
    repoDir: options.repoDir,
    sessionId,
    promptRef,
    provider: provider.providerName,
    model: provider.modelId,
    api: model.api,
    tools: phaseMeta.map((tool) => ({ name: tool.name, class: tool.class })),
  });

  const loopResult = await runWavemillLoop({
    model,
    context,
    contextManagement: getNativeContextManagementConfig(options.repoDir),
    convertToLlm: (messages) => messages as unknown as Message[],
    afterToolCall: gitAfterToolCall,
    promptSizeLog: options.repoDir ? {
      repoDir: options.repoDir,
      stage: 'expansion',
      session: options.session,
      issue: options.issue,
    } : undefined,
    toolPolicy: {
      phase: 'planning',
      worktreePath: options.repoDir,
      registry: allMeta,
      config: {
        pathFieldsByTool: READ_ONLY_PATH_FIELDS,
      },
    },
    onEvent: (event) => writer.handleEvent(event),
    onHeartbeat: buildHeartbeatHandler(options.repoDir, options.env),
    budget: {
      maxTurns: 8,
      maxToolCalls: 20,
      maxWallClockMs: 600_000,
      maxCostUsd: getMaxCostUsd(options.repoDir) ?? 5,
    },
    compatRegistry: options.registry,
  });

  if (loopResult.stopReason === 'error') {
    const providerError = extractAssistantErrorMessage(loopResult);
    throw new Error(providerError
      ? `Native task expansion failed: ${providerError}`
      : 'Native task expansion failed: loop exited with stopReason=error.');
  }

  const text = extractAssistantText(loopResult);
  if (!text.trim()) {
    throw new Error('Native task expansion produced no text.');
  }
  if (!isValidTaskPacket(text)) {
    throw new Error('Native task expansion produced invalid task-packet markdown.');
  }

  const deniedToolCalls = extractDeniedToolCalls(transcriptPath);

  return {
    text,
    native: {
      agent: nativeAgentTypeForProvider(provider.providerName),
      model: provider.modelId,
      provider: provider.providerName,
      api: model.api,
      transcriptPath,
      cost: loopResult.totalCostUsd,
      durationMs: loopResult.wallClockMs,
      stopReason: loopResult.stopReason,
      totalInputTokens: loopResult.totalInputTokens,
      totalOutputTokens: loopResult.totalOutputTokens,
      deniedToolCalls,
    },
  };
}
