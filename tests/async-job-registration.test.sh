#!/usr/bin/env bash
# protects: a failed tracker write must never run an untracked investigation.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CASE_DIR="$(mktemp -d)"
trap 'rm -rf "$CASE_DIR"' EXIT
source "$ROOT/shared/lib/transient-marker.sh"
source "$ROOT/shared/lib/bounded-retry.sh"
source "$ROOT/shared/lib/monitor-async-jobs.sh"
source "$ROOT/tests/lib/inline-ready-checks.sh"
STATE_DIR="$CASE_DIR"
log_warn() { :; }
launch_tracked_job() { return 17; }
_with_timeout() { touch "$CASE_DIR/runner-started"; }
meta="$(jq -cn --arg stateDir "$CASE_DIR" '{stateDir:$stateDir,bucket:"root-cause-investigation",key:"revision"}')"
monitor_async_job_launch root-cause-investigation investigation-1 '' '' 30 "$meta" unused
result="$CASE_DIR/async-jobs/investigation-1/job-result.json"
for _ in $(seq 1 100); do
  [[ ! -f "$result" ]] || break
  sleep 0.05
done
[[ -f "$result" ]]
jq -e '.ok == false and .exitCode == 17' "$result" >/dev/null
[[ ! -e "$CASE_DIR/runner-started" ]]
[[ "$(bounded_retry_count "$CASE_DIR" root-cause-investigation)" == 1 ]]
echo 'PASS failed registration suppresses worker and charges the existing retry bucket'

# protects: registration must name the notifier's captured run even if state
# was replaced before the asynchronous worker got CPU time.
launch_tracked_job() { printf '%s' "${11:-}" > "$CASE_DIR/captured-run"; }
_with_timeout() { return 0; }
monitor_async_job_launch task-recovery recovery-captured HOK-1 '' 30 '{"runId":"original-run"}' unused
for _ in $(seq 1 100); do
  [[ ! -f "$CASE_DIR/captured-run" ]] || break
  sleep 0.05
done
[[ "$(cat "$CASE_DIR/captured-run")" == original-run ]]
echo 'PASS registration preserves the captured recovery run'
