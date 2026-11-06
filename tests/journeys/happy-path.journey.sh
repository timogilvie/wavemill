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
journey_wait_until "$ISSUE" 8  "coding launched"             phase_is coding
journey_wait_until "$ISSUE" 8  "review launched"             phase_is review
journey_wait_until "$ISSUE" 15 "PR merged by tend"           journey_pr_merged
journey_wait_until "$ISSUE" 8  "task reaped after merge"     journey_task_reaped "$ISSUE"

echo ""
echo "assertions:"
journey_assert_landed "$ISSUE"
journey_assert "post-merge eval completed without operator attention" \
  test "$JOURNEY_SAW_ATTENTION" = "0"
journey_assert_session_ownership "$ISSUE" planning coding review helper:json-code-review

journey_finish
