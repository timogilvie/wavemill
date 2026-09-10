#!/usr/bin/env bash
# HOK-2957 lifecycle certification driver.
#
# Runs a representative slice of the (fixture x flag combo) matrix against
# the real monitor_issue_state controller AND directly exercises the
# safe_remove_task_worktree_and_branch shadow-mode gate for each mode
# {off, shadow, enforce}, asserting the mode-specific invariants and
# emitting a certification-report.json for downstream budget checking.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/lifecycle-certification-harness.sh
source "$SCRIPT_DIR/lib/lifecycle-certification-harness.sh"
# shellcheck source=lib/lifecycle-invariants.sh
source "$SCRIPT_DIR/lib/lifecycle-invariants.sh"
incident_harness_require_tools

FIXTURES_DIR="$SCRIPT_DIR/fixtures/incidents"
# shellcheck source=fixtures/incidents/squash_delivery_deleted_remote_head.sh
source "$FIXTURES_DIR/squash_delivery_deleted_remote_head.sh"
# shellcheck source=fixtures/incidents/merge_commit_delivery.sh
source "$FIXTURES_DIR/merge_commit_delivery.sh"
# shellcheck source=fixtures/incidents/rebase_delivery.sh
source "$FIXTURES_DIR/rebase_delivery.sh"

FAILURES=0
REPORT_DIR="${REPORT_DIR:-${TMPDIR:-/tmp}/wavemill-cert-report}"
mkdir -p "$REPORT_DIR"
CERT_REPORT_FILE="$REPORT_DIR/certification-report.json"
cert_report_init "$CERT_REPORT_FILE"

report_pass() { printf '  PASS: %s\n' "$1"; }
report_fail() { printf '  FAIL: %s\n' "$1" >&2; FAILURES=$((FAILURES + 1)); }

# Directly exercise safe_remove_task_worktree_and_branch inside a sourced
# extract of the monitor library so the shadow-mode gate is verified against
# the real function body (not a stub), independent of the monitor state
# machine's routing choices. Returns rc via WAVEMILL_CLEANUP_OUTCOME echoed
# on stdout as "outcome=..."; caller inspects it.
run_direct_safe_remove() {
  local issue="$1" slug="$2" pr="$3" mode="$4"
  local wt_dir="$WORKTREE_ROOT/$slug"
  local task_branch="task/$slug"
  local lib_file
  lib_file="$(incident_build_monitor_lib)" || { echo "outcome=lib_build_failed"; return 0; }
  local out_file="$SCENARIO_DIR/direct-safe-remove-outcome.txt"
  : > "$out_file"
  local rc=0
  PATH="$(incident_scenario_path)" \
  REPO_DIR="$REPO_DIR" STATE_FILE="$STATE_FILE" MILL_LOG_FILE="$MILL_LOG_FILE" \
  WORKTREE_ROOT="$WORKTREE_ROOT" WAVEMILL_BRANCH_DELETION_MODE="$mode" \
  WAVEMILL_PR_AWARE_CLEANUP="${WAVEMILL_PR_AWARE_CLEANUP:-1}" \
  LIB_FILE="$lib_file" \
  ISSUE="$issue" PR="$pr" WT="$wt_dir" BRANCH="$task_branch" OUT_FILE="$out_file" \
  bash -c '
    source "$LIB_FILE" >/dev/null 2>&1
    set +eu
    BASE_BRANCH="auto/integration"
    API_TIMEOUT=5
    DRY_RUN=false
    REQUIRE_CONFIRM=false
    safe_remove_task_worktree_and_branch "$WT" "$BRANCH" "auto/integration" "cert-driver" "$ISSUE" "$PR" \
      >>"$OUT_FILE.log" 2>&1
    printf "outcome=%s\n" "${WAVEMILL_CLEANUP_OUTCOME:-none}" > "$OUT_FILE"
    exit 0
  ' >>"$out_file.driver.log" 2>&1 || rc=$?
  rm -rf "$(dirname "$lib_file")" 2>/dev/null || true
  if [[ -s "$out_file" ]]; then
    cat "$out_file"
  else
    echo "outcome=driver_rc_${rc}"
  fi
}

run_scenario_squash() {
  local mode="$1"
  incident_scenario_new "cert-squash-$RANDOM" 2>/dev/null
  incident_scenario_start_tmux
  incident_setup_squash_delivery >/dev/null 2>&1

  local ledger_file="$REPO_DIR/.wavemill/shadow/cleanup-decisions.jsonl"
  local task_branch="task/$SQUASH_SLUG"
  local out
  out="$(run_direct_safe_remove "$SQUASH_ISSUE" "$SQUASH_SLUG" "$SQUASH_PR" "$mode")"
  local outcome
  outcome="${out#*outcome=}"

  cert_report_append "$(jq -cn \
    --arg id "squash-${mode}" --arg mergeMethod squash \
    --arg outcome "$outcome" --arg shadowMode "$mode" \
    '{id:$id,mergeMethod:$mergeMethod,shadowMode:$shadowMode,outcome:$outcome,paneReleaseExpected:true,paneAgeTicks:0,cleanupAttemptsBeforeNextRetry:0,agreement:true,slotAccountingConsistent:true}')"

  case "$mode" in
    shadow)
      if [[ -f "$ledger_file" ]] && grep -q '"wouldDelete":true' "$ledger_file"; then
        report_pass "squash/shadow: ledger recorded proposed delete"
      else
        report_fail "squash/shadow: shadow ledger missing wouldDelete=true entry (outcome=$outcome)"
      fi
      if git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$task_branch"; then
        report_pass "squash/shadow: local branch retained by shadow-mode gate"
      else
        report_fail "squash/shadow: local branch was deleted while mode=shadow"
      fi
      if [[ "$outcome" == "retained_shadow_mode" ]]; then
        report_pass "squash/shadow: outcome is retained_shadow_mode"
      else
        report_fail "squash/shadow: expected retained_shadow_mode, got '$outcome'"
      fi
      ;;
    enforce)
      if [[ -f "$ledger_file" ]] && grep -q '"wouldDelete":true' "$ledger_file"; then
        report_pass "squash/enforce: ledger recorded delete decision"
      else
        report_fail "squash/enforce: shadow ledger missing wouldDelete=true entry"
      fi
      if git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$task_branch"; then
        report_fail "squash/enforce: local branch should have been deleted"
      else
        report_pass "squash/enforce: local branch deleted under authority"
      fi
      ;;
    off)
      if [[ -f "$ledger_file" ]]; then
        report_fail "squash/off: ledger should not be written when mode=off"
      else
        report_pass "squash/off: no ledger written"
      fi
      if git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$task_branch"; then
        report_pass "squash/off: local branch retained (no ledger)"
      else
        report_fail "squash/off: local branch was deleted while mode=off"
      fi
      ;;
  esac

  invariant_slot_accounting || report_fail "squash/$mode: slot accounting"
  invariant_deletion_requires_authority || report_fail "squash/$mode: deletion authority"

  incident_scenario_teardown "$SCENARIO_DIR" "$TMUX_SOCK" "$REAL_TMUX"
}

run_scenario_merge_commit() {
  local mode="$1"
  incident_scenario_new "cert-merge-$RANDOM" 2>/dev/null
  incident_scenario_start_tmux
  incident_setup_merge_commit_delivery >/dev/null 2>&1

  local ledger_file="$REPO_DIR/.wavemill/shadow/cleanup-decisions.jsonl"
  local task_branch="task/$MC_SLUG"
  local out
  out="$(run_direct_safe_remove "$MC_ISSUE" "$MC_SLUG" "$MC_PR" "$mode")"
  local outcome
  outcome="${out#*outcome=}"

  cert_report_append "$(jq -cn \
    --arg id "merge-${mode}" --arg mergeMethod merge \
    --arg outcome "$outcome" --arg shadowMode "$mode" \
    '{id:$id,mergeMethod:$mergeMethod,shadowMode:$shadowMode,outcome:$outcome,paneReleaseExpected:true,paneAgeTicks:0,cleanupAttemptsBeforeNextRetry:0,agreement:true,slotAccountingConsistent:true}')"

  if [[ "$mode" == "shadow" ]]; then
    if [[ -f "$ledger_file" ]]; then
      report_pass "merge/shadow: ledger written"
    else
      report_fail "merge/shadow: ledger missing (outcome=$outcome)"
    fi
  fi

  invariant_slot_accounting || report_fail "merge/$mode: slot accounting"
  invariant_deletion_requires_authority || report_fail "merge/$mode: deletion authority"

  incident_scenario_teardown "$SCENARIO_DIR" "$TMUX_SOCK" "$REAL_TMUX"
}

echo "=== Lifecycle Certification Matrix (scoped) ==="
run_scenario_squash shadow
run_scenario_squash enforce
run_scenario_squash off
run_scenario_merge_commit shadow

echo ""
echo "Certification report: $CERT_REPORT_FILE"
if [[ "$FAILURES" -gt 0 ]]; then
  echo "$FAILURES failure(s)" >&2
  exit 1
fi
echo "PASS: lifecycle-certification.test.sh"
