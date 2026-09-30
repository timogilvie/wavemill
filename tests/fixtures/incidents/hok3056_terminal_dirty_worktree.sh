#!/usr/bin/env bash
# Incident fixture: HOK-3056-style terminal (error) task with a dirty worktree
# whose branch is a clean fast-forward of base and has no PR (HOK-3088).
#
# Topology: a regular (non-challenge) task whose phase is `error` and status is
# `""`, taskWorkflowIsTerminal but with a worktree that still holds
# uncommitted (modified tracked) and untracked (new tracked-shape) files. The
# branch tip is at base with no unique commits and no PR was ever opened, so
# the pre-HOK-3088 observer would take the "nothing at risk" shortcut and
# recommend abort/reap - which would delete the only copy of the work.
set -euo pipefail

incident_setup_hok3056_terminal_dirty_worktree() {
  HOK3056_ISSUE="HOK-3056"
  HOK3056_SLUG="native-runtime-epic-104-production-mcp-client-bridge"
  local branch="task/$HOK3056_SLUG"
  local wt_dir="$WORKTREE_ROOT/$HOK3056_SLUG"

  # Branch equal to base: fast-forward with no unique commits.
  git -C "$REPO_DIR" branch "$branch" auto/integration
  git -C "$REPO_DIR" worktree add "$wt_dir" "$branch" >/dev/null 2>&1

  # Simulate the HOK-3056 shape: modified tracked README plus new untracked
  # files under two subtrees. This is the exact evidence a rushed observer
  # abort/reap would silently discard.
  printf 'seed\nlocal edit\n' > "$wt_dir/README.md"
  mkdir -p "$wt_dir/shared/lib" "$wt_dir/tools" "$wt_dir/tests"
  printf 'export {};\n' > "$wt_dir/shared/lib/mcp-client.ts"
  printf 'export {};\n' > "$wt_dir/tools/mcp.ts"
  printf 'export {};\n' > "$wt_dir/tests/mcp-client.test.ts"

  # Backdated well past run_observer_pass's --stale-minutes 1 so the age
  # gate fires deterministically.
  local backdated
  backdated="$(date -u -v-24H +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d '24 hours ago' +"%Y-%m-%dT%H:%M:%SZ")"

  incident_seed_task "$HOK3056_ISSUE" "$(jq -cn \
    --arg slug "$HOK3056_SLUG" --arg branch "$branch" --arg wt "$wt_dir" --arg updated "$backdated" \
    '{slug:$slug,branch:$branch,worktree:$wt,pr:"",status:"error",phase:"error",agent:"claude",linearIssueId:"HOK-3056",updated:$updated}')"

  incident_write_hook "$HOK3056_ISSUE" "error" "Notification" "coding failed" "claude"

  incident_scenario_add_task_window "$HOK3056_ISSUE" "$HOK3056_SLUG"
}
