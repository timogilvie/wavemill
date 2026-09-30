#!/usr/bin/env bash
# HOK-3094: a mill with integration off still gets a backstage window running
# the observer, with no tend pane and tend recorded as disabled.
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
TMP_DIR="$(mktemp -d /tmp/wavemill-integration-observer-only.XXXXXX)"
SESSION="wavemill-integration-observer-only-$$"
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

# No observer key: the observer is on by default, whatever the integration setting.
cat > "$REPO_UNDER_TEST/.wavemill-config.json" <<'EOF'
{
  "integration": {
    "enabled": false
  }
}
EOF

# The fake npx cannot run the real resolver; pin the capabilities this
# config resolves to (HOK-3102 test override).
export WAVEMILL_SESSION_CAPABILITIES_JSON='{"tend":false,"observer":true,"mergeExecutor":"operator","mergeQueue":false,"reasons":{"tend":"integration.enabled=false"}}'

startup_log() {
  printf '%s\n' "$*" >> "$STATUS_LOG_FILE"
}

source "$(dirname "$RUNNER")/wavemill-common.sh"
eval "$(extract_spawn_function)"

fail() {
  echo "FAIL: $*"
  tmux list-panes -t "$SESSION:backstage" -F '#{pane_id} #{pane_title} #{pane_start_command}' 2>/dev/null || true
  cat "$STATE_DIR/backstage-health.json" 2>/dev/null || true
  exit 1
}

wait_for_observer_only_layout() {
  local titles observer_count tend_count start_cmds observer_status tend_status
  for _ in {1..30}; do
    titles="$(tmux list-panes -t "$SESSION:backstage" -F '#{pane_title}' 2>/dev/null || true)"
    observer_count="$(printf '%s\n' "$titles" | grep -Fxc 'Wavemill Observer' || true)"
    tend_count="$(printf '%s\n' "$titles" | grep -Fxc 'Wavemill Tend Loop' || true)"
    start_cmds="$(tmux list-panes -t "$SESSION:backstage" -F '#{pane_start_command}' 2>/dev/null || true)"
    observer_status="$(jq -r '.services.observer.status // empty' "$STATE_DIR/backstage-health.json" 2>/dev/null || true)"
    tend_status="$(jq -r '.services.tend.status // empty' "$STATE_DIR/backstage-health.json" 2>/dev/null || true)"
    if [[ "$observer_count" == "1" && "$tend_count" == "0" \
      && "$titles" == *"Wavemill Jobs"* \
      && "$titles" == *"Wavemill Pending + Queue"* \
      && "$start_cmds" == *"tools/observer.ts"* \
      && "$start_cmds" != *"tend.ts"* \
      && "$observer_status" == "healthy" \
      && "$tend_status" == "disabled" ]]; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

tmux new-session -d -s "$SESSION" -n mill -x 220 -y 50 -c "$REPO_UNDER_TEST" 'sleep 300'
spawn_integration_window
wait_for_observer_only_layout || fail "observer-only backstage window was not created correctly"
grep -Fq "tend is off: integration.enabled=false" "$STATE_DIR/backstage-health.json" \
  || fail "tend disabled detail does not carry the resolver reason"

# A tend pane left over from an earlier integration session is retired on the
# next reconcile, and the observer keeps running.
stale_tend="$(tmux split-window -d -t "$SESSION:backstage" -P -F '#{pane_id}' 'sleep 300')"
tmux select-pane -t "$stale_tend" -T "Wavemill Tend Loop"
spawn_integration_window
wait_for_observer_only_layout || fail "stale tend pane was not retired on reconcile"

echo "PASS: observer-only backstage window created without tend"
