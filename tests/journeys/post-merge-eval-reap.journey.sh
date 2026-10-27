#!/usr/bin/env bash
# Golden journey: post-merge eval completes after the task was reaped and does
# not resurrect it (HOK-3125).
#
# Protects against: the background post-merge eval settling with a raw
# `.tasks[$id].evalCompleted = true` write after the merge reaped the task.
# That write recreated the row as a phase/status/slug-less stub, the slot
# counter counted it as allocated, and the mill reported "0 slots available"
# with nothing running. The eval's outcome must land audit-only in
# terminalTaskHistory, never as a live task row.
#
# The judge call is gated (fixtures/post-merge-eval-reap/bin/claude) until the
# row is reaped, so the eval always settles post-reap — the losing side of the
# production race, made deterministic.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP post-merge-eval-reap journey: $reason"
  exit 0
fi

FIXTURE_DIR="$(cd "$(dirname "$0")/fixtures/post-merge-eval-reap" && pwd)"
ISSUE="JRN-1"
# A journey launched from inside a mill agent pane inherits that agent's
# WAVEMILL_PHASE / WAVEMILL_ISSUE; the fake CLI would then answer the eval's
# `claude -p` judge call as a phase launch instead of serving the verdict.
unset WAVEMILL_PHASE WAVEMILL_ISSUE
# The eval judge edge: the shared fake answers `claude -p` with this verdict.
export FAKE_JUDGE_VERDICT_FILE="$FIXTURE_DIR/judge-verdict.json"
journey_init post-merge-eval-reap
fakes_linear_add_issue "$ISSUE" "Add journey output file" Todo

# Pin the judge to the Claude CLI. The built-in default judge model is a GPT
# model served by the codex CLI, which has no shared fake and would reach the
# real network.
journey_write_config '{"eval": {"judge": {"model": "claude-sonnet-5", "provider": "claude-cli"}}}'
# Post-merge auto eval on (the harness default is off). MONITOR_ENV is sourced
# by the monitor, so the last assignment wins.
printf 'AUTO_EVAL=true\n' >> "$MONITOR_ENV"
# Judge gate: in front of the shared fake on the monitor's PATH (the eval runs
# as a monitor child); agent panes keep the tmux server's PATH.
export PATH="$FIXTURE_DIR/bin:$PATH"
export JOURNEY_EVAL_GATE_STATE="$STATE_FILE" JOURNEY_EVAL_GATE_ISSUE="$ISSUE"

EVAL_LOG="/tmp/${SESSION}-eval-${ISSUE}.log"

journey_start_monitor
journey_wait_until "$ISSUE" 5  "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
task_row_absent() { jq -e --arg id "$ISSUE" '.tasks[$id] == null' "$STATE_FILE" >/dev/null 2>&1; }
# The monitor writes the eval log under /tmp/<session>-*, which cleanup
# removes; keep a copy with the journey's logs for the failure trace.
eval_settled() {
  [[ -f "$EVAL_LOG" ]] && cp "$EVAL_LOG" "$JOURNEY_TMP/logs/eval.log"
  grep -q 'Eval process exited with code' "$EVAL_LOG" 2>/dev/null
}
post_reap_eval_recorded() {
  jq -e --arg id "$ISSUE" '.terminalTaskHistory.tasks[$id].postReapEval.outcome // empty' "$STATE_FILE" >/dev/null 2>&1
}
# Rows with no phase, status and slug: the HOK-3125 stub shape.
stub_rows() {
  jq -r '[(.tasks // {}) | to_entries[] | select((.value.phase // "") == "" and (.value.status // "") == "" and (.value.slug // "") == "") | .key] | join(",")' \
    "$STATE_FILE" 2>/dev/null
}

journey_wait_until "$ISSUE" 5  "task launched into planning"  phase_is planning
journey_wait_until "$ISSUE" 8  "coding launched"              phase_is coding
journey_wait_until "$ISSUE" 8  "review launched"              phase_is review
journey_wait_until "$ISSUE" 15 "PR merged by tend"            journey_pr_merged
journey_wait_until "$ISSUE" 8  "task reaped after merge"      journey_task_reaped "$ISSUE"
journey_wait_until "$ISSUE" 10 "post-merge eval settled"      eval_settled
journey_wait_until "$ISSUE" 3  "late eval outcome recorded in terminal history" post_reap_eval_recorded
# Give any post-reap writer (eval bookkeeping, job settlement, the reconciler)
# a few full monitor passes to resurrect the row before asserting it did not.
settle_until=$(( $(journey_tick) + 3 ))
ticks_passed() { (( $(journey_tick) >= settle_until )); }
journey_wait_until "$ISSUE" 5  "3 monitor passes after the eval settled" ticks_passed

echo ""
echo "assertions:"
journey_assert "the eval was launched by the merge (not skipped)" \
  grep -q "Launching post-merge eval in background" "$JOURNEY_TMP/logs/eval.log"
journey_assert "the judge was held until the reap (eval settled post-reap)" \
  grep -q "judge gate released: $ISSUE reaped" "$FAKE_AGENT_LOG"
journey_assert "the judge verdict was served to the eval" \
  grep -q "judge verdict served" "$FAKE_AGENT_LOG"
journey_assert "the judge never reached the unfaked codex CLI" \
  bash -c '! grep -qi "codex CLI" "$1"' _ "$JOURNEY_TMP/logs/eval.log"
journey_assert "the eval persisted its record (no evalFailed path)" \
  bash -c '! grep -q "Eval not persisted" "$1"' _ "$JOURNEY_TMP/logs/eval.log"
journey_assert "eval record appended for $ISSUE" \
  bash -c 'grep -qs "$2" "$1"/evals/*.jsonl' _ "$STATE_DIR" "$ISSUE"
journey_assert "late outcome recorded audit-only: postReapEval=completed" \
  test "$(jq -r --arg id "$ISSUE" '.terminalTaskHistory.tasks[$id].postReapEval.outcome // empty' "$STATE_FILE")" = "completed"
journey_assert "no task row recreated for $ISSUE after the eval settled" task_row_absent
journey_assert "no phase/status/slug-less stub rows in workflow-state" test -z "$(stub_rows)"
journey_assert_landed "$ISSUE"

journey_finish
