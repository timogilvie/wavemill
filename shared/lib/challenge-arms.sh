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
#   <plan_depth> <code_depth> <review_mode>
challenge_arm_json_build() {
  local key="$1" slug="$2" branch="$3" role="$4" varied_stage="$5"
  local coder_model="${6:-}" planner_model="${7:-}" reviewer_model="${8:-}"
  local coder_agent="${9:-}" planner_agent="${10:-}" reviewer_agent="${11:-}"
  local plan_depth="${12:-}" code_depth="${13:-}" review_mode="${14:-}"

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
    '{
      key: $key,
      slug: $slug,
      branch: $branch,
      role: $role,
      variedStage: $variedStage,
      challengeArmState: "awaiting_fork",
      models: {planner: $planner, coder: $coder, reviewer: $reviewer},
      agents: {planner: $plannerAgent, coder: $coderAgent, reviewer: $reviewerAgent},
      planDepth: $planDepth,
      codeDepth: $codeDepth,
      reviewMode: $reviewMode,
      recordedAt: (now | todate),
      materializedAt: null,
      forkCommit: null
    }'
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

  local pending_keys
  pending_keys=$(jq -r --arg issue "$primary_issue" \
    '(.tasks[$issue].challengeArms // [])
     | map(select(.challengeArmState == "awaiting_fork") | .key)
     | .[]' \
    "$STATE_FILE" 2>/dev/null || true)
  [[ -n "$pending_keys" ]] || return 0

  local key extra_json
  extra_json="$(jq -cn --arg r "$reason" --arg d "$detail" \
    '{cancelReason: $r, cancelDetail: $d, cancelledAt: (now | todate)}')"
  while IFS= read -r key; do
    [[ -n "$key" ]] || continue
    challenge_arms_set_state "$primary_issue" "$key" "awaiting_fork" "cancelled" "$extra_json" 2>/dev/null || true
    if declare -F log_route_lifecycle >/dev/null 2>&1; then
      log_route_lifecycle "challenge_arm_cancelled" \
        "issue=$primary_issue" \
        "arm=$key" \
        "reason=$reason"
    fi
  done <<< "$pending_keys"

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

  local interrupted_keys
  interrupted_keys=$(jq -r --arg issue "$primary_issue" \
    '(.tasks[$issue].challengeArms // [])
     | map(select(.challengeArmState == "materializing") | .key)
     | .[]' \
    "$STATE_FILE" 2>/dev/null || true)
  [[ -n "$interrupted_keys" ]] || return 0

  local key extra_json
  extra_json="$(jq -cn '{recoveredFrom: "materializing", recoveredAt: (now | todate)}')"
  while IFS= read -r key; do
    [[ -n "$key" ]] || continue
    challenge_arms_set_state "$primary_issue" "$key" "materializing" "awaiting_fork" "$extra_json" 2>/dev/null || true
    if declare -F log_route_lifecycle >/dev/null 2>&1; then
      log_route_lifecycle "challenge_arm_recovered" \
        "issue=$primary_issue" \
        "arm=$key" \
        "reason=materializing_interrupted_by_restart"
    fi
  done <<< "$interrupted_keys"
  return 0
}

# Convenience read accessors used by the fork trigger and materialiser.
challenge_arm_read_field() {
  local arm_json="$1" jq_path="$2"
  [[ -n "$arm_json" && -n "$jq_path" ]] || return 0
  echo "$arm_json" | jq -r "$jq_path // \"\"" 2>/dev/null || echo ""
}
