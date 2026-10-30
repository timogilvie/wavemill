/**
 * HOK-3361 — Rework-risk cell label contract (`cell-0.1.0`).
 *
 * A derived-label stream that classifies WHERE the defect lived for every PR
 * the authoritative rework labeler (`cr-0.1.0`, HOK-3267) marks as reworked:
 * a fixed product space of review layer (form | local_meaning | wiring |
 * runtime | use) x lens (correctness | security | history | reversibility),
 * plus an explicit `unknown` outcome whenever the evidence cannot support a
 * cell.
 *
 * SEMANTIC BOUNDARY: this is an *interpretation* of a confirmed corrective
 * relationship, not another corrective detector. It never rewrites, re-derives,
 * or second-guesses the core rework fact — a cell row is only ever emitted for
 * a `cr-0.1.0` row the rework labeler already confirmed, and the source row is
 * referenced by version + canonical row hash, never re-linked here.
 *
 * The `cr-0.1.0` producer/reader (HOK-3267) is not landed in the tree yet; the
 * {@link CorrectivePairRowV0} shape below is the canonical corrective-pair
 * identity this labeller consumes. When HOK-3267 lands, its reader replaces
 * `loadCorrectivePairRows` in `cell-backfill.ts` — the pair identity shape is
 * the merge surface, so the labeler does not re-discover fix/original links.
 *
 * Precision over recall: `unknown` is a valid measured outcome. Never impute.
 * Raw prompts/diffs are never stored on a row — only stable references,
 * hashes, typed reason codes, and provenance.
 */

import { createHash } from 'node:crypto';

/** Contract version. Bump for ANY field/semantics change, however small. */
export const CELL_LABEL_SCHEMA_VERSION = '0.1.0';

/** Version of the authoritative rework label stream this labeller consumes. */
export const SOURCE_REWORK_LABEL_VERSION = 'cr-0.1.0';

/** Labeller implementation version stamped into every row's envelope. */
export const CELL_LABELLER_VERSION = '0.1.0';

/** Structural signal-extractor/classifier version (pure, no LLM). */
export const CELL_CLASSIFIER_VERSION = '0.1.0';

/** Review layer vocabulary — the fixed product space's rows. */
export const CELL_LAYERS = ['form', 'local_meaning', 'wiring', 'runtime', 'use'] as const;
export type CellLayer = (typeof CELL_LAYERS)[number];

/** Review lens vocabulary — the fixed product space's columns. */
export const CELL_LENSES = ['correctness', 'security', 'history', 'reversibility'] as const;
export type CellLens = (typeof CELL_LENSES)[number];

/** Typed reason codes — no free-form reason strings on the wire. */
export const CELL_REASON_CODES = [
  // structural classification outcomes
  'no_substrate',
  'ambiguous_signals',
  // LLM classification outcomes
  'llm_disabled',
  'llm_unavailable',
  'llm_malformed_response',
  'llm_invalid_cell',
  'llm_retries_exhausted',
  // decision composition
  'structural_unknown',
  'structural_llm_disagree',
  'structural_llm_agree',
  'llm_evidence_missing',
  // review/challenge evidence provenance (orthogonal enrichment)
  'no_stage_artifact',
  'feature_dir_missing',
  'stale_head_evidence',
  'head_identity_unverifiable',
  'execution_evidence_missing',
  'unpinned_execution_identity',
  'reviewer_run_evidence_backed',
  'challenge_run_evidence_backed',
] as const;
export type CellReasonCode = (typeof CELL_REASON_CODES)[number];

/** Reason codes valid on an explicit `unknown` chosen outcome. */
export const CELL_UNKNOWN_REASON_CODES = [
  'no_substrate',
  'ambiguous_signals',
  'llm_retries_exhausted',
] as const satisfies readonly CellReasonCode[];
export type CellUnknownReasonCode = (typeof CELL_UNKNOWN_REASON_CODES)[number];

/** A decided cell: the concrete (layer, lens) coordinate. */
export interface DecidedCell {
  kind: 'cell';
  layer: CellLayer;
  lens: CellLens;
}

/** The explicit unknown outcome — evidence could not support a cell. */
export interface UnknownCell {
  kind: 'unknown';
  /** One or more {@link CellUnknownReasonCode}s; never empty. */
  reason_codes: CellUnknownReasonCode[];
}

export type ChosenCell = DecidedCell | UnknownCell;

/** Deterministic structural decision over changed paths / diff structure. */
export interface CellStructuralOutcome {
  decided: boolean;
  layer: CellLayer | null;
  lens: CellLens | null;
  /** Ordered signal ids that fired, most significant first. */
  signals: string[];
  /** Non-empty exactly when `decided === false`. */
  reason_codes: CellReasonCode[];
}

/** Schema-constrained LLM second opinion/fallback over the corrective diff. */
export interface CellLlmOutcome {
  decided: boolean;
  layer: CellLayer | null;
  lens: CellLens | null;
  prompt_version: string;
  /** SHA-256 of the rendered prompt template (never the prompt body). */
  prompt_hash: string;
  /** SHA-256 of the diff text classified (never the diff itself). */
  diff_sha256: string;
  model: string | null;
  attempts: number;
  /** Failure/absence reasons; empty exactly when `decided === true`. */
  reason_codes: CellReasonCode[];
}

/** How the structural and LLM decisions relate. */
export type CellAgreement = 'agree' | 'disagree' | 'not_comparable';

/** One normalized reviewer/challenge run recovered from durable artifacts. */
export interface CellEvidenceRun {
  stage: string;
  /** Durable artifact the run was recovered from (stable relative path). */
  artifact: string;
  status: string;
  /** True only with a completed run, pinned execution identity, and a head SHA that is matching or untestable. */
  evidence_backed: boolean;
  executed_model: string | null;
  evidence_status: string | null;
  head_sha_match: 'match' | 'mismatch' | 'unknown';
  recorded_at: string | null;
}

/**
 * Review/challenge evidence for the ORIGINAL PR. Orthogonal enrichment: it is
 * never an input to cell assignment. Missing historical data is *unavailable*,
 * never proof that no reviewer ran.
 */
export interface CellReviewEvidence {
  coverage: 'available' | 'unavailable';
  reason_codes: CellReasonCode[];
  reviewer_runs: CellEvidenceRun[];
  challenge_runs: CellEvidenceRun[];
}

/** Everything a replay needs to reproduce the row deterministically. */
export interface CellReproducibilityEnvelope {
  schema_version: '0.1.0';
  labeller_version: string;
  classifier_version: string;
  prompt_version: string;
  source_label_version: 'cr-0.1.0';
  /** Canonical hash of the consumed `cr-0.1.0` row (identity, not content). */
  source_label_row_hash: string;
  corrective_head_sha: string | null;
  original_head_sha: string | null;
  computed_at: string;
}

/** Natural key: one label per (repo, original PR, corrective PR). */
export interface CellLabelKey {
  repo: string;
  original_pr_url: string;
  corrective_pr_url: string;
}

/** The full `cell-0.1.0` row. Append-only stream; latest computed_at wins. */
export interface CellLabelRowV0 {
  schema_version: '0.1.0';
  label_key: CellLabelKey;
  original_pr: { number: number; url: string; head_sha: string | null };
  corrective_pr: { number: number; url: string; head_sha: string | null; merged_at: string | null };
  chosen: ChosenCell;
  structural: CellStructuralOutcome;
  llm: CellLlmOutcome;
  agreement: CellAgreement;
  agreement_reason_codes: CellReasonCode[];
  review_evidence?: CellReviewEvidence;
  envelope: CellReproducibilityEnvelope;
}

/**
 * Canonical corrective-pair identity consumed from the authoritative `cr-0.1.0`
 * rework label stream (HOK-3267 merge surface). Only rows whose rework label
 * is 'reworked' feed the cell labeller; the labeller never re-links pairs.
 */
export interface CorrectivePairRowV0 {
  schema_version: 'cr-0.1.0';
  repo: string;
  original_pr: { number: number; url: string; head_sha: string | null };
  corrective_pr: { number: number; url: string; head_sha: string | null; merged_at: string | null };
  /** Confirmed rework outcome from the authoritative labeler. */
  label: string;
  /** Optional precomputed changed-path substrate; otherwise resolved from git. */
  changed_paths?: ChangedPath[];
}

/** One changed path with optional numstat-style magnitude. */
export interface ChangedPath {
  path: string;
  status?: 'added' | 'modified' | 'deleted' | 'renamed';
  additions?: number;
  deletions?: number;
}

/** Canonical-JSON serialize (recursively sorted keys, no whitespace). */
export function canonicalSerializeCellLabel(row: CellLabelRowV0): string {
  return JSON.stringify(canonicalize(row));
}

/** SHA-256 identity of a label row (used for source-row linkage and replay). */
export function canonicalHashCellLabel(row: CellLabelRowV0): string {
  return createHash('sha256').update(canonicalSerializeCellLabel(row), 'utf-8').digest('hex');
}

/** Canonical hash of a consumed `cr-0.1.0` source row (identity reference). */
export function canonicalHashCorrectivePairRow(row: CorrectivePairRowV0): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(row)), 'utf-8').digest('hex');
}

/** Natural key string for dedup/query: latest `computed_at` wins at read time. */
export function cellNaturalKey(row: CellLabelRowV0 | CellLabelKey): string {
  const key = 'label_key' in row ? row.label_key : row;
  return `${key.repo}\u0000${key.original_pr_url}\u0000${key.corrective_pr_url}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Validate a `cell-0.1.0` row structurally. Returns a list of problems; an
 * empty list means the row is well-formed. Pure — no I/O, no schema engine.
 */
export function validateCellLabelRow(row: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(row)) return ['row must be an object'];
  if (row.schema_version !== CELL_LABEL_SCHEMA_VERSION) {
    errors.push(`schema_version must be '${CELL_LABEL_SCHEMA_VERSION}'`);
  }
  const key = row.label_key;
  if (!isRecord(key) || typeof key.repo !== 'string' || !key.repo
    || typeof key.original_pr_url !== 'string' || !key.original_pr_url
    || typeof key.corrective_pr_url !== 'string' || !key.corrective_pr_url) {
    errors.push('label_key must carry non-empty repo, original_pr_url, corrective_pr_url');
  }
  validatePrRef(row.original_pr, 'original_pr', errors, false);
  validatePrRef(row.corrective_pr, 'corrective_pr', errors, true);

  const chosen = row.chosen;
  if (!isRecord(chosen)) {
    errors.push('chosen must be an object');
  } else if (chosen.kind === 'cell') {
    if (!isLayer(chosen.layer) || !isLens(chosen.lens)) {
      errors.push('chosen.kind=cell requires a valid layer and lens');
    }
  } else if (chosen.kind === 'unknown') {
    const codes = chosen.reason_codes;
    if (!Array.isArray(codes) || codes.length === 0
      || !codes.every((c) => isUnknownReason(c))) {
      errors.push('chosen.kind=unknown requires at least one unknown reason code');
    }
  } else {
    errors.push("chosen.kind must be 'cell' or 'unknown'");
  }

  validateOutcomeBlock(row.structural, 'structural', errors, true);
  const llm = row.llm;
  if (!isRecord(llm)) {
    errors.push('llm must be an object');
  } else {
    validateOutcomeBlock(llm, 'llm', errors, false);
    if (typeof llm.prompt_version !== 'string' || !llm.prompt_version) {
      errors.push('llm.prompt_version must be a non-empty string');
    }
    if (!isSha256(llm.prompt_hash) || !isSha256(llm.diff_sha256)) {
      errors.push('llm.prompt_hash and llm.diff_sha256 must be sha256 hex');
    }
    if (!Number.isInteger(llm.attempts) || (llm.attempts as number) < 0) {
      errors.push('llm.attempts must be a non-negative integer');
    }
  }

  const agreement = row.agreement;
  if (agreement !== 'agree' && agreement !== 'disagree' && agreement !== 'not_comparable') {
    errors.push('agreement must be agree | disagree | not_comparable');
  }
  if (!Array.isArray(row.agreement_reason_codes)) {
    errors.push('agreement_reason_codes must be an array');
  }

  const evidence = row.review_evidence;
  if (evidence !== undefined) {
    if (!isRecord(evidence) || (evidence.coverage !== 'available' && evidence.coverage !== 'unavailable')
      || !Array.isArray(evidence.reason_codes)
      || !Array.isArray(evidence.reviewer_runs) || !Array.isArray(evidence.challenge_runs)) {
      errors.push('review_evidence must carry coverage, reason_codes, reviewer_runs, challenge_runs');
    }
  }

  const envelope = row.envelope;
  if (!isRecord(envelope)) {
    errors.push('envelope must be an object');
  } else {
    if (envelope.schema_version !== CELL_LABEL_SCHEMA_VERSION) {
      errors.push(`envelope.schema_version must be '${CELL_LABEL_SCHEMA_VERSION}'`);
    }
    for (const field of ['labeller_version', 'classifier_version', 'prompt_version'] as const) {
      if (typeof envelope[field] !== 'string' || !(envelope[field] as string).length) {
        errors.push(`envelope.${field} must be a non-empty string`);
      }
    }
    if (envelope.source_label_version !== SOURCE_REWORK_LABEL_VERSION) {
      errors.push(`envelope.source_label_version must be '${SOURCE_REWORK_LABEL_VERSION}'`);
    }
    if (!isSha256(envelope.source_label_row_hash)) {
      errors.push('envelope.source_label_row_hash must be sha256 hex');
    }
    if (typeof envelope.computed_at !== 'string' || !envelope.computed_at) {
      errors.push('envelope.computed_at must be a non-empty ISO string');
    }
    if (!('corrective_head_sha' in envelope) || !('original_head_sha' in envelope)) {
      errors.push('envelope must carry corrective_head_sha and original_head_sha (string or null)');
    }
  }
  return errors;
}

function validatePrRef(
  pr: unknown,
  field: string,
  errors: string[],
  requireMergedAt: boolean,
): void {
  if (!isRecord(pr) || typeof pr.number !== 'number' || pr.number < 1
    || typeof pr.url !== 'string' || !pr.url
    || !('head_sha' in pr)) {
    errors.push(`${field} must carry number, url, head_sha`);
    return;
  }
  if (requireMergedAt && !('merged_at' in pr)) {
    errors.push(`${field}.merged_at is required (string or null)`);
  }
}

function validateOutcomeBlock(
  block: unknown,
  field: string,
  errors: string[],
  structural: boolean,
): void {
  if (!isRecord(block)) {
    errors.push(`${field} must be an object`);
    return;
  }
  if (typeof block.decided !== 'boolean') {
    errors.push(`${field}.decided must be boolean`);
    return;
  }
  if (block.decided) {
    if (!isLayer(block.layer) || !isLens(block.lens)) {
      errors.push(`${field}.decided=true requires a valid layer and lens`);
    }
    if (structural && !Array.isArray(block.signals)) {
      errors.push('structural.signals must be an array');
    }
  } else if (!Array.isArray(block.reason_codes) || block.reason_codes.length === 0) {
    errors.push(`${field}.decided=false requires non-empty reason_codes`);
  }
}

export function isLayer(value: unknown): value is CellLayer {
  return (CELL_LAYERS as readonly string[]).includes(value as string);
}

export function isLens(value: unknown): value is CellLens {
  return (CELL_LENSES as readonly string[]).includes(value as string);
}

function isUnknownReason(value: unknown): value is CellUnknownReasonCode {
  return (CELL_UNKNOWN_REASON_CODES as readonly string[]).includes(value as string);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Input to {@link buildCellLabelRow}; versions are stamped, decision composed. */
export interface BuildCellLabelRowInput {
  label_key: CellLabelKey;
  original_pr: { number: number; url: string; head_sha: string | null };
  corrective_pr: { number: number; url: string; head_sha: string | null; merged_at: string | null };
  structural: CellStructuralOutcome;
  llm: CellLlmOutcome;
  review_evidence?: CellReviewEvidence;
  envelope: Omit<CellReproducibilityEnvelope, 'schema_version' | 'labeller_version' | 'classifier_version' | 'source_label_version'>;
  /** Override only when replaying a historical labeller version. */
  labellerVersion?: string;
  classifierVersion?: string;
}

/**
 * Compose the chosen cell from the structural decision (first) and the LLM
 * decision (second opinion / fallback), stamp contract versions, and derive
 * agreement. Deterministic and pure.
 *
 * Precedence: a decided structural cell wins (LLM disagreement is flagged,
 * never silently obeyed). Structural unknown + LLM decided → the LLM fallback
 * cell, flagged `structural_unknown` on the agreement channel. Both undecided
 * → explicit unknown with the structural reason (LLM failure reason appended).
 */
export function buildCellLabelRow(input: BuildCellLabelRowInput): CellLabelRowV0 {
  let chosen: ChosenCell;
  let agreement: CellAgreement;
  const agreementReasons: CellReasonCode[] = [];

  if (input.structural.decided && input.llm.decided) {
    const same = input.structural.layer === input.llm.layer && input.structural.lens === input.llm.lens;
    agreement = same ? 'agree' : 'disagree';
    agreementReasons.push(same ? 'structural_llm_agree' : 'structural_llm_disagree');
    chosen = { kind: 'cell', layer: input.structural.layer as CellLayer, lens: input.structural.lens as CellLens };
  } else if (input.structural.decided) {
    agreement = 'not_comparable';
    agreementReasons.push('llm_evidence_missing', ...input.llm.reason_codes);
    chosen = { kind: 'cell', layer: input.structural.layer as CellLayer, lens: input.structural.lens as CellLens };
  } else if (input.llm.decided) {
    agreement = 'not_comparable';
    agreementReasons.push('structural_unknown', ...input.structural.reason_codes);
    chosen = { kind: 'cell', layer: input.llm.layer as CellLayer, lens: input.llm.lens as CellLens };
  } else {
    agreement = 'not_comparable';
    agreementReasons.push('structural_unknown', ...input.structural.reason_codes);
    chosen = {
      kind: 'unknown',
      reason_codes: dedupe([
        ...pickUnknownReasons(input.structural.reason_codes),
        ...pickUnknownReasons(input.llm.reason_codes),
      ]),
    };
  }

  const row: CellLabelRowV0 = {
    schema_version: CELL_LABEL_SCHEMA_VERSION,
    label_key: input.label_key,
    original_pr: input.original_pr,
    corrective_pr: input.corrective_pr,
    chosen,
    structural: input.structural,
    llm: input.llm,
    agreement,
    agreement_reason_codes: dedupe(agreementReasons),
    envelope: {
      ...input.envelope,
      schema_version: CELL_LABEL_SCHEMA_VERSION,
      labeller_version: input.labellerVersion ?? CELL_LABELLER_VERSION,
      classifier_version: input.classifierVersion ?? CELL_CLASSIFIER_VERSION,
      source_label_version: SOURCE_REWORK_LABEL_VERSION,
    },
  };
  if (input.review_evidence !== undefined) {
    row.review_evidence = input.review_evidence;
  }
  return row;
}

function pickUnknownReasons(codes: CellReasonCode[]): CellUnknownReasonCode[] {
  return codes.filter((code): code is CellUnknownReasonCode => isUnknownReason(code));
}

function dedupe<T>(values: T[]): T[] {
  return [...new Set(values)];
}