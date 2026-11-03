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
echo 'state-lock shell tests passed'
