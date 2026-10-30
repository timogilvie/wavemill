#!/usr/bin/env bash
# HOK-2891 — bash parity test for resolve_task_artifact_path / resolve_stage_artifact_path.
#
# The shell twin of shared/lib/task-artifact-lookup.ts probes the same
# order: live feature/bugs dirs first, then the per-issue archive directory
# under $REPO_DIR/.wavemill/evals/artifacts/<issue>.

set -euo pipefail

REPO_DIR_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../shared/lib/wavemill-common.sh
source "$REPO_DIR_SRC/shared/lib/wavemill-common.sh"

pass=0
fail=0
tmpdir="$(mktemp -d)"
cleanup() { rm -rf "$tmpdir"; }
trap cleanup EXIT

check() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf '  ✗ %s\n     expected: %q\n     actual:   %q\n' "$desc" "$expected" "$actual" >&2
  fi
}

# protects: live `.coding-result.json` under features/<slug> is returned.
test_live_feature_hit() {
  local root="$tmpdir/t1"
  local slug="hok-9999-add-x"
  mkdir -p "$root/features/$slug" "$root/.wavemill"
  echo '{"from":"live"}' > "$root/features/$slug/.coding-result.json"
  local out
  REPO_DIR="$root" WORKTREE_ROOT="$root/worktrees" out="$(resolve_stage_artifact_path 'HOK-9999' "$slug" 'coding')"
  check 'live features hit' "$root/features/$slug/.coding-result.json" "$out"
}

# protects: an archived `.coding-result.json` resolves when live is gone (HOK-2885).
test_archive_fallback() {
  local root="$tmpdir/t2"
  mkdir -p "$root/.wavemill/evals/artifacts/HOK-2885_c"
  echo '{"model":"openrouter:devstral-small"}' > "$root/.wavemill/evals/artifacts/HOK-2885_c/.coding-result.json"
  local out
  REPO_DIR="$root" WORKTREE_ROOT="$root/worktrees" out="$(resolve_stage_artifact_path 'HOK-2885_c' 'hok-2885-c-missing' 'coding' || true)"
  check 'archive fallback' "$root/.wavemill/evals/artifacts/HOK-2885_c/.coding-result.json" "$out"
}

# protects: a missing artifact returns no path and nonzero exit.
test_absent() {
  local root="$tmpdir/t3"
  mkdir -p "$root/.wavemill"
  local out status
  REPO_DIR="$root" WORKTREE_ROOT="$root/worktrees" out="$(resolve_stage_artifact_path 'HOK-1' 'absent' 'planning' || true)"
  REPO_DIR="$root" WORKTREE_ROOT="$root/worktrees" resolve_stage_artifact_path 'HOK-1' 'absent' 'planning' >/dev/null 2>&1 || status=$?
  check 'absent empty output' '' "$out"
  check 'absent nonzero exit' '1' "${status:-0}"
}

# protects: a bugs/<slug> hit is found after features/<slug> is empty.
test_bugs_dir_hit() {
  local root="$tmpdir/t4"
  local slug="hok-7-bug"
  mkdir -p "$root/bugs/$slug" "$root/.wavemill"
  echo '{}' > "$root/bugs/$slug/.review-result.json"
  local out
  REPO_DIR="$root" WORKTREE_ROOT="$root/worktrees" out="$(resolve_stage_artifact_path 'HOK-7' "$slug" 'review')"
  check 'bugs dir hit' "$root/bugs/$slug/.review-result.json" "$out"
}

test_live_feature_hit
test_archive_fallback
test_absent
test_bugs_dir_hit

echo "task-artifact-lookup.test.sh: pass=$pass fail=$fail"
[[ "$fail" -eq 0 ]]
