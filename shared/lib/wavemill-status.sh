#!/opt/homebrew/bin/bash
# Wavemill Status Dashboard - Real-time task status for tmux control panel
#
# Usage: wavemill-status.sh [--pane=jobs|--pane=queued-pending] <session> <worktree_root> [state_file]
#
# Displays a compact per-task summary refreshing every 2 seconds by default
# (override with WAVEMILL_DASHBOARD_REFRESH_SECONDS=1..10):
#   ISSUE   TASK           TIME   PHASE         AGENT      PR
#   WAV-42  hero-cta        12m   📋 planning   ● running  —
#   WAV-55  nav-a11y         8m   🔨 executing  ● running  #147 ✓

set -euo pipefail

if ! declare -f wavemill_pick_usage_tip >/dev/null 2>&1; then
  _wss_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd 2>/dev/null)" || true
  if [[ -f "${_wss_dir}/wavemill-common.sh" ]]; then
    # shellcheck source=wavemill-common.sh
    source "${_wss_dir}/wavemill-common.sh"
  fi
  unset _wss_dir
fi
if ! declare -f wavemill_apply_window_metadata >/dev/null 2>&1; then
  _wss_title_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd 2>/dev/null)" || true
  if [[ -f "${_wss_title_dir}/wavemill-window-titles.sh" ]]; then
    # shellcheck source=wavemill-window-titles.sh
    source "${_wss_title_dir}/wavemill-window-titles.sh"
  fi
  unset _wss_title_dir
fi

PANE_MODE=""
if [[ "${1:-}" == --pane=* ]]; then
  PANE_MODE="${1#--pane=}"
  shift
fi

if [[ "$#" -lt 2 ]]; then
  echo "Usage: wavemill-status.sh [--pane=jobs|--pane=queued-pending] <session> <worktree_root> [state_file]" >&2
  exit 1
fi

SESSION="$1"
WORKTREE_ROOT="$2"
STATE_FILE="${3:-}"

if [[ -n "$PANE_MODE" ]]; then
  case "$PANE_MODE" in
    jobs|queued-pending) ;;
    *)
      echo "wavemill-status.sh: unsupported pane mode '$PANE_MODE'" >&2
      exit 1
      ;;
  esac
fi

# Signal-driven refresh uses USR1 for fast updates and polling as fallback.
WAVEMILL_REDRAW=0
trap 'WAVEMILL_REDRAW=1' USR1

DEFAULT_REFRESH=2
MAX_REFRESH=10
DEFAULT_TIP_REFRESH=60
MAX_TIP_REFRESH=3600
PR_CACHE="/tmp/${SESSION}-pr-cache.json"
OPENROUTER_WARNING_CACHE="/tmp/${SESSION}-openrouter-warning.txt"
PR_TTL=15
WAVEMILL_STATUS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WAVEMILL_REPO_DIR="$(cd "$WAVEMILL_STATUS_DIR/../.." && pwd)"
declare -Ag WAVEMILL_ROUTING_DISPLAY_CACHE=()
declare -Ag WAVEMILL_ARTIFACT_STATUS_CACHE=()

# Colors
G='\033[32m'; Y='\033[33m'; R='\033[31m'; D='\033[90m'; B='\033[1m'; N='\033[0m'
# Erase from cursor to end-of-line after each rendered row so shorter redraws
# cannot leave stale terminal cells behind.
EL='\033[K'

resolve_dashboard_refresh_seconds() {
  local raw_refresh="${WAVEMILL_DASHBOARD_REFRESH_SECONDS:-$DEFAULT_REFRESH}"

  if [[ "$raw_refresh" =~ ^[0-9]+$ ]] && (( raw_refresh >= 1 && raw_refresh <= MAX_REFRESH )); then
    printf '%s\n' "$raw_refresh"
    return 0
  fi

  if [[ "${WAVEMILL_DASHBOARD_REFRESH_WARNED:-0}" -eq 0 ]]; then
    printf 'wavemill: invalid WAVEMILL_DASHBOARD_REFRESH_SECONDS=%s, using default %s\n' \
      "$raw_refresh" "$DEFAULT_REFRESH" >&2
    WAVEMILL_DASHBOARD_REFRESH_WARNED=1
  fi

  printf '%s\n' "$DEFAULT_REFRESH"
}

resolve_tip_refresh_seconds() {
  local raw="${WAVEMILL_TIP_REFRESH_SECONDS:-$DEFAULT_TIP_REFRESH}"

  if [[ "$raw" =~ ^[0-9]+$ ]] && (( raw >= 1 && raw <= MAX_TIP_REFRESH )); then
    printf '%s\n' "$raw"
    return 0
  fi

  if [[ "${WAVEMILL_TIP_REFRESH_WARNED:-0}" -eq 0 ]]; then
    printf 'wavemill: invalid WAVEMILL_TIP_REFRESH_SECONDS=%s, using default %s\n' \
      "$raw" "$DEFAULT_TIP_REFRESH" >&2
    WAVEMILL_TIP_REFRESH_WARNED=1
  fi

  printf '%s\n' "$DEFAULT_TIP_REFRESH"
}

REFRESH="$(resolve_dashboard_refresh_seconds)"
TIP_REFRESH="$(resolve_tip_refresh_seconds)"
_CURRENT_TIP=""
_LAST_TIP_REFRESH_AT=0

# Hide cursor during rendering
tput civis 2>/dev/null || true
trap 'tput cnorm 2>/dev/null || true' EXIT

# ── PR cache (refreshed every PR_TTL seconds) ────────────────────────────

refresh_pr_cache() {
  local now
  now=$(date +%s)
  local mtime=0
  [[ -f "$PR_CACHE" ]] && mtime=$(stat -f %m "$PR_CACHE" 2>/dev/null || echo 0)
  if (( now - mtime >= PR_TTL )); then
    local tmp_file
    # Per-writer tmp file so this dashboard refresh does not race the monitor's
    # wavemill_pr_cache_refresh on a shared "${PR_CACHE}.tmp" path.
    tmp_file=$(mktemp "${PR_CACHE}.tmp.XXXXXX" 2>/dev/null) || return 0
    if gh pr list --json number,headRefName,state,statusCheckRollup --limit 50 \
         < /dev/null 2>/dev/null > "$tmp_file"; then
      if [[ -s "$tmp_file" ]]; then
        mv "$tmp_file" "$PR_CACHE" 2>/dev/null || rm -f "$tmp_file"
      else
        rm -f "$tmp_file"
      fi
    else
      rm -f "$tmp_file"
    fi
  fi
}

pr_for_branch() {
  local branch="$1"
  [[ -f "$PR_CACHE" ]] || return 0
  jq -r --arg b "$branch" \
    '.[] | select(.headRefName == $b) | "\(.number)|\(.state)"' \
    "$PR_CACHE" 2>/dev/null | head -1
}

pr_checks() {
  local branch="$1"
  [[ -f "$PR_CACHE" ]] || return 0
  # Rollup entries are either CheckRun (uses .conclusion) or StatusContext
  # (uses .state, e.g. Vercel/Netlify). Coalesce so both are treated uniformly.
  jq -r --arg b "$branch" '
    def outcome: .conclusion // .state;
    .[] | select(.headRefName == $b) |
    .statusCheckRollup // [] |
    if length == 0 then "none"
    elif all(.[]; outcome == "SUCCESS" or outcome == "NEUTRAL" or outcome == "SKIPPED") then "pass"
    elif any(.[]; outcome == "FAILURE" or outcome == "ERROR" or outcome == "TIMED_OUT" or outcome == "CANCELLED") then "fail"
    else "pending" end
  ' "$PR_CACHE" 2>/dev/null | head -1
}

# ── Agent-reported status (from status file) ──────────────────────────────

agent_reported_status() {
  local issue="$1"
  local status_file="/tmp/${SESSION}-${issue}-status.txt"
  if [[ -f "$status_file" ]]; then
    local raw_status
    raw_status=$(head -1 "$status_file" 2>/dev/null | tr -d '\r' | cut -c1-40)
    case "$raw_status" in
      working|waiting|done)
        echo "$raw_status"
        ;;
      *)
        echo "$raw_status"
        ;;
    esac
  fi
}

# Read detail field from hook JSON (e.g., tool name, error message).
# Only returns detail if hook file is fresh (300s TTL).
agent_hook_detail() {
  local issue="$1"
  local hook_file="/tmp/wavemill-${SESSION}-${issue}.hook"
  [[ -f "$hook_file" ]] || return 0

  local ts now staleness
  ts=$(jq -r '.timestamp // 0' "$hook_file" 2>/dev/null || echo 0)
  now=$(date +%s)
  staleness=$(( now - ts ))
  (( staleness < 300 )) || return 0

  jq -r '.detail // empty' "$hook_file" 2>/dev/null || true
}

# Read next_action field from hook JSON.
# Only returns next_action if hook file is fresh (300s TTL).
agent_hook_next_action() {
  local issue="$1"
  local hook_file="/tmp/wavemill-${SESSION}-${issue}.hook"
  [[ -f "$hook_file" ]] || return 0

  local ts now staleness
  ts=$(jq -r '.timestamp // 0' "$hook_file" 2>/dev/null || echo 0)
  now=$(date +%s)
  staleness=$(( now - ts ))
  (( staleness < 300 )) || return 0

  jq -r '.next_action // empty' "$hook_file" 2>/dev/null || true
}

# Read the planning stage display status from stage result files.
# Returns: awaiting_approval, approved, running, rejected, aborted, or empty string.
get_planning_display_status() {
  local worktree="$1" slug="$2"
  local feature_dir="$worktree/features/$slug"
  local result_file="$feature_dir/.planning-result.json"

  if [[ -f "$result_file" ]]; then
    local status
    status=$(jq -r '.status // empty' "$result_file" 2>/dev/null)
    case "$status" in
      awaiting_user) echo "awaiting_approval" ;;
      completed)     echo "approved" ;;
      running)       echo "running" ;;
      failed)        echo "rejected" ;;
      aborted)       echo "aborted" ;;
      *)             echo "" ;;
    esac
    return
  fi

}

get_ready_display_status() {
  local worktree="$1" slug="$2"
  local feature_dir="$worktree/features/$slug"
  local result_file="$feature_dir/.ready-result.json"

  [[ -f "$result_file" ]] || return 0
  jq -r '.status // empty' "$result_file" 2>/dev/null || true
}

# Return "approval_needed" when the coding stage result shows awaiting_user
# with an approvalRequest artifact, otherwise return empty string.
# HOK-2364: surface human-approval pause distinct from generic awaiting_user.
get_coding_approval_status() {
  local worktree="$1" slug="$2"
  local feature_dir="$worktree/features/$slug"
  local result_file="$feature_dir/.coding-result.json"

  [[ -f "$result_file" ]] || return 0
  local status request_id
  status=$(jq -r '.status // empty' "$result_file" 2>/dev/null) || return 0
  [[ "$status" == "awaiting_user" ]] || return 0
  request_id=$(jq -r '.artifacts.approvalRequest.requestId // empty' "$result_file" 2>/dev/null) || return 0
  [[ -n "$request_id" ]] && echo "approval_needed"
  return 0
}

get_ready_queue_state() {
  local worktree="$1" slug="$2"
  local feature_dir="$worktree/features/$slug"
  local result_file="$feature_dir/.ready-result.json"
  local status verdict queue_state

  [[ -f "$result_file" ]] || return 0
  queue_state=$(jq -r '.artifacts.queueState // empty' "$result_file" 2>/dev/null || true)
  if [[ -n "$queue_state" ]]; then
    printf '%s\n' "$queue_state"
    return 0
  fi

  status=$(jq -r '.status // empty' "$result_file" 2>/dev/null || true)
  verdict=$(jq -r '.artifacts.verdict // empty' "$result_file" 2>/dev/null || true)
  if [[ "$status" == "completed" && ( "$verdict" == "pass" || "$verdict" == "warn" ) ]]; then
    printf 'ready\n'
  fi
}

is_ready_conflicted() {
  local worktree="$1" slug="$2"
  local feature_dir=""
  local dir

  for dir in features bugs; do
    if [[ -d "$worktree/$dir/$slug" ]]; then
      feature_dir="$worktree/$dir/$slug"
      [[ -f "$feature_dir/.conflict-detected" ]] && return 0
      return 1
    fi
  done

  [[ -f "$worktree/features/$slug/.conflict-detected" ]]
}

is_stale_ready_gate_detail_for_phase() {
  local task_phase="${1:-}" agent_state="${2:-}" detail="${3:-}"

  [[ "$agent_state" == "running" ]] || return 1
  [[ "$task_phase" == "review" || "$task_phase" == "ready" ]] || return 1
  case "$detail" in
    Review\ verdict\ does\ not\ pass\ readiness\ gate*|\
    Review\ recorded\ no\ verdict*|\
    *blocked\ by\ scope\ guard*)
      return 0
      ;;
  esac
  return 1
}

ready_attention_detail() {
  local worktree="$1" slug="$2"
  local task_phase="${3:-}" agent_state="${4:-}"
  local feature_dir="$worktree/features/$slug"
  local attention_file="$feature_dir/.needs-attention"
  local detail

  [[ -f "$attention_file" ]] || return 0
  detail="$(head -1 "$attention_file" 2>/dev/null | tr -d '\r')"
  if is_stale_ready_gate_detail_for_phase "$task_phase" "$agent_state" "$detail"; then
    return 0
  fi
  printf '%s\n' "$detail"
}

truncate_blocked_completion_summary() {
  local summary="${1:-}"
  local max_len=80

  if (( ${#summary} > max_len )); then
    printf '%s...\n' "${summary:0:77}"
  else
    printf '%s\n' "$summary"
  fi
}

coding_blocked_completion_detail() {
  local worktree="$1" slug="$2" issue="$3"
  local feature_dir="$worktree/features/$slug"
  local artifact_record summary reason artifact_mtime
  local auto_detail uncommitted_detail

  auto_detail="$(coding_auto_advance_detail "$worktree" "$slug" "$issue")"
  [[ -z "$auto_detail" ]] || return 0

  uncommitted_detail="$(coding_uncommitted_output_detail "$worktree" "$slug" "$issue")"
  if [[ -n "$uncommitted_detail" ]]; then
    printf '%s\n' "$uncommitted_detail"
    return 0
  fi

  artifact_record="$(read_blocked_completion "$feature_dir" "$issue")"
  [[ -n "$artifact_record" ]] || return 0

  IFS=$'\001' read -r summary reason artifact_mtime <<< "$artifact_record"
  summary="$(truncate_blocked_completion_summary "$summary")"
  printf '%s needs attention: %s. Type "advance %s" to launch review.\n' "$issue" "$summary" "$issue"
}

coding_uncommitted_output_detail() {
  local worktree="$1" slug="$2" issue="$3"
  local feature_dir="$worktree/features/$slug"
  local artifact_record summary reason action artifact_mtime

  artifact_record="$(read_coding_uncommitted_output "$feature_dir")"
  [[ -n "$artifact_record" ]] || return 0

  IFS=$'\001' read -r summary reason action artifact_mtime <<< "$artifact_record"
  summary="$(truncate_blocked_completion_summary "$summary")"
  printf '%s needs attention: %s. %s\n' "$issue" "$summary" "$action"
}

coding_auto_advance_detail() {
  local worktree="$1" slug="$2" issue="$3"
  local feature_dir="$worktree/features/$slug"
  local artifact="$feature_dir/.coding-auto-advance.json"

  [[ -f "$artifact" ]] || return 0
  printf '%s auto-advanced coding to review from blocked completion.\n' "$issue"
}

planning_rejection_detail() {
  local worktree="$1" slug="$2"
  local feature_dir="$worktree/features/$slug"
  local artifact="$feature_dir/.planning-rejected.json"
  local reason files notified_at notify_status notify_attempts notify_target notify_suffix

  [[ -f "$artifact" ]] || return 0
  reason=$(jq -r '.reason // empty' "$artifact" 2>/dev/null || true)
  [[ "$reason" == "planning_modified_out_of_scope_files" ]] || return 0

  files=$(jq -r '(.outOfScopeFiles // []) | join(", ")' "$artifact" 2>/dev/null || true)
  [[ -n "$files" ]] || files="out-of-scope files"

  # Delivery status of the notification sent to the agent pane. Distinguishes a
  # successfully notified agent from one where the message was stranded in the
  # input box or otherwise never confirmed as submitted (HOK-2765).
  notified_at=$(jq -r '.notifiedAt // empty' "$artifact" 2>/dev/null || true)
  notify_status=$(jq -r '.notifyStatus // empty' "$artifact" 2>/dev/null || true)
  notify_attempts=$(jq -r '.notifyAttempts // empty' "$artifact" 2>/dev/null || true)
  notify_target=$(jq -r '.notifyTarget // empty' "$artifact" 2>/dev/null || true)

  if [[ -n "$notified_at" ]]; then
    notify_suffix=" Agent notified."
  else
    case "$notify_status" in
      stranded)
        notify_suffix=" Agent NOT notified: message stranded in pane input after ${notify_attempts:-?} attempts"
        [[ -n "$notify_target" ]] && notify_suffix+=" — press Enter in $notify_target"
        notify_suffix+="."
        ;;
      unconfirmed)
        notify_suffix=" Agent NOT notified: delivery unconfirmed after ${notify_attempts:-?} attempts"
        [[ -n "$notify_target" ]] && notify_suffix+=" — check $notify_target"
        notify_suffix+="."
        ;;
      unavailable)
        notify_suffix=" Agent NOT notified: pane unavailable."
        ;;
      "")
        notify_suffix=" Agent not notified."
        ;;
      *)
        notify_suffix=" Agent NOT notified: ${notify_status}."
        ;;
    esac
  fi

  printf 'Planning needs attention: edited %s; reverted. Review plan.md and re-approve.%s\n' "$files" "$notify_suffix"
}

# Read the arm-preservation flag that apply_expanded_route_if_present stamps on
# .routing-complete.  Prints "true", "false", or nothing when the task has no
# worktree, no routing artifact, or predates the flag.
challenge_arm_preserved_flag() {
  local issue="$1"
  local worktree slug routing_file

  [[ -n "$issue" && -n "${STATE_FILE:-}" && -f "${STATE_FILE:-}" ]] || return 0
  worktree=$(jq -r --arg issue "$issue" '.tasks[$issue].worktree // empty' "$STATE_FILE" 2>/dev/null || true)
  slug=$(jq -r --arg issue "$issue" '.tasks[$issue].slug // empty' "$STATE_FILE" 2>/dev/null || true)
  [[ -n "$worktree" && -n "$slug" ]] || return 0

  routing_file="$worktree/features/$slug/.routing-complete"
  [[ -f "$routing_file" ]] || return 0
  jq -r '.challengeArmPreserved // empty' "$routing_file" 2>/dev/null || true
}

native_launch_failure_detail() {
  local worktree="$1" slug="$2"
  local feature_dir="$worktree/features/$slug"
  local artifact="$feature_dir/.native-launch-failure.json"
  local issue stage model pane_target failure_kind exit_code action

  [[ -f "$artifact" ]] || return 0

  issue=$(jq -r '.issue // empty' "$artifact" 2>/dev/null || true)
  stage=$(jq -r '.stage // "native"' "$artifact" 2>/dev/null || echo "native")
  model=$(jq -r '.model // empty' "$artifact" 2>/dev/null || true)
  pane_target=$(jq -r '.paneTarget // empty' "$artifact" 2>/dev/null || true)
  failure_kind=$(jq -r '.failureKind // "native-launch-failure"' "$artifact" 2>/dev/null || echo "native-launch-failure")
  exit_code=$(jq -r '.exitCode // empty' "$artifact" 2>/dev/null || true)
  action=$(jq -r '.recommendedAction // "Inspect the pane transcript and route config before relaunching."' "$artifact" 2>/dev/null || true)

  if [[ -n "$exit_code" ]]; then
    printf 'Native %s launch failed: %s exit=%s\n' "$stage" "$failure_kind" "$exit_code"
  else
    printf 'Native %s launch failed: %s\n' "$stage" "$failure_kind"
  fi
  if [[ -n "$model" || -n "$pane_target" ]]; then
    printf 'model=%s pane=%s\n' "${model:-unknown}" "${pane_target:-unknown}"
  fi
  [[ -n "$action" ]] && printf '%s\n' "$action"
}

ready_watchdog_state_file() {
  [[ -n "$STATE_FILE" ]] || return 0
  printf '%s\n' "$(dirname "$STATE_FILE")/ready-watchdog-state.json"
}

ready_watchdog_field() {
  local issue="$1" field="$2"
  local watchdog_file
  watchdog_file="$(ready_watchdog_state_file)"
  [[ -n "$watchdog_file" && -f "$watchdog_file" ]] || return 0
  jq -r --arg issue "$issue" --arg field "$field" '.tasks[$issue][$field] // empty' "$watchdog_file" 2>/dev/null || true
}

# Legacy compat wrapper — used in the render loop below.
plan_waiting_for_review() {
  local task_phase="$1"
  local agent_state="$2"
  local worktree="$3"
  local slug="$4"

  [[ "$task_phase" == "planning" ]] || return 1
  [[ -z "$worktree" || -z "$slug" ]] && return 1

  # Prefer stage result
  local display_status
  display_status=$(get_planning_display_status "$worktree" "$slug")
  [[ "$display_status" == "awaiting_approval" ]] && return 0

  # If planning is no longer running and approval has not been recorded, treat
  # an exited agent as waiting for review until the monitor persists the stage update.
  [[ "$agent_state" == "exited" ]] || return 1
  return 0
}

render_plan_model_routing() {
  local worktree="$1" slug="$2"
  local planning_result_file="" initial_route_file="" post_expansion_file="" routing_complete_file=""
  local phase_config_file="" routing_jsonl_file="" candidate rendered cache_key artifact_key mtime

  for candidate in \
    "$worktree/features/$slug/.planning-result.json" \
    "$worktree/bugs/$slug/.planning-result.json"
  do
    [[ -f "$candidate" ]] || continue
    planning_result_file="$candidate"
    break
  done

  for candidate in \
    "$worktree/features/$slug/.initial-route.json" \
    "$worktree/bugs/$slug/.initial-route.json"
  do
    [[ -f "$candidate" ]] || continue
    initial_route_file="$candidate"
    break
  done

  for candidate in \
    "$worktree/features/$slug/.post-expansion-route.json" \
    "$worktree/bugs/$slug/.post-expansion-route.json"
  do
    [[ -f "$candidate" ]] || continue
    post_expansion_file="$candidate"
    break
  done

  for candidate in \
    "$worktree/features/$slug/.routing-complete" \
    "$worktree/bugs/$slug/.routing-complete"
  do
    [[ -f "$candidate" ]] || continue
    routing_complete_file="$candidate"
    break
  done

  for candidate in \
    "$worktree/features/$slug/.phase-config.json" \
    "$worktree/bugs/$slug/.phase-config.json"
  do
    [[ -f "$candidate" ]] || continue
    phase_config_file="$candidate"
    break
  done

  for candidate in \
    "$worktree/features/$slug/routing.jsonl" \
    "$worktree/bugs/$slug/routing.jsonl"
  do
    [[ -f "$candidate" ]] || continue
    routing_jsonl_file="$candidate"
    break
  done

  artifact_key=""
  for candidate in \
    "$planning_result_file" \
    "$initial_route_file" \
    "$post_expansion_file" \
    "$routing_complete_file" \
    "$phase_config_file" \
    "$routing_jsonl_file"
  do
    if [[ -n "$candidate" && -f "$candidate" ]]; then
      mtime=$(stat -f %m "$candidate" 2>/dev/null || stat -c %Y "$candidate" 2>/dev/null || echo 0)
      artifact_key+="${candidate}:${mtime}|"
    fi
  done

  if [[ -z "$artifact_key" ]]; then
    cache_key="missing:${worktree}:${slug}"
  else
    cache_key="$artifact_key"
  fi

  if [[ -v WAVEMILL_ROUTING_DISPLAY_CACHE["$cache_key"] ]]; then
    printf '%s' "${WAVEMILL_ROUTING_DISPLAY_CACHE["$cache_key"]}"
    return 0
  fi

  rendered="$(
    MODEL_RESOLUTION_DISPLAY_PLANNING_RESULT_PATH="$planning_result_file" \
    MODEL_RESOLUTION_DISPLAY_INITIAL_ROUTE_PATH="$initial_route_file" \
    MODEL_RESOLUTION_DISPLAY_POST_EXPANSION_PATH="$post_expansion_file" \
    MODEL_RESOLUTION_DISPLAY_ROUTING_COMPLETE_PATH="$routing_complete_file" \
    MODEL_RESOLUTION_DISPLAY_PHASE_CONFIG_PATH="$phase_config_file" \
    MODEL_RESOLUTION_DISPLAY_ROUTING_JSONL_PATH="$routing_jsonl_file" \
    MODEL_RESOLUTION_DISPLAY_MODULE="$WAVEMILL_REPO_DIR/shared/lib/model-resolution-display.ts" \
    NO_UPDATE_NOTIFIER=1 \
    npm_config_update_notifier=false \
    node --import tsx -e '
      (async () => {
        const modulePath = process.env.MODEL_RESOLUTION_DISPLAY_MODULE;
        const { formatRouteLifecycleDisplayTextFromPaths } = await import(modulePath);
        process.stdout.write(formatRouteLifecycleDisplayTextFromPaths({
          planningResultPath: process.env.MODEL_RESOLUTION_DISPLAY_PLANNING_RESULT_PATH,
          initialRoutePath: process.env.MODEL_RESOLUTION_DISPLAY_INITIAL_ROUTE_PATH,
          postExpansionRoutePath: process.env.MODEL_RESOLUTION_DISPLAY_POST_EXPANSION_PATH,
          routingCompletePath: process.env.MODEL_RESOLUTION_DISPLAY_ROUTING_COMPLETE_PATH,
          phaseConfigPath: process.env.MODEL_RESOLUTION_DISPLAY_PHASE_CONFIG_PATH,
          routingJsonlPath: process.env.MODEL_RESOLUTION_DISPLAY_ROUTING_JSONL_PATH,
        }));
      })().catch(() => process.exit(1));
    ' 2>/dev/null || true
  )"

  if [[ -z "$rendered" ]]; then
    rendered="executed planning: model resolution unavailable"$'\n'"bootstrap route: unavailable"
  fi
  WAVEMILL_ROUTING_DISPLAY_CACHE["$cache_key"]="$rendered"
  printf '%s' "$rendered"
}

# ── Normalized task artifact status (HOK-2261) ───────────────────────────
# Read-only, best-effort helpers that inspect normalized task artifacts
# (task-contract.json, feature-state.json, .trace-context.json, trace.jsonl)
# and compose a compact per-task status segment.  All functions degrade
# silently on missing or malformed input — never error, never write files.

# Extract contract status for a feature directory.
# Returns: "present", "stale" (source-hash drift), or "missing".
_artifact_contract_status() {
  local feature_dir="$1"
  local contract_file="$feature_dir/task-contract.json"

  command -v jq >/dev/null 2>&1 || { printf 'missing'; return; }
  [[ -f "$contract_file" ]] || { printf 'missing'; return; }
  jq -e '.' "$contract_file" >/dev/null 2>&1 || { printf 'missing'; return; }

  # Check every source whose hash was recorded for drift.
  local drift=0
  while IFS= read -r entry; do
    [[ -n "$entry" ]] || continue
    local src_path src_sha256
    src_path=$(jq -r '.path // empty' <<< "$entry" 2>/dev/null) || continue
    src_sha256=$(jq -r '.sha256 // empty' <<< "$entry" 2>/dev/null) || continue
    [[ -n "$src_path" && -n "$src_sha256" ]] || continue
    local abs="$feature_dir/$src_path"
    [[ -f "$abs" ]] || continue
    local current=""
    if command -v shasum >/dev/null 2>&1; then
      current=$(shasum -a 256 "$abs" 2>/dev/null | cut -d' ' -f1)
    elif command -v sha256sum >/dev/null 2>&1; then
      current=$(sha256sum "$abs" 2>/dev/null | cut -d' ' -f1)
    fi
    [[ -z "$current" ]] && continue
    if [[ "$current" != "$src_sha256" ]]; then
      drift=1; break
    fi
  done < <(jq -c '.sources[]? | select((.exists // false) == true and .sha256 != null and .sha256 != "")' "$contract_file" 2>/dev/null || true)

  [[ "$drift" -eq 1 ]] && printf 'stale' || printf 'present'
}

# Extract normalized outcome state from feature-state.json.
# Returns: short state string or "-".
_artifact_outcome_state() {
  local feature_dir="$1"
  local state_file="$feature_dir/feature-state.json"

  command -v jq >/dev/null 2>&1 || { printf '-'; return; }
  [[ -f "$state_file" ]] || { printf '-'; return; }

  local normalized
  normalized=$(jq -r '.normalizedState // empty' "$state_file" 2>/dev/null) || normalized=""
  [[ -z "$normalized" || "$normalized" == "unknown" ]] && { printf '-'; return; }

  if [[ "$normalized" == "failed" ]]; then
    local reason
    reason=$(jq -r '.failureReason // empty' "$state_file" 2>/dev/null) || reason=""
    if [[ -n "$reason" ]]; then
      printf 'fail:%s' "${reason:0:10}"
      return
    fi
    printf 'failed'
    return
  fi

  case "$normalized" in
    running)       printf 'running' ;;
    completed)     printf 'done' ;;
    aborted)       printf 'abort' ;;
    awaiting_user) printf 'waiting' ;;
    *)             printf '%s' "${normalized:0:8}" ;;
  esac
}

# Extract evidence record count from feature-state.json.
# Returns: integer string or "-".
_artifact_evidence_count() {
  local feature_dir="$1"
  local state_file="$feature_dir/feature-state.json"

  command -v jq >/dev/null 2>&1 || { printf '-'; return; }
  [[ -f "$state_file" ]] || { printf '-'; return; }

  local count
  count=$(jq -r '(.evidence // []) | length' "$state_file" 2>/dev/null) || { printf '-'; return; }
  [[ "$count" =~ ^[0-9]+$ ]] && printf '%s' "$count" || printf '-'
}

# Extract trace status from .trace-context.json + trace.jsonl.
# Returns: latest phase from trace events, "active" if traceId present but no
# events yet, or "-" if trace context is absent.
_artifact_trace_status() {
  local feature_dir="$1"
  local ctx_file="$feature_dir/.trace-context.json"
  local jsonl_file="$feature_dir/trace.jsonl"

  command -v jq >/dev/null 2>&1 || { printf '-'; return; }
  [[ -f "$ctx_file" ]] || { printf '-'; return; }

  local trace_id
  trace_id=$(jq -r '.traceId // empty' "$ctx_file" 2>/dev/null) || trace_id=""
  [[ -n "$trace_id" ]] || { printf '-'; return; }

  if [[ -f "$jsonl_file" ]]; then
    local last_phase=""
    while IFS= read -r line || [[ -n "$line" ]]; do
      [[ -n "$line" ]] || continue
      local ph
      ph=$(jq -r '.phase // empty' <<< "$line" 2>/dev/null) || continue
      [[ -n "$ph" ]] && last_phase="$ph"
    done < "$jsonl_file"
    [[ -n "$last_phase" ]] && { printf '%s' "${last_phase:0:8}"; return; }
  fi

  printf 'active'
}

# Render a compact artifact status segment for one feature directory.
# Output: e.g. "C✓ O:done E:3 T:review"  or  "C- O:- E:- T:-" for legacy tasks.
# Returns empty string if the feature directory does not exist.
# Uses a mtime-keyed in-memory cache to avoid redundant reads within one render
# cycle and across refreshes when files have not changed.
render_artifact_status_segment() {
  local feature_dir="$1"

  [[ -d "$feature_dir" ]] || {
    WAVEMILL_ARTIFACT_STATUS_CACHE["legacy:${feature_dir}"]=""
    return 0
  }
  command -v jq >/dev/null 2>&1 || return 0

  # Build a cache key from the mtimes of all four artifact files.
  local cache_key="" mtime
  for candidate in \
    "$feature_dir/task-contract.json" \
    "$feature_dir/feature-state.json" \
    "$feature_dir/.trace-context.json" \
    "$feature_dir/trace.jsonl"
  do
    if [[ -f "$candidate" ]]; then
      mtime=$(stat -f %m "$candidate" 2>/dev/null || stat -c %Y "$candidate" 2>/dev/null || echo 0)
      cache_key+="${candidate}:${mtime}|"
    fi
  done
  [[ -z "$cache_key" ]] && cache_key="legacy:${feature_dir}"

  if [[ -v WAVEMILL_ARTIFACT_STATUS_CACHE["$cache_key"] ]]; then
    printf '%s' "${WAVEMILL_ARTIFACT_STATUS_CACHE["$cache_key"]}"
    return 0
  fi

  local contract_status outcome evidence trace
  contract_status=$(_artifact_contract_status "$feature_dir")
  outcome=$(_artifact_outcome_state "$feature_dir")
  evidence=$(_artifact_evidence_count "$feature_dir")
  trace=$(_artifact_trace_status "$feature_dir")

  local contract_glyph
  case "$contract_status" in
    present)  contract_glyph="C✓" ;;
    stale)    contract_glyph="C⚠" ;;
    *)        contract_glyph="C-" ;;
  esac

  local segment="${contract_glyph} O:${outcome} E:${evidence} T:${trace}"
  WAVEMILL_ARTIFACT_STATUS_CACHE["$cache_key"]="$segment"
  printf '%s' "$segment"
}

# ── Elapsed time from directory birth ─────────────────────────────────────

elapsed() {
  local dir="$1"
  [[ -d "$dir" ]] || { echo "—"; return; }
  local birth
  birth=$(stat -f %B "$dir" 2>/dev/null || echo 0)
  (( birth > 0 )) || { echo "—"; return; }
  local mins=$(( ($(date +%s) - birth) / 60 ))
  if (( mins < 60 )); then
    printf "%dm" "$mins"
  else
    printf "%dh%dm" $((mins / 60)) $((mins % 60))
  fi
}

# ── Agent status via tmux pane liveness ───────────────────────────────────

# Read agent status via hook protocol with TTL-based fallback to pane liveness.
# Hook files use a 300s TTL - stale status falls back to tmux pane state.
agent_terminal_override() {
  local issue="$1"
  local task_status="" task_phase="" task_pr="" task_branch="" pr_info="" pr_state=""

  if [[ -n "$STATE_FILE" && -f "$STATE_FILE" ]]; then
    task_status="$(jq -r --arg issue "$issue" '.tasks[$issue].status // empty' "$STATE_FILE" 2>/dev/null || true)"
    task_phase="$(jq -r --arg issue "$issue" '.tasks[$issue].phase // empty' "$STATE_FILE" 2>/dev/null || true)"
    task_pr="$(jq -r --arg issue "$issue" '.tasks[$issue].pr // empty' "$STATE_FILE" 2>/dev/null || true)"
    task_branch="$(jq -r --arg issue "$issue" '.tasks[$issue].branch // empty' "$STATE_FILE" 2>/dev/null || true)"
  fi

  case "$task_status:$task_phase" in
    merged:*|closed:*|aborted:*|error:*|*:aborted|*:closed|*:done)
      echo "exited"
      return 0
      ;;
  esac

  if [[ -n "$task_pr" && -n "$task_branch" ]]; then
    pr_info="$(pr_for_branch "$task_branch")"
    if [[ -n "$pr_info" ]]; then
      IFS='|' read -r _pr_num pr_state <<<"$pr_info"
      case "$pr_state" in
        MERGED|CLOSED)
          echo "exited"
          return 0
          ;;
      esac
    fi
  fi
}

agent_status() {
  local issue="$1" target="${2:-}"
  local hook_file="/tmp/wavemill-${SESSION}-${issue}.hook"
  local terminal_override=""

  terminal_override="$(agent_terminal_override "$issue")"
  if [[ -n "$terminal_override" ]]; then
    echo "$terminal_override"
    return
  fi

  # Prefer hook-reported state when fresh (300s TTL)
  if [[ -f "$hook_file" ]]; then
    local state ts now staleness
    state=$(jq -r '.state // empty' "$hook_file" 2>/dev/null || true)
    ts=$(jq -r '.timestamp // 0' "$hook_file" 2>/dev/null || echo 0)
    now=$(date +%s)
    staleness=$(( now - ts ))

    if (( staleness < 300 )) && [[ -n "$state" ]]; then
      # Map hook states to dashboard display states
      case "$state" in
        working)         echo "running" ;;
        idle)            echo "exited" ;;
        waiting)         echo "waiting" ;;
        blocked)         echo "blocked" ;;
        approval-needed) echo "approval-needed" ;;
        policy-denied)   echo "policy-denied" ;;
        error)           echo "error" ;;
        *)               echo "$state" ;;
      esac
      return
    fi
  fi

  # Fallback to pane liveness for agents without hook support or stale hooks
  local dead
  [[ -n "$target" ]] || { echo "done"; return; }
  dead=$(tmux list-panes -t "$target" -F '#{pane_dead}' 2>/dev/null | head -1) || {
    echo "done"; return
  }
  if [[ "$dead" == "1" ]]; then echo "exited"; else echo "running"; fi
}

# ── Task discovery ────────────────────────────────────────────────────────
# Prefer state file (from mill), fall back to worktree directories.
# Output: issue|slug|branch|worktree|status|phase|pr  per line

gather_tasks() {
  if [[ -n "$STATE_FILE" && -f "$STATE_FILE" ]]; then
    jq -r '.tasks | to_entries[] | select(.key != "" and ((.value.slug // "") != "")) | "\(.key)|\(.value.slug)|\(.value.branch)|\(.value.worktree)|\(.value.status // "")|\(.value.phase // "executing")|\(.value.pr // "")"' \
      "$STATE_FILE" 2>/dev/null
  else
    for dir in "$WORKTREE_ROOT"/*/; do
      [[ -d "$dir" ]] || continue
      local slug
      slug=$(basename "$dir")
      local branch
      branch=$(git -C "$dir" branch --show-current 2>/dev/null || echo "?")
      echo "—|$slug|$branch|$dir||executing|"
    done
  fi
}

refresh_window_metadata_for_active_tasks() {
  declare -F wavemill_apply_window_metadata >/dev/null 2>&1 || return 0
  [[ -n "$STATE_FILE" && -f "$STATE_FILE" ]] || return 0

  local tasks issue slug branch worktree status phase pr target
  tasks="$(gather_tasks)"
  [[ -n "$tasks" ]] || return 0

  while IFS='|' read -r issue slug branch worktree status phase pr; do
    [[ -n "$issue" && -n "$slug" ]] || continue
    if ! is_active "$worktree" "$issue-$slug"; then
      continue
    fi
    target="$(task_window_target "$issue" "$slug" "$worktree")"
    wavemill_apply_window_metadata "$SESSION" "$issue" "$target" "$STATE_FILE" >/dev/null 2>&1 || true
  done <<< "$tasks"
}

gather_jobs() {
  [[ -r "$STATE_FILE" && -s "$STATE_FILE" ]] || return 0
  jq -r --arg session "$SESSION" '
    (.jobs // {}) |
    if type == "array" then .[] else (to_entries[] | .value) end |
    select((.kind == "eval" or .kind == "comparison") and .session? == $session) |
    [
      .id,
      .kind,
      (.status // ""),
      (.issueId // "-"),
      (.side // "-"),
      (.pairId // "-"),
      ((.prNumbers // []) | map(tostring) | join("/")),
      (.startedAt // "-"),
      (.logPath // "-"),
      ((.excerpt // "") | gsub("[\r\n]+"; " "))
    ] | join("|")
  ' "$STATE_FILE" 2>/dev/null
}

# ── Check if a task is still active ──────────────────────────────────────
# A task is active if its worktree exists OR its tmux window exists.

is_active() {
  local worktree="$1"
  local win="$2"
  [[ -d "$worktree" ]] && return 0
  local target="" issue="" slug=""
  if [[ "$win" =~ ^([A-Z]+-[0-9]+(_c)?)-(.+)$ ]]; then
    issue="${BASH_REMATCH[1]}"
    slug="${BASH_REMATCH[3]}"
    target="$(task_window_target "$issue" "$slug" "$worktree" 2>/dev/null || true)"
  fi
  [[ -n "$target" ]] || target="$SESSION:$win"
  tmux list-panes -t "$target" 2>/dev/null >/dev/null && return 0
  return 1
}

# Truncate detail string to fit within available terminal width.
# Format "%-10s  %4s  └─ %s" uses ~20 chars of prefix. Leave enough room for
# per-subagent requested/resolved/fallback routing details while still
# truncating long freeform status messages.
truncate_detail() {
  local detail="$1"
  local max_len=68
  if (( ${#detail} > max_len )); then
    echo "${detail:0:$((max_len - 3))}..."
  else
    echo "$detail"
  fi
}

render_task_detail_lines() {
  local detail_block="${1:-}"
  local line

  [[ -n "$detail_block" ]] || return 0

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -n "$line" ]] || continue
    line=$(truncate_detail "$line")
    printf "${D}%10s  %4s  └─ %s${N}${EL}\n" "" "" "$line" >> "$FRAME"
  done <<< "$detail_block"
}

truncate_cell() {
  local text="${1:-}" max_len="${2:-0}"
  if (( max_len <= 0 )); then
    printf ''
    return 0
  fi

  if (( ${#text} <= max_len )); then
    printf '%s' "$text"
    return 0
  fi

  if (( max_len <= 3 )); then
    printf '%.*s' "$max_len" "$text"
    return 0
  fi

  printf '%.*s...' "$((max_len - 3))" "$text"
}

format_job_elapsed() {
  local started_at="$1"
  local start_epoch now elapsed ts
  # Strip fractional seconds and timezone suffix (handles both 2006-01-02T15:04:05.999Z and no-fraction forms)
  ts="${started_at%%.*}"
  ts="${ts%Z}"
  if date -j -f "%Y-%m-%dT%H:%M:%S" "$ts" "+%s" >/dev/null 2>&1; then
    # BSD/macOS date
    start_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%S" "$ts" "+%s" 2>/dev/null || echo 0)
  else
    # GNU/Linux date
    start_epoch=$(date -d "${ts/T/ }" "+%s" 2>/dev/null || echo 0)
  fi
  now=$(date +%s)
  if (( start_epoch <= 0 || now < start_epoch )); then
    echo "—"
    return
  fi
  elapsed=$(( (now - start_epoch) / 60 ))
  if (( elapsed < 60 )); then
    printf "%dm" "$elapsed"
  else
    printf "%dh%dm" $((elapsed / 60)) $((elapsed % 60))
  fi
}

parse_iso_timestamp_epoch() {
  local timestamp="$1"
  local ts
  ts="${timestamp%%.*}"
  ts="${ts%Z}"
  ts="${ts%+*}"
  [[ -n "$ts" ]] || { echo 0; return; }
  if date -j -f "%Y-%m-%dT%H:%M:%S" "$ts" "+%s" >/dev/null 2>&1; then
    date -j -f "%Y-%m-%dT%H:%M:%S" "$ts" "+%s" 2>/dev/null || echo 0
  else
    date -d "${ts/T/ }" "+%s" 2>/dev/null || echo 0
  fi
}

format_running_elapsed() {
  local started_at="$1"
  local start_epoch now elapsed
  start_epoch=$(parse_iso_timestamp_epoch "$started_at")
  now=$(date +%s)
  if (( start_epoch <= 0 )); then
    echo ""
    return
  fi
  if (( now < start_epoch )); then
    echo "0s"
    return
  fi
  elapsed=$((now - start_epoch))
  if (( elapsed < 60 )); then
    printf "%ss" "$elapsed"
  elif (( elapsed < 3600 )); then
    printf "%dm%02ds" $((elapsed / 60)) $((elapsed % 60))
  else
    printf "%dh%02dm" $((elapsed / 3600)) $(((elapsed % 3600) / 60))
  fi
}

task_running_detail() {
  local issue="$1"
  [[ -r "$STATE_FILE" && -s "$STATE_FILE" ]] || return 0

  local eval_side eval_pr eval_phase eval_started eval_elapsed
  eval_side=$(jq -r --arg issue "$issue" '.tasks[$issue].evalRunning.side // empty' "$STATE_FILE" 2>/dev/null || true)
  if [[ -n "$eval_side" ]]; then
    eval_pr=$(jq -r --arg issue "$issue" '.tasks[$issue].evalRunning.pr // empty' "$STATE_FILE" 2>/dev/null || true)
    eval_phase=$(jq -r --arg issue "$issue" '.tasks[$issue].evalRunning.phase // "eval"' "$STATE_FILE" 2>/dev/null || echo "eval")
    eval_started=$(jq -r --arg issue "$issue" '.tasks[$issue].evalRunning.startedAt // empty' "$STATE_FILE" 2>/dev/null || true)
    eval_elapsed=$(format_running_elapsed "$eval_started")
    if [[ -n "$eval_elapsed" ]]; then
      printf 'eval running (%s): side=%s pr=#%s phase=%s\n' "$eval_elapsed" "$eval_side" "$eval_pr" "$eval_phase"
    else
      printf 'eval running: side=%s pr=#%s phase=%s\n' "$eval_side" "$eval_pr" "$eval_phase"
    fi
    return 0
  fi

  local pair_id primary_pr challenger_pr comparison_started comparison_elapsed
  pair_id=$(jq -r --arg issue "$issue" '.tasks[$issue].comparisonRunning.pairId // empty' "$STATE_FILE" 2>/dev/null || true)
  if [[ -n "$pair_id" ]]; then
    primary_pr=$(jq -r --arg issue "$issue" '.tasks[$issue].comparisonRunning.primaryPr // empty' "$STATE_FILE" 2>/dev/null || true)
    challenger_pr=$(jq -r --arg issue "$issue" '.tasks[$issue].comparisonRunning.challengerPr // empty' "$STATE_FILE" 2>/dev/null || true)
    comparison_started=$(jq -r --arg issue "$issue" '.tasks[$issue].comparisonRunning.startedAt // empty' "$STATE_FILE" 2>/dev/null || true)
    comparison_elapsed=$(format_running_elapsed "$comparison_started")
    if [[ -n "$comparison_elapsed" ]]; then
      printf 'comparison running (%s): pair=%s prs=#%s/#%s\n' "$comparison_elapsed" "$pair_id" "$primary_pr" "$challenger_pr"
    else
      printf 'comparison running: pair=%s prs=#%s/#%s\n' "$pair_id" "$primary_pr" "$challenger_pr"
    fi
    return 0
  fi

  # Surface the varied stage and both arms from the selection record, so an arm
  # replaced by rerouting is visible while the run is still live rather than
  # only after the comparison rejects the pair.
  local challenge_stage challenge_varied challenge_other challenge_role arm_preserved
  challenge_stage=$(jq -r --arg issue "$issue" '.tasks[$issue].challengeStage // empty' "$STATE_FILE" 2>/dev/null || true)
  if [[ -n "$challenge_stage" ]]; then
    challenge_role=$(jq -r --arg issue "$issue" '.tasks[$issue].challengeRole // "primary"' "$STATE_FILE" 2>/dev/null || echo "primary")
    challenge_varied=$(jq -r --arg issue "$issue" '.tasks[$issue].challengeVariedModel // empty' "$STATE_FILE" 2>/dev/null || true)
    challenge_other=$(jq -r --arg issue "$issue" --arg role "$challenge_role" '
      (.tasks[$issue].challengeExecutionIntent // .tasks[$issue].challengeIntent // {}) as $i
      | (if $role == "challenger" then $i.primary else $i.challenger end) // {}
      | .expectedStageModel // empty' "$STATE_FILE" 2>/dev/null || true)
    if [[ -n "$challenge_varied" ]]; then
      if [[ -n "$challenge_other" ]]; then
        printf 'challenge %s (stage=%s): this=%s vs %s\n' "$challenge_role" "$challenge_stage" "$challenge_varied" "$challenge_other"
      else
        printf 'challenge %s (stage=%s): this=%s\n' "$challenge_role" "$challenge_stage" "$challenge_varied"
      fi
      # apply_expanded_route_if_present stamps this false when it could not
      # retain the selected arm through rerouting.
      arm_preserved=$(challenge_arm_preserved_flag "$issue")
      if [[ "$arm_preserved" == "false" ]]; then
        printf 'challenge arm NOT preserved through rerouting — comparison will be unattributable\n'
      fi
    fi
  fi

  local comparison_state blocked_reason retry_count retry_max timed_out_sides manual_artifact
  comparison_state=$(jq -r --arg issue "$issue" '.tasks[$issue].comparisonState // empty' "$STATE_FILE" 2>/dev/null || true)
  [[ -n "$comparison_state" ]] || return 0
  blocked_reason=$(jq -r --arg issue "$issue" '.tasks[$issue].comparisonBlockedReason // empty' "$STATE_FILE" 2>/dev/null || true)
  retry_count=$(jq -r --arg issue "$issue" '.tasks[$issue].comparisonRetryCount // empty' "$STATE_FILE" 2>/dev/null || true)
  retry_max=$(jq -r --arg issue "$issue" '.tasks[$issue].comparisonRetryMaxAttempts // empty' "$STATE_FILE" 2>/dev/null || true)
  timed_out_sides=$(jq -r --arg issue "$issue" '.tasks[$issue].comparisonTimedOutSides // [] | join("/")' "$STATE_FILE" 2>/dev/null || true)
  manual_artifact=$(jq -r --arg issue "$issue" '.tasks[$issue].manualComparisonArtifact // empty' "$STATE_FILE" 2>/dev/null || true)

  case "$comparison_state" in
    retrying_eval)
      printf 'comparison retrying: timed_out=%s attempt=%s/%s reason=%s\n' "${timed_out_sides:-unknown}" "${retry_count:-0}" "${retry_max:-0}" "${blocked_reason:-eval_timed_out}"
      ;;
    manual_comparison_needed)
      printf 'manual comparison needed: timed_out=%s artifact=%s\n' "${timed_out_sides:-unknown}" "${manual_artifact:-missing}"
      ;;
    invalid_challenge)
      local invalid_reason invalid_details repair_action
      invalid_reason=$(jq -r --arg issue "$issue" '.tasks[$issue].invalidChallengeReason // "unknown"' "$STATE_FILE" 2>/dev/null || echo "unknown")
      invalid_details=$(jq -r --arg issue "$issue" '.tasks[$issue].invalidChallengeDetails // empty' "$STATE_FILE" 2>/dev/null || true)
      repair_action=$(jq -r --arg issue "$issue" '.tasks[$issue].challengeRepairAction // empty' "$STATE_FILE" 2>/dev/null || true)
      printf 'invalid challenge: reason=%s%s\n' "$invalid_reason" "${invalid_details:+ detail=$invalid_details}"
      printf 'retry/re-pair: %s\n' "${repair_action:-wavemill mill challenge repair}"
      ;;
  esac
  if [[ -n "$blocked_reason" && "$comparison_state" != "retrying_eval" ]]; then
    printf 'comparison blocker: %s\n' "$blocked_reason"
  fi
}

# Classify dashboard tasks into sections based on agent state.
is_actionable_state() {
  local agent_state="$1"
  local task_phase="${2:-}"
  local worktree="${3:-}"
  local slug="${4:-}"
  local issue="${5:-}"
  local ready_status attention_detail planning_detail watchdog_classification coding_detail launch_failure_detail

  launch_failure_detail=$(native_launch_failure_detail "$worktree" "$slug")
  if [[ -n "$launch_failure_detail" ]]; then
    echo "actionable"
    return
  fi

  if [[ "$task_phase" == "coding" ]]; then
    coding_detail=$(coding_blocked_completion_detail "$worktree" "$slug" "$issue")
    if [[ -n "$coding_detail" ]]; then
      echo "actionable"
      return
    fi
  fi

  planning_detail=$(planning_rejection_detail "$worktree" "$slug")
  if [[ -n "$planning_detail" ]]; then
    echo "actionable"
    return
  fi

  attention_detail=$(ready_attention_detail "$worktree" "$slug" "$task_phase" "$agent_state")
  if [[ -n "$attention_detail" ]]; then
    echo "actionable"
    return
  fi

  if [[ "$task_phase" == "ready" ]]; then
    watchdog_classification=$(ready_watchdog_field "$issue" "classification")
    case "$watchdog_classification" in
      stuck|needs-user)
        echo "actionable"
        return
        ;;
      waiting-on-ci|waiting-on-eval-comparison|waiting-on-merge-lane)
        echo "active"
        return
        ;;
    esac

    ready_status=$(get_ready_display_status "$worktree" "$slug")
    case "$ready_status" in
      completed|failed|aborted)
        echo "actionable"
        return
        ;;
    esac
  fi

  case "$agent_state" in
    exited|waiting|blocked|approval-needed|policy-denied|error) echo "actionable" ;;
    *)                                                           echo "active" ;;
  esac
}

task_window_target() {
  local issue="$1" slug="$2" worktree="$3"
  local stored_target="" canonical target target_path worktree_real target_real

  if [[ -n "$worktree" ]]; then
    worktree_real="$(cd -P "$worktree" 2>/dev/null && printf '%s\n' "$PWD" || printf '%s\n' "$worktree")"
  fi

  if [[ -n "$STATE_FILE" && -f "$STATE_FILE" ]]; then
    stored_target="$(jq -r --arg issue "$issue" '.tasks[$issue].windowId // empty' "$STATE_FILE" 2>/dev/null || true)"
  fi

  for target in "$stored_target" "$SESSION:$issue-$slug"; do
    [[ -n "$target" ]] || continue
    target_path="$(tmux display-message -p -t "$target" '#{pane_current_path}' 2>/dev/null || true)"
    target_real="$(cd -P "$target_path" 2>/dev/null && printf '%s\n' "$PWD" || printf '%s\n' "$target_path")"
    if [[ -z "$worktree" || "$target_real" == "$worktree_real" ]]; then
      tmux display-message -p -t "$target" '#{window_id}' 2>/dev/null || true
      return 0
    fi
  done

  canonical="${issue}-${slug}"
  target="$(tmux list-windows -t "$SESSION" -F '#{window_id}|#{window_name}' 2>/dev/null \
    | awk -F'|' -v name="$canonical" '$2 == name { print $1; exit }')"
  if [[ -n "$target" ]]; then
    target_path="$(tmux display-message -p -t "$target" '#{pane_current_path}' 2>/dev/null || true)"
    target_real="$(cd -P "$target_path" 2>/dev/null && printf '%s\n' "$PWD" || printf '%s\n' "$target_path")"
    if [[ -z "$worktree" || "$target_real" == "$worktree_real" ]]; then
      printf '%s\n' "$target"
      return 0
    fi
  fi

  if [[ -n "$worktree" ]]; then
    while IFS='|' read -r target _name; do
      [[ -n "$target" ]] || continue
      target_path="$(tmux display-message -p -t "$target" '#{pane_current_path}' 2>/dev/null || true)"
      target_real="$(cd -P "$target_path" 2>/dev/null && printf '%s\n' "$PWD" || printf '%s\n' "$target_path")"
      if [[ "$target_real" == "$worktree_real" ]]; then
        printf '%s\n' "$target"
        return 0
      fi
    done < <(tmux list-windows -t "$SESSION" -F '#{window_id}|#{window_name}' 2>/dev/null || true)
  fi
}

window_index() {
  local issue="$1" slug="$2" worktree="$3"
  local pane_state="" resource_disposition=""
  if [[ -n "$STATE_FILE" && -f "$STATE_FILE" ]]; then
    pane_state="$(jq -r --arg issue "$issue" '.tasks[$issue].paneState // empty' "$STATE_FILE" 2>/dev/null || true)"
    if declare -F get_task_resource_disposition >/dev/null 2>&1; then
      resource_disposition="$(get_task_resource_disposition "$issue" 2>/dev/null || true)"
    fi
  fi
  if [[ "$pane_state" == "released" || "$resource_disposition" == "released" || "$resource_disposition" == "reaped" ]]; then
    echo "—"
    return
  fi
  local target
  target="$(task_window_target "$issue" "$slug" "$worktree")"
  [[ -n "$target" ]] || { echo "—"; return; }
  tmux display-message -t "$target" -p '#{window_index}' 2>/dev/null || echo "—"
}

render_section_header() {
  local title="$1"
  local count="$2"
  printf "${EL}\n${B}%s${N} ${D}(%s)${N}${EL}\n" "$title" "$count" >> "$FRAME"
  printf "${D}%-10s  %4s  %-22s  %6s  %-12s  %-11s  %s${N}${EL}\n" \
    "ISSUE" "PANE" "TASK" "TIME" "PHASE" "AGENT" "PR" >> "$FRAME"
  printf "${D}%s${N}${EL}\n" \
    "────────────────────────────────────────────────────────────────────────────────" >> "$FRAME"
}

is_stale_planning_detail_for_phase() {
  local task_phase="$1" detail="$2"
  [[ "$task_phase" != "planning" && -n "$detail" ]] || return 1
  case "$detail" in
    planning_*|awaiting\ plan\ approval|Plan\ ready*|Native\ planning*) return 0 ;;
  esac
  return 1
}

# Render one task row and any optional follow-up detail line.
render_task_row() {
  local issue="$1" slug="$2" branch="$3" worktree="$4" win="$5"
  local task_status="$6" task_phase="$7" state_pr="$8" agent_state="$9"
  local t st_str pr_str pr_info checks phase_str plan_status ready_status ready_queue_state attention_detail planning_detail launch_failure_detail reported ds pane watchdog_classification watchdog_detail running_detail coding_blocked_detail coding_auto_detail
  local execution_owner pane_state resource_disposition workflow_outcome lifecycle_retention_reason queue_handoff_at queue_wait_age queue_gate queue_head

  t=$(elapsed "$worktree")
  reported=""
  execution_owner="task"
  pane_state="active"
  resource_disposition=""
  workflow_outcome=""
  lifecycle_retention_reason=""
  if [[ -n "$STATE_FILE" && -f "$STATE_FILE" ]]; then
    execution_owner="$(jq -r --arg issue "$issue" '.tasks[$issue].executionOwner // "task"' "$STATE_FILE" 2>/dev/null || echo "task")"
    pane_state="$(jq -r --arg issue "$issue" '.tasks[$issue].paneState // "active"' "$STATE_FILE" 2>/dev/null || echo "active")"
    workflow_outcome="$(jq -r --arg issue "$issue" '.tasks[$issue].lifecycle.workflowOutcome // empty' "$STATE_FILE" 2>/dev/null || true)"
    lifecycle_retention_reason="$(jq -r --arg issue "$issue" '.tasks[$issue].lifecycle.retention.reason // empty' "$STATE_FILE" 2>/dev/null || true)"
    if declare -F get_task_resource_disposition >/dev/null 2>&1; then
      resource_disposition="$(get_task_resource_disposition "$issue" 2>/dev/null || true)"
    else
      resource_disposition="$(jq -r --arg issue "$issue" '.tasks[$issue].lifecycle.resourceDisposition // empty' "$STATE_FILE" 2>/dev/null || true)"
    fi
  fi
  watchdog_classification=""
  watchdog_detail=""
  coding_blocked_detail=""
  coding_auto_detail=""
  launch_failure_detail=""
  [[ -n "$worktree" && -n "$slug" ]] && launch_failure_detail=$(native_launch_failure_detail "$worktree" "$slug")

  if [[ "$task_status" == "merged" ]]; then
    st_str="${G}✓ merged${N}"
  elif [[ "$resource_disposition" == "verification-required" ]]; then
    st_str="${R}verify${N}"
  elif [[ "$resource_disposition" == "retained" ]]; then
    st_str="${Y}retained${N}"
  elif [[ "$resource_disposition" == "reaping" ]]; then
    st_str="${Y}reaping${N}"
  elif [[ "$execution_owner" == "queue" && ( "$pane_state" == "released" || "$resource_disposition" == "released" ) ]]; then
    st_str="${G}queue-owned${N}"
  else
    # Prefer rich hook detail (tool names, errors) over legacy text files.
    reported=$(agent_hook_detail "$issue")
    [[ -z "$reported" ]] && reported=$(agent_reported_status "$issue")
    if is_stale_planning_detail_for_phase "$task_phase" "$reported"; then
      reported=""
    fi
    if is_stale_ready_gate_detail_for_phase "$task_phase" "$agent_state" "$reported"; then
      reported=""
    fi
    case "$agent_state:$reported" in
      waiting:*)         st_str="${Y}⏳ waiting${N}" ;;
      blocked:*)         st_str="${Y}⊘ blocked${N}" ;;
      approval-needed:*) st_str="${Y}⏳ approval${N}" ;;
      policy-denied:*)   st_str="${R}⛔ denied${N}" ;;
      error:*)           st_str="${R}! error${N}" ;;
      exited:*)          st_str="${D}○ exited${N}" ;;
      running:working)   st_str="${G}● working${N}" ;;
      running:waiting)   st_str="${Y}⏳ waiting${N}" ;;
      running:done)      st_str="${D}● idle${N}" ;;
      running:*)         st_str="${G}● running${N}" ;;
      *)                 st_str="${D}  done${N}" ;;
    esac
  fi

  # Only resolve PR cache entries for tasks already tracked with a PR.
  pr_str="${D}—${N}"
  pr_info=""
  if [[ -n "$state_pr" ]]; then
    pr_info=$(pr_for_branch "$branch")
  fi
  if [[ -n "$pr_info" ]]; then
    IFS='|' read -r pr_num pr_state <<<"$pr_info"
    case "$pr_state" in
      MERGED) pr_str="${G}#${pr_num} MERGED${N}" ;;
      CLOSED) pr_str="${R}#${pr_num} CLOSED${N}" ;;
      OPEN)
        if is_ready_conflicted "$worktree" "$slug"; then
          pr_str="${Y}#${pr_num} ⚠${N}"
        else
          checks=$(pr_checks "$branch")
          case "$checks" in
            pass)    pr_str="${G}#${pr_num} ✓${N}" ;;
            fail)    pr_str="${R}#${pr_num} ✗${N}" ;;
            pending) pr_str="${Y}#${pr_num} …${N}" ;;
            *)       pr_str="#${pr_num}" ;;
          esac
        fi
        ;;
    esac
  fi

  if [[ "$task_status" == "merged" ]]; then
    phase_str="${G}✓ done${N}"
  else
    case "$task_phase" in
    planning)
      plan_status=""
      [[ -n "$worktree" && -n "$slug" ]] && plan_status=$(get_planning_display_status "$worktree" "$slug")
      planning_detail=$(planning_rejection_detail "$worktree" "$slug")
      if [[ -n "$launch_failure_detail" ]]; then
        phase_str="${R}⚠ planning${N}"
      else
        case "$plan_status" in
          awaiting_approval)
            if [[ -n "$planning_detail" ]]; then
              phase_str="${R}⚠ planning${N}"
            else
              phase_str="${Y}⏳ awaiting${N}"
            fi
            ;;
          approved)          phase_str="${G}✅ approved${N}" ;;
          rejected)          phase_str="${R}❌ rejected${N}" ;;
          *)                 phase_str="${Y}📋 planning${N}" ;;
        esac
      fi
      ;;
    executing) phase_str="${G}🔨 executing${N}" ;;
    coding)
      coding_auto_detail=$(coding_auto_advance_detail "$worktree" "$slug" "$issue")
      coding_blocked_detail=$(coding_blocked_completion_detail "$worktree" "$slug" "$issue")
      coding_approval_status=""
      [[ -n "$worktree" && -n "$slug" ]] && coding_approval_status=$(get_coding_approval_status "$worktree" "$slug")
      if [[ -n "$launch_failure_detail" ]]; then
        phase_str="${R}⚠ coding${N}"
      elif [[ -n "$coding_auto_detail" ]]; then
        phase_str="${G}auto review${N}"
      elif [[ -n "$coding_blocked_detail" ]]; then
        phase_str="${R}⚠ coding${N}"
      elif [[ "$coding_approval_status" == "approval_needed" ]]; then
        phase_str="${Y}⏳ approval${N}"
      else
        phase_str="${G}💻 coding${N}"
      fi
      ;;
    review)
      if [[ -n "$launch_failure_detail" ]]; then
        phase_str="${R}⚠ review${N}"
      else
        phase_str="${Y}🔍 review${N}"
      fi
      ;;
    ready)
      watchdog_classification=$(ready_watchdog_field "$issue" "classification")
      watchdog_detail=$(ready_watchdog_field "$issue" "detail")
      ready_queue_state=$(get_ready_queue_state "$worktree" "$slug")
      if [[ "$execution_owner" == "queue" && ( "$pane_state" == "released" || "$resource_disposition" == "released" ) ]]; then
        phase_str="${G}queue-owned${N}"
      elif is_ready_conflicted "$worktree" "$slug"; then
        phase_str="${Y}⚠ ready${N}"
      else
        case "$watchdog_classification" in
          stuck|needs-user) phase_str="${R}🚦 ready${N}" ;;
          waiting-on-ci|waiting-on-eval-comparison) phase_str="${Y}🚦 ready${N}" ;;
          *)
            ready_status=$(get_ready_display_status "$worktree" "$slug")
            case "$ready_queue_state" in
              ready-stale) phase_str="${Y}ready-stale${N}" ;;
              merge-candidate) phase_str="${G}merge-candidate${N}" ;;
              *)
                case "$ready_status" in
                  failed|aborted) phase_str="${R}🚦 ready${N}" ;;
                  completed)      phase_str="${Y}🚦 ready${N}" ;;
                  *)              phase_str="${G}🚦 ready${N}" ;;
                esac
                ;;
            esac
            ;;
        esac
      fi
      ;;
    *)         phase_str="${D}$task_phase${N}" ;;
    esac
  fi

  ds="$slug"
  (( ${#ds} > 22 )) && ds="${ds:0:19}..."
  pane=$(window_index "$issue" "$slug" "$worktree")

  printf "%-10s  %4s  %-22s  %6s  %-12b  %-11b  %b${EL}\n" \
    "$issue" "$pane" "$ds" "$t" "$phase_str" "$st_str" "$pr_str" >> "$FRAME"

  attention_detail=$(ready_attention_detail "$worktree" "$slug" "$task_phase" "$agent_state")
  if [[ "$agent_state" != "running" && "$task_phase" == "ready" ]]; then
    if [[ -n "$attention_detail" ]]; then
      reported="$attention_detail"
    elif [[ -n "$watchdog_detail" ]]; then
      reported="$watchdog_detail"
    fi
  fi

  if [[ -n "$coding_auto_detail" ]]; then
    reported="$coding_auto_detail"
  elif [[ -n "$coding_blocked_detail" ]]; then
    reported="$coding_blocked_detail"
  elif [[ -n "$launch_failure_detail" ]]; then
    reported="$launch_failure_detail"
  fi
  planning_detail=$(planning_rejection_detail "$worktree" "$slug")
  if [[ -z "$reported" && -n "$planning_detail" ]]; then
    reported="$planning_detail"
  elif [[ -z "$reported" ]] && plan_waiting_for_review "$task_phase" "$agent_state" "$worktree" "$slug"; then
    reported="Plan ready — waiting for approval"
  fi
  if [[ -z "$reported" && -n "$attention_detail" ]]; then
    reported="$attention_detail"
  fi
  if [[ -z "$reported" && -n "$watchdog_detail" ]]; then
    reported="$watchdog_detail"
  fi
  if [[ -z "$reported" ]]; then
    running_detail=$(task_running_detail "$issue")
    [[ -n "$running_detail" ]] && reported="$running_detail"
  fi
  case "$reported" in
    working|waiting|done) reported="" ;;
  esac
  if [[ -n "$reported" ]]; then
    render_task_detail_lines "$reported"
  fi

  if [[ "$resource_disposition" == "verification-required" || "$resource_disposition" == "retained" ]]; then
    render_task_detail_lines "lifecycle: outcome=${workflow_outcome:-unknown} disposition=${resource_disposition}${lifecycle_retention_reason:+ reason=$lifecycle_retention_reason}"
  fi

  if [[ "$execution_owner" == "queue" && ( "$pane_state" == "released" || "$resource_disposition" == "released" ) ]]; then
    queue_handoff_at="$(jq -r --arg issue "$issue" '.tasks[$issue].queueHandoffAt // empty' "$STATE_FILE" 2>/dev/null || true)"
    queue_head="$(git -C "$worktree" rev-parse --short=7 HEAD 2>/dev/null || true)"
    queue_gate="$(get_ready_queue_state "$worktree" "$slug")"
    [[ -n "$queue_gate" ]] || queue_gate="waiting"
    queue_wait_age=""
    if [[ "$queue_handoff_at" =~ ^[0-9]+$ ]]; then
      local queue_wait_mins
      queue_wait_mins=$(( ($(date +%s) - queue_handoff_at) / 60 ))
      if (( queue_wait_mins < 60 )); then
        queue_wait_age="${queue_wait_mins}m"
      else
        queue_wait_age="$((queue_wait_mins / 60))h$((queue_wait_mins % 60))m"
      fi
    fi
    render_task_detail_lines "queue-owned PR #${state_pr:-?}${queue_head:+ · $queue_head}${queue_wait_age:+ · waiting $queue_wait_age} · gate: $queue_gate"
  fi

  # For actionable hook states, surface next_action as a follow-up detail line.
  case "$agent_state" in
    approval-needed|blocked|policy-denied)
      local next_action_detail
      next_action_detail="$(agent_hook_next_action "$issue")"
      if [[ -n "$next_action_detail" ]]; then
        render_task_detail_lines "$next_action_detail"
      fi
      ;;
  esac

  if [[ "$task_phase" == "planning" ]] && plan_waiting_for_review "$task_phase" "$agent_state" "$worktree" "$slug"; then
    render_task_detail_lines "$(render_plan_model_routing "$worktree" "$slug")"
  fi

  # Compact normalized artifact status (HOK-2261) — best-effort, read-only.
  if [[ -n "$worktree" && -n "$slug" ]]; then
    local _artifact_dir _artifact_seg
    _artifact_dir="$worktree/features/$slug"
    [[ -d "$_artifact_dir" ]] || _artifact_dir="$worktree/bugs/$slug"
    if [[ -d "$_artifact_dir" ]]; then
      _artifact_seg="$(render_artifact_status_segment "$_artifact_dir")"
      [[ -n "$_artifact_seg" ]] && render_task_detail_lines "artifacts: ${_artifact_seg}"
    fi
  fi
}

render_inbox_section() {
  local count="${#inbox_tasks[@]}"
  local task_data issue slug branch worktree task_status task_phase state_pr agent_state
  (( count == 0 )) && return

  render_section_header "📥 INBOX" "$count"
  for task_data in "${inbox_tasks[@]}"; do
    IFS='|' read -r issue slug branch worktree win task_status task_phase state_pr agent_state <<<"$task_data"
    render_task_row "$issue" "$slug" "$branch" "$worktree" "$win" "$task_status" "$task_phase" "$state_pr" "$agent_state"
  done
}

wavemill_incident_index_path() {
  printf '%s\n' "${WAVEMILL_INCIDENT_INDEX_OVERRIDE:-$WAVEMILL_REPO_DIR/.wavemill/incidents/index.json}"
}

format_incident_since() {
  local observed_at="$1"
  if [[ "$observed_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2} ]]; then
    printf '%s-%s\n' "${observed_at:5:2}" "${observed_at:8:2}"
    return 0
  fi
  printf '??-??\n'
}

incident_severity_color() {
  case "$1" in
    critical|high) printf '%s\n' "$R" ;;
    medium) printf '%s\n' "$Y" ;;
    low|info) printf '%s\n' "$D" ;;
    *) printf '%s\n' "$D" ;;
  esac
}

render_incidents_section() {
  local index incident_lines jq_status had_errexit=0 cap=5
  index="$(wavemill_incident_index_path)"
  [[ -r "$index" && -s "$index" ]] || return 0

  [[ $- == *e* ]] && had_errexit=1
  set +e
  incident_lines="$(jq -r --argjson cap "$cap" '
    def sev: {critical:0, high:1, medium:2, low:3, info:4}[.severity] // 9;
    def occ: if (.occurrenceCount | type) == "number" then .occurrenceCount else 0 end;

    (if type == "array" then . elif type == "object" then [.[]] else [] end)
    | [ .[] | select(.lifecycle == "active") ]
    | sort_by([sev, -occ]) as $active
    | ($active | length) as $total
    | if $total == 0 then
        empty
      else
        "__TOTAL__\t\($total)",
        ($active[:$cap][] | [
          (.fingerprint // ""),
          (.category // "unknown"),
          (.severity // "unknown"),
          (occ | tostring),
          (.summary // ""),
          (.firstObservedAt // .createdAt // "")
        ] | @tsv),
        (if $total > $cap then "__MORE__\t\($total - $cap)" else empty end)
      end
  ' "$index")"
  jq_status=$?
  if (( had_errexit == 1 )); then
    set -e
  fi
  (( jq_status == 0 )) || return 0
  [[ -n "$incident_lines" ]] || return 0

  local line fp category severity occ summary first total_count more_count
  local since severity_label severity_color short_fp rendered_count=0
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    IFS=$'\t' read -r fp category severity occ summary first <<<"$line"
    if [[ "$fp" == "__TOTAL__" ]]; then
      total_count="$category"
      printf "${EL}\n${B}%s${N} ${D}(%s)${N}${EL}\n" "🔥 INCIDENTS" "$total_count" >> "$FRAME"
      continue
    fi
    if [[ "$fp" == "__MORE__" ]]; then
      more_count="$category"
      printf "    ${D}…and %s more incidents${N}${EL}\n" "$more_count" >> "$FRAME"
      continue
    fi

    if (( rendered_count > 0 )); then
      printf "${EL}\n" >> "$FRAME"
    fi
    rendered_count=$((rendered_count + 1))
    severity_label="$category / $severity"
    severity_color="$(incident_severity_color "$severity")"
    since="$(format_incident_since "$first")"
    short_fp="${fp:0:8}"
    [[ -n "$short_fp" ]] || short_fp="????????"

    printf "%b🔥  %-30s%b  occ=%s  since %s${EL}\n" \
      "$severity_color" "$severity_label" "$N" "$occ" "$since" >> "$FRAME"
    printf "    %s${EL}\n" "$summary" >> "$FRAME"
    printf "    ${D}└─ fingerprint %s…  (wavemill observer --once --json to inspect)${N}${EL}\n" \
      "$short_fp" >> "$FRAME"
  done <<<"$incident_lines"
}

render_active_section() {
  local count="${#active_tasks[@]}"
  local task_data issue slug branch worktree task_status task_phase state_pr agent_state

  render_section_header "⚡ ACTIVE" "$count"
  if (( count == 0 )); then
    printf "${D}No active tasks${N}${EL}\n" >> "$FRAME"
    return
  fi

  for task_data in "${active_tasks[@]}"; do
    IFS='|' read -r issue slug branch worktree win task_status task_phase state_pr agent_state <<<"$task_data"
    render_task_row "$issue" "$slug" "$branch" "$worktree" "$win" "$task_status" "$task_phase" "$state_pr" "$agent_state"
  done
}

render_queued_section() {
  [[ -r "$STATE_FILE" && -s "$STATE_FILE" ]] || return 0
  local count
  count=$(jq '(.queued_tasks // []) | length' "$STATE_FILE" 2>/dev/null || echo 0)
  (( count == 0 )) && return 0

  printf "${EL}\n${B}%s${N} ${D}(%s)${N}${EL}\n" "⏸ PENDING DEPENDENCY" "$count" >> "$FRAME"
  printf "${D}%-10s  %-12s  %-8s  %s${N}${EL}\n" "ISSUE" "BLOCKER" "PR" "BASE" >> "$FRAME"
  printf "${D}%s${N}${EL}\n" "──────────────────────────────────────────────" >> "$FRAME"

  jq -r '
    (.queued_tasks // [])[] |
    [
      .issue_id,
      (.blocker_issue_id // "?"),
      (if .blocker_pr_number != null then "#\(.blocker_pr_number)" else "(no PR)" end),
      (.desired_base_branch // "?")
    ] | @tsv
  ' "$STATE_FILE" 2>/dev/null | while IFS=$'\t' read -r issue blocker pr base; do
    printf "%-10s  %-12s  %-8s  %s${EL}\n" "$issue" "$blocker" "$pr" "$base" >> "$FRAME"
  done
}

render_jobs_section() {
  [[ -r "$STATE_FILE" && -s "$STATE_FILE" ]] || return 0
  local jobs count=0 line
  jobs=$(gather_jobs)
  [[ -z "$jobs" ]] && return 0

  printf "${EL}\n${B}%s${N}${EL}\n" "🛠 JOBS" >> "$FRAME"
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    count=$((count + 1))
  done <<<"$jobs"
  printf "${D}Tracked background jobs (${count})${N}${EL}\n" >> "$FRAME"

  while IFS='|' read -r job_id kind job_status issue side pair_id prs started_at log_path excerpt; do
    local label elapsed status_str target detail
    elapsed=$(format_job_elapsed "$started_at")
    label="$kind"
    target="$issue"
    [[ "$kind" == "eval" && "$side" != "-" ]] && target="${issue}:${side}"
    [[ "$kind" == "comparison" ]] && target="${pair_id}:${prs}"

    case "$job_status" in
      running) status_str="${G}running${N}" ;;
      succeeded) status_str="${G}succeeded${N}" ;;
      timeout) status_str="${Y}timeout${N}" ;;
      *) status_str="${R}${job_status}${N}" ;;
    esac

    label="$(truncate_cell "$label" 8)"
    target="$(truncate_cell "$target" 12)"
    elapsed="$(truncate_cell "$elapsed" 5)"
    printf "%-8s %-12s %5s %b${EL}\n" "$label" "$target" "$elapsed" "$status_str" >> "$FRAME"
    if [[ "$job_status" == "failed" || "$job_status" == "timeout" ]]; then
      detail="$excerpt"
      [[ -z "$detail" ]] && detail="$log_path"
      detail=$(truncate_detail "$detail")
      printf "${D}%8s %12s %5s └─ %s${N}${EL}\n" "" "" "" "$detail" >> "$FRAME"
    fi
  done <<<"$jobs"
}

render_monitor_command_queue_section() {
  [[ -r "$STATE_FILE" && -s "$STATE_FILE" ]] || return 0
  local count
  count=$(jq '(.monitorDeferredCommands // []) | length' "$STATE_FILE" 2>/dev/null || echo 0)
  (( count == 0 )) && return 0

  printf "${EL}\n${B}%s${N} ${D}(%s)${N}${EL}\n" "⌛ QUEUED COMMANDS" "$count" >> "$FRAME"
  printf "${D}%-18s  %-28s  %s${N}${EL}\n" "COMMAND" "REASON" "QUEUED" >> "$FRAME"
  printf "${D}%s${N}${EL}\n" "────────────────────────────────────────────────────────────────────────" >> "$FRAME"

  jq -r '
    (.monitorDeferredCommands // [])[] |
    [
      (.event // "?"),
      ((.reason // "?") | gsub("_"; " ")),
      (.queued_at // "?")
    ] | @tsv
  ' "$STATE_FILE" 2>/dev/null | while IFS=$'\t' read -r event reason queued_at; do
    printf "%-18s  %-28s  %s${EL}\n" "$event" "$reason" "$queued_at" >> "$FRAME"
  done
}

render_project_context_suggestion() {
  [[ -r "$STATE_FILE" && -s "$STATE_FILE" ]] || return 0
  local size_kb threshold_kb

  if ! jq -e '.project_context_suggestion != null' "$STATE_FILE" >/dev/null 2>&1; then
    return 0
  fi

  size_kb=$(jq -r '(.project_context_suggestion.sizeBytes / 1024) | floor' "$STATE_FILE" 2>/dev/null) || return 0
  threshold_kb=$(jq -r '(.project_context_suggestion.thresholdBytes / 1024) | floor' "$STATE_FILE" 2>/dev/null) || return 0

  printf "${EL}\n${Y}⚠ project-context.md is %sKB (>%sKB) - run 'wavemill context compact' to compact${N}${EL}\n" \
    "$size_kb" "$threshold_kb" >> "$FRAME"
}

# Clear saved scrollback lines without blanking the visible pane. This keeps
# tmux history from accumulating stale dashboards while avoiding a full-screen
# flash on every refresh.
clear_dashboard_scrollback() {
  tput E3 2>/dev/null || printf '\033[3J'
}

# Redraw the dashboard from the top-left corner in one grouped write so tmux
# sees a single refresh operation rather than separate cursor, content, and
# clear steps.
redraw_dashboard_frame() {
  local frame_file="$1"
  {
    tput cup 0 0 2>/dev/null || printf '\033[H'
    cat "$frame_file"
    tput ed 2>/dev/null || printf '\033[J'
  }
}

cached_openrouter_warning() {
  [[ -r "$OPENROUTER_WARNING_CACHE" ]] || return 1
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    printf '%s\n' "$line"
    return 0
  done < "$OPENROUTER_WARNING_CACHE"
  return 1
}

# Render a warning for challenge-pair task entries that carry no slug.
#
# HOK-2926: when a primary's ledger write is rejected (empty challengeRole,
# see the fail-closed guard in save_task_state), the follow-up
# `.tasks[$issue].challengerLaunched = true` mutation still creates a bare
# object holding only challenge metadata — challengePairId, challengeStage,
# challengeExecutionIntent — with no slug/branch/worktree. gather_tasks filters
# on a non-empty slug, so such an arm never renders even though its tmux window
# and agent keep running and its plan gate is waiting on an operator. Surface
# the stub as a dashboard warning so the failure can never be silent.
#
# Diagnostic only: this never mutates state and never infers the missing
# fields. Non-challenge entries without a slug are deliberately ignored so the
# existing slug filter keeps its current fallback semantics for them.
# Returns 0 and prints one warning line if any stub exists, 1 otherwise.
malformed_challenge_state_warning() {
  local state_file="${1:-}" summary count keys
  [[ -n "$state_file" && -r "$state_file" ]] || return 1
  summary="$(jq -r '
    [ (.tasks // {}) | to_entries[]
      | select((.value | type) == "object")
      | select(.key != ""
               and ((.value.challengePairId // "") != "")
               and ((.value.slug // "") == ""))
      | .key ]
    | "\(length)|\(join(", "))"' "$state_file" 2>/dev/null || echo "")"
  [[ -n "$summary" ]] || return 1
  count="${summary%%|*}"
  keys="${summary#*|}"
  [[ "$count" =~ ^[0-9]+$ ]] || return 1
  (( count > 0 )) || return 1
  if (( count == 1 )); then
    printf 'challenge pair entry %s has no slug: arm is hidden but may still be running; repair state (HOK-2926)' "$keys"
  else
    printf '%d challenge pair entries have no slug (%s): arms are hidden but may still be running; repair state (HOK-2926)' "$count" "$keys"
  fi
  return 0
}

# Render queue-health degradation warning if active.
# Returns 0 and prints warning if degraded, 1 if healthy/missing.
queue_health_dashboard_warning() {
  local state_file="${1:-}" state_dir reason backoff_secs next_action
  [[ -n "$state_file" ]] || return 1
  state_dir="$(dirname "$state_file" 2>/dev/null || echo '')"
  [[ -n "$state_dir" ]] || return 1

  local health_file="${state_dir}/queue-health.json"
  [[ -r "$health_file" ]] || return 1

  local status="$(jq -r '.status // "healthy"' "$health_file" 2>/dev/null || echo 'healthy')"
  [[ "$status" == "healthy" ]] && return 1

  reason="$(jq -r '.degradationReason // "unknown"' "$health_file" 2>/dev/null || echo 'unknown')"
  backoff_secs="$(jq -r '.retryBackoffSeconds // 0' "$health_file" 2>/dev/null || echo '0')"
  next_action="$(jq -r '.nextAction // "retry"' "$health_file" 2>/dev/null || echo 'retry')"

  if [[ "$backoff_secs" -gt 0 ]]; then
    printf 'queue planning degraded: %s; flat fallback active; retry in %ds' "$reason" "$backoff_secs"
  else
    printf 'queue planning degraded: %s; %s' "$reason" "$next_action"
  fi
  return 0
}

format_backstage_service_status() {
  local status="${1:-unknown}"
  case "$status" in
    healthy) printf '%b' "${G}healthy${N}" ;;
    disabled) printf '%b' "${D}disabled${N}" ;;
    needs-user) printf '%b' "${R}needs-user${N}" ;;
    stalled) printf '%b' "${R}${status}${N}" ;;
    alive-not-progressing) printf '%b' "${Y}${status}${N}" ;;
    missing-*|stale-*|backstage-missing) printf '%b' "${Y}${status}${N}" ;;
    *) printf '%b' "${D}${status}${N}" ;;
  esac
}

# Progress-vs-liveness (HOK-2919): a service that reports progressState
# "stalled" is alive (its heartbeat is current) but not moving state. Rewrites
# a would-be "healthy" status so the header distinguishes the two; services
# without progress fields render unchanged. Echoes the effective status.
backstage_effective_service_status() {
  local health_file="$1" service="$2" status="${3:-unknown}"
  local progress_state
  progress_state="$(jq -r --arg service "$service" '.services[$service].progressState // empty' "$health_file" 2>/dev/null || true)"
  if [[ "$progress_state" == "stalled" && "$status" == "healthy" ]]; then
    printf 'alive-not-progressing'
  else
    printf '%s' "$status"
  fi
}

# Age suffix for the last real progress event of a service, shown alongside
# the heartbeat age when the service is alive but not progressing. Returns 1
# (prints nothing) when the service has no progress fields.
format_backstage_progress_age() {
  local health_file="$1" service="$2"
  local progress_state last_progress_at progress_age
  progress_state="$(jq -r --arg service "$service" '.services[$service].progressState // empty' "$health_file" 2>/dev/null || true)"
  [[ "$progress_state" == "stalled" ]] || return 1
  last_progress_at="$(jq -r --arg service "$service" '.services[$service].lastProgressAt // empty' "$health_file" 2>/dev/null || true)"
  if progress_age="$(format_backstage_heartbeat_age "$last_progress_at" 2>/dev/null)"; then
    printf 'progress %s' "$progress_age"
    return 0
  fi
  return 1
}

format_backstage_heartbeat_age() {
  local heartbeat_at="${1:-}" now_ts heartbeat_epoch heartbeat_age
  [[ -n "$heartbeat_at" ]] || return 1
  now_ts="$(date +%s)"
  heartbeat_epoch="$(wavemill_iso8601_to_epoch "$heartbeat_at" 2>/dev/null || echo 0)"
  if [[ "$heartbeat_epoch" =~ ^[0-9]+$ && "$heartbeat_epoch" -gt 0 ]]; then
    heartbeat_age=$(( now_ts - heartbeat_epoch ))
    printf '%ss ago' "$heartbeat_age"
    return 0
  fi
  return 1
}

queue_health_dashboard_status() {
  local state_file="${1:-}" state_dir health_file status reason
  [[ -n "$state_file" ]] || return 1
  state_dir="$(dirname "$state_file" 2>/dev/null || echo '')"
  [[ -n "$state_dir" ]] || return 1
  health_file="${state_dir}/queue-health.json"
  [[ -r "$health_file" ]] || return 1

  status="$(jq -r '.status // "healthy"' "$health_file" 2>/dev/null || echo 'healthy')"
  [[ -n "$status" ]] || status="healthy"
  printf 'Queue: %b' "$(format_backstage_service_status "$status")"
  if [[ "$status" != "healthy" ]]; then
    reason="$(jq -r '.degradationReason // .failureStep // empty' "$health_file" 2>/dev/null || true)"
    [[ -n "$reason" ]] && printf ' (%s)' "$reason"
  fi
  return 0
}

backstage_health_dashboard_line() {
  local state_file="${1:-}" state_dir health_file tend_status observer_status observer_instance_count heartbeat_at heartbeat_age queue_status_line tend_failure_count progress_age
  [[ -n "$state_file" ]] || return 1
  state_dir="$(dirname "$state_file" 2>/dev/null || echo '')"
  [[ -n "$state_dir" ]] || return 1
  health_file="${state_dir}/backstage-health.json"
  [[ -r "$health_file" ]] || return 1

  tend_status="$(jq -r '.services.tend.status // .status // empty' "$health_file" 2>/dev/null || true)"
  observer_status="$(jq -r '.services.observer.status // empty' "$health_file" 2>/dev/null || true)"
  [[ -n "$tend_status$observer_status" ]] || return 1

  tend_status="$(backstage_effective_service_status "$health_file" 'tend' "${tend_status:-unknown}")"
  printf 'Tend: %b' "$(format_backstage_service_status "$tend_status")"
  heartbeat_at="$(jq -r '.services.tend.heartbeatAt // empty' "$health_file" 2>/dev/null || true)"
  if heartbeat_age="$(format_backstage_heartbeat_age "$heartbeat_at" 2>/dev/null)"; then
    if progress_age="$(format_backstage_progress_age "$health_file" 'tend' 2>/dev/null)"; then
      printf ' (tick %s, %s)' "$heartbeat_age" "$progress_age"
    else
      printf ' (%s)' "$heartbeat_age"
    fi
  fi
  tend_failure_count="$(jq -r '.services.tend.failureCount // 0' "$health_file" 2>/dev/null || echo 0)"
  if [[ "$tend_failure_count" =~ ^[0-9]+$ ]] && (( tend_failure_count > 0 )); then
    printf ' retrying:%s' "$tend_failure_count"
  fi
  if [[ -n "$observer_status" ]]; then
    observer_status="$(backstage_effective_service_status "$health_file" 'observer' "$observer_status")"
    printf ' │ Observer: %b' "$(format_backstage_service_status "$observer_status")"
    observer_instance_count="$(jq -r '.services.observer.instanceCount // empty' "$health_file" 2>/dev/null || true)"
    if [[ "$observer_instance_count" =~ ^[0-9]+$ ]] && (( observer_instance_count > 1 )); then
      printf ' x%s' "$observer_instance_count"
    fi
    heartbeat_at="$(jq -r '.services.observer.heartbeatAt // empty' "$health_file" 2>/dev/null || true)"
    if heartbeat_age="$(format_backstage_heartbeat_age "$heartbeat_at" 2>/dev/null)"; then
      if progress_age="$(format_backstage_progress_age "$health_file" 'observer' 2>/dev/null)"; then
        printf ' (tick %s, %s)' "$heartbeat_age" "$progress_age"
      else
        printf ' (%s)' "$heartbeat_age"
      fi
    fi
  else
    printf ' │ Observer: %b' "$(format_backstage_service_status "disabled")"
  fi
  if queue_status_line="$(queue_health_dashboard_status "$state_file" 2>/dev/null)"; then
    printf ' │ %s' "$queue_status_line"
  fi
  printf '\n'
  return 0
}

render_dashboard() {
  local tasks line issue slug branch worktree task_status task_phase state_pr
  local win agent_state classification task_data free_slots queue_owned_tasks usage_tip openrouter_warning backstage_health_line malformed_challenge_warning resource_disposition
  declare -ga inbox_tasks=()
  declare -ga active_tasks=()

  # Build entire frame into a temp file (avoids $() stripping newlines)
  : > "$FRAME"
  printf "${B}Wavemill Dashboard${N}  ${D}%s${N}${EL}\n" "$(date '+%H:%M:%S')" >> "$FRAME"
  free_slots=""
  queue_owned_tasks=""
  if [[ -r "$STATE_FILE" && -s "$STATE_FILE" ]]; then
    free_slots=$(jq -r '.freeSlots // empty' "$STATE_FILE" 2>/dev/null || echo "")
    queue_owned_tasks=$(jq -r '.queueOwnedTasks // empty' "$STATE_FILE" 2>/dev/null || echo "")
  fi
  if [[ -n "$free_slots" ]]; then
    printf "${D}├─ %b${N}${EL}\n" "${G}${free_slots} slot(s) available${N}" >> "$FRAME"
  fi
  if [[ "$queue_owned_tasks" =~ ^[0-9]+$ ]] && (( queue_owned_tasks > 0 )); then
    printf "${D}├─ %b${N}${EL}\n" "${G}${queue_owned_tasks} queue-owned task(s) pane-released${N}" >> "$FRAME"
  fi
  if openrouter_warning="$(cached_openrouter_warning)"; then
    printf "${D}├─ WARN: %s${N}${EL}\n" "$openrouter_warning" >> "$FRAME"
  fi
  if queue_health_warning="$(queue_health_dashboard_warning "$STATE_FILE" 2>/dev/null)"; then
    printf "${D}├─ WARN: %s${N}${EL}\n" "$queue_health_warning" >> "$FRAME"
  fi
  # HOK-2926: a challenge arm whose state entry lost its slug is filtered out
  # of gather_tasks below; warn here so it is never silently unrenderable.
  if malformed_challenge_warning="$(malformed_challenge_state_warning "$STATE_FILE" 2>/dev/null)"; then
    printf "${D}├─ WARN: %s${N}${EL}\n" "$malformed_challenge_warning" >> "$FRAME"
  fi
  if backstage_health_line="$(backstage_health_dashboard_line "$STATE_FILE" 2>/dev/null)"; then
    printf "${D}├─ %b${N}${EL}\n" "$backstage_health_line" >> "$FRAME"
  fi

  tasks=$(gather_tasks)
  if [[ -z "$tasks" ]]; then
    printf "${D}No active tasks${N}${EL}\n" >> "$FRAME"
  else
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      IFS='|' read -r issue slug branch worktree task_status task_phase state_pr <<<"$line"
      task_phase="${task_phase:-executing}"

      win="${issue}-${slug}"
      [[ "$issue" == "—" ]] && win="$slug"

      is_active "$worktree" "$win" || continue

      agent_state=""
      resource_disposition=""
      if declare -F get_task_resource_disposition >/dev/null 2>&1; then
        resource_disposition="$(get_task_resource_disposition "$issue" 2>/dev/null || true)"
      fi
      if [[ "$task_status" == "merged" ]]; then
        agent_state="exited"
      elif [[ "$(jq -r --arg issue "$issue" '.tasks[$issue].executionOwner // "task"' "$STATE_FILE" 2>/dev/null || echo "task")" == "queue" \
        && ( "$(jq -r --arg issue "$issue" '.tasks[$issue].paneState // "active"' "$STATE_FILE" 2>/dev/null || echo "active")" == "released" || "$resource_disposition" == "released" ) ]]; then
        agent_state="queue-owned"
      else
        agent_state=$(agent_status "$issue" "$(task_window_target "$issue" "$slug" "$worktree")")
      fi

      if [[ "$agent_state" == "queue-owned" ]]; then
        classification="active"
      else
        classification=$(is_actionable_state "$agent_state" "$task_phase" "$worktree" "$slug" "$issue")
      fi
      task_data="$issue|$slug|$branch|$worktree|$win|$task_status|$task_phase|$state_pr|$agent_state"

      if [[ "$classification" == "actionable" ]]; then
        inbox_tasks+=("$task_data")
      else
        active_tasks+=("$task_data")
      fi
    done <<<"$tasks"

  fi

  if declare -f render_incidents_section >/dev/null 2>&1; then
    render_incidents_section
  fi
  render_inbox_section
  render_active_section
  render_project_context_suggestion

  local now_ts
  now_ts="$(date +%s)"
  if (( _LAST_TIP_REFRESH_AT == 0 || now_ts - _LAST_TIP_REFRESH_AT >= TIP_REFRESH )); then
    _CURRENT_TIP="$(wavemill_pick_usage_tip)"
    _LAST_TIP_REFRESH_AT="$now_ts"
  fi
  usage_tip="$_CURRENT_TIP"
  printf "${EL}\n${D}Refreshes every ${REFRESH}s │ %s${N}${EL}\n" "$usage_tip" >> "$FRAME"
}

run_dashboard() {
  # Disable errexit inside the render loop. USR1 signals (from hook writes)
  # can interrupt any command mid-execution; under set -e the interrupted
  # command's non-zero exit kills the entire script. The render helpers
  # already guard failures with "|| true" / "2>/dev/null" so errexit adds
  # no safety here — only fragility.
  set +e
  local last_window_metadata_refresh=0 now_ts
  while true; do
    # Block USR1 during rendering to prevent partial frame output.
    # Signals received during this window set WAVEMILL_REDRAW via the trap
    # but are deferred until the interruptible wait below.
    trap '' USR1

    # Keep tmux scrollback clean without blanking the visible pane.
    clear_dashboard_scrollback
    refresh_pr_cache
    now_ts="$(date +%s)"
    if (( now_ts - last_window_metadata_refresh >= 10 )); then
      refresh_window_metadata_for_active_tasks
      last_window_metadata_refresh="$now_ts"
    fi
    render_dashboard
    redraw_dashboard_frame "$FRAME"

    # Re-enable USR1 for the interruptible wait. Any signal received while
    # blocked above will have been queued and will fire the trap now.
    trap 'WAVEMILL_REDRAW=1' USR1
    WAVEMILL_REDRAW=0
    sleep "$REFRESH" &
    SLEEP_PID=$!
    wait "$SLEEP_PID" 2>/dev/null || true
  done
}

render_jobs_pane() {
  : > "$FRAME"
  printf "${B}Wavemill Jobs${N}  ${D}%s${N}${EL}\n" "$(date '+%H:%M:%S')" >> "$FRAME"
  render_jobs_section
  printf "${EL}\n${D}Refreshes every ${REFRESH}s${N}${EL}\n" >> "$FRAME"
}

render_queued_pending_pane() {
  : > "$FRAME"
  printf "${B}Wavemill Pending + Queue${N}  ${D}%s${N}${EL}\n" "$(date '+%H:%M:%S')" >> "$FRAME"
  render_queued_section
  render_monitor_command_queue_section
  printf "${EL}\n${D}Refreshes every ${REFRESH}s${N}${EL}\n" >> "$FRAME"
}

run_pane_loop() {
  local render_fn="$1"
  set +e
  while true; do
    trap '' USR1
    clear_dashboard_scrollback
    "$render_fn"
    redraw_dashboard_frame "$FRAME"
    trap 'WAVEMILL_REDRAW=1' USR1
    WAVEMILL_REDRAW=0
    sleep "$REFRESH" &
    SLEEP_PID=$!
    wait "$SLEEP_PID" 2>/dev/null || true
  done
}

# ── Main render loop ─────────────────────────────────────────────────────

FRAME=$(mktemp)
trap 'tput cnorm 2>/dev/null || true; rm -f "$FRAME"' EXIT INT TERM

if [[ "${BASH_SOURCE[0]:-}" == "$0" ]]; then
  case "$PANE_MODE" in
    jobs) run_pane_loop render_jobs_pane ;;
    queued-pending) run_pane_loop render_queued_pending_pane ;;
    *) run_dashboard ;;
  esac
fi
