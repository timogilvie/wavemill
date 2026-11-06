#!/usr/bin/env bash
# HOK-3428: unit coverage for monitor_canary_cohort_refresh_tick, the shell
# gate that decides whether to launch the opt-in native canary cohort
# refresh job each monitor pass.
#
# Without a launch-cadence gate, monitor_async_job_launch's only guard is
# "is a job with this id currently running" (monitor_async_job_running) —
# since the launched tool exits in well under a second when not due, the
# tick would fork a fresh `npx tsx` process on *every* monitor pass instead
# of once per canaryAutoRefreshIntervalMinutes. This test exercises:
#   * the feature stays off (no config read, no launch) until enabled
#   * a single stamp file gates both the config re-read cadence (<=1/min,
#     independent of the configured interval) and the actual launch cadence
#   * a due tick launches once, a tick inside the interval does not relaunch
#   * a stale stamp (past the configured interval) allows a relaunch
#   * disabling the cadence live takes effect within the recheck floor, not
#     only after the old (possibly much longer) interval elapses

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR_ROOT/shared/lib/wavemill-monitor.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

# Brace-depth-aware extract (same pattern as monitor-side-effect-detector-tick.test.sh)
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

for fn in sanitize_job_token monitor_canary_cohort_refresh_tick; do
  extracted="$(extract_function "$fn")"
  if [[ -z "$extracted" ]]; then
    echo "Could not extract $fn() from $MONITOR_SCRIPT_FILE" >&2
    exit 1
  fi
  eval "$extracted"
done

TMP_ROOT="$(mktemp -d /tmp/wavemill-canary-cohort-tick.XXXXXX)"
trap 'rm -rf "$TMP_ROOT"' EXIT

STATE_DIR="$TMP_ROOT/state"
REPO_DIR="$TMP_ROOT/repo"
mkdir -p "$STATE_DIR" "$REPO_DIR"
export REPO_DIR STATE_DIR
DRY_RUN=false
STAMP="$STATE_DIR/.canary-cohort-refresh-last-at"
SESSION="test-session"

CONFIG_INTERVAL_MINUTES=0
CONFIG_READ_COUNT_FILE="$TMP_ROOT/config-reads.count"
LAUNCH_LOG="$TMP_ROOT/launches.log"
: > "$LAUNCH_LOG"
: > "$CONFIG_READ_COUNT_FILE"

# Stand in for the merged-config loader; records how many times it's called
# so the test can assert the HOK-3206 hot-pass cost is bounded.
wavemill_load_config() {
  printf 'x' >> "$CONFIG_READ_COUNT_FILE"
  printf '{"nativeAgent":{"certification":{"canaryAutoRefreshIntervalMinutes":%s}}}\n' "$CONFIG_INTERVAL_MINUTES"
}
export -f wavemill_load_config

# Stand in for the real tracked-job launcher; records that a launch was
# attempted without forking an actual `npx tsx` process.
monitor_async_job_launch() {
  printf '%s\n' "$*" >> "$LAUNCH_LOG"
  return 0
}
export -f monitor_async_job_launch

config_reads() { wc -c < "$CONFIG_READ_COUNT_FILE" | tr -d ' '; }

# Test 1: disabled by default — one config read, no launch, stamp written.
rm -f "$STAMP"; : > "$LAUNCH_LOG"; : > "$CONFIG_READ_COUNT_FILE"
CONFIG_INTERVAL_MINUTES=0
monitor_canary_cohort_refresh_tick
[[ "$(config_reads)" == "1" ]] && pass "first disabled tick reads config once" || fail "first disabled tick config reads: $(config_reads)"
[[ ! -s "$LAUNCH_LOG" ]] && pass "disabled tick never launches" || fail "disabled tick launched: $(cat "$LAUNCH_LOG")"
[[ -f "$STAMP" ]] && pass "disabled tick still writes the stamp" || fail "disabled tick did not write the stamp"

# Test 2: a second tick inside the 60s recheck floor skips config entirely.
: > "$LAUNCH_LOG"; : > "$CONFIG_READ_COUNT_FILE"
monitor_canary_cohort_refresh_tick
[[ "$(config_reads)" == "0" ]] && pass "tick inside recheck floor skips config read" || fail "tick inside recheck floor read config: $(config_reads)"
[[ ! -s "$LAUNCH_LOG" ]] && pass "tick inside recheck floor still never launches" || fail "unexpected launch: $(cat "$LAUNCH_LOG")"

# Test 3: once the recheck floor elapses, a newly-enabled cadence launches.
: > "$LAUNCH_LOG"; : > "$CONFIG_READ_COUNT_FILE"
printf '%s %s\n' "$(( $(date +%s) - 61 ))" "0" > "$STAMP"
CONFIG_INTERVAL_MINUTES=10
monitor_canary_cohort_refresh_tick
[[ "$(config_reads)" == "1" ]] && pass "tick past the recheck floor re-reads config" || fail "tick past the recheck floor config reads: $(config_reads)"
if grep -q "canary-cohort-refresh " "$LAUNCH_LOG" && grep -q "monitor-canary-cohort-refresh.ts --repo-dir $REPO_DIR" "$LAUNCH_LOG"; then
  pass "newly-enabled cadence launches the tracked job"
else
  fail "expected launch payload, got: $(cat "$LAUNCH_LOG")"
fi
read -r checked_at launched_at < "$STAMP"
[[ "$launched_at" == "$checked_at" ]] && pass "stamp records the launch time" || fail "stamp launched_at wrong: $launched_at vs $checked_at"

# Test 4: a tick inside the 60s recheck floor after a launch does not
# relaunch and does not read config (the floor dominates a short interval).
: > "$LAUNCH_LOG"; : > "$CONFIG_READ_COUNT_FILE"
monitor_canary_cohort_refresh_tick
[[ "$(config_reads)" == "0" ]] && pass "tick inside the recheck floor after launch skips config read" || fail "tick after launch read config: $(config_reads)"
[[ ! -s "$LAUNCH_LOG" ]] && pass "tick inside the recheck floor after launch does not relaunch" || fail "relaunch inside recheck floor: $(cat "$LAUNCH_LOG")"

# Test 5: past the recheck floor but still inside the configured interval,
# config is re-read but the job does not relaunch.
: > "$LAUNCH_LOG"; : > "$CONFIG_READ_COUNT_FILE"
now="$(date +%s)"
printf '%s %s\n' "$(( now - 61 ))" "$(( now - 120 ))" > "$STAMP"
CONFIG_INTERVAL_MINUTES=10
monitor_canary_cohort_refresh_tick
[[ "$(config_reads)" == "1" ]] && pass "tick past the recheck floor re-reads config again" || fail "config reads: $(config_reads)"
[[ ! -s "$LAUNCH_LOG" ]] && pass "tick still inside the configured interval does not relaunch" || fail "unexpected relaunch: $(cat "$LAUNCH_LOG")"

# Test 6: a launch timestamp older than the configured interval relaunches.
: > "$LAUNCH_LOG"; : > "$CONFIG_READ_COUNT_FILE"
now="$(date +%s)"
printf '%s %s\n' "$(( now - 601 ))" "$(( now - 601 ))" > "$STAMP"
CONFIG_INTERVAL_MINUTES=10
monitor_canary_cohort_refresh_tick
if grep -q "canary-cohort-refresh " "$LAUNCH_LOG"; then
  pass "tick past the configured interval relaunches"
else
  fail "expected relaunch past the configured interval, got: $(cat "$LAUNCH_LOG")"
fi

# Test 7: disabling the cadence live is noticed within the recheck floor,
# not only after the old (longer) interval elapses.
: > "$LAUNCH_LOG"; : > "$CONFIG_READ_COUNT_FILE"
now="$(date +%s)"
printf '%s %s\n' "$(( now - 61 ))" "$now" > "$STAMP"
CONFIG_INTERVAL_MINUTES=0
monitor_canary_cohort_refresh_tick
[[ "$(config_reads)" == "1" ]] && pass "disabling live is checked within the recheck floor" || fail "config reads: $(config_reads)"
[[ ! -s "$LAUNCH_LOG" ]] && pass "disabling live does not launch" || fail "unexpected launch after disabling: $(cat "$LAUNCH_LOG")"

# Test 8: DRY_RUN is a no-op.
rm -f "$STAMP"; : > "$LAUNCH_LOG"; : > "$CONFIG_READ_COUNT_FILE"
DRY_RUN=true
monitor_canary_cohort_refresh_tick
DRY_RUN=false
[[ ! -f "$STAMP" && ! -s "$LAUNCH_LOG" ]] && pass "DRY_RUN skips the tick" || fail "DRY_RUN should skip the tick"

echo ""
echo "Results: $PASS passed, $FAIL failed"
(( FAIL == 0 ))
