#!/usr/bin/env bash
# Regression tests for pane hygiene at phase launch (HOK-2921):
#   - REQ-F3: _launch_agent_in_pane prepares the pane BEFORE sending the
#     WAVEMILL_* export line, so send-keys never types into a live REPL.
#   - REQ-F4: reap_completed_planning_pane terminates a planning agent that
#     wrote its completion marker but kept running, and is a no-op when the
#     pane is idle or the foreground command is an operator shell.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"
ADAPTERS_SCRIPT_FILE="$REPO_DIR/shared/lib/agent-adapters.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

check_eq() {
  local name="$1" actual="$2" expected="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass "$name"
  else
    echo "    expected: $expected"
    echo "    actual:   $actual"
    fail "$name"
  fi
}

check_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$name"
  else
    echo "    missing: $needle"
    fail "$name"
  fi
}

check_not_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    pass "$name"
  else
    echo "    unexpected: $needle"
    fail "$name"
  fi
}

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

extract_function() {
  local source_file="$1"
  local function_name="$2"
  awk -v name="$function_name" '
    $0 ~ "^" name "\\(\\) \\{" { capture=1 }
    capture { print }
    capture && $0 == "}" { exit }
  ' "$source_file"
}

FUNC_FILE="$TEST_TMP/pane_liveness_funcs.sh"
extract_function "$MONITOR_SCRIPT_FILE" "_launch_agent_in_pane" > "$FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "reap_completed_planning_pane" >> "$FUNC_FILE"
cat "$REPO_DIR/shared/lib/terminal-backend.sh" >> "$FUNC_FILE"
extract_function "$ADAPTERS_SCRIPT_FILE" "_pane_command_is_shell" >> "$FUNC_FILE"

for fn in _launch_agent_in_pane reap_completed_planning_pane _tmux_target_join _pane_command_is_shell; do
  if ! grep -q "${fn}()" "$FUNC_FILE"; then
    echo "Could not extract ${fn}()"
    exit 1
  fi
done

# shellcheck source=/dev/null
source "$FUNC_FILE"

SESSION="pane-liveness-test"
WORKTREE_ROOT="$TEST_TMP/worktrees"
STATE_FILE=""

# --- stubs -------------------------------------------------------------------
reset_capture() {
  CALL_LOG=""
  EXPORT_SEND_COUNT=0
  EXPORT_BEFORE_READY=0
  PANE_READY=0
  PREPARE_RC=0
  TERMINATE_CALLS=0
  TERMINATE_RC=0
  LOG_OUTPUT=""
  PANE_IDLE=1
  PANE_FG_CMD="zsh"
  WINDOW_TARGET="@7"
}

tmux() {
  local joined="$*"
  CALL_LOG+="tmux:$1"$'\n'
  if [[ "$joined" == *"send-keys"* && "$joined" == *"export WAVEMILL_SESSION"* ]]; then
    EXPORT_SEND_COUNT=$((EXPORT_SEND_COUNT + 1))
    if [[ "$PANE_READY" != "1" ]]; then
      EXPORT_BEFORE_READY=$((EXPORT_BEFORE_READY + 1))
    fi
  fi
  return 0
}

agent_prepare_pane_for_launch() {
  CALL_LOG+="prepare:$1:$2"$'\n'
  if [[ "$PREPARE_RC" -eq 0 ]]; then
    # Simulate the busy agent being terminated: the pane only becomes safe
    # for send-keys once prepare has completed.
    PANE_READY=1
  fi
  return "$PREPARE_RC"
}

agent_launch_interactive() {
  CALL_LOG+="launch:$1:$2"$'\n'
  return 0
}

_tmux_task_window_target() { printf '%s\n' "$WINDOW_TARGET"; }
_pane_is_dead_or_idle() { [[ "$PANE_IDLE" == "1" ]]; }
_pane_current_command() { printf '%s\n' "$PANE_FG_CMD"; }
agent_terminate_in_pane() {
  TERMINATE_CALLS=$((TERMINATE_CALLS + 1))
  CALL_LOG+="terminate:$1:$2"$'\n'
  return "$TERMINATE_RC"
}
log() { LOG_OUTPUT+="$*"$'\n'; }
log_warn() { LOG_OUTPUT+="WARN:$*"$'\n'; }

# --- REQ-F3: pane is prepared before the export send-keys --------------------
reset_capture
PANE_READY=0
rc=0
_launch_agent_in_pane "$SESSION:win1" "codex" "gpt-5.4" "$TEST_TMP/prompt.txt" "slug" "HOK-1" || rc=$?
check_eq "idle pane: launch returns 0" "$rc" "0"
check_eq "export send-keys fires exactly once" "$EXPORT_SEND_COUNT" "1"
check_eq "no export sent while pane is busy" "$EXPORT_BEFORE_READY" "0"
prepare_line=$(printf '%s' "$CALL_LOG" | grep -n '^prepare:' | head -1 | cut -d: -f1)
export_line=$(printf '%s' "$CALL_LOG" | grep -n '^tmux:send-keys' | head -1 | cut -d: -f1)
launch_line=$(printf '%s' "$CALL_LOG" | grep -n '^launch:' | head -1 | cut -d: -f1)
if [[ -n "$prepare_line" && -n "$export_line" && "$prepare_line" -lt "$export_line" ]]; then
  pass "prepare ordered before export send-keys"
else
  echo "    call log: $CALL_LOG"
  fail "prepare ordered before export send-keys"
fi
if [[ -n "$export_line" && -n "$launch_line" && "$export_line" -lt "$launch_line" ]]; then
  pass "export ordered before agent launch"
else
  echo "    call log: $CALL_LOG"
  fail "export ordered before agent launch"
fi

# --- REQ-F3: abort during prepare short-circuits the launch ------------------
reset_capture
PREPARE_RC=2
rc=0
_launch_agent_in_pane "$SESSION:win1" "codex" "gpt-5.4" "$TEST_TMP/prompt.txt" "slug" "HOK-1" || rc=$?
check_eq "aborted prepare propagates rc 2" "$rc" "2"
check_eq "aborted prepare sends no export" "$EXPORT_SEND_COUNT" "0"
check_not_contains "aborted prepare never launches the agent" "$CALL_LOG" "launch:"

# --- REQ-F4: reap terminates a lingering planning agent ----------------------
reset_capture
PANE_IDLE=0
PANE_FG_CMD="codex"
FEATURE_DIR="$TEST_TMP/worktrees/slug/features/slug"
mkdir -p "$FEATURE_DIR"
rc=0
reap_completed_planning_pane "HOK-2" "$FEATURE_DIR" "$TEST_TMP/worktrees/slug" || rc=$?
check_eq "reap returns 0" "$rc" "0"
check_eq "reap terminates the lingering agent" "$TERMINATE_CALLS" "1"
check_contains "reap targets the task window" "$CALL_LOG" "terminate:$SESSION:@7"
check_contains "reap logs the foreground command" "$LOG_OUTPUT" "codex"

# --- REQ-F4: reap is a no-op when the foreground command is a shell ----------
reset_capture
PANE_IDLE=0
PANE_FG_CMD="zsh"
rc=0
reap_completed_planning_pane "HOK-2" "$FEATURE_DIR" "$TEST_TMP/worktrees/slug" || rc=$?
check_eq "shell foreground: reap returns 0" "$rc" "0"
check_eq "shell foreground: no termination issued" "$TERMINATE_CALLS" "0"

# --- REQ-F4: reap is a no-op on an idle pane ---------------------------------
reset_capture
PANE_IDLE=1
PANE_FG_CMD="codex"
rc=0
reap_completed_planning_pane "HOK-2" "$FEATURE_DIR" "$TEST_TMP/worktrees/slug" || rc=$?
check_eq "idle pane: reap returns 0" "$rc" "0"
check_eq "idle pane: no termination issued" "$TERMINATE_CALLS" "0"

# --- REQ-F4: failed termination never blocks the transition ------------------
reset_capture
PANE_IDLE=0
PANE_FG_CMD="codex"
TERMINATE_RC=1
rc=0
reap_completed_planning_pane "HOK-2" "$FEATURE_DIR" "$TEST_TMP/worktrees/slug" || rc=$?
check_eq "failed termination still returns 0" "$rc" "0"
check_contains "failed termination logs a warning" "$LOG_OUTPUT" "WARN:"

# --- REQ-F4: the reap is a shell-overridable seam (tests may disable it) -----
reset_capture
PANE_IDLE=0
PANE_FG_CMD="codex"
reap_completed_planning_pane() { return 0; }
rc=0
reap_completed_planning_pane "HOK-2" "$FEATURE_DIR" "$TEST_TMP/worktrees/slug" || rc=$?
check_eq "overridden seam: reap returns 0" "$rc" "0"
check_eq "overridden seam: no termination issued" "$TERMINATE_CALLS" "0"

echo ""
echo "launch-pane-liveness: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
