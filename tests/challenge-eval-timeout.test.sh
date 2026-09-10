#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"
STATUS_SCRIPT="$REPO_DIR/shared/lib/wavemill-status.sh"

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
    printf '%s\n' "$haystack" | sed 's/^/      /'
    fail "$name"
  fi
}

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

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

FUNCTION_FILE="$TEST_TMP/challenge-timeout-functions.sh"
: > "$FUNCTION_FILE"
for fn in \
  challenge_eval_retry_max_attempts:1 \
  write_challenge_pair_state:1 \
  challenge_pair_timed_out_sides_csv:1 \
  challenge_pair_timeout_reason:1 \
  challenge_pair_manual_artifact_path:1 \
  write_manual_challenge_comparison_artifact:1
do
  IFS=: read -r name occurrence <<<"$fn"
  extract_function_occurrence "$MILL_SCRIPT" "$name" "$occurrence" >> "$FUNCTION_FILE"
  printf '\n' >> "$FUNCTION_FILE"
done
# poll_challenge_jobs lives only in the committed monitor script (HOK-2899
# extracted the heredoc body; the mill copy no longer exists).
extract_function_occurrence "$MONITOR_SCRIPT_FILE" "poll_challenge_jobs" 1 >> "$FUNCTION_FILE"
printf '\n' >> "$FUNCTION_FILE"

STATUS_FUNCTION_FILE="$TEST_TMP/challenge-timeout-status-functions.sh"
: > "$STATUS_FUNCTION_FILE"
for fn in \
  parse_iso_timestamp_epoch:1 \
  format_running_elapsed:1 \
  task_running_detail:1
do
  IFS=: read -r name occurrence <<<"$fn"
  extract_function_occurrence "$STATUS_SCRIPT" "$name" "$occurrence" >> "$STATUS_FUNCTION_FILE"
  printf '\n' >> "$STATUS_FUNCTION_FILE"
done

if [[ ! -s "$FUNCTION_FILE" || ! -s "$STATUS_FUNCTION_FILE" ]]; then
  echo "Could not extract timeout/status functions"
  exit 1
fi

cat > "$TEST_TMP/run-case.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

source "$REPO_DIR/shared/lib/wavemill-common.sh"
source "$FUNCTION_FILE"
source "$STATUS_FUNCTION_FILE"

STATE_FILE="$CASE_DIR/state.json"
REPO_DIR="$CASE_DIR/repo"
WORKTREE_ROOT="$CASE_DIR/worktrees"
TOOLS_DIR="$CASE_DIR/tools"
LOG_OUTPUT=""
RETRY_CALLS=""
POLL_JSON=""

mkdir -p "$REPO_DIR" "$WORKTREE_ROOT" "$TOOLS_DIR"

log() { printf -v LOG_OUTPUT "%s%s\n" "$LOG_OUTPUT" "$2"; }
challenge_eval_retry_max_attempts() { printf '%s\n' "${RETRY_MAX_OVERRIDE:-1}"; }
log_warn() { printf -v LOG_OUTPUT "%sWARN: %s\n" "$LOG_OUTPUT" "$1"; }
settle_tracked_job() {
  local job_id="$1"
  state_mutate "$STATE_FILE" '
    .jobs[$jobId].settled = true
    | .tasks[$issue].evalFailed = true
    | .tasks[$issue] |= (del(.evalRunning) | .updated = (now | todateiso8601))
  ' --arg jobId "$job_id" --arg issue "$SETTLE_ISSUE"
}
eval_record_exists_for_issue_pr() { return 1; }
maybe_run_challenge_eval() {
  printf -v RETRY_CALLS "%s%s|%s|%s|%s\n" "$RETRY_CALLS" "$1" "$2" "$3" "$4"
}
npx() {
  if [[ "$*" == *"job-tracker.ts poll"* ]]; then
    printf '%s\n' "$POLL_JSON"
    return 0
  fi
  return 1
}
read_state_value() {
  local default="$1"
  shift
  local value
  if value=$(jq -r "$@" "$STATE_FILE" 2>/dev/null); then
    if [[ -z "$value" || "$value" == "null" ]]; then
      printf '%s\n' "$default"
    else
      printf '%s\n' "$value"
    fi
  else
    printf '%s\n' "$default"
  fi
}

run_retry_case() {
  cat > "$STATE_FILE" <<JSON
{
  "tasks": {
    "HOK-2269": {
      "slug": "hok-2269",
      "branch": "task/hok-2269",
      "worktree": "$WORKTREE_ROOT/hok-2269",
      "pr": "754",
      "status": "ready",
      "phase": "ready",
      "evalCompleted": false,
      "evalFailed": false,
      "challenge": true,
      "challengePairId": "HOK-2269",
      "challengeRole": "primary"
    },
    "HOK-2269_c": {
      "slug": "hok-2269-c",
      "branch": "task/hok-2269-c",
      "worktree": "$WORKTREE_ROOT/hok-2269-c",
      "pr": "755",
      "status": "ready",
      "phase": "ready",
      "evalCompleted": true,
      "evalFailed": false,
      "challenge": true,
      "challengePairId": "HOK-2269",
      "challengeRole": "challenger"
    }
  },
  "jobs": {
    "eval-HOK-2269-primary-754": {
      "id": "eval-HOK-2269-primary-754",
      "kind": "eval",
      "issueId": "HOK-2269",
      "pairId": "HOK-2269",
      "side": "primary",
      "status": "timeout"
    }
  }
}
JSON
  mkdir -p "$WORKTREE_ROOT/hok-2269/features/hok-2269/ready"
  mkdir -p "$WORKTREE_ROOT/hok-2269-c/features/hok-2269-c/ready"
  POLL_JSON='{"unsettled":[{"id":"eval-HOK-2269-primary-754","kind":"eval","status":"timeout","issueId":"HOK-2269","pairId":"HOK-2269","side":"primary","reason":"timed_out","logPath":"/tmp/primary.log"}]}'
  SETTLE_ISSUE="HOK-2269"
  poll_challenge_jobs
  printf 'retry_state=%s\n' "$(jq -r '.tasks["HOK-2269"].comparisonState' "$STATE_FILE")"
  printf 'retry_reason=%s\n' "$(jq -r '.tasks["HOK-2269"].comparisonBlockedReason' "$STATE_FILE")"
  printf 'retry_count=%s\n' "$(jq -r '.tasks["HOK-2269"].comparisonRetryCount' "$STATE_FILE")"
  printf 'retry_max=%s\n' "$(jq -r '.tasks["HOK-2269"].comparisonRetryMaxAttempts' "$STATE_FILE")"
  printf 'retry_failed=%s\n' "$(jq -r '.tasks["HOK-2269"].evalFailed' "$STATE_FILE")"
  printf 'retry_calls=%s\n' "$(printf '%s' "$RETRY_CALLS" | tr '\n' ';')"
}

run_second_retry_case() {
  cat > "$STATE_FILE" <<JSON
{
  "tasks": {
    "HOK-2269": {
      "slug": "hok-2269",
      "branch": "task/hok-2269",
      "worktree": "$WORKTREE_ROOT/hok-2269",
      "pr": "754",
      "status": "ready",
      "phase": "ready",
      "evalCompleted": false,
      "evalFailed": false,
      "challenge": true,
      "challengePairId": "HOK-2269",
      "challengeRole": "primary",
      "comparisonState": "retrying_eval",
      "comparisonRetryCount": 1,
      "comparisonRetryMaxAttempts": 2,
      "comparisonTimedOutSides": ["primary"]
    },
    "HOK-2269_c": {
      "slug": "hok-2269-c",
      "branch": "task/hok-2269-c",
      "worktree": "$WORKTREE_ROOT/hok-2269-c",
      "pr": "755",
      "status": "ready",
      "phase": "ready",
      "evalCompleted": true,
      "evalFailed": false,
      "challenge": true,
      "challengePairId": "HOK-2269",
      "challengeRole": "challenger",
      "comparisonState": "retrying_eval",
      "comparisonRetryCount": 1,
      "comparisonRetryMaxAttempts": 2,
      "comparisonTimedOutSides": ["primary"]
    }
  },
  "jobs": {
    "eval-HOK-2269-primary-754": {
      "id": "eval-HOK-2269-primary-754",
      "kind": "eval",
      "issueId": "HOK-2269",
      "pairId": "HOK-2269",
      "side": "primary",
      "status": "timeout"
    }
  }
}
JSON
  mkdir -p "$WORKTREE_ROOT/hok-2269/features/hok-2269/ready"
  mkdir -p "$WORKTREE_ROOT/hok-2269-c/features/hok-2269-c/ready"
  POLL_JSON='{"unsettled":[{"id":"eval-HOK-2269-primary-754","kind":"eval","status":"timeout","issueId":"HOK-2269","pairId":"HOK-2269","side":"primary","reason":"timed_out","logPath":"/tmp/primary.log"}]}'
  SETTLE_ISSUE="HOK-2269"
  poll_challenge_jobs
  printf 'second_state=%s\n' "$(jq -r '.tasks["HOK-2269"].comparisonState' "$STATE_FILE")"
  printf 'second_count=%s\n' "$(jq -r '.tasks["HOK-2269"].comparisonRetryCount' "$STATE_FILE")"
  printf 'second_max=%s\n' "$(jq -r '.tasks["HOK-2269"].comparisonRetryMaxAttempts' "$STATE_FILE")"
  printf 'second_calls=%s\n' "$(printf '%s' "$RETRY_CALLS" | tr '\n' ';')"
}

run_exhausted_retry_case() {
  cat > "$STATE_FILE" <<JSON
{
  "tasks": {
    "HOK-2269": {
      "slug": "hok-2269",
      "branch": "task/hok-2269",
      "worktree": "$WORKTREE_ROOT/hok-2269",
      "pr": "754",
      "status": "ready",
      "phase": "ready",
      "evalCompleted": false,
      "evalFailed": false,
      "challenge": true,
      "challengePairId": "HOK-2269",
      "challengeRole": "primary",
      "comparisonState": "retrying_eval",
      "comparisonRetryCount": 2,
      "comparisonRetryMaxAttempts": 2,
      "comparisonTimedOutSides": ["primary"]
    },
    "HOK-2269_c": {
      "slug": "hok-2269-c",
      "branch": "task/hok-2269-c",
      "worktree": "$WORKTREE_ROOT/hok-2269-c",
      "pr": "755",
      "status": "ready",
      "phase": "ready",
      "evalCompleted": true,
      "evalFailed": false,
      "challenge": true,
      "challengePairId": "HOK-2269",
      "challengeRole": "challenger",
      "comparisonState": "retrying_eval",
      "comparisonRetryCount": 2,
      "comparisonRetryMaxAttempts": 2,
      "comparisonTimedOutSides": ["primary"]
    }
  },
  "jobs": {
    "eval-HOK-2269-primary-754": {
      "id": "eval-HOK-2269-primary-754",
      "kind": "eval",
      "issueId": "HOK-2269",
      "pairId": "HOK-2269",
      "side": "primary",
      "status": "timeout"
    }
  }
}
JSON
  mkdir -p "$WORKTREE_ROOT/hok-2269/features/hok-2269/ready"
  mkdir -p "$WORKTREE_ROOT/hok-2269-c/features/hok-2269-c/ready"
  POLL_JSON='{"unsettled":[{"id":"eval-HOK-2269-primary-754","kind":"eval","status":"timeout","issueId":"HOK-2269","pairId":"HOK-2269","side":"primary","reason":"timed_out","logPath":"/tmp/primary.log"}]}'
  SETTLE_ISSUE="HOK-2269"
  poll_challenge_jobs
  printf 'exhausted_state=%s\n' "$(jq -r '.tasks["HOK-2269"].comparisonState' "$STATE_FILE")"
  printf 'exhausted_count=%s\n' "$(jq -r '.tasks["HOK-2269"].comparisonRetryCount' "$STATE_FILE")"
  printf 'exhausted_max=%s\n' "$(jq -r '.tasks["HOK-2269"].comparisonRetryMaxAttempts' "$STATE_FILE")"
  printf 'exhausted_calls=%s\n' "$(printf '%s' "$RETRY_CALLS" | tr '\n' ';')"
}

run_manual_case() {
  cat > "$STATE_FILE" <<JSON
{
  "tasks": {
    "HOK-2269": {
      "slug": "hok-2269",
      "branch": "task/hok-2269",
      "worktree": "$WORKTREE_ROOT/hok-2269",
      "pr": "754",
      "status": "ready",
      "phase": "ready",
      "evalCompleted": false,
      "evalFailed": false,
      "challenge": true,
      "challengePairId": "HOK-2269",
      "challengeRole": "primary",
      "comparisonState": "retrying_eval",
      "comparisonRetryCount": 1,
      "comparisonRetryMaxAttempts": 1,
      "comparisonTimedOutSides": ["primary"]
    },
    "HOK-2269_c": {
      "slug": "hok-2269-c",
      "branch": "task/hok-2269-c",
      "worktree": "$WORKTREE_ROOT/hok-2269-c",
      "pr": "755",
      "status": "ready",
      "phase": "ready",
      "evalCompleted": false,
      "evalFailed": false,
      "challenge": true,
      "challengePairId": "HOK-2269",
      "challengeRole": "challenger",
      "comparisonState": "retrying_eval",
      "comparisonRetryCount": 1,
      "comparisonRetryMaxAttempts": 1,
      "comparisonTimedOutSides": ["primary"]
    }
  },
  "jobs": {
    "eval-HOK-2269_c-challenger-755": {
      "id": "eval-HOK-2269_c-challenger-755",
      "kind": "eval",
      "issueId": "HOK-2269_c",
      "pairId": "HOK-2269",
      "side": "challenger",
      "status": "timeout"
    }
  }
}
JSON
  mkdir -p "$WORKTREE_ROOT/hok-2269/features/hok-2269/ready"
  mkdir -p "$WORKTREE_ROOT/hok-2269-c/features/hok-2269-c/ready"
  POLL_JSON='{"unsettled":[{"id":"eval-HOK-2269_c-challenger-755","kind":"eval","status":"timeout","issueId":"HOK-2269_c","pairId":"HOK-2269","side":"challenger","reason":"timed_out","logPath":"/tmp/challenger.log"}]}'
  SETTLE_ISSUE="HOK-2269_c"
  poll_challenge_jobs
  printf 'manual_state=%s\n' "$(jq -r '.tasks["HOK-2269"].comparisonState' "$STATE_FILE")"
  printf 'manual_reason=%s\n' "$(jq -r '.tasks["HOK-2269"].comparisonBlockedReason' "$STATE_FILE")"
  printf 'manual_sides=%s\n' "$(jq -r '.tasks["HOK-2269"].comparisonTimedOutSides | join(",")' "$STATE_FILE")"
  printf 'manual_artifact=%s\n' "$(jq -r '.tasks["HOK-2269"].manualComparisonArtifact' "$STATE_FILE")"
  printf 'manual_detail=%s\n' "$(task_running_detail "HOK-2269" | tr '\n' ';')"
}

"run_${CASE_NAME}_case"
printf 'logs=%s\n' "$(printf '%s' "$LOG_OUTPUT" | tr '\n' ';')"
EOF
chmod +x "$TEST_TMP/run-case.sh"

echo "=== Challenge Eval Timeout State ==="

retry_output="$(CASE_NAME=retry CASE_DIR="$TEST_TMP/retry" REPO_DIR="$REPO_DIR" FUNCTION_FILE="$FUNCTION_FILE" STATUS_FUNCTION_FILE="$STATUS_FUNCTION_FILE" "$TEST_TMP/run-case.sh")"
second_retry_output="$(CASE_NAME=second_retry RETRY_MAX_OVERRIDE=2 CASE_DIR="$TEST_TMP/second_retry" REPO_DIR="$REPO_DIR" FUNCTION_FILE="$FUNCTION_FILE" STATUS_FUNCTION_FILE="$STATUS_FUNCTION_FILE" "$TEST_TMP/run-case.sh")"
exhausted_retry_output="$(CASE_NAME=exhausted_retry RETRY_MAX_OVERRIDE=2 CASE_DIR="$TEST_TMP/exhausted_retry" REPO_DIR="$REPO_DIR" FUNCTION_FILE="$FUNCTION_FILE" STATUS_FUNCTION_FILE="$STATUS_FUNCTION_FILE" "$TEST_TMP/run-case.sh")"
manual_output="$(CASE_NAME=manual CASE_DIR="$TEST_TMP/manual" REPO_DIR="$REPO_DIR" FUNCTION_FILE="$FUNCTION_FILE" STATUS_FUNCTION_FILE="$STATUS_FUNCTION_FILE" "$TEST_TMP/run-case.sh")"

check_contains "primary timeout enters retrying state" "$retry_output" "retry_state=retrying_eval"
check_contains "primary timeout records explicit blocker reason" "$retry_output" "retry_reason=primary_eval_timed_out"
check_contains "primary timeout increments retry count" "$retry_output" "retry_count=1"
check_contains "primary timeout records retry max" "$retry_output" "retry_max=1"
check_contains "primary timeout clears evalFailed for retry launch" "$retry_output" "retry_failed=false"
check_contains "primary timeout relaunches eval" "$retry_output" "retry_calls=HOK-2269|754|task/hok-2269|hok-2269;"
check_contains "primary timeout logs pair retry" "$retry_output" "challenge comparison retrying for HOK-2269: primary eval timed out"

check_contains "second retry stays in retrying_eval" "$second_retry_output" "second_state=retrying_eval"
check_contains "second retry increments count (1->2)" "$second_retry_output" "second_count=2"
check_contains "second retry preserves retry_max=2" "$second_retry_output" "second_max=2"
check_contains "second retry relaunches eval" "$second_retry_output" "second_calls=HOK-2269|754|task/hok-2269|hok-2269;"

check_contains "exhausted retry exits to manual_comparison_needed" "$exhausted_retry_output" "exhausted_state=manual_comparison_needed"
check_contains "exhausted retry preserves count at retry_max" "$exhausted_retry_output" "exhausted_count=2"
check_contains "exhausted retry does not relaunch eval" "$exhausted_retry_output" "exhausted_calls=
"

check_contains "challenger timeout exhausts into manual state" "$manual_output" "manual_state=manual_comparison_needed"
check_contains "challenger timeout records both timed out sides" "$manual_output" "manual_sides=primary,challenger"
check_contains "challenger timeout records pair-level reason" "$manual_output" "manual_reason=both_eval_timed_out"
check_contains "challenger timeout writes manual artifact" "$manual_output" "manual_artifact=$TEST_TMP/manual/worktrees/hok-2269/features/hok-2269/ready/challenge-comparison-needed.md"
check_contains "status detail renders manual comparison state" "$manual_output" "manual_detail=manual comparison needed: timed_out=primary/challenger artifact=$TEST_TMP/manual/worktrees/hok-2269/features/hok-2269/ready/challenge-comparison-needed.md;"
check_contains "manual state logs pair blocker" "$manual_output" "challenge comparison blocked for HOK-2269: primary,challenger eval timed out. manual comparison needed"

echo ""
echo "Passed: $PASS"
echo "Failed: $FAIL"

if [[ $FAIL -ne 0 ]]; then
  exit 1
fi
