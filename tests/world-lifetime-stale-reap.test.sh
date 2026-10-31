#!/usr/bin/env bash
# Stale-world replay for the startup backstop reaper (HOK-3329).
#
# protects: a world whose owner and watcher are both gone (watcher killed,
# host rebooted) staying on the host forever; the next fakes_setup must tear it
# down. Also protects against pid reuse (an alive pid with a different start
# time is not the owner), against reaping a live owner's world, and against
# the one-time legacy sweep deleting a pre-record journey that is still owned.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=fakes/lib.sh
source "$SCRIPT_DIR/fakes/lib.sh"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '  PASS  %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; }
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/world-lifetime-stale-reap.XXXXXX")"
TMP="$(cd "$TMP" && pwd -P)"
ID="sr$$"
SPAWNED=()
cleanup() {
  local pid
  for pid in "${SPAWNED[@]}"; do kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true; done
  fakes_teardown
  rm -f "$FAKES_WORLDS_DIR/$ID"-*.json
  rm -rf "$TMP" "${LEGACY_LIVE:-}" "${LEGACY_ORPHAN:-}" "${LEGACY_OLD:-}"
}
trap cleanup EXIT

# Seed one record. Args: name, owner pid, owner start time, pgids JSON.
seed_world() {
  mkdir -p "$TMP/$1"
  jq -n --arg id "$ID-$1" --argjson pid "$2" --arg start "$3" --argjson pgids "$4" \
        --arg world "$TMP/$1" --arg sock "$TMP/$1.sock" \
    '{schemaVersion:1,id:$id,ownerPid:$pid,ownerStartTime:$start,worldDir:$world,tmuxSocket:$sock,pgids:$pgids}' \
    > "$FAKES_WORLDS_DIR/$ID-$1.json"
  : > "$TMP/$1.sock"
}

# A child in its own process group, standing in for an orphaned monitor.
spawn_group() {
  # allow-world-lifetime: deliberately an orphaned group no live world registered.
  set -m
  sleep 300 >/dev/null 2>&1 &
  set +m
  printf '%s\n' "$!"
}

install -d -m 700 "$FAKES_WORLDS_DIR"
orphan_pgid="$(spawn_group)"
SPAWNED+=("$orphan_pgid")
seed_world live "$$" "$(fakes_pid_start_time "$$")" '[]'
seed_world dead 999999 "Mon Oct 27 08:30:17 2026" "[$orphan_pgid]"
seed_world reuse "$$" "Wed Jan  1 00:00:00 2020" '[]'

# A pre-record monitor stand-in: one process whose argv names the dir's
# monitor.env, as `bash wavemill-monitor.sh <dir>/monitor.env` does.
legacy_monitor() {
  exec -a "wavemill-monitor.sh $1/monitor.env" sleep 300 >/dev/null 2>&1
}

# Legacy journey dirs (no record). A live one's monitor is a child of this
# shell; an orphaned one's monitor was reparented to pid 1; an old one has no
# monitor and is past the sweep age.
LEGACY_LIVE="$(mktemp -d "${TMPDIR:-/tmp}/journey-sr-live.XXXXXX")"
LEGACY_LIVE="$(cd "$LEGACY_LIVE" && pwd -P)"
LEGACY_ORPHAN="$(mktemp -d "${TMPDIR:-/tmp}/journey-sr-orphan.XXXXXX")"
LEGACY_ORPHAN="$(cd "$LEGACY_ORPHAN" && pwd -P)"
LEGACY_OLD="$(mktemp -d "${TMPDIR:-/tmp}/journey-sr-old.XXXXXX")"
touch -t 202001010000 "$LEGACY_OLD"
legacy_monitor "$LEGACY_LIVE" &
live_monitor=$!
SPAWNED+=("$live_monitor")
( legacy_monitor "$LEGACY_ORPHAN" &
  echo $! > "$TMP/orphan-monitor.pid" )
orphan_monitor="$(cat "$TMP/orphan-monitor.pid")"
SPAWNED+=("$orphan_monitor")
orphan_reparented=0
[[ "$(ps -o ppid= -p "$orphan_monitor" | tr -d ' ')" == "1" ]] && orphan_reparented=1

# The next fakes_setup runs the reaper.
fakes_setup "$TMP/self" "acme/stale-reap" main

check "live owner's record kept" '[[ -f "$FAKES_WORLDS_DIR/$ID-live.json" && -d "$TMP/live" && -e "$TMP/live.sock" ]]'
check "dead owner's record, dir and socket removed" \
  '[[ ! -e "$FAKES_WORLDS_DIR/$ID-dead.json" && ! -e "$TMP/dead" && ! -e "$TMP/dead.sock" ]]'
check "dead owner's registered process group killed" '! kill -0 -- "-$orphan_pgid" 2>/dev/null'
check "pid-reuse record (alive pid, wrong start time) reaped" \
  '[[ ! -e "$FAKES_WORLDS_DIR/$ID-reuse.json" && ! -e "$TMP/reuse" && ! -e "$TMP/reuse.sock" ]]'
check "this fakes_setup's own world is recorded and kept" '[[ -f "$WORLD_RECORD" && -d "$TMP/self" ]]'
check "legacy journey dir with a live owned monitor kept" '[[ -d "$LEGACY_LIVE" ]] && kill -0 "$live_monitor"'
check "legacy journey dir past the sweep age removed" '[[ ! -e "$LEGACY_OLD" ]]'
if (( orphan_reparented )); then
  check "legacy journey dir with an orphaned monitor removed, monitor killed" \
    '[[ ! -e "$LEGACY_ORPHAN" ]] && ! kill -0 "$orphan_monitor" 2>/dev/null'
else
  echo "  SKIP  orphaned legacy monitor: a subreaper adopted it (ppid != 1)"
fi

echo ""
echo "--- world-lifetime-stale-reap: $PASS passed, $FAIL failed ---"
(( FAIL == 0 ))
