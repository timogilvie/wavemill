#!/usr/bin/env bash
# Golden journey: a challenge pair where the challenger exits "done" on a
# dirty tree. The mill relaunches it once, terminalises it as a forfeit, and
# the primary arm still reviews, readies and merges with no operator touch
# (HOK-3228).
#
# Protects against:
#   - HOK-3128: a challenger that wrote .coding-complete and exited with
#     uncommitted work parked at needs-user forever, and its parked pair held
#     the primary's green PR out of the merge lane. The coding-dirty-handoff
#     bucket must relaunch once per head, then forfeit the challenger.
#   - The challenge pair chain itself (HOK-2798 / HOK-3155 / HOK-3156 class):
#     the pair is selected at launch, the challenger is forked at the
#     primary's plan→code handoff, the primary's challenge eval runs, the
#     forfeit record resolves the pair, and tend's challenge gate releases
#     the winner. The loser never opens a PR or reaches the base; it is
#     superseded with its uncommitted draft preserved.
#
# Formerly covered by the lifecycle-harness test
# test_coding_complete_dirty_tree_agent_exited_relaunches_then_terminalizes,
# retired per HOK-3228 (its primary-arm needs-user branch stays pinned in
# tests/coding-dirty-handoff.test.sh).
#
# The only fakes beyond the standard set: the fake `claude` answers the eval
# judge (fixtures/challenge-pair/fake-agent/headless), and the challenge pool
# is narrowed to two Claude models because the journey has no fake codex.
set -euo pipefail
source "$(dirname "$0")/harness.sh"
# shellcheck source=../../shared/lib/task-identity.sh
source "$JOURNEY_INSTALL_DIR/shared/lib/task-identity.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP challenge-pair journey: $reason"
  exit 0
fi

ISSUE="JRN-7"
CHALLENGER="$(task_identity_challenger_id "$ISSUE")"
# Before journey_init: the tmux server (and so every agent pane) inherits the
# environment at init.
export FAKE_AGENT_SCRIPT_DIR
FAKE_AGENT_SCRIPT_DIR="$(cd "$(dirname "$0")/fixtures/challenge-pair/fake-agent" && pwd)"
# The challenger's idle Stop hook is seconds old, not minutes: no grace before
# the dirty-handoff guard reads it as an exited agent.
export WAVEMILL_CODING_DIRTY_HANDOFF_GRACE_SECONDS=0
journey_init challenge-pair
# Every journey but this one runs single-arm; the monitor inherits the env.
unset WAVEMILL_DISABLE_CHALLENGE

# Challenge every task (rate 1), let the forfeit winner merge, and keep the
# pool to two launchable Claude coders (everything else excluded).
exclusions="$(jq -c '[.models[] | (.id // .modelId) | select(. != "claude-opus-4-7" and . != "claude-sonnet-4-6")
  | {model: ., reason: "journey: only the fake claude CLI exists"}]' \
  "$JOURNEY_INSTALL_DIR/shared/fixtures/model-registry.v1.json")"
journey_write_config "$(jq -cn --argjson ex "$exclusions" '{
  challenge: {enabled: true, rate: 1, autoMergeWinner: true},
  eval: {judge: {model: "claude-sonnet-4-6"}},
  modelExclusions: $ex
}')"
fakes_linear_add_issue "$ISSUE" "Challenged task whose challenger exits dirty" Todo

journey_start_monitor
journey_wait_until "$ISSUE" 5 "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
challenger_forked() { [[ -n "$(journey_task_field "$CHALLENGER" slug)" ]]; }
# The sentinel and its HOK-3172 condition companion are written back to back.
challenger_exhausted() {
  [[ -f "$CHALLENGER_FD/.retry-coding-dirty-handoff-exhausted" \
    && -s "$CHALLENGER_FD/.retry-coding-dirty-handoff-exhausted-condition.json" ]]
}
challenger_coding_launches() { journey_agent_launch_count "$CHALLENGER" coding; }

# Budgets are monitor ticks (passes), not seconds.
journey_wait_until "$ISSUE" 5  "task launched into planning"                  phase_is planning
journey_wait_until "$ISSUE" 10 "challenger forked at the plan→code handoff"   challenger_forked
CHALLENGER_FD="$(journey_feature_dir "$CHALLENGER")"
CHALLENGER_WT="$(journey_task_field "$CHALLENGER" worktree)"
CHALLENGER_BRANCH="$(journey_task_field "$CHALLENGER" branch)"
journey_wait_until "$ISSUE" 12 "dirty-handoff relaunch exhausted, challenger forfeited" challenger_exhausted
EXHAUSTED_REASON="$(cat "$CHALLENGER_FD/.retry-coding-dirty-handoff-exhausted" 2>/dev/null || true)"
EXHAUSTED_CONDITION="$(cat "$CHALLENGER_FD/.retry-coding-dirty-handoff-exhausted-condition.json" 2>/dev/null || true)"
journey_wait_until "$ISSUE" 25 "primary PR merged by tend"                     journey_pr_merged
journey_wait_until "$ISSUE" 8  "primary reaped after merge"                    journey_task_reaped "$ISSUE"
# The loser is retired once its sibling merged: superseded, holding no slot.
# Its uncommitted draft is preserved, never deleted (retain_dirty: unattended
# cleanup of dirty work is off), so the row stays as the record of that work.
loser_retired() {
  [[ "$(journey_task_field "$CHALLENGER" phase)/$(journey_task_field "$CHALLENGER" status)" == "superseded/superseded" ]] \
    && [[ "$(jq -r '.freeSlots // empty' "$STATE_FILE" 2>/dev/null)" == "1" ]]
}
journey_wait_until "$ISSUE" 8  "loser retired (superseded, no slot held)"      loser_retired

echo ""
echo "assertions:"
journey_assert "the challenger arm was forked from the primary (one pair, two arms)" \
  test -n "$CHALLENGER_WT"
journey_assert "the loser was retired: superseded, holding no slot" loser_retired
journey_assert "and its uncommitted draft was preserved, not deleted" \
  bash -c 'git -C "$1" status --porcelain -- journey-output.txt | grep -q .' _ "$CHALLENGER_WT"
journey_assert "the challenger got exactly one recovery relaunch (2 coding launches)" \
  test "$(challenger_coding_launches)" = "2"
journey_assert "the exhaustion sentinel records the dirty-handoff reason" \
  bash -c '[[ "$1" == *"dirty-handoff relaunch exhausted after 1 attempt"* ]]' _ "$EXHAUSTED_REASON"
journey_assert "and carries its HOK-3172 condition companion" test -n "$EXHAUSTED_CONDITION"
journey_assert "the challenger forfeited as a terminal dirty-handoff failure" \
  bash -c '(( $1 >= 1 ))' _ "$(journey_mill_log_count "$CHALLENGER → coding-dirty-handoff exhausted: challenger quarantined, primary released")"
journey_assert "the primary got exactly one coding launch (never stamped by its sibling)" \
  test "$(journey_agent_launch_count "$ISSUE" coding)" = "1"
journey_assert "the primary's challenge eval ran through the judge" \
  bash -c '(( $1 >= 1 ))' _ "$(grep -c "phase=headless" "$FAKE_AGENT_LOG" 2>/dev/null || true)"
journey_assert "only the primary opened a PR (the loser never reached GitHub)" \
  test "$(jq '.prs | length' "$FAKE_GH_STATE")" = "1"
journey_assert "the challenger's uncommitted draft never reached $JOURNEY_INTEGRATION_BRANCH" \
  bash -c '! git --git-dir "$1" show "refs/heads/$2:journey-output.txt" | grep -q "challenger draft"' \
    _ "$FAKE_GH_ORIGIN" "$JOURNEY_INTEGRATION_BRANCH"
journey_assert "the challenger's branch was never pushed" \
  bash -c '[[ -n "$2" ]] && ! git --git-dir "$1" show-ref --quiet "refs/heads/$2"' _ "$FAKE_GH_ORIGIN" "$CHALLENGER_BRANCH"
journey_assert_landed "$ISSUE"

journey_finish
