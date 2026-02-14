#!/opt/homebrew/bin/bash
# Wavemill Common Library
# Shared functions used across wavemill-mill.sh and wavemill-expand.sh

# ============================================================================
# LAYERED CONFIGURATION LOADING
# ============================================================================

# Hardcoded defaults (ultimate fallbacks)
_WAVEMILL_DEFAULTS='{
  "linear": { "project": "" },
  "mill": {
    "session": "wavemill",
    "maxParallel": 3,
    "pollSeconds": 10,
    "baseBranch": "main",
    "worktreeRoot": "../worktrees",
    "agentCmd": "claude",
    "requireConfirm": true,
    "maxRetries": 3,
    "retryDelay": 2
  },
  "expand": {
    "maxSelect": 3,
    "maxDisplay": 9
  },
  "plan": {
    "maxDisplay": 9
  }
}'

# Load layered config: defaults < ~/.wavemill/config.json < .wavemill-config.json < env vars
#
# Resolution order (later wins):
#   1. Hardcoded defaults (_WAVEMILL_DEFAULTS)
#   2. User-level config (~/.wavemill/config.json)
#   3. Per-repo config (.wavemill-config.json)
#   4. Environment variables (always win)
#
# Sets: SESSION, MAX_PARALLEL, POLL_SECONDS, BASE_BRANCH, WORKTREE_ROOT,
#        AGENT_CMD, REQUIRE_CONFIRM, MAX_RETRIES, RETRY_DELAY,
#        PROJECT_NAME, MAX_SELECT, MAX_DISPLAY
#
# Args: $1 = repo directory (default: $PWD)
load_config() {
  local repo_dir="${1:-$PWD}"
  local user_config="$HOME/.wavemill/config.json"
  local repo_config="$repo_dir/.wavemill-config.json"

  # Read config files (empty object if missing)
  local user_json='{}'
  local repo_json='{}'
  if [[ -f "$user_config" ]]; then
    user_json=$(cat "$user_config") || user_json='{}'
  fi
  if [[ -f "$repo_config" ]]; then
    repo_json=$(cat "$repo_config") || repo_json='{}'
  fi

  # Single jq call: deep-merge all layers, emit shell-safe variable assignments
  local shell_vars
  shell_vars=$(jq -n -r \
    --argjson defaults "$_WAVEMILL_DEFAULTS" \
    --argjson user "$user_json" \
    --argjson repo "$repo_json" \
    '
    ($defaults * $user * $repo) as $c |
    [
      "_CFG_PROJECT=\($c.linear.project // "" | @sh)",
      "_CFG_SESSION=\($c.mill.session | @sh)",
      "_CFG_MAX_PARALLEL=\($c.mill.maxParallel)",
      "_CFG_POLL_SECONDS=\($c.mill.pollSeconds)",
      "_CFG_BASE_BRANCH=\($c.mill.baseBranch | @sh)",
      "_CFG_WORKTREE_ROOT=\($c.mill.worktreeRoot | @sh)",
      "_CFG_AGENT_CMD=\($c.mill.agentCmd | @sh)",
      "_CFG_REQUIRE_CONFIRM=\($c.mill.requireConfirm)",
      "_CFG_MAX_RETRIES=\($c.mill.maxRetries)",
      "_CFG_RETRY_DELAY=\($c.mill.retryDelay)",
      "_CFG_MAX_SELECT=\($c.expand.maxSelect)",
      "_CFG_MAX_DISPLAY=\($c.expand.maxDisplay)",
      "_CFG_PLAN_MAX_DISPLAY=\($c.plan.maxDisplay)"
    ] | .[]
    '
  ) || {
    echo "Error: Failed to parse config files. Check JSON syntax in:" >&2
    [[ -f "$user_config" ]] && echo "  $user_config" >&2
    [[ -f "$repo_config" ]] && echo "  $repo_config" >&2
    exit 1
  }

  eval "$shell_vars"

  # Apply env var overrides (env > repo config > user config > defaults)
  PROJECT_NAME="${PROJECT_NAME:-$_CFG_PROJECT}"
  SESSION="${SESSION:-$_CFG_SESSION}"
  MAX_PARALLEL="${MAX_PARALLEL:-$_CFG_MAX_PARALLEL}"
  POLL_SECONDS="${POLL_SECONDS:-$_CFG_POLL_SECONDS}"
  BASE_BRANCH="${BASE_BRANCH:-$_CFG_BASE_BRANCH}"
  AGENT_CMD="${AGENT_CMD:-$_CFG_AGENT_CMD}"
  REQUIRE_CONFIRM="${REQUIRE_CONFIRM:-$_CFG_REQUIRE_CONFIRM}"
  MAX_RETRIES="${MAX_RETRIES:-$_CFG_MAX_RETRIES}"
  RETRY_DELAY="${RETRY_DELAY:-$_CFG_RETRY_DELAY}"
  MAX_SELECT="${MAX_SELECT:-$_CFG_MAX_SELECT}"
  MAX_DISPLAY="${MAX_DISPLAY:-$_CFG_MAX_DISPLAY}"
  PLAN_MAX_DISPLAY="${PLAN_MAX_DISPLAY:-$_CFG_PLAN_MAX_DISPLAY}"

  # WORKTREE_ROOT: resolve relative paths against repo_dir
  local wt_raw="${WORKTREE_ROOT:-$_CFG_WORKTREE_ROOT}"
  if [[ "$wt_raw" != /* ]]; then
    WORKTREE_ROOT="$repo_dir/$wt_raw"
  else
    WORKTREE_ROOT="$wt_raw"
  fi

  # Export for child processes (orchestrator, monitor, agents)
  export SESSION MAX_PARALLEL POLL_SECONDS BASE_BRANCH WORKTREE_ROOT
  export AGENT_CMD REQUIRE_CONFIRM MAX_RETRIES RETRY_DELAY
  export PROJECT_NAME MAX_SELECT MAX_DISPLAY PLAN_MAX_DISPLAY

  # Clean up temp variables
  unset _CFG_PROJECT _CFG_SESSION _CFG_MAX_PARALLEL _CFG_POLL_SECONDS
  unset _CFG_BASE_BRANCH _CFG_WORKTREE_ROOT _CFG_AGENT_CMD _CFG_REQUIRE_CONFIRM
  unset _CFG_MAX_RETRIES _CFG_RETRY_DELAY _CFG_MAX_SELECT _CFG_MAX_DISPLAY
  unset _CFG_PLAN_MAX_DISPLAY

  # Sentinel so downstream scripts can skip re-loading
  _WAVEMILL_CONFIG_LOADED=1
}

# Backwards-compatible wrapper for callers that haven't migrated to load_config()
detect_project_name() {
  local repo_dir="${1:-$PWD}"

  # If load_config() already ran, PROJECT_NAME is set
  if [[ -n "${PROJECT_NAME:-}" ]]; then
    echo "$PROJECT_NAME"
    return
  fi

  # Legacy fallback
  local project_name=""
  if [[ -f "$repo_dir/.wavemill-config.json" ]]; then
    project_name=$(jq -r '.linear.project // empty' "$repo_dir/.wavemill-config.json" 2>/dev/null)
  fi
  if [[ -z "$project_name" ]]; then
    project_name="${PROJECT_NAME:-}"
  fi
  echo "$project_name"
}

# ============================================================================
# TASK PACKET DETECTION
# ============================================================================

# Check if issue description is already a detailed task packet
is_task_packet() {
  local description="$1"
  # Check for common task packet markers (h2 or h3 level)
  echo "$description" | grep -qE "(##+ (1\\.|Objective)|##+ What|##+ Technical Context|##+ Success Criteria|## Task Packet)"
}

# ============================================================================
# PRIORITY SCORING ALGORITHM
# ============================================================================

# Calculate priority score for a list of issues (JSON input)
# Returns: identifier|slug|title|area|score
score_and_rank_issues() {
  local backlog_json="$1"
  local show_limit="${2:-9}"

  echo "$backlog_json" | jq -r --argjson show_limit "$show_limit" '
    # Filter to backlog/todo only
    map(select((.state.name|ascii_downcase) == "todo" or (.state.name|ascii_downcase) == "backlog"))

    # Enrich each task with scoring factors
    | map(. + {
        # Extract area for conflict detection
        area: (
          (.labels.nodes // [])
          | map(.name)
          | map(select(test("^(Area|Component|Page|Route):")))
          | .[0] // ""
        ),

        # Check if task has detailed description (task packet)
        has_detailed_plan: (
          .description // ""
          | test("##+ (1\\.|Objective|What|Technical Context|Success Criteria|Implementation)")
        ),

        # Check for foundational labels
        is_foundational: (
          (.labels.nodes // [])
          | map(.name | ascii_downcase)
          | any(test("foundational|architecture|epic|infrastructure"))
        ),

        # Count how many issues this blocks (foundational work)
        blocks_count: (
          (.relations.nodes // [])
          | map(select(.type == "blocks"))
          | length
        ),

        # Count how many issues block this (dependency risk)
        blocked_by_count: (
          (.relations.nodes // [])
          | map(select(.type == "blocked"))
          | length
        )
      })

    # Calculate composite priority score (higher = higher priority)
    | map(. + {
        score: (
          # Base: Baseline for all items (prevents negative scores)
          20

          # Linear priority (1=urgent, 0=none, 4=low)
          + (if .priority > 0 then (5 - .priority) * 20 else 0 end)

          # Boost: Has detailed task packet (+30 points)
          + (if .has_detailed_plan then 30 else 0 end)

          # Boost: Foundational/architecture work (+25 points)
          + (if .is_foundational then 25 else 0 end)

          # Boost: Blocks other work (+10 per blocked issue)
          + (.blocks_count * 10)

          # Boost: Unblocked work is ready to go (+15 points)
          + (if .blocked_by_count == 0 then 15 else 0 end)

          # Penalty: Blocked by other work (-20 per blocker, harder penalty)
          - (.blocked_by_count * 20)

          # Penalty: Large estimates (prefer smaller, deliverable work)
          - ((.estimate // 3) * 2)
        )
      })

    # Sort by score descending (higher score = higher priority)
    | sort_by(-.score)

    # Take top candidates for display
    | .[0:$show_limit]
    | .[]
    | "\(.identifier)|\(.title|ascii_downcase|gsub("[^a-z0-9]+";"-"))|\(.title)|\(.area)|\(.score)|\(.has_detailed_plan)"
  '
}

# ============================================================================
# ISSUE EXPANSION
# ============================================================================

# Expand issue with expand-issue.ts if available
# Args: issue_id, output_file, [--update flag to save to Linear]
expand_issue_with_tool() {
  local issue_id="$1"
  local out_file="$2"
  local update_flag="${3:-}"
  local tools_dir="${TOOLS_DIR:?TOOLS_DIR must be set}"

  if [[ ! -f "$tools_dir/expand-issue.ts" ]]; then
    return 1
  fi

  # Build command with optional --update flag
  local cmd_args=("$tools_dir/expand-issue.ts" "$issue_id" "--output" "$out_file")
  if [[ "$update_flag" == "--update" ]]; then
    cmd_args+=("--update")
  fi

  # Run with real-time output using process substitution
  local log_file="/tmp/expand-issue-${issue_id}.log"

  # Show command being run
  echo "  Running: npx tsx expand-issue.ts $issue_id --output ... ${update_flag}" >&2

  # Use tee to show output in real-time AND capture to log file
  if npx tsx "${cmd_args[@]}" 2>&1 | tee "$log_file"; then
    return 0
  else
    # Print error summary
    echo "" >&2
    echo "Error expanding issue $issue_id (exit code: $?)" >&2
    echo "Full log saved to: $log_file" >&2
    return 1
  fi
}

# For backwards compatibility with wavemill-mill.sh
# Fetches current description and checks if expansion is needed
# If needed, calls expand_issue_with_tool
write_task_packet() {
  local issue_id="$1"
  local out_file="$2"
  local tools_dir="${TOOLS_DIR:?TOOLS_DIR must be set}"

  # Fetch current description (strip dotenv stdout noise before parsing JSON)
  local issue_json=$(npx tsx "$tools_dir/get-issue-json.ts" "$issue_id" 2>/dev/null | sed '/^\[dotenv/d' || echo "{}")
  local current_desc=$(echo "$issue_json" | jq -r '.description // ""')

  # Check if already a task packet
  if is_task_packet "$current_desc"; then
    echo "$current_desc" > "$out_file"
    return 0
  fi

  # Try to expand (with --update flag for backwards compatibility with wavemill-mill)
  if expand_issue_with_tool "$issue_id" "$out_file" "--update"; then
    return 0
  else
    # Fallback: just use the raw description
    echo "$current_desc" > "$out_file"
    return 1
  fi
}
