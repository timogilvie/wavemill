#!/usr/bin/env bash
# wavemill-test-suite: none (ran in no suite before HOK-3466; run it or delete it)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

source "$REPO_DIR/shared/lib/wavemill-common.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

echo "=== wavemill usage tips ==="

if [[ "${#WAVEMILL_USAGE_TIPS[@]}" -eq 10 ]]; then
  pass "defines exactly 10 usage tips"
else
  fail "expected 10 usage tips, found ${#WAVEMILL_USAGE_TIPS[@]}"
fi

tips_valid=1
for tip in "${WAVEMILL_USAGE_TIPS[@]}"; do
  if [[ -z "$tip" || "$tip" == *$'\n'* || "${#tip}" -gt 70 ]]; then
    tips_valid=0
    break
  fi
done
if [[ "$tips_valid" -eq 1 ]]; then
  pass "every tip is single-line, non-empty, and within 70 chars"
else
  fail "at least one tip is empty, multi-line, or too long"
fi

tip_zero="$(WAVEMILL_TIP_INDEX=0 wavemill_pick_usage_tip)"
if [[ "$tip_zero" == "${WAVEMILL_USAGE_TIPS[0]}" ]]; then
  pass "index 0 selects the first tip"
else
  fail "index 0 did not select the first tip"
fi

tip_nine="$(WAVEMILL_TIP_INDEX=9 wavemill_pick_usage_tip)"
if [[ "$tip_nine" == "${WAVEMILL_USAGE_TIPS[9]}" ]]; then
  pass "index 9 selects the last tip"
else
  fail "index 9 did not select the last tip"
fi

tip_wrap="$(WAVEMILL_TIP_INDEX=10 wavemill_pick_usage_tip)"
if [[ "$tip_wrap" == "${WAVEMILL_USAGE_TIPS[0]}" ]]; then
  pass "out-of-range deterministic index wraps with modulo"
else
  fail "out-of-range deterministic index did not wrap with modulo"
fi

invalid_ok=1
for override in foo -1 ''; do
  tmp_err="$(mktemp)"
  tip_output="$(
    WAVEMILL_TIP_INDEX="$override" wavemill_pick_usage_tip 2>"$tmp_err"
  )"
  if [[ -s "$tmp_err" || -z "$tip_output" ]]; then
    invalid_ok=0
  fi
  rm -f "$tmp_err"
done
if [[ "$invalid_ok" -eq 1 ]]; then
  pass "invalid or empty overrides fall back without stderr noise"
else
  fail "invalid or empty overrides did not fall back cleanly"
fi

random_membership_ok=1
declare -A seen=()
for _ in $(seq 1 50); do
  tip_output="$(wavemill_pick_usage_tip)"
  matched=0
  for tip in "${WAVEMILL_USAGE_TIPS[@]}"; do
    if [[ "$tip_output" == "$tip" ]]; then
      matched=1
      seen["$tip_output"]=1
      break
    fi
  done
  if [[ "$matched" -ne 1 ]]; then
    random_membership_ok=0
    break
  fi
done
if [[ "$random_membership_ok" -eq 1 ]]; then
  pass "random mode only returns known tips"
else
  fail "random mode returned an unknown tip"
fi

if [[ "${#seen[@]}" -ge 2 ]]; then
  pass "random mode shows variety across repeated selections"
else
  fail "random mode did not show variety across repeated selections"
fi

echo ""
echo "Passed: $PASS"
echo "Failed: $FAIL"

if [[ "$FAIL" -ne 0 ]]; then
  exit 1
fi
