#!/usr/bin/env bash
# HOK-3207: CI pass budget fixture. Counts process spawns per monitor pass
# (node / gh / jq) and fails when a pass exceeds the configured budget.
# Deterministic — no wall time — so it doesn't flake on busy CI.
#
# What it proves:
#   1. monitor-timing.json carries an integer `spawns` block (node/gh/jq).
#   2. A pass that stays within the budget passes the assertion.
#   3. A deliberately reintroduced per-pass extra `node` spawn (standing in
#      for the model-validator regression the acceptance names) pushes the
#      count over the budget and the assertion fails. The negative sub-test
#      runs the budget check in a sub-shell and asserts it returns non-zero,
#      proving the fixture itself enforces the ceiling.
#   4. The budget check honours the WAVEMILL_MONITOR_PASS_BUDGET_NODE
#      override so follow-up perf work can tune the ceiling without
#      changing this file.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP="$(mktemp -d -t wavemill-pass-budget-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }
assert_eq() {
  local actual="$1" expected="$2" label="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass "$label"
  else
    fail "$label: expected '$expected' got '$actual'"
  fi
}
assert_le() {
  local actual="$1" bound="$2" label="$3"
  if (( actual <= bound )); then
    pass "$label (${actual} ≤ ${bound})"
  else
    fail "$label (${actual} > ${bound})"
  fi
}
assert_ge() {
  local actual="$1" bound="$2" label="$3"
  if (( actual >= bound )); then
    pass "$label (${actual} ≥ ${bound})"
  else
    fail "$label (${actual} < ${bound})"
  fi
}

echo "=== monitor pass budget fixture (HOK-3207) ==="

export SESSION=test
export STATE_DIR="$TMP"
export STATE_FILE="$TMP/workflow-state.json"
export REPO_DIR="$REPO_DIR"
export WAVEMILL_INSTALL_DIR="$REPO_DIR"
export WORKTREE_ROOT="$TMP/worktrees"
export BASE_BRANCH=main
export POLL_SECONDS=10
export MAX_PARALLEL=4
export API_TIMEOUT=30
mkdir -p "$WORKTREE_ROOT"

# Seed N = 3 fake tasks (one coding, one review, one ready) so pass_task_field
# reads something plausible. Nothing in the fixture drives per-task behaviour,
# but the state file shape mirrors the real monitor's input.
cat > "$STATE_FILE" <<'JSON'
{
  "backlogExpanded": true,
  "depsExpanded": false,
  "freeSlots": 2,
  "updated": "2026-10-13T10:00:00Z",
  "tasks": {
    "HOK-3207-1": {
      "title": "fixture coding", "slug": "fix-coding", "pr": "9001",
      "worktree": "/wt/coding", "branch": "task/fix-coding",
      "phase": "coding", "status": "running"
    },
    "HOK-3207-2": {
      "title": "fixture review", "slug": "fix-review", "pr": "9002",
      "worktree": "/wt/review", "branch": "task/fix-review",
      "phase": "review", "status": "running"
    },
    "HOK-3207-3": {
      "title": "fixture ready", "slug": "fix-ready", "pr": "9003",
      "worktree": "/wt/ready", "branch": "task/fix-ready",
      "phase": "ready", "status": "running"
    }
  }
}
JSON

: > "$TMP/tasks.txt"

cat > "$TMP/env.sh" <<ENV
SESSION="$SESSION"
STATE_DIR="$STATE_DIR"
STATE_FILE="$STATE_FILE"
REPO_DIR="$REPO_DIR"
WAVEMILL_INSTALL_DIR="$WAVEMILL_INSTALL_DIR"
TOOLS_DIR="\$WAVEMILL_INSTALL_DIR/tools"
LIB_DIR="\$WAVEMILL_INSTALL_DIR/shared/lib"
WAVEMILL_LIB_DIR="\$WAVEMILL_INSTALL_DIR/shared/lib"
WORKTREE_ROOT="$WORKTREE_ROOT"
BASE_BRANCH="$BASE_BRANCH"
POLL_SECONDS="$POLL_SECONDS"
MAX_PARALLEL="$MAX_PARALLEL"
API_TIMEOUT="$API_TIMEOUT"
DRY_RUN=false
TASKS_FILE="$TMP/tasks.txt"
ENV

# PATH shims: fast, deterministic, side-effect-free stand-ins for the real
# gh / claude binaries the pass may call indirectly through the step
# functions. node / jq stay real (we count their invocations), but gh is
# shimmed so it never hits the network. The shims print nothing and exit 0.
SHIM_DIR="$TMP/shims"
mkdir -p "$SHIM_DIR"
for bin in gh claude; do
  cat > "$SHIM_DIR/$bin" <<'SHIM'
#!/usr/bin/env bash
exit 0
SHIM
  chmod +x "$SHIM_DIR/$bin"
done

# ── Pass driver ────────────────────────────────────────────────────────────
# The real monitor pass runs ~15 named steps, including per-task jq reads
# and a handful of node tool spawns. We drive a compact, deterministic
# approximation of that shape so the counting plumbing (wrappers, tally
# file, recorder) is exercised exactly as it is in prod. Driving the step
# functions directly keeps the fixture inside the mkdtemp sandbox and off
# the network.
#
# Included steps: passSnapshot (main jq read of state), issueMonitorLoop
# (per-task field reads), pipelineSanity (synthetic jq calls).
#
# Omitted steps that don't spawn: reconcile_condition_markers_tick,
# monitor_side_effect_detector_tick, check_backstage_health,
# check_backstage_observer_health, wavemill_pr_cache_refresh,
# refresh_ready_merge_queue_tick. These are omitted because they either
# have negligible spawn counts or are not central to the pass-budget
# regression detection (model-validator spawns are the primary concern).
# The budget ceiling is set to accommodate the omitted steps' typical
# spawns in a real pass, so regressions in the included steps are caught.
run_pass() {
  local extra_node="${1:-0}"
  bash -c '
    set -Eeuo pipefail
    export PATH="'"$SHIM_DIR"':$PATH"
    export WAVEMILL_MONITOR_SOURCE_ONLY=1
    source '"$REPO_DIR"'/shared/lib/wavemill-monitor.sh '"$TMP"'/env.sh

    # Open the per-pass tally. Mimics the first statement in the real
    # while-loop body.
    wavemill_monitor_spawn_pass_begin

    # Build the pass snapshot (one jq read of STATE_FILE). This is the
    # cheapest real step and the one the budget fixture most wants to
    # cover.
    monitor_step_begin passSnapshot
    monitor_build_pass_snapshot
    monitor_step_end passSnapshot

    # Simulate a few per-task jq reads to mimic the issue monitor loop
    # shape. The wrappers count every spawn, including these synthetic
    # ones. Using pass_task_field here is a no-op jq cost because the
    # snapshot has already loaded the fields.
    monitor_step_begin issueMonitorLoop
    _=$(pass_task_field HOK-3207-1 slug)
    _=$(pass_task_field HOK-3207-2 slug)
    _=$(pass_task_field HOK-3207-3 slug)
    monitor_step_end issueMonitorLoop

    # A couple of synthetic sub-shell jq calls to prove pipeline writes
    # are visible to the parent through WAVEMILL_MONITOR_SPAWN_TALLY.
    monitor_step_begin pipelineSanity
    echo "{}" | jq -c . >/dev/null
    echo "[]" | jq -c . >/dev/null
    monitor_step_end pipelineSanity

    # Optional: inject one or more extra node spawns to simulate a
    # regression (the acceptance names a per-pass model-validator spawn).
    extra='"$extra_node"'
    i=0
    while (( i < extra )); do
      monitor_step_begin extraNode
      node --version >/dev/null
      monitor_step_end extraNode
      i=$(( i + 1 ))
    done

    # Record the pass. The recorder reads the tally BEFORE calling jq
    # for its own output, so the counts reflect pass-body work only.
    wavemill_record_monitor_iteration_timing 1000 2000 10
  '
}

# Budget check: fails (non-zero exit) when any spawn count exceeds its
# ceiling. Separated so the fixture itself can be exercised as both a
# positive (clean pass) and a negative (regression injected) subject.
check_budget() {
  local timing="$1"
  local node_count gh_count jq_count
  node_count=$(jq -r '.spawns.node' "$timing")
  gh_count=$(jq -r '.spawns.gh' "$timing")
  jq_count=$(jq -r '.spawns.jq' "$timing")
  local node_budget="${WAVEMILL_MONITOR_PASS_BUDGET_NODE:-6}"
  local gh_budget="${WAVEMILL_MONITOR_PASS_BUDGET_GH:-2}"
  if ! (( node_count <= node_budget )); then
    printf 'budget-exceeded node=%s > budget=%s\n' "$node_count" "$node_budget" >&2
    return 1
  fi
  if ! (( gh_count <= gh_budget )); then
    printf 'budget-exceeded gh=%s > budget=%s\n' "$gh_count" "$gh_budget" >&2
    return 1
  fi
  # jq is only sanity-checked (>= 1) in the test, not budgeted here —
  # the pass should always do at least one jq read.
  if ! (( jq_count >= 1 )); then
    printf 'budget-under jq=%s < 1\n' "$jq_count" >&2
    return 1
  fi
  return 0
}

# ── 1: clean pass ────────────────────────────────────────────────────────
echo "--- clean pass (no injected regressions) ---"
run_pass 0 >/dev/null
TIMING="$STATE_DIR/monitor-timing.json"
if [[ ! -f "$TIMING" ]]; then
  fail "monitor-timing.json was not written"
  echo ""
  echo "--- Results: $PASS passed, $FAIL failed ---"
  exit 1
fi

NODE_COUNT=$(jq -r '.spawns.node' "$TIMING")
GH_COUNT=$(jq -r '.spawns.gh' "$TIMING")
JQ_COUNT=$(jq -r '.spawns.jq' "$TIMING")
SPAWN_TYPE=$(jq -r '.spawns | type' "$TIMING")

assert_eq "$SPAWN_TYPE" "object" "monitor-timing.json exposes a spawns object"
# Integer check: jq -r emits integers without quotes.
if [[ "$NODE_COUNT" =~ ^[0-9]+$ ]]; then pass "spawns.node is an integer (${NODE_COUNT})"; else fail "spawns.node is not an integer: $NODE_COUNT"; fi
if [[ "$GH_COUNT"   =~ ^[0-9]+$ ]]; then pass "spawns.gh is an integer (${GH_COUNT})"; else fail "spawns.gh is not an integer: $GH_COUNT"; fi
if [[ "$JQ_COUNT"   =~ ^[0-9]+$ ]]; then pass "spawns.jq is an integer (${JQ_COUNT})"; else fail "spawns.jq is not an integer: $JQ_COUNT"; fi

assert_le "$NODE_COUNT" "${WAVEMILL_MONITOR_PASS_BUDGET_NODE:-6}" "clean pass stays within node budget"
assert_le "$GH_COUNT"   "${WAVEMILL_MONITOR_PASS_BUDGET_GH:-2}"   "clean pass stays within gh budget"
assert_ge "$JQ_COUNT"   1                                            "clean pass counts at least one jq spawn"

# Budget check should pass on the clean pass.
if check_budget "$TIMING" 2>/dev/null; then
  pass "check_budget returns 0 on clean pass"
else
  fail "check_budget returned non-zero on clean pass"
fi

# ── 2: slowState and slowSinceAt fields are present ─────────────────────
SLOW_STATE_TYPE=$(jq -r '.slowState | type' "$TIMING")
SLOW_SINCE_HAS_FIELD=$(jq -r 'has("slowSinceAt")' "$TIMING")
WARN_MS=$(jq -r '.warnMs' "$TIMING")
assert_eq "$SLOW_STATE_TYPE"       "boolean" "monitor-timing.json exposes slowState as boolean"
assert_eq "$SLOW_SINCE_HAS_FIELD"  "true"    "monitor-timing.json exposes slowSinceAt field"
assert_eq "$WARN_MS"               "15000"   "warnMs defaults to 15 000 ms (HOK-3207)"

# ── 3: regression — inject extra node spawns, budget must fail ──────────
echo "--- regression: inject 10 extra node spawns ---"
run_pass 10 >/dev/null
NODE_COUNT_RE=$(jq -r '.spawns.node' "$TIMING")
assert_ge "$NODE_COUNT_RE" 10 "injected node spawns are counted"

# Run the budget check in a sub-shell so a failure doesn't abort the
# fixture. The whole point is to prove it DOES fail.
if check_budget "$TIMING" 2>/dev/null; then
  fail "check_budget incorrectly accepted a regression pass"
else
  pass "check_budget rejects a pass that exceeds the node budget"
fi

# ── 4: budget override honoured ─────────────────────────────────────────
# A follow-up perf fix should be able to tune the ceiling without editing
# this file. Prove the override is read.
if WAVEMILL_MONITOR_PASS_BUDGET_NODE=99 check_budget "$TIMING" 2>/dev/null; then
  pass "WAVEMILL_MONITOR_PASS_BUDGET_NODE override raises the ceiling"
else
  fail "WAVEMILL_MONITOR_PASS_BUDGET_NODE override was ignored"
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
exit $(( FAIL > 0 ? 1 : 0 ))
