#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154

# HOK-3273: a resolver is in flight at the current head (the marker's
# launchHead is HEAD and Ready is still running it). The arm is active work:
# no Ready re-run, no needs-user.
register_lifecycle_scenario ready_conflict_resolver_in_flight_holds

setup_ready_conflict_resolver_in_flight_holds() {
  CURRENT_PHASE="ready"
  PR="528"
  PR_BY_ISSUE["$ISSUE"]="$PR"
  REQUIRE_CONFIRM="false"
  READY_LAUNCH_RC=0

  create_git_worktree
  write_stage_result "$FEATURE_DIR" "review" "completed" "$CURRENT_AGENT"

  local ready_dir current_head detail
  ready_dir="$(ready_state_dir "${WORKTREE_ROOT}/${SLUG}" "$SLUG")"
  mkdir -p "$ready_dir"
  current_head="$(git -C "$WT_DIR" rev-parse HEAD)"
  cat > "$ready_dir/.ready-result.json" <<JSON
{"stage":"ready","status":"running","artifacts":{"type":"ready","prNumber":528,"mergeConflict":"CONFLICTED","launchHead":"$current_head"}}
JSON
  detail="$(jq -cn --arg h "$current_head" '{head:$h,base:"main",launchHead:$h,prNumber:528}')"
  marker_write "$ready_dir/.conflict-remediation.json" --kind conflict-remediation \
    --head "$current_head" --expires-on "head,remote,operator-event" --detail-json "$detail"
}

assert_ready_conflict_resolver_in_flight_holds() {
  local output="$1"
  local scenario_dir ready_dir
  scenario_dir="$(printf '%s\n' "$output" | awk -F= '$1=="scenario_dir"{print $2}')"
  ready_dir="$scenario_dir/worktrees/ready_conflict_resolver_in_flight_holds/features/ready_conflict_resolver_in_flight_holds/ready"

  check_contains "in-flight resolver does not relaunch ready" "$output" "ready_launches=0"
  check_contains "in-flight resolver keeps the arm active" "$output" "attention=clear"
  check_contains "in-flight resolver makes no GitHub call" "$output" "gh_pr_view_calls=0"
  check_file_exists "in-flight resolver keeps its marker" "$ready_dir/.conflict-remediation.json"
}
