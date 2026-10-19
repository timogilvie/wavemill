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
# Moving the integration branch also makes the monitor see its Ready result as
# stale and re-run Ready while tend already holds the claim; when tend's merge
# wins that race the monitor flags "merged before ready checks passed". That
# race is real but not what this journey guards, so attention is tolerated.
JOURNEY_EXPECT_ATTENTION=any

journey_start_monitor
journey_wait_until "$ISSUE" 5  "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }

# Budgets are monitor ticks (passes), not seconds.
journey_wait_until "$ISSUE" 5  "task launched into planning"   phase_is planning
journey_wait_until "$ISSUE" 15 "review launched"               phase_is review
journey_wait_until "$ISSUE" 15 "PR merged by tend despite lag" journey_pr_merged
journey_wait_until "$ISSUE" 8  "task reaped after merge"       journey_task_reaped "$ISSUE"

echo ""
echo "assertions:"
journey_assert "the lag was actually exercised (all lagged reads consumed)" \
  test "$(jq -r '.headLag["1"]' "$FAKE_GH_STATE")" = "0"
journey_assert "tend rebased: merged PR contains the concurrent integration change" \
  git --git-dir "$FAKE_GH_ORIGIN" cat-file -e "refs/heads/$JOURNEY_INTEGRATION_BRANCH:other-change.txt"
journey_assert_landed "$ISSUE"

journey_finish
