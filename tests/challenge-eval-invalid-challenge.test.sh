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
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$label"
  else
    echo "    missing: $needle"
    printf '%s\n' "$haystack" | sed 's/^/      /'
    fail "$label"
  fi
}

check_not_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    pass "$label"
  else
    echo "    unexpected: $needle"
    printf '%s\n' "$haystack" | sed 's/^/      /'
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

FUNCTION_FILE="$TEST_TMP/challenge-invalid-functions.sh"
: > "$FUNCTION_FILE"
for fn in \
  mark_challenge_eval_running:1 \
  write_challenge_pair_state:1 \
  challenge_pair_manual_artifact_path:1 \
  write_manual_challenge_comparison_artifact:1 \
  write_invalid_challenge_artifact:1 \
  mark_challenge_invalid:1 \
  sanitize_job_token:1 \
  challenge_job_dir:1 \
  build_eval_job_id:1 \
  read_job_state_value:1 \
  launch_tracked_job:1 \
  post_merge_eval_timeout_seconds:1 \
  challenge_eval_current_head_state:1 \
  challenge_eval_stale_relaunch_allowed:1 \
  challenge_eval_invalid_terminalize:1 \
  maybe_run_challenge_eval:1
do
  IFS=: read -r name occurrence <<<"$fn"
  extract_function_occurrence "$MONITOR_SCRIPT_FILE" "$name" "$occurrence" >> "$FUNCTION_FILE"
  printf '\n' >> "$FUNCTION_FILE"
done

if [[ ! -s "$FUNCTION_FILE" ]]; then
  echo "Could not extract invalid-challenge functions"
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
SESSION="challenge-invalid-test"
AGENT_CMD="codex"
LOG_OUTPUT=""
JOB_TRACKER_CALLS=0
GIT_HEAD="${GIT_HEAD:-sha-current}"

mkdir -p "$REPO_DIR" "$WORKTREE_ROOT" "$TOOLS_DIR"

log() { printf -v LOG_OUTPUT "%s%s\n" "$LOG_OUTPUT" "$2"; }
log_warn() { printf -v LOG_OUTPUT "%sWARN: %s\n" "$LOG_OUTPUT" "$1"; }
get_linear_issue_id() { printf '%s\n' "$1"; }
wavemill_load_config() { printf '%s\n' '{"eval":{"postMergeTimeoutSeconds":600}}'; }

git() {
  if [[ "${1:-}" == "-C" && "${3:-}" == "rev-parse" ]]; then
    printf '%s\n' "$GIT_HEAD"
    return 0
  fi
  command git "$@"
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

npx() {
  if [[ "$*" == *"challenge-eval-evidence.ts"* ]]; then
    if [[ "${EVIDENCE_FAIL:-false}" == "true" ]]; then
      return 1
    fi
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
  if [[ "$*" == *"run-eval-hook.ts"* ]]; then
    : > "$CASE_DIR/eval-launched"
    return 0
  fi
  return 0
}

seed_state() {
  local completed="${1:-true}"
  local shape="${2:-flat}"
  cat > "$STATE_FILE" <<JSON
{
  "tasks": {
    "HOK-3007": {
      "slug": "hok-3007",
      "branch": "task/hok-3007",
      "worktree": "$WORKTREE_ROOT/hok-3007",
      "pr": "101",
      "status": "ready",
      "agent": "codex",
      "phase": "ready",
      "evalCompleted": $completed,
      "evalFailed": false,
      "challengeCompared": false,
      "challenge": true,
      "challengePairId": "HOK-3007",
      "challengeRole": "primary",
      "challengeModel": "model-a"
    },
    "HOK-3007_c": {
      "slug": "hok-3007-c",
      "branch": "task/hok-3007-c",
      "worktree": "$WORKTREE_ROOT/hok-3007-c",
      "pr": "102",
      "status": "ready",
      "agent": "codex",
      "phase": "ready",
      "evalCompleted": true,
      "evalFailed": false,
      "challengeCompared": false,
      "challenge": true,
      "challengePairId": "HOK-3007",
      "challengeRole": "challenger",
      "challengeModel": "model-b"
    }
  },
  "jobs": {}
}
JSON
  if [[ "$shape" == "forked" ]]; then
    # HOK-2814 / HOK-3007: reviewer-fork shape — both arms carry the fork
    # descriptor + inherited-stages provenance the materialiser stamps. The
    # invalid_challenge current-head path must terminate the pair regardless
    # of shape; the fork fields are informational and must not change the
    # decision. Add them via jq so the base JSON stays clean under all shapes.
    tmp="$(mktemp)"
    jq '.tasks["HOK-3007"] += {"forkStage":"review","forkCommit":"abcdef01","sharedPrefix":true,"challengeArms":[{"key":"HOK-3007_c","challengeArmState":"materialized","forkCommit":"abcdef01"}]}
        | .tasks["HOK-3007_c"] += {"forkStage":"review","forkCommit":"abcdef01","sharedPrefix":true}' \
        "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
  fi
  mkdir -p "$WORKTREE_ROOT/hok-3007/features/hok-3007/ready"
  mkdir -p "$WORKTREE_ROOT/hok-3007-c/features/hok-3007-c/ready"
}

artifact_text() {
  cat "$WORKTREE_ROOT/hok-3007/features/hok-3007/ready/challenge-comparison-needed.md" 2>/dev/null || true
}

run_invalid_case() {
  seed_state true
  local bucket_dir="$WORKTREE_ROOT/hok-3007/features/hok-3007"
  EVIDENCE_JSON='{"ok":false,"reason":"ineligible_evidence","currentHeadSha":"c8c0f018","candidates":[{"evalId":"eval-1","evaluatedPrHeadSha":"c8c0f018","rejection":"invalid_challenge","challengeDivergenceReason":"missing_challenge_intent"}]}'
  maybe_run_challenge_eval "HOK-3007" "101" "task/hok-3007" "hok-3007"
  wait || true
  printf 'invalid_launch_file=%s\n' "$([[ -f "$CASE_DIR/eval-launched" ]] && echo present || echo absent)"
  printf 'invalid_tracker_calls=%s\n' "$JOB_TRACKER_CALLS"
  printf 'invalid_count_file=%s\n' "$([[ -f "$bucket_dir/.retry-challenge-eval-stale-count" ]] && echo present || echo absent)"
  printf 'invalid_sentinel=%s\n' "$([[ -f "$bucket_dir/.retry-challenge-eval-stale-exhausted" ]] && echo present || echo absent)"
  printf 'invalid_sentinel_reason=%s\n' "$(cat "$bucket_dir/.retry-challenge-eval-stale-exhausted" 2>/dev/null || true)"
  printf 'invalid_state_primary=%s\n' "$(jq -r '.tasks["HOK-3007"].comparisonState // empty' "$STATE_FILE")"
  printf 'invalid_state_challenger=%s\n' "$(jq -r '.tasks["HOK-3007_c"].comparisonState // empty' "$STATE_FILE")"
  printf 'invalid_reason=%s\n' "$(jq -r '.tasks["HOK-3007"].invalidChallengeReason // empty' "$STATE_FILE")"
  printf 'invalid_completed=%s\n' "$(jq -r '.tasks["HOK-3007"].evalCompleted' "$STATE_FILE")"
  printf 'invalid_artifact_ref=%s\n' "$(jq -r '.tasks["HOK-3007"].manualComparisonArtifact // empty' "$STATE_FILE")"
  printf 'invalid_artifact=%s\n' "$(artifact_text | tr '\n' ';')"
  EVIDENCE_JSON='{"ok":false,"reason":"ineligible_evidence","currentHeadSha":"c8c0f018","candidates":[{"evalId":"eval-1","evaluatedPrHeadSha":"c8c0f018","rejection":"invalid_challenge","challengeDivergenceReason":"missing_challenge_intent"}]}'
  maybe_run_challenge_eval "HOK-3007" "101" "task/hok-3007" "hok-3007"
  wait || true
  printf 'invalid_tracker_after_second=%s\n' "$JOB_TRACKER_CALLS"
  printf 'invalid_count_after_second=%s\n' "$([[ -f "$bucket_dir/.retry-challenge-eval-stale-count" ]] && cat "$bucket_dir/.retry-challenge-eval-stale-count" || echo absent)"
  printf 'invalid_warns=%s\n' "$(printf '%s' "$LOG_OUTPUT" | grep -c "terminal, no relaunch" || true)"
}

run_stale_case() {
  seed_state true
  local bucket_dir="$WORKTREE_ROOT/hok-3007/features/hok-3007"
  EVIDENCE_JSON='{"ok":false,"reason":"old_head_only","currentHeadSha":"sha-current","candidates":[{"evalId":"old-eval","evaluatedPrHeadSha":"sha-old","rejection":"head_mismatch"}]}'
  maybe_run_challenge_eval "HOK-3007" "101" "task/hok-3007" "hok-3007"
  wait || true
  printf 'stale_tracker_calls=%s\n' "$JOB_TRACKER_CALLS"
  printf 'stale_launch_file=%s\n' "$([[ -f "$CASE_DIR/eval-launched" ]] && echo present || echo absent)"
  printf 'stale_count=%s\n' "$(bounded_retry_count "$bucket_dir" challenge-eval-stale)"
  printf 'stale_completed=%s\n' "$(jq -r '.tasks["HOK-3007"].evalCompleted' "$STATE_FILE")"
}

run_stale_exhaustion_case() {
  seed_state true
  local bucket_dir="$WORKTREE_ROOT/hok-3007/features/hok-3007"
  printf '3\n' > "$bucket_dir/.retry-challenge-eval-stale-count"
  printf '%s\n' "$GIT_HEAD" > "$bucket_dir/.retry-challenge-eval-stale-head"
  printf '0\n' > "$bucket_dir/.retry-challenge-eval-stale-last-at"
  EVIDENCE_JSON='{"ok":false,"reason":"old_head_only","currentHeadSha":"sha-current","candidates":[{"evalId":"old-eval","evaluatedPrHeadSha":"sha-old","rejection":"head_mismatch"}]}'
  maybe_run_challenge_eval "HOK-3007" "101" "task/hok-3007" "hok-3007"
  wait || true
  printf 'exhaust_state=%s\n' "$(jq -r '.tasks["HOK-3007"].comparisonState // empty' "$STATE_FILE")"
  printf 'exhaust_reason=%s\n' "$(jq -r '.tasks["HOK-3007"].comparisonBlockedReason // empty' "$STATE_FILE")"
  printf 'exhaust_tracker_calls=%s\n' "$JOB_TRACKER_CALLS"
  printf 'exhaust_artifact=%s\n' "$(artifact_text | tr '\n' ';')"
}

run_disposition_case() {
  seed_state true
  EVIDENCE_JSON='{"ok":true,"evalId":"eval-ok","currentHeadSha":"sha-current"}'
  printf 'disp_current=%s\n' "$(challenge_eval_current_head_state "HOK-3007" "101")"
  EVIDENCE_FAIL=true
  printf 'disp_failure=%s\n' "$(challenge_eval_current_head_state "HOK-3007" "101")"
  unset EVIDENCE_FAIL
  EVIDENCE_JSON='{"ok":false,"reason":"ineligible_evidence","currentHeadSha":"sha-current","candidates":[{"evalId":"eval-a","evaluatedPrHeadSha":"sha-current","rejection":"invalid_challenge"},{"evalId":"eval-b","evaluatedPrHeadSha":"sha-current","rejection":"harness_mismatch"}]}'
  printf 'disp_mixed=%s\n' "$(challenge_eval_current_head_state "HOK-3007" "101")"
  EVIDENCE_JSON='{"ok":false,"reason":"ineligible_evidence","currentHeadSha":"sha-current","candidates":[{"evalId":"eval-a","evaluatedPrHeadSha":"sha-current","rejection":"invalid_challenge"}]}'
  printf 'disp_invalid=%s\n' "$(challenge_eval_current_head_state "HOK-3007" "101")"
}

# HOK-2814 / HOK-3007: forked-shape variant. The reviewer-fork materialiser
# stamps both arms with forkStage/forkCommit/sharedPrefix (+ challengeArms
# on the primary) BEFORE eval runs. The current-head `invalid_challenge`
# evidence path must behave identically regardless of shape: no relaunch,
# stale budget untouched, terminal sentinel names missing_challenge_intent,
# and both arms move to comparisonState=invalid_challenge.
run_invalid_forked_case() {
  seed_state true forked
  local bucket_dir="$WORKTREE_ROOT/hok-3007/features/hok-3007"
  # Guard: the seed carries the forked-shape fields.
  printf 'invalid_forked_seed_fork=%s\n' "$(jq -r '.tasks["HOK-3007"].forkStage // empty' "$STATE_FILE")"
  printf 'invalid_forked_seed_arm=%s\n' "$(jq -r '.tasks["HOK-3007"].challengeArms[0].challengeArmState // empty' "$STATE_FILE")"
  EVIDENCE_JSON='{"ok":false,"reason":"ineligible_evidence","currentHeadSha":"c8c0f018","candidates":[{"evalId":"eval-1","evaluatedPrHeadSha":"c8c0f018","rejection":"invalid_challenge","challengeDivergenceReason":"missing_challenge_intent"}]}'
  maybe_run_challenge_eval "HOK-3007" "101" "task/hok-3007" "hok-3007"
  wait || true
  printf 'invalid_forked_launch_file=%s\n' "$([[ -f "$CASE_DIR/eval-launched" ]] && echo present || echo absent)"
  printf 'invalid_forked_tracker_calls=%s\n' "$JOB_TRACKER_CALLS"
  printf 'invalid_forked_count_file=%s\n' "$([[ -f "$bucket_dir/.retry-challenge-eval-stale-count" ]] && echo present || echo absent)"
  printf 'invalid_forked_sentinel=%s\n' "$([[ -f "$bucket_dir/.retry-challenge-eval-stale-exhausted" ]] && echo present || echo absent)"
  printf 'invalid_forked_sentinel_reason=%s\n' "$(cat "$bucket_dir/.retry-challenge-eval-stale-exhausted" 2>/dev/null || true)"
  printf 'invalid_forked_state_primary=%s\n' "$(jq -r '.tasks["HOK-3007"].comparisonState // empty' "$STATE_FILE")"
  printf 'invalid_forked_state_challenger=%s\n' "$(jq -r '.tasks["HOK-3007_c"].comparisonState // empty' "$STATE_FILE")"
  # The fork descriptor is unchanged by the invalid path.
  printf 'invalid_forked_fork_preserved=%s\n' "$(jq -r '.tasks["HOK-3007"].forkStage // empty' "$STATE_FILE")"
  printf 'invalid_forked_arm_preserved=%s\n' "$(jq -r '.tasks["HOK-3007"].challengeArms[0].challengeArmState // empty' "$STATE_FILE")"
}

"run_${CASE_NAME}_case"
printf 'logs=%s\n' "$(printf '%s' "$LOG_OUTPUT" | tr '\n' ';')"
EOF
chmod +x "$TEST_TMP/run-case.sh"

echo "=== Challenge Eval Invalid Challenge ==="

invalid_output="$(CASE_NAME=invalid CASE_DIR="$TEST_TMP/invalid" REPO_DIR="$REPO_DIR" FUNCTION_FILE="$FUNCTION_FILE" "$TEST_TMP/run-case.sh")"
stale_output="$(CASE_NAME=stale CASE_DIR="$TEST_TMP/stale" REPO_DIR="$REPO_DIR" FUNCTION_FILE="$FUNCTION_FILE" "$TEST_TMP/run-case.sh")"
stale_exhaustion_output="$(CASE_NAME=stale_exhaustion CASE_DIR="$TEST_TMP/stale-exhaustion" REPO_DIR="$REPO_DIR" FUNCTION_FILE="$FUNCTION_FILE" "$TEST_TMP/run-case.sh")"
disposition_output="$(CASE_NAME=disposition CASE_DIR="$TEST_TMP/disposition" REPO_DIR="$REPO_DIR" FUNCTION_FILE="$FUNCTION_FILE" "$TEST_TMP/run-case.sh")"
invalid_forked_output="$(CASE_NAME=invalid_forked CASE_DIR="$TEST_TMP/invalid-forked" REPO_DIR="$REPO_DIR" FUNCTION_FILE="$FUNCTION_FILE" "$TEST_TMP/run-case.sh")"

check_contains "invalid does not launch eval command" "$invalid_output" "invalid_launch_file=absent"
check_contains "invalid does not register tracked eval launch" "$invalid_output" "invalid_tracker_calls=0"
check_contains "invalid leaves stale budget counter untouched" "$invalid_output" "invalid_count_file=absent"
check_contains "invalid writes terminal stale-bucket sentinel" "$invalid_output" "invalid_sentinel=present"
check_contains "invalid sentinel names terminal cause" "$invalid_output" "invalid_challenge (missing_challenge_intent)"
check_contains "invalid marks primary terminal" "$invalid_output" "invalid_state_primary=invalid_challenge"
check_contains "invalid marks challenger terminal" "$invalid_output" "invalid_state_challenger=invalid_challenge"
check_contains "invalid records divergence reason" "$invalid_output" "invalid_reason=missing_challenge_intent"
check_contains "invalid preserves evalCompleted" "$invalid_output" "invalid_completed=true"
check_contains "invalid records artifact path in state" "$invalid_output" "ready/challenge-comparison-needed.md"
check_contains "invalid artifact names divergence reason" "$invalid_output" "missing_challenge_intent"
check_contains "invalid artifact names eval id" "$invalid_output" "eval-1"
check_contains "invalid artifact points at recovery tool" "$invalid_output" "challenge-pair-recovery.ts"
check_not_contains "invalid artifact has no timeout wording" "$invalid_output" "Timed out"
check_not_contains "invalid artifact does not advise timeout rerun" "$invalid_output" "Re-run the timed-out"
check_contains "invalid path is idempotent" "$invalid_output" "invalid_tracker_after_second=0"
check_contains "invalid idempotence leaves count absent" "$invalid_output" "invalid_count_after_second=absent"
check_contains "invalid one-shot logs once" "$invalid_output" "invalid_warns=1"

check_contains "stale still registers eval launch" "$stale_output" "stale_tracker_calls=1"
check_contains "stale starts eval command" "$stale_output" "stale_launch_file=present"
check_contains "stale consumes budget" "$stale_output" "stale_count=1"
check_contains "stale clears evalCompleted" "$stale_output" "stale_completed=false"

check_contains "stale exhaustion terminalizes manual comparison" "$stale_exhaustion_output" "exhaust_state=manual_comparison_needed"
check_contains "stale exhaustion reason is accurate" "$stale_exhaustion_output" "exhaust_reason=stale_eval_evidence"
check_contains "stale exhaustion does not relaunch" "$stale_exhaustion_output" "exhaust_tracker_calls=0"
check_contains "stale exhaustion artifact names stale evidence" "$stale_exhaustion_output" "Cause: eval evidence repeatedly refused as stale"
check_contains "stale exhaustion artifact suggests evidence tool" "$stale_exhaustion_output" "challenge-eval-evidence.ts"
check_not_contains "stale exhaustion artifact has no timeout line" "$stale_exhaustion_output" "Timed out member"
check_not_contains "stale exhaustion artifact has no timed-out rerun" "$stale_exhaustion_output" "Re-run the timed-out"

check_contains "ok evidence disposition is current" "$disposition_output" "disp_current=current"
check_contains "tool failure disposition is unknown" "$disposition_output" "disp_failure=unknown"
check_contains "mixed ineligible evidence stays stale" "$disposition_output" "disp_mixed=stale"
check_contains "all-invalid current-head evidence is invalid" "$disposition_output" "disp_invalid=invalid"

# HOK-2814 / HOK-3007: forked-shape variant asserts the invalid-challenge
# current-head path behaves identically when the reviewer-fork descriptor
# is present on the state. No relaunch, stale budget untouched, terminal
# sentinel, and the fork descriptor is preserved through the terminalisation.
check_contains "invalid_forked seed carries fork descriptor" "$invalid_forked_output" "invalid_forked_seed_fork=review"
check_contains "invalid_forked seed carries materialized arm" "$invalid_forked_output" "invalid_forked_seed_arm=materialized"
check_contains "invalid_forked does not launch eval command" "$invalid_forked_output" "invalid_forked_launch_file=absent"
check_contains "invalid_forked does not register tracked eval launch" "$invalid_forked_output" "invalid_forked_tracker_calls=0"
check_contains "invalid_forked leaves stale budget counter untouched" "$invalid_forked_output" "invalid_forked_count_file=absent"
check_contains "invalid_forked writes terminal stale-bucket sentinel" "$invalid_forked_output" "invalid_forked_sentinel=present"
check_contains "invalid_forked sentinel names terminal cause" "$invalid_forked_output" "invalid_challenge (missing_challenge_intent)"
check_contains "invalid_forked marks primary comparisonState terminal" "$invalid_forked_output" "invalid_forked_state_primary=invalid_challenge"
check_contains "invalid_forked marks challenger comparisonState terminal" "$invalid_forked_output" "invalid_forked_state_challenger=invalid_challenge"
check_contains "invalid_forked preserves fork descriptor" "$invalid_forked_output" "invalid_forked_fork_preserved=review"
check_contains "invalid_forked preserves challengeArms state" "$invalid_forked_output" "invalid_forked_arm_preserved=materialized"

echo "challenge-eval-invalid-challenge: $PASS passed, $FAIL failed"
if (( FAIL > 0 )); then
  exit 1
fi
