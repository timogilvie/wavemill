#!/usr/bin/env bash
# Golden journey (HOK-3370): the mill publishes every stage commit; evidence
# binds to the change. Coding commits without pushing, review commits a fix
# without pushing, the base advances so the PR is behind at Ready — and the
# task still merges with zero operator touches, with one head-move row per
# move and per-stage authorship readable from the archived record.
#
# Protects against: the HOK-3361 shape — an agent commit that never reaches
# the PR (Ready re-checking a stale red head until exhausted, or refusing
# "unpushed local work"), a mill base move staling review evidence by raw
# SHA, and a reviewer commit invisible to authorship records. Each of those
# cost an operator touch on 2026-10-31; this journey fails if any of them
# needs one again.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP head-move-publication journey: $reason"
  exit 0
fi

ISSUE="JRN-9"
# Before journey_init: the tmux server (and so every agent pane) inherits the
# environment at init.
export FAKE_AGENT_SCRIPT_DIR
FAKE_AGENT_SCRIPT_DIR="$(cd "$(dirname "$0")/fixtures/head-move-publication/fake-agent" && pwd)"
journey_init head-move-publication
fakes_linear_add_issue "$ISSUE" "Change published by the mill at each stage exit" Todo

journey_start_monitor
journey_wait_until "$ISSUE" 5  "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
pr_exists() { [[ -n "$(fakes_gh_pr_field 1 state)" ]]; }
branch_published() {
  # The coding agent never pushes; only the mill's stage-exit publication can
  # put the task branch on origin before review opens the PR.
  [[ -n "$(git --git-dir "$FAKE_GH_ORIGIN" for-each-ref --format='%(objectname)' 'refs/heads/task/*' 2>/dev/null | head -n 1)" ]]
}

# Budgets are monitor ticks (passes), not seconds.
journey_wait_until "$ISSUE" 5  "task launched into planning"             phase_is planning
journey_wait_until "$ISSUE" 8  "coding launched"                         phase_is coding
journey_wait_until "$ISSUE" 10 "mill published the unpushed coding head" branch_published
journey_wait_until "$ISSUE" 8  "review launched"                         phase_is review
journey_wait_until "$ISSUE" 15 "review opened PR #1"                     pr_exists
journey_wait_until "$ISSUE" 25 "PR merged by tend behind the moved base" journey_pr_merged
journey_wait_until "$ISSUE" 8  "task reaped after merge"                 journey_task_reaped "$ISSUE"

HEAD_MOVES="$REPO_DIR/.wavemill/evals/artifacts/$ISSUE/.head-moves.jsonl"
head_move_kind_count() {
  jq -rs --arg kind "$1" '[.[] | select(.kind == $kind)] | length' "$HEAD_MOVES" 2>/dev/null || echo 0
}

echo ""
echo "assertions:"
journey_assert "archived head-move record exists (survives the reap)" \
  test -s "$HEAD_MOVES"
journey_assert "the coding head move was recorded (kind=coding)" \
  bash -c '(( $(jq -rs "[.[] | select(.kind == \"coding\")] | length" "$1") >= 1 ))' _ "$HEAD_MOVES"
journey_assert "the reviewer fix commit was published and recorded (kind=review-fix)" \
  bash -c '(( $(jq -rs "[.[] | select(.kind == \"review-fix\")] | length" "$1") >= 1 ))' _ "$HEAD_MOVES"
journey_assert "the behind-base sync was recorded (base-merge, remediation carrying it, or tend rebase)" \
  bash -c '(( $(jq -rs "[.[] | select(.kind == \"base-merge\" or .kind == \"rebase\" or .kind == \"remediation\")] | length" "$1") >= 1 ))' _ "$HEAD_MOVES"
journey_assert "per-stage authorship distinguishes the review stage's commits" \
  bash -c 'jq -rs "[.[] | select(.stage == \"review\" and .kind == \"review-fix\")] | length" "$1" | grep -qv "^0$"' _ "$HEAD_MOVES"
journey_assert "every recorded publisher is the mill or tend, never an agent" \
  bash -c '[[ -z "$(jq -rs ".[] | select(.actor == \"agent\") | .kind" "$1")" ]]' _ "$HEAD_MOVES"
journey_assert "the unpushed reviewer fix reached the merged integration branch" \
  bash -c 'git --git-dir "$1" show "refs/heads/$2:reviewer-fix.txt" 2>/dev/null | grep -q "review fix applied"' \
    _ "$FAKE_GH_ORIGIN" "$JOURNEY_INTEGRATION_BRANCH"
journey_assert "the contending base advance survived the merge" \
  bash -c 'git --git-dir "$1" show "refs/heads/$2:base-advance.txt" 2>/dev/null | grep -q "unrelated base work"' \
    _ "$FAKE_GH_ORIGIN" "$JOURNEY_INTEGRATION_BRANCH"
journey_assert_landed "$ISSUE"
journey_assert_session_ownership "$ISSUE" planning coding review

journey_finish
