#!/usr/bin/env bash
set -Eeuo pipefail


# Import environment from env file
source "$1"

# Source marker lifecycle helpers
WAVEMILL_LIB_DIR="${WAVEMILL_LIB_DIR:-${LIB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}}"
source "$WAVEMILL_LIB_DIR/transient-marker.sh"

run_linear_retry_drain_tick() {
  [[ "$DRY_RUN" == "true" ]] && return 0

  local stamp_file="${STATE_DIR}/linear-retry-drain.last-run"
  local now last_run=0
  now="$(date +%s)"
  if [[ -f "$stamp_file" ]]; then
    last_run="$(cat "$stamp_file" 2>/dev/null || echo 0)"
  fi

  if (( now - last_run < 60 )); then
    return 0
  fi

  printf '%s\n' "$now" > "$stamp_file"
  npx tsx "$TOOLS_DIR/linear-retry-drain.ts" drain --max-entries 10 >/dev/null 2>&1 || true
}

# Classify a failure for reconciliation (HOK-2936): delegates to ready-watchdog.ts
# classifyForReconciliation to distinguish stale_base, transient CI, deterministic CI,
# merge conflicts, and ambiguous failures (REQ-F3: only LLM on deterministic/conflict).
classify_for_reconciliation() {
  local merge_status="$1" failed_check_summary="$2" checks_run="$3" checks_passed="$4"
  (cd "$REPO_DIR" && npx tsx "$TOOLS_DIR/classify-reconciliation.ts" \
    "$merge_status" "$failed_check_summary" "$checks_run" "$checks_passed" 2>/dev/null) || echo "ambiguous"
}

# Logging functions - defined early so they're available for all error handling
_log_level_num() {
  case "$1" in
    error) echo 0 ;;
    status) echo 1 ;;
    info) echo 2 ;;
    debug) echo 3 ;;
    *) echo 2 ;;
  esac
}

VERBOSITY_NUM=$(_log_level_num "${DASHBOARD_VERBOSITY:-info}")

append_status_log() {
  local payload="$1"
  [[ -n "${STATUS_LOG_FILE:-}" ]] || return 1

  while IFS= read -r line || [[ -n "$line" ]]; do
    printf '%s\n' "$line" >> "$STATUS_LOG_FILE" 2>/dev/null || return 1
  done <<< "$payload"
}

log() {
  local level="info"
  local msg
  case "${1:-}" in
    error|status|info|debug)
      level="$1"
      shift
      ;;
  esac
  msg="$*"
  msg="${msg#"${msg%%[![:space:]]*}"}"

  local ts formatted msg_num
  ts="$(date '+%H:%M:%S')"
  formatted="$ts  $msg"

  if [[ "${DASHBOARD_LOG_TO_FILE:-true}" == "true" ]] && [[ -n "${MILL_LOG_FILE:-}" ]]; then
    printf '%s [%s] %s\n' "$ts" "$level" "$msg" >> "$MILL_LOG_FILE" 2>/dev/null || true
  fi

  msg_num=$(_log_level_num "$level")
  if (( msg_num <= VERBOSITY_NUM )); then
    append_status_log "$formatted" || echo "$formatted"
  fi
}
log_task() {
  local level="$1" task_id="$2"
  shift 2
  log "$level" "$(wavemill_task_log_message "$task_id" "$*")"
}
# Errors and warnings are mirrored into the durable per-repo mill log as well
# as the ephemeral /tmp status log. log() already writes to both; these two
# bypassed it, so the highest-value lines — launch and routing failures — were
# the only ones missing from .wavemill/logs/mill-<session>.log. They are not
# routed through log() because the status-log fallback here writes to stderr,
# and these are called from inside command substitutions.
_mirror_to_mill_log() {
  local level="$1" msg="$2"
  [[ "${DASHBOARD_LOG_TO_FILE:-true}" == "true" ]] || return 0
  [[ -n "${MILL_LOG_FILE:-}" ]] || return 0
  printf '%s [%s] %s\n' "$(date '+%H:%M:%S')" "$level" "$msg" >> "$MILL_LOG_FILE" 2>/dev/null || true
}
log_error() {
  local m="$*"
  m="${m#"${m%%[![:space:]]*}"}"
  local formatted
  formatted="$(date '+%H:%M:%S')  ERROR: $m"
  _mirror_to_mill_log "error" "$m"
  append_status_log "$formatted" || echo "$formatted" >&2
}
log_warn() {
  local m="$*"
  m="${m#"${m%%[![:space:]]*}"}"
  local formatted
  formatted="$(date '+%H:%M:%S')  WARN: $m"
  _mirror_to_mill_log "warn" "$m"
  append_status_log "$formatted" || echo "$formatted" >&2
}

replay_route_transparency_logs() {
  local stderr_file="$1"
  [[ -s "$stderr_file" ]] || return 0

  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      "[router]"*|"[coder]"*|"[planner]"*|"[reviewer]"*|"[classifier]"*|"[hokusai-router]"*)
        log "info" "$line"
        ;;
    esac
  done < "$stderr_file"
}

# Mirrors save_migration_reservation() from the parent script (see HOK-1377, c6dbb1c precedent).
# Duplicated here because the monitor runs as a standalone shell and does not inherit parent functions.
save_migration_reservation() {
  local issue="$1"
  local num="$2"
  state_mutate "$STATE_FILE" \
    '.migrationReservations[$issue] = $num | .nextMigrationNum = ($num + 1)' \
    --arg issue "$issue" --argjson num "$num" >/dev/null || true
}

# Duplicated intentionally from the parent script because the monitor runs as a
# standalone generated shell script and does not inherit parent functions.
render_prompt_template() {
  local template_path="$1"
  shift

  if [[ ! -f "$template_path" ]]; then
    log_error "Prompt template not found: $template_path"
    return 1
  fi

  local content
  content="$(cat "$template_path")"

  local pair key value
  for pair in "$@"; do
    key="${pair%%=*}"
    value="${pair#*=}"
    content="${content//\{\{$key\}\}/$value}"
  done

  printf '%s' "$content"
}

indent_block() {
  local prefix="$1"
  while IFS= read -r line || [[ -n "$line" ]]; do
    printf '%s%s\n' "$prefix" "$line"
  done
}

_global_operating_mode() {
  npx tsx "$TOOLS_DIR/get-operating-mode.ts" global --repo-dir "$REPO_DIR" 2>/dev/null || echo "normal"
}

_update_effective_max_parallel() {
  EFFECTIVE_MAX_PARALLEL="$MAX_PARALLEL"

  if has_any_healthy_model "$REPO_DIR"; then
    return 0
  fi

  local global_mode
  global_mode="$(_global_operating_mode)"
  case "$global_mode" in
    survival)
      if (( MAX_PARALLEL > 1 )); then
        EFFECTIVE_MAX_PARALLEL=1
      fi
      ;;
    constrained)
      if (( MAX_PARALLEL > 3 )); then
        EFFECTIVE_MAX_PARALLEL=3
      fi
      ;;
  esac
}

# Timeout for external API calls (Linear, GitHub) to prevent monitor freeze.
# If an API call hangs, the entire monitoring loop blocks and the user cannot
# type 'q' or select tasks.  This value caps individual calls.
API_TIMEOUT="${API_TIMEOUT:-30}"

# Load shared agent launch adapters used by launch_task()
if [[ ! -f "$LIB_DIR/agent-adapters.sh" ]]; then
  log_error "Missing adapter library: $LIB_DIR/agent-adapters.sh"
  exit 1
fi
source "$LIB_DIR/agent-adapters.sh"

# Fail fast if required adapter functions are unavailable.
command -v agent_launch_autonomous >/dev/null 2>&1 || { log_error "agent_launch_autonomous is not defined"; exit 1; }
command -v agent_launch_interactive >/dev/null 2>&1 || { log_error "agent_launch_interactive is not defined"; exit 1; }

# Load shared functions (scoring, task packet detection)
if [[ ! -f "$LIB_DIR/wavemill-common.sh" ]]; then
  log_error "Missing common library: $LIB_DIR/wavemill-common.sh"
  exit 1
fi
source "$LIB_DIR/wavemill-common.sh"
if [[ -f "$LIB_DIR/terminal-reconciler.sh" ]]; then
source "$LIB_DIR/terminal-reconciler.sh"
fi
# Queue-health helpers used by the dependency queue planner path.
# Sourced after wavemill-common.sh so state_mutate is available.
if [[ -f "$LIB_DIR/queue-health.sh" ]]; then
source "$LIB_DIR/queue-health.sh"
fi
_update_effective_max_parallel

# Ensure gh commands target the correct GitHub repo (not inherited CWD)
cd "$REPO_DIR"

# Classify API failures conservatively so the monitor only retries errors that
# are likely to succeed on a later attempt.
is_transient_error() {
  local detail="${1:-}"

  [[ -n "$detail" ]] || return 1

  if printf '%s\n' "$detail" | grep -Eiq '(500|502|503|529|internal server error|service unavailable|bad gateway|overloaded)'; then
    return 0
  fi

  if printf '%s\n' "$detail" | grep -Eiq '(429|too many requests|rate limit|rate.limit)'; then
    return 0
  fi

  if printf '%s\n' "$detail" | grep -Eiq '(timeout|timed out|connection.*reset|connection.*refused|network.*error)'; then
    return 0
  fi

  if printf '%s\n' "$detail" | grep -Eiq '(401|403|400|unauthorized|forbidden|bad request|invalid.*key)'; then
    return 1
  fi

  return 1
}

CODEX_CAPACITY_MESSAGE="Selected model is at capacity. Please try a different model."
CODEX_CAPACITY_REASON="model_at_capacity"

wavemill_capacity_stall_seconds() {
  local raw="${WAVEMILL_CAPACITY_STALL_SECONDS:-45}"

  if [[ ! "$raw" =~ ^[0-9]+$ ]]; then
    printf '45\n'
    return 0
  fi

  if (( raw > 299 )); then
    printf '299\n'
    return 0
  fi

  printf '%s\n' "$raw"
}

codex_capacity_recovery_marker() {
  local feature_dir="$1"
  printf '%s\n' "$feature_dir/.coding-capacity-recovery.json"
}

codex_capacity_dwell_marker() {
  local feature_dir="$1"
  printf '%s\n' "$feature_dir/.coding-capacity-dwell.json"
}

codex_capacity_clear_dwell_marker() {
  local feature_dir="$1"
  rm -f "$(codex_capacity_dwell_marker "$feature_dir")" 2>/dev/null || true
}

codex_capacity_pane_tail() {
  local issue="$1" slug="$2" worktree="$3"
  local target=""

  target="$(_tmux_task_window_target "$SESSION" "$issue" "$slug" "${STATE_FILE:-}" "$worktree" 2>/dev/null || true)"
  [[ -n "$target" ]] || return 1

  tmux capture-pane -p -t "$target" -S -80 2>/dev/null || return 1
}

codex_capacity_tail_has_terminal_prompt() {
  local tail="${1-}"
  local last_nonempty=""
  local line=""
  local capacity_message="${CODEX_CAPACITY_MESSAGE:-Selected model is at capacity. Please try a different model.}"

  [[ -n "$tail" ]] || return 1
  printf '%s\n' "$tail" | grep -Fq "$capacity_message" || return 1

  while IFS= read -r line; do
    [[ -n "${line//[[:space:]]/}" ]] || continue
    last_nonempty="$line"
  done <<< "$tail"

  [[ -n "$last_nonempty" ]] || return 1
  [[ "$last_nonempty" != "$capacity_message" ]] || return 1

  if [[ "$last_nonempty" =~ ^[[:space:]]*(>|›|❯|\$|%|>>>)[[:space:]]*$ ]]; then
    return 0
  fi

  return 1
}

codex_capacity_hook_status() {
  local issue="$1"
  local hook_file="/tmp/wavemill-${SESSION}-${issue}.hook"
  local hook_state hook_agent hook_detail hook_ts now staleness
  local capacity_message="${CODEX_CAPACITY_MESSAGE:-Selected model is at capacity. Please try a different model.}"
  local capacity_reason="${CODEX_CAPACITY_REASON:-model_at_capacity}"

  [[ -f "$hook_file" ]] || return 1

  hook_state=$(jq -r '.state // empty' "$hook_file" 2>/dev/null || echo "")
  hook_agent=$(jq -r '.agent // empty' "$hook_file" 2>/dev/null || echo "")
  hook_detail=$(jq -r '.detail // empty' "$hook_file" 2>/dev/null || echo "")
  hook_ts=$(jq -r '.timestamp // 0' "$hook_file" 2>/dev/null || echo "0")

  [[ "$hook_state" == "error" ]] || return 1
  [[ -z "$hook_agent" || "$hook_agent" == "codex" ]] || return 1

  now="$(date +%s)"
  staleness=$(( now - hook_ts ))
  (( staleness >= 0 && staleness < 300 )) || return 1

  if [[ "$hook_detail" == ${capacity_reason}:* ]] || [[ "$hook_detail" == *"$capacity_message"* ]]; then
    return 0
  fi

  return 1
}

codex_capacity_record_dwell() {
  local feature_dir="$1" source="$2"
  local marker tmp_file now existing_first_seen existing_source first_seen

  marker="$(codex_capacity_dwell_marker "$feature_dir")"
  tmp_file="$(mktemp "$marker.tmp.XXXXXX" 2>/dev/null)" || return 1
  now="$(date +%s)"
  existing_first_seen="$(jq -r '.firstSeen // empty' "$marker" 2>/dev/null || echo "")"
  existing_source="$(jq -r '.source // empty' "$marker" 2>/dev/null || echo "")"

  if [[ -n "$existing_first_seen" && "$existing_first_seen" =~ ^[0-9]+$ && "$existing_source" == "$source" ]]; then
    first_seen="$existing_first_seen"
  else
    first_seen="$now"
  fi

  if ! jq -n \
    --arg source "$source" \
    --argjson firstSeen "$first_seen" \
    --argjson lastSeen "$now" \
    '{source: $source, firstSeen: $firstSeen, lastSeen: $lastSeen}' > "$tmp_file" 2>/dev/null; then
    rm -f "$tmp_file"
    return 1
  fi

  mv "$tmp_file" "$marker" 2>/dev/null || {
    rm -f "$tmp_file"
    return 1
  }

  printf '%s\n' "$first_seen"
}

codex_capacity_idle_confirmed() {
  local issue="$1" slug="$2" feature_dir="$3" worktree="$4"
  local source="" first_seen="" now dwell_seconds tail=""

  if codex_capacity_hook_status "$issue"; then
    source="hook"
  else
    tail="$(codex_capacity_pane_tail "$issue" "$slug" "$worktree" 2>/dev/null || true)"
    if codex_capacity_tail_has_terminal_prompt "$tail"; then
      source="pane"
    else
      codex_capacity_clear_dwell_marker "$feature_dir"
      return 1
    fi
  fi

  first_seen="$(codex_capacity_record_dwell "$feature_dir" "$source" 2>/dev/null || true)"
  [[ "$first_seen" =~ ^[0-9]+$ ]] || return 1

  now="$(date +%s)"
  dwell_seconds="$(wavemill_capacity_stall_seconds)"
  (( now - first_seen >= dwell_seconds ))
}

retry_state_file() {
  local session="$1"
  local issue="$2"
  printf '/tmp/wavemill-%s-%s.retry\n' "$session" "$issue"
}

get_retry_count() {
  local retry_file
  retry_file="$(retry_state_file "$1" "$2")"

  if [[ ! -f "$retry_file" ]]; then
    echo "0"
    return 0
  fi

  jq -r '.count // 0' "$retry_file" 2>/dev/null || echo "0"
}

get_retry_timestamp() {
  local retry_file
  retry_file="$(retry_state_file "$1" "$2")"

  if [[ ! -f "$retry_file" ]]; then
    echo "0"
    return 0
  fi

  jq -r '.timestamp // 0' "$retry_file" 2>/dev/null || echo "0"
}

increment_retry_count() {
  local session="$1"
  local issue="$2"
  local retry_file tmp_file current_count new_count timestamp

  retry_file="$(retry_state_file "$session" "$issue")"
  tmp_file="${retry_file}.tmp.$$"
  current_count="$(get_retry_count "$session" "$issue")"
  new_count=$((current_count + 1))
  timestamp="$(date +%s)"

  if jq -n \
    --argjson count "$new_count" \
    --argjson timestamp "$timestamp" \
    '{count: $count, timestamp: $timestamp}' > "$tmp_file" 2>/dev/null; then
    mv "$tmp_file" "$retry_file" 2>/dev/null || rm -f "$tmp_file"
  else
    rm -f "$tmp_file"
  fi
}

reset_retry_count() {
  local retry_file
  retry_file="$(retry_state_file "$1" "$2")"
  rm -f "$retry_file" 2>/dev/null || true
}

get_backoff_delay() {
  local count="${1:-0}"
  case "$count" in
    1) echo "30" ;;
    2) echo "60" ;;
    3) echo "120" ;;
    *) echo "240" ;;
  esac
}

handle_agent_error_recovery() {
  local issue="$1"
  local agent_cmd="$2"
  local hook_file="/tmp/wavemill-${SESSION}-${issue}.hook"
  local retry_file hook_state hook_agent error_detail hook_ts now staleness retry_count last_retry_ts backoff_delay
  local time_since_last_retry time_since_error next_retry max_retries

  retry_file="$(retry_state_file "$SESSION" "$issue")"
  [[ -f "$hook_file" ]] || return 0

  # Native agents are single processes that exit on failure — there is no live
  # TUI to send-keys a resume into, so this path would type into a dead pane,
  # burn the retry counter, and race the challenger phase-relaunch machinery
  # (maybe_retry_challenger_transient_phase). Native failures are handled by
  # phase relaunch instead.
  hook_agent=$(jq -r '.agent // empty' "$hook_file" 2>/dev/null || echo "")
  [[ "$hook_agent" != "native" ]] || return 0

  hook_state=$(jq -r '.state // empty' "$hook_file" 2>/dev/null || echo "")
  error_detail=$(jq -r '.detail // empty' "$hook_file" 2>/dev/null || echo "")
  hook_ts=$(jq -r '.timestamp // 0' "$hook_file" 2>/dev/null || echo "0")

  now="$(date +%s)"
  staleness=$(( now - hook_ts ))

  if [[ "$hook_state" != "error" ]]; then
    if [[ -f "$retry_file" ]] && [[ "$hook_state" == "working" || "$hook_state" == "waiting" || "$hook_state" == "idle" ]]; then
      last_retry_ts="$(get_retry_timestamp "$SESSION" "$issue")"
      if (( hook_ts >= last_retry_ts )); then
        log "info" "Agent recovered for $issue, resetting retry count"
        reset_retry_count "$SESSION" "$issue"
      fi
    fi
    return 0
  fi

  if ! is_transient_error "$error_detail"; then
    return 0
  fi

  retry_count="$(get_retry_count "$SESSION" "$issue")"
  max_retries=4
  last_retry_ts="$(get_retry_timestamp "$SESSION" "$issue")"
  if (( staleness >= 300 )); then
    if (( retry_count > 0 )); then
      terminalize_transient_retry_failure "$issue" "$agent_cmd" "$error_detail" "retry process stopped updating after a transient error"
    fi
    return 0
  fi

  if (( retry_count >= max_retries )); then
    time_since_last_retry=$(( now - last_retry_ts ))
    if (( hook_ts >= last_retry_ts )) || [[ "$time_since_last_retry" -ge 300 ]]; then
      terminalize_transient_retry_failure "$issue" "$agent_cmd" "$error_detail" "transient retries exhausted"
    fi
    return 0
  fi

  backoff_delay="$(get_backoff_delay $((retry_count + 1)))"
  time_since_last_retry=$(( now - last_retry_ts ))

  if (( retry_count == 0 )); then
    time_since_error=$(( now - hook_ts ))
    (( time_since_error >= backoff_delay )) || return 0
  else
    (( time_since_last_retry >= backoff_delay )) || return 0
  fi

  next_retry=$((retry_count + 1))
  log "info" "Retrying $issue after transient error (attempt $next_retry/$max_retries, backoff ${backoff_delay}s): $error_detail"
  increment_retry_count "$SESSION" "$issue"

  if agent_resume_after_error "$SESSION" "$issue" "$agent_cmd"; then
    log "debug" "  Resume command sent to $issue"
  else
    log_error "  Failed to resume $issue after transient error"
    terminalize_transient_retry_failure "$issue" "$agent_cmd" "$error_detail" "retry resume command failed"
  fi
}

terminalize_transient_retry_failure() {
  local issue="$1" agent_cmd="${2:-}" error_detail="${3:-}" terminal_reason="${4:-transient retry failed}"
  local slug wt_dir phase result_stage feature_dir is_challenge pr model notes artifacts_json win next_action

  [[ -n "$issue" ]] || return 1
  slug=$(read_state_value "" --arg i "$issue" '.tasks[$i].slug // empty')
  wt_dir=$(read_state_value "" --arg i "$issue" '.tasks[$i].worktree // empty')
  [[ -z "$wt_dir" && -n "$slug" ]] && wt_dir="${WORKTREE_ROOT}/${slug}"
  phase=$(read_state_value "coding" --arg i "$issue" '.tasks[$i].phase // "coding"')
  case "$phase" in
    planning|coding|review|ready) result_stage="$phase" ;;
    *) result_stage="coding" ;;
  esac
  [[ -n "$wt_dir" && -n "$slug" ]] && feature_dir="${wt_dir}/features/${slug}"

  next_action="transient upstream failure persisted, retire the challenge arm and relaunch if needed"
  notes="Native ${result_stage} failed after retry recovery (${terminal_reason}): ${error_detail}. Next: ${next_action}"
  artifacts_json="$(jq -cn \
    --arg failureKind "provider-transient-error" \
    --arg detail "$error_detail" \
    --arg terminalReason "$terminal_reason" \
    --arg nextAction "$next_action" \
    '{type:"transientRetryFailure", failureKind:$failureKind, detail:$detail, terminalReason:$terminalReason, nextAction:$nextAction}' \
    2>/dev/null || printf '{}')"

  if [[ -n "$feature_dir" ]]; then
    model="$(stage_result_field "$feature_dir" "$result_stage" "model" 2>/dev/null || true)"
    write_stage_result "$feature_dir" "$result_stage" "failed" "$agent_cmd" "$model" "$notes" "$artifacts_json"
  fi

  state_mutate "$STATE_FILE" '
    if .tasks[$issue] == null then
      .
    else
      .tasks[$issue].status = "error"
      | .tasks[$issue].retryFailure = $reason
      | .tasks[$issue].retryFailureDetail = $detail
      | .tasks[$issue].updated = (now | todateiso8601)
    end
  ' --arg issue "$issue" --arg reason "$terminal_reason" --arg detail "$error_detail" >/dev/null 2>&1 || true

  is_challenge="$(get_task_meta "$issue" "challenge" 2>/dev/null || true)"
  pr=$(read_state_value "" --arg i "$issue" '.tasks[$i].pr // empty')
  if [[ "$is_challenge" == "true" && -z "$pr" && -n "$feature_dir" ]]; then
    win="${issue}-${slug}"
    challenge_abort_pair "$issue" "$feature_dir" "$win" "$result_stage" "$model" \
      "retry_exhausted:provider-transient-error" "$notes" "$next_action" \
      "$(challenge_abort_scope_for_failure "$issue" "provider-transient-error")" || true
    cleanup_quarantined_no_pr_challenge_arm "$issue" "$feature_dir" "$result_stage" "$terminal_reason" || true
    log_warn "$issue → challenge arm failed after transient retry recovery. Pair quarantined. $next_action"
  else
    log_warn "$issue → transient retry recovery reached terminal state: $terminal_reason"
  fi
  return 0
}

transient_error_recovery_pending() {
  local issue="$1"
  local hook_file="/tmp/wavemill-${SESSION}-${issue}.hook"
  local hook_state hook_agent error_detail hook_ts now staleness retry_count

  [[ -f "$hook_file" ]] || return 1

  # Mirror the native guard in handle_agent_error_recovery: a dead native
  # process must not be held "active" by the TUI resume path.
  hook_agent=$(jq -r '.agent // empty' "$hook_file" 2>/dev/null || echo "")
  [[ "$hook_agent" != "native" ]] || return 1

  hook_state=$(jq -r '.state // empty' "$hook_file" 2>/dev/null || echo "")
  [[ "$hook_state" == "error" ]] || return 1

  error_detail=$(jq -r '.detail // empty' "$hook_file" 2>/dev/null || echo "")
  is_transient_error "$error_detail" || return 1

  hook_ts=$(jq -r '.timestamp // 0' "$hook_file" 2>/dev/null || echo "0")
  now="$(date +%s)"
  staleness=$(( now - hook_ts ))
  (( staleness < 300 )) || return 1

  retry_count="$(get_retry_count "$SESSION" "$issue")"
  (( retry_count < 4 ))
}

# Close auxiliary panes when monitor exits so quitting control is a single action.
_AUX_PANES_CLEANED=0
cleanup_dashboard_pane() {
  [[ "$_AUX_PANES_CLEANED" -eq 1 ]] && return 0
  _AUX_PANES_CLEANED=1

  for pane in 1 2; do
    tmux list-panes -t "$SESSION:$WAVEMILL_WINDOW_MILL.$pane" >/dev/null 2>&1 || continue
    tmux kill-pane -t "$SESSION:$WAVEMILL_WINDOW_MILL.$pane" >/dev/null 2>&1 || true
  done
}
trap cleanup_dashboard_pane EXIT INT TERM

# Kill entire tmux session for single-step quit.
quit_and_kill_session() {
  local message="${1:-Quitting.}"
  log "status" "$message"

  # If running inside tmux, kill the entire session for single-step quit
  if [[ -n "${TMUX:-}" ]]; then
    # Use exec to replace current process with tmux kill-session
    # This prevents "session destroyed" message and provides clean exit
    exec tmux kill-session -t "$SESSION"
  else
    # Not in tmux (e.g., testing or direct execution) - exit normally
    exit 0
  fi
}

monitor_err_trap() {
  local rc=$?
  # Ignore SIGINT (130) and SIGTERM (143) - these are intentional user interruptions
  if [[ $rc -eq 130 || $rc -eq 143 ]]; then
    return 0
  fi
  local line="${BASH_LINENO[0]:-$LINENO}"
  log_error "Monitor command failed at line $line (exit $rc): $BASH_COMMAND"
}
trap monitor_err_trap ERR


# ============================================================================
# STATE MANAGEMENT FUNCTIONS
# ============================================================================
# These functions manage task state in the workflow state file. The canonical
# save_task_state writer is provided by wavemill-common.sh (sourced above);
# only monitor-local state helpers are defined here.

mark_task_needs_user_and_defer() {
  local issue="$1" slug="${2:-}" reason="${3:-launch_failed}" detail="${4:-launch failed}"
  local branch wt_dir feature_dir linear_issue win recovery_action

  if [[ -z "$slug" && -n "${STATE_FILE:-}" && -f "$STATE_FILE" ]]; then
    slug="$(jq -r --arg issue "$issue" '.tasks[$issue].slug // empty' "$STATE_FILE" 2>/dev/null || true)"
  fi
  [[ -n "$slug" ]] || slug="$(printf '%s' "$issue" | tr '[:upper:]' '[:lower:]')"

  branch="task/${slug}"
  wt_dir="${WORKTREE_ROOT}/${slug}"
  feature_dir="${wt_dir}/features/${slug}"
  linear_issue="$(get_linear_issue_id "$issue" 2>/dev/null || printf '%s' "$issue")"
  recovery_action="Retry with enter ${issue} after fixing routing, or run: wavemill config migrate-model-settings"

  mkdir -p "$feature_dir" 2>/dev/null || true
  cat > "$feature_dir/.routing-failure" <<EOF
issue=$issue
reason=$reason
detail=$detail
recovery=$recovery_action
EOF
  jq -n \
    --arg issue "$issue" \
    --arg reason "$reason" \
    --arg detail "$detail" \
    --arg recovery "$recovery_action" \
    '{issue: $issue, reason: $reason, detail: $detail, recoveryAction: $recovery, createdAt: (now | todateiso8601)}' \
    > "$feature_dir/.routing-failure.json" 2>/dev/null || true

  save_task_state "$issue" "$slug" "$branch" "$wt_dir" "" "needs-user" "${AGENT_CMD:-}" "$linear_issue"
  if [[ -n "${STATE_FILE:-}" && -f "$STATE_FILE" ]]; then
    state_mutate "$STATE_FILE" '
      .tasks[$issue].phase = "needs-user"
      | .tasks[$issue].launchFailure = {
          reason: $reason,
          detail: $detail,
          recoveryAction: $recovery,
          updated: (now | todateiso8601)
        }
      | .tasks[$issue].updated = (now | todate)
    ' --arg issue "$issue" --arg reason "$reason" --arg detail "$detail" --arg recovery "$recovery_action" >/dev/null || true
  fi
  win="${issue}-${slug}"
  set_window_attention_state "$win" "needs-user"
  log_error "  Selected route is not launchable for $issue: $detail. $recovery_action"
  return 0
}

dispatch_task_and_persist() {
  local issue="${1:-unknown}" slug="${2:-}" rc=0
  launch_task "$@" || rc=$?
  if (( rc != 0 )); then
    log_error "launch_task failed for $issue (exit $rc); monitor continues"
    mark_task_needs_user_and_defer "$issue" "$slug" "launch_failed" "launch_task exit $rc"
  fi
  return 0
}

# A challenge intent is sealed once any stage it describes has produced a
# result. After that point it is evidence about a run that already happened,
# not a routing decision that can still be revised.
# Usage: challenge_intent_is_sealed <feature_dir>
challenge_intent_is_sealed() {
  local feature_dir="$1" stage status
  [[ -n "$feature_dir" ]] || return 1

  for stage in planning coding review; do
    status=$(read_stage_status "$feature_dir" "$stage" 2>/dev/null || true)
    # `running` is deliberately included: a stage that has started is already
    # executing against this intent.
    case "$status" in
      running|awaiting_user|completed|failed|aborted) return 0 ;;
    esac
  done

  [[ -f "$feature_dir/.coding-complete" ]] && return 0
  return 1
}

# Single writer for the challenge intent, on every surface it is read from.
#
# Accepts one or more feature directories so both arms of a pair get an
# identical on-disk copy.  Previously only the primary's worktree received a
# file, so the two sides resolved their intent from different sources and could
# disagree about which stage was varied.
persist_challenge_execution_intent() {
  local issue="$1" challenger_key="${2:-}" feature_dir="${3:-}" intent_json="${4:-}"
  shift 4 2>/dev/null || true
  local extra_feature_dirs=("$@")
  [[ -n "$issue" && -n "$intent_json" ]] || return 0
  echo "$intent_json" | jq -e '.schemaVersion == 1 and (.pairId // "") != "" and (.issueId // "") != ""' >/dev/null 2>&1 || return 0

  local dir intent_file
  for dir in "$feature_dir" "${extra_feature_dirs[@]}"; do
    [[ -n "$dir" && -d "$dir" ]] || continue
    intent_file="$dir/.challenge-intent.json"

    # The intent is the pre-registered hypothesis: which stage is varied and
    # with which model. Once any stage it describes has produced a result it
    # must never be rewritten, or the record ends up describing a challenge
    # that never ran.
    #
    # This was previously gated on the task being in the `coding` phase, which
    # left it writable during planning and after review. A re-approval during
    # planning could therefore overwrite an intent whose coding phase had
    # already completed hours earlier — see HOK-2767, where a pair that
    # actually ran an implementation-stage challenge was relabelled as a
    # plan-stage challenge against a model that never executed.
    if [[ -f "$intent_file" ]] && challenge_intent_is_sealed "$dir"; then
      continue
    fi

    printf '%s\n' "$intent_json" | jq -S . > "$intent_file" 2>/dev/null || true

    # Seed the write-once selection record that readers prefer over the mutable
    # file above. Only the challenger arm used to receive one, so when the
    # mutable copy was later overwritten the two sides of a pair resolved
    # different intents and disagreed about which stage was varied. Reached
    # only while the intent is still unsealed, so it always captures the
    # pre-execution selection.
    if [[ ! -f "$dir/challenge-intent.json" ]]; then
      printf '%s\n' "$intent_json" | jq -S . > "$dir/challenge-intent.json" 2>/dev/null || true
    fi
  done

  # Promote each side's varied stage model into first-class state fields.
  #
  # Until now the varied model for a plan- or review-stage challenge lived only
  # inside .routing-complete, the one artifact a rerouting pass overwrites, so
  # those stages had no equivalent of the challengeModel backstop that the
  # implementation stage has always enjoyed.  Deriving them here keeps a single
  # writer: they come straight off the canonical intent.
  state_mutate "$STATE_FILE" \
    '($intent.selectedStage // $intent.challengeStage // "") as $stage
     | ($intent.primary // {}) as $p
     | ($intent.challenger // {}) as $c
     | .tasks[$issue].challengeExecutionIntent = $intent
     | (if $stage != "" then .tasks[$issue].challengeStage = $stage else . end)
     | (if ($p.expectedStageModel // "") != ""
        then .tasks[$issue].challengeVariedModel = $p.expectedStageModel
             | .tasks[$issue].challengeVariedAgent = ($p.expectedStageAgent // "")
        else . end)
     | if $challenger != "" and (.tasks[$challenger] != null)
       then .tasks[$challenger].challengeExecutionIntent = $intent
            | (if $stage != "" then .tasks[$challenger].challengeStage = $stage else . end)
            | (if ($c.expectedStageModel // "") != ""
               then .tasks[$challenger].challengeVariedModel = $c.expectedStageModel
                    | .tasks[$challenger].challengeVariedAgent = ($c.expectedStageAgent // "")
               else . end)
       else .
       end' \
    --arg issue "$issue" \
    --arg challenger "$challenger_key" \
    --argjson intent "$intent_json" || true
}

# The model this task's challenge selected for the stage about to launch.
#
# Returns empty unless the task is a challenge participant AND the stage being
# launched is the one the pair varies — so it can be applied unconditionally at
# every launch site without disturbing non-challenge runs or shared stages.
challenge_varied_stage_model() {
  local issue="$1" stage="$2"
  local task_stage selected_model
  [[ -n "$issue" ]] || return 0
  task_stage=$(get_task_meta "$issue" "challengeStage" 2>/dev/null || true)
  [[ -n "$task_stage" ]] || return 0

  # Map the launch phase name onto the challenge stage vocabulary.  Each arm is
  # a single pattern rather than an `a|b)` alternation: the monitor heredoc
  # guard in tests/check-shell.sh reads `|word)` as a command position and would
  # report `planning` and `implementation` as undefined function calls.
  local wanted=""
  case "$stage" in
    plan) wanted="plan" ;;
    planning) wanted="plan" ;;
    review) wanted="review" ;;
    coding) wanted="implementation" ;;
    implementation) wanted="implementation" ;;
    *) return 0 ;;
  esac
  [[ "$task_stage" == "$wanted" ]] || return 0

  selected_model=$(get_task_meta "$issue" "challengeVariedModel" 2>/dev/null || true)
  [[ -n "$selected_model" ]] || return 0
  printf '%s' "$selected_model"
}

challenge_result_stage_for_launch() {
  case "${1:-}" in
    plan) printf '%s\n' "planning" ;;
    planning) printf '%s\n' "planning" ;;
    coding) printf '%s\n' "coding" ;;
    implementation) printf '%s\n' "coding" ;;
    review) printf '%s\n' "review" ;;
    *) printf '%s\n' "${1:-}" ;;
  esac
}

challenge_stage_for_launch_env() {
  case "${1:-}" in
    plan) printf '%s\n' "plan" ;;
    planning) printf '%s\n' "plan" ;;
    coding) printf '%s\n' "implementation" ;;
    implementation) printf '%s\n' "implementation" ;;
    review) printf '%s\n' "review" ;;
    *) printf '%s\n' "${1:-}" ;;
  esac
}

challenge_selection_health_varied_model() {
  local stage
  stage="$(challenge_stage_for_launch_env "${1:-implementation}")"
  case "$stage" in
    plan) printf '%s\n' "${2:-${3:-}}" ;;
    review) printf '%s\n' "${4:-${3:-}}" ;;
    *) printf '%s\n' "${3:-}" ;;
  esac
}

challenge_selection_health_ack_launch() {
  local pair_id="${1:-}" stage="${2:-}" model="${3:-}"
  [[ -n "$pair_id" && -n "$stage" && -n "$model" && -n "${REPO_DIR:-}" ]] || return 0
  [[ -f "$REPO_DIR/tools/challenge-selection-health.ts" ]] || return 0
  (
    cd "$REPO_DIR" && npx tsx tools/challenge-selection-health.ts ack-launch \
      --repo-dir "$REPO_DIR" \
      --pair-id "$pair_id" \
      --stage "$(challenge_stage_for_launch_env "$stage")" \
      --model "$model"
  ) >/dev/null 2>&1 || true
}

challenge_selection_health_release() {
  local pair_id="${1:-}" stage="${2:-}" model="${3:-}"
  [[ -n "$pair_id" && -n "$stage" && -n "$model" && -n "${REPO_DIR:-}" ]] || return 0
  [[ -f "$REPO_DIR/tools/challenge-selection-health.ts" ]] || return 0
  (
    cd "$REPO_DIR" && npx tsx tools/challenge-selection-health.ts release \
      --repo-dir "$REPO_DIR" \
      --pair-id "$pair_id" \
      --stage "$(challenge_stage_for_launch_env "$stage")" \
      --model "$model"
  ) >/dev/null 2>&1 || true
}

write_openrouter_warning_cache() {
  local warning_text="${1:-}"
  local warning_file="/tmp/${SESSION}-openrouter-warning.txt"

  if [[ -n "$warning_text" ]]; then
    printf '%s\n' "$warning_text" > "$warning_file" 2>/dev/null || true
  else
    rm -f "$warning_file" 2>/dev/null || true
  fi
}

record_openrouter_credits_challenge_abort() {
  local state_dir count_file lock_dir count
  state_dir="${WAVEMILL_STATE_DIR:-}"
  if [[ -z "$state_dir" && -n "${STATE_FILE:-}" ]]; then
    state_dir="$(dirname "$STATE_FILE")"
  fi
  [[ -n "$state_dir" ]] || state_dir="/tmp"
  mkdir -p "$state_dir" 2>/dev/null || true

  count_file="$state_dir/openrouter-credits-abort-count"
  lock_dir="$state_dir/openrouter-credits-abort-count.lock"
  local attempt=0
  while ! mkdir "$lock_dir" 2>/dev/null; do
    attempt=$((attempt + 1))
    [[ "$attempt" -le 50 ]] || return 0
    sleep 0.05
  done
  count="$(cat "$count_file" 2>/dev/null || echo 0)"
  [[ "$count" =~ ^[0-9]+$ ]] || count=0
  count=$((count + 1))
  printf '%s\n' "$count" > "$count_file" 2>/dev/null || true
  rm -rf "$lock_dir" 2>/dev/null || true

  if [[ "$count" -ge 2 ]]; then
    write_openrouter_warning_cache "OpenRouter credits exhausted - challenge coverage disabled, top up at https://openrouter.ai/credits"
  fi
}

# Decide the challenge_abort_pair scope for a terminal arm failure.
#
# A challenger arm dying on a transient provider fault (mid-stream upstream
# stall, 5xx, rate limit) must not drag the healthy primary down with it —
# abort only the failing side so the pair can still resolve by forfeit.
# Non-transient challenger failures and primary-side failures keep today's
# pair-wide quarantine; broader isolation is an explicit non-goal of HOK-2885.
challenge_abort_scope_for_failure() {
  local issue="$1" failure_kind="$2"
  local role
  role="$(_challenge_side_for_issue "$issue" 2>/dev/null || true)"
  if [[ "$role" == "challenger" && "$failure_kind" == "provider-transient-error" ]]; then
    printf 'single\n'
  else
    printf 'pair\n'
  fi
}

# Quarantine a challenge pair (or one arm of it) and record why.
#
# A challenge is only meaningful when both arms actually ran, so a terminal
# failure on either side normally invalidates the comparison. Marking both arms
# (and writing the artifact) keeps the comparison from being scored later, and
# keeps the reason attached to the evidence rather than inferred after the fact.
#
# The optional 9th arg `scope` ("pair" default | "single") restricts the state
# stamp to the failing arm only. Used when a challenger dies on a transient
# provider fault (HOK-2885): stamping the healthy primary too would cost it its
# eval for a fault it did not have, and would make the pair classify as
# both-challenge-aborted — leaving the existing sibling-challenge-aborted
# forfeit-to-survivor path in challenge-pair-resolver.ts unreachable. With
# scope=single the primary keeps running, and the resolver later forfeits the
# pair to it (terminalReason: challenger_challenge_aborted).
challenge_abort_pair() {
  local issue="$1" feature_dir="$2" win="$3" stage="$4" model="$5" reason="$6" detail="$7" next_action="${8:-}" scope="${9:-pair}"
  local result_stage pair_id role peer now artifact tmp
  [[ -n "$issue" && -n "$feature_dir" && -n "$stage" && -n "$reason" ]] || return 1
  [[ "$scope" == "single" ]] || scope="pair"

  result_stage="$(challenge_result_stage_for_launch "$stage")"
  pair_id="$(get_task_meta "$issue" "challengePairId" 2>/dev/null || true)"
  role="$(get_task_meta "$issue" "challengeRole" 2>/dev/null || true)"
  if [[ -n "$pair_id" ]]; then
    if [[ "$role" == "challenger" ]]; then
      peer="$pair_id"
    else
      peer="${pair_id}_c"
    fi
  fi
  now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  write_stage_result "$feature_dir" "$result_stage" "failed" "" "$model" "$detail"

  if [[ -n "${STATE_FILE:-}" && -f "$STATE_FILE" ]]; then
    state_mutate "$STATE_FILE" \
      'def mark($key):
         if ($key != "" and .tasks[$key] != null)
         then .tasks[$key].challengeAborted = $reason
              | .tasks[$key].challengeAbortedDetail = $detail
              | .tasks[$key].challengeAbortedStage = $stage
              | (if $nextAction != "" then .tasks[$key].challengeAbortedNextAction = $nextAction else . end)
              | .tasks[$key].updated = (now | todate)
         else .
         end;
       mark($issue) | (if $scope == "pair" then mark($peer) else . end)' \
      --arg issue "$issue" \
      --arg peer "${peer:-}" \
      --arg reason "$reason" \
      --arg detail "$detail" \
      --arg stage "$(challenge_stage_for_launch_env "$stage")" \
      --arg nextAction "$next_action" \
      --arg scope "$scope" >/dev/null 2>&1 || true
  fi

  mkdir -p "$feature_dir"
  artifact="$feature_dir/.challenge-aborted.json"
  tmp="$artifact.tmp.$$"
  jq -n -S \
    --arg pairId "${pair_id:-$issue}" \
    --arg stage "$(challenge_stage_for_launch_env "$stage")" \
    --arg model "$model" \
    --arg reason "$reason" \
    --arg abortedAt "$now" \
    --arg detail "$detail" \
    --arg nextAction "$next_action" \
    '{pairId:$pairId, stage:$stage, model:$model, reason:$reason, abortedAt:$abortedAt, detail:$detail}
     + (if $nextAction == "" then {} else {nextAction:$nextAction} end)' \
    > "$tmp" 2>/dev/null && mv "$tmp" "$artifact" || rm -f "$tmp"

  if [[ -n "${REPO_DIR:-}" && -f "$REPO_DIR/tools/record-arm-failure.ts" && ( "$role" == "primary" || "$role" == "challenger" ) ]]; then
    (
      cd "$REPO_DIR" && npx tsx tools/record-arm-failure.ts \
        --repo-dir "${WAVEMILL_RELIABILITY_REPO_DIR:-$REPO_DIR}" \
        --issue "$issue" \
        --pair-id "${pair_id:-$issue}" \
        --role "$role" \
        --stage "$(challenge_stage_for_launch_env "$stage")" \
        --model "${model:-unknown}" \
        --abort-reason "$reason" \
        --detail "$detail" \
        --next-action "$next_action"
    ) >/dev/null 2> >(while IFS= read -r line; do log_warn "$line"; done) || true
  fi

  if [[ "$reason" == *"openrouter-credits-exhausted"* ]]; then
    record_openrouter_credits_challenge_abort || true
  fi

  set_window_attention_state "$win" "needs-user"
  return 0
}

challenge_abort_for_unresolvable_varied_model() {
  local issue="$1" feature_dir="$2" win="$3" stage="$4" model="$5" diagnostic="${6:-}"
  local detail
  [[ -n "$issue" && -n "$feature_dir" && -n "$stage" && -n "$model" ]] || return 1

  detail="Challenge aborted: varied ${stage} model ${model} failed validation"
  [[ -n "$diagnostic" ]] && detail="${detail}: ${diagnostic}"

  log_error "  $issue: challenge aborted because selected ${stage} model '$model' failed validation${diagnostic:+ ($diagnostic)}"
  challenge_abort_pair "$issue" "$feature_dir" "$win" "$stage" "$model" "varied_model_unresolvable" "$detail"
}

challenge_guard_varied_model_resolvable() {
  local issue="$1" feature_dir="$2" win="$3" stage="$4" candidate_model="${5:-}"
  local selected_model diagnostic
  selected_model="$(challenge_varied_stage_model "$issue" "$stage" 2>/dev/null || true)"
  [[ -n "$selected_model" ]] || return 0
  [[ -z "$candidate_model" || "$candidate_model" == "$selected_model" ]] || return 0

  if agent_validate_model "$selected_model" "$REPO_DIR" >/dev/null 2>&1; then
    return 0
  fi

  if agent_model_looks_like_depth_tag "$selected_model"; then
    diagnostic="model selector looks like a depth tag"
  else
    diagnostic="model selector is not valid for this repo"
  fi
  challenge_abort_for_unresolvable_varied_model "$issue" "$feature_dir" "$win" "$stage" "$selected_model" "$diagnostic"
  return 1
}

native_launch_preflight_failed_json() {
  local json="${AGENT_NATIVE_LAUNCH_LAST_JSON:-}"
  [[ -n "$json" ]] || return 1
  command -v jq >/dev/null 2>&1 || return 1
  printf '%s' "$json" | jq -e '.ok == false' >/dev/null 2>&1
}

format_native_launch_preflight_detail() {
  local json="${AGENT_NATIVE_LAUNCH_LAST_JSON:-}"
  [[ -n "$json" ]] || return 1
  command -v jq >/dev/null 2>&1 || return 1
  printf '%s' "$json" | jq -r '
    [
      (if (.code // "") != "" then "code=" + .code else empty end),
      (if (.surface // "") != "" then "surface=" + .surface else empty end),
      (if (.reason // "") != "" then "reason=" + .reason else empty end),
      (if (.remediation // "") != "" then "remediation=" + .remediation else empty end)
    ] | join("; ")
  ' 2>/dev/null
}

log_native_launch_preflight_detail() {
  local issue="$1" stage="$2" agent="$3" model="$4"
  local json="${AGENT_NATIVE_LAUNCH_LAST_JSON:-}" detail
  native_launch_preflight_failed_json || return 1
  detail="$(printf '%s' "$json" | jq -c \
    --arg route "$issue" \
    --arg stage "$stage" \
    --arg agent "$agent" \
    --arg model "$model" \
    '{route:$route, stage:$stage, agent:$agent, model:$model,
      code:(.code // ""), surface:(.surface // ""), reason:(.reason // ""),
      remediation:(.remediation // "")}' 2>/dev/null)" || return 1
  log "warn" "native launch preflight detail: $detail"
}

challenge_abort_for_native_preflight_varied_model() {
  local issue="$1" feature_dir="$2" win="$3" stage="$4" agent="$5" model="$6"
  local selected_model json_model json_alias diagnostic
  [[ -n "$issue" && -n "$feature_dir" && -n "$stage" && -n "$model" ]] || return 1
  native_launch_preflight_failed_json || return 1
  if declare -F agent_is_native_cmd >/dev/null 2>&1; then
    agent_is_native_cmd "$agent" || return 1
  fi

  selected_model="$(challenge_varied_stage_model "$issue" "$stage" 2>/dev/null || true)"
  [[ -n "$selected_model" ]] || return 1
  json_model="$(printf '%s' "${AGENT_NATIVE_LAUNCH_LAST_JSON:-}" | jq -r '.model // empty' 2>/dev/null || true)"
  json_alias="$(printf '%s' "${AGENT_NATIVE_LAUNCH_LAST_JSON:-}" | jq -r '.wavemillAlias // empty' 2>/dev/null || true)"
  [[ "$model" == "$selected_model" || "$json_model" == "$selected_model" || "$json_alias" == "$selected_model" ]] || return 1

  diagnostic="$(format_native_launch_preflight_detail 2>/dev/null || true)"
  challenge_abort_for_unresolvable_varied_model "$issue" "$feature_dir" "$win" "$stage" "$selected_model" "$diagnostic"
}

challenge_plan_stage_requires_effective_route() {
  local challenge_plan="$1"
  local challenge_mode challenge_stage decision_source

  challenge_mode=$(echo "$challenge_plan" | jq -r '.mode // "single"' 2>/dev/null || echo "single")
  [[ "$challenge_mode" == "challenge" ]] || return 1

  challenge_stage=$(echo "$challenge_plan" | jq -r '.challengeStage // "implementation"' 2>/dev/null || echo "implementation")
  [[ "$challenge_stage" == "planning" || "$challenge_stage" == "plan" || "$challenge_stage" == "planner" ]] || return 1

  decision_source=$(echo "$challenge_plan" | jq -r '.decisionSource // "bootstrap"' 2>/dev/null || echo "bootstrap")
  [[ "$decision_source" != "expanded" && "$decision_source" != "preserved" ]]
}

log_challenge_unavailable_plan() {
  local issue="$1"
  local challenge_plan="$2"
  local requested_rate

  requested_rate=$(echo "$challenge_plan" | jq -r '.requestedRate // empty' 2>/dev/null || echo "")
  log_error "  $issue: challenge required${requested_rate:+ (rate=$requested_rate)} but no valid pair could form"
  echo "$challenge_plan" | jq -r '.blockers[]? | "  blocker: \(.kind) \(.field // .modelId // "") \(.reason // "")"' 2>/dev/null | while IFS= read -r line; do
    [[ -n "$line" ]] && log_error "$line"
  done
  echo "$challenge_plan" | jq -r '.candidateDiagnostics[]? | "  candidate: \(.modelId) reason=\(.reason) provider=\(.provider // "unknown")"' 2>/dev/null | while IFS= read -r line; do
    [[ -n "$line" ]] && log_error "$line"
  done
}

log_challenge_selection_health_plan() {
  local issue="$1" challenge_plan="$2"
  local reserved circuit reason
  reserved=$(echo "$challenge_plan" | jq -r '(.selectionHealth.excludedByReservation // []) | length' 2>/dev/null || echo "0")
  circuit=$(echo "$challenge_plan" | jq -r '(.selectionHealth.excludedByCircuit // []) | length' 2>/dev/null || echo "0")
  reason=$(echo "$challenge_plan" | jq -r '.reason // empty' 2>/dev/null || echo "")
  if [[ "$reserved" != "0" || "$circuit" != "0" || "$reason" == "challenge_deferred_selection_health" ]]; then
    log "status" "  $issue: challenge selection health filtered candidates (reserved=$reserved, circuit=$circuit, reason=${reason:-selected})"
  fi
}

release_challenge_selection_health_plan() {
  local issue="$1" challenge_plan="$2"
  local stage model
  stage=$(echo "$challenge_plan" | jq -r '.challengeStage // empty' 2>/dev/null || echo "")
  model=$(echo "$challenge_plan" | jq -r '.entries[1].variedModel // .entries[1].model // empty' 2>/dev/null || echo "")
  [[ -n "$stage" && -n "$model" && -n "${REPO_DIR:-}" ]] || return 0
  [[ -f "$REPO_DIR/tools/challenge-selection-health.ts" ]] || return 0
  (
    cd "$REPO_DIR" && npx tsx tools/challenge-selection-health.ts release \
      --repo-dir "$REPO_DIR" \
      --pair-id "$issue" \
      --stage "$stage" \
      --model "$model"
  ) >/dev/null 2>&1 || true
}

record_planning_launch_route_snapshot() {
  local feature_dir="$1" model="$2" agent="$3" depth="$4" source="${5:-effective-route}"
  local route_file="$feature_dir/.routing-complete"
  local phase_file="$feature_dir/.phase-config.json"
  [[ -n "$feature_dir" && -n "$model" ]] || return 0
  [[ -f "$phase_file" ]] || return 0

  local snapshot
  if [[ -f "$route_file" ]] && jq -e . "$route_file" >/dev/null 2>&1; then
    snapshot=$(jq -c \
      --arg model "$model" \
      --arg agent "$agent" \
      --arg depth "$depth" \
      --arg source "$source" \
      '{
        source: $source,
        planner: $model,
        plannerAgent: $agent,
        planDepth: $depth,
        route: {
          planner: $model,
          coder: (.coder // ""),
          reviewer: (.reviewer // ""),
          planDepth: $depth,
          codeDepth: (.codeDepth // ""),
          reviewMode: (.reviewMode // .reviewRecommended // "")
        },
        routeProvenance: (.provenance // {}),
        recordedAt: (now | todateiso8601)
      }' "$route_file" 2>/dev/null || echo "")
  else
    snapshot=$(jq -cn \
      --arg model "$model" \
      --arg agent "$agent" \
      --arg depth "$depth" \
      --arg source "$source" \
      '{source:$source, planner:$model, plannerAgent:$agent, planDepth:$depth, route:{planner:$model, planDepth:$depth}, recordedAt:(now | todateiso8601)}' 2>/dev/null || echo "")
  fi
  [[ -n "$snapshot" ]] || return 0

  local tmp
  tmp=$(mktemp) || return 0
  if jq --argjson snapshot "$snapshot" '
      .planning.launchRoute = (.planning.launchRoute // $snapshot)
      | .planning.effectiveRoute = $snapshot.route
    ' "$phase_file" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$phase_file"
  else
    rm -f "$tmp"
  fi
}

finalize_challenge_execution_intent_before_coding() {
  local issue="$1" slug="$2" branch="$3" wt_dir="$4" feature_dir="$5" primary_coder="$6"
  local challenge_role_meta="${7:-}" challenge_stage_meta="${8:-}"
  [[ "$challenge_role_meta" != "challenger" ]] || return 0
  [[ -f "$feature_dir/.post-expansion-route.json" ]] || return 0

  # A challenge has already chosen its experimental arm before either side is
  # expanded.  The expanded route is useful for filling in the shared route,
  # but it must never resample that arm: doing so lets Hokusai replace the
  # challenger and turns an exploration run into another incumbent route.
  # apply_expanded_route_if_present preserves the selected-stage fields from
  # this intent while applying every non-varied field from the expanded route.
  local existing_intent pinned_stage=""
  existing_intent=$(read_state_value "" --arg i "$issue" '(.tasks[$i].challengeExecutionIntent // .tasks[$i].challengeIntent) // empty' 2>/dev/null || true)
  if [[ -n "$existing_intent" ]]; then
    pinned_stage=$(echo "$existing_intent" | jq -r '(.selectedStage // .challengeStage // "")' 2>/dev/null || true)
  fi
  # Fall back to the stage recorded directly on the task; either way the stage
  # is decided once, at selection, and is never re-sampled below.
  [[ -n "$pinned_stage" && "$pinned_stage" != "null" ]] || pinned_stage="$challenge_stage_meta"

  if [[ -n "$existing_intent" ]] \
    && echo "$existing_intent" | jq -e '(.pairId // "") != "" and (.primary // null) != null and (.challenger // null) != null' >/dev/null 2>&1; then
    log "status" "  $issue: Preserving selected challenge arm through expanded routing"
    return 0
  fi

  local refresh_title issue_json packet_arg refreshed_plan refreshed_source refreshed_mode refreshed_reason refreshed_fallback_reason
  local pinned_stage_arg=() preserved_challenger_arg=()
  if [[ -n "$pinned_stage" && "$pinned_stage" != "null" ]]; then
    # Without this the refresh rolls a fresh stage from challenge.stageWeights,
    # which is how an already-selected implementation-stage arm (a Qwen or Kimi
    # coder) became an unrelated plan-stage pair on the way to coding.
    pinned_stage_arg=(--pinned-stage "$pinned_stage")
  fi
  local preserved_challenger_key preserved_challenger_model
  preserved_challenger_key="${issue}_c"
  preserved_challenger_model=$(read_state_value "" --arg i "$preserved_challenger_key" '.tasks[$i].challengeVariedModel // ""' 2>/dev/null || true)
  if [[ -z "$preserved_challenger_model" && "$pinned_stage" == "implementation" ]]; then
    preserved_challenger_model=$(read_state_value "" --arg i "$preserved_challenger_key" '.tasks[$i].coderModel // ""' 2>/dev/null || true)
  fi
  if [[ -n "$preserved_challenger_model" && "$preserved_challenger_model" != "null" ]]; then
    preserved_challenger_arg=(--preserved-challenger-model "$preserved_challenger_model")
  fi
  refresh_title=$(read_state_value "" --arg i "$issue" '.tasks[$i].title // ""')
  if [[ -z "$refresh_title" ]]; then
    issue_json=$(cat "/tmp/${SESSION}-${issue}-issue.json" 2>/dev/null || echo "{}")
    refresh_title=$(echo "$issue_json" | jq -r '.title // "Task"' 2>/dev/null || echo "Task")
  fi

  packet_arg=()
  if [[ -f "$feature_dir/task-packet.md" ]]; then
    packet_arg=(--file "$feature_dir/task-packet.md")
  elif [[ -f "/tmp/${SESSION}-${issue}-taskpacket.md" ]]; then
    packet_arg=(--file "/tmp/${SESSION}-${issue}-taskpacket.md")
  fi

  refreshed_plan=$(_with_timeout "$API_TIMEOUT" npx tsx "$TOOLS_DIR/resolve-challenge-task.ts" \
    --issue "$issue" \
    --slug "$slug" \
    --title "$refresh_title" \
    --repo-dir "$REPO_DIR" \
    --remaining-slots 2 \
    --primary-model "$primary_coder" \
    --feature-dir "$feature_dir" \
    "${pinned_stage_arg[@]}" \
    "${preserved_challenger_arg[@]}" \
    "${packet_arg[@]}" 2>/dev/null || echo "")
  refreshed_source=$(echo "$refreshed_plan" | jq -r '.decisionSource // "bootstrap"' 2>/dev/null || echo "bootstrap")
  refreshed_mode=$(echo "$refreshed_plan" | jq -r '.mode // "single"' 2>/dev/null || echo "single")
  refreshed_reason=$(echo "$refreshed_plan" | jq -r '.reason // empty' 2>/dev/null || echo "")
  refreshed_fallback_reason=$(echo "$refreshed_plan" | jq -r '.fallbackReason // empty' 2>/dev/null || echo "")

  if [[ "$refreshed_source" != "expanded" && "$refreshed_source" != "preserved" ]]; then
    log_warn "$issue → expanded challenge finalization did not use expanded/preserved route (source=$refreshed_source); keeping current challenge state"
    return 0
  fi

  local intent_json
  intent_json=$(echo "$refreshed_plan" | jq -c '.challengeExecutionIntent // empty' 2>/dev/null || true)

  if [[ "$refreshed_mode" != "challenge" ]]; then
    if [[ -n "$refreshed_reason" ]]; then
      state_mutate "$STATE_FILE" \
        '.tasks[$issue].challengeCollapseReason = $reason
         | .tasks[$issue].challengeCollapseDetail = $detail
         | .tasks[$issue].updated = (now | todate)' \
        --arg issue "$issue" \
        --arg reason "$refreshed_reason" \
        --arg detail "Challenge finalization produced no challenge: $refreshed_reason" >/dev/null 2>&1 || true
    fi
    persist_challenge_execution_intent "$issue" "" "$feature_dir" "$intent_json"
    [[ -n "$refreshed_reason" ]] && log_warn "$issue → challenge finalization produced no challenge ($refreshed_reason)"
    if [[ "$refreshed_fallback_reason" == "preserved_challenger_ineligible" ]]; then
      log_warn "$issue → preserved challenger model was ineligible during challenge finalization"
    fi
    return 0
  fi

  local new_primary new_primary_planner new_primary_reviewer new_primary_plan_depth new_primary_code_depth new_primary_review_mode
  local new_challenge_stage new_challenger_key new_challenger_model new_challenger_planner new_challenger_reviewer
  local new_challenger_plan_depth new_challenger_code_depth new_challenger_review_mode
  new_primary=$(echo "$refreshed_plan" | jq -r '.entries[0].model // empty' 2>/dev/null)
  new_primary_planner=$(echo "$refreshed_plan" | jq -r '.entries[0].planner // empty' 2>/dev/null)
  new_primary_reviewer=$(echo "$refreshed_plan" | jq -r '.entries[0].reviewer // empty' 2>/dev/null)
  new_primary_plan_depth=$(echo "$refreshed_plan" | jq -r '.entries[0].planDepth // empty' 2>/dev/null)
  new_primary_code_depth=$(echo "$refreshed_plan" | jq -r '.entries[0].codeDepth // empty' 2>/dev/null)
  new_primary_review_mode=$(echo "$refreshed_plan" | jq -r '.entries[0].reviewMode // empty' 2>/dev/null)
  new_challenge_stage=$(echo "$refreshed_plan" | jq -r '.challengeStage // "implementation"' 2>/dev/null || echo "implementation")
  new_challenger_key=$(echo "$refreshed_plan" | jq -r '.entries[1].key // empty' 2>/dev/null)
  new_challenger_model=$(echo "$refreshed_plan" | jq -r '.entries[1].model // empty' 2>/dev/null)
  new_challenger_planner=$(echo "$refreshed_plan" | jq -r '.entries[1].planner // empty' 2>/dev/null)
  new_challenger_reviewer=$(echo "$refreshed_plan" | jq -r '.entries[1].reviewer // empty' 2>/dev/null)
  new_challenger_plan_depth=$(echo "$refreshed_plan" | jq -r '.entries[1].planDepth // empty' 2>/dev/null)
  new_challenger_code_depth=$(echo "$refreshed_plan" | jq -r '.entries[1].codeDepth // empty' 2>/dev/null)
  new_challenger_review_mode=$(echo "$refreshed_plan" | jq -r '.entries[1].reviewMode // empty' 2>/dev/null)

  if [[ -z "$new_primary" || -z "$new_challenger_key" || -z "$new_challenger_model" ]]; then
    log_warn "$issue → expanded challenge finalization returned incomplete pair; keeping current challenge state"
    return 0
  fi

  # Finalization must not manufacture phantom pairs (a pair where no challenger arm was launched).
  # This happens when finalization re-ran resolve-challenge-task after a single-model launch
  # and got mode=challenge, but the ${issue}_c task doesn't exist.
  # Check: (1) challenger already exists in state, OR (2) challenge was already selected at launch.
  local challenger_exists was_challenge_at_launch
  challenger_exists="false"
  was_challenge_at_launch="false"

  local existing_challenger_slug existing_challenger_branch existing_challenger_worktree
  existing_challenger_slug=$(read_state_value "" --arg i "$new_challenger_key" '.tasks[$i].slug // ""' 2>/dev/null || true)
  existing_challenger_branch=$(read_state_value "" --arg i "$new_challenger_key" '.tasks[$i].branch // ""' 2>/dev/null || true)
  existing_challenger_worktree=$(read_state_value "" --arg i "$new_challenger_key" '.tasks[$i].worktree // ""' 2>/dev/null || true)
  [[ -n "$existing_challenger_slug" && -n "$existing_challenger_branch" && -n "$existing_challenger_worktree" ]] && challenger_exists="true"

  local existing_challenge_flag existing_pair_id
  existing_challenge_flag=$(get_task_meta "$issue" challenge 2>/dev/null || true)
  existing_pair_id=$(get_task_meta "$issue" challengePairId 2>/dev/null || true)
  [[ "$existing_challenge_flag" == "true" || -n "$existing_pair_id" ]] && was_challenge_at_launch="true"

  if [[ "$challenger_exists" != "true" && "$was_challenge_at_launch" != "true" ]]; then
    # Finalization may refine an existing pair; it must never create one.
    local no_challenge_intent
    no_challenge_intent=$(echo "$intent_json" | jq -c \
      'del(.challenger) | .noChallengeReason = "challenger_never_launched" | .challengeCollapseReason = "challenger_never_launched"' 2>/dev/null || echo "$intent_json")
    persist_challenge_execution_intent "$issue" "" "$feature_dir" "$no_challenge_intent"
    state_mutate "$STATE_FILE" \
      '.tasks[$issue].challengeCollapseReason = "challenger_never_launched"
       | .tasks[$issue].challengeCollapseDetail = "Finalization selected a pair but no challenger arm was launched; staying single-model"
       | .tasks[$issue].challenge = false
       | .tasks[$issue] |= del(.challengePairId, .role)
       | .tasks[$issue].updated = (now | todate)' \
      --arg issue "$issue" >/dev/null 2>&1 || true
    log_route_lifecycle "challenge_not_formed" "issue=$issue" "stage=$new_challenge_stage" "model=$new_primary" "reason=challenger_never_launched"
    log_warn "$issue → challenge finalization selected a pair but no challenger arm exists; staying single-model"
    FINALIZED_CHALLENGE_CODER=""
    FINALIZED_CHALLENGE_STAGE=""
    return 0
  fi

  # Compare the varied-stage models, not the coders. Plan/review challenges
  # intentionally share the coder on both sides.
  local new_primary_varied new_challenger_varied
  new_primary_varied=$(echo "$refreshed_plan" | jq -r '.entries[0].variedModel // .entries[0].model // empty' 2>/dev/null)
  new_challenger_varied=$(echo "$refreshed_plan" | jq -r '.entries[1].variedModel // .entries[1].model // empty' 2>/dev/null)
  if [[ -n "$new_primary_varied" && "$new_primary_varied" == "$new_challenger_varied" ]] \
    && ! echo "$intent_json" | jq -e '.intentionallyIdentical == true' >/dev/null 2>&1; then
    local collapse_reason collapse_detail collapsed_intent
    collapse_reason="identical-at-varied-stage"
    collapse_detail="Challenge finalization collapsed to identical ${new_challenge_stage} model ${new_primary_varied}"
    collapsed_intent=$(echo "$intent_json" | jq -c \
      --arg reason "$collapse_reason" \
      --arg detail "$collapse_detail" \
      'del(.challenger)
       | .noChallengeReason = $reason
       | .challengeCollapseReason = $reason
       | .challengeCollapseDetail = $detail' 2>/dev/null || echo "$intent_json")
    challenge_cancel_challenger_arm "$issue" "$slug" "$new_challenger_key" "$feature_dir" "$new_challenge_stage" "$new_primary_varied" "$collapse_reason" "$collapse_detail"
    persist_challenge_execution_intent "$issue" "" "$feature_dir" "$collapsed_intent"
    log_warn "$issue → challenge finalization cancelled challenger ($collapse_reason)"
    if [[ "$refreshed_fallback_reason" == "preserved_challenger_ineligible" ]]; then
      log_warn "$issue → preserved challenger model was ineligible during challenge finalization"
    fi
    FINALIZED_CHALLENGE_CODER=""
    FINALIZED_CHALLENGE_STAGE=""
    return 0
  fi

  local current_pr current_status current_agent current_linear_issue
  current_pr=$(read_state_value "" --arg i "$issue" '.tasks[$i].pr // ""')
  current_status=$(read_state_value "" --arg i "$issue" '.tasks[$i].status // ""')
  current_agent=$(read_state_value "" --arg i "$issue" '.tasks[$i].agent // ""')
  current_linear_issue=$(read_state_value "" --arg i "$issue" '.tasks[$i].linearIssueId // ""')
  save_task_state "$issue" "$slug" "$branch" "$wt_dir" "$current_pr" "$current_status" "$current_agent" "$current_linear_issue" \
    "true" "$issue" "primary" "$new_primary" "$new_primary_planner" "$new_primary" "$new_primary_reviewer" "$new_primary_plan_depth" "$new_primary_code_depth" "$new_primary_review_mode" "$new_challenge_stage"

  local challenger_slug challenger_branch challenger_worktree challenger_pr challenger_status challenger_agent challenger_linear_issue
  challenger_slug=$(read_state_value "" --arg i "$new_challenger_key" '.tasks[$i].slug // ""')
  challenger_branch=$(read_state_value "" --arg i "$new_challenger_key" '.tasks[$i].branch // ""')
  challenger_worktree=$(read_state_value "" --arg i "$new_challenger_key" '.tasks[$i].worktree // ""')
  challenger_pr=$(read_state_value "" --arg i "$new_challenger_key" '.tasks[$i].pr // ""')
  challenger_status=$(read_state_value "" --arg i "$new_challenger_key" '.tasks[$i].status // ""')
  challenger_agent=$(read_state_value "" --arg i "$new_challenger_key" '.tasks[$i].agent // ""')
  challenger_linear_issue=$(read_state_value "" --arg i "$new_challenger_key" '.tasks[$i].linearIssueId // ""')
  if [[ -n "$challenger_slug" && -n "$challenger_branch" && -n "$challenger_worktree" ]]; then
    save_task_state "$new_challenger_key" "$challenger_slug" "$challenger_branch" "$challenger_worktree" "$challenger_pr" "$challenger_status" "$challenger_agent" "$challenger_linear_issue" \
      "true" "$issue" "challenger" "$new_challenger_model" "$new_challenger_planner" "$new_challenger_model" "$new_challenger_reviewer" "$new_challenger_plan_depth" "$new_challenger_code_depth" "$new_challenger_review_mode" "$new_challenge_stage"
    # Mark that the challenger was successfully launched (P0.6, HOK-2798)
    state_mutate "$STATE_FILE" \
      '.tasks[$issue].challengerLaunched = true
       | .tasks[$issue].updated = (now | todate)' \
      --arg issue "$issue" >/dev/null 2>&1 || true
  fi

  persist_challenge_execution_intent "$issue" "$new_challenger_key" "$feature_dir" "$intent_json"
  FINALIZED_CHALLENGE_CODER="$new_primary"
  FINALIZED_CHALLENGE_STAGE="$new_challenge_stage"

  if [[ "$refreshed_fallback_reason" == "preserved_challenger_ineligible" ]]; then
    log_warn "$issue → preserved challenger model was ineligible during challenge finalization"
  fi
  log "status" "  $issue: Challenge intent finalized ($refreshed_source route, stage=$new_challenge_stage): $new_primary_varied vs $new_challenger_varied"
  challenge_assert_arms_diverge "$issue" "$new_challenge_stage" "$new_primary_varied" "$new_challenger_varied" "$intent_json"
}

challenge_cancel_challenger_arm() {
  local issue="$1" primary_slug="$2" challenger_key="${3:-}" feature_dir="${4:-}" stage="${5:-}" varied_model="${6:-}" reason="${7:-}" detail="${8:-}"
  [[ -n "$issue" && -n "$reason" ]] || return 1

  local challenger_slug challenger_worktree target target_gone="false" win
  if [[ -n "$challenger_key" ]]; then
    challenger_slug=$(read_state_value "" --arg i "$challenger_key" '.tasks[$i].slug // ""' 2>/dev/null || true)
    challenger_worktree=$(read_state_value "" --arg i "$challenger_key" '.tasks[$i].worktree // ""' 2>/dev/null || true)
    win="$challenger_key-$challenger_slug"

    target="$(_tmux_task_window_target "$SESSION" "$challenger_key" "$challenger_slug" "${STATE_FILE:-}" "$challenger_worktree" 2>/dev/null || true)"
    if [[ -z "$target" ]] || ! command -v tmux >/dev/null 2>&1; then
      target_gone="true"
    else
      tmux kill-window -t "$(_tmux_target_join "$SESSION" "$target")" 2>/dev/null || true
      if ! _tmux_window_target_exists "$SESSION" "$target"; then
        target_gone="true"
      fi
    fi

    if [[ "$target_gone" != "true" ]]; then
      set_window_attention_state "$win" "needs-user"
      log_warn "  $challenger_key cleanup could not close tmux window during challenge collapse"
    fi

    if [[ -n "$challenger_slug" ]]; then
      local wt_dir="${WORKTREE_ROOT}/${challenger_slug}"
      [[ -n "$challenger_worktree" ]] && wt_dir="$challenger_worktree"
      local task_branch="task/${challenger_slug}"
      local cleanup_rc=0
      safe_remove_task_worktree_and_branch "$wt_dir" "$task_branch" "$BASE_BRANCH" "challenge_cancel_challenger_arm" || cleanup_rc=$?
      if [[ "$cleanup_rc" -eq 10 ]]; then
        set_window_attention_state "$win" "needs-user"
        log_warn "  $challenger_key cleanup preserved local work during challenge collapse; keeping task state"
        return 1
      fi
      if [[ "$cleanup_rc" -eq 20 ]]; then
        set_window_attention_state "$win" "needs-user"
        log_warn "  $challenger_key cleanup failed during challenge collapse; keeping task state"
        return 1
      fi
    fi

    git -C "$REPO_DIR" worktree prune >>"${MILL_LOG_FILE:-/dev/null}" 2>/dev/null || true
    rm -f "/tmp/wavemill-${SESSION}-${challenger_key}.hook" 2>/dev/null || true
    reset_retry_count "$SESSION" "$challenger_key" 2>/dev/null || true
    remove_task_state "$challenger_key"
    if declare -p CLEANED >/dev/null 2>&1; then
      CLEANED["$challenger_key"]=1
    fi
  fi

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
    --arg issue "$issue" \
    --arg reason "$reason" \
    --arg detail "$detail" >/dev/null 2>&1 || true

  log_route_lifecycle "challenge_collapsed" \
    "issue=$issue" \
    "slug=$primary_slug" \
    "stage=$stage" \
    "model=\"$varied_model\"" \
    "reason=$reason"
  return 0
}

# A pair whose two sides run the same model at the varied stage measures
# nothing.  The comparison stage already rejects these, but only after both arms
# have run; surfacing it at selection time makes the waste visible immediately.
challenge_assert_arms_diverge() {
  local issue="$1" stage="$2" primary_varied="$3" challenger_varied="$4" intent_json="${5:-}"
  [[ -n "$primary_varied" && -n "$challenger_varied" ]] || return 0
  [[ "$primary_varied" == "$challenger_varied" ]] || return 0
  if [[ -n "$intent_json" ]] \
    && echo "$intent_json" | jq -e '.intentionallyIdentical == true' >/dev/null 2>&1; then
    return 0
  fi
  log_error "  $issue: challenge arms are identical at stage=$stage ($primary_varied vs $challenger_varied) — comparison will measure nothing"
  log_route_lifecycle "challenge_arms_identical" \
    "issue=$issue" \
    "stage=$stage" \
    "model=\"$primary_varied\""
  return 0
}

update_free_slots_state() {
  local slots="$1"
  local queue_owned="${queue_owned_count:-0}"
  [[ -r "$STATE_FILE" && -s "$STATE_FILE" ]] || return 0
  if ! state_mutate "$STATE_FILE" \
     '.freeSlots = $slots | .queueOwnedTasks = $queueOwned | .updated = (now | todate)' \
     --argjson slots "$slots" \
     --argjson queueOwned "$queue_owned"; then
    log_warn "update_free_slots_state: failed to update free slots"
  fi
}

# remove_task_state() is provided by wavemill-common.sh (HOK-2903), sourced
# above; the canonical copy preserves this scope's semantics byte-for-byte.

set_task_phase() {
  local issue="$1" phase="$2"
  if ! state_mutate "$STATE_FILE" \
     '.tasks[$issue].phase = $phase
      | .tasks[$issue].updated = (now | todate)
      | if $phase == "aborted" then .tasks[$issue].status = "aborted" else . end' \
     --arg issue "$issue" --arg phase "$phase"; then
    log_warn "set_task_phase: failed to update $issue"
  fi
}

read_state_value() {
  local default="$1"
  shift
  local value

  if [[ ! -r "$STATE_FILE" || ! -s "$STATE_FILE" ]]; then
    printf '%s\n' "$default"
    return 0
  fi

  if value=$(jq -r "$@" "$STATE_FILE" 2>/dev/null); then
    printf '%s\n' "$value"
  else
    printf '%s\n' "$default"
  fi
}

# Duplicated intentionally: the pre-heredoc definition (~line 595) does not
# enter the generated monitor script, so the monitor needs its own copy to
# service late migration reservations.
save_migration_reservation() {
  local issue="$1"
  local num="$2"
  state_mutate "$STATE_FILE" \
    '.migrationReservations[$issue] = $num | .nextMigrationNum = ($num + 1)' \
    --arg issue "$issue" --argjson num "$num" >/dev/null || true
}

# get_task_phase() is provided by wavemill-common.sh (HOK-2903), sourced
# above; the canonical copy inlines the read_state_value "executing" guard
# this scope previously applied.

mark_eval_completed() {
  local issue="$1"
  local slug
  if ! state_mutate "$STATE_FILE" \
     '.tasks[$issue].evalCompleted = true
      | .tasks[$issue].evalFailed = false
      | .tasks[$issue].evalHardFailureRetryCount = 0
      | del(.tasks[$issue].evalRunning)
      | .tasks[$issue].updated = (now | todateiso8601)' \
     --arg issue "$issue"; then
    log_warn "mark_eval_completed: failed to update $issue"
  fi
  # Successful eval wipes the arm's bounded-retry eval budgets (HOK-2924).
  slug=$(read_state_value "" --arg i "$issue" '.tasks[$i].slug // empty')
  if [[ -n "$slug" && -n "${WORKTREE_ROOT:-}" ]]; then
    bounded_retry_clear "${WORKTREE_ROOT}/${slug}/features/${slug}" "challenge-eval-soft"
    bounded_retry_clear "${WORKTREE_ROOT}/${slug}/features/${slug}" "challenge-eval-hard"
  fi
}

mark_eval_failed() {
  local issue="$1"
  if ! state_mutate "$STATE_FILE" \
     '.tasks[$issue].evalFailed = true
      | del(.tasks[$issue].evalRunning)
      | .tasks[$issue].updated = (now | todateiso8601)' \
     --arg issue "$issue"; then
    log_warn "mark_eval_failed: failed to update $issue"
  fi
}

# Duplicated intentionally: the pre-heredoc definitions do not enter the
# generated monitor script, so challenge launchers need local monitor copies.
mark_challenge_eval_running() {
  local issue="$1" side="$2" pr="$3" phase="${4:-eval}"
  state_mutate "$STATE_FILE" '
    .tasks[$issue].evalRunning = {
      issue: $issue,
      side: $side,
      pr: ($pr | tonumber),
      phase: $phase,
      startedAt: (now | todateiso8601)
    } |
    .tasks[$issue].updated = (now | todateiso8601)
  ' \
    --arg issue "$issue" \
    --arg side "$side" \
    --arg pr "$pr" \
    --arg phase "$phase"
}

mark_challenge_comparison_running() {
  local pair_id="$1" primary_pr="$2" challenger_pr="$3"
  state_mutate "$STATE_FILE" '
    .tasks |= with_entries(
      if (.value.challengePairId // "") == $pair then
        .value.comparisonRunning = {
          pairId: $pair,
          primaryPr: ($primaryPr | tonumber),
          challengerPr: ($challengerPr | tonumber),
          startedAt: (now | todateiso8601)
        } |
        .value.comparisonState = "comparison_running" |
        .value |= del(.comparisonBlockedReason, .comparisonRetryTargetIssue, .comparisonTimedOutSides, .manualComparisonArtifact) |
        .value.updated = (now | todateiso8601)
      else
        .
      end
    )
  ' \
    --arg pair "$pair_id" \
    --arg primaryPr "$primary_pr" \
    --arg challengerPr "$challenger_pr"
}

# challenge_eval_retry_max_attempts() and challenge_eval_hard_failure_max_retries()
# are provided by wavemill-common.sh (HOK-2924), sourced above.

clear_challenge_pair_state() {
  local pair_id="$1"
  state_mutate "$STATE_FILE" '
    .tasks |= with_entries(
      if (.value.challengePairId // "") == $pair then
        .value |= (
          del(
            .comparisonState,
            .comparisonBlockedReason,
            .comparisonRetryCount,
            .comparisonRetryMaxAttempts,
            .comparisonRetryTargetIssue,
            .comparisonTimedOutSides,
            .manualComparisonArtifact
          ) |
          .updated = (now | todateiso8601)
        )
      else
        .
      end
    )
  ' --arg pair "$pair_id"
}

write_challenge_pair_state() {
  local pair_id="$1" state="$2" reason="${3:-}" retry_count="${4:-0}" retry_max="${5:-0}" retry_target="${6:-}" timed_out_sides_csv="${7:-}" artifact_path="${8:-}"
  state_mutate "$STATE_FILE" '
    ($timedOutSidesCsv
      | split(",")
      | map(gsub("^\\s+|\\s+$"; ""))
      | map(select(length > 0))) as $timedOutSides
    | .tasks |= with_entries(
        if (.value.challengePairId // "") == $pair then
          .value.comparisonState = $state
          | .value.comparisonRetryCount = $retryCount
          | .value.comparisonRetryMaxAttempts = $retryMax
          | .value |= del(.comparisonRunning)
          | .value.updated = (now | todateiso8601)
          | if $reason != "" then .value.comparisonBlockedReason = $reason else .value |= del(.comparisonBlockedReason) end
          | if $retryTarget != "" then .value.comparisonRetryTargetIssue = $retryTarget else .value |= del(.comparisonRetryTargetIssue) end
          | if ($timedOutSides | length) > 0 then .value.comparisonTimedOutSides = $timedOutSides else .value |= del(.comparisonTimedOutSides) end
          | if $artifactPath != "" then .value.manualComparisonArtifact = $artifactPath else .value |= del(.manualComparisonArtifact) end
        else
          .
        end
      )
  ' \
    --arg pair "$pair_id" \
    --arg state "$state" \
    --arg reason "$reason" \
    --arg retryTarget "$retry_target" \
    --arg timedOutSidesCsv "$timed_out_sides_csv" \
    --arg artifactPath "$artifact_path" \
    --argjson retryCount "$retry_count" \
    --argjson retryMax "$retry_max"
}

challenge_pair_timed_out_sides_csv() {
  local issue="$1"
  read_state_value "" --arg i "$issue" '.tasks[$i].comparisonTimedOutSides // [] | join(",")'
}

challenge_pair_timeout_reason() {
  local timed_out_sides_csv="$1"
  case ",$timed_out_sides_csv," in
    *,primary,challenger,*|*,challenger,primary,*) printf 'both_eval_timed_out\n' ;;
    *,primary,*) printf 'primary_eval_timed_out\n' ;;
    *,challenger,*) printf 'challenger_eval_timed_out\n' ;;
    *) printf 'eval_timed_out\n' ;;
  esac
}

challenge_pair_hard_failure_reason() {
  local failed_sides_csv="$1"
  case ",$failed_sides_csv," in
    *,primary,challenger,*|*,challenger,primary,*) printf 'both_eval_hard_failed\n' ;;
    *,primary,*) printf 'primary_eval_hard_failed\n' ;;
    *,challenger,*) printf 'challenger_eval_hard_failed\n' ;;
    *) printf 'eval_hard_failed\n' ;;
  esac
}

challenge_pair_records_file() {
  local evals_dir="$REPO_DIR/.wavemill/evals"
  mkdir -p "$evals_dir"
  printf '%s/challenge-records.jsonl\n' "$evals_dir"
}

challenge_pr_url_from_number() {
  local pr="$1"
  local pr_url=""
  if [[ -n "$pr" ]]; then
    pr_url=$(gh pr view "$pr" --json url --jq .url 2>/dev/null || true)
  fi
  if [[ -n "$pr_url" ]]; then
    printf '%s\n' "$pr_url"
  else
    printf 'https://github.com/unknown/unknown/pull/%s\n' "${pr:-0}"
  fi
}

challenge_pair_record_exists() {
  local pair_id="$1"
  local records_file voids_file
  records_file=$(challenge_pair_records_file)
  [[ -f "$records_file" ]] || return 1
  voids_file="${records_file%/*}/challenge-record-voids.jsonl"
  [[ -f "$voids_file" ]] || voids_file="/dev/null"
  jq -e --arg pair "$pair_id" --slurpfile voids "$voids_file" '
    select(.challengePairId == $pair)
    | select(
        if (if has("primaryCompleted") then false
            elif has("challengerCompleted") then false
            else true end) then true
        elif .comparisonOutcome == "forfeit" then
          if .primaryCompleted == true then true
          elif .challengerCompleted == true then true
          elif ((.armFailures // []) | length) > 0 then true
          else false end
        elif .comparisonOutcome == "double-forfeit" then
          if .primaryCompleted == true then true
          elif .challengerCompleted == true then true
          elif ((.armFailures // []) | length) > 0 then true
          else false end
        else true end
      ) as $record
    | select([
        $voids[]?
        | select(.challengePairId == $record.challengePairId)
        | select(.recordTimestamp >= ($record.timestamp // ""))
      ] | length == 0)
  ' "$records_file" >/dev/null 2>&1
}


challenge_pair_manual_artifact_path() {
  local primary_key="$1"
  local slug worktree
  slug=$(read_state_value "" --arg i "$primary_key" '.tasks[$i].slug // empty')
  worktree=$(read_state_value "" --arg i "$primary_key" '.tasks[$i].worktree // empty')
  [[ -z "$worktree" && -n "$slug" ]] && worktree="${WORKTREE_ROOT}/${slug}"
  [[ -n "$slug" && -n "$worktree" ]] || return 1
  printf '%s/features/%s/ready/challenge-comparison-needed.md\n' "$worktree" "$slug"
}

write_manual_challenge_comparison_artifact() {
  local pair_id="$1" primary_key="$2" challenger_key="$3" timed_out_sides_csv="$4" retry_count="$5" retry_max="$6"
  local artifact_path primary_pr challenger_pr
  artifact_path=$(challenge_pair_manual_artifact_path "$primary_key") || return 1
  primary_pr=$(read_state_value "" --arg i "$primary_key" '.tasks[$i].pr // empty')
  challenger_pr=$(read_state_value "" --arg i "$challenger_key" '.tasks[$i].pr // empty')
  mkdir -p "$(dirname "$artifact_path")"
  cat > "$artifact_path" <<EOF
# Challenge Comparison Needs Manual Action

Pair ID: $pair_id
Primary issue: $primary_key
Challenger issue: $challenger_key
Primary PR: ${primary_pr:-unknown}
Challenger PR: ${challenger_pr:-unknown}
Timed out member(s): ${timed_out_sides_csv:-unknown}
Retry count: $retry_count/$retry_max

Next action:
1. Re-run the timed-out eval job(s) manually when infrastructure is healthy.
2. If eval cannot be recovered quickly, compare PRs #${primary_pr:-?} and #${challenger_pr:-?} manually.
3. Close the losing PR and proceed with the winner.
EOF
  printf '%s\n' "$artifact_path"
}

eval_record_exists_for_issue_pr() {
  local issue="$1" pr="$2"
  local pr_url evals_dir evals_file

  [[ -z "$issue" || -z "$pr" ]] && return 1

  pr_url=$(gh pr view "$pr" --json url --jq .url 2>/dev/null || true)
  [[ -z "$pr_url" ]] && return 1

  evals_dir=$(wavemill_load_config "$REPO_DIR" | jq -r '.eval.evalsDir // ".wavemill/evals"' 2>/dev/null || echo ".wavemill/evals")
  [[ "$evals_dir" != /* ]] && evals_dir="$REPO_DIR/$evals_dir"
  evals_file="$evals_dir/evals.jsonl"
  [[ -r "$evals_file" ]] || return 1

  jq -e --arg issue "$issue" --arg pr_url "$pr_url" '
    select(.issueId == $issue and .prUrl == $pr_url)
  ' "$evals_file" >/dev/null 2>&1
}

validate_agent_set() {
  local issue="$1"
  local agent
  agent=$(read_state_value "" --arg i "$issue" '.tasks[$i].agent // ""')
  if [[ -z "$agent" ]]; then
    log_warn "  ⚠ BUG: Agent not set for $issue (should have been set at launch), auto-fixing to: $AGENT_CMD"
    # Auto-fix: update the task state with the default agent
    local slug branch worktree pr status
    slug=$(read_state_value "" --arg i "$issue" '.tasks[$i].slug // ""')
    branch=$(read_state_value "" --arg i "$issue" '.tasks[$i].branch // ""')
    worktree=$(read_state_value "" --arg i "$issue" '.tasks[$i].worktree // ""')
    pr=$(read_state_value "" --arg i "$issue" '.tasks[$i].pr // ""')
    status=$(read_state_value "" --arg i "$issue" '.tasks[$i].status // ""')
    save_task_state "$issue" "$slug" "$branch" "$worktree" "$pr" "$status" "$AGENT_CMD"
  fi
}

# Phase completion checks (must be defined inside monitor script)
check_routing_complete() {
  local slug="$1"
  local wt="${WORKTREE_ROOT}/${slug}"
  [[ -f "$wt/features/$slug/.routing-complete" ]] && return 0
  return 1
}

# ────────────────────────────────────────────────────────────────
# Controller-owned stage result functions (HOK-1177)
# ────────────────────────────────────────────────────────────────

# Write a structured stage result JSON file.
# Usage: write_stage_result <feature_dir> <stage> <status> [agent] [model] [notes] [artifacts_json] [started_at]
# Stages: routing, planning, coding, review, ready
# Statuses: running, awaiting_user, completed, aborted, failed
# artifacts_json: optional JSON string for stage-specific artifacts (HOK-1192)
write_stage_result() {
  local feature_dir="$1" stage="$2" status="$3"
  local agent="${4:-}" model="${5:-}" notes="${6:-}" artifacts_json="${7:-}"
  local started_at_override="${8:-}"
  local result_file="$feature_dir/.${stage}-result.json" previous_status=""

  # Capture the transition before either writer replaces the result. A malformed
  # or missing result is intentionally treated as an unknown prior state.
  if [[ -f "$result_file" ]]; then
    previous_status="$(jq -r '.status // empty' "$result_file" 2>/dev/null || true)"
  fi

  # Try the TypeScript CLI first (HOK-1192: structured writes with artifacts support)
  if [[ -n "${TOOLS_DIR:-}" ]]; then
    local cli_args=("$feature_dir" "$stage" "$status")
    [[ -n "$agent" ]] && cli_args+=(--agent "$agent")
    [[ -n "$model" ]] && cli_args+=(--model "$model")
    [[ -n "$notes" ]] && cli_args+=(--notes "$notes")
    [[ -n "$artifacts_json" ]] && cli_args+=(--artifacts "$artifacts_json")
    [[ -n "$started_at_override" ]] && cli_args+=(--started-at "$started_at_override")

    if npx tsx "$TOOLS_DIR/stage-result-cli.ts" write "${cli_args[@]}" 2>/dev/null; then
      _write_stage_result_trace_event "$feature_dir" "$stage" "$status" "$agent" "$model" "$previous_status"
      return 0
    fi
    log_warn "write_stage_result: TypeScript CLI failed, falling back to shell"
  fi

  # Fallback: inline JSON construction (legacy path)
  local now
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  mkdir -p "$feature_dir"

  local started_at="${started_at_override:-$now}"
  if [[ -f "$result_file" ]]; then
    local prev_start
    prev_start=$(jq -r '.startedAt // empty' "$result_file" 2>/dev/null || echo "")
    [[ -z "$started_at_override" && -n "$prev_start" ]] && started_at="$prev_start"
  fi

  local finished_at="null"
  if [[ "$status" == "completed" || "$status" == "aborted" || "$status" == "failed" ]]; then
    finished_at="\"$now\""
  fi

  local tmp
  tmp=$(mktemp) || { log_warn "write_stage_result: mktemp failed"; return 0; }
  cat > "$tmp" <<EOF
{
  "stage": "$stage",
  "status": "$status",
  "startedAt": "$started_at",
  "finishedAt": $finished_at,
  "agent": "$agent",
  "model": "$model",
  "notes": "$notes"
}
EOF
  mv "$tmp" "$result_file"
  _write_stage_result_trace_event "$feature_dir" "$stage" "$status" "$agent" "$model" "$previous_status"
}

write_stage_result_with_history() {
  local feature_dir="$1" stage="$2" status="$3"
  local agent="${4:-}" model="${5:-}" notes="${6:-}" artifacts_json="${7:-}"
  local started_at_override="${8:-}"
  local result_file="$feature_dir/.${stage}-result.json" previous_status=""

  if [[ -f "$result_file" ]]; then
    previous_status="$(jq -r '.status // empty' "$result_file" 2>/dev/null || true)"
  fi

  if [[ -n "${TOOLS_DIR:-}" ]]; then
    local cli_args=("$feature_dir" "$stage" "$status")
    [[ -n "$agent" ]] && cli_args+=(--agent "$agent")
    [[ -n "$model" ]] && cli_args+=(--model "$model")
    [[ -n "$notes" ]] && cli_args+=(--notes "$notes")
    [[ -n "$artifacts_json" ]] && cli_args+=(--artifacts "$artifacts_json")
    [[ -n "$started_at_override" ]] && cli_args+=(--started-at "$started_at_override")

    if npx tsx "$TOOLS_DIR/stage-result-cli.ts" write-with-history "${cli_args[@]}" 2>/dev/null; then
      _write_stage_result_trace_event "$feature_dir" "$stage" "$status" "$agent" "$model" "$previous_status"
      return 0
    fi
    log_warn "write_stage_result_with_history: TypeScript CLI failed, falling back to write_stage_result"
  fi

  write_stage_result "$feature_dir" "$stage" "$status" "$agent" "$model" "$notes" "$artifacts_json" "$started_at_override"
}

# Emit trace events when a stage result is written (HOK-2259).
# Best-effort — never fails. Reads trace context from the feature directory.
_write_stage_result_trace_event() {
  local feature_dir="$1" stage="$2" status="$3" agent="${4:-}" model="${5:-}" previous_status="${6:-}"
  local _tid _iid _sl
  _tid=$(trace_read_id "$feature_dir" 2>/dev/null || true)
  [[ -n "$_tid" ]] || return 0
  _iid=$(jq -r '.issueId // empty' "$feature_dir/.trace-context.json" 2>/dev/null || true)
  _sl=$(jq -r '.slug // empty' "$feature_dir/.trace-context.json" 2>/dev/null || true)
  [[ -n "$_iid" && -n "$_sl" ]] || return 0

  case "$status" in
    running)
      [[ "$previous_status" != "running" ]] || return 0
      trace_append_event "$feature_dir" "$_tid" "$_iid" "$_sl" "$stage" "phase_started" "ok" "$model" "$agent" 2>/dev/null || true
      ;;
    completed)
      [[ "$previous_status" != "completed" ]] || return 0
      trace_append_event "$feature_dir" "$_tid" "$_iid" "$_sl" "$stage" "phase_completed" "ok" "$model" "$agent" 2>/dev/null || true
      ;;
    failed|aborted)
      [[ "$previous_status" != "$status" ]] || return 0
      trace_append_event "$feature_dir" "$_tid" "$_iid" "$_sl" "$stage" "phase_completed" "failed" "$model" "$agent" \
        "$(jq -cn --arg st "$status" '{meta:{stageStatus:$st}}' 2>/dev/null || echo '{}')" 2>/dev/null || true
      ;;
  esac
}

clear_stage_result() {
  local feature_dir="$1" stage="$2"
  rm -f "$feature_dir/.${stage}-result.json"
}

# Read a stage result file, returning its JSON content or empty string.
# Usage: read_stage_result <feature_dir> <stage>
read_stage_result() {
  local feature_dir="$1" stage="$2"
  local result_file="$feature_dir/.${stage}-result.json"
  if [[ -f "$result_file" ]] && jq empty "$result_file" 2>/dev/null; then
    cat "$result_file"
  else
    echo ""
  fi
}

# Read the status field from a stage result file.
# Usage: read_stage_status <feature_dir> <stage>
# Returns the status string or empty.
read_stage_status() {
  local feature_dir="$1" stage="$2"
  local result_file="$feature_dir/.${stage}-result.json"
  if [[ -f "$result_file" ]]; then
    jq -r '.status // empty' "$result_file" 2>/dev/null || echo ""
  else
    echo ""
  fi
}

# Check if a stage is complete from controller-owned stage results.
# Usage: check_stage_complete <feature_dir> <stage>
# Returns 0 if completed, 1 otherwise.
check_stage_complete() {
  local feature_dir="$1" stage="$2"
  local status
  status=$(read_stage_status "$feature_dir" "$stage")
  [[ "$status" == "completed" ]] && return 0
  return 1
}

# Check if a stage is in awaiting_user state.
# Usage: check_stage_awaiting_user <feature_dir> <stage>
check_stage_awaiting_user() {
  local feature_dir="$1" stage="$2"
  local status
  status=$(read_stage_status "$feature_dir" "$stage")
  [[ "$status" == "awaiting_user" ]] && return 0
  return 1
}

# Check whether a stage is actively in progress according to controller-owned state.
# Usage: stage_result_is_in_progress <feature_dir> <stage>
stage_result_is_in_progress() {
  local feature_dir="$1" stage="$2"
  local status
  status=$(read_stage_status "$feature_dir" "$stage")

  case "$stage" in
    planning)
      [[ "$status" == "running" || "$status" == "awaiting_user" ]]
      return $?
      ;;
    coding|review|ready)
      [[ "$status" == "running" ]]
      return $?
      ;;
  esac

  return 1
}

ready_conflict_launch_head() {
  local feature_dir="$1"
  local result_file="$feature_dir/.ready-result.json"
  if [[ -f "$result_file" ]]; then
    jq -r '.artifacts.launchHead // empty' "$result_file" 2>/dev/null || echo ""
  else
    echo ""
  fi
}

ready_conflict_attention_head() {
  local feature_dir="$1"
  local attention_head_file="$feature_dir/.conflict-attention-head"
  if [[ -f "$attention_head_file" ]]; then
    cat "$attention_head_file" 2>/dev/null || echo ""
  else
    echo ""
  fi
}

record_ready_conflict_attention() {
  local feature_dir="$1" head="$2"
  mkdir -p "$feature_dir"
  printf '%s\n' "$head" > "$feature_dir/.conflict-attention-head"
  touch "$feature_dir/.conflict-attention-reported"
}

clear_ready_conflict_attention() {
  local feature_dir="$1"
  rm -f "$feature_dir/.conflict-attention-head" "$feature_dir/.conflict-attention-reported"
}

clear_ready_conflict_markers() {
  local feature_dir="$1"
  rm -f "$feature_dir/.conflict-detected" "$feature_dir/.conflict-recheck-at"
  marker_clear "$feature_dir/.needs-attention"
  clear_ready_conflict_attention "$feature_dir"
}

ready_conflict_recheck_interval_seconds() {
  local configured="${WAVEMILL_READY_CONFLICT_RECHECK_SECONDS:-}"
  if [[ "$configured" =~ ^[0-9]+$ ]] && (( configured >= 10 )); then
    printf '%s\n' "$configured"
  else
    printf '60\n'
  fi
}

ready_conflict_recheck_due() {
  local feature_dir="$1"
  local recheck_file="$feature_dir/.conflict-recheck-at"
  local last_recheck interval now
  if [[ ! -f "$recheck_file" ]]; then
    return 0
  fi

  last_recheck="$(cat "$recheck_file" 2>/dev/null || echo "")"
  if [[ ! "$last_recheck" =~ ^[0-9]+$ ]]; then
    return 0
  fi

  interval="$(ready_conflict_recheck_interval_seconds)"
  now="$(date +%s)"
  (( now - last_recheck >= interval ))
}

write_ready_conflict_recheck_at() {
  local feature_dir="$1"
  local recheck_file="$feature_dir/.conflict-recheck-at"
  local tmp_file
  mkdir -p "$feature_dir"
  tmp_file="$(mktemp "$feature_dir/.conflict-recheck-at.tmp.XXXXXX")"
  printf '%s\n' "$(date +%s)" > "$tmp_file"
  mv "$tmp_file" "$recheck_file"
}

ready_conflict_pr_is_clean() {
  local feature_dir="$1" pr_number="$2" issue="$3"
  local pr_json mergeable merge_state

  if pr_json=$(_with_timeout "$API_TIMEOUT" gh pr view "$pr_number" --json mergeable,mergeStateStatus 2>/dev/null); then
    write_ready_conflict_recheck_at "$feature_dir"
  else
    write_ready_conflict_recheck_at "$feature_dir"
    log "debug" "ready conflict recheck for $issue PR #$pr_number failed"
    return 1
  fi

  mergeable="$(printf '%s' "$pr_json" | jq -r '.mergeable // ""' 2>/dev/null || echo "")"
  merge_state="$(printf '%s' "$pr_json" | jq -r '.mergeStateStatus // ""' 2>/dev/null || echo "")"

  if [[ "$mergeable" == "MERGEABLE" && "$merge_state" == "CLEAN" ]]; then
    log "status" "ready conflict recheck for $issue PR #$pr_number: MERGEABLE/CLEAN (clearing stale markers)"
    return 0
  fi

  log "debug" "ready conflict recheck for $issue PR #$pr_number: ${mergeable:-empty}/${merge_state:-empty}"
  return 1
}

# Source of truth is the bounded-retry bucket (HOK-2924); the JSON
# remediationAttempts / remediationLaunchHead mirrors in .ready-result.json
# are still written for dashboards and downstream tools but are no longer
# read here — the bucket resets on a new head SHA, the JSON does not.
ready_remediation_attempts() {
  bounded_retry_count "$1" "ready-remediation"
}

ready_remediation_launch_head() {
  bounded_retry_head "$1" "ready-remediation"
}

ready_remediation_config_json() {
  local wt_dir="$1"
  local user_config="$HOME/.wavemill/config.json"
  local repo_config="$wt_dir/.wavemill-config.json"
  local local_config="$wt_dir/.wavemill-config.local.json"
  local user_json='{}'
  local repo_json='{}'
  local local_json='{}'

  [[ -f "$user_config" ]] && user_json=$(cat "$user_config" 2>/dev/null || echo '{}')
  [[ -f "$repo_config" ]] && repo_json=$(cat "$repo_config" 2>/dev/null || echo '{}')
  [[ -f "$local_config" ]] && local_json=$(cat "$local_config" 2>/dev/null || echo '{}')

  jq -n -c \
    --argjson user "$user_json" \
    --argjson repo "$repo_json" \
    --argjson local "$local_json" \
    '
    ({ready:{remediation:{enabled:true,maxAttempts:3,agentCmd:""}}} * $user * $repo * $local).ready.remediation
    ' 2>/dev/null || echo '{"enabled":true,"maxAttempts":3,"agentCmd":""}'
}

ready_watchdog_config_json() {
  local wt_dir="$1"
  local user_config="$HOME/.wavemill/config.json"
  local repo_config="$wt_dir/.wavemill-config.json"
  local local_config="$wt_dir/.wavemill-config.local.json"
  local user_json='{}'
  local repo_json='{}'
  local local_json='{}'

  [[ -f "$user_config" ]] && user_json=$(cat "$user_config" 2>/dev/null || echo '{}')
  [[ -f "$repo_config" ]] && repo_json=$(cat "$repo_config" 2>/dev/null || echo '{}')
  [[ -f "$local_config" ]] && local_json=$(cat "$local_config" 2>/dev/null || echo '{}')

  jq -n -c \
    --argjson user "$user_json" \
    --argjson repo "$repo_json" \
    --argjson local "$local_json" \
    '
    ({ready:{watchdog:{enabled:true,thresholdMinutes:10,autoRecover:true,timeoutSeconds:30,stableFailureConsecutivePolls:2,stableFailureEscalateAfterPolls:4,safeRemediationCategories:["lint","type","test","build","migration-chain","alembic"]}}} * $user * $repo * $local) as $merged
    | (($merged.monitor.readyWatchdog // {}) + ($merged.ready.watchdog // {}))
    ' 2>/dev/null || echo '{"enabled":true,"thresholdMinutes":10,"autoRecover":true,"timeoutSeconds":30,"stableFailureConsecutivePolls":2,"stableFailureEscalateAfterPolls":4,"safeRemediationCategories":["lint","type","test","build","migration-chain","alembic"]}'
}

run_ready_watchdog_tick() {
  local watchdog_json watchdog_enabled watchdog_timeout watchdog_stderr watchdog_error now
  watchdog_json=$(ready_watchdog_config_json "$REPO_DIR")
  watchdog_enabled=$(printf '%s' "$watchdog_json" | jq -r '.enabled // true' 2>/dev/null || echo "true")
  [[ "$watchdog_enabled" == "true" ]] || return 0

  watchdog_timeout=$(printf '%s' "$watchdog_json" | jq -r '.timeoutSeconds // 30' 2>/dev/null || echo "30")
  [[ "$watchdog_timeout" =~ ^[0-9]+$ ]] || watchdog_timeout=30

  watchdog_stderr="$(mktemp "${TMPDIR:-/tmp}/wavemill-ready-watchdog.XXXXXX")" || {
    log_warn "ready watchdog tick failed: could not create diagnostic file"
    return 0
  }

  local watchdog_output
  if ! watchdog_output=$(_with_timeout "$watchdog_timeout" \
    npx tsx "$TOOLS_DIR/ready-watchdog.ts" \
      --once \
      --repo-dir "$REPO_DIR" \
      --state-file "$STATE_FILE" \
      --json 2>"$watchdog_stderr"); then
    watchdog_error="$(tail -n 1 "$watchdog_stderr" 2>/dev/null | tr '\n' ' ' | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//')"
    rm -f "$watchdog_stderr"
    [[ -n "$watchdog_error" ]] || watchdog_error="command exited non-zero or timed out after ${watchdog_timeout}s"
    now=$(date +%s)
    if [[ "${LAST_READY_WATCHDOG_FAILURE_DETAIL:-}" != "$watchdog_error" || $(( now - ${LAST_READY_WATCHDOG_FAILURE_AT:-0} )) -ge "$READY_WATCHDOG_FAILURE_LOG_INTERVAL" ]]; then
      log_warn "ready watchdog tick failed: $watchdog_error"
      LAST_READY_WATCHDOG_FAILURE_DETAIL="$watchdog_error"
      LAST_READY_WATCHDOG_FAILURE_AT=$now
    fi
    return 0
  fi
  rm -f "$watchdog_stderr"
  LAST_READY_WATCHDOG_FAILURE_DETAIL=""
  LAST_READY_WATCHDOG_FAILURE_AT=0

  while IFS= read -r finding; do
    [[ -n "$finding" ]] || continue
    local issue label detail action slug branch base_branch pr_number title wt_dir state_dir remediation_categories
    issue=$(printf '%s' "$finding" | jq -r '.issueId // empty' 2>/dev/null || echo "")
    label=$(printf '%s' "$finding" | jq -r '.displayLabel // empty' 2>/dev/null || echo "")
    detail=$(printf '%s' "$finding" | jq -r '.detail // empty' 2>/dev/null || echo "")
    action=$(printf '%s' "$finding" | jq -r '.action // empty' 2>/dev/null || echo "")
    [[ -n "$issue" && -n "$label" && -n "$detail" ]] || continue
    if [[ "$action" == "queue-remediation" ]]; then
      slug=$(read_state_value "" --arg i "$issue" '.tasks[$i].slug // ""')
      branch=$(read_state_value "" --arg i "$issue" '.tasks[$i].branch // ""')
      base_branch=$(read_state_value "" --arg i "$issue" '.tasks[$i].baseBranch // ""')
      pr_number=$(read_state_value "" --arg i "$issue" '.tasks[$i].pr // ""')
      title=$(read_state_value "" --arg i "$issue" '.tasks[$i].title // "Task"')
      wt_dir=$(read_state_value "" --arg i "$issue" '.tasks[$i].worktree // ""')
      [[ -z "$wt_dir" && -n "$slug" ]] && wt_dir="${WORKTREE_ROOT}/${slug}"
      if [[ -n "$slug" && -n "$branch" && -n "$base_branch" && -n "$pr_number" ]]; then
        state_dir=$(ready_state_dir "$wt_dir" "$slug")
        remediation_categories=$(printf '%s' "$finding" | jq -c '.remediationCategories // []' 2>/dev/null || echo '[]')
        local detail_json
        detail_json=$(jq -cn --argjson categories "$remediation_categories" --arg detail "$detail" '{categories:$categories, detail:$detail}' 2>/dev/null || echo '{}')
        local head_sha
        head_sha=$(git -C "$wt_dir" rev-parse HEAD 2>/dev/null) || head_sha=""
        if [[ -n "$head_sha" ]]; then
          marker_write "$state_dir/.ready-watchdog-stable-failure.json" --kind watchdog-stable-failure --head "$head_sha" --detail-json "$detail_json" --reason "$detail"
        fi
        launch_ready_phase "$issue" "$slug" "$title" "$wt_dir" "$branch" "$base_branch" "$pr_number" >/dev/null 2>&1 || true
      fi
    fi
    log "status" "ready watchdog: $issue $label ($action) - $detail"
  done < <(printf '%s' "$watchdog_output" | jq -c '.findings[]?' 2>/dev/null)
}

ready_remediation_enabled() {
  local wt_dir="$1"
  local remediation_json
  remediation_json=$(ready_remediation_config_json "$wt_dir")
  jq -r '.enabled // true' <<< "$remediation_json" 2>/dev/null || echo "true"
}

ready_remediation_max_attempts() {
  local wt_dir="$1"
  local remediation_json
  remediation_json=$(ready_remediation_config_json "$wt_dir")
  jq -r '.maxAttempts // 3' <<< "$remediation_json" 2>/dev/null || echo "3"
}

ready_remediation_agent_cmd() {
  local wt_dir="$1"
  local remediation_json
  remediation_json=$(ready_remediation_config_json "$wt_dir")
  jq -r '.agentCmd // empty' <<< "$remediation_json" 2>/dev/null || echo ""
}

# ── Post-PR reconciliation capsule (HOK-2936) ────────────────────────────────
# Durable, head-keyed recovery context so a fresh agent can repair
# deterministic CI failures or merge conflicts without the original pane.
# Default-off; the capsule on disk is the correctness boundary — never tmux
# scrollback, a live process, or provider session resume.

post_pr_reconciliation_config_json() {
  local wt_dir="$1"
  local user_config="$HOME/.wavemill/config.json"
  local repo_config="$wt_dir/.wavemill-config.json"
  local local_config="$wt_dir/.wavemill-config.local.json"
  local user_json='{}' repo_json='{}' local_json='{}'

  [[ -f "$user_config" ]] && user_json=$(cat "$user_config" 2>/dev/null || echo '{}')
  [[ -f "$repo_config" ]] && repo_json=$(cat "$repo_config" 2>/dev/null || echo '{}')
  [[ -f "$local_config" ]] && local_json=$(cat "$local_config" 2>/dev/null || echo '{}')

  jq -n -c \
    --argjson user "$user_json" \
    --argjson repo "$repo_json" \
    --argjson local "$local_json" \
    '
    ({ready:{postPrReconciliation:{enabled:false}}} * $user * $repo * $local).ready.postPrReconciliation
    ' 2>/dev/null || echo '{"enabled":false}'
}

post_pr_reconciliation_enabled() {
  local wt_dir="$1"
  local recon_json
  recon_json=$(post_pr_reconciliation_config_json "$wt_dir")
  jq -r 'if .enabled == true then "true" else "false" end' <<< "$recon_json" 2>/dev/null || echo "false"
}

# ── Queue-owned pane release (HOK-2937) ─────────────────────────────────────

PANE_RELEASE_PREREQ_WARNED=false

pane_release_config_json() {
  local wt_dir="$1"
  local user_config="$HOME/.wavemill/config.json"
  local repo_config="$wt_dir/.wavemill-config.json"
  local local_config="$wt_dir/.wavemill-config.local.json"
  local user_json='{}' repo_json='{}' local_json='{}'

  [[ -f "$user_config" ]] && user_json=$(cat "$user_config" 2>/dev/null || echo '{}')
  [[ -f "$repo_config" ]] && repo_json=$(cat "$repo_config" 2>/dev/null || echo '{}')
  [[ -f "$local_config" ]] && local_json=$(cat "$local_config" 2>/dev/null || echo '{}')

  jq -n -c \
    --argjson user "$user_json" \
    --argjson repo "$repo_json" \
    --argjson local "$local_json" \
    '
    ({ready:{paneRelease:{enabled:false}}} * $user * $repo * $local).ready.paneRelease
    ' 2>/dev/null || echo '{"enabled":false}'
}

pane_release_enabled() {
  local wt_dir="$1"
  local release_json
  release_json=$(pane_release_config_json "$wt_dir")
  if [[ "$(jq -r 'if .enabled == true then "true" else "false" end' <<< "$release_json" 2>/dev/null || echo "false")" != "true" ]]; then
    printf '%s\n' "false"
    return 0
  fi
  if [[ "$(post_pr_reconciliation_enabled "$wt_dir")" != "true" ]]; then
    if [[ "${PANE_RELEASE_PREREQ_WARNED:-false}" != "true" ]]; then
      log_warn "ready.paneRelease.enabled requires ready.postPrReconciliation.enabled, retaining legacy panes"
      PANE_RELEASE_PREREQ_WARNED=true
    fi
    printf '%s\n' "false"
    return 0
  fi
  printf '%s\n' "true"
}

pane_release_marker_path() {
  local state_dir="$1"
  printf '%s\n' "$state_dir/.pane-release-blocked.json"
}

pane_release_reason_actionable() {
  case "$1" in
    dirty-worktree|unpushed-commits|no-remote-branch|git-error|capsule-invalid:*|capsule-head-mismatch|review-not-passed|review-stale|live-agent-child|liveness-indeterminate|pending-approval|attention-marker-present|reconciliation-lease-held|pr-not-open)
      return 0
      ;;
  esac
  return 1
}

write_pane_release_blocked_marker() {
  local state_dir="$1" reason="$2" wt_dir="${3:-}" head_sha=""
  [[ -n "$state_dir" ]] || return 0
  if [[ -n "$wt_dir" ]]; then
    head_sha="$(git -C "$wt_dir" rev-parse HEAD 2>/dev/null || true)"
  fi
  [[ -n "$head_sha" ]] || head_sha="$(git -C "$state_dir" rev-parse HEAD 2>/dev/null || true)"
  [[ -n "$head_sha" ]] || return 0
  marker_write "$(pane_release_marker_path "$state_dir")" --kind pane-release-blocked --head "$head_sha" --reason "$reason"
}

clear_stale_pane_release_blocked_marker() {
  local state_dir="$1" wt_dir="${2:-}" marker head_sha=""
  marker="$(pane_release_marker_path "$state_dir")"
  [[ -f "$marker" ]] || return 0
  if [[ -n "$wt_dir" ]]; then
    head_sha="$(git -C "$wt_dir" rev-parse HEAD 2>/dev/null || true)"
  fi
  [[ -n "$head_sha" ]] || return 0
  if marker_is_stale "$marker" "$head_sha"; then
    marker_clear "$marker"
  fi
}

fresh_hook_state_for_issue() {
  local issue="$1" hook_file="/tmp/wavemill-${SESSION}-${issue}.hook"
  local hook_ts now staleness
  [[ -f "$hook_file" ]] || return 1
  hook_ts=$(jq -r '.timestamp // 0' "$hook_file" 2>/dev/null || echo 0)
  [[ "$hook_ts" =~ ^[0-9]+$ ]] || return 1
  now=$(date +%s)
  staleness=$((now - hook_ts))
  (( staleness < 300 )) || return 1
  jq -r '.state // empty' "$hook_file" 2>/dev/null || true
}

pane_release_preflight() {
  local issue="$1" slug="$2" state_dir="$3" wt_dir="$4" pr_number="$5"
  local branch="${6:-}" base_branch="${7:-${BASE_BRANCH:-main}}" pr_state_value current_head review_status
  local validate_out validate_reason capsule_review_head safety_reason target pane_pid live_rc hook_state

  if [[ "$(pane_release_enabled "$wt_dir")" != "true" ]]; then
    printf '%s\n' "flag-off"
    return 1
  fi
  [[ -n "$state_dir" && -d "$state_dir" ]] || { printf '%s\n' "context-missing"; return 1; }
  [[ -n "$wt_dir" && -d "$wt_dir" ]] || { printf '%s\n' "worktree-missing"; return 1; }
  [[ -n "$pr_number" ]] || { printf '%s\n' "pr-missing"; return 1; }

  pr_state_value="$(pr_state "$pr_number" 2>/dev/null || echo "")"
  [[ "$pr_state_value" == "OPEN" ]] || { printf '%s\n' "pr-not-open"; return 1; }

  review_result_passes_ready_gate "$state_dir" || { printf '%s\n' "review-not-passed"; return 1; }
  review_status="$(jq -r '.status // empty' "$state_dir/.review-result.json" 2>/dev/null || echo "")"
  [[ "$review_status" != "stale" ]] || { printf '%s\n' "review-stale"; return 1; }
  if reconciliation_review_invalidated_by_commit "$state_dir" "$wt_dir"; then
    printf '%s\n' "review-stale"
    return 1
  fi

  if ! validate_out=$(npx tsx "$TOOLS_DIR/reconciliation-capsule.ts" validate --feature-dir "$state_dir" 2>/dev/null); then
    validate_reason="$(jq -r '.reason // "capsule_malformed"' <<< "$validate_out" 2>/dev/null || echo "capsule_malformed")"
    printf 'capsule-invalid:%s\n' "$validate_reason"
    return 1
  fi
  current_head="$(git -C "$wt_dir" rev-parse HEAD 2>/dev/null || true)"
  [[ -n "$current_head" ]] || { printf '%s\n' "git-error"; return 1; }
  capsule_review_head="$(jq -r '.review.reviewHeadSha // empty' "$state_dir/.reconciliation-context.json" 2>/dev/null || echo "")"
  [[ "$capsule_review_head" == "$current_head" ]] || { printf '%s\n' "capsule-head-mismatch"; return 1; }

  safety_reason="$(task_worktree_release_safety "$wt_dir" "$branch" "$base_branch" 2>/dev/null || true)"
  [[ "$safety_reason" == "ok" ]] || { printf '%s\n' "${safety_reason:-git-error}"; return 1; }

  target="$(_tmux_task_window_target "$SESSION" "$issue" "$slug" "${STATE_FILE:-}" "$wt_dir" 2>/dev/null || true)"
  if [[ -n "$target" && "$(command -v tmux 2>/dev/null || true)" != "" ]]; then
    pane_pid="$(tmux list-panes -t "$(_tmux_target_join "$SESSION" "$target")" -F '#{pane_pid}' 2>/dev/null | head -n 1 || true)"
    mill_pane_has_live_blocking_process "$pane_pid" || live_rc=$?
    live_rc="${live_rc:-0}"
    case "$live_rc" in
      0) printf '%s\n' "live-agent-child"; return 1 ;;
      2) printf '%s\n' "liveness-indeterminate"; return 1 ;;
    esac
  fi

  hook_state="$(fresh_hook_state_for_issue "$issue" 2>/dev/null || true)"
  case "$hook_state" in
    working|waiting|approval-needed)
      printf '%s\n' "pending-approval"
      return 1
      ;;
    blocked)
      printf '%s\n' "pending-approval"
      return 1
      ;;
    error)
      printf '%s\n' "pending-approval"
      return 1
      ;;
  esac
  if [[ -f "$state_dir/.needs-attention" ]] && ! marker_is_stale "$state_dir/.needs-attention" "$current_head"; then
    printf '%s\n' "attention-marker-present"
    return 1
  fi
  if reconciliation_lease_held "$state_dir"; then
    printf '%s\n' "reconciliation-lease-held"
    return 1
  fi

  printf '%s\n' "ok"
  return 0
}

release_task_pane_window_only() {
  local issue="$1" slug="$2" wt_dir="$3" target
  target="$(_tmux_task_window_target "$SESSION" "$issue" "$slug" "${STATE_FILE:-}" "$wt_dir" 2>/dev/null || true)"
  if [[ -n "$target" ]] && command -v tmux >/dev/null 2>&1; then
    tmux kill-window -t "$(_tmux_target_join "$SESSION" "$target")" 2>/dev/null || true
    if _tmux_window_target_exists "$SESSION" "$target" "$wt_dir"; then
      return 1
    fi
  fi
  rm -f "/tmp/wavemill-${SESSION}-${issue}.hook" 2>/dev/null || true
  return 0
}

release_task_pane() {
  local issue="$1" slug="$2" state_dir="$3" wt_dir="$4" pr_number="$5"
  local current_head capsule_digest=""
  current_head="$(git -C "$wt_dir" rev-parse HEAD 2>/dev/null || true)"
  capsule_digest="$(jq -r '.foundationDigest // empty' "$state_dir/.reconciliation-context.json" 2>/dev/null || true)"
  set_task_queue_owned "$issue" "$capsule_digest" || return 1
  release_task_pane_window_only "$issue" "$slug" "$wt_dir" || return 1
  marker_clear "$(pane_release_marker_path "$state_dir")"
  log "status" "🪁 $issue → pane released; queue-owned (PR #$pr_number, head ${current_head:0:7})"
  return 0
}

prepare_released_task_for_reconciliation() {
  local issue="$1" slug="$2" state_dir="$3" wt_dir="$4" pr_number="$5" current_head="$6"
  local validate_out validate_reason capsule_head lease_out
  if [[ "$(get_task_execution_owner "$issue")" != "queue" || "$(get_task_pane_state "$issue")" != "released" ]]; then
    return 0
  fi
  if ! validate_out=$(npx tsx "$TOOLS_DIR/reconciliation-capsule.ts" validate --feature-dir "$state_dir" 2>/dev/null); then
    validate_reason="$(jq -r '.reason // "capsule_malformed"' <<< "$validate_out" 2>/dev/null || echo "capsule_malformed")"
    write_ready_attention_file "$state_dir" "Reconciliation capsule invalid ($validate_reason) for PR #$pr_number - refusing pane rehydration."
    return 1
  fi
  capsule_head="$(jq -r '.incident.headSha // .review.reviewHeadSha // empty' "$state_dir/.reconciliation-context.json" 2>/dev/null || echo "")"
  if [[ -n "$capsule_head" && -n "$current_head" && "$capsule_head" != "$current_head" ]]; then
    bounded_retry_clear "$state_dir" "ready-remediation"
    log "status" "  ⏭ $issue: stale reconciliation request at ${capsule_head:0:7}, current head ${current_head:0:7}"
    return 1
  fi
  lease_out="$(reconciliation_lease_acquire "$state_dir" "$pr_number" "$current_head" 2>/dev/null || true)"
  if [[ "$lease_out" != "ok" ]]; then
    log "debug" "  $issue: reconciliation launch skipped ($lease_out)"
    return 1
  fi
  if ! set_task_reconciliation_owned "$issue"; then
    reconciliation_lease_release "$state_dir"
    return 1
  fi
  return 0
}

ensure_ready_worker_window() {
  local issue="$1" slug="$2" state_dir="$3" wt_dir="$4" pr_number="$5" current_head="$6"
  local win
  if [[ "$(get_task_execution_owner "$issue")" == "queue" && "$(get_task_pane_state "$issue")" == "released" ]]; then
    prepare_released_task_for_reconciliation "$issue" "$slug" "$state_dir" "$wt_dir" "$pr_number" "$current_head" || return 1
  elif [[ "$(get_task_execution_owner "$issue")" == "reconciliation" && "$(get_task_pane_state "$issue")" == "rehydrating" ]] \
    && reconciliation_lease_held "$state_dir"; then
    return 1
  fi
  win="$(_ensure_task_window_exists "$SESSION" "$issue" "$slug" "$wt_dir")" || return 1
  persist_task_window_id "$issue" "$win"
  printf '%s\n' "$win"
  return 0
}

reconciliation_feature_task_packet() {
  local state_dir="$1"
  local candidate
  for candidate in "$state_dir/task-packet-header.md" "$state_dir/task-packet.md"; do
    if [[ -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  printf '\n'
  return 0
}

# Build/refresh the durable capsule. Only called after the PR is open and the
# review readiness gate passed, so the recorded review head is genuine final
# evidence. The foundation is immutable after first write; only the review
# identity is refreshed here. Best-effort: launch-time gating enforces safety.
reconciliation_capsule_refresh() {
  local state_dir="$1" wt_dir="$2" pr_number="$3" branch="$4" base_branch="$5"
  local issue="$6" slug="$7" title="$8"
  local review_head review_verdict task_packet build_out

  review_result_has_final_evidence "$state_dir" || return 1
  review_head=$(git -C "$wt_dir" rev-parse HEAD 2>/dev/null || echo "")
  review_verdict=$(jq -r '
    (.artifacts // {}) as $a
    | (if ($a.type // "") == "review" then $a else ($a.review // {}) end).verdict // empty
  ' "$state_dir/.review-result.json" 2>/dev/null || echo "")
  task_packet="$(reconciliation_feature_task_packet "$state_dir")"

  if ! build_out=$(npx tsx "$TOOLS_DIR/reconciliation-capsule.ts" build \
      --feature-dir "$state_dir" \
      --task-id "$issue" \
      --title "$title" \
      --slug "$slug" \
      --branch "$branch" \
      --base-branch "$base_branch" \
      --pr "$pr_number" \
      ${review_head:+--review-head "$review_head"} \
      ${review_verdict:+--review-verdict "$review_verdict"} \
      ${task_packet:+--task-packet "$task_packet"} \
      2>/dev/null); then
    log_warn "  $issue: could not refresh reconciliation capsule: $(jq -r '.reason // "unknown"' <<< "$build_out" 2>/dev/null || echo "unknown")"
    return 1
  fi
  return 0
}

# Validate the capsule and write the projected recovery prompt (byte-stable
# foundation prefix first, volatile incident suffix last) to $prompt_file.
# Missing/malformed/oversized/digest-mismatched capsules surface a typed
# needs-user reason and refuse the launch (REQ-F4).
reconciliation_project_prompt() {
  local state_dir="$1" pr_number="$2" prompt_file="$3"
  local validate_out reason
  if ! validate_out=$(npx tsx "$TOOLS_DIR/reconciliation-capsule.ts" validate --feature-dir "$state_dir" 2>/dev/null); then
    reason=$(jq -r '.reason // "capsule_malformed"' <<< "$validate_out" 2>/dev/null || echo "capsule_malformed")
    write_ready_attention_file "$state_dir" "Reconciliation capsule invalid ($reason) for PR #$pr_number - refusing autonomous recovery launch."
    return 1
  fi
  if ! npx tsx "$TOOLS_DIR/reconciliation-capsule.ts" project --feature-dir "$state_dir" > "$prompt_file" 2>/dev/null; then
    write_ready_attention_file "$state_dir" "Reconciliation capsule projection failed for PR #$pr_number - refusing autonomous recovery launch."
    return 1
  fi
  return 0
}

# Retry identity is (PR, head SHA, failure fingerprint) (REQ-F5). The head key
# lives in the shared bounded-retry bucket (HOK-2924); the fingerprint
# companion file shares the bucket's file prefix so bounded_retry_clear
# removes it symmetrically. A changed fingerprint starts a new episode.
reconciliation_reset_retry_if_new_fingerprint() {
  local state_dir="$1" bucket="$2" fingerprint="$3"
  local fp_file="$state_dir/.retry-${bucket}-fingerprint" stored=""
  [[ -n "$fingerprint" ]] || return 0
  [[ -f "$fp_file" ]] && stored=$(cat "$fp_file" 2>/dev/null || echo "")
  if [[ -n "$stored" && "$stored" != "$fingerprint" ]]; then
    bounded_retry_clear "$state_dir" "$bucket"
  fi
  mkdir -p "$state_dir"
  printf '%s\n' "$fingerprint" > "$fp_file"
  return 0
}

# Record one bounded attempt per launch (REQ-F7). Best-effort telemetry.
reconciliation_record_attempt() {
  local state_dir="$1" agent="$2" model="$3" head="$4"
  local provider
  provider=$(jq -r '.coding.provider // empty' "$state_dir/.phase-config.json" 2>/dev/null || echo "")
  npx tsx "$TOOLS_DIR/reconciliation-capsule.ts" record-attempt \
    --feature-dir "$state_dir" \
    ${agent:+--agent "$agent"} \
    ${model:+--model "$model"} \
    ${provider:+--provider "$provider"} \
    ${head:+--head "$head"} \
    --launch-mode fresh \
    --outcome launched >/dev/null 2>&1 || true
  return 0
}

# A worker commit past the recorded review head invalidates the old verdict
# (REQ-F6). Only fires once at least one reconciliation attempt was recorded,
# so ordinary pre-reconciliation flows are untouched.
reconciliation_review_invalidated_by_commit() {
  local state_dir="$1" wt_dir="$2"
  local capsule="$state_dir/.reconciliation-context.json"
  local review_head current_head attempts
  [[ -f "$capsule" ]] || return 1
  review_head=$(jq -r '.review.reviewHeadSha // empty' "$capsule" 2>/dev/null || echo "")
  attempts=$(jq -r '.attempts | length' "$capsule" 2>/dev/null || echo "0")
  [[ -n "$review_head" ]] || return 1
  [[ "$attempts" =~ ^[0-9]+$ ]] && (( attempts > 0 )) || return 1
  current_head=$(git -C "$wt_dir" rev-parse HEAD 2>/dev/null || echo "")
  [[ -n "$current_head" ]] || return 1
  [[ "$current_head" != "$review_head" ]]
}

# Mark the review result stale against its recorded head so the ready gate
# refuses wm:ready until a fresh review passes at the new head, and finalize
# the launching attempt with the pushed commit.
reconciliation_mark_review_stale() {
  local state_dir="$1" pr_number="$2" old_head="$3" new_head="$4"
  local review_file="$state_dir/.review-result.json"
  if [[ -f "$review_file" ]]; then
    state_mutate "$review_file" \
      '.status = "stale" | .detail = $detail | .staleReviewHead = $old_head' \
      --arg detail "Review verdict at $old_head is stale after reconciliation commit $new_head - re-review required for PR #$pr_number" \
      --arg old_head "$old_head" || return 1
  fi
  npx tsx "$TOOLS_DIR/reconciliation-capsule.ts" finalize-attempt \
    --feature-dir "$state_dir" --outcome commit_pushed --result-commit "$new_head" >/dev/null 2>&1 || true
  return 0
}

phase_should_remain_active_without_pr() {
  local feature_dir="$1" phase="$2" slug="$3"

  case "$phase" in
    routing)
      ! check_routing_complete "$slug"
      return $?
      ;;
    planning|coding|review|ready)
      stage_result_is_in_progress "$feature_dir" "$phase"
      return $?
      ;;
  esac

  return 1
}

# Approve a plan: transition planning from awaiting_user to completed.
# Usage: approve_plan <feature_dir> [agent] [model]
approve_plan() {
  local feature_dir="$1"
  local agent="${2:-}" model="${3:-}"
  write_stage_result "$feature_dir" "planning" "completed" "$agent" "$model" "Plan approved by user" '{"type":"planning","planFile":"plan.md"}'
}

resolve_stage_result_model() {
  local feature_dir="$1" stage="$2" fallback="${3:-}"
  local model="" launch_model=""
  local challenge_varied_model

  case "$stage" in
    coding)
      model=$(read_phase_config "$feature_dir" "coding" "model")
      [[ -z "$model" ]] && model=$(get_task_meta "$ISSUE" "coderModel")
      [[ -z "$model" ]] && model=$(jq -r '.model // empty' "$feature_dir/.coding-result.json" 2>/dev/null || echo "")
      challenge_varied_model="$(challenge_varied_stage_model "$ISSUE" "coding" 2>/dev/null || true)"
      if [[ -n "$challenge_varied_model" ]]; then
        model="$challenge_varied_model"
      else
        model="$(resolve_phase_model "coding" "$model" "${fallback:-claude-opus-4-7}")"
      fi
      if [[ -z "$challenge_varied_model" ]] && declare -F agent_resolve_model >/dev/null 2>&1; then
        launch_model="$(agent_resolve_model "coder" "$model" "$REPO_DIR" 2>/dev/null || true)"
      fi
      ;;
    review)
      model=$(read_phase_config "$feature_dir" "review" "model")
      [[ -z "$model" ]] && model=$(get_task_meta "$ISSUE" "reviewerModel")
      [[ -z "$model" ]] && model=$(jq -r '.model // empty' "$feature_dir/.review-result.json" 2>/dev/null || echo "")
      local challenge_varied_review
      challenge_varied_review="$(challenge_varied_stage_model "$ISSUE" "review" 2>/dev/null || true)"
      if [[ -n "$challenge_varied_review" && "$challenge_varied_review" != "$model" ]]; then
        log_warn "  $ISSUE: review-stage challenge arm restored from state ($model → $challenge_varied_review)"
        model="$challenge_varied_review"
      fi
      if [[ -z "$challenge_varied_review" ]]; then
        model="$(resolve_phase_model "review" "$model" "${fallback:-claude-sonnet-5}")"
      fi
      if [[ -z "$challenge_varied_review" ]] && declare -F agent_resolve_model >/dev/null 2>&1; then
        launch_model="$(agent_resolve_model "reviewer" "$model" "$REPO_DIR" 2>/dev/null || true)"
      fi
      ;;
    *)
      model="$fallback"
      ;;
  esac

  printf '%s\n' "${launch_model:-$model}"
}

# Validate that planning stayed within its phase boundary before coding starts.
# Usage: validate_planning_phase_output <wt_dir>
# Returns non-zero after reverting out-of-scope changes and removing approval.
# Records the paths already dirty when planning launches. Write-once: relaunches
# must not re-baseline planning leftovers after a rejection.
capture_planning_baseline() {
  local wt_dir="$1"
  local slug feature_dir baseline_file tmp_file

  [[ -d "$wt_dir/.git" || -f "$wt_dir/.git" ]] || return 0

  slug="$(basename "$wt_dir")"
  feature_dir="$wt_dir/features/$slug"
  baseline_file="$feature_dir/.planning-baseline-dirty"

  [[ -f "$baseline_file" ]] && return 0
  mkdir -p "$feature_dir" || return 0
  tmp_file="$(mktemp "$feature_dir/.planning-baseline-dirty.tmp.XXXXXX" 2>/dev/null)" || return 0

  {
    git -C "$wt_dir" diff --name-only HEAD -- 2>/dev/null || true
    git -C "$wt_dir" ls-files --others --exclude-standard 2>/dev/null || true
  } | sort -u > "$tmp_file"

  mv "$tmp_file" "$baseline_file" 2>/dev/null || rm -f "$tmp_file"
}

validate_planning_phase_output() {
  local wt_dir="$1"
  local slug
  slug="$(basename "$wt_dir")"
  local feature_dir="$wt_dir/features/$slug"
  local baseline_file="$feature_dir/.planning-baseline-dirty"
  local changed_file
  local -a out_of_scope_files=()

  VALIDATE_PLANNING_LAST_OUT_OF_SCOPE_FILES=()
  VALIDATE_PLANNING_LAST_STASH_REF=""

  [[ -d "$wt_dir/.git" || -f "$wt_dir/.git" ]] || return 0

  while IFS= read -r changed_file; do
    [[ -n "$changed_file" ]] || continue
    if [[ -f "$baseline_file" ]] && grep -Fxq -- "$changed_file" "$baseline_file"; then
      continue
    fi
    case "$changed_file" in
      features/*) ;;
      *)
        if wavemill_owned_dirty_path "$changed_file" "$slug"; then
          continue
        else
          out_of_scope_files+=("$changed_file")
        fi
        ;;
    esac
  done < <(
    {
      git -C "$wt_dir" diff --name-only HEAD -- 2>/dev/null || true
      git -C "$wt_dir" ls-files --others --exclude-standard 2>/dev/null || true
    } | sort -u
  )

  if [[ ${#out_of_scope_files[@]} -eq 0 ]]; then
    return 0
  fi

  VALIDATE_PLANNING_LAST_OUT_OF_SCOPE_FILES=("${out_of_scope_files[@]}")
  log_warn "WARNING: Planning phase modified source code files: ${out_of_scope_files[*]}"

  local cleanup_failed=0

  # refs/stash is local to this worktree clone; recover before task cleanup.
  if git -C "$wt_dir" stash push --quiet --include-untracked \
    -m "wavemill planning guard: out-of-scope planning output ($slug)" \
    -- "${out_of_scope_files[@]}" 2>/dev/null; then
    VALIDATE_PLANNING_LAST_STASH_REF="stash@{0}"
    log_warn "Planning phase validation stashed out-of-scope files. Recovery command: git stash pop stash@{0}"
  else
    log_warn "Planning phase validation could not stash out-of-scope files. Files were left in place"
    cleanup_failed=1
  fi

  # Report overall cleanup status
  if [[ $cleanup_failed -eq 1 ]]; then
    log_warn "Planning phase validation encountered cleanup errors"
  fi

  rm -f "$feature_dir/.plan-approved"
  return 1
}

planning_rejection_files_summary() {
  local -a files=("$@")
  local joined=""
  local file

  if [[ ${#files[@]} -eq 0 ]]; then
    printf 'out-of-scope files'
    return 0
  fi

  for file in "${files[@]:0:3}"; do
    if [[ -n "$joined" ]]; then
      joined+=", "
    fi
    joined+="$file"
  done

  if (( ${#files[@]} > 3 )); then
    joined+=" (+$(( ${#files[@]} - 3 )) more)"
  fi

  printf '%s' "$joined"
}

write_planning_rejection_artifact() {
  local issue="$1" feature_dir="$2"
  shift 2
  local -a files=("$@")
  local artifact="$feature_dir/.planning-rejected.json"
  local files_json created_at stash_ref stash_ref_json recommended_action

  stash_ref="${VALIDATE_PLANNING_LAST_STASH_REF:-}"
  if [[ -n "$stash_ref" ]]; then
    stash_ref_json="$(printf '%s' "$stash_ref" | jq -R . 2>/dev/null || printf 'null')"
    recommended_action="Review plan.md and re-approve the plan. Out-of-scope planning output was stashed and can be recovered with git stash pop $stash_ref before task cleanup."
  else
    stash_ref_json="null"
    recommended_action="Review plan.md and re-approve the plan. Planning may only write feature artifacts; out-of-scope files were left in place because recovery-safe revert failed."
  fi

  mkdir -p "$feature_dir"
  if (( ${#files[@]} == 0 )); then
    files_json='[]'
  else
    files_json=$(printf '%s\n' "${files[@]}" | jq -R . | jq -s . 2>/dev/null || printf '[]')
  fi
  created_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  jq -n \
    --arg issue "$issue" \
    --arg stage "planning" \
    --arg status "awaiting_user" \
    --arg reason "planning_modified_out_of_scope_files" \
    --arg createdAt "$created_at" \
    --arg recommendedAction "$recommended_action" \
    --argjson outOfScopeFiles "$files_json" \
    --argjson stashRef "$stash_ref_json" \
    '{issue: $issue, stage: $stage, status: $status, reason: $reason, outOfScopeFiles: $outOfScopeFiles, reverted: ($stashRef != null), stashRef: $stashRef, approvalMarkerRemoved: true, recommendedAction: $recommendedAction, createdAt: $createdAt}' > "$artifact"
}

notify_planning_rejection_agent() {
  local feature_dir="$1" win="$2"
  shift 2
  local -a files=("$@")
  local artifact="$feature_dir/.planning-rejected.json"
  local slug files_summary notified message target issue

  [[ -n "${SESSION:-}" && -n "$win" && -f "$artifact" ]] || return 0

  notified=$(jq -r '.notifiedAt // empty' "$artifact" 2>/dev/null || true)
  [[ -z "$notified" ]] || return 0

  slug="$(basename "$feature_dir")"
  if [[ "$win" =~ ^([A-Z]+-[0-9]+(_c)?)-(.+)$ ]]; then
    issue="${BASH_REMATCH[1]}"
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

  files_summary="$(planning_rejection_files_summary "${files[@]}")"
  message="Planning approval was rejected because planning modified out-of-scope files: $files_summary. Those changes were stashed when possible and .plan-approved was removed. Do not edit source/config files during planning. Update only features/$slug/plan.md if needed, then wait for user approval again."

  local now_iso status signal attempts detail
  now_iso="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  if wavemill_pane_send_message "$target" "$message" "$issue" "$SESSION"; then
    status="${WAVEMILL_PANE_MESSAGE_LAST_STATUS:-delivered}"
    signal="${WAVEMILL_PANE_MESSAGE_LAST_SIGNAL:-none}"
    attempts="${WAVEMILL_PANE_MESSAGE_LAST_ATTEMPTS:-1}"
    detail="${WAVEMILL_PANE_MESSAGE_LAST_DETAIL:-}"
    # Use state_mutate for concurrency-safe artifact writes (CLAUDE.md).
    state_mutate "$artifact" \
      '.notifiedAt = $notifiedAt | .notifyStatus = $notifyStatus | .notifySignal = $notifySignal | .notifyDetail = $notifyDetail | .notifyTarget = $notifyTarget | .notifyAttempts = $notifyAttempts' \
      --arg notifiedAt "$now_iso" \
      --arg notifyStatus "$status" \
      --arg notifySignal "$signal" \
      --arg notifyDetail "$detail" \
      --arg notifyTarget "$target" \
      --argjson notifyAttempts "$attempts" \
      2>/dev/null || true
    return 0
  fi

  # Delivery failed after retries. Record the failure durably on the artifact
  # (so it survives the hook TTL) and escalate to the dashboard inbox via the
  # blocked hook state so an operator can recover manually.
  status="${WAVEMILL_PANE_MESSAGE_LAST_STATUS:-unconfirmed}"
  signal="${WAVEMILL_PANE_MESSAGE_LAST_SIGNAL:-none}"
  attempts="${WAVEMILL_PANE_MESSAGE_LAST_ATTEMPTS:-0}"
  detail="${WAVEMILL_PANE_MESSAGE_LAST_DETAIL:-delivery not confirmed}"

  log_warn "$issue: failed to deliver planning rejection notification to agent pane ($status after $attempts attempts): $detail"

  state_mutate "$artifact" \
    'del(.notifiedAt) | .notifyStatus = $notifyStatus | .notifySignal = $notifySignal | .notifyDetail = $notifyDetail | .notifyTarget = $notifyTarget | .notifyLastAttemptAt = $notifyLastAttemptAt | .notifyAttempts = $notifyAttempts' \
    --arg notifyStatus "$status" \
    --arg notifySignal "$signal" \
    --arg notifyDetail "$detail" \
    --arg notifyTarget "$target" \
    --arg notifyLastAttemptAt "$now_iso" \
    --argjson notifyAttempts "$attempts" \
    2>/dev/null || true

  local hook_protocol="$LIB_DIR/../hooks/wavemill-hook-protocol.sh"
  local next_action="Press Enter in tmux window $target to submit the pending planning-rejection notice, or relay it manually."
  if [[ -f "$hook_protocol" ]]; then
    # shellcheck disable=SC1090
    source "$hook_protocol" || true
    if declare -F wavemill_hook_write >/dev/null 2>&1; then
      WAVEMILL_SESSION="$SESSION" WAVEMILL_ISSUE="$issue" \
        wavemill_hook_write "blocked" "planning_rejection_notify_failed" \
          "planning rejection notice $status after $attempts attempts" \
          "${current_agent:-unknown}" \
          "$next_action" || true
    fi
  fi

  return 0
}

blocked_completion_announce_marker() {
  local feature_dir="$1"
  printf '%s\n' "$feature_dir/.blocked-completion-announced"
}

blocked_completion_should_announce() {
  local feature_dir="$1" artifact_mtime="${2:-}"
  local marker last_announced effective_mtime

  # Use UNKNOWN sentinel when stat is unavailable so dedupe still works
  effective_mtime="${artifact_mtime:-UNKNOWN}"
  marker="$(blocked_completion_announce_marker "$feature_dir")"
  [[ -f "$marker" ]] || return 0

  last_announced="$(head -1 "$marker" 2>/dev/null | tr -d '\r')"
  [[ "$last_announced" != "$effective_mtime" ]]
}

mark_blocked_completion_announced() {
  local feature_dir="$1" artifact_mtime="${2:-}"
  local marker tmp_file effective_mtime

  # Use UNKNOWN sentinel when stat is unavailable so dedupe still works
  effective_mtime="${artifact_mtime:-UNKNOWN}"
  marker="$(blocked_completion_announce_marker "$feature_dir")"
  tmp_file="$(mktemp "$feature_dir/.blocked-completion-announced.tmp.XXXXXX" 2>/dev/null)" || return 0
  printf '%s\n' "$effective_mtime" > "$tmp_file" && mv "$tmp_file" "$marker" 2>/dev/null || rm -f "$tmp_file"
}

emit_blocked_completion_attention() {
  local issue="$1" feature_dir="$2"
  local artifact_record summary reason artifact_mtime slug win

  artifact_record="$(read_blocked_completion "$feature_dir")"
  [[ -n "$artifact_record" ]] || return 1

  IFS=$'\001' read -r summary reason artifact_mtime <<< "$artifact_record"
  slug="$(basename "$feature_dir")"
  win="$issue-$slug"

  if blocked_completion_should_announce "$feature_dir" "$artifact_mtime"; then
    log "status" "$issue needs attention: $summary. Type \"advance $issue\" to launch review."
    mark_blocked_completion_announced "$feature_dir" "$artifact_mtime"
  fi

  set_window_attention_state "$win" "needs-user"
  active_count=$((active_count + 1))
  return 0
}

blocked_completion_live_process_mode() {
  case "${WAVEMILL_BLOCKED_COMPLETION_LIVE_PROCESS_MODE:-attention}" in
    terminate) printf 'terminate\n' ;;
    *) printf 'attention\n' ;;
  esac
}

emit_blocked_completion_liveness_attention() {
  local issue="$1" feature_dir="$2" win="$3" detail="$4" next_action="$5"
  local artifact_record summary reason artifact_mtime
  local hook_protocol="$LIB_DIR/../hooks/wavemill-hook-protocol.sh"

  artifact_record="$(read_blocked_completion "$feature_dir")"
  IFS=$'\001' read -r summary reason artifact_mtime <<< "$artifact_record"

  if blocked_completion_should_announce "$feature_dir" "$artifact_mtime"; then
    log "status" "$issue needs attention: $detail. $next_action"
    mark_blocked_completion_announced "$feature_dir" "$artifact_mtime"
  fi

  if [[ -f "$hook_protocol" ]]; then
    source "$hook_protocol" || true
    WAVEMILL_SESSION="$SESSION" WAVEMILL_ISSUE="$issue" \
      wavemill_hook_write "blocked" "blocked_completion_liveness" "$detail" "${current_agent:-unknown}" "$next_action" || true
  fi

  set_window_attention_state "$win" "needs-user"
  AUTO_ADVANCE_BLOCKED_COMPLETION_HANDLED="attention"
  active_count=$((active_count + 1))
  return 0
}

write_codex_capacity_blocked_completion() {
  local issue="$1" feature_dir="$2" model="${3:-}" source="${4:-unknown}"
  local artifact recovery_marker artifact_tmp recovery_tmp slug timestamp
  local capacity_message="${CODEX_CAPACITY_MESSAGE:-Selected model is at capacity. Please try a different model.}"
  local capacity_reason="${CODEX_CAPACITY_REASON:-model_at_capacity}"

  artifact="$(blocked_completion_artifact_path "$feature_dir")"
  recovery_marker="$(codex_capacity_recovery_marker "$feature_dir")"
  slug="$(basename "$feature_dir")"
  timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  [[ -f "$artifact" ]] && return 1
  [[ -f "$recovery_marker" ]] && return 0

  artifact_tmp="$(mktemp "$artifact.tmp.XXXXXX" 2>/dev/null)" || return 1
  if ! jq -n \
    --arg reason "$capacity_reason" \
    --arg blockingReason "model_at_capacity" \
    --arg evidence "Codex pane was idle at the terminal capacity prompt after confirmation dwell." \
    --arg recommendedAction "relaunch_coding" \
    --arg summary "coding blocked: Codex model at capacity" \
    --arg humanReason "$capacity_message" \
    --arg detectedAt "$timestamp" \
    --arg issue "$issue" \
    --arg slug "$slug" \
    --arg model "$model" \
    --arg source "$source" \
    '{
      stage: "coding",
      implementationComplete: false,
      committed: false,
      passingChecks: [],
      blockingChecks: ["codex_model_capacity"],
      blockingReason: $blockingReason,
      evidence: $evidence,
      recommendedAction: $recommendedAction,
      summary: $summary,
      reason: $humanReason,
      capacityReason: $reason,
      detectedAt: $detectedAt,
      issue: $issue,
      slug: $slug,
      model: (if ($model | length) > 0 then $model else null end),
      source: $source
    }' > "$artifact_tmp"; then
    rm -f "$artifact_tmp"
    return 1
  fi

  mv "$artifact_tmp" "$artifact" 2>/dev/null || {
    rm -f "$artifact_tmp"
    return 1
  }

  recovery_tmp="$(mktemp "$recovery_marker.tmp.XXXXXX" 2>/dev/null)" || return 1
  if ! jq -n \
    --arg issue "$issue" \
    --arg slug "$slug" \
    --arg model "$model" \
    --arg source "$source" \
    --arg action "wrote_blocked_completion" \
    --arg reason "$capacity_reason" \
    --arg detectedAt "$timestamp" \
    '{
      issue: $issue,
      slug: $slug,
      model: (if ($model | length) > 0 then $model else null end),
      source: $source,
      action: $action,
      reason: $reason,
      detectedAt: $detectedAt
    }' > "$recovery_tmp"; then
    rm -f "$recovery_tmp"
    return 1
  fi

  mv "$recovery_tmp" "$recovery_marker" 2>/dev/null || {
    rm -f "$recovery_tmp"
    return 1
  }

  codex_capacity_clear_dwell_marker "$feature_dir"
}

blocked_completion_current_head() {
  local worktree="$1"
  git -C "$worktree" rev-parse HEAD 2>/dev/null || true
}

coding_output_dirty_paths() {
  local worktree="$1" slug="$2"
  local status_lines line path normalized_path

  status_lines="$(git -C "$worktree" status --porcelain --untracked-files=all 2>/dev/null || true)"
  [[ -z "$status_lines" ]] && return 0

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    path="${line#?? }"
    if [[ "$path" == *" -> "* ]]; then
      path="${path##* -> }"
    fi
    normalized_path="${path#./}"

    if blocked_completion_auto_allowed_dirty_path "$normalized_path" "$slug"; then
      continue
    fi

    printf '%s\n' "$normalized_path"
  done <<< "$status_lines"
}

blocked_completion_commit_matches_head() {
  local artifact_commit="${1:-}" head="${2:-}"

  [[ -z "$artifact_commit" ]] && return 0
  [[ -n "$head" ]] || return 1
  [[ "$artifact_commit" == "$head" ]] && return 0
  [[ "$head" == "$artifact_commit"* ]] && return 0
  return 1
}

# wavemill_owned_feature_artifact_path <normalized_path> <slug>
# Returns 0 when the path is a Wavemill-owned artifact scoped to features/<slug>/.
wavemill_owned_feature_artifact_path() {
  local normalized_path="$1" slug="$2"
  local artifact_prefix="features/$slug/"

  if [[ "$normalized_path" == ${artifact_prefix}.* ]]; then
    return 0
  fi

  # challenge-intent.json is the write-once challenger selection record.
  case "$normalized_path" in
    "${artifact_prefix}plan.md"|\
    "${artifact_prefix}task-packet"*.md|\
    "${artifact_prefix}challenge-intent.json"|\
    "${artifact_prefix}selected-task.json"|\
    "${artifact_prefix}trace.jsonl"|\
    "${artifact_prefix}routing.jsonl")
      return 0
      ;;
  esac

  return 1
}

# wavemill_owned_dirty_path <normalized_path> <slug>
# Single source of truth for Wavemill-owned generated/runtime paths.
wavemill_owned_dirty_path() {
  local normalized_path="$1" slug="$2"

  # Wavemill injects status hooks into this Claude-local settings file. Some
  # repositories track it, so it must not prevent an otherwise committed task
  # from advancing into review.
  if [[ "$normalized_path" == ".claude/settings.local.json" ]]; then
    return 0
  fi

  if [[ "$normalized_path" == .wavemill/* ]]; then
    return 0
  fi

  # This repository-local overlay is generated and consumed by Wavemill, but
  # intentionally remains untracked so each session can carry local settings.
  if [[ "$normalized_path" == ".wavemill-config.local.json" ]]; then
    return 0
  fi

  # Root prompt registry updates are Wavemill-owned generated metadata.
  if [[ "$normalized_path" == "prompt-registry.jsonl" ]]; then
    return 0
  fi

  wavemill_owned_feature_artifact_path "$normalized_path" "$slug"
}

blocked_completion_auto_allowed_dirty_path() {
  local normalized_path="$1" slug="$2"

  wavemill_owned_dirty_path "$normalized_path" "$slug"
}

blocked_completion_worktree_clean_for_auto() {
  local worktree="$1" slug="$2"
  [[ -z "$(coding_output_dirty_paths "$worktree" "$slug")" ]]
}

coding_uncommitted_output_announce_marker() {
  local feature_dir="$1"
  printf '%s\n' "$feature_dir/.coding-uncommitted-output-announced"
}

coding_uncommitted_output_should_announce() {
  local feature_dir="$1" artifact_mtime="${2:-}"
  local marker last_announced effective_mtime

  effective_mtime="${artifact_mtime:-UNKNOWN}"
  marker="$(coding_uncommitted_output_announce_marker "$feature_dir")"
  [[ -f "$marker" ]] || return 0

  last_announced="$(head -1 "$marker" 2>/dev/null | tr -d '\r')"
  [[ "$last_announced" != "$effective_mtime" ]]
}

mark_coding_uncommitted_output_announced() {
  local feature_dir="$1" artifact_mtime="${2:-}"
  local marker tmp_file effective_mtime

  effective_mtime="${artifact_mtime:-UNKNOWN}"
  marker="$(coding_uncommitted_output_announce_marker "$feature_dir")"
  tmp_file="$(mktemp "$feature_dir/.coding-uncommitted-output-announced.tmp.XXXXXX" 2>/dev/null)" || return 0
  printf '%s\n' "$effective_mtime" > "$tmp_file" && mv "$tmp_file" "$marker" 2>/dev/null || rm -f "$tmp_file"
}

clear_coding_uncommitted_output_attention() {
  local feature_dir="$1"
  local artifact resolved_log coding_complete_epoch coding_complete_iso_arg

  artifact="$(coding_uncommitted_output_artifact_path "$feature_dir")"

  # Preserve the handoff episode before deleting the live artifact: eval-time
  # manual-edit attribution (HOK-2894) needs the [detectedAt, resolvedAt]
  # interval to recognise an operator commit that completes an agent's
  # uncommitted output as an intentional handoff rather than a silent zero.
  # Best-effort — must never block the advance path.
  if [[ -f "$artifact" ]] && command -v jq >/dev/null 2>&1 && jq -e . "$artifact" >/dev/null 2>&1; then
    resolved_log="$(coding_uncommitted_output_resolved_log_path "$feature_dir")"
    coding_complete_iso_arg="null"
    coding_complete_epoch="$(portable_file_mtime_epoch "$feature_dir/.coding-complete" 2>/dev/null || echo "")"
    if [[ "$coding_complete_epoch" =~ ^[0-9]+$ ]]; then
      coding_complete_iso_arg="$(jq -n --argjson e "$coding_complete_epoch" '$e | todate' 2>/dev/null || echo "null")"
    fi
    jq -c --arg resolvedAt "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" --argjson codingCompleteAt "$coding_complete_iso_arg" \
      '. + {resolvedAt: $resolvedAt, codingCompleteAt: $codingCompleteAt}' \
      "$artifact" >> "$resolved_log" 2>/dev/null || true
  fi

  rm -f "$artifact" "$(coding_uncommitted_output_announce_marker "$feature_dir")"
}

coding_compare_commit_counts() {
  local worktree="$1" base_branch="$2"
  git -C "$worktree" rev-list --left-right --count "$base_branch...HEAD" 2>/dev/null || printf '0\t0\n'
}

write_coding_uncommitted_output_artifact() {
  local issue="$1" feature_dir="$2" base_branch="$3" ahead_count="$4" behind_count="$5" dirty_paths_raw="${6:-}" summary="$7" action="$8" reason="${9:-coding_output_not_committed}"
  local artifact slug artifact_tmp first_path dirty_paths_json existing_norm new_norm

  artifact="$(coding_uncommitted_output_artifact_path "$feature_dir")"
  slug="$(basename "$feature_dir")"
  artifact_tmp="$(mktemp "$artifact.tmp.XXXXXX" 2>/dev/null)" || return 1
  first_path="$(printf '%s\n' "$dirty_paths_raw" | head -1)"
  dirty_paths_json="$(printf '%s\n' "$dirty_paths_raw" | jq -R . | jq -s . 2>/dev/null || printf '[]')"

  if ! jq -n \
    --arg issue "$issue" \
    --arg slug "$slug" \
    --arg baseBranch "$base_branch" \
    --arg reason "$reason" \
    --arg summary "$summary" \
    --arg action "$action" \
    --arg firstDirtyPath "$first_path" \
    --argjson aheadCount "$ahead_count" \
    --argjson behindCount "$behind_count" \
    --argjson dirtyPaths "$dirty_paths_json" \
    --arg detectedAt "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
    '{
      issue: $issue,
      slug: $slug,
      reason: $reason,
      baseBranch: $baseBranch,
      aheadCount: $aheadCount,
      behindCount: $behindCount,
      dirtyPaths: $dirtyPaths,
      firstDirtyPath: (if ($firstDirtyPath | length) > 0 then $firstDirtyPath else null end),
      summary: $summary,
      action: $action,
      detectedAt: $detectedAt
    }' > "$artifact_tmp"; then
    rm -f "$artifact_tmp"
    return 1
  fi

  if [[ -f "$artifact" ]]; then
    existing_norm="$(jq -cS 'del(.detectedAt)' "$artifact" 2>/dev/null || true)"
    new_norm="$(jq -cS 'del(.detectedAt)' "$artifact_tmp" 2>/dev/null || true)"
    if [[ -n "$existing_norm" && -n "$new_norm" && "$existing_norm" == "$new_norm" ]]; then
      rm -f "$artifact_tmp"
      return 0
    fi
  fi

  mv "$artifact_tmp" "$artifact" 2>/dev/null || {
    rm -f "$artifact_tmp"
    return 1
  }
}

guard_coding_complete_handoff() {
  local issue="$1" feature_dir="$2" worktree="$3" base_branch="$4"
  local slug dirty_paths compare_counts behind_count ahead_count artifact_record summary reason action artifact_mtime
  local handoff_summary handoff_action handoff_reason
  local win

  slug="$(basename "$feature_dir")"
  dirty_paths="$(coding_output_dirty_paths "$worktree" "$slug")"
  if [[ -z "$dirty_paths" ]]; then
    clear_coding_uncommitted_output_attention "$feature_dir"
    return 1
  fi

  compare_counts="$(coding_compare_commit_counts "$worktree" "$base_branch")"
  behind_count="${compare_counts%%[[:space:]]*}"
  ahead_count="${compare_counts##*[[:space:]]}"
  [[ "$behind_count" =~ ^[0-9]+$ ]] || behind_count=0
  [[ "$ahead_count" =~ ^[0-9]+$ ]] || ahead_count=0

  if [[ "$ahead_count" == "0" ]]; then
    handoff_reason="coding_output_not_committed"
    handoff_summary="coding completed marker detected, but branch has no commits beyond $base_branch and worktree still contains uncommitted coding output"
    handoff_action="Commit the coding output, then retry review."
  else
    handoff_reason="coding_output_dirty_tree"
    handoff_summary="coding completed marker detected, but worktree still contains uncommitted coding output"
    handoff_action="Clean the dirty paths, then retry review."
  fi

  write_coding_uncommitted_output_artifact "$issue" "$feature_dir" "$base_branch" "$ahead_count" "$behind_count" "$dirty_paths" "$handoff_summary" "$handoff_action" "$handoff_reason" || true
  artifact_record="$(read_coding_uncommitted_output "$feature_dir")"
  IFS=$'\001' read -r summary reason action artifact_mtime <<< "$artifact_record"
  win="$issue-$slug"

  if coding_uncommitted_output_should_announce "$feature_dir" "$artifact_mtime"; then
    log "status" "$issue needs attention: $summary. $action"
    mark_coding_uncommitted_output_announced "$feature_dir" "$artifact_mtime"
  fi

  write_stage_result "$feature_dir" "coding" "running" "${current_agent:-}" "$(resolve_stage_result_model "$feature_dir" "coding" "claude-opus-4-7")" "Awaiting committed coding output before review"
  set_window_attention_state "$win" "needs-user"
  active_count=$((active_count + 1))
  return 0
}

seam_artifact_cli_path() {
  local candidate
  for candidate in \
    "${REPO_DIR:-}/tools/seam-artifact-cli.ts" \
    "${TOOLS_DIR:-}/seam-artifact-cli.ts" \
    "${LIB_DIR:-}/../../tools/seam-artifact-cli.ts"; do
    [[ -n "$candidate" && -f "$candidate" ]] || continue
    printf '%s\n' "$candidate"
    return 0
  done

  printf '%s\n' "${REPO_DIR:-${LIB_DIR%/shared/lib}}/tools/seam-artifact-cli.ts"
}

seam_validate_artifact() {
  local artifact="$1" artifact_path="$2"
  shift 2
  local cli stderr_file rc

  cli="$(seam_artifact_cli_path)"
  stderr_file="$(mktemp "${TMPDIR:-/tmp}/seam-validate.XXXXXX" 2>/dev/null)" || return 2
  SEAM_VALIDATION_JSON="$(wavemill_run_tsx_tool "$cli" validate "$artifact" "$artifact_path" "$@" 2>"$stderr_file")"
  rc=$?
  if [[ "$rc" -eq 2 ]]; then
    log_warn "seam validator unavailable for $artifact ($artifact_path): $(tail -n 3 "$stderr_file" | tr '\n' ' ')"
  fi
  rm -f "$stderr_file"
  return "$rc"
}

seam_validation_error_summary() {
  local json="${1:-${SEAM_VALIDATION_JSON:-}}"
  jq -r '[.errors[]? | "\(.code) at \(.path): \(.message)"] | join("; ")' <<<"$json" 2>/dev/null
}

seam_validation_has_code() {
  local code="$1" json="${2:-${SEAM_VALIDATION_JSON:-}}"
  jq -e --arg code "$code" '.errors[]? | select(.code == $code)' <<<"$json" >/dev/null 2>&1
}

write_coding_complete_marker() {
  local feature_dir="$1" confidence="$2" source="$3"
  local marker_path tmp timestamp

  marker_path="$feature_dir/.coding-complete"
  timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  tmp="$(mktemp "$marker_path.tmp.XXXXXX" 2>/dev/null)" || return 1
  if ! jq -n \
    --arg confidence "$confidence" \
    --arg source "$source" \
    --arg createdAt "$timestamp" \
    '{stage: "coding", confidence: $confidence, source: $source, createdAt: $createdAt}' > "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  mv "$tmp" "$marker_path"
}

blocked_completion_validate_for_advance() {
  local issue="$1" feature_dir="$2" mode="${3:-auto}"
  local slug artifact_path artifact_rel_path result_path result_rel_path worktree
  local json_valid=false schema_valid=false stage_running=false stage_is_coding=false
  local implementation_complete=false committed=false recommended_action_matches=false
  local has_passing_checks=false has_blocking_checks=false commit_matches_head=true
  local worktree_clean=true artifact_fresh=true artifact_commit="" current_head="" decision_reason=""
  local started_at="" artifact_epoch="" started_epoch=""
  local manual_soft_failure=false
  local validation_errors_json='[]'
  local _blocked_completion_bool

  slug="$(basename "$feature_dir")"
  worktree="$(git -C "$feature_dir/../.." rev-parse --show-toplevel 2>/dev/null || true)"
  artifact_path="$feature_dir/.coding-blocked-completion.json"
  artifact_rel_path="features/$slug/.coding-blocked-completion.json"
  result_path="$feature_dir/.coding-result.json"
  result_rel_path="features/$slug/.coding-result.json"

  if [[ ! -f "$artifact_path" ]]; then
    decision_reason="missing blocked-completion artifact"
  else
    if seam_validate_artifact blocked-completion "$artifact_path" --canonicalize; then
      json_valid=true
      schema_valid=true
    else
      case "$?" in
        1)
          validation_errors_json="$(jq -c '.errors // []' <<<"$SEAM_VALIDATION_JSON" 2>/dev/null || echo '[]')"
          if seam_validation_has_code MALFORMED_JSON "$SEAM_VALIDATION_JSON"; then
            decision_reason="invalid JSON in $artifact_rel_path"
          else
            json_valid=true
            decision_reason="invalid blocked-completion artifact: $(seam_validation_error_summary "$SEAM_VALIDATION_JSON")"
          fi
          ;;
        *)
          decision_reason="seam validator unavailable"
          ;;
      esac
    fi
  fi

  if [[ "$json_valid" == true && "$schema_valid" == true ]]; then
    stage_is_coding=$(jq -r 'if .stage == "coding" then "true" else "false" end' "$artifact_path" 2>/dev/null || echo false)
    implementation_complete=$(jq -r 'if .implementationComplete == true then "true" else "false" end' "$artifact_path" 2>/dev/null || echo false)
    committed=$(jq -r 'if .committed == true then "true" else "false" end' "$artifact_path" 2>/dev/null || echo false)
    recommended_action_matches=$(jq -r 'if .recommendedAction == "advance_to_review" then "true" else "false" end' "$artifact_path" 2>/dev/null || echo false)
    has_passing_checks=$(jq -r 'if ((.passingChecks | length) > 0) then "true" else "false" end' "$artifact_path" 2>/dev/null || echo false)
    has_blocking_checks=$(jq -r 'if ((.blockingChecks | length) > 0) then "true" else "false" end' "$artifact_path" 2>/dev/null || echo false)
    artifact_commit=$(jq -r '.commit // empty' "$artifact_path" 2>/dev/null || echo "")

    if [[ ! -f "$result_path" ]]; then
      decision_reason="${decision_reason:-missing $result_rel_path}"
    elif ! jq -e '.stage == "coding" and .status == "running"' "$result_path" >/dev/null 2>&1; then
      decision_reason="${decision_reason:-$result_rel_path is not coding/running}"
    else
      stage_running=true
    fi

    if [[ "$stage_is_coding" != true ]]; then
      decision_reason="${decision_reason:-blocked-completion artifact stage is not coding}"
    elif [[ "$implementation_complete" != true ]]; then
      decision_reason="${decision_reason:-implementationComplete must be true}"
    elif [[ "$committed" != true ]]; then
      decision_reason="${decision_reason:-committed must be true}"
    elif [[ "$recommended_action_matches" != true ]]; then
      decision_reason="${decision_reason:-recommendedAction must be advance_to_review}"
    elif [[ "$has_passing_checks" != true ]]; then
      decision_reason="${decision_reason:-passingChecks must be non-empty}"
    fi
  fi

  if [[ -n "$artifact_commit" ]]; then
    current_head="$(blocked_completion_current_head "$worktree")"
    if ! blocked_completion_commit_matches_head "$artifact_commit" "$current_head"; then
      commit_matches_head=false
      if [[ "$mode" == "auto" ]]; then
        decision_reason="${decision_reason:-artifact commit does not match HEAD}"
      else
        manual_soft_failure=true
      fi
    fi
  fi

  if [[ -f "$artifact_path" && -f "$result_path" ]]; then
    started_at="$(jq -r '.startedAt // empty' "$result_path" 2>/dev/null || echo "")"
    artifact_epoch="$(portable_file_mtime_epoch "$artifact_path" 2>/dev/null || echo "")"
    started_epoch="$(wavemill_iso8601_to_epoch "$started_at" 2>/dev/null || echo "")"
    if [[ -n "$artifact_epoch" && "$artifact_epoch" != "0" && -n "$started_epoch" && "$started_epoch" != "0" ]]; then
      if (( artifact_epoch < started_epoch )); then
        artifact_fresh=false
        if [[ "$mode" == "auto" ]]; then
          decision_reason="${decision_reason:-blocked-completion artifact predates current coding attempt}"
        else
          manual_soft_failure=true
        fi
      fi
    fi
  fi

  if ! blocked_completion_worktree_clean_for_auto "$worktree" "$slug"; then
    worktree_clean=false
    if [[ "$mode" == "auto" ]]; then
      decision_reason="${decision_reason:-worktree is not clean enough for auto-advance}"
    else
      manual_soft_failure=true
    fi
  fi

  if [[ -z "$decision_reason" && "$mode" == "manual" && "$manual_soft_failure" == true ]]; then
    decision_reason="manual override accepted with soft guardrail failures"
  fi
  [[ -z "$decision_reason" ]] && decision_reason="eligible"

  local _blocked_completion_bools=(stage_running json_valid schema_valid stage_is_coding implementation_complete committed recommended_action_matches has_passing_checks has_blocking_checks commit_matches_head worktree_clean artifact_fresh)
  for _blocked_completion_bool in "${_blocked_completion_bools[@]}"; do
    case "${!_blocked_completion_bool:-}" in
      true|false) ;;
      *) printf -v "$_blocked_completion_bool" '%s' false ;;
    esac
  done
  if ! jq empty <<<"$validation_errors_json" >/dev/null 2>&1; then
    validation_errors_json='[]'
  fi

  jq -n \
    --arg issue "$issue" \
    --arg mode "$mode" \
    --arg artifactPath "$artifact_rel_path" \
    --arg resultPath "$result_rel_path" \
    --arg reason "$decision_reason" \
    --arg commit "$artifact_commit" \
    --arg head "$current_head" \
    --arg stageRunning "$stage_running" \
    --arg jsonValid "$json_valid" \
    --arg schemaValid "$schema_valid" \
    --arg stageIsCoding "$stage_is_coding" \
    --arg implementationComplete "$implementation_complete" \
    --arg committed "$committed" \
    --arg recommendedActionMatches "$recommended_action_matches" \
    --arg hasPassingChecks "$has_passing_checks" \
    --arg hasBlockingChecks "$has_blocking_checks" \
    --arg commitMatchesHead "$commit_matches_head" \
    --arg worktreeClean "$worktree_clean" \
    --arg artifactFresh "$artifact_fresh" \
    --arg validationErrorsJson "$validation_errors_json" \
    --arg eligibleValue "$(
      if [[ "$decision_reason" == "eligible" || "$decision_reason" == "manual override accepted with soft guardrail failures" ]]; then
        printf 'true'
      else
        printf 'false'
      fi
    )" \
    '{
      issue: $issue,
      mode: $mode,
      eligible: ($eligibleValue == "true"),
      reason: $reason,
      artifactPath: $artifactPath,
      resultPath: $resultPath,
      commit: $commit,
      head: $head,
      guardrails: {
        "stageRunning": ($stageRunning == "true"),
        "jsonValid": ($jsonValid == "true"),
        "schemaValid": ($schemaValid == "true"),
        "stageIsCoding": ($stageIsCoding == "true"),
        "implementationComplete": ($implementationComplete == "true"),
        "committed": ($committed == "true"),
        "recommendedActionMatches": ($recommendedActionMatches == "true"),
        "hasPassingChecks": ($hasPassingChecks == "true"),
        "hasBlockingChecks": ($hasBlockingChecks == "true"),
        "commitMatchesHead": ($commitMatchesHead == "true"),
        "worktreeClean": ($worktreeClean == "true"),
        "artifactFresh": ($artifactFresh == "true")
      },
      validationErrors: ($validationErrorsJson | fromjson? // [])
    }'

  if [[ "$decision_reason" == "eligible" || "$decision_reason" == "manual override accepted with soft guardrail failures" ]]; then
    return 0
  fi

  return 1
}

archive_stale_coding_artifacts() {
  local issue="$1" feature_dir="$2"
  local candidates=(
    ".coding-complete"
    ".coding-blocked-completion.json"
    ".blocked-completion-announced"
    ".coding-uncommitted-output-announced"
    ".coding-failure-handoff.json"
  )
  local present=() name archive_dir archived_names=()

  for name in "${candidates[@]}"; do
    [[ -e "$feature_dir/$name" ]] && present+=("$name")
  done
  ((${#present[@]} > 0)) || return 0

  archive_dir="$feature_dir/.stale-artifacts/coding-$(date -u +%Y%m%dT%H%M%SZ)"
  if ! mkdir -p "$archive_dir" 2>/dev/null; then
    log_warn "$issue → Could not create stale coding artifact archive, continuing launch"
    return 0
  fi

  for name in "${present[@]}"; do
    if mv "$feature_dir/$name" "$archive_dir/$name" 2>/dev/null; then
      archived_names+=("$name")
    fi
  done

  if ((${#archived_names[@]} > 0)); then
    local IFS=', '
    log "status" "$issue → archived stale coding artifacts from a previous attempt: ${archived_names[*]}"
  fi
  return 0
}

complete_coding_advance() {
  local issue="$1" feature_dir="$2" audit_path="$3" stage_notes="$4"
  local audit_timestamp="${5:-}" summary="${6:-}" slug="${7:-}" passing_count="${8:-}" blocking_count="${9:-}" decision_json="${10:-}" blocked_json="${11:-}"
  local marker_source="${12:-blocked-completion-manual-advance}"
  local marker_path advance_agent result_path result_model finished_at audit_tmp

  if [[ -n "$audit_timestamp" ]]; then
    if [[ ! -f "$audit_path" ]] && ! printf '{}\n' | write_json_artifact "$audit_path"; then
      log_warn "$issue advance failed: could not initialize audit artifact"
      return 1
    fi

    if ! state_mutate "$audit_path" '
        .timestamp = $timestamp
        | .issue = $issue
        | .slug = $slug
        | .commit = ($validation.commit // "")
        | .reason = $reason
        | .blocked_completion_path = $blockedCompletionPath
        | .blocked_completion_summary = $blockedCompletionSummary
        | .guardrails = ($validation.guardrails // {})
        | .passing_checks_count = ($passingChecksCount | tonumber)
        | .blocking_checks_count = ($blockingChecksCount | tonumber)
        | .blockedCompletion = (($blocked[0] // {}) | {
            stage,
            implementationComplete,
            committed,
            commit,
            passingChecks,
            blockingChecks,
            blockingReason,
            evidence,
            recommendedAction
          })
      ' \
      --arg timestamp "$audit_timestamp" \
      --arg issue "$issue" \
      --arg slug "$slug" \
      --arg reason "automatic advance from valid blocked-completion artifact" \
      --arg blockedCompletionPath "features/$slug/.coding-blocked-completion.json" \
      --arg blockedCompletionSummary "$summary" \
      --arg passingChecksCount "$passing_count" \
      --arg blockingChecksCount "$blocking_count" \
      --argjson validation "$decision_json" \
      --argjson blocked "$blocked_json"; then
      log_warn "$issue advance failed: could not finalize audit artifact"
      return 1
    fi
  else
    audit_tmp="$(mktemp "$audit_path.tmp.XXXXXX" 2>/dev/null)" || {
      log_warn "$issue advance failed: could not create audit artifact"
      return 1
    }
    cat > "$audit_tmp"
    if ! mv "$audit_tmp" "$audit_path"; then
      rm -f "$audit_tmp"
      log_warn "$issue advance failed: could not finalize audit artifact"
      return 1
    fi
  fi

  advance_agent="${current_agent:-}"
  result_model="$(resolve_stage_result_model "$feature_dir" "coding" "claude-opus-4-7")"
  result_path="$feature_dir/.coding-result.json"
  if [[ ! -f "$result_path" ]]; then
    log_warn "$issue advance failed: missing coding stage result"
    return 1
  fi

  finished_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  if ! state_mutate "$result_path" '
      .stage = "coding"
      | .status = "completed"
      | .startedAt = (.startedAt // $finishedAt)
      | .finishedAt = $finishedAt
      | .agent = $agent
      | .model = $model
      | .notes = $notes
    ' \
    --arg finishedAt "$finished_at" \
    --arg agent "$advance_agent" \
    --arg model "$result_model" \
    --arg notes "$stage_notes"; then
    log_warn "$issue advance failed: could not update coding stage result"
    return 1
  fi
  _write_stage_result_trace_event "$feature_dir" "coding" "completed" "$advance_agent" "$result_model"

  marker_path="$feature_dir/.coding-complete"
  if ! write_coding_complete_marker "$feature_dir" "medium" "$marker_source"; then
    log_warn "$issue advance failed: could not create $marker_path"
    return 1
  fi

  quarantine_completed_coding_pane "$issue" "$feature_dir"

  return 0
}

auto_advance_blocked_completion() {
  local issue="$1" feature_dir="$2" win_target="${3:-}" win="${4:-$1-$(basename "$2")}"
  local slug artifact_path artifact_record summary reason artifact_mtime decision_json
  local audit_path audit_timestamp passing_count blocking_count blocked_json
  local pane_pid live_process_mode liveness_rc
  local blocking_command next_action
  local -a blocking_commands=()
  local -a MILL_BLOCKING_PROCESS_PIDS=()

  AUTO_ADVANCE_BLOCKED_COMPLETION_REASON=""
  AUTO_ADVANCE_BLOCKED_COMPLETION_HANDLED=""
  artifact_path="$feature_dir/.coding-blocked-completion.json"
  [[ -f "$artifact_path" ]] || return 1

  slug="$(basename "$feature_dir")"
  decision_json="$(blocked_completion_validate_for_advance "$issue" "$feature_dir" auto 2>/dev/null)" || {
    AUTO_ADVANCE_BLOCKED_COMPLETION_REASON="$(jq -r '.reason // "blocked-completion artifact is ineligible"' <<<"$decision_json" 2>/dev/null || echo "blocked-completion artifact is ineligible")"
    return 1
  }

  artifact_record="$(read_blocked_completion "$feature_dir")"
  IFS=$'\001' read -r summary reason artifact_mtime <<< "$artifact_record"
  audit_path="$feature_dir/.coding-auto-advance.json"
  audit_timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  passing_count="$(jq -r '(.passingChecks // []) | length' "$artifact_path" 2>/dev/null || echo 0)"
  blocking_count="$(jq -r '(.blockingChecks // []) | length' "$artifact_path" 2>/dev/null || echo 0)"
  blocked_json="$(jq -c '[.]' "$artifact_path")"
  if ! mapfile -t blocking_commands < <(jq -r '(.blockingChecks // [])[]? | strings' "$artifact_path" 2>/dev/null); then
    AUTO_ADVANCE_BLOCKED_COMPLETION_REASON="blocked-completion liveness checks could not parse blocking checks"
    emit_blocked_completion_liveness_attention \
      "$issue" \
      "$feature_dir" \
      "$win" \
      "blocked-completion auto-advance refused because liveness is indeterminate (could not parse blocking checks)" \
      "Inspect the coding pane for $issue and resolve the blocked completion manually."
    return 1
  fi

  pane_pid="$(tmux display-message -p -t "$win_target" '#{pane_pid}' 2>/dev/null || true)"
  mill_pane_has_live_blocking_process "$pane_pid" "${blocking_commands[@]}"
  liveness_rc=$?
  if [[ "$liveness_rc" -eq 2 ]]; then
    AUTO_ADVANCE_BLOCKED_COMPLETION_REASON="blocked-completion liveness indeterminate: ${MILL_BLOCKING_PROCESS_REASON:-unknown reason}"
    emit_blocked_completion_liveness_attention \
      "$issue" \
      "$feature_dir" \
      "$win" \
      "blocked-completion auto-advance refused because liveness is indeterminate (${MILL_BLOCKING_PROCESS_REASON:-unknown reason})" \
      "Inspect the coding pane for $issue and resolve the blocked completion manually."
    return 1
  fi

  if [[ "$liveness_rc" -eq 0 ]]; then
    blocking_command="${MILL_BLOCKING_PROCESS_COMMAND:-live blocking process}"
    next_action="Stop the live blocking command for $issue (${blocking_command}), then retry review."
    live_process_mode="$(blocked_completion_live_process_mode)"
    if [[ "$live_process_mode" == "terminate" ]] && (( ${#MILL_BLOCKING_PROCESS_PIDS[@]} > 0 )); then
      if mill_terminate_blocking_processes "$pane_pid" "${MILL_BLOCKING_PROCESS_PIDS[@]}"; then
        mill_pane_has_live_blocking_process "$pane_pid" "${blocking_commands[@]}"
        liveness_rc=$?
        if [[ "$liveness_rc" -eq 1 ]]; then
          log "status" "[auto-advance] $issue terminated live blocking process before coding handoff: $blocking_command"
        elif [[ "$liveness_rc" -eq 2 ]]; then
          AUTO_ADVANCE_BLOCKED_COMPLETION_REASON="blocked-completion liveness indeterminate after termination: ${MILL_BLOCKING_PROCESS_REASON:-unknown reason}"
          emit_blocked_completion_liveness_attention \
            "$issue" \
            "$feature_dir" \
            "$win" \
            "blocked-completion auto-advance refused because post-termination liveness is indeterminate (${MILL_BLOCKING_PROCESS_REASON:-unknown reason})" \
            "Inspect the coding pane for $issue and confirm the blocking command has stopped."
          return 1
        else
          blocking_command="${MILL_BLOCKING_PROCESS_COMMAND:-$blocking_command}"
          AUTO_ADVANCE_BLOCKED_COMPLETION_REASON="live blocking process still running after termination attempt"
          emit_blocked_completion_liveness_attention \
            "$issue" \
            "$feature_dir" \
            "$win" \
            "blocked-completion auto-advance refused because a live blocking command is still running after termination attempt ($blocking_command)" \
            "Inspect the coding pane for $issue and stop the remaining blocking command manually."
          return 1
        fi
      else
        AUTO_ADVANCE_BLOCKED_COMPLETION_REASON="failed to terminate live blocking process"
        emit_blocked_completion_liveness_attention \
          "$issue" \
          "$feature_dir" \
          "$win" \
          "blocked-completion auto-advance refused because the live blocking command could not be terminated ($blocking_command)" \
          "Inspect the coding pane for $issue and stop the blocking command manually."
        return 1
      fi
    else
      AUTO_ADVANCE_BLOCKED_COMPLETION_REASON="live blocking process still running"
      emit_blocked_completion_liveness_attention \
        "$issue" \
        "$feature_dir" \
        "$win" \
        "blocked-completion auto-advance refused because a live blocking command is still running ($blocking_command)" \
        "$next_action"
      return 1
    fi
  fi

  if ! complete_coding_advance \
    "$issue" \
    "$feature_dir" \
    "$audit_path" \
    "Blocked verification accepted automatically; review may proceed" \
    "$audit_timestamp" \
    "$summary" \
    "$slug" \
    "$passing_count" \
    "$blocking_count" \
    "$decision_json" \
    "$blocked_json" \
    "blocked-completion-auto-advance"; then
    return 1
  fi

  log "status" "[auto-advance] $issue advancing coding to review from valid .coding-blocked-completion.json"
  return 0
}

handle_planning_overreach_rejection() {
  local issue="$1" feature_dir="$2" win="$3" current_agent="${4:-}"
  local -a files=("${VALIDATE_PLANNING_LAST_OUT_OF_SCOPE_FILES[@]:-}")
  local files_summary
  local stash_ref="${VALIDATE_PLANNING_LAST_STASH_REF:-}"

  files_summary="$(planning_rejection_files_summary "${files[@]}")"
  write_planning_rejection_artifact "$issue" "$feature_dir" "${files[@]}"
  if [[ -n "$stash_ref" ]]; then
    log_warn "$issue needs attention: planning edited $files_summary. Reverted recoverably via git stash ($stash_ref). Review plan.md and re-approve to continue."
    write_stage_result "$feature_dir" "planning" "awaiting_user" "$current_agent" "" "Planning edited $files_summary. Reverted recoverably via git stash and awaiting re-approval"
  else
    log_warn "$issue needs attention: planning edited $files_summary. Could not revert safely. Files were left in place. Review plan.md and re-approve to continue."
    write_stage_result "$feature_dir" "planning" "awaiting_user" "$current_agent" "" "Planning edited $files_summary. Could not revert safely and awaiting re-approval"
  fi
  notify_planning_rejection_agent "$feature_dir" "$win" "${files[@]}"
  set_window_attention_state "$win" "needs-user"
}

# Warn if coding already created a PR before the review phase can run.
# Usage: validate_coding_phase_output <branch>
validate_coding_phase_output() {
  local branch="$1"
  local pr_number

  pr_number=$(gh pr list --head "$branch" --json number --jq '.[0].number // empty' 2>/dev/null || true)
  if [[ -n "$pr_number" ]]; then
    log_warn "WARNING: Coding phase created PR #$pr_number before review phase"
  fi

  return 0
}

recover_misplaced_coding_complete_marker() {
  local issue="$1" worktree="$2" feature_dir="$3" slug="$4"
  local expected_marker misplaced_marker rel_marker audit_path audit_tmp recovered_at

  expected_marker="$feature_dir/.coding-complete"
  [[ -f "$expected_marker" ]] && return 1
  [[ -d "$worktree" ]] || return 1

  misplaced_marker="$(
    find "$worktree" \
      -path "$expected_marker" -prune -o \
      -path "*/features/$slug/.coding-complete" -type f -print -quit 2>/dev/null || true
  )"
  if [[ -z "$misplaced_marker" && -f "$worktree/.coding-complete" ]]; then
    if git -C "$worktree" ls-files --error-unmatch .coding-complete >/dev/null 2>&1; then
      return 1
    fi
    misplaced_marker="$worktree/.coding-complete"
  fi
  [[ -n "$misplaced_marker" ]] || return 1
  [[ "$misplaced_marker" != "$expected_marker" ]] || return 1

  if [[ "$misplaced_marker" == "$worktree/.coding-complete" ]]; then
    rel_marker=".coding-complete"
  else
    rel_marker="${misplaced_marker#"$worktree"/}"
  fi
  recovered_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  audit_path="$feature_dir/.coding-marker-recovered.json"
  audit_tmp="$(mktemp "$audit_path.tmp.XXXXXX" 2>/dev/null)" || {
    log_warn "$issue → Found misplaced .coding-complete at $rel_marker but could not create recovery audit"
    return 1
  }

  jq -n \
    --arg issue "$issue" \
    --arg expected "features/$slug/.coding-complete" \
    --arg found "$rel_marker" \
    --arg timestamp "$recovered_at" \
    '{
      issue: $issue,
      type: "misplaced-coding-complete-marker",
      expected: $expected,
      found: $found,
      recoveredAt: $timestamp
    }' > "$audit_tmp" || {
      rm -f "$audit_tmp"
      log_warn "$issue → Found misplaced .coding-complete at $rel_marker but could not write recovery audit"
      return 1
    }

  if ! mv "$audit_tmp" "$audit_path"; then
    rm -f "$audit_tmp"
    log_warn "$issue → Found misplaced .coding-complete at $rel_marker but could not finalize recovery audit"
    return 1
  fi

  if ! mv "$misplaced_marker" "$expected_marker"; then
    log_warn "$issue → Found misplaced .coding-complete at $rel_marker but could not move expected marker"
    return 1
  fi

  log_warn "$issue → Recovered misplaced .coding-complete from $rel_marker"
  return 0
}

recover_misplaced_plan_md() {
  local issue="$1" worktree="$2" feature_dir="$3" slug="$4"
  local expected_plan misplaced_plan rel_plan audit_path audit_tmp recovered_at

  expected_plan="$feature_dir/plan.md"
  [[ -f "$expected_plan" ]] && return 1
  [[ -d "$worktree" ]] || return 1

  misplaced_plan="$(
    find "$worktree" \
      -path "$expected_plan" -prune -o \
      -path "*/features/$slug/plan.md" -type f -print -quit 2>/dev/null || true
  )"
  if [[ -z "$misplaced_plan" && -f "$worktree/plan.md" ]]; then
    if git -C "$worktree" ls-files --error-unmatch plan.md >/dev/null 2>&1; then
      return 1
    fi
    misplaced_plan="$worktree/plan.md"
  fi
  [[ -n "$misplaced_plan" ]] || return 1
  [[ "$misplaced_plan" != "$expected_plan" ]] || return 1

  if [[ "$misplaced_plan" == "$worktree/plan.md" ]]; then
    rel_plan="plan.md"
  else
    rel_plan="${misplaced_plan#"$worktree"/}"
  fi
  recovered_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  mkdir -p "$feature_dir"
  audit_path="$feature_dir/.plan-recovered.json"
  audit_tmp="$(mktemp "$audit_path.tmp.XXXXXX" 2>/dev/null)" || {
    log_warn "$issue → Found misplaced plan.md at $rel_plan but could not create recovery audit"
    return 1
  }

  jq -n \
    --arg issue "$issue" \
    --arg expected "features/$slug/plan.md" \
    --arg found "$rel_plan" \
    --arg timestamp "$recovered_at" \
    '{
      issue: $issue,
      type: "misplaced-plan-md",
      expected: $expected,
      found: $found,
      recoveredAt: $timestamp
    }' > "$audit_tmp" || {
      rm -f "$audit_tmp"
      log_warn "$issue → Found misplaced plan.md at $rel_plan but could not write recovery audit"
      return 1
    }

  if ! mv "$audit_tmp" "$audit_path"; then
    rm -f "$audit_tmp"
    log_warn "$issue → Found misplaced plan.md at $rel_plan but could not finalize recovery audit"
    return 1
  fi

  if ! mv "$misplaced_plan" "$expected_plan"; then
    log_warn "$issue → Found misplaced plan.md at $rel_plan but could not move it into features/$slug"
    return 1
  fi

  log_warn "$issue → Recovered misplaced plan.md from $rel_plan"
  return 0
}

planning_premature_approval_announce_marker() {
  local feature_dir="$1"
  printf '%s\n' "$feature_dir/.plan-approved.premature-announced"
}

surface_premature_plan_approval() {
  local issue="$1" feature_dir="$2" win="$3" current_agent="${4:-}"
  local marker quarantined announce_marker detail next_action

  marker="$feature_dir/.plan-approved"
  quarantined="$feature_dir/.plan-approved.premature"
  [[ -f "$marker" ]] || return 1

  mv "$marker" "$quarantined" 2>/dev/null || rm -f "$marker"
  detail="Planning approval marker was created before plan.md existed and was saved at .plan-approved.premature"
  next_action="Create features/$(basename "$feature_dir")/plan.md, then approve again."
  write_stage_result "$feature_dir" "planning" "running" "$current_agent" "" "$detail"
  if declare -F wavemill_hook_write >/dev/null 2>&1; then
    wavemill_hook_write "blocked" "premature_plan_approval" "$detail" "${current_agent:-unknown}" "$next_action" || true
  fi
  set_window_attention_state "$win" "needs-user"

  announce_marker="$(planning_premature_approval_announce_marker "$feature_dir")"
  if [[ ! -f "$announce_marker" ]]; then
    : > "$announce_marker"
    log_warn "$issue → .plan-approved arrived before plan.md and was saved at .plan-approved.premature"
  fi
  return 0
}

# Returns path to the deduplicate announce marker for pane divergence detection.
_coding_divergence_announce_marker() {
  local feature_dir="$1"
  printf '%s\n' "$feature_dir/.coding-pane-divergence-detected"
}

# Detect whether the task pane has completed a different task's slug.
# Uses hook freshness and pane idle state as gating conditions so we do not
# mark tasks needs-user while the agent is still actively working.
# On success, sets globals _DIVERGENCE_SLUG and _DIVERGENCE_SOURCE.
# Returns 0 when divergence evidence is found; 1 otherwise.
_detect_coding_pane_divergence() {
  local issue="$1" slug="$2" worktree="$3" feature_dir="$4" win_target="$5"
  local hook_file="/tmp/wavemill-${SESSION}-${issue}.hook"
  local hook_state hook_ts now staleness pane_tail other_slug

  _DIVERGENCE_SLUG=""
  _DIVERGENCE_SOURCE=""

  # Fresh working/waiting hook means the agent is still active — keep waiting
  if [[ -f "$hook_file" ]]; then
    hook_state=$(jq -r '.state // empty' "$hook_file" 2>/dev/null || echo "")
    hook_ts=$(jq -r '.timestamp // 0' "$hook_file" 2>/dev/null || echo "0")
    now="$(date +%s)"
    staleness=$(( now - hook_ts ))
    if (( staleness < 300 )) && [[ "$hook_state" == "working" || "$hook_state" == "waiting" ]]; then
      return 1
    fi
  fi

  # Pane must be idle or dead for divergence detection to apply
  [[ -n "$win_target" ]] || return 1
  _pane_is_dead_or_idle "$win_target" 2>/dev/null || return 1

  # Check pane tail for a different slug's completion marker path
  pane_tail="$(tmux capture-pane -p -t "$win_target" -S -200 2>/dev/null || true)"
  if [[ -n "$pane_tail" ]]; then
    other_slug="$(printf '%s\n' "$pane_tail" \
      | grep -oE 'features/[^/[:space:]]+/\.coding-complete' \
      | sed 's|^features/||; s|/\.coding-complete$||' \
      | grep -v "^${slug}$" | head -1 || true)"
    if [[ -n "$other_slug" ]]; then
      _DIVERGENCE_SLUG="$other_slug"
      _DIVERGENCE_SOURCE="pane_tail"
      return 0
    fi
  fi

  return 1
}

# Emit a needs-user attention signal when the coding pane has completed a
# different task. This prevents the controller from polling forever when the
# pane identity has drifted from the controller-owned task/slug.
#
# Returns 0 (and increments active_count) when divergence is detected;
# returns 1 when no action is taken so the caller continues normal polling.
emit_pane_divergence_attention() {
  local issue="$1" slug="$2" feature_dir="$3" win="$4" win_target="$5"
  local worktree="${WORKTREE_ROOT:-}/${slug}"
  local artifact announce_marker detected_at tmp_artifact
  local observed_slug observed_source

  _DIVERGENCE_SLUG=""
  _DIVERGENCE_SOURCE=""

  if ! _detect_coding_pane_divergence "$issue" "$slug" "$worktree" "$feature_dir" "$win_target"; then
    return 1
  fi

  observed_slug="$_DIVERGENCE_SLUG"
  observed_source="$_DIVERGENCE_SOURCE"

  artifact="$feature_dir/.coding-pane-divergence.json"
  announce_marker="$(_coding_divergence_announce_marker "$feature_dir")"
  detected_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

  if [[ ! -f "$artifact" ]]; then
    tmp_artifact="$(mktemp "$artifact.tmp.XXXXXX" 2>/dev/null)" || true
    if [[ -n "$tmp_artifact" ]]; then
      jq -n \
        --arg expectedIssue "$issue" \
        --arg expectedSlug "$slug" \
        --arg expectedMarker "features/$slug/.coding-complete" \
        --arg observedSlug "$observed_slug" \
        --arg observedSource "$observed_source" \
        --arg detectedAt "$detected_at" \
        '{
          expectedIssue: $expectedIssue,
          expectedSlug: $expectedSlug,
          expectedMarker: $expectedMarker,
          observedSlug: $observedSlug,
          observedSource: $observedSource,
          detectedAt: $detectedAt
        }' > "$tmp_artifact" 2>/dev/null \
        && mv "$tmp_artifact" "$artifact" 2>/dev/null \
        || rm -f "$tmp_artifact"
    fi
  fi

  if [[ ! -f "$announce_marker" ]]; then
    log_warn "$issue → Coding pane completed a different task (expected: $slug, observed: $observed_slug via $observed_source). Expected .coding-complete is missing — task needs attention."
    : > "$announce_marker"
  fi

  set_window_attention_state "$win" "needs-user"
  active_count=$((active_count + 1))
  return 0
}

native_launch_failure_artifact_path() {
  local feature_dir="$1"
  printf '%s\n' "$feature_dir/.native-launch-failure.json"
}

stage_result_field() {
  local feature_dir="$1" stage="$2" field="$3"
  local result_file="$feature_dir/.${stage}-result.json"
  [[ -f "$result_file" ]] || return 0
  jq -r --arg field "$field" '.[$field] // empty' "$result_file" 2>/dev/null || true
}

agent_or_model_is_native_for_recovery() {
  local agent="${1:-}" model="${2:-}" tail="${3:-}"

  case "$agent" in
    native|native-*) return 0 ;;
  esac

  case "$model" in
    native:*|openrouter/*|qwen-*|kimi-*|glm-*) return 0 ;;
  esac

  if printf '%s\n' "$tail" | grep -Eiq '(native-openrouter|native-openai|launch-native-(planning|review|coding)|OpenRouter|wavemill native-agent)'; then
    return 0
  fi

  return 1
}

native_launch_failure_kind() {
  local tail="${1:-}"

  if printf '%s\n' "$tail" | grep -Eiq -- '--model[[:space:]]+[^[:space:]]'; then
    printf 'bare-model-command\n'
    return 0
  fi

  if printf '%s\n' "$tail" | grep -Eiq -- 'command not found.*--model'; then
    printf 'bare-model-command\n'
    return 0
  fi

  if printf '%s\n' "$tail" | grep -Eiq -- '--model.*command not found'; then
    printf 'bare-model-command\n'
    return 0
  fi

  if printf '%s\n' "$tail" | grep -Fq 'Agent exited (127)'; then
    printf 'agent-exited-127\n'
    return 0
  fi

  if printf '%s\n' "$tail" | grep -Fq 'exited with status 127'; then
    printf 'agent-exited-127\n'
    return 0
  fi

  if printf '%s\n' "$tail" | grep -Fq 'exited with code 127'; then
    printf 'agent-exited-127\n'
    return 0
  fi

  if printf '%s\n' "$tail" | grep -Fq 'exit status 127'; then
    printf 'agent-exited-127\n'
    return 0
  fi

  if printf '%s\n' "$tail" | grep -Fq 'native launch probe failed'; then
    printf 'native-route-rejected\n'
    return 0
  fi

  if printf '%s\n' "$tail" | grep -Eiq -- 'native agent .*cannot launch'; then
    printf 'native-route-rejected\n'
    return 0
  fi

  if printf '%s\n' "$tail" | grep -Eiq -- 'native agent .*does not support'; then
    printf 'native-route-rejected\n'
    return 0
  fi

  if printf '%s\n' "$tail" | grep -Eiq -- 'not eligible for planning'; then
    printf 'native-route-rejected\n'
    return 0
  fi

  if printf '%s\n' "$tail" | grep -Eiq -- 'not eligible for coding'; then
    printf 'native-route-rejected\n'
    return 0
  fi

  if printf '%s\n' "$tail" | grep -Eiq -- 'not eligible for review'; then
    printf 'native-route-rejected\n'
    return 0
  fi

  return 1
}

write_native_launch_failure_artifact() {
  local issue="$1" feature_dir="$2" stage="$3" agent="$4" model="$5" pane_target="$6" failure_kind="$7" exit_code="$8"
  local artifact tmp detected_at recommended_action

  artifact="$(native_launch_failure_artifact_path "$feature_dir")"
  detected_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  recommended_action="Inspect the pane transcript and route config, then relaunch after fixing native provider/model eligibility."
  mkdir -p "$feature_dir"
  tmp="$(mktemp "$artifact.tmp.XXXXXX" 2>/dev/null)" || return 0

  jq -n \
    --arg issue "$issue" \
    --arg stage "$stage" \
    --arg agent "$agent" \
    --arg model "$model" \
    --arg paneTarget "$pane_target" \
    --arg failureKind "$failure_kind" \
    --arg exitCode "$exit_code" \
    --arg detectedAt "$detected_at" \
    --arg recommendedAction "$recommended_action" \
    '{
      type: "native-launch-failure",
      issue: $issue,
      stage: $stage,
      agent: $agent,
      model: $model,
      paneTarget: $paneTarget,
      failureKind: $failureKind,
      exitCode: (if $exitCode == "" then null else ($exitCode | tonumber) end),
      detectedAt: $detectedAt,
      recommendedAction: $recommendedAction
    }' > "$tmp" 2>/dev/null \
    && mv "$tmp" "$artifact" 2>/dev/null \
    || rm -f "$tmp"
}

# Convert dead native launch panes into failed controller-owned stage results.
# This prevents malformed launchers from leaving stages in "running" forever.
emit_native_launch_failure_attention() {
  local issue="$1" feature_dir="$2" stage="$3" win="$4" win_target="$5" fallback_agent="${6:-}" fallback_model="${7:-}"
  local stage_status agent model pane_tail failure_kind exit_code notes artifacts_json

  stage_status="$(read_stage_status "$feature_dir" "$stage")"
  [[ "$stage_status" == "running" ]] || return 1
  [[ -n "$win_target" ]] || return 1
  _pane_is_dead_or_idle "$win_target" 2>/dev/null || return 1

  pane_tail="$(tmux capture-pane -p -t "$win_target" -S -200 2>/dev/null || true)"
  agent="$(stage_result_field "$feature_dir" "$stage" "agent")"
  model="$(stage_result_field "$feature_dir" "$stage" "model")"
  [[ -n "$agent" ]] || agent="$fallback_agent"
  [[ -n "$model" ]] || model="$fallback_model"

  agent_or_model_is_native_for_recovery "$agent" "$model" "$pane_tail" || return 1

  failure_kind="$(native_launch_failure_kind "$pane_tail" || true)"
  [[ -n "$failure_kind" ]] || failure_kind="native-agent-exited-without-artifacts"

  exit_code=""
  if printf '%s\n' "$pane_tail" | grep -Eq '(^|[^0-9])127([^0-9]|$)'; then
    exit_code="127"
  fi

  write_native_launch_failure_artifact "$issue" "$feature_dir" "$stage" "$agent" "$model" "$win_target" "$failure_kind" "$exit_code"

  notes="Native ${stage} launch failed: ${failure_kind}"
  [[ -n "$exit_code" ]] && notes+=" (exit $exit_code)"
  notes+=". Pane $win_target needs attention"

  artifacts_json="$(jq -cn \
    --arg paneTarget "$win_target" \
    --arg failureKind "$failure_kind" \
    --arg exitCode "$exit_code" \
    '{type:"nativeLaunchFailure", paneTarget:$paneTarget, failureKind:$failureKind, exitCode:(if $exitCode == "" then null else ($exitCode | tonumber) end)}' 2>/dev/null || printf '{}')"
  write_stage_result "$feature_dir" "$stage" "failed" "$agent" "$model" "$notes" "$artifacts_json"
  if [[ "${WAVEMILL_TERMINAL_RECONCILER_LOADED:-0}" == "1" ]]; then
    wavemill_reconcile_terminal "$SESSION" "$issue" "recovery_failure" || true
  fi
  set_window_attention_state "$win" "needs-user"
  log_warn "$issue → Native ${stage} launcher failed (${failure_kind}) in pane $win_target"
  active_count=$((active_count + 1))
  return 0
}

# ── Terminal native failure detection (hook-driven) ──────────────────
# The pane-scraping heuristics above only recognise *exec-level* failures:
# exit 127, bare `--model` invocations, probe failures. A provider that accepts
# the launch and then rejects the request — an unrecognised model ID, or a
# prompt larger than the model's context window — produces none of those
# signatures, and `_pane_is_dead_or_idle` may not hold either. Such arms stayed
# parked in `phase: coding` indefinitely, blocking the merge lane.
#
# The agent's own status hook already records these as a terminal
# {"state":"error","event":"process_exit"} write. Unlike the liveness reads in
# wavemill-status.sh, a terminal state is deliberately NOT TTL-gated: a dead
# process never refreshes its hook, so staleness corroborates the failure
# instead of invalidating it.

native_hook_terminal_failure_detail() {
  local issue="$1"
  local hook_file="/tmp/wavemill-${SESSION}-${issue}.hook"
  local state detail
  [[ -n "$issue" ]] || return 1
  [[ -f "$hook_file" ]] || return 1

  state="$(jq -r '.state // empty' "$hook_file" 2>/dev/null || true)"
  [[ "$state" == "error" ]] || return 1

  detail="$(jq -r '.detail // empty' "$hook_file" 2>/dev/null || true)"
  [[ -n "$detail" ]] || return 1
  printf '%s\n' "$detail"
}

# Read the typed reason from the coding stage's failure handoff, if present.
# Prints the reason on stdout; returns non-zero when the file is absent,
# malformed, fails schema validation, or the tool cannot run — callers treat
# every non-zero as "no typed evidence" and fall back to substring matching.
native_coding_failure_handoff_reason() {
  local feature_dir="${1:-}"
  local handoff_file="$feature_dir/.coding-failure-handoff.json"
  [[ -n "$feature_dir" && -f "$handoff_file" ]] || return 1
  [[ -n "${TOOLS_DIR:-}" ]] || return 1
  npx tsx "$TOOLS_DIR/read-coding-failure-handoff.ts" "$handoff_file" 2>/dev/null
}

# Classify a terminal native failure (HOK-2933). Precedence contract:
#   1. Typed handoff reason (optional 2nd arg, from .coding-failure-handoff.json):
#      no_completion_artifact / invalid_completion_artifact →
#      native-completion-protocol. The model violated the coding
#      completion/tool protocol — never a provider fault, so substring
#      matching is skipped entirely.
#   2. Substring matching on the failure detail. A typed provider_error also
#      runs this so it can refine into transient/credit/config sub-kinds.
#   3. Default: native-provider-error only when the handoff typed
#      provider_error; native-unclassified otherwise — never blame the
#      provider without evidence.
native_terminal_failure_kind() {
  local detail="${1:-}" handoff_reason="${2:-}"
  local lower

  case "$handoff_reason" in
    no_completion_artifact)
      printf 'native-completion-protocol\n'; return 0 ;;
    invalid_completion_artifact)
      printf 'native-completion-protocol\n'; return 0 ;;
  esac

  lower="$(printf '%s' "$detail" | tr '[:upper:]' '[:lower:]')"

  case "$lower" in
    *"context-exhausted"*|*"contextexhaustederror"*)
      printf 'context-exhausted\n'; return 0 ;;
    *"maximum context length"*|*"context length is"*|*"reduce the length"*|*"context_length_exceeded"*|*"context window"*|*"context-window"*)
      printf 'context-window-exceeded\n'; return 0 ;;
    *"no endpoints found"*"tool use"*|*"support tool use"*|*"supports tool use"*|*"tool use"*"not supported"*)
      printf 'tool-use-unsupported\n'; return 0 ;;
    *"401"*|*"unauthorized"*|*"unauthorised"*|*"invalid api key"*|*"authentication"*|*"forbidden"*)
      printf 'provider-config-error\n'; return 0 ;;
    *"is not a valid model id"*|*"invalid model"*|*"unknown model"*|*"model_not_found"*|*"invalid parameter"*|*"invalid param"*)
      printf 'provider-config-error\n'; return 0 ;;
    *"rate limit"*|*"429"*)
      printf 'provider-transient-error\n'; return 0 ;;
    *"can only afford"*|*"requires more credits"*|*"http 402"*|*"402 payment required"*|*"openrouter-credits-exhausted"*)
      printf 'provider-credit-exhausted\n'; return 0 ;;
    *"insufficient"*"credit"*|*"quota"*)
      printf 'provider-credit-exhausted\n'; return 0 ;;
    *"empty-model-turn"*|*"reasoning-only"*"turn"*|*"internal reasoning only"*)
      printf 'empty-model-turn\n'; return 0 ;;
    *"finish_reason: error"*|*"finish reason"*"error"*|*"idle timeout"*|*"stream ended without"*|*"without finish_reason"*|*"truncated stream"*|*"server error"*|*"bad gateway"*|*"service unavailable"*|*"gateway timeout"*|*"overloaded"*|*"upstream"*)
      printf 'provider-transient-error\n'; return 0 ;;
  esac
  if [[ "$handoff_reason" == "provider_error" ]]; then
    printf 'native-provider-error\n'
  else
    printf 'native-unclassified\n'
  fi
}

native_terminal_failure_next_action() {
  case "${1:-}" in
    context-exhausted)
      printf 'session compacted to the floor and still overflowed; re-launch on a larger-context model or split the task\n' ;;
    context-window-exceeded)
      printf 'relaunch with compressed context or a larger-context model; the prompt exceeded the model context window\n' ;;
    invalid-model-id|provider-config-error)
      printf 'check provider auth/model configuration, then rerun. The provider rejected the request\n' ;;
    provider-rate-limited)
      printf 'relaunch after the rate limit window\n' ;;
    provider-credit-exhausted|openrouter-credits-exhausted|provider-quota-exhausted)
      printf 'top up OpenRouter credits at https://openrouter.ai/credits\n' ;;
    provider-transient-error)
      printf 'transient upstream failure. Start the phase again\n' ;;
    empty-model-turn)
      printf 'relaunch native coding; the runtime exhausted bounded continuation after empty model turns\n' ;;
    tool-use-unsupported)
      printf 'inspect the native provider error, then relaunch the phase\n' ;;
    native-completion-protocol)
      printf "model ended the phase without a valid completion artifact (protocol violation, not a provider fault) - check the model's structured tool-call compatibility before relaunching\n" ;;
    native-unclassified)
      printf 'inspect the terminal failure detail and classify it manually - unrecognized failure signature, extend the classifier when this shape recurs\n' ;;
    *)
      printf 'inspect the native provider error, then relaunch the phase\n' ;;
  esac
}

# Turn a terminal hook error into a failed stage plus, for challenge arms, a
# quarantined pair. Returns 0 when it handled the issue (caller should stop).
emit_native_terminal_failure_attention() {
  local issue="$1" feature_dir="$2" stage="$3" win="$4" win_target="$5" fallback_agent="${6:-}" fallback_model="${7:-}"
  local stage_status detail handoff_reason failure_kind next_action agent model notes artifacts_json is_challenge

  stage_status="$(read_stage_status "$feature_dir" "$stage")"
  [[ "$stage_status" == "running" ]] || return 1

  # Never override a run that actually produced its completion artifact.
  [[ ! -f "$feature_dir/.${stage}-complete" ]] || return 1

  agent="$(stage_result_field "$feature_dir" "$stage" "agent")"
  model="$(stage_result_field "$feature_dir" "$stage" "model")"
  [[ -n "$agent" ]] || agent="$fallback_agent"
  [[ -n "$model" ]] || model="$fallback_model"
  agent_or_model_is_native_for_recovery "$agent" "$model" "" || return 1

  detail="$(native_hook_terminal_failure_detail "$issue")" || return 1
  # Only the coding stage produces a typed failure handoff; other stages use
  # the substring/default classification path unchanged.
  handoff_reason=""
  if [[ "$stage" == "coding" ]]; then
    handoff_reason="$(native_coding_failure_handoff_reason "$feature_dir" 2>/dev/null || true)"
  fi
  failure_kind="$(native_terminal_failure_kind "$detail" "$handoff_reason")"
  next_action="$(native_terminal_failure_next_action "$failure_kind")"
  if [[ "$failure_kind" == "provider-credit-exhausted" ]]; then
    write_openrouter_warning_cache "OpenRouter credits exhausted: $next_action"
  fi

  notes="Native ${stage} failed (${failure_kind}): ${detail} Next: ${next_action}"
  [[ -z "$handoff_reason" ]] || notes+=" (typed handoff: ${handoff_reason})"

  artifacts_json="$(jq -cn \
    --arg paneTarget "$win_target" \
    --arg failureKind "$failure_kind" \
    --arg detail "$detail" \
    --arg nextAction "$next_action" \
    --arg handoffReason "$handoff_reason" \
    '{type:"nativeTerminalFailure", paneTarget:$paneTarget, failureKind:$failureKind, detail:$detail, nextAction:$nextAction,
      handoffReason:(if $handoffReason == "" then null else $handoffReason end)}' \
    2>/dev/null || printf '{}')"

  # Quarantine first: challenge_abort_pair also writes a stage result, so the
  # richer artifact-bearing write below must land last and win.
  is_challenge="$(get_task_meta "$issue" "challenge" 2>/dev/null || true)"
  if [[ "$is_challenge" == "true" ]]; then
    challenge_abort_pair "$issue" "$feature_dir" "$win" "$stage" "$model" \
      "terminal_launch_failure:${failure_kind}" "$notes" "$next_action" \
      "$(challenge_abort_scope_for_failure "$issue" "$failure_kind")" || true
  fi

  write_stage_result "$feature_dir" "$stage" "failed" "$agent" "$model" "$notes" "$artifacts_json"

  if [[ "${WAVEMILL_TERMINAL_RECONCILER_LOADED:-0}" == "1" ]]; then
    wavemill_reconcile_terminal "$SESSION" "$issue" "recovery_failure" || true
  fi
  if [[ "$is_challenge" == "true" ]]; then
    if cleanup_quarantined_no_pr_challenge_arm "$issue" "$feature_dir" "$stage" "native terminal failure" 2>/dev/null; then
      log_warn "$issue → Native ${stage} failed (${failure_kind}). Pair quarantined. ${next_action}"
      return 0
    fi
  fi
  set_window_attention_state "$win" "needs-user"
  log_warn "$issue → Native ${stage} failed (${failure_kind}). ${next_action}"
  active_count=$((active_count + 1))
  return 0
}

# Quarantine a challenge arm whose stage the launcher already marked `failed`.
#
# emit_native_terminal_failure_attention() only fires while the stage is still
# `running` — the case where the agent died without recording anything. When the
# native launcher writes its own `failed` stage result (as it does for a provider
# 404), that handler never runs, and nothing else quarantines the pair. The
# comparison it was supposed to supply will never arrive, so the merge gate sits
# at `pair-unresolved:no-comparison` and holds the sibling's green PR forever.
#
# Idempotent: an already-quarantined arm is left alone so this does not rewrite
# state on every monitor cycle.
emit_challenge_stage_failure_quarantine() {
  local issue="$1" feature_dir="$2" stage="$3" win="$4"
  local is_challenge existing detail handoff_reason failure_kind next_action model

  is_challenge="$(get_task_meta "$issue" "challenge" 2>/dev/null || true)"
  [[ "$is_challenge" == "true" ]] || return 1

  existing="$(get_task_meta "$issue" "challengeAborted" 2>/dev/null || true)"
  [[ -z "$existing" ]] || return 1

  # Prefer the agent's own terminal hook detail; fall back to the stage notes.
  detail="$(native_hook_terminal_failure_detail "$issue" 2>/dev/null || true)"
  [[ -n "$detail" ]] || detail="$(stage_result_field "$feature_dir" "$stage" "notes")"
  [[ -n "$detail" ]] || detail="${stage} stage reported failed without detail"

  # Typed handoff evidence (coding stage only) takes precedence over the
  # substring heuristics; other stages never produce one.
  handoff_reason=""
  if [[ "$stage" == "coding" ]]; then
    handoff_reason="$(native_coding_failure_handoff_reason "$feature_dir" 2>/dev/null || true)"
  fi
  failure_kind="$(native_terminal_failure_kind "$detail" "$handoff_reason")"
  next_action="$(native_terminal_failure_next_action "$failure_kind")"
  model="$(stage_result_field "$feature_dir" "$stage" "model")"
  # Preserve the typed reason in the abort record. Appended only after
  # classification so the token never perturbs substring matching.
  [[ -z "$handoff_reason" ]] || detail+=" [typed handoff reason: ${handoff_reason}]"

  challenge_abort_pair "$issue" "$feature_dir" "$win" "$stage" "$model" \
    "terminal_stage_failure:${failure_kind}" "$detail" "$next_action" \
    "$(challenge_abort_scope_for_failure "$issue" "$failure_kind")" || return 1

  log_warn "$issue → challenge arm failed at ${stage} (${failure_kind}). Pair quarantined. ${next_action}"
  cleanup_quarantined_no_pr_challenge_arm "$issue" "$feature_dir" "$stage" "terminal stage failure:${failure_kind}" || true
  return 0
}

# ── Challenger transient-failure phase relaunch (HOK-2885) ────────────────────
#
# `provider-transient-error` on a native challenger arm is a mid-stream upstream
# stall (OpenRouter tearing down its own idle connection), observed on ~59% of
# challenger launches. The in-process retry inside the native loop (3 attempts,
# ~21s span) cannot ride out a stall measured in minutes, so the mill relaunches
# the whole phase instead: fresh session, minutes-scale spacing, bounded budget.
#
# The counter lives in the feature dir (not workflow state) so the retry
# budget dies with the worktree instead of leaking across relaunches of the
# same issue.

challenger_transient_retry_file() {
  printf '%s\n' "$1/.challenger-transient-retries.json"
}

challenger_transient_retry_max() {
  local max="${WAVEMILL_CHALLENGER_TRANSIENT_RETRY_MAX:-3}"
  [[ "$max" =~ ^[0-9]+$ ]] || max=3
  printf '%s\n' "$max"
}

clear_challenger_transient_retry_state() {
  rm -f "$1/.challenger-transient-retries.json" 2>/dev/null || true
}

challenger_transient_retry_diagnostic_file() {
  printf '%s\n' "$1/.challenger-transient-retry-diagnostic.json"
}

challenger_transient_retry_result_head() {
  local feature_dir="$1" stage="$2"
  jq -r '(.headSha // .head // .artifacts.headSha // .artifacts.launchHead // empty)' \
    "$feature_dir/.${stage}-result.json" 2>/dev/null || true
}

challenger_transient_retry_intent_json() {
  local issue="$1" feature_dir="$2"
  local intent_json path

  if [[ -n "${STATE_FILE:-}" && -f "$STATE_FILE" ]]; then
    intent_json="$(jq -c --arg i "$issue" '(.tasks[$i].challengeExecutionIntent // .tasks[$i].challengeIntent // empty)' "$STATE_FILE" 2>/dev/null || true)"
    [[ "$intent_json" != "null" && -n "$intent_json" ]] && {
      printf '%s\n' "$intent_json"
      return 0
    }
  fi

  for path in "$feature_dir/challenge-intent.json" "$feature_dir/.challenge-intent.json"; do
    [[ -f "$path" ]] || continue
    jq -c '.' "$path" 2>/dev/null || {
      printf '%s\n' '{"__wavemillInvalidIntent":true}'
      return 0
    }
    return 0
  done

  return 1
}

resolve_challenger_transient_retry_launch_intent() {
  local issue="$1" feature_dir="$2" stage="$3" current_head="${4:-}"
  local pair_id intent_json launch_stage result_head intent_source

  pair_id="$(get_task_meta "$issue" "challengePairId" 2>/dev/null || true)"
  launch_stage="$(challenge_stage_for_launch_env "$stage")"
  result_head="$(challenger_transient_retry_result_head "$feature_dir" "$stage")"
  if [[ -n "$result_head" && -n "$current_head" && "$result_head" != "$current_head" ]]; then
    jq -cn --arg reason "stale_head" --arg stage "$launch_stage" \
      --arg resultHead "$result_head" --arg currentHead "$current_head" \
      '{ok:false,reason:$reason,stage:$stage,resultHead:$resultHead,currentHead:$currentHead}'
    return 0
  fi

  if ! intent_json="$(challenger_transient_retry_intent_json "$issue" "$feature_dir")"; then
    jq -cn --arg reason "missing_challenge_intent" --arg stage "$launch_stage" \
      '{ok:false,reason:$reason,stage:$stage}'
    return 0
  fi

  if printf '%s' "$intent_json" | jq -e '.__wavemillInvalidIntent == true' >/dev/null 2>&1; then
    jq -cn --arg reason "invalid_challenge_intent_json" --arg stage "$launch_stage" \
      '{ok:false,reason:$reason,stage:$stage}'
    return 0
  fi

  intent_source="state"
  jq -c \
    --arg issue "$issue" \
    --arg pair "$pair_id" \
    --arg stage "$launch_stage" \
    --arg source "$intent_source" \
    --arg resultHead "$result_head" \
    --arg currentHead "$current_head" \
    '
      if (type != "object") then
        {ok:false, reason:"invalid_challenge_intent_schema"}
      elif (($pair == "") or ((.pairId // "") != $pair)) then
        {ok:false, reason:"pair_mismatch"}
      elif ((.selectedStage // .challengeStage // "") != $stage) then
        {ok:false, reason:"stage_mismatch"}
      elif ((.challenger // null) == null or (.challenger | type) != "object") then
        {ok:false, reason:"missing_challenger_intent"}
      else
        (.challenger) as $side
        | ($side.role // $side.side // "") as $role
        | ($side.key // "") as $key
        | ($side.expectedStageAgent // (if $stage == "plan" then $side.planner.agent elif $stage == "implementation" then $side.coder.agent else $side.reviewer.agent end) // "") as $agent
        | ($side.expectedStageModel // (if $stage == "plan" then $side.planner.model elif $stage == "implementation" then $side.coder.model else $side.reviewer.model end) // "") as $model
        | if ($role != "challenger") then
            {ok:false, reason:"challenger_side_mismatch"}
          elif ($key != "" and $key != $issue) then
            {ok:false, reason:"challenger_key_mismatch"}
          elif ((($agent | type) != "string") or ($agent == "")) then
            {ok:false, reason:"missing_launch_agent"}
          elif ((($model | type) != "string") or ($model == "")) then
            {ok:false, reason:"missing_launch_model"}
          elif ($agent == "native") then
            {ok:false, reason:"ambiguous_launch_agent"}
          else
            {ok:true, agent:$agent, model:$model, stage:$stage, source:$source}
          end
      end
      | . + {resultHead:$resultHead, currentHead:$currentHead}
    ' <<< "$intent_json" 2>/dev/null || jq -cn --arg reason "invalid_challenge_intent_schema" '{ok:false,reason:$reason}'
}

record_challenger_transient_retry_contract_failure() {
  local issue="$1" feature_dir="$2" win="$3" stage="$4" reason="$5" detail="$6"
  local result_agent="${7:-}" launch_agent="${8:-}" model="${9:-}"
  local terminal_reason next_action diag_file tmp now terminal_class

  case "$reason" in
    stale_head)
      terminal_class="retry_intent_mismatch"
      ;;
    stage_mismatch)
      terminal_class="retry_intent_mismatch"
      ;;
    pair_mismatch)
      terminal_class="retry_intent_mismatch"
      ;;
    challenger_key_mismatch)
      terminal_class="retry_intent_mismatch"
      ;;
    challenger_side_mismatch)
      terminal_class="retry_intent_mismatch"
      ;;
    *)
      terminal_class="retry_contract_invalid"
      ;;
  esac
  terminal_reason="${terminal_class}:${reason}"
  next_action="Fix the persisted challenge execution intent before retrying this challenger."
  now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  mkdir -p "$feature_dir" 2>/dev/null || true
  diag_file="$(challenger_transient_retry_diagnostic_file "$feature_dir")"
  tmp="$diag_file.tmp.$$"
  jq -n -S \
    --arg issue "$issue" \
    --arg stage "$(challenge_stage_for_launch_env "$stage")" \
    --arg reason "$terminal_reason" \
    --arg detail "$detail" \
    --arg resultAgent "$result_agent" \
    --arg launchAgent "$launch_agent" \
    --arg model "$model" \
    --arg recordedAt "$now" \
    '{issue:$issue, stage:$stage, reason:$reason, detail:$detail, recordedAt:$recordedAt}
     + (if $resultAgent == "" then {} else {resultAgent:$resultAgent} end)
     + (if $launchAgent == "" then {} else {launchAdapter:$launchAgent} end)
     + (if $model == "" then {} else {model:$model} end)' \
    > "$tmp" 2>/dev/null && mv "$tmp" "$diag_file" || rm -f "$tmp"

  challenge_abort_pair "$issue" "$feature_dir" "$win" "$stage" "$model" \
    "$terminal_reason" "$detail" "$next_action" "single" || true
  cleanup_quarantined_no_pr_challenge_arm "$issue" "$feature_dir" "$stage" "$terminal_reason" || true
  log_warn "$issue → challenger transient retry blocked at ${stage} (${terminal_reason}), no relaunch attempted."
}

# Relaunch a challenger arm's failed phase after a transient provider error.
#
# Called from the three stage-failed branches of monitor_issue_state, before
# the quarantine fall-through. Returns:
#   0 — phase relaunched; caller keeps the arm active, no quarantine
#   2 — waiting out backoff; caller keeps the arm active, no quarantine
#   1 — not applicable (not a transient challenger failure), or the retry
#       budget is exhausted / the relaunch is not possible. On exhaustion this
#       function has already applied the single-side quarantine
#       (retry_exhausted:provider-transient-error); the caller's
#       emit_challenge_stage_failure_quarantine call is then an idempotent no-op.
maybe_retry_challenger_transient_phase() {
  local issue="$1" feature_dir="$2" stage="$3" win="$4"
  local is_challenge role existing detail handoff_reason failure_kind retry_file retry_state
  local stored_stage stored_head count last_at now max backoff agent model result_agent
  local slug wt_dir branch title issue_json contract_payload depth review_mode rc=0
  local current_head launch_identity launch_ok launch_reason launch_detail lock_dir lock_acquired=0

  # 1. Applicability: challenger arm of a live challenge, transient failure kind.
  is_challenge="$(get_task_meta "$issue" "challenge" 2>/dev/null || true)"
  [[ "$is_challenge" == "true" ]] || return 1
  role="$(_challenge_side_for_issue "$issue" 2>/dev/null || true)"
  [[ "$role" == "challenger" ]] || return 1
  existing="$(get_task_meta "$issue" "challengeAborted" 2>/dev/null || true)"
  [[ -z "$existing" ]] || return 1

  # Failure detail resolution mirrors emit_challenge_stage_failure_quarantine:
  # prefer the agent's terminal hook detail, fall back to the stage notes.
  detail="$(native_hook_terminal_failure_detail "$issue" 2>/dev/null || true)"
  [[ -n "$detail" ]] || detail="$(stage_result_field "$feature_dir" "$stage" "notes")"
  [[ -n "$detail" ]] || return 1
  # A typed completion-protocol handoff must never be relaunched as a
  # transient provider stall, even when the detail contains a transient-looking
  # word — the typed evidence wins over the substring heuristics.
  handoff_reason=""
  if [[ "$stage" == "coding" ]]; then
    handoff_reason="$(native_coding_failure_handoff_reason "$feature_dir" 2>/dev/null || true)"
  fi
  failure_kind="$(native_terminal_failure_kind "$detail" "$handoff_reason")"
  [[ "$failure_kind" == "provider-transient-error" ]] || return 1

  slug="$(read_state_value "" --arg i "$issue" '.tasks[$i].slug // empty')"
  [[ -n "$slug" ]] || return 1
  wt_dir="$(read_state_value "" --arg i "$issue" '.tasks[$i].worktree // empty')"
  [[ -n "$wt_dir" ]] || wt_dir="${WORKTREE_ROOT}/${slug}"
  [[ -d "$wt_dir" ]] || return 1
  current_head="$(git -C "$wt_dir" rev-parse HEAD 2>/dev/null || true)"

  # Result provenance and launch adapter identity are different contracts. The
  # failed stage may record agent=native for audit history; relaunch must recover
  # the provider-aware adapter, such as native-openrouter, from immutable intent.
  result_agent="$(stage_result_field "$feature_dir" "$stage" "agent")"
  launch_identity="$(resolve_challenger_transient_retry_launch_intent "$issue" "$feature_dir" "$stage" "$current_head")"
  launch_ok="$(printf '%s' "$launch_identity" | jq -r 'if .ok == true then "true" else "false" end' 2>/dev/null || echo false)"
  agent="$(printf '%s' "$launch_identity" | jq -r '.agent // ""' 2>/dev/null || echo "")"
  model="$(printf '%s' "$launch_identity" | jq -r '.model // ""' 2>/dev/null || echo "")"
  if [[ "$launch_ok" != "true" ]]; then
    launch_reason="$(printf '%s' "$launch_identity" | jq -r '.reason // "invalid_challenge_intent_schema"' 2>/dev/null || echo "invalid_challenge_intent_schema")"
    launch_detail="Challenger ${stage} transient retry could not reconstruct launch identity from challenge execution intent: ${launch_reason}"
    record_challenger_transient_retry_contract_failure "$issue" "$feature_dir" "$win" "$stage" "$launch_reason" "$launch_detail" "$result_agent" "$agent" "${model:-$(stage_result_field "$feature_dir" "$stage" "model")}"
    return 1
  fi
  if ! agent_validate_phase_launch "$agent" "$stage" "$model" "$REPO_DIR"; then
    launch_reason="unsupported_launch_identity"
    launch_detail="Challenger ${stage} transient retry intent is not launchable (adapter=${agent:-?} model=${model:-?})"
    record_challenger_transient_retry_contract_failure "$issue" "$feature_dir" "$win" "$stage" "$launch_reason" "$launch_detail" "$result_agent" "$agent" "$model"
    return 1
  fi

  # 2. Read the counter; a different stored stage means a new phase gets a
  # fresh budget. A recorded head keeps the budget scoped to the worktree head
  # that produced the transient failure while old headless files stay readable.
  retry_file="$(challenger_transient_retry_file "$feature_dir")"
  count=0
  last_at=0
  if [[ -f "$retry_file" ]]; then
    retry_state="$(cat "$retry_file" 2>/dev/null || printf '{}')"
    stored_stage="$(printf '%s' "$retry_state" | jq -r '.stage // empty' 2>/dev/null || true)"
    stored_head="$(printf '%s' "$retry_state" | jq -r '.head // empty' 2>/dev/null || true)"
    if [[ "$stored_stage" == "$stage" && ( -z "$stored_head" || -z "$current_head" || "$stored_head" == "$current_head" ) ]]; then
      count="$(printf '%s' "$retry_state" | jq -r '.count // 0' 2>/dev/null || echo 0)"
      last_at="$(printf '%s' "$retry_state" | jq -r '.lastAt // 0' 2>/dev/null || echo 0)"
    fi
  fi
  [[ "$count" =~ ^[0-9]+$ ]] || count=0
  [[ "$last_at" =~ ^[0-9]+$ ]] || last_at=0
  now="$(date +%s)"
  max="$(challenger_transient_retry_max)"

  # 3. Budget exhausted: terminalize with a single-side quarantine so the
  # healthy primary keeps its eval and the pair resolves by forfeit.
  if (( count >= max )); then
    model="$(stage_result_field "$feature_dir" "$stage" "model")"
    local exhausted_notes exhausted_next
    exhausted_next="$(native_terminal_failure_next_action "provider-transient-error")"
    exhausted_notes="Challenger ${stage} phase failed on a transient provider error after ${count}/${max} relaunches (attempts=${count}): ${detail}"
    challenge_abort_pair "$issue" "$feature_dir" "$win" "$stage" "$model" \
      "retry_exhausted:provider-transient-error" "$exhausted_notes" "$exhausted_next" "single" || true
    log_warn "$issue → challenger transient retries exhausted at ${stage} (${count}/${max}). Challenger quarantined, primary unaffected."
    cleanup_quarantined_no_pr_challenge_arm "$issue" "$feature_dir" "$stage" "retry_exhausted:provider-transient-error" || true
    return 1
  fi

  # 4. First observation of this failure: start the backoff clock instead of
  # relaunching immediately — the upstream stall needs time to clear.
  if (( last_at == 0 )); then
    if jq -n --arg stage "$stage" --arg head "$current_head" --argjson count "$count" --argjson lastAt "$now" \
      '{stage:$stage,head:$head,count:$count,lastAt:$lastAt}' > "$retry_file.tmp.$$" 2>/dev/null; then
      mv "$retry_file.tmp.$$" "$retry_file" 2>/dev/null || rm -f "$retry_file.tmp.$$"
    else
      rm -f "$retry_file.tmp.$$"
    fi
    log "status" "$issue → transient challenger failure at ${stage}, retrying in $(get_backoff_delay $((count + 1)))s (attempt $((count + 1))/${max})"
    return 2
  fi
  backoff="$(get_backoff_delay $((count + 1)))"
  if (( now - last_at < backoff )); then
    return 2
  fi

  lock_dir="${retry_file}.lock"
  if ! mkdir "$lock_dir" 2>/dev/null; then
    return 2
  fi
  lock_acquired=1

  branch="$(read_state_value "" --arg i "$issue" '.tasks[$i].branch // empty')"
  [[ -n "$branch" ]] || branch="task/${slug}"
  title="$(read_state_value "" --arg i "$issue" '.tasks[$i].title // ""')"
  if [[ -z "$title" ]]; then
    issue_json="$(cat "/tmp/${SESSION}-${issue}-issue.json" 2>/dev/null || echo "{}")"
    title="$(printf '%s' "$issue_json" | jq -r '.title // "Task"' 2>/dev/null || echo "Task")"
  fi

  # 6. Increment the counter first (crash-safe), then re-arm and relaunch.
  count=$((count + 1))
  if jq -n --arg stage "$stage" --arg head "$current_head" --argjson count "$count" --argjson lastAt "$now" \
    '{stage:$stage,head:$head,count:$count,lastAt:$lastAt}' > "$retry_file.tmp.$$" 2>/dev/null; then
    mv "$retry_file.tmp.$$" "$retry_file" 2>/dev/null || rm -f "$retry_file.tmp.$$"
  else
    rm -f "$retry_file.tmp.$$"
  fi

  contract_payload="$(jq -cn --arg stageRole "$stage" --arg agent "$agent" --arg model "$model" --arg resultAgent "$result_agent" \
    '{stageRole:$stageRole,agent:$agent,model:$model,resultAgent:$resultAgent}' 2>/dev/null || printf '{}')"

  # Clear the stale terminal-error hook before relaunching. Launch paths never
  # reset it, and _prepare_recovery_phase_launch's hook write is a no-op in the
  # monitor (no WAVEMILL_ISSUE in env) — leaving the old {"state":"error"} in
  # place would let emit_native_terminal_failure_attention re-quarantine the
  # relaunched arm on the next tick, before the new process writes its first hook.
  rm -f "/tmp/wavemill-${SESSION}-${issue}.hook" 2>/dev/null || true

  case "$stage" in
    planning)
      depth="$(read_phase_config "$feature_dir" "planning" "depth")"
      [[ -n "$depth" ]] || depth="$(get_task_meta "$issue" "planDepth")"
      [[ -n "$depth" ]] || depth="light"
      _prepare_recovery_phase_launch "$issue" "$slug" "planning" "$feature_dir" "$wt_dir" "$agent" "$model" "$contract_payload" || {
        rm -rf "$lock_dir" 2>/dev/null || true
        return 1
      }
      launch_planning_phase "$issue" "$slug" "$title" "$wt_dir" "$branch" "$BASE_BRANCH" \
        "$model" "$agent" "$depth" || rc=$?
      ;;
    coding)
      depth="$(read_phase_config "$feature_dir" "coding" "depth")"
      [[ -n "$depth" ]] || depth="$(get_task_meta "$issue" "codeDepth")"
      [[ -n "$depth" ]] || depth="medium"
      _prepare_recovery_phase_launch "$issue" "$slug" "coding" "$feature_dir" "$wt_dir" "$agent" "$model" "$contract_payload" || {
        rm -rf "$lock_dir" 2>/dev/null || true
        return 1
      }
      launch_coding_phase "$issue" "$slug" "$title" "$wt_dir" "$branch" "$BASE_BRANCH" \
        "$model" "$agent" "$depth" || rc=$?
      ;;
    review)
      review_mode="$(read_phase_config "$feature_dir" "review" "mode")"
      [[ -n "$review_mode" ]] || review_mode="$(get_task_meta "$issue" "reviewMode")"
      [[ -n "$review_mode" ]] || review_mode="static"
      _prepare_recovery_phase_launch "$issue" "$slug" "review" "$feature_dir" "$wt_dir" "$agent" "$model" "$contract_payload" "review" || {
        rm -rf "$lock_dir" 2>/dev/null || true
        return 1
      }
      launch_review_phase "$issue" "$slug" "$title" "$wt_dir" "$branch" "$BASE_BRANCH" \
        "$model" "$agent" "$review_mode" || rc=$?
      ;;
    *)
      rm -rf "$lock_dir" 2>/dev/null || true
      return 1
      ;;
  esac

  if [[ "$rc" -ne 0 ]]; then
    log_warn "$issue → challenger transient relaunch of ${stage} failed (rc=$rc); falling through to quarantine"
    rm -rf "$lock_dir" 2>/dev/null || true
    return 1
  fi

  set_window_attention_state "$win" "clear"
  log "status" "♻ $issue → challenger_transient_retry attempt=${count}/${max}: relaunched ${stage} after transient provider error (result_agent=${result_agent:-?} launch_adapter=${agent})"
  if [[ "$lock_acquired" -eq 1 ]]; then
    rm -rf "$lock_dir" 2>/dev/null || true
  fi
  return 0
}

coding_missing_blocked_completion_announce_marker() {
  local feature_dir="$1"
  printf '%s\n' "$feature_dir/.missing-blocked-completion-announced"
}

_coding_terminal_blocked_completion_detected() {
  local feature_dir="$1" win_target="$2"
  local coding_status pane_tail line lower_line
  local commit_phrase="" blocked_phrase=""

  _CODING_TERMINAL_BLOCKED_COMMIT_PHRASE=""
  _CODING_TERMINAL_BLOCKED_BLOCKED_PHRASE=""

  coding_status="$(read_stage_status "$feature_dir" "coding")"
  [[ "$coding_status" == "running" ]] || return 1
  [[ ! -f "$feature_dir/.coding-complete" ]] || return 1
  [[ ! -f "$feature_dir/.coding-blocked-completion.json" ]] || return 1
  [[ -n "$win_target" ]] || return 1
  _pane_is_dead_or_idle "$win_target" 2>/dev/null || return 1

  pane_tail="$(tmux capture-pane -p -t "$win_target" -S -500 2>/dev/null || true)"
  [[ -n "$pane_tail" ]] || return 1

  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    lower_line="$(printf '%s' "$line" | tr '[:upper:]' '[:lower:]')"

    if [[ -z "$commit_phrase" ]] && [[ \
      "$lower_line" == *"committed as"* || \
      "$lower_line" == *"implementation is committed"* || \
      "$lower_line" == *"implementation committed"* || \
      "$lower_line" == *"changes committed"* \
    ]]; then
      commit_phrase="$line"
    fi

    if [[ -z "$blocked_phrase" ]] && [[ \
      "$lower_line" == *"did not create .coding-complete"* || \
      "$lower_line" == *"verification is blocked"* || \
      "$lower_line" == *"verification blocked"* || \
      "$lower_line" == *"environmentally blocked"* || \
      "$lower_line" == *"environmental blocker"* \
    ]]; then
      blocked_phrase="$line"
    fi
  done <<< "$pane_tail"

  [[ -n "$commit_phrase" ]] || return 1
  [[ -n "$blocked_phrase" ]] || return 1

  _CODING_TERMINAL_BLOCKED_COMMIT_PHRASE="$commit_phrase"
  _CODING_TERMINAL_BLOCKED_BLOCKED_PHRASE="$blocked_phrase"
  return 0
}

emit_terminal_blocked_completion_attention() {
  local issue="$1" slug="$2" feature_dir="$3" win="$4" win_target="$5"
  local artifact_rel_path audit_path announce_marker detected_at tmp_artifact
  local action observed_phrases_json

  if ! _coding_terminal_blocked_completion_detected "$feature_dir" "$win_target"; then
    return 1
  fi

  artifact_rel_path="features/$slug/.coding-blocked-completion.json"
  audit_path="$feature_dir/.coding-missing-blocked-completion.json"
  announce_marker="$(coding_missing_blocked_completion_announce_marker "$feature_dir")"
  detected_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  action="Create $artifact_rel_path or run advance $issue."
  observed_phrases_json="$(
    printf '%s\n%s\n' \
      "$_CODING_TERMINAL_BLOCKED_COMMIT_PHRASE" \
      "$_CODING_TERMINAL_BLOCKED_BLOCKED_PHRASE" \
      | jq -R . \
      | jq -s .
  )"

  if [[ ! -f "$audit_path" ]]; then
    tmp_artifact="$(mktemp "$audit_path.tmp.XXXXXX" 2>/dev/null)" || true
    if [[ -n "$tmp_artifact" ]]; then
      jq -n \
        --arg issue "$issue" \
        --arg slug "$slug" \
        --arg detectedAt "$detected_at" \
        --arg missingArtifact "$artifact_rel_path" \
        --arg action "$action" \
        --argjson observedPhrases "$observed_phrases_json" \
        '{
          issue: $issue,
          slug: $slug,
          detectedAt: $detectedAt,
          observedPhrases: $observedPhrases,
          missingArtifact: $missingArtifact,
          action: $action
        }' > "$tmp_artifact" 2>/dev/null \
        && mv "$tmp_artifact" "$audit_path" 2>/dev/null \
        || rm -f "$tmp_artifact"
    fi
  fi

  if [[ ! -f "$announce_marker" ]]; then
    log "status" "$issue needs attention: coding appears complete but .coding-blocked-completion.json is missing. Create $artifact_rel_path or run \"advance $issue\" to continue."
    : > "$announce_marker"
  fi

  set_window_attention_state "$win" "needs-user"
  active_count=$((active_count + 1))
  return 0
}

# Reject a plan: transition planning from awaiting_user to failed.
# Usage: reject_plan <feature_dir> [agent] [model]
reject_plan() {
  local feature_dir="$1"
  local agent="${2:-}" model="${3:-}"
  write_stage_result "$feature_dir" "planning" "failed" "$agent" "$model" "Plan rejected by user"
}

# Check if the workflow is aborted (new-style result or legacy marker).
# Usage: check_stage_aborted <feature_dir>
# Checks any stage result for aborted status, then falls back to .workflow-aborted marker.
check_stage_aborted() {
  local feature_dir="$1"

  # 1. Check new-style: any stage result with status=aborted
  local stage result_file
  for stage in planning coding review ready; do
    result_file="$feature_dir/.${stage}-result.json"
    if [[ -f "$result_file" ]]; then
      local status
      status=$(jq -r '.status // empty' "$result_file" 2>/dev/null || echo "")
      [[ "$status" == "aborted" ]] && return 0
    fi
  done

  # 2. Fallback to legacy marker
  [[ -f "$feature_dir/.workflow-aborted" ]] && return 0

  return 1
}

# Resolve the worktree HEAD for a feature dir (…/<wt>/features/<slug>).
# Empty output means git failed; bounded-retry helpers treat that as
# "no new information" and never reset on it.
phase_launch_head() {
  local feature_dir="$1"
  local wt_dir="${feature_dir%/features/*}"
  [[ -n "$wt_dir" && "$wt_dir" != "$feature_dir" ]] || { echo ""; return 0; }
  git -C "$wt_dir" rev-parse HEAD 2>/dev/null || echo ""
}

# Pre-launch admission for phase relaunches (HOK-2924). The revert-for-retry
# in handle_phase_launch_result restores exactly the state that re-derives the
# same launch on the next poll tick, so without this gate a failing launch
# retries forever at poll cadence (HOK-2921; HOK-2893_c retried 234 times).
#
# Usage: phase_launch_gate <issue> <feature_dir> <phase> <win>
# Returns 0 when the launch may proceed. Returns 1 when the caller must hold
# the task this cycle: a backoff window is open, or the retry budget is
# exhausted (the task is terminalized here with a recorded reason).
phase_launch_gate() {
  local issue="$1" feature_dir="$2" phase="$3" win="$4"
  local bucket="phase-launch-$phase"
  local limit head disposition attempts reason

  limit="${WAVEMILL_PHASE_LAUNCH_MAX_ATTEMPTS:-4}"
  [[ "$limit" =~ ^[0-9]+$ ]] || limit=4
  head="$(phase_launch_head "$feature_dir")"
  disposition=$(bounded_retry_gate "$feature_dir" "$bucket" "$head" "$limit")

  case "$disposition" in
    proceed)
      return 0
      ;;
    backoff)
      log "debug" "  $issue: holding ${phase} launch retry (backoff)"
      return 1
      ;;
    exhausted)
      attempts=$(bounded_retry_count "$feature_dir" "$bucket")
      reason="${phase^} launch retries exhausted after ${attempts} attempt(s) at head ${head:-unknown}"
      write_stage_result "$feature_dir" "$phase" "failed" "" "" "$reason"
      if bounded_retry_mark_exhausted "$feature_dir" "$bucket" "$reason"; then
        log "status" "⛔ $issue → ${phase^} launch retries exhausted after ${attempts} attempt(s) - aborting task"
      fi
      set_task_phase "$issue" "aborted"
      if [[ "${WAVEMILL_TERMINAL_RECONCILER_LOADED:-0}" == "1" ]]; then
        wavemill_reconcile_terminal "$SESSION" "$issue" "phase_launch_exhausted" || true
      fi
      set_window_attention_state "$win" "needs-user"
      return 1
      ;;
    *)
      # exhausted-quiet: already terminalized; hold silently until a new
      # commit clears the bucket.
      set_window_attention_state "$win" "needs-user"
      return 1
      ;;
  esac
}

# Normalize launch outcomes after the controller has already advanced phase state.
# On launch failure, revert the controller phase so the next monitor cycle retries
# the same transition instead of waiting for artifacts that will never arrive.
# Each failure counts against the phase-launch-<phase> bounded-retry bucket
# (HOK-2924); phase_launch_gate enforces the backoff and ceiling before the
# next launch fires, and a successful launch clears the bucket.
#
# Usage:
#   handle_phase_launch_result <issue> <feature_dir> <launched_phase> <retry_phase> \
#     <launch_rc> <win> [agent] [model]
# Returns:
#   0 if launch succeeded and callers should continue success handling
#   1 if the outcome was handled here (abort or failure) and callers should stop
handle_phase_launch_result() {
  local issue="$1" feature_dir="$2" launched_phase="$3" retry_phase="$4"
  local launch_rc="$5" win="$6" agent="${7:-}" model="${8:-}"
  local launch_attempts

  if [[ "$launch_rc" -eq 2 ]] && check_stage_aborted "$feature_dir"; then
    log_task "status" "$issue" "⛔ $issue → Workflow aborted during ${launched_phase} launch"
    write_stage_result "$feature_dir" "$launched_phase" "aborted" "$agent" "$model"
    set_task_phase "$issue" "aborted"
    if [[ "${WAVEMILL_TERMINAL_RECONCILER_LOADED:-0}" == "1" ]]; then
      wavemill_reconcile_terminal "$SESSION" "$issue" "operator_abort" || true
    fi
    set_window_attention_state "$win" "needs-user"
    return 1
  fi

  if [[ "$launch_rc" -ne 0 ]]; then
    log_native_launch_preflight_detail "$issue" "$launched_phase" "$agent" "$model" || true
    if challenge_abort_for_native_preflight_varied_model "$issue" "$feature_dir" "$win" "$launched_phase" "$agent" "$model"; then
      # Terminal cause: the varied model can never pass native preflight
      # (HOK-2920), so record the terminal reason without consuming the
      # retry budget.
      bounded_retry_mark_exhausted "$feature_dir" "phase-launch-$launched_phase" \
        "${launched_phase^} launch aborted: varied model cannot pass native preflight${model:+ ($model)}" || true
      return 1
    fi
    launch_attempts=$(bounded_retry_increment "$feature_dir" "phase-launch-$launched_phase" "$(phase_launch_head "$feature_dir")")
    clear_stage_result "$feature_dir" "$launched_phase"
    set_task_phase "$issue" "$retry_phase"
    set_window_attention_state "$win" "needs-user"
    log "warn" "⚠ $issue → ${launched_phase^} phase launch failed (rc=$launch_rc, attempt ${launch_attempts}), reverting to $retry_phase for retry"
    return 1
  fi

  bounded_retry_clear "$feature_dir" "phase-launch-$launched_phase"
  return 0
}

# Resolve the current workflow phase from controller-owned stage state.
# Priority: stage result files > default.
# Writes the resolved phase to .resolved-phase for downstream consumers.
#
# Usage: resolve_phase <feature_dir>
# Returns: prints one of: planning, coding, review, ready, aborted, awaiting_user, unknown
resolve_phase() {
  local feature_dir="$1"

  if [[ ! -d "$feature_dir" ]]; then
    echo "unknown"
    return 0
  fi

  # 1. Check for abort first (any stage or legacy marker)
  if check_stage_aborted "$feature_dir"; then
    _persist_phase "$feature_dir" "aborted"
    echo "aborted"
    return 0
  fi

  # 2. Check stages in reverse order (highest stage wins)
  # Ready
  local ready_status
  ready_status=$(read_stage_status "$feature_dir" "ready")
  if [[ "$ready_status" == "completed" ]]; then
    _persist_phase "$feature_dir" "ready"
    echo "ready"
    return 0
  fi

  # Review
  if check_stage_complete "$feature_dir" "review" && review_result_has_final_evidence "$feature_dir"; then
    _persist_phase "$feature_dir" "ready"
    echo "ready"
    return 0
  fi

  local review_status
  review_status=$(read_stage_status "$feature_dir" "review")
  if [[ -n "$review_status" ]]; then
    # Review stage exists (running/failed/etc) — we're in review
    _persist_phase "$feature_dir" "review"
    echo "review"
    return 0
  fi

  # Coding
  if check_stage_complete "$feature_dir" "coding"; then
    _persist_phase "$feature_dir" "review"
    echo "review"
    return 0
  fi

  local coding_status
  coding_status=$(read_stage_status "$feature_dir" "coding")
  if [[ -n "$coding_status" ]]; then
    _persist_phase "$feature_dir" "coding"
    echo "coding"
    return 0
  fi

  # Planning
  if check_stage_awaiting_user "$feature_dir" "planning"; then
    _persist_phase "$feature_dir" "awaiting_user"
    echo "awaiting_user"
    return 0
  fi

  if check_stage_complete "$feature_dir" "planning"; then
    _persist_phase "$feature_dir" "coding"
    echo "coding"
    return 0
  fi

  local planning_status
  planning_status=$(read_stage_status "$feature_dir" "planning")
  if [[ -n "$planning_status" ]]; then
    _persist_phase "$feature_dir" "planning"
    echo "planning"
    return 0
  fi

  # 3. Default
  _persist_phase "$feature_dir" "planning"
  echo "planning"
  return 0
}

_persist_phase() {
  local feature_dir="$1" phase="$2"
  local tmp
  tmp=$(mktemp) || return 0
  printf '%s\n' "$phase" > "$tmp"
  mv "$tmp" "$feature_dir/.resolved-phase"
}

# Write .phase-config.json with resolved per-stage configuration.
# Usage: write_phase_config <feature_dir> <planner_model> <coder_model> <reviewer_model> \
#                           <plan_depth> <code_depth> <review_mode> [force_model]
write_phase_config() {
  local feature_dir="$1"
  local planner_model="$2" coder_model="$3" reviewer_model="$4"
  local plan_depth="$5" code_depth="$6" review_mode="$7"
  local force_model="${8:-}"
  local now
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  mkdir -p "$feature_dir"
  local tmp
  tmp=$(mktemp) || { log_warn "write_phase_config: mktemp failed"; return 0; }

  local force_model_json="null"
  [[ -n "$force_model" ]] && force_model_json="\"$force_model\""

  local planner_agent coder_agent reviewer_agent
  if declare -F agent_resolve_models_for_roles >/dev/null 2>&1; then
    if agent_resolve_models_for_roles "$planner_model" "$coder_model" "$reviewer_model"; then
      :
    fi
    planner_agent="$(agent_resolve_batch_agent_for_role "planner")"
    coder_agent="$(agent_resolve_batch_agent_for_role "coder")"
    reviewer_agent="$(agent_resolve_batch_agent_for_role "reviewer")"
  else
    planner_agent="$(agent_resolve_from_model "$planner_model" "planning" || true)"
    coder_agent="$(agent_resolve_from_model "$coder_model" "coding" || true)"
    reviewer_agent="$(agent_resolve_from_model "$reviewer_model" "review" || true)"
  fi

  local planner_provider coder_provider reviewer_provider
  planner_provider="$(_provider_for_model "$planner_model")"
  coder_provider="$(_provider_for_model "$coder_model")"
  reviewer_provider="$(_provider_for_model "$reviewer_model")"

  jq -n \
    --arg plannerModel "$planner_model" \
    --arg plannerAgent "$planner_agent" \
    --arg plannerProvider "$planner_provider" \
    --arg planDepth "$plan_depth" \
    --arg coderModel "$coder_model" \
    --arg coderAgent "$coder_agent" \
    --arg coderProvider "$coder_provider" \
    --arg codeDepth "$code_depth" \
    --arg reviewerModel "$reviewer_model" \
    --arg reviewerAgent "$reviewer_agent" \
    --arg reviewerProvider "$reviewer_provider" \
    --arg reviewMode "$review_mode" \
    --arg selectedAt "$now" \
    --argjson forceModel "$force_model_json" \
    '{
      planning: {model:$plannerModel, provider:$plannerProvider, agent:$plannerAgent, stageRole:"planning", challengeSide:null, selectedAt:$selectedAt, depth:$planDepth},
      coding: {model:$coderModel, provider:$coderProvider, agent:$coderAgent, stageRole:"coding", challengeSide:null, selectedAt:$selectedAt, depth:$codeDepth},
      review: {model:$reviewerModel, provider:$reviewerProvider, agent:$reviewerAgent, stageRole:"review", challengeSide:null, selectedAt:$selectedAt, mode:$reviewMode},
      resolvedAt: $selectedAt,
      forceModel: $forceModel
    }' > "$tmp" 2>/dev/null || {
      rm -f "$tmp"
      log_warn "write_phase_config: jq failed"
      return 0
    }
  mv "$tmp" "$feature_dir/.phase-config.json"
}

_provider_for_model() {
  local model="$1" provider_json provider
  if [[ -n "${TOOLS_DIR:-}" && -n "$model" ]]; then
    provider_json="$(npx tsx "$TOOLS_DIR/recovery-contract.ts" provider --model "$model" --json 2>/dev/null || true)"
    provider="$(printf '%s' "$provider_json" | jq -r '.provider // empty' 2>/dev/null || true)"
    [[ -n "$provider" ]] && printf '%s\n' "$provider" && return 0
  fi
  case "$(agent_resolve_from_model "$model" "coding" 2>/dev/null || true)" in
    native-openrouter) printf '%s\n' 'native-openrouter' ;;
    native-openai) printf '%s\n' 'native-openai' ;;
    claude) printf '%s\n' 'anthropic' ;;
    codex) printf '%s\n' 'openai' ;;
    *) printf '%s\n' '' ;;
  esac
}

# Read a field from .phase-config.json for a given stage.
# Usage: read_phase_config <feature_dir> <stage> <field>
# Example: read_phase_config "$dir" "coding" "model"
read_phase_config() {
  local feature_dir="$1" stage="$2" field="$3"
  local config_file="$feature_dir/.phase-config.json"
  if [[ -f "$config_file" ]]; then
    jq -r --arg s "$stage" --arg f "$field" '.[$s][$f] // empty' "$config_file" 2>/dev/null || echo ""
  else
    echo ""
  fi
}

resolve_phase_model() {
  local stage="$1" model="${2:-}" fallback_model="$3"

  if [[ -z "$model" ]]; then
    printf '%s\n' "$fallback_model"
    return 0
  fi

  if agent_validate_model "$model" "$REPO_DIR" >/dev/null 2>&1; then
    printf '%s\n' "$model"
    return 0
  fi

  if agent_model_looks_like_depth_tag "$model"; then
    log_warn "  Invalid ${stage} model '$model' looks like a depth tag; using '$fallback_model'"
  else
    log_warn "  Invalid ${stage} model '$model'; using '$fallback_model'"
  fi

  printf '%s\n' "$fallback_model"
}

# Ensure a tmux window exists, creating it if missing (e.g. after monitor restart).
_ensure_window_exists() {
  local session="$1" win="$2" wt_dir="$3"
  if ! tmux list-windows -t "$session" -F '#{window_name}' 2>/dev/null | grep -qxF "$win"; then
    log_warn "  Window $win missing, recreating..."
    tmux new-window -d -t "$session" -n "$win" -c "$wt_dir" 2>/dev/null || true
    tmux set-option -t "$session:$win" remain-on-exit on 2>/dev/null || true
    sleep 1
  fi
}

_tmux_window_target_exists() {
  local session="$1" target="$2" expected_path="${3:-}"
  local target_session target_path expected_real target_real pane_dead

  [[ -n "$session" && -n "$target" ]] || return 1
  target_session="$(tmux display-message -p -t "$target" '#{session_name}' 2>/dev/null || true)"
  [[ "$target_session" == "$session" ]] || return 1
  if [[ -n "$expected_path" ]]; then
    target_path="$(tmux display-message -p -t "$target" '#{pane_current_path}' 2>/dev/null || true)"
    if [[ -z "$target_path" ]]; then
      pane_dead="$(tmux list-panes -t "$target" -F '#{pane_dead}' 2>/dev/null | head -1 || true)"
      [[ "$pane_dead" == "1" ]] && return 0
      return 1
    fi
    expected_real="$(cd -P "$expected_path" 2>/dev/null && printf '%s\n' "$PWD" || printf '%s\n' "$expected_path")"
    target_real="$(cd -P "$target_path" 2>/dev/null && printf '%s\n' "$PWD" || printf '%s\n' "$target_path")"
    [[ "$target_real" == "$expected_real" ]] || return 1
  fi
  return 0
}

_tmux_target_join() {
  local session="$1" target="$2"
  [[ -n "$target" ]] || return 1
  case "$target" in
    @*|*:*) printf '%s\n' "$target" ;;
    *) printf '%s:%s\n' "$session" "$target" ;;
  esac
}

_tmux_task_window_target() {
  local session="$1" issue="$2" slug="$3" state_file="${4:-${STATE_FILE:-}}" wt_dir="${5:-}"
  local stored_target="" canonical target issue_number renamed_target

  if [[ -n "$state_file" && -f "$state_file" ]]; then
    stored_target="$(jq -r --arg issue "$issue" '.tasks[$issue].windowId // empty' "$state_file" 2>/dev/null || true)"
  fi
  if _tmux_window_target_exists "$session" "$stored_target" "$wt_dir"; then
    printf '%s\n' "$stored_target"
    return 0
  fi

  issue_number="${issue##*-}"
  renamed_target="$(tmux list-windows -t "$session" -F '#{window_id}|#{window_name}' 2>/dev/null \
    | awk -F'|' -v issue="$issue" -v issue_number="$issue_number" -v slug="$slug" '
        index($2, issue_number " · " slug " ·") == 1 { print $1; exit }
        index($2, issue_number " · " slug) == 1 { print $1; exit }
        index($2, issue " · " slug " ·") == 1 { print $1; exit }
        index($2, issue " · " slug) == 1 { print $1; exit }
      ')"
  if _tmux_window_target_exists "$session" "$renamed_target" "$wt_dir"; then
    printf '%s\n' "$renamed_target"
    return 0
  fi

  canonical="${issue}-${slug}"
  target="$(tmux list-windows -t "$session" -F '#{window_id}|#{window_name}' 2>/dev/null \
    | awk -F'|' -v name="$canonical" '$2 == name { print $1; exit }')"
  if _tmux_window_target_exists "$session" "$target" "$wt_dir"; then
    printf '%s\n' "$target"
    return 0
  fi

  if [[ -n "$wt_dir" ]]; then
    while IFS='|' read -r target _name; do
      [[ -n "$target" ]] || continue
      if _tmux_window_target_exists "$session" "$target" "$wt_dir"; then
        printf '%s\n' "$target"
        return 0
      fi
    done < <(tmux list-windows -t "$session" -F '#{window_id}|#{window_name}' 2>/dev/null || true)
  fi

  return 1
}

coding_pane_expected_replacement_path() {
  local feature_dir="$1"
  printf '%s\n' "$feature_dir/.coding-pane-expected-replacement.json"
}

mark_coding_pane_expected_replacement() {
  local issue="$1" feature_dir="$2" worktree="$3" target="$4"
  local marker tmp created_at slug

  [[ -n "$feature_dir" ]] || return 1
  mkdir -p "$feature_dir" 2>/dev/null || return 1
  marker="$(coding_pane_expected_replacement_path "$feature_dir")"
  tmp="$(mktemp "$feature_dir/.coding-pane-expected-replacement.tmp.XXXXXX" 2>/dev/null)" || return 1
  created_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  slug="$(basename "$feature_dir")"

  jq -n \
    --arg issue "$issue" \
    --arg slug "$slug" \
    --arg worktree "$worktree" \
    --arg target "$target" \
    --arg createdAt "$created_at" \
    '{
      issue: $issue,
      slug: $slug,
      worktree: $worktree,
      quarantinedWindowTarget: $target,
      createdAt: $createdAt,
      reason: "completed-coding-pane-quarantine"
    }' > "$tmp" 2>/dev/null || {
      rm -f "$tmp"
      return 1
    }
  mv "$tmp" "$marker" 2>/dev/null || {
    rm -f "$tmp"
    return 1
  }
}

clear_coding_pane_expected_replacement() {
  local feature_dir="$1"
  [[ -n "$feature_dir" ]] || return 0
  rm -f "$(coding_pane_expected_replacement_path "$feature_dir")" 2>/dev/null || true
}

consume_coding_pane_expected_replacement() {
  local issue="$1" slug="$2" wt_dir="$3"
  local feature_dir marker marker_issue marker_slug marker_worktree expected_real marker_real

  [[ -n "$wt_dir" && -n "$slug" ]] || return 1
  feature_dir="$wt_dir/features/$slug"
  marker="$(coding_pane_expected_replacement_path "$feature_dir")"
  [[ -f "$marker" ]] || return 1

  marker_issue="$(jq -r '.issue // empty' "$marker" 2>/dev/null || true)"
  marker_slug="$(jq -r '.slug // empty' "$marker" 2>/dev/null || true)"
  marker_worktree="$(jq -r '.worktree // empty' "$marker" 2>/dev/null || true)"
  clear_coding_pane_expected_replacement "$feature_dir"

  [[ "$marker_issue" == "$issue" && "$marker_slug" == "$slug" ]] || return 1
  [[ -n "$marker_worktree" ]] || return 1
  expected_real="$(cd -P "$wt_dir" 2>/dev/null && printf '%s\n' "$PWD" || printf '%s\n' "$wt_dir")"
  marker_real="$(cd -P "$marker_worktree" 2>/dev/null && printf '%s\n' "$PWD" || printf '%s\n' "$marker_worktree")"
  [[ "$marker_real" == "$expected_real" ]] || return 1
  return 0
}

# A completed coding agent must not remain available for unrelated interactive
# input while the controller advances the task. This is deliberately best-effort:
# result state is authoritative and review will recreate a task window as needed.
coding_pane_replacement_intent_path() {
  local feature_dir="$1"
  printf '%s/.coding-pane-replacement-intent.json\n' "$feature_dir"
}

record_coding_pane_replacement_intent() {
  local issue="$1" feature_dir="$2" worktree="${3:-}"
  local slug intent_path intent_tmp created_at

  [[ -n "$feature_dir" ]] || return 0
  slug="$(basename "$feature_dir")"
  intent_path="$(coding_pane_replacement_intent_path "$feature_dir")"
  created_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  mkdir -p "$feature_dir" 2>/dev/null || return 0

  intent_tmp="$(mktemp "$intent_path.tmp.XXXXXX" 2>/dev/null)" || return 0
  jq -n \
    --arg issue "$issue" \
    --arg slug "$slug" \
    --arg from "coding" \
    --arg to "review" \
    --arg action "replace_task_window_after_coding_quarantine" \
    --arg worktree "$worktree" \
    --arg createdAt "$created_at" \
    '{
      issue: $issue,
      slug: $slug,
      from: $from,
      to: $to,
      action: $action,
      worktree: $worktree,
      createdAt: $createdAt
    }' > "$intent_tmp" 2>/dev/null || {
      rm -f "$intent_tmp"
      return 0
    }
  mv "$intent_tmp" "$intent_path" 2>/dev/null || rm -f "$intent_tmp"
  return 0
}

coding_pane_replacement_intent_matches() {
  local issue="$1" slug="$2" feature_dir="$3" to_phase="$4"
  local intent_path

  [[ "$to_phase" == "review" ]] || return 1
  intent_path="$(coding_pane_replacement_intent_path "$feature_dir")"
  [[ -f "$intent_path" ]] || return 1

  jq -e \
    --arg issue "$issue" \
    --arg slug "$slug" \
    --arg to "$to_phase" \
    '(.issue == $issue) and (.slug == $slug) and (.from == "coding") and (.to == $to) and (.action == "replace_task_window_after_coding_quarantine")' \
    "$intent_path" >/dev/null 2>&1
}

clear_coding_pane_replacement_intent() {
  local feature_dir="$1"
  rm -f "$(coding_pane_replacement_intent_path "$feature_dir")" 2>/dev/null || true
}

quarantine_completed_coding_pane() {
  local issue="$1" feature_dir="$2" worktree="${3:-}"
  local slug target

  slug="$(basename "$feature_dir")"
  [[ -n "$worktree" ]] || worktree="$(dirname "$(dirname "$feature_dir")")"
  record_coding_pane_replacement_intent "$issue" "$feature_dir" "$worktree"

  command -v tmux >/dev/null 2>&1 || return 0
  target="$(_tmux_task_window_target "$SESSION" "$issue" "$slug" "${STATE_FILE:-}" "$worktree" 2>/dev/null || true)"
  [[ -n "$target" ]] || return 0

  mark_coding_pane_expected_replacement "$issue" "$feature_dir" "$worktree" "$target" || true
  if ! tmux kill-window -t "$target" 2>/dev/null; then
    clear_coding_pane_expected_replacement "$feature_dir"
  fi
  return 0
}

# Reap a planning agent that finished its phase but did not exit (HOK-2921 /
# REQ-F4). Called at the .plan-approved transition so the next poll's coding
# launch finds an idle pane rather than typing into a live REPL. Unlike
# quarantine_completed_coding_pane this does NOT kill the window — the
# operator may have the plan scrollback open and the same window is reused
# for coding. Only known agent CLIs are terminated: if the pane's foreground
# command is a shell (agent already exited, or the operator recovered the
# window), the reap is a no-op. Failure never blocks the phase transition.
reap_completed_planning_pane() {
  local issue="$1" feature_dir="$2" worktree="${3:-}"
  local slug target fg_cmd

  [[ "${WAVEMILL_SKIP_PLANNING_REAP:-0}" == "1" ]] && return 0
  command -v tmux >/dev/null 2>&1 || return 0

  slug="$(basename "$feature_dir")"
  [[ -n "$worktree" ]] || worktree="$(dirname "$(dirname "$feature_dir")")"
  target="$(_tmux_task_window_target "$SESSION" "$issue" "$slug" "${STATE_FILE:-}" "$worktree" 2>/dev/null || true)"
  [[ -n "$target" ]] || return 0

  if _pane_is_dead_or_idle "$(_tmux_target_join "$SESSION" "$target")"; then
    return 0
  fi
  fg_cmd="$(_pane_current_command "$(_tmux_target_join "$SESSION" "$target")")"
  if _pane_command_is_shell "$fg_cmd"; then
    return 0
  fi

  log "status" "$issue → reaping completed planning agent ($fg_cmd) before coding launch"
  if ! agent_terminate_in_pane "$SESSION" "$target" 10; then
    log_warn "$issue → planning agent in $target did not exit cleanly; coding launch will force pane preparation"
  fi
  return 0
}

_ensure_task_window_exists() {
  local session="$1" issue="$2" slug="$3" wt_dir="$4" lifecycle_phase="${5:-}"
  local target canonical feature_dir expected_replacement="false" expected_marker_replacement="false" new_window_rc=0

  if target="$(_tmux_task_window_target "$session" "$issue" "$slug" "${STATE_FILE:-}" "$wt_dir")"; then
    printf '%s\n' "$target"
    return 0
  fi

  canonical="${issue}-${slug}"
  feature_dir="$wt_dir/features/$slug"
  if coding_pane_replacement_intent_matches "$issue" "$slug" "$feature_dir" "$lifecycle_phase"; then
    expected_replacement="true"
  fi
  if consume_coding_pane_expected_replacement "$issue" "$slug" "$wt_dir"; then
    expected_marker_replacement="true"
  fi
  if [[ "$expected_replacement" == "true" || "$expected_marker_replacement" == "true" ]]; then
    log "status" "  Window $canonical intentionally quarantined after coding, creating fresh review window"
  else
    log_warn "  Window $canonical missing, recreating..." >&2
  fi
  tmux new-window -d -t "$session" -n "$canonical" -c "$wt_dir" 2>/dev/null || new_window_rc=$?
  target="$(tmux display-message -p -t "$session:$canonical" '#{window_id}' 2>/dev/null || true)"
  [[ -n "$target" ]] || target="$canonical"
  tmux set-option -t "$(_tmux_target_join "$session" "$target")" remain-on-exit on 2>/dev/null || true
  if [[ "$expected_replacement" == "true" && "$new_window_rc" -eq 0 ]]; then
    clear_coding_pane_replacement_intent "$feature_dir"
  fi
  sleep 1
  printf '%s\n' "$target"
}

persist_task_window_id() {
  local issue="$1" target="$2"
  local resolved_target window_id

  [[ -n "$issue" && -n "$target" ]] || return 0
  [[ -n "${STATE_FILE:-}" && -f "$STATE_FILE" ]] || return 0

  resolved_target="$target"
  [[ "$resolved_target" == @* ]] || resolved_target="$SESSION:$resolved_target"
  window_id="$(tmux display-message -p -t "$resolved_target" '#{window_id}' 2>/dev/null || true)"
  [[ -n "$window_id" ]] || return 0

  state_mutate "$STATE_FILE" \
    '.tasks[$issue].windowId = $windowId | .tasks[$issue].updated = (now | todate)' \
    --arg issue "$issue" \
    --arg windowId "$window_id" >/dev/null 2>&1 || true
}

_challenge_side_for_issue() {
  local issue="$1" role=""
  role="$(get_task_meta "$issue" "challengeRole" 2>/dev/null || true)"
  if [[ "$role" == "primary" || "$role" == "challenger" ]]; then
    printf '%s\n' "$role"
    return 0
  fi
  if [[ "$issue" == *_c ]]; then
    printf '%s\n' "challenger"
    return 0
  fi
  printf '%s\n' ""
}

_append_recovery_contract_trace() {
  local feature_dir="$1" issue="$2" slug="$3" phase="$4" model="$5" agent="$6" contract_json="$7"
  local trace_id ctx_file line now
  trace_id="$(trace_read_id "$feature_dir" 2>/dev/null || true)"
  [[ -n "$trace_id" ]] || return 0
  ctx_file="$feature_dir/.trace-context.json"
  [[ -f "$ctx_file" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 1
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")
  line="$(jq -cn \
    --arg sv "1.0" \
    --arg tid "$trace_id" \
    --arg iid "$issue" \
    --arg sl "$slug" \
    --arg ts "$now" \
    --arg ph "$phase" \
    --arg mo "$model" \
    --arg ag "$agent" \
    --argjson contract "$contract_json" \
    '{schemaVersion:$sv,traceId:$tid,issueId:$iid,slug:$sl,timestamp:$ts,phase:$ph,event:"recovery_contract_replay",status:"ok",model:$mo,agent:$ag,meta:{contract:$contract}}')" || return 1
  printf '%s\n' "$line" >> "$feature_dir/trace.jsonl"
}

_stop_task_recovery_contract_unavailable() {
  local issue="$1" phase="$2" feature_dir="$3" sub_reason="$4" detail="$5"
  if [[ -f "${STATE_FILE:-}" ]] && jq -e --arg issue "$issue" '.tasks[$issue]? // empty' "$STATE_FILE" >/dev/null 2>&1; then
    state_mutate "$STATE_FILE" \
      '.tasks[$issue].status = "stopped"
       | .tasks[$issue].stopReason = "recovery_contract_unavailable"
       | .tasks[$issue].stopSubReason = $subReason
       | .tasks[$issue].stopDetail = $detail
       | .tasks[$issue].updated = (now | todate)' \
      --arg issue "$issue" \
      --arg subReason "$sub_reason" \
      --arg detail "$detail" >/dev/null 2>&1 || true
  fi
  write_stage_result "$feature_dir" "$phase" "failed" "" "" "recovery_contract_unavailable: $sub_reason - $detail"
  if declare -F wavemill_hook_write >/dev/null 2>&1; then
    wavemill_hook_write "blocked" "recovery_contract_unavailable" "$detail" "" "$sub_reason" || true
  fi
}

# Prepare observable runtime surfaces before launching recovered work.
_prepare_recovery_phase_launch() {
  local issue="$1" slug="$2" phase="$3" feature_dir="$4" wt_dir="$5"
  local agent="$6" model="$7" contract_payload="$8" lifecycle_phase="${9:-}"
  local win contract_title resolved_window artifacts_json=""

  if [[ -f "$feature_dir/.${phase}-result.json" ]]; then
    artifacts_json="$(jq -c --arg phase "$phase" '
      if ((.artifacts // null) | type) == "object" then
        .artifacts
        | if $phase == "review" then
            . + {
              recoveryReplay: {
                status: "running",
                preservesPriorVerdict: true
              }
            }
          else
            .
          end
      else
        empty
      end
    ' "$feature_dir/.${phase}-result.json" 2>/dev/null || true)"
  fi

  if ! write_stage_result_with_history "$feature_dir" "$phase" "running" "$agent" "$model" "Recovery replay of persisted execution contract" \
      "$artifacts_json" \
    || ! jq -e --arg phase "$phase" '.stage == $phase and .status == "running"' "$feature_dir/.${phase}-result.json" >/dev/null 2>&1; then
    log_warn "$issue → failed to record recovered $phase stage"
    return 1
  fi

  if ! configure_agent_hooks "$agent" "$wt_dir" "$REPO_DIR"; then
    log_warn "$issue → failed to configure hooks for recovered $phase stage"
    return 1
  fi

  if declare -F wavemill_hook_write >/dev/null 2>&1; then
    wavemill_hook_write "working" "" "" "$agent" || true
  fi

  if ! win="$(_ensure_task_window_exists "$SESSION" "$issue" "$slug" "$wt_dir" "$lifecycle_phase")" || [[ -z "$win" ]]; then
    log_warn "$issue → failed to restore tmux window for $phase stage"
    return 1
  fi
  resolved_window="$(tmux display-message -p -t "$(_tmux_target_join "$SESSION" "$win")" '#{window_id}' 2>/dev/null || true)"
  if [[ -z "$resolved_window" ]]; then
    log_warn "$issue → restored tmux window could not be verified for $phase stage"
    return 1
  fi

  contract_title="$(printf '%s' "$contract_payload" | jq -r '[.stageRole, .agent, .model] | map(select(type == "string" and length > 0)) | join(" · ")' 2>/dev/null || true)"
  [[ -n "$contract_title" ]] && wavemill_set_tmux_pane_title "$(_tmux_target_join "$SESSION" "$win")" "$contract_title" || true
  return 0
}

# Relaunch an in-flight task's phase agent when its tmux window has been lost
# (typically after a `r`/`a` session resume, which kills the prior tmux session
# before restarting the monitor).
#
# Always returns 0 — the monitor runs under `set -Eeuo pipefail` with an ERR
# trap, so signalling via non-zero return codes would either bail out of the
# monitor or spam error logs. Callers read the outcome from the shell variable
# `_RESTORE_STATE`:
#   none       — window already existed, caller should continue normal processing
#   restored   — agent was relaunched, caller should mark task active and return
#   failed     — restoration failed, caller should flag needs-user and return
_RESTORE_STATE=""
_restore_inflight_task_window_if_missing() {
  local issue="$1" slug="$2" branch="$3" phase="$4"
  local wt_dir
  wt_dir=$(read_state_value "" --arg i "$issue" '.tasks[$i].worktree // ""')
  [[ -z "$wt_dir" ]] && wt_dir="${WORKTREE_ROOT}/${slug}"
  local feature_dir="${wt_dir}/features/${slug}"
  _RESTORE_STATE="none"

  if [[ "$(get_task_execution_owner "$issue")" == "queue" && "$(get_task_pane_state "$issue")" == "released" ]]; then
    log "debug" "$issue → queue-owned released task has no pane to restore"
    return 0
  fi

  if [[ "$(get_task_execution_owner "$issue")" == "reconciliation" && "$(get_task_pane_state "$issue")" == "rehydrating" ]]; then
    local pr_number safety_reason release_reason
    pr_number="$(read_state_value "" --arg i "$issue" '.tasks[$i].pr // ""')"
    safety_reason="$(task_worktree_release_safety "$wt_dir" "$branch" "${BASE_BRANCH:-main}" 2>/dev/null || true)"
    if [[ "$safety_reason" == "ok" ]]; then
      reconciliation_lease_release "$feature_dir"
      release_reason="$(pane_release_preflight "$issue" "$slug" "$feature_dir" "$wt_dir" "$pr_number" "$branch" "${BASE_BRANCH:-main}" 2>/dev/null || true)"
      if [[ "$release_reason" == "ok" ]]; then
        release_task_pane "$issue" "$slug" "$feature_dir" "$wt_dir" "$pr_number" || true
        return 0
      fi
    fi
    set_task_task_owned "$issue" "active" || true
  fi

  # A prior resume may already have determined that this task has no valid
  # recovery contract.  Its phase remains persisted for diagnosis, but it is
  # terminal from the resume controller's perspective; retrying it every poll
  # only produces a missing-window log storm.
  if [[ -f "${STATE_FILE:-}" ]] \
    && jq -e --arg issue "$issue" '
      .tasks[$issue]
      | select(.status == "stopped")
      | select(.stopReason == "recovery_contract_unavailable")
    ' "$STATE_FILE" >/dev/null 2>&1; then
    _RESTORE_STATE="failed"
    return 0
  fi

  if _tmux_task_window_target "$SESSION" "$issue" "$slug" "${STATE_FILE:-}" "$wt_dir" >/dev/null 2>&1; then
    return 0
  fi

  if [[ "$phase" == "coding" && -f "$feature_dir/.coding-complete" ]]; then
    return 0
  fi

  log "status" "⚡ $issue → tmux window missing after resume, relaunching $phase phase"

  local title issue_json
  title=$(read_state_value "" --arg i "$issue" '.tasks[$i].title // ""')
  if [[ -z "$title" ]]; then
    issue_json=$(cat "/tmp/${SESSION}-${issue}-issue.json" 2>/dev/null || echo "{}")
    title=$(echo "$issue_json" | jq -r '.title // "Task"' 2>/dev/null || echo "Task")
  fi

  local challenge_side contract_json contract_ok contract_payload reason detail
  challenge_side="$(_challenge_side_for_issue "$issue")"
  local recovery_args=(read-and-validate --feature-dir "$feature_dir" --stage "$phase" --repo "$REPO_DIR" --json)
  [[ -n "$challenge_side" ]] && recovery_args+=(--challenge-side "$challenge_side")
  if ! contract_json="$(npx tsx "$TOOLS_DIR/recovery-contract.ts" "${recovery_args[@]}" 2>/dev/null)"; then
    _stop_task_recovery_contract_unavailable "$issue" "$phase" "$feature_dir" "contract_read_failed" "recovery-contract CLI exited non-zero"
    _RESTORE_STATE="failed"
    return 0
  fi
  contract_ok="$(printf '%s' "$contract_json" | jq -r '.ok // false' 2>/dev/null || echo "false")"
  if [[ "$contract_ok" != "true" ]]; then
    reason="$(printf '%s' "$contract_json" | jq -r '.reason // "contract_malformed"' 2>/dev/null || echo "contract_malformed")"
    detail="$(printf '%s' "$contract_json" | jq -r '.detail // "Persisted recovery contract is unavailable."' 2>/dev/null || echo "Persisted recovery contract is unavailable.")"
    _stop_task_recovery_contract_unavailable "$issue" "$phase" "$feature_dir" "$reason" "$detail"
    _RESTORE_STATE="failed"
    return 0
  fi

  contract_payload="$(printf '%s' "$contract_json" | jq -c '.contract' 2>/dev/null || echo '{}')"
  local model agent_cmd provider depth rc=0
  model="$(printf '%s' "$contract_payload" | jq -r '.model // empty')"
  agent_cmd="$(printf '%s' "$contract_payload" | jq -r '.agent // empty')"
  provider="$(printf '%s' "$contract_payload" | jq -r '.provider // empty')"

  if ! _append_recovery_contract_trace "$feature_dir" "$issue" "$slug" "$phase" "$model" "$agent_cmd" "$contract_payload"; then
    _stop_task_recovery_contract_unavailable "$issue" "$phase" "$feature_dir" "state_transition_failed" "failed to write recovery contract trace event"
    _RESTORE_STATE="failed"
    return 0
  fi

  if [[ -f "${STATE_FILE:-}" ]] && jq -e --arg issue "$issue" '.tasks[$issue]? // empty' "$STATE_FILE" >/dev/null 2>&1; then
    if ! state_mutate "$STATE_FILE" \
      '.tasks[$issue].model = $model
       | .tasks[$issue].agent = $agent
       | .tasks[$issue].provider = $provider
       | .tasks[$issue].stageRole = $stageRole
       | .tasks[$issue].updated = (now | todate)' \
      --arg issue "$issue" \
      --arg model "$model" \
      --arg agent "$agent_cmd" \
      --arg provider "$provider" \
      --arg stageRole "$phase" >/dev/null 2>&1; then
      _stop_task_recovery_contract_unavailable "$issue" "$phase" "$feature_dir" "state_transition_failed" "failed to update workflow task state"
      _RESTORE_STATE="failed"
      return 0
    fi
  fi

  case "$phase" in
    planning)
      depth=$(read_phase_config "$feature_dir" "planning" "depth")
      [[ -z "$depth" ]] && depth=$(get_task_meta "$issue" "planDepth")
      [[ -z "$depth" ]] && depth="light"
      if ! _prepare_recovery_phase_launch "$issue" "$slug" "planning" "$feature_dir" "$wt_dir" "$agent_cmd" "$model" "$contract_payload"; then
        _stop_task_recovery_contract_unavailable "$issue" "$phase" "$feature_dir" "state_transition_failed" "failed to prepare recovery launch surfaces"
        _RESTORE_STATE="failed"
        return 0
      fi
      launch_planning_phase "$issue" "$slug" "$title" "$wt_dir" "$branch" "$BASE_BRANCH" \
        "$model" "$agent_cmd" "$depth" || rc=$?
      ;;
    coding)
      depth=$(read_phase_config "$feature_dir" "coding" "depth")
      [[ -z "$depth" ]] && depth=$(get_task_meta "$issue" "codeDepth")
      [[ -z "$depth" ]] && depth="medium"
      if ! _prepare_recovery_phase_launch "$issue" "$slug" "coding" "$feature_dir" "$wt_dir" "$agent_cmd" "$model" "$contract_payload"; then
        _stop_task_recovery_contract_unavailable "$issue" "$phase" "$feature_dir" "state_transition_failed" "failed to prepare recovery launch surfaces"
        _RESTORE_STATE="failed"
        return 0
      fi
      launch_coding_phase "$issue" "$slug" "$title" "$wt_dir" "$branch" "$BASE_BRANCH" \
        "$model" "$agent_cmd" "$depth" || rc=$?
      ;;
    review)
      local review_mode
      review_mode=$(read_phase_config "$feature_dir" "review" "mode")
      [[ -z "$review_mode" ]] && review_mode=$(get_task_meta "$issue" "reviewMode")
      [[ -z "$review_mode" ]] && review_mode="static"
      if ! _prepare_recovery_phase_launch "$issue" "$slug" "review" "$feature_dir" "$wt_dir" "$agent_cmd" "$model" "$contract_payload" "review"; then
        _stop_task_recovery_contract_unavailable "$issue" "$phase" "$feature_dir" "state_transition_failed" "failed to prepare recovery launch surfaces"
        _RESTORE_STATE="failed"
        return 0
      fi
      launch_review_phase "$issue" "$slug" "$title" "$wt_dir" "$branch" "$BASE_BRANCH" \
        "$model" "$agent_cmd" "$review_mode" || rc=$?
      ;;
    *)
      log_warn "$issue → Cannot restore window for unsupported phase: $phase"
      _RESTORE_STATE="failed"
      return 0
      ;;
  esac

  if [[ "$rc" -ne 0 ]]; then
    log_warn "$issue → Failed to relaunch $phase phase after resume (rc=$rc)"
    _stop_task_recovery_contract_unavailable "$issue" "$phase" "$feature_dir" "launch_failed" "recovery launch command exited with status $rc"
    _RESTORE_STATE="failed"
    return 0
  fi

  log "status" "$issue → $phase phase relaunched in restored window"
  _RESTORE_STATE="restored"
  return 0
}

# Run a phase-launch command with stderr captured to a tmpfile so a failure's
# log line carries the real error text instead of only ERR-trap line numbers
# (HOK-2921 / REQ-F5). Captured stderr is replayed to the caller's stderr
# after the launch returns, so nothing is lost from the existing streams.
#
# Usage: _run_phase_launch <phase> <launch-command> [args...]
# Returns: the launch command's exit code
_run_phase_launch() {
  local phase="$1"
  shift
  local launch_stderr rc=0
  launch_stderr="$(mktemp -t "wavemill-launch-${phase}-XXXXXX" 2>/dev/null || true)"
  if [[ -z "$launch_stderr" ]]; then
    "$@"
    return $?
  fi
  "$@" 2>"$launch_stderr" || rc=$?
  [[ -s "$launch_stderr" ]] && cat "$launch_stderr" >&2
  if (( rc != 0 )) && [[ -s "$launch_stderr" ]]; then
    log_warn "$(tail -n 20 "$launch_stderr" 2>/dev/null | sed "s/^/  ${phase}-launch stderr: /")"
  fi
  rm -f "$launch_stderr"
  return "$rc"
}

# Launch an agent in a tmux window, ensuring any previous agent is terminated first.
# This is the single point of control for all phase launches — it guarantees:
#   1. Previous agent is killed (Ctrl-C + wait for shell)
#   2. Pane is verified ready before sending commands
#   3. Agent is launched with the correct model (no LLM discretion)
#
# Args:
#   $1 = tmux session:window target
#   $2 = agent command (claude/codex)
#   $3 = model ID
#   $4 = path to prompt file
#   $5 = slug (optional)
#   $6 = issue ID (optional)
_launch_agent_in_pane() {
  local target="$1" agent_cmd="$2" model="$3" prompt_file="$4" slug="${5:-}" issue="${6:-}" semantic_phase="${7:-}"
  local session window
  if [[ "$target" == @* ]]; then
    session="$SESSION"
    window="$target"
  else
    session="${target%%:*}"
    window="${target#*:}"
  fi
  local agent_flags=""
  local abort_check_cmd=""
  local feature_dir=""
  local esc_session esc_issue esc_slug esc_linear_issue linear_issue=""
  local launch_phase="" varied_launch_stage="" varied_launch_model=""
  local esc_varied_stage="" esc_varied_model=""

  [[ "$agent_cmd" == "codex" ]] && agent_flags="--dangerously-bypass-approvals-and-sandbox"
  if [[ -n "$slug" ]]; then
    feature_dir="${WORKTREE_ROOT}/${slug}/features/${slug}"
    abort_check_cmd="check_stage_aborted '$feature_dir'"
  fi
  launch_phase="$semantic_phase"
  if [[ -z "$launch_phase" ]] && declare -F agent_normalize_launch_phase >/dev/null 2>&1; then
    launch_phase="$(agent_normalize_launch_phase "$window" "$prompt_file" 2>/dev/null || true)"
  fi
  if [[ -n "$launch_phase" ]]; then
    varied_launch_stage="$(challenge_stage_for_launch_env "$launch_phase")"
    varied_launch_model="$(challenge_varied_stage_model "$issue" "$varied_launch_stage" 2>/dev/null || true)"
  fi

  # Export wavemill context environment variables for hook protocol
  if declare -F get_linear_issue_id >/dev/null 2>&1; then
    linear_issue="$(get_linear_issue_id "$issue" 2>/dev/null || true)"
  fi
  [[ -n "$linear_issue" ]] || linear_issue="$issue"
  esc_session=${session//\'/\'\\\'\'}
  esc_issue=${issue//\'/\'\\\'\'}
  esc_slug=${slug//\'/\'\\\'\'}
  esc_linear_issue=${linear_issue//\'/\'\\\'\'}
  esc_varied_stage=${varied_launch_stage//\'/\'\\\'\'}
  esc_varied_model=${varied_launch_model//\'/\'\\\'\'}

  # Prepare the pane BEFORE the export send-keys (HOK-2921 / REQ-F3): if a
  # previous agent still holds the pane, the export text would be typed into
  # its REPL instead of executed by the shell. agent_launch_interactive calls
  # agent_prepare_pane_for_launch again below; that second call is a fast
  # no-op once the pane is idle.
  local prepare_rc=0
  agent_prepare_pane_for_launch "$session" "$window" 15 3 "$abort_check_cmd" || prepare_rc=$?
  if [[ "$prepare_rc" -eq 2 ]]; then
    return "$prepare_rc"
  fi

  tmux send-keys -t "$target" \
    "export WAVEMILL_SESSION='$esc_session' WAVEMILL_ISSUE='$esc_issue' WAVEMILL_LINEAR_ISSUE='$esc_linear_issue' WAVEMILL_SLUG='$esc_slug' WAVEMILL_FEATURE_SLUG='$esc_slug' WAVEMILL_FEATURE_DIR='$feature_dir' WAVEMILL_CHALLENGE_VARIED_STAGE='$esc_varied_stage' WAVEMILL_CHALLENGE_VARIED_MODEL='$esc_varied_model'" C-m

  export WAVEMILL_FEATURE_SLUG="$slug"
  export WAVEMILL_FEATURE_DIR="$feature_dir"
  export WAVEMILL_LINEAR_ISSUE="$linear_issue"
  export WAVEMILL_CHALLENGE_VARIED_STAGE="$varied_launch_stage"
  export WAVEMILL_CHALLENGE_VARIED_MODEL="$varied_launch_model"

  agent_launch_interactive "$session" "$window" "$prompt_file" "$agent_cmd" "$model" "$agent_flags" "$abort_check_cmd" "$issue"
}

# Launch the planning phase in an existing tmux window
launch_planning_phase() {
  local issue="$1" slug="$2" title="$3" wt_dir="$4" branch="$5" base_branch="$6"
  local planner_model="$7" planner_agent="$8" plan_depth="$9"
  local operating_mode="normal"
  local win
  local status_file="/tmp/${SESSION}-${issue}-status.txt"
  win="$(_ensure_task_window_exists "$SESSION" "$issue" "$slug" "$wt_dir")"
  persist_task_window_id "$issue" "$win"
  configure_agent_hooks "$planner_agent" "$wt_dir" "$REPO_DIR"
  # Clear stale approval markers before capturing the baseline: removing them
  # afterwards would make the baseline diff attribute the deletions to the
  # planning phase and stash them.
  rm -f "$wt_dir/features/$slug/.plan-approved" \
    "$wt_dir/features/$slug/.plan-approved.premature" \
    "$wt_dir/features/$slug/.plan-approved.premature-announced"
  capture_planning_baseline "$wt_dir"

  # Read issue context
  local issue_json issue_desc issue_context
  issue_json=$(cat "/tmp/${SESSION}-${issue}-issue.json" 2>/dev/null || echo "{}")
  issue_desc=$(echo "$issue_json" | jq -r '.description // ""' 2>/dev/null || echo "")
  issue_context="Issue Description:
$issue_desc
"
  operating_mode="$(get_model_operating_mode "$planner_model" "$REPO_DIR")"

  # Build planning prompt
  local prompt_file="/tmp/${SESSION}-${issue}-planning-prompt.txt"
  build_planning_prompt "$title" "$issue" "$wt_dir" "$branch" "$base_branch" \
    "$issue_context" "$status_file" "$TOOLS_DIR" "$slug" "$plan_depth" "$planner_agent" "$operating_mode" > "$prompt_file"

  log_task "status" "$issue" "Launching planning phase for $issue (model: $planner_model, depth: $plan_depth, mode: $operating_mode)"
  _launch_agent_in_pane "$win" "$planner_agent" "$planner_model" "$prompt_file" "$slug" "$issue"
  return $?
}

# Launch the coding phase in an existing tmux window
launch_coding_phase() {
  local issue="$1" slug="$2" title="$3" wt_dir="$4" branch="$5" base_branch="$6"
  local coder_model="$7" coder_agent="$8" code_depth="$9"
  local operating_mode="normal"
  local win
  local status_file="/tmp/${SESSION}-${issue}-status.txt"
  win="$(_ensure_task_window_exists "$SESSION" "$issue" "$slug" "$wt_dir")"
  persist_task_window_id "$issue" "$win"
  configure_agent_hooks "$coder_agent" "$wt_dir" "$REPO_DIR"

  # Read issue context
  local issue_json issue_desc issue_context
  issue_json=$(cat "/tmp/${SESSION}-${issue}-issue.json" 2>/dev/null || echo "{}")
  issue_desc=$(echo "$issue_json" | jq -r '.description // ""' 2>/dev/null || echo "")
  issue_context="Issue Description:
$issue_desc
"
  operating_mode="$(get_model_operating_mode "$coder_model" "$REPO_DIR")"

  # Build coding prompt
  local prompt_file="/tmp/${SESSION}-${issue}-coding-prompt.txt"
  build_coding_prompt "$title" "$issue" "$wt_dir" "$branch" "$base_branch" \
    "$issue_context" "$status_file" "$TOOLS_DIR" "$slug" "$code_depth" "$coder_agent" "$operating_mode" > "$prompt_file"

  log_task "status" "$issue" "Launching coding phase for $issue (model: $coder_model, depth: $code_depth, mode: $operating_mode)"
  _launch_agent_in_pane "$win" "$coder_agent" "$coder_model" "$prompt_file" "$slug" "$issue"
  return $?
}

# Materialize the review-scope baseline artifact before a review launch
# (HOK-2913). Create-if-absent: an existing baseline (including one written
# before earlier review iterations) is never regenerated, so review-fix
# commits cannot widen the recorded scope. Failure downgrades to a warning —
# the guard's merge-base fallback still admits the branch's own committed
# deliverable, so a missing baseline degrades scope narrowing, not liveness.
ensure_review_scope_baseline() {
  local issue="$1" worktree="$2" feature_dir="$3"
  local out rc=0
  if [[ ! -d "$feature_dir" ]]; then
    log_warn "$issue → review-scope baseline skipped: feature dir missing ($feature_dir)"
    return 1
  fi
  out="$(wavemill_run_tsx_tool "$TOOLS_DIR/write-review-scope-baseline.ts" \
    --repo-dir "$worktree" --feature-dir "$feature_dir" 2>&1)" || rc=$?
  if (( rc != 0 )); then
    log_warn "$issue → review-scope baseline not materialized (guard falls back to merge-base scope): $(printf '%s' "$out" | tail -n 2 | tr '\n' ' ')"
    return 1
  fi
  return 0
}

# Launch the review phase in an existing tmux window
launch_review_phase() {
  local issue="$1" slug="$2" title="$3" wt_dir="$4" branch="$5" base_branch="$6"
  local reviewer_model="$7" reviewer_agent="$8" review_mode="$9"
  local operating_mode="normal"
  local win
  local status_file="/tmp/${SESSION}-${issue}-status.txt"
  win="$(_ensure_task_window_exists "$SESSION" "$issue" "$slug" "$wt_dir" "review")"
  persist_task_window_id "$issue" "$win"
  configure_agent_hooks "$reviewer_agent" "$wt_dir" "$REPO_DIR"

  # Record the committed coding path set once, before the review agent starts
  # (HOK-2913): with the artifact present the scope guard reviews against the
  # task-owned set instead of re-deriving (and mis-flagging) the branch's
  # whole deliverable from merge-base fallback.
  ensure_review_scope_baseline "$issue" "$wt_dir" "$wt_dir/features/$slug" || true

  # Read issue context
  local issue_json issue_desc issue_context
  issue_json=$(cat "/tmp/${SESSION}-${issue}-issue.json" 2>/dev/null || echo "{}")
  issue_desc=$(echo "$issue_json" | jq -r '.description // ""' 2>/dev/null || echo "")
  issue_context="Issue Description:
$issue_desc
"
  operating_mode="$(get_model_operating_mode "$reviewer_model" "$REPO_DIR")"

  # Build review prompt
  local prompt_file="/tmp/${SESSION}-${issue}-review-prompt.txt"
  build_review_prompt "$title" "$issue" "$wt_dir" "$branch" "$base_branch" \
    "$issue_context" "$status_file" "$TOOLS_DIR" "$slug" "$reviewer_model" "$review_mode" "$reviewer_agent" "$operating_mode" > "$prompt_file"

  log_task "status" "$issue" "Launching review phase for $issue (model: $reviewer_model, mode: $review_mode, operating mode: $operating_mode)"
  _launch_agent_in_pane "$win" "$reviewer_agent" "$reviewer_model" "$prompt_file" "$slug" "$issue"
  return $?
}

# Restore the operator-facing review window for an in-review task that already
# has an open PR. On resume we should rebuild the local task context and a
# usable shell window, but we must not relaunch the review prompt because that
# prompt includes PR creation instructions and would conflict with the existing
# PR-backed workflow state.
restore_review_task_window() {
  local issue="$1" slug="$2" branch="$3" pr="$4" wt_dir="$5"
  local win="${issue}-${slug}"
  local target=""
  local feature_dir="$wt_dir/features/$slug"
  local issue_json_file="/tmp/${SESSION}-${issue}-issue.json"
  local task_header_file="$feature_dir/task-packet-header.md"
  local task_details_file="$feature_dir/task-packet-details.md"
  local title issue_json issue_desc linear_issue restored_window recreated_worktree
  local branch_exists=1

  restored_window="false"
  recreated_worktree="false"

  if [[ ! -d "$wt_dir" ]]; then
    if git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$branch" 2>/dev/null; then
      branch_exists=0
    fi

    if [[ "$branch_exists" -ne 0 ]]; then
      log_warn "$issue → Cannot restore review task: branch $branch is missing"
      return 1
    fi

    log "status" "⚡ $issue → Recreating worktree for review task"
    local resolved_path
    resolved_path="$(ensure_worktree "$branch" "$wt_dir" "$REPO_DIR" 2>/dev/null)" || {
      log_warn "$issue → Failed to recreate worktree for review task"
      return 1
    }
    wt_dir="$resolved_path"
    recreated_worktree="true"
  fi

  mkdir -p "$feature_dir"

  if [[ -f "$issue_json_file" ]]; then
    issue_json=$(cat "$issue_json_file" 2>/dev/null || echo "{}")
  else
    linear_issue=$(get_linear_issue_id "$issue")
    issue_json=$(_with_timeout "$API_TIMEOUT" npx tsx "$TOOLS_DIR/get-issue.ts" "$linear_issue" --json 2>/dev/null || echo "{}")
    if [[ -n "$issue_json" ]]; then
      printf '%s\n' "$issue_json" > "$issue_json_file"
    fi
  fi

  # Fetch title and description from state or issue data (used for both packet and agent launch)
  title=$(read_state_value "" --arg i "$issue" '.tasks[$i].title // ""')
  [[ -z "$title" ]] && title=$(printf '%s' "$issue_json" | jq -r '.title // empty' 2>/dev/null || echo "")
  [[ -z "$title" ]] && title="Task"
  issue_desc=$(printf '%s' "$issue_json" | jq -r '.description // empty' 2>/dev/null || echo "")

  if [[ ! -f "$task_header_file" ]]; then
    cat > "$task_header_file" <<EOF
# $issue - $title

## Resume Context

- Review task restored after session resume
- Branch: \`$branch\`
- Open PR: #$pr
- Worktree: \`$wt_dir\`

## Objective

${issue_desc:-Review the existing PR and complete any follow-up work.}
EOF
  fi

  if [[ ! -f "$task_details_file" ]]; then
    cat > "$task_details_file" <<EOF
# $issue - Review Resume Details

## Current Status

This task already has an open pull request: **#$pr**.

The original review-phase tmux window was not available during resume, so
wavemill recreated the local review context here instead of relaunching PR
creation.

## Review Workspace

- Branch: \`$branch\`
- Worktree: \`$wt_dir\`
- Summary file: \`features/$slug/task-packet-header.md\`

## Issue Description

${issue_desc:-No issue description was available from cached or live issue data.}
EOF
  fi

  target="$(_tmux_task_window_target "$SESSION" "$issue" "$slug" "${STATE_FILE:-}" "$wt_dir" 2>/dev/null || true)"
  if [[ -z "$target" ]]; then
    log "status" "⚡ $issue → Restoring review window (PR #$pr)"
    tmux new-window -d -t "$SESSION" -n "$win" -c "$wt_dir" 2>/dev/null || return 1
    target="$(tmux display-message -p -t "$SESSION:$win" '#{window_id}' 2>/dev/null || true)"
    [[ -n "$target" ]] || target="$win"
    tmux set-option -t "$(_tmux_target_join "$SESSION" "$target")" remain-on-exit on 2>/dev/null || true
    restored_window="true"
    sleep 1
  fi

  if _pane_is_dead_or_idle "$(_tmux_target_join "$SESSION" "$target")"; then
    if declare -F launch_review_phase >/dev/null 2>&1 && declare -F agent_resolve_from_model >/dev/null 2>&1; then
      # Get review phase configuration from state
      local reviewer_model review_mode reviewer_agent
      reviewer_model=$(read_state_value "claude-sonnet-5" --arg i "$issue" '.tasks[$i].reviewerModel // "claude-sonnet-5"')
      review_mode=$(read_state_value "static+llm" --arg i "$issue" '.tasks[$i].reviewMode // "static+llm"')

      # Resolve agent from model
      if reviewer_agent="$(agent_resolve_from_model "$reviewer_model" "review")"; then
        # Launch review phase agent
        log "status" "  → Relaunching review agent for $issue (model: $reviewer_model, mode: $review_mode)"
        launch_review_phase "$issue" "$slug" "$title" "$wt_dir" "$branch" "$BASE_BRANCH" "$reviewer_model" "$reviewer_agent" "$review_mode"
        if [[ $? -eq 0 ]]; then
          log "status" "$issue → Review context restored and agent relaunched for PR #$pr"
        else
          log_warn "$issue → Failed to relaunch review agent"
          if [[ "$restored_window" == "true" || "$recreated_worktree" == "true" ]]; then
            log "status" "$issue → Review context restored for PR #$pr (but agent launch failed)"
          fi
          return 1
        fi
      else
        log_warn "$issue → Review relaunch blocked: ${AGENT_RESOLVE_LAST_DIAGNOSTIC:-agent resolution failed}"
        if [[ "$restored_window" == "true" || "$recreated_worktree" == "true" ]]; then
          log "status" "$issue → Review context restored for PR #$pr (but agent launch was blocked)"
        fi
        return 1
      fi
    else
      # Keep the restored window useful in stripped-down test or utility contexts
      # where the full launch stack has not been sourced yet.
      tmux send-keys -t "$(_tmux_target_join "$SESSION" "$target")" "cd '$wt_dir'" C-m 2>/dev/null || true
    fi
  fi

  if [[ "$restored_window" == "true" || "$recreated_worktree" == "true" ]]; then
    log "status" "$issue → Review context restored for PR #$pr"
  fi

  return 0
}

ready_state_dir() {
  local wt_dir="$1" slug="$2"

  for dir in features bugs; do
    if [[ -d "$wt_dir/$dir/$slug" ]]; then
      echo "$wt_dir/$dir/$slug"
      return 0
    fi
  done

  echo "$wt_dir/features/$slug"
}

ready_base_sha() {
  local state_dir="$1"
  local result_file="$state_dir/.ready-result.json"
  [[ -f "$result_file" ]] || { echo ""; return 0; }
  jq -r '.artifacts.readyBaseSha // empty' "$result_file" 2>/dev/null || echo ""
}

ready_queue_state() {
  local state_dir="$1"
  local result_file="$state_dir/.ready-result.json"
  local status verdict queue_state

  [[ -f "$result_file" ]] || { echo ""; return 0; }

  queue_state=$(jq -r '.artifacts.queueState // empty' "$result_file" 2>/dev/null || echo "")
  if [[ -n "$queue_state" ]]; then
    printf '%s\n' "$queue_state"
    return 0
  fi

  status=$(jq -r '.status // empty' "$result_file" 2>/dev/null || echo "")
  verdict=$(jq -r '.artifacts.verdict // empty' "$result_file" 2>/dev/null || echo "")
  if [[ "$status" == "completed" && ( "$verdict" == "pass" || "$verdict" == "warn" ) ]]; then
    printf 'ready\n'
  else
    printf '\n'
  fi
}

ready_queue_field() {
  local state_dir="$1" field="$2"
  local result_file="$state_dir/.ready-result.json"
  [[ -f "$result_file" ]] || { echo ""; return 0; }
  jq -r --arg field "$field" '.artifacts[$field] // empty' "$result_file" 2>/dev/null || echo ""
}

# Reads the transient merge-retry window marker written by the tend process for a
# PR (shared/lib/tend-controller.ts writeMergeRetryMarker). Returns the ISO expiry
# timestamp while tend is actively retrying a transient merge failure, or empty
# when no active retry window exists. Keeps the local merge queue from demoting a
# candidate as "stuck" while tend keeps retrying it in a separate process.
merge_retry_marker_until() {
  local pr="$1"
  local marker_file="$REPO_DIR/.wavemill/merge-retry/${pr}.json"
  [[ -n "$pr" && -f "$marker_file" ]] || { echo ""; return 0; }
  jq -r '.until // empty' "$marker_file" 2>/dev/null || echo ""
}

merge_queue_enabled() {
  [[ "${MERGE_QUEUE_ENABLED:-true}" == "1" || "${MERGE_QUEUE_ENABLED:-true}" == "true" ]]
}

# Mirrors the tend process's per-PR lane-progress record (HOK-2919, written by
# shared/lib/merge-queue.ts recordLaneProgress) into a merge-queue artifacts
# patch so queue residence is explainable from the ready artifacts alone.
# Emits '{}' when no record exists or it is unreadable.
lane_progress_patch_json() {
  local pr="$1"
  local progress_file="$REPO_DIR/.wavemill/merge-lane/${pr}/progress.json"
  [[ -n "$pr" && -f "$progress_file" ]] || { echo "{}"; return 0; }
  jq -c '
    {
      lastProgressAt: (.lastProgressAt // null),
      laneWaitSeconds: (.laneWaitSeconds // null),
      laneHoldSeconds: (.laneHoldSeconds // null),
      rebaseCount: (.rebaseCount // null),
      ciRestartCount: (.ciRestartCount // null)
    } | with_entries(select(.value != null))
  ' "$progress_file" 2>/dev/null || echo "{}"
}

wavemill_run_tsx_tool() {
  local tool="$1"
  shift

  if node --import tsx -e "" >/dev/null 2>&1; then
    node --import tsx "$tool" "$@"
  elif command -v tsx >/dev/null 2>&1; then
    tsx "$tool" "$@"
  else
    npx tsx "$tool" "$@"
  fi
}

ready_live_ci_json() {
  local wt_dir="$1" pr_number="$2" base_branch="$3"
  local output rc=0

  output=$(_with_timeout "$API_TIMEOUT" wavemill_run_tsx_tool "$TOOLS_DIR/pr-ci-status.ts" "$pr_number" --repo-dir "$wt_dir" --base "$base_branch" 2>/dev/null) || rc=$?
  if (( rc != 0 )) || [[ -z "$output" ]] || ! printf '%s' "$output" | jq -e . >/dev/null 2>&1; then
    jq -cn \
      --arg reason "pr-ci-status failed for PR #$pr_number" \
      '{conclusion:"unknown", observed:0, passing:0, failing:[], pending:[], missingRequired:[], requiredContexts:[], requiredSource:"none", readError:{errorType:"command-failed", reason:$reason}}'
    return 0
  fi
  printf '%s\n' "$output"
}

write_ready_queue_artifacts() {
  local state_dir="$1" patch_json="$2"
  local result_file="$state_dir/.ready-result.json"
  local existing_artifacts merged_artifacts

  [[ -f "$result_file" ]] || return 0
  existing_artifacts=$(jq -c '.artifacts // {"type":"ready"}' "$result_file" 2>/dev/null || echo '{"type":"ready"}')
  merged_artifacts=$(jq -cn \
    --argjson existing "$existing_artifacts" \
    --argjson patch "$patch_json" '
      reduce ($patch | keys[]) as $key ($existing;
        if $patch[$key] == null then
          del(.[$key])
        else
          .[$key] = $patch[$key]
        end
      ) | .type = "ready"
    ')

  wavemill_run_tsx_tool "$TOOLS_DIR/stage-result-cli.ts" update "$state_dir" ready --artifacts "$merged_artifacts" >/dev/null 2>&1 || \
    log_warn "merge queue: failed to update ready artifacts in $state_dir"
}

mark_ready_stale() {
  local issue="$1" state_dir="$2" old_sha="$3" new_sha="$4"
  local now patch_json
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  patch_json=$(jq -cn \
    --arg old_sha "$old_sha" \
    --arg new_sha "$new_sha" \
    --arg now "$now" '
      {
        queueState: "ready-stale",
        staleAt: $now,
        staleBaseSha: $old_sha,
        targetBaseSha: $new_sha,
        candidatePromotedAt: null,
        candidateLastProgressAt: null
      }
    ')
  write_ready_queue_artifacts "$state_dir" "$patch_json"
}

promote_merge_candidate() {
  local issue="$1" state_dir="$2" new_sha="$3"
  local now existing_promoted_at patch_json ready_at ready_epoch now_epoch lane_wait_seconds
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  existing_promoted_at=$(ready_queue_field "$state_dir" "candidatePromotedAt")
  [[ -z "$existing_promoted_at" ]] && existing_promoted_at="$now"
  # Progress telemetry (HOK-2919): laneWaitSeconds is the ready-verdict → lane
  # entry span, computable only here where the ready timestamps live.
  lane_wait_seconds=""
  ready_at=$(jq -r '.finishedAt // .startedAt // empty' "$state_dir/.ready-result.json" 2>/dev/null || echo "")
  if [[ -n "$ready_at" ]]; then
    ready_epoch="$(wavemill_iso8601_to_epoch "$ready_at" 2>/dev/null || echo 0)"
    now_epoch="$(wavemill_iso8601_to_epoch "$now" 2>/dev/null || echo 0)"
    if [[ "$ready_epoch" =~ ^[0-9]+$ && "$now_epoch" =~ ^[0-9]+$ && "$ready_epoch" -gt 0 && "$now_epoch" -ge "$ready_epoch" ]]; then
      lane_wait_seconds=$(( now_epoch - ready_epoch ))
    fi
  fi
  patch_json=$(jq -cn \
    --arg new_sha "$new_sha" \
    --arg now "$now" \
    --arg promoted_at "$existing_promoted_at" \
    --arg lane_wait_seconds "$lane_wait_seconds" '
      {
        queueState: "merge-candidate",
        targetBaseSha: $new_sha,
        candidatePromotedAt: $promoted_at,
        candidateLastProgressAt: $now,
        lastProgressAt: $now,
        laneWaitSeconds: (if $lane_wait_seconds == "" then null else ($lane_wait_seconds | tonumber) end),
        staleAt: null,
        staleBaseSha: null,
        candidateSkipReason: null
      } | with_entries(select(.key != "laneWaitSeconds" or .value != null))
    ')
  write_ready_queue_artifacts "$state_dir" "$patch_json"
}

demote_merge_candidate() {
  local issue="$1" state_dir="$2" reason="$3"
  local now patch_json
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  patch_json=$(jq -cn \
    --arg reason "$reason" \
    --arg now "$now" '
      {
        queueState: "ready-stale",
        candidateSkippedAt: $now,
        candidateSkipReason: $reason,
        candidatePromotedAt: null,
        candidateLastProgressAt: null,
        mergeRetryInProgressUntil: null
      }
    ')
  write_ready_queue_artifacts "$state_dir" "$patch_json"
}

mark_ready_stale_head() {
  local issue="$1" state_dir="$2" old_head="$3" new_head="$4"
  local now patch_json
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  patch_json=$(jq -cn \
    --arg old_head "$old_head" \
    --arg new_head "$new_head" \
    --arg now "$now" '
      {
        queueState: "ready-stale",
        staleAt: $now,
        staleHeadSha: $old_head,
        targetHeadSha: $new_head,
        candidatePromotedAt: null,
        candidateLastProgressAt: null
      }
    ')
  write_ready_queue_artifacts "$state_dir" "$patch_json"
}

ci_summary_from_json() {
  local ci_json="$1"
  printf '%s' "$ci_json" | jq -r '
    (.conclusion // "unknown") as $conclusion
    | (.observed // 0) as $observed
    | ((.requiredContexts // []) | length) as $required
    | if $conclusion == "pass" then
        "pass: \($observed)/\(if $required > 0 then $required else $observed end) checks"
      elif $conclusion == "fail" then
        "fail: " + (((.failing // []) | join(", ")) // "checks failing")
      elif $conclusion == "pending" then
        "pending: \($observed)/\(if $required > 0 then $required else $observed end) checks"
      else
        $conclusion
      end
  ' 2>/dev/null || echo "unknown"
}

invalidate_ready_for_ci() {
  local issue="$1" state_dir="$2" ci_json="$3"
  local now failing_names reason existing_artifacts artifacts_json pr_number
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  failing_names=$(printf '%s' "$ci_json" | jq -r '(.failing // []) | join(", ")' 2>/dev/null || echo "")
  [[ -n "$failing_names" ]] || failing_names="required CI checks"
  reason="CI regressed after ready pass: $failing_names"
  pr_number=$(jq -r '.artifacts.prNumber // empty' "$state_dir/.ready-result.json" 2>/dev/null || echo "")
  existing_artifacts=$(jq -c '.artifacts // {"type":"ready"}' "$state_dir/.ready-result.json" 2>/dev/null || echo '{"type":"ready"}')
  artifacts_json=$(jq -cn \
    --argjson existing "$existing_artifacts" \
    --argjson ci "$ci_json" \
    --arg now "$now" \
    --arg reason "$reason" '
      $existing
      + {
          type: "ready",
          verdict: "fail",
          queueState: null,
          candidatePromotedAt: null,
          candidateLastProgressAt: null,
          mergeRetryInProgressUntil: null,
          ciInvalidatedAt: $now,
          ciInvalidationReason: $reason,
          ciFailingChecks: ($ci.failing // []),
          lastCiConclusion: ($ci.conclusion // "unknown"),
          lastCiHeadSha: ($ci.headSha // ""),
          lastCiObservedAt: $now,
          lastCiSummary: ($reason)
        }
      | with_entries(select(.value != null))
    ')
  write_stage_result "$state_dir" "ready" "failed" "" "" "$reason" "$artifacts_json"
  log "status" "✗ $issue → PR ${pr_number:+#$pr_number }live CI failing ($failing_names); ready verdict invalidated"
}

ready_candidate_selected() {
  local issue="$1"
  [[ -f "$MERGE_QUEUE_SELECTION_FILE" ]] || return 1
  jq -e --arg issue "$issue" '.selectedIssues // [] | index($issue) != null' "$MERGE_QUEUE_SELECTION_FILE" >/dev/null 2>&1
}

ready_changed_files_json() {
  local state_dir="$1" wt_dir="$2" pr_number="$3"
  local result_file="$state_dir/.ready-result.json"
  local cached

  cached=$(jq -c '.artifacts.changedFiles // empty' "$result_file" 2>/dev/null || echo "")
  if [[ -n "$cached" && "$cached" != "null" ]]; then
    printf '%s\n' "$cached"
    return 0
  fi

  if cached=$(cd "$wt_dir" && gh pr view "$pr_number" --json files --jq '[.files[].path]' 2>/dev/null); then
    [[ -n "$cached" ]] && printf '%s\n' "$cached" && return 0
  fi

  printf '[]\n'
}

merge_queue_enrich_ready_artifacts() {
  local state_dir="$1" base_json="$2" mode="${3:-preserve}"
  local queue_state promoted_at target_base now extra_json

  if ! merge_queue_enabled; then
    printf '%s\n' "$base_json"
    return 0
  fi

  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  queue_state=$(ready_queue_state "$state_dir")
  promoted_at=$(ready_queue_field "$state_dir" "candidatePromotedAt")
  target_base=$(ready_queue_field "$state_dir" "targetBaseSha")

  case "$mode" in
    completed)
      extra_json='{"queueState":"ready"}'
      ;;
    candidate-progress)
      if [[ "$queue_state" == "merge-candidate" ]]; then
        extra_json=$(jq -cn \
          --arg target_base "$target_base" \
          --arg promoted_at "${promoted_at:-$now}" \
          --arg now "$now" '
            {
              queueState: "merge-candidate",
              targetBaseSha: $target_base,
              candidatePromotedAt: $promoted_at,
              candidateLastProgressAt: $now
            }
          ')
      else
        extra_json='{}'
      fi
      ;;
    *)
      extra_json='{}'
      ;;
  esac

  jq -cn --argjson base "$base_json" --argjson extra "$extra_json" '$base + $extra'
}

refresh_ready_merge_queue_tick() {
  local now input_file output_file input_json output_json config_json
  local issue phase slug pr state_dir ready_status ready_verdict stored_base current_main queue_state wt_dir workflow_status pr_state_val
  local ci_json ci_conclusion ci_head ci_summary stored_head lane_progress_patch
  local ready_prs='[]'

  : > "$MERGE_QUEUE_SELECTION_FILE"
  if ! merge_queue_enabled; then
    printf '{"selectedIssues":[],"stuckIssues":[],"ciBlockedIssues":[]}\n' > "$MERGE_QUEUE_SELECTION_FILE"
    return 0
  fi

  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  for issue in "${!BRANCH_BY_ISSUE[@]}"; do
    phase=$(get_task_phase "$issue")
    [[ "$phase" == "ready" ]] || continue
    slug="${SLUG_BY_ISSUE[$issue]}"
    pr="${PR_BY_ISSUE[$issue]:-}"
    [[ -n "$pr" ]] || continue
    wt_dir="${WORKTREE_ROOT}/${slug}"
    state_dir="$(ready_state_dir "$wt_dir" "$slug")"
    [[ -f "$state_dir/.ready-result.json" ]] || continue

    ready_status=$(read_stage_status "$state_dir" "ready")
    ready_verdict=$(ready_stage_pending_verdict "$state_dir")
    queue_state=$(ready_queue_state "$state_dir")
    stored_base=$(ready_base_sha "$state_dir")
    current_main=$(get_main_head_sha "$wt_dir" "$BASE_BRANCH")
    workflow_status=$(read_state_value "" --arg i "$issue" '.tasks[$i].status // ""')

    # Skip terminal tasks early (authoritative guard is in merge-queue.ts)
    if [[ "$workflow_status" == "merged" || "$workflow_status" == "completed-external" || "$workflow_status" == "aborted" ]]; then
      continue
    fi

    ci_json="$(ready_live_ci_json "$wt_dir" "$pr" "$BASE_BRANCH")"
    ci_conclusion=$(printf '%s' "$ci_json" | jq -r '.conclusion // "unknown"' 2>/dev/null || echo "unknown")
    ci_head=$(printf '%s' "$ci_json" | jq -r '.headSha // empty' 2>/dev/null || echo "")
    ci_summary="$(ci_summary_from_json "$ci_json")"
    pr_state_val=$(printf '%s' "$ci_json" | jq -r '.state // empty' 2>/dev/null || echo "")
    [[ -n "$pr_state_val" ]] || pr_state_val="$(pr_state "$pr")"

    write_ready_queue_artifacts "$state_dir" "$(jq -cn \
      --arg conclusion "$ci_conclusion" \
      --arg head "$ci_head" \
      --arg now "$now" \
      --arg summary "$ci_summary" \
      '{
        lastCiConclusion: $conclusion,
        lastCiHeadSha: $head,
        lastCiObservedAt: $now,
        lastCiSummary: $summary
      }')"

    # Mirror tend's lane-progress telemetry (rebase/CI-restart counts, hold
    # time) into the queue artifacts so both subsystems explain residence from
    # the same numbers (HOK-2919).
    lane_progress_patch="$(lane_progress_patch_json "$pr")"
    if [[ -n "$lane_progress_patch" && "$lane_progress_patch" != "{}" ]]; then
      write_ready_queue_artifacts "$state_dir" "$lane_progress_patch"
    fi

    if [[ "$ready_status" == "completed" && ( "$ready_verdict" == "pass" || "$ready_verdict" == "warn" ) && -n "$current_main" && "$stored_base" != "$current_main" && "$queue_state" != "merge-candidate" ]]; then
      mark_ready_stale "$issue" "$state_dir" "$stored_base" "$current_main"
      queue_state="ready-stale"
    fi

    stored_head=$(ready_queue_field "$state_dir" "readyHeadSha")
    if [[ "$ready_status" == "completed" && ( "$ready_verdict" == "pass" || "$ready_verdict" == "warn" ) && "$ci_conclusion" == "fail" ]]; then
      invalidate_ready_for_ci "$issue" "$state_dir" "$ci_json"
      continue
    fi
    if [[ "$ready_status" == "completed" && ( "$ready_verdict" == "pass" || "$ready_verdict" == "warn" ) && -n "$stored_head" && -n "$ci_head" && "$stored_head" != "$ci_head" && "$queue_state" != "merge-candidate" ]]; then
      mark_ready_stale_head "$issue" "$state_dir" "$stored_head" "$ci_head"
      queue_state="ready-stale"
    fi

    if [[ "$ready_status" == "completed" && ( "$ready_verdict" == "pass" || "$ready_verdict" == "warn" ) ]] || [[ "$queue_state" == "merge-candidate" || "$queue_state" == "ready-stale" ]]; then
      ready_prs=$(jq -cn \
        --argjson prs "$ready_prs" \
        --arg issue "$issue" \
        --arg slug "$slug" \
        --arg branch "${BRANCH_BY_ISSUE[$issue]}" \
        --argjson pr_number "$pr" \
        --arg ready_base_sha "$stored_base" \
        --arg queue_state "$queue_state" \
        --arg workflow_status "$workflow_status" \
        --arg pr_state "$pr_state_val" \
        --argjson ci "$ci_json" \
        --arg now "$now" \
        --arg ready_at "$(jq -r '.finishedAt // .startedAt // empty' "$state_dir/.ready-result.json" 2>/dev/null || echo "")" \
        --arg candidate_promoted_at "$(ready_queue_field "$state_dir" candidatePromotedAt)" \
        --arg candidate_last_progress_at "$(ready_queue_field "$state_dir" candidateLastProgressAt)" \
        --arg last_progress_at "$(ready_queue_field "$state_dir" lastProgressAt)" \
        --arg merge_retry_in_progress_until "$(merge_retry_marker_until "$pr")" \
        --arg candidate_skipped_at "$(ready_queue_field "$state_dir" candidateSkippedAt)" \
        --argjson changed_files "$(ready_changed_files_json "$state_dir" "$wt_dir" "$pr")" '
          $prs + [{
            issue: $issue,
            slug: $slug,
            prNumber: $pr_number,
            branch: $branch,
            readyBaseSha: $ready_base_sha,
            queueState: (if $queue_state == "" then null else $queue_state end),
            changedFiles: $changed_files,
            readyAt: (if $ready_at == "" then null else $ready_at end),
            unblocksCount: 0,
            candidatePromotedAt: (if $candidate_promoted_at == "" then null else $candidate_promoted_at end),
            candidateLastProgressAt: (if $candidate_last_progress_at == "" then null else $candidate_last_progress_at end),
            lastProgressAt: (if $last_progress_at == "" then null else $last_progress_at end),
            mergeRetryInProgressUntil: (if $merge_retry_in_progress_until == "" then null else $merge_retry_in_progress_until end),
            candidateSkippedAt: (if $candidate_skipped_at == "" then null else $candidate_skipped_at end),
            workflowStatus: (if $workflow_status == "" then null else $workflow_status end),
            prState: (if $pr_state == "" then null else $pr_state end),
            ci: {
              conclusion: ($ci.conclusion // "unknown"),
              headSha: ($ci.headSha // null),
              mergeStateStatus: ($ci.mergeStateStatus // null),
              observedAt: $now,
              failing: ($ci.failing // []),
              observed: ($ci.observed // 0),
              required: (($ci.requiredContexts // []) | length)
            }
          }]
        ')
    fi
  done

  config_json=$(jq -cn \
    --arg enabled "${MERGE_QUEUE_ENABLED:-true}" \
    --argjson max_concurrent "${MERGE_QUEUE_MAX_CONCURRENT:-2}" \
    --argjson stuck_timeout "${MERGE_QUEUE_STUCK_TIMEOUT_SECONDS:-900}" \
    --arg conflict_grouping "${MERGE_QUEUE_CONFLICT_GROUPING_ENABLED:-true}" \
    --argjson skip_cooldown "${MERGE_QUEUE_SKIP_COOLDOWN_SECONDS:-60}" '
      {
        enabled: ($enabled == "true" or $enabled == "1"),
        maxConcurrentCandidates: $max_concurrent,
        stuckTimeoutSeconds: $stuck_timeout,
        conflictGroupingEnabled: ($conflict_grouping == "true" or $conflict_grouping == "1"),
        skipCooldownSeconds: $skip_cooldown
      }
    ')

  input_file=$(mktemp) || return 0
  output_file=$(mktemp) || { rm -f "$input_file"; return 0; }
  jq -cn --arg now "$now" --argjson prs "$ready_prs" --argjson config "$config_json" '{readyPrs:$prs, now:$now, config:$config}' > "$input_file"
  if ! wavemill_run_tsx_tool "$TOOLS_DIR/merge-queue-select.ts" --input "$input_file" > "$output_file" 2>/dev/null; then
    rm -f "$input_file" "$output_file"
    printf '{"selectedIssues":[],"stuckIssues":[],"ciBlockedIssues":[]}\n' > "$MERGE_QUEUE_SELECTION_FILE"
    return 0
  fi
  mv "$output_file" "$MERGE_QUEUE_SELECTION_FILE"
  rm -f "$input_file"

  jq -r '.ciBlockedIssues[]?' "$MERGE_QUEUE_SELECTION_FILE" 2>/dev/null | while IFS= read -r issue; do
    [[ -n "$issue" ]] || continue
    slug="${SLUG_BY_ISSUE[$issue]}"
    wt_dir="${WORKTREE_ROOT}/${slug}"
    state_dir="$(ready_state_dir "$wt_dir" "$slug")"
    pr="${PR_BY_ISSUE[$issue]:-}"
    ci_json="$(ready_live_ci_json "$wt_dir" "$pr" "$BASE_BRANCH")"
    demote_merge_candidate "$issue" "$state_dir" "live CI failing"
    invalidate_ready_for_ci "$issue" "$state_dir" "$ci_json"
  done

  jq -r '.stuckIssues[]?' "$MERGE_QUEUE_SELECTION_FILE" 2>/dev/null | while IFS= read -r issue; do
    [[ -n "$issue" ]] || continue
    slug="${SLUG_BY_ISSUE[$issue]}"
    wt_dir="${WORKTREE_ROOT}/${slug}"
    state_dir="$(ready_state_dir "$wt_dir" "$slug")"
    demote_merge_candidate "$issue" "$state_dir" "stuck merge candidate"
  done

  jq -r '.selectedIssues[]?' "$MERGE_QUEUE_SELECTION_FILE" 2>/dev/null | while IFS= read -r issue; do
    [[ -n "$issue" ]] || continue
    slug="${SLUG_BY_ISSUE[$issue]}"
    wt_dir="${WORKTREE_ROOT}/${slug}"
    state_dir="$(ready_state_dir "$wt_dir" "$slug")"
    current_main=$(get_main_head_sha "$wt_dir" "$BASE_BRANCH")
    [[ -n "$current_main" ]] || continue
    if [[ "$(ready_queue_state "$state_dir")" != "merge-candidate" ]]; then
      promote_merge_candidate "$issue" "$state_dir" "$current_main"
      local pr_for_log
      pr_for_log="${PR_BY_ISSUE[$issue]:-}"
      ci_head=$(ready_queue_field "$state_dir" "lastCiHeadSha")
      ci_summary=$(ready_queue_field "$state_dir" "lastCiSummary")
      [[ -n "$ci_summary" ]] || ci_summary="pass"
      log "status" "✓ $issue → PR ${pr_for_log:+#$pr_for_log }promoted to merge candidate (live CI $ci_summary${ci_head:+ @${ci_head:0:7}}, base current)"
    fi
  done
}

get_main_head_sha() {
  local wt_dir="$1" base_branch="$2"
  local remote_ref="refs/heads/${base_branch}"
  local remote_timeout remote_output remote_rc=0
  remote_timeout="$(wavemill_git_remote_timeout_seconds)"
  remote_output="$(wavemill_git_remote_with_timeout "$remote_timeout" -C "$wt_dir" ls-remote origin "$remote_ref" 2>/dev/null)" || remote_rc=$?

  if (( remote_rc != 0 )); then
    log_warn "git ls-remote failed for worktree=$wt_dir remote=origin ref=$remote_ref timeout=${remote_timeout}s exit=$remote_rc; skipping base-branch freshness this tick"
    printf '\n'
    return 0
  fi

  awk '{print $1}' <<< "$remote_output"
}

ready_stage_allows_merge() {
  local state_dir="$1"
  local result_file="$state_dir/.ready-result.json"
  local status verdict

  [[ -f "$result_file" ]] || return 1

  status=$(jq -r '.status // empty' "$result_file" 2>/dev/null || echo "")
  verdict=$(jq -r '.artifacts.verdict // empty' "$result_file" 2>/dev/null || echo "")

  [[ "$status" == "completed" && ( "$verdict" == "pass" || "$verdict" == "warn" ) ]]
}

# Keep the merged-before-ready warning one-shot per task instance so the
# attention signal persists without spamming every monitor tick.
ready_stage_warn_bypass_once() {
  local state_dir="$1" issue="$2" pr="$3"
  local sentinel="$state_dir/.ready-bypass-warned"

  mkdir -p "$state_dir"
  if [[ -f "$sentinel" ]]; then
    return 1
  fi

  log "status" "⛔ $issue → PR #$pr was merged before ready checks passed"
  : > "$sentinel"
  return 0
}

ready_stage_pending_verdict() {
  local state_dir="$1"
  local result_file="$state_dir/.ready-result.json"

  [[ -f "$result_file" ]] || { echo ""; return 0; }
  jq -r '.artifacts.verdict // empty' "$result_file" 2>/dev/null || echo ""
}

READY_TRANSIENT_MAX_ATTEMPTS=6

# Failed-ready re-check budget (HOK-2893). Operator env overrides survive the
# `:=` defaults; all knobs are validated at point of use with these fallbacks.
: "${READY_FAILED_RECHECK_MAX_ATTEMPTS:=4}"
: "${READY_FAILED_RECHECK_BACKOFF_SECONDS:=120}"
: "${READY_FAILED_RECHECK_BACKOFF_CAP_SECONDS:=1800}"
: "${READY_FAILED_RECHECK_IDENTICAL_LIMIT:=3}"

write_ready_attention_file() {
  local state_dir="$1" message="$2"
  local repo_dir
  repo_dir=$(git -C "$state_dir" rev-parse --show-toplevel 2>/dev/null) || return 0
  local head_sha
  head_sha=$(git -C "$repo_dir" rev-parse HEAD 2>/dev/null) || return 0
  marker_write "$state_dir/.needs-attention" --kind ready-attention --head "$head_sha" --reason "$message"
}

_write_cross_pr_diagnostic() {
  local state_dir="$1" ref_name="$2" cmd_class="$3" diag_stderr="$4"
  local result_file="$state_dir/.ready-result.json"
  local diag_json
  diag_json=$(jq -cn \
    --arg ref "$ref_name" \
    --arg commandClass "$cmd_class" \
    --arg stderr "$diag_stderr" \
    '{commandClass: $commandClass, ref: $ref, stderr: $stderr}') || return 0

  mkdir -p "$state_dir"
  local tmp
  tmp=$(mktemp "$state_dir/.ready-result.XXXXXX") || return 0

  if [[ -f "$result_file" ]]; then
    jq -c --argjson diag "$diag_json" '. + {crossPrDiagnostic: $diag}' "$result_file" > "$tmp" 2>/dev/null \
      && mv "$tmp" "$result_file"
  else
    printf '{"crossPrDiagnostic":%s}\n' "$diag_json" > "$tmp" \
      && mv "$tmp" "$result_file"
  fi
  rm -f "$tmp"
}

write_cross_pr_guard_ready_result() {
  local state_dir="$1" pr_number="$2" checked_head_sha="$3" status="$4" reason="$5" raw_result="${6:-}"
  local result_file="$state_dir/.ready-result.json"
  local now tmp

  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  mkdir -p "$state_dir"
  tmp=$(mktemp "$state_dir/.ready-result.XXXXXX") || return 0

  jq -cn \
    --arg now "$now" \
    --argjson pr_number "$pr_number" \
    --arg checked_head_sha "$checked_head_sha" \
    --arg status "$status" \
    --arg reason "$reason" \
    --arg raw_result "$raw_result" '
      ($raw_result | fromjson? // {}) as $parsed
      | {
          stage: "ready",
          status: "failed",
          startedAt: $now,
          finishedAt: $now,
          agent: "",
          model: "",
          notes: $reason,
          failureReason: $reason,
          artifacts: {
            type: "ready",
            verdict: "fail",
            prNumber: $pr_number,
            readyHeadSha: $checked_head_sha,
            crossPrGuard: {
              source: "cross-pr-revert-guard",
              status: $status,
              checkedHeadSha: $checked_head_sha,
              reason: $reason,
              result: $parsed,
              toolError: ($parsed.toolError // null)
            }
          }
        }
      | .artifacts.crossPrGuard |= with_entries(select(.value != null))
    ' > "$tmp" 2>/dev/null && mv "$tmp" "$result_file"
  rm -f "$tmp"
}

clear_cross_pr_guard_ready_evidence() {
  local state_dir="$1"
  local result_file="$state_dir/.ready-result.json"
  local tmp

  if [[ -f "$result_file" ]] && jq -e '.artifacts.crossPrGuard or .crossPrDiagnostic' "$result_file" >/dev/null 2>&1; then
    tmp=$(mktemp "$state_dir/.ready-result.XXXXXX") || tmp=""
    if [[ -n "$tmp" ]]; then
      jq 'del(.artifacts.crossPrGuard, .crossPrDiagnostic)' "$result_file" > "$tmp" 2>/dev/null && mv "$tmp" "$result_file"
      rm -f "$tmp"
    fi
  fi

  local attention_reason="" attention_marker="$state_dir/.needs-attention"
  attention_reason="$(marker_reason "$state_dir/.needs-attention" 2>/dev/null || true)"
  if [[ -n "$attention_reason" ]] \
    && { [[ "$attention_reason" == *'Cross-PR revert guard'* ]] \
      || [[ "$attention_reason" == *'without explicit acknowledgement'* ]]; } \
    && validate_ready_attention_marker "$state_dir" "ready_attention_reason_is_cross_pr_guard \"$attention_marker\""; then
    clear_ready_attention "$state_dir"
  fi
}

cross_pr_revert_gate_allows_merge() {
  local issue="$1" state_dir="$2" wt_dir="$3" pr_number="$4" base_branch="${5-}"
  local result rc prs files message stderr_file raw_error classification checked_head_sha
  local tool_stderr=""
  local extra_args=()
  raw_error=""
  checked_head_sha=$(git -C "$wt_dir" rev-parse HEAD 2>/dev/null || echo "")

  [[ -n "$base_branch" ]] && extra_args+=(--base-ref "$base_branch" --integration-ref "$base_branch")
  stderr_file=$(mktemp 2>/dev/null) || stderr_file=""

  if [[ -n "$stderr_file" ]]; then
    if result=$(cd "$wt_dir" && npx tsx "$TOOLS_DIR/check-cross-pr-reverts.ts" --repo-dir "$wt_dir" "${extra_args[@]}" 2>"$stderr_file"); then
      rc=0
    else
      rc=$?
    fi
    raw_error=$(cat "$stderr_file" 2>/dev/null || echo "")
    rm -f "$stderr_file"
  elif result=$(cd "$wt_dir" && npx tsx "$TOOLS_DIR/check-cross-pr-reverts.ts" --repo-dir "$wt_dir" "${extra_args[@]}" 2>/dev/null); then
    rc=0
  else
    rc=$?
  fi

  if [[ "$rc" -eq 0 ]]; then
    clear_cross_pr_guard_ready_evidence "$state_dir"
    return 0
  fi
  tool_stderr="$raw_error"

  if [[ "$rc" -eq 1 ]]; then
    prs=$(printf '%s' "$result" | jq -r '[.unacknowledged[]?.prNumber] | reduce .[] as $item ([]; if index($item) then . else . + [$item] end) | map("#" + tostring) | join(", ")' 2>/dev/null || echo "")
    files=$(printf '%s' "$result" | jq -r '[.unacknowledged[]?.files[]?.path] | reduce .[] as $item ([]; if index($item) then . else . + [$item] end) | join(", ")' 2>/dev/null || echo "")
    [[ -n "$prs" ]] || prs="a recently merged PR"
    message="PR #$pr_number removes files from $prs without explicit acknowledgement."
    if [[ -n "$files" ]]; then
      message="$message Affected files: $files."
    fi
    write_cross_pr_guard_ready_result "$state_dir" "$pr_number" "$checked_head_sha" "blocked" "$message" "$result"
    write_ready_attention_file "$state_dir" "$message"
    npx tsx "$TOOLS_DIR/ready-preflight-diagnostic.ts" \
      --state-dir "$state_dir" \
      --stage "cross-pr-guard" \
      --tool "check-cross-pr-reverts" \
      --classification "preflight-failure" \
      --reason "$message" \
      --raw-error "$raw_error" \
      --exit-code "$rc" >/dev/null 2>&1 || true
    log "status" "⛔ $issue → Cross-PR revert guard blocked ready phase for PR #$pr_number"
    return 1
  fi

  if [[ "$rc" -eq 2 ]] && printf '%s' "$result" | jq -e '.toolError' >/dev/null 2>&1; then
    local ref_name cmd_class diag_stderr
    ref_name=$(printf '%s' "$result" | jq -r '.toolError.ref // ""' 2>/dev/null || echo "")
    cmd_class=$(printf '%s' "$result" | jq -r '.toolError.commandClass // ""' 2>/dev/null || echo "")
    diag_stderr=$(printf '%s' "$result" | jq -r '.toolError.stderr // ""' 2>/dev/null || echo "")
    [[ -n "$diag_stderr" ]] || diag_stderr="${tool_stderr:0:2048}"
    [[ -z "$ref_name" && -n "$tool_stderr" ]] && ref_name="${tool_stderr:0:200}"
    [[ -z "$ref_name" ]] && ref_name="unknown ref"
    [[ -z "$cmd_class" ]] && cmd_class="unknown command"

    message="Cross-PR revert guard tool failure for PR #$pr_number: $cmd_class failed on ref '$ref_name'."
    if [[ -n "$diag_stderr" ]]; then
      message="$message Diagnostic: $diag_stderr"
    fi

    write_cross_pr_guard_ready_result "$state_dir" "$pr_number" "$checked_head_sha" "tool-error" "$message" "$result"
    write_ready_attention_file "$state_dir" "$message"
    _write_cross_pr_diagnostic "$state_dir" "$ref_name" "$cmd_class" "$diag_stderr"
    npx tsx "$TOOLS_DIR/ready-preflight-diagnostic.ts" \
      --state-dir "$state_dir" \
      --stage "cross-pr-guard" \
      --tool "check-cross-pr-reverts" \
      --classification "preflight-failure" \
      --reason "$message" \
      --raw-error "${diag_stderr:-$raw_error}" \
      --exit-code "$rc" >/dev/null 2>&1 || true
    log_error "  Cross-PR revert guard tool failure for $issue (PR #$pr_number): $cmd_class on '$ref_name'"
    return 1
  fi

  classification="preflight-failure"
  if [[ "$raw_error" == *"not a valid object name"* ]] || [[ "$raw_error" == *"bad revision"* ]] || [[ "$raw_error" == *"does not exist"* ]]; then
    classification="ref-missing"
  fi

  message="Cross-PR revert guard failed for PR #$pr_number."
  write_cross_pr_guard_ready_result "$state_dir" "$pr_number" "$checked_head_sha" "tool-error" "$message" "$result"
  write_ready_attention_file "$state_dir" "$message"
  npx tsx "$TOOLS_DIR/ready-preflight-diagnostic.ts" \
    --state-dir "$state_dir" \
    --stage "cross-pr-guard" \
    --tool "check-cross-pr-reverts" \
    --classification "$classification" \
    --reason "$message" \
    --raw-error "$raw_error" \
    --exit-code "$rc" >/dev/null 2>&1 || true
  log_error "  Cross-PR revert guard failed for $issue (PR #$pr_number)"
  return 1
}

transient_mergeability_count() {
  local state_dir="$1"
  local count_file="$state_dir/.transient-mergeability-count"

  if [[ ! -f "$count_file" ]]; then
    echo "0"
    return 0
  fi

  local count
  count=$(cat "$count_file" 2>/dev/null || echo "0")
  if [[ ! "$count" =~ ^[0-9]+$ ]]; then
    echo "0"
    return 0
  fi

  echo "$count"
}

increment_transient_mergeability_count() {
  local state_dir="$1"
  local count
  count=$(transient_mergeability_count "$state_dir")
  count=$((count + 1))
  mkdir -p "$state_dir"
  printf '%s\n' "$count" > "$state_dir/.transient-mergeability-count"
  echo "$count"
}

clear_transient_mergeability_state() {
  local state_dir="$1"
  rm -f \
    "$state_dir/.transient-mergeability-count" \
    "$state_dir/.needs-attention-transient"
}

write_transient_ready_attention_file() {
  local state_dir="$1" message="$2"
  write_ready_attention_file "$state_dir" "$message"
  local repo_dir
  repo_dir=$(git -C "$state_dir" rev-parse --show-toplevel 2>/dev/null) || return 0
  local head_sha
  head_sha=$(git -C "$repo_dir" rev-parse HEAD 2>/dev/null) || return 0
  marker_write "$state_dir/.needs-attention-transient" --kind ready-attention-transient --head "$head_sha" --reason "$message"
}

clear_ready_attention() {
  local state_dir="$1"
  marker_clear "$state_dir/.needs-attention"
}

validate_ready_attention_marker() {
  local state_dir="$1" condition_cmd="${2:-true}"
  local marker_path="$state_dir/.needs-attention"
  [[ -f "$marker_path" ]] || return 3

  local repo_dir head_sha rc
  repo_dir=$(git -C "$state_dir" rev-parse --show-toplevel 2>/dev/null) || return 3
  head_sha=$(git -C "$repo_dir" rev-parse HEAD 2>/dev/null) || return 3

  if marker_validate "$marker_path" "$head_sha" "$condition_cmd"; then
    return 0
  fi
  rc=$?
  if [[ "$rc" -eq 1 || "$rc" -eq 2 ]]; then
    marker_emit_finding "$marker_path" "ready attention" "$repo_dir"
    clear_ready_attention "$state_dir"
  fi
  return "$rc"
}

ready_attention_reason_is_cross_pr_guard() {
  local marker_path="$1" reason
  reason="$(marker_reason "$marker_path" 2>/dev/null || true)"
  [[ "$reason" == *'Cross-PR revert guard'* || "$reason" == *'without explicit acknowledgement'* ]]
}

validate_watchdog_stable_failure_marker() {
  local state_dir="$1" verdict="${2:-}"
  local marker_path="$state_dir/.ready-watchdog-stable-failure.json"
  [[ -f "$marker_path" ]] || return 3

  local repo_dir head_sha rc
  repo_dir=$(git -C "$state_dir" rev-parse --show-toplevel 2>/dev/null) || return 3
  head_sha=$(git -C "$repo_dir" rev-parse HEAD 2>/dev/null) || return 3

  if marker_validate "$marker_path" "$head_sha" '[[ "$verdict" == "fail" ]]'; then
    return 0
  fi
  rc=$?
  if [[ "$rc" -eq 1 || "$rc" -eq 2 ]]; then
    marker_emit_finding "$marker_path" "watchdog stable failure" "$repo_dir"
    marker_clear "$marker_path"
  fi
  return "$rc"
}

# --- Failed-ready re-check budget (HOK-2893) ---------------------------------
# The monitor re-launches ready checks whenever the stored status is `failed`.
# These helpers bound that loop as thin wrappers around the shared
# bounded-retry module (HOK-2924, bucket `failed-ready-recheck`), plus the
# path-specific identical-failure-reason short-circuit. The bucket keeps its
# pre-HOK-2924 file names (.failed-ready-recheck-*) so in-flight state
# survives an upgrade. A new head SHA (fresh commit) or a ready pass wipes
# the budget. Only mark_failed_ready_recheck_exhausted and
# failed_ready_recheck_due use their exit status as a signal, and both are
# always called behind `if`.

# Legacy env overrides (READY_FAILED_RECHECK_BACKOFF*) predate the shared
# helper and stay authoritative for this bucket; they are resolved inline in
# each wrapper (the launch-ready-phase test extracts these functions one by
# one, so wrappers must be self-contained). Non-numeric values fall back to
# the shipped defaults.

failed_ready_recheck_count() {
  bounded_retry_count "$1" "failed-ready-recheck"
}

clear_failed_ready_recheck_state() {
  bounded_retry_clear "$1" "failed-ready-recheck"
}

failed_ready_recheck_reset_if_new_head() {
  bounded_retry_reset_if_new_head "$1" "failed-ready-recheck" "$2"
}

increment_failed_ready_recheck_count() {
  bounded_retry_increment "$1" "failed-ready-recheck" "$2"
}

# Delay before attempt (count+1): min(base * 2^(count-1), cap).
failed_ready_recheck_backoff_seconds() {
  local base="${READY_FAILED_RECHECK_BACKOFF_SECONDS:-120}"
  local cap="${READY_FAILED_RECHECK_BACKOFF_CAP_SECONDS:-1800}"
  [[ "$base" =~ ^[0-9]+$ ]] || base=120
  [[ "$cap" =~ ^[0-9]+$ ]] || cap=1800
  bounded_retry_backoff_seconds "$1" "$base" "$cap"
}

failed_ready_recheck_due() {
  local base="${READY_FAILED_RECHECK_BACKOFF_SECONDS:-120}"
  local cap="${READY_FAILED_RECHECK_BACKOFF_CAP_SECONDS:-1800}"
  [[ "$base" =~ ^[0-9]+$ ]] || base=120
  [[ "$cap" =~ ^[0-9]+$ ]] || cap=1800
  bounded_retry_due "$1" "failed-ready-recheck" "$base" "$cap"
}

ready_failure_reason() {
  local state_dir="$1"
  local result_file="$state_dir/.ready-result.json"

  [[ -f "$result_file" ]] || { echo ""; return 0; }
  jq -r '.failureReason // .notes // empty' "$result_file" 2>/dev/null || echo ""
}

# Record what the last failed launch actually observed. Only a fresh verdict
# (a new finishedAt in .ready-result.json) counts as evidence — a launch that
# died before writing a result (review-gate refusal, unparseable output) must
# not feed the identical-reason streak, or infra flakes would be classified
# as deterministic. Byte-identical consecutive reasons grow the streak; a
# different (or empty) reason resets it to 1.
record_failed_ready_recheck_observation() {
  local state_dir="$1"
  local result_file="$state_dir/.ready-result.json"
  local reason_file="$state_dir/.failed-ready-recheck-reason.json"
  local finished_at reason prev_finished_at prev_reason streak tmp

  [[ -f "$result_file" ]] || return 0
  finished_at=$(jq -r '.finishedAt // empty' "$result_file" 2>/dev/null || echo "")
  [[ -n "$finished_at" ]] || return 0

  prev_finished_at=""
  prev_reason=""
  streak=0
  if [[ -f "$reason_file" ]]; then
    prev_finished_at=$(jq -r '.finishedAt // empty' "$reason_file" 2>/dev/null || echo "")
    prev_reason=$(jq -r '.reason // empty' "$reason_file" 2>/dev/null || echo "")
    streak=$(jq -r '.streak // 0' "$reason_file" 2>/dev/null || echo "0")
    [[ "$streak" =~ ^[0-9]+$ ]] || streak=0
  fi

  [[ "$finished_at" != "$prev_finished_at" ]] || return 0

  reason=$(ready_failure_reason "$state_dir")
  if [[ -n "$reason" && "$reason" == "$prev_reason" ]]; then
    streak=$((streak + 1))
  else
    streak=1
  fi

  mkdir -p "$state_dir"
  tmp=$(mktemp "$state_dir/.failed-ready-recheck-reason.XXXXXX") || return 0
  if jq -cn \
      --arg finishedAt "$finished_at" \
      --arg reason "$reason" \
      --argjson streak "$streak" \
      '{finishedAt: $finishedAt, reason: $reason, streak: $streak}' > "$tmp" 2>/dev/null; then
    mv "$tmp" "$reason_file"
  fi
  rm -f "$tmp"
  return 0
}

failed_ready_recheck_identical_streak() {
  local state_dir="$1"
  local reason_file="$state_dir/.failed-ready-recheck-reason.json"
  local streak

  [[ -f "$reason_file" ]] || { echo "0"; return 0; }
  streak=$(jq -r '.streak // 0' "$reason_file" 2>/dev/null || echo "0")
  [[ "$streak" =~ ^[0-9]+$ ]] || streak=0
  echo "$streak"
}

# One-shot terminalization. Returns 0 on the first-time transition (caller
# emits the status line) and 1 when the sentinel already exists. Annotates
# .ready-result.json so the stall names its own gate for the observer,
# watchdog, and eval consumers; a missing result file skips annotation.
mark_failed_ready_recheck_exhausted() {
  local issue="$1" pr_number="$2" state_dir="$3"
  local result_file="$state_dir/.ready-result.json"
  local attempts reason tmp

  attempts=$(failed_ready_recheck_count "$state_dir")
  reason=$(ready_failure_reason "$state_dir")
  [[ -n "$reason" ]] || reason="ready checks failed"

  if ! bounded_retry_mark_exhausted "$state_dir" "failed-ready-recheck" \
      "Failed-ready re-checks exhausted after ${attempts} attempt(s) for PR #$pr_number: $reason"; then
    return 1
  fi

  if [[ -f "$result_file" ]]; then
    tmp=$(mktemp "$state_dir/.ready-result.XXXXXX") || tmp=""
    if [[ -n "$tmp" ]]; then
      if jq -c \
          --argjson attempts "$attempts" \
          --arg reason "$reason" \
          '.artifacts.failedReadyRecheck = {attempts: $attempts, exhausted: true, lastReason: $reason}
           | .failureReason //= $reason' \
          "$result_file" > "$tmp" 2>/dev/null; then
        mv "$tmp" "$result_file"
      fi
      rm -f "$tmp"
    fi
  fi

  write_ready_attention_file "$state_dir" \
    "Failed-ready re-checks exhausted after ${attempts} attempt(s) for PR #$pr_number: $reason"
  log_error "  Failed-ready re-checks exhausted for $issue after ${attempts} attempt(s) (PR #$pr_number): $reason"
  return 0
}

# The composed decision for the failed-status poll site. Echoes exactly one of:
#   proceed         — launch a re-check now (caller increments the counter)
#   backoff         — a retry is scheduled but its delay has not elapsed
#   exhausted       — budget spent (or reason provably deterministic); caller
#                     terminalizes via mark_failed_ready_recheck_exhausted
#   exhausted-quiet — already terminalized; hold silently until a new commit
failed_ready_recheck_gate() {
  local state_dir="$1" current_head="$2"
  local disposition limit streak identical_limit base cap

  limit="${READY_FAILED_RECHECK_MAX_ATTEMPTS:-4}"
  [[ "$limit" =~ ^[0-9]+$ ]] || limit=4
  base="${READY_FAILED_RECHECK_BACKOFF_SECONDS:-120}"
  cap="${READY_FAILED_RECHECK_BACKOFF_CAP_SECONDS:-1800}"
  [[ "$base" =~ ^[0-9]+$ ]] || base=120
  [[ "$cap" =~ ^[0-9]+$ ]] || cap=1800
  disposition=$(bounded_retry_gate "$state_dir" "failed-ready-recheck" "$current_head" "$limit" "$base" "$cap")

  # Path-specific short-circuit: a provably deterministic failure (identical
  # verdicts N times in a row) terminalizes even while a backoff window is
  # still open — retrying cannot change the outcome.
  if [[ "$disposition" == "proceed" || "$disposition" == "backoff" ]]; then
    identical_limit="${READY_FAILED_RECHECK_IDENTICAL_LIMIT:-3}"
    [[ "$identical_limit" =~ ^[0-9]+$ ]] || identical_limit=3
    streak=$(failed_ready_recheck_identical_streak "$state_dir")
    if (( identical_limit > 0 && streak >= identical_limit )); then
      echo "exhausted"
      return 0
    fi
  fi

  echo "$disposition"
}
# --- end failed-ready re-check budget ----------------------------------------

log_ready_failure_result() {
  local issue="$1"
  local result="${2-}"
  local summary debug_file

  summary="$(summarize_ready_result "$result")"
  debug_file="$(ready_debug_log_file)"

  log_error "  Ready checks failed for $issue - $summary"
  if [[ -n "$result" ]]; then
    log_error "  Full ready result: $debug_file"
    log_debug_json "ready" "$result"
  fi
}

log_ready_unparseable_result() {
  local issue="$1"
  local result="${2-}"
  local debug_file

  debug_file="$(ready_debug_log_file)"
  log_error "  Ready checks produced unparseable output for $issue"
  if [[ -n "$result" ]]; then
    log_error "  Full ready result: $debug_file"
    log_debug_json "ready" "$result"
  fi
}

ready_failure_is_actionable_for_remediation() {
  local state_dir="${1-}"
  local verdict="${2-}"
  local failed_check_names="${3-}"
  local ready_result="${4-}"
  local actionable_names failed_check_name failed_check_name_lc
  local IFS=','

  if validate_watchdog_stable_failure_marker "$state_dir" "$verdict"; then
    return 0
  fi

  [[ "$verdict" == "fail" ]] || return 1
  [[ -n "$failed_check_names" ]] || return 1

  actionable_names=",ci-status,test,tests,unit,unit-test,unit-tests,shell,shell-test,shell-tests,lint,typecheck,type-check,build,ci,"
  for failed_check_name in $failed_check_names; do
    failed_check_name_lc="${failed_check_name,,}"
    if [[ "$actionable_names" == *",$failed_check_name_lc,"* ]]; then
      return 0
    fi
  done

  if printf '%s' "$ready_result" | jq -e '
    ["test", "tests", "unit", "unit-tests", "shell", "shell-tests", "lint", "typecheck", "type-check", "build"] as $terms
    | [
        .checks[]?
        | select(.status == "fail")
        | (
            (.name // "") + " "
            + (.message // "") + " "
            + ((.details.failedChecks // []) | map(.name // "") | join(" "))
          )
        | ascii_downcase
      ] as $failed_text
    | any($failed_text[]; . as $text | any($terms[]; . as $term | ($text | contains($term))))
  ' >/dev/null 2>&1; then
    return 0
  fi

  return 1
}

ready_failed_check_summary() {
  local ready_result="${1-}"

  printf '%s' "$ready_result" | jq -r '
    [
      .checks[]?
      | select(.status == "fail")
      | if .name == "ci-status" then
          "ci-status: " + (.message // "CI checks failing")
          + (if ((.details.failedChecks // []) | length) > 0
              then " (" + ((.details.failedChecks // []) | map(.name // "unknown") | join(", ")) + ")"
              else ""
            end)
        else
          (.name // "unknown") + ": " + (.message // "check failed")
        end
    ]
    | join("; ")
  ' 2>/dev/null
}

# Readiness rule shared with shared/lib/stage-result.ts reviewOutcomePassesReadyGate
# (HOK-2932). Passes on zero *effective* blockers: either the legacy shape
# (exit 0, ready, zero raw blockers) or every raw blocker auditably dismissed
# with a non-blank justification. Malformed dismissals or count mismatches fail
# closed — the raw count is never reduced by an unexplained number.
review_result_passes_ready_gate() {
  local feature_dir="$1"
  local review_file="$feature_dir/.review-result.json"
  [[ -f "$review_file" ]] || return 1

  jq -e '
    def valid_dismissal_count:
      (.dismissedBlockers // []) as $d
      | if ($d | type) != "array" then -1
        elif ([$d[] | select(
            (type == "object") and
            ((.justification? | type) == "string") and
            (.justification | test("\\S"))
          )] | length) != ($d | length) then -1
        else ($d | length)
        end;

    (.status == "completed") and (
      .artifacts as $artifacts
      | if ($artifacts.type // "") == "review" then
          $artifacts
        else
          ($artifacts.review // {})
        end
      | (.iterations as $iterations | (($iterations | type) == "number" and $iterations >= 1)) and
        (((.blockerCount // .blockingIssues // .blockingCount) // null) as $raw
          | (($raw | type) == "number") and
            (valid_dismissal_count as $dismissed
              | (
                  (.exitCode == 0) and (.verdict == "ready") and
                  (($raw == 0) or ($dismissed == $raw))
                ) or (
                  (.exitCode == 1) and (.verdict == "not_ready") and
                  ($raw >= 1) and ($dismissed == $raw)
                )
            )
        )
    )
  ' "$review_file" >/dev/null 2>&1
}

review_result_has_final_evidence() {
  local feature_dir="$1"
  local review_file="$feature_dir/.review-result.json"
  [[ -f "$review_file" ]] || return 1

  jq -e '
    (.artifacts // {}) as $artifacts
    | (if ($artifacts.type // "") == "review" then $artifacts else ($artifacts.review // {}) end) as $review
    | (($review.exitCode | type) == "number") and
      (($review.verdict | type) == "string" and ($review.verdict | length) > 0) and
      (($review.iterations | type) == "number" and $review.iterations >= 1) and
      (((($review.blockerCount // $review.blockingIssues // $review.blockingCount) // null) | type) == "number")
  ' "$review_file" >/dev/null 2>&1
}

review_result_missing_final_evidence() {
  local feature_dir="$1"
  local review_file="$feature_dir/.review-result.json"
  [[ -f "$review_file" ]] || return 0

  review_result_has_final_evidence "$feature_dir" && return 1

  jq -e '
    (.status == "completed" or .status == "running") and (
      (.artifacts // {}) as $artifacts
      | (if ($artifacts.type // "") == "review" then $artifacts else ($artifacts.review // {}) end) as $review
      | (($review.verdict // "") != "not_ready")
    )
  ' "$review_file" >/dev/null 2>&1
}

review_result_infra_failure() {
  local feature_dir="$1"
  local review_file="$feature_dir/.review-result.json"
  [[ -f "$review_file" ]] || return 0

  if review_result_missing_final_evidence "$feature_dir"; then
    return 0
  fi

  jq -e '
    (.artifacts // {}) as $artifacts
    | (if ($artifacts.type // "") == "review" then $artifacts else ($artifacts.review // {}) end) as $review
    | (
      (($review.failureCategory // "") == "native-runtime-unavailable") or
      (($review.failureCategory // "") == "native-review-prompt-missing") or
      (($review.failureCategory // "") == "review-scope-unverifiable") or
      ((($review.verdict // "") == "error") and ((($review.reviewToolError // "") | tostring | length) > 0))
    )
  ' "$review_file" >/dev/null 2>&1
}

review_infra_retry_count() {
  local state_dir="$1"
  local count_file="$state_dir/.review-infra-retries"
  if [[ -f "$count_file" ]] && [[ "$(cat "$count_file" 2>/dev/null || echo "")" =~ ^[0-9]+$ ]]; then
    cat "$count_file"
    return 0
  fi
  echo "0"
}

increment_review_infra_retry_count() {
  local state_dir="$1"
  local count
  count=$(review_infra_retry_count "$state_dir")
  count=$((count + 1))
  mkdir -p "$state_dir"
  printf '%s\n' "$count" > "$state_dir/.review-infra-retries"
  echo "$count"
}

clear_review_infra_retry_state() {
  local state_dir="$1"
  rm -f "$state_dir/.review-infra-retries"
}

relaunch_review_after_infra_recovery() {
  local issue="$1" slug="$2" title="$3" wt_dir="$4" branch="$5" base_branch="$6" pr_number="$7" state_dir="$8"
  local review_file="$state_dir/.review-result.json"
  local retry_count retry_max reviewer_agent reviewer_model review_mode contract_payload retry_number rc=0

  retry_count=$(review_infra_retry_count "$state_dir")
  retry_max="${WAVEMILL_REVIEW_INFRA_RETRY_MAX:-2}"
  [[ "$retry_max" =~ ^[0-9]+$ ]] || retry_max=2
  if (( retry_count >= retry_max )); then
    write_ready_attention_file "$state_dir" "Review failed on infrastructure ${retry_count}/${retry_max} times for PR #$pr_number, manual re-review required."
    log_error "  $issue: review infrastructure retry cap reached for PR #$pr_number (${retry_count}/${retry_max})"
    return 1
  fi

  reviewer_agent="$(jq -r '.agent // empty' "$review_file" 2>/dev/null || echo "")"
  reviewer_model="$(jq -r '.model // empty' "$review_file" 2>/dev/null || echo "")"
  [[ -n "$reviewer_agent" ]] || reviewer_agent="$(read_state_value "" --arg i "$issue" '.tasks[$i].agent // ""')"
  [[ -n "$reviewer_agent" ]] || reviewer_agent="$AGENT_CMD"
  [[ -n "$reviewer_model" ]] || reviewer_model="$(read_state_value "" --arg i "$issue" '.tasks[$i].model // ""')"

  if ! agent_validate_phase_launch "$reviewer_agent" "review" "$reviewer_model" "$REPO_DIR"; then
    write_ready_attention_file "$state_dir" "Review infrastructure is still unavailable for PR #$pr_number; waiting for reviewer runtime recovery."
    log_error "  $issue: waiting for reviewer runtime recovery before re-reviewing PR #$pr_number"
    return 1
  fi

  retry_number=$(increment_review_infra_retry_count "$state_dir")
  review_mode="static"
  if declare -F read_phase_config >/dev/null 2>&1; then
    review_mode=$(read_phase_config "$state_dir" "review" "mode")
    [[ -n "$review_mode" ]] || review_mode="static"
  fi
  contract_payload="$(jq -cn --arg agent "$reviewer_agent" --arg model "$reviewer_model" '{stageRole:"review",agent:$agent,model:$model}')"

  if ! _prepare_recovery_phase_launch "$issue" "$slug" "review" "$state_dir" "$wt_dir" "$reviewer_agent" "$reviewer_model" "$contract_payload" "review"; then
    write_ready_attention_file "$state_dir" "Could not prepare infrastructure re-review for PR #$pr_number."
    return 1
  fi

  launch_review_phase "$issue" "$slug" "$title" "$wt_dir" "$branch" "$base_branch" \
    "$reviewer_model" "$reviewer_agent" "$review_mode" || rc=$?
  if [[ "$rc" -eq 0 ]]; then
    marker_clear "$state_dir/.needs-attention"
    log "status" "♻ $issue → review relaunched after infrastructure recovery (attempt ${retry_number}/${retry_max})"
    return 6
  fi
  if [[ "$rc" -eq 2 ]] && check_stage_aborted "$state_dir"; then
    return 2
  fi
  write_ready_attention_file "$state_dir" "Could not relaunch infrastructure re-review for PR #$pr_number (rc=$rc)."
  return 1
}

review_result_summary() {
  local feature_dir="$1"
  local review_file="$feature_dir/.review-result.json"
  if [[ ! -f "$review_file" ]]; then
    printf '%s\n' "status=missing, verdictState=no-verdict-recorded"
    return 0
  fi

  jq -r '
    def valid_dismissal_count:
      (.dismissedBlockers // []) as $d
      | if ($d | type) != "array" then -1
        elif ([$d[] | select(
            (type == "object") and
            ((.justification? | type) == "string") and
            (.justification | test("\\S"))
          )] | length) != ($d | length) then -1
        else ($d | length)
        end;

    . as $root
    | (.artifacts // {}) as $artifacts
    | (if ($artifacts.type // "") == "review" then $artifacts else ($artifacts.review // {}) end) as $review
    | ((($review.blockerCount // $review.blockingIssues // $review.blockingCount) // null)) as $raw
    | ($review | valid_dismissal_count) as $dismissed
      | [
        "status=" + ($root.status // "unknown"),
        "verdictState=" + (
          if (
            (($review.exitCode | type) == "number") and
            (($review.verdict | type) == "string" and ($review.verdict | length) > 0) and
            (($review.iterations | type) == "number" and $review.iterations >= 1) and
            (($raw | type) == "number")
          ) then
            if (
              ($root.status == "completed") and
              (
                (
                  ($review.exitCode == 0) and ($review.verdict == "ready") and
                  (($raw == 0) or ($dismissed == $raw))
                ) or (
                  ($review.exitCode == 1) and ($review.verdict == "not_ready") and
                  ($raw >= 1) and ($dismissed == $raw)
                )
              )
            ) then "passed" else "failed" end
          else
            "no-verdict-recorded"
          end
        ),
        "exitCode=" + (($review.exitCode // "missing") | tostring),
        "verdict=" + (($review.verdict // "missing") | tostring),
        "iterations=" + (($review.iterations // "missing") | tostring),
        "blockers=" + (($raw // "missing") | tostring),
        (if (($review.dismissedBlockers // []) | length) > 0 then
          "dismissedBlockers=" + (($review.dismissedBlockers | length) | tostring)
          + ", effectiveBlockers=" + (
              if (($raw | type) == "number") and ($dismissed >= 0) and ($dismissed <= $raw)
              then (($raw - $dismissed) | tostring)
              else ($raw | tostring)
              end
            )
        else empty end),
        (if ($review.failureCategory // "") != "" then "failureCategory=" + ($review.failureCategory | tostring) else empty end),
        (if ($review.reviewToolError // "") != "" then "error=" + ($review.reviewToolError | tostring) else empty end)
      ]
      | join(", ")
  ' "$review_file" 2>/dev/null || printf '%s\n' "review result unreadable"
}

review_artifacts_with_pr_number() {
  local feature_dir="$1" pr_number="$2"
  local review_file="$feature_dir/.review-result.json"

  if [[ -f "$review_file" ]]; then
    jq -c --argjson pr_number "$pr_number" '
      (.artifacts // {type:"review"}) as $artifacts
      | if (($artifacts | type) != "object") then
          {type:"review", prNumber:$pr_number, missingReviewEvidence:true, evidence:"missing-review-verdict"}
        elif (($artifacts.type // "") == "review") then
          ($artifacts + {type:"review", prNumber:$pr_number}) as $review
          | if (
              (($review.exitCode | type) == "number") and
              (($review.verdict | type) == "string" and ($review.verdict | length) > 0) and
              (($review.iterations | type) == "number" and $review.iterations >= 1) and
              (((($review.blockerCount // $review.blockingIssues // $review.blockingCount) // null) | type) == "number")
            ) then
              $review
            else
              $review + {missingReviewEvidence:true, evidence:($review.evidence // "missing-review-verdict")}
            end
        else
          (($artifacts.review // {}) + {prNumber:$pr_number}) as $review
          | $artifacts + {
              review: (
                if (
                  (($review.exitCode | type) == "number") and
                  (($review.verdict | type) == "string" and ($review.verdict | length) > 0) and
                  (($review.iterations | type) == "number" and $review.iterations >= 1) and
                  (((($review.blockerCount // $review.blockingIssues // $review.blockingCount) // null) | type) == "number")
                ) then
                  $review
                else
                  $review + {missingReviewEvidence:true, evidence:($review.evidence // "missing-review-verdict")}
                end
              )
            }
        end
    ' "$review_file" 2>/dev/null && return 0
  fi

  jq -cn --argjson pr_number "$pr_number" \
    '{type:"review", prNumber:$pr_number, missingReviewEvidence:true, evidence:"missing-review-result"}'
}

record_review_pr_reconciliation() {
  local feature_dir="$1" pr_number="$2" current_agent="${3:-}" model="${4:-}"
  local artifacts_json
  artifacts_json="$(review_artifacts_with_pr_number "$feature_dir" "$pr_number")"

  if review_result_has_final_evidence "$feature_dir"; then
    write_stage_result "$feature_dir" "review" "completed" "$current_agent" "$model" "PR #$pr_number" "$artifacts_json"
    return 0
  fi

  write_stage_result "$feature_dir" "review" "running" "$current_agent" "$model" \
    "PR #$pr_number exists, but no review verdict is recorded; re-review required" "$artifacts_json"
  return 1
}

clear_review_gate_attention() {
  local feature_dir="$1" marker_path reason
  marker_path="$feature_dir/.needs-attention"
  [[ -f "$marker_path" ]] || return 0
  reason="$(marker_reason "$marker_path" 2>/dev/null || true)"
  case "$reason" in
    Review\ verdict\ does\ not\ pass\ readiness\ gate*|\
    Review\ recorded\ no\ verdict*|\
    *missing\ review\ verdict*)
      marker_clear "$marker_path"
      ;;
  esac
}

launch_review_for_missing_evidence() {
  local issue="$1" slug="$2" title="$3" wt_dir="$4" branch="$5" base_branch="$6" feature_dir="$7" current_agent="${8:-}"
  local reviewer_agent reviewer_model review_mode rc=0

  reviewer_agent="$(read_phase_config "$feature_dir" "review" "agent" 2>/dev/null || true)"
  [[ -n "$reviewer_agent" ]] || reviewer_agent="$(read_state_value "" --arg i "$issue" '.tasks[$i].reviewerAgent // .tasks[$i].agent // ""')"
  [[ -n "$reviewer_agent" ]] || reviewer_agent="${current_agent:-$AGENT_CMD}"

  reviewer_model="$(read_phase_config "$feature_dir" "review" "model" 2>/dev/null || true)"
  [[ -n "$reviewer_model" ]] || reviewer_model="$(read_state_value "" --arg i "$issue" '.tasks[$i].reviewerModel // .tasks[$i].model // ""')"
  reviewer_model="$(resolve_phase_model "review" "$reviewer_model" "claude-sonnet-5")"

  review_mode="$(read_phase_config "$feature_dir" "review" "mode" 2>/dev/null || true)"
  [[ -n "$review_mode" ]] || review_mode="static"

  clear_review_gate_attention "$feature_dir"
  launch_review_phase "$issue" "$slug" "$title" "$wt_dir" "$branch" "$base_branch" "$reviewer_model" "$reviewer_agent" "$review_mode" || rc=$?
  return "$rc"
}

strip_ready_label_if_review_not_passed() {
  local wt_dir="$1" pr_number="$2" feature_dir="$3"
  review_result_passes_ready_gate "$feature_dir" && return 0

  (cd "$wt_dir" && gh pr edit "$pr_number" --remove-label "wm:ready") >/dev/null 2>&1 || true
  return 1
}

set_ready_pass_labels() {
  local wt_dir="$1"
  local pr_number="$2"
  local feature_dir="${3:-}"

  if [[ -z "$feature_dir" ]]; then
    feature_dir="$wt_dir/features/$(basename "$wt_dir")"
  fi

  review_result_passes_ready_gate "$feature_dir" || return 1

  (cd "$wt_dir" && npx tsx "$TOOLS_DIR/set-pr-ready-label.ts" "$pr_number" --marker-root "$REPO_DIR")
}

_launch_ready_remediation_attempt() {
  local issue="$1" slug="$2" wt_dir="$3" branch="$4" base_branch="$5" pr_number="$6"
  local state_dir="$7" win="$8" status_file="$9" current_agent="${10}" current_model="${11}"
  local current_head="${12}" checks_run="${13}" checks_passed="${14}" merge_status="${15}"
  local remediation_attempt_number="${16}" remediation_max_attempts="${17}"
  local failed_check_names_json="${18}" failed_check_summary="${19}" ready_result_file="${20}"
  local remediation_agent prompt_file launch_rc remediation_artifacts_json remediation_failed_artifacts_json
  local resolved_model recon_enabled recon_incident_out recon_fingerprint recon_checks_json

  # Post-PR reconciliation capsule gate (HOK-2936): update the incident and
  # validate the capsule before consuming any retry budget. An invalid capsule
  # refuses the launch with a typed needs-user reason (REQ-F4).
  # REQ-F3: Gate launch based on classification — only launch for deterministic/conflict
  # failures; skip costly LLM for transient and stale-base issues.
  recon_enabled=$(post_pr_reconciliation_enabled "$wt_dir")
  if [[ "$recon_enabled" == "true" ]]; then
    local recon_classification
    recon_classification=$(classify_for_reconciliation "$merge_status" "$failed_check_summary" "$checks_run" "$checks_passed")

    if [[ "$recon_classification" == "stale_base_clean" || "$recon_classification" == "ci_transient" ]]; then
      log "status" "  ⏭ Skipping LLM remediation for $recon_classification failure on PR #$pr_number (REQ-F3)"
      return 0
    fi

    recon_checks_json=$(jq -c 'map({name: .})' <<< "$failed_check_names_json" 2>/dev/null || echo '[]')
    recon_incident_out=$(npx tsx "$TOOLS_DIR/reconciliation-capsule.ts" update-incident \
      --feature-dir "$state_dir" \
      --classification "$recon_classification" \
      ${current_head:+--head "$current_head"} \
      --detail "Ready-check failure on PR #$pr_number: $failed_check_summary" \
      --failing-checks-json "$recon_checks_json" \
      2>/dev/null) || {
      write_ready_attention_file "$state_dir" "Reconciliation capsule invalid ($(jq -r '.reason // "unknown"' <<< "$recon_incident_out" 2>/dev/null || echo "unknown")) for PR #$pr_number - refusing ready remediation launch."
      log_error "  $issue: reconciliation capsule unavailable - refusing ready remediation launch for PR #$pr_number"
      return 1
    }
    recon_fingerprint=$(jq -r '.failureFingerprint // empty' <<< "$recon_incident_out" 2>/dev/null || echo "")
    reconciliation_reset_retry_if_new_fingerprint "$state_dir" "ready-remediation" "$recon_fingerprint"
  fi

  # Bounded-retry bucket (HOK-2924): every launch attempt counts, keyed to the
  # head it launched from; the JSON remediationAttempts mirror below stays for
  # dashboards and downstream tools.
  bounded_retry_increment "$state_dir" "ready-remediation" "$current_head" >/dev/null

  remediation_agent=$(ready_remediation_agent_cmd "$wt_dir")
  [[ -z "$remediation_agent" ]] && remediation_agent="$current_agent"
  [[ -z "$remediation_agent" ]] && remediation_agent="$AGENT_CMD"

  resolved_model="$current_model"
  [[ -z "$resolved_model" ]] && resolved_model=$(read_state_value "" --arg i "$issue" '.tasks[$i].coderModel // ""')
  [[ -z "$resolved_model" ]] && resolved_model=$(read_state_value "" --arg i "$issue" '.tasks[$i].reviewerModel // ""')
  [[ -z "$resolved_model" ]] && resolved_model=$(read_state_value "" --arg i "$issue" '.tasks[$i].plannerModel // ""')

  if [[ -z "$resolved_model" ]]; then
    local no_model_artifacts_json
    no_model_artifacts_json=$(merge_queue_enrich_ready_artifacts "$state_dir" \
      "{\"type\":\"ready\",\"verdict\":\"fail\",\"checksRun\":${checks_run:-0},\"checksPassed\":${checks_passed:-0},\"mergeConflict\":\"${merge_status:-UNKNOWN}\",\"prNumber\":${pr_number},\"remediationAttempts\":${remediation_attempt_number},\"remediationFailures\":${failed_check_names_json}}" \
      "candidate-progress")
    write_stage_result "$state_dir" "ready" "failed" "$current_agent" "$resolved_model" \
      "No model configured for ready remediation" \
      "$no_model_artifacts_json"
    write_ready_attention_file "$state_dir" "Ready remediation cannot proceed without a configured model for PR #$pr_number."
    log_error "  Failed to launch ready remediation agent for $issue (no model configured)"
    return 1
  fi

  prompt_file="/tmp/${SESSION}-${issue}-ready-remediation-prompt.txt"
  build_ready_remediation_prompt \
    "$pr_number" \
    "$branch" \
    "$wt_dir" \
    "$status_file" \
    "$base_branch" \
    "$remediation_attempt_number" \
    "$remediation_max_attempts" \
    "$failed_check_summary" \
    "$ready_result_file" > "$prompt_file"

  if [[ "$recon_enabled" == "true" ]]; then
    # Capsule projection first (stable foundation prefix, then the volatile
    # incident), followed by the narrow remediation process instructions.
    if ! reconciliation_project_prompt "$state_dir" "$pr_number" "$prompt_file.capsule"; then
      log_error "  $issue: reconciliation capsule projection failed - refusing ready remediation launch for PR #$pr_number"
      return 1
    fi
    cat "$prompt_file" >> "$prompt_file.capsule"
    mv "$prompt_file.capsule" "$prompt_file"
  fi

  _launch_agent_in_pane "$win" "$remediation_agent" "$resolved_model" "$prompt_file" "$slug" "$issue" "coding"
  launch_rc=$?

  if [[ "$launch_rc" -eq 0 ]]; then
    if [[ "$recon_enabled" == "true" ]]; then
      reconciliation_record_attempt "$state_dir" "$remediation_agent" "$resolved_model" "$current_head"
    fi
    remediation_artifacts_json=$(jq -cn \
      --arg merge_status "${merge_status:-UNKNOWN}" \
      --arg launch_head "$current_head" \
      --argjson pr_number "${pr_number}" \
      --argjson checks_run "${checks_run:-0}" \
      --argjson checks_passed "${checks_passed:-0}" \
      --argjson attempts "$remediation_attempt_number" \
      --argjson remediation_failures "$failed_check_names_json" \
      '{
        type: "ready",
        verdict: "fail",
        checksRun: $checks_run,
        checksPassed: $checks_passed,
        mergeConflict: $merge_status,
        prNumber: $pr_number,
        remediationAttempts: $attempts,
        remediationLaunchHead: $launch_head,
        remediationFailures: $remediation_failures
      }')
    remediation_artifacts_json=$(merge_queue_enrich_ready_artifacts "$state_dir" "$remediation_artifacts_json" "candidate-progress")
    write_stage_result "$state_dir" "ready" "running" "$remediation_agent" "$resolved_model" \
      "Ready remediation in progress for PR #$pr_number" \
      "$remediation_artifacts_json"
    marker_clear "$state_dir/.needs-attention"
    log "status" "⚙ $issue → Launched ready remediation (attempt ${remediation_attempt_number}/${remediation_max_attempts}) for PR #$pr_number"
    return 0
  fi

  if [[ "$launch_rc" -eq 2 ]] && check_stage_aborted "$state_dir"; then
    reconciliation_lease_release "$state_dir"
    set_task_task_owned "$issue" "active" || true
    return 2
  fi

  reconciliation_lease_release "$state_dir"
  set_task_task_owned "$issue" "active" || true
  remediation_failed_artifacts_json=$(merge_queue_enrich_ready_artifacts "$state_dir" \
    "{\"type\":\"ready\",\"verdict\":\"fail\",\"checksRun\":${checks_run:-0},\"checksPassed\":${checks_passed:-0},\"mergeConflict\":\"${merge_status:-UNKNOWN}\",\"prNumber\":${pr_number},\"remediationAttempts\":${remediation_attempt_number},\"remediationFailures\":${failed_check_names_json}}" \
    "candidate-progress")
  write_stage_result "$state_dir" "ready" "failed" "$current_agent" "$resolved_model" \
    "Could not launch ready remediation agent" \
    "$remediation_failed_artifacts_json"
  write_ready_attention_file "$state_dir" "Could not launch remediation agent for PR #$pr_number."
  log_error "  Failed to launch ready remediation agent for $issue"
  return 1
}

launch_ready_watchdog_remediation() {
  local issue="$1" slug="$2" wt_dir="$3" branch="$4" base_branch="$5" pr_number="$6"
  local failed_check_summary="$7" attempt_number="$8" max_attempts="$9" failed_check_names_json="${10}"
  local win state_dir status_file current_agent current_model current_head remediation_attempts remediation_launch_head
  local ready_status checks_run checks_passed merge_status ready_result_file helper_rc resolved_model

  : "${SESSION:=wavemill}"
  state_dir="$(ready_state_dir "$wt_dir" "$slug")"
  status_file="/tmp/${SESSION}-${issue}-status.txt"
  current_agent=$(read_state_value "" --arg i "$issue" '.tasks[$i].agent // ""')
  current_model=$(read_state_value "" --arg i "$issue" '.tasks[$i].model // ""')
  [[ -z "$current_agent" ]] && current_agent="$AGENT_CMD"

  resolved_model="$current_model"
  [[ -z "$resolved_model" ]] && resolved_model=$(read_state_value "" --arg i "$issue" '.tasks[$i].coderModel // ""')
  [[ -z "$resolved_model" ]] && resolved_model=$(read_state_value "" --arg i "$issue" '.tasks[$i].reviewerModel // ""')
  [[ -z "$resolved_model" ]] && resolved_model=$(read_state_value "" --arg i "$issue" '.tasks[$i].plannerModel // ""')

  current_head=$(git -C "$wt_dir" rev-parse HEAD 2>/dev/null || echo "")
  remediation_attempts=$(ready_remediation_attempts "$state_dir")
  remediation_launch_head=$(ready_remediation_launch_head "$state_dir")
  ready_status=$(read_stage_status "$state_dir" "ready")
  ready_result_file="$state_dir/.ready-result.json"
  checks_run=$(jq -r '.artifacts.checksRun // 0' "$ready_result_file" 2>/dev/null || echo "0")
  checks_passed=$(jq -r '.artifacts.checksPassed // 0' "$ready_result_file" 2>/dev/null || echo "0")
  merge_status=$(jq -r '.artifacts.mergeConflict // "UNKNOWN"' "$ready_result_file" 2>/dev/null || echo "UNKNOWN")

  if [[ "$ready_status" == "running" ]] && [[ -n "$remediation_launch_head" ]] && [[ "$remediation_launch_head" == "$current_head" ]]; then
    jq -cn --arg detail "Ready remediation is already running for PR #$pr_number at $current_head." --argjson attempt "$remediation_attempts" \
      '{status:"skipped-in-flight", detail:$detail, attemptNumber:$attempt}'
    return 0
  fi

  # Bounded-retry bucket shared with launch_ready_phase (HOK-2924): a fresh
  # commit restores the budget; the ceiling terminalizes with a recorded
  # reason; attempts inside the backoff window hold instead of relaunching.
  bounded_retry_reset_if_new_head "$state_dir" "ready-remediation" "$current_head"
  remediation_attempts=$(ready_remediation_attempts "$state_dir")

  if (( remediation_attempts >= max_attempts )); then
    bounded_retry_mark_exhausted "$state_dir" "ready-remediation" \
      "Ready remediation capped at ${remediation_attempts}/${max_attempts} attempts for PR #$pr_number: $failed_check_summary" || true
    jq -cn --arg detail "Ready remediation capped at ${remediation_attempts}/${max_attempts} attempts for PR #$pr_number." --argjson attempt "$remediation_attempts" \
      '{status:"skipped-max-attempts", detail:$detail, attemptNumber:$attempt}'
    return 0
  fi

  if ! bounded_retry_due "$state_dir" "ready-remediation"; then
    jq -cn --arg detail "Ready remediation backoff window open for PR #$pr_number - retry deferred." --argjson attempt "$remediation_attempts" \
      '{status:"skipped-backoff", detail:$detail, attemptNumber:$attempt}'
    return 0
  fi

  if ! win="$(ensure_ready_worker_window "$issue" "$slug" "$state_dir" "$wt_dir" "$pr_number" "$current_head")"; then
    jq -cn --arg detail "Ready remediation already has a reconciliation owner or could not acquire ownership for PR #$pr_number." \
      '{status:"skipped-lease-held", detail:$detail}'
    return 0
  fi

  _launch_ready_remediation_attempt \
    "$issue" "$slug" "$wt_dir" "$branch" "$base_branch" "$pr_number" \
    "$state_dir" "$win" "$status_file" "$current_agent" "$current_model" \
    "$current_head" "$checks_run" "$checks_passed" "$merge_status" \
    "$attempt_number" "$max_attempts" "$failed_check_names_json" "$failed_check_summary" "$ready_result_file"
  helper_rc=$?

  if [[ "$helper_rc" -eq 0 ]]; then
    jq -cn --arg detail "Launched ready remediation attempt ${attempt_number}/${max_attempts} for failing checks: $failed_check_summary." --arg head "$current_head" --argjson attempt "$attempt_number" \
      '{status:"launched", detail:$detail, attemptNumber:$attempt, launchHead:$head}'
    return 0
  fi

  jq -cn --arg detail "Failed to launch ready remediation attempt ${attempt_number}/${max_attempts} for PR #$pr_number." --argjson attempt "$attempt_number" \
    '{status:"failed", detail:$detail, attemptNumber:$attempt}'
  return 0
}

if [[ "${WAVEMILL_READY_WATCHDOG_SOURCE_ONLY:-}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi

launch_ready_phase() {
  local issue="$1" slug="$2" title="$3" wt_dir="$4" branch="$5" base_branch="$6"
  local pr_number="$7"
  local win
  local state_dir status_file result ready_rc merge_status verdict
  local current_agent current_model prompt_file launch_rc launch_head checks_run checks_passed
  local ready_head_sha ci_conclusion required_source required_contexts_json
  local remediation_attempts remediation_launch_head remediation_enabled remediation_max_attempts
  local remediation_agent failed_check_names failed_check_summary current_head ready_status
  local remediation_artifacts_json failed_check_names_json ready_result_file ready_stderr_file
  local prior_ready_status prior_ready_verdict pending_log_level

  win=""
  if [[ "$(get_task_pane_state "$issue")" != "released" ]]; then
    win="$(_ensure_task_window_exists "$SESSION" "$issue" "$slug" "$wt_dir")"
    persist_task_window_id "$issue" "$win"
  fi
  state_dir="$(ready_state_dir "$wt_dir" "$slug")"
  status_file="/tmp/${SESSION}-${issue}-status.txt"
  current_agent=$(read_state_value "" --arg i "$issue" '.tasks[$i].agent // ""')
  current_model=$(read_state_value "" --arg i "$issue" '.tasks[$i].model // ""')
  [[ -z "$current_agent" ]] && current_agent="$AGENT_CMD"
  if [[ -z "$current_model" ]]; then
    current_model=$(read_state_value "" --arg i "$issue" '.tasks[$i].coderModel // ""')
    [[ -z "$current_model" ]] && current_model=$(read_state_value "" --arg i "$issue" '.tasks[$i].reviewerModel // ""')
    [[ -z "$current_model" ]] && current_model=$(read_state_value "" --arg i "$issue" '.tasks[$i].plannerModel // ""')
  fi
  prior_ready_status=$(read_stage_status "$state_dir" "ready")
  prior_ready_verdict=$(ready_stage_pending_verdict "$state_dir")
  if [[ "$prior_ready_status" == "running" && "$prior_ready_verdict" == "pending" ]]; then
    pending_log_level="debug"
  else
    pending_log_level="info"
  fi

  # A reconciliation commit invalidates the prior review verdict (HOK-2936
  # REQ-F6): mark it stale against its recorded head and relaunch review
  # before any ready pass can restore wm:ready.
  if [[ "$(post_pr_reconciliation_enabled "$wt_dir")" == "true" ]] \
    && reconciliation_review_invalidated_by_commit "$state_dir" "$wt_dir" \
    && review_result_passes_ready_gate "$state_dir"; then
    local recon_old_head recon_new_head recon_review_rc=0
    recon_old_head=$(jq -r '.review.reviewHeadSha // empty' "$state_dir/.reconciliation-context.json" 2>/dev/null || echo "")
    recon_new_head=$(git -C "$wt_dir" rev-parse HEAD 2>/dev/null || echo "")
    reconciliation_mark_review_stale "$state_dir" "$pr_number" "$recon_old_head" "$recon_new_head" || true
    strip_ready_label_if_review_not_passed "$wt_dir" "$pr_number" "$state_dir" || true
    log "status" "  ♻ $issue: reconciliation commit ${recon_new_head:0:7} invalidates review at ${recon_old_head:0:7} - relaunching review for PR #$pr_number"
    launch_review_for_missing_evidence "$issue" "$slug" "$title" "$wt_dir" "$branch" "$base_branch" "$state_dir" "$current_agent" || recon_review_rc=$?
    if [[ "$recon_review_rc" -eq 0 ]]; then
      return 6
    fi
    if [[ "$recon_review_rc" -eq 2 ]] && check_stage_aborted "$state_dir"; then
      return 2
    fi
    write_ready_attention_file "$state_dir" "Review invalidated by reconciliation commit, but re-review could not be launched for PR #$pr_number."
    return 1
  fi

  if ! review_result_passes_ready_gate "$state_dir"; then
    local review_summary
    review_summary="$(review_result_summary "$state_dir")"
    if review_result_infra_failure "$state_dir"; then
      relaunch_review_after_infra_recovery "$issue" "$slug" "$title" "$wt_dir" "$branch" "$base_branch" "$pr_number" "$state_dir"
      return $?
    fi
    strip_ready_label_if_review_not_passed "$wt_dir" "$pr_number" "$state_dir" || true
    write_ready_attention_file "$state_dir" "Review verdict does not pass readiness gate for PR #$pr_number ($review_summary)."
    log_error "  $issue: refusing ready phase for PR #$pr_number; $review_summary"
    return 1
  fi

  if [[ "$(post_pr_reconciliation_enabled "$wt_dir")" == "true" ]]; then
    reconciliation_capsule_refresh "$state_dir" "$wt_dir" "$pr_number" "$branch" "$base_branch" "$issue" "$slug" "$title" || true
  fi

  clear_review_infra_retry_state "$state_dir"
  clear_challenger_transient_retry_state "$state_dir"
  marker_clear "$state_dir/.needs-attention"
  log "$pending_log_level" "  $issue: Launching ready phase (PR #$pr_number)"

  if ! cross_pr_revert_gate_allows_merge "$issue" "$state_dir" "$wt_dir" "$pr_number" "$base_branch"; then
    return 1
  fi

  ready_stderr_file=$(mktemp) || {
    log_warn "  Failed to capture ready stderr for $issue (mktemp failed)"
    ready_stderr_file=""
  }
  if [[ -n "$ready_stderr_file" ]]; then
    if result=$(cd "$wt_dir" && npx tsx "$TOOLS_DIR/ready.ts" "$pr_number" --state-dir "$state_dir" 2>"$ready_stderr_file"); then
      ready_rc=0
    else
      ready_rc=$?
    fi
    if [[ -s "$ready_stderr_file" ]]; then
      while IFS= read -r line; do
        if [[ "$ready_rc" -ne 0 ]]; then
          log_error "  [ready stderr] $line"
        else
          log "debug" "  [ready stderr] $line"
        fi
      done < "$ready_stderr_file"
    fi
    rm -f "$ready_stderr_file"
  else
    if result=$(cd "$wt_dir" && npx tsx "$TOOLS_DIR/ready.ts" "$pr_number" --state-dir "$state_dir" 2>/dev/null); then
      ready_rc=0
    else
      ready_rc=$?
    fi
  fi

  merge_status=$(printf '%s' "$result" | jq -r '.mergeConflict.status // empty' 2>/dev/null || echo "")
  verdict=$(printf '%s' "$result" | jq -r '.verdict // empty' 2>/dev/null || echo "")
  checks_run=$(printf '%s' "$result" | jq -r '.checks | if type == "array" then length else 0 end' 2>/dev/null || echo "0")
  checks_passed=$(printf '%s' "$result" | jq -r '[.checks[]? | select(.status == "pass")] | length' 2>/dev/null || echo "0")
  ready_head_sha=$(printf '%s' "$result" | jq -r '.headSha // empty' 2>/dev/null || echo "")
  ci_conclusion=$(printf '%s' "$result" | jq -r '.ciConclusion // empty' 2>/dev/null || echo "")
  required_source=$(printf '%s' "$result" | jq -r '.checks[]? | select(.name == "ci-status") | .details.requiredSource // empty' 2>/dev/null | head -n 1 || echo "")
  required_contexts_json=$(printf '%s' "$result" | jq -c '[.checks[]? | select(.name == "ci-status") | .details.requiredContexts[]?] | unique' 2>/dev/null || echo '[]')
  remediation_attempts=$(ready_remediation_attempts "$state_dir")
  remediation_launch_head=$(ready_remediation_launch_head "$state_dir")
  ready_status=$(read_stage_status "$state_dir" "ready")
  ready_result_file="$state_dir/.ready-result.json"

  if [[ -z "$merge_status" ]]; then
    log_ready_unparseable_result "$issue" "$result"
    write_ready_attention_file "$state_dir" "Ready stage produced invalid output for PR #$pr_number."
    return 1
  fi

  if [[ "$merge_status" == "CONFLICTED" ]]; then
    mkdir -p "$state_dir"
    if [[ -f "$state_dir/.conflict-detected" ]]; then
      current_head=$(git -C "$wt_dir" rev-parse HEAD 2>/dev/null || echo "")
      write_ready_attention_file "$state_dir" "PR #$pr_number still has merge conflicts after automatic remediation."
      record_ready_conflict_attention "$state_dir" "$current_head"
      log_error "  Merge conflicts persist for $issue after remediation attempt"
      return 1
    fi
    touch "$state_dir/.conflict-detected"
    marker_clear "$state_dir/.needs-attention"
    log "status" "  ⚠ Merge conflict detected for $issue (PR #$pr_number)"

    prompt_file="/tmp/${SESSION}-${issue}-conflict-prompt.txt"
    build_conflict_resolution_prompt "$pr_number" "$branch" "$wt_dir" "$status_file" "$base_branch" > "$prompt_file"
    if [[ "$(post_pr_reconciliation_enabled "$wt_dir")" == "true" ]]; then
      # Fresh-agent conflict reconciliation from the durable capsule
      # (HOK-2936): stable foundation projection first, current incident and
      # narrow conflict instructions after. An invalid capsule refuses the
      # launch with a typed needs-user reason instead of guessing context.
      local recon_head recon_base_sha recon_incident_out recon_fingerprint recon_classification
      recon_head=$(git -C "$wt_dir" rev-parse HEAD 2>/dev/null || echo "")
      recon_base_sha=$(git -C "$wt_dir" rev-parse "origin/$base_branch" 2>/dev/null || echo "")
      recon_classification=$(classify_for_reconciliation "$merge_status" "" "0" "0")
      recon_incident_out=$(npx tsx "$TOOLS_DIR/reconciliation-capsule.ts" update-incident \
        --feature-dir "$state_dir" \
        --classification "$recon_classification" \
        ${recon_head:+--head "$recon_head"} \
        ${recon_base_sha:+--base "$recon_base_sha"} \
        --detail "PR #$pr_number reports merge conflicts against $base_branch (GitHub mergeable: CONFLICTED)." \
        2>/dev/null) || {
        write_ready_attention_file "$state_dir" "Reconciliation capsule invalid ($(jq -r '.reason // "unknown"' <<< "$recon_incident_out" 2>/dev/null || echo "unknown")) for PR #$pr_number - refusing conflict reconciliation launch."
        log_error "  $issue: reconciliation capsule unavailable - refusing conflict launch for PR #$pr_number"
        return 1
      }
      recon_fingerprint=$(jq -r '.failureFingerprint // empty' <<< "$recon_incident_out" 2>/dev/null || echo "")
      reconciliation_reset_retry_if_new_fingerprint "$state_dir" "ready-remediation" "$recon_fingerprint"
      if ! reconciliation_project_prompt "$state_dir" "$pr_number" "$prompt_file.capsule"; then
        log_error "  $issue: reconciliation capsule projection failed - refusing conflict launch for PR #$pr_number"
        return 1
      fi
      cat "$prompt_file" >> "$prompt_file.capsule"
      mv "$prompt_file.capsule" "$prompt_file"
    fi
    local conflict_launch_head
    conflict_launch_head="$(git -C "$wt_dir" rev-parse HEAD 2>/dev/null || echo "")"
    if ! win="$(ensure_ready_worker_window "$issue" "$slug" "$state_dir" "$wt_dir" "$pr_number" "$conflict_launch_head")"; then
      log "debug" "  $issue: conflict reconciliation launch skipped because ownership is already held"
      return 5
    fi
    _launch_agent_in_pane "$win" "$current_agent" "$current_model" "$prompt_file" "$slug" "$issue" "coding"
    launch_rc=$?

    if [[ "$launch_rc" -eq 0 ]]; then
      launch_head=$(git -C "$wt_dir" rev-parse HEAD 2>/dev/null || echo "")
      if [[ "$(post_pr_reconciliation_enabled "$wt_dir")" == "true" ]]; then
        reconciliation_record_attempt "$state_dir" "$current_agent" "$current_model" "$launch_head"
      fi
      local conflict_artifacts_json
      conflict_artifacts_json=$(merge_queue_enrich_ready_artifacts "$state_dir" \
        "{\"type\":\"ready\",\"prNumber\":$pr_number,\"mergeConflict\":\"CONFLICTED\",\"launchHead\":\"$launch_head\"}" \
        "candidate-progress")
      write_stage_result "$state_dir" "ready" "running" "$current_agent" "$current_model" \
        "Conflict remediation in progress for PR #$pr_number" \
        "$conflict_artifacts_json"
      return 3
    fi
    if [[ "$launch_rc" -eq 2 ]] && check_stage_aborted "$state_dir"; then
      reconciliation_lease_release "$state_dir"
      set_task_task_owned "$issue" "active" || true
      return 2
    fi

    reconciliation_lease_release "$state_dir"
    set_task_task_owned "$issue" "active" || true
    write_ready_attention_file "$state_dir" "Automatic merge-conflict resolution could not be launched for PR #$pr_number."
    log_error "  Failed to launch conflict-resolution agent for $issue"
    return 1
  fi

  if [[ "$merge_status" == "UNKNOWN" || "$merge_status" == "ERROR" ]]; then
    local transient_count transient_limit pending_artifacts_json
    transient_limit="${READY_TRANSIENT_MAX_ATTEMPTS:-6}"
    transient_count=$(increment_transient_mergeability_count "$state_dir")

    if (( transient_count <= transient_limit )); then
      pending_artifacts_json=$(jq -cn \
        --arg merge_status "${merge_status:-UNKNOWN}" \
        --argjson checks_run "${checks_run:-0}" \
        --argjson checks_passed "${checks_passed:-0}" \
        --argjson pr_number "${pr_number}" \
        --argjson attempts "$transient_count" \
        '{
          type: "ready",
          verdict: "pending",
          checksRun: $checks_run,
          checksPassed: $checks_passed,
          mergeConflict: $merge_status,
          prNumber: $pr_number,
          transientMergeabilityAttempts: $attempts
        }')
      pending_artifacts_json=$(merge_queue_enrich_ready_artifacts "$state_dir" "$pending_artifacts_json" "candidate-progress")
      write_stage_result "$state_dir" "ready" "running" "$current_agent" "$current_model" \
        "pending GitHub mergeability - will retry (attempt ${transient_count}/${transient_limit})" \
        "$pending_artifacts_json"
      marker_clear "$state_dir/.needs-attention"
      marker_clear "$state_dir/.needs-attention-transient"
      log "info" "  Merge status for $issue is $merge_status - will retry (attempt ${transient_count}/${transient_limit})"
      return 4
    fi

    write_transient_ready_attention_file "$state_dir" \
      "Merge status $merge_status persisted after $transient_count checks for PR #$pr_number."
    log_error "  Merge status $merge_status persisted for $issue after $transient_count attempts"
    return 1
  fi

  rm -f "$state_dir/.conflict-detected" "$state_dir/.conflict-recheck-at"
  marker_clear "$state_dir/.needs-attention"
  marker_clear "$state_dir/.needs-attention-transient"
  clear_ready_conflict_attention "$state_dir"
  clear_transient_mergeability_state "$state_dir"

  if [[ "$ready_rc" -eq 0 ]]; then
    local main_sha completed_artifacts_json label_failed_artifacts_json
    main_sha=$(get_main_head_sha "$wt_dir" "$base_branch")
    if ! set_ready_pass_labels "$wt_dir" "$pr_number" "$state_dir" >/dev/null 2>&1; then
      label_failed_artifacts_json=$(jq -cn \
        --arg verdict "${verdict:-unknown}" \
        --arg merge_status "${merge_status:-UNKNOWN}" \
        --argjson checks_run "${checks_run:-0}" \
        --argjson checks_passed "${checks_passed:-0}" \
        --argjson pr_number "${pr_number}" \
        --arg ready_base_sha "$main_sha" \
        --arg ready_head_sha "$ready_head_sha" \
        --arg ci_conclusion "$ci_conclusion" \
        --arg required_source "$required_source" \
        --argjson required_contexts "$required_contexts_json" '
          {
            type:"ready",
            verdict:$verdict,
            checksRun:$checks_run,
            checksPassed:$checks_passed,
            mergeConflict:$merge_status,
            prNumber:$pr_number,
            readyLabelsUpdated:false,
            readyBaseSha:$ready_base_sha,
            readyHeadSha:$ready_head_sha,
            ciConclusion:$ci_conclusion,
            requiredSource:$required_source,
            requiredContexts:$required_contexts
          } | with_entries(select(.value != ""))
        ')
      label_failed_artifacts_json=$(merge_queue_enrich_ready_artifacts "$state_dir" "$label_failed_artifacts_json" "candidate-progress")
      write_stage_result "$state_dir" "ready" "failed" "$current_agent" "$current_model" \
        "Ready passed but failed to restore PR labels" \
        "$label_failed_artifacts_json"
      write_ready_attention_file "$state_dir" "Ready passed for PR #$pr_number, but updating wm:ready labels failed."
      log_error "  Ready passed for $issue but failed to restore PR labels"
      return 1
    fi

    completed_artifacts_json=$(jq -cn \
      --arg verdict "${verdict:-unknown}" \
      --arg merge_status "${merge_status:-UNKNOWN}" \
      --argjson checks_run "${checks_run:-0}" \
      --argjson checks_passed "${checks_passed:-0}" \
      --argjson pr_number "${pr_number}" \
      --arg ready_base_sha "$main_sha" \
      --arg ready_head_sha "$ready_head_sha" \
      --arg ci_conclusion "$ci_conclusion" \
      --arg required_source "$required_source" \
      --argjson required_contexts "$required_contexts_json" '
        {
          type:"ready",
          verdict:$verdict,
          checksRun:$checks_run,
          checksPassed:$checks_passed,
          mergeConflict:$merge_status,
          prNumber:$pr_number,
          readyLabelsUpdated:true,
          readyBaseSha:$ready_base_sha,
          readyHeadSha:$ready_head_sha,
          ciConclusion:$ci_conclusion,
          requiredSource:$required_source,
          requiredContexts:$required_contexts
        } | with_entries(select(.value != ""))
      ')
    completed_artifacts_json=$(merge_queue_enrich_ready_artifacts "$state_dir" "$completed_artifacts_json" "completed")
    write_stage_result "$state_dir" "ready" "completed" "$current_agent" "$current_model" \
      "verdict: ${verdict:-unknown}" \
      "$completed_artifacts_json"
    clear_failed_ready_recheck_state "$state_dir"
    bounded_retry_clear "$state_dir" "ready-remediation"
    bounded_retry_clear "$state_dir" "pending-ready-recheck"
    log "debug" "  $issue: Canonicalized ready labels for PR #$pr_number"
    log "debug" "  $issue: Ready checks completed (verdict: ${verdict:-unknown})"
    return 0
  fi

  if [[ "$ready_rc" -eq 2 ]]; then
    local pending_artifacts_json prior_remediation_failures_json
    prior_remediation_failures_json=$(jq -c '.artifacts.remediationFailures // []' "$ready_result_file" 2>/dev/null || echo '[]')
    pending_artifacts_json=$(jq -cn \
      --arg merge_status "${merge_status:-UNKNOWN}" \
      --argjson checks_run "${checks_run:-0}" \
      --argjson checks_passed "${checks_passed:-0}" \
      --argjson pr_number "${pr_number}" \
      --argjson attempts "${remediation_attempts:-0}" \
      --argjson remediation_failures "$prior_remediation_failures_json" \
      '{
        type: "ready",
        verdict: "pending",
        checksRun: $checks_run,
        checksPassed: $checks_passed,
        mergeConflict: $merge_status,
        prNumber: $pr_number
      } + (if $attempts > 0 then {remediationAttempts: $attempts} else {} end)
        + (if $attempts > 0 and ($remediation_failures | length) > 0
            then {remediationFailures: $remediation_failures}
            else {}
          end)')
    pending_artifacts_json=$(merge_queue_enrich_ready_artifacts "$state_dir" "$pending_artifacts_json" "candidate-progress")
    write_stage_result "$state_dir" "ready" "running" "$current_agent" "$current_model" \
      "CI checks pending for PR #$pr_number" \
      "$pending_artifacts_json"
    log "$pending_log_level" "  CI checks pending for $issue (PR #$pr_number) - will retry"
    return 4
  fi

  failed_check_names=$(printf '%s' "$result" | jq -r '[.checks[]? | select(.status == "fail") | .name] | join(",")' 2>/dev/null || echo "")
  failed_check_names_json=$(printf '%s' "$result" | jq -c '[.checks[]? | select(.status == "fail") | .name]' 2>/dev/null || echo '[]')
  remediation_enabled=$(ready_remediation_enabled "$wt_dir")
  remediation_max_attempts=$(ready_remediation_max_attempts "$wt_dir")
  current_head=$(git -C "$wt_dir" rev-parse HEAD 2>/dev/null || echo "")

  if [[ "$remediation_enabled" == "true" ]] && ready_failure_is_actionable_for_remediation "$state_dir" "$verdict" "$failed_check_names" "$result"; then
    if [[ "$ready_status" == "running" ]] && [[ -n "$remediation_launch_head" ]] && [[ "$remediation_launch_head" == "$current_head" ]]; then
      return 5
    fi

    # A fresh commit is genuine new information: give the new head a full
    # remediation budget (HOK-2924).
    bounded_retry_reset_if_new_head "$state_dir" "ready-remediation" "$current_head"
    remediation_attempts=$(ready_remediation_attempts "$state_dir")

    if (( remediation_attempts >= remediation_max_attempts )); then
      local exhausted_artifacts_json
      exhausted_artifacts_json=$(merge_queue_enrich_ready_artifacts "$state_dir" \
        "{\"type\":\"ready\",\"verdict\":\"fail\",\"checksRun\":${checks_run:-0},\"checksPassed\":${checks_passed:-0},\"mergeConflict\":\"${merge_status:-UNKNOWN}\",\"prNumber\":${pr_number},\"remediationAttempts\":${remediation_attempts},\"remediationFailures\":${failed_check_names_json}}" \
        "candidate-progress")
      write_stage_result "$state_dir" "ready" "failed" "$current_agent" "$current_model" \
        "Ready remediation exhausted after ${remediation_attempts} attempt(s)" \
        "$exhausted_artifacts_json"
      write_ready_attention_file "$state_dir" "Remediation exhausted after ${remediation_attempts} attempt(s) for PR #$pr_number."
      bounded_retry_mark_exhausted "$state_dir" "ready-remediation" \
        "Ready remediation exhausted after ${remediation_attempts} attempt(s) for PR #$pr_number (failed checks: ${failed_check_names})" || true
      log_error "  Ready remediation exhausted for $issue (failed checks: ${failed_check_names})"
      return 1
    fi

    # Never relaunch on the next poll tick: honor the backoff window between
    # remediation attempts (HOK-2924).
    if ! bounded_retry_due "$state_dir" "ready-remediation"; then
      log "debug" "  $issue: holding ready remediation for PR #$pr_number (backoff)"
      return 5
    fi

    failed_check_summary=$(ready_failed_check_summary "$result")
    [[ -n "$failed_check_summary" ]] || failed_check_summary="${failed_check_names}: checks failing"
    if ! win="$(ensure_ready_worker_window "$issue" "$slug" "$state_dir" "$wt_dir" "$pr_number" "$current_head")"; then
      log "debug" "  $issue: ready remediation launch skipped because ownership is already held"
      return 5
    fi
    _launch_ready_remediation_attempt \
      "$issue" "$slug" "$wt_dir" "$branch" "$base_branch" "$pr_number" \
      "$state_dir" "$win" "$status_file" "$current_agent" "$current_model" \
      "$current_head" "${checks_run:-0}" "${checks_passed:-0}" "${merge_status:-UNKNOWN}" \
      "$(( remediation_attempts + 1 ))" "$remediation_max_attempts" \
      "$failed_check_names_json" "$failed_check_summary" "$ready_result_file"
    launch_rc=$?
    if [[ "$launch_rc" -eq 0 ]]; then
      return 5
    elif [[ "$launch_rc" -eq 2 ]]; then
      return 2
    fi
    return 1
  fi

  local failed_artifacts_json
  failed_artifacts_json=$(merge_queue_enrich_ready_artifacts "$state_dir" \
    "{\"type\":\"ready\",\"verdict\":\"${verdict:-unknown}\",\"checksRun\":${checks_run:-0},\"checksPassed\":${checks_passed:-0},\"mergeConflict\":\"${merge_status:-UNKNOWN}\",\"prNumber\":${pr_number}${failed_check_names_json:+,\"remediationFailures\":${failed_check_names_json}}}" \
    "candidate-progress")
  write_stage_result "$state_dir" "ready" "failed" "$current_agent" "$current_model" "Ready checks failed" "$failed_artifacts_json"
  write_ready_attention_file "$state_dir" "Ready checks failed for PR #$pr_number."
  log_ready_failure_result "$issue" "$result"
  return 1
}

# Controller-owned feature-directory readiness check (HOK-1183).
# Evaluates phase state without requiring a PR or GitHub CLI.
# Returns JSON to stdout; exits 0 if ready, 1 otherwise.
#
# Usage: check_ready_stage <feature_dir>
#
# Full phase-transition wiring is deferred to HOK-1177.
check_ready_stage() {
  local feature_dir="$1"
  if [[ -z "$feature_dir" ]]; then
    echo '{"error":"feature_dir argument required"}' >&2
    return 1
  fi
  npx tsx "$TOOLS_DIR/controller-ready.ts" "$feature_dir" 2>/dev/null
  return $?
}

_resolve_window_attention_target() {
  local win="$1"
  local target="$win" issue="" slug=""
  if [[ "$win" =~ ^([A-Z]+-[0-9]+(_c)?)-(.+)$ ]]; then
    issue="${BASH_REMATCH[1]}"
    slug="${BASH_REMATCH[3]}"
    local expected_worktree=""
    [[ -n "${WORKTREE_ROOT:-}" ]] && expected_worktree="${WORKTREE_ROOT}/${slug}"
    target="$(_tmux_task_window_target "$SESSION" "$issue" "$slug" "${STATE_FILE:-}" "$expected_worktree" 2>/dev/null || true)"
  fi
  [[ -n "$target" ]] || target="$win"
  _tmux_target_join "$SESSION" "$target" 2>/dev/null || printf '%s:%s\n' "$SESSION" "$target"
}

clear_window_attention_state() {
  local win="$1" target
  target="$(_resolve_window_attention_target "$win")"
  tmux set-window-option -u -t "$target" window-status-style >/dev/null 2>&1 || true
  tmux set-window-option -u -t "$target" window-status-current-style >/dev/null 2>&1 || true
}

set_window_attention_state() {
  local win="$1" state="${2:-clear}"
  if [[ "$state" == "needs-user" ]]; then
    local target
    target="$(_resolve_window_attention_target "$win")"
    tmux set-window-option -t "$target" window-status-style bg=red,fg=white,bold >/dev/null 2>&1 || true
    tmux set-window-option -t "$target" window-status-current-style bg=red,fg=white,bold >/dev/null 2>&1 || true
  else
    clear_window_attention_state "$win"
  fi
  tmux refresh-client -S >/dev/null 2>&1 || true
}

codex_has_pending_approval() {
  local worktree="$1"
  local codex_db="$HOME/.codex/state_5.sqlite"
  [[ -n "$worktree" ]] || return 1
  [[ -f "$codex_db" ]] || return 1

  local escaped_worktree thread_row thread_id rollout_path
  escaped_worktree=${worktree//\'/\'\'}
  thread_row=$(sqlite3 "$codex_db" \
    "SELECT id || '|' || rollout_path FROM threads WHERE cwd = '$escaped_worktree' ORDER BY updated_at DESC LIMIT 1;" \
    2>/dev/null || true)
  [[ -n "$thread_row" ]] || return 1

  thread_id="${thread_row%%|*}"
  rollout_path="${thread_row#*|}"
  [[ -n "$thread_id" && -f "$rollout_path" ]] || return 1

  declare -A pending_calls=()
  local event_type call_id
  while IFS=$'\t' read -r event_type call_id; do
    [[ -n "$call_id" ]] || continue
    case "$event_type" in
      pending) pending_calls["$call_id"]=1 ;;
      resolved) unset 'pending_calls[$call_id]' ;;
    esac
  done < <(
    jq -r '
      if .type == "response_item" and .payload.type == "function_call" then
        ((.payload.arguments? // "{}") | try fromjson catch {}) as $args |
        if ($args.sandbox_permissions // "") == "require_escalated" then
          "pending\t\(.payload.call_id // "")"
        else
          empty
        end
      elif .type == "response_item" and .payload.type == "function_call_output" then
        "resolved\t\(.payload.call_id // "")"
      else
        empty
      end
    ' "$rollout_path" 2>/dev/null
  )

  (( ${#pending_calls[@]} > 0 ))
}

get_task_meta() {
  local issue="$1" field="$2"
  read_state_value "" --arg issue "$issue" --arg field "$field" '.tasks[$issue][$field] // empty'
}

get_linear_issue_id() {
  local issue="$1"
  local linear_issue
  linear_issue=$(get_task_meta "$issue" "linearIssueId")
  linear_issue="${linear_issue#"${linear_issue%%[![:space:]]*}"}"
  linear_issue="${linear_issue%"${linear_issue##*[![:space:]]}"}"
  if [[ "$linear_issue" =~ ^[A-Z][A-Z0-9]*-[0-9]+$ ]]; then
    printf '%s\n' "$linear_issue"
    return 0
  fi
  if [[ "$linear_issue" =~ ^https?://linear\.app/[^/]+/issue/[A-Z][A-Z0-9]*-[0-9]+([/?#].*)?$ ]]; then
    local linear_url_path="${linear_issue#*://linear.app/}"
    linear_url_path="${linear_url_path#*/issue/}"
    printf '%s\n' "${linear_url_path%%[/?#]*}"
    return 0
  fi
  if [[ "$issue" =~ ^([A-Z][A-Z0-9]*-[0-9]+)_c$ ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
    return 0
  fi
  printf '%s\n' "$issue"
}

expansion_recovery_resolve_issue_id() {
  local issue="$1"
  local linear_issue=""

  if [[ "$issue" != *_c ]]; then
    printf '%s\n' "$issue"
    return 0
  fi

  linear_issue="$(get_task_meta "$issue" "linearIssueId")"
  linear_issue="${linear_issue#"${linear_issue%%[![:space:]]*}"}"
  linear_issue="${linear_issue%"${linear_issue##*[![:space:]]}"}"
  if [[ "$linear_issue" =~ ^[A-Z][A-Z0-9]*-[0-9]+$ ]]; then
    printf '%s\n' "$linear_issue"
    return 0
  fi

  if [[ "$linear_issue" =~ ^https?://linear\.app/[^/]+/issue/[A-Z][A-Z0-9]*-[0-9]+([/?#].*)?$ ]]; then
    local linear_url_path="${linear_issue#*://linear.app/}"
    linear_url_path="${linear_url_path#*/issue/}"
    printf '%s\n' "${linear_url_path%%[/?#]*}"
    return 0
  fi

  return 1
}

should_update_linear_state() {
  local issue="$1"
  local role
  role=$(get_task_meta "$issue" "challengeRole")
  [[ "$role" != "challenger" ]]
}

should_cleanup_closed_pr() {
  local issue="$1"
  local role
  role=$(get_task_meta "$issue" "challengeRole")
  [[ "$role" == "challenger" && "${CHALLENGE_AUTO_MERGE:-false}" != "true" ]]
}

is_challenge_task() {
  local issue="$1"
  [[ "$(get_task_meta "$issue" "challenge")" == "true" ]]
}

get_challenge_sibling_pr() {
  local issue="$1"
  local pair_id role sibling_key

  pair_id=$(get_task_meta "$issue" "challengePairId")
  role=$(get_task_meta "$issue" "challengeRole")

  [[ -z "$pair_id" || -z "$role" ]] && return 1

  if [[ "$role" == "primary" ]]; then
    sibling_key="${pair_id}_c"
  elif [[ "$role" == "challenger" ]]; then
    sibling_key="$pair_id"
  else
    return 1
  fi

  read_state_value "" --arg issue "$sibling_key" '.tasks[$issue].pr // empty'
}

# Check if a challenge task's sibling PR was merged.
# Returns 0 if merged, 1 if not merged or unavailable.
check_challenge_sibling_merged() {
  local issue="$1"
  local sibling_pr

  sibling_pr=$(get_challenge_sibling_pr "$issue")
  [[ -z "$sibling_pr" ]] && return 1

  validate_pr_merge "$sibling_pr"
}

mark_challenge_compared() {
  local pair_id="$1"
  local source="${2:-comparison}"
  if ! state_mutate "$STATE_FILE" '
    .tasks |= with_entries(
      if (.value.challengePairId // "") == $pair then
        .value.challengeCompared = true |
        .value.challengeComparedSource = $source |
        .value |= (
          del(
            .comparisonRunning,
            .comparisonState,
            .comparisonBlockedReason,
            .comparisonRetryCount,
            .comparisonRetryMaxAttempts,
            .comparisonRetryTargetIssue,
            .comparisonTimedOutSides,
            .manualComparisonArtifact
          ) |
          .updated = (now | todateiso8601)
        )
      else
        .
      end
    )' --arg pair "$pair_id" --arg source "$source"; then
    log_warn "mark_challenge_compared: failed for $pair_id"
  fi
}

mark_challenge_invalid() {
  local pair_id="$1" reason="$2" details="${3:-}"
  if ! state_mutate "$STATE_FILE" '
    .tasks |= with_entries(
      if (.value.challengePairId // "") == $pair then
        .value.challengeCompared = false |
        .value.comparisonState = "invalid_challenge" |
        .value.invalidChallengeReason = $reason |
        .value.invalidChallengeDetails = $details |
        .value.challengeRepairAction = ("wavemill mill challenge repair " + $pair) |
        .value |= (
          del(
            .comparisonRunning,
            .cleanupPolicy
          ) |
          .updated = (now | todateiso8601)
        )
      else
        .
      end
    )' --arg pair "$pair_id" --arg reason "$reason" --arg details "$details"; then
    log_warn "mark_challenge_invalid: failed for $pair_id"
  fi
}

sanitize_job_token() {
  printf '%s' "${1:-unknown}" | sed 's/[^A-Za-z0-9._-]/-/g'
}

challenge_job_dir() {
  local dir="$REPO_DIR/.wavemill/jobs/$SESSION"
  mkdir -p "$dir"
  printf '%s\n' "$dir"
}

build_eval_job_id() {
  local issue="$1" side="$2" pr="$3"
  printf 'eval-%s-%s-%s\n' \
    "$(sanitize_job_token "$issue")" \
    "$(sanitize_job_token "$side")" \
    "$pr"
}

build_comparison_job_id() {
  local pair_id="$1" primary_pr="$2" challenger_pr="$3"
  printf 'comparison-%s-%s-%s\n' \
    "$(sanitize_job_token "$pair_id")" \
    "$primary_pr" \
    "$challenger_pr"
}

read_job_state_value() {
  local job_id="$1" default="$2" expr="$3"
  read_state_value "$default" --arg id "$job_id" "$expr"
}

launch_tracked_job() {
  local kind="$1" job_id="$2" issue_id="$3" side="$4" pair_id="$5" pr_numbers="$6" pid="$7" timeout_seconds="$8" log_path="$9" result_path="${10}"
  local args=(
    launch
    --state-file "$STATE_FILE" \
    --kind "$kind" \
    --job-id "$job_id" \
    --pr-numbers "$pr_numbers" \
    --pid "$pid" \
    --timeout-seconds "$timeout_seconds" \
    --log-path "$log_path" \
    --result-path "$result_path"
  )
  [[ -n "$issue_id" ]] && args+=(--issue-id "$issue_id")
  [[ -n "$side" ]] && args+=(--side "$side")
  [[ -n "$pair_id" ]] && args+=(--pair-id "$pair_id")
  [[ -n "${SESSION:-}" ]] && args+=(--session "$SESSION")
  npx tsx "$TOOLS_DIR/job-tracker.ts" "${args[@]}" >/dev/null
}

settle_tracked_job() {
  local job_id="$1"
  npx tsx "$TOOLS_DIR/job-tracker.ts" mark-settled \
    --state-file "$STATE_FILE" \
    --job-id "$job_id" \
    >/dev/null
}

render_challenge_comparison_summary() {
  local pair_id="$1" primary_pr="$2" challenger_pr="$3" primary_model="$4" challenger_model="$5" result_path="$6"
  [[ -r "$result_path" ]] || return 0

  local compare_json winner winner_model rationale comparison_outcome
  local comp_p comp_c cor_p cor_c qual_p qual_c impact_p impact_c auto_p auto_c
  local primary_eval_score challenger_eval_score
  compare_json=$(jq -c '.comparison // {}' "$result_path" 2>/dev/null || echo "{}")
  winner=$(echo "$compare_json" | jq -r '.winner // empty' 2>/dev/null)
  winner_model=$(echo "$compare_json" | jq -r '.winnerModel // empty' 2>/dev/null)
  rationale=$(echo "$compare_json" | jq -r '.rationale // empty' 2>/dev/null)
  local invalid_challenge invalid_reason
  invalid_challenge=$(echo "$compare_json" | jq -r '.invalidChallenge // false' 2>/dev/null)
  invalid_reason=$(echo "$compare_json" | jq -r '.invalidChallengeReason // empty' 2>/dev/null)
  comparison_outcome=$(echo "$compare_json" | jq -r '.comparisonOutcome // "compared"' 2>/dev/null)
  primary_eval_score=$(echo "$compare_json" | jq -r '.primaryEvalScore // "—"' 2>/dev/null)
  challenger_eval_score=$(echo "$compare_json" | jq -r '.challengerEvalScore // "—"' 2>/dev/null)
  comp_p=$(echo "$compare_json" | jq -r '.dimensions.completeness.primary // "—"' 2>/dev/null)
  comp_c=$(echo "$compare_json" | jq -r '.dimensions.completeness.challenger // "—"' 2>/dev/null)
  cor_p=$(echo "$compare_json" | jq -r '.dimensions.correctness.primary // "—"' 2>/dev/null)
  cor_c=$(echo "$compare_json" | jq -r '.dimensions.correctness.challenger // "—"' 2>/dev/null)
  qual_p=$(echo "$compare_json" | jq -r '.dimensions.code_quality.primary // .dimensions.codeQuality.primary // "—"' 2>/dev/null)
  qual_c=$(echo "$compare_json" | jq -r '.dimensions.code_quality.challenger // .dimensions.codeQuality.challenger // "—"' 2>/dev/null)
  impact_p=$(echo "$compare_json" | jq -r '.dimensions.intervention_impact.primary // .dimensions.scopeDiscipline.primary // "—"' 2>/dev/null)
  impact_c=$(echo "$compare_json" | jq -r '.dimensions.intervention_impact.challenger // .dimensions.scopeDiscipline.challenger // "—"' 2>/dev/null)
  auto_p=$(echo "$compare_json" | jq -r '.dimensions.autonomy.primary // "—"' 2>/dev/null)
  auto_c=$(echo "$compare_json" | jq -r '.dimensions.autonomy.challenger // "—"' 2>/dev/null)

  local disp_primary disp_challenger disp_winner
  local primary_planner challenger_planner primary_reviewer challenger_reviewer
  local primary_exec_planner challenger_exec_planner primary_exec_coder challenger_exec_coder primary_exec_reviewer challenger_exec_reviewer
  local disp_primary_planner disp_challenger_planner disp_primary_reviewer disp_challenger_reviewer
  local disp_primary_exec_planner disp_challenger_exec_planner disp_primary_exec_coder disp_challenger_exec_coder disp_primary_exec_reviewer disp_challenger_exec_reviewer
  local model_row_label has_routing
  disp_primary=$(echo "$primary_model" | sed 's/-[0-9]\{8\}$//')
  disp_challenger=$(echo "$challenger_model" | sed 's/-[0-9]\{8\}$//')
  disp_winner=$(echo "$winner_model" | sed 's/-[0-9]\{8\}$//')
  primary_planner=$(echo "$compare_json" | jq -r '.comparison.primaryRouting.planner // .primaryRouting.planner // empty' 2>/dev/null)
  challenger_planner=$(echo "$compare_json" | jq -r '.comparison.challengerRouting.planner // .challengerRouting.planner // empty' 2>/dev/null)
  primary_reviewer=$(echo "$compare_json" | jq -r '.comparison.primaryRouting.reviewer // .primaryRouting.reviewer // empty' 2>/dev/null)
  challenger_reviewer=$(echo "$compare_json" | jq -r '.comparison.challengerRouting.reviewer // .challengerRouting.reviewer // empty' 2>/dev/null)
  primary_exec_planner=$(echo "$compare_json" | jq -r '(.primaryExecution.planning.agent // "") + "/" + (.primaryExecution.planning.model // "") | select(. != "/")' 2>/dev/null)
  challenger_exec_planner=$(echo "$compare_json" | jq -r '(.challengerExecution.planning.agent // "") + "/" + (.challengerExecution.planning.model // "") | select(. != "/")' 2>/dev/null)
  primary_exec_coder=$(echo "$compare_json" | jq -r '(.primaryExecution.coding.agent // "") + "/" + (.primaryExecution.coding.model // "") | select(. != "/")' 2>/dev/null)
  challenger_exec_coder=$(echo "$compare_json" | jq -r '(.challengerExecution.coding.agent // "") + "/" + (.challengerExecution.coding.model // "") | select(. != "/")' 2>/dev/null)
  primary_exec_reviewer=$(echo "$compare_json" | jq -r '(.primaryExecution.review.agent // "") + "/" + (.primaryExecution.review.model // "") | select(. != "/")' 2>/dev/null)
  challenger_exec_reviewer=$(echo "$compare_json" | jq -r '(.challengerExecution.review.agent // "") + "/" + (.challengerExecution.review.model // "") | select(. != "/")' 2>/dev/null)
  disp_primary_planner=$(echo "$primary_planner" | sed 's/-[0-9]\{8\}$//')
  disp_challenger_planner=$(echo "$challenger_planner" | sed 's/-[0-9]\{8\}$//')
  disp_primary_reviewer=$(echo "$primary_reviewer" | sed 's/-[0-9]\{8\}$//')
  disp_challenger_reviewer=$(echo "$challenger_reviewer" | sed 's/-[0-9]\{8\}$//')
  disp_primary_exec_planner=$(echo "$primary_exec_planner" | sed 's/-[0-9]\{8\}$//')
  disp_challenger_exec_planner=$(echo "$challenger_exec_planner" | sed 's/-[0-9]\{8\}$//')
  disp_primary_exec_coder=$(echo "$primary_exec_coder" | sed 's/-[0-9]\{8\}$//')
  disp_challenger_exec_coder=$(echo "$challenger_exec_coder" | sed 's/-[0-9]\{8\}$//')
  disp_primary_exec_reviewer=$(echo "$primary_exec_reviewer" | sed 's/-[0-9]\{8\}$//')
  disp_challenger_exec_reviewer=$(echo "$challenger_exec_reviewer" | sed 's/-[0-9]\{8\}$//')
  has_routing="false"
  if [[ -n "$primary_planner$challenger_planner$primary_reviewer$challenger_reviewer" ]]; then
    has_routing="true"
  fi
  model_row_label="Model"
  [[ "$has_routing" == "true" ]] && model_row_label="Coder"

  log "status" ""
  log "status" "  ┌────────────────────────────────────────────────────────────┐"
  log "status" "  │  ⚖  Challenge Comparison: $pair_id"
  log "status" "  ├────────────────────────────────────────────────────────────┤"
  log "status" "  │                    Primary            Challenger           │"
  log "status" "  │  $(printf '%-14s' "$model_row_label")$(printf '%-20s' "$disp_primary") $(printf '%-19s' "$disp_challenger")│"
  if [[ "$has_routing" == "true" ]]; then
    log "status" "  │  Intent Planner $(printf '%-20s' "${disp_primary_planner:-—}") $(printf '%-19s' "${disp_challenger_planner:-—}")│"
    log "status" "  │  Intent Reviewer$(printf '%-20s' "${disp_primary_reviewer:-—}") $(printf '%-19s' "${disp_challenger_reviewer:-—}")│"
  fi
  if [[ -n "$primary_exec_planner$challenger_exec_planner$primary_exec_coder$challenger_exec_coder$primary_exec_reviewer$challenger_exec_reviewer" ]]; then
    log "status" "  │  Exec Planner   $(printf '%-20s' "${disp_primary_exec_planner:-—}") $(printf '%-19s' "${disp_challenger_exec_planner:-—}")│"
    log "status" "  │  Exec Coder     $(printf '%-20s' "${disp_primary_exec_coder:-—}") $(printf '%-19s' "${disp_challenger_exec_coder:-—}")│"
    log "status" "  │  Exec Reviewer  $(printf '%-20s' "${disp_primary_exec_reviewer:-—}") $(printf '%-19s' "${disp_challenger_exec_reviewer:-—}")│"
  fi
  log "status" "  │  PR              #$(printf '%-19s' "$primary_pr") #$(printf '%-18s' "$challenger_pr")│"
  log "status" "  │  Eval Score      $(printf '%-20s' "$primary_eval_score") $(printf '%-19s' "$challenger_eval_score")│"
  log "status" "  ├────────────────────────────────────────────────────────────┤"
  log "status" "  │  Completeness    $(printf '%-20s' "$comp_p") $(printf '%-19s' "$comp_c")│"
  log "status" "  │  Correctness     $(printf '%-20s' "$cor_p") $(printf '%-19s' "$cor_c")│"
  log "status" "  │  Code Quality    $(printf '%-20s' "$qual_p") $(printf '%-19s' "$qual_c")│"
  log "status" "  │  Intervention    $(printf '%-20s' "$impact_p") $(printf '%-19s' "$impact_c")│"
  log "status" "  │  Autonomy        $(printf '%-20s' "$auto_p") $(printf '%-19s' "$auto_c")│"
  log "status" "  ├────────────────────────────────────────────────────────────┤"
  if [[ "$invalid_challenge" == "true" ]]; then
    log "status" "  │  Invalid challenge: ${invalid_reason:-unknown}"
  elif [[ -z "$winner" ]]; then
    log "status" "  │  Outcome: ${comparison_outcome:-inconclusive}"
  elif [[ "$winner" == "primary" ]]; then
    log "status" "  │  ★ Winner: Primary ($disp_winner) — PR #$primary_pr"
  else
    log "status" "  │  ★ Winner: Challenger ($disp_winner) — PR #$challenger_pr"
  fi
  log "status" "  │                                                            │"
  echo "$rationale" | fold -s -w 56 | while IFS= read -r rline; do
    log "status" "  │  $(printf '%-58s' "$rline")│"
  done
  log "status" "  └────────────────────────────────────────────────────────────┘"
  log "status" ""
}

handle_comparison_job_success() {
  local pair_id="$1" primary_key="$2" challenger_key="$3" primary_pr="$4" challenger_pr="$5" result_path="$6"
  local primary_model challenger_model loser_key loser_slug loser_pr winner comparison_outcome
  primary_model=$(get_task_meta "$primary_key" "challengeModel")
  challenger_model=$(get_task_meta "$challenger_key" "challengeModel")
  render_challenge_comparison_summary "$pair_id" "$primary_pr" "$challenger_pr" "$primary_model" "$challenger_model" "$result_path"

  if [[ "$(jq -r '.invalidChallenge // .comparison.invalidChallenge // false' "$result_path" 2>/dev/null || echo "false")" == "true" ]]; then
    local invalid_reason invalid_details
    invalid_reason=$(jq -r '.comparison.invalidChallengeReason // "invalid_challenge"' "$result_path" 2>/dev/null || echo "invalid_challenge")
    invalid_details=$(jq -r '.comparison.invalidChallengeDetails // .comparison.rationale // ""' "$result_path" 2>/dev/null || echo "")
    mark_challenge_invalid "$pair_id" "$invalid_reason" "$invalid_details"
    log_warn "challenge comparison invalid for $pair_id: $invalid_reason"
    return 0
  fi

  winner=$(jq -r '.comparison.winner // empty' "$result_path" 2>/dev/null || echo "")
  comparison_outcome=$(jq -r '.comparison.comparisonOutcome // "compared"' "$result_path" 2>/dev/null || echo "compared")
  if [[ "$comparison_outcome" == "invalid" || "$comparison_outcome" == "inconclusive" ]]; then
    write_challenge_pair_state "$pair_id" "manual_comparison_needed" "$comparison_outcome" 0 0 "" "" "" >/dev/null || true
    log_warn "challenge comparison held for $pair_id: $comparison_outcome"
    return 0
  fi
  if [[ "$winner" == "primary" ]]; then
    loser_key="$challenger_key"
  elif [[ "$winner" == "challenger" ]]; then
    loser_key="$primary_key"
  fi

  if [[ -n "${loser_key:-}" ]]; then
    loser_slug=$(get_task_meta "$loser_key" "slug")
    loser_pr=$(get_task_meta "$loser_key" "pr")
    if [[ -n "$loser_slug" ]]; then
      if [[ "${CHALLENGE_AUTO_MERGE:-false}" == "true" ]]; then
        log "status" "  ⚖ Auto-merge enabled: cleaning up losing side: $loser_key"
        if [[ -n "$loser_pr" ]] && [[ "$(pr_state "$loser_pr")" == "OPEN" ]]; then
          gh pr close "$loser_pr" \
            --comment "Closing: lost challenge comparison to ${winner} side." 2>/dev/null || true
          log "status" "Closed losing PR #$loser_pr"
        fi
        cleanup_completed_task "$loser_key" "$loser_slug" "challenge loser"
      else
        log "status" "  ⚖ Both PRs remain open for manual review (autoMergeWinner=false)"
      fi
    fi
  fi
}

poll_challenge_jobs() {
  local poll_json
  if ! poll_json=$(npx tsx "$TOOLS_DIR/job-tracker.ts" poll --state-file "$STATE_FILE" 2>/dev/null); then
    log_warn "challenge job poll failed"
    return 0
  fi

  while IFS= read -r job_json; do
    [[ -z "$job_json" ]] && continue
    local job_id kind status issue_id pair_id excerpt reason log_path result_path side
    local primary_pr challenger_pr primary_key challenger_key
    job_id=$(echo "$job_json" | jq -r '.id')
    kind=$(echo "$job_json" | jq -r '.kind')
    status=$(echo "$job_json" | jq -r '.status')
    issue_id=$(echo "$job_json" | jq -r '.issueId // empty')
    pair_id=$(echo "$job_json" | jq -r '.pairId // empty')
    excerpt=$(echo "$job_json" | jq -r '.excerpt // empty')
    reason=$(echo "$job_json" | jq -r '.reason // empty')
    log_path=$(echo "$job_json" | jq -r '.logPath // empty')
    result_path=$(echo "$job_json" | jq -r '.resultPath // empty')
    side=$(echo "$job_json" | jq -r '.side // empty')

    if [[ "$kind" == "eval" && "$status" == "succeeded" ]]; then
      log "status" "Challenge eval completed for $issue_id${side:+ ($side)}"
      settle_tracked_job "$job_id"
      continue
    fi

    if [[ "$kind" == "comparison" && "$status" == "succeeded" ]]; then
      primary_pr=$(echo "$job_json" | jq -r '.prNumbers[0] // empty')
      challenger_pr=$(echo "$job_json" | jq -r '.prNumbers[1] // empty')
      primary_key="$pair_id"
      challenger_key="${pair_id}_c"
      handle_comparison_job_success "$pair_id" "$primary_key" "$challenger_key" "$primary_pr" "$challenger_pr" "$result_path"
      settle_tracked_job "$job_id"
      continue
    fi

    if [[ "$kind" == "eval" && ( "$reason" == "no_result_file" || "$reason" == "timed_out" ) && -n "$issue_id" ]]; then
      local pr_num
      pr_num=$(echo "$job_json" | jq -r '.prNumbers[0] // empty')
      if [[ -n "$result_path" ]] && [[ -f "$result_path" ]] \
        && [[ "$(jq -r '.ok // .persisted // false' "$result_path" 2>/dev/null || echo "false")" == "true" ]]; then
        log_warn "challenge eval for $issue_id ${reason}: result was persisted, marking completed"
        mark_eval_completed "$issue_id"
        settle_tracked_job "$job_id"
        continue
      fi
      if [[ -n "$pr_num" ]] && eval_record_exists_for_issue_pr "$issue_id" "$pr_num"; then
        log_warn "challenge eval for $issue_id ${reason}: eval record was persisted, marking completed"
        mark_eval_completed "$issue_id"
        settle_tracked_job "$job_id"
        continue
      fi
    fi
    if [[ "$kind" == "eval" && "$reason" == "timed_out" && -n "$issue_id" && -n "$pair_id" ]]; then
      local retry_max retry_count timed_out_sides_csv timeout_reason primary_key challenger_key artifact_path
      local issue_pr issue_branch issue_slug soft_retry_state_dir soft_retry_head
      primary_key="$pair_id"
      challenger_key="${pair_id}_c"
      settle_tracked_job "$job_id"
      retry_max=$(challenge_eval_retry_max_attempts)
      issue_pr=$(read_state_value "" --arg i "$issue_id" '.tasks[$i].pr // empty')
      issue_branch=$(read_state_value "" --arg i "$issue_id" '.tasks[$i].branch // empty')
      issue_slug=$(read_state_value "" --arg i "$issue_id" '.tasks[$i].slug // empty')
      # Bounded-retry bucket in the arm's feature dir (HOK-2924). Effective
      # count is max(bucket, comparisonRetryCount mirror) so pre-existing
      # state keeps its budget; a fresh commit on the arm zeroes both. The
      # mirror keeps being written for external consumers.
      soft_retry_state_dir=""
      soft_retry_head=""
      local soft_retry_prior_head soft_retry_mirror
      if [[ -n "$issue_slug" ]]; then
        soft_retry_state_dir="${WORKTREE_ROOT}/${issue_slug}/features/${issue_slug}"
        soft_retry_head=$(git -C "${WORKTREE_ROOT}/${issue_slug}" rev-parse HEAD 2>/dev/null || echo "")
        soft_retry_prior_head=$(bounded_retry_head "$soft_retry_state_dir" "challenge-eval-soft")
        bounded_retry_reset_if_new_head "$soft_retry_state_dir" "challenge-eval-soft" "$soft_retry_head"
        if [[ -n "$soft_retry_prior_head" && -n "$soft_retry_head" && "$soft_retry_prior_head" != "$soft_retry_head" ]]; then
          state_mutate "$STATE_FILE" '
            .tasks[$issue].comparisonRetryCount = 0
            | .tasks[$issue].updated = (now | todateiso8601)
          ' --arg issue "$primary_key" >/dev/null || true
        fi
        retry_count=$(bounded_retry_count "$soft_retry_state_dir" "challenge-eval-soft")
      else
        retry_count=0
      fi
      soft_retry_mirror=$(read_state_value "0" --arg i "$primary_key" '.tasks[$i].comparisonRetryCount // 0')
      [[ "$soft_retry_mirror" =~ ^[0-9]+$ ]] || soft_retry_mirror=0
      (( soft_retry_mirror > retry_count )) && retry_count="$soft_retry_mirror"
      timed_out_sides_csv=$(challenge_pair_timed_out_sides_csv "$primary_key")
      if [[ -n "$timed_out_sides_csv" ]]; then
        case ",$timed_out_sides_csv," in
          *,"$side",*) ;;
          *) timed_out_sides_csv="${timed_out_sides_csv},${side}" ;;
        esac
      else
        timed_out_sides_csv="$side"
      fi
      timed_out_sides_csv="${timed_out_sides_csv#,}"
      timeout_reason=$(challenge_pair_timeout_reason "$timed_out_sides_csv")

      if (( retry_count < retry_max )); then
        if [[ -n "$soft_retry_state_dir" ]]; then
          bounded_retry_increment "$soft_retry_state_dir" "challenge-eval-soft" "$soft_retry_head" >/dev/null
        fi
        retry_count=$((retry_count + 1))
        write_challenge_pair_state "$pair_id" "retrying_eval" "$timeout_reason" "$retry_count" "$retry_max" "$issue_id" "$timed_out_sides_csv" ""
        state_mutate "$STATE_FILE" '
          .tasks[$issue].evalFailed = false
          | .tasks[$issue].evalCompleted = false
          | .tasks[$issue].updated = (now | todateiso8601)
        ' --arg issue "$issue_id" >/dev/null || true
        log "status" "challenge comparison retrying for $pair_id: $side eval timed out (attempt $retry_count/$retry_max)"
        if [[ -n "$issue_pr" && -n "$issue_branch" && -n "$issue_slug" ]]; then
          maybe_run_challenge_eval "$issue_id" "$issue_pr" "$issue_branch" "$issue_slug"
        else
          log_warn "challenge eval retry launch skipped for $issue_id: missing PR/branch/slug"
        fi
        continue
      fi

      if [[ -n "$soft_retry_state_dir" ]]; then
        bounded_retry_mark_exhausted "$soft_retry_state_dir" "challenge-eval-soft" \
          "Challenge eval soft retries exhausted for $issue_id (pair $pair_id): ${timed_out_sides_csv} eval timed out after ${retry_count}/${retry_max} attempt(s) - manual comparison needed" || true
      fi
      artifact_path=$(write_manual_challenge_comparison_artifact "$pair_id" "$primary_key" "$challenger_key" "$timed_out_sides_csv" "$retry_count" "$retry_max" || true)
      write_challenge_pair_state "$pair_id" "manual_comparison_needed" "$timeout_reason" "$retry_count" "$retry_max" "" "$timed_out_sides_csv" "$artifact_path"
      log_warn "challenge comparison blocked for $pair_id: ${timed_out_sides_csv} eval timed out. manual comparison needed${artifact_path:+ ($artifact_path)}"
      continue
    fi

    if [[ "$kind" == "eval" ]]; then
      log_warn "challenge eval failed for $issue_id (${reason:-$status}); log: $log_path"
    else
      log_warn "challenge comparison failed for $pair_id (${reason:-$status}); log: $log_path"
    fi
    if [[ -n "$excerpt" ]]; then
      while IFS= read -r line; do
        [[ -n "$line" ]] && log_warn "  $line"
      done <<<"$excerpt"
    fi
    settle_tracked_job "$job_id"
  done < <(echo "$poll_json" | jq -c '.unsettled[]?')
}

maybe_run_challenge_eval() {
  local issue="$1" pr="$2" branch="$3" slug="$4"
  local eval_completed eval_failed eval_hard_retry_count eval_hard_retry_max
  local pair_id solution_model linear_issue eval_agent side challenge_stage job_id job_status job_dir log_path result_path pid eval_timeout
  local task_status challenge_aborted
  task_status=$(read_state_value "" --arg i "$issue" '.tasks[$i].status // empty')
  challenge_aborted=$(read_state_value "" --arg i "$issue" '.tasks[$i].challengeAborted // empty')
  if [[ "$task_status" == "aborted" || ( -n "$challenge_aborted" && -z "$pr" ) ]]; then
    log "debug" "challenge eval skipped for $issue: aborted/no-PR arm"
    return 0
  fi
  eval_completed=$(read_state_value "false" --arg i "$issue" '.tasks[$i].evalCompleted // false')
  [[ "$eval_completed" == "true" ]] && return 0

  pair_id=$(get_task_meta "$issue" "challengePairId")
  if [[ "$(read_state_value "false" --arg i "$issue" '.tasks[$i].challengeCompared // false')" == "true" ]]; then
    if [[ "$(read_state_value "" --arg i "$issue" '.tasks[$i].challengeComparedSource // empty')" == "record" ]]; then
      log "debug" "challenge eval suppressed for $issue by existing challenge record"
    fi
    return 0
  fi
  eval_failed=$(read_state_value "false" --arg i "$issue" '.tasks[$i].evalFailed // false')
  if [[ "$eval_failed" == "true" ]]; then
    # Bounded-retry bucket in the arm's feature dir (HOK-2924). The effective
    # count is max(bucket, state mirror): the evalHardFailureRetryCount mirror
    # stays authoritative for pre-existing state (and for
    # resolve_challenge_pair_hard_failure, which reads it), while the bucket
    # adds the head-keyed reset — a fresh commit zeroes both. The backoff base
    # defaults to 0 (today's cadence); raise it via
    # WAVEMILL_RETRY_BACKOFF_CHALLENGE_EVAL_HARD_BASE_SECONDS.
    local hard_retry_state_dir hard_retry_head hard_retry_prior_head hard_retry_mirror hard_retry_base
    hard_retry_state_dir="${WORKTREE_ROOT}/${slug}/features/${slug}"
    hard_retry_head=$(git -C "${WORKTREE_ROOT}/${slug}" rev-parse HEAD 2>/dev/null || echo "")
    hard_retry_prior_head=$(bounded_retry_head "$hard_retry_state_dir" "challenge-eval-hard")
    bounded_retry_reset_if_new_head "$hard_retry_state_dir" "challenge-eval-hard" "$hard_retry_head"
    if [[ -n "$hard_retry_prior_head" && -n "$hard_retry_head" && "$hard_retry_prior_head" != "$hard_retry_head" ]]; then
      state_mutate "$STATE_FILE" '
        .tasks[$issue].evalHardFailureRetryCount = 0
        | .tasks[$issue].updated = (now | todateiso8601)
      ' --arg issue "$issue" >/dev/null || true
    fi
    eval_hard_retry_count=$(bounded_retry_count "$hard_retry_state_dir" "challenge-eval-hard")
    hard_retry_mirror=$(read_state_value "0" --arg i "$issue" '.tasks[$i].evalHardFailureRetryCount // 0')
    [[ "$hard_retry_mirror" =~ ^[0-9]+$ ]] || hard_retry_mirror=0
    (( hard_retry_mirror > eval_hard_retry_count )) && eval_hard_retry_count="$hard_retry_mirror"
    eval_hard_retry_max=$(challenge_eval_hard_failure_max_retries)
    if (( eval_hard_retry_count < eval_hard_retry_max )); then
      hard_retry_base="${WAVEMILL_RETRY_BACKOFF_CHALLENGE_EVAL_HARD_BASE_SECONDS:-0}"
      [[ "$hard_retry_base" =~ ^[0-9]+$ ]] || hard_retry_base=0
      if ! bounded_retry_due "$hard_retry_state_dir" "challenge-eval-hard" "$hard_retry_base"; then
        log "debug" "challenge eval hard-failure retry for $issue holding (backoff)"
        return 0
      fi
      bounded_retry_increment "$hard_retry_state_dir" "challenge-eval-hard" "$hard_retry_head" >/dev/null
      eval_hard_retry_count=$((eval_hard_retry_count + 1))
      state_mutate "$STATE_FILE" '
        .tasks[$issue].evalFailed = false
        | .tasks[$issue].evalCompleted = false
        | .tasks[$issue].evalHardFailureRetryCount = $retryCount
        | .tasks[$issue].updated = (now | todateiso8601)
      ' --arg issue "$issue" --argjson retryCount "$eval_hard_retry_count" >/dev/null || true
      log "status" "challenge eval retrying for $issue: hard failure (attempt $eval_hard_retry_count/$eval_hard_retry_max)"
    else
      bounded_retry_mark_exhausted "$hard_retry_state_dir" "challenge-eval-hard" \
        "Challenge eval hard-failure retries exhausted for $issue (${eval_hard_retry_count}/${eval_hard_retry_max}) - resolving pair ${pair_id:-unknown}" || true
      resolve_challenge_pair_hard_failure "$pair_id" >/dev/null || true
      return 0
    fi
  fi
  solution_model=$(get_task_meta "$issue" "challengeModel")
  linear_issue=$(get_linear_issue_id "$issue")
  eval_agent=$(read_state_value "" --arg i "$issue" '.tasks[$i].agent // ""')
  [[ -z "$eval_agent" ]] && eval_agent="$AGENT_CMD"
  side=$(get_task_meta "$issue" "challengeRole")
  [[ -z "$side" ]] && side="primary"
  challenge_stage=$(get_task_meta "$issue" "challengeStage")
  job_id=$(build_eval_job_id "$issue" "$side" "$pr")
  job_status=$(read_job_state_value "$job_id" "" '.jobs[$id].status // empty')
  if [[ "$job_status" == "running" || "$job_status" == "succeeded" ]]; then
    return 0
  fi

  job_dir=$(challenge_job_dir)
  log_path="$job_dir/${job_id}.log"
  result_path="$job_dir/${job_id}.result.json"

  log "status" "  📊 [mill] eval running: issue=$issue side=$side pr=#$pr phase=eval"
  if ! mark_challenge_eval_running "$issue" "$side" "$pr" "eval" >/dev/null; then
    log_warn "challenge eval launch skipped for $issue: failed to persist running state"
    return 1
  fi

  npx tsx "$TOOLS_DIR/run-eval-hook.ts" \
    --issue "$linear_issue" --pr "$pr" --branch "$branch" \
    --worktree "${WORKTREE_ROOT}/${slug}" \
    --workflow-type mill --repo-dir "$REPO_DIR" \
    --agent "$eval_agent" \
    --solution-model "$solution_model" \
    --challenge-pair "$pair_id" \
    --challenge-side "$side" \
    --challenge-stage "${challenge_stage:-}" \
    --result-file "$result_path" \
    --debug \
    >"$log_path" 2>&1 &
  pid=$!

  eval_timeout="$(post_merge_eval_timeout_seconds)"
  launch_tracked_job "eval" "$job_id" "$issue" "$side" "$pair_id" "$pr" "$pid" "$eval_timeout" "$log_path" "$result_path"
  log "status" "  📊 Challenge eval running in background for $issue (pid $pid)"
}

post_merge_eval_timeout_seconds() {
  local timeout
  timeout=$(wavemill_load_config "$REPO_DIR" | jq -r '.eval.postMergeTimeoutSeconds // 600' 2>/dev/null || echo "600")
  if [[ "$timeout" =~ ^[0-9]+$ ]] && (( timeout >= 30 )); then
    echo "$timeout"
  else
    echo "600"
  fi
}

launch_background_post_merge_eval() {
  local issue="$1" pr="$2" branch="$3" slug="$4" issue_ref="$5" reason="$6" preresolved_agent="${7:-}"
  local eval_agent eval_log eval_timeout rc result_path persisted

  if should_skip_post_completion_eval "$issue" "$pr" "$branch" "$slug"; then
    return 0
  fi

  if [[ -n "$preresolved_agent" ]]; then
    eval_agent="$preresolved_agent"
  else
    validate_agent_set "$issue"
    eval_agent=$(read_state_value "" --arg i "$issue" '.tasks[$i].agent // ""')
    [[ -z "$eval_agent" ]] && eval_agent="$AGENT_CMD"
  fi

  eval_log="/tmp/${SESSION}-eval-${issue}.log"
  result_path="/tmp/${SESSION:-wavemill}-eval-${issue}-result.json"
  eval_timeout="$(post_merge_eval_timeout_seconds)"
  : >"$eval_log"
  rm -f "$result_path"

  (
    {
      printf 'Launching %s eval in background\n' "$reason"
      if [[ -n "$pr" ]]; then
        if _with_timeout "$eval_timeout" npx tsx "$TOOLS_DIR/run-eval-hook.ts" \
          --issue "$issue_ref" --pr "$pr" --branch "$branch" \
          --worktree "${WORKTREE_ROOT}/${slug}" \
          --workflow-type mill --repo-dir "$REPO_DIR" \
          --agent "$eval_agent" \
          --result-file "$result_path" \
          --debug; then
          rc=0
        else
          rc=$?
        fi
      else
        if _with_timeout "$eval_timeout" npx tsx "$TOOLS_DIR/run-eval-hook.ts" \
          --issue "$issue_ref" --branch "$branch" \
          --worktree "${WORKTREE_ROOT}/${slug}" \
          --workflow-type mill --repo-dir "$REPO_DIR" \
          --agent "$eval_agent" \
          --result-file "$result_path" \
          --debug; then
          rc=0
        else
          rc=$?
        fi
      fi
      printf 'Eval process exited with code %s\n' "$rc"
      persisted=$(jq -r '.persisted // false' "$result_path" 2>/dev/null || echo "false")
      rm -f "$result_path"
      if [[ "$persisted" == "true" ]]; then
        mark_eval_completed "$issue"
      else
        printf 'WARN: Eval not persisted for %s (rc=%s); setting evalFailed=true\n' "$issue" "$rc"
        mark_eval_failed "$issue"
      fi
    } >>"$eval_log" 2>&1
  ) >/dev/null 2>&1 &

  log "debug" "  ↳ Eval running in background; log: $eval_log"
}

task_has_local_commit_evidence() {
  local issue="$1" branch="$2" slug="$3"
  local wt_dir="${WORKTREE_ROOT}/${slug}"
  local ref="$branch"
  [[ -z "$ref" ]] && ref=$(read_state_value "" --arg i "$issue" '.tasks[$i].branch // empty')

  if [[ -n "$ref" ]] && git -C "$REPO_DIR" rev-parse --verify --quiet "$ref" >/dev/null 2>&1; then
    local count
    count=$(git -C "$REPO_DIR" rev-list --count "${BASE_BRANCH}..${ref}" 2>/dev/null || echo "0")
    [[ "$count" =~ ^[0-9]+$ ]] && (( count > 0 )) && return 0
  fi

  if [[ -d "$wt_dir/.git" || -f "$wt_dir/.git" ]]; then
    local wt_count
    wt_count=$(git -C "$wt_dir" rev-list --count "${BASE_BRANCH}..HEAD" 2>/dev/null || echo "0")
    [[ "$wt_count" =~ ^[0-9]+$ ]] && (( wt_count > 0 )) && return 0
  fi

  return 1
}

should_skip_post_completion_eval() {
  local issue="$1" pr="$2" branch="$3" slug="$4"
  local status challenge_aborted state_pr
  status=$(read_state_value "" --arg i "$issue" '.tasks[$i].status // empty')
  challenge_aborted=$(read_state_value "" --arg i "$issue" '.tasks[$i].challengeAborted // empty')
  state_pr=$(read_state_value "" --arg i "$issue" '.tasks[$i].pr // empty')
  [[ -z "$pr" ]] && pr="$state_pr"

  if [[ "$status" == "aborted" ]]; then
    log "debug" "Skipping $issue eval: task is aborted"
    return 0
  fi

  if [[ -n "$challenge_aborted" && -z "$pr" ]]; then
    log "debug" "Skipping $issue eval: challenge-aborted arm has no PR"
    return 0
  fi

  if [[ -z "$pr" ]] && ! task_has_local_commit_evidence "$issue" "$branch" "$slug"; then
    log "debug" "Skipping $issue eval: no PR or local commit evidence"
    return 0
  fi

  return 1
}

maybe_run_challenge_comparison() {
  local issue="$1"
  local pair_id primary_key challenger_key compared primary_pr challenger_pr primary_eval challenger_eval linear_issue primary_model challenger_model
  local primary_slug challenger_slug primary_worktree challenger_worktree primary_feature_dir challenger_feature_dir
  local primary_planner primary_reviewer primary_plan_depth primary_code_depth primary_review_mode
  local challenger_planner challenger_reviewer challenger_plan_depth challenger_code_depth challenger_review_mode
  local job_id job_status job_reason pairing_repaired job_dir log_path result_path pid
  pair_id=$(get_task_meta "$issue" "challengePairId")
  [[ -z "$pair_id" ]] && return 0
  primary_key="$pair_id"
  challenger_key="${pair_id}_c"
  compared=$(read_state_value "false" --arg i "$primary_key" '.tasks[$i].challengeCompared // false')
  [[ "$compared" == "true" ]] && return 0
  if [[ "$(read_state_value "" --arg i "$primary_key" '.tasks[$i].comparisonState // empty')" == "manual_comparison_needed" ]]; then
    return 0
  fi
  if [[ "$(read_state_value "" --arg i "$primary_key" '.tasks[$i].comparisonState // empty')" == "invalid_challenge" ]]; then
    return 0
  fi

  primary_pr=$(read_state_value "" --arg i "$primary_key" '.tasks[$i].pr // empty')
  challenger_pr=$(read_state_value "" --arg i "$challenger_key" '.tasks[$i].pr // empty')
  primary_eval=$(read_state_value "false" --arg i "$primary_key" '.tasks[$i].evalCompleted // false')
  challenger_eval=$(read_state_value "false" --arg i "$challenger_key" '.tasks[$i].evalCompleted // false')
  [[ -z "$primary_pr" || -z "$challenger_pr" || "$primary_eval" != "true" || "$challenger_eval" != "true" ]] && return 0
  job_id=$(build_comparison_job_id "$pair_id" "$primary_pr" "$challenger_pr")
  job_status=$(read_job_state_value "$job_id" "" '.jobs[$id].status // empty')
  if [[ -n "$job_status" ]]; then
    # A prior comparison already ran. By default that's terminal: succeeded /
    # running need no action, and genuinely failing comparisons (LLM errors,
    # invalid scores) must not relaunch every poll and burn repeated LLM calls.
    #
    # The one exception is a failure caused by drifted challenge pairing
    # metadata ("Missing eval records"): the eval scores exist but the
    # challenger record is filed under the wrong pair id. We attempt a single
    # self-healing repair + retry, gated by a one-shot flag so a pair can never
    # loop here. launch_tracked_job upserts by job id, overwriting the failed
    # entry when we proceed below.
    job_reason=$(read_job_state_value "$job_id" "" '.jobs[$id].reason // empty')
    pairing_repaired=$(read_state_value "false" --arg i "$primary_key" '.tasks[$i].comparisonPairingRepaired // false')
    if [[ "$job_status" == "failed" && "$job_reason" == *"Missing eval records"* && "$pairing_repaired" != "true" ]]; then
      log "status" "  ⚖ $pair_id comparison failed on eval pairing — attempting one-shot repair and retry"
      npx tsx "$TOOLS_DIR/repair-challenge-pairing.ts" --pair-id "$pair_id" --repo-dir "$REPO_DIR" >/dev/null 2>&1 || \
        log_warn "challenge pairing repair failed for $pair_id (continuing to retry comparison)"
      state_mutate "$STATE_FILE" '.tasks[$i].comparisonPairingRepaired = true' --arg i "$primary_key" >/dev/null || true
    else
      return 0
    fi
  fi

  linear_issue=$(get_linear_issue_id "$primary_key")
  primary_model=$(get_task_meta "$primary_key" "challengeModel")
  challenger_model=$(get_task_meta "$challenger_key" "challengeModel")
  primary_slug=$(get_task_meta "$primary_key" "slug")
  challenger_slug=$(get_task_meta "$challenger_key" "slug")
  primary_worktree=$(get_task_meta "$primary_key" "worktree")
  challenger_worktree=$(get_task_meta "$challenger_key" "worktree")
  [[ -z "$primary_worktree" && -n "$primary_slug" ]] && primary_worktree="${WORKTREE_ROOT}/${primary_slug}"
  [[ -z "$challenger_worktree" && -n "$challenger_slug" ]] && challenger_worktree="${WORKTREE_ROOT}/${challenger_slug}"
  primary_feature_dir=""
  challenger_feature_dir=""
  [[ -n "$primary_worktree" && -n "$primary_slug" ]] && primary_feature_dir="$primary_worktree/features/$primary_slug"
  [[ -n "$challenger_worktree" && -n "$challenger_slug" ]] && challenger_feature_dir="$challenger_worktree/features/$challenger_slug"

  # Read routing metadata for both sides
  primary_planner=$(get_task_meta "$primary_key" "plannerModel")
  primary_reviewer=$(get_task_meta "$primary_key" "reviewerModel")
  primary_plan_depth=$(get_task_meta "$primary_key" "planDepth")
  primary_code_depth=$(get_task_meta "$primary_key" "codeDepth")
  primary_review_mode=$(get_task_meta "$primary_key" "reviewMode")

  challenger_planner=$(get_task_meta "$challenger_key" "plannerModel")
  challenger_reviewer=$(get_task_meta "$challenger_key" "reviewerModel")
  challenger_plan_depth=$(get_task_meta "$challenger_key" "planDepth")
  challenger_code_depth=$(get_task_meta "$challenger_key" "codeDepth")
  challenger_review_mode=$(get_task_meta "$challenger_key" "reviewMode")

  log "status" "  ⚖ [mill] comparison running: pair=$pair_id primary_pr=#$primary_pr challenger_pr=#$challenger_pr"
  job_dir=$(challenge_job_dir)
  log_path="$job_dir/${job_id}.log"
  result_path="$job_dir/${job_id}.result.json"
  if ! mark_challenge_comparison_running "$pair_id" "$primary_pr" "$challenger_pr" >/dev/null; then
    log_warn "challenge comparison launch skipped for $pair_id: failed to persist running state"
    return 1
  fi
  npx tsx "$TOOLS_DIR/compare-prs.ts" \
    --issue "$linear_issue" --pair-id "$pair_id" \
    --primary-pr "$primary_pr" --challenger-pr "$challenger_pr" \
    --primary-model "$primary_model" --challenger-model "$challenger_model" \
    --primary-planner "$primary_planner" --primary-reviewer "$primary_reviewer" \
    --primary-plan-depth "$primary_plan_depth" --primary-code-depth "$primary_code_depth" --primary-review-mode "$primary_review_mode" \
    --challenger-planner "$challenger_planner" --challenger-reviewer "$challenger_reviewer" \
    --challenger-plan-depth "$challenger_plan_depth" --challenger-code-depth "$challenger_code_depth" --challenger-review-mode "$challenger_review_mode" \
    --primary-feature-dir "${primary_feature_dir:-}" --challenger-feature-dir "${challenger_feature_dir:-}" \
    --repo-dir "$REPO_DIR" --comment \
    --result-file "$result_path" \
    >"$log_path" 2>&1 &
  pid=$!

  launch_tracked_job "comparison" "$job_id" "" "" "$pair_id" "${primary_pr},${challenger_pr}" "$pid" "240" "$log_path" "$result_path"
  log "status" "  ⚖ Challenge comparison running in background for $pair_id (pid $pid)"
}

maybe_resolve_unresolvable_challenge_pair() {
  local issue="$1"
  local pair_id resolve_output resolve_status resolve_reason

  pair_id=$(get_task_meta "$issue" "challengePairId")
  [[ -n "$pair_id" ]] || return 0

  if challenge_pair_record_exists "$pair_id"; then
    mark_challenge_compared "$pair_id" "record" >/dev/null || true
    return 0
  fi

  resolve_output=$(npx tsx "$TOOLS_DIR/resolve-orphan-challenge-pair.ts" \
    --pair-id "$pair_id" \
    --repo-dir "$REPO_DIR" 2>/dev/null || true)
  resolve_status=$(jq -r '.status // empty' <<<"$resolve_output" 2>/dev/null || true)

  case "$resolve_status" in
    resolved)
      resolve_reason=$(jq -r '.reason // "unknown"' <<<"$resolve_output" 2>/dev/null || echo "unknown")
      mark_challenge_compared "$pair_id" >/dev/null || true
      log_warn "challenge pair $pair_id resolved automatically via $resolve_reason"
      if [[ "$resolve_reason" == "sibling-challenge-aborted" || "$resolve_reason" == "both-challenge-aborted" ]]; then
        cleanup_pair_aborted_no_pr_arms "$pair_id" "$resolve_reason"
      fi
      ;;
    already-resolved)
      mark_challenge_compared "$pair_id" >/dev/null || true
      cleanup_pair_aborted_no_pr_arms "$pair_id" "challenge pair already resolved"
      ;;
  esac
}

resolve_pair_on_primary_merge() {
  local issue="$1"
  local pr="$2"
  local role pair_id resolve_output resolve_status resolve_reason

  role=$(get_task_meta "$issue" "challengeRole")
  pair_id=$(get_task_meta "$issue" "challengePairId")
  [[ "$role" == "primary" && -n "$pair_id" && -n "$pr" ]] || return 0

  resolve_output=$(npx tsx "$TOOLS_DIR/resolve-primary-merged-pair.ts" \
    --pair-id "$pair_id" \
    --primary-pr "$pr" \
    --repo-dir "$REPO_DIR" 2>/dev/null || true)
  resolve_status=$(jq -r '.status // empty' <<<"$resolve_output" 2>/dev/null || true)

  case "$resolve_status" in
    resolved)
      resolve_reason=$(jq -r '.reason // "unknown"' <<<"$resolve_output" 2>/dev/null || echo "unknown")
      mark_challenge_compared "$pair_id" >/dev/null || true
      log_warn "challenge pair $pair_id resolved automatically via $resolve_reason"
      ;;
    already-resolved)
      mark_challenge_compared "$pair_id" "record" >/dev/null || true
      log "status" "challenge pair $pair_id already resolved, primary merge cleanup continuing"
      ;;
    skipped|"")
      resolve_reason=$(jq -r '.reason // "unknown"' <<<"$resolve_output" 2>/dev/null || echo "unknown")
      log_warn "challenge pair $pair_id primary-merge resolver skipped: $resolve_reason"
      ;;
  esac
}

cleanup_merged_primary_challenge_task() {
  local issue="$1" slug="$2" completion_reason="${3:-}"
  local pr="${4:-}" role pair_id preserved

  role=$(get_task_meta "$issue" "challengeRole")
  pair_id=$(get_task_meta "$issue" "challengePairId")
  if [[ "$role" != "primary" || -z "$pair_id" ]]; then
    cleanup_completed_task "$issue" "$slug" "$completion_reason"
    return $?
  fi

  preserved=$(jq -c \
    --arg issue "$issue" \
    --arg slug "$slug" \
    --arg pr "$pr" \
    --arg pair_id "$pair_id" \
    '
    (.tasks[$issue] // {}) as $task
    | ($pr | tonumber? // $task.pr // $task.prNumber // null) as $merged_pr
    | {
        pr: $merged_pr,
        prNumber: ($task.prNumber // $merged_pr),
        branch: $task.branch,
        slug: ($task.slug // $slug),
        challengePairId: ($task.challengePairId // $pair_id),
        challengeRole: ($task.challengeRole // "primary"),
        challengeModel: $task.challengeModel,
        evalCompleted: ($task.evalCompleted // true),
        status: "merged",
        phase: "merged"
      }
    | with_entries(select(.value != null))
    ' "$STATE_FILE" 2>/dev/null || printf '{}')

  cleanup_completed_task "$issue" "$slug" "$completion_reason" || return $?

  if ! state_mutate "$STATE_FILE" \
    '.tasks[$issue] = ($preserved + {updated: (now | todate)}) | .updated = (now | todate)' \
    --arg issue "$issue" \
    --argjson preserved "$preserved"; then
    log_warn "cleanup_merged_primary_challenge_task: failed to preserve $issue challenge metadata"
  fi
}

mark_task_aborted_for_cleanup() {
  local issue="$1" reason="${2:-challenge arm cleanup}"
  if ! state_mutate "$STATE_FILE" '
    if .tasks[$issue] == null then
      .
    else
      .tasks[$issue].status = "aborted"
      | .tasks[$issue].phase = "aborted"
      | .tasks[$issue].abortedCleanupReason = $reason
      | .tasks[$issue].abortedCleanupAt = (now | todateiso8601)
      | .tasks[$issue].updated = (now | todateiso8601)
    end
  ' --arg issue "$issue" --arg reason "$reason" >/dev/null; then
    log_warn "mark_task_aborted_for_cleanup: failed to terminalize $issue"
    return 1
  fi
  return 0
}

cleanup_quarantined_no_pr_challenge_arm() {
  local issue="$1" feature_dir="${2:-}" stage="${3:-challenge}" reason="${4:-challenge quarantined}"
  local is_challenge pr slug

  [[ -n "$issue" ]] || return 1
  is_challenge="$(get_task_meta "$issue" "challenge" 2>/dev/null || true)"
  [[ "$is_challenge" == "true" ]] || return 1

  pr=$(read_state_value "" --arg i "$issue" '.tasks[$i].pr // empty')
  [[ -z "$pr" ]] || return 1

  slug=$(read_state_value "" --arg i "$issue" '.tasks[$i].slug // empty')
  if [[ -z "$slug" && -n "$feature_dir" ]]; then
    slug="$(basename "$feature_dir")"
  fi
  [[ -n "$slug" ]] || return 1

  cleanup_aborted_challenge_arm "$issue" "$slug" "quarantined ${stage}: ${reason}"
}

cleanup_aborted_challenge_arm() {
  local issue="$1" slug="${2:-}" reason="${3:-challenge aborted}"
  local win target target_gone wt_dir task_branch state_branch pr

  [[ -z "$slug" ]] && slug=$(read_state_value "" --arg i "$issue" '.tasks[$i].slug // empty')
  [[ -n "$slug" ]] || {
    log_warn "$issue aborted challenge cleanup skipped: missing slug"
    return 1
  }

  win="$issue-$slug"
  wt_dir=$(read_state_value "" --arg i "$issue" '.tasks[$i].worktree // empty')
  [[ -z "$wt_dir" ]] && wt_dir="${WORKTREE_ROOT}/${slug}"
  state_branch=$(read_state_value "" --arg i "$issue" '.tasks[$i].branch // empty')
  task_branch="${state_branch:-task/${slug}}"
  pr=$(read_state_value "" --arg i "$issue" '.tasks[$i].pr // empty')

  archive_stage_artifacts "$issue" "$slug"

  if ! mark_task_aborted_for_cleanup "$issue" "$reason"; then
    return 1
  fi

  target_gone="false"
  target="$(_tmux_task_window_target "$SESSION" "$issue" "$slug" "${STATE_FILE:-}" "$wt_dir" 2>/dev/null || true)"
  if [[ -z "$target" ]] || ! command -v tmux >/dev/null 2>&1; then
    target_gone="true"
  else
    tmux kill-window -t "$(_tmux_target_join "$SESSION" "$target")" 2>/dev/null || true
    if ! _tmux_window_target_exists "$SESSION" "$target"; then
      target_gone="true"
    fi
  fi

  if [[ "$target_gone" != "true" ]]; then
    set_window_attention_state "$win" "needs-user"
	    log_warn "  $issue aborted challenge cleanup could not close tmux window, task is terminal and cleanup will retry"
    return 1
  fi

  log "debug" "Closed window: $win"

  if [[ -n "$pr" ]]; then
    log_warn "  $issue: PR #$pr exists - preserving worktree and local branch (aborted task)"
    set_window_attention_state "$win" "needs-user"
    rm -f "/tmp/wavemill-${SESSION}-${issue}.hook" 2>/dev/null || true
    reset_retry_count "$SESSION" "$issue" 2>/dev/null || true
    remove_task_state "$issue"
    CLEANED["$issue"]=1
    log "$issue: Complete (aborted cleanup, worktree preserved due to PR #$pr)"
    return 0
  fi

  local cleanup_rc=0
  safe_remove_task_worktree_and_branch "$wt_dir" "$task_branch" "${BASE_BRANCH:-main}" "cleanup_aborted_challenge_arm" || cleanup_rc=$?
  if [[ "$cleanup_rc" -eq 10 ]]; then
    set_window_attention_state "$win" "needs-user"
    log_warn "  $issue aborted challenge cleanup preserved local work; keeping task state"
    return 1
  fi
  if [[ "$cleanup_rc" -eq 20 ]]; then
    set_window_attention_state "$win" "needs-user"
    log_warn "  $issue aborted challenge cleanup failed; keeping task state"
    return 1
  fi

  if [[ -n "$pr" ]]; then
    log "debug" "$issue: retaining remote branch ${state_branch:-task/${slug}} (aborted cleanup does not delete PR branches)"
  fi

  git -C "$REPO_DIR" worktree prune >>"${MILL_LOG_FILE:-/dev/null}" 2>/dev/null || true
  rm -f "/tmp/wavemill-${SESSION}-${issue}.hook" 2>/dev/null || true
  reset_retry_count "$SESSION" "$issue" 2>/dev/null || true
  remove_task_state "$issue"
  CLEANED["$issue"]=1
  log "$issue: Complete (aborted challenge cleanup)"
}

cleanup_pair_aborted_no_pr_arms() {
  local pair_id="$1" reason="${2:-challenge pair resolved}"
  local key slug pr challenge_aborted
  for key in "$pair_id" "${pair_id}_c"; do
    challenge_aborted=$(read_state_value "" --arg i "$key" '.tasks[$i].challengeAborted // empty')
    [[ -n "$challenge_aborted" ]] || continue
    pr=$(read_state_value "" --arg i "$key" '.tasks[$i].pr // empty')
    [[ -z "$pr" ]] || continue
    slug=$(read_state_value "" --arg i "$key" '.tasks[$i].slug // empty')
    [[ -n "$slug" ]] || continue
    cleanup_aborted_challenge_arm "$key" "$slug" "$reason" || true
  done
}

# ============================================================================
# GIT/GITHUB FUNCTIONS
# ============================================================================
# Functions for PR detection and merge validation.

find_pr_for_branch() {
  local branch="$1"
  local cached
  cached=$(wavemill_pr_lookup_by_branch "$branch")
  if [[ -n "$cached" ]]; then
    echo "$cached"
    return
  fi
  _with_timeout "$API_TIMEOUT" gh pr list --head "$branch" --state all --json number --jq '.[0].number // empty' 2>/dev/null || echo ""
}

inject_depends_on_pr_block() {
  local issue="${1:-}" pr_number="${2:-}" meta_json="${3:-}"
  if [[ -z "$issue" || -z "$pr_number" || -z "$meta_json" ]]; then
    echo "Usage: inject_depends_on_pr_block <issue> <pr_number> <meta_json>" >&2
    return 1
  fi

  local current_body
  if ! current_body=$(_with_timeout "$API_TIMEOUT" gh pr view "$pr_number" --json body --jq '.body // ""' 2>/dev/null); then
    log_warn "$issue: could not read PR #$pr_number body for depends_on metadata"
    return 0
  fi
  if [[ "$current_body" == *"depends_on:"* ]]; then
    return 0
  fi

  local depends_block
  depends_block=$(jq -r '
    "depends_on:\n" +
    "  - pr: \"#" + (.number | tostring) + "\"\n" +
    "    issue: \"" + .parent_issue + "\"\n" +
    "    branch: \"" + .branch + "\"\n" +
    "    url: \"" + .url + "\""
  ' <<<"$meta_json" 2>/dev/null) || {
    log_warn "$issue: could not build depends_on metadata block for PR #$pr_number"
    return 0
  }

  local new_body="$depends_block"
  if [[ -n "$current_body" ]]; then
    new_body+=$'\n\n'"$current_body"
  fi

  if ! _with_timeout "$API_TIMEOUT" gh pr edit "$pr_number" --body "$new_body" >/dev/null 2>&1; then
    log_warn "$issue: could not update PR #$pr_number with depends_on metadata"
  fi
}

dispatch_queued_children_for_parent() {
  local parent_issue="${1:-}" parent_pr_number="${2:-}"
  if [[ -z "$parent_issue" || -z "$parent_pr_number" ]]; then
    echo "Usage: dispatch_queued_children_for_parent <parent_issue> <pr_number>" >&2
    return 1
  fi

  local children_json
  children_json=$(find_queued_children_for_parent "$parent_issue") || return 1
  [[ "$children_json" == "[]" ]] && return 0

  local parent_branch="" resolved_pr_number="" parent_pr_url="" resolve_reason=""
  local resolve_err
  resolve_err=$(mktemp) || return 1
  if IFS='|' read -r parent_branch resolved_pr_number parent_pr_url < <(resolve_parent_pr_branch "$parent_pr_number" 2>"$resolve_err"); then
    :
  else
    resolve_reason=$(tr '\n' ' ' <"$resolve_err" | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//')
  fi
  rm -f "$resolve_err"

  local child_issue child_slug child_title entry
  while IFS= read -r entry; do
    [[ -n "$entry" ]] || continue
    child_issue=$(jq -r '.issue_id' <<<"$entry")
    child_slug=$(jq -r '.slug // ""' <<<"$entry")
    child_title=$(jq -r '.title // ""' <<<"$entry")

    if [[ -z "$child_slug" ]]; then
      child_slug="${child_issue,,}"
    fi
    if [[ -z "$child_title" ]]; then
      child_title="$child_issue"
    fi

    if [[ -n "$parent_branch" ]]; then
      record_depends_on_metadata "$child_issue" "$resolved_pr_number" "$parent_pr_url" "$parent_branch" "$parent_issue" || {
        log_warn "$child_issue: failed to record depends_on metadata"
        continue
      }
      queue_remove_task "$child_issue" || {
        log_warn "$child_issue: failed to remove queued dependency entry"
        continue
      }

      BRANCH_BY_ISSUE["$child_issue"]="task/${child_slug}"
      SLUG_BY_ISSUE["$child_issue"]="$child_slug"

      if ! launch_task "$child_issue" "$child_slug" "$child_title" 1 "$parent_branch"; then
        log_warn "$child_issue: failed to launch from parent PR branch $parent_branch"
      fi
    else
      local reason="parent_pr_branch_unresolvable: ${resolve_reason:-unknown error}"
      queue_mark_waiting "$child_issue" "$reason" || log_warn "$child_issue: failed to mark queued dependency waiting"
      log_warn "$child_issue -> queued waiting: $reason"
    fi
  done < <(jq -c '.[]' <<<"$children_json")
}

# pr_state() and validate_pr_merge() are provided by wavemill-common.sh (HOK-2904).


# ============================================================================
# LINEAR API FUNCTIONS
# ============================================================================
# Functions for updating Linear issue states.
# Note: linear_set_state() and linear_is_completed() now provided by wavemill-common.sh (HOK-2901)

prepare_route_input_for_issue() {
  local issue="$1" slug="$2" title="$3"
  local linear_issue issue_json issue_desc packet_file feature_dir selected_task_file

  linear_issue=$(get_linear_issue_id "$issue")
  packet_file="/tmp/${SESSION}-${issue}-taskpacket.md"
  feature_dir="${WORKTREE_ROOT}/${slug}/features/${slug}"
  selected_task_file="$feature_dir/selected-task.json"

  if [[ -f "/tmp/${SESSION}-${issue}-issue.json" ]]; then
    issue_json=$(cat "/tmp/${SESSION}-${issue}-issue.json" 2>/dev/null || echo "{}")
  else
    issue_json=$(_with_timeout "$API_TIMEOUT" npx tsx "$TOOLS_DIR/get-issue.ts" "$linear_issue" --json 2>/dev/null || echo "{}")
    echo "$issue_json" > "/tmp/${SESSION}-${issue}-issue.json"
  fi

  issue_desc=$(echo "$issue_json" | jq -r '.description // ""' 2>/dev/null || echo "")

  if [[ ! -s "$packet_file" ]]; then
    if [[ -f "$selected_task_file" ]] && jq -e '.title or .description' "$selected_task_file" >/dev/null 2>&1; then
      jq -r '[(.title // ""), (.description // "")] | map(select(length > 0)) | join("\n\n")' \
        "$selected_task_file" > "$packet_file" 2>/dev/null || true
      [[ -s "$packet_file" ]] && log "info" "  Created minimal routing packet from selected-task.json"
    fi
  fi

  if [[ ! -s "$packet_file" ]]; then
    printf '%s\n\n%s\n' "$title" "$issue_desc" > "$packet_file"
    log "info" "  Created minimal routing packet from title and description"
  fi

  if [[ -s "$packet_file" ]]; then
    printf '%s\n' "$packet_file"
    return 0
  fi

  return 1
}

apply_route_json_for_issue() {
  local issue="$1" route_json="$2" source="${3:-startup-cache}"
  local route_file="/tmp/${SESSION}-${issue}-route.json"
  local route_source_file="/tmp/${SESSION}-${issue}-route-source.txt"
  local input_kind="cache"
  local route_mode
  route_mode="$(_global_operating_mode)"

  if [[ -z "$route_json" ]] || ! echo "$route_json" | jq -e '.planner and .coder and .reviewer' >/dev/null 2>&1; then
    return 1
  fi

  if [[ "$source" == "heuristic-fallback" ]]; then
    input_kind="heuristic"
  fi

  route_json="$(echo "$route_json" | jq -c \
    --arg source "$source" \
    --arg inputKind "$input_kind" \
    --arg routerMode "$route_mode" \
    '(.provenance // {}) as $p
    | .provenance = ($p + {
        source: $source,
        inputKind: ($p.inputKind // $inputKind),
        inputPath: ($p.inputPath // ""),
        inputHash: ($p.inputHash // ""),
        routedAt: ($p.routedAt // (now | todateiso8601)),
        routerMode: ($p.routerMode // $routerMode)
      })')"

  printf '%s\n' "$route_json" > "$route_file"
  printf '%s\n' "$source" > "$route_source_file"
  return 0
}

batch_route_selected_tasks() {
  local selected_lines="$1"
  local route_batch_tool="$TOOLS_DIR/route-tasks.ts"
  local route_jsonl_file route_output_file route_stderr_file
  local count=0 idx issue slug title packet_file route_json
  local -a route_issues=()
  local -a route_lines=()
  local -a route_max_cost_args=()

  if [[ "${ROUTER_ENABLED:-true}" != "true" ]] || [[ ! -f "$route_batch_tool" ]] || [[ -z "$selected_lines" ]]; then
    return 1
  fi

  route_jsonl_file="/tmp/${SESSION}-dynamic-route-batch-input.jsonl"
  route_output_file="/tmp/${SESSION}-dynamic-route-batch-output.jsonl"
  route_stderr_file="/tmp/${SESSION}-dynamic-route-batch.stderr"

  [[ -n "${DEFAULT_MAX_COST_USD:-}" ]] && route_max_cost_args=(--max-cost "$DEFAULT_MAX_COST_USD")
  : > "$route_jsonl_file"

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    IFS='|' read -r issue slug title _sel_area _sel_score _sel_blocked <<<"$line"
    if packet_file=$(prepare_route_input_for_issue "$issue" "$slug" "$title"); then
      jq -cn \
        --arg issueId "$issue" \
        --arg file "$packet_file" \
        --arg source "expanded" \
        --arg inputKind "task-packet" \
        '{issueId: $issueId, file: $file, source: $source, inputKind: $inputKind}' >> "$route_jsonl_file"
      printf '\n' >> "$route_jsonl_file"
      route_issues+=("$issue")
      count=$((count + 1))
    fi
  done <<<"$selected_lines"

  if (( count < 2 )); then
    rm -f "$route_jsonl_file" "$route_output_file" "$route_stderr_file"
    return 1
  fi

  if ! _with_timeout "$API_TIMEOUT" npx tsx "$route_batch_tool" --jsonl "$route_jsonl_file" --repo-dir "$REPO_DIR" "${route_max_cost_args[@]}" >"$route_output_file" 2>"$route_stderr_file"; then
    replay_route_transparency_logs "$route_stderr_file"
    rm -f "$route_jsonl_file" "$route_output_file" "$route_stderr_file"
    return 1
  fi

  replay_route_transparency_logs "$route_stderr_file"
  mapfile -t route_lines < <(grep -v '^[[:space:]]*$' "$route_output_file" 2>/dev/null || true)
  if (( ${#route_lines[@]} != count )); then
    rm -f "$route_jsonl_file" "$route_output_file" "$route_stderr_file"
    return 1
  fi

  for idx in "${!route_lines[@]}"; do
    issue="${route_issues[$idx]}"
    route_json="${route_lines[$idx]}"
    if ! apply_route_json_for_issue "$issue" "$route_json" "batch-cache"; then
      rm -f "$route_jsonl_file" "$route_output_file" "$route_stderr_file"
      return 1
    fi
  done

  rm -f "$route_jsonl_file" "$route_output_file" "$route_stderr_file"
  return 0
}

append_expanded_reroute_input() {
  local jsonl_file="$1" issue="$2" slug="$3" feature_dir="$4"
  local output_file="$feature_dir/.post-expansion-route.json"
  local full_packet="$feature_dir/task-packet.md"
  local header_file="$feature_dir/task-packet-header.md"
  local details_file="$feature_dir/task-packet-details.md"

  if [[ -f "$full_packet" ]]; then
    jq -cn \
      --arg issueId "$issue" \
      --arg slug "$slug" \
      --arg featureDir "$feature_dir" \
      --arg packetFile "$full_packet" \
      --arg outputFile "$output_file" \
      '{issueId: $issueId, slug: $slug, featureDir: $featureDir, packetFile: $packetFile, outputFile: $outputFile}' >> "$jsonl_file"
    printf '\n' >> "$jsonl_file"
    return 0
  fi

  if [[ -f "$header_file" && -f "$details_file" ]]; then
    jq -cn \
      --arg issueId "$issue" \
      --arg slug "$slug" \
      --arg featureDir "$feature_dir" \
      --arg headerFile "$header_file" \
      --arg detailsFile "$details_file" \
      --arg outputFile "$output_file" \
      '{issueId: $issueId, slug: $slug, featureDir: $featureDir, headerFile: $headerFile, detailsFile: $detailsFile, outputFile: $outputFile}' >> "$jsonl_file"
    printf '\n' >> "$jsonl_file"
    return 0
  fi

  return 1
}

reroute_expanded_packets_for_coding_handoff() {
  local current_issue="$1" current_slug="$2" current_feature_dir="$3"
  local route_batch_tool="$TOOLS_DIR/route-tasks.ts"
  local input_file output_file stderr_file
  local -a route_max_cost_args=()
  local count=0
  REROUTE_EXPANDED_LAST_REASON=""

  if [[ ! -f "$route_batch_tool" ]]; then
    REROUTE_EXPANDED_LAST_REASON="disabled"
    return 1
  fi

  input_file="/tmp/${SESSION}-${current_issue}-expanded-reroute-input.jsonl"
  output_file="/tmp/${SESSION}-${current_issue}-expanded-reroute-output.jsonl"
  stderr_file="/tmp/${SESSION}-${current_issue}-expanded-reroute.stderr"
  : > "$input_file"

  if ! append_expanded_reroute_input "$input_file" "$current_issue" "$current_slug" "$current_feature_dir"; then
    REROUTE_EXPANDED_LAST_REASON="not_eligible"
    rm -f "$input_file" "$output_file" "$stderr_file"
    return 1
  fi
  count=$((count + 1))

  if [[ -f "${STATE_FILE:-}" ]]; then
    local sibling_issue sibling_slug sibling_worktree sibling_feature_dir
    while IFS=$'\t' read -r sibling_issue sibling_slug sibling_worktree; do
      [[ -n "$sibling_issue" && -n "$sibling_slug" && -n "$sibling_worktree" ]] || continue
      [[ "$sibling_issue" == "$current_issue" ]] && continue

      sibling_feature_dir="$sibling_worktree/features/$sibling_slug"
      [[ -d "$sibling_feature_dir" ]] || continue
      [[ -f "$sibling_feature_dir/.post-expansion-route.json" ]] && continue
      [[ -f "$sibling_feature_dir/.coding-result.json" ]] && continue
      [[ -f "$sibling_feature_dir/.planning-result.json" ]] || continue
      if ! jq -e '.status == "completed"' "$sibling_feature_dir/.planning-result.json" >/dev/null 2>&1; then
        continue
      fi

      if append_expanded_reroute_input "$input_file" "$sibling_issue" "$sibling_slug" "$sibling_feature_dir"; then
        count=$((count + 1))
      fi
    done < <(jq -r '.tasks | to_entries[] | select(.key != "" and ((.value.slug // "") != "")) | [.key, (.value.slug // ""), (.value.worktree // "")] | @tsv' "$STATE_FILE" 2>/dev/null || true)
  fi

  [[ -n "${DEFAULT_MAX_COST_USD:-}" ]] && route_max_cost_args=(--max-cost "$DEFAULT_MAX_COST_USD")

  if ! _with_timeout "$API_TIMEOUT" npx tsx "$route_batch_tool" \
    --expanded-jsonl "$input_file" \
    --repo-dir "$REPO_DIR" \
    "${route_max_cost_args[@]}" >"$output_file" 2>"$stderr_file"; then
    REROUTE_EXPANDED_LAST_REASON="routing_error"
    replay_route_transparency_logs "$stderr_file"
    if [[ -f "$current_feature_dir/.post-expansion-route.json" ]]; then
      REROUTE_EXPANDED_LAST_REASON="routing_error_using_existing_artifact"
      log_route_lifecycle "expansion_skipped" \
        "issue=$current_issue" \
        "reason=routing_error_using_existing_artifact" \
        "active_route=\"$(route_lifecycle_route_id "$current_feature_dir/.routing-complete" 2>/dev/null || true)\""
      rm -f "$input_file" "$output_file" "$stderr_file"
      return 0
    fi
    rm -f "$input_file" "$output_file" "$stderr_file"
    return 1
  fi

  replay_route_transparency_logs "$stderr_file"
  rm -f "$input_file" "$output_file" "$stderr_file"
  return 0
}

handle_expanded_reroute_handoff_failure() {
  local issue="$1" feature_dir="$2"
  local reason="${REROUTE_EXPANDED_LAST_REASON:-routing_error}"
  local active_route
  active_route="$(route_lifecycle_route_id "$feature_dir/.routing-complete" 2>/dev/null || true)"

  case "$reason" in
    disabled|not_eligible)
      log_route_lifecycle "expansion_skipped" \
        "issue=$issue" \
        "reason=$reason" \
        "active_route=\"$active_route\""
      log "info" "$issue → expanded reroute skipped ($reason), attempting promotion from existing artifacts"
      ;;
    *)
      log_route_lifecycle "expansion_failed" \
        "issue=$issue" \
        "reason=$reason" \
        "active_route=\"$active_route\""
      log_warn "$issue → expanded reroute helper failed, attempting promotion from existing artifacts"
      ;;
  esac
}

recover_missing_expansion_artifact() {
  local issue="$1" slug="$2" feature_dir="$3"
  local expand_tool="$TOOLS_DIR/expand-issue.ts"
  local packet_file="$feature_dir/task-packet.md"
  local route_file="$feature_dir/.post-expansion-route.json"
  local recovery_log_dir="$REPO_DIR/.wavemill/logs"
  local recovery_log_file="$recovery_log_dir/expansion-recovery-${issue}.log"
  local recovery_timeout="" recovery_issue=""
  local packet_content="" detail="" rc=0

  if expansion_recovery_already_attempted "$feature_dir"; then
    log "warn" "[expansion-handshake] RECOVERY_SKIPPED_ALREADY_ATTEMPTED issue=$issue"
    return 1
  fi

  if ! expansion_recovery_mark_attempted "$feature_dir" "$issue" "missing"; then
    log "warn" "[expansion-handshake] RECOVERY_FAILED issue=$issue detail=failed-to-record-attempt"
    return 1
  fi

  mkdir -p "$recovery_log_dir"

  if [[ ! -f "$expand_tool" ]]; then
    detail="expand-tool-missing"
    expansion_recovery_mark_result "$feature_dir" "$issue" "failed" "$detail" "127" || true
    log "warn" "[expansion-handshake] RECOVERY_FAILED issue=$issue detail=$detail"
    return 1
  fi

  if ! recovery_issue="$(expansion_recovery_resolve_issue_id "$issue")"; then
    detail="synthetic-challenger-linear-issue-id-missing-or-invalid"
    expansion_recovery_mark_result "$feature_dir" "$issue" "skipped" "$detail" "0" || true
    log "warn" "[expansion-handshake] RECOVERY_SKIPPED issue=$issue detail=$detail"
    return 1
  fi

  recovery_timeout="$(get_expansion_handshake_timeout_seconds "$REPO_DIR")"
  if _with_timeout "$recovery_timeout" npx tsx "$expand_tool" "$recovery_issue" --output "$packet_file" >"$recovery_log_file" 2>&1; then
    :
  else
    rc=$?
    if [[ "$rc" == "124" || "$rc" == "143" ]]; then
      detail="expand-issue-timed-out"
    else
      detail="expand-issue-exited-non-zero"
    fi
    expansion_recovery_mark_result "$feature_dir" "$issue" "failed" "$detail" "$rc" || true
    if [[ "$detail" == "expand-issue-timed-out" ]]; then
      log "warn" "[expansion-handshake] RECOVERY_FAILED issue=$issue detail=$detail timeoutSeconds=$recovery_timeout exit=$rc log=\"$recovery_log_file\""
    else
      log "warn" "[expansion-handshake] RECOVERY_FAILED issue=$issue detail=$detail exit=$rc log=\"$recovery_log_file\""
    fi
    return 1
  fi

  packet_content="$(cat "$packet_file" 2>/dev/null || echo "")"
  if [[ ! -s "$packet_file" ]] || ! is_task_packet "$packet_content"; then
    detail="expanded-task-packet-missing-or-invalid"
    expansion_recovery_mark_result "$feature_dir" "$issue" "failed" "$detail" "1" || true
    log "warn" "[expansion-handshake] RECOVERY_FAILED issue=$issue detail=$detail log=\"$recovery_log_file\""
    return 1
  fi

  if ! reroute_expanded_packets_for_coding_handoff "$issue" "$slug" "$feature_dir"; then
    detail="expanded-reroute-${REROUTE_EXPANDED_LAST_REASON:-failed}"
    expansion_recovery_mark_result "$feature_dir" "$issue" "failed" "$detail" "1" || true
    log "warn" "[expansion-handshake] RECOVERY_FAILED issue=$issue detail=$detail log=\"$recovery_log_file\""
    return 1
  fi

  if [[ ! -f "$route_file" ]]; then
    detail="expanded-route-artifact-missing-after-reroute"
    expansion_recovery_mark_result "$feature_dir" "$issue" "failed" "$detail" "1" || true
    log "warn" "[expansion-handshake] RECOVERY_FAILED issue=$issue detail=$detail log=\"$recovery_log_file\""
    return 1
  fi

  if ! jq -e '.' "$route_file" >/dev/null 2>&1; then
    detail="expanded-route-invalid-json-after-reroute"
    expansion_recovery_mark_result "$feature_dir" "$issue" "failed" "$detail" "1" || true
    log "warn" "[expansion-handshake] RECOVERY_FAILED issue=$issue detail=$detail log=\"$recovery_log_file\""
    return 1
  fi

  if ! validate_expanded_route_artifact "$route_file"; then
    detail="expanded-route-missing-required-field-after-reroute"
    expansion_recovery_mark_result "$feature_dir" "$issue" "failed" "$detail" "1" || true
    log "warn" "[expansion-handshake] RECOVERY_FAILED issue=$issue detail=$detail log=\"$recovery_log_file\""
    return 1
  fi

  expansion_recovery_mark_result "$feature_dir" "$issue" "succeeded" "expanded-route-recovered" "0" || true
  log "info" "[expansion-handshake] RECOVERY_OK issue=$issue log=\"$recovery_log_file\""
  return 0
}


# ============================================================================
# BACKLOG FETCHING & CANDIDATE SCORING
# ============================================================================

BACKLOG_CACHE=""
BACKLOG_JSON_CACHE=""
QUEUE_PLAN_CACHE=""
LAST_BACKLOG_FETCH=0
LAST_QUEUE_PLAN_FETCH=0
BACKLOG_CACHE_TTL=60  # seconds between backlog refreshes

refresh_backlog_cache() {
  local now
  now=$(date +%s)

  # Use cache if fresh enough
  if (( now - LAST_BACKLOG_FETCH < BACKLOG_CACHE_TTL )) && [[ -n "$BACKLOG_CACHE" ]]; then
    return 0
  fi

  local backlog_json
  backlog_json=$(_with_timeout 60 npx tsx "$TOOLS_DIR/list-backlog-json.ts" "$PROJECT_NAME" 2>/dev/null) || true

  if [[ -z "$backlog_json" ]] || [[ "$backlog_json" == "[]" ]]; then
    BACKLOG_CACHE=""
    BACKLOG_JSON_CACHE=""
    QUEUE_PLAN_CACHE=""
    LAST_QUEUE_PLAN_FETCH=0
    LAST_BACKLOG_FETCH=$now
    return 0
  fi

  # Filter out parent issues (epics) - HOK-2867
  # Warnings go to stderr, filtered JSON goes to stdout
  backlog_json="$(filter_parent_issues "$backlog_json")"

  BACKLOG_JSON_CACHE="$backlog_json"
  QUEUE_PLAN_CACHE=""
  LAST_QUEUE_PLAN_FETCH=0

  # Use shared scoring function from wavemill-common.sh (eliminates duplication)
  # Strip has_detailed_plan (field 6) to match pick_candidates() 6-field format:
  # identifier|slug|title|area|score|blocked_by_count
  local focus_milestones_json="[]"
  if [[ -n "${REPO_DIR:-}" ]] && declare -F wavemill_load_config >/dev/null 2>&1; then
    focus_milestones_json="$(wavemill_load_config "$REPO_DIR" | jq -c '.backlog.focusMilestones // []' 2>/dev/null || printf '[]')"
  fi
  BACKLOG_CACHE=$(score_and_rank_issues "$backlog_json" 30 "$focus_milestones_json" | awk -F'|' -v OFS='|' '{print $1,$2,$3,$4,$5,$7}')
  LAST_BACKLOG_FETCH=$now
  return 0
}

print_cached_candidates() {
  echo "$BACKLOG_CACHE"
}

# NOTE: cache mutation must run in the parent shell, not in $(...) subshells.
fetch_candidates() {
  refresh_backlog_cache || return
  print_cached_candidates
}

# Run queue planner with rich process lifecycle tracking and diagnostics.
# Handles timeout, external cancellation, and malformed graph classification.
# Updates queue-health.json via queue_health_record_success/failure.
#
# Arguments:
#   $1 = planner command (as single string: "npx tsx tools/plan-queue.ts --stdin --json ...")
#   $2 = timeout seconds
#   $3 = input snapshot JSON (e.g., {"taskCount":12,"explicitDependencyCount":4})
#   stdin = plan input
#
# Output: queue plan JSON on success, nothing on failure
# Exit: 0 = success, 1 = failure
run_queue_planner_with_policy() {
  local planner_cmd="$1" timeout_secs="$2" input_snapshot="${3:-}"
  local tmp_stderr tmp_stdout tmp_stdin exit_code signal_num pid pgid
  # step stays set: the timeout path never assigns it, and the monitor runs
  # under `set -u`, where reading it unset would abort the diagnostics write.
  local started_at ended_at duration_ms cancellation_owner reason step=""

  tmp_stderr="$(mktemp -t wavemill-planner-stderr.XXXXXX)" || {
    queue_health_record_failure "diagnostics_setup_failed" "diagnostics_setup_failed" \
      "unknown" "unknown" "unknown" 1 "" "unknown" "" "stderr setup failed" "" 2>/dev/null || true
    return 1
  }

  tmp_stdout="$(mktemp -t wavemill-planner-stdout.XXXXXX)" || {
    rm -f "$tmp_stderr"
    queue_health_record_failure "diagnostics_setup_failed" "diagnostics_setup_failed" \
      "unknown" "unknown" "unknown" 1 "" "unknown" "" "stdout setup failed" "" 2>/dev/null || true
    return 1
  }

  tmp_stdin="$(mktemp -t wavemill-planner-stdin.XXXXXX)" || {
    rm -f "$tmp_stderr" "$tmp_stdout"
    queue_health_record_failure "diagnostics_setup_failed" "diagnostics_setup_failed" \
      "unknown" "unknown" "unknown" 1 "" "unknown" "" "stdin setup failed" "" 2>/dev/null || true
    return 1
  }

  if ! cat > "$tmp_stdin"; then
    record_fetch_queue_plan_failure "planner_input_missing" "failed to capture planner stdin" 1
    queue_health_record_failure "planner_input_missing" "planner_input_missing" \
      "unknown" "unknown" "$timeout_secs" 1 "" "unknown" \
      "" "failed to capture planner stdin" "$input_snapshot" 2>/dev/null || true
    rm -f "$tmp_stderr" "$tmp_stdout" "$tmp_stdin"
    return 1
  fi

  # BSD date has no %3N and emits a literal "N" with exit 0, so validate the
  # result is numeric instead of relying on a command-failure fallback.
  started_at="$(date +%s%3N 2>/dev/null || true)"
  [[ "$started_at" =~ ^[0-9]+$ ]] || started_at="$(date +%s)000"

  # Launch planner in a dedicated process group (or best-effort).
  # Try setsid first; fall back to backgrounding if unavailable.
  local cmd_array
  if command -v setsid &>/dev/null; then
    # Use setsid to create new session; child processes inherit PGID
    eval "$planner_cmd" < "$tmp_stdin" > "$tmp_stdout" 2> "$tmp_stderr" &
    pid=$!
    pgid=$(ps -o pgid= -p $pid 2>/dev/null | tr -d ' ' || echo "$pid")
  else
    # macOS fallback: background and use PID as PGID (less reliable)
    eval "$planner_cmd" < "$tmp_stdin" > "$tmp_stdout" 2> "$tmp_stderr" &
    pid=$!
    pgid=$pid
  fi

  # Set up watchdog to kill planner on timeout.
  local watchdog_pipe watchdog_pid
  watchdog_pipe=$(mktemp -t wavemill-watchdog-XXXXXX) || {
    kill $pid 2>/dev/null || true
    rm -f "$tmp_stderr" "$tmp_stdout" "$tmp_stdin"
    queue_health_record_failure "diagnostics_setup_failed" "diagnostics_setup_failed" \
      "$pid" "$pgid" "$timeout_secs" 1 "" "unknown" "" "watchdog setup failed" "" 2>/dev/null || true
    return 1
  }

  # Only group-kill when the planner really landed in its own process group.
  # Without job control the child shares our group, and "kill -- -$pgid" would
  # take down the monitor itself.
  local self_pgid
  self_pgid="$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ' || true)"

  # Watchdog subshell: wait for timeout, then kill.
  # stdout/stderr are detached because this function runs inside a command
  # substitution: a watchdog holding that pipe open would stall the caller for
  # the full timeout on every call, including successful ones.
  (
    sleep "$timeout_secs"
    # Mark that watchdog fired before killing
    printf '1\n' > "$watchdog_pipe" 2>/dev/null || true
    if [[ -n "$pgid" && "$pgid" != "$self_pgid" ]]; then
      kill -TERM -- "-$pgid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
      sleep 1
      kill -KILL -- "-$pgid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
    else
      kill -TERM "$pid" 2>/dev/null || true
      sleep 1
      kill -KILL "$pid" 2>/dev/null || true
    fi
  ) >/dev/null 2>&1 &
  watchdog_pid=$!

  # Wait for planner process
  wait $pid 2>/dev/null
  exit_code=$?

  # Clean up watchdog
  kill $watchdog_pid 2>/dev/null || true

  ended_at="$(date +%s%3N 2>/dev/null || true)"
  [[ "$ended_at" =~ ^[0-9]+$ ]] || ended_at="$(date +%s)000"
  duration_ms=$(( (ended_at - started_at) + 1 ))  # Ensure at least 1ms

  # Check if watchdog fired
  cancellation_owner="unknown"
  if [[ -s "$watchdog_pipe" ]]; then
    cancellation_owner="queue_plan_timeout"
  fi

  # Classify failure
  reason=""
  if [[ "$cancellation_owner" == "queue_plan_timeout" ]]; then
    reason="timeout"
  elif [[ "$exit_code" == "143" || "$exit_code" == "137" ]]; then
    reason="external_cancellation"
  elif [[ "$exit_code" == "0" ]]; then
    reason=""  # Success, will be handled below
  else
    # Try to infer from stderr
    local stderr_text="$(cat "$tmp_stderr" 2>/dev/null | head -c 512 || echo '')"
    if [[ "$stderr_text" == *"cycle"* || "$stderr_text" == *"Cycle"* ]]; then
      reason="malformed_graph"
      step="validation_failed"
    elif [[ "$stderr_text" == *"planner_input_missing"* ]]; then
      reason="planner_input_missing"
      step="planner_input_missing"
    else
      reason="planner_error"
      step="plan_queue_failed"
    fi
  fi

  # Handle success
  if [[ "$exit_code" == "0" && -z "$reason" ]]; then
    local stdout_text
    stdout_text="$(cat "$tmp_stdout" 2>/dev/null || echo '')"

    # Validate output. An empty plan and a malformed plan are distinct
    # failures: the fallback diagnostics classify them as empty_queue vs
    # invalid_input, so keep the two steps apart rather than collapsing both
    # into validation_failed.
    if [[ -z "${stdout_text//[[:space:]]/}" ]]; then
      record_fetch_queue_plan_failure "empty_queue" "" 0
      queue_health_record_failure "malformed_graph" "empty_queue" \
        "$pid" "$pgid" "$timeout_secs" 0 "" "unknown" \
        "" "empty queue plan" "$input_snapshot" 2>/dev/null || true
      rm -f "$tmp_stderr" "$tmp_stdout" "$tmp_stdin" "$watchdog_pipe"
      return 1
    fi

    if ! jq -e 'has("availableNow")' >/dev/null 2>&1 <<<"$stdout_text"; then
      record_fetch_queue_plan_failure "validation_failed" \
        "$(cat "$tmp_stderr" 2>/dev/null | tr '\n' ' ' | head -c 512 || true)" 1
      queue_health_record_failure "malformed_graph" "validation_failed" \
        "$pid" "$pgid" "$timeout_secs" 0 "" "unknown" \
        "" "invalid queue plan JSON" "$input_snapshot" 2>/dev/null || true
      rm -f "$tmp_stderr" "$tmp_stdout" "$tmp_stdin" "$watchdog_pipe"
      return 1
    fi

    queue_health_record_success "$pid" "$pgid" "$duration_ms" "$planner_cmd" 2>/dev/null || true
    cat "$tmp_stdout"
    rm -f "$tmp_stderr" "$tmp_stdout" "$tmp_stdin" "$watchdog_pipe"
    return 0
  fi

  # Handle failure: record diagnostics
  local stderr_excerpt stdout_excerpt
  stderr_excerpt="$(cat "$tmp_stderr" 2>/dev/null | tr '\n' ' ' | head -c 512 || echo '(no stderr)')"
  stdout_excerpt="$(cat "$tmp_stdout" 2>/dev/null | tr '\n' ' ' | head -c 512 || echo '(no stdout)')"

  [[ -z "$step" ]] && step="plan_queue_failed"

  # Feed the fallback diagnostics too. This runs inside a command
  # substitution, so caller-visible state has to travel through the
  # diagnostics file rather than shell variables; without the real stderr and
  # exit code the reason classifier degrades every planner failure to a
  # generic dependency_planning_failed.
  record_fetch_queue_plan_failure "$step" "$stderr_excerpt" "$exit_code" "$cancellation_owner"

  queue_health_record_failure "$reason" "$step" \
    "$pid" "$pgid" "$timeout_secs" "$exit_code" "" "$cancellation_owner" \
    "$stdout_excerpt" "$stderr_excerpt" "$input_snapshot" 2>/dev/null || true

  rm -f "$tmp_stderr" "$tmp_stdout" "$tmp_stdin" "$watchdog_pipe"
  return 1
}

fetch_queue_plan() {
  local now plan_input queue_plan
  now=$(date +%s)
  [[ -n "${FETCH_QUEUE_PLAN_DIAGNOSTICS_FILE:-}" ]] && : > "$FETCH_QUEUE_PLAN_DIAGNOSTICS_FILE"

  if (( now - LAST_QUEUE_PLAN_FETCH < BACKLOG_CACHE_TTL )) && [[ -n "$QUEUE_PLAN_CACHE" ]]; then
    echo "$QUEUE_PLAN_CACHE"
    return 0
  fi

  [[ -n "$BACKLOG_JSON_CACHE" ]] || {
    record_fetch_queue_plan_failure "cache_empty" ""
    return 1
  }
  queue_plan=$(build_queue_plan_once "$BACKLOG_JSON_CACHE") || return 1

  QUEUE_PLAN_CACHE="$queue_plan"
  LAST_QUEUE_PLAN_FETCH=$now
  echo "$QUEUE_PLAN_CACHE"
}

# fetch_queue_plan runs in command substitution, so diagnostics use a caller-owned file.
record_fetch_queue_plan_failure() {
  local step="$1" stderr_text="${2-}" exit_code="${3:-1}" cancellation_owner="${4:-}" diagnostics_file="${FETCH_QUEUE_PLAN_DIAGNOSTICS_FILE:-}"
  [[ -n "$diagnostics_file" ]] || return 0

  local bounded
  if [[ -n "$stderr_text" ]]; then
    bounded="$(printf '%s' "$stderr_text" | sed -n '1,5p' | tr '\n' ' ' | head -c 512)"
    [[ -n "$bounded" ]] || bounded="(no stderr captured)"
  else
    bounded="(no stderr captured)"
  fi

  if [[ -n "$cancellation_owner" ]]; then
    printf 'step=%s exit=%s cancellationOwner=%s stderr=%s\n' "$step" "$exit_code" "$cancellation_owner" "$bounded" > "$diagnostics_file" 2>/dev/null || true
  else
    printf 'step=%s exit=%s stderr=%s\n' "$step" "$exit_code" "$bounded" > "$diagnostics_file" 2>/dev/null || true
  fi
}

log_fetch_queue_plan_failure() {
  local diagnostics_file="$1"
  [[ -s "$diagnostics_file" ]] || return 0

  local details step reason
  details="$(cat "$diagnostics_file" 2>/dev/null || true)"
  step="$(printf '%s' "$details" | sed -n 's/.*step=\([^ ]*\).*/\1/p')"
  reason="$(classify_queue_failure_reason "$step" "$details")"
  [[ -n "$details" ]] && log "debug" "[fetch_queue_plan] failed reason=$reason $details"
}

classify_queue_failure_reason() {
  local step="$1" details="${2:-}" lowered exit_code cancellation_owner
  exit_code="$(printf '%s' "$details" | sed -n 's/.*exit=\([0-9][0-9]*\).*/\1/p')"
  cancellation_owner="$(printf '%s' "$details" | sed -n 's/.*cancellationOwner=\([^ ]*\).*/\1/p')"

  if [[ "$cancellation_owner" == "queue_plan_timeout" ]]; then
    echo "timeout"
    return 0
  fi
  if [[ "$exit_code" == "143" || "$exit_code" == "137" ]]; then
    echo "external_cancellation"
    return 0
  fi

  case "$step" in
    cache_empty|empty_queue)   echo "empty_queue" ;;
    jq_massage_failed)         echo "invalid_input" ;;
    planner_input_missing)     echo "planner_input_missing" ;;
    plan_queue_failed)
      lowered="$(printf '%s' "$details" | tr '[:upper:]' '[:lower:]')"
      if [[ "$lowered" == *cache* || "$lowered" == *refresh* ]]; then
        echo "cache_refresh_failed"
      else
        echo "dependency_planning_failed"
      fi
      ;;
    validation_failed)         echo "invalid_input" ;;
    *)                         echo "unknown" ;;
  esac
}

get_queue_failure_reason() {
  local diagnostics_file="${1:-}" details step
  [[ -s "$diagnostics_file" ]] || { echo "unknown"; return 0; }
  details="$(cat "$diagnostics_file" 2>/dev/null || true)"
  step="$(printf '%s' "$details" | sed -n 's/.*step=\([^ ]*\).*/\1/p')"
  classify_queue_failure_reason "$step" "$details"
}

build_queue_plan_once() {
  local backlog_json="$1"
  local plan_input queue_plan tmp_stderr stderr_text cache_key timeout_secs input_snapshot

  # Massage backlog into plan input format
  tmp_stderr="$(mktemp -t wavemill-fqp-stderr.XXXXXX)" || {
    record_fetch_queue_plan_failure "diagnostics_setup_failed" "mktemp failed"
    queue_health_init 2>/dev/null || true
    queue_health_record_failure "diagnostics_setup_failed" "diagnostics_setup_failed" \
      "unknown" "unknown" "unknown" 1 "" "unknown" "" "mktemp failed" "" 2>/dev/null || true
    return 1
  }

  plan_input=$(jq -c '
    map({
      id: .identifier,
      title: .title,
      description: .description,
      labels: ((.labels.nodes // []) | map(.name) | sort),
      priority: (.priority // null),
      priorityLabel: (.priorityLabel // null),
      estimate: (.estimate // null),
      state: (.state.name // null),
      dueDate: (.dueDate // null),
      projectMilestone: (.projectMilestone // null),
      blocks: (
        (.relations.nodes // [])
        | map(select(.type == "blocks" and .relatedIssue.identifier != null and .relatedIssue.completedAt == null and .relatedIssue.canceledAt == null) | .relatedIssue.identifier)
        | sort
      ),
      sharedSurface: ((.sharedSurface // []) | sort),
      dependsOn: (
        (.inverseRelations.nodes // [])
        | map(select(.type == "blocks" and .issue.identifier != null and .issue.completedAt == null and .issue.canceledAt == null) | .issue.identifier)
        | sort
      )
    })
  ' <<<"$backlog_json" 2>"$tmp_stderr") || {
    stderr_text="$(cat "$tmp_stderr" 2>/dev/null || true)"
    rm -f "$tmp_stderr"
    record_fetch_queue_plan_failure "jq_massage_failed" "$stderr_text"
    queue_health_init 2>/dev/null || true
    queue_health_record_failure "invalid_input" "jq_massage_failed" \
      "unknown" "unknown" "unknown" 1 "" "unknown" "" "$stderr_text" "" 2>/dev/null || true
    return 1
  }

  # Build input snapshot for diagnostics
  local task_count explicit_dep_count
  task_count=$(printf '%s' "$plan_input" | jq 'length // 0' 2>/dev/null || echo '0')
  explicit_dep_count=$(printf '%s' "$plan_input" | jq 'map(.blocks | length) | add // 0' 2>/dev/null || echo '0')
  cache_key="${PROJECT_NAME:-default}"
  input_snapshot=$(jq -n \
    --argjson taskCount "$task_count" \
    --argjson explicitDependencyCount "$explicit_dep_count" \
    --arg cacheKey "$cache_key" \
    '{"taskCount": $taskCount, "explicitDependencyCount": $explicitDependencyCount, "cacheKey": $cacheKey}' 2>/dev/null)

  # Determine timeout and build planner command
  if [[ -n "${PROJECT_NAME:-}" ]]; then
    timeout_secs=60
    local now_ms classifier_deadline_ms classifier_grace_secs=8
    now_ms="$(date +%s%3N 2>/dev/null || true)"
    [[ "$now_ms" =~ ^[0-9]+$ ]] || now_ms="$(date +%s)000"
    classifier_deadline_ms=$(( now_ms + ((timeout_secs - classifier_grace_secs) * 1000) ))
    planner_cmd="npx tsx \"$TOOLS_DIR/plan-queue.ts\" --stdin --json --cache-key \"$cache_key\" --refresh-missing-cache --queue-classifier-deadline-ms \"$classifier_deadline_ms\""
  else
    timeout_secs=15
    planner_cmd="npx tsx \"$TOOLS_DIR/plan-queue.ts\" --stdin --json"
  fi

  # Initialize queue-health file before attempting planner
  queue_health_init 2>/dev/null || true

  # Run planner with policy wrapper (handles timeout, process group, diagnostics)
  rm -f "$tmp_stderr"
  queue_plan=$(printf '%s' "$plan_input" | run_queue_planner_with_policy "$planner_cmd" "$timeout_secs" "$input_snapshot") || {
    # The planner records the specific step/stderr/exit itself. Only fill in a
    # generic record when it left nothing behind, so we never overwrite the
    # detailed diagnostics with a placeholder.
    local _diag_file="${FETCH_QUEUE_PLAN_DIAGNOSTICS_FILE:-}"
    if [[ -z "$_diag_file" || ! -s "$_diag_file" ]]; then
      record_fetch_queue_plan_failure "plan_queue_failed" "" 1
    fi
    return 1
  }

  # Validate output shape
  if [[ -z "${queue_plan//[[:space:]]/}" ]] || ! jq -e 'has("availableNow")' >/dev/null 2>&1 <<<"$queue_plan"; then
    record_fetch_queue_plan_failure "validation_failed" "" 1
    queue_health_record_failure "malformed_graph" "validation_failed" \
      "unknown" "unknown" "unknown" 1 "" "unknown" "" "invalid output shape" "$input_snapshot" 2>/dev/null || true
    return 1
  fi

  echo "$queue_plan"
}

invoke_first_wave_helper() {
  local queue_plan="$1" candidates="$2" max_parallel="${3:-$MAX_PARALLEL}"
  [[ -z "$queue_plan" ]] && return 1

  local tasks_json input_json
  tasks_json=$(awk -F'|' 'NF >= 5 && $1 != "" {
    id = $1
    gsub(/"/, "\\\"", id)
    printf "{\"id\":\"%s\",\"score\":%s}\n", id, ($5 + 0)
  }' <<<"$candidates" | jq -s '.') || return 1

  input_json=$(jq -n \
    --argjson p "$queue_plan" \
    --argjson t "$tasks_json" \
    --argjson m "$max_parallel" \
    '{"plan": $p, "tasks": $t, "maxParallel": ($m | tonumber)}') || return 1

  printf '%s\n' "$input_json" | _with_timeout 10 npx tsx "$TOOLS_DIR/select-wave.ts" 2>/dev/null
}

BACKLOG_LAST_TIER=""
BACKLOG_DEFAULT_AVAILABLE_CAP=12

render_grouped_task_list() {
  local queue_plan="$1" available="$2" budget="${3:-999}" expanded="${4:-false}"
  local deps_expanded="${5:-false}" active_issue_ids="${6:-}"
  local counter=0 output="" select_lines="" section_body="" line rec group_index task_id blockers triage_id task_key
  local backlog_cap="${BACKLOG_DEFAULT_AVAILABLE_CAP:-12}"
  local tier=0 hidden_count=0 config_max="" indicator_label="expand"
  local deps_hidden_count=0 available_limit=0 queued_line_budget=0 max_queued_entries=0
  local -a available_entries=() queued_entries=() on_deck_queued=() off_deck_queued=()
  local available_section_lines=0 queued_section_lines=0 total_lines=0
  declare -A id_to_record=()
  declare -A rendered_ids=()
  declare -A on_deck_set=()

  jq -e . >/dev/null 2>&1 <<<"$queue_plan" || return 1

  if [[ -n "${REPO_DIR:-}" ]] && declare -F wavemill_load_config >/dev/null 2>&1; then
    backlog_cap="$(wavemill_load_config "$REPO_DIR" | jq -r '.backlog.defaultAvailableNowCap // 12' 2>/dev/null || printf '12')"
    config_max="$(wavemill_load_config "$REPO_DIR" | jq -r '.backlog.maxLines // empty' 2>/dev/null || true)"
  fi
  if ! [[ "$backlog_cap" =~ ^[0-9]+$ ]] || (( backlog_cap < 1 )); then
    backlog_cap=12
  fi
  if ! [[ "$budget" =~ ^[0-9]+$ ]]; then
    budget=999
  fi

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    task_id=${line%%|*}
    if [[ -n "$task_id" ]]; then
      id_to_record["$task_id"]="$line"
      task_key="$(printf '%s' "$task_id" | tr '[:lower:]' '[:upper:]')"
      id_to_record["$task_key"]="$line"
    fi
  done <<<"$available"

  section_body=""
  while IFS= read -r task_id; do
    [[ -n "$task_id" ]] || continue
    task_key="$(printf '%s' "$task_id" | tr '[:lower:]' '[:upper:]')"
    [[ -n "${rendered_ids[$task_key]:-}" ]] && continue
    rec="${id_to_record[$task_id]:-${id_to_record[$task_key]:-}}"
    [[ -n "$rec" ]] || continue
    IFS='|' read -r task_id _slug title _area _score _blocked <<<"$rec"
    available_entries+=("$rec")
    rendered_ids["$task_key"]=1
  done < <(jq -r '.availableNow[]?' <<<"$queue_plan" 2>/dev/null)

  section_body=""
  while IFS=$'\t' read -r task_id blockers; do
    [[ -n "$task_id" ]] || continue
    task_key="$(printf '%s' "$task_id" | tr '[:lower:]' '[:upper:]')"
    [[ -n "${rendered_ids[$task_key]:-}" ]] && continue
    rec="${id_to_record[$task_id]:-${id_to_record[$task_key]:-}}"
    [[ -n "$rec" ]] || continue
    IFS='|' read -r task_id _slug title _area _score _blocked <<<"$rec"
    queued_entries+=("${rec}"$'\t'"$blockers")
    rendered_ids["$task_key"]=1
  done < <(jq -r '.queuedAfterDependencies[]? | [.taskId, (.ancestors | join(", "))] | @tsv' <<<"$queue_plan" 2>/dev/null)

  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    local avail_id="${line%%|*}"
    [[ -n "$avail_id" ]] && on_deck_set["$(printf '%s' "$avail_id" | tr '[:lower:]' '[:upper:]')"]=1
  done <<<"$available"
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    on_deck_set["$(printf '%s' "$line" | tr '[:lower:]' '[:upper:]')"]=1
  done <<<"$active_issue_ids"

  for line in "${queued_entries[@]}"; do
    IFS=$'\t' read -r rec blockers <<<"$line"
    local is_on_deck=true blocker bkey
    if [[ -z "$blockers" ]]; then
      is_on_deck=true
    else
      while IFS= read -r blocker; do
        [[ -n "$blocker" ]] || continue
        bkey="$(printf '%s' "${blocker// /}" | tr '[:lower:]' '[:upper:]')"
        if [[ -z "${on_deck_set[$bkey]:-}" ]]; then
          is_on_deck=false
          break
        fi
      done < <(printf '%s\n' "$blockers" | tr ',' '\n')
    fi
    if [[ "$is_on_deck" == "true" ]]; then
      on_deck_queued+=("$line")
    else
      off_deck_queued+=("$line")
    fi
  done
  deps_hidden_count=${#off_deck_queued[@]}
  if [[ "$deps_expanded" == "true" ]]; then
    queued_entries=("${on_deck_queued[@]+"${on_deck_queued[@]}"}" "${off_deck_queued[@]+"${off_deck_queued[@]}"}")
  else
    queued_entries=("${on_deck_queued[@]+"${on_deck_queued[@]}"}")
  fi

  if (( ${#available_entries[@]} > 1 )); then
    local -a sorted_available_entries=()
    while IFS= read -r rec; do
      [[ -n "$rec" ]] && sorted_available_entries+=("$rec")
    done < <(printf '%s\n' "${available_entries[@]}" | sort -t'|' -k5,5nr -k1,1)
    available_entries=("${sorted_available_entries[@]}")
  fi
  if (( ${#queued_entries[@]} > 1 )); then
    local -a sorted_queued_entries=()
    while IFS= read -r rec; do
      [[ -n "$rec" ]] && sorted_queued_entries+=("$rec")
    done < <(printf '%s\n' "${queued_entries[@]}" | sort -t'|' -k5,5nr -k1,1)
    queued_entries=("${sorted_queued_entries[@]}")
  fi

  available_section_lines=0
  if (( ${#available_entries[@]} > 0 )); then
    available_section_lines=$((1 + ${#available_entries[@]}))
  fi
  queued_section_lines=0
  if (( ${#queued_entries[@]} > 0 )); then
    queued_section_lines=$((2 + ${#queued_entries[@]} * 2))
  fi
  total_lines=$((available_section_lines + queued_section_lines))

  if [[ "$expanded" != "true" ]] && (( total_lines > budget )); then
    if (( ${#queued_entries[@]} > 0 )); then
      queued_line_budget=$((budget - available_section_lines - 2))
      max_queued_entries=$((queued_line_budget / 2))
      if (( max_queued_entries > 0 )); then
        tier=1
        if (( max_queued_entries < ${#queued_entries[@]} )); then
          hidden_count=$((hidden_count + ${#queued_entries[@]} - max_queued_entries))
          queued_entries=("${queued_entries[@]:0:max_queued_entries}")
        else
          tier=0
        fi
      else
        hidden_count=$((hidden_count + ${#queued_entries[@]}))
        queued_entries=()
        tier=2
      fi
    fi

    if (( available_section_lines > budget )); then
      tier=3
      hidden_count=$((hidden_count + ${#queued_entries[@]}))
      queued_entries=()
      local min_visible=$((budget - 1))
      (( min_visible < 10 )) && min_visible=10
      available_limit=$min_visible
      if (( backlog_cap < available_limit )); then
        available_limit=$backlog_cap
      fi
      if (( available_limit > budget - 1 )); then
        available_limit=$((budget - 1))
      fi
      if (( ${#available_entries[@]} > available_limit )); then
        hidden_count=$((hidden_count + ${#available_entries[@]} - available_limit))
        available_entries=("${available_entries[@]:0:available_limit}")
      fi
    fi
  fi

  if (( ${#available_entries[@]} > 0 )); then
    output+="Available Now - Parallel Wave 1"$'\n'
    for rec in "${available_entries[@]}"; do
      IFS='|' read -r task_id _slug title _area _score _blocked <<<"$rec"
      counter=$((counter + 1))
      output+="$(printf '  %s. %s - %s' "$counter" "$task_id" "$title")"$'\n'
      select_lines+="${rec}"$'\n'
    done
  fi

  if (( ${#queued_entries[@]} > 0 )); then
    [[ -n "$output" ]] && output+=$'\n'
    output+="Queued After Dependencies"$'\n'
    for line in "${queued_entries[@]}"; do
      IFS=$'\t' read -r rec blockers <<<"$line"
      IFS='|' read -r task_id _slug title _area _score _blocked <<<"$rec"
      counter=$((counter + 1))
      output+="$(printf '  %s. %s - %s (blocked by: %s)' "$counter" "$task_id" "$title" "$blockers")"$'\n'
      select_lines+="${rec}"$'\n'
    done
    if [[ "$deps_expanded" != "true" ]] && (( deps_hidden_count > 0 )); then
      output+="$(printf '  +%s hidden - d to expand' "$deps_hidden_count")"$'\n'
    elif [[ "$deps_expanded" == "true" ]] && (( deps_hidden_count > 0 )); then
      output+="  (d to collapse)"$'\n'
    fi
  fi

  section_body=""
  group_index=0
  while IFS= read -r blockers; do
    [[ -n "$blockers" ]] || continue
    group_index=$((group_index + 1))
    local cluster_body=""
    while IFS= read -r task_id; do
      [[ -n "$task_id" ]] || continue
      task_key="$(printf '%s' "$task_id" | tr '[:lower:]' '[:upper:]')"
      [[ -n "${rendered_ids[$task_key]:-}" ]] && continue
      rec="${id_to_record[$task_id]:-${id_to_record[$task_key]:-}}"
      [[ -n "$rec" ]] || continue
      IFS='|' read -r task_id _slug title _area _score _blocked <<<"$rec"
      counter=$((counter + 1))
      cluster_body+="$(printf '    %s. %s - %s' "$counter" "$task_id" "$title")"$'\n'
      select_lines+="${rec}"$'\n'
      rendered_ids["$task_key"]=1
    done < <(jq -r '.[]' <<<"$blockers" 2>/dev/null)
    if [[ -n "$cluster_body" ]]; then
      section_body+="$(printf '  [conflict cluster %s]' "$group_index")"$'\n'
      section_body+="$cluster_body"
    fi
  done < <(jq -c '.avoidRunningTogether[]?' <<<"$queue_plan" 2>/dev/null)
  if [[ -n "$section_body" ]]; then
    [[ -n "$output" ]] && output+=$'\n'
    output+="Avoid Running Together"$'\n'
    output+="${section_body}"
  fi

  section_body=""
  while IFS= read -r triage_id; do
    [[ -n "$triage_id" ]] || continue
    task_key="$(printf '%s' "$triage_id" | tr '[:lower:]' '[:upper:]')"
    [[ -n "${rendered_ids[$task_key]:-}" ]] && continue
    rec="${id_to_record[$triage_id]:-${id_to_record[$task_key]:-}}"
    [[ -n "$rec" ]] || continue
    IFS='|' read -r task_id _slug title _area _score _blocked <<<"$rec"
    counter=$((counter + 1))
    section_body+="$(printf '  %s. %s - %s [triage]' "$counter" "$task_id" "$title")"$'\n'
    select_lines+="${rec}"$'\n'
    rendered_ids["$task_key"]=1
  done < <(jq -r '.needsTriage[]? | .edge.to' <<<"$queue_plan" 2>/dev/null)
  if [[ -n "$section_body" ]]; then
    [[ -n "$output" ]] && output+=$'\n'
    output+="Needs Triage"$'\n'
    output+="${section_body}"
  fi

  if [[ "$expanded" != "true" ]] && (( tier > 0 )) && (( hidden_count > 0 )); then
    output+="$(printf '... %s tasks hidden (m to expand)' "$hidden_count")"$'\n'
  elif [[ "$expanded" == "true" ]] && (( total_lines > budget )); then
    output+="(m to collapse)"$'\n'
    indicator_label="collapse"
  fi

  (( counter > 0 )) || return 1

  if [[ "$tier" != "${BACKLOG_LAST_TIER:-}" ]] && declare -F log >/dev/null 2>&1; then
    local backlog_annotation=" (backlog.maxLines=${config_max:-auto})"
    if declare -F wavemill_config_annotation >/dev/null 2>&1; then
      backlog_annotation="$(wavemill_config_annotation "backlog.maxLines" "${config_max:-auto}")"
    fi
    log "info" "[backlog] tier=$tier budget=$budget${backlog_annotation}"
    BACKLOG_LAST_TIER="$tier"
  fi

  GROUPED_SELECT_FROM="${select_lines%$'\n'}"
  GROUPED_DISPLAY="${output%$'\n'}"
}


# Filter out issues that are already tracked (active or cleaned)
filter_active_issues() {
  local candidates="$1"
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    local cand_issue
    cand_issue=$(echo "$line" | cut -d'|' -f1)
    # Skip if already tracked
    if [[ -n "${BRANCH_BY_ISSUE[$cand_issue]:-}" ]] || [[ -n "${CLEANED[$cand_issue]:-}" ]]; then
      continue
    fi
    echo "$line"
  done <<<"$candidates"
}


# ============================================================================
# TASK LAUNCH (worktree + agent + state)
# ============================================================================
# Note: is_task_packet() is now provided by wavemill-common.sh (sourced above)

LAST_LAUNCHED_SLOTS=1

launch_task() {
  local issue="$1" slug="$2" title="$3" remaining_slots="${4:-1}" override_base="${5:-}"
  local branch="task/${slug}"
  local wt_dir="${WORKTREE_ROOT}/${slug}"
  local feature_dir="${wt_dir}/features/${slug}"
  local linear_issue="$issue"
  local challenge_model=""
  local effective_base="${override_base:-$BASE_BRANCH}"
  LAST_LAUNCHED_SLOTS=1

  linear_issue=$(get_linear_issue_id "$issue")
  challenge_model=$(get_task_meta "$issue" "challengeModel")

  log "status" "$issue: Launching - $title"

  # A new attempt invalidates any recorded launch failure. Cleared here rather
  # than on success so a retry that fails a second time records the new reason
  # instead of leaving the previous one in place.
  if [[ -n "${STATE_FILE:-}" && -f "$STATE_FILE" ]]; then
    state_mutate "$STATE_FILE" 'del(.tasks[$issue].launchFailure)' --arg issue "$issue" >/dev/null || true
  fi

  # Fetch issue details
  local issue_json
  if [[ -f "/tmp/${SESSION}-${issue}-issue.json" ]]; then
    issue_json=$(cat "/tmp/${SESSION}-${issue}-issue.json" 2>/dev/null || echo "{}")
  else
    issue_json=$(_with_timeout "$API_TIMEOUT" npx tsx "$TOOLS_DIR/get-issue.ts" "$linear_issue" --json 2>/dev/null || echo "{}")
    echo "$issue_json" > "/tmp/${SESSION}-${issue}-issue.json"
  fi
  local issue_desc
  issue_desc=$(echo "$issue_json" | jq -r '.description // ""' 2>/dev/null || echo "")

  # Task packet handling — write title plus raw description (agent will expand in-pane)
  local packet_file="/tmp/${SESSION}-${issue}-taskpacket.md"
  if [[ -f "$packet_file" ]]; then
    :
  else
    if is_task_packet "$issue_desc"; then
      log "info" "$issue has task packet"
      printf '%s\n' "$issue_desc" > "$packet_file"
    else
      log "info" "$issue title and raw description saved (agent will expand)"
      if [[ -n "$issue_desc" ]]; then
        printf '%s\n\n%s\n' "$title" "$issue_desc" > "$packet_file"
      else
        printf '%s\n' "$title" > "$packet_file"
      fi
    fi
  fi
  local packet_content
  packet_content=$(cat "$packet_file" 2>/dev/null || echo "")

  # Refresh base branch on a TTL so repeated dynamic launches avoid redundant fetches.
  wavemill_fetch_base_branch "$effective_base" 2>/dev/null || true

  # ── Migration detection for dynamically launched tasks ──────────────
  # Detection: 1) label match  2) raw description keywords
  # Post-expansion migration detection happens in the planning agent
  local is_migration=false
  local has_migration_label
  has_migration_label=$(echo "$issue_json" | jq -r '.labels.nodes[]? | select(.name | ascii_downcase | test("migration|database|schema|alembic")) | .name' 2>/dev/null | head -1)

  if [[ -n "$has_migration_label" ]]; then
    is_migration=true
  elif echo "$issue_desc" | grep -qi "alembic\|migration.*file\|database.*migration\|schema.*migration"; then
    is_migration=true
  fi

  if [[ "$is_migration" == "true" ]]; then
    # Read next migration number from state file (persisted by initial mill or prior launches)
    local next_num
    next_num=$(jq -r '.nextMigrationNum // empty' "$STATE_FILE" 2>/dev/null)
    if [[ -z "$next_num" ]]; then
      # Fallback: compute from git tree
      local highest
      highest=$(git -C "$REPO_DIR" ls-tree --name-only "origin/$BASE_BRANCH" alembic/versions/ 2>/dev/null \
        | grep -oE '^[0-9]+' | sort -n | tail -1)
      next_num=$(( ${highest:-0} + 1 ))
    fi

    # Append migration hint to task packet
    echo "" >> "$packet_file"
    echo "---" >> "$packet_file"
    echo "**ASSIGNED MIGRATION NUMBER**: $next_num" >> "$packet_file"
    echo "" >> "$packet_file"
    echo "Use revision='$(printf '%03d' $next_num)' in your Alembic migration file." >> "$packet_file"
    echo "CRITICAL: This number has been reserved to avoid conflicts with parallel tasks." >> "$packet_file"

    # Persist reservation so subsequent launches continue the sequence
    if ! state_mutate "$STATE_FILE" \
       '.migrationReservations[$issue] = $num | .nextMigrationNum = ($num + 1)' \
       --arg issue "$issue" --argjson num "$next_num"; then
      log_warn "Failed to persist migration reservation for $issue"
    fi

    # Re-read packet content with migration hint included
    packet_content=$(cat "$packet_file" 2>/dev/null || echo "")
    log "debug" "  → Migration detected, assigned number: $next_num"
  fi

  # Create worktree + branch
  local created_new=false
  if [[ -d "$wt_dir" ]]; then
    log "info" "  Worktree exists: $wt_dir (resuming)"
  elif git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$branch" 2>/dev/null; then
    log "info" "  Branch $branch exists, resuming"
    local requested_wt_dir="$wt_dir"
    local resolved_path
    resolved_path="$(ensure_worktree "$branch" "$wt_dir" "$REPO_DIR" 2>>"$MILL_LOG_FILE")" || {
      log_error "$issue: worktree add failed (log: $MILL_LOG_FILE)"
      return 1
    }
    wt_dir="$resolved_path"
    if [[ "$wt_dir" == "$requested_wt_dir" ]]; then
      created_new=true
    fi
  else
    log "info" "  Creating branch $branch from origin/$effective_base"
    if ! git -C "$REPO_DIR" worktree add "$wt_dir" -b "$branch" "origin/$effective_base" >>"$MILL_LOG_FILE" 2>&1; then
      log_error "$issue: worktree add failed (log: $MILL_LOG_FILE)"
      return 1
    fi
    created_new=true
  fi
  mkdir -p "$feature_dir"

  # ── Trace correlation (HOK-2259) — resolve or create stable traceId ──
  local _trace_id
  _trace_id=$(trace_get_or_create "$feature_dir" "$issue" "$slug" 2>/dev/null || true)

  # Set Linear state
  if should_update_linear_state "$issue"; then
    linear_set_state "$linear_issue" "In Progress"
  fi

  # Track in monitor arrays
  BRANCH_BY_ISSUE["$issue"]="$branch"
  SLUG_BY_ISSUE["$issue"]="$slug"

  # ── Per-task model routing ──────────────────────────────────────────
  local task_agent_cmd="$AGENT_CMD"
  local task_model=""
  local planner_model="" planner_agent="" plan_depth=""
  local reviewer_model="" reviewer_agent="" review_mode=""
  local code_depth=""
  local challenge_enabled_for_launch="false"
  local challenge_pair=""
  local challenge_role
  challenge_role=$(get_task_meta "$issue" "challengeRole")
  local should_launch_challenger="false"
  local challenger_key="" challenger_slug="" challenger_title="$title"
  if [[ -n "$challenge_model" ]]; then
    task_model="$challenge_model"
    # Read stored routing for this challenge entry
    planner_model=$(get_task_meta "$issue" "plannerModel")
    reviewer_model=$(get_task_meta "$issue" "reviewerModel")
    plan_depth=$(get_task_meta "$issue" "planDepth")
    code_depth=$(get_task_meta "$issue" "codeDepth")
    review_mode=$(get_task_meta "$issue" "reviewMode")
    if declare -F agent_resolve_models_for_roles >/dev/null 2>&1; then
      if agent_resolve_models_for_roles "${planner_model:-$task_model}" "$task_model" "${reviewer_model:-$task_model}"; then
        :
      fi
      planner_agent="$(agent_resolve_batch_agent_for_role "planner")"
      task_agent_cmd="$(agent_resolve_batch_agent_for_role "coder")"
      reviewer_agent="$(agent_resolve_batch_agent_for_role "reviewer")"
    else
      task_agent_cmd="$(agent_resolve_from_model "$task_model" "coding" || true)"
      planner_agent="$(agent_resolve_from_model "${planner_model:-$task_model}" "planning" || true)"
      reviewer_agent="$(agent_resolve_from_model "${reviewer_model:-$task_model}" "review" || true)"
    fi
    log "info" "  Challenge: $task_agent_cmd --model $task_model (planner=$planner_model, reviewer=$reviewer_model)"
  elif [[ -n "${FORCE_MODEL:-}" ]]; then
    # Validate model (should have been validated earlier, but double-check)
    if ! agent_validate_model "$FORCE_MODEL" "$REPO_DIR"; then
      log_error "  Invalid FORCE_MODEL for $issue: $FORCE_MODEL"
      log_error "  Skipping this task."
      continue
    fi
    task_model="$FORCE_MODEL"
    task_agent_cmd="$(agent_resolve_from_model "$FORCE_MODEL" "coding" || true)"
    planner_model="$FORCE_MODEL"
    planner_agent="$task_agent_cmd"
    reviewer_model="$FORCE_MODEL"
    reviewer_agent="$task_agent_cmd"
    log "info" "  FORCE_MODEL: $task_agent_cmd --model $task_model"
  elif [[ "${AGENT_CMD_EXPLICIT:-}" != "true" ]]; then
    local route_tool="$TOOLS_DIR/route-task.ts"
    if [[ "${ROUTER_ENABLED:-true}" == "true" ]] && [[ -f "$route_tool" ]]; then
      local selected_task_file="$feature_dir/selected-task.json"
      local saved_route="/tmp/${SESSION}-${issue}-route.json"
      local saved_route_source_file="/tmp/${SESSION}-${issue}-route-source.txt"
      local routing_log_file="$feature_dir/.routing-debug.log"
      local routing_failure_file="$feature_dir/.routing-failure"
      local route_input_file="$packet_file"
      local route_json=""
      local route_rc=0
      local route_attempt=1
      local route_reason=""
      local route_source=""
      local route_stderr_file="/tmp/${SESSION}-${issue}-route-live.stderr"
      local route_max_cost_args=()
      local route_mode_args=()
      local route_debug_enabled="false"
      : > "$routing_log_file"
      rm -f "$routing_failure_file"

      if [[ -n "${DEFAULT_MAX_COST_USD:-}" ]]; then
        route_max_cost_args=(--max-cost "$DEFAULT_MAX_COST_USD")
      fi
      if [[ "${WAVEMILL_ROUTING_DEBUG:-0}" == "1" ]]; then
        route_debug_enabled="true"
      fi

      if [[ ! -s "$route_input_file" ]]; then
        if [[ -f "$selected_task_file" ]] && jq -e '.title or .description' "$selected_task_file" >/dev/null 2>&1; then
          jq -r '[(.title // ""), (.description // "")] | map(select(length > 0)) | join("\n\n")' \
            "$selected_task_file" > "$route_input_file" 2>/dev/null || true
          if [[ -s "$route_input_file" ]]; then
            packet_content=$(cat "$route_input_file" 2>/dev/null || echo "")
            log "info" "  Created minimal routing packet from selected-task.json"
          fi
        fi

        if [[ ! -s "$route_input_file" ]]; then
          printf '%s\n\n%s\n' "$title" "$issue_desc" > "$route_input_file"
          packet_content=$(cat "$route_input_file" 2>/dev/null || echo "")
          log "info" "  Created minimal routing packet from title and description"
        fi
      fi

      printf 'issue=%s\npacket=%s\nsaved_route=%s\n' "$issue" "$route_input_file" "$saved_route" >> "$routing_log_file"

      if [[ -f "$saved_route" ]] && [[ -f "$saved_route_source_file" ]] && [[ "$(cat "$saved_route_source_file" 2>/dev/null)" == "batch-cache" ]] && jq -e '.planner and .coder and .reviewer' "$saved_route" >/dev/null 2>&1; then
        route_json=$(cat "$saved_route" 2>/dev/null || echo "")
        route_source="batch-cache"
        log "info" "  Workflow route cache hit from batch cache"
      elif [[ ! -s "$route_input_file" ]]; then
        route_reason="missing_packet"
        log_warn "  Workflow routing skipped: no packet content available"
      else
        while (( route_attempt <= 3 )); do
          printf '\n[attempt %d] live route\n' "$route_attempt" >> "$routing_log_file"
          rm -f "$route_stderr_file"
          if [[ "$route_debug_enabled" == "true" ]]; then
            if route_json=$(_with_timeout "$API_TIMEOUT" npx tsx "$route_tool" --json --file "$route_input_file" --repo-dir "$REPO_DIR" --source live --input-kind task-packet "${route_max_cost_args[@]}" "${route_mode_args[@]}" 2>"$route_stderr_file"); then
              route_rc=0
            else
              route_rc=$?
            fi
          else
            if route_json=$(_with_timeout "$API_TIMEOUT" npx tsx "$route_tool" --json --file "$route_input_file" --repo-dir "$REPO_DIR" --source live --input-kind task-packet "${route_max_cost_args[@]}" "${route_mode_args[@]}" 2>"$route_stderr_file"); then
              route_rc=0
            else
              route_rc=$?
            fi
          fi

          if [[ -s "$route_stderr_file" ]]; then
            cat "$route_stderr_file" >> "$routing_log_file"
            replay_route_transparency_logs "$route_stderr_file"
          fi

          if [[ -n "$route_json" ]]; then
            printf '%s\n' "$route_json" >> "$routing_log_file"
          fi

          if [[ -n "$route_json" ]] && echo "$route_json" | jq -e '.planner and .coder and .reviewer' >/dev/null 2>&1; then
            route_source="live"
            break
          fi

          if [[ -n "$route_json" ]]; then
            route_reason="invalid_json"
          elif (( route_rc == 124 )); then
            route_reason="timeout"
          else
            route_reason="command_failed"
          fi

          log_warn "  Workflow routing attempt $route_attempt failed (${route_reason}, exit=${route_rc:-0})"
          if (( route_attempt < 3 )); then
            local route_backoff=$(( 1 << (route_attempt - 1) ))
            sleep "$route_backoff"
          fi
          route_attempt=$((route_attempt + 1))
        done
      fi

      if [[ -z "$route_source" ]] && [[ -f "$saved_route" ]] && jq -e '.planner and .coder and .reviewer' "$saved_route" >/dev/null 2>&1; then
        route_json=$(cat "$saved_route" 2>/dev/null || echo "")
        route_source="$(cat "$saved_route_source_file" 2>/dev/null || echo "startup-cache")"
        if [[ "$route_source" == "batch-cache" ]]; then
          log "info" "  Workflow route cache hit from batch cache"
        else
          route_source="startup-cache"
          log "info" "  Workflow route cache hit from startup cache"
        fi
      fi

      if [[ -z "$route_source" ]] && [[ -s "$route_input_file" ]]; then
        printf '\n[heuristic fallback]\n' >> "$routing_log_file"
        rm -f "$route_stderr_file"
        if [[ "$route_debug_enabled" == "true" ]]; then
          if route_json=$(_with_timeout "$API_TIMEOUT" npx tsx "$route_tool" --json --mode heuristic --file "$route_input_file" --repo-dir "$REPO_DIR" --source heuristic-fallback --input-kind heuristic "${route_max_cost_args[@]}" 2>"$route_stderr_file"); then
            route_rc=0
          else
            route_rc=$?
          fi
        else
          if route_json=$(_with_timeout "$API_TIMEOUT" npx tsx "$route_tool" --json --mode heuristic --file "$route_input_file" --repo-dir "$REPO_DIR" --source heuristic-fallback --input-kind heuristic "${route_max_cost_args[@]}" 2>"$route_stderr_file"); then
            route_rc=0
          else
            route_rc=$?
          fi
        fi

        if [[ -s "$route_stderr_file" ]]; then
          cat "$route_stderr_file" >> "$routing_log_file"
          replay_route_transparency_logs "$route_stderr_file"
        fi

        if [[ -n "$route_json" ]]; then
          printf '%s\n' "$route_json" >> "$routing_log_file"
        fi

        if [[ -n "$route_json" ]] && echo "$route_json" | jq -e '.planner and .coder and .reviewer' >/dev/null 2>&1; then
          route_source="heuristic-fallback"
          log "info" "  Workflow route selected via heuristic fallback"
        else
          if [[ -n "$route_json" ]]; then
            route_reason="invalid_json"
          elif (( route_rc == 124 )); then
            route_reason="timeout"
          else
            route_reason="command_failed"
          fi
        fi
      fi

      if [[ -n "$route_source" ]] && [[ -n "$route_json" ]] && echo "$route_json" | jq -e '.planner and .coder and .reviewer' >/dev/null 2>&1; then
        # Extract stage-specific models from workflow routing decision
        planner_model=$(echo "$route_json" | jq -r '.planner // empty' 2>/dev/null)
        task_model=$(echo "$route_json" | jq -r '.coder // empty' 2>/dev/null)
        reviewer_model=$(echo "$route_json" | jq -r '.reviewer // empty' 2>/dev/null)
        plan_depth=$(echo "$route_json" | jq -r '.planDepth // "light"' 2>/dev/null)
        code_depth=$(echo "$route_json" | jq -r '.codeDepth // "medium"' 2>/dev/null)
        review_mode=$(echo "$route_json" | jq -r '.reviewRecommended // "static"' 2>/dev/null)

        # Resolve agents for each stage
        if declare -F agent_resolve_models_for_roles >/dev/null 2>&1; then
          if agent_resolve_models_for_roles "$planner_model" "$task_model" "$reviewer_model"; then
            :
          fi
          planner_agent="$(agent_resolve_batch_agent_for_role "planner")"
          task_agent_cmd="$(agent_resolve_batch_agent_for_role "coder")"
          reviewer_agent="$(agent_resolve_batch_agent_for_role "reviewer")"
        else
          if [[ -n "$planner_model" ]]; then
            planner_agent="$(agent_resolve_from_model "$planner_model" "planning" || true)"
          fi
          if [[ -n "$task_model" ]]; then
            task_agent_cmd="$(agent_resolve_from_model "$task_model" "coding" || true)"
          fi
          if [[ -n "$reviewer_model" ]]; then
            reviewer_agent="$(agent_resolve_from_model "$reviewer_model" "review" || true)"
          fi
        fi

        if [[ "$route_source" == "live" ]]; then
          log "info" "  $issue Route: planner=$planner_model ($plan_depth), coder=$task_model ($code_depth), reviewer=$reviewer_model ($review_mode)"
        elif [[ "$route_source" == "batch-cache" ]]; then
          log "info" "  $issue Route (from batch cache): planner=$planner_model ($plan_depth), coder=$task_model ($code_depth), reviewer=$reviewer_model ($review_mode)"
        elif [[ "$route_source" == "startup-cache" ]]; then
          log "info" "  $issue Route (from startup cache): planner=$planner_model ($plan_depth), coder=$task_model ($code_depth), reviewer=$reviewer_model ($review_mode)"
        else
          log "info" "  $issue Route (heuristic fallback): planner=$planner_model ($plan_depth), coder=$task_model ($code_depth), reviewer=$reviewer_model ($review_mode)"
        fi
      else
        task_agent_cmd="$AGENT_CMD"
        task_model=""
        planner_agent=""
        planner_model=""
        reviewer_agent=""
        reviewer_model=""
        plan_depth="light"
        code_depth="medium"
        review_mode="static"
        cat > "$routing_failure_file" <<EOF
issue=$issue
packet=$route_input_file
saved_route=$saved_route
reason=${route_reason:-unknown}
exit_code=${route_rc:-0}
debug_log=$routing_log_file
fallback_agent=$task_agent_cmd
recovery=Retry with enter $issue, or run: wavemill config migrate-model-settings
EOF
        log "info" "  Workflow routing unavailable (${route_reason:-unknown}), using default agent"
      fi
      rm -f "$route_stderr_file"
    fi
  fi

  # Validate the selected agent exists
  if ! agent_validate_phase_launch "$task_agent_cmd" "coding" "$task_model" "$REPO_DIR"; then
    if agent_is_native_cmd "$task_agent_cmd"; then
      mark_task_needs_user_and_defer "$issue" "$slug" "coder_route_not_launchable" "Native coder route is not launchable: agent=$task_agent_cmd model=${task_model:-agent-default}"
      return 0
    fi
    log_warn "  Agent '$task_agent_cmd' not found, falling back to '$AGENT_CMD'"
    task_agent_cmd="$AGENT_CMD"
    task_model=""
  fi

  # Validate planner and reviewer agents if they were set
  if [[ -n "$planner_agent" ]] && ! agent_validate_phase_launch "$planner_agent" "planning" "$planner_model" "$REPO_DIR"; then
    if agent_is_native_cmd "$planner_agent"; then
      mark_task_needs_user_and_defer "$issue" "$slug" "planner_route_not_launchable" "Native planner route is not launchable: agent=$planner_agent model=$planner_model"
      return 0
    fi
    log_warn "  Planner agent '$planner_agent' not found, using coder agent"
    planner_agent="$task_agent_cmd"
    planner_model="$task_model"
  fi
  if [[ -n "$reviewer_agent" ]] && ! agent_validate_phase_launch "$reviewer_agent" "review" "$reviewer_model" "$REPO_DIR"; then
    if agent_is_native_cmd "$reviewer_agent"; then
      mark_task_needs_user_and_defer "$issue" "$slug" "reviewer_route_not_launchable" "Native reviewer route is not launchable: agent=$reviewer_agent model=$reviewer_model"
      return 0
    fi
    log_warn "  Reviewer agent '$reviewer_agent' not found, using coder agent"
    reviewer_agent="$task_agent_cmd"
    reviewer_model="$task_model"
  fi

  if [[ -z "${WAVEMILL_DISABLE_CHALLENGE:-}" ]] && should_update_linear_state "$issue" && (( remaining_slots >= 1 )); then
    local challenge_args challenge_plan challenge_mode challenge_reason challenge_stage challenge_intent challenge_execution_intent primary_varied challenger_varied
    # Challengers are free overhead — always pass remaining-slots >= 2
    challenge_mode="single"
    challenge_reason=""
    if [[ -n "${FORCE_MODEL:-}" ]]; then
      challenge_reason="forced_model"
      log "debug" "  $issue: Challenge skipped because FORCE_MODEL is set ($FORCE_MODEL)"
    else
      local _dyn_rs=$remaining_slots
      (( _dyn_rs < 2 )) && _dyn_rs=2
      challenge_args=(--issue "$issue" --slug "$slug" --title "$title" --repo-dir "$REPO_DIR" --remaining-slots "$_dyn_rs")
      [[ -n "$task_model" ]] && challenge_args+=(--primary-model "$task_model")
      [[ -n "$packet_file" ]] && challenge_args+=(--file "$packet_file")
      if [[ -d "${WORKTREE_ROOT}/${slug}/features/${slug}" ]]; then
        challenge_args+=(--feature-dir "${WORKTREE_ROOT}/${slug}/features/${slug}")
      fi
      challenge_plan=$(_with_timeout "$API_TIMEOUT" npx tsx "$TOOLS_DIR/resolve-challenge-task.ts" "${challenge_args[@]}" 2>/dev/null || echo "")
      challenge_mode=$(echo "$challenge_plan" | jq -r '.mode // "single"' 2>/dev/null || echo "single")
      challenge_reason=$(echo "$challenge_plan" | jq -r '.reason // empty' 2>/dev/null || echo "")
      log_challenge_selection_health_plan "$issue" "$challenge_plan"
      if [[ "$challenge_mode" == "challenge_unavailable" ]]; then
        log_challenge_unavailable_plan "$issue" "$challenge_plan"
        return 1
      fi
      if challenge_plan_stage_requires_effective_route "$challenge_plan"; then
        release_challenge_selection_health_plan "$issue" "$challenge_plan"
        # A plan-stage challenge cannot be formed before the expanded route
        # exists.  Retarget it to the implementation stage rather than dropping
        # to a single-model run: discarding the pair here is how an already
        # selected open-weight coder arm disappeared entirely (HOK-534).
        local retargeted_plan retargeted_mode
        retargeted_plan=$(_with_timeout "$API_TIMEOUT" npx tsx "$TOOLS_DIR/resolve-challenge-task.ts" \
          "${challenge_args[@]}" --pinned-stage implementation 2>/dev/null || echo "")
        retargeted_mode=$(echo "$retargeted_plan" | jq -r '.mode // "single"' 2>/dev/null || echo "single")
        if [[ "$retargeted_mode" == "challenge" ]]; then
          challenge_plan="$retargeted_plan"
          challenge_mode="challenge"
          challenge_reason=$(echo "$challenge_plan" | jq -r '.reason // empty' 2>/dev/null || echo "")
          log_challenge_selection_health_plan "$issue" "$challenge_plan"
          log_warn "  $issue: Planner challenge unavailable before expansion — retargeted to implementation stage"
        else
          challenge_mode="single"
          challenge_reason="plan_stage_expanded_route_unavailable"
          log_warn "  $issue: Planner challenge deferred until expanded route is available"
        fi
      fi
    fi
    if [[ "$challenge_mode" == "challenge" ]]; then
      challenge_enabled_for_launch="true"
      challenge_pair="$issue"
      # HOK-2926: this task is the pair's primary. challenge_role was seeded
      # from state above, but a bootstrap pair is formed before the task has
      # any state entry, so it is empty here. The canonical save_task_state
      # fails closed on an empty role for a challenge entry (HOK-2876), which
      # would drop the primary's ledger write entirely — the arm then runs
      # with no slug and is invisible to the dashboard. The pre-launch batch
      # path already stamps "primary"; mirror it here.
      challenge_role="primary"
      challenge_stage=$(echo "$challenge_plan" | jq -r '.challengeStage // "implementation"' 2>/dev/null || echo "implementation")
      challenge_execution_intent=$(echo "$challenge_plan" | jq -c '.challengeExecutionIntent // empty' 2>/dev/null || true)
      task_model=$(echo "$challenge_plan" | jq -r '.entries[0].model // empty' 2>/dev/null)
      task_agent_cmd=$(echo "$challenge_plan" | jq -r '.entries[0].agent // empty' 2>/dev/null)

      # Extract primary routing fields
      planner_model=$(echo "$challenge_plan" | jq -r '.entries[0].planner // empty' 2>/dev/null)
      reviewer_model=$(echo "$challenge_plan" | jq -r '.entries[0].reviewer // empty' 2>/dev/null)
      plan_depth=$(echo "$challenge_plan" | jq -r '.entries[0].planDepth // "light"' 2>/dev/null)
      code_depth=$(echo "$challenge_plan" | jq -r '.entries[0].codeDepth // "medium"' 2>/dev/null)
      review_mode=$(echo "$challenge_plan" | jq -r '.entries[0].reviewMode // "static"' 2>/dev/null)

      # Extract challenger info
      challenger_key=$(echo "$challenge_plan" | jq -r '.entries[1].key // empty' 2>/dev/null)
      challenger_slug=$(echo "$challenge_plan" | jq -r '.entries[1].slug // empty' 2>/dev/null)
      challenger_model=$(echo "$challenge_plan" | jq -r '.entries[1].model // empty' 2>/dev/null)
      challenger_agent=$(echo "$challenge_plan" | jq -r '.entries[1].agent // empty' 2>/dev/null)

      # Extract challenger routing fields
      challenger_planner=$(echo "$challenge_plan" | jq -r '.entries[1].planner // empty' 2>/dev/null)
      challenger_reviewer=$(echo "$challenge_plan" | jq -r '.entries[1].reviewer // empty' 2>/dev/null)
      challenger_plan_depth=$(echo "$challenge_plan" | jq -r '.entries[1].planDepth // "light"' 2>/dev/null)
      challenger_code_depth=$(echo "$challenge_plan" | jq -r '.entries[1].codeDepth // "medium"' 2>/dev/null)
      challenger_review_mode=$(echo "$challenge_plan" | jq -r '.entries[1].reviewMode // "static"' 2>/dev/null)
      challenge_intent=$(echo "$challenge_plan" | jq -c '.challengeIntent // null' 2>/dev/null || echo "null")

      cp "$packet_file" "/tmp/${SESSION}-${challenger_key}-taskpacket.md" 2>/dev/null || true
      cp "/tmp/${SESSION}-${issue}-issue.json" "/tmp/${SESSION}-${challenger_key}-issue.json" 2>/dev/null || true
      cp "/tmp/${SESSION}-${issue}-taskpacket-details.md" "/tmp/${SESSION}-${challenger_key}-taskpacket-details.md" 2>/dev/null || true

      should_launch_challenger="true"
      LAST_LAUNCHED_SLOTS=1  # Challenger is free overhead, doesn't consume a slot
      primary_varied=$(echo "$challenge_plan" | jq -r '.entries[0].variedModel // .entries[0].model // empty' 2>/dev/null)
      challenger_varied=$(echo "$challenge_plan" | jq -r '.entries[1].variedModel // .entries[1].model // empty' 2>/dev/null)
      log "status" "  Challenge selected (stage=${challenge_stage}: ${primary_varied} vs ${challenger_varied}) [challenger is extra pane]"
      challenge_assert_arms_diverge "$issue" "$challenge_stage" "$primary_varied" "$challenger_varied" "$challenge_execution_intent"
    elif [[ -n "$challenge_reason" ]] && [[ "$challenge_reason" != "challenge_disabled" ]] && [[ "$challenge_reason" != "roll_not_selected" ]]; then
      log "debug" "  Challenge skipped ($challenge_reason), launching single-model run"
    fi
  fi

  if [[ -z "${FORCE_MODEL:-}" ]]; then
    [[ -n "${WAVEMILL_PLANNER_MODEL:-}" ]] && planner_model="$WAVEMILL_PLANNER_MODEL"
    [[ -n "${WAVEMILL_CODER_MODEL:-}" ]] && task_model="$WAVEMILL_CODER_MODEL"
    [[ -n "${WAVEMILL_REVIEWER_MODEL:-}" ]] && reviewer_model="$WAVEMILL_REVIEWER_MODEL"
  fi

  if declare -F agent_resolve_models_for_roles >/dev/null 2>&1 && [[ -n "$planner_model$task_model$reviewer_model" ]]; then
    if ! agent_resolve_models_for_roles "$planner_model" "$task_model" "$reviewer_model"; then
      mark_task_needs_user_and_defer "$issue" "$slug" "route_not_launchable" "${AGENT_RESOLVE_LAST_DIAGNOSTIC:-agent resolution failed}"
      return 0
    fi
    [[ -n "$planner_model" ]] && planner_agent="$(agent_resolve_batch_agent_for_role "planner")"
    if [[ -n "$task_model" ]]; then
      task_agent_cmd="$(agent_resolve_batch_agent_for_role "coder")"
    else
      task_agent_cmd="${task_agent_cmd:-$AGENT_CMD}"
    fi
    [[ -n "$reviewer_model" ]] && reviewer_agent="$(agent_resolve_batch_agent_for_role "reviewer")"
  else
    if [[ -n "$planner_model" ]]; then
      if ! planner_agent="$(agent_resolve_from_model "$planner_model" "planning")"; then
        mark_task_needs_user_and_defer "$issue" "$slug" "planner_route_not_launchable" "${AGENT_RESOLVE_LAST_DIAGNOSTIC:-agent resolution failed}"
        return 0
      fi
    fi
    if [[ -n "$task_model" ]]; then
      if ! task_agent_cmd="$(agent_resolve_from_model "$task_model" "coding")"; then
        mark_task_needs_user_and_defer "$issue" "$slug" "coder_route_not_launchable" "${AGENT_RESOLVE_LAST_DIAGNOSTIC:-agent resolution failed}"
        return 0
      fi
    else
      task_agent_cmd="${task_agent_cmd:-$AGENT_CMD}"
    fi
    if [[ -n "$reviewer_model" ]]; then
      if ! reviewer_agent="$(agent_resolve_from_model "$reviewer_model" "review")"; then
        mark_task_needs_user_and_defer "$issue" "$slug" "reviewer_route_not_launchable" "${AGENT_RESOLVE_LAST_DIAGNOSTIC:-agent resolution failed}"
        return 0
      fi
    fi
  fi

  if [[ -n "$planner_model" && -z "$planner_agent" ]]; then
    mark_task_needs_user_and_defer "$issue" "$slug" "planner_route_not_launchable" "Selected planner route is not launchable: agent resolution returned empty for model=$planner_model"
    return 0
  fi
  if [[ -z "$task_agent_cmd" ]]; then
    mark_task_needs_user_and_defer "$issue" "$slug" "coder_route_not_launchable" "Selected coder route is not launchable: agent resolution returned empty for model=${task_model:-agent-default}"
    return 0
  fi
  if [[ -n "$reviewer_model" && -z "$reviewer_agent" ]]; then
    mark_task_needs_user_and_defer "$issue" "$slug" "reviewer_route_not_launchable" "Selected reviewer route is not launchable: agent resolution returned empty for model=$reviewer_model"
    return 0
  fi

  if ! agent_validate_phase_launch "$task_agent_cmd" "coding" "$task_model" "$REPO_DIR"; then
    mark_task_needs_user_and_defer "$issue" "$slug" "coder_route_not_launchable" "Selected coder route is not launchable: agent=$task_agent_cmd model=${task_model:-agent-default}"
    return 0
  fi
  if [[ -n "$planner_model" ]] && ! agent_validate_phase_launch "$planner_agent" "planning" "$planner_model" "$REPO_DIR"; then
    mark_task_needs_user_and_defer "$issue" "$slug" "planner_route_not_launchable" "Selected planner route is not launchable: agent=$planner_agent model=$planner_model"
    return 0
  fi
  if [[ -n "$reviewer_model" ]] && ! agent_validate_phase_launch "$reviewer_agent" "review" "$reviewer_model" "$REPO_DIR"; then
    mark_task_needs_user_and_defer "$issue" "$slug" "reviewer_route_not_launchable" "Selected reviewer route is not launchable: agent=$reviewer_agent model=$reviewer_model"
    return 0
  fi

  local challenger_planner_agent="" challenger_reviewer_agent=""
  if [[ "$challenge_enabled_for_launch" == "true" ]]; then
    if declare -F agent_resolve_models_for_roles >/dev/null 2>&1; then
      if ! agent_resolve_models_for_roles "$challenger_planner" "$challenger_model" "$challenger_reviewer"; then
        log_error "  Selected challenger route is not launchable: ${AGENT_RESOLVE_LAST_DIAGNOSTIC:-agent resolution failed}"
        challenge_selection_health_release "$challenge_pair" "$challenge_stage" \
          "$(challenge_selection_health_varied_model "$challenge_stage" "$challenger_planner" "$challenger_model" "$challenger_reviewer")"
        return 1
      fi
      challenger_planner_agent="$(agent_resolve_batch_agent_for_role "planner")"
      challenger_agent="$(agent_resolve_batch_agent_for_role "coder")"
      challenger_reviewer_agent="$(agent_resolve_batch_agent_for_role "reviewer")"
    else
      if [[ -n "$challenger_planner" ]] && ! challenger_planner_agent="$(agent_resolve_from_model "$challenger_planner" "planning")"; then
        log_error "  Selected challenger planner route is not launchable: ${AGENT_RESOLVE_LAST_DIAGNOSTIC:-agent resolution failed}"
        challenge_selection_health_release "$challenge_pair" "$challenge_stage" \
          "$(challenge_selection_health_varied_model "$challenge_stage" "$challenger_planner" "$challenger_model" "$challenger_reviewer")"
        return 1
      fi
      if [[ -n "$challenger_model" ]] && ! challenger_agent="$(agent_resolve_from_model "$challenger_model" "coding")"; then
        log_error "  Selected challenger coder route is not launchable: ${AGENT_RESOLVE_LAST_DIAGNOSTIC:-agent resolution failed}"
        challenge_selection_health_release "$challenge_pair" "$challenge_stage" \
          "$(challenge_selection_health_varied_model "$challenge_stage" "$challenger_planner" "$challenger_model" "$challenger_reviewer")"
        return 1
      fi
      if [[ -n "$challenger_reviewer" ]] && ! challenger_reviewer_agent="$(agent_resolve_from_model "$challenger_reviewer" "review")"; then
        log_error "  Selected challenger reviewer route is not launchable: ${AGENT_RESOLVE_LAST_DIAGNOSTIC:-agent resolution failed}"
        challenge_selection_health_release "$challenge_pair" "$challenge_stage" \
          "$(challenge_selection_health_varied_model "$challenge_stage" "$challenger_planner" "$challenger_model" "$challenger_reviewer")"
        return 1
      fi
    fi

    if [[ -n "$challenger_planner" && -z "$challenger_planner_agent" ]]; then
      log_error "  Selected challenger planner route is not launchable: agent resolution returned empty for model=$challenger_planner"
      challenge_selection_health_release "$challenge_pair" "$challenge_stage" \
        "$(challenge_selection_health_varied_model "$challenge_stage" "$challenger_planner" "$challenger_model" "$challenger_reviewer")"
      return 1
    fi
    if [[ -n "$challenger_model" && -z "$challenger_agent" ]]; then
      log_error "  Selected challenger coder route is not launchable: agent resolution returned empty for model=$challenger_model"
      challenge_selection_health_release "$challenge_pair" "$challenge_stage" \
        "$(challenge_selection_health_varied_model "$challenge_stage" "$challenger_planner" "$challenger_model" "$challenger_reviewer")"
      return 1
    fi
    if [[ -n "$challenger_reviewer" && -z "$challenger_reviewer_agent" ]]; then
      log_error "  Selected challenger reviewer route is not launchable: agent resolution returned empty for model=$challenger_reviewer"
      challenge_selection_health_release "$challenge_pair" "$challenge_stage" \
        "$(challenge_selection_health_varied_model "$challenge_stage" "$challenger_planner" "$challenger_model" "$challenger_reviewer")"
      return 1
    fi

    if ! agent_validate_phase_launch "$challenger_agent" "coding" "$challenger_model" "$REPO_DIR"; then
      log_error "  Selected challenger coder route is not launchable: agent=$challenger_agent model=$challenger_model"
      challenge_selection_health_release "$challenge_pair" "$challenge_stage" \
        "$(challenge_selection_health_varied_model "$challenge_stage" "$challenger_planner" "$challenger_model" "$challenger_reviewer")"
      return 1
    fi
    if [[ -n "$challenger_planner_agent" ]] && ! agent_validate_phase_launch "$challenger_planner_agent" "planning" "$challenger_planner" "$REPO_DIR"; then
      log_error "  Selected challenger planner route is not launchable: agent=$challenger_planner_agent model=$challenger_planner"
      challenge_selection_health_release "$challenge_pair" "$challenge_stage" \
        "$(challenge_selection_health_varied_model "$challenge_stage" "$challenger_planner" "$challenger_model" "$challenger_reviewer")"
      return 1
    fi
    if [[ -n "$challenger_reviewer_agent" ]] && ! agent_validate_phase_launch "$challenger_reviewer_agent" "review" "$challenger_reviewer" "$REPO_DIR"; then
      log_error "  Selected challenger reviewer route is not launchable: agent=$challenger_reviewer_agent model=$challenger_reviewer"
      challenge_selection_health_release "$challenge_pair" "$challenge_stage" \
        "$(challenge_selection_health_varied_model "$challenge_stage" "$challenger_planner" "$challenger_model" "$challenger_reviewer")"
      return 1
    fi
  fi

  if ! agent_validate_phase_launch "$task_agent_cmd" "coding" "$task_model" "$REPO_DIR"; then
    mark_task_needs_user_and_defer "$issue" "$slug" "coder_route_not_launchable" "Selected coder route is not launchable: agent=$task_agent_cmd model=${task_model:-agent-default}"
    return 0
  fi
  if [[ -n "$planner_agent" ]] && ! agent_validate_phase_launch "$planner_agent" "planning" "$planner_model" "$REPO_DIR"; then
    mark_task_needs_user_and_defer "$issue" "$slug" "planner_route_not_launchable" "Selected planner route is not launchable: agent=$planner_agent model=$planner_model"
    return 0
  fi
  if [[ -n "$reviewer_agent" ]] && ! agent_validate_phase_launch "$reviewer_agent" "review" "$reviewer_model" "$REPO_DIR"; then
    mark_task_needs_user_and_defer "$issue" "$slug" "reviewer_route_not_launchable" "Selected reviewer route is not launchable: agent=$reviewer_agent model=$reviewer_model"
    return 0
  fi

  local challenger_planner_agent="" challenger_reviewer_agent=""
  if [[ "$challenge_enabled_for_launch" == "true" ]]; then
    if declare -F agent_resolve_models_for_roles >/dev/null 2>&1; then
      if agent_resolve_models_for_roles "$challenger_planner" "$challenger_model" "$challenger_reviewer"; then
        :
      fi
      challenger_planner_agent="$(agent_resolve_batch_agent_for_role "planner")"
      challenger_agent="$(agent_resolve_batch_agent_for_role "coder")"
      challenger_reviewer_agent="$(agent_resolve_batch_agent_for_role "reviewer")"
    else
      [[ -n "$challenger_planner" ]] && challenger_planner_agent="$(agent_resolve_from_model "$challenger_planner" "planning" || true)"
      [[ -n "$challenger_model" ]] && challenger_agent="$(agent_resolve_from_model "$challenger_model" "coding" || true)"
      [[ -n "$challenger_reviewer" ]] && challenger_reviewer_agent="$(agent_resolve_from_model "$challenger_reviewer" "review" || true)"
    fi

    if ! agent_validate_phase_launch "$challenger_agent" "coding" "$challenger_model" "$REPO_DIR"; then
      log_error "  Selected challenger coder route is not launchable: agent=$challenger_agent model=$challenger_model"
      challenge_selection_health_release "$challenge_pair" "$challenge_stage" \
        "$(challenge_selection_health_varied_model "$challenge_stage" "$challenger_planner" "$challenger_model" "$challenger_reviewer")"
      return 1
    fi
    if [[ -n "$challenger_planner_agent" ]] && ! agent_validate_phase_launch "$challenger_planner_agent" "planning" "$challenger_planner" "$REPO_DIR"; then
      log_error "  Selected challenger planner route is not launchable: agent=$challenger_planner_agent model=$challenger_planner"
      challenge_selection_health_release "$challenge_pair" "$challenge_stage" \
        "$(challenge_selection_health_varied_model "$challenge_stage" "$challenger_planner" "$challenger_model" "$challenger_reviewer")"
      return 1
    fi
    if [[ -n "$challenger_reviewer_agent" ]] && ! agent_validate_phase_launch "$challenger_reviewer_agent" "review" "$challenger_reviewer" "$REPO_DIR"; then
      log_error "  Selected challenger reviewer route is not launchable: agent=$challenger_reviewer_agent model=$challenger_reviewer"
      challenge_selection_health_release "$challenge_pair" "$challenge_stage" \
        "$(challenge_selection_health_varied_model "$challenge_stage" "$challenger_planner" "$challenger_model" "$challenger_reviewer")"
      return 1
    fi
  fi

  # Save to state ledger (after routing so agent is known)
  local initial_phase="planning"
  # If this task was already marked as a challenge participant (e.g. challenger
  # launched via recursive call with WAVEMILL_DISABLE_CHALLENGE=1), preserve
  # the existing challenge flag rather than overwriting with "false".
  local effective_challenge="$challenge_enabled_for_launch"
  if [[ "$effective_challenge" != "true" && -n "$challenge_role" ]]; then
    effective_challenge="true"
  fi
  save_task_state "$issue" "$slug" "$branch" "$wt_dir" "" "" "${planner_agent:-$task_agent_cmd}" "$linear_issue" "$effective_challenge" "$challenge_pair" "${challenge_role:-}" "$task_model" "$planner_model" "$task_model" "$reviewer_model" "$plan_depth" "$code_depth" "$review_mode" "${challenge_stage:-}"
  if [[ "$challenge_enabled_for_launch" == "true" ]]; then
    save_task_state "$challenger_key" "$challenger_slug" "task/${challenger_slug}" "${WORKTREE_ROOT}/${challenger_slug}" "" "" "${challenger_planner_agent:-$challenger_agent}" "$linear_issue" "true" "$challenge_pair" "challenger" "$challenger_model" "$challenger_planner" "$challenger_model" "$challenger_reviewer" "$challenger_plan_depth" "$challenger_code_depth" "$challenger_review_mode" "$challenge_stage"
    state_mutate "$STATE_FILE" '.tasks[$issue].challengeStage = $stage' --arg issue "$challenger_key" --arg stage "$challenge_stage" || true
    state_mutate "$STATE_FILE" \
      '.tasks[$issue].challengerLaunched = true
       | .tasks[$issue].updated = (now | todate)' \
      --arg issue "$issue" >/dev/null 2>&1 || true
    # One writer, both arms, both surfaces.  The separate challengeIntent write
    # that used to live here persisted a second, independently-built schema
    # under a different key; resolve-challenge-task.ts now emits the canonical
    # intent alone and persist_challenge_execution_intent is its only writer.
    persist_challenge_execution_intent "$issue" "$challenger_key" \
      "${WORKTREE_ROOT}/${slug}/features/${slug}" \
      "$challenge_execution_intent" \
      "${WORKTREE_ROOT}/${challenger_slug}/features/${challenger_slug}"
  fi
  if [[ -n "${challenge_stage:-}" ]]; then
    state_mutate "$STATE_FILE" '.tasks[$issue].challengeStage = $stage' --arg issue "$issue" --arg stage "$challenge_stage" || true
  fi
  set_task_phase "$issue" "$initial_phase"

  # Verify agent was saved correctly (helps debug future issues)
  if [[ "${DEBUG_AGENT:-}" == "1" ]]; then
    local saved_agent
    local expected_saved_agent="${planner_agent:-$task_agent_cmd}"
    saved_agent=$(jq -r --arg i "$issue" '.tasks[$i].agent // ""' "$STATE_FILE" 2>/dev/null)
    if [[ "$saved_agent" != "$expected_saved_agent" ]]; then
      log_warn "  ⚠ Agent save mismatch: expected='$expected_saved_agent' but got='$saved_agent'"
    else
      log "info" "Agent set to: $expected_saved_agent"
    fi
  fi

  # Pre-trust worktree directory so Claude doesn't prompt
  if [[ "$task_agent_cmd" == "claude" ]] && [[ -f "$HOME/.claude.json" ]]; then
    local already_trusted
    already_trusted=$(jq -r --arg p "$wt_dir" '.projects[$p].hasTrustDialogAccepted // false' "$HOME/.claude.json" 2>/dev/null)
    if [[ "$already_trusted" != "true" ]]; then
      local _tmp
      _tmp=$(mktemp)
      if jq --arg p "$wt_dir" '
        .projects[$p] = (.projects[$p] // {}) |
        .projects[$p].hasTrustDialogAccepted = true |
        .projects[$p].hasCompletedProjectOnboarding = true
      ' "$HOME/.claude.json" > "$_tmp" 2>/dev/null; then
        mv "$_tmp" "$HOME/.claude.json"
      else
        rm -f "$_tmp"
      fi
    fi
  fi

  # Create tmux window
  local win="$issue-$slug"
  local win_target
  tmux new-window -d -t "$SESSION" -n "$win" -c "$wt_dir"
  win_target="$(tmux display-message -p -t "$SESSION:$win" '#{window_id}' 2>/dev/null || true)"
  [[ -n "$win_target" ]] || win_target="$win"
  persist_task_window_id "$issue" "$win_target"
  # Prevent window destruction if the pane shell exits (e.g. from a stray Ctrl-D).
  # This lets _pane_is_dead_or_idle detect and respawn dead panes during phase transitions.
  tmux set-option -t "$(_tmux_target_join "$SESSION" "$win_target")" remain-on-exit on 2>/dev/null || true
  set_window_attention_state "$win" "clear"

  # Run setup command in new worktrees (e.g., npm install)
  if [[ -n "${SETUP_CMD:-}" ]] && [[ "$created_new" == "true" ]]; then
    log "info" "  Running setup: $SETUP_CMD"
    local _sentinel="/tmp/.wavemill-setup-${issue//[^a-zA-Z0-9_-]/_}"
    rm -f "$_sentinel"
    tmux send-keys -t "$(_tmux_target_join "$SESSION" "$win_target")" \
      "$SETUP_CMD && touch '$_sentinel' || touch '$_sentinel'" C-m
    local _t=0
    while [[ ! -f "$_sentinel" ]] && (( _t < 180 )); do
      sleep 2; (( _t += 2 ))
    done
    rm -f "$_sentinel"
    if (( _t >= 180 )); then
      log_warn "  Setup timed out after 180s, proceeding anyway"
    else
      log "info" "  Setup complete"
    fi
  fi

  # ── Build issue context and launch agent ──────────────────────────────
  # Prompt assembly uses shared builders in agent-adapters.sh (single
  # source of truth shared with wavemill-orchestrator.sh).

  local status_file="/tmp/${SESSION}-${issue}-status.txt"
  local details_file="/tmp/${SESSION}-${issue}-taskpacket-details.md"
  local details_context=""

  # Copy details file to worktree and build details context string
  if [[ -f "$details_file" ]]; then
    if [[ "$PLANNING_MODE" == "interactive" ]]; then
      local feature_dir="$wt_dir/features/$slug"
      mkdir -p "$feature_dir"
      cp "$details_file" "$feature_dir/task-packet-details.md"
      # Also persist header for eval artifact discovery (HOK-1033)
      local header_source="/tmp/${SESSION}-${issue}-taskpacket.md"
      if [[ -f "$header_source" ]]; then
        cp "$header_source" "$feature_dir/task-packet-header.md"
      fi
      details_context="
📖 Full Details: Comprehensive task packet with all 9 sections available at:
   features/$slug/task-packet-details.md

Read specific sections on-demand as you plan and implement:
- Section 1: Complete Objective & Scope
- Section 2: Technical Context (dependencies, architecture)
- Section 3: Implementation Approach (step-by-step)
- Section 4: Success Criteria (all requirements with [REQ-FX] tags)
- Section 5: Implementation Constraints (all rules)
- Section 6: Validation Steps (concrete test scenarios)
- Section 7: Definition of Done
- Section 8: Rollback Plan
- Section 9: Proposed Labels"
    else
      cp "$details_file" "$wt_dir/task-packet-details.md"
      # Also persist header for eval artifact discovery (HOK-1033)
      local header_source="/tmp/${SESSION}-${issue}-taskpacket.md"
      if [[ -f "$header_source" ]]; then
        cp "$header_source" "$wt_dir/task-packet-header.md"
      fi
      details_context="
📖 Full Details: Read task-packet-details.md in the repo root for:
- Complete implementation approach (Section 3)
- All success criteria with [REQ-FX] tags (Section 4)
- Concrete validation steps with test scenarios (Section 6)
- Implementation constraints and rules (Section 5)"
    fi
  fi

  local issue_context
  if [[ -n "$packet_content" ]]; then
    issue_context="Issue Description (Brief Overview):
$packet_content
$details_context"
  elif [[ -n "$details_context" ]]; then
    issue_context="$details_context"
  else
    issue_context="NOTE: Task packet details file was not pre-seeded in this worktree.
Implement from the issue description plus direct codebase analysis."
  fi

  # Launch in routing phase - monitor will handle phase transitions
  mkdir -p "$feature_dir"
  local labels_json="[]"
  labels_json=$(echo "$issue_json" | jq '[.labels.nodes[]?.name // empty]' 2>/dev/null || echo "[]")

  jq -n \
    --arg taskId "$issue" \
    --arg title "$title" \
    --arg description "$packet_content" \
    --argjson labels "$labels_json" \
    --arg featureName "$slug" \
    --arg contextPath "features/$slug/selected-task.json" \
    '{
      taskId: $taskId,
      title: $title,
      description: $description,
      labels: $labels,
      workflowType: "feature",
      featureName: $featureName,
      contextPath: $contextPath,
      selectedAt: (now | todate)
    }' > "$feature_dir/selected-task.json"

  # Write routing results directly (no LLM needed — routing is deterministic)
  # The routing tool was already called at lines above (route-task.ts).
  # We just need to write the .routing-complete file and launch planning.
  local routing_file="$feature_dir/.routing-complete"
  local routing_max_cost_usd
  routing_max_cost_usd="$(read_route_json "$SESSION" "$issue" "constraints.maxCostUsd" "")"
  [[ -z "$routing_max_cost_usd" ]] && routing_max_cost_usd="${DEFAULT_MAX_COST_USD:-}"

  local startup_route_file="/tmp/${SESSION}-${issue}-route.json"
  if [[ -f "$startup_route_file" ]] && jq -e '.planner and .coder and .reviewer' "$startup_route_file" >/dev/null 2>&1; then
    jq \
      --arg planner "${planner_model:-claude-sonnet-5}" \
      --arg coder "${task_model:-claude-opus-4-7}" \
      --arg reviewer "${reviewer_model:-claude-sonnet-5}" \
      --arg planDepth "${plan_depth:-light}" \
      --arg codeDepth "${code_depth:-medium}" \
      --arg reviewMode "${review_mode:-static}" \
      --arg source "bootstrap" \
      --arg inputKind "issue" \
      --arg inputPath "features/$slug/selected-task.json" \
      --argjson maxCostUsd "${routing_max_cost_usd:-null}" \
      '(.provenance // {}) as $p
      | .planner = $planner
      | .coder = $coder
      | .reviewer = $reviewer
      | .planDepth = $planDepth
      | .codeDepth = $codeDepth
      | .reviewMode = $reviewMode
      | .reviewRecommended = $reviewMode
      | .provenance = ($p + {
          source: (if (($p.source // "") == "") then $source else $p.source end),
          inputKind: (if (($p.inputKind // "") == "") then $inputKind else $p.inputKind end),
          inputPath: (if (($p.inputPath // "") == "") then $inputPath else $p.inputPath end),
          inputHash: ($p.inputHash // ""),
          routedAt: (if (($p.routedAt // "") == "") then (now | todateiso8601) else $p.routedAt end),
          routerMode: (if (($p.routerMode // "") == "") then "normal" else $p.routerMode end)
        })
      | if $maxCostUsd == null
        then .
        else .maxCostUsd = $maxCostUsd | .constraints = ((.constraints // {}) + {maxCostUsd: $maxCostUsd})
        end' "$startup_route_file" \
      | write_json_artifact "$routing_file"
  else
    jq -n \
      --arg planner "${planner_model:-claude-sonnet-5}" \
      --arg coder "${task_model:-claude-opus-4-7}" \
      --arg reviewer "${reviewer_model:-claude-sonnet-5}" \
      --arg planDepth "${plan_depth:-light}" \
      --arg codeDepth "${code_depth:-medium}" \
      --arg reviewMode "${review_mode:-static}" \
      --arg source "bootstrap" \
      --arg inputKind "issue" \
      --arg inputPath "features/$slug/selected-task.json" \
      --arg provenanceSource "$(read_route_json "$SESSION" "$issue" "source" "")" \
      --arg provenanceInputKind "$(read_route_json "$SESSION" "$issue" "inputKind" "")" \
      --arg provenanceInputPath "$(read_route_json "$SESSION" "$issue" "inputPath" "")" \
      --arg provenanceInputHash "$(read_route_json "$SESSION" "$issue" "inputHash" "")" \
      --arg provenanceRoutedAt "$(read_route_json "$SESSION" "$issue" "routedAt" "")" \
      --arg provenanceRouterMode "$(read_route_json "$SESSION" "$issue" "routerMode" "")" \
      --argjson maxCostUsd "${routing_max_cost_usd:-null}" \
      '{
        planner: $planner,
        coder: $coder,
        reviewer: $reviewer,
        planDepth: $planDepth,
        codeDepth: $codeDepth,
        reviewMode: $reviewMode,
        reviewRecommended: $reviewMode,
        provenance: {
          source: (if $provenanceSource == "" then $source else $provenanceSource end),
          inputKind: (if $provenanceInputKind == "" then $inputKind else $provenanceInputKind end),
          inputPath: (if $provenanceInputPath == "" then $inputPath else $provenanceInputPath end),
          inputHash: $provenanceInputHash,
          routedAt: (if $provenanceRoutedAt == "" then (now | todateiso8601) else $provenanceRoutedAt end),
          routerMode: (if $provenanceRouterMode == "" then "normal" else $provenanceRouterMode end)
        },
        maxCostUsd: $maxCostUsd
      } + (if $maxCostUsd == null then {} else {constraints: {maxCostUsd: $maxCostUsd}} end)' \
      | write_json_artifact "$routing_file"
  fi

  # Save initial route for eval comparison (routed on raw description).
  # Always stamp source='bootstrap' regardless of what the batch router recorded,
  # so .initial-route.json remains unambiguous bootstrap evidence.
  if [[ -f "$feature_dir/.initial-route.json" ]]; then
    log "info" "  Keeping existing .initial-route.json for $issue"
  else
    jq '.provenance.source = "bootstrap"' "$routing_file" \
      | write_json_artifact "$feature_dir/.initial-route.json"
  fi
  local bootstrap_route
  bootstrap_route="$(route_lifecycle_route_id "$feature_dir/.initial-route.json" 2>/dev/null || true)"
  if [[ -n "$bootstrap_route" ]]; then
    log_route_lifecycle "bootstrap_assigned" "issue=$issue" "route=\"$bootstrap_route\""
  fi

  write_phase_config "$feature_dir" "${planner_model:-claude-sonnet-5}" "${task_model:-claude-opus-4-7}" "${reviewer_model:-claude-sonnet-5}" "${plan_depth:-light}" "${code_depth:-medium}" "${review_mode:-static}" "${FORCE_MODEL:-}"

  # Emit task_launched trace event (best-effort)
  trace_append_event "$feature_dir" "$_trace_id" "$issue" "$slug" "launch" "task_launched" "ok" "" "$AGENT_CMD" \
    "$(jq -cn --arg agent "$AGENT_CMD" --arg coder "${task_model:-}" --arg planner "${planner_model:-}" \
      --arg reviewer "${reviewer_model:-}" --arg mode "${PLANNING_MODE:-}" \
      '{meta:{agentCmd:$agent,coderModel:$coder,plannerModel:$planner,reviewerModel:$reviewer,planningMode:$mode}}' 2>/dev/null || echo '{}')" 2>/dev/null || true

  # Emit route_assigned trace event (best-effort)
  if [[ -n "$bootstrap_route" ]]; then
    trace_append_event "$feature_dir" "$_trace_id" "$issue" "$slug" "launch" "route_assigned" "ok" "${task_model:-}" "$AGENT_CMD" \
      "$(jq -cn --arg rt "$bootstrap_route" --arg src "bootstrap" '{meta:{routeId:$rt,routeSource:$src}}' 2>/dev/null || echo '{}')" 2>/dev/null || true
  fi

  # Launch planning phase directly with the routed model (skip routing agent)
  local planner_launch_model resolved_planner_agent
  planner_launch_model="${planner_model:-claude-sonnet-5}"
  if declare -F agent_resolve_model >/dev/null 2>&1; then
    if ! planner_launch_model="$(agent_resolve_model "planner" "${planner_model:-claude-sonnet-5}" "$REPO_DIR")"; then
      if [[ "$effective_challenge" == "true" ]]; then
        challenge_selection_health_release "$challenge_pair" "$challenge_stage" \
          "$(challenge_selection_health_varied_model "$challenge_stage" "$planner_model" "$task_model" "$reviewer_model")"
      fi
      return 1
    fi
  fi
  if ! resolved_planner_agent="$(agent_resolve_from_model "$planner_launch_model" "planning")"; then
    write_stage_result "$feature_dir" "planning" "failed" "" "$planner_launch_model" "${AGENT_RESOLVE_LAST_DIAGNOSTIC:-Planning launch blocked by agent resolution failure.}"
    set_task_phase "$issue" "routing"
    set_window_attention_state "$win" "needs-user"
    log "warn" "⚠ $issue → Planning launch blocked: ${AGENT_RESOLVE_LAST_DIAGNOSTIC:-agent resolution failed}"
    if [[ "$effective_challenge" == "true" ]]; then
      challenge_selection_health_release "$challenge_pair" "$challenge_stage" \
        "$(challenge_selection_health_varied_model "$challenge_stage" "$planner_model" "$task_model" "$reviewer_model")"
    fi
    return 0
  fi

  # Record planning stage as running before the first launch so the monitor
  # keeps the task active even before any planning artifacts exist.
  record_planning_launch_route_snapshot "$feature_dir" "$planner_launch_model" "$resolved_planner_agent" "${plan_depth:-light}" "effective-route"
  write_stage_result_with_history "$feature_dir" "planning" "running" "$resolved_planner_agent" "$planner_launch_model"

  launch_planning_phase "$issue" "$slug" "$title" "$wt_dir" "$branch" "$BASE_BRANCH" \
    "$planner_launch_model" "$resolved_planner_agent" "${plan_depth:-light}"
  local launch_rc=$?
  if ! handle_phase_launch_result "$issue" "$feature_dir" "planning" "routing" "$launch_rc" "$win" \
    "$resolved_planner_agent" "$planner_launch_model"; then
    if [[ "$effective_challenge" == "true" ]]; then
      challenge_selection_health_release "$challenge_pair" "$challenge_stage" \
        "$(challenge_selection_health_varied_model "$challenge_stage" "$planner_model" "$task_model" "$reviewer_model")"
    fi
    return 0
  fi
  if [[ "$effective_challenge" == "true" ]]; then
    challenge_selection_health_ack_launch "$challenge_pair" "$challenge_stage" \
      "$(challenge_selection_health_varied_model "$challenge_stage" "$planner_model" "$task_model" "$reviewer_model")"
  fi
  log "status" "$issue Routing complete (direct), launched planning with $planner_launch_model"

  log "status" "$issue launched (phase: ${initial_phase}, agent: ${resolved_planner_agent}${planner_launch_model:+ --model $planner_launch_model})"
  [[ -n "$planner_model" ]] && log "info" "$issue: Routing: planner=$planner_model, coder=$task_model, reviewer=$reviewer_model"

  if [[ "$should_launch_challenger" == "true" ]]; then
    WAVEMILL_DISABLE_CHALLENGE=1 launch_task "$challenger_key" "$challenger_slug" "$challenger_title" 0
    # The challenger worktree only exists after its launch, so backfill the
    # intent file now.  Both arms must resolve the same intent from the same
    # kind of source, or rerouting can preserve one side and not the other.
    persist_challenge_execution_intent "$issue" "$challenger_key" \
      "${WORKTREE_ROOT}/${challenger_slug}/features/${challenger_slug}" \
      "$challenge_execution_intent"
  fi
}


# ============================================================================
# MAIN MONITORING LOOP
# ============================================================================

# Parse initial tasks from file
declare -A PR_BY_ISSUE BRANCH_BY_ISSUE SLUG_BY_ISSUE CLEANED

# Rehydrate tracked tasks from persisted state first so restarts continue
# monitoring prior in-flight issues.
if [[ -f "$STATE_FILE" ]]; then
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    IFS='|' read -r ISSUE SLUG BRANCH PR <<<"$line"
    [[ -z "$ISSUE" ]] && continue

    if [[ -z "$SLUG" && -n "$BRANCH" ]]; then
      SLUG="${BRANCH#task/}"
    fi
    if [[ -z "$BRANCH" && -n "$SLUG" ]]; then
      BRANCH="task/${SLUG}"
    fi

    [[ -z "$SLUG" || -z "$BRANCH" ]] && continue
    BRANCH_BY_ISSUE["$ISSUE"]="$BRANCH"
    SLUG_BY_ISSUE["$ISSUE"]="$SLUG"
    [[ -n "$PR" ]] && PR_BY_ISSUE["$ISSUE"]="$PR"
  done < <(jq -r '.tasks | to_entries[] | "\(.key)|\(.value.slug // "")|\(.value.branch // "")|\(.value.pr // "")"' "$STATE_FILE" 2>/dev/null)
fi

# Overlay tasks selected in this launch.
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  IFS='|' read -r ISSUE SLUG TITLE <<<"$line"
  [[ -z "$ISSUE" || -z "$SLUG" ]] && continue
  BRANCH_BY_ISSUE["$ISSUE"]="task/${SLUG}"
  SLUG_BY_ISSUE["$ISSUE"]="$SLUG"
done < "$TASKS_FILE"


log "status" "Monitoring tasks and managing work queue..."
[[ "$PLANNING_MODE" == "interactive" ]] && log "info" "  Planning mode: interactive (watching for plan approval)"
if (( EFFECTIVE_MAX_PARALLEL < MAX_PARALLEL )); then
  log "status" "  Max parallel: $EFFECTIVE_MAX_PARALLEL (reduced from $MAX_PARALLEL - all models degraded)$(wavemill_config_annotation "mill.maxParallel" "$MAX_PARALLEL")"
else
  log "info" "  Max parallel: $MAX_PARALLEL$(wavemill_config_annotation "mill.maxParallel" "$MAX_PARALLEL")"
fi
log "info" "  Checking every ${POLL_SECONDS}s$(wavemill_config_annotation "mill.pollSeconds" "$POLL_SECONDS")"
log "info" "  Type 'q' to quit, or 'touch $STATE_DIR/.stop-loop' to stop"
printf '\033[1mTask Backlog\033[0m\n'

QUIT_REQUESTED=false
_active_count_prev=0
LAST_DISPLAY=""       # fingerprint of what was last printed
LAST_ACTIVE_COUNT=-1  # force first render
LAST_WAITING_MSG=""   # track last waiting message to avoid repetition
READY_STALE_MERGE_LANE_LOG_KEYS=$'\n'
TASK_LIST_RENDERED=0              # track task list cursor region in control pane
WAVEMILL_PANE_REPAINT_LAST_LINES=0  # line-count state for repaint helper
SELECT_SHOW_ALL=false
USING_GROUPED_VIEW=false
GROUPED_SELECT_FROM=""
GROUPED_DISPLAY=""
declare -a COMMAND_QUEUE=()
declare -a COMMAND_QUEUE_OFFSETS=()
COMMAND_FILE="$(wavemill_command_file_path "$SESSION")"
COMMAND_OFFSET_WARNED=false

clear_task_list_display() {
  if (( TASK_LIST_RENDERED == 1 )); then
    printf '\033[u'  # restore cursor to saved anchor
    printf '\033[J'  # clear from anchor to end of screen
    TASK_LIST_RENDERED=0
    WAVEMILL_PANE_REPAINT_LAST_LINES=0
  fi
}

# Paint a task-list frame, managing the cursor anchor and repaint state.
# On first call (TASK_LIST_RENDERED=0): emits a blank separator line and
# saves the cursor as the anchor.  On subsequent calls (TASK_LIST_RENDERED=1):
# restores the cursor to the saved anchor before repainting.
paint_task_list_frame() {
  local frame="$1"
  if (( TASK_LIST_RENDERED == 1 )); then
    printf '\033[u'  # restore cursor to anchor
  else
    printf '\n'      # blank separator before first paint
    printf '\033[s'  # save cursor as anchor
  fi
  wavemill_pane_repaint "$frame"
  TASK_LIST_RENDERED=1
}

log_ready_stale_merge_lane_once() {
  local issue="$1" pr="$2" stored_base_sha="$3" current_main_sha="$4"
  local key="${issue}|${pr}|${stored_base_sha}|${current_main_sha}"
  local logged_keys="${READY_STALE_MERGE_LANE_LOG_KEYS:-$'\n'}"

  if [[ "$logged_keys" == *$'\n'"$key"$'\n'* ]]; then
    return 0
  fi

  READY_STALE_MERGE_LANE_LOG_KEYS="${logged_keys}${key}"$'\n'
  log "status" "⚠ $issue → Ready marked stale; waiting for merge lane (PR #$pr)"
}

monitor_command_timestamp() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

read_command_file_line_count() {
  local line_count=0
  [[ -f "$COMMAND_FILE" ]] && line_count=$(wc -l < "$COMMAND_FILE" 2>/dev/null | tr -d ' ')
  [[ "$line_count" =~ ^[0-9]+$ ]] || line_count=0
  printf '%s\n' "$line_count"
}

read_command_offset() {
  local line_count offset_raw
  line_count=$(read_command_file_line_count)

  if [[ ! -r "$STATE_FILE" || ! -s "$STATE_FILE" ]]; then
    printf '%s\n' "0"
    return 0
  fi

  offset_raw=$(jq -r '.monitorCommandOffset // empty' "$STATE_FILE" 2>/dev/null || echo "")
  if [[ -z "$offset_raw" || "$offset_raw" == "null" ]]; then
    if (( line_count > 0 )); then
      [[ "$COMMAND_OFFSET_WARNED" == "false" ]] && log_warn "Command offset missing (init at EOF)."
      COMMAND_OFFSET_WARNED=true
      write_command_offset "$line_count" || true
      printf '%s\n' "$line_count"
      return 0
    fi
    write_command_offset "0" || true
    printf '%s\n' "0"
    return 0
  fi

  if ! [[ "$offset_raw" =~ ^[0-9]+$ ]]; then
    [[ "$COMMAND_OFFSET_WARNED" == "false" ]] && log_warn "Command offset invalid (init at EOF)."
    COMMAND_OFFSET_WARNED=true
    write_command_offset "$line_count" || true
    printf '%s\n' "$line_count"
    return 0
  fi
  if (( offset_raw > line_count )); then
    write_command_offset "$line_count" || true
    printf '%s\n' "$line_count"
    return 0
  fi
  printf '%s\n' "$offset_raw"
}

write_command_offset() {
  local new_offset="$1"
  [[ "$new_offset" =~ ^[0-9]+$ ]] || return 1
  [[ -r "$STATE_FILE" && -s "$STATE_FILE" ]] || return 1
  state_mutate "$STATE_FILE" \
    '.monitorCommandOffset = $offset | .updated = (now | todate)' \
    --argjson offset "$new_offset" >/dev/null
}

highest_pending_command_offset() {
  local highest=0 offset
  for offset in "${COMMAND_QUEUE_OFFSETS[@]:-}"; do
    [[ "$offset" =~ ^[0-9]+$ ]] || continue
    if (( offset > highest )); then
      highest=$offset
    fi
  done
  printf '%s\n' "$highest"
}

queue_command_event() {
  local offset="$1" event="$2"
  COMMAND_QUEUE+=("$event")
  COMMAND_QUEUE_OFFSETS+=("$offset")
}

requeue_consumed_command_front() {
  if [[ -n "${REPLY:-}" && -n "${REPLY_OFFSET:-}" ]]; then
    COMMAND_QUEUE=("$REPLY" "${COMMAND_QUEUE[@]}")
    COMMAND_QUEUE_OFFSETS=("$REPLY_OFFSET" "${COMMAND_QUEUE_OFFSETS[@]}")
  fi
}

acknowledge_command_offset() {
  local offset="$1" current
  [[ "$offset" =~ ^[0-9]+$ ]] || return 1
  current="$(read_command_offset)"
  [[ "$current" =~ ^[0-9]+$ ]] || current=0
  if (( offset > current )); then
    write_command_offset "$offset" || true
  fi
}

monitor_list_deferred_commands() {
  if [[ ! -r "$STATE_FILE" || ! -s "$STATE_FILE" ]]; then
    printf '[]\n'
    return 0
  fi
  jq -c '.monitorDeferredCommands // []' "$STATE_FILE" 2>/dev/null || printf '[]\n'
}

monitor_remove_deferred_command() {
  local event="$1"
  [[ -n "$event" ]] || return 0
  state_mutate "$STATE_FILE" \
    '.monitorDeferredCommands = ((.monitorDeferredCommands // []) | map(select(.event != $event))) | .updated = (now | todate)' \
    --arg event "$event" >/dev/null || true
}

monitor_defer_command() {
  local event="$1" reason="$2"
  local kind args_json now_ts

  case "$event" in
    select\ *)
      kind="select"
      args_json=$(printf '%s\n' "${event#select }" | tr ' ' '\n' | sed '/^$/d' | jq -Rsc 'split("\n") | map(select(length > 0))')
      ;;
    enter)
      kind="enter"
      args_json='[]'
      ;;
    more)
      kind="more"
      args_json='[]'
      ;;
    re-review\ *)
      kind="re-review"
      args_json=$(printf '%s\n' "${event#re-review }" | jq -Rsc 'split("\n") | map(select(length > 0))')
      ;;
    *)
      kind="unknown"
      args_json='[]'
      ;;
  esac

  now_ts="$(monitor_command_timestamp)"
  state_mutate "$STATE_FILE" '
    .monitorDeferredCommands = (
      (.monitorDeferredCommands // []) as $existing
      | ($existing | map(select(.event == $event)) | .[0]) as $prior
      | ($existing | map(select(.event != $event))) + [{
          event: $event,
          kind: $kind,
          args: $args,
          reason: $reason,
          queued_at: ($prior.queued_at // $now),
          last_checked_at: $now
        }]
    )
    | .updated = (now | todate)
  ' \
    --arg event "$event" \
    --arg kind "$kind" \
    --arg reason "$reason" \
    --arg now "$now_ts" \
    --argjson args "$args_json" >/dev/null || true
}

drain_command_events() {
  local line_count offset highest_pending start new_lines current_offset
  [[ -f "$COMMAND_FILE" ]] || return 0
  line_count=$(read_command_file_line_count)
  offset="$(read_command_offset)"
  [[ "$offset" =~ ^[0-9]+$ ]] || offset=0
  highest_pending="$(highest_pending_command_offset)"
  [[ "$highest_pending" =~ ^[0-9]+$ ]] || highest_pending=0
  if (( highest_pending > offset )); then
    offset=$highest_pending
  fi
  (( line_count <= offset )) && return 0

  start=$((offset + 1))
  new_lines="$(sed -n "${start},${line_count}p" "$COMMAND_FILE" 2>/dev/null || true)"
  current_offset=$start
  while IFS= read -r evt; do
    [[ -z "$evt" ]] && continue
    queue_command_event "$current_offset" "$evt"
    current_offset=$((current_offset + 1))
  done <<< "$new_lines"
}

consume_next_command() {
  if (( ${#COMMAND_QUEUE[@]} == 0 )); then
    return 1
  fi
  if (( ${#COMMAND_QUEUE_OFFSETS[@]} == 0 )); then
    COMMAND_QUEUE=()
    return 1
  fi
  REPLY="${COMMAND_QUEUE[0]}"
  REPLY_OFFSET="${COMMAND_QUEUE_OFFSETS[0]}"
  if (( ${#COMMAND_QUEUE[@]} == 1 )); then
    COMMAND_QUEUE=()
    COMMAND_QUEUE_OFFSETS=()
  else
    COMMAND_QUEUE=("${COMMAND_QUEUE[@]:1}")
    COMMAND_QUEUE_OFFSETS=("${COMMAND_QUEUE_OFFSETS[@]:1}")
  fi
  return 0
}

invalidate_backlog_prompt_state() {
  LAST_BACKLOG_FETCH=0
  LAST_DISPLAY=""
  LAST_WAITING_MSG=""
  SELECT_SHOW_ALL=false
  USING_GROUPED_VIEW=false
  clear_task_list_display
}

launch_selected_task_lines() {
  local selected_lines="$1" free_slots="$2"
  local launched=0 local_line sel_issue sel_slug sel_title
  LAST_COMMAND_LAUNCHED_SLOTS=0

  [[ -n "$selected_lines" ]] || return 0

  if (( $(grep -c . <<<"$selected_lines") > 1 )); then
    if batch_route_selected_tasks "$selected_lines"; then
      log "info" "Prepared batch routing for $(grep -c . <<<"$selected_lines") selected tasks"
    else
      log_warn "Batch routing failed for selected tasks; falling back to per-task routing"
    fi
  fi

  while IFS= read -r local_line; do
    [[ -z "$local_line" ]] && continue
    (( launched >= free_slots )) && break
    IFS='|' read -r sel_issue sel_slug sel_title _rest <<<"$local_line"
    dispatch_task_and_persist "$sel_issue" "$sel_slug" "$sel_title" "$((free_slots - launched))"
    launched=$((launched + LAST_LAUNCHED_SLOTS))
  done <<<"$selected_lines"

  LAST_COMMAND_LAUNCHED_SLOTS=$launched
  if (( launched > 0 )); then
    invalidate_backlog_prompt_state
  fi
}

handle_enter_command() {
  local event="$1" free_slots="$2" queue_plan_json="$3" avail_unblocked="$4" avail_blocked="$5"
  local wave_result wave_ids deferred_ids wave_selected_lines wid wline

  MONITOR_COMMAND_STATUS="noop"
  MONITOR_COMMAND_DEFER_EVENT=""
  MONITOR_COMMAND_DEFER_REASON=""

  if (( free_slots <= 0 )); then
    MONITOR_COMMAND_STATUS="deferred"
    MONITOR_COMMAND_DEFER_EVENT="$event"
    MONITOR_COMMAND_DEFER_REASON="no_slots_available"
    return 0
  fi

  if [[ "${ENTER_LAUNCHES_WAVE:-true}" != "true" ]]; then
    MONITOR_COMMAND_STATUS="invalid"
    return 0
  fi

  if [[ -z "$queue_plan_json" ]]; then
    MONITOR_COMMAND_STATUS="deferred"
    MONITOR_COMMAND_DEFER_EVENT="$event"
    if [[ -n "$avail_blocked" ]]; then
      MONITOR_COMMAND_DEFER_REASON="dependency_blocked"
    else
      MONITOR_COMMAND_DEFER_REASON="no_launchable_candidates"
    fi
    return 0
  fi

  wave_result=$(invoke_first_wave_helper "$queue_plan_json" "$avail_unblocked" "$free_slots" 2>/dev/null) || wave_result=""
  if [[ -z "$wave_result" ]]; then
    MONITOR_COMMAND_STATUS="deferred"
    MONITOR_COMMAND_DEFER_EVENT="$event"
    if [[ -n "$avail_blocked" ]]; then
      MONITOR_COMMAND_DEFER_REASON="dependency_blocked"
    else
      MONITOR_COMMAND_DEFER_REASON="no_launchable_candidates"
    fi
    return 0
  fi

  wave_ids=$(jq -r '.wave[]?' <<<"$wave_result" 2>/dev/null) || wave_ids=""
  deferred_ids=$(jq -r '.deferred[]?' <<<"$wave_result" 2>/dev/null) || deferred_ids=""
  if [[ -z "$wave_ids" ]]; then
    MONITOR_COMMAND_STATUS="deferred"
    MONITOR_COMMAND_DEFER_EVENT="$event"
    if [[ -n "$deferred_ids" || -n "$avail_blocked" ]]; then
      MONITOR_COMMAND_DEFER_REASON="dependency_blocked"
    else
      MONITOR_COMMAND_DEFER_REASON="no_launchable_candidates"
    fi
    return 0
  fi

  wave_selected_lines=""
  while IFS= read -r wid; do
    [[ -z "$wid" ]] && continue
    wline=$(grep -m1 "^${wid}|" <<<"$avail_unblocked" 2>/dev/null || echo "")
    [[ -n "$wline" ]] && wave_selected_lines+="${wline}"$'\n'
  done <<<"$wave_ids"

  if [[ -z "$wave_selected_lines" ]]; then
    MONITOR_COMMAND_STATUS="deferred"
    MONITOR_COMMAND_DEFER_EVENT="$event"
    MONITOR_COMMAND_DEFER_REASON="selection_not_currently_visible"
    return 0
  fi

  [[ -n "$deferred_ids" ]] && log "debug" "[wave-launch] deferred=$(tr '\n' ',' <<<"$deferred_ids" | sed 's/,$//')"
  launch_selected_task_lines "$wave_selected_lines" "$free_slots"
  if (( LAST_COMMAND_LAUNCHED_SLOTS > 0 )); then
    MONITOR_COMMAND_STATUS="launched"
  else
    MONITOR_COMMAND_STATUS="deferred"
    MONITOR_COMMAND_DEFER_EVENT="$event"
    MONITOR_COMMAND_DEFER_REASON="no_launchable_candidates"
  fi
}

handle_select_command() {
  local event="$1" free_slots="$2" select_from="$3"
  local numbers_str selected_lines remaining_numbers unresolved_numbers blocked_numbers
  local n local_line sel_issue sel_slug sel_title _sel_area _sel_score _sel_blocked
  local launch_budget=0 launchable_count=0

  MONITOR_COMMAND_STATUS="noop"
  MONITOR_COMMAND_DEFER_EVENT=""
  MONITOR_COMMAND_DEFER_REASON=""

  numbers_str="${event#select }"
  if [[ -z "$numbers_str" ]]; then
    MONITOR_COMMAND_STATUS="invalid"
    return 0
  fi

  if (( free_slots <= 0 )); then
    MONITOR_COMMAND_STATUS="deferred"
    MONITOR_COMMAND_DEFER_EVENT="$event"
    MONITOR_COMMAND_DEFER_REASON="no_slots_available"
    return 0
  fi

  selected_lines=""
  remaining_numbers=()
  unresolved_numbers=()
  blocked_numbers=()
  launch_budget=$free_slots

  for n in $numbers_str; do
    if ! [[ "$n" =~ ^[0-9]+$ ]] || (( n == 0 )); then
      log_warn "Invalid selection: $n (must be a number)"
      continue
    fi
    local_line=$(sed -n "${n}p" <<<"$select_from")
    if [[ -z "$local_line" ]]; then
      unresolved_numbers+=("$n")
      continue
    fi
    IFS='|' read -r sel_issue sel_slug sel_title _sel_area _sel_score _sel_blocked <<<"$local_line"
    if [[ "${_sel_blocked:-0}" =~ ^[0-9]+$ ]] && (( _sel_blocked > 0 )); then
      blocked_numbers+=("$n")
      continue
    fi
    if (( launchable_count >= launch_budget )); then
      remaining_numbers+=("$n")
      continue
    fi
    selected_lines+="${local_line}"$'\n'
    launchable_count=$((launchable_count + 1))
  done

  if [[ -n "$selected_lines" ]]; then
    launch_selected_task_lines "$selected_lines" "$free_slots"
  fi

  if (( ${#remaining_numbers[@]} > 0 )); then
    MONITOR_COMMAND_STATUS="deferred"
    MONITOR_COMMAND_DEFER_EVENT="select ${remaining_numbers[*]}"
    MONITOR_COMMAND_DEFER_REASON="no_slots_available"
    return 0
  fi

  if (( ${#blocked_numbers[@]} > 0 )); then
    MONITOR_COMMAND_STATUS="deferred"
    MONITOR_COMMAND_DEFER_EVENT="select ${blocked_numbers[*]}"
    MONITOR_COMMAND_DEFER_REASON="dependency_blocked"
    return 0
  fi

  if (( ${#unresolved_numbers[@]} > 0 )); then
    MONITOR_COMMAND_STATUS="deferred"
    MONITOR_COMMAND_DEFER_EVENT="select ${unresolved_numbers[*]}"
    MONITOR_COMMAND_DEFER_REASON="selection_not_currently_visible"
    return 0
  fi

  if (( LAST_COMMAND_LAUNCHED_SLOTS > 0 )); then
    MONITOR_COMMAND_STATUS="launched"
  else
    MONITOR_COMMAND_STATUS="invalid"
  fi
}

handle_advance_command() {
  local event="$1"
  local payload issue slug worktree feature_dir current_phase artifact_path artifact_rel_path
  local task_phase decision_json audit_path audit_timestamp soft_failures_json blocked_json
  local artifact_record artifact_summary artifact_mtime

  MONITOR_COMMAND_STATUS="noop"
  MONITOR_COMMAND_DEFER_EVENT=""
  MONITOR_COMMAND_DEFER_REASON=""

  payload="${event#advance }"
  if [[ "$payload" == "$event" ]]; then
    log_warn "usage: advance <issue-id>"
    MONITOR_COMMAND_STATUS="invalid"
    return 0
  fi

  set -- $payload
  if (( $# != 1 )); then
    log_warn "usage: advance <issue-id>"
    MONITOR_COMMAND_STATUS="invalid"
    return 0
  fi
  issue="$1"

  if [[ ! "$issue" =~ ^[A-Z][A-Z0-9]+-[0-9]+(_c)?$ ]]; then
    log_warn "usage: advance <issue-id>"
    MONITOR_COMMAND_STATUS="invalid"
    return 0
  fi

  slug=$(read_state_value "" --arg issue "$issue" '.tasks[$issue].slug // empty')
  worktree=$(read_state_value "" --arg issue "$issue" '.tasks[$issue].worktree // empty')
  if [[ -z "$slug" || -z "$worktree" ]]; then
    log_warn "$issue is not tracked"
    MONITOR_COMMAND_STATUS="invalid"
    return 0
  fi

  feature_dir="$worktree/features/$slug"
  if [[ ! -d "$feature_dir" ]]; then
    log_warn "$issue is not tracked (missing feature dir: $feature_dir)"
    MONITOR_COMMAND_STATUS="invalid"
    return 0
  fi

  current_phase=$(resolve_phase "$feature_dir")
  task_phase=$(read_state_value "" --arg issue "$issue" '.tasks[$issue].phase // empty')
  if [[ "$current_phase" != "coding" ]]; then
    if [[ -n "$task_phase" && "$task_phase" != "$current_phase" ]]; then
      log_warn "$issue is in phase $current_phase (state: $task_phase); advance only works for coding tasks"
    else
      log_warn "$issue is in phase $current_phase; advance only works for coding tasks"
    fi
    MONITOR_COMMAND_STATUS="invalid"
    return 0
  fi

  artifact_path="$feature_dir/.coding-blocked-completion.json"
  artifact_rel_path="features/$slug/.coding-blocked-completion.json"
  if [[ ! -f "$artifact_path" ]]; then
    log_warn "$issue has no valid blocked-completion artifact at $artifact_rel_path"
    MONITOR_COMMAND_STATUS="invalid"
    return 0
  fi

  decision_json="$(blocked_completion_validate_for_advance "$issue" "$feature_dir" manual 2>/dev/null)" || {
    log_warn "$issue has no valid blocked-completion artifact at $artifact_rel_path"
    MONITOR_COMMAND_STATUS="invalid"
    return 0
  }

  audit_path="$feature_dir/.coding-advance-override.json"
  audit_timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  artifact_record="$(read_blocked_completion "$feature_dir")"
  IFS=$'\001' read -r artifact_summary _reason artifact_mtime <<< "$artifact_record"
  blocked_json="$(jq -c '[.]' "$artifact_path")"
  soft_failures_json="$(jq -c '
    .guardrails
    | to_entries
    | map(select((.key == "commitMatchesHead" or .key == "worktreeClean") and (.value == false)))
    | map(.key)
  ' <<<"$decision_json" 2>/dev/null || echo '[]')"

  if ! jq -n \
    --arg timestamp "$audit_timestamp" \
    --arg issue "$issue" \
    --arg reason "manual advance via mill input" \
    --arg summary "$artifact_summary" \
    --arg path "$artifact_rel_path" \
    --arg resultPath "features/$slug/.coding-result.json" \
    --argjson validation "$decision_json" \
    --argjson softFailures "$soft_failures_json" \
    --argjson blocked "$blocked_json" \
    '{
      timestamp: $timestamp,
      issue: $issue,
      reason: $reason,
      artifact_summary: {
        path: $path,
        summary: $summary,
        stage: (($blocked[0] // {}).stage // ""),
        recommendedAction: (($blocked[0] // {}).recommendedAction // ""),
        implementationComplete: (($blocked[0] // {}).implementationComplete // false),
        committed: (($blocked[0] // {}).committed // false),
        passing_checks_count: (((($blocked[0] // {}).passingChecks) // []) | length),
        blocking_checks_count: (((($blocked[0] // {}).blockingChecks) // []) | length),
        coding_result_path: $resultPath
      },
      guardrails: ($validation.guardrails // {}),
      soft_failures: $softFailures
    }' | complete_coding_advance "$issue" "$feature_dir" "$audit_path" "Blocked verification accepted manually; review may proceed"; then
    MONITOR_COMMAND_STATUS="invalid"
    return 0
  fi

  log "status" "$issue -> advance recorded; review will launch on the next monitor tick"
  MONITOR_COMMAND_STATUS="handled"
}

handle_re_review_command() {
  local event="$1" free_slots="${2:-1}"
  local payload issue slug worktree branch feature_dir current_phase task_phase review_status
  local pr pr_state_value title issue_json audit_path audit_timestamp prior_json audit_tmp
  local current_agent reviewer_agent reviewer_model review_mode base_branch artifacts_json rc=0

  MONITOR_COMMAND_STATUS="noop"
  MONITOR_COMMAND_DEFER_EVENT=""
  MONITOR_COMMAND_DEFER_REASON=""

  payload="${event#re-review }"
  if [[ "$payload" == "$event" ]]; then
    log_warn "usage: re-review <issue-id>"
    MONITOR_COMMAND_STATUS="invalid"
    return 0
  fi

  set -- $payload
  if (( $# != 1 )); then
    log_warn "usage: re-review <issue-id>"
    MONITOR_COMMAND_STATUS="invalid"
    return 0
  fi
  issue="$1"

  if [[ ! "$issue" =~ ^[A-Z][A-Z0-9]+-[0-9]+(_c)?$ ]]; then
    log_warn "usage: re-review <issue-id>"
    MONITOR_COMMAND_STATUS="invalid"
    return 0
  fi

  if (( free_slots <= 0 )); then
    MONITOR_COMMAND_STATUS="deferred"
    MONITOR_COMMAND_DEFER_EVENT="$event"
    MONITOR_COMMAND_DEFER_REASON="no_slots_available"
    return 0
  fi

  slug=$(read_state_value "" --arg issue "$issue" '.tasks[$issue].slug // empty')
  worktree=$(read_state_value "" --arg issue "$issue" '.tasks[$issue].worktree // empty')
  branch=$(read_state_value "" --arg issue "$issue" '.tasks[$issue].branch // empty')
  if [[ -z "$slug" || -z "$worktree" || -z "$branch" ]]; then
    log_warn "$issue is not tracked"
    MONITOR_COMMAND_STATUS="invalid"
    return 0
  fi

  feature_dir="$worktree/features/$slug"
  if [[ ! -d "$feature_dir" ]]; then
    log_warn "$issue is not tracked (missing feature dir: $feature_dir)"
    MONITOR_COMMAND_STATUS="invalid"
    return 0
  fi

  current_phase=$(resolve_phase "$feature_dir")
  task_phase=$(read_state_value "" --arg issue "$issue" '.tasks[$issue].phase // empty')
  if [[ "$current_phase" != "review" && "$current_phase" != "ready" ]]; then
    if [[ -n "$task_phase" && "$task_phase" != "$current_phase" ]]; then
      log_warn "$issue is in phase $current_phase (state: $task_phase); re-review only works for review or ready tasks"
    else
      log_warn "$issue is in phase $current_phase; re-review only works for review or ready tasks"
    fi
    MONITOR_COMMAND_STATUS="invalid"
    return 0
  fi

  review_status=$(read_stage_status "$feature_dir" "review")
  if [[ "$review_status" == "running" ]]; then
    log_warn "$issue review is already running"
    MONITOR_COMMAND_STATUS="invalid"
    return 0
  fi

  pr=$(read_state_value "" --arg issue "$issue" '.tasks[$issue].pr // .tasks[$issue].pullRequest // empty')
  if [[ ! "$pr" =~ ^[0-9]+$ ]]; then
    pr="$(find_pr_for_branch "$branch" 2>/dev/null || true)"
  fi
  if [[ ! "$pr" =~ ^[0-9]+$ ]]; then
    log_warn "$issue has no open PR to re-review"
    MONITOR_COMMAND_STATUS="invalid"
    return 0
  fi
  pr_state_value="$(pr_state "$pr" 2>/dev/null || true)"
  if [[ "$pr_state_value" != "OPEN" ]]; then
    log_warn "$issue PR #$pr is not open; re-review skipped"
    MONITOR_COMMAND_STATUS="invalid"
    return 0
  fi

  title=$(read_state_value "" --arg i "$issue" '.tasks[$i].title // ""')
  if [[ -z "$title" ]]; then
    issue_json=$(cat "/tmp/${SESSION}-${issue}-issue.json" 2>/dev/null || echo "{}")
    title=$(echo "$issue_json" | jq -r '.title // "Task"' 2>/dev/null || echo "Task")
  fi

  audit_path="$feature_dir/.review-rerun-request.json"
  audit_timestamp="$(monitor_command_timestamp)"
  prior_json="null"
  if [[ -f "$feature_dir/.review-result.json" ]]; then
    prior_json="$(jq -c '.' "$feature_dir/.review-result.json" 2>/dev/null || printf 'null')"
  fi
  audit_tmp=$(mktemp) || {
    log_warn "$issue could not record re-review request"
    MONITOR_COMMAND_STATUS="invalid"
    return 0
  }
  if ! jq -n \
    --arg timestamp "$audit_timestamp" \
    --arg issue "$issue" \
    --argjson prNumber "$pr" \
    --arg reason "manual re-review via mill input" \
    --argjson prior "$prior_json" \
    '{timestamp:$timestamp, issue:$issue, prNumber:$prNumber, reason:$reason, previousReviewResult:$prior}' > "$audit_tmp"; then
    rm -f "$audit_tmp"
    log_warn "$issue could not record re-review request"
    MONITOR_COMMAND_STATUS="invalid"
    return 0
  fi
  mv "$audit_tmp" "$audit_path"

  current_agent=$(read_state_value "" --arg i "$issue" '.tasks[$i].agent // ""')
  reviewer_agent="$(read_phase_config "$feature_dir" "review" "agent" 2>/dev/null || true)"
  [[ -n "$reviewer_agent" ]] || reviewer_agent="${current_agent:-$AGENT_CMD}"
  reviewer_model="$(read_phase_config "$feature_dir" "review" "model" 2>/dev/null || true)"
  [[ -n "$reviewer_model" ]] || reviewer_model="$(read_state_value "" --arg i "$issue" '.tasks[$i].reviewerModel // .tasks[$i].model // ""')"
  reviewer_model="$(resolve_phase_model "review" "$reviewer_model" "claude-sonnet-5")"
  review_mode="$(read_phase_config "$feature_dir" "review" "mode" 2>/dev/null || true)"
  [[ -n "$review_mode" ]] || review_mode="static"
  base_branch="$(read_state_value "" --arg i "$issue" '.tasks[$i].baseBranch // empty')"
  [[ -n "$base_branch" ]] || base_branch="${BASE_BRANCH:-main}"

  artifacts_json="$(review_artifacts_with_pr_number "$feature_dir" "$pr" | jq -c --arg timestamp "$audit_timestamp" --arg issue "$issue" \
    '. + {manualRereview:{requestedAt:$timestamp, issue:$issue}}')"
  write_stage_result_with_history "$feature_dir" "review" "running" "$reviewer_agent" "$reviewer_model" \
    "Manual re-review requested for PR #$pr" "$artifacts_json"
  set_task_phase "$issue" "review"
  clear_review_gate_attention "$feature_dir"

  launch_review_phase "$issue" "$slug" "$title" "$worktree" "$branch" "$base_branch" "$reviewer_model" "$reviewer_agent" "$review_mode" || rc=$?
  if [[ "$rc" -eq 0 ]]; then
    log "status" "$issue -> re-review launched for PR #$pr"
    MONITOR_COMMAND_STATUS="handled"
    return 0
  fi
  if [[ "$rc" -eq 2 ]] && check_stage_aborted "$feature_dir"; then
    set_task_phase "$issue" "aborted"
    MONITOR_COMMAND_STATUS="handled"
    return 0
  fi
  write_ready_attention_file "$feature_dir" "Could not launch manual re-review for PR #$pr (rc=$rc)."
  log_warn "$issue re-review launch failed for PR #$pr (rc=$rc)"
  MONITOR_COMMAND_STATUS="invalid"
}

execute_or_defer_monitor_command() {
  local source="$1" event="$2" event_offset="$3" free_slots="$4" queue_plan_json="$5" avail_unblocked="$6" avail_blocked="$7" select_from="$8"

  MONITOR_COMMAND_STATUS="noop"
  MONITOR_COMMAND_DEFER_EVENT=""
  MONITOR_COMMAND_DEFER_REASON=""

  case "$event" in
    more)
      if [[ "$USING_GROUPED_VIEW" != "true" ]]; then
        SELECT_SHOW_ALL=true
      fi
      MONITOR_COMMAND_STATUS="handled"
      ;;
    unknown\ *)
      log_warn "Unknown input: ${event#unknown }"
      MONITOR_COMMAND_STATUS="invalid"
      ;;
    enter)
      handle_enter_command "$event" "$free_slots" "$queue_plan_json" "$avail_unblocked" "$avail_blocked"
      ;;
    advance|advance\ *)
      handle_advance_command "$event"
      ;;
    re-review|re-review\ *)
      handle_re_review_command "$event" "$free_slots"
      ;;
    select\ *)
      handle_select_command "$event" "$free_slots" "$select_from"
      ;;
    *)
      MONITOR_COMMAND_STATUS="invalid"
      ;;
  esac

  if [[ "$MONITOR_COMMAND_STATUS" == "deferred" && -n "$MONITOR_COMMAND_DEFER_EVENT" ]]; then
    monitor_defer_command "$MONITOR_COMMAND_DEFER_EVENT" "$MONITOR_COMMAND_DEFER_REASON"
  fi

  if [[ "$source" == "deferred" ]]; then
    if [[ "$MONITOR_COMMAND_STATUS" != "deferred" || "$MONITOR_COMMAND_DEFER_EVENT" != "$event" ]]; then
      monitor_remove_deferred_command "$event"
    fi
  elif [[ "$MONITOR_COMMAND_STATUS" != "noop" && "$MONITOR_COMMAND_STATUS" != "pending" ]]; then
    acknowledge_command_offset "$event_offset"
  fi
}

process_new_monitor_commands() {
  local free_slots="$1" queue_plan_json="$2" avail_unblocked="$3" avail_blocked="$4" select_from="$5"
  while consume_next_command; do
    if [[ "$REPLY" == "quit" ]]; then
      requeue_consumed_command_front
      break
    fi
    execute_or_defer_monitor_command "new" "$REPLY" "$REPLY_OFFSET" "$free_slots" "$queue_plan_json" "$avail_unblocked" "$avail_blocked" "$select_from"
    if (( LAST_COMMAND_LAUNCHED_SLOTS > 0 )); then
      free_slots=$((free_slots - LAST_COMMAND_LAUNCHED_SLOTS))
      (( free_slots < 0 )) && free_slots=0
    fi
  done
  REMAINING_FREE_SLOTS="$free_slots"
}

process_deferred_monitor_commands() {
  local free_slots="$1" queue_plan_json="$2" avail_unblocked="$3" avail_blocked="$4" select_from="$5"
  local deferred_json event

  deferred_json="$(monitor_list_deferred_commands)"
  while IFS= read -r event; do
    [[ -z "$event" ]] && continue
    execute_or_defer_monitor_command "deferred" "$event" "" "$free_slots" "$queue_plan_json" "$avail_unblocked" "$avail_blocked" "$select_from"
    if (( LAST_COMMAND_LAUNCHED_SLOTS > 0 )); then
      free_slots=$((free_slots - LAST_COMMAND_LAUNCHED_SLOTS))
      (( free_slots < 0 )) && free_slots=0
    fi
  done < <(jq -r '.[].event // empty' <<<"$deferred_json" 2>/dev/null)

  REMAINING_FREE_SLOTS="$free_slots"
}

normalize_prompt_command_reply() {
  local event="$1"
  case "$event" in
    enter) printf '%s\n' "enter" ;;
    select\ *) printf '%s\n' "${event#select }" ;;
    more) printf '%s\n' "m" ;;
    quit) printf '%s\n' "q" ;;
    advance\ *) printf '%s\n' "$event" ;;
    re-review\ *) printf '%s\n' "$event" ;;
    unknown\ *) printf '%s\n' "unknown ${event#unknown }" ;;
    *) printf '%s\n' "" ;;
  esac
}

poll_sleep() {
  local secs="${1:-$POLL_SECONDS}" elapsed
  if ! [[ "$secs" =~ ^[0-9]+$ ]]; then
    sleep "$secs"
    return 0
  fi
  elapsed=0
  while (( elapsed < secs )); do
    drain_command_events
    if (( ${#COMMAND_QUEUE[@]} > 0 )); then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
}

monitor_issue_state() {
  local ISSUE="$1"
  local BRANCH SLUG PR
  local task_status WIN WT_DIR task_branch current_phase eval_agent debug_flag current_agent needs_attention

  : "${queue_owned_count:=0}"
  BRANCH="${BRANCH_BY_ISSUE[$ISSUE]}"
  SLUG="${SLUG_BY_ISSUE[$ISSUE]}"
  PR="${PR_BY_ISSUE[$ISSUE]:-}"
  WIN="$ISSUE-$SLUG"
  WT_DIR=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].worktree // ""')
  [[ -z "$WT_DIR" ]] && WT_DIR="${WORKTREE_ROOT}/${SLUG}"
  local WIN_TARGET
  WIN_TARGET="$(_tmux_task_window_target "$SESSION" "$ISSUE" "$SLUG" "${STATE_FILE:-}" "$WT_DIR" 2>/dev/null || true)"
  if [[ -z "$WIN_TARGET" ]]; then
    WIN_TARGET="$(_tmux_target_join "$SESSION" "$WIN" 2>/dev/null || printf '%s:%s\n' "$SESSION" "$WIN")"
  fi
  local FEATURE_DIR="${WT_DIR}/features/${SLUG}"
  current_agent=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].agent // ""')
  needs_attention="false"

  # Critical invariant: controller-owned tasks must produce a PR before
  # completion cleanup. If an agent exits without one, preserve the worktree
  # and mark the task for attention so committed or uncommitted work is not
  # silently lost.

	  # If already merged or completed-external (requireConfirm), wait for window close then cleanup
	  task_status=$(read_state_value "" --arg issue "$ISSUE" '.tasks[$issue].status // empty')
	  local challenge_aborted pair_id_for_cleanup
	  challenge_aborted=$(read_state_value "" --arg issue "$ISSUE" '.tasks[$issue].challengeAborted // empty')
	  pair_id_for_cleanup=$(read_state_value "" --arg issue "$ISSUE" '.tasks[$issue].challengePairId // empty')
	  if [[ "$task_status" == "aborted" ]]; then
	    cleanup_aborted_challenge_arm "$ISSUE" "$SLUG" "aborted challenge retry" || true
	    return 0
	  fi
	  if [[ -n "$challenge_aborted" && -z "$PR" && -n "$pair_id_for_cleanup" ]] \
	    && challenge_pair_record_exists "$pair_id_for_cleanup"; then
	    cleanup_aborted_challenge_arm "$ISSUE" "$SLUG" "challenge pair resolved" || true
	    return 0
	  fi
	  if [[ "$task_status" == "merged" || "$task_status" == "completed-external" ]]; then
    if [[ "$task_status" == "merged" ]]; then
      local merged_ready_dir merged_before_ready=false
      merged_ready_dir="$(ready_state_dir "$WT_DIR" "$SLUG")"
      if ! ready_stage_allows_merge "$merged_ready_dir"; then
        merged_before_ready=true
        ready_stage_warn_bypass_once "$merged_ready_dir" "$ISSUE" "$PR" || true
        write_ready_attention_file "$merged_ready_dir" "PR #$PR was merged before the Release Readiness Check passed."
      else
        clear_transient_mergeability_state "$merged_ready_dir"
        marker_clear "$merged_ready_dir/.needs-attention"
      fi
    fi

    set_window_attention_state "$WIN" "clear"
    if [[ "$task_status" == "merged" && "$merged_before_ready" == "true" ]]; then
      resolve_pair_on_primary_merge "$ISSUE" "$PR" || true
      cleanup_merged_primary_challenge_task "$ISSUE" "$SLUG" "post-review cleanup" "$PR"
      execute git -C "$REPO_DIR" worktree prune 2>/dev/null || true
      return 0
    fi

    # When quit is requested, force-clean merged tasks instead of waiting for the
    # user to close the review window (which blocks shutdown indefinitely).
    if [[ "${QUIT_REQUESTED:-false}" != "true" ]] \
       && tmux list-panes -t "$WIN_TARGET" -F '#{pane_dead}' 2>/dev/null | grep -q '^0$'; then
      active_count=$((active_count + 1))
      return 0
    fi

    if [[ "$task_status" == "merged" ]]; then
      resolve_pair_on_primary_merge "$ISSUE" "$PR" || true
      cleanup_merged_primary_challenge_task "$ISSUE" "$SLUG" "post-review cleanup" "$PR"
    else
      cleanup_completed_task "$ISSUE" "$SLUG" "post-review cleanup"
    fi

    # Prune worktrees after cleanup
    execute git -C "$REPO_DIR" worktree prune 2>/dev/null || true
    return 0
  fi

  if [[ "$task_status" == "error" ]]; then
    if check_pr_exists "$BRANCH"; then
      local recovered_pr
      recovered_pr=$(find_pr_for_branch "$BRANCH")
      if [[ -n "$recovered_pr" ]]; then
        PR_BY_ISSUE["$ISSUE"]="$recovered_pr"
        log "status" "$ISSUE → Found PR #$recovered_pr for errored task (updating state)"
        save_task_state "$ISSUE" "$SLUG" "$BRANCH" "$WT_DIR" "$recovered_pr" "" "$current_agent"
        set_task_phase "$ISSUE" "review"
      fi
    fi
    set_window_attention_state "$WIN" "needs-user"
    active_count=$((active_count + 1))
    return 0
  fi

  # Recovery runs inside per-issue monitoring so retries share the same task,
  # phase, and cleanup state as the rest of the controller.
  handle_agent_error_recovery "$ISSUE" "${current_agent:-$AGENT_CMD}"

  # Check if PR exists
  if [[ -z "$PR" ]]; then
    PR="$(find_pr_for_branch "$BRANCH")"
    if [[ -n "$PR" ]]; then
      PR_BY_ISSUE["$ISSUE"]="$PR"
      # Preserve agent when updating with PR number
      current_agent=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].agent // ""')
      linear_issue=$(get_linear_issue_id "$ISSUE")
      challenge_flag=$(get_task_meta "$ISSUE" "challenge")
      challenge_pair=$(get_task_meta "$ISSUE" "challengePairId")
      challenge_role=$(get_task_meta "$ISSUE" "challengeRole")
      challenge_model=$(get_task_meta "$ISSUE" "challengeModel")
      save_task_state "$ISSUE" "$SLUG" "$BRANCH" "$WT_DIR" "$PR" "" "$current_agent" "$linear_issue" "$challenge_flag" "$challenge_pair" "$challenge_role" "$challenge_model"
      if should_update_linear_state "$ISSUE"; then
        linear_set_state "$linear_issue" "In Review"
      fi
      # Fetch PR details for user-visible summary
      pr_details=$(_with_timeout "$API_TIMEOUT" gh pr view "$PR" --json title,url --jq '"  " + .title + "\n  " + .url' 2>/dev/null || echo "")
      log "status" "$ISSUE → PR #$PR (In Review)"
      if [[ -n "$pr_details" ]]; then
        log "info" "$pr_details"
      fi

      local depends_on_pr_meta
      depends_on_pr_meta=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].dependsOnPr // empty')
      if [[ -n "$depends_on_pr_meta" ]]; then
        inject_depends_on_pr_block "$ISSUE" "$PR" "$depends_on_pr_meta"
      fi

      local title launch_rc
      title=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].title // ""')
      if [[ -z "$title" ]]; then
        issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
        title=$(echo "$issue_json" | jq -r '.title // "Task"' 2>/dev/null || echo "Task")
      fi

      if record_review_pr_reconciliation "$FEATURE_DIR" "$PR" "$current_agent" ""; then
        dispatch_queued_children_for_parent "$ISSUE" "$PR"
        set_task_phase "$ISSUE" "review"
        set_task_phase "$ISSUE" "ready"
        if [[ "${WAVEMILL_TERMINAL_RECONCILER_LOADED:-0}" == "1" ]]; then
          wavemill_reconcile_terminal "$SESSION" "$ISSUE" "review_complete" "$PR" || true
        fi
      else
        set_task_phase "$ISSUE" "review"
        if launch_review_for_missing_evidence "$ISSUE" "$SLUG" "$title" "${WORKTREE_ROOT}/${SLUG}" "$BRANCH" "$BASE_BRANCH" "$FEATURE_DIR" "$current_agent"; then
          set_window_attention_state "$WIN" "clear"
        else
          launch_rc=$?
          if [[ "$launch_rc" -eq 2 ]] && check_stage_aborted "$FEATURE_DIR"; then
            log_task "status" "$ISSUE" "⛔ $ISSUE → Workflow aborted during review launch"
            set_task_phase "$ISSUE" "aborted"
            set_window_attention_state "$WIN" "needs-user"
            return 0
          fi
          write_ready_attention_file "$FEATURE_DIR" "Could not relaunch review for PR #$PR after missing review verdict evidence (rc=$launch_rc)."
          set_window_attention_state "$WIN" "needs-user"
        fi
        active_count=$((active_count + 1))
        return 0
      fi

      if launch_ready_phase "$ISSUE" "$SLUG" "$title" "${WORKTREE_ROOT}/${SLUG}" "$BRANCH" "$BASE_BRANCH" "$PR"; then
        launch_rc=0
      else
        launch_rc=$?
      fi
      if [[ "$launch_rc" -eq 2 ]] && check_stage_aborted "$FEATURE_DIR"; then
        log_task "status" "$ISSUE" "⛔ $ISSUE → Workflow aborted during ready launch"
        set_task_phase "$ISSUE" "aborted"
        set_window_attention_state "$WIN" "needs-user"
        return 0
      fi
      if [[ "$launch_rc" -eq 3 ]]; then
        set_window_attention_state "$WIN" "clear"
        log "status" "⚠ $ISSUE → Ready detected conflicts, launching remediation"
        active_count=$((active_count + 1))
        return 0
      fi
      if [[ "$launch_rc" -eq 5 ]]; then
        set_window_attention_state "$WIN" "clear"
        log "status" "⚙ $ISSUE → Ready remediation launched (PR #$PR)"
        active_count=$((active_count + 1))
        return 0
      fi
      if [[ "$launch_rc" -eq 4 || "$launch_rc" -eq 6 ]]; then
        set_window_attention_state "$WIN" "clear"
        active_count=$((active_count + 1))
        return 0
      fi
      if [[ "$launch_rc" -ne 0 ]]; then
        log "status" "⚠ $ISSUE → Ready checks failed (PR #$PR)"
        set_window_attention_state "$WIN" "needs-user"
        return 0
      fi
      set_window_attention_state "$WIN" "needs-user"
      log "status" "$ISSUE → Ready checks completed for PR #$PR"
      if [[ "${WAVEMILL_TERMINAL_RECONCILER_LOADED:-0}" == "1" ]]; then
        wavemill_reconcile_terminal "$SESSION" "$ISSUE" "ready_complete" "$PR" || true
      fi
      return 0
    else
	      # No PR in current repo - check Linear issue state for cross-repo completion
	      if should_update_linear_state "$ISSUE" && linear_is_completed "$(get_linear_issue_id "$ISSUE")"; then
	        if [[ -n "$challenge_aborted" && -z "$PR" ]]; then
	          log "debug" "$ISSUE: skipping completed-external reconciliation for challenge-aborted no-PR arm"
	          active_count=$((active_count + 1))
	          return 0
	        fi
	        log "status" "$ISSUE → Completed externally (cross-repo or manual)"
	        set_window_attention_state "$WIN" "clear"

        # Post-completion eval (non-blocking: always exits 0)
        if [[ "$AUTO_EVAL" == "true" ]]; then
          eval_completed=$(read_state_value "false" --arg i "$ISSUE" '.tasks[$i].evalCompleted // false')
          if [[ "$eval_completed" == "false" ]]; then
            log_task "info" "$ISSUE" "📊 Running post-completion eval..."
            launch_background_post_merge_eval "$ISSUE" "" "$BRANCH" "$SLUG" "$ISSUE" "post-completion"
          else
            log "debug" "Eval already completed for $ISSUE"
          fi
        fi

        if [[ "$REQUIRE_CONFIRM" == "true" ]]; then
          log "status" "  → Window stays open for review - close it when ready$(wavemill_config_annotation "mill.requireConfirm" "$REQUIRE_CONFIRM")"
          if should_update_linear_state "$ISSUE"; then
            linear_set_state "$(get_linear_issue_id "$ISSUE")" "Done"
          fi
          # Preserve agent when marking as completed-external
          current_agent=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].agent // ""')
          save_task_state "$ISSUE" "$SLUG" "$BRANCH" "$WT_DIR" "" "completed-external" "$current_agent"
          active_count=$((active_count + 1))
          return 0
        fi

        # Clean up worktree and state
        if should_update_linear_state "$ISSUE"; then
          linear_set_state "$(get_linear_issue_id "$ISSUE")" "Done"
        fi
        cleanup_completed_task "$ISSUE" "$SLUG" "external completion"
        return 0
      fi

      # Multi-phase workflow tracking (must run before pane-alive early return)
      current_phase=$(get_task_phase "$ISSUE")

      # Resolve current phase from controller-owned stage state
      local resolved_phase
      resolved_phase=$(resolve_phase "$FEATURE_DIR")

      case "$current_phase" in
        routing)
          if check_stage_aborted "$FEATURE_DIR"; then
            log_task "status" "$ISSUE" "⛔ $ISSUE → Workflow aborted by user during routing phase"
            set_task_phase "$ISSUE" "aborted"
            set_window_attention_state "$WIN" "needs-user"
            return 0
          fi

          if check_routing_complete "$SLUG"; then
            # Read routing results
            routing_file="${WORKTREE_ROOT}/${SLUG}/features/${SLUG}/.routing-complete"
            if [[ -f "$routing_file" ]]; then
              # FORCE_MODEL overrides routing file for all stage models
              if [[ -n "${FORCE_MODEL:-}" ]]; then
                planner_model="$FORCE_MODEL"
                coder_model="$FORCE_MODEL"
                reviewer_model="$FORCE_MODEL"
                # Still read depth/mode from routing file if available
                if jq empty "$routing_file" 2>/dev/null; then
                  plan_depth=$(jq -r '.planDepth // "light"' "$routing_file" 2>/dev/null || echo "light")
                  code_depth=$(jq -r '.codeDepth // "medium"' "$routing_file" 2>/dev/null || echo "medium")
                  review_mode=$(jq -r '.reviewMode // "static"' "$routing_file" 2>/dev/null || echo "static")
                else
                  plan_depth="light"
                  code_depth="medium"
                  review_mode="static"
                fi
              elif ! jq empty "$routing_file" 2>/dev/null; then
                log_warn "$ISSUE → Routing file contains invalid JSON, using defaults"
                planner_model="claude-sonnet-5"
                coder_model="claude-opus-4-7"
                reviewer_model="claude-sonnet-5"
                plan_depth="light"
                code_depth="medium"
                review_mode="static"
              else
                planner_model=$(jq -r '.planner // "claude-sonnet-5"' "$routing_file" 2>/dev/null || echo "claude-sonnet-5")
                coder_model=$(jq -r '.coder // "claude-opus-4-7"' "$routing_file" 2>/dev/null || echo "claude-opus-4-7")
                reviewer_model=$(jq -r '.reviewer // "claude-sonnet-5"' "$routing_file" 2>/dev/null || echo "claude-sonnet-5")
                plan_depth=$(jq -r '.planDepth // "light"' "$routing_file" 2>/dev/null || echo "light")
                code_depth=$(jq -r '.codeDepth // "medium"' "$routing_file" 2>/dev/null || echo "medium")
                review_mode=$(jq -r '.reviewMode // "static"' "$routing_file" 2>/dev/null || echo "static")
              fi

              # Restore the arm this pair was selected to vary before it is
              # written to state and phase config.  The routing file is the
              # artifact rerouting overwrites, so it cannot be the only source.
              local challenge_varied_plan challenge_varied_review_stage
              challenge_varied_plan="$(challenge_varied_stage_model "$ISSUE" "plan" 2>/dev/null || true)"
              if [[ -n "$challenge_varied_plan" && "$challenge_varied_plan" != "$planner_model" ]]; then
                log_warn "  $ISSUE: plan-stage challenge arm restored from state ($planner_model → $challenge_varied_plan)"
                planner_model="$challenge_varied_plan"
              fi
              challenge_varied_review_stage="$(challenge_varied_stage_model "$ISSUE" "review" 2>/dev/null || true)"
              if [[ -n "$challenge_varied_review_stage" && "$challenge_varied_review_stage" != "$reviewer_model" ]]; then
                log_warn "  $ISSUE: review-stage challenge arm restored from state ($reviewer_model → $challenge_varied_review_stage)"
                reviewer_model="$challenge_varied_review_stage"
              fi

              if ! challenge_guard_varied_model_resolvable "$ISSUE" "$FEATURE_DIR" "$WIN" "plan" "$planner_model"; then
                set_task_phase "$ISSUE" "routing"
                active_count=$((active_count + 1))
                return 0
              fi
              planner_model="$(resolve_phase_model "planning" "$planner_model" "claude-sonnet-5")"
              coder_model="$(resolve_phase_model "coding" "$coder_model" "claude-opus-4-7")"
              reviewer_model="$(resolve_phase_model "review" "$reviewer_model" "claude-sonnet-5")"

              if [[ -z "${FORCE_MODEL:-}" ]]; then
                [[ -n "${WAVEMILL_PLANNER_MODEL:-}" ]] && planner_model="$WAVEMILL_PLANNER_MODEL"
                [[ -n "${WAVEMILL_CODER_MODEL:-}" ]] && coder_model="$WAVEMILL_CODER_MODEL"
                [[ -n "${WAVEMILL_REVIEWER_MODEL:-}" ]] && reviewer_model="$WAVEMILL_REVIEWER_MODEL"
              fi

              # Save routing results to state
              current_agent=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].agent // ""')
              linear_issue=$(get_linear_issue_id "$ISSUE")
              save_task_state "$ISSUE" "$SLUG" "$BRANCH" "$WT_DIR" "" "" "$current_agent" "$linear_issue" "" "" "" "" "$planner_model" "$coder_model" "$reviewer_model" "$plan_depth" "$code_depth" "$review_mode"

              # Write canonical phase config (HOK-1177)
              write_phase_config "$FEATURE_DIR" "$planner_model" "$coder_model" "$reviewer_model" "$plan_depth" "$code_depth" "$review_mode" "${FORCE_MODEL:-}"

              # Bounded relaunch admission (HOK-2924): hold during backoff,
              # terminalize once the phase-launch budget is spent.
              if ! phase_launch_gate "$ISSUE" "$FEATURE_DIR" "planning" "$WIN"; then
                active_count=$((active_count + 1))
                return 0
              fi

              # Transition to planning phase
              set_task_phase "$ISSUE" "planning"
              planner_launch_model="$planner_model"
              if declare -F agent_resolve_model >/dev/null 2>&1; then
                planner_launch_model="$(agent_resolve_model "planner" "$planner_model" "$REPO_DIR")" || return 1
              fi
              if ! planner_agent="$(agent_resolve_from_model "$planner_launch_model" "planning")"; then
                write_stage_result "$FEATURE_DIR" "planning" "failed" "" "$planner_launch_model" "${AGENT_RESOLVE_LAST_DIAGNOSTIC:-Planning launch blocked by agent resolution failure.}"
                set_task_phase "$ISSUE" "routing"
                set_window_attention_state "$WIN" "needs-user"
                log "warn" "⚠ $ISSUE → Planning launch blocked: ${AGENT_RESOLVE_LAST_DIAGNOSTIC:-agent resolution failed}"
                active_count=$((active_count + 1))
                return 0
              fi

              # Get title from state or Linear
              title=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].title // ""')
              if [[ -z "$title" ]]; then
                issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
                title=$(echo "$issue_json" | jq -r '.title // "Task"' 2>/dev/null || echo "Task")
              fi

              # Record planning stage as running (HOK-1177)
              record_planning_launch_route_snapshot "$FEATURE_DIR" "$planner_launch_model" "$planner_agent" "$plan_depth" "effective-route"
              write_stage_result_with_history "$FEATURE_DIR" "planning" "running" "$planner_agent" "$planner_launch_model"

              _run_phase_launch planning launch_planning_phase "$ISSUE" "$SLUG" "$title" "${WORKTREE_ROOT}/${SLUG}" "$BRANCH" "$BASE_BRANCH" "$planner_launch_model" "$planner_agent" "$plan_depth"
              local launch_rc=$?
              if ! handle_phase_launch_result "$ISSUE" "$FEATURE_DIR" "planning" "routing" "$launch_rc" "$WIN" "$planner_agent" "$planner_launch_model"; then
                return 0
              fi
              set_window_attention_state "$WIN" "clear"
              log "status" "$ISSUE → Routing complete, launching planning phase"
              active_count=$((active_count + 1))
              return 0
            else
              log_warn "$ISSUE → Routing file missing: $routing_file"
              needs_attention="true"
            fi
          else
            if ! check_routing_complete "$SLUG"; then
              set_window_attention_state "$WIN" "clear"
              # Keep routing tasks active while the controller-owned routing state is incomplete
              active_count=$((active_count + 1))
              return 0
            fi
            needs_attention="true"
          fi
          ;;

        planning)
          local approval_wait_var="_approval_wait_logged_${ISSUE//[^a-zA-Z0-9]/_}"

          if [[ "$resolved_phase" == "aborted" ]]; then
            unset "$approval_wait_var" 2>/dev/null || true
            log_task "status" "$ISSUE" "⛔ $ISSUE → Workflow aborted by user during planning phase"
            write_stage_result "$FEATURE_DIR" "planning" "aborted" "$current_agent"
            set_task_phase "$ISSUE" "aborted"
            set_window_attention_state "$WIN" "needs-user"
            return 0
          fi

          # Resume recovery: if the tmux window was lost (session was quit and
          # restarted via `r`/`a`), relaunch the planning agent so the task is
          # interactable again. On success we treat the task as freshly active
          # and skip the rest of this cycle's processing — the next poll will
          # pick up whatever state the agent produces. This must run before any
          # of the sub-state handlers below, which all assume the pane exists.
          _restore_inflight_task_window_if_missing "$ISSUE" "$SLUG" "$BRANCH" "planning"
          if [[ "$_RESTORE_STATE" == "restored" ]]; then
            set_window_attention_state "$WIN" "clear"
            active_count=$((active_count + 1))
            return 0
          elif [[ "$_RESTORE_STATE" == "failed" ]]; then
            set_window_attention_state "$WIN" "needs-user"
            active_count=$((active_count + 1))
            return 0
          fi

          # Late migration detection: agent writes .migration-detected after expanding
          local mig_marker="${WORKTREE_ROOT}/${SLUG}/features/${SLUG}/.migration-detected"
          local mig_num_file="${WORKTREE_ROOT}/${SLUG}/features/${SLUG}/.migration-number"
          if [[ -f "$mig_marker" ]] && [[ ! -f "$mig_num_file" ]]; then
            # Check if reservation already exists
            local existing_reservation
            existing_reservation=$(read_state_value "" --arg i "$ISSUE" '.migrationReservations[$i] // empty')
            if [[ -z "$existing_reservation" ]]; then
              local next_num
              next_num=$(read_state_value "" '.nextMigrationNum // empty')
              if [[ -z "$next_num" ]]; then
                local highest
                highest=$(git -C "$REPO_DIR" ls-tree --name-only "origin/$BASE_BRANCH" alembic/versions/ 2>/dev/null \
                  | grep -oE '^[0-9]+' | sort -n | tail -1)
                next_num=$(( ${highest:-0} + 1 ))
              fi
              echo "$next_num" > "$mig_num_file"
              save_migration_reservation "$ISSUE" "$next_num"
              log "debug" "  → Late migration detected for $ISSUE, assigned number: $next_num"
            else
              echo "$existing_reservation" > "$mig_num_file"
            fi
          fi

          if [[ "$resolved_phase" == "coding" ]]; then
            unset "$approval_wait_var" 2>/dev/null || true
            # Before launching coding, validate planning did not overreach.
            if ! validate_planning_phase_output "$WT_DIR"; then
              handle_planning_overreach_rejection "$ISSUE" "$FEATURE_DIR" "$WIN" "$current_agent"
              active_count=$((active_count + 1))
              return 0
            fi
            # A superseded rejection artifact would keep rendering "agent NOT
            # notified" on the dashboard even after the plan was re-approved
            # (HOK-2765). Drop it now that we're transitioning to coding.
            rm -f "$FEATURE_DIR/.planning-rejected.json" 2>/dev/null || true
            # Record approval via approve_plan (HOK-1193: controller-owned stage result)
            approve_plan "$FEATURE_DIR" "$current_agent" ""

            if ! reroute_expanded_packets_for_coding_handoff "$ISSUE" "$SLUG" "$FEATURE_DIR"; then
              handle_expanded_reroute_handoff_failure "$ISSUE" "$FEATURE_DIR"
            fi
            if ! apply_expanded_route_if_present "$FEATURE_DIR" "$ISSUE" "$SLUG" "$WT_DIR" "$STATE_FILE"; then
              log_warn "$ISSUE → expanded route invalid; using bootstrap execution route for coding"
            fi
            emit_execution_active_route "$FEATURE_DIR" "$ISSUE"

            local handshake_reason handshake_policy handshake_block_note
            handshake_reason="$(mill_expansion_handshake_reason "$FEATURE_DIR")"
            handshake_policy="$(get_expansion_handshake_policy "$REPO_DIR")"

            if [[ "$handshake_reason" == "missing" && "$handshake_policy" == "recover" ]]; then
              if recover_missing_expansion_artifact "$ISSUE" "$SLUG" "$FEATURE_DIR"; then
                if ! apply_expanded_route_if_present "$FEATURE_DIR" "$ISSUE" "$SLUG" "$WT_DIR" "$STATE_FILE"; then
                  expansion_recovery_mark_result "$FEATURE_DIR" "$ISSUE" "failed" "expanded-route-promotion-failed" "1" || true
                  log_warn "$ISSUE → recovered expanded route was invalid during promotion; using bootstrap execution route for coding"
                  handshake_reason="recovery-fallback-bootstrap"
                else
                  handshake_reason="$(mill_expansion_handshake_reason "$FEATURE_DIR")"
                fi
                emit_execution_active_route "$FEATURE_DIR" "$ISSUE"
              else
                log_warn "$ISSUE → expansion recovery failed; RECOVERY_FALLBACK_BOOTSTRAP"
                emit_execution_active_route "$FEATURE_DIR" "$ISSUE"
                handshake_reason="recovery-fallback-bootstrap"
              fi
            fi

            if [[ "$handshake_reason" != "recovery-fallback-bootstrap" ]] && ! mill_check_expansion_handshake "$FEATURE_DIR" "$ISSUE" "$REPO_DIR"; then
              rm -f "$FEATURE_DIR/.plan-approved"
              if [[ "$handshake_reason" == "missing" ]]; then
                handshake_block_note="Expansion handshake blocked: raw input requires wavemill expand $ISSUE"
              else
                handshake_block_note="Expansion handshake blocked: invalid expanded routing artifact ($handshake_reason)"
              fi
              write_stage_result "$FEATURE_DIR" "planning" "awaiting_user" "$current_agent" "" "$handshake_block_note"
              set_window_attention_state "$WIN" "needs-user"
              active_count=$((active_count + 1))
              return 0
            fi

            # FORCE_MODEL takes priority, then challenge, then state, then default
            if [[ -n "${FORCE_MODEL:-}" ]]; then
              coder_model="$FORCE_MODEL"
            else
              coder_model=$(read_phase_config "$FEATURE_DIR" "coding" "model")
              [[ -z "$coder_model" ]] && coder_model=$(get_task_meta "$ISSUE" "coderModel")
              challenge_coder=$(get_task_meta "$ISSUE" "challengeModel")
              challenge_stage_meta=$(get_task_meta "$ISSUE" "challengeStage")
              challenge_role_meta=$(get_task_meta "$ISSUE" "challengeRole")
              FINALIZED_CHALLENGE_CODER=""
              FINALIZED_CHALLENGE_STAGE=""
              finalize_challenge_execution_intent_before_coding "$ISSUE" "$SLUG" "$BRANCH" "$WT_DIR" "$FEATURE_DIR" "$coder_model" "$challenge_role_meta" "$challenge_stage_meta"
              if [[ -n "$FINALIZED_CHALLENGE_CODER" ]]; then
                challenge_coder="$FINALIZED_CHALLENGE_CODER"
                challenge_stage_meta="$FINALIZED_CHALLENGE_STAGE"
              fi
              # For challenge tasks, the challengeModel only names the coder when the
              # challenge varied the implementation stage. Plan-stage and review-stage
              # challenges leave the coder route untouched (see HOK-2272).
              if [[ -n "$challenge_coder" ]]; then
                case "$challenge_stage_meta" in
                  implementation)
                    coder_model="$challenge_coder"
                    ;;
                  plan|review)
                    log "debug" "  $ISSUE: challenge stage=$challenge_stage_meta — honoring phase-config coder ($coder_model) over challengeModel ($challenge_coder)"
                    ;;
                  "")
                    log_warn "  $ISSUE: challenge has no challengeStage signal — fail-safe to phase-config coder ($coder_model); challengeModel ($challenge_coder) ignored"
                    ;;
                  *)
                    log_warn "  $ISSUE: unrecognized challengeStage=$challenge_stage_meta — fail-safe to phase-config coder ($coder_model); challengeModel ($challenge_coder) ignored"
                    ;;
                esac
              fi
            fi
            if ! challenge_guard_varied_model_resolvable "$ISSUE" "$FEATURE_DIR" "$WIN" "coding" "$coder_model"; then
              set_task_phase "$ISSUE" "planning"
              active_count=$((active_count + 1))
              return 0
            fi
            coder_model="$(resolve_phase_model "coding" "$coder_model" "claude-opus-4-7")"
            [[ -n "${WAVEMILL_CODER_MODEL:-}" && -z "${FORCE_MODEL:-}" ]] && coder_model="$WAVEMILL_CODER_MODEL"
            code_depth=$(read_phase_config "$FEATURE_DIR" "coding" "depth")
            [[ -z "$code_depth" ]] && code_depth=$(get_task_meta "$ISSUE" "codeDepth")
            [[ -z "$code_depth" ]] && code_depth="medium"

            # Bounded relaunch admission (HOK-2924): hold during backoff,
            # terminalize once the phase-launch budget is spent.
            if ! phase_launch_gate "$ISSUE" "$FEATURE_DIR" "coding" "$WIN"; then
              active_count=$((active_count + 1))
              return 0
            fi

            # Transition to coding phase
            set_task_phase "$ISSUE" "coding"
            coder_launch_model="$coder_model"
            if declare -F agent_resolve_model >/dev/null 2>&1; then
              coder_launch_model="$(agent_resolve_model "coder" "$coder_model" "$REPO_DIR")" || return 1
            fi
            if ! coder_agent="$(agent_resolve_from_model "$coder_launch_model" "coding")"; then
              write_stage_result "$FEATURE_DIR" "coding" "failed" "" "$coder_launch_model" "${AGENT_RESOLVE_LAST_DIAGNOSTIC:-Coding launch blocked by agent resolution failure.}"
              set_task_phase "$ISSUE" "planning"
              set_window_attention_state "$WIN" "needs-user"
              log "warn" "⚠ $ISSUE → Coding launch blocked: ${AGENT_RESOLVE_LAST_DIAGNOSTIC:-agent resolution failed}"
              active_count=$((active_count + 1))
              return 0
            fi
            if [[ -f "${STATE_FILE:-}" ]] && jq -e --arg issue "$ISSUE" '.tasks[$issue]? // empty' "$STATE_FILE" >/dev/null 2>&1; then
              if ! state_mutate "$STATE_FILE" \
                '.tasks[$issue].agent = $agent | .tasks[$issue].updated = (now | todate)' \
                --arg issue "$ISSUE" \
                --arg agent "$coder_agent" >/dev/null 2>&1; then
                log_warn "set_task_agent: failed to update $ISSUE for coding"
              fi
            fi

            # Get title
            title=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].title // ""')
            if [[ -z "$title" ]]; then
              issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
              title=$(echo "$issue_json" | jq -r '.title // "Task"' 2>/dev/null || echo "Task")
            fi

            archive_stale_coding_artifacts "$ISSUE" "$FEATURE_DIR"

            # Record coding stage as running (HOK-1177)
            local coding_started_at
            coding_started_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
            write_stage_result_with_history "$FEATURE_DIR" "coding" "running" "$coder_agent" "$coder_launch_model" "" "" "$coding_started_at"

            _run_phase_launch coding launch_coding_phase "$ISSUE" "$SLUG" "$title" "$WT_DIR" "$BRANCH" "$BASE_BRANCH" "$coder_launch_model" "$coder_agent" "$code_depth"
            local launch_rc=$?
            if ! handle_phase_launch_result "$ISSUE" "$FEATURE_DIR" "coding" "planning" "$launch_rc" "$WIN" "$coder_agent" "$coder_launch_model"; then
                return 0
            fi
            set_window_attention_state "$WIN" "clear"
            log "status" "$ISSUE → Plan approved, launching coding phase"
            active_count=$((active_count + 1))
            return 0
          fi

          # HOK-1194: Detect planning stage transitions
          local planning_status
          planning_status=$(read_stage_status "$FEATURE_DIR" "planning")

          # Transition 1: awaiting_user + .plan-approved → completed.
          # Approval markers created before the run reaches awaiting_user are
          # stale/in-run markers and must not bypass the operator gate.
          if [[ "$planning_status" == "running" ]]; then
            recover_misplaced_plan_md "$ISSUE" "$WT_DIR" "$FEATURE_DIR" "$SLUG" || true
            if [[ -f "$FEATURE_DIR/plan.md" ]]; then
              unset "$approval_wait_var" 2>/dev/null || true
              log "status" "$ISSUE → plan.md detected, marking planning as awaiting_user"
              write_stage_result "$FEATURE_DIR" "planning" "awaiting_user" "$current_agent" "" "Plan ready for review"
              set_window_attention_state "$WIN" "needs-user"
              active_count=$((active_count + 1))
              return 0
            fi
            if [[ -f "$FEATURE_DIR/.plan-approved" ]]; then
              surface_premature_plan_approval "$ISSUE" "$FEATURE_DIR" "$WIN" "$current_agent" || true
              active_count=$((active_count + 1))
              return 0
            fi
          fi

          if [[ "$planning_status" == "awaiting_user" ]]; then
            if [[ -f "$FEATURE_DIR/.plan-approved" ]]; then
              unset "$approval_wait_var" 2>/dev/null || true
              if ! validate_planning_phase_output "$WT_DIR"; then
                handle_planning_overreach_rejection "$ISSUE" "$FEATURE_DIR" "$WIN" "$current_agent"
                active_count=$((active_count + 1))
                return 0
              fi
              log "status" "$ISSUE → Plan approved (via .plan-approved marker), marking as completed"
              approve_plan "$FEATURE_DIR" "$current_agent" ""
              # A planning agent that announced completion but kept running would
              # swallow the next launch's send-keys (HOK-2921 / REQ-F4).
              reap_completed_planning_pane "$ISSUE" "$FEATURE_DIR" "${WORKTREE_ROOT}/${SLUG}" || true
              # Next iteration will detect resolved_phase == "coding" and launch coding
              active_count=$((active_count + 1))
              return 0
            fi
          fi

          if emit_native_terminal_failure_attention "$ISSUE" "$FEATURE_DIR" "planning" "$WIN" "$WIN_TARGET" "$current_agent" "$(resolve_stage_result_model "$FEATURE_DIR" "planning" "")"; then
            return 0
          fi
          if emit_native_launch_failure_attention "$ISSUE" "$FEATURE_DIR" "planning" "$WIN" "$WIN_TARGET" "$current_agent" "$(resolve_stage_result_model "$FEATURE_DIR" "planning" "")"; then
            return 0
          fi

          # Check if plan exists but not yet approved (awaiting_user)
          if [[ "$resolved_phase" == "awaiting_user" ]]; then
            # Check if user signaled approval by creating .plan-approved marker
            if [[ -f "$FEATURE_DIR/.plan-approved" ]]; then
              unset "$approval_wait_var" 2>/dev/null || true
              if ! validate_planning_phase_output "$WT_DIR"; then
                handle_planning_overreach_rejection "$ISSUE" "$FEATURE_DIR" "$WIN" "$current_agent"
                active_count=$((active_count + 1))
                return 0
              fi
              log "status" "$ISSUE → User approved plan (via .plan-approved marker)"
              approve_plan "$FEATURE_DIR" "$current_agent" ""
              # A planning agent that announced completion but kept running would
              # swallow the next launch's send-keys (HOK-2921 / REQ-F4).
              reap_completed_planning_pane "$ISSUE" "$FEATURE_DIR" "${WORKTREE_ROOT}/${SLUG}" || true
              # Now completed — next poll iteration will pick up and launch coding
              active_count=$((active_count + 1))
              return 0
            fi

            # HOK-1210: Do NOT auto-approve just because the pane is idle.
            # The agent must create .plan-approved after explicit user approval.
            # If the pane is idle or dead without the marker, log once and wait for user.
            if [[ -f "$FEATURE_DIR/plan.md" ]] && _pane_is_dead_or_idle "$WIN_TARGET"; then
              if [[ "${!approval_wait_var:-}" != "true" ]]; then
                log "status" "⏳ $ISSUE → Plan ready — awaiting user approval (touch .plan-approved to continue)"
                printf -v "$approval_wait_var" '%s' "true"
              fi
            fi

            set_window_attention_state "$WIN" "needs-user"
            active_count=$((active_count + 1))
            return 0
          fi

          # Stage still running — keep task active
          if [[ "$planning_status" == "running" ]]; then
            set_window_attention_state "$WIN" "clear"
            active_count=$((active_count + 1))
            return 0
          fi

          if [[ "$planning_status" == "failed" ]]; then
            local planning_transient_rc=0
            maybe_retry_challenger_transient_phase "$ISSUE" "$FEATURE_DIR" "planning" "$WIN" || planning_transient_rc=$?
            if [[ "$planning_transient_rc" -eq 0 || "$planning_transient_rc" -eq 2 ]]; then
              active_count=$((active_count + 1))
              return 0
            fi
            emit_challenge_stage_failure_quarantine "$ISSUE" "$FEATURE_DIR" "planning" "$WIN" || true
            set_window_attention_state "$WIN" "needs-user"
            active_count=$((active_count + 1))
            return 0
          fi

          # No controller-observed transition artifact — needs attention
          needs_attention="true"
          ;;

        coding)
          if [[ "$resolved_phase" == "aborted" ]]; then
            log_task "status" "$ISSUE" "⛔ $ISSUE → Workflow aborted by user during coding phase"
            write_stage_result "$FEATURE_DIR" "coding" "aborted" "$current_agent" "$(resolve_stage_result_model "$FEATURE_DIR" "coding" "claude-opus-4-7")"
            set_task_phase "$ISSUE" "aborted"
            set_window_attention_state "$WIN" "needs-user"
            return 0
          fi

          # Resume recovery: see matching block in the planning case above.
          _restore_inflight_task_window_if_missing "$ISSUE" "$SLUG" "$BRANCH" "coding"
          if [[ "$_RESTORE_STATE" == "restored" ]]; then
            set_window_attention_state "$WIN" "clear"
            active_count=$((active_count + 1))
            return 0
          elif [[ "$_RESTORE_STATE" == "failed" ]]; then
            set_window_attention_state "$WIN" "needs-user"
            active_count=$((active_count + 1))
            return 0
          fi

          if [[ "$resolved_phase" == "review" ]]; then
            if guard_coding_complete_handoff "$ISSUE" "$FEATURE_DIR" "${WORKTREE_ROOT}/${SLUG}" "$BASE_BRANCH"; then
              return 0
            fi
            validate_coding_phase_output "$BRANCH"
            clear_coding_uncommitted_output_attention "$FEATURE_DIR"
            # Mark coding as completed (HOK-1177)
            write_stage_result "$FEATURE_DIR" "coding" "completed" "$current_agent" "$(resolve_stage_result_model "$FEATURE_DIR" "coding" "claude-opus-4-7")"
            quarantine_completed_coding_pane "$ISSUE" "$FEATURE_DIR" "${WORKTREE_ROOT}/${SLUG}"

            # FORCE_MODEL takes priority, then phase config, then state, then default
            if [[ -n "${FORCE_MODEL:-}" ]]; then
              reviewer_model="$FORCE_MODEL"
            else
              reviewer_model=$(read_phase_config "$FEATURE_DIR" "review" "model")
              [[ -z "$reviewer_model" ]] && reviewer_model=$(get_task_meta "$ISSUE" "reviewerModel")
            fi
            if ! challenge_guard_varied_model_resolvable "$ISSUE" "$FEATURE_DIR" "$WIN" "review" "$reviewer_model"; then
              active_count=$((active_count + 1))
              return 0
            fi
            reviewer_model="$(resolve_phase_model "review" "$reviewer_model" "claude-sonnet-5")"
            [[ -n "${WAVEMILL_REVIEWER_MODEL:-}" && -z "${FORCE_MODEL:-}" ]] && reviewer_model="$WAVEMILL_REVIEWER_MODEL"
            review_mode=$(read_phase_config "$FEATURE_DIR" "review" "mode")
            [[ -z "$review_mode" ]] && review_mode=$(get_task_meta "$ISSUE" "reviewMode")
            [[ -z "$review_mode" ]] && review_mode="static"

            # Bounded relaunch admission (HOK-2924): hold during backoff,
            # terminalize once the phase-launch budget is spent.
            if ! phase_launch_gate "$ISSUE" "$FEATURE_DIR" "review" "$WIN"; then
              active_count=$((active_count + 1))
              return 0
            fi

            # Transition to review phase
            set_task_phase "$ISSUE" "review"
            reviewer_launch_model="$reviewer_model"
            if declare -F agent_resolve_model >/dev/null 2>&1; then
              reviewer_launch_model="$(agent_resolve_model "reviewer" "$reviewer_model" "$REPO_DIR")" || return 1
            fi
            if ! reviewer_agent="$(agent_resolve_from_model "$reviewer_launch_model" "review")"; then
              write_stage_result "$FEATURE_DIR" "review" "failed" "" "$reviewer_launch_model" "${AGENT_RESOLVE_LAST_DIAGNOSTIC:-Review launch blocked by agent resolution failure.}"
              set_task_phase "$ISSUE" "coding"
              set_window_attention_state "$WIN" "needs-user"
              log "warn" "⚠ $ISSUE → Review launch blocked: ${AGENT_RESOLVE_LAST_DIAGNOSTIC:-agent resolution failed}"
              active_count=$((active_count + 1))
              return 0
            fi

            # Get title
            title=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].title // ""')
            if [[ -z "$title" ]]; then
              issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
              title=$(echo "$issue_json" | jq -r '.title // "Task"' 2>/dev/null || echo "Task")
            fi

            # Record review stage as running (HOK-1177)
            write_stage_result_with_history "$FEATURE_DIR" "review" "running" "$reviewer_agent" "$reviewer_launch_model"

            _run_phase_launch review launch_review_phase "$ISSUE" "$SLUG" "$title" "${WORKTREE_ROOT}/${SLUG}" "$BRANCH" "$BASE_BRANCH" "$reviewer_launch_model" "$reviewer_agent" "$review_mode"
            local launch_rc=$?
            if ! handle_phase_launch_result "$ISSUE" "$FEATURE_DIR" "review" "coding" "$launch_rc" "$WIN" "$reviewer_agent" "$reviewer_launch_model"; then
              return 0
            fi
            set_window_attention_state "$WIN" "clear"
            log "status" "$ISSUE → Coding complete, launching review phase"
            active_count=$((active_count + 1))
            return 0
          fi

          # HOK-1194: Detect running→completed transition
          # When stage result is "running" and .coding-complete exists,
          # write completed status (next iteration will launch review)
          local coding_status
          coding_status=$(read_stage_status "$FEATURE_DIR" "coding")
          if [[ "$coding_status" == "running" ]]; then
            recover_misplaced_coding_complete_marker "$ISSUE" "${WORKTREE_ROOT}/${SLUG}" "$FEATURE_DIR" "$SLUG" || true
            if [[ -f "$FEATURE_DIR/.coding-complete" ]]; then
              local coding_complete_validation_rc=0
              seam_validate_artifact coding-complete "$FEATURE_DIR/.coding-complete" --canonicalize
              coding_complete_validation_rc=$?
              if [[ "$coding_complete_validation_rc" -ne 0 ]]; then
                local coding_complete_summary
                if [[ "$coding_complete_validation_rc" -eq 1 ]]; then
                  coding_complete_summary="$(seam_validation_error_summary "$SEAM_VALIDATION_JSON")"
                else
                  coding_complete_summary="seam validator unavailable"
                fi
                log_warn "$ISSUE needs attention: invalid .coding-complete: $coding_complete_summary"
                write_stage_result "$FEATURE_DIR" "coding" "running" "$current_agent" "$(resolve_stage_result_model "$FEATURE_DIR" "coding" "claude-opus-4-7")" "Invalid .coding-complete: $coding_complete_summary"
                set_window_attention_state "$WIN" "needs-user"
                active_count=$((active_count + 1))
                return 0
              fi
              if guard_coding_complete_handoff "$ISSUE" "$FEATURE_DIR" "${WORKTREE_ROOT}/${SLUG}" "$BASE_BRANCH"; then
                return 0
              fi
              validate_coding_phase_output "$BRANCH"
              log "status" "$ISSUE → .coding-complete detected, marking coding as completed"
              clear_coding_uncommitted_output_attention "$FEATURE_DIR"
              write_stage_result "$FEATURE_DIR" "coding" "completed" "$current_agent" "$(resolve_stage_result_model "$FEATURE_DIR" "coding" "claude-opus-4-7")"
              quarantine_completed_coding_pane "$ISSUE" "$FEATURE_DIR" "${WORKTREE_ROOT}/${SLUG}"
              # Next iteration will detect resolved_phase == "review" and launch review
              active_count=$((active_count + 1))
              return 0
            fi
            if [[ ! -f "$FEATURE_DIR/.coding-blocked-completion.json" ]] \
              && [[ "${current_agent:-}" == "codex" || "${AGENT_CMD:-}" == "codex" ]] \
              && codex_capacity_idle_confirmed "$ISSUE" "$SLUG" "$FEATURE_DIR" "${WORKTREE_ROOT}/${SLUG}"; then
              local codex_capacity_source codex_capacity_model
              codex_capacity_source="$(jq -r '.source // "unknown"' "$(codex_capacity_dwell_marker "$FEATURE_DIR")" 2>/dev/null || echo "unknown")"
              codex_capacity_model="$(jq -r '.model // empty' "$FEATURE_DIR/.coding-result.json" 2>/dev/null || echo "")"
              write_codex_capacity_blocked_completion "$ISSUE" "$FEATURE_DIR" "$codex_capacity_model" "$codex_capacity_source" || true
              write_stage_result "$FEATURE_DIR" "coding" "running" "$current_agent" "$(resolve_stage_result_model "$FEATURE_DIR" "coding" "claude-opus-4-7")" "Blocked: Codex model at capacity"
            fi
            if auto_advance_blocked_completion "$ISSUE" "$FEATURE_DIR" "$WIN_TARGET" "$WIN"; then
              set_window_attention_state "$WIN" "clear"
              active_count=$((active_count + 1))
              return 0
            fi
            if [[ "${AUTO_ADVANCE_BLOCKED_COMPLETION_HANDLED:-}" == "attention" ]]; then
              return 0
            fi
            if emit_blocked_completion_attention "$ISSUE" "$FEATURE_DIR"; then
              return 0
            fi
            if emit_pane_divergence_attention "$ISSUE" "$SLUG" "$FEATURE_DIR" "$WIN" "$WIN_TARGET"; then
              return 0
            fi
            if emit_native_terminal_failure_attention "$ISSUE" "$FEATURE_DIR" "coding" "$WIN" "$WIN_TARGET" "$current_agent" "$(resolve_stage_result_model "$FEATURE_DIR" "coding" "claude-opus-4-7")"; then
              return 0
            fi
            if emit_native_launch_failure_attention "$ISSUE" "$FEATURE_DIR" "coding" "$WIN" "$WIN_TARGET" "$current_agent" "$(resolve_stage_result_model "$FEATURE_DIR" "coding" "claude-opus-4-7")"; then
              return 0
            fi
            if emit_terminal_blocked_completion_attention "$ISSUE" "$SLUG" "$FEATURE_DIR" "$WIN" "$WIN_TARGET"; then
              return 0
            fi
            log "debug" "$ISSUE → Coding still running: waiting for .coding-complete"
          fi

          # Stage still running
          if [[ "$coding_status" == "running" ]]; then
            set_window_attention_state "$WIN" "clear"
            # Keep coding tasks active while the controller-owned stage is running
            active_count=$((active_count + 1))
            return 0
          fi

          if [[ "$coding_status" == "failed" ]]; then
            local coding_transient_rc=0
            maybe_retry_challenger_transient_phase "$ISSUE" "$FEATURE_DIR" "coding" "$WIN" || coding_transient_rc=$?
            if [[ "$coding_transient_rc" -eq 0 || "$coding_transient_rc" -eq 2 ]]; then
              active_count=$((active_count + 1))
              return 0
            fi
            emit_challenge_stage_failure_quarantine "$ISSUE" "$FEATURE_DIR" "coding" "$WIN" || true
            set_window_attention_state "$WIN" "needs-user"
            active_count=$((active_count + 1))
            return 0
          fi

          # No controller-observed completion artifact
          needs_attention="true"
          ;;

        review)
          if [[ "$resolved_phase" == "aborted" ]]; then
            log_task "status" "$ISSUE" "⛔ $ISSUE → Workflow aborted by user during review phase"
            write_stage_result "$FEATURE_DIR" "review" "aborted" "$current_agent" "$(resolve_stage_result_model "$FEATURE_DIR" "review" "claude-sonnet-5")"
            set_task_phase "$ISSUE" "aborted"
            set_window_attention_state "$WIN" "needs-user"
            return 0
          fi

          local review_status
          local pr_number
          review_status=$(read_stage_status "$FEATURE_DIR" "review")
          pr_number=$(find_pr_for_branch "$BRANCH")

          if [[ "$review_status" == "running" && -z "$pr_number" ]]; then
            _restore_inflight_task_window_if_missing "$ISSUE" "$SLUG" "$BRANCH" "review"
            if [[ "$_RESTORE_STATE" == "restored" ]]; then
              set_window_attention_state "$WIN" "clear"
              active_count=$((active_count + 1))
              return 0
            elif [[ "$_RESTORE_STATE" == "failed" ]]; then
              set_window_attention_state "$WIN" "needs-user"
              active_count=$((active_count + 1))
              return 0
            fi
          fi

          # Reconcile legacy/stale review state: once a PR exists, review is effectively complete
          # and the controller can move into ready even if the stage file is still "running".
          if [[ "$review_status" == "running" ]]; then
            if [[ -n "$pr_number" ]]; then
              local depends_on_pr_meta
              depends_on_pr_meta=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].dependsOnPr // empty')
              if [[ -n "$depends_on_pr_meta" ]]; then
                inject_depends_on_pr_block "$ISSUE" "$pr_number" "$depends_on_pr_meta"
              fi
              if record_review_pr_reconciliation "$FEATURE_DIR" "$pr_number" "$current_agent" "$(resolve_stage_result_model "$FEATURE_DIR" "review" "claude-sonnet-5")"; then
                dispatch_queued_children_for_parent "$ISSUE" "$pr_number"
                if [[ "${WAVEMILL_TERMINAL_RECONCILER_LOADED:-0}" == "1" ]]; then
                  wavemill_reconcile_terminal "$SESSION" "$ISSUE" "review_complete" "$pr_number" || true
                fi
                review_status="completed"
              else
                set_task_phase "$ISSUE" "review"
                set_window_attention_state "$WIN" "clear"
                active_count=$((active_count + 1))
                return 0
              fi
            elif emit_native_terminal_failure_attention "$ISSUE" "$FEATURE_DIR" "review" "$WIN" "$WIN_TARGET" "$current_agent" "$(resolve_stage_result_model "$FEATURE_DIR" "review" "claude-sonnet-5")"; then
              return 0
            elif emit_native_launch_failure_attention "$ISSUE" "$FEATURE_DIR" "review" "$WIN" "$WIN_TARGET" "$current_agent" "$(resolve_stage_result_model "$FEATURE_DIR" "review" "claude-sonnet-5")"; then
              return 0
            else
              set_window_attention_state "$WIN" "clear"
              # Keep review tasks active while the controller-owned stage is running
              active_count=$((active_count + 1))
              return 0
            fi
          fi

          if [[ "$review_status" == "running" ]]; then
            set_window_attention_state "$WIN" "clear"
            active_count=$((active_count + 1))
            return 0
          fi

          if [[ "$review_status" == "failed" ]]; then
            local review_transient_rc=0
            maybe_retry_challenger_transient_phase "$ISSUE" "$FEATURE_DIR" "review" "$WIN" || review_transient_rc=$?
            if [[ "$review_transient_rc" -eq 0 || "$review_transient_rc" -eq 2 ]]; then
              active_count=$((active_count + 1))
              return 0
            fi
            emit_challenge_stage_failure_quarantine "$ISSUE" "$FEATURE_DIR" "review" "$WIN" || true
            set_window_attention_state "$WIN" "needs-user"
            active_count=$((active_count + 1))
            return 0
          fi

          # This branch is only reachable when no PR is cached yet. The live
          # review -> ready transition for PR-backed tasks runs in the PR
          # lifecycle section below so resumed tasks can still advance.
          # Review is no longer running - check if PR was created and transition to ready phase.
          if [[ -n "$pr_number" ]]; then
            # Mark review as completed with PR artifact (HOK-1177)
            local depends_on_pr_meta
            depends_on_pr_meta=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].dependsOnPr // empty')
            if [[ -n "$depends_on_pr_meta" ]]; then
              inject_depends_on_pr_block "$ISSUE" "$pr_number" "$depends_on_pr_meta"
            fi
            title=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].title // ""')
            if [[ -z "$title" ]]; then
              issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
              title=$(echo "$issue_json" | jq -r '.title // "Task"' 2>/dev/null || echo "Task")
            fi

            if record_review_pr_reconciliation "$FEATURE_DIR" "$pr_number" "$current_agent" "$(resolve_stage_result_model "$FEATURE_DIR" "review" "claude-sonnet-5")"; then
              dispatch_queued_children_for_parent "$ISSUE" "$pr_number"

              # Transition to ready phase
              set_task_phase "$ISSUE" "ready"
              if [[ "${WAVEMILL_TERMINAL_RECONCILER_LOADED:-0}" == "1" ]]; then
                wavemill_reconcile_terminal "$SESSION" "$ISSUE" "review_complete" "$pr_number" || true
              fi
            else
              set_task_phase "$ISSUE" "review"
              if launch_review_for_missing_evidence "$ISSUE" "$SLUG" "$title" "${WORKTREE_ROOT}/${SLUG}" "$BRANCH" "$BASE_BRANCH" "$FEATURE_DIR" "$current_agent"; then
                set_window_attention_state "$WIN" "clear"
              else
                local relaunch_rc=$?
                if [[ "$relaunch_rc" -eq 2 ]] && check_stage_aborted "$FEATURE_DIR"; then
                  log_task "status" "$ISSUE" "⛔ $ISSUE → Workflow aborted during review launch"
                  set_task_phase "$ISSUE" "aborted"
                  set_window_attention_state "$WIN" "needs-user"
                  return 0
                fi
                write_ready_attention_file "$FEATURE_DIR" "Could not relaunch review for PR #$pr_number after missing review verdict evidence (rc=$relaunch_rc)."
                set_window_attention_state "$WIN" "needs-user"
              fi
              active_count=$((active_count + 1))
              return 0
            fi
            if launch_ready_phase "$ISSUE" "$SLUG" "$title" "${WORKTREE_ROOT}/${SLUG}" "$BRANCH" "$BASE_BRANCH" "$pr_number"; then
              local launch_rc=0
            else
              local launch_rc=$?
            fi
            if [[ "$launch_rc" -eq 2 ]] && check_stage_aborted "$FEATURE_DIR"; then
              log_task "status" "$ISSUE" "⛔ $ISSUE → Workflow aborted during ready launch"
              set_task_phase "$ISSUE" "aborted"
              set_window_attention_state "$WIN" "needs-user"
              return 0
            fi
            if [[ "$launch_rc" -eq 3 ]]; then
              set_window_attention_state "$WIN" "clear"
              log "status" "⚠ $ISSUE → Ready detected conflicts, launching remediation"
              active_count=$((active_count + 1))
              return 0
            fi
            if [[ "$launch_rc" -eq 5 ]]; then
              set_window_attention_state "$WIN" "clear"
              log "status" "⚙ $ISSUE → Ready remediation launched (PR #$pr_number)"
              active_count=$((active_count + 1))
              return 0
            fi
            if [[ "$launch_rc" -eq 4 || "$launch_rc" -eq 6 ]]; then
              set_window_attention_state "$WIN" "clear"
              active_count=$((active_count + 1))
              return 0
            fi
            if [[ "$launch_rc" -ne 0 ]]; then
              # Ready checks failed - mark for user attention
              log "⚠ $ISSUE → Ready checks failed (PR #$pr_number)"
              set_window_attention_state "$WIN" "needs-user"
              return 0
            fi
            set_window_attention_state "$WIN" "needs-user"
            log "status" "$ISSUE → Ready checks completed for PR #$pr_number"
            if [[ "${WAVEMILL_TERMINAL_RECONCILER_LOADED:-0}" == "1" ]]; then
              wavemill_reconcile_terminal "$SESSION" "$ISSUE" "ready_complete" "$pr_number" || true
            fi
            return 0
          fi
          # No PR created or ready phase disabled - mark for attention
          needs_attention="true"
          ;;

        ready)
          # This branch is only reachable when no PR is cached yet. Normal
          # ready-phase monitoring runs in the PR lifecycle section below,
          # because ready always has a known PR.
          if [[ "$resolved_phase" == "aborted" ]]; then
            log_task "status" "$ISSUE" "⛔ $ISSUE → Workflow aborted by user during ready phase"
            write_stage_result "$FEATURE_DIR" "ready" "aborted" "$current_agent"
            set_task_phase "$ISSUE" "aborted"
            set_window_attention_state "$WIN" "needs-user"
            return 0
          fi

          local ready_state_dir_path
          ready_state_dir_path="$(ready_state_dir "${WORKTREE_ROOT}/${SLUG}" "$SLUG")"

          if [[ -f "$ready_state_dir_path/.conflict-detected" ]]; then
            local ready_status launch_head current_head attention_head
            ready_status=$(read_stage_status "$ready_state_dir_path" "ready")
            launch_head=$(ready_conflict_launch_head "$ready_state_dir_path")
            current_head=$(git -C "${WORKTREE_ROOT}/${SLUG}" rev-parse HEAD 2>/dev/null || echo "")
            attention_head=$(ready_conflict_attention_head "$ready_state_dir_path")

            if [[ "$ready_status" == "running" ]] && [[ -n "$launch_head" ]] && [[ "$launch_head" == "$current_head" ]]; then
              set_window_attention_state "$WIN" "clear"
              active_count=$((active_count + 1))
              return 0
            fi

            if [[ "$ready_status" != "running" || -z "$launch_head" || "$launch_head" != "$current_head" ]]; then
              local pr_number
              pr_number=$(find_pr_for_branch "$BRANCH")
              if [[ -z "$pr_number" ]]; then
                write_ready_attention_file "$ready_state_dir_path" "Unable to find open PR for branch $BRANCH after conflict remediation."
                set_window_attention_state "$WIN" "needs-user"
                return 0
              fi

              if [[ -n "$attention_head" && -n "$current_head" && "$attention_head" == "$current_head" ]]; then
                if ready_conflict_recheck_due "$ready_state_dir_path" && ready_conflict_pr_is_clean "$ready_state_dir_path" "$pr_number" "$ISSUE"; then
                  clear_ready_conflict_markers "$ready_state_dir_path"
                else
                  set_window_attention_state "$WIN" "needs-user"
                  return 0
                fi
              fi

              title=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].title // ""')
              if [[ -z "$title" ]]; then
                issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
                title=$(echo "$issue_json" | jq -r '.title // "Task"' 2>/dev/null || echo "Task")
              fi

              if launch_ready_phase "$ISSUE" "$SLUG" "$title" "${WORKTREE_ROOT}/${SLUG}" "$BRANCH" "$BASE_BRANCH" "$pr_number"; then
                local launch_rc=0
              else
                local launch_rc=$?
              fi
              if [[ "$launch_rc" -eq 2 ]] && check_stage_aborted "$FEATURE_DIR"; then
                log_task "status" "$ISSUE" "⛔ $ISSUE → Workflow aborted during conflict remediation"
                set_task_phase "$ISSUE" "aborted"
                set_window_attention_state "$WIN" "needs-user"
                return 0
              fi
              if [[ "$launch_rc" -eq 3 ]]; then
                set_window_attention_state "$WIN" "clear"
                active_count=$((active_count + 1))
                return 0
              fi
              if [[ "$launch_rc" -eq 5 ]]; then
                set_window_attention_state "$WIN" "clear"
                active_count=$((active_count + 1))
                return 0
              fi
              if [[ "$launch_rc" -eq 4 || "$launch_rc" -eq 6 ]]; then
                set_window_attention_state "$WIN" "clear"
                active_count=$((active_count + 1))
                return 0
              fi
              if [[ "$launch_rc" -ne 0 ]]; then
                log "⚠ $ISSUE → Conflict remediation still needs attention"
                set_window_attention_state "$WIN" "needs-user"
                return 0
              fi

              log "$ISSUE → Conflict remediation complete, ready checks rerun"
              set_window_attention_state "$WIN" "needs-user"
              return 0
            fi
          fi
          set_window_attention_state "$WIN" "needs-user"
          return 0
          ;;

        aborted)
          set_window_attention_state "$WIN" "needs-user"
          return 0
          ;;

        executing)
          # Legacy autonomous mode - treat an idle shell as exited so stalled
          # autonomous panes do not occupy a slot forever.
          if ! _pane_is_dead_or_idle "$WIN_TARGET"; then
            set_window_attention_state "$WIN" "clear"
            active_count=$((active_count + 1))
            return 0
          fi
          ;;
      esac

      if [[ "$current_agent" == "codex" ]] && codex_has_pending_approval "$WT_DIR"; then
        needs_attention="true"
      fi

      if [[ "$needs_attention" == "true" ]]; then
        set_window_attention_state "$WIN" "needs-user"
      else
        set_window_attention_state "$WIN" "clear"
      fi

      # Not completed externally - keep controller-owned running stages active
      if phase_should_remain_active_without_pr "$FEATURE_DIR" "$current_phase" "$SLUG"; then
        active_count=$((active_count + 1))
        return 0
      fi

      if check_stage_aborted "$FEATURE_DIR"; then
        log_task "status" "$ISSUE" "⛔ $ISSUE → Workflow aborted (controller state)"
        set_task_phase "$ISSUE" "aborted"
        set_window_attention_state "$WIN" "needs-user"
        return 0
      fi

      if transient_error_recovery_pending "$ISSUE"; then
        set_window_attention_state "$WIN" "clear"
        active_count=$((active_count + 1))
        return 0
      fi

      # Window itself is gone (shouldn't happen with remain-on-exit, but
      # handle gracefully). Flag for attention instead of cleaning up
      # immediately — the worktree and branch still have value.
      if ! _tmux_task_window_target "$SESSION" "$ISSUE" "$SLUG" "${STATE_FILE:-}" "$WT_DIR" >/dev/null 2>&1; then
        log "status" "⚠ $ISSUE → Window disappeared during $current_phase phase, recreating..."
        tmux new-window -d -t "$SESSION" -n "$WIN" -c "${WORKTREE_ROOT}/${SLUG}" 2>/dev/null || true
        WIN_TARGET="$(tmux display-message -p -t "$SESSION:$WIN" '#{window_id}' 2>/dev/null || true)"
        [[ -n "$WIN_TARGET" ]] || WIN_TARGET="$WIN"
        persist_task_window_id "$ISSUE" "$WIN_TARGET"
        WIN_TARGET="$(_tmux_target_join "$SESSION" "$WIN_TARGET" 2>/dev/null || printf '%s:%s\n' "$SESSION" "$WIN_TARGET")"
        tmux set-option -t "$WIN_TARGET" remain-on-exit on 2>/dev/null || true
        sleep 1
        active_count=$((active_count + 1))
        set_window_attention_state "$WIN" "needs-user"
        return 0
      fi

      # Agent exited without creating a PR. This is an error condition, not
      # normal completion: preserve the worktree and branch for recovery.
      if check_pr_exists "$BRANCH"; then
        local pr_number
        pr_number=$(find_pr_for_branch "$BRANCH")
        if [[ -n "$pr_number" ]]; then
          PR_BY_ISSUE["$ISSUE"]="$pr_number"
          log "status" "$ISSUE → Found PR #$pr_number (updating state)"
          save_task_state "$ISSUE" "$SLUG" "$BRANCH" "$WT_DIR" "$pr_number" "" "$current_agent"
          set_task_phase "$ISSUE" "review"
          set_window_attention_state "$WIN" "needs-user"
          active_count=$((active_count + 1))
          return 0
        fi
      fi

      log_error "⚠ $ISSUE → Agent exited without creating PR on branch $BRANCH"
      save_task_state "$ISSUE" "$SLUG" "$BRANCH" "$WT_DIR" "" "error" "$current_agent"
      set_task_phase "$ISSUE" "error"

      local hook_protocol="$LIB_DIR/../hooks/wavemill-hook-protocol.sh"
      if [[ -f "$hook_protocol" ]]; then
        # Surface the controller-detected lifecycle error through the same
        # hook file dashboard readers use for agent-reported failures.
        source "$hook_protocol" || true
        WAVEMILL_SESSION="$SESSION" WAVEMILL_ISSUE="$ISSUE" \
          wavemill_hook_write "error" "NoPR" "Agent exited without creating PR on branch $BRANCH" "${current_agent:-unknown}" || true
      fi

      set_window_attention_state "$WIN" "needs-user"
      log "status" "⛔ $ISSUE → Task requires attention: No PR created (worktree preserved)"
      active_count=$((active_count + 1))
      return 0
    fi
  fi

  current_phase=$(get_task_phase "$ISSUE")
  local pr_status=""
  pr_status=$(pr_state "$PR")

  # Check completion before phase-specific OPEN handling so merged/closed PRs
  # still trigger eval, cleanup, and Linear updates after the ready stage was added.
  if validate_pr_merge "$PR"; then
    local merged_ready_dir merged_before_ready=false
    merged_ready_dir="$(ready_state_dir "${WORKTREE_ROOT}/${SLUG}" "$SLUG")"
    if ! ready_stage_allows_merge "$merged_ready_dir"; then
      merged_before_ready=true
      ready_stage_warn_bypass_once "$merged_ready_dir" "$ISSUE" "$PR" || true
      write_ready_attention_file "$merged_ready_dir" "PR #$PR was merged before the Release Readiness Check passed."
    else
      clear_transient_mergeability_state "$merged_ready_dir"
      marker_clear "$merged_ready_dir/.needs-attention"
    fi

    log "status" "$ISSUE → PR #$PR MERGED"
    set_window_attention_state "$WIN" "clear"

    # Capture eval eligibility and agent before cleanup removes task state.
    local _eval_needed=false _eval_agent=""
    if [[ "$AUTO_EVAL" == "true" ]]; then
      local _eval_completed
      _eval_completed=$(read_state_value "false" --arg i "$ISSUE" '.tasks[$i].evalCompleted // false')
      if [[ "$_eval_completed" == "false" ]]; then
        _eval_needed=true
        _eval_agent=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].agent // ""')
        [[ -z "$_eval_agent" ]] && _eval_agent="$AGENT_CMD"
      fi
    fi

    if [[ "$REQUIRE_CONFIRM" == "true" && "$merged_before_ready" != "true" ]]; then
      if [[ "$_eval_needed" == "true" ]]; then
        log_task "info" "$ISSUE" "📊 Running post-merge eval..."
        launch_background_post_merge_eval "$ISSUE" "$PR" "$BRANCH" "$SLUG" "$ISSUE" "post-merge"
      elif [[ "$AUTO_EVAL" == "true" ]]; then
        log "debug" "Eval already completed for $ISSUE"
      fi
      log "status" "  → Window stays open for review - close it when ready$(wavemill_config_annotation "mill.requireConfirm" "$REQUIRE_CONFIRM")"
      if [[ "${WAVEMILL_TERMINAL_RECONCILER_LOADED:-0}" == "1" ]]; then
        wavemill_reconcile_terminal "$SESSION" "$ISSUE" "pr_merged" "$PR" || true
      elif should_update_linear_state "$ISSUE"; then
        linear_set_state "$(get_linear_issue_id "$ISSUE")" "Done"
      fi
      # Preserve agent when marking as merged
      current_agent=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].agent // ""')
      save_task_state "$ISSUE" "$SLUG" "$BRANCH" "$WT_DIR" "$PR" "merged" "$current_agent"
      active_count=$((active_count + 1))
      return 0
    fi

    if [[ "${WAVEMILL_TERMINAL_RECONCILER_LOADED:-0}" == "1" ]]; then
      wavemill_reconcile_terminal "$SESSION" "$ISSUE" "pr_merged" "$PR" || true
    elif should_update_linear_state "$ISSUE"; then
      linear_set_state "$(get_linear_issue_id "$ISSUE")" "Done"
    fi
    resolve_pair_on_primary_merge "$ISSUE" "$PR" || true
    cleanup_merged_primary_challenge_task "$ISSUE" "$SLUG" "" "$PR"
    if [[ "$_eval_needed" == "true" ]]; then
      log_task "info" "$ISSUE" "📊 Eval queued in background"
      launch_background_post_merge_eval "$ISSUE" "$PR" "$BRANCH" "$SLUG" "$ISSUE" "post-merge" "$_eval_agent"
    elif [[ "$AUTO_EVAL" == "true" ]]; then
      log "debug" "Eval already completed for $ISSUE"
    fi
    return 0
  elif [[ "$pr_status" == "CLOSED" ]]; then
    log_warn "$ISSUE → PR #$PR CLOSED without merge"
    local linear_status="Backlog"
    if is_challenge_task "$ISSUE"; then
      local sibling_pr sibling_state
      sibling_pr=$(get_challenge_sibling_pr "$ISSUE")
      sibling_state=""

      # Challenge tasks should only move once the sibling outcome is definitive.
      if check_challenge_sibling_merged "$ISSUE"; then
        linear_status="Done"
        log "status" "Challenge sibling merged → marking Linear as Done"
      fi

      if [[ "$linear_status" != "Done" && -n "$sibling_pr" ]]; then
        sibling_state=$(pr_state "$sibling_pr")
      fi

      case "$linear_status:$sibling_pr:$sibling_state" in
        Done:*) ;;
        Backlog::*)
          linear_status=""
          log "debug" "  ↳ Challenge sibling PR not found yet, deferring Linear state update"
          ;;
        Backlog:*:CLOSED)
          log "status" "  ↺ Challenge sibling also closed → returning Linear to Backlog"
          ;;
        Backlog:*)
          linear_status=""
          log "debug" "  ↳ Challenge sibling still active or unknown, deferring Linear state update"
          ;;
      esac
    fi
    if [[ -n "$linear_status" ]]; then
      if [[ "${WAVEMILL_TERMINAL_RECONCILER_LOADED:-0}" == "1" ]]; then
        wavemill_reconcile_terminal "$SESSION" "$ISSUE" "pr_closed_unmerged" "$PR" || true
      elif should_update_linear_state "$ISSUE"; then
        linear_set_state "$(get_linear_issue_id "$ISSUE")" "$linear_status"
      fi
    fi
    if should_cleanup_closed_pr "$ISSUE"; then
      log "debug" "  ↳ Auto-cleaning closed challenger pane/worktree"
      set_window_attention_state "$WIN" "clear"
      cleanup_completed_task "$ISSUE" "$SLUG" "closed without merge" || true
    else
      CLEANED["$ISSUE"]=1
    fi
    return 0
  fi

  if [[ "$current_phase" == "review" ]]; then
    local resolved_phase review_status title launch_rc
    if [[ "$pr_status" == "OPEN" ]]; then
      resolved_phase=$(resolve_phase "$FEATURE_DIR")
      if [[ "$resolved_phase" == "aborted" ]]; then
        log_task "status" "$ISSUE" "⛔ $ISSUE → Workflow aborted by user during review phase"
        write_stage_result "$FEATURE_DIR" "review" "aborted" "$current_agent"
        set_task_phase "$ISSUE" "aborted"
        set_window_attention_state "$WIN" "needs-user"
        return 0
      fi

      review_status=$(read_stage_status "$FEATURE_DIR" "review")
      if [[ "$review_status" == "running" || -z "$review_status" || "$review_status" == "completed" ]]; then
        local depends_on_pr_meta
        depends_on_pr_meta=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].dependsOnPr // empty')
        if [[ -n "$depends_on_pr_meta" ]]; then
          inject_depends_on_pr_block "$ISSUE" "$PR" "$depends_on_pr_meta"
        fi
        title=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].title // ""')
        if [[ -z "$title" ]]; then
          issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
          title=$(echo "$issue_json" | jq -r '.title // "Task"' 2>/dev/null || echo "Task")
        fi

        if record_review_pr_reconciliation "$FEATURE_DIR" "$PR" "$current_agent" ""; then
          dispatch_queued_children_for_parent "$ISSUE" "$PR"
          set_task_phase "$ISSUE" "ready"
          if [[ "${WAVEMILL_TERMINAL_RECONCILER_LOADED:-0}" == "1" ]]; then
            wavemill_reconcile_terminal "$SESSION" "$ISSUE" "review_complete" "$PR" || true
          fi
        else
          set_task_phase "$ISSUE" "review"
          if [[ "$review_status" == "running" ]]; then
            set_window_attention_state "$WIN" "clear"
            active_count=$((active_count + 1))
            return 0
          fi
          if launch_review_for_missing_evidence "$ISSUE" "$SLUG" "$title" "${WORKTREE_ROOT}/${SLUG}" "$BRANCH" "$BASE_BRANCH" "$FEATURE_DIR" "$current_agent"; then
            set_window_attention_state "$WIN" "clear"
          else
            launch_rc=$?
            if [[ "$launch_rc" -eq 2 ]] && check_stage_aborted "$FEATURE_DIR"; then
              log_task "status" "$ISSUE" "⛔ $ISSUE → Workflow aborted during review launch"
              set_task_phase "$ISSUE" "aborted"
              set_window_attention_state "$WIN" "needs-user"
              return 0
            fi
            write_ready_attention_file "$FEATURE_DIR" "Could not relaunch review for PR #$PR after missing review verdict evidence (rc=$launch_rc)."
            set_window_attention_state "$WIN" "needs-user"
          fi
          active_count=$((active_count + 1))
          return 0
        fi

        if launch_ready_phase "$ISSUE" "$SLUG" "$title" "${WORKTREE_ROOT}/${SLUG}" "$BRANCH" "$BASE_BRANCH" "$PR"; then
          launch_rc=0
        else
          launch_rc=$?
        fi
        if [[ "$launch_rc" -eq 2 ]] && check_stage_aborted "$FEATURE_DIR"; then
          log_task "status" "$ISSUE" "⛔ $ISSUE → Workflow aborted during ready launch"
          set_task_phase "$ISSUE" "aborted"
          set_window_attention_state "$WIN" "needs-user"
          return 0
        fi
        if [[ "$launch_rc" -eq 3 ]]; then
          set_window_attention_state "$WIN" "clear"
          log "status" "⚠ $ISSUE → Ready detected conflicts, launching remediation"
          active_count=$((active_count + 1))
          return 0
        fi
        if [[ "$launch_rc" -eq 5 ]]; then
          set_window_attention_state "$WIN" "clear"
          log "status" "⚙ $ISSUE → Ready remediation launched (PR #$PR)"
          active_count=$((active_count + 1))
          return 0
        fi
        if [[ "$launch_rc" -eq 4 || "$launch_rc" -eq 6 ]]; then
          set_window_attention_state "$WIN" "clear"
          active_count=$((active_count + 1))
          return 0
        fi
        if [[ "$launch_rc" -ne 0 ]]; then
          log "status" "⚠ $ISSUE → Ready checks failed (PR #$PR)"
          set_window_attention_state "$WIN" "needs-user"
          return 0
        fi
        set_window_attention_state "$WIN" "needs-user"
        log "status" "$ISSUE → Ready checks completed for PR #$PR"
        if [[ "${WAVEMILL_TERMINAL_RECONCILER_LOADED:-0}" == "1" ]]; then
          wavemill_reconcile_terminal "$SESSION" "$ISSUE" "ready_complete" "$PR" || true
        fi
        return 0
      fi

      if ! restore_review_task_window "$ISSUE" "$SLUG" "$BRANCH" "$PR" "$WT_DIR"; then
        set_window_attention_state "$WIN" "needs-user"
        active_count=$((active_count + 1))
        return 0
      fi
    fi
  elif [[ "$current_phase" == "ready" ]]; then
    local resolved_phase ready_state_dir_path ready_status ready_verdict
    local launch_head current_head title launch_rc _conflict_cleared
    local recheck_disposition recheck_attempt recheck_limit
    local pending_recheck_disposition pending_recheck_limit pending_recheck_reason
    _conflict_cleared=false
    resolved_phase=$(resolve_phase "$FEATURE_DIR")
    if [[ "$resolved_phase" == "aborted" ]]; then
      log_task "status" "$ISSUE" "⛔ $ISSUE → Workflow aborted by user during ready phase"
      write_stage_result "$FEATURE_DIR" "ready" "aborted" "$current_agent"
      set_task_phase "$ISSUE" "aborted"
      set_window_attention_state "$WIN" "needs-user"
      return 0
    fi

    ready_state_dir_path="$(ready_state_dir "${WORKTREE_ROOT}/${SLUG}" "$SLUG")"
    if [[ -f "$ready_state_dir_path/.conflict-detected" ]]; then
      ready_status=$(read_stage_status "$ready_state_dir_path" "ready")
      launch_head=$(ready_conflict_launch_head "$ready_state_dir_path")
      current_head=$(git -C "${WORKTREE_ROOT}/${SLUG}" rev-parse HEAD 2>/dev/null || echo "")
      local attention_head
      attention_head=$(ready_conflict_attention_head "$ready_state_dir_path")

      if [[ "$ready_status" == "running" ]] && [[ -n "$launch_head" ]] && [[ "$launch_head" == "$current_head" ]]; then
        set_window_attention_state "$WIN" "clear"
        active_count=$((active_count + 1))
        return 0
      fi

      if [[ "$ready_status" != "running" || -z "$launch_head" || "$launch_head" != "$current_head" ]]; then
        if [[ -n "$attention_head" && -n "$current_head" && "$attention_head" == "$current_head" ]]; then
          if ready_conflict_recheck_due "$ready_state_dir_path" && ready_conflict_pr_is_clean "$ready_state_dir_path" "$PR" "$ISSUE"; then
            clear_ready_conflict_markers "$ready_state_dir_path"
            _conflict_cleared=true
          else
            set_window_attention_state "$WIN" "needs-user"
            return 0
          fi
        fi

        title=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].title // ""')
        if [[ -z "$title" ]]; then
          issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
          title=$(echo "$issue_json" | jq -r '.title // "Task"' 2>/dev/null || echo "Task")
        fi

        if launch_ready_phase "$ISSUE" "$SLUG" "$title" "${WORKTREE_ROOT}/${SLUG}" "$BRANCH" "$BASE_BRANCH" "$PR"; then
          launch_rc=0
        else
          launch_rc=$?
        fi
        if [[ "$launch_rc" -eq 2 ]] && check_stage_aborted "$FEATURE_DIR"; then
          log_task "status" "$ISSUE" "⛔ $ISSUE → Workflow aborted during conflict remediation"
          set_task_phase "$ISSUE" "aborted"
          set_window_attention_state "$WIN" "needs-user"
          return 0
        fi
        if [[ "$launch_rc" -eq 3 ]]; then
          set_window_attention_state "$WIN" "clear"
          active_count=$((active_count + 1))
          return 0
        fi
        if [[ "$launch_rc" -eq 5 ]]; then
          set_window_attention_state "$WIN" "clear"
          active_count=$((active_count + 1))
          return 0
        fi
        if [[ "$launch_rc" -eq 4 || "$launch_rc" -eq 6 ]]; then
          set_window_attention_state "$WIN" "clear"
          active_count=$((active_count + 1))
          return 0
        fi
        if [[ "$launch_rc" -ne 0 ]]; then
          log "status" "⚠ $ISSUE → Conflict remediation still needs attention"
          set_window_attention_state "$WIN" "needs-user"
          return 0
        fi

        log "status" "$ISSUE → Conflict remediation complete, ready checks rerun"
        if [[ "$_conflict_cleared" == "true" ]]; then
          set_window_attention_state "$WIN" "clear"
        else
          set_window_attention_state "$WIN" "needs-user"
        fi
        return 0
      fi
    fi

    ready_status=$(read_stage_status "$ready_state_dir_path" "ready")
    launch_head=$(ready_remediation_launch_head "$ready_state_dir_path")
    current_head=$(git -C "${WORKTREE_ROOT}/${SLUG}" rev-parse HEAD 2>/dev/null || echo "")

    # Ready stage finished — run challenge eval/comparison before dropping out.
    # Without this, challenge tasks sit in phase=ready forever (resolve_phase
    # keeps them there until merge), and the eval call at the bottom of this
    # function is unreachable.
    if [[ "$ready_status" == "completed" ]]; then
      if is_challenge_task "$ISSUE"; then
        maybe_run_challenge_eval "$ISSUE" "$PR" "$BRANCH" "$SLUG"
        maybe_run_challenge_comparison "$ISSUE"
        maybe_resolve_unresolvable_challenge_pair "$ISSUE"
      fi

      local challenge_comparison_state
      challenge_comparison_state=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].comparisonState // empty')
      case "$challenge_comparison_state" in
        manual_comparison_needed)
          set_window_attention_state "$WIN" "needs-user"
          active_count=$((active_count + 1))
          return 0
          ;;
        retrying_eval)
          set_window_attention_state "$WIN" "clear"
          active_count=$((active_count + 1))
          return 0
          ;;
        comparison_running)
          set_window_attention_state "$WIN" "clear"
          active_count=$((active_count + 1))
          return 0
          ;;
      esac

      # Re-run ready if main has advanced since the pass was recorded (HOK-1359)
      local stored_base_sha current_main_sha queue_state
      stored_base_sha=$(ready_base_sha "$ready_state_dir_path")
      current_main_sha=$(get_main_head_sha "${WORKTREE_ROOT}/${SLUG}" "$BASE_BRANCH")
      queue_state=$(ready_queue_state "$ready_state_dir_path")

      if [[ -n "$current_main_sha" && "$stored_base_sha" != "$current_main_sha" ]]; then
        if merge_queue_enabled; then
          if [[ "$queue_state" != "merge-candidate" ]]; then
            mark_ready_stale "$ISSUE" "$ready_state_dir_path" "$stored_base_sha" "$current_main_sha"
            log_ready_stale_merge_lane_once "$ISSUE" "$PR" "$stored_base_sha" "$current_main_sha"
            set_window_attention_state "$WIN" "clear"
            active_count=$((active_count + 1))
            return 0
          fi
          if ! ready_candidate_selected "$ISSUE"; then
            set_window_attention_state "$WIN" "clear"
            active_count=$((active_count + 1))
            return 0
          fi
        fi
        log "status" "⚠ $ISSUE → Ready result stale (main advanced); re-running ready checks for PR #$PR"
        title=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].title // ""')
        if [[ -z "$title" ]]; then
          issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
          title=$(echo "$issue_json" | jq -r '.title // "Task"' 2>/dev/null || echo "Task")
        fi
        if launch_ready_phase "$ISSUE" "$SLUG" "$title" "${WORKTREE_ROOT}/${SLUG}" "$BRANCH" "$BASE_BRANCH" "$PR"; then
          launch_rc=0
        else
          launch_rc=$?
        fi
        if [[ "$launch_rc" -eq 2 ]] && check_stage_aborted "$FEATURE_DIR"; then
          log_task "status" "$ISSUE" "⛔ $ISSUE → Workflow aborted during stale-ready re-check"
          set_task_phase "$ISSUE" "aborted"
          set_window_attention_state "$WIN" "needs-user"
          return 0
        fi
        if [[ "$launch_rc" -eq 3 || "$launch_rc" -eq 4 || "$launch_rc" -eq 5 || "$launch_rc" -eq 6 ]]; then
          set_window_attention_state "$WIN" "clear"
          active_count=$((active_count + 1))
          return 0
        fi
        if [[ "$launch_rc" -ne 0 ]]; then
          log "status" "⚠ $ISSUE → Ready re-check failed after main advanced (PR #$PR)"
          set_window_attention_state "$WIN" "needs-user"
          return 0
        fi
        log "status" "$ISSUE → Ready re-check passed after main advanced (PR #$PR)"
        set_window_attention_state "$WIN" "clear"
        active_count=$((active_count + 1))
        return 0
      fi

      if merge_queue_enabled && [[ "$queue_state" == "merge-candidate" ]]; then
        last_ci_conclusion=$(ready_queue_field "$ready_state_dir_path" "lastCiConclusion")
        last_ci_summary=$(ready_queue_field "$ready_state_dir_path" "lastCiSummary")
        last_ci_head=$(ready_queue_field "$ready_state_dir_path" "lastCiHeadSha")
        if [[ -n "$last_ci_conclusion" ]]; then
          log "debug" "✓ $ISSUE → PR #$PR is a merge candidate (live CI ${last_ci_summary:-$last_ci_conclusion}${last_ci_head:+ @${last_ci_head:0:7}}; waiting in merge lane)"
        else
          log "debug" "✓ $ISSUE → PR #$PR is a merge candidate (live CI unverified, saved verdict only)"
        fi

        if [[ "$(get_task_execution_owner "$ISSUE")" == "queue" && "$(get_task_pane_state "$ISSUE")" == "released" ]]; then
          release_task_pane_window_only "$ISSUE" "$SLUG" "${WORKTREE_ROOT}/${SLUG}" || true
          queue_owned_count=$((queue_owned_count + 1))
          set_window_attention_state "$WIN" "clear"
          return 0
        fi

        if [[ "$(get_task_execution_owner "$ISSUE")" == "reconciliation" && "$(get_task_pane_state "$ISSUE")" == "rehydrating" ]]; then
          reconciliation_lease_release "$ready_state_dir_path"
        fi

        local release_reason
        release_reason="$(pane_release_preflight "$ISSUE" "$SLUG" "$ready_state_dir_path" "${WORKTREE_ROOT}/${SLUG}" "$PR" "$BRANCH" "$BASE_BRANCH" 2>/dev/null || true)"
        if [[ "$release_reason" == "ok" ]]; then
          if release_task_pane "$ISSUE" "$SLUG" "$ready_state_dir_path" "${WORKTREE_ROOT}/${SLUG}" "$PR"; then
            queue_owned_count=$((queue_owned_count + 1))
            set_window_attention_state "$WIN" "clear"
            return 0
          fi
          set_task_task_owned "$ISSUE" "active" || true
          write_pane_release_blocked_marker "$ready_state_dir_path" "pane-release-failed" "${WORKTREE_ROOT}/${SLUG}"
        elif pane_release_reason_actionable "$release_reason"; then
          if [[ "$(get_task_execution_owner "$ISSUE")" == "reconciliation" ]]; then
            set_task_task_owned "$ISSUE" "active" || true
          fi
          write_pane_release_blocked_marker "$ready_state_dir_path" "$release_reason" "${WORKTREE_ROOT}/${SLUG}"
          log "debug" "  $ISSUE: pane release blocked ($release_reason)"
        else
          clear_stale_pane_release_blocked_marker "$ready_state_dir_path" "${WORKTREE_ROOT}/${SLUG}"
        fi
      fi
      set_window_attention_state "$WIN" "clear"
      active_count=$((active_count + 1))
      return 0
    fi

    if [[ "$ready_status" == "running" ]] && [[ -n "$launch_head" ]] && [[ "$launch_head" == "$current_head" ]]; then
      set_window_attention_state "$WIN" "clear"
      active_count=$((active_count + 1))
      return 0
    fi

    ready_verdict=$(ready_stage_pending_verdict "$ready_state_dir_path")
    if [[ "$ready_status" == "failed" ]]; then
      # Bound the re-check loop (HOK-2893): attempt ceiling + backoff + terminal
      # hold, reset by a new commit or a ready pass.
      recheck_disposition=$(failed_ready_recheck_gate "$ready_state_dir_path" "$current_head")
      recheck_limit="${READY_FAILED_RECHECK_MAX_ATTEMPTS:-4}"
      case "$recheck_disposition" in
        exhausted)
          if mark_failed_ready_recheck_exhausted "$ISSUE" "$PR" "$ready_state_dir_path"; then
            log "status" "⛔ $ISSUE → Failed-ready re-checks exhausted for PR #$PR; waiting for a new commit or operator"
          fi
          set_window_attention_state "$WIN" "needs-user"
          return 0
          ;;
        exhausted-quiet)
          set_window_attention_state "$WIN" "needs-user"
          return 0
          ;;
        backoff)
          log "debug" "  $ISSUE: holding failed-ready re-check for PR #$PR (backoff)"
          active_count=$((active_count + 1))
          return 0
          ;;
      esac

      recheck_attempt=$(increment_failed_ready_recheck_count "$ready_state_dir_path" "$current_head")
      log "status" "↻ $ISSUE → Re-running failed ready checks for PR #$PR (attempt ${recheck_attempt}/${recheck_limit})"
      title=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].title // ""')
      if [[ -z "$title" ]]; then
        issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
        title=$(echo "$issue_json" | jq -r '.title // "Task"' 2>/dev/null || echo "Task")
      fi

      if launch_ready_phase "$ISSUE" "$SLUG" "$title" "${WORKTREE_ROOT}/${SLUG}" "$BRANCH" "$BASE_BRANCH" "$PR"; then
        launch_rc=0
      else
        launch_rc=$?
      fi
      if [[ "$launch_rc" -eq 2 ]] && check_stage_aborted "$FEATURE_DIR"; then
        log_task "status" "$ISSUE" "⛔ $ISSUE → Workflow aborted during failed-ready re-check"
        set_task_phase "$ISSUE" "aborted"
        set_window_attention_state "$WIN" "needs-user"
        return 0
      fi
      if [[ "$launch_rc" -eq 3 || "$launch_rc" -eq 4 || "$launch_rc" -eq 5 || "$launch_rc" -eq 6 ]]; then
        set_window_attention_state "$WIN" "clear"
        active_count=$((active_count + 1))
        return 0
      fi
      if [[ "$launch_rc" -ne 0 ]]; then
        record_failed_ready_recheck_observation "$ready_state_dir_path"
        log "status" "⚠ $ISSUE → Ready re-check still failed (PR #$PR)"
        set_window_attention_state "$WIN" "needs-user"
        return 0
      fi

      log "status" "$ISSUE → Ready re-check passed for PR #$PR"
      set_window_attention_state "$WIN" "clear"
      active_count=$((active_count + 1))
      return 0
    fi

    # Re-run ready checks when CI is still computing (verdict=pending) OR when
	    # a remediation agent has pushed new commits past the launch head — without
    # the second case, a successful remediation leaves status=running/verdict=fail
    # and the controller never re-evaluates CI.
    if [[ "$ready_status" == "running" ]] && { [[ "$ready_verdict" == "pending" ]] || [[ -n "$launch_head" && "$launch_head" != "$current_head" ]]; }; then
      # Bound the pending-ready re-check loop (HOK-2924): the sibling of the
      # failed-ready budget above. A refused launch preserves exactly the
      # precondition that re-arms this branch, so without a ceiling it retries
      # every poll tick forever. A new commit or a fresh ready verdict wipes
      # the budget; failed launches back off, then terminalize.
      pending_recheck_limit="${WAVEMILL_PENDING_READY_RECHECK_MAX_ATTEMPTS:-4}"
      [[ "$pending_recheck_limit" =~ ^[0-9]+$ ]] || pending_recheck_limit=4
      pending_recheck_disposition=$(bounded_retry_gate "$ready_state_dir_path" "pending-ready-recheck" "$current_head" "$pending_recheck_limit")
      case "$pending_recheck_disposition" in
        exhausted)
          pending_recheck_reason=$(ready_failure_reason "$ready_state_dir_path")
          [[ -n "$pending_recheck_reason" ]] || pending_recheck_reason="ready launch kept failing without a fresh verdict"
          if bounded_retry_mark_exhausted "$ready_state_dir_path" "pending-ready-recheck" \
              "Pending-ready re-checks exhausted after $(bounded_retry_count "$ready_state_dir_path" "pending-ready-recheck") attempt(s) for PR #$PR: $pending_recheck_reason"; then
            write_ready_attention_file "$ready_state_dir_path" \
              "Pending-ready re-checks exhausted for PR #$PR: $pending_recheck_reason. Waiting for a new commit or operator."
            log "status" "⛔ $ISSUE → Pending-ready re-checks exhausted for PR #$PR; waiting for a new commit or operator"
          fi
          set_window_attention_state "$WIN" "needs-user"
          return 0
          ;;
        exhausted-quiet)
          set_window_attention_state "$WIN" "needs-user"
          return 0
          ;;
        backoff)
          log "debug" "  $ISSUE: holding pending-ready re-check for PR #$PR (backoff)"
          active_count=$((active_count + 1))
          return 0
          ;;
      esac

      title=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].title // ""')
      if [[ -z "$title" ]]; then
        issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
        title=$(echo "$issue_json" | jq -r '.title // "Task"' 2>/dev/null || echo "Task")
      fi

      bounded_retry_increment "$ready_state_dir_path" "pending-ready-recheck" "$current_head" >/dev/null
      if launch_ready_phase "$ISSUE" "$SLUG" "$title" "${WORKTREE_ROOT}/${SLUG}" "$BRANCH" "$BASE_BRANCH" "$PR"; then
        launch_rc=0
      else
        launch_rc=$?
      fi
      if [[ "$launch_rc" -eq 2 ]] && check_stage_aborted "$FEATURE_DIR"; then
        log_task "status" "$ISSUE" "⛔ $ISSUE → Workflow aborted during ready re-check"
        set_task_phase "$ISSUE" "aborted"
        set_window_attention_state "$WIN" "needs-user"
        return 0
      fi
      if [[ "$launch_rc" -eq 3 ]]; then
        bounded_retry_clear "$ready_state_dir_path" "pending-ready-recheck"
        set_window_attention_state "$WIN" "clear"
        active_count=$((active_count + 1))
        return 0
      fi
      if [[ "$launch_rc" -eq 5 ]]; then
        bounded_retry_clear "$ready_state_dir_path" "pending-ready-recheck"
        set_window_attention_state "$WIN" "clear"
        active_count=$((active_count + 1))
        return 0
      fi
      if [[ "$launch_rc" -eq 4 || "$launch_rc" -eq 6 ]]; then
        bounded_retry_clear "$ready_state_dir_path" "pending-ready-recheck"
        set_window_attention_state "$WIN" "clear"
        active_count=$((active_count + 1))
        return 0
      fi
      if [[ "$launch_rc" -ne 0 ]]; then
        # Terminal cause (HOK-2915 shape): a review artifact the readiness
        # gate can never accept cannot become passing by relaunching ready —
        # unless it is an infra failure, which launch_ready_phase recovers by
        # relaunching review. Abort on the first refusal instead of retrying.
        if ! review_result_passes_ready_gate "$ready_state_dir_path" \
            && ! review_result_infra_failure "$ready_state_dir_path"; then
          if bounded_retry_mark_exhausted "$ready_state_dir_path" "pending-ready-recheck" \
              "Ready launch refused for PR #$PR: review verdict does not pass the readiness gate (terminal until the review artifact changes)"; then
            log "status" "⛔ $ISSUE → Ready launch refused by review gate for PR #$PR; not retrying (terminal cause)"
          fi
        fi
        log "status" "⚠ $ISSUE → Ready checks failed (PR #$PR)"
        set_window_attention_state "$WIN" "needs-user"
        return 0
      fi
      bounded_retry_clear "$ready_state_dir_path" "pending-ready-recheck"

      log "status" "$ISSUE → Ready checks completed for PR #$PR"
      if [[ "${WAVEMILL_TERMINAL_RECONCILER_LOADED:-0}" == "1" ]]; then
        wavemill_reconcile_terminal "$SESSION" "$ISSUE" "ready_complete" "$PR" || true
      fi
      set_window_attention_state "$WIN" "clear"
      active_count=$((active_count + 1))
      return 0
    fi

    set_window_attention_state "$WIN" "needs-user"
    return 0
  fi

  # PR open but not merged — re-check challenge eval and comparison
  # in case the eval was missed on initial PR detection (e.g. challenge
  # flag was incorrect when PR was first found)
  if is_challenge_task "$ISSUE"; then
    maybe_run_challenge_eval "$ISSUE" "$PR" "$BRANCH" "$SLUG"
    maybe_run_challenge_comparison "$ISSUE"
    maybe_resolve_unresolvable_challenge_pair "$ISSUE"
  fi
  active_count=$((active_count + 1))

  return 0
}

# ── Control pane health watchdog ──────────────────────────────────────
# Respawns dead mill panes (dashboard, log) to prevent layout collapse.
# Called each monitor cycle. Relies on remain-on-exit keeping dead panes
# visible so we can detect and respawn them without losing the layout.
LAST_DASHBOARD_HEALTH_CHECK=0
DASHBOARD_HEALTH_INTERVAL=30  # seconds between checks
LAST_CONTROL_PANE_HEALTH_STATUS=""

classify_control_pane_input_path() {
  local pane_details="${1-}"
  local session_name="${2:-$SESSION}"

  if [[ -z "$pane_details" ]]; then
    printf 'unknown\n'
    return 0
  fi

  if [[ "$pane_details" == *"wavemill-input-reader.sh"* ]]; then
    printf 'healthy\n'
    return 0
  fi

  if [[ "$pane_details" == *"/tmp/${session_name}-monitor.sh"* ]] || [[ "$pane_details" == *"wavemill-monitor.sh"* ]]; then
    printf 'drifted-monitor\n'
    return 0
  fi

  printf 'unknown\n'
}

probe_control_pane_input_path() {
  tmux display-message -p -t "$SESSION:$WAVEMILL_WINDOW_MILL.0" \
    '#{pane_id} #{pane_pid} #{pane_current_command} #{pane_start_command}'
}

recover_control_pane_input_path() {
  local cmd_file monitor_cmd
  cmd_file="$(wavemill_command_file_path "$SESSION")"
  monitor_cmd="$(wavemill_build_control_pane_command recovery "$SESSION" "$MONITOR_SCRIPT" "$MONITOR_ENV" "$LIB_DIR")" || {
    log_warn "Control pane recovery command build failed. Append 'quit' to $cmd_file to exit safely."
    return 1
  }

  tmux respawn-pane -k -t "$SESSION:$WAVEMILL_WINDOW_MILL.0" "$monitor_cmd" 2>/dev/null || {
    log_warn "Control pane recovery failed. Append 'quit' to $cmd_file to exit safely."
    return 1
  }

  return 0
}

check_mill_pane_health() {
  local now
  now=$(date +%s)
  (( now - LAST_DASHBOARD_HEALTH_CHECK < DASHBOARD_HEALTH_INTERVAL )) && return 0
  LAST_DASHBOARD_HEALTH_CHECK=$now

  local pane_count
  pane_count=$(tmux list-panes -t "$SESSION:$WAVEMILL_WINDOW_MILL" -F '#{pane_index}' 2>/dev/null | wc -l | tr -d ' ')

  # If panes were destroyed (layout collapsed), rebuild from scratch.
  if (( pane_count < 3 )); then
    log_warn "Control window has $pane_count pane(s) (expected 3). Rebuilding layout..."
    local status_script="$LIB_DIR/wavemill-status.sh"

    if (( pane_count == 1 )); then
      # Single pane remaining — recreate both missing panes
      tmux split-window -t "$SESSION:$WAVEMILL_WINDOW_MILL.0" -hb -p 50 "exec bash" 2>/dev/null || true
      tmux split-window -t "$SESSION:$WAVEMILL_WINDOW_MILL.0" -v -p 65 "exec bash" 2>/dev/null || true
    elif (( pane_count == 2 )); then
      # Two panes — add the missing one
      tmux split-window -t "$SESSION:$WAVEMILL_WINDOW_MILL.0" -v -p 65 "exec bash" 2>/dev/null || true
    fi

    # Re-count after splits
    pane_count=$(tmux list-panes -t "$SESSION:$WAVEMILL_WINDOW_MILL" -F '#{pane_index}' 2>/dev/null | wc -l | tr -d ' ')
    if (( pane_count >= 3 )); then
      # Respawn dashboard (pane 1) and log (pane 2)
      tmux respawn-pane -k -t "$SESSION:$WAVEMILL_WINDOW_MILL.1" "'$status_script' '$SESSION' '$WORKTREE_ROOT' '$STATE_FILE'" 2>/dev/null || true
      tmux respawn-pane -k -t "$SESSION:$WAVEMILL_WINDOW_MILL.2" "bash -c \"clear && printf 'Wavemill Status Log\\n\\n' && tail -n 200 -f '$STATUS_LOG_FILE'\"" 2>/dev/null || true
      # Update dashboard PID
      sleep 0.3
      local new_pid
      new_pid=$(tmux list-panes -t "$SESSION:$WAVEMILL_WINDOW_MILL.1" -F '#{pane_pid}' 2>/dev/null || true)
      [[ -n "$new_pid" ]] && tmux set-environment -t "$SESSION" WAVEMILL_DASHBOARD_PID "$new_pid" 2>/dev/null || true
      log "status" "Control panes rebuilt successfully"
    else
      log_warn "Failed to rebuild mill panes (got $pane_count)"
      return 0
    fi
  fi

  # All 3 panes exist — check for dead ones and respawn in place.
  local dead_panes
  dead_panes=$(tmux list-panes -t "$SESSION:$WAVEMILL_WINDOW_MILL" -F '#{pane_index} #{pane_dead}' 2>/dev/null || true)

  while IFS=' ' read -r idx is_dead; do
    [[ "$is_dead" == "1" ]] || continue
    case "$idx" in
      1)
        log_warn "Dashboard pane (control.1) is dead. Respawning..."
        local status_script="$LIB_DIR/wavemill-status.sh"
        tmux respawn-pane -t "$SESSION:$WAVEMILL_WINDOW_MILL.1" "'$status_script' '$SESSION' '$WORKTREE_ROOT' '$STATE_FILE'" 2>/dev/null || true
        sleep 0.3
        local new_pid
        new_pid=$(tmux list-panes -t "$SESSION:$WAVEMILL_WINDOW_MILL.1" -F '#{pane_pid}' 2>/dev/null || true)
        [[ -n "$new_pid" ]] && tmux set-environment -t "$SESSION" WAVEMILL_DASHBOARD_PID "$new_pid" 2>/dev/null || true
        log "status" "Dashboard pane respawned"
        ;;
      2)
        log_warn "Log pane (control.2) is dead. Respawning..."
        tmux respawn-pane -t "$SESSION:$WAVEMILL_WINDOW_MILL.2" "bash -c \"clear && printf 'Wavemill Status Log\\n\\n' && tail -n 200 -f '$STATUS_LOG_FILE'\"" 2>/dev/null || true
        log "status" "Log pane respawned"
        ;;
    esac
  done <<<"$dead_panes"

  local pane_probe pane_status status_key cmd_file
  cmd_file="$(wavemill_command_file_path "$SESSION")"
  if ! pane_probe=$(probe_control_pane_input_path 2>/dev/null); then
    status_key="probe-failed"
    if [[ "$LAST_CONTROL_PANE_HEALTH_STATUS" != "$status_key" ]]; then
      log_warn "Unable to inspect control pane input path. If quit input is stuck, append 'quit' to $cmd_file."
    fi
    LAST_CONTROL_PANE_HEALTH_STATUS="$status_key"
    return 0
  fi

  pane_status="$(classify_control_pane_input_path "$pane_probe" "$SESSION")"
  case "$pane_status" in
    healthy)
      LAST_CONTROL_PANE_HEALTH_STATUS="healthy"
      return 0
      ;;
    drifted-monitor)
      if [[ "$LAST_CONTROL_PANE_HEALTH_STATUS" != "drifted-monitor" ]]; then
        log_warn "Control pane drift detected (pane 0 is running the monitor directly). Recovering input reader..."
      fi
      LAST_CONTROL_PANE_HEALTH_STATUS="drifted-monitor"
      recover_control_pane_input_path || true
      return 0
      ;;
    *)
      if [[ "$LAST_CONTROL_PANE_HEALTH_STATUS" != "unknown" ]]; then
        log_warn "Control pane input path is unknown. If quit input is stuck, append 'quit' to $cmd_file."
      fi
      LAST_CONTROL_PANE_HEALTH_STATUS="unknown"
      return 0
      ;;
  esac
}

handle_monitor_quit_command() {
  local active_count="${1:-0}"
  if [[ "$QUIT_REQUESTED" == "true" ]]; then
    if (( active_count == 0 )); then
      quit_and_kill_session "Quitting (all tasks complete)."
    else
      quit_and_kill_session "Force quitting (${active_count} task(s) still active)."
    fi
  elif (( active_count == 0 )); then
    quit_and_kill_session "Quitting."
  else
    log "status" "Will quit after ${active_count} active task(s) finish. Press q again to force quit."
    QUIT_REQUESTED=true
  fi
}

# ── Backstage tend-loop health watchdog ──────────────────────────────
LAST_BACKSTAGE_HEALTH_CHECK=0
LAST_BACKSTAGE_OBSERVER_HEALTH_CHECK=0
BACKSTAGE_HEALTH_INTERVAL=30
BACKSTAGE_RESTART_COOLDOWN=60
# Tend's self-healing loop caps error backoff at 120s; keep this stale window above that.
BACKSTAGE_TEND_HEARTBEAT_STALE_SECONDS=210
BACKSTAGE_CLASSIFICATION_HOLD_STALE_SECONDS=900
BACKSTAGE_RESTART_BACKOFF_MAX_SECONDS=900
BACKSTAGE_RESTART_NEEDS_USER_AFTER_ATTEMPTS=3
BACKSTAGE_TEND_RESTART_CONFIRM_SECONDS=20
BACKSTAGE_TEND_RESTART_GRACE_SECONDS=120
READY_WATCHDOG_FAILURE_LOG_INTERVAL=60
LAST_BACKSTAGE_HEALTH_STATUS=""
LAST_BACKSTAGE_OBSERVER_HEALTH_STATUS=""
LAST_READY_WATCHDOG_FAILURE_DETAIL=""
LAST_READY_WATCHDOG_FAILURE_AT=0

backstage_health_enabled() {
  local merged enabled use_mill_session
  merged="$(wavemill_load_config "$REPO_DIR")"
  enabled="$(printf '%s' "$merged" | jq -r '.integration.enabled // false' 2>/dev/null || echo false)"
  use_mill_session="$(printf '%s' "$merged" | jq -r '.integration.useMillSession // true' 2>/dev/null || echo true)"
  [[ "$enabled" == "true" && "$use_mill_session" == "true" ]]
}

backstage_restart_backoff_seconds() {
  local attempt_count="${1:-0}" delay exponent i
  [[ "$attempt_count" =~ ^[0-9]+$ ]] || attempt_count=0
  if (( attempt_count <= 0 )); then
    printf '0\n'
    return 0
  fi
  if (( attempt_count > 10 )); then
    printf '%s\n' "$BACKSTAGE_RESTART_BACKOFF_MAX_SECONDS"
    return 0
  fi
  delay="$BACKSTAGE_RESTART_COOLDOWN"
  exponent=$(( attempt_count - 1 ))
  for (( i = 0; i < exponent; i++ )); do
    delay=$(( delay * 2 ))
    if (( delay >= BACKSTAGE_RESTART_BACKOFF_MAX_SECONDS )); then
      delay="$BACKSTAGE_RESTART_BACKOFF_MAX_SECONDS"
      break
    fi
  done
  (( delay > BACKSTAGE_RESTART_BACKOFF_MAX_SECONDS )) && delay="$BACKSTAGE_RESTART_BACKOFF_MAX_SECONDS"
  printf '%s\n' "$delay"
}

probe_backstage_panes() {
  tmux list-panes -t "$SESSION:$WAVEMILL_WINDOW_BACKSTAGE" \
    -F '#{pane_id}	#{pane_title}	#{pane_dead}	#{pane_current_command}	#{pane_start_command}'
}

read_backstage_health_field() {
  local field="$1"
  local path
  path="$(wavemill_backstage_health_file "$STATE_DIR" 2>/dev/null || true)"
  [[ -n "$path" && -f "$path" ]] || return 1
  jq -r "$field // empty" "$path" 2>/dev/null
}

read_backstage_service_health_field() {
  local service="$1" field="$2"
  local path
  path="$(wavemill_backstage_health_file "$STATE_DIR" 2>/dev/null || true)"
  [[ -n "$path" && -f "$path" ]] || return 1
  jq -r --arg service "$service" ".services[\$service] | $field // empty" "$path" 2>/dev/null
}

classify_ready_watchdog_hold_health() {
  local now="${1:-$(date +%s)}" stale_seconds="${2:-$BACKSTAGE_CLASSIFICATION_HOLD_STALE_SECONDS}"
  local state_file="${STATE_DIR:-}/ready-watchdog-state.json"
  local row issue classification since updated_at detail epoch held_seconds held_minutes oldest_seconds=0
  local oldest_issue="" oldest_classification="" oldest_held_minutes=0

  [[ -r "$state_file" ]] || return 1

  while IFS=$'\t' read -r issue classification since updated_at detail; do
    [[ -n "$issue" && -n "$classification" ]] || continue
    if [[ "$classification" != "needs-user" && "$classification" != "stuck" ]]; then
      continue
    fi

    [[ -n "$since" ]] || since="$updated_at"
    [[ -n "$since" ]] || continue
    epoch="$(wavemill_iso8601_to_epoch "$since" 2>/dev/null || echo 0)"
    [[ "$epoch" =~ ^[0-9]+$ && "$epoch" -gt 0 ]] || continue
    held_seconds=$(( now - epoch ))
    (( held_seconds > stale_seconds )) || continue
    if (( held_seconds > oldest_seconds )); then
      held_minutes=$(( held_seconds / 60 ))
      oldest_seconds="$held_seconds"
      oldest_issue="$issue"
      oldest_classification="$classification"
      oldest_held_minutes="$held_minutes"
    fi
  done < <(
    jq -r '
      (.tasks // {}) | to_entries[] |
      [
        .key,
        (.value.classification // ""),
        (.value.classificationSince // ""),
        (.value.updatedAt // ""),
        (.value.detail // "")
      ] | @tsv
    ' "$state_file" 2>/dev/null || true
  )

  [[ -n "$oldest_issue" ]] || return 1
  printf 'task %s has held %s for %sm\n' "$oldest_issue" "$oldest_classification" "$oldest_held_minutes"
}

classify_backstage_health() {
  local pane_details="${1-}" now="${2:-$(date +%s)}" stale_seconds="${3:-$BACKSTAGE_TEND_HEARTBEAT_STALE_SECONDS}" hold_stale_seconds="${4:-$BACKSTAGE_CLASSIFICATION_HOLD_STALE_SECONDS}"
  local pane_count=0 tend_alive=0 tend_count=0 status_panes=0
  local executor_pane_id="" pane_id pane_title pane_dead _pane_cmd _start_cmd
  local heartbeat_at="" heartbeat_epoch=0 heartbeat_age="" updated_at="" updated_epoch=0 updated_age="" hold_detail=""

  if [[ -z "$pane_details" ]]; then
    printf 'backstage-missing\t\t0\t\t0\n'
    return 0
  fi

  while IFS=$'\t' read -r pane_id pane_title pane_dead _pane_cmd _start_cmd; do
    [[ -n "$pane_id" ]] || continue
    pane_count=$((pane_count + 1))
    if [[ "$pane_title" == "$WAVEMILL_BACKSTAGE_TEND_PANE_TITLE" && "$pane_dead" != "1" ]]; then
      tend_alive=1
      tend_count=$((tend_count + 1))
      [[ -n "$executor_pane_id" ]] || executor_pane_id="$pane_id"
    fi
    if [[ "$pane_title" == "$WAVEMILL_BACKSTAGE_JOBS_PANE_TITLE" || "$pane_title" == "$WAVEMILL_BACKSTAGE_QUEUE_PANE_TITLE" ]]; then
      status_panes=$((status_panes + 1))
    fi
  done <<< "$pane_details"

  if (( tend_alive == 1 )); then
    heartbeat_at="$(read_backstage_service_health_field "tend" '.heartbeatAt' || true)"
    if [[ -n "$heartbeat_at" ]]; then
      heartbeat_epoch="$(wavemill_iso8601_to_epoch "$heartbeat_at" 2>/dev/null || echo 0)"
      if (( heartbeat_epoch > 0 )); then
        heartbeat_age=$(( now - heartbeat_epoch ))
        if (( heartbeat_age > stale_seconds )); then
          printf 'stalled\ttend heartbeat is stale (%ss old)\t%s\t%s\t%s\n' "$heartbeat_age" "$pane_count" "$executor_pane_id" "$tend_count"
          return 0
        fi
      fi
    else
      updated_at="$(read_backstage_service_health_field "tend" '.updatedAt' || read_backstage_health_field '.updatedAt' || true)"
      if [[ -n "$updated_at" ]]; then
        updated_epoch="$(wavemill_iso8601_to_epoch "$updated_at" 2>/dev/null || echo 0)"
        if (( updated_epoch > 0 )); then
          updated_age=$(( now - updated_epoch ))
          if (( updated_age > stale_seconds )); then
            printf 'stalled\ttend heartbeat is missing and health update is stale (%ss old)\t%s\t%s\t%s\n' "$updated_age" "$pane_count" "$executor_pane_id" "$tend_count"
            return 0
          fi
        fi
      fi
    fi

    hold_detail="$(classify_ready_watchdog_hold_health "$now" "$hold_stale_seconds" || true)"
    if [[ -n "$hold_detail" ]]; then
      printf 'stalled\t%s\t%s\t%s\t%s\n' "$hold_detail" "$pane_count" "$executor_pane_id" "$tend_count"
      return 0
    fi

    printf 'healthy\tbackstage tend loop is running\t%s\t%s\t%s\n' "$pane_count" "$executor_pane_id" "$tend_count"
    return 0
  fi

  if (( status_panes > 0 )); then
    printf 'missing-tend-loop\tbackstage window is missing the %s executor pane while status panes remain\t%s\t\t0\n' "$WAVEMILL_BACKSTAGE_TEND_PANE_TITLE" "$pane_count"
    return 0
  fi

  printf 'backstage-missing\tbackstage window is unavailable\t%s\t\t0\n' "$pane_count"
}

restart_backstage_tend_loop() {
  local target_pane_id="${1:-}" integration_cmd result new_pane action _killed
  integration_cmd="$(wavemill_build_tend_loop_command "$SESSION" "$REPO_DIR" "$TOOLS_DIR" "integration")"
  if [[ -n "$target_pane_id" ]]; then
    if ! tmux respawn-pane -k -t "$target_pane_id" -c "$REPO_DIR" "$integration_cmd" 2>/dev/null; then
      return 1
    fi
    wavemill_set_tmux_pane_title "$target_pane_id" "$WAVEMILL_BACKSTAGE_TEND_PANE_TITLE"
    wavemill_capture_tend_pane_output "$target_pane_id" "$SESSION" "$REPO_DIR"
    printf '%s\n' "$target_pane_id"
    return 0
  fi
  result="$(wavemill_reconcile_backstage_service_pane "$SESSION" "$WAVEMILL_WINDOW_BACKSTAGE" "$WAVEMILL_BACKSTAGE_TEND_PANE_TITLE" "$integration_cmd" "restart" "$SESSION:$WAVEMILL_WINDOW_BACKSTAGE.0" -d -h -b -p 60 -c "$REPO_DIR" || true)"
  IFS=$'\t' read -r new_pane action _killed <<< "$result"
  [[ -n "$new_pane" ]] || return 1
  wavemill_capture_tend_pane_output "$new_pane" "$SESSION" "$REPO_DIR"
  tmux select-layout -t "$SESSION:$WAVEMILL_WINDOW_BACKSTAGE" main-vertical >/dev/null 2>&1 || true
  printf '%s\n' "$new_pane"
}

backstage_tend_restart_confirmed() {
  local prior_heartbeat="${1:-}" restart_epoch="${2:?restart epoch required}" expected_pane="${3:-}"
  local deadline now pane_probe pane_summary pane_status _detail _pane_count executor_pane_id _tend_count heartbeat_at heartbeat_epoch

  deadline=$(( $(date +%s) + BACKSTAGE_TEND_RESTART_CONFIRM_SECONDS ))
  while (( $(date +%s) <= deadline )); do
    pane_probe="$(probe_backstage_panes 2>/dev/null || true)"
    pane_summary="$(classify_backstage_health "$pane_probe")"
    IFS=$'\t' read -r pane_status _detail _pane_count executor_pane_id _tend_count <<< "$pane_summary"
    if [[ "$pane_status" == "healthy" && ( -z "$expected_pane" || "$executor_pane_id" == "$expected_pane" ) ]]; then
      heartbeat_at="$(read_backstage_service_health_field "tend" '.heartbeatAt' || true)"
      heartbeat_epoch="$(wavemill_iso8601_to_epoch "$heartbeat_at" 2>/dev/null || echo 0)"
      if [[ -n "$heartbeat_at" && "$heartbeat_at" != "$prior_heartbeat" && "$heartbeat_epoch" =~ ^[0-9]+$ ]] && (( heartbeat_epoch >= restart_epoch )); then
        printf '%s\n' "$heartbeat_at"
        return 0
      fi
    fi
    sleep 0.25
  done
  return 1
}

backstage_tend_restart_diagnostic() {
  local log_file="$REPO_DIR/.wavemill/logs/tend-${SESSION}.log"
  local detail

  detail="$(tail -n 1 "$log_file" 2>/dev/null | tr '\n' ' ' | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//')"
  [[ -n "$detail" ]] || detail="no tend output was captured"
  printf '%s\n' "$detail"
}

observer_health_enabled() {
  local merged enabled use_mill_session
  merged="$(wavemill_load_config "$REPO_DIR")"
  enabled="$(printf '%s' "$merged" | jq -r '.integration.enabled // false' 2>/dev/null || echo false)"
  use_mill_session="$(printf '%s' "$merged" | jq -r '.integration.useMillSession // true' 2>/dev/null || echo true)"
  [[ "$enabled" == "true" && "$use_mill_session" == "true" ]] || return 1
  wavemill_observer_config_enabled "$merged"
}

classify_backstage_observer_health() {
  local pane_details="${1-}" now="${2:-$(date +%s)}" stale_seconds="${3:-300}"
  local pane_count=0 observer_count=0 observer_pane_id="" heartbeat_at="" heartbeat_epoch=0 heartbeat_age=""
  local pane_id pane_title pane_dead _pane_cmd _start_cmd

  if [[ -z "$pane_details" ]]; then
    printf 'backstage-missing\tbackstage window is unavailable\t0\t\t\t0\n'
    return 0
  fi

  while IFS=$'\t' read -r pane_id pane_title pane_dead _pane_cmd _start_cmd; do
    [[ -n "$pane_id" ]] || continue
    pane_count=$((pane_count + 1))
    if [[ "$pane_title" == "$WAVEMILL_BACKSTAGE_OBSERVER_PANE_TITLE" && "$pane_dead" != "1" ]]; then
      observer_count=$((observer_count + 1))
      [[ -n "$observer_pane_id" ]] || observer_pane_id="$pane_id"
    fi
  done <<< "$pane_details"

  if (( observer_count == 0 )); then
    printf 'missing-observer-loop\tbackstage window is missing the %s pane\t%s\t\t\t0\n' "$WAVEMILL_BACKSTAGE_OBSERVER_PANE_TITLE" "$pane_count"
    return 0
  fi

  heartbeat_at="$(read_backstage_service_health_field "observer" '.heartbeatAt' || true)"
  if [[ -n "$heartbeat_at" ]]; then
    heartbeat_epoch="$(wavemill_iso8601_to_epoch "$heartbeat_at" 2>/dev/null || echo 0)"
    if (( heartbeat_epoch > 0 )); then
      heartbeat_age=$(( now - heartbeat_epoch ))
      if (( heartbeat_age > stale_seconds )); then
        printf 'stale-observer-heartbeat\tobserver heartbeat is stale (%ss old)\t%s\t%s\t%s\t%s\n' "$heartbeat_age" "$pane_count" "$observer_pane_id" "$heartbeat_at" "$observer_count"
        return 0
      fi
    fi
  fi

  printf 'healthy\tbackstage observer loop is running\t%s\t%s\t%s\t%s\n' "$pane_count" "$observer_pane_id" "$heartbeat_at" "$observer_count"
}

restart_backstage_observer_loop() {
  local merged observer_interval observer_max_log_lines observer_cmd result new_pane action _killed
  merged="$(wavemill_load_config "$REPO_DIR")"
  observer_interval="$(wavemill_observer_interval_seconds "$merged")"
  observer_max_log_lines="$(wavemill_observer_max_log_lines "$merged")"
  observer_cmd="$(wavemill_build_observer_loop_command "$SESSION" "$REPO_DIR" "$TOOLS_DIR" "$observer_interval" "$observer_max_log_lines")"
  result="$(wavemill_reconcile_backstage_service_pane "$SESSION" "$WAVEMILL_WINDOW_BACKSTAGE" "$WAVEMILL_BACKSTAGE_OBSERVER_PANE_TITLE" "$observer_cmd" "restart" "$SESSION:$WAVEMILL_WINDOW_BACKSTAGE.0" -d -v -p 25 -c "$REPO_DIR" || true)"
  IFS=$'\t' read -r new_pane action _killed <<< "$result"
  [[ -n "$new_pane" ]] || return 1
  if [[ "$action" == "created" ]]; then
    tmux select-layout -t "$SESSION:$WAVEMILL_WINDOW_BACKSTAGE" tiled >/dev/null 2>&1 || true
  fi
  printf '%s\n' "$new_pane"
}

check_backstage_observer_health() {
  local now health_file merged stale_seconds pane_probe pane_summary pane_status detail pane_count observer_pane_id heartbeat_at observer_count
  local prior_attempt_at prior_attempt_count elapsed restart_pane_id observer_cmd observer_interval observer_max_log_lines
  local reconcile_result _reconcile_pane _reconcile_action _reconcile_killed

  now=$(date +%s)
  (( now - LAST_BACKSTAGE_OBSERVER_HEALTH_CHECK < BACKSTAGE_HEALTH_INTERVAL )) && return 0
  LAST_BACKSTAGE_OBSERVER_HEALTH_CHECK=$now

  if ! observer_health_enabled; then
    LAST_BACKSTAGE_OBSERVER_HEALTH_STATUS="disabled"
    return 0
  fi

  health_file="$(wavemill_backstage_health_file "$STATE_DIR" 2>/dev/null || true)"
  merged="$(wavemill_load_config "$REPO_DIR")"
  stale_seconds="$(wavemill_observer_heartbeat_stale_seconds "$merged")"
  pane_probe="$(probe_backstage_panes 2>/dev/null || true)"
  pane_summary="$(classify_backstage_observer_health "$pane_probe" "$now" "$stale_seconds")"
  IFS=$'\t' read -r pane_status detail pane_count observer_pane_id heartbeat_at observer_count <<< "$pane_summary"
  [[ "$observer_count" =~ ^[0-9]+$ ]] || observer_count=0

  if [[ "$pane_status" == "healthy" ]] && (( observer_count > 1 )); then
    observer_interval="$(wavemill_observer_interval_seconds "$merged")"
    observer_max_log_lines="$(wavemill_observer_max_log_lines "$merged")"
    observer_cmd="$(wavemill_build_observer_loop_command "$SESSION" "$REPO_DIR" "$TOOLS_DIR" "$observer_interval" "$observer_max_log_lines")"
    reconcile_result="$(wavemill_reconcile_backstage_service_pane "$SESSION" "$WAVEMILL_WINDOW_BACKSTAGE" "$WAVEMILL_BACKSTAGE_OBSERVER_PANE_TITLE" "$observer_cmd" "reuse" "$SESSION:$WAVEMILL_WINDOW_BACKSTAGE.0" -d -v -p 25 -c "$REPO_DIR" || true)"
    IFS=$'\t' read -r _reconcile_pane _reconcile_action _reconcile_killed <<< "$reconcile_result"
    log_warn "Backstage observer had ${observer_count} duplicate panes, reconciled to one"
    sleep 0.3
    pane_probe="$(probe_backstage_panes 2>/dev/null || true)"
    pane_summary="$(classify_backstage_observer_health "$pane_probe" "$(date +%s)" "$stale_seconds")"
    IFS=$'\t' read -r pane_status detail pane_count observer_pane_id heartbeat_at observer_count <<< "$pane_summary"
    [[ "$observer_count" =~ ^[0-9]+$ ]] || observer_count=0
  fi

  case "$pane_status" in
    healthy)
      [[ -n "$health_file" ]] && wavemill_write_backstage_service_health "$health_file" "observer" "healthy" "$detail" 0 "" "$observer_pane_id" "$heartbeat_at" "$observer_count"
      LAST_BACKSTAGE_OBSERVER_HEALTH_STATUS="healthy"
      return 0
      ;;
    'backstage-missing')
      [[ -n "$health_file" ]] && wavemill_write_backstage_service_health "$health_file" "observer" "backstage-missing" "$detail" 0 "" "" "" 0
      LAST_BACKSTAGE_OBSERVER_HEALTH_STATUS="backstage-missing"
      return 0
      ;;
  esac

  prior_attempt_at="$(read_backstage_service_health_field "observer" '.lastRestartAttemptAt' || true)"
  prior_attempt_count="$(read_backstage_service_health_field "observer" '.restartAttemptCount' || true)"
  [[ "$prior_attempt_count" =~ ^[0-9]+$ ]] || prior_attempt_count=0
  elapsed=$BACKSTAGE_RESTART_COOLDOWN
  if [[ -n "$prior_attempt_at" ]]; then
    local prior_attempt_epoch=0
    prior_attempt_epoch="$(wavemill_iso8601_to_epoch "$prior_attempt_at" 2>/dev/null || echo 0)"
    elapsed=$(( now - prior_attempt_epoch ))
  fi

  if (( prior_attempt_count == 0 )); then
    if [[ "$LAST_BACKSTAGE_OBSERVER_HEALTH_STATUS" != "$pane_status" ]]; then
      log_warn "Backstage health check detected an unhealthy observer ($pane_status). Attempting one restart in '$WAVEMILL_WINDOW_BACKSTAGE'."
    fi
    restart_pane_id="$(restart_backstage_observer_loop || true)"
    sleep 0.3
    pane_probe="$(probe_backstage_panes 2>/dev/null || true)"
    pane_summary="$(classify_backstage_observer_health "$pane_probe" "$(date +%s)" "$stale_seconds")"
    IFS=$'\t' read -r pane_status detail pane_count observer_pane_id heartbeat_at observer_count <<< "$pane_summary"
    [[ "$observer_count" =~ ^[0-9]+$ ]] || observer_count=0
    if [[ "$pane_status" == "healthy" ]]; then
      [[ -n "$health_file" ]] && wavemill_write_backstage_service_health "$health_file" "observer" "healthy" "backstage observer loop was restarted automatically" 0 "" "${observer_pane_id:-$restart_pane_id}" "$heartbeat_at" "$observer_count"
      log "status" "Backstage observer loop restarted"
      LAST_BACKSTAGE_OBSERVER_HEALTH_STATUS="healthy"
      return 0
    fi
    [[ -n "$health_file" ]] && wavemill_write_backstage_service_health "$health_file" "observer" "$pane_status" "$detail" 1 "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "${observer_pane_id:-$restart_pane_id}" "$heartbeat_at" "$observer_count"
    LAST_BACKSTAGE_OBSERVER_HEALTH_STATUS="$pane_status"
    return 0
  fi

  if (( elapsed < BACKSTAGE_RESTART_COOLDOWN )); then
    [[ -n "$health_file" ]] && wavemill_write_backstage_service_health "$health_file" "observer" "$pane_status" "$detail" "$prior_attempt_count" "$prior_attempt_at" "$observer_pane_id" "$heartbeat_at" "$observer_count"
    LAST_BACKSTAGE_OBSERVER_HEALTH_STATUS="$pane_status"
    return 0
  fi

  detail="Backstage window '$WAVEMILL_WINDOW_BACKSTAGE' observer service needs user attention. Restart 'npx tsx tools/observer.ts --loop --json --dry-run --repo-dir $REPO_DIR --session $SESSION' in tmux."
  [[ -n "$health_file" ]] && wavemill_write_backstage_service_health "$health_file" "observer" "needs-user" "$detail" "$prior_attempt_count" "$prior_attempt_at" "$observer_pane_id" "$heartbeat_at" "$observer_count"
  if [[ "$LAST_BACKSTAGE_OBSERVER_HEALTH_STATUS" != "needs-user" ]]; then
    log_warn "$detail"
  fi
  LAST_BACKSTAGE_OBSERVER_HEALTH_STATUS="needs-user"
}

check_backstage_health() {
  local now health_file pane_probe pane_summary pane_status detail pane_count executor_pane_id tend_count heartbeat_at
  local prior_attempt_at prior_attempt_count elapsed restart_pane_id prior_heartbeat restart_error
  local prior_attempt_epoch heartbeat_epoch backoff remaining next_attempt_count status next_backoff attempt_at

  now=$(date +%s)
  (( now - LAST_BACKSTAGE_HEALTH_CHECK < BACKSTAGE_HEALTH_INTERVAL )) && return 0
  LAST_BACKSTAGE_HEALTH_CHECK=$now

  health_file="$(wavemill_backstage_health_file "$STATE_DIR" 2>/dev/null || true)"
  if ! backstage_health_enabled; then
    [[ -n "$health_file" ]] && wavemill_write_backstage_health "$health_file" "disabled" "integration mill-session backstage health checks are disabled"
    LAST_BACKSTAGE_HEALTH_STATUS="disabled"
    return 0
  fi

  pane_probe="$(probe_backstage_panes 2>/dev/null || true)"
  pane_summary="$(classify_backstage_health "$pane_probe")"
  IFS=$'\t' read -r pane_status detail pane_count executor_pane_id tend_count <<< "$pane_summary"
  [[ "$tend_count" =~ ^[0-9]+$ ]] || tend_count=0

  prior_attempt_at="$(read_backstage_health_field '.lastRestartAttemptAt' || true)"
  prior_attempt_count="$(read_backstage_health_field '.restartAttemptCount' || true)"
  [[ "$prior_attempt_count" =~ ^[0-9]+$ ]] || prior_attempt_count=0
  prior_attempt_epoch=0
  elapsed="$BACKSTAGE_RESTART_COOLDOWN"
  if [[ -n "$prior_attempt_at" ]]; then
    prior_attempt_epoch="$(wavemill_iso8601_to_epoch "$prior_attempt_at" 2>/dev/null || echo 0)"
    [[ "$prior_attempt_epoch" =~ ^[0-9]+$ ]] || prior_attempt_epoch=0
    if (( prior_attempt_epoch > 0 )); then
      elapsed=$(( now - prior_attempt_epoch ))
    fi
  fi

  if (( prior_attempt_count > 0 && elapsed < BACKSTAGE_TEND_RESTART_GRACE_SECONDS )) && [[ -n "$executor_pane_id" && ( "$pane_status" == "healthy" || "$pane_status" == "stalled" ) ]]; then
    heartbeat_at="$(read_backstage_service_health_field "tend" '.heartbeatAt' || true)"
    heartbeat_epoch="$(wavemill_iso8601_to_epoch "$heartbeat_at" 2>/dev/null || echo 0)"
    [[ "$heartbeat_epoch" =~ ^[0-9]+$ ]] || heartbeat_epoch=0
    if (( prior_attempt_epoch == 0 || heartbeat_epoch <= prior_attempt_epoch )); then
      detail="Backstage tend restart attempt ${prior_attempt_count} is pending: pane ${executor_pane_id} is alive, awaiting first heartbeat (${elapsed}s elapsed). Restart 'npx tsx tools/tend.ts --loop --repo-dir $REPO_DIR' in tmux."
      [[ -n "$health_file" ]] && wavemill_write_backstage_health "$health_file" "missing-tend-loop" "$detail" "$prior_attempt_count" "$prior_attempt_at" "$executor_pane_id" "$tend_count"
      LAST_BACKSTAGE_HEALTH_STATUS="missing-tend-loop"
      return 0
    fi
  fi

  case "$pane_status" in
    healthy)
      heartbeat_at="$(read_backstage_service_health_field "tend" '.heartbeatAt' || true)"
      [[ -n "$health_file" ]] && wavemill_write_backstage_service_health "$health_file" "tend" "healthy" "$detail" 0 "" "$executor_pane_id" "$heartbeat_at" "$tend_count"
      if (( prior_attempt_count > 0 )); then
        log "status" "Backstage tend loop restart confirmed by heartbeat"
      fi
      LAST_BACKSTAGE_HEALTH_STATUS="healthy"
      return 0
      ;;
    'backstage-missing')
      [[ -n "$health_file" ]] && wavemill_write_backstage_health "$health_file" "backstage-missing" "$detail" 0 "" "" 0
      if [[ "$LAST_BACKSTAGE_HEALTH_STATUS" != "backstage-missing" ]]; then
        log_warn "Backstage health check could not find the backstage window."
      fi
      LAST_BACKSTAGE_HEALTH_STATUS="backstage-missing"
      return 0
      ;;
  esac

  backoff="$(backstage_restart_backoff_seconds "$prior_attempt_count")"
  if (( prior_attempt_count > 0 && elapsed < backoff )); then
    remaining=$(( backoff - elapsed ))
    status="$pane_status"
    [[ "$status" == "stalled" ]] || status="missing-tend-loop"
    (( prior_attempt_count >= BACKSTAGE_RESTART_NEEDS_USER_AFTER_ATTEMPTS )) && status="needs-user"
    if [[ "$pane_status" == "stalled" ]]; then
      detail="Backstage tend loop is stalled (restart attempt ${prior_attempt_count} unconfirmed: $detail); next automatic restart in ${remaining}s. Restart 'npx tsx tools/tend.ts --loop --repo-dir $REPO_DIR' in tmux."
    else
      detail="Backstage window '$WAVEMILL_WINDOW_BACKSTAGE' is missing the ${WAVEMILL_BACKSTAGE_TEND_PANE_TITLE} executor (restart attempt ${prior_attempt_count} unconfirmed: $detail); next automatic restart in ${remaining}s. Restart 'npx tsx tools/tend.ts --loop --repo-dir $REPO_DIR' in tmux."
    fi
    [[ -n "$health_file" ]] && wavemill_write_backstage_health "$health_file" "$status" "$detail" "$prior_attempt_count" "$prior_attempt_at" "$executor_pane_id" "$tend_count"
    if [[ "$LAST_BACKSTAGE_HEALTH_STATUS" != "$status" ]]; then
      log_warn "$detail"
    fi
    LAST_BACKSTAGE_HEALTH_STATUS="$status"
    return 0
  fi

  next_attempt_count=$(( prior_attempt_count + 1 ))
  if [[ "$pane_status" == "stalled" ]]; then
    log_warn "Backstage health check detected a stalled tend loop. Attempting respawn (attempt ${next_attempt_count}) in '$WAVEMILL_WINDOW_BACKSTAGE'."
  else
    log_warn "Backstage health check detected a missing tend loop. Attempting restart (attempt ${next_attempt_count}) in '$WAVEMILL_WINDOW_BACKSTAGE'."
  fi
  prior_heartbeat="$(read_backstage_service_health_field "tend" '.heartbeatAt' || true)"
  if [[ "$pane_status" == "stalled" && -n "$executor_pane_id" ]]; then
    restart_pane_id="$(restart_backstage_tend_loop "$executor_pane_id" || true)"
  else
    restart_pane_id="$(restart_backstage_tend_loop || true)"
  fi
  if [[ -n "$restart_pane_id" ]] && heartbeat_at="$(backstage_tend_restart_confirmed "$prior_heartbeat" "$now" "$restart_pane_id")"; then
    [[ -n "$health_file" ]] && wavemill_write_backstage_service_health "$health_file" "tend" "healthy" "backstage tend loop was restarted automatically" 0 "" "${executor_pane_id:-$restart_pane_id}" "$heartbeat_at" 1
    log "status" "Backstage tend loop restart confirmed by heartbeat"
    LAST_BACKSTAGE_HEALTH_STATUS="healthy"
    return 0
  fi

  restart_error="$(backstage_tend_restart_diagnostic)"
  attempt_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  next_backoff="$(backstage_restart_backoff_seconds "$next_attempt_count")"
  status="$pane_status"
  [[ "$status" == "stalled" ]] || status="missing-tend-loop"
  (( next_attempt_count >= BACKSTAGE_RESTART_NEEDS_USER_AFTER_ATTEMPTS )) && status="needs-user"
  if [[ -n "$restart_pane_id" ]]; then
    detail="Backstage tend restart attempt ${next_attempt_count} did not produce a fresh heartbeat within ${BACKSTAGE_TEND_RESTART_CONFIRM_SECONDS}s: $restart_error. Watching the new pane for ${BACKSTAGE_TEND_RESTART_GRACE_SECONDS}s and retrying no earlier than ${next_backoff}s after that. Restart 'npx tsx tools/tend.ts --loop --repo-dir $REPO_DIR' in tmux."
  else
    detail="Backstage tend restart attempt ${next_attempt_count} could not split a backstage pane: $restart_error. Retrying no earlier than ${next_backoff}s. Restart 'npx tsx tools/tend.ts --loop --repo-dir $REPO_DIR' in tmux."
  fi
  local restart_instance_count="$tend_count"
  [[ -n "$restart_pane_id" ]] && restart_instance_count=1
  [[ -n "$health_file" ]] && wavemill_write_backstage_health "$health_file" "$status" "$detail" "$next_attempt_count" "$attempt_at" "${restart_pane_id:-$executor_pane_id}" "$restart_instance_count"
  LAST_BACKSTAGE_HEALTH_STATUS="$status"
}

while :; do
  # ── Phase A: Monitor existing tasks ──────────────────────────────────
  _update_effective_max_parallel
  run_linear_retry_drain_tick
  drain_command_events
  while consume_next_command; do
    case "$REPLY" in
      quit)
        handle_monitor_quit_command "${_active_count_prev}"
        ;;
      *)
        requeue_consumed_command_front
        break
        ;;
    esac
  done
  poll_challenge_jobs
  check_backstage_health
  check_backstage_observer_health || true
  run_ready_watchdog_tick
  check_mill_pane_health
  wavemill_pr_cache_refresh
  refresh_ready_merge_queue_tick
  active_count=0
  active_challenger_count=0
  queue_owned_count=0

  for ISSUE in "${!BRANCH_BY_ISSUE[@]}"; do
    [[ -n "${CLEANED[$ISSUE]:-}" ]] && continue
    set +e
    monitor_issue_state "$ISSUE"
    issue_rc=$?
    set -e
    if (( issue_rc != 0 )); then
      log_warn "$ISSUE → Monitor step failed (exit $issue_rc). Keeping slot active."
      active_count=$((active_count + 1))
    fi
    # Track active challengers separately (they are free overhead for slot counting)
    _cr=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].challengeRole // ""')
    if [[ "$_cr" == "challenger" ]] && [[ -z "${CLEANED[$ISSUE]:-}" ]]; then
      active_challenger_count=$((active_challenger_count + 1))
    fi
  done
  if declare -F slot_consuming_task_count >/dev/null 2>&1; then
    active_count="$(slot_consuming_task_count)"
    active_challenger_count="$(slot_consuming_challenger_task_count)"
  fi
  _active_count_prev=$active_count

  # ── Phase B: Check for stop signal ──────────────────────────────────
  if [[ -f "$STATE_DIR/.stop-loop" ]]; then
    if (( active_count == 0 )); then
      rm -f "$STATE_DIR/.stop-loop"
      quit_and_kill_session "Stop signal detected and all tasks complete. Exiting."
    fi
    log "status" "Stop signal detected. Finishing $active_count active task(s)..."
    poll_sleep "$POLL_SECONDS"
    continue
  fi

  if [[ "$QUIT_REQUESTED" == "true" ]]; then
    if (( active_count == 0 )); then
      quit_and_kill_session "All tasks complete. Exiting."
    fi
    # Still have active tasks — keep monitoring but accept 'q' for force-quit
    if consume_next_command; then
      if [[ "$REPLY" == "quit" ]]; then
        handle_monitor_quit_command "$active_count"
      fi
    fi
    poll_sleep "$POLL_SECONDS"
    continue
  fi

  # ── Phase C: Offer new tasks if slots available ─────────────────────
  # Challengers are free overhead — don't count them against MAX_PARALLEL
  free_slots=$((EFFECTIVE_MAX_PARALLEL - (active_count - active_challenger_count)))
  update_free_slots_state "$free_slots"

  if (( free_slots <= 0 )); then
    refresh_backlog_cache
    candidates=$(print_cached_candidates)
    available=""
    [[ -n "$candidates" ]] && available=$(filter_active_issues "$candidates")

    display_fingerprint="slots-full|${active_count}|${available}"
    if [[ "$display_fingerprint" != "$LAST_DISPLAY" ]] || (( active_count != LAST_ACTIVE_COUNT )); then
      _task_frame="Next tasks (slots full):"$'\n'
      if [[ -n "$available" ]]; then
        _task_frame+="$(echo "$available" | head -9 | awk -F'|' '{printf "  %s. %s - %s (score: %.0f)\n", NR, $1, $3, $5}')"
      elif [[ -n "$candidates" ]]; then
        _task_frame+="  (all listed backlog tasks are already active)"$'\n'
      else
        _task_frame+="  (backlog empty)"$'\n'
      fi
      _task_frame+=$'\n'"0 slots available; waiting for active tasks to finish. Press 'q' to quit or wait ${POLL_SECONDS}s to refresh."$'\n'

      paint_task_list_frame "$_task_frame"
      LAST_DISPLAY="$display_fingerprint"
      LAST_ACTIVE_COUNT=$active_count
      LAST_WAITING_MSG=""
    fi

    poll_sleep "$POLL_SECONDS"
    continue
  fi

  if (( free_slots > 0 )); then
    refresh_backlog_cache
    candidates=$(print_cached_candidates)

    if [[ -n "$candidates" ]]; then
      available=$(filter_active_issues "$candidates")

      if [[ -n "$available" ]]; then
        # Split into unblocked and blocked
        # Field 6 is blocked_by_count (has_detailed_plan stripped by fetch_candidates)
        avail_unblocked=$(echo "$available" | awk -F'|' '$6 == 0 || $6 == ""')
        avail_blocked=$(echo "$available" | awk -F'|' '$6 > 0')
        avail_blocked_count=0
        [[ -n "$avail_blocked" ]] && avail_blocked_count=$(echo "$avail_blocked" | grep -c .)

        # Only re-render the prompt when the display would actually change
        queue_fp="${QUEUE_PLAN_CACHE:0:50}"
        display_fingerprint="${free_slots}|${avail_unblocked}|${avail_blocked_count}|${queue_fp}|${_backlog_budget:-}|${_backlog_expanded:-}|${_deps_expanded:-}"
        if [[ "$display_fingerprint" != "$LAST_DISPLAY" ]] || (( active_count != LAST_ACTIVE_COUNT )); then
          SELECT_SHOW_ALL=false

          # Gather data first so old content stays visible during queue analysis.
          queue_plan_json=""
          queue_plan_diag_file=""
          queue_plan_diag_previous="${FETCH_QUEUE_PLAN_DIAGNOSTICS_FILE:-}"
          queue_plan_diag_file="$(mktemp -t wavemill-fqp-diagnostics.XXXXXX 2>/dev/null || true)"
          FETCH_QUEUE_PLAN_DIAGNOSTICS_FILE="$queue_plan_diag_file"
          GROUPED_DISPLAY=""
          GROUPED_SELECT_FROM=""
          _backlog_default_expanded="$(wavemill_load_config "$REPO_DIR" | jq -r '.backlog.defaultExpanded // false' 2>/dev/null || echo "false")"
          _backlog_expanded="$(jq -r --arg def "$_backlog_default_expanded" '.backlogExpanded // $def' "$STATE_FILE" 2>/dev/null || echo "$_backlog_default_expanded")"
          _deps_expanded="$(jq -r --arg def "false" '.depsExpanded // $def' "$STATE_FILE" 2>/dev/null || echo "false")"
          _backlog_budget="$(wavemill_backlog_compute_budget "$SESSION" "$WAVEMILL_WINDOW_MILL.0" "$REPO_DIR/.wavemill-config.json" 2>/dev/null || echo 20)"
          _active_issue_ids=""
          for _ai in "${!BRANCH_BY_ISSUE[@]}"; do
            [[ -n "${CLEANED[$_ai]:-}" ]] && continue
            _active_issue_ids+="${_ai}"$'\n'
          done

          # Check queue-health backoff before attempting planner
          queue_health_init 2>/dev/null || true
          if queue_health_should_skip_attempt 2>/dev/null; then
            # In backoff; skip planner attempt
            record_fetch_queue_plan_failure "backoff_active" ""
          elif queue_plan_json=$(fetch_queue_plan 2>/dev/null); then
            if [[ -n "$queue_plan_json" ]]; then
              QUEUE_PLAN_CACHE="$queue_plan_json"
              LAST_QUEUE_PLAN_FETCH=$(date +%s)
            fi
            render_grouped_task_list "$queue_plan_json" "$available" "$_backlog_budget" "$_backlog_expanded" "$_deps_expanded" "$_active_issue_ids" || true
            if [[ -n "$GROUPED_DISPLAY" ]]; then
              select_from="$GROUPED_SELECT_FROM"
              USING_GROUPED_VIEW=true
            fi
          fi
          if [[ -z "$GROUPED_DISPLAY" ]]; then
            USING_GROUPED_VIEW=false
            if [[ -z "$queue_plan_json" ]]; then
              _queue_reason="$(get_queue_failure_reason "${queue_plan_diag_file:-}")"
              # Deduplicate warning: only emit if episode is new
              _health_status="$(queue_health_read 2>/dev/null || echo '{}')"
              _episode_started="$(printf '%s' "$_health_status" | jq -r '.episodeStartedAt // ""' 2>/dev/null || echo '')"
              _warn_cache_file="${STATE_DIR}/.queue-warn-episode"
              _prev_episode="$(cat "$_warn_cache_file" 2>/dev/null || echo '')"
              if [[ -z "$_prev_episode" || "$_prev_episode" != "$_episode_started" ]]; then
                log_warn "queue analysis unavailable (reason: ${_queue_reason:-unknown}), falling back to flat list"
                [[ -n "$_episode_started" ]] && printf '%s' "$_episode_started" > "$_warn_cache_file" 2>/dev/null || true
              fi
              [[ -n "$queue_plan_diag_file" ]] && log_fetch_queue_plan_failure "$queue_plan_diag_file"
            fi
          fi
          queue_fp="${queue_plan_json:0:50}"
          display_fingerprint="${free_slots}|${avail_unblocked}|${avail_blocked_count}|${queue_fp}|${_backlog_budget}|${_backlog_expanded}|${_deps_expanded}"
          rm -f "$queue_plan_diag_file"
          FETCH_QUEUE_PLAN_DIAGNOSTICS_FILE="$queue_plan_diag_previous"

          _task_frame="Next tasks:"$'\n'
          if [[ -n "$GROUPED_DISPLAY" ]]; then
            _task_frame+="${GROUPED_DISPLAY}"$'\n'
          else
            if [[ -n "$avail_unblocked" ]]; then
              _task_frame+="$(echo "$avail_unblocked" | head -9 | awk -F'|' '{printf "  %s. %s - %s (score: %.0f)\n", NR, $1, $3, $5}')"
            else
              _task_frame+="  (no unblocked tasks)"$'\n'
            fi
            if (( avail_blocked_count > 0 )); then
              _task_frame+=$'\n'"  ($avail_blocked_count blocked task(s) hidden — enter 'm' to show all)"$'\n'
            fi
          fi
          _task_frame+=$'\n'
          if [[ "$USING_GROUPED_VIEW" == "true" ]]; then
            _task_frame+="Enter number(s) to start (e.g. 1 3), press Enter to launch recommended wave, 'm' for more, 'd' for deps, 'q' to quit, or wait ${POLL_SECONDS}s to refresh:"$'\n'
          elif (( avail_blocked_count > 0 )); then
            _task_frame+="Enter number(s) to start (e.g. 1 3), press Enter to launch recommended wave, 'm' for more, 'q' to quit, or wait ${POLL_SECONDS}s to refresh:"$'\n'
          else
            _task_frame+="Enter number(s) to start (e.g. 1 3), press Enter to launch recommended wave, 'q' to quit, or wait ${POLL_SECONDS}s to refresh:"$'\n'
          fi

          paint_task_list_frame "$_task_frame"
          LAST_DISPLAY="$display_fingerprint"
          LAST_ACTIVE_COUNT=$active_count
          LAST_WAITING_MSG=""  # Clear waiting state when tasks are available
        fi

        # Default: selection against unblocked list only
        select_from="$avail_unblocked"
        if [[ "$USING_GROUPED_VIEW" == "true" ]]; then
          select_from="$GROUPED_SELECT_FROM"
        elif [[ "$SELECT_SHOW_ALL" == "true" ]]; then
          select_from=$(printf '%s\n%s' "$avail_unblocked" "$avail_blocked" | grep .)
        fi

        REPLY=""
        MONITOR_PHASE_C_REPLY_OFFSET=""
        if consume_next_command; then
          MONITOR_PHASE_C_REPLY_OFFSET="${REPLY_OFFSET:-}"
          REPLY="$(normalize_prompt_command_reply "$REPLY")"
        fi

        if [[ "$REPLY" =~ ^[Qq]$ ]]; then
          handle_monitor_quit_command "$active_count"
        elif [[ "$REPLY" =~ ^[mM]$ ]]; then
          if [[ "$USING_GROUPED_VIEW" == "true" ]]; then
            state_mutate "$STATE_FILE" \
              '.backlogExpanded = (if (.backlogExpanded // false) then false else true end) | .updated = (now | todate)'
            LAST_DISPLAY=""
          else
            clear_task_list_display
            all_avail=$(printf '%s\n%s' "$avail_unblocked" "$avail_blocked" | grep .)
            echo ""
            log "info" "All tasks:"
            ln=0
            while IFS= read -r mline; do
              ln=$((ln + 1))
              IFS='|' read -r mid mslug mtitle marea mscore mblocked <<<"$mline"
              if (( mblocked > 0 )); then
                printf "  %s. %s - %s (score: %.0f) [blocked]\n" "$ln" "$mid" "$mtitle" "$mscore"
              else
                printf "  %s. %s - %s (score: %.0f)\n" "$ln" "$mid" "$mtitle" "$mscore"
              fi
            done <<<"$all_avail"
            echo ""
            echo "Enter number(s) to start (e.g. 1 3), 'q' to quit, or wait ${POLL_SECONDS}s to refresh:"
            SELECT_SHOW_ALL=true
          fi
        elif [[ "$REPLY" =~ ^[dD]$ ]]; then
          if [[ "$USING_GROUPED_VIEW" == "true" ]]; then
            state_mutate "$STATE_FILE" \
              '.depsExpanded = (if (.depsExpanded // false) then false else true end) | .updated = (now | todate)'
            LAST_DISPLAY=""
          fi
        elif [[ "$REPLY" == advance\ * ]]; then
          execute_or_defer_monitor_command "new" "$REPLY" "$MONITOR_PHASE_C_REPLY_OFFSET" "$free_slots" "$queue_plan_json" "$avail_unblocked" "$avail_blocked" "$select_from"
          MONITOR_PHASE_C_REPLY_OFFSET=""
        elif [[ "$REPLY" =~ ^unknown\  ]]; then
          log_warn "Unknown input: ${REPLY#unknown }"
        elif [[ "$REPLY" == "enter" ]]; then
          if [[ "${ENTER_LAUNCHES_WAVE:-true}" == "true" ]]; then
            wave_plan_json="${queue_plan_json:-$QUEUE_PLAN_CACHE}"
            if [[ -n "$wave_plan_json" ]]; then
              wave_result=$(invoke_first_wave_helper "$wave_plan_json" "$avail_unblocked" "$free_slots" 2>/dev/null) || wave_result=""
            else
              wave_result=""
            fi
            if [[ -n "$wave_result" ]]; then
              wave_ids=$(jq -r '.wave[]?' <<<"$wave_result" 2>/dev/null) || wave_ids=""
              deferred_ids=$(jq -r '.deferred[]?' <<<"$wave_result" 2>/dev/null) || deferred_ids=""
              if [[ -z "$wave_ids" ]]; then
                log "status" "No tasks currently available, waiting on dependencies."
              else
                [[ -n "$deferred_ids" ]] && log "debug" "[wave-launch] deferred=$(tr '\n' ',' <<<"$deferred_ids" | sed 's/,$//')"
                wave_selected_lines=""
                while IFS= read -r wid; do
                  [[ -z "$wid" ]] && continue
                  wline=$(grep -m1 "^${wid}|" <<<"$avail_unblocked" 2>/dev/null || echo "")
                  [[ -n "$wline" ]] && wave_selected_lines+="${wline}"$'\n'
                done <<<"$wave_ids"
                if [[ -n "$wave_selected_lines" ]]; then
                  launched=0
                  while IFS= read -r local_line; do
                    [[ -z "$local_line" ]] && continue
                    (( launched >= free_slots )) && break
                    IFS='|' read -r sel_issue sel_slug sel_title _rest <<<"$local_line"
                    dispatch_task_and_persist "$sel_issue" "$sel_slug" "$sel_title" "$((free_slots - launched))"
                    launched=$((launched + LAST_LAUNCHED_SLOTS))
                  done <<<"$wave_selected_lines"
                  LAST_BACKLOG_FETCH=0; LAST_DISPLAY=""; SELECT_SHOW_ALL=false
                  USING_GROUPED_VIEW=false
                  clear_task_list_display
                fi
              fi
            fi
          fi
        elif [[ -n "$REPLY" ]]; then
          if [[ "$USING_GROUPED_VIEW" == "true" ]]; then
            select_from="$GROUPED_SELECT_FROM"
          elif [[ "$SELECT_SHOW_ALL" == "true" ]]; then
            select_from=$(printf '%s\n%s' "$avail_unblocked" "$avail_blocked" | grep .)
          fi
          # Parse user selection and launch tasks (up to free_slots)
          launched=0
          selected_lines=""
          for n in $REPLY; do
            # Validate n is a positive integer to prevent sed injection
            if ! [[ "$n" =~ ^[0-9]+$ ]] || (( n == 0 )); then
              log_warn "Invalid selection: $n (must be a number)"
              continue
            fi
            if (( launched >= free_slots )); then
              log_warn "No more free slots — skipping remaining selections"
              break
            fi
            local_line=$(echo "$select_from" | sed -n "${n}p")
            if [[ -z "$local_line" ]]; then
              log_warn "Invalid selection: $n"
              continue
            fi
            selected_lines+="${local_line}"$'\n'
            launched=$((launched + 1))
          done

          if (( launched > 1 )); then
            if batch_route_selected_tasks "$selected_lines"; then
              log "info" "Prepared batch routing for $launched selected tasks"
            else
              log_warn "Batch routing failed for selected tasks; falling back to per-task routing"
            fi
          fi

          launched=0
          while IFS= read -r local_line; do
            [[ -z "$local_line" ]] && continue
            IFS='|' read -r sel_issue sel_slug sel_title _sel_area _sel_score _sel_blocked <<<"$local_line"
            dispatch_task_and_persist "$sel_issue" "$sel_slug" "$sel_title" "$((free_slots - launched))"
            launched=$((launched + LAST_LAUNCHED_SLOTS))
            if (( launched >= free_slots )); then
              break
            fi
          done <<<"$selected_lines"
          # Invalidate caches after launching so next cycle re-renders
          LAST_BACKLOG_FETCH=0
          LAST_DISPLAY=""
          LAST_WAITING_MSG=""  # Clear waiting state
          SELECT_SHOW_ALL=false
          USING_GROUPED_VIEW=false
          clear_task_list_display
        fi
        if [[ -n "$MONITOR_PHASE_C_REPLY_OFFSET" ]]; then
          acknowledge_command_offset "$MONITOR_PHASE_C_REPLY_OFFSET"
        fi
        poll_sleep "$POLL_SECONDS"
      else
        # All candidates are already active
        clear_task_list_display
        if (( active_count == 0 )); then
          waiting_msg="No new tasks available. Waiting... (type 'q' to quit)"
          if [[ "$waiting_msg" != "$LAST_WAITING_MSG" ]]; then
            log "status" "$waiting_msg"
            LAST_WAITING_MSG="$waiting_msg"
          fi
          if consume_next_command && [[ "$REPLY" == "quit" ]]; then
            quit_and_kill_session
          fi
          poll_sleep "$POLL_SECONDS"
        else
          poll_sleep "$POLL_SECONDS"
        fi
      fi
    else
      # Backlog empty
      clear_task_list_display
      if (( active_count == 0 )); then
        waiting_msg="Backlog empty. Waiting for new tasks... (type 'q' to quit)"
        if [[ "$waiting_msg" != "$LAST_WAITING_MSG" ]]; then
          log "status" "$waiting_msg"
          LAST_WAITING_MSG="$waiting_msg"
        fi
        # Invalidate cache so we re-fetch next cycle
        LAST_BACKLOG_FETCH=0
        if consume_next_command && [[ "$REPLY" == "quit" ]]; then
          quit_and_kill_session
        fi
        poll_sleep "$POLL_SECONDS"
      else
        poll_sleep "$POLL_SECONDS"
      fi
    fi
  else
    # All slots full — just monitor
    clear_task_list_display
    poll_sleep "$POLL_SECONDS"
  fi
done
