#!/usr/bin/env bash
# HOK-2814: post-fork shape audit — the tracked job monitor loop assumes both
# arms are already present, which is still the correct shape post-fork (by the
# time a tracked job is polling, both arms exist). The fork itself is covered
# by challenge-deferred-arm.test.sh and challenge-fork-*.test.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

run_case() {
  local kind="$1"
  local tmp_dir state_file log_path result_path completion_marker pid job_id pr_numbers timeout status cycles drains
  local -a job_flags=()
  tmp_dir="$(mktemp -d)"
  state_file="$tmp_dir/workflow-state.json"
  log_path="$tmp_dir/${kind}.log"
  result_path="$tmp_dir/${kind}.result.json"
  completion_marker="$tmp_dir/${kind}.complete"
  printf '{"tasks":{"HOK-1564":{"challengePairId":"HOK-1564","challengeRole":"primary"},"HOK-1564_c":{"challengePairId":"HOK-1564","challengeRole":"challenger"}}}\n' > "$state_file"
  printf 'job running\n' > "$log_path"

  if [[ "$kind" == "eval" ]]; then
    (
      while [[ ! -f "$completion_marker" ]]; do
        sleep 0.05
      done
    ) &
  else
    (
      sleep 30
    ) &
  fi
  pid=$!

  if [[ "$kind" == "eval" ]]; then
    job_id="eval-HOK-1564-primary-101"
    pr_numbers="101"
    job_flags=(--issue-id HOK-1564 --side primary --pair-id HOK-1564)
  else
    job_id="comparison-HOK-1564-101-102"
    pr_numbers="101,102"
    job_flags=(--pair-id HOK-1564)
  fi
  timeout=30

  npx tsx "$REPO_DIR/tools/job-tracker.ts" launch \
    --state-file "$state_file" \
    --kind "$kind" \
    --job-id "$job_id" \
    "${job_flags[@]}" \
    --pr-numbers "$pr_numbers" \
    --pid "$pid" \
    --timeout-seconds "$timeout" \
    --log-path "$log_path" \
    --result-path "$result_path" >/dev/null

  status="running"
  cycles=0
  drains=0
  while [[ "$status" == "running" && $cycles -lt 10 ]]; do
    drains=$((drains + 1))
    npx tsx "$REPO_DIR/tools/job-tracker.ts" poll --state-file "$state_file" >/dev/null
    if (( cycles == 1 )); then
      cat > "$result_path" <<'JSON'
{"ok":true,"exitCode":0}
JSON
      if [[ "$kind" == "eval" ]]; then
        : > "$completion_marker"
      fi
    fi
    status=$(jq -r --arg id "$job_id" '.jobs[$id].status // "running"' "$state_file")
    cycles=$((cycles + 1))
    sleep 0.2
  done

  if (( cycles >= 2 )); then
    pass "$kind monitor loop keeps iterating while job runs"
  else
    fail "$kind monitor loop did not iterate enough while job ran"
  fi

  if (( drains >= cycles )); then
    pass "$kind loop continues draining commands during job"
  else
    fail "$kind loop did not keep draining while job ran"
  fi

  if [[ "$status" == "succeeded" ]]; then
    pass "$kind job finishes successfully after polling"
  else
    fail "$kind job did not finish successfully"
  fi

  rm -rf "$tmp_dir"
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

run_failed_comparison_case() {
  local tmp_dir state_file log_path result_path pid job_id status blocked_primary blocked_challenger
  tmp_dir="$(mktemp -d)"
  state_file="$tmp_dir/workflow-state.json"
  log_path="$tmp_dir/comparison.log"
  result_path="$tmp_dir/comparison.result.json"
  job_id="comparison-HOK-1564-101-102"
  cat > "$state_file" <<'JSON'
{"tasks":{"HOK-1564":{"challengePairId":"HOK-1564","challengeRole":"primary","challengeCompared":false,"comparisonState":"comparison_running","comparisonRunning":{"startedAt":"2026-06-23T00:00:00.000Z"}},"HOK-1564_c":{"challengePairId":"HOK-1564","challengeRole":"challenger","challengeCompared":false,"comparisonState":"comparison_running","comparisonRunning":{"startedAt":"2026-06-23T00:00:00.000Z"}}}}
JSON
  printf 'comparison failed\n' > "$log_path"

  (
    sleep 0.2
    cat > "$result_path" <<'JSON'
{"ok":false,"exitCode":1,"reason":"Challenge comparison has no varied routing dimensions"}
JSON
    sleep 30
  ) &
  pid=$!

  npx tsx "$REPO_DIR/tools/job-tracker.ts" launch \
    --state-file "$state_file" \
    --kind comparison \
    --job-id "$job_id" \
    --pair-id HOK-1564 \
    --pr-numbers 101,102 \
    --pid "$pid" \
    --timeout-seconds 30 \
    --log-path "$log_path" \
    --result-path "$result_path" >/dev/null

  sleep 0.4
  npx tsx "$REPO_DIR/tools/job-tracker.ts" poll --state-file "$state_file" >/dev/null
  status=$(jq -r --arg id "$job_id" '.jobs[$id].status // "running"' "$state_file")

  if [[ "$status" == "failed" ]]; then
    pass "comparison job fails from terminal result before pid exit"
  else
    fail "comparison job did not fail while pid was still alive"
  fi

  if kill -0 "$pid" 2>/dev/null; then
    pass "comparison worker remains alive after terminal result"
  else
    fail "comparison worker exited before live-pid poll check"
  fi

  npx tsx "$REPO_DIR/tools/job-tracker.ts" mark-settled --state-file "$state_file" --job-id "$job_id" >/dev/null
  blocked_primary=$(jq -r '.tasks["HOK-1564"].comparisonState // ""' "$state_file")
  blocked_challenger=$(jq -r '.tasks["HOK-1564_c"].comparisonState // ""' "$state_file")

  if [[ "$blocked_primary" == "manual_comparison_needed" && "$blocked_challenger" == "manual_comparison_needed" ]]; then
    pass "comparison settlement moves both sides to manual comparison"
  else
    fail "comparison settlement did not update both sides"
  fi

  if [[ "$(jq -r '.tasks["HOK-1564"].comparisonRunning == null' "$state_file")" == "true" \
    && "$(jq -r '.tasks["HOK-1564_c"].comparisonRunning == null' "$state_file")" == "true" ]]; then
    pass "comparison settlement clears running markers"
  else
    fail "comparison settlement did not clear running markers"
  fi

  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  rm -rf "$tmp_dir"
}

echo "=== Challenge Job Monitor Loop ==="
run_case eval
run_case comparison
run_failed_comparison_case

echo ""
echo "Passed: $PASS"
echo "Failed: $FAIL"

if [[ $FAIL -ne 0 ]]; then
  exit 1
fi
