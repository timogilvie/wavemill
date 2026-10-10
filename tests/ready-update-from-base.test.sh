#!/usr/bin/env bash
# Unit tests for the HOK-3092 update-from-base wiring:
#   - failed_ready_recheck_gate accepts an optional trailing base_sha and
#     drives the composite (head, base) reset from bounded-retry.sh.
#   - try_update_branch_from_base translates the CLI's exit codes into the
#     `not-behind` / `updated` / `conflict:<paths>` / `error:*` protocol the
#     failed-ready and conflict-remediation loops rely on.
#   - conflict-remediation-relaunch bucket terminalizes after one attempt on
#     identical (head, base) via bounded_retry_gate with limit=1.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

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

check_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$name"
  else
    echo "    missing: $needle"
    echo "    haystack: $haystack"
    fail "$name"
  fi
}

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

# Extract only the functions we need. Reuse the same awk-based extractor the
# launch-ready-phase suite uses so tests stay pinned to production shapes.
extract_function() {
  local source_file="$1" function_name="$2"
  awk -v name="$function_name" '
    function brace_delta(line, opened, closed) {
      opened = gsub(/\{/, "{", line)
      closed = gsub(/\}/, "}", line)
      return opened - closed
    }
    $0 ~ "^" name "\\(\\) \\{" { capture=1; depth=0 }
    capture {
      print
      depth += brace_delta($0)
      if (depth == 0) { exit }
    }
  ' "$source_file"
}

FUNC_FILE="$TEST_TMP/ready-update-from-base.sh"
: > "$FUNC_FILE"
cat "$REPO_DIR/shared/lib/bounded-retry.sh" >> "$FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "coding_compare_commit_counts" >> "$FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "failed_ready_recheck_count"        >> "$FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "clear_failed_ready_recheck_state"  >> "$FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "failed_ready_recheck_reset_if_new_head" >> "$FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "increment_failed_ready_recheck_count"   >> "$FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "failed_ready_recheck_backoff_seconds"   >> "$FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "failed_ready_recheck_due"               >> "$FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "failed_ready_recheck_identical_streak"  >> "$FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "failed_ready_recheck_gate"              >> "$FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "try_update_branch_from_base"            >> "$FUNC_FILE"

# The monitor helper delegates the base-ref lookup to wavemill-common; the
# ref is only used inside `coding_compare_commit_counts` for a git rev-list
# call, so a minimal shim keeps this test hermetic.
cat >> "$FUNC_FILE" <<'STUB'
wavemill_base_compare_ref() {
  printf 'origin/%s\n' "$1"
}
# HOK-3190: monitor rewrote `npx tsx <tool>` to `wavemill_run_tool <tool>`;
# this test extracts try_update_branch_from_base standalone, so forward the
# shim to the test's `npx` stub.
wavemill_run_tool() {
  local tool="$1"; shift
  npx tsx "$tool" "$@"
}
export -f wavemill_run_tool 2>/dev/null || true
STUB

# shellcheck disable=SC1090
source "$FUNC_FILE"

# ---------------------------------------------------------------------------
# 1) failed_ready_recheck_gate accepts a base_sha and honours the composite
#    reset (HOK-3092 REQ-F2).
# ---------------------------------------------------------------------------
SHA_HEAD="deadbee"
SHA_BASE_A="beefcaf"
SHA_BASE_B="c0ffee1"

dir="$TEST_TMP/gate-composite"
mkdir -p "$dir"
check_eq "gate proceeds with fresh (head, base)" \
  "$(failed_ready_recheck_gate "$dir" "$SHA_HEAD" "$SHA_BASE_A")" "proceed"
# Simulate enough failed attempts to hit the default ceiling
# (READY_FAILED_RECHECK_MAX_ATTEMPTS=4).
for i in 1 2 3 4; do
  increment_failed_ready_recheck_count "$dir" "$SHA_HEAD" "$SHA_BASE_A" >/dev/null
  printf '%s\n' "$(( $(date +%s) - 7200 ))" > "$dir/.failed-ready-recheck-last-at"
done
# `identical_limit` short-circuits before the ceiling when the reason streak
# is set; leave it unset for this test so the pure attempt ceiling drives.
check_eq "gate exhausted at ceiling on (head, base_a)" \
  "$(READY_FAILED_RECHECK_IDENTICAL_LIMIT=0 failed_ready_recheck_gate "$dir" "$SHA_HEAD" "$SHA_BASE_A")" "exhausted"
bounded_retry_mark_exhausted "$dir" "failed-ready-recheck" "spent on (head, base_a)" || true
# Same head, different base — a fresh merge parent invalidates the last
# outcome and gets a full set of attempts.
check_eq "gate resets on new base (same head)" \
  "$(READY_FAILED_RECHECK_IDENTICAL_LIMIT=0 failed_ready_recheck_gate "$dir" "$SHA_HEAD" "$SHA_BASE_B")" "proceed"
check_eq "new base cleared the counter" "$(failed_ready_recheck_count "$dir")" "0"
if bounded_retry_is_exhausted "$dir" "failed-ready-recheck"; then
  fail "new base clears exhausted sentinel"
else
  pass "new base clears exhausted sentinel"
fi

# Backwards compatibility: two-arg call (no base_sha) behaves like before.
dir="$TEST_TMP/gate-legacy"
mkdir -p "$dir"
check_eq "legacy 2-arg call still returns proceed" \
  "$(failed_ready_recheck_gate "$dir" "$SHA_HEAD")" "proceed"
increment_failed_ready_recheck_count "$dir" "$SHA_HEAD" >/dev/null
check_eq "legacy caller writes single-line key" \
  "$(bounded_retry_head "$dir" failed-ready-recheck)" "$SHA_HEAD"
check_eq "legacy caller has no base component" \
  "$(bounded_retry_base "$dir" failed-ready-recheck)" ""

# ---------------------------------------------------------------------------
# 2) try_update_branch_from_base — mock repo and stubbed CLI.
# ---------------------------------------------------------------------------
setup_repo() {
  local dir="$1" behind="$2"
  rm -rf "$dir"
  mkdir -p "$dir"
  export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com
  export GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
  git init -q --bare --initial-branch=main "$dir/origin.git"
  git init -q -b main "$dir/seed"
  git -C "$dir/seed" commit -q --allow-empty -m base
  git -C "$dir/seed" push -q "$dir/origin.git" HEAD:refs/heads/main
  git clone -q -b main "$dir/origin.git" "$dir/worktree"
  git -C "$dir/worktree" checkout -q -b task/foo
  printf 'work\n' > "$dir/worktree/f.txt"
  git -C "$dir/worktree" add f.txt
  git -C "$dir/worktree" commit -q -m work
  git -C "$dir/worktree" push -q -u origin task/foo
  if [[ "$behind" == "yes" ]]; then
    # Advance origin/main so the worktree is behind.
    git clone -q -b main "$dir/origin.git" "$dir/scratch"
    git -C "$dir/scratch" commit -q --allow-empty -m advance
    git -C "$dir/scratch" push -q origin main
    git -C "$dir/worktree" fetch -q origin main
  fi
}

# 2a) not-behind → returns 0, echoes not-behind, never invokes CLI.
dir="$TEST_TMP/case-not-behind"
setup_repo "$dir" no
TOOLS_DIR="$dir/tools"
mkdir -p "$TOOLS_DIR"
CLI_CALLS_FILE="$dir/cli-calls"
: > "$CLI_CALLS_FILE"
export CLI_CALLS_FILE
npx() { printf 'call: %s\n' "$*" >> "$CLI_CALLS_FILE"; return 0; }
export -f npx
result="$(try_update_branch_from_base HOK-XXXX "$dir/worktree" task/foo main)" && rc=0 || rc=$?
check_eq "not-behind returns 0" "$rc" "0"
check_eq "not-behind echoes marker" "$result" "not-behind"
check_eq "not-behind does not invoke CLI" \
  "$(wc -l < "$CLI_CALLS_FILE" | tr -d ' ')" "0"

# 2b) updated — stub the CLI to return status: success.
dir="$TEST_TMP/case-updated"
setup_repo "$dir" yes
TOOLS_DIR="$dir/tools"
mkdir -p "$TOOLS_DIR"
CLI_CALLS_FILE="$dir/cli-calls"
: > "$CLI_CALLS_FILE"
export CLI_CALLS_FILE
npx() {
  printf 'call: %s\n' "$*" >> "$CLI_CALLS_FILE"
  if [[ "$*" == *"update-branch-with-base.ts"* ]]; then
    printf '{"status":"success","detail":"updated task/foo with origin/main"}\n'
    return 0
  fi
  return 0
}
export -f npx
result="$(try_update_branch_from_base HOK-XXXX "$dir/worktree" task/foo main)" && rc=0 || rc=$?
check_eq "updated returns 0" "$rc" "0"
check_eq "updated echoes marker" "$result" "updated"
if grep -q "update-branch-with-base.ts" "$CLI_CALLS_FILE"; then
  pass "updated invokes the update CLI"
else
  fail "updated invokes the update CLI"
fi

# 2c) conflict → returns 0 (disposition in stdout), echoes conflict:<paths>.
dir="$TEST_TMP/case-conflict"
setup_repo "$dir" yes
TOOLS_DIR="$dir/tools"
mkdir -p "$TOOLS_DIR"
npx() {
  if [[ "$*" == *"update-branch-with-base.ts"* ]]; then
    printf '{"status":"conflict","detail":"CONFLICT (content): Merge conflict in README.md","conflictingFiles":["README.md","src/util.ts"]}\n'
    return 10
  fi
  return 0
}
export -f npx
result="$(try_update_branch_from_base HOK-XXXX "$dir/worktree" task/foo main)" && rc=0 || rc=$?
check_eq "conflict returns 0 (disposition in stdout)" "$rc" "0"
check_contains "conflict echoes marker with paths" "$result" "conflict:README.md src/util.ts"

# 2d) unknown-failed (e.g. bogus push failure) → returns 0, echoes error:*.
dir="$TEST_TMP/case-error"
setup_repo "$dir" yes
TOOLS_DIR="$dir/tools"
mkdir -p "$TOOLS_DIR"
npx() {
  if [[ "$*" == *"update-branch-with-base.ts"* ]]; then
    printf '{"status":"push-failed","detail":"remote rejected"}\n'
    return 13
  fi
  return 0
}
export -f npx
result="$(try_update_branch_from_base HOK-XXXX "$dir/worktree" task/foo main)" && rc=0 || rc=$?
check_eq "push-failed returns 0" "$rc" "0"
check_eq "push-failed echoes error marker" "$result" "error:push-failed"

# 2e) missing worktree directory is caller error, but still returns 0.
result="$(try_update_branch_from_base HOK-XXXX "$TEST_TMP/does-not-exist" task/foo main)" && rc=0 || rc=$?
check_eq "missing worktree returns 0" "$rc" "0"
check_eq "missing worktree echoes shape hint" "$result" "error:worktree-missing"

unset -f npx

# ---------------------------------------------------------------------------
# 3) conflict-remediation-relaunch bucket terminalizes after one attempt on
#    identical (head, base) (HOK-3092 REQ-F4).
# ---------------------------------------------------------------------------
dir="$TEST_TMP/conflict-relaunch"
mkdir -p "$dir"
check_eq "first attempt proceeds" \
  "$(bounded_retry_gate "$dir" "conflict-remediation-relaunch" "$SHA_HEAD" 1 "" "" "$SHA_BASE_A")" "proceed"
bounded_retry_increment "$dir" "conflict-remediation-relaunch" "$SHA_HEAD" "$SHA_BASE_A" >/dev/null
# Push last-at into the past so backoff is not the reason it holds.
printf '%s\n' "$(( $(date +%s) - 7200 ))" > "$dir/.retry-conflict-remediation-relaunch-last-at"
check_eq "second attempt on identical (head, base) is exhausted" \
  "$(bounded_retry_gate "$dir" "conflict-remediation-relaunch" "$SHA_HEAD" 1 "" "" "$SHA_BASE_A")" "exhausted"
bounded_retry_mark_exhausted "$dir" "conflict-remediation-relaunch" \
  "Conflict remediation exhausted on identical (head=$SHA_HEAD, base=$SHA_BASE_A) for PR #97" || true
# A greppable terminal reason is a REQ-F3 constraint.
if grep -q "Conflict remediation exhausted on identical (head=" "$dir/.retry-conflict-remediation-relaunch-exhausted"; then
  pass "terminal reason is greppable"
else
  fail "terminal reason is greppable"
fi
# New base_sha (base advanced) → budget is reset with the sentinel cleared.
check_eq "new base clears the conflict-relaunch budget" \
  "$(bounded_retry_gate "$dir" "conflict-remediation-relaunch" "$SHA_HEAD" 1 "" "" "$SHA_BASE_B")" "proceed"
if bounded_retry_is_exhausted "$dir" "conflict-remediation-relaunch"; then
  fail "new base clears exhausted sentinel"
else
  pass "new base clears exhausted sentinel"
fi

echo ""
echo "--- ready-update-from-base: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
