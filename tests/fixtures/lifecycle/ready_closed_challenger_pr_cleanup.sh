#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154
#
# HOK-2814: this scenario assumes a materialised pair in the ready phase with
# the challenger PR CLOSED and the sibling still OPEN. It is not on the
# pre-fork path — the fork lifecycle is covered by
# deferred_challenger_materialises_after_coding.

register_lifecycle_scenario ready_closed_challenger_pr_cleanup

setup_ready_closed_challenger_pr_cleanup() {
  CURRENT_PHASE="ready"
  PR="854"
  PR_BY_ISSUE["$ISSUE"]="$PR"
  PR_STATUS="CLOSED"
  CHALLENGE_TASK="true"
  CHALLENGE_SIBLING_PR="855"
  CHALLENGE_SIBLING_STATE="OPEN"
  LINEAR_UPDATES="true"
  write_stage_result "$FEATURE_DIR" "review" "completed" "$CURRENT_AGENT"
}

assert_ready_closed_challenger_pr_cleanup() {
  local output="$1"

  check_contains "ready closed challenger is cleaned up" "$output" "cleanup_count=1"
  check_contains "ready closed challenger keeps cleanup reason" "$output" "closed without merge"
  check_not_contains "ready closed challenger does not move Linear done" "$output" "|Done"
  check_not_contains "ready closed challenger does not move Linear backlog yet" "$output" "|Backlog"
  check_contains "ready closed challenger does not relaunch ready" "$output" "ready_launches=0"
}
