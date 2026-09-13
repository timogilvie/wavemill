#!/usr/bin/env bash
set -euo pipefail

[[ "${BASH_SOURCE[0]}" != "${0}" ]] && return 0

if ! command -v tmux >/dev/null 2>&1; then
  echo "SKIP: tmux unavailable"
  exit 0
fi

if [[ -n "${CI:-}" ]]; then
  echo "SKIP: tmux layout test not available in CI"
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RUNNER="$SOURCE_REPO_DIR/shared/lib/wavemill-startup-runner.sh"
MONITOR_LIB="$SOURCE_REPO_DIR/shared/lib/wavemill-monitor.sh"
TMP_DIR="$(mktemp -d /tmp/wavemill-integration-recover.XXXXXX)"
SESSION="wavemill-integration-recover-$$"
export SESSION

cleanup() {
  tmux kill-session -t "$SESSION" >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

extract_function() {
  local source_file="$1"
  local function_name="$2"
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
      if (depth == 0) {
        exit
      }
    }
  ' "$source_file"
}

wait_for_tend_pane() {
  for _ in {1..30}; do
    pane_id="$(tmux list-panes -t "$SESSION:backstage" -F '#{pane_id}	#{pane_title}' 2>/dev/null | awk -F '\t' '$2 == "Wavemill Tend Loop" { print $1; exit }')"
    if [[ -n "${pane_id:-}" ]]; then
      printf '%s\n' "$pane_id"
      return 0
    fi
    sleep 0.1
  done
  return 1
}

FAKE_BIN="$TMP_DIR/bin"
TEST_REPO="$TMP_DIR/repo"
TOOLS_DIR="$TMP_DIR/tools"
STATE_DIR="$TEST_REPO/.wavemill"
STATUS_LOG_FILE="$TMP_DIR/status.log"
STATE_FILE="$STATE_DIR/workflow-state.json"
mkdir -p "$FAKE_BIN" "$TEST_REPO" "$TOOLS_DIR" "$STATE_DIR"
printf '{"tasks":{}}' > "$STATE_FILE"
export REPO_DIR="$TEST_REPO" TOOLS_DIR STATUS_LOG_FILE STATE_FILE STATE_DIR PATH="$FAKE_BIN:$PATH"
export LIB_DIR="$SOURCE_REPO_DIR/shared/lib"

cat > "$FAKE_BIN/npx" <<'EOF'
#!/usr/bin/env bash
exec -a "npx $* session=${WAVEMILL_SESSION:-unknown}" sleep 300
EOF
chmod +x "$FAKE_BIN/npx"
touch "$TOOLS_DIR/tend.ts"

cat > "$TEST_REPO/.wavemill-config.json" <<'EOF'
{
  "integration": {
    "enabled": true,
    "useMillSession": true
  }
}
EOF

startup_log() {
  printf '%s\n' "$*" >> "$STATUS_LOG_FILE"
}

log_warn() {
  printf 'WARN %s\n' "$*" >> "$STATUS_LOG_FILE"
}

log() {
  local _level="${1:-info}"
  shift || true
  printf '%s\n' "$*" >> "$STATUS_LOG_FILE"
}

source "$SOURCE_REPO_DIR/shared/lib/wavemill-common.sh"
eval "$(extract_function "$RUNNER" spawn_integration_window)"
eval "$(extract_function "$MONITOR_LIB" backstage_health_enabled)"
eval "$(extract_function "$MONITOR_LIB" backstage_restart_backoff_seconds)"
eval "$(extract_function "$MONITOR_LIB" probe_backstage_panes)"
eval "$(extract_function "$MONITOR_LIB" read_backstage_health_field)"
eval "$(extract_function "$MONITOR_LIB" read_backstage_service_health_field)"
eval "$(extract_function "$MONITOR_LIB" classify_backstage_health)"
eval "$(extract_function "$MONITOR_LIB" classify_ready_watchdog_hold_health)"
eval "$(extract_function "$MONITOR_LIB" restart_backstage_tend_loop)"
eval "$(extract_function "$MONITOR_LIB" backstage_tend_restart_confirmed)"
eval "$(extract_function "$MONITOR_LIB" backstage_tend_restart_diagnostic)"
eval "$(extract_function "$MONITOR_LIB" check_backstage_health)"

BACKSTAGE_TEND_HEARTBEAT_STALE_SECONDS=210
BACKSTAGE_CLASSIFICATION_HOLD_STALE_SECONDS=900
BACKSTAGE_TEND_RESTART_CONFIRM_SECONDS=3
BACKSTAGE_RESTART_COOLDOWN=60
BACKSTAGE_RESTART_BACKOFF_MAX_SECONDS=900
BACKSTAGE_RESTART_NEEDS_USER_AFTER_ATTEMPTS=3
BACKSTAGE_TEND_RESTART_GRACE_SECONDS=120
pane_details=$'%1\tWavemill Tend Loop\t0\tnpx\tcmd\n%2\tWavemill Jobs\t0\tbash\tcmd'
cat > "$STATE_DIR/backstage-health.json" <<'JSON'
{
  "updatedAt": "2030-01-01T00:00:00Z",
  "services": {
    "tend": {
      "status": "healthy",
      "updatedAt": "2030-01-01T00:00:00Z",
      "heartbeatAt": "2030-01-01T00:00:00Z"
    }
  }
}
JSON
fresh_summary="$(classify_backstage_health "$pane_details" 1893456060 210 900)"
IFS=$'\t' read -r fresh_status _fresh_detail _fresh_count _fresh_pane <<< "$fresh_summary"
if [[ "$fresh_status" != "healthy" ]]; then
  echo "FAIL: fresh tend heartbeat should be healthy (got $fresh_status)"
  exit 1
fi

stale_summary="$(classify_backstage_health "$pane_details" 1893456301 210 900)"
IFS=$'\t' read -r stale_status stale_detail _stale_count _stale_pane <<< "$stale_summary"
if [[ "$stale_status" != "stalled" || "$stale_detail" != *"heartbeat is stale"* ]]; then
  echo "FAIL: stale tend heartbeat should be stalled (got $stale_status: $stale_detail)"
  exit 1
fi

cat > "$STATE_DIR/backstage-health.json" <<'JSON'
{
  "updatedAt": "2030-01-01T00:00:30Z",
  "services": {
    "tend": {
      "status": "healthy",
      "updatedAt": "2030-01-01T00:00:30Z"
    }
  }
}
JSON
startup_summary="$(classify_backstage_health "$pane_details" 1893456060 210 900)"
IFS=$'\t' read -r startup_status _startup_detail _startup_count _startup_pane <<< "$startup_summary"
if [[ "$startup_status" != "healthy" ]]; then
  echo "FAIL: fresh startup health without heartbeat should be healthy (got $startup_status)"
  exit 1
fi

cat > "$STATE_DIR/ready-watchdog-state.json" <<'JSON'
{
  "updatedAt": "2030-01-01T00:01:00Z",
  "tasks": {
    "HOK-2677": {
      "classification": "needs-user",
      "classificationSince": "2030-01-01T00:00:00Z",
      "updatedAt": "2030-01-01T00:01:00Z",
      "detail": "same finding"
    }
  }
}
JSON
cat > "$STATE_DIR/backstage-health.json" <<'JSON'
{
  "updatedAt": "2030-01-01T00:01:00Z",
  "services": {
    "tend": {
      "status": "healthy",
      "updatedAt": "2030-01-01T00:01:00Z",
      "heartbeatAt": "2030-01-01T00:01:00Z"
    }
  }
}
JSON
hold_summary="$(classify_backstage_health "$pane_details" 1893456060 210 10)"
IFS=$'\t' read -r hold_status hold_detail _hold_count _hold_pane <<< "$hold_summary"
if [[ "$hold_status" != "alive-needs-user" || "$hold_detail" != *"HOK-2677"* || "$hold_detail" != *"needs-user"* ]]; then
  echo "FAIL: live needs-user classification should hold backstage health (got $hold_status: $hold_detail)"
  exit 1
fi
rm -f "$STATE_DIR/ready-watchdog-state.json"

tmux new-session -d -s "$SESSION" -n mill -x 220 -y 50 -c "$TEST_REPO" 'sleep 300'
spawn_integration_window

tend_pane="$(wait_for_tend_pane)" || {
  echo "FAIL: tend pane did not start"
  exit 1
}

tmux kill-pane -t "$tend_pane"
sleep 0.3

remaining_titles="$(tmux list-panes -t "$SESSION:backstage" -F '#{pane_title}' 2>/dev/null | sort)"
if [[ "$remaining_titles" != *"Wavemill Jobs"* || "$remaining_titles" != *"Wavemill Pending + Queue"* ]]; then
  echo "FAIL: status panes did not remain after tend exit"
  exit 1
fi

LAST_BACKSTAGE_HEALTH_CHECK=0
LAST_BACKSTAGE_HEALTH_STATUS=""
BACKSTAGE_HEALTH_INTERVAL=0
BACKSTAGE_RESTART_COOLDOWN=60
(
  sleep 1
  timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  mkdir -p "$(dirname "$STATE_DIR/backstage-health.json")"
  jq --arg timestamp "$timestamp" '
    .updatedAt = $timestamp
    | .services.tend.heartbeatAt = $timestamp
    | .services.tend.updatedAt = $timestamp
  ' "$STATE_DIR/backstage-health.json" > "$STATE_DIR/backstage-health.json.heartbeat"
  mv "$STATE_DIR/backstage-health.json.heartbeat" "$STATE_DIR/backstage-health.json"
) &
check_backstage_health

recovered_pane="$(wait_for_tend_pane)" || {
  echo "FAIL: tend pane did not recover"
  exit 1
}

health_status="$(jq -r '.status' "$STATE_DIR/backstage-health.json" 2>/dev/null || echo missing)"
if [[ "$health_status" != "healthy" ]]; then
  echo "FAIL: backstage health did not return to healthy (status=$health_status)"
  exit 1
fi

if [[ -z "$recovered_pane" ]]; then
  echo "FAIL: recovered tend pane id missing"
  exit 1
fi

# A replacement pane alone is not recovery. It must write a heartbeat newer
# than the restart attempt, otherwise the supervisor retains the failed
# attempt and stops retrying after the configured one attempt.
tmux kill-pane -t "$recovered_pane"
sleep 0.3
LAST_BACKSTAGE_HEALTH_CHECK=0
LAST_BACKSTAGE_HEALTH_STATUS=""
check_backstage_health

failed_restart_status="$(jq -r '.status' "$STATE_DIR/backstage-health.json")"
failed_restart_attempts="$(jq -r '.restartAttemptCount' "$STATE_DIR/backstage-health.json")"
failed_restart_detail="$(jq -r '.detail' "$STATE_DIR/backstage-health.json")"
if [[ "$failed_restart_status" != "missing-tend-loop" || "$failed_restart_attempts" != "1" || "$failed_restart_detail" != *"fresh heartbeat"* ]]; then
  echo "FAIL: unconfirmed tend restart should retain failure state (status=$failed_restart_status attempts=$failed_restart_attempts detail=$failed_restart_detail)"
  exit 1
fi

echo "PASS: backstage health restored missing tend loop"
