#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

check_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$name"
  else
    echo "    missing: $needle"
    fail "$name"
  fi
}

check_not_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "    unexpected: $needle"
    fail "$name"
  else
    pass "$name"
  fi
}

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

extract_function() {
  local source_file="$1"
  local function_name="$2"
  awk -v name="$function_name" '
    $0 ~ "^" name "\\(\\) \\{" { capture=1 }
    capture { print }
    capture && $0 == "}" { exit }
  ' "$source_file"
}

MONITOR_FUNC_FILE="$TEST_TMP/monitor_issue_state.sh"
# The extracted helpers are thin wrappers over the shared bounded-retry
# module (HOK-2924); make it available first.
cat "$REPO_DIR/shared/lib/bounded-retry.sh" > "$MONITOR_FUNC_FILE"
cat "$REPO_DIR/shared/lib/transient-marker.sh" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "ready_base_sha" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "get_main_head_sha" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "ready_stage_allows_merge" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "ready_stage_warn_bypass_once" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "ready_stage_pending_verdict" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "ready_pending_reason" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "ready_pending_is_challenge_work" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "pane_release_marker_path" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "pane_release_reason_actionable" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "clear_stale_pane_release_blocked_marker" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "release_task_pane_window_only" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "ready_remediation_launch_head" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "ready_conflict_attention_head" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "ready_conflict_recheck_interval_seconds" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "ready_conflict_recheck_due" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "ready_conflict_pr_is_clean" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "write_ready_conflict_recheck_at" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "clear_transient_mergeability_state" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "failed_ready_recheck_count" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "clear_failed_ready_recheck_state" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "failed_ready_recheck_reset_if_new_head" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "increment_failed_ready_recheck_count" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "failed_ready_recheck_backoff_seconds" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "failed_ready_recheck_due" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "ready_failure_reason" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "record_failed_ready_recheck_observation" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "failed_ready_recheck_identical_streak" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "mark_failed_ready_recheck_exhausted" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "failed_ready_recheck_gate" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "review_result_passes_ready_gate" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "review_result_has_final_evidence" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "review_result_missing_final_evidence" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "review_result_infra_failure" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "ready_queue_field" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "review_artifacts_with_pr_number" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "record_review_pr_reconciliation" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "clear_review_gate_attention" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "launch_review_for_missing_evidence" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "resolve_pair_on_primary_merge" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "cleanup_merged_primary_challenge_task" >> "$MONITOR_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "monitor_issue_state" >> "$MONITOR_FUNC_FILE"

if [[ ! -s "$MONITOR_FUNC_FILE" ]]; then
  echo "Could not extract monitor_issue_state()"
  exit 1
fi

run_monitor_case() {
  local case_name="$1"
  local case_dir="$TEST_TMP/$case_name"
  mkdir -p "$case_dir"

  CASE_NAME="$case_name" CASE_DIR="$case_dir" MONITOR_FUNC_FILE="$MONITOR_FUNC_FILE" SOURCE_REPO_DIR="$REPO_DIR" bash -lc '
    set -euo pipefail
    shopt -s expand_aliases
    source "$SOURCE_REPO_DIR/shared/lib/wavemill-common.sh"
    source "$MONITOR_FUNC_FILE"

    declare -Ag BRANCH_BY_ISSUE=()
    declare -Ag SLUG_BY_ISSUE=()
    declare -Ag PR_BY_ISSUE=()
    declare -Ag CLEANED=()

    ISSUE="HOK-1249"
    SLUG="monitor-ready"
    BRANCH="task/monitor-ready"
    PR="321"
    FOUND_PR=""
    SESSION="ready-transition-test"
    WORKTREE_ROOT="$CASE_DIR/worktrees"
    REPO_DIR="$CASE_DIR/repo"
    BASE_BRANCH="main"
    AGENT_CMD="codex"
    STATE_FILE="$CASE_DIR/state.json"
    API_TIMEOUT=5
    AUTO_EVAL="false"
    REQUIRE_CONFIRM="false"
    QUIT_REQUESTED="false"
    active_count=0
    CURRENT_PHASE="review"
    CURRENT_AGENT="codex"
    RESOLVED_PHASE="review"
    REVIEW_STATUS="running"
    READY_STATUS="completed"
    PR_STATUS="OPEN"
    VALIDATE_MERGED="false"
    RESTORE_SHOULD_FAIL="false"
    READY_LAUNCH_RC=0
    ABORTED="false"
    ATTENTION_STATE=""
    SET_PHASE_TO=""
    READY_LAUNCH_COUNT=0
    REVIEW_LAUNCH_COUNT=0
    RESTORE_COUNT=0
    CLEANUP_COUNT=0
    INVOKE_COUNT=1
    WRITE_STAGE_CALLS=""
    WRITE_READY_ATTENTION_CALLS=""
    SAVE_TASK_STATE_CALLS=""
    LOG_OUTPUT=""
    MAIN_SHA_RETURN="current-main-sha"
    MERGE_QUEUE_ON="false"
    QUEUE_STATE="ready"
    CHALLENGE_TASK="false"
    HANDLER_RC=0
    HANDLER_CALLS=0

    mkdir -p "$WORKTREE_ROOT/$SLUG/features/$SLUG" "$REPO_DIR"
    FEATURE_DIR="$WORKTREE_ROOT/$SLUG/features/$SLUG"
    READY_DIR="$FEATURE_DIR/ready"
    mkdir -p "$READY_DIR"
    cat > "$FEATURE_DIR/.review-result.json" <<JSON
{"stage":"review","status":"completed","artifacts":{"type":"review","prNumber":321,"exitCode":0,"verdict":"ready","iterations":1,"blockerCount":0}}
JSON
    printf "{\"title\":\"Monitor ready transition\"}\n" > "/tmp/${SESSION}-${ISSUE}-issue.json"

    BRANCH_BY_ISSUE["$ISSUE"]="$BRANCH"
    SLUG_BY_ISSUE["$ISSUE"]="$SLUG"
    PR_BY_ISSUE["$ISSUE"]="$PR"

    case "$CASE_NAME" in
      review_to_ready)
        ;;
      ready_conflict_rerun)
        CURRENT_PHASE="ready"
        READY_STATUS="completed"
        touch "$READY_DIR/.conflict-detected"
        ;;
      ready_conflict_attention_already_reported)
        CURRENT_PHASE="ready"
        READY_STATUS="completed"
        touch "$READY_DIR/.conflict-detected" "$READY_DIR/.conflict-attention-reported"
        printf "%s\n" "current-head" > "$READY_DIR/.conflict-attention-head"
        ;;
      ready_conflict_attention_different_head)
        CURRENT_PHASE="ready"
        READY_STATUS="completed"
        touch "$READY_DIR/.conflict-detected" "$READY_DIR/.conflict-attention-reported"
        printf "%s\n" "old-head" > "$READY_DIR/.conflict-attention-head"
        ;;
      ready_pending_repolls_ci)
        CURRENT_PHASE="ready"
        READY_STATUS="running"
        READY_LAUNCH_RC=4
        cat > "$READY_DIR/.ready-result.json" <<JSON
{"stage":"ready","status":"running","artifacts":{"verdict":"pending"}}
JSON
        ;;
      ready_pending_transitions_to_pass)
        CURRENT_PHASE="ready"
        READY_STATUS="running"
        READY_LAUNCH_RC=0
        cat > "$READY_DIR/.ready-result.json" <<JSON
{"stage":"ready","status":"running","artifacts":{"verdict":"pending"}}
JSON
        ;;
      ready_pending_failure_needs_user)
        CURRENT_PHASE="ready"
        READY_STATUS="running"
        READY_LAUNCH_RC=1
        cat > "$READY_DIR/.ready-result.json" <<JSON
{"stage":"ready","status":"running","artifacts":{"verdict":"pending"}}
JSON
        ;;
      ready_failed_resume_repolls)
        CURRENT_PHASE="ready"
        READY_STATUS="failed"
        READY_LAUNCH_RC=0
        cat > "$READY_DIR/.ready-result.json" <<JSON
{"stage":"ready","status":"failed","artifacts":{"verdict":"fail"}}
JSON
        ;;
      ready_failed_recheck_backoff_holds)
        CURRENT_PHASE="ready"
        READY_STATUS="failed"
        cat > "$READY_DIR/.ready-result.json" <<JSON
{"stage":"ready","status":"failed","artifacts":{"verdict":"fail"}}
JSON
        printf "%s\n" "1" > "$READY_DIR/.failed-ready-recheck-count"
        printf "%s\n" "current-head" > "$READY_DIR/.failed-ready-recheck-head"
        date +%s > "$READY_DIR/.failed-ready-recheck-last-at"
        ;;
      ready_failed_recheck_exhausted)
        CURRENT_PHASE="ready"
        READY_STATUS="failed"
        INVOKE_COUNT=2
        cat > "$READY_DIR/.ready-result.json" <<JSON
{"stage":"ready","status":"failed","finishedAt":"2026-08-27T09:52:37Z","failureReason":"Cross-PR revert guard blocked ready phase","artifacts":{"verdict":"fail"}}
JSON
        printf "%s\n" "4" > "$READY_DIR/.failed-ready-recheck-count"
        printf "%s\n" "current-head" > "$READY_DIR/.failed-ready-recheck-head"
        printf "%s\n" "0" > "$READY_DIR/.failed-ready-recheck-last-at"
        ;;
      ready_failed_recheck_new_head_resets)
        CURRENT_PHASE="ready"
        READY_STATUS="failed"
        READY_LAUNCH_RC=0
        cat > "$READY_DIR/.ready-result.json" <<JSON
{"stage":"ready","status":"failed","artifacts":{"verdict":"fail"}}
JSON
        printf "%s\n" "4" > "$READY_DIR/.failed-ready-recheck-count"
        printf "%s\n" "old-head" > "$READY_DIR/.failed-ready-recheck-head"
        printf "%s\n" "0" > "$READY_DIR/.failed-ready-recheck-last-at"
        : > "$READY_DIR/.failed-ready-recheck-exhausted"
        ;;
      ready_remediation_repolls_active)
        CURRENT_PHASE="ready"
        READY_STATUS="running"
        READY_LAUNCH_RC=5
        cat > "$READY_DIR/.ready-result.json" <<JSON
{"stage":"ready","status":"running","artifacts":{"verdict":"pending","remediationAttempts":1,"remediationLaunchHead":"old-head"}}
JSON
        printf "%s\n" "1" > "$READY_DIR/.retry-ready-remediation-count"
        printf "%s\n" "old-head" > "$READY_DIR/.retry-ready-remediation-head"
        printf "%s\n" "0" > "$READY_DIR/.retry-ready-remediation-last-at"
        ;;
      ready_remediation_inflight_same_head)
        CURRENT_PHASE="ready"
        READY_STATUS="running"
        cat > "$READY_DIR/.ready-result.json" <<JSON
{"stage":"ready","status":"running","artifacts":{"verdict":"fail","remediationAttempts":1,"remediationLaunchHead":"current-head"}}
JSON
        printf "%s\n" "1" > "$READY_DIR/.retry-ready-remediation-count"
        printf "%s\n" "current-head" > "$READY_DIR/.retry-ready-remediation-head"
        printf "%s\n" "0" > "$READY_DIR/.retry-ready-remediation-last-at"
        ;;
      pending_recheck_backoff_holds)
        CURRENT_PHASE="ready"
        READY_STATUS="running"
        READY_LAUNCH_RC=1
        cat > "$READY_DIR/.ready-result.json" <<JSON
{"stage":"ready","status":"running","artifacts":{"verdict":"pending"}}
JSON
        printf "%s\n" "1" > "$READY_DIR/.retry-pending-ready-recheck-count"
        printf "%s\n" "current-head" > "$READY_DIR/.retry-pending-ready-recheck-head"
        date +%s > "$READY_DIR/.retry-pending-ready-recheck-last-at"
        ;;
      pending_recheck_exhausted)
        CURRENT_PHASE="ready"
        READY_STATUS="running"
        READY_LAUNCH_RC=1
        INVOKE_COUNT=2
        cat > "$READY_DIR/.ready-result.json" <<JSON
{"stage":"ready","status":"running","failureReason":"launch refused by review gate","artifacts":{"verdict":"pending"}}
JSON
        printf "%s\n" "4" > "$READY_DIR/.retry-pending-ready-recheck-count"
        printf "%s\n" "current-head" > "$READY_DIR/.retry-pending-ready-recheck-head"
        printf "%s\n" "0" > "$READY_DIR/.retry-pending-ready-recheck-last-at"
        ;;
      pending_recheck_new_head_resets)
        CURRENT_PHASE="ready"
        READY_STATUS="running"
        READY_LAUNCH_RC=4
        cat > "$READY_DIR/.ready-result.json" <<JSON
{"stage":"ready","status":"running","artifacts":{"verdict":"pending"}}
JSON
        printf "%s\n" "4" > "$READY_DIR/.retry-pending-ready-recheck-count"
        printf "%s\n" "old-head" > "$READY_DIR/.retry-pending-ready-recheck-head"
        printf "%s\n" "0" > "$READY_DIR/.retry-pending-ready-recheck-last-at"
        printf "%s\n" "stale reason" > "$READY_DIR/.retry-pending-ready-recheck-exhausted"
        ;;
      pending_recheck_pass_clears_budget)
        CURRENT_PHASE="ready"
        READY_STATUS="running"
        READY_LAUNCH_RC=0
        cat > "$READY_DIR/.ready-result.json" <<JSON
{"stage":"ready","status":"running","artifacts":{"verdict":"pending"}}
JSON
        printf "%s\n" "2" > "$READY_DIR/.retry-pending-ready-recheck-count"
        printf "%s\n" "current-head" > "$READY_DIR/.retry-pending-ready-recheck-head"
        printf "%s\n" "0" > "$READY_DIR/.retry-pending-ready-recheck-last-at"
        ;;
      pending_recheck_terminal_review_gate)
        CURRENT_PHASE="ready"
        READY_STATUS="running"
        READY_LAUNCH_RC=1
        INVOKE_COUNT=2
        cat > "$READY_DIR/.ready-result.json" <<JSON
{"stage":"ready","status":"running","artifacts":{"verdict":"pending"}}
JSON
        cat > "$READY_DIR/.review-result.json" <<JSON
{"stage":"review","status":"completed","artifacts":{"type":"review","prNumber":321,"exitCode":"missing","verdict":"unknown","iterations":0,"blockerCount":1}}
JSON
        ;;
      # HOK-2963: typed challenge waits route to the orchestration handler
      # and never consume the generic pending-ready-recheck budget.
      challenge_pending_orchestrates)
        CURRENT_PHASE="ready"
        READY_STATUS="running"
        CHALLENGE_TASK="true"
        HANDLER_RC=0
        cat > "$READY_DIR/.ready-result.json" <<JSON
{"stage":"ready","status":"running","artifacts":{"verdict":"pending","pendingReason":"challenge-eval-pending","implementationReady":true}}
JSON
        printf "%s\n" "1" > "$READY_DIR/.retry-pending-ready-recheck-count"
        printf "%s\n" "current-head" > "$READY_DIR/.retry-pending-ready-recheck-head"
        printf "%s\n" "0" > "$READY_DIR/.retry-pending-ready-recheck-last-at"
        ;;
      challenge_pending_terminal)
        CURRENT_PHASE="ready"
        READY_STATUS="running"
        CHALLENGE_TASK="true"
        HANDLER_RC=1
        cat > "$READY_DIR/.ready-result.json" <<JSON
{"stage":"ready","status":"running","artifacts":{"verdict":"pending","pendingReason":"challenge-comparison-pending","implementationReady":true}}
JSON
        ;;
      challenge_pending_settled_reruns_ready)
        CURRENT_PHASE="ready"
        READY_STATUS="running"
        CHALLENGE_TASK="true"
        HANDLER_RC=2
        READY_LAUNCH_RC=0
        cat > "$READY_DIR/.ready-result.json" <<JSON
{"stage":"ready","status":"running","artifacts":{"verdict":"pending","pendingReason":"challenge-comparison-pending","implementationReady":true}}
JSON
        printf "%s\n" "2" > "$READY_DIR/.retry-pending-ready-recheck-count"
        printf "%s\n" "current-head" > "$READY_DIR/.retry-pending-ready-recheck-head"
        printf "%s\n" "0" > "$READY_DIR/.retry-pending-ready-recheck-last-at"
        ;;
      challenge_pending_compared_falls_back)
        CURRENT_PHASE="ready"
        READY_STATUS="running"
        CHALLENGE_TASK="true"
        HANDLER_RC=3
        READY_LAUNCH_RC=4
        cat > "$READY_DIR/.ready-result.json" <<JSON
{"stage":"ready","status":"running","artifacts":{"verdict":"pending","pendingReason":"challenge-eval-pending","implementationReady":true}}
JSON
        ;;
      challenge_pending_untyped_uses_generic)
        CURRENT_PHASE="ready"
        READY_STATUS="running"
        CHALLENGE_TASK="true"
        READY_LAUNCH_RC=4
        cat > "$READY_DIR/.ready-result.json" <<JSON
{"stage":"ready","status":"running","artifacts":{"verdict":"pending"}}
JSON
        ;;
      ready_conflict_merged)
        CURRENT_PHASE="ready"
        READY_STATUS="completed"
        PR_STATUS="MERGED"
        VALIDATE_MERGED="true"
        touch "$READY_DIR/.conflict-detected"
        printf "%s\n" "{\"status\":\"completed\",\"artifacts\":{\"verdict\":\"pass\"}}" > "$READY_DIR/.ready-result.json"
        ;;
      ready_closed_cleanup)
        CURRENT_PHASE="ready"
        PR_STATUS="CLOSED"
        ;;
      review_to_ready_pending)
        READY_LAUNCH_RC=4
        ;;
      merged_without_ready)
        PR_STATUS="MERGED"
        VALIDATE_MERGED="true"
        ;;
      merged_without_ready_twice)
        PR_STATUS="MERGED"
        VALIDATE_MERGED="true"
        INVOKE_COUNT=2
        ;;
      merged_after_ready)
        PR_STATUS="MERGED"
        VALIDATE_MERGED="true"
        printf "%s\n" "{\"status\":\"completed\",\"artifacts\":{\"verdict\":\"pass\"}}" > "$READY_DIR/.ready-result.json"
        printf "%s\n" "stale transient attention" > "$READY_DIR/.needs-attention"
        : > "$READY_DIR/.needs-attention-transient"
        printf "%s\n" "4" > "$READY_DIR/.transient-mergeability-count"
        ;;
      discovered_pr_from_coding)
        unset "PR_BY_ISSUE[$ISSUE]"
        PR=""
        FOUND_PR="321"
        CURRENT_PHASE="coding"
        ;;
      discovered_pr_missing_review_evidence)
        unset "PR_BY_ISSUE[$ISSUE]"
        PR=""
        FOUND_PR="321"
        CURRENT_PHASE="coding"
        rm -f "$FEATURE_DIR/.review-result.json"
        ;;
      discovered_pr_verdictless_stub)
        unset "PR_BY_ISSUE[$ISSUE]"
        PR=""
        FOUND_PR="321"
        CURRENT_PHASE="coding"
        cat > "$FEATURE_DIR/.review-result.json" <<JSON
{"stage":"review","status":"completed","artifacts":{"type":"review","prNumber":321}}
JSON
        ;;
      ready_stale_main_advanced)
        CURRENT_PHASE="ready"
        READY_STATUS="completed"
        MAIN_SHA_RETURN="new-main-sha"
        cat > "$READY_DIR/.ready-result.json" <<JSON
{"stage":"ready","status":"completed","artifacts":{"verdict":"pass","readyBaseSha":"old-main-sha"}}
JSON
        ;;
      ready_fresh_base_sha)
        CURRENT_PHASE="ready"
        READY_STATUS="completed"
        MAIN_SHA_RETURN="same-sha"
        cat > "$READY_DIR/.ready-result.json" <<JSON
{"stage":"ready","status":"completed","artifacts":{"verdict":"pass","readyBaseSha":"same-sha"}}
JSON
        ;;
      ready_empty_base_sha_treated_as_stale)
        CURRENT_PHASE="ready"
        READY_STATUS="completed"
        MAIN_SHA_RETURN="current-main-sha"
        cat > "$READY_DIR/.ready-result.json" <<JSON
{"stage":"ready","status":"completed","artifacts":{"verdict":"pass"}}
JSON
        ;;
      ready_main_sha_fetch_fails)
        CURRENT_PHASE="ready"
        READY_STATUS="completed"
        MAIN_SHA_RETURN=""
        cat > "$READY_DIR/.ready-result.json" <<JSON
{"stage":"ready","status":"completed","artifacts":{"verdict":"pass","readyBaseSha":"old-sha"}}
JSON
        ;;
      ready_merge_candidate_current_base)
        # HOK-2267: merge-candidate with current base should NOT re-run
        # ready checks — the PR is waiting in the merge lane for its turn to merge.
        CURRENT_PHASE="ready"
        READY_STATUS="completed"
        MAIN_SHA_RETURN="same-sha"
        MERGE_QUEUE_ON="true"
        QUEUE_STATE="merge-candidate"
        cat > "$READY_DIR/.ready-result.json" <<JSON
{"stage":"ready","status":"completed","artifacts":{"verdict":"pass","readyBaseSha":"same-sha","queueState":"merge-candidate"}}
JSON
        ;;
      ready_merge_candidate_main_advanced_not_selected)
        # When main has advanced and the PR is merge-candidate but NOT currently
        # selected, the controller marks it stale and waits (no ready re-run).
        CURRENT_PHASE="ready"
        READY_STATUS="completed"
        MAIN_SHA_RETURN="new-sha"
        MERGE_QUEUE_ON="true"
        QUEUE_STATE="merge-candidate"
        cat > "$READY_DIR/.ready-result.json" <<JSON
{"stage":"ready","status":"completed","artifacts":{"verdict":"pass","readyBaseSha":"old-sha","queueState":"merge-candidate"}}
JSON
        ;;
      *)
        echo "unknown case: $CASE_NAME" >&2
        exit 1
        ;;
    esac

    log() { LOG_OUTPUT+="$*\n"; }
    log_warn() { LOG_OUTPUT+="WARN:$*\n"; }
    log_error() { LOG_OUTPUT+="ERROR:$*\n"; }
    read_state_value() { printf "%s\n" "${1-}"; }
    set_window_attention_state() { ATTENTION_STATE="$2"; }
    handle_agent_error_recovery() { :; }
    cleanup_completed_task() { CLEANUP_COUNT=$((CLEANUP_COUNT + 1)); }
    execute() { :; }
    tmux() { return 1; }
    get_linear_issue_id() { printf "%s\n" "$ISSUE"; }
    should_update_linear_state() { return 1; }
    linear_set_state() { :; }
    get_task_meta() { :; }
    save_task_state() {
      printf -v SAVE_TASK_STATE_CALLS '%s%s\n' "$SAVE_TASK_STATE_CALLS" "$*"
    }
    _with_timeout() { shift; "$@"; }
    gh() { return 1; }
    is_challenge_task() { [[ "${CHALLENGE_TASK:-false}" == "true" ]]; }
    handle_challenge_pending_ready() {
      HANDLER_CALLS=$((HANDLER_CALLS + 1))
      return "${HANDLER_RC:-0}"
    }
    maybe_run_challenge_eval() { :; }
    maybe_run_challenge_comparison() { :; }
    dispatch_queued_children_for_parent() { :; }
    find_pr_for_branch() { printf "%s\n" "${FOUND_PR:-$PR}"; }
    get_task_phase() { printf "%s\n" "$CURRENT_PHASE"; }
    pr_state() { printf "%s\n" "$PR_STATUS"; }
    resolve_phase() { printf "%s\n" "$RESOLVED_PHASE"; }
    read_stage_status() {
      local feature_dir="$1" stage="$2"
      if [[ "$stage" == "review" ]]; then
        printf "%s\n" "$REVIEW_STATUS"
      elif [[ "$stage" == "ready" && "$feature_dir" == "$READY_DIR" ]]; then
        printf "%s\n" "$READY_STATUS"
      else
        printf "\n"
      fi
    }
    write_stage_result() {
      printf -v WRITE_STAGE_CALLS '%s%s\n' \
        "$WRITE_STAGE_CALLS" \
        "${1-}|${2-}|${3-}|${4-}|${5-}|${6-}|${7-}"
    }
    set_task_phase() {
      CURRENT_PHASE="$2"
      SET_PHASE_TO="$2"
    }
    launch_ready_phase() {
      READY_LAUNCH_COUNT=$((READY_LAUNCH_COUNT + 1))
      READY_LAUNCH_ARGS="$*"
      return "$READY_LAUNCH_RC"
    }
    launch_review_phase() {
      REVIEW_LAUNCH_COUNT=$((REVIEW_LAUNCH_COUNT + 1))
      REVIEW_LAUNCH_ARGS="$*"
      return 0
    }
    read_phase_config() { printf "\n"; }
    resolve_phase_model() { printf "%s\n" "${2:-$3}"; }
    check_stage_aborted() { [[ "$ABORTED" == "true" ]]; }
    restore_review_task_window() {
      RESTORE_COUNT=$((RESTORE_COUNT + 1))
      [[ "$RESTORE_SHOULD_FAIL" != "true" ]]
    }
    validate_pr_merge() { [[ "$VALIDATE_MERGED" == "true" ]]; }
    write_ready_attention_file() {
      printf -v WRITE_READY_ATTENTION_CALLS '%s%s\n' "$WRITE_READY_ATTENTION_CALLS" "$*"
    }
    ready_state_dir() { printf "%s\n" "$READY_DIR"; }
    ready_conflict_launch_head() {
      if [[ "$CASE_NAME" == "ready_conflict_rerun" ]]; then
        printf "%s\n" "old-head"
      fi
    }
    git() {
      if [[ "${1:-}" == "-C" && "${3:-}" == "rev-parse" && "${4:-}" == "HEAD" ]]; then
        printf "%s\n" "current-head"
        return 0
      fi
      return 1
    }
    get_main_head_sha() { printf "%s\n" "$MAIN_SHA_RETURN"; }
    merge_queue_enabled() { [[ "$MERGE_QUEUE_ON" == "true" ]]; }
    ready_queue_state() { printf "%s\n" "$QUEUE_STATE"; }
    mark_ready_stale() { :; }
    ready_candidate_selected() { return 1; }
    closed_pr_resource_policy() { printf "%s\n" "full-cleanup"; }
    wavemill_release_terminal_pane() { return 0; }
    get_challenge_sibling_pr() { :; }
    check_challenge_sibling_merged() { return 1; }
    transient_error_recovery_pending() { return 1; }
    phase_should_remain_active_without_pr() { return 1; }
    codex_has_pending_approval() { return 1; }

    for ((i = 0; i < INVOKE_COUNT; i++)); do
      monitor_issue_state "$ISSUE"
    done

    stage_summary=$(printf "%s" "$WRITE_STAGE_CALLS" | tr "\n" ";")
    bypass_warn_count=$(printf "%s" "$LOG_OUTPUT" | grep -c "was merged before ready checks passed" || true)
    save_task_state_status=""
    if printf "%s" "$SAVE_TASK_STATE_CALLS" | grep -q " merged "; then
      save_task_state_status="merged"
    fi
    needs_attention="absent"
    [[ -f "$READY_DIR/.needs-attention" ]] && needs_attention="present"
    transient_attention="absent"
    [[ -f "$READY_DIR/.needs-attention-transient" ]] && transient_attention="present"
    transient_count="$(cat "$READY_DIR/.transient-mergeability-count" 2>/dev/null || echo "")"
    printf "phase=%s\nattention=%s\nready_launches=%s\nreview_launches=%s\nrestore_calls=%s\ncleanup_count=%s\nactive_count=%s\nwrite_stage=%s\nready_args=%s\nreview_args=%s\nattention_calls=%s\nbypass_warn_count=%s\nsave_task_state_status=%s\nneeds_attention=%s\ntransient_attention=%s\ntransient_count=%s\nlogs=%s\n" \
      "$CURRENT_PHASE" \
      "$ATTENTION_STATE" \
      "$READY_LAUNCH_COUNT" \
      "$REVIEW_LAUNCH_COUNT" \
      "$RESTORE_COUNT" \
      "$CLEANUP_COUNT" \
      "$active_count" \
      "$stage_summary" \
      "${READY_LAUNCH_ARGS:-}" \
      "${REVIEW_LAUNCH_ARGS:-}" \
      "$WRITE_READY_ATTENTION_CALLS" \
      "$bypass_warn_count" \
      "$save_task_state_status" \
      "$needs_attention" \
      "$transient_attention" \
      "$transient_count" \
      "$LOG_OUTPUT"
    recheck_count="$(cat "$READY_DIR/.failed-ready-recheck-count" 2>/dev/null || echo "")"
    recheck_sentinel="absent"
    [[ -f "$READY_DIR/.failed-ready-recheck-exhausted" ]] && recheck_sentinel="present"
    exhausted_log_count="$(printf "%s" "$LOG_OUTPUT" | grep -o "re-checks exhausted for PR" | grep -c . || true)"
    printf "recheck_count=%s\nrecheck_sentinel=%s\nexhausted_log_count=%s\n" \
      "$recheck_count" "$recheck_sentinel" "$exhausted_log_count"
    pending_count="$(cat "$READY_DIR/.retry-pending-ready-recheck-count" 2>/dev/null || echo "")"
    pending_sentinel="absent"
    [[ -f "$READY_DIR/.retry-pending-ready-recheck-exhausted" ]] && pending_sentinel="present"
    pending_exhausted_log_count="$(printf "%s" "$LOG_OUTPUT" | grep -o "Pending-ready re-checks exhausted" | grep -c . || true)"
    printf "pending_count=%s\npending_sentinel=%s\npending_exhausted_log_count=%s\n" \
      "$pending_count" "$pending_sentinel" "$pending_exhausted_log_count"
    printf "handler_calls=%s\n" "$HANDLER_CALLS"
  '
}

echo "=== Monitor Ready Transition ==="

review_to_ready_output="$(run_monitor_case review_to_ready)"
check_contains "review with open PR transitions to ready" "$review_to_ready_output" "phase=ready"
check_contains "review with open PR launches ready checks" "$review_to_ready_output" "ready_launches=1"
check_contains "review with open PR does not only restore review window" "$review_to_ready_output" "restore_calls=0"
check_contains "review with open PR records completed review stage" "$review_to_ready_output" "|review|completed|"

ready_conflict_output="$(run_monitor_case ready_conflict_rerun)"
check_contains "ready conflict rerun keeps task in ready" "$ready_conflict_output" "phase=ready"
check_contains "ready conflict rerun launches ready checks again" "$ready_conflict_output" "ready_launches=1"
check_contains "ready conflict rerun leaves attention on task" "$ready_conflict_output" "attention=needs-user"

ready_conflict_reported_output="$(run_monitor_case ready_conflict_attention_already_reported)"
check_contains "reported conflict keeps task in ready" "$ready_conflict_reported_output" "phase=ready"
check_contains "reported conflict does not relaunch ready" "$ready_conflict_reported_output" "ready_launches=0"
check_contains "reported conflict leaves attention on task" "$ready_conflict_reported_output" "attention=needs-user"

ready_conflict_different_head_output="$(run_monitor_case ready_conflict_attention_different_head)"
check_contains "different-head conflict relaunches ready" "$ready_conflict_different_head_output" "ready_launches=1"
check_contains "different-head conflict leaves attention on task" "$ready_conflict_different_head_output" "attention=needs-user"

ready_pending_repolls_ci_output="$(run_monitor_case ready_pending_repolls_ci)"
check_contains "pending ready re-polls CI" "$ready_pending_repolls_ci_output" "ready_launches=1"
check_contains "pending ready stays in ready phase" "$ready_pending_repolls_ci_output" "phase=ready"
check_contains "pending ready does not flag user" "$ready_pending_repolls_ci_output" "attention=clear"
check_contains "pending ready holds slot active" "$ready_pending_repolls_ci_output" "active_count=1"

ready_pending_transitions_to_pass_output="$(run_monitor_case ready_pending_transitions_to_pass)"
check_contains "pending ready passes on re-poll" "$ready_pending_transitions_to_pass_output" "ready_launches=1"
check_contains "pending ready pass keeps attention clear" "$ready_pending_transitions_to_pass_output" "attention=clear"
check_contains "pending ready pass holds slot active" "$ready_pending_transitions_to_pass_output" "active_count=1"
check_contains "pending ready pass logs status completion once" "$ready_pending_transitions_to_pass_output" "logs=status HOK-1249 → Ready checks completed for PR #321"

ready_pending_failure_needs_user_output="$(run_monitor_case ready_pending_failure_needs_user)"
check_contains "pending ready failure relaunches once" "$ready_pending_failure_needs_user_output" "ready_launches=1"
check_contains "pending ready failure needs user" "$ready_pending_failure_needs_user_output" "attention=needs-user"

ready_failed_resume_repolls_output="$(run_monitor_case ready_failed_resume_repolls)"
check_contains "failed ready resumes by re-running checks" "$ready_failed_resume_repolls_output" "ready_launches=1"
check_contains "failed ready re-run logs bounded attempt" "$ready_failed_resume_repolls_output" "Re-running failed ready checks for PR #321 (attempt 1/4)"
check_contains "failed ready pass clears attention" "$ready_failed_resume_repolls_output" "attention=clear"
check_contains "failed ready pass holds slot active" "$ready_failed_resume_repolls_output" "active_count=1"

ready_failed_recheck_backoff_output="$(run_monitor_case ready_failed_recheck_backoff_holds)"
check_contains "recheck backoff skips relaunch" "$ready_failed_recheck_backoff_output" "ready_launches=0"
check_contains "recheck backoff holds slot active" "$ready_failed_recheck_backoff_output" "active_count=1"
check_contains "recheck backoff leaves attention untouched" "$ready_failed_recheck_backoff_output" $'attention=\nready_launches=0'

ready_failed_recheck_exhausted_output="$(run_monitor_case ready_failed_recheck_exhausted)"
check_contains "recheck exhaustion stops relaunching" "$ready_failed_recheck_exhausted_output" "ready_launches=0"
check_contains "recheck exhaustion flags user" "$ready_failed_recheck_exhausted_output" "attention=needs-user"
check_contains "recheck exhaustion logs terminal status once" "$ready_failed_recheck_exhausted_output" "exhausted_log_count=1"
check_contains "recheck exhaustion writes sentinel" "$ready_failed_recheck_exhausted_output" "recheck_sentinel=present"
check_contains "recheck exhaustion names failing gate" "$ready_failed_recheck_exhausted_output" "Cross-PR revert guard blocked ready phase"

ready_failed_recheck_new_head_output="$(run_monitor_case ready_failed_recheck_new_head_resets)"
check_contains "new commit re-enables failed-ready recheck" "$ready_failed_recheck_new_head_output" "ready_launches=1"
check_contains "new commit resets attempt numbering" "$ready_failed_recheck_new_head_output" "(attempt 1/4)"
check_contains "new commit clears exhausted sentinel" "$ready_failed_recheck_new_head_output" "recheck_sentinel=absent"
check_contains "new head recheck pass clears attention" "$ready_failed_recheck_new_head_output" "attention=clear"

ready_remediation_repolls_active_output="$(run_monitor_case ready_remediation_repolls_active)"
check_contains "ready remediation rc 5 relaunches once" "$ready_remediation_repolls_active_output" "ready_launches=1"
check_contains "ready remediation rc 5 clears attention" "$ready_remediation_repolls_active_output" "attention=clear"
check_contains "ready remediation rc 5 holds slot active" "$ready_remediation_repolls_active_output" "active_count=1"

ready_remediation_inflight_same_head_output="$(run_monitor_case ready_remediation_inflight_same_head)"
check_contains "ready remediation in-flight keeps task active" "$ready_remediation_inflight_same_head_output" "active_count=1"
check_contains "ready remediation in-flight does not relaunch ready" "$ready_remediation_inflight_same_head_output" "ready_launches=0"
check_contains "ready remediation in-flight clears attention" "$ready_remediation_inflight_same_head_output" "attention=clear"

pending_recheck_backoff_output="$(run_monitor_case pending_recheck_backoff_holds)"
check_contains "pending recheck backoff skips relaunch" "$pending_recheck_backoff_output" "ready_launches=0"
check_contains "pending recheck backoff holds slot active" "$pending_recheck_backoff_output" "active_count=1"

pending_recheck_exhausted_output="$(run_monitor_case pending_recheck_exhausted)"
check_contains "pending recheck exhaustion stops relaunching" "$pending_recheck_exhausted_output" "ready_launches=0"
check_contains "pending recheck exhaustion flags user" "$pending_recheck_exhausted_output" "attention=needs-user"
check_contains "pending recheck exhaustion logs terminal status once" "$pending_recheck_exhausted_output" "pending_exhausted_log_count=1"
check_contains "pending recheck exhaustion writes sentinel" "$pending_recheck_exhausted_output" "pending_sentinel=present"
check_contains "pending recheck exhaustion names the failing reason" "$pending_recheck_exhausted_output" "launch refused by review gate"

pending_recheck_new_head_output="$(run_monitor_case pending_recheck_new_head_resets)"
check_contains "new commit re-enables pending recheck" "$pending_recheck_new_head_output" "ready_launches=1"
check_contains "new commit clears pending exhausted sentinel" "$pending_recheck_new_head_output" "pending_sentinel=absent"

pending_recheck_pass_output="$(run_monitor_case pending_recheck_pass_clears_budget)"
check_contains "ready pass relaunches pending recheck once" "$pending_recheck_pass_output" "ready_launches=1"
check_contains "ready pass clears pending recheck budget" "$pending_recheck_pass_output" $'pending_count=\npending_sentinel=absent'

pending_recheck_terminal_output="$(run_monitor_case pending_recheck_terminal_review_gate)"
check_contains "unacceptable review artifact launches once" "$pending_recheck_terminal_output" "ready_launches=1"
check_contains "verdictless review artifact does not terminalize pending recheck" "$pending_recheck_terminal_output" "pending_sentinel=absent"
check_not_contains "verdictless review artifact is recoverable" "$pending_recheck_terminal_output" "refused by review gate"
check_contains "unacceptable review artifact flags user" "$pending_recheck_terminal_output" "attention=needs-user"

echo "=== Challenge Typed Pending Routing (HOK-2963) ==="

# REQ-F1/F5: a typed challenge wait routes to the orchestration handler,
# leaves the generic pending-ready budget untouched, and stays active.
challenge_orchestrates_output="$(run_monitor_case challenge_pending_orchestrates)"
check_contains "challenge wait invokes orchestration handler" "$challenge_orchestrates_output" "handler_calls=1"
check_contains "challenge wait does not relaunch ready" "$challenge_orchestrates_output" "ready_launches=0"
check_contains "challenge wait leaves generic budget untouched" "$challenge_orchestrates_output" "pending_count=1"
check_contains "challenge wait keeps attention clear" "$challenge_orchestrates_output" "attention=clear"
check_contains "challenge wait holds slot active" "$challenge_orchestrates_output" "active_count=1"

challenge_terminal_output="$(run_monitor_case challenge_pending_terminal)"
check_contains "challenge terminal state invokes handler" "$challenge_terminal_output" "handler_calls=1"
check_contains "challenge terminal state flags user" "$challenge_terminal_output" "attention=needs-user"
check_contains "challenge terminal state does not relaunch ready" "$challenge_terminal_output" "ready_launches=0"

# REQ-F3/F4: a settled comparison triggers exactly one Ready re-run outside
# the generic budget so the fresh record can complete Ready.
challenge_settled_output="$(run_monitor_case challenge_pending_settled_reruns_ready)"
check_contains "settled comparison reruns ready once" "$challenge_settled_output" "ready_launches=1"
check_contains "settled comparison completes ready" "$challenge_settled_output" "Ready checks completed after challenge comparison (PR #321)"
check_contains "settled comparison keeps attention clear" "$challenge_settled_output" "attention=clear"
check_contains "settled comparison does not increment generic budget" "$challenge_settled_output" "pending_count=2"

# A compared-but-stale pair has no launchable work: it falls back to the
# bounded generic pending path, which consumes its own budget as before.
challenge_fallback_output="$(run_monitor_case challenge_pending_compared_falls_back)"
check_contains "compared fallback invokes handler" "$challenge_fallback_output" "handler_calls=1"
check_contains "compared fallback relaunches ready via generic path" "$challenge_fallback_output" "ready_launches=1"
check_contains "compared fallback clears generic budget after relaunch" "$challenge_fallback_output" "pending_count=
"

# An untyped pending on a challenge task keeps the generic CI re-poll path.
challenge_untyped_output="$(run_monitor_case challenge_pending_untyped_uses_generic)"
check_contains "untyped challenge pending skips handler" "$challenge_untyped_output" "handler_calls=0"
check_contains "untyped challenge pending re-polls via generic path" "$challenge_untyped_output" "ready_launches=1"

ready_conflict_merged_output="$(run_monitor_case ready_conflict_merged)"
check_contains "ready merge wins over conflict rerun" "$ready_conflict_merged_output" "cleanup_count=1"
check_contains "ready merge does not relaunch ready" "$ready_conflict_merged_output" "ready_launches=0"
check_contains "ready merge clears attention" "$ready_conflict_merged_output" "attention=clear"

ready_closed_cleanup_output="$(run_monitor_case ready_closed_cleanup)"
check_contains "ready closed PR cleans up" "$ready_closed_cleanup_output" "cleanup_count=1"
check_contains "ready closed PR clears attention" "$ready_closed_cleanup_output" "attention=clear"
check_contains "ready closed PR avoids ready relaunch" "$ready_closed_cleanup_output" "ready_launches=0"

review_to_ready_pending_output="$(run_monitor_case review_to_ready_pending)"
check_contains "pending ready checks keep task in ready" "$review_to_ready_pending_output" "phase=ready"
check_contains "pending ready checks clear attention" "$review_to_ready_pending_output" "attention=clear"
check_contains "pending ready checks count as active work" "$review_to_ready_pending_output" "active_count=1"

merged_without_ready_output="$(run_monitor_case merged_without_ready)"
check_contains "merged PR without ready pass clears attention" "$merged_without_ready_output" "attention=clear"
check_contains "merged PR without ready pass is cleaned up" "$merged_without_ready_output" "cleanup_count=1"
check_contains "merged PR without ready pass writes attention" "$merged_without_ready_output" "Release Readiness Check passed"
check_contains "merged PR without ready pass does not persist merged state for review hold" "$merged_without_ready_output" "save_task_state_status="

merged_without_ready_twice_output="$(run_monitor_case merged_without_ready_twice)"
check_contains "merged-before-ready warning logs only once across ticks" "$merged_without_ready_twice_output" "bypass_warn_count=1"
check_contains "merged-before-ready clears attention after repeat tick" "$merged_without_ready_twice_output" "attention=clear"
check_contains "merged-before-ready does not persist merged task status on repeat tick" "$merged_without_ready_twice_output" "save_task_state_status="

merged_after_ready_output="$(run_monitor_case merged_after_ready)"
check_contains "merged PR after ready pass can clean up" "$merged_after_ready_output" "cleanup_count=1"
check_contains "merged PR after ready pass clears stale attention" "$merged_after_ready_output" "needs_attention=absent"
check_contains "merged PR after ready pass clears transient marker" "$merged_after_ready_output" "transient_attention=absent"
check_contains "merged PR after ready pass clears transient counter" "$merged_after_ready_output" "transient_count="

discovered_pr_from_coding_output="$(run_monitor_case discovered_pr_from_coding)"
check_contains "newly discovered PR moves stale coding phase to ready" "$discovered_pr_from_coding_output" "phase=ready"
check_contains "newly discovered PR launches ready immediately" "$discovered_pr_from_coding_output" "ready_launches=1"
check_contains "newly discovered PR does not restore review window first" "$discovered_pr_from_coding_output" "restore_calls=0"

discovered_pr_missing_review_output="$(run_monitor_case discovered_pr_missing_review_evidence)"
check_contains "PR without review artifact stays in review" "$discovered_pr_missing_review_output" "phase=review"
check_contains "PR without review artifact launches review" "$discovered_pr_missing_review_output" "review_launches=1"
check_contains "PR without review artifact does not launch ready" "$discovered_pr_missing_review_output" "ready_launches=0"
check_contains "PR without review artifact records running review" "$discovered_pr_missing_review_output" "|review|running|"
check_contains "PR without review artifact records missing evidence" "$discovered_pr_missing_review_output" '"missingReviewEvidence":true'

discovered_pr_stub_output="$(run_monitor_case discovered_pr_verdictless_stub)"
check_contains "PR with verdictless stub stays in review" "$discovered_pr_stub_output" "phase=review"
check_contains "PR with verdictless stub launches review" "$discovered_pr_stub_output" "review_launches=1"
check_contains "PR with verdictless stub does not launch ready" "$discovered_pr_stub_output" "ready_launches=0"
check_contains "PR with verdictless stub marks missing evidence" "$discovered_pr_stub_output" '"missingReviewEvidence":true'

ready_stale_main_advanced_output="$(run_monitor_case ready_stale_main_advanced)"
check_contains "stale ready (main advanced) re-runs ready checks" "$ready_stale_main_advanced_output" "ready_launches=1"
check_contains "stale ready (main advanced) clears attention on pass" "$ready_stale_main_advanced_output" "attention=clear"
check_contains "stale ready (main advanced) holds slot active" "$ready_stale_main_advanced_output" "active_count=1"

ready_fresh_base_sha_output="$(run_monitor_case ready_fresh_base_sha)"
check_contains "fresh base SHA does not re-run ready" "$ready_fresh_base_sha_output" "ready_launches=0"
check_contains "fresh base SHA keeps task active" "$ready_fresh_base_sha_output" "active_count=1"
check_contains "fresh base SHA clears attention" "$ready_fresh_base_sha_output" "attention=clear"

ready_empty_base_sha_output="$(run_monitor_case ready_empty_base_sha_treated_as_stale)"
check_contains "empty baseSha (legacy record) treated as stale" "$ready_empty_base_sha_output" "ready_launches=1"

ready_main_sha_fetch_fails_output="$(run_monitor_case ready_main_sha_fetch_fails)"
check_contains "main SHA fetch failure skips re-check" "$ready_main_sha_fetch_fails_output" "ready_launches=0"
check_contains "main SHA fetch failure keeps task active" "$ready_main_sha_fetch_fails_output" "active_count=1"

# HOK-2267: merge-candidate with current base must not re-run checks
ready_merge_candidate_current_base_output="$(run_monitor_case ready_merge_candidate_current_base)"
check_contains "merge-candidate current-base does not re-run ready" "$ready_merge_candidate_current_base_output" "ready_launches=0"
check_contains "merge-candidate current-base keeps task active" "$ready_merge_candidate_current_base_output" "active_count=1"
check_contains "merge-candidate current-base clears attention" "$ready_merge_candidate_current_base_output" "attention=clear"
check_contains "merge-candidate current-base logs saved-verdict status" "$ready_merge_candidate_current_base_output" "live CI unverified, saved verdict only"

ready_merge_candidate_main_advanced_not_selected_output="$(run_monitor_case ready_merge_candidate_main_advanced_not_selected)"
check_contains "merge-candidate main-advanced not-selected does not re-run ready" "$ready_merge_candidate_main_advanced_not_selected_output" "ready_launches=0"
check_contains "merge-candidate main-advanced not-selected keeps task active" "$ready_merge_candidate_main_advanced_not_selected_output" "active_count=1"
check_contains "merge-candidate main-advanced not-selected clears attention" "$ready_merge_candidate_main_advanced_not_selected_output" "attention=clear"

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
