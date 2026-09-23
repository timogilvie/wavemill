/**
 * Tool-decision corpus contract (HOK-2076).
 *
 * Versioned, append-only projection of the canonical native session-event
 * stream ({@link ./session-stream.schema.ts}). One decision row per agentic
 * branch point:
 *   - a tool call (allowed by policy),
 *   - a policy denial (no execution),
 *   - a text-only or think response (no tool call).
 *
 * Rows are read-only training substrate. They are derived deterministically
 * from the source event stream and must never be treated as the source of
 * truth. Any change to the row shape or its semantics requires bumping
 * {@link TOOL_DECISION_SCHEMA_VERSION}.
 *
 * Provenance and propensity semantics are intentionally explicit: every
 * field that could be inferred from a surrogate is tagged. Downstream
 * consumers must not assume causal meaning for a surrogate propensity.
 */

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/** Bump for ANY field/semantics change to a decision row. */
export const TOOL_DECISION_SCHEMA_VERSION = '1';

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/** Kind of decision the agent made this step. */
export type DecisionKind =
  /** Model produced an executable tool call and policy allowed it. */
  | 'tool_call'
  /** Model was forced (single tool) and policy allowed it. */
  | 'forced_tool_call'
  /** Model produced a tool call and policy denied it. */
  | 'policy_denied'
  /** Model produced text only (no tool call). */
  | 'respond'
  /** Model produced only extended-thinking output (no tool call, no text). */
  | 'think';

/**
 * How well we know the propensity/alternatives at this step.
 *
 * `exact`             — provider returned every candidate with per-tool
 *                       probability; treat as a true propensity.
 * `provider_reported` — provider returned a probability/rank for the chosen
 *                       tool only (top-1 style); use for calibration, not
 *                       for causal off-policy lift.
 * `surrogate`         — computed from local features (e.g., prior tool
 *                       cadence, menu size). Never use as causal evidence.
 * `unavailable`       — no propensity information could be reconstructed.
 */
export type PropensityProvenance =
  | 'exact'
  | 'provider_reported'
  | 'surrogate'
  | 'unavailable';

/** Result of executing the chosen tool. `n/a` for `respond`, `think`, and denials. */
export type ToolResultStatus = 'success' | 'error' | 'skipped' | 'n/a';

/** How the outcome join was resolved. */
export type OutcomeJoinStatus = 'joined' | 'unjoinable' | 'pending';

// ---------------------------------------------------------------------------
// Sub-structures
// ---------------------------------------------------------------------------

export interface MenuSnapshot {
  /** Digest of the exact set of tool names the policy exposed this turn. */
  digest: string;
  /** Concrete tool names (bounded; empty means "no tools exposed"). */
  toolNames: string[];
  /** Byte size of the canonical menu representation, if available. */
  byteSize?: number;
  /** Artifact digest, when the menu was stored out-of-band. */
  artifactDigest?: string;
}

export interface ProviderMenuSnapshot {
  /** Digest of the schemas the provider actually received this turn. */
  digest: string;
  /** Count of provider schemas. Names live in artifact if too large. */
  toolCount: number;
  /** Artifact digest, when the provider payload was stored out-of-band. */
  artifactDigest?: string;
}

/** Argument evidence. Raw arguments never appear in rows. */
export interface ArgumentEvidence {
  /** Digest of the canonical JSON of the arguments (bounded). */
  digest?: string;
  /** Short human-readable summary (e.g., "read('src/a.ts')"). */
  summary?: string;
  /** True when arguments were redacted (secrets, credentials, etc.). */
  redacted?: boolean;
  /** Category tags for the redaction (e.g., ["api_key"]). */
  redactionCategories?: string[];
}

/** Bounded execution result evidence. */
export interface ResultEvidence {
  /** Success / error / skipped / n/a. */
  status: ToolResultStatus;
  /** Latency in milliseconds, when known. */
  latencyMs?: number;
  /** Byte size of the result payload (before any artifact cutover). */
  byteSize?: number;
  /** Content-addressed artifact digest, if a large payload was retained. */
  artifactDigest?: string;
  /** Non-secret one-line description of the result. */
  contentSummary?: string;
}

/** Cost / token attribution for the model request that produced this decision. */
export interface CostAttribution {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Total cost in USD (may be zero for locally-hosted models). */
  totalCostUsd?: number;
}

/**
 * Bounded state features sufficient to control for phase, policy, task class,
 * prior error/result state, and resource budget.
 */
export interface StateFeatures {
  /** Total prior tool calls in this trace (before this decision). */
  priorToolCallCount: number;
  /** Whether the prior tool call was an error. */
  priorErrorFlag: boolean;
  /** Count of prior errors in this trace. */
  priorErrorCount: number;
  /** Terminal-synthesis turn (no tools exposed by policy). */
  terminalSynthesis: boolean;
  /** Prior policy denials in this trace. */
  priorPolicyDenials: number;
  /** Turn budget remaining, when known. */
  turnBudgetRemaining?: number;
  /** Tool-call budget remaining, when known. */
  toolCallBudgetRemaining?: number;
}

/**
 * Propensity / alternatives evidence for this decision.
 *
 * `provenance` tells the consumer how much causal weight to give it:
 * only `exact` may participate in causal off-policy estimators.
 */
export interface PropensityEvidence {
  provenance: PropensityProvenance;
  /**
   * Bounded (tool_name → probability) map when `provenance === "exact"` or
   * `"provider_reported"`. Omit for `surrogate` and `unavailable`.
   */
  distribution?: Record<string, number>;
  /**
   * Alternatives that were on the menu but not chosen. Always populated when
   * `menu.toolNames` is non-empty; presence does not imply causal evidence.
   */
  alternatives?: string[];
}

/**
 * Mutation / test / edit evidence. Only bounded references — never diffs
 * or raw test output. Downstream labelers hydrate this from artifacts.
 */
export interface MutationEvidence {
  /** Content-addressed refs to redacted edit hunks, if any. */
  editHunkArtifactDigests?: string[];
  /** Command tool-call IDs that captured commit/test/lint evidence. */
  commandToolCallIds?: string[];
  /** True when a test invocation is linked to this decision. */
  hasTestEvidence?: boolean;
}

/** Outcome join to Wavemill's existing eval/stage/terminal signals. */
export interface OutcomeJoin {
  status: OutcomeJoinStatus;
  /** Feature/issue slug for the record, when known. */
  issue?: string;
  /** Stage score (0–1) at the moment this decision landed. */
  stageScore?: number;
  /** Cumulative interventions on the trace so far. */
  interventionCount?: number;
  /** Terminal eval status (success / failure / aborted / …). */
  terminalStatus?: string;
  /** Commit that carried the effect of this decision, when known. */
  commit?: string;
  /** Reason we could not join, if `status === "unjoinable"`. */
  unjoinableReason?: string;
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

/**
 * One tool-decision row. Every field except the schema/version/id triad is
 * optional in the sense that upstream sources may not report it — the row
 * records what we know AND records that we do not know the rest.
 */
export interface ToolDecisionRow {
  /** Schema version — must equal {@link TOOL_DECISION_SCHEMA_VERSION}. */
  schemaVersion: string;

  /** Deterministic identity — stable across re-projection of the same stream. */
  decisionId: string;

  /** Session identity from the canonical event stream. */
  sessionId: string;
  /** Trace identity (correlates across retries). */
  traceId: string;
  /** Phase (planning, coding, review). */
  phase: string;
  /** 0-indexed turn within the session. */
  turnIndex: number;
  /** Position within the turn's tool-call/response batch (0-indexed). */
  stepIndex: number;

  /** Wavemill session events that produced the row (for auditability). */
  sourceEventIds: string[];

  /** Provider identifier (anthropic, openai, openrouter, …). */
  provider: string;
  /** Concrete model ID sent to the provider. */
  model: string;
  /** Runtime label (e.g., "native"). */
  runtime: string;

  /** Policy-exposed tool menu snapshot (may be empty for terminal-synthesis). */
  toolMenu?: MenuSnapshot;
  /** Provider-sent tool schemas snapshot (may be absent when no menu was sent). */
  providerMenu?: ProviderMenuSnapshot;
  /** Alias for consumers preferring `available_tools`. Always mirrors toolMenu.toolNames. */
  availableTools?: string[];

  /** Kind of decision. */
  kind: DecisionKind;
  /** Chosen tool name (undefined for respond/think). */
  chosenTool?: string;

  /**
   * Policy decision reason. Populated for policy denials, forced tools, or
   * whenever the policy layer attached rationale to an `allow`.
   */
  policyDecision?: {
    decision: 'allow' | 'deny';
    reason?: string;
    policyConfigDigest?: string;
  };

  /** Argument evidence (digest + summary + redaction status). */
  arguments?: ArgumentEvidence;

  /** Result evidence (status/latency/byte size/artifact digest). */
  result?: ResultEvidence;

  /** Cost attribution for this decision's model request. */
  cost?: CostAttribution;

  /** Bounded controllable state features. */
  state: StateFeatures;

  /** Propensity / alternatives evidence with explicit provenance. */
  propensity: PropensityEvidence;

  /** Mutation / test / edit substrate (references only, never bodies). */
  mutationEvidence?: MutationEvidence;

  /** Outcome join (stage/terminal/verification). Filled offline. */
  outcome?: OutcomeJoin;

  /** ISO 8601 or ms-since-epoch timestamp of the underlying model request. */
  timestamp: string | number;

  /**
   * Causal event IDs from the source stream that fed into this decision
   * (model_request, tool_menu, provider_tools, tool_call, tool_result, …).
   */
  causalEventIds: string[];
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export class ToolDecisionParseError extends Error {
  readonly line: string;
  readonly lineNumber: number;

  constructor(message: string, line: string, lineNumber: number) {
    super(message);
    this.name = 'ToolDecisionParseError';
    this.line = line;
    this.lineNumber = lineNumber;
  }
}

const REQUIRED_KEYS: readonly (keyof ToolDecisionRow)[] = [
  'schemaVersion',
  'decisionId',
  'sessionId',
  'traceId',
  'phase',
  'turnIndex',
  'stepIndex',
  'sourceEventIds',
  'provider',
  'model',
  'runtime',
  'kind',
  'state',
  'propensity',
  'timestamp',
  'causalEventIds',
];

const ALLOWED_KINDS: readonly DecisionKind[] = [
  'tool_call',
  'forced_tool_call',
  'policy_denied',
  'respond',
  'think',
];

const ALLOWED_PROPENSITY_PROVENANCE: readonly PropensityProvenance[] = [
  'exact',
  'provider_reported',
  'surrogate',
  'unavailable',
];

/**
 * Validate a raw JSON value as a ToolDecisionRow. Returns `null` on shape
 * violation with a reason string; returns the typed row when it validates.
 *
 * The validator is intentionally strict about required primitives and
 * enum coverage, but tolerant of unknown extra fields (forward compatibility).
 */
export type ToolDecisionValidation =
  | { ok: true; row: ToolDecisionRow; reason?: undefined }
  | { ok: false; row?: undefined; reason: string };

export function validateToolDecisionRow(value: unknown): ToolDecisionValidation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'not_an_object' };
  }
  const record = value as Record<string, unknown>;

  for (const key of REQUIRED_KEYS) {
    if (!(key in record)) {
      return { ok: false, reason: `missing_field:${key}` };
    }
  }

  if (record.schemaVersion !== TOOL_DECISION_SCHEMA_VERSION) {
    return { ok: false, reason: `schema_version_mismatch:${String(record.schemaVersion)}` };
  }

  const kind = record.kind;
  if (typeof kind !== 'string' || !ALLOWED_KINDS.includes(kind as DecisionKind)) {
    return { ok: false, reason: `bad_kind:${String(kind)}` };
  }

  const propensity = record.propensity;
  if (propensity === null || typeof propensity !== 'object' || Array.isArray(propensity)) {
    return { ok: false, reason: 'bad_propensity' };
  }
  const propProvenance = (propensity as Record<string, unknown>).provenance;
  if (
    typeof propProvenance !== 'string' ||
    !ALLOWED_PROPENSITY_PROVENANCE.includes(propProvenance as PropensityProvenance)
  ) {
    return { ok: false, reason: `bad_propensity_provenance:${String(propProvenance)}` };
  }

  const state = record.state;
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    return { ok: false, reason: 'bad_state' };
  }
  const stateRec = state as Record<string, unknown>;
  if (typeof stateRec.priorToolCallCount !== 'number') {
    return { ok: false, reason: 'bad_state.priorToolCallCount' };
  }
  if (typeof stateRec.terminalSynthesis !== 'boolean') {
    return { ok: false, reason: 'bad_state.terminalSynthesis' };
  }

  if (!Array.isArray(record.sourceEventIds)) {
    return { ok: false, reason: 'bad_sourceEventIds' };
  }
  if (!Array.isArray(record.causalEventIds)) {
    return { ok: false, reason: 'bad_causalEventIds' };
  }

  return { ok: true, row: record as unknown as ToolDecisionRow };
}

/**
 * Parse a JSONL corpus into typed rows. Skips blank lines. Fails fast on
 * malformed JSON. Rejects rows that fail {@link validateToolDecisionRow}.
 */
export function parseToolDecisionJsonl(content: string): ToolDecisionRow[] {
  const lines = content.split('\n');
  const rows: ToolDecisionRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new ToolDecisionParseError(
        `Malformed JSONL at line ${i + 1}: ${line.slice(0, 80)}`,
        line,
        i + 1,
      );
    }
    const check = validateToolDecisionRow(parsed);
    if (!check.ok) {
      throw new ToolDecisionParseError(
        `Invalid decision row at line ${i + 1}: ${check.reason}`,
        line,
        i + 1,
      );
    }
    rows.push(check.row);
  }
  return rows;
}
