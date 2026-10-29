#!/usr/bin/env bash
# HOK-3211 regression coverage: plan re-approval must NOT archive a valid
# `.coding-complete` and must NOT relaunch coding when the agent has already
# finished the work in-planning. The fix adds:
#   1. planning_late_coding_complete_reconcile — approves the plan and marks
#      coding completed in-place when the marker is condition-valid (commit
#      matches HEAD, tree clean, HEAD ahead of base, seam-valid).
#   2. archive_stale_coding_artifacts hardening — preserves a condition-valid
#      .coding-complete at the launch gate.
#   3. maybe_retry_failed_stage for stage=coding — relaunches coding directly
#      instead of routing back through planning (which would then invoke the
#      planning overreach guard on the coder's in-flight edits).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

# Brace-depth-aware extraction (same approach as the HOK-3137 and HOK-3176
# tests) so nested function braces are preserved.
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

# shellcheck source=../shared/lib/wavemill-common.sh
source "$REPO_DIR/shared/lib/wavemill-common.sh"
# shellcheck source=../shared/lib/transient-marker.sh
source "$REPO_DIR/shared/lib/transient-marker.sh"
# shellcheck source=../shared/lib/condition-reconciler.sh
source "$REPO_DIR/shared/lib/condition-reconciler.sh"

for fn in \
  phase_launch_head \
  phase_launch_base \
  coding_output_dirty_paths \
  blocked_completion_commit_matches_head \
  blocked_completion_auto_allowed_dirty_path \
  wavemill_owned_feature_artifact_path \
  wavemill_owned_dirty_path \
  seam_validate_artifact \
  seam_artifact_cli_path \
  wavemill_run_tsx_tool \
  recover_misplaced_coding_complete_marker \
  read_stage_status \
  approve_plan \
  read_phase_config \
  stage_result_field \
  planning_late_coding_complete_reconcile \
  archive_stale_coding_artifacts \
  coding_complete_marker_condition_valid \
  maybe_log_planning_wait_coding_present \
  native_hook_terminal_failure_detail \
  native_coding_failure_handoff_reason \
  native_stage_failure_envelope_json \
  stage_failure_decision \
  stage_failure_owned_by_bucket \
  maybe_retry_failed_stage \
  _stage_failure_coding_relaunch \
  recovery_contract_json \
  _challenge_side_for_issue \
  challenge_result_stage_for_launch \
  write_openrouter_warning_cache \
  record_openrouter_credits_challenge_abort \
; do
  extracted="$(extract_function "$fn")"
  if [[ -z "$extracted" ]]; then
    echo "Could not extract $fn() from $MONITOR_SCRIPT_FILE" >&2
    exit 1
  fi
  eval "$extracted"
done

TMP_ROOT="$(mktemp -d)"
SESSION="hok3211$$"
LIB_DIR="$REPO_DIR/shared/lib"
TOOLS_DIR="$REPO_DIR/tools"
BASE_BRANCH="auto/integration"
WAVEMILL_STATE_DIR="$TMP_ROOT/wavemill-state"
STATE_FILE="$TMP_ROOT/state.json"
STATUS_LOG="$TMP_ROOT/status.txt"
WARN_FILE="$TMP_ROOT/warn.txt"
ATTENTION_FILE="$TMP_ROOT/attention.txt"
HOOK_CALLS_FILE="$TMP_ROOT/hook-calls.txt"
LAUNCH_SPY="$TMP_ROOT/launch.txt"
PHASE_LOG="$TMP_ROOT/phase.txt"
mkdir -p "$WAVEMILL_STATE_DIR"

cleanup() {
  rm -rf "$TMP_ROOT"
  rm -f /tmp/wavemill-"${SESSION}"-*.hook 2>/dev/null || true
}
trap cleanup EXIT

: > "$STATUS_LOG"; : > "$WARN_FILE"; : > "$ATTENTION_FILE"; : > "$HOOK_CALLS_FILE"
: > "$LAUNCH_SPY"; : > "$PHASE_LOG"
printf '{"tasks":{}}\n' > "$STATE_FILE"

# resolve_stage_result_model in production reads $ISSUE and the global
# challenge state — stub to the stored stage result's model so the
# reconciler path advances deterministically.
resolve_stage_result_model() {
  local feature_dir="$1" stage="$2" fallback="${3:-}"
  local stored
  stored="$(jq -r '.model // empty' "$feature_dir/.${stage}-result.json" 2>/dev/null || true)"
  if [[ -n "$stored" ]]; then
    printf '%s\n' "$stored"
  else
    printf '%s\n' "$fallback"
  fi
}

# resolve_phase_model's full resolution chain reads global router state;
# stub to the first non-empty of model/fallback so the direct coding
# relaunch path has a deterministic choice.
resolve_phase_model() {
  local phase="$1" model="${2:-}" fallback="${3:-}"
  if [[ -n "$model" ]]; then
    printf '%s\n' "$model"
  else
    printf '%s\n' "$fallback"
  fi
}

log() { shift; printf '%s\n' "$*" >> "$STATUS_LOG"; }
log_warn() { printf '%s\n' "$1" >> "$WARN_FILE"; }
log_error() { printf '%s\n' "$1" >> "$WARN_FILE"; }
set_window_attention_state() { printf '%s=%s\n' "$1" "$2" >> "$ATTENTION_FILE"; }
wavemill_hook_write() { printf '%s\n' "$*" >> "$HOOK_CALLS_FILE"; }
# plan_packet_record_binding is a no-op in tests; approve_plan calls it
# best-effort, so stub it to avoid an unbound-function error.
plan_packet_record_binding() { return 0; }

# quarantine_completed_coding_pane / reap_completed_planning_pane need a
# live tmux session; stub them to a trace so we can assert they ran but
# avoid spawning tmux.
quarantine_completed_coding_pane() { printf 'quarantine=%s\n' "$1" >> "$LAUNCH_SPY"; return 0; }
reap_completed_planning_pane() { printf 'reap=%s\n' "$1" >> "$LAUNCH_SPY"; return 0; }

# Minimal write_stage_result stand-in: same observable contract (fresh
# .${stage}-result.json, startedAt preserved, finishedAt stamped on
# terminal statuses, artifacts optional).
write_stage_result() {
  local feature_dir="$1" stage="$2" status="$3" agent="${4:-}" model="${5:-}" notes="${6:-}" artifacts="${7:-}"
  local result_file="$feature_dir/.${stage}-result.json" started_at="2026-01-01T00:00:00Z" finished_at="null"
  mkdir -p "$feature_dir"
  [[ -f "$result_file" ]] && started_at="$(jq -r '.startedAt // "2026-01-01T00:00:00Z"' "$result_file" 2>/dev/null)"
  if [[ "$status" == "completed" || "$status" == "aborted" || "$status" == "failed" ]]; then
    finished_at="\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\""
  fi
  if [[ -n "$artifacts" ]]; then
    jq -n --arg stage "$stage" --arg status "$status" --arg startedAt "$started_at" --argjson finishedAt "$finished_at" \
      --arg agent "$agent" --arg model "$model" --arg notes "$notes" --argjson artifacts "$artifacts" \
      '{stage:$stage,status:$status,startedAt:$startedAt,finishedAt:$finishedAt,agent:$agent,model:$model,notes:$notes,artifacts:$artifacts}' \
      > "$result_file"
  else
    jq -n --arg stage "$stage" --arg status "$status" --arg startedAt "$started_at" --argjson finishedAt "$finished_at" \
      --arg agent "$agent" --arg model "$model" --arg notes "$notes" \
      '{stage:$stage,status:$status,startedAt:$startedAt,finishedAt:$finishedAt,agent:$agent,model:$model,notes:$notes}' \
      > "$result_file"
  fi
}

# Clear a stage result (used by maybe_retry_failed_stage before the direct
# coding relaunch attempt).
clear_stage_result() { rm -f "$1/.${2}-result.json"; }

# set_task_phase stand-in: records the transition, no state file.
set_task_phase() { printf '%s=%s\n' "$1" "$2" >> "$PHASE_LOG"; }

# get_task_meta reads from $STATE_FILE if the task exists; empty otherwise.
get_task_meta() {
  jq -r --arg i "$1" --arg f "$2" '.tasks[$i][$f] // empty' "$STATE_FILE" 2>/dev/null || true
}

# Launch spy — assert the direct coding relaunch path fires on a retryable
# coding failure without going through the planning overreach guard.
agent_resolve_from_model() {
  AGENT_RESOLVE_LAST_DIAGNOSTIC=""
  printf 'claude\n'
  return 0
}
agent_validate_phase_launch() { return 0; }
_prepare_recovery_phase_launch() {
  printf 'prepare=%s/%s/%s\n' "$1" "$3" "$6" >> "$LAUNCH_SPY"
  return 0
}
launch_coding_phase() {
  printf 'launch_coding_phase=%s %s %s %s\n' "$1" "$2" "$7" "$8" >> "$LAUNCH_SPY"
  return 0
}
# validate_planning_phase_output must NOT fire during a HOK-3211 coding retry.
# A test flag records any call so we can assert it did not happen.
PLANNING_GUARD_CALLED=0
validate_planning_phase_output() {
  PLANNING_GUARD_CALLED=$((PLANNING_GUARD_CALLED + 1))
  return 0
}

seed_worktree() {
  local slug="$1"
  local wt="$TMP_ROOT/$slug"
  local fd
  rm -rf "$wt"
  mkdir -p "$wt"
  git -C "$wt" init -q
  git -C "$wt" config user.email tests@example.com
  git -C "$wt" config user.name "Wavemill Tests"
  git -C "$wt" checkout -q -b main
  printf 'initial\n' > "$wt/README.md"
  git -C "$wt" add README.md
  git -C "$wt" commit -q -m "Initial commit"
  # Pin the merge-base BEFORE adding "task" commits so HEAD is ahead of base.
  git -C "$wt" update-ref "refs/remotes/origin/$BASE_BRANCH" HEAD
  git -C "$wt" checkout -q -b "task/$slug"
  printf 'change-1\n' >> "$wt/README.md"
  git -C "$wt" commit -qam "Task commit 1"
  printf 'change-2\n' >> "$wt/README.md"
  git -C "$wt" commit -qam "Task commit 2"
  fd="$wt/features/$slug"
  mkdir -p "$fd"
  printf '%s\n' "$fd"
}

write_marker() {
  local feature_dir="$1" commit="${2:-}"
  if [[ -n "$commit" ]]; then
    jq -n --arg commit "$commit" '{stage:"coding", confidence:"high", commit:$commit}' > "$feature_dir/.coding-complete"
  else
    printf '{"stage":"coding","confidence":"high"}\n' > "$feature_dir/.coding-complete"
  fi
}

write_planning_awaiting_user() {
  local feature_dir="$1"
  jq -n '{stage:"planning", status:"awaiting_user", startedAt:"2026-01-01T00:00:00Z", agent:"claude", model:"claude-opus-4-7", notes:"Plan ready for review"}' \
    > "$feature_dir/.planning-result.json"
}

reset_state() {
  : > "$STATUS_LOG"; : > "$WARN_FILE"; : > "$ATTENTION_FILE"; : > "$HOOK_CALLS_FILE"
  : > "$LAUNCH_SPY"; : > "$PHASE_LOG"
  PLANNING_GUARD_CALLED=0
}

echo "=== HOK-3211 plan re-approval + late .coding-complete reconciliation ==="

# ─────────────────────────────────────────────────────────────────────────
# F1 — Reconciler accepts a condition-valid late marker in awaiting_user.
# ─────────────────────────────────────────────────────────────────────────
fd="$(seed_worktree "f1-valid-marker")"
wt="$TMP_ROOT/f1-valid-marker"
head="$(git -C "$wt" rev-parse HEAD)"
write_planning_awaiting_user "$fd"
write_marker "$fd" "$head"
reset_state
rc=0
planning_late_coding_complete_reconcile "HOK-3211-F1" "$fd" "$wt" "HOK-3211-F1-win" "claude" || rc=$?
if [[ "$rc" == "0" ]] \
  && [[ "$(stage_result_field "$fd" planning status)" == "completed" ]] \
  && [[ "$(stage_result_field "$fd" coding status)" == "completed" ]] \
  && [[ -f "$fd/.coding-complete" ]] \
  && grep -q "late_completion_reconciled" "$STATUS_LOG" \
  && grep -q "HOK-3211-F1-win=clear" "$ATTENTION_FILE" \
  && grep -q "late_completion_reconciled" "$HOOK_CALLS_FILE"; then
  pass "F1: condition-valid .coding-complete reconciles planning→completed + coding=completed in-place"
else
  fail "F1: reconciler did not fire (rc=$rc planning=$(stage_result_field "$fd" planning status) coding=$(stage_result_field "$fd" coding status) status_log=$(cat "$STATUS_LOG"))"
fi

# ─────────────────────────────────────────────────────────────────────────
# F2 — archive_stale_coding_artifacts preserves a condition-valid marker
# even when .plan-approved is touched (the HOK-3185 incident path).
# ─────────────────────────────────────────────────────────────────────────
fd="$(seed_worktree "f2-plan-approved")"
wt="$TMP_ROOT/f2-plan-approved"
head="$(git -C "$wt" rev-parse HEAD)"
write_marker "$fd" "$head"
: > "$fd/.plan-approved"
# Also drop a mix of other candidates to prove ONLY the valid .coding-complete
# is preserved — other stale artifacts still get archived.
: > "$fd/.coding-uncommitted-output-announced"
: > "$fd/.blocked-completion-announced"
reset_state
archive_stale_coding_artifacts "HOK-3211-F2" "$fd"
archive_subdir="$(find "$fd/.stale-artifacts" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | head -1)"
if [[ -f "$fd/.coding-complete" ]] \
  && [[ ! -f "$fd/.coding-uncommitted-output-announced" ]] \
  && [[ ! -f "$fd/.blocked-completion-announced" ]] \
  && [[ -n "$archive_subdir" ]] \
  && [[ -f "$archive_subdir/.coding-uncommitted-output-announced" ]] \
  && [[ -f "$archive_subdir/.blocked-completion-announced" ]] \
  && [[ ! -f "$archive_subdir/.coding-complete" ]] \
  && grep -q "preserved condition-valid .coding-complete" "$STATUS_LOG"; then
  pass "F2: valid .coding-complete preserved at launch gate; other stale artifacts archived normally"
else
  fail "F2: archive hardening wrong (marker=$([[ -f $fd/.coding-complete ]] && echo kept || echo moved) archive_subdir=$archive_subdir status=$(cat "$STATUS_LOG"))"
fi

# ─────────────────────────────────────────────────────────────────────────
# F3 — .coding-complete whose commit != HEAD is STILL archived (existing
# behaviour preserved for genuinely stale markers from prior attempts).
# ─────────────────────────────────────────────────────────────────────────
fd="$(seed_worktree "f3-stale-marker")"
wt="$TMP_ROOT/f3-stale-marker"
write_marker "$fd" "0000000000000000000000000000000000000000"
reset_state
archive_stale_coding_artifacts "HOK-3211-F3" "$fd"
if [[ ! -f "$fd/.coding-complete" ]]; then
  archive_subdir="$(find "$fd/.stale-artifacts" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | head -1)"
  if [[ -n "$archive_subdir" ]] && [[ -f "$archive_subdir/.coding-complete" ]]; then
    pass "F3: a .coding-complete whose commit != HEAD is still archived (prior-attempt stale marker)"
  else
    fail "F3: marker removed but not placed under .stale-artifacts"
  fi
else
  fail "F3: stale marker (commit mismatch) wrongly preserved"
fi

# ─────────────────────────────────────────────────────────────────────────
# F4 — a .coding-complete with a DIRTY tree does NOT reconcile. The
# existing dirty-handoff machinery still owns that case.
# ─────────────────────────────────────────────────────────────────────────
fd="$(seed_worktree "f4-dirty-tree")"
wt="$TMP_ROOT/f4-dirty-tree"
head="$(git -C "$wt" rev-parse HEAD)"
write_planning_awaiting_user "$fd"
write_marker "$fd" "$head"
printf 'wip\n' >> "$wt/README.md"
reset_state
rc=0
planning_late_coding_complete_reconcile "HOK-3211-F4" "$fd" "$wt" "HOK-3211-F4-win" "claude" || rc=$?
if [[ "$rc" == "1" ]] \
  && [[ "$(stage_result_field "$fd" planning status)" == "awaiting_user" ]] \
  && [[ ! -f "$fd/.coding-result.json" ]]; then
  pass "F4: dirty tree stays in awaiting_user (dirty-handoff machinery owns live arms)"
else
  fail "F4: reconciler fired on a dirty tree (rc=$rc planning=$(stage_result_field "$fd" planning status))"
fi

# ─────────────────────────────────────────────────────────────────────────
# F5 — maybe_retry_failed_stage for stage=coding relaunches coding
# DIRECTLY (new behaviour); the planning overreach guard never fires.
# ─────────────────────────────────────────────────────────────────────────
fd="$(seed_worktree "f5-coding-retry")"
wt="$TMP_ROOT/f5-coding-retry"
export WORKTREE_ROOT="$TMP_ROOT"
jq -n '{coding:{model:"claude-opus-4-7",agent:"claude",provider:"anthropic",stageRole:"coding",challengeSide:null,selectedAt:"2026-10-28T00:00:00Z"}}' > "$fd/.phase-config.json"
jq -n '{tasks:{"HOK-3211-F5":{worktree:"'"$wt"'", challenge:false}}}' > "$STATE_FILE"
# Seed a retryable native coding failure.
jq -n '{stage:"coding", status:"failed", startedAt:"2026-01-01T00:00:00Z", finishedAt:"2026-01-01T01:00:00Z", agent:"native", model:"claude-opus-4-7", notes:"Native coding failed: zstd decoder mismatch on shard 7"}' \
  > "$fd/.coding-result.json"
jq -n '{failureKind:"native-unclassified"}' > "$fd/.coding-failure-envelope.json"
reset_state
export WAVEMILL_RETRY_BACKOFF_STAGE_FAILURE_CODING_BASE_SECONDS=0
rc=0
maybe_retry_failed_stage "HOK-3211-F5" "$fd" "coding" "HOK-3211-F5-win" || rc=$?
if [[ "$rc" == "0" ]] \
  && [[ "$PLANNING_GUARD_CALLED" == "0" ]] \
  && grep -q "^HOK-3211-F5=coding$" "$PHASE_LOG" \
  && grep -q "^launch_coding_phase=" "$LAUNCH_SPY" \
  && grep -q "^prepare=" "$LAUNCH_SPY" \
  && grep -q "directly via coding" "$STATUS_LOG" \
  && grep -q "planning guard bypassed" "$STATUS_LOG"; then
  pass "F5: a retryable coding failure relaunches coding directly (planning guard bypassed)"
else
  fail "F5: direct coding relaunch wrong (rc=$rc guard=$PLANNING_GUARD_CALLED phase=$(cat "$PHASE_LOG") launch=$(cat "$LAUNCH_SPY") status=$(cat "$STATUS_LOG"))"
fi

# ─────────────────────────────────────────────────────────────────────────
# F6 — Reconciler against planning stage == running (plan.md absent) does
# NOT fire. We only reconcile from awaiting_user/completed planning state.
# ─────────────────────────────────────────────────────────────────────────
fd="$(seed_worktree "f6-planning-running")"
wt="$TMP_ROOT/f6-planning-running"
head="$(git -C "$wt" rev-parse HEAD)"
jq -n '{stage:"planning", status:"running", startedAt:"2026-01-01T00:00:00Z", agent:"claude"}' \
  > "$fd/.planning-result.json"
write_marker "$fd" "$head"
reset_state
rc=0
planning_late_coding_complete_reconcile "HOK-3211-F6" "$fd" "$wt" "HOK-3211-F6-win" "claude" || rc=$?
if [[ "$rc" == "1" ]] \
  && [[ "$(stage_result_field "$fd" planning status)" == "running" ]] \
  && [[ ! -f "$fd/.coding-result.json" ]]; then
  pass "F6: reconciler does not fire when planning stage is still running"
else
  fail "F6: scope leak — reconciler fired on planning=running (rc=$rc planning=$(stage_result_field "$fd" planning status))"
fi

# ─────────────────────────────────────────────────────────────────────────
# F7 — HEAD at base (no durable work) does NOT reconcile. A .coding-
# complete that commits nothing beyond base should fall through to the
# normal launch path.
# ─────────────────────────────────────────────────────────────────────────
fd="$(seed_worktree "f7-head-at-base")"
wt="$TMP_ROOT/f7-head-at-base"
# Reset the base ref to HEAD so there's no divergence.
git -C "$wt" update-ref "refs/remotes/origin/$BASE_BRANCH" HEAD
head="$(git -C "$wt" rev-parse HEAD)"
write_planning_awaiting_user "$fd"
write_marker "$fd" "$head"
reset_state
rc=0
planning_late_coding_complete_reconcile "HOK-3211-F7" "$fd" "$wt" "HOK-3211-F7-win" "claude" || rc=$?
if [[ "$rc" == "1" ]] \
  && [[ "$(stage_result_field "$fd" planning status)" == "awaiting_user" ]] \
  && [[ ! -f "$fd/.coding-result.json" ]]; then
  pass "F7: a .coding-complete whose HEAD equals base does not reconcile"
else
  fail "F7: HEAD-at-base case leaked into reconcile (rc=$rc)"
fi

# ─────────────────────────────────────────────────────────────────────────
# F8 — Seam-invalid marker stays in awaiting_user and the verdict is
# cached so the next tick does not re-spawn the tsx validator.
# ─────────────────────────────────────────────────────────────────────────
fd="$(seed_worktree "f8-seam-invalid")"
wt="$TMP_ROOT/f8-seam-invalid"
write_planning_awaiting_user "$fd"
printf '{"stage":"coding","confidence":"not-a-real-level"}\n' > "$fd/.coding-complete"
reset_state
rc=0
planning_late_coding_complete_reconcile "HOK-3211-F8" "$fd" "$wt" "HOK-3211-F8-win" "claude" || rc=$?
cache_present=0
if [[ -f "$fd/.late-planning-reconcile.json" ]] \
  && [[ "$(jq -r 'if .valid == false then "false" elif .valid == true then "true" else "missing" end' "$fd/.late-planning-reconcile.json")" == "false" ]]; then
  cache_present=1
fi
if [[ "$rc" == "1" ]] \
  && [[ "$(stage_result_field "$fd" planning status)" == "awaiting_user" ]] \
  && [[ "$cache_present" == "1" ]]; then
  pass "F8: seam-invalid marker stays in awaiting_user; cached verdict will skip future validator spawns"
else
  fail "F8: seam-invalid handling wrong (rc=$rc cache=$cache_present)"
fi

# ─────────────────────────────────────────────────────────────────────────
# F9 — coding_complete_marker_condition_valid is used by both the
# reconciler and archive_stale_coding_artifacts; verify it directly.
# ─────────────────────────────────────────────────────────────────────────
fd="$(seed_worktree "f9-condition-helper")"
wt="$TMP_ROOT/f9-condition-helper"
head="$(git -C "$wt" rev-parse HEAD)"

# Valid: marker commit matches HEAD, tree clean.
write_marker "$fd" "$head"
if coding_complete_marker_condition_valid "$fd"; then
  pass "F9a: valid marker (commit=HEAD, clean tree) is condition-valid"
else
  fail "F9a: valid marker not recognised as condition-valid"
fi

# Invalid: tree dirty.
printf 'wip\n' >> "$wt/README.md"
if ! coding_complete_marker_condition_valid "$fd"; then
  pass "F9b: dirty tree invalidates condition"
else
  fail "F9b: dirty tree not caught"
fi
# Clean up for next check.
git -C "$wt" checkout -q -- README.md

# Invalid: commit mismatch.
write_marker "$fd" "0000000000000000000000000000000000000000"
if ! coding_complete_marker_condition_valid "$fd"; then
  pass "F9c: commit mismatch invalidates condition"
else
  fail "F9c: commit mismatch not caught"
fi

# No marker at all.
rm -f "$fd/.coding-complete"
if ! coding_complete_marker_condition_valid "$fd"; then
  pass "F9d: missing marker is not condition-valid"
else
  fail "F9d: missing marker wrongly accepted"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
