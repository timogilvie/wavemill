#!/usr/bin/env bash
# HOK-3513: the one write of "a passed Ready verdict no longer holds".
#
# `invalidate_ready_verdict` records red CI, a GitHub conflict or a tend rebase
# conflict as a failed Ready result. This test drives the real monitor function
# (write_stage_result captured, never executed) and asserts the behaviour the
# rest of the mill depends on:
#   - the completed pass's agent/model are carried forward, otherwise the
#     failed-Ready recovery refuses the result and never relaunches Ready;
#   - `mergeConflict` keeps the pass's value (CONFLICT* would read as base
#     drift and page at once instead of repairing);
#   - the live mergeability is recorded in its own fields with the cause;
#   - it is idempotent: a running or already-failed result is never clobbered.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_ROOT/shared/lib/wavemill-monitor.sh"

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

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

extract_function() {
  local source_file="$1"
  local function_name="$2"
  awk -v name="$function_name" '
    function brace_delta(line, opened, closed) {
      opened = gsub(/\{/, "{", line)
      closed = gsub(/\}/, "}", line)
      return opened - closed
    }
    $0 ~ "^" name "\\(\\) \\{" { capture=1; depth=0 }
    capture {
      print
      depth += brace_delta($0)
      if (depth == 0) { exit }
    }
  ' "$source_file"
}

FUNC_FILE="$TEST_TMP/monitor_funcs.sh"
{
  extract_function "$MONITOR_SCRIPT_FILE" invalidate_ready_verdict
  extract_function "$MONITOR_SCRIPT_FILE" ready_failure_base_drift
  extract_function "$MONITOR_SCRIPT_FILE" ready_failure_evidence_detail
  extract_function "$MONITOR_SCRIPT_FILE" ready_failure_reason
} > "$FUNC_FILE"

# shellcheck disable=SC1090
source "$FUNC_FILE"
declare -F invalidate_ready_verdict >/dev/null || {
  echo "could not extract invalidate_ready_verdict" >&2
  exit 1
}

BASE_BRANCH="main"
WRITE_ARGS_FILE="$TEST_TMP/write-args.json"

log() { :; }
# Capture the write instead of running the stage-result CLI.
write_stage_result() {
  jq -cn \
    --arg dir "$1" --arg stage "$2" --arg status "$3" \
    --arg agent "${4:-}" --arg model "${5:-}" --arg notes "${6:-}" \
    --argjson artifacts "${7:-null}" \
    '{dir:$dir,stage:$stage,status:$status,agent:$agent,model:$model,notes:$notes,artifacts:$artifacts}' \
    > "$WRITE_ARGS_FILE"
}

write_result() {
  local state_dir="$1" payload="$2"
  mkdir -p "$state_dir"
  printf '%s\n' "$payload" > "$state_dir/.ready-result.json"
}

# A completed Ready pass that also became a merge candidate, as HOK-3493 had.
PASSED_RESULT='{"stage":"ready","status":"completed","agent":"codex","model":"deepseek-v4-flash",
  "startedAt":"2026-11-16T17:50:00Z","finishedAt":"2026-11-16T18:00:00Z",
  "artifacts":{"type":"ready","verdict":"pass","prNumber":1865,"mergeConflict":"CLEAN",
    "readyHeadSha":"abc1234","readyBaseSha":"def5678","queueState":"merge-candidate",
    "candidatePromotedAt":"2026-11-16T17:59:00Z","ciConclusion":"pass"}}'
CONFLICT_CI='{"conclusion":"pending","headSha":"abc1234","mergeable":"CONFLICTING","mergeStateStatus":"DIRTY","failing":[],"observed":3,"requiredContexts":["unit"]}'
FAILING_CI='{"conclusion":"fail","headSha":"abc1234","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","failing":["Shell and Unit Tests"],"observed":15,"requiredContexts":["unit"]}'

echo "=== conflict after Ready passed ==="
CASE_DIR="$TEST_TMP/conflict"
write_result "$CASE_DIR" "$PASSED_RESULT"
invalidate_ready_verdict "HOK-3513" "$CASE_DIR" "$CONFLICT_CI" conflict

check_eq "the result is rewritten as failed" "failed" "$(jq -r '.status' "$WRITE_ARGS_FILE")"
check_eq "the pass's agent is carried forward" "codex" "$(jq -r '.agent' "$WRITE_ARGS_FILE")"
check_eq "the pass's model is carried forward" "deepseek-v4-flash" "$(jq -r '.model' "$WRITE_ARGS_FILE")"
check_eq "the verdict is fail" "fail" "$(jq -r '.artifacts.verdict' "$WRITE_ARGS_FILE")"
check_eq "the cause is recorded" "conflict" "$(jq -r '.artifacts.verdictInvalidationCause' "$WRITE_ARGS_FILE")"
check_eq "the live mergeable read is recorded" "CONFLICTING" "$(jq -r '.artifacts.liveMergeable' "$WRITE_ARGS_FILE")"
check_eq "the live mergeStateStatus is recorded" "DIRTY" "$(jq -r '.artifacts.liveMergeStateStatus' "$WRITE_ARGS_FILE")"
check_eq "mergeConflict keeps the pass's value (not base drift)" "CLEAN" "$(jq -r '.artifacts.mergeConflict' "$WRITE_ARGS_FILE")"
check_eq "queueState is cleared so the PR leaves the lane" "null" "$(jq -r '.artifacts.queueState // "null"' "$WRITE_ARGS_FILE")"
check_eq "an invalidation timestamp is recorded" "yes" \
  "$(jq -r 'if (.artifacts.verdictInvalidatedAt // "") == "" then "no" else "yes" end' "$WRITE_ARGS_FILE")"
check_eq "the reason names the conflict and the base" "yes" \
  "$(jq -r 'if (.artifacts.verdictInvalidationReason // "") | test("conflicts with main after Ready passed") then "yes" else "no" end' "$WRITE_ARGS_FILE")"

echo ""
echo "=== red CI after Ready passed ==="
CASE_DIR="$TEST_TMP/ci"
write_result "$CASE_DIR" "$PASSED_RESULT"
invalidate_ready_verdict "HOK-3513" "$CASE_DIR" "$FAILING_CI" ci-failing
check_eq "the cause is ci-failing" "ci-failing" "$(jq -r '.artifacts.verdictInvalidationCause' "$WRITE_ARGS_FILE")"
check_eq "the failing checks are listed" '["Shell and Unit Tests"]' "$(jq -c '.artifacts.ciFailingChecks' "$WRITE_ARGS_FILE")"
check_eq "the reason keeps the CI wording" "CI regressed after ready pass: Shell and Unit Tests" \
  "$(jq -r '.artifacts.verdictInvalidationReason' "$WRITE_ARGS_FILE")"
check_eq "the passed mergeConflict is kept" "CLEAN" "$(jq -r '.artifacts.mergeConflict' "$WRITE_ARGS_FILE")"

echo ""
echo "=== tend rebase conflict after Ready passed ==="
CASE_DIR="$TEST_TMP/tend"
write_result "$CASE_DIR" "$PASSED_RESULT"
invalidate_ready_verdict "HOK-3513" "$CASE_DIR" "$CONFLICT_CI" tend-rebase-conflict
check_eq "the cause is tend-rebase-conflict" "tend-rebase-conflict" "$(jq -r '.artifacts.verdictInvalidationCause' "$WRITE_ARGS_FILE")"
check_eq "the reason names tend and the base" "yes" \
  "$(jq -r 'if (.artifacts.verdictInvalidationReason // "") | test("tend could not rebase PR #1865 onto main after Ready passed") then "yes" else "no" end' "$WRITE_ARGS_FILE")"

echo ""
echo "=== idempotence ==="
CASE_DIR="$TEST_TMP/running"
write_result "$CASE_DIR" '{"stage":"ready","status":"running","agent":"codex","model":"m","artifacts":{"type":"ready","verdict":"pending","mergeConflict":"CONFLICTED"}}'
rm -f "$WRITE_ARGS_FILE"
invalidate_ready_verdict "HOK-3513" "$CASE_DIR" "$CONFLICT_CI" conflict
check_eq "a running Ready is never clobbered" "no" "$([[ -f "$WRITE_ARGS_FILE" ]] && echo yes || echo no)"

CASE_DIR="$TEST_TMP/already-failed"
write_result "$CASE_DIR" '{"stage":"ready","status":"failed","agent":"codex","model":"m","artifacts":{"type":"ready","verdict":"fail"}}'
rm -f "$WRITE_ARGS_FILE"
invalidate_ready_verdict "HOK-3513" "$CASE_DIR" "$CONFLICT_CI" conflict
check_eq "an already failed Ready is never rewritten" "no" "$([[ -f "$WRITE_ARGS_FILE" ]] && echo yes || echo no)"

CASE_DIR="$TEST_TMP/no-result"
rm -f "$WRITE_ARGS_FILE"
invalidate_ready_verdict "HOK-3513" "$CASE_DIR" "$CONFLICT_CI" conflict
check_eq "no result file is a no-op" "no" "$([[ -f "$WRITE_ARGS_FILE" ]] && echo yes || echo no)"

echo ""
echo "=== the invalidated result is not base drift (finding 2) ==="
CASE_DIR="$TEST_TMP/drift"
write_result "$CASE_DIR" "$PASSED_RESULT"
invalidate_ready_verdict "HOK-3513" "$CASE_DIR" "$CONFLICT_CI" conflict
# Apply the captured write so ready_failure_base_drift reads the real shape.
jq '.artifacts' "$WRITE_ARGS_FILE" > "$CASE_DIR/artifacts.json"
jq --slurpfile a "$CASE_DIR/artifacts.json" '.status = "failed" | .artifacts = $a[0]' \
  "$CASE_DIR/.ready-result.json" > "$CASE_DIR/.ready-result.json.tmp"
mv "$CASE_DIR/.ready-result.json.tmp" "$CASE_DIR/.ready-result.json"
check_eq "the invalidated result still carries a non-conflict mergeConflict" "CLEAN" \
  "$(jq -r '.artifacts.mergeConflict' "$CASE_DIR/.ready-result.json")"
check_eq "a conflict invalidation is not read as base drift" "no" \
  "$(ready_failure_base_drift "$CASE_DIR" "$CASE_DIR" main)"

echo ""
echo "=== Totals ==="
echo "pass=$PASS fail=$FAIL"
exit "$FAIL"
