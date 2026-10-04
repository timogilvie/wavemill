#!/usr/bin/env bash
# Regression tests for launch stderr capture (HOK-2921 / REQ-F5):
# _run_phase_launch wraps the launch_*_phase calls, replays captured stderr
# to the caller, and on a non-zero exit surfaces the tail of the real error
# text through log_warn instead of only ERR-trap line numbers.
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

FUNC_FILE="$TEST_TMP/run_phase_launch.sh"
extract_function "$MONITOR_SCRIPT_FILE" "_run_phase_launch" > "$FUNC_FILE"

if ! grep -q "_run_phase_launch()" "$FUNC_FILE"; then
  echo "Could not extract _run_phase_launch()"
  exit 1
fi

# shellcheck source=/dev/null
source "$FUNC_FILE"

WARN_LOG=""
log_warn() { WARN_LOG+="$*"$'\n'; }
reset_capture() { WARN_LOG=""; }

stub_launch_ok() {
  echo "launcher ready" >&2
  return 0
}

stub_launch_fail() {
  echo "Error: invalid model selector 'gpt-5.6-terra' for codex" >&2
  return 1
}

stub_launch_fail_long() {
  local i
  for i in $(seq 1 30); do
    echo "stderr line $i" >&2
  done
  return 1
}

stub_launch_fail_silent() {
  return 3
}

# --- success: stderr replayed, no warn line ----------------------------------
reset_capture
rc=0
replay="$TEST_TMP/replay-ok.txt"
_run_phase_launch planning stub_launch_ok 2>"$replay" || rc=$?
check_eq "successful launch returns 0" "$rc" "0"
check_eq "successful launch emits no warn line" "$WARN_LOG" ""
check_contains "successful launch replays stderr to caller" "$(cat "$replay")" "launcher ready"

# --- failure: warn line carries the real error text --------------------------
reset_capture
rc=0
_run_phase_launch coding stub_launch_fail 2>/dev/null || rc=$?
check_eq "failed launch preserves rc" "$rc" "1"
check_contains "failed launch warn carries real error" "$WARN_LOG" "Error: invalid model selector 'gpt-5.6-terra' for codex"
check_contains "failed launch warn names the phase" "$WARN_LOG" "coding-launch stderr:"

# --- failure: stderr is still replayed to the caller -------------------------
reset_capture
rc=0
replay="$TEST_TMP/replay-fail.txt"
_run_phase_launch coding stub_launch_fail 2>"$replay" || rc=$?
check_contains "failed launch replays stderr to caller" "$(cat "$replay")" "invalid model selector"

# --- failure: only the last 20 lines survive in the warn ---------------------
reset_capture
rc=0
_run_phase_launch review stub_launch_fail_long 2>/dev/null || rc=$?
check_eq "long stderr preserves rc" "$rc" "1"
warn_lines=$(printf '%s' "$WARN_LOG" | grep -c "review-launch stderr:" || true)
check_eq "long stderr truncated to 20 lines" "$warn_lines" "20"
check_contains "long stderr keeps the tail" "$WARN_LOG" "stderr line 30"
if [[ "$WARN_LOG" == *"stderr line 5"$'\n'* || "$WARN_LOG" == *"stderr line 5 "* ]]; then
  fail "long stderr drops the head"
else
  pass "long stderr drops the head"
fi

# --- failure with empty stderr: rc preserved, no warn line -------------------
reset_capture
rc=0
_run_phase_launch coding stub_launch_fail_silent 2>/dev/null || rc=$?
check_eq "silent failure preserves rc" "$rc" "3"
check_eq "silent failure emits no warn line" "$WARN_LOG" ""

echo ""
echo "launch-failure-log-capture: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
