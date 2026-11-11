---
title: Hook-Based Status Tracking
---

# Hook-Based Status Tracking

Wavemill tracks agent lifecycle using a JSON status file contract at `/tmp/wavemill-${SESSION}-${ISSUE}.hook`. This replaces tmux pane liveness checks with richer state reporting (working/idle/waiting/blocked/approval-needed/policy-denied/error) and supports staleness detection via timestamps.

### Architecture

**Shared Protocol** ([wavemill-hook-protocol.sh](../shared/hooks/wavemill-hook-protocol.sh)):
- `wavemill_hook_check()` - Ensures hooks are no-ops outside wavemill contexts
- `wavemill_hook_write(state, event, detail, agent[, next_action])` - Atomic JSON writes with timestamps; optional `next_action` surfaces a human-readable hint in the dashboard
- 300s TTL for staleness detection

**Agent Adapters**:
- **Claude** ([claude-status-hook.sh](../shared/hooks/claude-status-hook.sh)) - Hooks configured per-worktree in `.claude/settings.local.json` (gitignored). Fires on UserPromptSubmit, PreToolUse, Stop, StopFailure, and Notification events.
- **Codex** ([codex-status-monitor.sh](../shared/hooks/codex-status-monitor.sh)) - Monitors JSONL event stream from `codex exec --json`
- **Generic** ([process-status-monitor.sh](../shared/hooks/process-status-monitor.sh)) - Fallback monitoring via child process detection

**Status Reading** ([wavemill-status.sh](../shared/lib/wavemill-status.sh)):
- Reads JSON hook files with TTL validation (300s)
- Falls back to tmux pane liveness if hook is stale or missing
- Extracts `detail` and `next_action` fields for dashboard display

**Hook Configuration** ([wavemill-common.sh](../shared/lib/wavemill-common.sh)):
- `configure_agent_hooks()` dynamically writes `.claude/settings.local.json` per-worktree
- Claude hook adapters are always loaded from the wavemill installation at `$TOOLS_DIR/../shared/hooks/`
- Only affects wavemill-launched agents, not standalone Claude usage
- Called before each phase launch (planning, coding, review)
- Missing wavemill hook adapters warn once per session via `/tmp/wavemill-${SESSION}-hook-warnings.txt`

### JSON Status Format

```json
{
  "state": "working",
  "event": "PreToolUse",
  "detail": "Read",
  "agent": "claude",
  "timestamp": 1712345678,
  "writer": "agent",
  "agentRecord": {
    "state": "working",
    "event": "PreToolUse",
    "agent": "claude",
    "timestamp": 1712345678,
    "detail": "Read"
  }
}
```

The optional `next_action` field carries a short operator hint for actionable states:

```json
{
  "state": "approval-needed",
  "event": "Notification",
  "detail": "waiting for human approval",
  "next_action": "approve HOK-1234 to continue",
  "agent": "claude",
  "timestamp": 1712345678,
  "writer": "agent"
}
```

**States**:
- `working` — agent is actively processing
- `idle` — agent stopped normally
- `waiting` — agent blocked on user input (generic)
- `blocked` — agent cannot proceed (e.g. merge conflict); displayed in dashboard inbox
- `approval-needed` — agent paused awaiting explicit operator approval; emits OSC desktop notification
- `policy-denied` — an action was rejected by a network or mutation policy; emits OSC desktop notification
- `error` — agent encountered a failure; emits OSC desktop notification

Unknown states are silently dropped so readers never see partial or malformed hook files.

**TTL**: 300s - dashboard falls back to pane liveness if timestamp is stale

**Atomic Writes**: Uses tmp file + mv to prevent partial reads

**`writer` field (HOK-3101)**: `agent` or `monitor`. Distinguishes controller writes from agent writes. Monitor/controller writes NEVER count as agent liveness evidence and NEVER erase the agent's own record. Legacy hooks (no `writer` field, written before HOK-3101 landed) are classified by event: `pr_merged`, `pr_closed_unmerged`, `operator_abort`, `review_complete`, `ready_complete`, `pr_opened`, `blocked_completion_liveness`, `premature_plan_approval`, `recovery_contract_unavailable`, `planning_rejection_notify_failed`, `NoPR`, `worktree-setup`, `recovery_failure`, `challenge_*` are monitor; everything else is agent.

**`agentRecord` field (HOK-3101)**: preserves the agent's own last record across subsequent monitor writes so a monitor `pr_merged` write cannot erase the agent's `idle:Stop` (HOK-3089 pt 3). Callers that need the agent's true state (dashboard, ready-watchdog, reconciler pane release, monitor stage-owner check) must read from `agentRecord`, not the top level, via the shared shell accessor `wavemill_hook_read --agent-only` or the TS `readHookFile()`.

### Signal-Driven Dashboard Refresh

The dashboard supports immediate updates via `USR1` in addition to polling:

- After each successful atomic hook write, `wavemill_hook_notify()` sends `USR1` to `$WAVEMILL_DASHBOARD_PID`
- `wavemill-status.sh` traps `USR1` and sets `WAVEMILL_REDRAW=1`
- The dashboard loop uses an interruptible wait (`sleep "$REFRESH" &; wait`) for fast wakeups
- A 2-second default poll fallback remains in place in case signals are missed
- `WAVEMILL_DASHBOARD_REFRESH_SECONDS` can override the fallback cadence with integer values from `1` through `10`; invalid values fall back to `2`
- Signal delivery is best-effort with full PID validation (invalid/stale PID is a no-op, never fails hook writes)

**PID propagation architecture (tmux environment-based)**:
1. `setup_control_dashboard()` in `wavemill-startup-runner.sh` captures the dashboard pane PID after spawn
2. The PID is set as a tmux session environment variable: `tmux set-environment -t "$SESSION" WAVEMILL_DASHBOARD_PID "$WAVEMILL_DASHBOARD_PID"`
3. `agent_resolve_dashboard_pid()` in `agent-adapters.sh` reads the PID from either:
   - The current shell environment (if already set), or
   - The tmux session environment via `tmux show-environment`
4. `agent_launch_autonomous()` and `agent_launch_interactive()` export `WAVEMILL_DASHBOARD_PID` for all agent types (Claude, Codex, generic)
5. Hook scripts inherit the PID from their environment and call `wavemill_hook_notify()` for validated signal delivery

This architecture ensures complete agent coverage without coupling hook configuration to PID injection.

### OSC 7501 Program Status mirror

Every successful `wavemill_hook_write` also emits a best-effort [OSC 7501
Program Status](https://www.superlogical.com/rex/docs/build/program-status)
report to the agent's pane TTY. Terminals that understand the sequence (e.g.
Rex) show agent state natively; terminals that don't ignore it.

Mapping:

| wavemill state | OSC 7501 |
|---|---|
| `working` | `state=working` |
| `idle` | `state=idle` |
| `waiting` | `state=blocked:kind=question` |
| `approval-needed` | `state=blocked:kind=permission` |
| `blocked` | `state=blocked` |
| `policy-denied` | `state=error` |
| `error` | `state=error` |

- `app=wavemill-<agent>` on every report; an agent string that fails the
  `[A-Za-z0-9_.+-]{1,32}` validation falls back to `wavemill`.
- `msg` is base64-encoded `next_action` if set, otherwise `detail` (truncated
  to 2048 bytes before encoding, control chars stripped).
- `title` is base64-encoded `WAVEMILL_ISSUE` (truncated to 192 bytes before
  encoding).
- Writes go to the resolved pane TTY (`tmux display-message -p '#{pane_tty}'`
  under tmux, else the controlling `tty`), never to stdout or stderr.
- Under tmux, the sequence is wrapped in DCS passthrough and only reaches the
  outer terminal when tmux's `allow-passthrough` option is on. The hook does
  not change this option globally.
- Kill switch: set `hooks.programStatus: false` in `.wavemill-config.json`.
  Reads share the single `jq` invocation that already resolves
  `hooks.emitOsc`, so adding this does not cost an extra process per write.
- Separate from the existing OSC 777 notification path (`hooks.emitOsc`),
  which keeps its narrower emission rules (phase gate + actionable states).

### Dependencies

- `jq` (required for all adapters) - JSON parsing and creation
- `pgrep` (optional) - Child process detection for generic adapter

Without `jq`, hooks are no-ops. Without `pgrep`, generic adapter degrades to initial/final state only.

### Adding New Adapters

1. **Prefer native hooks** if the CLI exposes them (like Claude Code)
2. **Otherwise prefer structured event streams** (like Codex JSONL)
3. **Fall back to process monitoring** for agents without hooks/streams

All adapters:
- Source `wavemill-hook-protocol.sh`
- Call `wavemill_hook_check()` at startup
- Use `wavemill_hook_write()` for all status updates
- Set `WAVEMILL_SESSION` and `WAVEMILL_ISSUE` environment variables
