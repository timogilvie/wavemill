#!/usr/bin/env bash
# Regression coverage for HOK-2885: bounded phase relaunch on transient
# challenger provider errors, plus single-side abort scoping.
#
# Background: `provider-transient-error` on a native challenger arm is a
# mid-stream upstream stall (OpenRouter tearing down its own idle connection).
# Before this, one transient error on the challenger quarantined the whole
# pair — the healthy primary lost its eval for a fault it did not have. The
# monitor now relaunches the challenger's phase (bounded, backed off) and, when
# the budget is exhausted, aborts only the challenger so the pair resolves by
# forfeit to the primary.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

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

for fn in \
  challenger_transient_retry_file \
  challenger_transient_retry_max \
  clear_challenger_transient_retry_state \
  challenger_transient_retry_diagnostic_file \
  challenger_transient_retry_result_head \
  challenger_transient_retry_intent_json \
  resolve_challenger_transient_retry_launch_intent \
  record_challenger_transient_retry_contract_failure \
  maybe_retry_challenger_transient_phase \
  challenge_abort_scope_for_failure \
  challenge_abort_pair \
  _challenge_side_for_issue \
  native_hook_terminal_failure_detail \
  native_coding_failure_handoff_reason \
  native_terminal_failure_kind \
  native_terminal_failure_next_action \
  emit_challenge_stage_failure_quarantine \
  get_backoff_delay \
  challenge_result_stage_for_launch \
  challenge_stage_for_launch_env \
  write_openrouter_warning_cache \
  record_openrouter_credits_challenge_abort \
; do
  eval "$(extract_function "$fn")"
done

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"; rm -f /tmp/wavemill-transretry-*.hook 2>/dev/null || true' EXIT

SESSION="transretry"
STATE_FILE="$TMP_ROOT/state.json"
ATTENTION_FILE="$TMP_ROOT/attention.txt"
WARN_FILE="$TMP_ROOT/warn.txt"
STATUS_LOG="$TMP_ROOT/status.txt"
WAVEMILL_STATE_DIR="$TMP_ROOT/wavemill-state"
WORKTREE_ROOT="$TMP_ROOT/worktrees"
BASE_BRANCH="auto/integration"
mkdir -p "$WAVEMILL_STATE_DIR" "$WORKTREE_ROOT"
export WAVEMILL_RELIABILITY_REPO_DIR="$TMP_ROOT/reliability-repo"
active_count=0
CLEANUP_CALLS=""
PREPARE_CALLS=""
LAUNCH_CALLS=""
VALIDATE_CALLS=""
VALIDATE_RC=0

log() { printf '%s\n' "$*" >> "$STATUS_LOG"; }
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
cleanup_quarantined_no_pr_challenge_arm() {
  CLEANUP_CALLS+="$1|$3|$4"$'\n'
  return 0
}
read_stage_status() {
  jq -r '.status // empty' "$1/.${2}-result.json" 2>/dev/null || true
}
stage_result_field() {
  jq -r --arg f "$3" '.[$f] // empty' "$1/.${2}-result.json" 2>/dev/null || true
}
write_stage_result() {
  local feature_dir="$1" stage="$2" status="$3" agent="${4:-}" model="${5:-}" notes="${6:-}" artifacts="${7:-}"
  mkdir -p "$feature_dir"
  jq -n \
    --arg stage "$stage" --arg status "$status" --arg agent "$agent" \
    --arg model "$model" --arg notes "$notes" --argjson artifacts "${artifacts:-null}" \
    '{stage:$stage,status:$status,agent:$agent,model:$model,notes:$notes,artifacts:$artifacts}' \
    > "$feature_dir/.${stage}-result.json"
}
read_phase_config() { printf ''; }
agent_validate_phase_launch() {
  VALIDATE_CALLS+="$1|$2|$3"$'\n'
  return "$VALIDATE_RC"
}
_prepare_recovery_phase_launch() {
  local issue="$1" slug="$2" phase="$3" feature_dir="$4"
  PREPARE_CALLS+="$issue|$phase"$'\n'
  # Real helper rewrites the stage result to running before relaunch.
  write_stage_result "$feature_dir" "$phase" "running" "$6" "$7" "Recovery replay of persisted execution contract"
  return 0
}
launch_planning_phase() { LAUNCH_CALLS+="planning|$1|$7|$8|$9"$'\n'; return 0; }
launch_coding_phase() { LAUNCH_CALLS+="coding|$1|$7|$8|$9"$'\n'; return 0; }
launch_review_phase() { LAUNCH_CALLS+="review|$1|$7|$8|$9"$'\n'; return 0; }

write_hook() {
  local issue="$1" state="$2" detail="$3"
  jq -n --arg s "$state" --arg d "$detail" \
    '{state:$s,event:"process_exit",agent:"native",timestamp:1,detail:$d}' \
    > "/tmp/wavemill-${SESSION}-${issue}.hook"
}

real_challenge_intent() {
  npx tsx "$REPO_DIR/tests/fixtures/build-challenge-intent.ts" "$@"
}

# Seed both arms of the pair; slug/worktree/branch details attach to the arm
# under test ($issue) so relaunch inputs resolve from workflow state.
seed() {
  local issue="$1" challenge="${2:-true}" role="${3:-challenger}"
  local slug="$4"
  local challenge_stage="${5:-implementation}"
  local challenger_model="${6:-llama-4-scout}"
  local challenger_agent="${7:-native-openrouter}"
  local primary_model="${8:-claude-opus-4-7}"
  local intent intent_args
  mkdir -p "$WORKTREE_ROOT/$slug"
  jq -n \
    --arg issue "$issue" --arg role "$role" --argjson challenge "$challenge" \
    --arg slug "$slug" --arg worktree "$WORKTREE_ROOT/$slug" --arg branch "task/$slug" \
    '{tasks:{
       "PAIR-9":   {challengePairId:"PAIR-9", challengeRole:"primary",    challenge:$challenge},
       "PAIR-9_c": {challengePairId:"PAIR-9", challengeRole:"challenger", challenge:$challenge}
     }}
     | .tasks[$issue] += {
         challengeRole:$role, slug:$slug, worktree:$worktree,
         branch:$branch, title:"Transient retry fixture"
       }' \
    > "$STATE_FILE"
  if [[ "$challenge" == "true" ]]; then
    intent_args=(--stage "$challenge_stage" --pair-id PAIR-9 --slug "$slug")
    case "$challenge_stage" in
      plan)
        intent_args+=(--primary-planner "$primary_model" --primary-planner-agent claude --challenger-planner "$challenger_model" --challenger-planner-agent "$challenger_agent")
        ;;
      review)
        intent_args+=(--primary-reviewer "$primary_model" --primary-reviewer-agent claude --challenger-reviewer "$challenger_model" --challenger-reviewer-agent "$challenger_agent")
        ;;
      *)
        intent_args+=(--primary-coder "$primary_model" --primary-coder-agent claude --challenger-coder "$challenger_model" --challenger-coder-agent "$challenger_agent")
        ;;
    esac
    intent="$(real_challenge_intent "${intent_args[@]}")"
    jq --argjson intent "$intent" \
      '.tasks["PAIR-9"].challengeExecutionIntent = $intent
       | .tasks["PAIR-9_c"].challengeExecutionIntent = $intent
       | .tasks["PAIR-9"].challengeStage = ($intent.selectedStage // $intent.challengeStage)
       | .tasks["PAIR-9_c"].challengeStage = ($intent.selectedStage // $intent.challengeStage)
       | .tasks["PAIR-9"].challengeVariedModel = ($intent.primary.expectedStageModel // "")
       | .tasks["PAIR-9_c"].challengeVariedModel = ($intent.challenger.expectedStageModel // "")
       | .tasks["PAIR-9"].challengeVariedAgent = ($intent.primary.expectedStageAgent // "")
       | .tasks["PAIR-9_c"].challengeVariedAgent = ($intent.challenger.expectedStageAgent // "")' \
      "$STATE_FILE" > "$STATE_FILE.tmp"
    mv "$STATE_FILE.tmp" "$STATE_FILE"
  fi
  : > "$ATTENTION_FILE"
  : > "$WARN_FILE"
  : > "$STATUS_LOG"
  CLEANUP_CALLS=""
  PREPARE_CALLS=""
  LAUNCH_CALLS=""
  VALIDATE_CALLS=""
}

transient_detail="Native coding failed: provider-transient-error: Upstream idle timeout exceeded"
config_detail="Native coding failed: 401 Unauthorized"

echo "=== Challenger Transient Phase Relaunch (HOK-2885) ==="

# ── First observation starts the backoff clock, nothing stamped ───────
seed "PAIR-9_c" true challenger "slug-first"
fd="$TMP_ROOT/f-first"
write_stage_result "$fd" "coding" "failed" "native" "llama-4-scout" "$transient_detail"
rm -f "/tmp/wavemill-${SESSION}-PAIR-9_c.hook"

rc=0
maybe_retry_challenger_transient_phase "PAIR-9_c" "$fd" "coding" "win-first" || rc=$?
if [[ "$rc" -eq 2 ]] \
  && [[ -z "$LAUNCH_CALLS" ]] \
  && [[ "$(jq -r '.count' "$fd/.challenger-transient-retries.json")" == "0" ]] \
  && [[ "$(jq -r '.stage' "$fd/.challenger-transient-retries.json")" == "coding" ]] \
  && [[ "$(jq -r '.tasks["PAIR-9_c"].challengeAborted // "none"' "$STATE_FILE")" == "none" ]] \
  && [[ "$(jq -r '.tasks["PAIR-9"].challengeAborted // "none"' "$STATE_FILE")" == "none" ]]; then
  pass "first transient failure starts backoff without stamping either arm"
else
  fail "first transient failure handling wrong (rc=$rc)"
fi

# ── Backoff not yet elapsed → still waiting ───────────────────────────
rc=0
maybe_retry_challenger_transient_phase "PAIR-9_c" "$fd" "coding" "win-first" || rc=$?
if [[ "$rc" -eq 2 ]] && [[ -z "$LAUNCH_CALLS" ]]; then
  pass "backoff window returns waiting with no relaunch"
else
  fail "backoff window handling wrong (rc=$rc)"
fi

# ── Backoff elapsed → relaunch, counter incremented, stage re-armed ───
jq -n '{stage:"coding",count:0,lastAt:1}' > "$fd/.challenger-transient-retries.json"
write_hook "PAIR-9_c" "error" "$transient_detail"
rc=0
maybe_retry_challenger_transient_phase "PAIR-9_c" "$fd" "coding" "win-first" || rc=$?
if [[ "$rc" -eq 0 ]] \
  && [[ "$LAUNCH_CALLS" == *"coding|PAIR-9_c|llama-4-scout|native-openrouter|medium"* ]] \
  && [[ "$VALIDATE_CALLS" == *"native-openrouter|coding|llama-4-scout"* ]] \
  && [[ "$PREPARE_CALLS" == *"PAIR-9_c|coding"* ]] \
  && [[ "$(jq -r '.count' "$fd/.challenger-transient-retries.json")" == "1" ]] \
  && [[ "$(read_stage_status "$fd" "coding")" == "running" ]] \
  && [[ "$(jq -r '.tasks["PAIR-9_c"].challengeAborted // "none"' "$STATE_FILE")" == "none" ]] \
  && [[ "$(jq -r '.tasks["PAIR-9"].challengeAborted // "none"' "$STATE_FILE")" == "none" ]] \
  && grep -q 'win-first=clear' "$ATTENTION_FILE" \
  && grep -q 'challenger_transient_retry attempt=1/3' "$STATUS_LOG"; then
  pass "elapsed backoff relaunches the phase and re-arms the stage result"
else
  fail "relaunch handling wrong (rc=$rc, launches=$LAUNCH_CALLS)"
fi
rc=0
maybe_retry_challenger_transient_phase "PAIR-9_c" "$fd" "coding" "win-first" || rc=$?
if [[ "$(jq -r '.count' "$fd/.challenger-transient-retries.json")" == "1" ]] \
  && [[ "$(printf '%s' "$LAUNCH_CALLS" | grep -c '^coding|')" == "1" ]]; then
  pass "duplicate callback after relaunch does not claim another attempt"
else
  fail "duplicate callback claimed another launch (rc=$rc)"
fi
# The stale terminal-error hook must be cleared so the running-stage failure
# detector cannot re-quarantine the relaunched arm before its first hook write.
if [[ ! -f "/tmp/wavemill-${SESSION}-PAIR-9_c.hook" ]]; then
  pass "relaunch clears the stale terminal error hook"
else
  fail "stale terminal error hook survived the relaunch"
fi

# ── Stage change resets the counter ───────────────────────────────────
seed "PAIR-9_c" true challenger "slug-stage-reset" review "kimi-k2.7-code" native-openrouter
fd="$TMP_ROOT/f-stage-reset"
write_stage_result "$fd" "review" "failed" "native" "kimi-k2.7-code" "$transient_detail"
jq -n '{stage:"coding",count:3,lastAt:1}' > "$fd/.challenger-transient-retries.json"
rc=0
maybe_retry_challenger_transient_phase "PAIR-9_c" "$fd" "review" "win-stage" || rc=$?
if [[ "$rc" -eq 2 ]] \
  && [[ "$(jq -r '.stage' "$fd/.challenger-transient-retries.json")" == "review" ]] \
  && [[ "$(jq -r '.count' "$fd/.challenger-transient-retries.json")" == "0" ]]; then
  pass "a new stage gets a fresh retry budget"
else
  fail "stage change did not reset the counter (rc=$rc)"
fi

# ── Budget exhausted → single-side abort ──────────────────────────────
seed "PAIR-9_c" true challenger "slug-exhausted"
fd="$TMP_ROOT/f-exhausted"
write_stage_result "$fd" "coding" "failed" "native" "llama-4-scout" "$transient_detail"
jq -n '{stage:"coding",count:3,lastAt:1}' > "$fd/.challenger-transient-retries.json"
rc=0
maybe_retry_challenger_transient_phase "PAIR-9_c" "$fd" "coding" "win-exhausted" || rc=$?
reliability_file="$WAVEMILL_RELIABILITY_REPO_DIR/.wavemill/evals/reliability-records.jsonl"
if [[ "$rc" -eq 1 ]] \
  && [[ -z "$LAUNCH_CALLS" ]] \
  && [[ "$(jq -r '.tasks["PAIR-9_c"].challengeAborted' "$STATE_FILE")" == "retry_exhausted:provider-transient-error" ]] \
  && [[ "$(jq -r '.tasks["PAIR-9_c"].challengeAbortedDetail' "$STATE_FILE")" == *"attempts=3"* ]] \
  && [[ "$(jq -r '.tasks["PAIR-9"] | has("challengeAborted")' "$STATE_FILE")" == "false" ]] \
  && [[ "$(jq -r '.tasks["PAIR-9"] | has("challengeAbortedDetail")' "$STATE_FILE")" == "false" ]] \
  && [[ "$(jq -r '.challengePairAbortions["PAIR-9"].challenger.reason' "$STATE_FILE")" == "retry_exhausted:provider-transient-error" ]] \
  && [[ "$(jq -r '.challengePairAbortions["PAIR-9"].challenger.scope' "$STATE_FILE")" == "single" ]] \
  && [[ -f "$fd/.challenge-aborted.json" ]] \
  && [[ "$(jq -r '.role' "$fd/.challenge-aborted.json")" == "challenger" ]] \
  && [[ "$CLEANUP_CALLS" == *"PAIR-9_c|coding|retry_exhausted:provider-transient-error"* ]]; then
  pass "exhausted budget aborts only the challenger"
else
  fail "exhausted budget handling wrong (rc=$rc)"
fi
if [[ -f "$reliability_file" ]] \
  && [[ "$(jq -r 'select(.issueId == "PAIR-9_c") | .challengeRole' "$reliability_file" | tail -n 1)" == "challenger" ]] \
  && [[ "$(jq -r 'select(.issueId == "PAIR-9_c") | .faultClass' "$reliability_file" | tail -n 1)" == "provider-fault" ]]; then
  pass "exhaustion records a challenger-side provider-fault reliability record"
else
  fail "exhaustion reliability record missing or misattributed"
fi

# The caller's quarantine fall-through must then be an idempotent no-op.
if emit_challenge_stage_failure_quarantine "PAIR-9_c" "$fd" "coding" "win-exhausted"; then
  fail "quarantine fall-through re-fired on the already-aborted challenger"
else
  pass "quarantine fall-through is idempotent after exhaustion"
fi

# ── Non-transient failure → not applicable, pair-wide quarantine ──────
seed "PAIR-9_c" true challenger "slug-config"
fd="$TMP_ROOT/f-config"
write_stage_result "$fd" "coding" "failed" "native" "llama-4-scout" "$config_detail"
rc=0
maybe_retry_challenger_transient_phase "PAIR-9_c" "$fd" "coding" "win-config" || rc=$?
if [[ "$rc" -eq 1 ]] && [[ ! -f "$fd/.challenger-transient-retries.json" ]] && [[ -z "$LAUNCH_CALLS" ]]; then
  pass "non-transient failure is not retried"
else
  fail "non-transient failure handling wrong (rc=$rc)"
fi
if emit_challenge_stage_failure_quarantine "PAIR-9_c" "$fd" "coding" "win-config"; then
  if [[ "$(jq -r '.tasks["PAIR-9_c"].challengeAborted' "$STATE_FILE")" == "terminal_stage_failure:provider-config-error" ]] \
    && [[ "$(jq -r '.tasks["PAIR-9"].challengeAborted' "$STATE_FILE")" == "terminal_stage_failure:provider-config-error" ]]; then
    pass "non-transient challenger failure still quarantines the whole pair"
  else
    fail "non-transient quarantine did not stamp both arms"
  fi
else
  fail "non-transient quarantine did not fire"
fi

# ── Primary-arm transient failure → not applicable, pair-wide ─────────
seed "PAIR-9" true primary "slug-primary"
fd="$TMP_ROOT/f-primary"
write_stage_result "$fd" "coding" "failed" "native" "claude-opus-4-7" "$transient_detail"
rc=0
maybe_retry_challenger_transient_phase "PAIR-9" "$fd" "coding" "win-primary" || rc=$?
if [[ "$rc" -eq 1 ]] && [[ -z "$LAUNCH_CALLS" ]]; then
  pass "primary transient failure is not retried"
else
  fail "primary transient failure handling wrong (rc=$rc)"
fi
if emit_challenge_stage_failure_quarantine "PAIR-9" "$fd" "coding" "win-primary"; then
  if [[ "$(jq -r '.tasks["PAIR-9"].challengeAborted' "$STATE_FILE")" == "terminal_stage_failure:provider-transient-error" ]] \
    && [[ "$(jq -r '.tasks["PAIR-9_c"].challengeAborted' "$STATE_FILE")" == "terminal_stage_failure:provider-transient-error" ]]; then
    pass "primary transient failure keeps today's pair-wide quarantine"
  else
    fail "primary transient quarantine did not stamp both arms"
  fi
else
  fail "primary transient quarantine did not fire"
fi

# ── Non-challenge task → function not applicable ──────────────────────
seed "PAIR-9_c" false challenger "slug-solo"
fd="$TMP_ROOT/f-solo"
write_stage_result "$fd" "coding" "failed" "native" "kimi-k2" "$transient_detail"
rc=0
maybe_retry_challenger_transient_phase "PAIR-9_c" "$fd" "coding" "win-solo" || rc=$?
if [[ "$rc" -eq 1 ]] && [[ ! -f "$fd/.challenger-transient-retries.json" ]] && [[ -z "$LAUNCH_CALLS" ]]; then
  pass "non-challenge tasks are not applicable"
else
  fail "non-challenge task handling wrong (rc=$rc)"
fi

# ── Relaunch validation failure fails closed before launch ────────────
seed "PAIR-9_c" true challenger "slug-novalidate"
fd="$TMP_ROOT/f-novalidate"
write_stage_result "$fd" "coding" "failed" "native" "llama-4-scout" "$transient_detail"
jq -n '{stage:"coding",count:1,lastAt:1}' > "$fd/.challenger-transient-retries.json"
VALIDATE_RC=1
rc=0
maybe_retry_challenger_transient_phase "PAIR-9_c" "$fd" "coding" "win-novalidate" || rc=$?
VALIDATE_RC=0
if [[ "$rc" -eq 1 ]] \
  && [[ -z "$LAUNCH_CALLS" ]] \
  && [[ "$(jq -r '.tasks["PAIR-9_c"].challengeAborted' "$STATE_FILE")" == "retry_contract_invalid:unsupported_launch_identity" ]] \
  && [[ "$(jq -r '.reason' "$fd/.challenger-transient-retry-diagnostic.json")" == "retry_contract_invalid:unsupported_launch_identity" ]]; then
  pass "unlaunchable retry fails closed with a typed contract reason"
else
  fail "unlaunchable retry handling wrong (rc=$rc)"
fi

# ── Missing/corrupt intent fails closed without consuming retry budget ──
seed "PAIR-9_c" true challenger "slug-missing-intent"
fd="$TMP_ROOT/f-missing-intent"
write_stage_result "$fd" "coding" "failed" "native" "llama-4-scout" "$transient_detail"
jq -n '{stage:"coding",count:1,lastAt:1}' > "$fd/.challenger-transient-retries.json"
jq 'del(.tasks["PAIR-9_c"].challengeExecutionIntent)' "$STATE_FILE" > "$STATE_FILE.tmp"
mv "$STATE_FILE.tmp" "$STATE_FILE"
rc=0
maybe_retry_challenger_transient_phase "PAIR-9_c" "$fd" "coding" "win-missing-intent" || rc=$?
if [[ "$rc" -eq 1 ]] \
  && [[ -z "$LAUNCH_CALLS" ]] \
  && [[ "$(jq -r '.count' "$fd/.challenger-transient-retries.json")" == "1" ]] \
  && [[ "$(jq -r '.tasks["PAIR-9_c"].challengeAborted' "$STATE_FILE")" == "retry_contract_invalid:missing_challenge_intent" ]]; then
  pass "missing intent fails closed without incrementing retry count"
else
  fail "missing intent handling wrong (rc=$rc)"
fi

seed "PAIR-9_c" true challenger "slug-invalid-intent"
fd="$TMP_ROOT/f-invalid-intent"
write_stage_result "$fd" "coding" "failed" "native" "llama-4-scout" "$transient_detail"
jq -n '{stage:"coding",count:1,lastAt:1}' > "$fd/.challenger-transient-retries.json"
jq 'del(.tasks["PAIR-9_c"].challengeExecutionIntent)' "$STATE_FILE" > "$STATE_FILE.tmp"
mv "$STATE_FILE.tmp" "$STATE_FILE"
printf '{bad\n' > "$fd/challenge-intent.json"
rc=0
maybe_retry_challenger_transient_phase "PAIR-9_c" "$fd" "coding" "win-invalid-intent" || rc=$?
if [[ "$rc" -eq 1 ]] \
  && [[ -z "$LAUNCH_CALLS" ]] \
  && [[ "$(jq -r '.count' "$fd/.challenger-transient-retries.json")" == "1" ]] \
  && [[ "$(jq -r '.tasks["PAIR-9_c"].challengeAborted' "$STATE_FILE")" == "retry_contract_invalid:invalid_challenge_intent_json" ]]; then
  pass "invalid intent JSON fails closed without incrementing retry count"
else
  fail "invalid intent handling wrong (rc=$rc)"
fi

seed "PAIR-9_c" true challenger "slug-corrupt-intent"
fd="$TMP_ROOT/f-corrupt-intent"
write_stage_result "$fd" "coding" "failed" "native" "llama-4-scout" "$transient_detail"
jq -n '{stage:"coding",count:1,lastAt:1}' > "$fd/.challenger-transient-retries.json"
jq '.tasks["PAIR-9_c"].challengeExecutionIntent.challenger.expectedStageAgent = "native"' "$STATE_FILE" > "$STATE_FILE.tmp"
mv "$STATE_FILE.tmp" "$STATE_FILE"
rc=0
maybe_retry_challenger_transient_phase "PAIR-9_c" "$fd" "coding" "win-corrupt-intent" || rc=$?
if [[ "$rc" -eq 1 ]] \
  && [[ -z "$LAUNCH_CALLS" ]] \
  && [[ "$(jq -r '.count' "$fd/.challenger-transient-retries.json")" == "1" ]] \
  && [[ "$(jq -r '.tasks["PAIR-9_c"].challengeAborted' "$STATE_FILE")" == "retry_contract_invalid:ambiguous_launch_agent" ]]; then
  pass "ambiguous native launch identity fails closed before validation"
else
  fail "ambiguous launch identity handling wrong (rc=$rc)"
fi

# ── Stale-head callback fails closed before touching current-head counter ─
seed "PAIR-9_c" true challenger "slug-stale-head"
fd="$TMP_ROOT/f-stale-head"
git -C "$WORKTREE_ROOT/slug-stale-head" init -q
git -C "$WORKTREE_ROOT/slug-stale-head" config user.email test@example.com
git -C "$WORKTREE_ROOT/slug-stale-head" config user.name Test
printf 'seed\n' > "$WORKTREE_ROOT/slug-stale-head/file.txt"
git -C "$WORKTREE_ROOT/slug-stale-head" add file.txt
git -C "$WORKTREE_ROOT/slug-stale-head" commit -qm seed
current_head="$(git -C "$WORKTREE_ROOT/slug-stale-head" rev-parse HEAD)"
write_stage_result "$fd" "coding" "failed" "native" "llama-4-scout" "$transient_detail" '{"headSha":"stale-head"}'
jq -n --arg head "$current_head" '{stage:"coding",head:$head,count:1,lastAt:1}' > "$fd/.challenger-transient-retries.json"
rc=0
maybe_retry_challenger_transient_phase "PAIR-9_c" "$fd" "coding" "win-stale-head" || rc=$?
if [[ "$rc" -eq 1 ]] \
  && [[ -z "$LAUNCH_CALLS" ]] \
  && [[ "$(jq -r '.count' "$fd/.challenger-transient-retries.json")" == "1" ]] \
  && [[ "$(jq -r '.tasks["PAIR-9_c"].challengeAborted' "$STATE_FILE")" == "retry_intent_mismatch:stale_head" ]]; then
  pass "stale-head retry callback fails closed without mutating retry count"
else
  fail "stale-head handling wrong (rc=$rc)"
fi

# ── Hook detail is preferred over stage notes ─────────────────────────
seed "PAIR-9_c" true challenger "slug-hook"
fd="$TMP_ROOT/f-hook"
write_stage_result "$fd" "coding" "failed" "native" "gemini-2.5-pro" "no useful notes"
write_hook "PAIR-9_c" "error" "Upstream idle timeout exceeded"
rc=0
maybe_retry_challenger_transient_phase "PAIR-9_c" "$fd" "coding" "win-hook" || rc=$?
rm -f "/tmp/wavemill-${SESSION}-PAIR-9_c.hook"
if [[ "$rc" -eq 2 ]] && [[ -f "$fd/.challenger-transient-retries.json" ]]; then
  pass "terminal hook detail classifies the failure when stage notes are unhelpful"
else
  fail "hook detail preference wrong (rc=$rc)"
fi

# ── clear helper removes the counter ──────────────────────────────────
clear_challenger_transient_retry_state "$fd"
if [[ ! -f "$fd/.challenger-transient-retries.json" ]]; then
  pass "clear_challenger_transient_retry_state removes the counter file"
else
  fail "counter file survived clear"
fi

# ── Retry max is validated ────────────────────────────────────────────
if [[ "$(challenger_transient_retry_max)" == "3" ]] \
  && [[ "$(WAVEMILL_CHALLENGER_TRANSIENT_RETRY_MAX=5 challenger_transient_retry_max)" == "5" ]] \
  && [[ "$(WAVEMILL_CHALLENGER_TRANSIENT_RETRY_MAX=bogus challenger_transient_retry_max)" == "3" ]]; then
  pass "retry max defaults to 3 and rejects non-integer overrides"
else
  fail "retry max validation wrong"
fi

echo
echo "--- Results: $PASS passed, $FAIL failed ---"
[[ "$FAIL" -eq 0 ]]
