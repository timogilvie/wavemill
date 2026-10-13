#!/usr/bin/env bash
# HOK-3206 acceptance smoke: with the slow ready-path tools stubbed to take
# 3 s each and three ready tasks, the monitor-side consumers stay fast (the
# work happens in background jobs), and monitor-timing.json records the
# per-pass GitHub counters and async job stats.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_DIR="$(mktemp -d)"
trap 'rm -rf "$HARNESS_DIR"' EXIT
source "$SCRIPT_DIR/fixtures/monitor-perf/async-harness.sh"
for fn in wavemill_monitor_now_ms ready_watchdog_config_json run_ready_watchdog_tick monitor_step_begin monitor_step_end \
  monitor_reset_steps wavemill_record_monitor_iteration_timing _monitor_counter_take monitor_github_pass_counters_json; do
  eval "$(harness_extract_function "$fn")"
done
declare -A MONITOR_STEP_MS=()
declare -A MONITOR_STEP_START_MS=()
READY_WATCHDOG_FAILURE_LOG_INTERVAL=300
READY_WATCHDOG_SWEEP_INTERVAL_SECONDS=0

now_ms() { wavemill_monitor_now_ms 2>/dev/null || echo $(( $(date +%s) * 1000 )); }

harness_tool_set check-cross-pr-reverts.ts 0 '{"unacknowledged":[]}'
harness_tool_set ready-watchdog.ts 0 '{"findings":[]}'
for tool in check-cross-pr-reverts.ts ready-watchdog.ts pr-ci-status.ts; do
  printf '3\n' > "$HARNESS_DIR/tools/$tool.sleep"
done

declare -a WTS=() STATES=()
for n in 1 2 3; do
  harness_new_worktree
  WTS+=("$WT")
  STATES+=("$WT/features/task")
  mkdir -p "$WT/features/task"
done
harness_tool_set pr-ci-status.ts 0 "$(jq -cn --arg h "$HEAD_SHA" '{conclusion:"pass",headSha:$h}')"

run_pass() {
  local i rc
  monitor_reset_steps
  monitor_async_job_stats_reset
  monitor_step_begin readyWatchdog
  run_ready_watchdog_tick
  monitor_step_end readyWatchdog
  monitor_step_begin readyCrossPrGuard
  for i in 0 1 2; do
    rc=0; ready_cross_pr_revert_gate "HOK-80$i" "${STATES[$i]}" "${WTS[$i]}" "50$i" "" || rc=$?
  done
  monitor_step_end readyCrossPrGuard
  monitor_step_begin readyMergeQueue
  for i in 0 1 2; do
    ready_ci_json_cached "${WTS[$i]}" "50$i" main "HOK-80$i" "${STATES[$i]}" >/dev/null
  done
  monitor_step_end readyMergeQueue
}

echo "=== launch pass: every slow check is backgrounded ==="
start="$(now_ms)"
run_pass
elapsed=$(( $(now_ms) - start ))
if (( elapsed < 5000 )); then pass "launch pass ${elapsed}ms < 5000ms with 3x3s of tool work"; else fail "launch pass took ${elapsed}ms"; fi
for step in readyWatchdog readyCrossPrGuard readyMergeQueue; do
  ms="${MONITOR_STEP_MS[$step]:-0}"
  if (( ms < 5000 )); then pass "$step ${ms}ms < 5000ms"; else fail "$step ${ms}ms"; fi
done
assert_eq "three guard jobs pending" "3" "$(monitor_async_job_stats_json | jq -r '."cross-pr-guard".pending')"

for i in 0 1 2; do harness_wait_job "cross-pr-guard-HOK-80$i"; harness_wait_job "pr-ci-status-HOK-80$i"; done
harness_wait_job ready-watchdog

echo "=== steady-state pass: results consumed, nothing slow inline ==="
start="$(now_ms)"
run_pass
elapsed=$(( $(now_ms) - start ))
if (( elapsed < 5000 )); then pass "steady pass ${elapsed}ms < 5000ms"; else fail "steady pass took ${elapsed}ms"; fi
assert_eq "three guard verdicts consumed" "3" "$(monitor_async_job_stats_json | jq -r '."cross-pr-guard".consumed')"
assert_eq "three CI results consumed" "3" "$(monitor_async_job_stats_json | jq -r '."pr-ci-status".consumed')"

echo "=== monitor-timing.json carries github + jobs ==="
printf '...' > "$MONITOR_PR_CACHE.gh-calls"
MONITOR_GH_CALL_COUNTER_FILE="$MONITOR_PR_CACHE.gh-calls"
wavemill_record_monitor_iteration_timing 1000 2000 10
timing="$STATE_DIR/monitor-timing.json"
assert_eq "ghCalls recorded" "3" "$(jq -r '.github.ghCalls' "$timing")"
assert_eq "counter reset after the pass" "0" "$(wc -c < "$MONITOR_PR_CACHE.gh-calls" | tr -d ' ')"
assert_eq "jobs stats recorded" "3" "$(jq -r '.jobs."cross-pr-guard".consumed' "$timing")"
for i in 0 1 2; do harness_wait_job "cross-pr-guard-HOK-80$i"; harness_wait_job "pr-ci-status-HOK-80$i"; done
harness_wait_job ready-watchdog

harness_finish
