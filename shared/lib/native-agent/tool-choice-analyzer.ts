/**
 * Tool-choice signal analyzer (HOK-2080).
 *
 * Offline, reproducible analysis pipeline over the HOK-2076 native
 * tool-decision corpus:
 *   1. tolerant corpus loading with schema-adherence accounting,
 *   2. eval-outcome joining via session-id → (issue, challenge-side) parsing,
 *   3. pre-registered data-quality gates (G1–G4),
 *   4. confounder-adjusted signal estimation separated by propensity
 *      provenance tier — observational estimators for every tier, IPW/AIPW
 *      restricted to `exact` per the schema's causal-use contract,
 *   5. a mechanical Go/No-go/Inconclusive recommendation and the markdown
 *      report consumed by `tools/tool-choice-analysis.ts`.
 *
 * Determinism contract: filesystem access is confined to the two loaders,
 * the bootstrap uses a seeded PRNG, and every histogram/sort is keyed so
 * re-runs with the same inputs produce byte-identical reports.
 *
 * The module deliberately runs honestly on thin data: when the pre-registered
 * coverage gates fail, estimation is suppressed and the recommendation is
 * Inconclusive with a quantified minimum-capture specification — the pipeline
 * never manufactures a signal.
 */

import { existsSync, readFileSync } from 'node:fs';

import { fitLogisticRegression, wilsonInterval } from '../stats-utils.ts';
import {
  TOOL_DECISION_SCHEMA_VERSION,
  validateToolDecisionRow,
  type DecisionKind,
  type PropensityProvenance,
  type ToolDecisionRow,
} from './tool-decision-schema.ts';

// ---------------------------------------------------------------------------
// Pre-registered gates and thresholds
// ---------------------------------------------------------------------------

/**
 * Decision-gate constants, pre-registered before any results were inspected.
 * They are printed verbatim in the report's Methodology section and applied
 * mechanically by {@link deriveRecommendation}. Overrides exist for unit
 * tests on small fixtures; production runs use the defaults.
 */
export const TOOL_CHOICE_GATES = {
  /** G1: minimum schema-valid coding-stage rows of kind tool_call/forced_tool_call. */
  minCodingToolRows: 500,
  /** G2: minimum share of the G1 cohort that must join an eval outcome. */
  minJoinRatePct: 60,
  /** G2: minimum distinct models among joined coding rows. */
  minJoinedModels: 3,
  /** G2: minimum distinct sessions among joined coding rows. */
  minJoinedSessions: 20,
  /** G3: minimum share of joined coding rows carrying a toolMenu digest. */
  minMenuDigestCoveragePct: 90,
  /** G3: minimum availableTools↔toolMenu.toolNames mirror consistency. */
  minMenuMirrorPct: 99,
  /** G4: minimum joined rows before a provenance tier may be reported. */
  minTierJoinedRows: 200,
  /** Pre-registered binary success threshold on the joined eval score. */
  successThreshold: 0.8,
  /** Time-ordered holdout split: first N% train, the rest holdout. */
  holdoutTrainPct: 70,
  /** 90% z for holdout reproduction (S2). */
  holdoutZ: 1.645,
  /** 95% z for primary estimates (S1). */
  primaryZ: 1.96,
  /** Cluster-bootstrap replicates per tier. */
  bootstrapReplicates: 200,
  /** Bootstrap / off-policy minimum rows (below this: skip with a note). */
  bootstrapMinRows: 25,
  /** Cells below this size are flagged small in contrast tables. */
  smallCellFloor: 25,
  /** Default PRNG seed so default runs are reproducible. */
  defaultSeed: 20_260_923,
} as const;

export type GateThresholds = typeof TOOL_CHOICE_GATES;

function resolveGates(overrides?: Partial<GateThresholds>): GateThresholds {
  return { ...TOOL_CHOICE_GATES, ...(overrides ?? {}) };
}

const TOOL_KINDS: readonly DecisionKind[] = ['tool_call', 'forced_tool_call'];
const TIER_ORDER: readonly PropensityProvenance[] = [
  'exact',
  'provider_reported',
  'surrogate',
  'unavailable',
];
const EXAMPLE_LIMIT = 3;
const EXCERPT_LENGTH = 80;
const PRIMARY_ITERATIONS = 2500;
const SENSITIVITY_ITERATIONS = 1200;
const BOOTSTRAP_ITERATIONS = 600;
const MAX_CONTRAST_ROWS = 20;
/** Sort-safe sentinel for missing eval timestamps (far below any real epoch-ms). */
const MISSING_TIMESTAMP_MS = -8_640_000_000_000_000;

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function pct(part: number, total: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return null;
  return (part / total) * 100;
}

function rate(part: number, total: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return null;
  return part / total;
}

function fmtPct(value: number | null | undefined, digits = 1): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${round(value, digits)}%`
    : 'n/a';
}

function fmtNum(value: number | null | undefined, digits = 4): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? String(round(value, digits))
    : 'n/a';
}

function sortedCounts(counts: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of [...counts.keys()].sort()) {
    out[key] = counts.get(key) ?? 0;
  }
  return out;
}

function addTo(map: Map<string, number>, key: string, delta = 1): void {
  map.set(key, (map.get(key) ?? 0) + delta);
}

function addExample(examples: string[], value: string): void {
  if (examples.length < EXAMPLE_LIMIT) examples.push(value);
}

export function normalizeTimestampMs(value: string | number | undefined | null): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value !== '') {
    if (/^\d+$/.test(value)) {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : null;
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/** Compare model ids ignoring an optional `provider/` prefix. */
export function normalizeModelId(model: string | undefined): string | undefined {
  if (typeof model !== 'string' || model.trim() === '') return undefined;
  const trimmed = model.trim();
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

// ---------------------------------------------------------------------------
// Corpus loading (tolerant)
// ---------------------------------------------------------------------------

export interface CorpusLineIssue {
  lineNumber: number;
  reason: string;
  excerpt: string;
}

export interface DuplicateDecision {
  decisionId: string;
  lineNumber: number;
}

export interface CorpusRowEntry {
  row: ToolDecisionRow;
  /** 1-based line number in the corpus file. */
  lineNumber: number;
  /** False for leniently-recovered rows that failed schema validation. */
  schemaValid: boolean;
}

export interface CorpusLoadResult {
  path: string;
  fileMissing: boolean;
  /** Non-blank lines seen. */
  totalLines: number;
  /** Schema-valid rows (duplicates by decisionId excluded). */
  rows: ToolDecisionRow[];
  /** Lenient casts of schema-invalid lines that still carry a sessionId. */
  invalidRows: ToolDecisionRow[];
  /** Every join candidate (valid + lenient) in file order. */
  entries: CorpusRowEntry[];
  malformed: CorpusLineIssue[];
  duplicates: DuplicateDecision[];
}

function asLenientRow(value: unknown): ToolDecisionRow | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.sessionId !== 'string' || record.sessionId === '') return null;
  return value as ToolDecisionRow;
}

/**
 * Load a tool-decision corpus JSONL tolerantly. Malformed JSON and rows that
 * fail {@link validateToolDecisionRow} are counted (with line numbers and a
 * short excerpt) instead of throwing; duplicate decisionIds are reported and
 * excluded from `rows` so the analysis never double-counts a decision.
 * Schema-invalid lines that still carry a usable sessionId are recovered
 * leniently into `invalidRows` so they still participate in join-rate
 * accounting (they are real corpus records for join purposes).
 */
export function loadCorpusTolerant(path: string): CorpusLoadResult {
  const result: CorpusLoadResult = {
    path,
    fileMissing: false,
    totalLines: 0,
    rows: [],
    invalidRows: [],
    entries: [],
    malformed: [],
    duplicates: [],
  };
  if (!existsSync(path)) {
    result.fileMissing = true;
    return result;
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    // Unreadable content is treated as absent rather than fatal: an empty
    // corpus is itself a reportable data-quality finding.
    result.fileMissing = true;
    return result;
  }
  const seen = new Set<string>();
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    result.totalLines += 1;
    const lineNumber = i + 1;
    const excerpt = line.slice(0, EXCERPT_LENGTH);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      result.malformed.push({ lineNumber, reason: 'malformed_json', excerpt });
      continue;
    }
    const check = validateToolDecisionRow(parsed);
    if (!check.ok) {
      result.malformed.push({ lineNumber, reason: check.reason, excerpt });
      const lenient = asLenientRow(parsed);
      if (lenient) {
        result.invalidRows.push(lenient);
        result.entries.push({ row: lenient, lineNumber, schemaValid: false });
      }
      continue;
    }
    if (seen.has(check.row.decisionId)) {
      result.duplicates.push({ decisionId: check.row.decisionId, lineNumber });
      continue;
    }
    seen.add(check.row.decisionId);
    result.rows.push(check.row);
    result.entries.push({ row: check.row, lineNumber, schemaValid: true });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Eval outcome index
// ---------------------------------------------------------------------------

export interface EvalOutcomeRecord {
  id: string;
  lineNumber: number;
  rawIssueId?: string;
  /** issueId with a trailing `_c` challenger suffix stripped. */
  normalizedIssue: string;
  challengeSide: 'primary' | 'challenger';
  /** True when the side was derived from a literal `_c` issueId suffix. */
  sideFromIssueSuffix: boolean;
  modelId?: string;
  score?: number;
  /** Explicit outcomes.success boolean when the eval record carries one. */
  outcomesSuccess?: boolean;
  interventionRequired?: boolean;
  interventionCount?: number;
  taskType?: string;
  timestamp?: string;
  timestampMs: number;
}

export interface EvalOutcomeIndex {
  path: string;
  fileMissing: boolean;
  totalLines: number;
  records: EvalOutcomeRecord[];
  malformed: number;
  withoutIssueId: number;
  /** Eval rows whose issueId literally carried the `_c` challenger suffix. */
  literalSuffixNormalizations: number;
  byKey: Map<string, EvalOutcomeRecord[]>;
}

function evalKey(issue: string, side: 'primary' | 'challenger'): string {
  return `${issue}|${side}`;
}

function extractOutcomesSuccess(record: Record<string, unknown>): boolean | undefined {
  const outcomes = record.outcomes;
  if (outcomes === null || typeof outcomes !== 'object' || Array.isArray(outcomes)) {
    return undefined;
  }
  const success = (outcomes as Record<string, unknown>).success;
  return typeof success === 'boolean' ? success : undefined;
}

function extractTaskType(record: Record<string, unknown>): string | undefined {
  const taskContext = record.taskContext;
  if (taskContext === null || typeof taskContext !== 'object' || Array.isArray(taskContext)) {
    return undefined;
  }
  const taskType = (taskContext as Record<string, unknown>).taskType;
  return typeof taskType === 'string' && taskType !== '' ? taskType : undefined;
}

/**
 * Minimal tolerant parse of an evals JSONL file. Only the fields the analyzer
 * needs are extracted (issue identity, challenge side, model, score,
 * intervention signals, task type, timestamp); everything else is ignored and
 * bad lines are counted rather than thrown.
 */
export function loadEvalOutcomes(path: string): EvalOutcomeIndex {
  const index: EvalOutcomeIndex = {
    path,
    fileMissing: false,
    totalLines: 0,
    records: [],
    malformed: 0,
    withoutIssueId: 0,
    literalSuffixNormalizations: 0,
    byKey: new Map(),
  };
  if (!existsSync(path)) {
    index.fileMissing = true;
    return index;
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    index.fileMissing = true;
    return index;
  }
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    index.totalLines += 1;
    const lineNumber = i + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      index.malformed += 1;
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      index.malformed += 1;
      continue;
    }
    const record = parsed as Record<string, unknown>;
    const issueId = typeof record.issueId === 'string' ? record.issueId : undefined;
    if (!issueId) {
      index.withoutIssueId += 1;
      continue;
    }
    let side: 'primary' | 'challenger' | undefined;
    if (record.challengeSide === 'primary' || record.challengeSide === 'challenger') {
      side = record.challengeSide;
    }
    let normalizedIssue = issueId;
    let sideFromSuffix = false;
    if (/_c$/.test(issueId)) {
      normalizedIssue = issueId.replace(/_c$/, '');
      index.literalSuffixNormalizations += 1;
      if (!side) {
        side = 'challenger';
        sideFromSuffix = true;
      }
    }
    if (normalizedIssue === '') {
      index.withoutIssueId += 1;
      continue;
    }
    const timestamp = typeof record.timestamp === 'string' ? record.timestamp : undefined;
    const outcome: EvalOutcomeRecord = {
      id: typeof record.id === 'string' && record.id !== '' ? record.id : `line:${lineNumber}`,
      lineNumber,
      rawIssueId: issueId,
      normalizedIssue,
      challengeSide: side ?? 'primary',
      sideFromIssueSuffix: sideFromSuffix,
      modelId:
        typeof record.modelId === 'string' && record.modelId !== ''
          ? record.modelId
          : undefined,
      score:
        typeof record.score === 'number' && Number.isFinite(record.score)
          ? record.score
          : undefined,
      outcomesSuccess: extractOutcomesSuccess(record),
      interventionRequired:
        typeof record.interventionRequired === 'boolean'
          ? record.interventionRequired
          : undefined,
      interventionCount:
        typeof record.interventionCount === 'number' && Number.isFinite(record.interventionCount)
          ? record.interventionCount
          : undefined,
      taskType: extractTaskType(record),
      timestamp,
      timestampMs: normalizeTimestampMs(timestamp) ?? MISSING_TIMESTAMP_MS,
    };
    index.records.push(outcome);
    const key = evalKey(outcome.normalizedIssue, outcome.challengeSide);
    const bucket = index.byKey.get(key);
    if (bucket) bucket.push(outcome);
    else index.byKey.set(key, [outcome]);
  }
  return index;
}

// ---------------------------------------------------------------------------
// Session-id parsing and outcome joining
// ---------------------------------------------------------------------------

const SESSION_ID_PATTERN = /^(.+)-(planning|coding|review)-(.+)$/;

export interface SessionIdParse {
  ok: boolean;
  phase?: 'planning' | 'coding' | 'review';
  issue?: string;
  side?: 'primary' | 'challenger';
  reason?: string;
}

/**
 * Parse the launch-time native session naming:
 * `${session}-planning-${issue}` / `${session}-coding-${issue}` (see
 * launch-planning.ts / launch-coding.ts) and `${session}-review-${safeBranch}`
 * (see review.ts). A trailing `_c` on the issue slot marks the challenger
 * side of a challenge pair (the orchestrator keys challenger state as
 * `<issue>_c`). Review sessions are keyed by branch, so no issue can be
 * recovered from them by construction.
 */
export function parseDecisionSessionId(sessionId: string): SessionIdParse {
  const match = SESSION_ID_PATTERN.exec(sessionId);
  if (!match) {
    return { ok: false, reason: 'unrecognized_session_id' };
  }
  const sessionPrefix = match[1];
  const phase = match[2] as 'planning' | 'coding' | 'review';
  const tail = match[3];
  if (phase === 'review') {
    return { ok: true, phase, reason: 'review_session_branch_keyed' };
  }
  const challenger = tail.endsWith('_c') || sessionPrefix.endsWith('_c');
  const issue = tail.endsWith('_c') ? tail.slice(0, -2) : tail;
  if (issue === '') {
    return { ok: false, reason: 'empty_issue_slot' };
  }
  return {
    ok: true,
    phase,
    issue,
    side: challenger ? 'challenger' : 'primary',
  };
}

export type JoinStatus =
  | 'joined'
  | 'unjoinable_by_construction'
  | 'unjoinable_missing_eval'
  | 'unjoinable_ambiguous';

export interface JoinedDecision {
  decisionId: string;
  lineNumber: number;
  schemaValid: boolean;
  row: ToolDecisionRow;
  joinStatus: JoinStatus;
  joinReason?: string;
  issue?: string;
  challengeSide?: 'primary' | 'challenger';
  evalRecord?: EvalOutcomeRecord;
  /** True when the joined eval record's model matched the row's model. */
  modelMatched?: boolean;
  /** Binary pre-registered outcome (eval score >= threshold, or explicit outcomes.success). */
  success?: boolean;
  interventionRequired?: boolean;
  interventionCount?: number;
  taskType?: string;
  timestampMs: number | null;
}

export interface JoinDiagnostics {
  candidates: number;
  joined: number;
  joinedPct: number | null;
  byConstruction: number;
  missingEval: number;
  ambiguous: number;
  modelMismatched: number;
  reviewSessions: number;
  unparsedSessionIds: number;
  examples: {
    byConstruction: string[];
    missingEval: string[];
    ambiguous: string[];
  };
}

export interface JoinResult {
  decisions: JoinedDecision[];
  diagnostics: JoinDiagnostics;
}

/**
 * Mirrors the eval success policy (shared/lib/eval-success-policy.ts):
 * explicit `outcomes.success` wins, then `score >= threshold`, else false.
 * Implemented locally with an injected threshold so this module stays free
 * of config/filesystem reads and remains unit-testable in isolation.
 */
function evalSuccess(record: EvalOutcomeRecord, threshold: number): boolean {
  if (typeof record.outcomesSuccess === 'boolean') return record.outcomesSuccess;
  if (typeof record.score === 'number' && Number.isFinite(record.score)) {
    return record.score >= threshold;
  }
  return false;
}

export interface JoinOptions {
  successThreshold?: number;
}

/**
 * Join every corpus entry (schema-valid and leniently recovered) to an eval
 * outcome record keyed by (normalized issue, challenge side), preferring a
 * model match and then the latest timestamp. Ambiguity — multiple candidate
 * evals with no model match — is reported rather than guessed.
 */
export function joinOutcomes(
  load: CorpusLoadResult,
  index: EvalOutcomeIndex,
  options: JoinOptions = {},
): JoinResult {
  const threshold = options.successThreshold ?? TOOL_CHOICE_GATES.successThreshold;
  const diagnostics: JoinDiagnostics = {
    candidates: 0,
    joined: 0,
    joinedPct: null,
    byConstruction: 0,
    missingEval: 0,
    ambiguous: 0,
    modelMismatched: 0,
    reviewSessions: 0,
    unparsedSessionIds: 0,
    examples: { byConstruction: [], missingEval: [], ambiguous: [] },
  };
  const decisions: JoinedDecision[] = [];
  for (const entry of load.entries) {
    diagnostics.candidates += 1;
    const row = entry.row;
    const base: JoinedDecision = {
      decisionId:
        typeof row.decisionId === 'string' && row.decisionId !== ''
          ? row.decisionId
          : `line:${entry.lineNumber}`,
      lineNumber: entry.lineNumber,
      schemaValid: entry.schemaValid,
      row,
      joinStatus: 'unjoinable_missing_eval',
      timestampMs: normalizeTimestampMs(row.timestamp),
    };
    const parse = parseDecisionSessionId(row.sessionId);
    if (!parse.ok) {
      diagnostics.byConstruction += 1;
      diagnostics.unparsedSessionIds += 1;
      addExample(diagnostics.examples.byConstruction, row.sessionId);
      decisions.push({
        ...base,
        joinStatus: 'unjoinable_by_construction',
        joinReason: parse.reason ?? 'unrecognized_session_id',
      });
      continue;
    }
    if (parse.phase === 'review') {
      diagnostics.byConstruction += 1;
      diagnostics.reviewSessions += 1;
      addExample(diagnostics.examples.byConstruction, row.sessionId);
      decisions.push({
        ...base,
        joinStatus: 'unjoinable_by_construction',
        joinReason: 'review_session_branch_keyed',
      });
      continue;
    }
    const issue = parse.issue ?? '';
    const side = parse.side ?? 'primary';
    const key = evalKey(issue, side);
    const evals = index.byKey.get(key) ?? [];
    if (evals.length === 0) {
      diagnostics.missingEval += 1;
      addExample(diagnostics.examples.missingEval, row.sessionId);
      decisions.push({
        ...base,
        joinStatus: 'unjoinable_missing_eval',
        joinReason: `no_eval_record:${key}`,
        issue,
        challengeSide: side,
      });
      continue;
    }
    const rowModel = normalizeModelId(row.model);
    const matching = rowModel
      ? evals.filter((candidate) => normalizeModelId(candidate.modelId) === rowModel)
      : [];
    if (evals.length > 1 && matching.length === 0) {
      diagnostics.ambiguous += 1;
      addExample(diagnostics.examples.ambiguous, row.sessionId);
      decisions.push({
        ...base,
        joinStatus: 'unjoinable_ambiguous',
        joinReason: `ambiguous:${evals.length}_evals_no_model_match`,
        issue,
        challengeSide: side,
      });
      continue;
    }
    const pool = matching.length > 0 ? matching : evals;
    const chosen = [...pool].sort(
      (a, b) => b.timestampMs - a.timestampMs || b.lineNumber - a.lineNumber,
    )[0];
    if (matching.length === 0) diagnostics.modelMismatched += 1;
    diagnostics.joined += 1;
    decisions.push({
      ...base,
      joinStatus: 'joined',
      issue,
      challengeSide: side,
      evalRecord: chosen,
      modelMatched: matching.length > 0,
      success: evalSuccess(chosen, threshold),
      interventionRequired: chosen.interventionRequired,
      interventionCount: chosen.interventionCount,
      taskType: chosen.taskType,
    });
  }
  diagnostics.joinedPct = pct(diagnostics.joined, diagnostics.candidates);
  return { decisions, diagnostics };
}

// ---------------------------------------------------------------------------
// Data-quality report (REQ-F1)
// ---------------------------------------------------------------------------

export interface CoverageMetric {
  present: number;
  total: number;
  pct: number | null;
}

export interface CodingCohortStats {
  /** Schema-valid coding-stage rows of kind tool_call/forced_tool_call. */
  toolRows: number;
  joinedToolRows: number;
  joinedPct: number | null;
  distinctModels: number;
  models: string[];
  distinctSessions: number;
  menuDigestCoveragePct: number | null;
  mirrorConsistencyPct: number | null;
  /** Success rate (0–1) across joined coding tool rows. */
  successRate: number | null;
  timestampParseFailures: number;
  perTierJoined: Record<PropensityProvenance, number>;
  exactRowsWithDistribution: number;
}

export interface GateResult {
  id: 'G1' | 'G2' | 'G3' | 'G4';
  requirement: string;
  observed: string;
  passed: boolean;
  shortfall?: string;
}

export interface DataQualityReport {
  corpusPath: string;
  corpusFileMissing: boolean;
  corpusLines: number;
  validRows: number;
  invalidRows: number;
  schemaAdherencePct: number | null;
  malformed: { count: number; examples: CorpusLineIssue[] };
  duplicates: { count: number; examples: DuplicateDecision[] };
  duplicateRatePct: number | null;
  expectedSchemaVersion: string;
  kindHistogram: Record<string, number>;
  phaseHistogram: Record<string, number>;
  modelHistogram: Record<string, number>;
  runtimeHistogram: Record<string, number>;
  providerHistogram: Record<string, number>;
  policyDeniedRatePct: number | null;
  propensityProvenanceHistogram: Record<string, number>;
  confounderCoverage: Record<string, CoverageMetric>;
  menuIntegrity: {
    rowsWithToolMenu: number;
    rowsWithMirrorFields: number;
    mirrorConsistent: number;
    mirrorConsistencyPct: number | null;
  };
  outcomeFieldFilled: number;
  join: JoinDiagnostics;
  evalIndex: {
    path: string;
    fileMissing: boolean;
    records: number;
    malformed: number;
    withoutIssueId: number;
    literalSuffixNormalizations: number;
  };
  codingCohort: CodingCohortStats;
  gates: GateResult[];
  coverageGatesPassed: boolean;
  reportableTiers: PropensityProvenance[];
}

function coverageOf(
  rows: ToolDecisionRow[],
  present: (row: ToolDecisionRow) => boolean,
): CoverageMetric {
  let presentCount = 0;
  for (const row of rows) {
    if (present(row)) presentCount += 1;
  }
  return { present: presentCount, total: rows.length, pct: pct(presentCount, rows.length) };
}

function hasMenuDigest(row: ToolDecisionRow): boolean {
  return typeof row.toolMenu?.digest === 'string' && row.toolMenu.digest !== '';
}

function mirrorConsistent(row: ToolDecisionRow): boolean {
  const menuNames = row.toolMenu?.toolNames;
  const available = row.availableTools;
  if (!Array.isArray(menuNames) || !Array.isArray(available)) return false;
  const a = [...menuNames].sort().join('\u0000');
  const b = [...available].sort().join('\u0000');
  return a === b;
}

function rowProvenance(row: ToolDecisionRow): PropensityProvenance {
  const provenance = row.propensity?.provenance;
  return (TIER_ORDER as readonly string[]).includes(String(provenance))
    ? (provenance as PropensityProvenance)
    : 'unavailable';
}

function hasFilledDistribution(row: ToolDecisionRow): boolean {
  const distribution = row.propensity?.distribution;
  if (distribution === null || typeof distribution !== 'object' || Array.isArray(distribution)) {
    return false;
  }
  return Object.keys(distribution).length > 0;
}

function emptyCohort(): CodingCohortStats {
  return {
    toolRows: 0,
    joinedToolRows: 0,
    joinedPct: null,
    distinctModels: 0,
    models: [],
    distinctSessions: 0,
    menuDigestCoveragePct: null,
    mirrorConsistencyPct: null,
    successRate: null,
    timestampParseFailures: 0,
    perTierJoined: { exact: 0, provider_reported: 0, surrogate: 0, unavailable: 0 },
    exactRowsWithDistribution: 0,
  };
}

export interface ValidateQualityOptions {
  gates?: Partial<GateThresholds>;
  /** Eval index for appendix stats; optional so quality can be computed standalone. */
  evalIndex?: EvalOutcomeIndex;
}

/**
 * Compute the full REQ-F1 data-quality appendix: schema adherence, duplicate
 * rate, per-confounder coverage, propensity provenance histogram, menu
 * integrity, join diagnostics, coding-cohort descriptives, and the
 * pre-registered gate evaluations G1–G4 with shortfall quantities.
 */
export function validateDataQuality(
  load: CorpusLoadResult,
  join: JoinResult,
  options: ValidateQualityOptions = {},
): DataQualityReport {
  const gates = resolveGates(options.gates);
  const rows = load.rows;

  const kindCounts = new Map<string, number>();
  const phaseCounts = new Map<string, number>();
  const modelCounts = new Map<string, number>();
  const runtimeCounts = new Map<string, number>();
  const providerCounts = new Map<string, number>();
  const provenanceCounts = new Map<string, number>();
  let policyDenied = 0;
  let outcomeFilled = 0;
  let rowsWithToolMenu = 0;
  let rowsWithMirrorFields = 0;
  let mirrorConsistentCount = 0;

  for (const row of rows) {
    addTo(kindCounts, String(row.kind));
    addTo(phaseCounts, String(row.phase));
    addTo(modelCounts, String(row.model));
    addTo(runtimeCounts, String(row.runtime));
    addTo(providerCounts, String(row.provider));
    addTo(provenanceCounts, rowProvenance(row));
    if (row.kind === 'policy_denied') policyDenied += 1;
    if (row.outcome) outcomeFilled += 1;
    if (row.toolMenu) rowsWithToolMenu += 1;
    if (Array.isArray(row.toolMenu?.toolNames) && Array.isArray(row.availableTools)) {
      rowsWithMirrorFields += 1;
      if (mirrorConsistent(row)) mirrorConsistentCount += 1;
    }
  }

  const cohortToolRows = rows.filter(
    (row) => row.phase === 'coding' && (TOOL_KINDS as readonly string[]).includes(row.kind),
  );
  const joinedCohort = join.decisions.filter(
    (decision) =>
      decision.schemaValid &&
      decision.joinStatus === 'joined' &&
      decision.row.phase === 'coding' &&
      (TOOL_KINDS as readonly string[]).includes(decision.row.kind),
  );

  const cohort: CodingCohortStats = emptyCohort();
  cohort.toolRows = cohortToolRows.length;
  cohort.joinedToolRows = joinedCohort.length;
  cohort.joinedPct = pct(cohort.joinedToolRows, cohort.toolRows);
  const cohortModels = new Set<string>();
  const cohortSessions = new Set<string>();
  let menuDigestPresent = 0;
  let mirrorRows = 0;
  let mirrorOk = 0;
  let successes = 0;
  let timestampFailures = 0;
  for (const decision of joinedCohort) {
    cohortModels.add(String(decision.row.model));
    cohortSessions.add(decision.row.sessionId);
    if (hasMenuDigest(decision.row)) menuDigestPresent += 1;
    if (
      Array.isArray(decision.row.toolMenu?.toolNames) &&
      Array.isArray(decision.row.availableTools)
    ) {
      mirrorRows += 1;
      if (mirrorConsistent(decision.row)) mirrorOk += 1;
    }
    if (decision.success === true) successes += 1;
    if (decision.timestampMs === null) timestampFailures += 1;
    cohort.perTierJoined[rowProvenance(decision.row)] += 1;
    if (rowProvenance(decision.row) === 'exact' && hasFilledDistribution(decision.row)) {
      cohort.exactRowsWithDistribution += 1;
    }
  }
  cohort.distinctModels = cohortModels.size;
  cohort.models = [...cohortModels].sort();
  cohort.distinctSessions = cohortSessions.size;
  cohort.menuDigestCoveragePct = pct(menuDigestPresent, joinedCohort.length);
  cohort.mirrorConsistencyPct = pct(mirrorOk, mirrorRows);
  cohort.successRate = rate(successes, joinedCohort.length);
  cohort.timestampParseFailures = timestampFailures;

  const decisionByRowKey = new Map<string, JoinedDecision>();
  for (const decision of join.decisions) {
    if (!decisionByRowKey.has(decision.decisionId)) {
      decisionByRowKey.set(decision.decisionId, decision);
    }
  }

  const confounderCoverage: Record<string, CoverageMetric> = {
    model: coverageOf(rows, (row) => typeof row.model === 'string' && row.model !== ''),
    provider: coverageOf(rows, (row) => typeof row.provider === 'string' && row.provider !== ''),
    phase: coverageOf(rows, (row) => typeof row.phase === 'string' && row.phase !== ''),
    runtime: coverageOf(rows, (row) => typeof row.runtime === 'string' && row.runtime !== ''),
    menu_digest: coverageOf(rows, hasMenuDigest),
    available_tools_mirror: coverageOf(
      rows,
      (row) => Array.isArray(row.availableTools) && row.availableTools.length > 0,
    ),
    provider_menu: coverageOf(rows, (row) => row.providerMenu !== undefined),
    turn_budget_remaining: coverageOf(
      rows,
      (row) => typeof row.state?.turnBudgetRemaining === 'number',
    ),
    tool_call_budget_remaining: coverageOf(
      rows,
      (row) => typeof row.state?.toolCallBudgetRemaining === 'number',
    ),
    outcome_field: coverageOf(rows, (row) => row.outcome !== undefined),
    timestamp_parseable: coverageOf(
      rows,
      (row) => normalizeTimestampMs(row.timestamp) !== null,
    ),
    task_class_via_eval_join: coverageOf(rows, (row) => {
      const decision = decisionByRowKey.get(row.decisionId);
      return decision?.taskType !== undefined;
    }),
  };

  // ---- Pre-registered gates ---------------------------------------------
  const gateResults: GateResult[] = [];

  const g1Need = Math.max(0, gates.minCodingToolRows - cohort.toolRows);
  gateResults.push({
    id: 'G1',
    requirement: `>= ${gates.minCodingToolRows} schema-valid coding-stage rows of kind tool_call/forced_tool_call`,
    observed: `${cohort.toolRows} rows`,
    passed: cohort.toolRows >= gates.minCodingToolRows,
    ...(cohort.toolRows < gates.minCodingToolRows
      ? { shortfall: `${g1Need} more coding-stage tool-call rows` }
      : {}),
  });

  const g2Shortfalls: string[] = [];
  if (cohort.joinedPct === null || cohort.joinedPct < gates.minJoinRatePct) {
    g2Shortfalls.push(`join rate ${fmtPct(cohort.joinedPct)} < ${gates.minJoinRatePct}%`);
  }
  if (cohort.distinctModels < gates.minJoinedModels) {
    g2Shortfalls.push(
      `${gates.minJoinedModels - cohort.distinctModels} more distinct models among joined rows`,
    );
  }
  if (cohort.distinctSessions < gates.minJoinedSessions) {
    g2Shortfalls.push(
      `${gates.minJoinedSessions - cohort.distinctSessions} more distinct sessions among joined rows`,
    );
  }
  gateResults.push({
    id: 'G2',
    requirement: `>= ${gates.minJoinRatePct}% of the G1 cohort joined to an eval outcome; >= ${gates.minJoinedModels} models and >= ${gates.minJoinedSessions} distinct sessions among joined rows`,
    observed: `${fmtPct(cohort.joinedPct)} joined; ${cohort.distinctModels} models; ${cohort.distinctSessions} sessions`,
    passed: g2Shortfalls.length === 0,
    ...(g2Shortfalls.length > 0 ? { shortfall: g2Shortfalls.join('; ') } : {}),
  });

  const g3Shortfalls: string[] = [];
  if (
    cohort.menuDigestCoveragePct === null ||
    cohort.menuDigestCoveragePct < gates.minMenuDigestCoveragePct
  ) {
    g3Shortfalls.push(
      `menu digest coverage ${fmtPct(cohort.menuDigestCoveragePct)} < ${gates.minMenuDigestCoveragePct}%`,
    );
  }
  if (
    cohort.mirrorConsistencyPct === null ||
    cohort.mirrorConsistencyPct < gates.minMenuMirrorPct
  ) {
    g3Shortfalls.push(
      `mirror consistency ${fmtPct(cohort.mirrorConsistencyPct)} < ${gates.minMenuMirrorPct}%`,
    );
  }
  gateResults.push({
    id: 'G3',
    requirement: `toolMenu.digest on >= ${gates.minMenuDigestCoveragePct}% of joined rows; availableTools mirrors toolMenu.toolNames on >= ${gates.minMenuMirrorPct}% of rows having both`,
    observed: `digest ${fmtPct(cohort.menuDigestCoveragePct)}; mirror ${fmtPct(cohort.mirrorConsistencyPct)}`,
    passed: g3Shortfalls.length === 0,
    ...(g3Shortfalls.length > 0 ? { shortfall: g3Shortfalls.join('; ') } : {}),
  });

  const reportableTiers = TIER_ORDER.filter(
    (tier) => cohort.perTierJoined[tier] >= gates.minTierJoinedRows,
  );
  const tierObserved = TIER_ORDER.map((tier) => `${tier}=${cohort.perTierJoined[tier]}`).join(', ');
  const g4Passed = reportableTiers.length > 0;
  gateResults.push({
    id: 'G4',
    requirement: `each reported provenance tier needs >= ${gates.minTierJoinedRows} joined rows; the off-policy (IPW/AIPW) tier additionally requires provenance='exact' rows with a filled distribution`,
    observed: `${tierObserved}; exact rows with filled distribution: ${cohort.exactRowsWithDistribution}`,
    passed: g4Passed,
    ...(!g4Passed
      ? {
          shortfall: `no provenance tier reaches ${gates.minTierJoinedRows} joined rows (largest: ${Math.max(
            ...TIER_ORDER.map((tier) => cohort.perTierJoined[tier]),
          )})`,
        }
      : {}),
  });

  const malformedExamples = load.malformed.slice(0, EXAMPLE_LIMIT);
  const duplicateExamples = load.duplicates.slice(0, EXAMPLE_LIMIT);
  const evalIndex = options.evalIndex;

  return {
    corpusPath: load.path,
    corpusFileMissing: load.fileMissing,
    corpusLines: load.totalLines,
    validRows: rows.length,
    invalidRows: load.invalidRows.length,
    schemaAdherencePct: pct(rows.length, load.totalLines),
    malformed: { count: load.malformed.length, examples: malformedExamples },
    duplicates: { count: load.duplicates.length, examples: duplicateExamples },
    duplicateRatePct: pct(load.duplicates.length, load.totalLines),
    expectedSchemaVersion: TOOL_DECISION_SCHEMA_VERSION,
    kindHistogram: sortedCounts(kindCounts),
    phaseHistogram: sortedCounts(phaseCounts),
    modelHistogram: sortedCounts(modelCounts),
    runtimeHistogram: sortedCounts(runtimeCounts),
    providerHistogram: sortedCounts(providerCounts),
    policyDeniedRatePct: pct(policyDenied, rows.length),
    propensityProvenanceHistogram: sortedCounts(provenanceCounts),
    confounderCoverage,
    menuIntegrity: {
      rowsWithToolMenu,
      rowsWithMirrorFields,
      mirrorConsistent: mirrorConsistentCount,
      mirrorConsistencyPct: pct(mirrorConsistentCount, rowsWithMirrorFields),
    },
    outcomeFieldFilled: outcomeFilled,
    join: join.diagnostics,
    evalIndex: {
      path: evalIndex?.path ?? '',
      fileMissing: evalIndex?.fileMissing ?? false,
      records: evalIndex?.records.length ?? 0,
      malformed: evalIndex?.malformed ?? 0,
      withoutIssueId: evalIndex?.withoutIssueId ?? 0,
      literalSuffixNormalizations: evalIndex?.literalSuffixNormalizations ?? 0,
    },
    codingCohort: cohort,
    gates: gateResults,
    coverageGatesPassed: gateResults.every((gate) => gate.passed),
    reportableTiers,
  };
}

// ---------------------------------------------------------------------------
// Statistical machinery
// ---------------------------------------------------------------------------

/** Deterministic mulberry32-style PRNG so bootstrap intervals are reproducible. */
export function createSeededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sortedValues: number[], q: number): number {
  if (sortedValues.length === 0) return Number.NaN;
  const pos = (sortedValues.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const base = sortedValues[lo];
  return hi === lo ? base : base + (sortedValues[hi] - base) * (pos - lo);
}

function finiteOrNull(value: number | undefined | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function safeWilson(
  successes: number,
  n: number,
): { p: number | null; lo: number | null; hi: number | null } | null {
  if (
    !Number.isFinite(successes) ||
    !Number.isFinite(n) ||
    n <= 0 ||
    successes < 0 ||
    successes > n
  ) {
    return null;
  }
  return wilsonInterval(successes, n);
}

function sampleStandardError(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance / values.length);
}

// ---- Design matrix ----------------------------------------------------------

type CategoryField = 'tool' | 'model' | 'menu_digest' | 'task_type' | 'runtime';

interface CategorySpec {
  field: CategoryField;
  /** Levels that get one-hot columns (the reference level is excluded). */
  levels: string[];
  reference: string;
  lumped: boolean;
}

function categoryValue(decision: JoinedDecision, field: CategoryField): string {
  const row = decision.row;
  switch (field) {
    case 'tool':
      return typeof row.chosenTool === 'string' && row.chosenTool !== ''
        ? row.chosenTool
        : '__no_tool__';
    case 'model':
      return typeof row.model === 'string' && row.model !== '' ? row.model : '__unknown_model__';
    case 'menu_digest':
      return hasMenuDigest(row) ? String(row.toolMenu?.digest) : '__missing_digest__';
    case 'task_type':
      return decision.taskType ?? '__unknown_task__';
    case 'runtime':
      return typeof row.runtime === 'string' && row.runtime !== ''
        ? row.runtime
        : '__unknown_runtime__';
  }
}

function buildCategory(
  rows: JoinedDecision[],
  field: CategoryField,
  cap: number,
  notes: string[],
): CategorySpec {
  const counts = new Map<string, number>();
  for (const decision of rows) {
    addTo(counts, categoryValue(decision, field));
  }
  let entries = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  let lumped = false;
  if (entries.length > cap) {
    const kept = entries.slice(0, cap - 1);
    const restCount = entries.slice(cap - 1).reduce((sum, entry) => sum + entry[1], 0);
    entries = [...kept, [`__other_${field}__`, restCount] as [string, number]];
    lumped = true;
    notes.push(`${field}: more than ${cap} distinct values; kept top ${cap - 1} and lumped the rest`);
  }
  const reference = entries[0]?.[0] ?? '__none__';
  return { field, reference, levels: entries.slice(1).map(([name]) => name), lumped };
}

interface NumericFeatureSpec {
  name: string;
  value: (row: ToolDecisionRow) => number | null;
}

const NUMERIC_FEATURES: NumericFeatureSpec[] = [
  { name: 'turn_index', value: (row) => numOrNull(row.turnIndex) },
  { name: 'step_index', value: (row) => numOrNull(row.stepIndex) },
  { name: 'prior_tool_call_count', value: (row) => numOrNull(row.state?.priorToolCallCount) },
  { name: 'prior_error_count', value: (row) => numOrNull(row.state?.priorErrorCount) },
  { name: 'prior_policy_denials', value: (row) => numOrNull(row.state?.priorPolicyDenials) },
  { name: 'terminal_synthesis', value: (row) => (row.state?.terminalSynthesis === true ? 1 : 0) },
  {
    name: 'menu_size',
    value: (row) => (Array.isArray(row.toolMenu?.toolNames) ? row.toolMenu.toolNames.length : null),
  },
];

const OPTIONAL_NUMERIC_FEATURES: NumericFeatureSpec[] = [
  { name: 'turn_budget_remaining', value: (row) => numOrNull(row.state?.turnBudgetRemaining) },
  { name: 'tool_call_budget_remaining', value: (row) => numOrNull(row.state?.toolCallBudgetRemaining) },
];

export interface DesignSpecOptions {
  includeModel?: boolean;
  includeMenuDigest?: boolean;
  includeTaskType?: boolean;
  includeRuntime?: boolean;
  maxTools?: number;
  maxModels?: number;
  maxMenuDigests?: number;
  maxTaskTypes?: number;
  maxRuntimes?: number;
}

export interface DesignSpec {
  numericNames: string[];
  numericMeans: number[];
  numericStds: number[];
  categories: CategorySpec[];
  referenceTool: string | null;
  toolLevels: string[];
  covariateNames: string[];
  notes: string[];
  buildVector: (decision: JoinedDecision, toolOverride?: string) => number[];
}

/**
 * Build the covariate design for a tier. One spec is shared by the pooled fit,
 * the stratum fits, the holdout refit, leave-one-model-out, and the bootstrap
 * so the reference tool and standardizers stay comparable across fits.
 */
function buildDesignSpec(rows: JoinedDecision[], options: DesignSpecOptions = {}): DesignSpec {
  if (rows.length === 0) {
    return {
      numericNames: [],
      numericMeans: [],
      numericStds: [],
      categories: [],
      referenceTool: null,
      toolLevels: [],
      covariateNames: [],
      notes: ['no rows in tier'],
      buildVector: () => [],
    };
  }
  const notes: string[] = [];
  const optionalSpecs = OPTIONAL_NUMERIC_FEATURES.filter((feature) =>
    rows.some((decision) => feature.value(decision.row) !== null),
  );
  if (optionalSpecs.length === 0) {
    notes.push(
      'budget confounder uncontrolled: state.turnBudgetRemaining/toolCallBudgetRemaining are never filled in this tier',
    );
  }
  const allNumeric = [...NUMERIC_FEATURES, ...optionalSpecs];
  const numericNames = allNumeric.map((feature) => feature.name);
  const numericMeans: number[] = [];
  const numericStds: number[] = [];
  for (const feature of allNumeric) {
    const values = rows.map((decision) => feature.value(decision.row) ?? 0);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance =
      values.length > 1
        ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
        : 0;
    numericMeans.push(mean);
    numericStds.push(Math.sqrt(variance) || 1);
  }

  const categories: CategorySpec[] = [];
  categories.push(buildCategory(rows, 'tool', options.maxTools ?? 15, notes));
  if (options.includeModel) {
    categories.push(buildCategory(rows, 'model', options.maxModels ?? 20, notes));
  }
  if (options.includeMenuDigest) {
    const digests = new Set(rows.map((decision) => categoryValue(decision, 'menu_digest')));
    const cap = options.maxMenuDigests ?? 25;
    if (digests.size > cap) {
      notes.push(
        `menu-digest confounder collapsed to menu_size only: ${digests.size} distinct digests exceeds the cap of ${cap}`,
      );
    } else if (digests.size > 1) {
      categories.push(buildCategory(rows, 'menu_digest', cap, notes));
    } else {
      notes.push('menu-digest confounder constant within tier (controlled by stratification)');
    }
  }
  if (options.includeTaskType) {
    const withTaskType = rows.filter((decision) => decision.taskType !== undefined).length;
    const distinctTypes = new Set(
      rows.map((decision) => categoryValue(decision, 'task_type')),
    ).size;
    if (withTaskType / rows.length < 0.5) {
      notes.push(
        `task-class confounder uncontrolled: eval-joined task type covers ${fmtPct(
          pct(withTaskType, rows.length),
        )} of rows (< 50%)`,
      );
    } else if (distinctTypes > 1) {
      categories.push(buildCategory(rows, 'task_type', options.maxTaskTypes ?? 10, notes));
    } else {
      notes.push('task-class confounder constant within tier');
    }
  }
  if (options.includeRuntime) {
    const distinctRuntimes = new Set(
      rows.map((decision) => categoryValue(decision, 'runtime')),
    ).size;
    if (distinctRuntimes > 1) {
      categories.push(buildCategory(rows, 'runtime', options.maxRuntimes ?? 5, notes));
    }
  }

  const covariateNames = [
    ...numericNames,
    ...categories.flatMap((category) =>
      category.levels.map((level) => `${category.field}=${level}`),
    ),
  ];
  const toolCategory = categories.find((category) => category.field === 'tool');

  const spec: DesignSpec = {
    numericNames,
    numericMeans,
    numericStds,
    categories,
    referenceTool: toolCategory?.reference ?? null,
    toolLevels: toolCategory?.levels ?? [],
    covariateNames,
    notes,
    buildVector: (decision: JoinedDecision, toolOverride?: string): number[] => {
      const row = decision.row;
      const numeric: number[] = [];
      for (let i = 0; i < allNumeric.length; i += 1) {
        const raw = allNumeric[i].value(row) ?? numericMeans[i];
        numeric.push((raw - numericMeans[i]) / numericStds[i]);
      }
      const oneHots: number[] = [];
      for (const category of categories) {
        const value =
          category.field === 'tool' && toolOverride !== undefined
            ? toolOverride
            : categoryValue(decision, category.field);
        for (const level of category.levels) {
          oneHots.push(value === level ? 1 : 0);
        }
      }
      return [...numeric, ...oneHots];
    },
  };
  return spec;
}

// ---- Regression wrappers ----------------------------------------------------

export interface ToolEffect {
  tool: string;
  support: number;
  coefficient: number | null;
  standardError: number | null;
  z: number | null;
  pValue: number | null;
  ciLo: number | null;
  ciHi: number | null;
  excludesZero: boolean;
}

interface FitResult {
  n: number;
  estimable: boolean;
  notes: string[];
  coefficients: number[];
  standardErrors: number[];
  pValues: number[];
}

/**
 * Fit the tier design on a (sub)set of rows. Degenerate inputs — perfect
 * separation, constant covariates, single-class labels — surface as notes and
 * a non-estimable flag instead of NaNs or crashes.
 */
function fitWithSpec(
  rows: JoinedDecision[],
  spec: DesignSpec,
  iterations: number,
): FitResult | null {
  if (rows.length === 0) return null;
  const design = rows.map((decision) => spec.buildVector(decision));
  const labels = rows.map((decision) => (decision.success === true ? 1 : 0));
  const notes: string[] = [];
  if (new Set(labels).size < 2) notes.push('degenerate_outcome: single-class labels');
  if (rows.length < spec.covariateNames.length * 2) {
    notes.push(
      `low_rows_per_covariate: ${rows.length} rows over ${spec.covariateNames.length} covariates`,
    );
  }
  let fit;
  try {
    fit = fitLogisticRegression(design, labels, {
      iterations,
      learningRate: 0.05,
      l2: 0.001,
    });
  } catch (error) {
    return {
      n: rows.length,
      estimable: false,
      notes: [...notes, `fit_error:${(error as Error).message}`],
      coefficients: [],
      standardErrors: [],
      pValues: [],
    };
  }
  const estimable =
    fit.coefficients.length === spec.covariateNames.length + 1 &&
    fit.coefficients.every((coefficient) => Number.isFinite(coefficient));
  return {
    n: rows.length,
    estimable,
    notes,
    coefficients: fit.coefficients,
    standardErrors: fit.standardErrors,
    pValues: fit.pValues,
  };
}

function extractToolEffects(
  fit: FitResult,
  spec: DesignSpec,
  rows: JoinedDecision[],
): ToolEffect[] {
  const supportCounts = new Map<string, number>();
  for (const decision of rows) {
    addTo(
      supportCounts,
      typeof decision.row.chosenTool === 'string' && decision.row.chosenTool !== ''
        ? decision.row.chosenTool
        : '__no_tool__',
    );
  }
  let toolStartCol = spec.numericNames.length;
  for (const category of spec.categories) {
    if (category.field === 'tool') break;
    toolStartCol += category.levels.length;
  }
  return spec.toolLevels.map((tool, index) => {
    const coefficientIndex = toolStartCol + index + 1; // +1 for the intercept
    const coefficient = finiteOrNull(fit.coefficients[coefficientIndex]);
    const standardError = finiteOrNull(fit.standardErrors[coefficientIndex]);
    const z =
      coefficient !== null && standardError !== null && standardError > 0
        ? coefficient / standardError
        : null;
    const pValue = finiteOrNull(fit.pValues[coefficientIndex]);
    const ciLo =
      coefficient !== null && standardError !== null
        ? coefficient - TOOL_CHOICE_GATES.primaryZ * standardError
        : null;
    const ciHi =
      coefficient !== null && standardError !== null
        ? coefficient + TOOL_CHOICE_GATES.primaryZ * standardError
        : null;
    const excludesZero = ciLo !== null && ciHi !== null && (ciLo > 0 || ciHi < 0);
    return {
      tool,
      support: supportCounts.get(tool) ?? 0,
      coefficient,
      standardError,
      z: finiteOrNull(z),
      pValue: pValue !== null && pValue >= 0 && pValue <= 1 ? pValue : null,
      ciLo: finiteOrNull(ciLo),
      ciHi: finiteOrNull(ciHi),
      excludesZero,
    };
  });
}

function predictWithFit(
  fit: FitResult,
  spec: DesignSpec,
  decision: JoinedDecision,
  toolOverride: string,
): number | null {
  if (!fit.estimable) return null;
  const vector = spec.buildVector(decision, toolOverride);
  let logit = fit.coefficients[0] ?? 0;
  for (let i = 0; i < vector.length; i += 1) {
    logit += (fit.coefficients[i + 1] ?? 0) * vector[i];
  }
  const clamped = Math.max(-35, Math.min(35, logit));
  return 1 / (1 + Math.exp(-clamped));
}

// ---- Stratified contrasts ---------------------------------------------------

export interface ContrastResult {
  model: string;
  menuDigest: string;
  tool: string;
  nTool: number;
  successesTool: number;
  pTool: number | null;
  ciToolLo: number | null;
  ciToolHi: number | null;
  nOther: number;
  successesOther: number;
  pOther: number | null;
  /** Success-rate difference in percentage points (tool minus rest). */
  deltaPct: number | null;
  deltaCiLo: number | null;
  deltaCiHi: number | null;
  smallCell: boolean;
  excludesZero: boolean;
}

function chosenToolOf(decision: JoinedDecision): string {
  return typeof decision.row.chosenTool === 'string' && decision.row.chosenTool !== ''
    ? decision.row.chosenTool
    : '__no_tool__';
}

function menuDigestOf(decision: JoinedDecision): string {
  return hasMenuDigest(decision.row) ? String(decision.row.toolMenu?.digest) : '__missing_digest__';
}

/**
 * Per-(model × menu-digest) success-rate contrasts for each chosen tool against
 * the rest of the stratum, with Wilson intervals on both sides.
 */
function computeContrasts(rows: JoinedDecision[], smallCellFloor: number): ContrastResult[] {
  const groups = new Map<string, JoinedDecision[]>();
  for (const decision of rows) {
    const key = `${String(decision.row.model)}\u0000${menuDigestOf(decision)}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(decision);
    else groups.set(key, [decision]);
  }
  const results: ContrastResult[] = [];
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key) ?? [];
    const [model, digest] = key.split('\u0000');
    const toolCounts = new Map<string, number>();
    for (const decision of group) {
      addTo(toolCounts, chosenToolOf(decision));
    }
    const tools = [...toolCounts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
    for (const [tool, nTool] of tools) {
      if (nTool === 0) continue;
      const cell = group.filter((decision) => chosenToolOf(decision) === tool);
      const others = group.filter((decision) => chosenToolOf(decision) !== tool);
      if (others.length === 0) continue;
      const successesTool = cell.filter((decision) => decision.success === true).length;
      const successesOther = others.filter((decision) => decision.success === true).length;
      const wilsonTool = safeWilson(successesTool, cell.length);
      const pTool = rate(successesTool, cell.length);
      const pOther = rate(successesOther, others.length);
      let deltaPct: number | null = null;
      let deltaCiLo: number | null = null;
      let deltaCiHi: number | null = null;
      let excludesZero = false;
      if (pTool !== null && pOther !== null) {
        deltaPct = (pTool - pOther) * 100;
        const standardError = Math.sqrt(
          (pTool * (1 - pTool)) / cell.length + (pOther * (1 - pOther)) / others.length,
        );
        if (Number.isFinite(standardError)) {
          deltaCiLo =
            (pTool - pOther - TOOL_CHOICE_GATES.primaryZ * standardError) * 100;
          deltaCiHi =
            (pTool - pOther + TOOL_CHOICE_GATES.primaryZ * standardError) * 100;
          excludesZero = deltaCiLo > 0 || deltaCiHi < 0;
        }
      }
      results.push({
        model,
        menuDigest: digest,
        tool,
        nTool: cell.length,
        successesTool,
        pTool,
        ciToolLo: wilsonTool?.lo ?? null,
        ciToolHi: wilsonTool?.hi ?? null,
        nOther: others.length,
        successesOther,
        pOther,
        deltaPct,
        deltaCiLo,
        deltaCiHi,
        smallCell: cell.length < smallCellFloor || others.length < smallCellFloor,
        excludesZero,
      });
    }
  }
  return results
    .sort(
      (a, b) =>
        b.nTool - a.nTool ||
        `${a.model}\u0000${a.tool}`.localeCompare(`${b.model}\u0000${b.tool}`),
    )
    .slice(0, MAX_CONTRAST_ROWS);
}

// ---- Holdout / leave-one-model-out / bootstrap ------------------------------

export interface HoldoutResult {
  trainRows: number;
  holdoutRows: number;
  excludedUnparseableTimestamps: number;
  estimable: boolean;
  note?: string;
  toolEffects: ToolEffect[];
}

function computeHoldout(
  rows: JoinedDecision[],
  spec: DesignSpec,
  gates: GateThresholds,
  holdoutMinRows: number,
): HoldoutResult {
  const parseable = rows.filter((decision) => decision.timestampMs !== null);
  const excluded = rows.length - parseable.length;
  if (parseable.length === 0) {
    return {
      trainRows: 0,
      holdoutRows: 0,
      excludedUnparseableTimestamps: excluded,
      estimable: false,
      note: 'no parseable timestamps',
      toolEffects: [],
    };
  }
  const sorted = [...parseable].sort(
    (a, b) =>
      (a.timestampMs ?? 0) - (b.timestampMs ?? 0) || a.decisionId.localeCompare(b.decisionId),
  );
  const trainRows = Math.max(1, Math.floor((sorted.length * gates.holdoutTrainPct) / 100));
  const holdoutRows = sorted.slice(trainRows);
  if (holdoutRows.length < holdoutMinRows) {
    return {
      trainRows,
      holdoutRows: holdoutRows.length,
      excludedUnparseableTimestamps: excluded,
      estimable: false,
      note: `holdout too small (${holdoutRows.length} < ${holdoutMinRows})`,
      toolEffects: [],
    };
  }
  const fit = fitWithSpec(holdoutRows, spec, SENSITIVITY_ITERATIONS);
  return {
    trainRows,
    holdoutRows: holdoutRows.length,
    excludedUnparseableTimestamps: excluded,
    estimable: fit?.estimable ?? false,
    ...(fit?.estimable ? {} : { note: 'holdout fit not estimable' }),
    toolEffects: fit ? extractToolEffects(fit, spec, holdoutRows) : [],
  };
}

export interface LomoResult {
  droppedModel: string;
  n: number;
  estimable: boolean;
  toolSigns: Array<{ tool: string; sign: number | null }>;
}

function computeLomo(rows: JoinedDecision[], spec: DesignSpec): LomoResult[] {
  const models = [...new Set(rows.map((decision) => String(decision.row.model)))].sort();
  return models.map((model) => {
    const subset = rows.filter((decision) => String(decision.row.model) !== model);
    if (subset.length === 0) {
      return { droppedModel: model, n: 0, estimable: false, toolSigns: [] };
    }
    const fit = fitWithSpec(subset, spec, SENSITIVITY_ITERATIONS);
    const toolEffects = fit ? extractToolEffects(fit, spec, subset) : [];
    return {
      droppedModel: model,
      n: subset.length,
      estimable: fit?.estimable ?? false,
      toolSigns: toolEffects.map((effect) => ({
        tool: effect.tool,
        sign: effect.coefficient !== null ? Math.sign(effect.coefficient) : null,
      })),
    };
  });
}

export interface BootstrapCi {
  tool: string;
  replicates: number;
  lo: number | null;
  hi: number | null;
}

function computeBootstrap(
  rows: JoinedDecision[],
  spec: DesignSpec,
  seed: number,
  replicates: number,
  gates: GateThresholds,
): { cis: BootstrapCi[]; note?: string } {
  if (rows.length < gates.bootstrapMinRows) {
    return {
      cis: [],
      note: `skipped: n=${rows.length} below the bootstrap floor of ${gates.bootstrapMinRows}`,
    };
  }
  const clusters = new Map<string, JoinedDecision[]>();
  for (const decision of rows) {
    const key = decision.row.sessionId;
    const bucket = clusters.get(key);
    if (bucket) bucket.push(decision);
    else clusters.set(key, [decision]);
  }
  const clusterList = [...clusters.keys()]
    .sort()
    .map((key) => clusters.get(key) ?? []);
  const random = createSeededRandom(seed);
  const perTool = new Map<string, number[]>(spec.toolLevels.map((tool) => [tool, []]));
  let validReplicates = 0;
  for (let replicate = 0; replicate < replicates; replicate += 1) {
    const sample: JoinedDecision[] = [];
    for (let i = 0; i < clusterList.length; i += 1) {
      const index = Math.min(
        clusterList.length - 1,
        Math.floor(random() * clusterList.length),
      );
      sample.push(...clusterList[index]);
    }
    const fit = fitWithSpec(sample, spec, BOOTSTRAP_ITERATIONS);
    if (!fit || !fit.estimable) continue;
    validReplicates += 1;
    for (const effect of extractToolEffects(fit, spec, sample)) {
      if (effect.coefficient !== null) {
        perTool.get(effect.tool)?.push(effect.coefficient);
      }
    }
  }
  if (validReplicates < 10) {
    return {
      cis: [],
      note: `unstable: only ${validReplicates}/${replicates} replicates produced an estimable fit`,
    };
  }
  const cis: BootstrapCi[] = spec.toolLevels.map((tool) => {
    const values = (perTool.get(tool) ?? []).sort((a, b) => a - b);
    return {
      tool,
      replicates: values.length,
      lo: values.length > 0 ? round(quantile(values, 0.025), 4) : null,
      hi: values.length > 0 ? round(quantile(values, 0.975), 4) : null,
    };
  });
  return { cis };
}

// ---- Off-policy estimators (exact-provenance tier only) ---------------------

export interface OffPolicyEstimate {
  method: 'ipw' | 'aipw';
  baselineTool: string;
  n: number;
  excludedRows: number;
  observedValue: number | null;
  baselineValue: number | null;
  valueOfChoice: number | null;
  standardError: number | null;
  ciLo: number | null;
  ciHi: number | null;
  notes: string[];
}

function distributionOf(row: ToolDecisionRow): Record<string, number> | null {
  const distribution = row.propensity?.distribution;
  if (distribution === null || typeof distribution !== 'object' || Array.isArray(distribution)) {
    return null;
  }
  return distribution as Record<string, number>;
}

/**
 * Doubly-robust contrast of the observed choice policy against the
 * pre-registered simple baseline "always choose the modal tool". Only rows
 * with a filled exact propensity distribution participate; the outcome model
 * is the tier's adjusted regression reused through {@link predictWithFit}.
 */
function computeOffPolicy(
  rows: JoinedDecision[],
  spec: DesignSpec,
  fit: FitResult | null,
  gates: GateThresholds,
): { estimates: OffPolicyEstimate[]; note?: string } {
  const notes: string[] = [];
  const usable = rows.filter((decision) => {
    const distribution = distributionOf(decision.row);
    const chosen = decision.row.chosenTool;
    if (!distribution || typeof chosen !== 'string' || chosen === '') return false;
    const propensity = distribution[chosen];
    return (
      typeof propensity === 'number' &&
      Number.isFinite(propensity) &&
      propensity > 0 &&
      propensity <= 1
    );
  });
  if (usable.length === 0) {
    return {
      estimates: [],
      note: 'skipped: 0 rows carry a filled exact propensity distribution',
    };
  }
  const toolCounts = new Map<string, number>();
  for (const decision of usable) {
    addTo(toolCounts, String(decision.row.chosenTool));
  }
  const baselineTool = [...toolCounts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )[0][0];
  const evaluable = usable.filter((decision) => {
    const menu = decision.row.toolMenu?.toolNames;
    return Array.isArray(menu) && menu.includes(baselineTool);
  });
  const excludedRows = rows.length - evaluable.length;
  notes.push(
    `${excludedRows} row(s) excluded: no usable exact propensity distribution, or the modal baseline tool is not on the row's menu`,
  );
  if (evaluable.length < gates.bootstrapMinRows) {
    return {
      estimates: [],
      note: `skipped: ${evaluable.length} evaluable rows below the floor of ${gates.bootstrapMinRows}`,
    };
  }

  const observedValue =
    evaluable.reduce((sum, decision) => sum + (decision.success === true ? 1 : 0), 0) /
    evaluable.length;

  // IPW (Horvitz–Thompson) value of the baseline policy.
  const ipwContributions: number[] = [];
  let ipwSum = 0;
  for (const decision of evaluable) {
    const outcome = decision.success === true ? 1 : 0;
    const propensity = distributionOf(decision.row)?.[baselineTool] ?? 0;
    const contribution = decision.row.chosenTool === baselineTool ? outcome / propensity : 0;
    ipwSum += contribution;
    ipwContributions.push(outcome - contribution);
  }
  const ipwBaselineValue = ipwSum / evaluable.length;
  const ipwValueOfChoice = observedValue - ipwBaselineValue;
  const ipwStandardError = sampleStandardError(ipwContributions);

  const estimates: OffPolicyEstimate[] = [
    {
      method: 'ipw',
      baselineTool,
      n: evaluable.length,
      excludedRows,
      observedValue: round(observedValue, 4),
      baselineValue: round(ipwBaselineValue, 4),
      valueOfChoice: round(ipwValueOfChoice, 4),
      standardError: ipwStandardError === null ? null : round(ipwStandardError, 4),
      ciLo:
        ipwStandardError === null
          ? null
          : round(ipwValueOfChoice - gates.primaryZ * ipwStandardError, 4),
      ciHi:
        ipwStandardError === null
          ? null
          : round(ipwValueOfChoice + gates.primaryZ * ipwStandardError, 4),
      notes,
    },
  ];

  if (!fit || !fit.estimable) {
    estimates[0].notes = [
      ...notes,
      'aipw skipped: the tier outcome model is not estimable',
    ];
    return { estimates };
  }

  // AIPW (doubly robust): outcome-model imputation plus propensity correction.
  const aipwContributions: number[] = [];
  let aipwSum = 0;
  for (const decision of evaluable) {
    const outcome = decision.success === true ? 1 : 0;
    const mu = predictWithFit(fit, spec, decision, baselineTool);
    const propensity = distributionOf(decision.row)?.[baselineTool] ?? 0;
    const contribution =
      mu === null
        ? 0
        : mu +
          (decision.row.chosenTool === baselineTool
            ? (outcome - mu) / propensity
            : 0);
    aipwSum += contribution;
    aipwContributions.push(outcome - contribution);
  }
  const aipwBaselineValue = aipwSum / evaluable.length;
  const aipwValueOfChoice = observedValue - aipwBaselineValue;
  const aipwStandardError = sampleStandardError(aipwContributions);
  estimates.push({
    method: 'aipw',
    baselineTool,
    n: evaluable.length,
    excludedRows,
    observedValue: round(observedValue, 4),
    baselineValue: round(aipwBaselineValue, 4),
    valueOfChoice: round(aipwValueOfChoice, 4),
    standardError: aipwStandardError === null ? null : round(aipwStandardError, 4),
    ciLo:
      aipwStandardError === null
        ? null
        : round(aipwValueOfChoice - gates.primaryZ * aipwStandardError, 4),
    ciHi:
      aipwStandardError === null
        ? null
        : round(aipwValueOfChoice + gates.primaryZ * aipwStandardError, 4),
    notes: [
      ...notes,
      'outcome model: tier-level adjusted logistic regression; baseline policy: always choose the modal tool',
    ],
  });
  return { estimates };
}

// ---------------------------------------------------------------------------
// Signal analysis (REQ-F2, REQ-F3)
// ---------------------------------------------------------------------------

export interface AnalyzeSignalOptions {
  gates?: Partial<GateThresholds>;
  seed?: number;
  /** Run estimation even when coverage gates fail (unit tests / exploratory). */
  force?: boolean;
  bootstrapReplicates?: number;
  minStratumRows?: number;
  holdoutMinRows?: number;
}

export interface AdjustedRegressionSummary {
  n: number;
  estimable: boolean;
  notes: string[];
  referenceTool: string | null;
  covariates: string[];
  toolEffects: ToolEffect[];
}

export interface StratumFit {
  model: string;
  menuDigest: string;
  n: number;
  estimable: boolean;
  notes: string[];
  toolEffects: ToolEffect[];
}

export interface TierAnalysis {
  provenance: PropensityProvenance;
  rows: number;
  /** True when the tier clears the G4 row floor. */
  reportable: boolean;
  notReportableReason?: string;
  contrasts: ContrastResult[];
  adjusted: AdjustedRegressionSummary;
  stratumFits: StratumFit[];
  holdout?: HoldoutResult;
  lomo: LomoResult[];
  bootstrap: BootstrapCi[];
  bootstrapNote?: string;
  offPolicy: OffPolicyEstimate[];
  offPolicyNote?: string;
}

export interface SignalCriteriaResult {
  s1: boolean;
  s1Detail: string;
  s2: boolean;
  s2Detail: string;
  s3: boolean;
  s3Detail: string;
  s4: boolean;
  s4Detail: string;
  passesAll: boolean;
  bestEffect?: {
    tier: PropensityProvenance;
    model?: string;
    menuDigest?: string;
    tool: string;
    coefficient: number;
    ciLo: number;
    ciHi: number;
  };
}

export interface SignalAnalysis {
  skipped: boolean;
  skipReason?: string;
  cohort: {
    rows: number;
    sessions: number;
    models: string[];
    successRate: number | null;
    timestampParseFailures: number;
  };
  tiers: TierAnalysis[];
  signal: SignalCriteriaResult;
}

function analysisCohort(join: JoinResult): JoinedDecision[] {
  return join.decisions.filter(
    (decision) =>
      decision.schemaValid &&
      decision.joinStatus === 'joined' &&
      decision.row.phase === 'coding' &&
      (TOOL_KINDS as readonly string[]).includes(decision.row.kind) &&
      typeof decision.row.chosenTool === 'string' &&
      decision.row.chosenTool !== '',
  );
}

function emptySignalResult(): SignalCriteriaResult {
  return {
    s1: false,
    s1Detail: 'no reportable stratum-level effect',
    s2: false,
    s2Detail: 'no S1 effect to reproduce',
    s3: false,
    s3Detail: 'no S1 effect to test',
    s4: false,
    s4Detail: 'no S1 effect on the exact-provenance tier',
    passesAll: false,
  };
}

/**
 * Run the confounder-adjusted signal analysis, separated by propensity
 * provenance tier. Estimation is suppressed (with the failing gate ids) when
 * the pre-registered coverage gates fail, unless `force` is set for tests.
 */
export function analyzeSignal(
  join: JoinResult,
  quality: DataQualityReport,
  options: AnalyzeSignalOptions = {},
): SignalAnalysis {
  const gates = resolveGates(options.gates);
  const seed = options.seed ?? gates.defaultSeed;
  const minStratumRows = options.minStratumRows ?? gates.smallCellFloor;
  const holdoutMinRows = options.holdoutMinRows ?? 30;
  const bootstrapReplicates = options.bootstrapReplicates ?? gates.bootstrapReplicates;
  const cohortRows = analysisCohort(join);

  const models = [...new Set(cohortRows.map((decision) => String(decision.row.model)))].sort();
  const sessions = new Set(cohortRows.map((decision) => decision.row.sessionId)).size;
  const successes = cohortRows.filter((decision) => decision.success === true).length;
  const timestampFailures = cohortRows.filter((decision) => decision.timestampMs === null).length;
  const cohort = {
    rows: cohortRows.length,
    sessions,
    models,
    successRate: rate(successes, cohortRows.length),
    timestampParseFailures: timestampFailures,
  };

  const failedGates = quality.gates.filter((gate) => !gate.passed);
  if (!options.force && failedGates.length > 0) {
    return {
      skipped: true,
      skipReason:
        `Pre-registered coverage gates failed (${failedGates
          .map((gate) => gate.id)
          .join(', ')}) — estimation suppressed to avoid manufacturing a signal`,
      cohort,
      tiers: [],
      signal: emptySignalResult(),
    };
  }

  const tiers: TierAnalysis[] = [];
  for (const provenance of TIER_ORDER) {
    const rows = cohortRows.filter((decision) => rowProvenance(decision.row) === provenance);
    const reportable = rows.length >= gates.minTierJoinedRows;
    const notReportableReason = reportable
      ? undefined
      : `insufficient rows for a reportable tier (n=${rows.length} < ${gates.minTierJoinedRows}); any estimates below are exploratory only`;

    const spec = buildDesignSpec(rows, {
      includeModel: true,
      includeMenuDigest: true,
      includeTaskType: true,
      includeRuntime: true,
    });
    const fit = fitWithSpec(rows, spec, PRIMARY_ITERATIONS);
    const adjusted: AdjustedRegressionSummary = {
      n: rows.length,
      estimable: fit?.estimable ?? false,
      notes: [...spec.notes, ...(fit?.notes ?? [])],
      referenceTool: spec.referenceTool,
      covariates: spec.covariateNames,
      toolEffects: fit ? extractToolEffects(fit, spec, rows) : [],
    };

    // Stratum fits (model × menu digest) share the tier-level spec so the
    // reference tool and standardizers stay comparable across fits.
    const stratumGroups = new Map<string, JoinedDecision[]>();
    for (const decision of rows) {
      const key = `${String(decision.row.model)}\u0000${menuDigestOf(decision)}`;
      const bucket = stratumGroups.get(key);
      if (bucket) bucket.push(decision);
      else stratumGroups.set(key, [decision]);
    }
    const stratumFits: StratumFit[] = [...stratumGroups.keys()]
      .sort()
      .filter((key) => (stratumGroups.get(key)?.length ?? 0) >= minStratumRows)
      .map((key) => {
        const group = stratumGroups.get(key) ?? [];
        const [model, digest] = key.split('\u0000');
        const stratumFit = fitWithSpec(group, spec, PRIMARY_ITERATIONS);
        return {
          model,
          menuDigest: digest,
          n: group.length,
          estimable: stratumFit?.estimable ?? false,
          notes: stratumFit?.notes ?? ['no rows'],
          toolEffects: stratumFit ? extractToolEffects(stratumFit, spec, group) : [],
        };
      });

    const holdout =
      rows.length > 0 ? computeHoldout(rows, spec, gates, holdoutMinRows) : undefined;
    const lomo = rows.length > 0 ? computeLomo(rows, spec) : [];
    const bootstrapResult =
      rows.length > 0
        ? computeBootstrap(rows, spec, seed, bootstrapReplicates, gates)
        : { cis: [] as BootstrapCi[], note: 'no rows in tier' };

    let offPolicy: OffPolicyEstimate[] = [];
    let offPolicyNote: string | undefined;
    if (provenance === 'exact') {
      if (rows.length === 0) {
        offPolicyNote =
          'no exact-provenance rows in this run: the causal (IPW/AIPW) tier is empty, so Go is unreachable by construction';
      } else {
        const result = computeOffPolicy(rows, spec, fit, gates);
        offPolicy = result.estimates;
        offPolicyNote = result.note;
      }
    } else if (rows.length > 0) {
      offPolicyNote =
        'off-policy estimators are restricted to the exact-provenance tier per the schema causal-use contract';
    }

    tiers.push({
      provenance,
      rows: rows.length,
      reportable,
      ...(notReportableReason ? { notReportableReason } : {}),
      contrasts: computeContrasts(rows, gates.smallCellFloor),
      adjusted,
      stratumFits,
      ...(holdout ? { holdout } : {}),
      lomo,
      bootstrap: bootstrapResult.cis,
      ...(bootstrapResult.note ? { bootstrapNote: bootstrapResult.note } : {}),
      offPolicy,
      ...(offPolicyNote ? { offPolicyNote } : {}),
    });
  }

  return {
    skipped: false,
    cohort,
    tiers,
    signal: evaluateSignal(tiers, gates),
  };
}

interface SignalCandidate {
  tier: PropensityProvenance;
  model: string;
  menuDigest: string;
  tool: string;
  coefficient: number;
  ciLo: number;
  ciHi: number;
  z: number;
}

/**
 * Apply the pre-registered signal criteria S1–S4 to the tier analyses.
 * S1 requires a pre-specified (model × coding × menu-digest) stratum whose
 * adjusted tool effect has a 95% CI excluding zero. S4 (per the schema's
 * causal-use contract) requires the winning effect to come from the
 * exact-provenance tier: surrogate-only evidence can never justify Go.
 */
function evaluateSignal(tiers: TierAnalysis[], gates: GateThresholds): SignalCriteriaResult {
  const candidates: SignalCandidate[] = [];
  for (const tier of tiers) {
    if (!tier.reportable) continue;
    for (const fit of tier.stratumFits) {
      if (!fit.estimable) continue;
      for (const effect of fit.toolEffects) {
        if (
          effect.excludesZero &&
          effect.coefficient !== null &&
          effect.ciLo !== null &&
          effect.ciHi !== null
        ) {
          candidates.push({
            tier: tier.provenance,
            model: fit.model,
            menuDigest: fit.menuDigest,
            tool: effect.tool,
            coefficient: effect.coefficient,
            ciLo: effect.ciLo,
            ciHi: effect.ciHi,
            z: Math.abs(effect.z ?? 0),
          });
        }
      }
    }
  }
  if (candidates.length === 0) {
    return {
      ...emptySignalResult(),
      s1Detail:
        'no pre-specified (model × coding × menu-digest) stratum shows an adjusted tool effect whose 95% CI excludes zero',
    };
  }

  const exactCandidates = candidates.filter((candidate) => candidate.tier === 'exact');
  const pool = exactCandidates.length > 0 ? exactCandidates : candidates;
  const best = [...pool].sort(
    (a, b) => b.z - a.z || `${a.model}\u0000${a.tool}`.localeCompare(`${b.model}\u0000${b.tool}`),
  )[0];
  const s1 = true;
  const s1Detail = `${best.tier} tier, model ${best.model}, menu ${best.menuDigest}: tool '${best.tool}' adjusted effect ${fmtNum(
    best.coefficient,
  )} (95% CI [${fmtNum(best.ciLo)}, ${fmtNum(best.ciHi)}])`;

  const tier = tiers.find((candidate) => candidate.provenance === best.tier);
  const s4 = best.tier === 'exact';
  const s4Detail = s4
    ? 'the winning effect comes from the exact-provenance tier'
    : `the winning effect comes from the ${best.tier} tier; surrogate or provider-reported propensities cannot justify Go on their own`;

  let s2 = false;
  let s2Detail = 'no estimable holdout fit';
  const holdout = tier?.holdout;
  if (holdout) {
    const holdoutEffect = holdout.toolEffects.find((effect) => effect.tool === best.tool);
    if (
      holdout.estimable &&
      holdoutEffect &&
      holdoutEffect.coefficient !== null &&
      holdoutEffect.standardError !== null &&
      Number.isFinite(holdoutEffect.standardError) &&
      holdoutEffect.standardError > 0
    ) {
      const sameDirection =
        Math.sign(holdoutEffect.coefficient) === Math.sign(best.coefficient);
      const excludesZero90 =
        Math.abs(holdoutEffect.coefficient) / holdoutEffect.standardError > gates.holdoutZ;
      s2 = sameDirection && excludesZero90;
      s2Detail = `holdout (n=${holdout.holdoutRows}) coefficient ${fmtNum(
        holdoutEffect.coefficient,
      )}, se ${fmtNum(holdoutEffect.standardError)}: ${
        sameDirection ? 'same direction' : 'direction flipped'
      }, ${excludesZero90 ? '90% CI excludes zero' : '90% CI straddles zero'}`;
    }
  }

  let s3 = false;
  let s3Detail = 'no estimable leave-one-model-out fits';
  const lomo = tier?.lomo ?? [];
  const estimableLomo = lomo.filter((result) => result.estimable);
  if (estimableLomo.length > 0) {
    const unstable = estimableLomo.filter((result) => {
      const sign = result.toolSigns.find((entry) => entry.tool === best.tool)?.sign ?? null;
      return sign === null || sign !== Math.sign(best.coefficient);
    });
    const nonEstimable = lomo.length - estimableLomo.length;
    s3 = unstable.length === 0;
    s3Detail =
      `${estimableLomo.length} estimable model drop(s); ${unstable.length} flipped or lost direction` +
      (nonEstimable > 0 ? `; ${nonEstimable} drop(s) not estimable` : '');
  }

  return {
    s1,
    s1Detail,
    s2,
    s2Detail,
    s3,
    s3Detail,
    s4,
    s4Detail,
    passesAll: s1 && s2 && s3 && s4,
    bestEffect: {
      tier: best.tier,
      model: best.model,
      menuDigest: best.menuDigest,
      tool: best.tool,
      coefficient: best.coefficient,
      ciLo: best.ciLo,
      ciHi: best.ciHi,
    },
  };
}

// ---------------------------------------------------------------------------
// Recommendation and minimum-capture specification
// ---------------------------------------------------------------------------

export interface CaptureSpec {
  codingToolRowsNeeded: number;
  joinedCodingRowsNeeded: number;
  modelsNeeded: number;
  sessionsNeeded: number;
  menuCoverageShortfallPct: number | null;
  mirrorShortfallPct: number | null;
  exactProvenanceRowsNeeded: number;
  targets: string[];
}

/**
 * Quantify the minimum additional capture needed to run the gated analysis,
 * derived from the observed shortfalls against the pre-registered gates.
 */
export function computeMinimumCapture(
  quality: DataQualityReport,
  gates: GateThresholds = TOOL_CHOICE_GATES,
): CaptureSpec {
  const cohort = quality.codingCohort;
  const codingToolRowsNeeded = Math.max(0, gates.minCodingToolRows - cohort.toolRows);
  const joinedTarget = Math.ceil(
    (gates.minJoinRatePct / 100) * Math.max(cohort.toolRows, gates.minCodingToolRows),
  );
  const joinedCodingRowsNeeded = Math.max(0, joinedTarget - cohort.joinedToolRows);
  const modelsNeeded = Math.max(0, gates.minJoinedModels - cohort.distinctModels);
  const sessionsNeeded = Math.max(0, gates.minJoinedSessions - cohort.distinctSessions);
  const menuCoverageShortfallPct =
    cohort.menuDigestCoveragePct === null
      ? null
      : round(Math.max(0, gates.minMenuDigestCoveragePct - cohort.menuDigestCoveragePct), 1);
  const mirrorShortfallPct =
    cohort.mirrorConsistencyPct === null
      ? null
      : round(Math.max(0, gates.minMenuMirrorPct - cohort.mirrorConsistencyPct), 1);
  const exactProvenanceRowsNeeded = Math.max(
    0,
    gates.minTierJoinedRows - cohort.perTierJoined.exact,
  );
  const targets = [
    `>= ${gates.minCodingToolRows} schema-valid coding-stage tool_call/forced_tool_call decision rows (have ${cohort.toolRows}; need ${codingToolRowsNeeded} more)`,
    `>= ${gates.minJoinRatePct}% of those rows joined to an eval outcome (have ${cohort.joinedToolRows} joined; need ${joinedCodingRowsNeeded} more)`,
    `>= ${gates.minJoinedModels} distinct models among joined rows (have ${cohort.distinctModels}; need ${modelsNeeded} more)`,
    `>= ${gates.minJoinedSessions} distinct sessions among joined rows (have ${cohort.distinctSessions}; need ${sessionsNeeded} more)`,
    `toolMenu.digest on >= ${gates.minMenuDigestCoveragePct}% of joined rows (currently ${fmtPct(
      cohort.menuDigestCoveragePct,
    )}; shortfall ${fmtPct(menuCoverageShortfallPct)})`,
    `availableTools mirroring toolMenu.toolNames on >= ${gates.minMenuMirrorPct}% of rows having both (currently ${fmtPct(
      cohort.mirrorConsistencyPct,
    )}; shortfall ${fmtPct(mirrorShortfallPct)})`,
    `>= ${gates.minTierJoinedRows} joined rows with propensity.provenance='exact' and a filled distribution for the causal tier (have ${
      cohort.perTierJoined.exact
    }; need ${exactProvenanceRowsNeeded} more)`,
  ];
  return {
    codingToolRowsNeeded,
    joinedCodingRowsNeeded,
    modelsNeeded,
    sessionsNeeded,
    menuCoverageShortfallPct,
    mirrorShortfallPct,
    exactProvenanceRowsNeeded,
    targets,
  };
}

export interface Recommendation {
  decision: 'go' | 'no-go' | 'inconclusive';
  rationale: string[];
  minimumAdditionalCapture?: CaptureSpec;
}

/**
 * Mechanical application of the pre-registered decision rule:
 *   - any coverage gate fails → Inconclusive + quantified minimum capture;
 *   - gates pass and S1–S4 all pass → Go;
 *   - gates pass but the signal criteria are not met → No-go (kill condition).
 */
export function deriveRecommendation(
  quality: DataQualityReport,
  analysis: SignalAnalysis,
  gates: GateThresholds = TOOL_CHOICE_GATES,
): Recommendation {
  const failed = quality.gates.filter((gate) => !gate.passed);
  if (failed.length > 0) {
    return {
      decision: 'inconclusive',
      rationale: [
        `pre-registered coverage gates failed: ${failed
          .map((gate) => `${gate.id} (${gate.shortfall ?? gate.observed})`)
          .join('; ')}`,
        'insufficient data to estimate the value of tool choice; this is neither a positive nor a negative signal',
        'kill condition: if the gates later pass and no effect satisfies S1–S4, the decision becomes No-go and HOK-2081 must not proceed',
      ],
      minimumAdditionalCapture: computeMinimumCapture(quality, gates),
    };
  }
  if (analysis.skipped) {
    return {
      decision: 'inconclusive',
      rationale: [
        `coverage gates passed but estimation was suppressed: ${
          analysis.skipReason ?? 'unknown reason'
       }`,
      ],
    };
  }
  const signal = analysis.signal;
  const rationale = [
    `S1 (pre-specified stratum, adjusted 95% CI excludes zero): ${
      signal.s1 ? 'pass' : 'fail'
    } — ${signal.s1Detail}`,
    `S2 (reproduces in the time-ordered holdout at 90%): ${
      signal.s2 ? 'pass' : 'fail'
    } — ${signal.s2Detail}`,
    `S3 (leave-one-model-out direction stable): ${
      signal.s3 ? 'pass' : 'fail'
    } — ${signal.s3Detail}`,
    `S4 (exact-provenance tier carries the signal): ${
      signal.s4 ? 'pass' : 'fail'
    } — ${signal.s4Detail}`,
  ];
  if (signal.passesAll) {
    rationale.push(
      'all pre-registered signal criteria pass on the exact-provenance tier; proceed to HOK-2081',
    );
    return { decision: 'go', rationale };
  }
  rationale.push(
    'coverage gates pass but the pre-registered signal criteria are not met: no identifiable tool-choice effect at the required confidence',
  );
  rationale.push(
    'kill condition reached: HOK-2081 (production tool router) must not proceed on this evidence',
  );
  if (quality.codingCohort.perTierJoined.exact === 0) {
    rationale.push(
      'note: the exact-provenance tier is empty, so off-policy confirmation was impossible; the pre-registered rule still maps this to No-go rather than Inconclusive',
    );
  }
  return { decision: 'no-go', rationale };
}

// ---------------------------------------------------------------------------
// Report generation (REQ-F4, REQ-F5)
// ---------------------------------------------------------------------------

export interface ReportInput {
  load: CorpusLoadResult;
  quality: DataQualityReport;
  analysis: SignalAnalysis;
  recommendation: Recommendation;
  /** Operator decision; the report's terminal line records this verbatim. */
  decision: 'go' | 'no-go' | 'inconclusive';
  decisionReason: string;
  evalsPath: string;
  /** Injected timestamp so the report is reproducible. */
  now: string;
  /** Operator context notes appended to the Data Quality Appendix. */
  notes?: string[];
}

const DECISION_LABEL: Record<'go' | 'no-go' | 'inconclusive', string> = {
  go: 'Go',
  'no-go': 'No-go',
  inconclusive: 'Inconclusive',
};

function mdEscape(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function mdTable(headers: string[], rows: string[][]): string {
  const head = `| ${headers.map(mdEscape).join(' | ')} |`;
  const divider = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.map(mdEscape).join(' | ')} |`);
  return [head, divider, ...body].join('\n');
}

function coverageRow(name: string, metric: CoverageMetric): string[] {
  return [name, `${fmtPct(metric.pct)} (${metric.present}/${metric.total})`];
}

function describeGatesForMethodology(gates: GateThresholds): string[] {
  return [
    `- G1: at least ${gates.minCodingToolRows} schema-valid coding-stage rows of kind tool_call/forced_tool_call.`,
    `- G2: at least ${gates.minJoinRatePct}% of the G1 cohort joined to an eval outcome; joined rows span at least ${gates.minJoinedModels} models and ${gates.minJoinedSessions} distinct sessions.`,
    `- G3: toolMenu.digest on at least ${gates.minMenuDigestCoveragePct}% of joined rows, and availableTools mirrors toolMenu.toolNames on at least ${gates.minMenuMirrorPct}% of rows that have both.`,
    `- G4: a provenance tier is reported only with at least ${gates.minTierJoinedRows} joined rows; the off-policy (IPW/AIPW) tier additionally requires provenance='exact' rows with a filled distribution.`,
  ];
}

function formatTierContrastTable(tier: TierAnalysis): string {
  if (tier.contrasts.length === 0) {
    return '_No contrasts available (no joined rows in this tier)._';
  }
  return mdTable(
    [
      'Model',
      'Menu digest',
      'Tool',
      'n(tool)',
      'success(tool) [95% CI]',
      'n(rest)',
      'success(rest)',
      'Δ (pp) [95% CI]',
      'small cell',
    ],
    tier.contrasts.map((contrast) => [
      contrast.model,
      contrast.menuDigest,
      contrast.tool,
      String(contrast.nTool),
      `${fmtPct(contrast.pTool === null ? null : contrast.pTool * 100)} [${fmtNum(
        contrast.ciToolLo,
      )}, ${fmtNum(contrast.ciToolHi)}]`,
      String(contrast.nOther),
      fmtPct(contrast.pOther === null ? null : contrast.pOther * 100),
      `${fmtNum(contrast.deltaPct)} [${fmtNum(contrast.deltaCiLo)}, ${fmtNum(
        contrast.deltaCiHi,
      )}]`,
      contrast.smallCell ? 'yes' : 'no',
    ]),
  );
}

function formatToolEffectTable(effects: ToolEffect[]): string {
  if (effects.length === 0) return '_No tool effects estimable._';
  return mdTable(
    ['Tool', 'support', 'coefficient', 'SE', 'z', 'p', '95% CI', 'excludes 0'],
    effects.map((effect) => [
      effect.tool,
      String(effect.support),
      fmtNum(effect.coefficient),
      fmtNum(effect.standardError),
      fmtNum(effect.z),
      fmtNum(effect.pValue, 4),
      `[${fmtNum(effect.ciLo)}, ${fmtNum(effect.ciHi)}]`,
      effect.excludesZero ? 'yes' : 'no',
    ]),
  );
}

/**
 * Render the full markdown report. The document always ends with the exact
 * terminal block:
 *
 * ```
 * ## Decision
 *
 * Decision: <Go|No-go|Inconclusive>
 *
 * <justification>
 * ```
 */
export function generateReport(input: ReportInput): string {
  const { quality, analysis, recommendation, decision, decisionReason } = input;
  const divergence = decision !== recommendation.decision;
  const lines: string[] = [];

  lines.push('# Tool-choice signal analysis (HOK-2080)');
  lines.push('');
  lines.push(
    `Generated from \`${input.load.path}\` on ${input.now}. Eval outcomes joined from \`${input.evalsPath}\`.`,
  );
  lines.push('');

  // ---- Executive summary -------------------------------------------------
  lines.push('## Executive Summary');
  lines.push('');
  const corpusState = quality.corpusFileMissing
    ? 'corpus file absent — no tool decisions have been captured'
    : `${quality.corpusLines} line(s), ${quality.validRows} schema-valid row(s)`;
  lines.push(`- Corpus: \`${quality.corpusPath}\` (${corpusState})`);
  lines.push(
    `- Schema adherence: ${fmtPct(quality.schemaAdherencePct)} (${quality.validRows}/${
      quality.corpusLines
    } lines valid against schema v${quality.expectedSchemaVersion})`,
  );
  lines.push(
    `- Outcome join rate: ${fmtPct(quality.join.joinedPct)} (${quality.join.joined}/${
      quality.join.candidates
    } candidates joined)`,
  );
  lines.push(
    `- Coding-stage tool-call cohort: ${quality.codingCohort.toolRows} row(s), ${
      quality.codingCohort.joinedToolRows
    } joined, across ${quality.codingCohort.distinctModels} model(s) and ${
      quality.codingCohort.distinctSessions
    } session(s)`,
  );
  lines.push(
    `- Propensity provenance mix: ${
      Object.entries(quality.propensityProvenanceHistogram)
        .map(([key, value]) => `${key}=${value}`)
        .join(', ') || 'none'
    }`,
  );
  lines.push(`- Computed recommendation: ${DECISION_LABEL[recommendation.decision]}`);
  lines.push(
    `- Operator decision: ${DECISION_LABEL[decision]}${
      divergence ? ' — ⚠ diverges from the computed recommendation; recorded for audit' : ''
    }`,
  );
  lines.push(
    `- Coverage gates: ${quality.gates
      .map((gate) => `${gate.id} ${gate.passed ? 'pass' : 'fail'}`)
      .join(', ')}`,
  );
  lines.push('');

  // ---- Methodology ---------------------------------------------------------
  lines.push('## Methodology');
  lines.push('');
  lines.push(
    `- Outcome: binary success per decision — the joined eval record's explicit \`outcomes.success\` when present, otherwise \`score >= ${
      TOOL_CHOICE_GATES.successThreshold
    }\` (mirrors shared/lib/eval-success-policy.ts; threshold pre-registered in \`TOOL_CHOICE_GATES\`).`,
  );
  lines.push(
    '- Cohort: schema-valid rows with phase=coding and kind in {tool_call, forced_tool_call} that joined an eval outcome, deduplicated by decisionId.',
  );
  lines.push(
    '- Confounder control: covariate-adjusted logistic regression per propensity-provenance tier, with standardized state features (turn/step index, prior tool calls, prior errors, prior policy denials, terminal-synthesis flag, menu size, budget fields where present) plus tool, model, policy-exposed menu-digest, runtime (when varied), and eval-joined task-class (when coverage reaches 50%) one-hots. Coverage of every declared confounder is itself reported in the Data Quality Appendix.',
  );
  lines.push(
    '- Propensity tiering (REQ-F3): every estimate is reported under its provenance tier. Inverse-probability weighting (IPW) and the doubly-robust (AIPW) contrast against the always-modal-tool baseline run only on exact-provenance rows with a filled distribution, per the tool-decision schema causal-use contract.',
  );
  lines.push(
    '- Uncertainty: Wilson intervals for stratified contrasts; seeded cluster bootstrap over sessions for adjusted coefficients; time-ordered 70/30 holdout; leave-one-model-out sensitivity.',
  );
  lines.push('');
  lines.push('Pre-registered coverage gates (all must pass before any estimate is reported):');
  lines.push('');
  lines.push(...describeGatesForMethodology(TOOL_CHOICE_GATES));
  lines.push('');
  lines.push('Pre-registered signal criteria (Go requires all four):');
  lines.push('');
  lines.push(
    '- S1: at least one pre-specified stratum (model × phase=coding × menu-digest) shows a tool-choice effect whose 95% CI excludes zero after covariate adjustment (state features + budget where present + task class where joined).',
  );
  lines.push(
    '- S2: the effect reproduces in a time-ordered 70/30 holdout (same direction, CI excluding zero in the holdout at 90%).',
  );
  lines.push('- S3: the effect survives leave-one-model-out sensitivity (direction stable).');
  lines.push(
    "- S4: surrogate-only evidence never justifies Go — the exact-provenance tier must pass S1–S2. Surrogate/observational agreement upgrades confidence but does not substitute.",
  );
  lines.push('');
  lines.push(
    'Decision mapping: gates pass + S1–S4 pass → **Go**; gates pass + no identifiable effect → **No-go**; coverage/propensity gates fail → **Inconclusive** with a quantified minimum-capture specification. Kill condition: if the gates later pass and no effect satisfies S1–S4, the decision becomes No-go and HOK-2081 (production tool router) must not proceed.',
  );
  lines.push('');
  lines.push('Observed gate evaluation:');
  lines.push('');
  lines.push(
    mdTable(
      ['Gate', 'Requirement', 'Observed', 'Result', 'Shortfall'],
      quality.gates.map((gate) => [
        gate.id,
        gate.requirement,
        gate.observed,
        gate.passed ? 'pass' : 'fail',
        gate.shortfall ?? '—',
      ]),
    ),
  );
  lines.push('');

  // ---- Data quality appendix ----------------------------------------------
  lines.push('## Data Quality Appendix');
  lines.push('');
  lines.push('### Corpus integrity');
  lines.push('');
  lines.push(
    mdTable(
      ['Metric', 'Value'],
      [
        ['Corpus path', quality.corpusPath],
        ['Corpus file present', quality.corpusFileMissing ? 'no' : 'yes'],
        ['Non-blank lines', String(quality.corpusLines)],
        ['Schema-valid rows', String(quality.validRows)],
        ['Schema-invalid but joinable rows (lenient)', String(quality.invalidRows)],
        ['Malformed lines', String(quality.malformed.count)],
        [
          'Duplicate decisionIds',
          `${quality.duplicates.count} (rate ${fmtPct(quality.duplicateRatePct)})`,
        ],
        ['Schema adherence', fmtPct(quality.schemaAdherencePct)],
        ['Rows with a projector-filled outcome field', String(quality.outcomeFieldFilled)],
        ['Policy-denied rows', fmtPct(quality.policyDeniedRatePct)],
      ],
    ),
  );
  lines.push('');
  if (quality.malformed.examples.length > 0) {
    lines.push('Malformed-line examples:');
    lines.push('');
    for (const issue of quality.malformed.examples) {
      lines.push(`- line ${issue.lineNumber}: ${issue.reason} — \`${issue.excerpt}\``);
    }
    lines.push('');
  }

  lines.push('### Confounder coverage (over schema-valid rows)');
  lines.push('');
  lines.push(
    mdTable(
      ['Confounder', 'Coverage'],
      Object.entries(quality.confounderCoverage).map(([name, metric]) =>
        coverageRow(name, metric),
      ),
    ),
  );
  lines.push('');

  lines.push('### Propensity provenance histogram');
  lines.push('');
  const provenanceEntries = Object.entries(quality.propensityProvenanceHistogram);
  if (provenanceEntries.length === 0) {
    lines.push('_No schema-valid rows, so no provenance distribution to report._');
  } else {
    lines.push(
      mdTable(
        ['Provenance', 'Rows'],
        provenanceEntries.map(([key, value]) => [key, String(value)]),
      ),
    );
  }
  lines.push('');

  lines.push('### Menu integrity');
  lines.push('');
  lines.push(
    mdTable(
      ['Metric', 'Value'],
      [
        ['Rows with a toolMenu snapshot', String(quality.menuIntegrity.rowsWithToolMenu)],
        [
          'Rows with both toolMenu.toolNames and availableTools',
          String(quality.menuIntegrity.rowsWithMirrorFields),
        ],
        ['Mirror-consistent rows', String(quality.menuIntegrity.mirrorConsistent)],
        ['Mirror consistency', fmtPct(quality.menuIntegrity.mirrorConsistencyPct)],
        [
          'Menu digest coverage (joined coding rows)',
          fmtPct(quality.codingCohort.menuDigestCoveragePct),
        ],
      ],
    ),
  );
  lines.push('');

  lines.push('### Outcome join diagnostics');
  lines.push('');
  lines.push(
    mdTable(
      ['Metric', 'Value'],
      [
        ['Join candidates (valid + lenient rows)', String(quality.join.candidates)],
        ['Joined', `${quality.join.joined} (${fmtPct(quality.join.joinedPct)})`],
        [
          'Unjoinable by construction (review/branch-keyed sessions)',
          String(quality.join.byConstruction),
        ],
        ['— of which review sessions', String(quality.join.reviewSessions)],
        ['— of which unrecognized session ids', String(quality.join.unparsedSessionIds)],
        ['Unjoinable: no matching eval record', String(quality.join.missingEval)],
        ['Unjoinable: ambiguous eval records', String(quality.join.ambiguous)],
        ['Joined without a model match', String(quality.join.modelMismatched)],
      ],
    ),
  );
  if (quality.join.examples.byConstruction.length > 0) {
    lines.push('', 'Examples (by construction):');
    for (const example of quality.join.examples.byConstruction) lines.push(`- \`${example}\``);
  }
  if (quality.join.examples.missingEval.length > 0) {
    lines.push('', 'Examples (no matching eval record):');
    for (const example of quality.join.examples.missingEval) lines.push(`- \`${example}\``);
  }
  if (quality.join.examples.ambiguous.length > 0) {
    lines.push('', 'Examples (ambiguous):');
    for (const example of quality.join.examples.ambiguous) lines.push(`- \`${example}\``);
  }
  lines.push('');

  lines.push('### Coding-stage analysis cohort');
  lines.push('');
  lines.push(
    mdTable(
      ['Metric', 'Value'],
      [
        ['Coding tool_call/forced_tool_call rows', String(quality.codingCohort.toolRows)],
        [
          'Joined rows',
          `${quality.codingCohort.joinedToolRows} (${fmtPct(quality.codingCohort.joinedPct)})`,
        ],
        ['Distinct models among joined rows', quality.codingCohort.models.join(', ') || '—'],
        ['Distinct sessions among joined rows', String(quality.codingCohort.distinctSessions)],
        [
          'Success rate (joined rows)',
          fmtPct(
            quality.codingCohort.successRate === null
              ? null
              : quality.codingCohort.successRate * 100,
          ),
        ],
        ['Menu digest coverage', fmtPct(quality.codingCohort.menuDigestCoveragePct)],
        ['Mirror consistency', fmtPct(quality.codingCohort.mirrorConsistencyPct)],
        ['Rows with unparseable timestamps', String(quality.codingCohort.timestampParseFailures)],
        [
          'Exact-provenance rows with a filled distribution',
          String(quality.codingCohort.exactRowsWithDistribution),
        ],
        ...TIER_ORDER.map(
          (tier) =>
            [`Joined rows — ${tier} provenance`, String(quality.codingCohort.perTierJoined[tier])] as string[],
        ),
      ],
    ),
  );
  lines.push('');

  lines.push('### Eval outcome index');
  lines.push('');
  lines.push(
    mdTable(
      ['Metric', 'Value'],
      [
        ['Evals path', quality.evalIndex.path || input.evalsPath],
        ['Evals file present', quality.evalIndex.fileMissing ? 'no' : 'yes'],
        ['Eval records indexed', String(quality.evalIndex.records)],
        ['Malformed eval lines', String(quality.evalIndex.malformed)],
        ['Eval rows without issueId', String(quality.evalIndex.withoutIssueId)],
        [
          'Literal `_c` issueId suffix normalizations',
          String(quality.evalIndex.literalSuffixNormalizations),
        ],
      ],
    ),
  );
  lines.push('');

  if ((input.notes ?? []).length > 0) {
    lines.push('### Operator context notes');
    lines.push('');
    for (const note of input.notes ?? []) {
      lines.push(`- ${note}`);
    }
    lines.push('');
  }

  // ---- Results -------------------------------------------------------------
  lines.push('## Results');
  lines.push('');
  if (analysis.skipped) {
    lines.push(
      `The pre-registered coverage gates failed, so no signal estimates were produced. ${
        analysis.skipReason ?? ''
      }`,
    );
    lines.push('');
    lines.push(
      'Per-stratum observational contrasts, the covariate-adjusted regression, the off-policy estimators, and all sensitivity checks are suppressed on this run. This is not a positive signal: it is an explicit statement that the corpus cannot currently support the gated analysis. The minimum additional capture needed to re-run is quantified in the “Minimum additional capture” section.',
    );
    lines.push('');
  } else {
    lines.push(
      `Analysis cohort: ${analysis.cohort.rows} joined coding tool rows across ${
        analysis.cohort.sessions
      } session(s) and ${analysis.cohort.models.length} model(s) (${
        analysis.cohort.models.join(', ') || '—'
      }); success rate ${fmtPct(
        analysis.cohort.successRate === null ? null : analysis.cohort.successRate * 100,
      )}.`,
    );
    lines.push('');
    for (const tier of analysis.tiers) {
      lines.push(`### Tier: ${tier.provenance} (n=${tier.rows})`);
      lines.push('');
      if (tier.rows === 0) {
        lines.push('_No rows in this tier._');
        lines.push('');
        continue;
      }
      if (tier.notReportableReason) {
        lines.push(`_${tier.notReportableReason}_`);
        lines.push('');
      }
      lines.push('Stratified success-rate contrasts (tool vs rest, within model × menu digest):');
      lines.push('');
      lines.push(formatTierContrastTable(tier));
      lines.push('');
      lines.push(
        `Covariate-adjusted logistic regression${
          tier.adjusted.referenceTool ? ` (reference tool: ${tier.adjusted.referenceTool})` : ''
        }:`,
      );
      lines.push('');
      if (!tier.adjusted.estimable) {
        lines.push('_Not estimable._');
      } else {
        lines.push(formatToolEffectTable(tier.adjusted.toolEffects));
      }
      if (tier.adjusted.notes.length > 0) {
        lines.push('');
        for (const note of tier.adjusted.notes) lines.push(`- note: ${note}`);
      }
      lines.push('');
      if (tier.stratumFits.length > 0) {
        lines.push(
          'Stratum-level adjusted fits (model × menu digest; effects are relative to the tier reference tool):',
        );
        lines.push('');
        lines.push(
          mdTable(
            ['Model', 'Menu digest', 'n', 'Estimable', 'Effects with 95% CI excluding zero'],
            tier.stratumFits.map((fit) => [
              fit.model,
              fit.menuDigest,
              String(fit.n),
              fit.estimable ? 'yes' : 'no',
              fit.toolEffects
                .filter((effect) => effect.excludesZero)
                .map(
                  (effect) =>
                    `${effect.tool}: ${fmtNum(effect.coefficient)} [${fmtNum(
                      effect.ciLo,
                    )}, ${fmtNum(effect.ciHi)}]`,
                )
                .join('; ') || 'none',
            ]),
          ),
        );
        lines.push('');
      }
    }
    const exactTier = analysis.tiers.find((tier) => tier.provenance === 'exact');
    lines.push('### Off-policy estimates (exact-provenance tier only)');
    lines.push('');
    if (!exactTier || exactTier.offPolicy.length === 0) {
      lines.push(
        `_${
          exactTier?.offPolicyNote ??
          'not estimable on this run: no exact-provenance rows with a filled propensity distribution'
        }._`,
      );
    } else {
      lines.push(
        mdTable(
          [
            'Method',
            'Baseline tool',
            'n',
            'Observed value',
            'Baseline-policy value',
            'Value of choice',
            '95% CI',
          ],
          exactTier.offPolicy.map((estimate) => [
            estimate.method.toUpperCase(),
            estimate.baselineTool,
            String(estimate.n),
            fmtNum(estimate.observedValue),
            fmtNum(estimate.baselineValue),
            fmtNum(estimate.valueOfChoice),
            `[${fmtNum(estimate.ciLo)}, ${fmtNum(estimate.ciHi)}]`,
          ]),
        ),
      );
      for (const note of exactTier.offPolicy[0]?.notes ?? []) {
        lines.push('', `- note: ${note}`);
      }
    }
    lines.push('');
  }

  // ---- Uncertainty & sensitivity ------------------------------------------
  lines.push('## Uncertainty & Sensitivity');
  lines.push('');
  if (analysis.skipped || analysis.tiers.length === 0) {
    lines.push('_Suppressed with the signal analysis (coverage gates failed)._');
    lines.push('');
  } else {
    const bootstrapped = analysis.tiers.filter((tier) => tier.bootstrap.length > 0);
    if (bootstrapped.length === 0) {
      lines.push('_No bootstrap intervals available._');
      for (const tier of analysis.tiers) {
        if (tier.bootstrapNote) lines.push(`- ${tier.provenance}: ${tier.bootstrapNote}`);
      }
      lines.push('');
    } else {
      lines.push('Seeded cluster bootstrap (resampling sessions) of adjusted tool coefficients:');
      lines.push('');
      for (const tier of bootstrapped) {
        lines.push(`- ${tier.provenance}:`);
        lines.push('');
        lines.push(
          mdTable(
            ['Tool', '2.5%', '97.5%', 'replicates'],
            tier.bootstrap.map((ci) => [
              ci.tool,
              fmtNum(ci.lo),
              fmtNum(ci.hi),
              String(ci.replicates),
            ]),
          ),
        );
        lines.push('');
      }
    }
    lines.push('Time-ordered holdout refits:');
    lines.push('');
    lines.push(
      mdTable(
        ['Tier', 'Train', 'Holdout', 'Excluded (bad timestamps)', 'Estimable', 'Note'],
        analysis.tiers
          .filter((tier) => tier.holdout !== undefined)
          .map((tier) => [
            tier.provenance,
            String(tier.holdout?.trainRows ?? 0),
            String(tier.holdout?.holdoutRows ?? 0),
            String(tier.holdout?.excludedUnparseableTimestamps ?? 0),
            tier.holdout?.estimable ? 'yes' : 'no',
            tier.holdout?.note ?? '—',
          ]),
      ),
    );
    lines.push('');
    lines.push('Leave-one-model-out sensitivity (sign of the tracked tool effect):');
    lines.push('');
    for (const tier of analysis.tiers) {
      if (tier.lomo.length === 0) continue;
      lines.push(`- ${tier.provenance}:`);
      lines.push('');
      lines.push(
        mdTable(
          ['Dropped model', 'n', 'Estimable', 'Tool signs'],
          tier.lomo.map((result) => [
            result.droppedModel,
            String(result.n),
            result.estimable ? 'yes' : 'no',
            result.toolSigns
              .map((sign) =>
                `${sign.tool}:${
                  sign.sign === null ? '?' : sign.sign > 0 ? '+' : sign.sign < 0 ? '−' : '0'
                }`)
              .join(', ') || '—',
          ]),
        ),
      );
      lines.push('');
    }
    const notes = analysis.tiers.flatMap((tier) =>
      tier.adjusted.notes.map((note) => `${tier.provenance}: ${note}`),
    );
    if (notes.length > 0) {
      lines.push('Estimability notes:');
      lines.push('');
      for (const note of notes) lines.push(`- ${note}`);
      lines.push('');
    }
  }

  // ---- Minimum additional capture ------------------------------------------
  if (recommendation.minimumAdditionalCapture) {
    lines.push('## Minimum additional capture');
    lines.push('');
    lines.push(
      'The pre-registered coverage gates failed, so no signal estimate was produced. This is not a positive signal. To re-run the gated analysis, capture at least:',
    );
    lines.push('');
    for (const target of recommendation.minimumAdditionalCapture.targets) {
      lines.push(`- ${target}`);
    }
    lines.push('');
  }

  // ---- Decision ------------------------------------------------------------
  lines.push('## Decision');
  lines.push('');
  lines.push(`Decision: ${DECISION_LABEL[decision]}`);
  lines.push('');
  lines.push(decisionReason);
  if (divergence) {
    lines.push('');
    lines.push(
      `Divergence note: the computed recommendation from the pre-registered gates is ${
        DECISION_LABEL[recommendation.decision]
      } (${recommendation.rationale[0] ?? 'no rationale recorded'}). The operator decision recorded above governs and is flagged for audit.`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
