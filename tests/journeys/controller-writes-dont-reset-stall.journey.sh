#!/usr/bin/env bash
# HOK-3422 incident replay: a Ready remediation goes silent with no hook or
# stop event while the controller continues refreshing .ready-result.json.
# The shared agent stall clock must settle it, launch one replacement, and
# let current-head green CI merge the task without an operator intervention.
# The fixture skews only progress-reader clocks, using the existing journey
# clock seam; no production timeout or retry budget is changed.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP controller-writes-dont-reset-stall journey: $reason"
  exit 0
fi

ISSUE="JRN-42"
# Before journey_init: the tmux server (and so every agent pane) inherits the
# environment at init.
export FAKE_AGENT_SCRIPT_DIR
FAKE_AGENT_SCRIPT_DIR="$(cd "$(dirname "$0")/fixtures/controller-writes-dont-reset-stall/fake-agent" && pwd)"
journey_init controller-writes-dont-reset-stall
export NODE_OPTIONS="--import=$FAKE_AGENT_SCRIPT_DIR/../progress-clock.mjs $NODE_OPTIONS"
# Ready remediation relaunches the task's recorded coder (task_launch_model);
# pin one the way an operator's `--coder-model` does (see ready-fail-remediate).
export WAVEMILL_CODER_MODEL="claude-opus-4-7"
fakes_linear_add_issue "$ISSUE" "Change whose first CI run flakes" Todo

# ── fake CI ────────────────────────────────────────────────────────────────
# Every write holds the gh fake's own state lock, the same lock the
# remediation agent takes for its rerun, and the rerun marker is read under
# it: a verdict computed before the rerun can never overwrite the rerun's
# SUCCESS.

ci_set_pr1() {
  fakes_gh_state '.checks.byPr["1"] = [{name: "unit-tests", conclusion: $c}]' --arg c "$1"
}

CI_LAST=""
ci_tick() {
  local head conclusion
  head="$(jq -r '.prs["1"].headRefName // empty' "$FAKE_GH_STATE" 2>/dev/null)"
  [[ -n "$head" ]] || return 0
  head="$(git --git-dir "$FAKE_GH_ORIGIN" rev-parse -q --verify "refs/heads/$head" 2>/dev/null)" || return 0
  fakes_gh_state_lock
  conclusion=FAILURE
  [[ -e "$FAKE_ROOT/ci-rerun-$head" ]] && conclusion=SUCCESS
  if [[ "$head/$conclusion" != "$CI_LAST" ]]; then
    ci_set_pr1 "$conclusion"
    CI_LAST="$head/$conclusion"
    journey_log "fake CI: ${head:0:7} → $conclusion"
  fi
  fakes_gh_state_unlock
}

fakes_gh_state_lock; ci_set_pr1 FAILURE; fakes_gh_state_unlock

# ── observation ────────────────────────────────────────────────────────────
phase_is() { ci_tick; [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
remediation_launches() { grep -c "phase=coding issue=$ISSUE role=ready-remediation$" "$FAKE_AGENT_LOG" 2>/dev/null || true; }
remediation_launched() { ci_tick; [[ "$(remediation_launches)" -ge 1 ]]; }
ci_rerun_green() { ci_tick; [[ "$CI_LAST" == */SUCCESS ]]; }
pr_merged() { ci_tick; journey_pr_merged; }
mill_log_count() {
  sed 's/\x1b\[[0-9;]*[A-Za-z]//g' "$JOURNEY_TMP/logs/mill.log" "$JOURNEY_TMP/logs/status.log" 2>/dev/null \
    | grep -c "$1" || true
}

journey_start_monitor
journey_set_tick_budget 85
journey_wait_until "$ISSUE" 5  "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

# Budgets are monitor ticks (passes), not seconds.
journey_wait_until "$ISSUE" 5  "task launched into planning"          phase_is planning
journey_wait_until "$ISSUE" 8  "coding launched"                      phase_is coding
journey_wait_until "$ISSUE" 8  "review launched"                      phase_is review
journey_wait_until "$ISSUE" 10 "red CI made Ready launch remediation" remediation_launched
RED_HEAD="${CI_LAST%%/*}"
journey_wait_until "$ISSUE" 8  "replacement fixed CI" ci_rerun_green
journey_wait_until "$ISSUE" 15 "PR merged by tend after replacement repair"    pr_merged
journey_wait_until "$ISSUE" 8  "task reaped after merge"              journey_task_reaped "$ISSUE"

echo ""
echo "assertions:"
journey_assert "controller refreshes did not prevent agent-stalled settlement" \
  bash -c '(( $1 >= 1 ))' _ "$(mill_log_count "Ready remediation settled at ${RED_HEAD:0:7} (agent-stalled)")"
journey_assert "the stalled remediation was replaced exactly once" \
  test "$(remediation_launches)" = "2"
journey_assert "replacement committed the repair after the stalled head" \
  bash -c '[[ -n "$1" && "$(jq -r ".prs[\"1\"].headRefOid // empty" "$2")" != "$1" ]]' _ "$RED_HEAD" "$FAKE_GH_STATE"
journey_assert "no remediation or pending-ready exhaustion at any point" \
  test "$(( $(mill_log_count "Ready remediation exhausted") + $(mill_log_count "Pending-ready re-checks exhausted") ))" = "0"
journey_assert_landed "$ISSUE"
journey_assert_session_ownership "$ISSUE" planning coding review ready-remediation ready-remediation

journey_finish
