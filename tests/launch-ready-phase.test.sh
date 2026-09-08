#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"
COMMON_SCRIPT="$REPO_DIR/shared/lib/wavemill-common.sh"

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
    function brace_delta(line, opened, closed) {
      opened = gsub(/\{/, "{", line)
      closed = gsub(/\}/, "}", line)
      return opened - closed
    }

    $0 ~ "^" name "\\(\\) \\{" {
      capture=1
      depth=0
    }
    capture {
      print
      depth += brace_delta($0)
      if (depth == 0) {
        exit
      }
    }
  ' "$source_file"
}

LAUNCH_FUNC_FILE="$TEST_TMP/launch_ready_phase.sh"
cat "$REPO_DIR/shared/lib/transient-marker.sh" > "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "ready_conflict_attention_head" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "record_ready_conflict_attention" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "clear_ready_conflict_attention" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "transient_mergeability_count" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "increment_transient_mergeability_count" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "clear_transient_mergeability_state" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "write_ready_attention_file" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "_write_cross_pr_diagnostic" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "write_cross_pr_guard_ready_result" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "clear_cross_pr_guard_ready_evidence" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "cross_pr_revert_gate_allows_merge" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "write_transient_ready_attention_file" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "failed_ready_recheck_count" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "clear_failed_ready_recheck_state" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "failed_ready_recheck_reset_if_new_head" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "increment_failed_ready_recheck_count" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "failed_ready_recheck_backoff_seconds" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "failed_ready_recheck_due" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "ready_failure_reason" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "record_failed_ready_recheck_observation" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "failed_ready_recheck_identical_streak" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "mark_failed_ready_recheck_exhausted" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "failed_ready_recheck_gate" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "log_ready_failure_result" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "log_ready_unparseable_result" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "ready_failure_is_actionable_for_remediation" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "ready_failed_check_summary" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "review_result_passes_ready_gate" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "review_result_has_final_evidence" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "review_result_missing_final_evidence" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "review_result_infra_failure" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "review_result_failure_category" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "review_result_review_head_sha" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "review_infra_recovery_category_label" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "review_infra_recovery_next_action" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "relaunch_review_after_infra_recovery" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "review_result_summary" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "review_artifacts_with_pr_number" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "strip_ready_label_if_review_not_passed" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "set_ready_pass_labels" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "post_pr_reconciliation_config_json" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "post_pr_reconciliation_enabled" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "reconciliation_feature_task_packet" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "reconciliation_capsule_refresh" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "reconciliation_project_prompt" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "reconciliation_reset_retry_if_new_fingerprint" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "reconciliation_record_attempt" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "reconciliation_review_invalidated_by_commit" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "reconciliation_mark_review_stale" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "_launch_ready_remediation_attempt" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "launch_ready_watchdog_remediation" >> "$LAUNCH_FUNC_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "launch_ready_phase" >> "$LAUNCH_FUNC_FILE"

if [[ ! -s "$LAUNCH_FUNC_FILE" ]]; then
  echo "Could not extract launch_ready_phase()"
  exit 1
fi

run_launch_case() {
  local test_case="$1"
  local case_dir="$TEST_TMP/$test_case"
  # Each invocation starts from a clean state dir: the bounded-retry backoff
  # (HOK-2924) would otherwise hold a re-run of the same case name because a
  # previous invocation's attempt timestamp is still inside the window.
  rm -rf "$case_dir"
  mkdir -p "$case_dir"

  CASE_DIR="$case_dir" LAUNCH_FUNC_FILE="$LAUNCH_FUNC_FILE" COMMON_SCRIPT="$COMMON_SCRIPT" TEST_CASE="$test_case" bash -lc '
    set -euo pipefail
    source "$COMMON_SCRIPT"
    source "$LAUNCH_FUNC_FILE"

    SESSION="ready-phase-test-$TEST_CASE"
    TOOLS_DIR="$CASE_DIR/tools"
    REPO_DIR="$CASE_DIR/repo"
    AGENT_CMD="codex"
    READY_TRANSIENT_MAX_ATTEMPTS=6
    mkdir -p "$TOOLS_DIR" "$REPO_DIR"

    STATE_DIR="$CASE_DIR/feature/ready"
    WT_DIR="$CASE_DIR/worktree"
    mkdir -p "$STATE_DIR" "$WT_DIR"
    cat > "$STATE_DIR/.review-result.json" <<EOF
{"stage":"review","status":"completed","artifacts":{"type":"review","prNumber":304,"exitCode":0,"verdict":"ready","iterations":1,"blockerCount":0,"warningCount":0}}
EOF
    DEBUG_FILE="$(ready_debug_log_file)"
    rm -f "$DEBUG_FILE"
    trap '\''rm -f "$DEBUG_FILE"'\'' EXIT

    case "$TEST_CASE" in
      conflict_persists_after_remediation)
        touch "$STATE_DIR/.conflict-detected"
        ;;
      pass_after_remediation)
        touch "$STATE_DIR/.conflict-detected" "$STATE_DIR/.conflict-attention-reported"
        printf "%s\n" "abc123" > "$STATE_DIR/.conflict-attention-head"
        printf "%s\n" "stale attention" > "$STATE_DIR/.needs-attention"
        ;;
      pass_clears_recheck)
        printf "%s\n" "3" > "$STATE_DIR/.failed-ready-recheck-count"
        printf "%s\n" "abc123" > "$STATE_DIR/.failed-ready-recheck-head"
        printf "%s\n" "100" > "$STATE_DIR/.failed-ready-recheck-last-at"
        printf "%s\n" "{\"finishedAt\":\"t1\",\"reason\":\"guard blocked\",\"streak\":2}" > "$STATE_DIR/.failed-ready-recheck-reason.json"
        : > "$STATE_DIR/.failed-ready-recheck-exhausted"
        ;;
      unknown_capped)
        printf "%s\n" "6" > "$STATE_DIR/.transient-mergeability-count"
        ;;
      remediation_backoff_hold)
        printf "%s\n" "1" > "$STATE_DIR/.retry-ready-remediation-count"
        printf "%s\n" "abc123" > "$STATE_DIR/.retry-ready-remediation-head"
        printf "%s\n" "$(date +%s)" > "$STATE_DIR/.retry-ready-remediation-last-at"
        ;;
      remediation_head_reset)
        printf "%s\n" "2" > "$STATE_DIR/.retry-ready-remediation-count"
        printf "%s\n" "oldsha" > "$STATE_DIR/.retry-ready-remediation-head"
        printf "%s\n" "$(date +%s)" > "$STATE_DIR/.retry-ready-remediation-last-at"
        ;;
      clean_after_unknown)
        printf "%s\n" "stale transient attention" > "$STATE_DIR/.needs-attention"
        : > "$STATE_DIR/.needs-attention-transient"
        printf "%s\n" "3" > "$STATE_DIR/.transient-mergeability-count"
        ;;
      review_tool_error_gate)
        cat > "$STATE_DIR/.review-result.json" <<EOF
{"stage":"review","status":"completed","artifacts":{"type":"review","prNumber":304,"exitCode":2,"verdict":"error","iterations":2,"blockerCount":0,"warningCount":0,"reviewToolError":"provider failed"}}
EOF
        ;;
      infra_retry_healthy)
        cat > "$STATE_DIR/.review-result.json" <<EOF
{"stage":"review","status":"completed","agent":"native-openrouter","model":"qwen-3-coder","artifacts":{"type":"review","prNumber":304,"exitCode":0,"verdict":"not_ready","iterations":1,"blockerCount":1,"warningCount":0,"failureCategory":"native-runtime-unavailable"}}
EOF
        ;;
      infra_retry_unhealthy)
        cat > "$STATE_DIR/.review-result.json" <<EOF
{"stage":"review","status":"completed","agent":"native-openrouter","model":"qwen-3-coder","artifacts":{"type":"review","prNumber":304,"exitCode":0,"verdict":"not_ready","iterations":1,"blockerCount":1,"warningCount":0,"failureCategory":"native-runtime-unavailable"}}
EOF
        ;;
      infra_retry_capped)
        printf "%s\n" "2" > "$STATE_DIR/.retry-review-infra-recovery-count"
        printf "%s\n" "abc123:native-runtime-unavailable" > "$STATE_DIR/.retry-review-infra-recovery-head"
        cat > "$STATE_DIR/.review-result.json" <<EOF
{"stage":"review","status":"completed","agent":"native-openrouter","model":"qwen-3-coder","artifacts":{"type":"review","prNumber":304,"exitCode":0,"verdict":"not_ready","iterations":1,"blockerCount":1,"warningCount":0,"failureCategory":"native-runtime-unavailable"}}
EOF
        ;;
      # HOK-2964: native-context-window-exceeded enters bounded infra
      # recovery instead of terminal code-defect handling (REQ-F1).
      infra_retry_context_window)
        cat > "$STATE_DIR/.review-result.json" <<EOF
{"stage":"review","status":"completed","agent":"native-openrouter","model":"qwen-3-coder","artifacts":{"type":"review","prNumber":304,"exitCode":0,"verdict":"not_ready","iterations":1,"blockerCount":1,"warningCount":0,"failureCategory":"native-context-window-exceeded","reviewHeadSha":"stalehead"}}
EOF
        ;;
      # HOK-2964: a new head at the same failure category resets the bounded
      # budget instead of inheriting the exhausted attempt count (REQ-F2/F4).
      infra_retry_context_window_scope_refreshed)
        printf "%s\n" "2" > "$STATE_DIR/.retry-review-infra-recovery-count"
        printf "%s\n" "stalehead:native-context-window-exceeded" > "$STATE_DIR/.retry-review-infra-recovery-head"
        cat > "$STATE_DIR/.review-result.json" <<EOF
{"stage":"review","status":"completed","agent":"native-openrouter","model":"qwen-3-coder","artifacts":{"type":"review","prNumber":304,"exitCode":0,"verdict":"not_ready","iterations":1,"blockerCount":1,"warningCount":0,"failureCategory":"native-context-window-exceeded","reviewHeadSha":"stalehead"}}
EOF
        ;;
      # HOK-2964: an unchanged context-window overflow at the same head
      # eventually exhausts with an actionable capacity diagnostic (REQ-F3).
      infra_retry_context_window_exhausted)
        printf "%s\n" "2" > "$STATE_DIR/.retry-review-infra-recovery-count"
        printf "%s\n" "abc123:native-context-window-exceeded" > "$STATE_DIR/.retry-review-infra-recovery-head"
        cat > "$STATE_DIR/.review-result.json" <<EOF
{"stage":"review","status":"completed","agent":"native-openrouter","model":"qwen-3-coder","artifacts":{"type":"review","prNumber":304,"exitCode":0,"verdict":"not_ready","iterations":1,"blockerCount":1,"warningCount":0,"failureCategory":"native-context-window-exceeded","reviewHeadSha":"abc123"}}
EOF
        ;;
      # HOK-2964 REQ-F5: a typed provider credit failure recovers within the
      # bounded budget once relaunched (retryable, not a blind loop).
      infra_retry_provider_credit_exhausted)
        cat > "$STATE_DIR/.review-result.json" <<EOF
{"stage":"review","status":"completed","agent":"native-openrouter","model":"qwen-3-coder","artifacts":{"type":"review","prNumber":304,"exitCode":0,"verdict":"not_ready","iterations":1,"blockerCount":1,"warningCount":0,"failureCategory":"provider-credit-exhausted"}}
EOF
        ;;
      # HOK-2964 REQ-F6: exhaustion of a provider-capacity recovery keeps
      # Ready blocked and leaves an actionable terminal diagnostic.
      infra_retry_provider_credit_exhausted_capped)
        printf "%s\n" "2" > "$STATE_DIR/.retry-review-infra-recovery-count"
        printf "%s\n" "abc123:provider-credit-exhausted" > "$STATE_DIR/.retry-review-infra-recovery-head"
        cat > "$STATE_DIR/.review-result.json" <<EOF
{"stage":"review","status":"completed","agent":"native-openrouter","model":"qwen-3-coder","artifacts":{"type":"review","prNumber":304,"exitCode":0,"verdict":"not_ready","iterations":1,"blockerCount":1,"warningCount":0,"failureCategory":"provider-credit-exhausted"}}
EOF
        ;;
      infra_retry_error_tool)
        cat > "$STATE_DIR/.review-result.json" <<EOF
{"stage":"review","status":"completed","agent":"codex","model":"gpt-5.5","artifacts":{"type":"review","prNumber":304,"exitCode":2,"verdict":"error","iterations":1,"blockerCount":0,"warningCount":0,"reviewToolError":"spawnSync /bin/bash ETIMEDOUT"}}
EOF
        ;;
      infra_retry_scope_unverifiable)
        cat > "$STATE_DIR/.review-result.json" <<EOF
{"stage":"review","status":"completed","agent":"codex","model":"gpt-5.5","artifacts":{"type":"review","prNumber":304,"exitCode":1,"verdict":"not_ready","iterations":1,"blockerCount":1,"warningCount":1,"failureCategory":"review-scope-unverifiable","terminalReason":"review_complete"}}
EOF
        ;;
      verdictless_completed_recovery)
        cat > "$STATE_DIR/.review-result.json" <<EOF
{"stage":"review","status":"completed","agent":"codex","model":"gpt-5.5","artifacts":{"type":"review","prNumber":304,"missingReviewEvidence":true}}
EOF
        ;;
      missing_review_recovery)
        rm -f "$STATE_DIR/.review-result.json"
        ;;
      verdictless_running_recovery)
        cat > "$STATE_DIR/.review-result.json" <<EOF
{"stage":"review","status":"running","agent":"codex","model":"gpt-5.5","artifacts":{"type":"review","prNumber":304,"recoveryReplay":{"status":"running","preservesPriorVerdict":true}}}
EOF
        ;;
      infra_retry_running_preserved_failure)
        cat > "$STATE_DIR/.review-result.json" <<EOF
{"stage":"review","status":"running","agent":"native-openrouter","model":"qwen-3-coder","artifacts":{"type":"review","prNumber":304,"exitCode":1,"verdict":"not_ready","iterations":1,"blockerCount":1,"failureCategory":"native-runtime-unavailable","history":["prior"]}}
EOF
        ;;
      review_not_ready_no_category)
        cat > "$STATE_DIR/.review-result.json" <<EOF
{"stage":"review","status":"completed","agent":"codex","model":"gpt-5.5","artifacts":{"type":"review","prNumber":304,"exitCode":1,"verdict":"not_ready","iterations":1,"blockerCount":1,"warningCount":0,"terminalReason":"review_complete"}}
EOF
        ;;
      dismissed_blockers_pass)
        cat > "$STATE_DIR/.review-result.json" <<EOF
{"stage":"review","status":"completed","agent":"codex","model":"claude-opus-4-7","artifacts":{"type":"review","prNumber":304,"exitCode":1,"verdict":"not_ready","iterations":2,"blockerCount":1,"warningCount":0,"dismissedBlockers":[{"location":"scope-guard","category":"plan_compliance","description":"Diff includes files from already-merged PRs","justification":"False positive: stale diff base; PR diff touches only in-scope files","evidence":"git log auto/integration..HEAD -- <in-scope paths>"}],"terminalReason":"review_complete"}}
EOF
        ;;
      dismissed_blockers_invalid)
        cat > "$STATE_DIR/.review-result.json" <<EOF
{"stage":"review","status":"completed","agent":"codex","model":"claude-opus-4-7","artifacts":{"type":"review","prNumber":304,"exitCode":1,"verdict":"not_ready","iterations":2,"blockerCount":1,"warningCount":0,"dismissedBlockers":[{"location":"scope-guard","description":"Diff includes files from already-merged PRs","justification":"   "}],"terminalReason":"review_complete"}}
EOF
        ;;
    esac

    WRITE_STAGE_CALLS=""
    READY_ATTENTION_CALLS=""
    LOG_OUTPUT=""
    LOG_ERROR_OUTPUT=""
    LOG_WARN_OUTPUT=""
    LAUNCH_AGENT_CALLS=0
    REVIEW_LAUNCH_CALLS=0
    PREPARE_RECOVERY_CALLS=0
    AGENT_VALIDATE_CALLS=0
    READY_PROMPT_CALLS=0
    READY_PROMPT_SUMMARY=""
    READY_LABEL_COUNT_FILE="$CASE_DIR/ready-label-calls"
    printf "%s\n" "0" > "$READY_LABEL_COUNT_FILE"

    _ensure_window_exists() { :; }
    ready_state_dir() { printf "%s\n" "$STATE_DIR"; }
    read_state_value() {
      local filter="${5:-}${4:-}"
      if [[ "$filter" == *".tasks["*".model"* ]]; then
        case "$TEST_CASE" in
          no_model_available) printf "\n" ;;
          *) printf "%s\n" "gpt-5.4" ;;
        esac
        return 0
      fi
      if [[ "$filter" == *".tasks["*".coderModel"* ]]; then
        case "$TEST_CASE" in
          native_route_coder_model) printf "%s\n" "kimi-k2-thinking" ;;
          no_model_available) printf "\n" ;;
          *) printf "\n" ;;
        esac
        return 0
      fi
      if [[ "$filter" == *".tasks["*".reviewerModel"* ]]; then
        case "$TEST_CASE" in
          no_model_available) printf "\n" ;;
          *) printf "\n" ;;
        esac
        return 0
      fi
      if [[ "$filter" == *".tasks["*".plannerModel"* ]]; then
        case "$TEST_CASE" in
          no_model_available) printf "\n" ;;
          *) printf "\n" ;;
        esac
        return 0
      fi
      printf "\n"
    }
    read_stage_status() {
      case "$TEST_CASE" in
        pending_re_check) printf "%s\n" "running" ;;
        already_inflight_same_head) printf "%s\n" "running" ;;
        *) printf "\n" ;;
      esac
    }
    ready_stage_pending_verdict() {
      case "$TEST_CASE" in
        pending_re_check) printf "%s\n" "pending" ;;
        *) printf "\n" ;;
      esac
    }
    ready_remediation_attempts() {
      case "$TEST_CASE" in
        second_remediation_launch) printf "%s\n" "1" ;;
        remediation_exhausted) printf "%s\n" "3" ;;
        pass_after_remediation) printf "%s\n" "2" ;;
        sequential_failing_launch_2) printf "%s\n" "1" ;;
        sequential_failing_launch_3) printf "%s\n" "2" ;;
        *) printf "%s\n" "0" ;;
      esac
    }
    ready_remediation_launch_head() {
      case "$TEST_CASE" in
        already_inflight_same_head) printf "%s\n" "abc123" ;;
        *) printf "\n" ;;
      esac
    }
    ready_remediation_enabled() {
      case "$TEST_CASE" in
        remediation_disabled) printf "%s\n" "false" ;;
        *) printf "%s\n" "true" ;;
      esac
    }
    ready_remediation_max_attempts() { printf "%s\n" "3"; }
    ready_remediation_agent_cmd() { printf "\n"; }
    log() { LOG_OUTPUT+="$*\n"; }
    log_error() { LOG_ERROR_OUTPUT+="$*\n"; }
    log_warn() { LOG_WARN_OUTPUT+="$*\n"; }
    build_conflict_resolution_prompt() { :; }
    ensure_ready_worker_window() {
      printf "%s\n" "win-1"
    }
    build_ready_remediation_prompt() {
      READY_PROMPT_CALLS=$((READY_PROMPT_CALLS + 1))
      READY_PROMPT_SUMMARY="${8-}"
      printf "prompt\n"
    }
    LAUNCH_AGENT_PHASE=""
    _launch_agent_in_pane() {
      LAUNCH_AGENT_CALLS=$((LAUNCH_AGENT_CALLS + 1))
      LAUNCH_AGENT_PHASE="${7:-}"
      case "$TEST_CASE" in
        remediation_launch_failure) return 1 ;;
        sequential_failing_launch_1|sequential_failing_launch_2|sequential_failing_launch_3) return 1 ;;
        *) return 0 ;;
      esac
    }
    _prepare_recovery_phase_launch() {
      PREPARE_RECOVERY_CALLS=$((PREPARE_RECOVERY_CALLS + 1))
      return 0
    }
    launch_review_phase() {
      REVIEW_LAUNCH_CALLS=$((REVIEW_LAUNCH_CALLS + 1))
      return 0
    }
    agent_validate_phase_launch() {
      AGENT_VALIDATE_CALLS=$((AGENT_VALIDATE_CALLS + 1))
      case "$TEST_CASE" in
        infra_retry_unhealthy) return 1 ;;
        *) return 0 ;;
      esac
    }
    check_stage_aborted() { return 1; }
    git() {
      if [[ "${1:-}" == "-C" && "${3:-}" == "rev-parse" && "${4:-}" == "--show-toplevel" ]]; then
        printf "%s\n" "$REPO_DIR"
        return 0
      fi
      if [[ "${1:-}" == "-C" && "${3:-}" == "rev-parse" && "${4:-}" == "HEAD" ]]; then
        printf "%s\n" "abc123"
        return 0
      fi
      return 1
    }
    get_main_head_sha() { printf "%s\n" "main456"; }
    merge_queue_enabled() { return 1; }
    merge_queue_enrich_ready_artifacts() { printf "%s\n" "$2"; }
    write_stage_result() {
      printf -v WRITE_STAGE_CALLS "%s%s|%s|%s|%s|%s|%s|%s\n" \
        "$WRITE_STAGE_CALLS" "${1-}" "${2-}" "${3-}" "${4-}" "${5-}" "${6-}" "${7-}"
    }
    write_ready_attention_file() {
      printf -v READY_ATTENTION_CALLS "%s%s|%s\n" "$READY_ATTENTION_CALLS" "$1" "$2"
      mkdir -p "$1"
      printf "%s\n" "$2" > "$1/.needs-attention"
    }
    if [[ "$TEST_CASE" != "cross_pr_revert_tool_error_direct" && "$TEST_CASE" != "cross_pr_revert_blocked" && "$TEST_CASE" != "cross_pr_revert_error" ]]; then
      cross_pr_revert_gate_allows_merge() {
        case "$TEST_CASE" in
          cross_pr_revert_blocked)
            write_ready_attention_file "$2" "PR #$4 removes files from #437 without explicit acknowledgement. Affected files: strategy.txt."
            log "status" "⛔ $1 → Cross-PR revert guard blocked ready phase for PR #$4"
            return 1
            ;;
          cross_pr_revert_error)
            local diag_msg="Cross-PR revert guard tool failure for PR #$4: git-merge-base failed on ref '\''auto/integration'\''. Diagnostic: fatal: Not a valid object name '\''auto/integration'\''"
            write_ready_attention_file "$2" "$diag_msg"
            log_error "  Cross-PR revert guard tool failure for $1 (PR #$4): git-merge-base on '\''auto/integration'\''"
            return 1
            ;;
          *)
            return 0
            ;;
        esac
      }
    fi
    npx() {
      if [[ "${1:-}" != "tsx" ]]; then
        return 1
      fi

      if [[ "${2:-}" == "$TOOLS_DIR/check-cross-pr-reverts.ts" ]]; then
        case "$TEST_CASE" in
          cross_pr_revert_blocked)
            printf "%s\n" "{\"blocked\":true,\"reverts\":[{\"prNumber\":437,\"files\":[{\"path\":\"strategy.txt\"}]}],\"acknowledged\":[],\"unacknowledged\":[{\"prNumber\":437,\"files\":[{\"path\":\"strategy.txt\"}]}]}"
            return 1
            ;;
          cross_pr_revert_error)
            printf "%s\n" "{\"blocked\":false,\"reverts\":[],\"acknowledged\":[],\"unacknowledged\":[],\"toolError\":{\"commandClass\":\"git-merge-base\",\"command\":\"git merge-base auto/integration HEAD\",\"ref\":\"auto/integration\",\"stderr\":\"fatal: Not a valid object name '\''auto/integration'\''\"}}"
            return 2
            ;;
          cross_pr_revert_tool_error_direct)
            printf "%s\n" "{\"blocked\":false,\"reverts\":[],\"acknowledged\":[],\"unacknowledged\":[],\"toolError\":{\"commandClass\":\"git-merge-base\",\"command\":\"git merge-base auto/integration HEAD\",\"ref\":\"auto/integration\",\"stderr\":\"fatal: Not a valid object name '\''auto/integration'\''\"}}"
            return 2
            ;;
          *)
            printf "%s\n" "{\"blocked\":false,\"reverts\":[],\"acknowledged\":[],\"unacknowledged\":[]}"
            return 0
            ;;
        esac
      fi

      if [[ "${2:-}" == "$TOOLS_DIR/set-pr-ready-label.ts" ]]; then
        printf "%s\n" "$(( $(cat "$READY_LABEL_COUNT_FILE") + 1 ))" > "$READY_LABEL_COUNT_FILE"
        case "$TEST_CASE" in
          ready_label_failure) return 1 ;;
          *) printf "Canonicalized ready labels for PR #%s\n" "${3:-304}"; return 0 ;;
        esac
      fi

      case "$TEST_CASE" in
        pending|pending_re_check)
          printf "%s\n" "{\"prNumber\":304,\"branch\":\"task/fix-failing-ci-tests\",\"verdict\":\"pending\",\"checks\":[{\"name\":\"ci-status\",\"status\":\"pending\",\"message\":\"2 CI check(s) still running\",\"details\":{\"pendingChecks\":[{\"name\":\"Shell and Unit Tests\",\"state\":\"QUEUED\"},{\"name\":\"Check Lifecycle Paths\",\"state\":\"QUEUED\"}],\"totalChecks\":2}}],\"timestamp\":\"2026-04-16T14:12:00.431Z\",\"summary\":\"CI checks still in progress - will retry\",\"mergeConflict\":{\"status\":\"CLEAN\",\"message\":\"No merge conflicts detected\",\"mergeable\":\"MERGEABLE\",\"mergeStateStatus\":\"UNSTABLE\",\"attempts\":1}}"
          return 2
          ;;
        pass_after_remediation|pass_clears_recheck|dismissed_blockers_pass)
          printf "%s\n" "{\"prNumber\":304,\"branch\":\"task/fix-failing-ci-tests\",\"verdict\":\"pass\",\"checks\":[{\"name\":\"ci-status\",\"status\":\"pass\",\"message\":\"All CI checks passing\",\"details\":{\"totalChecks\":3}}],\"timestamp\":\"2026-04-16T14:12:00.431Z\",\"summary\":\"All checks passed\",\"mergeConflict\":{\"status\":\"CLEAN\",\"message\":\"No merge conflicts detected\",\"mergeable\":\"MERGEABLE\",\"mergeStateStatus\":\"CLEAN\",\"attempts\":1}}"
          return 0
          ;;
        ready_label_failure)
          printf "%s\n" "{\"prNumber\":304,\"branch\":\"task/fix-failing-ci-tests\",\"verdict\":\"pass\",\"checks\":[{\"name\":\"ci-status\",\"status\":\"pass\",\"message\":\"All CI checks passing\",\"details\":{\"totalChecks\":3}}],\"timestamp\":\"2026-04-16T14:12:00.431Z\",\"summary\":\"All checks passed\",\"mergeConflict\":{\"status\":\"CLEAN\",\"message\":\"No merge conflicts detected\",\"mergeable\":\"MERGEABLE\",\"mergeStateStatus\":\"CLEAN\",\"attempts\":1}}"
          return 0
          ;;
        unknown_first|unknown_capped)
          printf "%s\n" "{\"prNumber\":304,\"branch\":\"task/fix-failing-ci-tests\",\"verdict\":\"pass\",\"checks\":[{\"name\":\"ci-status\",\"status\":\"pass\",\"message\":\"All CI checks passing\",\"details\":{\"totalChecks\":3}}],\"timestamp\":\"2026-04-16T14:12:00.431Z\",\"summary\":\"All checks passed\",\"mergeConflict\":{\"status\":\"UNKNOWN\",\"message\":\"GitHub is still computing mergeability\",\"mergeable\":\"UNKNOWN\",\"mergeStateStatus\":\"UNKNOWN\",\"attempts\":3}}"
          return 0
          ;;
        error_first)
          printf "%s\n" "{\"prNumber\":304,\"branch\":\"task/fix-failing-ci-tests\",\"verdict\":\"pass\",\"checks\":[{\"name\":\"ci-status\",\"status\":\"pass\",\"message\":\"All CI checks passing\",\"details\":{\"totalChecks\":3}}],\"timestamp\":\"2026-04-16T14:12:00.431Z\",\"summary\":\"All checks passed\",\"mergeConflict\":{\"status\":\"ERROR\",\"message\":\"Unable to fetch mergeability from GitHub\",\"attempts\":3,\"error\":\"HTTP 504\"}}"
          return 0
          ;;
        clean_after_unknown)
          printf "%s\n" "{\"prNumber\":304,\"branch\":\"task/fix-failing-ci-tests\",\"verdict\":\"pass\",\"checks\":[{\"name\":\"ci-status\",\"status\":\"pass\",\"message\":\"All CI checks passing\",\"details\":{\"totalChecks\":3}}],\"timestamp\":\"2026-04-16T14:12:00.431Z\",\"summary\":\"All checks passed\",\"mergeConflict\":{\"status\":\"CLEAN\",\"message\":\"No merge conflicts detected\",\"mergeable\":\"MERGEABLE\",\"mergeStateStatus\":\"CLEAN\",\"attempts\":1}}"
          return 0
          ;;
        clean_with_stderr)
          printf "%s\n" "{\"prNumber\":304,\"branch\":\"task/fix-failing-ci-tests\",\"verdict\":\"pass\",\"checks\":[{\"name\":\"ci-status\",\"status\":\"pass\",\"message\":\"All CI checks passing\",\"details\":{\"totalChecks\":3}}],\"timestamp\":\"2026-04-16T14:12:00.431Z\",\"summary\":\"All checks passed\",\"mergeConflict\":{\"status\":\"CLEAN\",\"message\":\"No merge conflicts detected\",\"mergeable\":\"MERGEABLE\",\"mergeStateStatus\":\"CLEAN\",\"attempts\":1}}"
          return 0
          ;;
        fail_with_stderr)
          printf "%s\n" "{\"prNumber\":304,\"branch\":\"task/fix-failing-ci-tests\",\"verdict\":\"fail\",\"checks\":[{\"name\":\"ci-status\",\"status\":\"fail\",\"message\":\"1 CI check(s) failing\",\"details\":{\"failedChecks\":[{\"name\":\"Shell and Unit Tests\",\"state\":\"FAILURE\"}],\"pendingChecks\":[],\"totalChecks\":3}}],\"timestamp\":\"2026-04-16T14:12:00.431Z\",\"summary\":\"One or more checks failed - not safe to merge\",\"mergeConflict\":{\"status\":\"CLEAN\",\"message\":\"No merge conflicts detected\",\"mergeable\":\"MERGEABLE\",\"mergeStateStatus\":\"UNSTABLE\",\"attempts\":1}}"
          printf "%s\n" "TypeError: ready crashed" >&2
          return 1
          ;;
        remediation_disabled|remediation_launch|second_remediation_launch|remediation_exhausted|remediation_launch_failure|already_inflight_same_head|sequential_failing_launch_1|sequential_failing_launch_2|sequential_failing_launch_3|native_route_coder_model|no_model_available|remediation_backoff_hold|remediation_head_reset)
          printf "%s\n" "{\"prNumber\":304,\"branch\":\"task/fix-failing-ci-tests\",\"verdict\":\"fail\",\"checks\":[{\"name\":\"ci-status\",\"status\":\"fail\",\"message\":\"1 CI check(s) failing\",\"details\":{\"failedChecks\":[{\"name\":\"Shell and Unit Tests\",\"state\":\"FAILURE\"}],\"pendingChecks\":[],\"totalChecks\":3}}],\"timestamp\":\"2026-04-16T14:12:00.431Z\",\"summary\":\"One or more checks failed - not safe to merge\",\"mergeConflict\":{\"status\":\"CLEAN\",\"message\":\"No merge conflicts detected\",\"mergeable\":\"MERGEABLE\",\"mergeStateStatus\":\"UNSTABLE\",\"attempts\":1}}"
          return 1
          ;;
        actionable_named_failure)
          printf "%s\n" "{\"prNumber\":304,\"branch\":\"task/fix-failing-ci-tests\",\"verdict\":\"fail\",\"checks\":[{\"name\":\"lint\",\"status\":\"fail\",\"message\":\"eslint failed\",\"details\":{}}],\"timestamp\":\"2026-04-16T14:12:00.431Z\",\"summary\":\"Lint failed\",\"mergeConflict\":{\"status\":\"CLEAN\",\"message\":\"No merge conflicts detected\",\"mergeable\":\"MERGEABLE\",\"mergeStateStatus\":\"UNSTABLE\",\"attempts\":1}}"
          return 1
          ;;
        actionable_compound_failure)
          printf "%s\n" "{\"prNumber\":304,\"branch\":\"task/fix-failing-ci-tests\",\"verdict\":\"fail\",\"checks\":[{\"name\":\"ci-status\",\"status\":\"fail\",\"message\":\"1 CI check(s) failing\",\"details\":{\"failedChecks\":[{\"name\":\"Shell and Unit Tests\",\"state\":\"FAILURE\"}],\"pendingChecks\":[],\"totalChecks\":3}},{\"name\":\"tests\",\"status\":\"fail\",\"message\":\"unit tests failed\",\"details\":{}}],\"timestamp\":\"2026-04-16T14:12:00.431Z\",\"summary\":\"Multiple checks failed\",\"mergeConflict\":{\"status\":\"CLEAN\",\"message\":\"No merge conflicts detected\",\"mergeable\":\"MERGEABLE\",\"mergeStateStatus\":\"UNSTABLE\",\"attempts\":1}}"
          return 1
          ;;
        actionable_message_failure)
          printf "%s\n" "{\"prNumber\":304,\"branch\":\"task/fix-failing-ci-tests\",\"verdict\":\"fail\",\"checks\":[{\"name\":\"ci-suite\",\"status\":\"fail\",\"message\":\"Shell and Unit Tests failed\",\"details\":{}}],\"timestamp\":\"2026-04-16T14:12:00.431Z\",\"summary\":\"CI suite failed\",\"mergeConflict\":{\"status\":\"CLEAN\",\"message\":\"No merge conflicts detected\",\"mergeable\":\"MERGEABLE\",\"mergeStateStatus\":\"UNSTABLE\",\"attempts\":1}}"
          return 1
          ;;
        conflict_persists_after_remediation)
          printf "%s\n" "{\"prNumber\":304,\"branch\":\"task/fix-failing-ci-tests\",\"verdict\":\"fail\",\"checks\":[{\"name\":\"merge-conflict\",\"status\":\"fail\",\"message\":\"PR has conflicts\",\"details\":{}}],\"timestamp\":\"2026-04-16T14:12:00.431Z\",\"summary\":\"Merge conflicts detected\",\"mergeConflict\":{\"status\":\"CONFLICTED\",\"message\":\"PR #304 has conflicts with main\",\"mergeable\":\"CONFLICTING\",\"mergeStateStatus\":\"DIRTY\",\"attempts\":1}}"
          printf "%s\n" "⚠️  MERGE CONFLICT: PR #304 has conflicts with main" >&2
          return 1
          ;;
        non_ci_failure)
          printf "%s\n" "{\"prNumber\":304,\"branch\":\"task/fix-failing-ci-tests\",\"verdict\":\"fail\",\"checks\":[{\"name\":\"release-requirements\",\"status\":\"fail\",\"message\":\"Manual release steps missing\",\"details\":{}}],\"timestamp\":\"2026-04-16T14:12:00.431Z\",\"summary\":\"One or more checks failed - not safe to merge\",\"mergeConflict\":{\"status\":\"CLEAN\",\"message\":\"No merge conflicts detected\",\"mergeable\":\"MERGEABLE\",\"mergeStateStatus\":\"UNSTABLE\",\"attempts\":1}}"
          return 1
          ;;
        *)
          return 1
          ;;
      esac
    }

    set +e
    launch_ready_phase "HOK-1300" "fix-failing-ci-tests" "Fix failing CI tests" "$WT_DIR" "task/fix-failing-ci-tests" "main" "304"
    rc=$?
    set -e

    stage_summary=$(printf "%s" "$WRITE_STAGE_CALLS" | tr "\n" ";")
    attention_summary=$(printf "%s" "$READY_ATTENTION_CALLS" | tr "\n" ";")
    attention_count=0
    [[ -n "$READY_ATTENTION_CALLS" ]] && attention_count=$(printf "%s" "$READY_ATTENTION_CALLS" | grep -c .)
    error_count=0
    [[ -n "$LOG_ERROR_OUTPUT" ]] && error_count=$(printf "%s" "$LOG_ERROR_OUTPUT" | grep -c .)
    conflict_attention_head=""
    [[ -f "$STATE_DIR/.conflict-attention-head" ]] && conflict_attention_head=$(cat "$STATE_DIR/.conflict-attention-head")
    conflict_attention_reported="absent"
    [[ -f "$STATE_DIR/.conflict-attention-reported" ]] && conflict_attention_reported="present"
    conflict_detected="absent"
    [[ -f "$STATE_DIR/.conflict-detected" ]] && conflict_detected="present"
    needs_attention="absent"
    [[ -f "$STATE_DIR/.needs-attention" ]] && needs_attention="present"
    transient_attention="absent"
    [[ -f "$STATE_DIR/.needs-attention-transient" ]] && transient_attention="present"
    transient_count="$(cat "$STATE_DIR/.transient-mergeability-count" 2>/dev/null || echo "")"
    infra_retry_count="$(cat "$STATE_DIR/.retry-review-infra-recovery-count" 2>/dev/null || echo "")"
    ready_label_calls="$(cat "$READY_LABEL_COUNT_FILE" 2>/dev/null || echo "0")"
    ready_result_payload=""
    [[ -f "$STATE_DIR/.ready-result.json" ]] && ready_result_payload=$(cat "$STATE_DIR/.ready-result.json")

    debug_line_count=0
    [[ -f "$DEBUG_FILE" ]] && debug_line_count=$(wc -l < "$DEBUG_FILE" | tr -d " ")
    debug_payload=""
    [[ -f "$DEBUG_FILE" ]] && debug_payload=$(cat "$DEBUG_FILE")

    printf "rc=%s\nstage_calls=%s\nattention_calls=%s\nattention_count=%s\nlaunch_calls=%s\nreview_launch_calls=%s\nprepare_recovery_calls=%s\nagent_validate_calls=%s\nprompt_calls=%s\nerror_count=%s\nlogs=%s\nwarn_logs=%s\nerror_payload=%s\ndebug_file=%s\ndebug_lines=%s\ndebug_payload=%s\nconflict_attention_head=%s\nconflict_attention_reported=%s\nconflict_detected=%s\nneeds_attention=%s\ntransient_attention=%s\ntransient_count=%s\ninfra_retry_count=%s\nready_result_payload=%s\n" \
      "$rc" "$stage_summary" "$attention_summary" "$attention_count" "$LAUNCH_AGENT_CALLS" "$REVIEW_LAUNCH_CALLS" "$PREPARE_RECOVERY_CALLS" "$AGENT_VALIDATE_CALLS" "$READY_PROMPT_CALLS" "$error_count" "$LOG_OUTPUT" "$LOG_WARN_OUTPUT" "$LOG_ERROR_OUTPUT" "$DEBUG_FILE" "$debug_line_count" "$debug_payload" "$conflict_attention_head" "$conflict_attention_reported" "$conflict_detected" "$needs_attention" "$transient_attention" "$transient_count" "$infra_retry_count" "$ready_result_payload"
    printf "ready_label_calls=%s\n" "$ready_label_calls"
    printf "prompt_summary=%s\n" "$READY_PROMPT_SUMMARY"
    printf "phase_used=%s\n" "$LAUNCH_AGENT_PHASE"
    remediation_retry_count="$(cat "$STATE_DIR/.retry-ready-remediation-count" 2>/dev/null || echo "")"
    remediation_retry_exhausted="absent"
    [[ -f "$STATE_DIR/.retry-ready-remediation-exhausted" ]] && remediation_retry_exhausted="present"
    printf "remediation_retry_count=%s\nremediation_retry_exhausted=%s\n" \
      "$remediation_retry_count" "$remediation_retry_exhausted"
    recheck_count_file="absent"
    [[ -f "$STATE_DIR/.failed-ready-recheck-count" ]] && recheck_count_file="present"
    recheck_head_file="absent"
    [[ -f "$STATE_DIR/.failed-ready-recheck-head" ]] && recheck_head_file="present"
    recheck_last_at_file="absent"
    [[ -f "$STATE_DIR/.failed-ready-recheck-last-at" ]] && recheck_last_at_file="present"
    recheck_reason_file="absent"
    [[ -f "$STATE_DIR/.failed-ready-recheck-reason.json" ]] && recheck_reason_file="present"
    recheck_exhausted_file="absent"
    [[ -f "$STATE_DIR/.failed-ready-recheck-exhausted" ]] && recheck_exhausted_file="present"
    printf "recheck_files=%s,%s,%s,%s,%s\n" \
      "$recheck_count_file" "$recheck_head_file" "$recheck_last_at_file" "$recheck_reason_file" "$recheck_exhausted_file"
  ' 2>&1
}

run_watchdog_launch_case() {
  local test_case="$1"
  local case_dir="$TEST_TMP/watchdog-$test_case"
  mkdir -p "$case_dir"

  CASE_DIR="$case_dir" LAUNCH_FUNC_FILE="$LAUNCH_FUNC_FILE" COMMON_SCRIPT="$COMMON_SCRIPT" TEST_CASE="$test_case" bash -lc '
    set -euo pipefail
    source "$COMMON_SCRIPT"
    source "$LAUNCH_FUNC_FILE"

    SESSION="ready-watchdog-test-$TEST_CASE"
    AGENT_CMD="codex"
    STATE_DIR="$CASE_DIR/feature/ready"
    WT_DIR="$CASE_DIR/worktree"
    mkdir -p "$STATE_DIR" "$WT_DIR"
    printf "%s\n" "{\"stage\":\"ready\",\"status\":\"running\",\"startedAt\":\"2026-05-05T11:55:00.000Z\",\"finishedAt\":null,\"agent\":\"codex\",\"model\":\"gpt-5.5\",\"notes\":null,\"artifacts\":{\"type\":\"ready\",\"verdict\":\"fail\",\"prNumber\":304,\"checksRun\":3,\"checksPassed\":2,\"mergeConflict\":\"CLEAN\"}}" > "$STATE_DIR/.ready-result.json"

    WRITE_STAGE_CALLS=""
    READY_PROMPT_CALLS=0
    READY_PROMPT_SUMMARY=""
    LAUNCH_AGENT_CALLS=0

    _ensure_task_window_exists() { printf "%s\n" "win-1"; }
    persist_task_window_id() { :; }
    ready_state_dir() { printf "%s\n" "$STATE_DIR"; }
    read_state_value() {
      local filter="${5:-}${4:-}"
      if [[ "$filter" == *".agent"* ]]; then
        printf "%s\n" "codex"
      elif [[ "$filter" == *".model"* ]]; then
        printf "%s\n" "gpt-5.5"
      elif [[ "$filter" == *".coderModel"* ]]; then
        printf "%s\n" "kimi-k2-thinking"
      else
        printf "\n"
      fi
    }
    read_stage_status() {
      case "$TEST_CASE" in
        inflight_same_head) printf "%s\n" "running" ;;
        *) printf "\n" ;;
      esac
    }
    ready_remediation_attempts() {
      case "$TEST_CASE" in
        max_attempts) printf "%s\n" "3" ;;
        *) printf "%s\n" "0" ;;
      esac
    }
    ready_remediation_launch_head() {
      case "$TEST_CASE" in
        inflight_same_head) printf "%s\n" "abc123" ;;
        *) printf "\n" ;;
      esac
    }
    ready_remediation_agent_cmd() { printf "\n"; }
    build_ready_remediation_prompt() {
      READY_PROMPT_CALLS=$((READY_PROMPT_CALLS + 1))
      READY_PROMPT_SUMMARY="${8-}"
      printf "prompt\n"
    }
    _launch_agent_in_pane() {
      LAUNCH_AGENT_CALLS=$((LAUNCH_AGENT_CALLS + 1))
      return 0
    }
    check_stage_aborted() { return 1; }
    git() {
      if [[ "${1:-}" == "-C" && "${3:-}" == "rev-parse" && "${4:-}" == "HEAD" ]]; then
        printf "%s\n" "abc123"
        return 0
      fi
      return 1
    }
    merge_queue_enrich_ready_artifacts() { printf "%s\n" "$2"; }
    write_stage_result() {
      printf -v WRITE_STAGE_CALLS "%s%s|%s|%s|%s|%s|%s|%s\n" \
        "$WRITE_STAGE_CALLS" "${1-}" "${2-}" "${3-}" "${4-}" "${5-}" "${6-}" "${7-}"
    }
    ensure_ready_worker_window() {
      _ensure_task_window_exists "$SESSION" "$1" "$2" "$4"
    }
    write_ready_attention_file() { :; }
    log() { :; }
    log_error() { :; }

    output_file="$CASE_DIR/watchdog-output.json"
    launch_ready_watchdog_remediation \
      "HOK-1300" \
      "fix-failing-ci-tests" \
      "$WT_DIR" \
      "task/fix-failing-ci-tests" \
      "main" \
      "304" \
      "Alembic Check (FAILURE)" \
      "1" \
      "3" \
      "[\"Alembic Check\"]" > "$output_file"
    output=$(cat "$output_file")

    stage_summary=$(printf "%s" "$WRITE_STAGE_CALLS" | tr "\n" ";")
    printf "output=%s\nstage_calls=%s\nlaunch_calls=%s\nprompt_calls=%s\nprompt_summary=%s\n" \
      "$output" "$stage_summary" "$LAUNCH_AGENT_CALLS" "$READY_PROMPT_CALLS" "$READY_PROMPT_SUMMARY"
  ' 2>&1
}

run_cross_pr_gate_case() {
  local test_case="$1"
  local case_dir="$TEST_TMP/gate-$test_case"
  mkdir -p "$case_dir"

  CASE_DIR="$case_dir" LAUNCH_FUNC_FILE="$LAUNCH_FUNC_FILE" COMMON_SCRIPT="$COMMON_SCRIPT" TEST_CASE="$test_case" bash -lc '
    set -euo pipefail
    source "$COMMON_SCRIPT"
    source "$LAUNCH_FUNC_FILE"

    TOOLS_DIR="$CASE_DIR/tools"
    mkdir -p "$TOOLS_DIR"

    STATE_DIR="$CASE_DIR/state"
    WT_DIR="$CASE_DIR/worktree"
    mkdir -p "$STATE_DIR" "$WT_DIR"

    CAPTURED_NPX_ARGS_FILE="$CASE_DIR/npx-args.txt"
    LOG_OUTPUT=""
    LOG_ERROR_OUTPUT=""

    log() { LOG_OUTPUT+="$*\n"; }
    log_error() { LOG_ERROR_OUTPUT+="$*\n"; }
    npx() {
      printf "%s\n" "$*" > "$CAPTURED_NPX_ARGS_FILE"
      printf "%s\n" "{\"blocked\":false,\"reverts\":[],\"acknowledged\":[],\"unacknowledged\":[]}"
      return 0
    }

    case "$TEST_CASE" in
      passes_base_branch)
        set +e
        cross_pr_revert_gate_allows_merge "HOK-1300" "$STATE_DIR" "$WT_DIR" "304" "main"
        rc=$?
        set -e
        ;;
      empty_base_branch)
        set +e
        cross_pr_revert_gate_allows_merge "HOK-1300" "$STATE_DIR" "$WT_DIR" "304" ""
        rc=$?
        set -e
        ;;
      omitted_base_branch)
        set +e
        cross_pr_revert_gate_allows_merge "HOK-1300" "$STATE_DIR" "$WT_DIR" "304"
        rc=$?
        set -e
        ;;
    esac

    printf "rc=%s\nargs=%s\nlogs=%s\nerrors=%s\n" "$rc" "$(cat "$CAPTURED_NPX_ARGS_FILE" 2>/dev/null || true)" "$LOG_OUTPUT" "$LOG_ERROR_OUTPUT"
  ' 2>&1
}

run_recheck_case() {
  local test_case="$1"
  local case_dir="$TEST_TMP/recheck-$test_case"
  mkdir -p "$case_dir"

  CASE_DIR="$case_dir" LAUNCH_FUNC_FILE="$LAUNCH_FUNC_FILE" COMMON_SCRIPT="$COMMON_SCRIPT" TEST_CASE="$test_case" bash -lc '
    set -euo pipefail
    source "$COMMON_SCRIPT"
    source "$LAUNCH_FUNC_FILE"

    STATE_DIR="$CASE_DIR/state"
    mkdir -p "$STATE_DIR"
    LOG_OUTPUT=""
    LOG_ERROR_OUTPUT=""
    log() { LOG_OUTPUT+="$*\n"; }
    log_error() { LOG_ERROR_OUTPUT+="$*\n"; }
    git() {
      if [[ "${1:-}" == "-C" && "${3:-}" == "rev-parse" && "${4:-}" == "--show-toplevel" ]]; then
        printf "%s\n" "$CASE_DIR"
        return 0
      fi
      if [[ "${1:-}" == "-C" && "${3:-}" == "rev-parse" && "${4:-}" == "HEAD" ]]; then
        printf "%s\n" "abc123"
        return 0
      fi
      return 1
    }

    write_failed_result() {
      printf "%s\n" "{\"stage\":\"ready\",\"status\":\"failed\",\"finishedAt\":\"$1\",\"notes\":\"$2\",\"failureReason\":\"$2\",\"artifacts\":{\"type\":\"ready\",\"verdict\":\"fail\",\"prNumber\":304,\"crossPrGuard\":{\"source\":\"cross-pr-revert-guard\"}}}" > "$STATE_DIR/.ready-result.json"
    }

    case "$TEST_CASE" in
      counter_roundtrip)
        c0=$(failed_ready_recheck_count "$STATE_DIR")
        c1=$(increment_failed_ready_recheck_count "$STATE_DIR" "aaa")
        c2=$(increment_failed_ready_recheck_count "$STATE_DIR" "aaa")
        head_stored=$(cat "$STATE_DIR/.failed-ready-recheck-head")
        printf "%s\n" "garbage" > "$STATE_DIR/.failed-ready-recheck-count"
        cg=$(failed_ready_recheck_count "$STATE_DIR")
        printf "%s\n" "{}" > "$STATE_DIR/.failed-ready-recheck-reason.json"
        : > "$STATE_DIR/.failed-ready-recheck-exhausted"
        clear_failed_ready_recheck_state "$STATE_DIR"
        remaining=$(ls -A "$STATE_DIR" 2>/dev/null | grep -c "failed-ready-recheck" || true)
        printf "c0=%s c1=%s c2=%s head_stored=%s cg=%s remaining=%s\n" \
          "$c0" "$c1" "$c2" "$head_stored" "$cg" "$remaining"
        ;;
      head_reset)
        increment_failed_ready_recheck_count "$STATE_DIR" "aaa" >/dev/null
        : > "$STATE_DIR/.failed-ready-recheck-exhausted"
        failed_ready_recheck_reset_if_new_head "$STATE_DIR" "aaa"
        same_head_count=$(failed_ready_recheck_count "$STATE_DIR")
        failed_ready_recheck_reset_if_new_head "$STATE_DIR" ""
        empty_head_count=$(failed_ready_recheck_count "$STATE_DIR")
        failed_ready_recheck_reset_if_new_head "$STATE_DIR" "bbb"
        new_head_count=$(failed_ready_recheck_count "$STATE_DIR")
        sentinel="absent"
        [[ -f "$STATE_DIR/.failed-ready-recheck-exhausted" ]] && sentinel="present"
        printf "same_head_count=%s empty_head_count=%s new_head_count=%s sentinel=%s\n" \
          "$same_head_count" "$empty_head_count" "$new_head_count" "$sentinel"
        ;;
      backoff_schedule)
        d1=$(failed_ready_recheck_backoff_seconds 1)
        d2=$(failed_ready_recheck_backoff_seconds 2)
        d3=$(failed_ready_recheck_backoff_seconds 3)
        dg=$(failed_ready_recheck_backoff_seconds garbage)
        d9=$(failed_ready_recheck_backoff_seconds 9)
        READY_FAILED_RECHECK_BACKOFF_SECONDS=1000
        READY_FAILED_RECHECK_BACKOFF_CAP_SECONDS=1500
        dcap=$(failed_ready_recheck_backoff_seconds 2)
        READY_FAILED_RECHECK_BACKOFF_SECONDS=garbage
        READY_FAILED_RECHECK_BACKOFF_CAP_SECONDS=nope
        dbad=$(failed_ready_recheck_backoff_seconds 2)
        READY_FAILED_RECHECK_BACKOFF_SECONDS=1
        READY_FAILED_RECHECK_BACKOFF_CAP_SECONDS=1800
        dover=$(failed_ready_recheck_backoff_seconds 1)
        printf "d1=%s d2=%s d3=%s dg=%s d9=%s dcap=%s dbad=%s dover=%s\n" \
          "$d1" "$d2" "$d3" "$dg" "$d9" "$dcap" "$dbad" "$dover"
        ;;
      due_logic)
        no_file="not-due"
        failed_ready_recheck_due "$STATE_DIR" && no_file="due"
        printf "%s\n" "1" > "$STATE_DIR/.failed-ready-recheck-count"
        printf "%s\n" "$(date +%s)" > "$STATE_DIR/.failed-ready-recheck-last-at"
        fresh="not-due"
        failed_ready_recheck_due "$STATE_DIR" && fresh="due"
        printf "%s\n" "$(( $(date +%s) - 500 ))" > "$STATE_DIR/.failed-ready-recheck-last-at"
        elapsed="not-due"
        failed_ready_recheck_due "$STATE_DIR" && elapsed="due"
        printf "%s\n" "garbage" > "$STATE_DIR/.failed-ready-recheck-last-at"
        garbage_last="not-due"
        failed_ready_recheck_due "$STATE_DIR" && garbage_last="due"
        printf "no_file=%s fresh=%s elapsed=%s garbage_last=%s\n" \
          "$no_file" "$fresh" "$elapsed" "$garbage_last"
        ;;
      gate_dispositions)
        g_fresh=$(failed_ready_recheck_gate "$STATE_DIR" "aaa")
        increment_failed_ready_recheck_count "$STATE_DIR" "aaa" >/dev/null
        g_backoff=$(failed_ready_recheck_gate "$STATE_DIR" "aaa")
        printf "%s\n" "$(( $(date +%s) - 500 ))" > "$STATE_DIR/.failed-ready-recheck-last-at"
        g_elapsed=$(failed_ready_recheck_gate "$STATE_DIR" "aaa")
        printf "%s\n" "4" > "$STATE_DIR/.failed-ready-recheck-count"
        g_ceiling=$(failed_ready_recheck_gate "$STATE_DIR" "aaa")
        : > "$STATE_DIR/.failed-ready-recheck-exhausted"
        g_quiet=$(failed_ready_recheck_gate "$STATE_DIR" "aaa")
        g_newhead=$(failed_ready_recheck_gate "$STATE_DIR" "bbb")
        newhead_count=$(failed_ready_recheck_count "$STATE_DIR")
        printf "g_fresh=%s g_backoff=%s g_elapsed=%s g_ceiling=%s g_quiet=%s g_newhead=%s newhead_count=%s\n" \
          "$g_fresh" "$g_backoff" "$g_elapsed" "$g_ceiling" "$g_quiet" "$g_newhead" "$newhead_count"
        ;;
      identical_streak)
        write_failed_result "2026-08-27T09:52:00Z" "guard blocked"
        record_failed_ready_recheck_observation "$STATE_DIR"
        s1=$(failed_ready_recheck_identical_streak "$STATE_DIR")
        record_failed_ready_recheck_observation "$STATE_DIR"
        s_repeat=$(failed_ready_recheck_identical_streak "$STATE_DIR")
        write_failed_result "2026-08-27T09:53:00Z" "guard blocked"
        record_failed_ready_recheck_observation "$STATE_DIR"
        s2=$(failed_ready_recheck_identical_streak "$STATE_DIR")
        write_failed_result "2026-08-27T09:54:00Z" "guard blocked"
        record_failed_ready_recheck_observation "$STATE_DIR"
        s3=$(failed_ready_recheck_identical_streak "$STATE_DIR")
        printf "%s\n" "1" > "$STATE_DIR/.failed-ready-recheck-count"
        printf "%s\n" "$(date +%s)" > "$STATE_DIR/.failed-ready-recheck-last-at"
        g_streak=$(failed_ready_recheck_gate "$STATE_DIR" "aaa")
        write_failed_result "2026-08-27T09:55:00Z" "different failure"
        record_failed_ready_recheck_observation "$STATE_DIR"
        s_reset=$(failed_ready_recheck_identical_streak "$STATE_DIR")
        printf "s1=%s s_repeat=%s s2=%s s3=%s g_streak=%s s_reset=%s\n" \
          "$s1" "$s_repeat" "$s2" "$s3" "$g_streak" "$s_reset"
        ;;
      exhaustion_oneshot)
        write_failed_result "2026-08-27T09:52:00Z" "guard blocked"
        printf "%s\n" "4" > "$STATE_DIR/.failed-ready-recheck-count"
        first="not-first"
        mark_failed_ready_recheck_exhausted "HOK-1300" "304" "$STATE_DIR" && first="first"
        attention=$(marker_reason "$STATE_DIR/.needs-attention" 2>/dev/null || echo "")
        exhausted_flag=$(jq -r ".artifacts.failedReadyRecheck.exhausted" "$STATE_DIR/.ready-result.json")
        attempts=$(jq -r ".artifacts.failedReadyRecheck.attempts" "$STATE_DIR/.ready-result.json")
        last_reason=$(jq -r ".artifacts.failedReadyRecheck.lastReason" "$STATE_DIR/.ready-result.json")
        failure_reason=$(jq -r ".failureReason" "$STATE_DIR/.ready-result.json")
        guard_kept=$(jq -r ".artifacts.crossPrGuard.source" "$STATE_DIR/.ready-result.json")
        result_before=$(cat "$STATE_DIR/.ready-result.json")
        second="not-first"
        mark_failed_ready_recheck_exhausted "HOK-1300" "304" "$STATE_DIR" && second="first"
        result_after=$(cat "$STATE_DIR/.ready-result.json")
        unchanged="differs"
        [[ "$result_before" == "$result_after" ]] && unchanged="unchanged"
        error_count=0
        [[ -n "$LOG_ERROR_OUTPUT" ]] && error_count=$(printf "%s" "$LOG_ERROR_OUTPUT" | grep -c .)
        STATE_DIR2="$CASE_DIR/state2"
        mkdir -p "$STATE_DIR2"
        printf "%s\n" "2" > "$STATE_DIR2/.failed-ready-recheck-count"
        missing_result="not-first"
        mark_failed_ready_recheck_exhausted "HOK-1300" "304" "$STATE_DIR2" && missing_result="first"
        missing_attention=$(marker_reason "$STATE_DIR2/.needs-attention" 2>/dev/null || echo "")
        printf "first=%s second=%s unchanged=%s exhausted_flag=%s attempts=%s last_reason=%s failure_reason=%s guard_kept=%s error_count=%s attention=%s missing_result=%s missing_attention=%s\n" \
          "$first" "$second" "$unchanged" "$exhausted_flag" "$attempts" "$last_reason" "$failure_reason" "$guard_kept" "$error_count" "$attention" "$missing_result" "$missing_attention"
        ;;
      fresh_budget_after_success)
        g1=$(failed_ready_recheck_gate "$STATE_DIR" "aaa")
        increment_failed_ready_recheck_count "$STATE_DIR" "aaa" >/dev/null
        clear_failed_ready_recheck_state "$STATE_DIR"
        cleared_count=$(failed_ready_recheck_count "$STATE_DIR")
        g2=$(failed_ready_recheck_gate "$STATE_DIR" "aaa")
        printf "g1=%s cleared_count=%s g2=%s\n" "$g1" "$cleared_count" "$g2"
        ;;
    esac
  ' 2>&1
}

echo "=== Cross-PR Revert Gate ==="

output="$(run_cross_pr_gate_case passes_base_branch)"
check_contains "gate includes integration ref flag" "$output" "--integration-ref main"
check_contains "gate invokes revert checker" "$output" "check-cross-pr-reverts.ts --repo-dir"
check_contains "gate passes explicit integration ref rc" "$output" "rc=0"

output="$(run_cross_pr_gate_case empty_base_branch)"
check_contains "gate omits empty integration ref rc" "$output" "rc=0"
check_not_contains "gate omits empty integration ref flag" "$output" "--integration-ref"

output="$(run_cross_pr_gate_case omitted_base_branch)"
check_contains "gate supports omitted base branch rc" "$output" "rc=0"
check_not_contains "gate omits missing integration ref flag" "$output" "--integration-ref"

echo "=== Launch Ready Phase ==="

output="$(run_launch_case pending)"
check_contains "pending ready returns retry code" "$output" "rc=4"
check_contains "pending ready writes running stage result" "$output" "|ready|running|"
check_contains "pending ready records pending verdict" "$output" "\"verdict\":\"pending\""
check_contains "pending ready logs launch at info level" "$output" "logs=info   HOK-1300: Launching ready phase (PR #304)"
check_contains "pending ready logs retry message" "$output" "will retry"
check_contains "pending ready logs retry at info level" "$output" "info   CI checks pending for HOK-1300 (PR #304) - will retry"
check_not_contains "pending ready does not demote first poll to debug" "$output" "debug   CI checks pending for HOK-1300 (PR #304) - will retry"
check_contains "pending ready skips attention file" "$output" "attention_count=0"
check_contains "pending ready emits no errors" "$output" "error_count=0"

output="$(run_launch_case pending_re_check)"
check_contains "pending re-check returns retry code" "$output" "rc=4"
check_contains "pending re-check logs launch at debug level" "$output" "logs=debug   HOK-1300: Launching ready phase (PR #304)"
check_contains "pending re-check logs retry at debug level" "$output" "debug   CI checks pending for HOK-1300 (PR #304) - will retry"
check_not_contains "pending re-check does not log launch at info level" "$output" "info   HOK-1300: Launching ready phase (PR #304)"
check_not_contains "pending re-check does not log retry at info level" "$output" "info   CI checks pending for HOK-1300 (PR #304) - will retry"

output="$(run_launch_case cross_pr_revert_blocked)"
check_contains "cross-pr revert block returns failure" "$output" "rc=1"
check_contains "cross-pr revert block writes attention" "$output" "PR #304 removes files from #437 without explicit acknowledgement."
check_contains "cross-pr revert block includes file list" "$output" "Affected files: strategy.txt."
check_contains "cross-pr revert block records failed ready verdict" "$output" "\"verdict\":\"fail\""
check_contains "cross-pr revert block records guard evidence" "$output" "\"source\":\"cross-pr-revert-guard\""
check_contains "cross-pr revert block records checked head" "$output" "\"checkedHeadSha\":\"abc123\""
check_contains "cross-pr revert block logs status" "$output" "Cross-PR revert guard blocked ready phase for PR #304"
check_not_contains "cross-pr revert block does not run ready tool" "$output" "\"checksRun\":3"

output="$(run_launch_case cross_pr_revert_error)"
check_contains "cross-pr revert tool error returns failure" "$output" "rc=1"
check_contains "cross-pr revert tool error writes attention" "$output" "Cross-PR revert guard tool failure for PR #304: git-merge-base failed on ref 'auto/integration'"
check_contains "cross-pr revert tool error records failed ready verdict" "$output" "\"verdict\":\"fail\""
check_contains "cross-pr revert tool error records guard evidence" "$output" "\"status\":\"tool-error\""
check_contains "cross-pr revert tool error logs failure" "$output" "Cross-PR revert guard tool failure for HOK-1300 (PR #304): git-merge-base on 'auto/integration'"
check_not_contains "cross-pr revert error does not run ready tool" "$output" "\"checksRun\":3"

output="$(run_launch_case cross_pr_revert_tool_error_direct)"
check_contains "direct cross-pr tool error returns failure" "$output" "rc=1"
check_contains "direct cross-pr tool error writes attention" "$output" "Cross-PR revert guard tool failure for PR #304: git-merge-base failed on ref 'auto/integration'"
check_contains "direct cross-pr tool error includes diagnostic" "$output" "Diagnostic: fatal: Not a valid object name 'auto/integration'"
check_contains "direct cross-pr tool error writes ready diagnostic" "$output" "\"crossPrDiagnostic\""
check_contains "direct cross-pr tool error records checked head" "$output" "\"checkedHeadSha\":\"abc123\""
check_contains "direct cross-pr tool error records command class" "$output" "\"commandClass\":\"git-merge-base\""
check_contains "direct cross-pr tool error logs failure" "$output" "Cross-PR revert guard tool failure for HOK-1300 (PR #304): git-merge-base on 'auto/integration'"
check_contains "direct cross-pr tool error skips stage helper writes" "$output" "stage_calls="
check_not_contains "direct cross-pr tool error does not run ready tool" "$output" "\"checksRun\":3"

output="$(run_launch_case unknown_first)"
check_contains "unknown first poll returns retry code" "$output" "rc=4"
check_contains "unknown first poll writes running stage result" "$output" "|ready|running|"
check_contains "unknown first poll records pending verdict" "$output" "\"verdict\":\"pending\""
check_contains "unknown first poll tracks transient attempt" "$output" "\"transientMergeabilityAttempts\":1"
check_contains "unknown first poll leaves no attention file" "$output" "needs_attention=absent"
check_contains "unknown first poll leaves no transient attention marker" "$output" "transient_attention=absent"
check_contains "unknown first poll stores retry count" "$output" "transient_count=1"
check_contains "unknown first poll logs retry" "$output" "Merge status for HOK-1300 is UNKNOWN - will retry (attempt 1/6)"

output="$(run_launch_case error_first)"
check_contains "error first poll returns retry code" "$output" "rc=4"
check_contains "error first poll writes running stage result" "$output" "|ready|running|"
check_contains "error first poll records pending verdict" "$output" "\"verdict\":\"pending\""
check_contains "error first poll tracks transient attempt" "$output" "\"transientMergeabilityAttempts\":1"
check_contains "error first poll stores retry count" "$output" "transient_count=1"
check_contains "error first poll leaves no attention file" "$output" "needs_attention=absent"
check_contains "error first poll logs retry" "$output" "Merge status for HOK-1300 is ERROR - will retry (attempt 1/6)"

output="$(run_launch_case unknown_capped)"
check_contains "unknown capped returns failure" "$output" "rc=1"
check_contains "unknown capped writes attention" "$output" "Merge status UNKNOWN persisted after 7 checks for PR #304."
check_contains "unknown capped writes transient marker" "$output" "transient_attention=present"
check_contains "unknown capped keeps attention file" "$output" "needs_attention=present"
check_contains "unknown capped increments counter past cap" "$output" "transient_count=7"
check_contains "unknown capped logs persistent failure" "$output" "Merge status UNKNOWN persisted for HOK-1300 after 7 attempts"

output="$(run_launch_case remediation_launch)"
check_contains "first remediation launch returns rc 5" "$output" "rc=5"
check_contains "first remediation launch writes running stage result" "$output" "|ready|running|"
check_contains "first remediation launch records attempt 1" "$output" "\"remediationAttempts\":1"
check_contains "first remediation launch records current head" "$output" "\"remediationLaunchHead\":\"abc123\""
check_contains "first remediation launch records ci-status failure name" "$output" "\"remediationFailures\":[\"ci-status\"]"
check_contains "first remediation launch clears attention" "$output" "attention_count=0"
check_contains "first remediation launch invokes agent once" "$output" "launch_calls=1"
check_contains "first remediation launch builds prompt once" "$output" "prompt_calls=1"
check_contains "first remediation launch emits no errors" "$output" "error_count=0"

output="$(run_launch_case actionable_named_failure)"
check_contains "actionable named failure returns rc 5" "$output" "rc=5"
check_contains "actionable named failure launches remediation" "$output" "launch_calls=1"
check_contains "actionable named failure records failure name" "$output" "\"remediationFailures\":[\"lint\"]"
check_contains "actionable named failure summarizes direct check" "$output" "prompt_summary=lint: eslint failed"

output="$(run_launch_case actionable_compound_failure)"
check_contains "compound actionable failure returns rc 5" "$output" "rc=5"
check_contains "compound actionable failure launches once" "$output" "launch_calls=1"
check_contains "compound actionable failure records both failures" "$output" "\"remediationFailures\":[\"ci-status\",\"tests\"]"
check_contains "compound actionable failure summarizes both checks" "$output" "prompt_summary=ci-status: 1 CI check(s) failing (Shell and Unit Tests); tests: unit tests failed"

output="$(run_launch_case actionable_message_failure)"
check_contains "message-based actionable failure returns rc 5" "$output" "rc=5"
check_contains "message-based actionable failure launches remediation" "$output" "launch_calls=1"
check_contains "message-based actionable failure records direct name" "$output" "\"remediationFailures\":[\"ci-suite\"]"

output="$(run_launch_case second_remediation_launch)"
check_contains "second remediation launch returns rc 5" "$output" "rc=5"
check_contains "second remediation launch records attempt 2" "$output" "\"remediationAttempts\":2"

output="$(run_launch_case remediation_exhausted)"
check_contains "remediation exhaustion returns failure" "$output" "rc=1"
check_contains "remediation exhaustion writes failed stage result" "$output" "|ready|failed|"
check_contains "remediation exhaustion writes terse attention file" "$output" "Remediation exhausted after 3 attempt(s)"
check_contains "remediation exhaustion logs terse error" "$output" "Ready remediation exhausted"
check_not_contains "remediation exhaustion skips json dump" "$output" "error_payload=  {\"prNumber\":304"
check_contains "remediation exhaustion writes terminal sentinel" "$output" "remediation_retry_exhausted=present"

echo "=== Remediation Bounded Retry (HOK-2924) ==="

output="$(run_launch_case remediation_backoff_hold)"
check_contains "remediation backoff holds inside window" "$output" "rc=5"
check_contains "remediation backoff does not launch agent" "$output" "launch_calls=0"
check_contains "remediation backoff logs the hold" "$output" "holding ready remediation"

output="$(run_launch_case remediation_head_reset)"
check_contains "new head re-enables remediation launch" "$output" "launch_calls=1"
check_contains "new head restarts the attempt counter" "$output" "remediation_retry_count=1"
check_contains "new head remediation returns in-progress" "$output" "rc=5"

output="$(run_launch_case remediation_disabled)"
check_contains "disabled remediation falls back to ready failure" "$output" "rc=1"
check_contains "disabled remediation writes attention" "$output" "Ready checks failed for PR #304."
check_contains "disabled remediation logs failing check summary" "$output" "Ready checks failed for HOK-1300 - 1 failed (ci-status: 1 check), 0 passed/skipped"
check_contains "disabled remediation logs debug file pointer" "$output" "Full ready result: /tmp/wavemill-ready-phase-test-remediati"
check_not_contains "disabled remediation omits raw json from error log" "$output" "error_payload=  {\"prNumber\":304"
check_contains "disabled remediation writes debug record" "$output" "debug_lines=1"
check_contains "disabled remediation debug record preserves payload" "$output" "\"prNumber\":304"

output="$(run_launch_case non_ci_failure)"
check_contains "non ci failure returns failure" "$output" "rc=1"
check_contains "non ci failure does not launch agent" "$output" "launch_calls=0"
check_contains "non ci failure logs failing check summary" "$output" "release-requirements"
check_not_contains "non ci failure omits raw json from error log" "$output" "error_payload=  {\"prNumber\":304"
check_contains "non ci failure writes debug record" "$output" "debug_lines=1"

output="$(run_launch_case remediation_launch_failure)"
check_contains "launch failure returns failure" "$output" "rc=1"
check_contains "launch failure records failed stage" "$output" "|ready|failed|"
check_contains "launch failure writes operator message" "$output" "Could not launch remediation agent for PR #304."
check_contains "launch failure records attempt 1" "$output" "\"remediationAttempts\":1"

output="$(run_launch_case already_inflight_same_head)"
check_contains "inflight same head returns rc 5" "$output" "rc=5"
check_contains "inflight same head does not relaunch agent" "$output" "launch_calls=0"
check_contains "inflight same head does not rewrite stage" "$output" "stage_calls="

output="$(run_launch_case conflict_persists_after_remediation)"
check_contains "persistent conflict returns failure" "$output" "rc=1"
check_contains "persistent conflict writes attention" "$output" "PR #304 still has merge conflicts after automatic remediation."
check_contains "persistent conflict records attention head" "$output" "conflict_attention_head=abc123"
check_contains "persistent conflict records reported marker" "$output" "conflict_attention_reported=present"
check_contains "persistent conflict keeps detected marker" "$output" "conflict_detected=present"
check_contains "persistent conflict logs one terse error" "$output" "Merge conflicts persist for HOK-1300 after remediation attempt"

output="$(run_launch_case pass_after_remediation)"
check_contains "pass after remediation returns success" "$output" "rc=0"
check_contains "pass after remediation writes completed stage" "$output" "|ready|completed|"
check_contains "pass after remediation canonicalizes ready labels once" "$output" "ready_label_calls=1"
check_contains "pass after remediation records ready label update" "$output" "\"readyLabelsUpdated\":true"
check_not_contains "pass after remediation clears remediation artifacts" "$output" "\"remediationAttempts\":"
check_contains "pass after remediation clears conflict marker" "$output" "conflict_detected=absent"
check_contains "pass after remediation clears attention head" "$output" "conflict_attention_head="
check_contains "pass after remediation clears reported marker" "$output" "conflict_attention_reported=absent"
check_contains "pass after remediation clears needs attention" "$output" "needs_attention=absent"
check_contains "pass after remediation demotes label canonicalization to debug" "$output" "debug   HOK-1300: Canonicalized ready labels for PR #304"
check_contains "pass after remediation demotes ready completion to debug" "$output" "debug   HOK-1300: Ready checks completed (verdict: pass)"
check_not_contains "pass after remediation no longer emits label canonicalization at status" "$output" "status   HOK-1300: Canonicalized ready labels for PR #304"

output="$(run_launch_case review_tool_error_gate)"
check_contains "review tool error gate retries review" "$output" "rc=6"
check_contains "review tool error gate probes runtime" "$output" "agent_validate_calls=1"
check_contains "review tool error gate relaunches review" "$output" "review_launch_calls=1"
check_contains "review tool error gate increments infra retry" "$output" "infra_retry_count=1"

output="$(run_launch_case infra_retry_healthy)"
check_contains "infra retry healthy returns relaunch rc" "$output" "rc=6"
check_contains "infra retry healthy probes runtime" "$output" "agent_validate_calls=1"
check_contains "infra retry healthy prepares recovery" "$output" "prepare_recovery_calls=1"
check_contains "infra retry healthy launches review" "$output" "review_launch_calls=1"
check_contains "infra retry healthy increments counter" "$output" "infra_retry_count=1"

output="$(run_launch_case infra_retry_unhealthy)"
check_contains "infra retry unhealthy refuses ready" "$output" "rc=1"
check_contains "infra retry unhealthy probes runtime" "$output" "agent_validate_calls=1"
check_contains "infra retry unhealthy does not launch review" "$output" "review_launch_calls=0"
check_contains "infra retry unhealthy does not increment counter" "$output" "infra_retry_count="
check_contains "infra retry unhealthy writes waiting attention" "$output" "waiting for reviewer runtime recovery"

output="$(run_launch_case infra_retry_capped)"
check_contains "infra retry capped refuses ready" "$output" "rc=1"
check_contains "infra retry capped does not probe" "$output" "agent_validate_calls=0"
check_contains "infra retry capped keeps counter" "$output" "infra_retry_count=2"
check_contains "infra retry capped writes manual attention" "$output" "manual re-review required"

# HOK-2964 REQ-F1: native-context-window-exceeded enters bounded infra
# recovery instead of terminal code-defect handling.
output="$(run_launch_case infra_retry_context_window)"
check_contains "context window retries review" "$output" "rc=6"
check_contains "context window launches review" "$output" "review_launch_calls=1"
check_contains "context window increments infra retry" "$output" "infra_retry_count=1"

# HOK-2964 REQ-F2/F4: a new head at the same failure category resets the
# bounded budget instead of inheriting the exhausted attempt count.
output="$(run_launch_case infra_retry_context_window_scope_refreshed)"
check_contains "context window scope refresh retries review" "$output" "rc=6"
check_contains "context window scope refresh resets counter" "$output" "infra_retry_count=1"

# HOK-2964 REQ-F3: unchanged context-window overflow at the same head
# eventually exhausts with an actionable capacity diagnostic, never a
# synthesized pass.
output="$(run_launch_case infra_retry_context_window_exhausted)"
check_contains "context window exhausted refuses ready" "$output" "rc=1"
check_contains "context window exhausted does not launch review" "$output" "review_launch_calls=0"
check_contains "context window exhausted names the category" "$output" "native-context-window-exceeded"
check_contains "context window exhausted gives actionable diagnostic" "$output" "larger-context reviewer or manual scope reduction"

# HOK-2964 REQ-F5: typed OpenRouter 402/credit failures recover within the
# bounded budget, keeping the same intended reviewer identity.
output="$(run_launch_case infra_retry_provider_credit_exhausted)"
check_contains "provider credit retries review" "$output" "rc=6"
check_contains "provider credit launches review" "$output" "review_launch_calls=1"
check_contains "provider credit increments infra retry" "$output" "infra_retry_count=1"

# HOK-2964 REQ-F6: exhausted provider-capacity recovery keeps Ready blocked
# and leaves actionable terminal evidence for challenge forfeit resolution.
output="$(run_launch_case infra_retry_provider_credit_exhausted_capped)"
check_contains "provider credit exhausted refuses ready" "$output" "rc=1"
check_contains "provider credit exhausted does not launch review" "$output" "review_launch_calls=0"
check_contains "provider credit exhausted names the category" "$output" "provider-credit-exhausted"
check_contains "provider credit exhausted gives actionable diagnostic" "$output" "Top up credits"

output="$(run_launch_case infra_retry_error_tool)"
check_contains "infra retry tool timeout retries review" "$output" "rc=6"
check_contains "infra retry tool timeout launches review" "$output" "review_launch_calls=1"

# HOK-2889: a not_ready verdict whose failure is classified as
# review-scope-unverifiable is retryable infrastructure, not a permanent refusal.
output="$(run_launch_case infra_retry_scope_unverifiable)"
check_contains "scope unverifiable retries review" "$output" "rc=6"
check_contains "scope unverifiable launches review" "$output" "review_launch_calls=1"
check_contains "scope unverifiable increments infra retry" "$output" "infra_retry_count=1"

output="$(run_launch_case verdictless_completed_recovery)"
check_contains "verdictless completed retries review" "$output" "rc=6"
check_contains "verdictless completed launches review" "$output" "review_launch_calls=1"
check_contains "verdictless completed increments infra retry" "$output" "infra_retry_count=1"

output="$(run_launch_case missing_review_recovery)"
check_contains "missing review retries review" "$output" "rc=6"
check_contains "missing review launches review" "$output" "review_launch_calls=1"
check_contains "missing review increments infra retry" "$output" "infra_retry_count=1"

output="$(run_launch_case verdictless_running_recovery)"
check_contains "verdictless running retries review" "$output" "rc=6"
check_contains "verdictless running launches review" "$output" "review_launch_calls=1"
check_contains "verdictless running increments infra retry" "$output" "infra_retry_count=1"

output="$(run_launch_case infra_retry_running_preserved_failure)"
check_contains "running preserved infra verdict retries review" "$output" "rc=6"
check_contains "running preserved infra verdict launches review" "$output" "review_launch_calls=1"
check_contains "running preserved infra verdict increments infra retry" "$output" "infra_retry_count=1"

# HOK-2889 (other direction): a plain not_ready with no failure category is a
# genuine review failure and must refuse without any infra retry.
output="$(run_launch_case review_not_ready_no_category)"
check_contains "plain not_ready refuses ready" "$output" "rc=1"
check_contains "plain not_ready does not launch review" "$output" "review_launch_calls=0"
check_not_contains "plain not_ready does not increment infra retry" "$output" "infra_retry_count=1"
check_contains "plain not_ready writes readiness attention" "$output" "Review verdict does not pass readiness gate"
check_contains "plain not_ready marks failed verdict" "$output" "verdictState=failed"

# HOK-2932: a completed not_ready artifact whose only blocker is auditably
# dismissed (non-blank justification) passes the ready gate — the ready phase
# launches, completes, and applies wm:ready instead of parking the arm.
output="$(run_launch_case dismissed_blockers_pass)"
check_contains "dismissed blockers pass returns success" "$output" "rc=0"
check_contains "dismissed blockers pass writes completed stage" "$output" "|ready|completed|"
check_contains "dismissed blockers pass canonicalizes ready labels" "$output" "ready_label_calls=1"
check_not_contains "dismissed blockers pass emits no readiness refusal" "$output" "Review verdict does not pass readiness gate"
check_not_contains "dismissed blockers pass does not relaunch review" "$output" "review_launch_calls=1"

# HOK-2932 fail-closed: a dismissal with a blank justification is rejected and
# the artifact still refuses readiness like any other unresolved blocker.
output="$(run_launch_case dismissed_blockers_invalid)"
check_contains "invalid dismissal refuses ready" "$output" "rc=1"
check_contains "invalid dismissal does not launch review" "$output" "review_launch_calls=0"
check_contains "invalid dismissal writes readiness attention" "$output" "Review verdict does not pass readiness gate"
check_contains "invalid dismissal marks failed verdict" "$output" "verdictState=failed"

output="$(run_launch_case ready_label_failure)"
check_contains "ready label failure returns failure" "$output" "rc=1"
check_contains "ready label failure writes failed stage" "$output" "|ready|failed|"
check_contains "ready label failure attempts label restore once" "$output" "ready_label_calls=1"
check_contains "ready label failure keeps attention" "$output" "needs_attention=present"
check_contains "ready label failure writes operator message" "$output" "Ready passed for PR #304, but updating wm:ready labels failed."
check_contains "ready label failure records label update failure" "$output" "\"readyLabelsUpdated\":false"
check_contains "ready label failure logs terse error" "$output" "Ready passed for HOK-1300 but failed to restore PR labels"

output="$(run_launch_case clean_after_unknown)"
check_contains "clean after unknown returns success" "$output" "rc=0"
check_contains "clean after unknown clears attention" "$output" "needs_attention=absent"
check_contains "clean after unknown clears transient marker" "$output" "transient_attention=absent"
check_contains "clean after unknown clears transient count" "$output" "transient_count="

output="$(run_launch_case clean_with_stderr)"
check_contains "success stderr is not treated as error" "$output" "error_count=0"
check_not_contains "success path does not log ready stderr" "$output" "[ready stderr] ⚠️  MERGE CONFLICT: PR #304 has conflicts with main"

output="$(run_launch_case fail_with_stderr)"
check_contains "failure stderr is logged as error" "$output" "error_payload=  [ready stderr] TypeError: ready crashed"
check_not_contains "failure stderr does not leak to terminal" "$output" $'\nTypeError: ready crashed\n'

echo "=== Failed-Ready Re-check Budget ==="

output="$(run_recheck_case counter_roundtrip)"
check_contains "recheck counter starts at zero" "$output" "c0=0"
check_contains "recheck counter increments to one" "$output" "c1=1"
check_contains "recheck counter increments to two" "$output" "c2=2"
check_contains "recheck counter stores launch head" "$output" "head_stored=aaa"
check_contains "recheck counter treats garbage as zero" "$output" "cg=0"
check_contains "recheck clear removes all budget files" "$output" "remaining=0"

output="$(run_recheck_case head_reset)"
check_contains "same head preserves recheck count" "$output" "same_head_count=1"
check_contains "empty head preserves recheck count" "$output" "empty_head_count=1"
check_contains "new head resets recheck count" "$output" "new_head_count=0"
check_contains "new head clears exhausted sentinel" "$output" "sentinel=absent"

output="$(run_recheck_case backoff_schedule)"
check_contains "backoff after first attempt is base" "$output" "d1=120"
check_contains "backoff after second attempt doubles" "$output" "d2=240"
check_contains "backoff after third attempt doubles again" "$output" "d3=480"
check_contains "backoff treats garbage count as one" "$output" "dg=120"
check_contains "backoff caps at ceiling" "$output" "d9=1800"
check_contains "backoff respects custom cap" "$output" "dcap=1500"
check_contains "backoff falls back on non-numeric env" "$output" "dbad=240"
check_contains "backoff respects base override" "$output" "dover=1"

output="$(run_recheck_case due_logic)"
check_contains "recheck due when no last-at file" "$output" "no_file=due"
check_contains "recheck not due right after attempt" "$output" "fresh=not-due"
check_contains "recheck due after backoff elapses" "$output" "elapsed=due"
check_contains "recheck due when last-at is garbage" "$output" "garbage_last=due"

output="$(run_recheck_case gate_dispositions)"
check_contains "gate proceeds on fresh state" "$output" "g_fresh=proceed"
check_contains "gate backs off after an attempt" "$output" "g_backoff=backoff"
check_contains "gate proceeds once backoff elapses" "$output" "g_elapsed=proceed"
check_contains "gate exhausts at attempt ceiling" "$output" "g_ceiling=exhausted"
check_contains "gate goes quiet once terminalized" "$output" "g_quiet=exhausted-quiet"
check_contains "gate proceeds again on new head" "$output" "g_newhead=proceed"
check_contains "new head grants fresh budget" "$output" "newhead_count=0"

output="$(run_recheck_case identical_streak)"
check_contains "first observation starts streak" "$output" "s1=1"
check_contains "repeated finishedAt leaves streak unchanged" "$output" "s_repeat=1"
check_contains "second identical reason grows streak" "$output" "s2=2"
check_contains "third identical reason grows streak" "$output" "s3=3"
check_contains "identical streak exhausts below ceiling" "$output" "g_streak=exhausted"
check_contains "different reason resets streak" "$output" "s_reset=1"

output="$(run_recheck_case exhaustion_oneshot)"
check_contains "exhaustion mark reports first time" "$output" "first=first"
check_contains "exhaustion mark is one-shot" "$output" "second=not-first"
check_contains "second exhaustion mark leaves result untouched" "$output" "unchanged=unchanged"
check_contains "exhaustion annotates ready result" "$output" "exhausted_flag=true"
check_contains "exhaustion records attempt count" "$output" "attempts=4"
check_contains "exhaustion records last reason" "$output" "last_reason=guard blocked"
check_contains "exhaustion preserves existing failure reason" "$output" "failure_reason=guard blocked"
check_contains "exhaustion preserves cross-pr guard evidence" "$output" "guard_kept=cross-pr-revert-guard"
check_contains "exhaustion logs a single error" "$output" "error_count=1"
check_contains "exhaustion attention names the gate" "$output" "attention=Failed-ready re-checks exhausted after 4 attempt(s) for PR #304: guard blocked"
check_contains "exhaustion tolerates missing ready result" "$output" "missing_result=first"
check_contains "exhaustion without result uses fallback reason" "$output" "missing_attention=Failed-ready re-checks exhausted after 2 attempt(s) for PR #304: ready checks failed"

output="$(run_recheck_case fresh_budget_after_success)"
check_contains "gate proceeds before transient failure" "$output" "g1=proceed"
check_contains "success clears the budget" "$output" "cleared_count=0"
check_contains "gate proceeds again after success" "$output" "g2=proceed"

output="$(run_launch_case pass_clears_recheck)"
check_contains "ready pass returns success" "$output" "rc=0"
check_contains "ready pass writes completed stage result" "$output" "|ready|completed|"
check_contains "ready pass clears recheck budget files" "$output" "recheck_files=absent,absent,absent,absent,absent"

echo "=== Watchdog Launch Helper ==="

output="$(run_watchdog_launch_case success)"
check_contains "watchdog launch succeeds" "$output" '"status":"launched"'
check_contains "watchdog launch writes running stage" "$output" "|ready|running|"
check_contains "watchdog launch invokes agent" "$output" "launch_calls=1"
check_contains "watchdog launch reuses prompt summary" "$output" "prompt_summary=Alembic Check (FAILURE)"

output="$(run_watchdog_launch_case max_attempts)"
check_contains "watchdog max attempts skips launch" "$output" '"status":"skipped-max-attempts"'
check_contains "watchdog max attempts does not relaunch agent" "$output" "launch_calls=0"
check_contains "watchdog max attempts does not rewrite stage" "$output" "stage_calls="

output="$(run_watchdog_launch_case inflight_same_head)"
check_contains "watchdog inflight skips launch" "$output" '"status":"skipped-in-flight"'
check_contains "watchdog inflight does not relaunch agent" "$output" "launch_calls=0"
check_contains "watchdog inflight does not rewrite stage" "$output" "stage_calls="

echo "=== Sequential Failing Launch Scenario ==="

output="$(run_launch_case sequential_failing_launch_1)"
check_contains "sequential attempt 1 returns failure" "$output" "rc=1"
check_contains "sequential attempt 1 records attempt 1" "$output" "\"remediationAttempts\":1"
check_contains "sequential attempt 1 invokes agent once" "$output" "launch_calls=1"

output="$(run_launch_case sequential_failing_launch_2)"
check_contains "sequential attempt 2 returns failure" "$output" "rc=1"
check_contains "sequential attempt 2 records attempt 2" "$output" "\"remediationAttempts\":2"
check_contains "sequential attempt 2 invokes agent once" "$output" "launch_calls=1"

output="$(run_launch_case sequential_failing_launch_3)"
check_contains "sequential attempt 3 returns failure" "$output" "rc=1"
check_contains "sequential attempt 3 records attempt 3" "$output" "\"remediationAttempts\":3"
check_contains "sequential attempt 3 invokes agent once" "$output" "launch_calls=1"

echo "=== Native Route Scenario ==="

output="$(run_launch_case native_route_coder_model)"
check_contains "native route uses coder model" "$output" "launch_calls=1"
check_contains "native route passes model to launch" "$output" "rc=5"
check_contains "native route records attempt 1" "$output" "\"remediationAttempts\":1"

echo "=== No Model Scenario ==="

output="$(run_launch_case no_model_available)"
check_contains "no model scenario fails" "$output" "rc=1"
check_contains "no model scenario records attempt 1" "$output" "\"remediationAttempts\":1"
check_contains "no model scenario does not invoke agent" "$output" "launch_calls=0"
check_contains "no model scenario writes clear reason" "$output" "No model configured for ready remediation"

echo "=== Launch Phase Propagation ==="

output="$(run_launch_case remediation_launch)"
check_contains "remediation passes explicit phase" "$output" "phase_used=coding"

echo "=== Post-PR Reconciliation Capsule (HOK-2936) ==="

run_recon_case() {
  local test_case="$1"
  local case_dir="$TEST_TMP/recon-$test_case"
  rm -rf "$case_dir"
  mkdir -p "$case_dir"

  CASE_DIR="$case_dir" LAUNCH_FUNC_FILE="$LAUNCH_FUNC_FILE" COMMON_SCRIPT="$COMMON_SCRIPT" \
    REAL_REPO_DIR="$REPO_DIR" TEST_CASE="$test_case" bash -lc '
    set -euo pipefail
    source "$COMMON_SCRIPT"
    source "$LAUNCH_FUNC_FILE"

    TOOLS_DIR="$REAL_REPO_DIR/tools"
    STATE_DIR="$CASE_DIR/feature"
    WT_DIR="$CASE_DIR/worktree"
    mkdir -p "$STATE_DIR" "$WT_DIR"

    case "$TEST_CASE" in
      flag_default_off)
        echo "default_enabled=$(post_pr_reconciliation_enabled "$WT_DIR")"
        printf "%s\n" "{\"ready\":{\"postPrReconciliation\":{\"enabled\":true}}}" > "$WT_DIR/.wavemill-config.json"
        HOME="$CASE_DIR" echo "repo_enabled=$(post_pr_reconciliation_enabled "$WT_DIR")"
        ;;
      fingerprint_reset)
        printf "%s\n" "2" > "$STATE_DIR/.retry-ready-remediation-count"
        reconciliation_reset_retry_if_new_fingerprint "$STATE_DIR" "ready-remediation" "fp-one"
        echo "same_count=$(bounded_retry_count "$STATE_DIR" "ready-remediation")"
        reconciliation_reset_retry_if_new_fingerprint "$STATE_DIR" "ready-remediation" "fp-one"
        echo "repeat_count=$(bounded_retry_count "$STATE_DIR" "ready-remediation")"
        reconciliation_reset_retry_if_new_fingerprint "$STATE_DIR" "ready-remediation" "fp-two"
        echo "new_fp_count=$(bounded_retry_count "$STATE_DIR" "ready-remediation")"
        ;;
      capsule_gate)
        git -C "$CASE_DIR" init -q
        git -C "$CASE_DIR" -c user.email=t@t -c user.name=t commit -q --allow-empty -m fixture
        printf "%s\n" "{not json" > "$STATE_DIR/.reconciliation-context.json"
        rc=0
        reconciliation_project_prompt "$STATE_DIR" 304 "$CASE_DIR/prompt.txt" || rc=$?
        echo "malformed_rc=$rc"
        echo "malformed_attention=$(cat "$STATE_DIR/.needs-attention" 2>/dev/null | tr "\n" " ")"
        rm -f "$STATE_DIR/.reconciliation-context.json" "$STATE_DIR/.needs-attention"
        rc=0
        reconciliation_project_prompt "$STATE_DIR" 304 "$CASE_DIR/prompt.txt" || rc=$?
        echo "missing_rc=$rc"
        echo "missing_attention=$(cat "$STATE_DIR/.needs-attention" 2>/dev/null | tr "\n" " ")"
        ;;
      capsule_project)
        npx tsx "$TOOLS_DIR/reconciliation-capsule.ts" build \
          --feature-dir "$STATE_DIR" --task-id HOK-2936 --title "Recon test" \
          --slug recon-test --branch task/recon --base-branch main --pr 304 \
          --review-head aaa111aaa111aaa111aaa111aaa111aaa111aaa1 --review-verdict ready >/dev/null
        npx tsx "$TOOLS_DIR/reconciliation-capsule.ts" update-incident \
          --feature-dir "$STATE_DIR" --classification merge_conflict \
          --head aaa111aaa111aaa111aaa111aaa111aaa111aaa1 --detail "conflict test" >/dev/null
        rc=0
        reconciliation_project_prompt "$STATE_DIR" 304 "$CASE_DIR/prompt.txt" || rc=$?
        echo "project_rc=$rc"
        foundation_line=$(grep -n "Task foundation" "$CASE_DIR/prompt.txt" | head -1 | cut -d: -f1)
        incident_line=$(grep -n "Current incident" "$CASE_DIR/prompt.txt" | head -1 | cut -d: -f1)
        if [[ -n "$foundation_line" && -n "$incident_line" ]] && (( foundation_line < incident_line )); then
          echo "projection_order=foundation-first"
        else
          echo "projection_order=wrong"
        fi
        ;;
      review_invalidation)
        git -C "$WT_DIR" init -q
        git -C "$WT_DIR" -c user.email=t@t -c user.name=t commit -q --allow-empty -m one
        old_head=$(git -C "$WT_DIR" rev-parse HEAD)
        cat > "$STATE_DIR/.review-result.json" <<EOF
{"stage":"review","status":"completed","artifacts":{"type":"review","prNumber":304,"exitCode":0,"verdict":"ready","iterations":1,"blockerCount":0}}
EOF
        printf "%s\n" "{\"review\":{\"reviewHeadSha\":\"$old_head\"},\"attempts\":[]}" > "$STATE_DIR/.reconciliation-context.json"
        rc=0; reconciliation_review_invalidated_by_commit "$STATE_DIR" "$WT_DIR" || rc=$?
        echo "no_attempts_same_head_rc=$rc"
        git -C "$WT_DIR" -c user.email=t@t -c user.name=t commit -q --allow-empty -m two
        new_head=$(git -C "$WT_DIR" rev-parse HEAD)
        rc=0; reconciliation_review_invalidated_by_commit "$STATE_DIR" "$WT_DIR" || rc=$?
        echo "no_attempts_new_head_rc=$rc"
        printf "%s\n" "{\"review\":{\"reviewHeadSha\":\"$old_head\"},\"attempts\":[{\"attemptNumber\":1}]}" > "$STATE_DIR/.reconciliation-context.json"
        rc=0; reconciliation_review_invalidated_by_commit "$STATE_DIR" "$WT_DIR" || rc=$?
        echo "attempt_new_head_rc=$rc"
        reconciliation_mark_review_stale "$STATE_DIR" 304 "$old_head" "$new_head" || true
        echo "stale_status=$(jq -r .status "$STATE_DIR/.review-result.json")"
        rc=0; review_result_passes_ready_gate "$STATE_DIR" || rc=$?
        echo "gate_after_stale_rc=$rc"
        ;;
    esac
  '
}

output="$(run_recon_case flag_default_off)"
check_contains "reconciliation flag defaults off" "$output" "default_enabled=false"
check_contains "reconciliation flag honors repo config" "$output" "repo_enabled=true"

output="$(run_recon_case fingerprint_reset)"
check_contains "same fingerprint keeps retry budget" "$output" "same_count=2"
check_contains "repeat fingerprint keeps retry budget" "$output" "repeat_count=2"
check_contains "new fingerprint starts a new episode" "$output" "new_fp_count=0"

output="$(run_recon_case capsule_gate)"
check_contains "malformed capsule refuses projection" "$output" "malformed_rc=1"
check_contains "malformed capsule surfaces typed reason" "$output" "capsule_malformed"
check_contains "missing capsule refuses projection" "$output" "missing_rc=1"
check_contains "missing capsule surfaces typed reason" "$output" "capsule_missing"

output="$(run_recon_case capsule_project)"
check_contains "valid capsule projects a prompt" "$output" "project_rc=0"
check_contains "projection puts foundation before incident" "$output" "projection_order=foundation-first"

output="$(run_recon_case review_invalidation)"
check_contains "no attempts and same head keeps review valid" "$output" "no_attempts_same_head_rc=1"
check_contains "head advance without attempts keeps review valid" "$output" "no_attempts_new_head_rc=1"
check_contains "reconciliation commit invalidates review" "$output" "attempt_new_head_rc=0"
check_contains "stale review is recorded" "$output" "stale_status=stale"
check_contains "ready gate refuses stale review" "$output" "gate_after_stale_rc=1"

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
