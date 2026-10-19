#!/usr/bin/env bash
# ready_sync_worktree_to_github_head against a real worktree + bare origin.
#
# Protects against: Ready resetting the task worktree BACKWARDS to a lagging
# GitHub PR head right after the agent pushed (HOK-3076, 2026-10-19). After a
# push, local HEAD == origin/<branch>, so "local is an ancestor of the
# pre-fetch origin ref" held trivially and the stale API head was treated as a
# remote rewrite: the worktree was reset to the pre-fix commit, Ready latched
# at `running`, and the challenge pair never reached eval/comparison.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

extract_function() {
  local source_file="$1" function_name="$2"
  awk -v name="$function_name" '
    function brace_delta(line, stripped, opens, closes) {
      stripped = line
      gsub(/"([^"\\]|\\.)*"/, "\"\"", stripped)
      gsub(/\047([^\047\\]|\\.)*\047/, "\047\047", stripped)
      opens = gsub(/\{/, "{", stripped)
      closes = gsub(/\}/, "}", stripped)
      return opens - closes
    }
    $0 ~ "^" name "\\(\\)[[:space:]]*\\{" { capture = 1; depth = 0 }
    capture { print; depth += brace_delta($0); if (depth == 0) exit }
  ' "$source_file"
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FUNCS="$TMP/funcs.sh"
extract_function "$MONITOR_SCRIPT_FILE" ready_sync_worktree_to_github_head > "$FUNCS"
[[ -s "$FUNCS" ]] || { echo "FAIL: could not extract ready_sync_worktree_to_github_head"; exit 1; }
# shellcheck disable=SC1090
source "$FUNCS"

# The PR head GitHub's API reports; each case sets it.
FAKE_GH_HEAD=""
ready_current_github_head() { printf '%s\n' "$FAKE_GH_HEAD"; }

PASS=0
FAIL=0
check() {
  if [[ "$2" == "$3" ]]; then PASS=$((PASS + 1)); echo "  PASS  $1"
  else FAIL=$((FAIL + 1)); echo "  FAIL  $1 (expected '$3', got '$2')"; fi
}

BRANCH="task/x"
setup_world() {
  local name="$1"
  WORLD="$TMP/$name"
  ORIGIN="$WORLD/origin.git"
  WT="$WORLD/wt"
  STATE="$WORLD/state"
  mkdir -p "$WORLD" "$STATE"
  git init -q --bare "$ORIGIN"
  git init -q -b "$BRANCH" "$WT"
  git -C "$WT" config user.email t@example.com
  git -C "$WT" config user.name test
  git -C "$WT" remote add origin "$ORIGIN"
  commit_and_push base >/dev/null
}
commit_and_push() {
  echo "$1" > "$WT/$1.txt"
  git -C "$WT" add "$1.txt"
  git -C "$WT" commit -q -m "$1"
  git -C "$WT" push -q origin "HEAD:$BRANCH"
  git -C "$WT" rev-parse HEAD
}
run_sync() {
  set +e
  ready_sync_worktree_to_github_head "$WT" "$BRANCH" 1 "$STATE" >/dev/null 2>&1
  SYNC_RC=$?
  set -e
}

echo "=== pushed fix, GitHub PR head still the parent (HOK-3076) ==="
setup_world lag
parent="$(git -C "$WT" rev-parse HEAD)"
fix="$(commit_and_push fix)"
FAKE_GH_HEAD="$parent"
run_sync
check "reports GitHub head lag (rc 3), not a sync" "$SYNC_RC" 3
check "worktree stays on the pushed fix" "$(git -C "$WT" rev-parse HEAD)" "$fix"
check "observed lagging PR head is recorded" "$READY_SYNC_OBSERVED_PR_HEAD" "$parent"

echo "=== GitHub catches up: plain fast-forward still syncs ==="
FAKE_GH_HEAD="$fix"
run_sync
check "already at PR head (rc 0)" "$SYNC_RC" 0
check "READY_SYNC_HEAD is the fix" "$READY_SYNC_HEAD" "$fix"

echo "=== real remote rewrite (force-push elsewhere) still resets ==="
setup_world rewrite
old="$(commit_and_push old)"
# Someone else rewrites the branch: a sibling commit replaces `old`.
OTHER="$WORLD/other"
git clone -q "$ORIGIN" "$OTHER" -b "$BRANCH"
git -C "$OTHER" config user.email o@example.com
git -C "$OTHER" config user.name other
git -C "$OTHER" reset -q --hard HEAD~1
echo rewritten > "$OTHER/rewritten.txt"
git -C "$OTHER" add rewritten.txt
git -C "$OTHER" commit -q -m rewritten
git -C "$OTHER" push -q -f origin "HEAD:$BRANCH"
rewritten="$(git -C "$OTHER" rev-parse HEAD)"
# Local is still on `old`, which is what origin/<branch> held before the fetch.
FAKE_GH_HEAD="$rewritten"
run_sync
check "rewrite syncs (rc 0)" "$SYNC_RC" 0
check "worktree moved to the rewritten head" "$(git -C "$WT" rev-parse HEAD)" "$rewritten"

echo "=== unpushed local work on top of the PR head is refused ==="
setup_world unpushed
pr_head="$(git -C "$WT" rev-parse HEAD)"
echo local > "$WT/local.txt"; git -C "$WT" add local.txt; git -C "$WT" commit -q -m local
local_only="$(git -C "$WT" rev-parse HEAD)"
FAKE_GH_HEAD="$pr_head"
run_sync
check "refuses (rc 2)" "$SYNC_RC" 2
check "unpushed commit is kept" "$(git -C "$WT" rev-parse HEAD)" "$local_only"

echo ""
echo "passed=$PASS failed=$FAIL"
(( FAIL == 0 ))
