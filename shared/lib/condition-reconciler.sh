#!/usr/bin/env bash
# Condition reconciler (HOK-3172)
#
# One reconciler expires every marker whose recorded condition no longer holds.
# Run once per task per monitor tick, before any gate reads markers.
#
# Invariant:
#   1. Every marker records its condition through marker_write / marker_condition_json
#   2. One reconciler expires them (this file)
#   3. Gates never clear markers themselves
#   4. Operator commands record events that the reconciler consumes
#   5. Observations write waiting-on, never verdicts
#
# Expiry triggers (marker opts into a set; default is head,operator-event):
#   head                       — worktree HEAD differs from condition.head
#   operator-event             — .operator-events.jsonl has applicable event with seq > recorded
#   review-artifact            — .review-result.json identity differs and status != running
#   review-artifact-substantive — as review-artifact, and not an infra failure
#   ready-artifact             — same as review-artifact for .ready-result.json
#   remote                     — PR headRefOid differs from observed value
#   waiting-on                 — awaited value now holds
#   deadline                   — now >= recheckAfter

set -euo pipefail

WAVEMILL_CONDITION_RECONCILER_LOADED=1

# _condition_iso_to_epoch <iso-utc>
# Epoch seconds for an ISO-8601 UTC timestamp (fractional seconds allowed), or
# empty when it cannot be parsed. BSD date (macOS, the mill host) needs -u, or
# it reads the trailing Z as a literal and the time as local, which skews every
# comparison by the UTC offset. Callers must treat empty as "unknown" and not
# expire on it.
_condition_iso_to_epoch() {
  local iso="${1%%.*}" epoch=""
  [[ -n "$iso" ]] || return 0
  [[ "$iso" == *Z ]] || iso="${iso}Z"
  epoch=$(date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$iso" +%s 2>/dev/null) || \
    epoch=$(date -u -d "$iso" +%s 2>/dev/null) || epoch=""
  printf '%s' "$epoch"
}

# _condition_pr_head_oid <pr-number>
# headRefOid for a PR from the monitor's PR cache, which is the raw
# `gh pr list --json number,headRefOid,...` array (not an object keyed by PR).
_condition_pr_head_oid() {
  local pr="$1"
  local cache="${MONITOR_PR_CACHE:-/tmp/${SESSION:-wavemill}-pr-cache.json}"
  [[ -n "$pr" && -f "$cache" ]] || return 0
  jq -r --arg pr "$pr" \
    '(if type == "array" then . else [] end)[] | select((.number | tostring) == $pr) | .headRefOid // empty' \
    "$cache" 2>/dev/null | head -n 1
}

# condition_reconcile_task <issue> <wt_dir> <state_dir>
# Evaluates every marker's condition and clears expired ones.
# Always returns 0 (set -e safety).
condition_reconcile_task() {
  local issue="$1"
  local wt_dir="$2"
  local state_dir="$3"

  # Fast path: return early if nothing to reconcile
  local needs_reconcile=false
  if [[ -f "$state_dir/.needs-attention" ]] || \
     [[ -f "$state_dir/.needs-attention-transient" ]] || \
     [[ -f "$state_dir/.ready-waiting-on.json" ]] || \
     compgen -G "$state_dir/.retry-*-exhausted" >/dev/null 2>&1 || \
     compgen -G "$state_dir/.failed-ready-recheck-exhausted" >/dev/null 2>&1; then
    needs_reconcile=true
  fi

  # Check if task status is error
  if [[ "$needs_reconcile" == "false" ]]; then
    local task_status
    task_status=$(jq -r --arg i "$issue" '.tasks[$i].status // empty' "$STATE_FILE" 2>/dev/null || echo "")
    if [[ "$task_status" == "error" ]]; then
      needs_reconcile=true
    fi
  fi

  if [[ "$needs_reconcile" == "false" ]]; then
    return 0
  fi

  # Lazy context (computed only when needed)
  local current_head=""
  local operator_seq=""
  local review_identity=""
  local ready_identity=""
  local pr_head_oid=""
  local pr_number=""

  # Helper to get current head (lazy)
  _get_current_head() {
    if [[ -z "$current_head" ]]; then
      current_head=$(git -C "$wt_dir" rev-parse HEAD 2>/dev/null || echo "")
    fi
    echo "$current_head"
  }

  # Helper to get operator seq (lazy)
  _get_operator_seq() {
    if [[ -z "$operator_seq" ]]; then
      operator_seq=$(operator_event_seq "$state_dir")
    fi
    echo "$operator_seq"
  }

  # Helper to get review identity (lazy)
  _get_review_identity() {
    if [[ -z "$review_identity" ]]; then
      review_identity=$(marker_artifact_identity "$state_dir" "review")
    fi
    echo "$review_identity"
  }

  # Helper to get ready identity (lazy)
  _get_ready_identity() {
    if [[ -z "$ready_identity" ]]; then
      ready_identity=$(marker_artifact_identity "$state_dir" "ready")
    fi
    echo "$ready_identity"
  }

  # Helper to get the task's PR head OID from the PR cache (lazy). The task's
  # PR number lives in `.pr` (`.prNumber` is accepted for older entries).
  _get_pr_head_oid() {
    if [[ -z "$pr_head_oid" && -z "$pr_number" ]]; then
      pr_number=$(jq -r --arg i "$issue" '.tasks[$i].pr // .tasks[$i].prNumber // empty | tostring' "$STATE_FILE" 2>/dev/null || echo "")
      pr_head_oid=$(_condition_pr_head_oid "$pr_number")
    fi
    echo "$pr_head_oid"
  }

  # Helper to check if condition should expire
  _should_expire() {
    local marker_path="$1"
    local condition
    condition=$(marker_condition "$marker_path")

    # No condition = legacy marker, handle separately
    if [[ -z "$condition" ]]; then
      return 1  # Don't expire by default
    fi

    local expires_on
    expires_on=$(jq -r '.expiresOn // [] | join(",")' <<< "$condition" 2>/dev/null || echo "")

    # Check each trigger
    local IFS=','
    for trigger in $expires_on; do
      case "$trigger" in
        head)
          local cond_head
          cond_head=$(jq -r '.head // empty' <<< "$condition" 2>/dev/null || echo "")
          # Only a real SHA is a head condition; a placeholder never matches
          # HEAD and would clear the marker on every tick.
          [[ "$cond_head" =~ ^[0-9a-f]{7,40}$ ]] || cond_head=""
          if [[ -n "$cond_head" && -n "$(_get_current_head)" && "$cond_head" != "$(_get_current_head)" ]]; then
            echo "head:${cond_head}→$(_get_current_head)"
            return 0
          fi
          ;;
        operator-event)
          local cond_seq
          cond_seq=$(jq -r '.operatorEventSeq // 0' <<< "$condition" 2>/dev/null || echo "0")
          if [[ "$(_get_operator_seq)" -gt "$cond_seq" ]]; then
            local latest_event
            latest_event=$(operator_event_latest_since "$state_dir" "$cond_seq")
            if [[ -n "$latest_event" ]]; then
              echo "operator-event:seq ${cond_seq}→$(_get_operator_seq)"
              return 0
            fi
          fi
          ;;
        review-artifact|review-artifact-substantive)
          local cond_review
          cond_review=$(jq -r '.reviewArtifact // null' <<< "$condition" 2>/dev/null || echo "null")
          if [[ "$cond_review" != "null" ]]; then
            local current_review
            current_review=$(_get_review_identity)
            if [[ "$current_review" != "null" ]]; then
              # Check if identity differs
              local cond_started cond_finished current_started current_finished current_status
              cond_started=$(jq -r '.startedAt // empty' <<< "$cond_review" 2>/dev/null || echo "")
              cond_finished=$(jq -r '.finishedAt // empty' <<< "$cond_review" 2>/dev/null || echo "")
              current_started=$(jq -r '.startedAt // empty' <<< "$current_review" 2>/dev/null || echo "")
              current_finished=$(jq -r '.finishedAt // empty' <<< "$current_review" 2>/dev/null || echo "")
              current_status=$(jq -r '.status // empty' <<< "$current_review" 2>/dev/null || echo "")

              if [[ "$current_status" != "running" ]] && \
                 { [[ "$cond_started" != "$current_started" ]] || [[ "$cond_finished" != "$current_finished" ]]; }; then
                # For review-artifact-substantive, check if it's not an infra failure
                if [[ "$trigger" == "review-artifact-substantive" ]]; then
                  # Check if current is substantive (not infra failure)
                  if declare -F review_result_infra_failure >/dev/null 2>&1; then
                    if ! review_result_infra_failure "$state_dir/.review-result.json" 2>/dev/null; then
                      echo "review-artifact-substantive:new substantive verdict"
                      return 0
                    fi
                  fi
                else
                  echo "review-artifact:identity changed"
                  return 0
                fi
              fi
            fi
          fi
          ;;
        ready-artifact)
          local cond_ready
          cond_ready=$(jq -r '.readyArtifact // null' <<< "$condition" 2>/dev/null || echo "null")
          if [[ "$cond_ready" != "null" ]]; then
            local current_ready
            current_ready=$(_get_ready_identity)
            if [[ "$current_ready" != "null" ]]; then
              local cond_started cond_finished current_started current_finished current_status
              cond_started=$(jq -r '.startedAt // empty' <<< "$cond_ready" 2>/dev/null || echo "")
              cond_finished=$(jq -r '.finishedAt // empty' <<< "$cond_ready" 2>/dev/null || echo "")
              current_started=$(jq -r '.startedAt // empty' <<< "$current_ready" 2>/dev/null || echo "")
              current_finished=$(jq -r '.finishedAt // empty' <<< "$current_ready" 2>/dev/null || echo "")
              current_status=$(jq -r '.status // empty' <<< "$current_ready" 2>/dev/null || echo "")

              if [[ "$current_status" != "running" ]] && \
                 { [[ "$cond_started" != "$current_started" ]] || [[ "$cond_finished" != "$current_finished" ]]; }; then
                echo "ready-artifact:identity changed"
                return 0
              fi
            fi
          fi
          ;;
        remote)
          local observed_pr_head
          observed_pr_head=$(jq -r '.observed.prHeadRefOid // empty' <<< "$condition" 2>/dev/null || echo "")
          if [[ -n "$observed_pr_head" ]]; then
            local current_pr_head
            current_pr_head=$(_get_pr_head_oid)
            if [[ -n "$current_pr_head" && "$observed_pr_head" != "$current_pr_head" ]]; then
              echo "remote:PR head moved"
              return 0
            fi
          fi
          ;;
        waiting-on)
          local waiting_kind waiting_value
          waiting_kind=$(jq -r '.waitingOn.kind // empty' <<< "$condition" 2>/dev/null || echo "")
          waiting_value=$(jq -r '.waitingOn.value // empty' <<< "$condition" 2>/dev/null || echo "")
          if [[ "$waiting_kind" == "pr-head" && -n "$waiting_value" ]]; then
            local current_pr_head waiting_pr
            # Prefer the PR recorded with the wait; fall back to the task's PR.
            waiting_pr=$(jq -r '.waitingOn.prNumber // empty | tostring' <<< "$condition" 2>/dev/null || echo "")
            if [[ -n "$waiting_pr" ]]; then
              current_pr_head=$(_condition_pr_head_oid "$waiting_pr")
            else
              current_pr_head=$(_get_pr_head_oid)
            fi
            if [[ -n "$current_pr_head" && "$current_pr_head" == "$waiting_value" ]]; then
              echo "waiting-on:PR head caught up"
              return 0
            fi
          fi
          ;;
        deadline)
          local recheck_after
          recheck_after=$(jq -r '.recheckAfter // empty' <<< "$condition" 2>/dev/null || echo "")
          if [[ -n "$recheck_after" ]]; then
            local deadline_epoch now_epoch
            deadline_epoch=$(_condition_iso_to_epoch "$recheck_after")
            now_epoch=$(date +%s)
            # An unparseable deadline never fires (fail closed).
            if [[ -n "$deadline_epoch" && "$now_epoch" -ge "$deadline_epoch" ]]; then
              echo "deadline:recheck time elapsed"
              return 0
            fi
          fi
          ;;
      esac
    done

    return 1  # No trigger fired
  }

  # Helper to handle legacy markers (no condition block)
  _should_expire_legacy() {
    local marker_path="$1"
    local marker_kind="$2"

    # Legacy JSON .needs-attention: head trigger from headSha
    if [[ "$marker_kind" == "needs-attention" ]]; then
      local marker_sha written_at
      marker_sha=$(marker_head "$marker_path")
      if [[ -n "$marker_sha" && -n "$(_get_current_head)" && "$marker_sha" != "$(_get_current_head)" ]]; then
        echo "legacy-head:${marker_sha}→$(_get_current_head)"
        return 0
      fi

      # operator-event trigger: event at later than writtenAt
      written_at=$(marker_written_at "$marker_path")
      if [[ -n "$written_at" ]]; then
        local latest_event
        latest_event=$(operator_event_latest_since "$state_dir" "0")
        if [[ -n "$latest_event" ]]; then
          local event_at
          event_at=$(jq -r '.at // empty' <<< "$latest_event" 2>/dev/null || echo "")
          if [[ -n "$event_at" && "$event_at" > "$written_at" ]]; then
            echo "legacy-operator-event:event after marker"
            return 0
          fi
        fi
      fi
    fi

    return 1
  }

  # Helper to log a clear
  _log_clear() {
    local marker_name="$1"
    local trigger="$2"
    local detail="$3"

    if declare -F log_task >/dev/null 2>&1; then
      log_task "status" "$issue" "↺ $issue → cleared $marker_name ($trigger: $detail)"
    fi

    # Append to reconcile log
    local reconcile_log="$state_dir/.condition-reconcile.jsonl"
    local log_entry
    log_entry=$(jq -n \
      --arg at "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
      --arg issue "$issue" \
      --arg marker "$marker_name" \
      --arg trigger "$trigger" \
      --arg detail "$detail" \
      '{at: $at, issue: $issue, marker: $marker, trigger: $trigger, detail: $detail}')
    echo "$log_entry" >> "$reconcile_log"
  }

  # Reconcile .needs-attention
  if [[ -f "$state_dir/.needs-attention" ]]; then
    local reason
    if reason=$(_should_expire "$state_dir/.needs-attention"); then
      _log_clear ".needs-attention" "${reason%%:*}" "${reason#*:}"
      marker_clear "$state_dir/.needs-attention"
    elif reason=$(_should_expire_legacy "$state_dir/.needs-attention" "needs-attention"); then
      _log_clear ".needs-attention" "${reason%%:*}" "${reason#*:}"
      marker_clear "$state_dir/.needs-attention"
    fi
  fi

  # Reconcile .needs-attention-transient
  if [[ -f "$state_dir/.needs-attention-transient" ]]; then
    local reason
    if reason=$(_should_expire "$state_dir/.needs-attention-transient"); then
      _log_clear ".needs-attention-transient" "${reason%%:*}" "${reason#*:}"
      marker_clear "$state_dir/.needs-attention-transient"
    fi
  fi

  # Reconcile .ready-waiting-on.json
  if [[ -f "$state_dir/.ready-waiting-on.json" ]]; then
    local reason
    if reason=$(_should_expire "$state_dir/.ready-waiting-on.json"); then
      _log_clear ".ready-waiting-on.json" "${reason%%:*}" "${reason#*:}"
      marker_clear "$state_dir/.ready-waiting-on.json"
    fi
  fi

  # Reconcile .retry-*-exhausted sentinels
  local exhausted_files
  exhausted_files=$(compgen -G "$state_dir/.retry-*-exhausted" 2>/dev/null || true)
  if [[ -n "$exhausted_files" ]]; then
    for sentinel in $exhausted_files; do
      # Derive bucket name from file
      local basename bucket
      basename=$(basename "$sentinel")
      bucket="${basename#.retry-}"
      bucket="${bucket%-exhausted}"

      # Check companion condition
      local companion
      companion=$(bounded_retry_condition_path "$state_dir" "$bucket")

      if [[ -f "$companion" ]]; then
        local reason
        if reason=$(_should_expire "$companion"); then
          _log_clear "$basename" "${reason%%:*}" "${reason#*:}"
          bounded_retry_clear "$state_dir" "$bucket"
        fi
      else
        # Legacy sentinel: check if it's review-infra-recovery with head trigger
        if [[ "$bucket" == "review-infra-recovery" ]]; then
          # Extract head from key file
          local stored_head
          # The bucket key is `<head>:<category>`; compare only the SHA, or
          # the sentinel is cleared every tick even at the same head.
          stored_head=$(bounded_retry_head "$state_dir" "$bucket")
          stored_head="${stored_head%%:*}"
          if [[ -n "$stored_head" && -n "$(_get_current_head)" && "$stored_head" != "$(_get_current_head)" ]]; then
            _log_clear "$basename" "legacy-head" "${stored_head}→$(_get_current_head)"
            bounded_retry_clear "$state_dir" "$bucket"
          fi
        fi
      fi
    done
  fi

  # Reconcile .failed-ready-recheck-exhausted (legacy bucket)
  if [[ -f "$state_dir/.failed-ready-recheck-exhausted" ]]; then
    local companion="$state_dir/.failed-ready-recheck-exhausted-condition.json"

    if [[ -f "$companion" ]]; then
      local reason
      if reason=$(_should_expire "$companion"); then
        _log_clear ".failed-ready-recheck-exhausted" "${reason%%:*}" "${reason#*:}"
        rm -f "$state_dir/.failed-ready-recheck-"* 2>/dev/null || true
      fi
    else
      # Legacy sentinel: pending-ready-recheck with specific reason
      local exhaustion_reason
      exhaustion_reason=$(cat "$state_dir/.failed-ready-recheck-exhausted" 2>/dev/null || echo "")
      if [[ "$exhaustion_reason" == "Review infrastructure recovery is exhausted"* ]]; then
        # Check head trigger
        local stored_head sentinel_mtime
        stored_head=$(bounded_retry_head "$state_dir" "pending-ready-recheck")
        if [[ -n "$stored_head" && -n "$(_get_current_head)" && "$stored_head" != "$(_get_current_head)" ]]; then
          _log_clear ".failed-ready-recheck-exhausted" "legacy-head" "${stored_head}→$(_get_current_head)"
          rm -f "$state_dir/.failed-ready-recheck-"* 2>/dev/null || true
        else
          # Check review-artifact-substantive trigger
          sentinel_mtime=$(stat -f %m "$state_dir/.failed-ready-recheck-exhausted" 2>/dev/null || \
                          stat -c %Y "$state_dir/.failed-ready-recheck-exhausted" 2>/dev/null || echo "0")
          local review_identity
          review_identity=$(_get_review_identity)
          if [[ "$review_identity" != "null" ]]; then
            local review_finished review_finished_epoch
            review_finished=$(jq -r '.finishedAt // empty' <<< "$review_identity" 2>/dev/null || echo "")
            if [[ -n "$review_finished" ]]; then
              review_finished_epoch=$(_condition_iso_to_epoch "$review_finished")
              if [[ -n "$review_finished_epoch" && "$review_finished_epoch" -gt "$sentinel_mtime" ]]; then
                # Check if substantive
                if declare -F review_result_infra_failure >/dev/null 2>&1; then
                  if ! review_result_infra_failure "$state_dir/.review-result.json" 2>/dev/null; then
                    _log_clear ".failed-ready-recheck-exhausted" "legacy-review-substantive" "new substantive verdict"
                    rm -f "$state_dir/.failed-ready-recheck-"* 2>/dev/null || true
                  fi
                fi
              fi
            fi
          fi
        fi
      fi
    fi
  fi

  # Reconcile status=error
  local task_status
  task_status=$(jq -r --arg i "$issue" '.tasks[$i].status // empty' "$STATE_FILE" 2>/dev/null || echo "")
  if [[ "$task_status" == "error" ]]; then
    # Check if there's an applicable operator event
    local status_condition
    status_condition=$(jq -r --arg i "$issue" '.tasks[$i].statusCondition // null' "$STATE_FILE" 2>/dev/null || echo "null")

    local recorded_seq=0
    if [[ "$status_condition" != "null" ]]; then
      recorded_seq=$(jq -r '.operatorEventSeq // 0' <<< "$status_condition" 2>/dev/null || echo "0")
    fi

    # Check for re-review or advance events after recorded seq
    local latest_event
    latest_event=$(operator_event_latest_since "$state_dir" "$recorded_seq" "re-review,advance")

    if [[ -n "$latest_event" ]]; then
      local event_cmd event_seq event_at
      event_cmd=$(jq -r '.command // empty' <<< "$latest_event" 2>/dev/null || echo "")
      event_seq=$(jq -r '.seq // 0' <<< "$latest_event" 2>/dev/null || echo "0")
      event_at=$(jq -r '.at // empty' <<< "$latest_event" 2>/dev/null || echo "")

      # Clear status=error. task_state_mutate_existing takes <issue> <filter>
      # [jq args]; log only once the write has landed, so the audit trail never
      # records a clear that did not happen.
      if declare -F task_state_mutate_existing >/dev/null 2>&1 && \
         task_state_mutate_existing "$issue" \
           '.status = "active" | .statusClearedBy = {command: $cmd, seq: ($seq | tonumber), at: $at} | del(.statusCondition)' \
           --arg cmd "$event_cmd" --arg seq "$event_seq" --arg at "$event_at" >/dev/null 2>&1; then
        _log_clear "status=error" "operator-event" "$event_cmd (seq $event_seq)"
      fi
    fi
  fi

  return 0
}

# reconcile_condition_markers_tick
# Runs condition_reconcile_task for every tracked task.
# Called from monitor main loop after command draining, before ready-watchdog.
reconcile_condition_markers_tick() {
  local issue wt_dir state_dir slug

  for issue in "${!BRANCH_BY_ISSUE[@]}"; do
    # Skip cleaned tasks
    if [[ -n "${CLEANED[$issue]:-}" ]]; then
      continue
    fi

    # Derive worktree and state dir (same as monitor_issue_state)
    slug=$(printf '%s' "${BRANCH_BY_ISSUE[$issue]}" | sed 's|^task/||; s|^bug/||; s|^epic/||')
    wt_dir="${WORKTREE_ROOT}/${slug}"

    if declare -F ready_state_dir >/dev/null 2>&1; then
      state_dir=$(ready_state_dir "$wt_dir" "$slug")
    else
      # Fallback if ready_state_dir is not available
      state_dir="$wt_dir/features/$slug"
    fi

    # Run reconciliation
    condition_reconcile_task "$issue" "$wt_dir" "$state_dir" || true
  done

  return 0
}
