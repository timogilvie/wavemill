#!/usr/bin/env bash
# protects: native mutation -> exited blocked completion -> fresh process -> commit -> merge, zero recovery touches.
set -euo pipefail
source "$(dirname "$0")/harness.sh"
reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then echo "SKIP native-ownership-recovery: $reason"; exit 0; fi
ISSUE="JRN-4"
export FAKE_AGENT_SCRIPT_DIR="$JOURNEY_INSTALL_DIR/tests/journeys/fixtures/native-ownership/fake-agent"
export WAVEMILL_CODING_DIRTY_HANDOFF_GRACE_SECONDS=0
journey_init native-ownership-recovery
fakes_linear_add_issue "$ISSUE" "Recover native ownership" Todo
journey_start_monitor
journey_wait_until "$ISSUE" 5 "task offered" journey_backlog_offers "$ISSUE"
journey_command 'select 1'
recovered() { [[ "$(journey_agent_launch_count "$ISSUE" coding)" -ge 2 ]]; }
journey_wait_until "$ISSUE" 25 "blocked coder relaunched" recovered
journey_wait_until "$ISSUE" 25 "PR merged" journey_pr_merged
journey_wait_until "$ISSUE" 8 "task reaped" journey_task_reaped "$ISSUE"
journey_assert "exactly one bounded recovery" test "$(journey_agent_launch_count "$ISSUE" coding)" = 2
journey_assert "the native mutation landed" bash -c 'git --git-dir "$1" show "refs/heads/$2:journey-output.txt" | grep -q "preserved native mutation"' _ "$FAKE_GH_ORIGIN" "$JOURNEY_INTEGRATION_BRANCH"
journey_assert_landed "$ISSUE"
journey_finish
