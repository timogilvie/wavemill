#!/opt/homebrew/bin/bash
set -euo pipefail

# Initiative Planner - Decompose Linear initiatives into issues
#
# This script:
# 1. Fetches Linear initiatives for the configured project
# 2. Prioritizes initiatives without existing issues
# 3. Presents up to MAX_DISPLAY candidates to the user
# 4. User selects one initiative
# 5. Calls plan-initiative.ts to decompose via Claude and create issues

REPO_DIR="${REPO_DIR:-$PWD}"

# Source common library and load layered config
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/wavemill-common.sh"
load_config "$REPO_DIR"

# Use plan-specific max display if set, otherwise fall back to expand's
PLAN_MAX_DISPLAY="${PLAN_MAX_DISPLAY:-$MAX_DISPLAY}"

# Validate dependencies
command -v jq >/dev/null || { echo "Error: jq required (install: brew install jq)"; exit 1; }
command -v npx >/dev/null || { echo "Error: npx required (install: brew install node)"; exit 1; }

# Logging
log() { echo "$(date '+%H:%M:%S') $*"; }
log_error() { echo "$(date '+%H:%M:%S') ERROR: $*" >&2; }

# ============================================================================
# MAIN WORKFLOW
# ============================================================================

main() {
  log "Initiative Planner - Decompose initiatives into issues"
  echo ""

  log "Repository: $REPO_DIR"
  if [[ -n "$PROJECT_NAME" ]]; then
    log "Project: $PROJECT_NAME"
  else
    log "Project: (all projects)"
  fi
  echo ""

  # Fetch initiatives via TypeScript tool (outputs JSON)
  log "Fetching initiatives from Linear..."

  local list_args=("$TOOLS_DIR/plan-initiative.ts" "list" "--max-display" "$PLAN_MAX_DISPLAY")
  if [[ -n "$PROJECT_NAME" ]]; then
    list_args+=("--project" "$PROJECT_NAME")
  fi

  INITIATIVES_JSON=$(npx tsx "${list_args[@]}" 2>&1 | sed '/^\[dotenv/d' | sed '/^[[:space:]]*$/d')

  if [[ -z "$INITIATIVES_JSON" ]] || [[ "$INITIATIVES_JSON" == "[]" ]]; then
    log "No initiatives found."
    exit 0
  fi

  # Count initiatives
  COUNT=$(echo "$INITIATIVES_JSON" | jq 'length')

  if [[ "$COUNT" -eq 0 ]]; then
    log "No initiatives found."
    exit 0
  fi

  echo ""
  log "Initiatives (showing up to $PLAN_MAX_DISPLAY, prioritizing those without issues):"
  echo ""
  echo "$INITIATIVES_JSON" | jq -r '
    to_entries[] |
    "\(.key + 1). \(.value.name) [\(.value.status)] (issues: \(.value.issueCount))"
  '
  echo ""
  echo "Select an initiative to decompose (1-$COUNT), or press Enter to skip:"
  read -r SELECTED

  if [[ -z "$SELECTED" ]]; then
    log "No initiative selected. Exiting."
    exit 0
  fi

  # Validate selection
  if ! [[ "$SELECTED" =~ ^[0-9]+$ ]] || [[ "$SELECTED" -lt 1 ]] || [[ "$SELECTED" -gt "$COUNT" ]]; then
    log_error "Invalid selection: $SELECTED (must be 1-$COUNT)"
    exit 1
  fi

  # Extract selected initiative
  INITIATIVE_ID=$(echo "$INITIATIVES_JSON" | jq -r ".[$((SELECTED - 1))].id")
  INITIATIVE_NAME=$(echo "$INITIATIVES_JSON" | jq -r ".[$((SELECTED - 1))].name")

  echo ""
  log "Selected: $INITIATIVE_NAME"
  echo ""

  # Confirm before proceeding
  if [[ "$REQUIRE_CONFIRM" == "true" ]]; then
    echo "This will use Claude to decompose the initiative and create issues in Linear."
    read -p "Continue? [y/N] " -n 1 -r
    echo
    [[ $REPLY =~ ^[Yy]$ ]] || exit 0
  fi

  # Check for --dry-run flag passed to this script
  local extra_args=()
  for arg in "$@"; do
    if [[ "$arg" == "--dry-run" ]]; then
      extra_args+=("--dry-run")
    fi
  done

  # Run decomposition via TypeScript tool
  log "Decomposing initiative with Claude..."
  echo ""

  local decompose_args=("$TOOLS_DIR/plan-initiative.ts" "decompose" "--initiative" "$INITIATIVE_ID")
  if [[ -n "$PROJECT_NAME" ]]; then
    decompose_args+=("--project" "$PROJECT_NAME")
  fi
  decompose_args+=("${extra_args[@]}")

  npx tsx "${decompose_args[@]}"

  echo ""
  log "Plan complete!"
}

main "$@"
