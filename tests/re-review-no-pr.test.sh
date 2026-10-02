#!/usr/bin/env bash
# HOK-3146 Phase 3: `re-review HOK-ID` must accept a task with commits but no
# PR (coding complete, review was interrupted before PR creation). The relaunch
# runs the normal review phase, which opens the PR as part of its flow.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT="$REPO_DIR/shared/lib/wavemill-monitor.sh"
COMMON_SCRIPT="$REPO_DIR/shared/lib/wavemill-common.sh"
BOUNDED_RETRY="$REPO_DIR/shared/lib/bounded-retry.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

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
    $0 ~ "^" name "\\(\\)[[:space:]]*\\{" { capture = 1; depth = 0 }
    capture {
      print
      depth += brace_delta($0)
      if (depth == 0) exit
    }
  ' "$MONITOR_SCRIPT"
}

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }
assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then pass "$label"; else fail "$label (expected '$expected', got '$actual')"; fi
}
assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then pass "$label"; else fail "$label (missing '$needle')"; fi
}

FUNCS_FILE="$TMP_DIR/handle-re-review.sh"
: > "$FUNCS_FILE"
for fn in handle_re_review_command; do
  extract_function "$fn" >> "$FUNCS_FILE"
  printf '\n' >> "$FUNCS_FILE"
done

source "$COMMON_SCRIPT"
source "$BOUNDED_RETRY"
source "$SCRIPT_DIR/../shared/lib/task-identity.sh"
source "$FUNCS_FILE"

# Fixture: branch with 2 commits over base, .coding-complete present, no PR.
CASE_DIR="$TMP_DIR/case"
REPO="$CASE_DIR/repo"
WT="$CASE_DIR/wt"
mkdir -p "$REPO" "$WT"
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=t@x GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=t@x
git -C "$WT" init -q -b main
git -C "$WT" commit --allow-empty -q -m "base"
BASE_SHA="$(git -C "$WT" rev-parse HEAD)"
git -C "$WT" checkout -q -b task/slug
printf 'x\n' > "$WT/a.txt"
git -C "$WT" add a.txt && git -C "$WT" commit -q -m "work 1"
printf 'y\n' >> "$WT/a.txt"
git -C "$WT" add a.txt && git -C "$WT" commit -q -m "work 2"

FEATURE_DIR="$WT/features/slug"
mkdir -p "$FEATURE_DIR"
printf '{"stage":"coding","confidence":"high"}\n' > "$FEATURE_DIR/.coding-complete"

STATE_FILE="$CASE_DIR/state.json"
cat > "$STATE_FILE" <<EOF
{"tasks":{"HOK-31461":{"phase":"review","slug":"slug","worktree":"$WT","branch":"task/slug","title":"re-review scenario","agent":"codex","model":"gpt-6-sol","baseBranch":"main"}}}
EOF
LOGS="$CASE_DIR/logs.txt"
: > "$LOGS"
LAUNCH_LOG="$CASE_DIR/launches.txt"
: > "$LAUNCH_LOG"

export SESSION="test-session"
export REPO_DIR="$REPO"
export BASE_BRANCH="main"
log() { echo "$2" >> "$LOGS"; }
log_warn() { echo "warn:$1" >> "$LOGS"; }
log_task() { :; }

read_state_value() {
  local default="$1"
  shift
  local value
  if [[ ! -r "$STATE_FILE" || ! -s "$STATE_FILE" ]]; then
    printf '%s\n' "$default"
    return 0
  fi
  if value=$(jq -r "$@" "$STATE_FILE" 2>/dev/null); then
    printf '%s\n' "$value"
  else
    printf '%s\n' "$default"
  fi
}
resolve_phase() { echo "review"; }
read_stage_status() {
  local fd="$1" stage="$2"
  if [[ -f "$fd/.${stage}-result.json" ]]; then
    jq -r '.status // empty' "$fd/.${stage}-result.json" 2>/dev/null || echo ""
  fi
}
effective_task_base_branch() { echo "main"; }
find_pr_for_branch() { echo ""; }
pr_state() { echo ""; }
get_main_head_sha() {
  git -C "$1" rev-parse "$2" 2>/dev/null || true
}
clear_stage_result() { rm -f "$1/.${2}-result.json" 2>/dev/null || true; }
set_task_phase() { echo "set_task_phase:$2" >> "$LOGS"; }
write_stage_result() {
  local fd="$1" stage="$2" status="$3"
  mkdir -p "$fd"
  printf '{"stage":"%s","status":"%s"}\n' "$stage" "$status" > "$fd/.${stage}-result.json"
}
read_phase_config() { echo "static"; }
check_stage_aborted() { return 1; }
write_ready_attention_file() { printf '%s\n' "${2:-}" > "$1/.needs-attention"; }
MONITOR_COMMAND_STATUS="noop"
MONITOR_COMMAND_DEFER_EVENT=""
MONITOR_COMMAND_DEFER_REASON=""

_run_phase_launch() {
  # phase name is $1; rest is the launch command and args
  local phase="$1"; shift
  echo "launched:phase=$phase cmd=$*" >> "$LAUNCH_LOG"
  "$@"
}
launch_review_phase() {
  echo "launch_review_phase:issue=$1 model=$7 agent=$8 mode=$9" >> "$LAUNCH_LOG"
  return 0
}
review_recovery_coordinator() {
  echo "review_recovery_coordinator:issue=$1 pr=$7" >> "$LAUNCH_LOG"
  return 0
}

echo "=== HOK-3146 Phase 3: re-review with commits but no PR ==="

handle_re_review_command "re-review HOK-31461" 1
assert_eq "command status handled" "handled" "$MONITOR_COMMAND_STATUS"
assert_contains "normal launch invoked (no PR path)" "$(cat "$LAUNCH_LOG")" "launch_review_phase:issue=HOK-31461"
if grep -q "review_recovery_coordinator" "$LAUNCH_LOG"; then
  fail "recovery coordinator should not be used for no-PR path"
else
  pass "recovery coordinator not used for no-PR path"
fi
if grep -q "no open PR" "$LOGS"; then
  fail "no-open-PR warning not emitted"
else
  pass "no-open-PR warning not emitted when commits exist"
fi

echo ""
echo "=== HOK-3146 Phase 3: re-review with no commits still fails ==="

# Rebuild case without commits: fresh branch pointing to base
rm -rf "$CASE_DIR"
mkdir -p "$CASE_DIR"
REPO="$CASE_DIR/repo"
WT="$CASE_DIR/wt"
mkdir -p "$REPO" "$WT"
git -C "$WT" init -q -b main
git -C "$WT" commit --allow-empty -q -m "base"
git -C "$WT" checkout -q -b task/slug
FEATURE_DIR="$WT/features/slug"
mkdir -p "$FEATURE_DIR"
# No .coding-complete; no new commits
STATE_FILE="$CASE_DIR/state.json"
cat > "$STATE_FILE" <<EOF
{"tasks":{"HOK-31462":{"phase":"review","slug":"slug","worktree":"$WT","branch":"task/slug","title":"no commits scenario","agent":"codex","model":"gpt-6-sol","baseBranch":"main"}}}
EOF
export REPO_DIR="$REPO"
LOGS="$CASE_DIR/logs.txt"
: > "$LOGS"
LAUNCH_LOG="$CASE_DIR/launches.txt"
: > "$LAUNCH_LOG"
MONITOR_COMMAND_STATUS="noop"

handle_re_review_command "re-review HOK-31462" 1
assert_eq "no-commits path still returns invalid" "invalid" "$MONITOR_COMMAND_STATUS"
assert_contains "no-commits path warns about missing coding completion" \
  "$(cat "$LOGS")" "coding not committed"
if grep -q "launch_review_phase" "$LAUNCH_LOG"; then
  fail "no launch when coding was not committed"
else
  pass "no launch when coding was not committed"
fi

echo ""
echo "=== Totals ==="
echo "pass=$PASS fail=$FAIL"
exit "$FAIL"
