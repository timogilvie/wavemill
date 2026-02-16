/**
 * Eval scoring rubric and data schema for the wavemill eval system.
 *
 * Defines a 0–1 scoring rubric that maps autonomous task outcomes to
 * human-readable bands, plus the {@link EvalRecord} type that captures
 * a complete eval result.
 *
 * @module eval-schema
 */

// ────────────────────────────────────────────────────────────────
// Scoring Rubric
// ────────────────────────────────────────────────────────────────

/**
 * A single band in the scoring rubric.
 *
 * Each band covers a contiguous range of the 0–1 score space.
 * `min` is inclusive and `max` is inclusive.
 */
export interface ScoreBand {
  /** Human-readable label for this band (e.g. "Full Success") */
  readonly label: string;
  /** Lower bound of the band (inclusive) */
  readonly min: number;
  /** Upper bound of the band (inclusive) */
  readonly max: number;
  /** Plain-language description of what qualifies for this band */
  readonly description: string;
}

/**
 * The five scoring bands that partition the 0.0–1.0 range.
 *
 * | Band              | Range     | Meaning |
 * |-------------------|-----------|---------|
 * | Failure           | 0.0–0.1   | Task not completed; fundamental misunderstanding or no meaningful output |
 * | Partial           | 0.2–0.4   | Some progress but major gaps remain; output is not usable without significant rework |
 * | Assisted Success  | 0.5–0.7   | Task completed with notable human intervention; core goal achieved but required guidance |
 * | Minor Feedback    | 0.8–0.9   | Task completed with minor corrections; output was nearly autonomous |
 * | Full Success      | 1.0       | Task completed autonomously with no human intervention; output is production-ready |
 */
export const SCORE_BANDS = [
  {
    label: 'Failure',
    min: 0.0,
    max: 0.1,
    description:
      'Task not completed; fundamental misunderstanding or no meaningful output.',
  },
  {
    label: 'Partial',
    min: 0.2,
    max: 0.4,
    description:
      'Some progress but major gaps remain; output is not usable without significant rework.',
  },
  {
    label: 'Assisted Success',
    min: 0.5,
    max: 0.7,
    description:
      'Task completed with notable human intervention; core goal achieved but required guidance.',
  },
  {
    label: 'Minor Feedback',
    min: 0.8,
    max: 0.9,
    description:
      'Task completed with minor corrections; output was nearly autonomous.',
  },
  {
    label: 'Full Success',
    min: 1.0,
    max: 1.0,
    description:
      'Task completed autonomously with no human intervention; output is production-ready.',
  },
] as const satisfies readonly ScoreBand[];

/** Union of all valid score band labels */
export type ScoreBandLabel = (typeof SCORE_BANDS)[number]['label'];

/**
 * Map a numeric score (0–1) to its rubric band.
 *
 * Scores that fall between defined bands are rounded to the nearest band.
 * Scores outside 0–1 throw a RangeError.
 *
 * @param score - A number between 0 and 1 (inclusive)
 * @returns The matching {@link ScoreBand}
 * @throws {RangeError} If score is outside the 0–1 range
 *
 * @example
 * ```ts
 * getScoreBand(1.0).label  // "Full Success"
 * getScoreBand(0.6).label  // "Assisted Success"
 * getScoreBand(0.0).label  // "Failure"
 * ```
 */
export function getScoreBand(score: number): ScoreBand {
  if (score < 0 || score > 1) {
    throw new RangeError(`Score must be between 0 and 1, got ${score}`);
  }

  // Walk bands in order; return the first band whose range contains the score.
  // Because bands have gaps (e.g. 0.1–0.2), scores in gaps are assigned to
  // the nearest band by checking which band boundary is closer.
  for (const band of SCORE_BANDS) {
    if (score >= band.min && score <= band.max) {
      return band;
    }
  }

  // Score falls in a gap between bands — find the closest band.
  let closest: ScoreBand = SCORE_BANDS[0];
  let minDistance = Infinity;
  for (const band of SCORE_BANDS) {
    const distance = Math.min(
      Math.abs(score - band.min),
      Math.abs(score - band.max),
    );
    if (distance < minDistance) {
      minDistance = distance;
      closest = band;
    }
  }
  return closest;
}

// ────────────────────────────────────────────────────────────────
// Token Usage
// ────────────────────────────────────────────────────────────────

/**
 * Token usage from an LLM API call.
 */
export interface TokenUsage {
  /** Number of input (prompt) tokens */
  inputTokens: number;
  /** Number of output (completion) tokens */
  outputTokens: number;
  /** Total tokens (input + output) */
  totalTokens: number;
}

// ────────────────────────────────────────────────────────────────
// Eval Record
// ────────────────────────────────────────────────────────────────

/**
 * A single eval result record.
 *
 * Captures everything needed to assess, compare, and analyse an
 * autonomous task execution — the prompt, the model, the outcome
 * score, timing, and any human interventions that occurred.
 */
export interface EvalRecord {
  /** Unique identifier for this eval record (UUID v4 recommended) */
  id: string;

  /** Schema version for forward compatibility (semver, e.g. "1.0.0") */
  schemaVersion: string;

  /** The task prompt that was given to the agent */
  originalPrompt: string;

  /** Model identifier (e.g. "claude-opus-4-6") */
  modelId: string;

  /** Specific model version string for reproducibility */
  modelVersion: string;

  /** Model ID used by the LLM judge for this eval */
  judgeModel?: string;

  /** Provider used by the LLM judge for this eval (e.g. "anthropic") */
  judgeProvider?: string;

  /** Numeric score between 0 and 1 (inclusive) */
  score: number;

  /** The rubric band label derived from the score */
  scoreBand: ScoreBandLabel;

  /** Wall-clock time in seconds for task completion */
  timeSeconds: number;

  /** ISO 8601 datetime string when the eval was recorded */
  timestamp: string;

  /** Whether any human intervention was required during the task */
  interventionRequired: boolean;

  /** Number of distinct human interventions during the task */
  interventionCount: number;

  /** Brief description of each human intervention */
  interventionDetails: string[];

  /** Free-text rationale from the LLM judge explaining the score */
  rationale: string;

  /** Linear issue identifier (e.g. "HOK-697"), if the task was issue-based */
  issueId?: string;

  /** Pull request URL, if the task produced a PR */
  prUrl?: string;

  /** Token usage from the LLM judge API call */
  tokenUsage?: TokenUsage;

  /** Estimated cost in USD based on the pricing table */
  estimatedCost?: number;

  /** Total estimated cost in USD to build the feature (all Claude sessions on this branch) */
  workflowCost?: number;

  /** Per-model token usage breakdown from the workflow sessions */
  workflowTokenUsage?: Record<
    string,
    {
      inputTokens: number;
      cacheCreationTokens: number;
      cacheReadTokens: number;
      outputTokens: number;
      costUsd: number;
    }
  >;

  /** Optional extensibility bag for additional metadata */
  metadata?: Record<string, unknown>;
}
