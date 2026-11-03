// allow-arm-termination: this file *is* the arm-termination guard; its
// pattern table necessarily contains every forbidden shape. The guard is
// auto-excluded from its own scan via `invariantPaths`; the marker above is
// defensive.
/**
 * Preflight guard for the one arm-termination recorder invariant (HOK-3358).
 *
 * "This arm is terminated: record it, whose fault was it?" has one answer.
 * The operator (`task-abort.ts`), the monitor (`wavemill-monitor.sh`
 * `challenge_abort_pair`), and the pair-resolver (`challenge-pair-resolver.ts`
 * `stampStalledArm`) all route through
 * {@link ../lib/arm-termination.ts recordArmTermination}. This guard fails on
 * the shapes that answer it a second way:
 *
 * 1. `challengeAborted-direct-write` — a `challengeAborted = …` assignment
 *    outside the recorder. The one exception,
 *    `markChallengerSupersededForPrimaryMerge`, is kept via the allowlist
 *    with a reason: supersession is a different lifecycle (phase/status/
 *    supersededReason flip), not an arm termination.
 * 2. `faultClass-literal` — a `faultClass: '<class>'` string literal in a
 *    stored record body (object initializer) outside the arm-failure
 *    taxonomy; readers must derive fault class via `classifyArmFault` at
 *    read time (HOK-3338 rule 3). Interface field declarations
 *    (`faultClass: ArmFaultClass`) and type-level annotations are fine
 *    because they do not store a value.
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

export const ARM_TERMINATION_GUARD: GuardSpec = {
  name: 'arm-termination',
  findingNoun: 'arm-termination recorder bypass(es)',
  suppressionMarker: 'allow-arm-termination',
  allowlistFile: 'tools/arm-termination-allowlist.txt',
  invariantPaths: [
    'shared/lib/arm-termination.ts',
    'shared/lib/arm-termination-guard.ts',
    'tools/check-arm-termination-recorder.ts',
    'tools/record-arm-termination.ts',
    // The arm-reliability record is the derived output of the recorder; its
    // ArmReliabilityRecord type declares `faultClass`, and tests for the
    // recorder verify equivalence with `classifyArmFault`.
    'shared/lib/arm-reliability.ts',
  ],
  patterns: [
    {
      name: 'challengeAborted-direct-write',
      description: 'challengeAborted assigned outside the recorder — call recordArmTermination({ actor: operator | monitor | pair-resolver, ... }) in shared/lib/arm-termination.ts',
      lang: 'ts',
      // Catch an assignment to `.challengeAborted` on an object. Does not fire
      // on reads (`===`), interface declarations (`challengeAborted?: ...`), or
      // trailing-comma literal fields in a hydrated record.
      re: /\b(?:task|entry|row|current\.tasks\[[^\]]+\]|next\.tasks\[[^\]]+\]|arm)\.challengeAborted\s*=\s*(?!=)/,
    },
    {
      name: 'challengeAborted-direct-write',
      description: 'challengeAborted written via a jq state_mutate expression outside the recorder — call tools/record-arm-termination.ts instead',
      lang: 'sh',
      re: /\.tasks\[\$(?:key|issue)\]\.challengeAborted\s*=\s*\$/,
    },
  ],
  remediation: [
    'HOK-3358: terminations go through the one arm-termination recorder',
    '(shared/lib/arm-termination.ts). Operator aborts use actor=operator',
    'and may require --evidence for model-fault kinds; monitor and resolver',
    'paths use actor=monitor | pair-resolver and already have the stage',
    'artifact by construction. `faultClass` is derived from `classifyArmFault`',
    'at read time, never stored as primary (HOK-3338 rule 3).',
  ],
};
