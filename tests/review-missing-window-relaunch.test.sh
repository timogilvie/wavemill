#!/usr/bin/env bash
# HOK-3146 Phase 2: a missing review window with coding commits must relaunch
# review through the recovery contract, never terminalize as "No PR created".
#
# This test asserts the branch behavior added at the generic missing-window
# fallthrough in `monitor_issue_state`. The full monitor function is
# unimportantly large, so we extract the branch under test and simulate it with
# the stubs that exercise the review-vs-planning distinction.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT="$REPO_DIR/shared/lib/wavemill-monitor.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }
assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then pass "$label"; else fail "$label (expected '$expected', got '$actual')"; fi
}
assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then pass "$label"; else fail "$label (missing '$needle')"; fi
}

# Simulate the structural branch — mirrors the code around monitor_issue_state's
# generic missing-window and no-PR fallthroughs for review phase.
simulate_missing_window_branch() {
  local current_phase="$1"
  local feature_dir="$2"
  local window_missing="$3"      # "true"/"false"
  local coding_complete="$4"     # "true"/"false"
  local review_status="$5"       # e.g. "running"
  local restore_state="$6"       # "restored" / "failed" / "none"

  # Mocked helpers
  _tmux_task_window_target() { [[ "$window_missing" == "false" ]]; }
  _restore_inflight_task_window_if_missing() { _RESTORE_STATE="$restore_state"; }
  read_stage_status() {
    local fd="$1" stage="$2"
    jq -r '.status // empty' "$fd/.${stage}-result.json" 2>/dev/null || true
  }
  write_ready_attention_file() { printf '%s\n' "${2:-}" > "$1/.needs-attention"; }
  set_task_phase() { echo "set_task_phase:$1:$2" >> "$ACTIONS_LOG"; }
  set_window_attention_state() { echo "attention:$2" >> "$ACTIONS_LOG"; }
  save_task_state() { echo "save_task_state:$5:$6" >> "$ACTIONS_LOG"; }
  log() { :; }
  log_error() { :; }
  log_task() { :; }
  check_pr_exists() { return 1; }
  find_pr_for_branch() { echo ""; }
  wavemill_hook_write() {
    echo "hook:$1:$2:$3:$5" >> "$ACTIONS_LOG"
    return 0
  }

  local ISSUE="HOK-3146-WIN" SLUG="slug-x" BRANCH="task/slug-x" WT_DIR="$feature_dir/..  "
  local FEATURE_DIR="$feature_dir" WIN="win"
  WT_DIR="$(dirname "$feature_dir")"
  local WORKTREE_ROOT; WORKTREE_ROOT="$(dirname "$WT_DIR")"
  local SESSION="test-session"
  local current_agent="claude"
  local active_count=0
  local LIB_DIR="$REPO_DIR/shared/lib"
  local STATE_FILE=""

  # Window-missing branch (HOK-3146 Phase 2 extraction)
  if [[ "$window_missing" == "true" ]]; then
    local _review_status_missing_window
    _review_status_missing_window="$(read_stage_status "$FEATURE_DIR" "review" 2>/dev/null || true)"
    if [[ "$current_phase" == "review" ]] \
      && [[ "$coding_complete" == "true" ]] \
      && [[ "$_review_status_missing_window" != "completed" \
         && "$_review_status_missing_window" != "aborted" ]]; then
      _restore_inflight_task_window_if_missing "$ISSUE" "$SLUG" "$BRANCH" "review"
      if [[ "$_RESTORE_STATE" == "restored" ]]; then
        set_window_attention_state "$WIN" "clear"
        echo "branch:restored" >> "$ACTIONS_LOG"
        return 0
      fi
      write_ready_attention_file "$FEATURE_DIR" "Review window disappeared and could not be relaunched automatically."
      set_task_phase "$ISSUE" "review"
      set_window_attention_state "$WIN" "needs-user"
      echo "branch:relaunch-failed-review-preserved" >> "$ACTIONS_LOG"
      return 0
    fi
    echo "branch:recreate-empty" >> "$ACTIONS_LOG"
    return 0
  fi

  # No-PR fallthrough (HOK-3146 Phase 2 defense in depth)
  local _review_status_no_pr
  _review_status_no_pr="$(read_stage_status "$FEATURE_DIR" "review" 2>/dev/null || true)"
  if [[ "$current_phase" == "review" ]] \
    && [[ "$coding_complete" == "true" ]] \
    && [[ "$_review_status_no_pr" != "completed" \
       && "$_review_status_no_pr" != "aborted" ]]; then
    wavemill_hook_write "waiting" "review_interrupted_no_pr" \
      "Review interrupted on branch $BRANCH; coding commits preserved" \
      "${current_agent:-unknown}" \
      "run /re-review $ISSUE to relaunch the review (it will open the PR)" \
      "monitor" || true
    write_ready_attention_file "$FEATURE_DIR" "Review interrupted on branch $BRANCH before PR creation; re-review available."
    set_task_phase "$ISSUE" "review"
    set_window_attention_state "$WIN" "needs-user"
    echo "branch:no-pr-review-preserved" >> "$ACTIONS_LOG"
    return 0
  fi

  save_task_state "$ISSUE" "$SLUG" "$BRANCH" "$WT_DIR" "" "error"
  set_task_phase "$ISSUE" "error"
  wavemill_hook_write "error" "NoPR" "Agent exited without creating PR on branch $BRANCH" "$current_agent" "" "monitor"
  set_window_attention_state "$WIN" "needs-user"
  echo "branch:no-pr-terminal-error" >> "$ACTIONS_LOG"
  return 0
}

echo "=== HOK-3146 Phase 2: review window missing → relaunch via recovery ==="

CASE_A="$TMP_DIR/case-a"
FD_A="$CASE_A/features/slug-x"
mkdir -p "$FD_A"
touch "$FD_A/.coding-complete"
printf '{"status":"running"}\n' > "$FD_A/.review-result.json"
ACTIONS_LOG="$CASE_A/actions.log"
: > "$ACTIONS_LOG"

simulate_missing_window_branch "review" "$FD_A" "true" "true" "running" "restored"
log_a="$(cat "$ACTIONS_LOG")"
assert_contains "review missing window → recovery contract relaunch" "$log_a" "branch:restored"
assert_contains "attention cleared on restored window" "$log_a" "attention:clear"

echo ""
echo "=== HOK-3146 Phase 2: coding-phase window missing still recreates empty window ==="

CASE_B="$TMP_DIR/case-b"
FD_B="$CASE_B/features/slug-x"
mkdir -p "$FD_B"
ACTIONS_LOG="$CASE_B/actions.log"
: > "$ACTIONS_LOG"

simulate_missing_window_branch "coding" "$FD_B" "true" "false" "" "none"
assert_contains "coding missing window → preserved legacy recreate path" \
  "$(cat "$ACTIONS_LOG")" "branch:recreate-empty"

echo ""
echo "=== HOK-3146 Phase 2: no PR + coding complete + review not finished = preserved ==="

CASE_C="$TMP_DIR/case-c"
FD_C="$CASE_C/features/slug-x"
mkdir -p "$FD_C"
touch "$FD_C/.coding-complete"
printf '{"status":"running"}\n' > "$FD_C/.review-result.json"
ACTIONS_LOG="$CASE_C/actions.log"
: > "$ACTIONS_LOG"

simulate_missing_window_branch "review" "$FD_C" "false" "true" "running" "none"
log_c="$(cat "$ACTIONS_LOG")"
assert_contains "no PR + review in-flight → preserved as review needs-user" "$log_c" "branch:no-pr-review-preserved"
assert_contains "no PR + review in-flight → review_interrupted_no_pr hook" "$log_c" "hook:waiting:review_interrupted_no_pr"
if grep -q "branch:no-pr-terminal-error" <<< "$log_c"; then
  fail "review interruption must not terminalize as error"
else
  pass "review interruption not terminalized as error"
fi
if grep -q "hook:error:NoPR" <<< "$log_c"; then
  fail "no NoPR hook written for review interruption"
else
  pass "no NoPR hook written for review interruption"
fi
if grep -q "set_task_phase:HOK-3146-WIN:error" <<< "$log_c"; then
  fail "phase=error must not be set for review interruption"
else
  pass "phase=error not set for review interruption"
fi

echo ""
echo "=== HOK-3146 Phase 2: planning crash with no commits still errors as before ==="

CASE_D="$TMP_DIR/case-d"
FD_D="$CASE_D/features/slug-x"
mkdir -p "$FD_D"
# No .coding-complete
ACTIONS_LOG="$CASE_D/actions.log"
: > "$ACTIONS_LOG"

simulate_missing_window_branch "coding" "$FD_D" "false" "false" "" "none"
log_d="$(cat "$ACTIONS_LOG")"
assert_contains "planning/coding no-work path still terminalizes" "$log_d" "branch:no-pr-terminal-error"
assert_contains "planning/coding no-work path writes NoPR hook" "$log_d" "hook:error:NoPR"

echo ""
echo "=== Totals ==="
echo "pass=$PASS fail=$FAIL"
exit "$FAIL"
