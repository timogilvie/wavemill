#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

extract_function_occurrence() {
  local source_file="$1"
  local function_name="$2"
  local occurrence="$3"
  awk -v name="$function_name" -v target="$occurrence" '
    function brace_delta(line, stripped, opens, closes) {
      stripped = line
      gsub(/"([^"\\]|\\.)*"/, "\"\"", stripped)
      gsub(/\047([^\047\\]|\\.)*\047/, "\047\047", stripped)
      opens = gsub(/\{/, "{", stripped)
      closes = gsub(/\}/, "}", stripped)
      return opens - closes
    }
    $0 ~ "^" name "\\(\\)[[:space:]]*\\{" {
      count++
      if (count == target) {
        capture = 1
        depth = 0
      }
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

check_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$label"
  else
    echo "    missing: $needle"
    fail "$label"
  fi
}

check_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$label"
  else
    echo "    expected: $expected"
    echo "    actual:   $actual"
    fail "$label"
  fi
}

echo "=== Challenge Running State ==="

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

FUNCTION_FILE="$TEST_TMP/challenge-running-functions.sh"
: > "$FUNCTION_FILE"
# save_task_state is provided by sourcing wavemill-common.sh below (HOK-2900
# canonicalization); only monitor-local helpers are extracted here.
for fn in \
  mark_challenge_eval_running:1:mill \
  clear_challenge_eval_running:1:mill \
  mark_challenge_comparison_running:1:mill \
  clear_challenge_comparison_running:1:mill \
  sanitize_job_token:1:monitor \
  challenge_job_dir:1:monitor \
  build_eval_job_id:1:monitor \
  build_comparison_job_id:1:monitor \
  read_job_state_value:1:monitor \
  launch_tracked_job:1:monitor \
  challenge_eval_current_head_state:1:monitor \
  maybe_run_challenge_eval:1:monitor \
  post_merge_eval_timeout_seconds:1:monitor \
  challenge_comparison_check_only_evidence:1:monitor \
  maybe_run_challenge_comparison:1:monitor
do
  IFS=: read -r name occurrence source <<<"$fn"
  source_file="$MILL_SCRIPT"
  [[ "$source" == "monitor" ]] && source_file="$MONITOR_SCRIPT_FILE"
  extract_function_occurrence "$source_file" "$name" "$occurrence" >> "$FUNCTION_FILE"
  printf '\n' >> "$FUNCTION_FILE"
done

if [[ ! -s "$FUNCTION_FILE" ]]; then
  echo "Could not extract challenge running-state functions"
  exit 1
fi

TEST_DIR="$TEST_TMP/case"
mkdir -p "$TEST_DIR"
STATE_FILE="$TEST_DIR/state.json"
SNAPSHOT_DIR="$TEST_DIR/snapshots"
mkdir -p "$SNAPSHOT_DIR"

cat > "$STATE_FILE" <<'JSON'
{
  "tasks": {
    "HOK-1563": {
      "slug": "hok-1563",
      "branch": "task/hok-1563",
      "worktree": "/tmp/hok-1563",
      "pr": "101",
      "status": "ready",
      "agent": "codex",
      "phase": "ready",
      "evalCompleted": false,
      "evalFailed": false,
      "challengeCompared": false,
      "challenge": true,
      "challengePairId": "HOK-1563",
      "challengeRole": "primary",
      "challengeModel": "model-a"
    },
    "HOK-1563_c": {
      "slug": "hok-1563-c",
      "branch": "task/hok-1563-c",
      "worktree": "/tmp/hok-1563-c",
      "pr": "102",
      "status": "ready",
      "agent": "codex",
      "phase": "ready",
      "evalCompleted": true,
      "evalFailed": false,
      "challengeCompared": false,
      "challenge": true,
      "challengePairId": "HOK-1563",
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

  SESSION="challenge-running-state-test"
  STATE_FILE="$2"
  SNAPSHOT_DIR="$4"
  REPO_DIR="$(mktemp -d)"
  WORKTREE_ROOT="/tmp"
  TOOLS_DIR="/tmp"
  AGENT_CMD="codex"
  JOB_TRACKER_CALLS=0

  log() { printf "%s\n" "$2"; }
  log_warn() { printf "WARN: %s\n" "$1"; }
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
    if [[ "$*" == *"job-tracker.ts"* ]]; then
      JOB_TRACKER_CALLS=$((JOB_TRACKER_CALLS + 1))
      return 0
    fi
    if [[ "$*" == *"run-eval-hook.ts"* ]]; then
      cp "$STATE_FILE" "$SNAPSHOT_DIR/eval-state.json"
      printf "eval-command-start\n"
      return 0
    fi
    if [[ "$*" == *"compare-prs.ts"* ]]; then
      cp "$STATE_FILE" "$SNAPSHOT_DIR/comparison-state.json"
      printf "comparison-command-start\n"
      return 0
    fi
    return 0
  }

  maybe_run_challenge_eval "HOK-1563" "101" "task/hok-1563" "hok-1563"
  wait || true
  jq ".tasks[\"HOK-1563\"].evalCompleted = true" "$STATE_FILE" > "$STATE_FILE.tmp"
  mv "$STATE_FILE.tmp" "$STATE_FILE"
  maybe_run_challenge_comparison "HOK-1563"
  wait || true
  printf "job_tracker_calls=%s\n" "$JOB_TRACKER_CALLS"
' bash "$FUNCTION_FILE" "$STATE_FILE" "$REPO_DIR" "$SNAPSHOT_DIR" > "$TEST_DIR/output.txt"

OUTPUT="$(cat "$TEST_DIR/output.txt")"

check_contains "eval launch logs running state" "$OUTPUT" "[mill] eval running: issue=HOK-1563 side=primary pr=#101 phase=eval"
check_contains "comparison launch logs running state" "$OUTPUT" "[mill] comparison running: pair=HOK-1563 primary_pr=#101 challenger_pr=#102"
check_eq "eval running state exists before eval command starts" "primary" "$(jq -r '.tasks["HOK-1563"].evalRunning.side // empty' "$SNAPSHOT_DIR/eval-state.json")"
check_eq "eval running state stores PR before eval command starts" "101" "$(jq -r '.tasks["HOK-1563"].evalRunning.pr // empty' "$SNAPSHOT_DIR/eval-state.json")"
check_eq "comparison running state exists on primary task before compare command starts" "HOK-1563" "$(jq -r '.tasks["HOK-1563"].comparisonRunning.pairId // empty' "$SNAPSHOT_DIR/comparison-state.json")"
check_eq "comparison running state exists on challenger task before compare command starts" "HOK-1563" "$(jq -r '.tasks["HOK-1563_c"].comparisonRunning.pairId // empty' "$SNAPSHOT_DIR/comparison-state.json")"
check_eq "tracked jobs still launch after running-state persistence" "2" "$(awk -F= '/job_tracker_calls=/{print $2}' "$TEST_DIR/output.txt")"

echo ""
echo "Passed: $PASS"
echo "Failed: $FAIL"

if [[ $FAIL -ne 0 ]]; then
  exit 1
fi
