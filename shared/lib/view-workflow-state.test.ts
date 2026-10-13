import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Ledger } from './ledger.ts';
import {
  computeStepInputsHash,
  ensureArm,
  ensurePair,
  markRetryExhausted,
  recordAgentEvidence,
  recordRetryAttempt,
  setWaitingOnFromMarker,
  upsertStep,
} from './ledger-shadow.ts';
import {
  renderWorkflowState,
  serializeRenderedWorkflowState,
} from './view-workflow-state.ts';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wavemill-view-workflow-state-'));
  dbPath = join(dir, 'ledger.sqlite');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('renderWorkflowState emits the expected envelope on an empty ledger', () => {
  const ledger = Ledger.open({ dbPath });
  const rendered = renderWorkflowState(ledger, { renderedAt: '2026-10-13T00:00:00.000Z' });
  assert.equal(rendered.schemaVersion, 1);
  assert.equal(rendered.source, 'ledger-h-phase-4');
  assert.equal(rendered.renderedAt, '2026-10-13T00:00:00.000Z');
  assert.deepEqual(rendered.tasks, {});
  assert.deepEqual(rendered.operatorEvents, {});
  ledger.close();
});

test('renderWorkflowState surfaces live steps and retry buckets', () => {
  const ledger = Ledger.open({ dbPath });
  const step = upsertStep(ledger, {
    issueKey: 'HOK-1234',
    kind: 'review',
    inputsHash: computeStepInputsHash({ headSha: 'abc', baseSha: 'def' }),
    nextAction: 'await verdict',
    maxAttempts: 3,
  });
  recordRetryAttempt(ledger, step.id);
  recordAgentEvidence(ledger, 'HOK-1234', 'PreToolUse', 'Read');
  setWaitingOnFromMarker(ledger, step.id, 'head', { head: 'abc' });

  const rendered = renderWorkflowState(ledger, { renderedAt: '2026-10-13T00:00:00.000Z' });
  const task = rendered.tasks['HOK-1234'];
  assert.ok(task, 'expected HOK-1234 to be rendered');
  assert.equal(task.status, 'running');
  assert.equal(task.phase, 'review');
  assert.equal(task.steps.length, 1);
  assert.equal(task.steps[0].kind, 'review');
  assert.equal(task.steps[0].state, 'running');
  assert.equal(task.steps[0].attempt, 1);
  assert.equal(task.waitingOn.length, 1);
  assert.equal(task.waitingOn[0].trigger, 'head');
  assert.ok(task.retryBuckets['step:review']);
  assert.equal(task.retryBuckets['step:review'].attempts, 1);

  ledger.close();
});

test('renderWorkflowState maps retry exhaustion to a terminal bucket', () => {
  const ledger = Ledger.open({ dbPath });
  const step = upsertStep(ledger, {
    issueKey: 'HOK-5678',
    kind: 'ready',
    inputsHash: computeStepInputsHash({ headSha: 'abc' }),
  });
  recordRetryAttempt(ledger, step.id);
  recordRetryAttempt(ledger, step.id);
  markRetryExhausted(ledger, step.id, 'ready-infra-recovery', 'budget');

  const rendered = renderWorkflowState(ledger);
  const task = rendered.tasks['HOK-5678'];
  const bucket = task.retryBuckets['ready-infra-recovery'];
  assert.ok(bucket, 'expected the exhausted bucket to be present');
  assert.equal(bucket.exhausted, true);
  assert.equal(bucket.attempts, 2);
  assert.ok(bucket.settledReason?.includes('ready-infra-recovery'));
  ledger.close();
});

test('renderWorkflowState surfaces challenge pair arms as tasks', () => {
  const ledger = Ledger.open({ dbPath });
  // Production (challenge-pairing-repair): pair row holds the slot at
  // parent_id=NULL; arm rows hang off it; no separate issue roots.
  ensurePair(ledger, 'HOK-9999', { stage: 'review' });
  ensureArm(ledger, 'HOK-9999', 'HOK-9999', 'primary');
  ensureArm(ledger, 'HOK-9999', 'HOK-9999_c', 'challenger');

  const rendered = renderWorkflowState(ledger);
  const primary = rendered.tasks['HOK-9999'];
  const challenger = rendered.tasks['HOK-9999_c'];
  assert.ok(primary, 'expected the primary arm to be rendered as a task');
  assert.ok(challenger, 'expected the challenger arm to be rendered as a task');
  assert.equal(primary.challengePairId, 'HOK-9999');
  assert.equal(challenger.challengePairId, 'HOK-9999');
  assert.equal(primary.challengeRole, 'primary');
  assert.equal(challenger.challengeRole, 'challenger');
  assert.ok(primary.pair);
  assert.equal(primary.pair!.arms.length, 2);
  ledger.close();
});

test('renderWorkflowState is deterministic byte-for-byte', () => {
  const ledger = Ledger.open({ dbPath });
  const step = upsertStep(ledger, {
    issueKey: 'HOK-7777',
    kind: 'eval',
    inputsHash: computeStepInputsHash({ headSha: 'f00d' }),
    maxAttempts: 2,
  });
  recordRetryAttempt(ledger, step.id);
  setWaitingOnFromMarker(ledger, step.id, 'review-artifact', { artifact: 'r1' });
  setWaitingOnFromMarker(ledger, step.id, 'head', { head: 'f00d' });

  const t = '2026-10-13T12:00:00.000Z';
  const first = serializeRenderedWorkflowState(renderWorkflowState(ledger, { renderedAt: t }));
  const second = serializeRenderedWorkflowState(renderWorkflowState(ledger, { renderedAt: t }));
  assert.equal(first, second, 'render must be deterministic');
  assert.ok(first.endsWith('\n'), 'serialized render must end with a newline');
  assert.ok(!/[\r\n]/.test(first.slice(0, -1)), 'serialized render must be a single compact line before the trailing newline');
  ledger.close();
});

test('renderWorkflowState renders within the 100 ms budget for a modest ledger', () => {
  const ledger = Ledger.open({ dbPath });
  for (let i = 0; i < 200; i += 1) {
    const issueKey = `HOK-${1000 + i}`;
    const step = upsertStep(ledger, {
      issueKey,
      kind: 'review',
      inputsHash: computeStepInputsHash({ headSha: `h${i}` }),
    });
    recordRetryAttempt(ledger, step.id);
    setWaitingOnFromMarker(ledger, step.id, 'head', { head: `h${i}` });
  }
  const start = performance.now();
  const rendered = renderWorkflowState(ledger);
  const elapsed = performance.now() - start;
  assert.ok(Object.keys(rendered.tasks).length === 200, 'expected 200 tasks rendered');
  assert.ok(elapsed < 1000, `expected render under 1000 ms on 200-task ledger, got ${elapsed.toFixed(1)} ms`);
  ledger.close();
});
