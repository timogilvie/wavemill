#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_REPO_DIR="$REPO_DIR"
TMP_DIR="$(mktemp -d /tmp/wavemill-fresh-launch-preflight.XXXXXX)"
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

extract_function() {
  local source_file="$1" function_name="$2"
  awk -v name="$function_name" '
    !capture && $0 ~ "^" name "\\(\\)[[:space:]]*\\{" {
      capture = 1
    }
    capture {
      print
      if ($0 == "}") exit
    }
  ' "$source_file"
}

FAKE_BIN="$TMP_DIR/bin"
GH_FIXTURES="$TMP_DIR/gh"
mkdir -p "$FAKE_BIN" "$GH_FIXTURES"
PATH="$FAKE_BIN:$PATH"
export PATH GH_FIXTURES

cat > "$FAKE_BIN/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "pr" && "${2:-}" == "list" ]]; then
  head=""
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "--head" ]]; then
      head="${2:-}"
      break
    fi
    shift
  done
  key="${head//\//__}"
  if [[ -n "${GH_FAIL:-}" ]]; then
    exit "$GH_FAIL"
  fi
  if [[ -f "$GH_FIXTURES/$key.json" ]]; then
    cat "$GH_FIXTURES/$key.json"
  else
    printf '[]\n'
  fi
  exit 0
fi
exit 1
SH
chmod +x "$FAKE_BIN/gh"

STARTUP_FUNCS="$TMP_DIR/startup-functions.sh"
for fn in \
  startup_issue_state_from_task \
  startup_existing_attempt_for_issue \
  startup_stamp_fresh_plan_summary \
  startup_preflight_fresh_launch_plan
do
  extract_function "$SOURCE_REPO_DIR/shared/lib/wavemill-startup-runner.sh" "$fn" >> "$STARTUP_FUNCS"
done

# shellcheck source=../shared/lib/wavemill-common.sh
source "$SOURCE_REPO_DIR/shared/lib/wavemill-common.sh"
# shellcheck source=../shared/lib/startup-terminal-preflight.sh
source "$SOURCE_REPO_DIR/shared/lib/startup-terminal-preflight.sh"
# shellcheck source=/tmp/startup-functions.sh
source "$STARTUP_FUNCS"

SESSION="fresh-preflight"
STATE_FILE="$TMP_DIR/state.json"
STATE_DIR="$TMP_DIR/state"
WORKTREE_ROOT="$TMP_DIR/worktrees"
PLAN_FILE="$TMP_DIR/launch-plan.json"
BASE_BRANCH="auto/integration"
REPO_DIR="$TMP_DIR/repo"
API_TIMEOUT=2
WAVEMILL_RUN_EPOCH="epoch-fresh"
LOG_OUTPUT=""
export SESSION STATE_FILE STATE_DIR WORKTREE_ROOT PLAN_FILE BASE_BRANCH REPO_DIR API_TIMEOUT WAVEMILL_RUN_EPOCH
mkdir -p "$STATE_DIR" "$WORKTREE_ROOT" "$REPO_DIR"
git -C "$REPO_DIR" init -q

startup_log() { LOG_OUTPUT+="$*"$'\n'; }
log_warn() { LOG_OUTPUT+="WARN: $*"$'\n'; }
log() { :; }
wavemill_lock_run() { shift; "$@"; }

write_prs() {
  local branch="$1" json="$2"
  printf '%s\n' "$json" > "$GH_FIXTURES/${branch//\//__}.json"
}

write_issue_json() {
  local issue="$1" state="$2"
  jq -cn --arg state "$state" '{state:{name:$state}}' > "$TMP_DIR/${issue}.json"
}

task_json() {
  local issue="$1" slug="$2" title="$3" extra="${4-}"
  [[ -n "$extra" ]] || extra='{}'
  jq -cn \
    --arg issue "$issue" \
    --arg slug "$slug" \
    --arg title "$title" \
    --arg worktree "$WORKTREE_ROOT/$slug" \
    --arg issueFile "$TMP_DIR/${issue}.json" \
    --argjson extra "$extra" \
    '{
      issue: $issue,
      slug: $slug,
      title: $title,
      branch: ("task/" + $slug),
      worktreeDir: $worktree,
      linearIssueId: ($issue | sub("_c$"; "")),
      taskPacketFile: "/tmp/task.md",
      taskPacketDetailsFile: "/tmp/details.md",
      issueJsonFile: $issueFile,
      route: {planner:"gpt-5.6-terra", coder:"gpt-5.5", reviewer:"gpt-5.6-terra"}
    } + $extra'
}

reset_state() {
  LOG_OUTPUT=""
  jq -cn '{session:"fresh-preflight",tasks:{}}' > "$STATE_FILE"
}

echo "=== Fresh Launch Terminal Preflight ==="

reset_state
write_prs "task/branch-only" '[{"number":9,"state":"MERGED","mergedAt":"2026-09-01T00:00:00Z","headRefName":"task/branch-only","headRefOid":"abc","baseRefName":"auto/integration","title":"old unrelated work","body":"","updatedAt":"2026-09-01T00:00:00Z"}]'
classification="$(wavemill_resolve_pr_attempt "HOK-3000" "task/branch-only" "$BASE_BRANCH" "" "HOK-3000-a1" "Backlog" "" "" | jq -r '.classification + ":" + .reason')"
check_eq "branch-only merged candidate is historical" "historical-merged:branch_only_match" "$classification"

reset_state
write_issue_json "HOK-2915" "Todo"
write_issue_json "HOK-2915_c" "Todo"
write_issue_json "HOK-2595" "Backlog"
write_issue_json "HOK-3003" "Todo"
write_issue_json "HOK-3004" "Todo"
write_prs "task/merged-primary" '[{"number":1306,"state":"MERGED","mergedAt":"2026-09-02T00:00:00Z","headRefName":"task/merged-primary","headRefOid":"a1","baseRefName":"auto/integration","title":"HOK-2915 merged work","body":"","updatedAt":"2026-09-02T00:00:00Z"}]'
write_prs "task/reopened" '[{"number":1043,"state":"CLOSED","mergedAt":null,"headRefName":"task/reopened","headRefOid":"b1","baseRefName":"auto/integration","title":"HOK-2595 old attempt","body":"","updatedAt":"2026-08-03T00:00:00Z"}]'

primary_extra='{"challenge":true,"challengePairId":"HOK-2915","challengeRole":"primary"}'
challenger_extra='{"challenge":true,"challengePairId":"HOK-2915","challengeRole":"challenger"}'
jq -cn \
  --argjson t1 "$(task_json HOK-2915 merged-primary "Merged primary" "$primary_extra")" \
  --argjson t2 "$(task_json HOK-2915_c merged-challenger "Merged challenger" "$challenger_extra")" \
  --argjson t3 "$(task_json HOK-2595 reopened "Reopened old PR")" \
  --argjson t4 "$(task_json HOK-3003 clean-a "Clean A")" \
  --argjson t5 "$(task_json HOK-3004 clean-b "Clean B")" \
  --arg stateFile "$STATE_FILE" \
  --arg stateDir "$STATE_DIR" \
  --arg worktreeRoot "$WORKTREE_ROOT" \
  '{
    session:"fresh-preflight",
    repoDir:"/tmp/repo",
    baseBranch:"auto/integration",
    worktreeRoot:$worktreeRoot,
    agentCmd:"codex",
    stateFile:$stateFile,
    stateDir:$stateDir,
    tasks: [$t1,$t2,$t3,$t4,$t5]
  }' > "$PLAN_FILE"

startup_preflight_fresh_launch_plan

check_eq "incident matrix leaves three launchable tasks" "3" "$(jq '.tasks | length' "$PLAN_FILE")"
check_eq "fresh preflight reports two skips" "2" "$(jq '.freshLaunchPreflight.skippedTaskCount' "$PLAN_FILE")"
check_eq "reopened task receives retry branch" "task/reopened-r2" "$(jq -r '.tasks[] | select(.issue=="HOK-2595") | .branch' "$PLAN_FILE")"
check_eq "reopened task receives retry slug" "reopened-r2" "$(jq -r '.tasks[] | select(.issue=="HOK-2595") | .slug' "$PLAN_FILE")"
check_eq "merged primary persisted terminal" "merged" "$(jq -r '.tasks["HOK-2915"].status' "$STATE_FILE")"
check_eq "merged challenger suppressed terminal" "merged" "$(jq -r '.tasks["HOK-2915_c"].status' "$STATE_FILE")"
if [[ -d "$WORKTREE_ROOT/merged-primary" ]]; then
  allocated_worktree="true"
else
  allocated_worktree="false"
fi
check_eq "terminal skip allocated no worktree" "false" "$allocated_worktree"

retry_task="$(jq -c '.tasks[] | select(.issue=="HOK-2595")' "$PLAN_FILE")"
save_task_state "HOK-2595" \
  "$(jq -r '.slug' <<<"$retry_task")" \
  "$(jq -r '.branch' <<<"$retry_task")" \
  "$(jq -r '.worktreeDir' <<<"$retry_task")" \
  "" "" "codex" "HOK-2595"
wavemill_persist_attempt_reconciliation "HOK-2595" \
  "$(jq -c '.attempt' <<<"$retry_task")" \
  "$(jq -c '.prReconciliation' <<<"$retry_task")" \
  "test"
check_eq "reopened launched state does not attach old PR" "" "$(jq -r '.tasks["HOK-2595"].pr // empty' "$STATE_FILE")"

find_fn="$TMP_DIR/find-pr.sh"
extract_function "$SOURCE_REPO_DIR/shared/lib/wavemill-monitor.sh" "find_pr_for_branch" > "$find_fn"
# shellcheck source=/tmp/find-pr.sh
source "$find_fn"
read_state_value() {
  local default="$1"
  shift
  jq -r "$@" "$STATE_FILE" 2>/dev/null || printf '%s\n' "$default"
}

write_prs "task/reopened-r2" '[{"number":77,"state":"OPEN","mergedAt":null,"headRefName":"task/reopened-r2","headRefOid":"c1","baseRefName":"auto/integration","title":"unrelated title","body":"","updatedAt":"2026-09-08T00:00:00Z"}]'
check_eq "monitor does not bind branch-only open PR" "" "$(find_pr_for_branch "task/reopened-r2")"

write_prs "task/reopened-r2" '[{"number":78,"state":"OPEN","mergedAt":null,"headRefName":"task/reopened-r2","headRefOid":"c1","baseRefName":"auto/integration","title":"HOK-2595 current attempt","body":"","updatedAt":"2026-09-08T00:00:00Z"}]'
check_eq "monitor binds evidence-backed current open PR" "78" "$(find_pr_for_branch "task/reopened-r2")"

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
if (( FAIL > 0 )); then
  exit 1
fi
