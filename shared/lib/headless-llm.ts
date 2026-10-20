/**
 * Headless utility LLM calls (non-agent, single-shot text generation).
 *
 * This wraps {@link callLLM} for the "utility" call sites — eval judging,
 * subsystem/context doc generation, task-packet splitting — that previously
 * hardcoded `provider: 'claude'` and Claude-CLI-only flags (`--tools ''`,
 * `--append-system-prompt`).
 *
 * Two things it centralizes:
 *  1. **Provider follows the model.** The provider is derived from the model id
 *     via `resolveModelAgent` (the single resolver the launcher and router
 *     use), so flipping a call site to Codex is a matter of configuring a
 *     `gpt-*` model — no per-site provider edits (HOK-3248).
 *  2. **System-instruction / no-tools translation.** Claude expresses "no tools,
 *     append this system prompt" with CLI flags; Codex has no equivalent flag,
 *     so the instruction is folded into the prompt and tool use is already
 *     constrained by the codex provider's `--sandbox read-only` default.
 *
 * @module headless-llm
 */

import {
  callLLM,
  type LLMCallOptions,
  type LLMCallResult,
  type LLMProvider,
} from './llm-cli.ts';
import { resolveModelAgent } from './model-agent-resolution.ts';

/**
 * Resolve a model id to the CLI provider that serves it (`claude` or
 * `codex`). Native-only models and anything the resolver cannot place still
 * fall back to `claude`, since the headless path has no native runtime.
 * Ids not in the registry fall back to a name heuristic so a `gpt-*`/`o<n>`
 * name still reaches codex.
 */
export function headlessProviderForModel(model?: string, repoDir?: string): LLMProvider {
  if (!model) return 'claude';
  const resolution = resolveModelAgent({ model, phase: 'review', repoDir });
  if (resolution.ok) {
    return resolution.agent === 'codex' ? 'codex' : 'claude';
  }
  // Not placeable by the resolver (e.g. not in the registry). Preserve the
  // historical name heuristic so `gpt-*`/`o<n>` ids still land on codex.
  return /^(gpt-|o\d|codex)/i.test(model) ? 'codex' : 'claude';
}

/**
 * Default model for headless utility calls. Codex/`gpt-5.6-terra` (successor to
 * retired `gpt-5.5`). Overridable via env; Phase 3 will source this from wavemill config.
 */
export const HEADLESS_DEFAULT_MODEL = process.env.WAVEMILL_HEADLESS_MODEL || 'gpt-5.6-terra';

export interface HeadlessLLMOptions extends Omit<LLMCallOptions, 'provider' | 'cliCmd' | 'cliFlags'> {
  /**
   * Instruction constraining the output (e.g. "Output ONLY markdown, no preamble").
   * Appended as a system prompt on Claude; prepended to the prompt on Codex.
   */
  systemInstruction?: string;
  /**
   * Disable tool use. On Claude this passes `--tools ''`; on Codex tool use is
   * already constrained by the provider's read-only sandbox default, so this is
   * a no-op there.
   */
  noTools?: boolean;
}

/**
 * Run a headless utility LLM call, routing to Codex or Claude based on the model.
 *
 * @param prompt - The user prompt.
 * @param options - Standard {@link LLMCallOptions} minus `provider`/`cliCmd`/`cliFlags`,
 *   plus `systemInstruction` / `noTools`. `model` defaults to {@link HEADLESS_DEFAULT_MODEL}.
 */
export async function callHeadlessLLM(
  prompt: string,
  options: HeadlessLLMOptions = {},
): Promise<LLMCallResult> {
  const { systemInstruction, noTools, ...rest } = options;
  const model = rest.model ?? HEADLESS_DEFAULT_MODEL;
  const provider = headlessProviderForModel(model, rest.repoDir);

  if (provider === 'claude') {
    const cliFlags: string[] = [];
    if (noTools) {
      cliFlags.push('--tools', '');
    }
    if (systemInstruction) {
      cliFlags.push('--append-system-prompt', systemInstruction);
    }
    return callLLM(prompt, {
      ...rest,
      model,
      provider: 'claude',
      cliCmd: process.env.CLAUDE_CMD || 'claude',
      cliFlags: cliFlags.length > 0 ? cliFlags : undefined,
    });
  }

  // Codex (and any other non-Claude provider): no append-system-prompt flag, so
  // fold the instruction into the prompt. Tool use is constrained by the codex
  // provider's read-only sandbox default.
  const finalPrompt = systemInstruction ? `${systemInstruction}\n\n${prompt}` : prompt;
  return callLLM(finalPrompt, {
    ...rest,
    model,
    provider,
  });
}
