#!/usr/bin/env bash
# HOK-3206: the merge-queue tick reads CI through ready_ci_json_cached. CI for
# a PR is read by a tracked job and consumed only while it is for the PR's
# current GitHub head (from the per-pass PR cache).
#
#   1. no result: pending "unknown" shape (never a pass) + one job launch
#   2. result for the live head is served without spawning anything
#   3. result older than the refresh window is served and refreshed
#   4. the PR head moved: the old result is pending, never consumed
#   5. a read with no head is a job failure; exhaustion reports readError
#   6. the reconciler expires the result when the PR head moves (remote)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_DIR="$(mktemp -d)"
trap 'rm -rf "$HARNESS_DIR"' EXIT
source "$SCRIPT_DIR/fixtures/monitor-perf/async-harness.sh"

ISSUE="HOK-7002"
PR=4402
JOB_ID="pr-ci-status-$ISSUE"
HEAD_A="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
HEAD_B="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

set_pr_cache_head() {
  jq -n --argjson pr "$PR" --arg head "$1" '[{number: $pr, headRefName: "task/x", headRefOid: $head, state: "OPEN"}]' > "$MONITOR_PR_CACHE"
  jq -n --argjson at "$(date +%s)" '{schemaVersion: 1, branches: ["task/x"], complete: true, writtenAt: $at}' > "$MONITOR_PR_CACHE.meta.json"
}
ci_out() { jq -cn --arg head "$1" --arg c "$2" '{conclusion: $c, observed: 3, passing: 3, failing: [], pending: [], missingRequired: [], requiredContexts: ["CI"], requiredSource: "branch-protection", headSha: $head, state: "OPEN"}'; }
read_ci() { ready_ci_json_cached "$WT" "$PR" "main" "$ISSUE" "$STATE"; }

harness_new_worktree
STATE="$WT/features/task"
mkdir -p "$STATE"

echo "=== 1. no result: pending + launch ==="
set_pr_cache_head "$HEAD_A"
harness_tool_set pr-ci-status.ts 0 "$(ci_out "$HEAD_A" pass)"
out="$(read_ci)"
assert_eq "pending is not a pass" "unknown" "$(jq -r '.conclusion' <<<"$out")"
assert_eq "pending reason names the job" "pr-ci-status-running" "$(jq -r '.pendingReason' <<<"$out")"
harness_wait_job "$JOB_ID"
assert_eq "one CI read launched" "1" "$(harness_count "tool pr-ci-status.ts $PR")"
assert_eq "result keyed on the PR head" "$HEAD_A" "$(marker_head "$STATE/.pr-ci-status-result.json")"

echo "=== 2. fresh result for the live head ==="
out="$(read_ci)"
assert_eq "served the recorded conclusion" "pass" "$(jq -r '.conclusion' <<<"$out")"
assert_eq "served the recorded head" "$HEAD_A" "$(jq -r '.headSha' <<<"$out")"
assert_eq "no extra read inside the refresh window" "1" "$(harness_count "tool pr-ci-status.ts")"

echo "=== 3. result past the refresh window is served and refreshed ==="
jq '.detail.observedAtEpoch -= 120' "$STATE/.pr-ci-status-result.json" > "$STATE/x.json" && mv "$STATE/x.json" "$STATE/.pr-ci-status-result.json"
harness_tool_set pr-ci-status.ts 0 "$(ci_out "$HEAD_A" fail)"
out="$(read_ci)"
assert_eq "stale-but-same-head result still served" "pass" "$(jq -r '.conclusion' <<<"$out")"
harness_wait_job "$JOB_ID"
assert_eq "background refresh ran" "2" "$(harness_count "tool pr-ci-status.ts")"
assert_eq "refreshed conclusion consumed next pass" "fail" "$(read_ci | jq -r '.conclusion')"

echo "=== 4. PR head moved: old result never consumed ==="
set_pr_cache_head "$HEAD_B"
harness_tool_set pr-ci-status.ts 0 "$(ci_out "$HEAD_B" pending)"
out="$(read_ci)"
assert_eq "other-head result reads pending" "unknown" "$(jq -r '.conclusion' <<<"$out")"
assert_eq "pending carries the live head" "$HEAD_B" "$(jq -r '.headSha' <<<"$out")"
harness_wait_job "$JOB_ID"
assert_eq "new head consumed after the job" "pending" "$(read_ci | jq -r '.conclusion')"

echo "=== 5. headless read fails; exhaustion reports readError ==="
rm -f "$STATE/.pr-ci-status-result.json"
HEAD_C="cccccccccccccccccccccccccccccccccccccccc"
set_pr_cache_head "$HEAD_C"
harness_tool_set pr-ci-status.ts 0 '{"conclusion":"unknown","readError":{"errorType":"network","reason":"timeout"}}'
ASYNC_CHECK_JOB_RETRY_LIMIT=1
read_ci >/dev/null
harness_wait_job "$JOB_ID"
assert_eq "headless read is a job failure" "false" "$(jq -r '.ok' "$STATE_DIR/async-jobs/$JOB_ID/job-result.json")"
handle_check_job_failure "$JOB_ID" pr-ci-status failed job_failed "$STATE_DIR/async-jobs/$JOB_ID/job-result.json"
out="$(read_ci)"
assert_eq "exhausted read reports readError" "command-failed" "$(jq -r '.readError.errorType' <<<"$out")"
assert_eq "exhausted read is not a pass" "unknown" "$(jq -r '.conclusion' <<<"$out")"
ASYNC_CHECK_JOB_RETRY_LIMIT=3

echo "=== 6. reconciler expires the result when the PR head moves ==="
harness_tool_set pr-ci-status.ts 0 "$(ci_out "$HEAD_A" pass)"
set_pr_cache_head "$HEAD_A"
pr_ci_status_job_run "$WT" "$STATE" "$PR" main >/dev/null
printf '{"tasks":{"%s":{"status":"active","pr":"%s"}}}\n' "$ISSUE" "$PR" > "$STATE_FILE"
condition_reconcile_task "$ISSUE" "$WT" "$STATE"
assert_eq "result for the live PR head survives" "yes" "$([[ -f "$STATE/.pr-ci-status-result.json" ]] && echo yes || echo no)"
set_pr_cache_head "$HEAD_B"
condition_reconcile_task "$ISSUE" "$WT" "$STATE"
assert_eq "remote-stale result expired" "no" "$([[ -f "$STATE/.pr-ci-status-result.json" ]] && echo yes || echo no)"


harness_finish
