#!/usr/bin/env bash
# HOK-3465 / HOK-3447 replay: real planning synthesizes at its boundary before normal approval and merge.
set -euo pipefail
source "$(dirname "$0")/harness.sh"
reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP native-planning-synthesis journey: $reason"
  exit 0
fi
ISSUE="JRN-65"
export FAKE_AGENT_SCRIPT_DIR
FAKE_AGENT_SCRIPT_DIR="$(cd "$(dirname "$0")/fixtures/native-planning-synthesis/fake-agent" && pwd)"
journey_init native-planning-synthesis
journey_write_config '{"nativeAgent":{"planning":{"maxTurns":3,"maxToolCalls":120}}}'
fakes_linear_add_issue "$ISSUE" "Add journey output file" Todo
journey_start_monitor
journey_set_tick_budget 80
journey_wait_until "$ISSUE" 5 "backlog offers task" journey_backlog_offers "$ISSUE"
journey_command "select 1"
phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
journey_wait_until "$ISSUE" 5 "planning launched" phase_is planning
journey_wait_until "$ISSUE" 12 "plan approved and coding launched" phase_is coding
fd="$(journey_feature_dir "$ISSUE")"
journey_assert "native planning validated its synthesized artifact" \
  journey_jq_true '.planningResult.status == "awaiting_user" and .planningResult.artifacts.planArtifactValid == true and .planningResult.artifacts.usage.turnsCompleted == 3 and .planningResult.artifacts.usage.toolCallsExecuted == 2' "$fd/.synthesis-assertions.json"
journey_assert "provider saw no tools and retained gathered evidence" \
  journey_jq_true '.turns == 3 and .terminalTools == 0 and .retainedEvidence == true' "$fd/.synthesis-assertions.json"
journey_assert "one native planning launch" \
  test "$(jq -s '[.[] | select(.harness == "native" and .stage == "planning")] | length' "$fd/.session-ownership.jsonl")" = 1
journey_wait_until "$ISSUE" 12 "review launched" phase_is review
journey_wait_until "$ISSUE" 25 "PR merged by tend" journey_pr_merged
journey_wait_until "$ISSUE" 8 "task reaped" journey_task_reaped "$ISSUE"
journey_assert "no recovery intervention" test "$JOURNEY_SAW_ATTENTION" = 0
journey_assert_landed "$ISSUE"
journey_finish
