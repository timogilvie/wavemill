#!/usr/bin/env bash
# HOK-3176 acceptance: an unrecognised stage failure retries by default.
#
# _maybe_retry_failed_stage_now owns the default path for a failed planning /
# coding / review stage: bounded retry with backoff through bounded-retry.sh
# (bucket stage-failure-<stage>, keyed on stage input per HOK-3491),
# then one fresh relaunch, then escalation to needs-user — never a terminal
# park. Only an allowlisted cause (failure-policy.ts TERMINAL_ALLOWLIST) skips
# the retry. Planning/coding output cannot refill the budget. A new input/run resets it;
# review/Ready retain the head + merge-base reset.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

TMP_ROOT="$(mktemp -d)"
SESSION="stagefail$$"
trap 'rm -rf "$TMP_ROOT"; rm -f /tmp/wavemill-'"$SESSION"'-*.hook 2>/dev/null || true' EXIT

# shellcheck source=../shared/lib/wavemill-common.sh
source "$REPO_DIR/shared/lib/wavemill-common.sh"
# shellcheck source=../shared/lib/transient-marker.sh
source "$REPO_DIR/shared/lib/transient-marker.sh"
# shellcheck source=../shared/lib/condition-reconciler.sh
source "$REPO_DIR/shared/lib/condition-reconciler.sh"
TOOLS_DIR="$REPO_DIR/tools"
source "$REPO_DIR/tests/lib/state-fixtures.sh"

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

# Brace-depth-aware extraction so functions with nested braces survive intact.
extract_function() {
  awk -v name="$1" '
    function brace_delta(line, stripped, opens, closes) {
      stripped = line
      gsub(/"([^"\\]|\\.)*"/, "\"\"", stripped)
      gsub(/\047([^\047\\]|\\.)*\047/, "\047\047", stripped)
      opens = gsub(/\{/, "{", stripped)
      closes = gsub(/\}/, "}", stripped)
      return opens - closes
    }
    $0 ~ "^" name "\\(\\)[[:space:]]*\\{" { capture = 1; depth = 0 }
    capture { print; depth += brace_delta($0); if (depth == 0) exit }
  ' "$MONITOR_SCRIPT_FILE"
}

for fn in \
  read_stage_result \
  phase_launch_head \
  phase_launch_base \
  stage_failure_retry_key \
  native_hook_terminal_failure_detail \
  native_coding_failure_handoff_reason \
  native_stage_failure_envelope_json \
  stage_failure_decision \
  stage_failure_owned_by_bucket \
  _recovery_continuation_current \
  _maybe_retry_failed_stage_now \
  _monitor_claim_failed_stage_action \
  _dispatch_failed_stage_recovery \
  _execute_recovery_escalation \
  _ready_failure_update_base \
  _stage_failure_coding_relaunch \
  recovery_contract_json \
  emit_challenge_stage_failure_quarantine \
  challenge_abort_scope_for_failure \
  stage_budget_exhausted_json \
  challenge_abort_pair \
  _challenge_side_for_issue \
  challenge_result_stage_for_launch \
  write_openrouter_warning_cache \
  record_openrouter_credits_challenge_abort \
  _request_launch_recovery \
; do
  eval "$(extract_function "$fn")"
done

STATE_FILE="$TMP_ROOT/state.json"
ATTENTION_FILE="$TMP_ROOT/attention.txt"
STATUS_LOG="$TMP_ROOT/status.txt"
PHASE_LOG="$TMP_ROOT/phases.txt"
WAVEMILL_STATE_DIR="$TMP_ROOT/wavemill-state"
BASE_BRANCH="auto/integration"
mkdir -p "$WAVEMILL_STATE_DIR"
export WAVEMILL_RELIABILITY_REPO_DIR="$TMP_ROOT/reliability-repo"
export WAVEMILL_RETRY_BACKOFF_STAGE_FAILURE_CODING_BASE_SECONDS=3600
CLEANUP_CALLS=""

log() { printf '%s\n' "$*" >> "$STATUS_LOG"; }
log_warn() { printf '%s\n' "$1" >> "$STATUS_LOG"; }
log_error() { printf '%s\n' "$1" >> "$STATUS_LOG"; }
set_window_attention_state() { printf '%s=%s\n' "$1" "$2" >> "$ATTENTION_FILE"; }
set_task_phase() { printf '%s=%s\n' "$1" "$2" >> "$PHASE_LOG"; }
challenge_stage_for_launch_env() { printf '%s\n' "$1"; }
clear_stage_result() { rm -f "$1/.${2}-result.json"; }
state_mutate() {
  local state_path="$1" filter="$2"
  shift 2
  jq "$@" "$filter" "$state_path" > "$state_path.tmp"
  mv "$state_path.tmp" "$state_path"
}
get_task_meta() {
  jq -r --arg issue "$1" --arg field "$2" '.tasks[$issue][$field] // empty' "$STATE_FILE"
}
cleanup_quarantined_no_pr_challenge_arm() { CLEANUP_CALLS+="$1|$3|$4"$'\n'; return 0; }
stage_result_field() {
  jq -r --arg f "$3" '.[$f] // empty' "$1/.${2}-result.json" 2>/dev/null || true
}
RESULT_SERIAL=0
write_stage_result() {
  local feature_dir="$1" stage="$2" status="$3" agent="${4:-}" model="${5:-}" notes="${6:-}"
  RESULT_SERIAL=$((RESULT_SERIAL + 1))
  mkdir -p "$feature_dir"
  jq -n --arg startedAt "2026-11-15T00:00:$(printf "%02d" "$RESULT_SERIAL")Z" --arg stage "$stage" --arg status "$status" --arg agent "$agent" --arg model "$model" --arg notes "$notes" \
    '{stage:$stage,status:$status,agent:$agent,model:$model,notes:$notes,startedAt:$startedAt}' > "$feature_dir/.${stage}-result.json"
}
write_hook() {
  jq -n --arg d "$2" '{state:"error",event:"process_exit",agent:"native",timestamp:1,detail:$d}' \
    > "/tmp/wavemill-${SESSION}-$1.hook"
}

# A worktree whose feature dir sits at <wt>/features/<slug>, with an
# origin/<base> ref so phase_launch_base resolves a real merge-base.
new_worktree() {
  local name="$1" wt="$TMP_ROOT/$1"
  git -C "$TMP_ROOT" init -q "$name"
  git -C "$wt" config user.email test@example.com
  git -C "$wt" config user.name Test
  git -C "$wt" commit -q --allow-empty -m c0
  git -C "$wt" commit -q --allow-empty -m c1
  git -C "$wt" update-ref "refs/remotes/origin/$BASE_BRANCH" HEAD
  git -C "$wt" commit -q --allow-empty -m c2
  mkdir -p "$wt/features/$name"
  printf '%s\n' '{"coding":{"model":"claude-opus-4-7","provider":"anthropic","agent":"claude","stageRole":"coding","challengeSide":null,"selectedAt":"2026-10-27T12:27:16Z"}}' > "$wt/features/$name/.phase-config.json"

  printf '%s\n' "$wt/features/$name"
}

seed() {
  local challenge="${1:-false}"
  fixture_workflow_state "$STATE_FILE" T-1 challengePairId=T-1 challengeRole=primary challenge="$challenge" phase=coding \
    -- T-1_c challengePairId=T-1 challengeRole=challenger challenge="$challenge" phase=coding
  : > "$ATTENTION_FILE"; : > "$STATUS_LOG"; : > "$PHASE_LOG"
  CLEANUP_CALLS=""
}

pass_task_field() {
  case "$2" in
    worktree) printf '%s\n' "${fd%/features/*}" ;;
    branch) printf 'task/recovery\n' ;;
    title) printf 'Recovery test\n' ;;
    *) get_task_meta "$1" "$2" ;;
  esac
}
read_phase_config() { printf ''; }
resolve_stage_result_model() { stage_result_field "$1" "$2" model; }
_prepare_recovery_phase_launch() { write_stage_result "$4" "$3" running "$6" "$7"; }
launch_coding_phase() { return 0; }

unknown_detail="Native coding failed: zstd decoder mismatch on shard 7 (never seen before)"
bucket="stage-failure-coding"

echo "=== Stage failure default retry (HOK-3176) ==="

# ── Unknown failure: retry → backoff → retry → fresh relaunch → escalate ──
seed false
fd="$(new_worktree wt-unknown)"
write_stage_result "$fd" coding failed native kimi-k2 "$unknown_detail"
write_hook T-1 "$unknown_detail"
printf '{"failureKind":"native-unclassified"}\n' > "$fd/.coding-failure-envelope.json"
rc=0; _maybe_retry_failed_stage_now T-1 "$fd" coding win-1 || rc=$?
if [[ "$rc" -eq 0 ]] \
  && [[ -f "$fd/.coding-result.json" ]] \
  && [[ ! -f "/tmp/wavemill-${SESSION}-T-1.hook" ]] \
  && grep -q '^T-1=coding$' "$PHASE_LOG" \
  && grep -q '^win-1=clear$' "$ATTENTION_FILE" \
  && [[ "$(bounded_retry_count "$fd" "$bucket")" == "1" ]] \
  && grep -q 'relaunch 1/3.*directly via coding' "$STATUS_LOG"; then
  pass "unknown failure replays its persisted coding contract (attempt 1)"
else
  fail "unknown failure was not relaunched (rc=$rc)"
fi

write_stage_result "$fd" coding failed native kimi-k2 "$unknown_detail"
rc=0; _maybe_retry_failed_stage_now T-1 "$fd" coding win-1 || rc=$?
if [[ "$rc" -eq 2 && -f "$fd/.coding-result.json" && "$(bounded_retry_count "$fd" "$bucket")" == "1" ]]; then
  pass "a repeat failure inside the backoff window holds without spending budget"
else
  fail "backoff window not honoured (rc=$rc)"
fi

export WAVEMILL_RETRY_BACKOFF_STAGE_FAILURE_CODING_BASE_SECONDS=0
rc=0; _maybe_retry_failed_stage_now T-1 "$fd" coding win-1 || rc=$?
[[ "$rc" -eq 0 && "$(bounded_retry_count "$fd" "$bucket")" == "2" ]] \
  && pass "backoff elapsed → second relaunch" || fail "second relaunch missing (rc=$rc)"

write_stage_result "$fd" coding failed native kimi-k2 "$unknown_detail"
printf '{"failureKind":"native-unclassified"}\n' > "$fd/.coding-failure-envelope.json"
rc=0; _maybe_retry_failed_stage_now T-1 "$fd" coding win-1 || rc=$?
if [[ "$rc" -eq 0 ]] \
  && grep -q 'relaunch 3/3 (fresh relaunch)' "$STATUS_LOG" \
  && [[ ! -f "$fd/.coding-failure-envelope.json" && -f "$fd/.coding-failure-envelope.attempt-3.json" ]]; then
  pass "final attempt is a fresh relaunch with the failed run's envelope archived"
else
  fail "fresh relaunch did not archive failure artifacts (rc=$rc)"
fi

write_stage_result "$fd" coding failed native kimi-k2 "$unknown_detail"
rc=0; _maybe_retry_failed_stage_now T-1 "$fd" coding win-1 || rc=$?
reason="$(bounded_retry_exhaustion_reason "$fd" "$bucket")"
companion="$(bounded_retry_condition_path "$fd" "$bucket")"
if [[ "$rc" -eq 1 ]] \
  && [[ "$reason" == "unknown-failure-after-retries:coding:native-unclassified after 3 relaunch(es)"* ]] \
  && [[ "$reason" == *"$unknown_detail"* ]] \
  && grep -q 'escalating to needs-user' "$STATUS_LOG" \
  && [[ -f "$companion" ]] \
  && [[ "$(jq -r '.condition.expiresOn | join(",")' "$companion" 2>/dev/null)" == "operator-event" ]]; then
  pass "exhausted budget escalates with evidence and an input-safe condition companion"
else
  fail "escalation incomplete (rc=$rc reason=$reason)"
fi

rc=0; _maybe_retry_failed_stage_now T-1 "$fd" coding win-1 || rc=$?
[[ "$rc" -eq 1 ]] && pass "already-escalated stage holds quietly (exhausted-quiet)" || fail "exhausted-quiet rc=$rc"

# ── Coding output cannot undo exhaustion; a replacement run is new input ──
wt="${fd%/features/*}"
git -C "$wt" commit -q --allow-empty -m "partial coding output"
condition_reconcile_task T-1 "$wt" "$fd" >/dev/null 2>&1 || true
if bounded_retry_is_exhausted "$fd" "$bucket" && [[ -f "$companion" ]]; then
  pass "reconciliation preserves coding exhaustion across output commits"
else
  fail "output commit expired coding exhaustion"
fi
fixture_workflow_state "$STATE_FILE" T-1 phase=coding runId=replacement-input
rc=0; _maybe_retry_failed_stage_now T-1 "$fd" coding win-1 || rc=$?
[[ "$rc" -eq 0 && "$(bounded_retry_count "$fd" "$bucket")" == "1" ]] \
  && pass "a replacement input/run receives a fresh allowance" || fail "new input did not refill (rc=$rc)"

# ── HOK-3103 remains valid for review: a new merge-base is new input ──
export WAVEMILL_RETRY_BACKOFF_STAGE_FAILURE_REVIEW_BASE_SECONDS=0
seed false
fixture_workflow_state "$STATE_FILE" T-1 phase=review
fd="$(new_worktree wt-base)"
wt="${fd%/features/*}"
for n in 1 2; do
  write_stage_result "$fd" review failed claude claude-opus-4-7 "$unknown_detail"
  _maybe_retry_failed_stage_now T-1 "$fd" review win-b >/dev/null || true
done
before="$(bounded_retry_count "$fd" stage-failure-review)"
git -C "$wt" update-ref "refs/remotes/origin/$BASE_BRANCH" HEAD~2
write_stage_result "$fd" review failed claude claude-opus-4-7 "$unknown_detail"
_maybe_retry_failed_stage_now T-1 "$fd" review win-b >/dev/null || true
expected_base="$(git -C "$wt" rev-parse HEAD~2)"
if [[ "$before" == "2" && "$(bounded_retry_count "$fd" stage-failure-review)" == "1" \
  && "$(bounded_retry_base "$fd" stage-failure-review)" == "$expected_base" ]]; then
  pass "review still resets its allowance on a changed merge-base"
else
  fail "review base change did not reset its allowance (before=$before)"
fi

# ── Allowlisted terminal cause: no retry, no budget spent ─────────────
seed false
fd="$(new_worktree wt-terminal)"
write_stage_result "$fd" coding failed native qwen "Native coding failed: 400 qwen-2.5-coder-32b is not a valid model ID"
rc=0; _maybe_retry_failed_stage_now T-1 "$fd" coding win-t || rc=$?
if [[ "$rc" -eq 1 && "$(bounded_retry_count "$fd" "$bucket")" == "0" && ! -s "$PHASE_LOG" ]]; then
  pass "allowlisted terminal cause (provider-config-error) is not retried"
else
  fail "terminal cause was retried (rc=$rc)"
fi

# ── Monitor-owned terminalizations are not retried twice ──────────────
seed false
fd="$(new_worktree wt-owned)"
write_stage_result "$fd" coding failed "" kimi-k2 "Coding launch refused (coder reroute budget of 3 exhausted)"
rc=0; _maybe_retry_failed_stage_now T-1 "$fd" coding win-o || rc=$?
[[ "$rc" -eq 1 && ! -s "$PHASE_LOG" ]] \
  && pass "agentless failed result (monitor terminalization) is not retried" || fail "monitor terminalization retried"
write_stage_result "$fd" coding failed native kimi-k2 "$unknown_detail"
bounded_retry_mark_exhausted "$fd" coding-dirty-handoff "dirty handoff exhausted" || true
rc=0; _maybe_retry_failed_stage_now T-1 "$fd" coding win-o || rc=$?
[[ "$rc" -eq 1 && ! -s "$PHASE_LOG" ]] \
  && pass "a stage whose own bucket is exhausted is not retried again" || fail "owned bucket retried"

# ── Challenger arm: retries first, then a single-sided retry_exhausted abort ──
seed true
fd="$(new_worktree wt-challenger)"
export WAVEMILL_STAGE_FAILURE_MAX_ATTEMPTS=1
write_stage_result "$fd" coding failed native llama-4-scout "$unknown_detail"
rc=0; _maybe_retry_failed_stage_now T-1_c "$fd" coding win-c || rc=$?
[[ "$rc" -eq 0 && "$(get_task_meta T-1_c challengeAborted)" == "" ]] \
  && pass "unknown challenger failure relaunches instead of quarantining the pair" || fail "challenger not retried (rc=$rc)"
write_stage_result "$fd" coding failed native llama-4-scout "$unknown_detail"
rc=0; _maybe_retry_failed_stage_now T-1_c "$fd" coding win-c || rc=$?
if [[ "$rc" -eq 1 ]] && emit_challenge_stage_failure_quarantine T-1_c "$fd" coding win-c \
  && [[ "$(get_task_meta T-1_c challengeAborted)" == "terminal_stage_failure:native-unclassified" ]] \
  && [[ -z "$(get_task_meta T-1 challengeAborted)" ]] \
  && [[ "$CLEANUP_CALLS" == *"T-1_c|coding|retry exhausted:native-unclassified"* ]]; then
  pass "exhausted challenger retires single-sided so the healthy primary proceeds"
else
  fail "challenger exhaustion scoping wrong (rc=$rc)"
fi
unset WAVEMILL_STAGE_FAILURE_MAX_ATTEMPTS


# ── HOK-3512: a refused saved route escalates once; window-lost matches ──
# (HOK-3500 incident) The retry verdict is `proceed`, but the saved coding
# route no longer passes launch validation. The controller used to wait on an
# `execution-contract-available` wake nothing produced; it must now raise one
# failure-policy terminal escalation naming the stage, model and reason.
refuse_route() { jq '.coding.model = "retired-coder-model"' "$1/.phase-config.json" > "$1/.pc.tmp" && mv "$1/.pc.tmp" "$1/.phase-config.json"; }
refusal_basis() { jq -r '.detail.escalationBasis // empty' "$1/.needs-attention" 2>/dev/null; }
seed false
fd="$(new_worktree wt-refused)"
refuse_route "$fd"
write_stage_result "$fd" coding failed native kimi-k2 "$unknown_detail"
rc=0; _maybe_retry_failed_stage_now T-1 "$fd" coding win-r || rc=$?
failed_basis="$(refusal_basis "$fd")"
if [[ "$rc" -eq 1 && "$(bounded_retry_count "$fd" "$bucket")" == "0" && ! -s "$PHASE_LOG" ]] \
  && [[ "$failed_basis" == policy-terminal* ]] \
  && grep -q 'saved coding route (model retired-coder-model) refused by launch validation: model_not_launchable' "$fd/.needs-attention" \
  && grep -q '^win-r=needs-user$' "$ATTENTION_FILE"; then
  pass "a refused saved coding route raises one terminal escalation naming the stage, model and validator reason"
else
  fail "refused saved route did not escalate (rc=$rc basis=$failed_basis)"
fi
escalations="$(grep -c 'refused by launch validation' "$STATUS_LOG")"
rc=0; _maybe_retry_failed_stage_now T-1 "$fd" coding win-r || rc=$?
[[ "$rc" -eq 1 && "$(grep -c 'refused by launch validation' "$STATUS_LOG")" == "$escalations" && ! -s "$PHASE_LOG" ]] \
  && pass "the next pass holds the claimed escalation without a second page or a relaunch" \
  || fail "refused route re-escalated or relaunched (rc=$rc)"

seed false
fd="$(new_worktree wt-window-lost)"
refuse_route "$fd"
write_stage_result "$fd" coding running native kimi-k2
before_state="$(jq -S . "$STATE_FILE")"
_RESTORE_STATE=none
# The supervised async job runs the same controller step; run it inline here.
maybe_retry_failed_stage() { _maybe_retry_failed_stage_now "$@" >/dev/null 2>&1 || true; }
stage_agent_disposition() { printf '%s\n' '{"kind":"settled","reason":"window-missing"}'; }
refused_contract="$(recovery_contract_json T-1 "$fd" coding)"
_request_launch_recovery T-1 coding "$fd" "$(jq -r .reason <<<"$refused_contract")" \
  "$(jq -r .detail <<<"$refused_contract")" "$refused_contract"
unset -f maybe_retry_failed_stage stage_agent_disposition
if [[ "$_RESTORE_STATE" == "pending" && "$(refusal_basis "$fd")" == "$failed_basis" ]] \
  && grep -q 'saved coding route (model retired-coder-model) refused by launch validation: model_not_launchable' "$fd/.needs-attention" \
  && [[ "$(jq -S . "$STATE_FILE")" == "$before_state" ]] \
  && [[ "$(stage_result_field "$fd" coding status)" == "running" ]] \
  && [[ ! -f "/tmp/wavemill-${SESSION}-T-1.hook" ]]; then
  pass "window-lost refusal takes the same escalation, with no private stopped state, result or hook"
else
  fail "window-lost refusal diverged (state=$_RESTORE_STATE basis=$(refusal_basis "$fd"))"
fi

# CI 43647719528: an old coding worker resumed after the same run reached Ready.
# Advance state at the teardown barrier, then exercise the real launch guard.
seed false
fd="$(new_worktree wt-delayed)"
write_stage_result "$fd" coding failed native kimi-k2 "$unknown_detail"
eval "$(extract_function _launch_agent_in_pane)"
WORKTREE_ROOT="$TMP_ROOT"
LAUNCH_EFFECTS="$TMP_ROOT/delayed-launch-effects"
: > "$LAUNCH_EFFECTS"
agent_prepare_pane_for_launch() {
  fixture_workflow_state "$STATE_FILE" T-1 phase=ready
}
task_identity_linear_id() { printf '%s\n' "$1"; }
challenge_varied_stage_model() { :; }
tmux() { printf 'tmux\n' >> "$LAUNCH_EFFECTS"; }
agent_launch_interactive() { printf 'agent\n' >> "$LAUNCH_EFFECTS"; }
launch_coding_phase() { _launch_agent_in_pane @fake claude claude-opus-4-7 "$TMP_ROOT/prompt" wt-delayed T-1 coding; }
rc=0; _maybe_retry_failed_stage_now T-1 "$fd" coding win-delayed || rc=$?
if [[ "$rc" == 2 && "$(jq -r '.tasks["T-1"].phase' "$STATE_FILE")" == ready \
      && ! -s "$LAUNCH_EFFECTS" && ! -s "$PHASE_LOG" \
      && "$(jq -r '.claim.outcome' "$fd/.recovery-claim.json")" == reassess ]]; then
  pass "delayed worker cannot launch or regress phase after teardown advances to Ready"
else
  fail "delayed worker crossed its stage fence (rc=$rc)"
fi
launch_coding_phase() { return 0; }

# Protects: uncertain dispatch schedules a supervised fresh probe carrying the
# original run, and handing off a completion cannot strand its claim.
eval "$(extract_function _stage_disposition_act_now)"
eval "$(extract_function _stage_disposition_act)"
eval "$(extract_function _task_recovery_job_id)"
eval "$(extract_function sanitize_job_token)"
ASYNC_JOB_MAX_RUNTIME_SECONDS=3600
VERIFY_CALLS="$TMP_ROOT/verification-calls"
ACK_CALLS="$TMP_ROOT/ack-calls"
stage_agent_disposition() { printf '%s\n' '{"kind":"in-flight","reason":"agent-working"}'; }
CONTROL_OUTCOME='{"decision":{"action":"verify-effect"},"claim":{"claimed":false}}'
wavemill_run_tool() {
  if [[ "${4:-}" == "--ack" ]]; then printf '%s\n' "$5" >> "$ACK_CALLS"; return 0; fi
  printf '%s\n' "$CONTROL_OUTCOME"
}
monitor_async_job_launch() { printf '%s\n' "$*" >> "$VERIFY_CALLS"; }
_stage_disposition_act T-1 "$fd" "$fd" pane win coding original-run
if [[ "$(cat "$VERIFY_CALLS")" == task-recovery* ]] \
  && [[ "$(cat "$VERIFY_CALLS")" == *"_task_recovery_job_run original-run _stage_disposition_act_now T-1 $fd $fd pane win coding original-run" ]]; then
  pass "uncertain dispatch schedules tracked verification for the original run"
else
  fail "uncertain dispatch did not schedule run-fenced verification"
fi
_stage_disposition_act T-1 "$fd" "$fd" pane win coding replacement-run
[[ "$(awk '{print $2}' "$VERIFY_CALLS" | sort -u | wc -l | tr -d ' ')" == "2" ]] \
  && pass "a replacement run gets a distinct supervisor slot" || fail "replacement recovery shares stale slot"
jq '.finishedAt="2026-11-14T23:59:59Z"' "$fd/.coding-result.json" > "$TMP_ROOT/new-result.json"
mv "$TMP_ROOT/new-result.json" "$fd/.coding-result.json"
_stage_disposition_act T-1 "$fd" "$fd" pane win coding replacement-run
[[ "$(awk '{print $2}' "$VERIFY_CALLS" | sort -u | wc -l | tr -d ' ')" == "3" ]] \
  && pass "new result evidence gets a distinct supervisor slot" || fail "new evidence shares stale slot"
CONTROL_OUTCOME='{"decision":{"action":"consume-advance"},"claim":{"claimed":true,"claim":{"claimId":"completion-token"}}}'
_stage_disposition_act_now T-1 "$fd" "$fd" pane win coding original-run
[[ "$(cat "$ACK_CALLS")" == completion-token ]] \
  && pass "completion handoff acknowledges its own claim" || fail "completion claim stranded"

echo

# After the two-argument shift, $3 is the stage. Ready must not acquire the
# non-Ready challenge quarantine path when its controller returns rc=1.
eval "$(extract_function _task_recovery_job_run)"
_maybe_retry_failed_stage_now() { return 1; }
QUARANTINE_CALLS="$TMP_ROOT/worker-quarantine"
: > "$QUARANTINE_CALLS"
emit_challenge_stage_failure_quarantine() { printf '%s\n' "$*" >> "$QUARANTINE_CALLS"; }
_task_recovery_job_run original-run _maybe_retry_failed_stage_now T-1 "$fd" ready win
[[ ! -s "$QUARANTINE_CALLS" ]] && pass "Ready worker does not quarantine an operator escalation" || fail "Ready worker incorrectly quarantined"
_task_recovery_job_run original-run _maybe_retry_failed_stage_now T-1 "$fd" coding win
grep -q "^T-1 $fd coding win$" "$QUARANTINE_CALLS" && pass "coding worker passes the shifted stage to quarantine" || fail "coding worker argument order wrong"
[[ "$FAIL" -eq 0 ]]

echo "--- Results: $PASS passed, $FAIL failed ---"
