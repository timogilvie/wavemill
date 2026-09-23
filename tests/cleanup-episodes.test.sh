#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=../shared/lib/wavemill-common.sh
source "$REPO_DIR/shared/lib/wavemill-common.sh"

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

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

REPO_DIR="$TEST_TMP/repo"
WORKTREE_ROOT="$TEST_TMP/worktrees"
STATE_FILE="$REPO_DIR/.wavemill/workflow-state.json"
BASE_BRANCH="auto/integration"
mkdir -p "$REPO_DIR/.wavemill" "$WORKTREE_ROOT"

git -C "$TEST_TMP" init -q repo
git -C "$REPO_DIR" config user.email "test@example.com"
git -C "$REPO_DIR" config user.name "Test User"
git -C "$REPO_DIR" checkout -q -b "$BASE_BRANCH"
printf 'base\n' > "$REPO_DIR/file.txt"
git -C "$REPO_DIR" add file.txt
git -C "$REPO_DIR" commit -q -m "base"
git -C "$REPO_DIR" update-ref "refs/remotes/origin/$BASE_BRANCH" HEAD
git -C "$REPO_DIR" checkout -q -b task/cleanup-episode
printf 'task\n' >> "$REPO_DIR/file.txt"
git -C "$REPO_DIR" commit -q -am "task"

cat > "$STATE_FILE" <<'JSON'
{
  "tasks": {
    "HOK-2955": {
      "slug": "cleanup-episode",
      "branch": "task/cleanup-episode",
      "status": "merged",
      "phase": "done",
      "lifecycle": {
        "schemaVersion": 1,
        "workflowOutcome": "merged",
        "resourceDisposition": "reaping",
        "retention": {
          "reason": "cleanup-started"
        }
      }
    }
  }
}
JSON

export WAVEMILL_TEST_NOW_EPOCH=1000
export WAVEMILL_CLEANUP_EPISODE_JITTER_RATIO=0
export WAVEMILL_CLEANUP_EPISODE_BACKOFF_BASE_SECONDS=10
export WAVEMILL_CLEANUP_EPISODE_BACKOFF_CAP_SECONDS=25
export WAVEMILL_CLEANUP_EPISODE_MAX_ATTEMPTS=3

echo "=== Cleanup Episodes ==="

candidate="$(cleanup_episode_candidate_json "HOK-2955" "cleanup-episode" "" "")"
fingerprint="$(jq -r '.fingerprint' <<<"$candidate")"
cleanup_episode_record_outcome "HOK-2955" "retained" "expected-preservation" "local-work-preserved" "$candidate"

check_eq "retained episode records resource disposition" \
  "$(jq -r '.tasks["HOK-2955"].lifecycle.resourceDisposition' "$STATE_FILE")" "retained"
check_eq "retained episode records attempt count" \
  "$(jq -r '.tasks["HOK-2955"].lifecycle.cleanupEpisode.attemptCount' "$STATE_FILE")" "1"
check_eq "retained episode records fingerprint" \
  "$(jq -r '.tasks["HOK-2955"].lifecycle.cleanupEpisode.fingerprint' "$STATE_FILE")" "$fingerprint"
check_eq "unchanged retained fingerprint skips" \
  "$(cleanup_episode_should_attempt "HOK-2955" "cleanup-episode" "" "")" "skip"
check_eq "explicit inbox cleanup retries a retained episode" \
  "$(WAVEMILL_TERMINAL_INBOX_CLEANUP=1 cleanup_episode_should_attempt "HOK-2955" "cleanup-episode" "" "")" "attempt"

printf 'new head\n' >> "$REPO_DIR/file.txt"
git -C "$REPO_DIR" commit -q -am "new head"
check_eq "changed local head rearms cleanup" \
  "$(cleanup_episode_should_attempt "HOK-2955" "cleanup-episode" "" "")" "attempt"

state_mutate "$STATE_FILE" '
  .tasks["HOK-2955"].lifecycle.resourceDisposition = "reaping"
  | del(.tasks["HOK-2955"].lifecycle.cleanupEpisode)
' >/dev/null

candidate="$(cleanup_episode_candidate_json "HOK-2955" "cleanup-episode" "" "")"
WAVEMILL_TEST_NOW_EPOCH=1000 cleanup_episode_record_outcome "HOK-2955" "transient" "transient" "remote-branch-cleanup-unverified" "$candidate"
check_eq "transient first attempt recorded" \
  "$(jq -r '.tasks["HOK-2955"].lifecycle.cleanupEpisode.attemptCount' "$STATE_FILE")" "1"
check_eq "transient first retry scheduled" \
  "$(jq -r '.tasks["HOK-2955"].lifecycle.cleanupEpisode.nextRetryAt' "$STATE_FILE")" "1970-01-01T00:16:50Z"
check_eq "transient backs off before retry time" \
  "$(WAVEMILL_TEST_NOW_EPOCH=1005 cleanup_episode_should_attempt "HOK-2955" "cleanup-episode" "" "")" "skip"
check_eq "transient retries when due" \
  "$(WAVEMILL_TEST_NOW_EPOCH=1010 cleanup_episode_should_attempt "HOK-2955" "cleanup-episode" "" "")" "attempt"

WAVEMILL_TEST_NOW_EPOCH=1010 cleanup_episode_record_outcome "HOK-2955" "transient" "transient" "remote-branch-cleanup-unverified" "$candidate"
check_eq "transient second attempt doubles backoff" \
  "$(jq -r '.tasks["HOK-2955"].lifecycle.cleanupEpisode.nextRetryAt' "$STATE_FILE")" "1970-01-01T00:17:10Z"

WAVEMILL_TEST_NOW_EPOCH=1030 cleanup_episode_record_outcome "HOK-2955" "transient" "transient" "remote-branch-cleanup-unverified" "$candidate"
check_eq "transient exhaustion transitions to needs-user" \
  "$(jq -r '.tasks["HOK-2955"].lifecycle.cleanupEpisode.disposition' "$STATE_FILE")" "needs-user"
check_eq "exhausted unchanged episode skips" \
  "$(WAVEMILL_TEST_NOW_EPOCH=2000 cleanup_episode_should_attempt "HOK-2955" "cleanup-episode" "" "")" "skip"

state_mutate "$STATE_FILE" '.tasks["HOK-2955"].lifecycle.cleanupEpisode = {"disposition":"retained"}' >/dev/null
check_eq "malformed cleanup episode fails closed to attempt" \
  "$(cleanup_episode_should_attempt "HOK-2955" "cleanup-episode" "" "")" "attempt"

echo
if [[ "$FAIL" -eq 0 ]]; then
  echo "All $PASS assertions passed."
else
  echo "$FAIL assertion(s) failed; $PASS passed."
  exit 1
fi
