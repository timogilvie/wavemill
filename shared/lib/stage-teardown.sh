#!/usr/bin/env bash
# HOK-3359 — the one stage-agent teardown.
#
# "May the controller end this stage agent now, and what does the record say
# afterwards?" was answered differently at eight call sites (quarantine,
# planning reap, review-capacity release, pane release, challenge abort/
# cancel, terminal cleanup). `stage_agent_teardown` is the one answer:
#
#   1. Settle  — while the HOK-3101 task-progress primitive shows the agent
#      still live, hold (non-blocking, HOK-3206) until either the agent's own
#      idle/Stop record lands, or the shared dirty-handoff grace
#      (WAVEMILL_CODING_DIRTY_HANDOFF_GRACE_SECONDS, default 120s) elapses
#      since the completion marker that triggered this teardown. Skippable
#      with --no-settle for operator/terminal/challenge-cancel paths that
#      have already proven the agent is done.
#   2. Terminate — the existing graceful `agent_terminate_in_pane` escalation
#      (Esc / C-c / `/exit` / C-d, then forceful escalation).
#   3. Record — append one controller-termination entry to
#      `.terminal-history.jsonl` via `wavemill_hook_write_controller_termination`
#      (shared/hooks/wavemill-hook-protocol.sh). This is an EXIT FACT, not
#      progress and not agent-liveness evidence: it is deliberately a third
#      thing, orthogonal to the two HOK-3101 invariants (see the "controller
#      exit facts" note in shared/lib/task-progress.ts). `tools/task-progress.ts`
#      reads it and reports `agentIdle=true` without moving `lastProgressAt`.
#   4. Kill the window (unless --keep-window).
#
# Usage:
#   stage_agent_teardown <issue> <feature_dir> <reason> \
#       [--phase <phase>] [--worktree <wt_dir>] [--marker <path>] \
#       [--keep-window] [--no-settle] [--no-record]
#
# Returns:
#   0 — torn down (window killed unless --keep-window) and recorded.
#   2 — pending: the agent is still settling; the caller re-enters next tick.
#   1 — failure: the window is still present after the kill attempt. The
#       record step (if not suppressed) has already run.
#
# Every dependency here is optional at source time (agent-adapters.sh, the
# hook protocol, and wavemill-monitor.sh's grace constant are not always
# loaded alongside wavemill-common.sh), so every external call is guarded
# with `declare -F` and degrades to a safe no-op rather than aborting the
# caller.

if [[ -n "${WAVEMILL_STAGE_TEARDOWN_SH_LOADED:-}" ]]; then
  return 0
fi
WAVEMILL_STAGE_TEARDOWN_SH_LOADED=1

# Grace seconds for the settle phase. Reuses the one dirty-handoff grace
# constant (coding_dirty_handoff_grace_seconds, wavemill-monitor.sh) when it
# is loaded; otherwise reads the same env var directly so stage-teardown.sh
# never hard-depends on the monitor script having been sourced.
_stage_teardown_grace_seconds() {
  if declare -F coding_dirty_handoff_grace_seconds >/dev/null 2>&1; then
    coding_dirty_handoff_grace_seconds
    return 0
  fi
  local grace="${WAVEMILL_CODING_DIRTY_HANDOFF_GRACE_SECONDS:-120}"
  [[ "$grace" =~ ^[0-9]+$ ]] || grace=120
  printf '%s\n' "$grace"
}

# The marker file whose mtime anchors the settle grace, when the caller does
# not pass --marker explicitly. No new markers (HOK-3359 "not in scope") —
# this reuses the completion markers that already exist per phase.
_stage_teardown_default_marker() {
  local feature_dir="$1" phase="$2"
  case "$phase" in
    coding) printf '%s\n' "$feature_dir/.coding-complete" ;;
    planning) printf '%s\n' "$feature_dir/.plan-approved" ;;
    *) printf '\n' ;;
  esac
}

_stage_teardown_mtime_epoch() {
  local path="$1"
  stat -f %m "$path" 2>/dev/null || stat -c %Y "$path" 2>/dev/null || date +%s
}

# True (rc 0) when the task-progress primitive shows the agent already
# settled: its own idle/Stop record landed, the terminal history already
# carries a settled-idle entry, or its process is confirmed not live.
_stage_teardown_agent_settled() {
  local issue="$1" feature_dir="$2" phase="$3" worktree="$4"
  declare -F task_progress_json >/dev/null 2>&1 || return 0
  command -v jq >/dev/null 2>&1 || return 0

  local -a progress_args=(--feature-dir "$feature_dir")
  [[ -n "$phase" ]] && progress_args+=(--phase "$phase")
  [[ -n "$worktree" ]] && progress_args+=(--worktree "$worktree")

  local progress
  progress="$(task_progress_json "$issue" "${progress_args[@]}" 2>/dev/null || printf '{}')"
  printf '%s' "$progress" | jq -e '
    (.agentIdle == true) or (.terminalIdle == true) or (.agentProcessLive == false)
  ' >/dev/null 2>&1
}

stage_agent_teardown() {
  local issue="$1" feature_dir="$2" reason="$3"
  shift 3

  local phase="" worktree="" marker="" keep_window=0 no_settle=0 no_record=0
  while (( $# > 0 )); do
    case "$1" in
      --phase) phase="$2"; shift 2 ;;
      --worktree) worktree="$2"; shift 2 ;;
      --marker) marker="$2"; shift 2 ;;
      --keep-window) keep_window=1; shift ;;
      --no-settle) no_settle=1; shift ;;
      --no-record) no_record=1; shift ;;
      *) shift ;;
    esac
  done

  [[ -n "$issue" && -n "$feature_dir" ]] || return 1
  [[ -n "$worktree" ]] || worktree="$(dirname "$(dirname "$feature_dir")")"
  local slug session
  slug="$(basename "$feature_dir")"
  session="${SESSION:-${WAVEMILL_SESSION:-wavemill}}"

  # --- Phase 1: settle ------------------------------------------------------
  if (( no_settle == 0 )) && ! _stage_teardown_agent_settled "$issue" "$feature_dir" "$phase" "$worktree"; then
    local grace now start
    grace="$(_stage_teardown_grace_seconds)"
    now="$(date +%s)"
    [[ -n "$marker" ]] || marker="$(_stage_teardown_default_marker "$feature_dir" "$phase")"
    if [[ -n "$marker" && -f "$marker" ]]; then
      start="$(_stage_teardown_mtime_epoch "$marker")"
    else
      start="$now"
    fi
    [[ "$start" =~ ^[0-9]+$ ]] || start="$now"
    if (( now - start < grace )); then
      return 2
    fi
    # Grace elapsed with the agent still live — proceed to terminate anyway.
  fi

  # --- Phase 2: terminate ----------------------------------------------------
  local target=""
  if command -v tmux >/dev/null 2>&1 && declare -F _tmux_task_window_target >/dev/null 2>&1; then
    target="$(_tmux_task_window_target "$session" "$issue" "$slug" "${STATE_FILE:-}" "$worktree" 2>/dev/null || true)"
  fi
  if [[ -n "$target" ]] && declare -F agent_terminate_in_pane >/dev/null 2>&1; then
    agent_terminate_in_pane "$session" "$target" 10 || true
  fi

  # --- Phase 3: record -------------------------------------------------------
  if (( no_record == 0 )); then
    if ! declare -F wavemill_hook_write_controller_termination >/dev/null 2>&1; then
      local hook_protocol="${WAVEMILL_HOOK_PROTOCOL:-${LIB_DIR:-${REPO_DIR:-.}/shared/lib}/../hooks/wavemill-hook-protocol.sh}"
      [[ -f "$hook_protocol" ]] || hook_protocol="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)/hooks/wavemill-hook-protocol.sh"
      if [[ -f "$hook_protocol" ]]; then
        # shellcheck disable=SC1090
        source "$hook_protocol" || true
      fi
    fi
    if declare -F wavemill_hook_write_controller_termination >/dev/null 2>&1; then
      wavemill_hook_write_controller_termination "$issue" "$feature_dir" "$reason" "$phase" "$session" || true
    fi
  fi

  # --- Phase 4: kill the window ----------------------------------------------
  if (( keep_window == 1 )); then
    return 0
  fi
  if [[ -z "$target" ]] || ! command -v tmux >/dev/null 2>&1; then
    return 0
  fi
  local joined_target
  joined_target="$(_tmux_target_join "$session" "$target" 2>/dev/null || printf '%s' "$target")"
  tmux kill-window -t "$joined_target" 2>/dev/null || true
  if declare -F _tmux_window_target_exists >/dev/null 2>&1 && _tmux_window_target_exists "$session" "$target"; then
    return 1
  fi
  return 0
}
