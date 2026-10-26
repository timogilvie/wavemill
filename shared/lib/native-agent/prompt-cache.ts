/**
 * Prompt-cache projection for native runs (HOK-3260).
 *
 * Every native turn resends the whole conversation; the provider-cached
 * prefix costs ~10% of the normal input price. If anything rewrites the start
 * of the request (a timestamp in the system prompt, reordered tools, an edited
 * old message) every later turn pays full price — nothing errors, and the
 * only signal is the cache-read token count. The loop already reads that count
 * per turn for cost; this module turns the per-turn usage into the numbers the
 * stage result carries.
 *
 * Pure: no IO. The warn line and observer finding live in
 * `prompt-cache-detector.ts`.
 *
 * @module prompt-cache
 */

import type { StageExecutionUsage } from '../stage-result.ts';

/**
 * The per-turn usage fields this projection reads. Matches Pi's
 * `AssistantMessage.usage` (`input` excludes cached tokens; `cacheRead` and
 * `cacheWrite` are reported separately), which is also the shape the native
 * loop records per turn.
 */
export interface TurnCacheUsage {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface PromptCacheSummary {
  /** Cache-read tokens summed over every turn, including turn 1. */
  cacheReadTokens: number;
  /** Cache-write (creation) tokens summed over every turn, including turn 1. */
  cacheWriteTokens: number;
  /**
   * `cacheRead / (input + cacheRead + cacheWrite)` summed over turns 2..n.
   * Turn 1 is excluded because it can only write the cache. `null` when fewer
   * than two turns reported usage, or turns 2..n sent no prompt tokens.
   */
  cacheHitRate: number | null;
  /** Number of turns that reported usage (the denominator for "turns 2..n"). */
  turnsWithUsage: number;
}

export const EMPTY_PROMPT_CACHE_SUMMARY: PromptCacheSummary = Object.freeze({
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cacheHitRate: null,
  turnsWithUsage: 0,
});

/** Non-negative finite token count; anything else counts as zero. */
function tokens(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Summarise prompt-cache usage over a run's turns, in turn order.
 */
export function summarizePromptCache(turns: readonly TurnCacheUsage[]): PromptCacheSummary {
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let laterRead = 0;
  let laterPrompt = 0;
  turns.forEach((turn, index) => {
    const input = tokens(turn.input);
    const cacheRead = tokens(turn.cacheRead);
    const cacheWrite = tokens(turn.cacheWrite);
    cacheReadTokens += cacheRead;
    cacheWriteTokens += cacheWrite;
    if (index >= 1) {
      laterRead += cacheRead;
      laterPrompt += input + cacheRead + cacheWrite;
    }
  });
  return {
    cacheReadTokens,
    cacheWriteTokens,
    cacheHitRate: turns.length >= 2 && laterPrompt > 0 ? laterRead / laterPrompt : null,
    turnsWithUsage: turns.length,
  };
}

/** The `LoopResult` fields a stage usage block is built from. */
export interface LoopUsageSource {
  turnsCompleted: number;
  toolCallsExecuted: number;
  wallClockMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd?: number;
  /** Absent on loop results produced before HOK-3260 (and in some test doubles). */
  promptCache?: PromptCacheSummary;
}

/**
 * Build the stage result's `artifacts.usage` block from a loop result.
 *
 * `providerRoute` is the transport provider the loop called (e.g.
 * `anthropic`, `openrouter`), so cache regressions can be attributed to a
 * route as well as a model. `totalCostUsd` is passed through only when the
 * caller has a finite cost; the loop reports 0 when no pricing was loaded,
 * which is not a real cost.
 */
export function buildStageExecutionUsage(
  result: LoopUsageSource,
  providerRoute: string,
  opts: { totalCostUsd?: number } = {},
): StageExecutionUsage {
  const cache = result.promptCache ?? EMPTY_PROMPT_CACHE_SUMMARY;
  const totalCostUsd = opts.totalCostUsd;
  return {
    turnsCompleted: result.turnsCompleted,
    toolCallsExecuted: result.toolCallsExecuted,
    wallClockMs: result.wallClockMs,
    totalInputTokens: result.totalInputTokens,
    totalOutputTokens: result.totalOutputTokens,
    ...(typeof totalCostUsd === 'number' && Number.isFinite(totalCostUsd) ? { totalCostUsd } : {}),
    cacheReadTokens: cache.cacheReadTokens,
    cacheWriteTokens: cache.cacheWriteTokens,
    cacheHitRate: cache.cacheHitRate,
    ...(providerRoute ? { providerRoute } : {}),
  };
}

/** Minimum turns before a run's hit rate is judged (turns 2..n need ≥2 samples). */
export const PROMPT_CACHE_MIN_TURNS = 3;

export interface PromptCacheEvaluation {
  /** True when the run had enough turns and a defined hit rate to judge. */
  eligible: boolean;
  /** True when eligible and the hit rate is below `threshold`. */
  belowThreshold: boolean;
  rate: number | null;
  turns: number;
}

/**
 * Judge one run's hit rate against the threshold. A run needs at least
 * {@link PROMPT_CACHE_MIN_TURNS} turns that reported usage; a run without a
 * defined rate is never flagged.
 */
export function evaluatePromptCache(
  usage: Pick<StageExecutionUsage, 'cacheHitRate' | 'turnsCompleted'>,
  threshold: number,
): PromptCacheEvaluation {
  const turns = usage.turnsCompleted ?? 0;
  const rate = typeof usage.cacheHitRate === 'number' && Number.isFinite(usage.cacheHitRate)
    ? usage.cacheHitRate
    : null;
  const eligible = turns >= PROMPT_CACHE_MIN_TURNS && rate !== null;
  return {
    eligible,
    belowThreshold: eligible && rate! < threshold,
    rate,
    turns,
  };
}
