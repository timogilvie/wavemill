#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"
COMMON_SCRIPT="$REPO_DIR/shared/lib/wavemill-common.sh"
ADAPTERS_SCRIPT="$REPO_DIR/shared/lib/agent-adapters.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

check_true() {
  local name="$1"
  shift
  if "$@"; then
    pass "$name"
  else
    fail "$name"
  fi
}

check_false() {
  local name="$1"
  shift
  if "$@"; then
    fail "$name"
  else
    pass "$name"
  fi
}

check_eq() {
  local name="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$name"
  else
    echo "    expected: $expected"
    echo "    actual:   $actual"
    fail "$name"
  fi
}

TEST_TMP="$(mktemp -d)"
TEST_SESSION="TESTREC$$"
trap 'rm -rf "$TEST_TMP"; rm -f /tmp/wavemill-'"$TEST_SESSION"'-*.hook /tmp/wavemill-'"$TEST_SESSION"'-*.exit 2>/dev/null || true' EXIT

extract_monitor_heredoc() {
  cat "$MONITOR_SCRIPT_FILE"
}

extract_function() {
  local source_file="$1"
  local function_name="$2"
  awk -v name="$function_name" '
    $0 ~ "^" name "\\(\\) \\{" { capture=1 }
    capture { print }
    capture && $0 == "}" { exit }
  ' "$source_file"
}

MONITOR_BODY="$TEST_TMP/monitor-body.sh"
extract_monitor_heredoc > "$MONITOR_BODY"

STATE_FILE="$TEST_TMP/workflow-state.json"
WORKTREE_ROOT="$TEST_TMP/worktrees"
mkdir -p "$WORKTREE_ROOT"
STAGE_WRITES=""

read_state_value() {
  local default="$1"
  shift
  jq -r "$@" "$STATE_FILE" 2>/dev/null || printf '%s\n' "$default"
}

# HOK-3190: the extracted recovery helpers call pass_task_field for per-pass
# cached reads; route the test shim through the existing read_state_value stub.
pass_task_field() {
  local issue="$1" field="$2" default="${3:-}"
  local v
  v=$(read_state_value "$default" --arg i "$issue" ".tasks[\$i].${field} // empty" 2>/dev/null)
  if [[ -z "$v" ]]; then
    printf '%s\n' "$default"
  else
    printf '%s\n' "$v"
  fi
}

state_mutate() {
  local file="$1" filter="$2"
  shift 2
  jq "$filter" "$@" "$file" > "$file.tmp"
  mv "$file.tmp" "$file"
}

get_task_meta() {
  jq -r --arg issue "$1" --arg field "$2" '.tasks[$issue][$field] // empty' "$STATE_FILE" 2>/dev/null || true
}

stage_result_field() {
  jq -r --arg f "$3" '.[$f] // empty' "$1/.${2}-result.json" 2>/dev/null || true
}

write_stage_result() {
  local feature_dir="$1" stage="$2" status="$3" agent="${4:-}" model="${5:-}" notes="${6:-}" artifacts="${7:-}"
  mkdir -p "$feature_dir"
  STAGE_WRITES+="$stage|$status|$notes"$'\n'
  jq -n \
    --arg stage "$stage" --arg status "$status" --arg agent "$agent" \
    --arg model "$model" --arg notes "$notes" --argjson artifacts "${artifacts:-null}" \
    '{stage:$stage,status:$status,agent:$agent,model:$model,notes:$notes,artifacts:$artifacts}' \
    > "$feature_dir/.${stage}-result.json"
}

challenge_abort_pair() {
  local issue="$1" feature_dir="$2" win="$3" stage="$4" model="$5" reason="$6" detail="$7"
  state_mutate "$STATE_FILE" \
    '.tasks[$issue].challengeAborted = $reason | .tasks[$issue].challengeAbortedDetail = $detail' \
    --arg issue "$issue" --arg reason "$reason" --arg detail "$detail" >/dev/null
  jq -n --arg reason "$reason" --arg stage "$stage" '{reason:$reason,stage:$stage}' > "$feature_dir/.challenge-aborted.json"
}

cleanup_quarantined_no_pr_challenge_arm() {
  CLEANUP_CALLS+="$1|$3|$4"$'\n'
  state_mutate "$STATE_FILE" 'del(.tasks[$issue])' --arg issue "$1" >/dev/null
}

seed_retry_challenge() {
  local issue="$1" slug="$2" phase="${3:-coding}"
  local worktree="$WORKTREE_ROOT/$slug"
  mkdir -p "$worktree/features/$slug"
  jq -n \
    --arg issue "$issue" --arg slug "$slug" --arg worktree "$worktree" --arg phase "$phase" \
    '{tasks:{($issue):{slug:$slug,branch:("task/" + $slug),worktree:$worktree,status:"active",phase:$phase,pr:"",challenge:true,challengeRole:"challenger",challengePairId:"HOK-PAIR"}}}' \
    > "$STATE_FILE"
  write_stage_result "$worktree/features/$slug" "$phase" "running" "codex" "gpt-test" ""
}

echo "=== Shared failure retry coverage ==="
# The persisted failed-stage route and bounded stage-failure budget are
# exercised behaviorally in tests/stage-failure-retry.test.sh.

echo "=== No-PR Guard Helpers ==="

# shellcheck source=/dev/null
source "$COMMON_SCRIPT"

gh() {
  if [[ "${1:-}" == "pr" && "${2:-}" == "list" ]]; then
    printf '123\n'
    return 0
  fi
  return 1
}
export -f gh
check_true "PR exists when gh returns a PR number" check_pr_exists "task/my-branch"

gh() {
  if [[ "${1:-}" == "pr" && "${2:-}" == "list" ]]; then
    printf '\n'
    return 0
  fi
  return 1
}
export -f gh
check_false "No PR when gh returns empty result" check_pr_exists "task/my-branch"

gh() {
  return 1
}
export -f gh
check_false "PR check gracefully handles gh failure" check_pr_exists "task/my-branch"
check_false "PR check rejects empty branch" check_pr_exists ""
unset -f gh

echo ""
echo "=== Hook Scripts ==="

CLAUDE_ISSUE="HOK-4"
WAVEMILL_SESSION="$TEST_SESSION" WAVEMILL_ISSUE="$CLAUDE_ISSUE" \
  bash "$REPO_DIR/shared/hooks/claude-status-hook.sh" <<'EOF'
{"hook_event_name":"StopFailure","error":{"type":"api_error","message":"Internal server error"}}
EOF
check_eq "claude hook records nested error message" "Internal server error" "$(jq -r '.detail' "/tmp/wavemill-${TEST_SESSION}-${CLAUDE_ISSUE}.hook")"

CODEX_ISSUE="HOK-5"
WAVEMILL_SESSION="$TEST_SESSION" WAVEMILL_ISSUE="$CODEX_ISSUE" \
  bash "$REPO_DIR/shared/hooks/codex-status-monitor.sh" <<'EOF'
{"type":"api_error","error":{"message":"Rate limit exceeded"}}
EOF
check_eq "codex hook records api errors" "error|Rate limit exceeded" "$(jq -r '.state + "|" + .detail' "/tmp/wavemill-${TEST_SESSION}-${CODEX_ISSUE}.hook")"

CODEX_CAPACITY_ISSUE="HOK-5A"
WAVEMILL_SESSION="$TEST_SESSION" WAVEMILL_ISSUE="$CODEX_CAPACITY_ISSUE" \
  bash "$REPO_DIR/shared/hooks/codex-status-monitor.sh" <<'EOF'
{"type":"api_error","error":{"message":"Selected model is at capacity. Please try a different model."}}
EOF
check_eq "codex hook classifies capacity errors" "error|model_at_capacity: Selected model is at capacity. Please try a different model." "$(jq -r '.state + "|" + .detail' "/tmp/wavemill-${TEST_SESSION}-${CODEX_CAPACITY_ISSUE}.hook")"
check_eq "codex hook rewrites capacity event" "model_capacity" "$(jq -r '.event' "/tmp/wavemill-${TEST_SESSION}-${CODEX_CAPACITY_ISSUE}.hook")"

CODEX_CAPACITY_OUTPUT_ISSUE="HOK-5B"
WAVEMILL_SESSION="$TEST_SESSION" WAVEMILL_ISSUE="$CODEX_CAPACITY_OUTPUT_ISSUE" \
  bash "$REPO_DIR/shared/hooks/codex-status-monitor.sh" <<'EOF'
{"type":"notification","message":"Selected model is at capacity. Please try a different model."}
{"type":"task_complete"}
EOF
check_eq "codex hook does not misclassify non-error capacity text" "idle|stream_end" "$(jq -r '.state + "|" + .event' "/tmp/wavemill-${TEST_SESSION}-${CODEX_CAPACITY_OUTPUT_ISSUE}.hook")"

CODEX_CRASH_ISSUE="HOK-7"
WAVEMILL_SESSION="$TEST_SESSION" WAVEMILL_ISSUE="$CODEX_CRASH_ISSUE" \
  bash "$REPO_DIR/shared/hooks/codex-status-monitor.sh" <<'EOF'
{"type":"response_item","payload":{"type":"function_call","function":{"name":"read_file"}}}
EOF
check_eq "codex unexpected eof writes error state" "error" "$(jq -r '.state' "/tmp/wavemill-${TEST_SESSION}-${CODEX_CRASH_ISSUE}.hook")"
check_eq "codex unexpected eof writes termination detail" "unexpected termination" "$(jq -r '.detail' "/tmp/wavemill-${TEST_SESSION}-${CODEX_CRASH_ISSUE}.hook")"

CODEX_COMPLETE_ISSUE="HOK-8"
WAVEMILL_SESSION="$TEST_SESSION" WAVEMILL_ISSUE="$CODEX_COMPLETE_ISSUE" \
  bash "$REPO_DIR/shared/hooks/codex-status-monitor.sh" <<'EOF'
{"type":"response_item","payload":{"type":"function_call","function":{"name":"read_file"}}}
{"type":"task_complete"}
EOF
check_eq "codex completion writes idle state" "idle" "$(jq -r '.state' "/tmp/wavemill-${TEST_SESSION}-${CODEX_COMPLETE_ISSUE}.hook")"
check_eq "codex completion ends as stream_end" "stream_end" "$(jq -r '.event' "/tmp/wavemill-${TEST_SESSION}-${CODEX_COMPLETE_ISSUE}.hook")"

CODEX_EMPTY_ISSUE="HOK-9"
WAVEMILL_SESSION="$TEST_SESSION" WAVEMILL_ISSUE="$CODEX_EMPTY_ISSUE" \
  bash "$REPO_DIR/shared/hooks/codex-status-monitor.sh" < /dev/null
check_eq "codex empty stream writes error state" "error" "$(jq -r '.state' "/tmp/wavemill-${TEST_SESSION}-${CODEX_EMPTY_ISSUE}.hook")"
check_eq "codex empty stream writes unexpected eof event" "unexpected_eof" "$(jq -r '.event' "/tmp/wavemill-${TEST_SESSION}-${CODEX_EMPTY_ISSUE}.hook")"

CODEX_EOF_STDERR_ISSUE="HOK-11"
CODEX_EOF_STDERR_LOG="$TEST_TMP/codex-eof-stderr.log"
printf '%s\n' 'apply_patch verification failed: expected lines not found' > "$CODEX_EOF_STDERR_LOG"
WAVEMILL_SESSION="$TEST_SESSION" WAVEMILL_ISSUE="$CODEX_EOF_STDERR_ISSUE" CODEX_STDERR_LOG="$CODEX_EOF_STDERR_LOG" \
  bash "$REPO_DIR/shared/hooks/codex-status-monitor.sh" < /dev/null
check_eq "codex eof with stderr keeps error state" "error" "$(jq -r '.state' "/tmp/wavemill-${TEST_SESSION}-${CODEX_EOF_STDERR_ISSUE}.hook")"
check_true "codex eof with stderr appends snippet to detail" grep -q 'unexpected termination: apply_patch verification failed' "/tmp/wavemill-${TEST_SESSION}-${CODEX_EOF_STDERR_ISSUE}.hook"

echo ""
echo "=== Generic Process Monitor ==="

PROCESS_ISSUE="HOK-6"
EXIT_FILE="/tmp/wavemill-${TEST_SESSION}-${PROCESS_ISSUE}.exit"
(
  sleep 0.2
  printf '7\n' > "$EXIT_FILE"
) &
WATCHER_PID=$!
WAVEMILL_PROCESS_STATUS_POLL_INTERVAL=1 WAVEMILL_SESSION="$TEST_SESSION" WAVEMILL_ISSUE="$PROCESS_ISSUE" \
  bash "$REPO_DIR/shared/hooks/process-status-monitor.sh" "$WATCHER_PID" "$EXIT_FILE"
check_eq "generic monitor surfaces wrapped exit codes" "error|exit_code:7" "$(jq -r '.state + "|" + .detail' "/tmp/wavemill-${TEST_SESSION}-${PROCESS_ISSUE}.hook")"

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
