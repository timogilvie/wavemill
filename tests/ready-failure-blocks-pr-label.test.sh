#!/usr/bin/env bash
# HOK-3109: regression test for the ensure_ready_failure_blocks_pr monitor
# helper. The whole monitor_issue_state loop is covered by
# monitor-ready-transition.test.sh; this harness scopes down to just the new
# helper plus ready_failure_reason, extracted from the monitor source, so the
# per-head idempotency contract is pinned without a fat fixture.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

check_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$name"
  else
    echo "    missing: $needle"
    echo "    in: $haystack"
    fail "$name"
  fi
}

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

NPX_LOG="$TEST_TMP/npx.log"
STATE_DIR="$TEST_TMP/state"
WT_DIR="$TEST_TMP/worktree"
mkdir -p "$STATE_DIR" "$WT_DIR"

# .ready-result.json carries the exact failureReason from HOK-3105 so the
# bash extraction wires through to --reason as a human-readable string.
cat > "$STATE_DIR/.ready-result.json" <<'JSON'
{"stage":"ready","status":"failed","failureReason":"Cross-PR revert guard blocked ready phase","artifacts":{"verdict":"fail"}}
JSON

run_helper() {
  local head_sha="$1"
  NPX_LOG="$NPX_LOG" \
  HELPERS_FILE="$HELPERS_FILE" \
  STATE_DIR="$STATE_DIR" \
  WT_DIR="$WT_DIR" \
  TOOLS_DIR="/fake-tools" \
  REPO_DIR="/fake-repo" \
  HEAD_SHA="$head_sha" \
  bash -lc '
    set -euo pipefail
    source "$HELPERS_FILE"
    # HOK-3190: the extracted helper now spawns the TS tool through
    # wavemill_run_tool. The helper used to call `npx tsx <tool>` directly,
    # so this harness overrode `npx` to log every argument. Keep the same
    # observable shape by routing wavemill_run_tool back through npx.
    wavemill_run_tool() {
      local tool="${1:?wavemill_run_tool requires a tool basename}"
      shift
      npx tsx "$TOOLS_DIR/$tool" "$@"
    }
    export -f wavemill_run_tool
    # Mock npx so we observe what the wrapper would send to tsx without
    # actually launching Node. The arguments are preserved one per line for
    # easy grep in assertions.
    npx() {
      {
        printf "CALL\n"
        for arg in "$@"; do printf "ARG=%s\n" "$arg"; done
        printf "END\n"
      } >> "$NPX_LOG"
      return 0
    }
    export -f npx
    ensure_ready_failure_blocks_pr "$WT_DIR" "1519" "$STATE_DIR" "$HEAD_SHA"
  '
}

echo "=== HOK-3109: ensure_ready_failure_blocks_pr ==="

# Case 1: first failure for head H1 invokes npx with the extracted reason.
run_helper "H1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
log_contents_1="$(cat "$NPX_LOG")"
check_contains "first call invokes the TS tool" "$log_contents_1" "CALL"
check_contains "first call targets set-pr-blocked-label.ts" "$log_contents_1" "ARG=/fake-tools/set-pr-blocked-label.ts"
check_contains "first call passes the PR number" "$log_contents_1" "ARG=1519"
check_contains "first call passes --reason" "$log_contents_1" "ARG=--reason"
check_contains "first call includes the failureReason text" "$log_contents_1" "ARG=Cross-PR revert guard blocked ready phase"
check_contains "first call passes --head" "$log_contents_1" "ARG=--head"
check_contains "first call passes H1 head" "$log_contents_1" "ARG=H1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
check_contains "first call passes --marker-root" "$log_contents_1" "ARG=--marker-root"

marker_contents_1="$(cat "$STATE_DIR/.ready-blocked-label-head" 2>/dev/null || echo "MISSING")"
check_equals "marker written after first call" "H1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "$marker_contents_1"

first_call_count="$(grep -c '^CALL$' "$NPX_LOG" || true)"
check_equals "first call invokes npx exactly once" "1" "$first_call_count"

# Case 2: same head again is a no-op in the bash wrapper -- the marker
# short-circuits before any npx invocation.
run_helper "H1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
second_call_count="$(grep -c '^CALL$' "$NPX_LOG" || true)"
check_equals "second call for same head does not spawn npx" "1" "$second_call_count"

# Case 3: a new head simulates a fresh commit -- the marker mismatches, so
# the helper runs again and the marker is overwritten.
run_helper "H2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
third_call_count="$(grep -c '^CALL$' "$NPX_LOG" || true)"
check_equals "new head re-invokes npx" "2" "$third_call_count"
log_contents_3="$(cat "$NPX_LOG")"
check_contains "new head call passes H2" "$log_contents_3" "ARG=H2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
marker_contents_3="$(cat "$STATE_DIR/.ready-blocked-label-head" 2>/dev/null || echo "MISSING")"
check_equals "marker now points at H2" "H2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" "$marker_contents_3"

# Case 4: empty head is a safe no-op (never spawns npx).
: > "$NPX_LOG"
run_helper ""
empty_head_count="$(grep -c '^CALL$' "$NPX_LOG" || true)"
check_equals "empty head is a no-op" "0" "$empty_head_count"

# Case 5: when .ready-result.json has no failureReason, the helper falls
# back to a synthetic reason so --reason is never empty.
rm -f "$STATE_DIR/.ready-blocked-label-head" "$STATE_DIR/.ready-result.json"
: > "$NPX_LOG"
run_helper "H3cccccccccccccccccccccccccccccccccccccc"
log_contents_5="$(cat "$NPX_LOG")"
check_contains "missing failureReason falls back to synthetic reason" "$log_contents_5" "ARG=Ready checks failed for PR #1519"

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
