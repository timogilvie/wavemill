#!/usr/bin/env bash
# Golden journey: the mill opens the task PR at review exit (HOK-3463).
#
# Protects against: finished review work stranded as a terminal "no PR" when
# the review agent cannot reach GitHub (the HOK-3424 incident: gh was not
# logged in inside the agent's isolated HOME, the review-fix commit was never
# published and the task sat in `error` for 21 hours). The review agent here
# never pushes and never calls gh; it only records the PR title and body.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP mill-opens-task-pr journey: $reason"
  exit 0
fi

ISSUE="JRN-1"
export FAKE_AGENT_SCRIPT_DIR
FAKE_AGENT_SCRIPT_DIR="$(cd "$(dirname "$0")/fixtures/mill-opens-task-pr/fake-agent" && pwd)"
journey_init mill-opens-task-pr
fakes_linear_add_issue "$ISSUE" "Add journey output file" Todo

journey_start_monitor
journey_set_tick_budget 60
journey_wait_until "$ISSUE" 5  "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }

journey_wait_until "$ISSUE" 5  "task launched into planning" phase_is planning
journey_wait_until "$ISSUE" 8  "coding launched"             phase_is coding
journey_wait_until "$ISSUE" 8  "review launched"             phase_is review
journey_wait_until "$ISSUE" 20 "PR merged by tend"           journey_pr_merged
journey_wait_until "$ISSUE" 8  "task reaped after merge"     journey_task_reaped "$ISSUE"

echo ""
echo "assertions:"
journey_assert_landed "$ISSUE"
journey_assert "the PR carries the title the review agent recorded" \
  test "$(fakes_gh_pr_field 1 title)" = "$ISSUE: journey change opened by the mill"
journey_assert "the PR body carries the task metadata block" \
  bash -c 'jq -r ".prs[\"1\"].body" "$1" | grep -q "wavemill-meta"' _ "$FAKE_GH_STATE"
journey_assert "the unpushed review-fix commit reached $JOURNEY_INTEGRATION_BRANCH" \
  bash -c 'git --git-dir "$1" show "refs/heads/$2:journey-output.txt" | grep -q "review fix for"' _ "$FAKE_GH_ORIGIN" "$JOURNEY_INTEGRATION_BRANCH"
journey_assert "no operator attention was needed" test "$JOURNEY_SAW_ATTENTION" = "0"

journey_finish
