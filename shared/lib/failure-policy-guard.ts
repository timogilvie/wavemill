// allow-failure-policy: this file *is* the failure-policy guard; its pattern
// table names every forbidden shape. It is auto-excluded from its own scan
// (see invariantPaths); the marker above is defensive.
/**
 * Preflight guard for the single failure policy (HOK-3176, enforced by
 * HOK-3236): whether a failure parks (`terminal`) is decided only by
 * `classifyFailure()` against `TERMINAL_ALLOWLIST` in
 * shared/lib/failure-policy.ts (shell: `failure_policy_decide`). Everything
 * unrecognised is retryable. A classifier branch elsewhere that decides
 * "this one parks" is exactly what the invariant forbids.
 *
 * Shapes caught — producers of a parking decision, never readers of one
 * (`decision.class === 'terminal'` is fine):
 * - a `class: 'terminal'` decision literal;
 * - a `retryable: false` classification;
 * - a private terminal/fatal/non-retryable pattern table
 *   (`TERMINAL_ERROR_PATTERNS = [...]`, `FATAL_SIGNATURES=(…)`).
 *
 * Lower-level provider/CLI taxonomies that feed into the policy are
 * allowlisted with a reason in tools/failure-policy-allowlist.txt.
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

export const FAILURE_POLICY_GUARD: GuardSpec = {
  name: 'failure-policy',
  findingNoun: 'private parking classifier(s)',
  suppressionMarker: 'allow-failure-policy',
  allowlistFile: 'tools/failure-policy-allowlist.txt',
  invariantPaths: [
    'shared/lib/failure-policy.ts',
    'shared/lib/failure-policy-guard.ts',
  ],
  patterns: [
    {
      name: 'terminal-decision-literal',
      description: '`class: \'terminal\'` decision built outside failure-policy.ts — call classifyFailure() / failure_policy_decide',
      lang: 'both',
      re: /["']?\bclass["']?\s*:\s*["']terminal["']/,
    },
    {
      name: 'non-retryable-classification',
      description: '`retryable: false` — a private parking classification; add a fixture to failure-policy.fixtures.test.ts instead',
      lang: 'ts',
      re: /\bretryable\s*:\s*false\b/,
    },
    {
      name: 'terminal-pattern-table',
      description: 'private terminal/fatal/non-retryable signature table — extend TERMINAL_ALLOWLIST (with a reason and test) or let it retry',
      lang: 'both',
      re: /\b[A-Z_]*(?:TERMINAL|FATAL|PERMANENT|NON_?RETRYABLE|UNRECOVERABLE)[A-Z_]*_(?:PATTERNS|SIGNATURES|REGEX(?:ES)?|RES|MATCHERS)\s*[:=(]/,
    },
  ],
  remediation: [
    'Every stage gate classifies failures through classifyFailure() / failure_policy_decide',
    '(HOK-3176): terminal only for TERMINAL_ALLOWLIST entries, code-failure for recognised',
    'signatures, retryable by default. Never add a classifier branch that parks: add a',
    'fixture to failure-policy.fixtures.test.ts, and only extend the allowlist (with a',
    'reason and test) when retrying provably cannot change the outcome.',
  ],
};
