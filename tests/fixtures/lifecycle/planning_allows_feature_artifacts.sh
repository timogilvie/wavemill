#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154

register_lifecycle_scenario planning_allows_feature_artifacts

setup_planning_allows_feature_artifacts() {
  create_git_worktree
  CURRENT_PHASE="planning"
  MONITOR_ITERATIONS=2
  write_stage_result "$FEATURE_DIR" "planning" "awaiting_user" "$CURRENT_AGENT"
  printf "plan\n" > "$FEATURE_DIR/plan.md"
  # HOK-3253: approval is only offered once the inputs are a valid packet.
  printf "## 1. Objective\npacket\n" > "$FEATURE_DIR/task-packet.md"
  printf "header\n" > "$FEATURE_DIR/task-packet-header.md"
  printf "{}\n" > "$FEATURE_DIR/.initial-route.json"
  touch "$FEATURE_DIR/.plan-approved"
}

assert_planning_allows_feature_artifacts() {
  local output="$1"
  local feature_dir
  feature_dir="$(awk -F= '/^feature_dir=/{print substr($0, index($0,$2))}' <<< "$output")"

  check_contains "feature artifacts allow coding transition" "$output" "phase=coding"
  check_contains "feature artifacts complete planning" "$output" "|planning|completed|"
  check_contains "feature artifacts start coding" "$output" "|coding|running|"
  check_file_content "plan artifact remains" "plan" "$feature_dir/plan.md"
  check_file_exists "task packet remains" "$feature_dir/task-packet.md"
  check_file_exists "route artifact remains" "$feature_dir/.initial-route.json"
}
