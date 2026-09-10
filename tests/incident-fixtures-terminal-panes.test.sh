#!/usr/bin/env bash
# HOK-2950: cross-component regression fixtures for the 2026-09-05 terminal
# resource leak / repeated-cleanup incident.
#
# Drives the REAL monitor_issue_state controller (extracted from
# shared/lib/wavemill-monitor.sh), real git topology, a real isolated tmux
# server, and the real tools/observer.ts against three incident topologies:
#   1. HOK-2595-style closed non-challenge task with a retained pane
#      (fixed by HOK-2952: full cleanup + durable pane release on tick 1).
#   2. HOK-2913_c-style challenger superseded by a merged primary
#      (fixed by HOK-2952: missing challengeRole takes full cleanup).
#   3. Squash-merged PR with a deleted remote head (still a pre-fix
#      reproduction - owned by the cleanup-proof ticket).
#
# See tests/fixtures/incidents/README.md for local/CI invocation and how to
# add a new fixture.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Note: this driver deliberately does NOT declare its own REPO_DIR - the
# harness's incident_scenario_new sets a global REPO_DIR per scenario (the
# scenario's own clone), and every fixture/assertion below reads that. The
# wavemill repo root itself is available as $INCIDENT_REPO_DIR once the
# harness below is sourced.
# HOK-2957: these regression fixtures predate the shadow-mode default and
# assert structural cleanup happens. Force enforce so pre-existing behavior
# is what gets exercised. Shadow mode is covered by
# tests/lifecycle-certification.test.sh.
export WAVEMILL_BRANCH_DELETION_MODE=enforce

# shellcheck source=lib/incident-fixture-harness.sh
source "$SCRIPT_DIR/lib/incident-fixture-harness.sh"
incident_harness_require_tools

FIXTURES_DIR="$SCRIPT_DIR/fixtures/incidents"
# shellcheck source=fixtures/incidents/hok2595_closed_non_challenge.sh
source "$FIXTURES_DIR/hok2595_closed_non_challenge.sh"
# shellcheck source=fixtures/incidents/hok2913c_superseded_challenger.sh
source "$FIXTURES_DIR/hok2913c_superseded_challenger.sh"
# shellcheck source=fixtures/incidents/squash_delivery_deleted_remote_head.sh
source "$FIXTURES_DIR/squash_delivery_deleted_remote_head.sh"

FAILURES=0

report_pass() { printf '  PASS: %s\n' "$1"; }
report_fail() { printf '  FAIL: %s\n' "$1" >&2; FAILURES=$((FAILURES + 1)); }

expect_eq() {
  local actual="$1" expected="$2" label="$3"
  if [[ "$actual" == "$expected" ]]; then
    report_pass "$label (got '$actual')"
  else
    report_fail "$label: expected '$expected', got '$actual'"
  fi
}

expect_true() {
  local label="$1"
  shift
  if "$@"; then
    report_pass "$label"
  else
    report_fail "$label"
  fi
}

preservation_marker_count() {
  local repo_dir="$1"
  # The directory legitimately does not exist when no branch was ever
  # preserved; a bare find would fail the pipefail-ed driver in that case.
  if [[ ! -d "$repo_dir/.wavemill/incidents/preserved-branches" ]]; then
    printf '0\n'
    return 0
  fi
  find "$repo_dir/.wavemill/incidents/preserved-branches" -type f -name '*.json' 2>/dev/null | wc -l | tr -d ' '
}

count_matching_lines() {
  local file="$1" pattern="$2"
  grep -c "$pattern" "$file" 2>/dev/null || true
}

tmux_window_count() {
  incident_tmux list-windows -t "$SESSION" -F '#{window_name}' 2>/dev/null | wc -l | tr -d ' '
}

run_startup_preflight_replay() {
  local before_windows after_windows before_agent after_agent rc=0
  before_windows="$(tmux_window_count)"
  before_agent="$(grep -cE '(^| )(claude|codex|native-agent)( |$)' "$NPX_CALLS_LOG" 2>/dev/null || true)"

  PATH="$(incident_scenario_path)" \
  SESSION="$SESSION" \
  REPO_DIR="$REPO_DIR" \
  WORKTREE_ROOT="$WORKTREE_ROOT" \
  STATE_FILE="$STATE_FILE" \
  STATE_DIR="$REPO_DIR/.wavemill" \
  MILL_LOG_FILE="$MILL_LOG_FILE" \
  TMUX_TMPDIR="$TMUX_TMPDIR" \
  TMUX_SOCK="$TMUX_SOCK" \
  WAVEMILL_RUN_EPOCH="incident-startup-epoch" \
  bash -c '
    set -Eeuo pipefail
    source "'"$INCIDENT_COMMON_SCRIPT"'"
    source "'"$INCIDENT_TERMINAL_RECONCILER_SCRIPT"'"
    source "'"$INCIDENT_REPO_DIR"'/shared/lib/startup-terminal-preflight.sh"
    BASE_BRANCH="auto/integration"
    API_TIMEOUT=5
    AGENT_CMD="codex"
    TOOLS_DIR="'"$INCIDENT_REPO_DIR"'/tools"
    LIB_DIR="'"$INCIDENT_REPO_DIR"'/shared/lib"
    REQUIRE_CONFIRM=false
    DRY_RUN=false
    CHALLENGE_AUTO_MERGE=false
    declare -Ag CLEANED=()
    log() { :; }
    log_warn() { :; }
    log_error() { :; }
    execute() { "$@" >/dev/null 2>&1 || true; }
    startup_terminal_preflight "$SESSION"
  ' || rc=$?

  after_windows="$(tmux_window_count)"
  after_agent="$(grep -cE '(^| )(claude|codex|native-agent)( |$)' "$NPX_CALLS_LOG" 2>/dev/null || true)"
  {
    printf 'rc=%s\n' "$rc"
    printf 'new_window_delta=%s\n' "$(( after_windows > before_windows ? after_windows - before_windows : 0 ))"
    printf 'agent_launch_delta=%s\n' "$((after_agent - before_agent))"
    printf 'slot_count=%s\n' "$(incident_slot_consuming_count)"
  }
}

# ============================================================================
# Scenario 1: HOK-2595-style closed non-challenge task, retained pane
# ============================================================================
echo ""
echo "=== Scenario 1: incident_hok2595_closed_non_challenge_pr_retained_pane ==="

incident_scenario_new "hok2595-startup"
incident_scenario_start_tmux
incident_setup_hok2595_closed_non_challenge
startup_replay_2595="$(run_startup_preflight_replay)"
expect_eq "$(tick_field "$startup_replay_2595" rc)" "0" "hok2595 startup preflight: completed"
expect_eq "$(tick_field "$startup_replay_2595" new_window_delta)" "0" "hok2595 startup preflight: created zero new task panes"
expect_eq "$(tick_field "$startup_replay_2595" agent_launch_delta)" "0" "hok2595 startup preflight: launched zero agents"
expect_eq "$(tick_field "$startup_replay_2595" slot_count)" "0" "hok2595 startup preflight: terminal state consumes no slots"

incident_scenario_new "hok2595"
incident_scenario_start_tmux
incident_setup_hok2595_closed_non_challenge

slots_before="$(incident_slot_consuming_count)"
expect_eq "$slots_before" "1" "hok2595 baseline: seeded task consumes one slot"

tick1="$(run_monitor_tick "$HOK2595_ISSUE" "$HOK2595_SLUG" "$HOK2595_PR")"
tick1_cleanup="$(tick_field "$tick1" cleanup_completed_calls)"
tick1_remote_delta="$(tick_field "$tick1" remote_call_delta)"

# HOK-2952: a closed non-challenge PR now takes the full-cleanup path on the
# first pass - pane released (archive + durable terminal record + kill),
# worktree/branch reaped by the guarded git cleanup, task state removed.
expect_eq "$tick1_cleanup" "1" "hok2595 tick1: cleanup_completed_task invoked exactly once for the closed non-challenge PR"
expect_true "hok2595 tick1: tmux pane closed after one terminal pass" \
  assert_pane_closed "$HOK2595_ISSUE" "$HOK2595_SLUG"
expect_eq "$(jq -r '.tasks["HOK-2595"] != null' "$STATE_FILE")" "false" \
  "hok2595 tick1: task entry removed from workflow-state"
expect_true "hok2595 tick1: durable terminal record written" \
  test -f "$REPO_DIR/.wavemill/evals/artifacts/$HOK2595_ISSUE/terminal-record.json"
expect_true "hok2595 tick1: pane transcript archived before release" \
  test -f "$REPO_DIR/.wavemill/evals/artifacts/$HOK2595_ISSUE/pane-transcript-pr_closed_unmerged.txt"
expect_eq "$(incident_slot_consuming_count)" "0" "hok2595 tick1: slot count back to baseline after the pass"

tick2="$(run_monitor_tick "$HOK2595_ISSUE" "$HOK2595_SLUG" "$HOK2595_PR")"
tick2_cleanup="$(tick_field "$tick2" cleanup_completed_calls)"
tick2_remote_delta="$(tick_field "$tick2" remote_call_delta)"
expect_eq "$tick2_cleanup" "0" "hok2595 tick2: repeated pass is a no-op (no new cleanup attempt)"
expect_eq "$tick2_remote_delta" "0" "hok2595 tick2: no remote-call growth on the no-op pass"
expect_true "hok2595 tick2: tmux pane stays closed" \
  assert_pane_closed "$HOK2595_ISSUE" "$HOK2595_SLUG"

restart_tick="$(run_monitor_tick "$HOK2595_ISSUE" "$HOK2595_SLUG" "$HOK2595_PR")"
restart_cleanup="$(tick_field "$restart_tick" cleanup_completed_calls)"
expect_eq "$restart_cleanup" "0" "hok2595 restart replay: durable state alone keeps the terminal pass a no-op"

observer_json="$(run_observer_pass)"
# Post-fix the controller and Observer agree: no parked terminal residue.
if observer_has_finding_prefix "$observer_json" "terminal-task-parked-${SESSION}-${HOK2595_ISSUE}"; then
  report_fail "hok2595: Observer still flags parked terminal residue after the fix; observer output: $observer_json"
else
  report_pass "hok2595: Observer no longer flags parked terminal residue"
fi

echo "  scenario 1 diagnostics: tick1=$tick1_cleanup tick2=$tick2_cleanup remote_deltas=${tick1_remote_delta}/${tick2_remote_delta}"

# ============================================================================
# Scenario 2: HOK-2913_c-style challenger superseded by a merged primary
# ============================================================================
echo ""
echo "=== Scenario 2: incident_hok2913c_challenger_superseded_pane_retained ==="

incident_scenario_new "hok2913c-startup"
incident_scenario_start_tmux
incident_setup_hok2913c_superseded_challenger
startup_replay_2913="$(run_startup_preflight_replay)"
expect_eq "$(tick_field "$startup_replay_2913" rc)" "0" "hok2913c startup preflight: completed"
expect_eq "$(tick_field "$startup_replay_2913" new_window_delta)" "0" "hok2913c startup preflight: created zero new task panes"
expect_eq "$(tick_field "$startup_replay_2913" agent_launch_delta)" "0" "hok2913c startup preflight: launched zero agents"
expect_eq "$(tick_field "$startup_replay_2913" slot_count)" "0" "hok2913c startup preflight: terminal state consumes no slots"

incident_scenario_new "hok2913c"
incident_scenario_start_tmux
incident_setup_hok2913c_superseded_challenger

slots_before_2913="$(incident_slot_consuming_count)"
expect_eq "$slots_before_2913" "2" "hok2913 baseline: both challenge arms consume slots"

# Primary tick: normal merge, should clean up fully on the same tick.
primary_tick1="$(run_monitor_tick "$HOK2913_ISSUE" "$HOK2913_SLUG" "$HOK2913_PR")"
primary_cleanup_merged="$(tick_field "$primary_tick1" cleanup_merged_primary_calls)"
expect_eq "$primary_cleanup_merged" "1" "hok2913 primary tick1: cleanup_merged_primary_challenge_task invoked exactly once"
expect_true "hok2913 primary tick1: primary tmux window closed" \
  assert_pane_closed "$HOK2913_ISSUE" "$HOK2913_SLUG"

# Challenger tick: closed PR, superseded, challengeRole missing (the drift
# shape). HOK-2952: the missing/unknown role now takes full-cleanup - pane
# released with a durable terminal record, guarded git cleanup, state reaped.
challenger_tick1="$(run_monitor_tick "$HOK2913C_ISSUE" "$HOK2913C_SLUG" "$HOK2913C_PR")"
challenger_cleanup1="$(tick_field "$challenger_tick1" cleanup_completed_calls)"
expect_eq "$challenger_cleanup1" "1" "hok2913c tick1: cleanup_completed_task invoked exactly once for the superseded challenger"
expect_true "hok2913c tick1: tmux pane closed after one terminal pass" \
  assert_pane_closed "$HOK2913C_ISSUE" "$HOK2913C_SLUG"
expect_eq "$(jq -r '.tasks["HOK-2913_c"] != null' "$STATE_FILE")" "false" \
  "hok2913c tick1: challenger task entry removed from workflow-state"
expect_true "hok2913c tick1: durable terminal record written" \
  test -f "$REPO_DIR/.wavemill/evals/artifacts/$HOK2913C_ISSUE/terminal-record.json"
expect_eq "$(jq -r '.recovery.branch' "$REPO_DIR/.wavemill/evals/artifacts/$HOK2913C_ISSUE/terminal-record.json")" \
  "task/$HOK2913C_SLUG" "hok2913c tick1: terminal record points recovery at the challenger branch"
expect_eq "$(incident_slot_consuming_count)" "0" "hok2913c tick1: no task consumes a slot after both terminal passes"

challenger_tick2="$(run_monitor_tick "$HOK2913C_ISSUE" "$HOK2913C_SLUG" "$HOK2913C_PR")"
challenger_cleanup2="$(tick_field "$challenger_tick2" cleanup_completed_calls)"
challenger_remote_delta2="$(tick_field "$challenger_tick2" remote_call_delta)"
expect_eq "$challenger_cleanup2" "0" "hok2913c tick2: repeated pass is a no-op (no new cleanup attempt)"
expect_eq "$challenger_remote_delta2" "0" "hok2913c tick2: no remote-call growth on the no-op pass"
expect_true "hok2913c tick2: tmux pane stays closed" \
  assert_pane_closed "$HOK2913C_ISSUE" "$HOK2913C_SLUG"

challenger_restart="$(run_monitor_tick "$HOK2913C_ISSUE" "$HOK2913C_SLUG" "$HOK2913C_PR")"
challenger_restart_cleanup="$(tick_field "$challenger_restart" cleanup_completed_calls)"
expect_eq "$challenger_restart_cleanup" "0" "hok2913c restart replay: converged state survives a restart"

observer_json_2913="$(run_observer_pass)"
if observer_has_finding_prefix "$observer_json_2913" "stale-active-task-live-process-${SESSION}-${HOK2913C_ISSUE}"; then
  report_fail "hok2913c: Observer still flags the superseded challenger after the fix; observer output: $observer_json_2913"
else
  report_pass "hok2913c: Observer no longer flags the superseded challenger"
fi

echo "  scenario 2 diagnostics: primary_cleanup=$primary_cleanup_merged challenger_cleanup=$challenger_cleanup1/$challenger_cleanup2 remote_delta_tick2=$challenger_remote_delta2"

# ============================================================================
# Scenario 3: Squash-merged PR with a deleted remote head
# ============================================================================
echo ""
echo "=== Scenario 3: incident_squash_delivery_deleted_remote_head ==="

incident_scenario_new "squash"
incident_setup_squash_delivery

squash_tick1="$(run_monitor_tick "$SQUASH_ISSUE" "$SQUASH_SLUG" "$SQUASH_PR")"
squash_rc1="$(tick_field "$squash_tick1" rc)"
squash_iteration1="$(tick_field "$squash_tick1" iteration_ms)"
marker_count_1="$(preservation_marker_count "$SCENARIO_DIR/repo")"

# HOK-2953: the merged PR's headRefOid exactly equals the local head, so the
# structured safe_terminal_pr_head authority must clean the branch up on the
# first tick even though ancestry is false and the remote head is deleted.
expect_eq "$marker_count_1" "0" \
  "squash tick1: no preservation marker is written (exact PR-head proof authorizes cleanup)"
expect_eq "$(jq -r '.tasks["HOK-3000"] != null' "$STATE_FILE")" "false" \
  "squash tick1: task entry is removed (cleanup completed)"
expect_true "squash tick1: worktree directory removed" \
  bash -c "[[ ! -d '$WORKTREE_ROOT/$SQUASH_SLUG' ]]"
if git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/task/$SQUASH_SLUG"; then
  report_fail "squash tick1: local branch task/$SQUASH_SLUG still exists after PR-head-proven cleanup"
else
  report_pass "squash tick1: local branch task/$SQUASH_SLUG deleted"
fi

# The deletion authority must be durably recorded for operator audit, with
# the exact evidence (classification, PR head OID, final head check) used.
squash_decision="$SCENARIO_DIR/repo/.wavemill/incidents/cleanup-decisions/task__${SQUASH_SLUG}.json"
if [[ -f "$squash_decision" ]]; then
  report_pass "squash tick1: cleanup decision evidence recorded at $squash_decision"
  expect_eq "$(jq -r '.classification // ""' "$squash_decision")" "safe_terminal_pr_head" \
    "squash tick1: decision classification is safe_terminal_pr_head"
  expect_eq "$(jq -r '.prHeadOid // ""' "$squash_decision")" "$SQUASH_LOCAL_HEAD" \
    "squash tick1: decision records the exact PR headRefOid"
  expect_eq "$(jq -r '.localHeadSha // ""' "$squash_decision")" "$SQUASH_LOCAL_HEAD" \
    "squash tick1: decision records the matching local head"
  expect_eq "$(jq -r '.prState // ""' "$squash_decision")" "MERGED" \
    "squash tick1: decision records the terminal PR state"
  expect_eq "$(jq -r '.finalCheckPassed // ""' "$squash_decision")" "true" \
    "squash tick1: decision records the final pre-deletion head check"
else
  report_fail "squash tick1: no cleanup decision evidence at $squash_decision"
fi

# Automatic cleanup must never recreate the deleted remote branch.
if git -C "$ORIGIN_DIR" show-ref --verify --quiet "refs/heads/task/$SQUASH_SLUG"; then
  report_fail "squash tick1: cleanup recreated the deleted remote branch"
else
  report_pass "squash tick1: deleted remote branch was not recreated"
fi

squash_tick2="$(run_monitor_tick "$SQUASH_ISSUE" "$SQUASH_SLUG" "$SQUASH_PR")"
squash_remote_delta2="$(tick_field "$squash_tick2" remote_call_delta)"
squash_iteration2="$(tick_field "$squash_tick2" iteration_ms)"
marker_count_2="$(preservation_marker_count "$SCENARIO_DIR/repo")"

# Restart-replay resource invariants. Driving monitor_issue_state directly
# for an already-reaped issue makes the terminal reconciler upsert a fresh
# (branch/worktree-less) task entry and recreate the feature dir - a harness
# artifact of the forced re-invocation, retained conservatively as
# retain_dirty. What must hold is that no deleted git resource reappears and
# nothing new is deleted: the local branch stays gone, the remote branch is
# never recreated, and the recorded deletion authority survives.
if git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/task/$SQUASH_SLUG"; then
  report_fail "squash tick2: local branch was resurrected"
else
  report_pass "squash tick2: local branch stays deleted"
fi
if git -C "$ORIGIN_DIR" show-ref --verify --quiet "refs/heads/task/$SQUASH_SLUG"; then
  report_fail "squash tick2: deleted remote branch was recreated on replay"
else
  report_pass "squash tick2: deleted remote branch still not recreated"
fi
if git -C "$REPO_DIR" worktree list 2>/dev/null | grep -q "$SQUASH_SLUG"; then
  report_fail "squash tick2: git-registered worktree reappeared"
else
  report_pass "squash tick2: no git-registered worktree reappears"
fi
expect_true "squash tick2: deletion authority record survives replay" \
  bash -c "[[ -f '$squash_decision' ]]"
# Any replay-tick marker must be a conservative retention, never a record
# that authorized deleting something on unchanged evidence.
if [[ "$marker_count_2" -gt 0 ]]; then
  replay_marker="$SCENARIO_DIR/repo/.wavemill/incidents/preserved-branches/task__${SQUASH_SLUG}.json"
  expect_eq "$(jq -r '.safeToDelete // false' "$replay_marker" 2>/dev/null)" "false" \
    "squash tick2: replay marker is a retention record, not deletion authority"
fi

restart_squash="$(run_monitor_tick "$SQUASH_ISSUE" "$SQUASH_SLUG" "$SQUASH_PR")"
marker_count_restart="$(preservation_marker_count "$SCENARIO_DIR/repo")"
if git -C "$ORIGIN_DIR" show-ref --verify --quiet "refs/heads/task/$SQUASH_SLUG"; then
  report_fail "squash restart replay: deleted remote branch was recreated"
else
  report_pass "squash restart replay: deleted remote branch still not recreated"
fi

timing_multiplier="${WAVEMILL_INCIDENT_FIXTURE_TIMING_TOLERANCE_MULTIPLIER:-1}"
tick1_budget_ms=$((10000 * timing_multiplier))
if [[ "$squash_iteration1" -lt "$tick1_budget_ms" ]]; then
  report_pass "squash tick1 iteration time ${squash_iteration1}ms within ${tick1_budget_ms}ms CI budget"
else
  report_fail "squash tick1 iteration time ${squash_iteration1}ms exceeded ${tick1_budget_ms}ms CI budget"
fi

echo "  scenario 3 diagnostics: rc1=$squash_rc1 markers=${marker_count_1}/${marker_count_2}/${marker_count_restart} iteration_ms=${squash_iteration1}/${squash_iteration2}"

# ============================================================================
# Summary
# ============================================================================
echo ""
if [[ "$FAILURES" -eq 0 ]]; then
  echo "incident-fixtures-terminal-panes: all assertions passed"
  exit 0
else
  echo "incident-fixtures-terminal-panes: $FAILURES assertion(s) failed" >&2
  exit 1
fi
