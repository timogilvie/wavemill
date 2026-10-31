#!/usr/bin/env bash
# Unit tests for the update-from-base wiring:
#   - ready_failure_base_drift (HOK-3371) gates the head move on real drift
#     evidence: a CONFLICT signature, a base-drift signature in the recorded
#     detail, or red CI with no transition failure and an observably behind
#     branch. Any other Ready failure skips the update entirely.
#   - try_update_branch_from_base translates the CLI's exit codes into the
#     `not-behind` / `updated` / `conflict:<paths>` / `error:*` protocol the
#     Ready disposition helper relies on.
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
extract_function "$MONITOR_SCRIPT_FILE" "ready_failure_reason"          >> "$FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "ready_failure_evidence_detail" >> "$FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "ready_failure_base_drift"      >> "$FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "try_update_branch_from_base"   >> "$FUNC_FILE"

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
# 1) ready_failure_base_drift — drift evidence gates the head move (HOK-3371).
# ---------------------------------------------------------------------------
SHA_HEAD="deadbee"
SHA_BASE_A="beefcaf"
SHA_BASE_B="c0ffee1"

write_ready_fixture() {
  local dir="$1" json="$2"
  mkdir -p "$dir"
  printf '%s\n' "$json" > "$dir/.ready-result.json"
}

dir="$TEST_TMP/drift-conflict"
write_ready_fixture "$dir" '{"artifacts":{"mergeConflict":"CONFLICTED"}}'
check_eq "a CONFLICT mergeConflict signature warrants the update" \
  "$(ready_failure_base_drift "$dir" "$TEST_TMP" main)" "yes"

dir="$TEST_TMP/drift-signature"
write_ready_fixture "$dir" '{"artifacts":{"transitionFailure":{"stage":"ready-label","detail":"remote rejected (fetch first)"}}}'
check_eq "a base-drift signature in the detail warrants the update" \
  "$(ready_failure_base_drift "$dir" "$TEST_TMP" main)" "yes"

dir="$TEST_TMP/drift-transition-error"
write_ready_fixture "$dir" '{"artifacts":{"transitionFailure":{"stage":"route-stamp","detail":"Expected resolved_model for planner inherited"}}}'
check_eq "a deterministic transition error does not warrant the update" \
  "$(ready_failure_base_drift "$dir" "$TEST_TMP" main)" "no"

dir="$TEST_TMP/drift-red-checks"
write_ready_fixture "$dir" '{"artifacts":{"ciConclusion":"FAILURE","remediationFailures":["unit-tests"]}}'
check_eq "red checks on a branch that is not behind do not warrant the update" \
  "$(ready_failure_base_drift "$dir" "$TEST_TMP" main)" "no"

dir="$TEST_TMP/drift-empty"
write_ready_fixture "$dir" '{"artifacts":{}}'
check_eq "no evidence does not warrant the update" \
  "$(ready_failure_base_drift "$dir" "$TEST_TMP" main)" "no"

# Red CI with no transition failure and an observably behind branch.
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

# Red CI with no transition failure and an observably behind branch (the
# task branch has no local commits — HEAD is an ancestor of origin/<base>).
drift_dir="$TEST_TMP/drift-behind-red-ci"
rm -rf "$drift_dir"
mkdir -p "$drift_dir"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com
export GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
git init -q --bare --initial-branch=main "$drift_dir/origin.git"
git init -q -b main "$drift_dir/seed"
git -C "$drift_dir/seed" commit -q --allow-empty -m base
git -C "$drift_dir/seed" push -q "$drift_dir/origin.git" HEAD:refs/heads/main
git clone -q -b main "$drift_dir/origin.git" "$drift_dir/worktree"
git clone -q -b main "$drift_dir/origin.git" "$drift_dir/scratch"
git -C "$drift_dir/scratch" commit -q --allow-empty -m advance
git -C "$drift_dir/scratch" push -q origin main
git -C "$drift_dir/worktree" fetch -q origin main
write_ready_fixture "$drift_dir/state" '{"artifacts":{"ciConclusion":"FAILURE"}}'
check_eq "red CI on an observably behind branch warrants the update" \
  "$(ready_failure_base_drift "$drift_dir/state" "$drift_dir/worktree" main)" "yes"

drift_dir="$TEST_TMP/drift-transition-behind"
setup_repo "$drift_dir" yes
write_ready_fixture "$drift_dir/state" '{"artifacts":{"ciConclusion":"FAILURE","transitionFailure":{"stage":"route-stamp","detail":"boom"}}}'
check_eq "a transition failure wins over the behind short-circuit" \
  "$(ready_failure_base_drift "$drift_dir/state" "$drift_dir/worktree" main)" "no"

drift_dir="$TEST_TMP/drift-ahead-red-ci"
setup_repo "$drift_dir" no
write_ready_fixture "$drift_dir/state" '{"artifacts":{"ciConclusion":"FAILURE"}}'
check_eq "red CI on an up-to-date branch does not warrant the update" \
  "$(ready_failure_base_drift "$drift_dir/state" "$drift_dir/worktree" main)" "no"

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
