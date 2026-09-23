#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT="$REPO_DIR/shared/lib/wavemill-monitor.sh"
COMMON_SCRIPT="$REPO_DIR/shared/lib/wavemill-common.sh"
# Real tools dir for exercising the envelope reader tool before REPO_DIR/TOOLS_DIR
# are reassigned to temp fixtures below.
REAL_TOOLS_DIR="$REPO_DIR/tools"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

extract_function() {
  local function_name="$1"
  awk -v name="$function_name" '
    function brace_delta(line, stripped, opens, closes) {
      stripped = line
      gsub(/"([^"\\]|\\.)*"/, "\"\"", stripped)
      gsub(/\047([^\047\\]|\\.)*\047/, "\047\047", stripped)
      opens = gsub(/\{/, "{", stripped)
      closes = gsub(/\}/, "}", stripped)
      return opens - closes
    }
    $0 ~ "^" name "\\(\\)[[:space:]]*\\{" { capture = 1; depth = 0 }
    capture {
      print
      depth += brace_delta($0)
      if (depth == 0) exit
    }
  ' "$MONITOR_SCRIPT"
}

FUNCS_FILE="$TMP_DIR/review-recovery-functions.sh"
: > "$FUNCS_FILE"
for fn in \
  review_recovery_claim_path \
  review_recovery_write_claim \
  review_recovery_settle_claim \
  review_recovery_write_audit \
  review_recovery_terminal_artifacts_json \
  review_recovery_restore_terminal_result \
  review_recovery_running_artifacts_json \
  review_result_has_final_evidence \
  review_result_missing_final_evidence \
  review_result_infra_failure \
  review_result_failure_category \
  review_result_review_head_sha \
  review_infra_recovery_category_label \
  review_infra_recovery_next_action \
  review_result_native_timeout_identity \
  review_recovery_timeout_state_path \
  review_recovery_write_timeout_state \
  review_recovery_clear_ready_handoff_state \
  review_recovery_publish_running \
  native_terminal_failure_kind \
  native_stage_failure_envelope_json \
  review_recovery_coordinator \
  review_recovery_coordinator_locked
do
  extract_function "$fn" >> "$FUNCS_FILE"
  printf '\n' >> "$FUNCS_FILE"
done

source "$COMMON_SCRIPT"
source "$FUNCS_FILE"

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then pass "$label"; else fail "$label (expected '$expected', got '$actual')"; fi
}

SESSION="review-recovery-test-$$"
STATE_FILE="$TMP_DIR/state.json"
REPO_DIR="$TMP_DIR/repo"
TOOLS_DIR="$TMP_DIR/tools"
mkdir -p "$REPO_DIR" "$TOOLS_DIR"

log() { :; }
log_warn() { :; }
log_error() { :; }
monitor_command_timestamp() { printf '2026-09-11T00:00:00Z\n'; }
read_phase_config() { printf 'static\n'; }
agent_validate_phase_launch() { return 0; }
_prepare_recovery_phase_launch() { return 0; }
review_recovery_window_observable() { return 0; }
clear_review_gate_attention() { rm -f "$1/.needs-attention"; }
write_ready_attention_file() { printf '%s\n' "$2" > "$1/.needs-attention"; }
check_stage_aborted() { return 1; }
_challenge_side_for_issue() {
  if [[ "$1" == *_c ]]; then
    printf 'challenger\n'
  elif [[ -n "${PRIMARY_CHALLENGE_ISSUE:-}" && "$1" == "$PRIMARY_CHALLENGE_ISSUE" ]]; then
    printf 'primary\n'
  else
    printf '\n'
  fi
}
get_task_meta() {
  # $1 issue, $2 key. Only challengePairId is consulted by the code under test.
  if [[ "$2" == "challengePairId" ]]; then
    printf '%s\n' "${TASK_PAIR_ID:-}"
  else
    printf '\n'
  fi
}
challenge_abort_pair() {
  printf '%s|%s|%s|%s|%s\n' "$1" "$4" "$5" "$6" "${9:-pair}" >> "$CHALLENGE_ABORT_LOG"
}
challenge_selection_health_record_review_timeout() {
  printf '%s|%s\n' "$1" "$2" >> "$RECORD_OUTCOME_LOG"
}
read_stage_status() {
  local feature_dir="$1" stage="$2"
  jq -r '.status // empty' "$feature_dir/.${stage}-result.json" 2>/dev/null || true
}
write_stage_result_with_history() {
  local feature_dir="$1" stage="$2" status="$3" agent="${4:-}" model="${5:-}" notes="${6:-}" artifacts="${7:-{}}"
  [[ "${WRITE_STAGE_RESULT_FAIL:-0}" != "1" ]] || return 1
  mkdir -p "$feature_dir"
  if [[ -z "$artifacts" ]] || ! jq empty <<<"$artifacts" >/dev/null 2>&1; then
    artifacts='{}'
  fi
  jq -cn --arg stage "$stage" --arg status "$status" --arg agent "$agent" --arg model "$model" --arg notes "$notes" --argjson artifacts "$artifacts" \
    '{stage:$stage,status:$status,agent:$agent,model:$model,notes:$notes,artifacts:$artifacts}' > "$feature_dir/.${stage}-result.json"
}

CONTRACT_AGENT="claude"
CONTRACT_MODEL="claude-sonnet-5"
CONTRACT_PROVIDER="anthropic"
review_recovery_contract_payload() {
  jq -cn --arg agent "$CONTRACT_AGENT" --arg model "$CONTRACT_MODEL" --arg provider "$CONTRACT_PROVIDER" \
    '{stageRole:"review",agent:$agent,model:$model,provider:$provider}'
}

launch_review_phase() {
  printf '%s|%s\n' "${8:-}" "${7:-}" >> "$LAUNCH_LOG"
  return "${LAUNCH_RC:-0}"
}

setup_case() {
  local name="$1"
  CASE_DIR="$TMP_DIR/$name"
  WT_DIR="$CASE_DIR/worktree"
  FEATURE_DIR="$WT_DIR/features/slug"
  LAUNCH_LOG="$CASE_DIR/launch.log"
  CHALLENGE_ABORT_LOG="$CASE_DIR/challenge-abort.log"
  RECORD_OUTCOME_LOG="$CASE_DIR/record-outcome.log"
  mkdir -p "$FEATURE_DIR"
  : > "$LAUNCH_LOG"
  : > "$CHALLENGE_ABORT_LOG"
  : > "$RECORD_OUTCOME_LOG"
  cat > "$STATE_FILE" <<EOF
{"tasks":{"HOK-2999_c":{"phase":"ready","slug":"slug","worktree":"$WT_DIR","branch":"task/slug","provider":"openai","agent":"codex","model":"gpt-5","executionOwner":"queue","paneState":"released","lifecycle":{"resourceDisposition":"released"}}}}
EOF
}

echo "=== Review Recovery Coordinator ==="

setup_case "stale-prior"
cat > "$FEATURE_DIR/.review-result.json" <<'EOF'
{"stage":"review","status":"failed","agent":"codex","model":"gpt-5","notes":"old infra failure","artifacts":{"type":"review","prNumber":1378,"failureCategory":"review-tool-error","verdict":"error","history":["kept"]}}
EOF
review_recovery_coordinator "HOK-2999_c" "slug" "Task" "$WT_DIR" "task/slug" "auto/integration" "1378" "$FEATURE_DIR" "test recovery" "manual" "manual" "" 0 "false"
assert_eq "stale prior result does not drive launch agent" "claude|claude-sonnet-5" "$(cat "$LAUNCH_LOG")"
assert_eq "successful recovery publishes running" "running" "$(jq -r '.status' "$FEATURE_DIR/.review-result.json")"
assert_eq "task phase moves ready to review" "review" "$(jq -r '.tasks["HOK-2999_c"].phase' "$STATE_FILE")"
assert_eq "state records contract agent" "claude" "$(jq -r '.tasks["HOK-2999_c"].agent' "$STATE_FILE")"
assert_eq "prior verdict preserved in audit" "error" "$(jq -r '.previousReviewResult.artifacts.verdict' "$FEATURE_DIR/.review-rerun-request.json")"

setup_case "launch-failure"
cat > "$FEATURE_DIR/.review-result.json" <<'EOF'
{"stage":"review","status":"failed","agent":"codex","model":"gpt-5","notes":"old infra failure","artifacts":{"type":"review","prNumber":1378,"failureCategory":"review-tool-error","verdict":"error","history":["kept"]}}
EOF
LAUNCH_RC=1 review_recovery_coordinator "HOK-2999_c" "slug" "Task" "$WT_DIR" "task/slug" "auto/integration" "1378" "$FEATURE_DIR" "test recovery" "manual" "manual" "" 0 "false" || true
assert_eq "failed launch restores terminal status" "failed" "$(jq -r '.status' "$FEATURE_DIR/.review-result.json")"
assert_eq "failed launch leaves no running replay" "not-running" "$(jq -r 'if (.artifacts.recoveryReplay.status // "") == "running" then "running" else "not-running" end' "$FEATURE_DIR/.review-result.json")"
assert_eq "failed launch keeps original verdict in audit" "error" "$(jq -r '.previousReviewResult.artifacts.verdict' "$FEATURE_DIR/.review-rerun-request.json")"
assert_eq "failed launch keeps task in ready" "ready" "$(jq -r '.tasks["HOK-2999_c"].phase' "$STATE_FILE")"

setup_case "publication-failure"
touch "$FEATURE_DIR/.needs-attention"
prior_json='{"stage":"review","status":"failed","artifacts":{"type":"review","prNumber":1378}}'
contract_json='{"stageRole":"review","agent":"claude","model":"claude-sonnet-5","provider":"anthropic"}'
if WRITE_STAGE_RESULT_FAIL=1 review_recovery_publish_running \
  "HOK-2999_c" "$FEATURE_DIR" "claude" "claude-sonnet-5" "anthropic" "1378" \
  "manual" "0" "$contract_json" "$prior_json"; then
  fail "failed result publication is reported"
else
  pass "failed result publication is reported"
fi
assert_eq "failed result publication leaves task in ready" "ready" "$(jq -r '.tasks["HOK-2999_c"].phase' "$STATE_FILE")"
assert_eq "failed result publication preserves ready attention" "present" "$([[ -f "$FEATURE_DIR/.needs-attention" ]] && printf present || printf missing)"

setup_case "duplicate"
cat > "$FEATURE_DIR/.review-result.json" <<'EOF'
{"stage":"review","status":"failed","artifacts":{"type":"review","prNumber":1378,"failureCategory":"review-tool-error","verdict":"error"}}
EOF
review_recovery_coordinator "HOK-2999_c" "slug" "Task" "$WT_DIR" "task/slug" "auto/integration" "1378" "$FEATURE_DIR" "test recovery" "manual" "manual" "" 0 "false"
review_recovery_coordinator "HOK-2999_c" "slug" "Task" "$WT_DIR" "task/slug" "auto/integration" "1378" "$FEATURE_DIR" "test recovery" "manual" "manual" "" 0 "false" || true
assert_eq "duplicate recovery launches at most once" "1" "$(wc -l < "$LAUNCH_LOG" | tr -d ' ')"

setup_case "timeout-classification"
cat > "$FEATURE_DIR/.review-result.json" <<'EOF'
{"stage":"review","status":"failed","agent":"native","model":"kimi-k3","artifacts":{"type":"review","failureCategory":"native-review-timeout","verdict":"error","reviewToolError":"Native review exceeded its wall-clock budget before producing a final JSON result.","effectiveNativeTimeoutMs":300000,"nativeTimeoutMaxMs":1200000,"nativeTimeoutMultiplier":2,"reviewInputDiffBytes":9000,"reviewInputTaskPacketBytes":1000,"reviewInputFileCount":4,"reviewExecutedIdentity":{"substantiveAnalysis":{"resolvedModel":"kimi-k3","agent":"native-openrouter"}}}}
EOF
if review_result_infra_failure "$FEATURE_DIR"; then
  pass "native-review-timeout is an infra review failure"
else
  fail "native-review-timeout is not an infra review failure"
fi
review_recovery_write_timeout_state "$FEATURE_DIR" "1" "native-review-timeout"
assert_eq "timeout retry writes doubled budget" "600000" "$(jq -r '.effectiveNativeTimeoutMs' "$FEATURE_DIR/.review-infra-recovery.json")"
identity="$(review_result_native_timeout_identity "$FEATURE_DIR")"
if [[ "$identity" == *"9000"* && "$identity" == *"kimi-k3"* ]]; then
  pass "timeout retry identity includes input size and reviewer"
else
  fail "timeout retry identity omits input size or reviewer"
fi

setup_case "timeout-exhaustion"
cat > "$FEATURE_DIR/.review-result.json" <<'EOF'
{"stage":"review","status":"failed","agent":"native","model":"kimi-k3","artifacts":{"type":"review","failureCategory":"native-review-timeout","verdict":"error","reviewToolError":"Native review exceeded its wall-clock budget before producing a final JSON result.","effectiveNativeTimeoutMs":1200000,"nativeTimeoutMaxMs":1200000,"nativeTimeoutMultiplier":2}}
EOF
bounded_retry_increment "$FEATURE_DIR" "review-infra-recovery" "same-head:native-review-timeout" >/dev/null
if review_recovery_coordinator "HOK-2999_c" "slug" "Task" "$WT_DIR" "task/slug" "auto/integration" "1378" "$FEATURE_DIR" "test recovery" "infra" "native-review-timeout" "same-head:native-review-timeout" 1 "false"; then
  fail "timeout exhaustion returns failure"
else
  pass "timeout exhaustion returns failure"
fi
assert_eq "timeout exhaustion aborts only challenger with typed reason" "HOK-2999_c|review|claude-sonnet-5|retry_exhausted:native-review-timeout|single" "$(cat "$CHALLENGE_ABORT_LOG")"
assert_eq "challenger exhaustion does not double-record selection outcome" "" "$(cat "$RECORD_OUTCOME_LOG")"

# Primary-side review-timeout exhaustion never aborts the pair, so it must feed
# the terminal outcome to selection health directly (HOK-3064).
setup_case "timeout-exhaustion-primary"
PRIMARY_CHALLENGE_ISSUE="HOK-2999"
TASK_PAIR_ID="HOK-2999"
cat > "$STATE_FILE" <<EOF
{"tasks":{"HOK-2999":{"phase":"ready","slug":"slug","worktree":"$WT_DIR","branch":"task/slug","provider":"openrouter","agent":"native-openrouter","model":"kimi-k2"}}}
EOF
cat > "$FEATURE_DIR/.review-result.json" <<'EOF'
{"stage":"review","status":"failed","agent":"native","model":"kimi-k2","artifacts":{"type":"review","failureCategory":"native-review-timeout","verdict":"error","reviewToolError":"Native review exceeded its wall-clock budget before producing a final JSON result.","effectiveNativeTimeoutMs":1200000,"nativeTimeoutMaxMs":1200000,"nativeTimeoutMultiplier":2}}
EOF
CONTRACT_AGENT="native-openrouter"
CONTRACT_MODEL="kimi-k2"
CONTRACT_PROVIDER="openrouter"
bounded_retry_increment "$FEATURE_DIR" "review-infra-recovery" "same-head:native-review-timeout" >/dev/null
if review_recovery_coordinator "HOK-2999" "slug" "Task" "$WT_DIR" "task/slug" "auto/integration" "1378" "$FEATURE_DIR" "test recovery" "infra" "native-review-timeout" "same-head:native-review-timeout" 1 "false"; then
  fail "primary timeout exhaustion returns failure"
else
  pass "primary timeout exhaustion returns failure"
fi
assert_eq "primary exhaustion records selection outcome with pair/reviewer" "HOK-2999|kimi-k2" "$(cat "$RECORD_OUTCOME_LOG")"
assert_eq "primary exhaustion does not abort the pair" "" "$(cat "$CHALLENGE_ABORT_LOG")"
unset PRIMARY_CHALLENGE_ISSUE TASK_PAIR_ID
CONTRACT_AGENT="claude"
CONTRACT_MODEL="claude-sonnet-5"
CONTRACT_PROVIDER="anthropic"

echo ""
echo "=== Native stage-failure envelope precedence (HOK-3064) ==="
ENV_CASE_DIR="$TMP_DIR/envelope-precedence"
mkdir -p "$ENV_CASE_DIR"
KIMI_DETAIL="Native review exceeded its wall-clock budget before producing a final JSON result."
# Without typed evidence, the Kimi wall-clock message matches no substring — the
# exact shape that previously degraded to native-unclassified (HOK-3052).
assert_eq "kimi timeout detail is unclassified without typed evidence" "native-unclassified" "$(native_terminal_failure_kind "$KIMI_DETAIL" "")"
cat > "$ENV_CASE_DIR/.review-failure-envelope.json" <<'EOF'
{"schemaVersion":"1.0","stage":"review","cause":"stage-timeout","stopReason":"wall_clock_limit","provider":"openrouter","model":"kimi-k2","agent":"native-openrouter","evidence":{"source":"native-runtime","detail":"Native review exceeded its wall-clock budget before producing a final JSON result."},"createdAt":"2026-09-22T00:00:00Z"}
EOF
ENVELOPE_JSON="$(TOOLS_DIR="$REAL_TOOLS_DIR" native_stage_failure_envelope_json "$ENV_CASE_DIR" "review")"
assert_eq "review envelope yields typed native-stage-timeout kind" "native-stage-timeout" "$(printf '%s' "$ENVELOPE_JSON" | jq -r '.failureKind')"
assert_eq "review envelope carries canonical provider identity" "openrouter" "$(printf '%s' "$ENVELOPE_JSON" | jq -r '.provider')"
assert_eq "review envelope carries canonical model identity" "kimi-k2" "$(printf '%s' "$ENVELOPE_JSON" | jq -r '.model')"

echo ""
echo "Passed: $PASS"
echo "Failed: $FAIL"
[[ "$FAIL" -eq 0 ]]
