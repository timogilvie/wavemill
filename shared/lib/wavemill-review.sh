#!/opt/homebrew/bin/bash
set -euo pipefail

# PR Review - Interactive selection and LLM-powered code review
#
# This script:
# 1. Parses filter options (--state, --author, --branch)
# 2. Checks if PR number provided as argument
# 3. If yes, directly reviews that PR
# 4. If no, fetches PRs with filters and presents interactive selection
# 5. Calls tools/review-pr.ts to perform the review

REPO_DIR="${REPO_DIR:-$PWD}"

# Source common library and load layered config
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/wavemill-common.sh"
load_config "$REPO_DIR"

# Validate dependencies
command -v jq >/dev/null || { echo "Error: jq required (install: brew install jq)"; exit 1; }
command -v npx >/dev/null || { echo "Error: npx required (install: brew install node)"; exit 1; }
command -v gh >/dev/null || { echo "Error: gh CLI required (install: brew install gh)"; exit 1; }

# Logging
log() { echo "$(date '+%H:%M:%S') $*"; }
log_error() { echo "$(date '+%H:%M:%S') ERROR: $*" >&2; }

# Colors
CYAN=$'\033[0;36m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
RED=$'\033[0;31m'
NC=$'\033[0m' # No Color

# ============================================================================
# PR FETCHING
# ============================================================================

# Fetch PRs using list-prs tool with filters
fetch_prs() {
  local state="${1:-open}"
  local author="${2:-}"
  local branch="${3:-}"

  # Determine list-prs tool path (use local if exists, otherwise use TOOLS_DIR)
  local list_prs_tool="$TOOLS_DIR/list-prs.ts"
  if [[ -f "$REPO_DIR/tools/list-prs.ts" ]]; then
    list_prs_tool="$REPO_DIR/tools/list-prs.ts"
  fi

  local args=("$list_prs_tool" "--state" "$state")

  if [[ -n "$author" ]]; then
    args+=("--author" "$author")
  fi

  if [[ -n "$branch" ]]; then
    args+=("--branch" "$branch")
  fi

  npx tsx "${args[@]}" 2>/dev/null || echo "[]"
}

# ============================================================================
# MAIN WORKFLOW
# ============================================================================

main() {
  # Check for --stats subcommand first
  if [[ "$1" == "--stats" ]]; then
    shift
    local stats_tool="$TOOLS_DIR/review-stats.ts"
    if [[ -f "$REPO_DIR/tools/review-stats.ts" ]]; then
      stats_tool="$REPO_DIR/tools/review-stats.ts"
    fi
    exec npx tsx "$stats_tool" "$@"
  fi

  # Default filter values
  local state="open"
  local author=""
  local branch=""
  local pr_number=""

  # Parse arguments
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --state)
        state="$2"
        shift 2
        ;;
      --author)
        author="$2"
        shift 2
        ;;
      --branch)
        branch="$2"
        shift 2
        ;;
      [0-9]*)
        pr_number="$1"
        shift
        ;;
      *)
        shift
        ;;
    esac
  done

  # Validate state value
  if [[ "$state" != "open" ]] && [[ "$state" != "closed" ]] && [[ "$state" != "all" ]]; then
    log_error "Invalid state: $state (must be one of: open, closed, all)"
    exit 1
  fi

  # Determine review tool path (use local if exists, otherwise use TOOLS_DIR)
  local review_tool="$TOOLS_DIR/review-pr.ts"
  if [[ -f "$REPO_DIR/tools/review-pr.ts" ]]; then
    review_tool="$REPO_DIR/tools/review-pr.ts"
  fi

  # If PR number provided, skip selection
  if [[ -n "$pr_number" ]]; then
    if ! [[ "$pr_number" =~ ^[0-9]+$ ]]; then
      log_error "Invalid PR number: $pr_number (must be a number)"
      exit 1
    fi

    log "Reviewing PR #$pr_number..."
    exec npx tsx "$review_tool" "$pr_number"
  fi

  # Interactive selection
  log "PR Review - Select a pull request to review"
  echo ""

  # Display active filters
  if [[ "$state" != "open" ]] || [[ -n "$author" ]] || [[ -n "$branch" ]]; then
    echo "${CYAN}Active filters:${NC}"
    [[ "$state" != "open" ]] && echo "  State: $state"
    [[ -n "$author" ]] && echo "  Author: $author"
    [[ -n "$branch" ]] && echo "  Branch: $branch"
    echo ""
  fi

  # Fetch PRs with filters
  log "Fetching pull requests..."
  PRS=$(fetch_prs "$state" "$author" "$branch")

  if [[ -z "$PRS" ]] || [[ "$PRS" == "[]" ]]; then
    log "No pull requests found matching filters."
    exit 0
  fi

  # Count PRs
  PR_COUNT=$(echo "$PRS" | jq 'length')
  if [[ "$PR_COUNT" -eq 0 ]]; then
    log "No pull requests found matching filters."
    exit 0
  fi

  # Display PRs with count
  echo ""
  log "Found $PR_COUNT pull request(s):"
  echo ""

  # Format display based on state
  if [[ "$state" == "closed" ]] || [[ "$state" == "all" ]]; then
    # Show dates for closed/merged PRs
    echo "$PRS" | jq -r '
      to_entries[] |
      "\(.key + 1). #\(.value.number) - \(.value.title) (by \(.value.author)) [\(.value.state)] \(
        if .value.mergedAt then "merged " + (.value.mergedAt | split("T")[0])
        elif .value.closedAt then "closed " + (.value.closedAt | split("T")[0])
        else ""
        end
      )"
    '
  else
    # Standard display for open PRs
    echo "$PRS" | jq -r '
      to_entries[] |
      "\(.key + 1). #\(.value.number) - \(.value.title) (by \(.value.author))"
    '
  fi

  echo ""

  # Prompt for selection
  echo "Enter PR number to review, or press Enter to cancel:"
  read -r SELECTED_PR

  # Check for cancellation
  if [[ -z "$SELECTED_PR" ]]; then
    log "No PR selected. Exiting."
    exit 0
  fi

  # Validate selection is a number
  if ! [[ "$SELECTED_PR" =~ ^[0-9]+$ ]]; then
    log_error "Invalid input: must be a PR number (e.g., 42)"
    exit 1
  fi

  # Review the selected PR
  echo ""
  log "Reviewing PR #$SELECTED_PR..."
  exec npx tsx "$review_tool" "$SELECTED_PR"
}

main "$@"
