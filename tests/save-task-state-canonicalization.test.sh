#!/usr/bin/env bash
# HOK-2900: canonical save_task_state coverage.
#
# Characterization record of the pre-change divergence this refactor removed.
# Three private copies of save_task_state existed and had drifted:
#   - shared/lib/wavemill-mill.sh (parent): defaulted an omitted status to ""
#     (accidentally writing a literal empty status), never resolved a traceId,
#     and had no production call site left after the monitor extraction.
#   - shared/lib/wavemill-startup-runner.sh: used positional argument 19 for
#     phase and 20 for windowId, colliding with the monitor's challengeStage
#     at 19, and wrote status:"" for launch saves.
#   - shared/lib/wavemill-monitor.sh: defaulted an omitted status to "active"
#     and resolved traceId from .trace-context.json, but rebuilt the task
#     object from a fixed field literal, silently dropping any stored field
#     missing from its allowlist (windowId among them).
# The canonical copy lives in shared/lib/wavemill-common.sh: status defaults
# to "active", the positional tail is challengeStage(19)/phase(20)/
# windowId(21), traceId is resolved best-effort from the worktree's feature
# (then bug) directory, and the write is one atomic state_mutate merge that
# preserves every existing task field the writer does not explicitly supply.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

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

# state <name> <expected> <state_file> <jq_expr>
check_state() {
  local name="$1" expected="$2" file="$3" expr="$4" actual
  actual="$(jq -r "$expr" "$file" 2>/dev/null || printf '<jq-error>')"
  check_eq "$name" "$expected" "$actual"
}

echo "=== save_task_state Canonicalization (HOK-2900) ==="

# --- Structural guards -------------------------------------------------------

DEFINING_FILES=()
for f in wavemill-mill.sh wavemill-startup-runner.sh wavemill-monitor.sh wavemill-common.sh; do
  if grep -qE '^save_task_state\(\) \{' "$REPO_DIR/shared/lib/$f"; then
    DEFINING_FILES+=("shared/lib/$f")
  fi
done
check_eq "exactly one save_task_state definition exists, in wavemill-common.sh" \
  "shared/lib/wavemill-common.sh" "${DEFINING_FILES[*]:-none}"

CANONICAL_BODY="$(awk '
  /^save_task_state\(\) \{/ { capture=1 }
  capture { print }
  /^}/ && capture { exit }
' "$REPO_DIR/shared/lib/wavemill-common.sh")"

if [[ -z "$CANONICAL_BODY" ]]; then
  echo "Could not extract canonical save_task_state from wavemill-common.sh"
  exit 1
fi

check_contains "canonical writer performs the write via state_mutate" \
  "$CANONICAL_BODY" 'state_mutate "$STATE_FILE"'
check_contains "canonical writer merges over the stored task object" \
  "$CANONICAL_BODY" '.tasks[$issue] = ($existing + {'
check_contains "canonical status default is active" \
  "$CANONICAL_BODY" 'status="${status_arg:-active}"'
check_contains "canonical tail fixes challengeStage at argument 19" \
  "$CANONICAL_BODY" 'challenge_stage="${19:-}"'
check_contains "canonical tail fixes phase at argument 20" \
  "$CANONICAL_BODY" 'phase="${20:-}"'
check_contains "canonical tail fixes windowId at argument 21" \
  "$CANONICAL_BODY" 'window_id="${21:-}"'

# --- Behavioral coverage -----------------------------------------------------

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

WORKTREE="$TEST_TMP/worktree"
STATE_FILE="$TEST_TMP/state.json"
STARTUP_STATE_FILE="$TEST_TMP/state-startup.json"
VALIDATION_STATE_FILE="$TEST_TMP/state-validation.json"
mkdir -p "$WORKTREE/features/hok-2900" "$WORKTREE/bugs/hok-2900"

# Fixture intentionally mixes every field class the old monitor allowlist knew
# about with fields it silently dropped (windowId) and unknown future fields.
cat > "$STATE_FILE" <<JSON
{
  "session": "canonicalization-test",
  "started": "2026-01-01T00:00:00Z",
  "tasks": {
    "HOK-2900": {
      "slug": "hok-2900",
      "branch": "task/hok-2900",
      "worktree": "$WORKTREE",
      "pr": "77",
      "status": "review",
      "agent": "codex",
      "linearIssueId": "HOK-2900",
      "phase": "review",
      "windowId": "@3",
      "challenge": true,
      "challengePairId": "HOK-2900",
      "challengeRole": "challenger",
      "challengeStage": "review",
      "challengeModel": "model-b",
      "challengeIntent": {
        "pairId": "HOK-2900",
        "challengeStage": "review",
        "challenger": {"expectedRoute": {"reviewer": "qwen-3-coder"}}
      },
      "challengeExecutionIntent": {"pairId": "HOK-2900", "preserved": true},
      "challengeVariedModel": "kimi-k2",
      "challengeVariedAgent": "native-openrouter",
      "evalCompleted": false,
      "evalFailed": false,
      "evalHardFailureRetryCount": 2,
      "evalRunning": {"side": "primary", "pr": 77},
      "comparisonRunning": null,
      "comparisonState": {"primaryPr": "77", "challengerPr": "78"},
      "comparisonBlockedReason": "pr-missing",
      "comparisonRetryCount": 1,
      "comparisonRetryMaxAttempts": 3,
      "comparisonRetryTargetIssue": "HOK-2900",
      "comparisonTimedOutSides": [],
      "manualComparisonArtifact": "/tmp/manual-comparison.md",
      "launchFailure": {"reason": "routing", "detail": "No PR created"},
      "routing": {"planner": "gpt-5.6-terra", "coder": "gpt-5.5"},
      "retry": {"count": 1},
      "execution": {"attempt": 2},
      "unknownFutureField": {"nested": {"deep": true}},
      "traceId": "trc_stored"
    }
  }
}
JSON

# Monitor-shaped thin update: 19 positional arguments ending in challengeStage,
# blank status argument. A thin write must never drop metadata the writer does
# not understand, and the blank status must default to active (the parent copy
# used to write a literal empty status here).
bash -c '
  set -euo pipefail
  STATE_FILE="$1"; WORKTREE="$2"; REPO_DIR="$3"
  source "$REPO_DIR/shared/lib/wavemill-common.sh"
  log_warn() { :; }
  save_task_state "HOK-2900" "hok-2900" "task/hok-2900" "$WORKTREE" "77" "" "codex" "HOK-2900" \
    "true" "HOK-2900" "challenger" "model-b" \
    "planner-m" "coder-m" "reviewer-m" "light" "medium" "llm" "review"
' bash "$STATE_FILE" "$WORKTREE" "$REPO_DIR"

check_state "blank status argument saves active" "active" "$STATE_FILE" '.tasks["HOK-2900"].status'
check_state "supplied pr is written" "77" "$STATE_FILE" '.tasks["HOK-2900"].pr'
check_state "supplied agent is written" "codex" "$STATE_FILE" '.tasks["HOK-2900"].agent'
check_state "supplied models are written" "planner-m" "$STATE_FILE" '.tasks["HOK-2900"].plannerModel'
check_state "stored phase is retained" "review" "$STATE_FILE" '.tasks["HOK-2900"].phase'
check_state "stored windowId survives a monitor-shaped save" "@3" "$STATE_FILE" '.tasks["HOK-2900"].windowId'
check_state "challenge flag overlay still applies" "true" "$STATE_FILE" '.tasks["HOK-2900"].challenge'
check_state "supplied challengeStage is written" "review" "$STATE_FILE" '.tasks["HOK-2900"].challengeStage'
check_state "stored challengeIntent is retained" "qwen-3-coder" \
  "$STATE_FILE" '.tasks["HOK-2900"].challengeIntent.challenger.expectedRoute.reviewer'
check_state "stored challengeExecutionIntent is retained" "true" \
  "$STATE_FILE" '.tasks["HOK-2900"].challengeExecutionIntent.preserved'
check_state "stored challengeVariedModel is retained" "kimi-k2" "$STATE_FILE" '.tasks["HOK-2900"].challengeVariedModel'
check_state "stored challengeVariedAgent is retained" "native-openrouter" "$STATE_FILE" '.tasks["HOK-2900"].challengeVariedAgent'
check_state "stored eval retry state is retained" "2" "$STATE_FILE" '.tasks["HOK-2900"].evalHardFailureRetryCount'
check_state "stored evalRunning object is retained" "primary" "$STATE_FILE" '.tasks["HOK-2900"].evalRunning.side'
check_state "stored comparisonState object is retained" "78" "$STATE_FILE" '.tasks["HOK-2900"].comparisonState.challengerPr'
check_state "stored comparison retry metadata is retained" "1" "$STATE_FILE" '.tasks["HOK-2900"].comparisonRetryCount'
check_state "stored manualComparisonArtifact is retained" "/tmp/manual-comparison.md" \
  "$STATE_FILE" '.tasks["HOK-2900"].manualComparisonArtifact'
check_state "stored launchFailure is retained" "routing" "$STATE_FILE" '.tasks["HOK-2900"].launchFailure.reason'
check_state "unknown routing metadata is retained" "gpt-5.6-terra" "$STATE_FILE" '.tasks["HOK-2900"].routing.planner'
check_state "unknown retry metadata is retained" "1" "$STATE_FILE" '.tasks["HOK-2900"].retry.count'
check_state "unknown execution metadata is retained" "2" "$STATE_FILE" '.tasks["HOK-2900"].execution.attempt'
check_state "unknown future field is retained" "true" "$STATE_FILE" '.tasks["HOK-2900"].unknownFutureField.nested.deep'
check_state "comparisonTimedOutSides stays an array" "array" "$STATE_FILE" '.tasks["HOK-2900"].comparisonTimedOutSides | type'
check_state "stored traceId is retained without trace context" "trc_stored" "$STATE_FILE" '.tasks["HOK-2900"].traceId'
check_state "lifecycle schema is backfilled" "1" "$STATE_FILE" '.tasks["HOK-2900"].lifecycle.schemaVersion'
check_state "active workflow outcome is backfilled" "active" "$STATE_FILE" '.tasks["HOK-2900"].lifecycle.workflowOutcome'
check_state "active task consumes allocated resources" "allocated" "$STATE_FILE" '.tasks["HOK-2900"].lifecycle.resourceDisposition'
check_state "launch contract records explicit remote deletion policy" "true" \
  "$STATE_FILE" '.tasks["HOK-2900"].lifecycle.launchContract.remoteBranchDeletionPolicy.allowed'
check_state "launch contract records cleanup deletion mode" "merged-pr-task-branch" \
  "$STATE_FILE" '.tasks["HOK-2900"].lifecycle.launchContract.remoteBranchDeletionPolicy.mode'
check_state "delivery evidence records PR number" "77" "$STATE_FILE" '.tasks["HOK-2900"].lifecycle.deliveryEvidence.prNumber'

# Trace contract: features/<slug>/.trace-context.json wins, a malformed context
# never fails the write nor erases the resolved traceId, and bugs/<slug> is the
# fallback when no feature context exists.
TRACE_RESULTS="$(bash -c '
  set -euo pipefail
  STATE_FILE="$1"; WORKTREE="$2"; REPO_DIR="$3"
  source "$REPO_DIR/shared/lib/wavemill-common.sh"
  log_warn() { :; }
  save_call() {
    save_task_state "HOK-2900" "hok-2900" "task/hok-2900" "$WORKTREE" "77" "merged" "codex" "HOK-2900" \
      "true" "HOK-2900" "challenger" "model-b" \
      "planner-m" "coder-m" "reviewer-m" "light" "medium" "llm" "review"
  }
  printf "%s\n" "{\"traceId\":\"trc-feature-1\",\"issueId\":\"HOK-2900\",\"slug\":\"hok-2900\"}" \
    > "$WORKTREE/features/hok-2900/.trace-context.json"
  save_call
  printf "%s\n" "$(jq -r ".tasks[\"HOK-2900\"].traceId" "$STATE_FILE")"

  # Malformed context: the write must still succeed (set -e would abort first).
  printf "%s\n" "{bad json" > "$WORKTREE/features/hok-2900/.trace-context.json"
  save_call
  printf "%s\n" "$(jq -r ".tasks[\"HOK-2900\"].traceId" "$STATE_FILE")"

  # bugs/<slug> fallback once the feature context is gone.
  rm -f "$WORKTREE/features/hok-2900/.trace-context.json"
  printf "%s\n" "{\"traceId\":\"trc-bug-1\"}" > "$WORKTREE/bugs/hok-2900/.trace-context.json"
  save_call
  printf "%s\n" "$(jq -r ".tasks[\"HOK-2900\"].traceId" "$STATE_FILE")"
' bash "$STATE_FILE" "$WORKTREE" "$REPO_DIR")"
mapfile -t TRACE_RESULTS <<< "$TRACE_RESULTS"

check_eq "feature trace context resolves into the state write" "trc-feature-1" "${TRACE_RESULTS[0]:-}"
check_eq "malformed trace context neither fails the write nor erases the traceId" "trc-feature-1" "${TRACE_RESULTS[1]:-}"
check_eq "bugs trace context is used when no feature context exists" "trc-bug-1" "${TRACE_RESULTS[2]:-}"
check_state "explicit non-empty status wins over the active default" "merged" "$STATE_FILE" '.tasks["HOK-2900"].status'
check_state "merged status separates workflow outcome" "merged" "$STATE_FILE" '.tasks["HOK-2900"].lifecycle.workflowOutcome'
check_state "merged retained state requires verification after save" "verification-required" \
  "$STATE_FILE" '.tasks["HOK-2900"].lifecycle.resourceDisposition'
check_state "merge write still preserves challengeIntent" "qwen-3-coder" \
  "$STATE_FILE" '.tasks["HOK-2900"].challengeIntent.challenger.expectedRoute.reviewer'

bash -c '
  set -euo pipefail
  STATE_FILE="$1"; WORKTREE="$2"; REPO_DIR="$3"
  source "$REPO_DIR/shared/lib/wavemill-common.sh"
  log_warn() { :; }
  save_task_state "HOK-2900" "hok-2900" "task/hok-2900" "$WORKTREE" "77" "" "codex" "HOK-2900" \
    "" "" "" "" "" "" "" "" "" "" "" "" ""
' bash "$STATE_FILE" "$WORKTREE" "$REPO_DIR"
check_state "blank metadata save does not reactivate terminal status" "merged" "$STATE_FILE" '.tasks["HOK-2900"].status'
check_state "blank metadata save keeps terminal outcome" "merged" "$STATE_FILE" '.tasks["HOK-2900"].lifecycle.workflowOutcome'

# Startup-shaped call: 21 positional arguments with the canonical tail
# challengeStage(19), phase(20), windowId(21). This is the layout that used to
# collide on argument 19 (phase there, challengeStage in the monitor).
printf '%s\n' '{"session":"canonicalization-startup","tasks":{}}' > "$STARTUP_STATE_FILE"
bash -c '
  set -euo pipefail
  STATE_FILE="$1"; WORKTREE="$2"; REPO_DIR="$3"
  source "$REPO_DIR/shared/lib/wavemill-common.sh"
  log_warn() { :; }
  save_task_state "HOK-2901" "hok-2901" "task/hok-2901" "$WORKTREE" "" "" "codex" "HOK-2901" \
    "false" "" "" "" \
    "planner-m" "coder-m" "reviewer-m" "light" "medium" "llm" "" "planning" "%5"
  # An explicit non-empty status must win over the active default, and blank
  # phase/windowId arguments must retain the stored values.
  save_task_state "HOK-2901" "hok-2901" "task/hok-2901" "$WORKTREE" "" "error" "codex" "HOK-2901" \
    "" "" "" "" "" "" "" "" "" "" "" "" ""
' bash "$STARTUP_STATE_FILE" "$WORKTREE" "$REPO_DIR"

check_state "startup-shaped call creates the task" "hok-2901" "$STARTUP_STATE_FILE" '.tasks["HOK-2901"].slug'
check_state "startup launch write no longer stores an empty status" "error" "$STARTUP_STATE_FILE" '.tasks["HOK-2901"].status'
check_state "startup-shaped call writes phase at argument 20" "planning" "$STARTUP_STATE_FILE" '.tasks["HOK-2901"].phase'
check_state "startup-shaped call writes windowId at argument 21" "%5" "$STARTUP_STATE_FILE" '.tasks["HOK-2901"].windowId'
check_state "blank challengeStage argument leaves the field unset" "absent" \
  "$STARTUP_STATE_FILE" '.tasks["HOK-2901"].challengeStage // "absent"'
check_state "challenge=false argument is written" "false" "$STARTUP_STATE_FILE" '.tasks["HOK-2901"].challenge'
check_state "blank challenge fields do not create empty records" "absent" \
  "$STARTUP_STATE_FILE" '.tasks["HOK-2901"].challengePairId // "absent"'

# Challenge-role derivation: a primary challenge write can derive an omitted
# role from challengePairId == issue, but underivable empty roles still fail
# before any mutation.
printf '%s\n' '{"session":"canonicalization-validation","tasks":{}}' > "$VALIDATION_STATE_FILE"
DERIVED_ROLE_RESULT="$(bash -c '
  set -euo pipefail
  STATE_FILE="$1"; WORKTREE="$2"; REPO_DIR="$3"
  source "$REPO_DIR/shared/lib/wavemill-common.sh"
  log_warn() { :; }
  if save_task_state "HOK-2931" "hok-2931" "task/hok-2931" "$WORKTREE" "9" "coding" "codex" "HOK-2931" \
    "true" "HOK-2931" "" "model-a" \
    "planner-m" "coder-m" "reviewer-m" "light" "medium" "llm" "implementation"; then
    printf "saved\n"
  else
    printf "rejected\n"
  fi
' bash "$VALIDATION_STATE_FILE" "$WORKTREE" "$REPO_DIR")"

check_eq "matching challenge pair derives an omitted primary role" "saved" "$DERIVED_ROLE_RESULT"
check_state "derived challengeRole is persisted as primary" "primary" \
  "$VALIDATION_STATE_FILE" '.tasks["HOK-2931"].challengeRole'
check_state "derived-role write keeps the challenge pair id" "HOK-2931" \
  "$VALIDATION_STATE_FILE" '.tasks["HOK-2931"].challengePairId'

printf '%s\n' '{"session":"canonicalization-validation","tasks":{"HOK-2932":{"slug":"hok-2932","status":"review","validationProbe":"kept"}}}' \
  > "$VALIDATION_STATE_FILE"
EMPTY_PAIR_ERR="$TEST_TMP/empty-pair.err"
EMPTY_PAIR_RESULT="$(bash -c '
  set -euo pipefail
  STATE_FILE="$1"; WORKTREE="$2"; REPO_DIR="$3"; ERR_FILE="$4"
  source "$REPO_DIR/shared/lib/wavemill-common.sh"
  log_warn() { :; }
  if save_task_state "HOK-2932" "hok-2932" "task/hok-2932" "$WORKTREE" "9" "coding" "codex" "HOK-2932" \
    "true" "" "" "model-a" \
    "planner-m" "coder-m" "reviewer-m" "light" "medium" "llm" "implementation" 2>"$ERR_FILE"; then
    printf "mutated\n"
  else
    printf "rejected\n"
  fi
' bash "$VALIDATION_STATE_FILE" "$WORKTREE" "$REPO_DIR" "$EMPTY_PAIR_ERR")"

check_eq "challenge write with empty pair and empty role is rejected" "rejected" "$EMPTY_PAIR_RESULT"
check_contains "empty-pair rejection emits the existing role error" \
  "$(<"$EMPTY_PAIR_ERR")" "Error: challengeRole cannot be empty for challenge task HOK-2932"
check_state "empty-pair rejection leaves the stored status untouched" "review" \
  "$VALIDATION_STATE_FILE" '.tasks["HOK-2932"].status'
check_state "empty-pair rejection leaves the task object untouched" "kept" \
  "$VALIDATION_STATE_FILE" '.tasks["HOK-2932"].validationProbe'

printf '%s\n' '{"session":"canonicalization-validation","tasks":{"HOK-2933":{"slug":"hok-2933","status":"review","validationProbe":"kept"}}}' \
  > "$VALIDATION_STATE_FILE"
MISMATCHED_PAIR_ERR="$TEST_TMP/mismatched-pair.err"
MISMATCHED_PAIR_RESULT="$(bash -c '
  set -euo pipefail
  STATE_FILE="$1"; WORKTREE="$2"; REPO_DIR="$3"; ERR_FILE="$4"
  source "$REPO_DIR/shared/lib/wavemill-common.sh"
  log_warn() { :; }
  if save_task_state "HOK-2933" "hok-2933" "task/hok-2933" "$WORKTREE" "9" "coding" "codex" "HOK-2933" \
    "true" "HOK-9999" "" "model-a" \
    "planner-m" "coder-m" "reviewer-m" "light" "medium" "llm" "implementation" 2>"$ERR_FILE"; then
    printf "mutated\n"
  else
    printf "rejected\n"
  fi
' bash "$VALIDATION_STATE_FILE" "$WORKTREE" "$REPO_DIR" "$MISMATCHED_PAIR_ERR")"

check_eq "challenge write with mismatched pair and empty role is rejected" "rejected" "$MISMATCHED_PAIR_RESULT"
check_contains "mismatched-pair rejection emits the existing role error" \
  "$(<"$MISMATCHED_PAIR_ERR")" "Error: challengeRole cannot be empty for challenge task HOK-2933"
check_state "mismatched-pair rejection leaves the stored status untouched" "review" \
  "$VALIDATION_STATE_FILE" '.tasks["HOK-2933"].status'
check_state "mismatched-pair rejection leaves the task object untouched" "kept" \
  "$VALIDATION_STATE_FILE" '.tasks["HOK-2933"].validationProbe'

printf '%s\n' '{"session":"canonicalization-validation","tasks":{}}' > "$VALIDATION_STATE_FILE"
EXPLICIT_ROLE_RESULTS="$(bash -c '
  set -euo pipefail
  STATE_FILE="$1"; WORKTREE="$2"; REPO_DIR="$3"
  source "$REPO_DIR/shared/lib/wavemill-common.sh"
  log_warn() { :; }
  save_task_state "HOK-2934" "hok-2934" "task/hok-2934" "$WORKTREE" "10" "coding" "codex" "HOK-2934" \
    "true" "HOK-2934" "challenger" "model-a" \
    "planner-m" "coder-m" "reviewer-m" "light" "medium" "llm" "implementation"
  save_task_state "HOK-2931_c" "hok-2931-c" "task/hok-2931-c" "$WORKTREE" "11" "coding" "codex" "HOK-2931_c" \
    "true" "HOK-2931" "challenger" "model-b" \
    "planner-m" "coder-m" "reviewer-m" "light" "medium" "llm" "implementation"
  printf "saved\n"
' bash "$VALIDATION_STATE_FILE" "$WORKTREE" "$REPO_DIR")"

check_eq "explicit challenge roles are accepted" "saved" "$EXPLICIT_ROLE_RESULTS"
check_state "explicit role is not replaced by derivation" "challenger" \
  "$VALIDATION_STATE_FILE" '.tasks["HOK-2934"].challengeRole'
check_state "explicit challenger role writes are unaffected" "challenger" \
  "$VALIDATION_STATE_FILE" '.tasks["HOK-2931_c"].challengeRole'

echo ""
echo "Passed: $PASS"
echo "Failed: $FAIL"

if [[ $FAIL -ne 0 ]]; then
  exit 1
fi
