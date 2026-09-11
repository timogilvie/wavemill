#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT="$REPO_DIR/shared/lib/wavemill-monitor.sh"
COMMON_SCRIPT="$REPO_DIR/shared/lib/wavemill-common.sh"

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
  review_recovery_clear_ready_handoff_state \
  review_recovery_publish_running \
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
read_stage_status() {
  local feature_dir="$1" stage="$2"
  jq -r '.status // empty' "$feature_dir/.${stage}-result.json" 2>/dev/null || true
}
write_stage_result_with_history() {
  local feature_dir="$1" stage="$2" status="$3" agent="${4:-}" model="${5:-}" notes="${6:-}" artifacts="${7:-{}}"
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
  mkdir -p "$FEATURE_DIR"
  : > "$LAUNCH_LOG"
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

setup_case "duplicate"
cat > "$FEATURE_DIR/.review-result.json" <<'EOF'
{"stage":"review","status":"failed","artifacts":{"type":"review","prNumber":1378,"failureCategory":"review-tool-error","verdict":"error"}}
EOF
review_recovery_coordinator "HOK-2999_c" "slug" "Task" "$WT_DIR" "task/slug" "auto/integration" "1378" "$FEATURE_DIR" "test recovery" "manual" "manual" "" 0 "false"
review_recovery_coordinator "HOK-2999_c" "slug" "Task" "$WT_DIR" "task/slug" "auto/integration" "1378" "$FEATURE_DIR" "test recovery" "manual" "manual" "" 0 "false" || true
assert_eq "duplicate recovery launches at most once" "1" "$(wc -l < "$LAUNCH_LOG" | tr -d ' ')"

echo ""
echo "Passed: $PASS"
echo "Failed: $FAIL"
[[ "$FAIL" -eq 0 ]]
