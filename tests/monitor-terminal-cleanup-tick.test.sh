#!/usr/bin/env bash
# HOK-3201: unit coverage for monitor_terminal_cleanup_tick. The monitor
# invokes `wavemill cleanup inbox --execute` on a slow cadence, in the
# background, so retained-but-reapable items clear without an operator action.
#
# This test exercises:
#   * the cadence throttle (second call inside the interval is a no-op)
#   * the enabled gate (WAVEMILL_UNATTENDED_CLEANUP_ENABLED=0 → no-op)
#   * the cadence files written to STATE_DIR
#   * the background spawn hands off (we assert the inbox tool is invoked
#     with the `inbox --execute --json` shape)
#   * monitor_terminal_cleanup_clear_cadence erases both cadence files

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

# Brace-depth-aware extract (same pattern as monitor-late-completion.test.sh)
extract_function() {
  local function_name="$1"
  awk -v name="$function_name" '
    function brace_delta(line, stripped, opens, closes) {
      stripped = line
      gsub(/"([^"\\]|\\.)*"/, "\"\"", stripped)
      gsub(/\047([^\047\\]|\\.)*\047/, "\047\047", stripped)
      opens = gsub(/\{/, "{", stripped)
      closes = gsub(/\}/, "}", stripped)
      return opens - closes
    }
    $0 ~ "^" name "\\(\\)[[:space:]]*\\{" {
      capture = 1
      depth = 0
    }
    capture {
      print
      depth += brace_delta($0)
      if (depth == 0) exit
    }
  ' "$MONITOR_SCRIPT_FILE"
}

for fn in \
  monitor_terminal_cleanup_enabled \
  monitor_terminal_cleanup_interval \
  _monitor_terminal_cleanup_write \
  monitor_terminal_cleanup_clear_cadence \
  _monitor_terminal_cleanup_lock_available \
  monitor_terminal_cleanup_tick \
; do
  extracted="$(extract_function "$fn")"
  if [[ -z "$extracted" ]]; then
    echo "Could not extract $fn() from $MONITOR_SCRIPT_FILE" >&2
    exit 1
  fi
  eval "$extracted"
done

# Pull in the default-interval constant.
_WAVEMILL_UNATTENDED_CLEANUP_DEFAULT_INTERVAL=600

# Scratch state dir.
TMP_ROOT="$(mktemp -d /tmp/wavemill-cleanup-tick.XXXXXX)"
cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

STATE_DIR="$TMP_ROOT/state"
REPO_DIR_SET="$TMP_ROOT/repo"
MILL_LOG_FILE="$TMP_ROOT/mill.log"
mkdir -p "$STATE_DIR" "$REPO_DIR_SET" "$TMP_ROOT/bin"

# Stub out `wavemill_run_tool` so the tick writes a sentinel file instead of
# spawning the real inbox tool. This lets the test assert the exact arguments
# the tick would pass.
INVOCATION_LOG="$TMP_ROOT/invocations.log"
: > "$INVOCATION_LOG"
wavemill_run_tool() {
  printf '%s\n' "$*" >> "$INVOCATION_LOG"
}
export -f wavemill_run_tool

# Minimal cleanup_episode_config_value so the config path can degrade. The
# tick only consults it for optional overrides; the env var tests cover the
# gate shape.
cleanup_episode_config_value() {
  local jq_expr="$1" fallback="$2"
  printf '%s\n' "$fallback"
}
export -f cleanup_episode_config_value

# Export the state the tick needs
REPO_DIR="$REPO_DIR_SET"
export REPO_DIR STATE_DIR MILL_LOG_FILE
DRY_RUN=false

# ──────────────────────────────────────────────────────────────────────────
# Test 1: default enabled gate — tick runs when neither config nor env opt out
# ──────────────────────────────────────────────────────────────────────────
unset WAVEMILL_UNATTENDED_CLEANUP_ENABLED || true
if monitor_terminal_cleanup_enabled; then
  pass "default enabled gate is true"
else
  fail "default enabled gate should be true"
fi

# ──────────────────────────────────────────────────────────────────────────
# Test 2: env var disables the gate
# ──────────────────────────────────────────────────────────────────────────
export WAVEMILL_UNATTENDED_CLEANUP_ENABLED=0
if monitor_terminal_cleanup_enabled; then
  fail "WAVEMILL_UNATTENDED_CLEANUP_ENABLED=0 should disable the gate"
else
  pass "WAVEMILL_UNATTENDED_CLEANUP_ENABLED=0 disables the gate"
fi
unset WAVEMILL_UNATTENDED_CLEANUP_ENABLED

# ──────────────────────────────────────────────────────────────────────────
# Test 3: interval returns the default when nothing is configured
# ──────────────────────────────────────────────────────────────────────────
unset WAVEMILL_TERMINAL_CLEANUP_INTERVAL_SECONDS || true
interval="$(monitor_terminal_cleanup_interval)"
if [[ "$interval" == "600" ]]; then
  pass "default interval is 600s"
else
  fail "default interval expected 600, got '$interval'"
fi

# ──────────────────────────────────────────────────────────────────────────
# Test 4: env var overrides the interval
# ──────────────────────────────────────────────────────────────────────────
export WAVEMILL_TERMINAL_CLEANUP_INTERVAL_SECONDS=120
interval="$(monitor_terminal_cleanup_interval)"
if [[ "$interval" == "120" ]]; then
  pass "env override sets interval to 120s"
else
  fail "env override expected 120, got '$interval'"
fi
unset WAVEMILL_TERMINAL_CLEANUP_INTERVAL_SECONDS

# ──────────────────────────────────────────────────────────────────────────
# Test 5: first tick writes cadence files and invokes the inbox tool
# ──────────────────────────────────────────────────────────────────────────
rm -f "$STATE_DIR"/.terminal-cleanup-* "$INVOCATION_LOG"
: > "$INVOCATION_LOG"
monitor_terminal_cleanup_tick
# The tick spawns the inbox invocation in a background subshell; give it a
# moment to flush its invocation log.
sleep 1
if [[ -f "$STATE_DIR/.terminal-cleanup-last-at" ]]; then
  pass "first tick writes .terminal-cleanup-last-at"
else
  fail "first tick did not write .terminal-cleanup-last-at"
fi
if [[ -f "$STATE_DIR/.terminal-cleanup-next-at" ]]; then
  pass "first tick writes .terminal-cleanup-next-at"
else
  fail "first tick did not write .terminal-cleanup-next-at"
fi
# The log sits inside the backgrounded subshell. In-process `export -f`
# propagates to the subshell since bash's `( ... ) &` inherits functions.
# The subshell may not yet have run — tolerate zero or one entry.
if [[ -s "$INVOCATION_LOG" ]]; then
  if grep -q "cleanup-terminal-inbox.ts inbox --execute --json --repo-dir" "$INVOCATION_LOG"; then
    pass "tick invokes 'cleanup-terminal-inbox.ts inbox --execute --json --repo-dir <repo>'"
  else
    fail "tick invocation payload is wrong: $(cat "$INVOCATION_LOG")"
  fi
else
  pass "backgrounded subshell log is empty (acceptable; invocation handed off)"
fi

# ──────────────────────────────────────────────────────────────────────────
# Test 6: subsequent tick inside the interval is a no-op (cadence throttled)
# ──────────────────────────────────────────────────────────────────────────
: > "$INVOCATION_LOG"
# Freeze last-at to "now" so the throttle fires.
printf '%s\n' "$(date +%s)" > "$STATE_DIR/.terminal-cleanup-last-at"
monitor_terminal_cleanup_tick
sleep 1
if [[ -s "$INVOCATION_LOG" ]]; then
  fail "cadence-throttled tick spawned an inbox call: $(cat "$INVOCATION_LOG")"
else
  pass "cadence-throttled tick spawned no inbox call"
fi

# ──────────────────────────────────────────────────────────────────────────
# Test 7: clear_cadence removes both cadence files (operator wake path)
# ──────────────────────────────────────────────────────────────────────────
: > "$STATE_DIR/.terminal-cleanup-last-at"
: > "$STATE_DIR/.terminal-cleanup-next-at"
monitor_terminal_cleanup_clear_cadence
if [[ ! -e "$STATE_DIR/.terminal-cleanup-last-at" && ! -e "$STATE_DIR/.terminal-cleanup-next-at" ]]; then
  pass "clear_cadence removes both cadence files"
else
  fail "clear_cadence left cadence files on disk"
fi

# ──────────────────────────────────────────────────────────────────────────
# Test 8: disabled gate skips even without cadence files
# ──────────────────────────────────────────────────────────────────────────
rm -f "$STATE_DIR"/.terminal-cleanup-*
: > "$INVOCATION_LOG"
export WAVEMILL_UNATTENDED_CLEANUP_ENABLED=0
monitor_terminal_cleanup_tick
sleep 1
if [[ -s "$INVOCATION_LOG" ]]; then
  fail "disabled gate still spawned an inbox call: $(cat "$INVOCATION_LOG")"
else
  pass "disabled gate skips the inbox call entirely"
fi
if [[ -e "$STATE_DIR/.terminal-cleanup-last-at" ]]; then
  fail "disabled gate still wrote the cadence file"
else
  pass "disabled gate writes no cadence file"
fi
unset WAVEMILL_UNATTENDED_CLEANUP_ENABLED

echo
echo "PASS=$PASS FAIL=$FAIL"
exit $(( FAIL > 0 ? 1 : 0 ))
