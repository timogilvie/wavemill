import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  QUALITY_GATE_THRESHOLDS,
  computeQualityGate,
  formatQualityGateReport,
} from './tool-choice-quality-gate.ts';
import type { ToolDecisionRow } from './tool-decision-schema.ts';
import { TOOL_DECISION_SCHEMA_VERSION } from './tool-decision-schema.ts';

function mkRow(overrides: Partial<ToolDecisionRow> = {}): ToolDecisionRow {
  return {
    schemaVersion: TOOL_DECISION_SCHEMA_VERSION,
    decisionId: `d-${Math.random().toString(36).slice(2)}`,
    sessionId: 'sess-1',
    traceId: 't-1',
    phase: 'coding',
    turnIndex: 0,
    stepIndex: 0,
    sourceEventIds: ['e1'],
    provider: 'anthropic',
    model: 'claude-3-5-sonnet',
    runtime: 'native',
    kind: 'tool_call',
    chosenTool: 'read',
    toolMenu: { digest: 'menu-1', toolNames: ['read', 'edit'] },
    providerMenu: { digest: 'p-1', toolCount: 2 },
    state: {
      priorToolCallCount: 0,
      priorErrorFlag: false,
      priorErrorCount: 0,
      terminalSynthesis: false,
      priorPolicyDenials: 0,
    },
    propensity: { provenance: 'unavailable' },
    timestamp: 1_759_000_000_000,
    causalEventIds: ['e1'],
    ...overrides,
  };
}

describe('computeQualityGate', () => {
  it('reports zero rows for an empty input and fails all size gates', () => {
    const report = computeQualityGate({ rows: [] });
    assert.equal(report.coverage.totalDecisions, 0);
    assert.equal(report.observationalGatePass, false);
    assert.equal(report.offPolicyGatePass, false);
  });

  it('counts distinct traces and sessions and per-phase breakdowns', () => {
    const rows = [
      mkRow({ sessionId: 's-1', traceId: 't-1', phase: 'planning' }),
      mkRow({ sessionId: 's-1', traceId: 't-1', phase: 'planning' }),
      mkRow({ sessionId: 's-2', traceId: 't-2', phase: 'coding' }),
    ];
    const report = computeQualityGate({ rows });
    assert.equal(report.coverage.distinctSessions, 2);
    assert.equal(report.coverage.distinctTraces, 2);
    assert.equal(report.coverage.perPhase.planning, 2);
    assert.equal(report.coverage.perPhase.coding, 1);
  });

  it('reports menu-presence fraction and flags menu-absent non-terminal rows', () => {
    const rows = [
      mkRow(),
      mkRow({ toolMenu: undefined as unknown as ToolDecisionRow['toolMenu'] }),
    ];
    const report = computeQualityGate({ rows });
    assert.equal(report.menu.menuPresenceFraction, 0.5);
    assert.equal(report.menu.rowsWithoutMenuNonTerminal, 1);
  });

  it('detects inconsistent menu digests within a turn', () => {
    const rows = [
      mkRow({ turnIndex: 0, toolMenu: { digest: 'a', toolNames: ['read'] } }),
      mkRow({ turnIndex: 0, toolMenu: { digest: 'b', toolNames: ['edit'] } }),
    ];
    const report = computeQualityGate({ rows });
    assert.equal(report.menu.perTurnDigestConsistent, false);
  });

  it('classifies outcomes joined/unjoinable/pending and preserves reasons', () => {
    const rows = [
      mkRow({ outcome: { status: 'joined', issue: 'HOK-1' } }),
      mkRow({ outcome: { status: 'unjoinable', unjoinableReason: 'no_eval_record_for_issue' } }),
      mkRow(),
    ];
    const report = computeQualityGate({ rows });
    assert.equal(report.outcome.joined, 1);
    assert.equal(report.outcome.unjoinable, 1);
    assert.equal(report.outcome.pending, 1);
    assert.equal(report.outcome.reasons['no_eval_record_for_issue'], 1);
  });

  it('gates off-policy off when no exact-propensity row is present', () => {
    const rows = [mkRow({ propensity: { provenance: 'surrogate' } })];
    const report = computeQualityGate({ rows });
    assert.equal(report.propensity.surrogate, 1);
    assert.equal(report.propensity.exact, 0);
    assert.equal(report.offPolicyGatePass, false);
  });

  it('permits off-policy when the exact-propensity floor is met', () => {
    const rows: ToolDecisionRow[] = [];
    for (let i = 0; i < 200; i++) {
      rows.push(
        mkRow({
          sessionId: `s-${i}`,
          traceId: `t-${i}`,
          decisionId: `d-${i}`,
          propensity: { provenance: 'exact', distribution: { read: 1.0 } },
          outcome: { status: 'joined', issue: 'HOK-1' },
        }),
      );
    }
    const report = computeQualityGate({ rows });
    assert.equal(report.checks.offPolicyEligible, true);
    assert.equal(report.observationalGatePass, true);
    assert.equal(report.offPolicyGatePass, true);
  });

  it('emits a formatted report string with all sections', () => {
    const rows = [mkRow({ outcome: { status: 'joined', issue: 'HOK-1' } })];
    const report = computeQualityGate({ rows });
    const printed = formatQualityGateReport(report);
    assert.match(printed, /Coverage/);
    assert.match(printed, /Menu integrity/);
    assert.match(printed, /Outcome joins/);
    assert.match(printed, /Propensity provenance/);
  });

  it('honors threshold overrides', () => {
    const report = computeQualityGate({
      rows: [mkRow({ outcome: { status: 'joined' } })],
      thresholds: { minTotalDecisions: 0, minDistinctTraces: 0, minJoinedTracesPerCell: 0 },
    });
    assert.equal(report.observationalGatePass, true);
    assert.equal(report.thresholds.minJoinedTracesPerCell, 0);
  });

  it('exports frozen defaults', () => {
    assert.ok(QUALITY_GATE_THRESHOLDS.minJoinedTracesPerCell >= 1);
    assert.ok(QUALITY_GATE_THRESHOLDS.minMenuPresenceFraction > 0);
  });
});
