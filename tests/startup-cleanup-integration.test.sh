#!/usr/bin/env bash
set -euo pipefail

# Exercise the production startup-preflight -> common cleanup call boundary.
# The parent Mill has no monitor-local CLEANED associative array at this point;
# a successful cleanup must still return normally under nounset.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TEST_TMP="$(mktemp -d /tmp/wavemill-startup-cleanup.XXXXXX)"
trap 'rm -rf "$TEST_TMP"' EXIT

export HOME="$TEST_TMP/home"
export REPO_DIR="$TEST_TMP/repo"
export STATE_DIR="$REPO_DIR/.wavemill"
export STATE_FILE="$STATE_DIR/workflow-state.json"
export WORKTREE_ROOT="$TEST_TMP/worktrees"
export SESSION="startup-cleanup-integration"
export BASE_BRANCH="auto/integration"
export MILL_LOG_FILE="$TEST_TMP/mill.log"
export WAVEMILL_RUN_EPOCH="startup-cleanup-test"
export WAVEMILL_CLEANUP_EPISODES_ENABLED=0

mkdir -p "$HOME" "$STATE_DIR" "$WORKTREE_ROOT"
jq -n '{
  session: "startup-cleanup-integration",
  tasks: {
    "HOK-2895": {
      slug: "completed-task",
      branch: "task/completed-task",
      status: "merged",
      phase: "done"
    }
  }
}' > "$STATE_FILE"

# shellcheck source=../shared/lib/wavemill-common.sh
source "$SOURCE_REPO_DIR/shared/lib/wavemill-common.sh"
# shellcheck source=../shared/lib/startup-terminal-preflight.sh
source "$SOURCE_REPO_DIR/shared/lib/startup-terminal-preflight.sh"

# Keep filesystem, git, remote, and tmux effects at their integration seams.
# The state mutation and the production cleanup_completed_task body remain real.
_tmux_task_window_target() { return 0; }
safe_remove_task_worktree_and_branch() {
  WAVEMILL_CLEANUP_OUTCOME="safe_ancestor"
  return 0
}
cleanup_remote_task_branch() { return 0; }
wavemill_cleanup_run() { return 0; }
reconciliation_lease_release() { return 0; }
reset_retry_count() { return 0; }
log() { :; }
log_warn() { :; }

unset CLEANED
startup_terminal_preflight "$SESSION"

if jq -e '.tasks["HOK-2895"] != null' "$STATE_FILE" >/dev/null; then
  echo "FAIL: startup cleanup did not remove the terminal task state" >&2
  exit 1
fi

if declare -p CLEANED >/dev/null 2>&1; then
  echo "FAIL: shared cleanup created the monitor-local CLEANED cache" >&2
  exit 1
fi

echo "PASS: startup cleanup runs without monitor arrays under set -u"

# ── HOK-3068: startup preflight skips settled cleanup episodes ──────────
# A task with a previous terminal classification and settled cleanup episode
# should be re-classified as terminal without PR fetches.
jq -n '{
  session: "startup-cleanup-integration",
  tasks: {
    "HOK-3068": {
      slug: "settled-retained-task",
      branch: "task/settled-retained-task",
      worktree: "'"$WORKTREE_ROOT"'/settled-retained-task",
      status: "merged",
      phase: "done",
      pr: "999",
      rehydration: {
        eligibility: "terminal",
        reason: "pr_merged",
        runEpoch: "previous-epoch"
      },
      lifecycle: {
        workflowOutcome: "merged",
        resourceDisposition: "retained",
        retention: { reason: "unique-local-work" },
        cleanupEpisode: {
          disposition: "retained",
          fingerprint: "abc123",
          attemptCount: 1
        }
      }
    }
  }
}' > "$STATE_FILE"

# Count calls to wavemill_fetch_pr_terminal_evidence — should be 0
_pr_fetch_count=0
wavemill_fetch_pr_terminal_evidence() {
  _pr_fetch_count=$((_pr_fetch_count + 1))
  return 1
}

startup_terminal_preflight "$SESSION"

if [[ "$_pr_fetch_count" -eq 0 ]]; then
  echo "PASS: settled cleanup episode skipped PR fetch on startup"
else
  echo "FAIL: settled cleanup episode fetched PR $_pr_fetch_count time(s)" >&2
  exit 1
fi

# Task may be cleaned up (removed from state) which is correct behavior.
# The key contract: no remote PR check was performed for this settled task.
echo "PASS: settled terminal task classified without remote checks"
