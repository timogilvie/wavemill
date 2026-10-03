#!/usr/bin/env bash
# Runtime guard: fail a test run when tracked repo files are left modified
# compared to a pre-run snapshot (HOK-3157).
#
# Only tracked files are considered; untracked files are ignored so CI
# artifacts (e.g. timing-unit-shard-N.json written at the repo root) never
# false-positive the guard. Pre-existing local dirt is also ignored so a
# developer running tests on an uncommitted tree keeps working — the guard
# only flags entries that appeared *during* the run.
#
# Limitation: a file already dirty before the run that gets re-modified by a
# test is not detected. The Phase 2 static check covers that common case.
#
# Usage:
#   source tests/lib/tracked-tree-guard.sh
#   BEFORE="$(tracked_tree_snapshot "$REPO_DIR")"
#   # ... run tests ...
#   tracked_tree_check "$REPO_DIR" "$BEFORE" <runner-label>  # returns non-zero on new dirt

# Prints `git status --porcelain=v1 --untracked-files=no` for tracked-only
# changes, or nothing if $1 is not a git work tree (guard disabled, e.g.
# running from a tarball). Always returns 0.
tracked_tree_snapshot() {
  local repo_dir="$1"
  if ! git -C "$repo_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    return 0
  fi
  git -C "$repo_dir" status --porcelain=v1 --untracked-files=no 2>/dev/null || true
}

# Takes an "after" snapshot, computes lines present after but not before, and
# fails (returns 1) if any new tracked-file dirt appeared. Writes a human
# diagnosis to stderr naming the files and the remediation (`git checkout`).
# Returns 0 when the delta is empty, or when the repo isn't a git work tree.
tracked_tree_check() {
  local repo_dir="$1"
  local before="$2"
  local runner_label="${3:-tests}"

  if ! git -C "$repo_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    return 0
  fi

  local after
  after="$(git -C "$repo_dir" status --porcelain=v1 --untracked-files=no 2>/dev/null || true)"

  local delta
  if [[ -z "$before" ]]; then
    delta="$after"
  else
    # Lines in after that are not in before. grep -Fxv requires a non-empty
    # pattern file, so use a temp file. Handles blank-line edge cases cleanly.
    local before_file
    before_file="$(mktemp "${TMPDIR:-/tmp}/tracked-tree-before.XXXXXX")"
    printf '%s\n' "$before" > "$before_file"
    delta="$(printf '%s\n' "$after" | grep -Fxv -f "$before_file" || true)"
    rm -f "$before_file"
  fi

  # Strip blank lines
  delta="$(printf '%s\n' "$delta" | sed '/^$/d')"
  if [[ -z "$delta" ]]; then
    return 0
  fi

  {
    printf '%s: tests modified tracked files (HOK-3157):\n' "$runner_label"
    printf '%s\n' "$delta"
    printf 'Tests must write only to temp dirs (mkdtemp) — never tracked repo paths.\n'
    printf 'Restore with: git checkout -- <file>\n'
  } >&2
  return 1
}
