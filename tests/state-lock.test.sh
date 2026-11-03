#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/shared/lib/state-lock.sh"
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
