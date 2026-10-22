#!/usr/bin/env bash
# Golden journey: Ready fails on red CI, the mill's remediator pushes a fix,
# CI goes green on the new head and the task merges with no operator touch
# (HOK-3228; HOK-3092 / HOK-3147 class).
#
# Protects against: a red Ready that never reaches a remediation launch, a
# remediation that is never re-evaluated at its new head (the failed verdict
# latched against the old head), or a remediation budget charged so eagerly
# that a fixed PR parks at "Ready remediation exhausted" instead of merging.
#
# CI is a function of the code: the fake GitHub reports every check red while
# the PR head contains ci-broken.txt (checks.redWhileHeadHas). The first
# coding launch commits it; the remediator deletes it (fixtures/
# ready-remediation/fake-agent/coding).
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP ready-remediation journey: $reason"
  exit 0
fi

ISSUE="JRN-5"
# Before journey_init: the tmux server (and so every agent pane) inherits the
# environment at init.
export FAKE_AGENT_SCRIPT_DIR
FAKE_AGENT_SCRIPT_DIR="$(cd "$(dirname "$0")/fixtures/ready-remediation/fake-agent" && pwd)"
journey_init ready-remediation
fakes_linear_add_issue "$ISSUE" "Change that breaks CI first" Todo
fakes_gh_state '.checks.redWhileHeadHas = "ci-broken.txt"'
# A red Ready writes .needs-attention until the remediation launches; the
# journey is about the mill recovering on its own, not about that flag.
JOURNEY_EXPECT_ATTENTION=any

journey_start_monitor
journey_wait_until "$ISSUE" 5  "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
pr_exists() { [[ -n "$(fakes_gh_pr_field 1 state)" ]]; }
remediator_launched() { [[ "$(journey_agent_role_launches "$ISSUE" ready-remediator)" -ge 1 ]]; }
# The PR head the remediator pushed (CI green) is what GitHub now reports.
fix_pushed() { ! git --git-dir "$FAKE_GH_ORIGIN" cat-file -e "$(fakes_gh_pr_field 1 headRefName):ci-broken.txt" 2>/dev/null; }

# Budgets are monitor ticks (passes), not seconds.
journey_wait_until "$ISSUE" 5  "task launched into planning"              phase_is planning
journey_wait_until "$ISSUE" 15 "review opened PR #1 with CI red"          pr_exists
journey_wait_until "$ISSUE" 10 "Ready launched the remediator"            remediator_launched
journey_wait_until "$ISSUE" 8  "remediator pushed the fix"                fix_pushed
journey_wait_until "$ISSUE" 20 "PR merged by tend after CI went green"    journey_pr_merged
journey_wait_until "$ISSUE" 8  "task reaped after merge"                  journey_task_reaped "$ISSUE"

echo ""
echo "assertions:"
journey_assert "exactly one remediator launched" \
  test "$(journey_agent_role_launches "$ISSUE" ready-remediator)" = "1"
journey_assert "the merged head is the remediator's fix commit, not the red head" \
  bash -c 'git --git-dir "$1" log -1 --format=%s "$2" | grep -q "$3: fix CI"' \
    _ "$FAKE_GH_ORIGIN" "$(fakes_gh_pr_field 1 headRefOid)" "$ISSUE"
journey_assert "the remediation fix is part of what merged" \
  bash -c '! git --git-dir "$1" cat-file -e "refs/heads/$2:ci-broken.txt" 2>/dev/null' \
    _ "$FAKE_GH_ORIGIN" "$JOURNEY_INTEGRATION_BRANCH"
journey_assert "no 'Ready remediation exhausted' at any point" \
  test "$(journey_mill_log_count "Ready remediation exhausted")" = "0"
journey_assert_landed "$ISSUE"

journey_finish
