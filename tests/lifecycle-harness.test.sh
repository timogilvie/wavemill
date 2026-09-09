#!/usr/bin/env bash
set -euo pipefail

# Headless mill lifecycle harness.
#
# This test runs one real controller tick at a time against a disposable git
# repository. It keeps the lifecycle/state-machine path real where the PR #294
# regression lived:
#
#   - monitor_issue_state()
#   - resolve_phase()
#   - approve_plan()
#   - validate_planning_phase_output()
#   - stage-result read/write helpers
#
# External boundaries are stubbed so the harness never launches agents, mutates
# tmux, calls gh, or updates Linear. The disposable worktree still uses real git
# status/diff behavior, real stage-result files, features/<slug>/ layout, and
# .wavemill runtime artifacts.
#
# To add a scenario:
#   1. Create a test_<scenario_name>() function.
#   2. Call harness_init_repo to create a disposable worktree.
#   3. Call harness_setup_planning_state with the desired stage status.
#   4. Add runtime/source artifacts needed by the scenario.
#   5. Call harness_run_tick, optionally passing extra setup code that overrides
#      a stub or extracted function inside the tick subshell.
#   6. Assert filesystem and emitted key/value state with check_* helpers.
#
# Run standalone:
#   bash tests/lifecycle-harness.test.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

check_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$name"
  else
    echo "    expected: $expected"
    echo "    actual:   $actual"
    fail "$name"
  fi
}

check_ne() {
  local name="$1" unexpected="$2" actual="$3"
  if [[ "$unexpected" != "$actual" ]]; then
    pass "$name"
  else
    echo "    unexpected: $unexpected"
    fail "$name"
  fi
}

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
  if [[ "$haystack" != *"$needle"* ]]; then
    pass "$name"
  else
    echo "    unexpected: $needle"
    fail "$name"
  fi
}

check_file_exists() {
  local name="$1" path="$2"
  if [[ -e "$path" ]]; then
    pass "$name"
  else
    fail "$name"
  fi
}

check_file_absent() {
  local name="$1" path="$2"
  if [[ ! -e "$path" ]]; then
    pass "$name"
  else
    fail "$name"
  fi
}

harness_file_mtime_epoch() {
  local path="$1"
  if stat -c %Y "$path" 2>/dev/null; then
    return 0
  fi
  stat -f %m "$path" 2>/dev/null
}

harness_backdate_file() {
  local path="$1"
  perl -e 'my $path = shift; my $t = time - 30; utime $t, $t, $path or die $!; print "$t\n";' "$path"
}

kv_value() {
  local output="$1" key="$2"
  awk -F= -v key="$key" '$1 == key { print substr($0, length(key) + 2); exit }' <<< "$output"
}

extract_function() {
  local source_file="$1"
  local function_name="$2"
  awk -v name="$function_name" '
    function brace_delta(line, stripped, opens, closes) {
      stripped = line
      gsub(/"([^"\\]|\\.)*"/, "\"\"", stripped)
      gsub(/\047([^\047\\]|\\.)*\047/, "\047\047", stripped)
      opens = gsub(/\{/, "{", stripped)
      closes = gsub(/\}/, "}", stripped)
      return opens - closes
    }
    $0 ~ "^" name "\\(\\)[[:space:]]*\\{" {
      capture = 1
      depth = 0
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

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

REAL_FUNC_FILE="$TEST_TMP/lifecycle-real-functions.sh"

harness_extract_real_functions() {
  local func
  cat "$REPO_DIR/shared/lib/transient-marker.sh" > "$REAL_FUNC_FILE"
  for func in \
    trim_outer_whitespace \
    merge_retry_marker_until \
    lane_progress_patch_json \
    refresh_ready_merge_queue_tick \
    wavemill_run_tsx_tool \
    get_main_head_sha \
    ready_stage_allows_merge \
    ready_stage_pending_verdict \
    clear_transient_mergeability_state \
    post_pr_reconciliation_config_json \
    post_pr_reconciliation_enabled \
    pane_release_config_json \
    pane_release_enabled \
    pane_release_marker_path \
    pane_release_reason_actionable \
    write_pane_release_blocked_marker \
    clear_stale_pane_release_blocked_marker \
    fresh_hook_state_for_issue \
    pane_release_preflight \
    release_task_pane_window_only \
    release_task_pane \
    prepare_released_task_for_reconciliation \
    ensure_ready_worker_window \
    review_result_passes_ready_gate \
    reconciliation_review_invalidated_by_commit \
    log_ready_stale_merge_lane_once \
    resolve_pair_on_primary_merge \
    cleanup_merged_primary_challenge_task \
    monitor_issue_state \
    capture_planning_baseline \
    validate_planning_phase_output \
    planning_rejection_files_summary \
    write_planning_rejection_artifact \
    notify_planning_rejection_agent \
    blocked_completion_announce_marker \
    blocked_completion_should_announce \
    mark_blocked_completion_announced \
    blocked_completion_live_process_mode \
    emit_blocked_completion_liveness_attention \
    seam_artifact_cli_path \
    seam_validate_artifact \
    seam_validation_error_summary \
    seam_validation_has_code \
    write_coding_complete_marker \
    wavemill_capacity_stall_seconds \
    codex_capacity_recovery_marker \
    codex_capacity_dwell_marker \
    codex_capacity_clear_dwell_marker \
    codex_capacity_pane_tail \
    codex_capacity_tail_has_terminal_prompt \
    codex_capacity_hook_status \
    codex_capacity_record_dwell \
    codex_capacity_idle_confirmed \
    write_codex_capacity_blocked_completion \
    blocked_completion_current_head \
    coding_output_dirty_paths \
    blocked_completion_commit_matches_head \
    wavemill_owned_feature_artifact_path \
    wavemill_owned_dirty_path \
    blocked_completion_auto_allowed_dirty_path \
    blocked_completion_worktree_clean_for_auto \
    coding_uncommitted_output_announce_marker \
    coding_uncommitted_output_should_announce \
    mark_coding_uncommitted_output_announced \
    clear_coding_uncommitted_output_attention \
    coding_compare_commit_counts \
    write_coding_uncommitted_output_artifact \
    guard_coding_complete_handoff \
    blocked_completion_validate_for_advance \
    archive_stale_coding_artifacts \
    complete_coding_advance \
    auto_advance_blocked_completion \
    emit_blocked_completion_attention \
    native_launch_failure_artifact_path \
    stage_result_field \
    agent_or_model_is_native_for_recovery \
    native_launch_failure_kind \
    write_native_launch_failure_artifact \
    emit_native_launch_failure_attention \
    native_hook_terminal_failure_detail \
    native_coding_failure_handoff_reason \
    native_terminal_failure_kind \
    native_terminal_failure_next_action \
    emit_native_terminal_failure_attention \
    challenge_varied_stage_model \
    challenge_result_stage_for_launch \
    challenge_stage_for_launch_env \
    challenge_abort_for_unresolvable_varied_model \
    challenge_guard_varied_model_resolvable \
    coding_missing_blocked_completion_announce_marker \
    _coding_terminal_blocked_completion_detected \
    emit_terminal_blocked_completion_attention \
    recover_misplaced_coding_complete_marker \
    recover_misplaced_plan_md \
    planning_premature_approval_announce_marker \
    surface_premature_plan_approval \
    _coding_divergence_announce_marker \
    _detect_coding_pane_divergence \
    emit_pane_divergence_attention \
    coding_pane_replacement_intent_path \
    record_coding_pane_replacement_intent \
    _tmux_window_target_exists \
    _tmux_target_join \
    _tmux_task_window_target \
    coding_pane_expected_replacement_path \
    mark_coding_pane_expected_replacement \
    clear_coding_pane_expected_replacement \
    consume_coding_pane_expected_replacement \
    coding_pane_replacement_intent_matches \
    clear_coding_pane_replacement_intent \
    quarantine_completed_coding_pane \
    _ensure_task_window_exists \
    handle_planning_overreach_rejection \
    validate_coding_phase_output \
    resolve_phase \
    resolve_stage_result_model \
    approve_plan \
    write_stage_result \
    write_stage_result_with_history \
    _write_stage_result_trace_event \
    read_stage_status \
    read_stage_result \
    check_stage_complete \
    check_stage_awaiting_user \
    check_stage_aborted \
    phase_launch_head \
    phase_launch_gate \
    _run_phase_launch \
    reap_completed_planning_pane \
    persist_challenge_execution_intent \
    finalize_challenge_execution_intent_before_coding \
    phase_should_remain_active_without_pr \
    stage_result_is_in_progress \
    ready_conflict_launch_head \
    _persist_phase \
    expansion_recovery_resolve_issue_id \
    recover_missing_expansion_artifact \
    handle_expanded_reroute_handoff_failure
  do
    local extracted source_file
    # trim_outer_whitespace is defined only in the parent mill script; every
    # other extracted controller function lives in the monitor script.
    source_file="$MONITOR_SCRIPT_FILE"
    [[ "$func" == "trim_outer_whitespace" ]] && source_file="$MILL_SCRIPT"
    extracted="$(extract_function "$source_file" "$func")"
    if [[ -z "$extracted" ]]; then
      echo "Could not extract $func() from $source_file" >&2
      exit 1
    fi
    printf '%s\n\n' "$extracted" >> "$REAL_FUNC_FILE"
  done
}

harness_init_repo() {
  local slug="$1"
  local repo
  repo="$TEST_TMP/$slug"
  mkdir -p "$repo"

  git -C "$repo" init -q
  git -C "$repo" config user.email "tests@example.com"
  git -C "$repo" config user.name "Wavemill Tests"
  git -C "$repo" checkout -q -b main

  mkdir -p "$repo/features/$slug"
  printf 'initial\n' > "$repo/README.md"
  git -C "$repo" add README.md
  git -C "$repo" commit -q -m "Initial commit"

  printf '%s\n' "$repo"
}

harness_setup_planning_state() {
  local repo="$1" slug="$2" status="$3"
  local feature_dir="$repo/features/$slug"
  mkdir -p "$feature_dir"

  printf '# Plan\n\nReady for approval.\n' > "$feature_dir/plan.md"
  touch "$feature_dir/.plan-approved"
  cat > "$feature_dir/.planning-result.json" <<EOF
{
  "stage": "planning",
  "status": "$status",
  "startedAt": "2026-04-15T00:00:00Z",
  "finishedAt": null,
  "agent": "codex",
  "model": "test-model",
  "notes": ""
}
EOF

  git -C "$repo" add "features/$slug/plan.md" "features/$slug/.plan-approved" "features/$slug/.planning-result.json"
  git -C "$repo" commit -q -m "Add planning state"
}

harness_setup_runtime_artifacts() {
  local repo="$1"
  mkdir -p "$repo/.wavemill/logs"
  printf '{"warning":"linear validation unavailable"}\n' > "$repo/.wavemill/logs/linear-validation-warnings.jsonl"
}

harness_setup_coding_state() {
  local repo="$1" slug="$2" status="${3:-running}"
  local feature_dir="$repo/features/$slug"
  mkdir -p "$feature_dir"

  cat > "$feature_dir/.coding-result.json" <<EOF
{
  "stage": "coding",
  "status": "$status",
  "startedAt": "2026-04-15T00:00:00Z",
  "finishedAt": null,
  "agent": "codex",
  "model": "test-model",
  "notes": ""
}
EOF
}

harness_seed_bootstrap_route() {
  local repo="$1" slug="$2"
  local feature_dir="$repo/features/$slug"
  mkdir -p "$feature_dir"

  cat > "$feature_dir/.initial-route.json" <<'EOF'
{
  "planner": "bootstrap-planner",
  "coder": "bootstrap-coder",
  "reviewer": "bootstrap-reviewer",
  "planDepth": "light",
  "codeDepth": "shallow",
  "reviewMode": "static",
  "provenance": {
    "source": "bootstrap"
  }
}
EOF

  cp "$feature_dir/.initial-route.json" "$feature_dir/.routing-complete"

  cat > "$feature_dir/.phase-config.json" <<'EOF'
{
  "planning": {
    "model": "bootstrap-planner",
    "agent": "claude",
    "depth": "light"
  },
  "coding": {
    "model": "bootstrap-coder",
    "agent": "claude",
    "depth": "shallow"
  },
  "review": {
    "model": "bootstrap-reviewer",
    "agent": "claude",
    "mode": "static"
  },
  "resolvedAt": "2026-05-01T00:00:00Z",
  "forceModel": null
}
EOF
}

harness_common_route_overrides() {
  cat <<EOF
    FORCE_MODEL=""
    source "$REPO_DIR/shared/lib/wavemill-common.sh"
    _with_timeout() { shift; "\$@"; }
    read_state_value() { printf "%s\\n" "\${1-}"; }
    get_task_phase() { printf "%s\\n" "\$CURRENT_PHASE"; }
    set_task_phase() { CURRENT_PHASE="\$2"; }
    get_task_meta() { :; }
    save_task_state() { :; }
    log() {
      if [[ "\${1:-}" == "warn" ]]; then
        shift
        WARN_OUTPUT+="\$*\\n"
      else
        LOG_OUTPUT+="\$*\\n"
      fi
    }
    eval "\$(declare -f apply_expanded_route_if_present | sed '1s/apply_expanded_route_if_present/apply_expanded_route_if_present_real/')"
    apply_expanded_route_if_present() {
      APPLY_CALLED="true"
      apply_expanded_route_if_present_real "\$@"
    }
    eval "\$(declare -f mill_check_expansion_handshake | sed '1s/mill_check_expansion_handshake/mill_check_expansion_handshake_real/')"
    mill_check_expansion_handshake() {
      HANDSHAKE_CALLED="true"
      mill_check_expansion_handshake_real "\$@"
    }
    eval "\$(declare -f mill_expansion_handshake_reason | sed '1s/mill_expansion_handshake_reason/mill_expansion_handshake_reason_real/')"
    mill_expansion_handshake_reason() {
      mill_expansion_handshake_reason_real "\$@"
    }
    read_phase_config() {
      local feature_dir="\$1" stage="\$2" field="\$3"
      jq -r --arg stage "\$stage" --arg field "\$field" '.[\$stage][\$field] // ""' "\$feature_dir/.phase-config.json" 2>/dev/null || true
    }
EOF
}

harness_read_stage_status() {
  local repo="$1" slug="$2" stage="$3"
  jq -r '.status // empty' "$repo/features/$slug/.${stage}-result.json" 2>/dev/null || true
}

harness_auto_advance_clear_liveness_setup() {
  cat <<'EOF'
CURRENT_PHASE="coding"
mill_pane_has_live_blocking_process() {
  MILL_BLOCKING_PROCESS_COMMAND=""
  MILL_BLOCKING_PROCESS_REASON=""
  MILL_BLOCKING_PROCESS_MATCH_COUNT=0
  MILL_BLOCKING_PROCESS_PIDS=()
  return 1
}
EOF
}

harness_run_tick() {
  local repo="$1" slug="$2" issue="$3" extra_setup="${4:-}"
  local tick_setup_file="$TEST_TMP/${issue}-${slug}-extra-$$.sh"
  printf '%s\n' "$extra_setup" > "$tick_setup_file"

  REPO_UNDER_TEST="$repo" \
  REPO_DIR="$REPO_DIR" \
  TEST_SLUG="$slug" \
  TEST_ISSUE="$issue" \
  REAL_FUNC_FILE="$REAL_FUNC_FILE" \
  EXTRA_SETUP_FILE="$tick_setup_file" \
  env -u npm_config_prefix bash -lc '
    set -euo pipefail
    source "$REPO_DIR/shared/lib/wavemill-common.sh"
    source "$REAL_FUNC_FILE"

    declare -Ag BRANCH_BY_ISSUE=()
    declare -Ag SLUG_BY_ISSUE=()
    declare -Ag PR_BY_ISSUE=()
    declare -Ag CLOSED_PR_LOGGED=()
    declare -Ag CLEANED=()
    monitor_deregister_terminal_arm() {
      local issue="${1:?issue required}"
      [[ -n "${CLEANED[$issue]:-}" ]] && return 0
      CLEANED["$issue"]=1
      unset "BRANCH_BY_ISSUE[$issue]" 2>/dev/null || true
      unset "SLUG_BY_ISSUE[$issue]" 2>/dev/null || true
      unset "PR_BY_ISSUE[$issue]" 2>/dev/null || true
      unset "CLOSED_PR_LOGGED[$issue]" 2>/dev/null || true
      return 0
    }

    ISSUE="$TEST_ISSUE"
    SLUG="$TEST_SLUG"
    BRANCH="task/$SLUG"
    WORKTREE_ROOT="$(dirname "$REPO_UNDER_TEST")"
    LIB_DIR="$REPO_DIR/shared/lib"
    REPO_DIR="$REPO_UNDER_TEST"
    TOOLS_DIR=""
    SESSION="lifecycle-harness"
    BASE_BRANCH="main"
    AGENT_CMD="codex"
    STATE_FILE="$REPO_UNDER_TEST/.wavemill/state.json"
    API_TIMEOUT=1
    AUTO_EVAL="false"
    REQUIRE_CONFIRM="false"
    QUIT_REQUESTED="false"
    FORCE_MODEL="test-model"
    CURRENT_PHASE="planning"
    CURRENT_AGENT="codex"
    CODING_LAUNCHED="false"
    CODING_MODEL=""
    CODING_AGENT=""
    CODING_DEPTH=""
    PLANNING_LAUNCHED="false"
    REROUTE_CALLED="false"
    APPLY_CALLED="false"
    HANDSHAKE_CALLED="false"
    CHALLENGE_REFRESH_CALLED="false"
    ACTIVE_COUNT=0
    LOG_OUTPUT=""
    WARN_OUTPUT=""
    ATTENTION_STATE=""
    MERGE_QUEUE_SELECTION_FILE="$REPO_UNDER_TEST/.wavemill/merge-queue-selection.json"
    MERGE_QUEUE_ENABLED="true"
    MERGE_QUEUE_MAX_CONCURRENT=2
    MERGE_QUEUE_STUCK_TIMEOUT_SECONDS=900
    MERGE_QUEUE_CONFLICT_GROUPING_ENABLED="true"
    MERGE_QUEUE_SKIP_COOLDOWN_SECONDS=60

    active_count=0
    BRANCH_BY_ISSUE["$ISSUE"]="$BRANCH"
    SLUG_BY_ISSUE["$ISSUE"]="$SLUG"
    mkdir -p "$REPO_UNDER_TEST/.wavemill"
    printf "{\"title\":\"Lifecycle Harness\"}\n" > "/tmp/${SESSION}-${ISSUE}-issue.json"

    log() { LOG_OUTPUT+="$*\n"; }
    log_warn() { WARN_OUTPUT+="$*\n"; }
    log_error() { WARN_OUTPUT+="$*\n"; }
    set_window_attention_state() { ATTENTION_STATE="$2"; }
    _pane_is_dead_or_idle() { return 0; }
    _ensure_window_exists() { :; }
    tmux() { return 1; }
    sleep() { :; }
    cleanup_completed_task() { :; }
    execute() { "$@" 2>/dev/null || true; }
    _with_timeout() { shift; "$@"; }
    gh() { return 1; }
    find_pr_for_branch() { return 0; }
    check_pr_exists() { return 1; }
    pr_state() { printf "%s\n" "OPEN"; }
    validate_pr_merge() { return 1; }
    should_update_linear_state() { return 1; }
    linear_set_state() { :; }
    linear_is_completed() { return 1; }
    get_linear_issue_id() { printf "%s\n" "$ISSUE"; }
    get_task_meta() { :; }
    save_task_state() { :; }
    read_state_value() { printf "%s\n" "${1-}"; }
    get_task_phase() { printf "%s\n" "$CURRENT_PHASE"; }
    set_task_phase() { CURRENT_PHASE="$2"; }
    resolve_phase_model() { printf "%s\n" "${2:-${3:-test-model}}"; }
    agent_resolve_from_model() { printf "%s\n" "codex"; }
    read_phase_config() {
      case "${2:-}.${3:-}" in
        coding.model) printf "%s\n" "test-model" ;;
        coding.depth) printf "%s\n" "medium" ;;
        review.model) printf "%s\n" "test-model" ;;
        review.mode) printf "%s\n" "static" ;;
        *) printf "\n" ;;
      esac
    }
    write_phase_config() { :; }
    handle_agent_error_recovery() { :; }
    handle_phase_launch_result() { return 0; }
    launch_planning_phase() { PLANNING_LAUNCHED="true"; return 0; }
    launch_coding_phase() {
      CODING_LAUNCHED="true"
      CODING_MODEL="${7:-}"
      CODING_AGENT="${8:-}"
      CODING_DEPTH="${9:-}"
      return 0
    }
    launch_review_phase() { return 0; }
    launch_ready_phase() { return 0; }
    ready_state_dir() { printf "%s\n" "$1/features/$2/ready"; }
    ready_base_sha() { printf "\n"; }
    ready_remediation_launch_head() { printf "\n"; }
    ready_remediation_attempts() { printf "%s\n" "0"; }
    write_ready_attention_file() { :; }
    emit_execution_active_route() { :; }
    log_route_lifecycle() { :; }
    route_lifecycle_route_id() { :; }
    reroute_expanded_packets_for_coding_handoff() { REROUTE_CALLED="true"; return 0; }
    apply_expanded_route_if_present() { APPLY_CALLED="true"; return 0; }
    mill_expansion_handshake_reason() { printf "%s\n" "already-expanded"; }
    get_expansion_handshake_policy() { printf "%s\n" "recover"; }
    recover_missing_expansion_artifact() { return 1; }
    mill_check_expansion_handshake() { HANDSHAKE_CALLED="true"; return 0; }
    restore_review_task_window() { return 0; }
    _restore_inflight_task_window_if_missing() { _RESTORE_STATE="none"; return 0; }
    check_routing_complete() { return 1; }
    merge_queue_enabled() { return 1; }
    ready_queue_state() { printf "\n"; }
    ready_queue_field() { printf "\n"; }
    ready_live_ci_json() { printf "%s\n" "{\"conclusion\":\"pass\",\"headSha\":\"head\",\"mergeStateStatus\":\"CLEAN\",\"observed\":1,\"requiredContexts\":[],\"checks\":[]}"; }
    ci_summary_from_json() { printf "unknown"; }
    write_ready_queue_artifacts() { :; }
    ready_changed_files_json() { printf "[]\n"; }
    mark_ready_stale() { :; }
    promote_merge_candidate() { :; }
    demote_merge_candidate() { :; }
    ready_candidate_selected() { return 1; }
    is_challenge_task() { return 1; }
    maybe_run_challenge_eval() { :; }
    maybe_run_challenge_comparison() { :; }
    get_challenge_sibling_pr() { :; }
    check_challenge_sibling_merged() { return 1; }
    save_migration_reservation() { :; }
    closed_pr_resource_policy() { printf "%s\n" "pane-release-only"; }
    wavemill_release_terminal_pane() { return 0; }
    transient_error_recovery_pending() { return 1; }
    codex_has_pending_approval() { return 1; }
    launch_background_post_merge_eval() { :; }

    # Scenario-specific function overrides must run after default stubs and
    # extracted real functions are loaded.
    source "$EXTRA_SETUP_FILE"

    refresh_ready_merge_queue_tick
    monitor_issue_state "$ISSUE"

    printf "phase=%s\n" "$CURRENT_PHASE"
    printf "planning_status=%s\n" "$(read_stage_status "$REPO_UNDER_TEST/features/$SLUG" planning)"
    printf "coding_status=%s\n" "$(read_stage_status "$REPO_UNDER_TEST/features/$SLUG" coding)"
    printf "coding_launched=%s\n" "$CODING_LAUNCHED"
    printf "coding_model=%s\n" "$CODING_MODEL"
    printf "coding_agent=%s\n" "$CODING_AGENT"
    printf "coding_depth=%s\n" "$CODING_DEPTH"
    printf "planning_launched=%s\n" "$PLANNING_LAUNCHED"
    printf "reroute_called=%s\n" "$REROUTE_CALLED"
    printf "apply_called=%s\n" "$APPLY_CALLED"
    printf "handshake_called=%s\n" "$HANDSHAKE_CALLED"
    printf "challenge_refresh_called=%s\n" "$CHALLENGE_REFRESH_CALLED"
    printf "attention=%s\n" "$ATTENTION_STATE"
    printf "active_count=%s\n" "$active_count"
    printf "queue_owned_count=%s\n" "${queue_owned_count:-0}"
    printf "log_output=%s\n" "$(printf "%s" "$LOG_OUTPUT" | tr "\n" "|")"
    printf "warn_output=%s\n" "$(printf "%s" "$WARN_OUTPUT" | tr "\n" "|")"
  '
}

test_positive_handoff_two_ticks() {
  local slug="planning-approval-positive"
  local issue="HOK-1293-POS"
  local repo tick1 tick2
  repo="$(harness_init_repo "$slug")"
  harness_setup_planning_state "$repo" "$slug" "awaiting_user"
  harness_setup_runtime_artifacts "$repo"

  tick1="$(harness_run_tick "$repo" "$slug" "$issue")"
  check_eq "tick 1: planning transitions to completed" "completed" "$(harness_read_stage_status "$repo" "$slug" planning)"
  check_file_exists "tick 1: .plan-approved preserved" "$repo/features/$slug/.plan-approved"
  check_eq "tick 1: no coding launch yet" "false" "$(kv_value "$tick1" coding_launched)"
  check_eq "tick 1: no source-overreach warning" "" "$(kv_value "$tick1" warn_output)"

  tick2="$(harness_run_tick "$repo" "$slug" "$issue")"
  check_eq "tick 2: controller phase becomes coding" "coding" "$(kv_value "$tick2" phase)"
  check_eq "tick 2: coding stage becomes running" "running" "$(harness_read_stage_status "$repo" "$slug" coding)"
  check_eq "tick 2: coding launch stub invoked" "true" "$(kv_value "$tick2" coding_launched)"
  check_file_exists "tick 2: .plan-approved still preserved" "$repo/features/$slug/.plan-approved"
  check_eq "tick 2: no source-overreach warning" "" "$(kv_value "$tick2" warn_output)"
}

test_source_edit_blocks_handoff() {
  local slug="planning-source-overreach"
  local issue="HOK-1293-NEG"
  local repo tick
  repo="$(harness_init_repo "$slug")"
  harness_setup_planning_state "$repo" "$slug" "awaiting_user"
  harness_setup_runtime_artifacts "$repo"
  mkdir -p "$repo/shared/lib"
  printf 'export const bad = true;\n' > "$repo/shared/lib/foo.ts"

  tick="$(harness_run_tick "$repo" "$slug" "$issue")"
  check_eq "negative: planning stays awaiting_user" "awaiting_user" "$(harness_read_stage_status "$repo" "$slug" planning)"
  check_file_absent "negative: .plan-approved removed" "$repo/features/$slug/.plan-approved"
  check_file_absent "negative: overreach file cleaned up" "$repo/shared/lib/foo.ts"
  check_file_exists "negative: planning rejection artifact written" "$repo/features/$slug/.planning-rejected.json"
  check_eq "negative: planning rejection reason recorded" "planning_modified_out_of_scope_files" "$(jq -r '.reason' "$repo/features/$slug/.planning-rejected.json")"
  check_eq "negative: planning rejection file recorded" "shared/lib/foo.ts" "$(jq -r '.outOfScopeFiles[0]' "$repo/features/$slug/.planning-rejected.json")"
  check_contains "negative: source-overreach warning emitted" "$(kv_value "$tick" warn_output)" "source code"
  check_contains "negative: source-overreach attention emitted" "$(kv_value "$tick" warn_output)" "needs attention"
  check_eq "negative: coding launch not invoked" "false" "$(kv_value "$tick" coding_launched)"
}

test_regression_without_wavemill_allowance() {
  local slug="planning-wavemill-regression"
  local issue="HOK-1293-REG"
  local repo tick
  repo="$(harness_init_repo "$slug")"
  harness_setup_planning_state "$repo" "$slug" "awaiting_user"
  harness_setup_runtime_artifacts "$repo"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" '
    validate_planning_phase_output() {
      local wt_dir="$1"
      local feature_dir="$wt_dir/features/$(basename "$wt_dir")"
      local changed_file
      local -a out_of_scope_files=()
      local -a tracked_out_of_scope=()
      local -a untracked_out_of_scope=()

      [[ -d "$wt_dir/.git" || -f "$wt_dir/.git" ]] || return 0

      while IFS= read -r changed_file; do
        [[ -n "$changed_file" ]] || continue
        case "$changed_file" in
          features/*) ;;
          *)
            out_of_scope_files+=("$changed_file")
            if git -C "$wt_dir" ls-files --error-unmatch -- "$changed_file" >/dev/null 2>&1; then
              tracked_out_of_scope+=("$changed_file")
            else
              untracked_out_of_scope+=("$changed_file")
            fi
            ;;
        esac
      done < <(
        {
          git -C "$wt_dir" diff --name-only HEAD -- 2>/dev/null || true
          git -C "$wt_dir" ls-files --others --exclude-standard 2>/dev/null || true
        } | sort -u
      )

      if [[ ${#out_of_scope_files[@]} -eq 0 ]]; then
        return 0
      fi

      log_warn "WARNING: Planning phase modified source code files: ${out_of_scope_files[*]}"

      if [[ ${#tracked_out_of_scope[@]} -gt 0 ]]; then
        git -C "$wt_dir" reset -q HEAD -- "${tracked_out_of_scope[@]}" 2>/dev/null || true
        git -C "$wt_dir" checkout -- "${tracked_out_of_scope[@]}" 2>/dev/null || true
      fi

      if [[ ${#untracked_out_of_scope[@]} -gt 0 ]]; then
        rm -f -- "${untracked_out_of_scope[@]/#/$wt_dir/}" 2>/dev/null || true
      fi

      rm -f "$feature_dir/.plan-approved"
      return 1
    }
  ')"

  check_eq "regression: handoff blocked without .wavemill allowance" "awaiting_user" "$(harness_read_stage_status "$repo" "$slug" planning)"
  check_file_absent "regression: .plan-approved removed" "$repo/features/$slug/.plan-approved"
  check_contains "regression: wavemill artifact treated as overreach" "$(kv_value "$tick" warn_output)" ".wavemill/logs/linear-validation-warnings.jsonl"
  check_eq "regression: coding launch not invoked" "false" "$(kv_value "$tick" coding_launched)"
}

test_mixed_artifacts_source_edit_wins() {
  local slug="planning-mixed-artifacts"
  local issue="HOK-1293-MIX"
  local repo tick
  repo="$(harness_init_repo "$slug")"
  harness_setup_planning_state "$repo" "$slug" "awaiting_user"
  harness_setup_runtime_artifacts "$repo"
  mkdir -p "$repo/src"
  printf 'export const bad = true;\n' > "$repo/src/bad.ts"

  tick="$(harness_run_tick "$repo" "$slug" "$issue")"
  check_eq "mixed: planning stays awaiting_user" "awaiting_user" "$(harness_read_stage_status "$repo" "$slug" planning)"
  check_file_absent "mixed: .plan-approved removed" "$repo/features/$slug/.plan-approved"
  check_file_absent "mixed: source edit cleaned up" "$repo/src/bad.ts"
  check_contains "mixed: source edit appears in warning" "$(kv_value "$tick" warn_output)" "src/bad.ts"
  check_not_contains "mixed: wavemill artifact not treated as overreach" "$(kv_value "$tick" warn_output)" ".wavemill/logs/linear-validation-warnings.jsonl"
  check_eq "mixed: coding launch not invoked" "false" "$(kv_value "$tick" coding_launched)"
}

test_claude_local_settings_allowed() {
  local slug="planning-claude-local-settings"
  local issue="HOK-1293-CLAUDE"
  local repo tick
  repo="$(harness_init_repo "$slug")"
  mkdir -p "$repo/.claude"
  printf '{}\n' > "$repo/.claude/settings.local.json"
  git -C "$repo" add -f ".claude/settings.local.json"
  git -C "$repo" commit -q -m "Track local Claude settings"

  harness_setup_planning_state "$repo" "$slug" "awaiting_user"
  harness_setup_runtime_artifacts "$repo"
  printf '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"hook.sh"}]}]}}\n' > "$repo/.claude/settings.local.json"

  tick="$(harness_run_tick "$repo" "$slug" "$issue")"
  check_eq "claude settings: planning transitions to completed" "completed" "$(harness_read_stage_status "$repo" "$slug" planning)"
  check_file_exists "claude settings: .plan-approved preserved" "$repo/features/$slug/.plan-approved"
  check_eq "claude settings: no coding launch on same tick" "false" "$(kv_value "$tick" coding_launched)"
  check_eq "claude settings: no overreach warning" "" "$(kv_value "$tick" warn_output)"
  check_contains "claude settings: tracked file remains modified" "$(git -C "$repo" status --short .claude/settings.local.json)" "M .claude/settings.local.json"
}

test_remote_probe_timeout_does_not_block_plan_approval() {
  local slug="planning-approval-after-remote-timeout"
  local issue="HOK-2322-PLAN"
  local repo tick overrides ready_slug ready_worktree
  repo="$(harness_init_repo "$slug")"
  harness_setup_planning_state "$repo" "$slug" "awaiting_user"
  harness_setup_runtime_artifacts "$repo"

  ready_slug="ready-merge-candidate"
  ready_worktree="$(dirname "$repo")/$ready_slug"
  mkdir -p "$ready_worktree"

  overrides='
    WAVEMILL_GIT_REMOTE_TIMEOUT_SECONDS=15
    refresh_ready_merge_queue_tick() {
      get_main_head_sha "'"$ready_worktree"'" "$BASE_BRANCH" >/dev/null
      return 0
    }
    wavemill_git_remote_with_timeout() {
      sleep 2
      return 124
    }
  '

  tick="$(harness_run_tick "$repo" "$slug" "$issue" "$overrides")"

  check_eq "remote timeout: planning transitions to completed" "completed" "$(harness_read_stage_status "$repo" "$slug" planning)"
  check_file_exists "remote timeout: .plan-approved preserved" "$repo/features/$slug/.plan-approved"
  check_eq "remote timeout: coding launch not invoked on same tick" "false" "$(kv_value "$tick" coding_launched)"
  check_contains "remote timeout: warning names ready worktree" "$(kv_value "$tick" warn_output)" "worktree=$ready_worktree"
  check_contains "remote timeout: warning names remote ref" "$(kv_value "$tick" warn_output)" "ref=refs/heads/main"
  check_contains "remote timeout: warning names timeout" "$(kv_value "$tick" warn_output)" "timeout=15s"
  check_contains "remote timeout: warning names exit" "$(kv_value "$tick" warn_output)" "exit=124"
  check_contains "remote timeout: warning names degraded action" "$(kv_value "$tick" warn_output)" "skipping base-branch freshness this tick"
}

test_coding_uses_expanded_route_over_bootstrap() {
  local slug="expanded-route-wins"
  local issue="HOK-1516-WINS"
  local repo tick initial_before overrides
  repo="$(harness_init_repo "$slug")"
  harness_setup_planning_state "$repo" "$slug" "completed"
  harness_setup_runtime_artifacts "$repo"
  harness_seed_bootstrap_route "$repo" "$slug"
  initial_before="$(cat "$repo/features/$slug/.initial-route.json")"

  cat > "$repo/features/$slug/.post-expansion-route.json" <<'EOF'
{
  "planner": "expanded-planner",
  "coder": "gpt-5.4",
  "reviewer": "claude-sonnet-5",
  "planDepth": "deep",
  "codeDepth": "deep",
  "reviewMode": "static+llm",
  "provenance": {
    "source": "expanded-test"
  }
}
EOF

  overrides="$(harness_common_route_overrides)"
  tick="$(harness_run_tick "$repo" "$slug" "$issue" "$overrides")"

  check_eq "expanded wins: coding launches" "true" "$(kv_value "$tick" coding_launched)"
  check_eq "expanded wins: coding model from expanded route" "gpt-5.4" "$(kv_value "$tick" coding_model)"
  check_eq "expanded wins: coding depth from expanded route" "deep" "$(kv_value "$tick" coding_depth)"
  check_eq "expanded wins: bootstrap model not launched" "false" "$([[ "$(kv_value "$tick" coding_model)" == "bootstrap-coder" ]] && printf true || printf false)"
  check_eq "expanded wins: routing provenance expanded" "expanded" "$(jq -r '.provenance.source' "$repo/features/$slug/.routing-complete")"
  check_eq "expanded wins: phase config model updated" "gpt-5.4" "$(jq -r '.coding.model' "$repo/features/$slug/.phase-config.json")"
  check_eq "expanded wins: phase config depth updated" "deep" "$(jq -r '.coding.depth' "$repo/features/$slug/.phase-config.json")"
  check_eq "expanded wins: initial route remains bootstrap-only" "$initial_before" "$(cat "$repo/features/$slug/.initial-route.json")"
}

test_missing_expansion_recovery_success_launches_with_expanded_route() {
  local slug="missing-expansion-recovery-success"
  local issue="HOK-1569-RECOVER-OK"
  local repo tick overrides
  repo="$(harness_init_repo "$slug")"
  harness_setup_planning_state "$repo" "$slug" "completed"
  harness_setup_runtime_artifacts "$repo"
  harness_seed_bootstrap_route "$repo" "$slug"
  printf 'raw issue text\n' > "$repo/features/$slug/task-packet.md"

  overrides="$(harness_common_route_overrides)
    recover_missing_expansion_artifact() {
      local issue=\"\$1\" slug=\"\$2\" feature_dir=\"\$3\"
      local count_file=\"\$REPO_UNDER_TEST/.wavemill/recovery-count\"
      local count
      count=\$(cat \"\$count_file\" 2>/dev/null || echo 0)
      printf '%s\n' \$((count + 1)) > \"\$count_file\"
      expansion_recovery_mark_attempted \"\$feature_dir\" \"\$issue\" \"missing\"
      cat > \"\$feature_dir/task-packet.md\" <<'EOF'
## 1. Objective

Recover the missing expanded routing artifact.
EOF
      cat > \"\$feature_dir/.post-expansion-route.json\" <<'EOF'
{
  \"planner\": \"expanded-planner\",
  \"coder\": \"gpt-5.4\",
  \"reviewer\": \"claude-sonnet-5\",
  \"planDepth\": \"deep\",
  \"codeDepth\": \"deep\",
  \"reviewMode\": \"static+llm\",
  \"provenance\": {
    \"source\": \"expanded-test\"
  }
}
EOF
      expansion_recovery_mark_result \"\$feature_dir\" \"\$issue\" \"succeeded\" \"stub-success\" \"0\"
      return 0
    }
  "
  tick="$(harness_run_tick "$repo" "$slug" "$issue" "$overrides")"

  check_eq "recover ok: coding launches" "true" "$(kv_value "$tick" coding_launched)"
  check_eq "recover ok: coding model from expanded route" "gpt-5.4" "$(kv_value "$tick" coding_model)"
  check_eq "recover ok: coding depth from expanded route" "deep" "$(kv_value "$tick" coding_depth)"
  check_eq "recover ok: routing provenance expanded" "expanded" "$(jq -r '.provenance.source' "$repo/features/$slug/.routing-complete")"
  check_eq "recover ok: recovery state succeeded" "succeeded" "$(jq -r '.status' "$repo/features/$slug/.expansion-recovery-state.json")"
  check_eq "recover ok: recovery attempted once" "1" "$(cat "$repo/.wavemill/recovery-count")"
  check_not_contains "recover ok: no blocked warning" "$(kv_value "$tick" warn_output)" "[expansion-handshake] BLOCKED"
}

test_challenger_missing_expansion_recovery_uses_linear_issue_id() {
  local slug="challenger-missing-expansion-recovery-real-id"
  local issue="HOK-2265_c"
  local repo tick overrides npx_args
  repo="$(harness_init_repo "$slug")"
  harness_setup_planning_state "$repo" "$slug" "completed"
  harness_setup_runtime_artifacts "$repo"
  harness_seed_bootstrap_route "$repo" "$slug"
  printf 'raw issue text\n' > "$repo/features/$slug/task-packet.md"

  overrides="$(harness_common_route_overrides)
    source \"\$REAL_FUNC_FILE\"
    TOOLS_DIR=\"/tmp/\${SESSION}-\${ISSUE}-tools\"
    mkdir -p \"\$TOOLS_DIR\"
    : > \"\$TOOLS_DIR/expand-issue.ts\"
    get_task_meta() {
      local issue_key=\"\$1\" field=\"\$2\"
      case \"\$issue_key.\$field\" in
        HOK-2265_c.linearIssueId) printf '%s\\n' '  HOK-2265  ' ;;
        HOK-2265_c.challenge) printf '%s\\n' 'true' ;;
        HOK-2265_c.challengeRole) printf '%s\\n' 'challenger' ;;
        *) printf '\\n' ;;
      esac
    }
    npx() {
      printf '%s\\n' \"\$*\" >> \"\$REPO_UNDER_TEST/.wavemill/npx-args.log\"
      [[ \"\$*\" == *\"expand-issue.ts\"* ]] || return 0
      cat > \"\$REPO_UNDER_TEST/features/$slug/task-packet.md\" <<'EOF'
## 1. Objective

Recover the missing expanded routing artifact.
EOF
    }
    reroute_expanded_packets_for_coding_handoff() {
      local packet_content=""
      REROUTE_CALLED=\"true\"
      packet_content=\"\$(cat \"\$3/task-packet.md\" 2>/dev/null || echo '')\"
      is_task_packet \"\$packet_content\" || {
        REROUTE_EXPANDED_LAST_REASON=\"not_eligible\"
        return 1
      }
      cat > \"\$3/.post-expansion-route.json\" <<'EOF'
{
  \"planner\": \"expanded-planner\",
  \"coder\": \"gpt-5.4\",
  \"reviewer\": \"claude-sonnet-5\",
  \"planDepth\": \"deep\",
  \"codeDepth\": \"deep\",
  \"reviewMode\": \"static+llm\",
  \"provenance\": {
    \"source\": \"expanded-test\"
  }
}
EOF
      return 0
    }
  "
  tick="$(harness_run_tick "$repo" "$slug" "$issue" "$overrides")"
  npx_args="$(cat "$repo/.wavemill/npx-args.log")"

  check_eq "challenger recover real id: coding launches" "true" "$(kv_value "$tick" coding_launched)"
  check_eq "challenger recover real id: coding model from expanded route" "gpt-5.4" "$(kv_value "$tick" coding_model)"
  check_contains "challenger recover real id: uses real Linear issue id" "$npx_args" "expand-issue.ts HOK-2265 --output $repo/features/$slug/task-packet.md"
  check_not_contains "challenger recover real id: does not use synthetic issue id" "$npx_args" "expand-issue.ts HOK-2265_c --output"
  check_not_contains "challenger recover real id: no invalid identifier log" "$(kv_value "$tick" warn_output)" "Invalid issue identifier"
}

test_challenger_missing_expansion_recovery_extracts_linear_issue_id_from_url() {
  local slug="challenger-missing-expansion-recovery-url-id"
  local issue="HOK-2265_c"
  local repo tick overrides npx_args
  repo="$(harness_init_repo "$slug")"
  harness_setup_planning_state "$repo" "$slug" "completed"
  harness_setup_runtime_artifacts "$repo"
  harness_seed_bootstrap_route "$repo" "$slug"
  printf 'raw issue text\n' > "$repo/features/$slug/task-packet.md"

  overrides="$(harness_common_route_overrides)
    source \"\$REAL_FUNC_FILE\"
    TOOLS_DIR=\"/tmp/\${SESSION}-\${ISSUE}-tools\"
    mkdir -p \"\$TOOLS_DIR\"
    : > \"\$TOOLS_DIR/expand-issue.ts\"
    get_task_meta() {
      local issue_key=\"\$1\" field=\"\$2\"
      case \"\$issue_key.\$field\" in
        HOK-2265_c.linearIssueId) printf '%s\\n' 'https://linear.app/wavemill/issue/HOK-2265?utm_source=test' ;;
        HOK-2265_c.challenge) printf '%s\\n' 'true' ;;
        HOK-2265_c.challengeRole) printf '%s\\n' 'challenger' ;;
        *) printf '\\n' ;;
      esac
    }
    npx() {
      printf '%s\\n' \"\$*\" >> \"\$REPO_UNDER_TEST/.wavemill/npx-args.log\"
      [[ \"\$*\" == *\"expand-issue.ts\"* ]] || return 0
      cat > \"\$REPO_UNDER_TEST/features/$slug/task-packet.md\" <<'EOF'
## 1. Objective

Recover the missing expanded routing artifact.
EOF
    }
    reroute_expanded_packets_for_coding_handoff() {
      local packet_content=""
      REROUTE_CALLED=\"true\"
      packet_content=\"\$(cat \"\$3/task-packet.md\" 2>/dev/null || echo '')\"
      is_task_packet \"\$packet_content\" || {
        REROUTE_EXPANDED_LAST_REASON=\"not_eligible\"
        return 1
      }
      cat > \"\$3/.post-expansion-route.json\" <<'EOF'
{
  \"planner\": \"expanded-planner\",
  \"coder\": \"gpt-5.4\",
  \"reviewer\": \"claude-sonnet-5\",
  \"planDepth\": \"deep\",
  \"codeDepth\": \"deep\",
  \"reviewMode\": \"static+llm\",
  \"provenance\": {
    \"source\": \"expanded-test\"
  }
}
EOF
      return 0
    }
  "
  tick="$(harness_run_tick "$repo" "$slug" "$issue" "$overrides")"
  npx_args="$(cat "$repo/.wavemill/npx-args.log")"

  check_eq "challenger recover url id: coding launches" "true" "$(kv_value "$tick" coding_launched)"
  check_contains "challenger recover url id: extracts real Linear issue id" "$npx_args" "expand-issue.ts HOK-2265 --output $repo/features/$slug/task-packet.md"
  check_not_contains "challenger recover url id: does not pass Linear URL" "$npx_args" "expand-issue.ts https://linear.app/wavemill/issue/HOK-2265"
}

test_expansion_recovery_resolve_issue_id_normalizes_linear_issue_url() {
  local resolved
  resolved="$(
    source "$REAL_FUNC_FILE"
    get_task_meta() {
      local issue_key="$1" field="$2"
      case "$issue_key.$field" in
        HOK-2265_c.linearIssueId) printf '%s\n' 'https://linear.app/hokusai/issue/HOK-2265/native-runtime' ;;
        *) printf '\n' ;;
      esac
    }
    expansion_recovery_resolve_issue_id HOK-2265_c
  )"

  check_eq "challenger recover url: resolves Linear issue URL to issue id" "HOK-2265" "$resolved"
}

test_challenger_missing_expansion_recovery_skips_without_linear_issue_id() {
  local slug="challenger-missing-expansion-recovery-skip"
  local issue="HOK-2265_c"
  local repo tick overrides
  repo="$(harness_init_repo "$slug")"
  harness_setup_planning_state "$repo" "$slug" "completed"
  harness_setup_runtime_artifacts "$repo"
  harness_seed_bootstrap_route "$repo" "$slug"
  printf 'raw issue text\n' > "$repo/features/$slug/task-packet.md"

  overrides="$(harness_common_route_overrides)
    source \"\$REAL_FUNC_FILE\"
    TOOLS_DIR=\"/tmp/\${SESSION}-\${ISSUE}-tools\"
    mkdir -p \"\$TOOLS_DIR\"
    : > \"\$TOOLS_DIR/expand-issue.ts\"
    get_task_meta() {
      local issue_key=\"\$1\" field=\"\$2\"
      case \"\$issue_key.\$field\" in
        HOK-2265_c.linearIssueId) printf '%s\\n' ' HOK-2265_c ' ;;
        HOK-2265_c.challenge) printf '%s\\n' 'true' ;;
        HOK-2265_c.challengeRole) printf '%s\\n' 'challenger' ;;
        *) printf '\\n' ;;
      esac
    }
    npx() {
      printf '%s\\n' \"\$*\" >> \"\$REPO_UNDER_TEST/.wavemill/npx-args.log\"
      return 0
    }
  "
  tick="$(harness_run_tick "$repo" "$slug" "$issue" "$overrides")"

  check_eq "challenger recover skip: coding launches" "true" "$(kv_value "$tick" coding_launched)"
  check_eq "challenger recover skip: coding stays bootstrap" "bootstrap-coder" "$(kv_value "$tick" coding_model)"
  check_eq "challenger recover skip: recovery state skipped" "skipped" "$(jq -r '.status' "$repo/features/$slug/.expansion-recovery-state.json")"
  check_eq "challenger recover skip: skipped detail stable" "synthetic-challenger-linear-issue-id-missing-or-invalid" "$(jq -r '.detail' "$repo/features/$slug/.expansion-recovery-state.json")"
  check_not_contains "challenger recover skip: expand tool not invoked" "$(cat "$repo/.wavemill/npx-args.log")" "expand-issue.ts"
  check_contains "challenger recover skip: warning includes skipped" "$(kv_value "$tick" warn_output)" "RECOVERY_SKIPPED"
  check_contains "challenger recover skip: warning includes bootstrap fallback" "$(kv_value "$tick" warn_output)" "RECOVERY_FALLBACK_BOOTSTRAP"
  check_not_contains "challenger recover skip: no invalid identifier log" "$(kv_value "$tick" warn_output)" "Invalid issue identifier"
}

test_missing_expansion_recovery_non_challenger_uses_issue_key() {
  local slug="missing-expansion-recovery-non-challenger"
  local issue="HOK-2300"
  local repo tick overrides npx_args
  repo="$(harness_init_repo "$slug")"
  harness_setup_planning_state "$repo" "$slug" "completed"
  harness_setup_runtime_artifacts "$repo"
  harness_seed_bootstrap_route "$repo" "$slug"
  printf 'raw issue text\n' > "$repo/features/$slug/task-packet.md"

  overrides="$(harness_common_route_overrides)
    source \"\$REAL_FUNC_FILE\"
    TOOLS_DIR=\"/tmp/\${SESSION}-\${ISSUE}-tools\"
    mkdir -p \"\$TOOLS_DIR\"
    : > \"\$TOOLS_DIR/expand-issue.ts\"
    npx() {
      printf '%s\\n' \"\$*\" >> \"\$REPO_UNDER_TEST/.wavemill/npx-args.log\"
      [[ \"\$*\" == *\"expand-issue.ts\"* ]] || return 0
      cat > \"\$REPO_UNDER_TEST/features/$slug/task-packet.md\" <<'EOF'
## 1. Objective

Recover the missing expanded routing artifact.
EOF
    }
    reroute_expanded_packets_for_coding_handoff() {
      local packet_content=""
      REROUTE_CALLED=\"true\"
      packet_content=\"\$(cat \"\$3/task-packet.md\" 2>/dev/null || echo '')\"
      is_task_packet \"\$packet_content\" || {
        REROUTE_EXPANDED_LAST_REASON=\"not_eligible\"
        return 1
      }
      cat > \"\$3/.post-expansion-route.json\" <<'EOF'
{
  \"planner\": \"expanded-planner\",
  \"coder\": \"gpt-5.4\",
  \"reviewer\": \"claude-sonnet-5\",
  \"planDepth\": \"deep\",
  \"codeDepth\": \"deep\",
  \"reviewMode\": \"static+llm\",
  \"provenance\": {
    \"source\": \"expanded-test\"
  }
}
EOF
      return 0
    }
  "
  tick="$(harness_run_tick "$repo" "$slug" "$issue" "$overrides")"
  npx_args="$(cat "$repo/.wavemill/npx-args.log")"

  check_eq "non-challenger recover: coding launches" "true" "$(kv_value "$tick" coding_launched)"
  check_contains "non-challenger recover: uses original issue id" "$npx_args" "expand-issue.ts HOK-2300 --output $repo/features/$slug/task-packet.md"
}

test_missing_expansion_recovery_failure_launches_with_bootstrap() {
  local slug="missing-expansion-recovery-failure"
  local issue="HOK-1569-RECOVER-FAIL"
  local repo tick overrides
  repo="$(harness_init_repo "$slug")"
  harness_setup_planning_state "$repo" "$slug" "completed"
  harness_setup_runtime_artifacts "$repo"
  harness_seed_bootstrap_route "$repo" "$slug"
  printf 'raw issue text\n' > "$repo/features/$slug/task-packet.md"

  overrides="$(harness_common_route_overrides)
    recover_missing_expansion_artifact() {
      local issue=\"\$1\" feature_dir=\"\$3\"
      local count_file=\"\$REPO_UNDER_TEST/.wavemill/recovery-count\"
      local count
      count=\$(cat \"\$count_file\" 2>/dev/null || echo 0)
      printf '%s\n' \$((count + 1)) > \"\$count_file\"
      if expansion_recovery_already_attempted \"\$feature_dir\"; then
        log warn \"[expansion-handshake] RECOVERY_SKIPPED_ALREADY_ATTEMPTED issue=\$issue\"
        return 1
      fi
      expansion_recovery_mark_attempted \"\$feature_dir\" \"\$issue\" \"missing\"
      expansion_recovery_mark_result \"\$feature_dir\" \"\$issue\" \"failed\" \"stubbed-failure\" \"1\"
      log warn \"[expansion-handshake] RECOVERY_FAILED issue=\$issue detail=stubbed-failure\"
      return 1
    }
  "
  tick="$(harness_run_tick "$repo" "$slug" "$issue" "$overrides")"

  check_eq "recover fail: coding launches" "true" "$(kv_value "$tick" coding_launched)"
  check_eq "recover fail: coding model stays bootstrap" "bootstrap-coder" "$(kv_value "$tick" coding_model)"
  check_eq "recover fail: coding depth stays bootstrap" "shallow" "$(kv_value "$tick" coding_depth)"
  check_eq "recover fail: recovery state failed" "failed" "$(jq -r '.status' "$repo/features/$slug/.expansion-recovery-state.json")"
  check_file_exists "recover fail: plan approval preserved" "$repo/features/$slug/.plan-approved"
  check_contains "recover fail: warning includes recovery failure" "$(kv_value "$tick" warn_output)" "RECOVERY_FAILED"
  check_contains "recover fail: warning includes bootstrap fallback" "$(kv_value "$tick" warn_output)" "RECOVERY_FALLBACK_BOOTSTRAP"
}

test_missing_expansion_recovery_not_repeated() {
  local slug="missing-expansion-recovery-not-repeated"
  local issue="HOK-1569-RECOVER-ONCE"
  local repo tick1 tick2 overrides
  repo="$(harness_init_repo "$slug")"
  harness_setup_planning_state "$repo" "$slug" "completed"
  harness_setup_runtime_artifacts "$repo"
  harness_seed_bootstrap_route "$repo" "$slug"
  printf 'raw issue text\n' > "$repo/features/$slug/task-packet.md"

  overrides="$(harness_common_route_overrides)
    recover_missing_expansion_artifact() {
      local issue=\"\$1\" feature_dir=\"\$3\"
      local count_file=\"\$REPO_UNDER_TEST/.wavemill/recovery-count\"
      local count
      count=\$(cat \"\$count_file\" 2>/dev/null || echo 0)
      if expansion_recovery_already_attempted \"\$feature_dir\"; then
        log warn \"[expansion-handshake] RECOVERY_SKIPPED_ALREADY_ATTEMPTED issue=\$issue\"
        return 1
      fi
      printf '%s\n' \$((count + 1)) > \"\$count_file\"
      expansion_recovery_mark_attempted \"\$feature_dir\" \"\$issue\" \"missing\"
      expansion_recovery_mark_result \"\$feature_dir\" \"\$issue\" \"failed\" \"stubbed-failure\" \"1\"
      log warn \"[expansion-handshake] RECOVERY_FAILED issue=\$issue detail=stubbed-failure\"
      return 1
    }
  "
  tick1="$(harness_run_tick "$repo" "$slug" "$issue" "$overrides")"
  tick2="$(harness_run_tick "$repo" "$slug" "$issue" "$overrides")"

  check_eq "recover once: first tick launches coding" "true" "$(kv_value "$tick1" coding_launched)"
  check_eq "recover once: second tick also launches coding" "true" "$(kv_value "$tick2" coding_launched)"
  check_eq "recover once: helper invoked only once" "1" "$(cat "$repo/.wavemill/recovery-count")"
  check_contains "recover once: second tick reports skip" "$(kv_value "$tick2" warn_output)" "RECOVERY_SKIPPED_ALREADY_ATTEMPTED"
}

test_invalid_expanded_route_blocks_lifecycle_handoff() {
  local case_name route_json slug issue repo tick feature_dir note overrides

  for case_name in malformed missing-fields; do
    slug="invalid-expanded-route-$case_name"
    issue="HOK-1516-INVALID-$case_name"
    repo="$(harness_init_repo "$slug")"
    harness_setup_planning_state "$repo" "$slug" "completed"
    harness_setup_runtime_artifacts "$repo"
    harness_seed_bootstrap_route "$repo" "$slug"
    feature_dir="$repo/features/$slug"
    cp "$feature_dir/.routing-complete" "$TEST_TMP/$slug-routing-before.json"
    cp "$feature_dir/.phase-config.json" "$TEST_TMP/$slug-phase-before.json"

    if [[ "$case_name" == "malformed" ]]; then
      printf '{"coder":\n' > "$feature_dir/.post-expansion-route.json"
    else
      cat > "$feature_dir/.post-expansion-route.json" <<'EOF'
{"coder":"gpt-5.4","reviewMode":"static+llm"}
EOF
    fi

    overrides="$(harness_common_route_overrides)"
    tick="$(harness_run_tick "$repo" "$slug" "$issue" "$overrides")"
    note="$(jq -r '.notes // empty' "$feature_dir/.planning-result.json")"

    check_eq "invalid $case_name: coding does not launch" "false" "$(kv_value "$tick" coding_launched)"
    check_file_absent "invalid $case_name: plan approval removed" "$feature_dir/.plan-approved"
    check_eq "invalid $case_name: planning awaits user" "awaiting_user" "$(harness_read_stage_status "$repo" "$slug" planning)"
    check_contains "invalid $case_name: planning note names handshake" "$note" "Expansion handshake blocked"
    check_contains "invalid $case_name: warning reports block" "$(kv_value "$tick" warn_output)" "[expansion-handshake] BLOCKED"
    check_file_absent "invalid $case_name: no recovery state written" "$feature_dir/.expansion-recovery-state.json"
    if cmp -s "$feature_dir/.routing-complete" "$TEST_TMP/$slug-routing-before.json" \
      && cmp -s "$feature_dir/.phase-config.json" "$TEST_TMP/$slug-phase-before.json"; then
      pass "invalid $case_name: route artifacts unchanged"
    else
      fail "invalid $case_name: route artifacts changed"
    fi
  done
}

test_already_expanded_packet_skips_mandatory_expansion() {
  local slug="already-expanded-packet"
  local issue="HOK-1516-PACKET"
  local repo tick overrides
  repo="$(harness_init_repo "$slug")"
  harness_setup_planning_state "$repo" "$slug" "completed"
  harness_setup_runtime_artifacts "$repo"

  cat > "$repo/features/$slug/task-packet.md" <<'EOF'
## 1. Objective

Implement the deterministic test fixture.
EOF
  cat > "$repo/features/$slug/.routing-complete" <<'EOF'
{"coder":"packet-coder","codeDepth":"deep","reviewer":"packet-reviewer","reviewMode":"static","provenance":{"source":"expanded"}}
EOF
  cat > "$repo/features/$slug/.phase-config.json" <<'EOF'
{
  "coding": {
    "model": "packet-coder",
    "agent": "codex",
    "depth": "deep"
  },
  "review": {
    "model": "packet-reviewer",
    "agent": "claude",
    "mode": "static"
  }
}
EOF

  overrides="$(harness_common_route_overrides)"
  tick="$(harness_run_tick "$repo" "$slug" "$issue" "$overrides")"

  check_eq "already-expanded: coding launches" "true" "$(kv_value "$tick" coding_launched)"
  check_eq "already-expanded: handshake checked" "true" "$(kv_value "$tick" handshake_called)"
  check_eq "already-expanded: model from phase config" "packet-coder" "$(kv_value "$tick" coding_model)"
  check_eq "already-expanded: depth from phase config" "deep" "$(kv_value "$tick" coding_depth)"
  check_not_contains "already-expanded: no mandatory expansion block" "$(kv_value "$tick" warn_output)" "[expansion-handshake] BLOCKED"
  check_file_absent "already-expanded: no expansion sentinel" "$repo/features/$slug/.expanded-route-command-invoked"
}

test_resume_uses_expanded_phase_config_over_stale_state() {
  local slug="resume-expanded-route"
  local issue="HOK-1516-RESUME"
  local repo tick initial_before routing_before phase_before overrides
  repo="$(harness_init_repo "$slug")"
  harness_setup_planning_state "$repo" "$slug" "completed"
  harness_setup_runtime_artifacts "$repo"
  harness_seed_bootstrap_route "$repo" "$slug"

  cat > "$repo/features/$slug/task-packet.md" <<'EOF'
## 1. Objective

Resume from expanded lifecycle artifacts.
EOF
  cat > "$repo/features/$slug/.routing-complete" <<'EOF'
{"coder":"gpt-5.4","codeDepth":"deep","reviewer":"claude-sonnet-5","reviewMode":"static+llm","provenance":{"source":"expanded"}}
EOF
  cat > "$repo/features/$slug/.phase-config.json" <<'EOF'
{
  "coding": {
    "model": "gpt-5.4",
    "agent": "codex",
    "depth": "deep"
  },
  "review": {
    "model": "claude-sonnet-5",
    "agent": "claude",
    "mode": "static+llm"
  }
}
EOF
  initial_before="$(cat "$repo/features/$slug/.initial-route.json")"
  routing_before="$(cat "$repo/features/$slug/.routing-complete")"
  phase_before="$(cat "$repo/features/$slug/.phase-config.json")"

  overrides="$(harness_common_route_overrides)"
  tick="$(harness_run_tick "$repo" "$slug" "$issue" "$overrides")"

  check_eq "resume: coding launches" "true" "$(kv_value "$tick" coding_launched)"
  check_eq "resume: model from phase config" "gpt-5.4" "$(kv_value "$tick" coding_model)"
  check_eq "resume: depth from phase config" "deep" "$(kv_value "$tick" coding_depth)"
  check_eq "resume: stale bootstrap model not used" "false" "$([[ "$(kv_value "$tick" coding_model)" == "bootstrap-coder" ]] && printf true || printf false)"
  check_eq "resume: initial route unchanged" "$initial_before" "$(cat "$repo/features/$slug/.initial-route.json")"
  check_eq "resume: routing artifact unchanged" "$routing_before" "$(cat "$repo/features/$slug/.routing-complete")"
  check_eq "resume: phase config unchanged" "$phase_before" "$(cat "$repo/features/$slug/.phase-config.json")"
}

test_merge_queue_marks_non_candidate_stale_without_rerun() {
  local slug="merge-queue-stale"
  local issue="HOK-1580-STALE"
  local repo tick
  repo="$(harness_init_repo "$slug")"
  mkdir -p "$repo/features/$slug/ready"
  cat > "$repo/features/$slug/ready/.ready-result.json" <<'EOF'
{
  "stage": "ready",
  "status": "completed",
  "artifacts": {
    "type": "ready",
    "verdict": "pass",
    "readyBaseSha": "sha-old"
  }
}
EOF

  tick="$(harness_run_tick "$repo" "$slug" "$issue" '
    CURRENT_PHASE="ready"
    PR_BY_ISSUE["$ISSUE"]="501"
    get_main_head_sha() { printf "%s\n" "sha-new"; }
    merge_queue_enabled() { return 0; }
    ready_queue_state() { printf "%s\n" "ready"; }
    mark_ready_stale() { printf "%s\n" "marked" > "$REPO_UNDER_TEST/.wavemill/marked"; }
    launch_ready_phase() { printf "%s\n" "launched" > "$REPO_UNDER_TEST/.wavemill/launched"; return 0; }
  ')"

  check_file_exists "merge queue stale: non-candidate marked stale" "$repo/.wavemill/marked"
  check_file_absent "merge queue stale: non-candidate did not rerun ready" "$repo/.wavemill/launched"
  check_eq "merge queue stale: task remains active" "1" "$(kv_value "$tick" active_count)"
  check_eq "merge queue stale: attention remains clear" "clear" "$(kv_value "$tick" attention)"
}

test_merge_queue_disabled_keeps_legacy_rerun() {
  local slug="merge-queue-disabled"
  local issue="HOK-1580-DISABLED"
  local repo tick
  repo="$(harness_init_repo "$slug")"
  mkdir -p "$repo/features/$slug/ready"
  cat > "$repo/features/$slug/ready/.ready-result.json" <<'EOF'
{
  "stage": "ready",
  "status": "completed",
  "artifacts": {
    "type": "ready",
    "verdict": "pass",
    "readyBaseSha": "sha-old"
  }
}
EOF

  tick="$(harness_run_tick "$repo" "$slug" "$issue" '
    CURRENT_PHASE="ready"
    PR_BY_ISSUE["$ISSUE"]="502"
    get_main_head_sha() { printf "%s\n" "sha-new"; }
    merge_queue_enabled() { return 1; }
    launch_ready_phase() { printf "%s\n" "launched" > "$REPO_UNDER_TEST/.wavemill/launched"; return 0; }
  ')"

  check_file_exists "merge queue disabled: legacy rerun still launches" "$repo/.wavemill/launched"
  check_eq "merge queue disabled: task remains active" "1" "$(kv_value "$tick" active_count)"
}

harness_setup_pane_release_candidate() {
  local repo="$1" slug="$2" issue="$3" owner="${4:-task}" pane_state="${5:-active}"
  local ready_dir="$repo/features/$slug/ready" head

  mkdir -p "$ready_dir"
  cat > "$repo/.wavemill-config.json" <<'EOF'
{
  "ready": {
    "postPrReconciliation": { "enabled": true },
    "paneRelease": { "enabled": true }
  }
}
EOF
  cat > "$ready_dir/.ready-result.json" <<'EOF'
{
  "stage": "ready",
  "status": "completed",
  "artifacts": {
    "type": "ready",
    "verdict": "pass",
    "readyBaseSha": "base-current",
    "queueState": "merge-candidate",
    "lastCiConclusion": "SUCCESS",
    "lastCiSummary": "green"
  }
}
EOF
  cat > "$ready_dir/.review-result.json" <<'EOF'
{
  "stage": "review",
  "status": "completed",
  "artifacts": {
    "type": "review",
    "exitCode": 0,
    "verdict": "ready",
    "iterations": 1,
    "blockerCount": 0
  }
}
EOF
  head="$(git -C "$repo" rev-parse HEAD)"
  jq -n --arg head "$head" '{foundationDigest:"digest-ok", review:{reviewHeadSha:$head}}' > "$ready_dir/.reconciliation-context.json"
  mkdir -p "$repo/.wavemill"
  jq -n \
    --arg issue "$issue" \
    --arg slug "$slug" \
    --arg worktree "$repo" \
    --arg owner "$owner" \
    --arg paneState "$pane_state" \
    '{
      tasks: {
        ($issue): {
          slug: $slug,
          branch: ("task/" + $slug),
          worktree: $worktree,
          status: "active",
          phase: "ready",
          pr: "701",
          executionOwner: $owner,
          paneState: $paneState,
          windowId: "@7"
        }
      }
    }' > "$repo/.wavemill/state.json"
}

test_queue_owned_pane_release_happy_path() {
  local slug="pane-release-happy"
  local issue="HOK-2937-HAPPY"
  local repo tick state
  repo="$(harness_init_repo "$slug")"
  harness_setup_pane_release_candidate "$repo" "$slug" "$issue"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" '
    CURRENT_PHASE="ready"
    PR_BY_ISSUE["$ISSUE"]="701"
    get_main_head_sha() { printf "%s\n" "base-current"; }
    merge_queue_enabled() { return 0; }
    ready_candidate_selected() { return 0; }
    ready_queue_state() { jq -r ".artifacts.queueState // empty" "$1/.ready-result.json"; }
    ready_base_sha() { jq -r ".artifacts.readyBaseSha // empty" "$1/.ready-result.json"; }
    ready_queue_field() { jq -r ".artifacts.${2} // empty" "$1/.ready-result.json"; }
    task_worktree_release_safety() { printf "%s\n" "ok"; }
    npx() {
      if [[ "$*" == *"reconciliation-capsule.ts validate"* ]]; then
        printf "%s\n" "{\"ok\":true}"
        return 0
      fi
      return 1
    }
    _tmux_task_window_target() { printf "%s\n" "@7"; }
    tmux() {
      printf "%s\n" "$*" >> "$REPO_UNDER_TEST/tmux.log"
      if [[ "${1:-}" == "list-panes" ]]; then
        printf "%s\n" "999999"
        return 0
      fi
      return 1
    }
  ')"

  state="$(cat "$repo/.wavemill/state.json")"
  check_eq "pane release: owner queue" "queue" "$(jq -r --arg issue "$issue" '.tasks[$issue].executionOwner' <<< "$state")"
  check_eq "pane release: pane released" "released" "$(jq -r --arg issue "$issue" '.tasks[$issue].paneState' <<< "$state")"
  check_eq "pane release: records digest" "digest-ok" "$(jq -r --arg issue "$issue" '.tasks[$issue].capsuleDigest' <<< "$state")"
  check_contains "pane release: killed window" "$(cat "$repo/tmux.log")" "kill-window -t @7"
  check_eq "pane release: no active slot" "0" "$(kv_value "$tick" active_count)"
  check_eq "pane release: queue-owned count" "1" "$(kv_value "$tick" queue_owned_count)"
  check_file_absent "pane release: no blocked marker" "$repo/features/$slug/ready/.pane-release-blocked.json"
}

test_queue_owned_released_crash_repair_kills_window() {
  local slug="pane-release-repair"
  local issue="HOK-2937-REPAIR"
  local repo tick
  repo="$(harness_init_repo "$slug")"
  harness_setup_pane_release_candidate "$repo" "$slug" "$issue" "queue" "released"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" '
    CURRENT_PHASE="ready"
    PR_BY_ISSUE["$ISSUE"]="701"
    get_main_head_sha() { printf "%s\n" "base-current"; }
    merge_queue_enabled() { return 0; }
    ready_candidate_selected() { return 0; }
    ready_queue_state() { jq -r ".artifacts.queueState // empty" "$1/.ready-result.json"; }
    ready_base_sha() { jq -r ".artifacts.readyBaseSha // empty" "$1/.ready-result.json"; }
    ready_queue_field() { jq -r ".artifacts.${2} // empty" "$1/.ready-result.json"; }
    _tmux_task_window_target() { printf "%s\n" "@7"; }
    tmux() {
      printf "%s\n" "$*" >> "$REPO_UNDER_TEST/tmux.log"
      return 1
    }
  ')"

  check_contains "pane release repair: killed lingering window" "$(cat "$repo/tmux.log")" "kill-window -t @7"
  check_eq "pane release repair: remains queue owned" "queue" "$(jq -r --arg issue "$issue" '.tasks[$issue].executionOwner' "$repo/.wavemill/state.json")"
  check_eq "pane release repair: no active slot" "0" "$(kv_value "$tick" active_count)"
  check_eq "pane release repair: queue-owned count" "1" "$(kv_value "$tick" queue_owned_count)"
}

test_reconciliation_rehydration_acquires_single_owner() {
  local slug="pane-release-rehydrate"
  local issue="HOK-2937-LEASE"
  local repo output
  repo="$(harness_init_repo "$slug")"
  harness_setup_pane_release_candidate "$repo" "$slug" "$issue" "queue" "released"

  output="$(
    REPO_UNDER_TEST="$repo" \
    REPO_DIR="$REPO_DIR" \
    REAL_FUNC_FILE="$REAL_FUNC_FILE" \
    ISSUE="$issue" \
    SLUG="$slug" \
    bash -lc '
      set -euo pipefail
      source "$REPO_DIR/shared/lib/wavemill-common.sh"
      source "$REAL_FUNC_FILE"
      SESSION="lifecycle-harness"
      STATE_FILE="$REPO_UNDER_TEST/.wavemill/state.json"
      WORKTREE_ROOT="$(dirname "$REPO_UNDER_TEST")"
      TOOLS_DIR=""
      log() { :; }
      log_warn() { :; }
      write_ready_attention_file() { :; }
      bounded_retry_clear() { :; }
      npx() {
        if [[ "$*" == *"reconciliation-capsule.ts validate"* ]]; then
          printf "%s\n" "{\"ok\":true}"
          return 0
        fi
        return 1
      }
      _ensure_task_window_exists() {
        local count_file="$REPO_UNDER_TEST/.wavemill/window-ensures"
        local count=0
        [[ -f "$count_file" ]] && count="$(cat "$count_file")"
        count=$((count + 1))
        printf "%s\n" "$count" > "$count_file"
        printf "%s\n" "@8"
      }
      persist_task_window_id() { :; }
      current_head="$(git -C "$REPO_UNDER_TEST" rev-parse HEAD)"
      state_dir="$REPO_UNDER_TEST/features/$SLUG/ready"
      ensure_ready_worker_window "$ISSUE" "$SLUG" "$state_dir" "$REPO_UNDER_TEST" "701" "$current_head" >/dev/null && first="ok" || first="blocked"
      ensure_ready_worker_window "$ISSUE" "$SLUG" "$state_dir" "$REPO_UNDER_TEST" "701" "$current_head" >/dev/null && second="ok" || second="blocked"
      printf "first=%s\n" "$first"
      printf "second=%s\n" "$second"
      printf "owner=%s\n" "$(jq -r --arg issue "$ISSUE" ".tasks[\$issue].executionOwner" "$STATE_FILE")"
      printf "pane=%s\n" "$(jq -r --arg issue "$ISSUE" ".tasks[\$issue].paneState" "$STATE_FILE")"
      printf "lease=%s\n" "$([[ -d "$state_dir/.reconciliation-lease" ]] && echo present || echo absent)"
      printf "ensures=%s\n" "$(cat "$REPO_UNDER_TEST/.wavemill/window-ensures" 2>/dev/null || echo 0)"
    '
  )"

  check_contains "rehydration lease: first owner succeeds" "$output" "first=ok"
  check_contains "rehydration lease: second owner blocked" "$output" "second=blocked"
  check_contains "rehydration lease: owner reconciliation" "$output" "owner=reconciliation"
  check_contains "rehydration lease: pane rehydrating" "$output" "pane=rehydrating"
  check_contains "rehydration lease: lease present" "$output" "lease=present"
  check_contains "rehydration lease: one window ensure" "$output" "ensures=1"
}

test_merge_queue_preserved_merged_tasks_do_not_block_ready_pr() {
  local slug="merge-queue-terminal"
  local issue="HOK-CLEAN"
  local repo tick worktree_root
  repo="$(harness_init_repo "$slug")"
  worktree_root="$(dirname "$repo")"

  # Create ready artifacts for the clean PR
  mkdir -p "$repo/features/$slug/ready"
  cat > "$repo/features/$slug/ready/.ready-result.json" <<'EOF'
{
  "stage": "ready",
  "status": "completed",
  "startedAt": "2026-06-25T10:00:00Z",
  "finishedAt": "2026-06-25T10:05:00Z",
  "artifacts": {
    "type": "ready",
    "verdict": "pass",
    "readyBaseSha": "sha-current",
    "queueState": "ready-stale"
  }
}
EOF

  # Create sibling worktree dirs for preserved-merged tasks
  # WORKTREE_ROOT = dirname(REPO_UNDER_TEST), so wt_dir = WORKTREE_ROOT/slug
  mkdir -p "$worktree_root/preserved-merged-a/features/preserved-merged-a/ready"
  cat > "$worktree_root/preserved-merged-a/features/preserved-merged-a/ready/.ready-result.json" <<'EOF'
{
  "stage": "ready",
  "status": "completed",
  "startedAt": "2026-06-25T09:00:00Z",
  "finishedAt": "2026-06-25T09:05:00Z",
  "artifacts": {
    "type": "ready",
    "verdict": "pass",
    "readyBaseSha": "sha-current",
    "queueState": "merge-candidate",
    "candidatePromotedAt": "2026-06-25T09:10:00Z",
    "candidateLastProgressAt": "2026-06-25T09:15:00Z"
  }
}
EOF

  mkdir -p "$worktree_root/preserved-merged-b/features/preserved-merged-b/ready"
  cat > "$worktree_root/preserved-merged-b/features/preserved-merged-b/ready/.ready-result.json" <<'EOF'
{
  "stage": "ready",
  "status": "completed",
  "startedAt": "2026-06-25T09:00:00Z",
  "finishedAt": "2026-06-25T09:05:00Z",
  "artifacts": {
    "type": "ready",
    "verdict": "pass",
    "readyBaseSha": "sha-current",
    "queueState": "merge-candidate",
    "candidatePromotedAt": "2026-06-25T09:10:00Z",
    "candidateLastProgressAt": "2026-06-25T09:15:00Z"
  }
}
EOF

  # Interpolate TOOLS_DIR from outer REPO_DIR (wavemill root) so npx tsx can find merge-queue-select.ts
  local extra_setup
  extra_setup="TOOLS_DIR=\"${REPO_DIR}/tools\""
  extra_setup+=$'\n'
  extra_setup+='
    CURRENT_PHASE="ready"
    PR_BY_ISSUE["$ISSUE"]="900"
    BRANCH_BY_ISSUE["HOK-MERGED-A"]="task/preserved-merged-a"
    SLUG_BY_ISSUE["HOK-MERGED-A"]="preserved-merged-a"
    PR_BY_ISSUE["HOK-MERGED-A"]="838"
    BRANCH_BY_ISSUE["HOK-MERGED-B"]="task/preserved-merged-b"
    SLUG_BY_ISSUE["HOK-MERGED-B"]="preserved-merged-b"
    PR_BY_ISSUE["HOK-MERGED-B"]="839"

    get_task_phase() { printf "%s\n" "ready"; }
    get_main_head_sha() { printf "%s\n" "sha-current"; }
    merge_queue_enabled() { return 0; }
    ready_queue_state() {
      local state_dir="$1"
      jq -r ".artifacts.queueState // empty" "$state_dir/.ready-result.json" 2>/dev/null || printf "\n"
    }
    ready_base_sha() {
      local state_dir="$1"
      jq -r ".artifacts.readyBaseSha // empty" "$state_dir/.ready-result.json" 2>/dev/null || printf "\n"
    }
    ready_queue_field() {
      local state_dir="$1" field="$2"
      jq -r ".artifacts.$field // empty" "$state_dir/.ready-result.json" 2>/dev/null || printf "\n"
    }
    ready_changed_files_json() {
      local state_dir="$1"
      if [[ "$state_dir" == *"preserved-merged-a"* ]]; then
        printf "[\"x.ts\"]\n"
      elif [[ "$state_dir" == *"preserved-merged-b"* ]]; then
        printf "[\"y.ts\"]\n"
      else
        printf "[\"z.ts\"]\n"
      fi
    }
    read_state_value() {
      local arg_issue=""
      local i
      for i in "$@"; do
        if [[ "$i" == "HOK-MERGED-A" || "$i" == "HOK-MERGED-B" || "$i" == "HOK-CLEAN" ]]; then
          arg_issue="$i"
          break
        fi
      done
      case "$arg_issue" in
        HOK-MERGED-A|HOK-MERGED-B) printf "%s\n" "merged" ;;
        *) printf "\n" ;;
      esac
    }
    promote_merge_candidate() {
      local promo_issue="$1"
      printf "%s\n" "$promo_issue" >> "$REPO_UNDER_TEST/.wavemill/promoted-issues"
    }
    demote_merge_candidate() {
      local demo_issue="$1"
      printf "%s\n" "$demo_issue" >> "$REPO_UNDER_TEST/.wavemill/demoted-issues"
    }
  '

  tick="$(harness_run_tick "$repo" "$slug" "$issue" "$extra_setup")"

  # The clean PR should be selected (promoted)
  check_file_exists "preserved-merged: promoted file exists" "$repo/.wavemill/promoted-issues"
  check_contains "preserved-merged: clean PR promoted" "$(cat "$repo/.wavemill/promoted-issues" 2>/dev/null || true)" "HOK-CLEAN"
  check_not_contains "preserved-merged: merged-A not promoted" "$(cat "$repo/.wavemill/promoted-issues" 2>/dev/null || true)" "HOK-MERGED-A"
  check_not_contains "preserved-merged: merged-B not promoted" "$(cat "$repo/.wavemill/promoted-issues" 2>/dev/null || true)" "HOK-MERGED-B"

  # Merged issues should not be in selectedIssues
  local selected
  selected="$(jq -r '.selectedIssues[]?' "$repo/.wavemill/merge-queue-selection.json" 2>/dev/null || true)"
  check_contains "preserved-merged: selection includes clean PR" "$selected" "HOK-CLEAN"
  check_not_contains "preserved-merged: selection excludes merged-A" "$selected" "HOK-MERGED-A"
  check_not_contains "preserved-merged: selection excludes merged-B" "$selected" "HOK-MERGED-B"

  # Demoted issues should not include the merged tasks (they were never selected)
  check_file_absent "preserved-merged: no demotions written" "$repo/.wavemill/demoted-issues"
}

test_merge_queue_closed_unmerged_pr_does_not_block_ready_pr() {
  local slug="merge-queue-closed-unmerged"
  local issue="HOK-CLEAN"
  local repo tick worktree_root
  repo="$(harness_init_repo "$slug")"
  worktree_root="$(dirname "$repo")"

  mkdir -p "$repo/features/$slug/ready"
  cat > "$repo/features/$slug/ready/.ready-result.json" <<'EOF'
{
  "stage": "ready",
  "status": "completed",
  "startedAt": "2026-06-25T10:00:00Z",
  "finishedAt": "2026-06-25T10:05:00Z",
  "artifacts": {
    "type": "ready",
    "verdict": "pass",
    "readyBaseSha": "sha-current",
    "queueState": "ready-stale"
  }
}
EOF

  mkdir -p "$worktree_root/closed-unmerged/features/closed-unmerged/ready"
  cat > "$worktree_root/closed-unmerged/features/closed-unmerged/ready/.ready-result.json" <<'EOF'
{
  "stage": "ready",
  "status": "completed",
  "startedAt": "2026-06-25T09:00:00Z",
  "finishedAt": "2026-06-25T09:05:00Z",
  "artifacts": {
    "type": "ready",
    "verdict": "pass",
    "readyBaseSha": "sha-current",
    "queueState": "merge-candidate",
    "candidatePromotedAt": "2026-06-25T09:10:00Z",
    "candidateLastProgressAt": "2026-06-25T09:15:00Z"
  }
}
EOF

  local extra_setup
  extra_setup="TOOLS_DIR=\"${REPO_DIR}/tools\""
  extra_setup+=$'\n'
  extra_setup+='
    CURRENT_PHASE="ready"
    PR_BY_ISSUE["$ISSUE"]="900"
    BRANCH_BY_ISSUE["HOK-CLOSED"]="task/closed-unmerged"
    SLUG_BY_ISSUE["HOK-CLOSED"]="closed-unmerged"
    PR_BY_ISSUE["HOK-CLOSED"]="838"

    get_task_phase() { printf "%s\n" "ready"; }
    get_main_head_sha() { printf "%s\n" "sha-current"; }
    merge_queue_enabled() { return 0; }
    pr_state() {
      if [[ "${1:-}" == "838" ]]; then
        printf "%s\n" "CLOSED"
      else
        printf "%s\n" "OPEN"
      fi
    }
    ready_queue_state() {
      local state_dir="$1"
      jq -r ".artifacts.queueState // empty" "$state_dir/.ready-result.json" 2>/dev/null || printf "\n"
    }
    ready_base_sha() {
      local state_dir="$1"
      jq -r ".artifacts.readyBaseSha // empty" "$state_dir/.ready-result.json" 2>/dev/null || printf "\n"
    }
    ready_queue_field() {
      local state_dir="$1" field="$2"
      jq -r ".artifacts.$field // empty" "$state_dir/.ready-result.json" 2>/dev/null || printf "\n"
    }
    ready_changed_files_json() {
      local state_dir="$1"
      if [[ "$state_dir" == *"closed-unmerged"* ]]; then
        printf "[\"a.ts\"]\n"
      else
        printf "[\"b.ts\"]\n"
      fi
    }
    read_state_value() {
      local arg_issue=""
      local i
      for i in "$@"; do
        if [[ "$i" == "HOK-CLOSED" || "$i" == "HOK-CLEAN" ]]; then
          arg_issue="$i"
          break
        fi
      done
      case "$arg_issue" in
        HOK-CLOSED) printf "%s\n" "active" ;;
        *) printf "\n" ;;
      esac
    }
    promote_merge_candidate() {
      local promo_issue="$1"
      printf "%s\n" "$promo_issue" >> "$REPO_UNDER_TEST/.wavemill/promoted-issues"
    }
    demote_merge_candidate() {
      local demo_issue="$1"
      printf "%s\n" "$demo_issue" >> "$REPO_UNDER_TEST/.wavemill/demoted-issues"
    }
  '

  tick="$(harness_run_tick "$repo" "$slug" "$issue" "$extra_setup")"

  check_file_exists "closed-unmerged: promoted file exists" "$repo/.wavemill/promoted-issues"
  check_contains "closed-unmerged: clean PR promoted" "$(cat "$repo/.wavemill/promoted-issues" 2>/dev/null || true)" "HOK-CLEAN"
  check_not_contains "closed-unmerged: closed PR not promoted" "$(cat "$repo/.wavemill/promoted-issues" 2>/dev/null || true)" "HOK-CLOSED"

  local selected stuck
  selected="$(jq -r '.selectedIssues[]?' "$repo/.wavemill/merge-queue-selection.json" 2>/dev/null || true)"
  stuck="$(jq -r '.stuckIssues[]?' "$repo/.wavemill/merge-queue-selection.json" 2>/dev/null || true)"
  check_contains "closed-unmerged: selection includes clean PR" "$selected" "HOK-CLEAN"
  check_not_contains "closed-unmerged: selection excludes closed PR" "$selected" "HOK-CLOSED"
  check_not_contains "closed-unmerged: stuck excludes closed PR" "$stuck" "HOK-CLOSED"

  check_file_absent "closed-unmerged: no demotions written" "$repo/.wavemill/demoted-issues"
  check_eq "closed-unmerged: task remains active" "1" "$(kv_value "$tick" active_count)"
}

test_coding_blocked_completion_needs_user_without_advancing() {
  local slug="coding-blocked-completion"
  local issue="HOK-1642-BLOCKED"
  local repo tick
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  cat > "$repo/features/$slug/.coding-blocked-completion.json" <<'EOF'
{
  "summary": "coding done; full verification blocked by Docker",
  "reason": "Integration tests require Docker."
}
EOF

  tick="$(harness_run_tick "$repo" "$slug" "$issue" 'CURRENT_PHASE="coding"')"

  check_eq "blocked completion: phase remains coding" "coding" "$(kv_value "$tick" phase)"
  check_eq "blocked completion: coding stage stays running" "running" "$(harness_read_stage_status "$repo" "$slug" coding)"
  check_eq "blocked completion: needs-user attention set" "needs-user" "$(kv_value "$tick" attention)"
  check_eq "blocked completion: task remains active" "1" "$(kv_value "$tick" active_count)"
  check_contains "blocked completion: attention log emitted" "$(kv_value "$tick" log_output)" "needs attention: coding done; full verification blocked by Docker"
  check_file_exists "blocked completion: dedupe marker written" "$repo/features/$slug/.blocked-completion-announced"
}

test_coding_blocked_completion_auto_advances_when_valid() {
  local slug="coding-blocked-auto"
  local issue="HOK-1642-AUTO"
  local repo tick tick_review commit review_setup
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  commit="$(git -C "$repo" rev-parse --short HEAD)"
  cat > "$repo/features/$slug/.coding-blocked-completion.json" <<EOF
{
  "stage": "coding",
  "implementationComplete": true,
  "committed": true,
  "commit": "$commit",
  "passingChecks": ["bash tests/wavemill-mill-advance.test.sh"],
  "blockingChecks": ["pnpm typecheck"],
  "blockingReason": "baseline_tests_failing",
  "evidence": "Repo-level typecheck is failing outside this change.",
  "recommendedAction": "advance_to_review"
}
EOF

  tick="$(harness_run_tick "$repo" "$slug" "$issue" "$(harness_auto_advance_clear_liveness_setup)
_tmux_task_window_target() { printf \"%s\\n\" \"@7\"; }
tmux() { printf \"%s\\n\" \"\$*\" >> \"\$REPO_UNDER_TEST/tmux.log\"; return 0; }")"

  check_eq "auto blocked completion: phase remains coding for handoff" "coding" "$(kv_value "$tick" phase)"
  check_eq "auto blocked completion: coding stage becomes completed" "completed" "$(harness_read_stage_status "$repo" "$slug" coding)"
  check_eq "auto blocked completion: attention cleared" "clear" "$(kv_value "$tick" attention)"
  check_eq "auto blocked completion: task remains active" "1" "$(kv_value "$tick" active_count)"
  check_contains "auto blocked completion: auto-advance log emitted" "$(kv_value "$tick" log_output)" "[auto-advance] $issue advancing coding to review"
  check_contains "auto blocked completion: completed window is killed" "$(cat "$repo/tmux.log")" "kill-window -t @7"
  check_file_exists "auto blocked completion: expected replacement marker written" "$repo/features/$slug/.coding-pane-expected-replacement.json"
  check_file_exists "auto blocked completion: audit artifact written" "$repo/features/$slug/.coding-auto-advance.json"
  check_file_exists "auto blocked completion: coding complete marker written" "$repo/features/$slug/.coding-complete"
  check_file_exists "auto blocked completion: review replacement intent written" "$repo/features/$slug/.coding-pane-replacement-intent.json"
  check_eq "auto blocked completion: replacement intent targets review" "review" "$(jq -r '.to' "$repo/features/$slug/.coding-pane-replacement-intent.json")"
  check_file_absent "auto blocked completion: no dedupe marker written" "$repo/features/$slug/.blocked-completion-announced"

  review_setup='
CURRENT_PHASE="coding"
log() { printf "%s\n" "$*" >> "$REPO_UNDER_TEST/review-log-output"; }
log_warn() { printf "%s\n" "$*" >> "$REPO_UNDER_TEST/review-warn-output"; }
_tmux_task_window_target() { return 1; }
tmux() {
  printf "%s\n" "$*" >> "$REPO_UNDER_TEST/tmux-review.log"
  if [[ "${1:-}" == "display-message" ]]; then
    printf "%s\n" "@8"
  fi
  return 0
}
review_win="$(_ensure_task_window_exists "$SESSION" "$ISSUE" "$SLUG" "$REPO_UNDER_TEST" "review")"
printf "%s\n" "$review_win" > "$REPO_UNDER_TEST/review-window-target"
'
  tick_review="$(harness_run_tick "$repo" "$slug" "$issue" "$review_setup")"
  check_eq "auto blocked completion review: fresh window target returned" "@8" "$(cat "$repo/review-window-target")"
  check_contains "auto blocked completion review: replacement window created" "$(cat "$repo/tmux-review.log")" "new-window -d -t lifecycle-harness -n $issue-$slug -c $repo"
  check_contains "auto blocked completion review: informational lifecycle log emitted" "$(cat "$repo/review-log-output")" "intentionally quarantined after coding"
  check_not_contains "auto blocked completion review: no missing-window warning" "$(cat "$repo/review-warn-output" 2>/dev/null || true)" "missing, recreating"
  check_file_absent "auto blocked completion review: expected replacement consumed" "$repo/features/$slug/.coding-pane-expected-replacement.json"
  check_file_absent "auto blocked completion review: replacement intent consumed" "$repo/features/$slug/.coding-pane-replacement-intent.json"
}

test_coding_blocked_completion_auto_advances_with_wavemill_metadata_noise() {
  local slug="coding-blocked-metadata-noise"
  local issue="HOK-1758-METADATA"
  local repo tick commit feature_dir
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  feature_dir="$repo/features/$slug"
  commit="$(git -C "$repo" rev-parse --short HEAD)"
  cat > "$feature_dir/.coding-blocked-completion.json" <<EOF
{
  "stage": "coding",
  "implementationComplete": true,
  "committed": true,
  "commit": "$commit",
  "passingChecks": ["bash tests/wavemill-mill-advance.test.sh"],
  "blockingChecks": ["pnpm typecheck"],
  "blockingReason": "baseline_tests_failing",
  "evidence": "Repo-level typecheck is failing outside this change.",
  "recommendedAction": "advance_to_review"
}
EOF

  printf '# Plan\n' > "$feature_dir/plan.md"
  printf '# Task Packet\n' > "$feature_dir/task-packet.md"
  printf '# Header\n' > "$feature_dir/task-packet-header.md"
  printf '# Details\n' > "$feature_dir/task-packet-details.md"
  printf '{"issue":"%s"}\n' "$issue" > "$feature_dir/selected-task.json"
  printf '{"prompt":"registry"}\n' > "$repo/prompt-registry.jsonl"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" "$(harness_auto_advance_clear_liveness_setup)")"

  check_eq "metadata noise: phase remains coding for handoff" "coding" "$(kv_value "$tick" phase)"
  check_eq "metadata noise: coding stage becomes completed" "completed" "$(harness_read_stage_status "$repo" "$slug" coding)"
  check_eq "metadata noise: attention cleared" "clear" "$(kv_value "$tick" attention)"
  check_contains "metadata noise: auto-advance log emitted" "$(kv_value "$tick" log_output)" "[auto-advance] $issue advancing coding to review"
  check_file_exists "metadata noise: audit artifact written" "$feature_dir/.coding-auto-advance.json"
  check_file_exists "metadata noise: coding complete marker written" "$feature_dir/.coding-complete"
  check_file_absent "metadata noise: no dedupe marker written" "$feature_dir/.blocked-completion-announced"
}

test_coding_blocked_completion_live_process_needs_attention() {
  local slug="coding-blocked-live-process"
  local issue="HOK-2464-LIVE"
  local repo tick commit hook_file overrides
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  commit="$(git -C "$repo" rev-parse --short HEAD)"
  hook_file="/tmp/wavemill-lifecycle-harness-${issue}.hook"
  cat > "$repo/features/$slug/.coding-blocked-completion.json" <<EOF
{
  "stage": "coding",
  "implementationComplete": true,
  "committed": true,
  "commit": "$commit",
  "passingChecks": ["bash tests/wavemill-mill-advance.test.sh"],
  "blockingChecks": ["pytest -v"],
  "blockingReason": "baseline_tests_failing",
  "evidence": "Repo-level typecheck is failing outside this change.",
  "recommendedAction": "advance_to_review"
}
EOF

  overrides="$(cat <<'EOF'
CURRENT_PHASE="coding"
mill_pane_has_live_blocking_process() {
  MILL_BLOCKING_PROCESS_COMMAND="pytest -v"
  MILL_BLOCKING_PROCESS_REASON=""
  MILL_BLOCKING_PROCESS_MATCH_COUNT=1
  MILL_BLOCKING_PROCESS_PIDS=("4242")
  return 0
}
EOF
)"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" "$overrides")"

  check_eq "live process: coding stage stays running" "running" "$(harness_read_stage_status "$repo" "$slug" coding)"
  check_eq "live process: needs-user attention set" "needs-user" "$(kv_value "$tick" attention)"
  check_contains "live process: attention log mentions running command" "$(kv_value "$tick" log_output)" "live blocking command is still running"
  check_file_absent "live process: no auto audit written" "$repo/features/$slug/.coding-auto-advance.json"
  check_file_absent "live process: no coding complete marker" "$repo/features/$slug/.coding-complete"
  check_eq "live process: hook state blocked" "blocked" "$(jq -r '.state // empty' "$hook_file" 2>/dev/null || true)"
  check_contains "live process: hook next action names issue" "$(jq -r '.next_action // empty' "$hook_file" 2>/dev/null || true)" "$issue"
}

test_coding_blocked_completion_terminates_live_process_when_configured() {
  local slug="coding-blocked-terminate"
  local issue="HOK-2464-TERM"
  local repo tick commit overrides
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  commit="$(git -C "$repo" rev-parse --short HEAD)"
  cat > "$repo/features/$slug/.coding-blocked-completion.json" <<EOF
{
  "stage": "coding",
  "implementationComplete": true,
  "committed": true,
  "commit": "$commit",
  "passingChecks": ["bash tests/wavemill-mill-advance.test.sh"],
  "blockingChecks": ["pytest -v"],
  "blockingReason": "baseline_tests_failing",
  "evidence": "Repo-level typecheck is failing outside this change.",
  "recommendedAction": "advance_to_review"
}
EOF

  overrides="$(cat <<'EOF'
CURRENT_PHASE="coding"
WAVEMILL_BLOCKED_COMPLETION_LIVE_PROCESS_MODE="terminate"
MILL_LIVENESS_CALLS=0
mill_pane_has_live_blocking_process() {
  MILL_LIVENESS_CALLS=$((MILL_LIVENESS_CALLS + 1))
  if [[ "$MILL_LIVENESS_CALLS" -eq 1 ]]; then
    MILL_BLOCKING_PROCESS_COMMAND="pytest -v"
    MILL_BLOCKING_PROCESS_REASON=""
    MILL_BLOCKING_PROCESS_MATCH_COUNT=1
    MILL_BLOCKING_PROCESS_PIDS=("5151")
    return 0
  fi
  MILL_BLOCKING_PROCESS_COMMAND=""
  MILL_BLOCKING_PROCESS_REASON=""
  MILL_BLOCKING_PROCESS_MATCH_COUNT=0
  MILL_BLOCKING_PROCESS_PIDS=()
  return 1
}
mill_terminate_blocking_processes() {
  [[ "$2" == "5151" ]] || return 1
  return 0
}
EOF
)"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" "$overrides")"

  check_eq "terminate mode: coding stage becomes completed" "completed" "$(harness_read_stage_status "$repo" "$slug" coding)"
  check_eq "terminate mode: attention cleared" "clear" "$(kv_value "$tick" attention)"
  check_contains "terminate mode: termination log emitted" "$(kv_value "$tick" log_output)" "terminated live blocking process before coding handoff"
  check_file_exists "terminate mode: auto audit written" "$repo/features/$slug/.coding-auto-advance.json"
  check_file_exists "terminate mode: coding complete marker written" "$repo/features/$slug/.coding-complete"
}

test_coding_blocked_completion_indeterminate_liveness_needs_attention() {
  local slug="coding-blocked-indeterminate"
  local issue="HOK-2464-INDET"
  local repo tick commit hook_file
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  commit="$(git -C "$repo" rev-parse --short HEAD)"
  hook_file="/tmp/wavemill-lifecycle-harness-${issue}.hook"
  cat > "$repo/features/$slug/.coding-blocked-completion.json" <<EOF
{
  "stage": "coding",
  "implementationComplete": true,
  "committed": true,
  "commit": "$commit",
  "passingChecks": ["bash tests/wavemill-mill-advance.test.sh"],
  "blockingChecks": ["pytest -v"],
  "blockingReason": "baseline_tests_failing",
  "evidence": "Repo-level typecheck is failing outside this change.",
  "recommendedAction": "advance_to_review"
}
EOF

  tick="$(harness_run_tick "$repo" "$slug" "$issue" '
    CURRENT_PHASE="coding"
    mill_pane_has_live_blocking_process() {
      MILL_BLOCKING_PROCESS_COMMAND=""
      MILL_BLOCKING_PROCESS_REASON="pane pid unavailable"
      MILL_BLOCKING_PROCESS_MATCH_COUNT=0
      MILL_BLOCKING_PROCESS_PIDS=()
      return 2
    }
  ')"

  check_eq "indeterminate liveness: coding stage stays running" "running" "$(harness_read_stage_status "$repo" "$slug" coding)"
  check_eq "indeterminate liveness: needs-user attention set" "needs-user" "$(kv_value "$tick" attention)"
  check_contains "indeterminate liveness: diagnostic log emitted" "$(kv_value "$tick" log_output)" "liveness is indeterminate"
  check_file_absent "indeterminate liveness: no auto audit written" "$repo/features/$slug/.coding-auto-advance.json"
  check_file_absent "indeterminate liveness: no coding complete marker" "$repo/features/$slug/.coding-complete"
  check_eq "indeterminate liveness: hook state blocked" "blocked" "$(jq -r '.state // empty' "$hook_file" 2>/dev/null || true)"
}

test_coding_blocked_completion_missing_blocking_checks_advances_when_pane_is_gone() {
  local slug="coding-blocked-missing-blocking-checks"
  local issue="HOK-2464-MISSING-CHECKS"
  local repo tick commit overrides
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  commit="$(git -C "$repo" rev-parse --short HEAD)"
  cat > "$repo/features/$slug/.coding-blocked-completion.json" <<EOF
{
  "stage": "coding",
  "implementationComplete": true,
  "committed": true,
  "commit": "$commit",
  "passingChecks": ["bash tests/wavemill-mill-advance.test.sh"],
  "blockingReason": "baseline_tests_failing",
  "evidence": "Repo-level typecheck is failing outside this change.",
  "recommendedAction": "advance_to_review"
}
EOF

  overrides="$(cat <<'EOF'
CURRENT_PHASE="coding"
mill_pane_has_live_blocking_process() {
  [[ "$#" -eq 1 ]] || return 2
  MILL_BLOCKING_PROCESS_COMMAND=""
  MILL_BLOCKING_PROCESS_REASON=""
  MILL_BLOCKING_PROCESS_MATCH_COUNT=0
  MILL_BLOCKING_PROCESS_PIDS=()
  return 1
}
EOF
)"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" "$overrides")"

  check_eq "missing blocking checks: coding stage stays running" "running" "$(harness_read_stage_status "$repo" "$slug" coding)"
  check_eq "missing blocking checks: needs-user attention set" "needs-user" "$(kv_value "$tick" attention)"
  check_file_absent "missing blocking checks: no auto audit written" "$repo/features/$slug/.coding-auto-advance.json"
  check_file_absent "missing blocking checks: no coding complete marker written" "$repo/features/$slug/.coding-complete"
}

test_coding_blocked_completion_empty_blocking_checks_falls_back_to_any_descendant() {
  local slug="coding-blocked-empty-blocking-checks"
  local issue="HOK-2464-EMPTY-CHECKS"
  local repo tick commit overrides
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  commit="$(git -C "$repo" rev-parse --short HEAD)"
  cat > "$repo/features/$slug/.coding-blocked-completion.json" <<EOF
{
  "stage": "coding",
  "implementationComplete": true,
  "committed": true,
  "commit": "$commit",
  "passingChecks": ["bash tests/wavemill-mill-advance.test.sh"],
  "blockingChecks": [],
  "blockingReason": "baseline_tests_failing",
  "evidence": "Repo-level typecheck is failing outside this change.",
  "recommendedAction": "advance_to_review"
}
EOF

  overrides="$(cat <<'EOF'
CURRENT_PHASE="coding"
mill_pane_has_live_blocking_process() {
  [[ "$#" -eq 1 ]] || return 2
  MILL_BLOCKING_PROCESS_COMMAND="pid 6262"
  MILL_BLOCKING_PROCESS_REASON=""
  MILL_BLOCKING_PROCESS_MATCH_COUNT=1
  MILL_BLOCKING_PROCESS_PIDS=("6262")
  return 0
}
EOF
)"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" "$overrides")"

  check_eq "empty blocking checks: coding stage stays running" "running" "$(harness_read_stage_status "$repo" "$slug" coding)"
  check_eq "empty blocking checks: needs-user attention set" "needs-user" "$(kv_value "$tick" attention)"
  check_contains "empty blocking checks: attention log emitted" "$(kv_value "$tick" log_output)" "live blocking command is still running"
  check_file_absent "empty blocking checks: no auto audit written" "$repo/features/$slug/.coding-auto-advance.json"
  check_file_absent "empty blocking checks: no coding complete marker" "$repo/features/$slug/.coding-complete"
}

test_coding_blocked_completion_dedupes_same_artifact() {
  local slug="coding-blocked-completion-dedupe"
  local issue="HOK-1642-DEDUP"
  local repo tick1 tick2
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  cat > "$repo/features/$slug/.coding-blocked-completion.json" <<'EOF'
{
  "summary": "coding done; waiting on baseline tests"
}
EOF

  tick1="$(harness_run_tick "$repo" "$slug" "$issue" 'CURRENT_PHASE="coding"')"
  tick2="$(harness_run_tick "$repo" "$slug" "$issue" 'CURRENT_PHASE="coding"')"

  check_contains "dedupe: first poll logs attention" "$(kv_value "$tick1" log_output)" "needs attention: coding done; waiting on baseline tests"
  check_eq "dedupe: second poll stays active" "1" "$(kv_value "$tick2" active_count)"
  check_eq "dedupe: second poll keeps needs-user attention" "needs-user" "$(kv_value "$tick2" attention)"
  check_not_contains "dedupe: second poll emits no duplicate log" "$(kv_value "$tick2" log_output)" "needs attention: coding done; waiting on baseline tests"
}

test_coding_blocked_completion_reannounces_on_mtime_change() {
  local slug="coding-blocked-completion-refresh"
  local issue="HOK-1642-REFRESH"
  local repo tick1 tick2 artifact
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  artifact="$repo/features/$slug/.coding-blocked-completion.json"
  cat > "$artifact" <<'EOF'
{
  "summary": "coding done; verification blocked by Docker"
}
EOF

  tick1="$(harness_run_tick "$repo" "$slug" "$issue" 'CURRENT_PHASE="coding"')"
  perl -e 'my $path = shift; my $now = time + 5; utime $now, $now, $path or die $!;' "$artifact"
  tick2="$(harness_run_tick "$repo" "$slug" "$issue" 'CURRENT_PHASE="coding"')"

  check_contains "mtime refresh: first poll logs attention" "$(kv_value "$tick1" log_output)" "needs attention: coding done; verification blocked by Docker"
  check_contains "mtime refresh: second poll logs again after touch" "$(kv_value "$tick2" log_output)" "needs attention: coding done; verification blocked by Docker"
}

test_coding_complete_wins_over_blocked_completion() {
  local slug="coding-complete-wins"
  local issue="HOK-1642-COMPLETE"
  local repo tick
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  printf '{"stage":"coding","confidence":"high"}\n' > "$repo/features/$slug/.coding-complete"
  cat > "$repo/features/$slug/.coding-blocked-completion.json" <<'EOF'
{
  "summary": "coding done; verification blocked by Docker"
}
EOF

  tick="$(harness_run_tick "$repo" "$slug" "$issue" 'CURRENT_PHASE="coding"')"

  check_eq "coding complete wins: phase does not request needs-user" "" "$(kv_value "$tick" attention)"
  check_eq "coding complete wins: coding stage becomes completed" "completed" "$(harness_read_stage_status "$repo" "$slug" coding)"
  check_not_contains "coding complete wins: no blocked-attention log" "$(kv_value "$tick" log_output)" "needs attention:"
}

test_coding_complete_dirty_worktree_without_commits_needs_attention() {
  local slug="coding-complete-uncommitted-output"
  local issue="HOK-2266-UNCOMMITTED"
  local repo tick feature_dir
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  feature_dir="$repo/features/$slug"

  printf '{"stage":"coding","confidence":"high"}\n' > "$feature_dir/.coding-complete"
  printf 'pending implementation\n' > "$repo/src-uncommitted.ts"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" 'CURRENT_PHASE="coding"')"

  check_eq "uncommitted output: phase stays coding" "coding" "$(kv_value "$tick" phase)"
  check_eq "uncommitted output: coding stage stays running" "running" "$(harness_read_stage_status "$repo" "$slug" coding)"
  check_eq "uncommitted output: needs-user attention set" "needs-user" "$(kv_value "$tick" attention)"
  check_eq "uncommitted output: task remains active" "1" "$(kv_value "$tick" active_count)"
  check_not_contains "uncommitted output: review does not launch" "$(kv_value "$tick" log_output)" "Launching review phase"
  check_contains "uncommitted output: actionable log emitted" "$(kv_value "$tick" log_output)" "branch has no commits beyond main and worktree still contains uncommitted coding output"
  check_file_exists "uncommitted output: artifact written" "$feature_dir/.coding-uncommitted-output.json"
  check_file_exists "uncommitted output: dedupe marker written" "$feature_dir/.coding-uncommitted-output-announced"
}

test_coding_complete_uncommitted_output_dedupes_stable_condition() {
  local slug="coding-complete-uncommitted-output-dedupe"
  local issue="HOK-2405-DEDUP"
  local repo tick1 tick2 feature_dir artifact marker backdated_mtime after_mtime
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  feature_dir="$repo/features/$slug"
  artifact="$feature_dir/.coding-uncommitted-output.json"
  marker="$feature_dir/.coding-uncommitted-output-announced"

  printf '{"stage":"coding","confidence":"high"}\n' > "$feature_dir/.coding-complete"
  printf 'pending implementation\n' > "$repo/src-uncommitted.ts"

  tick1="$(harness_run_tick "$repo" "$slug" "$issue" 'CURRENT_PHASE="coding"')"
  check_contains "stable uncommitted output: first tick logs attention" "$(kv_value "$tick1" log_output)" "branch has no commits beyond main and worktree still contains uncommitted coding output"
  check_file_exists "stable uncommitted output: artifact written" "$artifact"
  check_file_exists "stable uncommitted output: marker written" "$marker"

  backdated_mtime="$(harness_backdate_file "$artifact")"
  printf '%s\n' "$backdated_mtime" > "$marker"

  tick2="$(harness_run_tick "$repo" "$slug" "$issue" 'CURRENT_PHASE="coding"')"
  after_mtime="$(harness_file_mtime_epoch "$artifact")"

  check_eq "stable uncommitted output: second tick stays coding" "coding" "$(kv_value "$tick2" phase)"
  check_eq "stable uncommitted output: coding stage stays running" "running" "$(harness_read_stage_status "$repo" "$slug" coding)"
  check_eq "stable uncommitted output: second tick keeps needs-user attention" "needs-user" "$(kv_value "$tick2" attention)"
  check_eq "stable uncommitted output: second tick task remains active" "1" "$(kv_value "$tick2" active_count)"
  check_not_contains "stable uncommitted output: second tick emits no duplicate log" "$(kv_value "$tick2" log_output)" "needs attention:"
  check_eq "stable uncommitted output: artifact mtime preserved" "$backdated_mtime" "$after_mtime"
}

test_coding_complete_uncommitted_output_reannounces_on_dirty_path_change() {
  local slug="coding-complete-uncommitted-output-path-change"
  local issue="HOK-2405-PATH"
  local repo tick1 tick2 feature_dir artifact marker backdated_mtime after_mtime
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  feature_dir="$repo/features/$slug"
  artifact="$feature_dir/.coding-uncommitted-output.json"
  marker="$feature_dir/.coding-uncommitted-output-announced"

  printf '{"stage":"coding","confidence":"high"}\n' > "$feature_dir/.coding-complete"
  printf 'pending implementation\n' > "$repo/src-uncommitted.ts"

  tick1="$(harness_run_tick "$repo" "$slug" "$issue" 'CURRENT_PHASE="coding"')"
  check_contains "dirty path change: first tick logs attention" "$(kv_value "$tick1" log_output)" "branch has no commits beyond main and worktree still contains uncommitted coding output"

  backdated_mtime="$(harness_backdate_file "$artifact")"
  printf '%s\n' "$backdated_mtime" > "$marker"
  printf 'second pending file\n' > "$repo/src-second.ts"

  tick2="$(harness_run_tick "$repo" "$slug" "$issue" 'CURRENT_PHASE="coding"')"
  after_mtime="$(harness_file_mtime_epoch "$artifact")"

  check_contains "dirty path change: second tick reannounces" "$(kv_value "$tick2" log_output)" "branch has no commits beyond main and worktree still contains uncommitted coding output"
  check_eq "dirty path change: second tick task remains active" "1" "$(kv_value "$tick2" active_count)"
  check_eq "dirty path change: second tick keeps needs-user attention" "needs-user" "$(kv_value "$tick2" attention)"
  check_ne "dirty path change: artifact mtime refreshed" "$backdated_mtime" "$after_mtime"
  check_eq "dirty path change: artifact has two dirty paths" "2" "$(jq -r '.dirtyPaths | length' "$artifact")"
}

test_coding_complete_uncommitted_output_reannounces_on_ahead_count_change() {
  local slug="coding-complete-uncommitted-output-ahead-change"
  local issue="HOK-2405-AHEAD"
  local repo tick1 tick2 feature_dir artifact marker backdated_mtime tick_overrides
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  feature_dir="$repo/features/$slug"
  artifact="$feature_dir/.coding-uncommitted-output.json"
  marker="$feature_dir/.coding-uncommitted-output-announced"
  tick_overrides='CURRENT_PHASE="coding"; BASE_BRANCH="auto/integration"'

  git -C "$repo" branch auto/integration

  printf '{"stage":"coding","confidence":"high"}\n' > "$feature_dir/.coding-complete"
  printf 'pending implementation\n' > "$repo/src-uncommitted.ts"

  tick1="$(harness_run_tick "$repo" "$slug" "$issue" "$tick_overrides")"
  check_contains "ahead change: first tick logs no-commit attention" "$(kv_value "$tick1" log_output)" "branch has no commits beyond auto/integration and worktree still contains uncommitted coding output"

  backdated_mtime="$(harness_backdate_file "$artifact")"
  printf '%s\n' "$backdated_mtime" > "$marker"
  printf 'committed implementation\n' >> "$repo/README.md"
  git -C "$repo" add README.md
  git -C "$repo" commit -q -m "feat: committed coding output"

  tick2="$(harness_run_tick "$repo" "$slug" "$issue" "$tick_overrides")"

  check_contains "ahead change: second tick logs dirty-tree attention" "$(kv_value "$tick2" log_output)" "worktree still contains uncommitted coding output"
  check_contains "ahead change: second tick uses clean action" "$(kv_value "$tick2" log_output)" "Clean the dirty paths, then retry review."
  check_eq "ahead change: reason changed" "coding_output_dirty_tree" "$(jq -r '.reason' "$artifact")"
  check_eq "ahead change: ahead count changed" "1" "$(jq -r '.aheadCount' "$artifact")"
}

test_coding_complete_uncommitted_output_resolves_to_jsonl_log() {
  local slug="coding-complete-uncommitted-output-resolved"
  local issue="HOK-2894-RESOLVED"
  local repo tick1 tick2 feature_dir artifact resolved_log first_detected line_count
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  feature_dir="$repo/features/$slug"
  artifact="$feature_dir/.coding-uncommitted-output.json"
  resolved_log="$feature_dir/.coding-uncommitted-output.resolved.jsonl"

  printf '{"stage":"coding","confidence":"high"}\n' > "$feature_dir/.coding-complete"
  printf 'pending implementation\n' > "$repo/src-uncommitted.ts"

  tick1="$(harness_run_tick "$repo" "$slug" "$issue" 'CURRENT_PHASE="coding"')"
  check_eq "resolved log: first tick keeps needs-user" "needs-user" "$(kv_value "$tick1" attention)"
  check_file_exists "resolved log: artifact written before resolution" "$artifact"
  check_file_absent "resolved log: no log entry before resolution" "$resolved_log"
  first_detected="$(jq -r '.detectedAt' "$artifact")"

  # Operator completes the handoff by committing the agent's uncommitted output.
  git -C "$repo" add src-uncommitted.ts
  git -C "$repo" commit -q -m "chore: commit agent output (operator handoff)"

  tick2="$(harness_run_tick "$repo" "$slug" "$issue" 'CURRENT_PHASE="coding"')"

  check_eq "resolved log: second tick clears attention" "" "$(kv_value "$tick2" attention)"
  check_eq "resolved log: coding stage becomes completed" "completed" "$(harness_read_stage_status "$repo" "$slug" coding)"
  check_file_absent "resolved log: live artifact removed" "$artifact"
  check_file_exists "resolved log: resolved jsonl written" "$resolved_log"

  line_count="$(wc -l < "$resolved_log" | tr -d ' ')"
  check_eq "resolved log: exactly one resolved episode" "1" "$line_count"
  check_eq "resolved log: detectedAt preserved" "$first_detected" "$(jq -r '.detectedAt' "$resolved_log")"
  check_ne "resolved log: resolvedAt is recorded" "" "$(jq -r '.resolvedAt' "$resolved_log")"
  check_contains "resolved log: dirtyPaths preserved" "$(jq -r '.dirtyPaths[]?' "$resolved_log")" "src-uncommitted.ts"
}

test_write_coding_uncommitted_output_artifact_idempotent() {
  local slug="coding-uncommitted-output-direct"
  local feature_dir artifact first_mtime second_mtime third_mtime healed_mtime
  local first_detected second_detected dirty_paths
  source "$REPO_DIR/shared/lib/wavemill-common.sh"
  source "$REAL_FUNC_FILE"

  feature_dir="$TEST_TMP/$slug/features/$slug"
  mkdir -p "$feature_dir"
  artifact="$feature_dir/.coding-uncommitted-output.json"
  dirty_paths="src-uncommitted.ts"

  write_coding_uncommitted_output_artifact "HOK-2405-DIRECT" "$feature_dir" "main" "0" "0" "$dirty_paths" "summary" "action" "coding_output_not_committed"
  first_detected="$(jq -r '.detectedAt' "$artifact")"
  first_mtime="$(harness_backdate_file "$artifact")"

  write_coding_uncommitted_output_artifact "HOK-2405-DIRECT" "$feature_dir" "main" "0" "0" "$dirty_paths" "summary" "action" "coding_output_not_committed"
  second_mtime="$(harness_file_mtime_epoch "$artifact")"
  second_detected="$(jq -r '.detectedAt' "$artifact")"

  check_eq "direct idempotent: equivalent content preserves mtime" "$first_mtime" "$second_mtime"
  check_eq "direct idempotent: equivalent content preserves detectedAt" "$first_detected" "$second_detected"

  write_coding_uncommitted_output_artifact "HOK-2405-DIRECT" "$feature_dir" "main" "0" "0" $'src-uncommitted.ts\nsrc-second.ts' "summary" "action" "coding_output_not_committed"
  third_mtime="$(harness_file_mtime_epoch "$artifact")"
  check_ne "direct idempotent: dirty path change refreshes mtime" "$first_mtime" "$third_mtime"
  check_eq "direct idempotent: dirty path change recorded" "src-second.ts" "$(jq -r '.dirtyPaths[1]' "$artifact")"

  printf 'not-json\n' > "$artifact"
  healed_mtime="$(harness_backdate_file "$artifact")"
  write_coding_uncommitted_output_artifact "HOK-2405-DIRECT" "$feature_dir" "main" "0" "0" "$dirty_paths" "summary" "action" "coding_output_not_committed"
  check_ne "direct idempotent: corrupt artifact is replaced" "$healed_mtime" "$(harness_file_mtime_epoch "$artifact")"
  check_eq "direct idempotent: corrupt artifact heals to valid json" "coding_output_not_committed" "$(jq -r '.reason' "$artifact")"
}

test_coding_complete_dirty_worktree_with_commits_needs_attention() {
  local slug="coding-complete-dirty-tree"
  local issue="HOK-2345-DIRTY"
  local repo tick feature_dir
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  feature_dir="$repo/features/$slug"

  printf 'committed change\n' >> "$repo/README.md"
  git -C "$repo" add README.md
  git -C "$repo" commit -m "feat: committed coding output" >/dev/null 2>&1

  printf '{"stage":"coding","confidence":"high"}\n' > "$feature_dir/.coding-complete"
  printf 'still dirty\n' >> "$repo/src-dirty.ts"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" 'CURRENT_PHASE="coding"')"

  check_eq "dirty tree: phase stays coding" "coding" "$(kv_value "$tick" phase)"
  check_eq "dirty tree: coding stage stays running" "running" "$(harness_read_stage_status "$repo" "$slug" coding)"
  check_eq "dirty tree: needs-user attention set" "needs-user" "$(kv_value "$tick" attention)"
  check_eq "dirty tree: task remains active" "1" "$(kv_value "$tick" active_count)"
  check_not_contains "dirty tree: review does not launch" "$(kv_value "$tick" log_output)" "Launching review phase"
  check_contains "dirty tree: actionable log emitted" "$(kv_value "$tick" log_output)" "worktree still contains uncommitted coding output"
  check_file_exists "dirty tree: artifact written" "$feature_dir/.coding-uncommitted-output.json"
  check_file_exists "dirty tree: dedupe marker written" "$feature_dir/.coding-uncommitted-output-announced"
}

test_coding_complete_trace_only_dirty_worktree_advances() {
  local slug="coding-complete-trace-only"
  local issue="HOK-2454-TRACE"
  local repo tick feature_dir
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  feature_dir="$repo/features/$slug"

  printf '{"stage":"coding","confidence":"high"}\n' > "$feature_dir/.coding-complete"
  printf '{"event":"phase_completed"}\n' > "$feature_dir/trace.jsonl"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" 'CURRENT_PHASE="coding"')"

  check_eq "trace only: phase stays coding until review tick" "coding" "$(kv_value "$tick" phase)"
  check_eq "trace only: coding stage becomes completed" "completed" "$(harness_read_stage_status "$repo" "$slug" coding)"
  check_eq "trace only: no needs-user attention" "" "$(kv_value "$tick" attention)"
  check_eq "trace only: task remains active" "1" "$(kv_value "$tick" active_count)"
  check_contains "trace only: completion log emitted" "$(kv_value "$tick" log_output)" ".coding-complete detected, marking coding as completed"
  check_file_absent "trace only: no uncommitted artifact written" "$feature_dir/.coding-uncommitted-output.json"
  check_file_absent "trace only: no dedupe marker written" "$feature_dir/.coding-uncommitted-output-announced"
}

test_coding_complete_local_config_overlay_advances() {
  local slug="coding-complete-local-config-overlay"
  local issue="HOK-2454-LOCAL-CONFIG"
  local repo tick feature_dir
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  feature_dir="$repo/features/$slug"

  printf '{"stage":"coding","confidence":"high"}\n' > "$feature_dir/.coding-complete"
  printf '{"mill":{"maxParallel":1}}\n' > "$repo/.wavemill-config.local.json"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" 'CURRENT_PHASE="coding"')"

  check_eq "local config overlay: coding becomes completed" "completed" "$(harness_read_stage_status "$repo" "$slug" coding)"
  check_eq "local config overlay: no needs-user attention" "" "$(kv_value "$tick" attention)"
  check_file_absent "local config overlay: no uncommitted artifact written" "$feature_dir/.coding-uncommitted-output.json"
}

test_coding_complete_tracked_claude_settings_advances() {
  local slug="coding-complete-tracked-claude-settings"
  local issue="HOK-2454-CLAUDE-SETTINGS"
  local repo tick feature_dir
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  feature_dir="$repo/features/$slug"

  mkdir -p "$repo/.claude"
  printf '{}\n' > "$repo/.claude/settings.local.json"
  git -C "$repo" add -f .claude/settings.local.json
  git -C "$repo" commit -q -m "test: track Claude local settings"

  printf '{"stage":"coding","confidence":"high"}\n' > "$feature_dir/.coding-complete"
  printf '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"wavemill-hook.sh"}]}]}}\n' > "$repo/.claude/settings.local.json"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" 'CURRENT_PHASE="coding"')"

  check_eq "tracked Claude settings: coding becomes completed" "completed" "$(harness_read_stage_status "$repo" "$slug" coding)"
  check_eq "tracked Claude settings: no needs-user attention" "" "$(kv_value "$tick" attention)"
  check_file_absent "tracked Claude settings: no uncommitted artifact written" "$feature_dir/.coding-uncommitted-output.json"
}

test_coding_complete_metadata_only_routing_advances_to_review() {
  local slug="coding-complete-routing-only"
  local issue="HOK-2446-ROUTING"
  local repo tick feature_dir
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  feature_dir="$repo/features/$slug"

  printf '{"stage":"coding","confidence":"high"}\n' > "$feature_dir/.coding-complete"
  printf '{"agent":"codex"}\n' > "$feature_dir/routing.jsonl"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" 'CURRENT_PHASE="coding"')"

  check_eq "routing only: phase stays coding until review tick" "coding" "$(kv_value "$tick" phase)"
  check_eq "routing only: coding stage becomes completed" "completed" "$(harness_read_stage_status "$repo" "$slug" coding)"
  check_eq "routing only: no needs-user attention" "" "$(kv_value "$tick" attention)"
  check_eq "routing only: task remains active" "1" "$(kv_value "$tick" active_count)"
  check_contains "routing only: completion log emitted" "$(kv_value "$tick" log_output)" ".coding-complete detected, marking coding as completed"
  check_file_absent "routing only: no uncommitted artifact written" "$feature_dir/.coding-uncommitted-output.json"
  check_file_absent "routing only: no dedupe marker written" "$feature_dir/.coding-uncommitted-output-announced"
}

test_coding_complete_source_dirty_still_blocks() {
  local slug="coding-complete-feature-source-dirty"
  local issue="HOK-2446-SOURCE"
  local repo tick feature_dir
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  feature_dir="$repo/features/$slug"

  printf 'committed change\n' >> "$repo/README.md"
  git -C "$repo" add README.md
  git -C "$repo" commit -m "feat: committed coding output" >/dev/null 2>&1
  printf '{"stage":"coding","confidence":"high"}\n' > "$feature_dir/.coding-complete"
  printf 'export const extra = true;\n' > "$feature_dir/extra.ts"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" 'CURRENT_PHASE="coding"')"

  check_eq "feature source dirty: phase stays coding" "coding" "$(kv_value "$tick" phase)"
  check_eq "feature source dirty: coding stage stays running" "running" "$(harness_read_stage_status "$repo" "$slug" coding)"
  check_eq "feature source dirty: needs-user attention set" "needs-user" "$(kv_value "$tick" attention)"
  check_eq "feature source dirty: task remains active" "1" "$(kv_value "$tick" active_count)"
  check_not_contains "feature source dirty: review does not launch" "$(kv_value "$tick" log_output)" "Launching review phase"
  check_contains "feature source dirty: actionable log emitted" "$(kv_value "$tick" log_output)" "worktree still contains uncommitted coding output"
  check_file_exists "feature source dirty: artifact written" "$feature_dir/.coding-uncommitted-output.json"
  check_file_exists "feature source dirty: dedupe marker written" "$feature_dir/.coding-uncommitted-output-announced"
}

test_coding_complete_trace_and_source_dirty_worktree_needs_attention() {
  local slug="coding-complete-trace-and-source"
  local issue="HOK-2454-MIXED"
  local repo tick feature_dir dirty_paths
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  feature_dir="$repo/features/$slug"

  printf 'committed change\n' >> "$repo/README.md"
  git -C "$repo" add README.md
  git -C "$repo" commit -m "feat: committed coding output" >/dev/null 2>&1
  printf '{"stage":"coding","confidence":"high"}\n' > "$feature_dir/.coding-complete"
  printf '{"event":"phase_started"}\n' > "$feature_dir/trace.jsonl"
  printf 'still dirty\n' > "$repo/src-dirty.ts"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" 'CURRENT_PHASE="coding"')"
  dirty_paths="$(jq -r '.dirtyPaths[]?' "$feature_dir/.coding-uncommitted-output.json")"

  check_eq "trace and source: phase stays coding" "coding" "$(kv_value "$tick" phase)"
  check_eq "trace and source: coding stays running" "running" "$(harness_read_stage_status "$repo" "$slug" coding)"
  check_eq "trace and source: needs-user attention set" "needs-user" "$(kv_value "$tick" attention)"
  check_contains "trace and source: real source reported" "$dirty_paths" "src-dirty.ts"
  check_not_contains "trace and source: trace omitted from dirty paths" "$dirty_paths" "trace.jsonl"
}

test_stage_result_trace_events_are_idempotent() {
  local slug="stage-result-trace-idempotent"
  local issue="HOK-2454-TRACE-EVENTS"
  local repo starts completions
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"

  harness_run_tick "$repo" "$slug" "$issue" '
    CURRENT_PHASE="coding"
    monitor_issue_state() { :; }
    rm -f "$REPO_UNDER_TEST/features/$SLUG/.coding-result.json"
    printf "{\\\"issueId\\\":\\\"issue-1\\\",\\\"slug\\\":\\\"%s\\\"}\\n" "$SLUG" > "$REPO_UNDER_TEST/features/$SLUG/.trace-context.json"
    trace_read_id() { printf "%s\\n" "trace-1"; }
    trace_append_event() { printf "%s\\n" "$*" >> "$REPO_UNDER_TEST/trace-events.log"; }
    write_stage_result "$REPO_UNDER_TEST/features/$SLUG" coding running codex test-model
    write_stage_result "$REPO_UNDER_TEST/features/$SLUG" coding running codex test-model
    write_stage_result "$REPO_UNDER_TEST/features/$SLUG" coding completed codex test-model
    write_stage_result "$REPO_UNDER_TEST/features/$SLUG" coding completed codex test-model
  ' >/dev/null

  starts="$(grep -c 'phase_started' "$repo/trace-events.log")"
  completions="$(grep -c 'phase_completed' "$repo/trace-events.log")"
  check_eq "trace events: one running transition" "1" "$starts"
  check_eq "trace events: one completion transition" "1" "$completions"
}

test_completed_coding_pane_is_quarantined_best_effort() {
  local slug="coding-complete-pane-quarantine"
  local issue="HOK-2454-PANE"
  local repo tick tick_review feature_dir review_setup
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  feature_dir="$repo/features/$slug"
  printf '{"stage":"coding","confidence":"high"}\n' > "$feature_dir/.coding-complete"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" '
    CURRENT_PHASE="coding"
    _tmux_task_window_target() { printf "%s\\n" "@7"; }
    tmux() { printf "%s\\n" "$*" >> "$REPO_UNDER_TEST/tmux.log"; return 0; }
  ')"

  check_eq "pane quarantine: coding stage becomes completed" "completed" "$(harness_read_stage_status "$repo" "$slug" coding)"
  check_contains "pane quarantine: completed window is killed" "$(cat "$repo/tmux.log")" "kill-window -t @7"
  check_file_exists "pane quarantine: expected replacement marker written" "$repo/features/$slug/.coding-pane-expected-replacement.json"
  check_eq "pane quarantine: state advances despite cleanup" "" "$(kv_value "$tick" attention)"

  review_setup='
CURRENT_PHASE="coding"
log() { printf "%s\n" "$*" >> "$REPO_UNDER_TEST/review-log-output"; }
log_warn() { printf "%s\n" "$*" >> "$REPO_UNDER_TEST/review-warn-output"; }
_tmux_task_window_target() { return 1; }
tmux() {
  printf "%s\n" "$*" >> "$REPO_UNDER_TEST/tmux-review.log"
  if [[ "${1:-}" == "display-message" ]]; then
    printf "%s\n" "@8"
  fi
  return 0
}
review_win="$(_ensure_task_window_exists "$SESSION" "$ISSUE" "$SLUG" "$REPO_UNDER_TEST")"
printf "%s\n" "$review_win" > "$REPO_UNDER_TEST/review-window-target"
'
  tick_review="$(harness_run_tick "$repo" "$slug" "$issue" "$review_setup")"
  check_eq "pane quarantine review: fresh window target returned" "@8" "$(cat "$repo/review-window-target")"
  check_contains "pane quarantine review: replacement window created" "$(cat "$repo/tmux-review.log")" "new-window -d -t lifecycle-harness -n $issue-$slug -c $repo"
  check_contains "pane quarantine review: informational lifecycle log emitted" "$(cat "$repo/review-log-output")" "intentionally quarantined after coding"
  check_not_contains "pane quarantine review: no missing-window warning" "$(cat "$repo/review-warn-output" 2>/dev/null || true)" "missing, recreating"
  check_file_absent "pane quarantine review: expected replacement consumed" "$repo/features/$slug/.coding-pane-expected-replacement.json"
}

test_coding_blocked_completion_malformed_json_falls_back() {
  local slug="coding-blocked-completion-malformed"
  local issue="HOK-1642-MALFORMED"
  local repo tick
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  printf '{invalid json\n' > "$repo/features/$slug/.coding-blocked-completion.json"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" 'CURRENT_PHASE="coding"')"

  check_eq "malformed blocked completion: phase remains coding" "coding" "$(kv_value "$tick" phase)"
  check_eq "malformed blocked completion: stage stays running" "running" "$(harness_read_stage_status "$repo" "$slug" coding)"
  check_eq "malformed blocked completion: attention set" "needs-user" "$(kv_value "$tick" attention)"
  check_contains "malformed blocked completion: generic log emitted" "$(kv_value "$tick" log_output)" "needs attention: coding done; verification blocked"
}

test_coding_blocked_completion_missing_required_field_does_not_auto_advance() {
  local slug="coding-blocked-missing-field"
  local issue="HOK-1642-MISSINGFIELD"
  local repo tick commit
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  commit="$(git -C "$repo" rev-parse --short HEAD)"
  cat > "$repo/features/$slug/.coding-blocked-completion.json" <<EOF
{
  "stage": "coding",
  "committed": true,
  "commit": "$commit",
  "passingChecks": ["bash tests/wavemill-mill-advance.test.sh"],
  "blockingChecks": ["pnpm typecheck"],
  "blockingReason": "baseline_tests_failing",
  "evidence": "Repo-level typecheck is failing outside this change.",
  "recommendedAction": "advance_to_review"
}
EOF

  tick="$(harness_run_tick "$repo" "$slug" "$issue" 'CURRENT_PHASE="coding"')"

  check_eq "missing field: stage stays running" "running" "$(harness_read_stage_status "$repo" "$slug" coding)"
  check_eq "missing field: needs-user attention set" "needs-user" "$(kv_value "$tick" attention)"
  check_file_absent "missing field: no auto audit written" "$repo/features/$slug/.coding-auto-advance.json"
}

test_coding_blocked_completion_empty_passing_checks_does_not_auto_advance() {
  local slug="coding-blocked-empty-passing"
  local issue="HOK-1642-EMPTYPASS"
  local repo tick commit
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  commit="$(git -C "$repo" rev-parse --short HEAD)"
  cat > "$repo/features/$slug/.coding-blocked-completion.json" <<EOF
{
  "stage": "coding",
  "implementationComplete": true,
  "committed": true,
  "commit": "$commit",
  "passingChecks": [],
  "blockingChecks": ["pnpm typecheck"],
  "blockingReason": "baseline_tests_failing",
  "evidence": "Repo-level typecheck is failing outside this change.",
  "recommendedAction": "advance_to_review"
}
EOF

  tick="$(harness_run_tick "$repo" "$slug" "$issue" 'CURRENT_PHASE="coding"')"

  check_eq "empty passing checks: stage stays running" "running" "$(harness_read_stage_status "$repo" "$slug" coding)"
  check_eq "empty passing checks: needs-user attention set" "needs-user" "$(kv_value "$tick" attention)"
  check_file_absent "empty passing checks: no auto audit written" "$repo/features/$slug/.coding-auto-advance.json"
}

test_coding_blocked_completion_stale_commit_does_not_auto_advance() {
  local slug="coding-blocked-stale-commit"
  local issue="HOK-1642-STALE"
  local repo tick
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  cat > "$repo/features/$slug/.coding-blocked-completion.json" <<'EOF'
{
  "stage": "coding",
  "implementationComplete": true,
  "committed": true,
  "commit": "deadbee",
  "passingChecks": ["bash tests/wavemill-mill-advance.test.sh"],
  "blockingChecks": ["pnpm typecheck"],
  "blockingReason": "baseline_tests_failing",
  "evidence": "Repo-level typecheck is failing outside this change.",
  "recommendedAction": "advance_to_review"
}
EOF

  tick="$(harness_run_tick "$repo" "$slug" "$issue" 'CURRENT_PHASE="coding"')"

  check_eq "stale commit: stage stays running" "running" "$(harness_read_stage_status "$repo" "$slug" coding)"
  check_eq "stale commit: needs-user attention set" "needs-user" "$(kv_value "$tick" attention)"
  check_file_absent "stale commit: no auto audit written" "$repo/features/$slug/.coding-auto-advance.json"
}

test_coding_blocked_completion_dirty_worktree_does_not_auto_advance() {
  local slug="coding-blocked-dirty-worktree"
  local issue="HOK-1642-DIRTY"
  local repo tick commit
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  printf 'dirty\n' >> "$repo/README.md"
  commit="$(git -C "$repo" rev-parse --short HEAD)"
  cat > "$repo/features/$slug/.coding-blocked-completion.json" <<EOF
{
  "stage": "coding",
  "implementationComplete": true,
  "committed": true,
  "commit": "$commit",
  "passingChecks": ["bash tests/wavemill-mill-advance.test.sh"],
  "blockingChecks": ["pnpm typecheck"],
  "blockingReason": "baseline_tests_failing",
  "evidence": "Repo-level typecheck is failing outside this change.",
  "recommendedAction": "advance_to_review"
}
EOF

  tick="$(harness_run_tick "$repo" "$slug" "$issue" 'CURRENT_PHASE="coding"')"

  check_eq "dirty worktree: stage stays running" "running" "$(harness_read_stage_status "$repo" "$slug" coding)"
  check_eq "dirty worktree: needs-user attention set" "needs-user" "$(kv_value "$tick" attention)"
  check_file_absent "dirty worktree: no auto audit written" "$repo/features/$slug/.coding-auto-advance.json"
}

test_coding_blocked_completion_unknown_feature_file_does_not_auto_advance() {
  local slug="coding-blocked-unknown-feature-file"
  local issue="HOK-1758-UNKNOWN"
  local repo tick commit feature_dir
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  feature_dir="$repo/features/$slug"
  printf 'console.log("noise");\n' > "$feature_dir/extra.ts"
  commit="$(git -C "$repo" rev-parse --short HEAD)"
  cat > "$feature_dir/.coding-blocked-completion.json" <<EOF
{
  "stage": "coding",
  "implementationComplete": true,
  "committed": true,
  "commit": "$commit",
  "passingChecks": ["bash tests/wavemill-mill-advance.test.sh"],
  "blockingChecks": ["pnpm typecheck"],
  "blockingReason": "baseline_tests_failing",
  "evidence": "Repo-level typecheck is failing outside this change.",
  "recommendedAction": "advance_to_review"
}
EOF

  tick="$(harness_run_tick "$repo" "$slug" "$issue" 'CURRENT_PHASE="coding"')"

  check_eq "unknown feature file: stage stays running" "running" "$(harness_read_stage_status "$repo" "$slug" coding)"
  check_eq "unknown feature file: needs-user attention set" "needs-user" "$(kv_value "$tick" attention)"
  check_file_absent "unknown feature file: no auto audit written" "$feature_dir/.coding-auto-advance.json"
  check_file_absent "unknown feature file: no coding complete marker" "$feature_dir/.coding-complete"
}

test_coding_blocked_completion_dedupes_when_stat_unavailable() {
  local slug="coding-blocked-completion-no-stat"
  local issue="HOK-1642-NOSTAT"
  local repo tick1 tick2
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  cat > "$repo/features/$slug/.coding-blocked-completion.json" <<'EOF'
{
  "summary": "coding done; Docker unavailable"
}
EOF

  # Simulate stat unavailable by overriding portable_file_mtime_epoch to return empty
  local stub='CURRENT_PHASE="coding"; portable_file_mtime_epoch() { return 1; }'
  tick1="$(harness_run_tick "$repo" "$slug" "$issue" "$stub")"
  tick2="$(harness_run_tick "$repo" "$slug" "$issue" "$stub")"

  check_contains "no-stat dedupe: first poll logs attention" "$(kv_value "$tick1" log_output)" "needs attention: coding done; Docker unavailable"
  check_eq "no-stat dedupe: second poll stays active" "1" "$(kv_value "$tick2" active_count)"
  check_eq "no-stat dedupe: second poll keeps needs-user" "needs-user" "$(kv_value "$tick2" attention)"
  check_not_contains "no-stat dedupe: second poll emits no duplicate log" "$(kv_value "$tick2" log_output)" "needs attention:"
}

test_coding_terminal_blocked_report_no_marker_needs_user() {
  local slug="coding-terminal-blocked-no-marker"
  local issue="HOK-2484-POS"
  local repo tick feature_dir commit
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  feature_dir="$repo/features/$slug"

  printf 'feat: carry rewards context\n' > "$repo/integrate.ts"
  git -C "$repo" add integrate.ts
  git -C "$repo" commit -q -m "feat: carry rewards context into integrate flow"
  commit="$(git -C "$repo" rev-parse --short HEAD)"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" "
    CURRENT_PHASE=\"coding\"
    tmux() {
      if [[ \"\${1:-}\" == \"capture-pane\" ]]; then
        printf '%s\\n' \\
          'Implementation committed as $commit.' \\
          'pnpm verify failed: missing ts-node, next, and prisma.' \\
          'Verification is blocked because node_modules is absent.' \\
          'Because of that, I did not create .coding-complete.'
        return 0
      fi
      return 1
    }
  ")"

  check_eq "terminal blocked no marker: phase remains coding" "coding" "$(kv_value "$tick" phase)"
  check_eq "terminal blocked no marker: coding stage stays running" "running" "$(harness_read_stage_status "$repo" "$slug" coding)"
  check_eq "terminal blocked no marker: needs-user attention set" "needs-user" "$(kv_value "$tick" attention)"
  check_eq "terminal blocked no marker: task remains active" "1" "$(kv_value "$tick" active_count)"
  check_contains "terminal blocked no marker: log names missing artifact path" "$(kv_value "$tick" log_output)" "features/$slug/.coding-blocked-completion.json"
  check_contains "terminal blocked no marker: log suggests advance command" "$(kv_value "$tick" log_output)" "advance $issue"
  check_file_exists "terminal blocked no marker: audit artifact written" "$feature_dir/.coding-missing-blocked-completion.json"
  check_file_exists "terminal blocked no marker: dedupe marker written" "$feature_dir/.missing-blocked-completion-announced"
  check_file_absent "terminal blocked no marker: no blocked completion synthesized" "$feature_dir/.coding-blocked-completion.json"
}

test_coding_terminal_blocked_report_ignores_no_commit_evidence() {
  local slug="coding-terminal-blocked-no-commit"
  local issue="HOK-2484-NEG-COMMIT"
  local repo tick feature_dir
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  feature_dir="$repo/features/$slug"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" '
    CURRENT_PHASE="coding"
    tmux() {
      if [[ "${1:-}" == "capture-pane" ]]; then
        printf "%s\n" \
          "Verification is blocked because node_modules is missing." \
          "Because of that, I did not create .coding-complete."
        return 0
      fi
      return 1
    }
  ')"

  check_eq "no commit evidence: attention remains clear" "clear" "$(kv_value "$tick" attention)"
  check_file_absent "no commit evidence: no audit artifact" "$feature_dir/.coding-missing-blocked-completion.json"
  check_file_absent "no commit evidence: no dedupe marker" "$feature_dir/.missing-blocked-completion-announced"
}

test_coding_terminal_blocked_report_ignores_busy_pane() {
  local slug="coding-terminal-blocked-busy-pane"
  local issue="HOK-2484-NEG-BUSY"
  local repo tick feature_dir commit
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  feature_dir="$repo/features/$slug"
  commit="$(git -C "$repo" rev-parse --short HEAD)"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" "
    CURRENT_PHASE=\"coding\"
    _pane_is_dead_or_idle() { return 1; }
    tmux() {
      if [[ \"\${1:-}\" == \"capture-pane\" ]]; then
        printf '%s\\n' \\
          'Implementation committed as $commit.' \\
          'Verification is blocked.' \\
          'Because of that, I did not create .coding-complete.'
        return 0
      fi
      return 1
    }
  ")"

  check_eq "busy pane: attention remains clear" "clear" "$(kv_value "$tick" attention)"
  check_file_absent "busy pane: no audit artifact" "$feature_dir/.coding-missing-blocked-completion.json"
}

test_coding_capacity_hook_writes_blocked_completion() {
  local slug="coding-capacity-hook"
  local issue="HOK-2318-HOOK"
  local repo tick feature_dir hook_file
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  feature_dir="$repo/features/$slug"
  hook_file="/tmp/wavemill-lifecycle-harness-${issue}.hook"
  cat > "$hook_file" <<EOF
{"state":"error","event":"model_capacity","detail":"model_at_capacity: Selected model is at capacity. Please try a different model.","agent":"codex","timestamp":$(date +%s)}
EOF

  tick="$(harness_run_tick "$repo" "$slug" "$issue" 'CURRENT_PHASE="coding"; WAVEMILL_CAPACITY_STALL_SECONDS=0')"

  check_file_exists "capacity hook: blocked completion written" "$feature_dir/.coding-blocked-completion.json"
  check_file_exists "capacity hook: recovery audit written" "$feature_dir/.coding-capacity-recovery.json"
  check_eq "capacity hook: needs-user attention set" "needs-user" "$(kv_value "$tick" attention)"
  check_eq "capacity hook: task remains active" "1" "$(kv_value "$tick" active_count)"
  check_eq "capacity hook: stage remains running" "running" "$(harness_read_stage_status "$repo" "$slug" coding)"
  check_contains "capacity hook: attention log emitted" "$(kv_value "$tick" log_output)" "coding blocked: Codex model at capacity"
}

test_coding_capacity_prompt_writes_blocked_completion() {
  local slug="coding-capacity-pane"
  local issue="HOK-2318-PANE"
  local repo tick feature_dir
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  feature_dir="$repo/features/$slug"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" '
    CURRENT_PHASE="coding"
    WAVEMILL_CAPACITY_STALL_SECONDS=0
    _tmux_task_window_target() { printf "%s\n" "@7"; }
    tmux() {
      if [[ "${1:-}" == "capture-pane" ]]; then
        printf "%s\n\n%s\n" "Selected model is at capacity. Please try a different model." ">"
        return 0
      fi
      return 1
    }
  ')"

  check_file_exists "capacity pane: blocked completion written" "$feature_dir/.coding-blocked-completion.json"
  check_file_exists "capacity pane: recovery audit written" "$feature_dir/.coding-capacity-recovery.json"
  check_eq "capacity pane: needs-user attention set" "needs-user" "$(kv_value "$tick" attention)"
  check_eq "capacity pane: artifact blocking reason set" "model_at_capacity" "$(jq -r '.blockingReason' "$feature_dir/.coding-blocked-completion.json")"
  check_eq "capacity pane: artifact recommended action set" "relaunch_coding" "$(jq -r '.recommendedAction' "$feature_dir/.coding-blocked-completion.json")"
}

test_coding_complete_wins_over_capacity_prompt() {
  local slug="coding-complete-over-capacity"
  local issue="HOK-2318-COMPLETE"
  local repo tick feature_dir
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  feature_dir="$repo/features/$slug"
  printf '{"stage":"coding","confidence":"high"}\n' > "$feature_dir/.coding-complete"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" '
    CURRENT_PHASE="coding"
    WAVEMILL_CAPACITY_STALL_SECONDS=0
    _tmux_task_window_target() { printf "%s\n" "@7"; }
    tmux() {
      if [[ "${1:-}" == "capture-pane" ]]; then
        printf "%s\n%s\n" "Selected model is at capacity. Please try a different model." ">"
        return 0
      fi
      return 1
    }
  ')"

  check_eq "complete over capacity: stage becomes completed" "completed" "$(harness_read_stage_status "$repo" "$slug" coding)"
  check_file_absent "complete over capacity: no capacity artifact" "$feature_dir/.coding-blocked-completion.json"
  check_eq "complete over capacity: no needs-user attention" "" "$(kv_value "$tick" attention)"
}

test_coding_capacity_prompt_ignores_active_output() {
  local slug="coding-capacity-active-output"
  local issue="HOK-2318-ACTIVE"
  local repo tick feature_dir
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  feature_dir="$repo/features/$slug"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" '
    CURRENT_PHASE="coding"
    WAVEMILL_CAPACITY_STALL_SECONDS=0
    _tmux_task_window_target() { printf "%s\n" "@7"; }
    tmux() {
      if [[ "${1:-}" == "capture-pane" ]]; then
        printf "%s\n%s\n" "Selected model is at capacity. Please try a different model." "Retrying request with backoff..."
        return 0
      fi
      return 1
    }
  ')"

  check_file_absent "capacity active output: no blocked completion written" "$feature_dir/.coding-blocked-completion.json"
  check_eq "capacity active output: attention remains clear" "clear" "$(kv_value "$tick" attention)"
}

test_coding_capacity_recovery_is_idempotent() {
  local slug="coding-capacity-idempotent"
  local issue="HOK-2318-IDEMP"
  local repo tick1 tick2 feature_dir
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  feature_dir="$repo/features/$slug"

  tick1="$(harness_run_tick "$repo" "$slug" "$issue" '
    CURRENT_PHASE="coding"
    WAVEMILL_CAPACITY_STALL_SECONDS=0
    _tmux_task_window_target() { printf "%s\n" "@7"; }
    tmux() {
      if [[ "${1:-}" == "capture-pane" ]]; then
        printf "%s\n%s\n" "Selected model is at capacity. Please try a different model." ">"
        return 0
      fi
      return 1
    }
  ')"
  tick2="$(harness_run_tick "$repo" "$slug" "$issue" '
    CURRENT_PHASE="coding"
    WAVEMILL_CAPACITY_STALL_SECONDS=0
    _tmux_task_window_target() { printf "%s\n" "@7"; }
    tmux() {
      if [[ "${1:-}" == "capture-pane" ]]; then
        printf "%s\n%s\n" "Selected model is at capacity. Please try a different model." ">"
        return 0
      fi
      return 1
    }
  ')"

  check_eq "capacity idempotent: first tick sets needs-user" "needs-user" "$(kv_value "$tick1" attention)"
  check_eq "capacity idempotent: second tick keeps needs-user attention" "needs-user" "$(kv_value "$tick2" attention)"
  check_not_contains "capacity idempotent: second tick does not duplicate log" "$(kv_value "$tick2" log_output)" "needs attention: coding blocked: Codex model at capacity"
  check_file_exists "capacity idempotent: recovery audit still present" "$feature_dir/.coding-capacity-recovery.json"
}

test_coding_capacity_hook_ignores_stale_signal() {
  local slug="coding-capacity-stale-hook"
  local issue="HOK-2318-STALE-HOOK"
  local repo tick feature_dir stale_ts
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  feature_dir="$repo/features/$slug"
  stale_ts=$(( $(date +%s) - 400 ))
  cat > "/tmp/wavemill-lifecycle-harness-${issue}.hook" <<EOF
{"state":"error","event":"model_capacity","detail":"model_at_capacity: Selected model is at capacity. Please try a different model.","agent":"codex","timestamp":$stale_ts}
EOF

  tick="$(harness_run_tick "$repo" "$slug" "$issue" 'CURRENT_PHASE="coding"; WAVEMILL_CAPACITY_STALL_SECONDS=0')"

  check_file_absent "capacity stale hook: no blocked completion written" "$feature_dir/.coding-blocked-completion.json"
  check_eq "capacity stale hook: attention remains clear" "clear" "$(kv_value "$tick" attention)"
}

test_misplaced_coding_complete_marker_is_recovered() {
  local slug="misplaced-coding-complete"
  local issue="HOK-1642-MISPLACED"
  local repo feature_dir misplaced_dir tick
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  feature_dir="$repo/features/$slug"
  misplaced_dir="$repo/services/contract-deployer/features/$slug"
  mkdir -p "$misplaced_dir"
  printf '{"stage":"coding","confidence":"high"}\n' > "$misplaced_dir/.coding-complete"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" 'CURRENT_PHASE="coding"')"

  check_eq "misplaced marker: coding stage becomes completed" "completed" "$(harness_read_stage_status "$repo" "$slug" coding)"
  check_file_exists "misplaced marker: expected marker recovered" "$feature_dir/.coding-complete"
  check_file_exists "misplaced marker: recovery audit written" "$feature_dir/.coding-marker-recovered.json"
  check_eq "misplaced marker: audit found path" "services/contract-deployer/features/$slug/.coding-complete" "$(jq -r '.found' "$feature_dir/.coding-marker-recovered.json")"
  check_contains "misplaced marker: warning logged" "$(kv_value "$tick" warn_output)" "Recovered misplaced .coding-complete"
}

test_root_level_coding_complete_marker_is_recovered() {
  local slug="root-level-coding-complete"
  local issue="HOK-2264-ROOT"
  local repo feature_dir tick
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  feature_dir="$repo/features/$slug"
  printf '{"stage":"coding","confidence":"high"}\n' > "$repo/.coding-complete"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" 'CURRENT_PHASE="coding"')"

  check_eq "root marker: coding stage becomes completed" "completed" "$(harness_read_stage_status "$repo" "$slug" coding)"
  check_file_exists "root marker: expected marker recovered" "$feature_dir/.coding-complete"
  check_file_exists "root marker: recovery audit written" "$feature_dir/.coding-marker-recovered.json"
  check_eq "root marker: audit found path" ".coding-complete" "$(jq -r '.found' "$feature_dir/.coding-marker-recovered.json")"
  check_contains "root marker: warning logged" "$(kv_value "$tick" warn_output)" "Recovered misplaced .coding-complete from .coding-complete"
}

test_tracked_root_level_coding_complete_marker_is_ignored() {
  local slug="tracked-root-level-coding-complete"
  local issue="HOK-2264-TRACKED-ROOT"
  local repo feature_dir tick
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  feature_dir="$repo/features/$slug"
  printf '{"stage":"coding","confidence":"high"}\n' > "$repo/.coding-complete"
  git -C "$repo" add .coding-complete
  git -C "$repo" commit -q -m "Track accidental root coding marker"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" 'CURRENT_PHASE="coding"')"

  check_eq "tracked root marker: coding stage remains running" "running" "$(harness_read_stage_status "$repo" "$slug" coding)"
  check_file_absent "tracked root marker: expected marker not recovered" "$feature_dir/.coding-complete"
  check_file_absent "tracked root marker: recovery audit not written" "$feature_dir/.coding-marker-recovered.json"
  check_not_contains "tracked root marker: no recovery warning logged" "$(kv_value "$tick" warn_output)" "Recovered misplaced .coding-complete"
}

test_root_level_plan_md_is_recovered_before_approval_guard() {
  local slug="root-level-plan-recovered"
  local issue="HOK-2761-ROOT-PLAN"
  local repo feature_dir tick
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_planning_state "$repo" "$slug" "running"
  feature_dir="$repo/features/$slug"
  git -C "$repo" rm -q "features/$slug/plan.md" "features/$slug/.plan-approved"
  git -C "$repo" commit -q -m "Remove generated planning artifacts"
  printf '# Plan\n\nRecovered from root.\n' > "$repo/plan.md"
  touch "$feature_dir/.plan-approved"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" 'CURRENT_PHASE="planning"')"

  check_eq "root plan: planning becomes awaiting_user" "awaiting_user" "$(harness_read_stage_status "$repo" "$slug" planning)"
  check_file_exists "root plan: expected plan recovered" "$feature_dir/plan.md"
  check_file_absent "root plan: root plan moved away" "$repo/plan.md"
  check_file_exists "root plan: approval marker preserved" "$feature_dir/.plan-approved"
  check_file_exists "root plan: recovery audit written" "$feature_dir/.plan-recovered.json"
  check_eq "root plan: audit found path" "plan.md" "$(jq -r '.found' "$feature_dir/.plan-recovered.json")"
  check_eq "root plan: task needs user" "needs-user" "$(kv_value "$tick" attention)"
}

test_tracked_root_level_plan_md_is_ignored() {
  local slug="tracked-root-level-plan"
  local issue="HOK-2761-TRACKED-ROOT-PLAN"
  local repo feature_dir tick
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_planning_state "$repo" "$slug" "running"
  feature_dir="$repo/features/$slug"
  git -C "$repo" rm -q "features/$slug/plan.md" "features/$slug/.plan-approved"
  printf '# Repo Plan\n\nTracked root plan.\n' > "$repo/plan.md"
  git -C "$repo" add plan.md
  git -C "$repo" commit -q -m "Track root plan"
  touch "$feature_dir/.plan-approved"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" 'CURRENT_PHASE="planning"')"

  check_eq "tracked root plan: planning remains running" "running" "$(harness_read_stage_status "$repo" "$slug" planning)"
  check_file_absent "tracked root plan: expected plan not recovered" "$feature_dir/plan.md"
  check_file_absent "tracked root plan: recovery audit not written" "$feature_dir/.plan-recovered.json"
  check_file_exists "tracked root plan: premature marker quarantined" "$feature_dir/.plan-approved.premature"
  check_eq "tracked root plan: task needs user" "needs-user" "$(kv_value "$tick" attention)"
}

test_premature_plan_approval_is_quarantined_not_deleted() {
  local slug="premature-plan-approval"
  local issue="HOK-2761-PREMATURE"
  local repo feature_dir tick
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_planning_state "$repo" "$slug" "running"
  feature_dir="$repo/features/$slug"
  git -C "$repo" rm -q "features/$slug/plan.md" "features/$slug/.plan-approved"
  git -C "$repo" commit -q -m "Remove generated plan"
  touch "$feature_dir/.plan-approved"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" 'CURRENT_PHASE="planning"')"

  check_eq "premature plan approval: planning remains running" "running" "$(harness_read_stage_status "$repo" "$slug" planning)"
  check_file_absent "premature plan approval: marker no longer re-triggers" "$feature_dir/.plan-approved"
  check_file_exists "premature plan approval: marker quarantined" "$feature_dir/.plan-approved.premature"
  check_contains "premature plan approval: warning logged" "$(kv_value "$tick" warn_output)" ".plan-approved arrived before plan.md"
  check_eq "premature plan approval: task needs user" "needs-user" "$(kv_value "$tick" attention)"
}

test_not_eligible_expanded_reroute_does_not_emit_helper_failure_warn() {
  local slug="not-eligible-expanded-reroute"
  local issue="HOK-2274-NOT-ELIGIBLE"
  local repo tick
  repo="$(harness_init_repo "$slug")"
  harness_setup_planning_state "$repo" "$slug" "completed"
  harness_setup_runtime_artifacts "$repo"
  harness_seed_bootstrap_route "$repo" "$slug"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" '
    log_route_lifecycle() { LOG_OUTPUT+="route.lifecycle event=$1 $*\n"; }
    reroute_expanded_packets_for_coding_handoff() {
      REROUTE_CALLED="true"
      REROUTE_EXPANDED_LAST_REASON="not_eligible"
      return 1
    }
  ')"

  check_eq "not_eligible: coding launches" "true" "$(kv_value "$tick" coding_launched)"
  check_eq "not_eligible: reroute was called" "true" "$(kv_value "$tick" reroute_called)"
  check_eq "not_eligible: apply was called" "true" "$(kv_value "$tick" apply_called)"
  check_contains "not_eligible: expansion_skipped lifecycle event emitted" "$(kv_value "$tick" log_output)" "expansion_skipped"
  check_contains "not_eligible: reason logged" "$(kv_value "$tick" log_output)" "reason=not_eligible"
  check_not_contains "not_eligible: no helper-failed warning" "$(kv_value "$tick" warn_output)" "expanded reroute helper failed"
}

test_disabled_expanded_reroute_does_not_emit_helper_failure_warn() {
  local slug="disabled-expanded-reroute"
  local issue="HOK-2274-DISABLED"
  local repo tick
  repo="$(harness_init_repo "$slug")"
  harness_setup_planning_state "$repo" "$slug" "completed"
  harness_setup_runtime_artifacts "$repo"
  harness_seed_bootstrap_route "$repo" "$slug"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" '
    log_route_lifecycle() { LOG_OUTPUT+="route.lifecycle event=$1 $*\n"; }
    reroute_expanded_packets_for_coding_handoff() {
      REROUTE_CALLED="true"
      REROUTE_EXPANDED_LAST_REASON="disabled"
      return 1
    }
  ')"

  check_eq "disabled: coding launches" "true" "$(kv_value "$tick" coding_launched)"
  check_eq "disabled: reroute was called" "true" "$(kv_value "$tick" reroute_called)"
  check_eq "disabled: apply was called" "true" "$(kv_value "$tick" apply_called)"
  check_contains "disabled: expansion_skipped lifecycle event emitted" "$(kv_value "$tick" log_output)" "expansion_skipped"
  check_contains "disabled: reason logged" "$(kv_value "$tick" log_output)" "reason=disabled"
  check_not_contains "disabled: no helper-failed warning" "$(kv_value "$tick" warn_output)" "expanded reroute helper failed"
}

test_routing_error_expanded_reroute_emits_helper_failure_warn() {
  local slug="routing-error-expanded-reroute"
  local issue="HOK-2274-ROUTING-ERROR"
  local repo tick
  repo="$(harness_init_repo "$slug")"
  harness_setup_planning_state "$repo" "$slug" "completed"
  harness_setup_runtime_artifacts "$repo"
  harness_seed_bootstrap_route "$repo" "$slug"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" '
    log_route_lifecycle() { LOG_OUTPUT+="route.lifecycle event=$1 $*\n"; }
    reroute_expanded_packets_for_coding_handoff() {
      REROUTE_CALLED="true"
      REROUTE_EXPANDED_LAST_REASON="routing_error"
      return 1
    }
  ')"

  check_eq "routing_error: coding launches" "true" "$(kv_value "$tick" coding_launched)"
  check_eq "routing_error: reroute was called" "true" "$(kv_value "$tick" reroute_called)"
  check_eq "routing_error: apply was called" "true" "$(kv_value "$tick" apply_called)"
  check_contains "routing_error: expansion_failed lifecycle event emitted" "$(kv_value "$tick" log_output)" "expansion_failed"
  check_contains "routing_error: reason logged" "$(kv_value "$tick" log_output)" "reason=routing_error"
  check_contains "routing_error: helper-failed warning emitted" "$(kv_value "$tick" warn_output)" "expanded reroute helper failed"
}

test_review_stage_challenge_honors_phase_config_coder() {
  local slug="challenge-review-stage"
  local issue="HOK-2272-REV"
  local repo tick overrides
  repo="$(harness_init_repo "$slug")"
  harness_setup_planning_state "$repo" "$slug" "completed"
  harness_setup_runtime_artifacts "$repo"
  harness_seed_bootstrap_route "$repo" "$slug"

  cat > "$repo/features/$slug/.post-expansion-route.json" <<'EOF'
{
  "planner": "expanded-planner",
  "coder": "gpt-5.4",
  "reviewer": "claude-sonnet-5",
  "planDepth": "deep",
  "codeDepth": "deep",
  "reviewMode": "static+llm",
  "provenance": {
    "source": "expanded-test"
  }
}
EOF

  overrides="$(harness_common_route_overrides)
    is_challenge_task() { return 0; }
    get_task_meta() {
      local issue_key=\"\$1\" field=\"\$2\"
      case \"\$issue_key.\$field\" in
        HOK-2272-REV.challengeModel) printf '%s\\n' 'claude-sonnet-5' ;;
        HOK-2272-REV.challengeStage) printf '%s\\n' 'review' ;;
        *) printf '\\n' ;;
      esac
    }
  "
  tick="$(harness_run_tick "$repo" "$slug" "$issue" "$overrides")"

  check_eq "review challenge: coding launches" "true" "$(kv_value "$tick" coding_launched)"
  check_eq "review challenge: phase-config coder honored (not challengeModel)" "gpt-5.4" "$(kv_value "$tick" coding_model)"
  check_contains "review challenge: debug log records challenge stage" "$(kv_value "$tick" log_output)" "challenge stage=review"
  check_eq "review challenge: coding-result.json records phase-config model" "gpt-5.4" "$(jq -r '.model // ""' "$repo/features/$slug/.coding-result.json")"
}

test_plan_stage_challenge_honors_phase_config_coder() {
  local slug="challenge-plan-stage"
  local issue="HOK-2272-PLAN"
  local repo tick overrides
  repo="$(harness_init_repo "$slug")"
  harness_setup_planning_state "$repo" "$slug" "completed"
  harness_setup_runtime_artifacts "$repo"
  harness_seed_bootstrap_route "$repo" "$slug"

  cat > "$repo/features/$slug/.post-expansion-route.json" <<'EOF'
{
  "planner": "expanded-planner",
  "coder": "gpt-5.4",
  "reviewer": "claude-sonnet-5",
  "planDepth": "deep",
  "codeDepth": "deep",
  "reviewMode": "static+llm",
  "provenance": {
    "source": "expanded-test"
  }
}
EOF

  overrides="$(harness_common_route_overrides)
    is_challenge_task() { return 0; }
    get_task_meta() {
      local issue_key=\"\$1\" field=\"\$2\"
      case \"\$issue_key.\$field\" in
        HOK-2272-PLAN.challengeModel) printf '%s\\n' 'claude-sonnet-5' ;;
        HOK-2272-PLAN.challengeStage) printf '%s\\n' 'plan' ;;
        *) printf '\\n' ;;
      esac
    }
  "
  tick="$(harness_run_tick "$repo" "$slug" "$issue" "$overrides")"

  check_eq "plan challenge: coding launches" "true" "$(kv_value "$tick" coding_launched)"
  check_eq "plan challenge: phase-config coder honored (not challengeModel)" "gpt-5.4" "$(kv_value "$tick" coding_model)"
  check_contains "plan challenge: debug log records challenge stage" "$(kv_value "$tick" log_output)" "challenge stage=plan"
  check_eq "plan challenge: coding-result.json records phase-config model" "gpt-5.4" "$(jq -r '.model // ""' "$repo/features/$slug/.coding-result.json")"
}

test_implementation_stage_challenge_applies_override() {
  local slug="challenge-impl-stage"
  local issue="HOK-2272-IMPL"
  local repo tick overrides
  repo="$(harness_init_repo "$slug")"
  harness_setup_planning_state "$repo" "$slug" "completed"
  harness_setup_runtime_artifacts "$repo"
  harness_seed_bootstrap_route "$repo" "$slug"

  cat > "$repo/features/$slug/.post-expansion-route.json" <<'EOF'
{
  "planner": "expanded-planner",
  "coder": "gpt-5.4",
  "reviewer": "claude-sonnet-5",
  "planDepth": "deep",
  "codeDepth": "deep",
  "reviewMode": "static+llm",
  "provenance": {
    "source": "expanded-test"
  }
}
EOF

  # challengeRole=challenger skips the primary-only refresh block so the test
  # focuses solely on the override decision.
  overrides="$(harness_common_route_overrides)
    is_challenge_task() { return 0; }
    get_task_meta() {
      local issue_key=\"\$1\" field=\"\$2\"
      case \"\$issue_key.\$field\" in
        HOK-2272-IMPL.challengeModel) printf '%s\\n' 'claude-sonnet-5' ;;
        HOK-2272-IMPL.challengeStage) printf '%s\\n' 'implementation' ;;
        HOK-2272-IMPL.challengeRole) printf '%s\\n' 'challenger' ;;
        *) printf '\\n' ;;
      esac
    }
  "
  tick="$(harness_run_tick "$repo" "$slug" "$issue" "$overrides")"

  check_eq "impl challenge: coding launches" "true" "$(kv_value "$tick" coding_launched)"
  check_eq "impl challenge: challengeModel overrides phase-config coder" "claude-sonnet-5" "$(kv_value "$tick" coding_model)"
  check_eq "impl challenge: coding-result.json records challengeModel" "claude-sonnet-5" "$(jq -r '.model // ""' "$repo/features/$slug/.coding-result.json")"
}

test_missing_challenge_stage_fails_safe_to_phase_config() {
  local slug="challenge-missing-stage"
  local issue="HOK-2272-MISS"
  local repo tick overrides
  repo="$(harness_init_repo "$slug")"
  harness_setup_planning_state "$repo" "$slug" "completed"
  harness_setup_runtime_artifacts "$repo"
  harness_seed_bootstrap_route "$repo" "$slug"

  cat > "$repo/features/$slug/.post-expansion-route.json" <<'EOF'
{
  "planner": "expanded-planner",
  "coder": "gpt-5.4",
  "reviewer": "claude-sonnet-5",
  "planDepth": "deep",
  "codeDepth": "deep",
  "reviewMode": "static+llm",
  "provenance": {
    "source": "expanded-test"
  }
}
EOF

  # challengeStage intentionally absent; refresh block may fire but its npx
  # call fails gracefully, leaving challenge_coder unchanged.
  overrides="$(harness_common_route_overrides)
    is_challenge_task() { return 0; }
    TOOLS_DIR=\"/tmp/\${SESSION}-\${ISSUE}-tools\"
    mkdir -p \"\$TOOLS_DIR\"
    npx() { return 1; }
    get_task_meta() {
      local issue_key=\"\$1\" field=\"\$2\"
      case \"\$issue_key.\$field\" in
        HOK-2272-MISS.challengeModel) printf '%s\\n' 'claude-sonnet-5' ;;
        *) printf '\\n' ;;
      esac
    }
  "
  tick="$(harness_run_tick "$repo" "$slug" "$issue" "$overrides")"

  check_eq "missing stage: coding launches" "true" "$(kv_value "$tick" coding_launched)"
  check_eq "missing stage: phase-config coder honored (fail-safe)" "gpt-5.4" "$(kv_value "$tick" coding_model)"
  check_contains "missing stage: warn log records fail-safe message" "$(kv_value "$tick" warn_output)" "fail-safe to phase-config coder"
  check_contains "missing stage: warn log includes issue id" "$(kv_value "$tick" warn_output)" "HOK-2272-MISS"
}

test_completed_external_dead_pane_triggers_cleanup() {
  local slug="completed-external-dead-pane"
  local issue="HOK-2372-DEAD"
  local repo tick
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" '
    read_state_value() {
      if [[ "$*" == *".status"* ]]; then
        printf "%s\n" "completed-external"
      else
        printf "%s\n" "${1-}"
      fi
    }
    cleanup_completed_task() { LOG_OUTPUT+="cleanup:$*\n"; }
    tmux() {
      if [[ "${1:-}" == "list-panes" ]]; then
        printf "%s\n" "1"
        return 0
      fi
      return 1
    }
  ')"

  check_contains "dead pane: cleanup invoked on completed-external task" "$(kv_value "$tick" log_output)" "cleanup:HOK-2372-DEAD completed-external-dead-pane post-review cleanup"
  check_eq "dead pane: no active window count retained" "0" "$(kv_value "$tick" active_count)"
}

test_coding_pane_divergence_idle_pane_ignores_stale_unrelated_marker() {
  local slug="pane-divergence-misplaced-marker"
  local issue="HOK-2402-DIV-MARKER"
  local repo tick feature_dir other_feature_dir
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  feature_dir="$repo/features/$slug"

  # Simulate: a reused worktree contains a stale completion marker for an unrelated task.
  other_feature_dir="$repo/features/other-task-slug"
  mkdir -p "$other_feature_dir"
  printf '{"stage":"coding","confidence":"high"}\n' > "$other_feature_dir/.coding-complete"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" 'CURRENT_PHASE="coding"')"

  check_eq "div marker: phase remains coding" "coding" "$(kv_value "$tick" phase)"
  check_eq "div marker: coding stage stays running" "running" "$(harness_read_stage_status "$repo" "$slug" coding)"
  check_eq "div marker: attention stays clear" "clear" "$(kv_value "$tick" attention)"
  check_eq "div marker: task remains active" "1" "$(kv_value "$tick" active_count)"
  check_file_absent "div marker: no divergence audit written" "$feature_dir/.coding-pane-divergence.json"
  check_file_absent "div marker: no announce marker written" "$feature_dir/.coding-pane-divergence-detected"
  check_not_contains "div marker: no stale-marker warning" "$(kv_value "$tick" warn_output)" "other-task-slug"
}

test_coding_pane_divergence_idle_pane_different_slug_via_pane_tail_needs_user() {
  local slug="pane-divergence-tail"
  local issue="HOK-2402-DIV-TAIL"
  local repo tick feature_dir
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  feature_dir="$repo/features/$slug"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" '
    CURRENT_PHASE="coding"
    tmux() {
      if [[ "${1:-}" == "capture-pane" ]]; then
        printf "%s\n" "Created features/other-epic-slug/.coding-complete"
        return 0
      fi
      return 1
    }
  ')"

  check_eq "div tail: phase remains coding" "coding" "$(kv_value "$tick" phase)"
  check_eq "div tail: coding stage stays running" "running" "$(harness_read_stage_status "$repo" "$slug" coding)"
  check_eq "div tail: needs-user attention set" "needs-user" "$(kv_value "$tick" attention)"
  check_eq "div tail: task remains active" "1" "$(kv_value "$tick" active_count)"
  check_file_exists "div tail: divergence audit written" "$feature_dir/.coding-pane-divergence.json"
  check_eq "div tail: audit observedSlug from pane tail" "other-epic-slug" "$(jq -r '.observedSlug' "$feature_dir/.coding-pane-divergence.json")"
  check_eq "div tail: audit observedSource is pane_tail" "pane_tail" "$(jq -r '.observedSource' "$feature_dir/.coding-pane-divergence.json")"
  check_contains "div tail: warning log references observed slug" "$(kv_value "$tick" warn_output)" "other-epic-slug"
}

test_coding_pane_divergence_fresh_working_hook_keeps_waiting() {
  local slug="pane-divergence-fresh-hook"
  local issue="HOK-2402-DIV-HOOK"
  local repo tick feature_dir hook_file other_dir
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  feature_dir="$repo/features/$slug"
  hook_file="/tmp/wavemill-lifecycle-harness-${issue}.hook"

  # Write a fresh working hook that should suppress divergence detection
  cat > "$hook_file" <<EOF
{"state":"working","event":"PreToolUse","detail":"Read","agent":"claude","timestamp":$(date +%s)}
EOF

  # Simulate: different task marker exists (would trigger divergence without hook guard)
  other_dir="$repo/features/other-slug-task"
  mkdir -p "$other_dir"
  printf '{"stage":"coding","confidence":"high"}\n' > "$other_dir/.coding-complete"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" 'CURRENT_PHASE="coding"')"

  check_eq "hook guard: coding stage stays running" "running" "$(harness_read_stage_status "$repo" "$slug" coding)"
  check_eq "hook guard: attention remains clear" "clear" "$(kv_value "$tick" attention)"
  check_file_absent "hook guard: no divergence audit written" "$feature_dir/.coding-pane-divergence.json"
  check_eq "hook guard: task stays active" "1" "$(kv_value "$tick" active_count)"

  rm -f "$hook_file"
}

test_coding_pane_divergence_same_slug_marker_still_recovers() {
  # Regression: a misplaced marker for the correct slug must still be recovered
  # via the existing recovery path, not trigger divergence detection.
  local slug="pane-divergence-same-slug-recover"
  local issue="HOK-2402-DIV-SAME"
  local repo tick feature_dir misplaced_dir
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  feature_dir="$repo/features/$slug"
  misplaced_dir="$repo/services/some-service/features/$slug"
  mkdir -p "$misplaced_dir"
  printf '{"stage":"coding","confidence":"high"}\n' > "$misplaced_dir/.coding-complete"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" 'CURRENT_PHASE="coding"')"

  check_eq "same slug recover: coding stage becomes completed" "completed" "$(harness_read_stage_status "$repo" "$slug" coding)"
  check_file_exists "same slug recover: expected marker recovered" "$feature_dir/.coding-complete"
  check_file_absent "same slug recover: no divergence audit written" "$feature_dir/.coding-pane-divergence.json"
  check_not_contains "same slug recover: no divergence warning" "$(kv_value "$tick" warn_output)" "Coding pane completed a different task"
}

test_coding_pane_divergence_deduplicates_on_repeat_ticks() {
  local slug="pane-divergence-dedupe"
  local issue="HOK-2402-DIV-DEDUP"
  local repo tick1 tick2 feature_dir overrides
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_coding_state "$repo" "$slug" "running"
  feature_dir="$repo/features/$slug"
  overrides='
    CURRENT_PHASE="coding"
    tmux() {
      if [[ "${1:-}" == "capture-pane" ]]; then
        printf "%s\n" "Created features/another-task/.coding-complete"
        return 0
      fi
      return 1
    }
  '

  tick1="$(harness_run_tick "$repo" "$slug" "$issue" "$overrides")"
  tick2="$(harness_run_tick "$repo" "$slug" "$issue" "$overrides")"

  check_eq "div dedupe: tick 1 sets needs-user" "needs-user" "$(kv_value "$tick1" attention)"
  check_contains "div dedupe: tick 1 emits warning" "$(kv_value "$tick1" warn_output)" "another-task"
  check_eq "div dedupe: tick 2 stays needs-user" "needs-user" "$(kv_value "$tick2" attention)"
  check_not_contains "div dedupe: tick 2 does not repeat warning" "$(kv_value "$tick2" warn_output)" "another-task"
  check_eq "div dedupe: tick 2 task remains active" "1" "$(kv_value "$tick2" active_count)"
}

test_queue_owned_pane_release_blocks_on_dirty_worktree() {
  local slug="pane-release-blocked-dirty"
  local issue="HOK-2937-DIRTY"
  local repo tick
  repo="$(harness_init_repo "$slug")"
  harness_setup_pane_release_candidate "$repo" "$slug" "$issue"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" '
    CURRENT_PHASE="ready"
    PR_BY_ISSUE["$ISSUE"]="701"
    get_main_head_sha() { printf "%s\n" "base-current"; }
    merge_queue_enabled() { return 0; }
    ready_candidate_selected() { return 0; }
    ready_queue_state() { jq -r ".artifacts.queueState // empty" "$1/.ready-result.json"; }
    ready_base_sha() { jq -r ".artifacts.readyBaseSha // empty" "$1/.ready-result.json"; }
    ready_queue_field() { jq -r ".artifacts.${2} // empty" "$1/.ready-result.json"; }
    task_worktree_release_safety() { printf "%s\n" "dirty"; }
  ')"

  check_eq "pane release blocked dirty: remains task owned" "task" "$(jq -r --arg issue "$issue" '.tasks[$issue].executionOwner' "$repo/.wavemill/state.json")"
  check_eq "pane release blocked dirty: pane remains active" "active" "$(jq -r --arg issue "$issue" '.tasks[$issue].paneState' "$repo/.wavemill/state.json")"
  check_file_exists "pane release blocked dirty: blocked marker created" "$repo/features/$slug/ready/.pane-release-blocked.json"
  check_eq "pane release blocked dirty: task remains active" "1" "$(kv_value "$tick" active_count)"
}

test_queue_owned_pane_release_blocks_on_missing_capsule() {
  local slug="pane-release-blocked-capsule"
  local issue="HOK-2937-CAPSULE"
  local repo tick
  repo="$(harness_init_repo "$slug")"
  harness_setup_pane_release_candidate "$repo" "$slug" "$issue"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" '
    CURRENT_PHASE="ready"
    PR_BY_ISSUE["$ISSUE"]="701"
    get_main_head_sha() { printf "%s\n" "base-current"; }
    merge_queue_enabled() { return 0; }
    ready_candidate_selected() { return 0; }
    ready_queue_state() { jq -r ".artifacts.queueState // empty" "$1/.ready-result.json"; }
    ready_base_sha() { jq -r ".artifacts.readyBaseSha // empty" "$1/.ready-result.json"; }
    ready_queue_field() { jq -r ".artifacts.${2} // empty" "$1/.ready-result.json"; }
    task_worktree_release_safety() { printf "%s\n" "ok"; }
    npx() {
      if [[ "$*" == *"reconciliation-capsule.ts validate"* ]]; then
        printf "%s\n" "{\"ok\":false,\"reason\":\"missing\"}"
        return 1
      fi
      return 1
    }
  ')"

  check_eq "pane release blocked capsule: remains task owned" "task" "$(jq -r --arg issue "$issue" '.tasks[$issue].executionOwner' "$repo/.wavemill/state.json")"
  check_eq "pane release blocked capsule: pane remains active" "active" "$(jq -r --arg issue "$issue" '.tasks[$issue].paneState' "$repo/.wavemill/state.json")"
  check_file_exists "pane release blocked capsule: blocked marker created" "$repo/features/$slug/ready/.pane-release-blocked.json"
}

test_queue_owned_pane_release_blocks_on_stale_review() {
  local slug="pane-release-blocked-stale-review"
  local issue="HOK-2937-STALE-REV"
  local repo tick
  repo="$(harness_init_repo "$slug")"
  harness_setup_pane_release_candidate "$repo" "$slug" "$issue"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" '
    CURRENT_PHASE="ready"
    PR_BY_ISSUE["$ISSUE"]="701"
    get_main_head_sha() { printf "%s\n" "base-current"; }
    merge_queue_enabled() { return 0; }
    ready_candidate_selected() { return 0; }
    ready_queue_state() { jq -r ".artifacts.queueState // empty" "$1/.ready-result.json"; }
    ready_base_sha() { jq -r ".artifacts.readyBaseSha // empty" "$1/.ready-result.json"; }
    ready_queue_field() { jq -r ".artifacts.${2} // empty" "$1/.ready-result.json"; }
    task_worktree_release_safety() { printf "%s\n" "ok"; }
    review_result_passes_ready_gate() { return 1; }
    npx() {
      if [[ "$*" == *"reconciliation-capsule.ts validate"* ]]; then
        printf "%s\n" "{\"ok\":true}"
        return 0
      fi
      return 1
    }
  ')"

  check_eq "pane release blocked stale review: remains task owned" "task" "$(jq -r --arg issue "$issue" '.tasks[$issue].executionOwner' "$repo/.wavemill/state.json")"
  check_eq "pane release blocked stale review: pane remains active" "active" "$(jq -r --arg issue "$issue" '.tasks[$issue].paneState' "$repo/.wavemill/state.json")"
  check_file_exists "pane release blocked stale review: blocked marker created" "$repo/features/$slug/ready/.pane-release-blocked.json"
}

test_reconciliation_returns_to_queue_ownership_after_success() {
  local slug="pane-release-recon-success"
  local issue="HOK-2937-RECON-OK"
  local repo tick
  repo="$(harness_init_repo "$slug")"
  harness_setup_pane_release_candidate "$repo" "$slug" "$issue" "reconciliation" "rehydrating"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" '
    CURRENT_PHASE="ready"
    PR_BY_ISSUE["$ISSUE"]="701"
    get_main_head_sha() { printf "%s\n" "base-current"; }
    merge_queue_enabled() { return 0; }
    ready_candidate_selected() { return 0; }
    ready_queue_state() { jq -r ".artifacts.queueState // empty" "$1/.ready-result.json"; }
    ready_base_sha() { jq -r ".artifacts.readyBaseSha // empty" "$1/.ready-result.json"; }
    ready_queue_field() { jq -r ".artifacts.${2} // empty" "$1/.ready-result.json"; }
    task_worktree_release_safety() { printf "%s\n" "ok"; }
    npx() {
      if [[ "$*" == *"reconciliation-capsule.ts validate"* ]]; then
        printf "%s\n" "{\"ok\":true}"
        return 0
      fi
      return 1
    }
    _tmux_task_window_target() { printf "%s\n" "@8"; }
    tmux() {
      printf "%s\n" "$*" >> "$REPO_UNDER_TEST/tmux.log"
      if [[ "${1:-}" == "list-panes" ]]; then
        printf "%s\n" "999999"
        return 0
      fi
      return 1
    }
    review_result_passes_ready_gate() { return 0; }
  ')"

  check_eq "recon success: returns to queue ownership" "queue" "$(jq -r --arg issue "$issue" '.tasks[$issue].executionOwner' "$repo/.wavemill/state.json")"
  check_eq "recon success: pane released again" "released" "$(jq -r --arg issue "$issue" '.tasks[$issue].paneState' "$repo/.wavemill/state.json")"
}

test_restart_does_not_recreate_queue_owned_panes() {
  local slug="pane-release-restart"
  local issue="HOK-2937-RESTART"
  local repo tick
  repo="$(harness_init_repo "$slug")"
  harness_setup_pane_release_candidate "$repo" "$slug" "$issue" "queue" "released"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" '
    CURRENT_PHASE="ready"
    PR_BY_ISSUE["$ISSUE"]="701"
    get_main_head_sha() { printf "%s\n" "base-current"; }
    merge_queue_enabled() { return 0; }
    ready_candidate_selected() { return 0; }
    ready_queue_state() { jq -r ".artifacts.queueState // empty" "$1/.ready-result.json"; }
    ready_base_sha() { jq -r ".artifacts.readyBaseSha // empty" "$1/.ready-result.json"; }
    ready_queue_field() { jq -r ".artifacts.${2} // empty" "$1/.ready-result.json"; }
    _ensure_window_exists() {
      echo "ERROR: _ensure_window_exists should not be called for released panes" > /dev/stderr
      return 1
    }
  ')"

  check_eq "restart no pane: task remains queue-owned" "queue" "$(jq -r --arg issue "$issue" '.tasks[$issue].executionOwner' "$repo/.wavemill/state.json")"
  check_eq "restart no pane: queue-owned count" "1" "$(kv_value "$tick" queue_owned_count)"
  check_eq "restart no pane: no active slots" "0" "$(kv_value "$tick" active_count)"
}

test_terminal_cleanup_queue_owned_merged_pr_idempotent() {
  local slug="pane-release-merged-cleanup"
  local issue="HOK-2937-CLEANUP-M"
  local repo tick1 tick2
  repo="$(harness_init_repo "$slug")"
  harness_setup_pane_release_candidate "$repo" "$slug" "$issue" "queue" "released"

  # First cleanup tick - mark as merged
  tick1="$(harness_run_tick "$repo" "$slug" "$issue" '
    CURRENT_PHASE="ready"
    read_state_value() {
      if [[ "$*" == *".status"* ]]; then
        printf "%s\n" "merged"
      else
        printf "%s\n" "${1-}"
      fi
    }
    cleanup_completed_task() { remove_task_state "$1"; }
  ')"

  # Verify cleanup happened once
  local cleanup_count="$(jq -r '.tasks | length' "$repo/.wavemill/state.json" 2>/dev/null || echo 0)"
  check_eq "terminal cleanup merged: task removed on first cleanup" "0" "$cleanup_count"

  # Second cleanup tick - should be idempotent
  tick2="$(harness_run_tick "$repo" "$slug" "$issue" '
    CURRENT_PHASE="ready"
  ')"

  check_eq "terminal cleanup merged: remains cleaned up" "0" "$(jq -r '.tasks | length' "$repo/.wavemill/state.json" 2>/dev/null || echo 0)"
}

test_terminal_cleanup_queue_owned_closed_unmerged_preserves_unsafe_work() {
  local slug="pane-release-closed-cleanup"
  local issue="HOK-2937-CLEANUP-C"
  local repo tick
  repo="$(harness_init_repo "$slug")"
  harness_setup_pane_release_candidate "$repo" "$slug" "$issue" "queue" "released"

  # Simulate unpushed commit to trigger "unsafe" preservation
  git -C "$repo" commit --allow-empty -m "Unpushed work" 2>/dev/null || true

  tick="$(harness_run_tick "$repo" "$slug" "$issue" '
    CURRENT_PHASE="ready"
    read_state_value() {
      if [[ "$*" == *".status"* ]]; then
        printf "%s\n" "closed-unmerged"
      else
        printf "%s\n" "${1-}"
      fi
    }
    git_worktree_has_unpushed() { return 0; }
  ')"

  # Task should remain (preserved for recovery)
  check_eq "terminal cleanup closed: task preserved" "1" "$(jq -r '.tasks | length' "$repo/.wavemill/state.json" 2>/dev/null || echo 0)"
  check_eq "terminal cleanup closed: remains queue-owned" "queue" "$(jq -r --arg issue "$issue" '.tasks[$issue].executionOwner' "$repo/.wavemill/state.json")"
}

echo "=== Mill Lifecycle: Planning to Coding Handoff ==="
harness_extract_real_functions

test_positive_handoff_two_ticks
test_source_edit_blocks_handoff
test_regression_without_wavemill_allowance
test_mixed_artifacts_source_edit_wins
test_claude_local_settings_allowed
test_remote_probe_timeout_does_not_block_plan_approval
test_coding_uses_expanded_route_over_bootstrap
test_missing_expansion_recovery_success_launches_with_expanded_route
test_challenger_missing_expansion_recovery_uses_linear_issue_id
test_expansion_recovery_resolve_issue_id_normalizes_linear_issue_url
test_challenger_missing_expansion_recovery_extracts_linear_issue_id_from_url
test_challenger_missing_expansion_recovery_skips_without_linear_issue_id
test_missing_expansion_recovery_non_challenger_uses_issue_key
test_missing_expansion_recovery_failure_launches_with_bootstrap
test_missing_expansion_recovery_not_repeated
test_invalid_expanded_route_blocks_lifecycle_handoff
test_already_expanded_packet_skips_mandatory_expansion
test_resume_uses_expanded_phase_config_over_stale_state
test_merge_queue_marks_non_candidate_stale_without_rerun
test_merge_queue_disabled_keeps_legacy_rerun
test_queue_owned_pane_release_happy_path
test_queue_owned_pane_release_blocks_on_dirty_worktree
test_queue_owned_pane_release_blocks_on_missing_capsule
test_queue_owned_pane_release_blocks_on_stale_review
test_queue_owned_released_crash_repair_kills_window
test_reconciliation_rehydration_acquires_single_owner
test_reconciliation_returns_to_queue_ownership_after_success
test_restart_does_not_recreate_queue_owned_panes
test_terminal_cleanup_queue_owned_merged_pr_idempotent
test_terminal_cleanup_queue_owned_closed_unmerged_preserves_unsafe_work
test_merge_queue_preserved_merged_tasks_do_not_block_ready_pr
test_merge_queue_closed_unmerged_pr_does_not_block_ready_pr
test_coding_blocked_completion_needs_user_without_advancing
test_coding_blocked_completion_auto_advances_when_valid
test_coding_blocked_completion_auto_advances_with_wavemill_metadata_noise
test_coding_blocked_completion_live_process_needs_attention
test_coding_blocked_completion_terminates_live_process_when_configured
test_coding_blocked_completion_indeterminate_liveness_needs_attention
test_coding_blocked_completion_missing_blocking_checks_advances_when_pane_is_gone
test_coding_blocked_completion_empty_blocking_checks_falls_back_to_any_descendant
test_coding_blocked_completion_dedupes_same_artifact
test_coding_blocked_completion_reannounces_on_mtime_change
test_coding_complete_wins_over_blocked_completion
test_coding_complete_dirty_worktree_without_commits_needs_attention
test_coding_complete_uncommitted_output_dedupes_stable_condition
test_coding_complete_uncommitted_output_reannounces_on_dirty_path_change
test_coding_complete_uncommitted_output_reannounces_on_ahead_count_change
test_coding_complete_uncommitted_output_resolves_to_jsonl_log
test_write_coding_uncommitted_output_artifact_idempotent
test_coding_complete_dirty_worktree_with_commits_needs_attention
test_coding_complete_trace_only_dirty_worktree_advances
test_coding_complete_tracked_claude_settings_advances
test_coding_complete_trace_and_source_dirty_worktree_needs_attention
test_stage_result_trace_events_are_idempotent
test_completed_coding_pane_is_quarantined_best_effort
test_coding_complete_metadata_only_routing_advances_to_review
test_coding_complete_source_dirty_still_blocks
test_coding_blocked_completion_malformed_json_falls_back
test_coding_blocked_completion_missing_required_field_does_not_auto_advance
test_coding_blocked_completion_empty_passing_checks_does_not_auto_advance
test_coding_blocked_completion_stale_commit_does_not_auto_advance
test_coding_blocked_completion_dirty_worktree_does_not_auto_advance
test_coding_blocked_completion_unknown_feature_file_does_not_auto_advance
test_coding_blocked_completion_dedupes_when_stat_unavailable
test_coding_terminal_blocked_report_no_marker_needs_user
test_coding_terminal_blocked_report_ignores_no_commit_evidence
test_coding_terminal_blocked_report_ignores_busy_pane
test_coding_capacity_hook_writes_blocked_completion
test_coding_capacity_prompt_writes_blocked_completion
test_coding_complete_wins_over_capacity_prompt
test_coding_capacity_prompt_ignores_active_output
test_coding_capacity_recovery_is_idempotent
test_coding_capacity_hook_ignores_stale_signal
test_misplaced_coding_complete_marker_is_recovered
test_root_level_coding_complete_marker_is_recovered
test_tracked_root_level_coding_complete_marker_is_ignored
test_root_level_plan_md_is_recovered_before_approval_guard
test_tracked_root_level_plan_md_is_ignored
test_premature_plan_approval_is_quarantined_not_deleted
test_not_eligible_expanded_reroute_does_not_emit_helper_failure_warn
test_disabled_expanded_reroute_does_not_emit_helper_failure_warn
test_routing_error_expanded_reroute_emits_helper_failure_warn
test_review_stage_challenge_honors_phase_config_coder
test_plan_stage_challenge_honors_phase_config_coder
test_implementation_stage_challenge_applies_override
test_missing_challenge_stage_fails_safe_to_phase_config
test_completed_external_dead_pane_triggers_cleanup
test_coding_pane_divergence_idle_pane_ignores_stale_unrelated_marker
test_coding_pane_divergence_idle_pane_different_slug_via_pane_tail_needs_user
test_coding_pane_divergence_fresh_working_hook_keeps_waiting
test_coding_pane_divergence_same_slug_marker_still_recovers
test_coding_pane_divergence_deduplicates_on_repeat_ticks

echo ""
if [[ "$FAIL" -eq 0 ]]; then
  echo "All $PASS lifecycle harness tests passed"
else
  echo "$FAIL lifecycle harness tests failed ($PASS passed)"
  exit 1
fi
