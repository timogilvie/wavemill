#!/usr/bin/env bash
# A PID alone is reusable; a process identity is (pid, ps lstart).
process_identity_start_time() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ && "$pid" -gt 0 ]] || return 0
  ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//' || true
}

process_identity_alive() {
  local pid="$1" start="$2" now
  [[ "$pid" =~ ^[0-9]+$ && -n "$start" ]] || return 1
  now="$(process_identity_start_time "$pid")"
  [[ -n "$now" && "$now" == "$start" ]]
}

process_identity_host() { hostname; }
