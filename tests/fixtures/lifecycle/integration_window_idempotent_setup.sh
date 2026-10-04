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
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RUNNER="$REPO_DIR/shared/lib/wavemill-startup-runner.sh"
TMP_DIR="$(mktemp -d /tmp/wavemill-integration-idempotent.XXXXXX)"
SESSION="wavemill-integration-idempotent-$$"
export SESSION

cleanup() {
  tmux kill-session -t "$SESSION" >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

extract_spawn_function() {
  awk '
    /^spawn_integration_window\(\) \{/ { capture=1 }
    capture { print }
    capture && /^}/ { exit }
  ' "$RUNNER"
}

fail() {
  echo "FAIL: $*"
  tmux list-panes -t "$SESSION:backstage" -F '#{pane_id} #{pane_title} #{pane_dead} #{pane_start_command}' 2>/dev/null || true
  cat "$STATE_DIR/backstage-health.json" 2>/dev/null || true
  exit 1
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  [[ "$expected" == "$actual" ]] || fail "$label expected $expected got $actual"
}

wait_for_backstage() {
  local expected_panes="$1"
  for _ in {1..50}; do
    local pane_count observer_count health_count
    pane_count="$(tmux list-panes -t "$SESSION:backstage" -F '#{pane_id}' 2>/dev/null | wc -l | tr -d ' ' || true)"
    observer_count="$(tmux list-panes -t "$SESSION:backstage" -F '#{pane_title}' 2>/dev/null | grep -Fx 'Wavemill Observer' | wc -l | tr -d ' ' || true)"
    health_count="$(jq -r '.services.observer.instanceCount // empty' "$STATE_DIR/backstage-health.json" 2>/dev/null || true)"
    if [[ "$pane_count" == "$expected_panes" && "$observer_count" == "1" && "$health_count" == "1" ]]; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

observer_process_count() {
  pgrep -f "observer.ts --loop.*session=${SESSION}|session=${SESSION}.*observer.ts --loop" 2>/dev/null | wc -l | tr -d ' '
}

FAKE_BIN="$TMP_DIR/bin"
REPO_UNDER_TEST="$TMP_DIR/repo"
TOOLS_DIR="$TMP_DIR/tools"
STATE_DIR="$REPO_UNDER_TEST/.wavemill"
STATUS_LOG_FILE="$TMP_DIR/status.log"
STATE_FILE="$STATE_DIR/workflow-state.json"
mkdir -p "$FAKE_BIN" "$REPO_UNDER_TEST" "$TOOLS_DIR" "$STATE_DIR"
printf '{"tasks":{}}' > "$STATE_FILE"
export REPO_DIR="$REPO_UNDER_TEST" TOOLS_DIR STATE_DIR STATUS_LOG_FILE STATE_FILE PATH="$FAKE_BIN:$PATH"
export LIB_DIR="$SCRIPT_DIR/../../../shared/lib"

cat > "$FAKE_BIN/npx" <<'EOF'
#!/usr/bin/env bash
exec -a "npx $* session=${WAVEMILL_SESSION:-unknown}" sleep 300
EOF
chmod +x "$FAKE_BIN/npx"
touch "$TOOLS_DIR/tend.ts" "$TOOLS_DIR/observer.ts"

cat > "$REPO_UNDER_TEST/.wavemill-config.json" <<'EOF'
{
  "integration": {
    "enabled": true,
    "useMillSession": true
  },
  "observer": {
    "enabled": true,
    "intervalSeconds": 5,
    "heartbeatStaleSeconds": 30,
    "maxLogLines": 25
  }
}
EOF

# The fake npx cannot run the real resolver; pin the capabilities this
# config resolves to (HOK-3102 test override).
export WAVEMILL_SESSION_CAPABILITIES_JSON='{"tend":true,"observer":true,"mergeExecutor":"tend","mergeQueue":true}'

startup_log() {
  printf '%s\n' "$*" >> "$STATUS_LOG_FILE"
}

source "$(dirname "$RUNNER")/wavemill-common.sh"
eval "$(extract_spawn_function)"

tmux new-session -d -s "$SESSION" -n mill -x 220 -y 50 -c "$REPO_UNDER_TEST" 'sleep 300'
spawn_integration_window
wait_for_backstage 4 || fail "initial backstage setup did not settle"
tend_pane_before="$(tmux list-panes -t "$SESSION:backstage" -F '#{pane_id}	#{pane_title}' | awk -F '\t' '$2 == "Wavemill Tend Loop" { print $1; exit }')"
observer_pane_before="$(tmux list-panes -t "$SESSION:backstage" -F '#{pane_id}	#{pane_title}' | awk -F '\t' '$2 == "Wavemill Observer" { print $1; exit }')"

spawn_integration_window
wait_for_backstage 4 || fail "second backstage setup duplicated panes"
tend_pane_after="$(tmux list-panes -t "$SESSION:backstage" -F '#{pane_id}	#{pane_title}' | awk -F '\t' '$2 == "Wavemill Tend Loop" { print $1; exit }')"
assert_eq "tend pane id stable" "$tend_pane_before" "$tend_pane_after"
assert_eq "backstage window count" "1" "$(tmux list-windows -t "$SESSION" -F '#{window_name}' | grep -Fx 'backstage' | wc -l | tr -d ' ')"
assert_eq "observer process count" "1" "$(observer_process_count)"

tmux set-option -t "$SESSION:backstage" remain-on-exit on >/dev/null
observer_pid="$(tmux list-panes -t "$observer_pane_before" -F '#{pane_pid}')"
kill "$observer_pid" >/dev/null 2>&1 || true
for _ in {1..50}; do
  dead="$(tmux list-panes -t "$observer_pane_before" -F '#{pane_dead}' 2>/dev/null || true)"
  [[ "$dead" == "1" ]] && break
  sleep 0.1
done
spawn_integration_window
wait_for_backstage 4 || fail "dead observer pane was not respawned"
observer_pane_after="$(tmux list-panes -t "$SESSION:backstage" -F '#{pane_id}	#{pane_title}' | awk -F '\t' '$2 == "Wavemill Observer" { print $1; exit }')"
assert_eq "observer pane id stable after respawn" "$observer_pane_before" "$observer_pane_after"

extra_one="$(tmux split-window -d -t "$SESSION:backstage.0" -v -p 20 -P -F '#{pane_id}' "exec -a 'npx tools/observer.ts --loop session=${SESSION}' sleep 300")"
tmux select-pane -t "$extra_one" -T "Wavemill Observer" >/dev/null
extra_two="$(tmux split-window -d -t "$SESSION:backstage.0" -v -p 20 -P -F '#{pane_id}' "exec -a 'npx tools/observer.ts --loop session=${SESSION}' sleep 300")"
tmux select-pane -t "$extra_two" -T "Wavemill Observer" >/dev/null
assert_eq "manual duplicate observer panes created" "3" "$(tmux list-panes -t "$SESSION:backstage" -F '#{pane_title}' | grep -Fx 'Wavemill Observer' | wc -l | tr -d ' ')"
spawn_integration_window
wait_for_backstage 4 || fail "duplicate observer panes were not reconciled"
assert_eq "observer process count after reconcile" "1" "$(observer_process_count)"

echo "PASS: integration window setup is idempotent"
