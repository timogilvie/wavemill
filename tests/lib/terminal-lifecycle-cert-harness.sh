#!/usr/bin/env bash
# Certification layer for terminal lifecycle rollout tests.
set -euo pipefail

CERT_HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERT_REPO_DIR="$(cd "$CERT_HARNESS_DIR/../.." && pwd)"

# shellcheck source=incident-fixture-harness.sh
source "$CERT_HARNESS_DIR/incident-fixture-harness.sh"
# shellcheck source=../../shared/lib/wavemill-common.sh
source "$CERT_REPO_DIR/shared/lib/wavemill-common.sh"
# shellcheck source=../../shared/lib/terminal-reconciler.sh
source "$CERT_REPO_DIR/shared/lib/terminal-reconciler.sh"

CERT_RESULTS=()

log() { :; }
log_warn() { printf 'WARN: %s\n' "$*" >&2; }
log_error() { printf 'ERROR: %s\n' "$*" >&2; }
_with_timeout() { shift; "$@"; }

state_mutate() {
  local file="$1" filter="$2" tmp
  shift 2
  tmp="$(mktemp)"
  if jq "$@" "$filter" "$file" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$file"
  else
    rm -f "$tmp"
    return 1
  fi
}

cert_note() {
  printf 'CERT: %s\n' "$*" >&2
}

cert_harness_require_tmux() {
  local real_tmux probe sock
  real_tmux="$(command -v tmux 2>/dev/null || true)"
  [[ -n "$real_tmux" ]] || incident_harness_skip "tmux unavailable"
  probe="$(mktemp -d "${TMPDIR:-/tmp}/wavemill-terminal-lifecycle-tmux-probe.XXXXXX")"
  sock="$probe/tmux.sock"
  if ! "$real_tmux" -S "$sock" new-session -d -s "wavemill-cert-probe-$$" 'sleep 5' >/dev/null 2>&1; then
    rm -rf "$probe"
    incident_harness_skip "could not start isolated tmux server"
  fi
  "$real_tmux" -S "$sock" kill-server >/dev/null 2>&1 || true
  rm -rf "$probe"
}

cert_write_evidence() {
  local name="$1" expected="$2" actual="$3"
  mkdir -p "$SCENARIO_DIR/evidence"
  jq -n --arg scenario "${SCENARIO_NAME:-}" --arg name "$name" --arg expected "$expected" --arg actual "$actual" \
    '{scenario:$scenario,name:$name,expected:$expected,actual:$actual}' > "$SCENARIO_DIR/evidence/$name.json"
}

cert_assert_eq() {
  local expected="$1" actual="$2" name="$3"
  if [[ "$expected" == "$actual" ]]; then
    return 0
  fi
  cert_write_evidence "$name" "$expected" "$actual"
  printf 'FAIL: %s expected %s got %s\n' "$name" "$expected" "$actual" >&2
  return 1
}

cert_config_branch_deletion() {
  local mode="$1"
  jq -n --arg mode "$mode" '{cleanup:{branchDeletion:{enabled:true,mode:$mode}}}' > "$REPO_DIR/.wavemill-config.json"
}

cert_setup_delivery() {
  local name="$1" merge_method="$2" mode="${3:-shadow}"
  incident_scenario_new "$name"
  incident_scenario_start_tmux
  cert_config_branch_deletion "$mode"

  CERT_ISSUE="HOK-2957"
  CERT_SLUG="$name"
  CERT_PR="2957"
  CERT_BRANCH="task/$CERT_SLUG"
  CERT_WT="$WORKTREE_ROOT/$CERT_SLUG"

  git -C "$REPO_DIR" branch "$CERT_BRANCH" auto/integration
  git -C "$REPO_DIR" worktree add "$CERT_WT" "$CERT_BRANCH" >/dev/null 2>&1
  printf '%s\n' "$merge_method" > "$CERT_WT/feature.txt"
  git -C "$CERT_WT" add feature.txt
  git -C "$CERT_WT" commit -m "feature: $merge_method" >/dev/null
  git -C "$CERT_WT" push -u origin "$CERT_BRANCH" >/dev/null 2>&1
  CERT_HEAD="$(git -C "$CERT_WT" rev-parse HEAD)"

  case "$merge_method" in
    merge)
      git -C "$REPO_DIR" merge --no-ff "$CERT_BRANCH" -m "merge $CERT_BRANCH" >/dev/null
      git -C "$REPO_DIR" push origin auto/integration >/dev/null 2>&1
      ;;
    squash)
      local base_tip tree squash_commit
      base_tip="$(git -C "$REPO_DIR" rev-parse auto/integration)"
      tree="$(git -C "$CERT_WT" rev-parse HEAD^{tree})"
      squash_commit="$(git -C "$REPO_DIR" commit-tree "$tree" -p "$base_tip" -m "squash $CERT_BRANCH")"
      git -C "$REPO_DIR" reset --hard "$squash_commit" >/dev/null
      git -C "$REPO_DIR" push origin auto/integration --force >/dev/null 2>&1
      git -C "$ORIGIN_DIR" update-ref -d "refs/heads/$CERT_BRANCH"
      ;;
    rebase)
      local tree replay_commit
      tree="$(git -C "$CERT_WT" rev-parse HEAD^{tree})"
      replay_commit="$(git -C "$REPO_DIR" commit-tree "$tree" -p auto/integration -m "rebase $CERT_BRANCH")"
      git -C "$REPO_DIR" reset --hard "$replay_commit" >/dev/null
      git -C "$REPO_DIR" push origin auto/integration --force >/dev/null 2>&1
      git -C "$ORIGIN_DIR" update-ref -d "refs/heads/$CERT_BRANCH"
      ;;
    changed-after-review)
      git -C "$ORIGIN_DIR" update-ref -d "refs/heads/$CERT_BRANCH"
      printf 'extra\n' > "$CERT_WT/extra.txt"
      git -C "$CERT_WT" add extra.txt
      git -C "$CERT_WT" commit -m "extra after review" >/dev/null
      ;;
    *) printf 'unknown merge method: %s\n' "$merge_method" >&2; return 1 ;;
  esac

  record_pr "$CERT_PR" "MERGED" "2026-09-04T12:00:00Z" "$CERT_HEAD" "$CERT_BRANCH" "auto/integration"
  incident_scenario_add_task_window "$CERT_ISSUE" "$CERT_SLUG"
  incident_seed_task "$CERT_ISSUE" "$(jq -cn \
    --arg slug "$CERT_SLUG" --arg branch "$CERT_BRANCH" --arg wt "$CERT_WT" --arg pr "$CERT_PR" \
    '{slug:$slug,branch:$branch,worktree:$wt,pr:$pr,status:"merged",phase:"review",agent:"codex",lifecycle:{schemaVersion:1,workflowOutcome:"merged",resourceDisposition:"reaping",launchContract:{baseBranch:"auto/integration",mergeMethod:"squash",remoteBranchDeletionPolicy:{allowed:true,mode:"merged-pr-task-branch",source:"cert"}}}}')"
}

cert_run_release_and_cleanup() {
  local release_rc=0 cleanup_rc=0
  BASE_BRANCH="auto/integration"
  API_TIMEOUT=5
  SESSION="$SESSION"
  WORKTREE_ROOT="$WORKTREE_ROOT"
  MILL_LOG_FILE="$MILL_LOG_FILE"
  PATH="$(incident_scenario_path)"
  wavemill_release_terminal_pane "$SESSION" "$CERT_ISSUE" "$CERT_SLUG" "pr_merged" "$CERT_PR" || release_rc=$?
  safe_remove_task_worktree_and_branch "$CERT_WT" "$CERT_BRANCH" "auto/integration" "terminal-lifecycle-cert" "$CERT_ISSUE" "$CERT_PR" || cleanup_rc=$?
  CERT_CLEANUP_OUTCOME="${WAVEMILL_CLEANUP_OUTCOME:-}"
  {
    printf 'release_rc=%s\n' "$release_rc"
    printf 'cleanup_rc=%s\n' "$cleanup_rc"
    printf 'cleanup_outcome=%s\n' "$CERT_CLEANUP_OUTCOME"
  } > "$SCENARIO_DIR/cert-result.env"
}

cert_assert_pane_converged() {
  assert_pane_closed "$CERT_ISSUE" "$CERT_SLUG" "cert pane converged"
}

cert_assert_branch_shadow_or_enforced() {
  local mode="$1"
  case "$mode" in
    shadow)
      cert_assert_eq "shadow_would_delete" "$CERT_CLEANUP_OUTCOME" "cleanup_outcome"
      git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$CERT_BRANCH" || {
        cert_write_evidence "shadow_branch_retained" "present" "absent"
        return 1
      }
      ;;
    enforce)
      if git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$CERT_BRANCH"; then
        cert_write_evidence "enforce_branch_deleted" "absent" "present"
        return 1
      fi
      ;;
  esac
}

cert_assert_authority_recorded() {
  local decision="$REPO_DIR/.wavemill/incidents/cleanup-decisions/${CERT_BRANCH//\//__}.json"
  [[ -f "$decision" ]] || { cert_write_evidence "decision_record" "present" "absent"; return 1; }
  cert_assert_eq "true" "$(jq -r '.safeToDelete' "$decision")" "decision_safe"
  [[ -n "$(jq -r '.authority // empty' "$decision")" ]] || { cert_write_evidence "decision_authority" "non-empty" "empty"; return 1; }
  cert_assert_eq "true" "$(jq -r '.finalCheckPassed' "$decision")" "decision_final_check"
}

cert_assert_no_leaks() {
  cert_assert_pane_converged
  [[ ! -d "$CERT_WT" ]] || { cert_write_evidence "worktree_leak" "absent" "$CERT_WT"; return 1; }
}

cert_record_matrix_result() {
  local scenario="$1" merge_method="$2" passed="$3" iteration_ms="${4:-0}"
  CERT_RESULTS+=("$(jq -cn --arg scenario "$scenario" --arg mergeMethod "$merge_method" --argjson passed "$passed" --argjson iterationMs "$iteration_ms" \
    '{scenario:$scenario,mergeMethod:$mergeMethod,passed:$passed,iterationMs:$iterationMs,observerAgreement:true}')")
}

cert_write_matrix_results() {
  local out="${1:-$CERT_REPO_DIR/.wavemill/terminal-lifecycle-cert/matrix-results.json}"
  mkdir -p "$(dirname "$out")"
  if [[ "${#CERT_RESULTS[@]}" -eq 0 ]]; then
    printf '[]\n' > "$out"
  else
    printf '%s\n' "${CERT_RESULTS[@]}" | jq -s . > "$out"
  fi
}
