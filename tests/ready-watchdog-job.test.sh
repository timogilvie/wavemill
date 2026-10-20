#!/usr/bin/env bash
# HOK-3206: the ready watchdog sweep runs as one global tracked job. Each tick
# consumes the previous sweep's findings exactly once, then starts the next.
#
#   1. first tick launches a sweep and dispatches nothing
#   2. next tick dispatches the sweep's findings (remediation + log) once
#   3. a sweep is never dispatched twice across ticks
#   4. findings older than 2x the sweep timeout are dropped
#   5. a failed sweep logs once (rate-limited), never dispatches

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_DIR="$(mktemp -d)"
trap 'rm -rf "$HARNESS_DIR"' EXIT
source "$SCRIPT_DIR/fixtures/monitor-perf/async-harness.sh"
# shellcheck source=lib/state-fixtures.sh
source "$SCRIPT_DIR/lib/state-fixtures.sh"
# Production state accessors (not the harness stubs) against the temp state.
fixture_real_state_accessors
eval "$(harness_extract_function ready_watchdog_config_json)"
eval "$(harness_extract_function run_ready_watchdog_tick)"
READY_WATCHDOG_SWEEP_INTERVAL_SECONDS=0

ISSUE="HOK-7003"
harness_new_worktree
# No writer sets baseBranch or title on a task row (HOK-3220 schema); the
# tick's reads of them fall back, so the fixture carries only written fields.
fixture_workflow_state "$STATE_FILE" "$ISSUE" slug=fix-ci branch=task/fix-ci pr=4403 worktree="$WT" phase=ready
FINDINGS='{"findings":[{"issueId":"HOK-7003","displayLabel":"ready-stable-failure","detail":"lint failed twice","action":"queue-remediation","remediationCategories":["lint"]}]}'
OUT_DIR="$STATE_DIR/async-jobs/ready-watchdog"

tick() { run_ready_watchdog_tick; }

echo "=== 1. first tick launches a sweep ==="
harness_tool_set ready-watchdog.ts 0 "$FINDINGS"
tick
harness_wait_job ready-watchdog
assert_eq "sweep registered as a tracked job" "1" "$(harness_count "launch_tracked_job kind=ready-watchdog id=ready-watchdog")"
assert_eq "sweep ran with --once --json" "1" "$(harness_count "tool ready-watchdog.ts --once --repo-dir $REPO_DIR --state-file $STATE_FILE --json")"
assert_eq "nothing dispatched before the sweep lands" "0" "$(harness_count "launch_ready_phase")"

echo "=== 2. next tick dispatches the findings ==="
# The sweep this tick starts reports nothing new.
harness_tool_set ready-watchdog.ts 0 '{"findings":[]}'
tick
harness_wait_job ready-watchdog
assert_eq "remediation launched for the finding" "1" "$(harness_count "launch_ready_phase $ISSUE pr=4403")"
assert_eq "finding logged" "1" "$(harness_count "ready watchdog: $ISSUE ready-stable-failure")"
assert_eq "stable-failure marker keyed on the task head" "$HEAD_SHA" "$(marker_head "$WT/features/fix-ci/.ready-watchdog-stable-failure.json")"
assert_eq "next sweep launched" "2" "$(harness_count "tool ready-watchdog.ts")"

echo "=== 3. a sweep is dispatched once ==="
tick
harness_wait_job ready-watchdog
tick
harness_wait_job ready-watchdog
assert_eq "no duplicate dispatch" "1" "$(harness_count "launch_ready_phase")"

echo "=== 4. stale findings are dropped ==="
jq -n --argjson out "$FINDINGS" --argjson at "$(( $(date +%s) - 3600 ))" '{seq: 42, at: $at, output: $out}' > "$OUT_DIR/output.json"
tick
harness_wait_job ready-watchdog
assert_eq "hour-old findings not dispatched" "1" "$(harness_count "launch_ready_phase")"

echo "=== 5. failed sweep logs once ==="
harness_tool_set ready-watchdog.ts 2 '' 'boom: state unreadable'
tick
harness_wait_job ready-watchdog
tick
harness_wait_job ready-watchdog
tick
assert_eq "failure logged once" "1" "$(harness_count "warn ready watchdog tick failed: boom: state unreadable")"
assert_eq "failure dispatches nothing" "1" "$(harness_count "launch_ready_phase")"
harness_wait_job ready-watchdog

echo "=== 6. sweep cadence is capped ==="
READY_WATCHDOG_SWEEP_INTERVAL_SECONDS=3600
: > "$HARNESS_LOG"
tick
tick
assert_eq "no sweep inside the interval" "0" "$(harness_count "tool ready-watchdog.ts")"
READY_WATCHDOG_SWEEP_INTERVAL_SECONDS=0

harness_finish
