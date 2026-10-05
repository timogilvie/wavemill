#!/usr/bin/env bash
set -euo pipefail

# Tests for tests/lib/tracked-tree-guard.sh (HOK-3157 Phase 3 runtime guard).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/tracked-tree-guard.sh
source "$REPO_DIR/tests/lib/tracked-tree-guard.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

make_repo() {
  local dir
  dir="$(mktemp -d "${TMPDIR:-/tmp}/tracked-tree-guard.XXXXXX")"
  git -C "$dir" init -q
  git -C "$dir" config user.email test@example.com
  git -C "$dir" config user.name "Test User"
  printf 'original\n' > "$dir/tracked.md"
  git -C "$dir" add tracked.md
  git -C "$dir" commit -qm init
  echo "$dir"
}

# 1. Modified tracked file is detected and named in the diagnostic
run_modified_detected() {
  local repo stderr_file rc
  repo="$(make_repo)"
  local before
  before="$(tracked_tree_snapshot "$repo")"
  printf 'tampered\n' > "$repo/tracked.md"
  stderr_file="$(mktemp)"
  rc=0
  tracked_tree_check "$repo" "$before" test-runner 2>"$stderr_file" || rc=$?
  if (( rc == 1 )) && grep -q "tracked.md" "$stderr_file" && grep -q "HOK-3157" "$stderr_file"; then
    pass "modified tracked file is detected and named"
  else
    fail "modified tracked file not detected (rc=$rc, stderr=$(cat "$stderr_file"))"
  fi
  rm -rf "$repo" "$stderr_file"
}

# 2. Staged-only modification is detected
run_staged_detected() {
  local repo rc
  repo="$(make_repo)"
  local before
  before="$(tracked_tree_snapshot "$repo")"
  printf 'staged change\n' > "$repo/tracked.md"
  git -C "$repo" add tracked.md
  rc=0
  tracked_tree_check "$repo" "$before" test-runner 2>/dev/null || rc=$?
  if (( rc == 1 )); then
    pass "staged-only modification is detected"
  else
    fail "staged-only modification not detected (rc=$rc)"
  fi
  rm -rf "$repo"
}

# 3. New untracked file alone is not flagged (would false-positive CI timing JSON)
run_untracked_ignored() {
  local repo rc
  repo="$(make_repo)"
  local before
  before="$(tracked_tree_snapshot "$repo")"
  printf 'new\n' > "$repo/untracked.log"
  rc=0
  tracked_tree_check "$repo" "$before" test-runner 2>/dev/null || rc=$?
  if (( rc == 0 )); then
    pass "new untracked file alone is not flagged"
  else
    fail "new untracked file was flagged (rc=$rc)"
  fi
  rm -rf "$repo"
}

# 4. Pre-existing dirt that stays the same is not flagged
run_preexisting_dirt_ignored() {
  local repo rc
  repo="$(make_repo)"
  printf 'already dirty\n' > "$repo/tracked.md"
  local before
  before="$(tracked_tree_snapshot "$repo")"
  rc=0
  tracked_tree_check "$repo" "$before" test-runner 2>/dev/null || rc=$?
  if (( rc == 0 )); then
    pass "pre-existing dirt that stays unchanged is not flagged"
  else
    fail "pre-existing dirt was flagged (rc=$rc)"
  fi
  rm -rf "$repo"
}

# 5. Non-git directory: snapshot empty, check returns 0
run_non_git_disabled() {
  local dir rc
  dir="$(mktemp -d "${TMPDIR:-/tmp}/tracked-tree-nogit.XXXXXX")"
  local before
  before="$(tracked_tree_snapshot "$dir")"
  if [[ -n "$before" ]]; then
    fail "non-git dir snapshot was not empty"
    rm -rf "$dir"
    return
  fi
  rc=0
  tracked_tree_check "$dir" "$before" test-runner 2>/dev/null || rc=$?
  if (( rc == 0 )); then
    pass "non-git directory is a no-op"
  else
    fail "non-git directory tripped the guard (rc=$rc)"
  fi
  rm -rf "$dir"
}

echo "=== tracked-tree-guard tests ==="
run_modified_detected
run_staged_detected
run_untracked_ignored
run_preexisting_dirt_ignored
run_non_git_disabled

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
if (( FAIL > 0 )); then
  exit 1
fi
