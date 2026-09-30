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

# Source common library and load layered config
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/wavemill-common.sh"
source "$SCRIPT_DIR/task-identity.sh"
load_config "$REPO_DIR"

# Validate dependencies
command -v jq >/dev/null || { echo "Error: jq required (install: brew install jq)"; exit 1; }
command -v npx >/dev/null || { echo "Error: npx required (install: brew install node)"; exit 1; }

# Logging
log() { local m="$*"; m="${m#"${m%%[![:space:]]*}"}"; echo "$(date '+%H:%M:%S')  $m"; }
log_error() { local m="$*"; m="${m#"${m%%[![:space:]]*}"}"; echo "$(date '+%H:%M:%S')  ERROR: $m" >&2; }
log_warn() { local m="$*"; m="${m#"${m%%[![:space:]]*}"}"; echo "$(date '+%H:%M:%S')  WARN: $m" >&2; }

canonicalize_issue_identifier() {
  local input="${1^^}"
  if [[ "$input" =~ ^(${TASK_IDENTITY_ISSUE_ID_RE})$ ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
    return 0
  fi

  local url_re="^HTTPS?://LINEAR\.APP/[^/]+/ISSUE/(${TASK_IDENTITY_ISSUE_ID_RE})([/?#].*)?$"
  if [[ "$input" =~ $url_re ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
    return 0
  fi

  return 1
}

expand_selected_issues() {
  local mode="$1"
  shift
  local selected_issues=("$@")
  local success_count=0
  local fail_count=0

  echo ""
  log "Expanding ${#selected_issues[@]} issue(s)..."
  echo ""

  for issue_line in "${selected_issues[@]}"; do
    local issue title expanded_file header_file details_file

    if [[ "$mode" == "direct" ]]; then
      issue="$issue_line"
      title="Direct issue request"
    else
      IFS='|' read -r issue _ title _ _ _ <<<"$issue_line"
    fi

    log "Processing $issue: $title"

    expanded_file="/tmp/issue-expander-${issue}.md"

    echo ""
    if expand_issue_with_tool "$issue" "$expanded_file"; then
      echo ""
      log "Expanded and updated in Linear"

      header_file="${expanded_file%.md}-header.md"
      details_file="${expanded_file%.md}-details.md"
      if [[ -f "$header_file" ]] && [[ -f "$details_file" ]]; then
        log "Header and details files generated"
      fi

      rm -f "$expanded_file" "$header_file" "$details_file"
      ((++success_count))
    else
      log_error "  ✗ Expansion failed for $issue (see /tmp/expand-issue-${issue}.log)"
      ((++fail_count))
    fi

    echo ""
  done

  log "Expansion complete!"
  log "  Success: $success_count"
  if [[ $fail_count -gt 0 ]]; then
    log "  Failed: $fail_count"
  fi

  if [[ "$mode" == "direct" ]] && [[ $fail_count -gt 0 ]]; then
    return 1
  fi

  return 0
}

is_expand_quit_selection() {
  local input="$1"

  # Trim only the outer whitespace so mixed-token input stays non-quit.
  input="${input#"${input%%[![:space:]]*}"}"
  input="${input%"${input##*[![:space:]]}"}"

  [[ "$input" == "q" || "$input" == "Q" ]]
}

# ============================================================================
# LINEAR API HELPERS (read-only; writes go through expand-issue.ts)
# ============================================================================

linear_list_backlog() {
  local project_name="$1"
  # Capture stdout (JSON); collect stderr so we can show it on failure
  local stderr_file
  stderr_file=$(mktemp)
  if npx tsx "$TOOLS_DIR/list-backlog-json.ts" "$project_name" 2>"$stderr_file"; then
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
  local issue_id="$1"
  # Capture stdout (JSON); collect stderr so we can show it on failure
  local stderr_file
  stderr_file=$(mktemp)
  if npx tsx "$TOOLS_DIR/get-issue.ts" "$issue_id" --json 2>"$stderr_file"; then
    rm -f "$stderr_file"
  else
    local rc=$?
    log_error "Issue fetch failed for $issue_id. stderr:"
    cat "$stderr_file" >&2
    rm -f "$stderr_file"
    return "$rc"
  fi
}


# ============================================================================
# MAIN WORKFLOW
# ============================================================================

main() {
  local direct_args=("$@")
  log "Issue Expander - Batch expand Linear issues"
  echo ""

  log "Repository: $REPO_DIR"
  if [[ -n "$PROJECT_NAME" ]]; then
    log "Project: $PROJECT_NAME"
  else
    log "Project: (all projects)"
  fi
  echo ""

  if [[ $# -gt 0 ]]; then
    local requested_issues=()
    local invalid_inputs=()
    local input canonical_issue

    for input in "${direct_args[@]}"; do
      if canonical_issue=$(canonicalize_issue_identifier "$input"); then
        requested_issues+=("$canonical_issue")
      else
        invalid_inputs+=("$input")
      fi
    done

    if [[ ${#invalid_inputs[@]} -gt 0 ]]; then
      log_error "Invalid issue identifiers: ${invalid_inputs[*]}"
      log_error "Expected each argument to be TEAM-123 or a Linear issue URL"
      exit 1
    fi

    log "Direct issue expansion: ${requested_issues[*]}"
    expand_selected_issues "direct" "${requested_issues[@]}"
    return $?
  fi

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

  if is_expand_quit_selection "$SELECTED"; then
    log "Quit. No issues expanded."
    exit 0
  fi

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

  expand_selected_issues "interactive" "${SELECTED_ISSUES[@]}"
}

main "$@"
