#!/usr/bin/env bash
# HOK-3322 — shell twin of shared/lib/ready-remediation-disposition.ts.
#
# The one Ready remediation in-flight/completion disposition. A running Ready
# result and a matching launch SHA are facts about a launch, not liveness:
# whether a same-head remediation is still in flight is decided only from the
# owner's task-progress evidence (HOK-3101), which the TS CLI reads.
#
#   ready_remediation_disposition <issue> <state_dir> <launch_head> <current_head> [worktree]
#
# Prints one of:
#   none        no remediation launch at a known head, or Ready is not running
#   superseded  the remediation moved the head — re-run the Ready check
#   in-flight   same head, Ready running, owner live or unknown — hold
#   settled     same head, Ready running, owner idle/exited since its launch —
#               re-run the Ready check (a red result goes through the existing
#               ready-remediation bounded retry, never a synthesised pass)
#
# The head/status rows are answered here without a tsx spawn (this runs on the
# monitor hot path); only the same-head running row asks the TS module. Both
# sides are pinned against tests/fixtures/ready-remediation-disposition-cases.json
# (tests/ready-remediation-disposition.test.sh and
# shared/lib/ready-remediation-disposition.test.ts). Any CLI failure holds
# (`in-flight`), the pre-HOK-3322 behaviour, and is retried next tick.

if [[ -n "${WAVEMILL_READY_REMEDIATION_DISPOSITION_SH_LOADED:-}" ]]; then
  return 0
fi
WAVEMILL_READY_REMEDIATION_DISPOSITION_SH_LOADED=1

ready_remediation_disposition() {
  local issue="$1" state_dir="$2" launch_head="${3:-}" current_head="${4:-}" worktree="${5:-}"
  local ready_status out kind

  if [[ -z "$launch_head" || -z "$current_head" ]]; then
    printf 'none\n'
    return 0
  fi
  if [[ "$launch_head" != "$current_head" ]]; then
    printf 'superseded\n'
    return 0
  fi
  if declare -F read_stage_status >/dev/null 2>&1; then
    ready_status=$(read_stage_status "$state_dir" "ready")
  else
    # allow-stage-artifact-lookup: live in-flight status only; an archived result is never running
    ready_status=$(jq -r '.status // empty' "$state_dir/.ready-result.json" 2>/dev/null || true)
  fi
  if [[ "$ready_status" != "running" ]]; then
    printf 'none\n'
    return 0
  fi

  local -a cli=(ready-remediation-disposition.ts
    --issue "$issue"
    --session "${WAVEMILL_SESSION:-${SESSION:-wavemill}}"
    --state-dir "$state_dir"
    --launch-head "$launch_head"
    --current-head "$current_head")
  [[ -n "$worktree" ]] && cli+=(--worktree "$worktree")
  [[ -n "${STATE_FILE:-}" ]] && cli+=(--state-file "$STATE_FILE")

  if declare -F wavemill_run_tool >/dev/null 2>&1; then
    if declare -F _with_timeout >/dev/null 2>&1; then
      out=$(_with_timeout "${WAVEMILL_TASK_PROGRESS_TIMEOUT:-8}" wavemill_run_tool "${cli[@]}" 2>/dev/null || true)
    else
      out=$(wavemill_run_tool "${cli[@]}" 2>/dev/null || true)
    fi
  fi
  kind=$(jq -r '.kind // empty' <<<"${out:-}" 2>/dev/null || true)
  case "$kind" in
    settled) printf 'settled\n' ;;
    *) printf 'in-flight\n' ;;
  esac
  return 0
}
