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
  #
  # HOK-3314: a cache-only / skipped / cooldown planner run (no inference
  # report, attempted=false, or skipReason set) is not inference-recovery
  # evidence. Preserve the inference block, degradationReason/episode/
  # failureCount fields instead of clearing them — only authoritative
  # inferenceStatus=ok clears a failed-inference episode.
  local filter='
    (($inference // {}) | if type == "object" then . else {} end) as $report |
    ($report.inferenceStatus // null) as $inference_status |
    (($report.attempted // null) == false
      or ($report.skipReason // null) != null
      or ($report | length) == 0
    ) as $no_inference_attempt |
    ($inference_status == "failed" or $inference_status == "stale" or $inference_status == "never") as $inference_degraded |
    ((.inferenceStatus // null) == "failed" or (.inferenceStatus // null) == "stale") as $previously_degraded |
    (if $no_inference_attempt and $previously_degraded then true
     elif $no_inference_attempt then false
     else $inference_degraded end) as $effective_degraded |
    .schemaVersion = 1 |
    .status = (if $effective_degraded then "degraded" else "healthy" end) |
    .lastSuccessfulPlanAt = $now |
    .lastAttemptAt = $now |
    .lastFailureAt = (if $no_inference_attempt and $previously_degraded then .lastFailureAt else null end) |
    .episodeStartedAt = (if $no_inference_attempt and $previously_degraded then .episodeStartedAt else null end) |
    .degradationReason = (if $effective_degraded then (if $no_inference_attempt then (.degradationReason // "inference_unavailable") else "inference_unavailable" end) else null end) |
    .failureStep = (if $effective_degraded then (if $no_inference_attempt then (.failureStep // "queue_inference") else "queue_inference" end) else null end) |
    .failureCount = (if $no_inference_attempt and $previously_degraded then (.failureCount // 0) else 0 end) |
    .retryBackoffSeconds = 0 |
    .nextRetryAt = null |
    .nextAction = (if $effective_degraded then "use_explicit_edges_only" else "use_dependency_queue" end) |
    .inferenceStatus = (if $no_inference_attempt and $previously_degraded then (.inferenceStatus // null) elif $no_inference_attempt then null else $inference_status end) |
    .inferredEdgeCount = ($report.inferredEdgeCount // .inferredEdgeCount // null) |
    .inference = (if $no_inference_attempt and $previously_degraded then (.inference // null)
                  elif $no_inference_attempt then null
                  elif ($report | length) == 0 then null
                  else {
                    model: ($report.model // null),
                    lastAttemptAt: ($report.lastAttemptAt // null),
                    lastSuccessAt: ($report.lastSuccessAt // null),
                    consecutiveFailures: ($report.consecutiveFailures // 0),
                    error: ($report.error // null),
                    refreshKind: ($report.refreshKind // null),
                    skipReason: ($report.skipReason // null)
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

  # HOK-3314: stamp the single queue-alert projection so renderers read one field.
  queue_alert_projection_stamp 2>/dev/null || true

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

  # HOK-3314: stamp the single queue-alert projection so renderers read one field.
  queue_alert_projection_stamp 2>/dev/null || true

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

# HOK-3314: resolve the queue-alert-projection CLI path. Prefers the install
# dir set by wavemill-common.sh at source time (WAVEMILL_INSTALL_DIR), which
# is pinned to this file's worktree; falls back to TOOLS_DIR for callers
# that override. This ordering keeps the CLI colocated with the shell helper
# across worktrees (fixing drift when TOOLS_DIR points at a different worktree).
queue_alert_projection_cli() {
  local tool_dir=""
  if [[ -n "${WAVEMILL_INSTALL_DIR:-}" ]]; then
    tool_dir="${WAVEMILL_INSTALL_DIR%/}/tools"
  elif [[ -n "${WAVEMILL_TOOLS_DIR:-}" ]]; then
    tool_dir="$WAVEMILL_TOOLS_DIR"
  elif [[ -n "${TOOLS_DIR:-}" ]]; then
    tool_dir="$TOOLS_DIR"
  fi
  [[ -n "$tool_dir" ]] || return 1
  printf '%s/queue-alert-projection.ts' "${tool_dir%/}"
}

# HOK-3314: stamp the single queue-alert projection into
# .wavemill/queue-health.json. Called once per planner cycle so the shell
# renderers can read `.currentAlertProjection` with a single jq call instead
# of each re-deriving status / severity / wording. Silent on failure — the
# derived projection is additive and consumers tolerate it missing.
queue_alert_projection_stamp() {
  local state_dir="${STATE_DIR:-}"
  if [[ -z "$state_dir" && -n "${STATE_FILE:-}" ]]; then
    state_dir="$(dirname "$STATE_FILE")"
  fi
  [[ -n "$state_dir" ]] || return 0
  local cli
  cli="$(queue_alert_projection_cli)" || return 0
  [[ -r "$cli" ]] || return 0
  command -v npx >/dev/null 2>&1 || return 0
  (npx tsx "$cli" --state-dir "$state_dir" >/dev/null 2>&1) || true
}

# HOK-3314: project `.currentAlertProjection` fields. Readers call this
# instead of re-deriving from raw queue-health.json. If the stamped block is
# missing, falls back to deriving once from queue-health.json via the CLI.
# Output: JSON object or 'null' when inference evidence is missing.
queue_alert_projection_read() {
  local health
  health="$(queue_health_read 2>/dev/null || echo '{}')"
  local projection
  projection="$(printf '%s' "$health" | jq -c '.currentAlertProjection // empty' 2>/dev/null || true)"
  if [[ -n "$projection" ]]; then
    printf '%s' "$projection"
    return 0
  fi
  local cli
  cli="$(queue_alert_projection_cli)" || { printf 'null'; return 0; }
  if [[ -r "$cli" ]] && command -v npx >/dev/null 2>&1; then
    projection="$(printf '%s' "$health" | npx tsx "$cli" --stdin 2>/dev/null | jq -c '.' 2>/dev/null || true)"
    if [[ -n "$projection" ]]; then
      printf '%s' "$projection"
      return 0
    fi
  fi
  printf 'null'
}

# HOK-3314: one-line picker banner for an inference-unavailable episode.
# Reads `.currentAlertProjection.summary` directly — the single source of
# truth for wording. Empty output means do not render a banner (healthy /
# planner-only degradation / unknown-but-no-reason-to-alert); the planner
# fallback banner is rendered by `queue_health_dashboard_warning` instead.
queue_inference_degraded_banner() {
  local projection status summary
  projection="$(queue_alert_projection_read 2>/dev/null || echo 'null')"
  [[ "$projection" != "null" && -n "$projection" ]] || return 0
  status="$(printf '%s' "$projection" | jq -r '.status // "unknown"' 2>/dev/null || echo 'unknown')"
  [[ "$status" == "degraded-inference" ]] || return 0
  summary="$(printf '%s' "$projection" | jq -r '.summary // ""' 2>/dev/null || echo '')"
  [[ -n "$summary" ]] || return 0
  printf '%s' "$summary"
}

# Get a human-readable degradation status. Reads from the single projection.
queue_health_status_summary() {
  local projection status nextAction count severity summary
  projection="$(queue_alert_projection_read 2>/dev/null || echo 'null')"
  if [[ "$projection" == "null" || -z "$projection" ]]; then
    echo "unknown"
    return 0
  fi
  status="$(printf '%s' "$projection" | jq -r '.status // "unknown"' 2>/dev/null || echo 'unknown')"
  if [[ "$status" == "healthy" ]]; then
    echo "healthy"
    return 0
  fi
  nextAction="$(printf '%s' "$projection" | jq -r '.nextAction // ""' 2>/dev/null || echo '')"
  count="$(printf '%s' "$projection" | jq -r '.episode.consecutiveFailedAttempts // 0' 2>/dev/null || echo '0')"
  severity="$(printf '%s' "$projection" | jq -r '.episode.severity // "low"' 2>/dev/null || echo 'low')"
  summary="$(printf '%s' "$projection" | jq -r '.summary // ""' 2>/dev/null || echo '')"
  printf '%s (%s/%s/%s); %s' "$status" "$severity" "$count" "${summary}" "$nextAction"
}
