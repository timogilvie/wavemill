import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { EvalRecord } from '../eval-schema.ts';
import {
  analyzeToolChoice,
  renderMarkdownReport,
} from './tool-choice-analyzer.ts';
import type { ToolDecisionRow } from './tool-decision-schema.ts';
import { TOOL_DECISION_SCHEMA_VERSION } from './tool-decision-schema.ts';

function mkRow(overrides: Partial<ToolDecisionRow> = {}): ToolDecisionRow {
  return {
    schemaVersion: TOOL_DECISION_SCHEMA_VERSION,
    decisionId: `d-${Math.random().toString(36).slice(2)}`,
    sessionId: 'sess-1-coding-HOK-1',
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
    result: { status: 'success' },
    timestamp: 1_759_000_000_000,
    causalEventIds: ['e1'],
    ...overrides,
  };
}

function mkEval(overrides: Partial<EvalRecord> = {}): EvalRecord {
  return {
    id: 'ev-1',
    schemaVersion: '1.50.0',
    originalPrompt: '',
    modelId: 'claude-3-5-sonnet',
    modelVersion: 'v1',
    score: 0.9,
    scoreBand: 'Minor Feedback',
    timeSeconds: 100,
    timestamp: '2026-08-01T00:00:00Z',
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: '',
    issueId: 'HOK-1',
    ...overrides,
  } as unknown as EvalRecord;
}

describe('analyzeToolChoice — null corpus', () => {
  it('empty inputs yield an inconclusive decision with capture guidance', () => {
    const out = analyzeToolChoice({ rows: [], evalRecords: [] });
    assert.equal(out.decision.decision, 'inconclusive');
    assert.ok(out.decision.minimumAdditionalCapture);
    assert.ok(out.decision.minimumAdditionalCapture!.guidance.length > 0);
  });
});

describe('analyzeToolChoice — quality-gate failure', () => {
  it('all-unavailable propensity + tiny sample gates estimators off and refuses off-policy', () => {
    const rows: ToolDecisionRow[] = [];
    for (let i = 0; i < 5; i++) {
      rows.push(
        mkRow({
          sessionId: `sess-${i}-coding-HOK-1`,
          traceId: `t-${i}`,
          decisionId: `d-${i}`,
        }),
      );
    }
    const out = analyzeToolChoice({
      rows,
      evalRecords: [mkEval()],
      bootstrap: { iterations: 30, seed: 3 },
    });
    assert.equal(out.decision.decision, 'inconclusive');
    assert.ok('refused' in out.analysis.offPolicy.ips && out.analysis.offPolicy.ips.refused);
  });
});

describe('analyzeToolChoice — planted effect', () => {
  it('planted lift with exact propensities is at least visible in stratified/regression outputs', () => {
    // 60 traces, half choose "read" (75% success), half choose "edit" (25% success).
    const rows: ToolDecisionRow[] = [];
    for (let i = 0; i < 60; i++) {
      const chosen = i < 30 ? 'read' : 'edit';
      const isReadSuccess = i % 4 !== 0; // 75% success for read
      const isEditSuccess = i % 4 === 0; // 25% success for edit
      const status = chosen === 'read'
        ? isReadSuccess
          ? 'success'
          : 'error'
        : isEditSuccess
        ? 'success'
        : 'error';
      rows.push(
        mkRow({
          sessionId: `sess-${i}-coding-HOK-1`,
          traceId: `t-${i}`,
          decisionId: `d-${i}`,
          chosenTool: chosen,
          result: { status: status as 'success' | 'error' },
          propensity: {
            provenance: 'exact',
            distribution: { read: 0.5, edit: 0.5 },
          },
        }),
      );
    }
    const out = analyzeToolChoice({
      rows,
      evalRecords: [mkEval()],
      bootstrap: { iterations: 40, seed: 11 },
      thresholds: {
        minTotalDecisions: 10,
        minDistinctTraces: 10,
        minJoinedTracesPerCell: 10,
      },
    });
    // We should at least be able to score IPS on exact-propensity rows.
    assert.ok(!('refused' in out.analysis.offPolicy.ips && out.analysis.offPolicy.ips.refused));
    // At least one stratified contrast should be non-gated.
    const kept = out.analysis.stratified.contrasts.filter((c) => !c.gated);
    assert.ok(kept.length >= 1);
    // Decision may be go/inconclusive depending on sensitivity — assert only
    // the structural: it isn't a null-run inconclusive with empty stratified.
    assert.ok(out.analysis.covariateNotes.tracesJoined === 60);
  });
});

describe('renderMarkdownReport', () => {
  it('produces a report with all required sections', () => {
    const rows: ToolDecisionRow[] = [mkRow({ outcome: { status: 'joined', issue: 'HOK-1' } })];
    const out = analyzeToolChoice({ rows, evalRecords: [mkEval()] });
    const md = renderMarkdownReport(out, {
      timestamp: '2026-09-23T00:00:00Z',
      corpusPath: 'sample.jsonl',
      evalsPath: 'evals.jsonl',
      streamsDir: 'stream-dir',
      streamCount: 1,
      evalCount: 1,
      cliCommand: 'npx tsx tools/tool-choice-analysis.ts',
    });
    assert.match(md, /Data-quality appendix/);
    assert.match(md, /Stratified contrasts/);
    assert.match(md, /Sensitivity sweeps/);
    assert.match(md, /Off-policy/);
    assert.match(md, /## Decision/);
    assert.match(md, /Kill condition/);
    // The exact "Decision: …" line is present, per REQ-F5.
    assert.match(md, /Decision: (Go|No-go|Inconclusive)/);
  });
});
