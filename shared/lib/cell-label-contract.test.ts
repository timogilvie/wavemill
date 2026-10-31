/**
 * Contract test for the `cell-0.1.0` rework-risk cell label (HOK-3361).
 *
 * Pattern follows arbiter-survival-label.test.ts: producer output validates
 * against the JSON Schema at shared/schemas/cell-label.schema.json, and the
 * builder/decision composition is pinned here so the interpretation stream
 * cannot drift into silently rewriting the core rework fact.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  CELL_LABEL_SCHEMA_VERSION,
  CELL_REASON_CODES,
  canonicalHashCellLabel,
  canonicalHashCorrectivePairRow,
  canonicalSerializeCellLabel,
  cellNaturalKey,
  validateCellLabelRow,
} from './cell-label-contract.ts';
import { buildTestRow, decidedLlm, decidedStructural, undecidedLlm, undecidedStructural } from '../../tests/lib/cell-label-fixtures.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(__dirname, '../schemas/cell-label.schema.json'), 'utf-8')) as Record<string, unknown>;
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateSchema = ajv.compile(schema);

describe('cell-0.1.0 contract', () => {
  it('protects: producer rows must validate against the frozen JSON schema', () => {
    const row = buildTestRow();
    assert.equal(row.schema_version, CELL_LABEL_SCHEMA_VERSION);
    assert.equal(validateSchema(row), true, JSON.stringify(validateSchema.errors));
  });

  it('protects: an unknown chosen outcome must carry an unknown reason code', () => {
    const row = buildTestRow({ structural: undecidedStructural('ambiguous_signals'), llm: undecidedLlm('llm_disabled') });
    assert.equal(row.chosen.kind, 'unknown');
    assert.deepEqual(row.chosen.kind === 'unknown' ? row.chosen.reason_codes : [], ['ambiguous_signals']);
    assert.equal(validateSchema(row), true, JSON.stringify(validateSchema.errors));
  });

  it('protects: unknown must not be emitted with a non-unknown reason code', () => {
    const row = buildTestRow({ structural: undecidedStructural('no_substrate'), llm: undecidedLlm('llm_disabled') });
    const broken = { ...row, chosen: { kind: 'unknown', reason_codes: ['llm_disabled'] } };
    assert.equal(validateSchema(broken), false);
  });

  it('protects: structural wins over a disagreeing LLM, and the disagreement is flagged', () => {
    const row = buildTestRow({ structural: decidedStructural('runtime', 'reversibility'), llm: decidedLlm('wiring', 'correctness') });
    assert.equal(row.chosen.kind, 'cell');
    assert.equal(row.agreement, 'disagree');
    assert.ok(row.agreement_reason_codes.includes('structural_llm_disagree'));
    if (row.chosen.kind === 'cell') {
      assert.equal(row.chosen.layer, 'runtime');
      assert.equal(row.chosen.lens, 'reversibility');
    }
  });

  it('protects: agreement is agree only when both decided cells match', () => {
    const row = buildTestRow();
    assert.equal(row.agreement, 'agree');
    assert.ok(row.agreement_reason_codes.includes('structural_llm_agree'));
  });

  it('protects: structural unknown with a decided LLM falls back to the LLM cell, flagged not_comparable', () => {
    const row = buildTestRow({ structural: undecidedStructural('no_substrate'), llm: decidedLlm('use', 'correctness') });
    assert.equal(row.chosen.kind, 'cell');
    assert.equal(row.agreement, 'not_comparable');
    assert.ok(row.agreement_reason_codes.includes('structural_unknown'));
  });

  it('protects: LLM disagreement must never silently become the chosen cell', () => {
    const row = buildTestRow({ structural: decidedStructural(), llm: decidedLlm('runtime', 'security') });
    assert.notDeepEqual(row.chosen, { kind: 'cell', layer: 'runtime', lens: 'security' });
  });

  it('protects: canonical serialization is insertion-order independent and hash-stable', () => {
    const a = buildTestRow();
    const b = JSON.parse(JSON.stringify(a));
    const reordered: Record<string, unknown> = {};
    for (const key of Object.keys(b).reverse()) reordered[key] = b[key];
    assert.equal(canonicalHashCellLabel(reordered as never), canonicalHashCellLabel(a));
    assert.notEqual(
      canonicalHashCellLabel(a),
      canonicalHashCellLabel({ ...a, chosen: { kind: 'unknown', reason_codes: ['no_substrate'] } }),
    );
  });

  it('protects: canonicalSerialize emits compact sorted-key JSON', () => {
    const serialized = canonicalSerializeCellLabel(buildTestRow());
    assert.ok(!serialized.includes(' '));
    assert.ok(serialized.startsWith('{"agreement"'));
  });

  it('protects: the natural key is (repo, original, corrective)', () => {
    const row = buildTestRow();
    assert.equal(cellNaturalKey(row), cellNaturalKey(row.label_key));
    const other = buildTestRow({ correctiveUrl: 'https://github.com/owner/repo/pull/12' });
    assert.notEqual(cellNaturalKey(row), cellNaturalKey(other));
  });

  it('protects: the source rework row is referenced by hash, not re-linked', () => {
    const crRow = {
      schema_version: 'cr-0.1.0',
      repo: 'owner/repo',
      original_pr: { number: 10, url: 'https://github.com/owner/repo/pull/10', head_sha: null },
      corrective_pr: { number: 11, url: 'https://github.com/owner/repo/pull/11', head_sha: null, merged_at: null },
      label: 'reworked',
    } as const;
    assert.equal(canonicalHashCorrectivePairRow(crRow), canonicalHashCorrectivePairRow({ ...crRow }));
    assert.match(String(buildTestRow().envelope.source_label_row_hash), /^[0-9a-f]{64}$/);
  });

  it('protects: validation rejects schema_version drift and broken outcomes', () => {
    const row = buildTestRow();
    assert.deepEqual(validateCellLabelRow(row), []);
    assert.ok(validateCellLabelRow({ ...row, schema_version: '0.2.0' }).length > 0);
    assert.ok(validateCellLabelRow({ ...row, structural: { ...row.structural, decided: true, layer: 'bogus' } }).length > 0);
    assert.ok(validateCellLabelRow({ ...row, llm: { ...row.llm, prompt_hash: 'nope' } }).length > 0);
    assert.ok(validateCellLabelRow({ ...row, envelope: { ...row.envelope, source_label_version: 'cr-0.2.0' } }).length > 0);
    assert.ok(validateCellLabelRow('not-a-row').length > 0);
  });

  it('protects: the reason-code vocabulary is closed and typed', () => {
    assert.ok(CELL_REASON_CODES.includes('ambiguous_signals'));
    assert.ok(CELL_REASON_CODES.includes('stale_head_evidence'));
  });
});