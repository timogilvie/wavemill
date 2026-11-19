#!/usr/bin/env bash
# HOK-3512: refused replay becomes visible; an audited operator repair resumes.
set -euo pipefail
source "$(dirname "$0")/harness.sh"
reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then echo "SKIP recovery-route-refusal journey: $reason"; exit 0; fi
ISSUE=JRN-1
export FAKE_AGENT_SCRIPT_DIR="$(cd "$(dirname "$0")/fixtures/hok-3512/fake-agent" && pwd)"
export WAVEMILL_CODING_OWNER_GRACE_SECONDS=0
journey_init "${REFUSAL_JOURNEY_NAME:-recovery-route-refusal}"
JOURNEY_EXPECT_ATTENTION=1
journey_set_approval_budget 1
fakes_linear_add_issue "$ISSUE" 'Make a refused route visible and repairable' Todo
journey_start_monitor
journey_set_tick_budget 100
journey_wait_until "$ISSUE" 30 'backlog offers task' journey_backlog_offers "$ISSUE"
journey_command 'select 1'
FEATURE_DIR=''
if [[ "${REFUSAL_DROP_WINDOW:-0}" == 1 ]]; then
  route_injected() {
    FEATURE_DIR="$(journey_feature_dir "$ISSUE" 2>/dev/null || true)"
    [[ -n "$FEATURE_DIR" && -f "$FEATURE_DIR/refusal-injected" ]] \
      && jq -e '.status == "failed"' "$FEATURE_DIR/.coding-result.json" >/dev/null 2>&1
  }
  journey_wait_until "$ISSUE" 20 'coder exits with a refused saved route' route_injected
  target="$(term_task_window_target "$SESSION" "$ISSUE" "$(basename "$FEATURE_DIR")" "$STATE_FILE" "$(dirname "$(dirname "$FEATURE_DIR")")")"
  tmux kill-window -t "$target"
fi
refusal_visible() {
  FEATURE_DIR="$(journey_feature_dir "$ISSUE" 2>/dev/null || true)"
  [[ -n "$FEATURE_DIR" ]] || return 1
  jq -e '.detail.escalationBasis == "policy-terminal:terminal" and (.reason | contains("contract_missing"))' \
    "$FEATURE_DIR/.needs-attention" >/dev/null 2>&1
}
journey_wait_until "$ISSUE" 30 'saved route refusal reaches operator attention' refusal_visible
node "$JOURNEY_INSTALL_DIR/tools/recovery-contract.ts" read-and-validate \
  --feature-dir "$FEATURE_DIR" --stage coding --repo "$REPO_DIR" --json > "$JOURNEY_TMP/refused-contract.json"
journey_assert 'the real validator confirms the injected refusal' \
  jq -e '.ok == false and .reason == "contract_missing"' "$JOURNEY_TMP/refused-contract.json"
if [[ "${REFUSAL_DROP_WINDOW:-0}" == 1 ]]; then
  journey_assert 'the monitor observed the missing window' \
    grep -q 'tmux window missing after resume' "$JOURNEY_TMP/logs/status.log"
fi
refused_tick="$(journey_tick)"
refusal_marker="$(cat "$FEATURE_DIR/.needs-attention")"
polled_again() { (( $(journey_tick) - refused_tick >= 3 )); }
journey_wait_until "$ISSUE" 8 'polling neither repairs nor relaunches the refused route' polled_again
journey_assert 'refusal survives polling' refusal_visible
journey_assert 'acknowledged escalation is not rewritten after worker exit' \
  test "$(cat "$FEATURE_DIR/.needs-attention")" = "$refusal_marker"
journey_assert 'no coding relaunch before operator intervention' test "$(journey_agent_launch_count "$ISSUE" coding)" = 1
journey_assert 'no private stopped state' test "$(journey_task_field "$ISSUE" status)" != stopped
# A deliberate test-operator intervention: the existing audited reroute CLI,
# followed by an explicit release event consumed by the condition reconciler.
original_model="$(jq -er '.model' "$FEATURE_DIR/refusal-original-coding.json")"
node "$JOURNEY_INSTALL_DIR/tools/reroute-task.ts" "$ISSUE" --phase coding --model "$original_model" \
  --feature-dir "$FEATURE_DIR" --repo "$REPO_DIR" > "$JOURNEY_TMP/reroute.json"
source "$JOURNEY_INSTALL_DIR/shared/lib/transient-marker.sh"
operator_event_record "$FEATURE_DIR" reroute "$ISSUE" 'operator restored the original model and released recovery'
recovered() { [[ "$(journey_agent_launch_count "$ISSUE" coding)" -eq 2 ]]; }
journey_wait_until "$ISSUE" 15 'operator repair resumes the same coding task' recovered
journey_assert 'reroute audit restores the original model' \
  jq -e --arg model "$original_model" '.changed and .after.model == $model' "$JOURNEY_TMP/reroute.json"
journey_assert 'canonical retry claimed after refusal' \
  jq -s -e 'any(.[]; .action == "retry-stage" and .stage == "coding")' "$FEATURE_DIR/.recovery-actions.jsonl"
pr_merged() { [[ "$(fakes_gh_pr_field 1 state)" == MERGED ]]; }
journey_wait_until "$ISSUE" 25 'repaired task completes through review and merge' pr_merged
journey_assert 'exactly two coding launches' test "$(journey_agent_launch_count "$ISSUE" coding)" = 2
journey_assert 'one plan approval throughout recovery' test "$(journey_approval_count)" = 1
journey_assert_no_unhandled_fake_calls
journey_finish
