#!/usr/bin/env bash
# Idempotent terminal transition reconciliation for wavemill task surfaces.

WAVEMILL_TERMINAL_RECONCILER_LOADED=1

wavemill_terminal_reason_valid() {
  case "${1:-}" in
    review_complete|ready_complete|pr_opened|pr_merged|pr_closed_unmerged|challenge_resolved_winner|challenge_invalid|challenge_no_comparison|operator_abort|recovery_failure) return 0 ;;
    *) return 1 ;;
  esac
}

wavemill_terminal_marker_key() {
  local reason="$1" pr_number="${2:-}"
  [[ -n "$pr_number" ]] && printf '%s:%s\n' "$reason" "$pr_number" || printf '%s\n' "$reason"
}

wavemill_terminal_feature_dir() {
  local issue="$1" slug="" worktree=""
  if [[ -n "${STATE_FILE:-}" && -r "${STATE_FILE:-}" ]] && command -v jq >/dev/null 2>&1; then
    slug="$(jq -r --arg issue "$issue" '.tasks[$issue].slug // empty' "$STATE_FILE" 2>/dev/null || true)"
    worktree="$(jq -r --arg issue "$issue" '.tasks[$issue].worktree // empty' "$STATE_FILE" 2>/dev/null || true)"
  fi
  [[ -n "$slug" ]] || slug="${SLUG:-${WAVEMILL_SLUG:-${WAVEMILL_FEATURE_SLUG:-}}}"
  [[ -n "$worktree" ]] || worktree="${WT_DIR:-${WAVEMILL_WT_DIR:-}}"
  [[ -z "$worktree" && -n "${WORKTREE_ROOT:-}" && -n "$slug" ]] && worktree="${WORKTREE_ROOT%/}/$slug"
  if [[ -n "$worktree" && -n "$slug" ]]; then
    for kind in features bugs; do
      [[ -d "${worktree%/}/$kind/$slug" ]] && { printf '%s\n' "${worktree%/}/$kind/$slug"; return 0; }
    done
    printf '%s\n' "${worktree%/}/features/$slug"
    return 0
  fi
  return 1
}

wavemill_pr_live_state() {
  local pr_number="${1:-}"
  [[ -n "$pr_number" ]] || return 1
  command -v gh >/dev/null 2>&1 || return 1
  gh pr view "$pr_number" --json number,state,mergedAt --jq \
    '{number, state, mergedAt, terminalState: (if .mergedAt != null then "MERGED" elif .state == "CLOSED" then "CLOSED" else .state end)}' 2>/dev/null
}

wavemill_terminal_effective_reason() {
  local reason="$1" pr_json="${2:-}" terminal_state=""
  [[ -n "$pr_json" ]] && terminal_state="$(jq -r '.terminalState // empty' <<<"$pr_json" 2>/dev/null || true)"
  case "$terminal_state" in
    MERGED) printf 'pr_merged\n'; return 0 ;;
    CLOSED) [[ "$reason" != "pr_merged" ]] && { printf 'pr_closed_unmerged\n'; return 0; } ;;
  esac
  printf '%s\n' "$reason"
}

wavemill_terminal_hook_state() {
  case "$1" in
    recovery_failure|challenge_invalid) printf 'error\n' ;;
    *) printf 'idle\n' ;;
  esac
}

wavemill_terminal_detail() {
  local reason="$1" pr_number="${2:-}"
  case "$reason" in
    review_complete|pr_opened) printf 'PR #%s created' "$pr_number" ;;
    ready_complete) printf 'Ready checks completed%s' "${pr_number:+ for PR #$pr_number}" ;;
    pr_merged) printf 'PR #%s merged' "$pr_number" ;;
    pr_closed_unmerged) printf 'PR #%s closed without merge' "$pr_number" ;;
    challenge_resolved_winner) printf 'Challenge resolved with winner' ;;
    challenge_invalid) printf 'Challenge marked invalid' ;;
    challenge_no_comparison) printf 'Challenge closed without comparison' ;;
    operator_abort) printf 'Workflow aborted by operator' ;;
    recovery_failure) printf 'Recovery failed' ;;
    *) printf '%s' "$reason" ;;
  esac
}

wavemill_terminal_phase_for_reason() {
  case "$1" in
    review_complete|pr_opened|ready_complete) printf 'ready\n' ;;
    pr_merged) printf 'done\n' ;;
    pr_closed_unmerged|challenge_resolved_winner|challenge_invalid|challenge_no_comparison) printf 'closed\n' ;;
    operator_abort) printf 'aborted\n' ;;
    recovery_failure) printf 'error\n' ;;
  esac
}

wavemill_terminal_status_for_reason() {
  case "$1" in
    pr_merged) printf 'merged\n' ;;
    pr_closed_unmerged|challenge_resolved_winner|challenge_invalid|challenge_no_comparison) printf 'closed\n' ;;
    operator_abort) printf 'aborted\n' ;;
    recovery_failure) printf 'error\n' ;;
    *) printf '' ;;
  esac
}

wavemill_terminal_workflow_outcome_for_reason() {
  case "$1" in
    pr_merged) printf 'merged\n' ;;
    pr_closed_unmerged|challenge_resolved_winner|challenge_invalid|challenge_no_comparison) printf 'closed\n' ;;
    operator_abort) printf 'aborted\n' ;;
    recovery_failure) printf 'error\n' ;;
    *) printf 'active\n' ;;
  esac
}

wavemill_terminal_stage_for_reason() {
  case "$1" in
    review_complete|pr_opened) printf 'review\n' ;;
    ready_complete|pr_merged|pr_closed_unmerged|challenge_resolved_winner|challenge_invalid|challenge_no_comparison) printf 'ready\n' ;;
    operator_abort|recovery_failure) printf '%s\n' "${CURRENT_PHASE:-${WAVEMILL_PHASE:-coding}}" ;;
  esac
}

wavemill_terminal_stage_status_for_reason() {
  case "$1" in
    operator_abort) printf 'aborted\n' ;;
    recovery_failure|challenge_invalid) printf 'failed\n' ;;
    *) printf 'completed\n' ;;
  esac
}

wavemill_terminal_marker_value() {
  local issue="$1" reason="$2" pr_number="${3:-}" pr_json="${4:-null}" now
  now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  jq -cn --arg issue "$issue" --arg reason "$reason" --arg pr "$pr_number" --arg appliedAt "$now" --argjson prJson "$pr_json" \
    '{issue:$issue, reason:$reason, prNumber:(if $pr == "" then null else $pr end), appliedAt:$appliedAt, stateApplied:true, stageApplied:false, hookApplied:false, paneMetadataApplied:false, paneApplied:false, linearApplied:false, pr:$prJson}'
}

wavemill_terminal_marker_field() {
  local issue="$1" key="$2" field="$3"
  [[ -n "${STATE_FILE:-}" && -r "${STATE_FILE:-}" ]] || return 0
  jq -r --arg issue "$issue" --arg key "$key" --arg field "$field" \
    '.tasks[$issue].terminalReconciliations[$key][$field] // empty' "$STATE_FILE" 2>/dev/null || true
}

wavemill_terminal_mark_field() {
  local issue="$1" key="$2" field="$3" value="${4:-true}"
  [[ -n "${STATE_FILE:-}" && -f "${STATE_FILE:-}" ]] || return 0
  state_mutate "$STATE_FILE" \
    '.tasks[$issue].terminalReconciliations[$key][$field] = $value
     | .tasks[$issue].terminalReconciliations[$key].updatedAt = (now | todateiso8601)
     | .tasks[$issue].updated = (now | todateiso8601)' \
    --arg issue "$issue" --arg key "$key" --arg field "$field" --argjson value "$value" >/dev/null || true
}

wavemill_terminal_apply_state() {
  local issue="$1" reason="$2" pr_number="${3:-}" marker_json="$4" key phase status workflow_outcome pr_payload
  key="$(wavemill_terminal_marker_key "$reason" "$pr_number")"
  phase="$(wavemill_terminal_phase_for_reason "$reason")"
  status="$(wavemill_terminal_status_for_reason "$reason")"
  workflow_outcome="$(wavemill_terminal_workflow_outcome_for_reason "$reason")"
  pr_payload="$(jq -c '.pr // null' <<<"$marker_json" 2>/dev/null || printf 'null')"
  [[ -n "${STATE_FILE:-}" && -f "${STATE_FILE:-}" ]] || return 0
  state_mutate "$STATE_FILE" '
    (.tasks[$issue].terminalReconciliations[$key] // null) as $existing
    | if $existing == null then .tasks[$issue].terminalReconciliations[$key] = $marker else . end
    | if $phase != "" then .tasks[$issue].phase = $phase else . end
    | if $status != "" then .tasks[$issue].status = $status else . end
    | if $pr != "" then .tasks[$issue].pr = $pr else . end
    | (.tasks[$issue].lifecycle // {}) as $l
    | ($l.resourceDisposition // "") as $existingDisposition
    | .tasks[$issue].lifecycle = ($l + {
        schemaVersion: 1,
        workflowOutcome: $workflowOutcome,
        resourceDisposition: (
          if $workflowOutcome == "active" then
            (if ($existingDisposition | IN("allocated","released","retained","reaping","reaped","verification-required")) then $existingDisposition
             elif (.tasks[$issue].paneState // "") == "released" then "released"
             else "allocated"
             end)
          elif ($existingDisposition | IN("released","retained","reaping","reaped","verification-required")) then $existingDisposition
          else "verification-required"
          end
        )
      })
    | if $workflowOutcome != "active" and ((.tasks[$issue].lifecycle.retention.reason // "") == "") then
        .tasks[$issue].lifecycle.retention = {
          reason: "terminal-reconciliation-resource-verification-required",
          policy: "manual-verification-required",
          actor: "terminal-reconciler",
          timestamp: (now | todateiso8601),
          evidence: {terminalReason: $reason, prNumber: (if $pr == "" then null else $pr end)}
        }
      else .
      end
    | if $pr != "" then .tasks[$issue].lifecycle.deliveryEvidence.prNumber = $pr else . end
    | if ($prJson | type) == "object" then
        .tasks[$issue].lifecycle.deliveryEvidence.prState = ($prJson.terminalState // $prJson.state // .tasks[$issue].lifecycle.deliveryEvidence.prState // "")
        | .tasks[$issue].lifecycle.deliveryEvidence.prBaseBranch = ($prJson.baseRefName // .tasks[$issue].lifecycle.deliveryEvidence.prBaseBranch // "")
        | .tasks[$issue].lifecycle.deliveryEvidence.mergeSha = ($prJson.mergeCommit.oid // $prJson.mergeCommitOid // .tasks[$issue].lifecycle.deliveryEvidence.mergeSha // "")
      else .
      end
    | .tasks[$issue].updated = (now | todateiso8601)
  ' --arg issue "$issue" --arg key "$key" --arg phase "$phase" --arg status "$status" --arg pr "$pr_number" \
    --arg reason "$reason" --arg workflowOutcome "$workflow_outcome" --argjson marker "$marker_json" --argjson prJson "$pr_payload"
}

wavemill_terminalize_hook_for_issue() {
  local session="$1" issue="$2" reason="$3" pr_number="${4:-}" feature_dir hook_protocol hook_state detail agent
  hook_protocol="${WAVEMILL_HOOK_PROTOCOL:-${LIB_DIR:-${REPO_DIR:-}/shared/lib}/../hooks/wavemill-hook-protocol.sh}"
  [[ -f "$hook_protocol" ]] || hook_protocol="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)/hooks/wavemill-hook-protocol.sh"
  [[ -f "$hook_protocol" ]] || return 0
  # shellcheck source=../hooks/wavemill-hook-protocol.sh
  source "$hook_protocol" || return 0
  feature_dir="$(wavemill_terminal_feature_dir "$issue" 2>/dev/null || true)"
  hook_state="$(wavemill_terminal_hook_state "$reason")"
  detail="$(wavemill_terminal_detail "$reason" "$pr_number")"
  agent="${CURRENT_AGENT:-${AGENT_CMD:-wavemill}}"
  WAVEMILL_SESSION="$session" WAVEMILL_ISSUE="$issue" WAVEMILL_FEATURE_DIR="$feature_dir" \
    wavemill_hook_terminalize "$hook_state" "$reason" "$detail" "$agent" || true
}

wavemill_reconcile_pane_terminal() {
  local session="$1" issue="$2" reason="$3" slug="" target="" win=""
  if [[ -n "${STATE_FILE:-}" && -r "${STATE_FILE:-}" ]]; then
    slug="$(jq -r --arg issue "$issue" '.tasks[$issue].slug // empty' "$STATE_FILE" 2>/dev/null || true)"
    target="$(jq -r --arg issue "$issue" '.tasks[$issue].windowId // empty' "$STATE_FILE" 2>/dev/null || true)"
  fi
  [[ -n "$slug" ]] || slug="${SLUG:-}"
  win="$issue-$slug"
  [[ -n "$target" ]] || target="$session:$win"
  declare -F set_window_attention_state >/dev/null 2>&1 && [[ -n "$slug" ]] && set_window_attention_state "$win" "clear" || true
  declare -F wavemill_apply_window_metadata >/dev/null 2>&1 && wavemill_apply_window_metadata "$session" "$issue" "$target" "${STATE_FILE:-}" >/dev/null 2>&1 || true
  command -v tmux >/dev/null 2>&1 && tmux select-pane -t "$target" -T "$(wavemill_terminal_detail "$reason")" >/dev/null 2>&1 || true
  return 0
}

wavemill_terminal_linear_status() {
  local issue="$1" reason="$2" sibling_pr="" sibling_state=""
  case "$reason" in
    pr_merged) printf 'Done\n' ;;
    pr_closed_unmerged)
      if declare -F is_challenge_task >/dev/null 2>&1 && is_challenge_task "$issue"; then
        declare -F check_challenge_sibling_merged >/dev/null 2>&1 && check_challenge_sibling_merged "$issue" && { printf 'Done\n'; return 0; }
        declare -F get_challenge_sibling_pr >/dev/null 2>&1 && sibling_pr="$(get_challenge_sibling_pr "$issue" 2>/dev/null || true)"
        [[ -n "$sibling_pr" ]] && declare -F pr_state >/dev/null 2>&1 && sibling_state="$(pr_state "$sibling_pr" 2>/dev/null || true)"
        [[ "$sibling_state" == "CLOSED" ]] || return 1
      fi
      printf 'Backlog\n'
      ;;
    challenge_invalid|challenge_no_comparison|operator_abort|recovery_failure) printf 'Backlog\n' ;;
    challenge_resolved_winner) printf 'Done\n' ;;
    *) return 1 ;;
  esac
}

wavemill_reconcile_terminal_linear() {
  local issue="$1" reason="$2" status="" linear_issue=""
  declare -F linear_set_state >/dev/null 2>&1 || return 0
  declare -F should_update_linear_state >/dev/null 2>&1 && ! should_update_linear_state "$issue" && return 0
  status="$(wavemill_terminal_linear_status "$issue" "$reason" 2>/dev/null || true)"
  [[ -n "$status" ]] || return 3
  declare -F get_linear_issue_id >/dev/null 2>&1 && linear_issue="$(get_linear_issue_id "$issue")" || linear_issue="$issue"
  linear_set_state "$linear_issue" "$status"
}

wavemill_reconcile_terminal() {
  local session="$1" issue="$2" reason="$3" pr_number="${4:-}" pr_json="" effective_reason key marker_json linear_rc
  local feature_dir stage stage_status agent model notes artifacts existing_artifacts

  wavemill_terminal_reason_valid "$reason" || return 2
  if [[ -n "$pr_number" ]]; then
    pr_json="$(wavemill_pr_live_state "$pr_number" 2>/dev/null || true)"
    if [[ -z "$pr_json" ]]; then
      declare -F log_warn >/dev/null 2>&1 && log_warn "$issue terminal reconciliation deferred: could not read PR #$pr_number"
      return 1
    fi
  fi
  effective_reason="$(wavemill_terminal_effective_reason "$reason" "${pr_json:-}")"
  key="$(wavemill_terminal_marker_key "$effective_reason" "$pr_number")"
  marker_json="$(wavemill_terminal_marker_value "$issue" "$effective_reason" "$pr_number" "${pr_json:-null}")"
  wavemill_terminal_apply_state "$issue" "$effective_reason" "$pr_number" "$marker_json" || return 1

  feature_dir="$(wavemill_terminal_feature_dir "$issue" 2>/dev/null || true)"
  stage="$(wavemill_terminal_stage_for_reason "$effective_reason")"
  stage_status="$(wavemill_terminal_stage_status_for_reason "$effective_reason")"
  if [[ "$(wavemill_terminal_marker_field "$issue" "$key" "stageApplied")" != "true" ]] \
    && [[ -n "$feature_dir" && -n "$stage" ]] \
    && declare -F write_stage_result >/dev/null 2>&1; then
    agent="${CURRENT_AGENT:-${AGENT_CMD:-wavemill}}"
    model=""
    declare -F resolve_stage_result_model >/dev/null 2>&1 && model="$(resolve_stage_result_model "$feature_dir" "$stage" "" 2>/dev/null || true)"
    notes="$(wavemill_terminal_detail "$effective_reason" "$pr_number")"
    # Preserve any artifacts the stage agent already recorded (verdict, exitCode,
    # iterations, blockerCount). write_stage_result replaces the file wholesale, so
    # a thin terminal blob here would destroy the evidence the ready gate reads.
    existing_artifacts="{}"
    if [[ -f "$feature_dir/.${stage}-result.json" ]]; then
      existing_artifacts="$(jq -c 'if (.artifacts | type) == "object" then .artifacts else {} end' "$feature_dir/.${stage}-result.json" 2>/dev/null || printf '{}')"
    fi
    [[ -n "$existing_artifacts" ]] || existing_artifacts="{}"
    artifacts="$(jq -cn --argjson existing "$existing_artifacts" --arg type "$stage" --arg reason "$effective_reason" --arg pr "$pr_number" \
      '$existing + {type:$type, terminalReason:$reason} + (if $pr == "" then {} else {prNumber:($pr|tonumber)} end)' 2>/dev/null || true)"
    write_stage_result "$feature_dir" "$stage" "$stage_status" "$agent" "$model" "$notes" "$artifacts" || true
    wavemill_terminal_mark_field "$issue" "$key" "stageApplied" true
  fi

  if [[ "$(wavemill_terminal_marker_field "$issue" "$key" "hookApplied")" != "true" ]]; then
    wavemill_terminalize_hook_for_issue "$session" "$issue" "$effective_reason" "$pr_number"
    wavemill_terminal_mark_field "$issue" "$key" "hookApplied" true
  fi
  if [[ "$(wavemill_terminal_marker_field "$issue" "$key" "paneMetadataApplied")" != "true" ]] \
    && [[ "$(wavemill_terminal_marker_field "$issue" "$key" "paneApplied")" != "true" ]]; then
    wavemill_reconcile_pane_terminal "$session" "$issue" "$effective_reason"
    wavemill_terminal_mark_field "$issue" "$key" "paneMetadataApplied" true
    wavemill_terminal_mark_field "$issue" "$key" "paneApplied" true
  fi
  if [[ "$(wavemill_terminal_marker_field "$issue" "$key" "linearApplied")" != "true" ]]; then
    linear_rc=0
    wavemill_reconcile_terminal_linear "$issue" "$effective_reason" || linear_rc=$?
    if [[ "$linear_rc" -eq 0 ]]; then
      wavemill_terminal_mark_field "$issue" "$key" "linearApplied" true
    elif [[ "$linear_rc" -ne 3 ]]; then
      return "$linear_rc"
    fi
  fi
}
