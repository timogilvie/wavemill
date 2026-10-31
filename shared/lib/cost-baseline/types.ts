/**
 * Shared types for the MQ-0.1 cost-per-task baseline (HOK-3336).
 *
 * The baseline is a read-only, one-off analysis over data wavemill already
 * writes: `.wavemill/evals/evals.jsonl`, the merge-lane progress files, the
 * label-write ledger, state-archive tombstones and archived stage results.
 * Every derived number carries the explicit start/end boundary it was measured
 * between, so the report never repeats HOK-2895 (a wall-clock that silently
 * included queue idle).
 *
 * @module cost-baseline/types
 */

/** How much of a dimension's input was present for one task. */
export type Coverage = 'full' | 'partial' | 'missing';

/** One measured value plus the boundary it was measured between. */
export interface DimResult {
  /** Seconds, dollars or a count, depending on the dimension; null when unmeasurable. */
  value: number | null;
  /** Start boundary (ISO timestamp or a named event) — null when not timestamped. */
  start: string | null;
  /** End boundary (ISO timestamp or a named event) — null when not timestamped. */
  end: string | null;
  coverage: Coverage;
  notes: string[];
}

/** Inclusive analysis window. */
export interface BaselineWindow {
  since: string;
  until: string;
}

/** Token usage of one session, as recorded by the cost engine. */
export interface SessionTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * One agent session of a task, reduced from
 * `evals.jsonl.executionEconomics[].sessions[]`. Only the fields the baseline
 * reads are kept so a 78 MB corpus does not pin per-turn arrays in memory.
 */
export interface BaselineSession {
  sessionId: string;
  harness: string | null;
  /**
   * Ownership kind (`planning | coding | review | ready-remediation |
   * conflict-resolution | ci-fix | native-arm | helper:<purpose> | operator`)
   * read from the eval's stage label; `unattributed` when the record names none.
   */
  kind: string;
  /** Stage-label confidence as recorded (`launch_record`, `unowned`, ...). */
  confidence: string | null;
  /**
   * The launch the ownership row names (`launch coding@<head>#<epoch> at ...`),
   * used to tell a second coding launch from a second session of one launch.
   */
  launchEvidence: string | null;
  /** Provider charge when known, else the cost engine's local estimate; null when unpriced. */
  costUsd: number | null;
  costSource: string | null;
  firstTurnAt: string | null;
  lastTurnAt: string | null;
  turnCount: number;
  tokens: SessionTokens;
}

export interface BaselineCiCheck {
  name: string;
  status: string;
  durationSeconds: number | null;
}

/** `.wavemill/merge-lane/<pr>/progress.json`. */
export interface LaneProgress {
  prNumber: number;
  enteredLaneAt: string | null;
  lastProgressAt: string | null;
  lastEvent: string | null;
  laneHoldSeconds: number | null;
  mergeAttemptCount: number | null;
  rebaseCount: number | null;
  ciRestartCount: number | null;
}

/** One row of `.wavemill/label-writes.jsonl`. */
export interface LabelEvent {
  at: string;
  prNumber: number;
  label: string;
  action: 'labeled' | 'unlabeled';
}

/**
 * A PR's GitHub state (`gh pr list --json number,state,mergedAt,closedAt`).
 * Labels persist on merged and closed PRs, so the ledger alone cannot say
 * when a PR still labelled `wm:ready` left the queue.
 */
export interface PrState {
  prNumber: number;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  mergedAt: string | null;
  closedAt: string | null;
}

/** One finding of an archived review iteration. */
export interface BaselineReviewFinding {
  location: string;
  severity: string;
}

/** One `reviewIterations[]` entry of an archived `.review-result.json`. */
export interface BaselineReviewIteration {
  iteration: number;
  recordedAt: string | null;
  verdict: string | null;
  findings: BaselineReviewFinding[];
  filesChanged: string[] | null;
}

/** The archived review stage result, reduced to what round counting reads. */
export interface ArchivedReview {
  /** `artifacts.iterations` — self-review tool iterations of the final review run. */
  iterations: number | null;
  /** `artifacts.reviewIterations[]` (HOK-2969); null when the artifact predates it. */
  reviewIterations: BaselineReviewIteration[] | null;
}

/** The joined per-task input the dimension functions read. */
export interface BaselineTask {
  issueId: string;
  isChallenger: boolean;
  evalTimestamp: string;
  prNumber: number | null;
  workflowCost: number | null;
  workflowCostStatus: string | null;
  phaseDurations: { planning?: number; coding?: number; review?: number; total?: number };
  /** GitHub PR createdAt → mergedAt, as collected by the eval outcome collector. */
  timeToMergeSeconds: number | null;
  ciChecks: BaselineCiCheck[];
  ciPassed: boolean | null;
  sessions: BaselineSession[];
  lane: LaneProgress | null;
  labelEvents: LabelEvent[];
  review: ArchivedReview | null;
  /** GitHub state of the PR when fetched (`--fetch-pr-state`), else null. */
  prState: PrState | null;
}

/** Counts the loader reports so the cohort section can state what was dropped. */
export interface CohortCounts {
  /** Eval rows inside the window (any outcome). */
  evalRowsInWindow: number;
  /** Merged eval rows inside the window, before per-issue de-duplication. */
  mergedRows: number;
  /** Merged rows dropped because a later row for the same issue exists. */
  duplicateRowsCollapsed: number;
  /** Unparseable JSONL lines skipped. */
  malformedLines: number;
  /** Tombstones in the window grouped by `workflowOutcome`. */
  tombstonesByOutcome: Record<string, number>;
}

export interface LoadedBaseline {
  window: BaselineWindow;
  tasks: BaselineTask[];
  counts: CohortCounts;
  /** All label-ledger rows (every PR), for queue depth. */
  labelEvents: LabelEvent[];
  /** All lane progress rows (every PR), for queue depth. */
  laneProgress: LaneProgress[];
  /** GitHub PR states, keyed by number; empty unless fetched. */
  prStates: Map<number, PrState>;
}

/** Dollar decomposition of one task's agent spend. */
export interface CostBuckets {
  /** Planning + the first coding launch (+ native arms, non-review helpers). */
  authoring: number;
  /** Review stage sessions, review helpers, and coding launches after the first. */
  reviewLoop: number;
  /** Conflict resolution, Ready remediation and CI-fix sessions. */
  repairLoop: number;
  /** Sessions the eval record could not attribute to a stage. */
  unattributed: number;
}

/** Everything the baseline derives for one task. */
export interface TaskDimensions {
  costBuckets: CostBuckets;
  /** Σ costBuckets — task agent spend excluding operator and shared sessions. */
  agentCost: DimResult;
  /** CI compute minutes priced at the stated rate (list-price equivalent). */
  ciCost: DimResult;
  authoringWallClock: DimResult;
  reviewWallClock: DimResult;
  repairWallClock: DimResult;
  ciCriticalPath: DimResult;
  ciComputeMinutes: DimResult;
  queueWait: DimResult;
  mergeExecution: DimResult;
  endToEnd: DimResult;
  reviewLoop: ReviewLoopMetrics;
  integrationFailures: IntegrationFailureCounts;
  /** Sessions excluded from task cost, with the reason. */
  excludedSessions: { operator: number; shared: number; unpriced: number; operatorUsd: number; sharedUsd: number };
}

export interface ReviewLoopMetrics {
  /** Review rounds, from the best available source (see `roundsSource`). */
  rounds: number | null;
  roundsSource: 'review-iterations' | 'artifact-iterations' | 'review-helper-sessions' | 'review-launches' | 'none';
  /** Distinct review stage launches; null when review sessions name no launch. */
  reviewLaunches: number | null;
  /** Coding launches after the first (author ↔ reviewer re-code cycles). */
  recodeRounds: number | null;
  /** File-level attribution of review findings (HOK-2969 artifacts only). */
  findings: { total: number; onChangedFiles: number; onUnchangedFiles: number; unresolvable: number } | null;
}

export interface IntegrationFailureCounts {
  /** `mergeAttemptCount - 1` from the lane (failed merge attempts before the merge). */
  failedMergeAttempts: number | null;
  rebases: number | null;
  ciRestarts: number | null;
  /** `wm:merging` applications that did not end in a merge (label ledger). */
  ejections: number | null;
  /** `wm:blocked` applications after the PR first became ready (label ledger). */
  blockedAfterReady: number | null;
  conflictResolutionLaunches: number;
  readyRemediationLaunches: number;
  ciFixLaunches: number;
}

export interface BaselineTaskRow {
  issueId: string;
  isChallenger: boolean;
  prNumber: number | null;
  evalTimestamp: string;
  dimensions: TaskDimensions;
}
