#!/usr/bin/env bash
# HOK-2814: primary fails before the fork → challenge collapses to a single
# run with `pre_fork_primary_failure` recorded. Also verifies the taxonomy
# for pre_fork_primary_failure (NO_COMPARISON_REASONS, eval-schema) so a
# rename fails the test rather than silently drifting.
#
# The HOK-2970 addendum (invalid arm aborted → pair auto-resolves to
# `invalid_challenge`) is already covered end-to-end by
# tests/reviewer-stage-hok2939-shaped.test.sh and
# tests/reviewer-stage-hok2954-shaped.test.sh through the real resolver.
# Repeating those scenarios here would be a byte-identical duplicate, so this
# file scopes to the pre-fork side.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR_ROOT/shared/lib/wavemill-monitor.sh"
ARMS_SCRIPT="$REPO_DIR_ROOT/shared/lib/challenge-arms.sh"
COMPARISON_TS="$REPO_DIR_ROOT/shared/lib/challenge-comparison.ts"
EVAL_SCHEMA="$REPO_DIR_ROOT/shared/lib/eval-schema.json"

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

TMP_ROOT="$(mktemp -d "/tmp/challenge-fork-pre-fork-collapse.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

STATE_FILE="$TMP_ROOT/state.json"
export STATE_FILE
printf '%s\n' '{"session":"test","tasks":{"HOK-9001":{"slug":"prefork","branch":"task/prefork","challenge":true,"challengeRole":"primary","challengePairId":"HOK-9001","challengeStage":"review","challengeVariedModel":"claude-haiku-4-5-20251001","challengeModel":"claude-haiku-4-5-20251001"}}}' > "$STATE_FILE"

CANONICAL_INTENT='{"schemaVersion":1,"pairId":"HOK-9001","issueId":"HOK-9001","selectedStage":"review","challengeStage":"review","primary":{"pairId":"HOK-9001","side":"primary","challengeStage":"review","expectedStageModel":"claude-sonnet-5","expectedRoute":{}},"challenger":{"pairId":"HOK-9001","side":"challenger","challengeStage":"review","expectedStageModel":"claude-haiku-4-5-20251001","expectedRoute":{}}}'

ARM_JSON="$(challenge_arm_json_build \
  "HOK-9001_c" "prefork-c" "task/prefork-c" \
  "challenger" "review" \
  "claude-opus-4-7" "claude-sonnet-5" "claude-haiku-4-5-20251001" \
  "claude" "claude" "claude" \
  "light" "medium" "static" \
  "$CANONICAL_INTENT")"

challenge_arms_record_pending "HOK-9001" "$ARM_JSON"

echo "=== pre-fork primary failure collapses the pair ==="

# Sanity: before collapse, .challenge is true and the pending arm is present.
check_eq "before collapse: .challenge is true" "true" "$(jq -r '.tasks["HOK-9001"].challenge' "$STATE_FILE")"
check_eq "before collapse: exactly one pending arm" "1" \
  "$(challenge_arms_list_pending "HOK-9001" | jq -r 'length')"

# Simulate the primary's coding phase terminally failing — cleanup_aborted_
# challenge_arm in the real monitor drives challenge_arms_cancel_pending with
# the typed reason and the free-text cause.
challenge_arms_cancel_pending "HOK-9001" "pre_fork_primary_failure" "quarantined coding: agent exited"

# After collapse:
check_eq "arm state after collapse" "cancelled" \
  "$(jq -r '.tasks["HOK-9001"].challengeArms[0].challengeArmState' "$STATE_FILE")"
check_eq "typed cancelReason on arm" "pre_fork_primary_failure" \
  "$(jq -r '.tasks["HOK-9001"].challengeArms[0].cancelReason' "$STATE_FILE")"
check_eq "free-text cancelDetail preserved" "quarantined coding: agent exited" \
  "$(jq -r '.tasks["HOK-9001"].challengeArms[0].cancelDetail' "$STATE_FILE")"
check_eq "primary challengeCollapseReason" "pre_fork_primary_failure" \
  "$(jq -r '.tasks["HOK-9001"].challengeCollapseReason' "$STATE_FILE")"
check_eq "primary .challenge cleared" "false" "$(jq -r '.tasks["HOK-9001"].challenge' "$STATE_FILE")"

# Every challenge-facing meta field is deleted from the primary — otherwise
# a lingering challengePairId would still form a phantom pair for the eval
# ledger to trip over.
for field in challengeRole challengePairId challengeStage challengeVariedModel challengeModel; do
  if jq -e --arg f "$field" '.tasks["HOK-9001"] | has($f)' "$STATE_FILE" | grep -q true; then
    fail "collapse leaves $field on primary"
  else
    pass "collapse deletes $field on primary"
  fi
done

# No challenger task is ever created.
if jq -e '.tasks["HOK-9001_c"]' "$STATE_FILE" >/dev/null 2>&1; then
  fail "collapse must not create a challenger task entry"
else
  pass "collapse does not create a challenger task entry"
fi

# The cancelled arm is retained on the primary so the collapse stays
# inspectable.
check_eq "cancelled arm is retained for audit" "1" \
  "$(jq -r '.tasks["HOK-9001"].challengeArms | length' "$STATE_FILE")"

echo ""
echo "=== source-level wiring: cleanup_aborted_challenge_arm collapses via typed reason ==="

CLEANUP_BLOCK=$(awk '
  /^cleanup_aborted_challenge_arm\(\) \{/ { capture=1 }
  capture { print }
  /^}/ && capture { exit }
' "$MONITOR_SCRIPT_FILE")

check_contains "cleanup helper calls challenge_arms_cancel_pending with typed reason" \
  "$CLEANUP_BLOCK" 'challenge_arms_cancel_pending "$issue" "pre_fork_primary_failure" "$reason"'
check_contains "cleanup helper counts pending arms before cancel" \
  "$CLEANUP_BLOCK" 'challengeArms // []) | map(select(.challengeArmState == "awaiting_fork"))'

echo ""
echo "=== taxonomy: pre_fork_primary_failure is a registered no-comparison reason ==="

REASONS_BLOCK=$(awk '/NO_COMPARISON_REASONS = \[/,/^\] as const;/' "$COMPARISON_TS")
check_contains "NO_COMPARISON_REASONS carries pre_fork_primary_failure" \
  "$REASONS_BLOCK" "'pre_fork_primary_failure'"

if grep -qF '"pre_fork_primary_failure"' "$EVAL_SCHEMA"; then
  pass "eval-schema.json declares pre_fork_primary_failure"
else
  fail "eval-schema.json missing pre_fork_primary_failure"
fi

echo ""
echo "=== auto-resolve of invalid_challenge shape covered elsewhere ==="

# The HOK-2970 addendum shape (invalid arm aborted, pair auto-resolves to
# comparisonOutcome=invalid_challenge with no winner) is exercised end-to-
# end against the real resolveUnresolvablePair() in the sibling tests below.
# We assert those files still exist so a rename or deletion breaks THIS
# regression suite — not just theirs.
for sibling in \
  reviewer-stage-hok2939-shaped.test.sh \
  reviewer-stage-hok2954-shaped.test.sh; do
  if [[ -f "$SCRIPT_DIR/$sibling" ]]; then
    pass "sibling coverage present: $sibling"
  else
    fail "sibling coverage MISSING: $sibling — invalid-arm auto-resolve is unreferenced"
  fi
done

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
[[ "$FAIL" -eq 0 ]]
