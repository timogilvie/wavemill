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

now_ms() {
  perl -MTime::HiRes=time -e 'printf("%.0f\n", time() * 1000)'
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

assert_true() {
  local label="$1"
  if ! eval "$2"; then
    echo "FAIL: $label"
    exit 1
  fi
}

SESSION="monitor-command-drain-test"
STATE_FILE="$TMP_DIR/state.json"
COMMAND_FILE="$(bash -lc "source '$COMMON_SCRIPT'; wavemill_command_file_path '$SESSION'")"

cat > "$STATE_FILE" <<'EOF'
{
  "monitorCommandOffset": 0,
  "monitorDeferredCommands": [],
  "tasks": {}
}
EOF
rm -f "$COMMAND_FILE"

source "$COMMON_SCRIPT"

HEREDOC_CONTENT="$(cat "$MONITOR_SCRIPT_FILE")"

FUNCS_FILE="$TMP_DIR/monitor-funcs.sh"
: > "$FUNCS_FILE"
for fn in \
  monitor_command_timestamp \
  read_command_file_line_count \
  read_command_offset \
  write_command_offset \
  highest_pending_command_offset \
  queue_command_event \
  requeue_consumed_command_front \
  acknowledge_command_offset \
  monitor_list_deferred_commands \
  monitor_remove_deferred_command \
  monitor_defer_command \
  drain_command_events \
  consume_next_command \
  invalidate_backlog_prompt_state \
  launch_selected_task_lines \
  handle_enter_command \
  handle_select_command \
  execute_or_defer_monitor_command \
  process_new_monitor_commands \
  process_deferred_monitor_commands \
  poll_sleep
do
  extracted="$(extract_function <(printf '%s\n' "$HEREDOC_CONTENT") "$fn")"
  if [[ -z "$extracted" ]]; then
    echo "FAIL: missing extracted function $fn"
    exit 1
  fi
  printf '%s\n\n' "$extracted" >> "$FUNCS_FILE"
done
source "$FUNCS_FILE"

WATCHDOG_FUNCS_FILE="$TMP_DIR/watchdog-funcs.sh"
: > "$WATCHDOG_FUNCS_FILE"
for fn in ready_watchdog_config_json run_ready_watchdog_tick; do
  extracted="$(extract_function "$MONITOR_SCRIPT_FILE" "$fn")"
  if [[ -z "$extracted" ]]; then
    echo "FAIL: missing extracted function $fn"
    exit 1
  fi
  printf '%s\n\n' "$extracted" >> "$WATCHDOG_FUNCS_FILE"
done
source "$WATCHDOG_FUNCS_FILE"

log() { :; }
log_warn() { :; }
clear_task_list_display() { :; }
batch_route_selected_tasks() { return 0; }
launch_task() { LAST_LAUNCHED_SLOTS=0; }
invoke_first_wave_helper() { return 1; }
ready_watchdog_config_json() { echo '{"enabled":true,"timeoutSeconds":30}'; }
_with_timeout() { return 1; }
TOOLS_DIR="$REPO_DIR/tools"
REPO_DIR="$REPO_DIR"
watchdog_warned=0
watchdog_warning=""
READY_WATCHDOG_FAILURE_LOG_INTERVAL=60
LAST_READY_WATCHDOG_FAILURE_DETAIL=""
LAST_READY_WATCHDOG_FAILURE_AT=0
log_warn() { watchdog_warned=$((watchdog_warned + 1)); watchdog_warning="$*"; }

run_ready_watchdog_tick
run_ready_watchdog_tick
assert_eq "failed watchdog tick is diagnosed and rate-limited" "1" "$watchdog_warned"
assert_true "failed watchdog warning includes a reason" "[[ \"$watchdog_warning\" == *'command exited non-zero'* ]]"

log_warn() { :; }

POLL_SECONDS=10
COMMAND_QUEUE=()
COMMAND_QUEUE_OFFSETS=()
COMMAND_OFFSET_WARNED=false
REPLY=""
REPLY_OFFSET=""
LAST_BACKLOG_FETCH=0
LAST_DISPLAY=""
LAST_WAITING_MSG=""
SELECT_SHOW_ALL=false
USING_GROUPED_VIEW=false
TASK_LIST_RENDERED=0
LAST_COMMAND_LAUNCHED_SLOTS=0
REMAINING_FREE_SLOTS=0

compare_done_file="$TMP_DIR/compare.done"
rm -f "$compare_done_file"
(
  sleep 3
  now_ms > "$compare_done_file"
) &
compare_pid=$!

sleep 1
printf 'select 1 2\n' >> "$COMMAND_FILE"
drain_command_events
process_new_monitor_commands 0 "" "" "" ""
handled_at="$(now_ms)"

wait "$compare_pid"
comparison_done_at="$(cat "$compare_done_file")"

assert_true "drain/handle happens before comparison completes" "[[ $handled_at -lt $comparison_done_at ]]"
assert_eq "durable offset advances after deferred command" "1" "$(jq -r '.monitorCommandOffset' "$STATE_FILE")"
assert_eq "selection is explicitly deferred while slots are full" "select 1 2|no_slots_available" \
  "$(jq -r '.monitorDeferredCommands[0] | "\(.event)|\(.reason)"' "$STATE_FILE")"

COMMAND_QUEUE=()
COMMAND_QUEUE_OFFSETS=()
drain_command_events
if consume_next_command; then
  echo "FAIL: consumed commands replayed after restart simulation"
  exit 1
fi

printf 'select 9\n' >> "$COMMAND_FILE"
drain_command_events
assert_eq "new command is buffered before ack" "1" "${#COMMAND_QUEUE[@]}"
assert_eq "offset stays on last acknowledged line before processing" "1" "$(jq -r '.monitorCommandOffset' "$STATE_FILE")"

COMMAND_QUEUE=()
COMMAND_QUEUE_OFFSETS=()
drain_command_events
assert_eq "unacknowledged command is drained again after restart simulation" "1" "${#COMMAND_QUEUE[@]}"
process_new_monitor_commands 0 "" "" "" ""
assert_eq "offset advances once re-drained command is handled" "2" "$(jq -r '.monitorCommandOffset' "$STATE_FILE")"

printf 'select 3\n' >> "$COMMAND_FILE"
COMMAND_QUEUE=()
COMMAND_QUEUE_OFFSETS=()
drain_command_events
process_new_monitor_commands 0 "" "" "" ""
assert_eq "later commands after the durable offset are not skipped" "3" "$(jq -r '.monitorCommandOffset' "$STATE_FILE")"
assert_eq "deferred command list keeps distinct queued selections" "3" "$(jq -r '(.monitorDeferredCommands // []) | length' "$STATE_FILE")"

COMMAND_QUEUE=("select 4")
COMMAND_QUEUE_OFFSETS=()
if consume_next_command; then
  echo "FAIL: consumed malformed command queue without an offset"
  exit 1
fi
assert_eq "malformed command queue is cleared without set -u crash" "0" "${#COMMAND_QUEUE[@]}"

# A bare Enter must never launch work unless taskSelection.enterAction=wave,
# and must not be deferred to fire later when slots free up.
for enter_action in none top-scored ""; do
  ENTER_ACTION="$enter_action"
  [[ -z "$enter_action" ]] && unset ENTER_ACTION
  for slots in 0 3; do
    handle_enter_command "enter" "$slots" '{"availableNow":["HOK-1"]}' "HOK-1|slug|title" ""
    assert_eq "enter (action=${enter_action:-unset}, slots=$slots) is refused" "invalid" "$MONITOR_COMMAND_STATUS"
    assert_eq "enter (action=${enter_action:-unset}, slots=$slots) is not deferred" "" "$MONITOR_COMMAND_DEFER_EVENT"
  done
done
ENTER_ACTION=wave
handle_enter_command "enter" 0 '{"availableNow":["HOK-1"]}' "HOK-1|slug|title" ""
assert_eq "enter with action=wave still defers while slots are full" "deferred" "$MONITOR_COMMAND_STATUS"
unset ENTER_ACTION

rm -f "$COMMAND_FILE"
echo "PASS: monitor drains and persists commands independently of long-running lifecycle work"
