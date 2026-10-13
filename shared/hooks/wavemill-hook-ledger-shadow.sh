#!/usr/bin/env bash
# Shadow helpers for the HOK-3184 ledger evidence mirror.
#
# Only agent-sourced hook writes count as liveness evidence (HOK-3101). This
# file exposes one function that is called after a successful wavemill_hook_write;
# writer=monitor returns immediately so monitor writes never reach the ledger.
#
# All ledger invocations are best-effort: a missing CLI, locked DB, or
# older Node without the SQLite binding never crashes the hook caller.
# The kill switch is WAVEMILL_LEDGER_SHADOW_DISABLED=1.

# Record an agent-sourced hook event as an evidence row on the newest live
# step row. Returns 0 unconditionally.
#
# Args: state event detail writer [agent]
wavemill_hook_shadow_evidence() {
  local state="$1"
  local event="$2"
  local detail="${3:-}"
  local writer="${4:-agent}"

  # HOK-3101: only agent writes produce evidence rows (writer=monitor is
  # excluded by construction here).
  [[ "$writer" == "agent" ]] || return 0

  # Kill switch and env guards.
  [[ "${WAVEMILL_LEDGER_SHADOW_DISABLED:-0}" == "1" ]] && return 0
  [[ -n "${WAVEMILL_SESSION:-}" && -n "${WAVEMILL_ISSUE:-}" ]] || return 0

  # Resolve the tool runner. The helper must be no-op if the mill install
  # paths aren't resolvable (standalone agent, bare `claude -p`, etc.).
  if ! declare -F wavemill_run_tool >/dev/null 2>&1; then
    return 0
  fi

  # Build the arg vector; detail is optional.
  local -a cli_args=(
    evidence-insert
    --issue "$WAVEMILL_ISSUE"
    --event "$event"
    --state "$state"
  )
  [[ -n "$detail" ]] && cli_args+=(--detail "$detail")

  # Best-effort invocation: swallow stderr, always return 0.
  # Spawn in background and let it settle asynchronously (max 10s); don't block the hook caller.
  (
    wavemill_run_tool ledger.ts "${cli_args[@]}" >/dev/null 2>&1 || true
  ) &
  local pid=$!
  # Reap in background without waiting: the ledger write is small, but we
  # must not block the hook caller. The pid is intentionally orphaned on
  # process-exit paths. Suppress job status notifications.
  disown "$pid" 2>/dev/null || true
  return 0
}
