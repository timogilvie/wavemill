#!/usr/bin/env bash
# HOK-3206: routing runs as tracked jobs instead of inside the monitor pass.
#
# Expanded reroute (plan->code handoff):
#   1. first read is pending + launches the reroute job; next read consumes it
#   2. a changed packet invalidates the result (keyed on packet content)
#   3. a failed reroute surfaces its reason to the handoff failure path
#   4. no packet / WAVEMILL_SYNC_ROUTING=1 run the reroute inline
#   4b. router.enabled=false (ROUTER_ENABLED) skips the reroute entirely
# Launch routing (launch_task):
#   5. a live-route miss defers the launch and runs route-task.ts in the
#      background; the route lands in the saved-route cache as route-job
#   6. the deferred queue holds the launch while the job runs, then
#      re-dispatches it once (fields survive an empty override base)
#   7. a failed route job falls back to the inline route exactly once

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_DIR="$(mktemp -d)"
trap 'rm -rf "$HARNESS_DIR"; rm -f /tmp/async-harness-HOK-7005-route.json /tmp/async-harness-HOK-7005-route-source.txt' EXIT
source "$SCRIPT_DIR/fixtures/monitor-perf/async-harness.sh"

ISSUE="HOK-7004"
FEATURE="$HARNESS_DIR/feature"
mkdir -p "$FEATURE"
printf '# Task packet\n\nDo the thing.\n' > "$FEATURE/task-packet.md"
JOB_ID="route-task-$ISSUE"

# Stub of the inline reroute (route-tasks.ts); behaviour from REROUTE_RC.
REROUTE_RC=0
reroute_expanded_packets_for_coding_handoff() {
  harness_record "reroute $1"
  REROUTE_EXPANDED_LAST_REASON="${REROUTE_REASON:-}"
  return "$REROUTE_RC"
}

gate() { local rc=0; expanded_reroute_gate "$ISSUE" "slug" "$FEATURE" || rc=$?; printf '%s\n' "$rc"; }

echo "=== 1. pending, then consumed ==="
assert_eq "first read pending" "4" "$(gate)"
harness_wait_job "$JOB_ID"
assert_eq "reroute registered as a tracked job" "1" "$(harness_count "launch_tracked_job kind=route-task id=$JOB_ID")"
assert_eq "reroute ran once" "1" "$(harness_count "reroute $ISSUE")"
assert_eq "second read consumes the result" "0" "$(gate)"
assert_eq "no second reroute" "1" "$(harness_count "reroute $ISSUE")"

echo "=== 2. a changed packet invalidates the result ==="
printf '\nRegenerated.\n' >> "$FEATURE/task-packet.md"
assert_eq "changed packet reads pending" "4" "$(gate)"
harness_wait_job "$JOB_ID"
assert_eq "rerouted for the new packet" "2" "$(harness_count "reroute $ISSUE")"

echo "=== 3. failed reroute reason reaches the handoff ==="
printf '\nAgain.\n' >> "$FEATURE/task-packet.md"
REROUTE_RC=1 REROUTE_REASON=routing_error
export REROUTE_RC REROUTE_REASON
gate >/dev/null
harness_wait_job "$JOB_ID"
rc=0; expanded_reroute_gate "$ISSUE" "slug" "$FEATURE" || rc=$?
assert_eq "failed reroute returns 1" "1" "$rc"
assert_eq "failure reason preserved" "routing_error" "$REROUTE_EXPANDED_LAST_REASON"
REROUTE_RC=0 REROUTE_REASON=""

echo "=== 4. inline paths ==="
: > "$HARNESS_LOG"
EMPTY="$HARNESS_DIR/empty-feature"
mkdir -p "$EMPTY"
rc=0; expanded_reroute_gate "$ISSUE" "slug" "$EMPTY" || rc=$?
assert_eq "no packet runs inline (cheap not_eligible path)" "1" "$(harness_count "reroute $ISSUE")"
printf '\nSync.\n' >> "$FEATURE/task-packet.md"
assert_eq "sync routing runs inline" "0" "$(WAVEMILL_SYNC_ROUTING=1 gate)"
assert_eq "no job in sync mode" "0" "$(harness_count "launch_tracked_job")"

echo "=== 4b. router disabled skips the expanded reroute ==="
# protects: router.enabled=false being ignored after expansion — the reroute
# swapped the operator's pinned agent for a routed reviewer (found by the
# golden journeys, HOK-3227).
: > "$HARNESS_LOG"
printf '\nRouter off.\n' >> "$FEATURE/task-packet.md"
rc=0; ROUTER_ENABLED=false expanded_reroute_gate "$ISSUE" "slug" "$FEATURE" || rc=$?
assert_eq "router disabled returns 1 (handoff keeps current route)" "1" "$rc"
assert_eq "skip reason is disabled" "disabled" "$REROUTE_EXPANDED_LAST_REASON"
assert_eq "no reroute ran" "0" "$(harness_count "reroute $ISSUE")"
assert_eq "no reroute job launched" "0" "$(harness_count "launch_tracked_job")"

echo "=== 5. launch routing defers on a live-route miss ==="
LAUNCH_ISSUE="HOK-7005"
PACKET="$HARNESS_DIR/packet.md"
printf 'Implement feature\n' > "$PACKET"
ROUTE='{"planner":"p","coder":"c","reviewer":"r"}'
harness_tool_set route-task.ts 0 "$ROUTE"
: > "$HARNESS_LOG"
assert_eq "route needed with no cache" "yes" "$(launch_task_needs_live_route "$LAUNCH_ISSUE" "" && echo yes || echo no)"
assert_eq "challenge model never routes" "no" "$(launch_task_needs_live_route "$LAUNCH_ISSUE" "some-model" && echo yes || echo no)"
rc=0; launch_task_route_prefetch "$LAUNCH_ISSUE" "$PACKET" "$FEATURE" || rc=$?
assert_eq "miss defers the launch" "$LAUNCH_TASK_DEFERRED_RC" "$rc"
harness_wait_job "launch-route-$LAUNCH_ISSUE"
assert_eq "route-task.ts ran in the background" "1" "$(harness_count "tool route-task.ts --json --file $PACKET")"
assert_eq "route saved for launch_task" "c" "$(jq -r '.coder' "/tmp/${SESSION}-${LAUNCH_ISSUE}-route.json")"
assert_eq "route source tagged route-job" "route-job:" "$(cut -c1-10 "/tmp/${SESSION}-${LAUNCH_ISSUE}-route-source.txt")"
rc=0; launch_task_route_prefetch "$LAUNCH_ISSUE" "$PACKET" "$FEATURE" || rc=$?
assert_eq "route ready: launch proceeds" "0" "$rc"

echo "=== 6. deferred queue ==="
DISPATCHED=()
dispatch_task_and_persist() { harness_record "dispatch $1|$2|$3|$4|${5:-}"; }
enqueue_deferred_launch "HOK-7006" "slug-six" "Six | title" 2 ""
enqueue_deferred_launch "HOK-7006" "slug-six" "Six | title" 2 ""
assert_eq "enqueue is idempotent" "1" "$(deferred_launch_count)"
mkdir -p "$STATE_DIR/async-jobs/launch-route-HOK-7006"
sleep 30 &
printf '%s %s\n' "$!" "$(date +%s)" > "$STATE_DIR/async-jobs/launch-route-HOK-7006/inflight"
drain_deferred_launches
assert_eq "held while the route job runs" "0" "$(harness_count "dispatch HOK-7006")"
assert_eq "still queued" "1" "$(deferred_launch_count)"
printf '%s %s\n' "$(cut -d' ' -f1 "$STATE_DIR/async-jobs/launch-route-HOK-7006/inflight")" "$(( $(date +%s) - 7200 ))" \
  > "$STATE_DIR/async-jobs/launch-route-HOK-7006/inflight.aged"
mv "$STATE_DIR/async-jobs/launch-route-HOK-7006/inflight" "$STATE_DIR/async-jobs/launch-route-HOK-7006/inflight.live"
mv "$STATE_DIR/async-jobs/launch-route-HOK-7006/inflight.aged" "$STATE_DIR/async-jobs/launch-route-HOK-7006/inflight"
assert_eq "an over-age pid is never running (pid reuse)" "no" "$(monitor_async_job_running launch-route-HOK-7006 && echo yes || echo no)"
mv "$STATE_DIR/async-jobs/launch-route-HOK-7006/inflight.live" "$STATE_DIR/async-jobs/launch-route-HOK-7006/inflight"
kill "$(cut -d' ' -f1 "$STATE_DIR/async-jobs/launch-route-HOK-7006/inflight")" 2>/dev/null || true
wait 2>/dev/null || true
drain_deferred_launches
assert_eq "re-dispatched once with intact fields" "1" "$(harness_count "dispatch HOK-7006|slug-six|Six | title|2|")"
assert_eq "dispatch counted for slot accounting" "1" "$DEFERRED_LAUNCHES_DISPATCHED"
assert_eq "queue drained" "0" "$(deferred_launch_count)"

echo "=== 7. failed route job falls back inline once ==="
FAIL_ISSUE="HOK-7007"
harness_tool_set route-task.ts 1 '' 'router unavailable'
rc=0; launch_task_route_prefetch "$FAIL_ISSUE" "$PACKET" "$FEATURE" || rc=$?
assert_eq "first miss defers" "$LAUNCH_TASK_DEFERRED_RC" "$rc"
harness_wait_job "launch-route-$FAIL_ISSUE"
handle_check_job_failure "launch-route-$FAIL_ISSUE" route-task failed job_failed "$STATE_DIR/async-jobs/launch-route-$FAIL_ISSUE/job-result.json"
rc=0; launch_task_route_prefetch "$FAIL_ISSUE" "$PACKET" "$FEATURE" || rc=$?
assert_eq "spent async try falls back to inline routing" "0" "$rc"
rm -f "/tmp/${SESSION}-${LAUNCH_ISSUE}-route.json" "/tmp/${SESSION}-${LAUNCH_ISSUE}-route-source.txt" \
  "/tmp/${SESSION}-${FAIL_ISSUE}-route.json" "/tmp/${SESSION}-${FAIL_ISSUE}-route-source.txt"

harness_finish
