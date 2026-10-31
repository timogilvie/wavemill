/**
 * Bounded, schema-constrained LLM cell-classification adapter (HOK-3361).
 *
 * The LLM is the second opinion / fallback only — the structural classifier
 * decides first. The response must be a JSON object of exactly
 * `{ "layer": <CellLayer>, "lens": <CellLens> }`; anything else is a typed
 * failure, retried a bounded number of times, and finally recorded as an
 * explicit reason — never silently substituted with the structural result.
 *
 * Raw prompts and diffs are never persisted: only their SHA-256 hashes and a
 * prompt version. When the HOK-3341 integration labeler lands, its prompt
 * construction/validation and deterministic retry conventions replace the
 * local ones here; the adapter boundary (deps.classify) is the merge surface.
 */

import { createHash } from 'node:crypto';
import {
  CELL_LAYERS,
  CELL_LENSES,
  type CellLayer,
  type CellLens,
  type CellLlmOutcome,
  type CellReasonCode,
} from './cell-label-contract.ts';

/** Version of the rendered classification prompt (bump on prompt change). */
export const CELL_LLM_PROMPT_VERSION = 'cell-llm-0.1.0';

/** Default bounded attempt budget for the classification call. */
export const CELL_LLM_MAX_ATTEMPTS = 2;

/** Injectable LLM boundary: prompt in, raw model response string out. */
export type CellLlmClassify = (prompt: string) => Promise<string>;

export interface CellLlmDeps {
  /** Performs one LLM call; throws when the provider is unavailable. */
  classify: CellLlmClassify;
  /** Model identity recorded on the outcome (provenance only). */
  model?: string;
}

/**
 * Render the schema-constrained classification prompt over the corrective
 * diff. Kept small and deterministic; the full diff is an input, never stored.
 */
export function buildCellPrompt(input: { diff: string; repoHint?: string }): string {
  const repoLine = input.repoHint ? `Repository context: ${input.repoHint}\n` : '';
  return [
    'You classify where a defect lived in a corrective (fix) change.',
    repoLine,
    'Choose exactly one review layer and one review lens for the defect.',
    `Layers: ${CELL_LAYERS.join(' | ')}`,
    `Lenses: ${CELL_LENSES.join(' | ')}`,
    'Respond with ONLY a JSON object: {"layer": "<layer>", "lens": "<lens>"}',
    '',
    'Corrective diff:',
    input.diff,
  ].filter((part) => part !== '').join('\n');
}

/** SHA-256 of the prompt template actually sent (provenance, not content). */
export function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf-8').digest('hex');
}

/** SHA-256 of the diff text classified (identity reference, never stored raw). */
export function hashDiff(diff: string): string {
  return createHash('sha256').update(diff, 'utf-8').digest('hex');
}

/**
 * Parse and validate one model response against the schema constraint.
 * Returns the cell or the typed failure reason.
 */
export function parseCellLlmResponse(raw: string):
  | { ok: true; layer: CellLayer; lens: CellLens }
  | { ok: false; reason: CellReasonCode } {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'llm_malformed_response' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'llm_malformed_response' };
  }
  const record = parsed as Record<string, unknown>;
  const extraKeys = Object.keys(record).filter((key) => key !== 'layer' && key !== 'lens');
  if (extraKeys.length > 0 || !isLayerValue(record.layer) || !isLensValue(record.lens)) {
    return { ok: false, reason: 'llm_invalid_cell' };
  }
  return { ok: true, layer: record.layer, lens: record.lens };
}

function isLayerValue(value: unknown): value is CellLayer {
  return (CELL_LAYERS as readonly string[]).includes(value as string);
}

function isLensValue(value: unknown): value is CellLens {
  return (CELL_LENSES as readonly string[]).includes(value as string);
}

/**
 * Run the bounded LLM classification over the corrective diff.
 *
 * Deterministic retry/error conventions: a transport failure records
 * `llm_unavailable`; a response that fails parse/validation records
 * `llm_malformed_response` / `llm_invalid_cell`; after the bounded budget the
 * outcome is undecided with `llm_retries_exhausted` plus the last failure.
 * The caller decides whether an undecided LLM means fallback or abstention —
 * this adapter never invents a cell.
 */
export async function classifyCellWithLlm(input: {
  diff: string;
  deps: CellLlmDeps;
  maxAttempts?: number;
}): Promise<CellLlmOutcome> {
  const maxAttempts = Math.max(1, input.maxAttempts ?? CELL_LLM_MAX_ATTEMPTS);
  const prompt = buildCellPrompt({ diff: input.diff });
  const base: Omit<CellLlmOutcome, 'decided' | 'layer' | 'lens' | 'reason_codes'> = {
    prompt_version: CELL_LLM_PROMPT_VERSION,
    prompt_hash: hashPrompt(prompt),
    diff_sha256: hashDiff(input.diff),
    model: input.deps.model ?? null,
    attempts: 0,
  };
  let lastReason: CellReasonCode = 'llm_unavailable';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const raw = await input.deps.classify(prompt);
      const parsed = parseCellLlmResponse(raw);
      if (parsed.ok) {
        return { ...base, attempts: attempt, decided: true, layer: parsed.layer, lens: parsed.lens, reason_codes: [] };
      }
      lastReason = parsed.reason;
    } catch {
      lastReason = 'llm_unavailable';
    }
  }
  return {
    ...base,
    attempts: maxAttempts,
    decided: false,
    layer: null,
    lens: null,
    reason_codes: maxAttempts > 1
      ? ['llm_retries_exhausted', lastReason]
      : [lastReason],
  };
}

/**
 * The explicit no-LLM outcome used by deterministic backfills: LLM evidence
 * is recorded as absent with a typed reason, never substituted.
 */
export function disabledCellLlmOutcome(diffSha256: string): CellLlmOutcome {
  return {
    decided: false,
    layer: null,
    lens: null,
    prompt_version: CELL_LLM_PROMPT_VERSION,
    prompt_hash: hashPrompt(buildCellPrompt({ diff: '' })),
    diff_sha256: diffSha256,
    model: null,
    attempts: 0,
    reason_codes: ['llm_disabled'],
  };
}