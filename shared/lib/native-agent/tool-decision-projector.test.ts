import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildPlanningWithToolCall,
  buildCodingWithDenialAndRespond,
  buildReviewWithForcedAndRedaction,
} from './fixtures/tool-decision/build.ts';
import { projectSessionEventsToDecisions } from './tool-decision-projector.ts';
import { validateToolDecisionRow } from './tool-decision-schema.ts';
import { SESSION_STREAM_SCHEMA_VERSION, type SessionEvent } from './session-stream.schema.ts';

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
    assert.equal(denial!.result?.status, 'denied');
    assert.equal(respond!.result?.status, 'n/a');
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

  it('populates latency from tool_call and tool_result timestamps', () => {
    const events = buildPlanningWithToolCall();
    // Fixture seq-based timestamps are 1ms apart; nudge the result to a
    // measurable gap so the test proves we're computing the diff, not just
    // storing some constant.
    for (const ev of events) {
      if (ev.type === 'tool_call' && (ev as any).callId === 'call-1') {
        (ev as any).timestamp = 1_000;
      }
      if (ev.type === 'tool_result' && (ev as any).callId === 'call-1') {
        (ev as any).timestamp = 1_250;
      }
    }
    const { rows } = projectSessionEventsToDecisions({ events });
    const row = rows.find((r) => r.chosenTool === 'read');
    assert.ok(row);
    assert.equal(row!.result?.status, 'success');
    assert.equal(row!.result?.latencyMs, 250);
  });

  it('passes model_request budget fields through to StateFeatures', () => {
    const events = buildPlanningWithToolCall();
    for (const ev of events) {
      if (ev.type === 'model_request') {
        (ev as any).turnBudgetRemaining = 7;
        (ev as any).toolCallBudgetRemaining = 42;
        (ev as any).tokensUsedSoFar = 1234;
      }
    }
    const { rows } = projectSessionEventsToDecisions({ events });
    const row = rows[0];
    assert.equal(row.state.turnBudgetRemaining, 7);
    assert.equal(row.state.toolCallBudgetRemaining, 42);
    assert.equal(row.state.tokensUsedSoFar, 1234);
  });

  it('marks executed-but-denied rows as policy_denied with denied status', () => {
    // Executed-but-denied path: policy wrote deny but the call event was
    // still captured (edge case we must still surface as `denied`, not
    // leak an `error`/`success`).
    const events = buildPlanningWithToolCall();
    for (const ev of events) {
      if (ev.type === 'tool_policy_decision' && (ev as any).callId === 'call-1') {
        (ev as any).decision = 'deny';
        (ev as any).denialReason = 'mutation_blocked';
      }
    }
    const { rows } = projectSessionEventsToDecisions({ events });
    const row = rows.find((r) => r.chosenTool === 'read');
    assert.ok(row);
    assert.equal(row!.kind, 'policy_denied');
    assert.equal(row!.result?.status, 'denied');
  });

  describe('positional fallback pairing (historical streams)', () => {
    function buildHistoricalBugShapedStream(opts: {
      /** 'success' | 'error' | 'denied' */
      kind: 'success' | 'error' | 'denied';
    }): SessionEvent[] {
      const FIXED = 1_759_000_000_000;
      const sessionId = `sess-fallback-${opts.kind}`;
      const traceId = `trace-fallback-${opts.kind}`;
      const phase = 'coding';
      const base = (seq: number, type: SessionEvent['type']) => ({
        eventId: `${type}-${sessionId}-${seq}`,
        seq,
        timestamp: FIXED + seq,
        sessionId,
        traceId,
        phase,
        schemaVersion: SESSION_STREAM_SCHEMA_VERSION,
        type,
      });
      let seq = 0;
      const events: SessionEvent[] = [];
      events.push({
        ...base(seq++, 'session_started'),
        sessionId,
        initialConfigDigest: 'init',
      } as SessionEvent);
      events.push({
        ...base(seq++, 'tool_menu'),
        toolNames: ['read', 'edit'],
        digest: 'menu-fallback',
      } as SessionEvent);
      events.push({
        ...base(seq++, 'provider_tools'),
        toolCount: 2,
        digest: 'provider-fallback',
      } as SessionEvent);
      const reqEventId = `req-${sessionId}`;
      events.push({
        ...base(seq++, 'model_request'),
        eventId: reqEventId,
        callId: 'req-call-fallback',
        turnIndex: 0,
        provider: 'anthropic',
        modelId: 'claude-x',
        config: {},
        contextDigest: 'ctx-fallback',
        promptRefs: [],
        toolMenuDigest: 'menu-fallback',
        providerToolsDigest: 'provider-fallback',
      } as unknown as SessionEvent);
      // Decision + result share the REAL SDK id. The tool_call was written
      // with a different random id (this reproduces the historical bug).
      const realId = 'functions.read:0';
      const randomId = 'random-uuid-abc-123';
      events.push({
        ...base(seq++, 'tool_policy_decision'),
        callId: realId,
        toolName: 'read',
        decision: opts.kind === 'denied' ? 'deny' : 'allow',
        denialReason: opts.kind === 'denied' ? 'mutation_blocked' : undefined,
      } as unknown as SessionEvent);
      events.push({
        ...base(seq++, 'tool_call'),
        callId: randomId,
        toolName: 'read',
      } as SessionEvent);
      if (opts.kind !== 'denied') {
        events.push({
          ...base(seq++, 'tool_result'),
          callId: realId,
          toolName: 'read',
          isError: opts.kind === 'error',
          contentSummary: opts.kind === 'error' ? 'ENOENT' : 'ok',
          byteSize: 10,
        } as unknown as SessionEvent);
      }
      events.push({
        ...base(seq++, 'model_response'),
        requestEventId: reqEventId,
        callId: 'req-call-fallback',
        stopReason: 'tool_use',
        contentSummary: { toolCallCount: 1, textLength: 0 },
      } as unknown as SessionEvent);
      events.push({
        ...base(seq++, 'session_ended'),
        stopReason: 'end',
        totalTurns: 1,
        totalToolCalls: 1,
      } as SessionEvent);
      return events;
    }

    it('recovers success status via positional pairing when callIds differ', () => {
      const events = buildHistoricalBugShapedStream({ kind: 'success' });
      const { rows, warnings } = projectSessionEventsToDecisions({ events });
      const row = rows.find((r) => r.chosenTool === 'read');
      assert.ok(row);
      assert.equal(row!.result?.status, 'success');
      assert.ok(
        warnings.some((w) => w.startsWith('fallback_positional_pairing:')),
        `expected a fallback_positional_pairing warning, got ${JSON.stringify(warnings)}`,
      );
    });

    it('recovers error status via positional pairing when callIds differ', () => {
      const events = buildHistoricalBugShapedStream({ kind: 'error' });
      const { rows } = projectSessionEventsToDecisions({ events });
      const row = rows.find((r) => r.chosenTool === 'read');
      assert.ok(row);
      assert.equal(row!.result?.status, 'error');
    });

    it('does not emit a tool_call row for a denied call recovered via orphaned-denial path', () => {
      // When the policy denied the call, the tool was NOT allowed in the
      // historical stream (so there is only a decision event, no result).
      // That hits the orphaned-denial path, which already surfaces as a
      // policy_denied row with status 'denied'.
      const events = buildHistoricalBugShapedStream({ kind: 'denied' });
      const { rows } = projectSessionEventsToDecisions({ events });
      const denied = rows.filter((r) => r.kind === 'policy_denied');
      assert.equal(denied.length, 1);
      assert.equal(denied[0].result?.status, 'denied');
    });
  });

  describe('timeout detection at trailing unmatched call', () => {
    it('marks trailing unmatched call as timeout when session ended with wall_clock_limit', () => {
      const FIXED = 1_759_000_000_000;
      const sessionId = 'sess-timeout';
      const base = (seq: number, type: SessionEvent['type']) => ({
        eventId: `${type}-${sessionId}-${seq}`,
        seq,
        timestamp: FIXED + seq,
        sessionId,
        traceId: 'trace-timeout',
        phase: 'coding',
        schemaVersion: SESSION_STREAM_SCHEMA_VERSION,
        type,
      });
      let seq = 0;
      const events: SessionEvent[] = [];
      events.push({
        ...base(seq++, 'session_started'),
        sessionId,
        initialConfigDigest: 'init',
      } as SessionEvent);
      events.push({
        ...base(seq++, 'tool_menu'),
        toolNames: ['slow_tool'],
        digest: 'm1',
      } as SessionEvent);
      events.push({
        ...base(seq++, 'provider_tools'),
        toolCount: 1,
        digest: 'p1',
      } as SessionEvent);
      const reqId = `req-${sessionId}`;
      events.push({
        ...base(seq++, 'model_request'),
        eventId: reqId,
        callId: 'req-timeout',
        turnIndex: 0,
        provider: 'anthropic',
        modelId: 'claude-x',
        config: {},
        contextDigest: 'ctx-timeout',
        promptRefs: [],
        toolMenuDigest: 'm1',
        providerToolsDigest: 'p1',
      } as unknown as SessionEvent);
      // Call fires, no decision or result — abort tore the executor down.
      events.push({
        ...base(seq++, 'tool_call'),
        callId: 'orphan-call-1',
        toolName: 'slow_tool',
      } as SessionEvent);
      events.push({
        ...base(seq++, 'session_ended'),
        stopReason: 'wall_clock_limit',
        totalTurns: 1,
        totalToolCalls: 0,
      } as SessionEvent);
      const { rows } = projectSessionEventsToDecisions({ events });
      const row = rows.find((r) => r.chosenTool === 'slow_tool');
      assert.ok(row);
      assert.equal(row!.result?.status, 'timeout');
    });

    it('still reports skipped when the session ended cleanly', () => {
      const FIXED = 1_759_000_000_000;
      const sessionId = 'sess-clean-skip';
      const base = (seq: number, type: SessionEvent['type']) => ({
        eventId: `${type}-${sessionId}-${seq}`,
        seq,
        timestamp: FIXED + seq,
        sessionId,
        traceId: 'trace-clean',
        phase: 'coding',
        schemaVersion: SESSION_STREAM_SCHEMA_VERSION,
        type,
      });
      let seq = 0;
      const events: SessionEvent[] = [];
      events.push({
        ...base(seq++, 'session_started'),
        sessionId,
        initialConfigDigest: 'init',
      } as SessionEvent);
      events.push({
        ...base(seq++, 'tool_menu'),
        toolNames: ['read'],
        digest: 'm',
      } as SessionEvent);
      events.push({
        ...base(seq++, 'provider_tools'),
        toolCount: 1,
        digest: 'p',
      } as SessionEvent);
      const reqId = `req-${sessionId}`;
      events.push({
        ...base(seq++, 'model_request'),
        eventId: reqId,
        callId: 'req-clean',
        turnIndex: 0,
        provider: 'anthropic',
        modelId: 'claude-x',
        config: {},
        contextDigest: 'ctx',
        promptRefs: [],
        toolMenuDigest: 'm',
        providerToolsDigest: 'p',
      } as unknown as SessionEvent);
      events.push({
        ...base(seq++, 'tool_call'),
        callId: 'orphan-call-x',
        toolName: 'read',
      } as SessionEvent);
      events.push({
        ...base(seq++, 'session_ended'),
        stopReason: 'end',
        totalTurns: 1,
        totalToolCalls: 0,
      } as SessionEvent);
      const { rows } = projectSessionEventsToDecisions({ events });
      const row = rows.find((r) => r.chosenTool === 'read');
      assert.ok(row);
      assert.equal(row!.result?.status, 'skipped');
    });
  });
});
