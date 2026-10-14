#!/usr/bin/env bash
# Golden journey: tend has to rebase and push, and GitHub is slow to show it.
#
# Protects against: the HOK-3105 class — after tend rebases a PR onto a moved
# integration branch and force-pushes, GitHub keeps reporting the old head for
# a few reads. Tend must rebind to the pushed head and still merge, rather than
# refusing the handoff and leaving a green PR parked behind wm:blocked.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP gh-lag-after-push journey: $reason"
  exit 0
fi

ISSUE="JRN-2"
journey_init gh-lag-after-push
fakes_linear_add_issue "$ISSUE" "Change while integration moves" Todo

# Right before tend's first tick: another change lands on the integration
# branch (so tend must rebase + push), and the next 3 PR head reads after the
# push still report the pre-push head.
move_integration_and_lag_reads() {
  fakes_repo_commit "$JOURNEY_INTEGRATION_BRANCH" "other-change.txt" "landed meanwhile" "concurrent change"
  fakes_gh_state '.headLag["1"] = 3'
  journey_log "fault: integration moved; gh head reads lag by 3 after push"
}
JOURNEY_BEFORE_FIRST_TEND=move_integration_and_lag_reads

journey_start_monitor
journey_wait_until "$ISSUE" 30 "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
pr_merged() { [[ "$(jq -r '.prs["1"].state // empty' "$FAKE_GH_STATE")" == "MERGED" ]]; }

journey_wait_until "$ISSUE" 60  "task launched into planning" phase_is planning
journey_wait_until "$ISSUE" 120 "review launched"             phase_is review
journey_wait_until "$ISSUE" 180 "PR merged by tend despite lag" pr_merged

echo ""
echo "assertions:"
journey_assert "the lag was actually exercised (all lagged reads consumed)" \
  test "$(jq -r '.headLag["1"]' "$FAKE_GH_STATE")" = "0"
journey_assert "tend rebased: merged PR contains the concurrent integration change" \
  git --git-dir "$FAKE_GH_ORIGIN" cat-file -e "refs/heads/$JOURNEY_INTEGRATION_BRANCH:other-change.txt"
journey_assert "and the task's own change" \
  git --git-dir "$FAKE_GH_ORIGIN" cat-file -e "refs/heads/$JOURNEY_INTEGRATION_BRANCH:journey-output.txt"
journey_assert "PR never ended up wm:blocked" \
  bash -c '! jq -e ".prs[\"1\"].labels | index(\"wm:blocked\")" "$1" >/dev/null' _ "$FAKE_GH_STATE"
journey_assert_no_unhandled_fake_calls

journey_finish
