#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$SRC_ROOT"
TMP_DIR="$(mktemp -d /tmp/wavemill-terminal-reconciler.XXXXXX)"
trap 'rm -rf "$TMP_DIR"; rm -f /tmp/wavemill-terminal-test-*.hook' EXIT

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

check_file_exists() {
  local name="$1" path="$2"
  [[ -f "$path" ]] && pass "$name" || { echo "    missing: $path"; fail "$name"; }
}

# GNU stat first: on GNU, `stat -f` means --file-system and would dump
# filesystem counters (free blocks/inodes) into the captured value.
file_mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }

FAKE_BIN="$TMP_DIR/bin"
mkdir -p "$FAKE_BIN"
PATH="$FAKE_BIN:$PATH"
export PATH

cat > "$FAKE_BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "pr" && "${2:-}" == "view" ]]; then
  pr="${3:-}"
  cat "$GH_PR_VIEW_DIR/$pr.json"
  exit 0
fi
echo "unexpected gh args: $*" >&2
exit 1
EOF
chmod +x "$FAKE_BIN/gh"

# Stateful fake tmux: without FAKE_TMUX_STATE it only logs calls (no windows
# exist). With FAKE_TMUX_STATE set, one window exists while $state/alive is
# present; kill-window removes it unless $state/fail-kill simulates one
# silent kill failure (consumed on use).
cat > "$FAKE_BIN/tmux" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${TMUX_CALL_LOG:-/dev/null}"
state="${FAKE_TMUX_STATE:-}"
[[ -n "$state" && -d "$state" ]] || exit 0
alive() { [[ -f "$state/alive" ]]; }
case "${1:-}" in
  display-message)
    target="${4:-}" fmt="${5:-}"
    alive || exit 1
    [[ "$target" == "$(cat "$state/target")" ]] || exit 1
    case "$fmt" in
      '#{session_name}') cat "$state/session" ;;
      '#{pane_current_path}') cat "$state/path" ;;
      *) exit 1 ;;
    esac
    ;;
  list-panes)
    alive || exit 1
    fmt="${5:-}"
    case "$fmt" in
      '#{pane_pid}') cat "$state/pane-pid" ;;
      '#{pane_dead}') printf '0\n' ;;
      *) exit 1 ;;
    esac
    ;;
  list-windows)
    if alive; then
      printf '%s|%s\n' "$(cat "$state/target")" "$(cat "$state/name" 2>/dev/null || echo unknown)"
    fi
    ;;
  capture-pane)
    alive || exit 1
    cat "$state/scrollback"
    ;;
  kill-window)
    if [[ -f "$state/fail-kill" ]]; then
      rm -f "$state/fail-kill"
      exit 0
    fi
    rm -f "$state/alive"
    ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$FAKE_BIN/tmux"

# shellcheck source=../shared/lib/wavemill-common.sh
source "$SRC_ROOT/shared/lib/wavemill-common.sh"
# shellcheck source=../shared/lib/terminal-reconciler.sh
source "$SRC_ROOT/shared/lib/terminal-reconciler.sh"

# Terminal records/transcripts land under $REPO_DIR/.wavemill/evals/artifacts;
# point REPO_DIR at a sandbox so tests never write into the real repo.
REPO_DIR="$TMP_DIR/repo"
mkdir -p "$REPO_DIR"

SESSION="terminal-test"
STATE_FILE="$TMP_DIR/workflow-state.json"
WORKTREE_ROOT="$TMP_DIR/worktrees"
LIB_DIR="$SRC_ROOT/shared/lib"
GH_PR_VIEW_DIR="$TMP_DIR/pr-view"
TMUX_CALL_LOG="$TMP_DIR/tmux.log"
LINEAR_CALLS="$TMP_DIR/linear.log"
STAGE_CALLS="$TMP_DIR/stage.log"
ATTENTION_CALLS="$TMP_DIR/attention.log"
export SESSION STATE_FILE WORKTREE_ROOT LIB_DIR GH_PR_VIEW_DIR TMUX_CALL_LOG
mkdir -p "$GH_PR_VIEW_DIR" "$WORKTREE_ROOT"

write_stage_result() {
  local feature_dir="$1" stage="$2" status="$3" agent="${4:-}" model="${5:-}" notes="${6:-}" artifacts="${7:-}"
  mkdir -p "$feature_dir"
  printf '%s|%s|%s|%s|%s|%s\n' "$stage" "$status" "$agent" "$model" "$notes" "$artifacts" >> "$STAGE_CALLS"
  jq -cn --arg stage "$stage" --arg status "$status" --arg notes "$notes" \
    '{stage:$stage,status:$status,notes:$notes}' > "$feature_dir/.${stage}-result.json"
}

set_window_attention_state() {
  printf '%s|%s\n' "$1" "$2" >> "$ATTENTION_CALLS"
}

linear_set_state() {
  printf '%s|%s\n' "$1" "$2" >> "$LINEAR_CALLS"
}

should_update_linear_state() { return 0; }
get_linear_issue_id() { printf '%s\n' "${1%_c}"; }
is_challenge_task() { [[ "${CHALLENGE_TASK:-false}" == "true" ]]; }
check_challenge_sibling_merged() { [[ "${CHALLENGE_SIBLING_MERGED:-false}" == "true" ]]; }
get_challenge_sibling_pr() { printf '%s\n' "${CHALLENGE_SIBLING_PR:-}"; }
pr_state() { printf '%s\n' "${CHALLENGE_SIBLING_STATE:-OPEN}"; }

reset_case() {
  local issue="$1" slug="$2" pr="$3"
  rm -f "$LINEAR_CALLS" "$STAGE_CALLS" "$ATTENTION_CALLS" "$TMUX_CALL_LOG" "/tmp/wavemill-${SESSION}-${issue}.hook"
  mkdir -p "$WORKTREE_ROOT/$slug/features/$slug"
  jq -cn --arg issue "$issue" --arg slug "$slug" --arg wt "$WORKTREE_ROOT/$slug" --arg pr "$pr" \
    '{tasks:{($issue):{slug:$slug, branch:("task/"+$slug), worktree:$wt, pr:$pr, status:"", phase:"review", agent:"codex", linearIssueId:$issue}}}' > "$STATE_FILE"
}

write_pr_state() {
  local pr="$1" state="$2" merged_at="${3:-null}"
  if [[ "$merged_at" == "null" ]]; then
    jq -cn --argjson number "$pr" --arg state "$state" '{number:$number,state:$state,mergedAt:null,terminalState:(if $state == "CLOSED" then "CLOSED" else $state end)}' > "$GH_PR_VIEW_DIR/$pr.json"
  else
    jq -cn --argjson number "$pr" --arg state "$state" --arg mergedAt "$merged_at" '{number:$number,state:$state,mergedAt:$mergedAt,terminalState:"MERGED"}' > "$GH_PR_VIEW_DIR/$pr.json"
  fi
}

echo "=== Terminal Reconciler ==="

reset_case "HOK-2599" "review-complete" "101"
write_pr_state "101" "OPEN"
jq -cn '{state:"waiting",event:"UserPromptSubmit",detail:"Claude is waiting for your input",agent:"claude",timestamp:1}' > "/tmp/wavemill-${SESSION}-HOK-2599.hook"
wavemill_reconcile_terminal "$SESSION" "HOK-2599" "review_complete" "101"
check_eq "review completion writes idle hook" "idle" "$(jq -r '.state' "/tmp/wavemill-${SESSION}-HOK-2599.hook")"
check_eq "review completion phase ready" "ready" "$(jq -r '.tasks["HOK-2599"].phase' "$STATE_FILE")"
check_file_exists "review completion archives old hook" "$WORKTREE_ROOT/review-complete/features/review-complete/.terminal-history.jsonl"
check_eq "review completion stage once" "1" "$(wc -l < "$STAGE_CALLS" | tr -d ' ')"

reset_case "HOK-2600" "merged-pr" "102"
write_pr_state "102" "MERGED" "2026-07-30T12:00:00Z"
wavemill_reconcile_terminal "$SESSION" "HOK-2600" "pr_merged" "102"
wavemill_reconcile_terminal "$SESSION" "HOK-2600" "pr_merged" "102"
check_eq "merged PR updates Linear once" "1" "$(wc -l < "$LINEAR_CALLS" | tr -d ' ')"
check_eq "merged PR stage write once" "1" "$(wc -l < "$STAGE_CALLS" | tr -d ' ')"
check_eq "merged PR status durable" "merged" "$(jq -r '.tasks["HOK-2600"].status' "$STATE_FILE")"
check_eq "merged PR workflow outcome durable" "merged" "$(jq -r '.tasks["HOK-2600"].lifecycle.workflowOutcome' "$STATE_FILE")"
check_eq "merged PR requires resource verification" "verification-required" "$(jq -r '.tasks["HOK-2600"].lifecycle.resourceDisposition' "$STATE_FILE")"
check_eq "merged PR has explicit retention reason" "terminal-reconciliation-resource-verification-required" "$(jq -r '.tasks["HOK-2600"].lifecycle.retention.reason' "$STATE_FILE")"
check_eq "pane metadata marker is truthful" "true" "$(jq -r '.tasks["HOK-2600"].terminalReconciliations["pr_merged:102"].paneMetadataApplied' "$STATE_FILE")"

reset_case "HOK-2601_c" "closed-challenge" "103"
write_pr_state "103" "CLOSED"
CHALLENGE_TASK=true CHALLENGE_SIBLING_PR=104 CHALLENGE_SIBLING_STATE=OPEN wavemill_reconcile_terminal "$SESSION" "HOK-2601_c" "pr_closed_unmerged" "103"
linear_count=0
[[ -f "$LINEAR_CALLS" ]] && linear_count="$(wc -l < "$LINEAR_CALLS" | tr -d ' ')"
check_eq "closed challenge defers Linear while sibling open" "0" "$linear_count"
check_eq "closed challenge leaves Linear marker retryable" "false" "$(jq -r '.tasks["HOK-2601_c"].terminalReconciliations["pr_closed_unmerged:103"].linearApplied' "$STATE_FILE")"
CHALLENGE_TASK=true CHALLENGE_SIBLING_PR=104 CHALLENGE_SIBLING_STATE=CLOSED wavemill_reconcile_terminal "$SESSION" "HOK-2601_c" "pr_closed_unmerged" "103"
check_eq "closed challenge updates Linear after sibling closes" "1" "$(wc -l < "$LINEAR_CALLS" | tr -d ' ')"
check_eq "closed challenge records stable marker" "true" "$(jq -r '.tasks["HOK-2601_c"].terminalReconciliations["pr_closed_unmerged:103"].linearApplied' "$STATE_FILE")"

reset_case "HOK-2602" "supersede-hook" ""
hook_file="/tmp/wavemill-${SESSION}-HOK-2602.hook"
jq -cn '{state:"error",event:"native-error",detail:"transient native failure",agent:"native",timestamp:1}' > "$hook_file"
# shellcheck source=../shared/hooks/wavemill-hook-protocol.sh
source "$SRC_ROOT/shared/hooks/wavemill-hook-protocol.sh"
WAVEMILL_SESSION="$SESSION" WAVEMILL_ISSUE="HOK-2602" WAVEMILL_FEATURE_DIR="$WORKTREE_ROOT/supersede-hook/features/supersede-hook" \
  wavemill_hook_supersede "$SESSION" "HOK-2602" "replacement_process_started"
check_eq "supersede removes old hook" "absent" "$([[ -e "$hook_file" ]] && echo present || echo absent)"
check_file_exists "supersede archives old hook" "$WORKTREE_ROOT/supersede-hook/features/supersede-hook/.terminal-history.jsonl"

echo ""
echo "=== HOK-2952: deterministic pane release ==="

# Sets up a live fake window for <issue>/<slug> and stores its id in state.
setup_fake_window() {
  local issue="$1" slug="$2" target="${3:-@99}"
  export FAKE_TMUX_STATE="$TMP_DIR/tmux-state"
  rm -rf "$FAKE_TMUX_STATE"
  mkdir -p "$FAKE_TMUX_STATE"
  printf '%s\n' "$target" > "$FAKE_TMUX_STATE/target"
  printf '%s\n' "$SESSION" > "$FAKE_TMUX_STATE/session"
  printf '%s\n' "$WORKTREE_ROOT/$slug" > "$FAKE_TMUX_STATE/path"
  printf '%s\n' "$issue-$slug" > "$FAKE_TMUX_STATE/name"
  # A definitely-dead pid: liveness guard sees no live agent child.
  printf '%s\n' "4194304" > "$FAKE_TMUX_STATE/pane-pid"
  printf 'fake pane scrollback for %s\n' "$issue" > "$FAKE_TMUX_STATE/scrollback"
  touch "$FAKE_TMUX_STATE/alive"
  state_mutate "$STATE_FILE" '.tasks[$issue].windowId = $target' --arg issue "$issue" --arg target "$target" >/dev/null
}

record_for() { printf '%s/.wavemill/evals/artifacts/%s/terminal-record.json' "$REPO_DIR" "$1"; }
kill_count() { grep -c '^kill-window' "$TMUX_CALL_LOG" 2>/dev/null || true; }

# Policy table
check_eq "policy: pr_closed_unmerged releases" "release" "$(wavemill_terminal_pane_policy_for_reason pr_closed_unmerged)"
check_eq "policy: challenge_no_comparison releases" "release" "$(wavemill_terminal_pane_policy_for_reason challenge_no_comparison)"
check_eq "policy: review_complete is metadata-only" "metadata-only" "$(wavemill_terminal_pane_policy_for_reason review_complete)"
check_eq "policy: operator_abort retains" "retain" "$(wavemill_terminal_pane_policy_for_reason operator_abort)"
check_eq "policy: REQUIRE_CONFIRM holds merged pane open" "metadata-only" "$(REQUIRE_CONFIRM=true wavemill_terminal_pane_policy_for_reason pr_merged)"
check_eq "policy: env kill-switch downgrades release" "metadata-only" "$(WAVEMILL_TERMINAL_PANE_RELEASE=0 wavemill_terminal_pane_policy_for_reason pr_merged)"

# Release via reconciliation: archive -> record -> kill, exactly once.
reset_case "HOK-2610" "release-order" "110"
write_pr_state "110" "CLOSED"
setup_fake_window "HOK-2610" "release-order"
wavemill_reconcile_terminal "$SESSION" "HOK-2610" "pr_closed_unmerged" "110"
check_eq "release kills window exactly once" "1" "$(kill_count)"
check_eq "release captures transcript before kill" "capture-first" \
  "$(awk '/^capture-pane/ { cap=NR } /^kill-window/ { kill=NR } END { print (cap && kill && cap < kill) ? "capture-first" : "wrong-order" }' "$TMUX_CALL_LOG")"
check_file_exists "release writes durable terminal record" "$(record_for HOK-2610)"
check_eq "terminal record carries reason" "pr_closed_unmerged" "$(jq -r '.reason' "$(record_for HOK-2610)")"
check_eq "terminal record names branch for recovery" "task/release-order" "$(jq -r '.recovery.branch' "$(record_for HOK-2610)")"
check_eq "transcript archived flag is truthful" "true" "$(jq -r '.transcriptArchived' "$(record_for HOK-2610)")"
check_file_exists "pane transcript archived" "$REPO_DIR/.wavemill/evals/artifacts/HOK-2610/pane-transcript-pr_closed_unmerged.txt"
check_eq "state paneReleased is truthful" "true" "$(jq -r '.tasks["HOK-2610"].paneReleased' "$STATE_FILE")"
check_eq "state paneState released" "released" "$(jq -r '.tasks["HOK-2610"].paneState' "$STATE_FILE")"
check_eq "window really gone" "absent" "$([[ -f "$FAKE_TMUX_STATE/alive" ]] && echo present || echo absent)"
# Second pass is a no-op: no second kill, no duplicate record write.
record_mtime_1="$(file_mtime "$(record_for HOK-2610)")"
wavemill_reconcile_terminal "$SESSION" "HOK-2610" "pr_closed_unmerged" "110"
check_eq "second pass does not kill again" "1" "$(kill_count)"
check_eq "second pass leaves record untouched" "$record_mtime_1" "$(file_mtime "$(record_for HOK-2610)")"
check_eq "record stays a single JSON object" "1" "$(wc -l < "$(record_for HOK-2610)" | tr -d ' ')"

# Restart replay: if state says released but the window is still discoverable,
# release must converge the pane instead of trusting stale state.
reset_case "HOK-2610R" "release-replay-stale-pane" "110"
write_pr_state "110" "CLOSED"
setup_fake_window "HOK-2610R" "release-replay-stale-pane"
state_mutate "$STATE_FILE" '.tasks[$issue].paneReleased = true | .tasks[$issue].paneState = "released"' --arg issue "HOK-2610R" >/dev/null
wavemill_release_terminal_pane "$SESSION" "HOK-2610R" "release-replay-stale-pane" "pr_closed_unmerged" "110"
check_eq "stale released state still kills live pane" "1" "$(kill_count)"
check_eq "stale released state pane gone" "absent" "$([[ -f "$FAKE_TMUX_STATE/alive" ]] && echo present || echo absent)"

# Missing window + proven ownership: idempotent success, record still written.
reset_case "HOK-2611" "release-missing-window" "111"
write_pr_state "111" "CLOSED"
rm -rf "$FAKE_TMUX_STATE"
unset FAKE_TMUX_STATE
wavemill_reconcile_terminal "$SESSION" "HOK-2611" "pr_closed_unmerged" "111"
check_file_exists "missing window still writes terminal record" "$(record_for HOK-2611)"
check_eq "missing window is idempotent success" "true" "$(jq -r '.tasks["HOK-2611"].paneReleased' "$STATE_FILE")"
# Terminal outcome: disposition stays git-owned (verification-required from
# the reconciler), never flipped by the pane release.
check_eq "missing window keeps git-owned disposition" "verification-required" "$(jq -r '.tasks["HOK-2611"].lifecycle.resourceDisposition' "$STATE_FILE")"
kill_after_missing="$(kill_count)"
check_eq "missing window never calls kill-window" "0" "$kill_after_missing"

# Live agent child in the pane blocks release (marker stays unset, no error).
reset_case "HOK-2612" "release-live-agent" "112"
write_pr_state "112" "CLOSED"
setup_fake_window "HOK-2612" "release-live-agent"
bash -c 'sleep 30 & wait' &
LIVE_PARENT_PID=$!
printf '%s\n' "$LIVE_PARENT_PID" > "$FAKE_TMUX_STATE/pane-pid"
sleep 0.2
wavemill_reconcile_terminal "$SESSION" "HOK-2612" "pr_closed_unmerged" "112"
check_eq "live agent child blocks kill" "0" "$(kill_count)"
check_eq "live agent child leaves paneReleased unset" "false" "$(jq -r '.tasks["HOK-2612"].paneReleased // false' "$STATE_FILE")"
check_eq "blocked window stays alive" "present" "$([[ -f "$FAKE_TMUX_STATE/alive" ]] && echo present || echo absent)"
kill "$LIVE_PARENT_PID" 2>/dev/null || true
wait "$LIVE_PARENT_PID" 2>/dev/null || true

# Fresh 'working' hook blocks the primitive directly.
reset_case "HOK-2613" "release-hook-working" "113"
write_pr_state "113" "CLOSED"
setup_fake_window "HOK-2613" "release-hook-working"
jq -cn --argjson ts "$(date +%s)" '{state:"working",event:"PreToolUse",detail:"Edit",agent:"claude",timestamp:$ts}' > "/tmp/wavemill-${SESSION}-HOK-2613.hook"
release_rc=0
wavemill_release_terminal_pane "$SESSION" "HOK-2613" "release-hook-working" "pr_closed_unmerged" "113" || release_rc=$?
check_eq "fresh working hook blocks release" "1" "$release_rc"
check_eq "hook block reports reason" "hook-working" "${WAVEMILL_PANE_RELEASE_BLOCK_REASON:-}"
check_eq "hook block does not kill" "0" "$(kill_count)"
rm -f "/tmp/wavemill-${SESSION}-HOK-2613.hook"

# Feature gate off: metadata-only, but truthful lifecycle fields still land.
reset_case "HOK-2614" "release-gate-off" "114"
write_pr_state "114" "CLOSED"
setup_fake_window "HOK-2614" "release-gate-off"
WAVEMILL_TERMINAL_PANE_RELEASE=0 wavemill_reconcile_terminal "$SESSION" "HOK-2614" "pr_closed_unmerged" "114"
check_eq "gate off keeps window alive" "present" "$([[ -f "$FAKE_TMUX_STATE/alive" ]] && echo present || echo absent)"
check_eq "gate off leaves paneReleased unset" "false" "$(jq -r '.tasks["HOK-2614"].paneReleased // false' "$STATE_FILE")"
check_eq "gate off still records workflow outcome" "closed" "$(jq -r '.tasks["HOK-2614"].lifecycle.workflowOutcome' "$STATE_FILE")"
check_eq "gate off still records disposition" "verification-required" "$(jq -r '.tasks["HOK-2614"].lifecycle.resourceDisposition' "$STATE_FILE")"

# REQUIRE_CONFIRM on pr_merged: metadata-only hold.
reset_case "HOK-2615" "release-confirm-hold" "115"
write_pr_state "115" "MERGED" "2026-09-01T10:00:00Z"
setup_fake_window "HOK-2615" "release-confirm-hold"
REQUIRE_CONFIRM=true wavemill_reconcile_terminal "$SESSION" "HOK-2615" "pr_merged" "115"
check_eq "REQUIRE_CONFIRM keeps merged window open" "present" "$([[ -f "$FAKE_TMUX_STATE/alive" ]] && echo present || echo absent)"
check_eq "REQUIRE_CONFIRM leaves paneReleased unset" "false" "$(jq -r '.tasks["HOK-2615"].paneReleased // false' "$STATE_FILE")"
check_eq "REQUIRE_CONFIRM still applies pane metadata" "true" "$(jq -r '.tasks["HOK-2615"].terminalReconciliations["pr_merged:115"].paneMetadataApplied' "$STATE_FILE")"

# Fault boundary: kill-window fails silently once; pass 2 converges with no
# duplicate record write.
reset_case "HOK-2616" "release-kill-fault" "116"
write_pr_state "116" "CLOSED"
setup_fake_window "HOK-2616" "release-kill-fault"
touch "$FAKE_TMUX_STATE/fail-kill"
wavemill_reconcile_terminal "$SESSION" "HOK-2616" "pr_closed_unmerged" "116"
check_file_exists "fault pass 1 still wrote record before kill" "$(record_for HOK-2616)"
check_eq "fault pass 1 leaves paneReleased unset" "false" "$(jq -r '.tasks["HOK-2616"].paneReleased // false' "$STATE_FILE")"
check_eq "fault pass 1 window survives failed kill" "present" "$([[ -f "$FAKE_TMUX_STATE/alive" ]] && echo present || echo absent)"
fault_record_mtime="$(file_mtime "$(record_for HOK-2616)")"
wavemill_reconcile_terminal "$SESSION" "HOK-2616" "pr_closed_unmerged" "116"
check_eq "fault pass 2 converges (paneReleased)" "true" "$(jq -r '.tasks["HOK-2616"].paneReleased' "$STATE_FILE")"
check_eq "fault pass 2 window gone" "absent" "$([[ -f "$FAKE_TMUX_STATE/alive" ]] && echo present || echo absent)"
check_eq "fault pass 2 does not rewrite record" "$fault_record_mtime" "$(file_mtime "$(record_for HOK-2616)")"
check_eq "record still a single JSON object after retry" "1" "$(wc -l < "$(record_for HOK-2616)" | tr -d ' ')"

# Disposition reflects git truth: a retained worktree stays retained.
reset_case "HOK-2617" "release-retained-git" "117"
setup_fake_window "HOK-2617" "release-retained-git"
state_mutate "$STATE_FILE" '.tasks[$issue].lifecycle = {schemaVersion:1, workflowOutcome:"closed", resourceDisposition:"retained", retention:{reason:"local-work-preserved", policy:"manual-verification-required", actor:"test", timestamp:"2026-09-06T00:00:00Z"}}' --arg issue "HOK-2617" >/dev/null
wavemill_release_terminal_pane "$SESSION" "HOK-2617" "release-retained-git" "pr_closed_unmerged" "117"
check_eq "retained git disposition survives pane release" "retained" "$(jq -r '.tasks["HOK-2617"].lifecycle.resourceDisposition' "$STATE_FILE")"
check_eq "retention reason intact after pane release" "local-work-preserved" "$(jq -r '.tasks["HOK-2617"].lifecycle.retention.reason' "$STATE_FILE")"
check_eq "retained git task still releases pane" "released" "$(jq -r '.tasks["HOK-2617"].paneState' "$STATE_FILE")"
unset FAKE_TMUX_STATE

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
(( FAIL == 0 ))
