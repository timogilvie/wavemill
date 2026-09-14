#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"
COMMON_SCRIPT="$REPO_DIR/shared/lib/wavemill-common.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

extract_function() {
  local source_file="$1" function_name="$2"
  awk -v name="$function_name" '
    function brace_delta(line, stripped, opens, closes) {
      stripped = line
      gsub(/"([^"\\]|\\.)*"/, "\"\"", stripped)
      gsub(/\047([^\047\\]|\\.)*\047/, "\047\047", stripped)
      opens = gsub(/\{/, "{", stripped)
      closes = gsub(/\}/, "}", stripped)
      return opens - closes
    }
    $0 ~ "^" name "\\(\\)[[:space:]]*\\{" { capture = 1; depth = 0 }
    capture {
      print
      depth += brace_delta($0)
      if (depth == 0) exit
    }
  ' "$source_file"
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" != "$actual" ]]; then
    echo "FAIL: $label"
    echo "  expected: $expected"
    echo "  actual:   $actual"
    exit 1
  fi
}

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "FAIL: $label"
    echo "  missing: $needle"
    echo "  actual: $haystack"
    exit 1
  fi
}

source "$COMMON_SCRIPT"

FUNCS_FILE="$TMP_DIR/backstage-functions.sh"
: > "$FUNCS_FILE"
for fn in \
  backstage_restart_backoff_seconds \
  read_backstage_health_field \
  read_backstage_service_health_field \
  classify_ready_watchdog_hold_health \
  classify_backstage_health \
  backstage_tend_restart_diagnostic \
  check_backstage_health
do
  extract_function "$MONITOR_SCRIPT_FILE" "$fn" >> "$FUNCS_FILE"
  printf '\n' >> "$FUNCS_FILE"
done
source "$FUNCS_FILE"

SESSION="test-session"
STATE_DIR="$TMP_DIR/state"
REPO_DIR="$TMP_DIR/repo"
TOOLS_DIR="$TMP_DIR/tools"
mkdir -p "$STATE_DIR" "$REPO_DIR/.wavemill/logs" "$TOOLS_DIR"
HEALTH_FILE="$STATE_DIR/backstage-health.json"
LOG_FILE="$TMP_DIR/log.txt"
RESTART_LOG="$TMP_DIR/restarts.txt"
: > "$LOG_FILE"
: > "$RESTART_LOG"

BACKSTAGE_HEALTH_INTERVAL=0
BACKSTAGE_RESTART_COOLDOWN=60
BACKSTAGE_RESTART_BACKOFF_MAX_SECONDS=900
BACKSTAGE_RESTART_NEEDS_USER_AFTER_ATTEMPTS=3
BACKSTAGE_TEND_RESTART_CONFIRM_SECONDS=0
BACKSTAGE_TEND_RESTART_GRACE_SECONDS=120
BACKSTAGE_TEND_HEARTBEAT_STALE_SECONDS=210
BACKSTAGE_CLASSIFICATION_HOLD_STALE_SECONDS=900
LAST_BACKSTAGE_HEALTH_CHECK=0
LAST_BACKSTAGE_HEALTH_STATUS=""
PANE_PROBE=""
CONFIRM_RC=1
BACKSTAGE_RESTART_BUCKET="backstage-tend-restart"

backstage_health_enabled() { return 0; }
probe_backstage_panes() { printf '%s\n' "$PANE_PROBE"; }
restart_backstage_tend_loop() {
  local count
  count="$(wc -l < "$RESTART_LOG" | tr -d ' ')"
  printf 'restart-%s\n' "$(( count + 1 ))" >> "$RESTART_LOG"
  printf '%%%s\n' "$(( count + 9 ))"
}
backstage_tend_restart_confirmed() {
  if (( CONFIRM_RC == 0 )); then
    printf '2026-08-18T12:00:10Z\n'
    return 0
  fi
  return 1
}
log() { printf 'LOG %s\n' "$*" >> "$LOG_FILE"; }
log_warn() { printf 'WARN %s\n' "$*" >> "$LOG_FILE"; }

write_health() {
  local status="$1" detail="$2" count="$3" at="$4" pane="${5:-}" heartbeat="${6:-}"
  wavemill_write_backstage_health "$HEALTH_FILE" "$status" "$detail" "$count" "$at" "$pane"
  if [[ -n "$heartbeat" ]]; then
    state_mutate "$HEALTH_FILE" '.services.tend.heartbeatAt = $heartbeat' --arg heartbeat "$heartbeat"
  fi
  state_mutate "$HEALTH_FILE" 'del(.services.tend.laneCondition, .services.tend.laneEvidenceId)'
}

write_tend_service() {
  local status="$1" detail="$2" pane="${3:-%9}" heartbeat="${4:-}" lane_condition="${5:-}" lane_evidence_id="${6:-}"
  wavemill_write_backstage_service_health "$HEALTH_FILE" "tend" "$status" "$detail" 0 "" "$pane" "$heartbeat" 1
  if [[ -n "$lane_condition$lane_evidence_id" ]]; then
    state_mutate "$HEALTH_FILE" '
      .services.tend.laneCondition = $laneCondition
      | .services.tend.laneEvidenceId = $laneEvidenceId
    ' --arg laneCondition "$lane_condition" --arg laneEvidenceId "$lane_evidence_id"
  fi
}

old_iso() {
  perl -MPOSIX=strftime -e 'my $offset = shift @ARGV; print strftime("%Y-%m-%dT%H:%M:%SZ", gmtime(time() - $offset)), "\n"' -- "$1"
}

missing_hold_detail="$(classify_ready_watchdog_hold_health 1000 60 || true)"
assert_eq "missing watchdog state is silent" "" "$missing_hold_detail"

printf '{"updatedAt":"2026-08-23T12:00:00.000Z","tasks":{}}\n' > "$STATE_DIR/ready-watchdog-state.json"
empty_hold_detail="$(classify_ready_watchdog_hold_health 1000 60 || true)"
assert_eq "empty watchdog state is silent" "" "$empty_hold_detail"
rm -f "$STATE_DIR/ready-watchdog-state.json"

assert_eq "backoff 0" "0" "$(backstage_restart_backoff_seconds 0)"
assert_eq "backoff 1" "60" "$(backstage_restart_backoff_seconds 1)"
assert_eq "backoff 2" "120" "$(backstage_restart_backoff_seconds 2)"
assert_eq "backoff 3" "240" "$(backstage_restart_backoff_seconds 3)"
assert_eq "backoff 4" "480" "$(backstage_restart_backoff_seconds 4)"
assert_eq "backoff 5" "900" "$(backstage_restart_backoff_seconds 5)"
assert_eq "backoff cap" "900" "$(backstage_restart_backoff_seconds 40)"

PANE_PROBE=$'%9\tWavemill Tend Loop\t0\tnode\tnpx tsx tools/tend.ts'
write_tend_service "healthy" "ok" "%9" "$(old_iso 1)" "no-eligible" "empty-lane-a"
check_backstage_health
assert_eq "no eligible status" "alive-no-eligible" "$(jq -r '.status' "$HEALTH_FILE")"
assert_eq "no eligible count" "0" "$(jq -r '.restartAttemptCount' "$HEALTH_FILE")"
assert_eq "no eligible restarts" "0" "$(wc -l < "$RESTART_LOG" | tr -d ' ')"

cat > "$STATE_DIR/ready-watchdog-state.json" <<JSON
{"updatedAt":"2026-08-23T12:00:00.000Z","tasks":{"HOK-1":{"classification":"needs-user","classificationSince":"2026-08-23T11:00:00Z","updatedAt":"2026-08-23T11:00:00Z","detail":"waiting"}}}
JSON
write_tend_service "healthy" "ok" "%9" "$(old_iso 1)" "needs-user-hold" "blocked-lane-a"
LOG_BEFORE="$(wc -l < "$LOG_FILE" | tr -d ' ')"
check_backstage_health
assert_eq "needs user live status" "alive-needs-user" "$(jq -r '.status' "$HEALTH_FILE")"
assert_eq "needs user live count" "0" "$(jq -r '.restartAttemptCount' "$HEALTH_FILE")"
assert_eq "needs user live restarts" "0" "$(wc -l < "$RESTART_LOG" | tr -d ' ')"
LOG_AFTER_FIRST="$(wc -l < "$LOG_FILE" | tr -d ' ')"
assert_eq "needs user warns once first" "$(( LOG_BEFORE + 1 ))" "$LOG_AFTER_FIRST"
check_backstage_health
assert_eq "needs user warning throttled" "$LOG_AFTER_FIRST" "$(wc -l < "$LOG_FILE" | tr -d ' ')"
state_mutate "$HEALTH_FILE" '.services.tend.laneEvidenceId = "blocked-lane-b"'
check_backstage_health
assert_eq "needs user warning resets on evidence" "$(( LOG_AFTER_FIRST + 1 ))" "$(wc -l < "$LOG_FILE" | tr -d ' ')"
rm -f "$STATE_DIR/ready-watchdog-state.json"

PANE_PROBE=$'%1\tWavemill Jobs\t0\tzsh\tzsh'
check_backstage_health
assert_eq "first restart count" "1" "$(jq -r '.restartAttemptCount' "$HEALTH_FILE")"
assert_eq "first restart status" "missing-tend-loop" "$(jq -r '.status' "$HEALTH_FILE")"
assert_contains "first detail" "$(jq -r '.detail' "$HEALTH_FILE")" "fresh heartbeat"
assert_eq "first restart calls" "1" "$(wc -l < "$RESTART_LOG" | tr -d ' ')"

write_health "missing-tend-loop" "old miss" 1 "$(old_iso 10)"
check_backstage_health
assert_eq "cooldown restart calls" "1" "$(wc -l < "$RESTART_LOG" | tr -d ' ')"
assert_contains "cooldown detail" "$(jq -r '.detail' "$HEALTH_FILE")" "next automatic restart"

perl -e 'print time() - 70, "\n"' > "$STATE_DIR/.retry-${BACKSTAGE_RESTART_BUCKET}-last-at"
write_health "missing-tend-loop" "old miss" 1 "$(old_iso 70)"
check_backstage_health
assert_eq "second restart calls" "2" "$(wc -l < "$RESTART_LOG" | tr -d ' ')"
assert_eq "second count" "2" "$(jq -r '.restartAttemptCount' "$HEALTH_FILE")"

perl -e 'print time() - 300, "\n"' > "$STATE_DIR/.retry-${BACKSTAGE_RESTART_BUCKET}-last-at"
check_backstage_health
assert_eq "needs user still restarts" "3" "$(wc -l < "$RESTART_LOG" | tr -d ' ')"
assert_eq "needs user status" "needs-user" "$(jq -r '.status' "$HEALTH_FILE")"
assert_contains "needs user immediate exhausted detail" "$(jq -r '.detail' "$HEALTH_FILE")" "restart attempts are exhausted"
assert_eq "exhausted sentinel written" "tend-restart-exhausted evidence=missing-tend-loop:backstage:test-session:backstage:1 attempts=3" "$(cat "$STATE_DIR/.retry-${BACKSTAGE_RESTART_BUCKET}-exhausted")"

perl -e 'print time() - 600, "\n"' > "$STATE_DIR/.retry-${BACKSTAGE_RESTART_BUCKET}-last-at"
write_health "needs-user" "waiting" 5 "$(old_iso 600)"
check_backstage_health
assert_eq "needs user cooldown no restart" "3" "$(wc -l < "$RESTART_LOG" | tr -d ' ')"
assert_contains "needs user exhausted detail" "$(jq -r '.detail' "$HEALTH_FILE")" "restart attempts are exhausted"

PANE_PROBE=$'%1\tWavemill Jobs\t0\tzsh\tzsh\n%2\tWavemill Queue\t0\tzsh\tzsh'
check_backstage_health
assert_eq "identity change resets restart calls" "4" "$(wc -l < "$RESTART_LOG" | tr -d ' ')"
assert_eq "identity change count" "1" "$(jq -r '.restartAttemptCount' "$HEALTH_FILE")"

CONFIRM_RC=0
PANE_PROBE=$'%1\tWavemill Jobs\t0\tzsh\tzsh'
rm -f "$STATE_DIR/.retry-${BACKSTAGE_RESTART_BUCKET}-"*
bounded_retry_increment "$STATE_DIR" "$BACKSTAGE_RESTART_BUCKET" "missing-tend-loop:backstage:test-session:backstage:1" >/dev/null
perl -e 'print time() - 300, "\n"' > "$STATE_DIR/.retry-${BACKSTAGE_RESTART_BUCKET}-last-at"
write_health "missing-tend-loop" "old miss" 1 "$(old_iso 300)"
check_backstage_health
assert_eq "confirmed status" "healthy" "$(jq -r '.status' "$HEALTH_FILE")"
assert_eq "confirmed count" "0" "$(jq -r '.restartAttemptCount' "$HEALTH_FILE")"
assert_contains "confirmed log" "$(cat "$LOG_FILE")" "confirmed by heartbeat"
assert_eq "confirmed clears retry count" "0" "$(bounded_retry_count "$STATE_DIR" "$BACKSTAGE_RESTART_BUCKET")"
CONFIRM_RC=1

attempt_at="$(old_iso 30)"
write_health "missing-tend-loop" "pending" 1 "$attempt_at" "%9" "$(old_iso 90)"
bounded_retry_increment "$STATE_DIR" "$BACKSTAGE_RESTART_BUCKET" "missing-tend-loop:backstage:test-session:backstage:1" >/dev/null
perl -e 'print time() - 30, "\n"' > "$STATE_DIR/.retry-${BACKSTAGE_RESTART_BUCKET}-last-at"
PANE_PROBE=$'%9\tWavemill Tend Loop\t0\tnode\tnpx tsx tools/tend.ts'
check_backstage_health
assert_eq "pending status" "missing-tend-loop" "$(jq -r '.status' "$HEALTH_FILE")"
assert_eq "pending count" "1" "$(jq -r '.restartAttemptCount' "$HEALTH_FILE")"
assert_contains "pending detail" "$(jq -r '.detail' "$HEALTH_FILE")" "pending"

state_mutate "$HEALTH_FILE" '.services.tend.heartbeatAt = $heartbeat' --arg heartbeat "$(old_iso 1)"
state_mutate "$HEALTH_FILE" '.services.tend.laneCondition = "progressing" | .services.tend.laneEvidenceId = "progressable"'
check_backstage_health
assert_eq "new heartbeat status" "healthy" "$(jq -r '.status' "$HEALTH_FILE")"
assert_eq "new heartbeat count" "0" "$(jq -r '.restartAttemptCount' "$HEALTH_FILE")"

rm -f "$STATE_DIR/.retry-${BACKSTAGE_RESTART_BUCKET}-"*
write_health "healthy" "ok" 0 "" "%9" "$(old_iso 300)"
PANE_PROBE=$'%9\tWavemill Tend Loop\t0\tnode\tnpx tsx tools/tend.ts'
check_backstage_health
assert_eq "stale heartbeat restarts" "6" "$(wc -l < "$RESTART_LOG" | tr -d ' ')"
assert_eq "stale heartbeat status" "stalled" "$(jq -r '.status' "$HEALTH_FILE")"
assert_eq "stale heartbeat count" "1" "$(jq -r '.restartAttemptCount' "$HEALTH_FILE")"
assert_contains "stale heartbeat detail" "$(jq -r '.detail' "$HEALTH_FILE")" "fresh heartbeat"

state_mutate "$HEALTH_FILE" '.services.tend.failureCount = 2 | .services.tend.lastError = "transient: github 503"'
wavemill_write_backstage_service_health "$HEALTH_FILE" "tend" "healthy" "ok" 0 "" "%9" "$(old_iso 1)"
assert_eq "merged failure count" "2" "$(jq -r '.services.tend.failureCount' "$HEALTH_FILE")"
assert_eq "merged last error" "transient: github 503" "$(jq -r '.services.tend.lastError' "$HEALTH_FILE")"
assert_eq "omitted instance count is null" "null" "$(jq -r '.services.tend.instanceCount' "$HEALTH_FILE")"

wavemill_write_backstage_service_health "$HEALTH_FILE" "tend" "healthy" "ok" 0 "" "%9" "$(old_iso 1)" 1
assert_eq "explicit instance count is written" "1" "$(jq -r '.services.tend.instanceCount' "$HEALTH_FILE")"

echo "backstage tend watchdog tests passed"
