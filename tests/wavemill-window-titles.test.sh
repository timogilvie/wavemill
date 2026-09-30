#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=../shared/lib/wavemill-common.sh
source "$REPO_DIR/shared/lib/wavemill-common.sh"
# shellcheck source=../shared/lib/wavemill-window-titles.sh
source "$REPO_DIR/shared/lib/wavemill-window-titles.sh"

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

assert_eq() {
  local got="$1" want="$2" label="$3"
  if [[ "$got" == "$want" ]]; then
    pass "$label"
  else
    fail "$label (got='$got' want='$want')"
  fi
}

echo "=== Window Title Helper ==="

assert_eq "$(wavemill_window_branch_suffix 'task/feat/foo')" "foo" "branch suffix from slash-delimited branch"
assert_eq "$(wavemill_window_branch_suffix 'main')" "main" "branch suffix preserves plain branch"
assert_eq "$(wavemill_window_branch_suffix 'feature/a/b')" "b" "branch suffix uses last segment"
assert_eq "$(wavemill_window_branch_suffix '')" "" "branch suffix empty input"
assert_eq "$(wavemill_window_branch_suffix 'foo/')" "foo/" "branch suffix trailing slash falls back"

assert_eq "$(wavemill_window_pr_badge 'MERGED')" "✓" "badge merged"
assert_eq "$(wavemill_window_pr_badge 'OPEN')" "●" "badge open default"
assert_eq "$(wavemill_window_pr_badge 'OPEN' 'pass')" "✓" "badge open pass"
assert_eq "$(wavemill_window_pr_badge 'OPEN' 'fail')" "✗" "badge open fail"
assert_eq "$(wavemill_window_pr_badge 'OPEN' 'pending')" "…" "badge open pending"
assert_eq "$(wavemill_window_pr_badge 'CLOSED')" "✗" "badge closed"
assert_eq "$(wavemill_window_pr_badge 'DRAFT')" "…" "badge draft"
assert_eq "$(wavemill_window_pr_badge 'UNKNOWN')" "" "badge unknown"

assert_eq "$(wavemill_window_phase_label 'planning')" "plan" "phase planning"
assert_eq "$(wavemill_window_phase_label 'executing')" "code" "phase executing"
assert_eq "$(wavemill_window_phase_label 'coding')" "code" "phase coding"
assert_eq "$(wavemill_window_phase_label 'ready')" "review" "phase ready"
assert_eq "$(wavemill_window_phase_label 'review')" "review" "phase review"
assert_eq "$(wavemill_window_phase_label 'unknown')" "" "phase unknown omitted"

assert_eq "$(wavemill_build_window_title 'HOK-1857' 'task/feat/foo' '650' 'MERGED' 'coding' 'Bash')" "1857 · foo · PR#650 ✓ · code · Bash" "full title"
assert_eq "$(wavemill_build_window_title 'HOK-1857' 'task/feat/foo' '' '' 'coding' 'Bash')" "1857 · foo · code · Bash" "missing pr omitted cleanly"
assert_eq "$(wavemill_build_window_title 'HOK-1857' '' '650' 'OPEN' 'coding' 'Bash')" "1857 · PR#650 ● · code · Bash" "missing branch still renders"
assert_eq "$(wavemill_build_window_title 'HOK-1857' 'task/feat/foo' '650' 'OPEN' '' 'Bash')" "1857 · foo · PR#650 ● · Bash" "missing phase omitted"
assert_eq "$(wavemill_build_window_title 'HOK-1857' 'task/feat/foo' '650' 'OPEN' 'coding' '')" "1857 · foo · PR#650 ● · code" "missing notification omitted"
assert_eq "$(wavemill_build_window_title 'HOK-1857' '' '' '' '' '')" "1857" "only issue"
assert_eq "$(wavemill_build_window_title 'AB2-1_c' '' '' '' '' '')" "1" "digit-bearing team key"
assert_eq "$(wavemill_build_window_title 'custom-key' 'feat/foo' '' '' '' '')" "custom-key · foo" "non-standard issue key kept"

assert_eq "$(wavemill_build_status_right '3000,5173' 'claude-sonnet-4-6')" "ports: 3000,5173 | model: claude-sonnet-4-6" "status-right both"
assert_eq "$(wavemill_build_status_right '3000,5173' '')" "ports: 3000,5173" "status-right ports only"
assert_eq "$(wavemill_build_status_right '' 'claude-sonnet-4-6')" "model: claude-sonnet-4-6" "status-right model only"
assert_eq "$(wavemill_build_status_right '' '')" "" "status-right neither"

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
HOOK_FILE="$TMP_ROOT/hook.json"
printf '{"state":"working","timestamp":1,"pr_state":{"number":10,"state":"OPEN","fetched_at":200}}\n' > "$HOOK_FILE"
SESSION='testsession'
ISSUE='HOK-1857'

wavemill_hook_file_path() { printf '%s\n' "$HOOK_FILE"; }

now_epoch="220"
date() {
  if [[ "${1:-}" == "+%s" ]]; then
    printf '%s\n' "$now_epoch"
    return 0
  fi
  command date "$@"
}

GH_CALLS=0
GH_CALLS_FILE="$TMP_ROOT/gh-calls"
printf '0\n' > "$GH_CALLS_FILE"
gh() {
  local n
  n="$(cat "$GH_CALLS_FILE")"
  n=$((n + 1))
  printf '%s\n' "$n" > "$GH_CALLS_FILE"
  printf '{"number":650,"state":"OPEN","isDraft":false}\n'
}

fresh_cache="$(wavemill_fetch_pr_state "$SESSION" "$ISSUE" 'task/feat/foo')"
assert_eq "$GH_CALLS" "0" "fresh cache avoids gh"
assert_eq "$(jq -r '.number' <<< "$fresh_cache")" "10" "fresh cache returns cached payload"

now_epoch="400"
stale_cache="$(wavemill_fetch_pr_state "$SESSION" "$ISSUE" 'task/feat/foo')"
assert_eq "$(cat "$GH_CALLS_FILE")" "1" "stale cache triggers gh"
assert_eq "$(jq -r '.number' <<< "$stale_cache")" "650" "stale refresh returns gh payload"
assert_eq "$(jq -r '.pr_state.number' "$HOOK_FILE")" "650" "stale refresh updates hook cache"

now_epoch="500"
gh() {
  local n
  n="$(cat "$GH_CALLS_FILE")"
  n=$((n + 1))
  printf '%s\n' "$n" > "$GH_CALLS_FILE"
  return 1
}
failed_refresh="$(wavemill_fetch_pr_state "$SESSION" "$ISSUE" 'task/feat/foo')"
assert_eq "$(jq -r '.number' <<< "$failed_refresh")" "650" "gh failure falls back to stale cache"

if command -v lsof >/dev/null 2>&1; then
  # Stub lsof output for deterministic parser coverage.
  lsof() {
    cat <<'LSOF'
COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
node    11111 you   20u  IPv4 0x      0t0  TCP *:5173 (LISTEN)
node    11111 you   21u  IPv4 0x      0t0  TCP 127.0.0.1:3000 (LISTEN)
node    22222 you   22u  IPv4 0x      0t0  TCP *:5173 (LISTEN)
LSOF
  }
  wavemill_collect_pid_tree() {
    printf '11111\n22222\n'
  }
  assert_eq "$(wavemill_discover_listening_ports '11111')" "3000,5173" "port parser dedupes and sorts"
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
if [[ "$FAIL" -ne 0 ]]; then
  exit 1
fi
