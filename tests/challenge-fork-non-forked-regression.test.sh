#!/usr/bin/env bash
# HOK-2814: non-forked pairs (plan stage, and coder stage until it is enabled)
# behave exactly as before. This is the regression backstop the task packet
# calls out as the one that matters most — if a future edit accidentally
# routes a plan- or implementation-stage pair through the fork trigger, this
# test breaks.
#
# What we assert:
#   1. `defer_challenger` is only set to true for the literal condition
#      `challenge_stage == "review"` in both wavemill-mill.sh and
#      wavemill-monitor.sh. No other stage triggers the defer path.
#   2. For a plan- or implementation-stage varied pair, challenge_arm_json_
#      build + challenge_intent_record_selection produce no arm record on
#      the primary (the arm array is empty), and both primary + challenger
#      task entries receive the canonical intent — the shape the un-forked
#      launch path always produced pre-P2.4a.
#
# The intent round-trip itself is exercised by challenge-intent-roundtrip.
# test.sh; here we add only the "no arm record" guard that the round-trip
# test does not currently make.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR_ROOT/shared/lib/wavemill-monitor.sh"
MILL_SCRIPT="$REPO_DIR_ROOT/shared/lib/wavemill-mill.sh"
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

log() { :; }
log_warn() { :; }

TMP_ROOT="$(mktemp -d "/tmp/challenge-fork-non-forked-regression.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

# ────────────────────────────────────────────────────────────────
# Source-level guard: defer_challenger only sets true for review stage,
# and only inside the HOK-2811 blocks. No other stage triggers the fork.
# ────────────────────────────────────────────────────────────────
echo "=== defer_challenger is gated on 'review' stage only ==="

# Every assignment of defer_challenger=true in either file must appear
# alongside the exact `challenge_stage == "review"` guard on the immediate
# preceding line. Any new stage added to the defer path breaks this test.
for source in "$MONITOR_SCRIPT_FILE" "$MILL_SCRIPT"; do
  file="$(basename "$source")"
  # Pull every line number that assigns defer_challenger=true.
  while IFS= read -r line_no; do
    [[ -n "$line_no" ]] || continue
    # Look at the line above; the real code always sits inside the
    # `if [[ "$challenge_stage" == "review" ]]; then` block.
    context="$(awk -v n="$line_no" 'NR >= n-1 && NR <= n+1' "$source")"
    if [[ "$context" == *'challenge_stage" == "review"'* ]]; then
      pass "$file:$line_no defer_challenger=true is gated on review stage"
    else
      echo "    context:"
      printf '%s\n' "$context" | sed 's/^/      /'
      fail "$file:$line_no defer_challenger=true is NOT gated on review stage"
    fi
  done < <(grep -n 'defer_challenger="true"' "$source" | cut -d: -f1)
done

# Symmetrically: no assignment of defer_challenger=true near a check for
# "implementation" or "planning" — a positive regression guard.
for source in "$MONITOR_SCRIPT_FILE" "$MILL_SCRIPT"; do
  file="$(basename "$source")"
  # Any `defer_challenger="true"` inside a defer stanza whose immediate
  # guard names "implementation" or "planning" is the exact regression.
  offending=""
  while IFS= read -r line_no; do
    [[ -n "$line_no" ]] || continue
    context="$(awk -v n="$line_no" 'NR >= n-3 && NR <= n+1' "$source")"
    if [[ "$context" == *'challenge_stage" == "implementation"'* \
       || "$context" == *'challenge_stage" == "planning"'* \
       || "$context" == *'challenge_stage" == "coding"'* \
       || "$context" == *'challenge_stage" == "plan"'* ]]; then
      offending+="$file:$line_no "
    fi
  done < <(grep -n 'defer_challenger="true"' "$source" | cut -d: -f1)

  if [[ -z "$offending" ]]; then
    pass "$file has no defer_challenger=true tied to plan/implementation/coding"
  else
    fail "$file has defer_challenger=true near plan/implementation guard: $offending"
  fi
done

# ────────────────────────────────────────────────────────────────
# Runtime behaviour: challenge_arm_json_build + record_selection do NOT
# produce a pending arm record for a plan- or implementation-stage pair
# just because they varied their stage. The arm record is only for
# review-stage deferrals. The intent, however, is still recorded on both
# tasks so the launch site can consume it.
# ────────────────────────────────────────────────────────────────
echo ""
echo "=== plan-stage pair: no pending arm, both tasks get intent ==="

STATE_FILE="$TMP_ROOT/state-plan.json"
export STATE_FILE
printf '%s\n' '{"tasks":{"HOK-PLAN":{"slug":"plan"},"HOK-PLAN_c":{"slug":"plan-c"}}}' > "$STATE_FILE"

PLAN_INTENT='{"schemaVersion":1,"pairId":"HOK-PLAN","issueId":"HOK-PLAN","selectedStage":"plan","challengeStage":"plan","primary":{"pairId":"HOK-PLAN","side":"primary","challengeStage":"plan","expectedStageModel":"claude-sonnet-5","expectedRoute":{"planner":"claude-sonnet-5"}},"challenger":{"pairId":"HOK-PLAN","side":"challenger","challengeStage":"plan","expectedStageModel":"gpt-5.6-terra","expectedRoute":{"planner":"gpt-5.6-terra"}}}'

challenge_intent_record_selection "HOK-PLAN" "HOK-PLAN_c" "$PLAN_INTENT"

check_eq "plan-stage: no pending arm on primary" "0" \
  "$(jq -r '(.tasks["HOK-PLAN"].challengeArms // []) | length' "$STATE_FILE")"
check_eq "plan-stage: no arm on challenger" "0" \
  "$(jq -r '(.tasks["HOK-PLAN_c"].challengeArms // []) | length' "$STATE_FILE")"
check_eq "plan-stage: primary intent recorded" "plan" \
  "$(jq -r '.tasks["HOK-PLAN"].challengeExecutionIntent.selectedStage' "$STATE_FILE")"
check_eq "plan-stage: challenger intent recorded" "plan" \
  "$(jq -r '.tasks["HOK-PLAN_c"].challengeExecutionIntent.selectedStage' "$STATE_FILE")"
check_eq "plan-stage: challengeStage on primary" "plan" \
  "$(jq -r '.tasks["HOK-PLAN"].challengeStage' "$STATE_FILE")"
check_eq "plan-stage: challengeStage on challenger" "plan" \
  "$(jq -r '.tasks["HOK-PLAN_c"].challengeStage' "$STATE_FILE")"

echo ""
echo "=== implementation-stage pair: no pending arm, both tasks get intent ==="

STATE_FILE="$TMP_ROOT/state-impl.json"
export STATE_FILE
printf '%s\n' '{"tasks":{"HOK-IMPL":{"slug":"impl"},"HOK-IMPL_c":{"slug":"impl-c"}}}' > "$STATE_FILE"

IMPL_INTENT='{"schemaVersion":1,"pairId":"HOK-IMPL","issueId":"HOK-IMPL","selectedStage":"implementation","challengeStage":"implementation","primary":{"pairId":"HOK-IMPL","side":"primary","challengeStage":"implementation","expectedStageModel":"claude-opus-4-7","expectedRoute":{"coder":"claude-opus-4-7"}},"challenger":{"pairId":"HOK-IMPL","side":"challenger","challengeStage":"implementation","expectedStageModel":"gpt-5.6-terra","expectedRoute":{"coder":"gpt-5.6-terra"}}}'

challenge_intent_record_selection "HOK-IMPL" "HOK-IMPL_c" "$IMPL_INTENT"

check_eq "impl-stage: no pending arm on primary" "0" \
  "$(jq -r '(.tasks["HOK-IMPL"].challengeArms // []) | length' "$STATE_FILE")"
check_eq "impl-stage: no arm on challenger" "0" \
  "$(jq -r '(.tasks["HOK-IMPL_c"].challengeArms // []) | length' "$STATE_FILE")"
check_eq "impl-stage: primary intent recorded" "implementation" \
  "$(jq -r '.tasks["HOK-IMPL"].challengeExecutionIntent.selectedStage' "$STATE_FILE")"
check_eq "impl-stage: challenger intent recorded" "implementation" \
  "$(jq -r '.tasks["HOK-IMPL_c"].challengeExecutionIntent.selectedStage' "$STATE_FILE")"

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
[[ "$FAIL" -eq 0 ]]
