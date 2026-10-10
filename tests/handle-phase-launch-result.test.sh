#!/usr/bin/env bash
# Regression tests for the bounded phase-launch retry path (HOK-2924 /
# HOK-2921): handle_phase_launch_result counts failures against the
# phase-launch-<phase> bucket and phase_launch_gate enforces backoff, the
# ceiling (terminalizing the task), head-keyed reset, and the terminal-cause
# short-circuit.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

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

FUNC_FILE="$TEST_TMP/handle_phase_launch_result.sh"
cat "$REPO_DIR/shared/lib/bounded-retry.sh" > "$FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "phase_launch_head" >> "$FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "phase_launch_base" >> "$FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "phase_launch_gate" >> "$FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "handle_phase_launch_result" >> "$FUNC_FILE"

if ! grep -q "handle_phase_launch_result()" "$FUNC_FILE"; then
  echo "Could not extract handle_phase_launch_result()"
  exit 1
fi

# shellcheck source=/dev/null
source "$FUNC_FILE"

SESSION="phase-launch-test"

# --- stubs -------------------------------------------------------------------
GIT_HEAD="sha-aaa"
CHALLENGE_ABORT_MATCHES="false"

reset_capture() {
  WRITE_STAGE_CALLS=""
  CLEAR_STAGE_CALLS=""
  SET_PHASE_TO=""
  ATTENTION_STATE=""
  LOG_OUTPUT=""
}

git() {
  if [[ "${1:-}" == "-C" && "${3:-}" == "rev-parse" ]]; then
    printf "%s\n" "$GIT_HEAD"
    return 0
  fi
  return 1
}
log() { LOG_OUTPUT+="$*"$'\n'; }
log_warn() { LOG_OUTPUT+="WARN:$*"$'\n'; }
log_task() { LOG_OUTPUT+="$*"$'\n'; }
log_native_launch_preflight_detail() { return 0; }
challenge_abort_for_native_preflight_varied_model() {
  [[ "$CHALLENGE_ABORT_MATCHES" == "true" ]]
}
write_stage_result() {
  WRITE_STAGE_CALLS+="${1-}|${2-}|${3-}|${4-}|${5-}|${6-}"$'\n'
}
clear_stage_result() { CLEAR_STAGE_CALLS+="${1-}|${2-}"$'\n'; }
set_task_phase() { SET_PHASE_TO="$2"; }
set_window_attention_state() { ATTENTION_STATE="$2"; }
check_stage_aborted() { return 1; }

fresh_feature_dir() {
  local dir="$TEST_TMP/$1/wt/features/slug"
  mkdir -p "$dir"
  echo "$dir"
}

# --- failure increments the bucket and reverts for retry ---------------------
reset_capture
FEATURE_DIR="$(fresh_feature_dir failure_counts)"
if handle_phase_launch_result "HOK-1" "$FEATURE_DIR" "coding" "planning" 1 "@1" "codex" "gpt-5.4"; then
  fail "failed launch returns 1"
else
  pass "failed launch returns 1"
fi
check_eq "failed launch counts attempt 1" "$(bounded_retry_count "$FEATURE_DIR" phase-launch-coding)" "1"
check_eq "failed launch keys the head" "$(bounded_retry_head "$FEATURE_DIR" phase-launch-coding)" "sha-aaa"
check_contains "failed launch reverts phase" "$SET_PHASE_TO" "planning"
check_contains "failed launch clears stage result" "$CLEAR_STAGE_CALLS" "|coding"
check_contains "failed launch logs the attempt number" "$LOG_OUTPUT" "attempt 1"

# --- backoff: gate holds the relaunch inside the window ----------------------
reset_capture
if phase_launch_gate "HOK-1" "$FEATURE_DIR" "coding" "@1"; then
  fail "gate holds relaunch during backoff"
else
  pass "gate holds relaunch during backoff"
fi
check_contains "gate logs the backoff hold" "$LOG_OUTPUT" "holding coding launch retry (backoff)"
check_eq "backoff hold does not terminalize" "$SET_PHASE_TO" ""

# --- success clears the bucket ----------------------------------------------
reset_capture
if handle_phase_launch_result "HOK-1" "$FEATURE_DIR" "coding" "planning" 0 "@1" "codex" "gpt-5.4"; then
  pass "successful launch returns 0"
else
  fail "successful launch returns 0"
fi
check_eq "successful launch clears the bucket" "$(bounded_retry_count "$FEATURE_DIR" phase-launch-coding)" "0"
if phase_launch_gate "HOK-1" "$FEATURE_DIR" "coding" "@1"; then
  pass "gate proceeds after a successful launch"
else
  fail "gate proceeds after a successful launch"
fi

# --- ceiling: repeated failures at the same head terminalize -----------------
reset_capture
FEATURE_DIR="$(fresh_feature_dir ceiling)"
for _ in 1 2 3 4; do
  handle_phase_launch_result "HOK-2" "$FEATURE_DIR" "coding" "planning" 1 "@2" "codex" "gpt-5.4" || true
  # Age the last attempt so the ceiling (not the backoff window) decides.
  printf '%s\n' "0" > "$FEATURE_DIR/.retry-phase-launch-coding-last-at"
done
check_eq "four failures recorded" "$(bounded_retry_count "$FEATURE_DIR" phase-launch-coding)" "4"
reset_capture
if phase_launch_gate "HOK-2" "$FEATURE_DIR" "coding" "@2"; then
  fail "gate refuses launch at the ceiling"
else
  pass "gate refuses launch at the ceiling"
fi
check_eq "ceiling terminalizes the task" "$SET_PHASE_TO" "aborted"
check_contains "ceiling writes failed stage result" "$WRITE_STAGE_CALLS" "|coding|failed|"
check_contains "ceiling records greppable reason" "$WRITE_STAGE_CALLS" "Coding launch retries exhausted after 4 attempt(s)"
check_contains "ceiling logs terminal status" "$LOG_OUTPUT" "launch retries exhausted"
check_eq "ceiling flags needs-user" "$ATTENTION_STATE" "needs-user"
check_eq "ceiling reason is stored in the sentinel" \
  "$(bounded_retry_exhaustion_reason "$FEATURE_DIR" phase-launch-coding)" \
  "Coding launch retries exhausted after 4 attempt(s) at head sha-aaa"
reset_capture
if phase_launch_gate "HOK-2" "$FEATURE_DIR" "coding" "@2"; then
  fail "gate stays closed after terminalization"
else
  pass "gate stays closed after terminalization"
fi
check_eq "quiet hold does not re-log terminal status" "$LOG_OUTPUT" ""
check_eq "quiet hold still flags needs-user" "$ATTENTION_STATE" "needs-user"

# --- reset on new head re-enables the full budget ----------------------------
reset_capture
GIT_HEAD="sha-bbb"
if phase_launch_gate "HOK-2" "$FEATURE_DIR" "coding" "@2"; then
  pass "new head re-opens the gate"
else
  fail "new head re-opens the gate"
fi
check_eq "new head clears the counter" "$(bounded_retry_count "$FEATURE_DIR" phase-launch-coding)" "0"
if bounded_retry_is_exhausted "$FEATURE_DIR" phase-launch-coding; then
  fail "new head clears the exhausted sentinel"
else
  pass "new head clears the exhausted sentinel"
fi
GIT_HEAD="sha-aaa"

# --- terminal cause short-circuits without consuming attempts ----------------
reset_capture
FEATURE_DIR="$(fresh_feature_dir terminal_cause)"
CHALLENGE_ABORT_MATCHES="true"
if handle_phase_launch_result "HOK-3" "$FEATURE_DIR" "coding" "planning" 1 "@3" "native" "varied-model"; then
  fail "terminal cause returns 1"
else
  pass "terminal cause returns 1"
fi
CHALLENGE_ABORT_MATCHES="false"
check_eq "terminal cause consumes no attempts" "$(bounded_retry_count "$FEATURE_DIR" phase-launch-coding)" "0"
check_contains "terminal cause records the reason" \
  "$(bounded_retry_exhaustion_reason "$FEATURE_DIR" phase-launch-coding)" \
  "varied model cannot pass native preflight"
check_eq "terminal cause skips the revert dance" "$CLEAR_STAGE_CALLS" ""
reset_capture
if phase_launch_gate "HOK-3" "$FEATURE_DIR" "coding" "@3"; then
  fail "gate holds quietly after a terminal cause"
else
  pass "gate holds quietly after a terminal cause"
fi
check_eq "terminal hold flags needs-user" "$ATTENTION_STATE" "needs-user"

# --- each phase gets its own isolated bucket ---------------------------------
reset_capture
FEATURE_DIR="$(fresh_feature_dir isolation)"
handle_phase_launch_result "HOK-4" "$FEATURE_DIR" "planning" "routing" 1 "@4" || true
handle_phase_launch_result "HOK-4" "$FEATURE_DIR" "coding" "planning" 1 "@4" || true
handle_phase_launch_result "HOK-4" "$FEATURE_DIR" "coding" "planning" 1 "@4" || true
handle_phase_launch_result "HOK-4" "$FEATURE_DIR" "review" "coding" 1 "@4" || true
check_eq "planning bucket isolated" "$(bounded_retry_count "$FEATURE_DIR" phase-launch-planning)" "1"
check_eq "coding bucket isolated" "$(bounded_retry_count "$FEATURE_DIR" phase-launch-coding)" "2"
check_eq "review bucket isolated" "$(bounded_retry_count "$FEATURE_DIR" phase-launch-review)" "1"
handle_phase_launch_result "HOK-4" "$FEATURE_DIR" "coding" "planning" 0 "@4" || true
check_eq "coding success leaves planning bucket" "$(bounded_retry_count "$FEATURE_DIR" phase-launch-planning)" "1"
check_eq "coding success clears only coding bucket" "$(bounded_retry_count "$FEATURE_DIR" phase-launch-coding)" "0"

echo ""
echo "handle-phase-launch-result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
