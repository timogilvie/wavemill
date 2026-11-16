#!/usr/bin/env bash
# Golden journey: a PR that regenerates a large generated file is evaluated,
# compared and merged with zero operator touches (HOK-3493).
#
# Incident 2026-11-15 (PR #1862): the eval asked GitHub for the diff, GitHub
# ignored `.gitattributes -diff` and returned both regenerated validators in
# full, and the judge prompt grew to 3,810,241 bytes. The CLI failed with an
# empty-message `is_error`, the mill classified it retryable and re-ran the
# identical prompt three times, then parked a green, `wm:ready` pair as manual
# comparison needed. An operator unstuck it by hand.
#
# This variant sources challenge-pair-eval with no armed eval fault, and both
# arms commit a ~1.8 MB regenerated file at `generated/huge.validator.cjs` —
# the builder's data/fixture/generated tier. The judge shim records the size
# and whether the generated sentinel reached each judge prompt, and reproduces
# the incident's empty-message failure if it ever does.
#
# Pre-fix: the eval prompt carries the file's text, the shim fails every eval,
# the pair never compares and the journey fails. Post-fix: the change enters
# the prompt through buildBudgetedChangeInput, the file is summarised, both
# evals complete, the comparison decides and the winner merges — with no
# operator action beyond the plan approval every journey gives.
set -euo pipefail

export JOURNEY_EVAL_NO_FAULT=1
export JOURNEY_LARGE_GENERATED_FILE=1
export JOURNEY_PAIR_NAME=generated-file-eval
export JOURNEY_PAIR_TICK_BUDGET="${JOURNEY_PAIR_TICK_BUDGET:-190}"

# The pair must never reach the manual-comparison state at any tick.
SAW_MANUAL_COMPARISON=0

journey_pair_tick_hook() {
  local states
  states=$(jq -r '[.tasks[]? | select(.challengePairId != null) | (.comparisonState // "")] | join(",")' \
    "$STATE_FILE" 2>/dev/null || true)
  [[ ",$states," == *manual_comparison_needed* ]] && SAW_MANUAL_COMPARISON=1
  return 0
}

# Every judge call received a prompt without the generated text and far below
# the incident's 3.8 MB. Reads the judge shim's own record.
judge_prompts_were_budgeted() {
  local log="$FAKE_AGENT_LOG"
  [[ -s "$log" ]] || return 1
  # At least one eval prompt and one comparison prompt were judged.
  grep -q 'judge_call .*kind=eval' "$log" || return 1
  grep -q 'judge_call .*kind=compare' "$log" || return 1
  # No judge prompt ever carried the generated file's content.
  if grep -q 'sentinel=1' "$log"; then return 1; fi
  # And every one stayed small (the budgeted change input summarises the file).
  awk '$0 ~ /judge_call/ {
         for (i = 1; i <= NF; i++) if ($i ~ /^bytes=/) { sub(/^bytes=/, "", $i); if ($i + 0 > 500000) exit 1 }
       }' "$log"
}

journey_post_assertions() {
  journey_assert "every judge prompt was budgeted (no generated text, under 500 KB)" judge_prompts_were_budgeted
  journey_assert "no challenge eval failed for a generated-file change" \
    bash -c '! grep -q "challenge eval failed for" "$1"' _ "$JOURNEY_TMP/logs/status.log"
  journey_assert "the pair never reached manual comparison" test "$SAW_MANUAL_COMPARISON" = "0"
  journey_assert "no operator touches were recorded" test ! -f "$STATE_DIR/operator-touches.jsonl"
  journey_assert "the only operator action was the plan approval" test "$(journey_approval_count)" = "1"
}

source "$(dirname "$0")/challenge-pair-eval.journey.sh"
