#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154

register_lifecycle_scenario planning_missing_plan_stays_awaiting

setup_planning_missing_plan_stays_awaiting() {
  CURRENT_PHASE="planning"
  write_stage_result "$FEATURE_DIR" "planning" "running" "$CURRENT_AGENT"
  printf "plan\n" > "$FEATURE_DIR/plan.md"
  # HOK-3253: approval is only offered once the inputs are a valid packet.
  printf "## 1. Objective\nfixture\n" > "$FEATURE_DIR/task-packet.md"
}

assert_planning_missing_plan_stays_awaiting() {
  local output="$1"

  check_contains "plan without approval stays in planning" "$output" "phase=planning"
  check_contains "plan without approval marks awaiting_user" "$output" "|planning|awaiting_user|"
  check_contains "plan without approval asks for attention" "$output" "attention=needs-user"
  check_not_contains "plan without approval does not launch coding" "$output" "coding_launches=1"
}
