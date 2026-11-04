#!/usr/bin/env bash
# HOK-2579: mill_pane_has_live_blocking_process() used to export the full
# `ps -p <pid> -o command=` string in MILL_BLOCKING_PROCESS_COMMAND. Codex
# Computer Use descendants can carry a serialized turn-ended event — including
# the complete coding prompt — in their argv, so that raw command line
# reached the mill status log, dashboard, and hook `next_action`/`detail`.
#
# This test spawns a real descendant process whose argv embeds a multi-line,
# JSON-shaped payload (standing in for a leaked coding prompt), then asserts:
#   - the internal liveness matcher still matches `blockingChecks` against
#     the FULL command line (acceptance criterion 2);
#   - the exported MILL_BLOCKING_PROCESS_COMMAND is a bounded, single-line,
#     secret-safe identity — never the raw argv (acceptance criterion 1, 3).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

check_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass "$label"
  else
    fail "$label (expected '$expected', got '$actual')"
  fi
}

check_not_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    pass "$label"
  else
    fail "$label (unexpectedly found '$needle' in '$haystack')"
  fi
}

check_matches() {
  local label="$1" value="$2" pattern="$3"
  if [[ "$value" =~ $pattern ]]; then
    pass "$label"
  else
    fail "$label (value '$value' did not match pattern '$pattern')"
  fi
}

# shellcheck source=../shared/lib/wavemill-common.sh
source "$REPO_DIR/shared/lib/wavemill-common.sh"

SLEEPER_PID=""
cleanup() {
  if [[ -n "$SLEEPER_PID" ]]; then
    kill "$SLEEPER_PID" 2>/dev/null || true
    wait "$SLEEPER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# A real child process whose argv embeds a multi-line, JSON-shaped payload —
# standing in for a Codex Computer Use descendant's serialized turn-ended
# event (which can carry the complete coding prompt). The extra positional
# argument is unused by the script but still lands in the process's real
# argv, so `ps -p <pid> -o command=` reports it (a BSD `sleep` rejects extra
# arguments directly, so the payload rides along on the `bash -c` invocation
# instead of being passed to `sleep` itself).
PROMPT_LEAK_PAYLOAD=$'{"turn-ended":"input-messages: do the task\nsecret prompt line 2"}'
bash -c 'sleep 300' bash "$PROMPT_LEAK_PAYLOAD" &
SLEEPER_PID=$!

# Keep the test independent of tmux / the real pane tree: the mill's own
# descendant-collection is covered elsewhere (wavemill_collect_descendant_pids
# tests); here we only need a controllable PID with a hostile argv.
wavemill_collect_descendant_pids() {
  printf '%s\n' "$SLEEPER_PID"
}

# --- Case A: blockingChecks non-empty, match found ---------------------
MILL_BLOCKING_PROCESS_COMMAND=""
rc=0
mill_pane_has_live_blocking_process "$$" "sleep 300" || rc=$?
check_eq "case A: matcher returns 0 (internal match against full command line)" "0" "$rc"
check_eq "case A: redacted identity names matched check and pid" "sleep 300 (pid $SLEEPER_PID)" "$MILL_BLOCKING_PROCESS_COMMAND"
check_not_contains "case A: no JSON brace leaked" "$MILL_BLOCKING_PROCESS_COMMAND" "{"
check_not_contains "case A: no newline leaked" "$MILL_BLOCKING_PROCESS_COMMAND" $'\n'
check_not_contains "case A: no prompt text leaked" "$MILL_BLOCKING_PROCESS_COMMAND" "secret prompt"

# --- Case B: blockingChecks empty, fall back to any live descendant ----
MILL_BLOCKING_PROCESS_COMMAND=""
rc=0
mill_pane_has_live_blocking_process "$$" || rc=$?
check_eq "case B: fallback returns 0 (a live descendant exists)" "0" "$rc"
check_matches "case B: redacted identity is bounded basename+pid" "$MILL_BLOCKING_PROCESS_COMMAND" '^[A-Za-z0-9_.-]+ \(pid [0-9]+\)$'
check_not_contains "case B: no JSON brace leaked" "$MILL_BLOCKING_PROCESS_COMMAND" "{"
check_not_contains "case B: no newline leaked" "$MILL_BLOCKING_PROCESS_COMMAND" $'\n'
check_not_contains "case B: no prompt text leaked" "$MILL_BLOCKING_PROCESS_COMMAND" "secret prompt"

# --- Case C: no descendants -> indeterminate/no-match contract intact --
wavemill_collect_descendant_pids() {
  return 0
}
MILL_BLOCKING_PROCESS_COMMAND=""
rc=0
mill_pane_has_live_blocking_process "$$" "sleep 300" || rc=$?
check_eq "case C: no descendants returns 1" "1" "$rc"
check_eq "case C: no identity emitted" "" "$MILL_BLOCKING_PROCESS_COMMAND"

echo ""
if [[ "$FAIL" -eq 0 ]]; then
  echo "All $PASS blocked-completion redaction tests passed"
else
  echo "$FAIL blocked-completion redaction tests failed ($PASS passed)"
  exit 1
fi
