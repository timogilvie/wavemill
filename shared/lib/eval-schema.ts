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
// Intervention Record
// ────────────────────────────────────────────────────────────────

/**
 * Intervention type enum — describes the reason for human intervention.
 */
export type InterventionType =
  | 'clarification'
  | 'bugfix'
  | 'manual_merge'
  | 'environment_fix'
  | 'prompt_edit'
  | 'scope_change'
  | 'rollback';

/**
 * Intervention severity enum — indicates impact level.
 */
export type InterventionSeverity = 'low' | 'med' | 'high';

/**
 * A single structured intervention event.
 *
 * Captures when, why, and how a human intervened during task execution.
 * Enables ML routing to learn which task characteristics lead to babysitting.
 */
export interface InterventionRecord {
  /** ISO 8601 datetime when the intervention occurred */
  timestamp: string;

  /** Type of intervention (reason) */
  type: InterventionType;

  /** Severity/impact of the intervention */
  severity: InterventionSeverity;

  /** Human-readable description of what was done */
  note: string;

  /** Optional time spent on this intervention in seconds */
  timeSpentSeconds?: number;
}

// ────────────────────────────────────────────────────────────────
// Routing Decision (HOK-775)
// ────────────────────────────────────────────────────────────────

/**
 * A single candidate configuration considered during routing.
 *
 * Captures the full specification of a model + agent + toolset combination
 * that was eligible for selection by the router.
 */
export interface RoutingCandidate {
  /** Agent type (e.g., "claude", "codex") */
  agentType: string;

  /** Model identifier (e.g., "claude-opus-4-6", "gpt-5.3-codex") */
  modelId: string;

  /** Specific model version string (optional) */
  modelVersion?: string;

  /** Toolset variant identifier (optional) */
  toolsetId?: string;

  /** Price tier classification (e.g., "low", "medium", "high") */
  priceTier?: string;
}

/**
 * Routing decision metadata capturing all candidates considered.
 *
 * Records the full decision context: which models were eligible,
 * which was chosen, and why. Essential for training routing models
 * to learn cost/quality tradeoffs.
 *
 * **Why this matters:** Without the candidate set, a router can't learn
 * "use cheaper model when similar quality" because it never sees what
 * "similar" meant relative to the alternatives.
 */
export interface RoutingDecision {
  /**
   * All candidate configurations that were eligible for this task.
   *
   * Should include at least 2 candidates (otherwise no decision was made).
   */
  candidates: RoutingCandidate[];

  /**
   * The chosen candidate.
   *
   * Can be either:
   * - A full RoutingCandidate object (reference)
   * - A number (index into the candidates array)
   */
  chosen: RoutingCandidate | number;

  /**
   * Decision policy version that made this choice.
   *
   * Examples: "baseline", "router-v1.0", "router-v2.1-prod"
   */
  decisionPolicyVersion: string;

  /**
   * Optional rationale or top features used for the decision.
   *
   * Can be free text or structured (e.g., JSON of feature weights).
   */
  decisionRationale?: string;
}

// ────────────────────────────────────────────────────────────────
// Task Context (HOK-774)
// ────────────────────────────────────────────────────────────────

/**
 * Task type classification for routing and evaluation.
 */
export type TaskType =
  | 'bugfix'
  | 'feature'
  | 'refactor'
  | 'chore'
  | 'docs'
  | 'test'
  | 'infra';

/**
 * Change kind classification for understanding task scope.
 */
export type ChangeKind = 'modify_existing' | 'create_new' | 'mixed';

/**
 * Complexity band classification for task difficulty.
 */
export type ComplexityBand = 'xs' | 's' | 'm' | 'l' | 'xl';

/**
 * Task constraints that affect how the task can be executed.
 */
export interface TaskConstraints {
  /** Whether the task requires strict adherence to a style guide */
  hasStrictStyle?: boolean;

  /** Whether the task has modules/files that must not be touched */
  mustNotTouchX?: boolean;

  /** Whether the task is timeboxed with a deadline */
  timeboxed?: boolean;

  /** Whether the task must be completed without network access */
  noNetAccess?: boolean;
}

/**
 * Task context metadata for routing and evaluation.
 *
 * Describes the nature of the task to enable better model selection,
 * routing decisions, and stratified evaluation.
 */
export interface TaskContext {
  /** Type of task being performed */
  taskType: TaskType;

  /** Whether the task modifies existing code, creates new code, or both */
  changeKind: ChangeKind;

  /** Complexity score (0-1) or band classification */
  complexity: number | ComplexityBand;

  /** Special constraints that apply to this task */
  constraints?: TaskConstraints;

  /** Estimated number of files to be touched */
  filesTouchedEstimate?: number;

  /** Estimated lines of code to be changed */
  expectedLoCChange?: number;

  /** Domain-specific knowledge required (e.g., "payments", "auth", "k8s") */
  requiresDomainKnowledge?: string | boolean;
}

// ────────────────────────────────────────────────────────────────
// Repo Context (HOK-774)
// ────────────────────────────────────────────────────────────────

/**
 * Repository visibility classification.
 */
export type RepoVisibility = 'oss' | 'private';

/**
 * Repository size metrics.
 */
export interface RepoSize {
  /** Total number of files in the repository */
  fileCount: number;

  /** Total lines of code in the repository */
  loc: number;

  /** Number of dependencies (approximate) */
  dependencyCount: number;
}

/**
 * Repository context metadata for routing and evaluation.
 *
 * Describes the repository characteristics to enable better model selection,
 * routing decisions, and stratified evaluation.
 */
export interface RepoContext {
  /** Stable identifier for the repository (hash or slug) */
  repoId: string;

  /** Whether the repository is open source or private */
  repoVisibility: RepoVisibility;

  /** Primary programming language */
  primaryLanguage: string;

  /** Map of language to percentage (e.g., {"TypeScript": 75, "JavaScript": 25}) */
  languages?: Record<string, number>;

  /** Frameworks used in the repository */
  frameworks?: string[];

  /** Build system (e.g., "webpack", "vite", "gradle") */
  buildSystem?: string;

  /** Package manager (e.g., "npm", "yarn", "pnpm") */
  packageManager?: string;

  /** Test frameworks (e.g., ["jest", "vitest"]) */
  testFrameworks?: string[];

  /** CI provider (e.g., "github-actions", "gitlab-ci") */
  ciProvider?: string;

  /** Repository size metrics */
  repoSize?: RepoSize;

  /** Whether the repository is a monorepo */
  monorepo?: boolean;
}

// ────────────────────────────────────────────────────────────────
// Outcome Decomposition (HOK-776)
// ────────────────────────────────────────────────────────────────

/**
 * Status of a single CI check run.
 */
export interface CiCheck {
  /** Check name (e.g. "tests", "lint", "build") */
  name: string;
  /** Check status */
  status: 'success' | 'failure' | 'pending' | 'skipped' | 'cancelled';
  /** Check duration in seconds (if available) */
  durationSeconds?: number;
}

/**
 * CI/CD outcome: whether checks ran and their results.
 */
export interface CiOutcome {
  /** Whether CI checks were triggered for this PR */
  ran: boolean;
  /** Whether all CI checks passed */
  passed: boolean;
  /** Individual check results */
  checks: CiCheck[];
}

/**
 * Test outcome: test additions and results.
 */
export interface TestsOutcome {
  /** Whether new test files were added in this PR */
  added: boolean;
  /** Test pass rate (0-1), if test results are available */
  passRate?: number;
  /** Total test execution time in seconds, if available */
  durationSeconds?: number;
}

/**
 * Static analysis outcome: lint, typecheck, and security findings.
 */
export interface StaticAnalysisOutcome {
  /** Change in lint errors (negative = improvement, positive = regression) */
  lintDelta?: number;
  /** Whether typecheck passed */
  typecheckPassed?: boolean;
  /** Change in security findings (negative = improvement) */
  securityFindingsDelta?: number;
}

/**
 * Review outcome: human review activity on the PR.
 */
export interface ReviewOutcome {
  /** Whether human review was required (any review comments or changes requested) */
  humanReviewRequired: boolean;
  /** Number of distinct review submission rounds */
  rounds: number;
  /** Number of approval reviews */
  approvals: number;
  /** Number of change request reviews */
  changeRequests: number;
}

/**
 * Rework outcome: agent iterations and failures during implementation.
 */
export interface ReworkOutcome {
  /** Number of agent iterations (session turns, commits, or retries) */
  agentIterations: number;
  /** Number of tool/API call failures, if tracked */
  toolFailures?: number;
}

/**
 * Delivery outcome: PR creation, merge status, and timing.
 */
export interface DeliveryOutcome {
  /** Whether a PR was created */
  prCreated: boolean;
  /** Whether the PR was merged */
  merged: boolean;
  /** Time from PR creation to merge in seconds, if merged */
  timeToMergeSeconds?: number;
}

/**
 * Decomposed outcome components for granular eval analysis.
 *
 * Stores the raw outcome data that contributes to the overall score.
 * This enables re-scoring with different utility functions and
 * routing based on outcome patterns.
 */
export interface Outcomes {
  /** Hard gate: whether the task succeeded (derived from score) */
  success: boolean;
  /** CI/CD check results */
  ci?: CiOutcome;
  /** Test additions and results */
  tests?: TestsOutcome;
  /** Static analysis results */
  staticAnalysis?: StaticAnalysisOutcome;
  /** Human review activity */
  review: ReviewOutcome;
  /** Agent rework and failures */
  rework: ReworkOutcome;
  /** PR delivery status */
  delivery: DeliveryOutcome;
}

// ────────────────────────────────────────────────────────────────
// Difficulty Classification (HOK-777)
// ────────────────────────────────────────────────────────────────

/**
 * Difficulty band classification for task complexity.
 *
 * Derived from quantifiable signals (LOC touched, files modified, etc.)
 * to enable weighted rewards and stratified evaluation.
 */
export type DifficultyBand = 'trivial' | 'easy' | 'medium' | 'hard' | 'very_hard';

/**
 * Quantifiable difficulty signals computed from PR data.
 *
 * These metrics are derived from git diff analysis and provide
 * objective measures of task complexity.
 */
export interface DifficultySignals {
  /** Lines of code touched (additions + deletions) */
  locTouched: number;

  /** Number of files modified in the PR */
  filesTouched: number;

  /** Dependency depth (optional - 0 if not computed) */
  dependencyDepth?: number;

  /** Test runtime in seconds (optional) */
  testRuntime?: number;

  /** Module hotspot score 0-100 (optional - based on git history) */
  moduleHotspotScore?: number;

  /** True when diff parsing returned suspicious results (e.g. 0 LOC with files present) */
  diffUncertain?: boolean;
}

/**
 * Tech stack and size stratum for stratified evaluation.
 *
 * Format: "{tech_stack}_{size_band}"
 * Examples: "ts_nextjs_small", "py_django_med", "go_std_large"
 */
export type Stratum = string;

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

  /** Brief description of each human intervention (legacy - prefer interventions field) */
  interventionDetails: string[];

  /** Structured intervention events (machine-usable) */
  interventions?: InterventionRecord[];

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

  /** Agent that produced the work being evaluated (e.g. "claude", "codex") */
  agentType?: string;

  /** Total estimated cost in USD to build the feature (all agent sessions on this branch) */
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

  /** Status of workflow cost computation (HOK-883) */
  workflowCostStatus?: 'success' | 'no_sessions' | 'no_branch' | 'adapter_error' | 'missing_worktree' | 'skipped';

  /** Diagnostic details when workflowCost is missing (HOK-883) */
  workflowCostDiagnostics?: {
    reason: string;
    worktreePath?: string;
    branchName?: string;
    agentType?: string;
    sessionFilesFound?: number;
    matchingTurns?: number;
    totalAssistantTurns?: number;
    branchMismatches?: number;
  };

  /** Difficulty band classification (e.g. "easy", "medium", "hard") */
  difficultyBand?: DifficultyBand;

  /** Quantifiable difficulty metrics from PR analysis */
  difficultySignals?: DifficultySignals;

  /** Tech stack and size stratum (e.g. "ts_nextjs_small", "py_django_med") */
  stratum?: Stratum;

  /** Task context metadata for routing and evaluation (HOK-774) */
  taskContext?: TaskContext;

  /** Repository context metadata for routing and evaluation (HOK-774) */
  repoContext?: RepoContext;

  /** Decomposed outcome components (quality, cost, speed, risk dimensions) */
  outcomes?: Outcomes;

  /** Routing decision metadata (required if training routing models) */
  routingDecision?: RoutingDecision;

  /** Optional extensibility bag for additional metadata */
  metadata?: Record<string, unknown>;
}
