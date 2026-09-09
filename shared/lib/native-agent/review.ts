import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentMessage, Message } from './messages.ts';
import type { AgentContext, LoopStopReason, WavemillLoopConfig } from './loop.ts';
import { runWavemillLoop } from './loop.ts';
import {
  ContextExhaustedError,
  ContextWindowExceededError,
  ContextWindowUnverifiableError,
} from './context-window-guard.ts';
import { REVIEW_MAX_OUTPUT_TOKENS } from './output-limits.ts';
import { classifyProviderError, type ProviderErrorKind } from './provider-error-classifier.ts';
import {
  assertOpenRouterBalanceSufficient,
  capOpenRouterMaxTokensForBalance,
} from './openrouter-credits-guard.ts';
import { TranscriptWriter, type TranscriptEvent, type TranscriptToolResult } from './transcript.ts';
import {
  buildNativeProviderResolutionFailureMessage,
  getNativeProviderApiKey,
  resolveNativeAgentProviders,
  type ReadyNativeProviderEntry,
} from './providers.ts';
import { createReadOnlyTools, READ_ONLY_PATH_FIELDS } from './tools/read-only.ts';
import { createGitTools, gitAfterToolCall, gitToolPolicyConfig } from './tools/git.ts';
import { createToolRegistry } from './tools/registry.ts';
import { toPiAgentTool } from './tools/pi-adapter.ts';
import type { ToolDescriptor } from './tools/types.ts';
import { renderNativePhasePrompt, type NativePhasePromptOptions } from './prompts.ts';
import type { ReviewContext } from '../review-context-gatherer.ts';
import { logPromptUsage } from '../prompt-registry.ts';
import { recordUse } from '../resource-manifest.ts';
import { registerNativeRuntime } from '../resource-adapters/native-runtime-adapter.ts';
import type { ReviewEngineOptions, ReviewFinding, ReviewResult } from '../review-engine.ts';
import {
  fillReviewPromptTemplate,
  parseNativeReviewResponse,
} from '../review-engine.ts';
import { loadPromptResourceSync } from '../resource-retrieval.ts';
import { createCleanupTracker, runCleanup, type CleanupReason } from './cleanup.ts';
import {
  NATIVE_CONTEXT_WINDOW_EXCEEDED_CATEGORY,
  PROVIDER_CREDIT_EXHAUSTED_CATEGORY,
  updateStageResult,
} from '../stage-result.ts';
import { getNativeContextManagementConfig } from '../config.ts';
import type { NormalizedPricing } from '../openrouter-catalog.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NATIVE_REVIEW_PHASE_PROMPT_PATH = resolve(
  __dirname,
  '../../../tools/prompts/native-read-only-phase.md',
);

export interface DeniedToolRecord {
  tool: string;
  reason: string;
  message: string;
}

interface SelectedProviderSuccess {
  ok: true;
  entry: ReadyNativeProviderEntry;
}

interface SelectedProviderFailure {
  ok: false;
  message: string;
}

type SelectedProvider = SelectedProviderSuccess | SelectedProviderFailure;

function nativeReviewFailure(
  context: ReviewContext,
  category: string,
  description: string,
  deniedTools: DeniedToolRecord[] = [],
): ReviewResult {
  const blocker: ReviewFinding = {
    severity: 'blocker',
    location: 'native-runtime',
    category,
    description,
  };

  return {
    verdict: 'not_ready',
    codeReviewFindings: [blocker],
    failureCategory: category,
    metadata: {
      branch: context.metadata.branch,
      files: context.metadata.files,
      hasUiChanges: context.metadata.hasUiChanges,
      designContextAvailable: context.designContext !== null,
      uiVerificationRun: false,
      deniedTools,
    },
  };
}

function buildReviewToolRegistry(worktreePath: string) {
  const descriptors: ToolDescriptor[] = [
    ...createReadOnlyTools(worktreePath),
    ...createGitTools(worktreePath),
  ];
  const registry = createToolRegistry(descriptors);
  const phase = 'review' as const;
  const phaseTools = registry.getTools({ phase });
  return {
    registry,
    phaseTools,
    phaseMetadata: registry.list({ phase }),
  };
}

function loadNativeReviewPrompt(
  repoDir: string,
  options: NativePhasePromptOptions = {},
): { content: string; promptRef: ReturnType<typeof logPromptUsage> } {
  const template = readFileSync(NATIVE_REVIEW_PHASE_PROMPT_PATH, 'utf-8');
  // Log the unrendered template so the prompt hash tracks the template version
  // rather than the per-phase tool list rendered into it.
  const promptRef = logPromptUsage(NATIVE_REVIEW_PHASE_PROMPT_PATH, template, { dir: repoDir });
  return { content: renderNativePhasePrompt(template, options), promptRef };
}

function makeTranscriptPath(repoDir: string, sessionId: string): string {
  const runId = process.env.WAVEMILL_SESSION || 'manual-review';
  const baseDir = process.env.WAVEMILL_RUN_DIR
    ? join(process.env.WAVEMILL_RUN_DIR, 'native-sessions')
    : join(repoDir, '.wavemill', 'runs', runId, 'native-sessions');
  mkdirSync(baseDir, { recursive: true });
  return join(baseDir, `${sessionId}.jsonl`);
}

function makeSessionId(branch: string): string {
  const session = process.env.WAVEMILL_SESSION || 'manual-review';
  const safeBranch = branch.replace(/[^A-Za-z0-9._-]+/g, '-');
  return `${session}-review-${safeBranch}`;
}

function registerNativeReviewRuntime(input: {
  repoDir: string;
  provider: ReadyNativeProviderEntry;
  tools: readonly { name: string; class: string }[];
  promptRef: ReturnType<typeof logPromptUsage>;
}): void {
  const refs = registerNativeRuntime({
    phase: 'review',
    provider: input.provider.providerName,
    model: input.provider.modelId,
    api: String(input.provider.model.api),
    tools: input.tools,
    promptRef: input.promptRef ?? undefined,
    repoDir: input.repoDir,
  });

  const sessionId = process.env.WAVEMILL_SESSION;
  if (!sessionId) {
    return;
  }

  if (input.promptRef) {
    recordUse(sessionId, 'review', input.promptRef, input.repoDir);
  }
  if (refs.runtime) {
    recordUse(sessionId, 'review', refs.runtime, input.repoDir);
  }
  if (refs.toolSet) {
    recordUse(sessionId, 'review', refs.toolSet, input.repoDir);
  }
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

function selectReviewProvider(repoDir: string, env: NodeJS.ProcessEnv = process.env): SelectedProvider {
  const providers = resolveNativeAgentProviders(repoDir, { env, phase: 'review' });
  const readyEntry = providers.find(
    (entry): entry is ReadyNativeProviderEntry => entry.status === 'ready',
  );
  if (readyEntry) {
    return { ok: true, entry: readyEntry };
  }

  return {
    ok: false,
    message: buildNativeProviderResolutionFailureMessage('review', providers),
  };
}

function extractFinalAssistantText(messages: AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      continue;
    }
    return message.content
      .filter((block): block is Extract<typeof message.content[number], { type: 'text'; text: string }> => (
        typeof block === 'object' && block !== null && block.type === 'text' && typeof block.text === 'string'
      ))
      .map((block) => block.text)
      .join('\n');
  }
  return '';
}

function extractFinalAssistantErrorMessage(messages: AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
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

function extractDeniedTools(events: TranscriptEvent[]): DeniedToolRecord[] {
  return events
    .filter((event): event is TranscriptToolResult => event.type === 'tool_result')
    .filter((event) => event.isError && typeof event.content === 'string')
    .map((event) => {
      if (event.content.startsWith('phase_denied:')) {
        return {
          tool: event.toolName,
          reason: 'phase_denied',
          message: event.content,
        };
      }
      if (event.content.startsWith('path_denied:')) {
        return {
          tool: event.toolName,
          reason: 'path_denied',
          message: event.content,
        };
      }
      return null;
    })
    .filter((entry): entry is DeniedToolRecord => entry !== null);
}

function stopReasonDescription(stopReason: LoopStopReason): string {
  switch (stopReason) {
    case 'turn_limit':
      return 'Native review hit its iteration limit before producing a final JSON result.';
    case 'token_limit':
      return 'Native review exhausted its token budget before producing a final JSON result.';
    case 'tool_call_limit':
      return 'Native review exhausted its tool-call budget before producing a final JSON result.';
    case 'wall_clock_limit':
      return 'Native review exceeded its wall-clock budget before producing a final JSON result.';
    case 'aborted':
      return 'Native review was aborted before producing a final JSON result.';
    case 'error':
      return 'Native review failed before producing a final JSON result.';
    default:
      return `Native review stopped with "${stopReason}" before producing a final JSON result.`;
  }
}

/**
 * Map a classified provider error to the canonical review failure taxonomy
 * (HOK-2964). Only typed context-window and billing/credit conditions get a
 * dedicated infrastructure category; every other provider error kind keeps
 * the generic `native-review-failed` category so it is not mistaken for a
 * bounded-recoverable condition.
 */
function reviewFailureCategoryForProviderErrorKind(kind: ProviderErrorKind | undefined): string {
  switch (kind) {
    case 'context-window-exceeded':
      return NATIVE_CONTEXT_WINDOW_EXCEEDED_CATEGORY;
    case 'provider-credit-exhausted':
      return PROVIDER_CREDIT_EXHAUSTED_CATEGORY;
    default:
      return 'native-review-failed';
  }
}

function cleanupReasonForStopReason(stopReason: LoopStopReason): CleanupReason | null {
  if (stopReason === 'aborted') {
    return 'aborted';
  }
  if (stopReason === 'wall_clock_limit') {
    return 'timeout';
  }
  return null;
}

const nativeReviewDeps = {
  extractDeniedTools,
  extractFinalAssistantText,
  getNativeProviderApiKey,
  loadNativeReviewPrompt,
  registerNativeReviewRuntime,
  runWavemillLoop,
  selectReviewProvider,
};

export async function runNativeReview(
  context: ReviewContext,
  repoDir: string,
  options: ReviewEngineOptions = {},
): Promise<ReviewResult> {
  const provider = nativeReviewDeps.selectReviewProvider(repoDir, process.env);
  if (!provider.ok) {
    return nativeReviewFailure(context, 'native-runtime-unavailable', provider.message);
  }

  const template = loadPromptResourceSync({
    kind: 'prompt',
    role: 'reviewer',
    persona: 'general',
    operatingMode: options.operatingMode ?? 'normal',
  }).content;
  if (!template) {
    return nativeReviewFailure(
      context,
      'native-review-prompt-missing',
      'Native review could not load the general review prompt template.',
    );
  }

  const userPrompt = fillReviewPromptTemplate(template, context, true);
  const { phaseTools, phaseMetadata, registry } = buildReviewToolRegistry(repoDir);
  const { content: systemPrompt, promptRef } = nativeReviewDeps.loadNativeReviewPrompt(repoDir, {
    tools: phaseMetadata,
    phase: 'review',
  });
  nativeReviewDeps.registerNativeReviewRuntime({
    repoDir,
    provider: provider.entry,
    tools: phaseMetadata,
    promptRef,
  });

  const apiKey = nativeReviewDeps.getNativeProviderApiKey(provider.entry);
  if (!apiKey) {
    return nativeReviewFailure(
      context,
      'native-runtime-unavailable',
      `${provider.entry.apiKeyEnv} resolved to an empty value for native review.`,
    );
  }

  const sessionId = makeSessionId(context.metadata.branch);
  const transcriptPath = makeTranscriptPath(repoDir, sessionId);
  const transcriptWriter = new TranscriptWriter({
    sessionId,
    model: provider.entry.modelId,
    api: String(provider.entry.model.api),
    provider: provider.entry.providerName,
    worktreePath: repoDir,
    gitBranch: context.metadata.branch,
    path: transcriptPath,
  });
  const transcriptEvents: TranscriptEvent[] = [];

  const modelConfig: WavemillLoopConfig['model'] = {
    id: provider.entry.model.id,
    name: provider.entry.model.name,
    api: String(provider.entry.model.api),
    provider: String(provider.entry.model.provider),
    baseUrl: provider.entry.model.baseUrl,
    headers: {
      ...(provider.entry.model.headers ?? {}),
      Authorization: `Bearer ${apiKey}`,
    },
    // model.compat is provider-specific opaque config; runtime treats it as unknown.
    compat: provider.entry.model.compat as unknown,
  };

  const loopContext: AgentContext = {
    systemPrompt,
    messages: [{
      role: 'user',
      content: userPrompt,
      timestamp: 0,
    }],
    tools: phaseTools.map((tool) => toPiAgentTool(tool)),
  };
  const pricing = normalizedPricingFromModel(modelConfig);
  const effectiveMaxTokens = modelConfig.provider === 'openrouter'
    ? capOpenRouterMaxTokensForBalance({
      requestedMaxTokens: REVIEW_MAX_OUTPUT_TOKENS,
      pricing,
      repoDir,
    }) ?? REVIEW_MAX_OUTPUT_TOKENS
    : REVIEW_MAX_OUTPUT_TOKENS;
  if (modelConfig.provider === 'openrouter') {
    assertOpenRouterBalanceSufficient({
      repoDir,
      model: modelConfig.name ?? modelConfig.id,
      pricing,
      reservedOutputTokens: effectiveMaxTokens,
    });
  }

  const maxRetries = options.maxRetries ?? 1;
  const cleanupTracker = createCleanupTracker();
  let loopResult;
  try {
    loopResult = await nativeReviewDeps.runWavemillLoop({
      model: modelConfig,
      context: loopContext,
      maxTokens: effectiveMaxTokens,
      contextManagement: getNativeContextManagementConfig(options.repoDir),
      promptSizeLog: options.repoDir ? {
        repoDir: options.repoDir,
        stage: 'review',
        session: options.session,
        issue: options.issue,
      } : undefined,
      // AgentMessage and Message are structurally compatible at runtime; pi-agent-core
      // exports diverged nominal types so a direct cast is required.
      convertToLlm: (messages) => messages as unknown as Message[],
      afterToolCall: gitAfterToolCall,
      toolPolicy: {
        phase: 'review',
        worktreePath: repoDir,
        registry: registry.list(),
        config: {
          pathFieldsByTool: {
            ...READ_ONLY_PATH_FIELDS,
            ...gitToolPolicyConfig.pathFieldsByTool,
          },
        },
      },
      onEvent: (event) => {
        const derived = transcriptWriter.handleEvent(event);
        if (derived) {
          transcriptEvents.push(derived);
        }
      },
      budget: {
        maxTurns: maxRetries + 1,
        maxToolCalls: 12,
        maxWallClockMs: options.timeout ?? 300_000,
      },
    });
  } catch (error) {
    if (error instanceof ContextExhaustedError) {
      return nativeReviewFailure(context, 'native-context-exhausted', error.message);
    }
    if (error instanceof ContextWindowExceededError || error instanceof ContextWindowUnverifiableError) {
      return nativeReviewFailure(context, 'native-context-window-exceeded', error.message);
    }
    throw error;
  }

  const cleanupReason = cleanupReasonForStopReason(loopResult.stopReason);
  if (cleanupReason) {
    const cleanupReport = await runCleanup(cleanupTracker, {
      worktreePath: repoDir,
      reason: cleanupReason,
    });
    transcriptWriter.writeCleanupReport(cleanupReport);
    if (options.featureDir) {
      await updateStageResult(options.featureDir, 'review', {
        status: cleanupReason === 'aborted' ? 'aborted' : 'failed',
        finishedAt: new Date().toISOString(),
        agent: 'native',
        model: modelConfig.name ?? modelConfig.id,
        notes: `Native review stopped with ${loopResult.stopReason}; cleanup decision ${cleanupReport.cleanupDecision}.`,
        failureReason: loopResult.stopReason,
        finalTreeState: cleanupReport.finalTreeState,
        cleanupDecision: cleanupReport.cleanupDecision,
        cleanupReport,
      });
    }
  }

  const deniedTools = nativeReviewDeps.extractDeniedTools(transcriptEvents);
  if (loopResult.stopReason !== 'stop') {
    const providerErrorMessage = loopResult.stopReason === 'error'
      ? extractFinalAssistantErrorMessage(loopResult.messages)
      : '';
    const providerErrorKind = loopResult.providerError?.kind
      ?? (providerErrorMessage ? classifyProviderError(providerErrorMessage).kind : undefined);
    const providerDescription = providerErrorMessage
      ? `${providerErrorKind ?? 'provider-unknown-error'}: ${providerErrorMessage}`
      : '';
    return nativeReviewFailure(
      context,
      reviewFailureCategoryForProviderErrorKind(providerErrorKind),
      providerDescription || stopReasonDescription(loopResult.stopReason),
      deniedTools,
    );
  }

  const responseText = nativeReviewDeps.extractFinalAssistantText(loopResult.messages);
  if (responseText.trim() === '') {
    return nativeReviewFailure(
      context,
      'native-review-malformed-response',
      'Native review returned an empty final assistant message.',
      deniedTools,
    );
  }

  try {
    const result = parseNativeReviewResponse(responseText, context, options.operatingMode ?? 'normal');
    result.metadata = {
      ...result.metadata,
      deniedTools,
    };
    return result;
  } catch (error) {
    return nativeReviewFailure(
      context,
      'native-review-malformed-response',
      `Native review returned malformed response: ${(error as Error).message}`,
      deniedTools,
    );
  }
}

export const nativeReviewTestUtils = {
  buildReviewToolRegistry,
  extractDeniedTools,
  extractFinalAssistantText,
  setGetNativeProviderApiKey(fn: typeof nativeReviewDeps.getNativeProviderApiKey) {
    nativeReviewDeps.getNativeProviderApiKey = fn;
  },
  setRunWavemillLoop(fn: typeof nativeReviewDeps.runWavemillLoop) {
    nativeReviewDeps.runWavemillLoop = fn;
  },
  setSelectReviewProvider(fn: typeof nativeReviewDeps.selectReviewProvider) {
    nativeReviewDeps.selectReviewProvider = fn;
  },
  resetDeps() {
    nativeReviewDeps.extractDeniedTools = extractDeniedTools;
    nativeReviewDeps.extractFinalAssistantText = extractFinalAssistantText;
    nativeReviewDeps.getNativeProviderApiKey = getNativeProviderApiKey;
    nativeReviewDeps.loadNativeReviewPrompt = loadNativeReviewPrompt;
    nativeReviewDeps.registerNativeReviewRuntime = registerNativeReviewRuntime;
    nativeReviewDeps.runWavemillLoop = runWavemillLoop;
    nativeReviewDeps.selectReviewProvider = selectReviewProvider;
  },
};
