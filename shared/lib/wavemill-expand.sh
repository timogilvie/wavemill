#!/opt/homebrew/bin/bash
set -euo pipefail

# Issue Expander - Batch expand Linear issues with priority ranking
#
# This script:
# 1. Fetches the Linear backlog for the current repo
# 2. Identifies issues without detailed task packets
# 3. Ranks them by priority score (same algorithm as hokusai-loop)
# 4. Presents up to 9 candidates to the user
# 5. Allows selection of up to 3 issues
# 6. Expands selected issues with detailed descriptions
# 7. Auto-labels and updates them in Linear

REPO_DIR="${REPO_DIR:-$PWD}"
TOOLS_DIR="${TOOLS_DIR:-$HOME/.claude/tools}"
MAX_SELECT="${MAX_SELECT:-3}"
MAX_DISPLAY="${MAX_DISPLAY:-9}"

# Source common library
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/wavemill-common.sh"

# Validate dependencies
command -v jq >/dev/null || { echo "Error: jq required (install: brew install jq)"; exit 1; }
command -v npx >/dev/null || { echo "Error: npx required (install: brew install node)"; exit 1; }

# Logging
log() { echo "$(date '+%H:%M:%S') $*"; }
log_error() { echo "$(date '+%H:%M:%S') ERROR: $*" >&2; }
log_warn() { echo "$(date '+%H:%M:%S') WARN: $*" >&2; }

# ============================================================================
# LINEAR API HELPERS
# ============================================================================

linear_list_backlog() {
  local project_name="$1"
  # Filter out dotenv and other informational messages, keep only JSON
  npx tsx "$TOOLS_DIR/list-backlog-json.ts" "$project_name" 2>&1 | sed '/^\[dotenv/d' | sed '/^[[:space:]]*$/d'
}

linear_get_issue() {
  local issue_id="$1"
  npx tsx "$TOOLS_DIR/get-issue-json.ts" "$issue_id" 2>&1 | sed '/^\[dotenv/d' | sed '/^$/d'
}

linear_update_description() {
  local issue_id="$1"
  local file="$2"
  npx tsx "$TOOLS_DIR/update-issue.ts" "$issue_id" --file "$file" >/dev/null 2>&1
}

linear_add_label() {
  local issue_id="$1"
  local label="$2"
  npx tsx "$TOOLS_DIR/add-issue-label.ts" "$issue_id" "$label" >/dev/null 2>&1
}

# ============================================================================
# MAIN WORKFLOW
# ============================================================================

main() {
  log "Issue Expander - Batch expand Linear issues"
  echo ""

  # Detect project name
  PROJECT_NAME=$(detect_project_name "$REPO_DIR")
  log "Repository: $REPO_DIR"
  log "Project: $PROJECT_NAME"
  echo ""

  # Fetch backlog
  log "Fetching backlog from Linear..."
  BACKLOG=$(linear_list_backlog "$PROJECT_NAME")

  if [[ -z "$BACKLOG" ]] || [[ "$BACKLOG" == "[]" ]]; then
    log "No backlog issues found."
    exit 0
  fi

  # Score and rank issues, then filter to those without detailed plans
  log "Analyzing issues and ranking by priority..."
  CANDIDATES=$(score_and_rank_issues "$BACKLOG" 50 | awk -F'|' '$6 == "false"')

  if [[ -z "$CANDIDATES" ]]; then
    log "All backlog issues already have detailed task packets!"
    exit 0
  fi

  # Take top N for display
  DISPLAY_CANDIDATES=$(echo "$CANDIDATES" | head -n "$MAX_DISPLAY")

  echo ""
  log "Issues needing expansion (ranked by priority, showing up to $MAX_DISPLAY):"
  echo ""
  echo "$DISPLAY_CANDIDATES" | awk -F'|' '{
    printf "%s. %s - %s (score: %.0f)\n", NR, $1, $3, $5
  }'
  echo ""
  echo "Enter up to $MAX_SELECT numbers to expand (e.g. 1 3 5), or press Enter to skip:"
  read -r SELECTED

  if [[ -z "$SELECTED" ]]; then
    log "No issues selected. Exiting."
    exit 0
  fi

  # Parse selection
  SELECTED_ISSUES=()
  for num in $SELECTED; do
    # Validate number
    if ! [[ "$num" =~ ^[0-9]+$ ]] || [[ "$num" -lt 1 ]] || [[ "$num" -gt "$MAX_DISPLAY" ]]; then
      log_warn "Invalid selection: $num (must be 1-$MAX_DISPLAY)"
      continue
    fi

    # Extract issue info
    LINE=$(echo "$DISPLAY_CANDIDATES" | sed -n "${num}p")
    if [[ -n "$LINE" ]]; then
      SELECTED_ISSUES+=("$LINE")
    fi
  done

  if [[ ${#SELECTED_ISSUES[@]} -eq 0 ]]; then
    log "No valid issues selected. Exiting."
    exit 0
  fi

  # Limit to MAX_SELECT
  if [[ ${#SELECTED_ISSUES[@]} -gt $MAX_SELECT ]]; then
    log_warn "Too many selected (${#SELECTED_ISSUES[@]}), limiting to first $MAX_SELECT"
    SELECTED_ISSUES=("${SELECTED_ISSUES[@]:0:$MAX_SELECT}")
  fi

  echo ""
  log "Expanding ${#SELECTED_ISSUES[@]} issue(s)..."
  echo ""

  # Process each selected issue
  SUCCESS_COUNT=0
  FAIL_COUNT=0

  for issue_line in "${SELECTED_ISSUES[@]}"; do
    IFS='|' read -r ISSUE SLUG TITLE AREA SCORE HAS_PLAN <<<"$issue_line"

    log "Processing $ISSUE: $TITLE"

    # Create temp file for expanded description
    EXPANDED_FILE="/tmp/issue-expander-${ISSUE}.md"

    # Expand the issue (expand_issue_with_tool will show real-time progress and update Linear)
    echo ""
    if expand_issue_with_tool "$ISSUE" "$EXPANDED_FILE" "--update"; then
      echo ""
      log "  ✓ Expanded and updated in Linear"

      # Read expanded content
      if [[ -f "$EXPANDED_FILE" ]]; then
        EXPANDED_CONTENT=$(cat "$EXPANDED_FILE")

        # Extract suggested labels
        LABELS=$(extract_labels_from_description "$EXPANDED_CONTENT")

        # Add labels to Linear
        if [[ -n "$LABELS" ]]; then
          log "  → Adding labels..."
          while IFS= read -r label; do
            if [[ -n "$label" ]]; then
              # Disable exit-on-error for label addition (non-critical operation)
              set +e
              linear_add_label "$ISSUE" "$label" 2>/dev/null
              local label_result=$?
              set -e

              if [[ $label_result -eq 0 ]]; then
                log "    ✓ Added: $label"
              else
                log_warn "    ✗ Failed to add: $label (label may not exist in Linear)"
              fi
            fi
          done <<<"$LABELS"
        else
          log "  → No suggested labels found in expanded description"
        fi

        # Cleanup
        rm -f "$EXPANDED_FILE"
        ((SUCCESS_COUNT++))
      else
        log_error "  ✗ Expanded but output file not found"
        ((FAIL_COUNT++))
      fi
    else
      log_error "  ✗ Expansion failed for $ISSUE (see /tmp/expand-issue-${ISSUE}.log)"
      ((FAIL_COUNT++))
    fi

    echo ""
  done

  # Summary
  log "Expansion complete!"
  log "  Success: $SUCCESS_COUNT"
  if [[ $FAIL_COUNT -gt 0 ]]; then
    log "  Failed: $FAIL_COUNT"
  fi
}

main "$@"
