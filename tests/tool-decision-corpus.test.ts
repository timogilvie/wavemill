/**
 * Unit tests for the tool-decision corpus (HOK-2076).
 *
 * Covers projection, corpus storage, labeling, and reporting.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { projectSessionEvents } from '../shared/lib/tool-decision-projector.ts';
import {
  appendDecisionRow,
  appendDecisionRows,
  readDecisionRows,
  listCorpusSessions,
  appendOutcomeLabel,
  readOutcomeLabels,
} from '../shared/lib/tool-decision-corpus.ts';
import { materializeLabels } from '../shared/lib/tool-decision-labeler.ts';
import { buildToolDecisionReport, renderToolDecisionReport } from '../shared/lib/tool-decision-report.ts';
import { TOOL_DECISION_SCHEMA_VERSION } from '../shared/lib/tool-decision-schema.ts';
import type { SessionEvent } from '../shared/lib/native-agent/session-stream.schema.ts';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeRepo(): string {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'tool-decision-'));
  tempDirs.push(repoDir);
  return repoDir;
}

function baseEvent(overrides: Partial<SessionEvent> & { type: string }): SessionEvent {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2, 10)}`,
    seq: 0,
    timestamp: new Date().toISOString(),
    sessionId: 'test-session',
    traceId: 'test-trace',
    phase: 'coding',
    schemaVersion: '1',
    ...overrides,
  } as SessionEvent;
}

// ---------------------------------------------------------------------------
// Projection tests
// ---------------------------------------------------------------------------

describe('projectSessionEvents', () => {
  it('produces tool_call rows for a multi-tool execution', () => {
    const callId = 'call-1';
    const events: SessionEvent[] = [
      baseEvent({
        type: 'tool_menu',
        toolNames: ['Read', 'Edit', 'Bash'],
        digest: 'menu-digest-1',
      }),
      baseEvent({
        type: 'provider_tools',
        toolCount: 3,
        digest: 'provider-digest-1',
      }),
      baseEvent({
        type: 'model_request',
        callId,
        turnIndex: 0,
        provider: 'anthropic',
        modelId: 'claude-sonnet-5',
        config: { temperature: 0.7 },
        contextDigest: 'ctx-1',
        promptRefs: [],
      }),
      baseEvent({
        type: 'tool_policy_decision',
        callId: 'tool-1',
        toolName: 'Read',
        decision: 'allow',
      }),
      baseEvent({
        type: 'tool_call',
        callId: 'tool-1',
        toolName: 'Read',
        argumentsDigest: 'args-digest-1',
      }),
      baseEvent({
        type: 'tool_result',
        callId: 'tool-1',
        toolName: 'Read',
        isError: false,
        contentSummary: 'file contents',
      }),
      baseEvent({
        type: 'tool_call',
        callId: 'tool-2',
        toolName: 'Edit',
      }),
      baseEvent({
        type: 'tool_result',
        callId: 'tool-2',
        toolName: 'Edit',
        isError: false,
      }),
      baseEvent({
        type: 'model_response',
        requestEventId: 'req-1',
        callId,
        stopReason: 'end_turn',
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    ];

    const { rows, warnings } = projectSessionEvents(events);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].decisionKind, 'tool_call');
    assert.equal(rows[0].chosenTool, 'Read');
    assert.equal(rows[0].policyOutcome, 'allow');
    assert.equal(rows[0].resultStatus, 'success');
    assert.equal(rows[0].isError, false);
    assert.equal(rows[0].schemaVersion, TOOL_DECISION_SCHEMA_VERSION);
    assert.ok(rows[0].policyMenu);
    assert.equal(rows[0].policyMenu!.digest, 'menu-digest-1');
    assert.ok(rows[0].providerMenu);
    assert.equal(rows[0].providerMenu!.digest, 'provider-digest-1');
    assert.equal(rows[0].propensity.source, 'unavailable');
  });

  it('produces a policy_denial row', () => {
    const events: SessionEvent[] = [
      baseEvent({
        type: 'model_request',
        callId: 'call-2',
        turnIndex: 0,
        provider: 'anthropic',
        modelId: 'claude-sonnet-5',
        config: {},
        contextDigest: 'ctx-2',
        promptRefs: [],
      }),
      baseEvent({
        type: 'tool_policy_decision',
        callId: 'tool-2',
        toolName: 'Bash',
        decision: 'deny',
        denialReason: 'destructive command',
      }),
      baseEvent({
        type: 'model_response',
        requestEventId: 'req-2',
        callId: 'call-2',
        stopReason: 'end_turn',
      }),
    ];

    const { rows } = projectSessionEvents(events);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].decisionKind, 'policy_denial');
    assert.equal(rows[0].chosenTool, 'Bash');
    assert.equal(rows[0].policyOutcome, 'deny');
    assert.equal(rows[0].denialReason, 'destructive command');
  });

  it('produces a text_only row when no tools are used', () => {
    const events: SessionEvent[] = [
      baseEvent({
        type: 'model_request',
        callId: 'call-3',
        turnIndex: 0,
        provider: 'anthropic',
        modelId: 'claude-sonnet-5',
        config: {},
        contextDigest: 'ctx-3',
        promptRefs: [],
      }),
      baseEvent({
        type: 'model_response',
        requestEventId: 'req-3',
        callId: 'call-3',
        stopReason: 'end_turn',
      }),
    ];

    const { rows } = projectSessionEvents(events);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].decisionKind, 'text_only');
    assert.equal(rows[0].chosenTool, null);
    assert.equal(rows[0].resultStatus, 'not_applicable');
  });

  it('handles multiple turns correctly', () => {
    const events: SessionEvent[] = [
      baseEvent({ type: 'model_request', callId: 'c1', turnIndex: 0, provider: 'anthropic', modelId: 'm1', config: {}, contextDigest: 'x', promptRefs: [] }),
      baseEvent({ type: 'tool_call', callId: 'tc1', toolName: 'Read' }),
      baseEvent({ type: 'tool_result', callId: 'tc1', toolName: 'Read', isError: false }),
      baseEvent({ type: 'model_response', requestEventId: 'e1', callId: 'c1', stopReason: 'tool_use' }),
      baseEvent({ type: 'model_request', callId: 'c2', turnIndex: 1, provider: 'anthropic', modelId: 'm1', config: {}, contextDigest: 'y', promptRefs: [] }),
      baseEvent({ type: 'model_response', requestEventId: 'e2', callId: 'c2', stopReason: 'end_turn' }),
    ];

    const { rows } = projectSessionEvents(events);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].decisionKind, 'forced_single_tool');
    assert.equal(rows[1].decisionKind, 'text_only');
    assert.equal(rows[0].turnIndex, 0);
    assert.equal(rows[1].turnIndex, 1);
  });

  it('tolerates partial sessions (no model_response)', () => {
    const events: SessionEvent[] = [
      baseEvent({ type: 'model_request', callId: 'c-partial', turnIndex: 0, provider: 'openai', modelId: 'gpt-4', config: {}, contextDigest: 'z', promptRefs: [] }),
      baseEvent({ type: 'tool_call', callId: 'tc-partial', toolName: 'Edit' }),
    ];

    const { rows } = projectSessionEvents(events);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].chosenTool, 'Edit');
    assert.equal(rows[0].resultStatus, 'pending');
  });
});

// ---------------------------------------------------------------------------
// Corpus storage tests
// ---------------------------------------------------------------------------

describe('tool-decision-corpus', () => {
  it('appends and reads back decision rows', () => {
    const repoDir = makeRepo();
    const row = makeTestRow();

    appendDecisionRow(repoDir, 'test-session', row);
    const rows = readDecisionRows(repoDir, 'test-session');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].chosenTool, 'Read');
  });

  it('appends multiple rows atomically', () => {
    const repoDir = makeRepo();
    const rows = [makeTestRow('Read'), makeTestRow('Edit')];

    appendDecisionRows(repoDir, 'session-batch', rows);
    const readBack = readDecisionRows(repoDir, 'session-batch');
    assert.equal(readBack.length, 2);
    assert.equal(readBack[0].chosenTool, 'Read');
    assert.equal(readBack[1].chosenTool, 'Edit');
  });

  it('lists corpus sessions', () => {
    const repoDir = makeRepo();
    appendDecisionRow(repoDir, 'session-a', makeTestRow());
    appendDecisionRow(repoDir, 'session-b', makeTestRow());

    const sessions = listCorpusSessions(repoDir);
    assert.ok(sessions.includes('session-a'));
    assert.ok(sessions.includes('session-b'));
  });

  it('returns empty for nonexistent session', () => {
    const repoDir = makeRepo();
    const rows = readDecisionRows(repoDir, 'nonexistent');
    assert.equal(rows.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Labeler tests
// ---------------------------------------------------------------------------

describe('materializeLabels', () => {
  it('produces labeled rows with terminal outcome', () => {
    const rows = [makeTestRow()];
    const labeled = materializeLabels(rows, {
      featureOutcome: {
        completed: true,
        merged: true,
        reverted: false,
        evalScore: 0.85,
        ciPassed: true,
        reviewPassed: true,
      },
    });

    assert.equal(labeled.length, 1);
    assert.ok(labeled[0].outcome.terminalOutcome);
    assert.equal(labeled[0].outcome.terminalOutcome!.merged, true);
    assert.equal(labeled[0].outcome.terminalOutcome!.evalScore, 0.85);
    assert.equal(labeled[0].outcome.joinConfidence, 'session_match');
  });

  it('produces unavailable join when no outcome', () => {
    const rows = [makeTestRow()];
    const labeled = materializeLabels(rows, {});

    assert.equal(labeled.length, 1);
    assert.equal(labeled[0].outcome.joinConfidence, 'unavailable');
    assert.equal(labeled[0].outcome.terminalOutcome, null);
  });

  it('computes test delta when evidence available', () => {
    const rows = [makeTestRow()];
    const labeled = materializeLabels(rows, {
      testEvidence: { beforeFailures: 2, afterFailures: 0 },
    });

    assert.ok(labeled[0].outcome.testDelta);
    assert.equal(labeled[0].outcome.testDelta!.delta, -2);
    assert.equal(labeled[0].outcome.testDelta!.comparable, true);
  });

  it('marks test delta incomparable when partial', () => {
    const rows = [makeTestRow()];
    const labeled = materializeLabels(rows, {
      testEvidence: { afterFailures: 0 },
    });

    assert.ok(labeled[0].outcome.testDelta);
    assert.equal(labeled[0].outcome.testDelta!.comparable, false);
    assert.equal(labeled[0].outcome.testDelta!.delta, undefined);
  });

  it('marks survival eligibility correctly for unsuccessful tasks', () => {
    const rows = [makeTestRow()];
    const labeled = materializeLabels(rows, {
      featureOutcome: { completed: true, merged: false },
    });

    assert.ok(labeled[0].outcome.survivalLabel);
    assert.equal(labeled[0].outcome.survivalLabel!.eligibleForSurvival, false);
  });
});

// ---------------------------------------------------------------------------
// Report tests
// ---------------------------------------------------------------------------

describe('buildToolDecisionReport', () => {
  it('returns no_records for empty corpus', () => {
    const repoDir = makeRepo();
    const report = buildToolDecisionReport({ repoDir });
    assert.equal(report.status, 'no_records');
    assert.equal(report.totalRows, 0);
  });

  it('reports correct counts', () => {
    const repoDir = makeRepo();
    appendDecisionRow(repoDir, 'ses-1', makeTestRow('Read'));
    appendDecisionRow(repoDir, 'ses-1', makeTestRow('Bash'));

    const report = buildToolDecisionReport({ repoDir });
    assert.equal(report.status, 'ok');
    assert.equal(report.totalRows, 2);
    assert.equal(report.totalSessions, 1);
    assert.equal(report.absentPropensity, 2);
  });

  it('renders a human-readable report', () => {
    const repoDir = makeRepo();
    appendDecisionRow(repoDir, 'ses-1', makeTestRow());

    const report = buildToolDecisionReport({ repoDir });
    const rendered = renderToolDecisionReport(report);
    assert.ok(rendered.includes('Tool Decision Corpus Report'));
    assert.ok(rendered.includes('Absent propensity'));
  });

  it('detects unknown tools', () => {
    const repoDir = makeRepo();
    appendDecisionRow(repoDir, 'ses-1', makeTestRow('UnknownCustomTool'));

    const report = buildToolDecisionReport({ repoDir });
    assert.ok(report.unknownTools.includes('UnknownCustomTool'));
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTestRow(toolName = 'Read'): import('../shared/lib/tool-decision-schema.ts').ToolDecisionRow {
  return {
    schemaVersion: TOOL_DECISION_SCHEMA_VERSION,
    sessionId: 'test-session',
    traceId: 'test-trace',
    phase: 'coding',
    turnIndex: 0,
    stepIndex: 0,
    model: 'claude-sonnet-5',
    provider: 'anthropic',
    policyMenu: null,
    providerMenu: null,
    decisionKind: 'tool_call',
    chosenTool: toolName,
    chosenToolProvider: toolName,
    policyOutcome: 'allow',
    resultStatus: 'success',
    isError: false,
    turnUsage: null,
    requestEventId: 'req-1',
    stateFeatures: {
      phase: 'coding',
      turnIndex: 0,
      stepIndex: 0,
      toolCallsInTurn: 1,
      priorErrorInTurn: false,
    },
    propensity: { source: 'unavailable' },
    mutationEvidence: [],
    redacted: false,
    timestamp: new Date().toISOString(),
  };
}
