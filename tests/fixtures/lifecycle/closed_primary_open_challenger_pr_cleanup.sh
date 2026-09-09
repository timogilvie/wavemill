#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154

# HOK-2972: symmetric coverage for the primary-loses / challenger-survives
# orientation. Companion to closed_challenger_pr_cleanup.sh (which covers the
# opposite orientation). Both must converge without moving the shared Linear
# issue prematurely and without spamming WARN on repeat monitor polls.

register_lifecycle_scenario closed_primary_open_challenger_pr_cleanup

setup_closed_primary_open_challenger_pr_cleanup() {
  CURRENT_PHASE="review"
  PR="1369"
  PR_BY_ISSUE["$ISSUE"]="$PR"
  PR_STATUS="CLOSED"
  CHALLENGE_TASK="true"
  CHALLENGE_ROLE="primary"
  CHALLENGE_SIBLING_PR="1368"
  CHALLENGE_SIBLING_STATE="OPEN"
  LINEAR_UPDATES="true"
  MONITOR_ITERATIONS=3
  write_stage_result "$FEATURE_DIR" "review" "completed" "$CURRENT_AGENT"
}

assert_closed_primary_open_challenger_pr_cleanup() {
  local output="$1"

  # cleanup_completed_task is stubbed in the harness and does not set the
  # CLEANED tombstone, so with MONITOR_ITERATIONS=3 the harness records three
  # cleanup calls. The important invariants: cleanup keeps firing (does not
  # silently drop the arm) and the transition reason is preserved.
  check_contains "closed primary is cleaned up on every tick" "$output" "cleanup_count=3"
  check_contains "closed primary keeps cleanup reason" "$output" "closed without merge"
  check_not_contains "active challenger prevents Linear Done" "$output" "|Done"
  check_not_contains "active challenger prevents Backlog reset" "$output" "|Backlog"

  # HOK-2972: three monitor iterations must not produce three WARN lines; the
  # per-(issue,pr) dedup collapses the follow-up polls to debug.
  local warn_count
  warn_count=$(printf '%s' "$output" | tr ';' '\n' | grep -c "WARN:.*PR #1369 CLOSED without merge" || true)
  check_eq "closed-primary WARN is deduped across ticks" "1" "$warn_count"
}
