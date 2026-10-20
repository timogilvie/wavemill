#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154

register_lifecycle_scenario planning_late_migration_detected

setup_planning_late_migration_detected() {
  create_git_worktree
  CURRENT_PHASE="planning"
  MONITOR_ITERATIONS=2
  write_stage_result "$FEATURE_DIR" "planning" "awaiting_user" "$CURRENT_AGENT"
  printf "plan\n" > "$FEATURE_DIR/plan.md"
  # HOK-3253: approval is only offered once the inputs are a valid packet.
  printf "## 1. Objective\nfixture\n" > "$FEATURE_DIR/task-packet.md"
  touch "$FEATURE_DIR/.plan-approved"
  touch "$FEATURE_DIR/.migration-detected"
  cat > "$STATE_FILE" <<JSON
{"tasks":{},"nextMigrationNum":5}
JSON
}

assert_planning_late_migration_detected() {
  local output="$1"
  local feature_dir
  feature_dir="$(awk -F= '/^feature_dir=/{print substr($0, index($0,$2))}' <<< "$output")"

  check_contains "late migration reaches coding" "$output" "phase=coding"
  check_file_content "late migration writes assigned number" "5" "$feature_dir/.migration-number"
  check_contains "late migration persists reservation call" "$output" "save_migration_calls=HOK-1294|5;"
}
