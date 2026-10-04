#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154

# HOK-3004: symmetric primary-loses orientation of
# closed_challenger_sibling_merged_single_status. A closed primary PR with a
# merged challenger sibling must emit "Challenge sibling merged → marking
# Linear as Done" exactly once across many polls while cleanup remains
# retained. Verifies that both challenge-arm orientations share the same
# marker-based completion path.
register_lifecycle_scenario closed_primary_sibling_merged_single_status

setup_closed_primary_sibling_merged_single_status() {
  load_terminal_reconciler_for_scenario
  CURRENT_PHASE="review"
  PR="1393"
  PR_BY_ISSUE["$ISSUE"]="$PR"
  PR_STATUS="CLOSED"
  CHALLENGE_TASK="true"
  CHALLENGE_ROLE="primary"
  CHALLENGE_PAIR_ID="$ISSUE"
  CHALLENGE_SIBLING_PR="1392"
  CHALLENGE_SIBLING_STATE="MERGED"
  CHALLENGE_SIBLING_MERGED="true"
  LINEAR_UPDATES="true"
  MONITOR_ITERATIONS=10
  monitor_cleanup_episode_skip() { return 0; }
  write_stage_result "$FEATURE_DIR" "review" "completed" "$CURRENT_AGENT"
}

assert_closed_primary_sibling_merged_single_status() {
  local output="$1"
  local done_log_count linear_done_count linear_applied scenario_dir

  done_log_count=$(awk 'BEGIN { c=0 } { n=gsub(/Challenge sibling merged → marking Linear as Done/, "&"); c+=n } END { print c }' <<<"$output")
  linear_done_count=$(awk 'BEGIN { c=0 } { n=gsub(/\|Done/, "&"); c+=n } END { print c }' <<<"$output")
  scenario_dir=$(printf '%s\n' "$output" | awk -F= '/^scenario_dir=/{print $2; exit}')
  linear_applied=$(jq -r '.tasks["HOK-1294"].terminalReconciliations["pr_closed_unmerged:1393"].linearApplied // "missing"' "$scenario_dir/workflow-state.json" 2>/dev/null || echo "missing")

  check_eq "exactly one status Done log over 10 polls (primary loses, HOK-3004)" "1" "$done_log_count"
  check_eq "exactly one durable Linear Done call" "1" "$linear_done_count"
  check_eq "marker records durable linearApplied=true" "true" "$linear_applied"
  check_not_contains "retained cleanup does not demote Linear to Backlog" "$output" "|Backlog"
}
