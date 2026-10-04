import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  TOOL_DECISION_SCHEMA_VERSION,
  parseToolDecisionJsonl,
  validateToolDecisionRow,
  ToolDecisionParseError,
  type ToolDecisionRow,
} from './tool-decision-schema.ts';

function makeValidRow(overrides: Partial<ToolDecisionRow> = {}): ToolDecisionRow {
  const row: ToolDecisionRow = {
    schemaVersion: TOOL_DECISION_SCHEMA_VERSION,
    decisionId: 'abc123',
    sessionId: 'sess',
    traceId: 'trace',
    phase: 'coding',
    turnIndex: 0,
    stepIndex: 0,
    sourceEventIds: ['ev-1'],
    provider: 'anthropic',
    model: 'claude-3-5-sonnet',
    runtime: 'native',
    kind: 'tool_call',
    state: {
      priorToolCallCount: 0,
      priorErrorFlag: false,
      priorErrorCount: 0,
      terminalSynthesis: false,
      priorPolicyDenials: 0,
    },
    propensity: { provenance: 'surrogate', alternatives: ['edit'] },
    timestamp: 1_700_000_000_000,
    causalEventIds: ['ev-1'],
    ...overrides,
  };
  return row;
}

describe('validateToolDecisionRow', () => {
  it('accepts a well-formed row', () => {
    const res = validateToolDecisionRow(makeValidRow());
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.row.kind, 'tool_call');
  });

  it('rejects wrong schema version', () => {
    const res = validateToolDecisionRow(makeValidRow({ schemaVersion: '999' }));
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /schema_version_mismatch/);
  });

  it('rejects unknown decision kinds', () => {
    const res = validateToolDecisionRow(makeValidRow({ kind: 'nope' as unknown as ToolDecisionRow['kind'] }));
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /bad_kind/);
  });

  it('rejects missing required fields', () => {
    const bad = { ...makeValidRow() } as Partial<ToolDecisionRow>;
    delete bad.propensity;
    const res = validateToolDecisionRow(bad);
    assert.equal(res.ok, false);
  });

  it('rejects unknown propensity provenance', () => {
    const res = validateToolDecisionRow(
      makeValidRow({ propensity: { provenance: 'made_up' as unknown as 'exact' } }),
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /bad_propensity_provenance/);
  });

  it('accepts unavailable propensity', () => {
    const res = validateToolDecisionRow(
      makeValidRow({ propensity: { provenance: 'unavailable' } }),
    );
    assert.equal(res.ok, true);
  });
});

describe('parseToolDecisionJsonl', () => {
  it('round-trips a JSONL corpus', () => {
    const rows = [makeValidRow({ decisionId: '1' }), makeValidRow({ decisionId: '2' })];
    const content = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    const parsed = parseToolDecisionJsonl(content);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].decisionId, '1');
  });

  it('skips blank lines', () => {
    const rows = [makeValidRow({ decisionId: '1' })];
    const content = '\n' + JSON.stringify(rows[0]) + '\n\n';
    const parsed = parseToolDecisionJsonl(content);
    assert.equal(parsed.length, 1);
  });

  it('throws ToolDecisionParseError on malformed JSON', () => {
    assert.throws(() => parseToolDecisionJsonl('{not-json\n'), ToolDecisionParseError);
  });

  it('throws ToolDecisionParseError on invalid row shape', () => {
    const content = JSON.stringify({ ...makeValidRow(), kind: 'garbage' }) + '\n';
    assert.throws(() => parseToolDecisionJsonl(content), ToolDecisionParseError);
  });
});
