#!/usr/bin/env bash
# HOK-2957 fixture: MERGED PR with a true merge commit (mergeMethod=merge),
# head branch still present on origin. The task branch's tip IS an ancestor
# of the rewritten base via the merge commit, so safe_remove_task_worktree_
# and_branch can reach a safe_ancestor / safe_exact_remote classification
# without needing the PR headRefOid fallback.
set -euo pipefail

# incident_setup_merge_commit_delivery
# Returns via globals: MC_ISSUE, MC_SLUG, MC_PR, MC_LOCAL_HEAD
incident_setup_merge_commit_delivery() {
  MC_ISSUE="HOK-3100"
  MC_SLUG="merge-commit-delivery-fixture"
  MC_PR="3100"
  local branch="task/$MC_SLUG"
  local wt_dir="$WORKTREE_ROOT/$MC_SLUG"

  git -C "$REPO_DIR" branch "$branch" auto/integration
  git -C "$REPO_DIR" worktree add "$wt_dir" "$branch" >/dev/null 2>&1

  printf 'mc feature 1\n' > "$wt_dir/mc.txt"
  git -C "$wt_dir" add mc.txt
  git -C "$wt_dir" commit -m "mc: part 1" >/dev/null
  git -C "$wt_dir" push -u origin "$branch" >/dev/null 2>&1
  MC_LOCAL_HEAD="$(git -C "$wt_dir" rev-parse HEAD)"

  # Merge commit: origin/auto/integration gets a real merge with the task
  # branch as a second parent. Local head remains an ancestor of base.
  local origin_base_tip merge_tree merge_commit
  origin_base_tip="$(git -C "$REPO_DIR" rev-parse auto/integration)"
  merge_tree="$(git -C "$wt_dir" rev-parse HEAD^{tree})"
  merge_commit="$(git -C "$REPO_DIR" commit-tree "$merge_tree" -p "$origin_base_tip" -p "$MC_LOCAL_HEAD" \
    -m "Merge PR #$MC_PR")"
  git -C "$REPO_DIR" reset --hard "$merge_commit" >/dev/null
  git -C "$REPO_DIR" push origin auto/integration --force >/dev/null 2>&1

  record_pr "$MC_PR" "MERGED" "2026-09-04T13:00:00Z" "$MC_LOCAL_HEAD" "$branch" "auto/integration"

  local ready_dir="$wt_dir/features/$MC_SLUG"
  mkdir -p "$ready_dir"
  jq -cn '{status:"completed",artifacts:{verdict:"pass"}}' > "$ready_dir/.ready-result.json"

  local backdated
  backdated="$(incident_backdated_iso 2)"

  incident_seed_task "$MC_ISSUE" "$(jq -cn \
    --arg slug "$MC_SLUG" --arg branch "$branch" --arg wt "$wt_dir" \
    --arg pr "$MC_PR" --arg updated "$backdated" \
    '{slug:$slug,branch:$branch,worktree:$wt,pr:$pr,status:"merged",phase:"review",agent:"codex",linearIssueId:"HOK-3100",updated:$updated,lifecycle:{launchContract:{mergeMethod:"merge",baseBranch:"auto/integration"}}}')"

  incident_write_hook "$MC_ISSUE" "idle" "Stop" "" "claude"
}
