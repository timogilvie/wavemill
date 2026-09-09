#!/usr/bin/env bash
set -euo pipefail

# Guard: copy this script to /tmp and re-exec from there to prevent Dropbox
# from replacing the file mid-execution, which can surface as a spurious EOF
# parse error when bash seeks back into the large monitor heredoc. (HOK-1755)
if [[ -z "${_WAVEMILL_MILL_REEXEC:-}" ]]; then
  _mm_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  _mm_tmp="$(mktemp /tmp/wavemill-mill.XXXXXX)"
  cp "${BASH_SOURCE[0]}" "$_mm_tmp"
  chmod +x "$_mm_tmp"
  WAVEMILL_MILL_LIB_DIR="$_mm_lib" _WAVEMILL_MILL_REEXEC=1 \
    exec bash "$_mm_tmp" "$@"
fi

# Wavemill Mill - Continuous Task Execution System
#
# This script implements a continuous loop that:
# 1. Fetches prioritized tasks from Linear backlog
# 2. Launches parallel agent workers in tmux windows
# 3. Monitors PR creation and merge status
# 4. Auto-cleans completed tasks
# 5. Prompts user to select next batch (with 10s auto-continue)
#
# Exit conditions:
#   - Empty backlog (no tasks available)
#   - User declines to continue at prompt
#   - Stop signal file exists: touch $STATE_DIR/.stop-loop
#
# Manual controls:
#   - Ctrl+B D: Detach from tmux (loop continues in background)
#   - touch ~/.wavemill/.stop-loop: Stop loop after current cycle
#   - Ctrl+C: Interrupt and reset in-progress tasks to Backlog

REPO_DIR="${REPO_DIR:-$PWD}"
_WAVEMILL_PRELOAD_BASE_BRANCH_SET="${BASE_BRANCH+x}"
_WAVEMILL_PRELOAD_REQUIRE_CONFIRM_SET="${REQUIRE_CONFIRM+x}"
_WAVEMILL_PRELOAD_MERGE_METHOD_SET="${INTEGRATION_MERGE_METHOD+x}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-progress)
      export WAVEMILL_NO_PROGRESS=1
      shift
      ;;
    *)
      break
      ;;
  esac
done

if [[ ! -t 2 ]]; then
  export WAVEMILL_NO_PROGRESS=1
fi

# Source common library and load layered config
# Resolution: env vars > .wavemill-config.json > ~/.wavemill/config.json > defaults
SCRIPT_DIR="${WAVEMILL_MILL_LIB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
WAVEMILL_MILL_SOURCE_LIB_DIR="$SCRIPT_DIR"
WAVEMILL_COMMON_LIB_PATH="$SCRIPT_DIR/wavemill-common.sh"
source "$SCRIPT_DIR/wavemill-common.sh"
source "$SCRIPT_DIR/agent-adapters.sh"
source "$SCRIPT_DIR/queue-health.sh"
if [[ -f "$SCRIPT_DIR/terminal-reconciler.sh" ]]; then
source "$SCRIPT_DIR/terminal-reconciler.sh"
fi
if [[ -f "$SCRIPT_DIR/startup-terminal-preflight.sh" ]]; then
source "$SCRIPT_DIR/startup-terminal-preflight.sh"
fi
load_config "$REPO_DIR"
WAVEMILL_BASE_BRANCH_SOURCE="${WAVEMILL_BASE_BRANCH_SOURCE:-$([[ -n "$_WAVEMILL_PRELOAD_BASE_BRANCH_SET" ]] && printf 'runtime-env' || printf 'repo-config')}"
WAVEMILL_REQUIRE_CONFIRM_SOURCE="${WAVEMILL_REQUIRE_CONFIRM_SOURCE:-$([[ -n "$_WAVEMILL_PRELOAD_REQUIRE_CONFIRM_SET" ]] && printf 'runtime-env' || printf 'repo-config')}"
WAVEMILL_MERGE_METHOD_SOURCE="${WAVEMILL_MERGE_METHOD_SOURCE:-$([[ -n "$_WAVEMILL_PRELOAD_MERGE_METHOD_SET" ]] && printf 'runtime-env' || printf 'repo-config')}"
export WAVEMILL_BASE_BRANCH_SOURCE WAVEMILL_REQUIRE_CONFIRM_SOURCE WAVEMILL_MERGE_METHOD_SOURCE

# ── Nested invocation guards (HOK-1214) ──────────────────────────

# Guard 1: Detect if running inside a git worktree
_git_dir=$(git rev-parse --git-dir 2>/dev/null || echo "")
_git_common_dir=$(git rev-parse --git-common-dir 2>/dev/null || echo "")
if [[ -n "$_git_dir" && -n "$_git_common_dir" && "$_git_dir" != "$_git_common_dir" ]]; then
  echo "ERROR: wavemill mill cannot run inside a git worktree." >&2
  echo "  Detected worktree: $(git rev-parse --show-toplevel 2>/dev/null)" >&2
  echo "  Main repository:   $(cd "$_git_common_dir/.." && pwd)" >&2
  echo "  Run 'wavemill mill' from the main repository root instead." >&2
  exit 1
fi
unset _git_dir _git_common_dir

# Guard 2: Detect nested mill invocation via environment
# Stores repo path so separate repos in separate terminals don't conflict
if [[ -n "${WAVEMILL_MILL_ACTIVE:-}" ]]; then
  if [[ "${WAVEMILL_READY_WATCHDOG_SOURCE_ONLY:-}" != "1" ]]; then
    echo "ERROR: wavemill mill is already running for: $WAVEMILL_MILL_ACTIVE" >&2
    echo "  Nested mill invocations are not allowed." >&2
    echo "  If this is unexpected, unset WAVEMILL_MILL_ACTIVE and retry." >&2
    exit 1
  fi
else
  export WAVEMILL_MILL_ACTIVE="$REPO_DIR"
fi

# ─────────────────────────────────────────────────────────────────

# Derived variables (not in config files)
if [[ "${WAVEMILL_DRY_RUN:-}" == "1" || "${WAVEMILL_DRY_RUN:-}" == "true" || "${DRY_RUN:-}" == "true" ]]; then
  export WAVEMILL_DRY_RUN=1
  DRY_RUN="true"
else
  DRY_RUN="false"
fi
STATE_DIR="${STATE_DIR:-$REPO_DIR/.wavemill}"
STATE_FILE="$STATE_DIR/workflow-state.json"
WAVEMILL_RUN_EPOCH="${WAVEMILL_RUN_EPOCH:-$(date -u +%Y%m%dT%H%M%SZ).$$}"
export WAVEMILL_RUN_EPOCH
MILL_LOG_DIR="$REPO_DIR/.wavemill/logs"
mkdir -p "$MILL_LOG_DIR"
MILL_LOG_FILE="$MILL_LOG_DIR/mill-${SESSION}.log"
# Wavemill's own tools/ and shared/lib/, derived from the installation rather
# than from REPO_DIR. REPO_DIR is the repo being worked on, which has no
# tools/ of its own unless wavemill is driving itself; the old default silently
# pointed every helper lookup at a nonexistent directory in consumer repos.
# SCRIPT_DIR survives the /tmp re-exec above via WAVEMILL_MILL_LIB_DIR.
TOOLS_DIR="${TOOLS_DIR:-${SCRIPT_DIR%/shared/lib}/tools}"
LIB_DIR="${LIB_DIR:-$SCRIPT_DIR}"
MONITOR_PR_CACHE="/tmp/${SESSION}-pr-cache.json"
export MONITOR_PR_CACHE
MERGE_QUEUE_SELECTION_FILE="${STATE_DIR}/merge-queue-selection.json"
EFFECTIVE_MAX_PARALLEL="$MAX_PARALLEL"
# Persists queue plan for launch-plan JSON emission (set during task selection).
LAUNCH_QUEUE_PLAN=""

if [[ "${WAVEMILL_READY_WATCHDOG_SOURCE_ONLY:-}" != "1" ]]; then
  MILL_CONFIG_PREFLIGHT_TOOL="${TOOLS_DIR}/mill-config-preflight.ts"
  if [[ "${WAVEMILL_SKIP_CONFIG_PREFLIGHT:-}" == "1" ]]; then
    echo "WARN: skipping Mill config preflight (WAVEMILL_SKIP_CONFIG_PREFLIGHT=1)" >&2
  elif [[ -f "$MILL_CONFIG_PREFLIGHT_TOOL" ]]; then
    if ! npx tsx "$MILL_CONFIG_PREFLIGHT_TOOL" --repo-dir "$REPO_DIR"; then
      echo "ERROR: Mill config preflight failed. Run: wavemill config migrate-model-settings" >&2
      exit 1
    fi
  else
    echo "ERROR: Mill config preflight tool not found at: $MILL_CONFIG_PREFLIGHT_TOOL" >&2
    exit 1
  fi
fi

trim_outer_whitespace() {
  local value="${1-}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
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

if [[ "${WAVEMILL_READY_WATCHDOG_SOURCE_ONLY:-}" != "1" ]]; then
  _update_effective_max_parallel
fi

FORCE_MODEL="$(trim_outer_whitespace "${FORCE_MODEL:-}")"
if [[ -z "$FORCE_MODEL" ]]; then
  unset FORCE_MODEL
fi

WAVEMILL_PLANNER_MODEL="$(trim_outer_whitespace "${WAVEMILL_PLANNER_MODEL:-}")"
if [[ -z "$WAVEMILL_PLANNER_MODEL" ]]; then
  unset WAVEMILL_PLANNER_MODEL
fi

WAVEMILL_CODER_MODEL="$(trim_outer_whitespace "${WAVEMILL_CODER_MODEL:-}")"
if [[ -z "$WAVEMILL_CODER_MODEL" ]]; then
  unset WAVEMILL_CODER_MODEL
fi

WAVEMILL_REVIEWER_MODEL="$(trim_outer_whitespace "${WAVEMILL_REVIEWER_MODEL:-}")"
if [[ -z "$WAVEMILL_REVIEWER_MODEL" ]]; then
  unset WAVEMILL_REVIEWER_MODEL
fi


if [[ "${WAVEMILL_READY_WATCHDOG_SOURCE_ONLY:-}" != "1" ]]; then
  command -v jq >/dev/null || { echo "Error: jq required (install: brew install jq)"; exit 1; }
  command -v npx >/dev/null || { echo "Error: npx required (install: brew install node)"; exit 1; }
  command -v git >/dev/null || { echo "Error: git required"; exit 1; }
  if [[ "$DRY_RUN" != "true" ]]; then
    command -v gh >/dev/null || { echo "Error: gh required (install: brew install gh && gh auth login)"; exit 1; }
    command -v tmux >/dev/null || { echo "Error: tmux required (install: brew install tmux)"; exit 1; }
    agent_validate "$AGENT_CMD" || { echo "Error: agent '$AGENT_CMD' not found"; exit 1; }
  fi

  # Check agent authentication before launching tasks
  if [[ "$DRY_RUN" != "true" ]] && ! agent_check_auth "$AGENT_CMD"; then
    exit 1
  fi

  if [[ -n "${FORCE_MODEL:-}" && (-n "${WAVEMILL_PLANNER_MODEL:-}" || -n "${WAVEMILL_CODER_MODEL:-}" || -n "${WAVEMILL_REVIEWER_MODEL:-}") ]]; then
    log_error "FORCE_MODEL cannot be combined with planner/coder/reviewer model overrides"
    exit 1
  fi
fi


# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================


# Logging with timestamps and dashboard verbosity filtering
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

# Future submission hook for Hokusai data export. This is intentionally kept
# lightweight so the mill can gate outbound submission without duplicating the
# consent/version logic that lives in TypeScript.
hokusai_submission_allowed() {
  local hokusai_tool="$SCRIPT_DIR/../../tools/hokusai-manage.ts"
  [[ -f "$hokusai_tool" ]] || return 1
  npx tsx "$hokusai_tool" check-consent >/dev/null 2>&1
}

# Kept local to this script because the generated monitor script below runs as a
# standalone shell and must carry its own copy of any helpers it calls.
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

write_shell_assignment() {
  local name="$1" value="${2-}"
  printf '%s=' "$name"
  printf '%q\n' "$value"
}

dotenv_value() {
  local env_file="$1" wanted_key="$2"
  local raw line key value first last
  [[ -f "$env_file" ]] || return 1

  while IFS= read -r raw || [[ -n "$raw" ]]; do
    line="$(printf '%s' "$raw" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [[ -n "$line" && "$line" != \#* ]] || continue
    if [[ "$line" == export\ * ]]; then
      line="${line#export }"
      line="$(printf '%s' "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    fi
    [[ "$line" == *=* ]] || continue
    key="$(printf '%s' "${line%%=*}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [[ "$key" == "$wanted_key" ]] || continue
    value="$(printf '%s' "${line#*=}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    if [[ "${#value}" -ge 2 ]]; then
      first="${value:0:1}"
      last="${value: -1}"
      if [[ "$first" == "$last" && ( "$first" == "'" || "$first" == '"' ) ]]; then
        value="${value:1:${#value}-2}"
      fi
    fi
    printf '%s\n' "$value"
    return 0
  done < "$env_file"

  return 1
}

hydrate_provider_env_from_dotenv() {
  local repo_dir="$1" session="${2:-}"
  local env_file="$repo_dir/.env"
  local key value
  local keys=(
    OPENROUTER_API_KEY
    DEEPSEEK_API_KEY
    OPENAI_API_KEY
    ANTHROPIC_API_KEY
  )
  [[ -f "$env_file" ]] || return 0

  for key in "${keys[@]}"; do
    value="${!key:-}"
    if [[ -z "$value" ]]; then
      value="$(dotenv_value "$env_file" "$key" 2>/dev/null || true)"
      [[ -n "$value" ]] && export "$key=$value"
    fi
    if [[ -n "$session" && -n "${!key:-}" ]]; then
      tmux set-environment -t "$session" "$key" "${!key}" 2>/dev/null || true
    fi
  done
}

create_tmux_session() {
  local tmux_conf
  local next_done_script
  tmux_conf="$(cd "$SCRIPT_DIR/../.." && pwd)/.tmux.conf"
  next_done_script="$SCRIPT_DIR/wavemill-next-done.sh"

  if tmux has-session -t "$SESSION" 2>/dev/null; then
    local existing_dir
    existing_dir=$(tmux show-environment -t "$SESSION" REPO_DIR 2>/dev/null | sed 's/^REPO_DIR=//') || true
    if [[ -z "$existing_dir" ]]; then
      existing_dir="unknown"
    fi
    if [[ "$existing_dir" != "$REPO_DIR" ]]; then
      echo "ERROR: tmux session '$SESSION' is already bound to a different repo." >&2
      echo "  Requested repo: $REPO_DIR" >&2
      echo "  Active repo:    $existing_dir" >&2
      echo "  Attach:         tmux attach -t $SESSION" >&2
      echo "  Kill:           tmux kill-session -t $SESSION" >&2
      echo "  Override:       SESSION=${SESSION}-alt wavemill mill" >&2
      return 1
    fi
    tmux kill-session -t "$SESSION" 2>/dev/null || true
  fi

  tmux -f "$tmux_conf" new-session -d -s "$SESSION" -c "$REPO_DIR" -n "$WAVEMILL_WINDOW_MILL"
  # Prevent mill panes from being destroyed if their process crashes.
  # Without this, a dashboard crash collapses the entire control layout.
  tmux set-option -t "$SESSION:$WAVEMILL_WINDOW_MILL" remain-on-exit on 2>/dev/null || true
  tmux set-environment -t "$SESSION" REPO_DIR "$REPO_DIR"
  tmux set-environment -t "$SESSION" WAVEMILL_MILL_ACTIVE "$REPO_DIR"
  hydrate_provider_env_from_dotenv "$REPO_DIR" "$SESSION"
  [[ -n "${WAVEMILL_NO_PROGRESS:-}" ]] && tmux set-environment -t "$SESSION" WAVEMILL_NO_PROGRESS "$WAVEMILL_NO_PROGRESS"
  if [[ -x "$next_done_script" ]]; then
    tmux bind-key -T prefix N run-shell "WAVEMILL_SESSION='#{session_name}' '$next_done_script'"
  fi
  tmux send-keys -t "$SESSION:$WAVEMILL_WINDOW_MILL" "echo 'Mill window for $SESSION'" C-m
}

# Write the launch plan JSON for startup runner consumption.
# Optional fields added when queue planning data is available (HOK-1532).
# Runner currently ignores; reserved for future queue execution work.
# queuePlan (object): planner-supplied wave ordering from plan-queue.ts
# tasks[].dependsOn (string[]): task IDs this task depends on
# tasks[].baseFromTask (string|null): task ID to base branch from
write_launch_plan() {
  local launch_plan_file="$1"
  local queue_plan_json="${2:-}"
  local initial_phase="planning"

  if [[ -n "${FORCE_MODEL:-}" ]]; then
    if ! agent_validate_model "$FORCE_MODEL" "$REPO_DIR"; then
      log_error "Invalid FORCE_MODEL: $FORCE_MODEL"
      log_error "Run 'wavemill mill' without FORCE_MODEL to use the router, or fix the model name."
      exit 1
    fi
  else
    if [[ -n "${WAVEMILL_PLANNER_MODEL:-}" ]] && ! agent_validate_model "$WAVEMILL_PLANNER_MODEL" "$REPO_DIR"; then
      log_error "Invalid WAVEMILL_PLANNER_MODEL: $WAVEMILL_PLANNER_MODEL"
      exit 1
    fi
    if [[ -n "${WAVEMILL_CODER_MODEL:-}" ]] && ! agent_validate_model "$WAVEMILL_CODER_MODEL" "$REPO_DIR"; then
      log_error "Invalid WAVEMILL_CODER_MODEL: $WAVEMILL_CODER_MODEL"
      exit 1
    fi
    if [[ -n "${WAVEMILL_REVIEWER_MODEL:-}" ]] && ! agent_validate_model "$WAVEMILL_REVIEWER_MODEL" "$REPO_DIR"; then
      log_error "Invalid WAVEMILL_REVIEWER_MODEL: $WAVEMILL_REVIEWER_MODEL"
      exit 1
    fi
  fi

  local tasks_json='[]'
  local t issue slug title branch wt_dir linear_issue task_packet_file details_file issue_json_file route_file
  local route_json route_planner route_coder route_reviewer route_plan_depth route_code_depth route_review_mode route_max_cost_usd
  local route_payload challenge_flag challenge_pair challenge_role challenge_model migration_number task_agent
  local depends_on base_from_task attempt_id attempt_json

  for t in "${LAUNCH_ARGS[@]}"; do
    IFS='|' read -r issue slug title <<<"$t"
    branch="task/${slug}"
    wt_dir="${WORKTREE_ROOT}/${slug}"
    attempt_id="$(wavemill_default_attempt_id "$issue" "$branch")"
    attempt_json="$(wavemill_attempt_context_json "$issue" "$attempt_id" "$branch" "$branch" "$BASE_BRANCH" "launch-plan")"
    linear_issue="${TASK_LINEAR_ISSUE_BY_ISSUE[$issue]:-$issue}"
    task_packet_file="/tmp/${SESSION}-${issue}-taskpacket.md"
    details_file="/tmp/${SESSION}-${issue}-taskpacket-details.md"
    issue_json_file="/tmp/${SESSION}-${issue}-issue.json"
    route_file="/tmp/${SESSION}-${issue}-route.json"
    route_json='{}'
    [[ -f "$route_file" ]] && route_json="$(cat "$route_file" 2>/dev/null || echo '{}')"

    route_planner="${TASK_PLANNER_MODEL_BY_ISSUE[$issue]:-$(echo "$route_json" | jq -r '.planner // empty' 2>/dev/null)}"
    route_coder="${TASK_CODER_MODEL_BY_ISSUE[$issue]:-$(echo "$route_json" | jq -r '.coder // empty' 2>/dev/null)}"
    route_reviewer="${TASK_REVIEWER_MODEL_BY_ISSUE[$issue]:-$(echo "$route_json" | jq -r '.reviewer // empty' 2>/dev/null)}"
    route_plan_depth="${TASK_PLAN_DEPTH_BY_ISSUE[$issue]:-$(echo "$route_json" | jq -r '.planDepth // "light"' 2>/dev/null)}"
    route_code_depth="${TASK_CODE_DEPTH_BY_ISSUE[$issue]:-$(echo "$route_json" | jq -r '.codeDepth // "medium"' 2>/dev/null)}"
    route_review_mode="${TASK_REVIEW_MODE_BY_ISSUE[$issue]:-$(echo "$route_json" | jq -r '.reviewRecommended // .reviewMode // "static"' 2>/dev/null)}"
    route_max_cost_usd="$(echo "$route_json" | jq -r '.constraints.maxCostUsd // empty' 2>/dev/null)"
    [[ -z "$route_max_cost_usd" ]] && route_max_cost_usd="${DEFAULT_MAX_COST_USD:-}"
    challenge_flag="${TASK_CHALLENGE_BY_ISSUE[$issue]:-false}"
    challenge_pair="${TASK_CHALLENGE_PAIR_BY_ISSUE[$issue]:-}"
    challenge_role="${TASK_CHALLENGE_ROLE_BY_ISSUE[$issue]:-}"
    challenge_model="${TASK_CHALLENGE_MODEL_BY_ISSUE[$issue]:-}"
    challenge_stage="${TASK_CHALLENGE_STAGE_BY_ISSUE[$issue]:-}"
    migration_number="$(jq -r --arg issue "$issue" '.migrationReservations[$issue] // empty' "$STATE_FILE" 2>/dev/null || echo "")"
    task_agent="${TASK_AGENT_BY_ISSUE[$issue]:-$AGENT_CMD}"

    if [[ -n "${FORCE_MODEL:-}" ]]; then
      route_planner="$FORCE_MODEL"
      route_coder="$FORCE_MODEL"
      route_reviewer="$FORCE_MODEL"
    else
      [[ -n "${WAVEMILL_PLANNER_MODEL:-}" ]] && route_planner="$WAVEMILL_PLANNER_MODEL"
      [[ -n "${WAVEMILL_CODER_MODEL:-}" ]] && route_coder="$WAVEMILL_CODER_MODEL"
      [[ -n "${WAVEMILL_REVIEWER_MODEL:-}" ]] && route_reviewer="$WAVEMILL_REVIEWER_MODEL"
    fi
    # Extract per-task queue metadata when queue plan is available (HOK-1532)
    depends_on="[]"
    base_from_task="null"
    if [[ -n "$queue_plan_json" ]]; then
      depends_on="$(jq -c --arg id "$issue" '
        (.queuedAfterDependencies // [])
        | map(select(.taskId == $id))
        | if length > 0 then .[0].ancestors else [] end
      ' <<<"$queue_plan_json" 2>/dev/null || echo '[]')"
      base_from_task="$(jq -r --arg id "$issue" '
        (.queuedAfterDependencies // [])
        | map(select(.taskId == $id))
        | if length > 0 then (.[0].ancestors[0] // "null") else "null" end
      ' <<<"$queue_plan_json" 2>/dev/null || echo 'null')"
    fi

    route_payload="$(jq -n \
      --arg planner "$route_planner" \
      --arg coder "$route_coder" \
      --arg reviewer "$route_reviewer" \
      --arg planDepth "$route_plan_depth" \
      --arg codeDepth "$route_code_depth" \
      --arg reviewMode "$route_review_mode" \
      --argjson maxCostUsd "${route_max_cost_usd:-null}" \
      '{
        planner: $planner,
        coder: $coder,
        reviewer: $reviewer,
        planDepth: $planDepth,
        codeDepth: $codeDepth,
        reviewMode: $reviewMode,
        maxCostUsd: $maxCostUsd
      } + (if $maxCostUsd == null then {} else {constraints: {maxCostUsd: $maxCostUsd}} end)')"

    tasks_json="$(jq -n \
      --argjson tasks "$tasks_json" \
      --arg issue "$issue" \
      --arg slug "$slug" \
      --arg title "$title" \
      --arg branch "$branch" \
      --arg worktreeDir "$wt_dir" \
      --arg linearIssueId "$linear_issue" \
      --arg taskPacketFile "$task_packet_file" \
      --arg taskPacketDetailsFile "$details_file" \
      --arg issueJsonFile "$issue_json_file" \
      --arg routeFile "$route_file" \
      --argjson route "$route_payload" \
      --arg challenge "$challenge_flag" \
      --arg challengePairId "$challenge_pair" \
      --arg challengeRole "$challenge_role" \
      --arg challengeModel "$challenge_model" \
      --arg challengeStage "$challenge_stage" \
      --argjson challengeIntent "${TASK_CHALLENGE_INTENT_BY_ISSUE[$issue]:-null}" \
      --arg migrationNumber "$migration_number" \
      --arg agent "$task_agent" \
      --argjson dependsOn "$depends_on" \
      --arg baseFromTask "$base_from_task" \
      --argjson attempt "$attempt_json" \
      '$tasks + [{
        issue: $issue,
        slug: $slug,
        title: $title,
        branch: $branch,
        attempt: $attempt,
        worktreeDir: $worktreeDir,
        linearIssueId: $linearIssueId,
        taskPacketFile: $taskPacketFile,
        taskPacketDetailsFile: $taskPacketDetailsFile,
        issueJsonFile: $issueJsonFile,
        routeFile: $routeFile,
        route: $route,
        challenge: ($challenge == "true"),
        challengePairId: (if $challengePairId == "" then null else $challengePairId end),
        challengeRole: (if $challengeRole == "" then null else $challengeRole end),
        challengeModel: (if $challengeModel == "" then null else $challengeModel end),
        challengeStage: (if $challengeStage == "" then null else $challengeStage end),
        challengeIntent: $challengeIntent,
        migrationNumber: (if $migrationNumber == "" then null else ($migrationNumber | tonumber) end),
        agent: $agent
      } + (if ($baseFromTask != "null" or ($dependsOn | length > 0)) then {dependsOn: $dependsOn, baseFromTask: (if $baseFromTask == "null" then null else $baseFromTask end)} else {} end)]')"
  done

  jq -n \
    --arg session "$SESSION" \
    --arg runEpoch "$WAVEMILL_RUN_EPOCH" \
    --arg repoDir "$REPO_DIR" \
    --arg baseBranch "$BASE_BRANCH" \
    --arg baseBranchSource "${WAVEMILL_BASE_BRANCH_SOURCE:-repo-config}" \
    --arg resolvedBaseRef "${WAVEMILL_RESOLVED_BASE_REF:-}" \
    --argjson baseRefPreflight "${WAVEMILL_BASE_REF_PREFLIGHT_JSON:-null}" \
    --arg worktreeRoot "$WORKTREE_ROOT" \
    --arg planningMode "$PLANNING_MODE" \
    --arg agentCmd "$AGENT_CMD" \
    --arg agentCmdExplicit "${AGENT_CMD_EXPLICIT:-}" \
    --arg forceModel "${FORCE_MODEL:-}" \
    --arg routerEnabled "${ROUTER_ENABLED:-true}" \
    --arg maxParallel "$MAX_PARALLEL" \
    --arg stateDir "$STATE_DIR" \
    --arg stateFile "$STATE_FILE" \
    --arg toolsDir "$TOOLS_DIR" \
    --arg libDir "$SCRIPT_DIR" \
    --arg initialPhase "$initial_phase" \
    --arg statusLogFile "$STATUS_LOG_FILE" \
    --arg monitorEnv "$MONITOR_ENV" \
    --arg monitorScript "$MONITOR_SCRIPT" \
    --arg launchedIssuesFile "$LAUNCHED_ISSUES_FILE" \
    --argjson tasks "$tasks_json" \
    --arg pollSeconds "$POLL_SECONDS" \
    --arg requireConfirm "$REQUIRE_CONFIRM" \
    --arg requireConfirmSource "${WAVEMILL_REQUIRE_CONFIRM_SOURCE:-repo-config}" \
    --arg integrationMergeMethod "${INTEGRATION_MERGE_METHOD:-squash}" \
    --arg mergeMethodSource "${WAVEMILL_MERGE_METHOD_SOURCE:-repo-config}" \
    --arg dryRun "$DRY_RUN" \
    --arg projectName "$PROJECT_NAME" \
    --arg autoEval "$AUTO_EVAL" \
    --arg enterLaunchesWave "${ENTER_LAUNCHES_WAVE:-true}" \
    --arg dashboardVerbosity "$DASHBOARD_VERBOSITY" \
    --arg dashboardLogToFile "$DASHBOARD_LOG_TO_FILE" \
    --arg millLogFile "$MILL_LOG_FILE" \
    --argjson queuePlan "$(if [[ -n "$queue_plan_json" ]]; then printf "%s" "$queue_plan_json"; else printf "null"; fi)" \
    '{
      session: $session,
      runEpoch: $runEpoch,
      repoDir: $repoDir,
      baseBranch: $baseBranch,
      baseBranchSource: $baseBranchSource,
      resolvedBaseRef: (if $resolvedBaseRef == "" then null else $resolvedBaseRef end),
      baseRefPreflight: $baseRefPreflight,
      worktreeRoot: $worktreeRoot,
      planningMode: $planningMode,
      agentCmd: $agentCmd,
      agentCmdExplicit: ($agentCmdExplicit == "true"),
      forceModel: (if $forceModel == "" then null else $forceModel end),
      routerEnabled: ($routerEnabled == "true"),
      maxParallel: ($maxParallel | tonumber),
      stateDir: $stateDir,
      stateFile: $stateFile,
      toolsDir: $toolsDir,
      libDir: $libDir,
      initialPhase: $initialPhase,
      tasks: $tasks,
      startupConfig: {
        statusLogFile: $statusLogFile,
        monitorEnv: $monitorEnv,
        monitorScript: $monitorScript,
        launchedIssuesFile: $launchedIssuesFile,
        millLogFile: $millLogFile
      },
      monitorConfig: {
        pollSeconds: ($pollSeconds | tonumber),
        requireConfirm: ($requireConfirm == "true"),
        requireConfirmSource: $requireConfirmSource,
        mergeMethod: $integrationMergeMethod,
        mergeMethodSource: $mergeMethodSource,
        dryRun: ($dryRun == "true"),
        projectName: $projectName,
        autoEval: ($autoEval == "true"),
        enterLaunchesWave: ($enterLaunchesWave == "true"),
        dashboardVerbosity: $dashboardVerbosity,
        dashboardLogToFile: ($dashboardLogToFile == "true")
      }
    } + (if $queuePlan != null then {queuePlan: $queuePlan} else {} end)' > "$launch_plan_file"
}


# Dry-run wrapper
execute() {
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[DRY-RUN] $*"
    return 0
  else
    "$@"
  fi
}


# Confirmation prompt
confirm() {
  local prompt="$1"
  if [[ "$REQUIRE_CONFIRM" != "true" ]]; then
    return 0
  fi
  read -p "$prompt [y/N] " -n 1 -r
  echo
  [[ $REPLY =~ ^[Yy]$ ]]
}


# Per-attempt timeout for retried commands (seconds)
RETRY_TIMEOUT="${RETRY_TIMEOUT:-30}"


# Retry wrapper with exponential backoff and per-attempt timeout
retry() {
  local max_attempts="$MAX_RETRIES"
  local delay="$RETRY_DELAY"
  local attempt=1
  local exit_code=0


  while (( attempt <= max_attempts )); do
    _with_timeout "$RETRY_TIMEOUT" "$@" && return 0
    exit_code=$?


    if (( attempt < max_attempts )); then
      log_warn "Command failed (attempt $attempt/$max_attempts), retrying in ${delay}s..."
      sleep "$delay"
      delay=$((delay * 2))
    fi
    attempt=$((attempt + 1))
  done


  log_error "Command failed after $max_attempts attempts"
  return "$exit_code"
}


# State ledger functions
init_state_ledger() {
  mkdir -p "$STATE_DIR"
  if [[ ! -f "$STATE_FILE" ]]; then
    echo '{"session":"'$SESSION'","started":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","tasks":{}}' > "$STATE_FILE"
  fi
  state_mutate "$STATE_FILE" \
    '.session = $session
     | .runEpoch = $runEpoch
     | .updated = (now | todateiso8601)' \
    --arg session "$SESSION" \
    --arg runEpoch "$WAVEMILL_RUN_EPOCH" >/dev/null 2>&1 || true
  cleanup_background_jobs_startup
}


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

clear_challenge_eval_running() {
  local issue="$1"
  state_mutate "$STATE_FILE" '
    if .tasks[$issue]? then
      .tasks[$issue] |= (del(.evalRunning) | .updated = (now | todateiso8601))
    else
      .
    end
  ' --arg issue "$issue"
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

clear_challenge_comparison_running() {
  local pair_id="$1"
  state_mutate "$STATE_FILE" '
    .tasks |= with_entries(
      if (.value.challengePairId // "") == $pair then
        .value |= (del(.comparisonRunning) | .updated = (now | todateiso8601))
      else
        .
      end
    )
  ' --arg pair "$pair_id"
}


get_task_state() {
  local issue="$1"
  jq -r --arg issue "$issue" '.tasks[$issue] // empty' "$STATE_FILE"
}


# Migration state helpers — persist reservations in the state ledger
# so both the initial mill and the monitoring loop stay coordinated.
scan_highest_migration() {
  # Scan the git tree (not filesystem) for the highest migration number.
  # Requires a prior `git fetch` so origin/$BASE_BRANCH is up-to-date.
  local highest
  highest=$(git -C "$REPO_DIR" ls-tree --name-only "origin/$BASE_BRANCH" alembic/versions/ 2>/dev/null \
    | grep -oE '^[0-9]+' | sort -n | tail -1)
  echo "${highest:-0}"
}

get_next_migration_num() {
  # Read from state file; returns empty if not yet set.
  jq -r '.nextMigrationNum // empty' "$STATE_FILE" 2>/dev/null
}

save_migration_reservation() {
  local issue="$1"
  local num="$2"
  state_mutate "$STATE_FILE" \
    '.migrationReservations[$issue] = $num | .nextMigrationNum = ($num + 1)' \
    --arg issue "$issue" --argjson num "$num" >/dev/null || true
}

save_next_migration_num() {
  local num="$1"
  state_mutate "$STATE_FILE" '.nextMigrationNum = $num' --argjson num "$num" >/dev/null || true
}


# remove_task_state() is provided by wavemill-common.sh (HOK-2903); the
# canonical copy also stamps the top-level .updated timestamp on removal.

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

# get_task_phase() is provided by wavemill-common.sh (HOK-2903); the canonical
# copy falls back to "executing" on a missing/unreadable/malformed state file
# instead of this scope's former silent empty string.

check_routing_complete() {
  local slug="$1"
  local wt="${WORKTREE_ROOT}/${slug}"
  [[ -f "$wt/features/$slug/.routing-complete" ]] && return 0
  return 1
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


check_plan_exists() {
  local slug="$1"
  local wt="${WORKTREE_ROOT}/${slug}"
  [[ -f "$wt/features/$slug/plan.md" ]] && return 0
  return 1
}

# ============================================================================
# LINEAR API WITH RETRY
# ============================================================================


linear_list_backlog() {
  if [[ "$DRY_RUN" == "true" ]]; then
    local backlog_file="${WAVEMILL_DRY_RUN_BACKLOG_FILE:-}"
    if [[ -z "$backlog_file" ]]; then
      log_error "Dry-run requires WAVEMILL_DRY_RUN_BACKLOG_FILE or --dry-run-backlog."
      return 1
    fi
    if [[ ! -f "$backlog_file" ]]; then
      log_error "Dry-run backlog fixture not found: $backlog_file"
      return 1
    fi
    if ! jq empty "$backlog_file" >/dev/null 2>&1; then
      log_error "Dry-run backlog fixture is not valid JSON: $backlog_file"
      return 1
    fi
    cat "$backlog_file"
    return 0
  fi

  # Capture stdout (JSON); collect stderr so we can show it on failure
  local stderr_file
  stderr_file=$(mktemp)
  if retry npx tsx "$TOOLS_DIR/list-backlog-json.ts" "$PROJECT_NAME" 2>"$stderr_file"; then
    rm -f "$stderr_file"
  else
    local rc=$?
    log_error "Backlog fetch failed. stderr:"
    cat "$stderr_file" >&2
    rm -f "$stderr_file"
    return "$rc"
  fi
}
linear_get_issue() {
  if [[ "$DRY_RUN" == "true" ]]; then
    local backlog_file="${WAVEMILL_DRY_RUN_BACKLOG_FILE:-}"
    local issue="$1"
    if [[ -z "$backlog_file" || ! -f "$backlog_file" ]]; then
      log_error "Dry-run issue lookup requires backlog fixture file."
      return 1
    fi

    local selected
    selected="$(jq -cer --arg issue "$issue" '
      map(select(.identifier == $issue or .id == $issue)) | .[0]
    ' "$backlog_file" 2>/dev/null || true)"
    if [[ -z "$selected" || "$selected" == "null" ]]; then
      log_error "Dry-run issue fixture not found for: $issue"
      return 1
    fi
    printf '%s\n' "$selected"
    return 0
  fi

  # Capture stdout (JSON); collect stderr so we can show it on failure
  local stderr_file
  stderr_file=$(mktemp)
  if retry npx tsx "$TOOLS_DIR/get-issue.ts" "$1" --json 2>"$stderr_file"; then
    rm -f "$stderr_file"
  else
    local rc=$?
    log_error "Issue fetch failed for $1. stderr:"
    cat "$stderr_file" >&2
    rm -f "$stderr_file"
    return "$rc"
  fi
}


linear_set_description() {
  local issue="$1"
  local file="$2"


  if [[ "$DRY_RUN" == "true" ]]; then
    log "[DRY-RUN] Would update $issue description from $file"
    return 0
  fi


  retry npx tsx "$TOOLS_DIR/update-issue.ts" "$issue" --file "$file" >/dev/null 2>&1
}


# Note: linear_set_state() and linear_is_completed() now provided by wavemill-common.sh (HOK-2901)


# Note: is_task_packet() and write_task_packet() now provided by wavemill-common.sh


# Conflict-aware task selection with multi-factor priority scoring
# Fetches up to 30 candidates so we have enough unblocked items after filtering
# Output: identifier|slug|title|area|score|blocked_by_count
pick_candidates() {
  local backlog_json="$1"
  local show_limit=30
  local focus_milestones_json="[]"

  if [[ -n "${REPO_DIR:-}" ]] && declare -F wavemill_load_config >/dev/null 2>&1; then
    focus_milestones_json="$(wavemill_load_config "$REPO_DIR" | jq -c '.backlog.focusMilestones // []' 2>/dev/null || printf '[]')"
  fi

  # Use shared scoring function; strip has_detailed_plan (field 6), keep blocked_by_count (field 7→6)
  score_and_rank_issues "$backlog_json" "$show_limit" "$focus_milestones_json" | awk -F'|' -v OFS='|' '{print $1,$2,$3,$4,$5,$7}'
}


# Smart selection that avoids area conflicts
smart_select_from_candidates() {
  local candidates="$1"
  local selected_numbers="$2"
  local selection_limit="${STARTUP_SLOT_LIMIT:-$MAX_PARALLEL}"


  if [[ -z "$selected_numbers" ]]; then
    # Auto-select up to the startup slot limit with conflict avoidance
    local -A area_used=()
    local -a result=()
    local count=0


    while IFS= read -r line && [[ $count -lt $selection_limit ]]; do
      IFS='|' read -r issue slug title area score blocked_by <<<"$line"


      # Check area conflict - skip if area already in use
      if [[ -n "$area" ]] && [[ -n "${area_used[$area]:-}" ]]; then
        continue
      fi


      # Accept this task
      result+=("$issue|$slug|$title")
      [[ -n "$area" ]] && area_used["$area"]=1
      count=$((count + 1))
    done <<<"$candidates"


    printf '%s\n' "${result[@]}"
  else
    # User selected specific numbers - extract first 3 fields only
    while read -r n; do
      echo "$candidates" | sed -n "${n}p" | cut -d'|' -f1-3
    done <<<"$(echo "$selected_numbers" | tr ' ' '\n')"
  fi
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


# ============================================================================
# GITHUB API WITH RETRY AND VALIDATION
# ============================================================================
# pr_state() and validate_pr_merge() are provided by wavemill-common.sh (HOK-2904).


# ============================================================================
# MAIN WORKFLOW
# ============================================================================


# Trap handler for cleanup on exit/interrupt
ISSUES_IN_PROGRESS=()
cleanup_on_exit() {
  local exit_code=$?
  local launched_issue_file="/tmp/${SESSION}-launched-issues.txt"

  # Enhanced error context for debugging forced exit issues (HOK-1297)
  if [[ -n "${DEBUG_CLEANUP:-}" ]]; then
    log_warn "cleanup_on_exit: Starting cleanup (exit_code=$exit_code, session=${SESSION:-unknown})"
  fi

  if [[ ${#ISSUES_IN_PROGRESS[@]} -eq 0 && -f "$launched_issue_file" ]]; then
    while IFS= read -r issue; do
      [[ -n "$issue" ]] && ISSUES_IN_PROGRESS+=("$issue")
    done < <(sort -u "$launched_issue_file" 2>/dev/null || true)
  fi

  cleanup_background_jobs_shutdown 2>/dev/null || true

  if [[ ${#ISSUES_IN_PROGRESS[@]} -gt 0 ]]; then
    log_warn "Interrupted - resetting Linear state for unfinished tasks..."
    log_warn "Worktrees and branches preserved for resumption on next run."
    for issue in "${ISSUES_IN_PROGRESS[@]}"; do
      role=$(jq -r --arg issue "$issue" '.tasks[$issue].challengeRole // empty' "$STATE_FILE" 2>/dev/null)
      linear_issue=$(jq -r --arg issue "$issue" '.tasks[$issue].linearIssueId // .tasks[$issue].challengePairId // $issue' "$STATE_FILE" 2>/dev/null)
      if [[ "$role" != "challenger" ]]; then
        linear_set_state "${linear_issue:-$issue}" "Backlog" 2>/dev/null || {
          [[ -n "${DEBUG_CLEANUP:-}" ]] && log_warn "cleanup_on_exit: Failed to reset Linear state for $issue"
          true
        }
      fi
      remove_task_state "$issue" 2>/dev/null || {
        [[ -n "${DEBUG_CLEANUP:-}" ]] && log_warn "cleanup_on_exit: Failed to remove task state for $issue"
        true
      }
    done
  fi

  [[ -n "${DEBUG_CLEANUP:-}" ]] && log_warn "cleanup_on_exit: Cleanup complete"
  exit $exit_code
}
trap cleanup_on_exit INT TERM


# Initialize state ledger
init_state_ledger


cleanup_terminal_missing_worktree_entries() {
  local terminal_issues
  terminal_issues=$(jq -r '
    (.tasks // {})
    | to_entries[]
    | select((.value.worktree // "") != "")
    | select(.value.status as $status
        | ["aborted","merged","completed-external","complete","completed","closed","done","error","superseded"] | index($status))
    | select((.value.worktree | type) == "string")
    | "\(.key)|\(.value.worktree)|\(.value.status)"
  ' "$STATE_FILE" 2>/dev/null || true)
  [[ -n "$terminal_issues" ]] || return 0

  local issue worktree status dropped=0
  while IFS='|' read -r issue worktree status; do
    [[ -n "$issue" && -n "$worktree" ]] || continue
    if [[ ! -e "$worktree" ]]; then
      remove_task_state "$issue"
      dropped=$((dropped + 1))
      log "debug" "  Dropped terminal task state for $issue ($status, missing worktree: $worktree)"
    fi
  done <<<"$terminal_issues"

  if (( dropped > 0 )); then
    local entry_label="entries"
    (( dropped == 1 )) && entry_label="entry"
    log "debug" "  Dropped $dropped terminal task state $entry_label with missing worktrees"
  fi
}

# Prune stale tasks from previous runs
# Check each task: if PR merged or branch deleted, clean up worktree + state
cleanup_stale_tasks() {
  cleanup_terminal_missing_worktree_entries

  local stale_issues
  stale_issues=$(jq -r '.tasks | to_entries[] | .key' "$STATE_FILE" 2>/dev/null)
  [[ -z "$stale_issues" ]] && return 0

  local cleaned=0
  while IFS= read -r issue; do
    [[ -z "$issue" ]] && continue
    local task_json
    task_json=$(jq -r --arg i "$issue" '.tasks[$i]' "$STATE_FILE")
    local slug branch worktree pr linear_issue eval_completed
    slug=$(echo "$task_json" | jq -r '.slug')
    branch=$(echo "$task_json" | jq -r '.branch')
    worktree=$(echo "$task_json" | jq -r '.worktree')
    pr=$(echo "$task_json" | jq -r '.pr // empty')
    linear_issue=$(echo "$task_json" | jq -r '.linearIssueId // empty')
    eval_completed=$(echo "$task_json" | jq -r '.evalCompleted // false')

    local should_clean=false
    local full_clean=false  # true = also remove worktree+branch
    local reason=""

    # Check if branch still exists
    if ! git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$branch" 2>/dev/null; then
      should_clean=true
      full_clean=true
      reason="branch deleted"
    # Check if Linear issue is completed (handles cross-repo PRs)
    elif linear_is_completed "$issue" 2>/dev/null; then
      should_clean=true
      full_clean=true
      reason="Linear issue completed externally"
    # Check if PR was merged or closed
    elif [[ -n "$pr" ]]; then
      local pr_st
      pr_st=$(pr_state "$pr")
      if [[ "$pr_st" == "MERGED" ]]; then
        should_clean=true
        full_clean=true
        reason="PR #$pr merged"
      elif [[ "$pr_st" == "CLOSED" ]]; then
        should_clean=true
        full_clean=true
        reason="PR #$pr closed"
        # Run failure eval before cleanup so closed PRs are scored
        if [[ "$AUTO_EVAL" == "true" && "$eval_completed" == "false" ]]; then
          log "  📊 Running failure eval for closed PR #$pr..."
          local eval_log="/tmp/${SESSION}-eval-${issue}.log"
          : >"$eval_log"
          (
            {
              printf 'Launching pr-closed eval in background\n'
              _with_timeout 120 npx tsx "$TOOLS_DIR/run-eval-hook.ts" \
                --issue "${linear_issue:-$issue}" --pr "$pr" --branch "$branch" \
                --worktree "${WORKTREE_ROOT}/${slug}" \
                --workflow-type mill --repo-dir "$REPO_DIR" \
                --agent "$AGENT_CMD" \
                --debug
              printf 'Eval process exited with code %s\n' "$?"
            } >>"$eval_log" 2>&1 || true
            # Mark eval completed in state (harmless if task already removed)
            state_mutate "$STATE_FILE" \
              '.tasks[$issue].evalCompleted = true | .tasks[$issue].updated = (now | todate)' \
              --arg issue "$issue" >/dev/null 2>&1 || true
          ) >/dev/null 2>&1 &
    log "debug" "  ↳ Eval running in background; log: $eval_log"
        fi
      fi
    fi

    # Keep non-terminal tasks in state across restarts so the monitor can
    # resume PR/state reconciliation after crashes.

    if [[ "$should_clean" == "true" ]]; then
      log "debug" "  Pruning $issue ($reason)"
      if [[ "$full_clean" == "true" ]]; then
        # Clean up worktree + branch for completed tasks
        local cleanup_rc=0
        safe_remove_task_worktree_and_branch "$worktree" "$branch" "$BASE_BRANCH" "stale_task_pruner" "$issue" "$pr" || cleanup_rc=$?
        if [[ "$cleanup_rc" -eq 20 ]] || cleanup_outcome_is_failed; then
          log_warn "  $issue cleanup failed (${WAVEMILL_CLEANUP_OUTCOME:-operation_failed}); keeping task state"
          continue
        elif [[ "$cleanup_rc" -ne 0 ]] || cleanup_outcome_is_retain; then
          set_window_attention_state "$issue-$slug" "needs-user"
          log_warn "  $issue cleanup preserved local work (${WAVEMILL_CLEANUP_OUTCOME:-unclassified}); keeping task state"
          continue
        fi
        if [[ "$cleanup_rc" -eq 0 && "$reason" != "branch deleted" && "$branch" != "main" && "$branch" != "master" ]]; then
          git -C "$REPO_DIR" push origin --delete "$branch" 2>/dev/null || true
        fi
      fi
      # Remove from state file (dashboard will stop showing it)
      remove_task_state "$issue"
      cleaned=$((cleaned + 1))
    fi
  done <<<"$stale_issues"

  if (( cleaned > 0 )); then
    execute git -C "$REPO_DIR" worktree prune 2>/dev/null || true
    log "debug" "  Cleaned $cleaned stale task(s)"
  fi
}

detect_inflight_tasks() {
  [[ -f "$STATE_FILE" ]] || return 0
  jq -r "$(task_lifecycle_jq_filter '
    (.tasks // {})
    | to_entries[]
    | select(.value | wm_workflow_outcome == "active")
    | select((.value.rehydration.eligibility // "") as $eligibility
        | $eligibility == "" or $eligibility == "eligible" or $eligibility == "deferred")
    | "\(.key)|\(.value.slug // "")|\(.value.phase // "executing")|\(.value.agent // "")|\(.value.branch // "")|\(.value.worktree // "")|\(.value.challengeRole // "")"
  ')" "$STATE_FILE" 2>/dev/null || true
}

count_inflight_primary_tasks() {
  local inflight_tasks="$1"
  local count=0
  local issue slug phase agent branch worktree challenge_role
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    IFS='|' read -r issue slug phase agent branch worktree challenge_role <<<"$line"
    [[ "$challenge_role" == "challenger" ]] && continue
    count=$((count + 1))
  done <<<"$inflight_tasks"
  echo "$count"
}

clear_inflight_tasks_from_state() {
  state_mutate "$STATE_FILE" '.tasks = {} | .updated = (now | todate)'
}

stale_count=$(jq '.tasks | length' "$STATE_FILE" 2>/dev/null || echo 0)
if (( stale_count > 0 )); then
  log "debug" "Found $stale_count task(s) in state file from previous run. Checking..."
  if [[ "${WAVEMILL_STARTUP_PREFLIGHT_LOADED:-0}" == "1" ]]; then
    startup_terminal_preflight "$SESSION"
  fi
  cleanup_stale_tasks
fi

SKIP_BACKLOG_SELECTION=false
STARTUP_SLOT_LIMIT="$EFFECTIVE_MAX_PARALLEL"
inflight_tasks="$(detect_inflight_tasks)"
if [[ -n "$inflight_tasks" ]]; then
  inflight_count=$(printf '%s\n' "$inflight_tasks" | grep -c .)
  inflight_primary_count=$(count_inflight_primary_tasks "$inflight_tasks")

  echo ""
  log "status" "Found $inflight_count in-flight task(s) from a previous session:"
  menu_index=0
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    IFS='|' read -r issue slug phase agent branch worktree challenge_role <<<"$line"
    menu_index=$((menu_index + 1))
    display_slug="$slug"
    [[ -z "$display_slug" && -n "$branch" ]] && display_slug="${branch#task/}"
    [[ -z "$display_slug" ]] && display_slug="unknown-slug"
    display_phase="$phase"
    [[ -z "$display_phase" ]] && display_phase="executing"
    display_agent="$agent"
    [[ -z "$display_agent" ]] && display_agent="unknown"
    printf '  %s. %s (%s) - %s phase [%s]\n' "$menu_index" "$issue" "$display_slug" "$display_phase" "$display_agent"

    if [[ -z "$worktree" ]]; then
      worktree="${WORKTREE_ROOT}/${display_slug}"
    fi
    if [[ -n "$worktree" && ! -d "$worktree" ]]; then
      log_warn "  Worktree missing for $issue - will be recreated on resume"
    fi
  done <<<"$inflight_tasks"

  echo ""
  echo "Options:"
  echo "  r  Resume these tasks (skip backlog selection)"
  echo "  f  Ignore old state and start fresh"
  echo "  q  Quit"

  while true; do
    echo ""
    echo "Choose: [r/f/q]"
    read -r RESUME_CHOICE
    case "${RESUME_CHOICE:-}" in
      r|R)
        SKIP_BACKLOG_SELECTION=true
        STARTUP_SLOT_LIMIT=0
        break
        ;;
      f|F)
        if clear_inflight_tasks_from_state; then
          log "status" "Cleared in-flight task state. Starting fresh."
          inflight_tasks=""
          inflight_count=0
          inflight_primary_count=0
          STARTUP_SLOT_LIMIT="$EFFECTIVE_MAX_PARALLEL"
        else
          log_error "Failed to clear in-flight task state."
          exit 1
        fi
        break
        ;;
      q|Q)
        log "status" "Cancelled by user."
        exit 0
        ;;
      *)
        log_warn "Invalid selection: ${RESUME_CHOICE:-<empty>}"
        ;;
    esac
  done
fi


# Display configuration
if [[ "$DRY_RUN" == "true" ]]; then
  echo "============================================"
  echo "DRY-RUN MODE - No actions will be executed"
  echo "============================================"
fi


log "info" "Configuration:"
log "info" "  Repository: $REPO_DIR"
log "info" "  Base branch: $BASE_BRANCH"
log "info" "  Worktree root: $WORKTREE_ROOT"
log "info" "  Project: ${PROJECT_NAME:-(all projects)}"
log "info" "  Agent: $AGENT_CMD ($(agent_name "$AGENT_CMD"))${AGENT_CMD_EXPLICIT:+ [explicit override]}"
log "info" "  Router: ${ROUTER_ENABLED:-true} (per-task agent+model selection)$(wavemill_config_annotation "router.enabled" "${ROUTER_ENABLED:-true}")"
if (( EFFECTIVE_MAX_PARALLEL < MAX_PARALLEL )); then
  log "status" "  Max parallel: $EFFECTIVE_MAX_PARALLEL (reduced from $MAX_PARALLEL - all models degraded)$(wavemill_config_annotation "mill.maxParallel" "$MAX_PARALLEL")"
else
  log "info" "  Max parallel: $MAX_PARALLEL$(wavemill_config_annotation "mill.maxParallel" "$MAX_PARALLEL")"
fi
log "info" "  Planning mode: $PLANNING_MODE"
log "info" "  Dashboard verbosity: ${DASHBOARD_VERBOSITY:-info}"
[[ -n "${SETUP_CMD:-}" ]] && log "info" "  Setup command: $SETUP_CMD$(wavemill_config_annotation "mill.setupCommand" "$SETUP_CMD")"
log "info" "  State file: $STATE_FILE"
if [[ -n "${inflight_tasks:-}" ]]; then
  log "info" "  Resume detected: ${inflight_count:-0} in-flight task(s), startup slot limit: $STARTUP_SLOT_LIMIT"
fi
echo ""


# Safety check: first-time repo confirmation (skipped in dry-run)
if [[ ! -f "$STATE_DIR/.initialized" ]] && [[ "$REQUIRE_CONFIRM" == "true" ]] && [[ "$DRY_RUN" != "true" ]]; then
  echo "⚠️  First-time run in this repository"
  confirm "Continue with autonomous workflow in $REPO_DIR?" || exit 1
  execute touch "$STATE_DIR/.initialized"
fi


TASKS=()
if [[ "$SKIP_BACKLOG_SELECTION" != "true" ]]; then
  log "info" "Fetching backlog..."
  BACKLOG="$(linear_list_backlog)" || {
    log_error "Failed to fetch backlog from Linear. Check your LINEAR_API_KEY and network."
    exit 1
  }

  if [[ -z "$BACKLOG" ]] || [[ "$BACKLOG" == "[]" ]]; then
    log "status" "No backlog items returned from Linear."
    exit 0
  fi

  # Filter out parent issues (epics) - HOK-2867
  # Warnings go to stderr, filtered JSON goes to stdout
  BACKLOG="$(filter_parent_issues "$BACKLOG")"

  CANDIDATES="$(pick_candidates "$BACKLOG")"
  if [[ -z "$CANDIDATES" ]]; then
    log "status" "No backlog candidates found."
    exit 0
  fi
fi

check_subsystem_drift() {
  local drift_output
  drift_output="$(npx tsx tools/check-drift.ts "$REPO_DIR" 2>/dev/null)" || return 1
  printf '%s\n' "$drift_output"
}

PROJECT_CONTEXT_OVERSIZED=""
check_project_context_size() {
  local context_file="$REPO_DIR/.wavemill/project-context.md"
  local threshold_kb="${PROJECT_CONTEXT_COMPACTION_THRESHOLD_KB:-100}"
  local threshold_bytes=$(( threshold_kb * 1024 ))

  PROJECT_CONTEXT_OVERSIZED=""
  if [[ ! -f "$context_file" ]]; then
    project_context_suggestion_clear 2>/dev/null || true
    return 0
  fi

  local size_bytes
  size_bytes="$(get_file_size_bytes "$context_file" 2>/dev/null)" || return 0

  if (( size_bytes > threshold_bytes )); then
    PROJECT_CONTEXT_OVERSIZED=$(( size_bytes / 1024 ))
    project_context_suggestion_set "$size_bytes" "$threshold_bytes" 2>/dev/null || true
    log "info" "  project-context.md is ${PROJECT_CONTEXT_OVERSIZED}KB (>${threshold_kb}KB threshold; suggesting compaction)$(wavemill_config_annotation "projectContext.compactionThresholdKb" "$threshold_kb")"
  else
    project_context_suggestion_clear 2>/dev/null || true
  fi
}


check_project_context_size

if [[ "$SKIP_BACKLOG_SELECTION" != "true" ]]; then
  # Split candidates into unblocked and blocked
  # pick_candidates() outputs 6 fields (has_detailed_plan is stripped), so field 6 is blocked_by_count
  UNBLOCKED=$(echo "$CANDIDATES" | awk -F'|' '$6 == 0 || $6 == ""')
  BLOCKED=$(echo "$CANDIDATES" | awk -F'|' '$6 > 0')
  WAVE_LAUNCH_LINES=""
  WAVE_LAUNCH_USED=false
  BLOCKED_COUNT=0
  [[ -n "$BLOCKED" ]] && BLOCKED_COUNT=$(echo "$BLOCKED" | grep -c .)
  SHOW_BLOCKED_TASKS=false
  while true; do
    DRIFT_SUBSYSTEMS=""
    if DRIFT_SUBSYSTEMS="$(check_subsystem_drift)"; then
      :
    fi

    if [[ "$SHOW_BLOCKED_TASKS" == "true" ]]; then
      CANDIDATES=$(printf '%s\n%s' "$UNBLOCKED" "$BLOCKED" | grep .)
    else
      CANDIDATES="$UNBLOCKED"
    fi

    if [[ -n "$DRIFT_SUBSYSTEMS" ]]; then
      echo ""
      echo "  Warning: Subsystem docs stale ($DRIFT_SUBSYSTEMS) - press d to refresh"
    fi

    if [[ -n "${PROJECT_CONTEXT_OVERSIZED:-}" ]]; then
      echo ""
      echo "  ⚠ project-context.md is ${PROJECT_CONTEXT_OVERSIZED}KB (>${PROJECT_CONTEXT_COMPACTION_THRESHOLD_KB:-100}KB) - press 'c' to compact"
    fi

    echo ""
    if [[ "$SHOW_BLOCKED_TASKS" == "true" ]]; then
      log "info" "All tasks (ranked by priority):"
      line_num=0
      while IFS= read -r line; do
        line_num=$((line_num + 1))
        IFS='|' read -r id slug title area score blocked_by <<<"$line"
        if (( blocked_by > 0 )); then
          printf "  %s. %s - %s (score: %.0f) [blocked]\n" "$line_num" "$id" "$title" "$score"
        else
          printf "  %s. %s - %s (score: %.0f)\n" "$line_num" "$id" "$title" "$score"
        fi
      done <<<"$CANDIDATES"
    else
      log "status" "Available tasks (ranked by priority):"
      if [[ -n "$UNBLOCKED" ]]; then
        echo "$UNBLOCKED" | head -9 | awk -F'|' '{printf "  %s. %s - %s (score: %.0f)\n", NR, $1, $3, $5}'
      else
        echo "  (no unblocked tasks)"
      fi
    fi

    if [[ "$SHOW_BLOCKED_TASKS" != "true" ]] && (( BLOCKED_COUNT > 0 )); then
      echo ""
      echo "  ($BLOCKED_COUNT blocked task(s) hidden - enter 'm' to show all)"
    fi

    echo ""
    if (( STARTUP_SLOT_LIMIT < MAX_PARALLEL )); then
      log "info" "Startup launch capacity: $STARTUP_SLOT_LIMIT new task(s) (max parallel $MAX_PARALLEL, accounting for resumed work)"
    fi
    if [[ -n "$DRIFT_SUBSYSTEMS" ]]; then
      if (( BLOCKED_COUNT > 0 )) && [[ "$SHOW_BLOCKED_TASKS" != "true" ]]; then
        if [[ -n "${PROJECT_CONTEXT_OVERSIZED:-}" ]]; then
          echo "Enter numbers to run (e.g. 1 3 5), d to refresh docs, m for more, c to compact context, q to quit, or Enter to launch recommended wave:"
        else
          echo "Enter numbers to run (e.g. 1 3 5), d to refresh docs, m for more, q to quit, or Enter to launch recommended wave:"
        fi
      else
        if [[ -n "${PROJECT_CONTEXT_OVERSIZED:-}" ]]; then
          echo "Enter numbers to run (e.g. 1 3 5), d to refresh docs, c to compact context, q to quit, or Enter to launch recommended wave:"
        else
          echo "Enter numbers to run (e.g. 1 3 5), d to refresh docs, q to quit, or Enter to launch recommended wave:"
        fi
      fi
    else
      if (( BLOCKED_COUNT > 0 )) && [[ "$SHOW_BLOCKED_TASKS" != "true" ]]; then
        if [[ -n "${PROJECT_CONTEXT_OVERSIZED:-}" ]]; then
          echo "Enter numbers to run (e.g. 1 3 5), m for more, c to compact context, q to quit, or Enter to launch recommended wave:"
        else
          echo "Enter numbers to run (e.g. 1 3 5), m for more, q to quit, or Enter to launch recommended wave:"
        fi
      else
        if [[ -n "${PROJECT_CONTEXT_OVERSIZED:-}" ]]; then
          echo "Enter numbers to run (e.g. 1 3 5), c to compact context, q to quit, or Enter to launch recommended wave:"
        else
          echo "Enter numbers to run (e.g. 1 3 5), q to quit, or Enter to launch recommended wave:"
        fi
      fi
    fi
    read -r SELECTED

    if [[ "$SELECTED" =~ ^[cC](ompact)?$ ]] && [[ -n "${PROJECT_CONTEXT_OVERSIZED:-}" ]]; then
      echo ""
      log "info" "Compacting project-context.md..."
      if npx tsx "$TOOLS_DIR/compact-project-context.ts" "$REPO_DIR"; then
        PROJECT_CONTEXT_OVERSIZED=""
        project_context_suggestion_clear 2>/dev/null || true
        echo ""
        log "info" "Compaction complete. Re-displaying task list..."
      fi
      continue
    fi

    if [[ "$SELECTED" =~ ^[dD](ocs)?$ ]]; then
      echo ""
      if [[ -n "$DRIFT_SUBSYSTEMS" ]]; then
        log "info" "Refreshing subsystem docs..."
        npx tsx tools/init-project-context.ts --refresh "$REPO_DIR"
        echo ""
        log "info" "Refresh complete. Re-displaying task list..."
      else
        echo "Subsystem docs are up to date"
      fi
      SHOW_BLOCKED_TASKS=false
      continue
    fi

    if [[ "$SELECTED" =~ ^[mM] ]] && (( BLOCKED_COUNT > 0 )) && [[ "$SHOW_BLOCKED_TASKS" != "true" ]]; then
      SHOW_BLOCKED_TASKS=true
      continue
    fi

    if [[ "$SELECTED" =~ ^[qQ](uit)?$ ]]; then
      log "status" "Cancelled by user."
      exit 0
    fi

    if [[ -z "$SELECTED" ]]; then
      if [[ "${ENTER_LAUNCHES_WAVE:-true}" == "true" ]]; then
        WAVE_LAUNCH_USED=true
        startup_queue_plan=$(build_queue_plan_once "$BACKLOG" 2>/dev/null) || startup_queue_plan=""
        LAUNCH_QUEUE_PLAN="$startup_queue_plan"
        if [[ -n "$startup_queue_plan" ]]; then
          wave_result=$(invoke_first_wave_helper "$startup_queue_plan" "$UNBLOCKED" "$STARTUP_SLOT_LIMIT" 2>/dev/null) || wave_result=""
          wave_ids=$(jq -r '.wave[]?' <<<"$wave_result" 2>/dev/null) || wave_ids=""
          deferred_ids=$(jq -r '.deferred[]?' <<<"$wave_result" 2>/dev/null) || deferred_ids=""
          [[ -n "$deferred_ids" ]] && log "info" "[wave-launch] deferred: $(tr '\n' ',' <<<"$deferred_ids" | sed 's/,$//')"
          while IFS= read -r wid; do
            [[ -z "$wid" ]] && continue
            wline=$(grep -m1 "^${wid}|" <<<"$UNBLOCKED" 2>/dev/null || echo "")
            [[ -n "$wline" ]] && WAVE_LAUNCH_LINES+="${wline}"$'\n'
          done <<<"$wave_ids"
          if [[ -z "$wave_ids" ]]; then
            log "status" "No tasks currently available, waiting on dependencies."
          fi
        else
          WAVE_LAUNCH_USED=false
          [[ -n "$UNBLOCKED" ]] && CANDIDATES="$UNBLOCKED"
        fi
      elif [[ -n "$UNBLOCKED" ]]; then
        CANDIDATES="$UNBLOCKED"
      fi
    fi

    break
  done

  if [[ "$WAVE_LAUNCH_USED" == "true" ]]; then
    SELECTED_LINES="${WAVE_LAUNCH_LINES%$'\n'}"
  else
    SELECTED_LINES="$(smart_select_from_candidates "$CANDIDATES" "$SELECTED")"
  fi
  while IFS= read -r line; do
    [[ -n "$line" ]] && TASKS+=("$line")
  done <<<"$SELECTED_LINES"
fi


if [[ "$SKIP_BACKLOG_SELECTION" == "true" ]]; then
  log "info" "Skipping backlog selection and new task launch; monitor will resume in-flight tasks."
else
  log "info" "Normalizing issues with task packets and launching work..."
fi
LAUNCH_ARGS=()
declare -A TASK_LINEAR_ISSUE_BY_ISSUE
declare -A TASK_CHALLENGE_BY_ISSUE
declare -A TASK_CHALLENGE_PAIR_BY_ISSUE
declare -A TASK_CHALLENGE_ROLE_BY_ISSUE
declare -A TASK_CHALLENGE_MODEL_BY_ISSUE
declare -A TASK_CHALLENGE_STAGE_BY_ISSUE
declare -A TASK_CHALLENGE_INTENT_BY_ISSUE
declare -A TASK_AGENT_BY_ISSUE
declare -A TASK_PLANNER_MODEL_BY_ISSUE
declare -A TASK_CODER_MODEL_BY_ISSUE
declare -A TASK_REVIEWER_MODEL_BY_ISSUE
declare -A TASK_PLAN_DEPTH_BY_ISSUE
declare -A TASK_CODE_DEPTH_BY_ISSUE
declare -A TASK_REVIEW_MODE_BY_ISSUE


if (( ${#TASKS[@]} > 0 )); then
  # Pre-allocate migration numbers for parallel work
  # Fetch first so we scan the latest state of the base branch (not stale local files)
  if [[ "$DRY_RUN" == "true" ]]; then
    log "debug" "Dry-run: skipping base-branch fetch before migration scan."
  else
    log "debug" "Fetching latest $BASE_BRANCH for migration scan..."
    wavemill_fetch_base_branch "$BASE_BRANCH" --force 2>/dev/null || true
  fi

  # Scan the git tree (not local filesystem) for the highest existing migration number
  HIGHEST=$(scan_highest_migration)
  NEXT_MIGRATION_NUM=$((HIGHEST + 1))
  save_next_migration_num "$NEXT_MIGRATION_NUM"
  log "debug" "Next available migration number: $NEXT_MIGRATION_NUM (highest in origin/$BASE_BRANCH: $HIGHEST)"


  # ── Phase 1: Fetch issue details (reuse backlog payload when possible) ───
  log "info" "Fetching issue details..."
  for t in "${TASKS[@]}"; do
    IFS='|' read -r ISSUE SLUG TITLE <<<"$t"
    (
      backlog_record=""

      if [[ -n "${BACKLOG:-}" ]]; then
        backlog_record=$(printf '%s' "$BACKLOG" | jq -c --arg id "$ISSUE" \
          '.[] | select(.identifier == $id)' 2>/dev/null || true)
      fi

      if [[ -n "$backlog_record" ]] && issue_payload_is_complete "$backlog_record"; then
        log "debug" "  $ISSUE: reuse-backlog (skipping re-fetch)"
        printf '%s\n' "$backlog_record" > "/tmp/${SESSION}-${ISSUE}-issue.json"
      else
        log "debug" "  $ISSUE: refetch"
        json=$(linear_get_issue "$ISSUE" 2>/dev/null || echo "{}")
        printf '%s\n' "$json" > "/tmp/${SESSION}-${ISSUE}-issue.json"
      fi
    ) &
  done
  wait
  log "info" "All issues fetched"


  # ── Phase 2: Write task packets (no expansion — agent expands in-pane) ────
  # If the Linear description is already a task packet, use it directly.
  # Otherwise, write the title plus raw description — the planning agent will expand later.
  for t in "${TASKS[@]}"; do
    IFS='|' read -r ISSUE SLUG TITLE <<<"$t"
    PACKET_FILE="/tmp/${SESSION}-${ISSUE}-taskpacket.md"
    issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
    current_desc=$(echo "$issue_json" | jq -r '.description // ""' 2>/dev/null || echo "")

    if is_task_packet "$current_desc"; then
      log "info" "$ISSUE has task packet"
      printf '%s\n' "$current_desc" > "$PACKET_FILE"
    else
      log "info" "$ISSUE title and raw description saved (agent will expand)"
      if [[ -n "$current_desc" ]]; then
        printf '%s\n\n%s\n' "$TITLE" "$current_desc" > "$PACKET_FILE"
      else
        printf '%s\n' "$TITLE" > "$PACKET_FILE"
      fi
    fi
  done
fi


# ── Phase 3: Migration detection ──────────────────────────────────────────
for t in "${TASKS[@]}"; do
  IFS='|' read -r ISSUE SLUG TITLE <<<"$t"
  PACKET_FILE="/tmp/${SESSION}-${ISSUE}-taskpacket.md"
  issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
  current_desc=$(echo "$issue_json" | jq -r '.description // ""' 2>/dev/null || echo "")

  # Check if task involves database migration
  # Detection order: 1) label match  2) keyword in raw description
  # Note: expanded packet keyword scan moved to planning agent (post-expansion)
  has_migration_label=$(echo "$issue_json" | jq -r '.labels.nodes[]? | select(.name | ascii_downcase | test("migration|database|schema|alembic")) | .name' 2>/dev/null | head -1)
  is_migration=false

  if [[ -n "$has_migration_label" ]]; then
    log "debug" "  → Migration detected (label: $has_migration_label), assigning number: $NEXT_MIGRATION_NUM"
    is_migration=true
  elif echo "$current_desc" | grep -qi "alembic\|migration.*file\|database.*migration\|schema.*migration"; then
    log "debug" "  → Migration detected (raw description keyword match), assigning number: $NEXT_MIGRATION_NUM"
    log "debug" "    Tip: Add 'migration' label to $ISSUE for more reliable detection"
    is_migration=true
  fi

  if [[ "$is_migration" == "true" ]]; then
    # Append migration hint to task packet
    echo "" >> "$PACKET_FILE"
    echo "---" >> "$PACKET_FILE"
    echo "**ASSIGNED MIGRATION NUMBER**: $NEXT_MIGRATION_NUM" >> "$PACKET_FILE"
    echo "" >> "$PACKET_FILE"
    echo "Use revision='$(printf '%03d' $NEXT_MIGRATION_NUM)' in your Alembic migration file." >> "$PACKET_FILE"
    echo "CRITICAL: This number has been reserved to avoid conflicts with parallel tasks." >> "$PACKET_FILE"
    # Persist reservation so the monitoring loop can continue the sequence
    save_migration_reservation "$ISSUE" "$NEXT_MIGRATION_NUM"
    NEXT_MIGRATION_NUM=$((NEXT_MIGRATION_NUM + 1))
  fi

  log "status" "$ISSUE ready"
  LAUNCH_ARGS+=("$t")
done


# ── Phase 4: Stage-aware model routing ─────────────────────────────────
if [[ -n "${FORCE_MODEL:-}" ]]; then
  if ! agent_validate_model "$FORCE_MODEL" "$REPO_DIR"; then
    log_error "Invalid FORCE_MODEL: $FORCE_MODEL"
    log_error "Run 'wavemill mill' without FORCE_MODEL to use the router, or fix the model name."
    exit 1
  fi
  log "info" "FORCE_MODEL=$FORCE_MODEL - skipping router"
elif [[ "${ROUTER_ENABLED:-true}" == "true" ]]; then
  if [[ -n "${WAVEMILL_PLANNER_MODEL:-}" ]] && ! agent_validate_model "$WAVEMILL_PLANNER_MODEL" "$REPO_DIR"; then
    log_error "Invalid WAVEMILL_PLANNER_MODEL: $WAVEMILL_PLANNER_MODEL"
    exit 1
  fi
  if [[ -n "${WAVEMILL_CODER_MODEL:-}" ]] && ! agent_validate_model "$WAVEMILL_CODER_MODEL" "$REPO_DIR"; then
    log_error "Invalid WAVEMILL_CODER_MODEL: $WAVEMILL_CODER_MODEL"
    exit 1
  fi
  if [[ -n "${WAVEMILL_REVIEWER_MODEL:-}" ]] && ! agent_validate_model "$WAVEMILL_REVIEWER_MODEL" "$REPO_DIR"; then
    log_error "Invalid WAVEMILL_REVIEWER_MODEL: $WAVEMILL_REVIEWER_MODEL"
    exit 1
  fi
  ROUTE_TOOL="$TOOLS_DIR/route-task.ts"
  ROUTE_BATCH_TOOL="$TOOLS_DIR/route-tasks.ts"
  if [[ -f "$ROUTE_TOOL" ]]; then
    log "info" "Running model router..."
    ROUTE_MAX_COST_ARGS=()
    if [[ -n "${DEFAULT_MAX_COST_USD:-}" ]]; then
      ROUTE_MAX_COST_ARGS=(--max-cost "$DEFAULT_MAX_COST_USD")
    fi
    STARTUP_BATCH_ROUTED=false
    if [[ -f "$ROUTE_BATCH_TOOL" ]]; then
      ROUTE_BATCH_INPUT="/tmp/${SESSION}-route-batch-input.jsonl"
      ROUTE_BATCH_OUTPUT="/tmp/${SESSION}-route-batch-output.jsonl"
      ROUTE_BATCH_STDERR="/tmp/${SESSION}-route-batch.stderr"
      BATCH_ROUTE_ISSUES=()
      : > "$ROUTE_BATCH_INPUT"

      for t in "${TASKS[@]}"; do
        IFS='|' read -r ISSUE SLUG TITLE <<<"$t"
        PACKET_FILE="/tmp/${SESSION}-${ISSUE}-taskpacket.md"
        if [[ -f "$PACKET_FILE" ]]; then
          jq -cn --arg issueId "$ISSUE" --arg file "$PACKET_FILE" '{issueId: $issueId, file: $file}' >> "$ROUTE_BATCH_INPUT"
          printf '\n' >> "$ROUTE_BATCH_INPUT"
          BATCH_ROUTE_ISSUES+=("$ISSUE")
        fi
      done

      if (( ${#BATCH_ROUTE_ISSUES[@]} > 0 )); then
        rm -f "$ROUTE_BATCH_OUTPUT" "$ROUTE_BATCH_STDERR"
        if npx tsx "$ROUTE_BATCH_TOOL" --jsonl "$ROUTE_BATCH_INPUT" --repo-dir "$REPO_DIR" "${ROUTE_MAX_COST_ARGS[@]}" >"$ROUTE_BATCH_OUTPUT" 2>"$ROUTE_BATCH_STDERR"; then
          replay_route_transparency_logs "$ROUTE_BATCH_STDERR"
          mapfile -t BATCH_ROUTE_LINES < <(grep -v '^[[:space:]]*$' "$ROUTE_BATCH_OUTPUT" 2>/dev/null || true)
          if (( ${#BATCH_ROUTE_LINES[@]} == ${#BATCH_ROUTE_ISSUES[@]} )); then
            STARTUP_BATCH_ROUTED=true
            for idx in "${!BATCH_ROUTE_LINES[@]}"; do
              ISSUE="${BATCH_ROUTE_ISSUES[$idx]}"
              ROUTE_JSON="${BATCH_ROUTE_LINES[$idx]}"
              if ! echo "$ROUTE_JSON" | jq -e '.planner and .coder and .reviewer' >/dev/null 2>&1; then
                STARTUP_BATCH_ROUTED=false
                log_warn "  $ISSUE: Batch router returned invalid JSON, falling back to per-task routing"
                break
              fi

              PLANNER=$(echo "$ROUTE_JSON" | jq -r '.planner // empty' 2>/dev/null)
              CODER=$(echo "$ROUTE_JSON" | jq -r '.coder // empty' 2>/dev/null)
              REVIEWER=$(echo "$ROUTE_JSON" | jq -r '.reviewer // empty' 2>/dev/null)
              PLAN_DEPTH=$(echo "$ROUTE_JSON" | jq -r '.planDepth // "light"' 2>/dev/null)
              CODE_DEPTH=$(echo "$ROUTE_JSON" | jq -r '.codeDepth // "medium"' 2>/dev/null)
              REVIEW_MODE=$(echo "$ROUTE_JSON" | jq -r '.reviewRecommended // "static"' 2>/dev/null)
              ROUTING_MODE=$(echo "$ROUTE_JSON" | jq -r '.routingMode // "unknown"' 2>/dev/null)
              NEIGHBOR_COUNT=$(echo "$ROUTE_JSON" | jq -r '.neighborCount // 0' 2>/dev/null)

              log "info" "  $ISSUE: planner=$PLANNER ($PLAN_DEPTH), coder=$CODER ($CODE_DEPTH), reviewer=$REVIEWER ($REVIEW_MODE)"
              log "info" "          routing=$ROUTING_MODE, neighbors=$NEIGHBOR_COUNT"

              echo "$ROUTE_JSON" > "/tmp/${SESSION}-${ISSUE}-route.json"

              CODER_AGENT=$(agent_resolve_from_model "${CODER:-}" "coding" || true)
              jq -n \
                --arg model "${CODER:-}" \
                --arg agent "$CODER_AGENT" \
                --arg taskType "$(echo "$ROUTE_JSON" | jq -r '.signals.taskType // "unknown"')" \
                --arg reasoning "$(echo "$ROUTE_JSON" | jq -r '.reasoning[0] // ""')" \
                --argjson neighborCount "${NEIGHBOR_COUNT:-0}" \
                --arg routingMode "${ROUTING_MODE:-unknown}" \
                '{
                  recommendedModel: $model,
                  recommendedAgent: $agent,
                  taskType: $taskType,
                  confidence: (if $neighborCount > 0 then "medium" elif $routingMode == "heuristic-fallback" then "low" else "medium" end),
                  insufficientData: ($neighborCount == 0 and $routingMode == "heuristic-fallback"),
                  reasoning: $reasoning
                }' > "/tmp/${SESSION}-${ISSUE}-model-suggestion.json"
            done
          else
            log_warn "  Batch router returned ${#BATCH_ROUTE_LINES[@]} result(s) for ${#BATCH_ROUTE_ISSUES[@]} task(s); falling back to per-task routing"
          fi
        else
          replay_route_transparency_logs "$ROUTE_BATCH_STDERR"
          log_warn "  Batch router failed, falling back to per-task routing"
        fi
        rm -f "$ROUTE_BATCH_INPUT" "$ROUTE_BATCH_OUTPUT" "$ROUTE_BATCH_STDERR"
      fi
    fi

    if [[ "$STARTUP_BATCH_ROUTED" != "true" ]]; then
      for t in "${TASKS[@]}"; do
        IFS='|' read -r ISSUE SLUG TITLE <<<"$t"
        PACKET_FILE="/tmp/${SESSION}-${ISSUE}-taskpacket.md"
        if [[ -f "$PACKET_FILE" ]]; then
          ROUTE_STDERR="/tmp/${SESSION}-${ISSUE}-route.stderr"
          rm -f "$ROUTE_STDERR"
          ROUTE_JSON=$(npx tsx "$ROUTE_TOOL" --json --file "$PACKET_FILE" --repo-dir "$REPO_DIR" "${ROUTE_MAX_COST_ARGS[@]}" 2>"$ROUTE_STDERR" || echo "")
          replay_route_transparency_logs "$ROUTE_STDERR"
          rm -f "$ROUTE_STDERR"
          if [[ -n "$ROUTE_JSON" ]] && echo "$ROUTE_JSON" | jq -e '.planner' >/dev/null 2>&1; then
            PLANNER=$(echo "$ROUTE_JSON" | jq -r '.planner // empty' 2>/dev/null)
            CODER=$(echo "$ROUTE_JSON" | jq -r '.coder // empty' 2>/dev/null)
            REVIEWER=$(echo "$ROUTE_JSON" | jq -r '.reviewer // empty' 2>/dev/null)
            PLAN_DEPTH=$(echo "$ROUTE_JSON" | jq -r '.planDepth // "light"' 2>/dev/null)
            CODE_DEPTH=$(echo "$ROUTE_JSON" | jq -r '.codeDepth // "medium"' 2>/dev/null)
            REVIEW_MODE=$(echo "$ROUTE_JSON" | jq -r '.reviewRecommended // "static"' 2>/dev/null)
            ROUTING_MODE=$(echo "$ROUTE_JSON" | jq -r '.routingMode // "unknown"' 2>/dev/null)
            NEIGHBOR_COUNT=$(echo "$ROUTE_JSON" | jq -r '.neighborCount // 0' 2>/dev/null)

            log "info" "  $ISSUE: planner=$PLANNER ($PLAN_DEPTH), coder=$CODER ($CODE_DEPTH), reviewer=$REVIEWER ($REVIEW_MODE)"
            log "info" "          routing=$ROUTING_MODE, neighbors=$NEIGHBOR_COUNT"

            echo "$ROUTE_JSON" > "/tmp/${SESSION}-${ISSUE}-route.json"

            CODER_AGENT=$(agent_resolve_from_model "${CODER:-}" "coding" || true)
            jq -n \
              --arg model "${CODER:-}" \
              --arg agent "$CODER_AGENT" \
              --arg taskType "$(echo "$ROUTE_JSON" | jq -r '.signals.taskType // "unknown"')" \
              --arg reasoning "$(echo "$ROUTE_JSON" | jq -r '.reasoning[0] // ""')" \
              --argjson neighborCount "${NEIGHBOR_COUNT:-0}" \
              --arg routingMode "${ROUTING_MODE:-unknown}" \
              '{
                recommendedModel: $model,
                recommendedAgent: $agent,
                taskType: $taskType,
                confidence: (if $neighborCount > 0 then "medium" elif $routingMode == "heuristic-fallback" then "low" else "medium" end),
                insufficientData: ($neighborCount == 0 and $routingMode == "heuristic-fallback"),
                reasoning: $reasoning
              }' > "/tmp/${SESSION}-${ISSUE}-model-suggestion.json"
          else
            log "info" "  $ISSUE: Router returned no result, using defaults"
          fi
        fi
      done
    fi
    echo ""
  fi
fi

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

# ── Phase 5: Challenge-mode launch planning ──────────────────────────────
FINAL_LAUNCH_ARGS=()
slots_used=0

for t in "${TASKS[@]}"; do
  IFS='|' read -r ISSUE SLUG TITLE <<<"$t"
  if (( slots_used >= STARTUP_SLOT_LIMIT )); then
    log "status" "  $ISSUE: Deferring launch (no remaining slots after challenge allocation)"
    continue
  fi
  rec_model=""
  rec_agent="$AGENT_CMD"
  route_planner=""
  route_reviewer=""
  route_plan_depth="light"
  route_code_depth="medium"
  route_review_mode="static"

  if [[ -n "${FORCE_MODEL:-}" ]]; then
    rec_model="$FORCE_MODEL"
    rec_agent="$(agent_resolve_from_model "$FORCE_MODEL" "coding" || true)"
    route_planner="$FORCE_MODEL"
    route_reviewer="$FORCE_MODEL"
    route_plan_depth="light"
    route_code_depth="medium"
    route_review_mode="static"
  else
    rec_model=$(read_route_json "$SESSION" "$ISSUE" "coder")
    route_planner=$(read_route_json "$SESSION" "$ISSUE" "planner")
    route_reviewer=$(read_route_json "$SESSION" "$ISSUE" "reviewer")
    route_plan_depth=$(read_route_json "$SESSION" "$ISSUE" "planDepth" "light")
    route_code_depth=$(read_route_json "$SESSION" "$ISSUE" "codeDepth" "medium")
    route_review_mode=$(read_route_json "$SESSION" "$ISSUE" "reviewRecommended" "static")
    if [[ -n "$rec_model" ]]; then
      rec_agent="$(agent_resolve_from_model "$rec_model" "coding" || true)"
    fi
  fi

  # Challengers are free overhead (don't consume a slot), so always pass
  # remaining-slots >= 2 as long as the primary slot is available.
  challenge_mode="single"
  challenge_reason=""
  if [[ -n "${FORCE_MODEL:-}" ]]; then
    challenge_reason="forced_model"
    log "debug" "  $ISSUE: Challenge skipped because FORCE_MODEL is set ($FORCE_MODEL)"
  else
    _rs=$((STARTUP_SLOT_LIMIT - slots_used))
    (( _rs < 2 )) && _rs=2
    challenge_args=(--issue "$ISSUE" --slug "$SLUG" --title "$TITLE" --repo-dir "$REPO_DIR" --remaining-slots "$_rs")
    if [[ -d "${WORKTREE_ROOT}/${SLUG}/features/${SLUG}" ]]; then
      challenge_args+=(--feature-dir "${WORKTREE_ROOT}/${SLUG}/features/${SLUG}")
    fi
    [[ -f "/tmp/${SESSION}-${ISSUE}-taskpacket.md" ]] && challenge_args+=(--file "/tmp/${SESSION}-${ISSUE}-taskpacket.md")
    [[ -n "$rec_model" ]] && challenge_args+=(--primary-model "$rec_model")
    challenge_plan=$(npx tsx "$TOOLS_DIR/resolve-challenge-task.ts" "${challenge_args[@]}" 2>/dev/null || echo "")
    challenge_mode=$(echo "$challenge_plan" | jq -r '.mode // "single"' 2>/dev/null || echo "single")
    challenge_reason=$(echo "$challenge_plan" | jq -r '.reason // empty' 2>/dev/null || echo "")
    log_challenge_selection_health_plan "$ISSUE" "$challenge_plan"
    if [[ "$challenge_mode" == "challenge_unavailable" ]]; then
      log_challenge_unavailable_plan "$ISSUE" "$challenge_plan"
      continue
    fi
    if challenge_plan_stage_requires_effective_route "$challenge_plan"; then
      release_challenge_selection_health_plan "$ISSUE" "$challenge_plan"
      challenge_mode="single"
      challenge_reason="plan_stage_expanded_route_unavailable"
      log_warn "  $ISSUE: Planner challenge deferred until expanded route is available"
    fi
  fi

  if [[ "$challenge_mode" == "challenge" ]]; then
    primary_model=$(echo "$challenge_plan" | jq -r '.entries[0].model // empty' 2>/dev/null)
    challenger_key=$(echo "$challenge_plan" | jq -r '.entries[1].key // empty' 2>/dev/null)
    challenger_slug=$(echo "$challenge_plan" | jq -r '.entries[1].slug // empty' 2>/dev/null)
    challenger_branch=$(echo "$challenge_plan" | jq -r '.entries[1].branch // empty' 2>/dev/null)
    challenger_model=$(echo "$challenge_plan" | jq -r '.entries[1].model // empty' 2>/dev/null)
    challenger_agent=$(echo "$challenge_plan" | jq -r '.entries[1].agent // empty' 2>/dev/null)
    primary_agent=$(echo "$challenge_plan" | jq -r '.entries[0].agent // empty' 2>/dev/null)
    challenge_stage=$(echo "$challenge_plan" | jq -r '.challengeStage // "implementation"' 2>/dev/null || echo "implementation")
    primary_entry_planner=$(echo "$challenge_plan" | jq -r '.entries[0].planner // empty' 2>/dev/null)
    primary_entry_reviewer=$(echo "$challenge_plan" | jq -r '.entries[0].reviewer // empty' 2>/dev/null)
    primary_entry_planner_agent=$(echo "$challenge_plan" | jq -r '.entries[0].plannerAgent // empty' 2>/dev/null)
    primary_entry_plan_depth=$(echo "$challenge_plan" | jq -r '.entries[0].planDepth // empty' 2>/dev/null)
    primary_entry_code_depth=$(echo "$challenge_plan" | jq -r '.entries[0].codeDepth // empty' 2>/dev/null)
    primary_entry_review_mode=$(echo "$challenge_plan" | jq -r '.entries[0].reviewMode // empty' 2>/dev/null)
    challenger_entry_planner=$(echo "$challenge_plan" | jq -r '.entries[1].planner // empty' 2>/dev/null)
    challenger_entry_reviewer=$(echo "$challenge_plan" | jq -r '.entries[1].reviewer // empty' 2>/dev/null)
    challenger_entry_planner_agent=$(echo "$challenge_plan" | jq -r '.entries[1].plannerAgent // empty' 2>/dev/null)
    challenger_entry_plan_depth=$(echo "$challenge_plan" | jq -r '.entries[1].planDepth // empty' 2>/dev/null)
    challenger_entry_code_depth=$(echo "$challenge_plan" | jq -r '.entries[1].codeDepth // empty' 2>/dev/null)
    challenger_entry_review_mode=$(echo "$challenge_plan" | jq -r '.entries[1].reviewMode // empty' 2>/dev/null)
    challenge_intent=$(echo "$challenge_plan" | jq -c '.challengeIntent // null' 2>/dev/null || echo "null")

    cp "/tmp/${SESSION}-${ISSUE}-taskpacket.md" "/tmp/${SESSION}-${challenger_key}-taskpacket.md" 2>/dev/null || true
    cp "/tmp/${SESSION}-${ISSUE}-issue.json" "/tmp/${SESSION}-${challenger_key}-issue.json" 2>/dev/null || true
    cp "/tmp/${SESSION}-${ISSUE}-taskpacket-details.md" "/tmp/${SESSION}-${challenger_key}-taskpacket-details.md" 2>/dev/null || true

    TASK_LINEAR_ISSUE_BY_ISSUE["$ISSUE"]="$ISSUE"
    TASK_CHALLENGE_BY_ISSUE["$ISSUE"]="true"
    TASK_CHALLENGE_PAIR_BY_ISSUE["$ISSUE"]="$ISSUE"
    TASK_CHALLENGE_ROLE_BY_ISSUE["$ISSUE"]="primary"
    TASK_CHALLENGE_MODEL_BY_ISSUE["$ISSUE"]="$primary_model"
    TASK_CHALLENGE_STAGE_BY_ISSUE["$ISSUE"]="$challenge_stage"
    TASK_CHALLENGE_INTENT_BY_ISSUE["$ISSUE"]="$challenge_intent"
    TASK_AGENT_BY_ISSUE["$ISSUE"]="${primary_entry_planner_agent:-${primary_agent:-$rec_agent}}"
    TASK_PLANNER_MODEL_BY_ISSUE["$ISSUE"]="${primary_entry_planner:-$route_planner}"
    TASK_CODER_MODEL_BY_ISSUE["$ISSUE"]="$primary_model"
    TASK_REVIEWER_MODEL_BY_ISSUE["$ISSUE"]="${primary_entry_reviewer:-$route_reviewer}"
    TASK_PLAN_DEPTH_BY_ISSUE["$ISSUE"]="${primary_entry_plan_depth:-$route_plan_depth}"
    TASK_CODE_DEPTH_BY_ISSUE["$ISSUE"]="${primary_entry_code_depth:-$route_code_depth}"
    TASK_REVIEW_MODE_BY_ISSUE["$ISSUE"]="${primary_entry_review_mode:-$route_review_mode}"

    TASK_LINEAR_ISSUE_BY_ISSUE["$challenger_key"]="$ISSUE"
    TASK_CHALLENGE_BY_ISSUE["$challenger_key"]="true"
    TASK_CHALLENGE_PAIR_BY_ISSUE["$challenger_key"]="$ISSUE"
    TASK_CHALLENGE_ROLE_BY_ISSUE["$challenger_key"]="challenger"
    TASK_CHALLENGE_MODEL_BY_ISSUE["$challenger_key"]="$challenger_model"
    TASK_CHALLENGE_STAGE_BY_ISSUE["$challenger_key"]="$challenge_stage"
    TASK_CHALLENGE_INTENT_BY_ISSUE["$challenger_key"]="$challenge_intent"
    TASK_AGENT_BY_ISSUE["$challenger_key"]="${challenger_entry_planner_agent:-${challenger_agent:-$AGENT_CMD}}"
    # Stage-varied challengers carry their own planner/reviewer in the entry
    TASK_PLANNER_MODEL_BY_ISSUE["$challenger_key"]="${challenger_entry_planner:-$route_planner}"
    TASK_CODER_MODEL_BY_ISSUE["$challenger_key"]="$challenger_model"
    TASK_REVIEWER_MODEL_BY_ISSUE["$challenger_key"]="${challenger_entry_reviewer:-$route_reviewer}"
    TASK_PLAN_DEPTH_BY_ISSUE["$challenger_key"]="${challenger_entry_plan_depth:-$route_plan_depth}"
    TASK_CODE_DEPTH_BY_ISSUE["$challenger_key"]="${challenger_entry_code_depth:-$route_code_depth}"
    TASK_REVIEW_MODE_BY_ISSUE["$challenger_key"]="${challenger_entry_review_mode:-$route_review_mode}"

    FINAL_LAUNCH_ARGS+=("$ISSUE|$SLUG|$TITLE")
    FINAL_LAUNCH_ARGS+=("$challenger_key|$challenger_slug|$TITLE")
    slots_used=$((slots_used + 1))  # Challenger is free overhead
    primary_varied=$(echo "$challenge_plan" | jq -r '.entries[0].variedModel // .entries[0].model // empty' 2>/dev/null)
    challenger_varied=$(echo "$challenge_plan" | jq -r '.entries[1].variedModel // .entries[1].model // empty' 2>/dev/null)
    log "status" "  $ISSUE: Challenge selected (stage=${challenge_stage}: ${primary_varied} vs ${challenger_varied}) [challenger is extra pane]"
  else
    if [[ -n "$challenge_reason" ]] && [[ "$challenge_reason" != "challenge_disabled" ]] && [[ "$challenge_reason" != "roll_not_selected" ]]; then
      log "debug" "  $ISSUE: Challenge skipped ($challenge_reason), launching single-model run"
    fi
    TASK_LINEAR_ISSUE_BY_ISSUE["$ISSUE"]="$ISSUE"
    TASK_CHALLENGE_BY_ISSUE["$ISSUE"]="false"
    TASK_CHALLENGE_PAIR_BY_ISSUE["$ISSUE"]=""
    TASK_CHALLENGE_ROLE_BY_ISSUE["$ISSUE"]=""
    TASK_CHALLENGE_MODEL_BY_ISSUE["$ISSUE"]=""
    TASK_CHALLENGE_STAGE_BY_ISSUE["$ISSUE"]=""
    TASK_CHALLENGE_INTENT_BY_ISSUE["$ISSUE"]="null"
    TASK_AGENT_BY_ISSUE["$ISSUE"]="$rec_agent"
    TASK_PLANNER_MODEL_BY_ISSUE["$ISSUE"]="$route_planner"
    TASK_CODER_MODEL_BY_ISSUE["$ISSUE"]="$rec_model"
    TASK_REVIEWER_MODEL_BY_ISSUE["$ISSUE"]="$route_reviewer"
    TASK_PLAN_DEPTH_BY_ISSUE["$ISSUE"]="$route_plan_depth"
    TASK_CODE_DEPTH_BY_ISSUE["$ISSUE"]="$route_code_depth"
    TASK_REVIEW_MODE_BY_ISSUE["$ISSUE"]="$route_review_mode"
    FINAL_LAUNCH_ARGS+=("$ISSUE|$SLUG|$TITLE")
    slots_used=$((slots_used + 1))
  fi
done

LAUNCH_ARGS=("${FINAL_LAUNCH_ARGS[@]}")
# Create monitoring script that will run in tmux
STATUS_LOG_FILE="/tmp/${SESSION}-mill-status.log"
MONITOR_ENV="/tmp/${SESSION}-monitor.env"
MONITOR_SCRIPT="/tmp/${SESSION}-monitor.sh"
LAUNCHED_ISSUES_FILE="/tmp/${SESSION}-launched-issues.txt"
if [[ ! -f "$SCRIPT_DIR/wavemill-monitor.sh" ]]; then
  echo "Error: shared/lib/wavemill-monitor.sh not found beside wavemill-mill.sh" >&2
  exit 1
fi
cp "$SCRIPT_DIR/wavemill-monitor.sh" "$MONITOR_SCRIPT"

# HOK-1297 / HOK-1364: Investigate bash syntax errors reported during exit
#
# INVESTIGATION SUMMARY
# =====================
# HOK-1297:
# - Bug report: "syntax error near unexpected token `(' at line 5572"
# - Trigger: Forced exit after challenge panes failed to exit when issues lost their challenge
# - Date: April 15, 2026
#
# HOK-1364:
# - Bug report: "unexpected EOF while looking for matching `\"'" at line 6268
# - Trigger: Reported after tmux attach returned at session exit
# - Date: April 19, 2026
#
# Investigation steps performed:
# 1. ✓ Ran `bash -n shared/lib/wavemill-mill.sh` → PASS (no syntax errors found)
# 2. ✓ Ran `bash -n` on the extracted monitor heredoc content → PASS
# 3. ✓ Examined the reported lines: `sleep "$POLL_SECONDS"` and
#      `log "info" "  Type 'q' in mill window to quit"` are syntactically correct
# 4. ✓ Checked git history: No missing quote fix exists between the report and current HEAD
# 5. ✓ Searched for invalid 'local' keywords outside function context → NONE FOUND
#    (Previous bugs: fc198c8, d45ea00 fixed similar runtime errors with 'local')
# 6. ✓ Verified the heredoc terminator and generated monitor script syntax → CORRECT
#
# Conclusions:
# - Current codebase is syntactically valid; no unterminated string is present in this file.
# - Because this repo runs from Dropbox, a mid-execution file replacement can make bash report
#   a misleading EOF or line number while the shell is still reading the script in chunks.
# - The generated monitor script now has CI coverage via `tests/check-shell.sh`, so heredoc
#   quoting regressions are caught before runtime.
# - `_update_effective_max_parallel` is intentionally applied during startup so the main script
#   uses the degraded-model concurrency cap before any slot-selection logic runs.
#
# Defensive safeguards:
#
# 1. Monitor script syntax validation (below)
#    - Attempts to use the bash from monitor script shebang, falls back to system bash
#    - Catches syntax errors from heredoc expansion or variable substitution
#    - Provides diagnostic output if validation fails
#    - Prevents cryptic runtime errors during forced exit scenarios
#
# 2. Enhanced cleanup trap handler (line 928)
#    - Optional DEBUG_CLEANUP=1 for detailed error context
#    - Non-fatal error handling preserved
#
MONITOR_BASH="/opt/homebrew/bin/bash"
[[ ! -x "$MONITOR_BASH" ]] && MONITOR_BASH="bash"
validate_output=$($MONITOR_BASH -n "$MONITOR_SCRIPT" 2>&1)
if [[ -n "$validate_output" ]]; then
  log_error "Generated monitor script has syntax errors:"
  echo "$validate_output" | sed 's/^/  /' >&2
  log_error "Monitor script saved at: $MONITOR_SCRIPT"
  log_error "This may indicate a bug in the monitor script generation."
  exit 1
fi

chmod +x "$MONITOR_SCRIPT"


BASE_REF_PREFLIGHT_FILE="$(mktemp "/tmp/${SESSION}-base-ref-preflight.XXXXXX.json")"
BASE_REF_PREFLIGHT_RC=0
log "info" "Checking base branch $BASE_BRANCH..."
(
  source "$WAVEMILL_COMMON_LIB_PATH" || true
  wavemill_base_ref_preflight "$BASE_BRANCH" --force-fetch --json-out "$BASE_REF_PREFLIGHT_FILE"
) || BASE_REF_PREFLIGHT_RC=$?
WAVEMILL_BASE_REF_PREFLIGHT_JSON="$(cat "$BASE_REF_PREFLIGHT_FILE" 2>/dev/null || echo '{}')"
rm -f "$BASE_REF_PREFLIGHT_FILE"
export WAVEMILL_BASE_REF_PREFLIGHT_JSON
WAVEMILL_RESOLVED_BASE_REF="$(printf '%s' "$WAVEMILL_BASE_REF_PREFLIGHT_JSON" | jq -r '.resolvedRef // empty' 2>/dev/null || true)"
export WAVEMILL_RESOLVED_BASE_REF
if [[ "$BASE_REF_PREFLIGHT_RC" -ne 0 ]]; then
  BASE_REF_FAILURE_REASON="$(printf '%s' "$WAVEMILL_BASE_REF_PREFLIGHT_JSON" | jq -r '.reason // "base_ref_unavailable"' 2>/dev/null || echo "base_ref_unavailable")"
  (
    source "$WAVEMILL_COMMON_LIB_PATH" || true
    wavemill_format_base_ref_preflight_failure "$WAVEMILL_BASE_REF_PREFLIGHT_JSON"
  ) >&2 || log_error "Wavemill cannot start: configured base branch \"$BASE_BRANCH\" is unavailable."
  export SESSION REPO_DIR STATE_FILE LAUNCH_PLAN_FILE STATUS_LOG_FILE LAUNCHED_ISSUES_FILE MONITOR_SCRIPT MONITOR_ENV MILL_LOG_DIR
  CLEANUP_STATUS="$(
    (
    source "$WAVEMILL_COMMON_LIB_PATH" || true
    wavemill_cleanup_launch_attempt
    ) 2>/dev/null || echo "partial"
  )"
  (
    source "$WAVEMILL_COMMON_LIB_PATH" || true
    wavemill_record_startup_terminal_reason "$BASE_REF_FAILURE_REASON" "$WAVEMILL_BASE_REF_PREFLIGHT_JSON" "$CLEANUP_STATUS"
  ) || true
  if [[ ! -s "$MILL_LOG_DIR/startup-terminal.jsonl" ]]; then
    mkdir -p "$MILL_LOG_DIR" 2>/dev/null || true
    printf '%s' "$WAVEMILL_BASE_REF_PREFLIGHT_JSON" | jq -c \
      --arg event "startup_terminal" \
      --arg reason "$BASE_REF_FAILURE_REASON" \
      --arg session "$SESSION" \
      --arg repoDir "$REPO_DIR" \
      --arg cleanupStatus "$CLEANUP_STATUS" \
      '. as $p | {
        event: $event,
        reason: $reason,
        configuredBranch: ($p.configuredBranch // null),
        checkedRefs: ($p.checkedRefs // []),
        resolvedRef: ($p.resolvedRef // null),
        fetchDegraded: ($p.fetchDegraded // false),
        session: $session,
        repoDir: $repoDir,
        cleanupStatus: $cleanupStatus
      }' >> "$MILL_LOG_DIR/startup-terminal.jsonl" 2>/dev/null || true
    printf '\n' >> "$MILL_LOG_DIR/startup-terminal.jsonl" 2>/dev/null || true
  fi
  exit 1
fi
if [[ "$(printf '%s' "$WAVEMILL_BASE_REF_PREFLIGHT_JSON" | jq -r '.fetchDegraded // false' 2>/dev/null)" == "true" ]]; then
  log_warn "Startup fetch for $BASE_BRANCH degraded; continuing with verified local base ref $WAVEMILL_RESOLVED_BASE_REF"
fi

: > "$STATUS_LOG_FILE"
: > "$LAUNCHED_ISSUES_FILE"

LAUNCH_PLAN_FILE="${WAVEMILL_DRY_RUN_PLAN_OUT:-/tmp/${SESSION}-launch-plan.json}"
if ! mkdir -p "$(dirname "$LAUNCH_PLAN_FILE")"; then
  log_error "Failed to create launch-plan directory: $(dirname "$LAUNCH_PLAN_FILE")"
  exit 1
fi
LAUNCH_QUEUE_PLAN=""
if [[ -n "${QUEUE_PLAN_CACHE:-}" ]]; then
  LAUNCH_QUEUE_PLAN="$QUEUE_PLAN_CACHE"
elif [[ -n "${BACKLOG_JSON_CACHE:-}" ]]; then
  LAUNCH_QUEUE_PLAN="$(build_queue_plan_once "$BACKLOG_JSON_CACHE" 2>/dev/null)" || LAUNCH_QUEUE_PLAN=""
fi
write_launch_plan "$LAUNCH_PLAN_FILE" "$LAUNCH_QUEUE_PLAN"
if ! jq empty "$LAUNCH_PLAN_FILE" >/dev/null 2>&1; then
  log_error "Generated launch plan is not valid JSON: $LAUNCH_PLAN_FILE"
  exit 1
fi

if [[ "$DRY_RUN" == "true" ]]; then
  log "status" "Dry-run launch plan written: $LAUNCH_PLAN_FILE"
  exit 0
fi

STARTUP_RUNNER="$SCRIPT_DIR/wavemill-startup-runner.sh"
if [[ ! -f "$STARTUP_RUNNER" ]]; then
  echo "Error: wavemill-startup-runner.sh not found at $STARTUP_RUNNER" >&2
  exit 1
fi

log "status" "Creating tmux session..."
create_tmux_session

printf -v STARTUP_CMD '%q %q' "$STARTUP_RUNNER" "$LAUNCH_PLAN_FILE"
STARTUP_CMD="/opt/homebrew/bin/bash $STARTUP_CMD"
tmux respawn-pane -k -t "$SESSION:$WAVEMILL_WINDOW_MILL.0" "$STARTUP_CMD"


# Now attach to the session
log "status" "Attaching to session: $SESSION"
log "info" "  Ctrl+B then W to switch windows"
log "info" "  Ctrl+B then D to detach"
log "info" "  Type 'q' in mill window to quit"
log "info" "  Or: touch $STATE_DIR/.stop-loop"
echo ""
sleep 1
set +e
tmux attach -t "$SESSION"
attach_rc=$?
set -e

if [[ "$attach_rc" -ne 0 && "$attach_rc" -ne 1 ]]; then
  log_warn "tmux attach exited with status $attach_rc"
fi

log "status" "Session ended. Run 'git -C $REPO_DIR worktree prune' if needed."
