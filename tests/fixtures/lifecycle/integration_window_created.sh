#!/usr/bin/env bash
set -euo pipefail

# Guard against being sourced by lifecycle-scenarios.test.sh
[[ "${BASH_SOURCE[0]}" != "${0}" ]] && return 0

if ! command -v tmux >/dev/null 2>&1; then
  echo "SKIP: tmux unavailable"
  exit 0
fi

# tmux split-window -p requires an interactive terminal; skip in CI
if [[ -n "${CI:-}" ]]; then
  echo "SKIP: tmux layout test not available in CI"
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RUNNER="$REPO_DIR/shared/lib/wavemill-startup-runner.sh"
TMP_DIR="$(mktemp -d /tmp/wavemill-integration-created.XXXXXX)"
SESSION="wavemill-integration-created-$$"
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
STATE_DIR="$TMP_DIR/.wavemill"
STATUS_LOG_FILE="$TMP_DIR/status.log"
STATE_FILE="$TMP_DIR/workflow-state.json"
mkdir -p "$FAKE_BIN" "$REPO_UNDER_TEST" "$TOOLS_DIR" "$STATE_DIR"
printf '{"tasks":{}}' > "$STATE_FILE"
export REPO_DIR="$REPO_UNDER_TEST" TOOLS_DIR STATE_DIR STATUS_LOG_FILE STATE_FILE PATH="$FAKE_BIN:$PATH"
export LIB_DIR="$SCRIPT_DIR/../../../shared/lib"

cat > "$FAKE_BIN/npx" <<'EOF'
#!/usr/bin/env bash
exec -a "npx $* session=${WAVEMILL_SESSION:-unknown}" sleep 300
EOF
chmod +x "$FAKE_BIN/npx"
touch "$TOOLS_DIR/tend.ts"

cat > "$REPO_UNDER_TEST/.wavemill-config.json" <<'EOF'
{
  "integration": {
    "enabled": true,
    "useMillSession": true
  },
  "observer": {
    "enabled": false
  }
}
EOF

# The fake npx cannot run the real resolver; pin the capabilities this
# config resolves to (HOK-3102 test override).
export WAVEMILL_SESSION_CAPABILITIES_JSON='{"tend":true,"observer":false,"mergeExecutor":"tend","mergeQueue":true}'

startup_log() {
  printf '%s\n' "$*" >> "$STATUS_LOG_FILE"
}

source "$(dirname "$RUNNER")/wavemill-common.sh"
eval "$(extract_spawn_function)"

tmux new-session -d -s "$SESSION" -n mill -x 220 -y 50 -c "$REPO_UNDER_TEST" 'sleep 300'
spawn_integration_window

for _ in {1..20}; do
  if tmux list-windows -t "$SESSION" -F '#{window_name}' | grep -qx 'backstage'; then
    echo "PASS: backstage window created"
    exit 0
  fi
  sleep 0.1
done

echo "FAIL: backstage window was not created"
exit 1
