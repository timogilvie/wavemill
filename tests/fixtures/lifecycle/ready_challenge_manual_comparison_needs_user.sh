#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154
#
# HOK-2814: this scenario assumes a materialised pair with both PRs ready and
# drives the manual-comparison-needed transition. It is not on the pre-fork
# path — by the time we reach the ready/manual-comparison branch, both arms
# already exist. The fork itself is covered by the
# deferred_challenger_materialises_after_coding lifecycle fixture.

register_lifecycle_scenario ready_challenge_manual_comparison_needs_user

setup_ready_challenge_manual_comparison_needs_user() {
  CURRENT_PHASE="ready"
  PR="754"
  PR_BY_ISSUE["$ISSUE"]="$PR"
  CHALLENGE_TASK="true"
  write_stage_result "$FEATURE_DIR" "ready" "completed" "$CURRENT_AGENT"
  jq --arg issue "$ISSUE" '
    .tasks[$issue] = {
      slug: "ready-challenge-manual-comparison-needs-user",
      branch: "task/ready-challenge-manual-comparison-needs-user",
      worktree: .tasks[$issue].worktree,
      pr: "754",
      status: "ready",
      phase: "ready",
      challenge: true,
      challengePairId: $issue,
      challengeRole: "primary",
      comparisonState: "manual_comparison_needed",
      comparisonBlockedReason: "both_eval_timed_out",
      comparisonTimedOutSides: ["primary", "challenger"]
    }
  ' "$STATE_FILE" > "$STATE_FILE.tmp"
  mv "$STATE_FILE.tmp" "$STATE_FILE"
}

assert_ready_challenge_manual_comparison_needs_user() {
  local output="$1"

  check_contains "manual comparison keeps ready phase active" "$output" "phase=ready"
  check_contains "manual comparison requests attention" "$output" "attention=needs-user"
  check_contains "manual comparison does not relaunch ready" "$output" "ready_launches=0"
}
