#!/usr/bin/env bash
# Regression coverage for HOK-2840: the queue planner policy wrapper must
# forward piped backlog JSON to the backgrounded planner process.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

check_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$name"
  else
    echo "    expected: $expected"
    echo "    actual:   $actual"
    fail "$name"
  fi
}

check_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$name"
  else
    echo "    missing: $needle"
    fail "$name"
  fi
}

extract_monitor_heredoc() {
  cat "$MONITOR_SCRIPT_FILE"
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

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT
mkdir -p "$TEST_TMP/tmp" "$TEST_TMP/state"
export TMPDIR="$TEST_TMP/tmp"
export STATE_DIR="$TEST_TMP/state"

MONITOR_BODY="$TEST_TMP/monitor-body.sh"
extract_monitor_heredoc > "$MONITOR_BODY"

FUNCTIONS_FILE="$TEST_TMP/queue-planner-policy-funcs.sh"
{
  extract_function "$MONITOR_BODY" "record_fetch_queue_plan_failure"
  echo
  extract_function "$MONITOR_BODY" "classify_queue_failure_reason"
  echo
  extract_function "$MONITOR_BODY" "get_queue_failure_reason"
  echo
  extract_function "$MONITOR_BODY" "run_queue_planner_with_policy"
  echo
  extract_function "$MONITOR_BODY" "build_queue_plan_once"
} > "$FUNCTIONS_FILE"

# shellcheck source=../shared/lib/wavemill-common.sh
source "$REPO_DIR/shared/lib/wavemill-common.sh"
# shellcheck source=../shared/lib/queue-health.sh
source "$REPO_DIR/shared/lib/queue-health.sh"
# shellcheck source=/dev/null
source "$FUNCTIONS_FILE"

assert_no_temp_files() {
  local leftovers
  leftovers="$(find "$TMPDIR" -maxdepth 1 \( \
    -name 'wavemill-planner-stdin.*' -o \
    -name 'wavemill-planner-stdout.*' -o \
    -name 'wavemill-planner-stderr.*' -o \
    -name 'wavemill-watchdog-*' \
  \) -print)"
  check_eq "planner temp files cleaned" "" "$leftovers"
}

echo "=== HOK-2840: queue planner policy stdin forwarding ==="

plan_input='[{"id":"HOK-1","title":"Ready task"}]'
input_snapshot='{"taskCount":1,"explicitDependencyCount":0,"cacheKey":"stdin-policy-test"}'
export PLANNER_STDIN_CAPTURE="$TEST_TMP/planner-stdin.json"

planner="$TEST_TMP/planner-success.sh"
cat > "$planner" <<'EOF'
#!/usr/bin/env bash
payload="$(cat)"
printf '%s' "$payload" > "$PLANNER_STDIN_CAPTURE"
printf '{"availableNow":["HOK-1"],"queuedAfterDependencies":[],"avoidRunningTogether":[],"needsTriage":[]}\n'
EOF
chmod +x "$planner"

result="$(printf '%s' "$plan_input" | run_queue_planner_with_policy "\"$planner\"" 5 "$input_snapshot")"
check_eq "wrapper forwards stdin to backgrounded planner" "$plan_input" "$(cat "$PLANNER_STDIN_CAPTURE")"
check_eq "wrapper emits planner queue JSON" "HOK-1" "$(printf '%s' "$result" | jq -r '.availableNow[0]')"
check_eq "queue health records successful state" "healthy" "$(jq -r '.status' "$STATE_DIR/queue-health.json")"
check_eq "queue health clears failure count" "0" "$(jq -r '.failureCount' "$STATE_DIR/queue-health.json")"
check_eq "queue health clears backoff" "0" "$(jq -r '.retryBackoffSeconds' "$STATE_DIR/queue-health.json")"

export FETCH_QUEUE_PLAN_DIAGNOSTICS_FILE="$TEST_TMP/diagnostics.txt"
missing_input_planner="$TEST_TMP/planner-missing-input.sh"
cat > "$missing_input_planner" <<'EOF'
#!/usr/bin/env bash
echo "Error: planner_input_missing: stdin was empty" >&2
exit 1
EOF
chmod +x "$missing_input_planner"

if printf '' | run_queue_planner_with_policy "\"$missing_input_planner\"" 5 "$input_snapshot" >/dev/null; then
  fail "wrapper fails missing planner input"
else
  pass "wrapper fails missing planner input"
fi
check_contains "diagnostics use planner_input_missing step" "$(cat "$FETCH_QUEUE_PLAN_DIAGNOSTICS_FILE")" "step=planner_input_missing"
check_eq "queue health records input-missing reason" "planner_input_missing" "$(jq -r '.degradationReason' "$STATE_DIR/queue-health.json")"
check_eq "queue health records input-missing step" "planner_input_missing" "$(jq -r '.failureStep' "$STATE_DIR/queue-health.json")"
assert_no_temp_files

timeout_planner="$TEST_TMP/planner-timeout.sh"
cat > "$timeout_planner" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
sleep 5
EOF
chmod +x "$timeout_planner"

if printf '%s' "$plan_input" | run_queue_planner_with_policy "\"$timeout_planner\"" 1 "$input_snapshot" >/dev/null; then
  fail "wrapper fails watchdog timeout"
else
  pass "wrapper fails watchdog timeout"
fi
timeout_diagnostics="$(cat "$FETCH_QUEUE_PLAN_DIAGNOSTICS_FILE")"
check_contains "timeout diagnostics include watchdog owner" "$timeout_diagnostics" "cancellationOwner=queue_plan_timeout"
check_eq "watchdog-owned 143 classifies as timeout" "timeout" "$(get_queue_failure_reason "$FETCH_QUEUE_PLAN_DIAGNOSTICS_FILE")"
check_eq "queue health records timeout reason" "timeout" "$(jq -r '.degradationReason' "$STATE_DIR/queue-health.json")"
assert_no_temp_files

external_cancel_planner="$TEST_TMP/planner-external-cancel.sh"
cat > "$external_cancel_planner" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
kill -TERM "$PPID"
sleep 5
EOF
chmod +x "$external_cancel_planner"

if printf '%s' "$plan_input" | run_queue_planner_with_policy "\"$external_cancel_planner\"" 5 "$input_snapshot" >/dev/null; then
  fail "wrapper fails external cancellation"
else
  pass "wrapper fails external cancellation"
fi
check_contains "external diagnostics include 143" "$(cat "$FETCH_QUEUE_PLAN_DIAGNOSTICS_FILE")" "exit=143"
check_eq "external 143 classifies as external cancellation" "external_cancellation" "$(get_queue_failure_reason "$FETCH_QUEUE_PLAN_DIAGNOSTICS_FILE")"
check_eq "queue health records external cancellation" "external_cancellation" "$(jq -r '.degradationReason' "$STATE_DIR/queue-health.json")"
assert_no_temp_files

echo ""
echo "=== HOK-3130: inference report degrades a successful plan ==="

report_planner="$TEST_TMP/planner-inference-failed.sh"
cat > "$report_planner" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
report_file=""
while (( $# > 0 )); do
  if [[ "$1" == "--inference-report-file" ]]; then report_file="$2"; shift; fi
  shift
done
[[ -n "$report_file" ]] && printf '%s\n' '{"schemaVersion":1,"inferenceStatus":"failed","inferredEdgeCount":0,"attempted":true,"refreshKind":"full","skipReason":null,"model":null,"lastAttemptAt":"2026-09-30T12:00:00.000Z","lastSuccessAt":null,"consecutiveFailures":1,"error":"classifier timeout"}' > "$report_file"
printf '{"availableNow":["HOK-1"],"queuedAfterDependencies":[],"avoidRunningTogether":[],"needsTriage":[]}\n'
EOF
chmod +x "$report_planner"

report_path="$TEST_TMP/inference-report.json"
result="$(printf '%s' "$plan_input" | run_queue_planner_with_policy "\"$report_planner\" --inference-report-file \"$report_path\"" 5 "$input_snapshot" "$report_path")"
check_eq "inference failure still returns the plan" "HOK-1" "$(printf '%s' "$result" | jq -r '.availableNow[0]')"
check_eq "inference failure degrades queue health" "degraded" "$(jq -r '.status' "$STATE_DIR/queue-health.json")"
check_eq "inference failure reason" "inference_unavailable" "$(jq -r '.degradationReason' "$STATE_DIR/queue-health.json")"
check_eq "inference failure next action" "use_explicit_edges_only" "$(jq -r '.nextAction' "$STATE_DIR/queue-health.json")"
check_eq "inference failure sets no planner backoff" "null" "$(jq -r '.nextRetryAt' "$STATE_DIR/queue-health.json")"
assert_no_temp_files

# build_queue_plan_once owns the report tmpfile: it must pass it to the
# planner and remove it afterwards. `npx` is stubbed so the real planner
# command line is exercised without spawning tsx.
npx() {
  shift 2  # tsx <plan-queue.ts>
  "$report_planner" "$@"
}
export -f npx 2>/dev/null || true
printf '{}\n' > "$STATE_DIR/queue-health.json"
backlog_json='[{"identifier":"HOK-1","title":"Ready task","labels":{"nodes":[]},"state":{"name":"Todo"}}]'
built_plan="$(PROJECT_NAME="stdin-policy-test" TOOLS_DIR="$TEST_TMP/tools" build_queue_plan_once "$backlog_json")"
unset -f npx
check_eq "build_queue_plan_once returns the plan" "HOK-1" "$(printf '%s' "$built_plan" | jq -r '.availableNow[0]')"
check_eq "build_queue_plan_once records inference_unavailable" "inference_unavailable" "$(jq -r '.degradationReason' "$STATE_DIR/queue-health.json")"
check_eq "inference report tmpfile removed" "" "$(find "$TMPDIR" -maxdepth 1 -name 'wavemill-queue-inference.*' -print)"

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
if (( FAIL > 0 )); then
  exit 1
fi
