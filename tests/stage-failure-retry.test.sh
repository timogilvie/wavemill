#!/usr/bin/env bash
# HOK-3176 acceptance: an unrecognised stage failure retries by default.
#
# maybe_retry_failed_stage owns the default path for a failed planning /
# coding / review stage: bounded retry with backoff through bounded-retry.sh
# (bucket stage-failure-<stage>, keyed on (head, merge-base) per HOK-3103),
# then one fresh relaunch, then escalation to needs-user — never a terminal
# park. Only an allowlisted cause (failure-policy.ts TERMINAL_ALLOWLIST) skips
# the retry. The escalation does not latch: a new head refills the budget and
# the HOK-3172 reconciler expires the exhausted sentinel.
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
  phase_launch_head \
  phase_launch_base \
  native_hook_terminal_failure_detail \
  native_coding_failure_handoff_reason \
  native_stage_failure_envelope_json \
  stage_failure_decision \
  stage_failure_owned_by_bucket \
  maybe_retry_failed_stage \
  emit_challenge_stage_failure_quarantine \
  challenge_abort_scope_for_failure \
  challenge_abort_pair \
  _challenge_side_for_issue \
  challenge_result_stage_for_launch \
  write_openrouter_warning_cache \
  record_openrouter_credits_challenge_abort \
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
write_stage_result() {
  local feature_dir="$1" stage="$2" status="$3" agent="${4:-}" model="${5:-}" notes="${6:-}"
  mkdir -p "$feature_dir"
  jq -n --arg stage "$stage" --arg status "$status" --arg agent "$agent" --arg model "$model" --arg notes "$notes" \
    '{stage:$stage,status:$status,agent:$agent,model:$model,notes:$notes}' > "$feature_dir/.${stage}-result.json"
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
  printf '%s\n' "$wt/features/$name"
}

seed() {
  local challenge="${1:-false}"
  jq -n --argjson c "$challenge" '{tasks:{
      "T-1":   {challengePairId:"T-1", challengeRole:"primary",    challenge:$c},
      "T-1_c": {challengePairId:"T-1", challengeRole:"challenger", challenge:$c}
    }}' > "$STATE_FILE"
  : > "$ATTENTION_FILE"; : > "$STATUS_LOG"; : > "$PHASE_LOG"
  CLEANUP_CALLS=""
}

unknown_detail="Native coding failed: zstd decoder mismatch on shard 7 (never seen before)"
bucket="stage-failure-coding"

echo "=== Stage failure default retry (HOK-3176) ==="

# ── Unknown failure: retry → backoff → retry → fresh relaunch → escalate ──
seed false
fd="$(new_worktree wt-unknown)"
write_stage_result "$fd" coding failed native kimi-k2 "$unknown_detail"
write_hook T-1 "$unknown_detail"
printf '{"failureKind":"native-unclassified"}\n' > "$fd/.coding-failure-envelope.json"
rc=0; maybe_retry_failed_stage T-1 "$fd" coding win-1 || rc=$?
if [[ "$rc" -eq 0 ]] \
  && [[ ! -f "$fd/.coding-result.json" ]] \
  && [[ ! -f "/tmp/wavemill-${SESSION}-T-1.hook" ]] \
  && grep -q '^T-1=planning$' "$PHASE_LOG" \
  && grep -q '^win-1=clear$' "$ATTENTION_FILE" \
  && [[ "$(bounded_retry_count "$fd" "$bucket")" == "1" ]] \
  && grep -q 'relaunch 1/3 via planning' "$STATUS_LOG"; then
  pass "unknown failure relaunches the stage through the previous phase (attempt 1)"
else
  fail "unknown failure was not relaunched (rc=$rc)"
fi

write_stage_result "$fd" coding failed native kimi-k2 "$unknown_detail"
rc=0; maybe_retry_failed_stage T-1 "$fd" coding win-1 || rc=$?
if [[ "$rc" -eq 2 && -f "$fd/.coding-result.json" && "$(bounded_retry_count "$fd" "$bucket")" == "1" ]]; then
  pass "a repeat failure inside the backoff window holds without spending budget"
else
  fail "backoff window not honoured (rc=$rc)"
fi

export WAVEMILL_RETRY_BACKOFF_STAGE_FAILURE_CODING_BASE_SECONDS=0
rc=0; maybe_retry_failed_stage T-1 "$fd" coding win-1 || rc=$?
[[ "$rc" -eq 0 && "$(bounded_retry_count "$fd" "$bucket")" == "2" ]] \
  && pass "backoff elapsed → second relaunch" || fail "second relaunch missing (rc=$rc)"

write_stage_result "$fd" coding failed native kimi-k2 "$unknown_detail"
printf '{"failureKind":"native-unclassified"}\n' > "$fd/.coding-failure-envelope.json"
rc=0; maybe_retry_failed_stage T-1 "$fd" coding win-1 || rc=$?
if [[ "$rc" -eq 0 ]] \
  && grep -q 'relaunch 3/3 (fresh relaunch)' "$STATUS_LOG" \
  && [[ ! -f "$fd/.coding-failure-envelope.json" && -f "$fd/.coding-failure-envelope.attempt-3.json" ]]; then
  pass "final attempt is a fresh relaunch with the failed run's envelope archived"
else
  fail "fresh relaunch did not archive failure artifacts (rc=$rc)"
fi

write_stage_result "$fd" coding failed native kimi-k2 "$unknown_detail"
rc=0; maybe_retry_failed_stage T-1 "$fd" coding win-1 || rc=$?
reason="$(bounded_retry_exhaustion_reason "$fd" "$bucket")"
companion="$(bounded_retry_condition_path "$fd" "$bucket")"
if [[ "$rc" -eq 1 ]] \
  && [[ "$reason" == "unknown-failure-after-retries:coding:native-unclassified after 3 relaunch(es)"* ]] \
  && [[ "$reason" == *"$unknown_detail"* ]] \
  && grep -q 'escalating to needs-user' "$STATUS_LOG" \
  && [[ -f "$companion" ]] \
  && [[ "$(jq -r '.condition.expiresOn | join(",")' "$companion" 2>/dev/null)" == *head* ]]; then
  pass "exhausted budget escalates with the evidence and a head-expiring condition companion"
else
  fail "escalation incomplete (rc=$rc reason=$reason)"
fi

rc=0; maybe_retry_failed_stage T-1 "$fd" coding win-1 || rc=$?
[[ "$rc" -eq 1 ]] && pass "already-escalated stage holds quietly (exhausted-quiet)" || fail "exhausted-quiet rc=$rc"

# ── Escalation never latches ──────────────────────────────────────────
wt="${fd%/features/*}"
git -C "$wt" commit -q --allow-empty -m "operator fix"
condition_reconcile_task T-1 "$wt" "$fd" >/dev/null 2>&1 || true
if ! bounded_retry_is_exhausted "$fd" "$bucket" && [[ ! -f "$companion" ]]; then
  pass "HOK-3172 reconciler expires the escalation on a new head"
else
  fail "escalation latched across a new head"
fi
rc=0; maybe_retry_failed_stage T-1 "$fd" coding win-1 || rc=$?
[[ "$rc" -eq 0 && "$(bounded_retry_count "$fd" "$bucket")" == "1" ]] \
  && pass "a later failure at the new head gets a fresh budget" || fail "budget did not refill (rc=$rc)"

# ── HOK-3103: a new merge-base refills the budget at the same head ────
seed false
fd="$(new_worktree wt-base)"
wt="${fd%/features/*}"
write_stage_result "$fd" coding failed native kimi-k2 "$unknown_detail"
maybe_retry_failed_stage T-1 "$fd" coding win-b >/dev/null || true
write_stage_result "$fd" coding failed native kimi-k2 "$unknown_detail"
maybe_retry_failed_stage T-1 "$fd" coding win-b >/dev/null || true
before="$(bounded_retry_count "$fd" "$bucket")"
git -C "$wt" update-ref "refs/remotes/origin/$BASE_BRANCH" HEAD~2
write_stage_result "$fd" coding failed native kimi-k2 "$unknown_detail"
maybe_retry_failed_stage T-1 "$fd" coding win-b >/dev/null || true
if [[ "$before" == "2" && "$(bounded_retry_count "$fd" "$bucket")" == "1" \
  && "$(bounded_retry_base "$fd" "$bucket")" == "$(git -C "$wt" rev-parse HEAD~2)" ]]; then
  pass "(head, base) key: a new merge-base resets the budget"
else
  fail "base change did not reset the budget (before=$before after=$(bounded_retry_count "$fd" "$bucket"))"
fi

# ── Allowlisted terminal cause: no retry, no budget spent ─────────────
seed false
fd="$(new_worktree wt-terminal)"
write_stage_result "$fd" coding failed native qwen "Native coding failed: 400 qwen-2.5-coder-32b is not a valid model ID"
rc=0; maybe_retry_failed_stage T-1 "$fd" coding win-t || rc=$?
if [[ "$rc" -eq 1 && "$(bounded_retry_count "$fd" "$bucket")" == "0" && ! -s "$PHASE_LOG" ]]; then
  pass "allowlisted terminal cause (provider-config-error) is not retried"
else
  fail "terminal cause was retried (rc=$rc)"
fi

# ── Monitor-owned terminalizations are not retried twice ──────────────
seed false
fd="$(new_worktree wt-owned)"
write_stage_result "$fd" coding failed "" kimi-k2 "Coding launch refused (coder reroute budget of 3 exhausted)"
rc=0; maybe_retry_failed_stage T-1 "$fd" coding win-o || rc=$?
[[ "$rc" -eq 1 && ! -s "$PHASE_LOG" ]] \
  && pass "agentless failed result (monitor terminalization) is not retried" || fail "monitor terminalization retried"
write_stage_result "$fd" coding failed native kimi-k2 "$unknown_detail"
bounded_retry_mark_exhausted "$fd" coding-dirty-handoff "dirty handoff exhausted" || true
rc=0; maybe_retry_failed_stage T-1 "$fd" coding win-o || rc=$?
[[ "$rc" -eq 1 && ! -s "$PHASE_LOG" ]] \
  && pass "a stage whose own bucket is exhausted is not retried again" || fail "owned bucket retried"

# ── Challenger arm: retries first, then a single-sided retry_exhausted abort ──
seed true
fd="$(new_worktree wt-challenger)"
export WAVEMILL_STAGE_FAILURE_MAX_ATTEMPTS=1
write_stage_result "$fd" coding failed native llama-4-scout "$unknown_detail"
rc=0; maybe_retry_failed_stage T-1_c "$fd" coding win-c || rc=$?
[[ "$rc" -eq 0 && "$(get_task_meta T-1_c challengeAborted)" == "" ]] \
  && pass "unknown challenger failure relaunches instead of quarantining the pair" || fail "challenger not retried (rc=$rc)"
write_stage_result "$fd" coding failed native llama-4-scout "$unknown_detail"
rc=0; maybe_retry_failed_stage T-1_c "$fd" coding win-c || rc=$?
if [[ "$rc" -eq 1 ]] && emit_challenge_stage_failure_quarantine T-1_c "$fd" coding win-c \
  && [[ "$(get_task_meta T-1_c challengeAborted)" == "retry_exhausted:native-unclassified" ]] \
  && [[ -z "$(get_task_meta T-1 challengeAborted)" ]] \
  && [[ "$CLEANUP_CALLS" == *"T-1_c|coding|retry exhausted:native-unclassified"* ]]; then
  pass "exhausted challenger retires single-sided so the healthy primary proceeds"
else
  fail "challenger exhaustion scoping wrong (rc=$rc)"
fi
unset WAVEMILL_STAGE_FAILURE_MAX_ATTEMPTS

echo
echo "--- Results: $PASS passed, $FAIL failed ---"
[[ "$FAIL" -eq 0 ]]
