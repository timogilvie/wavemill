#!/usr/bin/env bash
# Golden journey: the integration branch conflicts with the PR mid-flight, the
# mill's resolver fixes it, and the task still merges with no operator touch
# (HOK-3273).
#
# Protects against: the HOK-3241 latch. Conflict state lived in a bare
# `.conflict-detected` touch that only a completed Ready pass cleared, and the
# one-shot conflict budget was charged when Ready launched rather than when a
# resolver did. After the resolver pushed a clean fix, the first Ready at the
# new head deferred on the pending cross-PR revert guard (HOK-3206) and spent
# the budget, so the next pass wrote "Conflict remediation exhausted" over a
# green, MERGEABLE PR and parked it at needs-user.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP mid-flight-base-conflict journey: $reason"
  exit 0
fi

ISSUE="JRN-3"
# Before journey_init: the tmux server (and so every agent pane) inherits the
# environment at init.
export FAKE_AGENT_SCRIPT_DIR
FAKE_AGENT_SCRIPT_DIR="$(cd "$(dirname "$0")/fixtures/hok-3273/fake-agent" && pwd)"
journey_init mid-flight-base-conflict
fakes_linear_add_issue "$ISSUE" "Change that collides with integration" Todo
# The conflict raises needs-user only if the resolver cannot launch; a ready
# re-run after the push may briefly surface attention while GitHub catches up.
JOURNEY_EXPECT_ATTENTION=any

journey_start_monitor
journey_wait_until "$ISSUE" 5  "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
resolver_launched() { [[ "$(journey_resolver_launches)" -ge 1 ]]; }
journey_resolver_launches() { grep -c "phase=coding issue=$ISSUE role=conflict-resolver" "$FAKE_AGENT_LOG" 2>/dev/null || true; }
conflict_exhaustions() {
  sed 's/\x1b\[[0-9;]*[A-Za-z]//g' "$JOURNEY_TMP/logs/monitor.out" "$JOURNEY_TMP/logs/status.log" 2>/dev/null \
    | grep -c "Conflict remediation exhausted" || true
}

# Budgets are monitor ticks (passes), not seconds.
journey_wait_until "$ISSUE" 5  "task launched into planning"           phase_is planning
journey_wait_until "$ISSUE" 15 "review opened PR #1, then base conflicted" \
  journey_jq_true '.prs["1"].overrides.mergeable == "CONFLICTING"' "$FAKE_GH_STATE"
journey_wait_until "$ISSUE" 15 "Ready launched the conflict resolver"  resolver_launched
journey_wait_until "$ISSUE" 25 "PR merged by tend after the resolution" journey_pr_merged
journey_wait_until "$ISSUE" 8  "task reaped after merge"               journey_task_reaped "$ISSUE"

echo ""
echo "assertions:"
journey_assert "exactly one resolver launched for the conflicted head" \
  test "$(journey_resolver_launches)" = "1"
journey_assert "no 'Conflict remediation exhausted' at any point" \
  test "$(conflict_exhaustions)" = "0"
journey_assert "the contending integration change survived the merge" \
  bash -c 'git --git-dir "$1" log --format=%s "refs/heads/$2" | grep -q "contending change to journey-output.txt"' \
    _ "$FAKE_GH_ORIGIN" "$JOURNEY_INTEGRATION_BRANCH"
journey_assert_landed "$ISSUE"

journey_finish
