#!/usr/bin/env bash
# Unit tests for shared/lib/bounded-retry.sh (HOK-2924): attempt counting,
# exponential backoff, ceiling, head-keyed reset, and terminal short-circuit.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=../shared/lib/bounded-retry.sh
source "$REPO_DIR/shared/lib/bounded-retry.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

check_eq() {
  local name="$1" actual="$2" expected="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass "$name"
  else
    echo "    expected: $expected"
    echo "    actual:   $actual"
    fail "$name"
  fi
}

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

fresh_dir() {
  local dir="$TEST_TMP/$1"
  rm -rf "$dir"
  mkdir -p "$dir"
  echo "$dir"
}

# --- count / increment / clear roundtrip -------------------------------------
dir="$(fresh_dir roundtrip)"
check_eq "count starts at 0" "$(bounded_retry_count "$dir" demo)" "0"
check_eq "increment returns 1" "$(bounded_retry_increment "$dir" demo sha-a)" "1"
check_eq "increment returns 2" "$(bounded_retry_increment "$dir" demo sha-a)" "2"
check_eq "count reads back 2" "$(bounded_retry_count "$dir" demo)" "2"
check_eq "head reads back" "$(bounded_retry_head "$dir" demo)" "sha-a"
last_at="$(bounded_retry_last_at "$dir" demo)"
if [[ "$last_at" =~ ^[0-9]+$ ]]; then
  pass "last_at is an epoch timestamp"
else
  fail "last_at is an epoch timestamp"
fi
bounded_retry_clear "$dir" demo
check_eq "clear resets count" "$(bounded_retry_count "$dir" demo)" "0"
check_eq "clear resets head" "$(bounded_retry_head "$dir" demo)" ""
check_eq "clear resets last_at" "$(bounded_retry_last_at "$dir" demo)" ""

# Corrupt counter reads as 0.
dir="$(fresh_dir corrupt)"
printf 'not-a-number\n' > "$dir/.retry-demo-count"
check_eq "corrupt counter reads as 0" "$(bounded_retry_count "$dir" demo)" "0"

# --- reset_if_new_head -------------------------------------------------------
dir="$(fresh_dir head-reset)"
bounded_retry_increment "$dir" demo sha-a >/dev/null
bounded_retry_mark_exhausted "$dir" demo "stuck" || true
bounded_retry_reset_if_new_head "$dir" demo sha-a
check_eq "same head keeps count" "$(bounded_retry_count "$dir" demo)" "1"
bounded_retry_reset_if_new_head "$dir" demo ""
check_eq "empty head keeps count" "$(bounded_retry_count "$dir" demo)" "1"
bounded_retry_reset_if_new_head "$dir" demo sha-b
check_eq "new head clears count" "$(bounded_retry_count "$dir" demo)" "0"
if bounded_retry_is_exhausted "$dir" demo; then
  fail "new head clears exhausted sentinel"
else
  pass "new head clears exhausted sentinel"
fi

# Reset with no recorded head is a no-op (nothing to compare against).
dir="$(fresh_dir head-unset)"
bounded_retry_reset_if_new_head "$dir" demo sha-a
check_eq "reset with no stored head is a no-op" "$(bounded_retry_count "$dir" demo)" "0"

# --- backoff_seconds ---------------------------------------------------------
check_eq "backoff attempt 1" "$(bounded_retry_backoff_seconds 1 120 1800)" "120"
check_eq "backoff attempt 2 doubles" "$(bounded_retry_backoff_seconds 2 120 1800)" "240"
check_eq "backoff attempt 4" "$(bounded_retry_backoff_seconds 4 120 1800)" "960"
check_eq "backoff caps" "$(bounded_retry_backoff_seconds 10 120 1800)" "1800"
check_eq "backoff count 0 treated as 1" "$(bounded_retry_backoff_seconds 0 120 1800)" "120"
check_eq "backoff non-numeric count treated as 1" "$(bounded_retry_backoff_seconds bogus 120 1800)" "120"
check_eq "backoff default base" "$(bounded_retry_backoff_seconds 1)" "120"
check_eq "backoff default cap" "$(bounded_retry_backoff_seconds 20)" "1800"
check_eq "backoff global env override" \
  "$(WAVEMILL_RETRY_BACKOFF_BASE_SECONDS=7 WAVEMILL_RETRY_BACKOFF_CAP_SECONDS=9 bounded_retry_backoff_seconds 2)" "9"

# --- due ---------------------------------------------------------------------
dir="$(fresh_dir due)"
if bounded_retry_due "$dir" demo; then
  pass "due with no attempts"
else
  fail "due with no attempts"
fi
bounded_retry_increment "$dir" demo sha-a >/dev/null
if bounded_retry_due "$dir" demo; then
  fail "not due immediately after an attempt"
else
  pass "not due immediately after an attempt"
fi
printf '%s\n' "$(( $(date +%s) - 121 ))" > "$dir/.retry-demo-last-at"
if bounded_retry_due "$dir" demo; then
  pass "due after the backoff window elapses"
else
  fail "due after the backoff window elapses"
fi
# Per-bucket env override widens the window.
printf '%s\n' "$(( $(date +%s) - 121 ))" > "$dir/.retry-demo-last-at"
if WAVEMILL_RETRY_BACKOFF_DEMO_BASE_SECONDS=600 bounded_retry_due "$dir" demo; then
  fail "per-bucket env base widens the backoff window"
else
  pass "per-bucket env base widens the backoff window"
fi

# --- mark_exhausted / is_exhausted / reason ----------------------------------
dir="$(fresh_dir exhausted)"
if bounded_retry_mark_exhausted "$dir" demo "unroutable model: nope-1"; then
  pass "mark_exhausted returns 0 on first call"
else
  fail "mark_exhausted returns 0 on first call"
fi
if bounded_retry_mark_exhausted "$dir" demo "second reason"; then
  fail "mark_exhausted returns 1 when already exhausted"
else
  pass "mark_exhausted returns 1 when already exhausted"
fi
check_eq "exhaustion reason preserved from first call" \
  "$(bounded_retry_exhaustion_reason "$dir" demo)" "unroutable model: nope-1"
if bounded_retry_is_exhausted "$dir" demo; then
  pass "is_exhausted after mark"
else
  fail "is_exhausted after mark"
fi
check_eq "terminal cause consumes no attempts" "$(bounded_retry_count "$dir" demo)" "0"
check_eq "gate is exhausted-quiet after terminal mark" \
  "$(bounded_retry_gate "$dir" demo sha-a 4)" "exhausted-quiet"

# --- gate --------------------------------------------------------------------
dir="$(fresh_dir gate)"
check_eq "gate proceeds with fresh bucket" "$(bounded_retry_gate "$dir" demo sha-a 2)" "proceed"
bounded_retry_increment "$dir" demo sha-a >/dev/null
check_eq "gate backs off inside the window" "$(bounded_retry_gate "$dir" demo sha-a 2)" "backoff"
printf '%s\n' "$(( $(date +%s) - 7200 ))" > "$dir/.retry-demo-last-at"
check_eq "gate proceeds once due" "$(bounded_retry_gate "$dir" demo sha-a 2)" "proceed"
bounded_retry_increment "$dir" demo sha-a >/dev/null
printf '%s\n' "$(( $(date +%s) - 7200 ))" > "$dir/.retry-demo-last-at"
check_eq "gate exhausted at the ceiling" "$(bounded_retry_gate "$dir" demo sha-a 2)" "exhausted"
bounded_retry_mark_exhausted "$dir" demo "budget spent" || true
check_eq "gate exhausted-quiet after terminalization" "$(bounded_retry_gate "$dir" demo sha-a 2)" "exhausted-quiet"
check_eq "gate resets on a new head" "$(bounded_retry_gate "$dir" demo sha-b 2)" "proceed"
check_eq "new head cleared the counter" "$(bounded_retry_count "$dir" demo)" "0"

# --- bucket isolation --------------------------------------------------------
dir="$(fresh_dir isolation)"
bounded_retry_increment "$dir" alpha sha-a >/dev/null
bounded_retry_increment "$dir" alpha sha-a >/dev/null
bounded_retry_increment "$dir" beta sha-z >/dev/null
check_eq "bucket alpha count isolated" "$(bounded_retry_count "$dir" alpha)" "2"
check_eq "bucket beta count isolated" "$(bounded_retry_count "$dir" beta)" "1"
bounded_retry_clear "$dir" alpha
check_eq "clearing alpha leaves beta" "$(bounded_retry_count "$dir" beta)" "1"
bounded_retry_mark_exhausted "$dir" beta "done" || true
if bounded_retry_is_exhausted "$dir" alpha; then
  fail "exhausting beta leaves alpha live"
else
  pass "exhausting beta leaves alpha live"
fi

# --- legacy file names for failed-ready-recheck ------------------------------
dir="$(fresh_dir legacy)"
bounded_retry_increment "$dir" failed-ready-recheck sha-a >/dev/null
if [[ -f "$dir/.failed-ready-recheck-count" ]]; then
  pass "failed-ready-recheck keeps legacy file names"
else
  fail "failed-ready-recheck keeps legacy file names"
fi
printf '{"reason":"x"}\n' > "$dir/.failed-ready-recheck-reason.json"
bounded_retry_clear "$dir" failed-ready-recheck
if [[ -e "$dir/.failed-ready-recheck-reason.json" ]]; then
  fail "clear removes prefix companions (reason.json)"
else
  pass "clear removes prefix companions (reason.json)"
fi

# --- greppable sentinel (REQ-F3) ---------------------------------------------
dir="$(fresh_dir greppable)"
bounded_retry_mark_exhausted "$dir" phase-launch-coding "coding launch failed 3x at sha-a" || true
if grep -rq "coding launch failed 3x at sha-a" "$dir"; then
  pass "terminal reason is greppable under the state dir"
else
  fail "terminal reason is greppable under the state dir"
fi

# --- composite (head, base) key (HOK-3092) -----------------------------------
# Use hex-shaped values so bounded_retry_gate's SHA-shape guard (which drops
# a non-SHA base as "safe default") does not force the head-only path here.
SHA_HEAD_A="aaaaaaa"
SHA_BASE_1="bbbbbb1"
SHA_BASE_2="bbbbbb2"

dir="$(fresh_dir composite-key)"
bounded_retry_increment "$dir" demo "$SHA_HEAD_A" "$SHA_BASE_1" >/dev/null
check_eq "composite key head reads back" "$(bounded_retry_head "$dir" demo)" "$SHA_HEAD_A"
check_eq "composite key base reads back" "$(bounded_retry_base "$dir" demo)" "$SHA_BASE_1"
# Same head with a different base wipes the budget (fresh merge parent).
bounded_retry_reset_if_new_key "$dir" demo "$SHA_HEAD_A" "$SHA_BASE_2"
check_eq "new base clears count" "$(bounded_retry_count "$dir" demo)" "0"

dir="$(fresh_dir composite-key-same)"
bounded_retry_increment "$dir" demo "$SHA_HEAD_A" "$SHA_BASE_1" >/dev/null
bounded_retry_increment "$dir" demo "$SHA_HEAD_A" "$SHA_BASE_1" >/dev/null
bounded_retry_reset_if_new_key "$dir" demo "$SHA_HEAD_A" "$SHA_BASE_1"
check_eq "identical (head, base) keeps count" "$(bounded_retry_count "$dir" demo)" "2"

dir="$(fresh_dir composite-key-empty-base)"
bounded_retry_increment "$dir" demo "$SHA_HEAD_A" "$SHA_BASE_1" >/dev/null
# Empty base_sha (e.g. transient ls-remote failure) is head-only reset:
# base component is ignored, and stored base is preserved through the tick.
bounded_retry_reset_if_new_key "$dir" demo "$SHA_HEAD_A" ""
check_eq "empty base leaves count intact" "$(bounded_retry_count "$dir" demo)" "1"
check_eq "empty base preserves stored base" "$(bounded_retry_base "$dir" demo)" "$SHA_BASE_1"
bounded_retry_increment "$dir" demo "$SHA_HEAD_A" "" >/dev/null
check_eq "increment without base preserves stored base" \
  "$(bounded_retry_base "$dir" demo)" "$SHA_BASE_1"

# gate accepts the optional trailing base and drives the composite reset.
dir="$(fresh_dir gate-composite)"
check_eq "gate proceeds with (head, base)" \
  "$(bounded_retry_gate "$dir" demo "$SHA_HEAD_A" 2 "" "" "$SHA_BASE_1")" "proceed"
bounded_retry_increment "$dir" demo "$SHA_HEAD_A" "$SHA_BASE_1" >/dev/null
printf '%s\n' "$(( $(date +%s) - 7200 ))" > "$dir/.retry-demo-last-at"
bounded_retry_increment "$dir" demo "$SHA_HEAD_A" "$SHA_BASE_1" >/dev/null
printf '%s\n' "$(( $(date +%s) - 7200 ))" > "$dir/.retry-demo-last-at"
check_eq "gate exhausted at ceiling (composite key)" \
  "$(bounded_retry_gate "$dir" demo "$SHA_HEAD_A" 2 "" "" "$SHA_BASE_1")" "exhausted"
bounded_retry_mark_exhausted "$dir" demo "budget spent on ($SHA_HEAD_A, $SHA_BASE_1)" || true
check_eq "gate resets on new base (same head)" \
  "$(bounded_retry_gate "$dir" demo "$SHA_HEAD_A" 2 "" "" "$SHA_BASE_2")" "proceed"
check_eq "new-base reset cleared the counter" "$(bounded_retry_count "$dir" demo)" "0"
if bounded_retry_is_exhausted "$dir" demo; then
  fail "new base clears exhausted sentinel"
else
  pass "new base clears exhausted sentinel"
fi

# gate ignores a non-SHA base (safe default).
dir="$(fresh_dir gate-bogus-base)"
bounded_retry_increment "$dir" demo "$SHA_HEAD_A" "$SHA_BASE_1" >/dev/null
check_eq "gate ignores non-SHA base" \
  "$(bounded_retry_gate "$dir" demo "$SHA_HEAD_A" 2 "" "" 'not!a!sha')" "backoff"
check_eq "bogus base leaves stored base intact" \
  "$(bounded_retry_base "$dir" demo)" "$SHA_BASE_1"

# Existing head-only callers keep working when they never supply a base.
dir="$(fresh_dir head-only-legacy)"
bounded_retry_increment "$dir" demo "$SHA_HEAD_A" >/dev/null
check_eq "legacy caller writes single-line key" \
  "$(bounded_retry_head "$dir" demo)" "$SHA_HEAD_A"
check_eq "legacy caller has no base component" "$(bounded_retry_base "$dir" demo)" ""
bounded_retry_reset_if_new_head "$dir" demo "$SHA_HEAD_A"
check_eq "legacy reset with same head keeps count" \
  "$(bounded_retry_count "$dir" demo)" "1"

echo ""
echo "bounded-retry: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
