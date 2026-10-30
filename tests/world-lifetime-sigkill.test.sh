#!/usr/bin/env bash
# SIGKILL replay for the test-world lifetime primitive (HOK-3329).
#
# protects: an owner shell that dies without running its EXIT trap (SIGKILL,
# fork subagent end, parent-tree kill) orphaning its monitor-like children, its
# private tmux server, socket and world dir (the 2026-10-27 incident). The
# owner watcher inside the world's tmux server must tear the world down within
# a bounded time, for one owner and for three parallel owners whose parent tree
# is killed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=fakes/lib.sh
source "$SCRIPT_DIR/fakes/lib.sh"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '  PASS  %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; }

REAL_TMUX="$(term_resolve_real_tmux 2>/dev/null || true)"
if [[ -z "$REAL_TMUX" ]] || ! command -v jq >/dev/null 2>&1; then
  echo "SKIP: tmux and jq are required"
  exit 0
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/world-lifetime-sigkill.XXXXXX")"
TMP="$(cd "$TMP" && pwd -P)"

# One world owner: fakes_setup, the world host (tmux server + watcher), one
# spawned long-lived child; then publish what the test asserts on and idle.
cat > "$TMP/owner.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
n="\$1"
source "$SCRIPT_DIR/fakes/lib.sh"
mkdir -p "$TMP/world-\$n"
fakes_setup "$TMP/world-\$n/fake" "acme/sigkill" main "$TMP/world-\$n"
fakes_start_world_host "wlk\$\$" "$TMP/world-\$n"
fakes_spawn sleep 300
jq -c --arg n "\$n" '. + {n:\$n}' "\$WORLD_RECORD" > "$TMP/manifest-\$n.tmp"
mv "$TMP/manifest-\$n.tmp" "$TMP/manifest-\$n.json"
while :; do sleep 1; done
EOF

cleanup() {
  local m record
  for m in "$TMP"/manifest-*.json; do
    [[ -f "$m" ]] || continue
    record="$FAKES_WORLDS_DIR/$(jq -r '.id' "$m").json"
    fakes_teardown_world "$record"
  done
  rm -rf "$TMP"
}
trap cleanup EXIT

wait_for_manifest() {
  for _ in $(seq 1 80); do
    [[ -s "$TMP/manifest-$1.json" ]] && return 0
    sleep 0.25
  done
  return 1
}

# True once nothing the manifest names survives: record, pgids, tmux server,
# socket, and (unless keep=1) the world dir.
world_gone() {
  local manifest="$1" keep="$2" pgid sock
  [[ ! -e "$FAKES_WORLDS_DIR/$(jq -r '.id' "$manifest").json" ]] || return 1
  for pgid in $(jq -r '.pgids[]' "$manifest"); do
    ! kill -0 -- "-$pgid" 2>/dev/null || return 1
  done
  sock="$(jq -r '.tmuxSocket' "$manifest")"
  ! "$REAL_TMUX" -S "$sock" list-sessions >/dev/null 2>&1 || return 1
  [[ ! -e "$sock" ]] || return 1
  [[ "$keep" == "1" || ! -e "$(jq -r '.worldDir' "$manifest")" ]]
}

wait_world_gone() {
  for _ in $(seq 1 60); do   # 15s: 1 Hz watcher + teardown slack
    world_gone "$1" "$2" && return 0
    sleep 0.25
  done
  return 1
}

# ── One owner, SIGKILLed: the EXIT trap never runs ──────────────────────────
bash "$TMP/owner.sh" 1 &
owner=$!
if wait_for_manifest 1; then
  m="$TMP/manifest-1.json"
  sock="$(jq -r '.tmuxSocket' "$m")"
  "$REAL_TMUX" -S "$sock" list-sessions >/dev/null 2>&1 \
    && pass "world host tmux server is up before the kill" \
    || fail "world host tmux server is up before the kill"
  [[ "$(jq '.pgids | length' "$m")" == "1" ]] \
    && pass "fakes_spawn registered the child's pgid" \
    || fail "fakes_spawn registered the child's pgid"
  kill -KILL "$owner"
  wait_world_gone "$m" 0 \
    && pass "SIGKILLed owner: pgids, tmux server, socket, world dir and record all gone" \
    || fail "SIGKILLed owner: pgids, tmux server, socket, world dir and record all gone"
else
  fail "owner 1 published its world"
fi

# ── JOURNEY_KEEP_TMP=1 keeps the dir but still kills everything else ────────
JOURNEY_KEEP_TMP=1 bash "$TMP/owner.sh" 2 &
owner=$!
if wait_for_manifest 2; then
  m="$TMP/manifest-2.json"
  kill -KILL "$owner"
  if wait_world_gone "$m" 1; then
    pass "JOURNEY_KEEP_TMP=1: processes, server, socket and record gone"
  else
    fail "JOURNEY_KEEP_TMP=1: processes, server, socket and record gone"
  fi
  [[ -d "$(jq -r '.worldDir' "$m")" ]] \
    && pass "JOURNEY_KEEP_TMP=1: world dir retained" \
    || fail "JOURNEY_KEEP_TMP=1: world dir retained"
else
  fail "owner 2 published its world"
fi

# ── Three parallel owners under one parent; the whole tree is SIGKILLed ─────
cat > "$TMP/parent.sh" <<EOF
#!/usr/bin/env bash
for n in 3 4 5; do bash "$TMP/owner.sh" "\$n" & done
wait
EOF
bash "$TMP/parent.sh" &
parent=$!
all_up=1
for n in 3 4 5; do wait_for_manifest "$n" || all_up=0; done
if (( all_up )); then
  pkill -KILL -P "$parent" 2>/dev/null || true
  kill -KILL "$parent" 2>/dev/null || true
  all_gone=1
  for n in 3 4 5; do wait_world_gone "$TMP/manifest-$n.json" 0 || all_gone=0; done
  (( all_gone )) \
    && pass "parallel worlds under a killed parent leave nothing behind" \
    || fail "parallel worlds under a killed parent leave nothing behind"
else
  fail "three parallel owners published their worlds"
fi

echo ""
echo "--- world-lifetime-sigkill: $PASS passed, $FAIL failed ---"
(( FAIL == 0 ))
