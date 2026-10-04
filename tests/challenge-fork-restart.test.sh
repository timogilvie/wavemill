#!/usr/bin/env bash
# HOK-2814: mill restart while an arm is pending, then a correct fork
# afterwards. Covers HOK-2813's restart-recovery invariant end-to-end as a
# single coherent lifecycle assertion rather than the scattered checked-and-
# set transitions in challenge-deferred-arm.test.sh.
#
# Shape:
#   1. Seed a pending arm (awaiting_fork). Nothing is interrupted → recover
#      is a no-op.
#   2. Flip the arm to `materializing` (simulating a mill that died mid-fork).
#      Call challenge_arms_recover_interrupted. The arm returns to
#      awaiting_fork with recoveredFrom=materializing stamped, models and
#      executionIntent preserved verbatim.
#   3. The rehydrate loop only enumerates .tasks[] entries — a pending arm is
#      never rehydrated as a first-class task/slug/branch entry. (HOK-2813.)
#   4. After recovery, the fork trigger can drive the arm through
#      awaiting_fork → materializing → materialized against the same scratch
#      repo shape used by challenge-fork-materialisation.test.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR_ROOT/shared/lib/wavemill-monitor.sh"
ARMS_SCRIPT="$REPO_DIR_ROOT/shared/lib/challenge-arms.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

check_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$name"
  else
    echo "    expected: $expected"
    echo "    actual:   $actual"
    fail "$name"
  fi
}

check_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$name"
  else
    echo "    missing: $needle"
    fail "$name"
  fi
}

state_mutate() {
  local state_path="$1" filter="$2"
  shift 2
  jq "$@" "$filter" "$state_path" > "$state_path.tmp"
  mv "$state_path.tmp" "$state_path"
}
export -f state_mutate

# shellcheck source=../shared/lib/challenge-arms.sh
source "$ARMS_SCRIPT"

log_route_lifecycle() { :; }
log() { :; }
log_warn() { :; }
log_error() { :; }

TMP_ROOT="$(mktemp -d "/tmp/challenge-fork-restart.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

STATE_FILE="$TMP_ROOT/state.json"
export STATE_FILE
printf '%s\n' '{"session":"test","tasks":{"HOK-2813":{"slug":"restart","branch":"task/restart","challenge":true,"challengeRole":"primary","challengePairId":"HOK-2813"}}}' > "$STATE_FILE"

CANONICAL_INTENT='{"schemaVersion":1,"pairId":"HOK-2813","issueId":"HOK-2813","selectedStage":"review","challengeStage":"review","primary":{"pairId":"HOK-2813","side":"primary","challengeStage":"review","expectedStageModel":"claude-sonnet-5","expectedRoute":{}},"challenger":{"pairId":"HOK-2813","side":"challenger","challengeStage":"review","expectedStageModel":"claude-haiku-4-5-20251001","expectedRoute":{}}}'

ARM_JSON="$(challenge_arm_json_build \
  "HOK-2813_c" "restart-c" "task/restart-c" \
  "challenger" "review" \
  "claude-opus-4-7" "claude-sonnet-5" "claude-haiku-4-5-20251001" \
  "claude" "claude" "claude" \
  "light" "medium" "static" \
  "$CANONICAL_INTENT")"

challenge_arms_record_pending "HOK-2813" "$ARM_JSON"

echo "=== restart recovery no-op when nothing is interrupted ==="

challenge_arms_recover_interrupted "HOK-2813"
check_eq "recover on awaiting_fork is a no-op" "awaiting_fork" \
  "$(jq -r '.tasks["HOK-2813"].challengeArms[0].challengeArmState' "$STATE_FILE")"
if jq -e '.tasks["HOK-2813"].challengeArms[0].recoveredFrom' "$STATE_FILE" >/dev/null; then
  fail "no recoveredFrom stamp when there was nothing to recover"
else
  pass "no recoveredFrom stamp when there was nothing to recover"
fi

echo ""
echo "=== restart recovery resets materializing → awaiting_fork ==="

# Simulate a mill that started to materialise but died: the arm is stuck in
# materializing.
challenge_arms_set_state "HOK-2813" "HOK-2813_c" "awaiting_fork" "materializing"
check_eq "arm claim awaiting_fork → materializing" "materializing" \
  "$(jq -r '.tasks["HOK-2813"].challengeArms[0].challengeArmState' "$STATE_FILE")"

# Restart recovery.
challenge_arms_recover_interrupted "HOK-2813"
check_eq "recover_interrupted resets materializing → awaiting_fork" "awaiting_fork" \
  "$(jq -r '.tasks["HOK-2813"].challengeArms[0].challengeArmState' "$STATE_FILE")"
check_eq "recover_interrupted stamps recoveredFrom" "materializing" \
  "$(jq -r '.tasks["HOK-2813"].challengeArms[0].recoveredFrom' "$STATE_FILE")"

# Preserved fields — models and executionIntent must survive the reset.
check_eq "planner model preserved through recovery" "claude-sonnet-5" \
  "$(jq -r '.tasks["HOK-2813"].challengeArms[0].models.planner' "$STATE_FILE")"
check_eq "coder model preserved through recovery" "claude-opus-4-7" \
  "$(jq -r '.tasks["HOK-2813"].challengeArms[0].models.coder' "$STATE_FILE")"
check_eq "reviewer model preserved through recovery" "claude-haiku-4-5-20251001" \
  "$(jq -r '.tasks["HOK-2813"].challengeArms[0].models.reviewer' "$STATE_FILE")"
check_eq "executionIntent pairId preserved" "HOK-2813" \
  "$(jq -r '.tasks["HOK-2813"].challengeArms[0].executionIntent.pairId' "$STATE_FILE")"
check_eq "executionIntent selectedStage preserved" "review" \
  "$(jq -r '.tasks["HOK-2813"].challengeArms[0].executionIntent.selectedStage' "$STATE_FILE")"

# Idempotent: calling recover again on an already-recovered arm is a no-op.
challenge_arms_recover_interrupted "HOK-2813"
check_eq "recover_interrupted is idempotent" "awaiting_fork" \
  "$(jq -r '.tasks["HOK-2813"].challengeArms[0].challengeArmState' "$STATE_FILE")"

echo ""
echo "=== rehydration only enumerates .tasks (arms never become slugs) ==="

# The rehydrate loop in the monitor iterates .tasks[]. A nested pending arm
# must never appear as a first-class rehydrated entry with its own slug/
# branch, otherwise the mill would try to launch a monitor for it and
# double-book the primary's pair (HOK-2813).
REHYDRATE_ROWS=$(jq -r '.tasks | to_entries[]
  | select(((.value.lifecycle.workflowOutcome // "active") == "active") or
      ((.value.lifecycle.resourceDisposition // "") != "reaped"))
  | "\(.key)|\(.value.slug // "")|\(.value.branch // "")|\(.value.pr // "")"' "$STATE_FILE")

check_eq "exactly one rehydration row" "1" "$(printf '%s\n' "$REHYDRATE_ROWS" | grep -c 'HOK-2813')"
check_contains "rehydration row is the primary, not the arm" "$REHYDRATE_ROWS" "HOK-2813|restart|task/restart"

if printf '%s\n' "$REHYDRATE_ROWS" | grep -q '_c|'; then
  fail "pending arm rehydrated as a task (would double-book the pair)"
else
  pass "pending arm does NOT rehydrate as a task"
fi

# Source-side guard: the monitor's rehydrate block wires
# challenge_arms_recover_interrupted directly.
REHYDRATE_BLOCK=$(sed -n '/Rehydrate tracked tasks from persisted state/,/^fi$/p' "$MONITOR_SCRIPT_FILE")
check_contains "rehydrate block calls challenge_arms_recover_interrupted" \
  "$REHYDRATE_BLOCK" 'challenge_arms_recover_interrupted "$ISSUE"'

echo ""
echo "=== fork trigger can drive the recovered arm to materialized ==="

# Build a scratch git repo mirroring the challenge-fork-materialisation test
# so we can end-to-end the transition awaiting_fork → materializing →
# materialized after recovery. We drive the on-disk steps of the materialiser
# directly (it is too large to source in isolation) and then flip the arm
# state to reflect a successful run.
SCRATCH_REPO="$TMP_ROOT/repo"
WORKTREE_ROOT="$TMP_ROOT/worktrees"
mkdir -p "$SCRATCH_REPO" "$WORKTREE_ROOT"
git -C "$SCRATCH_REPO" init -q -b main
git -C "$SCRATCH_REPO" config user.email test@example.com
git -C "$SCRATCH_REPO" config user.name test
echo initial > "$SCRATCH_REPO/README.md"
git -C "$SCRATCH_REPO" add README.md
git -C "$SCRATCH_REPO" commit -q -m 'initial'
git -C "$SCRATCH_REPO" checkout -q -b task/restart
echo more >> "$SCRATCH_REPO/README.md"
git -C "$SCRATCH_REPO" add README.md
git -C "$SCRATCH_REPO" commit -q -m 'primary coding work'
FORK_COMMIT="$(git -C "$SCRATCH_REPO" rev-parse HEAD)"

# Fresh claim — recovery already flipped the arm back to awaiting_fork.
if challenge_arms_set_state "HOK-2813" "HOK-2813_c" "awaiting_fork" "materializing"; then
  pass "post-recovery claim awaiting_fork → materializing"
else
  fail "post-recovery claim awaiting_fork → materializing"
fi

# Simulate a successful materialisation (real function creates worktree +
# seeds feature dir + stamps intent; we replay the state-side stamp here).
CHALLENGER_WT_DIR="$WORKTREE_ROOT/restart-c"
git -C "$SCRATCH_REPO" worktree add -b task/restart-c "$CHALLENGER_WT_DIR" "$FORK_COMMIT" >/dev/null 2>&1

challenge_arms_set_state "HOK-2813" "HOK-2813_c" "materializing" "materialized" \
  "$(jq -cn --arg fc "$FORK_COMMIT" '{materializedAt: (now | todate), forkCommit: $fc}')"
check_eq "arm state materialized" "materialized" \
  "$(jq -r '.tasks["HOK-2813"].challengeArms[0].challengeArmState' "$STATE_FILE")"
check_eq "arm forkCommit stamped" "$FORK_COMMIT" \
  "$(jq -r '.tasks["HOK-2813"].challengeArms[0].forkCommit' "$STATE_FILE")"

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
[[ "$FAIL" -eq 0 ]]
