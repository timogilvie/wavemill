#!/usr/bin/env bash
# Golden journey: a challenge pair runs both arms, the mill evals and compares
# them, the winner merges through tend and the loser is retired.
#
# The mill rolls an implementation-stage challenge for the task (challenge
# rate 1, coder pool narrowed to two Claude models so both arms run on the
# fake agent CLI). The challenger forks from the primary after the shared
# plan, both arms code, review (one PR each) and pass Ready; the mill then runs
# the real per-arm eval (run-eval-hook.ts) and the real blind comparison
# (compare-prs.ts), whose judge edge is the shared fake's seeded-verdict mode
# behind a shim that always picks the scripted winning arm (compare-prs
# randomises the A/B presentation order). With autoMergeWinner on, tend's
# challenge gate releases only the winner's PR.
#
# Protects against:
#   - the pair stalling before eval/compare because the challenger's pairing
#     drifted or one arm's state row was never saved (HOK-2926, HOK-3128);
#   - an eval/compare that never runs or never settles, leaving the merge lane
#     wedged on `pair-unresolved:no-comparison` (HOK-2462, HOK-2963);
#   - raw model-id comparison false-invalidating a valid pair (HOK-3321);
#   - the loser's PR merging, or staying open, or its arm lingering as a stub
#     row that holds a mill slot (HOK-2952, HOK-3125);
#   - the challenger, which never writes Linear (HOK-3113..HOK-3118), moving
#     the issue anyway.
#
# The loser is retired, not reaped: its closed-unmerged PR leaves work with no
# delivery evidence, so cleanup keeps its worktree and a terminal closed row
# (retention retain_closed_unmerged) until the operator abandons it — the same
# "never delete undelivered work" policy operator-abort-mid-coding pins.
#
# KNOWN GAP (pinned, not endorsed): when the challenger wins, nothing moves the
# Linear issue to Done — the challenger may not write Linear and the retired
# primary never does (it ends In Progress or In Review, depending on whether
# the primary opened its PR before it was retired). The assertion below pins
# "not Done"; flip it to "= Done" in the same PR that closes the gap.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP challenge-pair-eval journey: $reason"
  exit 0
fi

FIXTURE_DIR="$(cd "$(dirname "$0")/fixtures/challenge-pair-eval" && pwd)"
# shellcheck source=../../shared/lib/task-identity.sh
source "$JOURNEY_INSTALL_DIR/shared/lib/task-identity.sh"

ISSUE="JRN-5"
CHALLENGER="$(task_identity_challenger_id "$ISSUE")"
# The arm the scripted judge prefers. The challenger winning is the harder
# path: the primary (the only Linear writer) is the one retired.
WINNER="$CHALLENGER"
LOSER="$ISSUE"
# The two coder models the pair may draw (both resolve to the claude CLI).
POOL_MODELS=(claude-sonnet-4-6 claude-haiku-4-5)

# Before journey_init: the tmux server (and so every agent pane) inherits the
# environment at init. The arms leave the session telemetry and review
# identity a real Claude run does, so their PR route stamp is complete.
export FAKE_AGENT_SCRIPT_DIR="$FIXTURE_DIR/fake-agent"
journey_init challenge-pair-eval
fakes_linear_add_issue "$ISSUE" "Challenge pair journey change" Todo

# Challenge on: every task rolls an implementation-stage pair, the winner
# auto-merges. Every other coder in the registry is excluded so the pair is
# drawn from POOL_MODELS (computed, so a registry change cannot widen it).
exclusions="$(cd "$JOURNEY_INSTALL_DIR" && node --import tsx -e '
  const { listEffectiveModelsForStage } = await import("./shared/lib/effective-models.ts");
  const keep = new Set(process.argv.slice(1));
  const out = listEffectiveModelsForStage("coding").models
    .filter((m) => !keep.has(m))
    .map((model) => ({ model, reason: "challenge-pair journey: keep the pair on the fake claude CLI" }));
  console.log(JSON.stringify(out));
' "${POOL_MODELS[@]}")"
# The eval judge is pinned to a Claude model (served by the judge shim): the
# built-in default judge runs on the codex CLI, which has no shared fake and
# would reach the real network.
journey_write_config "$(jq -cn --argjson ex "$exclusions" '{
  challenge: {enabled: true, rate: 1, stageWeights: {implementation: 1}, autoMergeWinner: true},
  modelExclusions: $ex,
  eval: {judge: {model: "claude-sonnet-5", provider: "anthropic"}}
}')"
unset WAVEMILL_DISABLE_CHALLENGE
printf 'CHALLENGE_AUTO_MERGE=true\n' >> "$MONITOR_ENV"

# The judge shim sits ahead of the shared fake for the monitor's children
# (eval and comparison jobs); agent panes keep the plain fake.
export JOURNEY_WINNER_LINE="implemented $WINNER"
export PATH="$FIXTURE_DIR/bin:$PATH"

journey_start_monitor
journey_wait_until "$ISSUE" 5 "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

field() { journey_task_field "$1" "$2"; }
phase_is() { [[ "$(field "$ISSUE" phase)" == "$1" ]]; }
arm_pr() { field "$1" pr; }
arm_handoff_state() {
  local fd
  fd="$(journey_feature_dir "$1" 2>/dev/null)" || return 0
  jq -r '.state // empty' "$fd/.ready-tend-handoff.json" 2>/dev/null || true
}
pr_state() { fakes_gh_pr_field "$1" state; }

# The harness only plays tend for $ISSUE's handoff; play it for the
# challenger's too (the winner's lane once the primary is retired).
pair_tick() {
  if [[ "$(arm_handoff_state "$CHALLENGER")" == "ready-published" \
        && "$(arm_handoff_state "$ISSUE")" != "ready-published" ]]; then
    journey_tend_tick
  fi
}
challenger_launched() { pair_tick; [[ -n "$(field "$CHALLENGER" slug)" ]]; }
both_prs_open() {
  pair_tick
  local p c
  p="$(arm_pr "$ISSUE")"; c="$(arm_pr "$CHALLENGER")"
  [[ -n "$p" && -n "$c" && "$(pr_state "$p")" == "OPEN" && "$(pr_state "$c")" == "OPEN" ]]
}
comparison_recorded() {
  pair_tick
  [[ -n "$(comparison_winner)" ]]
}
comparison_winner() {
  # compare-prs appends one record per comparison to the evals dir.
  local file="$STATE_DIR/evals/challenge-records.jsonl"
  [[ -f "$file" ]] || return 0
  jq -r 'select((.winner // "") != "") | .winner' "$file" 2>/dev/null | tail -1
}
WINNER_PR=""
winner_merged() { pair_tick; [[ -n "$WINNER_PR" && "$(pr_state "$WINNER_PR")" == "MERGED" ]]; }
# Winner reaped (row and worktree gone), loser retired (terminal closed row),
# slot released.
pair_settled() {
  pair_tick
  [[ -z "$(field "$WINNER" phase)" && ! -d "$WORKTREE_ROOT/$WINNER_SLUG" ]] \
    && [[ "$(field "$LOSER" phase)/$(field "$LOSER" status)" == "closed/closed" ]] \
    && [[ "$(jq -r '.freeSlots // empty' "$STATE_FILE" 2>/dev/null)" == "1" ]]
}
loser_retention() {
  jq -r --arg id "$LOSER" '.tasks[$id].lifecycle | "\(.resourceDisposition // "")/\(.retention.reason // "")"' "$STATE_FILE" 2>/dev/null
}

# Budgets are monitor ticks (passes), not seconds.
journey_wait_until "$ISSUE" 5  "task launched into planning"        phase_is planning
journey_wait_until "$ISSUE" 10 "challenger forked after the plan"   challenger_launched
PRIMARY_SLUG="$(field "$ISSUE" slug)"
CHALLENGER_SLUG="$(field "$CHALLENGER" slug)"
journey_wait_until "$ISSUE" 15 "both arms opened a PR"              both_prs_open
journey_wait_until "$ISSUE" 25 "the mill compared the pair"         comparison_recorded
WINNER_PR="$(arm_pr "$WINNER")"
LOSER_PR="$(arm_pr "$LOSER")"
journey_wait_until "$ISSUE" 15 "winner's PR merged by tend"         winner_merged
WINNER_SLUG="$CHALLENGER_SLUG"
LOSER_SLUG="$PRIMARY_SLUG"
journey_wait_until "$ISSUE" 10 "winner reaped, loser retired"       pair_settled

echo ""
echo "assertions:"
journey_assert "the pair was rolled as a challenge (role recorded on both arms)" \
  test "$(grep -c "phase=coding issue=" "$FAKE_AGENT_LOG")" -ge 2
journey_assert "both arms were evaluated before the comparison" \
  bash -c '(( $(grep -c "Challenge eval completed for" "$1") >= 2 ))' _ "$JOURNEY_TMP/logs/status.log"
journey_assert "the comparison chose the scripted winner ($WINNER)" \
  test "$(comparison_winner)" = "challenger"
journey_assert "the judge was consulted through the fake (no live LLM)" \
  grep -q "judge picked candidate" "$FAKE_AGENT_LOG"
journey_assert "winner PR #$WINNER_PR merged into $JOURNEY_INTEGRATION_BRANCH" \
  test "$(fakes_gh_pr_field "$WINNER_PR" baseRefName)/$(pr_state "$WINNER_PR")" = "$JOURNEY_INTEGRATION_BRANCH/MERGED"
journey_assert "loser PR #$LOSER_PR closed, not merged" test "$(pr_state "$LOSER_PR")" = "CLOSED"
journey_assert "the winner's change is on $JOURNEY_INTEGRATION_BRANCH" \
  bash -c 'git --git-dir "$1" show "refs/heads/$2:journey-output.txt" | grep -qxF "$3"' \
    _ "$FAKE_GH_ORIGIN" "$JOURNEY_INTEGRATION_BRANCH" "$JOURNEY_WINNER_LINE"
journey_assert "KNOWN GAP: a challenger win never reaches Linear Done (see header)" \
  test "$(fakes_linear_state_of "$ISSUE")" != "Done"
journey_assert "winner $WINNER reaped: no row, no worktree" \
  bash -c '! jq -e --arg w "$2" ".tasks | has(\$w)" "$1" >/dev/null && [[ ! -d "$3" ]]' _ "$STATE_FILE" "$WINNER" "$WORKTREE_ROOT/$WINNER_SLUG"
journey_assert "loser $LOSER retired: the original row (slug kept), terminal closed, not a stub" \
  test "$(field "$LOSER" slug)/$(field "$LOSER" phase)/$(field "$LOSER" status)" = "$LOSER_SLUG/closed/closed"
journey_assert "loser's undelivered work retained for the operator (retain_closed_unmerged)" \
  test "$(loser_retention)" = "retained/retain_closed_unmerged"
journey_assert "only the loser's row remains (no stub recreated)" \
  test "$(jq -r '.tasks | keys | join(",")' "$STATE_FILE")" = "$LOSER"
journey_assert "slot count back to 0 (freeSlots == MAX_PARALLEL)" \
  test "$(jq -r '.freeSlots // empty' "$STATE_FILE")" = "1"
journey_assert "no .needs-attention at any tick" test "$JOURNEY_SAW_ATTENTION" = "0"
journey_assert_no_unhandled_fake_calls

journey_finish
