#!/usr/bin/env bash
# HOK-3293: pin the terminal backend seam (shared/lib/terminal-backend.sh).
#
# tmux is stubbed as a bash function — exactly how ~66 other tests stub it —
# so this also proves the seam invokes tmux by command name. Each operation's
# exact argv is asserted, plus the declared capability set, the typed refusal
# when a capability is missing, and the legacy helper aliases.

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

PASS=0
FAIL=0
pass() { echo "ok $1"; PASS=$((PASS + 1)); }
fail() { echo "not ok $1"; echo "  $2" >&2; FAIL=$((FAIL + 1)); }

# shellcheck source=../shared/lib/terminal-backend.sh
source "$REPO_DIR/shared/lib/terminal-backend.sh"
# shellcheck source=lib/state-fixtures.sh
source "$REPO_DIR/tests/lib/state-fixtures.sh"

TMUX_LOG="$TEST_TMP/tmux.log"
TMUX_STDOUT=""
TMUX_STATUS=0

# Records one line per invocation: each argv element wrapped in [].
tmux() {
  local arg line=""
  for arg in "$@"; do line+="[$arg]"; done
  printf '%s\n' "$line" >> "$TMUX_LOG"
  [[ -n "$TMUX_STDOUT" ]] && printf '%s\n' "$TMUX_STDOUT"
  return "$TMUX_STATUS"
}

reset_stub() {
  : > "$TMUX_LOG"
  TMUX_STDOUT=""
  TMUX_STATUS=0
}

# assert_argv <name> <expected log contents> -- <command...>
assert_argv() {
  local name="$1" expected="$2"
  shift 3
  reset_stub
  "$@" >/dev/null 2>&1
  local actual
  actual="$(cat "$TMUX_LOG")"
  if [[ "$actual" == "$expected" ]]; then
    pass "$name"
  else
    fail "$name" "expected: $expected | actual: $actual"
  fi
}

# ── Capability metadata ──────────────────────────────────────────────────────

[[ "$(term_backend)" == "tmux" ]] && pass "backend id is tmux" || fail "backend id is tmux" "$(term_backend)"

expected_caps="$(printf '%s\n' attach capture exit host input inspect session-env)"
actual_caps="$(term_capabilities | sort)"
if [[ "$actual_caps" == "$expected_caps" ]]; then
  pass "tmux backend declares exactly the seven capabilities"
else
  fail "tmux backend declares exactly the seven capabilities" "$actual_caps"
fi

for cap in host exit inspect capture input attach session-env; do
  term_has "$cap" || fail "term_has $cap" "returned non-zero"
done
pass "term_has accepts every declared capability"
if term_has rex-only; then fail "term_has rejects unknown capability" "returned 0"; else pass "term_has rejects unknown capability"; fi

# ── host ─────────────────────────────────────────────────────────────────────

assert_argv "new_session" "[new-session][-d][-s][wm][-n][control][-c][/repo][bash][-l]" -- \
  term_new_session wm --window control --cwd /repo -- bash -l
assert_argv "new_window" "[new-window][-d][-t][wm][-n][HOK-1-x][-c][/wt][-P][-F][#{window_id}][claude]" -- \
  term_new_window wm HOK-1-x --cwd /wt --print-handle -- claude
assert_argv "split" "[split-window][-t][wm:0][-h][-f][-p][30][-c][/wt][-P][-F][#{pane_id}][bash]" -- \
  term_split wm:0 --horizontal --full --percent 30 --cwd /wt --print-handle -- bash
assert_argv "list_sessions" "[list-sessions][-F][#{session_name}]" -- term_list_sessions
assert_argv "list_windows" "[list-windows][-t][wm][-F][#{window_id}|#{window_name}]" -- term_list_windows wm
assert_argv "list_panes all" "[list-panes][-a][-F][#{pane_id}]" -- term_list_panes --all
assert_argv "list_panes target" "[list-panes][-t][@3][-F][#{pane_id}]" -- term_list_panes @3
assert_argv "kill_session" "[kill-session][-t][wm]" -- term_kill_session wm
assert_argv "kill_window" "[kill-window][-t][@3]" -- term_kill_window @3
assert_argv "kill_pane" "[kill-pane][-t][%7]" -- term_kill_pane %7
assert_argv "respawn" "[respawn-pane][-k][-t][@3][-c][/wt][claude]" -- term_respawn @3 --kill --cwd /wt -- claude

[[ "$(term_window_handle wm 1)" == "wm:1" ]] && pass "window_handle joins a bare window name" || fail "window_handle joins a bare window name" "$(term_window_handle wm 1)"
[[ "$(term_window_handle wm @42)" == "@42" ]] && pass "window_handle passes a window id through" || fail "window_handle passes a window id through" "$(term_window_handle wm @42)"
[[ "$(term_window_handle wm other:2)" == "other:2" ]] && pass "window_handle passes a qualified handle through" || fail "window_handle passes a qualified handle through" "$(term_window_handle wm other:2)"
if term_window_handle wm "" >/dev/null; then fail "window_handle rejects an empty window" "returned 0"; else pass "window_handle rejects an empty window"; fi

assert_argv "window_exists" "[display-message][-p][-t][@3][#{session_name}]" -- term_window_exists wm @3
reset_stub
TMUX_STDOUT="wm"
if term_window_exists wm @3; then pass "window_exists accepts a slot in the session"; else fail "window_exists accepts a slot in the session" "returned non-zero"; fi
TMUX_STDOUT="other"
if term_window_exists wm @3; then fail "window_exists rejects a slot in another session" "returned 0"; else pass "window_exists rejects a slot in another session"; fi

# ── exit ─────────────────────────────────────────────────────────────────────

assert_argv "is_dead" "[list-panes][-t][@3][-F][#{pane_dead}]" -- term_is_dead @3
reset_stub; TMUX_STDOUT="1"; term_is_dead @3; rc=$?
[[ "$rc" == 0 ]] && pass "is_dead returns 0 for an exited process" || fail "is_dead returns 0 for an exited process" "rc=$rc"
reset_stub; TMUX_STDOUT="0"; term_is_dead @3; rc=$?
[[ "$rc" == 1 ]] && pass "is_dead returns 1 for a live process" || fail "is_dead returns 1 for a live process" "rc=$rc"
reset_stub; TMUX_STATUS=1; term_is_dead @3; rc=$?
[[ "$rc" == 2 ]] && pass "is_dead returns 2 when unreadable" || fail "is_dead returns 2 when unreadable" "rc=$rc"

assert_argv "exit_code" "[list-panes][-t][@3][-F][#{pane_dead}:#{pane_dead_status}]" -- term_exit_code @3
reset_stub; TMUX_STDOUT="1:42"
[[ "$(term_exit_code @3)" == "42" ]] && pass "exit_code prints the exit status" || fail "exit_code prints the exit status" "$(term_exit_code @3)"
reset_stub; TMUX_STDOUT="0:"
if term_exit_code @3 >/dev/null; then fail "exit_code fails while running" "returned 0"; else pass "exit_code fails while running"; fi

# ── inspect ──────────────────────────────────────────────────────────────────

for pair in pid:pane_pid current_command:pane_current_command current_path:pane_current_path \
  start_command:pane_start_command title:pane_title tty:pane_tty dead:pane_dead; do
  field="${pair%%:*}" token="${pair#*:}"
  assert_argv "pane_field $field" "[display-message][-p][-t][@3][#{$token}]" -- term_pane_field @3 "$field"
done
assert_argv "pane_field rejects unknown fields" "" -- term_pane_field @3 nope
assert_argv "pane_fields" "[display-message][-p][-t][@3][#{pane_dead}|#{pane_current_command}|#{pane_pid}]" -- \
  term_pane_fields @3 dead current_command pid

# ── capture ──────────────────────────────────────────────────────────────────

assert_argv "capture screen" "[capture-pane][-p][-t][@3]" -- term_capture @3
assert_argv "capture history" "[capture-pane][-p][-t][@3][-S][-200]" -- term_capture @3 200

# ── input ────────────────────────────────────────────────────────────────────

assert_argv "send_text" "[send-keys][-t][@3][-l][--][echo hi]" -- term_send_text @3 "echo hi"
assert_argv "send_key" "[send-keys][-t][@3][C-c][Enter]" -- term_send_key @3 C-c Enter
assert_argv "send_key requires a key" "" -- term_send_key @3

# ── attach ───────────────────────────────────────────────────────────────────

assert_argv "attach" "[attach][-t][wm]" -- term_attach wm
assert_argv "refresh_client" "[refresh-client][-S]" -- term_refresh_client
assert_argv "set_title" "[select-pane][-t][@3][-T][HOK-1 coding]" -- term_set_title @3 "HOK-1 coding"

# ── session-env ──────────────────────────────────────────────────────────────

assert_argv "session_env_get name" "[show-environment][-t][wm][WAVEMILL_DASHBOARD_PID]" -- \
  term_session_env_get wm WAVEMILL_DASHBOARD_PID
assert_argv "session_env_get all" "[show-environment][-t][wm]" -- term_session_env_get wm
assert_argv "session_env_set" "[set-environment][-t][wm][WAVEMILL_DASHBOARD_PID][123]" -- \
  term_session_env_set wm WAVEMILL_DASHBOARD_PID 123
reset_stub; TMUX_STDOUT="WAVEMILL_DASHBOARD_PID=123"
[[ "$(term_session_env_get wm WAVEMILL_DASHBOARD_PID)" == "123" ]] && pass "session_env_get prints the value" || fail "session_env_get prints the value" "$(term_session_env_get wm WAVEMILL_DASHBOARD_PID)"
reset_stub; TMUX_STDOUT="-WAVEMILL_DASHBOARD_PID"
if term_session_env_get wm WAVEMILL_DASHBOARD_PID >/dev/null; then fail "session_env_get fails when unset" "returned 0"; else pass "session_env_get fails when unset"; fi

# ── tmux-only helper ─────────────────────────────────────────────────────────

assert_argv "tmux_socket_path" "[display-message][-p][-t][@3][#{socket_path}]" -- term_tmux_socket_path @3

# ── Missing capability is a typed refusal, never a silent no-op ──────────────

(
  _TERM_BACKEND_CAPABILITIES=(host exit inspect capture attach session-env)
  reset_stub
  err="$(term_send_text @3 hi 2>&1 >/dev/null)"
  rc=$?
  if [[ "$rc" == 3 && "$err" == *"missing capability=input"*"reason=send_text"* && ! -s "$TMUX_LOG" ]]; then
    echo "ok missing input capability refuses send_text with a typed reason"
  else
    echo "not ok missing input capability refuses send_text with a typed reason"
    echo "  rc=$rc err=$err log=$(cat "$TMUX_LOG")" >&2
    exit 1
  fi
) && PASS=$((PASS + 1)) || FAIL=$((FAIL + 1))

# ── Legacy aliases keep their behaviour ──────────────────────────────────────

assert_argv "legacy _tmux_window_target_exists" "[display-message][-p][-t][@3][#{session_name}]" -- \
  _tmux_window_target_exists wm @3
[[ "$(_tmux_target_join wm 1)" == "wm:1" ]] && pass "legacy _tmux_target_join" || fail "legacy _tmux_target_join" "$(_tmux_target_join wm 1)"
assert_argv "legacy wavemill_set_tmux_pane_title" "[select-pane][-t][@3][-T][t]" -- wavemill_set_tmux_pane_title @3 t

# Task window resolution: the recorded windowId wins when it is live.
STATE_FILE_FIXTURE="$TEST_TMP/state.json"
fixture_workflow_state "$STATE_FILE_FIXTURE" HOK-1 windowId=@9
reset_stub; TMUX_STDOUT="wm"
resolved="$(_tmux_task_window_target wm HOK-1 slug "$STATE_FILE_FIXTURE")"
[[ "$resolved" == "@9" ]] && pass "task_window_target prefers the recorded windowId" || fail "task_window_target prefers the recorded windowId" "$resolved"

# The duplicate helpers must be defined only in the seam.
for helper in _tmux_window_target_exists _tmux_target_join _tmux_task_window_target wavemill_set_tmux_pane_title; do
  defs="$(grep -lE "^${helper}\(\)" "$REPO_DIR"/shared/lib/*.sh | sed "s|$REPO_DIR/||")"
  if [[ "$defs" == "shared/lib/terminal-backend.sh" ]]; then
    pass "$helper is defined only in the seam"
  else
    fail "$helper is defined only in the seam" "$defs"
  fi
done

# The seam never invokes tmux by absolute path.
if grep -nE '(/usr|/opt|/bin)[^ ]*/tmux ' "$REPO_DIR/shared/lib/terminal-backend.sh"; then
  fail "seam invokes tmux by command name" "absolute path found"
else
  pass "seam invokes tmux by command name"
fi

echo
echo "terminal-backend: $PASS passed, $FAIL failed"
[[ "$FAIL" == 0 ]]
