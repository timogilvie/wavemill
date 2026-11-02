/**
 * Guard specification for the arm-termination invariant (HOK-3358 D7).
 *
 * Invariants:
 * 1. challengeAborted writes only through recordArmTermination/stampTermination
 * 2. faultClass derived, never stored as primary
 * 3. No OPERATOR_ABORT_MARKER or 'operator_abort' values
 */

export const ARM_TERMINATION_GUARD = {
  name: 'arm-termination',
  description: 'One recorder for arm termination with typed cause (HOK-3358)',
  invariantSource: 'shared/lib/arm-termination.ts',
  patterns: [
    {
      name: 'challenge-aborted-write',
      type: 'ts',
      description: 'Direct challengeAborted assignment outside arm-termination',
      regex: /\.challengeAborted\s*=(?!=)/,
      context: 'task.challengeAborted = ... (must go through stampTermination)',
    },
    {
      name: 'challenge-aborted-jq-write',
      type: 'sh',
      description: 'Direct challengeAborted jq write outside arm-termination',
      regex: /\.challengeAborted\s*=/,
      context: 'jq mutation of challengeAborted field',
    },
    {
      name: 'fault-class-literal',
      type: 'ts',
      description: 'faultClass literal stored outside arm-termination/taxonomy',
      regex: /faultClass\s*:\s*'(harness|selection|provider|model|unknown)-fault'/,
      context: 'faultClass stored as primary (must be derived from classifyArmFault)',
    },
    {
      name: 'operator-abort-marker',
      type: 'both',
      description: 'OPERATOR_ABORT_MARKER or operator_abort value',
      regex: /OPERATOR_ABORT_MARKER|'operator_abort'|"operator_abort"/,
      context: 'Use formatTerminationReason(kind) instead',
    },
  ],
  allowlistPath: 'tools/arm-termination-allowlist.txt',
  suppressionMarker: 'allow-arm-termination',
};
