#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=shared/hooks/wavemill-hook-protocol.sh
source "$SCRIPT_DIR/wavemill-hook-protocol.sh"

wavemill_hook_check

# Wavemill agents run inside the controller's tmux server and inherit its TMUX
# socket. TMUX_TMPDIR alone does not override that inherited socket, so an
# apparently isolated `TMUX_TMPDIR=... tmux kill-server` still kills the whole
# mill session. Require destructive server-wide commands to name a socket or
# server explicitly. This intentionally inspects only direct tmux command
# segments; quoted documentation or output such as `echo "tmux kill-server"`
# is not a tmux invocation and remains allowed.
wavemill_tmux_kill_server_uses_implicit_socket() {
  local command="$1"

  printf '%s\n' "$command" | awk '
    BEGIN { RS = "[;&|\\n]+" }
    {
      segment = $0
      sub(/^[[:space:](!]+/, "", segment)

      # Peel off common command wrappers and leading environment assignments.
      # Repeat because forms such as `env TMUX_TMPDIR=... command tmux ...`
      # can contain more than one prefix.
      changed = 1
      while (changed) {
        changed = 0
        if (sub(/^(env|command|exec|nohup)[[:space:]]+/, "", segment)) {
          changed = 1
        }
        if (sub(/^[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+[[:space:]]+/, "", segment)) {
          changed = 1
        }
      }

      if (segment !~ /^([^[:space:]]*\/)?tmux[[:space:]]+/) {
        next
      }
      sub(/^([^[:space:]]*\/)?tmux[[:space:]]+/, "", segment)

      if (!match(segment, /(^|[[:space:]])kill-server([[:space:]]|$)/)) {
        next
      }

      # Only options before the subcommand select the tmux server. Accept both
      # the normal `-S path` / `-L name` form and attached option arguments.
      prefix = substr(segment, 1, RSTART - 1)
      if (prefix ~ /(^|[[:space:]])-[SL]([^[:space:]]|[[:space:]])/) {
        next
      }

      unsafe = 1
      exit
    }
    END { exit(unsafe ? 0 : 1) }
  '
}

# Read JSON payload from stdin (Claude sends hook context as JSON)
payload=$(cat 2>/dev/null || true)
[[ -n "$payload" ]] || exit 0

# Extract event name (Claude uses different field names across versions)
event=$(printf '%s' "$payload" | jq -r '.hook_event_name // .hookEventName // .event // empty' 2>/dev/null || true)
[[ -n "$event" ]] || exit 0

case "$event" in
  UserPromptSubmit)
    wavemill_hook_write "working" "$event" "" "claude"
    ;;
  PreToolUse)
    detail=$(printf '%s' "$payload" | jq -r '.tool_name // .toolName // .tool.name // empty' 2>/dev/null || true)
    wavemill_hook_write "working" "$event" "$detail" "claude"
    if [[ "$detail" == "Bash" ]]; then
      command_text=$(printf '%s' "$payload" | jq -r '.tool_input.command // .toolInput.command // empty' 2>/dev/null || true)
      if [[ -n "$command_text" ]] && wavemill_tmux_kill_server_uses_implicit_socket "$command_text"; then
        # allow-world-lifetime: deny-reason prose, not an invocation.
        deny_reason="Blocked tmux kill-server without an explicit server target: Wavemill agents inherit the controller socket, and TMUX_TMPDIR does not override TMUX. Use tmux -S <private-socket> kill-server or tmux -L <private-name> kill-server."
        wavemill_hook_write "policy-denied" "$event" "$deny_reason" "claude"
        jq -nc --arg reason "$deny_reason" '{decision:"deny", reason:$reason}' >&2
        exit 2
      fi
    fi
    ;;
  Stop)
    wavemill_hook_write "idle" "$event" "" "claude"
    ;;
  StopFailure)
    detail=$(printf '%s' "$payload" | jq -r '.error.message // .message // .error_type // .errorType // .error.type // empty' 2>/dev/null || true)
    if [[ -z "$detail" ]]; then
      detail=$(printf '%s' "$payload" | jq -r '. | tostring' 2>/dev/null | head -c 200 || true)
    fi
    wavemill_hook_write "error" "$event" "$detail" "claude"
    ;;
  Notification)
    # Claude Code SDK sends Notification events with a free-form `.message`
    # field when the agent asks the user a clarifying question or otherwise
    # blocks on input. Older payload shapes used `.notification_type` for
    # permission_prompt/idle_prompt — preserve those as fallbacks so legacy
    # writers keep working.
    #
    # When the payload carries a stable discriminator (notification_type or
    # message pattern) for approval or policy conditions, map to the richer
    # state so the dashboard can surface it distinctly. Falls back to `waiting`
    # for all other notifications.
    notification_type=$(printf '%s' "$payload" | jq -r '.notification_type // .notificationType // empty' 2>/dev/null || true)
    detail=$(printf '%s' "$payload" | jq -r '.message // .notification_type // .notificationType // .type // empty' 2>/dev/null || true)
    detail="${detail:0:120}"
    [[ -z "$detail" ]] && detail="awaiting user input"

    hook_state="waiting"
    case "$notification_type" in
      approval_request|approval-request)
        hook_state="approval-needed"
        ;;
      policy_denied|policy-denied)
        hook_state="policy-denied"
        ;;
    esac

    wavemill_hook_write "$hook_state" "$event" "$detail" "claude"
    ;;
  *)
    ;;
esac

exit 0
