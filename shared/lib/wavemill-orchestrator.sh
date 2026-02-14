#!/opt/homebrew/bin/bash
set -euo pipefail


# Validate dependencies
command -v tmux >/dev/null || { echo "Error: tmux is required but not installed"; exit 1; }
command -v git >/dev/null || { echo "Error: git is required but not installed"; exit 1; }
command -v npx >/dev/null || { echo "Error: npx is required but not installed"; exit 1; }
command -v jq >/dev/null || { echo "Error: jq is required but not installed"; exit 1; }




REPO_DIR="${REPO_DIR:-$PWD}"

# Load config if not already loaded by parent (wavemill-mill.sh)
if [[ -z "${_WAVEMILL_CONFIG_LOADED:-}" ]]; then
  _ORCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  source "$_ORCH_DIR/wavemill-common.sh"
  load_config "$REPO_DIR"
fi

# Positional arg overrides config for session name
SESSION="${1:-$SESSION}"
BASE_BRANCH="${BASE_BRANCH:-$(cd "$REPO_DIR" && git symbolic-ref --short HEAD)}"
LINEAR_TOOL="${LINEAR_TOOL:-${TOOLS_DIR:?TOOLS_DIR must be set}/get-issue-json.ts}"


# Validate agent command exists
command -v "$AGENT_CMD" >/dev/null || { echo "Error: Agent command '$AGENT_CMD' not found"; exit 1; }


mkdir -p "$WORKTREE_ROOT"


# Cleanup handler
trap 'echo "Session ended. Run: git -C \"$REPO_DIR\" worktree prune" >&2' EXIT


# tasks are passed as: "ISSUEID|slug|title" ...
# example:
# ./wavemill-orchestrator.sh wavemill \
#   "LIN-123|hero-cta|Improve hero CTA copy" \
#   "LIN-456|nav-a11y|Fix navbar accessibility"


shift || true
TASKS=("$@")


if [[ ${#TASKS[@]} -eq 0 ]]; then
  echo "Pass tasks as: ISSUEID|slug|title"
  exit 1
fi


# Start session if not exists
TMUX_CONF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && cd ../.. && pwd)/.tmux.conf"
tmux has-session -t "$SESSION" 2>/dev/null || tmux -f "$TMUX_CONF" new-session -d -s "$SESSION" -c "$REPO_DIR" -n control


# Control window message
tmux send-keys -t "$SESSION:control" "echo 'Control window for $SESSION'" C-m


# Create log file for failures
LOG_FILE="/tmp/${SESSION}-orchestrator.log"
echo "=== Orchestrator Log $(date) ===" > "$LOG_FILE"


# Per-task error handling (disable global exit on error for loop)
set +e
i=0
for t in "${TASKS[@]}"; do
  (
    # Re-enable exit on error for each task subprocess
    set -euo pipefail
    IFS='|' read -r ISSUE SLUG TITLE <<<"$t"
    BRANCH="task/${SLUG}"
    WT_DIR="${WORKTREE_ROOT}/${SLUG}"


    echo "==> Setting up $ISSUE: $TITLE"
    cd "$REPO_DIR"


    # Check if task packet was already created by loop script
    PACKET_FILE="/tmp/${SESSION}-${ISSUE}-taskpacket.md"
    ISSUE_DESCRIPTION=""


    if [[ -f "$PACKET_FILE" ]]; then
      # Use pre-expanded task packet
      echo "Using task packet from: $PACKET_FILE"
      ISSUE_DESCRIPTION="$(cat "$PACKET_FILE")"
    else
      # Fetch full issue details from Linear
      echo "Fetching issue details from Linear..."
      ISSUE_DATA=$(npx tsx "$LINEAR_TOOL" "$ISSUE" 2>/dev/null || echo "")
      if [[ -n "$ISSUE_DATA" ]]; then
        ISSUE_DESCRIPTION=$(echo "$ISSUE_DATA" | jq -r '.description // ""' 2>/dev/null || echo "")
      fi
    fi


    # Create worktree + branch (check for existing branch first)
    if [[ -d "$WT_DIR" ]]; then
      echo "Worktree exists: $WT_DIR (resuming)"
    else
      if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
        echo "Branch $BRANCH already exists, resuming from it"
        git worktree add "$WT_DIR" "$BRANCH"
      else
        echo "Creating new branch $BRANCH from origin/$BASE_BRANCH"
        git worktree add "$WT_DIR" -b "$BRANCH" "origin/$BASE_BRANCH"
      fi
    fi


    WIN="$ISSUE-$SLUG"
    tmux new-window -t "$SESSION" -n "$WIN" -c "$WT_DIR"


    # Build an instruction packet for the agent
    INSTR=$(cat <<'EOF_INSTR'
You are working on: TITLE_PLACEHOLDER (ISSUE_PLACEHOLDER)


Repo worktree: WTDIR_PLACEHOLDER
Branch: BRANCH_PLACEHOLDER
Base branch: BASE_BRANCH_PLACEHOLDER


DESCRIPTION_PLACEHOLDER


Goal:
- Implement the feature/fix described by the issue and title.


Success criteria:
- [ ] Implementation matches issue requirements
- [ ] UI is responsive and accessible (if applicable)
- [ ] Lint/tests pass
- [ ] No regressions in existing functionality
- [ ] PR created with clear description and linked to ISSUE_PLACEHOLDER


Process:
1. Inspect repo and find relevant code
2. Make minimal, high-quality changes
3. Run tests/lint
4. Create a PR using GitHub CLI: gh pr create --fill
5. Post back with summary of changes, commands run + results, and PR link
EOF_INSTR
)
    # Replace placeholders
    INSTR="${INSTR//TITLE_PLACEHOLDER/$TITLE}"
    INSTR="${INSTR//ISSUE_PLACEHOLDER/$ISSUE}"
    INSTR="${INSTR//WTDIR_PLACEHOLDER/$WT_DIR}"
    INSTR="${INSTR//BRANCH_PLACEHOLDER/$BRANCH}"
    INSTR="${INSTR//BASE_BRANCH_PLACEHOLDER/$BASE_BRANCH}"
    if [[ -n "$ISSUE_DESCRIPTION" ]]; then
      INSTR="${INSTR//DESCRIPTION_PLACEHOLDER/Issue Description:
$ISSUE_DESCRIPTION
}"
    else
      INSTR="${INSTR//DESCRIPTION_PLACEHOLDER/}"
    fi


    # Write instructions to temp file and use it to start agent
    INSTR_FILE="/tmp/${SESSION}-${ISSUE}-instructions.txt"
    echo "$INSTR" > "$INSTR_FILE"


    # Start agent in that window with instructions file
    if [[ "$AGENT_CMD" == "claude" ]]; then
      tmux send-keys -t "$SESSION:$WIN" "cat '$INSTR_FILE' | $AGENT_CMD" C-m
    elif [[ "$AGENT_CMD" == "codex" ]]; then
      tmux send-keys -t "$SESSION:$WIN" "$AGENT_CMD /task \"\$(cat '$INSTR_FILE')\"" C-m
    else
      # Generic approach: just start agent and paste instructions
      tmux send-keys -t "$SESSION:$WIN" "$AGENT_CMD" C-m
      sleep 0.3
      tmux set-buffer "$INSTR"
      tmux paste-buffer -t "$SESSION:$WIN"
      tmux send-keys -t "$SESSION:$WIN" C-m
    fi


    # Add delay between window launches
    sleep 0.5


    echo "✓ Task $ISSUE setup complete"
  ) || {
    echo "FAILED: $ISSUE - $TITLE" | tee -a "$LOG_FILE"
  }
  i=$((i+1))
done
set -e


# Add status dashboard panel in control window (only if not already exists)
STATUS_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/wavemill-status.sh"
PANE_COUNT=$(tmux list-panes -t "$SESSION:control" -F '#{pane_index}' | wc -l)
if [[ "$PANE_COUNT" -eq 1 ]]; then
  echo "Setting up status dashboard..."
  tmux split-window -t "$SESSION:control" -h -l 40%
  tmux send-keys -t "$SESSION:control.1" "'$STATUS_SCRIPT' '$SESSION' '$WORKTREE_ROOT' '${WAVEMILL_STATE_FILE:-}'" C-m
else
  echo "Status dashboard already exists, skipping..."
fi


echo ""
echo "✓ All tasks initialized!"
echo "Log file: $LOG_FILE"


# Only attach if not called with ORCHESTRATOR_NO_ATTACH=1
if [[ "${ORCHESTRATOR_NO_ATTACH:-}" != "1" ]]; then
  echo "Attaching to session: $SESSION"
  echo ""
  tmux select-window -t "$SESSION:control"
  tmux attach -t "$SESSION"
else
  echo "Session ready: $SESSION"
  echo ""
fi
