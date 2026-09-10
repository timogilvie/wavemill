#!/usr/bin/env bash
# HOK-2957 fault injection + restart equivalence test.
#
# For a representative scenario, capture a golden end state (uninterrupted
# run), then run the same scenario faulted at each named boundary and
# restart from persisted state; the normalized final projections must match.
#
# This is deliberately a small representative slice; the exhaustive matrix
# lives locally under WAVEMILL_CERT_EXHAUSTIVE=1.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/lifecycle-certification-harness.sh
source "$SCRIPT_DIR/lib/lifecycle-certification-harness.sh"
# shellcheck source=lib/lifecycle-invariants.sh
source "$SCRIPT_DIR/lib/lifecycle-invariants.sh"
incident_harness_require_tools

FIXTURES_DIR="$SCRIPT_DIR/fixtures/incidents"
# shellcheck source=fixtures/incidents/squash_delivery_deleted_remote_head.sh
source "$FIXTURES_DIR/squash_delivery_deleted_remote_head.sh"

FAILURES=0
FAIL_BOUNDARIES=(
  "after_terminal_reason"
  "after_archive"
  "after_terminal_record"
  "after_kill_window"
  "after_state_write"
)

report_pass() { printf '  PASS: %s\n' "$1"; }
report_fail() { printf '  FAIL: %s\n' "$1" >&2; FAILURES=$((FAILURES + 1)); }

run_golden() {
  incident_scenario_new "cert-fault-golden-$RANDOM"
  incident_scenario_start_tmux
  incident_setup_squash_delivery
  incident_scenario_add_task_window "$SQUASH_ISSUE" "$SQUASH_SLUG"
  run_monitor_tick "$SQUASH_ISSUE" "$SQUASH_SLUG" "$SQUASH_PR" >/dev/null
  GOLDEN_STATE="$(cert_capture_state "$SQUASH_ISSUE")"
  incident_scenario_teardown "$SCENARIO_DIR" "$TMUX_SOCK" "$REAL_TMUX"
}

run_faulted_restart() {
  local boundary="$1"
  incident_scenario_new "cert-fault-$boundary-$RANDOM"
  incident_scenario_start_tmux
  incident_setup_squash_delivery
  incident_scenario_add_task_window "$SQUASH_ISSUE" "$SQUASH_SLUG"
  WAVEMILL_CERT_FAULT_POINT="$boundary" run_monitor_tick "$SQUASH_ISSUE" "$SQUASH_SLUG" "$SQUASH_PR" >/dev/null || true
  # Restart replay: with the fault removed, re-run the tick from persisted state.
  unset WAVEMILL_CERT_FAULT_POINT
  run_monitor_tick "$SQUASH_ISSUE" "$SQUASH_SLUG" "$SQUASH_PR" >/dev/null || true
  local restarted_state
  restarted_state="$(cert_capture_state "$SQUASH_ISSUE")"

  # Compare structural equivalence: presence + branchAlive + worktreeAlive
  # + resourceDisposition. Deliberately do not compare event-order fields.
  local golden_norm restarted_norm
  golden_norm="$(jq -c '{present, branchAlive, worktreeAlive, resourceDisposition}' <<<"$GOLDEN_STATE")"
  restarted_norm="$(jq -c '{present, branchAlive, worktreeAlive, resourceDisposition}' <<<"$restarted_state")"
  if [[ "$golden_norm" == "$restarted_norm" ]]; then
    report_pass "restart equivalence at boundary '$boundary'"
  else
    report_fail "restart equivalence at boundary '$boundary': golden=$golden_norm restarted=$restarted_norm"
  fi
  incident_scenario_teardown "$SCENARIO_DIR" "$TMUX_SOCK" "$REAL_TMUX"
}

echo "=== Lifecycle Certification Fault Suite (scoped) ==="

run_golden

for boundary in "${FAIL_BOUNDARIES[@]}"; do
  run_faulted_restart "$boundary"
done

if [[ "$FAILURES" -gt 0 ]]; then
  echo "$FAILURES failure(s)" >&2
  exit 1
fi
echo "PASS: lifecycle-certification-faults.test.sh"
