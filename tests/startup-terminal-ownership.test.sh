#!/usr/bin/env bash
set -euo pipefail

# HOK-3068: the startup terminal preflight is the single owner of terminal
# reconciliation/cleanup per run epoch. This test exercises two invariants:
#   1. startup_preflight_owns_terminal_row() reports ownership only for rows the
#      preflight stamped as terminal in the current epoch, so the stale-task
#      pass skips them (no duplicate remote PR/Git/Linear work).
#   2. When the persisted cleanup-episode fingerprint is unchanged (should_attempt
#      == "skip"), the preflight does not reconcile or clean up the row again —
#      the retained resource is preserved and left for Backstage.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TEST_TMP="$(mktemp -d /tmp/wavemill-startup-ownership.XXXXXX)"
trap 'rm -rf "$TEST_TMP"' EXIT

export HOME="$TEST_TMP/home"
export REPO_DIR="$TEST_TMP/repo"
export STATE_DIR="$REPO_DIR/.wavemill"
export STATE_FILE="$STATE_DIR/workflow-state.json"
export WORKTREE_ROOT="$TEST_TMP/worktrees"
export SESSION="startup-terminal-ownership"
export BASE_BRANCH="auto/integration"
export WAVEMILL_RUN_EPOCH="epoch-current"
export WAVEMILL_CLEANUP_EPISODES_ENABLED=0
export WAVEMILL_STARTUP_TERMINAL_PREFLIGHT=1

mkdir -p "$HOME" "$STATE_DIR" "$WORKTREE_ROOT"

# shellcheck source=../shared/lib/wavemill-common.sh
source "$SOURCE_REPO_DIR/shared/lib/wavemill-common.sh"
# shellcheck source=../shared/lib/startup-terminal-preflight.sh
source "$SOURCE_REPO_DIR/shared/lib/startup-terminal-preflight.sh"

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

# ── 1. ownership helper ────────────────────────────────────────────────────
jq -n '{
  tasks: {
    "HOK-3300": { slug: "term", rehydration: { eligibility: "terminal", runEpoch: "epoch-current" } },
    "HOK-3301": { slug: "term-old", rehydration: { eligibility: "terminal", runEpoch: "epoch-previous" } },
    "HOK-3302": { slug: "active", rehydration: { eligibility: "eligible", runEpoch: "epoch-current" } }
  }
}' > "$STATE_FILE"

if startup_preflight_owns_terminal_row "HOK-3300"; then
  pass "owns terminal row stamped terminal in the current epoch"
else
  fail "should own terminal row stamped in current epoch"
fi

if startup_preflight_owns_terminal_row "HOK-3301"; then
  fail "must not own terminal row from a previous epoch"
else
  pass "does not own terminal row from a previous epoch"
fi

if startup_preflight_owns_terminal_row "HOK-3302"; then
  fail "must not own a non-terminal (eligible) row"
else
  pass "does not own a non-terminal row"
fi

# ── 2. unchanged fingerprint skips reconcile + cleanup ─────────────────────
jq -n '{
  session: "startup-terminal-ownership",
  tasks: {
    "HOK-3400": {
      slug: "retained-merged",
      branch: "task/retained-merged",
      status: "merged",
      phase: "done"
    }
  }
}' > "$STATE_FILE"

RECONCILE_CALLS=0
CLEANUP_CALLS=0
WAVEMILL_TERMINAL_RECONCILER_LOADED=1
# Force the fingerprint short-circuit.
cleanup_episode_should_attempt() { printf 'skip\n'; }
wavemill_reconcile_terminal() { RECONCILE_CALLS=$((RECONCILE_CALLS + 1)); return 0; }
startup_preflight_reconcile_terminal_issue() { RECONCILE_CALLS=$((RECONCILE_CALLS + 1)); return 0; }
cleanup_completed_task() { CLEANUP_CALLS=$((CLEANUP_CALLS + 1)); return 0; }
log() { :; }
log_warn() { :; }

startup_terminal_preflight "$SESSION"

if (( RECONCILE_CALLS == 0 && CLEANUP_CALLS == 0 )); then
  pass "unchanged retained fingerprint skips reconcile and cleanup"
else
  fail "retained fingerprint still triggered reconcile/cleanup (reconcile=$RECONCILE_CALLS cleanup=$CLEANUP_CALLS)"
fi

if jq -e '.tasks["HOK-3400"] != null' "$STATE_FILE" >/dev/null; then
  pass "retained terminal task state preserved for Backstage"
else
  fail "retained terminal task state was removed"
fi

eligibility="$(jq -r '.tasks["HOK-3400"].rehydration.eligibility // empty' "$STATE_FILE")"
if [[ "$eligibility" == "terminal" ]]; then
  pass "retained terminal row stamped terminal so the stale-task pass skips it"
else
  fail "retained terminal row not stamped terminal (got '$eligibility')"
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
(( FAIL == 0 ))
