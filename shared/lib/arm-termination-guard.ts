/**
 * Guard specification for the arm-termination invariant (HOK-3358 D7).
 *
 * Invariants:
 * 1. challengeAborted writes only through recordArmTermination/stampTermination
 * 2. faultClass derived, never stored as primary
 * 3. No retired OPERATOR_ABORT_MARKER constant
 */

import type { GuardSpec } from '../../tools/lib/source-guard.ts';

export const ARM_TERMINATION_GUARD: GuardSpec = {
  name: 'arm-termination',
  findingNoun: 'arm-termination invariant violation(s)',
  invariantPaths: ['shared/lib/arm-termination.ts', 'shared/lib/arm-termination-guard.ts', 'tools/check-arm-termination.ts'],
  patterns: [
    {
      name: 'challenge-aborted-write',
      lang: 'both',
      description: 'Direct challengeAborted assignment outside arm-termination',
      re: /\.challengeAborted\s*=(?!=)/,
      context: 'task.challengeAborted = ... (must go through stampTermination)',
    },
    {
      name: 'fault-class-literal',
      lang: 'ts',
      description: 'faultClass literal stored outside arm-termination/taxonomy',
      re: /faultClass\s*:\s*'(harness|selection|provider|model|unknown)-fault'/,
      context: 'faultClass stored as primary (must be derived from classifyArmFault)',
    },
    {
      name: 'operator-abort-marker',
      lang: 'both',
      description: 'retired OPERATOR_ABORT_MARKER constant',
      re: /OPERATOR_ABORT_MARKER/,
      context: 'Use formatTerminationReason(kind) instead',
    },
  ],
  allowlistFile: 'tools/arm-termination-allowlist.txt',
  suppressionMarker: 'allow-arm-termination',
  remediation: ['Route termination stamps through recordArmTermination and derive faultClass with classifyArmFault.'],
};
