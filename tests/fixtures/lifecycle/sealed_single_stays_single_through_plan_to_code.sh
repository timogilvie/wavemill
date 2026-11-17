#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154
# HOK-3506: a sealed single-model launch must stay single through finalization.

register_lifecycle_scenario sealed_single_stays_single_through_plan_to_code

setup_sealed_single_stays_single_through_plan_to_code() {
  create_git_worktree
  CURRENT_PHASE="planning"
  MONITOR_ITERATIONS=2

  # Valid expanded packet + plan approval so the planning→coding transition runs.
  printf "## 1. Objective\npacket\n" > "$FEATURE_DIR/task-packet.md"
  printf "header\n" > "$FEATURE_DIR/task-packet-header.md"
  printf "plan\n" > "$FEATURE_DIR/plan.md"
  printf '{"planner":"claude-opus-4-8","coder":"claude-sonnet-5","reviewer":"claude-sonnet-5","planDepth":"deep","codeDepth":"deep","reviewMode":"llm"}\n' > "$FEATURE_DIR/.initial-route.json"
  printf '{"planner":"claude-opus-4-8","coder":"claude-sonnet-5","reviewer":"claude-sonnet-5","planDepth":"deep","codeDepth":"deep","reviewMode":"llm"}\n' > "$FEATURE_DIR/.post-expansion-route.json"
  touch "$FEATURE_DIR/.plan-approved"

  write_stage_result "$FEATURE_DIR" "planning" "awaiting_user" "$CURRENT_AGENT"

  # Seal a single-model launch decision in state. The expanded route above
  # would normally be eligible for a plan-stage pair, but finalization must
  # honour the sealed single and never rerun the lottery.
  local single_intent
  single_intent='{"schemaVersion":1,"pairId":"HOK-1294","issueId":"HOK-1294","selectedStage":"plan","challengeStage":"plan","decisionSource":"bootstrap","selectionPath":"random-roll","noChallengeReason":"roll_not_selected","primary":{"key":"HOK-1294","role":"primary","planner":{"model":"claude-opus-4-8","agent":"claude"},"coder":{"model":"claude-sonnet-5","agent":"claude"},"reviewer":{"model":"claude-sonnet-5","agent":"claude"}}}'
  jq --arg issue "$ISSUE" --argjson intent "$single_intent" \
    '.tasks[$issue].challengeExecutionIntent = $intent' \
    "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
}

assert_sealed_single_stays_single_through_plan_to_code() {
  local output="$1"
  local scenario_dir
  scenario_dir="$(awk -F= '/^scenario_dir=/{print substr($0, index($0,$2))}' <<< "$output")"

  check_contains "planning completes and coding launches" "$output" "phase=coding"
  check_not_contains "no phantom challenger_never_launched log" "$output" "challenger_never_launched"
  check_not_contains "no challenge collapse reason" "$output" "challengeCollapseReason"
  check_eq "task stays single (not a challenge)" "false" "$(jq -r '.tasks["HOK-1294"].challenge // "false"' "$scenario_dir/workflow-state.json")"
  check_eq "sealed single intent survives finalization" "roll_not_selected" "$(jq -r '.tasks["HOK-1294"].challengeExecutionIntent.noChallengeReason // ""' "$scenario_dir/workflow-state.json")"
  check_eq "no challenger task materialised" "" "$(jq -r '.tasks["HOK-1294_c"].slug // ""' "$scenario_dir/workflow-state.json")"
}
