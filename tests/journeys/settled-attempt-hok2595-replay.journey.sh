#!/usr/bin/env bash
# Golden journey (HOK-3373): the HOK-2595 replay.
#
# The incident: a merged task (PR #1644) was reset to Linear Backlog by the
# mill's exit trap, relaunched, re-adopted its merged PR, and monitor marker
# writes recreated its long-gone worktree path as a plain directory. A
# touch-set probe ran `git -C` there, fell through to the main checkout, and
# the picker held every candidate for three days; cleanup could not remove the
# row (`safe_noop`) until an operator deleted it by hand.
#
# This journey restarts a mill on exactly that state, with zero operator
# touches: a settled-merged row whose worktree and local branch are gone (the
# exit trap's mark: Linear says Backlog, the Linear sync never landed) and a
# second, ordinary backlog issue.
#
# Protects against:
#   - the delivered issue being offered or relaunched (new row, re-adopted PR)
#   - a marker write recreating the dead worktree path
#   - the dead run holding the picker (JRN-2 is offered, nothing holds on JRN-1)
#   - Linear staying Backlog for delivered work (the convergence tick)
#   - the row never reaping because its resources are already absent
#     (the positive-evidence path, `safe_resources_absent`)
set -euo pipefail
source "$(dirname "$0")/harness.sh"
source "$JOURNEY_INSTALL_DIR/tests/lib/state-fixtures.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP settled-attempt-hok2595-replay journey: $reason"
  exit 0
fi

DELIVERED="JRN-1"
FRESH="JRN-2"
DEAD_SLUG="jrn-1-delivered-long-ago"
JOURNEY_MAX_PARALLEL=2
journey_init settled-attempt-hok2595-replay

# The merged PR the old relaunch re-adopted. Its branch survives on origin (a
# surviving remote branch must not block removal of the row).
fakes_origin_branch "task/$DEAD_SLUG" "$JOURNEY_INTEGRATION_BRANCH"
integration_sha="$(git --git-dir "$FAKE_GH_ORIGIN" rev-parse "refs/heads/$JOURNEY_INTEGRATION_BRANCH")"
fakes_gh_state '.prs["1"] = {number: 1, title: "JRN-1 delivered", body: "", headRefName: $b, baseRefName: $base,
    headRefOid: $sha, observedHead: $sha, state: "MERGED", isDraft: false, labels: [], createdAt: "2026-10-13T10:00:00Z",
    updatedAt: "2026-10-13T11:00:00Z", mergedAt: "2026-10-13T11:00:00Z", mergeCommitOid: $sha}
  | .nextPr = 2' --arg b "task/$DEAD_SLUG" --arg base "$JOURNEY_INTEGRATION_BRANCH" --arg sha "$integration_sha"

# Linear as the exit trap left it: delivered work flipped back to Backlog.
fakes_linear_add_issue "$DELIVERED" "Correlate stalled tend candidates" Backlog
fakes_linear_add_issue "$FRESH" "Add journey output file" Todo

# The settled run's row: merged, worktree and local branch already gone, its
# Linear sync never recorded (crash between settlement and the Linear write).
fixture_workflow_state "$STATE_FILE" "$DELIVERED" \
  slug="$DEAD_SLUG" branch="task/$DEAD_SLUG" worktree="$WORKTREE_ROOT/$DEAD_SLUG" pr=1 \
  status=merged phase=done runId="$DELIVERED:old-epoch:1697190000" linearIssueId="$DELIVERED" \
  lifecycle:="$(jq -cn --arg base "$JOURNEY_INTEGRATION_BRANCH" '{schemaVersion: 1, workflowOutcome: "merged",
    resourceDisposition: "verification-required", retention: {reason: "verification-required"},
    launchContract: {baseBranch: $base, remoteBranchDeletionPolicy: {allowed: false, mode: "manual-verification"}},
    deliveryEvidence: {prNumber: "1", prState: "MERGED"}}')"

journey_start_monitor

delivered_row_gone() { [[ "$(jq -r --arg i "$DELIVERED" '.tasks[$i] // empty' "$STATE_FILE")" == "" ]]; }
linear_done() { [[ "$(fakes_linear_state_of "$DELIVERED")" == "Done" ]]; }

journey_wait_until "$DELIVERED" 6 "Linear converges to Done for the delivered run" linear_done
journey_wait_until "$DELIVERED" 8 "delivered row reaps with its resources already absent" delivered_row_gone
journey_wait_until "$FRESH" 5 "backlog offers $FRESH" journey_backlog_offers "$FRESH"

echo ""
echo "assertions:"
journey_assert "the picker never held a candidate against the dead run" \
  bash -c '! grep -q "holds:.*$1" "$2"' _ "$DELIVERED" "$JOURNEY_TMP/logs/monitor.out"
journey_assert "the delivered issue was never offered by the picker" \
  bash -c '! grep -q "[0-9]\. $1 - " "$2"' _ "$DELIVERED" "$JOURNEY_TMP/logs/monitor.out"
journey_assert "the delivered issue was never relaunched (no agent launch, no new row)" \
  test "$(journey_agent_launch_count "$DELIVERED" planning)" = "0"
journey_assert "the dead worktree path was not recreated" test ! -e "$WORKTREE_ROOT/$DEAD_SLUG"
journey_assert "the merged PR was not re-adopted (still exactly one PR for the branch, MERGED)" \
  test "$(jq -r --arg b "task/$DEAD_SLUG" '[.prs[] | select(.headRefName == $b)] | map(.state) | join(",")' "$FAKE_GH_STATE")" = "MERGED"
journey_assert "Linear moved Backlog -> Done exactly once for the delivered issue" \
  test "$(jq -r --arg id "$DELIVERED" '[.transitions[] | select(.identifier == $id) | .to] | join(",")' "$FAKE_LINEAR_STATE")" = "Done"
journey_assert "the reap left a tombstone carrying the settled run id" \
  test "$(jq -r --arg i "$DELIVERED" '.terminalTaskHistory.tasks[$i].runId // empty' "$STATE_FILE")" = "$DELIVERED:old-epoch:1697190000"
journey_assert "the surviving remote branch did not block removal" \
  git --git-dir "$FAKE_GH_ORIGIN" rev-parse -q --verify "refs/heads/task/$DEAD_SLUG"
journey_assert "no control write was refused (nothing fought the settled run)" \
  test ! -s "$STATE_DIR/mutator-rejections.jsonl"
journey_assert_no_unhandled_fake_calls

journey_finish
