/**
 * Shared fixtures for the cell-0.1.0 label tests (HOK-3361).
 *
 * Lives in tests/lib (not inside a *.test.ts) so importing it does not
 * re-register another file's suite — node --test runs every imported test
 * file's describe blocks in the importer's process too.
 */
import {
  buildCellLabelRow,
  type CellLayer,
  type CellLens,
  type CellLlmOutcome,
  type CellStructuralOutcome,
} from '../../shared/lib/cell-label-contract.ts';

export function decidedStructural(layer: CellLayer = 'wiring', lens: CellLens = 'correctness'): CellStructuralOutcome {
  return { decided: true, layer, lens, signals: ['config_or_wiring'], reason_codes: [] } as CellStructuralOutcome;
}

export function undecidedStructural(reason = 'ambiguous_signals'): CellStructuralOutcome {
  return {
    decided: false,
    layer: null,
    lens: null,
    signals: ['migration_schema', 'config_or_wiring'],
    reason_codes: [reason],
  } as CellStructuralOutcome;
}

export function decidedLlm(layer: CellLayer = 'wiring', lens: CellLens = 'correctness'): CellLlmOutcome {
  return {
    decided: true,
    layer,
    lens,
    prompt_version: 'cell-llm-0.1.0',
    prompt_hash: 'a'.repeat(64),
    diff_sha256: 'b'.repeat(64),
    model: 'test-model',
    attempts: 1,
    reason_codes: [],
  };
}

export function undecidedLlm(reason: CellLlmOutcome['reason_codes'][number] = 'llm_disabled'): CellLlmOutcome {
  return {
    decided: false,
    layer: null,
    lens: null,
    prompt_version: 'cell-llm-0.1.0',
    prompt_hash: 'a'.repeat(64),
    diff_sha256: 'b'.repeat(64),
    model: null,
    attempts: 0,
    reason_codes: [reason],
  };
}

export interface CellTestRowOverrides {
  structural?: CellStructuralOutcome;
  llm?: CellLlmOutcome;
  computedAt?: string;
  repo?: string;
  originalUrl?: string;
  correctiveUrl?: string;
}

export function buildTestRow(overrides: CellTestRowOverrides = {}) {
  const originalUrl = overrides.originalUrl ?? 'https://github.com/owner/repo/pull/10';
  const correctiveUrl = overrides.correctiveUrl ?? 'https://github.com/owner/repo/pull/11';
  return buildCellLabelRow({
    label_key: { repo: overrides.repo ?? 'owner/repo', original_pr_url: originalUrl, corrective_pr_url: correctiveUrl },
    original_pr: { number: 10, url: originalUrl, head_sha: 'c'.repeat(40) },
    corrective_pr: { number: 11, url: correctiveUrl, head_sha: 'd'.repeat(40), merged_at: '2026-01-02T00:00:00Z' },
    structural: overrides.structural ?? decidedStructural(),
    llm: overrides.llm ?? decidedLlm(),
    envelope: {
      prompt_version: 'cell-llm-0.1.0',
      source_label_row_hash: 'e'.repeat(64),
      corrective_head_sha: 'd'.repeat(40),
      original_head_sha: 'c'.repeat(40),
      computed_at: overrides.computedAt ?? '2026-02-01T00:00:00Z',
    },
  });
}