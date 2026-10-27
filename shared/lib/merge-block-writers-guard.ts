// allow-merge-block-writer: this file *is* the merge-block guard; its pattern
// table names every forbidden shape. It is auto-excluded from its own scan
// (see invariantPaths); the marker above is defensive.
/**
 * Preflight guard for the one-merge-block-decision invariant (HOK-3316,
 * completing HOK-3181): `deriveMergeLabel()` in shared/lib/merge-labels.ts is
 * the only code that decides whether a PR carries `wm:blocked`.
 *
 * Tend used to keep a private block writer (`releaseToBlocked` →
 * `setWavemillBlocked`) and a private clearer (`resolveBlockedLabelReason` /
 * `clearGuardBlockedLabel`) next to the reconciler; the two disagreed every
 * poll on PR #1697. A merge-blocking outcome is now recorded as a fact the
 * reconciler reads (`shared/lib/tend-attempt-fact.ts`), and its PR comment is
 * posted once per condition by the side-effect-ledger-backed
 * `shared/lib/merge-status-comment.ts`.
 *
 * Forbidden outside the invariant source:
 *
 * - any `setWavemillBlocked` call or a `releaseToBlocked` dependency;
 * - a direct `wm:blocked` clear (`removeLabelFromPullRequest(…blocked…)`,
 *   `--remove-label wm:blocked`);
 * - `gh pr comment` outside the merge-status poster. Pre-existing comment
 *   sites (challenge comparison, challenge recovery) are held by a count
 *   ratchet in tools/merge-block-writers-allowlist.txt.
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

export const MERGE_BLOCK_WRITERS_GUARD: GuardSpec = {
  name: 'merge-block-writers',
  findingNoun: 'merge-block decision site(s) outside deriveMergeLabel',
  suppressionMarker: 'allow-merge-block-writer',
  allowlistFile: 'tools/merge-block-writers-allowlist.txt',
  invariantPaths: [
    'shared/lib/merge-labels.ts',
    'shared/lib/pr-state-labels.ts',
    'shared/lib/merge-status-comment.ts',
    'shared/lib/merge-block-writers-guard.ts',
  ],
  patterns: [
    {
      name: 'set-wavemill-blocked',
      description: '`setWavemillBlocked` outside the reconciler — record the blocking fact (e.g. writeTendAttemptFact) and let deriveMergeLabel render wm:blocked',
      lang: 'ts',
      re: /\bsetWavemillBlocked\b/,
    },
    {
      name: 'release-to-blocked',
      description: '`releaseToBlocked` — a private wm:blocked writer; release wm:merging only and record the outcome as a fact',
      lang: 'both',
      re: /\breleaseToBlocked\b/,
    },
    {
      name: 'blocked-label-clear',
      description: 'direct `wm:blocked` clear — a private clearer; the reconciler drops wm:blocked once its inputs stop deciding it',
      lang: 'both',
      // allow-side-effect-ledger: pattern text naming the forbidden clear, not a label write
      re: /removeLabelFromPullRequest\([^)]*(?:WM_LABELS\.blocked|['"`]wm:blocked['"`])|--remove-label[\s=]+["']?wm:blocked/,
    },
    {
      name: 'gh-pr-comment',
      description: '`gh pr comment` outside shared/lib/merge-status-comment.ts — post through postMergeStatusComment (one standing comment, one write per condition)',
      lang: 'both',
      re: /\bgh\s+pr\s+comment\b|\[\s*['"]pr['"]\s*,\s*['"]comment['"]/,
    },
  ],
  remediation: [
    'deriveMergeLabel() (shared/lib/merge-labels.ts) is the only decider of wm:blocked (HOK-3316).',
    'Record a merge-blocking outcome as a condition-keyed fact it reads, never as a label write or clear,',
    'and post PR comments through postMergeStatusComment (shared/lib/merge-status-comment.ts).',
  ],
};
