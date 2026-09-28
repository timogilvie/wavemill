#!/usr/bin/env bash
# Unit tests for shared/lib/plan-packet-binding.sh (HOK-3099).
# Verifies that the plan<->packet hash marker is recorded, checked, and used
# to detect divergence between an approved plan and a regenerated packet at
# the plan->code handoff.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=../shared/lib/plan-packet-binding.sh
source "$REPO_DIR/shared/lib/plan-packet-binding.sh"

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

write_packet_split() {
  local dir="$1" body="$2"
  printf '# Task Packet\n\n## Quick Reference\n%s\n' "$body" > "$dir/task-packet-header.md"
  printf '## Detailed Sections\n%s\n' "$body" > "$dir/task-packet-details.md"
}

write_packet_single() {
  local dir="$1" body="$2"
  printf '# Task Packet\n\n## 1. Objective\n%s\n' "$body" > "$dir/task-packet.md"
}

write_plan() {
  local dir="$1" body="$2"
  printf '# Plan\n\n%s\n' "$body" > "$dir/plan.md"
}

# --- hash availability -------------------------------------------------------
if plan_packet_hash_available; then
  pass "hash tool available"
else
  echo "SKIP: no sha256sum/shasum available"
  exit 0
fi

# --- current_hash split roundtrip -------------------------------------------
dir="$(fresh_dir split)"
write_packet_split "$dir" "alpha"
line="$(plan_packet_current_hash "$dir")"
hash="${line%%$'\t'*}"
kind="${line#*$'\t'}"
if [[ "$hash" =~ ^[0-9a-f]{64}$ ]]; then
  pass "split packet hash is 64 hex chars"
else
  fail "split packet hash format: $hash"
fi
check_eq "split kind" "$kind" "split"

# Repeated hash of same content is stable.
line2="$(plan_packet_current_hash "$dir")"
check_eq "split hash stable" "$line2" "$line"

# --- current_hash single roundtrip ------------------------------------------
dir="$(fresh_dir single)"
write_packet_single "$dir" "beta"
line="$(plan_packet_current_hash "$dir")"
kind="${line#*$'\t'}"
check_eq "single kind" "$kind" "single"

# --- current_hash prefers split ---------------------------------------------
dir="$(fresh_dir prefer-split)"
write_packet_split "$dir" "gamma"
write_packet_single "$dir" "different"
line="$(plan_packet_current_hash "$dir")"
kind="${line#*$'\t'}"
check_eq "prefers split when both exist" "$kind" "split"

# --- current_hash returns 1 when no packet ----------------------------------
dir="$(fresh_dir empty)"
if plan_packet_current_hash "$dir" >/dev/null 2>&1; then
  fail "no-packet returns non-zero"
else
  pass "no-packet returns non-zero"
fi

# --- record + read binding roundtrip ----------------------------------------
dir="$(fresh_dir record)"
write_packet_split "$dir" "delta"
write_plan "$dir" "plan body"
plan_packet_record_binding "$dir" "approval"
if [[ -f "$dir/.plan-packet-hash" ]]; then
  pass "record writes marker"
else
  fail "record writes marker"
fi
recorded_packet="$(plan_packet_recorded_packet_hash "$dir")"
current_packet="$(plan_packet_current_hash "$dir" | awk '{print $1}')"
check_eq "recorded packet matches current" "$recorded_packet" "$current_packet"

recorded_plan="$(plan_packet_recorded_plan_hash "$dir")"
if [[ "$recorded_plan" =~ ^[0-9a-f]{64}$ ]]; then
  pass "recorded plan hash is 64 hex chars"
else
  fail "recorded plan hash: $recorded_plan"
fi

# --- unchanged packet -> match ----------------------------------------------
result="$(plan_packet_check_binding "$dir")"
check_eq "unchanged packet => match" "$result" "match"

# --- HOK-2820 scenario: recovery writes a new packet after approval ---------
dir="$(fresh_dir hok2820)"
# Simulate: no packet at approval time (approval records nothing usable).
write_plan "$dir" "stale plan written from pre-expansion description"
sleep 1 # ensure mtime differs
# Now recovery generates the packet.
write_packet_split "$dir" "expanded packet with hard constraints"
# Without any marker, this is legacy_stale (packet newer than plan).
result="$(plan_packet_check_binding "$dir")"
check_eq "HOK-2820: recovery after approval => legacy_stale" "$result" "legacy_stale"

# --- packet edited after approval -> mismatch --------------------------------
dir="$(fresh_dir edited)"
write_packet_split "$dir" "original"
write_plan "$dir" "original plan"
plan_packet_record_binding "$dir" "approval"
write_packet_split "$dir" "edited packet body"
result="$(plan_packet_check_binding "$dir")"
check_eq "packet edited => mismatch" "$result" "mismatch"

# --- no packet at all ---------------------------------------------------------
dir="$(fresh_dir no-packet)"
write_plan "$dir" "solo plan"
result="$(plan_packet_check_binding "$dir")"
check_eq "no packet => no_packet" "$result" "no_packet"

# --- legacy plan (marker absent, packet older than plan) -> legacy ----------
dir="$(fresh_dir legacy-safe)"
write_packet_split "$dir" "existing packet"
sleep 1
write_plan "$dir" "plan written after packet"
result="$(plan_packet_check_binding "$dir")"
check_eq "legacy: plan newer than packet => legacy" "$result" "legacy"

# --- malformed marker -> treated as legacy ----------------------------------
dir="$(fresh_dir malformed)"
write_packet_split "$dir" "body"
write_plan "$dir" "plan"
printf 'not-json\n' > "$dir/.plan-packet-hash"
result="$(plan_packet_check_binding "$dir")"
# Malformed marker yields empty recorded packet hash → falls through to
# legacy or legacy_stale via mtime fallback. Either is acceptable (fail
# open); we require it not be "match" or "mismatch".
case "$result" in
  legacy|legacy_stale)
    pass "malformed marker fails open to legacy/legacy_stale"
    ;;
  *)
    fail "malformed marker returned unexpected: $result"
    ;;
esac

# --- preserve_stale_plan renames plan.md ------------------------------------
dir="$(fresh_dir preserve)"
write_plan "$dir" "will be preserved"
plan_packet_preserve_stale_plan "$dir"
if [[ ! -f "$dir/plan.md" ]]; then
  pass "preserve removes plan.md"
else
  fail "preserve removes plan.md"
fi
stale_count="$(find "$dir" -maxdepth 1 -name 'plan.stale-*.md' 2>/dev/null | wc -l | tr -d '[:space:]')"
if [[ "$stale_count" -ge 1 ]]; then
  pass "preserve writes plan.stale-*.md"
else
  fail "preserve did not create plan.stale-*.md"
fi

# --- preserve is a no-op when plan.md is absent -----------------------------
dir="$(fresh_dir preserve-empty)"
plan_packet_preserve_stale_plan "$dir"
pass "preserve is a no-op without plan.md"

# --- second divergence at same packet head is admitted only once ------------
# The bounded-retry gate (ceiling 1) is enforced at the caller. Here we just
# check that repeatedly regenerating the same packet leaves the marker in a
# consistent state so the caller's bounded-retry key stays stable.
dir="$(fresh_dir second-divergence)"
write_packet_split "$dir" "orig"
write_plan "$dir" "plan"
plan_packet_record_binding "$dir" "approval"
write_packet_split "$dir" "regenerated"
first_current="$(plan_packet_current_hash "$dir" | awk '{print $1}')"
second_current="$(plan_packet_current_hash "$dir" | awk '{print $1}')"
check_eq "regenerated packet hash is stable across reads" "$first_current" "$second_current"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
