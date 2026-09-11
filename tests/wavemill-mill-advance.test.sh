#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"
COMMON_SCRIPT="$REPO_DIR/shared/lib/wavemill-common.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

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

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" != "$actual" ]]; then
    echo "FAIL: $label"
    echo "  expected: $expected"
    echo "  actual:   $actual"
    exit 1
  fi
}

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "FAIL: $label"
    echo "  expected substring: $needle"
    echo "  actual: $haystack"
    exit 1
  fi
}

assert_file_exists() {
  local label="$1" path="$2"
  [[ -f "$path" ]] || {
    echo "FAIL: $label"
    echo "  missing file: $path"
    exit 1
  }
}

assert_file_missing() {
  local label="$1" path="$2"
  [[ ! -e "$path" ]] || {
    echo "FAIL: $label"
    echo "  unexpected file: $path"
    exit 1
  }
}

source "$COMMON_SCRIPT"

HEREDOC_CONTENT="$(cat "$MONITOR_SCRIPT_FILE")"

FUNCS_FILE="$TMP_DIR/advance-monitor-funcs.sh"
: > "$FUNCS_FILE"
for fn in \
  read_state_value \
  read_stage_result \
  read_stage_status \
  check_stage_complete \
  check_stage_awaiting_user \
  check_stage_aborted \
  _persist_phase \
  resolve_phase \
  resolve_stage_result_model \
  write_stage_result \
  write_stage_result_with_history \
  wavemill_run_tsx_tool \
  monitor_command_timestamp \
  normalize_prompt_command_reply \
  review_result_has_final_evidence \
  review_result_missing_final_evidence \
  review_artifacts_with_pr_number \
  clear_review_gate_attention \
  _challenge_side_for_issue \
  review_recovery_claim_dir \
  review_recovery_try_claim \
  review_recovery_release_claim \
  review_recovery_record_failure \
  review_recovery_restore_or_fail_result \
  read_validated_recovery_contract \
  prepare_recovery_launch_surfaces \
  commit_review_recovery_running \
  blocked_completion_current_head \
  blocked_completion_commit_matches_head \
  wavemill_owned_feature_artifact_path \
  wavemill_owned_dirty_path \
  blocked_completion_auto_allowed_dirty_path \
  coding_output_dirty_paths \
  blocked_completion_worktree_clean_for_auto \
  seam_artifact_cli_path \
  seam_validate_artifact \
  seam_validation_error_summary \
  seam_validation_has_code \
  write_coding_complete_marker \
  blocked_completion_validate_for_advance \
  archive_stale_coding_artifacts \
  coding_pane_replacement_intent_path \
  record_coding_pane_replacement_intent \
  quarantine_completed_coding_pane \
  complete_coding_advance \
  handle_advance_command \
  handle_re_review_command \
  execute_or_defer_monitor_command
do
  extracted="$(extract_function <(printf '%s\n' "$HEREDOC_CONTENT") "$fn")"
  if [[ -z "$extracted" ]]; then
    echo "FAIL: missing extracted function $fn"
    exit 1
  fi
  printf '%s\n\n' "$extracted" >> "$FUNCS_FILE"
done
source "$FUNCS_FILE"

TOOLS_DIR="$TMP_DIR/tools"
mkdir -p "$TOOLS_DIR"

resolve_stage_result_model() {
  local _feature_dir="$1" _stage="$2" fallback="$3"
  printf '%s\n' "$fallback"
}

write_stage_result() {
  local feature_dir="$1" stage="$2" status="$3"
  local agent="${4:-}" model="${5:-}"
  local artifacts_json="${7:-}" artifacts_fragment=""
  if [[ -n "$artifacts_json" ]] && jq empty <<<"$artifacts_json" >/dev/null 2>&1; then
    artifacts_fragment=",\"artifacts\":$artifacts_json"
  fi
  cat > "$feature_dir/.${stage}-result.json" <<EOF
{"stage":"$stage","status":"$status","agent":"$agent","model":"$model"$artifacts_fragment}
EOF
}

_write_stage_result_trace_event() { :; }
marker_reason() {
  local path="$1"
  [[ -f "$path" ]] || return 0
  jq -r '.reason // empty' "$path" 2>/dev/null || head -1 "$path" 2>/dev/null || true
}
marker_clear() { rm -f "$1"; }
read_phase_config() { printf "\n"; }
resolve_phase_model() { printf "%s\n" "${2:-$3}"; }
find_pr_for_branch() { printf "%s\n" "${FOUND_PR:-}"; }
pr_state() { printf "%s\n" "${PR_STATUS:-OPEN}"; }
agent_validate_phase_launch() { return 0; }
prepare_recovery_launch_surfaces() { return "${PREPARE_RECOVERY_RC:-0}"; }
launch_review_calls=0
launch_review_phase() {
  launch_review_calls=$((launch_review_calls + 1))
  return "${REVIEW_LAUNCH_RC:-0}"
}
set_task_phase() { :; }
write_ready_attention_file() {
  mkdir -p "$1"
  printf '%s\n' "$2" > "$1/.needs-attention"
}

log_lines=()
warn_lines=()
log() {
  local level="$1"
  shift
  log_lines+=("$level:$*")
}
log_warn() {
  warn_lines+=("$*")
}
npx() {
  if [[ "${1:-}" == "tsx" && "${2:-}" == *"/recovery-contract.ts" ]]; then
    if [[ "${3:-}" == "provider" ]]; then
      printf '%s\n' '{"ok":true,"provider":"anthropic"}'
      return 0
    fi
    printf '%s\n' '{"ok":true,"contract":{"stageRole":"review","agent":"claude","model":"claude-opus-4-7","provider":"anthropic","challengeSide":null,"selectedAt":"2026-09-11T00:00:00Z"}}'
    return 0
  fi
  command npx "$@"
}
acknowledge_command_offset() {
  ACKED_OFFSETS+=("$1")
}
monitor_defer_command() { :; }
monitor_remove_deferred_command() { :; }

reset_harness() {
  log_lines=()
  warn_lines=()
  ACKED_OFFSETS=()
  MONITOR_COMMAND_STATUS=""
  MONITOR_COMMAND_DEFER_EVENT=""
  MONITOR_COMMAND_DEFER_REASON=""
  launch_review_calls=0
  FOUND_PR=""
  REVIEW_LAUNCH_RC=0
  PREPARE_RECOVERY_RC=0
}

init_state() {
  local state_file="$1"
  cat > "$state_file" <<'EOF'
{
  "tasks": {}
}
EOF
}

write_task_state() {
  local issue="$1" slug="$2" worktree="$3" phase="$4"
  local pr="${5:-}"
  jq -n \
    --arg issue "$issue" \
    --arg slug "$slug" \
    --arg worktree "$worktree" \
    --arg phase "$phase" \
    --arg branch "task/$slug" \
    --arg pr "$pr" \
    '{tasks: {($issue): ({slug: $slug, worktree: $worktree, branch: $branch, phase: $phase} + (if $pr != "" then {pr: $pr} else {} end))}}' > "$STATE_FILE"
}

write_coding_result() {
  local feature_dir="$1" status="$2" json_body="${3:-}"
  if [[ -n "$json_body" ]]; then
    printf '%s\n' "$json_body" > "$feature_dir/.coding-result.json"
    return
  fi

  cat > "$feature_dir/.coding-result.json" <<EOF
{
  "stage": "coding",
  "status": "$status",
  "agent": "codex",
  "model": "gpt-5.4",
  "notes": "blocked on integration",
  "artifacts": {
    "log": "coding.log",
    "summary": "blocked"
  }
}
EOF
}

setup_git_worktree() {
  local worktree="$1"
  git init "$worktree" >/dev/null 2>&1
  (
    cd "$worktree"
    git config user.name "Test User"
    git config user.email "test@example.com"
    printf 'base\n' > tracked.txt
    git add tracked.txt
    git commit -m "base" >/dev/null 2>&1
  )
}

write_blocked_completion() {
  local feature_dir="$1" commit="$2" extra_json="${3:-}"
  cat > "$feature_dir/.coding-blocked-completion.json" <<EOF
{
  "stage": "coding",
  "implementationComplete": true,
  "committed": true,
  "commit": "$commit",
  "passingChecks": ["tests/wavemill-mill-advance.test.sh"],
  "blockingChecks": ["pnpm typecheck"],
  "blockingReason": "baseline_tests_failing",
  "evidence": "Repo-level verification is failing outside this change.",
  "recommendedAction": "advance_to_review"$extra_json
}
EOF
}

run_advance() {
  local event="$1"
  reset_harness
  execute_or_defer_monitor_command "new" "$event" "7" "0" "" "" "" ""
}

run_advance_quiet() {
  local event="$1"
  run_advance "$event" 2>/dev/null
}

run_rereview() {
  local event="$1" free_slots="${2:-1}" launch_rc="${3:-0}"
  reset_harness
  REVIEW_LAUNCH_RC="$launch_rc"
  execute_or_defer_monitor_command "new" "$event" "11" "$free_slots" "" "" "" ""
}

SCENARIO_DIR="$TMP_DIR/scenario"
mkdir -p "$SCENARIO_DIR"
STATE_FILE="$SCENARIO_DIR/state.json"
SESSION="advance-command-test"
AGENT_CMD="codex"
BASE_BRANCH="main"
PR_STATUS="OPEN"
init_state "$STATE_FILE"

# Success
WORKTREE_SUCCESS="$SCENARIO_DIR/worktree-success"
FEATURE_SUCCESS="$WORKTREE_SUCCESS/features/test-slug"
mkdir -p "$FEATURE_SUCCESS"
setup_git_worktree "$WORKTREE_SUCCESS"
write_task_state "HOK-1639" "test-slug" "$WORKTREE_SUCCESS" "coding"
write_coding_result "$FEATURE_SUCCESS" "running"
write_blocked_completion "$FEATURE_SUCCESS" "$(git -C "$WORKTREE_SUCCESS" rev-parse --short HEAD)"
run_advance "advance HOK-1639"
assert_eq "success status" "handled" "$MONITOR_COMMAND_STATUS"
assert_file_exists "success writes audit artifact" "$FEATURE_SUCCESS/.coding-advance-override.json"
assert_file_exists "success writes coding complete marker" "$FEATURE_SUCCESS/.coding-complete"
assert_file_exists "success records expected review window replacement" "$FEATURE_SUCCESS/.coding-pane-replacement-intent.json"
assert_eq "success acks command offset" "7" "${ACKED_OFFSETS[0]:-}"
assert_contains "success log message" "HOK-1639 -> advance recorded; review will launch on the next monitor tick" "${log_lines[*]}"
assert_eq "success audit issue" "HOK-1639" "$(jq -r '.issue' "$FEATURE_SUCCESS/.coding-advance-override.json")"
assert_eq "success audit reason" "manual advance via mill input" "$(jq -r '.reason' "$FEATURE_SUCCESS/.coding-advance-override.json")"
assert_eq "success audit path" "features/test-slug/.coding-blocked-completion.json" "$(jq -r '.artifact_summary.path' "$FEATURE_SUCCESS/.coding-advance-override.json")"
assert_eq "success audit action" "advance_to_review" "$(jq -r '.artifact_summary.recommendedAction' "$FEATURE_SUCCESS/.coding-advance-override.json")"
assert_eq "success audit passing count" "1" "$(jq -r '.artifact_summary.passing_checks_count' "$FEATURE_SUCCESS/.coding-advance-override.json")"
assert_eq "success audit stage running guardrail" "true" "$(jq -r '.guardrails.stageRunning' "$FEATURE_SUCCESS/.coding-advance-override.json")"
assert_eq "success replacement intent issue" "HOK-1639" "$(jq -r '.issue' "$FEATURE_SUCCESS/.coding-pane-replacement-intent.json")"
assert_eq "success replacement intent to review" "review" "$(jq -r '.to' "$FEATURE_SUCCESS/.coding-pane-replacement-intent.json")"
assert_contains "success audit timestamp present" "T" "$(jq -r '.timestamp' "$FEATURE_SUCCESS/.coding-advance-override.json")"
assert_eq "backlog prompt preserves advance command" "advance HOK-1639" "$(normalize_prompt_command_reply "advance HOK-1639")"

# Challenger success
WORKTREE_CHALLENGER="$SCENARIO_DIR/worktree-challenger"
FEATURE_CHALLENGER="$WORKTREE_CHALLENGER/features/challenger-slug"
mkdir -p "$FEATURE_CHALLENGER"
setup_git_worktree "$WORKTREE_CHALLENGER"
write_task_state "HOK-1639_c" "challenger-slug" "$WORKTREE_CHALLENGER" "coding"
write_coding_result "$FEATURE_CHALLENGER" "running"
write_blocked_completion "$FEATURE_CHALLENGER" "$(git -C "$WORKTREE_CHALLENGER" rev-parse --short HEAD)"
run_advance "advance HOK-1639_c"
assert_eq "challenger success status" "handled" "$MONITOR_COMMAND_STATUS"
assert_file_exists "challenger writes audit artifact" "$FEATURE_CHALLENGER/.coding-advance-override.json"
assert_file_exists "challenger writes coding complete marker" "$FEATURE_CHALLENGER/.coding-complete"
assert_file_exists "challenger records expected review window replacement" "$FEATURE_CHALLENGER/.coding-pane-replacement-intent.json"
assert_contains "challenger success log message" "HOK-1639_c -> advance recorded; review will launch on the next monitor tick" "${log_lines[*]}"
assert_eq "challenger audit issue" "HOK-1639_c" "$(jq -r '.issue' "$FEATURE_CHALLENGER/.coding-advance-override.json")"
assert_eq "challenger prompt preserves advance command" "advance HOK-1639_c" "$(normalize_prompt_command_reply "advance HOK-1639_c")"

# Unknown issue
init_state "$STATE_FILE"
run_advance "advance HOK-9999"
assert_eq "unknown issue invalid" "invalid" "$MONITOR_COMMAND_STATUS"
assert_contains "unknown issue message" "HOK-9999 is not tracked" "${warn_lines[*]}"

# Not in coding
WORKTREE_REVIEW="$SCENARIO_DIR/worktree-review"
FEATURE_REVIEW="$WORKTREE_REVIEW/features/review-slug"
mkdir -p "$FEATURE_REVIEW"
write_task_state "HOK-2000" "review-slug" "$WORKTREE_REVIEW" "review"
cat > "$FEATURE_REVIEW/.review-result.json" <<'EOF'
{"stage":"review","status":"running"}
EOF
run_advance "advance HOK-2000"
assert_eq "review phase invalid" "invalid" "$MONITOR_COMMAND_STATUS"
assert_contains "review phase message" "HOK-2000 is in phase review" "${warn_lines[*]}"
assert_file_missing "review phase no audit" "$FEATURE_REVIEW/.coding-advance-override.json"
assert_file_missing "review phase no marker" "$FEATURE_REVIEW/.coding-complete"

# Missing artifact
WORKTREE_MISSING="$SCENARIO_DIR/worktree-missing"
FEATURE_MISSING="$WORKTREE_MISSING/features/missing-slug"
mkdir -p "$FEATURE_MISSING"
write_task_state "HOK-2001" "missing-slug" "$WORKTREE_MISSING" "coding"
cat > "$FEATURE_MISSING/.planning-result.json" <<'EOF'
{"stage":"planning","status":"completed"}
EOF
run_advance "advance HOK-2001"
assert_eq "missing artifact invalid" "invalid" "$MONITOR_COMMAND_STATUS"
assert_contains "missing artifact message" "blocked-completion artifact" "${warn_lines[*]}"
assert_file_missing "missing artifact no audit" "$FEATURE_MISSING/.coding-advance-override.json"
assert_file_missing "missing artifact no marker" "$FEATURE_MISSING/.coding-complete"

# Invalid artifact JSON
WORKTREE_BAD_JSON="$SCENARIO_DIR/worktree-bad-json"
FEATURE_BAD_JSON="$WORKTREE_BAD_JSON/features/bad-json-slug"
mkdir -p "$FEATURE_BAD_JSON"
write_task_state "HOK-2002" "bad-json-slug" "$WORKTREE_BAD_JSON" "coding"
cat > "$FEATURE_BAD_JSON/.planning-result.json" <<'EOF'
{"stage":"planning","status":"completed"}
EOF
printf '{broken json\n' > "$FEATURE_BAD_JSON/.coding-blocked-completion.json"
run_advance "advance HOK-2002"
assert_eq "bad json invalid" "invalid" "$MONITOR_COMMAND_STATUS"
assert_contains "bad json message" "blocked-completion artifact" "${warn_lines[*]}"

# Invalid artifact status
WORKTREE_BAD_STATUS="$SCENARIO_DIR/worktree-bad-status"
FEATURE_BAD_STATUS="$WORKTREE_BAD_STATUS/features/bad-status-slug"
mkdir -p "$FEATURE_BAD_STATUS"
setup_git_worktree "$WORKTREE_BAD_STATUS"
write_task_state "HOK-2003" "bad-status-slug" "$WORKTREE_BAD_STATUS" "coding"
write_coding_result "$FEATURE_BAD_STATUS" "running"
cat > "$FEATURE_BAD_STATUS/.coding-blocked-completion.json" <<'EOF'
{
  "stage": "coding",
  "implementationComplete": true,
  "committed": true,
  "passingChecks": [],
  "blockingChecks": ["pnpm typecheck"],
  "blockingReason": "baseline_tests_failing",
  "evidence": "Repo-level verification is failing outside this change.",
  "recommendedAction": "advance_to_review"
}
EOF
run_advance "advance HOK-2003"
assert_eq "bad status invalid" "invalid" "$MONITOR_COMMAND_STATUS"
assert_contains "bad status message" "blocked-completion artifact" "${warn_lines[*]}"
assert_file_missing "bad status no audit" "$FEATURE_BAD_STATUS/.coding-advance-override.json"
assert_file_missing "bad status no marker" "$FEATURE_BAD_STATUS/.coding-complete"

# Usage errors
for bad_event in "advance" "advance hok-1639" "advance HOK-1 extra"; do
  init_state "$STATE_FILE"
  run_advance "$bad_event"
  assert_eq "usage invalid for $bad_event" "invalid" "$MONITOR_COMMAND_STATUS"
  assert_contains "usage message for $bad_event" "usage: advance <issue-id>" "${warn_lines[*]}"
done

# Re-review command success and validation
WORKTREE_REREVIEW="$SCENARIO_DIR/worktree-rereview"
FEATURE_REREVIEW="$WORKTREE_REREVIEW/features/rereview-slug"
mkdir -p "$FEATURE_REREVIEW"
setup_git_worktree "$WORKTREE_REREVIEW"
write_task_state "HOK-2012" "rereview-slug" "$WORKTREE_REREVIEW" "ready" "912"
cat > "$FEATURE_REREVIEW/.review-result.json" <<'EOF'
{
  "stage": "review",
  "status": "completed",
  "artifacts": {
    "type": "review",
    "prNumber": 912,
    "exitCode": 1,
    "verdict": "not_ready",
    "iterations": 1,
    "blockerCount": 1,
    "history": ["kept"]
  }
}
EOF
printf '%s\n' 'Review verdict does not pass readiness gate for PR #912.' > "$FEATURE_REREVIEW/.needs-attention"
run_rereview "re-review HOK-2012"
assert_eq "re-review handled" "handled" "$MONITOR_COMMAND_STATUS"
assert_eq "re-review launches review" "1" "$launch_review_calls"
assert_eq "re-review resets review status" "running" "$(jq -r '.status' "$FEATURE_REREVIEW/.review-result.json")"
assert_eq "re-review uses contract agent" "claude" "$(jq -r '.agent' "$FEATURE_REREVIEW/.review-result.json")"
assert_eq "re-review uses contract model" "claude-opus-4-7" "$(jq -r '.model' "$FEATURE_REREVIEW/.review-result.json")"
assert_eq "re-review preserves prior verdict in audit" "not_ready" "$(jq -r '.previousReviewResult.artifacts.verdict' "$FEATURE_REREVIEW/.review-rerun-request.json")"
assert_eq "re-review preserves prior history in audit" "kept" "$(jq -r '.previousReviewResult.artifacts.history[0]' "$FEATURE_REREVIEW/.review-rerun-request.json")"
assert_file_missing "re-review clears stale review-gate attention" "$FEATURE_REREVIEW/.needs-attention"

WORKTREE_REREVIEW_FAIL="$SCENARIO_DIR/worktree-rereview-fail"
FEATURE_REREVIEW_FAIL="$WORKTREE_REREVIEW_FAIL/features/rereview-fail-slug"
mkdir -p "$FEATURE_REREVIEW_FAIL"
setup_git_worktree "$WORKTREE_REREVIEW_FAIL"
write_task_state "HOK-2017" "rereview-fail-slug" "$WORKTREE_REREVIEW_FAIL" "ready" "917"
cat > "$FEATURE_REREVIEW_FAIL/.review-result.json" <<'EOF'
{
  "stage": "review",
  "status": "completed",
  "agent": "codex",
  "model": "gpt-5.5",
  "artifacts": {
    "type": "review",
    "prNumber": 917,
    "exitCode": 1,
    "verdict": "not_ready",
    "iterations": 1,
    "blockerCount": 1,
    "history": ["kept"]
  }
}
EOF
run_rereview "re-review HOK-2017" 1 1
assert_eq "failed re-review invalid" "invalid" "$MONITOR_COMMAND_STATUS"
assert_eq "failed re-review attempted launch" "1" "$launch_review_calls"
assert_eq "failed re-review restores terminal status" "completed" "$(jq -r '.status' "$FEATURE_REREVIEW_FAIL/.review-result.json")"
assert_eq "failed re-review preserves prior history" "kept" "$(jq -r '.artifacts.history[0]' "$FEATURE_REREVIEW_FAIL/.review-result.json")"
assert_eq "failed re-review records terminal reason" "manual_re_review_launch_failed: rc=1" "$(jq -r '.reason' "$FEATURE_REREVIEW_FAIL/.review-recovery-failure.json")"
assert_file_missing "failed re-review clears claim" "$FEATURE_REREVIEW_FAIL/.review-recovery-claim"

run_rereview "re-review HOK-2012" 0
assert_eq "re-review no slots defers" "deferred" "$MONITOR_COMMAND_STATUS"
assert_eq "re-review deferred event" "re-review HOK-2012" "$MONITOR_COMMAND_DEFER_EVENT"

init_state "$STATE_FILE"
run_rereview "re-review HOK-9999"
assert_eq "re-review unknown invalid" "invalid" "$MONITOR_COMMAND_STATUS"
assert_contains "re-review unknown message" "HOK-9999 is not tracked" "${warn_lines[*]}"

WORKTREE_REREVIEW_NOPR="$SCENARIO_DIR/worktree-rereview-nopr"
FEATURE_REREVIEW_NOPR="$WORKTREE_REREVIEW_NOPR/features/rereview-nopr-slug"
mkdir -p "$FEATURE_REREVIEW_NOPR"
setup_git_worktree "$WORKTREE_REREVIEW_NOPR"
write_task_state "HOK-2013" "rereview-nopr-slug" "$WORKTREE_REREVIEW_NOPR" "review"
cat > "$FEATURE_REREVIEW_NOPR/.review-result.json" <<'EOF'
{"stage":"review","status":"completed","artifacts":{"type":"review","exitCode":0,"verdict":"ready","iterations":1,"blockerCount":0}}
EOF
run_rereview "re-review HOK-2013"
assert_eq "re-review no PR invalid" "invalid" "$MONITOR_COMMAND_STATUS"
assert_contains "re-review no PR message" "has no open PR" "${warn_lines[*]}"

WORKTREE_REREVIEW_CLOSED="$SCENARIO_DIR/worktree-rereview-closed"
FEATURE_REREVIEW_CLOSED="$WORKTREE_REREVIEW_CLOSED/features/rereview-closed-slug"
mkdir -p "$FEATURE_REREVIEW_CLOSED"
setup_git_worktree "$WORKTREE_REREVIEW_CLOSED"
write_task_state "HOK-2014" "rereview-closed-slug" "$WORKTREE_REREVIEW_CLOSED" "ready" "914"
cat > "$FEATURE_REREVIEW_CLOSED/.review-result.json" <<'EOF'
{"stage":"review","status":"completed","artifacts":{"type":"review","prNumber":914,"exitCode":0,"verdict":"ready","iterations":1,"blockerCount":0}}
EOF
PR_STATUS="CLOSED"
run_rereview "re-review HOK-2014"
assert_eq "re-review closed PR invalid" "invalid" "$MONITOR_COMMAND_STATUS"
assert_contains "re-review closed PR message" "is not open" "${warn_lines[*]}"

WORKTREE_REREVIEW_PHASE="$SCENARIO_DIR/worktree-rereview-phase"
FEATURE_REREVIEW_PHASE="$WORKTREE_REREVIEW_PHASE/features/rereview-phase-slug"
mkdir -p "$FEATURE_REREVIEW_PHASE"
setup_git_worktree "$WORKTREE_REREVIEW_PHASE"
write_task_state "HOK-2015" "rereview-phase-slug" "$WORKTREE_REREVIEW_PHASE" "coding" "915"
write_coding_result "$FEATURE_REREVIEW_PHASE" "running"
run_rereview "re-review HOK-2015"
assert_eq "re-review wrong phase invalid" "invalid" "$MONITOR_COMMAND_STATUS"
assert_contains "re-review wrong phase message" "re-review only works for review or ready tasks" "${warn_lines[*]}"

WORKTREE_REREVIEW_RUNNING="$SCENARIO_DIR/worktree-rereview-running"
FEATURE_REREVIEW_RUNNING="$WORKTREE_REREVIEW_RUNNING/features/rereview-running-slug"
mkdir -p "$FEATURE_REREVIEW_RUNNING"
setup_git_worktree "$WORKTREE_REREVIEW_RUNNING"
write_task_state "HOK-2016" "rereview-running-slug" "$WORKTREE_REREVIEW_RUNNING" "review" "916"
write_stage_result "$FEATURE_REREVIEW_RUNNING" "review" "running"
run_rereview "re-review HOK-2016"
assert_eq "re-review running invalid" "invalid" "$MONITOR_COMMAND_STATUS"
assert_contains "re-review running message" "review is already running" "${warn_lines[*]}"

# Audit-before-advance
WORKTREE_AUDIT_FAIL="$SCENARIO_DIR/worktree-audit-fail"
FEATURE_AUDIT_FAIL="$WORKTREE_AUDIT_FAIL/features/audit-fail-slug"
mkdir -p "$FEATURE_AUDIT_FAIL"
setup_git_worktree "$WORKTREE_AUDIT_FAIL"
write_task_state "HOK-2004" "audit-fail-slug" "$WORKTREE_AUDIT_FAIL" "coding"
write_coding_result "$FEATURE_AUDIT_FAIL" "running"
write_blocked_completion "$FEATURE_AUDIT_FAIL" "$(git -C "$WORKTREE_AUDIT_FAIL" rev-parse --short HEAD)"
chmod 500 "$FEATURE_AUDIT_FAIL"
run_advance_quiet "advance HOK-2004"
assert_eq "audit failure invalid" "invalid" "$MONITOR_COMMAND_STATUS"
assert_file_missing "audit failure does not create marker" "$FEATURE_AUDIT_FAIL/.coding-complete"
chmod 700 "$FEATURE_AUDIT_FAIL"

# Idempotency
WORKTREE_IDEMP="$SCENARIO_DIR/worktree-idempotent"
FEATURE_IDEMP="$WORKTREE_IDEMP/features/idempotent-slug"
mkdir -p "$FEATURE_IDEMP"
setup_git_worktree "$WORKTREE_IDEMP"
write_task_state "HOK-2005" "idempotent-slug" "$WORKTREE_IDEMP" "coding"
write_coding_result "$FEATURE_IDEMP" "running"
write_blocked_completion "$FEATURE_IDEMP" "$(git -C "$WORKTREE_IDEMP" rev-parse --short HEAD)"
printf '{"stage":"coding","confidence":"high"}\n' > "$FEATURE_IDEMP/.coding-complete"
run_advance "advance HOK-2005"
assert_eq "idempotent handled" "handled" "$MONITOR_COMMAND_STATUS"
assert_file_exists "idempotent audit exists" "$FEATURE_IDEMP/.coding-advance-override.json"
assert_file_exists "idempotent marker still exists" "$FEATURE_IDEMP/.coding-complete"

# Soft guardrails are overrideable for manual advance
WORKTREE_SOFT="$SCENARIO_DIR/worktree-soft"
FEATURE_SOFT="$WORKTREE_SOFT/features/soft-slug"
mkdir -p "$FEATURE_SOFT"
setup_git_worktree "$WORKTREE_SOFT"
(
  cd "$WORKTREE_SOFT"
  printf 'dirty\n' >> tracked.txt
)
write_task_state "HOK-2006" "soft-slug" "$WORKTREE_SOFT" "coding"
write_coding_result "$FEATURE_SOFT" "running"
write_blocked_completion "$FEATURE_SOFT" "deadbee"
run_advance "advance HOK-2006"
assert_eq "soft guardrail override handled" "handled" "$MONITOR_COMMAND_STATUS"
assert_eq "soft guardrail commit mismatch recorded" "false" "$(jq -r '.guardrails.commitMatchesHead' "$FEATURE_SOFT/.coding-advance-override.json")"
assert_eq "soft guardrail dirty worktree recorded" "false" "$(jq -r '.guardrails.worktreeClean' "$FEATURE_SOFT/.coding-advance-override.json")"

# Stale blocked-completion artifacts are rejected in auto mode
WORKTREE_STALE_AUTO="$SCENARIO_DIR/worktree-stale-auto"
FEATURE_STALE_AUTO="$WORKTREE_STALE_AUTO/features/stale-auto-slug"
mkdir -p "$FEATURE_STALE_AUTO"
setup_git_worktree "$WORKTREE_STALE_AUTO"
write_coding_result "$FEATURE_STALE_AUTO" "running" '{"stage":"coding","status":"running","startedAt":"2030-01-01T00:00:00Z"}'
write_blocked_completion "$FEATURE_STALE_AUTO" "$(git -C "$WORKTREE_STALE_AUTO" rev-parse --short HEAD)"
touch -t 202001010000 "$FEATURE_STALE_AUTO/.coding-blocked-completion.json"
stale_auto_decision="$(blocked_completion_validate_for_advance "HOK-2007" "$FEATURE_STALE_AUTO" auto 2>/dev/null || true)"
assert_eq "stale auto ineligible" "false" "$(jq -r '.eligible' <<<"$stale_auto_decision")"
assert_eq "stale auto freshness guardrail" "false" "$(jq -r '.guardrails.artifactFresh' <<<"$stale_auto_decision")"
assert_contains "stale auto reason" "predates" "$(jq -r '.reason' <<<"$stale_auto_decision")"

# Stale blocked-completion artifacts are soft failures in manual mode
stale_manual_decision="$(blocked_completion_validate_for_advance "HOK-2007" "$FEATURE_STALE_AUTO" manual)"
assert_eq "stale manual eligible" "true" "$(jq -r '.eligible' <<<"$stale_manual_decision")"
assert_eq "stale manual freshness guardrail" "false" "$(jq -r '.guardrails.artifactFresh' <<<"$stale_manual_decision")"
assert_contains "stale manual reason" "manual override accepted" "$(jq -r '.reason' <<<"$stale_manual_decision")"

# Fresh blocked-completion artifacts remain eligible in auto mode
WORKTREE_FRESH_AUTO="$SCENARIO_DIR/worktree-fresh-auto"
FEATURE_FRESH_AUTO="$WORKTREE_FRESH_AUTO/features/fresh-auto-slug"
mkdir -p "$FEATURE_FRESH_AUTO"
setup_git_worktree "$WORKTREE_FRESH_AUTO"
write_coding_result "$FEATURE_FRESH_AUTO" "running" '{"stage":"coding","status":"running","startedAt":"2020-01-01T00:00:00Z"}'
write_blocked_completion "$FEATURE_FRESH_AUTO" "$(git -C "$WORKTREE_FRESH_AUTO" rev-parse --short HEAD)"
fresh_auto_decision="$(blocked_completion_validate_for_advance "HOK-2008" "$FEATURE_FRESH_AUTO" auto)"
assert_eq "fresh auto eligible" "true" "$(jq -r '.eligible' <<<"$fresh_auto_decision")"
assert_eq "fresh auto freshness guardrail" "true" "$(jq -r '.guardrails.artifactFresh' <<<"$fresh_auto_decision")"

# Missing startedAt skips the freshness guardrail to preserve prior behavior
WORKTREE_NO_START="$SCENARIO_DIR/worktree-no-start"
FEATURE_NO_START="$WORKTREE_NO_START/features/no-start-slug"
mkdir -p "$FEATURE_NO_START"
setup_git_worktree "$WORKTREE_NO_START"
write_coding_result "$FEATURE_NO_START" "running"
write_blocked_completion "$FEATURE_NO_START" "$(git -C "$WORKTREE_NO_START" rev-parse --short HEAD)"
touch -t 202001010000 "$FEATURE_NO_START/.coding-blocked-completion.json"
no_start_decision="$(blocked_completion_validate_for_advance "HOK-2009" "$FEATURE_NO_START" auto)"
assert_eq "missing startedAt eligible" "true" "$(jq -r '.eligible' <<<"$no_start_decision")"
assert_eq "missing startedAt freshness fail-open" "true" "$(jq -r '.guardrails.artifactFresh' <<<"$no_start_decision")"

# Stale coding artifacts are archived non-destructively and repeated calls are no-ops
FEATURE_ARCHIVE="$SCENARIO_DIR/archive-feature"
mkdir -p "$FEATURE_ARCHIVE"
printf '{"stage":"coding","confidence":"high"}\n' > "$FEATURE_ARCHIVE/.coding-complete"
printf '{"stage":"coding"}\n' > "$FEATURE_ARCHIVE/.coding-blocked-completion.json"
printf 'announced\n' > "$FEATURE_ARCHIVE/.blocked-completion-announced"
printf 'dirty\n' > "$FEATURE_ARCHIVE/.coding-uncommitted-output-announced"
printf '{"stage":"coding"}\n' > "$FEATURE_ARCHIVE/.coding-failure-handoff.json"
archive_stale_coding_artifacts "HOK-2010" "$FEATURE_ARCHIVE"
archive_dir="$(find "$FEATURE_ARCHIVE/.stale-artifacts" -mindepth 1 -maxdepth 1 -type d -name 'coding-*' -print -quit)"
[[ -n "$archive_dir" ]] || {
  echo "FAIL: archive helper created archive directory"
  exit 1
}
assert_file_exists "archive moved coding complete" "$archive_dir/.coding-complete"
assert_file_exists "archive moved blocked completion" "$archive_dir/.coding-blocked-completion.json"
assert_file_exists "archive moved blocked announcement" "$archive_dir/.blocked-completion-announced"
assert_file_exists "archive moved dirty announcement" "$archive_dir/.coding-uncommitted-output-announced"
assert_file_exists "archive moved failure handoff" "$archive_dir/.coding-failure-handoff.json"
assert_file_missing "archive removed original coding complete" "$FEATURE_ARCHIVE/.coding-complete"
assert_contains "archive log lists artifacts" ".coding-complete" "${log_lines[*]}"
archive_stale_coding_artifacts "HOK-2010" "$FEATURE_ARCHIVE"
archive_count="$(find "$FEATURE_ARCHIVE/.stale-artifacts" -mindepth 1 -maxdepth 1 -type d -name 'coding-*' | wc -l | tr -d ' ')"
assert_eq "archive second call no-op" "1" "$archive_count"

FEATURE_ARCHIVE_EMPTY="$SCENARIO_DIR/archive-empty-feature"
mkdir -p "$FEATURE_ARCHIVE_EMPTY"
archive_stale_coding_artifacts "HOK-2011" "$FEATURE_ARCHIVE_EMPTY"
[[ ! -e "$FEATURE_ARCHIVE_EMPTY/.stale-artifacts" ]] || {
  echo "FAIL: empty archive helper should not create archive root"
  exit 1
}

echo "PASS: advance command validates, audits, and advances coding tasks"
