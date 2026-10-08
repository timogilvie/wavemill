#!/usr/bin/env bash
# HOK-3172 acceptance: the condition reconciler clears each marker exactly when
# the condition that set it no longer holds, and never otherwise.
#
# One fixture per original incident:
#   HOK-3167  status=error survives a re-review
#   HOK-3168  same-head infra markers survive a substantive verdict
#   HOK-3171  GitHub head lag turns an observation into a permanent refusal
#   HOK-3165  review-infra exhaustion re-arms on a new head (not the same head)
# plus regressions found in review: UTC timestamp parsing on BSD date, the PR
# cache being an array, and exhausted sentinels without a SHA head.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

source "$REPO_DIR/shared/lib/wavemill-common.sh"
source "$REPO_DIR/shared/lib/bounded-retry.sh"
source "$REPO_DIR/shared/lib/transient-marker.sh"
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

# Infra classification stub: tests set INFRA_REVIEW=1 to make the current
# review an infra failure.
INFRA_REVIEW=0
review_result_infra_failure() { [[ "$INFRA_REVIEW" == "1" ]]; }

ISSUE="HOK-9999"
SESSION="reconciler-test"
export MONITOR_PR_CACHE="$TMP_DIR/pr-cache.json"

# Fresh worktree (git repo with two commits) + state dir + state file.
new_fixture() {
  WT="$TMP_DIR/wt-$RANDOM$RANDOM"
  STATE_DIR="$WT/features/task"
  mkdir -p "$STATE_DIR"
  git -C "$WT" init -q
  git -C "$WT" -c user.email=t@t -c user.name=t commit -q --allow-empty -m one
  OLD_HEAD="$(git -C "$WT" rev-parse HEAD)"
  git -C "$WT" -c user.email=t@t -c user.name=t commit -q --allow-empty -m two
  HEAD_SHA="$(git -C "$WT" rev-parse HEAD)"
  STATE_FILE="$TMP_DIR/state-$RANDOM$RANDOM.json"
  jq -n --arg i "$ISSUE" '{tasks: {($i): {status: "active", phase: "ready", pr: "1591"}}}' > "$STATE_FILE"
  export STATE_FILE
  echo '[]' > "$MONITOR_PR_CACHE"
}
reconcile() { condition_reconcile_task "$ISSUE" "$WT" "$STATE_DIR"; }
write_review() { # status finishedAt
  jq -n --arg s "$1" --arg f "$2" \
    '{stage: "review", status: $s, startedAt: "2026-10-06T21:00:00.123Z", finishedAt: $f,
      artifacts: {type: "review", verdict: "not_ready", exitCode: 1}}' > "$STATE_DIR/.review-result.json"
}
pr_cache() { # number headRefOid
  jq -n --argjson n "$1" --arg h "$2" '[{number: 42, headRefOid: "deadbeef"}, {number: $n, headRefOid: $h}]' > "$MONITOR_PR_CACHE"
}
set_task() { jq --arg i "$ISSUE" ".tasks[\$i] |= ($1)" "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"; }

echo "=== HOK-3167: re-review clears status=error ==="
new_fixture
set_task '.status = "error"'
reconcile
assert_eq "no operator event: status stays error" "error" "$(jq -r --arg i "$ISSUE" '.tasks[$i].status' "$STATE_FILE")"
assert_eq "no operator event: nothing logged" "no" "$(exists "$STATE_DIR/.condition-reconcile.jsonl")"
operator_event_record "$STATE_DIR" "re-review" "$ISSUE"
reconcile
assert_eq "re-review: status becomes active" "active" "$(jq -r --arg i "$ISSUE" '.tasks[$i].status' "$STATE_FILE")"
assert_eq "re-review: clear attributed to the command" "re-review" "$(jq -r --arg i "$ISSUE" '.tasks[$i].statusClearedBy.command' "$STATE_FILE")"
assert_eq "re-review: audit entry written once" "1" "$(grep -c 'status=error' "$STATE_DIR/.condition-reconcile.jsonl")"
reconcile
assert_eq "second tick: no repeat audit entry" "1" "$(grep -c 'status=error' "$STATE_DIR/.condition-reconcile.jsonl")"

echo "=== HOK-3168: substantive verdict supersedes same-head infra marker ==="
new_fixture
write_review completed "2026-10-06T21:10:00Z"
marker_write "$STATE_DIR/.needs-attention" --kind ready-attention --head "$HEAD_SHA" \
  --reason "Review infrastructure recovery is exhausted" --state-dir "$STATE_DIR" \
  --expires-on "head,operator-event,review-artifact-substantive" --review-artifact
reconcile
assert_eq "same review artifact: marker kept" "yes" "$(exists "$STATE_DIR/.needs-attention")"
write_review running "2026-10-06T21:30:00Z"
reconcile
assert_eq "review still running: marker kept" "yes" "$(exists "$STATE_DIR/.needs-attention")"
INFRA_REVIEW=1
write_review completed "2026-10-06T21:31:00Z"
reconcile
assert_eq "new review is another infra failure: marker kept" "yes" "$(exists "$STATE_DIR/.needs-attention")"
INFRA_REVIEW=0
write_review completed "2026-10-06T21:32:00Z"
reconcile
assert_eq "new substantive verdict at same head: marker cleared" "no" "$(exists "$STATE_DIR/.needs-attention")"

echo "=== HOK-3171: waiting on GitHub head lag ==="
new_fixture
marker_write "$STATE_DIR/.ready-waiting-on.json" --kind ready-waiting-on --head "$HEAD_SHA" \
  --state-dir "$STATE_DIR" --waiting-on "pr-head=$HEAD_SHA@1591" --expires-on "head,waiting-on"
pr_cache 1591 "$OLD_HEAD"
reconcile
assert_eq "PR head still lagging: wait kept" "yes" "$(exists "$STATE_DIR/.ready-waiting-on.json")"
pr_cache 1591 "$HEAD_SHA"
reconcile
assert_eq "PR head caught up (array cache): wait cleared" "no" "$(exists "$STATE_DIR/.ready-waiting-on.json")"

new_fixture
marker_write "$STATE_DIR/.needs-attention" --kind ready-attention --head "$HEAD_SHA" \
  --observed "prHeadRefOid=$OLD_HEAD" --expires-on "head,operator-event,remote" --state-dir "$STATE_DIR"
pr_cache 1591 "$OLD_HEAD"
reconcile
assert_eq "remote unchanged: refusal kept" "yes" "$(exists "$STATE_DIR/.needs-attention")"
pr_cache 1591 "$HEAD_SHA"
reconcile
assert_eq "remote moved (task .pr field): refusal cleared" "no" "$(exists "$STATE_DIR/.needs-attention")"

echo "=== deadline trigger (UTC parsing) ==="
new_fixture
marker_write "$STATE_DIR/.needs-attention-transient" --kind ready-attention-transient --head "$HEAD_SHA" \
  --state-dir "$STATE_DIR" --expires-on "deadline" --recheck-after-seconds 3600
reconcile
assert_eq "deadline one hour away: kept (not shifted by local UTC offset)" "yes" "$(exists "$STATE_DIR/.needs-attention-transient")"
jq '.condition.recheckAfter = "2000-01-01T00:00:00Z"' "$STATE_DIR/.needs-attention-transient" > "$TMP_DIR/m" && mv "$TMP_DIR/m" "$STATE_DIR/.needs-attention-transient"
reconcile
assert_eq "deadline passed: cleared" "no" "$(exists "$STATE_DIR/.needs-attention-transient")"
marker_write "$STATE_DIR/.needs-attention-transient" --kind ready-attention-transient --head "$HEAD_SHA" \
  --state-dir "$STATE_DIR" --expires-on "deadline" --recheck-after-seconds 3600
jq '.condition.recheckAfter = "not-a-time"' "$STATE_DIR/.needs-attention-transient" > "$TMP_DIR/m" && mv "$TMP_DIR/m" "$STATE_DIR/.needs-attention-transient"
reconcile
assert_eq "unparseable deadline: kept (fail closed)" "yes" "$(exists "$STATE_DIR/.needs-attention-transient")"
assert_eq "UTC parse of fractional timestamp" "1791321437" "$(_condition_iso_to_epoch 2026-10-06T21:17:17.793Z)"

echo "=== HOK-3165: review-infra exhaustion re-arms only on a new head ==="
new_fixture
bounded_retry_increment "$STATE_DIR" "review-infra-recovery" "${HEAD_SHA}:review-tool-error" >/dev/null
bounded_retry_mark_exhausted "$STATE_DIR" "review-infra-recovery" "exhausted after 2 attempt(s)"
reconcile
assert_eq "same head: exhaustion kept" "yes" "$(exists "$STATE_DIR/.retry-review-infra-recovery-exhausted")"
git -C "$WT" -c user.email=t@t -c user.name=t commit -q --allow-empty -m three
reconcile
assert_eq "new head: exhaustion cleared" "no" "$(exists "$STATE_DIR/.retry-review-infra-recovery-exhausted")"

new_fixture
bounded_retry_increment "$STATE_DIR" "review-infra-recovery" "${HEAD_SHA}:review-tool-error" >/dev/null
printf 'legacy sentinel\n' > "$STATE_DIR/.retry-review-infra-recovery-exhausted"
reconcile
assert_eq "legacy sentinel, same head (<sha>:<category> key): kept" "yes" "$(exists "$STATE_DIR/.retry-review-infra-recovery-exhausted")"

echo "=== terminal short-circuit without a SHA head ==="
new_fixture
bounded_retry_mark_exhausted "$STATE_DIR" "coding-launch-refused" "terminal: no launchable coder"
reconcile
assert_eq "no head key: terminal sentinel kept" "yes" "$(exists "$STATE_DIR/.retry-coding-launch-refused-exhausted")"
assert_eq "no placeholder head recorded" "" "$(jq -r '.condition.head // empty' "$STATE_DIR/.retry-coding-launch-refused-exhausted-condition.json")"
operator_event_record "$STATE_DIR" "advance" "$ISSUE"
reconcile
assert_eq "operator event: terminal sentinel cleared" "no" "$(exists "$STATE_DIR/.retry-coding-launch-refused-exhausted")"
assert_eq "two-argument mark_exhausted does not abort" "ok" "$(bounded_retry_mark_exhausted "$STATE_DIR" "two-arg" >/dev/null && echo ok)"

echo ""
echo "=== Totals ==="
echo "pass=$PASS fail=$FAIL"
exit "$FAIL"
