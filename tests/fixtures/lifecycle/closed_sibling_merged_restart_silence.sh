#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154

# HOK-3004: monitor-restart scenario. State persisted from an earlier run
# already carries linearApplied=true for the pr_closed_unmerged marker. A
# fresh monitor pass must observe the terminal transition is already
# recorded and stay silent at status level - mirroring what happens after a
# wavemill restart on a retained losing arm.
register_lifecycle_scenario closed_sibling_merged_restart_silence

setup_closed_sibling_merged_restart_silence() {
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
  MONITOR_ITERATIONS=3
  monitor_cleanup_episode_skip() { return 0; }
  write_stage_result "$FEATURE_DIR" "review" "completed" "$CURRENT_AGENT"
  # Pre-populate persisted state as if a prior monitor already drove the
  # transition to completion; any new status-level Done log is a regression.
  # Direct jq overwrite avoids state_mutate's file-lock overhead for this
  # one-shot test fixture setup.
  local marker_key="pr_closed_unmerged:$PR"
  local pre_state
  pre_state=$(jq --arg issue "$ISSUE" --arg key "$marker_key" --arg pr "$PR" \
    '.tasks[$issue].terminalReconciliations[$key] = {
       issue: $issue,
       reason: "pr_closed_unmerged",
       prNumber: $pr,
       stateApplied: true,
       stageApplied: true,
       hookApplied: true,
       paneMetadataApplied: true,
       paneReleased: true,
       linearApplied: true,
       appliedAt: "2026-10-04T12:00:00Z"
     }
     | .tasks[$issue].paneReleased = true
     | .tasks[$issue].paneState = "released"' "$STATE_FILE")
  printf '%s\n' "$pre_state" > "$STATE_FILE"
}

assert_closed_sibling_merged_restart_silence() {
  local output="$1"
  local done_log_count linear_done_count

  done_log_count=$(awk 'BEGIN { c=0 } { n=gsub(/Challenge sibling merged → marking Linear as Done/, "&"); c+=n } END { print c }' <<<"$output")
  linear_done_count=$(awk 'BEGIN { c=0 } { n=gsub(/\|Done/, "&"); c+=n } END { print c }' <<<"$output")

  check_eq "monitor restart emits zero status Done logs (HOK-3004)" "0" "$done_log_count"
  check_eq "monitor restart performs zero Linear writes" "0" "$linear_done_count"
  check_contains "monitor restart logs already-recorded message at debug" "$output" "Linear Done already recorded"
  check_contains "closed observation already recorded at debug" "$output" "terminal transition already recorded"
}
