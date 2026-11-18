/**
 * HOK-3509 — unit tests for the cross-task correlation step.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildFleetIncident,
  correlateFleetFailures,
  coveredTaskCandidates,
  fleetCauseForAttempt,
  fleetCauseKey,
  isCorrelatableFailure,
  jobFailureFacts,
  readTaskFailureFacts,
  type FailureFact,
} from './fleet-incident-correlation.ts';
import { classifyArmFault, isModelQualitySignal } from './arm-failure-taxonomy.ts';
import { buildArmReliabilityRecord } from './arm-reliability.ts';
import { createIncidentDraft } from './wavemill-incident-model.ts';

const fact = (over: Partial<FailureFact> = {}): FailureFact => ({
  taskId: 'HOK-1',
  stage: 'coding',
  attemptId: 'r-1',
  failedAt: Date.parse('2026-11-10T16:52:57Z'),
  endpoint: 'deepseek-v4-flash',
  endpointEvidence: 'launch-intent',
  failureKind: 'coding-exited-without-result',
  faultClass: 'harness-fault',
  sourcePath: '/tmp/x/.coding-result.json',
  ...over,
});

test('three tasks on same endpoint/class inside window → one correlation', () => {
  const now = Date.parse('2026-11-10T17:00:00Z');
  const windowMs = 10 * 60_000;
  const facts = [
    fact({ taskId: 'HOK-1' }),
    fact({ taskId: 'HOK-2', attemptId: 'r-2', failedAt: Date.parse('2026-11-10T16:54:02Z') }),
    fact({ taskId: 'HOK-3', attemptId: 'r-3', failedAt: Date.parse('2026-11-10T16:55:17Z') }),
  ];
  const correlations = correlateFleetFailures(facts, { windowMs, threshold: 3 });
  assert.equal(correlations.length, 1);
  const [one] = correlations;
  assert.equal(one.causeKey, 'deepseek-v4-flash::harness-fault');
  assert.equal(one.tasks.length, 3);
  assert.equal(one.fleetFaultClass, 'harness-fault');
  assert.ok(now >= one.lastAt);
});

test('two tasks on same cause key → no correlation (threshold 3)', () => {
  const facts = [fact({ taskId: 'HOK-1' }), fact({ taskId: 'HOK-2', attemptId: 'r-2' })];
  assert.deepEqual(correlateFleetFailures(facts, { windowMs: 60_000_000, threshold: 3 }), []);
});

test('same tasks on different endpoints → no correlation', () => {
  const facts = [
    fact({ taskId: 'HOK-1', endpoint: 'deepseek-v4-flash' }),
    fact({ taskId: 'HOK-2', attemptId: 'r-2', endpoint: 'qwen-max' }),
    fact({ taskId: 'HOK-3', attemptId: 'r-3', endpoint: 'kimi-k2' }),
  ];
  assert.deepEqual(correlateFleetFailures(facts, { windowMs: 60_000_000, threshold: 3 }), []);
});

test('re-polling the same attempts does not change the task count', () => {
  const facts = [
    fact({ taskId: 'HOK-1' }),
    fact({ taskId: 'HOK-2', attemptId: 'r-2', failedAt: Date.parse('2026-11-10T16:54:02Z') }),
    fact({ taskId: 'HOK-3', attemptId: 'r-3', failedAt: Date.parse('2026-11-10T16:55:17Z') }),
  ];
  const first = correlateFleetFailures(facts, { windowMs: 10 * 60_000, threshold: 3 });
  const second = correlateFleetFailures([...facts, ...facts], { windowMs: 10 * 60_000, threshold: 3 });
  assert.equal(first[0].tasks.length, second[0].tasks.length);
});

test('attempts spread wider than the window → no correlation', () => {
  const facts = [
    fact({ taskId: 'HOK-1', failedAt: Date.parse('2026-11-10T10:00:00Z') }),
    fact({ taskId: 'HOK-2', attemptId: 'r-2', failedAt: Date.parse('2026-11-10T11:00:00Z') }),
    fact({ taskId: 'HOK-3', attemptId: 'r-3', failedAt: Date.parse('2026-11-10T12:00:00Z') }),
  ];
  assert.deepEqual(correlateFleetFailures(facts, { windowMs: 60_000, threshold: 3 }), []);
});

test('a direct-model-evidence kind never correlates', () => {
  const protocolFact = fact({ failureKind: 'completion-protocol', faultClass: 'model-fault' });
  assert.equal(isCorrelatableFailure(protocolFact), false);
  const facts = [protocolFact, { ...protocolFact, taskId: 'HOK-2' }, { ...protocolFact, taskId: 'HOK-3' }];
  assert.deepEqual(correlateFleetFailures(facts, { windowMs: 60_000_000, threshold: 3 }), []);
});

test('fleetCauseKey is stable: same (endpoint, faultClass) → same key', () => {
  assert.equal(
    fleetCauseKey({ endpoint: 'deepseek-v4-flash', faultClass: 'harness-fault' }),
    fleetCauseKey({ endpoint: 'deepseek-v4-flash', faultClass: 'harness-fault' }),
  );
  assert.notEqual(
    fleetCauseKey({ endpoint: 'deepseek-v4-flash', faultClass: 'harness-fault' }),
    fleetCauseKey({ endpoint: 'deepseek-v4-flash', faultClass: 'provider-fault' }),
  );
});

test('jobFailureFacts classifies GitHub rate limit evidence into a dependency fact', () => {
  const now = Date.parse('2026-11-10T17:00:00Z');
  const facts = jobFailureFacts([
    {
      id: 'job-1', kind: 'pr-ci-status', status: 'failed', taskId: 'HOK-1', source: 'state',
      error: 'HTTP 403: API rate limit exceeded for user ID x-ratelimit-remaining: 0',
      finishedAt: '2026-11-10T16:55:00Z',
    },
    { id: 'job-2', kind: 'pr-ci-status', status: 'failed', taskId: 'HOK-2', source: 'state', error: 'some other error', finishedAt: '2026-11-10T16:55:00Z' },
  ], now, 60 * 60_000);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].endpoint, 'github-api');
  assert.equal(facts[0].failureKind, 'github-rate-limited');
});

test('buildFleetIncident writes the cause key and knownIssueIds onto the draft', () => {
  const now = Date.parse('2026-11-10T17:00:00Z');
  const correlation = correlateFleetFailures([
    fact({ taskId: 'HOK-1' }),
    fact({ taskId: 'HOK-2', attemptId: 'r-2', failedAt: Date.parse('2026-11-10T16:54:02Z') }),
    fact({ taskId: 'HOK-3', attemptId: 'r-3', failedAt: Date.parse('2026-11-10T16:55:17Z') }),
  ], { windowMs: 10 * 60_000, threshold: 3 })[0];
  const draft = buildFleetIncident(correlation, { session: 's', now: new Date(now) });
  assert.equal(draft.taskId, null);
  assert.equal(draft.rootCauseClass, 'fleet_shared_endpoint_failure');
  assert.equal(draft.metadata?.fleet?.causeKey, 'deepseek-v4-flash::harness-fault');
  assert.deepEqual(draft.metadata?.knownIssueIds, ['HOK-1', 'HOK-2', 'HOK-3']);
});

test('coveredTaskCandidates filters a stale-task candidate for a correlated task/stage', () => {
  const correlation = correlateFleetFailures([
    fact({ taskId: 'HOK-1' }),
    fact({ taskId: 'HOK-2', attemptId: 'r-2', failedAt: Date.parse('2026-11-10T16:54:02Z') }),
    fact({ taskId: 'HOK-3', attemptId: 'r-3', failedAt: Date.parse('2026-11-10T16:55:17Z') }),
  ], { windowMs: 10 * 60_000, threshold: 3 });
  const candidate = createIncidentDraft({
    taskId: 'HOK-1',
    session: null,
    category: 'configuration_operator_condition',
    severity: 'medium',
    confidence: 'high',
    lifecycle: 'observed',
    rootCauseClass: 'active_unpublished_work_stalled',
    summary: 'stall',
    operatorAction: 'x',
    evidence: [],
    metadata: {},
  });
  const unrelated = createIncidentDraft({
    taskId: 'HOK-99',
    session: null,
    category: 'configuration_operator_condition',
    severity: 'medium',
    confidence: 'high',
    lifecycle: 'observed',
    rootCauseClass: 'active_unpublished_work_stalled',
    summary: 'stall',
    operatorAction: 'x',
    evidence: [],
    metadata: {},
  });
  const covered = coveredTaskCandidates([candidate, unrelated], correlation);
  assert.equal(covered.length, 1);
  assert.equal(covered[0], candidate);
});

test('fleetCauseForAttempt finds a covering incident; returns null when none', () => {
  const draft = buildFleetIncident(correlateFleetFailures([
    fact({ taskId: 'HOK-1' }),
    fact({ taskId: 'HOK-2', attemptId: 'r-2', failedAt: Date.parse('2026-11-10T16:54:02Z') }),
    fact({ taskId: 'HOK-3', attemptId: 'r-3', failedAt: Date.parse('2026-11-10T16:55:17Z') }),
  ], { windowMs: 10 * 60_000, threshold: 3 })[0], { session: null, now: new Date() });
  const hit = fleetCauseForAttempt({ incidents: [draft], taskId: 'HOK-2', attemptId: 'r-2' });
  assert.ok(hit);
  assert.equal(hit?.fleetFaultClass, 'harness-fault');
  const miss = fleetCauseForAttempt({ incidents: [draft], taskId: 'HOK-99' });
  assert.equal(miss, null);
});

test('fleetCauseForAttempt never covers a later failure on the same task and stage', () => {
  const draft = buildFleetIncident(correlateFleetFailures([
    fact({ taskId: 'HOK-1' }),
    fact({ taskId: 'HOK-2', attemptId: 'r-2' }),
    fact({ taskId: 'HOK-3', attemptId: 'r-3' }),
  ], { windowMs: 10 * 60_000, threshold: 3 })[0], { session: null, now: new Date() });
  assert.equal(fleetCauseForAttempt({ incidents: [draft], taskId: 'HOK-2', stage: 'coding', attemptId: 'later-run' }), null);
});

test('classifyArmFault respects fleetCause override (settled-without-result → harness via fleet)', () => {
  // Without fleet cause: a settled-without-result is model-fault (no harness hold evidence).
  const plain = classifyArmFault({ failureKind: 'coding-exited-without-result', detail: 'Interrupted: coding agent settled without a result (agent-stalled)' });
  assert.equal(plain, 'model-fault');
  // With fleet cause: the shared cause rewrites attribution to harness.
  const withFleet = classifyArmFault({
    failureKind: 'coding-exited-without-result',
    detail: 'Interrupted: coding agent settled without a result (agent-stalled)',
    fleetCause: { fleetFaultClass: 'harness-fault' },
  });
  assert.equal(withFleet, 'harness-fault');
  assert.equal(isModelQualitySignal(withFleet), false);
});

test('classifyArmFault keeps cancelled/policy-denied as harness-fault even with fleetCause', () => {
  const cancelled = classifyArmFault({ failureKind: 'cancelled', fleetCause: { fleetFaultClass: 'provider-fault' } });
  assert.equal(cancelled, 'harness-fault');
  const denied = classifyArmFault({ failureKind: 'policy-denied', fleetCause: { fleetFaultClass: 'provider-fault' } });
  assert.equal(denied, 'harness-fault');
});

test('buildArmReliabilityRecord records fleetIncident + rewrites qualitySignalEligible', () => {
  const record = buildArmReliabilityRecord({
    issueId: 'HOK-1',
    challengePairId: 'pair-1',
    challengeRole: 'primary',
    stage: 'coding',
    model: 'deepseek-v4-flash',
    abortReason: 'terminal_stage_failure:coding-exited-without-result',
    detail: 'Interrupted: coding agent settled without a result (agent-stalled)',
    fleetCause: {
      fingerprint: 'fp-fleet',
      causeKey: 'deepseek-v4-flash::harness-fault',
      fleetFaultClass: 'harness-fault',
    },
  });
  assert.equal(record.faultClass, 'harness-fault');
  assert.equal(record.qualitySignalEligible, false);
  assert.equal(record.fleetIncident?.fingerprint, 'fp-fleet');
  assert.equal(record.fleetIncident?.causeKey, 'deepseek-v4-flash::harness-fault');
});

test('readTaskFailureFacts reads current + history and respects the window', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-'));
  try {
    const featureDir = join(dir, 'features', 'x');
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, '.coding-result.json'), JSON.stringify({
      stage: 'coding',
      status: 'failed',
      startedAt: '2026-11-10T16:50:00Z',
      finishedAt: '2026-11-10T16:52:57Z',
      agent: 'claude',
      model: 'deepseek-v4-flash',
      intendedModel: 'deepseek-v4-flash',
      notes: 'Interrupted: coding agent settled without a result (agent-stalled)',
      runId: 'r-1',
      history: [{
        stage: 'coding',
        status: 'failed',
        startedAt: '2026-11-10T16:20:00Z',
        finishedAt: '2026-11-10T16:24:11Z',
        agent: 'claude',
        model: 'deepseek-v4-flash',
        intendedModel: 'deepseek-v4-flash',
        notes: 'Interrupted: coding agent settled without a result (agent-stalled)',
        runId: 'r-0',
      }],
    }));
    const now = Date.parse('2026-11-10T17:00:00Z');
    const facts = readTaskFailureFacts({ taskId: 'HOK-1', featureDir, now, windowMs: 10 * 60_000 });
    assert.equal(facts.length, 1, 'only the recent attempt is in the 10m window');
    assert.equal(facts[0].endpoint, 'deepseek-v4-flash');
    assert.equal(facts[0].endpointEvidence, 'launch-intent');
    assert.equal(facts[0].failureKind, 'coding-exited-without-result');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readTaskFailureFacts honours the cached code-failure decision', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-decision-'));
  try {
    const featureDir = join(dir, 'features', 'x');
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, '.coding-result.json'), JSON.stringify({
      stage: 'coding', status: 'failed', startedAt: '2026-11-10T16:50:00Z', finishedAt: '2026-11-10T16:52:57Z',
      intendedModel: 'deepseek-v4-flash', notes: 'test failure', runId: 'r-1',
    }));
    writeFileSync(join(featureDir, '.coding-failure-decision.json'), JSON.stringify({ class: 'code-failure' }));
    assert.deepEqual(readTaskFailureFacts({
      taskId: 'HOK-1', featureDir, now: Date.parse('2026-11-10T17:00:00Z'), windowMs: 10 * 60_000,
    }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readTaskFailureFacts preserves typed exit evidence for the fleet cause key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-exit-evidence-'));
  try {
    const featureDir = join(dir, 'features', 'x');
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, '.coding-result.json'), JSON.stringify({
      stage: 'coding', status: 'failed', startedAt: '2026-11-10T16:50:00Z', finishedAt: '2026-11-10T16:52:57Z',
      executedModel: 'deepseek-v4-flash', executionEvidence: { status: 'direct' },
      notes: 'Interrupted: coding agent settled without a result (agent-stalled)', runId: 'r-1',
      artifacts: { exitEvidence: { reason: 'agent-stalled', harnessHold: { toolName: 'run_tests', toolCallId: 'call-1', startedAt: '2026-11-10T16:40:00Z' } } },
    }));
    const [fact] = readTaskFailureFacts({
      taskId: 'HOK-1', featureDir, now: Date.parse('2026-11-10T17:00:00Z'), windowMs: 10 * 60_000,
    });
    assert.equal(fact.faultClass, 'harness-fault');
    assert.equal(fleetCauseKey(fact), 'deepseek-v4-flash::harness-fault');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
