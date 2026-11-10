#!/usr/bin/env bash
# wavemill-test-suite: none (ran in no suite before HOK-3466; run it or delete it)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

source "$REPO_DIR/shared/lib/wavemill-common.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

check_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$name"
  else
    echo "    expected: $expected"
    echo "    actual:   $actual"
    fail "$name"
  fi
}

check_starts_with() {
  local name="$1" value="$2" prefix="$3"
  if [[ "$value" == "$prefix"* ]]; then
    pass "$name"
  else
    echo "    expected prefix: $prefix"
    echo "    actual: $value"
    fail "$name"
  fi
}

echo "=== Task ID Log Prefix ==="

line="$(wavemill_task_log_message "HOK-113" "⛔ HOK-113 → Workflow aborted by user during planning phase")"
check_starts_with "emoji message is prefixed" "$line" "[HOK-113]  ⛔"

line="$(wavemill_task_log_message "HOK-113" "Launching planning phase for HOK-113 (model: claude-sonnet-4-6, depth: light, mode: normal)")"
check_starts_with "text message is prefixed" "$line" "[HOK-113]  Launching planning phase"

line="$(wavemill_task_log_message "HOK-113" "📊 Eval queued in background")"
check_eq "eval queued message is prefixed" "[HOK-113]  📊 Eval queued in background" "$line"

if [[ "$line" == *"]  📊"* ]]; then
  pass "two-space separator preserved"
else
  fail "two-space separator preserved"
fi

line="$(wavemill_task_log_message "" "Session started")"
check_eq "empty task id remains unprefixed" "Session started" "$line"

line="$(wavemill_task_log_message "HOK-113" "[HOK-113]  Already prefixed")"
check_eq "already bracket-prefixed message not doubled" "[HOK-113]  Already prefixed" "$line"

line="$(wavemill_task_log_message "HOK-113" "HOK-113 → Already starts with task")"
check_eq "already task-starting message not doubled" "HOK-113 → Already starts with task" "$line"

# Extract directly for stability in this shell process.
eval "$(awk '
  /^log_error\(\) \{/ { capture=1 }
  capture { print }
  capture && /^}/ { exit }
' "$REPO_DIR/shared/lib/wavemill-mill.sh")"
eval "$(awk '
  /^log_warn\(\) \{/ { capture=1 }
  capture { print }
  capture && /^}/ { exit }
' "$REPO_DIR/shared/lib/wavemill-mill.sh")"

append_status_log() { printf '%s\n' "$1"; }
error_line="$(log_error "HOK-113 exploded")"
warn_line="$(log_warn "HOK-113 warning")"

if [[ "$error_line" == *"[HOK-113]"* || "$warn_line" == *"[HOK-113]"* ]]; then
  fail "ERROR/WARN do not receive task prefix"
else
  pass "ERROR/WARN do not receive task prefix"
fi

echo ""
echo "Passed: $PASS"
echo "Failed: $FAIL"
[[ "$FAIL" -eq 0 ]]
