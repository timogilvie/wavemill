#!/usr/bin/env bash
# Golden journey: a high-risk PR passes through a reconciler null decision and
# still merges with zero operator touches (HOK-3449).
#
# Protects against: the label-ledger defect. On a null decision (not stable)
# the reconciler used to call clearWavemillState, which removed every label in
# ALL_WM_LABELS — `wavemill`, the operator's `wm:risk-acknowledged` /
# `wm:approved`, and lane labels — not just `wm:ready` / `wm:blocked`
# (PR #1666: `wm:blocked` added 13:52:59, `wavemill` removed 13:53:18). The
# operator then had to re-acknowledge the high-risk PR.
#
# Here the operator's standing permission is seeded once when the PR appears
# (not a touch during the run). CI fails for one tend poll (→ wm:blocked),
# then reads as pending with the merge state CLEAN (→ a null `checks-pending`
# decision while wm:blocked is held), then goes green. Only wm:blocked may be
# removed; the operator labels and `wavemill` must survive to the merge.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP reconciler-null-decision journey: $reason"
  exit 0
fi

ISSUE="JRN-6"
journey_init reconciler-null-decision
fakes_linear_add_issue "$ISSUE" "High-risk change that passes through a null merge-label decision" Todo

journey_start_monitor
journey_set_tick_budget 90
journey_wait_until "$ISSUE" 5 "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }

pr_exists() { jq -e '.prs["1"]' "$FAKE_GH_STATE" >/dev/null 2>&1; }
pr_has_label() { jq -e --arg l "$1" '.prs["1"].labels // [] | index($l)' "$FAKE_GH_STATE" >/dev/null 2>&1; }
label_history() { jq -r --arg e "unlabeled" --arg l "$1" '[.prs["1"].history // [] | .[] | select(.event == $e and .label == $l)] | length' "$FAKE_GH_STATE"; }

# The operator's standing permission exists before Ready evaluates risk. This
# is seeded once, when the PR appears — it is not an intervention during the
# run and the journey never re-adds it.
seed_operator_permission() {
  pr_exists || return 1
  pr_has_label wm:risk-acknowledged && return 0
  fakes_gh_state '.prs["1"].labels = (((.prs["1"].labels // []) + ["wavemill", "Risk: High", "wm:risk-acknowledged", "wm:approved"]) | unique)'
  journey_log "seeded operator permission: wavemill, Risk: High, wm:risk-acknowledged, wm:approved"
  return 0
}

# First tend poll: CI failing → the reconciler renders wm:blocked (no merge).
force_blocked_decision() {
  fakes_gh_state '.checks.byPr["1"] = [{name: "ci", conclusion: "FAILURE"}]'
  journey_log "fault: ci failing for the first tend poll (expect wm:blocked)"
}
JOURNEY_BEFORE_FIRST_TEND=force_blocked_decision

# While wm:blocked is held, stage a checks-pending read with mergeStateStatus
# CLEAN: Ready's verdict is ready at this head, so deriveMergeLabel returns
# null `checks-pending` instead of wm:blocked.
stage_null_decision() {
  pr_has_label wm:blocked || return 1
  fakes_gh_state '.checks.byPr["1"] = [{name: "ci", conclusion: "IN_PROGRESS"}] | .prs["1"].overrides.mergeStateStatus = "CLEAN"'
  journey_log "staged null decision: checks pending, merge state CLEAN"
  return 0
}

# The null tick is the one that removes the held wm:blocked label.
null_decision_cleared_label() { (( $(label_history wm:blocked) >= 1 )); }

restore_green_checks() {
  fakes_gh_state '.checks.byPr["1"] = [{name: "ci", conclusion: "SUCCESS"}] | del(.prs["1"].overrides.mergeStateStatus)'
  journey_log "checks restored green"
  return 0
}

# Budgets are monitor ticks (passes), not seconds.
journey_wait_until "$ISSUE" 5  "task launched into planning" phase_is planning
journey_wait_until "$ISSUE" 12 "review launched"             phase_is review
journey_wait_until "$ISSUE" 12 "operator permission seeded on PR #1" seed_operator_permission
journey_wait_until "$ISSUE" 20 "reconciler rendered wm:blocked for the failing CI" pr_has_label wm:blocked
journey_wait_until "$ISSUE" 8  "null decision staged while wm:blocked is held" stage_null_decision
journey_wait_until "$ISSUE" 12 "reconciler took the null path (removed wm:blocked only)" null_decision_cleared_label
journey_wait_until "$ISSUE" 8  "checks restored green" restore_green_checks
journey_wait_until "$ISSUE" 20 "PR merged by tend after the null decision" journey_pr_merged
journey_wait_until "$ISSUE" 8  "task reaped after merge" journey_task_reaped "$ISSUE"

echo ""
echo "assertions:"
journey_assert_landed "$ISSUE"
journey_assert "the null decision removed wm:blocked" test "$(label_history wm:blocked)" = "1"
journey_assert "wavemill was never removed" test "$(label_history wavemill)" = "0"
journey_assert "the operator's wm:risk-acknowledged was never removed" test "$(label_history wm:risk-acknowledged)" = "0"
journey_assert "wm:approved was never removed" test "$(label_history wm:approved)" = "0"
journey_assert "the operator labels are still present at merge" \
  bash -c 'for l in wavemill wm:risk-acknowledged wm:approved; do jq -e --arg l "$l" ".prs[\"1\"].labels | index(\$l)" "$1" >/dev/null || exit 1; done' _ "$FAKE_GH_STATE"
journey_assert "the null decision took the checks-pending path while wm:blocked was held" \
  grep -q 'Clearing merge label (not stable).*checks-pending' "$JOURNEY_TMP/logs/tend.log"
journey_assert "the Ready phase completed ok after the null decision (no risk-acknowledgement pending)" \
  bash -c 'jq -e "select(.phase == \"ready\") | .event == \"phase_completed\" and .status == \"ok\"" "$1" >/dev/null' _ \
    "$REPO_DIR/.wavemill/evals/artifacts/$ISSUE/trace.jsonl"

journey_finish
