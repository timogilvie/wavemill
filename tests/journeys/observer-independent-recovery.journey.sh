#!/usr/bin/env bash
# Golden journey (HOK-3406): task repair is owned by the shared recovery
# controller, so a recoverable task completes with the Observer unavailable and
# zero operator touches.
#
# Protects against: the pre-HOK-3406 shape where Observer held a private repair
# engine (branch updates, retry-budget resets, stuck-arm forfeits) alongside the
# Monitor's recovery path. Two control loops meant duplicated side effects and
# fragmented retry limits. Here:
#   (A) a PR goes behind its base at Ready and is still merged by the mill with
#       observer.enabled=false and no .needs-attention;
#   (B) the behind-base repair is applied once (repeated ticks do not duplicate
#       it), and the controller fixture proves five repeated findings collapse
#       to exactly one claimed execution;
#   (C) an explicit human hold and a settled attempt cannot be bypassed by
#       automated recovery.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP observer-independent-recovery journey: $reason"
  exit 0
fi

ISSUE="JRN-12"
FIXTURE_DIR="$(cd "$(dirname "$0")/fixtures/observer-independent-recovery" && pwd)"
# Before journey_init: the tmux server (and so every agent pane) inherits the
# environment at init.
export FAKE_AGENT_SCRIPT_DIR="$FIXTURE_DIR/fake-agent"
journey_init observer-independent-recovery
# Observer is the point of the journey: keep it off explicitly (the harness
# default) rather than relying on a capability fold.
journey_write_config '{"observer":{"enabled":false}}'
fakes_linear_add_issue "$ISSUE" "Change recovered by the shared controller" Todo

journey_start_monitor
journey_set_tick_budget 110
journey_wait_until "$ISSUE" 5  "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
pr_exists() { [[ -n "$(fakes_gh_pr_field 1 state)" ]]; }

journey_wait_until "$ISSUE" 5  "task launched into planning" phase_is planning
journey_wait_until "$ISSUE" 8  "coding launched"             phase_is coding
journey_wait_until "$ISSUE" 8  "review launched"             phase_is review
journey_wait_until "$ISSUE" 15 "review opened PR #1 behind the moved base" pr_exists
journey_wait_until "$ISSUE" 30 "PR merged by the mill's recovery path" journey_pr_merged
journey_wait_until "$ISSUE" 8  "task reaped after merge"     journey_task_reaped "$ISSUE"

HEAD_MOVES="$REPO_DIR/.wavemill/evals/artifacts/$ISSUE/.head-moves.jsonl"
base_sync_moves() {
  jq -rs '[.[] | select(.kind == "base-merge" or .kind == "rebase" or .kind == "remediation")] | length' \
    "$HEAD_MOVES" 2>/dev/null || echo 0
}

echo ""
echo "assertions:"
journey_assert "Observer was disabled for the whole mill run" \
  jq -e '.observer.enabled == false' "$REPO_DIR/.wavemill-config.json"
journey_assert "the task landed with the base advance preserved" \
  bash -c 'git --git-dir "$1" show "refs/heads/$2:base-move.txt" 2>/dev/null | grep -q "unrelated base work"' \
    _ "$FAKE_GH_ORIGIN" "$JOURNEY_INTEGRATION_BRANCH"
journey_assert "the behind-base repair was applied (base-merge/rebase/remediation recorded)" \
  bash -c '(( $1 >= 1 ))' _ "$(base_sync_moves)"
journey_assert "the behind-base repair was applied exactly once (no duplicate)" \
  bash -c 'test "$1" = "1"' _ "$(base_sync_moves)"
journey_assert "the recovery controller's dedup/hold/settled check passes" \
  bash -c 'out="$(cd "$1" && node --import tsx "$2" 2>&1)" && grep -q "controller-check: ok" <<<"$out"' \
    _ "$JOURNEY_INSTALL_DIR" "$FIXTURE_DIR/controller-check.ts"
journey_assert "Observer wrote no private repair artifacts" \
  bash -c '! find "$1" "$2" -maxdepth 4 \( -name ".retry-observer-*" -o -name "auto-fix-state.json" -o -name "auto-fix-journal.json" \) 2>/dev/null | grep -q .' \
    _ "$STATE_DIR" "$WORKTREE_ROOT"
journey_assert_landed "$ISSUE"

journey_finish
