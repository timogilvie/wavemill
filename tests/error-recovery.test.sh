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
trap 'rm -rf "$TEST_TMP"; rm -f /tmp/wavemill-'"$TEST_SESSION"'-*.hook /tmp/wavemill-'"$TEST_SESSION"'-*.retry /tmp/wavemill-'"$TEST_SESSION"'-*.exit 2>/dev/null || true' EXIT

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

RECOVERY_FUNCS="$TEST_TMP/recovery-funcs.sh"
{
  echo 'log() { :; }'
  echo 'log_warn() { :; }'
  echo 'log_error() { :; }'
  echo "SESSION='$TEST_SESSION'"
  for fn in \
    is_transient_error \
    retry_state_file \
    get_retry_count \
    get_retry_timestamp \
    increment_retry_count \
    reset_retry_count \
    get_backoff_delay \
    terminalize_transient_retry_failure \
    handle_agent_error_recovery \
    transient_error_recovery_pending \
  ; do
    extract_function "$MONITOR_BODY" "$fn"
    echo
  done
} > "$RECOVERY_FUNCS"

# shellcheck source=/dev/null
source "$RECOVERY_FUNCS"

STATE_FILE="$TEST_TMP/workflow-state.json"
WORKTREE_ROOT="$TEST_TMP/worktrees"
mkdir -p "$WORKTREE_ROOT"
CLEANUP_CALLS=""
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

echo "=== Error Recovery Helpers ==="

check_true "classifies 500 as transient" is_transient_error 'API Error: 500 Internal server error'
check_true "classifies 429 as transient" is_transient_error 'Rate limit: 429 Too Many Requests'
check_false "classifies 401 as permanent" is_transient_error 'API Error: 401 Unauthorized'
check_false "classifies empty detail as permanent" is_transient_error ''

check_eq "retry count defaults to zero" "0" "$(get_retry_count "$TEST_SESSION" "HOK-1")"
increment_retry_count "$TEST_SESSION" "HOK-1"
check_eq "retry count increments" "1" "$(get_retry_count "$TEST_SESSION" "HOK-1")"
check_true "retry timestamp recorded" test "$(get_retry_timestamp "$TEST_SESSION" "HOK-1")" -gt 0
reset_retry_count "$TEST_SESSION" "HOK-1"
check_eq "retry count resets" "0" "$(get_retry_count "$TEST_SESSION" "HOK-1")"

check_eq "backoff 1" "30" "$(get_backoff_delay 1)"
check_eq "backoff 2" "60" "$(get_backoff_delay 2)"
check_eq "backoff 3" "120" "$(get_backoff_delay 3)"
check_eq "backoff max" "240" "$(get_backoff_delay 4)"

cat > "/tmp/wavemill-${TEST_SESSION}-HOK-2.hook" <<EOF
{"state":"error","detail":"API Error: 500","timestamp":$(date +%s)}
EOF
check_true "pending recovery while retries remain" transient_error_recovery_pending "HOK-2"
for _ in 1 2 3 4; do
  increment_retry_count "$TEST_SESSION" "HOK-2"
done
check_false "no pending recovery after max retries" transient_error_recovery_pending "HOK-2"
reset_retry_count "$TEST_SESSION" "HOK-2"

seed_retry_challenge "HOK-20_c" "retry-exhausted-challenger" "coding"
for _ in 1 2 3 4; do
  increment_retry_count "$TEST_SESSION" "HOK-20_c"
done
jq -n --argjson count 4 --argjson timestamp "$(($(date +%s) - 60))" \
  '{count:$count,timestamp:$timestamp}' > "$(retry_state_file "$TEST_SESSION" "HOK-20_c")"
cat > "/tmp/wavemill-${TEST_SESSION}-HOK-20_c.hook" <<EOF
{"state":"error","detail":"API Error: 500","timestamp":$(date +%s)}
EOF
CLEANUP_CALLS=""
handle_agent_error_recovery "HOK-20_c" "codex"
check_eq "retry exhaustion removes challenge state" "false" "$(jq -r '.tasks | has("HOK-20_c")' "$STATE_FILE")"
check_eq "retry exhaustion writes failed coding result" "failed" "$(jq -r '.status' "$WORKTREE_ROOT/retry-exhausted-challenger/features/retry-exhausted-challenger/.coding-result.json")"
check_true "retry exhaustion schedules cleanup" test -n "$CLEANUP_CALLS"
reset_retry_count "$TEST_SESSION" "HOK-20_c"

seed_retry_challenge "HOK-21_c" "retry-stalled-challenger" "coding"
cat > "/tmp/wavemill-${TEST_SESSION}-HOK-21_c.hook" <<EOF
{"state":"error","detail":"API Error: 500","timestamp":$(($(date +%s) - 3600))}
EOF
increment_retry_count "$TEST_SESSION" "HOK-21_c"
CLEANUP_CALLS=""
handle_agent_error_recovery "HOK-21_c" "codex"
check_eq "stale retry process removes challenge state" "false" "$(jq -r '.tasks | has("HOK-21_c")' "$STATE_FILE")"
check_true "stale retry process schedules cleanup" test -n "$CLEANUP_CALLS"
reset_retry_count "$TEST_SESSION" "HOK-21_c"

# HOK-2885: a native agent is a single process that exits on failure — there is
# no live TUI to resume into. The send-keys recovery path must no-op so it
# cannot burn the retry budget or race the challenger phase-relaunch machinery.
seed_retry_challenge "HOK-22_c" "native-guard-challenger" "coding"
cat > "/tmp/wavemill-${TEST_SESSION}-HOK-22_c.hook" <<EOF
{"state":"error","agent":"native","detail":"API Error: 500","timestamp":$(date +%s)}
EOF
CLEANUP_CALLS=""
handle_agent_error_recovery "HOK-22_c" "native"
check_eq "native error hook leaves challenge state intact" "true" "$(jq -r '.tasks | has("HOK-22_c")' "$STATE_FILE")"
check_eq "native error hook does not consume the retry counter" "0" "$(get_retry_count "$TEST_SESSION" "HOK-22_c")"
check_true "native error hook schedules no cleanup" test -z "$CLEANUP_CALLS"
check_false "native error hook is not held pending by TUI recovery" transient_error_recovery_pending "HOK-22_c"
rm -f "/tmp/wavemill-${TEST_SESSION}-HOK-22_c.hook"

echo ""
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
echo "=== Resume Adapter ==="

FAKE_BIN="$TEST_TMP/bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/tmux" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-}"
shift || true
case "$cmd" in
  list-windows)
    printf '%s\n' "${TMUX_WINDOW_NAME:-}"
    ;;
  list-panes)
    if [[ "$*" == *"#{pane_dead}"* ]]; then
      printf '%s\n' "${TMUX_PANE_DEAD:-0}"
    fi
    ;;
  display-message)
    if [[ "$*" == *"#{pane_pid}"* ]]; then
      printf '%s\n' "${TMUX_PANE_PID:-4242}"
    elif [[ "$*" == *"#{pane_current_command}"* ]]; then
      printf '%s\n' "${TMUX_CURRENT_COMMAND:-bash}"
    elif [[ "$*" == *"#{pane_current_path}"* ]]; then
      printf '%s\n' "${TMUX_CURRENT_PATH:-$PWD}"
    fi
    ;;
  capture-pane)
    printf '%s' "${TMUX_CAPTURE_TAIL:-}"
    ;;
  send-keys|respawn-pane)
    printf '%s %s\n' "$cmd" "$*" >> "${TMUX_LOG:?}"
    ;;
esac
EOF
cat > "$FAKE_BIN/pgrep" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
count="${TMUX_CHILD_COUNT:-0}"
if (( count > 0 )); then
  seq 1 "$count"
else
  exit 1
fi
EOF
cat > "$FAKE_BIN/claude" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "--help" ]]; then
  printf '%s\n' "${CLAUDE_HELP_TEXT:-usage: claude --resume}"
fi
EOF
chmod +x "$FAKE_BIN/tmux" "$FAKE_BIN/pgrep" "$FAKE_BIN/claude"

PATH="$FAKE_BIN:$PATH"

# shellcheck source=/dev/null
source "$ADAPTERS_SCRIPT"

TMUX_WINDOW_NAME="HOK-3-test-slug"
TMUX_PANE_DEAD=0
TMUX_PANE_PID=4242
TMUX_LOG="$TEST_TMP/tmux-ready.log"
TMUX_CURRENT_COMMAND="bash"
TMUX_CHILD_COUNT=0
CLAUDE_HELP_TEXT="usage: claude --resume"
export TMUX_WINDOW_NAME TMUX_PANE_DEAD TMUX_PANE_PID TMUX_LOG TMUX_CURRENT_COMMAND TMUX_CHILD_COUNT CLAUDE_HELP_TEXT
: > "$TMUX_LOG"
check_true "claude shell resume succeeds" agent_resume_after_error "sess" "HOK-3" "claude"
check_true "claude uses --resume from shell" grep -q 'claude --resume' "$TMUX_LOG"

# Fast tunables for the confirmed-send helper so tests don't wait 3s per attempt.
WAVEMILL_PANE_MESSAGE_ATTEMPTS=2
WAVEMILL_PANE_MESSAGE_CONFIRM_WAIT=1
WAVEMILL_PANE_MESSAGE_POLL=0.05
WAVEMILL_PANE_MESSAGE_ENTER_DELAY=0.05
WAVEMILL_PANE_MESSAGE_RETRY_DELAY=0.05
export WAVEMILL_PANE_MESSAGE_ATTEMPTS WAVEMILL_PANE_MESSAGE_CONFIRM_WAIT WAVEMILL_PANE_MESSAGE_POLL WAVEMILL_PANE_MESSAGE_ENTER_DELAY WAVEMILL_PANE_MESSAGE_RETRY_DELAY

TMUX_LOG="$TEST_TMP/tmux-busy.log"
TMUX_CURRENT_COMMAND="claude"
TMUX_CHILD_COUNT=1
# Submitted-tail: echo of the prompt above an empty input line — confirmed_delivery=true.
TMUX_CAPTURE_TAIL=$'──────\n❯ The previous attempt encountered a transient API error. Please continue working on the task from where you left off.\n──────\n❯ '
export TMUX_LOG TMUX_CURRENT_COMMAND TMUX_CHILD_COUNT TMUX_CAPTURE_TAIL
: > "$TMUX_LOG"
check_true "busy agent resume succeeds" agent_resume_after_error "sess" "HOK-3" "claude"
check_true "busy agent gets continuation prompt" grep -q 'Please continue working on the task from where you left off' "$TMUX_LOG"
check_false "busy agent does not inject shell resume command" grep -q 'claude --resume' "$TMUX_LOG"

# HOK-2765: stranded tail — prompt text still sitting in the input line, never submitted.
# The confirmed-send helper must return non-zero and agent_resume_after_error must surface it.
TMUX_LOG="$TEST_TMP/tmux-busy-stranded.log"
TMUX_CAPTURE_TAIL=$'──────\n❯ The previous attempt encountered a transient API error. Please continue working on the task from where you left off.\n──────'
export TMUX_LOG TMUX_CAPTURE_TAIL
: > "$TMUX_LOG"
check_false "busy agent resume fails on stranded pane" agent_resume_after_error "sess" "HOK-3" "claude"
unset TMUX_CAPTURE_TAIL

AUTONOMOUS_ISSUE="HOK-10"
AUTONOMOUS_INSTR="$TEST_TMP/autonomous-instructions.txt"
AUTONOMOUS_LAUNCHER="/tmp/sess-${AUTONOMOUS_ISSUE}-autonomous-launcher.sh"
printf 'test instructions\n' > "$AUTONOMOUS_INSTR"
rm -f "$AUTONOMOUS_LAUNCHER"
TMUX_LOG="$TEST_TMP/tmux-autonomous.log"
export TMUX_LOG
: > "$TMUX_LOG"
check_true "codex autonomous launch succeeds" agent_launch_autonomous "sess" "window" "$AUTONOMOUS_INSTR" "codex" "gpt-5.6-terra" "$AUTONOMOUS_ISSUE"
check_true "codex autonomous writes launcher script" test -f "$AUTONOMOUS_LAUNCHER"
check_true "codex autonomous launcher uses human readable exec" grep -q 'codex exec --model gpt-5.6-terra --dangerously-bypass-approvals-and-sandbox - < ' "$AUTONOMOUS_LAUNCHER"
check_false "codex autonomous launcher does not request json output" grep -q -- '--json' "$AUTONOMOUS_LAUNCHER"
check_false "codex autonomous launcher does not redirect stderr" grep -q '2>"\$stderr_log"' "$AUTONOMOUS_LAUNCHER"
check_false "codex autonomous launcher does not pipe through monitor" grep -q 'codex-status-monitor\.sh' "$AUTONOMOUS_LAUNCHER"
check_true "codex autonomous launcher reports completion hook" grep -q "wavemill_hook_write 'idle' 'process_exit'" "$AUTONOMOUS_LAUNCHER"
check_true "codex autonomous launcher reports error hook" grep -q "wavemill_hook_write 'error' 'process_exit'" "$AUTONOMOUS_LAUNCHER"
check_true "codex autonomous launcher logs single exit code to status log" grep -q 'codex exit code codex=' "$AUTONOMOUS_LAUNCHER"
check_false "codex autonomous launcher avoids pipeline status" grep -q 'PIPESTATUS' "$AUTONOMOUS_LAUNCHER"
check_true "codex autonomous dispatches guarded launcher path via tmux -l" grep -q 'send-keys .* -l -- .* /tmp/sess-HOK-10-autonomous-launcher\.sh' "$TMUX_LOG"
check_true "codex autonomous dispatches enter key after launcher" grep -q 'send-keys .* C-m' "$TMUX_LOG"

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
