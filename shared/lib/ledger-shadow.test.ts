import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from './ledger.ts';
import {
  canonicalConditionJson,
  clearWaitingOnFromMarker,
  computeStepInputsHash,
  ensureIssueRoot,
  findActiveStep,
  markRetryExhausted,
  parseWaitingTrigger,
  recordAgentEvidence,
  recordRetryAttempt,
  settleStep,
  setWaitingOnFromMarker,
  stepInputsFromCliArgs,
  upsertStep,
  withShadowSuppressing,
} from './ledger-shadow.ts';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wavemill-ledger-shadow-'));
  dbPath = join(dir, 'ledger.sqlite');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('computeStepInputsHash is stable across field insertion order', () => {
  const a = computeStepInputsHash({ headSha: 'abc', baseSha: 'def', prNumber: 42 });
  const b = computeStepInputsHash({ prNumber: 42, baseSha: 'def', headSha: 'abc' });
  assert.equal(a, b);
  const c = computeStepInputsHash({ headSha: 'abc', baseSha: 'def', prNumber: 43 });
  assert.notEqual(a, c);
});

test('computeStepInputsHash skips undefined and empty fields', () => {
  const sparse = computeStepInputsHash({ headSha: 'abc' });
  const padded = computeStepInputsHash({ headSha: 'abc', baseSha: undefined, promptIdentity: '' });
  assert.equal(sparse, padded);
});

test('ensureIssueRoot is idempotent', () => {
  const ledger = Ledger.open({ dbPath });
  const root1 = ensureIssueRoot(ledger, 'HOK-9999');
  const root2 = ensureIssueRoot(ledger, 'HOK-9999');
  assert.equal(root1.id, root2.id);
  assert.equal(root1.slug, 'HOK-9999');
  assert.equal(root1.kind, 'issue');
  ledger.close();
});

test('upsertStep inserts a child under the issue root and promotes to running', () => {
  const ledger = Ledger.open({ dbPath });
  const inputsHash = computeStepInputsHash({ headSha: 'abc', baseSha: 'def' });
  const result = upsertStep(ledger, { issueKey: 'HOK-9999', kind: 'review', inputsHash });
  assert.equal(result.isNew, true);
  const step = ledger.getTask(result.id);
  assert.ok(step);
  assert.equal(step!.state, 'running');
  assert.equal(step!.kind, 'step');
  assert.equal(step!.slug, 'review');
  assert.equal(step!.inputs_hash, inputsHash);
  ledger.close();
});

test('upsertStep returns existing row on second call with same inputs', () => {
  const ledger = Ledger.open({ dbPath });
  const inputsHash = computeStepInputsHash({ headSha: 'abc' });
  const first = upsertStep(ledger, { issueKey: 'HOK-9999', kind: 'ready', inputsHash });
  const second = upsertStep(ledger, { issueKey: 'HOK-9999', kind: 'ready', inputsHash });
  assert.equal(second.id, first.id);
  assert.equal(second.isNew, false);
  ledger.close();
});

test('upsertStep with a new head creates a new step row', () => {
  const ledger = Ledger.open({ dbPath });
  const first = upsertStep(ledger, {
    issueKey: 'HOK-9999',
    kind: 'review',
    inputsHash: computeStepInputsHash({ headSha: 'abc' }),
  });
  const second = upsertStep(ledger, {
    issueKey: 'HOK-9999',
    kind: 'review',
    inputsHash: computeStepInputsHash({ headSha: 'xyz' }),
  });
  assert.notEqual(first.id, second.id);
  assert.equal(second.isNew, true);
  ledger.close();
});

test('findActiveStep returns the newest non-settled step', () => {
  const ledger = Ledger.open({ dbPath });
  const first = upsertStep(ledger, {
    issueKey: 'HOK-9999',
    kind: 'review',
    inputsHash: computeStepInputsHash({ headSha: 'abc' }),
  });
  const second = upsertStep(ledger, {
    issueKey: 'HOK-9999',
    kind: 'review',
    inputsHash: computeStepInputsHash({ headSha: 'xyz' }),
  });
  settleStep(ledger, first.id, 'done');
  const active = findActiveStep(ledger, 'HOK-9999');
  assert.ok(active);
  assert.equal(active!.id, second.id);
  ledger.close();
});

test('findActiveStep returns null when no steps are running', () => {
  const ledger = Ledger.open({ dbPath });
  assert.equal(findActiveStep(ledger, 'HOK-404'), null);
  ledger.close();
});

test('recordRetryAttempt advances task.attempt', () => {
  const ledger = Ledger.open({ dbPath });
  const step = upsertStep(ledger, {
    issueKey: 'HOK-9999',
    kind: 'review',
    inputsHash: computeStepInputsHash({ headSha: 'abc' }),
    maxAttempts: 5,
  });
  const attempt = recordRetryAttempt(ledger, step.id);
  assert.equal(attempt, 1);
  ledger.close();
});

test('markRetryExhausted settles step with aborted:exhausted reason', () => {
  const ledger = Ledger.open({ dbPath });
  const step = upsertStep(ledger, {
    issueKey: 'HOK-9999',
    kind: 'review',
    inputsHash: computeStepInputsHash({ headSha: 'abc' }),
  });
  markRetryExhausted(ledger, step.id, 'review-infra-recovery', 'ci-red');
  const row = ledger.getTask(step.id);
  assert.ok(row);
  assert.equal(row!.settled_as, 'aborted');
  assert.equal(row!.settled_reason, 'exhausted:review-infra-recovery:ci-red');
  ledger.close();
});

test('setWaitingOnFromMarker writes a mirror row', () => {
  const ledger = Ledger.open({ dbPath });
  const step = upsertStep(ledger, {
    issueKey: 'HOK-9999',
    kind: 'review',
    inputsHash: computeStepInputsHash({ headSha: 'abc' }),
  });
  setWaitingOnFromMarker(ledger, step.id, 'head', { head: 'abc', expiresOn: ['head'] });
  const rows = ledger.listWaitingOn(step.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].trigger, 'head');
  ledger.close();
});

test('clearWaitingOnFromMarker removes the mirror row', () => {
  const ledger = Ledger.open({ dbPath });
  const step = upsertStep(ledger, {
    issueKey: 'HOK-9999',
    kind: 'review',
    inputsHash: computeStepInputsHash({ headSha: 'abc' }),
  });
  setWaitingOnFromMarker(ledger, step.id, 'head', { head: 'abc' });
  clearWaitingOnFromMarker(ledger, step.id, 'head');
  assert.equal(ledger.listWaitingOn(step.id).length, 0);
  ledger.close();
});

test('recordAgentEvidence writes an evidence row on the active step', () => {
  const ledger = Ledger.open({ dbPath });
  const step = upsertStep(ledger, {
    issueKey: 'HOK-9999',
    kind: 'review',
    inputsHash: computeStepInputsHash({ headSha: 'abc' }),
  });
  const result = recordAgentEvidence(ledger, 'HOK-9999', 'Stop', 'reviewer idle');
  assert.ok(result);
  assert.equal(result!.stepId, step.id);
  const rows = ledger.listEvidence(step.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'agent-hook');
  assert.equal(rows[0].event, 'Stop');
  ledger.close();
});

test('recordAgentEvidence returns null when no active step exists', () => {
  const ledger = Ledger.open({ dbPath });
  const result = recordAgentEvidence(ledger, 'HOK-1234', 'Stop', 'orphan');
  assert.equal(result, null);
  ledger.close();
});

test('withShadowSuppressing returns null and never throws by default', () => {
  const result = withShadowSuppressing(() => {
    throw new Error('simulated failure');
  });
  assert.equal(result, null);
});

test('withShadowSuppressing rethrows when strict', () => {
  assert.throws(() => withShadowSuppressing(() => { throw new Error('boom'); }, { strict: true }));
});

test('stepInputsFromCliArgs parses CLI string inputs', () => {
  const inputs = stepInputsFromCliArgs({
    head: 'abc',
    base: 'def',
    pr: '42',
    pair: 'pair-1',
    side: 'primary',
    prompt: 'sha256:xyz',
  });
  assert.equal(inputs.headSha, 'abc');
  assert.equal(inputs.baseSha, 'def');
  assert.equal(inputs.prNumber, 42);
  assert.equal(inputs.pairId, 'pair-1');
  assert.equal(inputs.side, 'primary');
  assert.equal(inputs.promptIdentity, 'sha256:xyz');
});

test('stepInputsFromCliArgs drops invalid side', () => {
  const inputs = stepInputsFromCliArgs({ side: 'nonsense' });
  assert.equal(inputs.side, undefined);
});

test('parseWaitingTrigger accepts every HOK-3172 trigger', () => {
  const triggers = [
    'head',
    'operator-event',
    'review-artifact',
    'review-artifact-substantive',
    'ready-artifact',
    'remote',
    'waiting-on',
    'deadline',
  ];
  for (const trigger of triggers) {
    assert.equal(parseWaitingTrigger(trigger), trigger);
  }
  assert.throws(() => parseWaitingTrigger('bogus-trigger'));
});

test('canonicalConditionJson sorts keys deterministically', () => {
  const a = canonicalConditionJson({ b: 1, a: 2, c: { y: 1, x: 2 } });
  const b = canonicalConditionJson({ a: 2, c: { x: 2, y: 1 }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":2,"b":1,"c":{"x":2,"y":1}}');
});
