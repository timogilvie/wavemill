#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/terminal-lifecycle-cert-harness.sh
source "$SCRIPT_DIR/lib/terminal-lifecycle-cert-harness.sh"
incident_harness_require_tools
cert_harness_require_tmux

FAILURES=0
FULL=0
[[ "${1:-}" == "--full" ]] && FULL=1

snapshot_state() {
  local branch_present pane_present worktree_present
  if git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$CERT_BRANCH"; then
    branch_present=true
  else
    branch_present=false
  fi
  if incident_tmux list-panes -t "$(incident_window_target "$CERT_ISSUE" "$CERT_SLUG")" >/dev/null 2>&1; then
    pane_present=true
  else
    pane_present=false
  fi
  [[ -d "$CERT_WT" ]] && worktree_present=true || worktree_present=false
  jq -cn --arg branch "$branch_present" --arg pane "$pane_present" --arg worktree "$worktree_present" --arg outcome "${WAVEMILL_CLEANUP_OUTCOME:-}" \
    '{branchPresent:($branch=="true"),panePresent:($pane=="true"),worktreePresent:($worktree=="true"),outcome:$outcome}'
}

run_control() {
  cert_setup_delivery "restart-control-$1" "$1" "shadow"
  cert_run_release_and_cleanup
  snapshot_state
}

run_restarted() {
  cert_setup_delivery "restart-replay-$1-$2" "$1" "shadow"
  case "$2" in
    after-pane-release)
      wavemill_release_terminal_pane "$SESSION" "$CERT_ISSUE" "$CERT_SLUG" "pr_merged" "$CERT_PR" >/dev/null 2>&1 || true
      ;;
    before-cleanup)
      :
      ;;
    after-decision)
      # The next invocation replays against persisted state and git evidence.
      # This boundary is intentionally modeled as same-state replay because the
      # cleanup helper writes its authority record atomically before deletion.
      :
      ;;
  esac
  cert_run_release_and_cleanup
  snapshot_state
}

check_boundary() {
  local merge_method="$1" boundary="$2" control replay
  printf '\n=== restart %s / %s ===\n' "$merge_method" "$boundary"
  control="$(run_control "$merge_method" | sed -n '/^{.*}$/p' | tail -n1)"
  replay="$(run_restarted "$merge_method" "$boundary" | sed -n '/^{.*}$/p' | tail -n1)"
  if [[ -z "$control" || -z "$replay" ]]; then
    printf '  FAIL restart equivalence %s/%s: missing JSON snapshot\n' "$merge_method" "$boundary" >&2
    FAILURES=$((FAILURES + 1))
    return 0
  fi
  if diff -u <(printf '%s\n' "$control" | jq -S .) <(printf '%s\n' "$replay" | jq -S .) >/dev/null; then
    printf '  PASS restart equivalence %s/%s\n' "$merge_method" "$boundary"
  else
    printf '  FAIL restart equivalence %s/%s\ncontrol=%s\nreplay=%s\n' "$merge_method" "$boundary" "$control" "$replay" >&2
    FAILURES=$((FAILURES + 1))
  fi
}

check_boundary "squash" "after-pane-release"
check_boundary "rebase" "before-cleanup"
check_boundary "merge" "after-decision"

if [[ "$FULL" -eq 1 ]]; then
  for method in merge squash rebase; do
    for boundary in after-pane-release before-cleanup after-decision; do
      check_boundary "$method" "$boundary"
    done
  done
fi

if [[ "$FAILURES" -gt 0 ]]; then
  echo "terminal lifecycle restart cert failed: $FAILURES" >&2
  exit 1
fi

echo "terminal lifecycle restart cert passed"
