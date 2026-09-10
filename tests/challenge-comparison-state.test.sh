#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
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

extract_function_occurrence() {
  local source_file="$1"
  local function_name="$2"
  local occurrence="$3"
  awk -v name="$function_name" -v target="$occurrence" '
    $0 ~ "^" name "\\(\\) \\{" {
      count++
      if (count == target) {
        capture=1
      }
    }
    capture { print }
    capture && $0 == "}" { exit }
  ' "$source_file"
}

extract_function_balanced() {
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
      if (depth == 0) exit
    }
  ' "$source_file"
}

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

FUNCTION_FILE="$TEST_TMP/challenge-comparison-functions.sh"
# save_task_state is provided by sourcing wavemill-common.sh below (HOK-2900
# canonicalization); only monitor-local helpers are extracted here.
extract_function_occurrence "$MONITOR_SCRIPT_FILE" "sanitize_job_token" 1 > "$FUNCTION_FILE"
printf '\n' >> "$FUNCTION_FILE"
extract_function_occurrence "$MONITOR_SCRIPT_FILE" "challenge_job_dir" 1 >> "$FUNCTION_FILE"
printf '\n' >> "$FUNCTION_FILE"
extract_function_occurrence "$MONITOR_SCRIPT_FILE" "build_comparison_job_id" 1 >> "$FUNCTION_FILE"
printf '\n' >> "$FUNCTION_FILE"
extract_function_occurrence "$MONITOR_SCRIPT_FILE" "read_job_state_value" 1 >> "$FUNCTION_FILE"
printf '\n' >> "$FUNCTION_FILE"
extract_function_occurrence "$MONITOR_SCRIPT_FILE" "launch_tracked_job" 1 >> "$FUNCTION_FILE"
printf '\n' >> "$FUNCTION_FILE"
extract_function_occurrence "$MONITOR_SCRIPT_FILE" "challenge_comparison_check_only_evidence" 1 >> "$FUNCTION_FILE"
printf '\n' >> "$FUNCTION_FILE"
extract_function_occurrence "$MONITOR_SCRIPT_FILE" "maybe_run_challenge_comparison" 1 >> "$FUNCTION_FILE"

if [[ ! -s "$FUNCTION_FILE" ]]; then
  echo "Could not extract monitor challenge comparison helpers"
  exit 1
fi

echo "=== Challenge Comparison State Persistence ==="

TEST_DIR="$TEST_TMP/case"
mkdir -p "$TEST_DIR"
STATE_FILE="$TEST_DIR/state.json"

cat > "$STATE_FILE" <<'JSON'
{
  "tasks": {
    "pair-1": {
      "slug": "pair-1",
      "branch": "task/pair-1",
      "worktree": "/tmp/pair-1",
      "pr": "324",
      "status": "review",
      "agent": "codex",
      "phase": "review",
      "evalCompleted": true,
      "challengeCompared": true,
      "challenge": true,
      "challengePairId": "pair-1",
      "challengeRole": "primary",
      "challengeModel": "model-a"
    },
    "pair-1_c": {
      "slug": "pair-1-c",
      "branch": "task/pair-1-c",
      "worktree": "/tmp/pair-1-c",
      "pr": "325",
      "status": "review",
      "agent": "codex",
      "phase": "review",
      "evalCompleted": true,
      "challengeCompared": true,
      "challenge": true,
      "challengePairId": "pair-1",
      "challengeRole": "challenger",
      "challengeModel": "model-b"
    }
  }
}
JSON

bash -lc '
  set -euo pipefail
  source "$3/shared/lib/wavemill-common.sh"
  source "$1"

  SESSION="challenge-comparison-state-test"
  TOOLS_DIR="/tmp"
  REPO_DIR="$(mktemp -d)"
  STATE_FILE="$2"
  TRACK_LAUNCH_CALLS=0

  log() { :; }
  log_warn() { :; }
  get_linear_issue_id() { printf "%s\n" "$1"; }

  read_state_value() {
    local default="${1:-}"
    shift || true
    local expr="${*: -1}"
    local jq_args=()
    if (( $# > 1 )); then
      jq_args=("${@:1:$#-1}")
    fi
    local result=""
    if result=$(jq -r "${jq_args[@]}" "$expr" "$STATE_FILE" 2>/dev/null); then
      :
    else
      result=""
    fi
    if [[ -z "$result" || "$result" == "null" ]]; then
      printf "%s\n" "$default"
    else
      printf "%s\n" "$result"
    fi
  }

  get_task_meta() {
    local issue="$1" field="$2"
    jq -r --arg issue "$issue" --arg field "$field" \
      ".tasks[\$issue][\$field] // empty" "$STATE_FILE"
  }

  npx() {
    if [[ "$*" == *"job-tracker.ts"* && "$*" == *" launch "* ]]; then
      TRACK_LAUNCH_CALLS=$((TRACK_LAUNCH_CALLS + 1))
    fi
    return 0
  }

  save_task_state "pair-1" "pair-1" "task/pair-1" "/tmp/pair-1" "324" "merged" "codex"

  compared_after_merge=$(jq -r ".tasks[\"pair-1\"].challengeCompared" "$STATE_FILE")
  status_after_merge=$(jq -r ".tasks[\"pair-1\"].status" "$STATE_FILE")

  maybe_run_challenge_comparison "pair-1_c"
  launches_after_compared="$TRACK_LAUNCH_CALLS"

  jq --arg id "comparison-pair-1-324-325" \
    ".jobs = {(\$id): {id:\$id, status:\"running\"}}" "$STATE_FILE" > "$STATE_FILE.tmp"
  mv "$STATE_FILE.tmp" "$STATE_FILE"

  maybe_run_challenge_comparison "pair-1_c"

  printf "%s\n%s\n%s\n%s\n" "$compared_after_merge" "$status_after_merge" "$launches_after_compared" "$TRACK_LAUNCH_CALLS"
' bash "$FUNCTION_FILE" "$STATE_FILE" "$REPO_DIR" > "$TEST_DIR/output.txt"

mapfile -t RESULTS < "$TEST_DIR/output.txt"

check_eq "challengeCompared survives canonical save_task_state" "true" "${RESULTS[0]:-}"
check_eq "merge update still sets merged status" "merged" "${RESULTS[1]:-}"
check_eq "comparison does not relaunch when already compared" "0" "${RESULTS[2]:-}"
check_eq "active comparison job suppresses duplicate launch" "0" "${RESULTS[3]:-}"

HANDLER_FILE="$TEST_TMP/challenge-comparison-handler.sh"
extract_function_balanced "$MONITOR_SCRIPT_FILE" "handle_comparison_job_success" > "$HANDLER_FILE"
cat > "$TEST_TMP/comparison-result.json" <<'JSON'
{
  "comparison": {
    "winner": "primary",
    "comparisonOutcome": "compared"
  }
}
JSON

handler_output="$(
  HANDLER_FILE="$HANDLER_FILE" RESULT_FILE="$TEST_TMP/comparison-result.json" bash -lc '
    set -u
    source "$HANDLER_FILE"

    CHALLENGE_AUTO_MERGE=true
    WARN_OUTPUT=""
    render_challenge_comparison_summary() { :; }
    mark_challenge_invalid() { :; }
    write_challenge_pair_state() { :; }
    log() { :; }
    log_warn() { WARN_OUTPUT="$*"; }
    pr_state() { printf "CLOSED\n"; }
    gh() { :; }
    cleanup_completed_task() { return 1; }
    get_task_meta() {
      case "$2" in
        challengeModel) printf "test-model\n" ;;
        slug) printf "test-slug\n" ;;
        pr) printf "123\n" ;;
      esac
    }

    set +e
    handle_comparison_job_success "HOK-TEST" "HOK-TEST" "HOK-TEST_c" "122" "123" "$RESULT_FILE"
    rc=$?
    set -e
    printf "%s\n%s\n" "$rc" "$WARN_OUTPUT"
  '
)"
mapfile -t HANDLER_RESULTS <<< "$handler_output"
check_eq "losing-side cleanup failure does not fail comparison handler" "0" "${HANDLER_RESULTS[0]:-}"
if [[ "${HANDLER_RESULTS[1]:-}" == *"losing-side cleanup deferred for HOK-TEST_c"* ]]; then
  pass "losing-side cleanup failure is logged for later recovery"
else
  fail "losing-side cleanup failure is not logged for later recovery"
fi

echo ""
echo "Passed: $PASS"
echo "Failed: $FAIL"

if [[ $FAIL -ne 0 ]]; then
  exit 1
fi
