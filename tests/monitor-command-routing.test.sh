#!/usr/bin/env bash
# Two operator-recovery paths that silently never ran:
#   1. `re-review <ID>` typed at the backlog prompt was parsed as a numeric
#      selection ("Invalid selection: re-review") and never reached
#      handle_re_review_command.
#   2. (moved) review-infra re-arm on a new head is covered by
#      tests/condition-reconciler.test.sh since HOK-3172.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT="$REPO_DIR/shared/lib/wavemill-monitor.sh"
BOUNDED_RETRY="$REPO_DIR/shared/lib/bounded-retry.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

extract_function() {
  local function_name="$1"
  awk -v name="$function_name" '
    function brace_delta(line, stripped, opens, closes) {
      stripped = line
      gsub(/"([^"\\]|\\.)*"/, "\"\"", stripped)
      gsub(/\047([^\047\\]|\\.)*\047/, "\047\047", stripped)
      opens = gsub(/\{/, "{", stripped)
      closes = gsub(/\}/, "}", stripped)
      return opens - closes
    }
    $0 ~ "^" name "\\(\\)[[:space:]]*\\{" { capture = 1; depth = 0 }
    capture {
      print
      depth += brace_delta($0)
      if (depth == 0) exit
    }
  ' "$MONITOR_SCRIPT"
}

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }
assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then pass "$label"; else fail "$label (expected '$expected', got '$actual')"; fi
}

FUNCS_FILE="$TMP_DIR/funcs.sh"
: > "$FUNCS_FILE"
for fn in monitor_reply_is_task_command normalize_prompt_command_reply; do
  extract_function "$fn" >> "$FUNCS_FILE"
  printf '\n' >> "$FUNCS_FILE"
done

source "$BOUNDED_RETRY"
source "$FUNCS_FILE"

echo "=== backlog prompt routes task commands ==="
routes() { monitor_reply_is_task_command "$(normalize_prompt_command_reply "$1")" && echo yes || echo no; }
assert_eq "re-review routes to the command handler" "yes" "$(routes "re-review HOK-3138")"
assert_eq "advance routes to the command handler" "yes" "$(routes "advance HOK-3138")"
assert_eq "numeric selection stays a selection" "no" "$(routes "select 1 3")"
assert_eq "bare re-review is not a task command" "no" "$(routes "re-review")"

# The backlog prompt must dispatch through the helper, not a hard-coded
# `advance` match that drops other task commands into numeric selection.
if grep -q 'elif monitor_reply_is_task_command "\$REPLY"; then' "$MONITOR_SCRIPT"; then
  pass "backlog prompt dispatches via monitor_reply_is_task_command"
else
  fail "backlog prompt dispatches via monitor_reply_is_task_command"
fi

# The review-infra re-arm-on-new-head checks moved to
# tests/condition-reconciler.test.sh with HOK-3172, which replaced the inline
# reset helper with the condition reconciler.

echo ""
echo "=== Totals ==="
echo "pass=$PASS fail=$FAIL"
exit "$FAIL"
