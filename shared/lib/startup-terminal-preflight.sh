#!/usr/bin/env bash
# Startup terminal-state reconciliation before task rehydration.

WAVEMILL_STARTUP_PREFLIGHT_LOADED=1

startup_preflight_enabled() {
  case "${WAVEMILL_STARTUP_TERMINAL_PREFLIGHT:-}" in
    0|false|no|off)
      printf 'false\n'
      return 0
      ;;
  esac

  local repo_dir="${REPO_DIR:-}"
  local user_config="$HOME/.wavemill/config.json"
  local repo_config="$repo_dir/.wavemill-config.json"
  local local_config="$repo_dir/.wavemill-config.local.json"
  local user_json='{}' repo_json='{}' local_json='{}'
  [[ -f "$user_config" ]] && user_json=$(cat "$user_config" 2>/dev/null || echo '{}')
  [[ -f "$repo_config" ]] && repo_json=$(cat "$repo_config" 2>/dev/null || echo '{}')
  [[ -f "$local_config" ]] && local_json=$(cat "$local_config" 2>/dev/null || echo '{}')

  jq -nr \
    --argjson user "$user_json" \
    --argjson repo "$repo_json" \
    --argjson local "$local_json" \
    '({startup:{terminalPreflight:{enabled:true}}} * $user * $repo * $local).startup.terminalPreflight.enabled
     | if . == false then "false" else "true" end' 2>/dev/null || printf 'true\n'
}

startup_terminal_reason_from_task_json() {
  local task_json="$1"
  local status phase outcome reason key
  status="$(jq -r '.status // empty' <<<"$task_json" 2>/dev/null || true)"
  phase="$(jq -r '.phase // empty' <<<"$task_json" 2>/dev/null || true)"
  outcome="$(jq -r "$(task_lifecycle_jq_filter '. | wm_workflow_outcome')" <<<"$task_json" 2>/dev/null || true)"

  key="$(jq -r '
    (.terminalReconciliations // {})
    | to_entries[]
    | (.key | split(":")[0]) as $reason
    | select($reason | IN("pr_merged","pr_closed_unmerged","challenge_resolved_winner","challenge_invalid","challenge_no_comparison","operator_abort","recovery_failure"))
    | .key
  ' <<<"$task_json" 2>/dev/null | head -n1 || true)"
  if [[ -n "$key" ]]; then
    reason="${key%%:*}"
    printf '%s\n' "$reason"
    return 0
  fi

  case "$status:$phase:$outcome" in
    superseded:*|*:superseded:*|*:*:closed)
      if [[ "$status" == "superseded" || "$phase" == "superseded" ]]; then
        printf 'challenge_resolved_winner\n'
      else
        printf 'pr_closed_unmerged\n'
      fi
      return 0
      ;;
    merged:*|*:done:*|*:*:merged)
      printf 'pr_merged\n'
      return 0
      ;;
    aborted:*|*:aborted:*|*:*:aborted)
      printf 'operator_abort\n'
      return 0
      ;;
    error:*|*:error:*|*:*:error)
      printf 'recovery_failure\n'
      return 0
      ;;
  esac

  return 1
}

startup_task_eligibility() {
  local issue="$1"
  local task_json pr worktree phase slug reason deferred_reason=""
  [[ -n "${STATE_FILE:-}" && -r "$STATE_FILE" ]] || { printf 'verification-required:state_unreadable\n'; return 0; }
  if ! task_json="$(jq -c --arg issue "$issue" '.tasks[$issue] // empty' "$STATE_FILE" 2>/dev/null)" || [[ -z "$task_json" ]]; then
    printf 'verification-required:missing_task_state\n'
    return 0
  fi

  if reason="$(startup_terminal_reason_from_task_json "$task_json" 2>/dev/null)"; then
    printf 'terminal:%s\n' "$reason"
    return 0
  fi

  pr="$(jq -r '.pr // .lifecycle.deliveryEvidence.prNumber // empty' <<<"$task_json" 2>/dev/null || true)"
  worktree="$(jq -r '.worktree // empty' <<<"$task_json" 2>/dev/null || true)"
  phase="$(jq -r '.phase // empty' <<<"$task_json" 2>/dev/null || true)"
  slug="$(jq -r '.slug // empty' <<<"$task_json" 2>/dev/null || true)"

  if [[ -n "$pr" ]]; then
    if wavemill_fetch_pr_terminal_evidence "$pr"; then
      case "${WAVEMILL_PR_EVIDENCE_STATE:-}" in
        MERGED)
          printf 'terminal:pr_merged\n'
          return 0
          ;;
        CLOSED)
          if [[ -z "${WAVEMILL_PR_EVIDENCE_MERGED_AT:-}" ]]; then
            printf 'terminal:pr_closed_unmerged\n'
            return 0
          fi
          ;;
      esac
    else
      deferred_reason="pr_state_unverifiable"
    fi
  fi

  if is_challenge_task "$issue" 2>/dev/null && check_challenge_sibling_merged "$issue" 2>/dev/null; then
    printf 'terminal:challenge_resolved_winner\n'
    return 0
  fi

  if [[ -z "$phase" ]]; then
    printf 'verification-required:missing_phase\n'
    return 0
  fi
  if [[ -z "$slug" ]]; then
    printf 'verification-required:missing_slug\n'
    return 0
  fi
  if [[ -z "$worktree" || ! -d "$worktree" ]]; then
    if [[ -n "$deferred_reason" ]]; then
      printf 'verification-required:missing_worktree_and_pr_unverifiable\n'
    else
      printf 'verification-required:missing_worktree\n'
    fi
    return 0
  fi
  if [[ -n "$deferred_reason" ]]; then
    printf 'deferred:%s\n' "$deferred_reason"
    return 0
  fi

  printf 'eligible\n'
}

startup_stamp_rehydration() {
  local issue="$1" eligibility="$2" reason="${3:-}" actor="${4:-startup-terminal-preflight}"
  [[ -n "${STATE_FILE:-}" && -f "$STATE_FILE" ]] || return 1
  state_mutate "$STATE_FILE" '
    if .tasks[$issue] == null then . else
      .tasks[$issue].rehydration = {
        eligibility: $eligibility,
        reason: (if $reason == "" then null else $reason end),
        checkedAt: (now | todateiso8601),
        runEpoch: $runEpoch,
        actor: $actor
      }
      | .tasks[$issue].updated = (now | todateiso8601)
      | .updated = (now | todateiso8601)
    end' \
    --arg issue "$issue" \
    --arg eligibility "$eligibility" \
    --arg reason "$reason" \
    --arg runEpoch "${WAVEMILL_RUN_EPOCH:-}" \
    --arg actor "$actor" >/dev/null
}

startup_stamp_superseded_reason() {
  local issue="$1" sibling_pr="${2:-}"
  [[ -n "${STATE_FILE:-}" && -f "$STATE_FILE" ]] || return 0
  state_mutate "$STATE_FILE" '
    if .tasks[$issue] == null then . else
      .tasks[$issue].supersededReason = (if $siblingPr == "" then "Challenge resolved with winner" else "Primary already merged as PR #\($siblingPr)" end)
      | .tasks[$issue].supersededAt = (.tasks[$issue].supersededAt // (now | todateiso8601))
      | .tasks[$issue].updated = (now | todateiso8601)
    end' \
    --arg issue "$issue" \
    --arg siblingPr "$sibling_pr" >/dev/null 2>&1 || true
}

startup_preflight_reason_allows_cleanup() {
  case "${1:-}" in
    pr_merged|pr_closed_unmerged|challenge_resolved_winner|challenge_invalid|challenge_no_comparison) return 0 ;;
    *) return 1 ;;
  esac
}

startup_preflight_reconcile_terminal_issue() {
  local session="$1" issue="$2" reason="$3" pr="${4:-}" rc=0
  if [[ "${WAVEMILL_TERMINAL_RECONCILER_LOADED:-0}" != "1" ]]; then
    return 0
  fi
  wavemill_reconcile_terminal "$session" "$issue" "$reason" "$pr" || rc=$?
  if [[ "$rc" -ne 0 && -n "$pr" ]]; then
    rc=0
    wavemill_reconcile_terminal "$session" "$issue" "$reason" "" || rc=$?
  fi
  return "$rc"
}

# HOK-3068: true when the terminal preflight already classified this issue as
# terminal during the current run epoch. The startup stale-task pass consults
# this so a single coordinator (the preflight) owns terminal reconciliation and
# cleanup per epoch, and the stale-task path never independently rediscovers and
# retries the same terminal row with a second round of remote PR/Git/Linear work.
startup_preflight_owns_terminal_row() {
  local issue="$1"
  [[ -n "$issue" ]] || return 1
  [[ -n "${STATE_FILE:-}" && -f "$STATE_FILE" ]] || return 1
  [[ -n "${WAVEMILL_RUN_EPOCH:-}" ]] || return 1
  local eligibility run_epoch
  eligibility="$(jq -r --arg issue "$issue" '.tasks[$issue].rehydration.eligibility // empty' "$STATE_FILE" 2>/dev/null || true)"
  [[ "$eligibility" == "terminal" ]] || return 1
  run_epoch="$(jq -r --arg issue "$issue" '.tasks[$issue].rehydration.runEpoch // empty' "$STATE_FILE" 2>/dev/null || true)"
  [[ "$run_epoch" == "$WAVEMILL_RUN_EPOCH" ]]
}

startup_terminal_preflight() {
  local session="${1:-${SESSION:-wavemill}}"
  [[ "$(startup_preflight_enabled)" == "true" ]] || return 0
  [[ -n "${STATE_FILE:-}" && -r "$STATE_FILE" ]] || return 0

  local issues issue classification eligibility reason pr slug sibling_pr should_attempt
  local terminal_count=0 eligible_count=0 verification_count=0 deferred_count=0 retained_count=0
  local deferred_issues=()
  issues="$(jq -r '(.tasks // {}) | keys[]' "$STATE_FILE" 2>/dev/null || true)"
  [[ -n "$issues" ]] || return 0

  while IFS= read -r issue; do
    [[ -n "$issue" ]] || continue
    classification="$(startup_task_eligibility "$issue")"
    case "$classification" in
      terminal:*)
        reason="${classification#terminal:}"
        pr="$(jq -r --arg issue "$issue" '.tasks[$issue].pr // .tasks[$issue].lifecycle.deliveryEvidence.prNumber // empty' "$STATE_FILE" 2>/dev/null || true)"
        slug="$(jq -r --arg issue "$issue" '.tasks[$issue].slug // empty' "$STATE_FILE" 2>/dev/null || true)"
        startup_stamp_rehydration "$issue" "terminal" "$reason" || true
        if [[ "$reason" == "challenge_resolved_winner" ]]; then
          sibling_pr="$(get_challenge_sibling_pr "$issue" 2>/dev/null || true)"
          startup_stamp_superseded_reason "$issue" "$sibling_pr"
        fi
        # HOK-3068: consult the persisted cleanup-episode fingerprint before any
        # reconcile, remote PR/Git, or worktree work. When the fingerprint is
        # unchanged and the episode is already retained/needs-user, skip the
        # expensive reconcile + cleanup this epoch. Backstage still surfaces the
        # retained row; the resource is preserved untouched.
        should_attempt="attempt"
        if declare -F cleanup_episode_should_attempt >/dev/null 2>&1; then
          should_attempt="$(cleanup_episode_should_attempt "$issue" "$slug" "$reason" "$pr" 2>/dev/null || echo attempt)"
        fi
        if [[ "$should_attempt" == "skip" ]]; then
          retained_count=$((retained_count + 1))
          terminal_count=$((terminal_count + 1))
          continue
        fi
        if startup_preflight_reconcile_terminal_issue "$session" "$issue" "$reason" "$pr"; then
          if startup_preflight_reason_allows_cleanup "$reason"; then
            slug="$(jq -r --arg issue "$issue" '.tasks[$issue].slug // empty' "$STATE_FILE" 2>/dev/null || true)"
            [[ -n "$slug" ]] && cleanup_completed_task "$issue" "$slug" "startup terminal preflight" || true
          fi
        else
          startup_stamp_rehydration "$issue" "deferred" "terminal_reconciliation_unavailable" || true
          deferred_issues+=("$issue")
          deferred_count=$((deferred_count + 1))
          continue
        fi
        terminal_count=$((terminal_count + 1))
        ;;
      verification-required:*)
        reason="${classification#verification-required:}"
        startup_stamp_rehydration "$issue" "verification-required" "$reason" || true
        set_task_lifecycle_disposition "$issue" "" "verification-required" "startup-preflight:${reason}" "startup-terminal-preflight" >/dev/null 2>&1 || true
        verification_count=$((verification_count + 1))
        ;;
      deferred:*)
        reason="${classification#deferred:}"
        startup_stamp_rehydration "$issue" "deferred" "$reason" || true
        deferred_issues+=("$issue")
        deferred_count=$((deferred_count + 1))
        ;;
      eligible)
        startup_stamp_rehydration "$issue" "eligible" "" || true
        eligible_count=$((eligible_count + 1))
        ;;
      *)
        startup_stamp_rehydration "$issue" "verification-required" "classifier_error" || true
        set_task_lifecycle_disposition "$issue" "" "verification-required" "startup-preflight:classifier_error" "startup-terminal-preflight" >/dev/null 2>&1 || true
        verification_count=$((verification_count + 1))
        ;;
    esac
  done <<<"$issues"

  if (( deferred_count > 0 )); then
    local joined
    joined="$(IFS=,; printf '%s' "${deferred_issues[*]}")"
    if declare -F log_warn >/dev/null 2>&1; then
      log_warn "Startup terminal preflight deferred ${deferred_count} task(s) pending PR verification: ${joined}"
    fi
  fi
  # HOK-3068: one bounded aggregate retained-resource summary instead of a
  # per-issue warning pair for each terminal retained row.
  if (( retained_count > 0 )) && declare -F log >/dev/null 2>&1; then
    log "status" "Startup terminal preflight: ${retained_count} retained resource(s) unchanged — see Backstage"
  fi
  if declare -F log >/dev/null 2>&1; then
    log "debug" "Preflight: ${terminal_count} terminal (${retained_count} retained unchanged), ${eligible_count} eligible, ${verification_count} verification-required, ${deferred_count} deferred"
  fi
}
