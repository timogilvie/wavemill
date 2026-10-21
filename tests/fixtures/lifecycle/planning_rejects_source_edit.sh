#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154

register_lifecycle_scenario planning_rejects_source_edit

setup_planning_rejects_source_edit() {
  create_git_worktree
  CURRENT_PHASE="planning"
  write_stage_result "$FEATURE_DIR" "planning" "awaiting_user" "$CURRENT_AGENT"
  printf "plan\n" > "$FEATURE_DIR/plan.md"
  # HOK-3253: approval is only offered once the inputs are a valid packet.
  printf "## 1. Objective\nfixture\n" > "$FEATURE_DIR/task-packet.md"
  touch "$FEATURE_DIR/.plan-approved"
  mkdir -p "$WT_DIR/src"
  printf "export const value = 1;\n" > "$WT_DIR/src/new-feature.ts"
}

assert_planning_rejects_source_edit() {
  local output="$1"
  local feature_dir wt_dir
  feature_dir="$(awk -F= '/^feature_dir=/{print substr($0, index($0,$2))}' <<< "$output")"
  wt_dir="$(awk -F= '/^wt_dir=/{print substr($0, index($0,$2))}' <<< "$output")"

  check_contains "source edit keeps planning active" "$output" "phase=planning"
  check_contains "source edit returns planning to awaiting_user" "$output" "|planning|awaiting_user|"
  check_contains "source edit requests user attention" "$output" "attention=needs-user"
  check_contains "source edit logs boundary warning" "$output" "modified source code"
  check_file_absent "source overreach is reverted" "$wt_dir/src/new-feature.ts"
  check_file_absent "approval marker removed after source edit" "$feature_dir/.plan-approved"
  check_file_exists "planning rejection artifact is written" "$feature_dir/.planning-rejected.json"
  check_eq "planning rejection reason is explicit" "planning_modified_out_of_scope_files" "$(jq -r '.reason' "$feature_dir/.planning-rejected.json")"
  check_eq "planning rejection records edited file" "src/new-feature.ts" "$(jq -r '.outOfScopeFiles[0]' "$feature_dir/.planning-rejected.json")"
}
