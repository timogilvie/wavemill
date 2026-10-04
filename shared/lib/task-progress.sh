#!/usr/bin/env bash
# HOK-3101 — shell entry point for the task-progress primitive.
#
# Shell callers must never make liveness decisions locally. Two ways to
# consume the primitive from shell:
#
#   1. `wavemill_hook_read <session> <issue> <field|state> [--fresh]
#      [--agent-only]` — a raw hook accessor that centralises the 300s TTL
#      check and the writer classification. It replaces ten copy-paste TTL
#      blocks (monitor :355, :508, :643, :3988, :5780; status :193, :209,
#      :844; next-done :33; reconciler :297). This is the ONLY function here
#      that decides "is the record fresh"; every other decision goes through
#      the TS CLI or the cache.
#
#   2. `task_progress_json <issue> [--phase p] [--pane-target t] [--pane-pid p]
#      [--max-age s] [--write-cache]` — spawns `tools/task-progress.ts`
#      under `_with_timeout` and prints its JSON. Fail-safe: `{}` on any
#      failure so downstream `jq` never crashes. `--pane-pid` (or
#      `--pane-target`, resolved to a pid by the CLI) feeds the HOK-3137
#      background-work probe: `.agentBackgroundLive` is `true` when the agent
#      has a live substantive descendant (a backgrounded task), which
#      suppresses `.stalled` while the agent is idle. Process/pane existence
#      is still NEVER progress — it never moves `.lastProgressAt` or adds a
#      `.sources[]` entry (HOK-3101 invariant 1); omitting both pane options
#      leaves `.agentBackgroundLive` as `null` ("not probed").
#
#   3. `task_progress_cached_json <session> <issue> [max_age_seconds=300]`
#      — reads only the pre-written cache. No tsx spawn. The dashboard uses
#      this at 2s refresh, and callers that only want an already-computed
#      snapshot use this.
#
# The controller-events list here MUST stay in sync with
# CONTROLLER_HOOK_EVENTS in shared/lib/task-progress.ts and the jq inline
# list in shared/hooks/wavemill-hook-protocol.sh. The parity test in
# tests/task-progress.test.sh pins all three.

# Guard against double-sourcing.
if [[ -n "${WAVEMILL_TASK_PROGRESS_SH_LOADED:-}" ]]; then
  return 0
fi
WAVEMILL_TASK_PROGRESS_SH_LOADED=1

WAVEMILL_HOOK_TTL_SECONDS="${WAVEMILL_HOOK_TTL_SECONDS:-300}"

# One shell regex twin of isWavemillControllerProcess in task-progress.ts.
# Keep in sync; the parity test compares both against a fixture list.
WAVEMILL_CONTROLLER_PROCESS_REGEX='wavemill-monitor|/tmp/wavemill-[^[:space:]]*monitor|tools/[A-Za-z0-9_.-]+\.ts|tend\.ts|observer\.ts|ready-watchdog|pr-ci-status\.ts|plan-queue\.ts|tmux attach -t wavemill|wavemill-hook-protocol|wavemill-common\.sh'

# Controller hook events. Keep in sync with the two other locations.
_wavemill_controller_event() {
  case "${1:-}" in
    pr_merged|pr_closed_unmerged|operator_abort|recovery_failure|review_complete|ready_complete|pr_opened|blocked_completion_liveness|premature_plan_approval|recovery_contract_unavailable|planning_rejection_notify_failed|NoPR|worktree-setup|challenge_resolved_winner|challenge_invalid|challenge_no_comparison|challenge_stale_evidence|challenge_pair_recovery)
      return 0
      ;;
  esac
  return 1
}

# Read one field from a hook file.
#
# Usage: wavemill_hook_read <session> <issue> <field> [--fresh] [--agent-only]
#   field: state|event|detail|agent|writer|timestamp|next_action
#   --fresh:      only return a value when the timestamp is < WAVEMILL_HOOK_TTL_SECONDS old.
#   --agent-only: read from the preserved agentRecord (or, for legacy hooks,
#                 fall back to the top level iff it is an agent write).
#                 --agent-only also implies "state/event/agent/timestamp are
#                 sourced from the agent record" so a monitor `pr_merged`
#                 top-level does not overwrite the agent's `idle:Stop` (HOK-3101).
#
# Prints an empty string when the file is missing/malformed, or when the
# requested field is not present. Never fails the shell.
wavemill_hook_read() {
  local session="$1" issue="$2" field="$3"
  shift 3
  local fresh_only=0 agent_only=0
  while (( $# > 0 )); do
    case "$1" in
      --fresh) fresh_only=1 ;;
      --agent-only) agent_only=1 ;;
      *) ;;
    esac
    shift
  done

  local hook_file="/tmp/wavemill-${session}-${issue}.hook"
  [[ -f "$hook_file" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  jq -e . "$hook_file" >/dev/null 2>&1 || return 0

  local now ts source_json
  now=$(date +%s)
  ts=$(jq -r '.timestamp // 0' "$hook_file" 2>/dev/null || echo 0)
  [[ "$ts" =~ ^[0-9]+$ ]] || ts=0

  if (( agent_only == 1 )); then
    # Prefer .agentRecord; else, if the top-level is an agent write (writer=agent,
    # or missing writer with a non-controller event), fall back to it.
    local writer top_event top_state
    writer=$(jq -r '.writer // ""' "$hook_file" 2>/dev/null || echo "")
    top_event=$(jq -r '.event // ""' "$hook_file" 2>/dev/null || echo "")
    top_state=$(jq -r '.state // ""' "$hook_file" 2>/dev/null || echo "")
    if jq -e '.agentRecord != null' "$hook_file" >/dev/null 2>&1; then
      source_json='.agentRecord'
      ts=$(jq -r '.agentRecord.timestamp // 0' "$hook_file" 2>/dev/null || echo 0)
    else
      # Legacy classification.
      if [[ "$writer" == "monitor" ]]; then
        return 0
      elif [[ -z "$writer" ]] && _wavemill_controller_event "$top_event"; then
        return 0
      elif [[ -z "$writer" ]] && [[ -z "$top_event" ]] && [[ "$top_state" == "working" ]]; then
        # Monitor recovery-replay `working` write with an empty event.
        return 0
      fi
      source_json=''
    fi
    [[ "$ts" =~ ^[0-9]+$ ]] || ts=0
  else
    source_json=''
  fi

  if (( fresh_only == 1 )); then
    (( ts > 0 )) || return 0
    (( now - ts < WAVEMILL_HOOK_TTL_SECONDS )) || return 0
  fi

  case "$field" in
    state|event|detail|agent|writer|next_action|timestamp)
      jq -r "${source_json}.${field} // empty" "$hook_file" 2>/dev/null || true
      ;;
    *)
      return 0
      ;;
  esac
}

# Compute a task-progress snapshot by spawning the TS CLI. Prints JSON, or `{}`.
#
# Usage: task_progress_json <issue> [--phase p] [--pane-target t]
#                                  [--max-age s] [--write-cache]
#                                  [--stall-minutes n] [--session s]
task_progress_json() {
  local issue="$1"
  shift
  [[ -n "$issue" ]] || { printf '{}\n'; return 0; }

  local phase="" pane_target="" pane_pid="" max_age="" stall_minutes="" write_cache=0
  local session="${WAVEMILL_SESSION:-${SESSION:-wavemill}}"
  local state_file="${STATE_FILE:-${WAVEMILL_STATE_FILE:-}}"
  local worktree="" feature_dir=""

  while (( $# > 0 )); do
    case "$1" in
      --phase) phase="$2"; shift 2 ;;
      --pane-target) pane_target="$2"; shift 2 ;;
      --pane-pid) pane_pid="$2"; shift 2 ;;
      --max-age) max_age="$2"; shift 2 ;;
      --stall-minutes) stall_minutes="$2"; shift 2 ;;
      --write-cache) write_cache=1; shift ;;
      --session) session="$2"; shift 2 ;;
      --state-file) state_file="$2"; shift 2 ;;
      --worktree) worktree="$2"; shift 2 ;;
      --feature-dir) feature_dir="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  local tools_dir="${TOOLS_DIR:-}"
  if [[ -z "$tools_dir" ]]; then
    tools_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../tools" 2>/dev/null && pwd || true)"
  fi
  local script="$tools_dir/task-progress.ts"
  [[ -f "$script" ]] || { printf '{}\n'; return 0; }

  local -a cli_args=(--issue "$issue" --session "$session")
  [[ -n "$state_file" ]] && cli_args+=(--state-file "$state_file")
  [[ -n "$phase" ]] && cli_args+=(--phase "$phase")
  [[ -n "$pane_target" ]] && cli_args+=(--pane-target "$pane_target")
  [[ -n "$pane_pid" ]] && cli_args+=(--pane-pid "$pane_pid")
  [[ -n "$max_age" ]] && cli_args+=(--max-age "$max_age")
  [[ -n "$stall_minutes" ]] && cli_args+=(--stall-minutes "$stall_minutes")
  [[ -n "$worktree" ]] && cli_args+=(--worktree "$worktree")
  [[ -n "$feature_dir" ]] && cli_args+=(--feature-dir "$feature_dir")
  (( write_cache == 1 )) && cli_args+=(--write-cache)

  local timeout_secs="${WAVEMILL_TASK_PROGRESS_TIMEOUT:-8}"
  local runner
  if command -v _with_timeout >/dev/null 2>&1; then
    runner="_with_timeout"
  else
    runner=""
  fi

  local out=""
  if command -v node >/dev/null 2>&1 && node --import tsx --version >/dev/null 2>&1; then
    if [[ -n "$runner" ]]; then
      out=$("$runner" "$timeout_secs" node --import tsx "$script" "${cli_args[@]}" 2>/dev/null || true)
    else
      out=$(node --import tsx "$script" "${cli_args[@]}" 2>/dev/null || true)
    fi
  else
    if [[ -n "$runner" ]]; then
      out=$("$runner" "$timeout_secs" npx tsx "$script" "${cli_args[@]}" 2>/dev/null || true)
    else
      out=$(npx tsx "$script" "${cli_args[@]}" 2>/dev/null || true)
    fi
  fi

  if [[ -z "$out" ]] || ! printf '%s' "$out" | jq -e . >/dev/null 2>&1; then
    printf '{}\n'
    return 0
  fi
  printf '%s\n' "$out"
}

# Read the on-disk cache only. No tsx spawn. Prints `{}` when the cache is
# missing or older than `max_age_seconds`.
task_progress_cached_json() {
  local session="$1" issue="$2" max_age="${3:-300}"
  [[ -n "$session" && -n "$issue" ]] || { printf '{}\n'; return 0; }
  local cache_file="/tmp/wavemill-${session}-${issue}.progress.json"
  [[ -f "$cache_file" ]] || { printf '{}\n'; return 0; }
  command -v jq >/dev/null 2>&1 || { printf '{}\n'; return 0; }
  jq -e . "$cache_file" >/dev/null 2>&1 || { printf '{}\n'; return 0; }

  local computed_at now age_seconds
  computed_at=$(jq -r '.computedAt // empty' "$cache_file" 2>/dev/null || true)
  [[ -n "$computed_at" ]] || { printf '{}\n'; return 0; }
  # Convert ISO to epoch. Try GNU first, then BSD.
  local computed_epoch
  computed_epoch=$(date -u -d "$computed_at" +%s 2>/dev/null || \
                   date -u -j -f "%Y-%m-%dT%H:%M:%S" "${computed_at%.*}" +%s 2>/dev/null || \
                   date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$computed_at" +%s 2>/dev/null || \
                   echo "")
  [[ -n "$computed_epoch" ]] || { cat "$cache_file"; printf '\n'; return 0; }
  now=$(date +%s)
  age_seconds=$((now - computed_epoch))
  if (( age_seconds > max_age )); then
    printf '{}\n'
    return 0
  fi
  cat "$cache_file"
  printf '\n'
}

# Extract a field from a task-progress JSON blob.
# Usage: task_progress_field <json_string> <jq_expr>
task_progress_field() {
  local json="$1" expr="$2"
  [[ -n "$json" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  printf '%s' "$json" | jq -r "$expr // empty" 2>/dev/null || true
}
