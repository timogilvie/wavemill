#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154
# HOK-3506 (review finding): a sealed plan-stage PAIR whose challenger task
# never actually exists in state must collapse to single without ever
# stamping the primary's own task row as part of a pair.
#
# A launch-time race/failure between sealing a pair and spawning its second
# task can leave --resolve-sealed returning status=materialize (the sealed
# challenger is still launchable) even though no HOK-1294_c task row was
# ever created. The pre-review version of this finalizer called
# save_task_state(challenge=true, role=primary, challengePairId=issue) on the
# primary unconditionally, *before* checking whether the challenger task
# existed, then only collapsed the execution-intent JSON in the else branch —
# leaving the primary's task row permanently stamped as half of a phantom
# pair. Fixed by checking challenger existence before stamping the primary.

register_lifecycle_scenario sealed_pair_with_missing_challenger_task_collapses_to_single

setup_sealed_pair_with_missing_challenger_task_collapses_to_single() {
  create_git_worktree
  CURRENT_PHASE="planning"
  MONITOR_ITERATIONS=2

  printf "## 1. Objective\npacket\n" > "$FEATURE_DIR/task-packet.md"
  printf "header\n" > "$FEATURE_DIR/task-packet-header.md"
  printf "plan\n" > "$FEATURE_DIR/plan.md"
  printf '{"planner":"claude-opus-4-8","coder":"claude-sonnet-5","reviewer":"claude-sonnet-5","planDepth":"deep","codeDepth":"deep","reviewMode":"llm"}\n' > "$FEATURE_DIR/.initial-route.json"
  printf '{"planner":"claude-opus-4-8","coder":"claude-sonnet-5","reviewer":"claude-sonnet-5","planDepth":"deep","codeDepth":"deep","reviewMode":"llm"}\n' > "$FEATURE_DIR/.post-expansion-route.json"
  touch "$FEATURE_DIR/.plan-approved"

  write_stage_result "$FEATURE_DIR" "planning" "awaiting_user" "$CURRENT_AGENT"

  # --resolve-sealed shells out to the real resolve-challenge-task.ts, which
  # needs challenge.enabled and a default agent to check the sealed
  # challenger's launchability.
  printf '{"challenge":{"enabled":true},"router":{"defaultAgent":"claude"}}\n' > "$REPO_DIR/.wavemill-config.json"

  # Seal a plan-stage PAIR. The challenger key (HOK-1294_c) is named in the
  # seal and is launchable (claude-haiku-4-5-20251001), so --resolve-sealed
  # returns status=materialize — but no HOK-1294_c task row is ever added to
  # $STATE_FILE, simulating the launch-time race this branch defends against.
  local pair_intent
  pair_intent='{"schemaVersion":1,"pairId":"HOK-1294","issueId":"HOK-1294","selectedStage":"plan","challengeStage":"plan","decisionSource":"bootstrap","primary":{"key":"HOK-1294","role":"primary","planner":{"model":"bootstrap-planner","agent":"claude"},"coder":{"model":"bootstrap-coder","agent":"claude"},"reviewer":{"model":"bootstrap-reviewer","agent":"claude"}},"challenger":{"key":"HOK-1294_c","role":"challenger","planner":{"model":"claude-haiku-4-5-20251001","agent":"claude"},"coder":{"model":"bootstrap-coder","agent":"claude"},"reviewer":{"model":"bootstrap-reviewer","agent":"claude"}}}'
  jq --arg issue "$ISSUE" --argjson intent "$pair_intent" \
    '.tasks[$issue].challengeExecutionIntent = $intent' \
    "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
}

assert_sealed_pair_with_missing_challenger_task_collapses_to_single() {
  local output="$1"
  local scenario_dir
  scenario_dir="$(awk -F= '/^scenario_dir=/{print substr($0, index($0,$2))}' <<< "$output")"

  check_contains "planning completes and coding launches" "$output" "phase=coding"
  check_contains "collapse logged (challenger_task_missing)" "$output" \
    "sealed challenge collapsed (challenger_task_missing)"
  # The review-found bug: save_task_state was called to stamp the primary as
  # a paired challenge task (challenge=true, role=primary, pairId=HOK-1294)
  # before the challenger's existence was checked, and was never reverted
  # once the else branch ran. Its args are recorded verbatim in
  # save_task_calls; the fixed finalizer never makes this call at all when
  # the challenger task doesn't exist.
  check_not_contains "primary never stamped as a paired challenge task" "$output" \
    "true HOK-1294 primary"
  check_eq "collapse reason recorded on the execution intent" "challenger_task_missing" \
    "$(jq -r '.tasks["HOK-1294"].challengeExecutionIntent.challengeCollapseReason // ""' "$scenario_dir/workflow-state.json")"
  check_eq "no challenger task materialised" "" \
    "$(jq -r '.tasks["HOK-1294_c"].slug // ""' "$scenario_dir/workflow-state.json")"
}
