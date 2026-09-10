#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154

# HOK-2972: primary-loses/challenger-survives convergence. Once the winning
# challenger sibling has merged, the closed primary finalizes: the shared
# Linear issue moves to Done (never Backlog) and the losing arm's resources
# are cleaned up.
register_lifecycle_scenario closed_primary_sibling_merged_marks_done

setup_closed_primary_sibling_merged_marks_done() {
  CURRENT_PHASE="review"
  PR="1369"
  PR_BY_ISSUE["$ISSUE"]="$PR"
  PR_STATUS="CLOSED"
  CHALLENGE_TASK="true"
  CHALLENGE_ROLE="primary"
  CHALLENGE_PAIR_ID="$ISSUE"
  CHALLENGE_SIBLING_PR="1368"
  CHALLENGE_SIBLING_STATE="MERGED"
  CHALLENGE_SIBLING_MERGED="true"
  LINEAR_UPDATES="true"
  write_stage_result "$FEATURE_DIR" "review" "completed" "$CURRENT_AGENT"
}

assert_closed_primary_sibling_merged_marks_done() {
  local output="$1"

  check_contains "merged sibling marks Linear Done" "$output" "|Done"
  check_not_contains "losing arm never resets Backlog" "$output" "|Backlog"
  check_contains "losing primary is cleaned up" "$output" "cleanup_count=1"
}
