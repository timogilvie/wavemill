#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_ROOT/shared/lib/wavemill-monitor.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

extract_function() {
  local name="$1"
  awk -v name="$name" '
    $0 ~ "^" name "\\(\\) \\{" { capture=1 }
    capture { print }
    /^}/ && capture { exit }
  ' "$MONITOR_SCRIPT_FILE"
}

eval "$(extract_function challenge_deferred_arm_state_filter)"
eval "$(extract_function challenge_mark_materialize_failed)"
eval "$(extract_function challenge_write_review_deferred_arms)"
eval "$(extract_function challenge_stamp_fork_descriptor)"
eval "$(extract_function challenge_materialize_challenger_arm)"
eval "$(extract_function challenge_maybe_materialize_deferred_arm)"
eval "$(extract_function challenge_cancel_challenger_arm)"

# shellcheck source=../shared/lib/bounded-retry.sh
source "$REPO_ROOT/shared/lib/bounded-retry.sh"

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

STATE_FILE="$TMP_ROOT/workflow-state.json"
STATE_DIR="$TMP_ROOT/state"
REPO_DIR="$TMP_ROOT/repo"
WORKTREE_ROOT="$TMP_ROOT/worktrees"
SESSION="test-session"
BASE_BRANCH="main"
MILL_LOG_FILE="$TMP_ROOT/mill.log"
LAUNCH_FILE="$TMP_ROOT/launches.txt"
ATTENTION_FILE="$TMP_ROOT/attention.txt"
LIFECYCLE_FILE="$TMP_ROOT/lifecycle.txt"
mkdir -p "$STATE_DIR" "$WORKTREE_ROOT"

state_mutate() {
  local state_path="$1" filter="$2"
  shift 2
  jq "$@" "$filter" "$state_path" > "$state_path.tmp"
  mv "$state_path.tmp" "$state_path"
}

read_state_value() {
  local default="$1" filter
  shift
  filter="${*: -1}"
  set -- "${@:1:$(($# - 1))}"
  jq -r "$@" "$filter // empty" "$STATE_FILE" 2>/dev/null || printf '%s\n' "$default"
}

get_task_meta() {
  jq -r --arg issue "$1" --arg field "$2" '.tasks[$issue][$field] // empty' "$STATE_FILE"
}

get_linear_issue_id() { printf '%s\n' "$1"; }
ensure_worktree() {
  git -C "$3" worktree add "$2" "$1" >/dev/null
  printf '%s\n' "$2"
}
agent_resolve_model() { printf '%s\n' "$2"; }
agent_resolve_from_model() { printf '%s\n' "codex"; }
write_phase_config() {
  mkdir -p "$1"
  jq -n \
    --arg planner "$2" \
    --arg coder "$3" \
    --arg reviewer "$4" \
    --arg planDepth "$5" \
    --arg codeDepth "$6" \
    --arg reviewMode "$7" \
    '{planning:{model:$planner},coding:{model:$coder},review:{model:$reviewer,mode:$reviewMode},planDepth:$planDepth,codeDepth:$codeDepth}' \
    > "$1/.phase-config.json"
}
write_stage_result_with_history() {
  mkdir -p "$1"
  jq -n --arg stage "$2" --arg status "$3" --arg agent "$4" --arg model "$5" \
    '{stage:$stage,status:$status,agent:$agent,model:$model,notes:""}' \
    > "$1/.$2-result.json"
}
launch_review_phase() {
  printf '%s|%s|%s|%s|%s\n' "$1" "$2" "$4" "$7" "$8" >> "$LAUNCH_FILE"
}
save_task_state() {
  local issue="$1" slug="$2" branch="$3" worktree="$4" pr="${5:-}" status="${6:-}" agent="${7:-}"
  local linear_issue="${8:-$issue}" challenge="${9:-}" challenge_pair="${10:-}" challenge_role="${11:-}" challenge_model="${12:-}"
  local planner_model="${13:-}" coder_model="${14:-}" reviewer_model="${15:-}" plan_depth="${16:-}" code_depth="${17:-}" review_mode="${18:-}"
  local challenge_stage="${19:-}" phase="${20:-}"
  state_mutate "$STATE_FILE" \
    '.tasks[$issue] = ((.tasks[$issue] // {}) + {
      slug:$slug, branch:$branch, worktree:$worktree, pr:$pr, status:(if $status == "" then "active" else $status end),
      agent:$agent, linearIssueId:$linearIssue, challenge:($challenge == "true"), challengePairId:$challengePair,
      challengeRole:$challengeRole, challengeModel:$challengeModel, plannerModel:$plannerModel,
      coderModel:$coderModel, reviewerModel:$reviewerModel, planDepth:$planDepth, codeDepth:$codeDepth,
      reviewMode:$reviewMode, challengeStage:$challengeStage, phase:$phase
    })' \
    --arg issue "$issue" --arg slug "$slug" --arg branch "$branch" --arg worktree "$worktree" \
    --arg pr "$pr" --arg status "$status" --arg agent "$agent" --arg linearIssue "$linear_issue" \
    --arg challenge "$challenge" --arg challengePair "$challenge_pair" --arg challengeRole "$challenge_role" \
    --arg challengeModel "$challenge_model" --arg plannerModel "$planner_model" --arg coderModel "$coder_model" \
    --arg reviewerModel "$reviewer_model" --arg planDepth "$plan_depth" --arg codeDepth "$code_depth" \
    --arg reviewMode "$review_mode" --arg challengeStage "$challenge_stage" --arg phase "$phase"
}
set_window_attention_state() { printf '%s=%s\n' "$1" "$2" >> "$ATTENTION_FILE"; }
log() { :; }
log_warn() { :; }
log_route_lifecycle() { printf '%s\n' "$*" >> "$LIFECYCLE_FILE"; }
_tmux_task_window_target() { return 1; }
_tmux_target_join() { printf '%s:%s\n' "$1" "$2"; }
_tmux_window_target_exists() { return 1; }
safe_remove_task_worktree_and_branch() { rm -rf "$1"; git -C "$REPO_DIR" branch -D "$2" >/dev/null 2>&1 || true; }
cleanup_outcome_is_retain() { return 1; }
reset_retry_count() { :; }
remove_task_state() { state_mutate "$STATE_FILE" 'del(.tasks[$issue])' --arg issue "$1"; }

seed_repo_and_state() {
  git init -q -b main "$REPO_DIR"
  git -C "$REPO_DIR" config user.email test@example.com
  git -C "$REPO_DIR" config user.name Test
  printf 'base\n' > "$REPO_DIR/README.md"
  git -C "$REPO_DIR" add README.md
  git -C "$REPO_DIR" commit -q -m base
  git -C "$REPO_DIR" checkout -q -b task/hok-2811
  printf 'implementation\n' >> "$REPO_DIR/README.md"
  git -C "$REPO_DIR" add README.md
  git -C "$REPO_DIR" commit -q -m implementation

  local primary_feature="$REPO_DIR/features/hok-2811"
  mkdir -p "$primary_feature/ready"
  printf 'plan\n' > "$primary_feature/plan.md"
  : > "$primary_feature/.plan-approved"
  printf '{"stage":"planning","status":"completed","agent":"codex","model":"planner","startedAt":"t","finishedAt":"t","notes":""}\n' > "$primary_feature/.planning-result.json"
  printf '{"stage":"coding","status":"completed","agent":"codex","model":"coder","startedAt":"t","finishedAt":"t","notes":""}\n' > "$primary_feature/.coding-result.json"
  printf '{"stage":"coding","confidence":"high"}\n' > "$primary_feature/.coding-complete"
  printf '{"featureName":"hok-2811","contextPath":"features/hok-2811/selected-task.json"}\n' > "$primary_feature/selected-task.json"
  printf '{"schemaVersion":1,"pairId":"HOK-2811","issueId":"HOK-2811","selectedStage":"review","primary":{"role":"primary"},"challenger":{"role":"challenger"}}\n' > "$primary_feature/.challenge-intent.json"
  cp "$primary_feature/.challenge-intent.json" "$primary_feature/challenge-intent.json"
  printf 'drop\n' > "$primary_feature/.review-result.json"
  printf 'drop\n' > "$primary_feature/.ready-result.json"
  printf 'drop\n' > "$primary_feature/.trace-context.json"
  printf 'drop\n' > "$primary_feature/trace.jsonl"

  cat > "$STATE_FILE" <<JSON
{"tasks":{"HOK-2811":{"slug":"hok-2811","branch":"task/hok-2811","worktree":"$REPO_DIR","challenge":true,"challengePairId":"HOK-2811","challengeRole":"primary","challengeStage":"review","challengeExecutionIntent":$(cat "$primary_feature/.challenge-intent.json"),"arms":[{"role":"primary","key":"HOK-2811","slug":"hok-2811","branch":"task/hok-2811","challengeArmState":"live"},{"role":"challenger","key":"HOK-2811_c","slug":"hok-2811-challenger","branch":"task/hok-2811-challenger","challengeArmState":"awaiting_fork","variedStage":"review","challengeModel":"reviewer-b","models":{"planner":"planner","coder":"coder","reviewer":"reviewer-b","plannerAgent":"codex","coderAgent":"codex","reviewerAgent":"codex","planDepth":"light","codeDepth":"medium","reviewMode":"llm"}}]}}}
JSON
}

echo "=== Deferred Reviewer Challenge Tests ==="

cat > "$STATE_FILE" <<'JSON'
{"tasks":{"HOK-1":{}}}
JSON
challenge_write_review_deferred_arms "HOK-1" "hok-1" "review" "reviewer-a" "reviewer-b" \
  "planner" "coder" "reviewer-a" "codex" "codex" "codex" "light" "medium" "llm" \
  "HOK-1_c" "hok-1-challenger" "planner" "coder" "reviewer-b" "codex" "codex" "codex" "light" "medium" "llm"
if [[ "$(jq -r '.tasks["HOK-1"].arms[1].challengeArmState' "$STATE_FILE")" == "awaiting_fork" ]] \
  && [[ "$(jq -r '.tasks["HOK-1"].arms[1].models.reviewer' "$STATE_FILE")" == "reviewer-b" ]]; then
  pass "review-stage launch writes deferred challenger arm"
else
  fail "deferred challenger arm was not persisted"
fi

seed_repo_and_state
fork_commit="$(git -C "$REPO_DIR" rev-parse HEAD)"
challenge_materialize_challenger_arm "HOK-2811" "hok-2811" "$REPO_DIR/features/hok-2811" "$REPO_DIR" "Reviewer fork"
challenger_dir="$WORKTREE_ROOT/hok-2811-challenger"
challenger_feature="$challenger_dir/features/hok-2811-challenger"
if [[ "$(git -C "$REPO_DIR" rev-parse task/hok-2811-challenger)" == "$fork_commit" ]] \
  && [[ -f "$challenger_feature/plan.md" ]] \
  && [[ "$(jq -r '.status' "$challenger_feature/.review-result.json")" == "running" ]] \
  && [[ ! -f "$challenger_feature/.ready-result.json" ]] \
  && [[ "$(jq -r '.source' "$challenger_feature/.coding-result.json")" == "inherited" ]] \
  && [[ "$(jq -r '.source' "$challenger_feature/.coding-complete")" == "inherited" ]] \
  && [[ "$(jq -r '.featureName' "$challenger_feature/selected-task.json")" == "hok-2811-challenger" ]] \
  && [[ "$(jq -r '.forkStage' "$challenger_feature/.challenge-intent.json")" == "review" ]] \
  && [[ "$(jq -r '.tasks["HOK-2811_c"].challengeRole' "$STATE_FILE")" == "challenger" ]] \
  && [[ "$(jq -r '.tasks["HOK-2811_c"].phase' "$STATE_FILE")" == "review" ]] \
  && [[ "$(jq -r '.tasks["HOK-2811"].arms[1].challengeArmState' "$STATE_FILE")" == "materialized" ]] \
  && [[ "$(jq -r '.tasks["HOK-2811"].challengerLaunched' "$STATE_FILE")" == "true" ]] \
  && grep -q '^HOK-2811_c|hok-2811-challenger|' "$LAUNCH_FILE"; then
  pass "materializer forks from coding head and launches challenger review"
else
  fail "materializer side effects were incomplete"
fi

launch_count="$(wc -l < "$LAUNCH_FILE" | tr -d ' ')"
challenge_maybe_materialize_deferred_arm "HOK-2811" "hok-2811" "$REPO_DIR/features/hok-2811" "$REPO_DIR" "Reviewer fork"
if [[ "$(wc -l < "$LAUNCH_FILE" | tr -d ' ')" == "$launch_count" ]]; then
  pass "materialization trigger is idempotent after success"
else
  fail "materialization trigger relaunched after success"
fi

cat > "$STATE_FILE" <<'JSON'
{"tasks":{"HOK-2":{"challenge":true,"challengePairId":"HOK-2","challengeRole":"primary","arms":[{"role":"challenger","key":"HOK-2_c","slug":"hok-2-challenger","branch":"task/hok-2-challenger","challengeArmState":"awaiting_fork"}]}}}
JSON
challenge_cancel_challenger_arm "HOK-2" "hok-2" "" "$TMP_ROOT/feature" "review" "reviewer" "collapse" "collapsed before fork"
if [[ "$(jq -r '.tasks["HOK-2"].arms // empty' "$STATE_FILE")" == "" ]] \
  && [[ "$(jq -r '.tasks["HOK-2"].challenge' "$STATE_FILE")" == "false" ]]; then
  pass "cancel clears deferred arm without live challenger row"
else
  fail "cancel did not clear deferred arm"
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
if (( FAIL > 0 )); then
  exit 1
fi
