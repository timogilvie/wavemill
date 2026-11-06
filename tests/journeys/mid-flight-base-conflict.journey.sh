#!/usr/bin/env bash
# Golden journey: the integration branch conflicts with the PR mid-flight, the
# mill merges the base into the task branch (HOK-3385), a native-compatible
# resolver only resolves the conflicted files, and the task still merges with
# no operator touch (HOK-3273).
#
# Protects against: the HOK-3241 latch. Conflict state lived in a bare
# `.conflict-detected` touch that only a completed Ready pass cleared, and the
# one-shot conflict budget was charged when Ready launched rather than when a
# resolver did. After the resolver pushed a clean fix, the first Ready at the
# new head deferred on the pending cross-PR revert guard (HOK-3206) and spent
# the budget, so the next pass wrote "Conflict remediation exhausted" over a
# green, MERGEABLE PR and parked it at needs-user.
#
# Also protects against: the HOK-3374 incident (2026-11-01). The resolver
# prompt told the agent to git-fetch and git-merge the base itself — tools a
# native runtime does not have — so every native-coded task whose PR
# conflicted spent the budget on launches that could never succeed and parked
# at needs-user. Now the mill opens the merge through updateBranchWithBase
# (retain-conflict) before launching, the resolver only edits/stages/commits
# (it never fetches, merges, rebases, or pushes), and the mill publishes the
# resolution through the stage-head seam.
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
# Zero operator touches: the conflict must never surface as needs-attention
# (the harness default asserts no .needs-attention at any tick).

journey_start_monitor
journey_set_tick_budget 90
journey_wait_until "$ISSUE" 5  "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
resolver_launched() { [[ "$(journey_resolver_launches)" -ge 1 ]]; }
journey_resolver_launches() { grep -c "phase=coding issue=$ISSUE role=conflict-resolver" "$FAKE_AGENT_LOG" 2>/dev/null || true; }
pr_exists() { [[ -n "$(fakes_gh_pr_field 1 state)" ]]; }
mill_log_count() {
  sed 's/\x1b\[[0-9;]*[A-Za-z]//g' "$JOURNEY_TMP/logs/monitor.out" "$JOURNEY_TMP/logs/status.log" 2>/dev/null \
    | grep -c "$1" || true
}

# Budgets are monitor ticks (passes), not seconds.
journey_wait_until "$ISSUE" 5  "task launched into planning"           phase_is planning
journey_wait_until "$ISSUE" 15 "base conflicted, then review opened PR #1" pr_exists
journey_wait_until "$ISSUE" 15 "Ready launched the conflict resolver"  resolver_launched
journey_wait_until "$ISSUE" 25 "PR merged by tend after the resolution" journey_pr_merged
journey_wait_until "$ISSUE" 8  "task reaped after merge"               journey_task_reaped "$ISSUE"

echo ""
echo "assertions:"
journey_assert "exactly one resolver launched for the conflicted head" \
  test "$(journey_resolver_launches)" = "1"
journey_assert "the mill opened the merge before the resolver ran (HOK-3385)" \
  grep -q "role=conflict-resolver merge_in_progress=yes" "$FAKE_AGENT_LOG"
journey_assert "both sides' lines survived the resolution (HOK-3374 shape)" \
  bash -c 'content="$(git --git-dir "$1" show "refs/heads/$2:journey-output.txt")" \
    && grep -q "implemented" <<<"$content" && grep -q "contending change" <<<"$content"' \
    _ "$FAKE_GH_ORIGIN" "$JOURNEY_INTEGRATION_BRANCH"
journey_assert "no 'Conflict remediation exhausted' at any point" \
  test "$(mill_log_count "Conflict remediation exhausted")" = "0"
journey_assert "Ready saw the conflict on GitHub" \
  bash -c '(( $1 >= 1 ))' _ "$(mill_log_count "Merge conflict detected for $ISSUE")"
journey_assert "the reconciler expired the in-flight marker on the resolved head" \
  bash -c '(( $1 >= 1 ))' _ "$(mill_log_count "cleared .conflict-remediation.json (head:")"
# HOK-3241 shape: a guard-deferred Ready must never spend the conflict
# budget (the one-launch assertion above proves the budget held). Under
# HOK-3385 the post-resolution Ready holds on the publish/head-lag path
# rather than the guard, so exactly one guard deferral is the common shape.
journey_assert "a Ready deferred on the cross-PR guard without spending the budget (the HOK-3241 shape)" \
  bash -c '(( $1 >= 1 ))' _ "$(mill_log_count "cross-PR revert guard pending - deferring Ready")"
journey_assert "the contending integration change survived the merge" \
  bash -c 'git --git-dir "$1" log --format=%s "refs/heads/$2" | grep -q "contending change to journey-output.txt"' \
    _ "$FAKE_GH_ORIGIN" "$JOURNEY_INTEGRATION_BRANCH"
journey_assert_landed "$ISSUE"

journey_finish
