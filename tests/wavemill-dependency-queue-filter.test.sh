#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"
PICKER_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-picker.sh"

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

RENDER_FUNC_FILE="$TMP_DIR/render-grouped.sh"
extract_function "$MONITOR_SCRIPT_FILE" "render_grouped_task_list" > "$RENDER_FUNC_FILE"

if [[ ! -s "$RENDER_FUNC_FILE" ]]; then
  echo "Could not extract render_grouped_task_list"
  exit 1
fi

render_case() {
  local queue_plan="$1" available="$2" budget="$3" expanded="${4:-false}"
  local deps_expanded="${5:-false}" active_issue_ids="${6:-}"
  local case_dir="$TMP_DIR/render-$RANDOM"
  mkdir -p "$case_dir"
  printf '{}\n' > "$case_dir/.wavemill-config.json"

  # HOK-3305: the extracted render_grouped_task_list forwards to the shared
  # launch-set picker. Source the picker here and stub _picker_select_wave to
  # keep the test hermetic (the real tool would invoke select-wave.ts).
  FUNCTIONS_FILE="$RENDER_FUNC_FILE" \
  PICKER_FILE="$PICKER_SCRIPT_FILE" \
  QUEUE_PLAN="$queue_plan" \
  AVAILABLE="$available" \
  BUDGET="$budget" \
  EXPANDED="$expanded" \
  DEPS_EXPANDED="$deps_expanded" \
  ACTIVE_ISSUE_IDS="$active_issue_ids" \
  CASE_DIR="$case_dir" \
  bash -lc '
    set -euo pipefail
    log() { :; }
    wavemill_config_annotation() { printf " (%s=%s)" "$1" "$2"; }
    wavemill_load_config() { cat "$1/.wavemill-config.json"; }
    queue_inference_degraded_banner() { return 0; }
    REPO_DIR="$CASE_DIR"
    BACKLOG_LAST_TIER=""
    BACKLOG_DEFAULT_AVAILABLE_CAP=12
    GROUPED_SELECT_FROM=""
    GROUPED_DISPLAY=""
    # shellcheck source=/dev/null
    source "$PICKER_FILE"
    _picker_select_wave() {
      jq -n --argjson p "$1" "{launchNext: (\$p.availableNow // []), held: [], slotsFull: []}"
    }
    # shellcheck source=/dev/null
    source "$FUNCTIONS_FILE"
    render_grouped_task_list "$QUEUE_PLAN" "$AVAILABLE" "$BUDGET" "$EXPANDED" "$DEPS_EXPANDED" "$ACTIVE_ISSUE_IDS"
    printf "DISPLAY<<EOF\n%s\nEOF\nSELECT<<EOF\n%s\nEOF\n" "$GROUPED_DISPLAY" "$GROUPED_SELECT_FROM"
  '
}

base_available() {
  cat <<'EOF'
HOK-1|slug-1|Issue 1|area|99|0
HOK-2|slug-2|Issue 2|area|98|0
HOK-3|slug-3|Issue 3|area|97|0
HOK-4|slug-4|Issue 4|area|96|0
HOK-5|slug-5|Issue 5|area|95|0
EOF
}

mixed_queue_plan() {
  cat <<'EOF'
{"availableNow":["HOK-1"],"queuedAfterDependencies":[{"taskId":"HOK-2","ancestors":["HOK-1"]},{"taskId":"HOK-3","ancestors":["HOK-1","HOK-9"]},{"taskId":"HOK-4","ancestors":["HOK-7"]},{"taskId":"HOK-5","ancestors":["HOK-8"]}],"avoidRunningTogether":[],"needsTriage":[]}
EOF
}

empty_blocker_queue_plan() {
  cat <<'EOF'
{"availableNow":[],"queuedAfterDependencies":[{"taskId":"HOK-1","ancestors":[]}],"avoidRunningTogether":[],"needsTriage":[]}
EOF
}

all_on_deck_queue_plan() {
  cat <<'EOF'
{"availableNow":["HOK-1"],"queuedAfterDependencies":[{"taskId":"HOK-2","ancestors":["HOK-1"]},{"taskId":"HOK-3","ancestors":["HOK-1"]}],"avoidRunningTogether":[],"needsTriage":[]}
EOF
}

two_line_budget_plan() {
  cat <<'EOF'
{"availableNow":[],"queuedAfterDependencies":[{"taskId":"HOK-1","ancestors":["HOK-9"]},{"taskId":"HOK-2","ancestors":["HOK-9"]},{"taskId":"HOK-3","ancestors":["HOK-9"]}],"avoidRunningTogether":[],"needsTriage":[]}
EOF
}

test_off_deck_items_suppressed() {
  local output
  output="$(render_case "$(mixed_queue_plan)" "$(base_available)" 40)"
  # HOK-3305: picker renames the queued section to "Held: waiting on".
  check_contains "default shows held-waiting header" "$output" "Held: waiting on"
  check_contains "shows on-deck available blocker item" "$output" "HOK-2 - Issue 2"
  check_not_contains "suppresses partially on-deck multi-blocker item" "$output" "HOK-3 - Issue 3"
  check_not_contains "suppresses off-deck item 4" "$output" "HOK-4 - Issue 4"
  check_not_contains "suppresses off-deck item 5" "$output" "HOK-5 - Issue 5"
  check_contains "shows hidden deps count" "$output" "+3 hidden - d to expand"
}

test_active_issue_ids_make_item_on_deck() {
  local output
  output="$(render_case "$(mixed_queue_plan)" "$(base_available)" 40 false false $'HOK-7\n')"
  check_contains "active blocker item becomes visible" "$output" "HOK-4 - Issue 4"
  check_not_contains "partially on-deck multi-blocker item stays hidden" "$output" "HOK-3 - Issue 3"
  check_not_contains "remaining off-deck item stays hidden" "$output" "HOK-5 - Issue 5"
  check_contains "hidden count updates" "$output" "+2 hidden - d to expand"
}

test_no_hidden_indicator_when_all_on_deck() {
  local output
  output="$(render_case "$(all_on_deck_queue_plan)" "$(base_available)" 40)"
  check_contains "all on-deck item 1 visible" "$output" "HOK-2 - Issue 2"
  check_contains "all on-deck item 2 visible" "$output" "HOK-3 - Issue 3"
  check_not_contains "no hidden deps indicator" "$output" "hidden - d to expand"
}

test_two_line_budget_limits_queued_entries() {
  local output
  # HOK-3305: the picker renders each held-waiting entry as a title line plus
  # a "blocked by:" line. A 6-line budget admits two queued entries and trims
  # the third.
  output="$(render_case "$(two_line_budget_plan)" "$(base_available)" 6 false false $'HOK-9\n')"
  check_contains "budget keeps held-waiting header" "$output" "Held: waiting on"
  check_contains "budget keeps first queued item" "$output" "HOK-1 - Issue 1"
  check_contains "budget keeps second queued item" "$output" "HOK-2 - Issue 2"
  check_not_contains "budget trims third queued item" "$output" "HOK-3 - Issue 3"
  check_contains "budget hidden count reflects one entry" "$output" "... 1 tasks hidden (m to expand)"
}

test_deps_expanded_shows_all_items() {
  local output
  output="$(render_case "$(mixed_queue_plan)" "$(base_available)" 40 false true)"
  check_contains "expanded shows off-deck item 4" "$output" "HOK-4 - Issue 4"
  check_contains "expanded shows off-deck item 5" "$output" "HOK-5 - Issue 5"
  check_contains "expanded shows collapse hint" "$output" "(d to collapse)"
  check_not_contains "expanded removes hidden deps indicator" "$output" "hidden - d to expand"
}

test_empty_blockers_stay_visible() {
  local output
  output="$(render_case "$(empty_blocker_queue_plan)" "$(base_available)" 40)"
  check_contains "empty blockers item remains visible" "$output" "HOK-1 - Issue 1"
}

echo "=== Dependency Queue Filter ==="
test_off_deck_items_suppressed
test_active_issue_ids_make_item_on_deck
test_no_hidden_indicator_when_all_on_deck
test_two_line_budget_limits_queued_entries
test_deps_expanded_shows_all_items
test_empty_blockers_stay_visible

echo
echo "Passed: $PASS"
echo "Failed: $FAIL"

if (( FAIL > 0 )); then
  exit 1
fi
