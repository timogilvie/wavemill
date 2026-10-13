#!/usr/bin/env bash
# HOK-3181: regression test for ensure_ready_failure_blocks_pr marker writing.
# HOK-3109: the label is now written by the reconciler on the next tend tick.
# This test pins the marker idempotency contract: the helper writes the marker
# only once per head, without calling any external tools.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

check_equals() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$name"
  else
    echo "    expected: $expected"
    echo "    actual:   $actual"
    fail "$name"
  fi
}

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

extract_function() {
  local source_file="$1"
  local function_name="$2"
  awk -v name="$function_name" '
    $0 ~ "^" name "\\(\\) \\{" { capture=1 }
    capture { print }
    capture && $0 == "}" { exit }
  ' "$source_file"
}

HELPERS_FILE="$TEST_TMP/helpers.sh"
: > "$HELPERS_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "ready_failure_reason" >> "$HELPERS_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "ensure_ready_failure_blocks_pr" >> "$HELPERS_FILE"

if ! grep -q 'ensure_ready_failure_blocks_pr' "$HELPERS_FILE"; then
  echo "Could not extract ensure_ready_failure_blocks_pr from $MONITOR_SCRIPT_FILE" >&2
  exit 1
fi

STATE_DIR="$TEST_TMP/state"
WT_DIR="$TEST_TMP/worktree"
mkdir -p "$STATE_DIR" "$WT_DIR"

# .ready-result.json carries the failureReason so ready_failure_reason can extract it
cat > "$STATE_DIR/.ready-result.json" <<'JSON'
{"stage":"ready","status":"failed","failureReason":"Cross-PR revert guard blocked ready phase","artifacts":{"verdict":"fail"}}
JSON

run_helper() {
  local head_sha="$1"
  HELPERS_FILE="$HELPERS_FILE" \
  STATE_DIR="$STATE_DIR" \
  WT_DIR="$WT_DIR" \
  REPO_DIR="/fake-repo" \
  HEAD_SHA="$head_sha" \
  bash -lc '
    set -euo pipefail
    source "$HELPERS_FILE"
    ensure_ready_failure_blocks_pr "$WT_DIR" "1519" "$STATE_DIR" "$HEAD_SHA"
  '
}

echo "=== HOK-3181: ensure_ready_failure_blocks_pr marker writing ==="

# Case 1: first failure for head H1 writes the marker
run_helper "H1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
marker_contents_1="$(cat "$STATE_DIR/.ready-blocked-label-head" 2>/dev/null || echo "MISSING")"
check_equals "marker written on first call" "H1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "$marker_contents_1"

# Case 2: same head again is idempotent -- marker unchanged
run_helper "H1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
marker_contents_2="$(cat "$STATE_DIR/.ready-blocked-label-head" 2>/dev/null || echo "MISSING")"
check_equals "marker unchanged for same head" "H1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "$marker_contents_2"

# Case 3: a new head overwrites the marker
run_helper "H2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
marker_contents_3="$(cat "$STATE_DIR/.ready-blocked-label-head" 2>/dev/null || echo "MISSING")"
check_equals "marker overwritten for new head" "H2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" "$marker_contents_3"

# Case 4: empty head writes no marker (early exit)
rm -f "$STATE_DIR/.ready-blocked-label-head"
run_helper ""
marker_contents_4="$(cat "$STATE_DIR/.ready-blocked-label-head" 2>/dev/null || echo "MISSING")"
check_equals "empty head writes no marker" "MISSING" "$marker_contents_4"

# Case 5: missing .ready-result.json does not block marker writing
rm -f "$STATE_DIR/.ready-blocked-label-head" "$STATE_DIR/.ready-result.json"
run_helper "H5eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
marker_contents_5="$(cat "$STATE_DIR/.ready-blocked-label-head" 2>/dev/null || echo "MISSING")"
check_equals "marker written even without .ready-result.json" "H5eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" "$marker_contents_5"

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
