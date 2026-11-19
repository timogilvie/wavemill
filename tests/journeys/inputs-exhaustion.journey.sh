#!/usr/bin/env bash
# Golden journey: a raw issue whose expansion recovery exhausts produces
# exactly one .needs-attention inbox item and no .task-inputs-failure.json
# marker. The operator places a task-packet.md directly, the item expires,
# and the plan is offered for approval (HOK-3505, replaying HOK-3409).
#
# Oracles:
#   - .needs-attention appeared (JOURNEY_EXPECT_ATTENTION=1)
#   - no .task-inputs-failure.json at any point
#   - operator approval requested exactly once after recovery
#   - coding launches against the recovered packet
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP inputs-exhaustion journey: $reason"
  exit 0
fi

FIXTURE_DIR="$(cd "$(dirname "$0")/fixtures/inputs-exhaustion" && pwd)"
ISSUE="$(jq -r '.identifier' "$FIXTURE_DIR/issue.json")"
export FAKE_AGENT_SCRIPT_DIR="$FIXTURE_DIR/fake-agent"

# Exhaust after 1 attempt (fast), expansion timeout 1s (tool dies quickly).
export WAVEMILL_ASYNC_CHECK_JOB_RETRY_LIMIT=1

journey_init inputs-exhaustion
JOURNEY_EXPECT_ATTENTION=1
journey_set_approval_budget 1
journey_write_config '{"mill":{"expansionHandshake":{"timeoutSeconds":1}}}'
fakes_linear_add_issue_from_file "$FIXTURE_DIR/issue.json"

journey_start_monitor
journey_set_tick_budget 80
journey_wait_until "$ISSUE" 5  "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }

journey_wait_until "$ISSUE" 5  "task launched into planning" phase_is planning

# Wait for the expansion recovery to exhaust and escalate. The feature dir
# lives in the task worktree, not the repo checkout.
has_attention() {
  local fd
  fd="$(journey_feature_dir "$ISSUE")" || return 1
  [[ -f "$fd/.needs-attention" ]] \
    && [[ "$(jq -r '.detail.escalationBasis // empty' "$fd/.needs-attention" 2>/dev/null)" == "exhausted:expansion-recovery-job" ]]
}
journey_wait_until "$ISSUE" 25 "exhausted:expansion-recovery-job escalation appeared" has_attention

feature_dir="$(journey_feature_dir "$ISSUE")"
# Assert: no private marker was written.
no_private_marker() { [[ ! -e "$feature_dir/.task-inputs-failure.json" ]]; }
journey_assert "no .task-inputs-failure.json at any point" no_private_marker

# Simulate operator recovery: place a valid task-packet.md.
cat > "$feature_dir/task-packet.md" <<'PACKET'
## 1. Objective

Expanded by the operator (simulated recovery).

## 2. Success Criteria

- journey-output.txt exists.

## 3. Scope

### Files to Modify
- journey-output.txt
PACKET

# Wait for the plan to be offered and approved, then coding launches.
journey_wait_until "$ISSUE" 15 "coding launched" phase_is coding
journey_wait_until "$ISSUE" 8  "review launched"  phase_is review
journey_wait_until "$ISSUE" 15 "PR merged"        journey_pr_merged
journey_wait_until "$ISSUE" 8  "task reaped"      journey_task_reaped "$ISSUE"

echo ""
echo "assertions:"
journey_assert_landed "$ISSUE"
journey_assert "escalation was raised" test "$JOURNEY_SAW_ATTENTION" = "1"

journey_finish
