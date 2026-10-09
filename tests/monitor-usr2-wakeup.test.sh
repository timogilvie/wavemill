#!/usr/bin/env bash
# HOK-3190: a USR2 signal interrupts poll_sleep so operator actions and
# marker drops are acted on in ≤ 1 s instead of waiting for POLL_SECONDS.
# This test sources the monitor as a library (via
# WAVEMILL_READY_WATCHDOG_SOURCE_ONLY=1) so poll_sleep's interrupt logic
# can be exercised in isolation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP="$(mktemp -d -t wavemill-usr2-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

echo "=== USR2 interrupts poll_sleep (HOK-3190) ==="

cat > "$TMP/env.sh" <<ENV
SESSION=test
STATE_DIR="$TMP"
STATE_FILE="$TMP/workflow-state.json"
REPO_DIR="$REPO_DIR"
WAVEMILL_INSTALL_DIR="$REPO_DIR"
TOOLS_DIR="$REPO_DIR/tools"
LIB_DIR="$REPO_DIR/shared/lib"
WAVEMILL_LIB_DIR="$REPO_DIR/shared/lib"
WORKTREE_ROOT="$TMP/worktrees"
BASE_BRANCH=main
POLL_SECONDS=5
MAX_PARALLEL=4
API_TIMEOUT=30
ENV
mkdir -p "$TMP/worktrees"
echo '{"session":"test","tasks":{}}' > "$TMP/workflow-state.json"

# Extract poll_sleep from the monitor as a function. The ready-watchdog
# source-only guard early-returns before poll_sleep is defined, so we parse
# the function body out of the committed file and exercise it in isolation
# with a minimal environment.
POLL_SLEEP_FN="$(awk '/^poll_sleep\(\) {$/,/^}$/' "$REPO_DIR/shared/lib/wavemill-monitor.sh")"
if [[ -z "$POLL_SLEEP_FN" ]]; then
  fail "could not extract poll_sleep from shared/lib/wavemill-monitor.sh"
  echo ""
  echo "--- Results: $PASS passed, $FAIL failed ---"
  exit 1
fi
printf '%s\n' "$POLL_SLEEP_FN" > "$TMP/poll-sleep.sh"

cat > "$TMP/sleeper.sh" <<SLEEP
#!/usr/bin/env bash
set -Eeuo pipefail
POLL_SECONDS=5
declare -a COMMAND_QUEUE=()
# No-op command drain (equivalent to no command file).
drain_command_events() { :; }
source "$TMP/poll-sleep.sh"
echo "ready \$\$" > "$TMP/ready.txt"
WAVEMILL_WAKE_PENDING=0
trap 'WAVEMILL_WAKE_PENDING=1' USR2
start=\$(date +%s)
poll_sleep 5
echo \$(( \$(date +%s) - start )) > "$TMP/elapsed.txt"
SLEEP
chmod +x "$TMP/sleeper.sh"

bash "$TMP/sleeper.sh" &
SLEEPER_PID=$!

# Wait for the sleeper to be ready
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [[ -f "$TMP/ready.txt" ]] && break
  sleep 0.1
done

# Fire USR2 after 500ms
sleep 0.5
kill -USR2 "$SLEEPER_PID" 2>/dev/null || true

wait "$SLEEPER_PID" || true

if [[ -f "$TMP/elapsed.txt" ]]; then
  elapsed=$(cat "$TMP/elapsed.txt")
else
  elapsed=99
fi

if (( elapsed <= 2 )); then
  pass "poll_sleep returns within ${elapsed}s of USR2 (<= 2s)"
else
  fail "poll_sleep returned after ${elapsed}s (expected <= 2s)"
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
exit $(( FAIL > 0 ? 1 : 0 ))
