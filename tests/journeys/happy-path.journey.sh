#!/usr/bin/env bash
# Golden journey: one task from backlog selection to merged and reaped.
#
# Protects against: any break in the plan → code → review → ready → tend merge
# → reap chain across real module boundaries — e.g. a reader that expects a
# field the writer never produces (HOK-3212), or a hand-off whose two sides
# disagree on shape (the reconciler never applying wm:ready).
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP happy-path journey: $reason"
  exit 0
fi

ISSUE="JRN-1"
journey_init happy-path
fakes_linear_add_issue "$ISSUE" "Add journey output file" Todo

journey_start_monitor
# The operator picks the first backlog task, as from the mill prompt.
journey_wait_until "$ISSUE" 30 "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
pr_merged() { [[ "$(jq -r '.prs["1"].state // empty' "$FAKE_GH_STATE")" == "MERGED" ]]; }
task_reaped() {
  local status
  status="$(journey_task_field "$ISSUE" status)"
  [[ -z "$(journey_task_field "$ISSUE" phase)" || "$status" == "merged" || "$status" == "completed" ]] \
    && [[ ! -d "$WORKTREE_ROOT/$(jq -r --arg id "$ISSUE" '.tasks[$id].slug // "__none__"' "$STATE_FILE" 2>/dev/null)" ]]
}

journey_wait_until "$ISSUE" 60  "task launched into planning" phase_is planning
journey_wait_until "$ISSUE" 90  "coding launched"             phase_is coding
journey_wait_until "$ISSUE" 90  "review launched"             phase_is review
journey_wait_until "$ISSUE" 120 "PR merged by tend"           pr_merged
journey_wait_until "$ISSUE" 90  "task reaped after merge"     task_reaped

echo ""
echo "assertions:"
journey_assert "PR #1 merged into $JOURNEY_INTEGRATION_BRANCH" \
  test "$(fakes_gh_pr_field 1 baseRefName)" = "$JOURNEY_INTEGRATION_BRANCH"
journey_assert "merged change is on the integration branch" \
  git --git-dir "$FAKE_GH_ORIGIN" cat-file -e "refs/heads/$JOURNEY_INTEGRATION_BRANCH:journey-output.txt"
journey_assert "wm:ready was applied before the merge (by the mill, not the agent)" \
  bash -c 'jq -e "select(.argv|join(\" \")|test(\"labels\")) " "$1" >/dev/null && grep -q "wm%3Aready\|wm:ready" "$1"' _ "$FAKE_GH_LOG"
journey_assert "Linear issue ended Done" test "$(fakes_linear_state_of "$ISSUE")" = "Done"
journey_assert "Linear saw In Progress before Done" \
  bash -c 'jq -e "[.transitions[] | select(.identifier==\"JRN-1\") | .to] | index(\"In Progress\") != null" "$1" >/dev/null' _ "$FAKE_LINEAR_STATE"
journey_assert_no_unhandled_fake_calls

journey_finish
