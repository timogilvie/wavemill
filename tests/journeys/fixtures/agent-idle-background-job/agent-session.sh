#!/usr/bin/env bash
# Coding session for the agent-idle-background-job journey (HOK-3137).
#
# Runs as the pane's agent process (exec'd as `claude-agent` by
# fake-agent/coding). Plays the incident: the agent starts its test suite in
# the background (`run_in_background`), its turn ends — Claude Code fires the
# Stop hook, so the hook file says idle/Stop — and it waits for the suite. The
# agent process stays alive the whole time. Only when the suite finishes does
# it wake up, commit and write .coding-complete.
#
# Status goes through the real Claude adapter (shared/hooks/claude-status-hook.sh)
# with the JSON payloads Claude Code sends, not hand-written hook files. The
# adapter's dashboard-redraw side channel (WAVEMILL_DASHBOARD_PID → window
# title refresh over tmux) is not part of this scenario and is switched off.
set -euo pipefail

WT="$(pwd -P)"
HOOK_ADAPTER="$FAKE_AGENT_TOOLS_DIR/../shared/hooks/claude-status-hook.sh"
# Read by progress-clock.mjs: while present, the liveness primitive sees the
# idle window as this many minutes long (past its 30-minute stall threshold).
SKEW_FILE="$FAKE_ROOT/progress-clock-skew-minutes"
IDLE_TICKS="${JOURNEY_IDLE_TICKS:-2}"
IDLE_MIN_SECONDS="${JOURNEY_IDLE_MIN_SECONDS:-10}"

claude_hook() {
  local payload
  payload="$(jq -cn --arg event "$1" --arg tool "${2:-}" \
    '{hook_event_name: $event} + (if $tool == "" then {} else {tool_name: $tool, tool_input: {command: "npm test"}} end)')"
  printf "%s" "$payload" | WAVEMILL_DASHBOARD_PID="" bash "$HOOK_ADAPTER" >/dev/null 2>&1 || true
}

mill_tick() {
  local tick=0 _epoch
  read -r tick _epoch < "$WAVEMILL_TICK_CLOCK_FILE" 2>/dev/null || true
  [[ "$tick" =~ ^[0-9]+$ ]] || tick=0
  printf '%s\n' "$tick"
}

agent_log() {
  printf '%s phase=coding issue=%s %s\n' "$(date -u +%FT%TZ)" "$WAVEMILL_ISSUE" "$*" >> "$FAKE_AGENT_LOG"
}

claude_hook UserPromptSubmit
claude_hook PreToolUse Bash

idle_start_tick="$(mill_tick)"
idle_until_tick=$(( idle_start_tick + IDLE_TICKS ))
idle_until_epoch=$(( $(date +%s) + IDLE_MIN_SECONDS ))

# The background test suite: a substantive child of the agent that outlives
# the agent's turn. It ends once the mill has made IDLE_TICKS passes (and a
# wall-clock minimum, so the owner-lost grace has elapsed) with the agent
# idle, and drops the clock skew on its way out so the agent's wake-up is
# not itself read as a 45-minute silence.
(
  exec -a fake-test-suite bash -c '
    while (( $(read -r t _ < "$1" 2>/dev/null; echo "${t:-0}") < $2 || $(date +%s) < $3 )); do
      sleep 0.5
    done
    rm -f "$4"
  ' _ "$WAVEMILL_TICK_CLOCK_FILE" "$idle_until_tick" "$idle_until_epoch" "$SKEW_FILE"
) &
suite_pid=$!

# The turn ends while the suite runs: Claude Code fires Stop → hook idle/Stop.
claude_hook Stop
printf '45\n' > "$SKEW_FILE"
agent_log "idle-awaiting-background start-tick=$idle_start_tick"

wait "$suite_pid" || true
agent_log "background-finished tick=$(mill_tick)"

# The suite's completion notification wakes the agent for a new turn.
claude_hook UserPromptSubmit
claude_hook PreToolUse Bash
printf 'implemented %s\n' "$WAVEMILL_ISSUE" >> journey-output.txt
git add journey-output.txt
git -c user.name=fake-agent -c user.email=fake-agent@example.invalid commit -q -m "$WAVEMILL_ISSUE: implement (tests passed in background)"
jq -n --arg commit "$(git -C "$WT" rev-parse HEAD)" '{stage:"coding",confidence:"high",commit:$commit}' > "$FEATURE_DIR/.coding-complete"
claude_hook Stop
agent_log "done"
