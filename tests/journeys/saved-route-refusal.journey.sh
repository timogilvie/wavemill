#!/usr/bin/env bash
# Golden journey: a failed coding attempt whose saved route is no longer
# launchable raises one claimed attention outcome. Losing the window reuses
# that outcome instead of writing a private stop or retrying in a loop.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP saved-route-refusal journey: $reason"
  exit 0
fi

ISSUE="JRN-3512"
export FAKE_AGENT_SCRIPT_DIR="$(cd "$(dirname "$0")/fixtures/saved-route-refusal/fake-agent" && pwd)"
journey_init saved-route-refusal
fakes_linear_add_issue "$ISSUE" "Recover a refused saved route" Todo
journey_start_monitor
journey_set_tick_budget 24

journey_wait_until "$ISSUE" 5 "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"
phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
route_refusal_escalated() {
  local fd
  fd="$(journey_feature_dir "$ISSUE" 2>/dev/null)" || return 1
  [[ -f "$fd/.needs-attention" ]] \
    && jq -e '.claim.action == "escalate" and .claim.stage == "coding"' \
      "$fd/.recovery-claim.json" >/dev/null 2>&1
}

journey_wait_until "$ISSUE" 5 "task launched into planning" phase_is planning
journey_wait_until "$ISSUE" 8 "coding launch refused and escalated" route_refusal_escalated
FEATURE_DIR="$(journey_feature_dir "$ISSUE")"
CLAIM_ID="$(jq -r '.claim.claimId' "$FEATURE_DIR/.recovery-claim.json")"
journey_assert "validator reason and saved model reach attention evidence" \
  jq -e '.reason | contains("model_disabled") and contains("gpt-5.3-codex")' "$FEATURE_DIR/.needs-attention"
journey_assert "the failed coding launch happened once before refusal" \
  test "$(journey_agent_launch_count "$ISSUE" coding)" = "1"

# Exercise the resume/window-lost entry against the same saved route refusal.
window_id="$(journey_task_field "$ISSUE" windowId)"
[[ -n "$window_id" ]] && tmux kill-window -t "$SESSION:$window_id" 2>/dev/null || true
START_TICK="$(journey_tick)"
same_refusal_claim() {
  [[ "$(journey_tick)" -gt "$START_TICK" ]] \
    && [[ "$(jq -r '.claim.claimId // empty' "$FEATURE_DIR/.recovery-claim.json" 2>/dev/null)" == "$CLAIM_ID" ]] \
    && [[ -f "$FEATURE_DIR/.needs-attention" ]]
}
journey_wait_until "$ISSUE" 4 "window-lost refusal retains the same attention claim" same_refusal_claim
journey_assert "window-lost recovery did not dispatch another coding launch" \
  test "$(journey_agent_launch_count "$ISSUE" coding)" = "1"

# The operator repairs the route through the contract writer and records the
# normal operator event, which expires this condition-keyed attention marker.
npx tsx "$JOURNEY_INSTALL_DIR/tools/recovery-contract.ts" write \
  --feature-dir "$FEATURE_DIR" --repo "$REPO_DIR" --coder "claude-opus-4-7" \
  --skip-stages "plan,review" --override-source operator --reason "saved-route-reroute" --json >/dev/null
source "$JOURNEY_INSTALL_DIR/shared/lib/transient-marker.sh"
operator_event_record "$FEATURE_DIR" reroute "$ISSUE" "replaced disabled saved coding route"
attention_expired() { [[ ! -f "$FEATURE_DIR/.needs-attention" ]]; }
journey_wait_until "$ISSUE" 5 "operator reroute expires refusal attention" attention_expired

coding_retried() { (( $(journey_agent_launch_count "$ISSUE" coding) >= 3 )); }
journey_wait_until "$ISSUE" 12 "coding relaunches through bounded retry" coding_retried
retry_count_file="$FEATURE_DIR/.retry-stage-failure-coding-count"
journey_assert "the post-reroute coding failure consumed one bounded retry" \
  test "$(cat "$retry_count_file" 2>/dev/null || echo 0)" = "1"
journey_assert "the attention marker cleared after the operator event" test ! -f "$FEATURE_DIR/.needs-attention"
journey_finish
