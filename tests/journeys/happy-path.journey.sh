#!/usr/bin/env bash
# Golden journey: one task from backlog selection to merged and reaped.
#
# Protects against: any break in the plan → code → review → ready → tend merge
# → reap chain across real module boundaries — e.g. a reader that expects a
# field the writer never produces (HOK-3212), or a hand-off whose two sides
# disagree on shape (the reconciler never applying wm:ready).
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP happy-path journey: $reason"
  exit 0
fi

ISSUE="JRN-1"
# The review phase invokes the real adapter against the shared CLI fake.
export FAKE_AGENT_SCRIPT_DIR
FAKE_AGENT_SCRIPT_DIR="$(cd "$(dirname "$0")/fixtures/happy-path/fake-agent" && pwd)"
journey_init happy-path
fakes_linear_add_issue "$ISSUE" "Add journey output file" Todo

journey_start_monitor
journey_set_tick_budget 60
# The operator picks the first backlog task, as from the mill prompt.
journey_wait_until "$ISSUE" 5  "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }

# Budgets are monitor ticks (passes), not seconds.
journey_wait_until "$ISSUE" 5  "task launched into planning" phase_is planning
TASK_RUN_ID="$(journey_task_field "$ISSUE" runId)"
TASK_SDK_RUN_ID="$(journey_task_field "$ISSUE" sdkRunId)"
# HOK-3403: a workflow-state writer dies while its owner-stamped lock is held.
# The real monitor must reclaim it on its next state write and finish the task.
lock_ready="$JOURNEY_TMP/killed-state-writer.ready"
fakes_spawn bash -c 'source "$1"; state_lock_acquire "$2" 100 0.01 journey-killed-writer; : > "$3"; exec sleep 300' \
  _ "$JOURNEY_INSTALL_DIR/shared/lib/state-lock.sh" "$STATE_FILE.lock" "$lock_ready"
lock_writer_pid="$FAKES_LAST_SPAWN_PID"
for _ in {1..100}; do
  [[ -f "$lock_ready" ]] && break
  sleep 0.05
done
[[ -f "$lock_ready" ]] || journey_fail "writer did not acquire workflow-state lock"
kill -KILL "$lock_writer_pid"
wait "$lock_writer_pid" 2>/dev/null || true
journey_assert "killed writer left its owner-stamped lock" test -f "$STATE_FILE.lock/owner.json"
# HOK-3516: several writers race the monitor to reclaim the dead owner's lock.
# A sampler watches the lock path throughout; the module's own operations must
# never leave it as an ownerless directory (the 2026-11-21 incident shape).
lock_violation="$JOURNEY_TMP/ownerless-lock-violation"
fakes_spawn bash -c '
  for _ in $(seq 1 300); do
    if [[ -d "$1" && ! -e "$1/owner.json" ]]; then
      sleep 0.2
      if [[ -d "$1" && ! -e "$1/owner.json" ]]; then ls -la "$1" > "$2" 2>&1; exit 0; fi
    fi
    sleep 0.05
  done' _ "$STATE_FILE.lock" "$lock_violation"
for waiter in 1 2; do
  fakes_spawn bash -c '
    source "$1"
    for _ in 1 2 3 4 5; do
      if state_lock_acquire "$2" 200 0.01 "journey-race-$3"; then state_lock_release "$2"; fi
    done' _ "$JOURNEY_INSTALL_DIR/shared/lib/state-lock.sh" "$STATE_FILE.lock" "$waiter"
done
journey_wait_until "$ISSUE" 8  "coding launched"             phase_is coding
journey_wait_until "$ISSUE" 8  "review launched"             phase_is review
journey_wait_until "$ISSUE" 15 "PR merged by tend"           journey_pr_merged
journey_wait_until "$ISSUE" 8  "task reaped after merge"     journey_task_reaped "$ISSUE"

echo ""
echo "assertions:"
journey_assert_landed "$ISSUE"
# Recovery's run fence must survive the complete normal path and cleanup.
for stage in planning coding review ready; do
  journey_assert "$stage completion retains the launched task run" \
    jq -e --arg run "$TASK_RUN_ID" '.runId == $run' "$REPO_DIR/.wavemill/evals/artifacts/$ISSUE/.$stage-result.json"
done
for stage in planning coding review; do
  result="$REPO_DIR/.wavemill/evals/artifacts/$ISSUE/.$stage-result.json"
  ownership="$REPO_DIR/.wavemill/evals/artifacts/$ISSUE/.session-ownership.jsonl"
  journey_assert "$stage result carries the SDK run" jq -e --arg run "$TASK_SDK_RUN_ID" '.attemptRef.run_id == $run and (.attemptRef.stage_attempt_id | type == "string")' "$result"
  attempt="$(jq -r '.attemptRef.stage_attempt_id' "$result")"
  journey_assert "$stage ownership matches its result" jq -s -e --arg run "$TASK_SDK_RUN_ID" --arg attempt "$attempt" 'any(.[]; .type == "launch" and .attemptRef.run_id == $run and .attemptRef.stage_attempt_id == $attempt)' "$ownership"
done
# The shared journey disables automatic eval. Exercise the production artifact
# gatherer and record builder against the archived coding result instead.
journey_eval_lineage_matches() {
  (cd "$JOURNEY_INSTALL_DIR" && node --import tsx --input-type=module -e '
    import { gatherStageArtifacts } from "./shared/lib/eval-context-gatherer.ts";
    import { attachAttemptLineage } from "./shared/lib/eval-record-builder.ts";
    const [repo, issue, run] = process.argv.slice(1);
    const record = {};
    attachAttemptLineage(record, gatherStageArtifacts(repo, issue, "task/add-journey-output-file").attemptLineage);
    if (record.attemptLineage?.run_id !== run) process.exit(1);
  ' "$REPO_DIR" "$ISSUE" "$TASK_SDK_RUN_ID")
}
journey_assert "eval carries the SDK run" journey_eval_lineage_matches
journey_assert "the happy path creates no retired ledger database" \
  test ! -e "$REPO_DIR/.wavemill/ledger.sqlite"
journey_assert "the happy path creates no retired duplicate audit" \
  test ! -e "$REPO_DIR/.wavemill/side-effect-duplicates.jsonl"
journey_assert "post-merge eval completed without operator attention" \
  test "$JOURNEY_SAW_ATTENTION" = "0"
# HOK-3516: no reclaim or release interleaving stranded an ownerless directory
# at the workflow-state lock path while the writers raced.
journey_assert "no writer stranded an ownerless workflow-state lock" \
  test ! -e "$lock_violation"
journey_assert_session_ownership "$ISSUE" planning coding review helper:json-code-review
# HOK-3474: replay a repo-scoped provider home after reap. Every consumer must
# recover the same owned coding evidence even though its cwd no longer exists.
node --import tsx "$JOURNEY_INSTALL_DIR/tests/journeys/fixtures/happy-path/provider-transcript-replay.ts" "$REPO_DIR" "$ISSUE"

journey_finish
