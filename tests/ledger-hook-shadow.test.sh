#!/usr/bin/env bash
# HOK-3184 hook ↔ ledger shadow mirror: writer=agent writes produce evidence
# rows; writer=monitor writes do not.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

ISSUE="HOK-HOOKSHADOW"
SESSION="hook-shadow-test"

LEDGER_DIR="$TEST_TMP/mill"
mkdir -p "$LEDGER_DIR/.wavemill"

run_ledger() {
  WAVEMILL_MILLED_REPO_DIR="$LEDGER_DIR" \
    node "$REPO_DIR/tools/ledger.ts" --strict --json "$@"
}

# Seed a running step row so the evidence writer has a target.
STEP_JSON="$(run_ledger step-upsert --issue "$ISSUE" --kind review --head abc --prompt sha256:zz)"
STEP_ID="$(echo "$STEP_JSON" | jq -r '.id')"

# Wire wavemill_run_tool to call the CLI with the test's ledger path. The
# protocol loads the shadow helper when sourced.
wavemill_run_tool() {
  local tool="$1"
  shift
  WAVEMILL_MILLED_REPO_DIR="$LEDGER_DIR" \
    node "$REPO_DIR/tools/$tool" "$@"
}
export -f wavemill_run_tool || true

# Source the protocol in a bash subshell with the env set so the shadow helper
# runs under the right session/issue identity.
WAVEMILL_SESSION="$SESSION" WAVEMILL_ISSUE="$ISSUE" \
  WAVEMILL_MILLED_REPO_DIR="$LEDGER_DIR" \
  bash -c '
    set -euo pipefail
    source "'"$REPO_DIR"'/shared/hooks/wavemill-hook-protocol.sh"
    wavemill_run_tool() {
      local tool="$1"; shift
      WAVEMILL_MILLED_REPO_DIR="'"$LEDGER_DIR"'" node "'"$REPO_DIR"'/tools/$tool" "$@"
    }
    # Writer=agent — produces an evidence row (synchronously via the helper).
    wavemill_hook_shadow_evidence working PreToolUse Read agent claude
    # Writer=monitor — never produces an evidence row.
    wavemill_hook_shadow_evidence idle pr_merged "" monitor wavemill
    # Give any disowned background workers a moment to finish.
    wait 2>/dev/null || true
    sleep 1
  '

# Verify: at least one agent-hook evidence row recorded.
EV_JSON="$(run_ledger inspect "$STEP_ID")"
AGENT_EVENTS="$(echo "$EV_JSON" | jq -r '[.evidence[] | select(.source=="agent-hook")] | length')"
if [[ "$AGENT_EVENTS" -ge 1 ]] 2>/dev/null; then
  pass "writer=agent produces agent-hook evidence row"
else
  fail "writer=agent produces agent-hook evidence row (count=$AGENT_EVENTS)"
fi

# Verify: zero monitor evidence rows (writer=monitor is excluded).
MONITOR_EVENTS="$(echo "$EV_JSON" | jq -r '[.evidence[] | select(.source=="monitor")] | length')"
if [[ "$MONITOR_EVENTS" == "0" ]]; then
  pass "writer=monitor does not produce evidence rows"
else
  fail "writer=monitor does not produce evidence rows (count=$MONITOR_EVENTS)"
fi

# Kill-switch: WAVEMILL_LEDGER_SHADOW_DISABLED=1 skips the write entirely.
WAVEMILL_SESSION="$SESSION" WAVEMILL_ISSUE="$ISSUE" \
  WAVEMILL_MILLED_REPO_DIR="$LEDGER_DIR" WAVEMILL_LEDGER_SHADOW_DISABLED=1 \
  bash -c '
    set -euo pipefail
    source "'"$REPO_DIR"'/shared/hooks/wavemill-hook-protocol.sh"
    wavemill_run_tool() {
      local tool="$1"; shift
      WAVEMILL_MILLED_REPO_DIR="'"$LEDGER_DIR"'" node "'"$REPO_DIR"'/tools/$tool" "$@"
    }
    wavemill_hook_shadow_evidence working PreToolUse Edit agent claude
    sleep 1
  '
BEFORE="$AGENT_EVENTS"
AFTER="$(run_ledger inspect "$STEP_ID" | jq -r '[.evidence[] | select(.source=="agent-hook")] | length')"
if [[ "$AFTER" == "$BEFORE" ]]; then
  pass "WAVEMILL_LEDGER_SHADOW_DISABLED=1 skips the write"
else
  fail "WAVEMILL_LEDGER_SHADOW_DISABLED=1 skips the write (before=$BEFORE after=$AFTER)"
fi

echo
echo "Passed: $PASS, Failed: $FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
exit 0
