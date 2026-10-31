#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
GUARD_DIR="$REPO_DIR/shared/agent-bin"
GUARD="$GUARD_DIR/tmux"
# The "real tmux" this test launches the controller through resolves through
# the one resolver primitive — never a private `type -P tmux` guess.
# shellcheck source=../shared/lib/terminal-backend.sh
source "$REPO_DIR/shared/lib/terminal-backend.sh"

PASS=0
FAIL=0
TMP_ROOT="$(mktemp -d)"
TEST_SESSION="tmux-runtime-guard-$$"
HOOK_FILE="/tmp/wavemill-${TEST_SESSION}-CASE.hook"
trap 'rm -rf "$TMP_ROOT"; rm -f "$HOOK_FILE"' EXIT

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

FAKE_LOG="$TMP_ROOT/real-tmux.log"
FAKE_TMUX="$TMP_ROOT/real-tmux"
cat > "$FAKE_TMUX" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_LOG"
FAKE
chmod +x "$FAKE_TMUX"
: > "$FAKE_LOG"

mkdir -p "$TMP_ROOT/controller-real" "$TMP_ROOT/private"
ln -s "$TMP_ROOT/controller-real" "$TMP_ROOT/controller-link"
CONTROL_SOCKET="$TMP_ROOT/controller-link/server.sock"
CONTROL_SOCKET_ALIAS="$TMP_ROOT/controller-real/server.sock"
PRIVATE_SOCKET="$TMP_ROOT/private/server.sock"

run_guard() {
  PATH="$GUARD_DIR:$PATH" \
  FAKE_LOG="$FAKE_LOG" \
  WAVEMILL_REAL_TMUX="$FAKE_TMUX" \
  WAVEMILL_CONTROL_TMUX_SOCKET="$CONTROL_SOCKET" \
  WAVEMILL_SESSION="$TEST_SESSION" \
  WAVEMILL_ISSUE="CASE" \
  WAVEMILL_AGENT="test-agent" \
    "$@"
}

echo "=== Agent tmux runtime guard ==="

set +e
implicit_stderr="$(run_guard tmux kill-server 2>&1)"
implicit_rc=$?
set -e
if [[ "$implicit_rc" -eq 126 && "$implicit_stderr" == *"blocked implicit tmux kill-server"* && ! -s "$FAKE_LOG" ]]; then
  pass "implicit kill-server is denied before reaching real tmux"
else
  fail "implicit kill-server denial (rc=$implicit_rc, stderr=$implicit_stderr)"
fi

cat > "$TMP_ROOT/nested-test.sh" <<'NESTED'
#!/usr/bin/env bash
command tmux kill-server
NESTED
chmod +x "$TMP_ROOT/nested-test.sh"
set +e
nested_stderr="$(run_guard bash "$TMP_ROOT/nested-test.sh" 2>&1)"
nested_rc=$?
set -e
if [[ "$nested_rc" -eq 126 && "$nested_stderr" == *"blocked implicit tmux kill-server"* && ! -s "$FAKE_LOG" ]]; then
  pass "nested scripts cannot bypass the execution-time guard"
else
  fail "nested script denial (rc=$nested_rc, stderr=$nested_stderr)"
fi

set +e
batch_stderr="$(run_guard tmux list-sessions ';' kill-serv 2>&1)"
batch_rc=$?
set -e
if [[ "$batch_rc" -eq 126 && "$batch_stderr" == *"blocked implicit tmux kill-server"* && ! -s "$FAKE_LOG" ]]; then
  pass "abbreviated kill-server in a tmux command batch is denied"
else
  fail "batched abbreviated denial (rc=$batch_rc, stderr=$batch_stderr)"
fi

set +e
global_option_stderr="$(run_guard tmux -c 'echo ready' kill-server 2>&1)"
global_option_rc=$?
set -e
if [[ "$global_option_rc" -eq 126 && "$global_option_stderr" == *"blocked implicit tmux kill-server"* && ! -s "$FAKE_LOG" ]]; then
  pass "global tmux options cannot hide kill-server"
else
  fail "global option denial (rc=$global_option_rc, stderr=$global_option_stderr)"
fi

set +e
controller_stderr="$(run_guard tmux -S "$CONTROL_SOCKET_ALIAS" kill-server 2>&1)"
controller_rc=$?
set -e
if [[ "$controller_rc" -eq 126 && "$controller_stderr" == *"targeting the Wavemill controller socket"* && ! -s "$FAKE_LOG" ]]; then
  pass "canonicalized explicit controller socket is denied"
else
  fail "explicit controller denial (rc=$controller_rc, stderr=$controller_stderr)"
fi

run_guard tmux -S "$PRIVATE_SOCKET" kill-server
if grep -Fq -- "-S $PRIVATE_SOCKET kill-server" "$FAKE_LOG"; then
  pass "explicit private socket kill-server reaches real tmux"
else
  fail "explicit private socket was not forwarded"
fi

: > "$FAKE_LOG"
run_guard tmux list-sessions
if grep -Fxq -- "list-sessions" "$FAKE_LOG"; then
  pass "non-destructive tmux commands are unchanged"
else
  fail "non-destructive command was not forwarded"
fi

if command -v jq >/dev/null 2>&1 && jq -e '.state == "policy-denied" and .event == "tmux_guard" and .agent == "test-agent"' "$HOOK_FILE" >/dev/null 2>&1; then
  pass "runtime denial writes policy status"
else
  fail "runtime denial did not write policy status"
fi

: > "$FAKE_LOG"
env -u WAVEMILL_SESSION -u WAVEMILL_ISSUE \
  WAVEMILL_REAL_TMUX="$FAKE_TMUX" FAKE_LOG="$FAKE_LOG" "$GUARD" kill-server
if grep -Fxq -- "kill-server" "$FAKE_LOG"; then
  pass "standalone tmux use remains unaffected"
else
  fail "standalone tmux command was not forwarded"
fi

# The launch adapter must install the guard in the agent environment; testing
# the wrapper alone would not prove that nested commands actually resolve it.
# shellcheck source=/dev/null
source "$REPO_DIR/shared/lib/agent-adapters.sh"
tmux() {
  [[ "${1:-}" == "display-message" ]] && printf '%s\n' "$CONTROL_SOCKET"
  return 0
}
guard_exports="$(agent_tmux_guard_export_command 'session:window' "$TEST_SESSION" 'CASE' 'codex')"
if [[ "$guard_exports" == *"WAVEMILL_REAL_TMUX="* \
  && "$guard_exports" == *"WAVEMILL_CONTROL_TMUX_SOCKET="* \
  && "$guard_exports" == *"shared/agent-bin:\"\$PATH\""* ]]; then
  pass "agent launch exports route nested tmux calls through the guard"
else
  fail "agent launch did not export the tmux guard environment"
fi

# End-to-end controller survival: the nested script runs with TMUX pointing at
# a live controller server, yet the PATH guard rejects its implicit kill.
if REAL_TMUX="$(term_resolve_real_tmux || true)"; [[ -n "$REAL_TMUX" ]]; then
  LIVE_SOCKET="$TMP_ROOT/live-controller.sock"
  if "$REAL_TMUX" -S "$LIVE_SOCKET" new-session -d -s controller 'sleep 60' 2>/dev/null; then
    before_pid="$($REAL_TMUX -S "$LIVE_SOCKET" display-message -p '#{pid}' 2>/dev/null || true)"
    if [[ -n "$before_pid" ]]; then
      set +e
      PATH="$GUARD_DIR:$PATH" \
      WAVEMILL_REAL_TMUX="$REAL_TMUX" \
      WAVEMILL_CONTROL_TMUX_SOCKET="$LIVE_SOCKET" \
      WAVEMILL_SESSION="$TEST_SESSION" WAVEMILL_ISSUE="CASE" \
      TMUX="$LIVE_SOCKET,$before_pid,0" \
        bash "$TMP_ROOT/nested-test.sh" >/dev/null 2>&1
      live_rc=$?
      set -e
      after_pid="$($REAL_TMUX -S "$LIVE_SOCKET" display-message -p '#{pid}' 2>/dev/null || true)"
      "$REAL_TMUX" -S "$LIVE_SOCKET" kill-server >/dev/null 2>&1 || true
      if [[ "$live_rc" -eq 126 && "$after_pid" == "$before_pid" ]]; then
        pass "live controller PID survives a nested implicit kill-server"
      else
        fail "live controller survival (rc=$live_rc, before=$before_pid, after=$after_pid)"
      fi
    else
      pass "live controller survival skipped because sandbox disallows tmux servers"
    fi
  else
    pass "live controller survival skipped because sandbox disallows tmux servers"
  fi
else
  pass "live controller survival skipped because tmux is unavailable"
fi

echo ""
echo "Passed: $PASS"
echo "Failed: $FAIL"
[[ "$FAIL" -eq 0 ]]
