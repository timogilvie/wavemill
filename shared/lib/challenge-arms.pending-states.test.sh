#!/usr/bin/env bash
# wavemill-test-suite: custom
#
# Shared fixture: the bash pending-state helper must stay in lockstep with the
# TypeScript source of truth in shared/lib/challenge-execution-contract.ts,
# and must treat only awaiting_fork and awaiting_expanded_route as pending.
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

# Stub state_mutate so challenge-arms.sh sources cleanly.
state_mutate() {
  local state_path="$1" filter="$2"
  shift 2
  jq "$@" "$filter" "$state_path" > "$state_path.tmp"
  mv "$state_path.tmp" "$state_path"
}
export -f state_mutate

# shellcheck source=../shared/lib/challenge-arms.sh
source "$ARMS_SCRIPT"

# Pull the canonical TS lists via tsx.
TS_LISTS=$(cd "$REPO_DIR_ROOT" && npx tsx -e '
  import { CHALLENGE_ARM_LIFECYCLE_STATES, CHALLENGE_ARM_PENDING_STATES } from "./shared/lib/challenge-execution-contract.ts";
  console.log(JSON.stringify({ lifecycle: CHALLENGE_ARM_LIFECYCLE_STATES, pending: CHALLENGE_ARM_PENDING_STATES }));
')

TS_LIFECYCLE=$(echo "$TS_LISTS" | jq -r '.lifecycle | join("\n")')
TS_PENDING=$(echo "$TS_LISTS" | jq -r '.pending | join("\n")')
BASH_LIFECYCLE=$(printf '%s\n' "${CHALLENGE_ARM_LIFECYCLE_STATES_BASH[@]}")
BASH_PENDING=$(printf '%s\n' "${CHALLENGE_ARM_PENDING_STATES_BASH[@]}")

check_eq "bash lifecycle list matches TS" \
  "$(echo "$TS_LIFECYCLE" | sort | tr '\n' ',')" \
  "$(echo "$BASH_LIFECYCLE" | sort | tr '\n' ',')"

check_eq "bash pending list matches TS" \
  "$(echo "$TS_PENDING" | sort | tr '\n' ',')" \
  "$(echo "$BASH_PENDING" | sort | tr '\n' ',')"

# Pending states.
for state in awaiting_fork awaiting_expanded_route; do
  if challenge_arm_state_is_pending "$state"; then
    pass "pending: $state"
  else
    fail "pending: $state"
  fi
done

# Non-pending lifecycle states.
for state in materializing materialized cancelled exhausted; do
  if challenge_arm_state_is_pending "$state"; then
    fail "not pending: $state"
  else
    pass "not pending: $state"
  fi
done

# Invalid/garbage input is non-pending (and non-valid).
if challenge_arm_state_is_pending "bogus_state"; then
  fail "not pending: bogus_state"
else
  pass "not pending: bogus_state"
fi

if challenge_arm_state_is_valid "bogus_state"; then
  fail "not valid: bogus_state"
else
  pass "not valid: bogus_state"
fi

# Validity across the lifecycle.
for state in awaiting_fork awaiting_expanded_route materializing materialized cancelled exhausted; do
  if challenge_arm_state_is_valid "$state"; then
    pass "valid: $state"
  else
    fail "valid: $state"
  fi
done

echo ""
echo "results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
