#!/usr/bin/env bash
# wavemill-test-suite: none (ran in no suite before HOK-3466; run it or delete it)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOK_PROTOCOL="$REPO_DIR/shared/hooks/wavemill-hook-protocol.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

if ! command -v jq >/dev/null 2>&1; then
  echo "jq not available; skipping hook OSC tests" >&2
  exit 0
fi

# shellcheck source=/dev/null
source "$HOOK_PROTOCOL"

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

hook_file_for() {
  local session="$1" issue="$2"
  printf '/tmp/wavemill-%s-%s.hook' "$session" "$issue"
}

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

run_write() {
  local stderr_file="$1"
  local session="$2"
  local issue="$3"
  local phase="$4"
  local tmux_value="$5"
  local state="$6"
  local event="$7"
  local detail="$8"
  local agent="$9"
  local repo_dir="${10:-$REPO_DIR}"
  local next_action="${11:-}"
  local hook_file

  hook_file="$(hook_file_for "$session" "$issue")"
  rm -f "$hook_file" "$stderr_file"

  (
    cd "$repo_dir"
    export WAVEMILL_SESSION="$session"
    export WAVEMILL_ISSUE="$issue"
    export WAVEMILL_DASHBOARD_PID=""
    if [[ -n "$phase" ]]; then
      export WAVEMILL_PHASE="$phase"
    else
      unset WAVEMILL_PHASE
    fi
    if [[ -n "$tmux_value" ]]; then
      export TMUX="$tmux_value"
    else
      unset TMUX
    fi
    wavemill_hook_write "$state" "$event" "$detail" "$agent" "$next_action"
  ) 2>"$stderr_file"

  printf '%s\n' "$hook_file"
}

echo "=== Hook OSC Emission ==="

esc=$'\033'
bel=$'\a'

session="hook-osc-$$-1"
issue="HOK-1856-A"
stderr_file="$TMP_ROOT/raw.stderr"
hook_file="$(run_write "$stderr_file" "$session" "$issue" "coding" "" "working" "PreToolUse" "Read" "claude")"
raw_output="$(cat "$stderr_file")"
if [[ -z "$raw_output" ]] \
  && jq -e '.state == "working" and .event == "PreToolUse" and .detail == "Read" and .agent == "claude"' "$hook_file" >/dev/null 2>&1; then
  pass "working PreToolUse writes JSON without OSC"
else
  fail "working PreToolUse should not emit OSC"
fi
rm -f "$hook_file"

session="hook-osc-$$-2"
issue="HOK-1856-B"
stderr_file="$TMP_ROOT/waiting.stderr"
hook_file="$(run_write "$stderr_file" "$session" "$issue" "coding" "" "waiting" "Notification" "review" "claude")"
waiting_output="$(cat "$stderr_file")"
expected_waiting="${esc}]777;notify;wavemill ${issue};waiting on review${esc}\\"
if [[ "$waiting_output" == "$expected_waiting" ]] \
  && [[ "$waiting_output" != *"Ptmux;"* ]] \
  && jq -e '.state == "waiting" and .event == "Notification" and .detail == "review" and .agent == "claude"' "$hook_file" >/dev/null 2>&1; then
  pass "waiting Notification emits raw OSC after JSON write"
else
  fail "waiting Notification raw OSC emission"
fi
rm -f "$hook_file"

session="hook-osc-$$-3"
issue="HOK-1856-C"
stderr_file="$TMP_ROOT/tmux.stderr"
hook_file="$(run_write "$stderr_file" "$session" "$issue" "coding" "tmux-session" "waiting" "Notification" "Read" "claude")"
tmux_output="$(cat "$stderr_file")"
if [[ "$tmux_output" == *"${esc}Ptmux;"* ]] \
  && [[ "$tmux_output" == *"${esc}${esc}]777;notify;wavemill ${issue};waiting on Read"* ]] \
  && [[ "$tmux_output" == *"${esc}${esc}\\${esc}\\" ]] \
  && jq -e '.state == "waiting" and .event == "Notification" and .detail == "Read"' "$hook_file" >/dev/null 2>&1; then
  pass "tmux passthrough wraps and escapes OSC payload"
else
  fail "tmux passthrough framing"
fi
rm -f "$hook_file"

optout_repo="$TMP_ROOT/optout-repo"
mkdir -p "$optout_repo"
printf '%s\n' '{"hooks":{"emitOsc":false}}' > "$optout_repo/.wavemill-config.json"
session="hook-osc-$$-4"
issue="HOK-1856-D"
stderr_file="$TMP_ROOT/optout.stderr"
hook_file="$(run_write "$stderr_file" "$session" "$issue" "coding" "" "waiting" "Notification" "review" "claude" "$optout_repo")"
if [[ ! -s "$stderr_file" ]] \
  && jq -e '.state == "waiting" and .detail == "review"' "$hook_file" >/dev/null 2>&1; then
  pass "hooks.emitOsc=false disables OSC fan-out without blocking JSON"
else
  fail "config opt-out"
fi
rm -f "$hook_file"

session="hook-osc-$$-5"
issue='HOK-1856;bad'
detail="semi;line${esc}break${bel}bell"$'\n'"tail"
stderr_file="$TMP_ROOT/sanitize.stderr"
hook_file="$(run_write "$stderr_file" "$session" "$issue" "coding" "" "waiting" "Notification" "$detail" "claude")"
sanitized_output="$(cat "$stderr_file")"
expected_sanitized="${esc}]777;notify;wavemill HOK-1856bad;waiting on semilinebreakbelltail${esc}\\"
if [[ "$sanitized_output" == "$expected_sanitized" ]] \
  && jq -e '.detail == $detail' --arg detail "$detail" "$hook_file" >/dev/null 2>&1; then
  pass "OSC payload sanitizes delimiters and control bytes"
else
  fail "OSC payload sanitization"
fi
rm -f "$hook_file"

session="hook-osc-$$-6"
issue="HOK-1856-E"
stderr_file="$TMP_ROOT/no-phase.stderr"
hook_file="$(run_write "$stderr_file" "$session" "$issue" "" "" "working" "PreToolUse" "Read" "claude")"
if [[ ! -s "$stderr_file" ]] \
  && jq -e '.state == "working" and .detail == "Read"' "$hook_file" >/dev/null 2>&1; then
  pass "missing phase keeps controller-side hook writes JSON-only"
else
  fail "phase gate for OSC emission"
fi
rm -f "$hook_file"

session="hook-osc-$$-7"
issue="HOK-1856-F"
stderr_file="$TMP_ROOT/invalid.stderr"
hook_file="$(run_write "$stderr_file" "$session" "$issue" "coding" "" "unknown" "PreToolUse" "Read" "claude")"
if [[ ! -e "$hook_file" && ! -s "$stderr_file" ]]; then
  pass "invalid states remain a no-op"
else
  fail "invalid state no-op behavior"
fi
rm -f "$hook_file"

routing_function="$(extract_function "$HOOK_PROTOCOL" "wavemill_hook_write_routing")"
if [[ "$routing_function" == *"wavemill_hook_notify"* ]] && [[ "$routing_function" != *"_wavemill_hook_emit_osc"* ]]; then
  pass "routing hook writes do not emit OSC notifications"
else
  fail "routing hook write should stay JSON + notify only"
fi

echo ""
echo "=== New hook states: blocked, approval-needed, policy-denied (HOK-2370) ==="

session="hook-osc-$$-new-1"
issue="HOK-2370-OSC-A"
stderr_file="$TMP_ROOT/approval-needed.stderr"
hook_file="$(run_write "$stderr_file" "$session" "$issue" "coding" "" "approval-needed" "Notification" "waiting for approval" "claude")"
approval_output="$(cat "$stderr_file")"
expected_approval="${esc}]777;notify;wavemill ${issue};approval needed: waiting for approval${esc}\\"
if [[ "$approval_output" == "$expected_approval" ]] \
  && jq -e '.state == "approval-needed" and .event == "Notification" and .detail == "waiting for approval" and .agent == "claude"' "$hook_file" >/dev/null 2>&1; then
  pass "approval-needed emits OSC notification with correct body"
else
  fail "approval-needed OSC emission (got: $(cat "$stderr_file" | cat -v))"
fi
rm -f "$hook_file"

session="hook-osc-$$-new-2"
issue="HOK-2370-OSC-B"
stderr_file="$TMP_ROOT/policy-denied.stderr"
hook_file="$(run_write "$stderr_file" "$session" "$issue" "coding" "" "policy-denied" "policy_check" "network request blocked" "claude")"
denied_output="$(cat "$stderr_file")"
expected_denied="${esc}]777;notify;wavemill ${issue};policy denied: network request blocked${esc}\\"
if [[ "$denied_output" == "$expected_denied" ]] \
  && jq -e '.state == "policy-denied" and .event == "policy_check" and .detail == "network request blocked"' "$hook_file" >/dev/null 2>&1; then
  pass "policy-denied emits OSC notification with correct body"
else
  fail "policy-denied OSC emission (got: $(cat "$stderr_file" | cat -v))"
fi
rm -f "$hook_file"

session="hook-osc-$$-new-3"
issue="HOK-2370-OSC-C"
stderr_file="$TMP_ROOT/blocked-no-osc.stderr"
hook_file="$(run_write "$stderr_file" "$session" "$issue" "coding" "" "blocked" "tool_error" "cannot proceed" "claude")"
if [[ ! -s "$stderr_file" ]] \
  && jq -e '.state == "blocked" and .event == "tool_error" and .detail == "cannot proceed"' "$hook_file" >/dev/null 2>&1; then
  pass "blocked writes JSON but does not emit OSC (non-actionable by user)"
else
  fail "blocked OSC behavior unexpected (expected no OSC, got: $(cat "$stderr_file" | cat -v))"
fi
rm -f "$hook_file"

session="hook-osc-$$-new-4"
issue="HOK-2370-OSC-D"
stderr_file="$TMP_ROOT/next-action.stderr"
# Args: stderr session issue phase tmux state event detail agent repo_dir next_action
hook_file="$(run_write "$stderr_file" "$session" "$issue" "coding" "" "approval-needed" "Notification" "plan ready" "claude" "$REPO_DIR" "approve HOK-9999 to proceed")"
if jq -e '.state == "approval-needed" and .next_action == "approve HOK-9999 to proceed" and .detail == "plan ready"' "$hook_file" >/dev/null 2>&1; then
  pass "next_action field is written to hook JSON when provided"
else
  fail "next_action field missing from hook JSON"
fi
rm -f "$hook_file"

session="hook-osc-$$-new-5"
issue="HOK-2370-OSC-E"
stderr_file="$TMP_ROOT/no-next-action.stderr"
# Args: stderr session issue phase tmux state event detail agent repo_dir (next_action omitted)
hook_file="$(run_write "$stderr_file" "$session" "$issue" "coding" "" "waiting" "Notification" "clarification needed" "claude" "$REPO_DIR")"
if jq -e 'has("next_action") | not' "$hook_file" >/dev/null 2>&1; then
  pass "next_action field absent from hook JSON when not provided"
else
  fail "next_action field unexpectedly present when not passed"
fi
rm -f "$hook_file"

echo ""
echo "Passed: $PASS"
echo "Failed: $FAIL"

if [[ "$FAIL" -ne 0 ]]; then
  exit 1
fi
