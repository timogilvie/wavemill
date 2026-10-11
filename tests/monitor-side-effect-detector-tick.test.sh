#!/usr/bin/env bash
# HOK-3183: unit coverage for monitor_side_effect_detector_tick. The monitor
# runs `tools/ledger-detect-duplicates.ts` on a slow cadence, in the
# background, so duplicate / unrecorded side effects reach the mill log.
#
# This test exercises:
#   * both kill switches (detector-only and ledger-wide)
#   * the cadence stamp written to STATE_DIR and the throttle inside the interval
#   * the interval override and its fallback on garbage
#   * the background spawn passes `--repo-dir <repo> --since 30m`

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR_ROOT/shared/lib/wavemill-monitor.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

# Brace-depth-aware extract (same pattern as monitor-terminal-cleanup-tick.test.sh)
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
  _monitor_terminal_cleanup_write \
  monitor_side_effect_detector_interval \
  monitor_side_effect_detector_tick \
; do
  extracted="$(extract_function "$fn")"
  if [[ -z "$extracted" ]]; then
    echo "Could not extract $fn() from $MONITOR_SCRIPT_FILE" >&2
    exit 1
  fi
  eval "$extracted"
done

TMP_ROOT="$(mktemp -d /tmp/wavemill-side-effect-tick.XXXXXX)"
trap 'rm -rf "$TMP_ROOT"' EXIT

STATE_DIR="$TMP_ROOT/state"
REPO_DIR="$TMP_ROOT/repo"
MILL_LOG_FILE="$TMP_ROOT/mill.log"
mkdir -p "$STATE_DIR" "$REPO_DIR"
export REPO_DIR STATE_DIR MILL_LOG_FILE
DRY_RUN=false
STAMP="$STATE_DIR/.side-effect-detector-last-at"

INVOCATION_LOG="$TMP_ROOT/invocations.log"
: > "$INVOCATION_LOG"
wavemill_run_tool() {
  printf '%s\n' "$*" >> "$INVOCATION_LOG"
}
export -f wavemill_run_tool

wait_for_invocation() {
  local i
  for i in $(seq 1 50); do
    [[ -s "$INVOCATION_LOG" ]] && return 0
    sleep 0.1
  done
  return 1
}

# Test 1: interval default, override, and garbage fallback
unset SIDE_EFFECT_DETECTOR_INTERVAL_SECONDS || true
[[ "$(monitor_side_effect_detector_interval)" == "300" ]] && pass "default interval is 300s" || fail "default interval"
SIDE_EFFECT_DETECTOR_INTERVAL_SECONDS=60
[[ "$(monitor_side_effect_detector_interval)" == "60" ]] && pass "env override sets 60s" || fail "env override"
SIDE_EFFECT_DETECTOR_INTERVAL_SECONDS=abc
[[ "$(monitor_side_effect_detector_interval)" == "300" ]] && pass "garbage interval falls back to 300s" || fail "garbage fallback"
unset SIDE_EFFECT_DETECTOR_INTERVAL_SECONDS

# Test 2: kill switches are no-ops that write no stamp
for switch in WAVEMILL_SIDE_EFFECT_DETECTOR_DISABLED WAVEMILL_LEDGER_SHADOW_DISABLED; do
  rm -f "$STAMP"
  : > "$INVOCATION_LOG"
  export "$switch=1"
  monitor_side_effect_detector_tick
  unset "$switch"
  if [[ ! -f "$STAMP" && ! -s "$INVOCATION_LOG" ]]; then
    pass "$switch=1 disables the tick"
  else
    fail "$switch=1 should disable the tick"
  fi
done

# Test 3: DRY_RUN is a no-op
rm -f "$STAMP"
DRY_RUN=true
monitor_side_effect_detector_tick
DRY_RUN=false
[[ ! -f "$STAMP" ]] && pass "DRY_RUN skips the tick" || fail "DRY_RUN should skip the tick"

# Test 4: first tick stamps the cadence and spawns the detector
rm -f "$STAMP"
: > "$INVOCATION_LOG"
monitor_side_effect_detector_tick
if [[ -f "$STAMP" ]]; then
  pass "first tick writes the cadence stamp"
else
  fail "first tick did not write the cadence stamp"
fi
if wait_for_invocation && grep -qx "ledger-detect-duplicates.ts --repo-dir $REPO_DIR --since 30m" "$INVOCATION_LOG"; then
  pass "tick invokes 'ledger-detect-duplicates.ts --repo-dir <repo> --since 30m'"
else
  fail "tick invocation payload is wrong: $(cat "$INVOCATION_LOG")"
fi

# Test 5: a second tick inside the interval is throttled
: > "$INVOCATION_LOG"
printf '%s\n' "$(date +%s)" > "$STAMP"
monitor_side_effect_detector_tick
sleep 0.5
[[ ! -s "$INVOCATION_LOG" ]] && pass "tick inside the interval is throttled" || fail "throttled tick spawned: $(cat "$INVOCATION_LOG")"

# Test 6: a stale stamp lets the tick run again
: > "$INVOCATION_LOG"
printf '%s\n' "$(( $(date +%s) - 301 ))" > "$STAMP"
monitor_side_effect_detector_tick
wait_for_invocation && pass "tick past the interval runs again" || fail "tick past the interval did not run"

echo ""
echo "Results: $PASS passed, $FAIL failed"
(( FAIL == 0 ))
