#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMMON_SCRIPT="$REPO_DIR/shared/lib/wavemill-common.sh"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

check_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$label"
  else
    echo "    missing: $needle"
    printf '%s\n' "$haystack" | sed 's/^/      /'
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

FUNCTION_FILE="$TEST_TMP/challenge-hard-failure-functions.sh"
: > "$FUNCTION_FILE"
for fn in \
  mark_challenge_eval_running:1:mill \
  challenge_eval_hard_failure_max_retries:1:common \
  challenge_pair_hard_failure_reason:1:mill \
  challenge_pair_records_file:1:mill \
  challenge_pr_url_from_number:1:mill \
  challenge_pair_record_exists:1:mill \
  mark_challenge_compared:1:monitor \
  resolve_challenge_pair_hard_failure:1:common \
  sanitize_job_token:1:monitor \
  challenge_job_dir:1:monitor \
  build_eval_job_id:1:monitor \
  read_job_state_value:1:monitor \
  launch_tracked_job:1:monitor \
  post_merge_eval_timeout_seconds:1:monitor \
  challenge_eval_current_head_state:1:monitor \
  challenge_eval_stale_relaunch_allowed:1:monitor \
  write_challenge_pair_state:1:monitor \
  challenge_pair_manual_artifact_path:1:monitor \
  write_manual_challenge_comparison_artifact:1:monitor \
  maybe_run_challenge_eval:1:monitor
do
  IFS=: read -r name occurrence source <<<"$fn"
  source_file="$MILL_SCRIPT"
  [[ "$source" == "monitor" ]] && source_file="$MONITOR_SCRIPT_FILE"
  [[ "$source" == "common" ]] && source_file="$COMMON_SCRIPT"
  extract_function_occurrence "$source_file" "$name" "$occurrence" >> "$FUNCTION_FILE"
  printf '\n' >> "$FUNCTION_FILE"
done

if [[ ! -s "$FUNCTION_FILE" ]]; then
  echo "Could not extract hard-failure functions"
  exit 1
fi

cat > "$TEST_TMP/run-case.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

source "$REPO_DIR/shared/lib/wavemill-common.sh"
source "$FUNCTION_FILE"

STATE_FILE="$CASE_DIR/state.json"
REPO_DIR="$CASE_DIR/repo"
WORKTREE_ROOT="$CASE_DIR/worktrees"
TOOLS_DIR="$CASE_DIR/tools"
SESSION="challenge-hard-failure-test"
AGENT_CMD="codex"
LOG_OUTPUT=""
EVAL_LAUNCHES=0
JOB_TRACKER_CALLS=0
PR_CLOSES=0
CLEANUPS=0

mkdir -p "$REPO_DIR" "$WORKTREE_ROOT" "$TOOLS_DIR" "$REPO_DIR/.wavemill/evals"

log() { printf -v LOG_OUTPUT "%s%s\n" "$LOG_OUTPUT" "$2"; }
log_warn() { printf -v LOG_OUTPUT "%sWARN: %s\n" "$LOG_OUTPUT" "$1"; }
get_linear_issue_id() { printf '%s\n' "$1"; }
pr_state() { printf 'OPEN\n'; }
cleanup_completed_task() {
  CLEANUPS=$((CLEANUPS + 1))
}
wavemill_load_config() {
  if [[ -n "${CONFIG_JSON:-}" ]]; then
    printf '%s\n' "$CONFIG_JSON"
  else
    printf '%s\n' '{"eval":{"postMergeTimeoutSeconds":600}}'
  fi
}

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
    printf '%s\n' "$default"
  else
    printf '%s\n' "$result"
  fi
}

get_task_meta() {
  local issue="$1" field="$2"
  jq -r --arg issue "$issue" --arg field "$field" \
    ".tasks[\$issue][\$field] // empty" "$STATE_FILE"
}

gh() {
  if [[ "${1:-}" == "pr" && "${2:-}" == "view" ]]; then
    printf 'https://github.com/example/repo/pull/%s\n' "${3:-0}"
    return 0
  fi
  if [[ "${1:-}" == "pr" && "${2:-}" == "close" ]]; then
    PR_CLOSES=$((PR_CLOSES + 1))
    return 0
  fi
  return 1
}

npx() {
  if [[ "$*" == *"challenge-eval-evidence.ts"* ]]; then
    if [[ -n "${EVIDENCE_JSON:-}" ]]; then
      printf '%s\n' "$EVIDENCE_JSON"
    else
      printf '{"ok":true}\n'
    fi
    return 0
  fi
  if [[ "$*" == *"job-tracker.ts"* ]]; then
    JOB_TRACKER_CALLS=$((JOB_TRACKER_CALLS + 1))
    return 0
  fi
  if [[ "$*" == *"resolve-orphan-challenge-pair.ts"* ]]; then
    local orphan_winner="${ORPHAN_WINNER:-primary}"
    local primary_pr_url="https://github.com/example/repo/pull/101"
    local challenger_pr_url="https://github.com/unknown/unknown/pull/0"
    local primary_model="model-a"
    local challenger_model="unknown"
    local winner_model="model-a"
    if [[ "$orphan_winner" == "challenger" ]]; then
      challenger_pr_url="https://github.com/example/repo/pull/102"
      challenger_model="model-b"
      winner_model="model-b"
    fi
    cat > "$REPO_DIR/.wavemill/evals/challenge-records.jsonl" <<JSON
{"challengePairId":"HOK-2462","primaryModel":"$primary_model","challengerModel":"$challenger_model","primaryPrUrl":"$primary_pr_url","challengerPrUrl":"$challenger_pr_url","primaryEvalScore":0,"challengerEvalScore":0,"winner":"$orphan_winner","winnerModel":"$winner_model","rationale":"Challenge pair became orphaned before a comparison could be launched; the surviving side wins by forfeit.","dimensions":{"completeness":{"primary":0,"challenger":0},"correctness":{"primary":0,"challenger":0},"code_quality":{"primary":0,"challenger":0},"intervention_impact":{"primary":0,"challenger":0},"autonomy":{"primary":0,"challenger":0}},"timestamp":"2026-07-17T00:00:00Z","comparisonOutcome":"forfeit","terminalReason":"orphan_pair"}
JSON
    printf '{"status":"resolved","reason":"orphan-sibling","record":'
    cat "$REPO_DIR/.wavemill/evals/challenge-records.jsonl"
    printf '}\n'
    return 0
  fi
  if [[ "$*" == *"run-eval-hook.ts"* ]]; then
    EVAL_LAUNCHES=$((EVAL_LAUNCHES + 1))
    cp "$STATE_FILE" "$CASE_DIR/eval-launch-state.json"
    printf 'eval-command-start\n'
    return 0
  fi
  return 0
}

run_retry_case() {
  cat > "$STATE_FILE" <<JSON
{
  "tasks": {
    "HOK-2462": {
      "slug": "hok-2462",
      "branch": "task/hok-2462",
      "worktree": "$WORKTREE_ROOT/hok-2462",
      "pr": "101",
      "status": "ready",
      "agent": "codex",
      "phase": "ready",
      "evalCompleted": false,
      "evalFailed": true,
      "challengeCompared": false,
      "challenge": true,
      "challengePairId": "HOK-2462",
      "challengeRole": "primary",
      "challengeModel": "model-a"
    },
    "HOK-2462_c": {
      "slug": "hok-2462-c",
      "branch": "task/hok-2462-c",
      "worktree": "$WORKTREE_ROOT/hok-2462-c",
      "pr": "102",
      "status": "ready",
      "agent": "codex",
      "phase": "ready",
      "evalCompleted": true,
      "evalFailed": false,
      "challengeCompared": false,
      "challenge": true,
      "challengePairId": "HOK-2462",
      "challengeRole": "challenger",
      "challengeModel": "model-b"
    }
  },
  "jobs": {
    "eval-HOK-2462-primary-101": {
      "id": "eval-HOK-2462-primary-101",
      "status": "failed"
    }
  }
}
JSON

  maybe_run_challenge_eval "HOK-2462" "101" "task/hok-2462" "hok-2462"
  wait || true
  printf 'retry_counter=%s\n' "$(jq -r '.tasks["HOK-2462"].evalHardFailureRetryCount // empty' "$STATE_FILE")"
  printf 'retry_failed=%s\n' "$(jq -r '.tasks["HOK-2462"].evalFailed' "$STATE_FILE")"
  printf 'retry_snapshot_exists=%s\n' "$([[ -f "$CASE_DIR/eval-launch-state.json" ]] && echo true || echo false)"
  printf 'retry_snapshot_failed=%s\n' "$(jq -r '.tasks["HOK-2462"].evalFailed' "$CASE_DIR/eval-launch-state.json")"
  printf 'retry_snapshot_counter=%s\n' "$(jq -r '.tasks["HOK-2462"].evalHardFailureRetryCount' "$CASE_DIR/eval-launch-state.json")"
}

run_exhausted_case() {
  cat > "$STATE_FILE" <<JSON
{
  "tasks": {
    "HOK-2462": {
      "slug": "hok-2462",
      "branch": "task/hok-2462",
      "worktree": "$WORKTREE_ROOT/hok-2462",
      "pr": "101",
      "status": "ready",
      "agent": "codex",
      "phase": "ready",
      "evalCompleted": false,
      "evalFailed": true,
      "evalHardFailureRetryCount": 2,
      "challengeCompared": false,
      "challenge": true,
      "challengePairId": "HOK-2462",
      "challengeRole": "primary",
      "challengeModel": "model-a"
    },
    "HOK-2462_c": {
      "slug": "hok-2462-c",
      "branch": "task/hok-2462-c",
      "worktree": "$WORKTREE_ROOT/hok-2462-c",
      "pr": "102",
      "status": "ready",
      "agent": "codex",
      "phase": "ready",
      "evalCompleted": true,
      "evalFailed": false,
      "challengeCompared": false,
      "challenge": true,
      "challengePairId": "HOK-2462",
      "challengeRole": "challenger",
      "challengeModel": "model-b"
    }
  },
  "jobs": {
    "eval-HOK-2462-primary-101": {
      "id": "eval-HOK-2462-primary-101",
      "status": "failed"
    }
  }
}
JSON

  maybe_run_challenge_eval "HOK-2462" "101" "task/hok-2462" "hok-2462"
  maybe_run_challenge_eval "HOK-2462" "101" "task/hok-2462" "hok-2462"
  printf 'terminal_lines=%s\n' "$(wc -l < "$REPO_DIR/.wavemill/evals/challenge-records.jsonl" | tr -d '[:space:]')"
  printf 'terminal_outcome=%s\n' "$(jq -r '.comparisonOutcome' "$REPO_DIR/.wavemill/evals/challenge-records.jsonl")"
  printf 'terminal_reason=%s\n' "$(jq -r '.terminalReason' "$REPO_DIR/.wavemill/evals/challenge-records.jsonl")"
  printf 'terminal_winner=%s\n' "$(jq -r '.winner' "$REPO_DIR/.wavemill/evals/challenge-records.jsonl")"
  printf 'terminal_compared_primary=%s\n' "$(jq -r '.tasks["HOK-2462"].challengeCompared' "$STATE_FILE")"
  printf 'terminal_compared_challenger=%s\n' "$(jq -r '.tasks["HOK-2462_c"].challengeCompared' "$STATE_FILE")"
  printf 'terminal_sentinel=%s\n' "$([[ -f "$WORKTREE_ROOT/hok-2462/features/hok-2462/.retry-challenge-eval-hard-exhausted" ]] && echo present || echo absent)"
  printf 'terminal_sentinel_reason=%s\n' "$(cat "$WORKTREE_ROOT/hok-2462/features/hok-2462/.retry-challenge-eval-hard-exhausted" 2>/dev/null || true)"
}

run_double_case() {
  cat > "$STATE_FILE" <<JSON
{
  "tasks": {
    "HOK-2462": {
      "slug": "hok-2462",
      "branch": "task/hok-2462",
      "worktree": "$WORKTREE_ROOT/hok-2462",
      "pr": "101",
      "status": "ready",
      "agent": "codex",
      "phase": "ready",
      "evalCompleted": false,
      "evalFailed": true,
      "evalHardFailureRetryCount": 2,
      "challengeCompared": false,
      "challenge": true,
      "challengePairId": "HOK-2462",
      "challengeRole": "primary",
      "challengeModel": "model-a"
    },
    "HOK-2462_c": {
      "slug": "hok-2462-c",
      "branch": "task/hok-2462-c",
      "worktree": "$WORKTREE_ROOT/hok-2462-c",
      "pr": "102",
      "status": "ready",
      "agent": "codex",
      "phase": "ready",
      "evalCompleted": false,
      "evalFailed": true,
      "evalHardFailureRetryCount": 2,
      "challengeCompared": false,
      "challenge": true,
      "challengePairId": "HOK-2462",
      "challengeRole": "challenger",
      "challengeModel": "model-b"
    }
  }
}
JSON

  maybe_run_challenge_eval "HOK-2462" "101" "task/hok-2462" "hok-2462"
  maybe_run_challenge_eval "HOK-2462_c" "102" "task/hok-2462-c" "hok-2462-c"
  printf 'double_lines=%s\n' "$(wc -l < "$REPO_DIR/.wavemill/evals/challenge-records.jsonl" | tr -d '[:space:]')"
  printf 'double_outcome=%s\n' "$(jq -r '.comparisonOutcome' "$REPO_DIR/.wavemill/evals/challenge-records.jsonl")"
  printf 'double_reason=%s\n' "$(jq -r '.terminalReason' "$REPO_DIR/.wavemill/evals/challenge-records.jsonl")"
  printf 'double_compared_primary=%s\n' "$(jq -r '.tasks["HOK-2462"].challengeCompared' "$STATE_FILE")"
  printf 'double_compared_challenger=%s\n' "$(jq -r '.tasks["HOK-2462_c"].challengeCompared' "$STATE_FILE")"
}

run_orphan_case() {
  cat > "$STATE_FILE" <<JSON
{
  "tasks": {
    "HOK-2462": {
      "slug": "hok-2462",
      "branch": "task/hok-2462",
      "worktree": "$WORKTREE_ROOT/hok-2462",
      "pr": "101",
      "status": "ready",
      "agent": "codex",
      "phase": "ready",
      "evalCompleted": true,
      "evalFailed": true,
      "evalHardFailureRetryCount": 2,
      "challengeCompared": false,
      "challenge": true,
      "challengePairId": "HOK-2462",
      "challengeRole": "primary",
      "challengeModel": "model-a"
    }
  }
}
JSON

  resolve_challenge_pair_hard_failure "HOK-2462"
  printf 'orphan_lines=%s\n' "$(wc -l < "$REPO_DIR/.wavemill/evals/challenge-records.jsonl" | tr -d '[:space:]')"
  printf 'orphan_outcome=%s\n' "$(jq -r '.comparisonOutcome' "$REPO_DIR/.wavemill/evals/challenge-records.jsonl")"
  printf 'orphan_reason=%s\n' "$(jq -r '.terminalReason' "$REPO_DIR/.wavemill/evals/challenge-records.jsonl")"
  printf 'orphan_winner=%s\n' "$(jq -r '.winner' "$REPO_DIR/.wavemill/evals/challenge-records.jsonl")"
  printf 'orphan_compared_primary=%s\n' "$(jq -r '.tasks["HOK-2462"].challengeCompared' "$STATE_FILE")"
  printf 'orphan_pr_closes=%s\n' "$PR_CLOSES"
  printf 'orphan_cleanups=%s\n' "$CLEANUPS"
}

run_orphan_cleanup_case() {
  cat > "$STATE_FILE" <<JSON
{
  "tasks": {
    "HOK-2462_c": {
      "slug": "hok-2462-c",
      "branch": "task/hok-2462-c",
      "worktree": "$WORKTREE_ROOT/hok-2462-c",
      "pr": "102",
      "status": "ready",
      "agent": "codex",
      "phase": "ready",
      "evalCompleted": true,
      "evalFailed": true,
      "evalHardFailureRetryCount": 2,
      "challengeCompared": false,
      "challenge": true,
      "challengePairId": "HOK-2462",
      "challengeRole": "challenger",
      "challengeModel": "model-b"
    }
  }
}
JSON

  ORPHAN_WINNER=challenger resolve_challenge_pair_hard_failure "HOK-2462"
  ORPHAN_WINNER=challenger resolve_challenge_pair_hard_failure "HOK-2462"
  printf 'orphan_cleanup_lines=%s\n' "$(wc -l < "$REPO_DIR/.wavemill/evals/challenge-records.jsonl" | tr -d '[:space:]')"
  printf 'orphan_cleanup_winner=%s\n' "$(jq -r '.winner' "$REPO_DIR/.wavemill/evals/challenge-records.jsonl")"
  printf 'orphan_cleanup_compared_challenger=%s\n' "$(jq -r '.tasks["HOK-2462_c"].challengeCompared' "$STATE_FILE")"
  printf 'orphan_cleanup_pr_closes=%s\n' "$PR_CLOSES"
  printf 'orphan_cleanup_cleanups=%s\n' "$CLEANUPS"
}

run_incomplete_case() {
  cat > "$STATE_FILE" <<JSON
{
  "tasks": {
    "HOK-2462": {
      "slug": "hok-2462",
      "branch": "task/hok-2462",
      "worktree": "$WORKTREE_ROOT/hok-2462",
      "pr": "101",
      "status": "ready",
      "agent": "codex",
      "phase": "ready",
      "evalCompleted": false,
      "evalFailed": true,
      "evalHardFailureRetryCount": 2,
      "challengeCompared": false,
      "challenge": true,
      "challengePairId": "HOK-2462",
      "challengeRole": "primary",
      "challengeModel": "model-a"
    },
    "HOK-2462_c": {
      "slug": "hok-2462-c",
      "branch": "task/hok-2462-c",
      "worktree": "$WORKTREE_ROOT/hok-2462-c",
      "pr": "102",
      "status": "ready",
      "agent": "codex",
      "phase": "ready",
      "evalCompleted": false,
      "evalFailed": false,
      "challengeCompared": false,
      "challenge": true,
      "challengePairId": "HOK-2462",
      "challengeRole": "challenger",
      "challengeModel": "model-b"
    }
  }
}
JSON

  resolve_challenge_pair_hard_failure "HOK-2462" || true
  printf 'incomplete_terminal_exists=%s\n' "$([[ -f "$REPO_DIR/.wavemill/evals/challenge-records.jsonl" ]] && echo true || echo false)"
  printf 'incomplete_compared_primary=%s\n' "$(jq -r '.tasks["HOK-2462"].challengeCompared' "$STATE_FILE")"
  printf 'incomplete_compared_challenger=%s\n' "$(jq -r '.tasks["HOK-2462_c"].challengeCompared' "$STATE_FILE")"
  printf 'incomplete_pr_closes=%s\n' "$PR_CLOSES"
  printf 'incomplete_cleanups=%s\n' "$CLEANUPS"
}

run_missing_pr_case() {
  cat > "$STATE_FILE" <<JSON
{
  "tasks": {
    "HOK-2462": {
      "slug": "hok-2462",
      "branch": "task/hok-2462",
      "worktree": "$WORKTREE_ROOT/hok-2462",
      "pr": "101",
      "status": "ready",
      "agent": "codex",
      "phase": "ready",
      "evalCompleted": false,
      "evalFailed": true,
      "evalHardFailureRetryCount": 2,
      "challengeCompared": false,
      "challenge": true,
      "challengePairId": "HOK-2462",
      "challengeRole": "primary",
      "challengeModel": "model-a"
    },
    "HOK-2462_c": {
      "slug": "hok-2462-c",
      "branch": "task/hok-2462-c",
      "worktree": "$WORKTREE_ROOT/hok-2462-c",
      "status": "ready",
      "agent": "codex",
      "phase": "ready",
      "evalCompleted": true,
      "evalFailed": false,
      "challengeCompared": false,
      "challenge": true,
      "challengePairId": "HOK-2462",
      "challengeRole": "challenger",
      "challengeModel": "model-b"
    }
  }
}
JSON

  resolve_challenge_pair_hard_failure "HOK-2462" || true
  printf 'missing_pr_terminal_exists=%s\n' "$([[ -f "$REPO_DIR/.wavemill/evals/challenge-records.jsonl" ]] && echo true || echo false)"
  printf 'missing_pr_compared_primary=%s\n' "$(jq -r '.tasks["HOK-2462"].challengeCompared' "$STATE_FILE")"
  printf 'missing_pr_compared_challenger=%s\n' "$(jq -r '.tasks["HOK-2462_c"].challengeCompared' "$STATE_FILE")"
  printf 'missing_pr_closes=%s\n' "$PR_CLOSES"
  printf 'missing_pr_cleanups=%s\n' "$CLEANUPS"
}

run_config_retry_case() {
  cat > "$STATE_FILE" <<JSON
{
  "tasks": {
    "HOK-2462": {
      "slug": "hok-2462",
      "branch": "task/hok-2462",
      "worktree": "$WORKTREE_ROOT/hok-2462",
      "pr": "101",
      "status": "ready",
      "agent": "codex",
      "phase": "ready",
      "evalCompleted": false,
      "evalFailed": true,
      "evalHardFailureRetryCount": 2,
      "challengeCompared": false,
      "challenge": true,
      "challengePairId": "HOK-2462",
      "challengeRole": "primary",
      "challengeModel": "model-a"
    },
    "HOK-2462_c": {
      "slug": "hok-2462-c",
      "branch": "task/hok-2462-c",
      "worktree": "$WORKTREE_ROOT/hok-2462-c",
      "pr": "102",
      "status": "ready",
      "agent": "codex",
      "phase": "ready",
      "evalCompleted": true,
      "evalFailed": false,
      "challengeCompared": false,
      "challenge": true,
      "challengePairId": "HOK-2462",
      "challengeRole": "challenger",
      "challengeModel": "model-b"
    }
  },
  "jobs": {
    "eval-HOK-2462-primary-101": {
      "id": "eval-HOK-2462-primary-101",
      "status": "failed"
    }
  }
}
JSON

  maybe_run_challenge_eval "HOK-2462" "101" "task/hok-2462" "hok-2462"
  wait || true
  printf 'config_retry_counter=%s\n' "$(jq -r '.tasks["HOK-2462"].evalHardFailureRetryCount // empty' "$STATE_FILE")"
  printf 'config_retry_failed=%s\n' "$(jq -r '.tasks["HOK-2462"].evalFailed' "$STATE_FILE")"
  printf 'config_retry_snapshot_exists=%s\n' "$([[ -f "$CASE_DIR/eval-launch-state.json" ]] && echo true || echo false)"
  printf 'config_retry_snapshot_counter=%s\n' "$(jq -r '.tasks["HOK-2462"].evalHardFailureRetryCount' "$CASE_DIR/eval-launch-state.json")"
  printf 'terminal_exists=%s\n' "$([[ -f "$REPO_DIR/.wavemill/evals/challenge-records.jsonl" ]] && echo true || echo false)"
}

run_helper_case() {
  printf 'max_retries=%s\n' "$(challenge_eval_hard_failure_max_retries)"
}

# HOK-2924: the hard-failure retry counts against the bounded-retry bucket in
# the arm's feature dir (head-keyed, backoff-capable) with the state mirror
# kept for resolve_challenge_pair_hard_failure.
run_bucket_case() {
  BUCKET_HEAD="sha-one"
  git() {
    if [[ "${1:-}" == "-C" && "${3:-}" == "rev-parse" ]]; then
      printf '%s\n' "$BUCKET_HEAD"
      return 0
    fi
    return 1
  }
  local bucket_dir="$WORKTREE_ROOT/hok-2462/features/hok-2462"

  cat > "$STATE_FILE" <<JSON
{
  "tasks": {
    "HOK-2462": {
      "slug": "hok-2462",
      "branch": "task/hok-2462",
      "worktree": "$WORKTREE_ROOT/hok-2462",
      "pr": "101",
      "status": "ready",
      "agent": "codex",
      "phase": "ready",
      "evalCompleted": false,
      "evalFailed": true,
      "challengeCompared": false,
      "challenge": true,
      "challengePairId": "HOK-2462",
      "challengeRole": "primary",
      "challengeModel": "model-a"
    },
    "HOK-2462_c": {
      "slug": "hok-2462-c",
      "branch": "task/hok-2462-c",
      "worktree": "$WORKTREE_ROOT/hok-2462-c",
      "pr": "102",
      "status": "ready",
      "agent": "codex",
      "phase": "ready",
      "evalCompleted": true,
      "evalFailed": false,
      "challengeCompared": false,
      "challenge": true,
      "challengePairId": "HOK-2462",
      "challengeRole": "challenger",
      "challengeModel": "model-b"
    }
  },
  "jobs": {}
}
JSON

  maybe_run_challenge_eval "HOK-2462" "101" "task/hok-2462" "hok-2462"
  wait || true
  printf 'bucket_count=%s\n' "$(bounded_retry_count "$bucket_dir" challenge-eval-hard)"
  printf 'bucket_head=%s\n' "$(bounded_retry_head "$bucket_dir" challenge-eval-hard)"
  printf 'bucket_launches_1=%s\n' "$(printf '%s' "$LOG_OUTPUT" | grep -c "eval running in background" || true)"

  # Backoff: with a non-zero base the next retry inside the window holds.
  state_mutate "$STATE_FILE" '.tasks["HOK-2462"].evalFailed = true | .tasks["HOK-2462"].evalCompleted = false' >/dev/null
  WAVEMILL_RETRY_BACKOFF_CHALLENGE_EVAL_HARD_BASE_SECONDS=600 \
    maybe_run_challenge_eval "HOK-2462" "101" "task/hok-2462" "hok-2462"
  printf 'backoff_count=%s\n' "$(bounded_retry_count "$bucket_dir" challenge-eval-hard)"
  printf 'backoff_launches=%s\n' "$(printf '%s' "$LOG_OUTPUT" | grep -c "eval running in background" || true)"
  printf 'backoff_failed=%s\n' "$(jq -r '.tasks["HOK-2462"].evalFailed' "$STATE_FILE")"

  # A fresh commit on the arm zeroes bucket and mirror: retry restarts at 1.
  BUCKET_HEAD="sha-two"
  maybe_run_challenge_eval "HOK-2462" "101" "task/hok-2462" "hok-2462"
  wait || true
  printf 'reset_count=%s\n' "$(bounded_retry_count "$bucket_dir" challenge-eval-hard)"
  printf 'reset_mirror=%s\n' "$(jq -r '.tasks["HOK-2462"].evalHardFailureRetryCount' "$STATE_FILE")"
  printf 'reset_logs_attempt=%s\n' "$(printf '%s' "$LOG_OUTPUT" | grep -c "hard failure (attempt 1/2)" || true)"
}

# HOK-2963: evalCompleted=true with stale current-head evidence relaunches
# the eval through the bounded challenge-eval-stale budget; exhaustion
# resolves to manual comparison, never a silent loop or a synthetic pass.
run_stale_case() {
  STALE_HEAD="sha-one"
  git() {
    if [[ "${1:-}" == "-C" && "${3:-}" == "rev-parse" ]]; then
      printf '%s\n' "$STALE_HEAD"
      return 0
    fi
    return 1
  }
  local bucket_dir="$WORKTREE_ROOT/hok-2462/features/hok-2462"

  cat > "$STATE_FILE" <<JSON
{
  "tasks": {
    "HOK-2462": {
      "slug": "hok-2462",
      "branch": "task/hok-2462",
      "worktree": "$WORKTREE_ROOT/hok-2462",
      "pr": "101",
      "status": "ready",
      "agent": "codex",
      "phase": "ready",
      "evalCompleted": true,
      "evalFailed": false,
      "challengeCompared": false,
      "challenge": true,
      "challengePairId": "HOK-2462",
      "challengeRole": "primary",
      "challengeModel": "model-a"
    },
    "HOK-2462_c": {
      "slug": "hok-2462-c",
      "branch": "task/hok-2462-c",
      "worktree": "$WORKTREE_ROOT/hok-2462-c",
      "pr": "102",
      "status": "ready",
      "agent": "codex",
      "phase": "ready",
      "evalCompleted": true,
      "evalFailed": false,
      "challengeCompared": false,
      "challenge": true,
      "challengePairId": "HOK-2462",
      "challengeRole": "challenger",
      "challengeModel": "model-b"
    }
  },
  "jobs": {}
}
JSON

  # Tick 1: stale evidence relaunches the eval and consumes budget attempt 1.
  EVIDENCE_JSON="{\"ok\":false,\"reason\":\"old_head_only\"}" \
    maybe_run_challenge_eval "HOK-2462" "101" "task/hok-2462" "hok-2462"
  wait || true
  printf 'stale_launches_1=%s\n' "$JOB_TRACKER_CALLS"
  printf 'stale_count_1=%s\n' "$(bounded_retry_count "$bucket_dir" challenge-eval-stale)"
  printf 'stale_completed_cleared=%s\n' "$(jq -r '.tasks["HOK-2462"].evalCompleted' "$STATE_FILE")"

  # Tick 2 (still stale, inside the backoff window): no duplicate relaunch.
  state_mutate "$STATE_FILE" '.tasks["HOK-2462"].evalCompleted = true' >/dev/null
  EVIDENCE_JSON="{\"ok\":false,\"reason\":\"old_head_only\"}" \
    maybe_run_challenge_eval "HOK-2462" "101" "task/hok-2462" "hok-2462"
  printf 'stale_launches_2=%s\n' "$JOB_TRACKER_CALLS"
  printf 'stale_count_2=%s\n' "$(bounded_retry_count "$bucket_dir" challenge-eval-stale)"

  # Current evidence never touches the budget and never relaunches.
  EVIDENCE_JSON="{\"ok\":true,\"evalId\":\"eval-1\"}" \
    maybe_run_challenge_eval "HOK-2462" "101" "task/hok-2462" "hok-2462"
  printf 'current_launches=%s\n' "$JOB_TRACKER_CALLS"

  # Exhaustion: at the ceiling the pair resolves to manual comparison with a
  # greppable sentinel instead of relaunching again.
  printf '%s\n' "3" > "$bucket_dir/.retry-challenge-eval-stale-count"
  printf '%s\n' "$STALE_HEAD" > "$bucket_dir/.retry-challenge-eval-stale-head"
  printf '%s\n' "0" > "$bucket_dir/.retry-challenge-eval-stale-last-at"
  EVIDENCE_JSON="{\"ok\":false,\"reason\":\"old_head_only\"}" \
    maybe_run_challenge_eval "HOK-2462" "101" "task/hok-2462" "hok-2462"
  printf 'stale_launches_3=%s\n' "$JOB_TRACKER_CALLS"
  printf 'stale_sentinel=%s\n' "$([[ -f "$bucket_dir/.retry-challenge-eval-stale-exhausted" ]] && echo present || echo absent)"
  printf 'stale_sentinel_reason=%s\n' "$(cat "$bucket_dir/.retry-challenge-eval-stale-exhausted" 2>/dev/null | head -1 || true)"
  printf 'stale_pair_state=%s\n' "$(jq -r '.tasks["HOK-2462"].comparisonState // empty' "$STATE_FILE")"
}

"run_${CASE_NAME}_case"
printf 'eval_launches=%s\n' "$EVAL_LAUNCHES"
printf 'job_tracker_calls=%s\n' "$JOB_TRACKER_CALLS"
printf 'logs=%s\n' "$(printf '%s' "$LOG_OUTPUT" | tr '\n' ';')"
EOF
chmod +x "$TEST_TMP/run-case.sh"

echo "=== Challenge Eval Hard Failure ==="

common_resolver_count="$(grep -c '^resolve_challenge_pair_hard_failure() {' "$COMMON_SCRIPT")"
mill_resolver_count="$(grep -c '^resolve_challenge_pair_hard_failure() {' "$MILL_SCRIPT" || true)"
monitor_resolver_count="$(grep -c '^resolve_challenge_pair_hard_failure() {' "$MONITOR_SCRIPT_FILE" || true)"
mill_sources_common="$(grep -c 'source "\$SCRIPT_DIR/wavemill-common.sh"' "$MILL_SCRIPT" || true)"
monitor_sources_common="$(grep -c 'source "\$LIB_DIR/wavemill-common.sh"' "$MONITOR_SCRIPT_FILE" || true)"

check_eq "canonical resolver exists exactly once in common" "1" "$common_resolver_count"
check_eq "parent no longer defines local hard-failure resolver" "0" "$mill_resolver_count"
check_eq "monitor no longer defines local hard-failure resolver" "0" "$monitor_resolver_count"
check_eq "parent sources common library" "1" "$mill_sources_common"
check_eq "monitor sources common library" "1" "$monitor_sources_common"

retry_output="$(CASE_NAME=retry CASE_DIR="$TEST_TMP/retry" REPO_DIR="$REPO_DIR" FUNCTION_FILE="$FUNCTION_FILE" "$TEST_TMP/run-case.sh")"
exhausted_output="$(CASE_NAME=exhausted CASE_DIR="$TEST_TMP/exhausted" REPO_DIR="$REPO_DIR" FUNCTION_FILE="$FUNCTION_FILE" "$TEST_TMP/run-case.sh")"
double_output="$(CASE_NAME=double CASE_DIR="$TEST_TMP/double" REPO_DIR="$REPO_DIR" FUNCTION_FILE="$FUNCTION_FILE" "$TEST_TMP/run-case.sh")"
orphan_output="$(CASE_NAME=orphan CASE_DIR="$TEST_TMP/orphan" REPO_DIR="$REPO_DIR" FUNCTION_FILE="$FUNCTION_FILE" "$TEST_TMP/run-case.sh")"
orphan_cleanup_output="$(CASE_NAME=orphan_cleanup CASE_DIR="$TEST_TMP/orphan-cleanup" REPO_DIR="$REPO_DIR" FUNCTION_FILE="$FUNCTION_FILE" "$TEST_TMP/run-case.sh")"
incomplete_output="$(CASE_NAME=incomplete CASE_DIR="$TEST_TMP/incomplete" REPO_DIR="$REPO_DIR" FUNCTION_FILE="$FUNCTION_FILE" "$TEST_TMP/run-case.sh")"
missing_pr_output="$(CASE_NAME=missing_pr CASE_DIR="$TEST_TMP/missing-pr" REPO_DIR="$REPO_DIR" FUNCTION_FILE="$FUNCTION_FILE" "$TEST_TMP/run-case.sh")"
helper_default_output="$(CASE_NAME=helper CASE_DIR="$TEST_TMP/helper-default" REPO_DIR="$REPO_DIR" FUNCTION_FILE="$FUNCTION_FILE" "$TEST_TMP/run-case.sh")"
helper_config_output="$(CONFIG_JSON='{"challenge":{"eval":{"hardFailureRetryMaxAttempts":4}}}' CASE_NAME=helper CASE_DIR="$TEST_TMP/helper-config" REPO_DIR="$REPO_DIR" FUNCTION_FILE="$FUNCTION_FILE" "$TEST_TMP/run-case.sh")"
helper_soft_only_output="$(CONFIG_JSON='{"challenge":{"eval":{"retryMaxAttempts":9}}}' CASE_NAME=helper CASE_DIR="$TEST_TMP/helper-soft-only" REPO_DIR="$REPO_DIR" FUNCTION_FILE="$FUNCTION_FILE" "$TEST_TMP/run-case.sh")"
helper_env_output="$(CONFIG_JSON='{"challenge":{"eval":{"hardFailureRetryMaxAttempts":4}}}' WAVEMILL_EVAL_HARD_FAILURE_MAX_RETRIES=3 CASE_NAME=helper CASE_DIR="$TEST_TMP/helper-env" REPO_DIR="$REPO_DIR" FUNCTION_FILE="$FUNCTION_FILE" "$TEST_TMP/run-case.sh")"
helper_invalid_env_output="$(CONFIG_JSON='{"challenge":{"eval":{"retryMaxAttempts":9,"hardFailureRetryMaxAttempts":4}}}' WAVEMILL_EVAL_HARD_FAILURE_MAX_RETRIES=bad CASE_NAME=helper CASE_DIR="$TEST_TMP/helper-invalid-env" REPO_DIR="$REPO_DIR" FUNCTION_FILE="$FUNCTION_FILE" "$TEST_TMP/run-case.sh")"
config_retry_output="$(CONFIG_JSON='{"challenge":{"eval":{"hardFailureRetryMaxAttempts":3}}}' CASE_NAME=config_retry CASE_DIR="$TEST_TMP/config-retry" REPO_DIR="$REPO_DIR" FUNCTION_FILE="$FUNCTION_FILE" "$TEST_TMP/run-case.sh")"
bucket_output="$(CASE_NAME=bucket CASE_DIR="$TEST_TMP/bucket" REPO_DIR="$REPO_DIR" FUNCTION_FILE="$FUNCTION_FILE" "$TEST_TMP/run-case.sh")"
stale_output="$(CASE_NAME=stale CASE_DIR="$TEST_TMP/stale" REPO_DIR="$REPO_DIR" FUNCTION_FILE="$FUNCTION_FILE" "$TEST_TMP/run-case.sh")"

check_contains "legacy hard failure defaults retry counter to zero then increments" "$retry_output" "retry_counter=1"
check_contains "hard failure retry clears evalFailed before relaunch" "$retry_output" "retry_failed=false"
check_contains "hard failure retry starts the eval command" "$retry_output" "retry_snapshot_exists=true"
check_contains "hard failure retry snapshot shows cleared evalFailed" "$retry_output" "retry_snapshot_failed=false"
check_contains "hard failure retry snapshot persists incremented counter" "$retry_output" "retry_snapshot_counter=1"
check_contains "hard failure retry still records tracked job launch" "$retry_output" "job_tracker_calls=1"
check_contains "hard failure retry logs retry attempt" "$retry_output" "challenge eval retrying for HOK-2462: hard failure (attempt 1/2)"

check_contains "exhausted hard failure writes exactly one terminal record" "$exhausted_output" "terminal_lines=1"
check_contains "exhausted hard failure writes forfeit outcome" "$exhausted_output" "terminal_outcome=forfeit"
check_contains "exhausted hard failure records machine reason" "$exhausted_output" "terminal_reason=primary_eval_hard_failed"
check_contains "exhausted hard failure awards challenger" "$exhausted_output" "terminal_winner=challenger"
check_contains "exhausted hard failure marks primary compared" "$exhausted_output" "terminal_compared_primary=true"
check_contains "exhausted hard failure marks challenger compared" "$exhausted_output" "terminal_compared_challenger=true"
check_contains "exhausted hard failure does not relaunch eval" "$exhausted_output" "eval_launches=0"
check_contains "exhausted hard failure writes bounded-retry sentinel" "$exhausted_output" "terminal_sentinel=present"
check_contains "exhausted hard failure sentinel carries greppable reason" "$exhausted_output" "Challenge eval hard-failure retries exhausted for HOK-2462"

check_contains "bucket retry counts attempt in feature dir" "$bucket_output" "bucket_count=1"
check_contains "bucket retry keys the arm head" "$bucket_output" "bucket_head=sha-one"
check_contains "bucket retry launches eval once" "$bucket_output" "bucket_launches_1=1"
check_contains "backoff window holds the hard-failure retry" "$bucket_output" "backoff_count=1"
check_contains "backoff hold launches nothing" "$bucket_output" "backoff_launches=1"
check_contains "backoff hold preserves evalFailed for the next tick" "$bucket_output" "backoff_failed=true"
check_contains "new head restarts the hard-failure budget" "$bucket_output" "reset_count=1"
check_contains "new head zeroes then rewrites the state mirror" "$bucket_output" "reset_mirror=1"
check_contains "new head retry logs attempt 1 twice" "$bucket_output" "reset_logs_attempt=2"

check_contains "stale evidence relaunches the eval once" "$stale_output" "stale_launches_1=1"
check_contains "stale relaunch consumes the bounded budget" "$stale_output" "stale_count_1=1"
check_contains "stale relaunch clears evalCompleted" "$stale_output" "stale_completed_cleared=false"
check_contains "stale relaunch holds inside the backoff window" "$stale_output" "stale_launches_2=1"
check_contains "backoff hold does not consume the stale budget" "$stale_output" "stale_count_2=1"
check_contains "current evidence never relaunches" "$stale_output" "current_launches=1"
check_contains "stale exhaustion stops relaunching" "$stale_output" "stale_launches_3=1"
check_contains "stale exhaustion writes greppable sentinel" "$stale_output" "stale_sentinel=present"
check_contains "stale exhaustion names the cause" "$stale_output" "stale-evidence relaunches exhausted for HOK-2462"
check_contains "stale exhaustion resolves to manual comparison" "$stale_output" "stale_pair_state=manual_comparison_needed"

check_contains "double hard failure writes exactly one terminal record" "$double_output" "double_lines=1"
check_contains "double hard failure writes double-forfeit outcome" "$double_output" "double_outcome=double-forfeit"
check_contains "double hard failure records both-side reason" "$double_output" "double_reason=both_eval_hard_failed"
check_contains "double hard failure marks primary compared" "$double_output" "double_compared_primary=true"
check_contains "double hard failure marks challenger compared" "$double_output" "double_compared_challenger=true"
check_contains "double hard failure does not relaunch eval" "$double_output" "eval_launches=0"

check_contains "orphan hard failure path writes exactly one terminal record" "$orphan_output" "orphan_lines=1"
check_contains "orphan hard failure path writes forfeit outcome" "$orphan_output" "orphan_outcome=forfeit"
check_contains "orphan hard failure path records orphan reason" "$orphan_output" "orphan_reason=orphan_pair"
check_contains "orphan hard failure path awards surviving primary" "$orphan_output" "orphan_winner=primary"
check_contains "orphan hard failure path marks primary compared" "$orphan_output" "orphan_compared_primary=true"
check_contains "orphan hard failure path does not close PRs" "$orphan_output" "orphan_pr_closes=0"
check_contains "orphan hard failure path does not cleanup worktrees" "$orphan_output" "orphan_cleanups=0"

check_contains "canonical orphan path remains idempotent" "$orphan_cleanup_output" "orphan_cleanup_lines=1"
check_contains "canonical orphan path preserves concrete winner" "$orphan_cleanup_output" "orphan_cleanup_winner=challenger"
check_contains "canonical orphan path marks survivor compared" "$orphan_cleanup_output" "orphan_cleanup_compared_challenger=true"
check_contains "canonical orphan path does not use former parent PR cleanup" "$orphan_cleanup_output" "orphan_cleanup_pr_closes=0"
check_contains "canonical orphan path does not use former parent worktree cleanup" "$orphan_cleanup_output" "orphan_cleanup_cleanups=0"

check_contains "incomplete hard failure writes no terminal record" "$incomplete_output" "incomplete_terminal_exists=false"
check_contains "incomplete hard failure does not compare primary" "$incomplete_output" "incomplete_compared_primary=false"
check_contains "incomplete hard failure does not compare challenger" "$incomplete_output" "incomplete_compared_challenger=false"
check_contains "incomplete hard failure does not close PRs" "$incomplete_output" "incomplete_pr_closes=0"
check_contains "incomplete hard failure does not cleanup worktrees" "$incomplete_output" "incomplete_cleanups=0"

check_contains "missing PR evidence writes no terminal record" "$missing_pr_output" "missing_pr_terminal_exists=false"
check_contains "missing PR evidence does not compare primary" "$missing_pr_output" "missing_pr_compared_primary=false"
check_contains "missing PR evidence does not compare challenger" "$missing_pr_output" "missing_pr_compared_challenger=false"
check_contains "missing PR evidence does not close PRs" "$missing_pr_output" "missing_pr_closes=0"
check_contains "missing PR evidence does not cleanup worktrees" "$missing_pr_output" "missing_pr_cleanups=0"

check_contains "hard failure helper defaults to two retries" "$helper_default_output" "max_retries=2"
check_contains "hard failure helper reads hard-failure config" "$helper_config_output" "max_retries=4"
check_contains "soft retry config does not affect hard-failure helper" "$helper_soft_only_output" "max_retries=2"
check_contains "hard failure env override wins over config" "$helper_env_output" "max_retries=3"
check_contains "invalid hard failure env falls through to config" "$helper_invalid_env_output" "max_retries=4"
check_contains "hard failure config allows retry before exhaustion" "$config_retry_output" "config_retry_counter=3"
check_contains "hard failure config retry clears evalFailed" "$config_retry_output" "config_retry_failed=false"
check_contains "hard failure config retry does not write terminal record" "$config_retry_output" "terminal_exists=false"
check_contains "hard failure config retry launches eval" "$config_retry_output" "config_retry_snapshot_exists=true"
check_contains "hard failure config retry snapshot has configured attempt" "$config_retry_output" "config_retry_snapshot_counter=3"
check_contains "hard failure config retry records tracked job launch" "$config_retry_output" "job_tracker_calls=1"
check_contains "hard failure config retry logs configured budget" "$config_retry_output" "challenge eval retrying for HOK-2462: hard failure (attempt 3/3)"

echo ""
echo "Passed: $PASS"
echo "Failed: $FAIL"

if [[ $FAIL -ne 0 ]]; then
  exit 1
fi
