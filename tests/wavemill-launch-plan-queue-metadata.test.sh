#!/usr/bin/env bash
# wavemill-test-suite: lifecycle (run by tests/run-lifecycle-tests.sh)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LEGACY="$REPO_DIR/tests/fixtures/startup/launch-plan-legacy.json"
QUEUE="$REPO_DIR/tests/fixtures/startup/launch-plan-with-queue.json"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

expect_true() {
  local name="$1" expr="$2" file="$3"
  if jq -e "$expr" "$file" >/dev/null 2>&1; then
    pass "$name"
  else
    fail "$name"
  fi
}

echo "=== Launch Plan Queue Metadata Compatibility ==="

# 1. Legacy fixture shape
expect_true "legacy has no queuePlan key" 'has("queuePlan") | not' "$LEGACY"
expect_true "legacy tasks have no dependsOn key" '[.tasks[] | has("dependsOn")] | any | not' "$LEGACY"
expect_true "legacy tasks have no baseFromTask key" '[.tasks[] | has("baseFromTask")] | any | not' "$LEGACY"

# 2. Queue fixture shape (raw queuePlan format: {availableNow, queuedAfterDependencies, ...})
expect_true "queuePlan has availableNow field" '.queuePlan | has("availableNow")' "$QUEUE"
expect_true "queuePlan has queuedAfterDependencies field" '.queuePlan | has("queuedAfterDependencies")' "$QUEUE"
expect_true "HOK-1531 is in availableNow" '.queuePlan.availableNow | contains(["HOK-1531"])' "$QUEUE"
expect_true "HOK-1532 dependsOn is HOK-1531" '(.tasks[] | select(.issue=="HOK-1532") | .dependsOn) == ["HOK-1531"]' "$QUEUE"
expect_true "HOK-1532 baseFromTask is HOK-1531" '(.tasks[] | select(.issue=="HOK-1532") | .baseFromTask) == "HOK-1531"' "$QUEUE"
expect_true "HOK-1531 has no dependency metadata" '(.tasks[] | select(.issue=="HOK-1531") | has("dependsOn") or has("baseFromTask")) | not' "$QUEUE"

# 3. Runner tolerance - legacy fixture
expect_true "legacy queuePlan read defaults to []" '(.queuePlan // []) == []' "$LEGACY"
expect_true "legacy task dependsOn read defaults to []" '[.tasks[] | (.dependsOn // []) == []] | all' "$LEGACY"
expect_true "legacy task baseFromTask read defaults to empty" '[.tasks[] | (.baseFromTask // empty) | (type == "string")] | all' "$LEGACY"

# 4. Runner tolerance - queue fixture (raw format)
expect_true "queue fixture queuePlan is an object" '(.queuePlan // {}) | type == "object"' "$QUEUE"
expect_true "queue fixture dependsOn read succeeds" '[(.tasks[] | select(.issue=="HOK-1532") | (.dependsOn // [])) == ["HOK-1531"]] | all' "$QUEUE"
expect_true "queue fixture baseFromTask read succeeds" '[(.tasks[] | select(.issue=="HOK-1532") | (.baseFromTask // empty)) == "HOK-1531"] | all' "$QUEUE"

# 5. Task ordering preserved in queue fixture (HOK-1531 before HOK-1532)
queue_order="$(jq -c '[.tasks[].issue]' "$QUEUE")"
if [[ "$queue_order" == '["HOK-1531","HOK-1532"]' ]]; then
  pass "task order preserved: independent task before dependent task"
else
  fail "task order preserved: expected HOK-1531 before HOK-1532, got: $queue_order"
fi

# 6. Mill jq logic - no queue plan (challenger approach: depends_on='[]', base_from_task='null')
no_queue_task_json="$(jq -cn \
  --arg issue "HOK-1532" \
  --argjson dependsOn '[]' \
  --arg baseFromTask "null" \
  '{issue:$issue}
  + (if ($baseFromTask != "null" or ($dependsOn | length > 0)) then {dependsOn: $dependsOn, baseFromTask: (if $baseFromTask == "null" then null else $baseFromTask end)} else {} end)')"

if jq -e '(has("dependsOn") | not) and (has("baseFromTask") | not)' <<<"$no_queue_task_json" >/dev/null; then
  pass "mill jq emits no per-task queue metadata when queue plan unavailable"
else
  fail "mill jq emits no per-task queue metadata when queue plan unavailable"
fi

# 7. Mill jq logic - with queue plan (challenger approach: jq filter via heredoc, base_from_task as string or "null")
queue_plan_json='{"availableNow":["HOK-1531"],"queuedAfterDependencies":[{"taskId":"HOK-1532","ancestors":["HOK-1531"]}]}'
computed_depends_on="$(jq -c --arg id "HOK-1532" '
  (.queuedAfterDependencies // [])
  | map(select(.taskId == $id))
  | if length > 0 then .[0].ancestors else [] end
' <<<"$queue_plan_json" 2>/dev/null || echo '[]')"
computed_base_from="$(jq -r --arg id "HOK-1532" '
  (.queuedAfterDependencies // [])
  | map(select(.taskId == $id))
  | if length > 0 then (.[0].ancestors[0] // "null") else "null" end
' <<<"$queue_plan_json" 2>/dev/null || echo 'null')"

with_queue_task_json="$(jq -cn \
  --arg issue "HOK-1532" \
  --argjson dependsOn "$computed_depends_on" \
  --arg baseFromTask "$computed_base_from" \
  '{issue:$issue}
  + (if ($baseFromTask != "null" or ($dependsOn | length > 0)) then {dependsOn: $dependsOn, baseFromTask: (if $baseFromTask == "null" then null else $baseFromTask end)} else {} end)')"

if jq -e '.dependsOn == ["HOK-1531"] and .baseFromTask == "HOK-1531"' <<<"$with_queue_task_json" >/dev/null; then
  pass "mill jq emits dependsOn and baseFromTask when queue plan exists"
else
  fail "mill jq emits dependsOn and baseFromTask when queue plan exists"
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
if (( FAIL > 0 )); then
  exit 1
fi
