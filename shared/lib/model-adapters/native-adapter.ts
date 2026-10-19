/**
 * Native transport adapters (HOK-3248).
 *
 * The native loop (`shared/lib/native-agent/loop.ts`) already resolves
 * `contextWindowLimit` from the registry and runs `evaluateContextWindow`
 * in-loop; these adapters are a thin facade so callers do not re-derive
 * them. `invoke`/`parseResult` are not applicable to the native path (it
 * never produces a stdout/stderr/exitCode tuple); callers that mis-dispatch
 * get a loud error from the throwing stubs.
 */
import { getEffectiveRegistry, getModel } from '../model-registry.ts';
import {
  policyKindFor,
  type AdapterError,
  type AdapterInvokeResult,
  type AdapterKind,
  type AdapterLimits,
  type AdapterParseResult,
  type TransportAdapter,
} from './transport-adapter.ts';
import {
  estimatePromptTokens,
  evaluateContextWindow,
} from '../native-agent/context-window-guard.ts';

export interface NativeAdapterOptions {
  model: string;
  repoDir?: string;
  reservedOutputTokens?: number;
}

const DEFAULT_RESERVED_OUTPUT_TOKENS = 8_000;

abstract class NativeAdapterBase implements TransportAdapter {
  abstract readonly kind: AdapterKind;
  readonly model: string;
  readonly limits: AdapterLimits;
  protected readonly reservedOutputTokens: number;

  constructor(opts: NativeAdapterOptions) {
    this.model = opts.model;
    this.reservedOutputTokens = opts.reservedOutputTokens ?? DEFAULT_RESERVED_OUTPUT_TOKENS;
    const capabilities = getModel(getEffectiveRegistry(opts.repoDir), opts.model);
    this.limits = {
      ...(typeof capabilities?.contextWindowTokens === 'number'
        ? { contextWindowTokens: capabilities.contextWindowTokens }
        : {}),
      cliHarnessOverheadTokens: 0,
      maxOutputTokens: this.reservedOutputTokens,
    };
  }

  countTokens(text: string): number {
    return estimatePromptTokens({ messages: [{ role: 'user', content: text }] }).inputTokens;
  }

  preflight(prompt: string): AdapterError | undefined {
    const limit = this.limits.contextWindowTokens;
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
      return undefined;
    }
    const verdict = evaluateContextWindow({
      phase: 'native',
      model: { id: this.model, provider: this.kind },
      limit: { limit, source: 'registry', registryModelId: this.model },
      estimate: estimatePromptTokens({ messages: [{ role: 'user', content: prompt }] }),
      reservedOutputTokens: this.reservedOutputTokens,
    });
    if (verdict.ok) return undefined;
    const message = (verdict as { message: string }).message;
    return {
      kind: 'context-exceeded',
      message,
      policyKind: policyKindFor('context-exceeded'),
      rawExcerpt: message.slice(0, 500),
    };
  }

  async invoke(): Promise<AdapterInvokeResult> {
    throw new Error(
      `${this.kind} adapter has no transport-level invoke; dispatch native work through ` +
        `runWavemillLoop / runNativeReview and consult adapter.limits / adapter.preflight only`,
    );
  }

  parseResult(): AdapterParseResult {
    throw new Error(
      `${this.kind} adapter has no CLI-shaped parseResult; native results arrive structured`,
    );
  }
}

export class NativeOpenAIAdapter extends NativeAdapterBase {
  readonly kind = 'native-openai' as const;
}

export class NativeOpenRouterAdapter extends NativeAdapterBase {
  readonly kind = 'native-openrouter' as const;
}
