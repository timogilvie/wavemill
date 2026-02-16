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
load_config "$REPO_DIR"

# Derived variables (not in config files)
DRY_RUN="${DRY_RUN:-false}"
STATE_DIR="${STATE_DIR:-$REPO_DIR/.wavemill}"
STATE_FILE="$STATE_DIR/workflow-state.json"


command -v jq >/dev/null || { echo "Error: jq required (install: brew install jq)"; exit 1; }
command -v gh >/dev/null || { echo "Error: gh required (install: brew install gh && gh auth login)"; exit 1; }
command -v npx >/dev/null || { echo "Error: npx required (install: brew install node)"; exit 1; }
command -v tmux >/dev/null || { echo "Error: tmux required (install: brew install tmux)"; exit 1; }
command -v "$AGENT_CMD" >/dev/null || { echo "Error: agent '$AGENT_CMD' not found"; exit 1; }


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


# Import functions
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

  # Check 1: Must be MERGED (not CLOSED)
  if [[ "$state" != "MERGED" ]]; then
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
      log_warn "PR #$pr has failing CI checks - waiting for resolution"
      return 1
    fi

    # Check 4: CI checks must be complete (not pending)
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


# Check if a planning task has completed its plan (plan.md exists + .plan-approved)
check_plan_approved() {
  local slug="$1"
  local wt="${WORKTREE_ROOT}/${slug}"
  local feature_dir="$wt/features/$slug"
  [[ -f "$feature_dir/.plan-approved" ]] && return 0
  return 1
}


check_plan_exists() {
  local slug="$1"
  local wt="${WORKTREE_ROOT}/${slug}"
  local feature_dir="$wt/features/$slug"
  [[ -f "$feature_dir/plan.md" ]] && return 0
  return 1
}


# Parse tasks from file
declare -A PR_BY_ISSUE BRANCH_BY_ISSUE SLUG_BY_ISSUE CLEANED


while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  IFS='|' read -r ISSUE SLUG TITLE <<<"$line"
  BRANCH_BY_ISSUE["$ISSUE"]="task/${SLUG}"
  SLUG_BY_ISSUE["$ISSUE"]="$SLUG"
done < "$TASKS_FILE"


log "Monitoring PRs and cleaning up merged tasks..."
[[ "$PLANNING_MODE" == "interactive" ]] && log "  Planning mode: interactive (watching for plan approval)"
log "  Checking every ${POLL_SECONDS}s"
echo ""


while :; do
  all_done=true


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
        # Window still open — user is reviewing
        all_done=false
        continue
      fi

      # Window closed or pane dead — finish cleanup
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
      continue
    fi


    # ── Planning phase tracking ─────────────────────────────────────────
    # When planningMode=interactive, tasks start in "planning" phase.
    # Monitor watches for plan.md and .plan-approved to track progress.
    current_phase=$(get_task_phase "$ISSUE")

    if [[ "$current_phase" == "planning" ]]; then
      if check_plan_approved "$SLUG"; then
        set_task_phase "$ISSUE" "executing"
        log "✓ $ISSUE → Plan approved, now executing"
      elif check_plan_exists "$SLUG"; then
        # Plan exists but not yet approved — user needs to review
        all_done=false
        continue
      else
        # Still planning — agent is researching/drafting
        all_done=false
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
        all_done=false
        continue
      fi
    fi


    # Check if merged
    if validate_pr_merge "$PR"; then
      log "✓ $ISSUE → PR #$PR MERGED"


      # When requireConfirm is on, mark as merged but keep polling
      # so the user can inspect the window before cleanup
      if [[ "$REQUIRE_CONFIRM" == "true" ]]; then
        log "  → Window stays open for review — close it when ready"
        linear_set_state "$ISSUE" "Done"
        save_task_state "$ISSUE" "$SLUG" "$BRANCH" "${WORKTREE_ROOT}/${SLUG}" "$PR" "merged"
        all_done=false
        continue
      fi


      # Auto cleanup
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

      # Clean up the merged branch to avoid stale reuse
      task_branch="task/${SLUG}"
      if git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$task_branch" 2>/dev/null; then
        execute git -C "$REPO_DIR" branch -D "$task_branch" 2>/dev/null || true
        log "  ✓ Deleted branch: $task_branch"
      fi

      remove_task_state "$ISSUE"
      CLEANED["$ISSUE"]=1
      log "  ✓ Complete: $ISSUE"


    elif [[ "$(pr_state "$PR")" == "CLOSED" ]]; then
      log_warn "$ISSUE → PR #$PR CLOSED without merge"
      linear_set_state "$ISSUE" "Backlog"
      CLEANED["$ISSUE"]=1
    else
      all_done=false
    fi
  done


  if $all_done; then
    echo ""
    log "🎉 All tasks complete!"

    # Prune old worktrees
    execute git -C "$REPO_DIR" worktree prune
    log "  ✓ Pruned worktrees"

    # Check for exit signal file
    if [[ -f "$STATE_DIR/.stop-loop" ]]; then
      log "Stop signal detected. Exiting loop..."
      rm -f "$STATE_DIR/.stop-loop"
      exit 0
    fi

    # Re-fetch backlog to get latest tasks
    echo ""
    log "Checking for more work..."
    BACKLOG_JSON=$(npx tsx "$TOOLS_DIR/list-backlog-json.ts" "$PROJECT_NAME" 2>&1 | sed '/^\[dotenv/d' | sed '/^[[:space:]]*$/d')

    if [[ -z "$BACKLOG_JSON" ]] || [[ "$BACKLOG_JSON" == "[]" ]]; then
      log "Backlog empty. Exiting loop."
      exit 0
    fi

    # Get new candidates
    NEW_CANDIDATES=$(echo "$BACKLOG_JSON" | jq -r --argjson show_limit 9 '
      map(select((.state.name|ascii_downcase) == "todo" or (.state.name|ascii_downcase) == "backlog"))
      | map(. + {
          area: ((.labels.nodes // []) | map(.name) | map(select(test("^(Area|Component|Page|Route):"))) | .[0] // ""),
          has_detailed_plan: (.description // "" | test("##+ (1\\\\\\\\.|Objective|What|Technical Context|Success Criteria|Implementation)")),
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

    if [[ -z "$NEW_CANDIDATES" ]]; then
      log "No backlog candidates found. Exiting loop."
      exit 0
    fi

    # Show available tasks
    echo ""
    log "Available tasks for next cycle:"
    echo "$NEW_CANDIDATES" | awk -F'|' '{printf "%s. %s - %s (score: %.0f)\n", NR, $1, $3, $5}' | head -9
    echo ""

    # Prompt with timeout for auto-continue
    log "Continue to next cycle? [Y/n] (auto-continue in 10s, or 'touch $STATE_DIR/.stop-loop' to stop)"
    read -t 10 -r REPLY || REPLY="y"
    echo ""

    if [[ ! $REPLY =~ ^[Yy]?$ ]]; then
      log "User declined. Exiting loop."
      exit 0
    fi

    log "🔄 Starting next cycle..."
    echo ""

    # Signal the outer script to restart by creating a restart file
    touch "$STATE_DIR/.restart-loop"
    log "Restart signal sent. Exiting monitoring..."
    exit 0
  fi


  sleep "$POLL_SECONDS"
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
log "  To stop continuous loop: touch $STATE_DIR/.stop-loop"
echo ""
sleep 1
tmux attach -t "$SESSION"

# After detaching, check if monitoring script signaled a restart
if [[ -f "$STATE_DIR/.restart-loop" ]]; then
  rm -f "$STATE_DIR/.restart-loop"
  log "Restart signal detected - preparing next cycle..."
  echo ""
  sleep 2
  # Re-execute this script to start next cycle
  exec "$0"
fi

log "Session ended. Run 'git -C $REPO_DIR worktree prune' if needed."
