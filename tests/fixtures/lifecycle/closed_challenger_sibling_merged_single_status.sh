#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154

# HOK-3004: the challenger-loses orientation of the retained-cleanup
# regression. A closed challenger PR with a merged primary sibling must emit
# "Challenge sibling merged → marking Linear as Done" exactly once across many
# monitor polls while cleanup remains retained (the earlier bug printed the
# message on every ~24-30s poll). The real terminal reconciler is sourced so
# the persisted linearApplied marker is the source of truth, and
# monitor_cleanup_episode_skip is stubbed to simulate a retained cleanup
# disposition (live agent / dirty worktree) that re-enters the closed-PR
# branch each poll.
register_lifecycle_scenario closed_challenger_sibling_merged_single_status

setup_closed_challenger_sibling_merged_single_status() {
  load_terminal_reconciler_for_scenario
  CURRENT_PHASE="review"
  PR="1392"
  PR_BY_ISSUE["$ISSUE"]="$PR"
  PR_STATUS="CLOSED"
  CHALLENGE_TASK="true"
  CHALLENGE_ROLE="challenger"
  CHALLENGE_PAIR_ID="$ISSUE"
  CHALLENGE_SIBLING_PR="1393"
  CHALLENGE_SIBLING_STATE="MERGED"
  CHALLENGE_SIBLING_MERGED="true"
  LINEAR_UPDATES="true"
  MONITOR_ITERATIONS=12
  # Retained cleanup: skip cleanup every poll so the CLOSED branch re-enters
  # exactly like the live HOK-3002 reproduction.
  monitor_cleanup_episode_skip() { return 0; }
  write_stage_result "$FEATURE_DIR" "review" "completed" "$CURRENT_AGENT"
}

assert_closed_challenger_sibling_merged_single_status() {
  local output="$1"
  local done_log_count linear_done_count linear_applied scenario_dir

  done_log_count=$(awk 'BEGIN { c=0 } { n=gsub(/Challenge sibling merged → marking Linear as Done/, "&"); c+=n } END { print c }' <<<"$output")
  linear_done_count=$(awk 'BEGIN { c=0 } { n=gsub(/\|Done/, "&"); c+=n } END { print c }' <<<"$output")
  scenario_dir=$(printf '%s\n' "$output" | awk -F= '/^scenario_dir=/{print $2; exit}')
  linear_applied=$(jq -r '.tasks["HOK-1294"].terminalReconciliations["pr_closed_unmerged:1392"].linearApplied // "missing"' "$scenario_dir/workflow-state.json" 2>/dev/null || echo "missing")

  check_eq "exactly one status Done log over 12 polls (HOK-3004)" "1" "$done_log_count"
  check_eq "exactly one durable Linear Done call" "1" "$linear_done_count"
  check_eq "marker records durable linearApplied=true" "true" "$linear_applied"
  check_not_contains "retained cleanup does not demote Linear to Backlog" "$output" "|Backlog"
  check_contains "retained cleanup leaves subsequent polls at debug" "$output" "Linear Done already recorded"
}
