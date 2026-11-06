#!/usr/bin/env bash
# Golden journey (HOK-3360): a one-tick, non-remediable Ready CI failure that
# recovers on the next tick must never page an operator. CI reports FAILURE on
# the PR's first Ready check (remediation disabled, so this is the generic
# non-remediable path — the incident's writer), then SUCCESS on the same head
# with no commit. The mill records a failed Ready result, retries through the
# shared stage-failure-ready budget, and merges — with zero .needs-attention at
# any tick (JOURNEY_EXPECT_ATTENTION=0, the default).
#
# Protects against: a first-occurrence retryable Ready failure paging an
# operator (the 2026-10-30 incident, CI run 41086521534, where a flaky tip
# check halted all merging for ~75 minutes).
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP ready-one-tick-failure journey: $reason"
  exit 0
fi

ISSUE="JRN-3360"
export FAKE_AGENT_SCRIPT_DIR
FAKE_AGENT_SCRIPT_DIR="$(cd "$(dirname "$0")/fixtures/ready-fail-remediate/fake-agent" && pwd)"
journey_init ready-one-tick-failure
# Remediation off: a failed Ready check takes the generic non-remediable path
# (the incident's writer), not the remediation launcher.
journey_write_config '{"ready":{"remediation":{"enabled":false}}}'
# No backoff between stage-failure-ready relaunches: the flake recovers on the
# same head, so the retry should re-check immediately (keeps the journey inside
# its wall-time budget).
export WAVEMILL_RETRY_BACKOFF_STAGE_FAILURE_READY_BASE_SECONDS=0
fakes_linear_add_issue "$ISSUE" "A change whose first Ready check flakes once" Todo

# ── fake CI: one-tick flake ──────────────────────────────────────────────────
# FAILURE until the mill has recorded one failed Ready result for the PR, then
# SUCCESS on the same head (no commit) — a transient check that recovers.
RECOVERED=0
ready_result_status() {
  local fd; fd="$(journey_feature_dir "$ISSUE" 2>/dev/null)" || return 1
  jq -r '.status // empty' "$fd/.ready-result.json" 2>/dev/null || true
}
ci_set_pr1() {
  local conclusion="$1" lock="$FAKE_GH_STATE.lock" i
  for i in $(seq 1 500); do mkdir "$lock" 2>/dev/null && break; sleep 0.01; done
  fakes_gh_state '.checks.byPr["1"] = [{name: "flaky-tip-check", conclusion: $c}]' --arg c "$conclusion"
  rm -rf "$lock"
}
CI_LAST=""
ci_tick() {
  # Flip to green once the mill has recorded the one-tick failure.
  if [[ "$RECOVERED" == "0" && "$(ready_result_status)" == "failed" ]]; then
    RECOVERED=1
    journey_log "fake CI: flaky-tip-check recovered (same head, no commit)"
  fi
  local want="FAILURE"
  [[ "$RECOVERED" == "1" ]] && want="SUCCESS"
  if [[ "$want" != "$CI_LAST" ]]; then
    ci_set_pr1 "$want"
    CI_LAST="$want"
  fi
}
ci_set_pr1 FAILURE

# ── observation ──────────────────────────────────────────────────────────────
SAW_READY_FAILED=0
phase_is() { ci_tick; [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
ready_failed_once() {
  ci_tick
  [[ "$(ready_result_status)" == "failed" ]] && SAW_READY_FAILED=1
  [[ "$SAW_READY_FAILED" == "1" ]]
}
pr_merged() { ci_tick; journey_pr_merged; }
mill_log_count() {
  sed 's/\x1b\[[0-9;]*[A-Za-z]//g' "$JOURNEY_TMP/logs/monitor.out" "$JOURNEY_TMP/logs/status.log" 2>/dev/null \
    | grep -c "$1" || true
}

journey_start_monitor
journey_set_tick_budget 75
journey_wait_until "$ISSUE" 5  "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

journey_wait_until "$ISSUE" 5  "task launched into planning"      phase_is planning
journey_wait_until "$ISSUE" 8  "coding launched"                  phase_is coding
journey_wait_until "$ISSUE" 8  "review launched"                  phase_is review
journey_wait_until "$ISSUE" 12 "the one-tick Ready failure landed" ready_failed_once
journey_wait_until "$ISSUE" 15 "PR merged after the flake recovered" pr_merged
journey_wait_until "$ISSUE" 8  "task reaped after merge"          journey_task_reaped "$ISSUE"

echo ""
echo "assertions:"
journey_assert "the one-tick Ready failure really happened (ready:failed observed)" \
  test "$SAW_READY_FAILED" = "1"
journey_assert "the generic non-remediable Ready failure never launched remediation" \
  test "$(mill_log_count "Launched ready remediation")" = "0"
journey_assert "no 'Remediation exhausted' at any point" \
  test "$(mill_log_count "Remediation exhausted")" = "0"
journey_assert_landed "$ISSUE"

# journey_finish asserts no .needs-attention at any tick (JOURNEY_EXPECT_ATTENTION=0).
journey_finish
