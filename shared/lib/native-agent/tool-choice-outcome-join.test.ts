import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { EvalRecord } from '../eval-schema.ts';
import {
  buildOutcomeJoin,
  parseIssueFromSessionId,
} from './tool-choice-outcome-join.ts';
import type { ToolDecisionRow } from './tool-decision-schema.ts';
import { TOOL_DECISION_SCHEMA_VERSION } from './tool-decision-schema.ts';

function mkRow(overrides: Partial<ToolDecisionRow> = {}): ToolDecisionRow {
  return {
    schemaVersion: TOOL_DECISION_SCHEMA_VERSION,
    decisionId: 'd-1',
    sessionId: 'sess-abc-coding-HOK-1234',
    traceId: 'trace-1',
    phase: 'coding',
    turnIndex: 0,
    stepIndex: 0,
    sourceEventIds: ['e1'],
    provider: 'anthropic',
    model: 'claude-3-5-sonnet',
    runtime: 'native',
    kind: 'tool_call',
    chosenTool: 'read',
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
    issueId: 'HOK-1234',
    ...overrides,
  } as unknown as EvalRecord;
}

describe('parseIssueFromSessionId', () => {
  it('extracts issue slug and phase from a coding session id', () => {
    const p = parseIssueFromSessionId('sess-abc-coding-HOK-1234');
    assert.equal(p.issue, 'HOK-1234');
    assert.equal(p.phase, 'coding');
    assert.equal(p.challengerArm, false);
  });

  it('flags a challenger arm via the _c suffix', () => {
    const p = parseIssueFromSessionId('sess-abc-coding-HOK-1234_c');
    assert.equal(p.issue, 'HOK-1234');
    assert.equal(p.challengerArm, true);
  });

  it('yields no issue for a review-branch session (no HOK slug)', () => {
    const p = parseIssueFromSessionId('sess-xyz-review-integration-branch');
    assert.equal(p.issue, undefined);
    assert.equal(p.phase, 'review');
  });

  it('lowercases the phase and uppercases the issue slug', () => {
    const p = parseIssueFromSessionId('sess-1-Coding-hok-42');
    assert.equal(p.phase, 'coding');
    assert.equal(p.issue, 'HOK-42');
  });
});

describe('buildOutcomeJoin', () => {
  it('joins a single trace by issue slug', () => {
    const result = buildOutcomeJoin({
      rows: [mkRow()],
      evalRecords: [mkEval()],
    });
    assert.equal(result.stats.joined, 1);
    assert.equal(result.stats.unjoinable, 0);
    assert.equal(result.rows[0].outcome?.status, 'joined');
    assert.equal(result.contexts[0].terminalSuccess, true);
    assert.equal(result.covariates[0].model, 'claude-3-5-sonnet');
  });

  it('flags ambiguous multi-record matches without silently picking', () => {
    const cov = buildOutcomeJoin({
      rows: [mkRow()],
      evalRecords: [
        mkEval({ id: 'a', timestamp: '2026-08-01T00:00:00Z' }),
        mkEval({ id: 'b', timestamp: '2026-08-01T00:00:00Z' }),
      ],
    });
    assert.equal(cov.stats.ambiguousMatches, 1);
    assert.equal(cov.covariates[0].ambiguousJoin, true);
  });

  it('routes challenger arm to challenger-side eval when both sides exist', () => {
    const primary = mkEval({ id: 'p', challengeSide: 'primary', modelId: 'model-A' });
    const challenger = mkEval({ id: 'c', challengeSide: 'challenger', modelId: 'model-B' });
    const result = buildOutcomeJoin({
      rows: [mkRow({ sessionId: 'sess-abc-coding-HOK-1234_c', traceId: 't-c' })],
      evalRecords: [primary, challenger],
    });
    assert.equal(result.covariates[0].model, 'model-B');
    assert.equal(result.covariates[0].challengeSide, 'challenger');
  });

  it('marks a review-branch session unjoinable and counts it', () => {
    const result = buildOutcomeJoin({
      rows: [mkRow({ sessionId: 'sess-xyz-review-integration-branch', traceId: 't-r' })],
      evalRecords: [mkEval()],
    });
    assert.equal(result.stats.unjoinable, 1);
    assert.equal(result.stats.reviewSessionsFlagged, 1);
    assert.equal(result.rows[0].outcome?.status, 'unjoinable');
    assert.equal(result.rows[0].outcome?.unjoinableReason, 'review_session_no_issue_slug');
  });

  it('marks unjoinable when no eval record matches the issue', () => {
    const result = buildOutcomeJoin({
      rows: [mkRow()],
      evalRecords: [mkEval({ issueId: 'HOK-9999' })],
    });
    assert.equal(result.stats.unjoinable, 1);
    assert.equal(result.rows[0].outcome?.unjoinableReason, 'no_eval_record_for_issue');
  });

  it('never mutates the input rows', () => {
    const rows = [mkRow()];
    buildOutcomeJoin({ rows, evalRecords: [mkEval()] });
    assert.equal(rows[0].outcome, undefined);
  });

  it('carries terminal_success=false from a failing eval', () => {
    const result = buildOutcomeJoin({
      rows: [mkRow()],
      evalRecords: [mkEval({ score: 0.05, scoreBand: 'Failure' })],
    });
    assert.equal(result.contexts[0].terminalSuccess, false);
    assert.equal(result.covariates[0].terminalStatus, 'failure');
  });
});
