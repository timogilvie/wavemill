import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildPlanningWithToolCall, buildCodingWithDenialAndRespond } from './fixtures/tool-decision/build.ts';
import { projectSessionEventsToDecisions } from './tool-decision-projector.ts';
import {
  TOOL_DECISION_LABEL_VERSION,
  labelToolDecisions,
  serializeLabelsAsJsonl,
} from './tool-decision-labeler.ts';

describe('labelToolDecisions', () => {
  it('marks survival ineligible when the terminal task did not succeed', () => {
    const { rows } = projectSessionEventsToDecisions({ events: buildPlanningWithToolCall() });
    const { labels } = labelToolDecisions({
      rows,
      contexts: [{ traceId: rows[0].traceId, terminalSuccess: false, merged: true }],
    });
    assert.equal(labels.length, rows.length);
    assert.equal(labels[0].survivalRatio, null);
    assert.equal(labels[0].ineligibilityReason, 'terminal_not_success');
    assert.equal(labels[0].labelVersion, TOOL_DECISION_LABEL_VERSION);
  });

  it('marks unmerged PRs as ineligible', () => {
    const { rows } = projectSessionEventsToDecisions({ events: buildPlanningWithToolCall() });
    const { labels } = labelToolDecisions({
      rows,
      contexts: [{ traceId: rows[0].traceId, merged: false }],
    });
    assert.equal(labels[0].ineligibilityReason, 'unmerged_pr');
  });

  it('reports exact_reversion + reverted outcome when told about a revert', () => {
    const { rows } = projectSessionEventsToDecisions({ events: buildPlanningWithToolCall() });
    const { labels } = labelToolDecisions({
      rows,
      contexts: [{
        traceId: rows[0].traceId,
        terminalSuccess: true,
        merged: true,
        elapsedDaysSinceMerge: 30,
        reversions: {
          [rows[0].decisionId]: { reverted: true, undoneBy: 'human' },
        },
      }],
    });
    assert.equal(labels[0].exactReversion, true);
    assert.equal(labels[0].humanVsAgentUndo, 'human');
    assert.equal(labels[0].reportOutcome, 'reverted');
  });

  it('yields survival_ratio and derived outcome when substrate present', () => {
    const { rows } = projectSessionEventsToDecisions({ events: buildPlanningWithToolCall() });
    const { labels } = labelToolDecisions({
      rows,
      contexts: [{
        traceId: rows[0].traceId,
        terminalSuccess: true,
        merged: true,
        elapsedDaysSinceMerge: 14,
        reversions: {
          [rows[0].decisionId]: { reverted: false, survivalRatio: 0.85 },
        },
      }],
    });
    assert.equal(labels[0].survivalRatio, 0.85);
    assert.equal(labels[0].reportOutcome, 'survived');
  });

  it('reports substantially_rewritten below the threshold', () => {
    const { rows } = projectSessionEventsToDecisions({ events: buildPlanningWithToolCall() });
    const { labels } = labelToolDecisions({
      rows,
      contexts: [{
        traceId: rows[0].traceId,
        terminalSuccess: true,
        merged: true,
        elapsedDaysSinceMerge: 30,
        reversions: {
          [rows[0].decisionId]: { reverted: false, survivalRatio: 0.1 },
        },
      }],
    });
    assert.equal(labels[0].reportOutcome, 'substantially_rewritten');
  });

  it('treats respond rows as not_a_mutation', () => {
    const { rows } = projectSessionEventsToDecisions({ events: buildCodingWithDenialAndRespond() });
    const respondRow = rows.find((r) => r.kind === 'respond');
    assert.ok(respondRow);
    const { labels } = labelToolDecisions({
      rows: [respondRow!],
      contexts: [{
        traceId: respondRow!.traceId,
        terminalSuccess: true,
        merged: true,
        elapsedDaysSinceMerge: 14,
      }],
    });
    assert.equal(labels[0].ineligibilityReason, 'not_a_mutation');
  });

  it('computes test_failure_delta when both signals are present', () => {
    const { rows } = projectSessionEventsToDecisions({ events: buildPlanningWithToolCall() });
    const { labels } = labelToolDecisions({
      rows,
      contexts: [{
        traceId: rows[0].traceId,
        terminalSuccess: true,
        merged: true,
        elapsedDaysSinceMerge: 30,
        testSignals: {
          [rows[0].decisionId]: { failedBefore: 3, failedAfter: 1 },
        },
      }],
    });
    assert.equal(labels[0].testFailureDelta, -2);
    assert.equal(labels[0].testFailureDeltaSource, 'measured');
  });

  it('serializeLabelsAsJsonl emits one line per label', () => {
    const { rows } = projectSessionEventsToDecisions({ events: buildPlanningWithToolCall() });
    const { labels } = labelToolDecisions({ rows, contexts: [] });
    const serialized = serializeLabelsAsJsonl(labels);
    assert.equal(serialized.trim().split('\n').length, labels.length);
  });
});
