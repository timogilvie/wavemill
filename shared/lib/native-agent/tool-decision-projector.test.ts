import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildPlanningWithToolCall,
  buildCodingWithDenialAndRespond,
  buildReviewWithForcedAndRedaction,
} from './fixtures/tool-decision/build.ts';
import { projectSessionEventsToDecisions } from './tool-decision-projector.ts';
import { validateToolDecisionRow } from './tool-decision-schema.ts';

describe('projectSessionEventsToDecisions', () => {
  it('produces a single tool_call row for a happy planning turn', () => {
    const events = buildPlanningWithToolCall();
    const { rows } = projectSessionEventsToDecisions({ events });
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.kind, 'tool_call');
    assert.equal(row.chosenTool, 'read');
    assert.deepEqual(row.availableTools, ['read', 'edit']);
    assert.equal(row.result?.status, 'success');
    assert.equal(row.propensity.provenance, 'surrogate');
    assert.deepEqual(row.propensity.alternatives, ['edit']);
    assert.ok(row.mutationEvidence?.commandToolCallIds?.includes('call-1'));
    assert.equal(validateToolDecisionRow(row).ok, true);
  });

  it('captures denials and text-only responses across two turns', () => {
    const events = buildCodingWithDenialAndRespond();
    const { rows } = projectSessionEventsToDecisions({ events });
    // Turn 0: policy_denied row. Turn 1: respond row.
    assert.equal(rows.length, 2);
    const denial = rows.find((r) => r.kind === 'policy_denied');
    const respond = rows.find((r) => r.kind === 'respond');
    assert.ok(denial);
    assert.ok(respond);
    assert.equal(denial!.chosenTool, 'bash');
    assert.equal(denial!.policyDecision?.decision, 'deny');
    assert.equal(denial!.policyDecision?.reason, 'mutation_blocked');
    assert.equal(respond!.state.priorPolicyDenials, 1);
  });

  it('detects forced_tool_call and terminal-synthesis respond', () => {
    const events = buildReviewWithForcedAndRedaction();
    const { rows } = projectSessionEventsToDecisions({ events });
    const forced = rows.find((r) => r.kind === 'forced_tool_call');
    assert.ok(forced);
    assert.equal(forced!.chosenTool, 'review_report');
    const respond = rows.find((r) => r.state.terminalSynthesis);
    assert.ok(respond);
    assert.equal(respond!.propensity.provenance, 'unavailable');
    // Redacted result summary should survive as evidence.
    assert.equal(forced!.result?.status, 'error');
  });

  it('generates deterministic decisionIds', () => {
    const first = projectSessionEventsToDecisions({ events: buildPlanningWithToolCall() });
    const second = projectSessionEventsToDecisions({ events: buildPlanningWithToolCall() });
    assert.deepEqual(
      first.rows.map((r) => r.decisionId),
      second.rows.map((r) => r.decisionId),
    );
  });

  it('returns empty rows when no model_request events are present', () => {
    const { rows } = projectSessionEventsToDecisions({ events: [] });
    assert.equal(rows.length, 0);
  });
});
