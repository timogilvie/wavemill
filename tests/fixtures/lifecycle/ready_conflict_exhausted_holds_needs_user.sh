#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154

# HOK-3273: the one resolver for this (head, base) launched, exited without a
# push, and the re-run Ready still saw a conflict, so the budget terminalized.
# The arm holds at needs-user until a new commit, base or operator event; it
# does not re-run Ready every tick.
register_lifecycle_scenario ready_conflict_exhausted_holds_needs_user

setup_ready_conflict_exhausted_holds_needs_user() {
  CURRENT_PHASE="ready"
  PR="528"
  PR_BY_ISSUE["$ISSUE"]="$PR"
  REQUIRE_CONFIRM="false"
  MAIN_SHA_RETURN=""

  create_git_worktree
  write_stage_result "$FEATURE_DIR" "review" "completed" "$CURRENT_AGENT"

  local ready_dir current_head
  ready_dir="$(ready_state_dir "${WORKTREE_ROOT}/${SLUG}" "$SLUG")"
  mkdir -p "$ready_dir"
  current_head="$(git -C "$WT_DIR" rev-parse HEAD)"
  cat > "$ready_dir/.ready-result.json" <<JSON
{"stage":"ready","status":"running","artifacts":{"type":"ready","prNumber":528,"mergeConflict":"CONFLICTED","launchHead":"stale-head"}}
JSON
  printf '%s\n' "1" > "$ready_dir/.retry-conflict-remediation-relaunch-count"
  printf '%s\n' "$current_head" > "$ready_dir/.retry-conflict-remediation-relaunch-head"
  bounded_retry_mark_exhausted "$ready_dir" "conflict-remediation-relaunch" \
    "Conflict remediation exhausted on identical (head=$current_head, base=) for PR #528"
}

assert_ready_conflict_exhausted_holds_needs_user() {
  local output="$1"
  local scenario_dir ready_dir
  scenario_dir="$(printf '%s\n' "$output" | awk -F= '$1=="scenario_dir"{print $2}')"
  ready_dir="$scenario_dir/worktrees/ready_conflict_exhausted_holds_needs_user/features/ready_conflict_exhausted_holds_needs_user/ready"

  check_contains "exhausted conflict budget does not relaunch ready" "$output" "ready_launches=0"
  check_contains "exhausted conflict budget holds at needs-user" "$output" "attention=needs-user"
  check_file_exists "exhausted conflict budget keeps its sentinel" "$ready_dir/.retry-conflict-remediation-relaunch-exhausted"
}
