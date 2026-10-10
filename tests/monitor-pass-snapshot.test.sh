#!/usr/bin/env bash
# HOK-3190: monitor_build_pass_snapshot pulls per-task fields and state-root
# globals in ONE jq call per pass. This guard sources the monitor as a
# library and asserts:
#   1. pass_task_field / pass_state_root return the correct values
#   2. explicit `false` and `0` survive the TSV round-trip (regression test
#      for the `.field // null` jq-fallback bug — false must not collapse to
#      null)
#   3. invalidate_task_field evicts a specific key
#   4. the monitor_build_pass_snapshot call site runs exactly one `jq -r`
#      against STATE_FILE (traced via a shim)
#   5. pass_task_field falls through to read_state_value when the snapshot is
#      not active (standalone CLI contexts stay correct)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP="$(mktemp -d -t wavemill-pass-snap-XXXXXX)"
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

echo "=== monitor_build_pass_snapshot (HOK-3190) ==="

export WAVEMILL_READY_WATCHDOG_SOURCE_ONLY=1
export WAVEMILL_INSTALL_DIR="$REPO_DIR"
export SESSION=test
export STATE_DIR="$TMP"
export STATE_FILE="$TMP/workflow-state.json"
export REPO_DIR
export WORKTREE_ROOT="$TMP/worktrees"
export BASE_BRANCH=main
export POLL_SECONDS=10
export MAX_PARALLEL=4
export API_TIMEOUT=30
mkdir -p "$WORKTREE_ROOT"

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
ENV

cat > "$STATE_FILE" <<'JSON'
{
  "backlogExpanded": true,
  "depsExpanded": false,
  "freeSlots": 2,
  "updated": "2026-10-09T10:00:00Z",
  "tasks": {
    "HOK-1": {
      "title": "primary",
      "slug": "primary-slug",
      "pr": "500",
      "worktree": "/wt/one",
      "branch": "feat/one",
      "phase": "coding",
      "status": "running",
      "evalCompleted": false,
      "challengeAborted": false,
      "challengerLaunched": true,
      "challengePairId": "HOK-1",
      "challengeRole": "primary"
    },
    "HOK-2_c": {
      "title": "challenger",
      "slug": "chal-slug",
      "branch": "feat/one-c",
      "pr": "501",
      "phase": "review",
      "status": "running",
      "challengePairId": "HOK-1",
      "challengeRole": "challenger",
      "comparisonState": "pending"
    }
  }
}
JSON

# ── 1 & 2: basic reads + false preservation ────────────────────────────────
RESULT=$(bash -c '
  set -Eeuo pipefail
  source '"$REPO_DIR"'/shared/lib/wavemill-monitor.sh '"$TMP"'/env.sh
  monitor_build_pass_snapshot
  printf "%s|%s|%s|%s|%s|%s|%s|%s|%s\n" \
    "$MONITOR_PASS_SNAPSHOT_ACTIVE" \
    "$(pass_task_field HOK-1 slug default)" \
    "$(pass_task_field HOK-1 evalCompleted MISSING)" \
    "$(pass_task_field HOK-1 challengerLaunched MISSING)" \
    "$(pass_task_field HOK-2_c comparisonState)" \
    "$(pass_state_root backlogExpanded DEFAULT)" \
    "$(pass_state_root depsExpanded DEFAULT)" \
    "$(pass_state_root freeSlots DEFAULT)" \
    "$(pass_task_field HOK-1 nosuchfield DFLT)"
')
IFS='|' read -r active slug evalc chlau cmp bexp dexp fs noexist <<<"$RESULT"
assert_eq "$active" "1" "snapshot active after build"
assert_eq "$slug" "primary-slug" "slug read"
assert_eq "$evalc" "false" "evalCompleted preserves literal false"
assert_eq "$chlau" "true" "challengerLaunched preserves literal true"
assert_eq "$cmp" "pending" "comparisonState read"
assert_eq "$bexp" "true" "root backlogExpanded"
assert_eq "$dexp" "false" "root depsExpanded preserves literal false"
assert_eq "$fs" "2" "root freeSlots"
assert_eq "$noexist" "DFLT" "missing field returns default"

# ── 3: invalidate_task_field ───────────────────────────────────────────────
INV=$(bash -c '
  set -Eeuo pipefail
  source '"$REPO_DIR"'/shared/lib/wavemill-monitor.sh '"$TMP"'/env.sh
  monitor_build_pass_snapshot
  # Prevent the pass_task_field fallback from re-reading the file.
  rm -f "$STATE_FILE"
  invalidate_task_field HOK-1 slug
  printf "%s" "$(pass_task_field HOK-1 slug CLEARED)"
')
assert_eq "$INV" "CLEARED" "invalidate_task_field evicts entry"

# Restore the state file for the remaining tests.
cat > "$STATE_FILE" <<'JSON'
{
  "backlogExpanded": true,
  "depsExpanded": false,
  "freeSlots": 2,
  "updated": "2026-10-09T10:00:00Z",
  "tasks": {
    "HOK-1": {
      "title": "primary",
      "slug": "primary-slug",
      "pr": "500",
      "worktree": "/wt/one",
      "branch": "feat/one",
      "phase": "coding",
      "status": "running",
      "evalCompleted": false,
      "challengerLaunched": true,
      "challengePairId": "HOK-1",
      "challengeRole": "primary"
    }
  }
}
JSON

# ── 4: single jq call per snapshot build ───────────────────────────────────
JQ_SHIM_DIR="$TMP/jq-shim"
mkdir -p "$JQ_SHIM_DIR"
JQ_REAL="$(command -v jq)"
cat > "$JQ_SHIM_DIR/jq" <<SHIM
#!/usr/bin/env bash
# Count every call to jq that reads STATE_FILE.
if [[ " \$* " == *" $STATE_FILE "* ]]; then
  echo count >> "$TMP/jq-state-reads.log"
fi
exec "$JQ_REAL" "\$@"
SHIM
chmod +x "$JQ_SHIM_DIR/jq"
: > "$TMP/jq-state-reads.log"

PATH="$JQ_SHIM_DIR:$PATH" bash -c '
  set -Eeuo pipefail
  source '"$REPO_DIR"'/shared/lib/wavemill-monitor.sh '"$TMP"'/env.sh
  monitor_build_pass_snapshot
  for i in 1 2 3 4 5; do
    _=$(pass_task_field HOK-1 slug)
    _=$(pass_task_field HOK-1 pr)
    _=$(pass_task_field HOK-1 phase)
  done
' >/dev/null

JQ_COUNT=$(wc -l < "$TMP/jq-state-reads.log" | tr -d ' ')
# Allow 1 jq call for the snapshot build. The ~15 subsequent pass_task_field
# reads must NOT re-read STATE_FILE.
if [[ "$JQ_COUNT" == "1" ]]; then
  pass "snapshot build + 15 pass_task_field reads cost 1 jq call on STATE_FILE"
else
  fail "snapshot build + 15 reads cost $JQ_COUNT jq STATE_FILE calls (expected 1)"
fi

# ── 5: pass_task_field falls through when snapshot not active ──────────────
FALLBACK=$(bash -c '
  set -Eeuo pipefail
  source '"$REPO_DIR"'/shared/lib/wavemill-monitor.sh '"$TMP"'/env.sh
  # Do NOT call monitor_build_pass_snapshot: the snapshot is inactive.
  printf "%s|%s" \
    "$(pass_task_field HOK-1 slug default)" \
    "$MONITOR_PASS_SNAPSHOT_ACTIVE"
')
IFS='|' read -r fb_slug fb_active <<<"$FALLBACK"
assert_eq "$fb_active" "0" "snapshot inactive by default"
assert_eq "$fb_slug" "primary-slug" "pass_task_field falls through to read_state_value when snapshot inactive"

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
exit $(( FAIL > 0 ? 1 : 0 ))
