#!/usr/bin/env bash
# HOK-3184 ledger shadow CLI end-to-end: exercises step-upsert, retry-attempt,
# retry-exhaust, waiting-on-set, evidence-insert, and check-consistency against
# a tmpdir SQLite DB.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

LEDGER_DIR="$TEST_TMP/mill"
mkdir -p "$LEDGER_DIR/.wavemill"
STATE_DIR="$TEST_TMP/state"
mkdir -p "$STATE_DIR"

run_ledger() {
  WAVEMILL_MILLED_REPO_DIR="$LEDGER_DIR" \
    npx tsx "$REPO_DIR/tools/ledger.ts" --strict --json "$@"
}

ISSUE="HOK-TESTSHADOW"

# step-upsert — review
STEP_JSON="$(run_ledger step-upsert --issue "$ISSUE" --kind review --head abc --base def --prompt sha256:zz || true)"
STEP_ID="$(echo "$STEP_JSON" | jq -r '.id')"
if [[ -n "$STEP_ID" && "$STEP_ID" != "null" ]]; then
  pass "step-upsert returns a step id"
else
  fail "step-upsert returns a step id (got: $STEP_JSON)"
fi

IS_NEW="$(echo "$STEP_JSON" | jq -r '.isNew')"
if [[ "$IS_NEW" == "true" ]]; then
  pass "first step-upsert marks row isNew=true"
else
  fail "first step-upsert marks row isNew=true (got $IS_NEW)"
fi

# idempotent on second call
STEP_JSON2="$(run_ledger step-upsert --issue "$ISSUE" --kind review --head abc --base def --prompt sha256:zz)"
STEP_ID2="$(echo "$STEP_JSON2" | jq -r '.id')"
IS_NEW2="$(echo "$STEP_JSON2" | jq -r '.isNew')"
if [[ "$STEP_ID" == "$STEP_ID2" && "$IS_NEW2" == "false" ]]; then
  pass "second step-upsert is idempotent"
else
  fail "second step-upsert is idempotent (ids: $STEP_ID vs $STEP_ID2)"
fi

# retry-attempt increments
ATTEMPT_JSON="$(run_ledger retry-attempt --id "$STEP_ID")"
ATTEMPT="$(echo "$ATTEMPT_JSON" | jq -r '.attempt')"
if [[ "$ATTEMPT" == "1" ]]; then
  pass "retry-attempt increments to 1"
else
  fail "retry-attempt increments to 1 (got $ATTEMPT)"
fi

# waiting-on-set writes a mirror row
run_ledger waiting-on-set --id "$STEP_ID" --trigger head --condition '{"head":"abc","expiresOn":["head"]}' >/dev/null
WAITING_JSON="$(run_ledger inspect "$STEP_ID")"
WAIT_COUNT="$(echo "$WAITING_JSON" | jq -r '.waiting_on | length')"
if [[ "$WAIT_COUNT" == "1" ]]; then
  pass "waiting-on-set writes mirror row"
else
  fail "waiting-on-set writes mirror row (count=$WAIT_COUNT)"
fi

# evidence-insert records agent evidence
EV_JSON="$(run_ledger evidence-insert --issue "$ISSUE" --event Stop --detail idle)"
EV_SKIPPED="$(echo "$EV_JSON" | jq -r '.skipped // empty')"
if [[ -z "$EV_SKIPPED" ]]; then
  pass "evidence-insert writes evidence row"
else
  fail "evidence-insert writes evidence row (got: $EV_JSON)"
fi

# waiting-on-clear removes it
run_ledger waiting-on-clear --id "$STEP_ID" --trigger head >/dev/null
WAIT_COUNT2="$(run_ledger inspect "$STEP_ID" | jq -r '.waiting_on | length')"
if [[ "$WAIT_COUNT2" == "0" ]]; then
  pass "waiting-on-clear removes the row"
else
  fail "waiting-on-clear removes the row (count=$WAIT_COUNT2)"
fi

# retry-exhaust settles with aborted:exhausted:<bucket>:<reason>
run_ledger retry-exhaust --id "$STEP_ID" --bucket review-infra-recovery --reason ci-red >/dev/null
SETTLED="$(run_ledger inspect "$STEP_ID" | jq -r '.task.settled_as')"
REASON="$(run_ledger inspect "$STEP_ID" | jq -r '.task.settled_reason')"
if [[ "$SETTLED" == "aborted" && "$REASON" == "exhausted:review-infra-recovery:ci-red" ]]; then
  pass "retry-exhaust settles with structured reason"
else
  fail "retry-exhaust settles with structured reason (settled=$SETTLED reason=$REASON)"
fi

# check-consistency on a clean state dir returns zero disagreements
# (reports back as "shadow: suppressed" if the ledger binding is unavailable).
CONSISTENCY_JSON="$(run_ledger check-consistency --issue "$ISSUE" --state-dir "$STATE_DIR" || true)"
DISAGREEMENT_COUNT="$(echo "$CONSISTENCY_JSON" | jq -r '.disagreements | length' 2>/dev/null || echo "")"
if [[ "$DISAGREEMENT_COUNT" == "0" ]]; then
  pass "check-consistency on empty state dir yields zero disagreements"
elif [[ "$(echo "$CONSISTENCY_JSON" | jq -r '.shadow // empty' 2>/dev/null)" == "suppressed" ]]; then
  pass "check-consistency suppressed on missing binding (expected on older Node)"
else
  fail "check-consistency on empty state dir yields zero disagreements (got: $CONSISTENCY_JSON)"
fi

# check-consistency on a dirty state dir detects the retry sentinel without a step
mkdir -p "$STATE_DIR/dirty"
printf '2\n' > "$STATE_DIR/dirty/.retry-no-step-count"
DIRTY_JSON="$(run_ledger check-consistency --issue "$ISSUE-dirty" --state-dir "$STATE_DIR/dirty" || true)"
DIRTY_COUNT="$(echo "$DIRTY_JSON" | jq -r '.disagreements | length' 2>/dev/null || echo "")"
if [[ "$DIRTY_COUNT" -ge 1 ]] 2>/dev/null; then
  pass "check-consistency detects a sentinel without its mirror row"
elif [[ "$(echo "$DIRTY_JSON" | jq -r '.shadow // empty' 2>/dev/null)" == "suppressed" ]]; then
  pass "check-consistency suppressed on missing binding (dirty path)"
else
  fail "check-consistency detects a sentinel without its mirror row (got: $DIRTY_JSON)"
fi

# Non-strict path swallows a bogus command: the CLI prints {shadow: suppressed}
# and exits 0 instead of propagating the error.
if WAVEMILL_MILLED_REPO_DIR="$LEDGER_DIR" npx tsx "$REPO_DIR/tools/ledger.ts" step-upsert --issue "$ISSUE" --kind invalid --head abc --json 2>/dev/null | grep -q 'suppressed'; then
  pass "shadow CLI swallows errors by default"
else
  fail "shadow CLI swallows errors by default"
fi

echo
echo "Passed: $PASS, Failed: $FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
exit 0
