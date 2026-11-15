#!/usr/bin/env bash
# Golden journey: a session with no tend merge consumer, then tend arrives.
#
# Protects against: the HOK-3453 class — `queueState: merge-needed` living
# outside the declared vocabulary, so a reader treats it as "not in the lane".
# With no tend (HOK-3102), a passing Ready must park the PR at merge-needed:
# no handoff published, no merge, no Ready re-run. Once tend is enabled, the
# monitor must re-run Ready, publish the handoff, and tend must merge.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP merge-needed-until-tend journey: $reason"
  exit 0
fi

ISSUE="JRN-3453"
# Derive capabilities from the repo config through the real resolver, so the
# config edit below is what turns tend on.
# shellcheck disable=SC2034  # read by journey_init (harness.sh)
JOURNEY_DERIVE_CAPABILITIES=1
journey_init merge-needed-until-tend
# integration on, but this session runs no tend → mergeExecutor=none.
journey_write_config '{"integration":{"useMillSession":false},"mergeQueue":{"enabled":false}}'
fakes_linear_add_issue "$ISSUE" "Change merged once tend arrives" Todo

journey_start_monitor
journey_set_tick_budget 30
journey_wait_until "$ISSUE" 5  "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
ready_result() { local fd; fd="$(journey_feature_dir "$ISSUE")" && cat "$fd/.ready-result.json" 2>/dev/null; }
ready_parked_merge_needed() {
  ready_result | jq -e '.status == "completed" and .artifacts.queueState == "merge-needed"' >/dev/null 2>&1
}
ready_left_merge_needed() {
  ready_result | jq -e '.artifacts.queueState != "merge-needed"' >/dev/null 2>&1
}
handoff_state() { local fd; fd="$(journey_feature_dir "$ISSUE")" && jq -r '.state // empty' "$fd/.ready-tend-handoff.json" 2>/dev/null || true; }
no_tend_handoff_yet() { [[ "$(handoff_state)" != "ready-published" && "$(handoff_state)" != "tend-claimed" ]]; }

journey_wait_until "$ISSUE" 5  "task launched into planning"        phase_is planning
journey_wait_until "$ISSUE" 15 "review launched"                    phase_is review
journey_wait_until "$ISSUE" 15 "Ready parks the PR at merge-needed" ready_parked_merge_needed

parked_finished_at="$(ready_result | jq -r '.finishedAt // empty')"
parked_executor="$(ready_result | jq -r '.artifacts.mergeExecutor // empty')"
# Hold for a few ticks: nothing may advance a merge-needed PR without tend.
hold_until=$(( $(journey_tick) + 4 ))
still_parked_for_hold() { (( $(journey_tick) >= hold_until )); }
journey_wait_until "$ISSUE" 6  "merge-needed holds without tend"    still_parked_for_hold

echo ""
echo "assertions while parked:"
journey_assert "merge-needed recorded the session's merge executor (none)" test "$parked_executor" = "none"
journey_assert "still parked at merge-needed after the hold" ready_parked_merge_needed
journey_assert "the parked pass published no labels" \
  test "$(ready_result | jq -r '.artifacts.readyLabelsUpdated')" = "false"
journey_assert "Ready did not re-run while parked" test -n "$parked_finished_at" -a "$(ready_result | jq -r '.finishedAt // empty')" = "$parked_finished_at"
journey_assert "no tend handoff was published while parked" no_tend_handoff_yet
journey_assert "tend never ran while parked" test "$JOURNEY_TEND_TICKS" = "0"
journey_assert "PR #1 is still open while parked" test "$(fakes_gh_pr_field 1 state)" = "OPEN"

# The operator enables tend for this session (gitignored local overlay).
jq -n '{integration: {useMillSession: true}}' > "$REPO_DIR/.wavemill-config.local.json"
journey_log "operator enabled tend (integration.useMillSession=true)"

journey_wait_until "$ISSUE" 8  "monitor re-runs Ready once tend exists" ready_left_merge_needed
journey_wait_until "$ISSUE" 15 "PR merged by tend"                  journey_pr_merged
journey_wait_until "$ISSUE" 8  "task reaped after merge"            journey_task_reaped "$ISSUE"

echo ""
echo "assertions:"
journey_assert "monitor logged the merge-needed → tend transition" \
  grep -q "$ISSUE → merge executor is now tend; re-running ready" "$JOURNEY_TMP/logs/status.log"
# The parked pass recorded readyLabelsUpdated=false + mergeExecutor; only a
# fresh pass under tend publishes labels and drops the merge-needed fields.
journey_assert "Ready re-ran under tend (labels published, merge-needed fields gone)" \
  journey_jq_true '.status == "completed" and .artifacts.readyLabelsUpdated == true
    and (.artifacts.queueState // "") != "merge-needed" and (.artifacts | has("mergeExecutor") | not)' \
  "$REPO_DIR/.wavemill/evals/artifacts/$ISSUE/.ready-result.json"
journey_assert "tend merged the PR (at least one tend tick)" test "$JOURNEY_TEND_TICKS" -ge 1
journey_assert_landed "$ISSUE"

journey_finish
