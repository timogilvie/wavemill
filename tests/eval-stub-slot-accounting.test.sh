#!/usr/bin/env bash
# HOK-3125 regression tests. Post-reap eval writers must not recreate the
# reaped .tasks[$issue] entry as a phase/status/slug/lifecycle-less stub that
# consumes a mill slot. Covers:
#   1. mark_eval_completed after reap → no entry, slot count unchanged,
#      postReapEval recorded in terminalTaskHistory.
#   2. mark_eval_failed after reap → same shape.
#   3. Existing orphan stubs classify as `orphan`, drop out of the slot
#      counter, and appear in orphan_stub_task_ids.
#   4. Live challenge arm still receives evalCompleted / evalFailed writes,
#      preserving phase/slug/challengePairId.
#   5. mark_challenge_eval_running for a missing issue returns non-zero and
#      creates no entry.
#   6. drop_tombstoned_eval_stubs removes tombstoned stubs, keeps
#      un-tombstoned stubs and live rows, and is idempotent.
#   7. drop_tombstoned_eval_stubs leaves stubs with non-allowlist keys alone.
#   8. Static: wavemill-mill.sh's closed-PR eval writer does not raw-write
#      .tasks[$issue].evalCompleted.
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

check_ne() {
  local name="$1" actual="$2" unexpected="$3"
  if [[ "$actual" != "$unexpected" ]]; then
    pass "$name"
  else
    echo "    unexpected: $unexpected"
    fail "$name"
  fi
}

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

# Brace-aware extractor (strings stripped) — matches challenge-eval-soft-retry.
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

# Extract monitor writers under test.
for fn in mark_eval_completed mark_eval_failed mark_challenge_eval_running; do
  out="$TEST_TMP/$fn.sh"
  extract_function "$MONITOR_SCRIPT_FILE" "$fn" > "$out"
  if [[ ! -s "$out" ]]; then
    echo "Could not extract $fn from monitor"
    exit 1
  fi
  # shellcheck source=/dev/null
  source "$out"
done

# Stubs for functions referenced by the writers but not needed by the tests.
log() { :; }
log_warn() { :; }
bounded_retry_clear() { :; }
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
WORKTREE_ROOT="$TEST_TMP/worktrees"
mkdir -p "$WORKTREE_ROOT"

STATE_FILE="$TEST_TMP/state.json"

seed_state() {
  cat > "$STATE_FILE" <<'JSON'
{
  "tasks": {
    "HOK-LIVE-A": {
      "slug": "hok-live-a",
      "branch": "task/hok-live-a",
      "phase": "executing",
      "status": "active",
      "pr": "101"
    },
    "HOK-LIVE-B": {
      "slug": "hok-live-b",
      "branch": "task/hok-live-b",
      "phase": "executing",
      "status": "active",
      "pr": "102"
    }
  },
  "terminalTaskHistory": {"tasks": {}},
  "terminalTaskTombstones": {}
}
JSON
}

# --- Test 1: reap then eval completed ---------------------------------------
seed_state
# Add tombstone + terminal history for a reaped issue.
jq '
  .terminalTaskHistory.tasks["HOK-9001"] = {issue:"HOK-9001", slug:"hok-9001"}
  | .terminalTaskTombstones["HOK-9001|101|no-epoch|no-attempt"] = {issue:"HOK-9001"}
' "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"

before_count="$(slot_consuming_task_count)"
mark_eval_completed "HOK-9001"
after_count="$(slot_consuming_task_count)"
entry_present="$(jq -r '.tasks["HOK-9001"] // "null"' "$STATE_FILE")"
outcome="$(jq -r '.terminalTaskHistory.tasks["HOK-9001"].postReapEval.outcome // ""' "$STATE_FILE")"

check_eq "reap+eval: entry not recreated" "$entry_present" "null"
check_eq "reap+eval: slot count unchanged" "$after_count" "$before_count"
check_eq "reap+eval: postReapEval recorded" "$outcome" "completed"

# --- Test 2: reap then eval failed ------------------------------------------
seed_state
jq '
  .terminalTaskHistory.tasks["HOK-9002"] = {issue:"HOK-9002", slug:"hok-9002"}
  | .terminalTaskTombstones["HOK-9002|202|no-epoch|no-attempt"] = {issue:"HOK-9002"}
' "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"

mark_eval_failed "HOK-9002"
entry_present="$(jq -r '.tasks["HOK-9002"] // "null"' "$STATE_FILE")"
outcome="$(jq -r '.terminalTaskHistory.tasks["HOK-9002"].postReapEval.outcome // ""' "$STATE_FILE")"

check_eq "reap+fail: entry not recreated" "$entry_present" "null"
check_eq "reap+fail: postReapEval recorded" "$outcome" "failed"

# --- Test 3: pre-existing orphan stubs never count ---------------------------
seed_state
jq '
  .tasks["STUB-1"] = {evalCompleted: true, evalFailed: false, updated: "2026-09-30T00:00:00Z"}
  | .tasks["STUB-2"] = {evalCompleted: true, updated: "2026-09-30T00:00:00Z"}
  | .tasks["STUB-3"] = {evalFailed: true, evalHardFailureRetryCount: 1, updated: "2026-09-30T00:00:00Z"}
  | .tasks["STUB-4"] = {evalCompleted: false}
  | .tasks["STUB-5"] = {evalRunning: {issue: "STUB-5"}}
' "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"

check_eq "stubs do not consume a slot" "$(slot_consuming_task_count)" "2"
check_eq "stub is orphan by disposition" "$(get_task_resource_disposition STUB-1)" "orphan"
check_eq "live is allocated by disposition" "$(get_task_resource_disposition HOK-LIVE-A)" "allocated"

orphan_list_lines="$(orphan_stub_task_ids | sort | tr '\n' ' ')"
check_eq "orphan_stub_task_ids lists all five stubs" \
  "$orphan_list_lines" "STUB-1 STUB-2 STUB-3 STUB-4 STUB-5 "

# --- Test 4: live challenge arm still records eval --------------------------
seed_state
jq '
  .tasks["HOK-LIVE-A"].challengePairId = "HOK-LIVE-A"
  | .tasks["HOK-LIVE-A"].challengeRole = "primary"
  | .tasks["HOK-LIVE-A"].evalRunning = {issue: "HOK-LIVE-A"}
' "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"

mark_eval_completed "HOK-LIVE-A"
completed="$(jq -r '.tasks["HOK-LIVE-A"].evalCompleted' "$STATE_FILE")"
failed="$(jq -r '.tasks["HOK-LIVE-A"].evalFailed' "$STATE_FILE")"
running="$(jq -r '.tasks["HOK-LIVE-A"].evalRunning // "null"' "$STATE_FILE")"
phase="$(jq -r '.tasks["HOK-LIVE-A"].phase' "$STATE_FILE")"
slug="$(jq -r '.tasks["HOK-LIVE-A"].slug' "$STATE_FILE")"
pair="$(jq -r '.tasks["HOK-LIVE-A"].challengePairId' "$STATE_FILE")"

check_eq "live arm: evalCompleted true" "$completed" "true"
check_eq "live arm: evalFailed false"   "$failed"    "false"
check_eq "live arm: evalRunning cleared" "$running"  "null"
check_eq "live arm: phase preserved"     "$phase"    "executing"
check_eq "live arm: slug preserved"      "$slug"     "hok-live-a"
check_eq "live arm: challengePairId preserved" "$pair" "HOK-LIVE-A"

# --- Test 5: mark_challenge_eval_running on missing issue -------------------
seed_state
if mark_challenge_eval_running "HOK-9999" primary 505 eval; then
  fail "running marker: returns non-zero on missing issue"
else
  pass "running marker: returns non-zero on missing issue"
fi
entry_present="$(jq -r '.tasks["HOK-9999"] // "null"' "$STATE_FILE")"
check_eq "running marker: no entry created" "$entry_present" "null"

# --- Test 6: drop_tombstoned_eval_stubs self-heal ---------------------------
seed_state
jq '
  .tasks["STUB-T1"] = {evalCompleted: true, updated: "2026-09-30T00:00:00Z"}
  | .tasks["STUB-T2"] = {evalCompleted: true, evalFailed: false, updated: "2026-09-30T00:00:00Z"}
  | .tasks["STUB-T3"] = {evalFailed: true, updated: "2026-09-30T00:00:00Z"}
  | .tasks["STUB-U"]  = {evalCompleted: true, updated: "2026-09-30T00:00:00Z"}
  | .terminalTaskHistory.tasks["STUB-T1"] = {issue:"STUB-T1"}
  | .terminalTaskHistory.tasks["STUB-T2"] = {issue:"STUB-T2"}
  | .terminalTaskTombstones["STUB-T3|1|no-epoch|no-attempt"] = {issue:"STUB-T3"}
' "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"

dropped="$(drop_tombstoned_eval_stubs | sort | tr '\n' ' ')"
remaining="$(jq -r '.tasks | keys | join(" ")' "$STATE_FILE")"

check_eq "self-heal: drops three tombstoned stubs" "$dropped" "STUB-T1 STUB-T2 STUB-T3 "
check_eq "self-heal: keeps live rows and un-tombstoned stub" \
  "$remaining" "HOK-LIVE-A HOK-LIVE-B STUB-U"

# Idempotent second call: nothing more to drop.
dropped_again="$(drop_tombstoned_eval_stubs)"
check_eq "self-heal: second call is a no-op" "$dropped_again" ""

# --- Test 7: allowlist guard — entry with a non-eval key is preserved -------
seed_state
jq '
  .tasks["STUB-EXTRA"] = {evalCompleted: true, pr: "42"}
  | .terminalTaskHistory.tasks["STUB-EXTRA"] = {issue:"STUB-EXTRA"}
' "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"

dropped="$(drop_tombstoned_eval_stubs)"
kept="$(jq -r '.tasks["STUB-EXTRA"].evalCompleted' "$STATE_FILE")"
check_eq "allowlist guard: non-eval key blocks drop" "$dropped" ""
check_eq "allowlist guard: entry preserved"          "$kept"    "true"

# --- Test 8: static — the mill closed-PR writer uses the guarded helper ----
if grep -q "task_state_mutate_existing" "$REPO_DIR/shared/lib/wavemill-mill.sh"; then
  pass "mill uses task_state_mutate_existing"
else
  fail "mill uses task_state_mutate_existing"
fi

if grep -qE "^[^#]*state_mutate .*\.tasks\[\\\$issue\]\.evalCompleted = true" "$REPO_DIR/shared/lib/wavemill-mill.sh"; then
  fail "mill closed-PR writer no longer raw-writes evalCompleted"
else
  pass "mill closed-PR writer no longer raw-writes evalCompleted"
fi

if grep -qE "^[^#]*state_mutate .*\.tasks\[\\\$issue\]\.evalCompleted = true" "$REPO_DIR/shared/lib/wavemill-monitor.sh"; then
  fail "monitor writers no longer raw-write evalCompleted"
else
  pass "monitor writers no longer raw-write evalCompleted"
fi

echo ""
echo "eval-stub-slot-accounting: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
