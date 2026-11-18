#!/usr/bin/env bash
# Golden journey: the integration branch lands a conflicting change AFTER Ready
# passed, the mill withdraws the passed verdict (HOK-3513), re-runs Ready, the
# mill-side base merge (HOK-3385) hands the conflict to one resolver, the
# resolved head goes green, and tend merges — with no operator touch.
#
# Protects against: the 2026-11-15/16 incident (HOK-3493 PR #1865, HOK-3382
# PR #1862). A Ready-passed PR that stopped being mergeable was marked
# `ready-stale` and parked by the watchdog at `needs-user` ("real merge
# conflicts on GitHub"); the merge lane never selected a DIRTY PR, so a person
# had to resolve or merge the base by hand. The post-pass conflict now has one
# disposition: invalidate the verdict (cause `conflict`), re-run Ready, and let
# its CONFLICTED branch repair it.
#
# Sibling of mid-flight-base-conflict.journey.sh, which covers the same
# conflict arriving *during* Ready and must keep its one-resolver-per-(head,
# base) behaviour unchanged.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP post-ready-base-conflict journey: $reason"
  exit 0
fi

ISSUE="JRN-3513"
# Before journey_init: the tmux server (and so every agent pane) inherits the
# environment at init.
export FAKE_AGENT_SCRIPT_DIR
FAKE_AGENT_SCRIPT_DIR="$(cd "$(dirname "$0")/fixtures/post-ready-conflict/fake-agent" && pwd)"
# Derive capabilities from the repo config: the merge-queue tick is where the
# one invalidation runs, and it is gated on the session having a queue consumer
# (tend). journey_init pins mergeQueue off, so opt back in below.
# shellcheck disable=SC2034  # read by journey_init (harness.sh)
JOURNEY_DERIVE_CAPABILITIES=1
journey_init post-ready-base-conflict
export MERGE_QUEUE_ENABLED=true
journey_write_config '{"mergeQueue":{"enabled":true}}'
# The failed-Ready relaunch resolves the task's recorded coder model; pin one
# the way an operator's `--coder-model` does (see ready-fail-remediate).
export WAVEMILL_CODER_MODEL="claude-opus-4-7"
fakes_linear_add_issue "$ISSUE" "Change that conflicts with integration after Ready passed" Todo
# Zero operator touches: the conflict must never surface as needs-attention
# (journey_assert_landed asserts no .needs-attention at any tick).

# ── the contender lands AFTER Ready passed ─────────────────────────────────
# The harness calls this right before the first tend tick, which only happens
# once Ready has published a handoff — i.e. after a completed pass.
land_contender_change() {
  local contender="$JOURNEY_TMP/contender-clone"
  [[ -d "$contender/.git" ]] || git clone -q "$FAKE_GH_ORIGIN" "$contender"
  (
    cd "$contender"
    git fetch -q origin
    git checkout -q -B "$JOURNEY_INTEGRATION_BRANCH" "origin/$JOURNEY_INTEGRATION_BRANCH"
    # Idempotent: a resumed run must not trip over its own fault.
    if ! grep -q 'contending change' journey-output.txt 2>/dev/null; then
      printf 'contending change landed after Ready passed\n' > journey-output.txt
      git add journey-output.txt
      git -c user.name=contender -c user.email=contender@example.invalid \
        commit -q -m "contending change to journey-output.txt"
      git push -q origin "$JOURNEY_INTEGRATION_BRANCH"
    fi
  )
}
# shellcheck disable=SC2034  # read by journey_tend_tick (harness.sh)
JOURNEY_BEFORE_FIRST_TEND=land_contender_change

journey_start_monitor
journey_set_tick_budget 120
journey_wait_until "$ISSUE" 5  "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

# ── observation ────────────────────────────────────────────────────────────
phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
feature_dir() { journey_feature_dir "$ISSUE"; }
ready_status() { jq -r '.status // empty' "$(feature_dir)/.ready-result.json" 2>/dev/null || true; }
handoff_published() {
  [[ "$(jq -r '.state // empty' "$(feature_dir)/.ready-tend-handoff.json" 2>/dev/null)" == "ready-published" ]]
}
ready_passed() { [[ "$(ready_status)" == "completed" ]] && handoff_published; }
contender_landed() {
  git --git-dir "$FAKE_GH_ORIGIN" log --format=%s "refs/heads/$JOURNEY_INTEGRATION_BRANCH" 2>/dev/null \
    | grep -q "contending change to journey-output.txt"
}
resolver_launches() { grep -c "phase=coding issue=$ISSUE role=conflict-resolver" "$FAKE_AGENT_LOG" 2>/dev/null || true; }
resolver_launched() { [[ "$(resolver_launches)" -ge 1 ]]; }
pr_exists() { [[ -n "$(fakes_gh_pr_field 1 state)" ]]; }
mill_log_count() {
  sed 's/\x1b\[[0-9;]*[A-Za-z]//g' "$JOURNEY_TMP/logs/monitor.out" "$JOURNEY_TMP/logs/status.log" 2>/dev/null \
    | grep -c "$1" || true
}

# ── waits ──────────────────────────────────────────────────────────────────
# Budgets are monitor ticks (passes), not seconds.
journey_wait_until "$ISSUE" 5  "task launched into planning"           phase_is planning
journey_wait_until "$ISSUE" 15 "review opened PR #1"                   pr_exists
journey_wait_until "$ISSUE" 15 "Ready passed and published a handoff"  ready_passed
journey_wait_until "$ISSUE" 10 "the base gained a conflicting change"  contender_landed
journey_wait_until "$ISSUE" 20 "Ready launched the conflict resolver"  resolver_launched
journey_wait_until "$ISSUE" 25 "PR merged by tend after the resolution" journey_pr_merged
journey_wait_until "$ISSUE" 10 "task reaped after merge"               journey_task_reaped "$ISSUE"

echo ""
echo "assertions:"
journey_assert "the passed Ready verdict was invalidated with cause conflict" \
  bash -c '(( $1 >= 1 ))' _ "$(mill_log_count "ready verdict invalidated (conflict)")"
journey_assert "exactly one resolver launched for the conflicted head" \
  test "$(resolver_launches)" = "1"
journey_assert "the mill opened the merge before the resolver ran (HOK-3385)" \
  grep -q "role=conflict-resolver merge_in_progress=yes" "$FAKE_AGENT_LOG"
journey_assert "both sides' lines survived the resolution" \
  bash -c 'content="$(git --git-dir "$1" show "refs/heads/$2:journey-output.txt")" \
    && grep -q "implemented" <<<"$content" && grep -q "contending change" <<<"$content"' \
    _ "$FAKE_GH_ORIGIN" "$JOURNEY_INTEGRATION_BRANCH"
journey_assert "the contending integration change survived the merge" \
  bash -c 'git --git-dir "$1" log --format=%s "refs/heads/$2" | grep -q "contending change to journey-output.txt"' \
    _ "$FAKE_GH_ORIGIN" "$JOURNEY_INTEGRATION_BRANCH"
journey_assert "no watchdog conflict park row was ever logged" \
  test "$(mill_log_count "real merge conflicts")" = "0"
journey_assert "no 'Conflict remediation exhausted' at any point" \
  test "$(mill_log_count "Conflict remediation exhausted")" = "0"
journey_assert_landed "$ISSUE"
# The repair-stage arm's launch is recorded like every other session, so the
# resolver's model and cost are attributable (HOK-3513 acceptance).
journey_assert_session_ownership "$ISSUE" planning coding review conflict-resolution

journey_finish
