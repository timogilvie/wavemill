#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154
# HOK-3506: a sealed single-model launch must stay single through finalization.
#
# Anchored to the real HOK-3469 incident from the Nov 9-17 corpus audit:
# launch sealed HOK-3469 single (roll_not_selected), but Hokusai's attached
# plan-stage challenge recommendation (challenger deepseek-v3 vs primary
# claude-opus-5-5) survived into the expanded route. The pre-fix finalizer
# re-ran resolve-challenge-task.ts without --resolve-sealed, got that
# recommendation back as mode=challenge, found no HOK-3469_c task, and
# stamped challengeCollapseReason=challenger_never_launched -- the exact
# signature recorded for HOK-3469 in .wavemill/state-archive/tombstones.jsonl.
# The wavemill_run_tool stub below reproduces that resolver response
# deterministically (no live cert/eval data needed) so this fixture actually
# fails against the pre-fix finalizer instead of passing by accident; a
# --resolve-sealed call (the fixed path) is left unstubbed since it only
# reads the sealed intent and needs no repo config.

register_lifecycle_scenario sealed_single_stays_single_through_plan_to_code

setup_sealed_single_stays_single_through_plan_to_code() {
  create_git_worktree
  CURRENT_PHASE="planning"
  MONITOR_ITERATIONS=2

  # Valid expanded packet + plan approval so the planning→coding transition runs.
  printf "## 1. Objective\npacket\n" > "$FEATURE_DIR/task-packet.md"
  printf "header\n" > "$FEATURE_DIR/task-packet-header.md"
  printf "plan\n" > "$FEATURE_DIR/plan.md"
  printf '{"planner":"claude-opus-5-5","coder":"deepseek-v4-flash","reviewer":"claude-fable-5","planDepth":"medium","codeDepth":"medium","reviewMode":"llm"}\n' > "$FEATURE_DIR/.initial-route.json"
  printf '{"planner":"claude-opus-5-5","coder":"deepseek-v4-flash","reviewer":"claude-fable-5","planDepth":"medium","codeDepth":"medium","reviewMode":"llm"}\n' > "$FEATURE_DIR/.post-expansion-route.json"
  touch "$FEATURE_DIR/.plan-approved"

  write_stage_result "$FEATURE_DIR" "planning" "awaiting_user" "$CURRENT_AGENT"

  # Seal a single-model launch decision in state. The expanded route above
  # would normally be eligible for a plan-stage pair, but finalization must
  # honour the sealed single and never rerun the lottery.
  local single_intent
  single_intent='{"schemaVersion":1,"pairId":"HOK-1294","issueId":"HOK-1294","selectedStage":"plan","challengeStage":"plan","decisionSource":"bootstrap","selectionPath":"random-roll","noChallengeReason":"roll_not_selected","primary":{"key":"HOK-1294","role":"primary","planner":{"model":"claude-opus-5-5","agent":"claude"},"coder":{"model":"deepseek-v4-flash","agent":"claude"},"reviewer":{"model":"claude-fable-5","agent":"claude"}}}'
  jq --arg issue "$ISSUE" --argjson intent "$single_intent" \
    '.tasks[$issue].challengeExecutionIntent = $intent' \
    "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"

  # Regression stub: only the non-sealed (pre-fix) resolver call is faked;
  # a --resolve-sealed call runs the real tool unchanged.
  eval "$(declare -f wavemill_run_tool | sed '1s/^wavemill_run_tool/__hok3469_real_wavemill_run_tool/')"
  wavemill_run_tool() {
    local tool="$1"; shift
    if [[ "$tool" == "resolve-challenge-task.ts" ]]; then
      local saw_resolve_sealed="false" arg
      for arg in "$@"; do
        [[ "$arg" == "--resolve-sealed" ]] && saw_resolve_sealed="true"
      done
      if [[ "$saw_resolve_sealed" != "true" ]]; then
        cat <<'JSON'
{"mode":"challenge","decisionSource":"expanded","challengeStage":"plan","entries":[{"key":"HOK-1294","model":"claude-opus-5-5","planner":"claude-opus-5-5","reviewer":"claude-fable-5","planDepth":"medium","codeDepth":"medium","reviewMode":"llm"},{"key":"HOK-1294_c","model":"deepseek-v3","planner":"deepseek-v3","reviewer":"claude-fable-5","planDepth":"medium","codeDepth":"medium","reviewMode":"llm"}],"challengeExecutionIntent":{"schemaVersion":1,"pairId":"HOK-1294","issueId":"HOK-1294","selectedStage":"plan","challengeStage":"plan","decisionSource":"expanded","primary":{"key":"HOK-1294","role":"primary"},"challenger":{"key":"HOK-1294_c","role":"challenger"}}}
JSON
        return 0
      fi
    fi
    __hok3469_real_wavemill_run_tool "$tool" "$@"
  }
}

assert_sealed_single_stays_single_through_plan_to_code() {
  local output="$1"
  local scenario_dir
  scenario_dir="$(awk -F= '/^scenario_dir=/{print substr($0, index($0,$2))}' <<< "$output")"

  check_contains "planning completes and coding launches" "$output" "phase=coding"
  # The pre-fix finalizer's phantom-pair warning text names no challenger arm,
  # not the literal collapse-reason string (that only ever reaches the
  # route-lifecycle log, which this harness stubs to a no-op) -- match the
  # actual warning text so this check can fail on the pre-fix base.
  check_not_contains "no phantom-pair warning logged" "$output" "no challenger arm exists"
  check_eq "no challenger_never_launched write on the task" "" \
    "$(jq -r '.tasks["HOK-1294"].challengeCollapseReason // ""' "$scenario_dir/workflow-state.json")"
  check_eq "task stays single (not a challenge)" "false" "$(jq -r '.tasks["HOK-1294"].challenge // "false"' "$scenario_dir/workflow-state.json")"
  check_eq "sealed single intent survives finalization" "roll_not_selected" "$(jq -r '.tasks["HOK-1294"].challengeExecutionIntent.noChallengeReason // ""' "$scenario_dir/workflow-state.json")"
  check_eq "no challenger task materialised" "" "$(jq -r '.tasks["HOK-1294_c"].slug // ""' "$scenario_dir/workflow-state.json")"
}
