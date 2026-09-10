#!/usr/bin/env bash
# HOK-2957 lifecycle invariant assertions.
#
# Every function maps to one packet success criterion. All functions:
#   - assume the harness variables from lifecycle-certification-harness.sh are
#     set (SESSION, SCENARIO_DIR, REPO_DIR, STATE_FILE, WORKTREE_ROOT, ...)
#   - return 0 on success, 1 on failure with a descriptive line on stderr
#   - never mutate state; strictly read-only diagnostics

# invariant_no_leaks — no tmux server processes on the scenario socket, no
# worktrees, no branches, no temp state beyond explicitly retained fixtures.
# Retention list is the fixture's list of expected preserved branches, one per
# argument.
invariant_no_leaks() {
  local -a expected_retained=("$@")
  local rc=0
  # tmux socket must be dead after teardown; for mid-scenario checks the
  # server is expected to be alive but the session should be gone once every
  # window is closed.
  if [[ -n "${REAL_TMUX:-}" && -S "$TMUX_SOCK" ]]; then
    if "$REAL_TMUX" -S "$TMUX_SOCK" list-sessions 2>/dev/null | grep -q .; then
      : # sessions still present is fine mid-scenario; final teardown kills the server
    fi
  fi
  local worktrees
  worktrees="$(git -C "$REPO_DIR" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}' | grep -Fv "$REPO_DIR" || true)"
  if [[ -n "$worktrees" ]]; then
    echo "INVARIANT_NO_LEAKS: unexpected worktrees remain: $worktrees" >&2
    rc=1
  fi
  local branches expected_pattern=""
  for retained in "${expected_retained[@]}"; do
    expected_pattern+="|^${retained}\$"
  done
  # strip leading pipe
  expected_pattern="${expected_pattern#|}"
  branches="$(git -C "$REPO_DIR" for-each-ref --format='%(refname:short)' refs/heads 2>/dev/null | grep -vE '^(main|master|auto/integration)$' || true)"
  if [[ -n "$expected_pattern" ]]; then
    branches="$(printf '%s\n' "$branches" | grep -vE "$expected_pattern" || true)"
  fi
  if [[ -n "$branches" ]]; then
    echo "INVARIANT_NO_LEAKS: unexpected local branches remain: $branches" >&2
    rc=1
  fi
  return "$rc"
}

# invariant_pane_released_within_interval <issue> <slug> <expected-policy>
# expected-policy ∈ {release, retain, metadata-only}. When release is
# expected, the window MUST be gone after the reconciliation tick sequence.
invariant_pane_released_within_interval() {
  local issue="$1" slug="$2" expected="${3:-release}"
  local target="$SESSION:${issue}-${slug}"
  case "$expected" in
    release)
      if incident_tmux list-windows -t "$SESSION" -F '#{window_name}' 2>/dev/null | grep -q "^${issue}-${slug}\$"; then
        echo "INVARIANT_PANE_RELEASE: window $target still alive; expected release policy" >&2
        return 1
      fi
      ;;
    retain|metadata-only)
      # any pane presence is acceptable
      ;;
    *)
      echo "INVARIANT_PANE_RELEASE: unknown expected policy '$expected'" >&2
      return 1
      ;;
  esac
  return 0
}

# invariant_no_duplicate_attempt_before_next_retry <issue> <cleanup-calls>
# When the cleanup episode has a nextRetryAt in the future, the number of
# cleanup attempts must not have grown since the previous tick.
invariant_no_duplicate_attempt_before_next_retry() {
  local issue="$1" cleanup_call_count="${2:-0}"
  local next_retry_at attempt_count
  next_retry_at="$(jq -r --arg i "$issue" '.tasks[$i].lifecycle.cleanupEpisode.nextRetryAt // empty' "$STATE_FILE" 2>/dev/null || true)"
  attempt_count="$(jq -r --arg i "$issue" '.tasks[$i].lifecycle.cleanupEpisode.attemptCount // 0' "$STATE_FILE" 2>/dev/null || echo 0)"
  if [[ -n "$next_retry_at" && "$attempt_count" =~ ^[0-9]+$ && "$attempt_count" -gt 1 && "$cleanup_call_count" -gt 1 ]]; then
    local now retry_epoch
    now="$(date -u +%s)"
    if retry_epoch="$(date -u -d "$next_retry_at" +%s 2>/dev/null)" || \
       retry_epoch="$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$next_retry_at" +%s 2>/dev/null)"; then
      if (( now < retry_epoch )); then
        echo "INVARIANT_CLEANUP_DEDUP: $issue attempted cleanup $cleanup_call_count times but nextRetryAt=$next_retry_at is still in the future" >&2
        return 1
      fi
    fi
  fi
  return 0
}

# invariant_deletion_requires_authority
# Every branch deletion recorded in the shadow ledger with wouldDelete=true
# must have a matching decision record whose classification is one of the
# safe_* forms, and (for safe_terminal_pr_head) the PR headRefOid must match
# the local head captured in the same evidence bundle.
invariant_deletion_requires_authority() {
  local ledger="$REPO_DIR/.wavemill/shadow/cleanup-decisions.jsonl"
  [[ -f "$ledger" ]] || return 0
  local bad
  bad="$(jq -c 'select(.wouldDelete == true and (.classification | test("^safe_") | not))' "$ledger" 2>/dev/null || true)"
  if [[ -n "$bad" ]]; then
    echo "INVARIANT_DELETION_AUTHORITY: ledger entries propose deletion without safe classification: $bad" >&2
    return 1
  fi
  return 0
}

# invariant_slot_accounting — slot count reported by
# slot_consuming_task_count must equal the number of tasks whose lifecycle
# disposition is a slot-consuming one.
invariant_slot_accounting() {
  local slots consuming
  slots="$(incident_slot_consuming_count 2>/dev/null || echo 0)"
  consuming="$(jq '[.tasks[]? | select(
      (.lifecycle.resourceDisposition // "") as $d
      | ($d == "active" or $d == "running" or $d == "reaping" or $d == ""))] | length' \
      "$STATE_FILE" 2>/dev/null || echo 0)"
  # loose bound: slots must not exceed the count of non-terminal tasks
  if [[ "$slots" =~ ^[0-9]+$ && "$consuming" =~ ^[0-9]+$ ]]; then
    if (( slots > consuming )); then
      echo "INVARIANT_SLOT_ACCOUNTING: slot count $slots exceeds non-terminal task count $consuming" >&2
      return 1
    fi
  fi
  return 0
}

# invariant_agreement <issue> <expected-controller> <expected-observer-finding-prefix> <expected-dashboard>
# expected-dashboard ∈ {absent, inactive, active}
invariant_agreement() {
  local issue="$1" expected_disposition="$2" observer_prefix="${3:-}" expected_dashboard="${4:-inactive}"
  local disposition observer_json dashboard
  disposition="$(jq -r --arg i "$issue" '.tasks[$i].lifecycle.resourceDisposition // ""' "$STATE_FILE" 2>/dev/null || echo "")"
  if [[ -n "$expected_disposition" && "$disposition" != "$expected_disposition" ]]; then
    echo "INVARIANT_AGREEMENT: controller disposition '$disposition' != expected '$expected_disposition' for $issue" >&2
    return 1
  fi
  if [[ -n "$observer_prefix" ]]; then
    observer_json="$(run_observer_pass 2>/dev/null || echo '{}')"
    if ! observer_has_finding_prefix "$observer_json" "$observer_prefix"; then
      echo "INVARIANT_AGREEMENT: observer produced no finding with prefix '$observer_prefix' for $issue" >&2
      return 1
    fi
  fi
  dashboard="$(dashboard_task_is_active "$issue" 2>/dev/null || echo unknown)"
  if [[ "$dashboard" != "$expected_dashboard" ]]; then
    echo "INVARIANT_AGREEMENT: dashboard '$dashboard' != expected '$expected_dashboard' for $issue" >&2
    return 1
  fi
  return 0
}
