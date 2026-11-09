#!/usr/bin/env bash
# Golden journey (HOK-3448): a review delivered through the Claude CLI's
# ReportFindings tool is accepted as one completed review, with the same
# findings and direct execution identity, from exactly one CLI invocation.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP review-tool-report journey: $reason"
  exit 0
fi

ISSUE="JRN-RTR-1"
export FAKE_AGENT_SCRIPT_DIR
FAKE_AGENT_SCRIPT_DIR="$(cd "$(dirname "$0")/fixtures/review-tool-report/fake-agent" && pwd)"
journey_init review-tool-report
fakes_linear_add_issue "$ISSUE" "Add journey output file" Todo

journey_start_monitor
journey_set_tick_budget 60
journey_wait_until "$ISSUE" 5  "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }

journey_wait_until "$ISSUE" 5  "task launched into planning" phase_is planning
journey_wait_until "$ISSUE" 8  "coding launched"             phase_is coding
journey_wait_until "$ISSUE" 8  "review launched"             phase_is review
journey_wait_until "$ISSUE" 30 "PR merged by tend"           journey_pr_merged

fd="$(journey_feature_dir "$ISSUE")"
journey_assert "review stage result is completed" \
  test "$(jq -r '.status' "$fd/.review-result.json" 2>/dev/null)" = "completed"
journey_assert ".review-tool-report-result.json verdict is ready" \
  test "$(jq -r '.verdict' "$fd/.review-tool-report-result.json" 2>/dev/null)" = "ready"
journey_assert ".review-tool-report-result.json has 3 warnings" \
  test "$(jq -r '[.codeReviewFindings[] | select(.severity == "warning")] | length' "$fd/.review-tool-report-result.json" 2>/dev/null)" = "3"
journey_assert ".review-tool-report-result.json has 0 blockers" \
  test "$(jq -r '[.codeReviewFindings[] | select(.severity == "blocker")] | length' "$fd/.review-tool-report-result.json" 2>/dev/null)" = "0"

journey_wait_until "$ISSUE" 8  "task reaped after merge"     journey_task_reaped "$ISSUE"

journey_assert_landed "$ISSUE"
journey_assert_session_ownership "$ISSUE" planning coding review helper:json-code-review

# The fake's judge-call log should contain exactly one tool-report served line.
# (Any ordering/touch-set predictions use the global verdict file and are not
# counted as review CLI calls.)
call_count="$(grep -c "judge tool-report served" "$FAKE_ROOT/logs/agent.log" 2>/dev/null || true)"
journey_assert "exactly one review CLI invocation used the tool report" test "$call_count" = "1"

echo ""