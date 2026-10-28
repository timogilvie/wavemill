#!/usr/bin/env bash
# HOK-3306: the in-flight touch-set job writes a condition-keyed marker that
# the monitor hot pass reads to pass per-task file lists through the picker.
#
#   1. clean head: first call is pending + launches the job; next call reads
#      a sorted/deduped files list from the marker
#   2. a head that moves mid-run publishes no verdict (gate re-launches)
#   3. non-array output from the tool is a job failure (no marker)
#   4. a stale marker for an older head reads as pending; relaunches at new head

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_DIR="$(mktemp -d)"
trap 'rm -rf "$HARNESS_DIR"' EXIT
source "$SCRIPT_DIR/fixtures/monitor-perf/async-harness.sh"

ISSUE="HOK-7101"
JOB_ID="in-flight-touch-set-$ISSUE"

gate_files() {
  local out
  out="$(in_flight_touch_set_gate "$ISSUE" "$STATE" "$WT" "$HEAD_SHA" "main" "coding" "$STATE" 2>/dev/null || true)"
  printf '%s\n' "$out"
}

new_case() {
  harness_new_worktree
  STATE="$WT/features/task"
  mkdir -p "$STATE"
  : > "$HARNESS_LOG"
  rm -rf "$STATE_DIR/async-jobs"
}

echo "=== 1. clean head: pending, then returns files ==="
new_case
harness_tool_set compute-in-flight-touch-set.ts 0 '["shared/lib/a.ts","shared/lib/b.ts"]'
first="$(gate_files)"
assert_eq "first call returns empty while job runs" "[]" "$first"
harness_wait_job "$JOB_ID"
assert_eq "job registered" "1" "$(harness_count "launch_tracked_job kind=in-flight-touch-set id=$JOB_ID")"
assert_eq "tool spawned once" "1" "$(harness_count "tool compute-in-flight-touch-set.ts")"
assert_eq "marker keyed on head" "$HEAD_SHA" "$(marker_head "$STATE/.in-flight-touch-set-result.json")"
second="$(gate_files | jq -c '.' 2>/dev/null)"
assert_eq "second call returns the file list" '["shared/lib/a.ts","shared/lib/b.ts"]' "$second"
assert_eq "no second tool spawn for the same head" "1" "$(harness_count "tool compute-in-flight-touch-set.ts")"

echo "=== 2. head moved mid-run publishes nothing ==="
new_case
harness_tool_set compute-in-flight-touch-set.ts 0 '["shared/lib/a.ts"]'
printf '1\n' > "$HARNESS_DIR/tools/compute-in-flight-touch-set.ts.sleep"
gate_files >/dev/null
harness_commit "$WT" moved >/dev/null
harness_wait_job "$JOB_ID"
rm -f "$HARNESS_DIR/tools/compute-in-flight-touch-set.ts.sleep"
assert_eq "no verdict for an ambiguous head" "no" "$([[ -f "$STATE/.in-flight-touch-set-result.json" ]] && echo yes || echo no)"
assert_eq "discarded run is not a crash" "true" "$(jq -r '.ok' "$STATE_DIR/async-jobs/$JOB_ID/job-result.json")"

echo "=== 3. non-array output is a job failure ==="
new_case
harness_tool_set compute-in-flight-touch-set.ts 0 '{"not":"an array"}'
gate_files >/dev/null
harness_wait_job "$JOB_ID"
assert_eq "no marker on bad output" "no" "$([[ -f "$STATE/.in-flight-touch-set-result.json" ]] && echo yes || echo no)"
assert_eq "job result records failure" "false" "$(jq -r '.ok' "$STATE_DIR/async-jobs/$JOB_ID/job-result.json")"

echo "=== 4. a stale marker for an older head reads as pending ==="
new_case
harness_tool_set compute-in-flight-touch-set.ts 0 '["shared/lib/a.ts"]'
gate_files >/dev/null
harness_wait_job "$JOB_ID"
NEW_HEAD="$(harness_commit "$WT" new-commit)"
HEAD_SHA="$NEW_HEAD"
assert_eq "new head reads pending" "[]" "$(gate_files)"
harness_wait_job "$JOB_ID"
assert_eq "relaunched for the new head" "2" "$(harness_count "tool compute-in-flight-touch-set.ts")"
assert_eq "marker now keyed on new head" "$NEW_HEAD" "$(marker_head "$STATE/.in-flight-touch-set-result.json")"

harness_finish
