#!/usr/bin/env bash
# HOK-3373: one settled attempt — the shell half.
#
#   - state_mutate's settlement gate (shell seam of task-settlement.ts)
#   - save_task_state launch mode: new run, never merges into a settled row,
#     refuses to relaunch delivered work
#   - attempt_identity_mint_run_id byte parity with TS mintRunId
#   - delivered_issue_ids (the replacement for the monitor's CLEANED set)
#   - task_worktree_path_status / task_dir_ensure (the task-worktree resolver)
#   - set_task_lifecycle_disposition never recreates a reaped row
#   - Linear convergence (linear_state_pending_syncs / converge tick)
#   - cleanup_on_exit writes neither Linear nor state
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_REPO_DIR="$REPO_DIR"

source "$MILL_REPO_DIR/shared/lib/wavemill-common.sh"
source "$REPO_DIR/tests/lib/state-fixtures.sh"

TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1" >&2; }
assert_eq() {
  local expected="$1" actual="$2" message="$3"
  if [[ "$expected" == "$actual" ]]; then pass "$message"; else fail "$message (expected '$expected', got '$actual')"; fi
}

log_warn() { :; }
log() { :; }

RUN_A="HOK-1:e1:1700000000"
MERGED_LIFECYCLE='{"schemaVersion":1,"workflowOutcome":"merged","resourceDisposition":"reaping"}'
ACTIVE_LIFECYCLE='{"schemaVersion":1,"workflowOutcome":"active","resourceDisposition":"allocated"}'

new_state() {
  local repo="$TEST_DIR/$1"
  mkdir -p "$repo/.wavemill"
  printf '%s\n' "$repo/.wavemill/workflow-state.json"
}

rejection_lines() {
  local log="$(dirname "$1")/mutator-rejections.jsonl"
  if [[ -f "$log" ]]; then wc -l <"$log" | tr -d ' '; else echo 0; fi
}

echo "test_run_id_parity_with_ts"
# protects: the shell and TS minting different ids for the same launch (stale-run checks never match).
ts_id="$(node --experimental-strip-types --no-warnings -e '
  import("'"$REPO_DIR"'/shared/lib/attempt-identity.ts").then((m) => {
    process.stdout.write(m.mintRunId({ issue: "HOK-7_c", runEpoch: "epoch-9", launchedAt: new Date(1700000123000) }));
  });')"
assert_eq "$ts_id" "$(attempt_identity_mint_run_id HOK-7_c epoch-9 1700000123)" "shell and TS mint the same run id"

echo "test_state_mutate_reverts_control_write_on_settled_run"
# protects: a shell writer reopening delivered work (HOK-2595 relaunch re-adoption).
state="$(new_state gate)"
fixture_workflow_state "$state" HOK-1 slug=one status=merged phase=done pr=12 runId="$RUN_A" lifecycle:="$MERGED_LIFECYCLE"
state_mutate "$state" '.tasks["HOK-1"].phase = "planning" | .tasks["HOK-1"].evalCompleted = true' 2>/dev/null
assert_eq "done" "$(jq -r '.tasks["HOK-1"].phase' "$state")" "the control write is reverted"
assert_eq "true" "$(jq -r '.tasks["HOK-1"].evalCompleted' "$state")" "the evidence write in the same filter lands"
assert_eq "1" "$(rejection_lines "$state")" "the rejection is logged once"
assert_eq "HOK-1|phase|settled-attempt|shell" \
  "$(jq -r '[.issue, .field, .reason, .writer] | join("|")' "$(dirname "$state")/mutator-rejections.jsonl")" "the line names task, field, reason and seam"

echo "test_state_mutate_stale_run_id"
# protects: an old run's completion arriving after a relaunch steering the new run.
state="$(new_state stale)"
fixture_workflow_state "$state" HOK-1 slug=one status=active phase=coding runId="HOK-1:e2:1700000600" lifecycle:="$ACTIVE_LIFECYCLE"
WAVEMILL_EXPECTED_RUN_ID="HOK-1=$RUN_A" state_mutate "$state" '.tasks["HOK-1"].phase = "ready" | .tasks["HOK-1"].coderModel = "gpt-x"' 2>/dev/null
assert_eq "coding|gpt-x" "$(jq -r '[.tasks["HOK-1"].phase, .tasks["HOK-1"].coderModel] | join("|")' "$state")" "stale control reverted, evidence kept"
assert_eq "stale-run-id" "$(jq -r '.reason' "$(dirname "$state")/mutator-rejections.jsonl")" "logged as stale-run-id"
WAVEMILL_EXPECTED_RUN_ID="HOK-1=HOK-1:e2:1700000600" state_mutate "$state" '.tasks["HOK-1"].phase = "ready"' 2>/dev/null
assert_eq "ready" "$(jq -r '.tasks["HOK-1"].phase' "$state")" "the current run's control write lands"

echo "test_set_task_lifecycle_disposition_never_recreates_reaped_row"
# protects: a late cleanup step recreating a reaped task as a lifecycle-only stub (HOK-3125 class).
state="$(new_state lifecycle)"
fixture_workflow_state "$state" HOK-1 slug=one status=merged lifecycle:="$MERGED_LIFECYCLE"
STATE_FILE="$state" set_task_lifecycle_disposition HOK-2 "" reaped "" test 2>/dev/null || true
assert_eq "null" "$(jq -c '.tasks["HOK-2"]' "$state")" "no row is created for a missing task"
STATE_FILE="$state" set_task_lifecycle_disposition HOK-1 "" reaped "" test 2>/dev/null
assert_eq "merged|reaped" "$(jq -r '.tasks["HOK-1"].lifecycle | [.workflowOutcome, .resourceDisposition] | join("|")' "$state")" "cleanup lands on a settled row"
STATE_FILE="$state" set_task_lifecycle_disposition HOK-1 active allocated "" test 2>/dev/null
assert_eq "merged" "$(jq -r '.tasks["HOK-1"].lifecycle.workflowOutcome' "$state")" "the outcome settles once"

echo "test_save_task_state_launch_is_a_new_run"
# protects: a relaunch inheriting the aborted row's challengeAborted and PR (HOK-3369).
repo="$TEST_DIR/launch"
mkdir -p "$repo/.wavemill"
STATE_FILE="$repo/.wavemill/workflow-state.json"
REPO_DIR="$repo"
fixture_workflow_state "$STATE_FILE" HOK-5 slug=five branch=task/five worktree="$repo/wt/five" pr=40 status=aborted phase=aborted \
  challengeAborted=operator_abort runId="HOK-5:old:1" lifecycle:='{"schemaVersion":1,"workflowOutcome":"aborted","resourceDisposition":"reaping"}'
WAVEMILL_RUN_EPOCH="new-epoch" SAVE_TASK_STATE_LAUNCH=1 save_task_state HOK-5 five task/five "$repo/wt/five" "" "" claude HOK-5 2>/dev/null
row="$(jq -c '.tasks["HOK-5"]' "$STATE_FILE")"
assert_eq "active|||active" "$(jq -r '[.status, .pr, (.challengeAborted // ""), .lifecycle.workflowOutcome] | join("|")' <<<"$row")" "the relaunch is a fresh active row"
case "$(jq -r '.runId' <<<"$row")" in
  HOK-5:new-epoch:*) pass "the relaunch mints a new run id" ;;
  *) fail "the relaunch mints a new run id (got $(jq -r '.runId' <<<"$row"))" ;;
esac
run_id="$(jq -r '.runId' <<<"$row")"
save_task_state HOK-5 five task/five "$repo/wt/five" "" "" claude HOK-5 2>/dev/null
assert_eq "$run_id" "$(jq -r '.tasks["HOK-5"].runId' "$STATE_FILE")" "a later save keeps the run id"

echo "test_save_task_state_refuses_to_relaunch_delivered_work"
# protects: merged work relaunched and its merged PR re-adopted (HOK-2595).
fixture_workflow_state "$STATE_FILE" HOK-6 slug=six branch=task/six pr=41 status=merged phase=done runId="HOK-6:e:1" lifecycle:="$MERGED_LIFECYCLE"
if SAVE_TASK_STATE_LAUNCH=1 save_task_state HOK-6 six task/six "$repo/wt/six" "" "" claude HOK-6 2>/dev/null; then
  fail "a delivered issue is refused"
else
  pass "a delivered issue is refused"
fi
assert_eq "merged|41" "$(jq -r '.tasks["HOK-6"] | [.status, .pr] | join("|")' "$STATE_FILE")" "the delivered row is untouched"

echo "test_delivered_issue_ids_reads_state_not_memory"
# protects: picker visibility depending on an in-memory set that a restart forgets.
state="$(new_state delivered)"
fixture_workflow_state "$state" HOK-10 status=merged lifecycle:="$MERGED_LIFECYCLE" \
  -- HOK-11 status=active lifecycle:="$ACTIVE_LIFECYCLE" \
  -- HOK-12_c challengePairId=HOK-12 challengeRole=challenger status=merged lifecycle:="$MERGED_LIFECYCLE" \
  -- HOK-12 challengePairId=HOK-12 challengeRole=primary status=closed lifecycle:='{"schemaVersion":1,"workflowOutcome":"closed","resourceDisposition":"reaping"}'
# allow-task-literal: terminalTaskHistory tombstones, not .tasks rows
jq '.terminalTaskHistory = {tasks: {"HOK-13": {issue: "HOK-13", workflowOutcome: "merged"}, "HOK-14": {issue: "HOK-14", workflowOutcome: "aborted"}, "HOK-11": {issue: "HOK-11", workflowOutcome: "merged"}}}' "$state" >"$state.tmp" && mv "$state.tmp" "$state"
assert_eq "HOK-10 HOK-12 HOK-12_c HOK-13" "$(delivered_issue_ids "$state" | tr '\n' ' ' | sed 's/ $//')" \
  "merged rows, merged pairs and reaped merged runs are delivered; aborted and re-run issues are not"

echo "test_task_worktree_path_status"
# protects: a recreated plain directory (or the main checkout) passing as the task's worktree.
wt_repo="$TEST_DIR/wtrepo"
git init -q "$wt_repo"
git -C "$wt_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
git -C "$wt_repo" worktree add -q "$TEST_DIR/wt-live" -b task/live
mkdir -p "$TEST_DIR/wt-plain/features/x"
assert_eq "registered" "$(task_worktree_path_status "$TEST_DIR/wt-live" "$wt_repo")" "a registered worktree resolves"
assert_eq "missing" "$(task_worktree_path_status "$TEST_DIR/wt-gone" "$wt_repo" || true)" "a deleted worktree is missing"
assert_eq "invalid" "$(task_worktree_path_status "$TEST_DIR/wt-plain" "$wt_repo" || true)" "a plain directory is invalid, never handed to git"
assert_eq "protected" "$(task_worktree_path_status "$wt_repo" "$wt_repo" || true)" "the main checkout is protected"
assert_eq "none" "$(task_worktree_path_status "" "$wt_repo" || true)" "no path is none"

echo "test_task_dir_ensure_never_recreates_a_dead_worktree"
# protects: a marker write recreating a reaped worktree path (the HOK-2595 orphan).
WORKTREE_ROOT="$TEST_DIR/wtroot"
mkdir -p "$WORKTREE_ROOT/live"
: > "$WORKTREE_ROOT/live/.git"
if task_dir_ensure "$WORKTREE_ROOT/gone/features/gone"; then fail "a dead worktree path is refused"; else pass "a dead worktree path is refused"; fi
[[ ! -e "$WORKTREE_ROOT/gone" ]] && pass "nothing is created under it" || fail "nothing is created under it"
task_dir_ensure "$WORKTREE_ROOT/live/features/live" && [[ -d "$WORKTREE_ROOT/live/features/live" ]] \
  && pass "a live worktree's state dir is created" || fail "a live worktree's state dir is created"
task_dir_ensure "$TEST_DIR/elsewhere/dir" && pass "non-task paths are unaffected" || fail "non-task paths are unaffected"
marker_write "$WORKTREE_ROOT/gone2/features/gone2/.m.json" --kind test --head abc 2>/dev/null || true
[[ ! -e "$WORKTREE_ROOT/gone2" ]] && pass "marker_write never recreates a dead worktree" || fail "marker_write never recreates a dead worktree"
unset WORKTREE_ROOT

echo "test_linear_convergence"
# protects: a crash between settlement and the Linear write leaving delivered work in Backlog.
state="$(new_state linear)"
fixture_workflow_state "$state" HOK-20 status=merged lifecycle:="$MERGED_LIFECYCLE" \
  -- HOK-21 status=merged linearSyncedState=Done lifecycle:="$MERGED_LIFECYCLE" \
  -- HOK-22_c challengeRole=challenger status=merged lifecycle:="$MERGED_LIFECYCLE" \
  -- HOK-23 status=aborted lifecycle:='{"schemaVersion":1,"workflowOutcome":"aborted","resourceDisposition":"reaping"}'
# allow-task-literal: terminalTaskHistory tombstones, not .tasks rows
jq '.terminalTaskHistory = {tasks: {"HOK-24": {issue: "HOK-24", workflowOutcome: "merged", runId: "HOK-24:e:1"}, "HOK-25": {issue: "HOK-25", workflowOutcome: "merged"}}}' "$state" >"$state.tmp" && mv "$state.tmp" "$state"
assert_eq "HOK-20	Done HOK-24	Done" "$(linear_state_pending_syncs "$state" | tr '\n' ' ' | sed 's/ $//')" \
  "only unsynced primary merged runs (live, or reaped post-HOK-3373) are pending"
LINEAR_WRITES="$TEST_DIR/linear-writes.log"
linear_set_state_checked() { printf '%s|%s\n' "$1" "$2" >>"$LINEAR_WRITES"; [[ "$1" != "HOK-24" ]]; }
STATE_FILE="$state" linear_state_converge_tick
assert_eq "HOK-20|Done HOK-24|Done" "$(tr '\n' ' ' <"$LINEAR_WRITES" | sed 's/ $//')" "the tick writes each pending run"
assert_eq "HOK-24	Done" "$(linear_state_pending_syncs "$state")" "a landed write is recorded; a failed one stays pending"
unset -f linear_set_state_checked
source "$MILL_REPO_DIR/shared/lib/wavemill-common.sh"

echo "test_cleanup_on_exit_writes_neither_linear_nor_state"
# protects: the mill's exit trap resetting delivered work to Backlog and deleting its row (HOK-2595).
# allow-source-text-assertion: extracts cleanup_on_exit to *run* it; wavemill-mill.sh has top-level side effects
trap_fn="$(awk '/^cleanup_on_exit\(\) \{/,/^\}/' "$MILL_REPO_DIR/shared/lib/wavemill-mill.sh")"
state="$(new_state trap)"
fixture_workflow_state "$state" HOK-30 status=merged lifecycle:="$MERGED_LIFECYCLE" -- HOK-31 status=active lifecycle:="$ACTIVE_LIFECYCLE"
SESSION="settled-attempt-test-$$"
printf 'HOK-30\nHOK-31\n' >"/tmp/${SESSION}-launched-issues.txt"
out="$(
  STATE_FILE="$state"
  linear_set_state() { echo "LINEAR $*"; }
  remove_task_state() { echo "REMOVE $*"; }
  cleanup_background_jobs_shutdown() { :; }
  log_warn() { echo "WARN $*"; }
  eval "$trap_fn"
  cleanup_on_exit 2>&1
)" || true
rm -f "/tmp/${SESSION}-launched-issues.txt"
[[ "$out" != *"LINEAR"* && "$out" != *"REMOVE"* ]] && pass "no Linear write and no row deletion" || fail "no Linear write and no row deletion: $out"
assert_eq "2" "$(jq '.tasks | length' "$state")" "both rows survive the interrupt"

echo
echo "settled-attempt: $PASS passed, $FAIL failed"
(( FAIL == 0 ))
