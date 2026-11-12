#!/usr/bin/env bash
JOURNEY_REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
exec > "$JOURNEY_REPO_DIR/hok3451-journey.log" 2>&1
set -x
# Golden journey (HOK-3451): a planner-stage challenge pair defers its
# challenger on awaiting_expanded_route, materialises once the expanded route
# is available, and reaches comparison + auto-merge with zero operator
# touches.
#
# The challenger is not launched at t=0. It waits as a pending arm on the
# primary until the expanded task packet provides the non-varied coder and
# reviewer routes. During that window the gate and resolver must treat the
# pair as deferred (not orphaned), and the status view must surface the
# awaiting_expanded_route arm. After materialisation the pair runs the normal
# plan → code → review → eval → compare → merge chain.
export JOURNEY_PAIR_STAGE=plan
export JOURNEY_PAIR_NAME=planner-expanded-route-comparison

# State captured during the run. The arm row and comparison record are reaped
# before final assertions, so we record them while they are still present.
JOURNEY_ARM_STATE_RECORDED=""
JOURNEY_COMPARISON_WINNER_RECORDED=""
JOURNEY_DEFERRED_WINDOW_SEEN=""

# Per-tick observer installed via the hook in challenge-pair-eval.journey.sh.
# We record the first time we observe the materialised arm and the comparison
# winner, and note that the pair spent its planning phase with a deferred
# challenger (no task row) rather than being flagged orphaned.
journey_pair_tick_hook() {
  if [[ -n "${ISSUE:-}" && -n "${STATE_FILE:-}" && -f "$STATE_FILE" ]]; then
    local arm_state primary_phase challenger_slug
    arm_state=$(jq -r --arg p "$ISSUE" --arg c "$CHALLENGER" \
      '(.tasks[$p].challengeArms // []) | map(select(.key == $c)) | .[0].challengeArmState // ""' \
      "$STATE_FILE" 2>/dev/null || true)
    if [[ "$arm_state" == "materialized" && -z "$JOURNEY_ARM_STATE_RECORDED" ]]; then
      JOURNEY_ARM_STATE_RECORDED="$arm_state"
    fi

    primary_phase=$(jq -r --arg p "$ISSUE" '.tasks[$p].phase // ""' "$STATE_FILE" 2>/dev/null || true)
    challenger_slug=$(jq -r --arg c "$CHALLENGER" '.tasks[$c].slug // ""' "$STATE_FILE" 2>/dev/null || true)
    if [[ "$primary_phase" == "planning" && -z "$challenger_slug" && -z "$JOURNEY_DEFERRED_WINDOW_SEEN" ]]; then
      JOURNEY_DEFERRED_WINDOW_SEEN="1"
    fi
  fi

  if [[ -z "$JOURNEY_COMPARISON_WINNER_RECORDED" ]]; then
    local winner
    winner=$(comparison_winner)
    if [[ -n "$winner" ]]; then
      JOURNEY_COMPARISON_WINNER_RECORDED="$winner"
    fi
  fi
}

# Post-assertion hook invoked by challenge-pair-eval.journey.sh before it
# finishes. Variables ISSUE, CHALLENGER, STATE_FILE, WINNER, etc. are defined
# in the sourced journey.
journey_post_assertions() {
  # The arm must have completed materialisation (not be stuck pending).
  journey_assert "challenger arm reached a terminal materialised state" \
    test "$JOURNEY_ARM_STATE_RECORDED" = "materialized"

  # The comparison winner must have been recorded.
  journey_assert "comparison recorded a winner" \
    test -n "$JOURNEY_COMPARISON_WINNER_RECORDED"

  # HOK-3451: the pair spent the planning phase deferred (challenger absent
  # as a task row) rather than orphaned/attention-generating.
  journey_assert "pair was deferred (not orphaned) while awaiting expanded route" \
    test "$JOURNEY_DEFERRED_WINDOW_SEEN" = "1"

  # HOK-3451: zero operator touches on the whole expanded-route path. The
  # harness already tracks attention; re-assert it explicitly.
  journey_assert "expanded-route pair reached comparison with zero operator touches" \
    test "$JOURNEY_SAW_ATTENTION" = "0"
}

source "$(dirname "$0")/challenge-pair-eval.journey.sh"
