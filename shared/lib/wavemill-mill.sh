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


# Retry wrapper with exponential backoff
retry() {
  local max_attempts="$MAX_RETRIES"
  local delay="$RETRY_DELAY"
  local attempt=1
  local exit_code=0


  while (( attempt <= max_attempts )); do
    "$@" && return 0
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
  local issue="$1"
  local slug="$2"
  local branch="$3"
  local worktree="$4"
  local pr="${5:-}"
  local status="${6:-}"


  local tmp=$(mktemp)
  jq --arg issue "$issue" \
     --arg slug "$slug" \
     --arg branch "$branch" \
     --arg worktree "$worktree" \
     --arg pr "$pr" \
     --arg status "$status" \
     '.tasks[$issue] = {slug: $slug, branch: $branch, worktree: $worktree, pr: $pr, status: $status, updated: (now | todate)}' \
     "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
}


get_task_state() {
  local issue="$1"
  jq -r --arg issue "$issue" '.tasks[$issue] // empty' "$STATE_FILE"
}


remove_task_state() {
  local issue="$1"
  local tmp=$(mktemp)
  jq --arg issue "$issue" 'del(.tasks[$issue])' "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
}


# ============================================================================
# LINEAR API WITH RETRY
# ============================================================================


linear_list_backlog() {
  # Filter out dotenv and other informational messages, keep only JSON
  retry npx tsx "$TOOLS_DIR/list-backlog-json.ts" "$PROJECT_NAME" 2>&1 | sed '/^\[dotenv/d' | sed '/^[[:space:]]*$/d'
}
linear_get_issue() {
  # Use JSON output version, filter dotenv messages
  retry npx tsx "$TOOLS_DIR/get-issue-json.ts" "$1" 2>&1 | sed '/^\[dotenv/d' | sed '/^$/d'
}


linear_set_state() {
  local issue="$1"
  local state="$2"


  if [[ "$DRY_RUN" == "true" ]]; then
    log "[DRY-RUN] Would set $issue → $state"
    return 0
  fi


  retry npx tsx "$TOOLS_DIR/set-issue-state.ts" "$issue" "$state" >/dev/null 2>&1
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


# Note: is_task_packet() and write_task_packet() now provided by wavemill-common.sh


# Conflict-aware task selection with multi-factor priority scoring
# Shows up to 9 candidates, selects up to MAX_PARALLEL avoiding conflicts
# Note: Uses score_and_rank_issues() from wavemill-common.sh, then strips the has_detailed_plan field
pick_candidates() {
  local backlog_json="$1"
  local show_limit=9

  # Use shared scoring function, then strip last field (has_detailed_plan)
  score_and_rank_issues "$backlog_json" "$show_limit" | cut -d'|' -f1-5
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
      IFS='|' read -r issue slug title area score <<<"$line"


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
  retry gh pr list --head "$branch" --json number --jq '.[0].number // empty'
}


pr_state() {
  local pr="$1"
  retry gh pr view "$pr" --json state --jq .state
}


# Get PR details with base branch validation
pr_details() {
  local pr="$1"
  retry gh pr view "$pr" --json state,baseRefName,statusCheckRollup
}


# Check if PR is safe to mark as Done
# Returns 0 if safe, 1 if not
validate_pr_merge() {
  local pr="$1"
  local details


  details="$(pr_details "$pr" 2>/dev/null || echo "")"


  if [[ -z "$details" ]]; then
    log_error "Failed to fetch PR #$pr details"
    return 1
  fi


  local state=$(echo "$details" | jq -r '.state')
  local base_branch=$(echo "$details" | jq -r '.baseRefName')
  local has_checks=$(echo "$details" | jq '.statusCheckRollup | length > 0')
  local checks=$(echo "$details" | jq -r '.statusCheckRollup[]?.conclusion // "PENDING"')


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


  # Only validate CI checks if checks exist (repos without CI skip this)
  if [[ "$has_checks" == "true" ]]; then
    # Check 3: All CI checks must pass
    if echo "$checks" | grep -qE "FAILURE|CANCELLED"; then
      log_warn "PR #$pr has failing CI checks"
      return 1
    fi

    # Check 4: CI checks must be complete (not pending)
    if echo "$checks" | grep -q "PENDING"; then
      log_warn "PR #$pr CI checks still pending"
      return 1
    fi
  fi

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

  # Check if the tmux session from a previous run is still alive
  local session_alive=false
  tmux has-session -t "$SESSION" 2>/dev/null && session_alive=true

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

    # If no tmux session exists, orphaned tasks should be removed from state
    # (worktree+branch preserved so user can resume manually if needed)
    if [[ "$should_clean" == "false" ]] && [[ "$session_alive" == "false" ]]; then
      should_clean=true
      full_clean=false
      reason="orphaned (no active session)"
    fi

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
log "  Agent: $AGENT_CMD ($(agent_name "$AGENT_CMD"))"
log "  Max parallel: $MAX_PARALLEL"
log "  Planning mode: $PLANNING_MODE"
log "  State file: $STATE_FILE"
echo ""


# Safety check: first-time repo confirmation
if [[ ! -f "$STATE_DIR/.initialized" ]] && [[ "$REQUIRE_CONFIRM" == "true" ]]; then
  echo "⚠️  First-time run in this repository"
  confirm "Continue with autonomous workflow in $REPO_DIR?" || exit 1
  execute touch "$STATE_DIR/.initialized"
fi


log "Fetching backlog..."
BACKLOG="$(linear_list_backlog)"


CANDIDATES="$(pick_candidates "$BACKLOG")"
if [[ -z "$CANDIDATES" ]]; then
  log "No backlog candidates found."
  exit 0
fi


echo ""
log "Available tasks (ranked by priority, up to 9 shown):"
echo "$CANDIDATES" | awk -F'|' '{printf "%s. %s - %s (score: %.0f)\n", NR, $1, $3, $5}' | head -9
echo ""
echo "Enter numbers to run (e.g. 1 3 5) or press Enter to auto-select first $MAX_PARALLEL:"
read -r SELECTED


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
# Find highest existing migration number in the repo
NEXT_MIGRATION_NUM=1
if [[ -d "$REPO_DIR/alembic/versions" ]]; then
  HIGHEST=$(find "$REPO_DIR/alembic/versions" -name "*.py" -exec basename {} \; | grep -oE '^[0-9]+' | sort -n | tail -1 || echo "0")
  NEXT_MIGRATION_NUM=$((HIGHEST + 1))
fi
log "Next available migration number: $NEXT_MIGRATION_NUM"


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
    current_desc=$(echo "$issue_json" | jq -r '.description // ""')
    echo "$current_desc" > "$PACKET_FILE"
    log "  ✓ $ISSUE raw description saved"
  done
else
  for t in "${TASKS[@]}"; do
    IFS='|' read -r ISSUE SLUG TITLE <<<"$t"
    PACKET_FILE="/tmp/${SESSION}-${ISSUE}-taskpacket.md"
    issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
    current_desc=$(echo "$issue_json" | jq -r '.description // ""')

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
  current_desc=$(echo "$issue_json" | jq -r '.description // ""')

  # Check if task involves database migration (label-based detection preferred, keyword fallback)
  has_migration_label=$(echo "$issue_json" | jq -r '.labels.nodes[]? | select(.name | ascii_downcase | test("migration|database|schema|alembic")) | .name' | head -1)
  is_migration=false

  if [[ -n "$has_migration_label" ]]; then
    log "  → Migration detected (label: $has_migration_label), assigning number: $NEXT_MIGRATION_NUM"
    is_migration=true
  elif echo "$current_desc" | grep -qi "alembic\|migration.*file\|database.*migration\|schema.*migration"; then
    log "  → Migration detected (keyword match), assigning number: $NEXT_MIGRATION_NUM"
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
    NEXT_MIGRATION_NUM=$((NEXT_MIGRATION_NUM + 1))
  fi

  # Don't set state yet - wait until user confirms
  # Save to state ledger (for tracking)
  BRANCH="task/${SLUG}"
  WT_DIR="${WORKTREE_ROOT}/${SLUG}"
  save_task_state "$ISSUE" "$SLUG" "$BRANCH" "$WT_DIR"

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

          if [[ "$INSUFFICIENT" == "true" ]]; then
            log "  $ISSUE: Using default model (insufficient eval data)"
          else
            log "  $ISSUE: Recommended model: $RECOMMENDED (confidence: $CONFIDENCE, task type: $TASK_TYPE)"
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
  set_task_phase "$STATE_FILE" "$ISSUE" "$INITIAL_PHASE"
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
STATE_DIR='$STATE_DIR'
STATE_FILE='$STATE_FILE'
POLL_SECONDS='$POLL_SECONDS'
REQUIRE_CONFIRM='$REQUIRE_CONFIRM'
DRY_RUN='$DRY_RUN'
BASE_BRANCH='$BASE_BRANCH'
PROJECT_NAME='$PROJECT_NAME'
PLANNING_MODE='$PLANNING_MODE'
AGENT_CMD='$AGENT_CMD'
MAX_PARALLEL='$MAX_PARALLEL'
AUTO_EVAL='$AUTO_EVAL'
ENVEOF


# Create monitoring script that will run in tmux
MONITOR_SCRIPT="/tmp/${SESSION}-monitor.sh"
cat > "$MONITOR_SCRIPT" <<'MONITOR_EOF'
#!/opt/homebrew/bin/bash
set -euo pipefail


# Import environment from env file
source "$1"


# Logging
log() { echo "$(date '+%H:%M:%S') $*"; }
log_error() { echo "$(date '+%H:%M:%S') ERROR: $*" >&2; }
log_warn() { echo "$(date '+%H:%M:%S') WARN: $*" >&2; }


# ============================================================================
# STATE & LINEAR HELPERS
# ============================================================================

save_task_state() {
  local issue="$1" slug="$2" branch="$3" worktree="$4" pr="${5:-}" status="${6:-}"
  local tmp=$(mktemp)
  jq --arg issue "$issue" --arg slug "$slug" --arg branch "$branch" \
     --arg worktree "$worktree" --arg pr "$pr" --arg status "$status" \
     '.tasks[$issue] = {slug: $slug, branch: $branch, worktree: $worktree, pr: $pr, status: $status, updated: (now | todate)}' \
     "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
}


remove_task_state() {
  local issue="$1"
  local tmp=$(mktemp)
  jq --arg issue "$issue" 'del(.tasks[$issue])' "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
}


linear_set_state() {
  local issue="$1" state="$2"
  [[ "$DRY_RUN" == "true" ]] && { log "[DRY-RUN] Would set $issue → $state"; return 0; }
  npx tsx "$TOOLS_DIR/set-issue-state.ts" "$issue" "$state" >/dev/null 2>&1
}


find_pr_for_branch() {
  local branch="$1"
  gh pr list --head "$branch" --json number --jq '.[0].number // empty' 2>/dev/null || true
}


pr_state() {
  local pr="$1"
  gh pr view "$pr" --json state --jq .state 2>/dev/null || echo ""
}


pr_details() {
  local pr="$1"
  gh pr view "$pr" --json state,baseRefName,statusCheckRollup 2>/dev/null || echo ""
}


validate_pr_merge() {
  local pr="$1"
  local details="$(pr_details "$pr")"

  if [[ -z "$details" ]]; then
    log_warn "Failed to fetch PR #$pr details"
    return 1
  fi

  local state=$(echo "$details" | jq -r '.state')
  local base_branch=$(echo "$details" | jq -r '.baseRefName')
  local has_checks=$(echo "$details" | jq '.statusCheckRollup | length > 0')
  local checks=$(echo "$details" | jq -r '.statusCheckRollup[]?.conclusion // "PENDING"')

  if [[ "$state" != "MERGED" ]]; then return 1; fi
  if [[ "$base_branch" != "$BASE_BRANCH" ]]; then
    log_error "PR #$pr merged to wrong base: $base_branch (expected: $BASE_BRANCH)"
    return 1
  fi

  if [[ "$has_checks" == "true" ]]; then
    if echo "$checks" | grep -qE "FAILURE|CANCELLED"; then
      log_warn "PR #$pr has failing CI checks - waiting for resolution"
      return 1
    fi
    if echo "$checks" | grep -q "PENDING"; then
      log "PR #$pr CI checks still pending - waiting..."
      return 1
    fi
  fi

  return 0
}


execute() {
  [[ "$DRY_RUN" == "true" ]] && { echo "[DRY-RUN] $*"; return 0; }
  "$@"
}


set_task_phase() {
  local issue="$1" phase="$2"
  local tmp=$(mktemp)
  jq --arg issue "$issue" --arg phase "$phase" \
     '.tasks[$issue].phase = $phase | .tasks[$issue].updated = (now | todate)' \
     "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
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
  backlog_json=$(npx tsx "$TOOLS_DIR/list-backlog-json.ts" "$PROJECT_NAME" 2>&1 | sed '/^\[dotenv/d' | sed '/^[[:space:]]*$/d')

  if [[ -z "$backlog_json" ]] || [[ "$backlog_json" == "[]" ]]; then
    BACKLOG_CACHE=""
    LAST_BACKLOG_FETCH=$now
    return
  fi

  BACKLOG_CACHE=$(echo "$backlog_json" | jq -r --argjson show_limit 9 '
    map(select((.state.name|ascii_downcase) == "todo" or (.state.name|ascii_downcase) == "backlog"))
    | map(. + {
        area: ((.labels.nodes // []) | map(.name) | map(select(test("^(Area|Component|Page|Route):"))) | .[0] // ""),
        has_detailed_plan: (.description // "" | test("##+ (1\\.|Objective|What|Technical Context|Success Criteria|Implementation)")),
        is_foundational: ((.labels.nodes // []) | map(.name | ascii_downcase) | any(test("foundational|architecture|epic|infrastructure"))),
        blocks_count: ((.relations.nodes // []) | map(select(.type == "blocks")) | length),
        blocked_by_count: ((.relations.nodes // []) | map(select(.type == "blocked")) | length)
      })
    | map(. + {
        score: (20 + (if .priority > 0 then (5 - .priority) * 20 else 0 end) + (if .has_detailed_plan then 30 else 0 end) + (if .is_foundational then 25 else 0 end) + (.blocks_count * 10) + (if .blocked_by_count == 0 then 15 else 0 end) - (.blocked_by_count * 20) - ((.estimate // 3) * 2))
      })
    | sort_by(-.score)
    | .[0:$show_limit]
    | .[]
    | "\(.identifier)|\(.title|ascii_downcase|gsub("[^a-z0-9]+";"-"))|\(.title)|\(.area)|\(.score)"
  ')
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

is_task_packet() {
  local description="$1"
  echo "$description" | grep -qE "(##+ (1\.|Objective)|##+ What|##+ Technical Context|##+ Success Criteria|## Task Packet)"
}


launch_task() {
  local issue="$1" slug="$2" title="$3"
  local branch="task/${slug}"
  local wt_dir="${WORKTREE_ROOT}/${slug}"

  log "Launching $issue: $title"

  # Fetch issue details
  local issue_json
  issue_json=$(npx tsx "$TOOLS_DIR/get-issue-json.ts" "$issue" 2>&1 | sed '/^\[dotenv/d' | sed '/^$/d' || echo "{}")
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

  # Create worktree + branch
  if [[ -d "$wt_dir" ]]; then
    log "  Worktree exists: $wt_dir (resuming)"
  elif git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$branch" 2>/dev/null; then
    log "  Branch $branch exists, resuming"
    git -C "$REPO_DIR" worktree add "$wt_dir" "$branch"
  else
    log "  Creating branch $branch from origin/$BASE_BRANCH"
    git -C "$REPO_DIR" worktree add "$wt_dir" -b "$branch" "origin/$BASE_BRANCH"
  fi

  # Set Linear state
  linear_set_state "$issue" "In Progress"

  # Save to state ledger
  local initial_phase="executing"
  [[ "$PLANNING_MODE" == "interactive" ]] && initial_phase="planning"
  save_task_state "$issue" "$slug" "$branch" "$wt_dir"
  set_task_phase "$issue" "$initial_phase"

  # Track in monitor arrays
  BRANCH_BY_ISSUE["$issue"]="$branch"
  SLUG_BY_ISSUE["$issue"]="$slug"

  # Create tmux window
  local win="$issue-$slug"
  tmux new-window -t "$SESSION" -n "$win" -c "$wt_dir"

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

    local prompt_file="/tmp/${SESSION}-${issue}-plan-prompt.txt"
    cat > "$prompt_file" <<PLAN_PROMPT_EOF
You are working on: $title ($issue)

Repo worktree: $wt_dir
Branch: $branch
Base branch: $BASE_BRANCH

${packet_content:+Issue Description:
$packet_content
}
---

## Your Workflow

You have TWO phases. Do them in order.

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
3. Create a PR using GitHub CLI: gh pr create --fill
4. Link the PR to $issue

Success criteria:
- [ ] Implementation matches plan and issue requirements
- [ ] Lint/tests pass
- [ ] No regressions
- [ ] PR created with clear description linked to $issue

Start with Phase 1 now. Read the task context and begin researching.
PLAN_PROMPT_EOF

    local launcher="/tmp/${SESSION}-${issue}-launcher.sh"
    cat > "$launcher" <<LAUNCH_EOF
#!/bin/bash
exec claude "\$(cat '$prompt_file')"
LAUNCH_EOF
    chmod +x "$launcher"
    tmux send-keys -t "$SESSION:$win" "'$launcher'" C-m
  else
    # Skip mode — pipe instructions to agent
    local instr_file="/tmp/${SESSION}-${issue}-instructions.txt"
    cat > "$instr_file" <<INSTR_EOF
You are working on: $title ($issue)

Repo worktree: $wt_dir
Branch: $branch
Base branch: $BASE_BRANCH

${packet_content:+Issue Description:
$packet_content
}

Goal:
- Implement the feature/fix described by the issue and title.

Success criteria:
- [ ] Implementation matches issue requirements
- [ ] UI is responsive and accessible (if applicable)
- [ ] Lint/tests pass
- [ ] No regressions in existing functionality
- [ ] PR created with clear description and linked to $issue

Process:
1. Inspect repo and find relevant code
2. Make minimal, high-quality changes
3. Run tests/lint
4. Create a PR using GitHub CLI: gh pr create --fill
5. Post back with summary of changes, commands run + results, and PR link
INSTR_EOF

    if [[ "$AGENT_CMD" == "claude" ]]; then
      tmux send-keys -t "$SESSION:$win" "cat '$instr_file' | $AGENT_CMD" C-m
    elif [[ "$AGENT_CMD" == "codex" ]]; then
      tmux send-keys -t "$SESSION:$win" "$AGENT_CMD /task \"\$(cat '$instr_file')\"" C-m
    else
      tmux send-keys -t "$SESSION:$win" "$AGENT_CMD" C-m
      sleep 0.3
      tmux set-buffer "$(cat "$instr_file")"
      tmux paste-buffer -t "$SESSION:$win"
      tmux send-keys -t "$SESSION:$win" C-m
    fi
  fi

  log "  ✓ $issue launched (phase: ${initial_phase})"
}


# ============================================================================
# MAIN MONITORING LOOP
# ============================================================================

# Parse initial tasks from file
declare -A PR_BY_ISSUE BRANCH_BY_ISSUE SLUG_BY_ISSUE CLEANED

while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  IFS='|' read -r ISSUE SLUG TITLE <<<"$line"
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

while :; do
  # ── Phase A: Monitor existing tasks ──────────────────────────────────
  active_count=0

  for ISSUE in "${!BRANCH_BY_ISSUE[@]}"; do
    [[ -n "${CLEANED[$ISSUE]:-}" ]] && continue

    BRANCH="${BRANCH_BY_ISSUE[$ISSUE]}"
    SLUG="${SLUG_BY_ISSUE[$ISSUE]}"
    PR="${PR_BY_ISSUE[$ISSUE]:-}"

    # If already merged (requireConfirm), wait for window close then cleanup
    task_status=$(jq -r --arg issue "$ISSUE" '.tasks[$issue].status // empty' "$STATE_FILE" 2>/dev/null)
    if [[ "$task_status" == "merged" ]]; then
      WIN="$ISSUE-$SLUG"
      if tmux list-panes -t "$SESSION:$WIN" -F '#{pane_dead}' 2>/dev/null | grep -q '^0$'; then
        active_count=$((active_count + 1))
        continue
      fi

      execute tmux kill-window -t "$SESSION:$WIN" 2>/dev/null || true

      WT_DIR="${WORKTREE_ROOT}/${SLUG}"
      if [[ -d "$WT_DIR" ]]; then
        execute git -C "$REPO_DIR" worktree remove "$WT_DIR" --force 2>/dev/null || true
        log "  ✓ Removed worktree: $WT_DIR"
      fi

      task_branch="task/${SLUG}"
      if git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$task_branch" 2>/dev/null; then
        execute git -C "$REPO_DIR" branch -D "$task_branch" 2>/dev/null || true
        log "  ✓ Deleted branch: $task_branch"
      fi

      remove_task_state "$ISSUE"
      CLEANED["$ISSUE"]=1
      log "  ✓ Complete: $ISSUE (post-review cleanup)"

      # Prune worktrees after cleanup
      execute git -C "$REPO_DIR" worktree prune 2>/dev/null || true
      continue
    fi

    # ── Planning phase tracking ───────────────────────────────────────
    current_phase=$(get_task_phase "$ISSUE")

    if [[ "$current_phase" == "planning" ]]; then
      if check_plan_approved "$SLUG"; then
        set_task_phase "$ISSUE" "executing"
        log "✓ $ISSUE → Plan approved, now executing"
      else
        active_count=$((active_count + 1))
        continue
      fi
    fi

    # Check if PR exists
    if [[ -z "$PR" ]]; then
      PR="$(find_pr_for_branch "$BRANCH")"
      if [[ -n "$PR" ]]; then
        PR_BY_ISSUE["$ISSUE"]="$PR"
        save_task_state "$ISSUE" "$SLUG" "$BRANCH" "${WORKTREE_ROOT}/${SLUG}" "$PR"
        linear_set_state "$ISSUE" "In Review"
        log "✓ $ISSUE → PR #$PR (In Review)"
      else
        active_count=$((active_count + 1))
        continue
      fi
    fi

    # Check if merged
    if validate_pr_merge "$PR"; then
      log "✓ $ISSUE → PR #$PR MERGED"

      # Post-merge eval (non-blocking: always exits 0)
      if [[ "$AUTO_EVAL" == "true" ]]; then
        log "  📊 Running post-merge eval..."
        npx tsx "$TOOLS_DIR/run-eval-hook.ts" \
          --issue "$ISSUE" --pr "$PR" --branch "$BRANCH" \
          --workflow-type mill --repo-dir "$REPO_DIR" \
          2>&1 | while IFS= read -r line; do log "  [eval] $line"; done || true
      fi

      if [[ "$REQUIRE_CONFIRM" == "true" ]]; then
        log "  → Window stays open for review — close it when ready"
        linear_set_state "$ISSUE" "Done"
        save_task_state "$ISSUE" "$SLUG" "$BRANCH" "${WORKTREE_ROOT}/${SLUG}" "$PR" "merged"
        active_count=$((active_count + 1))
        continue
      fi

      linear_set_state "$ISSUE" "Done"

      WIN="$ISSUE-$SLUG"
      if tmux has-session -t "$SESSION:$WIN" 2>/dev/null; then
        execute tmux kill-window -t "$SESSION:$WIN" 2>/dev/null || true
        log "  ✓ Closed window: $WIN"
      fi

      WT_DIR="${WORKTREE_ROOT}/${SLUG}"
      if [[ -d "$WT_DIR" ]]; then
        execute git -C "$REPO_DIR" worktree remove "$WT_DIR" --force 2>/dev/null || true
        log "  ✓ Removed worktree: $WT_DIR"
      fi

      task_branch="task/${SLUG}"
      if git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$task_branch" 2>/dev/null; then
        execute git -C "$REPO_DIR" branch -D "$task_branch" 2>/dev/null || true
        log "  ✓ Deleted branch: $task_branch"
      fi

      remove_task_state "$ISSUE"
      CLEANED["$ISSUE"]=1
      log "  ✓ Complete: $ISSUE"

      execute git -C "$REPO_DIR" worktree prune 2>/dev/null || true

    elif [[ "$(pr_state "$PR")" == "CLOSED" ]]; then
      log_warn "$ISSUE → PR #$PR CLOSED without merge"
      linear_set_state "$ISSUE" "Backlog"
      CLEANED["$ISSUE"]=1
    else
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
        # Only re-render the prompt when the display would actually change
        display_fingerprint="${free_slots}|${available}"
        if [[ "$display_fingerprint" != "$LAST_DISPLAY" ]] || (( active_count != LAST_ACTIVE_COUNT )); then
          echo ""
          log "$free_slots slot(s) available. Next tasks:"
          echo "$available" | awk -F'|' '{printf "  %s. %s - %s (score: %.0f)\n", NR, $1, $3, $5}' | head -9
          echo ""
          echo "Enter number(s) to start (e.g. 1 3), 'q' to quit, or wait ${POLL_SECONDS}s to refresh:"
          LAST_DISPLAY="$display_fingerprint"
          LAST_ACTIVE_COUNT=$active_count
        fi

        if read -t "$POLL_SECONDS" -r REPLY; then
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
              if (( launched >= free_slots )); then
                log_warn "No more free slots — skipping remaining selections"
                break
              fi
              local_line=$(echo "$available" | sed -n "${n}p")
              if [[ -z "$local_line" ]]; then
                log_warn "Invalid selection: $n"
                continue
              fi
              IFS='|' read -r sel_issue sel_slug sel_title _sel_area _sel_score <<<"$local_line"
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
