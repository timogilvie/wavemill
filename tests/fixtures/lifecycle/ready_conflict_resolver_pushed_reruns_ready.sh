#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154

# HOK-3273 (HOK-3241 primary): the resolver launched at an older head and
# pushed its fix. Ready must re-run on the new head straight away, with no
# latched conflict file to clear, no GitHub recheck of its own, and no charge
# against the conflict-remediation budget.
register_lifecycle_scenario ready_conflict_resolver_pushed_reruns_ready

setup_ready_conflict_resolver_pushed_reruns_ready() {
  CURRENT_PHASE="ready"
  PR="528"
  PR_BY_ISSUE["$ISSUE"]="$PR"
  REQUIRE_CONFIRM="false"
  READY_LAUNCH_RC=0

  create_git_worktree
  write_stage_result "$FEATURE_DIR" "review" "completed" "$CURRENT_AGENT"

  local ready_dir
  ready_dir="$(ready_state_dir "${WORKTREE_ROOT}/${SLUG}" "$SLUG")"
  mkdir -p "$ready_dir"
  cat > "$ready_dir/.ready-result.json" <<JSON
{"stage":"ready","status":"running","artifacts":{"type":"ready","prNumber":528,"mergeConflict":"CONFLICTED","launchHead":"stale-head"}}
JSON
  marker_write "$ready_dir/.conflict-remediation.json" --kind conflict-remediation \
    --head "stale-head" --expires-on "head,remote,operator-event" \
    --detail-json '{"head":"stale-head","base":"main","launchHead":"stale-head","prNumber":528}'
  printf '%s\n' "1" > "$ready_dir/.retry-conflict-remediation-relaunch-count"
  printf '%s\n' "stale-head" > "$ready_dir/.retry-conflict-remediation-relaunch-head"
}

assert_ready_conflict_resolver_pushed_reruns_ready() {
  local output="$1"
  local scenario_dir ready_dir
  scenario_dir="$(printf '%s\n' "$output" | awk -F= '$1=="scenario_dir"{print $2}')"
  ready_dir="$scenario_dir/worktrees/ready_conflict_resolver_pushed_reruns_ready/features/ready_conflict_resolver_pushed_reruns_ready/ready"

  check_contains "pushed resolver relaunches ready" "$output" "ready_launches=1"
  check_contains "pushed resolver clears attention after a ready pass" "$output" "attention=clear"
  check_contains "pushed resolver needs no GitHub recheck of its own" "$output" "gh_pr_view_calls=0"
  check_file_absent "pushed resolver writes no exhausted sentinel" "$ready_dir/.retry-conflict-remediation-relaunch-exhausted"
  check_contains "pushed resolver leaves the budget uncharged by the outer pass" "$(cat "$ready_dir/.retry-conflict-remediation-relaunch-count" 2>/dev/null)" "1"
}
