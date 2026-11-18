#!/usr/bin/env bash
# Golden journey: a native coder receives named-key feedback for a malformed
# apply_patch envelope, then recovers with a valid patch and lands with zero
# operator touches (HOK-3500).
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP native-patch-invalid-envelope journey: $reason"
  exit 0
fi

ISSUE="JRN-1"
export FAKE_AGENT_SCRIPT_DIR
FAKE_AGENT_SCRIPT_DIR="$(cd "$(dirname "$0")/fixtures/native-patch-invalid-envelope/fake-agent" && pwd)"
journey_init native-patch-invalid-envelope
fakes_linear_add_issue "$ISSUE" "Add journey output file" Todo

journey_start_monitor
journey_set_tick_budget 60

journey_wait_until "$ISSUE" 5  "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }

journey_wait_until "$ISSUE" 5  "task launched into planning" phase_is planning
journey_wait_until "$ISSUE" 8  "coding launched"             phase_is coding

FEATURE_DIR="$(journey_feature_dir "$ISSUE")"
journey_wait_until "$ISSUE" 5  "invalid envelope feedback named the corrupted keys" test -f "$FEATURE_DIR/.named-key-feedback-seen"

journey_wait_until "$ISSUE" 8  "review launched"             phase_is review
journey_wait_until "$ISSUE" 15 "PR merged by tend"           journey_pr_merged
journey_wait_until "$ISSUE" 8  "task reaped after merge"     journey_task_reaped "$ISSUE"

echo ""
echo "assertions:"
journey_assert "the valid patch changed journey-output.txt" \
  test "$(git --git-dir "$FAKE_GH_ORIGIN" cat-file -p "refs/heads/$JOURNEY_INTEGRATION_BRANCH:journey-output.txt" 2>/dev/null)" = "after"
journey_assert_landed "$ISSUE"

journey_finish
