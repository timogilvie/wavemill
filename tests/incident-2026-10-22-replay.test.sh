#!/usr/bin/env bash
# HOK-3313 replay — the 2026-10-22 "OpenRouter in pane + Claude coder exit 143"
# incident. The old pane-text sniff
# (agent_or_model_is_native_for_recovery, now deleted) would match the
# word "OpenRouter" in scrollback and classify this as a native/OpenRouter
# provider failure, overwriting agent='claude' in the stage result and
# routing the exit through the native-launch-failure quarantine path.
#
# After HOK-3313, identity comes from the launch record only
# (stageResults.coding.agent is 'claude'), the single failure policy
# classifies the exit, and an unrecognised exit text is retryable — not
# terminal — so stage-failure-coding is charged a relaunch instead of the
# arm being terminalized.
#
# Pins the exact 2026-10-22 fixture shape: Claude coder, exit 143, with
# 'OpenRouter' in the hook detail (standing in for the pane scrollback the
# old gate used to grep).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"
FIXTURE_FILE="$REPO_DIR/tests/fixtures/real-state/2026-10-22-exit-143.json"

[[ -f "$FIXTURE_FILE" ]] || { echo "fixture missing: $FIXTURE_FILE" >&2; exit 1; }

# shellcheck source=../shared/lib/transient-marker.sh
source "$REPO_DIR/shared/lib/transient-marker.sh"

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1" >&2; FAIL=$((FAIL + 1)); }

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
eval "$(extract_function stage_failure_decision)"
eval "$(extract_function native_stage_failure_envelope_json)"
eval "$(extract_function emit_native_terminal_failure_attention)"
eval "$(extract_function emit_challenge_stage_failure_quarantine)"
eval "$(extract_function write_openrouter_warning_cache)"
eval "$(extract_function record_openrouter_credits_challenge_abort)"
eval "$(extract_function challenge_abort_pair)"
eval "$(extract_function challenge_abort_scope_for_failure)"
eval "$(extract_function _challenge_side_for_issue)"

extract_common_function() {
  awk -v name="$1" '$0 ~ "^" name "\\(\\) \\{" { capture=1 } capture { print } /^}/ && capture { exit }' \
    "$REPO_DIR/shared/lib/wavemill-common.sh"
}
eval "$(extract_common_function failure_policy_decide)"
eval "$(extract_common_function failure_policy_next_action)"
eval "$(extract_common_function _failure_policy_cli)"
eval "$(extract_common_function wavemill_run_tool)"
# shellcheck source=../shared/lib/bounded-retry.sh
source "$REPO_DIR/shared/lib/bounded-retry.sh"
TOOLS_DIR="$REPO_DIR/tools"

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"; rm -f "/tmp/wavemill-${SESSION}-FIXTURE-1.hook"' EXIT

SESSION="hok3313replay"
STATE_FILE="$TMP_ROOT/state.json"
ATTENTION_FILE="$TMP_ROOT/attention.txt"
WARN_FILE="$TMP_ROOT/warn.txt"
WAVEMILL_STATE_DIR="$TMP_ROOT/wavemill-state"
mkdir -p "$WAVEMILL_STATE_DIR"
active_count=0
export WAVEMILL_RELIABILITY_REPO_DIR="$TMP_ROOT/reliability-repo"

log_warn() { printf '%s\n' "$1" >> "$WARN_FILE"; }
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
cleanup_quarantined_no_pr_challenge_arm() { return 1; }
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

# Seed the workflow-state and the running coding stage result from the
# fixture. The important bits are preserved verbatim: agent='claude',
# model='claude-opus-4-7', stage status='running'.
seed_from_fixture() {
  local issue="$1"
  # allow-task-literal: reshaping the real-state fixture verbatim pins the exact 2026-10-22 shape; the builder would re-encode it
  jq --arg issue "$issue" '{tasks:{($issue):.workflowState.tasks."FIXTURE-1"}}' "$FIXTURE_FILE" > "$STATE_FILE"
}

seed_stage_result_from_fixture() {
  local issue="$1" fd="$2"
  mkdir -p "$fd"
  jq --arg issue "$issue" '.stageResults."FIXTURE-1".coding' "$FIXTURE_FILE" > "$fd/.coding-result.json"
}

seed_hook_from_fixture() {
  local issue="$1"
  jq --arg issue "$issue" '.hooks."FIXTURE-1"' "$FIXTURE_FILE" > "/tmp/wavemill-${SESSION}-${issue}.hook"
}

echo "=== HOK-3313: 2026-10-22 Claude coder exit 143 replay ==="

ISSUE="FIXTURE-1"
seed_from_fixture "$ISSUE"
: > "$ATTENTION_FILE"
: > "$WARN_FILE"
fd="$TMP_ROOT/f-exit143"
seed_stage_result_from_fixture "$ISSUE" "$fd"
seed_hook_from_fixture "$ISSUE"

# Precondition: the fixture carries agent='claude' at the launch record and
# a hook detail that contains the word 'OpenRouter' (the old pane-text sniff
# would have matched this and clobbered identity).
pre_agent="$(jq -r '.agent' "$fd/.coding-result.json")"
hook_detail="$(jq -r '.detail' "/tmp/wavemill-${SESSION}-${ISSUE}.hook")"
if [[ "$pre_agent" == "claude" ]]; then
  pass "fixture preserves agent='claude' at the launch record"
else
  fail "fixture agent was '$pre_agent', expected 'claude'"
fi
if [[ "$hook_detail" == *"OpenRouter"* ]]; then
  pass "fixture hook detail contains the pane-text decoy 'OpenRouter'"
else
  fail "fixture hook detail missing 'OpenRouter' decoy: $hook_detail"
fi

# Run the real handler. Fallback agent/model intentionally != 'claude' to
# prove the handler does NOT fall back to those values when the launch
# record is present.
if emit_native_terminal_failure_attention "$ISSUE" "$fd" "coding" "win-exit143" "%1" "codex" "glm-4"; then
  pass "handler accepted the terminal hook"
else
  fail "handler declined the fixture (unexpected)"
fi

# The key assertion: identity comes from the launch record. The old gate
# would have written agent='native' (or 'codex' / 'glm-4' from the fallback)
# into the stage result; HOK-3313 keeps agent='claude'.
post_agent="$(jq -r '.agent' "$fd/.coding-result.json")"
post_model="$(jq -r '.model' "$fd/.coding-result.json")"
post_status="$(jq -r '.status' "$fd/.coding-result.json")"
post_class="$(jq -r '.artifacts.failureClass // empty' "$fd/.coding-result.json")"

if [[ "$post_agent" == "claude" ]]; then
  pass "stage result records agent='claude' (identity from launch record, not pane text)"
else
  fail "stage result records agent='$post_agent' (expected 'claude'; pane-text sniff may be back)"
fi

if [[ "$post_agent" != "codex" && "$post_agent" != "native" ]]; then
  pass "stage result is not clobbered to 'codex' or 'native' by fallback / pane sniff"
else
  fail "stage result was clobbered to '$post_agent' (HOK-3313 regression)"
fi

if [[ "$post_model" == "claude-opus-4-7" ]]; then
  pass "stage result model stays 'claude-opus-4-7' from the launch record"
else
  fail "stage result model is '$post_model', expected 'claude-opus-4-7'"
fi

if [[ "$post_status" == "failed" ]]; then
  pass "stage is marked failed (not quarantined, not left running)"
else
  fail "stage status is '$post_status', expected 'failed'"
fi

# The exit text ("exit_code:143 (SIGTERM; agent process killed mid-stage; ...)")
# is not in the terminal allowlist, so the failure policy classifies it as
# retryable. The arm is NOT quarantined and no needs-user attention is set.
if [[ "$post_class" == "retryable" ]]; then
  pass "unrecognised exit is classified retryable (not terminal)"
else
  fail "exit was classified '$post_class', expected 'retryable' (stage-failure-coding should relaunch)"
fi

if [[ "$(jq -r '.tasks["FIXTURE-1"].challengeAborted // "none"' "$STATE_FILE")" == "none" ]]; then
  pass "non-challenge task was not quarantined"
else
  fail "non-challenge task gained challenge quarantine state (regression)"
fi

if ! grep -q 'win-exit143=needs-user' "$ATTENTION_FILE"; then
  pass "window was not parked at needs-user (retryable classification)"
else
  fail "window was parked at needs-user despite retryable classification"
fi

echo
echo "--- Results: $PASS passed, $FAIL failed ---"
[[ "$FAIL" -eq 0 ]]
