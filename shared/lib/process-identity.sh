#!/usr/bin/env bash
# A PID alone is reusable; a process identity is (pid, ps lstart).
process_identity_start_time() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ && "$pid" -gt 0 ]] || return 0
  ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//' || true
}

process_identity_alive() {
  local pid="$1" start="$2" now error
  [[ "$pid" =~ ^[0-9]+$ && -n "$start" ]] || return 1
  now="$(process_identity_start_time "$pid")"
  if [[ -n "$now" ]]; then [[ "$now" == "$start" ]]; return; fi
  # ps may fail for a live process. Only a definite ESRCH proves it dead.
  error="$(LC_ALL=C kill -0 "$pid" 2>&1)" && return 0
  [[ "$error" != *"No such process"* ]]
}

process_identity_host() { hostname; }

# A legacy PID-only record is safe to retire only when the PID is absent.
process_identity_pid_gone() {
  local pid="$1" error
  [[ "$pid" =~ ^[0-9]+$ && "$pid" -gt 0 ]] || return 1
  error="$(LC_ALL=C kill -0 "$pid" 2>&1)" && return 1
  [[ "$error" == *"No such process"* ]]
}
