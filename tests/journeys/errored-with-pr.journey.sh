#!/usr/bin/env bash
# Golden journey: a task marked `error` after its PR already exists recovers
# and merges (HOK-3246).
#
# Protects against: the errored-task branch re-finding the PR every pass while
# the task stays `error` forever — save_task_state with an empty status keeps
# an existing terminal status, so the recovery never left `error`, nothing
# drove Ready or remediation, and "Found PR #N for errored task" looped.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP errored-with-pr journey: $reason"
  exit 0
fi

ISSUE="JRN-1"
journey_init errored-with-pr
fakes_linear_add_issue "$ISSUE" "Add journey output file" Todo

journey_start_monitor
journey_wait_until "$ISSUE" 30 "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
pr_open() { [[ "$(fakes_gh_pr_field 1 state)" == "OPEN" ]]; }
pr_merged() { [[ "$(fakes_gh_pr_field 1 state)" == "MERGED" ]]; }
task_reaped() {
  local status
  status="$(journey_task_field "$ISSUE" status)"
  [[ -z "$(journey_task_field "$ISSUE" phase)" || "$status" == "merged" || "$status" == "completed" ]] \
    && [[ ! -d "$WORKTREE_ROOT/$(jq -r --arg id "$ISSUE" '.tasks[$id].slug // "__none__"' "$STATE_FILE" 2>/dev/null)" ]]
}

journey_wait_until "$ISSUE" 60  "task launched into planning" phase_is planning
journey_wait_until "$ISSUE" 90  "coding launched"             phase_is coding
journey_wait_until "$ISSUE" 120 "PR #1 opened"                pr_open

# The race HOK-3246 was found through: the agent opened the PR, but a stale
# read declared it PR-less and the task was marked `error`.
bash -c 'source "$1/shared/lib/wavemill-common.sh"; state_mutate "$STATE_FILE" ".tasks[\$i].status = \"error\"" --arg i "$2"' \
  _ "$JOURNEY_INSTALL_DIR" "$ISSUE"
pr_open || journey_fail "PR #1 merged before the error could be forced (journey would pass vacuously)"
[[ "$(journey_task_field "$ISSUE" status)" == "error" ]] || journey_fail "forced status=error did not stick"
journey_log "forced $ISSUE status=error with PR #1 open"

journey_wait_until "$ISSUE" 150 "PR merged by tend after recovery" pr_merged
journey_wait_until "$ISSUE" 90  "task reaped after merge"          task_reaped

recovery_lines() {
  sed 's/\x1b\[[0-9;]*[A-Za-z]//g' "$JOURNEY_TMP/logs/monitor.out" "$JOURNEY_TMP/logs/status.log" 2>/dev/null \
    | grep -c "Found PR #1 for errored task" || true
}

echo ""
echo "assertions:"
journey_assert "PR #1 merged into $JOURNEY_INTEGRATION_BRANCH" \
  test "$(fakes_gh_pr_field 1 baseRefName)" = "$JOURNEY_INTEGRATION_BRANCH"
journey_assert "errored-task recovery logged, and at most once per log (not every pass)" \
  bash -c 'n="$1"; (( n >= 1 && n <= 2 ))' _ "$(recovery_lines)"
journey_assert "Linear issue ended Done" test "$(fakes_linear_state_of "$ISSUE")" = "Done"
journey_assert_no_unhandled_fake_calls

journey_finish
