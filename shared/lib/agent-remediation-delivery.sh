#!/usr/bin/env bash
# Agent remediation delivery helper (HOK-2890).
# Extracted from notify_planning_rejection_agent to provide a shared delivery
# seam for both planning rejections and review-gate remediations.
#
# Responsibilities:
# - Resolve pane target
# - Short-circuit on dead/idle pane
# - Deliver message via wavemill_pane_send_message
# - Record delivery metadata on artifact
# - Escalate to blocked hook on delivery failure
# - Write condition-keyed attention marker with --expires-on

# agent_remediation_deliver <feature_dir> <issue> <artifact_path> <message> <dedup_key> [--expires-on <triggers>]
#
# Args:
#   feature_dir:    Feature directory path
#   issue:          Linear issue ID (e.g., HOK-2890)
#   artifact_path:  Path to artifact file (e.g., .planning-rejected.json or .review-gate-remediation.json)
#   message:        Human-readable message to send to agent pane
#   dedup_key:      Unique key for deduplication (e.g., review-artifact-identity)
#   --expires-on:   Optional condition-reconciler expiry triggers (default: head,operator-event)

agent_remediation_deliver() {
  local feature_dir="$1" issue="$2" artifact_path="$3" message="$4" dedup_key="$5"
  shift 5
  local expires_on="head,operator-event"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --expires-on) expires_on="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  local slug target notified status signal attempts detail now_iso win state_dir

  [[ -n "${SESSION:-}" && -n "$issue" ]] || return 0

  # Resolve state directory and window
  state_dir="$(dirname "$artifact_path")"
  win="${WAVEMILL_WINDOW:-}"
  [[ -n "$win" ]] || return 0

  # Check deduplication: have we already notified for this dedup key?
  # The write side uses jq variable substitution (`.deliveredKeys[$dedupKey]`),
  # so the read must do the same — `.deliveredKeys."$k"` is literal field
  # access and would never match.
  notified=$(jq -r --arg dedupKey "$dedup_key" \
    '.deliveredKeys[$dedupKey] // empty' "$artifact_path" 2>/dev/null || true)
  [[ -z "$notified" ]] || return 0

  slug="$(basename "$feature_dir")"
  if [[ "$win" =~ $TASK_IDENTITY_WINDOW_PREFIX_RE ]]; then
    local expected_worktree=""
    [[ -n "${WORKTREE_ROOT:-}" ]] && expected_worktree="${WORKTREE_ROOT}/${slug}"
    target="$(_tmux_task_window_target "$SESSION" "$issue" "$slug" "${STATE_FILE:-}" "$expected_worktree" 2>/dev/null || true)"
  fi
  [[ -n "$target" ]] || target="$win"
  target="$(_tmux_target_join "$SESSION" "$target" 2>/dev/null || printf '%s:%s\n' "$SESSION" "$target")"

  if command -v _pane_is_dead_or_idle >/dev/null 2>&1 && _pane_is_dead_or_idle "$target"; then
    return 0
  fi

  if [[ "$(tmux list-panes -t "$target" -F '#{pane_dead}' 2>/dev/null | head -1)" == "1" ]]; then
    return 0
  fi

  now_iso="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  # Attempt delivery
  if wavemill_pane_send_message "$target" "$message" "$issue" "$SESSION"; then
    status="${WAVEMILL_PANE_MESSAGE_LAST_STATUS:-delivered}"
    signal="${WAVEMILL_PANE_MESSAGE_LAST_SIGNAL:-none}"
    attempts="${WAVEMILL_PANE_MESSAGE_LAST_ATTEMPTS:-1}"
    detail="${WAVEMILL_PANE_MESSAGE_LAST_DETAIL:-}"

    # Record successful delivery on the artifact with dedup key.
    # `.deliveredKeys[$dedupKey]` uses jq variable substitution so the written
    # key is the resolved value, not a literal `$dedupKey` field.
    state_mutate "$artifact_path" \
      ".deliveredAt = \$deliveredAt | .deliveryStatus = \$deliveryStatus | .deliverySignal = \$deliverySignal | .deliveryDetail = \$deliveryDetail | .deliveryTarget = \$deliveryTarget | .deliveryAttempts = \$deliveryAttempts | .deliveredKeys[\$dedupKey] = \$deliveredAt" \
      --arg deliveredAt "$now_iso" \
      --arg deliveryStatus "$status" \
      --arg deliverySignal "$signal" \
      --arg deliveryDetail "$detail" \
      --arg deliveryTarget "$target" \
      --argjson deliveryAttempts "$attempts" \
      --arg dedupKey "$dedup_key" \
      2>/dev/null || true

    # Write condition-keyed attention marker (expires on specified triggers).
    # The HEAD comes from the task worktree, resolved from WORKTREE_ROOT/<slug>
    # when available (feature_dir only locates the state tree, not a git repo).
    local worktree_root="${WORKTREE_ROOT:-}"
    local worktree_path=""
    if [[ -n "$worktree_root" && -n "$slug" ]]; then
      worktree_path="${worktree_root}/${slug}"
    fi
    local attention_head=""
    if [[ -n "$worktree_path" ]] && git -C "$worktree_path" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      attention_head=$(git -C "$worktree_path" rev-parse HEAD 2>/dev/null || echo "")
    fi
    write_ready_attention_file "$state_dir" "Remediation action sent to agent: $message" \
      --head "$attention_head" \
      --expires-on "$expires_on" --review-artifact || true

    return 0
  fi

  # Delivery failed after retries
  status="${WAVEMILL_PANE_MESSAGE_LAST_STATUS:-unconfirmed}"
  signal="${WAVEMILL_PANE_MESSAGE_LAST_SIGNAL:-none}"
  attempts="${WAVEMILL_PANE_MESSAGE_LAST_ATTEMPTS:-0}"
  detail="${WAVEMILL_PANE_MESSAGE_LAST_DETAIL:-delivery not confirmed}"

  log_warn "$issue: failed to deliver remediation to agent pane ($status after $attempts attempts): $detail"

  # Record failed delivery attempt
  state_mutate "$artifact_path" \
    ".deliveryStatus = \$deliveryStatus | .deliverySignal = \$deliverySignal | .deliveryDetail = \$deliveryDetail | .deliveryTarget = \$deliveryTarget | .deliveryLastAttemptAt = \$deliveryLastAttemptAt | .deliveryAttempts = \$deliveryAttempts" \
    --arg deliveryStatus "$status" \
    --arg deliverySignal "$signal" \
    --arg deliveryDetail "$detail" \
    --arg deliveryTarget "$target" \
    --arg deliveryLastAttemptAt "$now_iso" \
    --argjson deliveryAttempts "$attempts" \
    2>/dev/null || true

  # Escalate to blocked hook so operator can intervene. The agent kind is
  # read from the hook file if available (the caller does not pass it in);
  # fall back to the issue id so the blocked hook is at least attributable.
  local hook_protocol="$LIB_DIR/../hooks/wavemill-hook-protocol.sh"
  if [[ -f "$hook_protocol" ]]; then
    # shellcheck disable=SC1090
    source "$hook_protocol" || true
    if declare -F wavemill_hook_write >/dev/null 2>&1; then
      local hook_file="/tmp/wavemill-${SESSION}-${issue}.hook"
      local agent_kind=""
      if [[ -f "$hook_file" ]] && command -v jq >/dev/null 2>&1; then
        agent_kind=$(jq -r '.agent // .agentRecord.agent // empty' "$hook_file" 2>/dev/null || echo "")
      fi
      [[ -n "$agent_kind" ]] || agent_kind="unknown"
      local next_action="Press Enter in tmux window $target to acknowledge the pending remediation notice, or relay it manually."
      WAVEMILL_SESSION="$SESSION" WAVEMILL_ISSUE="$issue" \
        wavemill_hook_write "blocked" "remediation_delivery_failed" \
          "remediation notice $status after $attempts attempts: $detail" \
          "$agent_kind" \
          "$next_action" "monitor" || true
    fi
  fi

  return 0
}
