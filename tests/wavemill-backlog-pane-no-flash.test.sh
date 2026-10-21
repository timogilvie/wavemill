#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMMON_SCRIPT="$REPO_DIR/shared/lib/wavemill-common.sh"
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
  if [[ "$haystack" != *"$needle"* ]]; then
    pass "$name"
  else
    echo "    unexpected: $needle"
    fail "$name"
  fi
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

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

FUNC_FILE="$TMP_DIR/pane-repaint.sh"
extract_function "$COMMON_SCRIPT" "wavemill_pane_repaint" > "$FUNC_FILE"

if [[ ! -s "$FUNC_FILE" ]]; then
  echo "Could not extract wavemill_pane_repaint"
  exit 1
fi

PAINT_FUNC_FILE="$TMP_DIR/paint-task-list-frame.sh"
extract_function "$MONITOR_SCRIPT_FILE" "paint_task_list_frame" > "$PAINT_FUNC_FILE"

if [[ ! -s "$PAINT_FUNC_FILE" ]]; then
  echo "Could not extract paint_task_list_frame"
  exit 1
fi

render_with_helper() {
  local first_frame="$1" second_frame="$2"
  FUNCTIONS_FILE="$FUNC_FILE" bash -lc '
    set -euo pipefail
    # shellcheck source=/dev/null
    source "$FUNCTIONS_FILE"

    frame1=$(wavemill_pane_repaint "$0")
    frame2=$(wavemill_pane_repaint "$1")
    printf "%s<FRAME2>%s" "$frame1" "$frame2"
  ' "$first_frame" "$second_frame"
}

test_repaint_never_uses_full_screen_clear() {
  local output long short
  long=$'Next tasks:\n  1. HOK-1 - Long item\n  2. HOK-2 - Another item\n\nEnter number(s)...'
  short=$'Next tasks:\n  1. HOK-1 - Long item\n\nEnter number(s)...'
  output="$(render_with_helper "$long" "$short")"

  check_not_contains "no full-screen clear" "$output" $'\033[2J'
  check_not_contains "no terminal reset" "$output" $'\033c'
}

test_repaint_starts_with_content() {
  local output frame first_ten
  frame=$'Next tasks:\n  1. HOK-1 - Item\n\nEnter number(s)...'
  output="$(render_with_helper "$frame" "$frame")"
  first_ten="${output:0:10}"
  check_contains "starts with heading" "$first_ten" "Next tasks"
}

test_shorter_frame_clears_trailing_lines() {
  local output frame2
  output="$(render_with_helper $'Next tasks:\n  1. A\n  2. B\n\nPrompt' $'Next tasks:\n  1. A\n\nPrompt')"
  frame2="${output#*<FRAME2>}"
  check_contains "short frame ends with clear-to-end-screen" "$frame2" $'\033[J'
}

test_monitor_render_path_uses_helper() {
  # The render block for "Next tasks:" must call paint_task_list_frame.
  local snippet
  snippet="$(awk '
    /_task_frame="Next tasks:"/ { capture = 1 }
    capture { print }
    capture && /paint_task_list_frame/ { exit }
  ' "$MONITOR_SCRIPT_FILE")"

  check_contains "render path calls paint_task_list_frame" "$snippet" "paint_task_list_frame"
  check_not_contains "render path omits tput ed" "$snippet" "tput ed"
  check_not_contains "render path omits tput rc" "$snippet" "tput rc"

  # paint_task_list_frame must call wavemill_pane_repaint
  local helper_def
  helper_def="$(awk '
    /^paint_task_list_frame\(\)/ { capture = 1; depth = 0 }
    capture {
      print
      for (i = 1; i <= length($0); i++) {
        c = substr($0, i, 1)
        if (c == "{") depth++
        else if (c == "}") depth--
      }
      if (capture && depth == 0) exit
    }
  ' "$MONITOR_SCRIPT_FILE")"

  check_contains "paint_task_list_frame calls wavemill_pane_repaint" "$helper_def" "wavemill_pane_repaint"
}

# ---------------------------------------------------------------------------
# Terminal buffer simulator
#
# apply_repaint_to_buffer <bytes> [pane_rows]
#   Applies ANSI escape bytes to a virtual terminal buffer and prints the
#   visible lines (non-empty rows only).  Handles the sequences emitted by
#   wavemill_pane_repaint and the monitor cursor-anchor management:
#     \n        — newline (advance row, reset column to 0)
#     ESC[K     — erase current line from cursor to EOL
#     ESC[J     — erase from cursor to end of buffer
#     ESC[2J    — erase the whole buffer (cursor does not move)
#     ESC[H     — move cursor home (row 0, column 0)
#     ESC[s     — save cursor position (screen-relative, like a real tty)
#     ESC[u     — restore cursor position
#     other     — regular character written at current position
#   With pane_rows set, the buffer is a fixed-height screen: a newline on the
#   bottom row scrolls every row up by one and the top row is lost, exactly
#   like a short tmux pane.  Without it the buffer grows without bound.
# ---------------------------------------------------------------------------
apply_repaint_to_buffer() {
  local bytes="$1" pane_rows="${2:-0}"
  # Sparse indexed array: unset elements accessed with ${buf[$r]+${buf[$r]}}
  # so that set -u is not triggered.
  local -a buf=()
  local row=0 col=0 sv_row=0 sv_col=0 max_row=0
  local i=0 len=${#bytes}
  local _line _cur
  if (( pane_rows > 0 )); then max_row=$((pane_rows - 1)); fi

  while (( i < len )); do
    local c="${bytes:$i:1}"
    if [[ "$c" == $'\033' && "${bytes:$((i+1)):1}" == '[' ]]; then
      # Collect CSI sequence: optional params then a final letter
      local j=$((i+2)) seq=""
      while (( j < len )); do
        local x="${bytes:$j:1}"
        seq+="$x"
        j=$((j+1))
        if [[ "$x" =~ [A-Za-z] ]]; then break; fi
      done
      _cur="${buf[$row]+${buf[$row]}}"
      case "${seq: -1}" in
        K) buf[$row]="${_cur:0:$col}" ;;
        J) local k
           if [[ "$seq" == "2J" ]]; then
             for (( k = 0; k <= max_row; k++ )); do buf[$k]=""; done
           else
             buf[$row]="${_cur:0:$col}"
             for (( k = row + 1; k <= max_row; k++ )); do buf[$k]=""; done
           fi ;;
        H) row=0; col=0 ;;
        s) sv_row=$row; sv_col=$col ;;
        u) row=$sv_row; col=$sv_col ;;
      esac
      i=$j
    elif [[ "$c" == $'\n' ]]; then
      col=0
      if (( pane_rows > 0 && row == pane_rows - 1 )); then
        local k
        for (( k = 0; k < pane_rows - 1; k++ )); do
          buf[$k]="${buf[$((k + 1))]+${buf[$((k + 1))]}}"
        done
        buf[$row]=""
      else
        row=$((row + 1))
        if (( row > max_row )); then max_row=$row; fi
      fi
      i=$((i + 1))
    else
      _line="${buf[$row]+${buf[$row]}}"
      while (( ${#_line} < col )); do _line+=" "; done
      buf[$row]="${_line:0:$col}${c}${_line:$((col + 1))}"
      col=$((col + 1))
      i=$((i + 1))
    fi
  done

  # Output non-empty rows.  Using if/then avoids a false-returning &&
  # becoming the function's exit code under set -e.
  local r
  for (( r = 0; r <= max_row; r++ )); do
    local _v="${buf[$r]+${buf[$r]}}"
    if [[ -n "$_v" ]]; then printf '%s\n' "$_v"; fi
  done
}

# render_pane_sequence <step>...
#   Drives the real paint_task_list_frame + wavemill_pane_repaint in a single
#   shell so TASK_LIST_RENDERED and WAVEMILL_PANE_REPAINT_LAST_LINES carry
#   across calls, exactly as they do in the live monitor.  A step prefixed
#   with "RAW:" is written verbatim instead of painted, standing in for log
#   lines or reader output that reach the pane between repaints.
render_pane_sequence() {
  FUNCTIONS_FILE="$FUNC_FILE" PAINT_FILE="$PAINT_FUNC_FILE" bash -c '
    set -euo pipefail
    source "$FUNCTIONS_FILE"
    source "$PAINT_FILE"
    TASK_LIST_RENDERED=0
    WAVEMILL_PANE_REPAINT_LAST_LINES=0
    for step in "$@"; do
      if [[ "$step" == RAW:* ]]; then
        printf "%s" "${step#RAW:}"
      else
        paint_task_list_frame "$step"
      fi
    done
  ' _ "$@"
}

render_three_frames() {
  render_pane_sequence "$1" "$2" "$3"
}

# Three-frame visible-pane regression
# Frame A: tall grouped list; Frame B: short flat fallback; Frame C: medium list.
# After all three repaints only one "Next tasks:" must be visible.
test_three_frame_regression() {
  local frame_a frame_b frame_c raw visible count

  frame_a=$'Next tasks:\n  Available Now - Parallel Wave 1\n  1. HOK-100 - Task Alpha (score: 95)\n  2. HOK-101 - Task Beta (score: 88)\n  Queued\n  3. HOK-102 - Task Gamma (waiting)\n  4. HOK-103 - Task Delta (waiting)\n\nEnter number(s) to start (e.g. 1 3), wait 10s to refresh:'
  frame_b=$'Next tasks:\n  1. HOK-200 - Flat task (score: 70)\n\nEnter number(s) to start (e.g. 1 3), wait 10s to refresh:'
  frame_c=$'Next tasks:\n  Available Now - Parallel Wave 1\n  1. HOK-300 - New task (score: 80)\n  2. HOK-301 - Other task (score: 75)\n\nEnter number(s) to start (e.g. 1 3), wait 10s to refresh:'

  raw="$(render_three_frames "$frame_a" "$frame_b" "$frame_c")"
  visible="$(apply_repaint_to_buffer "$raw")"

  count=$(printf '%s' "$visible" | grep -c "Next tasks:" 2>/dev/null || echo "0")
  if [[ "$count" == "1" ]]; then
    pass "three-frame regression: exactly one 'Next tasks:' visible"
  else
    printf '    visible buffer:\n'
    printf '%s\n' "$visible" | head -30 | sed 's/^/    | /'
    fail "three-frame regression: expected 1 'Next tasks:', got $count"
  fi

  check_not_contains "three-frame: no stale HOK-100" "$visible" "HOK-100"
  check_not_contains "three-frame: no stale HOK-200" "$visible" "HOK-200"
  check_contains     "three-frame: current frame visible (HOK-300)" "$visible" "HOK-300"
}

# Shrink regression: tall grouped → short flat.
# Old trailing rows from the grouped frame must not remain visible.
test_shrink_regression() {
  local frame_tall frame_short raw visible

  frame_tall=$'Next tasks:\n  Available Now - Parallel Wave 1\n  1. HOK-10 - Alpha\n  2. HOK-11 - Beta\n  Queued - Wave 2\n  3. HOK-12 - Gamma\n\nEnter number(s) to start, wait 10s to refresh:'
  frame_short=$'Next tasks:\n  1. HOK-20 - Only task\n\nEnter number(s) to start, wait 10s to refresh:'

  raw="$(render_three_frames "$frame_tall" "$frame_short" "$frame_short")"
  visible="$(apply_repaint_to_buffer "$raw")"

  local count
  count=$(printf '%s' "$visible" | grep -c "Next tasks:" 2>/dev/null || echo "0")
  if [[ "$count" == "1" ]]; then
    pass "shrink regression: exactly one 'Next tasks:' visible"
  else
    fail "shrink regression: expected 1 'Next tasks:', got $count"
  fi

  check_not_contains "shrink: stale Wave 1 header gone" "$visible" "Parallel Wave 1"
  check_not_contains "shrink: stale HOK-10 gone" "$visible" "HOK-10"
  check_contains     "shrink: current task visible" "$visible" "HOK-20"
}

# Grow regression: short flat → tall grouped.
# The full tall frame must be rendered without duplication.
test_grow_regression() {
  local frame_short frame_tall raw visible

  frame_short=$'Next tasks:\n  1. HOK-20 - Only task\n\nEnter number(s) to start:'
  frame_tall=$'Next tasks:\n  Available Now - Parallel Wave 1\n  1. HOK-10 - Alpha\n  2. HOK-11 - Beta\n  Queued - Wave 2\n  3. HOK-12 - Gamma\n\nEnter number(s) to start:'

  raw="$(render_three_frames "$frame_short" "$frame_tall" "$frame_tall")"
  visible="$(apply_repaint_to_buffer "$raw")"

  local count
  count=$(printf '%s' "$visible" | grep -c "Next tasks:" 2>/dev/null || echo "0")
  if [[ "$count" == "1" ]]; then
    pass "grow regression: exactly one 'Next tasks:' visible"
  else
    fail "grow regression: expected 1 'Next tasks:', got $count"
  fi

  check_contains "grow: tall frame fully rendered (Wave 1)" "$visible" "Parallel Wave 1"
  check_contains "grow: tall frame task visible (HOK-12)" "$visible" "HOK-12"
  check_not_contains "grow: stale short frame task gone" "$visible" "HOK-20"
}

# Fallback regression: grouped frame → queue-analysis-unavailable flat frame.
# Grouped headings from the first frame must be cleared after fallback paints.
test_fallback_regression() {
  local frame_grouped frame_flat raw visible

  frame_grouped=$'Next tasks:\n  Available Now - Parallel Wave 1\n  1. HOK-50 - Group task A\n  2. HOK-51 - Group task B\n  Queued - Wave 2\n  3. HOK-52 - Group task C\n\nEnter number(s) to start (grouped view):'
  frame_flat=$'Next tasks:\n  1. HOK-50 - Group task A (score: 80)\n  2. HOK-51 - Group task B (score: 75)\n\nEnter number(s) to start (flat fallback):'

  raw="$(render_three_frames "$frame_grouped" "$frame_flat" "$frame_flat")"
  visible="$(apply_repaint_to_buffer "$raw")"

  local count
  count=$(printf '%s' "$visible" | grep -c "Next tasks:" 2>/dev/null || echo "0")
  if [[ "$count" == "1" ]]; then
    pass "fallback regression: exactly one 'Next tasks:' visible"
  else
    fail "fallback regression: expected 1 'Next tasks:', got $count"
  fi

  check_not_contains "fallback: grouped heading cleared" "$visible" "Parallel Wave 1"
  check_not_contains "fallback: stale Wave 2 heading cleared" "$visible" "Queued - Wave 2"
  check_contains     "fallback: flat task visible" "$visible" "flat fallback"
}

# Build a grouped "Next tasks:" frame listing <count> tasks with ids
# <prefix>-1..<prefix>-<count>.
make_task_frame() {
  local prefix="$1" count="$2" frame n
  frame=$'Next tasks:\n  Available Now - Parallel Wave 1\n'
  for (( n = 1; n <= count; n++ )); do
    frame+="  ${n}. ${prefix}-${n} - Task ${n} (score: 80)"$'\n'
  done
  frame+=$'\nEnter number(s) to start (e.g. 1 3), \'m\' for more, \'d\' for deps, \'q\' to quit, or wait 10s to refresh:'
  printf '%s' "$frame"
}

count_next_tasks() {
  local n
  n=$(printf '%s\n' "$1" | grep -c "Next tasks:" || true)
  printf '%s' "${n:-0}"
}

# HOK-3252: in a 24-row pane, a first paint that starts mid-pane scrolls the
# frame up.  A screen-relative ESC[s anchor then points below the old frame,
# so every later repaint stacked another "Next tasks:" frame under stale ones
# and a launched task (HOK-3214 in the incident) still looked launchable.
test_short_pane_scroll_no_stale_frame() {
  local noise="" n raw visible count frame_a frame_b frame_c
  for (( n = 1; n <= 16; n++ )); do noise+="startup line ${n}"$'\n'; done
  frame_a="$(make_task_frame STALE 6)"
  frame_b="$(make_task_frame MID 9)"
  frame_c="$(make_task_frame LIVE 4)"

  raw="$(render_pane_sequence "RAW:${noise}" "$frame_a" "$frame_b" "$frame_c")"
  visible="$(apply_repaint_to_buffer "$raw" 24)"

  count="$(count_next_tasks "$visible")"
  if [[ "$count" == "1" ]]; then
    pass "short pane scroll: exactly one 'Next tasks:' visible"
  else
    printf '    visible pane:\n'
    printf '%s\n' "$visible" | sed 's/^/    | /'
    fail "short pane scroll: expected 1 'Next tasks:', got $count"
  fi

  check_not_contains "short pane scroll: first-frame task gone (STALE-1)" "$visible" "STALE-1"
  check_not_contains "short pane scroll: middle-frame task gone (MID-9)" "$visible" "MID-9"
  check_contains     "short pane scroll: current task visible (LIVE-4)" "$visible" "LIVE-4"
}

# HOK-3252: log lines written to the pane between repaints (log fallback to
# stdout, input-reader output) must not leave earlier frames on screen or sit
# inside the current frame, even when they scroll the pane.
test_interleaved_log_output_no_stale_frame() {
  local logs="" n raw visible count frame_a frame_b frame_c
  # Eleven lines after the 12-row first frame scroll the 24-row pane by one
  # row: enough to move a screen-relative anchor below that frame's heading.
  for (( n = 1; n <= 11; n++ )); do logs+="$(printf '12:00:%02d' "$n") log line ${n}"$'\n'; done
  frame_a="$(make_task_frame OLD 8)"
  frame_b="$(make_task_frame MID 3)"
  frame_c="$(make_task_frame NEW 5)"

  raw="$(render_pane_sequence "$frame_a" "RAW:${logs}" "$frame_b" "RAW:${logs}" "$frame_c")"
  visible="$(apply_repaint_to_buffer "$raw" 24)"

  count="$(count_next_tasks "$visible")"
  if [[ "$count" == "1" ]]; then
    pass "interleaved logs: exactly one 'Next tasks:' visible"
  else
    printf '    visible pane:\n'
    printf '%s\n' "$visible" | sed 's/^/    | /'
    fail "interleaved logs: expected 1 'Next tasks:', got $count"
  fi

  check_not_contains "interleaved logs: first-frame task gone (OLD-8)" "$visible" "OLD-8"
  check_not_contains "interleaved logs: log lines not on screen" "$visible" "log line"
  check_contains     "interleaved logs: current task visible (NEW-5)" "$visible" "NEW-5"
}

echo "=== Backlog Pane No Flash ==="
test_repaint_never_uses_full_screen_clear
test_repaint_starts_with_content
test_shorter_frame_clears_trailing_lines
test_monitor_render_path_uses_helper

echo
echo "=== Repaint Visible-Buffer Regression ==="
test_three_frame_regression
test_shrink_regression
test_grow_regression
test_fallback_regression

echo
echo "=== Short Pane Scroll Regression (HOK-3252) ==="
test_short_pane_scroll_no_stale_frame
test_interleaved_log_output_no_stale_frame

echo
echo "Passed: $PASS"
echo "Failed: $FAIL"

if (( FAIL > 0 )); then
  exit 1
fi
