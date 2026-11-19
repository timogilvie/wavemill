#!/usr/bin/env bash
# Golden journey: declared expansion, review, and eval telemetry does not
# retain a merged worktree or require operator attention.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then echo "SKIP mill-owned-output-reap journey: $reason"; exit 0; fi

ISSUE="JRN-3503"
export FAKE_AGENT_SCRIPT_DIR
FAKE_AGENT_SCRIPT_DIR="$(cd "$(dirname "$0")/fixtures/happy-path/fake-agent" && pwd)"
journey_init mill-owned-output-reap
fakes_linear_add_issue "$ISSUE" "Exercise mill-owned output cleanup" Todo
journey_start_monitor
journey_set_tick_budget 60
journey_wait_until "$ISSUE" 5 "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"
phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
journey_wait_until "$ISSUE" 5 "task launched" phase_is planning
journey_wait_until "$ISSUE" 8 "review launched" phase_is review

# Expansion writes a genuine estimate row to the main repo. Seed the remaining
# declared legacy/runtime telemetry paths in the task worktree while review and
# eval proceed, exercising the same dirty check and discard path as old runs.
slug="$(journey_task_field "$ISSUE" slug)"
wt="$(journey_task_field "$ISSUE" worktree)"
wt="${wt:-$WORKTREE_ROOT/$slug}"
# Exercise the real expansion size writer with a linked-worktree repoDir.
node --import tsx "$JOURNEY_INSTALL_DIR/tests/journeys/fixtures/mill-owned-output-reap/write-expansion-telemetry.ts" "$wt" "$ISSUE"
mkdir -p "$wt/.wavemill/evals"
printf '{"phase":"review"}\n' > "$wt/.wavemill/task-size-estimates.jsonl"
printf '{"phase":"eval"}\n' > "$wt/.wavemill/evals/prompt-registry.jsonl"
printf '{"phase":"legacy-prompt-registry"}\n' > "$wt/prompt-registry.jsonl"
printf '{"phase":"observer"}\n' > "$wt/.wavemill/observer-findings.jsonl"

journey_wait_until "$ISSUE" 15 "PR merged by tend" journey_pr_merged
journey_wait_until "$ISSUE" 8 "task reaped after merge" journey_task_reaped "$ISSUE"

journey_assert_landed "$ISSUE"
journey_assert "expansion telemetry is retained in the main repo" \
  grep -q "\"issueId\":\"$ISSUE\"" "$REPO_DIR/.wavemill/task-size-estimates.jsonl"
journey_assert "task worktree is reaped" test ! -d "$wt"
journey_assert "no operator attention was needed" test "$JOURNEY_SAW_ATTENTION" = "0"
journey_finish
