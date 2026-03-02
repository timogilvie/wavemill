#!/opt/homebrew/bin/bash
set -euo pipefail

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

# Source common library and load layered config
# Resolution: env vars > .wavemill-config.json > ~/.wavemill/config.json > defaults
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/wavemill-common.sh"
source "$SCRIPT_DIR/agent-adapters.sh"
load_config "$REPO_DIR"

# Derived variables (not in config files)
DRY_RUN="${DRY_RUN:-false}"
STATE_DIR="${STATE_DIR:-$REPO_DIR/.wavemill}"
STATE_FILE="$STATE_DIR/workflow-state.json"


command -v jq >/dev/null || { echo "Error: jq required (install: brew install jq)"; exit 1; }
command -v gh >/dev/null || { echo "Error: gh required (install: brew install gh && gh auth login)"; exit 1; }
command -v npx >/dev/null || { echo "Error: npx required (install: brew install node)"; exit 1; }
command -v tmux >/dev/null || { echo "Error: tmux required (install: brew install tmux)"; exit 1; }
agent_validate "$AGENT_CMD" || { echo "Error: agent '$AGENT_CMD' not found"; exit 1; }

# Check agent authentication before launching tasks
if ! agent_check_auth "$AGENT_CMD"; then
  exit 1
fi


# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================


# Logging with timestamps
log() { echo "$(date '+%H:%M:%S') $*"; }
log_error() { echo "$(date '+%H:%M:%S') ERROR: $*" >&2; }
log_warn() { echo "$(date '+%H:%M:%S') WARN: $*" >&2; }


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


# Run a command with a hard wall-clock timeout (works on macOS without coreutils).
# Usage: _with_timeout <seconds> <command> [args...]
_with_timeout() {
  local secs=$1
  shift

  # Prefer system timeout / gtimeout if available
  if command -v timeout &>/dev/null; then
    timeout "$secs" "$@"
    return $?
  fi
  if command -v gtimeout &>/dev/null; then
    gtimeout "$secs" "$@"
    return $?
  fi

  # Fallback: background process + watchdog (stdout/stderr flow through)
  "$@" &
  local pid=$!
  # Redirect watchdog stdout/stderr to /dev/null so it doesn't hold the
  # file descriptor open inside $() command substitutions.  Without this,
  # $() blocks until sleep completes even after the real command exits.
  ( sleep "$secs" && kill "$pid" 2>/dev/null && log_warn "Command killed after ${secs}s timeout" ) >/dev/null 2>&1 &
  local wd=$!
  wait "$pid" 2>/dev/null
  local rc=$?
  kill "$wd" 2>/dev/null; wait "$wd" 2>/dev/null
  return "$rc"
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
}


save_task_state() {
  local issue="$1" slug="$2" branch="$3" worktree="$4" pr="${5:-}" status="${6:-}" agent="${7:-}"
  local tmp
  tmp=$(mktemp) || { log_warn "save_task_state: mktemp failed"; return 0; }
  if jq --arg issue "$issue" --arg slug "$slug" --arg branch "$branch" \
     --arg worktree "$worktree" --arg pr "$pr" --arg status "$status" --arg agent "$agent" \
     '.tasks[$issue] = (.tasks[$issue] // {}) + {slug: $slug, branch: $branch, worktree: $worktree, pr: $pr, status: $status, updated: (now | todate)} | if $agent != "" then .tasks[$issue].agent = $agent else . end' \
     "$STATE_FILE" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$STATE_FILE"
  else
    rm -f "$tmp"
    log_warn "save_task_state: failed to update $issue"
  fi
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
  local tmp
  tmp=$(mktemp) || return 0
  if jq --arg issue "$issue" --argjson num "$num" \
     '.migrationReservations[$issue] = $num | .nextMigrationNum = ($num + 1)' \
     "$STATE_FILE" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$STATE_FILE"
  else
    rm -f "$tmp"
  fi
}

save_next_migration_num() {
  local num="$1"
  local tmp
  tmp=$(mktemp) || return 0
  if jq --argjson num "$num" '.nextMigrationNum = $num' \
     "$STATE_FILE" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$STATE_FILE"
  else
    rm -f "$tmp"
  fi
}


remove_task_state() {
  local issue="$1"
  local tmp
  tmp=$(mktemp) || { log_warn "remove_task_state: mktemp failed"; return 0; }
  if jq --arg issue "$issue" 'del(.tasks[$issue])' "$STATE_FILE" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$STATE_FILE"
  else
    rm -f "$tmp"
    log_warn "remove_task_state: failed to remove $issue"
  fi
}


set_task_phase() {
  local issue="$1" phase="$2"
  local tmp
  tmp=$(mktemp) || { log_warn "set_task_phase: mktemp failed"; return 0; }
  if jq --arg issue "$issue" --arg phase "$phase" \
     '.tasks[$issue].phase = $phase | .tasks[$issue].updated = (now | todate)' \
     "$STATE_FILE" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$STATE_FILE"
  else
    rm -f "$tmp"
    log_warn "set_task_phase: failed to update $issue"
  fi
}


get_task_phase() {
  local issue="$1"
  jq -r --arg issue "$issue" '.tasks[$issue].phase // "executing"' "$STATE_FILE" 2>/dev/null
}


check_plan_approved() {
  local slug="$1"
  local wt="${WORKTREE_ROOT}/${slug}"
  [[ -f "$wt/features/$slug/.plan-approved" ]] && return 0
  return 1
}


check_plan_exists() {
  local slug="$1"
  local wt="${WORKTREE_ROOT}/${slug}"
  [[ -f "$wt/features/$slug/plan.md" ]] && return 0
  return 1
}


# Clean up completed task: close window, remove worktree/branch, update state
# Args: issue_id, slug, completion_reason (optional, for logging)
cleanup_completed_task() {
  local issue="$1"
  local slug="$2"
  local completion_reason="${3:-}"

  # Kill tmux window (unconditional - no race condition)
  local win="$issue-$slug"
  execute tmux kill-window -t "$SESSION:$win" 2>/dev/null || true
  log "  ✓ Closed window: $win"

  # Remove worktree
  local wt_dir="${WORKTREE_ROOT}/${slug}"
  if [[ -d "$wt_dir" ]]; then
    execute git -C "$REPO_DIR" worktree remove "$wt_dir" --force 2>/dev/null || true
    log "  ✓ Removed worktree: $wt_dir"
  fi

  # Delete branch
  local task_branch="task/${slug}"
  if git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$task_branch" 2>/dev/null; then
    execute git -C "$REPO_DIR" branch -D "$task_branch" 2>/dev/null || true
    log "  ✓ Deleted branch: $task_branch"
  fi

  # Clean up state
  execute git -C "$REPO_DIR" worktree prune 2>/dev/null || true
  remove_task_state "$issue"
  CLEANED["$issue"]=1

  # Log completion with optional reason
  if [[ -n "$completion_reason" ]]; then
    log "  ✓ Complete: $issue ($completion_reason)"
  else
    log "  ✓ Complete: $issue"
  fi
}


# ============================================================================
# LINEAR API WITH RETRY
# ============================================================================


linear_list_backlog() {
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
  # Capture stdout (JSON); collect stderr so we can show it on failure
  local stderr_file
  stderr_file=$(mktemp)
  if retry npx tsx "$TOOLS_DIR/get-issue-json.ts" "$1" 2>"$stderr_file"; then
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


linear_set_state() {
  local issue="$1" state="$2"
  [[ "$DRY_RUN" == "true" ]] && { log "[DRY-RUN] Would set $issue → $state"; return 0; }
  retry npx tsx "$TOOLS_DIR/set-issue-state.ts" "$issue" "$state" >/dev/null 2>&1 || log_warn "Failed to set $issue → $state in Linear"
}


linear_is_completed() {
  local issue="$1"
  local state
  state=$(_with_timeout "$RETRY_TIMEOUT" npx tsx "$TOOLS_DIR/get-issue-state.ts" "$issue" 2>/dev/null || echo "active")
  [[ "$state" == "completed" ]] && return 0
  return 1
}


# Note: is_task_packet() and write_task_packet() now provided by wavemill-common.sh


# Conflict-aware task selection with multi-factor priority scoring
# Fetches up to 30 candidates so we have enough unblocked items after filtering
# Output: identifier|slug|title|area|score|blocked_by_count
pick_candidates() {
  local backlog_json="$1"
  local show_limit=30

  # Use shared scoring function; strip has_detailed_plan (field 6), keep blocked_by_count (field 7→6)
  score_and_rank_issues "$backlog_json" "$show_limit" | awk -F'|' -v OFS='|' '{print $1,$2,$3,$4,$5,$7}'
}


# Smart selection that avoids area conflicts
smart_select_from_candidates() {
  local candidates="$1"
  local selected_numbers="$2"


  if [[ -z "$selected_numbers" ]]; then
    # Auto-select up to MAX_PARALLEL with conflict avoidance
    local -A area_used=()
    local -a result=()
    local count=0


    while IFS= read -r line && [[ $count -lt $MAX_PARALLEL ]]; do
      IFS='|' read -r issue slug title area score blocked_by <<<"$line"


      # Check area conflict - skip if area already in use
      if [[ -n "$area" ]] && [[ -n "${area_used[$area]:-}" ]]; then
        continue
      fi


      # Accept this task
      result+=("$issue|$slug|$title")
      [[ -n "$area" ]] && area_used["$area"]=1
      ((count++))
    done <<<"$candidates"


    printf '%s\n' "${result[@]}"
  else
    # User selected specific numbers - extract first 3 fields only
    while read -r n; do
      echo "$candidates" | sed -n "${n}p" | cut -d'|' -f1-3
    done <<<"$(echo "$selected_numbers" | tr ' ' '\n')"
  fi
}


# ============================================================================
# GITHUB API WITH RETRY AND VALIDATION
# ============================================================================


find_pr_for_branch() {
  local branch="$1"
  gh pr list --head "$branch" --state all --json number --jq '.[0].number // empty' 2>/dev/null || true
}


pr_state() {
  local pr="$1"
  gh pr view "$pr" --json state --jq .state 2>/dev/null || echo ""
}


# Get PR details with base branch validation
pr_details() {
  local pr="$1"
  gh pr view "$pr" --json state,baseRefName,statusCheckRollup 2>/dev/null || echo ""
}


# Check if PR is merged and ready for cleanup
# Returns 0 if merged, 1 if not
# Note: Once PR is merged, CI status is irrelevant for cleanup decisions
validate_pr_merge() {
  local pr="$1"
  local details


  details="$(pr_details "$pr" 2>/dev/null || echo "")"


  if [[ -z "$details" ]]; then
    log_error "Failed to fetch PR #$pr details"
    return 1
  fi


  local state base_branch
  state=$(echo "$details" | jq -r '.state' 2>/dev/null) || return 1
  base_branch=$(echo "$details" | jq -r '.baseRefName' 2>/dev/null) || return 1


  # Check 1: Must be MERGED (not CLOSED)
  if [[ "$state" != "MERGED" ]]; then
    log_warn "PR #$pr state is $state (not MERGED)"
    return 1
  fi


  # Check 2: Must be merged to correct base branch
  if [[ "$base_branch" != "$BASE_BRANCH" ]]; then
    log_error "PR #$pr merged to wrong base: $base_branch (expected: $BASE_BRANCH)"
    return 1
  fi


  # Once PR is merged, proceed with cleanup regardless of CI status.
  # The merge has already happened; CI validation is for pre-merge safety.
  return 0
}


# ============================================================================
# MAIN WORKFLOW
# ============================================================================


# Trap handler for cleanup on exit/interrupt
ISSUES_IN_PROGRESS=()
cleanup_on_exit() {
  local exit_code=$?
  if [[ ${#ISSUES_IN_PROGRESS[@]} -gt 0 ]]; then
    log_warn "Interrupted - resetting Linear state for unfinished tasks..."
    log_warn "Worktrees and branches preserved for resumption on next run."
    for issue in "${ISSUES_IN_PROGRESS[@]}"; do
      linear_set_state "$issue" "Backlog" 2>/dev/null || true
      remove_task_state "$issue" 2>/dev/null || true
    done
  fi
  exit $exit_code
}
trap cleanup_on_exit INT TERM


# Initialize state ledger
init_state_ledger


# Prune stale tasks from previous runs
# Check each task: if PR merged or branch deleted, clean up worktree + state
cleanup_stale_tasks() {
  local stale_issues
  stale_issues=$(jq -r '.tasks | to_entries[] | .key' "$STATE_FILE" 2>/dev/null)
  [[ -z "$stale_issues" ]] && return 0

  local cleaned=0
  while IFS= read -r issue; do
    [[ -z "$issue" ]] && continue
    local task_json
    task_json=$(jq -r --arg i "$issue" '.tasks[$i]' "$STATE_FILE")
    local slug branch worktree pr
    slug=$(echo "$task_json" | jq -r '.slug')
    branch=$(echo "$task_json" | jq -r '.branch')
    worktree=$(echo "$task_json" | jq -r '.worktree')
    pr=$(echo "$task_json" | jq -r '.pr // empty')

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
      pr_st=$(gh pr view "$pr" --json state --jq .state 2>/dev/null || echo "")
      if [[ "$pr_st" == "MERGED" ]]; then
        should_clean=true
        full_clean=true
        reason="PR #$pr merged"
      elif [[ "$pr_st" == "CLOSED" ]]; then
        should_clean=true
        full_clean=true
        reason="PR #$pr closed"
      fi
    fi

    # Keep non-terminal tasks in state across restarts so the monitor can
    # resume PR/state reconciliation after crashes.

    if [[ "$should_clean" == "true" ]]; then
      log "  Pruning $issue ($reason)"
      if [[ "$full_clean" == "true" ]]; then
        # Clean up worktree + branch for completed tasks
        if [[ -d "$worktree" ]]; then
          execute git -C "$REPO_DIR" worktree remove "$worktree" --force 2>/dev/null || true
        fi
        if [[ "$reason" != "branch deleted" ]]; then
          git -C "$REPO_DIR" branch -D "$branch" 2>/dev/null || true
        fi
      fi
      # Remove from state file (dashboard will stop showing it)
      remove_task_state "$issue"
      cleaned=$((cleaned + 1))
    fi
  done <<<"$stale_issues"

  if (( cleaned > 0 )); then
    execute git -C "$REPO_DIR" worktree prune 2>/dev/null || true
    log "  Cleaned $cleaned stale task(s)"
  fi
}

stale_count=$(jq '.tasks | length' "$STATE_FILE" 2>/dev/null || echo 0)
if (( stale_count > 0 )); then
  log "Found $stale_count task(s) in state file from previous run. Checking..."
  cleanup_stale_tasks
fi


# Display configuration
if [[ "$DRY_RUN" == "true" ]]; then
  echo "============================================"
  echo "DRY-RUN MODE - No actions will be executed"
  echo "============================================"
fi


log "Configuration:"
log "  Repository: $REPO_DIR"
log "  Base branch: $BASE_BRANCH"
log "  Worktree root: $WORKTREE_ROOT"
log "  Project: ${PROJECT_NAME:-(all projects)}"
log "  Agent: $AGENT_CMD ($(agent_name "$AGENT_CMD"))${AGENT_CMD_EXPLICIT:+ [explicit override]}"
log "  Router: ${ROUTER_ENABLED:-true} (per-task agent+model selection)"
log "  Max parallel: $MAX_PARALLEL"
log "  Planning mode: $PLANNING_MODE"
[[ -n "${SETUP_CMD:-}" ]] && log "  Setup command: $SETUP_CMD"
log "  State file: $STATE_FILE"
echo ""


# Safety check: first-time repo confirmation
if [[ ! -f "$STATE_DIR/.initialized" ]] && [[ "$REQUIRE_CONFIRM" == "true" ]]; then
  echo "⚠️  First-time run in this repository"
  confirm "Continue with autonomous workflow in $REPO_DIR?" || exit 1
  execute touch "$STATE_DIR/.initialized"
fi


log "Fetching backlog..."
BACKLOG="$(linear_list_backlog)" || {
  log_error "Failed to fetch backlog from Linear. Check your LINEAR_API_KEY and network."
  exit 1
}

if [[ -z "$BACKLOG" ]] || [[ "$BACKLOG" == "[]" ]]; then
  log "No backlog items returned from Linear."
  exit 0
fi

CANDIDATES="$(pick_candidates "$BACKLOG")"
if [[ -z "$CANDIDATES" ]]; then
  log "No backlog candidates found."
  exit 0
fi


# Split candidates into unblocked and blocked
# pick_candidates() outputs 6 fields (has_detailed_plan is stripped), so field 6 is blocked_by_count
UNBLOCKED=$(echo "$CANDIDATES" | awk -F'|' '$6 == 0 || $6 == ""')
BLOCKED=$(echo "$CANDIDATES" | awk -F'|' '$6 > 0')
BLOCKED_COUNT=0
[[ -n "$BLOCKED" ]] && BLOCKED_COUNT=$(echo "$BLOCKED" | grep -c .)

echo ""
log "Available tasks (ranked by priority):"
if [[ -n "$UNBLOCKED" ]]; then
  echo "$UNBLOCKED" | head -9 | awk -F'|' '{printf "  %s. %s - %s (score: %.0f)\n", NR, $1, $3, $5}'
else
  echo "  (no unblocked tasks)"
fi

if (( BLOCKED_COUNT > 0 )); then
  echo ""
  echo "  ($BLOCKED_COUNT blocked task(s) hidden — enter 'm' to show all)"
fi

echo ""
if (( BLOCKED_COUNT > 0 )); then
  echo "Enter numbers to run (e.g. 1 3 5), m for more, q to quit, or Enter to auto-select first $MAX_PARALLEL:"
else
  echo "Enter numbers to run (e.g. 1 3 5), q to quit, or Enter to auto-select first $MAX_PARALLEL:"
fi
read -r SELECTED

# Handle 'm' to show all tasks including blocked
if [[ "$SELECTED" =~ ^[mM] ]]; then
  ALL_CANDIDATES=$(printf '%s\n%s' "$UNBLOCKED" "$BLOCKED" | grep .)
  echo ""
  log "All tasks (ranked by priority):"
  line_num=0
  while IFS= read -r line; do
    line_num=$((line_num + 1))
    IFS='|' read -r id slug title area score blocked_by <<<"$line"
    if (( blocked_by > 0 )); then
      printf "  %s. %s - %s (score: %.0f) [blocked]\n" "$line_num" "$id" "$title" "$score"
    else
      printf "  %s. %s - %s (score: %.0f)\n" "$line_num" "$id" "$title" "$score"
    fi
  done <<<"$ALL_CANDIDATES"
  echo ""
  echo "Enter numbers to run (e.g. 1 3 5), q to quit, or Enter to auto-select first $MAX_PARALLEL:"
  read -r SELECTED
  # Use full list for selection
  CANDIDATES="$ALL_CANDIDATES"
fi

if [[ "$SELECTED" =~ ^[qQ](uit)?$ ]]; then
  log "Cancelled by user."
  exit 0
fi

# When auto-selecting (empty input), only pick from unblocked candidates
if [[ -z "$SELECTED" ]] && [[ -n "$UNBLOCKED" ]]; then
  CANDIDATES="$UNBLOCKED"
fi

# Use smart selection
TASKS=()
SELECTED_LINES="$(smart_select_from_candidates "$CANDIDATES" "$SELECTED")"
while IFS= read -r line; do
  [[ -n "$line" ]] && TASKS+=("$line")
done <<<"$SELECTED_LINES"


log "Normalizing issues with task packets and launching work..."
LAUNCH_ARGS=()
EXPANSION_NEEDED=false


# Pre-allocate migration numbers for parallel work
# Fetch first so we scan the latest state of the base branch (not stale local files)
log "Fetching latest $BASE_BRANCH for migration scan..."
git -C "$REPO_DIR" fetch origin "$BASE_BRANCH" 2>/dev/null || true

# Scan the git tree (not local filesystem) for the highest existing migration number
HIGHEST=$(scan_highest_migration)
NEXT_MIGRATION_NUM=$((HIGHEST + 1))
save_next_migration_num "$NEXT_MIGRATION_NUM"
log "Next available migration number: $NEXT_MIGRATION_NUM (highest in origin/$BASE_BRANCH: $HIGHEST)"


# ── Phase 1: Fetch issue details in parallel ──────────────────────────────
log "Fetching issue details..."
for t in "${TASKS[@]}"; do
  IFS='|' read -r ISSUE SLUG TITLE <<<"$t"
  (
    json=$(linear_get_issue "$ISSUE" 2>/dev/null || echo "{}")
    echo "$json" > "/tmp/${SESSION}-${ISSUE}-issue.json"
  ) &
done
wait
log "  ✓ All issues fetched"


# ── Phase 2: Expand task packets in parallel ──────────────────────────────
# When planningMode=interactive, skip expansion — the agent will research
# the codebase itself during the interactive planning session.
EXPAND_PIDS=()
EXPAND_ISSUES=()

if [[ "$PLANNING_MODE" == "interactive" ]]; then
  log "  Skipping task packet expansion (planningMode=interactive)"
  # Still write raw descriptions to packet files so the orchestrator
  # can use them for the selected-task.json context
  for t in "${TASKS[@]}"; do
    IFS='|' read -r ISSUE SLUG TITLE <<<"$t"
    PACKET_FILE="/tmp/${SESSION}-${ISSUE}-taskpacket.md"
    issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
    current_desc=$(echo "$issue_json" | jq -r '.description // ""' 2>/dev/null || echo "")
    echo "$current_desc" > "$PACKET_FILE"
    log "  ✓ $ISSUE raw description saved"
  done
else
  for t in "${TASKS[@]}"; do
    IFS='|' read -r ISSUE SLUG TITLE <<<"$t"
    PACKET_FILE="/tmp/${SESSION}-${ISSUE}-taskpacket.md"
    issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
    current_desc=$(echo "$issue_json" | jq -r '.description // ""' 2>/dev/null || echo "")

    if is_task_packet "$current_desc"; then
      log "  ✓ $ISSUE has task packet"
      echo "$current_desc" > "$PACKET_FILE"
    else
      log "  ⚠ $ISSUE needs expansion - launching..."
      EXPANSION_NEEDED=true
      (
        write_task_packet "$ISSUE" "$PACKET_FILE"
      ) > "/tmp/${SESSION}-${ISSUE}-expand.log" 2>&1 &
      EXPAND_PIDS+=("$!")
      EXPAND_ISSUES+=("$ISSUE")
    fi
  done
fi

EXPANSION_FAILED=false
if (( ${#EXPAND_PIDS[@]} > 0 )); then
  log "Expanding ${#EXPAND_PIDS[@]} issue(s) in parallel..."
  for i in "${!EXPAND_PIDS[@]}"; do
    if wait "${EXPAND_PIDS[$i]}"; then
      log "  ✓ ${EXPAND_ISSUES[$i]} expanded"
    else
      log_warn "  ✗ ${EXPAND_ISSUES[$i]} expansion failed (see /tmp/${SESSION}-${EXPAND_ISSUES[$i]}-expand.log)"
      EXPANSION_FAILED=true
    fi
  done
fi


# ── Phase 3: Migration detection + state saving ──────────────────────────
for t in "${TASKS[@]}"; do
  IFS='|' read -r ISSUE SLUG TITLE <<<"$t"
  PACKET_FILE="/tmp/${SESSION}-${ISSUE}-taskpacket.md"
  issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
  current_desc=$(echo "$issue_json" | jq -r '.description // ""' 2>/dev/null || echo "")

  # Check if task involves database migration
  # Detection order: 1) label match  2) keyword in expanded task packet  3) keyword in raw description
  has_migration_label=$(echo "$issue_json" | jq -r '.labels.nodes[]? | select(.name | ascii_downcase | test("migration|database|schema|alembic")) | .name' 2>/dev/null | head -1)
  packet_text=$(cat "$PACKET_FILE" 2>/dev/null || echo "")
  is_migration=false

  if [[ -n "$has_migration_label" ]]; then
    log "  → Migration detected (label: $has_migration_label), assigning number: $NEXT_MIGRATION_NUM"
    is_migration=true
  elif echo "$packet_text" | grep -qi "alembic\|migration.*file\|database.*migration\|schema.*migration\|add.*column.*table\|create.*table\|alter.*table"; then
    log "  → Migration detected (task packet keyword match), assigning number: $NEXT_MIGRATION_NUM"
    log "    Tip: Add 'migration' label to $ISSUE for more reliable detection"
    is_migration=true
  elif echo "$current_desc" | grep -qi "alembic\|migration.*file\|database.*migration\|schema.*migration"; then
    log "  → Migration detected (raw description keyword match), assigning number: $NEXT_MIGRATION_NUM"
    log "    Tip: Add 'migration' label to $ISSUE for more reliable detection"
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

  # Don't set state yet - wait until user confirms
  # Save to state ledger (for tracking)
  BRANCH="task/${SLUG}"
  WT_DIR="${WORKTREE_ROOT}/${SLUG}"
  # Initialize with default agent (will be overridden by router if different agent selected)
  save_task_state "$ISSUE" "$SLUG" "$BRANCH" "$WT_DIR" "" "" "$AGENT_CMD"

  log "  ✓ $ISSUE ready"
  LAUNCH_ARGS+=("$t")
done


# Warn if expansion failed
if [[ "$EXPANSION_FAILED" == "true" ]]; then
  echo ""
  log_warn "Some issues failed to expand. Consider running /issue-writer on them first:"
  log_warn "  See: skills/issue-writer/SKILL.md"
  echo ""
  if [[ "$REQUIRE_CONFIRM" == "true" ]]; then
    if ! confirm "Continue anyway?"; then
      # User declined - clean up state ledger for these issues
      for t in "${TASKS[@]}"; do
        IFS='|' read -r ISSUE SLUG TITLE <<<"$t"
        remove_task_state "$ISSUE"
      done
      log "Cancelled by user"
      exit 0
    fi
  fi
fi


# ── Phase 4: Model routing suggestions ─────────────────────────────────
if [[ "${ROUTER_ENABLED:-true}" == "true" ]]; then
  SUGGEST_TOOL="$TOOLS_DIR/suggest-model.ts"
  if [[ -f "$SUGGEST_TOOL" ]]; then
    log "Running model router..."
    for t in "${TASKS[@]}"; do
      IFS='|' read -r ISSUE SLUG TITLE <<<"$t"
      PACKET_FILE="/tmp/${SESSION}-${ISSUE}-taskpacket.md"
      if [[ -f "$PACKET_FILE" ]]; then
        SUGGESTION=$(npx tsx "$SUGGEST_TOOL" --json --file "$PACKET_FILE" --repo-dir "$REPO_DIR" 2>/dev/null || echo "")
        if [[ -n "$SUGGESTION" ]]; then
          RECOMMENDED=$(echo "$SUGGESTION" | jq -r '.recommendedModel // empty' 2>/dev/null)
          CONFIDENCE=$(echo "$SUGGESTION" | jq -r '.confidence // empty' 2>/dev/null)
          TASK_TYPE=$(echo "$SUGGESTION" | jq -r '.taskType // empty' 2>/dev/null)
          INSUFFICIENT=$(echo "$SUGGESTION" | jq -r '.insufficientData // false' 2>/dev/null)
          REASONING=$(echo "$SUGGESTION" | jq -r '.reasoning // empty' 2>/dev/null)

          RECOMMENDED_AGENT=$(echo "$SUGGESTION" | jq -r '.recommendedAgent // empty' 2>/dev/null)
          if [[ "$INSUFFICIENT" == "true" ]]; then
            log "  $ISSUE: Using default agent (insufficient eval data)"
          else
            log "  $ISSUE: Recommended: $RECOMMENDED_AGENT --model $RECOMMENDED (confidence: $CONFIDENCE, task type: $TASK_TYPE)"
          fi

          # Store recommendation for orchestrator
          echo "$SUGGESTION" > "/tmp/${SESSION}-${ISSUE}-model-suggestion.json"
        fi
      fi
    done
    echo ""
  fi
fi


# User confirmed (or no confirmation needed) - now set issues to In Progress
INITIAL_PHASE="executing"
[[ "$PLANNING_MODE" == "interactive" ]] && INITIAL_PHASE="planning"

for t in "${TASKS[@]}"; do
  IFS='|' read -r ISSUE SLUG TITLE <<<"$t"
  ISSUES_IN_PROGRESS+=("$ISSUE")
  linear_set_state "$ISSUE" "In Progress"
  set_task_phase "$ISSUE" "$INITIAL_PHASE"
  log "Set $ISSUE → In Progress (phase: $INITIAL_PHASE)"
done


# Find orchestrator script (should be in same directory as this script)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORCHESTRATOR="$SCRIPT_DIR/wavemill-orchestrator.sh"


if [[ ! -f "$ORCHESTRATOR" ]]; then
  echo "Error: wavemill-orchestrator.sh not found at $ORCHESTRATOR"
  exit 1
fi


# Fetch latest base branch so worktrees start from up-to-date main
log "Fetching latest $BASE_BRANCH from remote..."
git -C "$REPO_DIR" fetch origin "$BASE_BRANCH"

# Call the launcher script (don't attach yet)
# Pass state file so the dashboard can show richer info
WAVEMILL_STATE_FILE="$STATE_FILE" ORCHESTRATOR_NO_ATTACH=1 "$ORCHESTRATOR" "$SESSION" "${LAUNCH_ARGS[@]}"


# Write monitor env file (avoids long command lines in tmux pane)
MONITOR_ENV="/tmp/${SESSION}-monitor.env"
cat > "$MONITOR_ENV" <<ENVEOF
SESSION='$SESSION'
REPO_DIR='$REPO_DIR'
WORKTREE_ROOT='$WORKTREE_ROOT'
TOOLS_DIR='$TOOLS_DIR'
LIB_DIR='$SCRIPT_DIR'
STATE_DIR='$STATE_DIR'
STATE_FILE='$STATE_FILE'
POLL_SECONDS='$POLL_SECONDS'
REQUIRE_CONFIRM='$REQUIRE_CONFIRM'
DRY_RUN='$DRY_RUN'
BASE_BRANCH='$BASE_BRANCH'
PROJECT_NAME='$PROJECT_NAME'
PLANNING_MODE='$PLANNING_MODE'
AGENT_CMD='$AGENT_CMD'
AGENT_CMD_EXPLICIT='${AGENT_CMD_EXPLICIT:-}'
ROUTER_ENABLED='${ROUTER_ENABLED:-true}'
MAX_PARALLEL='$MAX_PARALLEL'
AUTO_EVAL='$AUTO_EVAL'
ENVEOF


# Create monitoring script that will run in tmux
MONITOR_SCRIPT="/tmp/${SESSION}-monitor.sh"
cat > "$MONITOR_SCRIPT" <<'MONITOR_EOF'
#!/opt/homebrew/bin/bash
set -Eeuo pipefail


# Import environment from env file
source "$1"

# Logging functions - defined early so they're available for all error handling
log() { echo "$(date '+%H:%M:%S') $*"; }
log_error() { echo "$(date '+%H:%M:%S') ERROR: $*" >&2; }
log_warn() { echo "$(date '+%H:%M:%S') WARN: $*" >&2; }

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

# Ensure gh commands target the correct GitHub repo (not inherited CWD)
cd "$REPO_DIR"

# Close dashboard pane when monitor exits so quitting control is a single action.
_DASHBOARD_CLEANED=0
cleanup_dashboard_pane() {
  [[ "$_DASHBOARD_CLEANED" -eq 1 ]] && return 0
  _DASHBOARD_CLEANED=1

  tmux list-panes -t "$SESSION:control.1" >/dev/null 2>&1 || return 0
  tmux kill-pane -t "$SESSION:control.1" >/dev/null 2>&1 || true
}
trap cleanup_dashboard_pane EXIT INT TERM

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
# These functions manage task state in the workflow state file.
# Defined inline to avoid sourcing dependencies (similar to logging functions).

save_task_state() {
  local issue="$1" slug="$2" branch="$3" worktree="$4" pr="${5:-}" status="${6:-active}" agent="${7:-}"
  local tmp
  tmp=$(mktemp) || { log_warn "save_task_state: mktemp failed"; return 0; }

  if jq --arg issue "$issue" --arg slug "$slug" --arg branch "$branch" \
     --arg worktree "$worktree" --arg pr "$pr" --arg status "$status" \
     --arg agent "$agent" \
     '(.tasks[$issue].agent // "") as $old_agent |
      (.tasks[$issue].phase // "executing") as $old_phase |
      (.tasks[$issue].evalCompleted // false) as $old_eval |
      .tasks[$issue] = {
        slug: $slug,
        branch: $branch,
        worktree: $worktree,
        pr: $pr,
        status: $status,
        agent: (if $agent != "" then $agent else $old_agent end),
        phase: $old_phase,
        evalCompleted: $old_eval,
        updated: (now | todate)
      }' "$STATE_FILE" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$STATE_FILE"
  else
    rm -f "$tmp"
    log_warn "save_task_state: failed to save $issue"
  fi
}

remove_task_state() {
  local issue="$1"
  local tmp
  tmp=$(mktemp) || { log_warn "remove_task_state: mktemp failed"; return 0; }
  if jq --arg issue "$issue" 'del(.tasks[$issue]) | .updated = (now | todate)' \
     "$STATE_FILE" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$STATE_FILE"
  else
    rm -f "$tmp"
    log_warn "remove_task_state: failed to remove $issue"
  fi
}

set_task_phase() {
  local issue="$1" phase="$2"
  local tmp
  tmp=$(mktemp) || { log_warn "set_task_phase: mktemp failed"; return 0; }
  if jq --arg issue "$issue" --arg phase "$phase" \
     '.tasks[$issue].phase = $phase | .tasks[$issue].updated = (now | todate)' \
     "$STATE_FILE" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$STATE_FILE"
  else
    rm -f "$tmp"
    log_warn "set_task_phase: failed to update $issue"
  fi
}

get_task_phase() {
  local issue="$1"
  jq -r --arg issue "$issue" '.tasks[$issue].phase // "executing"' "$STATE_FILE" 2>/dev/null
}

mark_eval_completed() {
  local issue="$1"
  local tmp
  tmp=$(mktemp) || { log_warn "mark_eval_completed: mktemp failed"; return 0; }
  if jq --arg issue "$issue" \
     '.tasks[$issue].evalCompleted = true | .tasks[$issue].updated = (now | todate)' \
     "$STATE_FILE" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$STATE_FILE"
  else
    rm -f "$tmp"
    log_warn "mark_eval_completed: failed to update $issue"
  fi
}

validate_agent_set() {
  local issue="$1"
  local agent
  agent=$(jq -r --arg i "$issue" '.tasks[$i].agent // ""' "$STATE_FILE" 2>/dev/null)
  if [[ -z "$agent" ]]; then
    log_warn "  ⚠ BUG: Agent not set for $issue (should have been set at launch), auto-fixing to: $AGENT_CMD"
    # Auto-fix: update the task state with the default agent
    local slug branch worktree pr status
    slug=$(jq -r --arg i "$issue" '.tasks[$i].slug // ""' "$STATE_FILE" 2>/dev/null)
    branch=$(jq -r --arg i "$issue" '.tasks[$i].branch // ""' "$STATE_FILE" 2>/dev/null)
    worktree=$(jq -r --arg i "$issue" '.tasks[$i].worktree // ""' "$STATE_FILE" 2>/dev/null)
    pr=$(jq -r --arg i "$issue" '.tasks[$i].pr // ""' "$STATE_FILE" 2>/dev/null)
    status=$(jq -r --arg i "$issue" '.tasks[$i].status // ""' "$STATE_FILE" 2>/dev/null)
    save_task_state "$issue" "$slug" "$branch" "$worktree" "$pr" "$status" "$AGENT_CMD"
  fi
}

check_plan_approved() {
  local slug="$1"
  local wt="${WORKTREE_ROOT}/${slug}"
  [[ -f "$wt/features/$slug/.plan-approved" ]] && return 0
  return 1
}

cleanup_completed_task() {
  local issue="$1"
  local slug="$2"
  local completion_reason="${3:-}"

  # Kill tmux window (unconditional - no race condition)
  local win="$issue-$slug"
  tmux kill-window -t "$SESSION:$win" 2>/dev/null || true
  log "  ✓ Closed window: $win"

  # Remove worktree
  local wt_dir="${WORKTREE_ROOT}/${slug}"
  if [[ -d "$wt_dir" ]]; then
    git -C "$REPO_DIR" worktree remove "$wt_dir" --force 2>/dev/null || true
    log "  ✓ Removed worktree: $wt_dir"
  fi

  # Delete branch
  local task_branch="task/${slug}"
  if git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$task_branch" 2>/dev/null; then
    git -C "$REPO_DIR" branch -D "$task_branch" 2>/dev/null || true
    log "  ✓ Deleted branch: $task_branch"
  fi

  # Clean up state
  git -C "$REPO_DIR" worktree prune 2>/dev/null || true
  remove_task_state "$issue"
  CLEANED["$issue"]=1

  # Log completion with optional reason
  if [[ -n "$completion_reason" ]]; then
    log "  ✓ Complete: $issue ($completion_reason)"
  else
    log "  ✓ Complete: $issue"
  fi
}


# ============================================================================
# GIT/GITHUB FUNCTIONS
# ============================================================================
# Functions for PR detection and merge validation.

find_pr_for_branch() {
  local branch="$1"
  gh pr list --head "$branch" --state all --json number --jq '.[0].number // empty' 2>/dev/null || echo ""
}

pr_state() {
  local pr="$1"
  gh pr view "$pr" --json state --jq '.state' 2>/dev/null || echo ""
}

validate_pr_merge() {
  local pr="$1"
  [[ -z "$pr" ]] && return 1
  local state
  state=$(gh pr view "$pr" --json state --jq '.state' 2>/dev/null || echo "")
  [[ "$state" == "MERGED" ]] && return 0
  return 1
}


# ============================================================================
# LINEAR API FUNCTIONS
# ============================================================================
# Functions for updating Linear issue states.

linear_set_state() {
  local issue="$1" state="$2"
  local stderr_file rc
  stderr_file=$(mktemp) || { log_warn "Failed to update Linear state for $issue to $state (mktemp failed)"; return 0; }

  if npx tsx "$TOOLS_DIR/set-issue-state.ts" "$issue" "$state" >/dev/null 2>"$stderr_file"; then
    rm -f "$stderr_file"
    return 0
  fi

  rc=$?
  if [[ -s "$stderr_file" ]]; then
    local err_line
    err_line=$(tail -n 1 "$stderr_file")
    log_warn "Failed to update Linear state for $issue to $state (exit $rc): $err_line"
  else
    log_warn "Failed to update Linear state for $issue to $state (exit $rc)"
  fi
  rm -f "$stderr_file"
  return 0
}

linear_is_completed() {
  local issue="$1"
  local issue_state
  issue_state=$(npx tsx "$TOOLS_DIR/get-issue-json.ts" "$issue" 2>/dev/null | \
    jq -r '.state.name // ""' 2>/dev/null)
  [[ "$issue_state" == "Done" || "$issue_state" == "Completed" || "$issue_state" == "Canceled" ]]
}


# ============================================================================
# BACKLOG FETCHING & CANDIDATE SCORING
# ============================================================================

BACKLOG_CACHE=""
LAST_BACKLOG_FETCH=0
BACKLOG_CACHE_TTL=60  # seconds between backlog refreshes

fetch_candidates() {
  local now
  now=$(date +%s)

  # Use cache if fresh enough
  if (( now - LAST_BACKLOG_FETCH < BACKLOG_CACHE_TTL )) && [[ -n "$BACKLOG_CACHE" ]]; then
    echo "$BACKLOG_CACHE"
    return
  fi

  local backlog_json
  backlog_json=$(npx tsx "$TOOLS_DIR/list-backlog-json.ts" "$PROJECT_NAME" 2>/dev/null)

  if [[ -z "$backlog_json" ]] || [[ "$backlog_json" == "[]" ]]; then
    BACKLOG_CACHE=""
    LAST_BACKLOG_FETCH=$now
    return
  fi

  # Use shared scoring function from wavemill-common.sh (eliminates duplication)
  BACKLOG_CACHE=$(score_and_rank_issues "$backlog_json" 30)
  LAST_BACKLOG_FETCH=$now
  echo "$BACKLOG_CACHE"
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

launch_task() {
  local issue="$1" slug="$2" title="$3"
  local branch="task/${slug}"
  local wt_dir="${WORKTREE_ROOT}/${slug}"

  log "Launching $issue: $title"

  # Fetch issue details
  local issue_json
  issue_json=$(npx tsx "$TOOLS_DIR/get-issue-json.ts" "$issue" 2>/dev/null || echo "{}")
  local issue_desc
  issue_desc=$(echo "$issue_json" | jq -r '.description // ""' 2>/dev/null || echo "")

  # Task packet handling
  local packet_file="/tmp/${SESSION}-${issue}-taskpacket.md"
  if [[ "$PLANNING_MODE" == "interactive" ]]; then
    echo "$issue_desc" > "$packet_file"
  elif is_task_packet "$issue_desc"; then
    echo "$issue_desc" > "$packet_file"
  else
    log "  Expanding task packet for $issue..."
    if [[ -f "$TOOLS_DIR/expand-issue.ts" ]]; then
      npx tsx "$TOOLS_DIR/expand-issue.ts" "$issue" --output "$packet_file" --update >/dev/null 2>&1 || echo "$issue_desc" > "$packet_file"
    else
      echo "$issue_desc" > "$packet_file"
    fi
  fi
  local packet_content
  packet_content=$(cat "$packet_file" 2>/dev/null || echo "")

  # Fetch latest base branch
  git -C "$REPO_DIR" fetch origin "$BASE_BRANCH" 2>/dev/null || true

  # ── Migration detection for dynamically launched tasks ──────────────
  local is_migration=false
  local has_migration_label
  has_migration_label=$(echo "$issue_json" | jq -r '.labels.nodes[]? | select(.name | ascii_downcase | test("migration|database|schema|alembic")) | .name' 2>/dev/null | head -1)

  if [[ -n "$has_migration_label" ]]; then
    is_migration=true
  elif echo "$packet_content" | grep -qi "alembic\|migration.*file\|database.*migration\|schema.*migration\|add.*column.*table\|create.*table\|alter.*table"; then
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
    local _mig_tmp
    _mig_tmp=$(mktemp) || true
    if [[ -n "$_mig_tmp" ]] && jq --arg issue "$issue" --argjson num "$next_num" \
       '.migrationReservations[$issue] = $num | .nextMigrationNum = ($num + 1)' \
       "$STATE_FILE" > "$_mig_tmp" 2>/dev/null; then
      mv "$_mig_tmp" "$STATE_FILE"
    else
      rm -f "$_mig_tmp"
      log_warn "Failed to persist migration reservation for $issue"
    fi

    # Re-read packet content with migration hint included
    packet_content=$(cat "$packet_file" 2>/dev/null || echo "")
    log "  → Migration detected, assigned number: $next_num"
  fi

  # Create worktree + branch
  local created_new=false
  if [[ -d "$wt_dir" ]]; then
    log "  Worktree exists: $wt_dir (resuming)"
  elif git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$branch" 2>/dev/null; then
    log "  Branch $branch exists, resuming"
    git -C "$REPO_DIR" worktree add "$wt_dir" "$branch"
    created_new=true
  else
    log "  Creating branch $branch from origin/$BASE_BRANCH"
    git -C "$REPO_DIR" worktree add "$wt_dir" -b "$branch" "origin/$BASE_BRANCH"
    created_new=true
  fi

  # Set Linear state
  linear_set_state "$issue" "In Progress"

  # Track in monitor arrays
  BRANCH_BY_ISSUE["$issue"]="$branch"
  SLUG_BY_ISSUE["$issue"]="$slug"

  # ── Per-task model routing ──────────────────────────────────────────
  local task_agent_cmd="$AGENT_CMD"
  local task_model=""
  if [[ "${AGENT_CMD_EXPLICIT:-}" != "true" ]]; then
    local suggest_tool="$TOOLS_DIR/suggest-model.ts"
    if [[ "${ROUTER_ENABLED:-true}" == "true" ]] && [[ -f "$suggest_tool" ]] && [[ -f "$packet_file" ]]; then
      local suggestion
      suggestion=$(npx tsx "$suggest_tool" --json --file "$packet_file" --repo-dir "$REPO_DIR" 2>/dev/null || echo "")
      if [[ -n "$suggestion" ]]; then
        local rec_model rec_agent rec_insufficient rec_confidence
        rec_model=$(echo "$suggestion" | jq -r '.recommendedModel // empty' 2>/dev/null)
        rec_agent=$(echo "$suggestion" | jq -r '.recommendedAgent // empty' 2>/dev/null)
        rec_insufficient=$(echo "$suggestion" | jq -r '.insufficientData // false' 2>/dev/null)
        rec_confidence=$(echo "$suggestion" | jq -r '.confidence // empty' 2>/dev/null)

        # Always use recommended agent if provided (even when data is insufficient)
        # The router correctly maps default models to their agents
        if [[ -n "$rec_agent" ]]; then
          task_agent_cmd="$rec_agent"
        fi

        # Only gate model selection on data sufficiency
        if [[ "$rec_insufficient" != "true" ]] && [[ -n "$rec_model" ]]; then
          task_model="$rec_model"
          log "  Router: $task_agent_cmd --model $task_model (confidence: $rec_confidence)"
        elif [[ -n "$rec_model" ]]; then
          # Insufficient data - using default model but still log it
          log "  Router: $task_agent_cmd --model $rec_model (insufficient data, using default)"
        fi
      fi
    fi
  fi

  # Validate the selected agent exists
  if ! agent_validate "$task_agent_cmd"; then
    log_warn "  Agent '$task_agent_cmd' not found, falling back to '$AGENT_CMD'"
    task_agent_cmd="$AGENT_CMD"
    task_model=""
  fi

  # Save to state ledger (after routing so agent is known)
  local initial_phase="executing"
  [[ "$PLANNING_MODE" == "interactive" ]] && initial_phase="planning"
  save_task_state "$issue" "$slug" "$branch" "$wt_dir" "" "" "$task_agent_cmd"
  set_task_phase "$issue" "$initial_phase"

  # Verify agent was saved correctly (helps debug future issues)
  if [[ "${DEBUG_AGENT:-}" == "1" ]]; then
    local saved_agent
    saved_agent=$(jq -r --arg i "$issue" '.tasks[$i].agent // ""' "$STATE_FILE" 2>/dev/null)
    if [[ "$saved_agent" != "$task_agent_cmd" ]]; then
      log_warn "  ⚠ Agent save mismatch: expected='$task_agent_cmd' but got='$saved_agent'"
    else
      log "  ✓ Agent set to: $task_agent_cmd"
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
  tmux new-window -t "$SESSION" -n "$win" -c "$wt_dir"

  # Codex does not reliably trigger bell flags for input-required turns.
  # Make codex attention states red by overriding activity style per-window.
  if [[ "$task_agent_cmd" == "codex" ]]; then
    tmux set-window-option -t "$SESSION:$win" window-status-activity-style bg=red,fg=white,bold >/dev/null 2>&1 || true
  fi

  # Run setup command in new worktrees (e.g., npm install)
  if [[ -n "${SETUP_CMD:-}" ]] && [[ "$created_new" == "true" ]]; then
    log "  Running setup: $SETUP_CMD"
    local _sentinel="/tmp/.wavemill-setup-${issue//[^a-zA-Z0-9_-]/_}"
    rm -f "$_sentinel"
    tmux send-keys -t "$SESSION:$win" \
      "$SETUP_CMD && touch '$_sentinel' || touch '$_sentinel'" C-m
    local _t=0
    while [[ ! -f "$_sentinel" ]] && (( _t < 180 )); do
      sleep 2; (( _t += 2 ))
    done
    rm -f "$_sentinel"
    if (( _t >= 180 )); then
      log_warn "  Setup timed out after 180s, proceeding anyway"
    else
      log "  Setup complete"
    fi
  fi

  # Launch agent
  if [[ "$PLANNING_MODE" == "interactive" ]]; then
    # Pre-seed selected-task.json
    local feature_dir="$wt_dir/features/$slug"
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

    # Copy details file to worktree for easy access
    local details_file="/tmp/${SESSION}-${issue}-taskpacket-details.md"
    local details_context
    if [[ -f "$details_file" ]]; then
      cp "$details_file" "$feature_dir/task-packet-details.md"
      details_context=$(cat <<DETAILS_EOF
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
- Section 9: Proposed Labels
DETAILS_EOF
)
    else
      details_context=$(cat <<'DETAILS_EOF'
NOTE: Task packet details file was not pre-seeded in this worktree.
Plan from `selected-task.json` plus direct codebase analysis.
DETAILS_EOF
)
    fi

    local issue_context
    if [[ -n "$packet_content" ]]; then
      issue_context=$(cat <<ISSUE_CONTEXT_EOF
Issue Description (Brief Overview):
$packet_content

$details_context
ISSUE_CONTEXT_EOF
)
    else
      issue_context="$details_context"
    fi

    local prompt_file="/tmp/${SESSION}-${issue}-plan-prompt.txt"
    cat > "$prompt_file" <<PLAN_PROMPT_EOF
You are working on: $title ($issue)

Repo worktree: $wt_dir
Branch: $branch
Base branch: $BASE_BRANCH

$issue_context
---

## Your Workflow

You have THREE phases. Do them in order.

### Phase 1: Planning (interactive)
Task context is pre-seeded at: features/$slug/selected-task.json

1. Read the task context
2. Research the codebase to understand relevant code and patterns
3. Create a detailed implementation plan with phases
4. Save the plan to: features/$slug/plan.md
5. Present the plan summary to the user and wait for approval
6. After approval, create a file: features/$slug/.plan-approved

Do NOT proceed to Phase 2 until the user has approved the plan.

### Phase 2: Implementation
After plan approval:
1. Execute the plan phase by phase
2. Run tests/lint between phases — pause if anything fails

### Phase 3: Self-Review & PR
After implementation is complete and tests/lint pass, you MUST run the self-review tool.
This is a REQUIRED step — do not skip it or substitute your own review.

1. Run the self-review tool (up to 3 iterations):
   npx tsx $TOOLS_DIR/review-changes.ts $BASE_BRANCH --verbose
   - Exit code 0 = review passed → proceed to step 3
   - Exit code 1 = issues found → fix blockers and re-run (step 2)
   - Exit code 2 = error → log warning and proceed to step 3

2. For each iteration where issues are found:
   - Read the review output carefully
   - Fix all blockers (severity: blocker) and straightforward warnings
   - Make targeted fixes only — do not refactor unrelated code
   - Commit fixes: git commit -m "fix: Address self-review findings (iteration N)"
   - Re-run the review tool (step 1)

3. Create a PR using GitHub CLI with a descriptive title and body:
   gh pr create --title "$issue: <concise summary>" --body "<PR body>"
   The PR body MUST include:
   - A "## Summary" section with 2-4 bullet points describing what changed and why
   - A "## Changes" section listing the key files/modules modified
   - A "## Test plan" section describing how the changes were validated
   - A "## Self-review" section noting the review verdict and iterations run
   Do NOT use --fill. Write the PR body as a HEREDOC if needed for formatting.
4. Link the PR to $issue

Success criteria:
- [ ] Implementation matches plan and issue requirements
- [ ] Lint/tests pass
- [ ] Self-review tool executed (npx tsx $TOOLS_DIR/review-changes.ts)
- [ ] No regressions
- [ ] PR created with descriptive summary linked to $issue

Start with Phase 1 now. Read the task context and begin researching.
PLAN_PROMPT_EOF

    agent_launch_interactive "$SESSION" "$win" "$prompt_file" "$task_agent_cmd" "$task_model"
  else
    # Skip mode — pipe instructions to agent
    local instr_file="/tmp/${SESSION}-${issue}-instructions.txt"
    local details_file="/tmp/${SESSION}-${issue}-taskpacket-details.md"
    local details_context

    # Copy details file to worktree root for easy access
    if [[ -f "$details_file" ]]; then
      cp "$details_file" "$wt_dir/task-packet-details.md"
      details_context=$(cat <<DETAILS_EOF
📖 Full Details: Read task-packet-details.md in the repo root for:
- Complete implementation approach (Section 3)
- All success criteria with [REQ-FX] tags (Section 4)
- Concrete validation steps with test scenarios (Section 6)
- Implementation constraints and rules (Section 5)
DETAILS_EOF
)
    else
      details_context=$(cat <<'DETAILS_EOF'
NOTE: Task packet details file was not pre-seeded in this worktree.
Implement from the issue description plus direct codebase analysis.
DETAILS_EOF
)
    fi

    local issue_context
    if [[ -n "$packet_content" ]]; then
      issue_context=$(cat <<ISSUE_CONTEXT_EOF
Issue Description (Brief Overview):
$packet_content

$details_context
ISSUE_CONTEXT_EOF
)
    else
      issue_context="$details_context"
    fi

    cat > "$instr_file" <<INSTR_EOF
You are working on: $title ($issue)

Repo worktree: $wt_dir
Branch: $branch
Base branch: $BASE_BRANCH

$issue_context

Goal:
- Implement the feature/fix described by the issue and title.

IMPORTANT: You are running autonomously with NO user interaction.
- Do NOT ask questions or request user input — make your best judgment call.
- If a decision is ambiguous, choose the most reasonable default and document your choice in the PR description.
- If you truly cannot proceed without clarification, note the blocker in the PR description and implement what you can.

Success criteria:
- [ ] Implementation matches issue requirements
- [ ] UI is responsive and accessible (if applicable)
- [ ] Lint/tests pass
- [ ] Self-review tool executed (npx tsx $TOOLS_DIR/review-changes.ts)
- [ ] No regressions in existing functionality
- [ ] PR created with clear description and linked to $issue

Process:
1. Inspect repo and find relevant code
2. Make minimal, high-quality changes
3. Run tests/lint
4. REQUIRED: Run the self-review tool before creating a PR (do not skip or substitute your own review):
   npx tsx $TOOLS_DIR/review-changes.ts $BASE_BRANCH --verbose
   - Exit code 0 = passed → proceed to step 5
   - Exit code 1 = issues found → fix blockers, commit fixes, re-run (up to 3 iterations)
   - Exit code 2 = error → log warning and proceed to step 5
   For each iteration with issues: fix all blockers and straightforward warnings,
   commit with "fix: Address self-review findings (iteration N)", then re-run the tool.
5. Create a PR using GitHub CLI with a descriptive title and body:
   gh pr create --title "$issue: <concise summary of changes>" --body "<PR body>"
   The PR body MUST include:
   - A "## Summary" section with 2-4 bullet points describing what changed and why
   - A "## Changes" section listing the key files/modules modified
   - A "## Test plan" section describing how the changes were validated
   - A "## Self-review" section noting the review verdict and iterations run
   Do NOT use --fill. Write the PR body as a HEREDOC if needed for formatting.
6. Post back with summary of changes, commands run + results, and PR link
INSTR_EOF

    agent_launch_autonomous "$SESSION" "$win" "$instr_file" "$task_agent_cmd" "$task_model"
  fi

  log "  ✓ $issue launched (phase: ${initial_phase}, agent: ${task_agent_cmd}${task_model:+ --model $task_model})"
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


log "Monitoring tasks and managing work queue..."
[[ "$PLANNING_MODE" == "interactive" ]] && log "  Planning mode: interactive (watching for plan approval)"
log "  Max parallel: $MAX_PARALLEL"
log "  Checking every ${POLL_SECONDS}s"
log "  Type 'q' to quit, or 'touch $STATE_DIR/.stop-loop' to stop"
echo ""

QUIT_REQUESTED=false
LAST_DISPLAY=""       # fingerprint of what was last printed
LAST_ACTIVE_COUNT=-1  # force first render

monitor_issue_state() {
  local ISSUE="$1"
  local BRANCH SLUG PR
  local task_status WIN WT_DIR task_branch current_phase eval_agent debug_flag

  BRANCH="${BRANCH_BY_ISSUE[$ISSUE]}"
  SLUG="${SLUG_BY_ISSUE[$ISSUE]}"
  PR="${PR_BY_ISSUE[$ISSUE]:-}"

  # If already merged (requireConfirm), wait for window close then cleanup
  task_status=$(jq -r --arg issue "$ISSUE" '.tasks[$issue].status // empty' "$STATE_FILE" 2>/dev/null)
  if [[ "$task_status" == "merged" ]]; then
    WIN="$ISSUE-$SLUG"
    if tmux list-panes -t "$SESSION:$WIN" -F '#{pane_dead}' 2>/dev/null | grep -q '^0$'; then
      active_count=$((active_count + 1))
      return 0
    fi

    cleanup_completed_task "$ISSUE" "$SLUG" "post-review cleanup"

    # Prune worktrees after cleanup
    execute git -C "$REPO_DIR" worktree prune 2>/dev/null || true
    return 0
  fi

  # Check if PR exists
  if [[ -z "$PR" ]]; then
    PR="$(find_pr_for_branch "$BRANCH")"
    if [[ -n "$PR" ]]; then
      PR_BY_ISSUE["$ISSUE"]="$PR"
      # Preserve agent when updating with PR number
      current_agent=$(jq -r --arg i "$ISSUE" '.tasks[$i].agent // ""' "$STATE_FILE" 2>/dev/null)
      save_task_state "$ISSUE" "$SLUG" "$BRANCH" "${WORKTREE_ROOT}/${SLUG}" "$PR" "" "$current_agent"
      linear_set_state "$ISSUE" "In Review"
      log "✓ $ISSUE → PR #$PR (In Review)"
    else
      # No PR in current repo - check Linear issue state for cross-repo completion
      if linear_is_completed "$ISSUE"; then
        log "✓ $ISSUE → Completed externally (cross-repo or manual)"

        # Post-completion eval (non-blocking: always exits 0)
        if [[ "$AUTO_EVAL" == "true" ]]; then
          eval_completed=$(jq -r --arg i "$ISSUE" '.tasks[$i].evalCompleted // false' "$STATE_FILE" 2>/dev/null)
          if [[ "$eval_completed" == "false" ]]; then
            log "  📊 Running post-completion eval..."
            # Validate and auto-fix agent if not set
            validate_agent_set "$ISSUE"
            eval_agent=$(jq -r --arg i "$ISSUE" '.tasks[$i].agent // ""' "$STATE_FILE" 2>/dev/null)
            [[ -z "$eval_agent" ]] && eval_agent="$AGENT_CMD"
            # Always enable debug mode for cost diagnostics (HOK-879)
            debug_flag="--debug"
            npx tsx "$TOOLS_DIR/run-eval-hook.ts" \
              --issue "$ISSUE" --branch "$BRANCH" \
              --worktree "${WORKTREE_ROOT}/${SLUG}" \
              --workflow-type mill --repo-dir "$REPO_DIR" \
              --agent "$eval_agent" \
              $debug_flag \
              2>&1 | while IFS= read -r line; do log "  [eval] $line"; done || true
            mark_eval_completed "$ISSUE"
          else
            log "  ✓ Eval already completed for $ISSUE"
          fi
        fi

        if [[ "$REQUIRE_CONFIRM" == "true" ]]; then
          log "  → Window stays open for review - close it when ready"
          linear_set_state "$ISSUE" "Done"
          # Preserve agent when marking as completed-external
          current_agent=$(jq -r --arg i "$ISSUE" '.tasks[$i].agent // ""' "$STATE_FILE" 2>/dev/null)
          save_task_state "$ISSUE" "$SLUG" "$BRANCH" "${WORKTREE_ROOT}/${SLUG}" "" "completed-external" "$current_agent"
          active_count=$((active_count + 1))
          return 0
        fi

        # Clean up worktree and state
        linear_set_state "$ISSUE" "Done"
        cleanup_completed_task "$ISSUE" "$SLUG" "external completion"
        return 0
      fi

      # Planning phase tracking (must run before pane-alive early return)
      current_phase=$(get_task_phase "$ISSUE")

      if [[ "$current_phase" == "planning" ]]; then
        if check_plan_approved "$SLUG"; then
          set_task_phase "$ISSUE" "executing"
          log "✓ $ISSUE → Plan approved, now executing"
        else
          WIN="$ISSUE-$SLUG"
          if tmux list-panes -t "$SESSION:$WIN" -F '#{pane_dead}' 2>/dev/null | grep -q '^0$'; then
            # Keep unapproved planning tasks active while agent is still running.
            active_count=$((active_count + 1))
            return 0
          fi
        fi
      fi

      # Not completed externally - check if agent pane is still alive
      WIN="$ISSUE-$SLUG"
      if tmux list-panes -t "$SESSION:$WIN" -F '#{pane_dead}' 2>/dev/null | grep -q '^0$'; then
        # Pane still running - agent is working, keep slot active
        active_count=$((active_count + 1))
        return 0
      fi

      # Agent exited without creating a PR - clean up the slot
      log "⚠ $ISSUE → Agent exited without PR - releasing slot"
      cleanup_completed_task "$ISSUE" "$SLUG" "no PR created"
      return 0
    fi
  fi

  # Check if merged
  if validate_pr_merge "$PR"; then
    log "✓ $ISSUE → PR #$PR MERGED"

    # Post-merge eval (non-blocking: always exits 0)
    if [[ "$AUTO_EVAL" == "true" ]]; then
      eval_completed=$(jq -r --arg i "$ISSUE" '.tasks[$i].evalCompleted // false' "$STATE_FILE" 2>/dev/null)
      if [[ "$eval_completed" == "false" ]]; then
        log "  📊 Running post-merge eval..."
        # Validate and auto-fix agent if not set
        validate_agent_set "$ISSUE"
        eval_agent=$(jq -r --arg i "$ISSUE" '.tasks[$i].agent // ""' "$STATE_FILE" 2>/dev/null)
        [[ -z "$eval_agent" ]] && eval_agent="$AGENT_CMD"
        # Always enable debug mode for cost diagnostics (HOK-879)
        debug_flag="--debug"
        npx tsx "$TOOLS_DIR/run-eval-hook.ts" \
          --issue "$ISSUE" --pr "$PR" --branch "$BRANCH" \
          --worktree "${WORKTREE_ROOT}/${SLUG}" \
          --workflow-type mill --repo-dir "$REPO_DIR" \
          --agent "$eval_agent" \
          $debug_flag \
          2>&1 | while IFS= read -r line; do log "  [eval] $line"; done || true
        mark_eval_completed "$ISSUE"
      else
        log "  ✓ Eval already completed for $ISSUE"
      fi
    fi

    if [[ "$REQUIRE_CONFIRM" == "true" ]]; then
      log "  → Window stays open for review - close it when ready"
      linear_set_state "$ISSUE" "Done"
      # Preserve agent when marking as merged
      current_agent=$(jq -r --arg i "$ISSUE" '.tasks[$i].agent // ""' "$STATE_FILE" 2>/dev/null)
      save_task_state "$ISSUE" "$SLUG" "$BRANCH" "${WORKTREE_ROOT}/${SLUG}" "$PR" "merged" "$current_agent"
      active_count=$((active_count + 1))
      return 0
    fi

    linear_set_state "$ISSUE" "Done"
    cleanup_completed_task "$ISSUE" "$SLUG"
  elif [[ "$(pr_state "$PR")" == "CLOSED" ]]; then
    log_warn "$ISSUE → PR #$PR CLOSED without merge"
    linear_set_state "$ISSUE" "Backlog"
    CLEANED["$ISSUE"]=1
  else
    active_count=$((active_count + 1))
  fi

  return 0
}

while :; do
  # ── Phase A: Monitor existing tasks ──────────────────────────────────
  active_count=0

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
  done

  # ── Phase B: Check for stop signal ──────────────────────────────────
  if [[ -f "$STATE_DIR/.stop-loop" ]]; then
    if (( active_count == 0 )); then
      log "Stop signal detected and all tasks complete. Exiting."
      rm -f "$STATE_DIR/.stop-loop"
      exit 0
    fi
    log "Stop signal detected. Finishing $active_count active task(s)..."
    sleep "$POLL_SECONDS"
    continue
  fi

  if [[ "$QUIT_REQUESTED" == "true" ]]; then
    if (( active_count == 0 )); then
      log "All tasks complete. Exiting."
      exit 0
    fi
    # Still have active tasks — keep monitoring but don't offer new ones
    sleep "$POLL_SECONDS"
    continue
  fi

  # ── Phase C: Offer new tasks if slots available ─────────────────────
  free_slots=$((MAX_PARALLEL - active_count))

  if (( free_slots > 0 )); then
    candidates=$(fetch_candidates)

    if [[ -n "$candidates" ]]; then
      available=$(filter_active_issues "$candidates")

      if [[ -n "$available" ]]; then
        # Split into unblocked and blocked
        # Field 7 is blocked_by_count (field 6 is has_detailed_plan)
        avail_unblocked=$(echo "$available" | awk -F'|' '$7 == 0 || $7 == ""')
        avail_blocked=$(echo "$available" | awk -F'|' '$7 > 0')
        avail_blocked_count=0
        [[ -n "$avail_blocked" ]] && avail_blocked_count=$(echo "$avail_blocked" | grep -c .)

        # Only re-render the prompt when the display would actually change
        display_fingerprint="${free_slots}|${avail_unblocked}|${avail_blocked_count}"
        if [[ "$display_fingerprint" != "$LAST_DISPLAY" ]] || (( active_count != LAST_ACTIVE_COUNT )); then
          echo ""
          log "$free_slots slot(s) available. Next tasks:"
          if [[ -n "$avail_unblocked" ]]; then
            echo "$avail_unblocked" | head -9 | awk -F'|' '{printf "  %s. %s - %s (score: %.0f)\n", NR, $1, $3, $5}'
          else
            echo "  (no unblocked tasks)"
          fi
          if (( avail_blocked_count > 0 )); then
            echo ""
            echo "  ($avail_blocked_count blocked task(s) hidden — enter 'm' to show all)"
          fi
          echo ""
          if (( avail_blocked_count > 0 )); then
            echo "Enter number(s) to start (e.g. 1 3), 'm' for more, 'q' to quit, or wait ${POLL_SECONDS}s to refresh:"
          else
            echo "Enter number(s) to start (e.g. 1 3), 'q' to quit, or wait ${POLL_SECONDS}s to refresh:"
          fi
          LAST_DISPLAY="$display_fingerprint"
          LAST_ACTIVE_COUNT=$active_count
        fi

        # Default: selection against unblocked list only
        select_from="$avail_unblocked"

        if read -t "$POLL_SECONDS" -r REPLY; then
          # Strip ANSI escape sequences (e.g. arrow keys buffered during wait)
          REPLY=$(printf '%s' "$REPLY" | LC_ALL=C tr -d '\033' | sed 's/\[[A-Za-z0-9;]*//g')

          # Handle 'm' to show all tasks including blocked
          if [[ "$REPLY" =~ ^[mM] ]]; then
            all_avail=$(printf '%s\n%s' "$avail_unblocked" "$avail_blocked" | grep .)
            echo ""
            log "$free_slots slot(s) available. All tasks:"
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
            select_from="$all_avail"
            # Re-read for actual selection
            if read -t "$POLL_SECONDS" -r REPLY; then
              REPLY=$(printf '%s' "$REPLY" | LC_ALL=C tr -d '\033' | sed 's/\[[A-Za-z0-9;]*//g')
            else
              REPLY=""
            fi
          fi

          if [[ "$REPLY" =~ ^[Qq] ]]; then
            if (( active_count == 0 )); then
              log "Quitting."
              exit 0
            else
              log "Will quit after $active_count active task(s) finish."
              QUIT_REQUESTED=true
            fi
          elif [[ -n "$REPLY" ]]; then
            # Parse user selection and launch tasks (up to free_slots)
            launched=0
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
              IFS='|' read -r sel_issue sel_slug sel_title _sel_area _sel_score _sel_blocked <<<"$local_line"
              launch_task "$sel_issue" "$sel_slug" "$sel_title"
              launched=$((launched + 1))
            done
            # Invalidate caches after launching so next cycle re-renders
            LAST_BACKLOG_FETCH=0
            LAST_DISPLAY=""
          fi
          # User pressed Enter with no input — just continue monitoring
        fi
        # read timed out — continue monitoring
      else
        # All candidates are already active
        if (( active_count == 0 )); then
          log "No new tasks available. Waiting... (type 'q' to quit)"
          if read -t "$POLL_SECONDS" -r REPLY; then
            [[ "$REPLY" =~ ^[Qq] ]] && exit 0
          fi
        else
          sleep "$POLL_SECONDS"
        fi
      fi
    else
      # Backlog empty
      if (( active_count == 0 )); then
        log "Backlog empty. Waiting for new tasks... (type 'q' to quit)"
        # Invalidate cache so we re-fetch next cycle
        LAST_BACKLOG_FETCH=0
        if read -t "$POLL_SECONDS" -r REPLY; then
          [[ "$REPLY" =~ ^[Qq] ]] && exit 0
        fi
      else
        sleep "$POLL_SECONDS"
      fi
    fi
  else
    # All slots full — just monitor
    sleep "$POLL_SECONDS"
  fi
done
MONITOR_EOF


chmod +x "$MONITOR_SCRIPT"


# Launch monitor in control window's first pane
log "Starting monitoring in tmux control window..."


# Write tasks to temp file and add to env
TASKS_FILE="/tmp/${SESSION}-tasks.txt"
printf '%s\n' "${TASKS[@]}" > "$TASKS_FILE"
echo "TASKS_FILE='$TASKS_FILE'" >> "$MONITOR_ENV"


tmux send-keys -t "$SESSION:control.0" "clear && '$MONITOR_SCRIPT' '$MONITOR_ENV'" C-m


# Now attach to the session
log "Attaching to session: $SESSION"
log "  Ctrl+B then W to switch windows"
log "  Ctrl+B then D to detach"
log "  Type 'q' in control window to quit"
log "  Or: touch $STATE_DIR/.stop-loop"
echo ""
sleep 1
tmux attach -t "$SESSION"

log "Session ended. Run 'git -C $REPO_DIR worktree prune' if needed."
