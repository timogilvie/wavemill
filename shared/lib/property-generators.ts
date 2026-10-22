/**
 * Shared fast-check arbitraries for the HOK-3230 property suites.
 *
 * Grouped by subsystem so each suite imports only what it needs. All
 * generators are pure (no I/O). The intent is that a property reads like
 *   "for any <generator>, <invariant> holds";
 * so names describe what is produced, not where it is used.
 */
import fc from 'fast-check';
import {
  TERMINAL_ALLOWLIST,
  type FailureStage,
  type FailureEvidence,
} from './failure-policy.ts';

// ── 5a. Primitives ──────────────────────────────────────────────────────────

/** Lower-case hex SHA of exact length (7 or 40, matching real wavemill keys). */
export function arbitraryHexSha(length: 7 | 40 = 7): fc.Arbitrary<string> {
  return fc
    .array(
      fc.constantFrom(...'0123456789abcdef'.split('')),
      { minLength: length, maxLength: length },
    )
    .map((chars) => chars.join(''));
}

/** A short mix of ASCII whitespace (0–5 chars), the kind that pads a log line. */
export function arbitraryWhitespacePad(): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom(' ', '\t', '\n', '\r'), { minLength: 0, maxLength: 5 })
    .map((chars) => chars.join(''));
}

/** Kebab-case bucket name under the dedicated `prop-retry-*` prefix. */
export function arbitraryBucketName(): fc.Arbitrary<string> {
  return fc
    .stringMatching(/^prop-retry-[a-z][a-z0-9-]{0,8}$/)
    .filter((name) => /^prop-retry-[a-z][a-z0-9-]*$/.test(name) && !name.endsWith('-'));
}

/** UTC ISO-8601 timestamp (`YYYY-MM-DDTHH:MM:SSZ`) at `baseEpochSeconds + deltaSeconds`. */
export function arbitraryIsoTimestamp(
  baseEpochSeconds: number,
  deltaSeconds: fc.Arbitrary<number>,
): fc.Arbitrary<string> {
  return deltaSeconds.map((delta) => {
    const epoch = baseEpochSeconds + delta;
    return new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  });
}

// ── 5b. Failure policy ──────────────────────────────────────────────────────

const STAGES: readonly FailureStage[] = ['planning', 'coding', 'review', 'ready', 'tend', 'eval'];
const TERMINAL_CODES: readonly string[] = TERMINAL_ALLOWLIST.map((c) => c.code);
const CHALLENGE_ONLY_CODES: readonly string[] = TERMINAL_ALLOWLIST.filter((c) => c.challengeOnly).map((c) => c.code);
const SOLO_TERMINAL_CODES: readonly string[] = TERMINAL_ALLOWLIST.filter((c) => !c.challengeOnly).map((c) => c.code);

/** `TERMINAL_ALLOWLIST` canonical codes paired with the TerminalCause entry. */
export const TERMINAL_ALLOWLIST_CODES = TERMINAL_CODES;
export const CHALLENGE_ONLY_TERMINAL_CODES = CHALLENGE_ONLY_CODES;
export const SOLO_ALLOWED_TERMINAL_CODES = SOLO_TERMINAL_CODES;

/** Any one failure stage. */
export function arbitraryStage(): fc.Arbitrary<FailureStage> {
  return fc.constantFrom(...STAGES);
}

/** Any allowlisted terminal code. */
export function arbitraryTerminalCode(): fc.Arbitrary<string> {
  return fc.constantFrom(...TERMINAL_CODES);
}

/**
 * Challenge-only terminal codes (`sibling-stalled`, `ready-exhausted`, …):
 * these are terminal only for a challenge arm; a solo task retries them.
 */
export function arbitraryChallengeOnlyTerminalCode(): fc.Arbitrary<string> {
  return fc.constantFrom(...CHALLENGE_ONLY_CODES);
}

/**
 * Strings that are *definitely not* in the terminal allowlist: short random
 * ASCII, with the known codes filtered out. Shrinks toward short printable
 * strings so a counter-example reads cleanly.
 *
 * Also throws in some near-miss variants (case mutants, suffixes) to prove
 * canonicalisation is strict about them.
 */
export function arbitraryNonTerminalKind(): fc.Arbitrary<string> {
  const codeSet = new Set(TERMINAL_CODES);
  // Near-miss generators built from the allowlist: case-mutants and suffix
  // variants. We filter out the exact canonical form afterwards.
  const nearMiss = fc
    .tuple(fc.constantFrom(...TERMINAL_CODES), fc.oneof(fc.constant('UPPER'), fc.constant('MIXED'), fc.constant('SUFFIX')))
    .map(([code, variant]) => {
      if (variant === 'UPPER') return code.toUpperCase();
      if (variant === 'MIXED') return code.split('').map((ch, i) => (i % 2 ? ch.toUpperCase() : ch)).join('');
      return `${code}-xtra`;
    });
  const freeform = fc.string({ minLength: 1, maxLength: 40 });
  return fc.oneof(freeform, nearMiss).filter((kind) => !codeSet.has(kind.trim()) && kind.trim() !== '');
}

/**
 * Composite `FailureEvidence` with no code-failure signatures in `detail`.
 * Used to drive the retryable-by-default properties without false hits on
 * the code-failure branch (which is covered by its own fixture suite).
 */
export function arbitraryBenignFailureEvidence(): fc.Arbitrary<FailureEvidence> {
  return fc.record({
    stage: arbitraryStage(),
    failureKind: fc.oneof(fc.constant(undefined), arbitraryNonTerminalKind()),
    detail: fc.oneof(
      fc.constant(null),
      fc.constant(''),
      // Freeform text that cannot match any known code-failure regex.
      fc.stringMatching(/^[a-z0-9 .,:]{0,80}$/),
    ),
    handoffReason: fc.oneof(fc.constant(undefined), fc.constant(null), fc.constant('provider_error')),
    challengeArm: fc.boolean(),
  });
}

// ── 5c. Bounded retry events ────────────────────────────────────────────────

export type RetryStepKind = 'gate' | 'increment' | 'markExhausted' | 'newHead' | 'clear';

export interface RetryStep {
  kind: RetryStepKind;
  reason?: string;
}

/** One event in a bounded-retry transition sequence. */
export function arbitraryRetryStep(): fc.Arbitrary<RetryStep> {
  return fc.oneof(
    fc.record<RetryStep>({ kind: fc.constant('gate') }),
    fc.record<RetryStep>({ kind: fc.constant('increment') }),
    fc.record<RetryStep>({
      kind: fc.constant('markExhausted'),
      reason: fc.stringMatching(/^[a-z0-9: -]{3,40}$/),
    }),
    fc.record<RetryStep>({ kind: fc.constant('newHead') }),
    fc.record<RetryStep>({ kind: fc.constant('clear') }),
  );
}

/** Sequence of retry events (0–20 steps). */
export function arbitraryRetryStepSequence(maxLength = 20): fc.Arbitrary<RetryStep[]> {
  return fc.array(arbitraryRetryStep(), { minLength: 0, maxLength });
}

// ── 5e. Merge labels ────────────────────────────────────────────────────────

/** Any `mergeable` value accepted by the live state. */
export function arbitraryMergeable(): fc.Arbitrary<'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'> {
  return fc.constantFrom('MERGEABLE', 'CONFLICTING', 'UNKNOWN');
}

/** Any `mergeStateStatus` wavemill models (plus noise). */
export function arbitraryMergeStateStatus(): fc.Arbitrary<string> {
  return fc.constantFrom('CLEAN', 'BLOCKED', 'DIRTY', 'UNKNOWN', 'BEHIND', 'UNSTABLE');
}

/** Any Ready verdict, or no readyAtHead at all. */
export function arbitraryReadyAtHead(headSha: string): fc.Arbitrary<
  { verdict: 'ready' | 'not-ready' | 'running' | 'errored'; sha: string } | undefined
> {
  return fc.oneof(
    fc.constant(undefined),
    fc
      .tuple(
        fc.constantFrom<'ready' | 'not-ready' | 'running' | 'errored'>(
          'ready',
          'not-ready',
          'running',
          'errored',
        ),
        // Mostly match the head, but sometimes drift so we exercise rule 2.
        fc.oneof(fc.constant(headSha), arbitraryHexSha(7)),
      )
      .map(([verdict, sha]) => ({ verdict, sha })),
  );
}

export function arbitraryHandoffAtHead(headSha: string, prNumber: number): fc.Arbitrary<
  { state: 'checked' | 'ready-published' | 'tend-claimed' | 'terminal'; headSha: string; prNumber: number } | undefined
> {
  return fc.oneof(
    fc.constant(undefined),
    fc
      .tuple(
        fc.constantFrom<'checked' | 'ready-published' | 'tend-claimed' | 'terminal'>(
          'checked',
          'ready-published',
          'tend-claimed',
          'terminal',
        ),
        fc.oneof(fc.constant(headSha), arbitraryHexSha(7)),
      )
      .map(([state, sha]) => ({ state, headSha: sha, prNumber })),
  );
}

/** A short rollup of status checks mixing conclusions and states. */
export function arbitraryStatusCheckRollup(): fc.Arbitrary<
  readonly { name: string; conclusion: string; status: string }[]
> {
  return fc.array(
    fc.record({
      name: fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/),
      conclusion: fc.constantFrom('SUCCESS', 'FAILURE', 'CANCELLED', 'TIMED_OUT', 'NEUTRAL', 'SKIPPED', ''),
      status: fc.constantFrom('COMPLETED', 'IN_PROGRESS', 'QUEUED'),
    }),
    { minLength: 0, maxLength: 4 },
  );
}

/** A set of PR labels that may contain `wm:ready` / `wm:blocked` and noise. */
export function arbitraryPrLabels(): fc.Arbitrary<string[]> {
  return fc
    .array(
      fc.constantFrom(
        'wm:ready',
        'wm:blocked',
        'wm:merging',
        'wm:merged',
        'wm:superseded',
        'rework-cost:low',
        'rework-cost:high',
        'needs-review',
      ),
      { minLength: 0, maxLength: 5 },
    )
    // De-duplicate (GitHub labels are a set).
    .map((labels) => [...new Set(labels)]);
}
