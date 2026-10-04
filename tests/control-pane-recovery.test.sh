#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_SRC="$REPO_DIR/shared/lib/wavemill-monitor.sh"
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

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "FAIL: $label"
    echo "  missing: $needle"
    exit 1
  fi
}

assert_not_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "FAIL: $label"
    echo "  unexpected: $needle"
    exit 1
  fi
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

source "$COMMON_SCRIPT"

FUNCS_FILE="$TMP_DIR/control-pane-functions.sh"
: > "$FUNCS_FILE"
for fn in \
  classify_control_pane_input_path \
  probe_control_pane_input_path \
  recover_control_pane_input_path \
  check_mill_pane_health \
  handle_monitor_quit_command
do
  extracted="$(extract_function "$MONITOR_SCRIPT_SRC" "$fn")"
  if [[ -z "$extracted" ]]; then
    echo "FAIL: missing extracted function $fn"
    exit 1
  fi
  printf '%s\n\n' "$extracted" >> "$FUNCS_FILE"
done
source "$FUNCS_FILE"

SESSION="control-pane-test"
WAVEMILL_WINDOW_MILL="mill"
LIB_DIR="$REPO_DIR/shared/lib"
WORKTREE_ROOT="$TMP_DIR/worktrees"
STATE_FILE="$TMP_DIR/state.json"
STATUS_LOG_FILE="$TMP_DIR/status.log"
MONITOR_SCRIPT="/tmp/${SESSION}-monitor.sh"
MONITOR_ENV="/tmp/${SESSION}-monitor.env"
DASHBOARD_HEALTH_INTERVAL=0
LAST_DASHBOARD_HEALTH_CHECK=0
LAST_CONTROL_PANE_HEALTH_STATUS=""
QUIT_REQUESTED=false
LAST_QUIT_MESSAGE=""
LOG_OUTPUT=""
WARN_OUTPUT=""
TMUX_LOG="$TMP_DIR/tmux.log"
# Because pane_count=$(tmux ...) runs the mocked tmux inside a subshell, any
# in-memory queue we mutate there is lost. Persist the queue as a file so
# successive list-panes calls (before/after the reconstruction splits) can
# return different values from the same check_mill_pane_health() invocation.
TMUX_PANE_COUNT_QUEUE_FILE="$TMP_DIR/pane-count-queue"
TMUX_DEAD_PANES_OUTPUT=$'0 0\n1 0\n2 0\n'
TMUX_DISPLAY_MESSAGE_OUTPUT=""
TMUX_DISPLAY_MESSAGE_RC=0
TMUX_RESPAWN_RC=0

# Reset the queue with one integer per list-panes call. Each argument is the
# pane count that list-panes -F '#{pane_index}' should report on that call
# (the mock synthesizes one index per line). When the queue empties the last
# value is repeated so late probes keep observing a stable three-pane layout.
set_pane_count_queue() {
  : > "$TMUX_PANE_COUNT_QUEUE_FILE"
  local entry
  for entry in "$@"; do
    printf '%s\n' "$entry" >> "$TMUX_PANE_COUNT_QUEUE_FILE"
  done
}

# Pop the next queued pane count and print list-panes output that produces
# exactly that many lines under `wc -l`. Rewrites the file without the head
# entry, keeping the tail entry if it would otherwise be the last remaining
# value.
pop_pane_count() {
  [[ -s "$TMUX_PANE_COUNT_QUEUE_FILE" ]] || return 0
  local head count remaining
  head="$(head -n 1 "$TMUX_PANE_COUNT_QUEUE_FILE")"
  count="$(wc -l < "$TMUX_PANE_COUNT_QUEUE_FILE" | tr -d ' ')"
  if (( count > 1 )); then
    remaining="$(tail -n +2 "$TMUX_PANE_COUNT_QUEUE_FILE")"
    printf '%s\n' "$remaining" > "$TMUX_PANE_COUNT_QUEUE_FILE"
  fi
  local i
  for (( i = 0; i < head; i++ )); do
    printf '%d\n' "$i"
  done
}

log() {
  local level="info"
  if [[ "${1:-}" == "error" || "${1:-}" == "status" || "${1:-}" == "info" || "${1:-}" == "debug" ]]; then
    shift
  fi
  LOG_OUTPUT+="$*"$'\n'
}

log_warn() {
  WARN_OUTPUT+="$*"$'\n'
}

sleep() { :; }

quit_and_kill_session() {
  LAST_QUIT_MESSAGE="${1:-}"
}

tmux() {
  printf 'tmux %s\n' "$*" >> "$TMUX_LOG"
  case "$1" in
    list-panes)
      if [[ "$*" == *"#{pane_index} #{pane_dead}"* ]]; then
        printf '%s' "$TMUX_DEAD_PANES_OUTPUT"
      elif [[ "$*" == *"#{pane_pid}"* ]]; then
        printf '%s' ""
      else
        pop_pane_count
      fi
      ;;
    display-message)
      printf '%s\n' "$TMUX_DISPLAY_MESSAGE_OUTPUT"
      return "$TMUX_DISPLAY_MESSAGE_RC"
      ;;
    respawn-pane)
      return "$TMUX_RESPAWN_RC"
      ;;
    split-window|set-environment|select-pane|kill-pane)
      return 0
      ;;
    *)
      echo "FAIL: unexpected tmux invocation: $*" >&2
      exit 1
      ;;
  esac
}

healthy_probe="%0 123 bash bash -lc clear\\; /tmp/${SESSION}-monitor.sh /tmp/${SESSION}-monitor.env \\< /dev/null \\& exec env WAVEMILL_SESSION=${SESSION} ${LIB_DIR}/wavemill-input-reader.sh ${SESSION}"
drift_probe="%0 123 bash bash /tmp/${SESSION}-monitor.sh /tmp/${SESSION}-monitor.env"

assert_eq "classifies input-reader pane as healthy" "healthy" \
  "$(classify_control_pane_input_path "$healthy_probe" "$SESSION")"
assert_eq "classifies direct monitor pane as drifted" "drifted-monitor" \
  "$(classify_control_pane_input_path "$drift_probe" "$SESSION")"
assert_eq "classifies empty probe as unknown" "unknown" \
  "$(classify_control_pane_input_path "" "$SESSION")"

startup_cmd="$(wavemill_build_control_pane_command startup "$SESSION" "$MONITOR_SCRIPT" "$MONITOR_ENV" "$LIB_DIR")"
recovery_cmd="$(wavemill_build_control_pane_command recovery "$SESSION" "$MONITOR_SCRIPT" "$MONITOR_ENV" "$LIB_DIR")"
assert_contains "startup wrapper resets the command file" "$startup_cmd" ":\\ \\>\\ /tmp/wavemill-${SESSION}-commands"
assert_contains "startup wrapper resets the offset file" "$startup_cmd" "commands.offset"
assert_not_contains "recovery wrapper preserves the command file" "$recovery_cmd" ":\\ \\>\\ /tmp/wavemill-${SESSION}-commands"
assert_not_contains "recovery wrapper preserves the offset file" "$recovery_cmd" "printf\\ \'0"

# ---- one-pane recovery: preserve the live monitor as pane 0 ----------------
: > "$TMUX_LOG"
WARN_OUTPUT=""
LOG_OUTPUT=""
LAST_DASHBOARD_HEALTH_CHECK=0
LAST_CONTROL_PANE_HEALTH_STATUS=""
# First list-panes call returns one pane; after the two split-window calls the
# re-count sees three panes.
set_pane_count_queue 1 3
TMUX_DEAD_PANES_OUTPUT=$'0 0\n1 0\n2 0\n'
TMUX_DISPLAY_MESSAGE_OUTPUT="$healthy_probe"
TMUX_DISPLAY_MESSAGE_RC=0
TMUX_RESPAWN_RC=0
check_mill_pane_health
tmux_output="$(cat "$TMUX_LOG")"

split_lines="$(grep 'split-window' "$TMUX_LOG" || true)"
split_count="$(printf '%s\n' "$split_lines" | grep -c 'split-window' || true)"
assert_eq "one-pane recovery issues exactly two split-window calls" "2" "$split_count"

first_split="$(printf '%s\n' "$split_lines" | sed -n '1p')"
second_split="$(printf '%s\n' "$split_lines" | sed -n '2p')"

assert_contains "first split targets pane 0 with -v -p 65 (startup order)" "$first_split" "split-window -t ${SESSION}:${WAVEMILL_WINDOW_MILL}.0 -v -p 65"
assert_not_contains "first split does not use -b (would renumber monitor)" "$first_split" "-b"
assert_not_contains "first split does not use -hb (regression guard)" "$first_split" "-hb"

assert_contains "second split targets pane 0 with -h -f -p 50 (startup order)" "$second_split" "split-window -t ${SESSION}:${WAVEMILL_WINDOW_MILL}.0 -h -f -p 50"
assert_not_contains "second split does not use -b" "$second_split" "-b"
assert_not_contains "second split does not use -hb (regression guard)" "$second_split" "-hb"

# The surviving monitor (pane 0) must NOT be respawned during the one-pane
# reconstruction branch. Only panes 1 and 2 (dashboard + log) may be respawned.
reconstruction_output="$(sed -n '/split-window/,$p' "$TMUX_LOG")"
respawn_zero="$(printf '%s\n' "$reconstruction_output" | grep -E "respawn-pane .* -t ${SESSION}:${WAVEMILL_WINDOW_MILL}\\.0( |\$)" || true)"
assert_eq "one-pane recovery never respawns pane 0" "" "$respawn_zero"

assert_contains "one-pane recovery respawns pane 1 as dashboard" "$tmux_output" "respawn-pane -k -t ${SESSION}:${WAVEMILL_WINDOW_MILL}.1"
assert_contains "one-pane recovery respawns pane 2 as log" "$tmux_output" "respawn-pane -k -t ${SESSION}:${WAVEMILL_WINDOW_MILL}.2"

assert_contains "one-pane recovery warns about rebuild" "$WARN_OUTPUT" "Control window has 1 pane"
assert_contains "one-pane recovery logs successful rebuild" "$LOG_OUTPUT" "Control panes rebuilt successfully"

# ---- drift recovery: healthy 3-pane layout, direct-monitor drift on pane 0 --
: > "$TMUX_LOG"
WARN_OUTPUT=""
LOG_OUTPUT=""
LAST_DASHBOARD_HEALTH_CHECK=0
LAST_CONTROL_PANE_HEALTH_STATUS=""
set_pane_count_queue 3
TMUX_DISPLAY_MESSAGE_OUTPUT="$drift_probe"
TMUX_DISPLAY_MESSAGE_RC=0
TMUX_RESPAWN_RC=0
check_mill_pane_health
tmux_output="$(cat "$TMUX_LOG")"
assert_contains "drift recovery respawns pane 0" "$tmux_output" "respawn-pane -k -t ${SESSION}:${WAVEMILL_WINDOW_MILL}.0"
assert_contains "drift recovery warns once" "$WARN_OUTPUT" "Control pane drift detected"
respawn_line="$(grep "respawn-pane -k -t ${SESSION}:${WAVEMILL_WINDOW_MILL}.0" "$TMUX_LOG")"
assert_not_contains "recovery respawn does not truncate the command file" "$respawn_line" ":\\ \\>\\ /tmp/wavemill-${SESSION}-commands"
assert_not_contains "recovery respawn does not reset offset to zero" "$respawn_line" "printf\\ \'0"

: > "$TMUX_LOG"
WARN_OUTPUT=""
LAST_DASHBOARD_HEALTH_CHECK=0
LAST_CONTROL_PANE_HEALTH_STATUS=""
set_pane_count_queue 3
TMUX_DISPLAY_MESSAGE_OUTPUT="$healthy_probe"
check_mill_pane_health
tmux_output="$(cat "$TMUX_LOG")"
assert_not_contains "healthy pane does not respawn pane 0" "$tmux_output" "respawn-pane -k -t ${SESSION}:${WAVEMILL_WINDOW_MILL}.0"
assert_eq "healthy pane emits no warning" "" "$WARN_OUTPUT"

: > "$TMUX_LOG"
WARN_OUTPUT=""
LAST_DASHBOARD_HEALTH_CHECK=0
LAST_CONTROL_PANE_HEALTH_STATUS=""
set_pane_count_queue 3
TMUX_DISPLAY_MESSAGE_OUTPUT="$drift_probe"
TMUX_RESPAWN_RC=1
check_mill_pane_health
assert_contains "respawn failure reports manual quit fallback" "$WARN_OUTPUT" "Append 'quit' to /tmp/wavemill-${SESSION}-commands"

WARN_OUTPUT=""
LOG_OUTPUT=""
LAST_QUIT_MESSAGE=""
QUIT_REQUESTED=false
handle_monitor_quit_command 3
assert_eq "first quit defers while active tasks remain" "true" "$QUIT_REQUESTED"
assert_contains "first quit logs force-quit guidance" "$LOG_OUTPUT" "Press q again to force quit."
assert_eq "first quit does not exit immediately" "" "$LAST_QUIT_MESSAGE"

handle_monitor_quit_command 3
assert_eq "second quit forces exit" "Force quitting (3 task(s) still active)." "$LAST_QUIT_MESSAGE"

echo "PASS: control pane recovery and double-quit behavior"
