#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154

register_lifecycle_scenario ready_conflict_then_merge_runs_eval

setup_ready_conflict_then_merge_runs_eval() {
  CURRENT_PHASE="ready"
  PR="856"
  PR_BY_ISSUE["$ISSUE"]="$PR"
  PR_STATUS="MERGED"
  VALIDATE_MERGED="true"
  AUTO_EVAL="true"
  EVAL_COMPLETED="false"
  REQUIRE_CONFIRM="false"
  LINEAR_UPDATES="true"
  write_stage_result "$FEATURE_DIR" "review" "completed" "$CURRENT_AGENT"
  local ready_dir
  ready_dir="$(ready_state_dir "${WORKTREE_ROOT}/${SLUG}" "$SLUG")"
  mkdir -p "$ready_dir"
  marker_write "$ready_dir/.conflict-remediation.json" --kind conflict-remediation \
    --head "stale-head" --expires-on "head,remote,operator-event" \
    --detail-json '{"head":"stale-head","base":"main","launchHead":"stale-head","prNumber":856}'
  cat > "$ready_dir/.ready-result.json" <<JSON
{"stage":"ready","status":"completed","artifacts":{"verdict":"pass"}}
JSON
}

assert_ready_conflict_then_merge_runs_eval() {
  local output="$1"

  check_contains "ready conflict merge launches post-merge eval" "$output" "HOK-1294 856 task/ready_conflict_then_merge_runs_eval ready_conflict_then_merge_runs_eval HOK-1294 post-merge"
  check_contains "ready conflict merge still cleans up" "$output" "cleanup_count=1"
  check_contains "ready conflict merge marks Linear done" "$output" "HOK-1294|Done"
  check_contains "ready conflict merge does not relaunch ready" "$output" "ready_launches=0"
}
