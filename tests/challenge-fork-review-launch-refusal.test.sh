#!/usr/bin/env bash
# HOK-2814 / HOK-3006: a review-stage challenger arm with no resolvable
# challenge intent must NOT run an unpinned review. The materialiser
# refuses (rc=2, terminal, no launch), and `selectReviewProvider` retains
# its fallback marker (`requested_model_unavailable`) rather than silently
# returning readyEntries[0] for a challenge arm.
#
# The behaviour is enforced at two layers:
#   1. Shell: challenge_maybe_materialize_deferred_arms treats
#      `materialise_rc == 2` as terminal, marks the arm exhausted with a
#      `missing_challenge_intent` reason, and never calls launch_review.
#   2. TypeScript: selectReviewProvider preserves the requestedModel and
#      records `fallbackReason: 'requested_model_unavailable'` when the
#      requested model is not among ready entries — so downstream folding
#      surfaces `executed_identity_missing` instead of a silent normalisation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR_ROOT/shared/lib/wavemill-monitor.sh"
REVIEW_TS="$REPO_DIR_ROOT/shared/lib/native-agent/review.ts"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

check_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$name"
  else
    echo "    missing: $needle"
    fail "$name"
  fi
}

# ────────────────────────────────────────────────────────────────
# Shell-side: the materialiser + fork-trigger loop refuse a review launch
# when the challenger has no resolvable intent, and mark the arm exhausted
# without ever calling the review launcher.
# ────────────────────────────────────────────────────────────────
echo "=== materialiser refuses review-arm launch when intent cannot be resolved ==="

MATERIALIZE_BLOCK=$(awk '
  /^challenge_materialize_challenger_arm\(\) \{/ { capture=1 }
  capture { print }
  /^}/ && capture { exit }
' "$MONITOR_SCRIPT_FILE")

check_contains "materialiser validates primary intent before launching review" \
  "$MATERIALIZE_BLOCK" 'challenge_intent_files_valid "$primary_feature_dir"'
check_contains "materialiser validates challenger intent before launching review" \
  "$MATERIALIZE_BLOCK" 'challenge_intent_files_valid "$challenger_feature_dir"'
check_contains "materialiser returns terminal rc=2 when intent invalid" \
  "$MATERIALIZE_BLOCK" 'return 2'
check_contains "materialiser logs refusal explaining intent invalidity" \
  "$MATERIALIZE_BLOCK" 'refusing to launch - challenge intent missing/invalid'

FORK_TRIGGER_BLOCK=$(awk '
  /^challenge_maybe_materialize_deferred_arms\(\) \{/ { capture=1 }
  capture { print }
  /^}/ && capture { exit }
' "$MONITOR_SCRIPT_FILE")

check_contains "fork trigger treats rc=2 as terminal (no relaunch)" \
  "$FORK_TRIGGER_BLOCK" 'materialise_rc == 2'
check_contains "fork trigger writes the missing_challenge_intent exhaustion reason" \
  "$FORK_TRIGGER_BLOCK" 'missing_challenge_intent'
check_contains "fork trigger emits the invalid-intent lifecycle event" \
  "$FORK_TRIGGER_BLOCK" 'challenge_arm_invalid_intent'
check_contains "fork trigger sets arm state to exhausted on rc=2" \
  "$FORK_TRIGGER_BLOCK" '"materializing" "exhausted"'

# The refusal precedes the review launch (Step 6 vs Step 8 in the
# materialiser). Extract the block from the intent check to the launch call
# and assert launch_review_phase is only reached AFTER validation passes.
POSITION_BLOCK=$(awk '
  /Step 6: refuse to launch an arm whose intent cannot be attested/ { capture=1 }
  capture { print }
  /launch_review_phase / && capture { exit }
' "$MONITOR_SCRIPT_FILE")

if [[ -n "$POSITION_BLOCK" ]]; then
  # The `return 2` must appear BEFORE launch_review_phase in the extract.
  return_line=$(printf '%s\n' "$POSITION_BLOCK" | grep -n 'return 2' | head -1 | cut -d: -f1)
  launch_line=$(printf '%s\n' "$POSITION_BLOCK" | grep -n 'launch_review_phase ' | head -1 | cut -d: -f1)
  if [[ -n "$return_line" && -n "$launch_line" ]] && (( return_line < launch_line )); then
    pass "return 2 (invalid intent) appears before launch_review_phase"
  else
    fail "return 2 must precede launch_review_phase (return=$return_line launch=$launch_line)"
  fi
else
  fail "could not extract materialiser position block"
fi

# ────────────────────────────────────────────────────────────────
# TypeScript-side: selectReviewProvider must NOT silently normalise a
# challenge-pinned request. When requestedModel is passed and unavailable,
# it must include fallbackReason='requested_model_unavailable' so downstream
# folding surfaces the mismatch as executed_identity_missing.
# ────────────────────────────────────────────────────────────────
echo ""
echo "=== selectReviewProvider preserves the pin marker on fallback ==="

if grep -Fq 'requestedModel?: string' "$REVIEW_TS"; then
  pass "selectReviewProvider accepts a requestedModel argument"
else
  fail "selectReviewProvider dropped the requestedModel parameter"
fi

# Extract the function body and assert the fallback branch records the
# pin marker. The literal string is intentionally checked (a rename must
# fail the test) — it is the exact taxonomy value the folding function
# consumes when detecting unpinned identities.
FN_BLOCK=$(awk '
  /^function selectReviewProvider\(/ { capture=1 }
  capture { print }
  /^}/ && capture { exit }
' "$REVIEW_TS")

check_contains "fallback branch is guarded by 'requestedModel'" "$FN_BLOCK" '...(requestedModel ? { requestedModel, fallbackReason:'
check_contains "fallback marker uses requested_model_unavailable" "$FN_BLOCK" "'requested_model_unavailable'"

# Guard against re-introducing the silent `return readyEntries[0]` for a
# challenge arm — the exact regression HOK-3006 flagged. The function's
# fallback branch must be reachable only through the spread that records
# the fallback marker, so a bare `return { ok: true, entry: readyEntry };`
# without `requestedModel` context would be the regression.
if grep -Fq 'return { ok: true, entry: readyEntry };' "$REVIEW_TS"; then
  fail "selectReviewProvider re-introduced a silent-return branch"
else
  pass "selectReviewProvider has no silent-return branch for challenge arms"
fi

# Cross-check: the ExecutedIdentity builder consumed by folding recognises
# `requested_model_unavailable` as an unpinned marker so the folding step
# lifts it to executed_identity_missing.
CONTRACT_TS="$REPO_DIR_ROOT/shared/lib/challenge-execution-contract.ts"
if grep -Fq "fallbackReason: 'requested_model_unavailable'" "$CONTRACT_TS"; then
  pass "challenge-execution-contract.ts recognises requested_model_unavailable"
else
  fail "challenge-execution-contract.ts no longer references requested_model_unavailable"
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
[[ "$FAIL" -eq 0 ]]
