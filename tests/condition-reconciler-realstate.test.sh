#!/usr/bin/env bash
# HOK-3225: Condition reconciler exercised against a sanitised real-state
# fixture. Confirms that a head-conditioned marker written against the
# fixture's recorded readyHeadSha survives one reconcile tick, and is expired
# once the worktree head advances past it.
#
# The fixture file itself is read-only; the test copies the workflowState
# sub-document into a mktemp'd STATE_FILE and runs the real reconciler.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURE_FILE="$REPO_DIR/tests/fixtures/real-state/2026-10-22-ready.json"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# shellcheck source=../shared/lib/wavemill-common.sh
source "$REPO_DIR/shared/lib/wavemill-common.sh"
# shellcheck source=../shared/lib/bounded-retry.sh
source "$REPO_DIR/shared/lib/bounded-retry.sh"
# shellcheck source=../shared/lib/transient-marker.sh
source "$REPO_DIR/shared/lib/transient-marker.sh"
# shellcheck source=../shared/lib/condition-reconciler.sh
source "$REPO_DIR/shared/lib/condition-reconciler.sh"

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }
assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then pass "$label"; else fail "$label (expected '$expected', got '$actual')"; fi
}
exists() { [[ -e "$1" ]] && echo yes || echo no; }

[[ -f "$FIXTURE_FILE" ]] || { echo "fixture missing: $FIXTURE_FILE" >&2; exit 1; }

ISSUE="$(jq -r '.workflowState.tasks | keys[0]' "$FIXTURE_FILE")"
if [[ -z "$ISSUE" || "$ISSUE" == "null" ]]; then
  echo "fixture carries no tasks" >&2
  exit 1
fi

READY_HEAD_SHA="$(jq -r --arg i "$ISSUE" '.stageResults[$i].ready.artifacts.readyHeadSha // ""' "$FIXTURE_FILE")"
if [[ -z "$READY_HEAD_SHA" ]]; then
  echo "ready fixture is missing readyHeadSha for $ISSUE" >&2
  exit 1
fi

# Build a worktree whose HEAD matches the fixture's recorded readyHeadSha. We
# can't literally rebuild a commit with that SHA, so we treat the fixture's
# recorded SHA as the condition value and compare the reconciler's HEAD-check
# behaviour against it by overriding `git -C <wt> rev-parse HEAD`.
WT="$TMP_DIR/worktree"
mkdir -p "$WT"
git -C "$WT" init -q
git -C "$WT" -c user.email=t@t -c user.name=t commit -q --allow-empty -m seed
INITIAL_SHA="$READY_HEAD_SHA"

# Stub `git -C <wt> rev-parse HEAD` so the reconciler reads the SHA we want it
# to see without depending on the fixture's exact commit object.
git() {
  if [[ "$1" == "-C" && "$2" == "$WT" && "$3" == "rev-parse" && "$4" == "HEAD" ]]; then
    printf '%s\n' "$CURRENT_HEAD"
    return 0
  fi
  command git "$@"
}
CURRENT_HEAD="$INITIAL_SHA"

STATE_DIR="$WT/features/$ISSUE"
mkdir -p "$STATE_DIR"

STATE_FILE="$TMP_DIR/workflow-state.json"
export STATE_FILE
jq '.workflowState' "$FIXTURE_FILE" > "$STATE_FILE"

export MONITOR_PR_CACHE="$TMP_DIR/pr-cache.json"
echo '[]' > "$MONITOR_PR_CACHE"

echo "=== real-state fixture: head-conditioned marker survives one tick, expires on head advance ==="

marker_write "$STATE_DIR/.needs-attention" --kind ready-attention --head "$READY_HEAD_SHA" \
  --reason "ready-attention test under real-state fixture" --state-dir "$STATE_DIR" \
  --expires-on "head,operator-event"

assert_eq "marker written" "yes" "$(exists "$STATE_DIR/.needs-attention")"

condition_reconcile_task "$ISSUE" "$WT" "$STATE_DIR" || true
assert_eq "same head: marker kept" "yes" "$(exists "$STATE_DIR/.needs-attention")"

# Advance the simulated worktree HEAD past the condition.
CURRENT_HEAD="deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
condition_reconcile_task "$ISSUE" "$WT" "$STATE_DIR" || true
assert_eq "new head: marker expired" "no" "$(exists "$STATE_DIR/.needs-attention")"
assert_eq "audit entry written" "yes" "$(exists "$STATE_DIR/.condition-reconcile.jsonl")"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
