#!/usr/bin/env bash
# Tick clock seam (HOK-3227).
#
# Deadlines, TTL-style expiries and retry backoff read time through
# mill_clock_now instead of `date +%s`, so a golden journey can run them on a
# monitor tick counter instead of the wall clock and stay deterministic.
#
# Off by default: with WAVEMILL_TICK_CLOCK_FILE unset every helper is the wall
# clock and production behaviour is unchanged.
#
# When WAVEMILL_TICK_CLOCK_FILE is set it holds one line, "<tick> <epoch>":
#   - the monitor increments <tick> once per main-loop pass
#     (mill_clock_advance_tick, at the end of each wavemill-monitor.sh pass);
#     <epoch> is fixed at the first write (or WAVEMILL_TICK_CLOCK_EPOCH);
#   - mill_clock_now = epoch + tick * WAVEMILL_TICK_CLOCK_SECONDS (default 60),
#     so a backoff of B seconds elapses after ceil(B / seconds) monitor ticks
#     no matter how long each pass takes.
# The TypeScript twin is shared/lib/mill-clock.ts.
#
# Agent liveness (hook TTLs, task-progress) deliberately stays on the wall
# clock: it compares against timestamps real agent processes write.

mill_clock_enabled() {
  [[ -n "${WAVEMILL_TICK_CLOCK_FILE:-}" ]]
}

# Prints "<tick> <epoch>"; tick 0 and the wall clock (or the configured
# epoch) when the file does not exist yet.
_mill_clock_read() {
  local tick="" epoch=""
  if [[ -f "$WAVEMILL_TICK_CLOCK_FILE" ]]; then
    read -r tick epoch < "$WAVEMILL_TICK_CLOCK_FILE" 2>/dev/null || true
  fi
  [[ "$tick" =~ ^[0-9]+$ ]] || tick=0
  [[ "$epoch" =~ ^[0-9]+$ ]] || epoch="${WAVEMILL_TICK_CLOCK_EPOCH:-}"
  [[ "$epoch" =~ ^[0-9]+$ ]] || epoch="$(date +%s)"
  printf '%s %s\n' "$tick" "$epoch"
}

# Current tick count (0 when the clock is off).
mill_clock_tick() {
  if ! mill_clock_enabled; then
    printf '0\n'
    return 0
  fi
  local tick epoch
  read -r tick epoch <<< "$(_mill_clock_read)"
  printf '%s\n' "$tick"
}

# Epoch seconds: wall clock, or the tick-derived virtual time.
mill_clock_now() {
  if ! mill_clock_enabled; then
    date +%s
    return 0
  fi
  local tick epoch seconds="${WAVEMILL_TICK_CLOCK_SECONDS:-60}"
  [[ "$seconds" =~ ^[0-9]+$ ]] || seconds=60
  read -r tick epoch <<< "$(_mill_clock_read)"
  printf '%s\n' "$(( epoch + tick * seconds ))"
}

# Advance the tick counter by one. Single writer (the monitor main loop), so a
# temp file + rename is enough. No-op when the clock is off.
mill_clock_advance_tick() {
  mill_clock_enabled || return 0
  local tick epoch tmp
  read -r tick epoch <<< "$(_mill_clock_read)"
  tmp="${WAVEMILL_TICK_CLOCK_FILE}.tmp.$$"
  printf '%s %s\n' "$(( tick + 1 ))" "$epoch" > "$tmp" 2>/dev/null \
    && mv -f "$tmp" "$WAVEMILL_TICK_CLOCK_FILE" 2>/dev/null \
    || rm -f "$tmp" 2>/dev/null
  return 0
}
