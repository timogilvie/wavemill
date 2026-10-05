#!/usr/bin/env bash
# HOK-2950: safety-control regression fixtures.
#
# Counter-fixtures to tests/incident-fixtures-terminal-panes.test.sh: they
# prove cleanup still preserves dirty, racy, divergent, unreachable-remote,
# and never-pushed work when driven through the SAME
# real monitor_issue_state -> cleanup_merged_primary_challenge_task ->
# cleanup_completed_task path (and, after preflight,
# safe_remove_task_worktree_and_branch) the incident fixtures exercise. If
# these regress, a "fix" for the terminal-
# pane leak has gone too far and started deleting real work.
#
# See tests/fixtures/incidents/README.md for local/CI invocation and how to
# add a new fixture.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=lib/incident-fixture-harness.sh
source "$SCRIPT_DIR/lib/incident-fixture-harness.sh"
incident_harness_require_tools

FIXTURES_DIR="$SCRIPT_DIR/fixtures/incidents"
# shellcheck source=fixtures/incidents/control_dirty_worktree.sh
source "$FIXTURES_DIR/control_dirty_worktree.sh"
# shellcheck source=fixtures/incidents/control_local_head_changed.sh
source "$FIXTURES_DIR/control_local_head_changed.sh"
# shellcheck source=fixtures/incidents/control_divergent_local_ahead.sh
source "$FIXTURES_DIR/control_divergent_local_ahead.sh"
# shellcheck source=fixtures/incidents/control_missing_network.sh
source "$FIXTURES_DIR/control_missing_network.sh"
# shellcheck source=fixtures/incidents/control_never_pushed.sh
source "$FIXTURES_DIR/control_never_pushed.sh"

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

marker_path_for_branch() {
  local repo_dir="$1" branch="$2"
  printf '%s/.wavemill/incidents/preserved-branches/%s.json\n' "$repo_dir" "${branch//\//__}"
}

branch_exists() {
  git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$1"
}

# assert_control_preserved <issue> <slug> <branch> <expected-reason> <expected-verification-reason-or-empty> [expected-episode-disposition] [expected-preflight-outcome]
#
# Drives ten ticks and asserts unchanged evidence produces one cleanup attempt
# and one durable episode instead of a repeated cleanup hot loop.
assert_control_preserved() {
  local issue="$1" slug="$2" branch="$3" expected_reason="$4" expected_verification_reason="$5"
  local expected_episode_disposition="${6:-retained}"
  local expected_preflight_outcome="${7:-}"
  local wt_dir="$WORKTREE_ROOT/$slug"
  local marker_path
  marker_path="$(marker_path_for_branch "$REPO_DIR" "$branch")"

  local tick1 tick1_cleanup tick1_remote
  tick1="$(run_monitor_tick "$issue" "$slug" "")"
  tick1_cleanup="$(tick_field "$tick1" cleanup_merged_primary_calls)"
  tick1_remote="$(tick_field "$tick1" remote_call_delta)"
  expect_eq "$tick1_cleanup" "1" "$issue tick1: cleanup_merged_primary_challenge_task attempted (guard must run, not skip)"
  case "$tick1_remote" in
    ''|*[!0-9]*) report_fail "$issue tick1: remote_call_delta missing or nonnumeric ($tick1_remote)" ;;
    *) report_pass "$issue tick1: remote_call_delta recorded ($tick1_remote)" ;;
  esac

  if [[ -n "$expected_preflight_outcome" ]]; then
    expect_true "$issue tick1: preflight did not reach branch deletion" \
      bash -c "[[ ! -e '$marker_path' ]]"
    expect_eq "$(jq -r --arg i "$issue" '.tasks[$i].lifecycle.cleanupEpisode.lastOutcome // ""' "$STATE_FILE")" "$expected_preflight_outcome" \
      "$issue tick1: cleanup preflight outcome"
  elif [[ -f "$marker_path" ]]; then
    report_pass "$issue tick1: preservation marker written at $marker_path"
    local actual_reason actual_verification
    actual_reason="$(jq -r '.reason // ""' "$marker_path")"
    expect_eq "$actual_reason" "$expected_reason" "$issue tick1: marker reason"
    if [[ -n "$expected_verification_reason" ]]; then
      actual_verification="$(jq -r '.verificationReason // ""' "$marker_path")"
      case "$actual_verification" in
        "$expected_verification_reason"*)
          report_pass "$issue tick1: marker verificationReason matches '$expected_verification_reason' (got '$actual_verification')"
          ;;
        *)
          report_fail "$issue tick1: marker verificationReason expected prefix '$expected_verification_reason', got '$actual_verification'"
          ;;
      esac
    fi
    local marker_fingerprint
    marker_fingerprint="$(jq -r '.cleanupFingerprint // ""' "$marker_path")"
    expect_true "$issue tick1: marker includes cleanup fingerprint" \
      bash -c "[[ -n '$marker_fingerprint' ]]"
  else
    report_fail "$issue tick1: no preservation marker found at $marker_path"
  fi

  expect_eq "$(jq -r --arg i "$issue" '.tasks[$i] != null' "$STATE_FILE")" "true" \
    "$issue tick1: workflow-state task entry retained (cleanup did not complete)"
  expect_true "$issue tick1: worktree directory still present on disk" \
    bash -c "[[ -d '$wt_dir' ]]"
  expect_true "$issue tick1: local branch still exists" branch_exists "$branch"
  expect_eq "$(jq -r --arg i "$issue" '.tasks[$i].lifecycle.cleanupEpisode.disposition // ""' "$STATE_FILE")" "$expected_episode_disposition" \
    "$issue tick1: cleanup episode disposition"
  expect_eq "$(jq -r --arg i "$issue" '.tasks[$i].lifecycle.cleanupEpisode.attemptCount // 0' "$STATE_FILE")" "1" \
    "$issue tick1: cleanup episode attempt count"
  if [[ "$expected_episode_disposition" == "retained" ]]; then
    expect_eq "$(jq -r --arg i "$issue" '.tasks[$i].lifecycle.resourceDisposition // ""' "$STATE_FILE")" "retained" \
      "$issue tick1: retained terminal work consumes no active slot"
  fi
  if [[ -n "$expected_preflight_outcome" ]]; then
    expect_eq "$(jq -r --arg i "$issue" '.tasks[$i].lifecycle.resourceDisposition // ""' "$STATE_FILE")" "verification-required" \
      "$issue tick1: unverified completion requires verification"
  fi

  local tick tick_cleanup tick_remote total_cleanup=1 total_remote="$tick1_remote"
  [[ "$total_remote" =~ ^[0-9]+$ ]] || total_remote=0
  for tick_number in 2 3 4 5 6 7 8 9 10; do
    tick="$(run_monitor_tick "$issue" "$slug" "")"
    tick_cleanup="$(tick_field "$tick" cleanup_merged_primary_calls)"
    tick_remote="$(tick_field "$tick" remote_call_delta)"
    [[ "$tick_cleanup" =~ ^[0-9]+$ ]] || tick_cleanup=0
    [[ "$tick_remote" =~ ^[0-9]+$ ]] || tick_remote=0
    total_cleanup=$((total_cleanup + tick_cleanup))
    total_remote=$((total_remote + tick_remote))
    expect_eq "$tick_cleanup" "0" "$issue tick$tick_number: unchanged cleanup episode skipped"
    expect_eq "$(tick_field "$tick" rc)" "0" "$issue tick$tick_number: monitor returns success"
  done
  expect_eq "$total_cleanup" "1" "$issue ten ticks: cleanup attempted once for unchanged evidence"
  expect_eq "$(jq -r --arg i "$issue" '.tasks[$i].lifecycle.cleanupEpisode.attemptCount // 0' "$STATE_FILE")" "1" \
    "$issue ten ticks: cleanup episode attempt count remains one"
  local expected_marker_count=1
  [[ -n "$expected_preflight_outcome" ]] && expected_marker_count=0
  expect_eq "$(find "$(dirname "$marker_path")" -type f -name '*.json' 2>/dev/null | wc -l | tr -d ' ')" "$expected_marker_count" \
    "$issue ten ticks: preservation marker count"
  expect_true "$issue tick10: worktree directory still present" \
    bash -c "[[ -d '$wt_dir' ]]"
  expect_true "$issue tick10: local branch still exists" branch_exists "$branch"
  expect_eq "$(jq -r --arg i "$issue" '.tasks[$i] != null' "$STATE_FILE")" "true" \
    "$issue tick10: workflow-state task entry still retained"
}

# ============================================================================
# Control 4: dirty worktree
# ============================================================================
echo ""
echo "=== Control 4: control_dirty_worktree_retained ==="
incident_scenario_new "dirty"
incident_setup_control_dirty_worktree
assert_control_preserved "$CONTROL_ISSUE" "$CONTROL_SLUG" "task/$CONTROL_SLUG" "dirty_worktree" "" "transient" "linear-completion-unverified"

# ============================================================================
# Control 5: local head changed mid-verification (race)
# ============================================================================
echo ""
echo "=== Control 5: control_local_head_changed_during_check ==="
incident_scenario_new "racehead"
incident_setup_control_local_head_changed
assert_control_preserved "$CONTROL_ISSUE" "$CONTROL_SLUG" "task/$CONTROL_SLUG" "unpushed_commits" "local_head_changed"

# ============================================================================
# Control 6: divergent - local ahead of what was pushed
# ============================================================================
echo ""
echo "=== Control 6: control_divergent_local_ahead_of_pushed ==="
incident_scenario_new "divergent"
incident_setup_control_divergent_local_ahead
assert_control_preserved "$CONTROL_ISSUE" "$CONTROL_SLUG" "task/$CONTROL_SLUG" "unpushed_commits" "remote_missing_local_head"

# ============================================================================
# Control 7: missing network (origin unreachable)
# ============================================================================
echo ""
echo "=== Control 7: control_missing_network ==="
incident_scenario_new "missingnet"
incident_setup_control_missing_network
assert_control_preserved "$CONTROL_ISSUE" "$CONTROL_SLUG" "task/$CONTROL_SLUG" "unpushed_commits" "base_fetch_failed:" "transient"

# ============================================================================
# Control 8: never pushed
# ============================================================================
echo ""
echo "=== Control 8: control_never_pushed ==="
incident_scenario_new "neverpushed"
incident_setup_control_never_pushed
assert_control_preserved "$CONTROL_ISSUE" "$CONTROL_SLUG" "task/$CONTROL_SLUG" "unpushed_commits" "remote_missing_local_head"

# ============================================================================
# Summary
# ============================================================================
echo ""
if [[ "$FAILURES" -eq 0 ]]; then
  echo "incident-fixtures-safety-controls: all assertions passed (safety guards intact)"
  exit 0
else
  echo "incident-fixtures-safety-controls: $FAILURES assertion(s) failed" >&2
  exit 1
fi
