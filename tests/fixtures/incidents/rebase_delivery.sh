#!/usr/bin/env bash
# HOK-2957 fixture: MERGED PR delivered via rebase merge. GitHub's rebase
# merge rewrites the task branch commits onto the base with new SHAs. The
# LOCAL task head is NOT an ancestor of the rewritten base (the tree matches
# but the commit SHA is different), so safe_remove_task_worktree_and_branch
# must fall through to the safe_terminal_pr_head path (headRefOid still
# matches the pre-rewrite local head).
set -euo pipefail

# incident_setup_rebase_delivery
# Returns via globals: REB_ISSUE, REB_SLUG, REB_PR, REB_LOCAL_HEAD
incident_setup_rebase_delivery() {
  REB_ISSUE="HOK-3200"
  REB_SLUG="rebase-delivery-fixture"
  REB_PR="3200"
  local branch="task/$REB_SLUG"
  local wt_dir="$WORKTREE_ROOT/$REB_SLUG"

  git -C "$REPO_DIR" branch "$branch" auto/integration
  git -C "$REPO_DIR" worktree add "$wt_dir" "$branch" >/dev/null 2>&1

  printf 'reb feature 1\n' > "$wt_dir/reb.txt"
  git -C "$wt_dir" add reb.txt
  git -C "$wt_dir" commit -m "reb: part 1" >/dev/null
  git -C "$wt_dir" push -u origin "$branch" >/dev/null 2>&1
  REB_LOCAL_HEAD="$(git -C "$wt_dir" rev-parse HEAD)"

  # Rebase merge: rewrite the base with a new commit that carries the same
  # tree but a fresh author date so the SHA is guaranteed different.
  local origin_base_tip rebase_tree rebase_commit
  origin_base_tip="$(git -C "$REPO_DIR" rev-parse auto/integration)"
  rebase_tree="$(git -C "$wt_dir" rev-parse HEAD^{tree})"
  rebase_commit="$(GIT_AUTHOR_DATE="2026-09-04T14:00:00Z" GIT_COMMITTER_DATE="2026-09-04T14:00:00Z" \
    git -C "$REPO_DIR" commit-tree "$rebase_tree" -p "$origin_base_tip" -m "reb: part 1 (rebase merge)")"
  git -C "$REPO_DIR" reset --hard "$rebase_commit" >/dev/null
  git -C "$REPO_DIR" push origin auto/integration --force >/dev/null 2>&1

  # The local head must not be an ancestor of the rewritten base — that is
  # the interesting shape a rebase-merge produces.
  if git -C "$REPO_DIR" merge-base --is-ancestor "$branch" auto/integration 2>/dev/null; then
    echo "FIXTURE BUG: rebase topology accidentally left the task branch as an ancestor of base" >&2
    return 1
  fi

  record_pr "$REB_PR" "MERGED" "2026-09-04T14:00:00Z" "$REB_LOCAL_HEAD" "$branch" "auto/integration"

  local ready_dir="$wt_dir/features/$REB_SLUG"
  mkdir -p "$ready_dir"
  jq -cn '{status:"completed",artifacts:{verdict:"pass"}}' > "$ready_dir/.ready-result.json"

  local backdated
  backdated="$(incident_backdated_iso 2)"

  incident_seed_task "$REB_ISSUE" "$(jq -cn \
    --arg slug "$REB_SLUG" --arg branch "$branch" --arg wt "$wt_dir" \
    --arg pr "$REB_PR" --arg updated "$backdated" \
    '{slug:$slug,branch:$branch,worktree:$wt,pr:$pr,status:"merged",phase:"review",agent:"codex",linearIssueId:"HOK-3200",updated:$updated,lifecycle:{launchContract:{mergeMethod:"rebase",baseBranch:"auto/integration"}}}')"

  incident_write_hook "$REB_ISSUE" "idle" "Stop" "" "claude"
}
