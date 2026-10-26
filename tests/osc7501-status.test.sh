#!/usr/bin/env bash
# HOK-3292: OSC 7501 Program Status mirror emitted alongside each hook write.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOK_PROTOCOL="$REPO_DIR/shared/hooks/wavemill-hook-protocol.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1 ($2)"; FAIL=$((FAIL + 1)); }

if ! command -v jq >/dev/null 2>&1; then
  echo "jq not available; skipping OSC 7501 tests" >&2
  exit 0
fi
if ! command -v base64 >/dev/null 2>&1; then
  echo "base64 not available; skipping OSC 7501 tests" >&2
  exit 0
fi

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

esc=$'\033'

# Decode a base64 field (strips any newline wrapping defensively).
b64_decode() {
  printf '%s' "$1" | LC_ALL=C tr -d '\n\r' | base64 --decode 2>/dev/null || true
}

# Extract a field value from an OSC 7501 payload body. Body shape:
#   app=<app>:<state_frag>[:msg=<b64>][:title=<b64>]
extract_field() {
  local body="$1" key="$2"
  # Fields are colon-separated at the top level. Walk the string.
  local rest="$body"
  while [[ "$rest" == *":"* || "$rest" == "${key}="* ]]; do
    local head="${rest%%:*}"
    local tail
    if [[ "$rest" == *":"* ]]; then
      tail="${rest#*:}"
    else
      tail=""
    fi
    if [[ "$head" == "${key}="* ]]; then
      printf '%s' "${head#${key}=}"
      return 0
    fi
    [[ -z "$tail" ]] && break
    rest="$tail"
  done
  return 1
}

# Extract the OSC 7501 payload body (between `\033]7501;` and `\033\\`) from a
# raw byte stream. Handles tmux DCS passthrough wrapping.
extract_osc7501_body() {
  local raw="$1"
  # Strip tmux DCS wrapper if present: ESC P tmux ; <escaped> ESC \
  # Doubled ESCs inside the wrapper collapse to single ESCs.
  if [[ "$raw" == "${esc}Ptmux;"* ]]; then
    local inner="${raw#${esc}Ptmux;}"
    inner="${inner%${esc}\\}"
    inner="${inner//${esc}${esc}/${esc}}"
    raw="$inner"
  fi
  [[ "$raw" == "${esc}]7501;"* ]] || return 1
  local body="${raw#${esc}]7501;}"
  body="${body%${esc}\\}"
  printf '%s' "$body"
}

# Shared run harness. Sources the protocol in a subshell, overrides the TTY
# resolver so we can inspect the written bytes, and captures stdout/stderr.
#
# Arguments (positional):
#   tty_file stderr_file stdout_file session issue phase tmux state event detail
#   agent repo_dir [next_action] [tty_override]
#
# tty_override values:
#   "mock" (default) — echo tty_file (bypasses `-c` check in resolver)
#   "none"           — echo __none__ (simulates missing TTY)
run_write() {
  local tty_file="$1" stderr_file="$2" stdout_file="$3"
  local session="$4" issue="$5" phase="$6" tmux_value="$7"
  local state="$8" event="$9" detail="${10}" agent="${11}"
  local repo_dir="${12}" next_action="${13:-}" tty_override="${14:-mock}"

  : > "$tty_file"
  : > "$stderr_file"
  : > "$stdout_file"
  local hook_file="/tmp/wavemill-${session}-${issue}.hook"
  rm -f "$hook_file"

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
    # shellcheck source=/dev/null
    source "$HOOK_PROTOCOL"

    local mock_tty="$tty_file"
    local override="$tty_override"
    _wavemill_hook_osc7501_tty() {
      if [[ "$override" == "none" ]]; then
        printf '%s' "__none__"
      else
        printf '%s' "$mock_tty"
      fi
    }

    wavemill_hook_write "$state" "$event" "$detail" "$agent" "$next_action"
  ) >"$stdout_file" 2>"$stderr_file"

  printf '%s\n' "$hook_file"
}

echo "=== OSC 7501 Program Status (HOK-3292) ==="

# -------- State mapping ----------------------------------------------------

check_state_mapping() {
  local label="$1" state="$2" expected_state_frag="$3"
  local session="osc7501-$$-${label}"
  local issue="HOK-3292-${label}"
  local tty_file="$TMP_ROOT/${label}.tty"
  local stderr_file="$TMP_ROOT/${label}.stderr"
  local stdout_file="$TMP_ROOT/${label}.stdout"
  local hook_file
  hook_file="$(run_write "$tty_file" "$stderr_file" "$stdout_file" \
    "$session" "$issue" "coding" "" "$state" "someEvent" "work detail" "claude" "$REPO_DIR")"

  local raw
  raw="$(cat "$tty_file")"
  local body
  body="$(extract_osc7501_body "$raw")" || {
    fail "$label mapping" "no OSC 7501 body"
    rm -f "$hook_file"
    return
  }

  if [[ "$body" != "app=wavemill-claude:${expected_state_frag}:"* ]]; then
    fail "$label mapping" "body=$body"
    rm -f "$hook_file"
    return
  fi

  # OSC 777 goes to stderr; OSC 7501 goes only to the TTY file.
  if [[ -s "$stdout_file" ]]; then
    fail "$label mapping" "stdout leaked: $(cat "$stdout_file" | cat -v)"
    rm -f "$hook_file"
    return
  fi

  # OSC 7501 bytes must not appear on stderr even when OSC 777 also fires.
  if LC_ALL=C grep -q '7501' "$stderr_file" 2>/dev/null; then
    fail "$label mapping" "OSC 7501 leaked to stderr"
    rm -f "$hook_file"
    return
  fi

  pass "$label mapping"
  rm -f "$hook_file"
}

check_state_mapping "working" "working" "state=working"
check_state_mapping "idle" "idle" "state=idle"
check_state_mapping "waiting" "waiting" "state=blocked:kind=question"
check_state_mapping "approval" "approval-needed" "state=blocked:kind=permission"
check_state_mapping "blocked" "blocked" "state=blocked"
check_state_mapping "policy" "policy-denied" "state=error"
check_state_mapping "error" "error" "state=error"

# -------- msg source: next_action overrides detail -------------------------

session="osc7501-$$-nextaction"
issue="HOK-3292-NA"
tty_file="$TMP_ROOT/nextaction.tty"
hook_file="$(run_write "$tty_file" "$TMP_ROOT/nextaction.stderr" "$TMP_ROOT/nextaction.stdout" \
  "$session" "$issue" "coding" "" "approval-needed" "Notification" "plan ready" "claude" \
  "$REPO_DIR" "approve HOK-3292 to proceed")"
body="$(extract_osc7501_body "$(cat "$tty_file")")"
msg_b64="$(extract_field "$body" msg)" || msg_b64=""
if [[ -n "$msg_b64" && "$(b64_decode "$msg_b64")" == "approve HOK-3292 to proceed" ]]; then
  pass "msg prefers next_action over detail"
else
  fail "msg prefers next_action over detail" "decoded=$(b64_decode "$msg_b64")"
fi
rm -f "$hook_file"

# -------- msg source: falls back to detail ---------------------------------

session="osc7501-$$-detail"
issue="HOK-3292-DT"
tty_file="$TMP_ROOT/detail.tty"
hook_file="$(run_write "$tty_file" "$TMP_ROOT/detail.stderr" "$TMP_ROOT/detail.stdout" \
  "$session" "$issue" "coding" "" "working" "PreToolUse" "Read tool" "claude" "$REPO_DIR")"
body="$(extract_osc7501_body "$(cat "$tty_file")")"
msg_b64="$(extract_field "$body" msg)" || msg_b64=""
if [[ -n "$msg_b64" && "$(b64_decode "$msg_b64")" == "Read tool" ]]; then
  pass "msg falls back to detail when next_action empty"
else
  fail "msg falls back to detail when next_action empty" "decoded=$(b64_decode "$msg_b64")"
fi
rm -f "$hook_file"

# -------- Control-character stripping --------------------------------------

session="osc7501-$$-cc"
issue="HOK-3292-CC"
tty_file="$TMP_ROOT/cc.tty"
dirty_detail=$'a\nb\tc\x07d'
hook_file="$(run_write "$tty_file" "$TMP_ROOT/cc.stderr" "$TMP_ROOT/cc.stdout" \
  "$session" "$issue" "coding" "" "working" "PreToolUse" "$dirty_detail" "claude" "$REPO_DIR")"
body="$(extract_osc7501_body "$(cat "$tty_file")")"
msg_b64="$(extract_field "$body" msg)" || msg_b64=""
decoded="$(b64_decode "$msg_b64")"
if [[ "$decoded" == "abcd" ]]; then
  pass "control chars stripped from msg"
else
  fail "control chars stripped from msg" "decoded=$decoded"
fi
rm -f "$hook_file"

# -------- Byte truncation of msg to 2048 -----------------------------------

session="osc7501-$$-trunc"
issue="HOK-3292-TR"
tty_file="$TMP_ROOT/trunc.tty"
long_detail="$(LC_ALL=C printf 'x%.0s' {1..3000})"
hook_file="$(run_write "$tty_file" "$TMP_ROOT/trunc.stderr" "$TMP_ROOT/trunc.stdout" \
  "$session" "$issue" "coding" "" "working" "PreToolUse" "$long_detail" "claude" "$REPO_DIR")"
body="$(extract_osc7501_body "$(cat "$tty_file")")"
msg_b64="$(extract_field "$body" msg)" || msg_b64=""
decoded="$(b64_decode "$msg_b64")"
decoded_len="${#decoded}"
if [[ "$decoded_len" == "2048" ]]; then
  pass "msg truncated to 2048 bytes"
else
  fail "msg truncated to 2048 bytes" "len=$decoded_len"
fi
rm -f "$hook_file"

# -------- Byte truncation of title to 192 ----------------------------------

session="osc7501-$$-ttrunc"
# 50 × 'HOK-' = 200 bytes (>192 to exercise truncation, short enough to keep the
# hook_file path under POSIX NAME_MAX / macOS's 255-byte filename limit).
long_issue="$(LC_ALL=C printf 'HOK-%.0s' {1..50})"
tty_file="$TMP_ROOT/ttrunc.tty"
hook_file="$(run_write "$tty_file" "$TMP_ROOT/ttrunc.stderr" "$TMP_ROOT/ttrunc.stdout" \
  "$session" "$long_issue" "coding" "" "working" "PreToolUse" "d" "claude" "$REPO_DIR")"
body="$(extract_osc7501_body "$(cat "$tty_file")")"
title_b64="$(extract_field "$body" title)" || title_b64=""
decoded="$(b64_decode "$title_b64")"
decoded_len="${#decoded}"
if [[ "$decoded_len" == "192" ]]; then
  pass "title truncated to 192 bytes"
else
  fail "title truncated to 192 bytes" "len=$decoded_len"
fi
rm -f "$hook_file"

# -------- Base64 fields contain no CR/LF -----------------------------------

session="osc7501-$$-nonl"
tty_file="$TMP_ROOT/nonl.tty"
hook_file="$(run_write "$tty_file" "$TMP_ROOT/nonl.stderr" "$TMP_ROOT/nonl.stdout" \
  "$session" "HOK-3292-NL" "coding" "" "working" "PreToolUse" "$long_detail" "claude" "$REPO_DIR")"
raw="$(cat "$tty_file")"
if [[ "$raw" != *$'\n'* && "$raw" != *$'\r'* ]]; then
  pass "base64 fields contain no CR/LF"
else
  fail "base64 fields contain no CR/LF" "raw has newline"
fi
rm -f "$hook_file"

# -------- Whole sequence ≤ 4096 bytes under worst case ---------------------

session="osc7501-$$-size"
long_issue2="$(LC_ALL=C printf 'HOK-%.0s' {1..50})"
tty_file="$TMP_ROOT/size.tty"
hook_file="$(run_write "$tty_file" "$TMP_ROOT/size.stderr" "$TMP_ROOT/size.stdout" \
  "$session" "$long_issue2" "coding" "" "working" "PreToolUse" "$long_detail" "claude" "$REPO_DIR")"
raw="$(cat "$tty_file")"
# The acceptance criterion applies to the unwrapped OSC 7501 sequence. Here we
# ran with TMUX unset, so the raw bytes ARE the sequence.
raw_len="${#raw}"
if (( raw_len <= 4096 )); then
  pass "whole sequence <= 4096 bytes under worst case (len=$raw_len)"
else
  fail "whole sequence <= 4096 bytes under worst case" "len=$raw_len"
fi
rm -f "$hook_file"

# -------- app sanitization: invalid agent falls back to wavemill -----------

session="osc7501-$$-app"
tty_file="$TMP_ROOT/app.tty"
hook_file="$(run_write "$tty_file" "$TMP_ROOT/app.stderr" "$TMP_ROOT/app.stdout" \
  "$session" "HOK-3292-APP" "coding" "" "working" "PreToolUse" "x" "bad name!" "$REPO_DIR")"
body="$(extract_osc7501_body "$(cat "$tty_file")")"
if [[ "$body" == "app=wavemill:"* ]]; then
  pass "invalid agent string yields app=wavemill"
else
  fail "invalid agent string yields app=wavemill" "body=$body"
fi
rm -f "$hook_file"

# -------- Non-tmux framing -------------------------------------------------

session="osc7501-$$-notmux"
tty_file="$TMP_ROOT/notmux.tty"
hook_file="$(run_write "$tty_file" "$TMP_ROOT/notmux.stderr" "$TMP_ROOT/notmux.stdout" \
  "$session" "HOK-3292-NT" "coding" "" "working" "PreToolUse" "x" "claude" "$REPO_DIR")"
raw="$(cat "$tty_file")"
if [[ "$raw" == "${esc}]7501;"* && "$raw" == *"${esc}\\" && "$raw" != "${esc}Ptmux;"* ]]; then
  pass "non-tmux framing"
else
  fail "non-tmux framing" "raw=$(printf '%s' "$raw" | cat -v)"
fi
rm -f "$hook_file"

# -------- Tmux DCS passthrough framing -------------------------------------

session="osc7501-$$-tmux"
tty_file="$TMP_ROOT/tmux.tty"
hook_file="$(run_write "$tty_file" "$TMP_ROOT/tmux.stderr" "$TMP_ROOT/tmux.stdout" \
  "$session" "HOK-3292-TM" "coding" "tmux-fake" "working" "PreToolUse" "x" "claude" "$REPO_DIR")"
raw="$(cat "$tty_file")"
if [[ "$raw" == "${esc}Ptmux;${esc}${esc}]7501;"* \
   && "$raw" == *"${esc}${esc}\\${esc}\\" ]]; then
  pass "tmux DCS passthrough wraps and doubles ESC"
else
  fail "tmux DCS passthrough" "raw=$(printf '%s' "$raw" | cat -v)"
fi
rm -f "$hook_file"

# -------- No TTY → no-op ---------------------------------------------------

session="osc7501-$$-notty"
tty_file="$TMP_ROOT/notty.tty"
hook_file="$(run_write "$tty_file" "$TMP_ROOT/notty.stderr" "$TMP_ROOT/notty.stdout" \
  "$session" "HOK-3292-NTT" "coding" "" "working" "PreToolUse" "x" "claude" "$REPO_DIR" "" "none")"
if [[ ! -s "$tty_file" && ! -s "$TMP_ROOT/notty.stdout" ]]; then
  pass "no-TTY resolution is a no-op"
else
  fail "no-TTY resolution is a no-op" "tty_file=$(cat "$tty_file" | cat -v)"
fi
rm -f "$hook_file"

# -------- No stdout leak on any state --------------------------------------

session="osc7501-$$-stdout"
tty_file="$TMP_ROOT/stdout.tty"
all_stdout_empty=1
for state in working idle waiting blocked approval-needed policy-denied error; do
  hook_file="$(run_write "$tty_file" "$TMP_ROOT/stdout.stderr" "$TMP_ROOT/stdout.stdout" \
    "$session-$state" "HOK-3292-ST" "coding" "" "$state" "ev" "d" "claude" "$REPO_DIR")"
  if [[ -s "$TMP_ROOT/stdout.stdout" ]]; then
    all_stdout_empty=0
    fail "no stdout leak" "state=$state produced stdout: $(cat "$TMP_ROOT/stdout.stdout" | cat -v)"
    break
  fi
  rm -f "$hook_file"
done
if (( all_stdout_empty )); then
  pass "no stdout leak across all states"
fi

# -------- Kill switch: hooks.programStatus=false ---------------------------

ps_off_repo="$TMP_ROOT/ps-off-repo"
mkdir -p "$ps_off_repo"
printf '%s\n' '{"hooks":{"programStatus":false}}' > "$ps_off_repo/.wavemill-config.json"
session="osc7501-$$-killswitch"
tty_file="$TMP_ROOT/killswitch.tty"
hook_file="$(run_write "$tty_file" "$TMP_ROOT/killswitch.stderr" "$TMP_ROOT/killswitch.stdout" \
  "$session" "HOK-3292-KS" "coding" "" "waiting" "Notification" "clarify" "claude" "$ps_off_repo")"
if [[ ! -s "$tty_file" ]]; then
  pass "hooks.programStatus=false disables OSC 7501 emission"
else
  fail "hooks.programStatus=false disables OSC 7501 emission" \
    "tty had bytes: $(cat "$tty_file" | cat -v)"
fi
# OSC 777 should still fire (emitOsc not disabled). We only check that OSC 7501
# didn't reach the tty — OSC 777 goes to stderr via the agent's existing path.
rm -f "$hook_file"

# -------- Kill switch: hooks.emitOsc=false does NOT disable OSC 7501 ------

osc_off_repo="$TMP_ROOT/osc-off-repo"
mkdir -p "$osc_off_repo"
printf '%s\n' '{"hooks":{"emitOsc":false}}' > "$osc_off_repo/.wavemill-config.json"
session="osc7501-$$-emitosc"
tty_file="$TMP_ROOT/emitosc.tty"
hook_file="$(run_write "$tty_file" "$TMP_ROOT/emitosc.stderr" "$TMP_ROOT/emitosc.stdout" \
  "$session" "HOK-3292-EO" "coding" "" "waiting" "Notification" "clarify" "claude" "$osc_off_repo")"
if [[ -s "$tty_file" ]]; then
  # OSC 7501 still fires (independent of OSC 777 switch).
  if ! LC_ALL=C grep -q '7501' "$tty_file" 2>/dev/null; then
    fail "OSC 7501 independent of emitOsc" "tty content lacks 7501"
  elif [[ -s "$TMP_ROOT/emitosc.stderr" ]]; then
    fail "OSC 7501 independent of emitOsc" "emitOsc=false still wrote stderr: $(cat "$TMP_ROOT/emitosc.stderr" | cat -v)"
  else
    pass "hooks.emitOsc=false disables OSC 777 but not OSC 7501"
  fi
else
  fail "OSC 7501 independent of emitOsc" "tty empty"
fi
rm -f "$hook_file"

# -------- OSC 7501 coexists with OSC 777 under coding phase ---------------

session="osc7501-$$-coexist"
tty_file="$TMP_ROOT/coexist.tty"
hook_file="$(run_write "$tty_file" "$TMP_ROOT/coexist.stderr" "$TMP_ROOT/coexist.stdout" \
  "$session" "HOK-3292-CX" "coding" "" "waiting" "Notification" "clarify" "claude" "$REPO_DIR")"
tty_has_7501=0
LC_ALL=C grep -q '7501' "$tty_file" && tty_has_7501=1 || true
stderr_has_777=0
LC_ALL=C grep -q '777;notify' "$TMP_ROOT/coexist.stderr" && stderr_has_777=1 || true
if (( tty_has_7501 == 1 && stderr_has_777 == 1 )); then
  pass "OSC 7501 and OSC 777 coexist (different sinks)"
else
  fail "OSC 7501 and OSC 777 coexist" \
    "tty_has_7501=$tty_has_7501 stderr_has_777=$stderr_has_777"
fi
rm -f "$hook_file"

# -------- Unknown state → no OSC 7501 emission -----------------------------

session="osc7501-$$-unknown"
tty_file="$TMP_ROOT/unknown.tty"
hook_file="$(run_write "$tty_file" "$TMP_ROOT/unknown.stderr" "$TMP_ROOT/unknown.stdout" \
  "$session" "HOK-3292-UN" "coding" "" "unknown" "ev" "d" "claude" "$REPO_DIR")"
if [[ ! -s "$tty_file" && ! -e "$hook_file" ]]; then
  pass "unknown state writes nothing (hook file and TTY both untouched)"
else
  fail "unknown state writes nothing" "tty=$(cat "$tty_file" | cat -v) hook_file_exists=$([[ -e "$hook_file" ]] && echo yes || echo no)"
fi
rm -f "$hook_file"

echo ""
echo "Passed: $PASS"
echo "Failed: $FAIL"

if [[ "$FAIL" -ne 0 ]]; then
  exit 1
fi
