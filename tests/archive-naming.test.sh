#!/usr/bin/env bash
# HOK-2891 — the archiver keeps the live basename for every stage result and
# sibling artifact; readers find them under one name.

set -euo pipefail

REPO_DIR_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../shared/lib/wavemill-common.sh
source "$REPO_DIR_SRC/shared/lib/wavemill-common.sh"

pass=0
fail=0
tmpdir="$(mktemp -d)"
cleanup() { rm -rf "$tmpdir"; }
trap cleanup EXIT

check_file() {
  local name="$1" path="$2"
  if [[ -f "$path" ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf '  ✗ expected %s at %q\n' "$name" "$path" >&2
  fi
}

check_absent() {
  local name="$1" path="$2"
  if [[ ! -e "$path" ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf '  ✗ expected %s to be absent at %q\n' "$name" "$path" >&2
  fi
}

# Set up a fake worktree + feature dir with every artifact kind.
export REPO_DIR="$tmpdir/repo"
export WORKTREE_ROOT="$REPO_DIR/worktrees"
slug="hok-9999-sample"
issue="HOK-9999"
feature_dir="$WORKTREE_ROOT/$slug/features/$slug"
mkdir -p "$feature_dir"

echo '{"stage":"planning"}' > "$feature_dir/.planning-result.json"
echo '{"stage":"coding"}' > "$feature_dir/.coding-result.json"
echo '{"stage":"review"}' > "$feature_dir/.review-result.json"
echo '{"routed":true}' > "$feature_dir/.routing-complete"
echo '{"initial":true}' > "$feature_dir/.initial-route.json"
echo '{"expanded":true}' > "$feature_dir/.post-expansion-route.json"
echo '{"type":"operator_recovery"}' > "$feature_dir/.operator-intervention.json"
echo '{"ev":1}' > "$feature_dir/.operator-events.jsonl"
echo '{"ev":1}' > "$feature_dir/.terminal-history.jsonl"
echo '{"ev":1}' > "$feature_dir/.coding-uncommitted-output.resolved.jsonl"
echo 'plan' > "$feature_dir/plan.md"
echo '{"stage":"coding","attempt":1}' > "$feature_dir/.coding-result.attempt-1-failed.json"

# stub out log helpers that write to the mill log
log() { :; }
log_warn() { :; }

archive_stage_artifacts "$issue" "$slug"

archive="$REPO_DIR/.wavemill/evals/artifacts/$issue"

# protects: live stage-result names survive into the archive.
check_file 'archived .planning-result.json' "$archive/.planning-result.json"
check_file 'archived .coding-result.json' "$archive/.coding-result.json"
check_file 'archived .review-result.json' "$archive/.review-result.json"
check_file 'archived failed attempt' "$archive/.coding-result.attempt-1-failed.json"

# protects: route lifecycle artifacts keep the dot.
check_file 'archived .routing-complete' "$archive/.routing-complete"
check_file 'archived .initial-route.json' "$archive/.initial-route.json"
check_file 'archived .post-expansion-route.json' "$archive/.post-expansion-route.json"

# protects: operator / telemetry artifacts keep the dot.
check_file 'archived .operator-intervention.json' "$archive/.operator-intervention.json"
check_file 'archived .operator-events.jsonl' "$archive/.operator-events.jsonl"
check_file 'archived .terminal-history.jsonl' "$archive/.terminal-history.jsonl"
check_file 'archived .coding-uncommitted-output.resolved.jsonl' "$archive/.coding-uncommitted-output.resolved.jsonl"
check_file 'archived plan.md' "$archive/plan.md"

# protects: the pre-HOK-2891 dot-less names are NOT written any more.
check_absent 'no dot-less planning-result.json' "$archive/planning-result.json"
check_absent 'no dot-less coding-result.json' "$archive/coding-result.json"
check_absent 'no dot-less review-result.json' "$archive/review-result.json"
check_absent 'no dot-less routing-complete.json' "$archive/routing-complete.json"
check_absent 'no dot-less initial-route.json' "$archive/initial-route.json"
check_absent 'no dot-less post-expansion-route.json' "$archive/post-expansion-route.json"
check_absent 'no dot-less operator-intervention.json' "$archive/operator-intervention.json"

echo "archive-naming.test.sh: pass=$pass fail=$fail"
[[ "$fail" -eq 0 ]]
