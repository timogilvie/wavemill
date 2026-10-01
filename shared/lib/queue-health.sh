#!/usr/bin/env bash
# Queue-Health Management
#
# Tracks the health, lifecycle, and diagnostics of the dependency queue planner.
# Persists state to .wavemill/queue-health.json with schema versioning and
# additive compatibility.
#
# Uses state_mutate for atomic JSON updates (requires caller to initialize file).
# Uses wavemill_iso8601_to_epoch from wavemill-common.sh, sourced by callers.
#
# Schema (additive, schemaVersion 1):
#   status                healthy | degraded
#   degradationReason     planner failure class, or "inference_unavailable"
#                         when the planner succeeded but dependency inference
#                         did not (HOK-3130)
#   failureStep / failureCount / retryBackoffSeconds / nextRetryAt / nextAction
#   lastSuccessfulPlanAt / lastAttemptAt / lastFailureAt / episodeStartedAt
#   planner {pid,pgid,timeoutSeconds,startedAt,endedAt,durationMs,exitCode,
#            signal,cancellationOwner}
#   diagnostics {inputSnapshot,stdoutExcerpt,stderrExcerpt}
#   inferenceStatus       ok | failed | stale | never | null (no report)
#   inferredEdgeCount     inferred edges used by the last plan, or null
#   inference {model,lastAttemptAt,lastSuccessAt,consecutiveFailures,error,
#              refreshKind,skipReason} or null

# Derive the queue-health file path from STATE_DIR or STATE_FILE.
# Caller must ensure STATE_DIR or STATE_FILE is set.
queue_health_file_path() {
  local state_dir="${STATE_DIR:-}"
  if [[ -z "$state_dir" && -n "${STATE_FILE:-}" ]]; then
    state_dir="$(dirname "$STATE_FILE")"
  fi
  if [[ -n "$state_dir" ]]; then
    printf '%s/queue-health.json' "$state_dir"
  else
    return 1
  fi
}

# Initialize queue-health file if missing, creating parent dirs as needed.
# Idempotent: succeeds if file already exists.
queue_health_init() {
  local health_file exit_code
  health_file="$(queue_health_file_path)" || return 1

  if [[ -f "$health_file" ]]; then
    return 0
  fi

  mkdir -p "$(dirname "$health_file")" || return 1
  printf '%s\n' '{}' > "$health_file" || return 1
  return 0
}

# Read and validate the current queue-health state. Returns empty string if
# file is missing or unreadable; this is not an error for backward compat.
queue_health_read() {
  local health_file
  health_file="$(queue_health_file_path)" || return 0
  [[ -r "$health_file" ]] && cat "$health_file" 2>/dev/null || true
}

# Classify a queue planner failure based on step, exit code, signal, watchdog
# flag, and/or output validation.
# Arguments:
#   $1 = step (e.g., "plan_queue_failed", "jq_massage_failed")
#   $2 = exit_code (numeric)
#   $3 = signal (numeric or empty)
#   $4 = watchdog_fired (0/1)
#   $5 = stderr excerpt (optional)
# Output: degradation reason (e.g., "timeout", "external_cancellation", etc.)
queue_health_classify_failure() {
  local step="$1" exit_code="$2" signal="${3:-}" watchdog_fired="${4:-0}" stderr="${5:-}"

  # Timeout: watchdog fired, or exit 124 (standard timeout exit)
  if [[ "$watchdog_fired" == "1" || "$exit_code" == "124" ]]; then
    echo "timeout"
    return 0
  fi

  # External cancellation: SIGTERM/SIGKILL without watchdog
  if [[ "$exit_code" == "143" || "$exit_code" == "137" || "$signal" == "15" || "$signal" == "9" ]]; then
    echo "external_cancellation"
    return 0
  fi

  # Malformed dependency graph or cycle
  if [[ "$stderr" == *"cycle"* || "$stderr" == *"Cycle"* ]]; then
    echo "malformed_graph"
    return 0
  fi

  # Empty queue or validation failures
  if [[ "$step" == "empty_queue" ]]; then
    echo "empty_queue"
    return 0
  fi

  if [[ "$step" == "validation_failed" ]]; then
    echo "malformed_graph"
    return 0
  fi

  # Invalid input (jq failures, etc.)
  if [[ "$step" == "jq_massage_failed" ]]; then
    echo "invalid_input"
    return 0
  fi

  if [[ "$step" == "planner_input_missing" ]]; then
    echo "planner_input_missing"
    return 0
  fi

  # Diagnostics setup failure
  if [[ "$step" == "diagnostics_setup_failed" ]]; then
    echo "diagnostics_setup_failed"
    return 0
  fi

  # Generic planner error
  if [[ "$step" == "plan_queue_failed" ]]; then
    # Try to infer from stderr
    if [[ "$stderr" == *"Error"* || "$stderr" == *"error"* ]]; then
      echo "planner_error"
      return 0
    fi
    echo "planner_error"
    return 0
  fi

  # Fallback
  echo "unknown"
  return 0
}

# Redact an excerpt of text to bounded length, avoiding secrets or full content.
# Removes lines containing sensitive keywords and caps total length.
queue_health_redact_excerpt() {
  local text="${1:-}" max_len="${2:-512}"

  # Filter out sensitive patterns (tokens, passwords, full descriptions)
  printf '%s' "$text" | \
    grep -v -i -E 'token|password|secret|key|credential|authorization|bearer' | \
    sed -n '1,5p' | \
    tr '\n' ' ' | \
    head -c "$max_len"

  # Ensure it's not empty
  printf '%s' "${REPLY:-}$([ $? -eq 0 ] && echo '' || echo '(output redacted)')"
}

# Validate a plan-queue inference report (tools/plan-queue.ts
# --inference-report-file). Prints the compact object, or "null" when the
# report is missing or malformed so callers can pass it to --argjson.
queue_health_normalize_inference_report() {
  local raw="${1:-}" normalized
  if [[ -n "$raw" ]]; then
    normalized="$(printf '%s' "$raw" | jq -ce '
      if type == "object" and (.inferenceStatus | type) == "string" then . else empty end
    ' 2>/dev/null || true)"
    if [[ -n "$normalized" ]]; then
      printf '%s' "$normalized"
      return 0
    fi
  fi
  printf 'null'
}

# Record a successful queue plan, clearing planner degradation state.
# Uses state_mutate if available, otherwise writes directly.
#
# The planner exiting 0 does not prove dependency inference ran (HOK-3130):
# when the inference report says failed/stale/never, the plan is still used
# (explicit edges only) but health is degraded with reason
# "inference_unavailable". That path never sets a retry backoff, so
# queue_health_should_skip_attempt keeps running the planner.
# Arguments:
#   $1 = planner PID
#   $2 = planner PGID (or "unknown")
#   $3 = duration in milliseconds
#   $4 = command (for logging, not stored)
#   $5 = inference report JSON (optional; missing/invalid => healthy, fields null)
queue_health_record_success() {
  local pid="$1" pgid="$2" duration_ms="$3" _cmd="${4:-}"
  local inference_json
  inference_json="$(queue_health_normalize_inference_report "${5:-}")"
  local health_file
  health_file="$(queue_health_file_path)" || return 1
  queue_health_init || return 1

  local now timestamp
  timestamp="$(date -u +'%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || echo '')"

  # Build update filter: reset planner failure state, mark success, then
  # degrade on inference_unavailable when the report says so.
  local filter='
    (($inference // {}).inferenceStatus // null) as $inference_status |
    ($inference_status == "failed" or $inference_status == "stale" or $inference_status == "never") as $inference_degraded |
    .schemaVersion = 1 |
    .status = (if $inference_degraded then "degraded" else "healthy" end) |
    .lastSuccessfulPlanAt = $now |
    .lastAttemptAt = $now |
    .lastFailureAt = null |
    .episodeStartedAt = null |
    .degradationReason = (if $inference_degraded then "inference_unavailable" else null end) |
    .failureStep = (if $inference_degraded then "queue_inference" else null end) |
    .failureCount = 0 |
    .retryBackoffSeconds = 0 |
    .nextRetryAt = null |
    .nextAction = (if $inference_degraded then "use_explicit_edges_only" else "use_dependency_queue" end) |
    .inferenceStatus = $inference_status |
    .inferredEdgeCount = (($inference // {}).inferredEdgeCount // null) |
    .inference = (if $inference == null then null else {
      model: ($inference.model // null),
      lastAttemptAt: ($inference.lastAttemptAt // null),
      lastSuccessAt: ($inference.lastSuccessAt // null),
      consecutiveFailures: ($inference.consecutiveFailures // 0),
      error: ($inference.error // null),
      refreshKind: ($inference.refreshKind // null),
      skipReason: ($inference.skipReason // null)
    } end) |
    .planner = {
      pid: ($pid | tonumber),
      pgid: (if $pgid == "unknown" then null else ($pgid | tonumber) end),
      timeoutSeconds: null,
      startedAt: $now,
      endedAt: $now,
      durationMs: ($duration_ms | tonumber),
      exitCode: 0,
      signal: null,
      cancellationOwner: null
    } |
    .diagnostics = {
      inputSnapshot: {},
      stdoutExcerpt: "",
      stderrExcerpt: ""
    }
  '

  # Use state_mutate if available, otherwise direct JSON update
  if declare -f state_mutate &>/dev/null; then
    state_mutate "$health_file" "$filter" \
      --arg now "$timestamp" \
      --arg pid "$pid" \
      --arg pgid "$pgid" \
      --arg duration_ms "$duration_ms" \
      --argjson inference "$inference_json" \
      2>/dev/null || return 1
  else
    # Fallback: direct jq update (not atomic, but rare path)
    jq "$filter" \
      --arg now "$timestamp" \
      --arg pid "$pid" \
      --arg pgid "$pgid" \
      --arg duration_ms "$duration_ms" \
      --argjson inference "$inference_json" \
      "$health_file" > "${health_file}.tmp" 2>/dev/null || return 1
    mv -f "${health_file}.tmp" "$health_file" || return 1
  fi

  return 0
}

# Log once per inference-status transition (HOK-3130). The planner runs every
# ~60s, so a persistent inference_unavailable must not warn on every poll.
# The last warned status lives in $STATE_DIR/.queue-inference-warn; a return
# to ok clears it so the next degradation warns again.
queue_health_warn_inference_transition() {
  local state_dir="${STATE_DIR:-}" health inference_status reason warn_file previous error_text
  if [[ -z "$state_dir" && -n "${STATE_FILE:-}" ]]; then
    state_dir="$(dirname "$STATE_FILE")"
  fi
  [[ -n "$state_dir" ]] || return 0
  warn_file="${state_dir}/.queue-inference-warn"

  health="$(queue_health_read 2>/dev/null || echo '{}')"
  reason="$(printf '%s' "$health" | jq -r '.degradationReason // ""' 2>/dev/null || echo '')"
  inference_status="$(printf '%s' "$health" | jq -r '.inferenceStatus // ""' 2>/dev/null || echo '')"

  if [[ "$reason" != "inference_unavailable" ]]; then
    rm -f "$warn_file" 2>/dev/null || true
    return 0
  fi

  previous="$(cat "$warn_file" 2>/dev/null || echo '')"
  [[ "$previous" == "$inference_status" ]] && return 0

  error_text="$(printf '%s' "$health" | jq -r '.inference.error // ""' 2>/dev/null | head -c 200 || echo '')"
  local message="queue inference unavailable (${inference_status:-unknown}); planning with explicit edges only${error_text:+ (last error: ${error_text})}"
  if declare -f log_warn &>/dev/null; then
    log_warn "$message"
  else
    printf 'WARN: %s\n' "$message" >&2
  fi
  printf '%s' "$inference_status" > "$warn_file" 2>/dev/null || true
}

# Record a failed queue planner attempt, entering or continuing degradation.
# Manages backoff state, episode identity, failure count, and diagnostics.
# Arguments:
#   $1 = degradation reason (e.g., "timeout", "external_cancellation")
#   $2 = failure step (e.g., "plan_queue_failed")
#   $3 = planner PID (or "unknown")
#   $4 = planner PGID (or "unknown")
#   $5 = timeout seconds (or "unknown")
#   $6 = exit code
#   $7 = signal (or empty)
#   $8 = cancellation owner (or "unknown")
#   $9 = stdout excerpt (redacted)
#   $10 = stderr excerpt (redacted)
#   $11 = input snapshot JSON (optional, e.g., {"taskCount":12})
queue_health_record_failure() {
  local reason="$1" step="$2" pid="$3" pgid="$4" timeout_secs="$5"
  local exit_code="$6" signal="${7:-}" cancellation_owner="$8"
  local stdout_excerpt="${9:-}" stderr_excerpt="${10:-}" input_snapshot="${11:-}"

  local health_file
  health_file="$(queue_health_file_path)" || return 1
  queue_health_init || return 1

  local now timestamp
  timestamp="$(date -u +'%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || echo '')"

  # Read current state to compute backoff and episode
  local current_health episode_started_at failure_count backoff_secs next_retry_at
  current_health="$(queue_health_read 2>/dev/null || echo '{}')"
  episode_started_at="$(printf '%s' "$current_health" | jq -r '.episodeStartedAt // ""' 2>/dev/null || echo '')"
  failure_count="$(printf '%s' "$current_health" | jq -r '.failureCount // 0' 2>/dev/null || echo '0')"

  # If no episode started, start one now
  if [[ -z "$episode_started_at" ]]; then
    episode_started_at="$timestamp"
    failure_count=1
    backoff_secs=0
  else
    # Continue episode: increment count and compute next backoff
    failure_count=$((failure_count + 1))
    # Exponential backoff: 15s, 30s, 60s, 120s, 300s (capped)
    case $failure_count in
      2) backoff_secs=15 ;;
      3) backoff_secs=30 ;;
      4) backoff_secs=60 ;;
      5) backoff_secs=120 ;;
      *) backoff_secs=300 ;;
    esac
  fi

  # Compute next retry time
  local next_retry_epoch
  next_retry_epoch=$(($(date +%s 2>/dev/null || echo '0') + backoff_secs))
  next_retry_at="$(date -u -d @$next_retry_epoch +'%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || \
                   date -u -jf '%s' $next_retry_epoch +'%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || echo '')"

  # Build input snapshot from argument
  local input_snapshot_json='{}'
  if [[ -n "$input_snapshot" ]]; then
    input_snapshot_json="$(printf '%s' "$input_snapshot" | jq -c '.' 2>/dev/null || echo '{}')"
  fi

  # Determine next action based on backoff
  local next_action="use_dependency_queue"
  if [[ "$backoff_secs" -gt 0 ]]; then
    next_action="retry_after_backoff"
  fi

  # Build update filter
  local filter='
    .schemaVersion = 1 |
    .status = "degraded" |
    .lastAttemptAt = $now |
    .lastFailureAt = $now |
    .episodeStartedAt = (if .episodeStartedAt then .episodeStartedAt else $episode_started end) |
    .degradationReason = $reason |
    .failureStep = $step |
    .failureCount = $failure_count |
    .retryBackoffSeconds = $backoff_secs |
    .nextRetryAt = $next_retry_at |
    .nextAction = $next_action |
    .planner = {
      pid: (if $pid == "unknown" then null else ($pid | tonumber) end),
      pgid: (if $pgid == "unknown" then null else ($pgid | tonumber) end),
      timeoutSeconds: (if $timeout_secs == "unknown" then null else ($timeout_secs | tonumber) end),
      startedAt: $now,
      endedAt: $now,
      durationMs: 0,
      exitCode: ($exit_code | tonumber),
      signal: (if $signal == "" or $signal == "null" then null else ($signal | tonumber) end),
      cancellationOwner: (if $cancellation_owner == "unknown" then null else $cancellation_owner end)
    } |
    .diagnostics = {
      inputSnapshot: ($input_snapshot_json | try fromjson catch {}),
      stdoutExcerpt: $stdout_excerpt,
      stderrExcerpt: $stderr_excerpt
    } |
    .totalFailureCount = ((.totalFailureCount // 0) + 1) |
    .lastFailureEvidence = {
      lastFailureAt: $now,
      episodeStartedAt: .episodeStartedAt,
      degradationReason: $reason,
      failureStep: $step,
      failureCount: $failure_count,
      planner: .planner,
      diagnostics: .diagnostics
    }
  '

  # Use state_mutate if available
  if declare -f state_mutate &>/dev/null; then
    state_mutate "$health_file" "$filter" \
      --arg now "$timestamp" \
      --arg reason "$reason" \
      --arg step "$step" \
      --arg pid "$pid" \
      --arg pgid "$pgid" \
      --arg timeout_secs "$timeout_secs" \
      --arg exit_code "$exit_code" \
      --arg signal "$signal" \
      --arg cancellation_owner "$cancellation_owner" \
      --arg stdout_excerpt "$stdout_excerpt" \
      --arg stderr_excerpt "$stderr_excerpt" \
      --arg input_snapshot_json "$input_snapshot_json" \
      --arg episode_started "$episode_started_at" \
      --argjson failure_count "$failure_count" \
      --arg next_retry_at "$next_retry_at" \
      --arg next_action "$next_action" \
      --argjson backoff_secs "$backoff_secs" \
      2>/dev/null || return 1
  else
    # Fallback: direct jq update
    jq "$filter" \
      --arg now "$timestamp" \
      --arg reason "$reason" \
      --arg step "$step" \
      --arg pid "$pid" \
      --arg pgid "$pgid" \
      --arg timeout_secs "$timeout_secs" \
      --arg exit_code "$exit_code" \
      --arg signal "$signal" \
      --arg cancellation_owner "$cancellation_owner" \
      --arg stdout_excerpt "$stdout_excerpt" \
      --arg stderr_excerpt "$stderr_excerpt" \
      --arg input_snapshot_json "$input_snapshot_json" \
      --arg episode_started "$episode_started_at" \
      --argjson failure_count "$failure_count" \
      --arg next_retry_at "$next_retry_at" \
      --arg next_action "$next_action" \
      --argjson backoff_secs "$backoff_secs" \
      "$health_file" > "${health_file}.tmp" 2>/dev/null || return 1
    mv -f "${health_file}.tmp" "$health_file" || return 1
  fi

  return 0
}

# Check if queue planner should skip execution due to backoff.
# Returns 0 (success, should skip) if in backoff window, 1 otherwise.
queue_health_should_skip_attempt() {
  local health_file next_retry_at current_epoch next_retry_epoch
  health_file="$(queue_health_file_path)" || return 1

  next_retry_at="$(queue_health_read | jq -r '.nextRetryAt // ""' 2>/dev/null || echo '')"
  [[ -n "$next_retry_at" ]] || return 1

  current_epoch=$(date +%s 2>/dev/null || echo '0')
  next_retry_epoch="$(wavemill_iso8601_to_epoch "$next_retry_at" 2>/dev/null || echo '0')"

  # If current time is before next retry, skip
  (( current_epoch < next_retry_epoch ))
}

# Get a human-readable degradation status. Useful for logging/UI.
# Output: one-line string describing current status, e.g.:
#   "healthy" / "degraded (timeout); backoff 14s" / "degraded (external_cancellation); retry available"
queue_health_status_summary() {
  local health_file
  health_file="$(queue_health_file_path)" || return 1

  local health status reason backoff next_action
  health="$(queue_health_read 2>/dev/null || echo '{}')"
  status="$(printf '%s' "$health" | jq -r '.status // "unknown"' 2>/dev/null || echo 'unknown')"

  if [[ "$status" == "healthy" ]]; then
    echo "healthy"
    return 0
  fi

  reason="$(printf '%s' "$health" | jq -r '.degradationReason // ""' 2>/dev/null || echo '')"
  backoff="$(printf '%s' "$health" | jq -r '.retryBackoffSeconds // 0' 2>/dev/null || echo '0')"
  next_action="$(printf '%s' "$health" | jq -r '.nextAction // ""' 2>/dev/null || echo '')"

  if [[ "$reason" == "inference_unavailable" ]]; then
    local inference_status
    inference_status="$(printf '%s' "$health" | jq -r '.inferenceStatus // "unknown"' 2>/dev/null || echo 'unknown')"
    printf 'degraded (%s: %s); %s' "$reason" "$inference_status" "$next_action"
  elif [[ "$backoff" -gt 0 ]]; then
    printf 'degraded (%s); backoff %ds' "$reason" "$backoff"
  else
    printf 'degraded (%s); %s' "$reason" "$next_action"
  fi
}
