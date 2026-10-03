#!/usr/bin/env bash
# Regression coverage for hook-driven terminal native failure handling.
#
# Background: a provider that accepts the launch and then rejects the request
# (unknown model ID, prompt larger than the context window) produces none of the
# exec-level signatures the pane-scraping heuristics look for. Those arms stayed
# in `phase: coding` indefinitely and blocked the merge lane. The agent's status
# hook records the failure as {"state":"error"}; the monitor now consumes it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

# Extracted monitor helpers depend on the shared marker lifecycle module.
# shellcheck source=../shared/lib/transient-marker.sh
source "$REPO_DIR/shared/lib/transient-marker.sh"

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

eval "$(extract_function native_hook_terminal_failure_detail)"
eval "$(extract_function native_coding_failure_handoff_reason)"
eval "$(extract_function native_terminal_failure_kind)"
eval "$(extract_function native_terminal_failure_next_action)"
eval "$(extract_function agent_or_model_is_native_for_recovery)"
eval "$(extract_function emit_native_terminal_failure_attention)"
eval "$(extract_function emit_challenge_stage_failure_quarantine)"
eval "$(extract_function write_openrouter_warning_cache)"
eval "$(extract_function record_openrouter_credits_challenge_abort)"
eval "$(extract_function challenge_abort_pair)"
eval "$(extract_function challenge_abort_scope_for_failure)"
eval "$(extract_function _challenge_side_for_issue)"

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

SESSION="testsess"
STATE_FILE="$TMP_ROOT/state.json"
ATTENTION_FILE="$TMP_ROOT/attention.txt"
WARN_FILE="$TMP_ROOT/warn.txt"
WAVEMILL_STATE_DIR="$TMP_ROOT/wavemill-state"
mkdir -p "$WAVEMILL_STATE_DIR"
active_count=0
export WAVEMILL_RELIABILITY_REPO_DIR="$TMP_ROOT/reliability-repo"
CLEANUP_CALLS=""

log_warn() { printf '%s\n' "$1" >> "$WARN_FILE"; }
# HOK-3100: monitor helpers now resolve tool paths through this install-rooted
# helper (wavemill-common.sh), which the extracted monitor functions call but
# this test does not source. Stub mirrors the real helper's semantics.
wavemill_tool_path() { printf '%s/%s\n' "${TOOLS_DIR:-$REPO_DIR/tools}" "$1"; }
set_window_attention_state() { printf '%s=%s\n' "$1" "$2" >> "$ATTENTION_FILE"; }
challenge_result_stage_for_launch() { printf '%s\n' "${1/#coding/coding}"; }
challenge_stage_for_launch_env() { printf '%s\n' "$1"; }
state_mutate() {
  local state_path="$1" filter="$2"
  shift 2
  jq "$@" "$filter" "$state_path" > "$state_path.tmp"
  mv "$state_path.tmp" "$state_path"
}
get_task_meta() {
  jq -r --arg issue "$1" --arg field "$2" '.tasks[$issue][$field] // empty' "$STATE_FILE"
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

write_hook() {
  local issue="$1" state="$2" detail="$3"
  jq -n --arg s "$state" --arg d "$detail" \
    '{state:$s,event:"process_exit",agent:"native",timestamp:1,detail:$d}' \
    > "/tmp/wavemill-${SESSION}-${issue}.hook"
}

seed() {
  local issue="$1" challenge="${2:-true}"
  cat > "$STATE_FILE" <<JSON
{
  "tasks": {
    "$issue":    { "challengePairId": "PAIR-1", "challengeRole": "challenger", "challenge": $challenge },
    "PAIR-1":    { "challengePairId": "PAIR-1", "challengeRole": "primary",    "challenge": $challenge }
  }
}
JSON
  : > "$ATTENTION_FILE"
  : > "$WARN_FILE"
}

echo "=== Native Terminal Failure Handling ==="

# ── Classifier ────────────────────────────────────────────────────────
ctx_detail="Native coding failed: 400 This endpoint's maximum context length is 131072 tokens. However, you requested about 131182 tokens"
preflight_ctx_detail="Native coding pre-flight rejected the launch: estimated prompt is ~98414 input tokens plus 32768 reserved output tokens = 131182, which exceeds the 131072-token context window of moonshotai/kimi-k2 (openrouter, limit from registry). The provider would reject this request (context_length_exceeded)."
bad_model_detail="Native coding failed: 400 qwen-2.5-coder-32b is not a valid model ID"
tool_use_detail="Native coding failed: 404 No endpoints found that support tool use"
credits_detail="Native coding failed: HTTP 402 Payment Required: This request requires more credits, or fewer max_tokens. You requested up to 32768 tokens, but can only afford 1123."
# HOK-3155: OpenRouter's current wording for a drained account; the key limit is
# not binding and the balance alone forbids the request.
credits_detail_exceed="Native coding failed: HTTP 402 This request would exceed your available credits given your current in-flight requests. Retry after in-flight requests settle, or add credits."
empty_turn_detail="Native coding failed: empty-model-turn: model returned reasoning-only or otherwise empty assistant turns after a continuation prompt"
context_exhausted_detail="Native coding failed: context-exhausted: compacted native coding context to the floor and still exceeded the model context window"
transient_detail="Native coding failed: Provider finish_reason: error"

if [[ "$(native_terminal_failure_kind "$ctx_detail")" == "context-window-exceeded" ]]; then
  pass "context overflow is classified"
else
  fail "context overflow misclassified as $(native_terminal_failure_kind "$ctx_detail")"
fi

if [[ "$(native_terminal_failure_kind "$preflight_ctx_detail")" == "context-window-exceeded" ]]; then
  pass "pre-flight context overflow is classified"
else
  fail "pre-flight context overflow misclassified as $(native_terminal_failure_kind "$preflight_ctx_detail")"
fi

if [[ "$(native_terminal_failure_kind "$context_exhausted_detail")" == "context-exhausted" ]]; then
  pass "context exhaustion is classified distinctly"
else
  fail "context exhaustion misclassified as $(native_terminal_failure_kind "$context_exhausted_detail")"
fi

if [[ "$(native_terminal_failure_kind "$bad_model_detail")" == "provider-config-error" ]]; then
  pass "invalid model ID is classified"
else
  fail "invalid model ID misclassified as $(native_terminal_failure_kind "$bad_model_detail")"
fi

if [[ "$(native_terminal_failure_kind "$tool_use_detail")" == "tool-use-unsupported" ]]; then
  pass "unsupported tool use is classified"
else
  fail "unsupported tool use misclassified as $(native_terminal_failure_kind "$tool_use_detail")"
fi

if [[ "$(native_terminal_failure_kind "$credits_detail")" == "provider-credit-exhausted" ]]; then
  pass "OpenRouter credit exhaustion is classified"
else
  fail "OpenRouter credit exhaustion misclassified as $(native_terminal_failure_kind "$credits_detail")"
fi

# HOK-3155: the "exceed your available credits" wording also classifies.
if [[ "$(native_terminal_failure_kind "$credits_detail_exceed")" == "provider-credit-exhausted" ]]; then
  pass "exceed-your-available-credits 402 is classified as provider-credit-exhausted"
else
  fail "exceed-your-available-credits 402 misclassified as $(native_terminal_failure_kind "$credits_detail_exceed")"
fi

if [[ "$(native_terminal_failure_kind "$transient_detail")" == "provider-transient-error" ]]; then
  pass "transient provider errors are classified"
else
  fail "transient provider error misclassified as $(native_terminal_failure_kind "$transient_detail")"
fi

if [[ "$(native_terminal_failure_kind "$empty_turn_detail")" == "empty-model-turn" ]]; then
  pass "empty model turns are classified"
else
  fail "empty model turns misclassified as $(native_terminal_failure_kind "$empty_turn_detail")"
fi

if [[ "$(native_terminal_failure_kind "something else entirely")" == "native-unclassified" ]]; then
  pass "unrecognised failures without typed evidence fall back to native-unclassified"
else
  fail "untyped unrecognised failure misclassified as $(native_terminal_failure_kind "something else entirely")"
fi

if [[ "$(native_terminal_failure_next_action context-window-exceeded)" == *"compressed context"* ]]; then
  pass "context overflow surfaces a specific recovery action"
else
  fail "context overflow recovery action missing"
fi

if [[ "$(native_terminal_failure_next_action context-exhausted)" == *"larger-context model"* ]]; then
  pass "context exhaustion surfaces a resumable recovery action"
else
  fail "context exhaustion recovery action missing"
fi

if [[ "$(native_terminal_failure_next_action provider-credit-exhausted)" == *"Top up OpenRouter credits"* || "$(native_terminal_failure_next_action provider-credit-exhausted)" == *"top up OpenRouter credits"* ]]; then
  pass "OpenRouter credit exhaustion surfaces a billing recovery action"
else
  fail "OpenRouter credit exhaustion recovery action missing"
fi

if [[ "$(native_terminal_failure_next_action empty-model-turn)" == *"bounded continuation"* ]]; then
  pass "empty model turn surfaces a specific recovery action"
else
  fail "empty model turn recovery action missing"
fi

# ── Context overflow end-to-end ───────────────────────────────────────
seed "PAIR-1_c"
fd="$TMP_ROOT/f-ctx"
write_stage_result "$fd" "coding" "running" "native" "kimi-k2"
write_hook "PAIR-1_c" "error" "$ctx_detail"

if emit_native_terminal_failure_attention "PAIR-1_c" "$fd" "coding" "win-1" "%1" "native" "kimi-k2"; then
  if [[ "$(jq -r '.status' "$fd/.coding-result.json")" == "failed" ]] \
    && [[ "$(jq -r '.artifacts.failureKind' "$fd/.coding-result.json")" == "context-window-exceeded" ]] \
    && [[ "$(jq -r '.artifacts.nextAction' "$fd/.coding-result.json")" == *"compressed context"* ]] \
    && grep -q 'win-1=needs-user' "$ATTENTION_FILE"; then
    pass "context overflow marks the stage failed with a recovery action"
  else
    fail "context overflow stage side effects incomplete"
  fi
else
  fail "context overflow was not detected"
fi

# Both arms of the pair must be quarantined: a dead arm invalidates the comparison.
if [[ "$(jq -r '.tasks["PAIR-1_c"].challengeAborted' "$STATE_FILE")" == "terminal_launch_failure:context-window-exceeded" ]] \
  && [[ "$(jq -r '.tasks["PAIR-1"].challengeAborted' "$STATE_FILE")" == "terminal_launch_failure:context-window-exceeded" ]] \
  && [[ "$(jq -r '.tasks["PAIR-1_c"].challengeAbortedStage' "$STATE_FILE")" == "coding" ]] \
  && [[ -f "$fd/.challenge-aborted.json" ]] \
  && [[ "$(jq -r '.nextAction' "$fd/.challenge-aborted.json")" == *"compressed context"* ]]; then
  pass "context overflow quarantines both challenge arms"
else
  fail "challenge pair was not quarantined on context overflow"
fi

# ── Tool-use unsupported end-to-end ───────────────────────────────────
seed "PAIR-1_c"
fd="$TMP_ROOT/f-tool-use"
write_stage_result "$fd" "coding" "running" "native" "qwen-2.5-coder-32b"
write_hook "PAIR-1_c" "error" "$tool_use_detail"

if emit_native_terminal_failure_attention "PAIR-1_c" "$fd" "coding" "win-tool" "%3" "native" "qwen-2.5-coder-32b"; then
  reliability_file="$WAVEMILL_RELIABILITY_REPO_DIR/.wavemill/evals/reliability-records.jsonl"
  if [[ "$(jq -r '.artifacts.failureKind' "$fd/.coding-result.json")" == "tool-use-unsupported" ]] \
    && [[ "$(jq -r '.tasks["PAIR-1_c"].challengeAborted' "$STATE_FILE")" == "terminal_launch_failure:tool-use-unsupported" ]] \
    && [[ -f "$reliability_file" ]] \
    && [[ "$(jq -r 'select(.issueId == "PAIR-1_c") | .faultClass' "$reliability_file" | tail -n 1)" == "selection-fault" ]]; then
    pass "unsupported tool use quarantines and records reliability"
  else
    fail "unsupported tool use side effects incomplete"
  fi
else
  fail "unsupported tool use was not detected"
fi

# HOK-3155: the first classified credit abort trips the warning cache, so the
# dashboard surfaces the loss of challenge coverage immediately rather than
# after a count. The abort-count file is still bumped for diagnostic grep
# attribution, and repeat aborts remain idempotent.
rm -f "/tmp/${SESSION}-openrouter-warning.txt" "$WAVEMILL_STATE_DIR/openrouter-credits-abort-count"
seed "PAIR-1_c"
fd="$TMP_ROOT/f-credits-1"
challenge_abort_pair "PAIR-1_c" "$fd" "win-credits-1" "coding" "glm-5.2" "terminal_launch_failure:openrouter-credits-exhausted" "$credits_detail" "top up OpenRouter credits" || true
if [[ "$(cat "/tmp/${SESSION}-openrouter-warning.txt" 2>/dev/null)" == *"challenge coverage disabled"* ]]; then
  pass "first OpenRouter credit abort writes aggregate warning (HOK-3155)"
else
  fail "first OpenRouter credit abort did not write aggregate warning"
fi

seed "PAIR-1_c"
fd="$TMP_ROOT/f-credits-2"
challenge_abort_pair "PAIR-1_c" "$fd" "win-credits-2" "coding" "gemini-2.5-pro" "terminal_launch_failure:openrouter-credits-exhausted" "$credits_detail" "top up OpenRouter credits" || true
if [[ "$(cat "/tmp/${SESSION}-openrouter-warning.txt" 2>/dev/null)" == *"challenge coverage disabled"* ]]; then
  pass "repeated OpenRouter credit aborts keep aggregate warning (idempotent)"
else
  fail "repeated OpenRouter credit aborts cleared aggregate warning"
fi

# HOK-3155: provider-credit-exhausted (today's canonical reason spelling) must
# also trip the circuit — the dispatcher used to match only the legacy
# openrouter-credits-exhausted substring.
rm -f "/tmp/${SESSION}-openrouter-warning.txt" "$WAVEMILL_STATE_DIR/openrouter-credits-abort-count"
seed "PAIR-1_c"
fd="$TMP_ROOT/f-credits-provider-exhausted"
challenge_abort_pair "PAIR-1_c" "$fd" "win-credits-provider" "coding" "qwen-3-coder" "terminal_launch_failure:provider-credit-exhausted" "$credits_detail_exceed" "top up OpenRouter credits" || true
if [[ "$(cat "/tmp/${SESSION}-openrouter-warning.txt" 2>/dev/null)" == *"challenge coverage disabled"* ]]; then
  pass "provider-credit-exhausted reason trips the warning cache"
else
  fail "provider-credit-exhausted reason did not trip the warning cache"
fi

# ── Invalid model ID end-to-end ───────────────────────────────────────
seed "PAIR-1_c"
fd="$TMP_ROOT/f-model"
write_stage_result "$fd" "coding" "running" "native" "qwen-2.5-coder-32b"
write_hook "PAIR-1_c" "error" "$bad_model_detail"

if emit_native_terminal_failure_attention "PAIR-1_c" "$fd" "coding" "win-2" "%2" "native" "qwen-2.5-coder-32b"; then
  if [[ "$(jq -r '.artifacts.failureKind' "$fd/.coding-result.json")" == "provider-config-error" ]] \
    && [[ "$(jq -r '.tasks["PAIR-1"].challengeAborted' "$STATE_FILE")" == "terminal_launch_failure:provider-config-error" ]]; then
    pass "invalid model ID fails the stage and quarantines the pair"
  else
    fail "invalid model ID side effects incomplete"
  fi
else
  fail "invalid model ID was not detected"
fi

# ── Transient hook failure while running: challenger-only quarantine ──
# HOK-2885: an upstream idle-timeout stall on the challenger must not stamp
# the healthy primary, so the pair stays resolvable by forfeit.
seed "PAIR-1_c"
fd="$TMP_ROOT/f-transient-running"
write_stage_result "$fd" "coding" "running" "native" "llama-4-maverick"
write_hook "PAIR-1_c" "error" "provider-transient-error: Upstream idle timeout exceeded"
if emit_native_terminal_failure_attention "PAIR-1_c" "$fd" "coding" "win-transient" "%9" "native" "llama-4-maverick"; then
  if [[ "$(jq -r '.tasks["PAIR-1_c"].challengeAborted' "$STATE_FILE")" == "terminal_launch_failure:provider-transient-error" ]] \
    && [[ "$(jq -r '.tasks["PAIR-1"] | has("challengeAborted")' "$STATE_FILE")" == "false" ]] \
    && [[ -f "$fd/.challenge-aborted.json" ]]; then
    pass "running-stage transient challenger failure quarantines the challenger only"
  else
    fail "running-stage transient challenger scoping wrong"
  fi
else
  fail "running-stage transient challenger failure was not detected"
fi

# ── Guards ────────────────────────────────────────────────────────────
# A terminal hook is deliberately NOT TTL-gated, but it must never override a
# run that actually produced its completion artifact.
seed "PAIR-1_c"
fd="$TMP_ROOT/f-complete"
write_stage_result "$fd" "coding" "running" "native" "kimi-k2"
write_hook "PAIR-1_c" "error" "$ctx_detail"
printf '{"stage":"coding","confidence":"high"}\n' > "$fd/.coding-complete"
if emit_native_terminal_failure_attention "PAIR-1_c" "$fd" "coding" "win-3" "%3" "native" "kimi-k2"; then
  fail "terminal handler overrode a completed run"
else
  pass "completion artifact wins over a stale terminal hook"
fi

seed "PAIR-1_c"
fd="$TMP_ROOT/f-working"
write_stage_result "$fd" "coding" "running" "native" "kimi-k2"
write_hook "PAIR-1_c" "working" "Phase 3: editing files"
if emit_native_terminal_failure_attention "PAIR-1_c" "$fd" "coding" "win-4" "%4" "native" "kimi-k2"; then
  fail "a healthy working hook was treated as terminal"
else
  pass "non-error hook states are ignored"
fi

seed "PAIR-1_c"
fd="$TMP_ROOT/f-non-native"
write_stage_result "$fd" "coding" "running" "codex" "claude-opus-4-7"
write_hook "PAIR-1_c" "error" "model_at_capacity: Selected model is at capacity. Please try a different model."
if emit_native_terminal_failure_attention "PAIR-1_c" "$fd" "coding" "win-non-native" "%4" "codex" "claude-opus-4-7"; then
  fail "a non-native terminal hook was treated as a native provider failure"
else
  pass "non-native terminal hooks are ignored by native recovery"
fi

seed "PAIR-1_c"
fd="$TMP_ROOT/f-nohook"
write_stage_result "$fd" "coding" "running" "native" "kimi-k2"
rm -f "/tmp/wavemill-${SESSION}-PAIR-1_c.hook"
if emit_native_terminal_failure_attention "PAIR-1_c" "$fd" "coding" "win-5" "%5" "native" "kimi-k2"; then
  fail "missing hook was treated as terminal"
else
  pass "missing hook file is a no-op"
fi

# Non-challenge tasks fail the stage but must not write challenge quarantine state.
seed "PAIR-1_c" false
fd="$TMP_ROOT/f-solo"
write_stage_result "$fd" "coding" "running" "native" "kimi-k2"
write_hook "PAIR-1_c" "error" "$ctx_detail"
if emit_native_terminal_failure_attention "PAIR-1_c" "$fd" "coding" "win-6" "%6" "native" "kimi-k2"; then
  if [[ "$(jq -r '.status' "$fd/.coding-result.json")" == "failed" ]] \
    && [[ ! -f "$fd/.challenge-aborted.json" ]] \
    && [[ "$(jq -r '.tasks["PAIR-1"].challengeAborted // "none"' "$STATE_FILE")" == "none" ]]; then
    pass "non-challenge tasks fail without challenge quarantine"
  else
    fail "non-challenge task wrote challenge quarantine state"
  fi
else
  fail "non-challenge terminal failure was not detected"
fi

# ── Stage already marked failed by the launcher ───────────────────────
# emit_native_terminal_failure_attention only fires while the stage is still
# `running`. When the native launcher writes its own `failed` result (a provider
# 404, say), that handler never runs — and before this, nothing quarantined the
# pair, so the gate sat at `pair-unresolved:no-comparison` indefinitely.
# This is the real HOK-2771_c shape: qwen-2.5-coder-32b, tool-use 404, status=failed.
seed "PAIR-1_c"
fd="$TMP_ROOT/f-stage-failed"
write_stage_result "$fd" "coding" "failed" "native" "qwen-2.5-coder-32b" "Native coding failed: 404 No endpoints found that support tool use."
write_hook "PAIR-1_c" "error" "Native coding failed: 404 No endpoints found that support tool use. Try disabling \"read_file\"."

# The running-only handler must decline this case.
if emit_native_terminal_failure_attention "PAIR-1_c" "$fd" "coding" "win-7" "%7" "native" "qwen-2.5-coder-32b"; then
  fail "running-only handler fired on an already-failed stage"
else
  pass "running-only handler declines an already-failed stage"
fi

if emit_challenge_stage_failure_quarantine "PAIR-1_c" "$fd" "coding" "win-7"; then
  reliability_file="$WAVEMILL_RELIABILITY_REPO_DIR/.wavemill/evals/reliability-records.jsonl"
  if [[ "$(jq -r '.tasks["PAIR-1_c"].challengeAborted' "$STATE_FILE")" == "terminal_stage_failure:tool-use-unsupported" ]] \
    && [[ "$(jq -r '.tasks["PAIR-1"].challengeAborted' "$STATE_FILE")" == "terminal_stage_failure:tool-use-unsupported" ]] \
    && [[ "$(jq -r '.tasks["PAIR-1_c"].challengeAbortedStage' "$STATE_FILE")" == "coding" ]] \
    && [[ -f "$fd/.challenge-aborted.json" ]] \
    && [[ "$(jq -r 'select(.abortReason == "terminal_stage_failure:tool-use-unsupported") | .faultClass' "$reliability_file" | tail -n 1)" == "selection-fault" ]]; then
    pass "launcher-reported stage failure quarantines both arms"
  else
    fail "stage-failure quarantine side effects incomplete"
  fi
else
  fail "stage-failure quarantine did not fire"
fi

CLEANUP_CALLS=""
seed "PAIR-1_c"
fd="$TMP_ROOT/f-review-stage-failed"
write_stage_result "$fd" "review" "failed" "native" "claude-sonnet-5" "Native review failed: Provider finish_reason: error"
write_hook "PAIR-1_c" "error" "Native review failed: Provider finish_reason: error"
if emit_challenge_stage_failure_quarantine "PAIR-1_c" "$fd" "review" "win-review"; then
  if [[ "$(jq -r '.tasks["PAIR-1_c"].challengeAbortedStage' "$STATE_FILE")" == "review" ]] \
    && [[ "$CLEANUP_CALLS" == *"PAIR-1_c|review|terminal stage failure:provider-transient-error"* ]]; then
    pass "review-stage quarantine schedules aborted cleanup"
  else
    fail "review-stage quarantine did not schedule cleanup"
  fi
  # HOK-2885: a transient challenger fault aborts the challenger only — the
  # healthy primary keeps running so the pair can resolve by forfeit.
  if [[ "$(jq -r '.tasks["PAIR-1_c"].challengeAborted' "$STATE_FILE")" == "terminal_stage_failure:provider-transient-error" ]] \
    && [[ "$(jq -r '.tasks["PAIR-1"] | has("challengeAborted")' "$STATE_FILE")" == "false" ]]; then
    pass "transient challenger failure stamps only the challenger arm"
  else
    fail "transient challenger failure stamped the healthy primary"
  fi
else
  fail "review-stage quarantine did not fire"
fi

# Idempotent: a second cycle must not rewrite an already-quarantined arm.
if emit_challenge_stage_failure_quarantine "PAIR-1_c" "$fd" "coding" "win-7"; then
  fail "stage-failure quarantine re-fired on an already-quarantined arm"
else
  pass "stage-failure quarantine is idempotent"
fi

# Empty/reasoning-only turn exhaustion must be attributable instead of becoming
# an unknown native-provider-error fault.
seed "PAIR-1_c"
fd="$TMP_ROOT/f-empty-turn"
rm -f "/tmp/wavemill-${SESSION}-PAIR-1_c.hook"
write_stage_result "$fd" "coding" "failed" "native" "google/gemini-2.5-pro" "$empty_turn_detail"
if emit_challenge_stage_failure_quarantine "PAIR-1_c" "$fd" "coding" "win-empty"; then
  reliability_file="$WAVEMILL_RELIABILITY_REPO_DIR/.wavemill/evals/reliability-records.jsonl"
  if [[ "$(jq -r '.tasks["PAIR-1_c"].challengeAborted' "$STATE_FILE")" == "terminal_stage_failure:empty-model-turn" ]] \
    && [[ -f "$reliability_file" ]] \
    && [[ "$(jq -r 'select(.abortReason == "terminal_stage_failure:empty-model-turn") | .failureKind' "$reliability_file" | tail -n 1)" == "empty-model-turn" ]] \
    && [[ "$(jq -r 'select(.abortReason == "terminal_stage_failure:empty-model-turn") | .faultClass' "$reliability_file" | tail -n 1)" == "harness-fault" ]]; then
    pass "empty turn exhaustion quarantines with named reliability fault"
  else
    fail "empty turn exhaustion side effects incomplete"
  fi
else
  fail "empty turn stage-failure quarantine did not fire"
fi

# Non-challenge tasks must never gain challenge quarantine state.
seed "PAIR-1_c" false
fd="$TMP_ROOT/f-stage-failed-solo"
write_stage_result "$fd" "coding" "failed" "native" "kimi-k2" "Native coding failed: boom"
if emit_challenge_stage_failure_quarantine "PAIR-1_c" "$fd" "coding" "win-8"; then
  fail "non-challenge task was quarantined"
else
  pass "non-challenge stage failure is not quarantined"
fi

rm -f "/tmp/wavemill-${SESSION}-PAIR-1_c.hook"

echo
echo "--- Results: $PASS passed, $FAIL failed ---"
[[ "$FAIL" -eq 0 ]]
