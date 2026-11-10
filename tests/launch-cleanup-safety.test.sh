#!/usr/bin/env bash
# wavemill-test-suite: none (ran in no suite before HOK-3466; run it or delete it)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMMON="$REPO_ROOT/shared/lib/wavemill-common.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

BIN_DIR="$TMP/bin"
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/tmux" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${TMUX_CALLS_FILE:?}"
case "${1:-}" in
  has-session)
    exit 0
    ;;
  show-environment)
    printf 'REPO_DIR=%s\n' "${TMUX_REPO_DIR:-}"
    exit 0
    ;;
  kill-session)
    exit 0
    ;;
esac
exit 0
EOF
chmod +x "$BIN_DIR/tmux"

export PATH="$BIN_DIR:$PATH"
export SESSION="wavemill-cleanup-test"
export REPO_DIR="$TMP/repo"
export STATE_FILE="$TMP/repo/.wavemill/workflow-state.json"
export LAUNCH_PLAN_FILE="/tmp/${SESSION}-launch-plan.json"
export STATUS_LOG_FILE="/tmp/${SESSION}-mill-status.log"
export LAUNCHED_ISSUES_FILE="/tmp/${SESSION}-launched-issues.txt"
export MONITOR_SCRIPT="/tmp/${SESSION}-monitor.sh"
export MONITOR_ENV="/tmp/${SESSION}-monitor.env"
export TMUX_CALLS_FILE="$TMP/tmux-calls.txt"
mkdir -p "$REPO_DIR/.wavemill"
source "$COMMON"

cat > "$STATE_FILE" <<EOF
{
  "tasks": {
    "HOK-1": {"branch": "task/current", "worktree": "$TMP/current"},
    "HOK-2": {"branch": "task/prior", "worktree": "$TMP/prior"}
  }
}
EOF
cat > "$LAUNCH_PLAN_FILE" <<EOF
{
  "tasks": [
    {
      "issue": "HOK-1",
      "taskPacketFile": "/tmp/${SESSION}-HOK-1-taskpacket.md",
      "taskPacketDetailsFile": "/tmp/${SESSION}-HOK-1-taskpacket-details.md",
      "issueJsonFile": "/tmp/${SESSION}-HOK-1-issue.json",
      "routeFile": "/tmp/${SESSION}-HOK-1-route.json"
    }
  ]
}
EOF
touch "$STATUS_LOG_FILE" "$LAUNCHED_ISSUES_FILE" "$MONITOR_SCRIPT" "$MONITOR_ENV"
touch "/tmp/${SESSION}-HOK-1-taskpacket.md" "/tmp/${SESSION}-HOK-1-taskpacket-details.md" "/tmp/${SESSION}-HOK-1-issue.json" "/tmp/${SESSION}-HOK-1-route.json"
touch "$TMP/unrelated"

echo "=== Launch Cleanup Safety ==="

TMUX_REPO_DIR="$TMP/other-repo" wavemill_cleanup_launch_attempt >/dev/null
if grep -q 'kill-session' "$TMUX_CALLS_FILE"; then
  fail "cleanup killed tmux session bound to a different repo"
else
  pass "cleanup preserves tmux session for different repo"
fi

if [[ "$(jq -r '.tasks | has("HOK-1")' "$STATE_FILE")" == "false" ]] && [[ "$(jq -r '.tasks | has("HOK-2")' "$STATE_FILE")" == "true" ]]; then
  pass "cleanup removes only current launch task state"
else
  fail "cleanup removed unrelated task state or kept current task"
fi

if [[ ! -e "$LAUNCH_PLAN_FILE" && ! -e "/tmp/${SESSION}-HOK-1-taskpacket.md" && -e "$TMP/unrelated" ]]; then
  pass "cleanup removes session temp files only"
else
  fail "cleanup temp file scope was incorrect"
fi

TMUX_REPO_DIR="$REPO_DIR" wavemill_cleanup_launch_attempt >/dev/null
if [[ -e "$TMP/unrelated" ]]; then
  pass "cleanup is idempotent"
else
  fail "idempotent cleanup removed unrelated file"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
