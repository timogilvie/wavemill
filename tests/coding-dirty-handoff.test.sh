#!/usr/bin/env bash
# Regression coverage for HOK-3128: a coding arm that writes `.coding-complete`
# but leaves uncommitted output after its agent exits must not park at
# needs-user forever.
#
# Background: guard_coding_complete_handoff used to set needs-user on every
# tick with no liveness check, no retry and no terminal state. After the agent
# exited nobody would ever clean the tree, and a parked challenger held its
# primary's green PR at `challenge:pair-unresolved:no-comparison` indefinitely
# (HOK-3121_c, 2026-09-30). The guard now consults the task-progress primitive;
# once the agent has exited it quarantines safe scratch residue, relaunches the
# coder once per head (bounded-retry bucket `coding-dirty-handoff`), and on
# exhaustion aborts a challenger (single scope) or records a sentinel for a
# primary. While the agent is live, the legacy needs-user hold is unchanged.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"
REAL_REPO_DIR="$REPO_DIR"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

# Brace-depth-aware extraction so functions with nested braces survive intact.
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

# Real shared helpers: bounded-retry.sh, the uncommitted-output artifact paths,
# portable mtime, base-compare ref.
# shellcheck source=../shared/lib/wavemill-common.sh
source "$REPO_DIR/shared/lib/wavemill-common.sh"

for fn in \
  coding_output_dirty_paths \
  wavemill_owned_feature_artifact_path \
  wavemill_owned_dirty_path \
  blocked_completion_auto_allowed_dirty_path \
  coding_uncommitted_output_announce_marker \
  coding_uncommitted_output_should_announce \
  mark_coding_uncommitted_output_announced \
  clear_coding_uncommitted_output_attention \
  coding_compare_commit_counts \
  write_coding_uncommitted_output_artifact \
  archive_stale_coding_artifacts \
  coding_recovery_instruction_path \
  coding_dirty_handoff_grace_seconds \
  coding_dirty_handoff_agent_exited \
  coding_dirty_handoff_path_is_planned \
  coding_dirty_handoff_quarantine_scratch \
  coding_dirty_handoff_write_recovery_instruction \
  coding_dirty_handoff_relaunch \
  coding_dirty_handoff_terminalize \
  guard_coding_complete_handoff \
  challenge_abort_pair \
  _challenge_side_for_issue \
  native_terminal_failure_next_action \
  challenger_transient_retry_result_head \
  challenger_transient_retry_intent_json \
  resolve_challenger_transient_retry_launch_intent \
  challenge_result_stage_for_launch \
  challenge_stage_for_launch_env \
; do
  extracted="$(extract_function "$fn")"
  if [[ -z "$extracted" ]]; then
    echo "Could not extract $fn() from $MONITOR_SCRIPT_FILE" >&2
    exit 1
  fi
  eval "$extracted"
done

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"; rm -f /tmp/wavemill-dirtyhandoff-*.hook 2>/dev/null || true' EXIT

SESSION="dirtyhandoff"
STATE_FILE="$TMP_ROOT/state.json"
ATTENTION_FILE="$TMP_ROOT/attention.txt"
WARN_FILE="$TMP_ROOT/warn.txt"
STATUS_LOG="$TMP_ROOT/status.txt"
WORKTREE_ROOT="$TMP_ROOT/worktrees"
BASE_BRANCH="main"
REPO_DIR="$TMP_ROOT/no-repo"
mkdir -p "$WORKTREE_ROOT" "$REPO_DIR"
git -C "$REPO_DIR" init -q
active_count=0
current_agent=""
PROGRESS_JSON='{}'
PROGRESS_CALLS=0
CLEANUP_CALLS=""
PREPARE_CALLS=""
LAUNCH_CALLS=""
VALIDATE_CALLS=""
LAUNCH_RC=0

log() { shift; printf '%s\n' "$*" >> "$STATUS_LOG"; }
log_warn() { printf '%s\n' "$1" >> "$WARN_FILE"; }
log_error() { printf '%s\n' "$1" >> "$WARN_FILE"; }
set_window_attention_state() { printf '%s=%s\n' "$1" "$2" >> "$ATTENTION_FILE"; }
state_mutate() {
  local state_path="$1" filter="$2"
  shift 2
  jq "$@" "$filter" "$state_path" > "$state_path.tmp"
  mv "$state_path.tmp" "$state_path"
}
get_task_meta() {
  jq -r --arg issue "$1" --arg field "$2" '.tasks[$issue][$field] // empty' "$STATE_FILE"
}
read_state_value() {
  local default="$1"
  shift
  jq -r "$@" "$STATE_FILE" 2>/dev/null || printf '%s\n' "$default"
}
# HOK-3101 primitive stub: the scenario sets PROGRESS_JSON.
task_progress_json() {
  PROGRESS_CALLS=$((PROGRESS_CALLS + 1))
  printf '%s\n' "$PROGRESS_JSON"
}
stage_result_field() {
  jq -r --arg f "$3" '.[$f] // empty' "$1/.${2}-result.json" 2>/dev/null || true
}
write_stage_result() {
  local feature_dir="$1" stage="$2" status="$3" agent="${4:-}" model="${5:-}" notes="${6:-}"
  mkdir -p "$feature_dir"
  jq -n --arg stage "$stage" --arg status "$status" --arg agent "$agent" --arg model "$model" --arg notes "$notes" \
    '{stage:$stage,status:$status,agent:$agent,model:$model,notes:$notes}' > "$feature_dir/.${stage}-result.json"
}
resolve_stage_result_model() { stage_result_field "$1" "$2" model; }
read_phase_config() { printf ''; }
resolve_phase_model() { printf '%s\n' "${2:-$3}"; }
agent_resolve_from_model() { printf 'claude\n'; }
agent_validate_phase_launch() {
  VALIDATE_CALLS+="$1|$2|$3"$'\n'
  return 0
}
_prepare_recovery_phase_launch() {
  PREPARE_CALLS+="$1|$3|$6|$7"$'\n'
  write_stage_result "$4" "$3" "running" "$6" "$7" "Recovery replay of persisted execution contract"
  return 0
}
launch_coding_phase() {
  LAUNCH_CALLS+="coding|$1|$7|$8|$9"$'\n'
  return "$LAUNCH_RC"
}
cleanup_quarantined_no_pr_challenge_arm() {
  CLEANUP_CALLS+="$1|$3|$4"$'\n'
  return 0
}

real_challenge_intent() {
  npx tsx "$REAL_REPO_DIR/tests/fixtures/build-challenge-intent.ts" "$@"
}

CHALLENGE_INTENT="$(real_challenge_intent --stage implementation --pair-id PAIR-7 --slug pair-seven-challenger \
  --primary-coder claude-opus-4-7 --primary-coder-agent claude \
  --challenger-coder qwen-3-coder --challenger-coder-agent native-openrouter)"

# seed <issue> <slug>: a challenge pair (PAIR-7 / PAIR-7_c) with the arm under
# test carrying slug/worktree/branch, plus a git worktree whose task branch is
# one commit ahead of main, a plan, and a fresh .coding-complete marker.
seed() {
  local issue="$1" slug="$2"
  local wt="$WORKTREE_ROOT/$slug" fd

  jq -n --arg issue "$issue" --arg slug "$slug" --arg wt "$wt" --argjson intent "$CHALLENGE_INTENT" \
    '{tasks:{
       "PAIR-7":   {challengePairId:"PAIR-7", challengeRole:"primary",    challenge:true, challengeExecutionIntent:$intent, challengeStage:"implementation"},
       "PAIR-7_c": {challengePairId:"PAIR-7", challengeRole:"challenger", challenge:true, challengeExecutionIntent:$intent, challengeStage:"implementation"}
     }}
     | .tasks[$issue] += {slug:$slug, worktree:$wt, branch:("task/" + $slug), title:"Dirty handoff fixture"}' \
    > "$STATE_FILE"

  rm -rf "$wt"
  mkdir -p "$wt"
  git -C "$wt" init -q
  git -C "$wt" config user.email tests@example.com
  git -C "$wt" config user.name "Wavemill Tests"
  git -C "$wt" checkout -q -b main
  printf 'initial\n' > "$wt/README.md"
  mkdir -p "$wt/src"
  printf 'export const a = 1;\n' > "$wt/src/feature.ts"
  git -C "$wt" add README.md src/feature.ts
  git -C "$wt" commit -q -m "Initial commit"
  git -C "$wt" checkout -q -b "task/$slug"
  printf 'export const a = 2;\n' > "$wt/src/feature.ts"
  git -C "$wt" commit -qam "Implement feature"

  fd="$wt/features/$slug"
  mkdir -p "$fd"
  printf '# Plan\n\nTouch src/feature.ts and tests/feature.test.ts.\n' > "$fd/plan.md"
  printf '{"stage":"coding","confidence":"high"}\n' > "$fd/.coding-complete"
  write_stage_result "$fd" "coding" "running" "native" "qwen-3-coder" ""

  printf '{"state":"idle","event":"process_exit","agent":"native","timestamp":1,"writer":"agent"}\n' \
    > "/tmp/wavemill-${SESSION}-${issue}.hook"

  : > "$ATTENTION_FILE"
  : > "$WARN_FILE"
  : > "$STATUS_LOG"
  active_count=0
  PROGRESS_CALLS=0
  CLEANUP_CALLS=""
  PREPARE_CALLS=""
  LAUNCH_CALLS=""
  VALIDATE_CALLS=""
  LAUNCH_RC=0
}

exited_progress() {
  local age="${1:-600}" now
  now="$(date +%s)"
  jq -cn --argjson ts "$((now - age))" --argjson mins "$((age / 60))" \
    '{agentIdle:true, terminal:false, terminalIdle:false, agentState:null, blockingPrompt:null,
      agentRecord:{state:"idle", event:"process_exit", agent:"native", timestamp:$ts},
      lastProgressAt:null, progressAgeMinutes:$mins, stalled:false}'
}
live_progress() {
  jq -cn --argjson ts "$(date +%s)" \
    '{agentIdle:false, terminal:false, terminalIdle:false, agentState:"working", blockingPrompt:null,
      agentRecord:{state:"working", event:"PreToolUse", agent:"native", timestamp:$ts},
      lastProgressAt:null, progressAgeMinutes:0, stalled:false}'
}

# Runs in the current shell (not a command substitution) so the stubs' call
# captures survive; the guard's exit status lands in $rc.
run_guard() {
  local issue="$1" slug="$2"
  rc=0
  guard_coding_complete_handoff "$issue" "$WORKTREE_ROOT/$slug/features/$slug" "$WORKTREE_ROOT/$slug" "$BASE_BRANCH" || rc=$?
}

retry_files() { find "$1" -maxdepth 1 -name '.retry-coding-dirty-handoff-*' 2>/dev/null | sort; }

echo "=== Coding dirty-tree handoff after agent exit (HOK-3128) ==="

# ── 1. Live agent + dirty tree → today's needs-user hold, no retry state ──
seed "PAIR-7_c" "live-agent"
fd="$WORKTREE_ROOT/live-agent/features/live-agent"
printf 'wip\n' >> "$WORKTREE_ROOT/live-agent/src/feature.ts"
PROGRESS_JSON="$(live_progress)"
run_guard "PAIR-7_c" "live-agent"
if [[ "$rc" == "0" ]] \
  && grep -q 'PAIR-7_c-live-agent=needs-user' "$ATTENTION_FILE" \
  && [[ -z "$LAUNCH_CALLS" ]] \
  && [[ -z "$(retry_files "$fd")" ]] \
  && [[ -f "$fd/.coding-complete" ]] \
  && [[ -f "$fd/.coding-uncommitted-output.json" ]] \
  && [[ "$(jq -r '.tasks["PAIR-7_c"].challengeAborted // "none"' "$STATE_FILE")" == "none" ]] \
  && [[ "$(stage_result_field "$fd" coding status)" == "running" ]]; then
  pass "live agent keeps the legacy needs-user hold (no relaunch, no retry files, no abort)"
else
  fail "live agent handling wrong (rc=$rc launches=$LAUNCH_CALLS retry=$(retry_files "$fd"))"
fi

# ── 2. Agent exited but inside the grace → still the legacy hold ──────────
seed "PAIR-7_c" "inside-grace"
fd="$WORKTREE_ROOT/inside-grace/features/inside-grace"
printf 'wip\n' >> "$WORKTREE_ROOT/inside-grace/src/feature.ts"
PROGRESS_JSON="$(exited_progress 30)"
run_guard "PAIR-7_c" "inside-grace"
if [[ "$rc" == "0" ]] \
  && grep -q '=needs-user' "$ATTENTION_FILE" \
  && [[ -z "$LAUNCH_CALLS" ]] \
  && [[ -z "$(retry_files "$fd")" ]]; then
  pass "an idle record younger than the grace does not relaunch"
else
  fail "inside-grace handling wrong (rc=$rc launches=$LAUNCH_CALLS)"
fi

# ── 3. Probe failure ({}) is treated as live ─────────────────────────────
seed "PAIR-7_c" "probe-failure"
fd="$WORKTREE_ROOT/probe-failure/features/probe-failure"
printf 'wip\n' >> "$WORKTREE_ROOT/probe-failure/src/feature.ts"
PROGRESS_JSON='{}'
run_guard "PAIR-7_c" "probe-failure"
if [[ "$rc" == "0" ]] && [[ -z "$LAUNCH_CALLS" ]] && [[ -z "$(retry_files "$fd")" ]] \
  && grep -q '=needs-user' "$ATTENTION_FILE"; then
  pass "missing progress evidence keeps the legacy hold"
else
  fail "probe-failure handling wrong (rc=$rc launches=$LAUNCH_CALLS)"
fi

# ── 4. Only unplanned root scratch → quarantined, handoff advances ───────
seed "PAIR-7_c" "scratch-only"
wt="$WORKTREE_ROOT/scratch-only"
fd="$wt/features/scratch-only"
printf 'console.log(1)\n' > "$wt/test-simple.ts"
PROGRESS_JSON="$(exited_progress)"
run_guard "PAIR-7_c" "scratch-only"
if [[ "$rc" == "1" ]] \
  && [[ ! -e "$wt/test-simple.ts" ]] \
  && ls "$fd"/.stale-artifacts/dirty-handoff-*/test-simple.ts >/dev/null 2>&1 \
  && [[ -z "$(git -C "$wt" status --porcelain --untracked-files=all -- ':!features')" ]] \
  && [[ ! -f "$fd/.coding-uncommitted-output.json" ]] \
  && [[ -z "$LAUNCH_CALLS" ]] \
  && [[ -z "$(retry_files "$fd")" ]] \
  && grep -q 'quarantined scratch residue test-simple.ts' "$STATUS_LOG"; then
  pass "unplanned root scratch is moved (not deleted) and the handoff advances"
else
  fail "scratch quarantine wrong (rc=$rc launches=$LAUNCH_CALLS)"
fi

# ── 5. Scratch named in the plan is never auto-cleaned ────────────────────
seed "PAIR-7_c" "planned-scratch"
wt="$WORKTREE_ROOT/planned-scratch"
fd="$wt/features/planned-scratch"
printf '\nAlso add scratch.ts at the repo root.\n' >> "$fd/plan.md"
printf 'x\n' > "$wt/scratch.ts"
PROGRESS_JSON="$(exited_progress)"
run_guard "PAIR-7_c" "planned-scratch"
if [[ "$rc" == "0" ]] && [[ -f "$wt/scratch.ts" ]] \
  && [[ "$LAUNCH_CALLS" == *"coding|PAIR-7_c|"* ]]; then
  pass "a planned root file is left in place and goes through the relaunch path"
else
  fail "planned scratch handling wrong (rc=$rc launches=$LAUNCH_CALLS)"
fi

# ── 6. Challenger, modified tracked file: relaunch once, then abort ───────
seed "PAIR-7_c" "challenger-dirty"
wt="$WORKTREE_ROOT/challenger-dirty"
fd="$wt/features/challenger-dirty"
printf 'wip\n' >> "$wt/src/feature.ts"
printf 'x\n' > "$wt/test-simple.ts"
mkdir -p "$wt/tests"
printf 'test\n' > "$wt/tests/feature-purge.test.ts"
PROGRESS_JSON="$(exited_progress)"
run_guard "PAIR-7_c" "challenger-dirty"
head="$(git -C "$wt" rev-parse HEAD)"
instruction="$fd/.coding-recovery-instruction.md"
if [[ "$rc" == "0" ]] \
  && [[ "$active_count" == "1" ]] \
  && [[ "$LAUNCH_CALLS" == "coding|PAIR-7_c|qwen-3-coder|native-openrouter|medium"$'\n' ]] \
  && [[ "$VALIDATE_CALLS" == *"native-openrouter|coding|qwen-3-coder"* ]] \
  && [[ "$PREPARE_CALLS" == *"PAIR-7_c|coding|native-openrouter|qwen-3-coder"* ]] \
  && [[ ! -f "$fd/.coding-complete" ]] \
  && ls "$fd"/.stale-artifacts/coding-*/.coding-complete >/dev/null 2>&1 \
  && [[ -f "$instruction" ]] \
  && grep -q 'src/feature.ts' "$instruction" \
  && grep -q 'tests/feature-purge.test.ts' "$instruction" \
  && ! grep -q 'test-simple.ts' "$instruction" \
  && [[ ! -e "$wt/test-simple.ts" ]] \
  && [[ ! -f "/tmp/wavemill-${SESSION}-PAIR-7_c.hook" ]] \
  && [[ "$(bounded_retry_count "$fd" coding-dirty-handoff)" == "1" ]] \
  && [[ "$(bounded_retry_head "$fd" coding-dirty-handoff)" == "$head" ]] \
  && grep -q 'PAIR-7_c-challenger-dirty=clear' "$ATTENTION_FILE" \
  && grep -q 'coding-dirty-handoff relaunch (agent exited with 2 dirty path(s)' "$STATUS_LOG" \
  && [[ "$(jq -r '.tasks["PAIR-7_c"].challengeAborted // "none"' "$STATE_FILE")" == "none" ]]; then
  pass "tick 1: exited challenger is relaunched once with the recovery instruction"
else
  fail "tick 1 relaunch wrong (rc=$rc launches=$LAUNCH_CALLS prepare=$PREPARE_CALLS count=$(bounded_retry_count "$fd" coding-dirty-handoff))"
fi

# Tick 2: the relaunched agent re-writes .coding-complete and exits again at
# the same head, still dirty → exhausted → challenger aborted, primary spared.
printf '{"stage":"coding","confidence":"high"}\n' > "$fd/.coding-complete"
LAUNCH_CALLS=""
: > "$ATTENTION_FILE"
active_count=0
run_guard "PAIR-7_c" "challenger-dirty"
sentinel="$fd/.retry-coding-dirty-handoff-exhausted"
if [[ "$rc" == "0" ]] \
  && [[ -z "$LAUNCH_CALLS" ]] \
  && [[ "$(jq -r '.tasks["PAIR-7_c"].challengeAborted' "$STATE_FILE")" == "terminal_stage_failure:coding-dirty-handoff" ]] \
  && [[ "$(jq -r '.tasks["PAIR-7"].challengeAborted // "none"' "$STATE_FILE")" == "none" ]] \
  && [[ "$(jq -r '.challengePairAbortions["PAIR-7"].challenger.scope' "$STATE_FILE")" == "single" ]] \
  && [[ "$(jq -r '.tasks["PAIR-7_c"].challengeAbortedStage' "$STATE_FILE")" == "implementation" ]] \
  && [[ -f "$sentinel" ]] \
  && grep -q "dirty-handoff relaunch exhausted after 1 attempt(s) at head $head" "$sentinel" \
  && grep -q 'src/feature.ts' "$sentinel" \
  && [[ "$(stage_result_field "$fd" coding status)" == "failed" ]] \
  && [[ "$CLEANUP_CALLS" == *"PAIR-7_c|coding|terminal_stage_failure:coding-dirty-handoff"* ]] \
  && [[ "$(jq -r '.reason' "$fd/.challenge-aborted.json")" == "terminal_stage_failure:coding-dirty-handoff" ]] \
  && grep -q 'challenger quarantined, primary released' "$WARN_FILE"; then
  pass "tick 2: exhausted challenger is aborted (single scope) with a recorded sentinel"
else
  fail "tick 2 terminalization wrong (rc=$rc aborted=$(jq -r '.tasks["PAIR-7_c"].challengeAborted // "none"' "$STATE_FILE") cleanup=$CLEANUP_CALLS)"
fi

# Tick 3: already terminal → quiet hold, never re-marked running/needs-user.
printf '{"stage":"coding","confidence":"high"}\n' > "$fd/.coding-complete"
: > "$ATTENTION_FILE"
run_guard "PAIR-7_c" "challenger-dirty"
if [[ "$rc" == "0" ]] && [[ -z "$LAUNCH_CALLS" ]] \
  && [[ "$(stage_result_field "$fd" coding status)" == "failed" ]] \
  && ! grep -q 'needs-user' "$ATTENTION_FILE"; then
  pass "tick 3: an aborted challenger is not re-marked running or needs-user"
else
  fail "tick 3 quiet hold wrong (rc=$rc status=$(stage_result_field "$fd" coding status))"
fi

# ── 7. Primary: relaunch once, then stay needs-user with a sentinel ──────
seed "PAIR-7" "primary-dirty"
wt="$WORKTREE_ROOT/primary-dirty"
fd="$wt/features/primary-dirty"
write_stage_result "$fd" "coding" "running" "claude" "claude-opus-4-7" ""
printf 'wip\n' >> "$wt/src/feature.ts"
PROGRESS_JSON="$(exited_progress)"
run_guard "PAIR-7" "primary-dirty"
if [[ "$rc" == "0" ]] && [[ "$LAUNCH_CALLS" == "coding|PAIR-7|claude-opus-4-7|claude|medium"$'\n' ]]; then
  pass "primary tick 1: relaunched with its own coder identity"
else
  fail "primary tick 1 wrong (rc=$rc launches=$LAUNCH_CALLS)"
fi
printf '{"stage":"coding","confidence":"high"}\n' > "$fd/.coding-complete"
LAUNCH_CALLS=""
: > "$ATTENTION_FILE"
run_guard "PAIR-7" "primary-dirty"
if [[ "$rc" == "0" ]] \
  && [[ -z "$LAUNCH_CALLS" ]] \
  && [[ "$(jq -r '.tasks["PAIR-7"].challengeAborted // "none"' "$STATE_FILE")" == "none" ]] \
  && [[ "$(jq -r '.tasks["PAIR-7_c"].challengeAborted // "none"' "$STATE_FILE")" == "none" ]] \
  && grep -q 'PAIR-7-primary-dirty=needs-user' "$ATTENTION_FILE" \
  && [[ -f "$fd/.retry-coding-dirty-handoff-exhausted" ]] \
  && grep -q 'dirty-handoff relaunch exhausted' "$fd/.retry-coding-dirty-handoff-exhausted" \
  && jq -r '.action' "$fd/.coding-uncommitted-output.json" | grep -q 'retry-coding-dirty-handoff-exhausted' \
  && [[ "$(stage_result_field "$fd" coding status)" == "running" ]] \
  && [[ -z "$CLEANUP_CALLS" ]]; then
  pass "primary tick 2: stays needs-user, never aborted, sentinel + artifact action record the reason"
else
  fail "primary exhaustion wrong (rc=$rc attention=$(cat "$ATTENTION_FILE"))"
fi

# ── 8. New head after exhaustion resets the budget → one more relaunch ───
printf 'more\n' > "$wt/src/second.ts"
git -C "$wt" add src/second.ts
git -C "$wt" commit -qm "Second commit"
printf '{"stage":"coding","confidence":"high"}\n' > "$fd/.coding-complete"
LAUNCH_CALLS=""
run_guard "PAIR-7" "primary-dirty"
if [[ "$rc" == "0" ]] \
  && [[ "$LAUNCH_CALLS" == *"coding|PAIR-7|"* ]] \
  && [[ ! -f "$fd/.retry-coding-dirty-handoff-exhausted" ]] \
  && [[ "$(bounded_retry_count "$fd" coding-dirty-handoff)" == "1" ]] \
  && [[ "$(bounded_retry_head "$fd" coding-dirty-handoff)" == "$(git -C "$wt" rev-parse HEAD)" ]]; then
  pass "a new commit resets the dirty-handoff budget"
else
  fail "new-head reset wrong (rc=$rc launches=$LAUNCH_CALLS)"
fi

# ── 9. Tree clean after relaunch → advance; bucket + instruction cleared ──
git -C "$wt" checkout -q -- src/feature.ts
printf '{"stage":"coding","confidence":"high"}\n' > "$fd/.coding-complete"
[[ -f "$fd/.coding-recovery-instruction.md" ]] || fail "precondition: recovery instruction present before clean tick"
run_guard "PAIR-7" "primary-dirty"
if [[ "$rc" == "1" ]] \
  && [[ -z "$(retry_files "$fd")" ]] \
  && [[ ! -f "$fd/.coding-recovery-instruction.md" ]] \
  && [[ ! -f "$fd/.coding-uncommitted-output.json" ]] \
  && [[ "$(tail -n 1 "$fd/.coding-uncommitted-output.resolved.jsonl" | jq -r '.recoveryInstruction')" == "true" ]]; then
  pass "a clean tree advances and clears the bucket, instruction and live artifact"
else
  fail "clean-tree advance wrong (rc=$rc retry=$(retry_files "$fd"))"
fi

# ── 10. Relaunch failure terminalizes immediately (never stuck holding) ──
seed "PAIR-7_c" "launch-fails"
wt="$WORKTREE_ROOT/launch-fails"
fd="$wt/features/launch-fails"
printf 'wip\n' >> "$wt/src/feature.ts"
PROGRESS_JSON="$(exited_progress)"
LAUNCH_RC=1
run_guard "PAIR-7_c" "launch-fails"
if [[ "$rc" == "0" ]] \
  && [[ "$(jq -r '.tasks["PAIR-7_c"].challengeAborted' "$STATE_FILE")" == "terminal_stage_failure:coding-dirty-handoff" ]] \
  && grep -q 'relaunch failed' "$fd/.retry-coding-dirty-handoff-exhausted"; then
  pass "a failed relaunch terminalizes the challenger instead of holding"
else
  fail "launch-failure handling wrong (rc=$rc)"
fi

# ── 11. Grace env validation ──────────────────────────────────────────────
if [[ "$(WAVEMILL_CODING_DIRTY_HANDOFF_GRACE_SECONDS=abc coding_dirty_handoff_grace_seconds)" == "120" ]] \
  && [[ "$(WAVEMILL_CODING_DIRTY_HANDOFF_GRACE_SECONDS=15 coding_dirty_handoff_grace_seconds)" == "15" ]]; then
  pass "grace override is validated and falls back to 120s"
else
  fail "grace env validation wrong"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
