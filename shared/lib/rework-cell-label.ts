/**
 * Rework Risk: cell-0.1.0 derived rework-risk label contract (HOK-3361).
 *
 * Classifies where a defect corrected by a rework PR lived across the product space:
 *   layer (form, local_meaning, wiring, runtime, use) x
 *   lens (correctness, security, history, reversibility)
 * plus an explicit 'unknown' outcome.
 *
 * Semantic boundary: this is an append-only derived interpretation over the
 * authoritative cr-0.1.0 corrective/rework rows. It never rewrites the core
 * rework fact. Latest row for the versioned natural key wins at query time.
 */

import { createHash } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

export const CELL_LABEL_SCHEMA_VERSION = '0.1.0';
export const DEFAULT_CELL_LABELLER_VERSION = '0.1.0';
export const DEFAULT_RULES_VERSION = '0.1.0';
export const DEFAULT_PROMPT_VERSION = '0.1.0';

export const REVIEW_LAYERS = [
  'form',
  'local_meaning',
  'wiring',
  'runtime',
  'use',
] as const;
export type ReviewLayer = (typeof REVIEW_LAYERS)[number];

export const REVIEW_LENSES = [
  'correctness',
  'security',
  'history',
  'reversibility',
] as const;
export type ReviewLens = (typeof REVIEW_LENSES)[number];

export type LayerOutcome = ReviewLayer | 'unknown';
export type LensOutcome = ReviewLens | 'unknown';

export const CELL_REASON_CODES = [
  'structural_signal_confident',
  'structural_signal_heuristic',
  'structural_ambiguous_signals',
  'structural_insufficient_substrate',
  'llm_concurrence',
  'llm_disagreement',
  'llm_fallback_used',
  'llm_malformed_response',
  'llm_unavailable',
  'llm_refusal',
  'llm_skipped_offline',
  'both_unknown',
  'structural_override',
  'owner_dispute',
  'missing_corrective_diff',
  'clean_agreement',
] as const;
export type CellReasonCode = (typeof CELL_REASON_CODES)[number];

export type CellConfidence = 'high' | 'medium' | 'low' | 'none';

export type DisagreementState =
  | 'agree'
  | 'disagree'
  | 'structural_only'
  | 'llm_only'
  | 'both_unknown'
  | 'llm_failed';

export type EvidenceProvenance = 'direct' | 'archived' | 'partial' | 'unavailable';

export interface PrRef {
  number: number;
  url: string;
  head_sha: string;
  merge_commit_sha?: string | null;
  title?: string;
}

export interface SourceReworkLabel {
  version: string;
  rework_id: string;
}

export interface CellDecision {
  layer: LayerOutcome;
  lens: LensOutcome;
  cell: string;
}

export interface StructuralOutcome extends CellDecision {
  confidence: CellConfidence;
  matched_rules: string[];
}

export interface LlmOutcome extends CellDecision {
  explanation?: string;
  raw_response?: string;
  error?: string;
}

export interface ReviewEvidence {
  reviewers_run: string[];
  challenge_stages: string[];
  provenance: EvidenceProvenance;
  coverage_flags: string[];
  notes?: string[];
}

export interface ReproducibilityEnvelope {
  schema_version: '0.1.0';
  labeller_version: string;
  rules_version: string;
  prompt_version: string;
  model: string | null;
  diff_hash: string;
  computed_at: string;
}

export interface ReworkCellLabelV1 {
  schema_version: '0.1.0';
  source_rework_label: SourceReworkLabel;
  original_pr: PrRef;
  corrective_pr: PrRef;
  chosen: CellDecision;
  structural: StructuralOutcome;
  llm: LlmOutcome | null;
  agreement: boolean;
  disagreement_state: DisagreementState;
  reason_codes: CellReasonCode[];
  review_evidence: ReviewEvidence;
  envelope: ReproducibilityEnvelope;
}

/** Formats layer and lens into a canonical cell identifier (e.g. 'wiring:correctness' or 'unknown'). */
export function formatCell(layer: LayerOutcome, lens: LensOutcome): string {
  if (layer === 'unknown' || lens === 'unknown') {
    return 'unknown';
  }
  return `${layer}:${lens}`;
}

/** Parses a cell identifier into layer and lens. */
export function parseCell(cellStr: string): { layer: LayerOutcome; lens: LensOutcome } {
  if (!cellStr || cellStr === 'unknown') {
    return { layer: 'unknown', lens: 'unknown' };
  }
  const parts = cellStr.split(':');
  if (parts.length === 2) {
    const layer = (REVIEW_LAYERS as readonly string[]).includes(parts[0])
      ? (parts[0] as ReviewLayer)
      : 'unknown';
    const lens = (REVIEW_LENSES as readonly string[]).includes(parts[1])
      ? (parts[1] as ReviewLens)
      : 'unknown';
    return { layer, lens };
  }
  return { layer: 'unknown', lens: 'unknown' };
}

/** SHA256 of text or buffer. */
export function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Canonical natural key for a corrective rework relationship. */
export function reworkCellNaturalKey(
  label: Pick<ReworkCellLabelV1, 'source_rework_label' | 'original_pr' | 'corrective_pr'>,
): string {
  if (label.source_rework_label?.rework_id) {
    return label.source_rework_label.rework_id;
  }
  return `cr:${label.original_pr.number}:${label.corrective_pr.number}`;
}

// ── Schema Validation ────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, '../schemas/rework-cell-label.schema.json');

let _validator: ReturnType<Ajv2020['compile']> | null = null;

function getValidator(): ReturnType<Ajv2020['compile']> {
  if (!_validator) {
    const schemaText = readFileSync(SCHEMA_PATH, 'utf-8');
    const schema = JSON.parse(schemaText) as Record<string, unknown>;
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    _validator = ajv.compile(schema);
  }
  return _validator;
}

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

export function validateReworkCellLabel(value: unknown): ValidationResult {
  const validate = getValidator();
  const valid = Boolean(validate(value));
  if (valid) {
    return { valid: true };
  }
  const errors = (validate.errors ?? []).map(
    (err) => `${err.instancePath || '/'}: ${err.message ?? 'validation error'}`,
  );
  return { valid: false, errors };
}

// ── Deduplication and Storage ────────────────────────────────────────────────

/**
 * Deduplicate an array of rework cell labels by natural key.
 * Latest `computed_at` wins. In case of equal timestamps, latest in array order wins.
 */
export function deduplicateReworkCellLabels(labels: readonly ReworkCellLabelV1[]): ReworkCellLabelV1[] {
  const byKey = new Map<string, { label: ReworkCellLabelV1; order: number }>();

  labels.forEach((label, idx) => {
    const key = reworkCellNaturalKey(label);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { label, order: idx });
      return;
    }

    const currentEpoch = Date.parse(label.envelope.computed_at);
    const existingEpoch = Date.parse(existing.label.envelope.computed_at);

    if (isNaN(currentEpoch) || isNaN(existingEpoch)) {
      if (idx >= existing.order) {
        byKey.set(key, { label, order: idx });
      }
    } else if (currentEpoch > existingEpoch || (currentEpoch === existingEpoch && idx > existing.order)) {
      byKey.set(key, { label, order: idx });
    }
  });

  return Array.from(byKey.values())
    .sort((a, b) => a.order - b.order)
    .map((entry) => entry.label);
}

/** Parses lines of JSONL into validated ReworkCellLabelV1 records. */
export function parseReworkCellLabelsJsonl(jsonlText: string): {
  records: ReworkCellLabelV1[];
  errors: { line: number; error: string }[];
} {
  const lines = jsonlText.split('\n');
  const records: ReworkCellLabelV1[] = [];
  const errors: { line: number; error: string }[] = [];

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const validation = validateReworkCellLabel(parsed);
      if (validation.valid) {
        records.push(parsed as ReworkCellLabelV1);
      } else {
        errors.push({
          line: index + 1,
          error: `Schema validation failed: ${validation.errors?.join('; ')}`,
        });
      }
    } catch (err) {
      errors.push({
        line: index + 1,
        error: `JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  return { records, errors };
}

/** Serialize a label record to a single-line JSON string without formatting. */
export function serializeReworkCellLabel(label: ReworkCellLabelV1): string {
  return JSON.stringify(label);
}

/** Append a single rework cell label to a file. */
export async function appendReworkCellLabel(filePath: string, label: ReworkCellLabelV1): Promise<void> {
  const line = serializeReworkCellLabel(label) + '\n';
  await appendFile(filePath, line, 'utf-8');
}

/** Reads a JSONL file and returns deduplicated records. */
export async function readReworkCellLabelsFromFile(filePath: string): Promise<ReworkCellLabelV1[]> {
  const content = await readFile(filePath, 'utf-8');
  const { records } = parseReworkCellLabelsJsonl(content);
  return deduplicateReworkCellLabels(records);
}
