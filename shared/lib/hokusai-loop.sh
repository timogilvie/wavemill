#!/opt/homebrew/bin/bash
set -euo pipefail


SESSION="${SESSION:-hokusai-web}"
REPO_DIR="${REPO_DIR:-$PWD}"
WORKTREE_ROOT="${WORKTREE_ROOT:-$REPO_DIR/../worktrees}"
TOOLS_DIR="${TOOLS_DIR:-$HOME/.claude/tools}"
AGENT_CMD="${AGENT_CMD:-claude}"
MAX_PARALLEL="${MAX_PARALLEL:-3}"
POLL_SECONDS="${POLL_SECONDS:-10}"
PROJECT_NAME="${PROJECT_NAME:-Hokusai public website}"
BASE_BRANCH="${BASE_BRANCH:-main}"


# Safety and robustness flags
DRY_RUN="${DRY_RUN:-false}"
REQUIRE_CONFIRM="${REQUIRE_CONFIRM:-true}"
STATE_DIR="${STATE_DIR:-$REPO_DIR/.hokusai}"
STATE_FILE="$STATE_DIR/workflow-state.json"
MAX_RETRIES="${MAX_RETRIES:-3}"
RETRY_DELAY="${RETRY_DELAY:-2}"


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


  local tmp=$(mktemp)
  jq --arg issue "$issue" \
     --arg slug "$slug" \
     --arg branch "$branch" \
     --arg worktree "$worktree" \
     --arg pr "$pr" \
     '.tasks[$issue] = {slug: $slug, branch: $branch, worktree: $worktree, pr: $pr, updated: (now | todate)}' \
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


# Check if issue description is already a detailed task packet
is_task_packet() {
  local description="$1"
  # Check for common task packet markers (h2 or h3 level)
  echo "$description" | grep -qE "(##+ (1\\.|Objective)|##+ What|##+ Technical Context|##+ Success Criteria|## Task Packet)"
}


# For v1: Use expand-issue.ts if available, otherwise skip expansion
# In future: integrate /issue-writer skill via dedicated expansion step
write_task_packet() {
  local issue_id="$1"
  local out_file="$2"


  # Fetch current description
  local issue_json=$(linear_get_issue "$issue_id" 2>/dev/null || echo "{}")
  local current_desc=$(echo "$issue_json" | jq -r '.description // ""')


  # Check if already a task packet
  if is_task_packet "$current_desc"; then
    log "  → Already detailed, skipping expansion"
    echo "$current_desc" > "$out_file"
    return 0
  fi


  # Check if expand-issue.ts exists
  if [[ -f "$TOOLS_DIR/expand-issue.ts" ]]; then
    log "  → Expanding with expand-issue.ts..."
    # Use --update to save to Linear and --output to save locally
    # This will also auto-label the issue
    npx tsx "$TOOLS_DIR/expand-issue.ts" "$issue_id" --update --output "$out_file" 2>&1 || {
      log_warn "Expansion failed, falling back to raw description"
      echo "$current_desc" > "$out_file"
    }
  else
    # Fallback: just use the raw issue description
    echo "$current_desc" > "$out_file"
  fi
}


# Conflict-aware task selection
# Shows up to 9 candidates, selects up to MAX_PARALLEL avoiding conflicts
pick_candidates() {
  local backlog_json="$1"
  local show_limit=9


  # Extract tasks with conflict scoring
  echo "$backlog_json" | jq -r --argjson show_limit "$show_limit" '
    # Filter to backlog/todo only
    map(select((.state.name|ascii_downcase) == "todo" or (.state.name|ascii_downcase) == "backlog"))


    # Extract area labels (common patterns: "Area: X", "Component: X", or any capitalized label)
    | map(. + {
        area: (
          .labels.nodes
          | map(.name)
          | map(select(test("^(Area|Component|Page|Route):")))
          | .[0] // ""
        )
      })


    # Sort by estimate (prefer smaller tasks)
    | sort_by(.estimate // 999)


    # Take up to show_limit for display
    | .[0:$show_limit]
    | .[]
    | "\(.identifier)|\(.title|ascii_downcase|gsub("[^a-z0-9]+";"-"))|\(.title)"
  '
}


# Smart selection that avoids conflicts
smart_select_from_candidates() {
  local candidates="$1"
  local selected_numbers="$2"


  if [[ -z "$selected_numbers" ]]; then
    # Auto-select up to MAX_PARALLEL with conflict avoidance
    local -a areas=()
    local -a result=()
    local count=0


    while IFS= read -r line && [[ $count -lt $MAX_PARALLEL ]]; do
      IFS='|' read -r issue slug title <<<"$line"


      # Get area from Linear (simplified - just use first label)
      local area=""
      # For now, assume no conflicts if no area specified


      result+=("$line")
      ((count++))
    done <<<"$candidates"


    printf '%s\n' "${result[@]}"
  else
    # User selected specific numbers
    while read -r n; do
      echo "$candidates" | sed -n "${n}p"
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


  # Check 3: All CI checks must pass (if checks exist)
  if echo "$checks" | grep -qE "FAILURE|CANCELLED"; then
    log_warn "PR #$pr has failing CI checks"
    return 1
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
log "  Project: $PROJECT_NAME"
log "  Max parallel: $MAX_PARALLEL"
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
log "Available tasks (up to 9 shown, select up to $MAX_PARALLEL):"
echo "$CANDIDATES" | nl -w2 -s'. '
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


for t in "${TASKS[@]}"; do
  IFS='|' read -r ISSUE SLUG TITLE <<<"$t"
  log "  Checking $ISSUE..."
  PACKET_FILE="/tmp/${SESSION}-${ISSUE}-taskpacket.md"


  # Fetch current description and check if expansion is needed
  issue_json=$(linear_get_issue "$ISSUE" 2>/dev/null || echo "{}")
  current_desc=$(echo "$issue_json" | jq -r '.description // ""')


  if is_task_packet "$current_desc"; then
    log "  ✓ Has detailed task packet (skipping expansion)"
    echo "$current_desc" > "$PACKET_FILE"
  else
    log "  ⚠ Simple description detected"
    EXPANSION_NEEDED=true
    # For now, just use the raw description
    # In future: integrate /issue-writer skill
    echo "$current_desc" > "$PACKET_FILE"
  fi


  # Don't set state yet - wait until user confirms
  # Save to state ledger (for tracking)
  BRANCH="task/${SLUG}"
  WT_DIR="${WORKTREE_ROOT}/${SLUG}"
  save_task_state "$ISSUE" "$SLUG" "$BRANCH" "$WT_DIR"


  log "  ✓ $ISSUE ready"
  LAUNCH_ARGS+=("$t")
done


# Warn if expansion was needed but skipped
if [[ "$EXPANSION_NEEDED" == "true" ]]; then
  echo ""
  log_warn "Some issues need expansion. Consider running /issue-writer on them first:"
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
for t in "${TASKS[@]}"; do
  IFS='|' read -r ISSUE SLUG TITLE <<<"$t"
  ISSUES_IN_PROGRESS+=("$ISSUE")
  linear_set_state "$ISSUE" "In Progress"
  log "Set $ISSUE → In Progress"
done


# Find orchestrator script (should be in same directory as this script)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORCHESTRATOR="$SCRIPT_DIR/hokusai-orchestrator.sh"


if [[ ! -f "$ORCHESTRATOR" ]]; then
  echo "Error: hokusai-orchestrator.sh not found at $ORCHESTRATOR"
  exit 1
fi


# Call the launcher script (don't attach yet)
ORCHESTRATOR_NO_ATTACH=1 "$ORCHESTRATOR" "$SESSION" "${LAUNCH_ARGS[@]}"


# Create monitoring script that will run in tmux
MONITOR_SCRIPT="/tmp/${SESSION}-monitor.sh"
cat > "$MONITOR_SCRIPT" <<'MONITOR_EOF'
#!/opt/homebrew/bin/bash
set -euo pipefail


# Import environment from parent
SESSION="$1"
REPO_DIR="$2"
WORKTREE_ROOT="$3"
TOOLS_DIR="$4"
STATE_DIR="$5"
STATE_FILE="$6"
POLL_SECONDS="$7"
REQUIRE_CONFIRM="$8"
DRY_RUN="$9"
BASE_BRANCH="${10}"
TASKS_FILE="${11}"


# Logging
log() { echo "$(date '+%H:%M:%S') $*"; }
log_error() { echo "$(date '+%H:%M:%S') ERROR: $*" >&2; }
log_warn() { echo "$(date '+%H:%M:%S') WARN: $*" >&2; }


# Import functions
save_task_state() {
  local issue="$1" slug="$2" branch="$3" worktree="$4" pr="${5:-}"
  local tmp=$(mktemp)
  jq --arg issue "$issue" --arg slug "$slug" --arg branch "$branch" \
     --arg worktree "$worktree" --arg pr "$pr" \
     '.tasks[$issue] = {slug: $slug, branch: $branch, worktree: $worktree, pr: $pr, updated: (now | todate)}' \
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
  [[ -z "$details" ]] && return 1


  local state=$(echo "$details" | jq -r '.state')
  local base_branch=$(echo "$details" | jq -r '.baseRefName')


  [[ "$state" != "MERGED" ]] && return 1
  [[ "$base_branch" != "$BASE_BRANCH" ]] && { log_error "PR #$pr merged to wrong base: $base_branch"; return 1; }
  return 0
}


execute() {
  [[ "$DRY_RUN" == "true" ]] && { echo "[DRY-RUN] $*"; return 0; }
  "$@"
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
log "  Checking every ${POLL_SECONDS}s"
echo ""


while :; do
  all_done=true


  for ISSUE in "${!BRANCH_BY_ISSUE[@]}"; do
    [[ -n "${CLEANED[$ISSUE]:-}" ]] && continue


    BRANCH="${BRANCH_BY_ISSUE[$ISSUE]}"
    SLUG="${SLUG_BY_ISSUE[$ISSUE]}"
    PR="${PR_BY_ISSUE[$ISSUE]:-}"


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


      # Auto-cleanup if REQUIRE_CONFIRM=false
      if [[ "$REQUIRE_CONFIRM" == "true" ]]; then
        log "  → Manual cleanup required: tmux kill-window -t $SESSION:$ISSUE-$SLUG"
        # Don't auto-clean, but mark as done in Linear
        linear_set_state "$ISSUE" "Done"
        CLEANED["$ISSUE"]=1
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
    log "Run: git -C \"$REPO_DIR\" worktree prune"
    echo ""
    log "Press Ctrl+C to exit monitoring, or wait for next workflow run..."
    sleep 30
    # Loop forever - ready for next run
  fi


  sleep "$POLL_SECONDS"
done
MONITOR_EOF


chmod +x "$MONITOR_SCRIPT"


# Launch monitor in control window's first pane
log "Starting monitoring in tmux control window..."


# Write tasks to temp file to avoid quoting issues with tmux send-keys
TASKS_FILE="/tmp/${SESSION}-tasks.txt"
printf '%s\n' "${TASKS[@]}" > "$TASKS_FILE"


tmux send-keys -t "$SESSION:control.0" "clear" C-m
tmux send-keys -t "$SESSION:control.0" "$MONITOR_SCRIPT '$SESSION' '$REPO_DIR' '$WORKTREE_ROOT' '$TOOLS_DIR' '$STATE_DIR' '$STATE_FILE' '$POLL_SECONDS' '$REQUIRE_CONFIRM' '$DRY_RUN' '$BASE_BRANCH' '$TASKS_FILE'" C-m


# Now attach to the session
log "Attaching to session: $SESSION"
log "  Ctrl+B then W to switch windows"
log "  Ctrl+B then D to detach"
echo ""
sleep 1
tmux attach -t "$SESSION"
