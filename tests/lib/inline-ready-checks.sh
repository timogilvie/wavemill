#!/usr/bin/env bash
# Inline ready-checks shim (HOK-3235).
#
# Pre-HOK-3206 the cross-PR revert guard, PR CI status read, ready-watchdog
# sweep and plan->code expanded reroute ran synchronously inside each monitor
# pass. HOK-3206 moved them to tracked background jobs with condition-keyed
# result markers, and `WAVEMILL_SYNC_READY_CHECKS` / `WAVEMILL_SYNC_ROUTING`
# were kept as debug rollbacks that forced the inline path.
#
# HOK-3235 retires those env flags from production. Tests that still pin the
# inline contract source this shim after `monitor-async-jobs.sh` to redefine
# the async wrappers back to their inline equivalents. Nothing in production
# ever sources this file.
#
# Guarded by sourcing: a test opts in with
#     source "$REPO_DIR/tests/lib/inline-ready-checks.sh"
# and gets inline cross-PR guard, inline live CI, inline expanded reroute, and
# a no-op launch-task route prefetch. The watchdog tick becomes a no-op by
# removing the async consumer `ready_watchdog_tick_async` — `run_ready_watchdog_tick`
# then logs a warn and returns 0 without touching the job infrastructure.
# A pass-through stub of `sanitize_job_token` is also defined so any residual
# call that still reaches `monitor_async_job_launch` from an extracted function
# does not crash with "command not found".

# Fast forward of the cross-PR revert gate: inline implementation.
ready_cross_pr_revert_gate() {
  cross_pr_revert_gate_allows_merge "$@"
}

# PR CI status read, inline.
ready_ci_json_cached() {
  local wt_dir="$1" pr_number="$2" base_branch="$3"
  ready_live_ci_json "$wt_dir" "$pr_number" "$base_branch"
}

# Expanded reroute at plan->code handoff, inline. Mirrors the pre-HOK-3206
# synchronous branch: honour router.enabled=false, otherwise call the handoff
# rerouter directly and ignore the marker / job infrastructure.
expanded_reroute_gate() {
  local issue="$1" slug="$2" feature_dir="$3"
  REROUTE_EXPANDED_LAST_REASON=""
  if [[ "${ROUTER_ENABLED:-true}" != "true" ]]; then
    REROUTE_EXPANDED_LAST_REASON="disabled"
    return 1
  fi
  reroute_expanded_packets_for_coding_handoff "$issue" "$slug" "$feature_dir"
}

# Launch route prefetch, inline: no deferral, caller falls through to live
# route-task.ts.
launch_task_route_prefetch() {
  return 0
}

# Pass-through stub so residual async-job entry points that are still reachable
# from an extracted function do not crash. The real implementation lives in
# wavemill-monitor.sh; harnesses that extract individual functions do not source
# it, so pre-HOK-3235 these calls were short-circuited by WAVEMILL_SYNC_READY_CHECKS.
if ! declare -F sanitize_job_token >/dev/null 2>&1; then
  sanitize_job_token() { printf '%s' "${1:-unknown}" | sed 's/[^A-Za-z0-9._-]/-/g'; }
fi

# Drop the async watchdog consumer so run_ready_watchdog_tick returns 0 without
# touching the job infrastructure (the retired inline sweep is not restored here).
unset -f ready_watchdog_tick_async 2>/dev/null || true
