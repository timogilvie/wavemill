#!/usr/bin/env bash
# Golden journey (HOK-3454): a challenger's coder leaves a dirty tree twice at
# the same head, exhausting the coding-dirty-handoff bounded retry
# (HOK-3128). The challenger is quarantined through
# `cleanup_quarantined_no_pr_challenge_arm` -> `cleanup_aborted_challenge_arm`
# -> `mark_task_aborted_for_cleanup` (shared/lib/wavemill-monitor.sh), the
# same writer that cleaned up the real HOK-3424_c challenger row. The
# challenger never pushed its branch (it died before review), so cleanup
# retains it under `needs-user` rather than reaping it outright -- that part
# is unrelated to this fix and not asserted here.
#
# Protects against: this writer flipping `workflowOutcome` to a terminal
# value without `retention` while `resourceDisposition` still requires it --
# the exact invalid-pair signature the task-record write guard shadow-logged
# for HOK-3424_c. No other golden journey drives this writer:
# challenge-pair-eval only exercises `cleanup_merged_primary_challenge_task`
# (the winner/loser comparison path); operator-abort.journey.sh only
# exercises the TS abort-task recorder.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP challenger-dirty-handoff-exhaustion journey: $reason"
  exit 0
fi

FIXTURE_DIR="$(cd "$(dirname "$0")/fixtures/challenger-dirty-handoff-exhaustion" && pwd)"
# shellcheck source=../../shared/lib/task-identity.sh
source "$JOURNEY_INSTALL_DIR/shared/lib/task-identity.sh"

ISSUE="JRN-6"
CHALLENGER="$(task_identity_challenger_id "$ISSUE")"
# The two coder models the pair may draw (both resolve to the claude CLI).
POOL_MODELS=(claude-sonnet-4-6 claude-haiku-4-5-20251001)

# Before journey_init: the tmux server (and so every agent pane) inherits the
# environment at init. The exit grace (default 120s) guards a live agent that
# writes the marker and then commits; it is wall-clock, not tick-clock, and
# the fake agent's exit is already final, so waiting it out would only burn
# the journey budget.
export WAVEMILL_CODING_DIRTY_HANDOFF_GRACE_SECONDS=0
export FAKE_AGENT_SCRIPT_DIR="$FIXTURE_DIR/fake-agent"
journey_init challenger-dirty-handoff-exhaustion
fakes_linear_add_issue "$ISSUE" "Challenger leaves a dirty tree" Todo

# Challenge on: every task rolls an implementation-stage pair. Every other
# coder in the registry is excluded so the pair is drawn from POOL_MODELS.
exclusions="$(cd "$JOURNEY_INSTALL_DIR" && node --import tsx -e '
  const { listEffectiveModelsForStage } = await import("./shared/lib/effective-models.ts");
  const keep = new Set(process.argv.slice(1));
  const out = [...new Set([
    ...listEffectiveModelsForStage("coding").models,
    ...listEffectiveModelsForStage("planning").models,
  ])]
    .filter((m) => !keep.has(m))
    .map((model) => ({ model, reason: "challenger-dirty-handoff-exhaustion journey: keep the pair on the fake claude CLI" }));
  console.log(JSON.stringify(out));
' "${POOL_MODELS[@]}")"
journey_write_config "$(jq -cn --argjson ex "$exclusions" '{
  challenge: {enabled: true, rate: 1, stageWeights: {implementation: 1}, autoMergeWinner: true},
  modelExclusions: $ex
}')"
unset WAVEMILL_DISABLE_CHALLENGE

journey_start_monitor
journey_set_tick_budget 40
journey_wait_until "$ISSUE" 5  "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

field() { journey_task_field "$1" "$2"; }
phase_is() { [[ "$(field "$ISSUE" phase)" == "$1" ]]; }
challenger_launched() { [[ -n "$(field "$CHALLENGER" slug)" ]]; }
mill_log_count() {
  sed 's/\x1b\[[0-9;]*[A-Za-z]//g' "$JOURNEY_TMP/logs/monitor.out" "$JOURNEY_TMP/logs/status.log" 2>/dev/null \
    | grep -c "$1" || true
}
dirty_handoff_relaunched() { [[ "$(mill_log_count "coding-dirty-handoff relaunch (agent exited")" -ge 1 ]]; }
challenger_quarantined_count() { mill_log_count "coding-dirty-handoff exhausted: challenger quarantined"; }
dirty_handoff_exhausted() { [[ "$(challenger_quarantined_count)" -ge 1 ]]; }
challenger_lifecycle() { jq -c --arg c "$CHALLENGER" '.tasks[$c].lifecycle // {}' "$STATE_FILE" 2>/dev/null; }
challenger_lifecycle_field() { challenger_lifecycle | jq -r "$1 // empty"; }
challenger_retention_stamped() { [[ -n "$(challenger_lifecycle_field .retention.reason)" ]]; }

# Budgets are monitor ticks (passes), not seconds.
journey_wait_until "$ISSUE" 5  "task launched into planning"          phase_is planning
journey_wait_until "$ISSUE" 10 "challenger forked after the plan"     challenger_launched
journey_wait_until "$ISSUE" 15 "dirty-handoff relaunched the coder"   dirty_handoff_relaunched
journey_wait_until "$ISSUE" 15 "dirty-handoff exhausted on the challenger" dirty_handoff_exhausted
# The exhaustion log line prints before cleanup_quarantined_no_pr_challenge_arm
# -> ... -> mark_task_aborted_for_cleanup runs and persists the retention
# stamp, so settle on the write itself before asserting its shape.
journey_wait_until "$ISSUE" 5  "challenger lifecycle.retention is persisted" challenger_retention_stamped

echo ""
echo "assertions:"
journey_assert "exactly one coding-dirty-handoff relaunch (ceiling 1, keyed on head)" \
  test "$(mill_log_count "coding-dirty-handoff relaunch (agent exited")" = "1"
journey_assert "exactly one dirty-handoff exhaustion (challenger quarantined, primary released)" \
  test "$(challenger_quarantined_count)" = "1"
# HOK-3454: this is the exact invalid-pair precondition HOK-3424_c shadow-
# logged -- a terminal workflowOutcome paired with a resourceDisposition that
# requires retention. The writer must stamp it, not just claim terminality.
journey_assert "challenger lifecycle.workflowOutcome = aborted" \
  test "$(challenger_lifecycle_field .workflowOutcome)" = "aborted"
journey_assert "challenger lifecycle.resourceDisposition downgraded to verification-required" \
  test "$(challenger_lifecycle_field .resourceDisposition)" = "verification-required"
journey_assert "challenger lifecycle.retention.reason is stamped" \
  test -n "$(challenger_lifecycle_field .retention.reason)"
journey_assert "challenger lifecycle.retention.actor = mark_task_aborted_for_cleanup" \
  test "$(challenger_lifecycle_field .retention.actor)" = "mark_task_aborted_for_cleanup"
journey_assert "the task-record write guard logged no schema violations" \
  bash -c '[[ ! -f "$1/state-schema-violations.jsonl" ]] || [[ ! -s "$1/state-schema-violations.jsonl" ]]' _ "$STATE_DIR"
journey_assert "the primary's own row is untouched by the sibling's quarantine" \
  test "$(field "$ISSUE" status)" != "aborted"
journey_assert_no_unhandled_fake_calls

journey_finish
