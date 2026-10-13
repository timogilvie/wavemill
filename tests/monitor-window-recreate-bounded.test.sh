#!/usr/bin/env bash
# HOK-3210: missing-window recreation is bounded through bounded-retry.sh.
#
# A live task whose window disappears still gets a fresh window (no regression
# of the existing recovery path), but recreation counts against the
# `window-recreate` bucket keyed on the worktree head. Once the ceiling is hit
# the task parks at needs-user instead of creating windows forever, and a new
# commit refills the budget.
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

for fn in \
  persist_task_window_id \
  monitor_drop_reaped_issue \
  monitor_recreate_missing_task_window \
; do
  extracted="$(extract_function "$fn")"
  [[ -n "$extracted" ]] || { echo "Could not extract $fn()" >&2; exit 1; }
  eval "$extracted"
done

LOG_FILE="$TMP_ROOT/monitor.log"
ATTENTION_LOG="$TMP_ROOT/attention.log"
: > "$LOG_FILE"
: > "$ATTENTION_LOG"
log() { printf '%s\n' "$*" >> "$LOG_FILE"; }
log_warn() { printf 'WARN %s\n' "$*" >> "$LOG_FILE"; }
set_window_attention_state() { printf '%s %s\n' "$1" "$2" >> "$ATTENTION_LOG"; }
sleep() { :; }

# No backoff between attempts so each call exercises the next attempt.
export WAVEMILL_RETRY_BACKOFF_WINDOW_RECREATE_BASE_SECONDS=0
unset WAVEMILL_WINDOW_RECREATE_MAX_ATTEMPTS

SESSION="wavemill-test"
WORKTREE_ROOT="$TMP_ROOT/worktrees"
ISSUE="HOK-4000"
SLUG="live-slug"
WIN="$ISSUE-$SLUG"
WT_DIR="$WORKTREE_ROOT/$SLUG"
FEATURE_DIR="$WT_DIR/features/$SLUG"
mkdir -p "$FEATURE_DIR"
git -C "$WT_DIR" init -q
git -C "$WT_DIR" -c user.email=t@t -c user.name=t commit -q --allow-empty -m one
HEAD_ONE="$(git -C "$WT_DIR" rev-parse HEAD)"

STATE_FILE="$TMP_ROOT/workflow-state.json"
printf '{"tasks":{"%s":{"slug":"%s","phase":"executing","status":"running"}}}\n' "$ISSUE" "$SLUG" > "$STATE_FILE"
declare -A PR_BY_ISSUE=() BRANCH_BY_ISSUE=() SLUG_BY_ISSUE=() CLEANED=() REAP_LOGGED=()
BRANCH_BY_ISSUE["$ISSUE"]="task/$SLUG"
SLUG_BY_ISSUE["$ISSUE"]="$SLUG"
active_count=0

recreate() { monitor_recreate_missing_task_window "$ISSUE" "$WIN" "$WT_DIR" "$FEATURE_DIR" "executing"; }
new_window_calls() { grep -c '^new-window' "$TMUX_LOG" || true; }
retry_count() { cat "$FEATURE_DIR/.retry-window-recreate-count" 2>/dev/null || echo 0; }

echo "=== Live task: window recreation still works (no regression) ==="
recreate
assert_eq "tick 1: tmux new-window called once" "1" "$(new_window_calls)"
assert_eq "new window opens in the task worktree, not \$HOME" "1" "$(grep -c -- "-c $WT_DIR\$" "$TMUX_LOG" || true)"
assert_eq "windowId persisted on the live row" "@7" "$(jq -r --arg i "$ISSUE" '.tasks[$i].windowId' "$STATE_FILE")"
assert_eq "live row keeps its fields" "executing|running|$SLUG" "$(jq -r --arg i "$ISSUE" '.tasks[$i] | "\(.phase)|\(.status)|\(.slug)"' "$STATE_FILE")"
assert_eq "attempt counted" "1" "$(retry_count)"
assert_eq "counter keyed to the worktree head" "$HEAD_ONE" "$(head -n1 "$FEATURE_DIR/.retry-window-recreate-head")"
assert_eq "slot kept active" "1" "$active_count"
assert_eq "flagged needs-user" "$WIN needs-user" "$(tail -n1 "$ATTENTION_LOG")"
assert_eq "still tracked" "task/$SLUG" "${BRANCH_BY_ISSUE[$ISSUE]:-}"

echo ""
echo "=== Same head: ceiling (default 3) then park ==="
recreate
recreate
assert_eq "ticks 2-3: new-window called each time" "3" "$(new_window_calls)"
assert_eq "counter at ceiling" "3" "$(retry_count)"
assert_eq "not yet exhausted" "false" "$([[ -f "$FEATURE_DIR/.retry-window-recreate-exhausted" ]] && echo true || echo false)"
recreate
assert_eq "tick 4: no new-window once the budget is spent" "3" "$(new_window_calls)"
assert_eq "exhausted sentinel written" "true" "$([[ -f "$FEATURE_DIR/.retry-window-recreate-exhausted" ]] && echo true || echo false)"
assert_eq "exhaustion reason is greppable" "1" "$(grep -c '^window-recreate: 3 window recreations on head' "$FEATURE_DIR/.retry-window-recreate-exhausted" || true)"
assert_eq "parked at needs-user" "$WIN needs-user" "$(tail -n1 "$ATTENTION_LOG")"
assert_eq "exhaustion logged" "1" "$(grep -c "$ISSUE → window recreated 3 times" "$LOG_FILE" || true)"
recreate
recreate
assert_eq "further ticks stay parked without new windows" "3" "$(new_window_calls)"
assert_eq "exhaustion logged only once" "1" "$(grep -c "$ISSUE → window recreated 3 times" "$LOG_FILE" || true)"
assert_eq "still tracked while parked" "task/$SLUG" "${BRANCH_BY_ISSUE[$ISSUE]:-}"

echo ""
echo "=== New head refills the budget ==="
git -C "$WT_DIR" -c user.email=t@t -c user.name=t commit -q --allow-empty -m two
: > "$TMUX_LOG"
recreate
assert_eq "new head: new-window called again" "1" "$(new_window_calls)"
assert_eq "exhausted sentinel cleared by the head reset" "false" "$([[ -f "$FEATURE_DIR/.retry-window-recreate-exhausted" ]] && echo true || echo false)"
assert_eq "counter restarted at 1" "1" "$(retry_count)"

echo ""
echo "=== Ceiling is operator-tunable ==="
WAVEMILL_WINDOW_RECREATE_MAX_ATTEMPTS=1 recreate
assert_eq "ceiling 1: no further window after one attempt" "1" "$(new_window_calls)"
assert_eq "ceiling 1: exhausted" "true" "$([[ -f "$FEATURE_DIR/.retry-window-recreate-exhausted" ]] && echo true || echo false)"

echo ""
echo "=== Backoff holds between attempts ==="
git -C "$WT_DIR" -c user.email=t@t -c user.name=t commit -q --allow-empty -m three
: > "$TMUX_LOG"
recreate
WAVEMILL_RETRY_BACKOFF_WINDOW_RECREATE_BASE_SECONDS=600 recreate
assert_eq "second attempt deferred inside the backoff window" "1" "$(new_window_calls)"
assert_eq "deferral does not consume an attempt" "1" "$(retry_count)"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
