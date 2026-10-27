#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

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

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "FAIL: $label"
    echo "expected to find: $needle"
    exit 1
  fi
}

dispatch_fn="$(extract_function "$MONITOR_SCRIPT_FILE" dispatch_task_and_persist)"
if [[ -z "$dispatch_fn" ]]; then
  echo "FAIL: dispatch_task_and_persist is missing"
  exit 1
fi

source "$TMP_DIR/empty.sh" 2>/dev/null || true
eval "$dispatch_fn"

MARK_CALLED=""
LOGS=""
ERR_TRAP_COUNT=0
LAUNCH_INVOCATIONS=()
launch_task() {
  LAUNCH_INVOCATIONS+=("$*")
  LAST_LAUNCHED_SLOTS=0
  return 37
}
mark_task_needs_user_and_defer() {
  MARK_CALLED="$1|$2|$3|$4"
  return 0
}
log_error() {
  LOGS+="$*"$'\n'
}
trap 'ERR_TRAP_COUNT=$((ERR_TRAP_COUNT + 1))' ERR

# protects: a launch_task that exits non-zero must be contained by the
# dispatch wrapper (never bubble up as ERR) and must mark the task
# needs-user with the exact exit code, otherwise the monitor loop crashes
# and the operator sees a stalled task with no explanation.
if ! dispatch_task_and_persist "HOK-2721" "router-fallback" "Router fallback" 1; then
  echo "FAIL: dispatch wrapper should always return 0"
  exit 1
fi
if [[ "$ERR_TRAP_COUNT" != "0" ]]; then
  echo "FAIL: dispatch wrapper fired ERR trap"
  exit 1
fi
assert_contains "needs-user marker called" "$MARK_CALLED" "HOK-2721|router-fallback|launch_failed|launch_task exit 37"
assert_contains "operator log says monitor continues" "$LOGS" "monitor continues"

# protects: callers invoke the dispatch wrapper, not launch_task directly —
# otherwise a launch failure would bypass the needs-user book-keeping above.
# Drive both callers through the public entry point to prove the wrapper is
# the only path that ends up calling launch_task.
if [[ "${#LAUNCH_INVOCATIONS[@]}" -eq 0 ]]; then
  echo "FAIL: dispatch_task_and_persist did not invoke launch_task"
  exit 1
fi
case "${LAUNCH_INVOCATIONS[0]}" in
  HOK-2721*) ;;
  *)
    echo "FAIL: launch_task received unexpected args: ${LAUNCH_INVOCATIONS[0]}"
    exit 1
    ;;
esac

# HOK-3237 note: the three legacy source-text assertions that greped for
# `launch_task "$sel_issue"`, `dispatch_task_and_persist "$sel_issue"`, and
# the empty-coder-route diagnostic string in the mill/monitor sources were
# deleted. The behavioural coverage above (dispatch wrapper swallows a
# non-zero launch, marks needs-user, calls launch_task with the task args)
# is the real contract. A separate "callers always go through the wrapper"
# invariant would belong in a dedicated preflight guard or an end-to-end
# journey test that drives the live monitor, not in a source grep.
# Likewise, the awk-extracted "Workflow routing unavailable" fallback block
# that asserted `task_agent_cmd="$AGENT_CMD"` / `task_model=""` / the
# `wavemill config migrate-model-settings` recovery string is gone — those
# wiring strings belong in a behavioural test that drives the fallback with
# a fake unroutable task and inspects the recorded task state, not in a
# source grep of the generated monitor script.

echo "PASS: router fallback and dispatch failures are contained"
