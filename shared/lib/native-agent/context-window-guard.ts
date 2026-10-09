import { getEffectiveRegistry, getModel, type ModelRegistry } from '../model-registry.ts';
import { estimateTokensFromBytes } from './compaction.ts';

export const CONTEXT_WINDOW_SAFETY_MARGIN = 0.10;
export const MESSAGE_OVERHEAD_TOKENS = 4;

export interface PromptTokenEstimate {
  systemPromptTokens: number;
  messageTokens: number;
  toolTokens: number;
  inputTokens: number;
}

export interface ContextWindowLimit {
  limit: number;
  source: 'registry' | 'model';
  registryModelId?: string;
}

export interface ContextWindowDiagnostic {
  phase: string;
  model: string;
  provider: string;
  limit: number;
  limitSource: 'registry' | 'model';
  reservedOutputTokens: number;
  safetyMargin: number;
  estimate: PromptTokenEstimate;
  projectedInputTokens: number;
  projectedTotalTokens: number;
  headroomTokens: number;
}

export type ContextWindowVerdict =
  | { ok: true; diagnostic: ContextWindowDiagnostic }
  | { ok: false; diagnostic: ContextWindowDiagnostic; message: string };

export class ContextWindowExceededError extends Error {
  readonly diagnostic: ContextWindowDiagnostic;

  constructor(message: string, diagnostic: ContextWindowDiagnostic) {
    super(message);
    this.name = 'ContextWindowExceededError';
    this.diagnostic = diagnostic;
  }
}

export interface ContextExhaustedDiagnostic extends ContextWindowDiagnostic {
  droppedCount: number;
  droppedTokensEstimate: number;
  handoff: {
    transcriptPath?: string;
    lastCompactionStrategy?: string;
    stopAfterTurn?: number;
  };
}

export class ContextExhaustedError extends Error {
  readonly diagnostic: ContextExhaustedDiagnostic;

  constructor(message: string, diagnostic: ContextExhaustedDiagnostic) {
    super(message);
    this.name = 'ContextExhaustedError';
    this.diagnostic = diagnostic;
  }
}

export class ContextWindowUnverifiableError extends Error {
  constructor(phase: string, model: { id: string; name?: string; provider: string }) {
    super(
      `Native ${phase} pre-flight cannot verify the context window for ${displayModel(model)} (${model.provider}): `
      + 'the model is not in the model registry and no contextWindow was supplied; refusing to launch (fail closed). '
      + 'Add the model to shared/lib/model-registry.ts with contextWindowTokens.',
    );
    this.name = 'ContextWindowUnverifiableError';
  }
}

interface PromptContext {
  systemPrompt?: string;
  messages: readonly unknown[];
  tools?: readonly { name: string; description?: string; parameters?: unknown }[];
}

export function estimatePromptTokens(input: PromptContext): PromptTokenEstimate {
  const systemPromptTokens = tokensForString(input.systemPrompt ?? '');
  const messageTokens = input.messages.reduce(
    (total, message) => total + MESSAGE_OVERHEAD_TOKENS + tokensForValue(withoutToolDeclarations(message)),
    0,
  );
  const toolTokens = (input.tools ?? []).reduce((total, tool) => {
    return total + tokensForValue({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    });
  }, 0);
  return {
    systemPromptTokens,
    messageTokens,
    toolTokens,
    inputTokens: systemPromptTokens + messageTokens + toolTokens,
  };
}

/**
 * Pi 1.0 records tool declarations as `toolsAdded`/`toolsRemoved` on transcript
 * system messages. The current tool set is already counted from `tools`, so
 * those fields are excluded to avoid counting every schema twice (HOK-3161).
 */
function withoutToolDeclarations(message: unknown): unknown {
  if (!message || typeof message !== 'object' || (message as { role?: unknown }).role !== 'system') {
    return message;
  }
  const { toolsAdded: _added, toolsRemoved: _removed, ...rest } = message as Record<string, unknown>;
  return rest;
}

export function resolveContextWindowLimit(
  model: { id: string; name?: string; provider: string; contextWindow?: number },
  registry: ModelRegistry = getEffectiveRegistry(),
): ContextWindowLimit | undefined {
  const registryIds = registryLookupIds(model);
  for (const registryModelId of registryIds) {
    const capabilities = getModel(registry, registryModelId);
    if (capabilities?.contextWindowTokens !== undefined) {
      return {
        limit: capabilities.contextWindowTokens,
        source: 'registry',
        registryModelId,
      };
    }
  }

  if (isPositiveFiniteInteger(model.contextWindow)) {
    return { limit: model.contextWindow, source: 'model' };
  }
  return undefined;
}

export function evaluateContextWindow(input: {
  phase?: string;
  model: { id: string; name?: string; provider: string };
  limit: ContextWindowLimit;
  estimate: PromptTokenEstimate;
  reservedOutputTokens: number;
  safetyMargin?: number;
}): ContextWindowVerdict {
  const safetyMargin = input.safetyMargin ?? CONTEXT_WINDOW_SAFETY_MARGIN;
  const projectedInputTokens = Math.ceil(input.estimate.inputTokens * (1 + safetyMargin));
  const projectedTotalTokens = projectedInputTokens + input.reservedOutputTokens;
  const diagnostic: ContextWindowDiagnostic = {
    phase: input.phase ?? 'native',
    model: displayModel(input.model),
    provider: input.model.provider,
    limit: input.limit.limit,
    limitSource: input.limit.source,
    reservedOutputTokens: input.reservedOutputTokens,
    safetyMargin,
    estimate: input.estimate,
    projectedInputTokens,
    projectedTotalTokens,
    headroomTokens: input.limit.limit - projectedTotalTokens,
  };

  if (projectedTotalTokens <= input.limit.limit) {
    return { ok: true, diagnostic };
  }

  return {
    ok: false,
    diagnostic,
    message: formatExceededMessage(diagnostic),
  };
}

export function assertPromptFitsContextWindow(input: {
  phase?: string;
  model: { id: string; name?: string; provider: string; contextWindow?: number };
  context: PromptContext;
  reservedOutputTokens: number;
  registry?: ModelRegistry;
  limit?: ContextWindowLimit;
  safetyMargin?: number;
}): ContextWindowVerdict | { ok: true; skipped: 'unknown-limit' } {
  const phase = input.phase ?? 'native';
  const limit = input.limit ?? resolveContextWindowLimit(input.model, input.registry);
  if (!limit) {
    if (isNativeCompatProvider(input.model.provider)) {
      throw new ContextWindowUnverifiableError(phase, input.model);
    }
    return { ok: true, skipped: 'unknown-limit' };
  }

  const verdict = evaluateContextWindow({
    phase,
    model: input.model,
    limit,
    estimate: estimatePromptTokens(input.context),
    reservedOutputTokens: input.reservedOutputTokens,
    safetyMargin: input.safetyMargin,
  });
  if (!verdict.ok) {
    throw new ContextWindowExceededError(verdict.message, verdict.diagnostic);
  }
  return verdict;
}

function registryLookupIds(model: { id: string; name?: string }): string[] {
  const ids: string[] = [];
  const name = model.name?.trim();
  if (name) ids.push(name);

  const id = model.id.trim();
  if (id) {
    const separator = id.indexOf(':');
    ids.push(separator === -1 ? id : id.slice(separator + 1));
  }

  return [...new Set(ids)];
}

function displayModel(model: { id: string; name?: string }): string {
  const name = model.name?.trim();
  return name && name.length > 0 ? name : model.id;
}

function tokensForString(text: string): number {
  return estimateTokensFromBytes(Buffer.byteLength(text, 'utf8'));
}

function tokensForValue(value: unknown): number {
  if (typeof value === 'string') {
    return tokensForString(value);
  }
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + tokensForBlock(item), 0);
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.content === 'string' || Array.isArray(record.content)) {
      return tokensForValue(record.content);
    }
  }
  return tokensForJson(value);
}

function tokensForBlock(block: unknown): number {
  if (typeof block === 'string') {
    return tokensForString(block);
  }
  if (!block || typeof block !== 'object') {
    return tokensForJson(block);
  }

  const record = block as Record<string, unknown>;
  let total = 0;
  if (typeof record.text === 'string') total += tokensForString(record.text);
  if (typeof record.thinking === 'string') total += tokensForString(record.thinking);
  if (record.arguments !== undefined) total += tokensForJson(record.arguments);
  if (record.content !== undefined) total += tokensForValue(record.content);

  return total > 0 ? total : tokensForJson(record);
}

function tokensForJson(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : tokensForString(json);
  } catch {
    return 0;
  }
}

function isPositiveFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isNativeCompatProvider(provider: string): boolean {
  return provider === 'openai' || provider === 'openrouter';
}

function formatExceededMessage(diagnostic: ContextWindowDiagnostic): string {
  const marginPercent = Math.round(diagnostic.safetyMargin * 100);
  return `Native ${diagnostic.phase} pre-flight rejected the launch: estimated prompt is ~${diagnostic.projectedInputTokens} input tokens `
    + `(${diagnostic.estimate.inputTokens} estimated = ${diagnostic.estimate.systemPromptTokens} system prompt + `
    + `${diagnostic.estimate.messageTokens} messages + ${diagnostic.estimate.toolTokens} tool schemas, +${marginPercent}% safety margin) `
    + `plus ${diagnostic.reservedOutputTokens} reserved output tokens = ${diagnostic.projectedTotalTokens}, which exceeds the `
    + `${diagnostic.limit}-token context window of ${diagnostic.model} (${diagnostic.provider}, limit from ${diagnostic.limitSource}). `
    + 'The provider would reject this request (context_length_exceeded). Re-route to a model with a larger context window, '
    + 'or trim the task packet, plan, or issue context before relaunching.';
}
