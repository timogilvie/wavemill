#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=../shared/lib/wavemill-common.sh
source "$REPO_DIR_ROOT/shared/lib/wavemill-common.sh"
# shellcheck source=../shared/lib/terminal-reconciler.sh
source "$REPO_DIR_ROOT/shared/lib/terminal-reconciler.sh"
# shellcheck source=../shared/lib/startup-terminal-preflight.sh
source "$REPO_DIR_ROOT/shared/lib/startup-terminal-preflight.sh"

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/wavemill-terminal-lifecycle-flags.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT
export HOME="$TMP_ROOT/home"
mkdir -p "$HOME"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

assert_eq() {
  local expected="$1" actual="$2" label="$3"
  [[ "$expected" == "$actual" ]] || fail "$label: expected '$expected', got '$actual'"
}

assert_true() {
  local label="$1"
  shift
  "$@" || fail "$label"
}

write_repo_config() {
  local repo="$1" json="$2"
  printf '%s\n' "$json" > "$repo/.wavemill-config.json"
}

setup_repo() {
  local name="$1" repo origin
  repo="$TMP_ROOT/$name/repo"
  origin="$TMP_ROOT/$name/origin.git"
  mkdir -p "$TMP_ROOT/$name"
  git init --bare "$origin" >/dev/null
  git clone "$origin" "$repo" >/dev/null 2>&1
  git -C "$repo" config user.email "test@example.com"
  git -C "$repo" config user.name "Wavemill Flag Test"
  git -C "$repo" checkout -b auto/integration >/dev/null 2>&1
  printf 'base\n' > "$repo/README.md"
  git -C "$repo" add README.md
  git -C "$repo" commit -m "base" >/dev/null
  git -C "$repo" push -u origin auto/integration >/dev/null 2>&1
  printf '%s\n' "$repo"
}

add_pushed_worktree() {
  local repo="$1" branch="$2" wt="$3"
  git -C "$repo" branch "$branch" auto/integration
  git -C "$repo" worktree add "$wt" "$branch" >/dev/null 2>&1
  printf 'feature\n' > "$wt/feature.txt"
  git -C "$wt" add feature.txt
  git -C "$wt" commit -m "feature" >/dev/null
  git -C "$wt" push -u origin "$branch" >/dev/null 2>&1
}

branch_exists() {
  git -C "$1" show-ref --verify --quiet "refs/heads/$2"
}

decision_path() {
  printf '%s/.wavemill/incidents/cleanup-decisions/%s.json\n' "$1" "${2//\//__}"
}

run_safe_cleanup() {
  local repo="$1" wt="$2" branch="$3" issue="${4:-HOK-2957}" pr="${5:-}"
  REPO_DIR="$repo"
  STATE_FILE="$repo/.wavemill/workflow-state.json"
  MILL_LOG_FILE="$repo/mill.log"
  API_TIMEOUT=5
  mkdir -p "$repo/.wavemill"
  [[ -f "$STATE_FILE" ]] || printf '{"tasks":{}}\n' > "$STATE_FILE"
  : > "$MILL_LOG_FILE"
  LOG_OUTPUT=""
  WARN_OUTPUT=""
  log() { LOG_OUTPUT+="$*\n"; }
  log_warn() { WARN_OUTPUT+="$*\n"; }
  _with_timeout() { shift; "$@"; }
  set +e
  safe_remove_task_worktree_and_branch "$wt" "$branch" "auto/integration" "terminal-lifecycle-flags" "$issue" "$pr"
  local rc=$?
  set -e
  printf 'rc=%s\noutcome=%s\n' "$rc" "${WAVEMILL_CLEANUP_OUTCOME:-}"
}

test_pane_release_flag_independent() {
  local repo
  repo="$(setup_repo pane-release)"
  REPO_DIR="$repo"
  write_repo_config "$repo" '{"terminal":{"paneRelease":{"enabled":false}},"cleanup":{"branchDeletion":{"mode":"enforce"}}}'
  assert_eq "metadata-only" "$(wavemill_terminal_pane_policy_for_reason pr_merged)" "pane release config gate"
  write_repo_config "$repo" '{"terminal":{"paneRelease":{"enabled":true}},"cleanup":{"branchDeletion":{"mode":"enforce"}}}'
  assert_eq "metadata-only" "$(WAVEMILL_TERMINAL_PANE_RELEASE=0 wavemill_terminal_pane_policy_for_reason pr_merged)" "pane release env kill-switch"
  assert_eq "enforce" "$(wavemill_branch_deletion_mode)" "pane release config does not affect branch deletion"
}

test_startup_preflight_flag_independent() {
  local repo
  repo="$(setup_repo startup-preflight)"
  REPO_DIR="$repo"
  write_repo_config "$repo" '{"startup":{"terminalPreflight":{"enabled":false}},"cleanup":{"branchDeletion":{"mode":"enforce"}}}'
  assert_eq "false" "$(startup_preflight_enabled)" "startup preflight config gate"
  write_repo_config "$repo" '{"startup":{"terminalPreflight":{"enabled":true}},"cleanup":{"branchDeletion":{"mode":"enforce"}}}'
  assert_eq "false" "$(WAVEMILL_STARTUP_TERMINAL_PREFLIGHT=0 startup_preflight_enabled)" "startup preflight env kill-switch"
  assert_eq "enforce" "$(wavemill_branch_deletion_mode)" "startup preflight config does not affect branch deletion"
}

test_cleanup_episode_flag_independent() {
  local repo
  repo="$(setup_repo cleanup-episodes)"
  REPO_DIR="$repo"
  write_repo_config "$repo" '{"cleanup":{"episodes":{"enabled":false},"branchDeletion":{"mode":"enforce"}}}'
  if cleanup_episode_enabled; then
    fail "cleanup episode config gate stayed enabled"
  fi
  assert_eq "enforce" "$(wavemill_branch_deletion_mode)" "cleanup episodes do not affect branch deletion"
}

test_branch_deletion_shadow_and_enforce() {
  local repo branch wt out decision
  repo="$(setup_repo branch-shadow)"
  branch="task/branch-shadow"
  wt="$TMP_ROOT/branch-shadow/wt"
  add_pushed_worktree "$repo" "$branch" "$wt"

  out="$(run_safe_cleanup "$repo" "$wt" "$branch")"
  decision="$(decision_path "$repo" "$branch")"
  assert_eq "0" "$(printf '%s\n' "$out" | awk -F= '$1=="rc"{print $2}')" "shadow cleanup rc"
  assert_eq "shadow_would_delete" "$(printf '%s\n' "$out" | awk -F= '$1=="outcome"{print $2}')" "shadow cleanup outcome"
  assert_true "shadow mode retains local branch" branch_exists "$repo" "$branch"
  [[ ! -d "$wt" ]] || fail "shadow mode should still remove the worktree"
  assert_true "shadow mode records decision" test -f "$decision"
  assert_eq "shadow" "$(jq -r '.mode' "$decision")" "shadow decision mode"
  assert_eq "true" "$(jq -r '.wouldDelete' "$decision")" "shadow decision wouldDelete"

  repo="$(setup_repo branch-enforce)"
  branch="task/branch-enforce"
  wt="$TMP_ROOT/branch-enforce/wt"
  write_repo_config "$repo" '{"cleanup":{"branchDeletion":{"enabled":true,"mode":"enforce"}}}'
  add_pushed_worktree "$repo" "$branch" "$wt"
  out="$(run_safe_cleanup "$repo" "$wt" "$branch")"
  assert_eq "safe_exact_remote" "$(printf '%s\n' "$out" | awk -F= '$1=="outcome"{print $2}')" "enforce cleanup outcome"
  if branch_exists "$repo" "$branch"; then
    fail "enforce mode retained local branch"
  fi
}

test_pr_aware_deletion_gate_preserves_contradictory_work() {
  local repo origin branch wt head fixture out marker
  repo="$(setup_repo pr-aware-disabled)"
  origin="$TMP_ROOT/pr-aware-disabled/origin.git"
  branch="task/pr-aware-disabled"
  wt="$TMP_ROOT/pr-aware-disabled/wt"
  add_pushed_worktree "$repo" "$branch" "$wt"
  head="$(git -C "$wt" rev-parse HEAD)"
  git -C "$origin" update-ref -d "refs/heads/$branch"
  write_repo_config "$repo" '{"cleanup":{"branchDeletion":{"enabled":false,"mode":"enforce"}}}'
  fixture="$TMP_ROOT/pr-aware-disabled/pr.json"
  jq -cn --arg head "$head" '{number:4242,state:"MERGED",mergedAt:"2026-09-04T12:00:00Z",headRefOid:$head,headRefName:"task/pr-aware-disabled",baseRefName:"auto/integration",mergeCommit:null}' > "$fixture"
  gh() { cat "$fixture"; }

  out="$(run_safe_cleanup "$repo" "$wt" "$branch" "HOK-2957" "4242")"
  marker="$repo/.wavemill/incidents/preserved-branches/${branch//\//__}.json"
  assert_eq "10" "$(printf '%s\n' "$out" | awk -F= '$1=="rc"{print $2}')" "PR-aware disabled rc"
  assert_eq "retain_unpublished" "$(printf '%s\n' "$out" | awk -F= '$1=="outcome"{print $2}')" "PR-aware disabled outcome"
  assert_true "PR-aware disabled preserves local branch" branch_exists "$repo" "$branch"
  assert_true "PR-aware disabled preserves worktree" test -d "$wt"
  assert_eq "remote_missing_local_head" "$(jq -r '.verificationReason' "$marker")" "PR-aware disabled verification reason"
}

test_pane_release_flag_independent
test_startup_preflight_flag_independent
test_cleanup_episode_flag_independent
test_branch_deletion_shadow_and_enforce
test_pr_aware_deletion_gate_preserves_contradictory_work

echo "terminal-lifecycle-flags test passed"
