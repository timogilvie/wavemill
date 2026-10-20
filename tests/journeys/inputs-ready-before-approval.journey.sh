#!/usr/bin/env bash
# Golden journey: an already-detailed issue whose planner writes only plan.md
# reaches coding on ONE plan approval (HOK-3253, replaying HOK-3220).
#
# Protects against: offering a plan for approval before the local task packet
# and expansion handshake exist. HOK-3220's handoff then regenerated the packet
# after approval and the HOK-3099 guard (correctly) voided the approval, so the
# operator approved a byte-identical plan twice. Fixture: fixtures/hok-3220/
# (sanitised incident evidence in incident.json).
#
# Oracles (none of them is "the PR merged"):
#   - the operator is asked for approval exactly once (budget 1: a second
#     request fails the journey instead of being approved);
#   - at that request the packet exists and the binding already names its
#     bytes (inputs ready BEFORE approval), and the binding is unchanged when
#     coding launches;
#   - the agent CLI received one planning and one coding launch, the planner
#     already found the controller-materialised packet, and no plan was
#     preserved as stale;
#   - no LLM expansion call was needed (no unmodelled agent CLI calls).
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP inputs-ready-before-approval journey: $reason"
  exit 0
fi

FIXTURE_DIR="$(cd "$(dirname "$0")/fixtures/hok-3220" && pwd)"
ISSUE="$(jq -r '.identifier' "$FIXTURE_DIR/issue.json")"
# Before journey_init: the tmux server (and so every agent pane) inherits the
# environment at init.
export FAKE_AGENT_SCRIPT_DIR="$FIXTURE_DIR/fake-agent"
journey_init inputs-ready-before-approval
journey_set_approval_budget 1
fakes_linear_add_issue_from_file "$FIXTURE_DIR/issue.json"

journey_start_monitor
journey_wait_until "$ISSUE" 5  "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }

journey_wait_until "$ISSUE" 5  "task launched into planning" phase_is planning
journey_wait_until "$ISSUE" 10 "coding launched"             phase_is coding
journey_wait_until "$ISSUE" 8  "review launched"             phase_is review
journey_wait_until "$ISSUE" 15 "PR merged by tend"           journey_pr_merged
journey_wait_until "$ISSUE" 8  "task reaped after merge"     journey_task_reaped "$ISSUE"

coding_snapshot_jq() { jq -e "$1" <<<"$JOURNEY_CODING_SNAPSHOT" >/dev/null 2>&1; }

echo ""
echo "assertions:"
journey_assert "exactly one plan approval was requested" test "$(journey_approval_count)" = "1"
journey_assert "inputs were ready at the approval request (packet present, binding names its bytes)" \
  journey_episodes_jq '.[0] | .packetHash != "" and .binding.packetHash == .packetHash and .binding.planHash == .planHash'
journey_assert "the binding was recorded by preparation, not by the approval" \
  journey_episodes_jq '.[0].binding.source == "preparation" and (.[0].binding.approvedAt == null)'
journey_assert "the approval request did not ask for re-approval" \
  journey_episodes_jq '.[0].planning.notes == "Plan ready for review"'
journey_assert "coding launched against the packet and plan the operator approved" \
  coding_snapshot_jq "(.binding.packetHash == .packetHash) and (.packetHash == $(jq -s '.[0].packetHash' "$JOURNEY_TMP/approval-episodes.jsonl")) and (.planHash == $(jq -s '.[0].planHash' "$JOURNEY_TMP/approval-episodes.jsonl"))"
journey_assert "the accepted approval was annotated on the binding" \
  coding_snapshot_jq '.binding.source == "preparation" and (.binding.approvedAt | type == "string")'
journey_assert "no plan was preserved as stale (no re-plan)" coding_snapshot_jq '.stalePlans == 0'
journey_assert "the agent CLI got exactly one planning launch" test "$(journey_agent_launch_count "$ISSUE" planning)" = "1"
journey_assert "the agent CLI got exactly one coding launch" test "$(journey_agent_launch_count "$ISSUE" coding)" = "1"
journey_assert "the planner found the controller-materialised local packet" \
  grep -q "phase=planning issue=$ISSUE local-packet=present" "$FAKE_AGENT_LOG"
journey_assert_landed "$ISSUE"

journey_finish
