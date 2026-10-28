#!/usr/bin/env bash
# Golden journey: CI is red when Ready first checks the PR, the mill launches
# one Ready remediation carrying the failure, the fix commit turns CI green,
# and the task merges with no operator touch.
#
# Protects against: the Ready failure → remediation → re-check chain breaking
# across module boundaries — a red check not classified as actionable (the
# task parks at needs-user instead of remediating), the remediation budget
# charged twice for one head (a second agent launched over the first), the
# re-check after the fix push never running (wm:blocked latched on a green
# PR), or Ready passing the old red head.
#
# CI is modelled as a function of the PR head's content, not the mill's view
# of it: any head whose journey-output.txt lacks the fix line reports a
# failing `unit-tests` check; a head carrying it reports green.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP ready-fail-remediate journey: $reason"
  exit 0
fi

ISSUE="JRN-4"
FIX_LINE="fixed: unit-tests green"
# Before journey_init: the tmux server (and so every agent pane) inherits the
# environment at init.
export FAKE_AGENT_SCRIPT_DIR
FAKE_AGENT_SCRIPT_DIR="$(cd "$(dirname "$0")/fixtures/ready-fail-remediate/fake-agent" && pwd)"
journey_init ready-fail-remediate
# Ready remediation relaunches the task's recorded coder (task_launch_model).
# The harness runs with the router off, and the direct-launch path persists
# coderModel only when a coder is chosen up front, so pin one the way an
# operator's `--coder-model` does; without it remediation refuses with
# "no model configured" and the task parks in failed-ready rechecks.
export WAVEMILL_CODER_MODEL="claude-opus-4-7"
fakes_linear_add_issue "$ISSUE" "Change whose first push fails CI" Todo

# ── fake CI ────────────────────────────────────────────────────────────────
# Runs on every journey poll. Takes the gh fake's own state lock so a write
# never races a concurrent `gh` call's read-modify-write.
ci_verdict_for_head() {
  local head="$1"
  if git --git-dir "$FAKE_GH_ORIGIN" show "$head:journey-output.txt" 2>/dev/null | grep -qx "$FIX_LINE"; then
    echo SUCCESS
  else
    echo FAILURE
  fi
}

ci_set_pr1() {
  local conclusion="$1" lock="$FAKE_GH_STATE.lock" i
  for i in $(seq 1 500); do
    mkdir "$lock" 2>/dev/null && break
    sleep 0.01
  done
  printf '%s' "$$" > "$lock/pid"
  fakes_gh_state '.checks.byPr["1"] = [{name: "unit-tests", conclusion: $c}]' --arg c "$conclusion"
  rm -rf "$lock"
}

CI_LAST=""
ci_tick() {
  local head conclusion
  head="$(jq -r '.prs["1"].headRefName // empty' "$FAKE_GH_STATE" 2>/dev/null)"
  [[ -n "$head" ]] || return 0
  head="$(git --git-dir "$FAKE_GH_ORIGIN" rev-parse -q --verify "refs/heads/$head" 2>/dev/null)" || return 0
  conclusion="$(ci_verdict_for_head "$head")"
  if [[ "$head/$conclusion" != "$CI_LAST" ]]; then
    ci_set_pr1 "$conclusion"
    CI_LAST="$head/$conclusion"
    journey_log "fake CI: ${head:0:7} → $conclusion"
  fi
}

# Every PR head starts red until CI has looked at it.
ci_set_pr1 FAILURE

# ── observation ────────────────────────────────────────────────────────────
phase_is() { ci_tick; [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
remediation_launches() { grep -c "phase=coding issue=$ISSUE role=ready-remediation" "$FAKE_AGENT_LOG" 2>/dev/null || true; }
remediation_launched() { ci_tick; [[ "$(remediation_launches)" -ge 1 ]]; }
fix_pushed() {
  ci_tick
  [[ "$CI_LAST" == */SUCCESS ]]
}
pr_merged() { ci_tick; journey_pr_merged; }
mill_log_count() {
  sed 's/\x1b\[[0-9;]*[A-Za-z]//g' "$JOURNEY_TMP/logs/monitor.out" "$JOURNEY_TMP/logs/status.log" 2>/dev/null \
    | grep -c "$1" || true
}

journey_start_monitor
journey_wait_until "$ISSUE" 5  "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

# Budgets are monitor ticks (passes), not seconds.
journey_wait_until "$ISSUE" 5  "task launched into planning"          phase_is planning
journey_wait_until "$ISSUE" 8  "coding launched"                      phase_is coding
journey_wait_until "$ISSUE" 8  "review launched"                      phase_is review
journey_wait_until "$ISSUE" 10 "red CI made Ready launch remediation" remediation_launched
RED_HEAD="${CI_LAST%%/*}"
journey_wait_until "$ISSUE" 8  "remediation pushed a green head"      fix_pushed
journey_wait_until "$ISSUE" 15 "PR merged by tend after the fix"      pr_merged
journey_wait_until "$ISSUE" 8  "task reaped after merge"              journey_task_reaped "$ISSUE"

echo ""
echo "assertions:"
journey_assert "exactly one remediation launched (one budget unit for the red head)" \
  test "$(remediation_launches)" = "1"
journey_assert "the remediation prompt carried the failing check" \
  grep -q "unit-tests" "$FAKE_ROOT/remediation-prompt-2.txt"
journey_assert "Ready logged the remediation launch" \
  bash -c '(( $1 >= 1 ))' _ "$(mill_log_count "Launched ready remediation (attempt 1/")"
journey_assert "no 'Ready remediation exhausted' at any point" \
  test "$(mill_log_count "Ready remediation exhausted")" = "0"
journey_assert "the red head never merged (merge commit carries the fix)" \
  bash -c 'git --git-dir "$1" show "refs/heads/$2:journey-output.txt" | grep -qx "$3"' \
    _ "$FAKE_GH_ORIGIN" "$JOURNEY_INTEGRATION_BRANCH" "$FIX_LINE"
journey_assert "the PR merged at a head other than the red one" \
  bash -c '[[ -n "$1" && "$(jq -r ".prs[\"1\"].headRefOid // empty" "$2")" != "$1" ]]' _ "$RED_HEAD" "$FAKE_GH_STATE"
journey_assert_landed "$ISSUE"

journey_finish
