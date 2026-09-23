/**
 * Tool-decision corpus schema (HOK-2076).
 *
 * Provider-independent, append-only decision rows projected from the
 * canonical P0 session event stream. Each row represents one agentic
 * branch point: tool call, forced single-tool call, policy denial,
 * or text-only response.
 *
 * @module tool-decision-schema
 */

export const TOOL_DECISION_SCHEMA_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Propensity provenance
// ---------------------------------------------------------------------------

export type PropensitySource =
  | 'exact'
  | 'provider_reported'
  | 'surrogate'
  | 'unavailable';

export interface PropensityRecord {
  source: PropensitySource;
  value?: number;
  alternatives?: string[];
}

// ---------------------------------------------------------------------------
// Decision kind
// ---------------------------------------------------------------------------

export type DecisionKind =
  | 'tool_call'
  | 'forced_single_tool'
  | 'policy_denial'
  | 'text_only'
  | 'think';

// ---------------------------------------------------------------------------
// Policy outcome
// ---------------------------------------------------------------------------

export type PolicyOutcome = 'allow' | 'deny' | 'not_evaluated';

// ---------------------------------------------------------------------------
// Result status
// ---------------------------------------------------------------------------

export type ResultStatus = 'success' | 'error' | 'skipped' | 'pending' | 'not_applicable';

// ---------------------------------------------------------------------------
// Menu reference
// ---------------------------------------------------------------------------

export interface MenuReference {
  digest: string;
  toolNames?: string[];
  toolCount: number;
  artifactRef?: {
    digest: string;
    path: string;
  };
  availability: 'available' | 'digest_only' | 'unavailable';
}

// ---------------------------------------------------------------------------
// Mutation substrate
// ---------------------------------------------------------------------------

export interface MutationEvidence {
  commandType?: string;
  commandSummary?: string;
  isError: boolean;
  outcomeSummary?: string;
  artifactRef?: { digest: string; path: string };
}

// ---------------------------------------------------------------------------
// State features (bounded context for controlling confounds)
// ---------------------------------------------------------------------------

export interface StateFeatures {
  phase: string;
  turnIndex: number;
  stepIndex: number;
  toolCallsInTurn: number;
  priorErrorInTurn: boolean;
  contextTokens?: number;
}

// ---------------------------------------------------------------------------
// Token/cost attribution
// ---------------------------------------------------------------------------

export interface TokenAttribution {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

// ---------------------------------------------------------------------------
// The decision row
// ---------------------------------------------------------------------------

export interface ToolDecisionRow {
  schemaVersion: string;

  // Stable IDs
  sessionId: string;
  traceId: string;
  phase: string;
  turnIndex: number;
  stepIndex: number;

  // Runtime identity
  model: string;
  provider: string;

  // Menus
  policyMenu: MenuReference | null;
  providerMenu: MenuReference | null;

  // Decision
  decisionKind: DecisionKind;
  chosenTool: string | null;
  chosenToolProvider: string | null;
  policyOutcome: PolicyOutcome;
  denialReason?: string;

  // Arguments and results
  argumentsDigest?: string;
  resultStatus: ResultStatus;
  latencyMs?: number;
  isError: boolean;

  // Token/cost
  turnUsage: TokenAttribution | null;

  // Causal links
  requestEventId: string;
  responseEventId?: string;
  toolCallEventId?: string;
  toolResultEventId?: string;
  causedByEventId?: string;

  // State features
  stateFeatures: StateFeatures;

  // Propensity
  propensity: PropensityRecord;

  // Mutation substrate
  mutationEvidence: MutationEvidence[];

  // Redaction
  redacted: boolean;
  redactionSummary?: string;

  // Timestamps
  timestamp: string | number;
  endTimestamp?: string | number;
}

// ---------------------------------------------------------------------------
// Outcome join (Phase 3 — separate from captured rows)
// ---------------------------------------------------------------------------

export const OUTCOME_LABEL_VERSION = '1.0.0';

export type OutcomeJoinConfidence =
  | 'exact'
  | 'session_match'
  | 'timestamp_window'
  | 'unavailable';

export interface StageOutcome {
  stageName: string;
  status?: string;
  score?: number;
  costUsd?: number;
  interventionCount: number;
}

export interface TerminalOutcome {
  evalScore?: number;
  merged: boolean;
  reverted: boolean;
  ciPassed?: boolean;
  reviewPassed?: boolean;
}

export interface SurvivalLabel {
  reversionDetected: boolean;
  survivalRatio?: number;
  humanUndo: boolean;
  agentUndo: boolean;
  eligibleForSurvival: boolean;
}

export interface TestDelta {
  beforeFailures?: number;
  afterFailures?: number;
  delta?: number;
  comparable: boolean;
}

export interface OutcomeLabel {
  labelVersion: string;
  normalizationVersion: string;
  joinConfidence: OutcomeJoinConfidence;
  stageOutcome: StageOutcome | null;
  terminalOutcome: TerminalOutcome | null;
  survivalLabel: SurvivalLabel | null;
  testDelta: TestDelta | null;
  localResultStatus: ResultStatus;
}

// ---------------------------------------------------------------------------
// Labeled decision row (captured row + derived labels)
// ---------------------------------------------------------------------------

export interface LabeledDecisionRow {
  decision: ToolDecisionRow;
  outcome: OutcomeLabel;
}
