#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154

# HOK-2972 / HOK-2963: the coding agent exits (SIGTERM) before writing any
# completion marker, leaving the pane alive at a bare shell and the stage
# result stuck at "running". The monitor must reconcile phase state with
# process ownership within one iteration: persist a typed interrupted
# outcome that preserves the durable commits, surface needs-user, and never
# relaunch or duplicate work on later iterations.
register_lifecycle_scenario coding_agent_exit_interrupted

setup_coding_agent_exit_interrupted() {
  CURRENT_PHASE="coding"
  PR=""
  PANE_ALIVE="true"
  MONITOR_ITERATIONS=2
  create_git_worktree

  # Coding started well past the owner-loss grace window; the agent produced
  # durable commits, then exited without a terminal stage result.
  local started_at
  started_at="$(date -u -v-30M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || date -u -d "30 minutes ago" +%Y-%m-%dT%H:%M:%SZ)"
  printf '{"stage":"coding","status":"running","startedAt":"%s","agent":"codex"}\n' "$started_at" \
    > "$FEATURE_DIR/.coding-result.json"

  # No fresh hook heartbeat and no live descendant under the pane shell:
  # the recorded owner is affirmatively gone (an idle shell only).
  fresh_hook_state_for_issue() { printf '\n'; }
  mill_pane_has_live_blocking_process() { return 1; }
  # Second-iteration failed-stage handlers: no bounded retry available and
  # no quarantine side effects; the arm must simply stay parked for the user.
  maybe_retry_challenger_transient_phase() { return 1; }
  emit_challenge_stage_failure_quarantine() { return 0; }
}

assert_coding_agent_exit_interrupted() {
  local output="$1"

  check_contains "interrupted stage result recorded" "$output" "|coding|failed|"
  check_contains "typed interruption class persisted" "$output" '"terminationClass":"interrupted"'
  check_contains "durable head recorded for recovery" "$output" '"lastDurableCommit":'
  check_contains "validation recorded as unknown, not failed" "$output" '"validationState":"unknown"'
  check_contains "interruption names the recovery action" "$output" "Relaunch the coding phase"
  check_contains "operator surfaced" "$output" "attention=needs-user"
  check_contains "second iteration launches no coding agent" "$output" "coding_launches=0"
  check_contains "second iteration launches no review" "$output" "review_launches=0"
}
