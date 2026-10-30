#!/usr/bin/env bash
# Golden journey (HOK-3322): Ready meets a flaky red check, the mill launches
# one Ready remediation, the agent re-runs CI green WITHOUT a new commit and
# settles idle, and the real monitor + tend complete Ready, publish the
# handoff and merge the same head with no operator touch.
#
# Protects against: the HOK-3316 strand. The monitor held the task forever on
# `ready status running + remediation launch head == current head`, an
# unconditional same-head hold that read a launch fact as liveness. The idle
# agent and the green CI could never advance it; tend kept reporting
# ready-failed:head-mismatch because no current-head Ready/handoff existed.
# The fix: the one Ready remediation disposition
# (shared/lib/ready-remediation-disposition.{ts,sh}) holds only while the
# owner is live per task-progress; a settled owner hands back to the
# controller Ready re-check, which reads current-head CI and publishes.
#
# Restore the old hold (`[[ "$launch_head" == "$current_head" ]] && return`)
# and the journey fails at "Ready completed and published the handoff".
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP ready-remediation-same-head journey: $reason"
  exit 0
fi

ISSUE="JRN-7"
# Before journey_init: the tmux server (and so every agent pane) inherits the
# environment at init.
export FAKE_AGENT_SCRIPT_DIR
FAKE_AGENT_SCRIPT_DIR="$(cd "$(dirname "$0")/fixtures/ready-remediation-same-head/fake-agent" && pwd)"
journey_init ready-remediation-same-head
# Ready remediation relaunches the task's recorded coder (see
# ready-fail-remediate.journey.sh).
export WAVEMILL_CODER_MODEL="claude-opus-4-7"
fakes_linear_add_issue "$ISSUE" "Change whose CI flakes once" Todo

# ── fake CI ────────────────────────────────────────────────────────────────
# A flaky check: red until the remediation agent re-runs it, green after, on
# the same head. Same gh-state lock as the fake's own writers.
ci_set_pr1() {
  local conclusion="$1" lock="$FAKE_GH_STATE.lock" i
  for i in $(seq 1 500); do
    mkdir "$lock" 2>/dev/null && break
    sleep 0.01
  done
  printf '%s' "$$" > "$lock/pid"
  fakes_gh_state '.checks.byPr["1"] = [{name: "unit-tests", conclusion: $c}]' --arg c "$conclusion"
  rm -rf "$lock"
}

CI_LAST=""
ci_tick() {
  local conclusion=FAILURE
  [[ -f "$FAKE_ROOT/ci-rerun-requested" ]] && conclusion=SUCCESS
  if [[ "$conclusion" != "$CI_LAST" ]]; then
    ci_set_pr1 "$conclusion"
    CI_LAST="$conclusion"
    journey_log "fake CI: unit-tests → $conclusion"
  fi
}
ci_set_pr1 FAILURE

# ── observation ────────────────────────────────────────────────────────────
remediation_launches() { grep -c "phase=coding issue=$ISSUE role=ready-remediation" "$FAKE_AGENT_LOG" 2>/dev/null || true; }
remediation_head() { sed -n "s/.*issue=$ISSUE role=ready-remediation head=\([0-9a-f]*\).*/\1/p" "$FAKE_AGENT_LOG" | head -1; }
phase_is() { ci_tick; [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
remediation_settled() {
  ci_tick
  [[ "$(remediation_launches)" -ge 1 && "$CI_LAST" == SUCCESS ]] \
    && jq -e '.agentRecord.state == "idle"' "/tmp/wavemill-${SESSION}-${ISSUE}.hook" >/dev/null 2>&1
}
# The controller's own Ready pass published the tend handoff (tend may claim
# it within the same poll, so a claimed handoff counts too).
handoff_published() {
  local fd
  ci_tick
  fd="$(journey_feature_dir "$ISSUE" 2>/dev/null)" || return 1
  case "$(jq -r '.state // empty' "$fd/.ready-tend-handoff.json" 2>/dev/null)" in
    ready-published|tend-claimed) return 0 ;;
  esac
  return 1
}
pr_merged() { ci_tick; journey_pr_merged; }
mill_log_count() {
  sed 's/\x1b\[[0-9;]*[A-Za-z]//g' "$JOURNEY_TMP/logs/monitor.out" "$JOURNEY_TMP/logs/status.log" 2>/dev/null \
    | grep -c "$1" || true
}

journey_start_monitor
journey_wait_until "$ISSUE" 5  "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

# Budgets are monitor ticks (passes), not seconds.
journey_wait_until "$ISSUE" 5  "task launched into planning"            phase_is planning
journey_wait_until "$ISSUE" 8  "coding launched"                        phase_is coding
journey_wait_until "$ISSUE" 8  "review launched"                        phase_is review
journey_wait_until "$ISSUE" 12 "remediation re-ran CI green and settled idle" remediation_settled
LAUNCH_HEAD="$(remediation_head)"
journey_wait_until "$ISSUE" 8  "Ready completed and published the handoff" handoff_published
journey_wait_until "$ISSUE" 15 "PR merged by tend"                      pr_merged
journey_wait_until "$ISSUE" 8  "task reaped after merge"                journey_task_reaped "$ISSUE"

echo ""
echo "assertions:"
journey_assert "exactly one remediation launched (the settled owner was not relaunched)" \
  test "$(remediation_launches)" = "1"
journey_assert "the remediation prompt carried the failing check" \
  grep -q "unit-tests" "$FAKE_ROOT/remediation-prompt-2.txt"
journey_assert "no new commit: the PR merged at the remediation launch head" \
  bash -c '[[ -n "$1" && "$(jq -r ".prs[\"1\"].headRefOid // empty" "$2")" == "$1" ]]' _ "$LAUNCH_HEAD" "$FAKE_GH_STATE"
journey_assert "no 'Ready remediation exhausted' at any point" \
  test "$(mill_log_count "Ready remediation exhausted")" = "0"
journey_assert "no 'Ready checks failed' needs-user park at any point" \
  test "$(mill_log_count "Ready checks failed (PR")" = "0"
journey_assert_landed "$ISSUE"
journey_assert_session_ownership "$ISSUE" planning coding review ready-remediation

journey_finish
