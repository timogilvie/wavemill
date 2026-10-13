/**
 * HOK-3176 acceptance: an unseen, random error string must never park a
 * task. It resolves to `retryable` (bounded retry → one fresh relaunch →
 * escalate), on every stage, for challenge arms and solo tasks alike.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { classifyFailure, type FailureStage } from './failure-policy.ts';

const STAGES: FailureStage[] = ['planning', 'coding', 'review', 'ready', 'tend', 'eval'];

// Plausible-sounding error vocabulary with no allowlisted or code-failure
// signature, so the fuzzer exercises the default path rather than a branch.
const NOISE = [
  'unexpected', 'failure', 'while', 'processing', 'turn', 'stream', 'agent', 'exited', 'status',
  'worker', 'panic', 'segfault', 'null', 'pointer', 'undefined', 'is', 'not', 'a', 'function',
  'ENOENT', 'EPIPE', 'lock', 'held', 'retry', 'later', 'zstd', 'decoder', 'mismatch', 'shard',
];

function randomErrorString(seed: number): string {
  const bytes = randomBytes(24);
  const words = Array.from({ length: 4 + (seed % 6) }, (_, index) => NOISE[bytes[index % bytes.length] % NOISE.length]);
  return `${words.join(' ')} ${bytes.toString('base64url')} #${seed}`;
}

test('50 unseen random error strings all retry, never park', () => {
  for (let seed = 0; seed < 50; seed += 1) {
    const detail = randomErrorString(seed);
    const stage = STAGES[seed % STAGES.length];
    for (const challengeArm of [false, true]) {
      const decision = classifyFailure({ stage, detail, challengeArm });
      assert.equal(decision.class, 'retryable', `${stage}: "${detail}" → ${decision.class} (${decision.rationale})`);
      assert.ok(decision.retryBucket, 'retryable decisions name their bounded-retry bucket');
      assert.equal(decision.cause, undefined);
    }
  }
});

test('an unseen typed failure kind retries too', () => {
  for (let seed = 0; seed < 20; seed += 1) {
    const failureKind = `novel-kind-${randomBytes(6).toString('hex')}`;
    const decision = classifyFailure({ stage: 'coding', failureKind, challengeArm: seed % 2 === 0 });
    assert.equal(decision.class, 'retryable', failureKind);
    assert.equal(decision.failureKind, failureKind);
  }
});

test('empty evidence retries', () => {
  for (const stage of STAGES) {
    const decision = classifyFailure({ stage });
    assert.equal(decision.class, 'retryable');
    assert.equal(decision.failureKind, 'native-unclassified');
  }
});
