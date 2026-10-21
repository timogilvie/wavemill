#!/usr/bin/env bash
# HOK-3206: the cross-PR revert guard runs as a tracked job; Ready consumes
# its verdict on a later pass, and only for the head (and base tip) it checked.
#
#   1. clean head: first call is pending + launches the job; next call passes
#   2. a verdict for an older head is never consumed: pending + relaunch
#   3. exit 1 (unacknowledged reverts) blocks Ready with evidence + attention
#   4. crashes charge the bounded-retry bucket; exhaustion is a tool error
#   5. a head that moves mid-run publishes no verdict
#   6. a base tip that moved invalidates the verdict
#   7. the reconciler expires a head-stale verdict marker

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_DIR="$(mktemp -d)"
trap 'rm -rf "$HARNESS_DIR"' EXIT
source "$SCRIPT_DIR/fixtures/monitor-perf/async-harness.sh"

ISSUE="HOK-7001"
PR=4401
JOB_ID="cross-pr-guard-$ISSUE"

gate() {
  local rc=0
  ready_cross_pr_revert_gate "$ISSUE" "$STATE" "$WT" "$PR" "" || rc=$?
  printf '%s\n' "$rc"
}

new_case() {
  harness_new_worktree
  STATE="$WT/features/task"
  mkdir -p "$STATE"
  : > "$HARNESS_LOG"
  rm -rf "$STATE_DIR/async-jobs"
}

echo "=== 1. clean head: pending, then pass ==="
new_case
harness_tool_set check-cross-pr-reverts.ts 0 '{"unacknowledged":[]}'
assert_eq "first read is pending" "4" "$(gate)"
harness_wait_job "$JOB_ID"
assert_eq "job registered with the tracker" "1" "$(harness_count "launch_tracked_job kind=cross-pr-guard id=$JOB_ID")"
assert_eq "guard ran once" "1" "$(harness_count "tool check-cross-pr-reverts.ts")"
assert_eq "verdict marker keyed on head" "$HEAD_SHA" "$(marker_head "$STATE/.cross-pr-guard-result.json")"
assert_eq "job result ok" "true" "$(jq -r '.ok' "$STATE_DIR/async-jobs/$JOB_ID/job-result.json")"
assert_eq "second read passes" "0" "$(gate)"
assert_eq "pass clears guard evidence" "1" "$(harness_count "guard_evidence_cleared")"
assert_eq "consumed verdict does not relaunch" "1" "$(harness_count "tool check-cross-pr-reverts.ts")"

echo "=== 2. verdict for an older head is never consumed ==="
NEW_HEAD="$(harness_commit "$WT" three)"
assert_eq "new head reads pending" "4" "$(gate)"
assert_eq "no pass evidence for the new head" "1" "$(harness_count "guard_evidence_cleared")"
harness_wait_job "$JOB_ID"
assert_eq "relaunched for the new head" "2" "$(harness_count "tool check-cross-pr-reverts.ts")"
assert_eq "marker now keyed on new head" "$NEW_HEAD" "$(marker_head "$STATE/.cross-pr-guard-result.json")"
assert_eq "new head passes" "0" "$(gate)"

echo "=== 3. unacknowledged reverts block Ready ==="
new_case
harness_tool_set check-cross-pr-reverts.ts 1 '{"unacknowledged":[{"prNumber":1500,"files":[{"path":"shared/lib/x.ts"}]}]}'
gate >/dev/null
harness_wait_job "$JOB_ID"
assert_eq "blocked verdict returns 1" "1" "$(gate)"
assert_eq "blocked evidence written for this head" "1" "$(harness_count "guard_result pr=$PR head=$HEAD_SHA verdict=blocked")"
assert_eq "attention names the reverted PR" "1" "$(harness_count "attention PR #$PR removes files from #1500")"

echo "=== 4. crashes charge the retry bucket, exhaustion is a tool error ==="
new_case
harness_tool_set check-cross-pr-reverts.ts 137 '' 'Killed: out of memory'
ASYNC_CHECK_JOB_RETRY_LIMIT=2
assert_eq "crash attempt 1 pending" "4" "$(gate)"
harness_wait_job "$JOB_ID"
assert_eq "crash publishes no verdict" "no" "$([[ -f "$STATE/.cross-pr-guard-result.json" ]] && echo yes || echo no)"
assert_eq "job result records failure" "false" "$(jq -r '.ok' "$STATE_DIR/async-jobs/$JOB_ID/job-result.json")"
handle_check_job_failure "$JOB_ID" cross-pr-guard failed job_failed "$STATE_DIR/async-jobs/$JOB_ID/job-result.json"
assert_eq "failure charged against this head" "1" "$(bounded_retry_count "$STATE" cross-pr-guard-job)"
assert_eq "backoff holds pending without relaunch" "4" "$(gate)"
assert_eq "no relaunch during backoff" "1" "$(harness_count "tool check-cross-pr-reverts.ts")"
printf '%s\n' "$(( $(date +%s) - 3600 ))" > "$STATE/.retry-cross-pr-guard-job-last-at"
gate >/dev/null
harness_wait_job "$JOB_ID"
handle_check_job_failure "$JOB_ID" cross-pr-guard failed job_failed "$STATE_DIR/async-jobs/$JOB_ID/job-result.json"
printf '%s\n' "$(( $(date +%s) - 3600 ))" > "$STATE/.retry-cross-pr-guard-job-last-at"
assert_eq "exhausted budget is a tool error" "1" "$(gate)"
assert_eq "tool-error evidence written" "1" "$(harness_count "guard_result pr=$PR head=$HEAD_SHA verdict=tool-error")"
assert_eq "exhausted sentinel recorded" "yes" "$(bounded_retry_is_exhausted "$STATE" cross-pr-guard-job && echo yes || echo no)"
assert_eq "exhaustion never reads as pass" "0" "$(harness_count "guard_evidence_cleared")"
ASYNC_CHECK_JOB_RETRY_LIMIT=3

echo "=== 5. a head that moves mid-run publishes nothing ==="
new_case
harness_tool_set check-cross-pr-reverts.ts 0 '{"unacknowledged":[]}'
printf '1\n' > "$HARNESS_DIR/tools/check-cross-pr-reverts.ts.sleep"
gate >/dev/null
harness_commit "$WT" moved >/dev/null
harness_wait_job "$JOB_ID"
rm -f "$HARNESS_DIR/tools/check-cross-pr-reverts.ts.sleep"
assert_eq "no verdict for an ambiguous head" "no" "$([[ -f "$STATE/.cross-pr-guard-result.json" ]] && echo yes || echo no)"
assert_eq "discarded run is not a crash" "true" "$(jq -r '.ok' "$STATE_DIR/async-jobs/$JOB_ID/job-result.json")"

echo "=== 6. a moved base tip invalidates the verdict ==="
new_case
git -C "$WT" branch -q base-branch "$OLD_HEAD"
harness_tool_set check-cross-pr-reverts.ts 0 '{"unacknowledged":[]}'
gate_base() { local rc=0; ready_cross_pr_revert_gate "$ISSUE" "$STATE" "$WT" "$PR" "base-branch" || rc=$?; printf '%s\n' "$rc"; }
gate_base >/dev/null
harness_wait_job "$JOB_ID"
assert_eq "verdict records the base tip" "$OLD_HEAD" "$(jq -r '.detail.baseSha' "$STATE/.cross-pr-guard-result.json")"
assert_eq "same base passes" "0" "$(gate_base)"
git -C "$WT" branch -q -f base-branch "$HEAD_SHA"
assert_eq "moved base reads pending" "4" "$(gate_base)"
harness_wait_job "$JOB_ID"

echo "=== 7. reconciler expires a head-stale verdict ==="
new_case
harness_tool_set check-cross-pr-reverts.ts 0 '{"unacknowledged":[]}'
gate >/dev/null
harness_wait_job "$JOB_ID"
printf '{"tasks":{"%s":{"status":"active","pr":"%s"}}}\n' "$ISSUE" "$PR" > "$STATE_FILE"
condition_reconcile_task "$ISSUE" "$WT" "$STATE"
assert_eq "same-head verdict survives the reconciler" "yes" "$([[ -f "$STATE/.cross-pr-guard-result.json" ]] && echo yes || echo no)"
harness_commit "$WT" four >/dev/null
condition_reconcile_task "$ISSUE" "$WT" "$STATE"
assert_eq "head-stale verdict expired" "no" "$([[ -f "$STATE/.cross-pr-guard-result.json" ]] && echo yes || echo no)"

harness_finish
