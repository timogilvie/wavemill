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
  gh pr view "$pr_number" --json number,state,mergedAt,headRefOid,headRefName,baseRefName,mergeCommit --jq \
    '{number, state, mergedAt, headRefOid, headRefName, baseRefName, mergeCommit, terminalState: (if .mergedAt != null then "MERGED" elif .state == "CLOSED" then "CLOSED" else .state end)}' 2>/dev/null
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
    '{issue:$issue, reason:$reason, prNumber:(if $pr == "" then null else $pr end), appliedAt:$appliedAt, stateApplied:true, stageApplied:false, hookApplied:false, paneMetadataApplied:false, paneReleased:false, linearApplied:false, pr:$prJson}'
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
        | .tasks[$issue].lifecycle.deliveryEvidence.prHeadSha = ($prJson.headRefOid // .tasks[$issue].lifecycle.deliveryEvidence.prHeadSha // "")
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

# --- HOK-2952: deterministic terminal pane release ---------------------------
#
# One pane-resource policy for every terminal reason, and one release
# primitive shared by terminal reconciliation (wavemill_reconcile_terminal)
# and completed-task cleanup (cleanup_completed_task). Pane release is
# deliberately independent of git worktree/branch cleanup: retained git work
# stays discoverable through the durable terminal record written before the
# window is killed.

# Feature gate (rollback lever). Default enabled; disable with
# terminal.paneRelease.enabled=false (user -> repo -> local config layering)
# or the WAVEMILL_TERMINAL_PANE_RELEASE=0 env kill-switch. Disabling stops
# automated release only - truthful state fields, archives, and terminal
# records keep being written.
terminal_pane_release_enabled() {
  if [[ "${WAVEMILL_TERMINAL_PANE_RELEASE:-}" == "0" ]]; then
    printf 'false\n'
    return 0
  fi
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
    '({terminal:{paneRelease:{enabled:true}}} * $user * $repo * $local).terminal.paneRelease.enabled
     | if . == false then "false" else "true" end' 2>/dev/null || printf 'true\n'
}

# Pane action terminal reconciliation owns for a reason:
#   release       - workflow is over; archive + record + kill the task window
#   metadata-only - workflow still active (HOK-2937 queue handoff owns any
#                   release), the feature gate is off, or an explicit
#                   operator hold (REQUIRE_CONFIRM on pr_merged) applies
#   retain        - attention states where the pane is the operator's
#                   diagnostic surface
wavemill_terminal_pane_policy_for_reason() {
  local reason="$1" policy
  case "$reason" in
    pr_merged|pr_closed_unmerged|challenge_resolved_winner|challenge_invalid|challenge_no_comparison)
      policy="release" ;;
    review_complete|ready_complete|pr_opened)
      policy="metadata-only" ;;
    operator_abort|recovery_failure)
      policy="retain" ;;
    *)
      policy="metadata-only" ;;
  esac
  if [[ "$policy" == "release" ]]; then
    if [[ "$(terminal_pane_release_enabled)" != "true" ]]; then
      policy="metadata-only"
    elif [[ "$reason" == "pr_merged" && "${REQUIRE_CONFIRM:-false}" == "true" ]]; then
      # "Window stays open for review" contract: explicit operator hold.
      policy="metadata-only"
    fi
  fi
  printf '%s\n' "$policy"
}

# Fresh (TTL < 300s) hook state for an issue. Self-contained equivalent of
# the monitor's fresh_hook_state_for_issue so the reconciler stays sourceable
# without wavemill-monitor.sh; prints nothing when the hook is missing/stale.
wavemill_terminal_fresh_hook_state() {
  local session="$1" issue="$2" hook_file hook_ts now
  hook_file="/tmp/wavemill-${session}-${issue}.hook"
  [[ -f "$hook_file" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  hook_ts=$(jq -r '.timestamp // 0' "$hook_file" 2>/dev/null || echo 0)
  [[ "$hook_ts" =~ ^[0-9]+$ ]] || return 0
  now=$(date +%s)
  (( now - hook_ts < 300 )) || return 0
  jq -r '.state // empty' "$hook_file" 2>/dev/null || true
}

# HOK-2972: proof that the pane's surviving process is an idle agent REPL.
# Only the agent's own Stop hook (state=idle, event=Stop) counts, read with
# the TTL ignored - after stage evidence is terminal, an aged Stop record is
# exactly the evidence that nothing ran since. The record is accepted either
# from the live hook file or from the archived payload that
# wavemill_hook_terminalize preserved in .terminal-history.jsonl before
# overwriting the file with the controller's terminal state. Controller
# writes (event=<terminal reason>) never count as agent idleness, so a task
# whose agent died mid-work (last agent state "working") stays protected.
wavemill_terminal_agent_idle_evidence() {
  local session="$1" issue="$2" hook_file feature_dir history_file last
  command -v jq >/dev/null 2>&1 || return 1
  hook_file="/tmp/wavemill-${session}-${issue}.hook"
  if [[ -f "$hook_file" ]] \
    && [[ "$(jq -r '((.state // "") + ":" + (.event // ""))' "$hook_file" 2>/dev/null)" == "idle:Stop" ]]; then
    return 0
  fi
  feature_dir="$(wavemill_terminal_feature_dir "$issue" 2>/dev/null || true)"
  [[ -n "$feature_dir" ]] || return 1
  history_file="$feature_dir/.terminal-history.jsonl"
  [[ -f "$history_file" ]] || return 1
  last="$(tail -n 1 "$history_file" 2>/dev/null || true)"
  [[ -n "$last" ]] || return 1
  [[ "$(jq -r '((.payload.state // "") + ":" + (.payload.event // ""))' <<<"$last" 2>/dev/null)" == "idle:Stop" ]]
}

# wavemill_release_terminal_pane <session> <issue> [slug] [reason] [pr]
#
# Fault-ordered release: ownership guard -> archive diagnostics -> durable
# terminal record -> kill window -> truthful state. Returns 0 on durable
# release (including a missing/already-dead window with ownership proven);
# returns 1 when blocked, with WAVEMILL_PANE_RELEASE_BLOCK_REASON set.
# Never deletes or modifies git work; disposition stays owned by git truth.
wavemill_release_terminal_pane() {
  local session="$1" issue="$2" slug="${3:-}" reason="${4:-terminal}" pr_number="${5:-}"
  local branch="" wt_dir="" head_sha="" target="" joined_target="" window_exists="false"
  local archive_dir record_path transcript_archived="false" transcript_path=""
  local pane_pid live_rc hook_state released_at reason_slug record_existed="false"
  local wt_present="false"

  WAVEMILL_PANE_RELEASE_BLOCK_REASON=""
  command -v jq >/dev/null 2>&1 || { WAVEMILL_PANE_RELEASE_BLOCK_REASON="jq-missing"; return 1; }
  [[ -n "$session" && -n "$issue" ]] || { WAVEMILL_PANE_RELEASE_BLOCK_REASON="context-missing"; return 1; }

  if [[ -n "${STATE_FILE:-}" && -r "${STATE_FILE:-}" ]]; then
    [[ -n "$slug" ]] || slug="$(jq -r --arg issue "$issue" '.tasks[$issue].slug // empty' "$STATE_FILE" 2>/dev/null || true)"
    branch="$(jq -r --arg issue "$issue" '.tasks[$issue].branch // empty' "$STATE_FILE" 2>/dev/null || true)"
    wt_dir="$(jq -r --arg issue "$issue" '.tasks[$issue].worktree // empty' "$STATE_FILE" 2>/dev/null || true)"
  fi
  [[ -n "$branch" || -z "$slug" ]] || branch="task/${slug}"
  [[ -n "$wt_dir" || -z "$slug" || -z "${WORKTREE_ROOT:-}" ]] || wt_dir="${WORKTREE_ROOT%/}/${slug}"

  # 1. Ownership guard: never kill a pane still owned by an active workflow
  # stage. A missing/already-dead window with ownership proven is idempotent
  # success (the durable record below is still written).
  if command -v tmux >/dev/null 2>&1; then
    target="$(_tmux_task_window_target "$session" "$issue" "$slug" "${STATE_FILE:-}" "$wt_dir" 2>/dev/null || true)"
  fi
  if [[ -z "$target" && -n "${STATE_FILE:-}" && -r "${STATE_FILE:-}" ]] \
    && [[ "$(jq -r --arg issue "$issue" '.tasks[$issue].paneReleased // false' "$STATE_FILE" 2>/dev/null || echo false)" == "true" ]]; then
    return 0
  fi
  if [[ -n "$target" ]]; then
    window_exists="true"
    joined_target="$(_tmux_target_join "$session" "$target" 2>/dev/null || printf '%s' "$target")"
    if declare -F mill_pane_has_live_blocking_process >/dev/null 2>&1; then
      pane_pid="$(tmux list-panes -t "$joined_target" -F '#{pane_pid}' 2>/dev/null | head -n 1 || true)"
      live_rc=0
      mill_pane_has_live_blocking_process "$pane_pid" || live_rc=$?
      if [[ "$live_rc" -eq 0 ]]; then
        # Phase-aware liveness (HOK-2972): a descendant process at an idle
        # prompt after its stage evidence is complete must not block terminal
        # release forever. The agent's own Stop hook recording idle is that
        # proof; anything else (working/stale-working/missing hook) keeps the
        # conservative live-agent-process retention.
        if wavemill_terminal_agent_idle_evidence "$session" "$issue" 2>/dev/null; then
          declare -F log >/dev/null 2>&1 && log "debug" "  $issue pane holds an idle agent REPL (agent Stop recorded); releasing" || true
        else
          WAVEMILL_PANE_RELEASE_BLOCK_REASON="live-agent-process"
          return 1
        fi
      elif [[ "$live_rc" -eq 2 ]]; then
        WAVEMILL_PANE_RELEASE_BLOCK_REASON="liveness-indeterminate"
        return 1
      fi
    fi
  fi
  hook_state="$(wavemill_terminal_fresh_hook_state "$session" "$issue" 2>/dev/null || true)"
  case "$hook_state" in
    working|waiting|approval-needed|blocked)
      WAVEMILL_PANE_RELEASE_BLOCK_REASON="hook-${hook_state}"
      return 1
      ;;
  esac

  # 2. Archive diagnostics before any kill. Failures are logged but never
  # block release (a restart replay may find no tmux server at all).
  reason_slug="$(printf '%s' "$reason" | tr -cs 'A-Za-z0-9_.-' '-')"
  archive_dir="${REPO_DIR:-.}/.wavemill/evals/artifacts/${issue}"
  mkdir -p "$archive_dir" 2>/dev/null || true
  if [[ "$window_exists" == "true" && -d "$archive_dir" ]]; then
    transcript_path="$archive_dir/pane-transcript-${reason_slug}.txt"
    if tmux capture-pane -p -J -S - -t "$joined_target" > "$transcript_path" 2>/dev/null; then
      transcript_archived="true"
    else
      rm -f "$transcript_path" 2>/dev/null || true
      declare -F log_warn >/dev/null 2>&1 && log_warn "  $issue pane transcript capture failed; releasing anyway" || true
    fi
  fi
  local hook_protocol feature_dir=""
  hook_protocol="${WAVEMILL_HOOK_PROTOCOL:-${LIB_DIR:-${REPO_DIR:-}/shared/lib}/../hooks/wavemill-hook-protocol.sh}"
  [[ -f "$hook_protocol" ]] || hook_protocol="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)/hooks/wavemill-hook-protocol.sh"
  if [[ -f "$hook_protocol" ]]; then
    # shellcheck source=../hooks/wavemill-hook-protocol.sh
    source "$hook_protocol" 2>/dev/null || true
    feature_dir="$(wavemill_terminal_feature_dir "$issue" 2>/dev/null || true)"
    if declare -F wavemill_hook_archive_current >/dev/null 2>&1; then
      WAVEMILL_SESSION="$session" WAVEMILL_ISSUE="$issue" WAVEMILL_FEATURE_DIR="$feature_dir" \
        wavemill_hook_archive_current "$session" "$issue" "pane-release-${reason_slug}" || true
    fi
  fi

  # 3. Durable terminal record, written atomically BEFORE the kill: the
  # recovery pointer for retained git work once the pane is gone. Unchanged
  # head/reason skips the rewrite so repeat passes stay no-ops.
  record_path="$archive_dir/terminal-record.json"
  [[ -n "$wt_dir" && -d "$wt_dir" ]] && wt_present="true"
  [[ "$wt_present" == "true" ]] && head_sha="$(git -C "$wt_dir" rev-parse HEAD 2>/dev/null || true)"
  released_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  if [[ -f "$record_path" ]] \
    && [[ "$(jq -r '.reason // empty' "$record_path" 2>/dev/null)" == "$reason" ]] \
    && [[ "$(jq -r '.headSha // empty' "$record_path" 2>/dev/null)" == "$head_sha" ]]; then
    record_existed="true"
  else
    local tmp_record="${record_path}.tmp.$$"
    if ! jq -cn \
      --arg issue "$issue" --arg slug "$slug" --arg session "$session" \
      --arg reason "$reason" --arg pr "$pr_number" --arg branch "$branch" \
      --arg worktree "$wt_dir" --arg headSha "$head_sha" --arg windowTarget "$target" \
      --arg releasedAt "$released_at" --arg repoDir "${REPO_DIR:-}" \
      --argjson transcriptArchived "$transcript_archived" \
      --argjson worktreePresent "$wt_present" \
      '{schemaVersion: 1, issue: $issue,
        slug: (if $slug == "" then null else $slug end),
        session: $session, reason: $reason,
        prNumber: (if $pr == "" then null else $pr end),
        branch: (if $branch == "" then null else $branch end),
        worktree: (if $worktree == "" then null else $worktree end),
        headSha: (if $headSha == "" then null else $headSha end),
        windowTarget: (if $windowTarget == "" then null else $windowTarget end),
        transcriptArchived: $transcriptArchived,
        recovery: {
          worktreePresentAtRelease: $worktreePresent,
          branch: (if $branch == "" then null else $branch end),
          howToRecover: (
            if $branch == "" then "No branch recorded; inspect this archive directory for stage artifacts."
            else ("Retained work (if any) lives on branch " + $branch
              + (if $worktree == "" then "" else " (worktree at release: " + $worktree + ")" end)
              + "; recover with: git -C " + $repoDir + " worktree add <dir> " + $branch)
            end)
        },
        releasedAt: $releasedAt}' > "$tmp_record" 2>/dev/null \
      || ! mv "$tmp_record" "$record_path" 2>/dev/null; then
      rm -f "$tmp_record" 2>/dev/null || true
      WAVEMILL_PANE_RELEASE_BLOCK_REASON="terminal-record-write-failed"
      declare -F log_warn >/dev/null 2>&1 && log_warn "  $issue could not write terminal record; deferring pane release" || true
      return 1
    fi
  fi

  # 4. Kill the window (verified), then drop the hook file - mirrors
  # release_task_pane_window_only.
  if [[ "$window_exists" == "true" ]]; then
    if declare -F wavemill_cleanup_run >/dev/null 2>&1; then
      wavemill_cleanup_run tmux kill-window -t "$joined_target" 2>/dev/null || true
    else
      tmux kill-window -t "$joined_target" 2>/dev/null || true
    fi
    if _tmux_window_target_exists "$session" "$target"; then
      WAVEMILL_PANE_RELEASE_BLOCK_REASON="tmux-window-close-failed"
      # First failure warns; retries (record already durable) log at debug
      # so repeated passes never emit duplicate pane-release errors.
      if [[ "$record_existed" == "true" ]]; then
        declare -F log >/dev/null 2>&1 && log "debug" "  $issue tmux window still present after kill; will retry" || true
      else
        declare -F log_warn >/dev/null 2>&1 && log_warn "  $issue tmux window still present after kill; will retry" || true
      fi
      return 1
    fi
  fi
  rm -f "/tmp/wavemill-${session}-${issue}.hook" 2>/dev/null || true

  # 5. Truthful state: pane fields describe the real state of tmux; the
  # resource disposition stays owned by git-side truth for terminal
  # outcomes (retained/verification-required/reaping/reaped survive).
  if [[ -n "${STATE_FILE:-}" && -f "${STATE_FILE:-}" ]] && declare -F state_mutate >/dev/null 2>&1 \
    && [[ "$(jq -r --arg issue "$issue" '.tasks[$issue] != null' "$STATE_FILE" 2>/dev/null || echo false)" == "true" ]]; then
    state_mutate "$STATE_FILE" '
      (.tasks[$issue].lifecycle // {}) as $l
      | .tasks[$issue].paneState = "released"
      | .tasks[$issue].paneReleased = true
      | .tasks[$issue].paneReleasedAt = $releasedAt
      | .tasks[$issue].terminalRecordWritten = true
      | .tasks[$issue].lifecycle = ($l + {
          schemaVersion: 1,
          workflowOutcome: ($l.workflowOutcome // "active"),
          resourceDisposition: (
            if ($l.workflowOutcome // "active") == "active" and ($l.resourceDisposition // "allocated") == "allocated"
            then "released"
            else ($l.resourceDisposition // "allocated")
            end
          )
        })
      | .tasks[$issue].updated = (now | todateiso8601)
    ' --arg issue "$issue" --arg releasedAt "$released_at" >/dev/null || true
  fi
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
  # Legacy `paneApplied` is read only as "metadata applied" back-compat for
  # existing markers; it is never written for new markers and never treated
  # as evidence of pane release (HOK-2952).
  if [[ "$(wavemill_terminal_marker_field "$issue" "$key" "paneMetadataApplied")" != "true" ]] \
    && [[ "$(wavemill_terminal_marker_field "$issue" "$key" "paneApplied")" != "true" ]]; then
    wavemill_reconcile_pane_terminal "$session" "$issue" "$effective_reason"
    wavemill_terminal_mark_field "$issue" "$key" "paneMetadataApplied" true
  fi
  local pane_policy pane_released
  pane_policy="$(wavemill_terminal_pane_policy_for_reason "$effective_reason")"
  if [[ "$pane_policy" == "release" ]]; then
    pane_released="false"
    if [[ -n "${STATE_FILE:-}" && -r "${STATE_FILE:-}" ]]; then
      pane_released="$(jq -r --arg issue "$issue" '.tasks[$issue].paneReleased // false' "$STATE_FILE" 2>/dev/null || echo false)"
    fi
    if [[ "$pane_released" != "true" ]]; then
      if wavemill_release_terminal_pane "$session" "$issue" "" "$effective_reason" "$pr_number"; then
        wavemill_terminal_mark_field "$issue" "$key" "paneReleased" true
      else
        declare -F log >/dev/null 2>&1 && log "debug" "  $issue terminal pane release deferred (${WAVEMILL_PANE_RELEASE_BLOCK_REASON:-blocked}); will retry" || true
      fi
    fi
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
