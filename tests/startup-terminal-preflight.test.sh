#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP_DIR="$(mktemp -d /tmp/wavemill-startup-preflight.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

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

check_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$name"
  else
    echo "    missing: $needle"
    fail "$name"
  fi
}

line_count() {
  local path="$1"
  [[ -f "$path" ]] || { printf '0\n'; return 0; }
  wc -l < "$path" | tr -d ' '
}

extract_function() {
  local source_file="$1" function_name="$2"
  awk -v name="$function_name" '
    function strip(line,   s) {
      s = line
      gsub(/(^|[[:space:]])#.*/, "", s)
      gsub(/"([^"\\]|\\.)*"/, "\"\"", s)
      gsub(/\047([^\047\\]|\\.)*\047/, "\047\047", s)
      return s
    }
    function brace_delta(line,   s, opens, closes) {
      s = strip(line)
      opens = gsub(/\{/, "{", s)
      closes = gsub(/\}/, "}", s)
      return opens - closes
    }
    !capture && $0 ~ "^" name "\\(\\)[[:space:]]*\\{" {
      capture = 1
      depth = 0
    }
    capture {
      print
      depth += brace_delta($0)
      if (depth <= 0) exit
    }
  ' "$source_file"
}

FAKE_BIN="$TMP_DIR/bin"
mkdir -p "$FAKE_BIN"
PATH="$FAKE_BIN:$PATH"
export PATH

cat > "$FAKE_BIN/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${GH_CALL_LOG:-/dev/null}"
if [[ "${1:-}" == "pr" && "${2:-}" == "view" ]]; then
  pr="${3:-}"
  [[ -f "$GH_PR_VIEW_DIR/$pr.json" ]] || exit 44
  if [[ "$*" == *"--jq .state"* ]]; then
    jq -r '.state // empty' "$GH_PR_VIEW_DIR/$pr.json"
  else
    cat "$GH_PR_VIEW_DIR/$pr.json"
  fi
  exit 0
fi
exit 1
SH
chmod +x "$FAKE_BIN/gh"

cat > "$FAKE_BIN/tmux" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${TMUX_CALL_LOG:-/dev/null}"
exit 1
SH
chmod +x "$FAKE_BIN/tmux"

# shellcheck source=../shared/lib/wavemill-common.sh
source "$REPO_DIR/shared/lib/wavemill-common.sh"
# shellcheck source=../shared/lib/terminal-reconciler.sh
source "$REPO_DIR/shared/lib/terminal-reconciler.sh"
# shellcheck source=../shared/lib/startup-terminal-preflight.sh
source "$REPO_DIR/shared/lib/startup-terminal-preflight.sh"

SESSION="startup-preflight"
STATE_FILE="$TMP_DIR/workflow-state.json"
WORKTREE_ROOT="$TMP_DIR/worktrees"
GH_PR_VIEW_DIR="$TMP_DIR/pr-view"
GH_CALL_LOG="$TMP_DIR/gh.log"
TMUX_CALL_LOG="$TMP_DIR/tmux.log"
STAGE_CALLS="$TMP_DIR/stage.log"
LINEAR_CALLS="$TMP_DIR/linear.log"
CLEANUP_CALLS="$TMP_DIR/cleanup.log"
WARN_OUTPUT=""
LOG_OUTPUT=""
BASE_BRANCH="auto/integration"
WAVEMILL_RUN_EPOCH="epoch-test"
export SESSION STATE_FILE WORKTREE_ROOT GH_PR_VIEW_DIR GH_CALL_LOG TMUX_CALL_LOG BASE_BRANCH WAVEMILL_RUN_EPOCH
mkdir -p "$WORKTREE_ROOT" "$GH_PR_VIEW_DIR"

log() { LOG_OUTPUT+="$*"$'\n'; }
log_warn() { WARN_OUTPUT+="$*"$'\n'; }
write_stage_result() {
  local feature_dir="$1" stage="$2" status="$3" agent="${4:-}" model="${5:-}" notes="${6:-}" artifacts="${7:-}"
  mkdir -p "$feature_dir"
  printf '%s|%s|%s|%s|%s|%s\n' "$stage" "$status" "$agent" "$model" "$notes" "$artifacts" >> "$STAGE_CALLS"
}
linear_set_state() { printf '%s|%s\n' "$1" "$2" >> "$LINEAR_CALLS"; }
cleanup_completed_task() { printf '%s|%s|%s\n' "$1" "$2" "${3:-}" >> "$CLEANUP_CALLS"; }
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

reset_case() {
  rm -f "$GH_CALL_LOG" "$TMUX_CALL_LOG" "$STAGE_CALLS" "$LINEAR_CALLS" "$CLEANUP_CALLS"
  WARN_OUTPUT=""
  LOG_OUTPUT=""
  mkdir -p "$WORKTREE_ROOT"
  jq -cn '{session:"startup-preflight",tasks:{}}' > "$STATE_FILE"
}

add_task() {
  local issue="$1" slug="$2" phase="$3" status="$4" pr="${5:-}" challenge="${6:-false}" pair="${7:-}" role="${8:-}"
  local wt="$WORKTREE_ROOT/$slug"
  mkdir -p "$wt/features/$slug"
  state_mutate "$STATE_FILE" '
    .tasks[$issue] = {
      slug: $slug,
      branch: ("task/" + $slug),
      worktree: $wt,
      pr: $pr,
      phase: (if $phase == "" then null else $phase end),
      status: $status,
      agent: "codex",
      challenge: ($challenge == "true"),
      challengePairId: $pair,
      challengeRole: $role
    }
    | if $phase == "" then .tasks[$issue] |= del(.phase) else . end' \
    --arg issue "$issue" \
    --arg slug "$slug" \
    --arg wt "$wt" \
    --arg pr "$pr" \
    --arg phase "$phase" \
    --arg status "$status" \
    --arg challenge "$challenge" \
    --arg pair "$pair" \
    --arg role "$role" >/dev/null
}

write_pr_state() {
  local pr="$1" state="$2" merged_at="${3:-}" base="${4:-auto/integration}"
  jq -cn \
    --argjson number "$pr" \
    --arg state "$state" \
    --arg mergedAt "$merged_at" \
    --arg base "$base" \
    '{
      number: $number,
      state: $state,
      mergedAt: (if $mergedAt == "" then null else $mergedAt end),
      headRefOid: "abc123",
      headRefName: "task/test",
      baseRefName: $base,
      mergeCommit: {oid: "def456"},
      terminalState: (if $state == "MERGED" or $mergedAt != "" then "MERGED" elif $state == "CLOSED" then "CLOSED" else $state end)
    }' > "$GH_PR_VIEW_DIR/$pr.json"
}

normalized_state() {
  jq -S '
    del(.updated)
    | .tasks |= with_entries(
        .value |= (
          del(.updated, .supersededAt)
          | if .rehydration then .rehydration |= del(.checkedAt) else . end
          | if .terminalReconciliations then
              .terminalReconciliations |= with_entries(.value |= del(.appliedAt, .updatedAt))
            else . end
        )
      )
  ' "$STATE_FILE"
}

echo "=== Startup Terminal Preflight ==="

reset_case
add_task "HOK-3001" "merged-primary" "review" "active" "101"
write_pr_state "101" "MERGED" "2026-09-01T12:00:00Z"
check_eq "merged primary classifies terminal" "terminal:pr_merged" "$(startup_task_eligibility HOK-3001)"
startup_terminal_preflight "$SESSION"
check_eq "merged primary rehydration terminal" "terminal" "$(jq -r '.tasks["HOK-3001"].rehydration.eligibility' "$STATE_FILE")"
check_eq "merged primary reconciler marker" "true" "$(jq -r '.tasks["HOK-3001"].terminalReconciliations["pr_merged:101"].stateApplied' "$STATE_FILE")"
check_contains "merged primary cleanup routed" "$(cat "$CLEANUP_CALLS")" "HOK-3001|merged-primary|startup terminal preflight"

reset_case
add_task "HOK-3002" "closed-unmerged" "ready" "active" "102"
write_pr_state "102" "CLOSED"
startup_terminal_preflight "$SESSION"
check_eq "closed-unmerged classified" "pr_closed_unmerged" "$(jq -r '.tasks["HOK-3002"].rehydration.reason' "$STATE_FILE")"
direct_delete_count=0
[[ -f "$TMUX_CALL_LOG" ]] && direct_delete_count=$((direct_delete_count + $(grep -cE 'worktree remove|branch -D|push origin --delete' "$TMUX_CALL_LOG" 2>/dev/null || true)))
[[ -f "$GH_CALL_LOG" ]] && direct_delete_count=$((direct_delete_count + $(grep -cE 'worktree remove|branch -D|push origin --delete' "$GH_CALL_LOG" 2>/dev/null || true)))
check_eq "closed-unmerged does not delete directly" "0" "$direct_delete_count"

reset_case
add_task "HOK-3003" "primary" "ready" "active" "201" "true" "HOK-3003" "primary"
add_task "HOK-3003_c" "challenger" "ready" "active" "" "true" "HOK-3003" "challenger"
write_pr_state "201" "MERGED" "2026-09-01T12:00:00Z"
check_eq "superseded challenger classifies by sibling" "terminal:challenge_resolved_winner" "$(startup_task_eligibility HOK-3003_c)"
startup_terminal_preflight "$SESSION"
check_eq "superseded challenger reason stamped" "Primary already merged as PR #201" "$(jq -r '.tasks["HOK-3003_c"].supersededReason' "$STATE_FILE")"

reset_case
add_task "HOK-3004" "active-task" "coding" "active" ""
startup_terminal_preflight "$SESSION"
check_eq "active task remains eligible" "eligible" "$(jq -r '.tasks["HOK-3004"].rehydration.eligibility' "$STATE_FILE")"
check_eq "active task does not cleanup" "0" "$(line_count "$CLEANUP_CALLS")"

reset_case
add_task "HOK-3005_c" "persisted-superseded" "superseded" "superseded" ""
check_eq "persisted superseded terminal without network" "terminal:challenge_resolved_winner" "$(startup_task_eligibility HOK-3005_c)"
check_eq "persisted superseded made no gh call" "absent" "$([[ -f "$GH_CALL_LOG" ]] && echo present || echo absent)"

reset_case
add_task "HOK-3006" "missing-network" "review" "active" "106"
check_eq "missing network defers active task" "deferred:pr_state_unverifiable" "$(startup_task_eligibility HOK-3006)"
startup_terminal_preflight "$SESSION"
check_eq "missing network stamped deferred" "deferred" "$(jq -r '.tasks["HOK-3006"].rehydration.eligibility' "$STATE_FILE")"
check_eq "missing network emits one warning" "1" "$(grep -c 'Startup terminal preflight deferred' <<<"$WARN_OUTPUT")"

reset_case
add_task "HOK-3007" "legacy" "" "active" ""
add_task "HOK-3008" "sibling-active" "coding" "active" ""
startup_terminal_preflight "$SESSION"
check_eq "legacy ambiguous requires verification" "verification-required" "$(jq -r '.tasks["HOK-3007"].rehydration.eligibility' "$STATE_FILE")"
check_eq "legacy disposition stamped" "verification-required" "$(jq -r '.tasks["HOK-3007"].lifecycle.resourceDisposition' "$STATE_FILE")"
check_eq "legacy does not block sibling" "eligible" "$(jq -r '.tasks["HOK-3008"].rehydration.eligibility' "$STATE_FILE")"

reset_case
add_task "HOK-3009" "restart-idempotent" "review" "active" "109"
write_pr_state "109" "MERGED" "2026-09-01T12:00:00Z"
startup_terminal_preflight "$SESSION"
state_once="$(normalized_state)"
startup_terminal_preflight "$SESSION"
state_twice="$(normalized_state)"
check_eq "restart preflight converges" "$state_once" "$state_twice"
check_eq "restart preflight keeps one marker" "1" "$(jq -r '.tasks["HOK-3009"].terminalReconciliations | length' "$STATE_FILE")"

reset_case
add_task "HOK-3010" "gate-off" "review" "active" "110"
write_pr_state "110" "MERGED" "2026-09-01T12:00:00Z"
before="$(jq -S . "$STATE_FILE")"
WAVEMILL_STARTUP_TERMINAL_PREFLIGHT=0 startup_terminal_preflight "$SESSION"
after="$(jq -S . "$STATE_FILE")"
check_eq "feature gate off is no-op" "$before" "$after"

reset_case
add_task "HOK-3011" "monitor-closed" "closed" "closed" "111"
monitor_restore_file="$TMP_DIR/monitor-restore.sh"
extract_function "$REPO_DIR/shared/lib/wavemill-monitor.sh" "_restore_inflight_task_window_if_missing" > "$monitor_restore_file"
# shellcheck source=/dev/null
source "$monitor_restore_file"
launch_planning_phase() { fail "monitor restore unexpectedly launched planning"; return 1; }
launch_coding_phase() { fail "monitor restore unexpectedly launched coding"; return 1; }
launch_review_phase() { fail "monitor restore unexpectedly launched review"; return 1; }
_restore_inflight_task_window_if_missing "HOK-3011" "monitor-closed" "task/monitor-closed" "coding"
check_eq "monitor restore skips terminal task" "none" "$_RESTORE_STATE"

# HOK-3115 regression (2026-09-29): the startup runner has no log_warn and no
# monitor identity helpers, and used to carry its own silent linear_set_state.
# An aborted HOK-N_c task (linearIssueId=HOK-N, no challengeRole) reconciled
# by the startup terminal preflight must make no Linear call and emit no
# warning; the aborted primary still writes through the canonical helper.
reset_case
add_task "HOK-3012_c" "aborted-challenger" "aborted" "aborted" "" "true" "HOK-3012" ""
state_mutate "$STATE_FILE" '.tasks["HOK-3012_c"] |= (del(.challengeRole) | .linearIssueId = "HOK-3012")' >/dev/null
add_task "HOK-3013" "aborted-primary" "aborted" "aborted" ""
NPX_CALLS="$TMP_DIR/npx.log"
STARTUP_LOG_FILE="$TMP_DIR/startup.log"
rm -f "$NPX_CALLS" "$STARTUP_LOG_FILE"
check_eq "aborted challenger classifies terminal" "terminal:operator_abort" "$(startup_task_eligibility HOK-3012_c)"
(
  # Recreate the startup-runner scope: canonical common helpers only.
  unset -f log_warn get_linear_issue_id should_update_linear_state linear_set_state
  eval "$(extract_function "$REPO_DIR/shared/lib/wavemill-common.sh" linear_set_state)"
  startup_log() { printf '%s\n' "$*" >> "$STARTUP_LOG_FILE"; }
  npx() { printf '%s\n' "$*" >> "$NPX_CALLS"; }
  TOOLS_DIR="$REPO_DIR/tools"
  DRY_RUN="false"
  startup_terminal_preflight "$SESSION"
)
npx_calls="$(cat "$NPX_CALLS" 2>/dev/null || true)"
check_eq "aborted challenger reconciled terminal" "terminal" "$(jq -r '.tasks["HOK-3012_c"].rehydration.eligibility' "$STATE_FILE")"
check_eq "aborted challenger makes no Linear call" "0" "$(grep -c 'HOK-3012' <<<"$npx_calls" || true)"
check_contains "aborted primary still writes Linear" "$npx_calls" "set-issue-state.ts HOK-3013 Backlog"
check_eq "aborted challenger emits no warning" "0" "$(cat "$STARTUP_LOG_FILE" 2>/dev/null | grep -ci 'warn' || true)"
check_eq "startup runner defines no linear_set_state" "0" "$(grep -c '^linear_set_state()' "$REPO_DIR/shared/lib/wavemill-startup-runner.sh" || true)"

if (( FAIL > 0 )); then
  echo "--- Results: $PASS passed, $FAIL failed ---"
  exit 1
fi

echo "--- Results: $PASS passed, 0 failed ---"
