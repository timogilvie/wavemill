#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/shared/lib/state-lock.sh"
while IFS= read -r case_json; do
  name="$(jq -r '.name' <<<"$case_json")"
  owner="$(jq -c '.owner' <<<"$case_json")"
  alive="$(jq -r '.alive' <<<"$case_json")"
  expected="$(jq -r '.reclaimable' <<<"$case_json")"
  process_identity_alive() { [[ "$alive" == true ]]; }
  actual=false
  state_lock_owner_reclaimable "$owner" local && actual=true
  [[ "$actual" == "$expected" ]] || { echo "FAIL: shared case $name" >&2; exit 1; }
done < <(jq -c '.cases[]' "$ROOT/tests/fixtures/state-lock-cases.json")
unset -f process_identity_alive
source "$ROOT/shared/lib/process-identity.sh"
current_start="$(process_identity_start_time "$$")"
ps() { return 1; }
process_identity_alive "$$" "$current_start" || { echo 'FAIL: ps error stole live lock' >&2; exit 1; }
if process_identity_alive 99999999 "$current_start"; then echo 'FAIL: absent PID survived ps error' >&2; exit 1; fi
unset -f ps
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
lock="$TMP/state.json.lock"
if state_lock_acquire "$lock" 1 0.01 test; then :; else echo 'FAIL: initial acquisition' >&2; exit 1; fi
if state_lock_acquire "$lock" 1 0.01 waiter; then echo 'FAIL: live owner stolen' >&2; exit 1; fi
state_lock_release "$lock"
: > "$lock"
if state_lock_acquire "$lock" 1 0.01 waiter; then echo 'FAIL: legacy lock reclaimed at runtime' >&2; exit 1; fi
state_lock_reclaim_legacy "$lock"
state_lock_acquire "$lock" 1 0.01 waiter
state_lock_release "$lock"
# HOK-3516: a foreign .reclaim entry travels with the released lock.
lock_foreign="$TMP/foreign.json.lock"
state_lock_acquire "$lock_foreign" 1 0.01 foreign-holder
mkdir "$lock_foreign/.reclaim"
state_lock_release "$lock_foreign"
[[ ! -e "$lock_foreign" ]] || { echo 'FAIL: foreign .reclaim survived release at the lock path' >&2; exit 1; }
# HOK-3516: an ownerless directory stays busy at runtime; only startup removes it.
lock_dirform="$TMP/dirform.json.lock"
mkdir "$lock_dirform"
if state_lock_acquire "$lock_dirform" 1 0.01 waiter; then echo 'FAIL: ownerless directory reclaimed at runtime' >&2; exit 1; fi
state_lock_reclaim_legacy "$lock_dirform" || { echo 'FAIL: startup did not retire the ownerless directory' >&2; exit 1; }
# HOK-3516 deterministic replay of the 2026-11-21 incident interleaving
# (tests/fixtures/incident-replay/real/hok3516-ownerless-lock/): a waiter
# creates .reclaim between the removal's unlink of owner.json and its final
# rmdir, then backs off. The lock path must end absent or owned, never an
# ownerless directory. The shadowed rm models the kernel-level schedule the
# evidence recorded; the rename-away removal never runs rm on the lock path.
lock_replay="$TMP/replay.json.lock"
(
  rm() {
    local arg target=''
    for arg in "$@"; do target="$arg"; done
    if [[ "$target" == "$lock_replay" ]]; then
      command rm -f "$lock_replay/owner.json"
      command mkdir "$lock_replay/.reclaim" 2>/dev/null || true
      command rmdir "$lock_replay" 2>/dev/null || true
      command rmdir "$lock_replay/.reclaim" 2>/dev/null || true
      return 0
    fi
    command rm "$@"
  }
  state_lock_acquire "$lock_replay" 1 0.01 replay-holder || exit 1
  state_lock_release "$lock_replay" || true
  [[ ! -e "$lock_replay" || -e "$lock_replay/owner.json" ]]
) || { echo 'FAIL: release interleaving stranded an ownerless lock directory' >&2; exit 1; }
# HOK-3516 stress: concurrent waiters reclaim one dead owner's lock. Exactly
# one generation wins at a time and the lock path is never ownerless.
lock_stress="$TMP/stress.json.lock"
stress_host="$(process_identity_host)"
for round in 1 2 3; do
  mkdir -p "$lock_stress"
  printf '{"pid":99999999,"processStartTime":"gone","host":"%s","acquiredAt":"2026-11-21T05:06:37Z","purpose":"hok3516-dead-owner"}\n' "$stress_host" > "$lock_stress/owner.json"
  wins="$TMP/wins.$round"; : > "$wins"; stress_pids=()
  for i in 1 2 3 4; do
    ( if state_lock_acquire "$lock_stress" 100 0.01 "stress-$i"; then echo w >> "$wins"; state_lock_release "$lock_stress"; fi ) &
    stress_pids+=($!)
  done
  wait "${stress_pids[@]}"
  [[ ! -e "$lock_stress" || -f "$lock_stress/owner.json" ]] || { echo "FAIL: round $round stranded an ownerless lock directory" >&2; exit 1; }
  [[ -s "$wins" ]] || { echo "FAIL: round $round no waiter reclaimed the dead owner" >&2; exit 1; }
  command rm -rf "$lock_stress"
done
mkdir -p "$TMP/locks"
printf '%s\n' 99999999 > "$TMP/locks/tend-test.lock"
state_lock_reclaim_legacy "$TMP/locks/tend-test.lock" || { echo 'FAIL: dead legacy singleton not reclaimed at startup' >&2; exit 1; }
printf '%s\n' "$$" > "$TMP/locks/tend-test.lock"
if state_lock_reclaim_legacy "$TMP/locks/tend-test.lock"; then echo 'FAIL: live legacy singleton reclaimed' >&2; exit 1; fi
echo 'state-lock shell tests passed'
