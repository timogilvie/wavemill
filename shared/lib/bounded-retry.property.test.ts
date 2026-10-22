/**
 * HOK-3230 property-based tests for `createStateDirRetry` →
 * `bounded-retry.sh`.
 *
 * Pins the HOK-2924 invariants:
 *   - `count` never exceeds `maxAttempts` once `gate` returns `exhausted`.
 *   - A new head always resets the bucket.
 *   - `markExhausted` writes the terminal sentinel and the HOK-3172
 *     condition companion.
 *   - `markExhausted` is idempotent across repeat calls.
 *
 * Each property shells `bounded-retry.sh` through `createStateDirRetry`, so
 * `numRuns` is small (15–25) and `maxLength` on the event sequence is capped
 * at 8 to stay inside the per-suite ≤ 5 s budget while still exercising a
 * meaningful transition space.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStateDirRetry } from './bounded-retry.ts';
import { assertProperty } from './fast-check-utils.ts';
import { arbitraryHexSha } from './property-generators.ts';

const __filename = fileURLToPath(import.meta.url);
const BOUNDED_RETRY_SH = join(dirname(__filename), 'bounded-retry.sh');
const TRANSIENT_MARKER_SH = join(dirname(__filename), 'transient-marker.sh');

/**
 * Shell out `bounded_retry_mark_exhausted` with BOTH the retry helper and
 * `transient-marker.sh` sourced, so the HOK-3172 condition companion is
 * written. The TypeScript bridge (`createStateDirRetry`) does not source
 * `transient-marker.sh`, mirroring tend-controller's historical bare
 * environment; the real callers that need the companion source both. This
 * helper reproduces that caller shape without touching production code.
 */
function shellMarkExhaustedWithCompanion(
  stateDir: string,
  bucket: string,
  reason: string,
  head: string,
): void {
  execFileSync(
    'bash',
    [
      '-c',
      `source "${TRANSIENT_MARKER_SH}" && source "${BOUNDED_RETRY_SH}" && `
      + `bounded_retry_increment "${stateDir}" "${bucket}" "${head}" >/dev/null && `
      + `bounded_retry_mark_exhausted "${stateDir}" "${bucket}" "${reason}" || true`,
    ],
    { encoding: 'utf-8' },
  );
}

function mkStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'retry-property-'));
}

/** A compact bucket name under the dedicated prop-retry prefix. */
const BUCKET_A = 'prop-retry-main';
const BUCKET_B = 'prop-retry-alt';

interface RetryStep {
  kind: 'increment' | 'gate' | 'newHead';
}

/** Short bounded sequence of events that step the retry state. */
function arbitraryRetrySequence(): fc.Arbitrary<RetryStep[]> {
  return fc.array(
    fc.oneof(
      fc.record<RetryStep>({ kind: fc.constant('increment') }),
      fc.record<RetryStep>({ kind: fc.constant('gate') }),
      // Rare: new head mid-sequence.
      fc.record<RetryStep>({ kind: fc.constant('newHead') }),
    ),
    { minLength: 0, maxLength: 8 },
  );
}

test('P1: following the gate→increment contract, count never exceeds maxAttempts', () => {
  // The shell helper's `bounded_retry_increment` is unconditional: callers
  // may call it even past the ceiling, and count will grow. The invariant
  // worth pinning is the one every real site respects: when a call site
  // only increments after a `proceed` gate, count stays at or below
  // maxAttempts and gate flips to `exhausted` at the ceiling.
  assertProperty(
    fc.property(
      fc.integer({ min: 1, max: 4 }),
      arbitraryHexSha(7),
      arbitraryRetrySequence(),
      (maxAttempts, headA, steps) => {
        const dir = mkStateDir();
        try {
          const retry = createStateDirRetry(BUCKET_A, {
            maxAttempts,
            backoff: { baseSeconds: 0, capSeconds: 0 },
          });
          let currentHead = headA;
          let proceedCount = 0;
          let exhaustedSeen = false;
          for (const step of steps) {
            if (step.kind === 'newHead') {
              currentHead = currentHead === headA ? 'ffffff0' : headA;
              proceedCount = 0;
              exhaustedSeen = false;
              continue;
            }
            const decision = retry.gate(dir, currentHead);
            if (decision === 'proceed') {
              retry.increment(dir, currentHead);
              proceedCount += 1;
            } else if (decision === 'exhausted') {
              exhaustedSeen = true;
            }
            const count = retry.count(dir);
            assert.ok(
              count <= maxAttempts,
              `count=${count} must stay ≤ maxAttempts=${maxAttempts} when following gate→increment`,
            );
          }
          // Final observation: once we've observed exhaustion for the
          // current head, we must have performed exactly maxAttempts
          // increments and the counter sits at the ceiling.
          if (exhaustedSeen) {
            assert.equal(
              proceedCount,
              maxAttempts,
              `exhausted gate implies ${maxAttempts} proceed increments were taken, got ${proceedCount}`,
            );
            assert.equal(retry.count(dir), maxAttempts);
          }
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    ),
    { name: 'P1 ceiling under gate→increment', numRuns: 15 },
  );
});

test('P2: a new head always resets the budget and the terminal sentinel', () => {
  assertProperty(
    fc.property(
      arbitraryHexSha(7),
      arbitraryHexSha(7),
      fc.integer({ min: 1, max: 3 }),
      (headA, headB, maxAttempts) => {
        fc.pre(headA !== headB);
        const dir = mkStateDir();
        try {
          const retry = createStateDirRetry(BUCKET_A, {
            maxAttempts,
            backoff: { baseSeconds: 0, capSeconds: 0 },
          });
          // Drive bucket to exhausted on headA.
          for (let i = 0; i < maxAttempts; i += 1) {
            retry.increment(dir, headA);
          }
          assert.equal(retry.gate(dir, headA), 'exhausted', 'bucket must be exhausted on headA');
          retry.markExhausted(dir, 'property-test-reason');
          assert.equal(retry.isExhausted(dir), true, 'markExhausted must terminalize');
          assert.equal(retry.gate(dir, headA), 'exhausted-quiet', 'same head → still terminal');
          // Switch to headB — the bucket must reset.
          const decisionB = retry.gate(dir, headB);
          assert.equal(decisionB, 'proceed', `new head ${headB} must reset the bucket, got ${decisionB}`);
          assert.equal(retry.count(dir), 0, 'count must be reset to 0');
          assert.equal(retry.isExhausted(dir), false, 'terminal sentinel must be cleared on head change');
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    ),
    { name: 'P2 new-head reset', numRuns: 15 },
  );
});

test('P3: markExhausted writes both the sentinel and the HOK-3172 condition companion', () => {
  // Shell-call path with transient-marker.sh sourced, matching the real
  // call sites that write the companion. The TS bridge does not source
  // transient-marker.sh and is tested in the fixture suite.
  assertProperty(
    fc.property(
      arbitraryHexSha(40),
      fc.stringMatching(/^[a-z0-9: -]{3,30}$/),
      (headSha, reason) => {
        const dir = mkStateDir();
        try {
          shellMarkExhaustedWithCompanion(dir, BUCKET_A, reason, headSha);
          const sentinelPath = join(dir, `.retry-${BUCKET_A}-exhausted`);
          const companionPath = join(dir, `.retry-${BUCKET_A}-exhausted-condition.json`);
          assert.ok(existsSync(sentinelPath), `sentinel file must exist: ${sentinelPath}`);
          assert.ok(existsSync(companionPath), `condition companion must exist: ${companionPath}`);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    ),
    { name: 'P3 companion present', numRuns: 10 },
  );
});

test('P4: markExhausted is idempotent (second call does not re-stamp or crash)', () => {
  assertProperty(
    fc.property(
      arbitraryHexSha(40),
      fc.stringMatching(/^[a-z0-9: -]{3,30}$/),
      (headSha, reason) => {
        const dir = mkStateDir();
        try {
          const retry = createStateDirRetry(BUCKET_A, {
            maxAttempts: 1,
            backoff: { baseSeconds: 0, capSeconds: 0 },
          });
          retry.increment(dir, headSha);
          retry.markExhausted(dir, reason);
          const firstReason = retry.exhaustionReason(dir).trim();
          // Second call must not throw and must leave the recorded reason unchanged.
          retry.markExhausted(dir, 'different-reason-should-not-replace');
          const secondReason = retry.exhaustionReason(dir).trim();
          assert.equal(
            secondReason,
            firstReason,
            `second markExhausted must not overwrite the recorded reason (first=${firstReason}, second=${secondReason})`,
          );
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    ),
    { name: 'P4 idempotent markExhausted', numRuns: 10 },
  );
});

test('P5: two independent buckets in the same state dir do not collide', () => {
  // Regression lock: BUCKET_A actions must not affect BUCKET_B. (Guards
  // against a reintroduction of the pre-HOK-2924 shared-prefix issue.)
  assertProperty(
    fc.property(arbitraryHexSha(7), (headSha) => {
      const dir = mkStateDir();
      try {
        const a = createStateDirRetry(BUCKET_A, { maxAttempts: 1, backoff: { baseSeconds: 0, capSeconds: 0 } });
        const b = createStateDirRetry(BUCKET_B, { maxAttempts: 1, backoff: { baseSeconds: 0, capSeconds: 0 } });
        a.increment(dir, headSha);
        a.markExhausted(dir, 'A-only');
        assert.equal(a.isExhausted(dir), true, 'bucket A must be terminal');
        assert.equal(b.isExhausted(dir), false, 'bucket B must be unaffected by bucket A');
        assert.equal(b.gate(dir, headSha), 'proceed', 'bucket B still has budget');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
    { name: 'P5 bucket isolation', numRuns: 10 },
  );
});
