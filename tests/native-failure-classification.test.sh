#!/usr/bin/env bash
# Regression coverage for the typed-handoff-aware native failure classifier
# (HOK-2933).
#
# Background: native_terminal_failure_kind() classified terminal failures
# purely by substring-matching the hook detail and defaulted everything
# unrecognized to native-provider-error. When the native coding launcher wrote
# a typed .coding-failure-handoff.json (reason: no_completion_artifact,
# invalid_completion_artifact, provider_error), the typed evidence was ignored
# — HOK-2791_c blamed the provider for a model that emitted apply_patch as
# plain assistant text. The classifier now honors the typed reason first and
# defaults untyped unknowns to native-unclassified.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

# The handoff-reason helper shells out to the real TS reader tool.
TOOLS_DIR="$REPO_DIR/tools"

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

eval "$(extract_function native_coding_failure_handoff_reason)"
eval "$(extract_function native_terminal_failure_kind)"
eval "$(extract_function native_terminal_failure_next_action)"
eval "$(extract_function native_hook_terminal_failure_detail)"
eval "$(extract_function agent_or_model_is_native_for_recovery)"
eval "$(extract_function emit_native_terminal_failure_attention)"

TMP_ROOT="$(mktemp -d)"
SESSION="classifysess"
trap 'rm -rf "$TMP_ROOT"; rm -f "/tmp/wavemill-${SESSION}-"*.hook 2>/dev/null || true' EXIT

STATE_FILE="$TMP_ROOT/state.json"
ATTENTION_FILE="$TMP_ROOT/attention.txt"
WARN_FILE="$TMP_ROOT/warn.txt"
active_count=0

# ── Mocks for the end-to-end emit_native_terminal_failure_attention run ──────
log_warn() { printf '%s\n' "$1" >> "$WARN_FILE"; }
set_window_attention_state() { printf '%s=%s\n' "$1" "$2" >> "$ATTENTION_FILE"; }
write_openrouter_warning_cache() { :; }
challenge_abort_pair() { return 0; }
challenge_abort_scope_for_failure() { printf 'pair\n'; }
cleanup_quarantined_no_pr_challenge_arm() { return 0; }
get_task_meta() {
  jq -r --arg issue "$1" --arg field "$2" '.tasks[$issue][$field] // empty' "$STATE_FILE"
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

# ── Schema-valid handoff fixtures ─────────────────────────────────────────────
# The reader tool runs the full validator, so every fixture must satisfy the
# CodingFailureHandoff schema (all required fields; providerError for
# provider_error; non-empty validationErrors for invalid_completion_artifact).
write_provider_error_handoff() {
  mkdir -p "$1"
  cat > "$1/.coding-failure-handoff.json" <<'JSON'
{
  "stage": "coding",
  "reason": "provider_error",
  "stopReason": "error",
  "mutationFailures": 0,
  "lastToolError": null,
  "recoveryAttempted": true,
  "suggestedAction": "inspect the provider error and relaunch",
  "createdAt": "2026-09-02T00:00:00Z",
  "schemaVersion": "1.0",
  "providerError": {
    "kind": "api_error",
    "errorMessage": "provider request failed",
    "turnsCompleted": 3,
    "toolCallsExecuted": 2,
    "attempts": 3
  }
}
JSON
}

# Modeled on the HOK-2791_c reproduction: stopReason=stop, zero mutation
# failures, no tool error — the model emitted apply_patch syntax as assistant
# text instead of invoking the mutation tool and never wrote .coding-complete.
write_no_artifact_handoff() {
  mkdir -p "$1"
  cat > "$1/.coding-failure-handoff.json" <<'JSON'
{
  "stage": "coding",
  "reason": "no_completion_artifact",
  "stopReason": "stop",
  "mutationFailures": 0,
  "lastToolError": null,
  "recoveryAttempted": true,
  "suggestedAction": "model emitted apply_patch as plain text with zero structured tool calls; check tool-call compatibility",
  "createdAt": "2026-09-02T00:00:00Z",
  "schemaVersion": "1.0"
}
JSON
}

write_invalid_artifact_handoff() {
  mkdir -p "$1"
  cat > "$1/.coding-failure-handoff.json" <<'JSON'
{
  "stage": "coding",
  "reason": "invalid_completion_artifact",
  "stopReason": "stop",
  "mutationFailures": 0,
  "lastToolError": null,
  "recoveryAttempted": true,
  "suggestedAction": "fix the completion marker JSON and relaunch",
  "createdAt": "2026-09-02T00:00:00Z",
  "schemaVersion": "1.0",
  "validationErrors": [
    { "code": "MISSING_REQUIRED_FIELD", "field": "confidence", "message": "confidence is required" }
  ]
}
JSON
}

write_malformed_handoff() {
  mkdir -p "$1"
  printf '{"reason": "provider_error"' > "$1/.coding-failure-handoff.json"
}

echo "=== Native Failure Classification (typed handoff, HOK-2933) ==="

# ── Handoff reason helper ─────────────────────────────────────────────────────
fd="$TMP_ROOT/f-helper-valid"
write_no_artifact_handoff "$fd"
if [[ "$(native_coding_failure_handoff_reason "$fd")" == "no_completion_artifact" ]]; then
  pass "helper reads the typed reason from a valid handoff"
else
  fail "helper did not surface the typed reason"
fi

fd="$TMP_ROOT/f-helper-malformed"
write_malformed_handoff "$fd"
if reason="$(native_coding_failure_handoff_reason "$fd" 2>/dev/null)"; then
  fail "helper accepted a malformed handoff (got: $reason)"
else
  pass "helper rejects a malformed handoff with a non-zero exit"
fi

fd="$TMP_ROOT/f-helper-missing"
mkdir -p "$fd"
if reason="$(native_coding_failure_handoff_reason "$fd" 2>/dev/null)"; then
  fail "helper reported a reason for a missing handoff (got: $reason)"
else
  pass "helper is a quiet no-op when no handoff file exists"
fi

if reason="$(TOOLS_DIR="" native_coding_failure_handoff_reason "$TMP_ROOT/f-helper-valid" 2>/dev/null)"; then
  fail "helper ran without TOOLS_DIR (got: $reason)"
else
  pass "helper degrades gracefully when TOOLS_DIR is unset"
fi

# ── Classifier: typed handoff reasons ─────────────────────────────────────────
# [REQ-F1] typed provider_error + unmatched detail → native-provider-error.
if [[ "$(native_terminal_failure_kind "some novel agent failure" "provider_error")" == "native-provider-error" ]]; then
  pass "typed provider_error with unmatched detail stays a provider error"
else
  fail "typed provider_error misclassified as $(native_terminal_failure_kind "some novel agent failure" "provider_error")"
fi

# HOK-2885 guard: typed provider_error still refines through the substring
# matcher so the challenger transient relaunch path keeps firing.
if [[ "$(native_terminal_failure_kind "the upstream service hit a rate limit" "provider_error")" == "provider-transient-error" ]]; then
  pass "typed provider_error refines to provider-transient-error on transient evidence"
else
  fail "typed provider_error transient refinement broken"
fi

# [REQ-F2] + HOK-2791_c reproduction: typed no_completion_artifact must map to
# the completion-protocol kind — never to a provider error.
repro_detail="Native coding failed: model emitted apply_patch syntax as assistant text twice (stopReason=stop, zero structured tool calls); no .coding-complete artifact"
repro_kind="$(native_terminal_failure_kind "$repro_detail" "no_completion_artifact")"
if [[ "$repro_kind" == "native-completion-protocol" ]]; then
  pass "typed no_completion_artifact classifies as native-completion-protocol"
else
  fail "typed no_completion_artifact misclassified as $repro_kind"
fi

repro_action="$(native_terminal_failure_next_action "$repro_kind")"
expected_action="model ended the phase without a valid completion artifact (protocol violation, not a provider fault) - check the model's structured tool-call compatibility before relaunching"
if [[ "$repro_action" == "$expected_action" ]]; then
  pass "completion-protocol next action points at model/tool compatibility"
else
  fail "completion-protocol next action wrong: $repro_action"
fi
if [[ "$repro_action" != *"inspect the native provider error"* ]]; then
  pass "completion-protocol next action does not tell the operator to inspect a provider error"
else
  fail "completion-protocol next action still blames the provider"
fi

# A typed protocol violation must win even when the detail contains a
# transient-looking word, so the transient phase-relaunch never fires on it.
if [[ "$(native_terminal_failure_kind "runtime gave up after an idle timeout waiting for a completion artifact" "no_completion_artifact")" == "native-completion-protocol" ]]; then
  pass "typed no_completion_artifact beats transient-looking substrings"
else
  fail "transient substring overrode the typed handoff reason"
fi

# [REQ-F3] typed invalid_completion_artifact is also a protocol violation.
if [[ "$(native_terminal_failure_kind "Native coding failed: completion marker missing confidence" "invalid_completion_artifact")" == "native-completion-protocol" ]]; then
  pass "typed invalid_completion_artifact classifies as native-completion-protocol"
else
  fail "typed invalid_completion_artifact misclassified"
fi

# An unknown-but-set handoff reason falls through to substrings, then the
# untyped default.
if [[ "$(native_terminal_failure_kind "some novel agent failure" "future_new_reason")" == "native-unclassified" ]]; then
  pass "unknown handoff reasons fall through to the unclassified default"
else
  fail "unknown handoff reason changed classification"
fi

# ── Classifier: no handoff (substring + default paths) ────────────────────────
# [REQ-F4] untyped, unmatched detail → native-unclassified.
if [[ "$(native_terminal_failure_kind "some novel agent failure")" == "native-unclassified" ]]; then
  pass "untyped unmatched failures default to native-unclassified"
else
  fail "untyped unmatched failure misclassified as $(native_terminal_failure_kind "some novel agent failure")"
fi

# [REQ-F5] existing substring classifications are intact.
if [[ "$(native_terminal_failure_kind "the upstream service hit a rate limit")" == "provider-transient-error" ]]; then
  pass "untyped rate-limit detail still classifies as provider-transient-error"
else
  fail "untyped rate-limit substring classification regressed"
fi
if [[ "$(native_terminal_failure_kind "Native coding failed: 401 Unauthorized")" == "provider-config-error" ]]; then
  pass "untyped 401 detail still classifies as provider-config-error"
else
  fail "untyped 401 substring classification regressed"
fi

# [REQ-F6] malformed handoff → helper fails → substring fallback → unclassified.
fd="$TMP_ROOT/f-malformed-flow"
write_malformed_handoff "$fd"
handoff_reason="$(native_coding_failure_handoff_reason "$fd" 2>/dev/null || true)"
if [[ -z "$handoff_reason" ]] \
  && [[ "$(native_terminal_failure_kind "unmatched error" "$handoff_reason")" == "native-unclassified" ]]; then
  pass "malformed handoff falls back to substring matching and native-unclassified"
else
  fail "malformed handoff fallback broken (reason='$handoff_reason')"
fi

# ── HOK-3129: four recurring native-unclassified signatures now typed ─────────
turn_limit_detail="Native planning rejected before approval: turn_limit"
if [[ "$(native_terminal_failure_kind "$turn_limit_detail")" == "planning-turn-limit" ]]; then
  pass "planning turn_limit classified as planning-turn-limit"
else
  fail "planning turn_limit misclassified as $(native_terminal_failure_kind "$turn_limit_detail")"
fi

artifact_invalid_detail="Native planning final artifact rejected: missing_title"
if [[ "$(native_terminal_failure_kind "$artifact_invalid_detail")" == "planning-artifact-invalid:missing_title" ]]; then
  pass "planning artifact rejection preserves structural reason suffix"
else
  fail "planning artifact classification missing suffix: $(native_terminal_failure_kind "$artifact_invalid_detail")"
fi

readiness_invalid_detail="Native planning final artifact rejected: missing_release_readiness_env_changes"
if [[ "$(native_terminal_failure_kind "$readiness_invalid_detail")" == "planning-artifact-invalid:missing_release_readiness_env_changes" ]]; then
  pass "planning artifact rejection preserves multi-token release-readiness suffix"
else
  fail "release readiness suffix dropped: $(native_terminal_failure_kind "$readiness_invalid_detail")"
fi

review_no_output_detail="Native review flow failed after 0 findings"
if [[ "$(native_terminal_failure_kind "$review_no_output_detail")" == "review-no-output" ]]; then
  pass "review no-output classified as review-no-output"
else
  fail "review no-output misclassified as $(native_terminal_failure_kind "$review_no_output_detail")"
fi

coding_interrupted_detail="Interrupted: coding agent exited without recording a result - durable commits preserved at /tmp/foo"
if [[ "$(native_terminal_failure_kind "$coding_interrupted_detail")" == "coding-exited-without-result" ]]; then
  pass "coding interruption classified as coding-exited-without-result"
else
  fail "coding interruption misclassified as $(native_terminal_failure_kind "$coding_interrupted_detail")"
fi

# Provider arms outrank the model-fault arms so a stacked message like
# "402 Payment Required: Native planning final artifact rejected: ..." stays a
# provider fault.
stacked_detail="402 Payment Required: Native planning final artifact rejected: missing_title"
if [[ "$(native_terminal_failure_kind "$stacked_detail")" == "provider-credit-exhausted" ]]; then
  pass "provider-fault arms outrank the HOK-3129 model-fault arms"
else
  fail "ordering regression: $(native_terminal_failure_kind "$stacked_detail")"
fi

# ── Next actions ──────────────────────────────────────────────────────────────
if [[ "$(native_terminal_failure_next_action native-unclassified)" == *"extend the classifier"* ]]; then
  pass "native-unclassified surfaces a classify-and-extend action"
else
  fail "native-unclassified next action missing"
fi
if [[ "$(native_terminal_failure_next_action some-unknown-kind)" == "inspect the native provider error, then relaunch the phase" ]]; then
  pass "unknown kinds keep the existing default next action"
else
  fail "default next action changed"
fi
if [[ "$(native_terminal_failure_next_action planning-turn-limit)" == *"stronger planner"* ]]; then
  pass "planning-turn-limit next action points at planner/budget"
else
  fail "planning-turn-limit next action missing"
fi
if [[ "$(native_terminal_failure_next_action planning-artifact-invalid)" == *"structural validation"* ]]; then
  pass "planning-artifact-invalid base variant next action set"
else
  fail "planning-artifact-invalid next action missing"
fi
if [[ "$(native_terminal_failure_next_action planning-artifact-invalid:missing_title)" == *"structural validation"* ]]; then
  pass "planning-artifact-invalid suffixed variant next action set"
else
  fail "planning-artifact-invalid suffixed next action missing"
fi
if [[ "$(native_terminal_failure_next_action review-no-output)" == *"stronger reviewer"* ]]; then
  pass "review-no-output next action points at reviewer"
else
  fail "review-no-output next action missing"
fi
if [[ "$(native_terminal_failure_next_action coding-exited-without-result)" == *"durable commits preserved"* ]]; then
  pass "coding-exited-without-result next action points at durable commits"
else
  fail "coding-exited-without-result next action missing"
fi

# ── End-to-end: terminal record preserves the typed handoff evidence ──────────
cat > "$STATE_FILE" <<'JSON'
{ "tasks": { "HOK-1_c": { "challenge": false } } }
JSON
fd="$TMP_ROOT/f-e2e"
write_stage_result "$fd" "coding" "running" "native" "meta-llama/llama-4-scout"
write_no_artifact_handoff "$fd"
write_hook "HOK-1_c" "error" "$repro_detail"

if emit_native_terminal_failure_attention "HOK-1_c" "$fd" "coding" "win-e2e" "%1" "native" "meta-llama/llama-4-scout"; then
  result_file="$fd/.coding-result.json"
  if [[ "$(jq -r '.status' "$result_file")" == "failed" ]] \
    && [[ "$(jq -r '.artifacts.failureKind' "$result_file")" == "native-completion-protocol" ]] \
    && [[ "$(jq -r '.artifacts.handoffReason' "$result_file")" == "no_completion_artifact" ]] \
    && [[ "$(jq -r '.artifacts.nextAction' "$result_file")" == "$expected_action" ]] \
    && [[ "$(jq -r '.notes' "$result_file")" == *"(typed handoff: no_completion_artifact)"* ]]; then
    pass "terminal record carries the protocol kind and the typed handoff reason"
  else
    fail "terminal record missing typed evidence: $(jq -c '.artifacts' "$result_file")"
  fi
  if [[ "$(jq -r '.notes' "$result_file")" != *"native-provider-error"* ]] \
    && [[ "$(jq -r '.artifacts.nextAction' "$result_file")" != *"inspect the native provider error"* ]]; then
    pass "terminal record no longer blames the provider for a protocol violation"
  else
    fail "terminal record still attributes the failure to the provider"
  fi
else
  fail "end-to-end terminal failure was not detected"
fi

# A review-stage failure never reads the coding handoff: a leftover coding
# handoff in the feature dir must not leak into review classification.
cat > "$STATE_FILE" <<'JSON'
{ "tasks": { "HOK-2_c": { "challenge": false } } }
JSON
fd="$TMP_ROOT/f-e2e-review"
write_stage_result "$fd" "review" "running" "native" "claude-sonnet-5"
write_no_artifact_handoff "$fd"
write_hook "HOK-2_c" "error" "some novel review failure"

if emit_native_terminal_failure_attention "HOK-2_c" "$fd" "review" "win-rev" "%2" "native" "claude-sonnet-5"; then
  result_file="$fd/.review-result.json"
  if [[ "$(jq -r '.artifacts.failureKind' "$result_file")" == "native-unclassified" ]] \
    && [[ "$(jq -r '.artifacts.handoffReason' "$result_file")" == "null" ]]; then
    pass "review-stage failures ignore a leftover coding handoff and use the new default"
  else
    fail "review-stage classification read the coding handoff: $(jq -c '.artifacts' "$result_file")"
  fi
else
  fail "review-stage terminal failure was not detected"
fi

echo
echo "--- Results: $PASS passed, $FAIL failed ---"
[[ "$FAIL" -eq 0 ]]
