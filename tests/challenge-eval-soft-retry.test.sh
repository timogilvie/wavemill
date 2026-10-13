#!/usr/bin/env bash
# Regression tests for the challenge-eval soft (timed-out) retry path on the
# shared bounded-retry helper (HOK-2924): ceiling, head-keyed reset, state
# mirror compatibility, and the greppable exhaustion sentinel.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

check_eq() {
  local name="$1" actual="$2" expected="$3"
  if [[ "$actual" == "$expected" ]]; then
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

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

# Brace-aware extractor (strings stripped) — poll_tracked_jobs contains
# braces inside jq programs and quoted strings.
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
    $0 ~ "^" name "\\(\\)[[:space:]]*\\{" { capture = 1; depth = 0 }
    capture {
      print
      depth += brace_delta($0)
      if (depth == 0) { exit }
    }
  ' "$source_file"
}

# shellcheck source=../shared/lib/wavemill-common.sh
source "$REPO_DIR/shared/lib/wavemill-common.sh"

FUNC_FILE="$TEST_TMP/poll_tracked_jobs.sh"
extract_function "$MONITOR_SCRIPT_FILE" "poll_tracked_jobs" > "$FUNC_FILE"
if ! grep -q "challenge-eval-soft" "$FUNC_FILE"; then
  echo "Could not extract poll_tracked_jobs() with the soft-retry bucket"
  exit 1
fi
# shellcheck source=/dev/null
source "$FUNC_FILE"

ISSUE="HOK-9001"
PAIR="HOK-9001"
SLUG="hok-9001"
WORKTREE_ROOT="$TEST_TMP/worktrees"
FEATURE_DIR="$WORKTREE_ROOT/$SLUG/features/$SLUG"
STATE_FILE="$TEST_TMP/state.json"
TOOLS_DIR="$TEST_TMP/tools"
GIT_HEAD="sha-one"

mkdir -p "$FEATURE_DIR" "$TOOLS_DIR"

reset_state() {
  local retry_mirror="${1:-0}"
  cat > "$STATE_FILE" <<JSON
{
  "tasks": {
    "$ISSUE": {
      "slug": "$SLUG",
      "branch": "task/$SLUG",
      "pr": "101",
      "comparisonRetryCount": $retry_mirror
    },
    "${ISSUE}_c": {
      "slug": "${SLUG}-c",
      "branch": "task/${SLUG}-c",
      "pr": "102"
    }
  }
}
JSON
}

POLL_JSON='{"unsettled":[{"id":"job-1","kind":"eval","status":"failed","reason":"timed_out","issueId":"HOK-9001","pairId":"HOK-9001","side":"primary","prNumbers":["101"]}]}'

# --- stubs -------------------------------------------------------------------
reset_capture() {
  EVAL_RELAUNCHES=0
  PAIR_STATE_CALLS=""
  LOG_OUTPUT=""
}

npx() { printf '%s\n' "$POLL_JSON"; }
git() {
  if [[ "${1:-}" == "-C" && "${3:-}" == "rev-parse" ]]; then
    printf '%s\n' "$GIT_HEAD"
    return 0
  fi
  return 1
}
read_state_value() {
  local default="$1"
  shift
  local value
  if value=$(jq -r "$@" "$STATE_FILE" 2>/dev/null); then
    printf '%s\n' "$value"
  else
    printf '%s\n' "$default"
  fi
}
log() { LOG_OUTPUT+="$*"$'\n'; }
log_warn() { LOG_OUTPUT+="WARN:$*"$'\n'; }
settle_tracked_job() { :; }
eval_record_exists_for_issue_pr() { return 1; }
mark_eval_completed() { :; }
handle_comparison_job_success() { :; }
maybe_run_challenge_eval() { EVAL_RELAUNCHES=$((EVAL_RELAUNCHES + 1)); }
challenge_eval_retry_max_attempts() { printf '2\n'; }
challenge_pair_timed_out_sides_csv() { printf '\n'; }
challenge_pair_timeout_reason() { printf 'eval timed out\n'; }
write_manual_challenge_comparison_artifact() { printf '%s\n' "$TEST_TMP/manual-artifact.json"; }
write_challenge_pair_state() {
  PAIR_STATE_CALLS+="${1-}|${2-}|${3-}|${4-}|${5-}"$'\n'
}

soft_count() { bounded_retry_count "$FEATURE_DIR" "challenge-eval-soft"; }

# --- first timeout retries and counts against the bucket ---------------------
reset_state 0
reset_capture
poll_tracked_jobs
check_eq "first timeout relaunches the eval" "$EVAL_RELAUNCHES" "1"
check_eq "first timeout counts attempt 1 in the bucket" "$(soft_count)" "1"
check_eq "first timeout keys the bucket to the arm head" \
  "$(bounded_retry_head "$FEATURE_DIR" challenge-eval-soft)" "sha-one"
check_contains "first timeout writes retrying pair state" "$PAIR_STATE_CALLS" "HOK-9001|retrying_eval|eval timed out|1|2"
check_contains "first timeout logs the attempt" "$LOG_OUTPUT" "(attempt 1/2)"

# --- second timeout consumes the last attempt --------------------------------
reset_capture
poll_tracked_jobs
check_eq "second timeout relaunches the eval" "$EVAL_RELAUNCHES" "1"
check_eq "second timeout counts attempt 2" "$(soft_count)" "2"
check_contains "second timeout logs the attempt" "$LOG_OUTPUT" "(attempt 2/2)"

# --- third timeout exhausts the budget with a recorded reason ----------------
reset_capture
poll_tracked_jobs
check_eq "exhausted timeout does not relaunch" "$EVAL_RELAUNCHES" "0"
check_contains "exhausted timeout blocks the comparison" "$PAIR_STATE_CALLS" "HOK-9001|manual_comparison_needed"
if bounded_retry_is_exhausted "$FEATURE_DIR" "challenge-eval-soft"; then
  pass "exhausted timeout writes the terminal sentinel"
else
  fail "exhausted timeout writes the terminal sentinel"
fi
check_contains "exhausted timeout records a greppable reason" \
  "$(bounded_retry_exhaustion_reason "$FEATURE_DIR" challenge-eval-soft)" \
  "Challenge eval soft retries exhausted for HOK-9001"

# --- a fresh commit on the arm restores the budget ---------------------------
reset_capture
GIT_HEAD="sha-two"
poll_tracked_jobs
check_eq "new head relaunches the eval" "$EVAL_RELAUNCHES" "1"
check_eq "new head restarts the counter" "$(soft_count)" "1"
if bounded_retry_is_exhausted "$FEATURE_DIR" "challenge-eval-soft"; then
  fail "new head clears the exhausted sentinel"
else
  pass "new head clears the exhausted sentinel"
fi
check_contains "new head retry logs attempt 1" "$LOG_OUTPUT" "(attempt 1/2)"
GIT_HEAD="sha-one"

# --- pre-existing state mirror is honored (upgrade path) ---------------------
rm -rf "$FEATURE_DIR"
mkdir -p "$FEATURE_DIR"
reset_state 2
reset_capture
poll_tracked_jobs
check_eq "mirrored retry count blocks further retries" "$EVAL_RELAUNCHES" "0"
check_contains "mirrored retry count reaches manual comparison" "$PAIR_STATE_CALLS" "manual_comparison_needed"

echo ""
echo "challenge-eval-soft-retry: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
