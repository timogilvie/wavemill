/**
 * Low prompt-cache hit-rate detection for native runs (HOK-3260).
 *
 * A native run with at least {@link PROMPT_CACHE_MIN_TURNS} turns whose hit
 * rate over turns 2..n is below `reliability.promptCache.minHitRate`
 * (default 0.5) gets:
 *
 * - a `[native-<stage>] low prompt-cache hit rate …` warn line in the stage
 *   log, every time (a retry of the same run logs it again), and
 * - one observer finding per (model, provider route, stage) per UTC day. The
 *   day's first emitter creates a sentinel under
 *   `.wavemill/observer-dedup/prompt-cache/<yyyy-mm-dd>/` with an exclusive
 *   create, so concurrent stages cannot both emit.
 *
 * This is a quality signal, not a gate: it never throws, parks, or fails a
 * run, and it adds no `WAVEMILL_*` flag (HOK-3235). Observer gating is the
 * shared `appendObserverFinding` capability check (HOK-3102).
 *
 * @module prompt-cache-detector
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getReliabilityConfig } from '../config.ts';
import { errorMessage } from '../error-utils.ts';
import { appendObserverFinding } from '../observer-findings.ts';
import type { StageExecutionUsage, StageName } from '../stage-result.ts';
import { evaluatePromptCache, PROMPT_CACHE_MIN_TURNS, type PromptCacheEvaluation } from './prompt-cache.ts';

export const PROMPT_CACHE_FINDING_SUBSYSTEM = 'native-prompt-cache';
export const PROMPT_CACHE_FINDING_KIND = 'prompt-cache-low-hit-rate';

export interface ReportPromptCacheInput {
  /** Repo whose `.wavemill/` receives the finding. Detection is skipped when absent. */
  repoDir: string | undefined;
  stage: Extract<StageName, 'planning' | 'coding' | 'review'>;
  /** Model the run was launched with (registry id). */
  model: string;
  usage: StageExecutionUsage;
  /** Overrides `reliability.promptCache.minHitRate` (tests). */
  threshold?: number;
  now?: () => Date;
  warn?: (line: string) => void;
}

export type PromptCacheFindingOutcome =
  /** Run was not eligible or was at/above the threshold. */
  | 'not-flagged'
  /** A finding was appended for this (model, route, stage, day). */
  | 'emitted'
  /** This (model, route, stage, day) already has a finding. */
  | 'deduplicated'
  /** Flagged, but the finding could not be written (observer off, IO error). */
  | 'skipped';

export interface ReportPromptCacheResult {
  evaluation: PromptCacheEvaluation;
  threshold: number | null;
  warned: boolean;
  finding: PromptCacheFindingOutcome;
}

/** Filesystem-safe key segment. */
function slug(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'unknown';
}

/** Path of the per-day dedup sentinel for one (model, route, stage). */
export function promptCacheDedupPath(
  repoDir: string,
  key: { dayUtc: string; model: string; providerRoute: string; stage: string },
): string {
  return join(
    repoDir,
    '.wavemill',
    'observer-dedup',
    'prompt-cache',
    key.dayUtc,
    `${slug(key.model)}__${slug(key.providerRoute)}__${slug(key.stage)}.json`,
  );
}

function resolveThreshold(input: ReportPromptCacheInput): number | null {
  if (typeof input.threshold === 'number') return input.threshold;
  try {
    return getReliabilityConfig(input.repoDir).promptCache.minHitRate;
  } catch (error) {
    // An unloadable config already fails louder elsewhere; detection is optional.
    console.warn(`[native-${input.stage}] prompt-cache detection skipped: ${errorMessage(error)}`);
    return null;
  }
}

/**
 * Exclusively create the sentinel. Returns false when it already exists.
 * Other IO errors propagate to the caller's catch.
 */
function claimSentinel(path: string, body: Record<string, unknown>): boolean {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, `${JSON.stringify(body)}\n`, { encoding: 'utf-8', flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/**
 * Evaluate a finished native run's prompt-cache hit rate; warn and emit a
 * deduplicated observer finding when it is below the threshold. Never throws.
 */
export function reportPromptCacheHitRate(input: ReportPromptCacheInput): ReportPromptCacheResult {
  const warn = input.warn ?? ((line: string) => console.warn(line));
  const threshold = resolveThreshold(input);
  const evaluation = evaluatePromptCache(input.usage, threshold ?? 0);
  if (threshold === null || !evaluation.belowThreshold) {
    return { evaluation, threshold, warned: false, finding: 'not-flagged' };
  }

  const rate = evaluation.rate!;
  const providerRoute = input.usage.providerRoute || 'unknown';
  warn(
    `[native-${input.stage}] low prompt-cache hit rate: ${rate.toFixed(3)} below ${threshold.toFixed(3)} `
    + `over ${evaluation.turns} turns (model=${input.model} provider=${providerRoute} `
    + `cacheRead=${input.usage.cacheReadTokens ?? 0} cacheWrite=${input.usage.cacheWriteTokens ?? 0} `
    + `input=${input.usage.totalInputTokens ?? 0})`,
  );

  if (!input.repoDir) {
    return { evaluation, threshold, warned: true, finding: 'skipped' };
  }

  try {
    const now = (input.now ?? (() => new Date()))();
    const dayUtc = now.toISOString().slice(0, 10);
    const sentinelPath = promptCacheDedupPath(input.repoDir, {
      dayUtc,
      model: input.model,
      providerRoute,
      stage: input.stage,
    });
    const context = {
      markerPath: sentinelPath,
      markerKind: PROMPT_CACHE_FINDING_KIND,
      stage: input.stage,
      model: input.model,
      providerRoute,
      hitRate: Number(rate.toFixed(4)),
      threshold,
      turnsCompleted: evaluation.turns,
      cacheReadTokens: input.usage.cacheReadTokens ?? 0,
      cacheWriteTokens: input.usage.cacheWriteTokens ?? 0,
      inputTokens: input.usage.totalInputTokens ?? 0,
      dayUtc,
    };
    if (!claimSentinel(sentinelPath, { emittedAt: now.toISOString(), ...context })) {
      return { evaluation, threshold, warned: true, finding: 'deduplicated' };
    }
    const appended = appendObserverFinding(input.repoDir, {
      subsystem: PROMPT_CACHE_FINDING_SUBSYSTEM,
      title: `Native ${input.stage} prompt-cache hit rate ${(rate * 100).toFixed(1)}% `
        + `(${input.model} via ${providerRoute})`,
      body: `A ${evaluation.turns}-turn native ${input.stage} run read ${(rate * 100).toFixed(1)}% of its `
        + `turn 2..n prompt tokens from the provider cache, below the ${(threshold * 100).toFixed(0)}% threshold. `
        + 'Every uncached turn pays full input price. Usual causes: a changing system-prompt prefix '
        + '(timestamps, ids), tools serialized in a different order, edits to earlier messages, or a '
        + `provider route/compat flag that drops cache breakpoints. Runs need at least ${PROMPT_CACHE_MIN_TURNS} turns to be judged.`,
      severity: 'medium',
      at: now.toISOString(),
      recommendation: 'Compare this run\'s per-turn cacheRead tokens with an earlier run of the same model and route; '
        + 'check recent changes to the native prompt builders, tool registry order and provider compat flags.',
      context,
    });
    if (!appended) {
      // Observer off (or the append failed): release the day's slot so a
      // later run can still report once the observer is on.
      rmSync(sentinelPath, { force: true });
      return { evaluation, threshold, warned: true, finding: 'skipped' };
    }
    return { evaluation, threshold, warned: true, finding: 'emitted' };
  } catch (error) {
    console.warn(`[native-${input.stage}] prompt-cache finding not recorded: ${errorMessage(error)}`);
    return { evaluation, threshold, warned: true, finding: 'skipped' };
  }
}
