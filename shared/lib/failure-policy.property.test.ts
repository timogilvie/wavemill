/**
 * HOK-3230 property-based tests for `classifyFailure`.
 *
 * These pin the HOK-3176 inversion: only entries in TERMINAL_ALLOWLIST may
 * park a task; every other string retries by default. The suite complements
 * the hand-picked fixture suite (`failure-policy.test.ts`) by sampling random
 * inputs; a counter-example is minimised and the seed is printed so it can
 * be replayed with `FAST_CHECK_SEED=<n> node --test <file>`.
 *
 * Replaces the fixed-50-iteration `failure-policy.random.test.ts`, which
 * used unseeded `crypto.randomBytes` and could not be reproduced.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  classifyFailure,
  canonicalFailureKind,
  terminalCauseFor,
  retryBucketFor,
  type FailureStage,
} from './failure-policy.ts';
import { assertProperty } from './fast-check-utils.ts';
import {
  arbitraryStage,
  arbitraryNonTerminalKind,
  arbitraryWhitespacePad,
  arbitraryBenignFailureEvidence,
  arbitraryTerminalCode,
  arbitraryChallengeOnlyTerminalCode,
  TERMINAL_ALLOWLIST_CODES,
  SOLO_ALLOWED_TERMINAL_CODES,
} from './property-generators.ts';

const STAGES: readonly FailureStage[] = ['planning', 'coding', 'review', 'ready', 'tend', 'eval'];

test('P1: any failure kind outside TERMINAL_ALLOWLIST classifies as non-terminal', () => {
  assertProperty(
    fc.property(
      arbitraryStage(),
      arbitraryNonTerminalKind(),
      fc.boolean(),
      (stage, failureKind, challengeArm) => {
        const decision = classifyFailure({ stage, failureKind, challengeArm });
        assert.notEqual(
          decision.class,
          'terminal',
          `${stage}/${challengeArm ? 'challenge' : 'solo'} "${failureKind}" → ${decision.class} (${decision.rationale})`,
        );
      },
    ),
    { name: 'P1 non-terminal default', numRuns: 400 },
  );
});

test('P2: whitespace padding does not change terminal classification', () => {
  assertProperty(
    fc.property(
      arbitraryTerminalCode(),
      arbitraryWhitespacePad(),
      arbitraryWhitespacePad(),
      (code, leading, trailing) => {
        const padded = `${leading}${code}${trailing}`;
        assert.equal(
          canonicalFailureKind(padded),
          code,
          `canonicalFailureKind("${JSON.stringify(padded)}") must be "${code}"`,
        );
        // Only solo-reachable codes park without `challengeArm: true`; the
        // challenge-only codes still retry solo (they are tested in P5).
        const challengeArm = !SOLO_ALLOWED_TERMINAL_CODES.includes(code);
        const decision = classifyFailure({
          stage: 'coding',
          failureKind: padded,
          challengeArm,
        });
        assert.equal(
          decision.class,
          'terminal',
          `padded terminal "${code}" (arm=${challengeArm}) → ${decision.class} (${decision.rationale})`,
        );
      },
    ),
    { name: 'P2 whitespace stability', numRuns: 200 },
  );
});

test('P3: case mutants of terminal codes do NOT park (strict canonicalisation)', () => {
  // The implementation's `canonicalFailureKind` is case-sensitive. We pin
  // that current behaviour: a future tolerant `toLowerCase()` would surface
  // as a change here, forcing an explicit decision rather than silent
  // widening of the allowlist.
  assertProperty(
    fc.property(
      arbitraryTerminalCode(),
      fc.integer({ min: 0, max: 1 }),
      (code, variant) => {
        const mutated =
          variant === 0
            ? code.toUpperCase()
            : code
                .split('')
                .map((ch, i) => (i % 2 ? ch.toUpperCase() : ch))
                .join('');
        // Skip when the mutation collapses back to the canonical form
        // (e.g. a code that is already fully lowercase has no uppercase
        // mapping other than its real spelling at i===0).
        fc.pre(mutated !== code);
        const decision = classifyFailure({ stage: 'coding', failureKind: mutated, challengeArm: true });
        assert.notEqual(
          decision.class,
          'terminal',
          `case-mutant "${mutated}" must not park (would widen the allowlist silently)`,
        );
      },
    ),
    { name: 'P3 case mutants do not park', numRuns: 200 },
  );
});

test('P4: classifyFailure is deterministic — same evidence, same decision', () => {
  assertProperty(
    fc.property(arbitraryBenignFailureEvidence(), (evidence) => {
      const a = classifyFailure(evidence);
      const b = classifyFailure(evidence);
      assert.deepEqual(a, b, 'two calls with the same evidence must return deeply equal decisions');
    }),
    { name: 'P4 determinism', numRuns: 300 },
  );
});

test('P5: challenge-only terminal codes park only for challenge arms', () => {
  assertProperty(
    fc.property(
      arbitraryChallengeOnlyTerminalCode(),
      arbitraryStage(),
      (code, stage) => {
        const challengeDecision = classifyFailure({ stage, failureKind: code, challengeArm: true });
        const soloDecision = classifyFailure({ stage, failureKind: code, challengeArm: false });
        assert.equal(challengeDecision.class, 'terminal', `${code} must park a challenge arm`);
        assert.equal(soloDecision.class, 'retryable', `${code} must retry on a solo task (not a challenge arm)`);
        assert.equal(
          soloDecision.retryBucket,
          retryBucketFor(stage),
          `solo ${code} must name the stage's retry bucket`,
        );
      },
    ),
    { name: 'P5 challenge-only scoping', numRuns: 200 },
  );
});

test('P6: empty / nullish / all-whitespace failure kinds retry with native-unclassified', () => {
  assertProperty(
    fc.property(
      arbitraryStage(),
      fc.oneof(
        fc.constant(''),
        fc.constant(null),
        fc.constant(undefined),
        arbitraryWhitespacePad(),
      ),
      fc.boolean(),
      (stage, failureKind, challengeArm) => {
        const decision = classifyFailure({
          stage,
          failureKind: failureKind as string | null | undefined,
          detail: '',
          challengeArm,
        });
        assert.equal(decision.class, 'retryable', `empty kind must retry (got ${decision.class})`);
        assert.equal(
          decision.failureKind,
          'native-unclassified',
          'empty / whitespace kinds fall through to native-unclassified detection',
        );
        assert.equal(
          decision.retryBucket,
          retryBucketFor(stage),
          'retryable decision names the stage-failure bucket',
        );
      },
    ),
    { name: 'P6 empty / nullish is retryable', numRuns: 150 },
  );
});

test('invariant: every TERMINAL_ALLOWLIST entry is addressable by terminalCauseFor', () => {
  // Not a fast-check property per se — this cross-checks our generator's
  // code list against the module's internal map, so a code added to the
  // allowlist cannot silently escape the random coverage.
  for (const code of TERMINAL_ALLOWLIST_CODES) {
    const cause = terminalCauseFor(code, true);
    assert.ok(cause, `terminalCauseFor must find allowlist code ${code}`);
    assert.equal(cause.code, code);
  }
});

test('cross-check: each stage names a defined retryBucket', () => {
  for (const stage of STAGES) {
    const bucket = retryBucketFor(stage);
    assert.ok(bucket && bucket.length > 0, `stage ${stage} must name a bucket`);
  }
});
