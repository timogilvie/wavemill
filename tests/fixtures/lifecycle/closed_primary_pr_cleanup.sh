#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154

# HOK-2972: symmetric orientation of closed_challenger_pr_cleanup. The
# PRIMARY arm's PR closes without merge while the challenger sibling stays
# open and green: the closed primary is a normal losing arm - cleaned up,
# with the shared Linear issue neither completed nor reset to Backlog while
# the sibling is still live.
register_lifecycle_scenario closed_primary_pr_cleanup

setup_closed_primary_pr_cleanup() {
  CURRENT_PHASE="review"
  PR="1369"
  PR_BY_ISSUE["$ISSUE"]="$PR"
  PR_STATUS="CLOSED"
  CHALLENGE_TASK="true"
  CHALLENGE_ROLE="primary"
  CHALLENGE_PAIR_ID="$ISSUE"
  CHALLENGE_SIBLING_PR="1368"
  CHALLENGE_SIBLING_STATE="OPEN"
  LINEAR_UPDATES="true"
  write_stage_result "$FEATURE_DIR" "review" "completed" "$CURRENT_AGENT"
}

assert_closed_primary_pr_cleanup() {
  local output="$1"

  check_contains "closed primary is cleaned up" "$output" "cleanup_count=1"
  check_contains "closed primary cleanup reason captured" "$output" "closed without merge"
  check_not_contains "open sibling prevents Linear Done" "$output" "|Done"
  check_not_contains "open sibling prevents Backlog reset" "$output" "|Backlog"
  check_not_contains "sibling task is not cleaned up" "$output" "1368"
}
