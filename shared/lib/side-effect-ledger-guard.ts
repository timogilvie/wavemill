// allow-side-effect-ledger: this file *is* the side-effect ledger guard; its
// pattern table names every forbidden shape. It is auto-excluded from its own
// scan (see invariantPaths); the marker above is defensive.
/**
 * Preflight guard for the side-effect ledger invariant (HOK-3183, enforced by
 * HOK-3236): every git push, PR label write, Linear state transition and PR
 * merge shadow-records one `side_effect` row through
 * `shadowRecordSideEffect()` (shared/lib/side-effect-ledger.ts) with the shared
 * key builders.
 *
 * The guard cannot tell from one line whether a site records its row, so it
 * counts external-effect call sites per file against a ratchet in
 * tools/side-effect-ledger-allowlist.txt (`<path> <count>  # reason`). The
 * recorded seams (branch-publication, tend-controller, github, linear) and
 * the pre-HOK-3183 unrecorded sites are listed with their current counts; a
 * new effect site anywhere — including in an already-listed file — raises the
 * count and fails until it is routed through a recorded seam (or the count is
 * raised in review with a reason). Removing a site requires lowering the
 * count, so the list only shrinks.
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

export const SIDE_EFFECT_LEDGER_GUARD: GuardSpec = {
  name: 'side-effect-ledger',
  findingNoun: 'external side-effect site(s) outside the recorded budget',
  suppressionMarker: 'allow-side-effect-ledger',
  allowlistFile: 'tools/side-effect-ledger-allowlist.txt',
  invariantPaths: [
    'shared/lib/side-effect-ledger.ts',
    'shared/lib/side-effect-ledger-guard.ts',
  ],
  patterns: [
    {
      name: 'git-push',
      description: '`git push` — publish through a recorded seam (branch-publication / tend-controller) that calls shadowRecordSideEffect with gitPushKey',
      lang: 'both',
      // Command string (`git push`, `git -C dir push`) or a git argv array
      // starting with 'push' followed by a remote (variable, 'origin', or a flag).
      re: /\bgit\s+(?:-C\s+\S+\s+)?push\b|\[\s*['"]push['"]\s*,\s*(?:[a-z_$][\w$]*\b|['"](?:origin|upstream|-[\w-]+)['"])/,
    },
    {
      name: 'gh-pr-merge',
      description: '`gh pr merge` — merge through tend (prMergeKey) so the merge is recorded',
      lang: 'both',
      re: /\bgh\s+pr\s+merge\b|['"]pr['"]\s*,\s*['"]merge['"]/,
    },
    {
      name: 'gh-label-write',
      description: '`--add-label` / `--remove-label` — write labels through a recorded seam (prLabelKey)',
      lang: 'both',
      re: /--(?:add|remove)-label\b/,
    },
    {
      name: 'linear-state-transition',
      description: 'Linear `stateId` write — transition through shared/lib/linear.js (linearTransitionKey)',
      lang: 'ts',
      re: /\bstateId\s*:/,
    },
  ],
  remediation: [
    'Every git push, PR label write, Linear state transition and PR merge shadow-records',
    'one side_effect row via shadowRecordSideEffect() with the shared key builders',
    '(HOK-3183). Route new effects through an existing recorded seam; never add a raw',
    'push / gh pr edit --add-label / gh pr merge / Linear stateId write.',
  ],
};
