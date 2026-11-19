#!/usr/bin/env bash
# Golden journey (HOK-3511, replaying the HOK-3500 incident shape): a
# plan-stage challenge pair whose expanded route changes the primary's coder.
#
# The planning fake flips the primary's coder to the other pool model in
# `.post-expansion-route.json` AND stamps a stale carried executor
# (agent codex / provider openai) onto the primary's coding block — the exact
# on-disk shape the pre-HOK-3511 reseal left behind. The plan→code handoff
# must rewrite the block through the one contract writer, so the persisted
# agent is DERIVED from the new model, never carried. The primary's coding
# then fails once and must relaunch under the stage's bounded retry, with the
# derived executor and zero operator touches — HOK-3500 stalled silently for
# two hours at exactly this point.
#
# The pool is claude-only because the shared fakes serve only the claude CLI;
# the cross-family derivation (claude → native-openrouter) is pinned by
# shared/lib/stage-executor-replay.test.ts against the real registry. This
# journey pins the pipeline: route change → derived persisted executor →
# failure → contract replay → relaunch → pair completes.
export JOURNEY_PAIR_STAGE=plan
export JOURNEY_PAIR_NAME=plan-pair-coder-family-change
export JOURNEY_CODER_ROUTE_CHANGE=1
# One extra coding attempt on the primary: give the pair a little headroom.
export JOURNEY_PAIR_TICK_BUDGET=190

JOURNEY_PRIMARY_CODING_CONTRACT=""
JOURNEY_PRIMARY_ROUTING_CODER=""
JOURNEY_PRIMARY_EXECUTED_CODER=""

# The primary (the scripted loser) is retired with its worktree retained, but
# record its route state while it is live so the assertions cannot race reaping.
journey_pair_tick_hook() {
  local fd
  fd="$(journey_feature_dir "$ISSUE" 2>/dev/null)" || return 0
  [[ -n "$fd" && -f "$fd/.phase-config.json" ]] || return 0
  local contract
  contract="$(jq -r '"\(.coding.model)/\(.coding.agent // "")/\(.coding.provider // "")"' "$fd/.phase-config.json" 2>/dev/null || true)"
  # Keep the latest post-handoff snapshot (the flipped coder).
  if [[ "$contract" == claude-*/claude/anthropic ]]; then
    JOURNEY_PRIMARY_CODING_CONTRACT="$contract"
  fi
  local routing_coder
  routing_coder="$(jq -r '.coder // ""' "$fd/.routing-complete" 2>/dev/null || true)"
  [[ -n "$routing_coder" ]] && JOURNEY_PRIMARY_ROUTING_CODER="$routing_coder"
  local executed
  executed="$(jq -r '.stageRoutes.coder.executed // ""' "$fd/.post-expansion-route.json" 2>/dev/null || true)"
  [[ -n "$executed" ]] && JOURNEY_PRIMARY_EXECUTED_CODER="$executed"
}

journey_post_assertions() {
  local flipped
  flipped="$(sed -n 's/.*HOK-3511 expanded route flipped primary coder to \(.*\)$/\1/p' "$FAKE_AGENT_LOG" | head -1)"
  journey_assert "the expanded route flipped the primary coder (fixture armed)" \
    test -n "$flipped"

  # HOK-3511: the persisted coding contract carries the executor DERIVED from
  # the flipped model — the stale carried codex/openai pair the fixture
  # stamped must be gone.
  journey_assert "persisted coding contract is the flipped model with the derived executor" \
    test "$JOURNEY_PRIMARY_CODING_CONTRACT" = "$flipped/claude/anthropic"

  # The route artifacts agree on the flipped coder (top-level role and the
  # HOK-3363 stage-route record's executed model).
  journey_assert ".routing-complete coder follows the expanded route" \
    test "$JOURNEY_PRIMARY_ROUTING_CODER" = "$flipped"
  journey_assert "stageRoutes.coder.executed is the coder that ran" \
    test "$JOURNEY_PRIMARY_EXECUTED_CODER" = "$flipped"

  # One scripted failure, one bounded-retry relaunch, zero operator touches.
  journey_assert "the scripted coding failure fired on the primary" \
    grep -q 'HOK-3511 injected coding exit' "$FAKE_AGENT_LOG"
  local coding_launches
  coding_launches="$(journey_agent_launch_count "$ISSUE" coding)"
  journey_assert "primary coding relaunched after the failure (two launches)" \
    test "$coding_launches" -ge 2
  journey_assert "relaunch chain ran with zero operator touches" \
    test "$JOURNEY_SAW_ATTENTION" = "0"
}

source "$(dirname "$0")/challenge-pair-eval.journey.sh"
