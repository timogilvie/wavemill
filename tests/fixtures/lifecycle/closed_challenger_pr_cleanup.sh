#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154
#
# HOK-2814: this scenario assumes a materialised pair with the challenger PR
# CLOSED and the sibling still OPEN. It drives the closed-challenger cleanup
# path in the monitor and is not on the pre-fork path — a pending arm never
# has a PR. The fork lifecycle is covered by
# deferred_challenger_materialises_after_coding.

register_lifecycle_scenario closed_challenger_pr_cleanup

setup_closed_challenger_pr_cleanup() {
  CURRENT_PHASE="review"
  PR="654"
  PR_BY_ISSUE["$ISSUE"]="$PR"
  PR_STATUS="CLOSED"
  CHALLENGE_TASK="true"
  CHALLENGE_SIBLING_PR="655"
  CHALLENGE_SIBLING_STATE="OPEN"
  LINEAR_UPDATES="true"
  write_stage_result "$FEATURE_DIR" "review" "completed" "$CURRENT_AGENT"
}

assert_closed_challenger_pr_cleanup() {
  local output="$1"

  check_contains "closed challenger is cleaned up" "$output" "cleanup_count=1"
  check_contains "closed challenger cleanup reason captured" "$output" "closed without merge"
  check_not_contains "active sibling prevents Linear Done" "$output" "|Done"
  check_not_contains "active sibling prevents Backlog reset" "$output" "|Backlog"
  check_not_contains "sibling task is not cleaned up" "$output" "655"
}
