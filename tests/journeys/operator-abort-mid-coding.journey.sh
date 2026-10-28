#!/usr/bin/env bash
# Golden journey: the operator aborts a task while its coder is mid-stage and
# the mill tears it down cleanly.
#
# Protects against: an operator abort (`wavemill abort <issue>`) that leaves a
# live agent pane behind, relaunches coding on the next pass (the monitor
# reading the dead pane as a crash), opens or merges a PR, moves Linear to
# Done, or loses the coder's committed-but-unpushed work.
#
# The coder has committed locally but pushed nothing, so the real policy is:
# pane killed, slot released, row terminal `aborted`, and the worktree + local
# branch retained (cleanup records `remote_missing_local_head`) until the
# operator pushes or abandons the work. A PR-less task with no local commits
# would be reaped outright; that is the easy half and not what wedged the mill.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP operator-abort-mid-coding journey: $reason"
  exit 0
fi

ISSUE="JRN-6"
# Before journey_init: the tmux server (and so every agent pane) inherits the
# environment at init.
export FAKE_AGENT_SCRIPT_DIR
FAKE_AGENT_SCRIPT_DIR="$(cd "$(dirname "$0")/fixtures/operator-abort-mid-coding/fake-agent" && pwd)"
journey_init operator-abort-mid-coding
fakes_linear_add_issue "$ISSUE" "Task the operator aborts mid-coding" Todo

journey_start_monitor
# journey_quiet_ticks <n>: let n monitor passes go by with the operator roles
# still running (unlike journey_wait_until, reaching the end is success).
journey_quiet_ticks() {
  local until_tick=$(( $(journey_tick) + $1 ))
  local safety_deadline=$(( $(journey_now) + ${JOURNEY_WAIT_SAFETY_SECONDS:-300} ))
  while (( $(journey_tick) < until_tick )); do
    kill -0 "$JOURNEY_MONITOR_PID" 2>/dev/null || journey_fail "monitor exited during the quiet period"
    (( $(journey_now) <= safety_deadline )) || journey_fail "monitor made no progress during the quiet period"
    journey_record_timeline "$ISSUE"
    journey_operator_tick "$ISSUE"
    sleep 0.2
  done
  journey_log "quiet for $1 ticks (tick $(journey_tick))"
}

journey_wait_until "$ISSUE" 5  "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
coder_busy() { [[ -f "$FAKE_ROOT/coding-busy-$ISSUE" ]]; }
coding_launches() { grep -c "phase=coding issue=$ISSUE role=mid-coding pid=" "$FAKE_AGENT_LOG" 2>/dev/null || true; }
coder_pid() { sed -n "s/.*phase=coding issue=$ISSUE role=mid-coding pid=\([0-9]*\).*/\1/p" "$FAKE_AGENT_LOG" | tail -1; }
# The mill renames task windows to a display title ("6 · <slug> · code"), so
# match on the slug ($SLUG, captured once coding starts). Captured first:
# under pipefail, grep -q closing the pipe early would SIGPIPE tmux.
task_window_open() {
  local windows
  windows="$(tmux list-windows -t "$SESSION" -F '#W' 2>/dev/null || true)"
  grep -qF "$SLUG" <<<"$windows"
}
window_closed() { ! task_window_open; }

journey_wait_until "$ISSUE" 5 "task launched into planning"   phase_is planning
journey_wait_until "$ISSUE" 8 "coding launched"               phase_is coding
journey_wait_until "$ISSUE" 8 "coder committed and is busy"   coder_busy

SLUG="$(journey_task_field "$ISSUE" slug)"
WT="$(journey_task_field "$ISSUE" worktree)"
WT="${WT:-$WORKTREE_ROOT/$SLUG}"
BRANCH="$(journey_task_field "$ISSUE" branch)"
BRANCH="${BRANCH:-task/$SLUG}"
WIP_SHA="$(git -C "$WT" rev-parse HEAD)"
PID="$(coder_pid)"
if [[ -z "$PID" ]] || ! kill -0 "$PID" 2>/dev/null; then
  journey_fail "coder process not alive before the abort (journey would pass vacuously)"
fi
task_window_open || journey_fail "coder window not open before the abort (journey would pass vacuously)"

# The operator's abort, exactly as typed at a shell.
journey_log "operator: wavemill abort $ISSUE"
bash "$JOURNEY_INSTALL_DIR/wavemill" abort "$ISSUE" --repo-dir "$REPO_DIR" --reason "journey: operator stop" \
  > "$JOURNEY_TMP/logs/abort.out" 2>&1 || journey_fail "wavemill abort failed: $(tail -5 "$JOURNEY_TMP/logs/abort.out")"

journey_wait_until "$ISSUE" 5 "mill closed the coder's window" window_closed
# Quiet period: nothing may relaunch, reopen or recreate the task.
journey_quiet_ticks 4

retention_reason() {
  jq -r --arg i "$ISSUE" 'first(.tasks[$i] | .. | objects | select(has("retention")) | .retention.reason) // empty' "$STATE_FILE" 2>/dev/null
}

echo ""
echo "assertions:"
journey_assert "the coder process was killed with its pane" bash -c '! kill -0 "$1" 2>/dev/null' _ "$PID"
journey_assert "no task window left open" window_closed
journey_assert "coding launched exactly once (never relaunched after the abort)" test "$(coding_launches)" = "1"
journey_assert "the task never left aborted once aborted (timeline ends aborted/aborted)" \
  bash -c '[[ "$1" == *"coding/active → aborted/aborted" ]]' _ "$JOURNEY_TIMELINE"
journey_assert "task row is terminal aborted with the operator's reason" \
  test "$(journey_task_field "$ISSUE" phase)/$(journey_task_field "$ISSUE" status)/$(journey_task_field "$ISSUE" abortedReason)" \
    = "aborted/aborted/journey: operator stop"
journey_assert "the row is the original task, not a recreated stub (slug kept, one row)" \
  test "$(journey_task_field "$ISSUE" slug)/$(jq -r '.tasks | length' "$STATE_FILE")" = "$SLUG/1"
journey_assert "slot released (freeSlots == MAX_PARALLEL)" test "$(jq -r '.freeSlots // empty' "$STATE_FILE")" = "1"
# Unpushed committed work is never deleted by an abort: cleanup retains the
# worktree and branch, and records why on the row for the operator.
journey_assert "cleanup retained the unpushed work and recorded why" test "$(retention_reason)" = "remote_missing_local_head"
journey_assert "worktree preserved at the coder's WIP commit" test "$(git -C "$WT" rev-parse HEAD 2>/dev/null)" = "$WIP_SHA"
journey_assert "local task branch preserved at the WIP commit" \
  test "$(git -C "$REPO_DIR" rev-parse --verify -q "refs/heads/$BRANCH")" = "$WIP_SHA"
journey_assert "nothing pushed: no task branch on origin" \
  bash -c '! git --git-dir "$1" rev-parse --verify -q "refs/heads/$2" >/dev/null' _ "$FAKE_GH_ORIGIN" "$BRANCH"
journey_assert "no PR opened" test "$(jq -r '.prs | length' "$FAKE_GH_STATE")" = "0"
journey_assert "Linear issue not Done (left In Progress)" test "$(fakes_linear_state_of "$ISSUE")" = "In Progress"
journey_assert_no_unhandled_fake_calls

journey_finish
