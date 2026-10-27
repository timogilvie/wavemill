#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
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

RENDER_FUNC_FILE="$TMP_DIR/render-grouped.sh"
{
  extract_function "$MONITOR_SCRIPT_FILE" "render_grouped_task_list"
  echo
  # HOK-3305: render_grouped_task_list is a thin wrapper that forwards to
  # render_launch_set_picker (defined in wavemill-picker.sh). Source the
  # picker file so the extracted wrapper can resolve its forward target.
  cat "$REPO_DIR/shared/lib/wavemill-picker.sh"
  echo
  cat <<'STUB'
if ! declare -F queue_inference_degraded_banner >/dev/null 2>&1; then
  queue_inference_degraded_banner() { return 0; }
fi
if ! declare -F wavemill_run_tool >/dev/null 2>&1; then
  wavemill_run_tool() { return 1; }
fi
if ! declare -F _with_timeout >/dev/null 2>&1; then
  _with_timeout() { shift; "$@"; }
fi
STUB
} > "$RENDER_FUNC_FILE"

if [[ ! -s "$RENDER_FUNC_FILE" ]]; then
  echo "Could not extract render_grouped_task_list()"
  exit 1
fi

render_backlog_case() {
  local case_dir="$TMP_DIR/backlog-$RANDOM"
  mkdir -p "$case_dir"

  local queue_plan available
  queue_plan='{"availableNow":["HOK-1","HOK-2","HOK-3","HOK-4","HOK-5","HOK-6","HOK-7","HOK-8","HOK-9"],"queuedAfterDependencies":[{"taskId":"HOK-10","ancestors":["HOK-1"]},{"taskId":"HOK-11","ancestors":["HOK-1"]}],"avoidRunningTogether":[],"needsTriage":[]}'
  available=$'HOK-1|slug-1|Task 1|area|99|0\nHOK-2|slug-2|Task 2|area|98|0\nHOK-3|slug-3|Task 3|area|97|0\nHOK-4|slug-4|Task 4|area|96|0\nHOK-5|slug-5|Task 5|area|95|0\nHOK-6|slug-6|Task 6|area|94|0\nHOK-7|slug-7|Task 7|area|93|0\nHOK-8|slug-8|Task 8|area|92|0\nHOK-9|slug-9|Task 9|area|91|0\nHOK-10|slug-10|Task 10|area|90|1\nHOK-11|slug-11|Task 11|area|89|1'

  FUNCTIONS_FILE="$RENDER_FUNC_FILE" CASE_DIR="$case_dir" QUEUE_PLAN="$queue_plan" AVAILABLE="$available" bash -lc '
    set -euo pipefail
    LOG_OUTPUT=""
    log() { printf -v LOG_OUTPUT "%s%s\n" "$LOG_OUTPUT" "$*"; }
    wavemill_config_annotation() { printf " (%s=%s)" "$1" "$2"; }
    wavemill_load_config() { cat "$1/.wavemill-config.json"; }
    REPO_DIR="$CASE_DIR"
    BACKLOG_LAST_TIER=""
    BACKLOG_DEFAULT_AVAILABLE_CAP=12
    GROUPED_SELECT_FROM=""
    GROUPED_DISPLAY=""
    printf "%s\n" "{}" > "$CASE_DIR/.wavemill-config.json"
    # shellcheck source=/dev/null
    source "$FUNCTIONS_FILE"
    # HOK-3305: stub select-wave so the picker renders without the TS tool.
    # The log-hygiene assertion only cares that the backlog tier log fires at
    # info level, which requires the picker to emit at least one entry.
    _picker_select_wave() {
      jq -n --argjson p "$1" '"'"'{launchNext: ($p.availableNow // []), held: [], slotsFull: []}'"'"'
    }
    render_grouped_task_list "$QUEUE_PLAN" "$AVAILABLE" 16 false
    printf "logs=%s\n" "$LOG_OUTPUT"
  '
}

echo "=== Log Hygiene ==="

source_checks="$(cat "$MILL_SCRIPT" "$MONITOR_SCRIPT_FILE" "$COMMON_SCRIPT")"

check_contains "completion log includes issue-first with reason" "$source_checks" '$issue: Complete ($completion_reason)'
check_contains "completion log includes issue-first without reason" "$source_checks" '$issue: Complete'
check_contains "launch log includes issue-first launch format" "$source_checks" '$issue: Launching - $title'
check_contains "direct routing completion includes issue-first format" "$source_checks" '$issue Routing complete (direct), launched planning with $planner_launch_model'
check_contains "routing summary includes issue-first format" "$source_checks" '$issue: Routing: planner=$planner_model, coder=$task_model, reviewer=$reviewer_model'
check_contains "live workflow route includes issue-first format" "$source_checks" '$issue Route: planner=$planner_model ($plan_depth), coder=$task_model ($code_depth), reviewer=$reviewer_model ($review_mode)'
check_contains "batch-cache workflow route keeps provenance" "$source_checks" '$issue Route (from batch cache): planner=$planner_model ($plan_depth), coder=$task_model ($code_depth), reviewer=$reviewer_model ($review_mode)'
check_contains "startup-cache workflow route keeps provenance" "$source_checks" '$issue Route (from startup cache): planner=$planner_model ($plan_depth), coder=$task_model ($code_depth), reviewer=$reviewer_model ($review_mode)'
check_contains "fallback workflow route keeps provenance" "$source_checks" '$issue Route (heuristic fallback): planner=$planner_model ($plan_depth), coder=$task_model ($code_depth), reviewer=$reviewer_model ($review_mode)'

backlog_output="$(render_backlog_case)"
check_contains "backlog tier log is emitted at info level" "$backlog_output" "logs=info [backlog] tier=0 budget=16 (backlog.maxLines=auto)"
check_not_contains "backlog tier log is not emitted at status level" "$backlog_output" "logs=status [backlog] tier=0 budget=16"

echo
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
