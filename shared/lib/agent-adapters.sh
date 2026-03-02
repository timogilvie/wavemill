#!/opt/homebrew/bin/bash
# Agent Adapter Library
# Abstracts agent-specific launch patterns so the orchestrator and mill
# scripts don't need to know how each agent CLI works.
#
# Adding a new agent: add a case block in each function below.

# ============================================================================
# AGENT RESOLUTION
# ============================================================================

# Resolve the agent CLI command for a given model ID using prefix heuristics.
# Mirrors the logic in shared/lib/model-router.ts resolveAgent().
# Args: $1 = model ID (e.g. "claude-opus-4-6", "gpt-5.3-codex")
# Prints: agent command name (e.g. "claude", "codex")
agent_resolve_from_model() {
  local model="$1"
  case "$model" in
    claude-*) echo "claude" ;;
    gpt-*|o[0-9]*) echo "codex" ;;
    *) echo "${AGENT_CMD:-claude}" ;;
  esac
}

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

# Check if agent is authenticated and ready to use.
# Args: $1 = agent command name (e.g. "claude", "codex")
# Returns: 0 if authenticated, 1 if not authenticated
# Output: Error message to stderr if not authenticated
# Note: Results are cached per-process to avoid redundant checks
declare -A _AGENT_AUTH_CACHE

agent_check_auth() {
  local cmd="$1"

  # Return cached result if available (valid for this process lifetime)
  if [[ -n "${_AGENT_AUTH_CACHE[$cmd]:-}" ]]; then
    return "${_AGENT_AUTH_CACHE[$cmd]}"
  fi

  case "$cmd" in
    claude)
      # Use 'claude auth status' which exits 0 when logged in
      if ! claude auth status >/dev/null 2>&1; then
        echo "Error: Claude authentication required. Run: claude auth login" >&2
        _AGENT_AUTH_CACHE[$cmd]=1
        return 1
      fi
      ;;
    codex)
      # Check for auth file existence and non-empty (fast path)
      local auth_file="$HOME/.codex/auth.json"
      if [[ ! -s "$auth_file" ]]; then
        echo "Error: Codex authentication required. Run: codex login" >&2
        _AGENT_AUTH_CACHE[$cmd]=1
        return 1
      fi
      ;;
    *)
      # Unknown agent - assume authenticated (don't block unknown agents)
      _AGENT_AUTH_CACHE[$cmd]=0
      return 0
      ;;
  esac

  _AGENT_AUTH_CACHE[$cmd]=0
  return 0
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
#   $5 = model ID (optional — when set, passes --model flag to the agent CLI)
agent_launch_autonomous() {
  local session="$1"
  local window="$2"
  local instr_file="$3"
  local agent_cmd="$4"
  local model="${5:-}"

  local model_flag=""
  if [[ -n "$model" ]]; then
    model_flag=" --model $model"
  fi

  # Wrap agent command so exit status is visible and the shell survives
  case "$agent_cmd" in
    claude)
      tmux send-keys -t "$session:$window" "cat '$instr_file' | claude${model_flag}; echo '[wavemill] Agent exited (\$?)'" C-m
      ;;
    codex)
      tmux send-keys -t "$session:$window" "codex exec${model_flag} --dangerously-bypass-approvals-and-sandbox - < '$instr_file'; echo '[wavemill] Agent exited (\$?)'" C-m
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
#   $5 = model ID (optional — when set, passes --model flag to the agent CLI)
agent_launch_interactive() {
  local session="$1"
  local window="$2"
  local prompt_file="$3"
  local agent_cmd="$4"
  local model="${5:-}"

  local model_flag=""
  if [[ -n "$model" ]]; then
    model_flag=" --model $model"
  fi

  local launcher="/tmp/${session}-$(basename "$prompt_file" .txt)-launcher.sh"

  # Don't use exec — keep the shell alive so the window persists after agent exit
  case "$agent_cmd" in
    claude)
      cat > "$launcher" <<LAUNCHEOF
#!/bin/bash
claude${model_flag} "\$(cat '$prompt_file')"
echo "[wavemill] Agent exited (\$?)"
LAUNCHEOF
      ;;
    codex)
      cat > "$launcher" <<LAUNCHEOF
#!/bin/bash
codex${model_flag} "\$(cat '$prompt_file')"
echo "[wavemill] Agent exited (\$?)"
LAUNCHEOF
      ;;
    *)
      cat > "$launcher" <<LAUNCHEOF
#!/bin/bash
$agent_cmd "\$(cat '$prompt_file')"
echo "[wavemill] Agent exited (\$?)"
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
