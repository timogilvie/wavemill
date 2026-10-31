#!/usr/bin/env bash
# Golden journey (HOK-3371): the HOK-3361 incident replay.
#
# Ready's transition tool (stamp-pr-route.ts) fails with a deterministic
# contract error. The mill must classify the failure through the single
# failure policy (ready_failure_classify_and_act → failure_policy_decide),
# keep the tool's error text in the typed sentinel, the mill log and the
# attention record, and NOT spend the retry budget, NOT move the head with an
# update-from-base, and NOT retire the task.
#
# Protects against: the bare {"transitionFailure":{"stage":"route-stamp"}}
# sentinel dropping the tool's stderr (the incident's blind spot), the
# transition_stage="github-api" default mislabelling the cause, the
# unconditional update-from-base staling the review on an unrelated
# validation error, and a private failed-ready-recheck counter spinning.
#
# End state: the task holds at Ready for the operator with the excerpt on the
# attention record. No merge, no remediation launch, no retry spend.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP ready-failure-disposition journey: $reason"
  exit 0
fi

ISSUE="JRN-8"
STAMP_ERROR="Expected resolved_model for planner inherited"

# The coder fake is unchanged (fixtures/ready-fail-remediate/fake-agent): a
# transition failure must never reach the coder, so the remediation path is
# only observed to be silent.
export FAKE_AGENT_SCRIPT_DIR
FAKE_AGENT_SCRIPT_DIR="$(cd "$(dirname "$0")/fixtures/ready-fail-remediate/fake-agent" && pwd)"
journey_init ready-failure-disposition

# ── shadow TOOLS_DIR ────────────────────────────────────────────────────────
# Every tool resolves to the real one through a symlink farm; stamp-pr-route
# resolves to the HOK-3361 replay fixture. The shadow must live at
# <install>/tools with <install>/shared beside it: agent-adapters.sh and
# wavemill-common.sh derive the lib dir as "${TOOLS_DIR%/tools}/shared/lib",
# so a shadow named anything else breaks model resolution (and every launch
# with it). Appended after journey_init wrote MONITOR_ENV, so the later
# TOOLS_DIR assignment wins when the monitor sources the file.
FAKE_INSTALL_DIR="$JOURNEY_TMP/install"
FAKE_TOOLS_DIR="$FAKE_INSTALL_DIR/tools"
mkdir -p "$FAKE_TOOLS_DIR"
ln -s "$JOURNEY_INSTALL_DIR/shared" "$FAKE_INSTALL_DIR/shared"
for entry in "$JOURNEY_INSTALL_DIR"/tools/*; do
  ln -s "$entry" "$FAKE_TOOLS_DIR/$(basename "$entry")"
done
rm -f "$FAKE_TOOLS_DIR/stamp-pr-route.ts"
cp "$(dirname "$0")/fixtures/ready-failure-disposition/stamp-pr-route-fixture.ts" \
  "$FAKE_TOOLS_DIR/stamp-pr-route.ts"
{
  printf 'TOOLS_DIR=%q\n' "$FAKE_TOOLS_DIR"
} >> "$MONITOR_ENV"
# The monitor sources MONITOR_ENV without set -a, so appended vars stay shell
# vars inside the monitor process. The fixture vars must reach the node child
# (process.env), so export them here: the monitor spawn — and every tool child
# it launches — inherits the journey's exported environment.
export FAKE_STAMP_FIXTURE="$JOURNEY_INSTALL_DIR/tests/journeys/fixtures/ready-fail-remediate/fake-stamp-pr-route.sh"
export FAKE_STAMP_CALLS_FILE="$JOURNEY_TMP/stamp-calls.log"
export FAKE_STAMP_REAL_TOOL="$JOURNEY_INSTALL_DIR/tools/stamp-pr-route.ts"

fakes_linear_add_issue "$ISSUE" "Change whose route stamp fails deterministically" Todo
# CI is green from the start: the failure under test is the transition tool,
# not the checks.
fakes_gh_state '.checks.byPr["1"] = [{name: "unit-tests", conclusion: "SUCCESS"}]'

# ── observation ────────────────────────────────────────────────────────────
phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
# The Ready state dir is the feature dir itself (ready_state_dir):
# .ready-result.json and .needs-attention live directly in it.
ready_state_dir() { journey_feature_dir "$ISSUE" 2>/dev/null; }
stamp_failed_ready() {
  local result
  result="$(ready_state_dir)/.ready-result.json" || return 1
  [[ -f "$result" ]] || return 1
  jq -e '.status == "failed"
    and (.artifacts.transitionFailure.stage == "route-stamp")
    and ((.artifacts.transitionFailure.detail // "") | contains("Expected resolved_model"))' \
    "$result" >/dev/null 2>&1
}
# Summed match count across the mill's two log sinks (grep -c prints one line
# per file when several are given).
mill_log_count() {
  sed 's/\x1b\[[0-9;]*[A-Za-z]//g' "$JOURNEY_TMP/logs/monitor.out" "$JOURNEY_TMP/logs/status.log" 2>/dev/null \
    | grep -c "$1" || true
}

journey_start_monitor
journey_wait_until "$ISSUE" 5  "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"
journey_wait_until "$ISSUE" 5  "task launched into planning" phase_is planning
journey_wait_until "$ISSUE" 8  "coding launched"             phase_is coding
journey_wait_until "$ISSUE" 8  "review launched"             phase_is review
journey_wait_until "$ISSUE" 10 "the stamp tool failed Ready with its contract error" stamp_failed_ready
attention_has_excerpt() {
  grep -q "$STAMP_ERROR" "$(ready_state_dir)/.needs-attention" 2>/dev/null
}
journey_wait_until "$ISSUE" 3 "the attention record carries the excerpt" attention_has_excerpt

echo ""
echo "assertions:"
journey_assert "the stamp tool error text reached the mill log" \
  bash -c '(( $1 >= 1 ))' _ "$(mill_log_count "$STAMP_ERROR")"
journey_assert "the error text is on the Ready attention record" \
  bash -c 'grep -q "$1" "$2"' _ "$STAMP_ERROR" "$(ready_state_dir)/.needs-attention"
journey_assert "update-from-base never ran for a deterministic transition error" \
  bash -c '(( $1 == 0 ))' _ "$(mill_log_count "updated from origin/")"
journey_assert "no ready remediation was launched" \
  bash -c '! grep -q "role=ready-remediation" "$1"' _ "$FAKE_AGENT_LOG"
journey_assert "the stamp tool was called exactly once (no blind retries)" \
  bash -c '[[ "$(wc -l < "$1" | tr -d " ")" == "1" ]]' _ "$JOURNEY_TMP/stamp-calls.log"
journey_assert "the shared stage-failure-ready budget was not charged" \
  bash -c '[[ -z "$(ls "$1"/.retry-stage-failure-ready-* 2>/dev/null)" ]]' \
  _ "$(ready_state_dir)"
journey_assert "the task holds at Ready for the operator (never retired)" \
  test "$(journey_task_field "$ISSUE" phase)" = "ready"
journey_assert "the PR was never merged" \
  bash -c '[[ "$1" != "MERGED" ]]' _ "$(jq -r '.prs["1"].state // empty' "$FAKE_GH_STATE")"
journey_assert "no legacy failed-ready-recheck sentinel appeared" \
  bash -c '[[ -z "$(ls "$1"/.failed-ready-recheck-* 2>/dev/null)" ]]' \
  _ "$(ready_state_dir)"

journey_assert_no_unhandled_fake_calls
journey_finish
