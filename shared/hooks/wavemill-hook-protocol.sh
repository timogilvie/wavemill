#!/usr/bin/env bash
# Shared hook protocol helpers for wavemill agent status tracking.
#
# This library provides reusable functions for agent hooks to report status
# in a standardized format. Hooks are no-ops outside wavemill contexts.

# HOK-3184: optional ledger shadow helper. The helper is sourced defensively
# so standalone/bare agents without a wavemill install silently skip the
# shadow path. The helper itself is a no-op outside wavemill contexts.
_wavemill_hook_proto_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd 2>/dev/null || true)"
if [[ -n "${_wavemill_hook_proto_dir:-}" && -f "${_wavemill_hook_proto_dir}/wavemill-hook-ledger-shadow.sh" ]]; then
  # shellcheck source=wavemill-hook-ledger-shadow.sh
  source "${_wavemill_hook_proto_dir}/wavemill-hook-ledger-shadow.sh" 2>/dev/null || true
fi

# Verify we are running inside a wavemill-launched agent context.
# Hooks must be no-ops outside wavemill to avoid disrupting standalone use.
wavemill_hook_check() {
  [[ -n "${WAVEMILL_SESSION:-}" ]] || exit 0
  [[ -n "${WAVEMILL_ISSUE:-}" ]] || exit 0
  command -v jq >/dev/null 2>&1 || exit 0
}

# HOK-3190: Send USR2 to the monitor process to interrupt poll_sleep and
# make it re-enter its loop body immediately. Marker writers (plan-approved,
# coding-complete, ready-complete, re-review commands) call this so operator
# actions aren't gated on the next POLL_SECONDS boundary.
#
# Mirrors the shape of wavemill_hook_notify (which signals the dashboard
# with USR1). Best-effort: a stale/missing PID is a no-op and never fails.
#
# The monitor PID lives on the tmux session environment as
# WAVEMILL_MONITOR_PID; agent panes export it via write_monitor_env, and
# marker writers that are not in a wavemill-launched pane fall back to
# tmux show-environment (resolved by the caller).
wavemill_monitor_notify() {
  local monitor_pid="${WAVEMILL_MONITOR_PID:-}"
  [[ -n "$monitor_pid" ]] || return 0
  [[ "$monitor_pid" =~ ^[0-9]+$ ]] || return 0
  [[ "$monitor_pid" -eq 0 ]] && return 0
  kill -0 "$monitor_pid" 2>/dev/null || return 0
  kill -USR2 "$monitor_pid" 2>/dev/null || true
  return 0
}

# HOK-3190: touch a lifecycle marker (`.plan-approved`, `.coding-complete`,
# `.review-complete`, `.ready-complete`) AND wake the monitor so the next
# phase launch doesn't wait on the poll tick. Call this from any site that
# would otherwise do `touch "$feature_dir/.X"` or `printf '…' > "$feature_dir/.X"`.
#
# Usage: wavemill_touch_marker <path> [--content <string>]
# A missing --content writes an empty file (touch semantics). The write is
# atomic (tmp + rename) when --content is supplied.
wavemill_touch_marker() {
  local marker_path="${1:-}"
  shift || true
  [[ -n "$marker_path" ]] || return 1
  local content=""
  local have_content=0
  while (( $# > 0 )); do
    case "$1" in
      --content) content="${2:-}"; have_content=1; shift 2 ;;
      *) shift ;;
    esac
  done
  mkdir -p "$(dirname "$marker_path")" 2>/dev/null || true
  if (( have_content )); then
    local tmp="${marker_path}.tmp.$$"
    printf '%s' "$content" > "$tmp" && mv "$tmp" "$marker_path"
  else
    : > "$marker_path"
  fi
  wavemill_monitor_notify
  return 0
}

# Send USR1 to dashboard process to trigger an immediate refresh.
# Best-effort only: never fail, even when PID is stale or invalid.
wavemill_hook_notify() {
  local dashboard_pid="${WAVEMILL_DASHBOARD_PID:-}"
  [[ -n "$dashboard_pid" ]] || return 0

  # Validate PID before signaling.
  [[ "$dashboard_pid" =~ ^[0-9]+$ ]] || return 0
  [[ "$dashboard_pid" -eq 0 ]] && return 0
  kill -0 "$dashboard_pid" 2>/dev/null || return 0

  kill -USR1 "$dashboard_pid" 2>/dev/null || true
  if [[ -n "${WAVEMILL_SESSION:-}" && -n "${WAVEMILL_ISSUE:-}" ]]; then
    (
      local hook_dir helper state_file
      hook_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd 2>/dev/null || true)"
      helper="${hook_dir%/hooks}/lib/wavemill-window-titles.sh"
      [[ -f "$helper" ]] || exit 0
      # shellcheck source=wavemill-window-titles.sh
      source "$helper" || exit 0
      state_file="${WAVEMILL_STATE_FILE:-${STATE_FILE:-}}"
      wavemill_apply_window_metadata "${WAVEMILL_SESSION:-}" "${WAVEMILL_ISSUE:-}" "" "$state_file" >/dev/null 2>&1 || true
    ) 2>/dev/null || true
  fi
  return 0
}

_wavemill_hook_osc_allowed_context() {
  case "${WAVEMILL_PHASE:-}" in
    planning|coding|review|reviewing) return 0 ;;
    *) return 1 ;;
  esac
}

_wavemill_hook_config_file() {
  local repo_dir="${WAVEMILL_MILLED_REPO_DIR:-}"
  local config_file=""
  local git_root=""

  if [[ -n "$repo_dir" ]]; then
    config_file="${repo_dir%/}/.wavemill-config.json"
    [[ -r "$config_file" ]] && printf '%s\n' "$config_file" && return 0
  fi

  config_file="$PWD/.wavemill-config.json"
  [[ -r "$config_file" ]] && printf '%s\n' "$config_file" && return 0

  if command -v git >/dev/null 2>&1; then
    git_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
    if [[ -n "$git_root" ]]; then
      config_file="${git_root%/}/.wavemill-config.json"
      [[ -r "$config_file" ]] && printf '%s\n' "$config_file" && return 0
    fi
  fi

  return 1
}

_wavemill_hook_osc_flags() {
  # Return "<emitOsc> <programStatus>" (true/false tokens). Cached per-process.
  if [[ -n "${_WAVEMILL_HOOK_OSC_FLAGS_CACHE:-}" ]]; then
    printf '%s' "$_WAVEMILL_HOOK_OSC_FLAGS_CACHE"
    return 0
  fi

  local emit_osc="true"
  local program_status="true"
  local config_file=""

  if command -v jq >/dev/null 2>&1; then
    config_file="$(_wavemill_hook_config_file 2>/dev/null || true)"
    if [[ -n "$config_file" ]]; then
      local flags
      flags="$(
        jq -r '
          (if (.hooks? | type == "object")
             and (.hooks | has("emitOsc"))
             and .hooks.emitOsc == false then "false" else "true" end) as $osc |
          (if (.hooks? | type == "object")
             and (.hooks | has("programStatus"))
             and .hooks.programStatus == false then "false" else "true" end) as $ps |
          "\($osc) \($ps)"
        ' "$config_file" 2>/dev/null || true
      )"
      if [[ "$flags" =~ ^(true|false)\ (true|false)$ ]]; then
        emit_osc="${flags%% *}"
        program_status="${flags##* }"
      fi
    fi
  fi

  _WAVEMILL_HOOK_OSC_FLAGS_CACHE="${emit_osc} ${program_status}"
  printf '%s' "$_WAVEMILL_HOOK_OSC_FLAGS_CACHE"
}

_wavemill_hook_osc_enabled() {
  local flags
  flags="$(_wavemill_hook_osc_flags)"
  [[ "${flags%% *}" != "false" ]]
}

_wavemill_hook_osc7501_enabled() {
  local flags
  flags="$(_wavemill_hook_osc_flags)"
  [[ "${flags##* }" != "false" ]]
}

_wavemill_hook_osc_sanitize() {
  local value="${1:-}"
  printf '%s' "$value" | LC_ALL=C tr -d '[:cntrl:];'
}

_wavemill_hook_osc_body() {
  local state="$1"
  local event="$2"
  local detail="${3:-}"
  local agent="${4:-}"
  local context=""

  if [[ -n "$detail" ]]; then
    context="$detail"
  elif [[ -n "$event" ]]; then
    context="$event"
  else
    context="$agent"
  fi

  case "$state" in
    working)
      [[ -n "$context" ]] && printf 'working: %s' "$context" || printf 'working'
      ;;
    waiting)
      [[ -n "$context" ]] && printf 'waiting on %s' "$context" || printf 'waiting'
      ;;
    blocked)
      [[ -n "$context" ]] && printf 'blocked: %s' "$context" || printf 'blocked'
      ;;
    approval-needed)
      [[ -n "$context" ]] && printf 'approval needed: %s' "$context" || printf 'approval needed'
      ;;
    policy-denied)
      [[ -n "$context" ]] && printf 'policy denied: %s' "$context" || printf 'policy denied'
      ;;
    error)
      [[ -n "$context" ]] && printf 'error in %s' "$context" || printf 'error'
      ;;
    idle)
      [[ -n "$context" ]] && printf 'idle: %s' "$context" || printf 'idle'
      ;;
    *)
      printf '%s' "$state"
      ;;
  esac
}

_wavemill_hook_osc_sequence() {
  local title="$(_wavemill_hook_osc_sanitize "${1:-}")"
  local body="$(_wavemill_hook_osc_sanitize "${2:-}")"
  printf '\033]777;notify;%s;%s\033\\' "$title" "$body"
}

_wavemill_hook_osc_wrap() {
  local payload="${1:-}"
  local escaped_payload="$payload"

  if [[ -n "${TMUX:-}" ]]; then
    escaped_payload="${escaped_payload//$'\033'/$'\033\033'}"
    printf '\033Ptmux;%s\033\\' "$escaped_payload"
    return 0
  fi

  printf '%s' "$payload"
}

_wavemill_hook_emit_osc() {
  local state="$1"
  local event="$2"
  local detail="${3:-}"
  local agent="$4"
  local issue="${WAVEMILL_ISSUE:-}"
  local title="wavemill"
  local body=""
  local sequence=""
  local wrapped=""

  _wavemill_hook_osc_allowed_context || return 0
  _wavemill_hook_osc_enabled || return 0

  case "$state" in
    waiting|approval-needed|policy-denied|error) ;;
    *) return 0 ;;
  esac

  if [[ -n "$issue" ]]; then
    title="wavemill $issue"
  fi

  body="$(_wavemill_hook_osc_body "$state" "$event" "$detail" "$agent")"
  sequence="$(_wavemill_hook_osc_sequence "$title" "$body")"
  wrapped="$(_wavemill_hook_osc_wrap "$sequence")"

  printf '%s' "$wrapped" >&2 2>/dev/null || true
  return 0
}

# ---------------------------------------------------------------------------
# OSC 7501 Program Status (rev 0.4, 2026-10-10)
#
# A continuous-state mirror emitted alongside every successful hook write.
# Writes go to the resolved pane TTY (never stdout/stderr) and are best-effort:
# every error path returns 0 so the hook write budget is unaffected.
# ---------------------------------------------------------------------------

_wavemill_hook_osc7501_state() {
  case "${1:-}" in
    working) printf 'state=working' ;;
    idle) printf 'state=idle' ;;
    waiting) printf 'state=blocked:kind=question' ;;
    approval-needed) printf 'state=blocked:kind=permission' ;;
    blocked) printf 'state=blocked' ;;
    policy-denied|error) printf 'state=error' ;;
    *) return 0 ;;
  esac
}

_wavemill_hook_osc7501_strip_cc() {
  printf '%s' "${1:-}" | LC_ALL=C tr -d '[:cntrl:]'
}

# Truncate to the specified byte count BEFORE base64 encoding, then base64
# the result and strip any newline wrapping (some base64 implementations wrap
# at 76 chars). Caller is responsible for stripping control chars.
_wavemill_hook_osc7501_b64() {
  local value="${1:-}"
  local max_bytes="${2:-2048}"
  [[ -n "$value" ]] || { printf ''; return 0; }
  printf '%s' "$value" \
    | LC_ALL=C head -c "$max_bytes" \
    | base64 2>/dev/null \
    | LC_ALL=C tr -d '\n\r'
}

_wavemill_hook_osc7501_sanitize_app() {
  local agent="${1:-}"
  local candidate="wavemill"
  if [[ -n "$agent" ]]; then
    candidate="wavemill-${agent}"
  fi
  if [[ "$candidate" =~ ^[A-Za-z0-9_.+-]{1,32}$ ]]; then
    printf '%s' "$candidate"
  else
    printf 'wavemill'
  fi
}

# Resolve the pane TTY once per process. The result is a writable character
# device, or the sentinel "__none__" if resolution fails. Both outcomes are
# cached so subsequent writes don't re-run `tmux display-message`.
_wavemill_hook_osc7501_tty() {
  if [[ -n "${_WAVEMILL_HOOK_OSC7501_TTY_CACHE:-}" ]]; then
    printf '%s' "$_WAVEMILL_HOOK_OSC7501_TTY_CACHE"
    return 0
  fi
  local tty=""
  if [[ -n "${TMUX:-}" ]] && command -v tmux >/dev/null 2>&1; then
    tty="$(tmux display-message -p '#{pane_tty}' 2>/dev/null || true)"
  fi
  if [[ -z "$tty" ]]; then
    tty="$(tty 2>/dev/null || true)"
  fi
  if [[ -n "$tty" && -w "$tty" && -c "$tty" ]]; then
    _WAVEMILL_HOOK_OSC7501_TTY_CACHE="$tty"
  else
    _WAVEMILL_HOOK_OSC7501_TTY_CACHE="__none__"
  fi
  printf '%s' "$_WAVEMILL_HOOK_OSC7501_TTY_CACHE"
}

_wavemill_hook_osc7501_sequence() {
  local app="$1"
  local state_frag="$2"
  local msg_b64="${3:-}"
  local title_b64="${4:-}"
  local body="app=${app}:${state_frag}"
  [[ -n "$msg_b64" ]] && body="${body}:msg=${msg_b64}"
  [[ -n "$title_b64" ]] && body="${body}:title=${title_b64}"
  printf '\033]7501;%s\033\\' "$body"
}

_wavemill_hook_osc7501_wrap() {
  local payload="${1:-}"
  if [[ -n "${TMUX:-}" ]]; then
    local escaped="${payload//$'\033'/$'\033\033'}"
    printf '\033Ptmux;%s\033\\' "$escaped"
    return 0
  fi
  printf '%s' "$payload"
}

_wavemill_hook_emit_osc7501() {
  local state="$1"
  local event="$2"
  local detail="${3:-}"
  local agent="${4:-}"
  local next_action="${5:-}"

  _wavemill_hook_osc7501_enabled || return 0

  local state_frag
  state_frag="$(_wavemill_hook_osc7501_state "$state")"
  [[ -n "$state_frag" ]] || return 0

  local tty
  tty="$(_wavemill_hook_osc7501_tty)"
  [[ "$tty" != "__none__" ]] || return 0

  local app
  app="$(_wavemill_hook_osc7501_sanitize_app "$agent")"

  local msg_source
  if [[ -n "$next_action" ]]; then
    msg_source="$next_action"
  else
    msg_source="$detail"
  fi
  msg_source="$(_wavemill_hook_osc7501_strip_cc "$msg_source")"
  local msg_b64=""
  if [[ -n "$msg_source" ]]; then
    msg_b64="$(_wavemill_hook_osc7501_b64 "$msg_source" 2048)"
  fi

  local title_source
  title_source="$(_wavemill_hook_osc7501_strip_cc "${WAVEMILL_ISSUE:-}")"
  local title_b64=""
  if [[ -n "$title_source" ]]; then
    title_b64="$(_wavemill_hook_osc7501_b64 "$title_source" 192)"
  fi

  local sequence wrapped
  sequence="$(_wavemill_hook_osc7501_sequence "$app" "$state_frag" "$msg_b64" "$title_b64")"
  wrapped="$(_wavemill_hook_osc7501_wrap "$sequence")"

  # Best-effort: never fail or slow the hook write.
  printf '%s' "$wrapped" > "$tty" 2>/dev/null || true
  return 0
}

# Atomically write the standardized hook status payload.
# Args: state, event, detail, agent [next_action] [writer]
#
# States: working (agent is actively processing), idle (agent stopped normally),
#         waiting (agent blocked on user input), blocked (agent cannot proceed),
#         approval-needed (agent paused awaiting explicit approval),
#         policy-denied (action rejected by policy), error (agent encountered failure)
#
# The optional next_action field carries a short hint for the dashboard (e.g. the
# action the operator should take). It is additive and does not affect readers that
# only know the four-state contract.
#
# HOK-3101: The optional writer field (agent|monitor, default agent) distinguishes
# controller writes from agent writes. Monitor writes never count as agent liveness
# evidence, and they preserve the previous agent's record in .agentRecord so a
# monitor pr_merged/blocked/waiting write cannot erase the agent's own Stop/idle
# evidence (HOK-3089 pt 3). Callers in wavemill-monitor.sh, terminal-reconciler.sh
# and wavemill-common.sh worktree setup pass writer=monitor.
#
# The hook file uses a 300s TTL - consumers should fall back to other signals
# (pane liveness, process monitoring) if the timestamp is stale.
wavemill_hook_write() {
  local state="$1"
  local event="$2"
  local detail="${3:-}"
  local agent="$4"
  local next_action="${5:-}"
  local writer="${6:-agent}"

  case "$writer" in
    agent|monitor) ;;
    *) writer="agent" ;;
  esac

  # Hooks are a no-op outside a wavemill agent context. wavemill_hook_check()
  # enforces this for adapter scripts by exiting, but wavemill_hook_write() is
  # also called directly from long-running processes (the monitor loop, worktree
  # setup) and several of those callers guard only on `declare -F`, not on the
  # env. Expanding the vars unguarded under `set -u` killed the monitor outright:
  #
  #   wavemill-hook-protocol.sh: line NNN: WAVEMILL_SESSION: unbound variable
  #
  # Return rather than exit — exiting here would take the calling loop down,
  # which is the very failure this guard exists to prevent.
  [[ -n "${WAVEMILL_SESSION:-}" && -n "${WAVEMILL_ISSUE:-}" ]] || return 0

  # Only write recognized states; unknown states are silently dropped so that
  # readers never see partial or malformed JSON from an unrecognized write.
  case "$state" in
    working|idle|waiting|blocked|approval-needed|policy-denied|error) ;;
    *) return 0 ;;
  esac

  local hook_file="/tmp/wavemill-${WAVEMILL_SESSION}-${WAVEMILL_ISSUE}.hook"
  local tmp_file="${hook_file}.tmp.$$"
  local timestamp
  timestamp=$(date +%s)

  local base_json='{}'
  if [[ -f "$hook_file" ]] && jq -e . "$hook_file" >/dev/null 2>&1; then
    base_json="$(cat "$hook_file")"
  fi

  # HOK-3101: legacy hooks (no writer field, written before this ships) are
  # classified by event. Controller events must stay in sync with
  # CONTROLLER_HOOK_EVENTS in shared/lib/task-progress.ts and
  # shared/lib/task-progress.sh — the parity tests pin all three.
  local controller_events_filter='
    def controller_events:
      [
        "pr_merged","pr_closed_unmerged","operator_abort","recovery_failure",
        "review_complete","ready_complete","pr_opened","blocked_completion_liveness",
        "premature_plan_approval","recovery_contract_unavailable",
        "planning_rejection_notify_failed","NoPR","worktree-setup",
        "challenge_resolved_winner","challenge_invalid","challenge_no_comparison",
        "challenge_stale_evidence","challenge_pair_recovery"
      ];
    def is_controller_event($event): (controller_events | index($event)) != null;
    def base_writer($base): (
      ($base.writer // (if ($base.event // "" | length) > 0 and is_controller_event($base.event // "") then "monitor"
                        elif ($base.event // "") == "" and ($base.state // "") == "working" then "monitor"
                        else "agent" end))
    );'

  # Atomic write: build JSON in tmp, then mv (prevents partial reads).
  # HOK-3101: also carries the writer field and preserves the previous
  # agentRecord across monitor writes (see comment above), so monitor writes
  # never overwrite the agent's last own record.
  if jq -n \
    --argjson base "$base_json" \
    --arg state "$state" \
    --arg event "$event" \
    --arg detail "$detail" \
    --arg agent "$agent" \
    --arg next_action "$next_action" \
    --arg writer "$writer" \
    --argjson timestamp "$timestamp" \
    "$controller_events_filter"'
    def new_agent_record:
      {state: $state, event: $event, agent: $agent, timestamp: $timestamp}
      + (if $detail != "" then {detail: $detail} else {} end);
    def preserved_agent_record($base):
      if ($base.agentRecord? // null) != null then $base.agentRecord
      elif base_writer($base) == "agent"
        and ($base.state? // "" | length) > 0
        and ($base.timestamp? // 0) > 0 then
        {state: ($base.state // ""), event: ($base.event // ""), agent: ($base.agent // ""), timestamp: ($base.timestamp // 0)}
        + (if ($base.detail? // "" | length) > 0 then {detail: $base.detail} else {} end)
      else null
      end;
    $base
     + {state: $state, event: $event, agent: $agent, timestamp: $timestamp, writer: $writer}
     + (if $detail != "" then {detail: $detail} else {} end)
     + (if $next_action != "" then {next_action: $next_action} else {} end)
     + (if $writer == "agent" then {agentRecord: new_agent_record}
        else
          (preserved_agent_record($base) as $rec
           | if $rec != null then {agentRecord: $rec} else {} end)
        end)
    ' > "$tmp_file" 2>/dev/null; then
    if mv "$tmp_file" "$hook_file" 2>/dev/null; then
      wavemill_hook_notify
      _wavemill_hook_emit_osc "$state" "$event" "$detail" "$agent" || true
      _wavemill_hook_emit_osc7501 "$state" "$event" "$detail" "$agent" "$next_action" || true
      # HOK-3184: mirror the agent record as an evidence row. Monitor writes
      # return immediately inside the helper (writer-field enforcement).
      if declare -F wavemill_hook_shadow_evidence >/dev/null 2>&1; then
        wavemill_hook_shadow_evidence "$state" "$event" "$detail" "$writer" "$agent" || true
      fi
    else
      rm -f "$tmp_file"
    fi
  else
    rm -f "$tmp_file"
  fi

  return 0
}

_wavemill_hook_feature_dir() {
  if [[ -n "${WAVEMILL_FEATURE_DIR:-}" && -d "${WAVEMILL_FEATURE_DIR:-}" ]]; then
    printf '%s\n' "$WAVEMILL_FEATURE_DIR"
    return 0
  fi

  local slug="${WAVEMILL_FEATURE_SLUG:-${WAVEMILL_SLUG:-}}"
  local wt_dir="${WAVEMILL_WT_DIR:-}"
  if [[ -n "$slug" && -n "$wt_dir" ]]; then
    for kind in features bugs; do
      if [[ -d "${wt_dir%/}/$kind/$slug" ]]; then
        printf '%s\n' "${wt_dir%/}/$kind/$slug"
        return 0
      fi
    done
  fi

  return 1
}

wavemill_hook_archive_current() {
  local session="${1:-${WAVEMILL_SESSION:-}}"
  local issue="${2:-${WAVEMILL_ISSUE:-}}"
  local reason="${3:-superseded}"
  local hook_file="/tmp/wavemill-${session}-${issue}.hook"
  local feature_dir history_file payload timestamp

  [[ -n "$session" && -n "$issue" && -f "$hook_file" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  jq -e . "$hook_file" >/dev/null 2>&1 || return 0
  feature_dir="$(_wavemill_hook_feature_dir 2>/dev/null || true)"
  [[ -n "$feature_dir" ]] || return 0

  mkdir -p "$feature_dir" 2>/dev/null || return 0
  history_file="$feature_dir/.terminal-history.jsonl"
  payload="$(cat "$hook_file" 2>/dev/null || true)"
  [[ -n "$payload" ]] || return 0
  timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  jq -cn --arg archivedAt "$timestamp" --arg reason "$reason" --arg session "$session" --arg issue "$issue" --argjson payload "$payload" \
    '{archivedAt:$archivedAt, reason:$reason, session:$session, issue:$issue, payload:$payload}' >> "$history_file" 2>/dev/null || true
}

wavemill_hook_terminalize() {
  local state="$1"
  local reason="$2"
  local detail="${3:-}"
  local agent="${4:-wavemill}"
  local writer="${5:-monitor}"

  case "$state" in
    idle|error) ;;
    *) return 0 ;;
  esac

  wavemill_hook_archive_current "${WAVEMILL_SESSION:-}" "${WAVEMILL_ISSUE:-}" "$reason" || true
  # HOK-3101: terminal writes are controller writes. They preserve the agent's
  # own record in .agentRecord so the reconciler's idle-evidence check keeps
  # seeing the agent's Stop event (HOK-3089 pt 3).
  wavemill_hook_write "$state" "$reason" "$detail" "$agent" "" "$writer"
}

wavemill_hook_supersede() {
  local session="$1" issue="$2" reason="${3:-superseded}"
  local hook_file="/tmp/wavemill-${session}-${issue}.hook"

  [[ -n "$session" && -n "$issue" ]] || return 0
  wavemill_hook_archive_current "$session" "$issue" "$reason" || true
  rm -f "$hook_file" 2>/dev/null || true
}

wavemill_hook_write_routing() {
  local role="$1"
  local routing_json="$2"

  case "$role" in
    planner|coder|reviewer) ;;
    *) return 0 ;;
  esac

  [[ -n "${WAVEMILL_SESSION:-}" ]] || return 0
  [[ -n "${WAVEMILL_ISSUE:-}" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0

  local hook_file="/tmp/wavemill-${WAVEMILL_SESSION}-${WAVEMILL_ISSUE}.hook"
  local tmp_file="${hook_file}.tmp.$$"
  local base_json="{}"

  if [[ -f "$hook_file" ]] && jq -e . "$hook_file" >/dev/null 2>&1; then
    base_json="$(cat "$hook_file")"
  fi

  if jq -n \
    --argjson base "$base_json" \
    --arg role "$role" \
    --argjson routing "$routing_json" \
    '$base + {routing: (($base.routing // {}) + {($role): $routing})}' > "$tmp_file" 2>/dev/null; then
    if mv "$tmp_file" "$hook_file" 2>/dev/null; then
      wavemill_hook_notify
    else
      rm -f "$tmp_file"
    fi
  else
    rm -f "$tmp_file"
  fi
  return 0
}
