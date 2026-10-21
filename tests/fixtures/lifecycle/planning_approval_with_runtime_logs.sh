#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154

register_lifecycle_scenario planning_approval_with_runtime_logs

setup_planning_approval_with_runtime_logs() {
  create_git_worktree
  CURRENT_PHASE="planning"
  MONITOR_ITERATIONS=2
  write_stage_result "$FEATURE_DIR" "planning" "awaiting_user" "$CURRENT_AGENT"
  printf "plan\n" > "$FEATURE_DIR/plan.md"
  # HOK-3253: approval is only offered once the inputs are a valid packet.
  printf "## 1. Objective\nruntime logs\n" > "$FEATURE_DIR/task-packet.md"
  touch "$FEATURE_DIR/.plan-approved"
  mkdir -p "$WT_DIR/.wavemill/logs" "$WT_DIR/.wavemill/evals"
  printf "{\"warning\":\"linear\"}\n" > "$WT_DIR/.wavemill/logs/linear-validation-warnings.jsonl"
  printf "{\"prompt\":\"registry\"}\n" > "$WT_DIR/.wavemill/evals/prompt-registry.jsonl"
}

assert_planning_approval_with_runtime_logs() {
  local output="$1"
  local feature_dir wt_dir
  feature_dir="$(awk -F= '/^feature_dir=/{print substr($0, index($0,$2))}' <<< "$output")"
  wt_dir="$(awk -F= '/^wt_dir=/{print substr($0, index($0,$2))}' <<< "$output")"

  check_contains "runtime logs allow planning to reach coding" "$output" "phase=coding"
  check_contains "runtime logs scenario completes planning" "$output" "|planning|completed|"
  check_contains "runtime logs scenario starts coding" "$output" "|coding|running|"
  check_contains "runtime logs scenario launches coding" "$output" "coding_launches=1"
  check_not_contains "runtime logs do not trigger source warning" "$output" "modified source code"
  check_file_exists "runtime log fixture remains present" "$wt_dir/.wavemill/logs/linear-validation-warnings.jsonl"
  check_file_exists "planning approval result persisted" "$feature_dir/.planning-result.json"
}
