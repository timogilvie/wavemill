#!/usr/bin/env bash
# wavemill-test-suite: none (ran in no suite before HOK-3466; run it or delete it)
set -euo pipefail

# Notification → waiting transition tests for the Claude status hook adapter.
#
# Covers the HOK-1731 fix: every Notification event must produce a `waiting`
# status write (not just permission_prompt/idle_prompt), and the `.message`
# field should be surfaced as the detail so the dashboard can display the
# question text.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOK_SCRIPT="$REPO_DIR/shared/hooks/claude-status-hook.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

if ! command -v jq >/dev/null 2>&1; then
  echo "jq not available; skipping notification-waiting tests" >&2
  exit 0
fi

if [[ ! -x "$HOOK_SCRIPT" ]]; then
  if [[ ! -f "$HOOK_SCRIPT" ]]; then
    echo "FAIL: claude-status-hook.sh not found at $HOOK_SCRIPT" >&2
    exit 1
  fi
  # Some checkouts strip the executable bit; invoke via `bash` instead.
fi

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

# Each test isolates its hook output via a fresh WAVEMILL_SESSION/WAVEMILL_ISSUE
# pair. Helper computes the hook path and runs the adapter with the supplied
# stdin payload.
hook_file_for() {
  local session="$1" issue="$2"
  printf '/tmp/wavemill-%s-%s.hook' "$session" "$issue"
}

run_hook() {
  local session="$1" issue="$2" payload="$3"
  WAVEMILL_SESSION="$session" \
  WAVEMILL_ISSUE="$issue" \
  WAVEMILL_DASHBOARD_PID="" \
  bash "$HOOK_SCRIPT" <<<"$payload"
}

cleanup_hook_file() {
  local file="$1"
  rm -f "$file"
}

echo "=== Notification → waiting ==="

# --- Test 1: Notification with message → waiting + detail surfaces message ---
session="notif-msg-$$-1"
issue="HOK-1731-A"
hook_file="$(hook_file_for "$session" "$issue")"
cleanup_hook_file "$hook_file"
payload='{"hook_event_name":"Notification","message":"Should I proceed with approach A?"}'
run_hook "$session" "$issue" "$payload"
if [[ -s "$hook_file" ]] \
  && state="$(jq -r '.state' "$hook_file")" \
  && [[ "$state" == "waiting" ]] \
  && detail="$(jq -r '.detail' "$hook_file")" \
  && [[ "$detail" == "Should I proceed with approach A?" ]] \
  && event="$(jq -r '.event' "$hook_file")" \
  && [[ "$event" == "Notification" ]] \
  && agent="$(jq -r '.agent' "$hook_file")" \
  && [[ "$agent" == "claude" ]]; then
  pass "Notification with message surfaces detail and waiting state"
else
  fail "Notification with message did not produce expected waiting+detail"
fi
cleanup_hook_file "$hook_file"

# --- Test 2: Notification without message → waiting + fallback detail ---
session="notif-msg-$$-2"
issue="HOK-1731-B"
hook_file="$(hook_file_for "$session" "$issue")"
cleanup_hook_file "$hook_file"
payload='{"hook_event_name":"Notification"}'
run_hook "$session" "$issue" "$payload"
if [[ -s "$hook_file" ]] \
  && state="$(jq -r '.state' "$hook_file")" \
  && [[ "$state" == "waiting" ]] \
  && detail="$(jq -r '.detail' "$hook_file")" \
  && [[ "$detail" == "awaiting user input" ]]; then
  pass "Notification without message falls back to 'awaiting user input'"
else
  fail "Notification without message did not fall back to default detail"
fi
cleanup_hook_file "$hook_file"

# --- Test 3: Long message truncated to ≤120 chars ---
session="notif-msg-$$-3"
issue="HOK-1731-C"
hook_file="$(hook_file_for "$session" "$issue")"
cleanup_hook_file "$hook_file"
long_message="$(printf 'A%.0s' {1..200})"
payload="$(jq -nc --arg msg "$long_message" '{hook_event_name:"Notification", message:$msg}')"
run_hook "$session" "$issue" "$payload"
if [[ -s "$hook_file" ]] \
  && state="$(jq -r '.state' "$hook_file")" \
  && [[ "$state" == "waiting" ]] \
  && detail="$(jq -r '.detail' "$hook_file")" \
  && [[ "${#detail}" -eq 120 ]]; then
  pass "long Notification message truncates to 120 characters"
else
  fail "long Notification message was not truncated to 120 characters (got ${#detail:-0})"
fi
cleanup_hook_file "$hook_file"

# --- Test 4: Legacy permission_prompt payload still produces waiting ---
session="notif-msg-$$-4"
issue="HOK-1731-D"
hook_file="$(hook_file_for "$session" "$issue")"
cleanup_hook_file "$hook_file"
payload='{"hook_event_name":"Notification","notification_type":"permission_prompt"}'
run_hook "$session" "$issue" "$payload"
if [[ -s "$hook_file" ]] \
  && state="$(jq -r '.state' "$hook_file")" \
  && [[ "$state" == "waiting" ]] \
  && detail="$(jq -r '.detail' "$hook_file")" \
  && [[ "$detail" == "permission_prompt" ]]; then
  pass "legacy permission_prompt notification still maps to waiting"
else
  fail "legacy permission_prompt notification regressed"
fi
cleanup_hook_file "$hook_file"

# --- Test 5: Adapter is a no-op outside wavemill context ---
hook_file="/tmp/wavemill-no-wavemill-$$-HOK-1731-E.hook"
cleanup_hook_file "$hook_file"
# Unset WAVEMILL_SESSION/ISSUE entirely; adapter must exit 0 without writing.
if (
  unset WAVEMILL_SESSION WAVEMILL_ISSUE
  bash "$HOOK_SCRIPT" <<<'{"hook_event_name":"Notification","message":"hi"}'
); then
  if [[ ! -e "$hook_file" ]]; then
    pass "adapter is no-op outside wavemill (no hook file)"
  else
    fail "adapter wrote a hook file outside wavemill context"
    cleanup_hook_file "$hook_file"
  fi
else
  fail "adapter exited non-zero outside wavemill context"
fi

# --- Test 6: Malformed JSON stdin does not crash and does not write ---
session="notif-msg-$$-6"
issue="HOK-1731-F"
hook_file="$(hook_file_for "$session" "$issue")"
cleanup_hook_file "$hook_file"
if WAVEMILL_SESSION="$session" \
   WAVEMILL_ISSUE="$issue" \
   bash "$HOOK_SCRIPT" <<<'this is not json'; then
  # `jq -r` will produce an empty event field, so the adapter exits 0 with no
  # hook write. We accept either: no file, or an empty file (no jq state ran).
  if [[ ! -s "$hook_file" ]]; then
    pass "malformed JSON payload is handled without writing a hook file"
  else
    fail "malformed JSON payload produced a hook write"
  fi
else
  fail "adapter exited non-zero on malformed JSON payload"
fi
cleanup_hook_file "$hook_file"

# --- Test 7: UserPromptSubmit after Notification transitions back to working ---
session="notif-msg-$$-7"
issue="HOK-1731-G"
hook_file="$(hook_file_for "$session" "$issue")"
cleanup_hook_file "$hook_file"
run_hook "$session" "$issue" '{"hook_event_name":"Notification","message":"Need confirmation"}'
state_after_notif="$(jq -r '.state' "$hook_file" 2>/dev/null || echo MISSING)"
run_hook "$session" "$issue" '{"hook_event_name":"UserPromptSubmit"}'
state_after_prompt="$(jq -r '.state' "$hook_file" 2>/dev/null || echo MISSING)"
if [[ "$state_after_notif" == "waiting" && "$state_after_prompt" == "working" ]]; then
  pass "UserPromptSubmit after Notification transitions waiting → working"
else
  fail "expected waiting → working transition (got $state_after_notif → $state_after_prompt)"
fi
cleanup_hook_file "$hook_file"

# --- Test 8: USR1 is delivered to the dashboard PID after a Notification ---
# We mock the dashboard process with a small bash subshell that traps USR1 and
# writes a sentinel file, then verify the adapter signals it.
session="notif-msg-$$-8"
issue="HOK-1731-H"
hook_file="$(hook_file_for "$session" "$issue")"
cleanup_hook_file "$hook_file"

sentinel="$TMP_ROOT/usr1.signal"
rm -f "$sentinel"

# Start a background dashboard mock that writes the sentinel on USR1 and
# exits cleanly. We use a polling loop so the test never hangs even if the
# signal never arrives.
(
  trap 'echo got >"'"$sentinel"'"; exit 0' USR1
  for _ in $(seq 1 100); do
    sleep 0.05
    [[ -e "$sentinel" ]] && exit 0
  done
) &
dashboard_pid=$!

# Give the trap a tick to install before sending the signal.
sleep 0.1

WAVEMILL_SESSION="$session" \
WAVEMILL_ISSUE="$issue" \
WAVEMILL_DASHBOARD_PID="$dashboard_pid" \
bash "$HOOK_SCRIPT" <<<'{"hook_event_name":"Notification","message":"please confirm"}'

# Wait briefly for the trap handler to run.
for _ in $(seq 1 40); do
  [[ -e "$sentinel" ]] && break
  sleep 0.05
done

# Clean up the mock dashboard whether or not it has exited yet.
kill "$dashboard_pid" 2>/dev/null || true
wait "$dashboard_pid" 2>/dev/null || true

if [[ -e "$sentinel" ]]; then
  pass "USR1 is delivered to the dashboard PID after a Notification write"
else
  fail "USR1 was not delivered to the dashboard PID after a Notification write"
fi
cleanup_hook_file "$hook_file"

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
