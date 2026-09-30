/**
 * pr-comparison-actions — plan the PR-side actions after a challenge comparison.
 *
 * HOK-3102: `compare-prs` never merges. The winner reaches a merge through the
 * single merge executor (tend, via `tend-challenge-gate` on `autoMergeWinner`),
 * so this planner emits `comment` and `close` actions only — never `merge`.
 *
 * The action list is constructed here (not inline in the tool) so a unit test
 * can assert that no merge action is emitted for any combination of inputs,
 * satisfying acceptance item 3 (compare-prs never calls `gh pr merge`).
 *
 * @module pr-comparison-actions
 */

export type ChallengeOutcome =
  | 'compared'
  | 'skipped-identical'
  | 'invalid'
  | 'inconclusive';

export interface PlanComparisonPrActionsInput {
  outcome: ChallengeOutcome;
  /**
   * Recommended winner side. Required when outcome is `compared`. For
   * `skipped-identical` the primary is retained by convention.
   */
  winner?: 'primary' | 'challenger' | null;
  primary: { number: string; commentBody: string };
  challenger: { number: string; commentBody: string };
  /**
   * When true, close the loser (compared) or the challenger (skipped-identical).
   * This mirrors the pre-HOK-3102 `--auto-merge` / `challenge.autoMergeWinner`
   * behavior for the *loser*; the winner is left to the single merge executor.
   */
  autoMergeWinner: boolean;
  /**
   * Whether comment-only mode is requested. When true, actions include the
   * paired comments. `autoMergeWinner` also implies commenting.
   */
  comment: boolean;
  /**
   * Optional model attribution for the winner, used to craft the loser-close
   * message on `compared`.
   */
  winnerModel?: string | null;
}

export interface PlannedCommentAction {
  kind: 'comment';
  pr: string;
  body: string;
}

export interface PlannedCloseAction {
  kind: 'close';
  pr: string;
  reasonBody: string;
}

export type PlannedComparisonAction = PlannedCommentAction | PlannedCloseAction;

/**
 * Plan the post-comparison PR-side actions. Returns a list of actions with
 * no merge action, by construction. Callers execute each action through the
 * `gh` CLI. Empty list is a valid result (e.g., check-only outcomes).
 */
export function planComparisonPrActions(input: PlanComparisonPrActionsInput): PlannedComparisonAction[] {
  const actions: PlannedComparisonAction[] = [];
  const wantComments = input.comment || input.autoMergeWinner;

  if (input.outcome === 'skipped-identical') {
    if (wantComments) {
      actions.push({ kind: 'comment', pr: input.primary.number, body: input.primary.commentBody });
      actions.push({ kind: 'comment', pr: input.challenger.number, body: input.challenger.commentBody });
    }
    if (input.autoMergeWinner) {
      actions.push({
        kind: 'close',
        pr: input.challenger.number,
        reasonBody: 'Closing after skipped challenge comparison. Routing dimensions were identical.',
      });
    }
    return actions;
  }

  if (input.outcome === 'compared') {
    if (wantComments) {
      actions.push({ kind: 'comment', pr: input.primary.number, body: input.primary.commentBody });
      actions.push({ kind: 'comment', pr: input.challenger.number, body: input.challenger.commentBody });
    }
    if (input.autoMergeWinner && (input.winner === 'primary' || input.winner === 'challenger')) {
      const loserNumber = input.winner === 'primary' ? input.challenger.number : input.primary.number;
      const closeSummary = input.winnerModel
        ? `Closing after challenge comparison. Recommended winner: ${input.winnerModel}`
        : `Closing after challenge comparison. Recommended side: ${input.winner}; model attribution unavailable`;
      actions.push({ kind: 'close', pr: loserNumber, reasonBody: closeSummary });
    }
    return actions;
  }

  // invalid / inconclusive: no comments or closes.
  return actions;
}
