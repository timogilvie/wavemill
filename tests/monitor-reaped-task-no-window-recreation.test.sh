#!/usr/bin/env bash
# HOK-3210: the monitor spawned an empty tmux window every pass for a task an
# operator reaped out of band (`wavemill cleanup <issue> --abandon --execute`
# under a live mill): 67 bare `zsh` windows in 2 h.
#
# The cleanup deleted the state row, worktree and window, but the monitor
# still tracked the issue in BRANCH_BY_ISSUE. Each tick the missing-window
# branch ran `tmux new-window` (falling back to $HOME) and
# `persist_task_window_id` wrote `.tasks[$issue].windowId` back as an
# HOK-3125 orphan stub, which defeated the next tick's window lookup.
#
# This test drives the real `monitor_issue_state` (extracted from the monitor)
# through two monitor ticks for a reaped issue and asserts: no window is
# created, no stub row is written, and the issue is dropped from tracking with
# exactly one log line. It also pins `monitor_task_reap_reason`'s decision
# table so a live or launch-in-flight task is never dropped.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }
assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then pass "$label"; else fail "$label (expected '$expected', got '$actual')"; fi
}

# Brace-depth-aware extraction (same approach as tests/monitor-late-completion.test.sh).
extract_function() {
  local function_name="$1"
  awk -v name="$function_name" '
    function brace_delta(line, stripped, opens, closes) {
      stripped = line
      gsub(/"([^"\\]|\\.)*"/, "\"\"", stripped)
      gsub(/\047([^\047\\]|\\.)*\047/, "\047\047", stripped)
      opens = gsub(/\{/, "{", stripped)
      closes = gsub(/\}/, "}", stripped)
      return opens - closes
    }
    $0 ~ "^" name "\\(\\)[[:space:]]*\\{" {
      capture = 1
      depth = 0
    }
    capture {
      print
      depth += brace_delta($0)
      if (depth == 0) exit
    }
  ' "$MONITOR_SCRIPT_FILE"
}

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

# PATH shim: record every tmux invocation so the test can prove no window was
# created. display-message answers like a live server would.
SHIM_DIR="$TMP_ROOT/bin"
TMUX_LOG="$TMP_ROOT/tmux.log"
mkdir -p "$SHIM_DIR"
: > "$TMUX_LOG"
cat > "$SHIM_DIR/tmux" <<SHIM
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$TMUX_LOG"
case "\${1:-}" in
  display-message) printf '@7\n' ;;
esac
exit 0
SHIM
chmod +x "$SHIM_DIR/tmux"
export PATH="$SHIM_DIR:$PATH"

# shellcheck source=../shared/lib/wavemill-common.sh
source "$REPO_DIR/shared/lib/wavemill-common.sh"

# Module-scope snapshot field list used by monitor_build_pass_snapshot.
eval "$(awk '/^MONITOR_PASS_SNAPSHOT_FIELDS=\(/{c=1} c{print} c && /^\)/{exit}' "$MONITOR_SCRIPT_FILE")"
declare -A TASK_FIELD=() STATE_ROOT=()
MONITOR_PASS_SNAPSHOT_ACTIVE=0

for fn in \
  read_state_value \
  monitor_build_pass_snapshot \
  _pass_snapshot_unwrap \
  _unescape_json_string \
  pass_task_field \
  _pass_snapshot_load \
  pass_snapshot_refresh_task \
  persist_task_window_id \
  monitor_task_reap_reason \
  monitor_drop_reaped_issue \
  monitor_recreate_missing_task_window \
  monitor_issue_state \
; do
  extracted="$(extract_function "$fn")"
  if [[ -z "$extracted" ]]; then
    echo "Could not extract $fn() from $MONITOR_SCRIPT_FILE" >&2
    exit 1
  fi
  eval "$extracted"
done

LOG_FILE="$TMP_ROOT/monitor.log"
: > "$LOG_FILE"
log() { printf '%s\n' "$*" >> "$LOG_FILE"; }
log_warn() { printf 'WARN %s\n' "$*" >> "$LOG_FILE"; }
set_window_attention_state() { :; }
sleep() { :; }
# The window was killed by the out-of-band cleanup.
_tmux_task_window_target() { return 1; }

SESSION="wavemill-test"
WORKTREE_ROOT="$TMP_ROOT/worktrees"
mkdir -p "$WORKTREE_ROOT"
STATE_FILE="$TMP_ROOT/workflow-state.json"
declare -A PR_BY_ISSUE=() BRANCH_BY_ISSUE=() SLUG_BY_ISSUE=() CLEANED=() REAP_LOGGED=()
active_count=0

# One monitor tick, mirroring issueMonitorLoop: rebuild the pass snapshot,
# then visit every tracked issue that is not CLEANED.
run_tick() {
  local ISSUE
  monitor_build_pass_snapshot
  for ISSUE in "${!BRANCH_BY_ISSUE[@]}"; do
    [[ -n "${CLEANED[$ISSUE]:-}" ]] && continue
    monitor_issue_state "$ISSUE"
  done
  MONITOR_PASS_SNAPSHOT_ACTIVE=0
}

new_window_calls() { grep -c '^new-window' "$TMUX_LOG" || true; }

echo "=== REQ-F1: reaped task (row + worktree gone) — two ticks ==="
# State after `wavemill cleanup HOK-9999 --abandon --execute`: the row is
# deleted and the tombstone written; another live task is still present.
cat > "$STATE_FILE" <<'JSON'
{
  "tasks": {
    "HOK-1000": {"slug": "alive", "branch": "task/alive", "phase": "executing", "status": "running"}
  },
  "terminalTaskHistory": {
    "tasks": {
      "HOK-9999": {"issue": "HOK-9999", "reason": "operator_abandon", "outcome": "reaped"}
    }
  },
  "terminalTaskTombstones": {}
}
JSON
BRANCH_BY_ISSUE["HOK-9999"]="task/reaped-slug"
SLUG_BY_ISSUE["HOK-9999"]="reaped-slug"
before_state="$(cat "$STATE_FILE")"

run_tick
run_tick

assert_eq "no tmux new-window across two ticks" "0" "$(new_window_calls)"
assert_eq "state file unchanged (no stub row recreated)" "$before_state" "$(cat "$STATE_FILE")"
assert_eq "HOK-9999 row still absent" "true" "$(jq '.tasks["HOK-9999"] == null' "$STATE_FILE")"
assert_eq "dropped from BRANCH_BY_ISSUE" "unset" "${BRANCH_BY_ISSUE[HOK-9999]-unset}"
assert_eq "dropped from SLUG_BY_ISSUE" "unset" "${SLUG_BY_ISSUE[HOK-9999]-unset}"
assert_eq "marked CLEANED" "1" "${CLEANED[HOK-9999]:-}"
assert_eq "reap logged exactly once" "1" "$(grep -c 'HOK-9999 → reaped out of band' "$LOG_FILE" || true)"
assert_eq "no 'Window disappeared' recreation line" "0" "$(grep -c 'Window disappeared' "$LOG_FILE" || true)"

echo ""
echo "=== REQ-F1: row missing, tombstone evicted (byte cap), worktree gone ==="
: > "$TMUX_LOG"; : > "$LOG_FILE"
printf '{"tasks":{}}\n' > "$STATE_FILE"
BRANCH_BY_ISSUE["HOK-9998"]="task/evicted-slug"
SLUG_BY_ISSUE["HOK-9998"]="evicted-slug"
run_tick
run_tick
assert_eq "no tmux new-window without a tombstone either" "0" "$(new_window_calls)"
assert_eq "no stub row written" '{"tasks":{}}' "$(jq -c . "$STATE_FILE")"
assert_eq "dropped (missing worktree is a reap signal)" "1" "${CLEANED[HOK-9998]:-}"

echo ""
echo "=== REQ-F1: a pre-fix orphan stub row + missing worktree is also dropped ==="
: > "$TMUX_LOG"; : > "$LOG_FILE"
printf '{"tasks":{"HOK-9997":{"windowId":"@232"}}}\n' > "$STATE_FILE"
BRANCH_BY_ISSUE["HOK-9997"]="task/stub-slug"
SLUG_BY_ISSUE["HOK-9997"]="stub-slug"
run_tick
assert_eq "no tmux new-window for an orphan stub" "0" "$(new_window_calls)"
assert_eq "dropped from tracking" "1" "${CLEANED[HOK-9997]:-}"
assert_eq "reason names the stub" "1" "$(grep -c 'HOK-9997 → reaped out of band (state row stub' "$LOG_FILE" || true)"

echo ""
echo "=== monitor_task_reap_reason decision table ==="
mkdir -p "$WORKTREE_ROOT/live-slug" "$WORKTREE_ROOT/inflight-slug"
cat > "$STATE_FILE" <<'JSON'
{
  "tasks": {
    "HOK-2001": {"slug": "live-slug", "phase": "executing", "status": "running"},
    "HOK-2002": {"slug": "live-gone", "phase": "executing", "status": "running"},
    "HOK-2004": {"windowId": "@9"}
  },
  "terminalTaskHistory": {"tasks": {"HOK-2005": {"issue": "HOK-2005"}}}
}
JSON
reap() { monitor_task_reap_reason "$1" "$2" >/dev/null && echo reaped || echo kept; }
# Snapshot inactive: pass_task_field falls through to read_state_value.
assert_eq "live row + worktree present → kept" "kept" "$(reap HOK-2001 "$WORKTREE_ROOT/live-slug")"
assert_eq "live row + worktree gone → kept (row is authoritative)" "kept" "$(reap HOK-2002 "$WORKTREE_ROOT/live-gone")"
assert_eq "row missing + worktree present + no tombstone → kept (launch in flight)" "kept" "$(reap HOK-2003 "$WORKTREE_ROOT/inflight-slug")"
assert_eq "orphan stub + worktree present + no tombstone → kept" "kept" "$(reap HOK-2004 "$WORKTREE_ROOT/inflight-slug")"
assert_eq "row missing + tombstone + worktree present → reaped" "reaped" "$(reap HOK-2005 "$WORKTREE_ROOT/inflight-slug")"
assert_eq "row missing + worktree gone → reaped" "reaped" "$(reap HOK-2006 "$WORKTREE_ROOT/nope")"
# Snapshot active: a live row is answered from the snapshot alone.
monitor_build_pass_snapshot
assert_eq "snapshot: live row → kept" "kept" "$(reap HOK-2001 "$WORKTREE_ROOT/live-slug")"
assert_eq "snapshot: row missing + worktree gone → reaped" "reaped" "$(reap HOK-2006 "$WORKTREE_ROOT/nope")"
MONITOR_PASS_SNAPSHOT_ACTIVE=0
# An unparsable state file (in-flight write) never reads as reaped.
printf '{"tasks": {' > "$STATE_FILE"
assert_eq "unparsable state → kept" "kept" "$(reap HOK-2006 "$WORKTREE_ROOT/nope")"

echo ""
echo "=== monitor_recreate_missing_task_window: worktree gone → drop, no window ==="
: > "$TMUX_LOG"; : > "$LOG_FILE"
printf '{"tasks":{"HOK-3001":{"slug":"x","phase":"executing","status":"running"}}}\n' > "$STATE_FILE"
BRANCH_BY_ISSUE["HOK-3001"]="task/x"
SLUG_BY_ISSUE["HOK-3001"]="x"
monitor_recreate_missing_task_window "HOK-3001" "HOK-3001-x" "$WORKTREE_ROOT/x" "$WORKTREE_ROOT/x/features/x" "executing"
assert_eq "no tmux new-window when the worktree is gone" "0" "$(new_window_calls)"
assert_eq "dropped from tracking" "1" "${CLEANED[HOK-3001]:-}"
assert_eq "no retry state written under a missing worktree" "false" "$([[ -e "$WORKTREE_ROOT/x" ]] && echo true || echo false)"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
