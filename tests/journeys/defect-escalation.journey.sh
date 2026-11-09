#!/usr/bin/env bash
# protects: confirmed defects bypassing investigation, untracked workers,
# revision mismatch, duplicate filings after restart, and a draft filed live.
set -euo pipefail
source "$(dirname "$0")/harness.sh"
reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then echo "SKIP defect-escalation journey: $reason"; exit 0; fi
ISSUE=JRN-25
export FAKE_AGENT_SCRIPT_DIR="$JOURNEY_HARNESS_DIR/fixtures/happy-path/fake-agent"
journey_init defect-escalation
export PATH="$JOURNEY_HARNESS_DIR/fixtures/defect-escalation/bin:$PATH"
export FAKE_INVESTIGATION_PAYLOAD_DIR="$JOURNEY_TMP/investigation-payloads"
export WAVEMILL_HEADLESS_MODEL=claude-sonnet-5
export WAVEMILL_SESSION_CAPABILITIES_JSON='{"tend":true,"observer":true,"mergeExecutor":"tend","mergeQueue":false}'
journey_write_config '{"observer":{"enabled":true,"linear":{"enabled":true,"mode":"live","team":"JRN"}}}'
# Export into the monitor launch environment too; no production routing changes.
journey_write_monitor_env
fakes_linear_add_issue "$ISSUE" "Exercise the defect escalation pipeline" Todo
# Existing owners are already underway and must not appear in the picker.
fakes_linear_add_issue JRN-3312 "Cleanup owner" "In Progress"
fakes_linear_add_issue JRN-3315 "Install health owner" "In Progress"
driver() { (cd "$JOURNEY_INSTALL_DIR" && node --import tsx tests/journeys/fixtures/defect-escalation/driver.ts "$1" "$REPO_DIR"); }
driver seed
journey_start_monitor
journey_set_tick_budget 120
journey_wait_until "$ISSUE" 5 "backlog offers task" journey_backlog_offers "$ISSUE"
journey_command 'select 1'
phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
journey_wait_until "$ISSUE" 8 "planning" phase_is planning
journey_wait_until "$ISSUE" 12 "coding" phase_is coding
journey_wait_until "$ISSUE" 12 "review" phase_is review
journey_wait_until "$ISSUE" 25 "task merged" journey_pr_merged
journey_wait_until "$ISSUE" 10 "task reaped" journey_task_reaped "$ISSUE"
all_investigated() { [[ "$(find "$REPO_DIR/.wavemill/incidents" -name 'investigation-*.json' | wc -l | tr -d ' ')" == 4 ]]; }
journey_wait_until "$ISSUE" 20 "tracked investigations completed" all_investigated
# New consumer processes model restart: persisted artifacts and sync metadata
# must be sufficient for idempotence, with no in-memory investigation cache.
driver sync
driver sync
driver assert
journey_assert_landed "$ISSUE"
journey_assert "four helper calls, no reinvestigation" test "$(wc -l < "$FAKE_INVESTIGATION_PAYLOAD_DIR/calls.log" | tr -d ' ')" = 4
journey_finish
