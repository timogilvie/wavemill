#!/usr/bin/env bash
# HOK-3491: committing partial output never refills a failed coder's allowance.
set -euo pipefail
source "$(dirname "$0")/harness.sh"
reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then echo "SKIP coding-retry-input-budget journey: $reason"; exit 0; fi
ISSUE=JRN-1
export FAKE_AGENT_SCRIPT_DIR="$(cd "$(dirname "$0")/fixtures/hok-3491/fake-agent" && pwd)"
export WAVEMILL_CODING_OWNER_GRACE_SECONDS=0
export WAVEMILL_STAGE_FAILURE_MAX_ATTEMPTS=3
journey_init coding-retry-input-budget
JOURNEY_EXPECT_ATTENTION=1
journey_set_approval_budget 1
fakes_linear_add_issue "$ISSUE" 'Bound coding retries across partial commits' Todo
journey_start_monitor
journey_set_tick_budget 120
journey_wait_until "$ISSUE" 30 'backlog offers task' journey_backlog_offers "$ISSUE"
journey_command 'select 1'
FEATURE_DIR=''
exhausted() {
  FEATURE_DIR="$(journey_feature_dir "$ISSUE" 2>/dev/null || true)"
  [[ -n "$FEATURE_DIR" ]] || return 1
  jq -e '.detail.escalationBasis == "exhausted:stage-failure-coding"' "$FEATURE_DIR/.needs-attention" >/dev/null 2>&1
}
journey_wait_until "$ISSUE" 65 'three relaunches then visible escalation' exhausted
settled_tick="$(journey_tick)"
observed_again() { (( $(journey_tick) - settled_tick >= 4 )); }
journey_wait_until "$ISSUE" 8 'later reconciliation preserves exhaustion' observed_again
echo 'assertions:'
journey_assert 'one initial coding launch plus exactly three relaunches' \
  test "$(journey_agent_launch_count "$ISSUE" coding)" = 4
journey_assert 'no additional plan approvals during retries' test "$(journey_approval_count)" = 1
journey_assert 'exhaustion remains visible after reconciliation' exhausted
journey_assert 'no review or PR for an unfinished implementation' test -z "$(journey_get_pr_number)"
journey_assert_no_unhandled_fake_calls
journey_finish
