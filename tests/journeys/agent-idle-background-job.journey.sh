#!/usr/bin/env bash
# Golden journey: the coding agent goes idle while its own background job
# runs, then finishes; the mill waits for it and the task merges with no
# relaunch and no operator touch (HOK-3137).
#
# Protects against: the false owner-lost stamp. An agent that starts its test
# suite in the background ends its turn (Stop hook → idle) while the suite
# keeps running. With no fresh progress the liveness primitive read the agent
# as idle and stalled, so coding_stage_owner_lost stamped the coding stage
# interrupted and parked the task at needs-user, and the agent's genuine
# .coding-complete minutes later was ignored. The fix: a live substantive
# descendant of the agent (its background task) suppresses `stalled` while the
# agent is idle (task-progress.ts deriveAgentBackgroundWork). Since HOK-3374
# that decision is ownership-only — a descendant of the agent counts whatever
# it is named — so the fake agent also spawns a `tools/tend.ts`-named
# descendant (a wavemill-controller argv) that must still read as live.
#
# The idle window is real in the pane — the agent process and its suite stay
# alive across several monitor passes with the hook saying idle/Stop — while
# the primitive's clock is skewed past its 30-minute stall threshold for the
# window (fixtures/agent-idle-background-job/progress-clock.mjs), so the
# owner-lost decision is actually exercised rather than skipped as "not
# stalled yet". Set JOURNEY_BG_CHILD_LAG_SECONDS=99999 to blind the
# background probe and watch the journey fail on the interrupted stamp.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP agent-idle-background-job journey: $reason"
  exit 0
fi

ISSUE="JRN-6"
FIXTURE_DIR="$(cd "$(dirname "$0")/fixtures/agent-idle-background-job" && pwd)"
# Before journey_init: the tmux server (and so every agent pane) inherits the
# environment at init.
export FAKE_AGENT_SCRIPT_DIR="$FIXTURE_DIR/fake-agent"
export JOURNEY_IDLE_TICKS=2
export JOURNEY_IDLE_MIN_SECONDS=10
journey_init agent-idle-background-job
fakes_linear_add_issue "$ISSUE" "Change verified by a background test run" Todo

# Monitor-side knobs (the monitor inherits this shell's environment):
#  - owner-lost / stall checks start 4s after the coding launch instead of 5m,
#    so they run inside the idle window;
#  - a background child counts once it started 1s after the agent (30s in
#    production, where it filters agent start-up services);
#  - the primitive's clock seam.
export WAVEMILL_CODING_OWNER_GRACE_SECONDS=4
export WAVEMILL_BG_CHILD_LAG_SECONDS="${JOURNEY_BG_CHILD_LAG_SECONDS:-1}"
export NODE_OPTIONS="--import=$FIXTURE_DIR/progress-clock.mjs $NODE_OPTIONS"

PROGRESS_CACHE="/tmp/wavemill-${SESSION}-${ISSUE}.progress.json"
SAW_PROTECTED="$JOURNEY_TMP/saw-idle-background-protected"
SAW_INTERRUPTED="$JOURNEY_TMP/saw-coding-interrupted"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }

# Sampled on every poll: what the mill's own liveness read concluded, and
# whether the coding stage was ever stamped interrupted (even if a later
# late-completion reconcile would have papered over it).
sample_coding() {
  local fd
  if jq -e '.agentIdle == true and .agentBackgroundLive == true and .stalled == false and (.progressAgeMinutes // 0) > 30' \
      "$PROGRESS_CACHE" >/dev/null 2>&1; then
    touch "$SAW_PROTECTED"
  fi
  fd="$(journey_feature_dir "$ISSUE" 2>/dev/null)" || return 0
  if jq -e '.artifacts.terminationClass == "interrupted"' "$fd/.coding-result.json" >/dev/null 2>&1; then
    touch "$SAW_INTERRUPTED"
  fi
}
coding_finished() { sample_coding; phase_is review; }

mill_log_count() {
  sed 's/\x1b\[[0-9;]*[A-Za-z]//g' "$JOURNEY_TMP/logs/monitor.out" "$JOURNEY_TMP/logs/status.log" 2>/dev/null \
    | grep -c "$1" || true
}
agent_log_tick() {
  sed -n "s/.*$1.*tick=\([0-9]*\).*/\1/p" "$FAKE_AGENT_LOG" | head -1
}

journey_start_monitor
journey_wait_until "$ISSUE" 5  "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

# Budgets are monitor ticks (passes), not seconds.
journey_wait_until "$ISSUE" 5  "task launched into planning"                 phase_is planning
journey_wait_until "$ISSUE" 8  "coding launched"                             phase_is coding
journey_wait_until "$ISSUE" 12 "agent woke from its idle wait; review began" coding_finished
journey_wait_until "$ISSUE" 15 "PR merged by tend"                           journey_pr_merged
journey_wait_until "$ISSUE" 8  "task reaped after merge"                     journey_task_reaped "$ISSUE"

idle_start="$(agent_log_tick idle-awaiting-background)"
idle_end="$(agent_log_tick background-finished)"

echo ""
echo "assertions:"
journey_assert "the agent sat idle on its background job across >= $JOURNEY_IDLE_TICKS monitor passes" \
  bash -c '[[ -n "$1" && -n "$2" ]] && (( $2 - $1 >= $3 ))' _ "$idle_start" "$idle_end" "$JOURNEY_IDLE_TICKS"
journey_assert "the mill's liveness read saw idle + background-live + past the stall threshold, and did not call it stalled" \
  test -f "$SAW_PROTECTED"
journey_assert "the coding stage was never stamped interrupted" test ! -f "$SAW_INTERRUPTED"
journey_assert "no 'marked interrupted' at any point" \
  test "$(mill_log_count "Coding agent exited without a terminal result")" = "0"
journey_assert "no 'coding stalled' warning at any point" \
  test "$(mill_log_count "coding stalled")" = "0"
journey_assert "exactly one coding launch (no relaunch over the live agent)" \
  test "$(journey_agent_launch_count "$ISSUE" coding)" = "1"
journey_assert "the late .coding-complete was accepted directly, not via late-completion reconcile" \
  test "$(mill_log_count "late_completion_reconciled")" = "0"
journey_assert_landed "$ISSUE"

journey_finish
