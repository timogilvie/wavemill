#!/usr/bin/env bash
# Golden journey (HOK-3373): one task-worktree resolver, two outcomes.
#
#   JRN-8  a delivered row on a non-task branch whose directory is gone:
#          cleanup skips it (`safe_noop` keeps only "protected or non-task
#          branch"); it is never reaped as if its resources were proven absent.
#   JRN-9  an ACTIVE task whose worktree is a plain directory (the HOK-2595
#          orphan shape: a marker under features/<slug>/, no .git): the
#          picker holds the backlog as an UNKNOWN in-flight touch set instead
#          of running `git -C` there (which falls through to the main checkout
#          and once made a dead task "touch" every file of main).
#
# Zero operator touches.
set -euo pipefail
source "$(dirname "$0")/harness.sh"
source "$JOURNEY_INSTALL_DIR/tests/lib/state-fixtures.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP settled-attempt-unknown-worktree journey: $reason"
  exit 0
fi

JOURNEY_MAX_PARALLEL=3
journey_init settled-attempt-unknown-worktree

fakes_origin_branch "manual/hotfix" "$JOURNEY_INTEGRATION_BRANCH"
integration_sha="$(git --git-dir "$FAKE_GH_ORIGIN" rev-parse "refs/heads/$JOURNEY_INTEGRATION_BRANCH")"
fakes_gh_state '.prs["1"] = {number: 1, title: "manual hotfix", body: "", headRefName: "manual/hotfix", baseRefName: $base,
    headRefOid: $sha, observedHead: $sha, state: "MERGED", isDraft: false, labels: [], createdAt: "2026-10-30T10:00:00Z",
    updatedAt: "2026-10-30T11:00:00Z", mergedAt: "2026-10-30T11:00:00Z", mergeCommitOid: $sha}
  | .nextPr = 2' --arg base "$JOURNEY_INTEGRATION_BRANCH" --arg sha "$integration_sha"

fakes_linear_add_issue JRN-8 "Manual hotfix tracked by the mill" Done
fakes_linear_add_issue JRN-9 "Active task whose worktree is unresolvable" "In Progress"
fakes_linear_add_issue JRN-2 "Add journey output file" Todo

# JRN-9's worktree path holds only a recreated marker: a directory, not a
# git worktree. git -C there would resolve to the enclosing checkout.
mkdir -p "$WORKTREE_ROOT/jrn-9-orphan/features/jrn-9-orphan"
: > "$WORKTREE_ROOT/jrn-9-orphan/features/jrn-9-orphan/.ready-bypass-warned"

lifecycle_merged="$(jq -cn --arg base "$JOURNEY_INTEGRATION_BRANCH" '{schemaVersion: 1, workflowOutcome: "merged",
  resourceDisposition: "verification-required", retention: {reason: "verification-required"},
  launchContract: {baseBranch: $base, remoteBranchDeletionPolicy: {allowed: false, mode: "manual-verification"}}}')"
lifecycle_active="$(jq -cn --arg base "$JOURNEY_INTEGRATION_BRANCH" '{schemaVersion: 1, workflowOutcome: "active",
  resourceDisposition: "allocated", launchContract: {baseBranch: $base, remoteBranchDeletionPolicy: {allowed: false}}}')"
fixture_workflow_state "$STATE_FILE" \
  JRN-8 slug=manual-hotfix branch=manual/hotfix worktree="$WORKTREE_ROOT/manual-hotfix" pr=1 status=merged phase=done \
    runId="JRN-8:e:1" linearSyncedState=Done lifecycle:="$lifecycle_merged" \
  -- JRN-9 slug=jrn-9-orphan branch=task/jrn-9-orphan worktree="$WORKTREE_ROOT/jrn-9-orphan" status=active phase=planning \
    runId="JRN-9:e:1" lifecycle:="$lifecycle_active"

journey_start_monitor

held_as_unknown() { grep -q "holds: touch set of JRN-9 unknown" "$JOURNEY_TMP/logs/monitor.out" 2>/dev/null; }
journey_wait_until JRN-9 6 "picker holds JRN-2 against JRN-9's unknown touch set" held_as_unknown

echo ""
echo "assertions:"
journey_assert "the non-task-branch row was skipped, not reaped" \
  test "$(jq -r '.tasks["JRN-8"].status // empty' "$STATE_FILE")" = "merged"
journey_assert "JRN-2 was not offered as safe to launch next to JRN-9" \
  bash -c '! grep -q "Launch next.*JRN-2" "$1"' _ "$JOURNEY_TMP/logs/monitor.out"
journey_assert "no touch-set job ran git against JRN-9's directory" \
  test ! -e "$WORKTREE_ROOT/jrn-9-orphan/features/jrn-9-orphan/.in-flight-touch-set-result.json"
journey_assert "the main checkout's files never became anyone's touch set" \
  bash -c '! grep -q "shares .gitattributes" "$1"' _ "$JOURNEY_TMP/logs/monitor.out"
journey_assert_no_unhandled_fake_calls

journey_finish
