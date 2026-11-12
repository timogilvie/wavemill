// allow-handoff-state: this file *is* the handoff-state guard; its pattern
// table names every forbidden shape. It is auto-excluded from its own scan
// (see invariantPaths); the marker above is defensive.
/**
 * Preflight guard for the handoff-gate invariant (HOK-3450, enforced by
 * HOK-3236): "may Tend take this PR?" is answered by one state test,
 * `handoffStateIsPublished` in `shared/lib/ready-tend-handoff.ts`.
 *
 * A private comparison against a Ready→Tend handoff state literal is how the
 * merge-label derivation came to grant `wm:ready` on a `checked` record that
 * Tend's claim then refused.
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

export const HANDOFF_STATE_GUARD: GuardSpec = {
  name: 'handoff-state',
  invariantDocs: ['docs/invariants/handoff-gate.md'],
  findingNoun: 'private Ready→Tend handoff-state comparison(s)',
  suppressionMarker: 'allow-handoff-state',
  allowlistFile: 'tools/handoff-state-allowlist.txt',
  invariantPaths: [
    'shared/lib/ready-tend-handoff.ts',
    'shared/lib/handoff-state-guard.ts',
  ],
  patterns: [
    {
      name: 'ts-private-handoff-state-equality',
      description: 'private TypeScript equality check against a handoff state literal — use handoffStateIsPublished / classifyClaim / isMatchingTendClaim',
      lang: 'ts',
      re: /(?:===|!==|==|!=)\s*['"](?:ready-published|tend-claimed)['"]|['"](?:ready-published|tend-claimed)['"]\s*(?:===|!==|==|!=)|\.state\s*(?:===|!==|==|!=)\s*['"]checked['"]/,
    },
    {
      name: 'sh-private-handoff-state-equality',
      description: 'private shell/jq equality check against a handoff state literal — run tools/ready-tend-handoff.ts and act on its exit status',
      lang: 'sh',
      re: /(?:==|!=)\s*\\?["'](?:ready-published|tend-claimed)\\?["']|\.state\s*(?:==|!=)\s*\\?["']checked\\?["']/,
    },
  ],
  remediation: [
    'Handoff states are declared in shared/lib/ready-tend-handoff.ts (READY_TEND_STATES).',
    'Ask "is this handoff published?" with handoffStateIsPublished; ask "may Tend claim?" with classifyClaim / claimReadyHandoff.',
    'Shell callers run tools/ready-tend-handoff.ts, which exits non-zero on a rejected transition.',
    'Never compare a handoff state literal outside the handoff module.',
  ],
};
