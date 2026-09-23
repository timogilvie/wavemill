#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMMON_SCRIPT="$REPO_ROOT/shared/lib/wavemill-common.sh"

extract_function() {
  local source_file="$1"
  local function_name="$2"
  awk -v name="$function_name" '
    function brace_delta(line, stripped, opens, closes) {
      stripped = line
      gsub(/"([^"\\]|\\.)*"/, "\"\"", stripped)
      gsub(/\047([^\047\\]|\\.)*\047/, "\047\047", stripped)
      opens = gsub(/\{/, "{", stripped)
      closes = gsub(/\}/, "}", stripped)
      return opens - closes
    }
    $0 ~ "^" name "\\(\\)[[:space:]]*\\{" {
      capture = 1
      depth = 0
    }
    capture {
      print
      depth += brace_delta($0)
      if (depth == 0) exit
    }
  ' "$source_file"
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

helper_file="$tmp/safe-cleanup-helper.sh"
{
  printf '%s\n' 'WAVEMILL_GIT_REMOTE_TIMEOUT_DEFAULT=15'
  printf '%s\n' 'WAVEMILL_GIT_REMOTE_TIMEOUT_MIN=1'
  printf '%s\n' 'WAVEMILL_GIT_REMOTE_TIMEOUT_MAX=600'
  printf '\n'
  extract_function "$COMMON_SCRIPT" "wavemill_warn"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "wavemill_git_remote_timeout_seconds"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "_wavemill_kill_process_tree"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "wavemill_git_remote_with_timeout"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "wavemill_cleanup_run"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "_wavemill_write_preserved_branch_incident"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "cleanup_outcome_is_safe"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "cleanup_outcome_is_retain"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "cleanup_outcome_is_failed"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "_wavemill_cleanup_operator_guidance"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "wavemill_load_config"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "cleanup_episode_config_value"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "wavemill_pr_aware_cleanup_enabled"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "wavemill_branch_deletion_mode"
  printf '\n'
  printf '%s\n' 'WAVEMILL_CONTROLLER_OBSERVER_ARTIFACT=".wavemill/observer-findings.jsonl"'
  extract_function "$COMMON_SCRIPT" "wavemill_task_worktree_identity"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "wavemill_orphan_dir_scan"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "wavemill_branch_content_matches_base"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "wavemill_orphan_dir_in_bounds"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "wavemill_remove_orphan_task_dir"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "wavemill_worktree_dirty_status"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "wavemill_migrate_controller_observer_artifact"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "wavemill_fetch_pr_terminal_evidence"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "wavemill_record_pr_delivery_evidence"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "_wavemill_record_cleanup_decision"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "_wavemill_build_cleanup_evidence_json"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "wavemill_classify_task_cleanup"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "safe_remove_task_worktree_and_branch"
} > "$helper_file"

fail() {
  echo "$1" >&2
  exit 1
}

setup_repo() {
  local case_name="$1"
  local case_dir="$tmp/$case_name"
  local origin="$case_dir/origin.git"
  local repo="$case_dir/repo"

  mkdir -p "$case_dir"
  git init --bare "$origin" >/dev/null
  git clone "$origin" "$repo" >/dev/null 2>&1
  jq -n '{cleanup:{branchDeletion:{enabled:true,mode:"enforce"}}}' > "$repo/.wavemill-config.json"
  git -C "$repo" config user.email "test@example.com"
  git -C "$repo" config user.name "Wavemill Test"
  git -C "$repo" checkout -b auto/integration >/dev/null 2>&1
  printf 'base\n' > "$repo/README.md"
  git -C "$repo" add README.md
  git -C "$repo" commit -m "base" >/dev/null
  git -C "$repo" push -u origin auto/integration >/dev/null 2>&1
  printf '%s\n' "$repo"
}

add_task_worktree() {
  local repo="$1" branch="$2" wt_dir="$3"
  git -C "$repo" branch "$branch" auto/integration
  git -C "$repo" worktree add "$wt_dir" "$branch" >/dev/null 2>&1
}

commit_in_worktree() {
  local wt_dir="$1" file_name="$2" message="$3"
  printf '%s\n' "$message" > "$wt_dir/$file_name"
  git -C "$wt_dir" add "$file_name"
  git -C "$wt_dir" commit -m "$message" >/dev/null
}

run_helper() {
  local repo="$1" wt_dir="$2" branch="$3" base_branch="${4:-auto/integration}" caller="${5:-test}"
  local issue="${6:-}" pr="${7:-}" gh_fixture="${8:-}" gate="${9:-}"
  REPO_DIR="$repo" WT_DIR="$wt_dir" BRANCH="$branch" BASE="$base_branch" CALLER="$caller" \
  ISSUE_ARG="$issue" PR_ARG="$pr" GH_FIXTURE="$gh_fixture" GATE="$gate" HELPER_FILE="$helper_file" \
  WORKTREE_ROOT="$(dirname "$wt_dir")" bash -lc '
    set -euo pipefail
    source "$HELPER_FILE"
    MILL_LOG_FILE="$REPO_DIR/mill.log"
    LOG_OUTPUT=""
    WARN_OUTPUT=""
    [[ -n "$GATE" ]] && export WAVEMILL_PR_AWARE_CLEANUP="$GATE"
    log() { LOG_OUTPUT+="$*\n"; }
    log_warn() { WARN_OUTPUT+="$*\n"; }
    _with_timeout() { shift; "$@"; }
    gh() {
      [[ -n "$GH_FIXTURE" && -f "$GH_FIXTURE" ]] || return 1
      cat "$GH_FIXTURE"
    }
    set +e
    safe_remove_task_worktree_and_branch "$WT_DIR" "$BRANCH" "$BASE" "$CALLER" "$ISSUE_ARG" "$PR_ARG"
    rc=$?
    set -e
    printf "rc=%s\n" "$rc"
    printf "outcome=%s\n" "${WAVEMILL_CLEANUP_OUTCOME:-}"
    printf "logs=%s\n" "$(printf "%s" "$LOG_OUTPUT" | tr "\n" ";")"
    printf "warns=%s\n" "$(printf "%s" "$WARN_OUTPUT" | tr "\n" ";")"
  '
}

branch_exists() {
  git -C "$1" show-ref --verify --quiet "refs/heads/$2"
}

marker_path() {
  local repo="$1" branch="$2"
  printf '%s/.wavemill/incidents/preserved-branches/%s.json\n' "$repo" "${branch//\//__}"
}

decision_path() {
  local repo="$1" branch="$2"
  printf '%s/.wavemill/incidents/cleanup-decisions/%s.json\n' "$repo" "${branch//\//__}"
}

# record_pr_fixture <path> <state> <mergedAt|null> <headRefOid> <baseRefName>
record_pr_fixture() {
  local path="$1" state="$2" merged_at="$3" head_oid="$4" base_ref="$5"
  jq -cn --arg state "$state" --arg mergedAt "$merged_at" --arg headOid "$head_oid" --arg baseRef "$base_ref" \
    '{number: 4242, state: $state,
      mergedAt: (if $mergedAt == "null" or $mergedAt == "" then null else $mergedAt end),
      headRefOid: (if $headOid == "" then null else $headOid end),
      headRefName: "task/fixture", baseRefName: $baseRef, mergeCommit: null}' > "$path"
}

assert_exists() {
  [[ -e "$1" ]] || fail "expected to exist: $1"
}

assert_absent() {
  [[ ! -e "$1" ]] || fail "expected to be absent: $1"
}

assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  [[ "$haystack" == *"$needle"* ]] || fail "$label missing '$needle': $haystack"
}

case_unpushed_commits_retained() {
  local repo branch wt out marker
  repo="$(setup_repo unpushed)"
  branch="task/unpushed"
  wt="$tmp/unpushed/wt"
  add_task_worktree "$repo" "$branch" "$wt"
  commit_in_worktree "$wt" "feature.txt" "feature"

  out="$(run_helper "$repo" "$wt" "$branch")"
  marker="$(marker_path "$repo" "$branch")"
  assert_contains "$out" "rc=10" "unpushed return"
  assert_contains "$out" "outcome=retain_unpublished" "unpushed outcome"
  branch_exists "$repo" "$branch" || fail "unpushed branch was deleted"
  assert_exists "$wt"
  assert_exists "$marker"
  [[ "$(jq -r '.reason' "$marker")" == "unpushed_commits" ]] || fail "unpushed marker reason mismatch"
  [[ "$(jq -r '.commitsAhead' "$marker")" == "1" ]] || fail "unpushed marker commitsAhead mismatch"
  [[ "$(jq -r '.classification' "$marker")" == "retain_unpublished" ]] || fail "unpushed marker classification mismatch"
  [[ "$(jq -r '.safeToDelete' "$marker")" == "false" ]] || fail "unpushed marker safeToDelete mismatch"
  [[ "$(jq -r '.operatorGuidance' "$marker")" == *"push the branch or explicitly abandon"* ]] || fail "unpushed marker guidance mismatch"
  assert_contains "$out" "PRESERVED_UNPUSHED_WORK" "unpushed warning"
}

case_pushed_unmerged_deleted() {
  local repo branch wt out marker
  repo="$(setup_repo pushed)"
  branch="task/pushed"
  wt="$tmp/pushed/wt"
  add_task_worktree "$repo" "$branch" "$wt"
  commit_in_worktree "$wt" "feature.txt" "feature"
  git -C "$wt" push -u origin "$branch" >/dev/null 2>&1
  git -C "$repo" fetch origin "$branch" >/dev/null 2>&1

  out="$(run_helper "$repo" "$wt" "$branch")"
  marker="$(marker_path "$repo" "$branch")"
  assert_contains "$out" "rc=0" "pushed return"
  assert_contains "$out" "outcome=safe_exact_remote" "pushed outcome"
  branch_exists "$repo" "$branch" && fail "pushed branch was retained"
  assert_absent "$wt"
  assert_absent "$marker"
  assert_exists "$(decision_path "$repo" "$branch")"
  [[ "$(jq -r '.classification' "$(decision_path "$repo" "$branch")")" == "safe_exact_remote" ]] || fail "pushed decision classification mismatch"
}

case_merged_deleted() {
  local repo branch wt out marker
  repo="$(setup_repo merged)"
  branch="task/merged"
  wt="$tmp/merged/wt"
  add_task_worktree "$repo" "$branch" "$wt"
  commit_in_worktree "$wt" "feature.txt" "feature"
  git -C "$repo" merge --ff-only "$branch" >/dev/null
  git -C "$repo" push origin auto/integration >/dev/null 2>&1

  out="$(run_helper "$repo" "$wt" "$branch")"
  marker="$(marker_path "$repo" "$branch")"
  assert_contains "$out" "rc=0" "merged return"
  assert_contains "$out" "outcome=safe_ancestor" "merged outcome"
  branch_exists "$repo" "$branch" && fail "merged branch was retained"
  assert_absent "$wt"
  assert_absent "$marker"
  assert_exists "$(decision_path "$repo" "$branch")"
  [[ "$(jq -r '.classification' "$(decision_path "$repo" "$branch")")" == "safe_ancestor" ]] || fail "merged decision classification mismatch"
  [[ "$(jq -r '.finalCheckPassed' "$(decision_path "$repo" "$branch")")" == "true" ]] || fail "merged decision finalCheckPassed mismatch"
}

case_pushed_then_local_commit_retained() {
  local repo branch wt out marker
  repo="$(setup_repo pushed-then-local)"
  branch="task/pushed-then-local"
  wt="$tmp/pushed-then-local/wt"
  add_task_worktree "$repo" "$branch" "$wt"
  commit_in_worktree "$wt" "feature.txt" "feature"
  git -C "$wt" push -u origin "$branch" >/dev/null 2>&1
  git -C "$repo" fetch origin "$branch" >/dev/null 2>&1
  commit_in_worktree "$wt" "local.txt" "local"

  out="$(run_helper "$repo" "$wt" "$branch")"
  marker="$(marker_path "$repo" "$branch")"
  assert_contains "$out" "rc=10" "pushed-then-local return"
  branch_exists "$repo" "$branch" || fail "pushed-then-local branch was deleted"
  assert_exists "$wt"
  assert_exists "$marker"
  [[ "$(jq -r '.reason' "$marker")" == "unpushed_commits" ]] || fail "pushed-then-local marker reason mismatch"
  [[ "$(jq -r '.verificationReason' "$marker")" == "remote_missing_local_head" ]] || fail "pushed-then-local verification reason mismatch"
  assert_contains "$out" "PRESERVED_UNPUSHED_WORK" "pushed-then-local warning"
}

case_stale_local_base_uses_origin_base() {
  local repo branch wt out marker
  repo="$(setup_repo stale-local-base)"
  branch="task/stale-local-base"
  wt="$tmp/stale-local-base/wt"
  add_task_worktree "$repo" "$branch" "$wt"
  commit_in_worktree "$wt" "feature.txt" "feature"
  git -C "$wt" push origin HEAD:auto/integration >/dev/null 2>&1

  out="$(run_helper "$repo" "$wt" "$branch")"
  marker="$(marker_path "$repo" "$branch")"
  assert_contains "$out" "rc=0" "stale-local-base return"
  branch_exists "$repo" "$branch" && fail "stale-local-base branch was retained"
  assert_absent "$wt"
  assert_absent "$marker"
}

case_remote_verification_failure_preserved() {
  local repo branch wt out marker
  repo="$(setup_repo remote-verification-failure)"
  branch="task/remote-verification-failure"
  wt="$tmp/remote-verification-failure/wt"
  add_task_worktree "$repo" "$branch" "$wt"
  commit_in_worktree "$wt" "feature.txt" "feature"
  git -C "$repo" remote set-url origin "$tmp/remote-verification-failure/missing-origin.git"

  out="$(run_helper "$repo" "$wt" "$branch")"
  marker="$(marker_path "$repo" "$branch")"
  assert_contains "$out" "rc=10" "remote-verification-failure return"
  branch_exists "$repo" "$branch" || fail "remote-verification-failure branch was deleted"
  assert_exists "$wt"
  assert_exists "$marker"
  [[ "$(jq -r '.verificationReason' "$marker")" == base_fetch_failed:* ]] || fail "remote-verification-failure reason mismatch"
  assert_contains "$out" "PRESERVED_UNPUSHED_WORK" "remote-verification-failure warning"
}

case_no_new_commits_deleted() {
  local repo branch wt out marker
  repo="$(setup_repo no-new-commits)"
  branch="task/no-new-commits"
  wt="$tmp/no-new-commits/wt"
  add_task_worktree "$repo" "$branch" "$wt"

  out="$(run_helper "$repo" "$wt" "$branch")"
  marker="$(marker_path "$repo" "$branch")"
  assert_contains "$out" "rc=0" "no-new return"
  branch_exists "$repo" "$branch" && fail "no-new branch was retained"
  assert_absent "$wt"
  assert_absent "$marker"
}

case_dirty_worktree_retained() {
  local repo branch wt out marker
  repo="$(setup_repo dirty)"
  branch="task/dirty"
  wt="$tmp/dirty/wt"
  add_task_worktree "$repo" "$branch" "$wt"
  printf 'dirty\n' > "$wt/dirty.txt"

  out="$(run_helper "$repo" "$wt" "$branch")"
  marker="$(marker_path "$repo" "$branch")"
  assert_contains "$out" "rc=10" "dirty return"
  assert_contains "$out" "outcome=retain_dirty" "dirty outcome"
  branch_exists "$repo" "$branch" || fail "dirty branch was deleted"
  assert_exists "$wt/dirty.txt"
  assert_exists "$marker"
  [[ "$(jq -r '.reason' "$marker")" == "dirty_worktree" ]] || fail "dirty marker reason mismatch"
  [[ "$(jq -r '.classification' "$marker")" == "retain_dirty" ]] || fail "dirty marker classification mismatch"
  assert_contains "$out" "PRESERVED_DIRTY_WORKTREE" "dirty warning"
}

# HOK-2972: the controller-owned observer artifact alone never makes a
# worktree dirty; cleanup proceeds and the artifact is migrated to the
# repository-level findings file rather than lost.
case_observer_artifact_only_cleaned() {
  local repo branch wt out
  repo="$(setup_repo observer-artifact)"
  branch="task/observer-artifact"
  wt="$tmp/observer-artifact/wt"
  add_task_worktree "$repo" "$branch" "$wt"
  mkdir -p "$wt/.wavemill"
  printf '{"title":"finding"}\n' > "$wt/.wavemill/observer-findings.jsonl"

  out="$(run_helper "$repo" "$wt" "$branch")"
  assert_contains "$out" "rc=0" "observer-artifact return"
  branch_exists "$repo" "$branch" && fail "observer-artifact branch was retained"
  assert_absent "$wt"
  assert_exists "$repo/.wavemill/observer-findings.jsonl"
  grep -q '"title":"finding"' "$repo/.wavemill/observer-findings.jsonl" \
    || fail "observer-artifact content was not migrated to the repo-level findings file"
}

# Any other untracked content - even next to the excluded artifact, even
# under .wavemill/ - still blocks destructive cleanup.
case_observer_artifact_plus_user_file_retained() {
  local repo branch wt out
  repo="$(setup_repo observer-artifact-dirty)"
  branch="task/observer-artifact-dirty"
  wt="$tmp/observer-artifact-dirty/wt"
  add_task_worktree "$repo" "$branch" "$wt"
  mkdir -p "$wt/.wavemill"
  printf '{"title":"finding"}\n' > "$wt/.wavemill/observer-findings.jsonl"
  printf 'user work\n' > "$wt/.wavemill/notes.md"

  out="$(run_helper "$repo" "$wt" "$branch")"
  assert_contains "$out" "rc=10" "observer-artifact-dirty return"
  assert_contains "$out" "outcome=retain_dirty" "observer-artifact-dirty outcome"
  branch_exists "$repo" "$branch" || fail "observer-artifact-dirty branch was deleted"
  assert_exists "$wt/.wavemill/notes.md"
  assert_exists "$wt/.wavemill/observer-findings.jsonl"
}

# Shared topology for the PR-aware cases: a squash-delivered branch. The task
# branch is pushed, origin auto/integration is rewritten with a squash commit
# of the branch tip, and the remote task branch is deleted, so neither the
# ancestry proof nor the exact-remote proof can authorize deletion.
setup_squash_delivery() {
  local case_name="$1"
  local repo branch wt origin squash_tree squash_commit origin_base_tip
  repo="$(setup_repo "$case_name")"
  branch="task/$case_name"
  wt="$tmp/$case_name/wt"
  origin="$tmp/$case_name/origin.git"
  add_task_worktree "$repo" "$branch" "$wt"
  commit_in_worktree "$wt" "feature.txt" "feature"
  git -C "$wt" push -u origin "$branch" >/dev/null 2>&1
  origin_base_tip="$(git -C "$repo" rev-parse auto/integration)"
  squash_tree="$(git -C "$wt" rev-parse "HEAD^{tree}")"
  squash_commit="$(git -C "$repo" commit-tree "$squash_tree" -p "$origin_base_tip" -m "feature (squash)")"
  git -C "$repo" push origin "$squash_commit:refs/heads/auto/integration" >/dev/null 2>&1
  git -C "$origin" update-ref -d "refs/heads/$branch"
  printf '%s\n' "$repo"
}

case_squash_pr_head_deleted() {
  local repo branch wt out marker decision head fixture
  repo="$(setup_squash_delivery squash-pr)"
  branch="task/squash-pr"
  wt="$tmp/squash-pr/wt"
  head="$(git -C "$wt" rev-parse HEAD)"
  fixture="$tmp/squash-pr/pr.json"
  record_pr_fixture "$fixture" "MERGED" "2026-09-04T12:00:00Z" "$head" "auto/integration"

  out="$(run_helper "$repo" "$wt" "$branch" "auto/integration" "test" "HOK-9001" "4242" "$fixture")"
  marker="$(marker_path "$repo" "$branch")"
  decision="$(decision_path "$repo" "$branch")"
  assert_contains "$out" "rc=0" "squash-pr return"
  assert_contains "$out" "outcome=safe_terminal_pr_head" "squash-pr outcome"
  branch_exists "$repo" "$branch" && fail "squash-pr branch was retained despite exact PR head proof"
  assert_absent "$wt"
  assert_absent "$marker"
  assert_exists "$decision"
  [[ "$(jq -r '.classification' "$decision")" == "safe_terminal_pr_head" ]] || fail "squash-pr decision classification mismatch"
  [[ "$(jq -r '.prHeadOid' "$decision")" == "$head" ]] || fail "squash-pr decision prHeadOid mismatch"
  [[ "$(jq -r '.localHeadSha' "$decision")" == "$head" ]] || fail "squash-pr decision localHeadSha mismatch"
  [[ "$(jq -r '.prState' "$decision")" == "MERGED" ]] || fail "squash-pr decision prState mismatch"
  [[ "$(jq -r '.baseSha' "$decision")" != "" ]] || fail "squash-pr decision baseSha missing"
  [[ "$(jq -r '.caller' "$decision")" == "test" ]] || fail "squash-pr decision caller mismatch"
  [[ "$(jq -r '.finalCheckPassed' "$decision")" == "true" ]] || fail "squash-pr decision finalCheckPassed mismatch"
  [[ "$(jq -r '.safeToDelete' "$decision")" == "true" ]] || fail "squash-pr decision safeToDelete mismatch"
  [[ "$(jq -r '.issue' "$decision")" == "HOK-9001" ]] || fail "squash-pr decision issue mismatch"
  [[ "$(jq -r '.prNumber' "$decision")" == "4242" ]] || fail "squash-pr decision prNumber mismatch"
}

case_squash_pr_head_shadow_records_decision() {
  local repo branch wt out decision head fixture
  repo="$(setup_squash_delivery squash-pr-shadow)"
  jq -n '{cleanup:{branchDeletion:{enabled:true,mode:"shadow"}}}' > "$repo/.wavemill-config.json"
  branch="task/squash-pr-shadow"
  wt="$tmp/squash-pr-shadow/wt"
  head="$(git -C "$wt" rev-parse HEAD)"
  fixture="$tmp/squash-pr-shadow/pr.json"
  record_pr_fixture "$fixture" "MERGED" "2026-09-04T12:00:00Z" "$head" "auto/integration"

  out="$(run_helper "$repo" "$wt" "$branch" "auto/integration" "test" "HOK-9010" "4242" "$fixture")"
  decision="$(decision_path "$repo" "$branch")"
  assert_contains "$out" "rc=0" "squash-pr-shadow return"
  assert_contains "$out" "outcome=shadow_would_delete" "squash-pr-shadow outcome"
  branch_exists "$repo" "$branch" || fail "squash-pr-shadow branch was deleted in shadow mode"
  assert_absent "$wt"
  assert_exists "$decision"
  [[ "$(jq -r '.classification' "$decision")" == "safe_terminal_pr_head" ]] || fail "squash-pr-shadow decision classification mismatch"
  [[ "$(jq -r '.mode' "$decision")" == "shadow" ]] || fail "squash-pr-shadow decision mode mismatch"
  [[ "$(jq -r '.wouldDelete' "$decision")" == "true" ]] || fail "squash-pr-shadow wouldDelete mismatch"
  [[ "$(jq -r '.authority' "$decision")" == *"headRefOid exactly equal"* ]] || fail "squash-pr-shadow authority missing"
  [[ "$(jq -r '.finalCheckPassed' "$decision")" == "true" ]] || fail "squash-pr-shadow finalCheckPassed mismatch"
}

case_pr_head_mismatch_retained() {
  local repo branch wt out marker fixture
  repo="$(setup_squash_delivery squash-pr-mismatch)"
  branch="task/squash-pr-mismatch"
  wt="$tmp/squash-pr-mismatch/wt"
  fixture="$tmp/squash-pr-mismatch/pr.json"
  record_pr_fixture "$fixture" "MERGED" "2026-09-04T12:00:00Z" \
    "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" "auto/integration"

  out="$(run_helper "$repo" "$wt" "$branch" "auto/integration" "test" "HOK-9002" "4242" "$fixture")"
  marker="$(marker_path "$repo" "$branch")"
  assert_contains "$out" "rc=10" "pr-mismatch return"
  assert_contains "$out" "outcome=retain_unpublished" "pr-mismatch outcome"
  branch_exists "$repo" "$branch" || fail "pr-mismatch branch was deleted despite differing PR head"
  assert_exists "$wt"
  assert_exists "$marker"
  [[ "$(jq -r '.classification' "$marker")" == "retain_unpublished" ]] || fail "pr-mismatch marker classification mismatch"
  [[ "$(jq -r '.verificationReason' "$marker")" == "changed_after_pr_head" ]] || fail "pr-mismatch marker verification reason mismatch"
  [[ "$(jq -r '.operatorGuidance' "$marker")" == *"inspect the extra commits"* ]] || fail "pr-mismatch marker guidance mismatch"
}

case_pr_closed_unmerged_retained() {
  local repo branch wt out marker fixture head
  repo="$(setup_squash_delivery squash-pr-closed)"
  branch="task/squash-pr-closed"
  wt="$tmp/squash-pr-closed/wt"
  head="$(git -C "$wt" rev-parse HEAD)"
  fixture="$tmp/squash-pr-closed/pr.json"
  record_pr_fixture "$fixture" "CLOSED" "null" "$head" "auto/integration"

  out="$(run_helper "$repo" "$wt" "$branch" "auto/integration" "test" "HOK-9003" "4242" "$fixture")"
  marker="$(marker_path "$repo" "$branch")"
  assert_contains "$out" "rc=10" "pr-closed return"
  assert_contains "$out" "outcome=retain_closed_unmerged" "pr-closed outcome"
  branch_exists "$repo" "$branch" || fail "pr-closed branch was deleted"
  assert_exists "$wt"
  assert_exists "$marker"
  [[ "$(jq -r '.classification' "$marker")" == "retain_closed_unmerged" ]] || fail "pr-closed marker classification mismatch"
  [[ "$(jq -r '.operatorGuidance' "$marker")" == *"closed without merging"* ]] || fail "pr-closed marker guidance mismatch"
  assert_contains "$out" "closed without merging" "pr-closed scenario guidance in warning"
}

case_pr_lookup_failure_retained() {
  local repo branch wt out marker
  repo="$(setup_squash_delivery squash-pr-lookup)"
  branch="task/squash-pr-lookup"
  wt="$tmp/squash-pr-lookup/wt"

  out="$(run_helper "$repo" "$wt" "$branch" "auto/integration" "test" "HOK-9004" "4242" "")"
  marker="$(marker_path "$repo" "$branch")"
  assert_contains "$out" "rc=10" "pr-lookup return"
  assert_contains "$out" "outcome=retain_unverifiable" "pr-lookup outcome"
  branch_exists "$repo" "$branch" || fail "pr-lookup branch was deleted"
  assert_exists "$wt"
  assert_exists "$marker"
  [[ "$(jq -r '.classification' "$marker")" == "retain_unverifiable" ]] || fail "pr-lookup marker classification mismatch"
  [[ "$(jq -r '.verificationReason' "$marker")" == "pr_lookup_failed" ]] || fail "pr-lookup marker verification reason mismatch"
}

case_pr_base_mismatch_retained() {
  local repo branch wt out marker fixture head
  repo="$(setup_squash_delivery squash-pr-base)"
  branch="task/squash-pr-base"
  wt="$tmp/squash-pr-base/wt"
  head="$(git -C "$wt" rev-parse HEAD)"
  fixture="$tmp/squash-pr-base/pr.json"
  record_pr_fixture "$fixture" "MERGED" "2026-09-04T12:00:00Z" "$head" "main"

  out="$(run_helper "$repo" "$wt" "$branch" "auto/integration" "test" "HOK-9005" "4242" "$fixture")"
  marker="$(marker_path "$repo" "$branch")"
  assert_contains "$out" "rc=10" "pr-base return"
  assert_contains "$out" "outcome=retain_unverifiable" "pr-base outcome"
  branch_exists "$repo" "$branch" || fail "pr-base branch was deleted"
  assert_exists "$marker"
  [[ "$(jq -r '.verificationReason' "$marker")" == pr_base_mismatch:* ]] || fail "pr-base marker verification reason mismatch"
}

case_pr_gate_disabled_retained() {
  local repo branch wt out marker fixture head
  repo="$(setup_squash_delivery squash-pr-gated)"
  branch="task/squash-pr-gated"
  wt="$tmp/squash-pr-gated/wt"
  head="$(git -C "$wt" rev-parse HEAD)"
  fixture="$tmp/squash-pr-gated/pr.json"
  record_pr_fixture "$fixture" "MERGED" "2026-09-04T12:00:00Z" "$head" "auto/integration"

  out="$(run_helper "$repo" "$wt" "$branch" "auto/integration" "test" "HOK-9006" "4242" "$fixture" "0")"
  marker="$(marker_path "$repo" "$branch")"
  assert_contains "$out" "rc=10" "pr-gated return"
  assert_contains "$out" "outcome=retain_unpublished" "pr-gated outcome"
  branch_exists "$repo" "$branch" || fail "pr-gated branch was deleted with PR-aware authority disabled"
  assert_exists "$wt"
  assert_exists "$marker"
  [[ "$(jq -r '.verificationReason' "$marker")" == "remote_missing_local_head" ]] || fail "pr-gated marker verification reason mismatch"
}

case_protected_branch_refused() {
  local repo out
  repo="$(setup_repo protected)"
  out="$(run_helper "$repo" "$repo" "main")"
  assert_contains "$out" "rc=0" "protected return"
  assert_contains "$out" "Refusing to delete protected branch: main" "protected warning"
  assert_absent "$repo/.wavemill/incidents/preserved-branches/main.json"
}

case_branch_already_absent() {
  local repo out
  repo="$(setup_repo absent)"
  out="$(run_helper "$repo" "" "task/absent")"
  assert_contains "$out" "rc=0" "absent return"
}

case_unresolvable_base_preserved() {
  local repo branch wt out marker
  repo="$(setup_repo missing-base)"
  branch="task/missing-base"
  wt="$tmp/missing-base/wt"
  add_task_worktree "$repo" "$branch" "$wt"
  commit_in_worktree "$wt" "feature.txt" "feature"

  out="$(run_helper "$repo" "$wt" "$branch" "missing/base")"
  marker="$(marker_path "$repo" "$branch")"
  assert_contains "$out" "rc=10" "missing-base return"
  branch_exists "$repo" "$branch" || fail "missing-base branch was deleted"
  assert_exists "$wt"
  assert_exists "$marker"
  [[ "$(jq -r '.reason' "$marker")" == "unpushed_commits" ]] || fail "missing-base marker reason mismatch"
}

case_all_sites_refactored() {
  local non_helper_matches helper_matches
  non_helper_matches="$(grep -nE 'branch -[dD]|worktree remove --force|worktree remove' \
    "$REPO_ROOT/shared/lib/wavemill-mill.sh" \
    "$REPO_ROOT/shared/lib/wavemill-monitor.sh" \
    "$REPO_ROOT/shared/lib/wavemill-startup-runner.sh" || true)"
  [[ -z "$non_helper_matches" ]] || fail "unsafe cleanup remains outside helper: $non_helper_matches"

  helper_matches="$(extract_function "$COMMON_SCRIPT" "safe_remove_task_worktree_and_branch")"
  assert_contains "$helper_matches" "worktree remove" "helper worktree cleanup"
  assert_contains "$helper_matches" "branch \"\$branch_delete_flag\"" "helper branch cleanup"
  assert_contains "$helper_matches" "branch_delete_flag=\"-D\"" "helper force cleanup only after guard"
  [[ "$helper_matches" != *"--force"* ]] || fail "helper still force-removes worktrees"
}

# Assertion 1 (HOK-3042/HOK-3033 shape): an orphan task directory (no task-local
# .git metadata; git rev-parse --show-toplevel would walk up to the parent
# wavemill repo) must not inherit dirt from that parent. It must be classified
# retain_orphan_dir with the identity_verification reason, never retain_dirty.
case_orphan_dir_no_git_metadata_retained() {
  local repo branch wt out marker parent_top
  repo="$(setup_repo orphan-nested)"
  branch="task/orphan-nested"
  wt="$repo/wavemill-worktrees/orphan-nested"
  # Dirty the parent repo so the ancestor walk would report dirty state.
  printf 'stray\n' > "$repo/parent-dirty.txt"
  mkdir -p "$wt"
  printf 'feature\n' > "$wt/feature.txt"

  out="$(run_helper "$repo" "$wt" "$branch")"
  marker="$(marker_path "$repo" "$branch")"
  assert_contains "$out" "rc=10" "orphan-nested return"
  assert_contains "$out" "outcome=retain_orphan_dir" "orphan-nested classified as retain_orphan_dir, not retain_dirty"
  assert_exists "$wt"
  assert_exists "$wt/feature.txt"
  assert_exists "$marker"
  [[ "$(jq -r '.reason' "$marker")" == "orphan_worktree" ]] || fail "orphan-nested marker reason mismatch"
  [[ "$(jq -r '.verificationReason' "$marker")" == no_git_metadata* ]] \
    || [[ "$(jq -r '.verificationReason' "$marker")" == toplevel_mismatch* ]] \
    || fail "orphan-nested verification reason should be identity-related, got: $(jq -r '.verificationReason' "$marker")"
  assert_contains "$out" "PRESERVED_ORPHAN_DIR" "orphan-nested warning"
}

# Orphan with an independent user file must be retained (allowlist scan flags
# the file).
case_orphan_dir_with_user_file_retained() {
  local repo branch wt out marker
  repo="$(setup_repo orphan-userfile)"
  branch="task/orphan-userfile"
  wt="$repo/wavemill-worktrees/orphan-userfile"
  mkdir -p "$wt/features/orphan-userfile"
  printf 'ok\n' > "$wt/features/orphan-userfile/task-packet.md"
  printf 'user notes\n' > "$wt/notes-from-user.md"

  out="$(run_helper "$repo" "$wt" "$branch")"
  marker="$(marker_path "$repo" "$branch")"
  assert_contains "$out" "rc=10" "orphan-userfile return"
  assert_contains "$out" "outcome=retain_orphan_dir" "orphan-userfile outcome"
  assert_exists "$wt/notes-from-user.md"
  assert_exists "$marker"
  assert_contains "$out" "notes-from-user.md" "orphan-userfile scan lists the offending path"
}

# Orphan containing ONLY wavemill-generated artifacts must be classified
# retain_orphan_dir (no branch present) but the directory is safe to delete via
# the orphan removal path.
case_orphan_dir_wavemill_artifacts_removable() {
  local repo branch wt marker
  repo="$(setup_repo orphan-wavemill)"
  branch="task/orphan-wavemill"
  wt="$repo/wavemill-worktrees/orphan-wavemill"
  mkdir -p "$wt/features/orphan-wavemill" "$wt/.claude" "$wt/.wavemill"
  printf 'ok\n' > "$wt/features/orphan-wavemill/task-packet.md"
  printf '{}\n' > "$wt/.claude/settings.local.json"
  printf '{"title":"finding"}\n' > "$wt/.wavemill/observer-findings.jsonl"

  # Direct helper call: classification alone (branch does not exist).
  local out
  out="$(run_helper "$repo" "$wt" "$branch")"
  # With no branch and only allowlisted files, orphan removal path applies.
  # rc=0 with successful removal, or rc=10 retained-orphan (still safe: dir
  # unchanged). Either way the directory must not be misclassified as dirty.
  [[ "$out" == *"outcome=retain_dirty"* ]] && fail "orphan-wavemill misclassified as dirty"
  [[ "$out" == *"outcome=retain_orphan_dir"* || "$out" == *"outcome=safe_noop"* ]] \
    || fail "orphan-wavemill unexpected outcome: $out"
}

# Bounded-path refusal: wavemill_remove_orphan_task_dir must refuse when the
# path is outside WORKTREE_ROOT.
case_orphan_removal_refuses_outside_bounded_root() {
  local repo out root
  repo="$(setup_repo orphan-outside)"
  root="$tmp/orphan-outside/root"
  mkdir -p "$root"
  local target="$tmp/orphan-outside-external/wt"
  mkdir -p "$target"
  printf 'x\n' > "$target/junk"

  # Invoke removal helper directly through a subshell that sources the
  # extracted helpers.
  out="$(REPO_DIR="$repo" WT="$target" WORKTREE_ROOT="$root" HELPER_FILE="$helper_file" bash -lc '
    set -euo pipefail
    source "$HELPER_FILE"
    log() { true; }
    log_warn() { true; }
    _with_timeout() { shift; "$@"; }
    set +e
    wavemill_remove_orphan_task_dir "$WT" "task/orphan-outside"
    printf "rc=%s\n" "$?"
  ')"
  assert_contains "$out" "rc=1" "orphan removal must refuse path outside WORKTREE_ROOT"
  assert_exists "$target/junk"
}

# Assertion 2 (HOK-3018 shape): a merged-PR task with a later local commit
# whose patch is patch-equivalent to a commit already on the authoritative base
# is classified safe_patch_equivalent_pr and reaped. `git cherry` marks the
# post-PR commit with `-` (delivered), which cleanup must honour rather than
# stopping at changed_after_pr_head.
case_post_pr_patch_equivalent_deleted() {
  local repo branch wt out decision head_at_pr head_final fixture
  local squash_tree_a squash_commit_a
  local unique_tree_b unique_commit_b_delivered
  local origin_base_tip origin
  repo="$(setup_repo post-pr-equiv)"
  branch="task/post-pr-equiv"
  wt="$tmp/post-pr-equiv/wt"
  origin="$tmp/post-pr-equiv/origin.git"
  add_task_worktree "$repo" "$branch" "$wt"

  # Commit A on the task branch, push it and record its SHA as the PR head.
  commit_in_worktree "$wt" "featureA.txt" "featureA"
  git -C "$wt" push -u origin "$branch" >/dev/null 2>&1
  head_at_pr="$(git -C "$wt" rev-parse HEAD)"

  # Simulate squash-delivery of A: origin auto/integration gets a squash
  # commit with A's tree; the remote task branch is removed.
  origin_base_tip="$(git -C "$repo" rev-parse auto/integration)"
  squash_tree_a="$(git -C "$wt" rev-parse HEAD^{tree})"
  squash_commit_a="$(git -C "$repo" commit-tree "$squash_tree_a" -p "$origin_base_tip" -m "featureA (squash)")"
  git -C "$repo" push origin "$squash_commit_a:refs/heads/auto/integration" >/dev/null 2>&1
  git -C "$origin" update-ref -d "refs/heads/$branch"

  # Local commit B on the task branch after PR head — introduces featureB.
  commit_in_worktree "$wt" "featureB.txt" "featureB"
  head_final="$(git -C "$wt" rev-parse HEAD)"
  unique_tree_b="$(git -C "$wt" rev-parse HEAD^{tree})"

  # ALSO deliver B to origin/auto/integration via a distinct commit SHA —
  # same tree diff (featureB.txt) but different commit metadata. This is
  # exactly the HOK-3018 shape: post-PR commit is delivered elsewhere.
  unique_commit_b_delivered="$(git -C "$repo" commit-tree "$unique_tree_b" -p "$squash_commit_a" -m "featureB (delivered)")"
  git -C "$repo" push origin "$unique_commit_b_delivered:refs/heads/auto/integration" >/dev/null 2>&1

  fixture="$tmp/post-pr-equiv/pr.json"
  # Full fixture including mergeCommit — patch-equivalence path requires a
  # non-empty merge SHA to authorize deletion.
  jq -cn --arg headOid "$head_at_pr" --arg mergeSha "$squash_commit_a" \
    '{number: 4242, state: "MERGED", mergedAt: "2026-09-04T12:00:00Z",
      headRefOid: $headOid, headRefName: "task/fixture",
      baseRefName: "auto/integration",
      mergeCommit: {oid: $mergeSha}}' > "$fixture"

  out="$(run_helper "$repo" "$wt" "$branch" "auto/integration" "test" "HOK-3018" "4242" "$fixture")"
  decision="$(decision_path "$repo" "$branch")"
  # Local head has one commit beyond head_at_pr; that commit is
  # patch-equivalent to unique_commit_b_delivered on origin/base.
  # `git cherry` should emit `-` for it → safe_patch_equivalent_pr.
  assert_contains "$out" "rc=0" "post-pr-equiv return"
  assert_contains "$out" "outcome=safe_patch_equivalent_pr" "post-pr-equiv outcome"
  branch_exists "$repo" "$branch" && fail "post-pr-equiv branch retained despite delivered post-PR commit"
  assert_absent "$wt"
  assert_exists "$decision"
  [[ "$(jq -r '.classification' "$decision")" == "safe_patch_equivalent_pr" ]] \
    || fail "post-pr-equiv decision classification mismatch"
  [[ "$(jq -r '.patchEquivalence.status' "$decision")" == "equivalent" ]] \
    || fail "post-pr-equiv decision patchEquivalence.status should be 'equivalent', got: $(jq -r '.patchEquivalence.status' "$decision")"
  # Delivered commit count = 1 (the post-PR commit B).
  [[ "$(jq -r '.patchEquivalence.equivalentCount' "$decision")" == "1" ]] \
    || fail "post-pr-equiv patchEquivalence.equivalentCount should be 1, got: $(jq -r '.patchEquivalence.equivalentCount' "$decision")"
}

# Assertion 3: a merged-PR task with a genuinely unique post-PR commit must
# be retained with the SHA visible.
case_post_pr_unique_commit_retained() {
  local repo branch wt out marker fixture head_at_pr squash_tree squash_commit origin_base_tip origin
  repo="$(setup_repo post-pr-unique)"
  branch="task/post-pr-unique"
  wt="$tmp/post-pr-unique/wt"
  origin="$tmp/post-pr-unique/origin.git"
  add_task_worktree "$repo" "$branch" "$wt"

  commit_in_worktree "$wt" "featureA.txt" "featureA"
  git -C "$wt" push -u origin "$branch" >/dev/null 2>&1
  head_at_pr="$(git -C "$wt" rev-parse HEAD)"

  origin_base_tip="$(git -C "$repo" rev-parse auto/integration)"
  squash_tree="$(git -C "$wt" rev-parse HEAD^{tree})"
  squash_commit="$(git -C "$repo" commit-tree "$squash_tree" -p "$origin_base_tip" -m "featureA (squash)")"
  git -C "$repo" push origin "$squash_commit:refs/heads/auto/integration" >/dev/null 2>&1
  git -C "$origin" update-ref -d "refs/heads/$branch"

  # Post-PR unique commit with brand new content.
  commit_in_worktree "$wt" "unique.txt" "unique post-PR work"

  fixture="$tmp/post-pr-unique/pr.json"
  jq -cn --arg headOid "$head_at_pr" --arg mergeSha "$squash_commit" \
    '{number: 4242, state: "MERGED", mergedAt: "2026-09-04T12:00:00Z",
      headRefOid: $headOid, headRefName: "task/fixture",
      baseRefName: "auto/integration", mergeCommit: {oid: $mergeSha}}' > "$fixture"

  out="$(run_helper "$repo" "$wt" "$branch" "auto/integration" "test" "HOK-3018U" "4242" "$fixture")"
  marker="$(marker_path "$repo" "$branch")"
  assert_contains "$out" "rc=10" "post-pr-unique return"
  assert_contains "$out" "outcome=retain_unpublished" "post-pr-unique outcome"
  branch_exists "$repo" "$branch" || fail "post-pr-unique branch was deleted despite unique commit"
  assert_exists "$wt"
  assert_exists "$marker"
  [[ "$(jq -r '.classification' "$marker")" == "retain_unpublished" ]] \
    || fail "post-pr-unique marker classification mismatch"
  [[ "$(jq -r '.verificationReason' "$marker")" == "unique_local_patch" ]] \
    || fail "post-pr-unique marker should report unique_local_patch, got: $(jq -r '.verificationReason' "$marker")"
}

case_squash_content_equivalent_with_different_patch_id_deleted() {
  local repo branch wt head_at_pr fixture out merge_sha
  repo="$(setup_repo content-equivalent)"
  branch="task/content-equivalent"
  wt="$tmp/content-equivalent/wt"
  add_task_worktree "$repo" "$branch" "$wt"
  commit_in_worktree "$wt" "featureA.txt" "featureA"
  head_at_pr="$(git -C "$wt" rev-parse HEAD)"
  commit_in_worktree "$wt" "featureB.txt" "featureB"

  # The squash includes both task files and an unrelated base-only file. Its
  # patch ID cannot match the post-PR task commit, but merging the retained
  # branch into the base contributes no file content.
  cp "$wt/featureA.txt" "$repo/featureA.txt"
  cp "$wt/featureB.txt" "$repo/featureB.txt"
  printf 'base-only\n' > "$repo/base-only.txt"
  git -C "$repo" add featureA.txt featureB.txt base-only.txt
  git -C "$repo" commit -m "combined squash delivery" >/dev/null
  merge_sha="$(git -C "$repo" rev-parse HEAD)"
  git -C "$repo" push origin auto/integration >/dev/null 2>&1
  fixture="$tmp/content-equivalent/pr.json"
  jq -cn --arg headOid "$head_at_pr" --arg mergeSha "$merge_sha" \
    '{number: 4242, state: "MERGED", mergedAt: "2026-09-04T12:00:00Z",
      headRefOid: $headOid, headRefName: "task/fixture",
      baseRefName: "auto/integration", mergeCommit: {oid: $mergeSha}}' > "$fixture"

  [[ "$(git -C "$repo" cherry origin/auto/integration "$branch" "$head_at_pr" | awk '/^\+/ {count++} END {print count+0}')" == "1" ]] \
    || fail "content-equivalent fixture did not produce a distinct patch ID"
  out="$(run_helper "$repo" "$wt" "$branch" auto/integration test HOK-9003 4242 "$fixture")"
  assert_contains "$out" "outcome=safe_content_equivalent_pr" "content-equivalent outcome"
  branch_exists "$repo" "$branch" && fail "content-equivalent branch was retained"
  assert_absent "$wt"
}

case_orphan_generated_markers_with_merged_pr_deleted() {
  local repo branch wt head fixture out
  repo="$(setup_squash_delivery orphan-delivered)"
  branch="task/orphan-delivered"
  wt="$tmp/orphan-delivered/wt"
  head="$(git -C "$wt" rev-parse HEAD)"
  git -C "$repo" worktree remove --force "$wt"
  wt="$tmp/orphan-delivered/orphan-delivered"
  mkdir -p "$wt/features/orphan-delivered"
  printf 'done\n' > "$wt/features/orphan-delivered/.needs-attention"
  printf '{}\n' > "$wt/features/orphan-delivered/.terminal-history.jsonl"
  : > "$wt/features/orphan-delivered/.ready-bypass-warned"
  fixture="$tmp/orphan-delivered/pr.json"
  record_pr_fixture "$fixture" MERGED 2026-09-04T12:00:00Z "$head" auto/integration

  out="$(run_helper "$repo" "$wt" "$branch" auto/integration test HOK-9004 4242 "$fixture")"
  assert_contains "$out" "outcome=safe_terminal_pr_head" "orphan-delivered outcome"
  branch_exists "$repo" "$branch" && fail "delivered orphan branch was retained"
  assert_absent "$wt"
}

# Assertion 4: the read-only classifier delegates to the destructive path in
# WAVEMILL_CLASSIFY_ONLY=1 mode. Both must agree on classification for the same
# input, and the classifier must not touch state.
case_classifier_parity_read_only_matches_destructive() {
  local repo branch wt out classify_out classify_json destructive_class
  repo="$(setup_repo classify-parity)"
  branch="task/classify-parity"
  wt="$tmp/classify-parity/wt"
  add_task_worktree "$repo" "$branch" "$wt"
  commit_in_worktree "$wt" "feature.txt" "feature"

  # Snapshot .wavemill/incidents dir contents before the classify call.
  local before_incidents=""
  [[ -d "$repo/.wavemill/incidents" ]] && before_incidents="$(find "$repo/.wavemill/incidents" -type f 2>/dev/null | sort)"

  classify_out="$(REPO_DIR="$repo" WT="$wt" BRANCH="$branch" HELPER_FILE="$helper_file" bash -lc '
    set -euo pipefail
    source "$HELPER_FILE"
    log() { true; }
    log_warn() { true; }
    _with_timeout() { shift; "$@"; }
    set +e
    wavemill_classify_task_cleanup "$WT" "$BRANCH" auto/integration classify
    printf "rc=%s\n" "$?"
    printf "outcome=%s\n" "${WAVEMILL_CLEANUP_OUTCOME:-}"
  ')"
  classify_json="$(printf '%s\n' "$classify_out" | head -1)"
  [[ -n "$classify_json" ]] || fail "classifier produced no JSON"

  # State must not have changed after read-only classification.
  local after_incidents=""
  [[ -d "$repo/.wavemill/incidents" ]] && after_incidents="$(find "$repo/.wavemill/incidents" -type f 2>/dev/null | sort)"
  [[ "$before_incidents" == "$after_incidents" ]] \
    || fail "classifier wrote to .wavemill/incidents (read-only violation)"

  # Now run destructive path and compare classification.
  out="$(run_helper "$repo" "$wt" "$branch")"
  destructive_class="$(printf '%s\n' "$out" | awk -F= '/^outcome=/ {print $2}')"

  local classify_class
  classify_class="$(printf '%s' "$classify_json" | jq -r '.classification')"

  [[ "$classify_class" == "$destructive_class" ]] \
    || fail "classifier/destructive disagreement: classifier=$classify_class destructive=$destructive_class"
}

case_unpushed_commits_retained
case_pushed_unmerged_deleted
case_merged_deleted
case_pushed_then_local_commit_retained
case_stale_local_base_uses_origin_base
case_remote_verification_failure_preserved
case_no_new_commits_deleted
case_dirty_worktree_retained
case_observer_artifact_only_cleaned
case_observer_artifact_plus_user_file_retained
case_squash_pr_head_deleted
case_squash_pr_head_shadow_records_decision
case_pr_head_mismatch_retained
case_pr_closed_unmerged_retained
case_pr_lookup_failure_retained
case_pr_base_mismatch_retained
case_pr_gate_disabled_retained
case_protected_branch_refused
case_branch_already_absent
case_unresolvable_base_preserved
case_all_sites_refactored
case_orphan_dir_no_git_metadata_retained
case_orphan_dir_with_user_file_retained
case_orphan_dir_wavemill_artifacts_removable
case_orphan_removal_refuses_outside_bounded_root
case_post_pr_patch_equivalent_deleted
case_post_pr_unique_commit_retained
case_squash_content_equivalent_with_different_patch_id_deleted
case_orphan_generated_markers_with_merged_pr_deleted
case_classifier_parity_read_only_matches_destructive

echo "safe-branch-cleanup test passed"
