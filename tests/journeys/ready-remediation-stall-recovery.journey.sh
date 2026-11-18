#!/usr/bin/env bash
# Golden journey (HOK-3447): CI is red when Ready first checks the PR, the mill
# launches one Ready remediation, the agent fixes the failing check, commits —
# and exits WITHOUT pushing. The mill must publish that repair commit through
# the one head-publication seam (the same path the settled disposition uses),
# re-run Ready on the new head, and merge with no operator touch.
#
# Protects against the 2026-11 HOK-3325 Ready stall class: a finished repair
# whose commit was never published, and a disposition split where only a
# `settled` agent published its head while an `advanced` one (the worktree
# head moved past the launch head) fell through unpublished. The controller's
# own publication is observable in the mill log
# ("Ready remediation advanced the worktree head"), which only the unified
# path emits.
#
# Also protects: the repair launch being charged twice for one head, a
# remediation exhaustion / pending-ready halt, and an operator page.
#
# CI is modelled as a function of the PR head's content: a head whose
# journey-output.txt lacks the fix line is red; a head carrying it is green.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP ready-remediation-stall-recovery journey: $reason"
  exit 0
fi

ISSUE="JRN-9"
FIX_LINE="fixed: unit-tests green"
# Before journey_init: the tmux server (and so every agent pane) inherits the
# environment at init.
export FAKE_AGENT_SCRIPT_DIR
FAKE_AGENT_SCRIPT_DIR="$(cd "$(dirname "$0")/fixtures/ready-remediation-stall-recovery/fake-agent" && pwd)"
journey_init ready-remediation-stall-recovery
# Ready remediation relaunches the task's recorded coder (task_launch_model).
export WAVEMILL_CODER_MODEL="claude-opus-4-7"
fakes_linear_add_issue "$ISSUE" "Change whose repair commit the agent never pushes" Todo

# ── fake CI ────────────────────────────────────────────────────────────────
ci_verdict_for_head() {
  local head="$1"
  if git --git-dir "$FAKE_GH_ORIGIN" show "$head:journey-output.txt" 2>/dev/null | grep -qx "$FIX_LINE"; then
    echo SUCCESS
  else
    echo FAILURE
  fi
}

ci_set_pr1() {
  local conclusion="$1"
  fakes_gh_state_lock
  fakes_gh_state '.checks.byPr["1"] = [{name: "unit-tests", conclusion: $c}]' --arg c "$conclusion"
  fakes_gh_state_unlock
}

CI_LAST=""
RED_HEAD=""
ci_tick() {
  local head conclusion
  head="$(jq -r '.prs["1"].headRefName // empty' "$FAKE_GH_STATE" 2>/dev/null)"
  [[ -n "$head" ]] || return 0
  head="$(git --git-dir "$FAKE_GH_ORIGIN" rev-parse -q --verify "refs/heads/$head" 2>/dev/null)" || return 0
  conclusion="$(ci_verdict_for_head "$head")"
  if [[ "$head/$conclusion" != "$CI_LAST" ]]; then
    ci_set_pr1 "$conclusion"
    CI_LAST="$head/$conclusion"
    [[ "$conclusion" == "FAILURE" && -z "$RED_HEAD" ]] && RED_HEAD="$head"
    journey_log "fake CI: ${head:0:7} → $conclusion"
  fi
}

ci_set_pr1 FAILURE

# ── observation ────────────────────────────────────────────────────────────
phase_is() { ci_tick; [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
remediation_launches() { grep -c "phase=coding issue=$ISSUE role=ready-remediation" "$FAKE_AGENT_LOG" 2>/dev/null || true; }
remediation_launched() { ci_tick; [[ "$(remediation_launches)" -ge 1 ]]; }
repair_committed_locally() { ci_tick; [[ -f "$FAKE_ROOT/remediation-committed" ]]; }
fix_published() { ci_tick; [[ "$CI_LAST" == */SUCCESS ]]; }
pr_merged() { ci_tick; journey_pr_merged; }
mill_log_count() {
  sed 's/\x1b\[[0-9;]*[A-Za-z]//g' "$JOURNEY_TMP/logs/monitor.out" "$JOURNEY_TMP/logs/status.log" 2>/dev/null \
    | grep -c "$1" || true
}

journey_start_monitor
journey_set_tick_budget 90
journey_wait_until "$ISSUE" 5  "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

# Budgets are monitor ticks (passes), not seconds.
journey_wait_until "$ISSUE" 5  "task launched into planning"          phase_is planning
journey_wait_until "$ISSUE" 8  "coding launched"                      phase_is coding
journey_wait_until "$ISSUE" 8  "review launched"                      phase_is review
journey_wait_until "$ISSUE" 10 "red CI made Ready launch remediation" remediation_launched
journey_wait_until "$ISSUE" 10 "the repair was committed but not pushed" repair_committed_locally
journey_wait_until "$ISSUE" 10 "the mill published the repair head (CI green)" fix_published
journey_wait_until "$ISSUE" 15 "PR merged by tend on the repair head"  pr_merged
journey_wait_until "$ISSUE" 8  "task reaped after merge"              journey_task_reaped "$ISSUE"

echo ""
echo "assertions:"
journey_assert "exactly one remediation launched (one budget unit for the red head)" \
  test "$(remediation_launches)" = "1"
journey_assert "the remediation agent never pushed: the repair commit is the mill's publish" \
  test ! -s "$FAKE_GH_UNHANDLED"
journey_assert "the mill published from the advanced disposition (the unified path)" \
  bash -c '(( $1 >= 1 ))' _ "$(mill_log_count "Ready remediation advanced the worktree head")"
journey_assert "no 'Ready remediation exhausted' at any point" \
  test "$(mill_log_count "Ready remediation exhausted")" = "0"
journey_assert "no pending-ready re-check exhaustion at any point" \
  test "$(mill_log_count "Pending-ready re-checks exhausted")" = "0"
journey_assert "the merged head carries the repair commit" \
  bash -c '[[ -n "$1" && "$(git --git-dir "$2" show "refs/heads/$3:journey-output.txt")" == *"$4"* ]]' \
    _ "$(cat "$FAKE_ROOT/remediation-commit" 2>/dev/null || true)" "$FAKE_GH_ORIGIN" "$JOURNEY_INTEGRATION_BRANCH" "$FIX_LINE"
journey_assert "the PR merged at a head other than the red one" \
  bash -c '[[ -n "$1" && "$(jq -r ".prs[\"1\"].headRefOid // empty" "$2")" != "$1" ]]' _ "$RED_HEAD" "$FAKE_GH_STATE"
journey_assert_landed "$ISSUE"
journey_assert_session_ownership "$ISSUE" planning coding review ready-remediation

journey_finish
