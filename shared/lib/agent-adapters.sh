#!/opt/homebrew/bin/bash
# Agent Adapter Library
# Abstracts agent-specific launch patterns so the orchestrator and mill
# scripts don't need to know how each agent CLI works.
#
# Adding a new agent: add a case block in each function below.

# ============================================================================
# AGENT VALIDATION
# ============================================================================

# Check that the agent CLI binary is available on PATH.
# Args: $1 = agent command name (e.g. "claude", "codex")
# Returns: 0 if found, 1 if not
agent_validate() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1
}

# ============================================================================
# AGENT LAUNCH — AUTONOMOUS (SKIP) MODE
# ============================================================================

# Launch an agent in autonomous mode inside a tmux window.
# The agent receives a pre-written instructions file and runs without
# interactive user input.
#
# Args:
#   $1 = tmux session name
#   $2 = tmux window name
#   $3 = path to instructions file
#   $4 = agent command name
agent_launch_autonomous() {
  local session="$1"
  local window="$2"
  local instr_file="$3"
  local agent_cmd="$4"

  case "$agent_cmd" in
    claude)
      tmux send-keys -t "$session:$window" "cat '$instr_file' | claude" C-m
      ;;
    codex)
      tmux send-keys -t "$session:$window" "codex exec --dangerously-bypass-approvals-and-sandbox - < '$instr_file'" C-m
      ;;
    *)
      # Generic fallback: start the agent, then paste instructions via tmux buffer.
      tmux send-keys -t "$session:$window" "$agent_cmd" C-m
      sleep 0.3
      local instr
      instr="$(cat "$instr_file")"
      tmux set-buffer "$instr"
      tmux paste-buffer -t "$session:$window"
      tmux send-keys -t "$session:$window" C-m
      ;;
  esac
}

# ============================================================================
# AGENT LAUNCH — INTERACTIVE (PLANNING) MODE
# ============================================================================

# Launch an agent interactively in a tmux window for user-guided planning.
# Creates a small launcher script that execs the agent with the prompt.
#
# Args:
#   $1 = tmux session name
#   $2 = tmux window name
#   $3 = path to prompt file
#   $4 = agent command name
agent_launch_interactive() {
  local session="$1"
  local window="$2"
  local prompt_file="$3"
  local agent_cmd="$4"

  local launcher="/tmp/${session}-$(basename "$prompt_file" .txt)-launcher.sh"

  case "$agent_cmd" in
    claude)
      cat > "$launcher" <<LAUNCHEOF
#!/bin/bash
exec claude "\$(cat '$prompt_file')"
LAUNCHEOF
      ;;
    codex)
      cat > "$launcher" <<LAUNCHEOF
#!/bin/bash
exec codex "\$(cat '$prompt_file')"
LAUNCHEOF
      ;;
    *)
      cat > "$launcher" <<LAUNCHEOF
#!/bin/bash
exec $agent_cmd "\$(cat '$prompt_file')"
LAUNCHEOF
      ;;
  esac

  chmod +x "$launcher"
  tmux send-keys -t "$session:$window" "'$launcher'" C-m
}

# ============================================================================
# AGENT DISPLAY NAME
# ============================================================================

# Return a human-friendly display name for an agent command.
# Args: $1 = agent command name
agent_name() {
  local cmd="$1"
  case "$cmd" in
    claude) echo "Claude" ;;
    codex)  echo "Codex" ;;
    *)      echo "$cmd" ;;
  esac
}
