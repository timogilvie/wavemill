#!/usr/bin/env bash
# Two operator-recovery paths that silently never ran:
#   1. `re-review <ID>` typed at the backlog prompt was parsed as a numeric
#      selection ("Invalid selection: re-review") and never reached
#      handle_re_review_command.
#   2. Once review-infra-recovery terminalized, the pending-ready halt kept the
#      arm halted across new commits, because it checked the exhausted sentinel
#      before the head-keyed gate could reset it (HOK-2924).

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
for fn in monitor_reply_is_task_command normalize_prompt_command_reply review_infra_recovery_reset_if_new_head; do
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

echo "=== review-infra exhaustion re-arms on a new head ==="
OLD_HEAD="54f598df95ed0ac47db56b30583b492a68b12536"
NEW_HEAD="b7f1b36020b5adb5f90f06b4f625762a0e6a2445"
seed_exhausted() {
  local dir="$1"
  rm -rf "$dir"; mkdir -p "$dir"
  bounded_retry_increment "$dir" "review-infra-recovery" "${OLD_HEAD}:review-tool-error" >/dev/null
  bounded_retry_increment "$dir" "review-infra-recovery" "${OLD_HEAD}:review-tool-error" >/dev/null
  bounded_retry_mark_exhausted "$dir" "review-infra-recovery" "Review infrastructure recovery exhausted after 2 attempt(s)"
  bounded_retry_mark_exhausted "$dir" "pending-ready-recheck" \
    "Review infrastructure recovery is exhausted for PR #1583; pending-ready halted until the review artifact changes"
}
exhausted() { bounded_retry_is_exhausted "$1" "$2" && echo yes || echo no; }

STATE="$TMP_DIR/new-head"
seed_exhausted "$STATE"
review_infra_recovery_reset_if_new_head "$STATE" "$NEW_HEAD"
assert_eq "new head clears review-infra exhaustion" "no" "$(exhausted "$STATE" review-infra-recovery)"
assert_eq "new head lifts the lockstep pending-ready halt" "no" "$(exhausted "$STATE" pending-ready-recheck)"
assert_eq "new head resets the attempt count" "0" "$(bounded_retry_count "$STATE" review-infra-recovery)"

STATE="$TMP_DIR/same-head"
seed_exhausted "$STATE"
review_infra_recovery_reset_if_new_head "$STATE" "$OLD_HEAD"
assert_eq "same head keeps review-infra exhausted" "yes" "$(exhausted "$STATE" review-infra-recovery)"
assert_eq "same head keeps pending-ready halted" "yes" "$(exhausted "$STATE" pending-ready-recheck)"

STATE="$TMP_DIR/empty-head"
seed_exhausted "$STATE"
review_infra_recovery_reset_if_new_head "$STATE" ""
assert_eq "unknown head (git failure) never resets" "yes" "$(exhausted "$STATE" review-infra-recovery)"

STATE="$TMP_DIR/foreign-halt"
seed_exhausted "$STATE"
rm -f "$STATE/.retry-pending-ready-recheck-exhausted"
bounded_retry_mark_exhausted "$STATE" "pending-ready-recheck" "Ready re-check budget exhausted after 3 attempt(s)"
review_infra_recovery_reset_if_new_head "$STATE" "$NEW_HEAD"
assert_eq "a pending-ready halt from another cause is left alone" "yes" "$(exhausted "$STATE" pending-ready-recheck)"

echo ""
echo "=== Totals ==="
echo "pass=$PASS fail=$FAIL"
exit "$FAIL"
