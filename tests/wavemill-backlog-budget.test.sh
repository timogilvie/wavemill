#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMMON_SCRIPT="$REPO_DIR/shared/lib/wavemill-common.sh"
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

check_equals() {
  local name="$1" actual="$2" expected="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass "$name"
  else
    echo "    expected: $expected"
    echo "    actual:   $actual"
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
BUDGET_FUNC_FILE="$TMP_DIR/backlog-budget.sh"
extract_function "$MONITOR_SCRIPT_FILE" "render_grouped_task_list" > "$RENDER_FUNC_FILE"
extract_function "$COMMON_SCRIPT" "wavemill_backlog_compute_budget" > "$BUDGET_FUNC_FILE"

if [[ ! -s "$RENDER_FUNC_FILE" ]] || [[ ! -s "$BUDGET_FUNC_FILE" ]]; then
  echo "Could not extract backlog functions"
  exit 1
fi

make_available() {
  local count="$1" prefix="$2"
  local i
  for ((i = 1; i <= count; i++)); do
    printf 'HOK-%s|slug-%s|%s Task %s|area|%s|0\n' "$i" "$i" "$prefix" "$i" "$((100 - i))"
  done
}

make_queue_plan() {
  local available_count="$1" queued_count="$2"
  local i
  {
    printf '{"availableNow":['
    for ((i = 1; i <= available_count; i++)); do
      (( i > 1 )) && printf ','
      printf '"HOK-%s"' "$i"
    done
    printf '],"queuedAfterDependencies":['
    for ((i = available_count + 1; i <= available_count + queued_count; i++)); do
      (( i > available_count + 1 )) && printf ','
      printf '{"taskId":"HOK-%s","ancestors":["HOK-1"]}' "$i"
    done
    printf '],"avoidRunningTogether":[],"needsTriage":[]}\n'
  }
}

render_case() {
  local available_count="$1" queued_count="$2" budget="$3" expanded="${4:-false}" config_json="${5:-{}}"
  local case_dir="$TMP_DIR/render-$RANDOM"
  mkdir -p "$case_dir"
  printf '%s\n' "$config_json" > "$case_dir/.wavemill-config.json"

  local queue_plan available
  queue_plan="$(make_queue_plan "$available_count" "$queued_count")"
  available="$(make_available "$((available_count + queued_count))" "Visible")"

  # HOK-3305: the extracted render_grouped_task_list forwards to the shared
  # launch-set picker. Source the picker here and stub _picker_select_wave to
  # keep the test hermetic (the real tool would invoke select-wave.ts).
  FUNCTIONS_FILE="$RENDER_FUNC_FILE" PICKER_FILE="$PICKER_SCRIPT_FILE" \
  QUEUE_PLAN="$queue_plan" AVAILABLE="$available" BUDGET="$budget" EXPANDED="$expanded" \
  CASE_DIR="$case_dir" bash -lc '
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
    render_grouped_task_list "$QUEUE_PLAN" "$AVAILABLE" "$BUDGET" "$EXPANDED"
    printf "DISPLAY<<EOF\n%s\nEOF\nSELECT<<EOF\n%s\nEOF\n" "$GROUPED_DISPLAY" "$GROUPED_SELECT_FROM"
  '
}

budget_case() {
  local config_json="$1" tmux_height="$2"
  local case_dir="$TMP_DIR/budget-$RANDOM"
  local shim_dir="$case_dir/bin"
  mkdir -p "$shim_dir"
  printf '%s\n' "$config_json" > "$case_dir/config.json"
  cat > "$shim_dir/tmux" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "${TMUX_HEIGHT:-}"
EOF
  chmod +x "$shim_dir/tmux"

  FUNCTIONS_FILE="$BUDGET_FUNC_FILE" CASE_DIR="$case_dir" TMUX_HEIGHT="$tmux_height" PATH="$shim_dir:$PATH" bash -c '
    set -euo pipefail
    log_warn() { printf "WARN:%s\n" "$*"; }
    wavemill_load_config() { cat "$1/.wavemill-config.json"; }
    BACKLOG_BUDGET_WARNED=false
    REPO_DIR="$CASE_DIR"
    cp "$CASE_DIR/config.json" "$CASE_DIR/.wavemill-config.json"
    # shellcheck source=/dev/null
    source "$FUNCTIONS_FILE"
    wavemill_backlog_compute_budget "sess" "1.0" "$CASE_DIR/config.json"
  '
}

test_under_budget_renders_full_list() {
  local output
  output="$(render_case 5 2 40)"
  # HOK-3305: picker renames the queued section to "Held: waiting on".
  check_contains "under budget shows held-waiting section" "$output" "Held: waiting on"
  check_not_contains "under budget no hidden indicator" "$output" "tasks hidden"
  check_contains "under budget includes last queued task" "$output" "HOK-7 - Visible Task 7"
}

test_tier_one_trims_queued_entries() {
  local output
  output="$(render_case 8 20 16)"
  check_contains "tier 1 keeps held-waiting header" "$output" "Held: waiting on"
  # Each held entry costs two lines (title + "blocked by:"), so a 16-line
  # budget with 9 lines of launch-next leaves room for ~3 held entries,
  # hiding the remaining 17.
  check_contains "tier 1 shows hidden indicator" "$output" "... 17 tasks hidden (m to expand)"
  check_contains "tier 1 keeps first queued task" "$output" "HOK-9 - Visible Task 9"
  check_contains "tier 1 keeps second queued task" "$output" "HOK-10 - Visible Task 10"
  check_not_contains "tier 1 hides deep queued task" "$output" "HOK-12 - Visible Task 12"
}

test_tier_two_drops_queued_section() {
  local output
  output="$(render_case 8 20 10)"
  check_not_contains "tier 2 removes held-waiting header" "$output" "Held: waiting on"
  check_contains "tier 2 shows indicator" "$output" "... 20 tasks hidden (m to expand)"
  check_contains "tier 2 keeps available list" "$output" "HOK-8 - Visible Task 8"
}

test_tier_three_caps_available_now() {
  local output
  output="$(render_case 25 10 14)"
  check_contains "tier 3 shows twelfth task" "$output" "HOK-12 - Visible Task 12"
  check_not_contains "tier 3 hides thirteenth task" "$output" "HOK-13 - Visible Task 13"
  check_not_contains "tier 3 removes held-waiting section" "$output" "Held: waiting on"
  check_contains "tier 3 shows total hidden count" "$output" "... 23 tasks hidden (m to expand)"
}

test_expanded_mode_shows_full_content() {
  local output
  output="$(render_case 25 10 14 true)"
  check_contains "expanded shows deep available task" "$output" "HOK-25 - Visible Task 25"
  check_contains "expanded shows held-waiting section" "$output" "Held: waiting on"
  check_contains "expanded shows collapse hint" "$output" "(m to collapse)"
  check_not_contains "expanded omits hidden indicator" "$output" "tasks hidden"
}

test_budget_computation_paths() {
  local output

  output="$(budget_case '{"backlog":{"maxLines":20}}' 99)"
  check_equals "config override beats tmux height" "${output##*$'\n'}" "20"

  output="$(budget_case '{}' 8)"
  check_equals "pane height subtracts frame overhead and clamps" "${output##*$'\n'}" "10"

  output="$(budget_case '{}' 23)"
  check_equals "typical mill pane reserves frame rows" "${output##*$'\n'}" "15"

  output="$(budget_case '{}' '')"
  check_contains "fallback warns once" "$output" "WARN:Backlog pane height unavailable; using fallback budget 20"
  check_equals "fallback returns 20" "${output##*$'\n'}" "20"
}

echo "=== Backlog Budget ==="
test_under_budget_renders_full_list
test_tier_one_trims_queued_entries
test_tier_two_drops_queued_section
test_tier_three_caps_available_now
test_expanded_mode_shows_full_content
test_budget_computation_paths

echo
echo "Passed: $PASS"
echo "Failed: $FAIL"

if (( FAIL > 0 )); then
  exit 1
fi
