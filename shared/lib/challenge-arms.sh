#!/usr/bin/env bash
# Challenge arms[] state helpers (HOK-2811, Arbiter P2.4a).
#
# When a challenge pair varies the review stage, the challenger is not launched
# alongside the primary. Its record lives as a nested entry on the primary
# task's state — an "arm" waiting to be materialised at the fork commit. This
# module owns the arms[] array: writing pending records at launch time, listing
# them for the fork trigger, and driving them through an exactly-once state
# machine.
#
# State machine (challengeArmState):
#
#   awaiting_fork → materializing → materialized      (happy path)
#                 → cancelled                         (primary aborted pre-fork)
#                 → exhausted                         (materialisation retry ceiling)
#   materializing → awaiting_fork                     (retryable failure; reset)
#                 → materialized                      (success)
#                 → exhausted                         (final failure)
#
# The array is stored under `.tasks[$primaryIssue].challengeArms` and mutated
# via state_mutate so writes are serialised against other state updates. The
# arms shape from day one uses an array so Phase 4's N-candidates-at-one-role
# extension is a matter of appending records — no code rewrite from a
# primary/challenger pair.

# Return the JSON of every arm on a primary. Prints "[]" when the task has no
# arms (unmaterialised, or the primary is not a challenge participant).
challenge_arms_list() {
  local primary_issue="$1"
  [[ -n "$primary_issue" && -n "${STATE_FILE:-}" && -f "${STATE_FILE}" ]] || { echo "[]"; return 0; }
  jq -c --arg issue "$primary_issue" \
    '(.tasks[$issue].challengeArms // [])' \
    "$STATE_FILE" 2>/dev/null || echo "[]"
}

# Return the JSON of arms in the awaiting_fork state.
challenge_arms_list_pending() {
  local primary_issue="$1"
  [[ -n "$primary_issue" && -n "${STATE_FILE:-}" && -f "${STATE_FILE}" ]] || { echo "[]"; return 0; }
  jq -c --arg issue "$primary_issue" \
    '(.tasks[$issue].challengeArms // []) | map(select(.challengeArmState == "awaiting_fork"))' \
    "$STATE_FILE" 2>/dev/null || echo "[]"
}

# Return the JSON of arms in the awaiting_expanded_route state (HOK-3065):
# planner-stage challengers whose selection was sealed at launch and that
# materialise once the expanded route is available. Kept separate from
# challenge_arms_list_pending so the reviewer-stage fork trigger and the
# planner-stage expansion trigger each drive only their own arms.
challenge_arms_list_awaiting_expanded_route() {
  local primary_issue="$1"
  [[ -n "$primary_issue" && -n "${STATE_FILE:-}" && -f "${STATE_FILE}" ]] || { echo "[]"; return 0; }
  jq -c --arg issue "$primary_issue" \
    '(.tasks[$issue].challengeArms // []) | map(select(.challengeArmState == "awaiting_expanded_route"))' \
    "$STATE_FILE" 2>/dev/null || echo "[]"
}

# Fetch a single arm by key. Prints its JSON object, or empty when absent.
challenge_arms_get() {
  local primary_issue="$1" arm_key="$2"
  [[ -n "$primary_issue" && -n "$arm_key" && -n "${STATE_FILE:-}" && -f "${STATE_FILE}" ]] || return 0
  jq -c --arg issue "$primary_issue" --arg key "$arm_key" \
    '(.tasks[$issue].challengeArms // []) | map(select(.key == $key)) | .[0] // empty' \
    "$STATE_FILE" 2>/dev/null || true
}

# Assemble a pending arm record from the fields the launch sites already have.
# Prints a compact JSON object; caller feeds it back into challenge_arms_record_pending.
# Optional fields fall back to empty strings.
#
# Usage: challenge_arm_json_build <key> <slug> <branch> <role> <varied_stage> \
#   <coder_model> <planner_model> <reviewer_model> \
#   <coder_agent> <planner_agent> <reviewer_agent> \
#   <plan_depth> <code_depth> <review_mode> [execution_intent_json] [pending_state]
#
# pending_state (HOK-3065) is the lifecycle state the arm starts in — either
# `awaiting_fork` (default; reviewer-stage arm forking off completed work) or
# `awaiting_expanded_route` (planner-stage arm whose non-varied route waits on
# the expanded task packet). It is recorded twice: as the live
# `challengeArmState`, and as an immutable `pendingState` marker so restart
# recovery can return an interrupted `materializing` arm to the correct origin.
challenge_arm_json_build() {
  local key="$1" slug="$2" branch="$3" role="$4" varied_stage="$5"
  local coder_model="${6:-}" planner_model="${7:-}" reviewer_model="${8:-}"
  local coder_agent="${9:-}" planner_agent="${10:-}" reviewer_agent="${11:-}"
  local plan_depth="${12:-}" code_depth="${13:-}" review_mode="${14:-}"
  local execution_intent_json="${15:-}" execution_intent_arg="null"
  local pending_state="${16:-awaiting_fork}"
  case "$pending_state" in
    awaiting_fork|awaiting_expanded_route) ;;
    *) pending_state="awaiting_fork" ;;
  esac
  if challenge_intent_json_is_canonical "$execution_intent_json"; then
    execution_intent_arg="$execution_intent_json"
  fi

  jq -cn \
    --arg key "$key" \
    --arg slug "$slug" \
    --arg branch "$branch" \
    --arg role "$role" \
    --arg variedStage "$varied_stage" \
    --arg planner "$planner_model" \
    --arg coder "$coder_model" \
    --arg reviewer "$reviewer_model" \
    --arg plannerAgent "$planner_agent" \
    --arg coderAgent "$coder_agent" \
    --arg reviewerAgent "$reviewer_agent" \
    --arg planDepth "$plan_depth" \
    --arg codeDepth "$code_depth" \
    --arg reviewMode "$review_mode" \
    --argjson executionIntent "$execution_intent_arg" \
    --arg pendingState "$pending_state" \
    '{
      key: $key,
      slug: $slug,
      branch: $branch,
      role: $role,
      variedStage: $variedStage,
      challengeArmState: $pendingState,
      pendingState: $pendingState,
      models: {planner: $planner, coder: $coder, reviewer: $reviewer},
      agents: {planner: $plannerAgent, coder: $coderAgent, reviewer: $reviewerAgent},
      planDepth: $planDepth,
      codeDepth: $codeDepth,
      reviewMode: $reviewMode,
      executionIntent: $executionIntent,
      recordedAt: (now | todate),
      materializedAt: null,
      forkCommit: null
    }'
}

# True when JSON is the canonical challenge execution intent envelope.
challenge_intent_json_is_canonical() {
  local intent_json="${1:-}"
  [[ -n "$intent_json" ]] || return 1
  echo "$intent_json" | jq -e \
    '.schemaVersion == 1 and (.pairId // "") != "" and (.issueId // "") != ""' \
    >/dev/null 2>&1
}

# Selection-time state writer for canonical challenge execution intent.
#
# Usage: challenge_intent_record_selection <primary_issue> <challenger_key> <intent_json>
challenge_intent_record_selection() {
  local issue="$1" challenger_key="${2:-}" intent_json="${3:-}"
  [[ -n "$issue" ]] || return 0
  challenge_intent_json_is_canonical "$intent_json" || return 0
  [[ -n "${STATE_FILE:-}" && -f "${STATE_FILE}" ]] || return 0
  declare -F state_mutate >/dev/null 2>&1 || return 0

  state_mutate "$STATE_FILE" \
    '($intent.selectedStage // $intent.challengeStage // "") as $stage
     | ($intent.primary // {}) as $p
     | ($intent.challenger // {}) as $c
     | .tasks[$issue] = (.tasks[$issue] // {})
     | .tasks[$issue].challengeExecutionIntent = $intent
     | (if $stage != "" then .tasks[$issue].challengeStage = $stage else . end)
     | (if ($p.expectedStageModel // "") != ""
        then .tasks[$issue].challengeVariedModel = $p.expectedStageModel
             | .tasks[$issue].challengeVariedAgent = ($p.expectedStageAgent // "")
        else . end)
     | if $challenger != "" and (.tasks[$challenger] != null)
       then .tasks[$challenger].challengeExecutionIntent = $intent
            | (if $stage != "" then .tasks[$challenger].challengeStage = $stage else . end)
            | (if ($c.expectedStageModel // "") != ""
               then .tasks[$challenger].challengeVariedModel = $c.expectedStageModel
                    | .tasks[$challenger].challengeVariedAgent = ($c.expectedStageAgent // "")
               else . end)
       else .
       end' \
    --arg issue "$issue" \
    --arg challenger "$challenger_key" \
    --argjson intent "$intent_json" || true
}

# Append (or replace by .key) an arm record on the primary's task entry.
# Idempotent: calling twice with the same key leaves a single record.
#
# Usage: challenge_arms_record_pending <primary_issue> <arm_json>
challenge_arms_record_pending() {
  local primary_issue="$1" arm_json="$2"
  [[ -n "$primary_issue" && -n "$arm_json" ]] || return 1
  [[ -n "${STATE_FILE:-}" && -f "${STATE_FILE}" ]] || return 1
  echo "$arm_json" | jq -e '.key and .role and .variedStage' >/dev/null 2>&1 || return 1

  state_mutate "$STATE_FILE" \
    '($arm.key) as $armKey
     | .tasks[$issue].challengeArms = (
         ((.tasks[$issue].challengeArms // []) | map(select(.key != $armKey))) + [$arm]
       )
     | .tasks[$issue].updated = (now | todate)' \
    --arg issue "$primary_issue" \
    --argjson arm "$arm_json"
}

# Checked-and-set state transition. Fails (rc=1) unless the current
# challengeArmState matches $expected. Optional $extra_object is a JSON
# object literal merged into the arm on the same atomic write, letting
# callers stamp e.g. materializedAt/forkCommit alongside the transition.
#
# Usage: challenge_arms_set_state <primary_issue> <arm_key> <expected> <new_state> [extra_json_object]
challenge_arms_set_state() {
  local primary_issue="$1" arm_key="$2" expected="$3" new_state="$4"
  local extra_object="${5:-{\}}"
  [[ -n "$primary_issue" && -n "$arm_key" && -n "$expected" && -n "$new_state" ]] || return 1
  [[ -n "${STATE_FILE:-}" && -f "${STATE_FILE}" ]] || return 1
  # Fail closed on malformed extra_object rather than passing junk to jq.
  echo "$extra_object" | jq -e 'type == "object"' >/dev/null 2>&1 || return 1

  local check
  check=$(jq -r --arg issue "$primary_issue" --arg key "$arm_key" \
    '(.tasks[$issue].challengeArms // []) | map(select(.key == $key)) | .[0].challengeArmState // ""' \
    "$STATE_FILE" 2>/dev/null || echo "")
  if [[ "$check" != "$expected" ]]; then
    return 1
  fi

  state_mutate "$STATE_FILE" \
    '.tasks[$issue].challengeArms = (
        (.tasks[$issue].challengeArms // []) | map(
          if .key == $key and .challengeArmState == $expected then
            . + {challengeArmState: $new} + $extra
          else . end
        )
      )
      | .tasks[$issue].updated = (now | todate)' \
    --arg issue "$primary_issue" \
    --arg key "$arm_key" \
    --arg expected "$expected" \
    --arg new "$new_state" \
    --argjson extra "$extra_object"
}

# Remove an arm record entirely. Used when the primary aborts pre-fork and
# there is nothing worth tracking. Idempotent.
challenge_arms_delete() {
  local primary_issue="$1" arm_key="$2"
  [[ -n "$primary_issue" && -n "$arm_key" ]] || return 1
  [[ -n "${STATE_FILE:-}" && -f "${STATE_FILE}" ]] || return 1

  state_mutate "$STATE_FILE" \
    '.tasks[$issue].challengeArms = (
        (.tasks[$issue].challengeArms // []) | map(select(.key != $key))
      )
      | .tasks[$issue].updated = (now | todate)' \
    --arg issue "$primary_issue" \
    --arg key "$arm_key"
}

# Cancel every pending arm on a primary. Called when the primary terminally
# aborts before the fork could fire, so the pair-accounting layer sees a
# deliberate no-comparison rather than a phantom one-armed pair.
#
# The reason is a taxonomy value (e.g. pre_fork_primary_failure); the optional
# detail carries the free-text cause for audit. The cancelled arm record is
# retained on the primary so the collapse stays inspectable.
#
# Usage: challenge_arms_cancel_pending <primary_issue> <reason> [detail]
challenge_arms_cancel_pending() {
  local primary_issue="$1" reason="${2:-primary_aborted_pre_fork}"
  local detail="${3:-pending challenger arm cancelled before fork}"
  [[ -n "$primary_issue" ]] || return 1
  [[ -n "${STATE_FILE:-}" && -f "${STATE_FILE}" ]] || return 0

  # Both pending states (awaiting_fork, awaiting_expanded_route) are cancellable
  # (HOK-3065). Emit `key<TAB>state` so each arm is cancelled from its own
  # current state via the checked-and-set transition.
  local pending_rows
  pending_rows=$(jq -r --arg issue "$primary_issue" \
    '(.tasks[$issue].challengeArms // [])
     | map(select(.challengeArmState == "awaiting_fork" or .challengeArmState == "awaiting_expanded_route"))
     | .[]
     | "\(.key)\t\(.challengeArmState)"' \
    "$STATE_FILE" 2>/dev/null || true)
  [[ -n "$pending_rows" ]] || return 0

  local key state extra_json
  extra_json="$(jq -cn --arg r "$reason" --arg d "$detail" \
    '{cancelReason: $r, cancelDetail: $d, cancelledAt: (now | todate)}')"
  while IFS=$'\t' read -r key state; do
    [[ -n "$key" ]] || continue
    challenge_arms_set_state "$primary_issue" "$key" "$state" "cancelled" "$extra_json" 2>/dev/null || true
    if declare -F log_route_lifecycle >/dev/null 2>&1; then
      log_route_lifecycle "challenge_arm_cancelled" \
        "issue=$primary_issue" \
        "arm=$key" \
        "reason=$reason"
    fi
  done <<< "$pending_rows"

  # Once we've cancelled the pending arms, this primary no longer has a live
  # pair. Clear the challenge selection so downstream accounting treats it as
  # a solo run rather than a lone primary of a pair with a dead challenger.
  # Mirrors the del(...) set in challenge_cancel_challenger_arm so both
  # collapse paths leave the primary looking identical.
  state_mutate "$STATE_FILE" \
    '.tasks[$issue].challengeCollapseReason = $reason
     | .tasks[$issue].challengeCollapseDetail = $detail
     | .tasks[$issue].challenge = false
     | del(.tasks[$issue].challengeRole,
           .tasks[$issue].challengePairId,
           .tasks[$issue].challengeStage,
           .tasks[$issue].challengeVariedModel,
           .tasks[$issue].challengeVariedAgent,
           .tasks[$issue].challengeModel)
     | .tasks[$issue].updated = (now | todate)' \
    --arg issue "$primary_issue" \
    --arg reason "$reason" \
    --arg detail "$detail" >/dev/null 2>&1 || true

  return 0
}

# Restart recovery (HOK-2813): an arm caught in `materializing` when the mill
# died never completed its fork. Materialisation is idempotent-by-retry (the
# branch-at-fork-commit tolerance in challenge_materialize_challenger_arm
# attaches to a partial attempt, and mismatched identity fails closed), so the
# safe restart posture is to reset the arm to awaiting_fork and let the fork
# trigger's bounded-retry gate drive it again. The persisted arm record — the
# original execution intent, models, and planned identity — is preserved
# verbatim; only the state field and a recovery stamp change.
#
# Usage: challenge_arms_recover_interrupted <primary_issue>
challenge_arms_recover_interrupted() {
  local primary_issue="$1"
  [[ -n "$primary_issue" ]] || return 1
  [[ -n "${STATE_FILE:-}" && -f "${STATE_FILE}" ]] || return 0

  # Reset each interrupted arm to the pending state it started in. Reviewer arms
  # return to awaiting_fork; planner arms (HOK-3065) return to
  # awaiting_expanded_route. Legacy records with no pendingState marker default
  # to awaiting_fork, preserving pre-HOK-3065 behavior. Emit `key<TAB>origin`.
  local interrupted_rows
  interrupted_rows=$(jq -r --arg issue "$primary_issue" \
    '(.tasks[$issue].challengeArms // [])
     | map(select(.challengeArmState == "materializing"))
     | .[]
     | "\(.key)\t\(.pendingState // "awaiting_fork")"' \
    "$STATE_FILE" 2>/dev/null || true)
  [[ -n "$interrupted_rows" ]] || return 0

  local key origin extra_json
  while IFS=$'\t' read -r key origin; do
    [[ -n "$key" ]] || continue
    case "$origin" in
      awaiting_fork|awaiting_expanded_route) ;;
      *) origin="awaiting_fork" ;;
    esac
    extra_json="$(jq -cn --arg o "$origin" '{recoveredFrom: "materializing", recoveredTo: $o, recoveredAt: (now | todate)}')"
    challenge_arms_set_state "$primary_issue" "$key" "materializing" "$origin" "$extra_json" 2>/dev/null || true
    if declare -F log_route_lifecycle >/dev/null 2>&1; then
      log_route_lifecycle "challenge_arm_recovered" \
        "issue=$primary_issue" \
        "arm=$key" \
        "reason=materializing_interrupted_by_restart"
    fi
  done <<< "$interrupted_rows"
  return 0
}

# Convenience read accessors used by the fork trigger and materialiser.
challenge_arm_read_field() {
  local arm_json="$1" jq_path="$2"
  [[ -n "$arm_json" && -n "$jq_path" ]] || return 0
  echo "$arm_json" | jq -r "$jq_path // \"\"" 2>/dev/null || echo ""
}

# Whether a challenge at <stage> defers its challenger to a fork of the
# primary instead of launching it at t=0. Review-stage arms fork after the
# primary's coding (HOK-2811); implementation-stage arms fork after the
# primary's single shared plan (HOK-3086) so both coders start from one plan
# and one commit and the pair carries a ForkIdentity.
#
# WAVEMILL_CHALLENGE_IMPLEMENTATION_FORK=0 restores independent implementation
# launches (operator rollback); those pairs then carry delivery verdicts only.
challenge_stage_defers_to_fork() {
  case "${1:-}" in
    review) return 0 ;;
    implementation) [[ "${WAVEMILL_CHALLENGE_IMPLEMENTATION_FORK:-1}" != "0" ]] ;;
    *) return 1 ;;
  esac
}
