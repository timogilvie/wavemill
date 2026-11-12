# shellcheck shell=bash
# The gh fake's state lock, for shell callers (journeys and scripted fake
# agents that edit $FAKE_GH_STATE directly, e.g. to set a PR's checks).
#
# Same contract as acquireLock in gh.mjs: the lock is a directory holding the
# owner's pid, and a lock whose owner is dead is taken over. A caller never
# proceeds without the lock: it either holds it or fails loudly. The private
# copies this replaces waited five seconds and then went ahead regardless,
# writing their pid into a directory another process could remove underneath
# them, which killed a `set -e` fake agent mid-repair.
#
# Sourced by tests/fakes/lib.sh and tests/fakes/bin/claude.

# Re-entrancy depth for this shell process. A journey helper that locks for a
# read-modify-write (e.g. to read a rerun marker and then update CI) may call
# fakes_gh_state inside that section, and fakes_gh_state locks too; without a
# depth the inner unlock would release the outer section's lock and a plain
# nested acquire would deadlock on a lock the same process already holds.
FAKES_GH_STATE_LOCK_DEPTH="${FAKES_GH_STATE_LOCK_DEPTH:-0}"

fakes_gh_state_lock() {
  local lock="$FAKE_GH_STATE.lock" owner i
  # Already held by this process: deepen the count, do not lock again.
  if (( FAKES_GH_STATE_LOCK_DEPTH > 0 )) \
    && [[ "$(cat "$lock/pid" 2>/dev/null || true)" == "$$" ]]; then
    FAKES_GH_STATE_LOCK_DEPTH=$((FAKES_GH_STATE_LOCK_DEPTH + 1))
    return 0
  fi
  for ((i = 1; i <= 6000; i++)); do
    if mkdir "$lock" 2>/dev/null; then
      # A concurrent stale-lock takeover can remove the directory between
      # these two steps; that is a lost race, not an error.
      if printf '%s' "$$" > "$lock/pid" 2>/dev/null; then
        FAKES_GH_STATE_LOCK_DEPTH=1
        return 0
      fi
      continue
    fi
    if (( i % 20 == 0 )); then
      owner="$(cat "$lock/pid" 2>/dev/null || true)"
      # No pid a full second in, or a pid that is gone: the owner died.
      if { [[ -z "$owner" ]] && (( i >= 100 )); } \
        || { [[ -n "$owner" ]] && ! kill -0 "$owner" 2>/dev/null; }; then
        rm -rf "$lock"
        continue
      fi
    fi
    sleep 0.01
  done
  echo "fakes_gh_state_lock: $lock still held by live pid $(cat "$lock/pid" 2>/dev/null || echo unknown) after 60s" >&2
  return 1
}

fakes_gh_state_unlock() {
  # Only the outermost unlock releases; a nested section's unlock just unwinds.
  if (( FAKES_GH_STATE_LOCK_DEPTH > 1 )); then
    FAKES_GH_STATE_LOCK_DEPTH=$((FAKES_GH_STATE_LOCK_DEPTH - 1))
    return 0
  fi
  FAKES_GH_STATE_LOCK_DEPTH=0
  rm -rf "$FAKE_GH_STATE.lock"
}
