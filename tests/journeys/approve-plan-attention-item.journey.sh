#!/usr/bin/env bash
# Golden journey: a plan awaiting approval is one `approve-plan` item in the
# attention projection AND the dashboard inbox; approving it removes the item
# on the next projection with no clear call (HOK-3423).
#
# Protects against: the inbox and the attention decision disagreeing (the
# seven private classifiers HOK-3423 replaced), an approval request the
# operator can only find by switching panes, and an item that outlives its
# condition (the HOK-2916 latch shape).
#
# Oracles:
#   - before the operator acts, `.wavemill/attention.json` (written by the
#     monitor's attention-projection tracked job) holds exactly one item,
#     kind approve-plan, for the task, and the real dashboard renderer shows
#     it as the only inbox row with the approval text;
#   - the only operator action is the approval itself (budget 1, one touch of
#     the `.plan-approved` file the item's command names);
#   - a later projection (newer pass stamp) holds no approve-plan item and
#     the dashboard inbox no longer lists the task.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP approve-plan-attention-item journey: $reason"
  exit 0
fi

# Reuse the detailed-issue fixture: inputs are materialised without an LLM,
# so planning reaches awaiting_user on the first planner launch.
FIXTURE_DIR="$(cd "$(dirname "$0")/fixtures/hok-3220" && pwd)"
ISSUE="$(jq -r '.identifier' "$FIXTURE_DIR/issue.json")"
export FAKE_AGENT_SCRIPT_DIR="$FIXTURE_DIR/fake-agent"
journey_init approve-plan-attention-item
journey_set_approval_budget 1
fakes_linear_add_issue_from_file "$FIXTURE_DIR/issue.json"

ATTENTION_FILE="$STATE_DIR/attention.json"
OBSERVED_FILE="$JOURNEY_TMP/attention-at-request.json"
DASHBOARD_AT_REQUEST="$JOURNEY_TMP/dashboard-at-request.txt"
DASHBOARD_AFTER="$JOURNEY_TMP/dashboard-after-approval.txt"

# The real dashboard renderer, one frame, ANSI stripped.
journey_render_dashboard() {
  (
    set -- "$SESSION" "$WORKTREE_ROOT" "$STATE_FILE"
    source "$JOURNEY_INSTALL_DIR/shared/lib/wavemill-status.sh" >/dev/null 2>&1
    render_dashboard >/dev/null 2>&1
    perl -pe 's/\e\[[0-9;?]*[A-Za-z]//g' < "$FRAME"
  ) 2>/dev/null || true
}

approve_plan_items() {
  jq -c --arg id "$ISSUE" '[.items[] | select(.kind == "approve-plan" and .taskId == $id)]' "$ATTENTION_FILE" 2>/dev/null || echo '[]'
}

# JOURNEY_BEFORE_APPROVAL: hold the approval until the projection and the
# dashboard both show the request; record what they showed.
observe_approval_request() {
  local fd="$1"
  [[ -f "$OBSERVED_FILE" ]] && return 0
  jq -e --arg id "$ISSUE" '(.items | length) == 1 and .items[0].kind == "approve-plan" and .items[0].taskId == $id' \
    "$ATTENTION_FILE" >/dev/null 2>&1 || return 1
  journey_render_dashboard > "$DASHBOARD_AT_REQUEST"
  grep -q "📥 INBOX (1)" "$DASHBOARD_AT_REQUEST" || return 1
  cp "$ATTENTION_FILE" "$OBSERVED_FILE"
  journey_log "attention projection shows the approval request (tick $(journey_tick)); approving via $(jq -r '.items[0].commands[0].argv | join(" ")' "$OBSERVED_FILE")"
  [[ "$(jq -r '.items[0].commands[0].argv[-1]' "$OBSERVED_FILE")" == "$fd/.plan-approved" ]] \
    || journey_fail "approve-plan command does not name $fd/.plan-approved"
  return 0
}
JOURNEY_BEFORE_APPROVAL=observe_approval_request

journey_start_monitor
# Sum of the bounded waits below (5 + 5 + 12 + 10 + 10).
journey_set_tick_budget 42
journey_wait_until "$ISSUE" 5  "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }

item_gone_after_approval() {
  [[ -f "$OBSERVED_FILE" && -f "$ATTENTION_FILE" ]] || return 1
  local before after
  before="$(jq -r '.passStampMs' "$OBSERVED_FILE")"
  after="$(jq -r '.passStampMs // 0' "$ATTENTION_FILE" 2>/dev/null || echo 0)"
  (( after > before )) && [[ "$(approve_plan_items)" == "[]" ]] && [[ -f "$(journey_feature_dir "$ISSUE")/.plan-approved" || "$(journey_task_field "$ISSUE" phase)" != "planning" ]]
}

journey_wait_until "$ISSUE" 5  "task launched into planning"            phase_is planning
journey_wait_until "$ISSUE" 12 "approval request seen in the projection" test -f "$OBSERVED_FILE"
journey_wait_until "$ISSUE" 10 "approve-plan item gone from a newer projection" item_gone_after_approval
journey_render_dashboard > "$DASHBOARD_AFTER"
journey_wait_until "$ISSUE" 10 "coding launched"                         phase_is coding

echo ""
echo "assertions:"
journey_assert "the projection held exactly one item, approve-plan for $ISSUE" \
  journey_jq_true --arg id "$ISSUE" '(.items | length) == 1 and .items[0].kind == "approve-plan" and .items[0].taskId == $id' "$OBSERVED_FILE"
journey_assert "the item is keyed on the bound packet and carries the approval text" \
  journey_jq_true '.items[0].id | test(":approve-plan:[0-9a-f]{12}$")' "$OBSERVED_FILE"
journey_assert "the dashboard inbox listed the task as its only row" \
  grep -Eq "^$ISSUE +" "$DASHBOARD_AT_REQUEST"
journey_assert "the dashboard row showed the approval request" \
  grep -q "Plan ready — waiting for approval" "$DASHBOARD_AT_REQUEST"
journey_assert "the only operator action was the one approval" test "$(journey_approval_count)" = "1"
journey_assert "a newer projection no longer holds the item" test "$(approve_plan_items)" = "[]"
journey_assert "the dashboard inbox no longer lists the task after approval" \
  bash -c '! grep -q "📥 INBOX (" "$1"' _ "$DASHBOARD_AFTER"
journey_assert "the attention-projection job ran as a tracked job" \
  test -d "$STATE_DIR/async-jobs/attention-projection-$SESSION"

journey_finish
