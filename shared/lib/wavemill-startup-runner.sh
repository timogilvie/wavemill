#!/opt/homebrew/bin/bash
set -Eeuo pipefail

command -v git >/dev/null || { echo "Error: git is required but not installed" >&2; exit 1; }
command -v npx >/dev/null || { echo "Error: npx is required but not installed" >&2; exit 1; }
command -v jq >/dev/null || { echo "Error: jq is required but not installed" >&2; exit 1; }

PLAN_FILE="${1:-}"
if [[ -z "$PLAN_FILE" || ! -f "$PLAN_FILE" ]]; then
  echo "Usage: $0 /tmp/<session>-launch-plan.json" >&2
  exit 1
fi

if [[ ! -t 2 ]]; then
  export WAVEMILL_NO_PROGRESS=1
fi

SESSION="$(jq -r '.session' "$PLAN_FILE")"
WAVEMILL_RUN_EPOCH="$(jq -r '.runEpoch // empty' "$PLAN_FILE")"
REPO_DIR="$(jq -r '.repoDir' "$PLAN_FILE")"
BASE_BRANCH="$(jq -r '.baseBranch' "$PLAN_FILE")"
WAVEMILL_BASE_BRANCH_SOURCE="$(jq -r '.baseBranchSource // "runtime-env"' "$PLAN_FILE")"
RESOLVED_BASE_REF="$(jq -r '.resolvedBaseRef // empty' "$PLAN_FILE")"
BASE_REF_PREFLIGHT_JSON="$(jq -c '.baseRefPreflight // empty' "$PLAN_FILE" 2>/dev/null || true)"
WORKTREE_ROOT="$(jq -r '.worktreeRoot' "$PLAN_FILE")"
PLANNING_MODE="$(jq -r '.planningMode' "$PLAN_FILE")"
if [[ "$PLANNING_MODE" != "interactive" ]]; then
  startup_log "Warning: planningMode='$PLANNING_MODE' is no longer supported; forcing interactive planning."
  PLANNING_MODE="interactive"
fi
AGENT_CMD="$(jq -r '.agentCmd' "$PLAN_FILE")"
AGENT_CMD_EXPLICIT="$(jq -r '.agentCmdExplicit // false' "$PLAN_FILE")"
FORCE_MODEL="$(jq -r '.forceModel // empty' "$PLAN_FILE")"
ROUTER_ENABLED="$(jq -r '.routerEnabled // true' "$PLAN_FILE")"
MAX_PARALLEL="$(jq -r '.maxParallel // 0' "$PLAN_FILE")"
STATE_DIR="$(jq -r '.stateDir' "$PLAN_FILE")"
STATE_FILE="$(jq -r '.stateFile' "$PLAN_FILE")"
TOOLS_DIR="$(jq -r '.toolsDir' "$PLAN_FILE")"
LIB_DIR="$(jq -r '.libDir' "$PLAN_FILE")"
INITIAL_PHASE="$(jq -r '.initialPhase' "$PLAN_FILE")"
STATUS_LOG_FILE="$(jq -r '.startupConfig.statusLogFile' "$PLAN_FILE")"
MONITOR_ENV="$(jq -r '.startupConfig.monitorEnv' "$PLAN_FILE")"
MONITOR_SCRIPT="$(jq -r '.startupConfig.monitorScript' "$PLAN_FILE")"
LAUNCHED_ISSUES_FILE="$(jq -r '.startupConfig.launchedIssuesFile' "$PLAN_FILE")"
MILL_LOG_FILE="$(jq -r '.startupConfig.millLogFile // empty' "$PLAN_FILE")"
POLL_SECONDS="$(jq -r '.monitorConfig.pollSeconds // 10' "$PLAN_FILE")"
REQUIRE_CONFIRM="$(jq -r '.monitorConfig.requireConfirm // true' "$PLAN_FILE")"
WAVEMILL_REQUIRE_CONFIRM_SOURCE="$(jq -r '.monitorConfig.requireConfirmSource // "runtime-env"' "$PLAN_FILE")"
INTEGRATION_MERGE_METHOD="$(jq -r '.monitorConfig.mergeMethod // "squash"' "$PLAN_FILE")"
WAVEMILL_MERGE_METHOD_SOURCE="$(jq -r '.monitorConfig.mergeMethodSource // "repo-config"' "$PLAN_FILE")"
DRY_RUN="$(jq -r '.monitorConfig.dryRun // false' "$PLAN_FILE")"
if [[ "${WAVEMILL_DRY_RUN:-}" == "1" || "${WAVEMILL_DRY_RUN:-}" == "true" || "$DRY_RUN" == "true" ]]; then
  export WAVEMILL_DRY_RUN=1
  DRY_RUN="true"
else
  DRY_RUN="false"
  command -v tmux >/dev/null || { echo "Error: tmux is required but not installed" >&2; exit 1; }
fi
PROJECT_NAME="$(jq -r '.monitorConfig.projectName // empty' "$PLAN_FILE")"
AUTO_EVAL="$(jq -r '.monitorConfig.autoEval // true' "$PLAN_FILE")"
ENTER_LAUNCHES_WAVE="$(jq -r '.monitorConfig.enterLaunchesWave // true' "$PLAN_FILE")"
DASHBOARD_VERBOSITY="$(jq -r '.monitorConfig.dashboardVerbosity // "info"' "$PLAN_FILE")"
DASHBOARD_LOG_TO_FILE="$(jq -r '.monitorConfig.dashboardLogToFile // true' "$PLAN_FILE")"
# Parsed but intentionally unused; behavior change ships in follow-up.
QUEUE_PLAN="$(jq -c '.queuePlan // []' "$PLAN_FILE")"
DASHBOARD_PID=""
# Optional queue plan metadata (HOK-1532) — read but not acted on.
# Runner ignores these fields; queue execution lands in a follow-up.
LAUNCH_QUEUE_PLAN="$(jq -c '.queuePlan // empty' "$PLAN_FILE" 2>/dev/null || true)"

export SESSION REPO_DIR BASE_BRANCH RESOLVED_BASE_REF WORKTREE_ROOT PLANNING_MODE AGENT_CMD AGENT_CMD_EXPLICIT
export WAVEMILL_RUN_EPOCH
export WAVEMILL_BASE_BRANCH_SOURCE WAVEMILL_REQUIRE_CONFIRM_SOURCE WAVEMILL_MERGE_METHOD_SOURCE
export FORCE_MODEL ROUTER_ENABLED MAX_PARALLEL STATE_DIR STATE_FILE TOOLS_DIR LIB_DIR
export POLL_SECONDS REQUIRE_CONFIRM INTEGRATION_MERGE_METHOD DRY_RUN PROJECT_NAME AUTO_EVAL ENTER_LAUNCHES_WAVE DASHBOARD_VERBOSITY
export DASHBOARD_LOG_TO_FILE MILL_LOG_FILE

source "$LIB_DIR/wavemill-common.sh"
source "$LIB_DIR/agent-adapters.sh"
if [[ -f "$LIB_DIR/terminal-reconciler.sh" ]]; then
# shellcheck source=terminal-reconciler.sh
source "$LIB_DIR/terminal-reconciler.sh"
fi
if [[ -f "$LIB_DIR/startup-terminal-preflight.sh" ]]; then
# shellcheck source=startup-terminal-preflight.sh
source "$LIB_DIR/startup-terminal-preflight.sh"
fi
source "$LIB_DIR/startup-progress.sh"
if [[ -f "$LIB_DIR/wavemill-worktree-deps.sh" ]]; then
# shellcheck source=wavemill-worktree-deps.sh
source "$LIB_DIR/wavemill-worktree-deps.sh"
fi
if [[ -f "$LIB_DIR/wavemill-window-titles.sh" ]]; then
# shellcheck source=wavemill-window-titles.sh
source "$LIB_DIR/wavemill-window-titles.sh"
fi

write_shell_assignment() {
  local name="$1" value="${2-}"
  printf '%s=' "$name"
  printf '%q\n' "$value"
}

startup_log() {
  local line="$*"
  if [[ -n "${STARTUP_TASK_LOG_FILE:-}" ]]; then
    printf '%s\n' "$line" >> "$STARTUP_TASK_LOG_FILE" 2>/dev/null || true
    return 0
  fi
  # DO NOT add printf to stdout here - causes [1/7] messages to bleed into monitor pane (HOK-1282)
  # Startup messages are already displayed in pane 2 via tail -f of STATUS_LOG_FILE
  [[ -n "${STATUS_LOG_FILE:-}" ]] && printf '%s\n' "$line" >> "$STATUS_LOG_FILE" 2>/dev/null || true
}

startup_task_log() {
  local issue="$1"
  shift
  startup_log "$(wavemill_task_log_message "$issue" "$*")"
}

startup_step() {
  local message="$1"
  startup_log "  $message"
}

startup_preflight_base_ref() {
  local needs_preflight="true"

  if [[ -n "${RESOLVED_BASE_REF:-}" ]] \
    && [[ -n "${BASE_REF_PREFLIGHT_JSON:-}" ]] \
    && [[ "$(printf '%s' "$BASE_REF_PREFLIGHT_JSON" | jq -r '.status // empty' 2>/dev/null)" == "ok" ]] \
    && git -C "$REPO_DIR" show-ref --verify --quiet "$RESOLVED_BASE_REF"; then
    needs_preflight="false"
  fi

  if [[ "$needs_preflight" == "true" ]]; then
    local preflight_file preflight_rc=0
    preflight_file="$(mktemp "/tmp/${SESSION}-base-ref-preflight.XXXXXX")"
    wavemill_base_ref_preflight "$BASE_BRANCH" --force-fetch --json-out "$preflight_file" || preflight_rc=$?
    BASE_REF_PREFLIGHT_JSON="$(cat "$preflight_file" 2>/dev/null || echo '{}')"
    rm -f "$preflight_file"
    RESOLVED_BASE_REF="$(printf '%s' "$BASE_REF_PREFLIGHT_JSON" | jq -r '.resolvedRef // empty' 2>/dev/null || true)"
    export RESOLVED_BASE_REF BASE_REF_PREFLIGHT_JSON
    if [[ "$preflight_rc" -ne 0 ]]; then
      return "$preflight_rc"
    fi
  fi

  [[ -n "${RESOLVED_BASE_REF:-}" ]]
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

startup_refresh_openrouter_credits() {
  [[ -n "${REPO_DIR:-}" && -n "${TOOLS_DIR:-}" ]] || return 0

  if command -v timeout >/dev/null 2>&1; then
    timeout 5 npx tsx "$TOOLS_DIR/refresh-openrouter-credits.ts" --repo-dir "$REPO_DIR" --timeout-ms 5000 >/dev/null 2>&1 \
      || startup_log "WARN: OpenRouter credit refresh failed; continuing with cached balance"
  else
    npx tsx "$TOOLS_DIR/refresh-openrouter-credits.ts" --repo-dir "$REPO_DIR" --timeout-ms 5000 >/dev/null 2>&1 \
      || startup_log "WARN: OpenRouter credit refresh failed; continuing with cached balance"
  fi
}

startup_openrouter_credit_warning() {
  [[ -n "${REPO_DIR:-}" ]] || return 1
  command -v jq >/dev/null 2>&1 || return 1

  local quota_file="$REPO_DIR/.wavemill/quota-state.json"
  [[ -f "$quota_file" ]] || return 1

  local balance min_credits usage_daily runway_days
  balance="$(jq -r '.providers.openrouter.balanceUsd // empty' "$quota_file" 2>/dev/null || true)"
  [[ -n "$balance" ]] || return 1
  usage_daily="$(jq -r '.providers.openrouter.usageDaily // empty' "$quota_file" 2>/dev/null || true)"
  min_credits="$(jq -r '.nativeAgent.providers.openrouter.minCreditsUsd // 0.02' "$REPO_DIR/.wavemill-config.json" 2>/dev/null || echo "0.02")"
  [[ -n "$min_credits" ]] || min_credits="0.02"

  if awk -v balance="$balance" -v min="$min_credits" 'BEGIN { exit !(balance < min) }'; then
    printf 'OpenRouter credits exhausted - challenge coverage disabled, top up at https://openrouter.ai/credits\n'
    return 0
  fi

  if [[ -n "$usage_daily" ]] && awk -v burn="$usage_daily" 'BEGIN { exit !(burn > 0) }'; then
    runway_days="$(awk -v balance="$balance" -v burn="$usage_daily" 'BEGIN { printf "%.1f", balance / burn }')"
    if awk -v days="$runway_days" 'BEGIN { exit !(days < 2) }'; then
      printf 'OpenRouter runway low: $%.2f balance / $%.2f daily burn (~%s days)\n' "$balance" "$usage_daily" "$runway_days"
      return 0
    fi
  fi

  return 1
}

startup_warn_openrouter_status() {
  [[ -n "${REPO_DIR:-}" && -n "${TOOLS_DIR:-}" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0

  local credit_warning
  credit_warning="$(startup_openrouter_credit_warning 2>/dev/null || true)"
  if [[ -n "$credit_warning" ]]; then
    write_openrouter_warning_cache "$credit_warning"
    startup_log "WARN: $credit_warning"
    return 0
  fi

  local doctor_json doctor_rc warning_text status_line line
  doctor_json="$(npx tsx "$TOOLS_DIR/openrouter-doctor.ts" --json --repo-dir "$REPO_DIR" --lookback 20 2>/dev/null)" || doctor_rc=$?
  doctor_rc="${doctor_rc:-0}"
  [[ -n "$doctor_json" ]] || return 0

  warning_text="$(printf '%s' "$doctor_json" | jq -r '.zeroTrafficAlertText // empty' 2>/dev/null)" || return 0
  status_line="$(printf '%s' "$doctor_json" | jq -r '.zeroTrafficAlert.headline // empty' 2>/dev/null)" || status_line=""

  if [[ -z "$warning_text" ]]; then
    write_openrouter_warning_cache ""
    return 0
  fi

  write_openrouter_warning_cache "${status_line:-$warning_text}"
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    startup_log "WARN: $line"
  done <<< "$warning_text"

  return 0
}

write_stage_result_local() {
  local feature_dir="$1" stage="$2" status="$3"
  local agent="${4:-}" model="${5:-}" notes="${6:-}"
  local result_file="$feature_dir/.${stage}-result.json"
  local now started_at finished_at tmp

  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  mkdir -p "$feature_dir"

  started_at="$now"
  if [[ -f "$result_file" ]]; then
    local prev_start
    prev_start=$(jq -r '.startedAt // empty' "$result_file" 2>/dev/null || echo "")
    [[ -n "$prev_start" ]] && started_at="$prev_start"
  fi

  finished_at="null"
  if [[ "$status" == "completed" || "$status" == "aborted" || "$status" == "failed" ]]; then
    finished_at="\"$now\""
  fi

  tmp=$(mktemp) || return 1
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
}

startup_state_lock_acquire() {
  local lock_dir="${STATE_FILE}.lock"
  local attempt
  for attempt in {1..200}; do
    if mkdir "$lock_dir" 2>/dev/null; then
      STARTUP_STATE_LOCK_DIR="$lock_dir"
      return 0
    fi
    sleep 0.05
  done
  return 1
}

startup_state_lock_release() {
  [[ -n "${STARTUP_STATE_LOCK_DIR:-}" ]] && rmdir "$STARTUP_STATE_LOCK_DIR" 2>/dev/null || true
  STARTUP_STATE_LOCK_DIR=""
}

reset_startup_phase_artifacts() {
  local feature_dir="$1"

  rm -f \
    "$feature_dir/.planning-result.json" \
    "$feature_dir/.coding-result.json" \
    "$feature_dir/.review-result.json" \
    "$feature_dir/.ready-result.json" \
    "$feature_dir/.review-infra-retries" \
    "$feature_dir/.resolved-phase" \
    "$feature_dir/.plan-approved" \
    "$feature_dir/.coding-complete" \
    "$feature_dir/.review-complete" \
    "$feature_dir/.ready-complete" \
    "$feature_dir/.workflow-aborted" \
    "$feature_dir/plan.md"
}

# remove_task_state() is provided by wavemill-common.sh (HOK-2903), sourced
# above. The canonical copy always returns 0 and warns through log_warn when
# defined; this scope's former copy propagated state_mutate's exit code, but
# every call site here already discarded it via `|| true`.

set_task_phase_local() {
  local issue="$1" phase="$2"
  state_mutate "$STATE_FILE" \
    '.tasks[$issue] = ((.tasks[$issue] // {}) + {
      phase: $phase,
      updated: (now | todate)
    })' \
    --arg issue "$issue" --arg phase "$phase"
}

linear_set_state() {
  local issue="$1" state="$2"
  [[ "$DRY_RUN" == "true" ]] && return 0
  npx tsx "$TOOLS_DIR/set-issue-state.ts" "$issue" "$state" >/dev/null 2>&1
}

linear_enqueue_retry() {
  local state="$1"
  local issues_csv="$2"
  local category="${3:-unknown}"
  local http="${4:-none}"
  local message="${5:-Queued from startup batch retry path}"
  [[ "$DRY_RUN" == "true" ]] && return 0
  [[ -z "$issues_csv" ]] && return 0
  npx tsx "$TOOLS_DIR/linear-retry-drain.ts" enqueue \
    --state "$state" \
    --issues "$issues_csv" \
    --category "$category" \
    --http "$http" \
    --message "$message" >/dev/null 2>&1 || true
}

linear_batch_set_state() {
  local state="$1"
  shift || true
  local -a issues=("$@")
  local output exit_code=0 stderr_tmp stderr_output retryable_issues_csv retry_category retry_http retry_message
  [[ "$DRY_RUN" == "true" ]] && return 0
  [[ "${#issues[@]}" -eq 0 ]] && return 0

  stderr_tmp="$(mktemp -t wavemill-linear-batch-stderr.XXXXXX)"
  output="$(npx tsx "$TOOLS_DIR/set-issues-state.ts" --state "$state" "${issues[@]}" 2>"$stderr_tmp")" || exit_code=$?
  stderr_output="$(cat "$stderr_tmp" 2>/dev/null || true)"

  if jq -e '.failed | length > 0' >/dev/null 2>&1 <<<"$output"; then
    while IFS= read -r failure; do
      startup_log "WARN: Linear state update to '$state' failed for $failure"
    done < <(jq -r '.failed[] | "\(.issueId): \(.error) [category=\(.category // "unknown"), http=\((.httpStatus // "none") | tostring), retryable=\(.isRetryable // false)]"' <<<"$output")
    retryable_issues_csv="$(jq -r '[.failed[] | select(.isRetryable == true) | .issueId] | unique | join(",")' <<<"$output")"
    retry_category="$(jq -r '([.failed[] | select(.isRetryable == true) | .category] | first) // "unknown"' <<<"$output")"
    retry_http="$(jq -r '([.failed[] | select(.isRetryable == true) | .httpStatus] | map(select(. != null)) | first // "none") | tostring' <<<"$output")"
    retry_message="$(jq -r '([.failed[] | select(.isRetryable == true) | .error] | first) // "Queued from startup batch retry path"' <<<"$output")"
    linear_enqueue_retry "$state" "$retryable_issues_csv" "$retry_category" "$retry_http" "$retry_message"
  elif [[ "$exit_code" -ne 0 ]]; then
    startup_log "WARN: Batch Linear state update to '$state' failed for ${#issues[@]} issue(s) [category=unknown, http=none, retryable=false, details=${stderr_output:-none}]"
  fi
  rm -f "$stderr_tmp"
  return 0
}

ensure_state_file() {
  mkdir -p "$STATE_DIR"
  if [[ ! -f "$STATE_FILE" ]]; then
    printf '{"session":"%s","started":"%s","tasks":{}}\n' \
      "$SESSION" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATE_FILE"
  fi
}

startup_issue_state_from_task() {
  local task_json="$1" issue_json_file issue_json
  issue_json_file="$(jq -r '.issueJsonFile // empty' <<<"$task_json" 2>/dev/null || true)"
  if [[ -n "$issue_json_file" && -f "$issue_json_file" ]]; then
    issue_json="$(cat "$issue_json_file" 2>/dev/null || echo '{}')"
    jq -r '(.state.name // .state // .workflowState.name // .status // "") | ascii_downcase' <<<"$issue_json" 2>/dev/null || true
  fi
}

startup_existing_attempt_for_issue() {
  local issue="$1"
  [[ -n "${STATE_FILE:-}" && -f "$STATE_FILE" ]] || return 1
  jq -c --arg issue "$issue" '.tasks[$issue].attempt // .tasks[$issue].lifecycle.attempt // empty' "$STATE_FILE" 2>/dev/null
}

startup_stamp_fresh_plan_summary() {
  local original_count="$1" launchable_count="$2" skipped_count="$3" deferred_count="$4"
  local tmp
  tmp="$(mktemp "${PLAN_FILE}.fresh-preflight.XXXXXX" 2>/dev/null || true)"
  [[ -n "$tmp" ]] || return 0
  if jq \
    --argjson original "$original_count" \
    --argjson launchable "$launchable_count" \
    --argjson skipped "$skipped_count" \
    --argjson deferred "$deferred_count" \
    --arg runEpoch "${WAVEMILL_RUN_EPOCH:-}" \
    '.freshLaunchPreflight = {
      schemaVersion: 1,
      originalTaskCount: $original,
      launchableTaskCount: $launchable,
      skippedTaskCount: $skipped,
      deferredTaskCount: $deferred,
      runEpoch: (if $runEpoch == "" then null else $runEpoch end),
      checkedAt: (now | todateiso8601)
    }' "$PLAN_FILE" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$PLAN_FILE"
  else
    rm -f "$tmp" 2>/dev/null || true
  fi
}

startup_preflight_fresh_launch_plan() {
  declare -F wavemill_resolve_pr_attempt >/dev/null 2>&1 || return 0
  if declare -F startup_preflight_enabled >/dev/null 2>&1; then
    [[ "$(startup_preflight_enabled)" == "true" ]] || return 0
  fi

  local original_count decisions_file task_json decision_json issue slug branch worktree linear_issue linear_state
  local attempt_json existing_attempt attempt_id resolution classification challenge_pair challenge_role head_sha
  local tasks_json='[]' launchable_count=0 skipped_count=0 deferred_count=0 retry_task retry_attempt retry_branch retry_slug retry_worktree
  local tmp_plan selected_pr reason
  original_count="$(jq '.tasks | length' "$PLAN_FILE" 2>/dev/null || echo 0)"
  [[ "$original_count" -gt 0 ]] || return 0

  decisions_file="$(mktemp "/tmp/${SESSION}-fresh-launch-preflight.XXXXXX")"
  declare -A merged_challenge_pairs=()
  declare -A merged_challenge_prs=()

  while IFS= read -r task_json; do
    [[ -n "$task_json" ]] || continue
    issue="$(jq -r '.issue // empty' <<<"$task_json")"
    slug="$(jq -r '.slug // empty' <<<"$task_json")"
    branch="$(jq -r '.branch // empty' <<<"$task_json")"
    worktree="$(jq -r '.worktreeDir // empty' <<<"$task_json")"
    linear_issue="$(jq -r '.linearIssueId // .issue // empty' <<<"$task_json")"
    challenge_pair="$(jq -r '.challengePairId // empty' <<<"$task_json")"
    challenge_role="$(jq -r '.challengeRole // empty' <<<"$task_json")"
    linear_state="$(startup_issue_state_from_task "$task_json")"
    existing_attempt="$(startup_existing_attempt_for_issue "$issue" 2>/dev/null || true)"
    if [[ -n "$existing_attempt" ]]; then
      attempt_json="$existing_attempt"
    else
      attempt_json="$(jq -c '.attempt // empty' <<<"$task_json" 2>/dev/null || true)"
    fi
    if [[ -z "$attempt_json" || "$attempt_json" == "null" ]]; then
      attempt_json="$(wavemill_attempt_context_json "$issue" "$(wavemill_default_attempt_id "$issue" "$branch")" "$branch" "$branch" "$BASE_BRANCH" "fresh-launch")"
    fi
    branch="$(jq -r --arg fallback "$branch" '.effectiveBranch // $fallback' <<<"$attempt_json" 2>/dev/null || printf '%s\n' "$branch")"
    attempt_id="$(jq -r '.attemptId // empty' <<<"$attempt_json" 2>/dev/null || true)"
    head_sha=""
    [[ -d "$worktree/.git" || -d "$worktree" ]] && head_sha="$(git -C "$worktree" rev-parse HEAD 2>/dev/null || true)"
    resolution="$(wavemill_resolve_pr_attempt "$issue" "$branch" "$BASE_BRANCH" "$head_sha" "$attempt_id" "$linear_state" "$challenge_pair" "$challenge_role")"
    classification="$(jq -r '.classification // "unverifiable"' <<<"$resolution" 2>/dev/null || echo "unverifiable")"
    if [[ "$classification" == "current-merged" && -n "$challenge_pair" ]]; then
      selected_pr="$(jq -r '.selectedCandidate.number // empty' <<<"$resolution" 2>/dev/null || true)"
      merged_challenge_pairs["$challenge_pair"]=1
      merged_challenge_prs["$challenge_pair"]="$selected_pr"
    fi
    jq -cn --argjson task "$task_json" --argjson attempt "$attempt_json" --argjson resolution "$resolution" \
      '{task: $task, attempt: $attempt, resolution: $resolution}' >> "$decisions_file"
  done < <(jq -c '.tasks[]' "$PLAN_FILE")

  while IFS= read -r decision_json; do
    [[ -n "$decision_json" ]] || continue
    task_json="$(jq -c '.task' <<<"$decision_json")"
    attempt_json="$(jq -c '.attempt' <<<"$decision_json")"
    resolution="$(jq -c '.resolution' <<<"$decision_json")"
    issue="$(jq -r '.issue // empty' <<<"$task_json")"
    slug="$(jq -r '.slug // empty' <<<"$task_json")"
    branch="$(jq -r '.branch // empty' <<<"$task_json")"
    worktree="$(jq -r '.worktreeDir // empty' <<<"$task_json")"
    linear_issue="$(jq -r '.linearIssueId // .issue // empty' <<<"$task_json")"
    challenge_pair="$(jq -r '.challengePairId // empty' <<<"$task_json")"
    classification="$(jq -r '.classification // "unverifiable"' <<<"$resolution" 2>/dev/null || echo "unverifiable")"

    if [[ -n "$challenge_pair" && -n "${merged_challenge_pairs[$challenge_pair]:-}" && "$classification" != "current-merged" ]]; then
      reason="challenge_sibling_current_pr_merged"
      selected_pr="${merged_challenge_prs[$challenge_pair]:-}"
      resolution="$(jq -c --arg reason "$reason" --arg pr "$selected_pr" '.classification = "current-merged" | .reason = $reason | .siblingPr = (if $pr == "" then null else $pr end)' <<<"$resolution")"
      wavemill_record_fresh_launch_reconciliation "$issue" "$slug" "$branch" "$worktree" "$linear_issue" "merged" "done" "$attempt_json" "$resolution" "fresh-launch-preflight"
      startup_log "SKIP: $issue suppressed because challenge pair $challenge_pair already has merged PR${selected_pr:+ #$selected_pr}"
      skipped_count=$((skipped_count + 1))
      continue
    fi

    case "$classification" in
      current-merged)
        wavemill_record_fresh_launch_reconciliation "$issue" "$slug" "$branch" "$worktree" "$linear_issue" "merged" "done" "$attempt_json" "$resolution" "fresh-launch-preflight"
        selected_pr="$(jq -r '.selectedCandidate.number // empty' <<<"$resolution" 2>/dev/null || true)"
        startup_log "SKIP: $issue already merged by PR${selected_pr:+ #$selected_pr}; no launch resources allocated"
        skipped_count=$((skipped_count + 1))
        ;;
      historical-closed)
        if wavemill_allocate_retry_attempt_identity "$issue" "$slug" "$branch" "$WORKTREE_ROOT" "$BASE_BRANCH" >/dev/null; then
          retry_branch="$WAVEMILL_ATTEMPT_BRANCH"
          retry_slug="$WAVEMILL_ATTEMPT_SLUG"
          retry_worktree="$WAVEMILL_ATTEMPT_WORKTREE"
          retry_attempt="$(wavemill_attempt_context_json "$issue" "$WAVEMILL_ATTEMPT_ID" "$branch" "$retry_branch" "$BASE_BRANCH" "fresh-launch-retry")"
          retry_task="$(jq -c \
            --arg slug "$retry_slug" \
            --arg branch "$retry_branch" \
            --arg worktreeDir "$retry_worktree" \
            --argjson attempt "$retry_attempt" \
            --argjson reconciliation "$resolution" \
            '.slug = $slug | .branch = $branch | .worktreeDir = $worktreeDir | .attempt = $attempt | .prReconciliation = $reconciliation' <<<"$task_json")"
          tasks_json="$(jq -cn --argjson tasks "$tasks_json" --argjson task "$retry_task" '$tasks + [$task]')"
          launchable_count=$((launchable_count + 1))
          startup_log "RETRY: $issue historical closed PR detected; launching $retry_branch"
        else
          wavemill_record_fresh_launch_reconciliation "$issue" "$slug" "$branch" "$worktree" "$linear_issue" "verification-required" "verification-required" "$attempt_json" "$resolution" "fresh-launch-preflight"
          startup_log "WARN: $issue fresh launch deferred; retry attempt identity could not be allocated"
          deferred_count=$((deferred_count + 1))
        fi
        ;;
      historical-merged|unverifiable)
        wavemill_record_fresh_launch_reconciliation "$issue" "$slug" "$branch" "$worktree" "$linear_issue" "verification-required" "verification-required" "$attempt_json" "$resolution" "fresh-launch-preflight"
        reason="$(jq -r '.reason // "pr_lineage_unverifiable"' <<<"$resolution" 2>/dev/null || echo "pr_lineage_unverifiable")"
        startup_log "WARN: $issue fresh launch deferred pending PR verification ($reason)"
        deferred_count=$((deferred_count + 1))
        ;;
      *)
        task_json="$(jq -c --argjson attempt "$attempt_json" --argjson reconciliation "$resolution" '.attempt = $attempt | .prReconciliation = $reconciliation' <<<"$task_json")"
        tasks_json="$(jq -cn --argjson tasks "$tasks_json" --argjson task "$task_json" '$tasks + [$task]')"
        launchable_count=$((launchable_count + 1))
        ;;
    esac
  done < "$decisions_file"
  rm -f "$decisions_file"

  tmp_plan="$(mktemp "${PLAN_FILE}.fresh.XXXXXX" 2>/dev/null || true)"
  if [[ -n "$tmp_plan" ]] && jq --argjson tasks "$tasks_json" '.tasks = $tasks' "$PLAN_FILE" > "$tmp_plan" 2>/dev/null; then
    mv "$tmp_plan" "$PLAN_FILE"
  else
    rm -f "$tmp_plan" 2>/dev/null || true
    return 1
  fi
  startup_stamp_fresh_plan_summary "$original_count" "$launchable_count" "$skipped_count" "$deferred_count"
  if (( skipped_count > 0 || deferred_count > 0 )); then
    startup_log "Fresh launch preflight: ${launchable_count} launchable, ${skipped_count} skipped, ${deferred_count} deferred"
  fi
}

seed_queued_tasks_from_plan() {
  local plan_file="$1"
  local queue_plan
  queue_plan=$(jq -c '.queuePlan // {}' "$plan_file")
  [[ "$queue_plan" == "{}" || "$queue_plan" == "[]" || "$queue_plan" == "null" ]] && return 0

  while IFS= read -r entry; do
    local issue_id blocker_issue_id blocker_pr desired_base linear_url slug title
    issue_id=$(printf '%s' "$entry" | jq -r '.issue_id')
    blocker_issue_id=$(printf '%s' "$entry" | jq -r '.blocker_issue_id')
    blocker_pr=$(printf '%s' "$entry" | jq -r '.blocker_pr_number // "null"')
    desired_base=$(printf '%s' "$entry" | jq -r '.desired_base_branch')
    linear_url=$(printf '%s' "$entry" | jq -r '.linear_issue_url // ""')
    slug=$(printf '%s' "$entry" | jq -r '.slug // ""')
    title=$(printf '%s' "$entry" | jq -r '.title // ""')

    [[ -z "$linear_url" ]] && linear_url="https://linear.app/issue/$issue_id"
    [[ -z "$blocker_issue_id" ]] && blocker_issue_id="unknown"
    [[ -z "$desired_base" ]] && desired_base="$blocker_issue_id"

    queue_add_task "$issue_id" "$blocker_issue_id" "$blocker_pr" "$desired_base" "$linear_url" "$slug" "$title"
  done < <(jq -c '
    .queuePlan as $qp
    | .tasks as $tasks
    | if ($qp | type) == "array" then
        $qp[] | select(.wave > 1)
        | .taskIds[] as $tid
        | ($tasks[] | select(.issue == $tid)) as $task
        | {
            issue_id: $tid,
            blocker_issue_id: ($task.dependsOn[0] // $task.baseFromTask // ""),
            blocker_pr_number: null,
            desired_base_branch: ($task.baseFromTask // ""),
            linear_issue_url: ($task.linearIssueUrl // ""),
            slug: ($task.slug // ""),
            title: ($task.title // "")
          }
      else
        $qp.queuedAfterDependencies[]? as $queued
        | $queued.taskId as $tid
        | ($tasks[] | select(.issue == $tid)) as $task
        | {
            issue_id: $tid,
            blocker_issue_id: ($queued.ancestors[0] // $task.dependsOn[0] // $task.baseFromTask // ""),
            blocker_pr_number: null,
            desired_base_branch: ($task.baseFromTask // ""),
            linear_issue_url: ($task.linearIssueUrl // ""),
            slug: ($task.slug // ""),
            title: ($task.title // "")
          }
      end
  ' "$plan_file")
}

write_monitor_env() {
  local tasks_file="$1"
  {
    write_shell_assignment "SESSION" "$SESSION"
    write_shell_assignment "WAVEMILL_RUN_EPOCH" "$WAVEMILL_RUN_EPOCH"
    write_shell_assignment "REPO_DIR" "$REPO_DIR"
    write_shell_assignment "WORKTREE_ROOT" "$WORKTREE_ROOT"
    write_shell_assignment "TOOLS_DIR" "$TOOLS_DIR"
    write_shell_assignment "LIB_DIR" "$LIB_DIR"
    write_shell_assignment "STATE_DIR" "$STATE_DIR"
    write_shell_assignment "STATE_FILE" "$STATE_FILE"
    write_shell_assignment "MERGE_QUEUE_SELECTION_FILE" "$STATE_DIR/merge-queue-selection.json"
    write_shell_assignment "POLL_SECONDS" "$POLL_SECONDS"
    write_shell_assignment "REQUIRE_CONFIRM" "$REQUIRE_CONFIRM"
    write_shell_assignment "WAVEMILL_BASE_BRANCH_SOURCE" "$WAVEMILL_BASE_BRANCH_SOURCE"
    write_shell_assignment "WAVEMILL_REQUIRE_CONFIRM_SOURCE" "$WAVEMILL_REQUIRE_CONFIRM_SOURCE"
    write_shell_assignment "WAVEMILL_MERGE_METHOD_SOURCE" "$WAVEMILL_MERGE_METHOD_SOURCE"
    write_shell_assignment "DRY_RUN" "$DRY_RUN"
    write_shell_assignment "BASE_BRANCH" "$BASE_BRANCH"
    write_shell_assignment "PROJECT_NAME" "$PROJECT_NAME"
    write_shell_assignment "PLANNING_MODE" "$PLANNING_MODE"
    write_shell_assignment "AGENT_CMD" "$AGENT_CMD"
    write_shell_assignment "AGENT_CMD_EXPLICIT" "$AGENT_CMD_EXPLICIT"
    write_shell_assignment "ROUTER_ENABLED" "$ROUTER_ENABLED"
    write_shell_assignment "MAX_PARALLEL" "$MAX_PARALLEL"
    write_shell_assignment "AUTO_EVAL" "$AUTO_EVAL"
    write_shell_assignment "ENTER_LAUNCHES_WAVE" "$ENTER_LAUNCHES_WAVE"
    write_shell_assignment "DASHBOARD_VERBOSITY" "$DASHBOARD_VERBOSITY"
    write_shell_assignment "DASHBOARD_LOG_TO_FILE" "$DASHBOARD_LOG_TO_FILE"
    write_shell_assignment "WAVEMILL_GIT_REMOTE_TIMEOUT_SECONDS" "${WAVEMILL_GIT_REMOTE_TIMEOUT_SECONDS:-}"
    write_shell_assignment "WAVEMILL_DASHBOARD_PID" "${WAVEMILL_DASHBOARD_PID:-}"
    write_shell_assignment "WAVEMILL_STATE_FILE" "$STATE_FILE"
    write_shell_assignment "MILL_LOG_FILE" "$MILL_LOG_FILE"
    write_shell_assignment "STATUS_LOG_FILE" "$STATUS_LOG_FILE"
    write_shell_assignment "TASKS_FILE" "$tasks_file"
    write_shell_assignment "CHALLENGE_AUTO_MERGE" "${CHALLENGE_AUTO_MERGE:-false}"
    write_shell_assignment "WAVEMILL_WINDOW_MILL" "$WAVEMILL_WINDOW_MILL"
    write_shell_assignment "WAVEMILL_WINDOW_BACKSTAGE" "$WAVEMILL_WINDOW_BACKSTAGE"
    write_shell_assignment "WAVEMILL_BACKSTAGE_TEND_PANE_TITLE" "$WAVEMILL_BACKSTAGE_TEND_PANE_TITLE"
    write_shell_assignment "WAVEMILL_BACKSTAGE_JOBS_PANE_TITLE" "$WAVEMILL_BACKSTAGE_JOBS_PANE_TITLE"
    write_shell_assignment "WAVEMILL_BACKSTAGE_QUEUE_PANE_TITLE" "$WAVEMILL_BACKSTAGE_QUEUE_PANE_TITLE"
    write_shell_assignment "WAVEMILL_BACKSTAGE_OBSERVER_PANE_TITLE" "$WAVEMILL_BACKSTAGE_OBSERVER_PANE_TITLE"
    # Plumb the monitor's own script/env paths so the control-pane health
    # watchdog can rebuild its launch command during recovery.
    write_shell_assignment "MONITOR_SCRIPT" "$MONITOR_SCRIPT"
    write_shell_assignment "MONITOR_ENV" "$MONITOR_ENV"
  } > "$MONITOR_ENV"
}

write_runtime_env_snapshot() {
  local issue="$1" snapshot_dir snapshot_file tmp_file merge_method
  [[ -n "$issue" && -n "${REPO_DIR:-}" ]] || return 0
  snapshot_dir="$REPO_DIR/.wavemill/runtime-env"
  snapshot_file="$snapshot_dir/$issue.json"
  mkdir -p "$snapshot_dir" 2>/dev/null || return 0
  tmp_file="$snapshot_file.tmp.$$"
  merge_method="${INTEGRATION_MERGE_METHOD:-squash}"
  jq -n \
    --arg issue "$issue" \
    --arg session "$SESSION" \
    --arg runEpoch "$WAVEMILL_RUN_EPOCH" \
    --arg baseBranch "$BASE_BRANCH" \
    --arg baseBranchSource "${WAVEMILL_BASE_BRANCH_SOURCE:-runtime-env}" \
    --arg requireConfirm "$REQUIRE_CONFIRM" \
    --arg requireConfirmSource "${WAVEMILL_REQUIRE_CONFIRM_SOURCE:-runtime-env}" \
    --arg mergeMethod "$merge_method" \
    --arg mergeMethodSource "${WAVEMILL_MERGE_METHOD_SOURCE:-repo-config}" \
    --arg capturedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{
      issue: $issue,
      session: $session,
      runEpoch: $runEpoch,
      baseBranch: $baseBranch,
      baseBranchSource: $baseBranchSource,
      requireConfirm: ($requireConfirm == "true"),
      requireConfirmSource: $requireConfirmSource,
      mergeMethod: $mergeMethod,
      mergeMethodSource: $mergeMethodSource,
      capturedAt: $capturedAt
    }' > "$tmp_file" 2>/dev/null && mv "$tmp_file" "$snapshot_file" 2>/dev/null || rm -f "$tmp_file"
}

setup_control_dashboard() {
  [[ "${DRY_RUN:-false}" == "true" ]] && return 0
  local status_script="$LIB_DIR/wavemill-status.sh"
  local pane_count
  pane_count=$(tmux list-panes -t "$SESSION:$WAVEMILL_WINDOW_MILL" -F '#{pane_index}' | wc -l | tr -d ' ')
  if [[ "$pane_count" -eq 1 ]]; then
    # Split 1: vertical split — top-left (pane 0, 35%) / bottom-left (pane 1, 65%)
    tmux split-window -t "$SESSION:$WAVEMILL_WINDOW_MILL.0" -v -p 65
    # Split 2: full-height horizontal — right pane (pane 2, 50%) spans full window height
    tmux split-window -t "$SESSION:$WAVEMILL_WINDOW_MILL.0" -h -f -p 50
  elif [[ "$pane_count" -eq 2 ]]; then
    tmux split-window -t "$SESSION:$WAVEMILL_WINDOW_MILL.0" -h -f -p 50
  fi
  # Pane 0 = top-left (monitor, set later in main)
  # Pane 1 = bottom-left (dashboard)
  # Pane 2 = right full-height (status log)
  tmux respawn-pane -k -t "$SESSION:$WAVEMILL_WINDOW_MILL.1" "'$status_script' '$SESSION' '$WORKTREE_ROOT' '$STATE_FILE'"

  WAVEMILL_DASHBOARD_PID=""
  for attempt in {1..10}; do
    WAVEMILL_DASHBOARD_PID="$(tmux list-panes -t "$SESSION:$WAVEMILL_WINDOW_MILL.1" -F '#{pane_pid}' 2>/dev/null || true)"
    [[ -n "$WAVEMILL_DASHBOARD_PID" ]] && break
    sleep 0.1
  done

  if [[ -n "${WAVEMILL_DASHBOARD_PID:-}" ]]; then
    tmux set-environment -t "$SESSION" WAVEMILL_DASHBOARD_PID "$WAVEMILL_DASHBOARD_PID"
  fi
  tmux set-environment -t "$SESSION" WAVEMILL_STATE_FILE "$STATE_FILE" 2>/dev/null || true

  tmux respawn-pane -k -t "$SESSION:$WAVEMILL_WINDOW_MILL.2" "bash -c \"clear && printf 'Wavemill Status Log\\n\\n' && tail -n 200 -f '$STATUS_LOG_FILE'\""
  tmux select-pane -t "$SESSION:$WAVEMILL_WINDOW_MILL.0"
}

spawn_integration_window() {
  [[ "${DRY_RUN:-false}" == "true" ]] && return 0
  local merged enabled use_mill_session observer_enabled observer_interval observer_max_log_lines
  local integration_cmd observer_cmd status_script jobs_cmd queue_cmd tend_pane right_top_pane right_bottom_pane observer_pane backstage_health_file
  local backstage_exists=false tend_result jobs_result queue_result observer_result tend_action jobs_action queue_action observer_action
  local tend_killed=0 jobs_killed=0 queue_killed=0 observer_killed=0 created_layout=false observer_instance_count=0

  merged="$(wavemill_load_config "$REPO_DIR")"
  enabled="$(printf '%s' "$merged" | jq -r '.integration.enabled // false' 2>/dev/null || echo false)"
  use_mill_session="$(printf '%s' "$merged" | jq -r '.integration.useMillSession // true' 2>/dev/null || echo true)"

  if [[ "$enabled" != "true" || "$use_mill_session" != "true" ]]; then
    return 0
  fi

  observer_enabled=false
  if wavemill_observer_config_enabled "$merged"; then
    observer_enabled=true
  fi

  startup_log "Starting backstage window (tend loop + background status)..."
  if [[ "$observer_enabled" == "true" ]]; then
    observer_interval="$(wavemill_observer_interval_seconds "$merged")"
    startup_log "Observer: enabled (interval=${observer_interval}s)"
  else
    startup_log "Observer: disabled (opt-in; enable via .observer.enabled in .wavemill-config.json; see HOK-2594)"
  fi
  WORKTREE_ROOT="${WORKTREE_ROOT:-$REPO_DIR}"
  integration_cmd="$(wavemill_build_tend_loop_command "$SESSION" "$REPO_DIR" "$TOOLS_DIR" "integration")"
  if tmux list-windows -t "$SESSION" -F '#{window_name}' 2>/dev/null | grep -Fxq "$WAVEMILL_WINDOW_BACKSTAGE"; then
    backstage_exists=true
    startup_log "Backstage window already exists; reconciling panes"
  fi

  if [[ "$backstage_exists" == "true" ]]; then
    tend_result="$(wavemill_reconcile_backstage_service_pane "$SESSION" "$WAVEMILL_WINDOW_BACKSTAGE" "$WAVEMILL_BACKSTAGE_TEND_PANE_TITLE" "$integration_cmd" "reuse" "$SESSION:$WAVEMILL_WINDOW_BACKSTAGE.0" -h -b -p 60 -c "$REPO_DIR" || true)"
    IFS=$'\t' read -r tend_pane tend_action tend_killed <<< "$tend_result"
  else
    tmux new-window -d -t "$SESSION" -n "$WAVEMILL_WINDOW_BACKSTAGE" -c "$REPO_DIR" "$integration_cmd" >/dev/null
    tend_pane="$(tmux display-message -p -t "$SESSION:$WAVEMILL_WINDOW_BACKSTAGE.0" '#{pane_id}' 2>/dev/null || true)"
    tend_action="created"
  fi

  if [[ -n "$tend_pane" ]]; then
    wavemill_set_tmux_pane_title "$tend_pane" "$WAVEMILL_BACKSTAGE_TEND_PANE_TITLE"
    if [[ "$tend_action" == "created" || "$tend_action" == "respawned" ]]; then
      wavemill_capture_tend_pane_output "$tend_pane" "$SESSION" "$REPO_DIR"
    fi
  fi

  status_script="${LIB_DIR:-$REPO_DIR/shared/lib}/wavemill-status.sh"
  printf -v jobs_cmd "'%s' --pane=jobs '%s' '%s' '%s'" "$status_script" "$SESSION" "$WORKTREE_ROOT" "$STATE_FILE"
  printf -v queue_cmd "'%s' --pane=queued-pending '%s' '%s' '%s'" "$status_script" "$SESSION" "$WORKTREE_ROOT" "$STATE_FILE"

  jobs_result="$(wavemill_reconcile_backstage_service_pane "$SESSION" "$WAVEMILL_WINDOW_BACKSTAGE" "$WAVEMILL_BACKSTAGE_JOBS_PANE_TITLE" "$jobs_cmd" "restart" "${tend_pane:-$SESSION:$WAVEMILL_WINDOW_BACKSTAGE.0}" -h -p 40 || true)"
  IFS=$'\t' read -r right_top_pane jobs_action jobs_killed <<< "$jobs_result"
  [[ "$jobs_action" == "created" ]] && created_layout=true

  queue_result="$(wavemill_reconcile_backstage_service_pane "$SESSION" "$WAVEMILL_WINDOW_BACKSTAGE" "$WAVEMILL_BACKSTAGE_QUEUE_PANE_TITLE" "$queue_cmd" "restart" "${right_top_pane:-$tend_pane}" -v -p 50 || true)"
  IFS=$'\t' read -r right_bottom_pane queue_action queue_killed <<< "$queue_result"
  [[ "$queue_action" == "created" ]] && created_layout=true

  if [[ "$observer_enabled" == "true" ]]; then
    observer_max_log_lines="$(wavemill_observer_max_log_lines "$merged")"
    observer_cmd="$(wavemill_build_observer_loop_command "$SESSION" "$REPO_DIR" "$TOOLS_DIR" "$observer_interval" "$observer_max_log_lines")"
    local observer_split_target="${right_bottom_pane:-${right_top_pane:-$tend_pane}}"
    observer_result="$(wavemill_reconcile_backstage_service_pane "$SESSION" "$WAVEMILL_WINDOW_BACKSTAGE" "$WAVEMILL_BACKSTAGE_OBSERVER_PANE_TITLE" "$observer_cmd" "reuse" "$observer_split_target" -v -p 50 -c "$REPO_DIR" || true)"
    IFS=$'\t' read -r observer_pane observer_action observer_killed <<< "$observer_result"
    [[ "$observer_killed" =~ ^[0-9]+$ ]] || observer_killed=0
    [[ "$observer_action" == "created" ]] && created_layout=true
    observer_instance_count="$(wavemill_list_backstage_panes_by_title "$SESSION" "$WAVEMILL_WINDOW_BACKSTAGE" "$WAVEMILL_BACKSTAGE_OBSERVER_PANE_TITLE" 2>/dev/null | wc -l | tr -d ' ' || true)"
    [[ "$observer_instance_count" =~ ^[0-9]+$ ]] || observer_instance_count=0
    if (( observer_killed > 0 )); then
      startup_log "Warning: reconciled ${observer_killed} duplicate Observer pane(s)"
    fi
  else
    while IFS=$'\t' read -r observer_pane _dead; do
      [[ -n "$observer_pane" ]] || continue
      tmux kill-pane -t "$observer_pane" >/dev/null 2>&1 || true
    done < <(wavemill_list_backstage_panes_by_title "$SESSION" "$WAVEMILL_WINDOW_BACKSTAGE" "$WAVEMILL_BACKSTAGE_OBSERVER_PANE_TITLE" 2>/dev/null || true)
  fi

  tmux set-window-option -u -t "$SESSION:$WAVEMILL_WINDOW_BACKSTAGE" window-status-style >/dev/null 2>&1 || true
  tmux set-window-option -u -t "$SESSION:$WAVEMILL_WINDOW_BACKSTAGE" window-status-current-style >/dev/null 2>&1 || true
  tmux set-option -t "$SESSION:$WAVEMILL_WINDOW_BACKSTAGE" remain-on-exit off >/dev/null 2>&1 || true
  if [[ "$backstage_exists" == "true" && "$created_layout" == "true" ]]; then
    tmux select-layout -t "$SESSION:$WAVEMILL_WINDOW_BACKSTAGE" tiled >/dev/null 2>&1 || true
  fi
  # Findings deserve more room than a repeated one-line poll status, so give the
  # observer the larger pane. No-ops once the observer already holds it.
  if [[ "$observer_enabled" == "true" ]]; then
    wavemill_promote_observer_pane "${observer_pane:-}" "${tend_pane:-}" || true
  fi
  backstage_health_file="$(wavemill_backstage_health_file "$STATE_DIR" 2>/dev/null || true)"
  if [[ -n "$backstage_health_file" ]]; then
    wavemill_write_backstage_health "$backstage_health_file" "healthy" "backstage tend loop is running" 0 "" "$tend_pane" 1
    if [[ "$observer_enabled" == "true" && -n "${observer_pane:-}" ]]; then
      local observer_detail="backstage observer loop is running"
      if (( observer_killed > 0 )); then
        observer_detail="backstage observer loop is running (reconciled ${observer_killed} duplicate pane(s))"
      fi
      wavemill_write_backstage_service_health "$backstage_health_file" "observer" "healthy" "$observer_detail" 0 "" "$observer_pane" "" "$observer_instance_count"
    elif [[ "$observer_enabled" != "true" && -f "$backstage_health_file" ]] && jq -e '.services.observer? != null' "$backstage_health_file" >/dev/null 2>&1; then
      wavemill_write_backstage_service_health "$backstage_health_file" "observer" "disabled" "observer is disabled by config" 0 "" "" "" 0
    fi
  fi
  startup_log "✓ Backstage window running."
}

should_update_linear_for_task() {
  local challenge_role="$1"
  [[ "$challenge_role" != "challenger" ]]
}

startup_mark_remaining_skipped() {
  local task_id="$1" current_col="$2"
  local cols=(route worktree deps agent linear)
  local seen_current=false col
  [[ "${WAVEMILL_NO_PROGRESS:-0}" == "1" ]] && return 0
  for col in "${cols[@]}"; do
    if [[ "$col" == "$current_col" ]]; then
      seen_current=true
      continue
    fi
    [[ "$seen_current" == "true" ]] && progress_update "$task_id" "$col" skipped
  done
}

startup_phase_failed() {
  local task_id="$1" col="$2" issue="$3" message="$4"
  [[ "${WAVEMILL_NO_PROGRESS:-0}" != "1" ]] && progress_update "$task_id" "$col" failed "$message"
  startup_mark_remaining_skipped "$task_id" "$col"
  startup_log "✗ $issue FAILED at $col: $message"
}

# Detect which package manager (if any) needs to run for a fresh worktree.
# Outputs three lines: pm, lockfile, install_cmd.
# Returns 1 when no install is needed (no lockfile, or node_modules already
# present, or the package manager binary is missing).
# Callers can capture stdout with process substitution or mapfile.
_detect_worktree_pm() {
  local wt_dir="$1" issue="$2"
  local pm="" lockfile="" install_cmd=""

  if [[ -f "$wt_dir/pnpm-lock.yaml" ]]; then
    pm="pnpm"; lockfile="pnpm-lock.yaml"
    install_cmd="pnpm install --frozen-lockfile --prefer-offline"
  elif [[ -f "$wt_dir/yarn.lock" ]]; then
    pm="yarn"; lockfile="yarn.lock"
    install_cmd="yarn install --frozen-lockfile --prefer-offline"
  elif [[ -f "$wt_dir/package-lock.json" ]]; then
    pm="npm"; lockfile="package-lock.json"
    install_cmd="npm ci --prefer-offline"
  else
    return 1
  fi

  if [[ -d "$wt_dir/node_modules" ]]; then
    return 1
  fi

  if ! command -v "$pm" >/dev/null 2>&1; then
    startup_log "  Warning: $lockfile present but '$pm' not on PATH; skipping dep install"
    return 1
  fi

  printf '%s\n' "$pm" "$lockfile" "$install_cmd"
  return 0
}

# Run the package manager install inside the already-created tmux pane so that
# the user sees live output while the runner waits for a per-task sentinel file.
# Args: wt_dir  issue  session  win  pm  install_cmd
# Returns 0 on success, 1 on failure or timeout.
ensure_worktree_dependencies_in_pane() {
  local wt_dir="$1" issue="$2" session="$3" win="$4" pm="$5" install_cmd="$6"

  local sentinel_file="/tmp/wavemill-${session}-${issue}-deps.exit"
  local sentinel_script="/tmp/wavemill-${session}-${issue}-deps.sh"
  rm -f "$sentinel_file"

  local wt_dir_q install_cmd_q sentinel_file_q
  printf -v wt_dir_q '%q' "$wt_dir"
  printf -v install_cmd_q '%q' "$install_cmd"
  printf -v sentinel_file_q '%q' "$sentinel_file"

  cat > "$sentinel_script" <<INSTALL_EOF
#!/usr/bin/env bash
printf '\\n[wavemill] Installing dependencies ($pm)...\\n'
cd $wt_dir_q
$install_cmd
__wavemill_rc=\$?
printf '%s\\n' "\$__wavemill_rc" > $sentinel_file_q
if [[ "\$__wavemill_rc" -ne 0 ]]; then
  printf '[wavemill] ✗ Dependency install FAILED (exit %s)\\n' "\$__wavemill_rc"
  printf '[wavemill] Task will not be launched. Retry with: wavemill mill\\n'
else
  printf '[wavemill] ✓ Dependencies installed successfully\\n'
fi
INSTALL_EOF
  chmod +x "$sentinel_script"

  local script_q
  printf -v script_q '%q' "$sentinel_script"
  tmux send-keys -t "$session:$win" "bash $script_q" Enter

  # Poll up to 5 minutes (600 × 0.5 s) for the sentinel.
  local poll_count=0 timeout_polls=600
  while (( poll_count < timeout_polls )); do
    [[ -f "$sentinel_file" ]] && break
    sleep 0.5
    poll_count=$(( poll_count + 1 ))
  done

  rm -f "$sentinel_script"

  if [[ ! -f "$sentinel_file" ]]; then
    local elapsed=$(( poll_count / 2 ))
    startup_log "✗ $issue: dependency install timed out after ${elapsed}s"
    startup_log "  See the task pane for details"
    [[ -n "${STARTUP_TASK_LOG_FILE:-}" ]] && \
      printf '  %s install timed out after %ss - see task pane\n' "$pm" "$elapsed" >> "$STARTUP_TASK_LOG_FILE"
    return 1
  fi

  local rc
  rc="$(cat "$sentinel_file")"
  rm -f "$sentinel_file"

  if [[ "${rc:-1}" -ne 0 ]]; then
    startup_log "✗ $issue FAILED at step [3/7]: $pm install (exit $rc)"
    startup_log "  See the task pane for full output"
    [[ -n "${STARTUP_TASK_LOG_FILE:-}" ]] && \
      printf '  %s install failed (exit %s) - see task pane\n' "$pm" "$rc" >> "$STARTUP_TASK_LOG_FILE"
    return 1
  fi

  return 0
}

challenge_selection_health_stage() {
  case "${1:-}" in
    plan|planning|planner) printf '%s\n' "plan" ;;
    review|reviewer) printf '%s\n' "review" ;;
    implementation|coding|coder) printf '%s\n' "implementation" ;;
    *) printf '%s\n' "${1:-implementation}" ;;
  esac
}

challenge_selection_health_varied_model() {
  local stage
  stage="$(challenge_selection_health_stage "${1:-implementation}")"
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
      --stage "$(challenge_selection_health_stage "$stage")" \
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
      --stage "$(challenge_selection_health_stage "$stage")" \
      --model "$model"
  ) >/dev/null 2>&1 || true
}

startup_run_task_phases() {
  local task_json="$1" ordinal="${2:-}" total="${3:-}"
  local issue slug title branch wt_dir linear_issue task_packet_file details_file issue_json_file
  local planner_model coder_model reviewer_model plan_depth code_depth review_mode route_max_cost_usd
  local challenge challenge_pair challenge_role challenge_model challenge_stage task_agent win
  local depends_on base_from_task
  local packet_content issue_json issue_description issue_context details_context labels_json
  local feature_dir status_file planning_prompt instr_file created_window created_window_id state_written created_new=false planner_launch_model
  local attempt_json pr_reconciliation_json preflight_pr

  local startup_id
  startup_id="$(echo "$task_json" | jq -r '.startupId // empty')"
  issue="$(echo "$task_json" | jq -r '.issue')"
  write_runtime_env_snapshot "$issue"
  [[ -z "$startup_id" || "$startup_id" == "null" ]] && startup_id="${ordinal:-1}"
  [[ -z "$ordinal" ]] && ordinal="$startup_id"
  if [[ -z "$total" ]]; then
    total="$(echo "$task_json" | jq -r '.startupTotal // empty')"
  fi
  slug="$(echo "$task_json" | jq -r '.slug')"
  title="$(echo "$task_json" | jq -r '.title')"
  branch="$(echo "$task_json" | jq -r '.branch')"
  wt_dir="$(echo "$task_json" | jq -r '.worktreeDir')"
  linear_issue="$(echo "$task_json" | jq -r '.linearIssueId // .issue')"
  task_packet_file="$(echo "$task_json" | jq -r '.taskPacketFile')"
  details_file="$(echo "$task_json" | jq -r '.taskPacketDetailsFile')"
  issue_json_file="$(echo "$task_json" | jq -r '.issueJsonFile')"
  planner_model="$(echo "$task_json" | jq -r '.route.planner // empty')"
  coder_model="$(echo "$task_json" | jq -r '.route.coder // empty')"
  reviewer_model="$(echo "$task_json" | jq -r '.route.reviewer // empty')"
  plan_depth="$(echo "$task_json" | jq -r '.route.planDepth // "light"')"
  code_depth="$(echo "$task_json" | jq -r '.route.codeDepth // "medium"')"
  review_mode="$(echo "$task_json" | jq -r '.route.reviewMode // "static"')"
  route_max_cost_usd="$(echo "$task_json" | jq -r '.route.maxCostUsd // empty')"
  challenge="$(echo "$task_json" | jq -r '.challenge // false')"
  challenge_pair="$(echo "$task_json" | jq -r '.challengePairId // empty')"
  challenge_role="$(echo "$task_json" | jq -r '.challengeRole // empty')"
  challenge_model="$(echo "$task_json" | jq -r '.challengeModel // empty')"
  challenge_stage="$(echo "$task_json" | jq -r '.challengeStage // empty')"
  task_agent="$(echo "$task_json" | jq -r '.agent // empty')"
  attempt_json="$(echo "$task_json" | jq -c '.attempt // empty' 2>/dev/null || true)"
  pr_reconciliation_json="$(echo "$task_json" | jq -c '.prReconciliation // empty' 2>/dev/null || true)"
  preflight_pr="$(echo "$task_json" | jq -r 'if (.prReconciliation.classification // "") == "current-open" then (.prReconciliation.selectedCandidate.number // empty) else empty end' 2>/dev/null || true)"
  # Parsed but intentionally unused; behavior change ships in follow-up.
  depends_on="$(echo "$task_json" | jq -c '.dependsOn // []')"
  base_from_task="$(echo "$task_json" | jq -r '.baseFromTask // empty')"
  STARTUP_TASK_LOG_FILE=""
  if [[ "${WAVEMILL_NO_PROGRESS:-0}" != "1" ]]; then
    STARTUP_TASK_LOG_FILE="/tmp/wavemill-${SESSION}-${issue}.startup.log"
    : > "$STARTUP_TASK_LOG_FILE"
    progress_update "$startup_id" issue "$issue"
    progress_update "$startup_id" route running
  fi

  if ! [[ "$issue" =~ ^[A-Z]+-[0-9]+(_c)?$|^[a-z0-9-]+$ ]]; then
    startup_phase_failed "$startup_id" route "$issue" "invalid issue id"
    return 1
  fi

  if [[ -f "${STATE_FILE:-}" ]] && jq -e --arg issue "$issue" '.tasks[$issue]? != null' "$STATE_FILE" >/dev/null 2>&1; then
    local persisted_outcome rehydration_eligibility rehydration_reason
    persisted_outcome="$(jq -r --arg issue "$issue" "$(task_lifecycle_jq_filter '(.tasks[$issue] // {}) | wm_workflow_outcome')" "$STATE_FILE" 2>/dev/null || echo active)"
    rehydration_eligibility="$(jq -r --arg issue "$issue" '.tasks[$issue].rehydration.eligibility // empty' "$STATE_FILE" 2>/dev/null || true)"
    rehydration_reason="$(jq -r --arg issue "$issue" '.tasks[$issue].rehydration.reason // empty' "$STATE_FILE" 2>/dev/null || true)"
    if [[ "$persisted_outcome" != "active" ]] \
      || [[ "$rehydration_eligibility" == terminal* || "$rehydration_eligibility" == "verification-required" ]]; then
      startup_task_log "$issue" "$issue launch skipped: persisted task is not rehydratable (${rehydration_eligibility:-outcome:$persisted_outcome}${rehydration_reason:+:$rehydration_reason})"
      [[ "${WAVEMILL_NO_PROGRESS:-0}" != "1" ]] && progress_update "$startup_id" route done
      STARTUP_TASK_LOG_FILE=""
      return 0
    fi
  fi

  [[ -z "$task_agent" ]] && task_agent="$AGENT_CMD"
  [[ -z "$coder_model" && -n "$challenge_model" ]] && coder_model="$challenge_model"
  [[ -z "$coder_model" && -n "$FORCE_MODEL" ]] && coder_model="$FORCE_MODEL"

  if ! agent_validate "$task_agent"; then
    startup_phase_failed "$startup_id" route "$issue" "agent unavailable"
    return 1
  fi
  if [[ "$DRY_RUN" != "true" && "$task_agent" != "$AGENT_CMD" ]] && ! agent_check_auth "$task_agent" "$coder_model" "$REPO_DIR"; then
    startup_phase_failed "$startup_id" route "$issue" "agent unauthenticated"
    return 1
  fi

  if [[ "${WAVEMILL_NO_PROGRESS:-0}" == "1" ]]; then
    startup_log ""
    startup_task_log "$issue" "── Task ${ordinal}/${total}: $issue ($slug) ──"
    startup_task_log "$issue" "[${ordinal}/${total}] launching $issue"
  else
    startup_task_log "$issue" "── Task $issue ($slug) ──"
    progress_update "$startup_id" route done
    progress_update "$startup_id" worktree running
  fi

  if [[ -d "$wt_dir" ]]; then
    startup_step "[1/7] Reusing worktree...       ✓"
  else
    local worktree_stderr
    worktree_stderr="$(mktemp)"
    if git show-ref --verify --quiet "refs/heads/$branch"; then
      local resolved_path
      if ! resolved_path="$(wavemill_lock_run "git-worktree" ensure_worktree "$branch" "$wt_dir" 2>"$worktree_stderr")"; then
        startup_phase_failed "$startup_id" worktree "$issue" "worktree creation"
        startup_log "  Error: failed to attach existing branch $branch"
        [[ -s "$worktree_stderr" ]] && sed 's/^/  git: /' "$worktree_stderr" >> "$STATUS_LOG_FILE"
        [[ -s "$worktree_stderr" && -n "${STARTUP_TASK_LOG_FILE:-}" ]] && sed 's/^/  git: /' "$worktree_stderr" >> "$STARTUP_TASK_LOG_FILE"
        rm -f "$worktree_stderr"
        startup_log "  Task will not be launched. Retry with: wavemill mill"
        return 1
      fi
      wt_dir="$resolved_path"
    else
      local worktree_base_ref="${RESOLVED_BASE_REF:-origin/$BASE_BRANCH}"
      if ! wavemill_lock_run "git-worktree" git worktree add "$wt_dir" -b "$branch" "$worktree_base_ref" >/dev/null 2>"$worktree_stderr"; then
        startup_phase_failed "$startup_id" worktree "$issue" "worktree creation"
        startup_log "  Error: failed to create $branch from $worktree_base_ref"
        [[ -s "$worktree_stderr" ]] && sed 's/^/  git: /' "$worktree_stderr" >> "$STATUS_LOG_FILE"
        [[ -s "$worktree_stderr" && -n "${STARTUP_TASK_LOG_FILE:-}" ]] && sed 's/^/  git: /' "$worktree_stderr" >> "$STARTUP_TASK_LOG_FILE"
        rm -f "$worktree_stderr"
        startup_log "  Task will not be launched. Retry with: wavemill mill"
        return 1
      fi
      created_new=true
    fi
    rm -f "$worktree_stderr"
    startup_step "[1/7] Creating worktree...     ✓"
  fi

  # Propagate the per-developer overlay (.wavemill-config.local.json) into the
  # worktree if one exists in the parent repo. The overlay is gitignored, so
  # `git worktree add` doesn't bring it along — without this copy, ready
  # checks and other tools running inside the worktree only see the base
  # config and silently miss the developer's overrides (e.g. anchored
  # migrationPatterns or integration.enabled). Done unconditionally so we
  # also self-heal worktrees created by older mill versions.
  if [[ -f "$REPO_DIR/.wavemill-config.local.json" ]]; then
    cp "$REPO_DIR/.wavemill-config.local.json" "$wt_dir/.wavemill-config.local.json"
  fi

  [[ "${WAVEMILL_NO_PROGRESS:-0}" != "1" ]] && progress_update "$startup_id" worktree done

  AGENT_CMD="$task_agent"
  pretrust_directory "$wt_dir"
  startup_step "[2/7] Pre-trusting directory... ✓"

  # Create the task tmux window immediately after the worktree is ready so all
  # task windows appear before any dependency installs begin. The deps install
  # runs inside this pane so users see live progress.
  win="$issue-$slug"
  if [[ "$DRY_RUN" == "true" ]]; then
    startup_step "[3/7] Creating tmux window...   [DRY-RUN skip]"
  else
    wavemill_lock_run "tmux-win" tmux new-window -d -t "$SESSION" -n "$win" -c "$wt_dir" >/dev/null
    created_window_id="$(tmux display-message -p -t "$SESSION:$win" '#{window_id}' 2>/dev/null || true)"
    tmux set-window-option -u -t "$SESSION:$win" window-status-style >/dev/null 2>&1 || true
    tmux set-window-option -u -t "$SESSION:$win" window-status-current-style >/dev/null 2>&1 || true
    tmux set-option -t "$SESSION:$win" remain-on-exit on >/dev/null 2>&1 || true
    created_window=true
    startup_step "[3/7] Creating tmux window...   ✓"
  fi

  # Detect whether a dependency install is needed, then run it inside the task
  # pane so users see live output. The agent is not launched until the install
  # succeeds.
  local _deps_pm="" _deps_lockfile="" _deps_cmd="" _deps_needed=false
  local _detect_out
  if _detect_out="$(_detect_worktree_pm "$wt_dir" "$issue")"; then
    _deps_pm="$(printf '%s' "$_detect_out" | sed -n '1p')"
    _deps_lockfile="$(printf '%s' "$_detect_out" | sed -n '2p')"
    _deps_cmd="$(printf '%s' "$_detect_out" | sed -n '3p')"
    _deps_needed=true
  fi

  if [[ "$_deps_needed" == "true" ]]; then
    [[ "${WAVEMILL_NO_PROGRESS:-0}" != "1" ]] && progress_update "$startup_id" deps running
    if [[ "$DRY_RUN" == "true" ]]; then
      startup_step "[3.5/7] Installing deps ($_deps_pm)... [DRY-RUN skip]"
      [[ "${WAVEMILL_NO_PROGRESS:-0}" != "1" ]] && progress_update "$startup_id" deps done
    elif ! ensure_worktree_dependencies_in_pane "$wt_dir" "$issue" "$SESSION" "$win" "$_deps_pm" "$_deps_cmd"; then
      # Keep the window open so the user can inspect the install failure.
      # Only remove a freshly created worktree if we can't reuse it later.
      if [[ -n "${created_new:-}" && "$created_new" == "true" ]]; then
        local cleanup_rc=0
        safe_remove_task_worktree_and_branch "$wt_dir" "$branch" "$(effective_task_base_branch "$issue" 2>/dev/null || printf '%s\n' "${BASE_BRANCH:-main}")" "startup_dependency_failure" "$issue" "" || cleanup_rc=$?
        if [[ "$cleanup_rc" -eq 10 ]] || cleanup_outcome_is_retain; then
          startup_log "WARN: $issue dependency-failure cleanup preserved local work (${WAVEMILL_CLEANUP_OUTCOME:-unclassified})"
        elif [[ "$cleanup_rc" -ne 0 ]]; then
          startup_log "WARN: $issue dependency-failure cleanup failed (${WAVEMILL_CLEANUP_OUTCOME:-operation_failed})"
        fi
      fi
      startup_phase_failed "$startup_id" deps "$issue" "dependency install"
      return 1
    else
      [[ "${WAVEMILL_NO_PROGRESS:-0}" != "1" ]] && progress_update "$startup_id" deps done
      startup_step "[3.5/7] Installing deps ($_deps_pm)... ✓"
    fi
  else
    [[ "${WAVEMILL_NO_PROGRESS:-0}" != "1" ]] && progress_update "$startup_id" deps done
  fi

  [[ "${WAVEMILL_NO_PROGRESS:-0}" != "1" ]] && progress_update "$startup_id" agent running

  packet_content="$(cat "$task_packet_file" 2>/dev/null || true)"
  issue_json="$(cat "$issue_json_file" 2>/dev/null || echo '{}')"
  issue_description="$(echo "$issue_json" | jq -r '.description // ""' 2>/dev/null || echo "")"
  labels_json="$(echo "$issue_json" | jq '[.labels.nodes[]?.name // empty]' 2>/dev/null || echo '[]')"
  status_file="/tmp/${SESSION}-${issue}-status.txt"
  feature_dir="$wt_dir/features/$slug"
  mkdir -p "$feature_dir"
  reset_startup_phase_artifacts "$feature_dir"

  if [[ -f "$details_file" ]]; then
    if [[ "$PLANNING_MODE" == "interactive" ]]; then
      cp "$details_file" "$feature_dir/task-packet-details.md"
      [[ -f "$task_packet_file" ]] && cp "$task_packet_file" "$feature_dir/task-packet-header.md"
      details_context="
📖 Full Details: Comprehensive task packet with all 9 sections available at:
   features/$slug/task-packet-details.md"
    else
      cp "$details_file" "$wt_dir/task-packet-details.md"
      [[ -f "$task_packet_file" ]] && cp "$task_packet_file" "$wt_dir/task-packet-header.md"
      details_context="
📖 Full Details: Read task-packet-details.md in the repo root for implementation constraints and validation steps."
    fi
  else
    details_context=""
  fi

  issue_context="Issue Description:
${issue_description:-$packet_content}
$details_context"

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

  local bootstrap_router_mode
  bootstrap_router_mode="$(npx tsx "$TOOLS_DIR/get-operating-mode.ts" global --repo-dir "$REPO_DIR" 2>/dev/null || echo "normal")"

  local startup_route_file="/tmp/${SESSION}-${issue}-route.json"
  if [[ -f "$startup_route_file" ]] && jq -e '.planner and .coder and .reviewer' "$startup_route_file" >/dev/null 2>&1; then
    jq \
      --arg planner "${planner_model:-gpt-5.6-terra}" \
      --arg coder "${coder_model:-gpt-5.5}" \
      --arg reviewer "${reviewer_model:-gpt-5.6-terra}" \
      --arg planDepth "$plan_depth" \
      --arg codeDepth "$code_depth" \
      --arg reviewMode "$review_mode" \
      --arg source "bootstrap" \
      --arg inputKind "issue" \
      --arg inputPath "features/$slug/selected-task.json" \
      --arg routerMode "$bootstrap_router_mode" \
      --argjson maxCostUsd "${route_max_cost_usd:-null}" \
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
          routerMode: (if (($p.routerMode // "") == "") then $routerMode else $p.routerMode end)
        })
      | if $maxCostUsd == null
        then .
        else .maxCostUsd = $maxCostUsd | .constraints = ((.constraints // {}) + {maxCostUsd: $maxCostUsd})
        end' "$startup_route_file" \
      | write_json_artifact "$feature_dir/.routing-complete"
  else
    jq -n \
      --arg planner "${planner_model:-gpt-5.6-terra}" \
      --arg coder "${coder_model:-gpt-5.5}" \
      --arg reviewer "${reviewer_model:-gpt-5.6-terra}" \
      --arg planDepth "$plan_depth" \
      --arg codeDepth "$code_depth" \
      --arg reviewMode "$review_mode" \
      --arg source "bootstrap" \
      --arg inputKind "issue" \
      --arg inputPath "features/$slug/selected-task.json" \
      --arg routerMode "$bootstrap_router_mode" \
      --argjson maxCostUsd "${route_max_cost_usd:-null}" \
      '{
        planner: $planner,
        coder: $coder,
        reviewer: $reviewer,
        planDepth: $planDepth,
        codeDepth: $codeDepth,
        reviewMode: $reviewMode,
        reviewRecommended: $reviewMode,
        provenance: {
          source: $source,
          inputKind: $inputKind,
          inputPath: $inputPath,
          inputHash: "",
          routedAt: (now | todateiso8601),
          routerMode: $routerMode
        }
      } + (if $maxCostUsd == null then {} else {maxCostUsd: $maxCostUsd} end)' \
      | write_json_artifact "$feature_dir/.routing-complete"
  fi
  if [[ -f "$feature_dir/.initial-route.json" ]]; then
    startup_log "  Keeping existing .initial-route.json for $issue"
  else
    jq '.provenance.source = "bootstrap"' "$feature_dir/.routing-complete" \
      | write_json_artifact "$feature_dir/.initial-route.json"
  fi
  local bootstrap_route
  bootstrap_route="$(route_lifecycle_route_id "$feature_dir/.initial-route.json" 2>/dev/null || true)"
  if [[ -n "$bootstrap_route" ]]; then
    log_route_lifecycle "bootstrap_assigned" "issue=$issue" "route=\"$bootstrap_route\""
  fi

  local planner_agent
  planner_agent="$(agent_resolve_from_model "${planner_model:-gpt-5.6-terra}" "planning" || true)"
  write_stage_result_local "$feature_dir" "planning" "running" "$planner_agent" "${planner_model:-gpt-5.6-terra}" "Startup handoff launched planning" || true
  startup_step "[4/7] Writing task artifacts...  ✓"

  # Persist launched tasks as active planning work in the initial state write so
  # downstream startup checks do not depend on a second jq update succeeding.
  local persisted_phase="planning"
  # Canonical save_task_state tail: challengeStage(19), phase(20), windowId(21).
  if ! wavemill_lock_run "state" save_task_state "$issue" "$slug" "$branch" "$wt_dir" "$preflight_pr" "" "$task_agent" "$linear_issue" "$challenge" "$challenge_pair" "$challenge_role" "$challenge_model" \
    "$planner_model" "$coder_model" "$reviewer_model" "$plan_depth" "$code_depth" "$review_mode" "$challenge_stage" "$persisted_phase" "${created_window_id:-}"; then
    startup_phase_failed "$startup_id" agent "$issue" "saving workflow state"
    [[ -n "${created_window:-}" ]] && tmux kill-window -t "${created_window_id:-$SESSION:$win}" >/dev/null 2>&1 || true
    return 1
  fi
  wavemill_lock_run "state" wavemill_persist_attempt_reconciliation "$issue" "$attempt_json" "$pr_reconciliation_json" "startup-runner" >/dev/null 2>&1 || true

  if [[ -n "$challenge_stage" ]]; then
    wavemill_lock_run "state" state_mutate "$STATE_FILE" '.tasks[$issue].challengeStage = $stage' \
      --arg issue "$issue" --arg stage "$challenge_stage" >/dev/null 2>&1 || true
  fi

  if ! wavemill_lock_run "state" set_task_phase_local "$issue" "$persisted_phase"; then
    wavemill_lock_run "state" remove_task_state "$issue" >/dev/null 2>&1 || true
    [[ -n "${created_window:-}" ]] && tmux kill-window -t "${created_window_id:-$SESSION:$win}" >/dev/null 2>&1 || true
    startup_phase_failed "$startup_id" agent "$issue" "setting phase"
    return 1
  fi
  state_written=true
  startup_step "[5/7] Saving workflow state...  ✓"
  if [[ -n "${created_window_id:-}" ]] && declare -F wavemill_apply_window_metadata >/dev/null 2>&1; then
    wavemill_apply_window_metadata "$SESSION" "$issue" "${created_window_id:-}" "$STATE_FILE" >/dev/null 2>&1 || true
  fi

  if [[ "$DRY_RUN" == "true" ]]; then
    startup_step "[6/7] Launching agent...        [DRY-RUN skip]"
    [[ "${WAVEMILL_NO_PROGRESS:-0}" != "1" ]] && progress_update "$startup_id" agent done
    startup_step "[7/7] Setting Linear → In Progress... [DRY-RUN skip]"
    [[ "${WAVEMILL_NO_PROGRESS:-0}" != "1" ]] && progress_update "$startup_id" linear done
    printf '%s\n' "$issue" >> "$LAUNCHED_ISSUES_FILE"
    startup_task_log "$issue" "✓ $issue validated in dry-run (${coder_model:-$planner_model}, phase: $persisted_phase)"
    STARTUP_TASK_LOG_FILE=""
    return 0
  fi

  planning_prompt="/tmp/${SESSION}-${issue}-planning-prompt.txt"
  build_planning_prompt "$title" "$linear_issue" "$wt_dir" "$branch" "$BASE_BRANCH" \
    "$issue_context" "$status_file" "$TOOLS_DIR" "$slug" "$plan_depth" "$planner_agent" > "$planning_prompt"
  if ! planner_launch_model="$(agent_resolve_model "planner" "${planner_model:-gpt-5.6-terra}" "$wt_dir" 2>/dev/null)"; then
    planner_launch_model="${planner_model:-gpt-5.6-terra}"
  fi
  export WAVEMILL_RESOLVED_MODEL="$planner_launch_model"
  tmux set-environment -t "$SESSION" WAVEMILL_RESOLVED_MODEL "$planner_launch_model" 2>/dev/null || true
  export WAVEMILL_FEATURE_SLUG="$slug"
  export WAVEMILL_FEATURE_DIR="$feature_dir"
  if ! agent_launch_interactive "$SESSION" "${created_window_id:-$win}" "$planning_prompt" "$planner_agent" "${planner_model:-gpt-5.6-terra}" "" "" "$issue"; then
    if [[ "$challenge" == "true" ]]; then
      challenge_selection_health_release "$challenge_pair" "$challenge_stage" \
        "$(challenge_selection_health_varied_model "$challenge_stage" "$planner_model" "$coder_model" "$reviewer_model")"
    fi
    [[ -n "${state_written:-}" ]] && wavemill_lock_run "state" remove_task_state "$issue" >/dev/null 2>&1 || true
    tmux kill-window -t "${created_window_id:-$SESSION:$win}" >/dev/null 2>&1 || true
    startup_phase_failed "$startup_id" agent "$issue" "launching planning agent"
    return 1
  fi

  # Re-persist the launched task after the pane handoff succeeds so the final
  # workflow record reflects a fully launched planning session.
  if ! wavemill_lock_run "state" save_task_state "$issue" "$slug" "$branch" "$wt_dir" "$preflight_pr" "" "$task_agent" "$linear_issue" "$challenge" "$challenge_pair" "$challenge_role" "$challenge_model" \
    "$planner_model" "$coder_model" "$reviewer_model" "$plan_depth" "$code_depth" "$review_mode" "$challenge_stage" "$persisted_phase" "${created_window_id:-}"; then
    [[ -n "${state_written:-}" ]] && wavemill_lock_run "state" remove_task_state "$issue" >/dev/null 2>&1 || true
    tmux kill-window -t "${created_window_id:-$SESSION:$win}" >/dev/null 2>&1 || true
    startup_phase_failed "$startup_id" agent "$issue" "re-saving workflow state"
    return 1
  fi
  wavemill_lock_run "state" wavemill_persist_attempt_reconciliation "$issue" "$attempt_json" "$pr_reconciliation_json" "startup-runner" >/dev/null 2>&1 || true
  startup_step "[6/7] Launching agent...        ✓"
  if [[ -n "${created_window_id:-}" ]] && declare -F wavemill_apply_window_metadata >/dev/null 2>&1; then
    wavemill_apply_window_metadata "$SESSION" "$issue" "${created_window_id:-}" "$STATE_FILE" >/dev/null 2>&1 || true
  fi
  [[ "${WAVEMILL_NO_PROGRESS:-0}" != "1" ]] && progress_update "$startup_id" agent done

  [[ "${WAVEMILL_NO_PROGRESS:-0}" != "1" ]] && progress_update "$startup_id" linear running

  # Reassert the launched phase after agent dispatch and Linear updates so the
  # final persisted state reflects active coding work even if a helper touched
  # workflow-state during startup.
  if ! wavemill_lock_run "state" set_task_phase_local "$issue" "$persisted_phase"; then
    [[ -n "${state_written:-}" ]] && wavemill_lock_run "state" remove_task_state "$issue" >/dev/null 2>&1 || true
    tmux kill-window -t "${created_window_id:-$SESSION:$win}" >/dev/null 2>&1 || true
    startup_phase_failed "$startup_id" linear "$issue" "finalizing workflow state"
    return 1
  fi
  startup_step "[7/7] Setting Linear → In Progress... ✓"
  [[ "${WAVEMILL_NO_PROGRESS:-0}" != "1" ]] && progress_update "$startup_id" linear done

  printf '%s\n' "$issue" >> "$LAUNCHED_ISSUES_FILE"
  if [[ "$challenge" == "true" ]]; then
    challenge_selection_health_ack_launch "$challenge_pair" "$challenge_stage" \
      "$(challenge_selection_health_varied_model "$challenge_stage" "$planner_model" "$coder_model" "$reviewer_model")"
  fi
  startup_task_log "$issue" "✓ $issue launched (${coder_model:-$planner_model}, phase: $persisted_phase)"
  STARTUP_TASK_LOG_FILE=""
  return 0
}

launch_startup_concurrent() {
  local task_count="$1"
  local pool_size="${WAVEMILL_STARTUP_CONCURRENCY:-4}"

  if ! [[ "$pool_size" =~ ^[1-9][0-9]*$ ]]; then
    startup_log "Error: WAVEMILL_STARTUP_CONCURRENCY must be a positive integer (got $pool_size)"
    return 2
  fi
  if [[ "$task_count" -eq 0 ]]; then
    return 0
  fi
  [[ "$pool_size" -gt "$task_count" ]] && pool_size="$task_count"

  local status_dir
  status_dir="$(mktemp -d "/tmp/wavemill-${SESSION}-worker-status-XXXXXX")"

  local idx=0
  local -a bg_pids=()

  while IFS= read -r task_json; do
    [[ -z "$task_json" ]] && continue
    idx=$((idx + 1))

    local issue exit_file
    issue="$(printf '%s' "$task_json" | jq -r '.issue')"
    exit_file="$status_dir/${issue}.exit"

    while [[ "${#bg_pids[@]}" -ge "$pool_size" ]]; do
      local -a new_bg=()
      local pid
      for pid in "${bg_pids[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
          new_bg+=("$pid")
        else
          wait "$pid" 2>/dev/null || true
        fi
      done
      bg_pids=("${new_bg[@]}")
      [[ "${#bg_pids[@]}" -ge "$pool_size" ]] && sleep 0.2
    done

    (
      local rc=0
      launch_task_from_plan "$task_json" "$idx" "$task_count" || rc=$?
      printf '%s\n' "$rc" > "$exit_file"
    ) &
    bg_pids+=("$!")
  done < <(jq -c '.tasks[]' "$PLAN_FILE")

  local pid
  for pid in "${bg_pids[@]}"; do
    wait "$pid" 2>/dev/null || true
  done

  local any_failed=0
  while IFS= read -r task_json; do
    [[ -z "$task_json" ]] && continue

    local issue rc_file rc
    issue="$(printf '%s' "$task_json" | jq -r '.issue')"
    rc_file="$status_dir/${issue}.exit"
    if [[ -f "$rc_file" ]]; then
      rc="$(cat "$rc_file")"
    else
      rc=1
    fi
    if [[ "$rc" -ne 0 ]]; then
      startup_log "✗ $issue launch failed (worker exit $rc)"
      any_failed=1
    fi
  done < <(jq -c '.tasks[]' "$PLAN_FILE")

  rm -rf "$status_dir"
  return "$any_failed"
}

main() {
  local task_count idx tasks_file monitor_cmd task_json resumed_count launched_count pool_exit
  local -a linear_batch_ids=()

  if ! cd "$REPO_DIR"; then
    startup_log "✗ Startup failed: could not cd to repo root: $REPO_DIR"
    exit 1
  fi

  if ! startup_preflight_base_ref; then
    local base_ref_reason cleanup_status
    base_ref_reason="$(printf '%s' "$BASE_REF_PREFLIGHT_JSON" | jq -r '.reason // "base_ref_unavailable"' 2>/dev/null || echo "base_ref_unavailable")"
    wavemill_format_base_ref_preflight_failure "$BASE_REF_PREFLIGHT_JSON" >> "$STATUS_LOG_FILE" 2>/dev/null || startup_log "Wavemill cannot start: configured base branch \"$BASE_BRANCH\" is unavailable."
    cleanup_status="$(wavemill_cleanup_launch_attempt 2>/dev/null || echo "partial")"
    wavemill_record_startup_terminal_reason "$base_ref_reason" "$BASE_REF_PREFLIGHT_JSON" "$cleanup_status"
    exit 1
  fi

  if [[ "$(printf '%s' "$BASE_REF_PREFLIGHT_JSON" | jq -r '.fetchDegraded // false' 2>/dev/null)" == "true" ]]; then
    startup_log "WARN: Startup fetch for $BASE_BRANCH degraded; continuing with verified local base ref $RESOLVED_BASE_REF"
  fi

  ensure_state_file
  cleanup_background_jobs_startup
  : > "$STATUS_LOG_FILE"
  : > "$LAUNCHED_ISSUES_FILE"

  startup_log "═══ Wavemill Startup ═══"
  startup_log "Reading launch plan: $PLAN_FILE"
  startup_preflight_fresh_launch_plan
  seed_queued_tasks_from_plan "$PLAN_FILE"
  startup_refresh_openrouter_credits || true
  startup_warn_openrouter_status || true

  if [[ -n "$LAUNCH_QUEUE_PLAN" ]]; then
    startup_log "Queue plan metadata present (ignored; reserved for future queue execution)"
  fi

  task_count="$(jq '.tasks | length' "$PLAN_FILE")"
  startup_log "Tasks to launch: $task_count"
  if [[ "$task_count" -eq 0 ]]; then
    resumed_count="$(jq '(.tasks // {}) | length' "$STATE_FILE" 2>/dev/null || echo 0)"
    startup_log "No new tasks selected. Resuming $resumed_count in-flight task(s) from previous session."
  fi

  if [[ "${WAVEMILL_NO_PROGRESS:-0}" == "1" ]]; then
    idx=0
    while IFS= read -r task_json; do
      [[ -z "$task_json" ]] && continue
      idx=$((idx + 1))
      startup_run_task_phases "$task_json" "$idx" "$task_count" || true
    done < <(jq -c '.tasks[]' "$PLAN_FILE")
  elif [[ "$task_count" -gt 0 ]]; then
    local task_list=()
    mapfile -t task_list < <(jq -c --argjson total "$task_count" '.tasks | to_entries[] | .value + {startupId: (.key + 1), startupTotal: $total}' "$PLAN_FILE")
    progress_start "$task_count" "$STATUS_LOG_FILE"
    worker_pool_run "${WAVEMILL_STARTUP_CONCURRENCY:-4}" startup_run_task_phases "${task_list[@]}"
    pool_exit=$?
    progress_finish
    if [[ "$pool_exit" -ne 0 ]]; then
      startup_log "One or more startup tasks failed; see /tmp/wavemill-${SESSION}-*.startup.log for details."
    fi
  fi

  tasks_file="/tmp/${SESSION}-tasks.txt"
  jq -r '.tasks[] | "\(.issue)|\(.slug)|\(.title)"' "$PLAN_FILE" > "$tasks_file"
  setup_control_dashboard
  spawn_integration_window
  write_monitor_env "$tasks_file"

  launched_count="$(wc -l < "$LAUNCHED_ISSUES_FILE" | tr -d ' ')"
  if [[ "$DRY_RUN" != "true" && "$launched_count" -gt 0 ]]; then
    while IFS= read -r launched_issue; do
      [[ -z "$launched_issue" ]] && continue
      linear_id="$(jq -r --arg issue "$launched_issue" '.tasks[]
        | select(.issue == $issue and ((.challengeRole // "") != "challenger"))
        | (.linearIssueId // .issue)' "$PLAN_FILE" | head -n 1)"
      [[ -n "$linear_id" && "$linear_id" != "null" ]] && linear_batch_ids+=("$linear_id")
    done < "$LAUNCHED_ISSUES_FILE"
    if [[ "${#linear_batch_ids[@]}" -gt 0 ]]; then
      startup_log "Setting Linear state for ${#linear_batch_ids[@]} launched issue(s) in one batch call..."
      linear_batch_set_state "In Progress" "${linear_batch_ids[@]}"
    fi
  fi

  if [[ "$launched_count" -eq 0 && "${resumed_count:-0}" -eq 0 ]]; then
    startup_log ""
    startup_log "No tasks launched. Keeping startup diagnostics visible in mill window."
    [[ "$DRY_RUN" == "true" ]] && return 0
    tmux respawn-pane -k -t "$SESSION:$WAVEMILL_WINDOW_MILL.0" "bash -lc \"clear; cat '$STATUS_LOG_FILE'; printf '\\nPress Ctrl+B then D to detach.\\n'; tail -f /dev/null\""
    return 0
  fi

  startup_log ""
  startup_log "Starting monitor in mill window..."
  if [[ "$DRY_RUN" == "true" ]]; then
    startup_log "[DRY-RUN] Skipping mill dashboard, backstage window, and monitor startup."
    return 0
  fi
  local monitor_cmd
  monitor_cmd="$(wavemill_build_control_pane_command startup "$SESSION" "$MONITOR_SCRIPT" "$MONITOR_ENV" "$LIB_DIR")"
  tmux respawn-pane -k -t "$SESSION:$WAVEMILL_WINDOW_MILL.0" "$monitor_cmd"
}

main "$@"
