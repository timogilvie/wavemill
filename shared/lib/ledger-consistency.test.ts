import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from './ledger.ts';
import {
  computeStepInputsHash,
  markRetryExhausted,
  recordRetryAttempt,
  setWaitingOnFromMarker,
  settleStep,
  upsertStep,
} from './ledger-shadow.ts';
import { enumerateRetrySentinels, runConsistencyCheck } from './ledger-consistency.ts';

let dir: string;
let dbPath: string;
let stateDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wavemill-ledger-consistency-'));
  dbPath = join(dir, 'ledger.sqlite');
  stateDir = join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeFile(name: string, content: string): string {
  const p = join(stateDir, name);
  writeFileSync(p, content);
  return p;
}

test('enumerateRetrySentinels discovers retry buckets', () => {
  writeFile('.retry-review-infra-recovery-count', '2\n');
  writeFile('.retry-review-infra-recovery-head', 'abc123\ndef456\n');
  writeFile('.retry-review-infra-recovery-exhausted', 'ci-red\n');
  const buckets = enumerateRetrySentinels(stateDir);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].bucket, 'review-infra-recovery');
  assert.equal(buckets[0].count, 2);
  assert.equal(buckets[0].headSha, 'abc123');
  assert.equal(buckets[0].baseSha, 'def456');
  assert.equal(buckets[0].exhaustedReason, 'ci-red');
});

test('enumerateRetrySentinels handles legacy failed-ready-recheck files', () => {
  writeFile('.failed-ready-recheck-count', '1\n');
  writeFile('.failed-ready-recheck-head', 'abc123\n');
  const buckets = enumerateRetrySentinels(stateDir);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].bucket, 'failed-ready-recheck');
  assert.equal(buckets[0].count, 1);
});

test('clean state reports zero disagreements', () => {
  const ledger = Ledger.open({ dbPath });
  const result = runConsistencyCheck({ stateDir, issue: 'HOK-9999', ledger });
  assert.equal(result.disagreements.length, 0);
  assert.equal(result.scanned.steps, 0);
  ledger.close();
});

test('retry count without step row surfaces missing-step warn', () => {
  writeFile('.retry-review-infra-recovery-count', '2\n');
  const ledger = Ledger.open({ dbPath });
  const result = runConsistencyCheck({ stateDir, issue: 'HOK-9999', ledger });
  assert.equal(result.disagreements.length, 1);
  assert.equal(result.disagreements[0].category, 'missing-step');
  assert.equal(result.disagreements[0].severity, 'warn');
  ledger.close();
});

test('attempt mismatch surfaces info-level disagreement', () => {
  writeFile('.retry-review-infra-recovery-count', '2\n');
  const ledger = Ledger.open({ dbPath });
  const step = upsertStep(ledger, {
    issueKey: 'HOK-9999',
    kind: 'review',
    inputsHash: computeStepInputsHash({ headSha: 'abc' }),
    maxAttempts: 5,
  });
  recordRetryAttempt(ledger, step.id); // attempt=1, sentinel=2
  const result = runConsistencyCheck({ stateDir, issue: 'HOK-9999', ledger });
  const mismatch = result.disagreements.find((d) => d.category === 'attempt-mismatch');
  assert.ok(mismatch);
  assert.equal(mismatch!.severity, 'info');
  ledger.close();
});

test('exhausted sentinel with aligned step row produces no disagreement', () => {
  writeFile('.retry-review-infra-recovery-count', '3\n');
  writeFile('.retry-review-infra-recovery-exhausted', 'ci-red\n');
  const ledger = Ledger.open({ dbPath });
  const step = upsertStep(ledger, {
    issueKey: 'HOK-9999',
    kind: 'review',
    inputsHash: computeStepInputsHash({ headSha: 'abc' }),
  });
  recordRetryAttempt(ledger, step.id);
  recordRetryAttempt(ledger, step.id);
  recordRetryAttempt(ledger, step.id);
  markRetryExhausted(ledger, step.id, 'review-infra-recovery', 'ci-red');
  const result = runConsistencyCheck({ stateDir, issue: 'HOK-9999', ledger });
  assert.equal(result.disagreements.length, 0);
  ledger.close();
});

test('exhausted sentinel with running step row surfaces settled-reason-mismatch', () => {
  writeFile('.retry-review-infra-recovery-exhausted', 'ci-red\n');
  const ledger = Ledger.open({ dbPath });
  upsertStep(ledger, {
    issueKey: 'HOK-9999',
    kind: 'review',
    inputsHash: computeStepInputsHash({ headSha: 'abc' }),
  });
  const result = runConsistencyCheck({ stateDir, issue: 'HOK-9999', ledger });
  const mismatch = result.disagreements.find((d) => d.category === 'settled-reason-mismatch');
  assert.ok(mismatch);
  ledger.close();
});

test('condition sidecar without mirror waiting_on surfaces missing-waiting-on', () => {
  writeFileSync(
    join(stateDir, '.retry-review-infra-recovery-exhausted-condition.json'),
    JSON.stringify({
      schemaVersion: 1,
      kind: 'retry-exhausted',
      headSha: 'abc',
      writtenAt: new Date().toISOString(),
      condition: { expiresOn: ['head', 'operator-event'] },
    }),
  );
  const ledger = Ledger.open({ dbPath });
  const result = runConsistencyCheck({ stateDir, issue: 'HOK-9999', ledger });
  const miss = result.disagreements.find((d) => d.category === 'missing-waiting-on');
  assert.ok(miss);
  ledger.close();
});

test('condition sidecar with mirror waiting_on produces no disagreement', () => {
  writeFileSync(
    join(stateDir, '.retry-review-infra-recovery-exhausted-condition.json'),
    JSON.stringify({
      schemaVersion: 1,
      kind: 'retry-exhausted',
      headSha: 'abc',
      writtenAt: new Date().toISOString(),
      condition: { expiresOn: ['head', 'operator-event'] },
    }),
  );
  const ledger = Ledger.open({ dbPath });
  const step = upsertStep(ledger, {
    issueKey: 'HOK-9999',
    kind: 'review',
    inputsHash: computeStepInputsHash({ headSha: 'abc' }),
  });
  setWaitingOnFromMarker(ledger, step.id, 'head', { head: 'abc' });
  const result = runConsistencyCheck({ stateDir, issue: 'HOK-9999', ledger });
  assert.equal(
    result.disagreements.filter((d) => d.category === 'missing-waiting-on').length,
    0,
  );
  ledger.close();
});

test('agent hook event with no mirror evidence surfaces missing-evidence', () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const hookFile = join(dir, 'wavemill-test-session-HOK-9999.hook');
  writeFileSync(
    hookFile,
    JSON.stringify({
      state: 'idle',
      event: 'Stop',
      agent: 'claude',
      timestamp: nowSec,
      writer: 'agent',
      agentRecord: { state: 'idle', event: 'Stop', agent: 'claude', timestamp: nowSec },
    }),
  );
  const ledger = Ledger.open({ dbPath });
  upsertStep(ledger, {
    issueKey: 'HOK-9999',
    kind: 'review',
    inputsHash: computeStepInputsHash({ headSha: 'abc' }),
  });
  const result = runConsistencyCheck({
    stateDir,
    issue: 'HOK-9999',
    ledger,
    hookFilePath: hookFile,
  });
  const miss = result.disagreements.find((d) => d.category === 'missing-evidence');
  assert.ok(miss);
  // Live step means warn-level, not info.
  assert.equal(miss!.severity, 'warn');
  ledger.close();
});

test('old agent hook event (outside window) does not surface missing-evidence', () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const hookFile = join(dir, 'wavemill-test-session-HOK-9999.hook');
  writeFileSync(
    hookFile,
    JSON.stringify({
      state: 'idle',
      event: 'Stop',
      agent: 'claude',
      timestamp: nowSec - 999,
      writer: 'agent',
      agentRecord: { state: 'idle', event: 'Stop', agent: 'claude', timestamp: nowSec - 999 },
    }),
  );
  const ledger = Ledger.open({ dbPath });
  const result = runConsistencyCheck({
    stateDir,
    issue: 'HOK-9999',
    ledger,
    hookFilePath: hookFile,
    evidenceWindowMs: 60_000,
  });
  assert.equal(
    result.disagreements.filter((d) => d.category === 'missing-evidence').length,
    0,
  );
  ledger.close();
});

test('consistency check runs under budget on small state', () => {
  // Create a modest state dir with 10 retry buckets
  for (let i = 0; i < 10; i++) {
    writeFileSync(join(stateDir, `.retry-bucket-${i}-count`), `${i + 1}\n`);
    writeFileSync(join(stateDir, `.retry-bucket-${i}-head`), `abc${i}\n`);
  }
  const ledger = Ledger.open({ dbPath });
  const result = runConsistencyCheck({ stateDir, issue: 'HOK-9999', ledger });
  assert.ok(result.tookMs < 500, `took ${result.tookMs}ms`);
  ledger.close();
});

test('completed step with retired sentinel is tolerated', () => {
  const ledger = Ledger.open({ dbPath });
  const step = upsertStep(ledger, {
    issueKey: 'HOK-9999',
    kind: 'review',
    inputsHash: computeStepInputsHash({ headSha: 'abc' }),
  });
  settleStep(ledger, step.id, 'done');
  const result = runConsistencyCheck({ stateDir, issue: 'HOK-9999', ledger });
  assert.equal(result.disagreements.length, 0);
  ledger.close();
});
