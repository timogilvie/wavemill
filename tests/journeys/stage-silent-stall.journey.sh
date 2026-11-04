#!/usr/bin/env bash
# Golden journey (HOK-3386): a review agent exits silently (no transcript, no
# .review-result.json verdict, no PR). Before HOK-3386 the mill sat forever
# without noticing — that is the 2026-11-02 incident this journey protects.
#
# Protects against: every stage-agent liveness decision being private. The
# shared `stage_agent_disposition` (planning, coding, review, Ready
# remediation, conflict resolution) must notice a settled-without-result and
# route the stage through the HOK-3176 failure policy → the HOK-2924
# `stage-failure-<stage>` bucket → a fresh relaunch. The relaunched agent
# finishes the review normally and the task merges with zero operator touch.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP stage-silent-stall journey: $reason"
  exit 0
fi

ISSUE="JRN-8"
# Before journey_init: the tmux server (and so every agent pane) inherits
# this environment.
export FAKE_AGENT_SCRIPT_DIR
FAKE_AGENT_SCRIPT_DIR="$(cd "$(dirname "$0")/fixtures/stage-silent-stall/fake-agent" && pwd)"
# Shrink the owner grace so the stage-failure-review bucket charges inside
# the journey's tick budget (default 300s is wall-clock).
export WAVEMILL_CODING_OWNER_GRACE_SECONDS=1
journey_init stage-silent-stall
fakes_linear_add_issue "$ISSUE" "Change whose first review agent stalls silently" Todo

journey_start_monitor
journey_wait_until "$ISSUE" 5  "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
review_launches() { journey_agent_launch_count "$ISSUE" review; }
relaunched() { [[ "$(review_launches)" -ge 2 ]]; }
agent_log_count() { grep -c "$1" "$FAKE_AGENT_LOG" 2>/dev/null || true; }

journey_wait_until "$ISSUE" 5  "task launched into planning"                      phase_is planning
journey_wait_until "$ISSUE" 8  "coding launched"                                  phase_is coding
journey_wait_until "$ISSUE" 10 "first review launched (silent-stall fault)"       phase_is review
journey_wait_until "$ISSUE" 20 "stage-failure-review relaunched the reviewer"     relaunched
journey_wait_until "$ISSUE" 20 "PR merged by tend after the relaunched reviewer"  journey_pr_merged
journey_wait_until "$ISSUE" 8  "task reaped after merge"                          journey_task_reaped "$ISSUE"

echo ""
echo "assertions:"
journey_assert "exactly two review launches (first stalled silently, relaunch succeeded)" \
  test "$(review_launches)" = "2"
journey_assert "the first reviewer really stalled silently (no verdict, no PR)" \
  test "$(agent_log_count "fault=silent-stall-no-verdict")" = "1"
journey_assert "the relaunched reviewer ran as a stage-failure-review relaunch" \
  test "$(agent_log_count "role=stage-failure-review-relaunch")" = "1"
journey_assert_landed "$ISSUE"

journey_finish
