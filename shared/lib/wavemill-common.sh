#!/opt/homebrew/bin/bash
# Wavemill Common Library
# Shared functions used across wavemill-mill.sh and issue-expander.sh

# ============================================================================
# PROJECT NAME DETECTION
# ============================================================================

# Auto-detect project name from repo-specific config or environment
detect_project_name() {
  local repo_dir="${1:-$PWD}"
  local project_name=""

  # Try repo-specific config first
  if [[ -f "$repo_dir/.wavemill-config.json" ]]; then
    project_name=$(jq -r '.linear.project // empty' "$repo_dir/.wavemill-config.json" 2>/dev/null)
  fi

  # Fallback to environment variable
  if [[ -z "$project_name" ]]; then
    project_name="${PROJECT_NAME:-}"
  fi

  # Final fallback
  if [[ -z "$project_name" ]]; then
    project_name="Hokusai public website"
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
          | test("##+ (1\\\\.|Objective|What|Technical Context|Success Criteria|Implementation)")
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
  local tools_dir="${TOOLS_DIR:-$HOME/.claude/tools}"

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
  local tools_dir="${TOOLS_DIR:-$HOME/.claude/tools}"

  # Fetch current description
  local issue_json=$(npx tsx "$tools_dir/get-issue-json.ts" "$issue_id" 2>/dev/null || echo "{}")
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

# ============================================================================
# LABEL EXTRACTION
# ============================================================================

# Extract suggested labels from expanded issue description
# Looks for the "Label Summary" section with format:
# Suggested labels for this task:
# - Label: Value
# - Label: Value
extract_labels_from_description() {
  local description="$1"

  # Extract labels from the code block format
  # Match lines like: "- Risk: Medium" or "- Area: Landing"
  echo "$description" | \
    awk '/Suggested labels for this task:/,/```/' | \
    grep -E '^[[:space:]]*-[[:space:]]+[^:]+:[[:space:]]*' | \
    sed 's/^[[:space:]]*-[[:space:]]*//' | \
    sed 's/:[[:space:]]*/: /' | \
    awk -F': ' '{
      # For labels like "Risk: Medium", output "Risk: Medium"
      # For labels like "Files: path1, path2", split by comma and output each
      label=$1
      value=$2
      if (index(value, ",") > 0) {
        # Multiple values - output each as separate label
        split(value, vals, ",")
        for (i in vals) {
          gsub(/^[[:space:]]+|[[:space:]]+$/, "", vals[i])
          if (vals[i] != "") print label ": " vals[i]
        }
      } else {
        # Single value
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
        if (value != "") print label ": " value
      }
    }'
}
