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


# Start session with a clean control window.
# Kill any stale session from a previous crashed run so we get a fresh control window.
TMUX_CONF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && cd ../.. && pwd)/.tmux.conf"
if tmux has-session -t "$SESSION" 2>/dev/null; then
  # Safety check: don't kill a session running in a different repo
  _existing_dir=$(tmux show-environment -t "$SESSION" REPO_DIR 2>/dev/null | sed 's/^REPO_DIR=//') || true
  if [[ -n "$_existing_dir" && "$_existing_dir" != "$REPO_DIR" ]]; then
    echo "ERROR: tmux session '$SESSION' is already active in: $_existing_dir" >&2
    echo "Cannot start a new session for: $REPO_DIR" >&2
    echo "" >&2
    echo "Options:" >&2
    echo "  - Stop the existing session first (tmux kill-session -t '$SESSION')" >&2
    echo "  - Use a different session name: SESSION=my-session wavemill mill" >&2
    exit 1
  fi
  # Same repo or unknown — stale session, safe to kill and recreate
  tmux kill-session -t "$SESSION" 2>/dev/null || true
fi
tmux -f "$TMUX_CONF" new-session -d -s "$SESSION" -c "$REPO_DIR" -n control
# Store REPO_DIR in tmux environment so other instances can detect cross-repo conflicts
tmux set-environment -t "$SESSION" REPO_DIR "$REPO_DIR"


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


    # Load model suggestion and select per-task agent + model
    MODEL_SUGGESTION_FILE="/tmp/${SESSION}-${ISSUE}-model-suggestion.json"
    TASK_AGENT_CMD="$AGENT_CMD"
    TASK_MODEL=""
    if [[ -n "${FORCE_MODEL:-}" ]]; then
      # FORCE_MODEL env var overrides the router entirely
      TASK_MODEL="$FORCE_MODEL"
      TASK_AGENT_CMD="$(agent_resolve_from_model "$FORCE_MODEL")"
      echo "FORCE_MODEL: $ISSUE -> $TASK_AGENT_CMD --model $TASK_MODEL"
    elif [[ "${AGENT_CMD_EXPLICIT:-}" != "true" ]] && [[ -f "$MODEL_SUGGESTION_FILE" ]]; then
      RECOMMENDED_MODEL=$(jq -r '.recommendedModel // empty' "$MODEL_SUGGESTION_FILE" 2>/dev/null)
      RECOMMENDED_AGENT=$(jq -r '.recommendedAgent // empty' "$MODEL_SUGGESTION_FILE" 2>/dev/null)
      MODEL_INSUFFICIENT=$(jq -r '.insufficientData // false' "$MODEL_SUGGESTION_FILE" 2>/dev/null)
      MODEL_CONFIDENCE=$(jq -r '.confidence // empty' "$MODEL_SUGGESTION_FILE" 2>/dev/null)

      if [[ "$MODEL_INSUFFICIENT" != "true" ]] && [[ -n "$RECOMMENDED_MODEL" ]]; then
        TASK_MODEL="$RECOMMENDED_MODEL"
        if [[ -n "$RECOMMENDED_AGENT" ]]; then
          TASK_AGENT_CMD="$RECOMMENDED_AGENT"
        fi
        echo "Router: $ISSUE -> $TASK_AGENT_CMD --model $TASK_MODEL (confidence: $MODEL_CONFIDENCE)"
      else
        echo "Router: $ISSUE -> using default agent (insufficient eval data)"
      fi
    fi

    # Validate the selected agent exists, fall back to global default if not
    if ! agent_validate "$TASK_AGENT_CMD"; then
      echo "WARN: Agent '$TASK_AGENT_CMD' not found, falling back to '$AGENT_CMD'"
      TASK_AGENT_CMD="$AGENT_CMD"
      TASK_MODEL=""
    fi

    # Check authentication only if router selected a different agent
    if [[ "$TASK_AGENT_CMD" != "$AGENT_CMD" ]] && ! agent_check_auth "$TASK_AGENT_CMD"; then
      echo "Error: Agent '$TASK_AGENT_CMD' not authenticated for task $ISSUE" >&2
      exit 1
    fi

    # Override AGENT_CMD for pretrust_directory and other functions in this subshell
    AGENT_CMD="$TASK_AGENT_CMD"

    # Persist resolved agent to state file so monitor/eval uses the correct agent
    if [[ -n "${WAVEMILL_STATE_FILE:-}" ]] && [[ -f "$WAVEMILL_STATE_FILE" ]]; then
      _tmp=$(mktemp) || true
      if [[ -n "${_tmp:-}" ]] && jq --arg issue "$ISSUE" --arg agent "$TASK_AGENT_CMD" \
         'if .tasks[$issue] then .tasks[$issue].agent = $agent else . end' \
         "$WAVEMILL_STATE_FILE" > "$_tmp" 2>/dev/null; then
        mv "$_tmp" "$WAVEMILL_STATE_FILE"
      else
        rm -f "${_tmp:-}"
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

    # Codex does not reliably trigger bell flags for input-required turns.
    # Make codex attention states red by overriding activity style per-window.
    if [[ "$TASK_AGENT_CMD" == "codex" ]]; then
      tmux set-window-option -t "$SESSION:$WIN" window-status-activity-style bg=red,fg=white,bold >/dev/null 2>&1 || true
    fi


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
---

## Status Reporting
Throughout your work, periodically update your status by running:
  echo '<short description of what you are doing right now>' > /tmp/${SESSION}-${ISSUE}-status.txt
Keep it under 50 chars. Update it at each major step (e.g. "reading codebase", "implementing auth handler", "running tests", "creating PR"). This feeds the Wavemill dashboard so the user can see your progress.

## Your Workflow

You have THREE phases. Do them in order.

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
3. Create a PR using GitHub CLI with a descriptive title and body:
   gh pr create --title "$ISSUE: <concise summary>" --body "<PR body>"
   The PR body MUST include:
   - A "## Summary" section with 2-4 bullet points describing what changed and why
   - A "## Changes" section listing the key files/modules modified
   - A "## Test plan" section describing how the changes were validated
   Do NOT use --fill. Write the PR body as a HEREDOC if needed for formatting.
4. Link the PR to $ISSUE

Success criteria:
- [ ] Implementation matches plan and issue requirements
- [ ] Lint/tests pass
- [ ] No regressions
- [ ] PR created with descriptive summary linked to $ISSUE

### Phase 3: Review & Respond
After creating the PR:
1. Present a brief summary of what was implemented and any decisions you made
2. Remain available — the user may have questions, want changes, or need you to address CI failures
3. If asked to make changes, push them to the same branch to update the PR
4. Do NOT exit until the user confirms they are done

Start with Phase 1 now. Read the task context and begin researching.
EOF_PLAN
)

      # Write prompt to file and create a launcher script
      PROMPT_FILE="/tmp/${SESSION}-${ISSUE}-plan-prompt.txt"
      echo "$PLAN_PROMPT" > "$PROMPT_FILE"

      # Launch agent interactively via adapter
      agent_launch_interactive "$SESSION" "$WIN" "$PROMPT_FILE" "$TASK_AGENT_CMD" "$TASK_MODEL"

    else
      # ── Skip mode (current autonomous behavior) ───────────────────────
      # Pipe instructions to agent — no interactive planning phase.

      INSTR=$(cat <<'EOF_INSTR'
You are working on: TITLE_PLACEHOLDER (ISSUE_PLACEHOLDER)


Repo worktree: WTDIR_PLACEHOLDER
Branch: BRANCH_PLACEHOLDER
Base branch: BASE_BRANCH_PLACEHOLDER


DESCRIPTION_PLACEHOLDER

Goal:
- Implement the feature/fix described by the issue and title.

IMPORTANT: You are running autonomously with NO user interaction.
- Do NOT ask questions or request user input — make your best judgment call.
- If a decision is ambiguous, choose the most reasonable default and document your choice in the PR description.
- If you truly cannot proceed without clarification, note the blocker in the PR description and implement what you can.

Status Reporting:
Throughout your work, periodically update your status by running:
  echo '<short description of what you are doing right now>' > STATUS_FILE_PLACEHOLDER
Keep it under 50 chars. Update it at each major step (e.g. "reading codebase", "implementing auth handler", "running tests", "creating PR"). This feeds the Wavemill dashboard so the user can see your progress.


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
4. Create a PR using GitHub CLI with a descriptive title and body:
   gh pr create --title "ISSUE_PLACEHOLDER: <concise summary of changes>" --body "<PR body>"
   The PR body MUST include:
   - A "## Summary" section with 2-4 bullet points describing what changed and why
   - A "## Changes" section listing the key files/modules modified
   - A "## Test plan" section describing how the changes were validated
   Do NOT use --fill. Write the PR body as a HEREDOC if needed for formatting.
5. Post back with summary of changes, commands run + results, and PR link
EOF_INSTR
)
      # Replace placeholders
      INSTR="${INSTR//TITLE_PLACEHOLDER/$TITLE}"
      INSTR="${INSTR//ISSUE_PLACEHOLDER/$ISSUE}"
      INSTR="${INSTR//WTDIR_PLACEHOLDER/$WT_DIR}"
      INSTR="${INSTR//BRANCH_PLACEHOLDER/$BRANCH}"
      INSTR="${INSTR//BASE_BRANCH_PLACEHOLDER/$BASE_BRANCH}"
      INSTR="${INSTR//STATUS_FILE_PLACEHOLDER//tmp/${SESSION}-${ISSUE}-status.txt}"
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

      # Start agent in that window via adapter
      agent_launch_autonomous "$SESSION" "$WIN" "$INSTR_FILE" "$TASK_AGENT_CMD" "$TASK_MODEL"
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
  tmux select-pane -t "$SESSION:control.0"
  tmux attach -t "$SESSION"
else
  echo "Session ready: $SESSION"
  echo ""
fi
