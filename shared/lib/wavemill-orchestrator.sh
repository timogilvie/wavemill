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

# Load agent adapter functions
_ORCH_DIR="${_ORCH_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
source "$_ORCH_DIR/agent-adapters.sh"

# Positional arg overrides config for session name
SESSION="${1:-$SESSION}"
BASE_BRANCH="${BASE_BRANCH:-$(cd "$REPO_DIR" && git symbolic-ref --short HEAD)}"
LINEAR_TOOL="${LINEAR_TOOL:-${TOOLS_DIR:?TOOLS_DIR must be set}/get-issue-json.ts}"


# Validate agent command exists
agent_validate "$AGENT_CMD" || { echo "Error: Agent command '$AGENT_CMD' not found"; exit 1; }


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


    # Load model suggestion if available
    MODEL_SUGGESTION_FILE="/tmp/${SESSION}-${ISSUE}-model-suggestion.json"
    MODEL_HINT=""
    if [[ -f "$MODEL_SUGGESTION_FILE" ]]; then
      RECOMMENDED_MODEL=$(jq -r '.recommendedModel // empty' "$MODEL_SUGGESTION_FILE" 2>/dev/null)
      MODEL_CONFIDENCE=$(jq -r '.confidence // empty' "$MODEL_SUGGESTION_FILE" 2>/dev/null)
      MODEL_TASK_TYPE=$(jq -r '.taskType // empty' "$MODEL_SUGGESTION_FILE" 2>/dev/null)
      MODEL_REASONING=$(jq -r '.reasoning // empty' "$MODEL_SUGGESTION_FILE" 2>/dev/null)
      MODEL_INSUFFICIENT=$(jq -r '.insufficientData // false' "$MODEL_SUGGESTION_FILE" 2>/dev/null)

      if [[ "$MODEL_INSUFFICIENT" != "true" && -n "$RECOMMENDED_MODEL" ]]; then
        MODEL_HINT="Model recommendation: ${RECOMMENDED_MODEL} (confidence: ${MODEL_CONFIDENCE}, task type: ${MODEL_TASK_TYPE})"
        echo "Model suggestion: $RECOMMENDED_MODEL (confidence: $MODEL_CONFIDENCE)"
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


    # Pre-trust worktree directory so Claude doesn't prompt
    pretrust_directory "$WT_DIR"

    WIN="$ISSUE-$SLUG"
    tmux new-window -t "$SESSION" -n "$WIN" -c "$WT_DIR"


    # ── Agent launch (planning vs skip mode) ──────────────────────────────

    if [[ "${PLANNING_MODE:-skip}" == "interactive" ]]; then
      # ── Interactive planning mode ─────────────────────────────────────
      # Launch agent interactively so the user can guide the planning
      # phase from the tmux window before implementation begins.

      # Pre-seed selected-task.json for the /create-plan workflow
      FEATURE_DIR="$WT_DIR/features/$SLUG"
      mkdir -p "$FEATURE_DIR"
      TASK_JSON="$FEATURE_DIR/selected-task.json"

      # Build issue labels array from issue JSON (if available)
      ISSUE_JSON_FILE="/tmp/${SESSION}-${ISSUE}-issue.json"
      LABELS_JSON="[]"
      if [[ -f "$ISSUE_JSON_FILE" ]]; then
        LABELS_JSON=$(jq '[.labels.nodes[]?.name // empty]' "$ISSUE_JSON_FILE" 2>/dev/null || echo "[]")
      fi

      # Write selected-task.json
      jq -n \
        --arg taskId "$ISSUE" \
        --arg title "$TITLE" \
        --arg description "$ISSUE_DESCRIPTION" \
        --argjson labels "$LABELS_JSON" \
        --arg featureName "$SLUG" \
        --arg contextPath "features/$SLUG/selected-task.json" \
        '{
          taskId: $taskId,
          title: $title,
          description: $description,
          labels: $labels,
          workflowType: "feature",
          featureName: $featureName,
          contextPath: $contextPath,
          selectedAt: (now | todate)
        }' > "$TASK_JSON"

      # Build the planning prompt
      PLAN_PROMPT=$(cat <<EOF_PLAN
You are working on: $TITLE ($ISSUE)

Repo worktree: $WT_DIR
Branch: $BRANCH
Base branch: $BASE_BRANCH

${ISSUE_DESCRIPTION:+Issue Description:
$ISSUE_DESCRIPTION
}
${MODEL_HINT:+$MODEL_HINT
}
---

## Your Workflow

You have TWO phases. Do them in order.

### Phase 1: Planning (interactive)
Task context is pre-seeded at: features/$SLUG/selected-task.json

1. Read the task context
2. Research the codebase to understand relevant code and patterns
3. Create a detailed implementation plan with phases
4. Save the plan to: features/$SLUG/plan.md
5. Present the plan summary to the user and wait for approval
6. After approval, create a file: features/$SLUG/.plan-approved

Do NOT proceed to Phase 2 until the user has approved the plan.

### Phase 2: Implementation
After plan approval:
1. Execute the plan phase by phase
2. Run tests/lint between phases — pause if anything fails
3. Create a PR using GitHub CLI: gh pr create --fill
4. Link the PR to $ISSUE

Success criteria:
- [ ] Implementation matches plan and issue requirements
- [ ] Lint/tests pass
- [ ] No regressions
- [ ] PR created with clear description linked to $ISSUE

Start with Phase 1 now. Read the task context and begin researching.
EOF_PLAN
)

      # Write prompt to file and create a launcher script
      PROMPT_FILE="/tmp/${SESSION}-${ISSUE}-plan-prompt.txt"
      echo "$PLAN_PROMPT" > "$PROMPT_FILE"

      # Launch agent interactively via adapter
      agent_launch_interactive "$SESSION" "$WIN" "$PROMPT_FILE" "$AGENT_CMD"

    else
      # ── Skip mode (current autonomous behavior) ───────────────────────
      # Pipe instructions to agent — no interactive planning phase.

      INSTR=$(cat <<'EOF_INSTR'
You are working on: TITLE_PLACEHOLDER (ISSUE_PLACEHOLDER)


Repo worktree: WTDIR_PLACEHOLDER
Branch: BRANCH_PLACEHOLDER
Base branch: BASE_BRANCH_PLACEHOLDER


DESCRIPTION_PLACEHOLDER

MODEL_HINT_PLACEHOLDER

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
      INSTR="${INSTR//MODEL_HINT_PLACEHOLDER/$MODEL_HINT}"

      # Write instructions to temp file and use it to start agent
      INSTR_FILE="/tmp/${SESSION}-${ISSUE}-instructions.txt"
      echo "$INSTR" > "$INSTR_FILE"

      # Start agent in that window via adapter
      agent_launch_autonomous "$SESSION" "$WIN" "$INSTR_FILE" "$AGENT_CMD"
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
