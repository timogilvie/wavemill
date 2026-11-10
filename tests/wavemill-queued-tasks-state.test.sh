#!/usr/bin/env bash
# wavemill-test-suite: lifecycle (run by tests/run-lifecycle-tests.sh)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMMON_LIB="$REPO_DIR/shared/lib/wavemill-common.sh"
STATUS_LIB="$REPO_DIR/shared/lib/wavemill-status.sh"
STARTUP_LIB="$REPO_DIR/shared/lib/wavemill-startup-runner.sh"
QUEUE_FIXTURE="$REPO_DIR/tests/fixtures/startup/launch-plan-with-queue.json"
LEGACY_FIXTURE="$REPO_DIR/tests/fixtures/startup/launch-plan-legacy.json"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

assert_jq() {
  local name="$1" expr="$2" file="$3"
  if jq -e "$expr" "$file" >/dev/null 2>&1; then
    pass "$name"
  else
    fail "$name"
  fi
}

echo "=== Queued Task State ==="

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
STATE_FILE="$TMP_DIR/state.json"
SESSION="test-session"
export STATE_FILE SESSION
printf '{"session":"test","tasks":{}}\n' > "$STATE_FILE"

# shellcheck source=/dev/null
source "$COMMON_LIB"

seed_fn="$(sed -n '/^seed_queued_tasks_from_plan()/,/^}/p' "$STARTUP_LIB")"
eval "$seed_fn"

seed_queued_tasks_from_plan "$QUEUE_FIXTURE"
assert_jq "seed queued task count" '(.queued_tasks // []) | length == 1' "$STATE_FILE"
assert_jq "seeded issue id" '.queued_tasks[0].issue_id == "HOK-1532"' "$STATE_FILE"
assert_jq "seeded blocker issue" '.queued_tasks[0].blocker_issue_id == "HOK-1531"' "$STATE_FILE"
assert_jq "seeded blocker pr null" '.queued_tasks[0].blocker_pr_number == null' "$STATE_FILE"
assert_jq "seeded desired base" '.queued_tasks[0].desired_base_branch == "HOK-1531"' "$STATE_FILE"
assert_jq "seeded linear url fallback" '.queued_tasks[0].linear_issue_url == "https://linear.app/issue/HOK-1532"' "$STATE_FILE"
assert_jq "seeded slug" '.queued_tasks[0].slug == "task-b"' "$STATE_FILE"
assert_jq "seeded title" '.queued_tasks[0].title == "Task B"' "$STATE_FILE"

printf '{"session":"test","tasks":{}}\n' > "$STATE_FILE"
seed_queued_tasks_from_plan "$LEGACY_FIXTURE"
assert_jq "legacy plan leaves queue empty" '(.queued_tasks // []) == []' "$STATE_FILE"

printf '{"session":"test","tasks":{}}\n' > "$STATE_FILE"
seed_queued_tasks_from_plan "$QUEUE_FIXTURE"
seed_queued_tasks_from_plan "$QUEUE_FIXTURE"
assert_jq "re-seed remains idempotent" '(.queued_tasks // []) | length == 1' "$STATE_FILE"

printf '{"session":"test","tasks":{}}\n' > "$STATE_FILE"
queue_add_task "HOK-2" "HOK-1" "null" "HOK-1" "https://linear.app/issue/HOK-2"
queue_add_task "HOK-2" "HOK-9" "123" "HOK-9" "https://linear.app/issue/HOK-2"
assert_jq "queue_add_task upserts by issue" '(.queued_tasks // []) as $q | ($q | length) == 1 and $q[0].blocker_issue_id == "HOK-9" and $q[0].blocker_pr_number == 123' "$STATE_FILE"

queue_remove_task "HOK-2"
assert_jq "queue_remove_task removes present entry" '(.queued_tasks // []) == []' "$STATE_FILE"
queue_remove_task "HOK-404"
assert_jq "queue_remove_task is no-op for absent entry" '(.queued_tasks // []) == []' "$STATE_FILE"

printf '{"session":"test","tasks":{},"queued_tasks":[{"issue_id":"HOK-2","blocker_issue_id":"HOK-1","blocker_pr_number":null,"desired_base_branch":"HOK-1"},{"issue_id":"HOK-3","blocker_issue_id":"HOK-2","blocker_pr_number":55,"desired_base_branch":"HOK-2"}]}' > "$STATE_FILE"
FRAME="$TMP_DIR/frame.txt"
EL=''
B=''
N=''
D=''
# shellcheck disable=SC1090
set -- test-session /tmp "$STATE_FILE"
source <(sed '/^if \[\[ "\${BASH_SOURCE\[0\]:-}" == "\$0" \]\]; then/,/^fi$/d' "$STATUS_LIB")
: > "$FRAME"
render_queued_section
if grep -q "PENDING DEPENDENCY" "$FRAME" && grep -q "HOK-2" "$FRAME" && grep -q "HOK-3" "$FRAME"; then
  pass "status renders pending dependency section"
else
  fail "status renders pending dependency section"
fi
if grep -q "(no PR)" "$FRAME"; then
  pass "null blocker PR renders as (no PR)"
else
  fail "null blocker PR renders as (no PR)"
fi

printf '{"session":"test","tasks":{},"queued_tasks":[]}' > "$STATE_FILE"
: > "$FRAME"
render_queued_section
if grep -q "PENDING DEPENDENCY" "$FRAME"; then
  fail "empty queue does not render header"
else
  pass "empty queue does not render header"
fi

if grep -En "queue_(add_task|remove_task)\(\)" "$COMMON_LIB" >/dev/null \
  && [[ "$(grep -En "state_mutate " "$COMMON_LIB" | wc -l | tr -d ' ')" -ge 2 ]]; then
  pass "queue mutation helpers use state_mutate"
else
  fail "queue mutation helpers use state_mutate"
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
if (( FAIL > 0 )); then
  exit 1
fi
