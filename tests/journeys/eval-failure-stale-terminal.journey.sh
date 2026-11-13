#!/usr/bin/env bash
# Golden journey: a stale, terminal, model-attributed eval-failure verdict must
# not abort a challenge pair (HOK-3452).
#
# Protects against: the pre-change relaunch site read `.eval-failure-decision.json`
# with no identity check. A terminal verdict left in the feature dir by an
# earlier attempt (the HOK-3076 failure shape) would then be applied to a new
# attempt and abort the pair as `terminal_stage_failure:*`.
#
# Now the record is condition-keyed on the worktree head + attempt runId and is
# read only through eval_failure_decision_current. This variant seeds a
# terminal, `attribution: model` decision carrying a stale runId at the current
# head, together with `evalFailed = true`, once both arms have a PR. No eval
# fault is armed, so this seeded state is the only failure: the mill must
# classify it on its own evidence (retryable), re-run the eval, compare, merge
# the winner and retire the loser — without aborting the pair.
set -euo pipefail

export JOURNEY_EVAL_NO_FAULT=1
export JOURNEY_PAIR_NAME=eval-failure-stale-terminal
export JOURNEY_PAIR_TICK_BUDGET="${JOURNEY_PAIR_TICK_BUDGET:-190}"

STALE_SEEDED=0
STALE_SURVIVED=0
STALE_RUN_SUFFIX="-stale"

stale_marker_path() {
  local slug
  slug="$(journey_task_field "$ISSUE" slug)"
  printf '%s\n' "$WORKTREE_ROOT/$slug/features/$slug/.eval-failure-decision.json"
}

# Positive evidence that the mill read the record and did not consume it: once
# the primary's eval is relaunched on the retryable default, the record must
# still carry the stale runId.
stale_record_survived_relaunch() {
  local marker
  [[ "$STALE_SEEDED" == "1" ]] || return 1
  grep -q "challenge eval retrying for $ISSUE:" "$JOURNEY_TMP/logs/status.log" 2>/dev/null || return 1
  marker="$(stale_marker_path)"
  [[ -f "$marker" ]] || return 1
  [[ "$(jq -r '.detail.runId // ""' "$marker" 2>/dev/null)" == *"$STALE_RUN_SUFFIX" ]]
}

# Seed exactly once, on the tick both arms first have a PR (before Ready/eval).
journey_pair_tick_hook() {
  if [[ "$STALE_SURVIVED" == "0" ]] && stale_record_survived_relaunch; then
    STALE_SURVIVED=1
    journey_log "the stale record survived the relaunch unconsumed"
  fi
  [[ "$STALE_SEEDED" == "1" ]] && return 0
  local primary="$ISSUE" challenger="$CHALLENGER"
  local p c slug wt fd head run detail
  p="$(journey_task_field "$primary" pr)"
  c="$(journey_task_field "$challenger" pr)"
  [[ -n "$p" && -n "$c" ]] || return 0
  # Seed at a tick boundary where the primary's eval has neither launched nor
  # completed: the next pass reads the record and relaunches on the retryable
  # default. Seeding after completion would be vacuous (the evalCompleted
  # guard skips the whole eval, so nothing would consume the record).
  [[ -z "$(journey_task_field "$primary" evalRunning)" ]] || return 0
  [[ -z "$(journey_task_field "$primary" evalCompleted)" \
     || "$(journey_task_field "$primary" evalCompleted)" == "false" ]] || return 0
  run="$(journey_task_field "$primary" runId)"
  slug="$(journey_task_field "$primary" slug)"
  [[ -n "$run" && -n "$slug" ]] || return 0
  wt="$WORKTREE_ROOT/$slug"
  fd="$wt/features/$slug"
  head="$(git -C "$wt" rev-parse HEAD 2>/dev/null)" || return 0
  [[ -n "$head" ]] || return 0
  detail="$(jq -cn --arg r "${run}${STALE_RUN_SUFFIX}" '{
    class: "terminal",
    failureKind: "eval-harness-error",
    attribution: "model",
    nextAction: "stale terminal verdict seeded by the journey",
    runId: $r
  }')"
  if ! bash -c '
    set -euo pipefail
    source "$1/shared/lib/wavemill-common.sh"
    source "$1/shared/lib/transient-marker.sh"
    marker_write "$2/.eval-failure-decision.json" \
      --kind eval-failure-decision --head "$3" --expires-on head,operator-event \
      --reason "stale terminal eval failure" --detail-json "$4"
    state_mutate "$STATE_FILE" \
      ".tasks[\$i].evalFailed = true | .tasks[\$i].evalCompleted = false" \
      --arg i "$5"
  ' _ "$JOURNEY_INSTALL_DIR" "$fd" "$head" "$detail" "$primary"; then
    return 0
  fi
  STALE_SEEDED=1
  journey_log "seeded stale terminal eval-failure verdict at head $head, run ${run}${STALE_RUN_SUFFIX}"
}

# The seeded verdict is never current, so nothing it says may reach the pair.
stale_verdict_was_not_applied() {
  local reason
  reason="$(jq -r '[.. | strings | select(test("^(terminal_stage_failure|invalid_challenge):"))] | length' "$STATE_FILE" 2>/dev/null || echo 0)"
  [[ "$reason" == "0" ]] || return 1
  [[ ! -f "$WORKTREE_ROOT/$PRIMARY_SLUG/features/$PRIMARY_SLUG/.challenge-aborted.json" ]] || return 1
  [[ -z "$(jq -r '(.challengePairAbortions // {}) | length | select(. > 0)' "$STATE_FILE" 2>/dev/null)" ]] || return 1
  ! grep -q 'terminal_stage_failure:\|invalid_challenge:' "$JOURNEY_TMP/logs/status.log" 2>/dev/null
}

journey_post_assertions() {
  journey_assert "the stale terminal verdict was seeded on an open pair" test "$STALE_SEEDED" = "1"
  journey_assert "the stale verdict was not applied (no terminal/invalid challenge reason)" stale_verdict_was_not_applied
  journey_assert "the record still carried the stale runId after the mill read it" test "$STALE_SURVIVED" = "1"
  journey_assert "no operator touches were recorded" test ! -f "$STATE_DIR/operator-touches.jsonl"
}

source "$(dirname "$0")/challenge-pair-eval.journey.sh"
