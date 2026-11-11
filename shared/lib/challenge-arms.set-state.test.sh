#!/usr/bin/env bash
# wavemill-test-suite: custom
#
# HOK-3451: challenge_arms_set_state validates states and returns non-zero on
# invalid new_state or a lost compare-and-set race.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
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

# Stub state_mutate BEFORE sourcing challenge-arms.sh. Mirrors the real helper:
# jq errors must not overwrite the state file.
state_mutate() {
  local state_path="$1" filter="$2"
  shift 2
  jq "$@" "$filter" "$state_path" > "$state_path.tmp" || { rm -f "$state_path.tmp"; return 1; }
  mv "$state_path.tmp" "$state_path"
}
export -f state_mutate

# shellcheck source=../shared/lib/challenge-arms.sh
source "$ARMS_SCRIPT"

TMP_ROOT="$(mktemp -d "/tmp/challenge-arms-set-state.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

STATE_FILE="$TMP_ROOT/state.json"
export STATE_FILE
printf '%s\n' '{"session":"test","tasks":{"HOK-3451":{"slug":"setstate","challenge":true,"challengeRole":"primary","challengePairId":"HOK-3451","challengeStage":"review"}}}' > "$STATE_FILE"

ARM_JSON="$(challenge_arm_json_build \
  "HOK-3451_c" "setstate-c" "task/setstate-c" \
  "challenger" "review" \
  "claude-opus-4-7" "claude-sonnet-5" "claude-haiku-4-5-20251001" \
  "claude" "claude" "claude" \
  "light" "medium" "static")"
challenge_arms_record_pending "HOK-3451" "$ARM_JSON"

echo "=== invalid new_state is rejected ==="
if challenge_arms_set_state "HOK-3451" "HOK-3451_c" "awaiting_fork" "not_a_state"; then
  fail "invalid new_state returns non-zero"
else
  pass "invalid new_state returns non-zero"
fi
check_eq "invalid new_state leaves arm unchanged" "awaiting_fork" \
  "$(jq -r '.tasks["HOK-3451"].challengeArms[0].challengeArmState' "$STATE_FILE")"

echo "=== mismatched expected state is a lost race ==="
if challenge_arms_set_state "HOK-3451" "HOK-3451_c" "materializing" "materialized"; then
  fail "mismatched expected returns non-zero"
else
  pass "mismatched expected returns non-zero"
fi
check_eq "lost race leaves arm unchanged" "awaiting_fork" \
  "$(jq -r '.tasks["HOK-3451"].challengeArms[0].challengeArmState' "$STATE_FILE")"

echo "=== happy path transitions state ==="
if challenge_arms_set_state "HOK-3451" "HOK-3451_c" "awaiting_fork" "materializing"; then
  pass "happy path returns zero"
else
  fail "happy path returns zero"
fi
check_eq "happy path updates arm" "materializing" \
  "$(jq -r '.tasks["HOK-3451"].challengeArms[0].challengeArmState' "$STATE_FILE")"

echo "=== serialized second caller with stale expected loses ==="
if challenge_arms_set_state "HOK-3451" "HOK-3451_c" "awaiting_fork" "materialized"; then
  fail "stale expected returns non-zero"
else
  pass "stale expected returns non-zero"
fi
check_eq "stale expected leaves arm at materializing" "materializing" \
  "$(jq -r '.tasks["HOK-3451"].challengeArms[0].challengeArmState' "$STATE_FILE")"

echo "=== extra_json is merged on success ==="
if challenge_arms_set_state "HOK-3451" "HOK-3451_c" "materializing" "materialized" '{"forkCommit":"abc123"}'; then
  pass "transition with extra returns zero"
else
  fail "transition with extra returns zero"
fi
check_eq "extra json merged" "abc123" \
  "$(jq -r '.tasks["HOK-3451"].challengeArms[0].forkCommit' "$STATE_FILE")"

echo ""
echo "results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
