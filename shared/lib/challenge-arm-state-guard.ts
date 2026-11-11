// allow-challenge-arm-state: this file *is* the challenge-arm-state guard;
// its pattern table names every forbidden shape. It is auto-excluded from its
// own scan (see invariantPaths); the marker above is defensive.
/**
 * Preflight guard for the challenge-arm-state invariant (HOK-3451, enforced
 * by HOK-3236): readers derive pending state from the declared list, and
 * writers transition arms only through `challenge_arms_set_state`.
 *
 * A private arm-state string comparison is any direct equality/inequality
 * test against a literal lifecycle state name. Such tests bypass the single
 * source of truth and are the pattern that made awaiting_expanded_route arms
 * invisible to gate, recovery, and pre-fork cancellation.
 *
 * Authoritative sites (the TS contract, this guard, and the bash helper list)
 * are auto-excluded. Existing jq select filters inside
 * `shared/lib/challenge-arms.sh` are also auto-excluded because that file
 * owns the authoritative lists and list helpers.
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

export const CHALLENGE_ARM_STATE_GUARD: GuardSpec = {
  name: 'challenge-arm-state',
  invariantDocs: ['docs/invariants/challenge-arm-state.md'],
  findingNoun: 'private challenge-arm state comparison(s)',
  suppressionMarker: 'allow-challenge-arm-state',
  allowlistFile: 'tools/challenge-arm-state-allowlist.txt',
  invariantPaths: [
    'shared/lib/challenge-execution-contract.ts',
    'shared/lib/challenge-execution-contract.test.ts',
    'shared/lib/challenge-arms.sh',
    'shared/lib/challenge-arm-state-guard.ts',
  ],
  patterns: [
    {
      name: 'ts-private-arm-state-equality',
      description: 'private TypeScript equality check against a challengeArmState literal — use isChallengeArmPendingState or challenge_arm_state_is_pending',
      lang: 'ts',
      re: /challengeArmState\s*(?:===|!==|==|!=)\s*['"]awaiting_(fork|expanded_route|materializing|materialized|cancelled|exhausted)['"]/,
    },
    {
      name: 'sh-private-arm-state-equality',
      description: 'private shell/jq equality check against a challengeArmState literal — use challenge_arm_state_is_pending or challenge_arm_state_is_valid',
      lang: 'sh',
      re: /challengeArmState\s*(?:==|!=)\s*["']awaiting_(fork|expanded_route|materializing|materialized|cancelled|exhausted)["']/,
    },
  ],
  remediation: [
    'Challenge-arm lifecycle states are declared in shared/lib/challenge-execution-contract.ts.',
    'Readers must use isChallengeArmPendingState (TS) or challenge_arm_state_is_pending (shell).',
    'Writers must use challenge_arms_set_state, which validates states and does CAS inside state_mutate.',
    'Never add a private == "awaiting_..." comparison.',
  ],
};
