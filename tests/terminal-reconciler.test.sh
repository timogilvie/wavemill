#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
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

cat > "$FAKE_BIN/tmux" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${TMUX_CALL_LOG:-/dev/null}"
exit 0
EOF
chmod +x "$FAKE_BIN/tmux"

# shellcheck source=../shared/lib/wavemill-common.sh
source "$REPO_DIR/shared/lib/wavemill-common.sh"
# shellcheck source=../shared/lib/terminal-reconciler.sh
source "$REPO_DIR/shared/lib/terminal-reconciler.sh"

SESSION="terminal-test"
STATE_FILE="$TMP_DIR/workflow-state.json"
WORKTREE_ROOT="$TMP_DIR/worktrees"
LIB_DIR="$REPO_DIR/shared/lib"
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
source "$REPO_DIR/shared/hooks/wavemill-hook-protocol.sh"
WAVEMILL_SESSION="$SESSION" WAVEMILL_ISSUE="HOK-2602" WAVEMILL_FEATURE_DIR="$WORKTREE_ROOT/supersede-hook/features/supersede-hook" \
  wavemill_hook_supersede "$SESSION" "HOK-2602" "replacement_process_started"
check_eq "supersede removes old hook" "absent" "$([[ -e "$hook_file" ]] && echo present || echo absent)"
check_file_exists "supersede archives old hook" "$WORKTREE_ROOT/supersede-hook/features/supersede-hook/.terminal-history.jsonl"

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
(( FAIL == 0 ))
