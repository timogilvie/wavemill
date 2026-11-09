#!/usr/bin/env bash
# HOK-3426 — the launcher-recorded exit fact (`agent-exit`).
#
# A stage agent can be hard-killed (SIGKILL), so its harness never writes an
# idle hook; the pane shell also outlives the agent, so the pane is not an exit
# record either. The launcher is the agent process's parent and IS the surface
# that observes the exit. These cases pin that:
#   1. `wavemill_hook_write_agent_exit` appends a `writer: launcher,
#      kind: agent-exit` entry (phase + exit code) to `.terminal-history.jsonl`
#      and never touches the live hook file;
#   2. `agent_launch_exit_trap_inject` installs an EXIT trap after the
#      launcher's shebang whose helper records the agent's own exit status;
#   3. the injected trap actually fires for a non-zero (killed) agent exit.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1: ${2:-}"; FAIL=$((FAIL + 1)); }

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

# shellcheck source=../shared/hooks/wavemill-hook-protocol.sh
source "$REPO_DIR/shared/hooks/wavemill-hook-protocol.sh"

echo ""
echo "=== prot_1: writer appends a launcher agent-exit record ==="

feature_dir="$TMP_ROOT/features/testslug"
mkdir -p "$feature_dir"
WAVEMILL_SESSION="sess"
wavemill_hook_write_agent_exit "TEST-3426" "$feature_dir" "review" "143"

history="$feature_dir/.terminal-history.jsonl"
if [[ ! -f "$history" ]]; then
  fail "prot_1: history file written" "missing $history"
else
  row="$(jq -r 'select(.payload.kind == "agent-exit") | [.payload.writer, .payload.phase, .payload.exitCode, .payload.state] | @tsv' "$history" 2>/dev/null | tail -n 1)"
  if [[ "$row" == $'launcher\treview\t143\terror' ]]; then
    pass "prot_1: history carries writer=launcher phase=review exit=143 state=error"
  else
    fail "prot_1: history row" "got '$row'"
  fi
  if jq -e '.payload.timestamp | numbers' "$history" >/dev/null 2>&1; then
    pass "prot_1: record carries a numeric timestamp for the reader"
  else
    fail "prot_1: record carries a numeric timestamp"
  fi
fi

if [[ -f "/tmp/wavemill-sess-TEST-3426.hook" ]]; then
  fail "prot_1: exit record never writes the live hook file"
else
  pass "prot_1: exit record never writes the live hook file"
fi

# An exit 0 is a clean exit; the record still exists (it is the fact), as idle.
wavemill_hook_write_agent_exit "TEST-3426" "$feature_dir" "coding" "0"
clean="$(jq -r 'select(.payload.kind == "agent-exit" and .payload.phase == "coding") | .payload.state' "$history" | tail -n 1)"
[[ "$clean" == "idle" ]] && pass "prot_1: exit 0 records state=idle" || fail "prot_1: exit 0 records state=idle" "got '$clean'"

echo ""
echo "=== trap_1: launcher trap injection records the agent's own exit ==="

# shellcheck disable=SC1090
source "$REPO_DIR/shared/lib/agent-adapters.sh" 2>/dev/null || true

launcher="$TMP_ROOT/review-launcher.sh"
cat > "$launcher" <<'LAUNCHER'
#!/bin/bash
set -euo pipefail
agent_cmd="$1"
"$agent_cmd"
echo "[wavemill] Agent exited ($?)"
LAUNCHER
chmod +x "$launcher"

agent_launch_exit_trap_inject "$launcher" "TEST-3426" "$feature_dir" "review"

if head -n 1 "$launcher" | grep -q '^#!/bin/bash$' && sed -n '2,4p' "$launcher" | grep -q 'trap .*_WM_LAUNCH_EXIT_RECORD'; then
  pass "trap_1: EXIT trap installed after the shebang"
else
  fail "trap_1: EXIT trap installed after the shebang" "$(head -n 4 "$launcher")"
fi

# The trap must record a NON-ZERO exit (a killed agent) even though the
# launcher's own `set -e` aborts the script before its trailing echo.
cat > "$TMP_ROOT/killed-agent" <<'AGENT'
#!/bin/bash
kill -TERM $$
AGENT
chmod +x "$TMP_ROOT/killed-agent"

bash "$launcher" "$TMP_ROOT/killed-agent" >/dev/null 2>&1 || true

latest="$(jq -r 'select(.payload.kind == "agent-exit") | [.payload.phase, .payload.exitCode, .payload.state] | @tsv' "$history" | tail -n 1)"
if [[ "$latest" == $'review\t143\terror' ]]; then
  pass "trap_1: killed agent exit (143) is recorded with its phase"
else
  fail "trap_1: killed agent exit is recorded" "got '$latest'"
fi

# A launcher with no feature dir (helper launches) must not gain a trap.
plain="$TMP_ROOT/plain-launcher.sh"
printf '#!/bin/bash\nagent_cmd="$1"\n"$agent_cmd"\n' > "$plain"
chmod +x "$plain"
agent_launch_exit_trap_inject "$plain" "TEST-3426" "" "review"
if grep -q '_WM_LAUNCH_EXIT_RECORD' "$plain"; then
  fail "trap_1: no feature dir means no injected trap"
else
  pass "trap_1: no feature dir means no injected trap"
fi

echo ""
echo "=== trap_2: the recorded phase is the launch's session-ownership kind ==="

# Ready remediation and conflict resolution launch with the `coding` phase
# token but own `ready-remediation` / `conflict-resolution` rows. The reader
# scopes exit records by stage name, so the launcher must record the KIND, not
# the raw token, or a hard-killed remediation agent would never settle.
kind="$(WAVEMILL_SESSION_KIND=ready-remediation session_ownership_kind_for_launch "coding")"
if [[ "$kind" == "ready-remediation" ]]; then
  pass "trap_2: a remediation launch resolves to the ready-remediation kind"
else
  fail "trap_2: a remediation launch resolves to the ready-remediation kind" "got '$kind'"
fi
uncoded_kind="$(session_ownership_kind_for_launch "review")"
if [[ "$uncoded_kind" == "review" ]]; then
  pass "trap_2: a plain review launch keeps the review kind"
else
  fail "trap_2: a plain review launch keeps the review kind" "got '$uncoded_kind'"
fi

kind_launcher="$TMP_ROOT/kind-launcher.sh"
printf '#!/bin/bash\nagent_cmd="$1"\n"$agent_cmd"\n' > "$kind_launcher"
chmod +x "$kind_launcher"
agent_launch_exit_trap_inject "$kind_launcher" "TEST-3426" "$feature_dir" "$kind"
bash "$kind_launcher" "$TMP_ROOT/killed-agent" >/dev/null 2>&1 || true
kind_latest="$(jq -r 'select(.payload.kind == "agent-exit") | .payload.phase' "$history" | tail -n 1)"
if [[ "$kind_latest" == "ready-remediation" ]]; then
  pass "trap_2: the exit record names the ownership kind as its phase"
else
  fail "trap_2: the exit record names the ownership kind as its phase" "got '$kind_latest'"
fi

echo ""
echo "=== trap_3: a signal-killed launcher still records the exit ==="

# The mill's shutdown path kills the launcher, not the agent. Bash runs an
# EXIT trap on SIGTERM/SIGHUP, so the fact survives — but only while the
# launcher stays a shell (it deliberately does not `exec` the agent; replacing
# the process image would delete the trap). Protecting this keeps a killed
# stage from waiting out the 30-minute stall clock.
sig_agent="$TMP_ROOT/sig-agent.sh"
printf '#!/bin/bash\nsleep 30\n' > "$sig_agent"
chmod +x "$sig_agent"
sig_launcher="$TMP_ROOT/sig-launcher.sh"
printf '#!/bin/bash\nagent_cmd="$1"\n"$agent_cmd"\n' > "$sig_launcher"
chmod +x "$sig_launcher"
agent_launch_exit_trap_inject "$sig_launcher" "TEST-3426" "$feature_dir" "review"

for sig in TERM HUP; do
  before="$(jq -r 'select(.payload.kind == "agent-exit") | .payload.phase' "$history" 2>/dev/null | wc -l | tr -d ' ')"
  bash "$sig_launcher" "$sig_agent" >/dev/null 2>&1 &
  launcher_pid=$!
  # bounded wait for the launcher to actually be running its agent
  for _ in $(seq 1 50); do
    kill -0 "$launcher_pid" 2>/dev/null || break
    [[ -n "$(pgrep -P "$launcher_pid" 2>/dev/null || true)" ]] && break
    sleep 0.02
  done
  kill -"$sig" "$launcher_pid" 2>/dev/null || true
  wait "$launcher_pid" 2>/dev/null || true
  after="$(jq -r 'select(.payload.kind == "agent-exit") | .payload.phase' "$history" 2>/dev/null | wc -l | tr -d ' ')"
  if [[ "$after" -gt "$before" ]]; then
    pass "trap_3: SIG$sig of the launcher is recorded as an exit"
  else
    fail "trap_3: SIG$sig of the launcher is recorded as an exit" "records $before -> $after"
  fi
  # the orphaned agent sleep is short-lived and holds no world resource
done

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
