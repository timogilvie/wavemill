#!/usr/bin/env bash
# HOK-2814: non-forked control path — exercises the live-challenger collapse
# via challenge_cancel_challenger_arm, which is the collapse shape for a
# challenger that has already been launched (non-review stages, or a
# review-stage arm that already materialised). The pre-fork collapse of a
# pending arm is covered by challenge-fork-pre-fork-collapse.test.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

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

HELPERS="$(awk '
  /^challenge_varied_stage_model\(\) \{/ { capture=1 }
  /^challenge_plan_stage_requires_effective_route\(\) \{/ && capture { exit }
  capture { print }
' "$MONITOR_SCRIPT_FILE")"
eval "$HELPERS"
# handle_phase_launch_result records terminal causes via the shared
# bounded-retry helpers (HOK-2924).
# shellcheck source=../shared/lib/bounded-retry.sh
source "$REPO_DIR/shared/lib/bounded-retry.sh"
eval "$(extract_function phase_launch_head)"
eval "$(extract_function resolve_phase_model)"
eval "$(extract_function resolve_stage_result_model)"
eval "$(extract_function challenge_cancel_challenger_arm)"
eval "$(extract_function handle_phase_launch_result)"

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

STATE_FILE="$TMP_ROOT/state.json"
REPO_DIR="$TMP_ROOT/repo"
mkdir -p "$REPO_DIR"
WORKTREE_ROOT="$TMP_ROOT/worktrees"
SESSION="test-session"
MILL_LOG_FILE="$TMP_ROOT/mill.log"
ATTENTION_FILE="$TMP_ROOT/attention.txt"
LIFECYCLE_FILE="$TMP_ROOT/lifecycle.txt"

log() { printf '[%s] %s\n' "$1" "$2" >> "$MILL_LOG_FILE"; }
log_error() { :; }
log_warn() { :; }
log_route_lifecycle() { printf '%s\n' "$*" >> "$LIFECYCLE_FILE"; }
agent_is_native_cmd() { [[ "${1:-}" == native-* ]]; }
agent_model_looks_like_depth_tag() { [[ "${1:-}" == light || "${1:-}" == medium || "${1:-}" == deep ]]; }
agent_validate_model() { [[ "${1:-}" != "bad-model" ]]; }
clear_stage_result() { rm -f "$1/.$2-result.json"; }
set_task_phase() {
  state_mutate "$STATE_FILE" '.tasks[$issue].phase = $phase' --arg issue "$1" --arg phase "$2"
}
set_window_attention_state() { printf '%s=%s\n' "$1" "$2" >> "$ATTENTION_FILE"; }
_tmux_task_window_target() { return 1; }
_tmux_target_join() { printf '%s:%s\n' "$1" "$2"; }
_tmux_window_target_exists() { return 1; }
reset_retry_count() { :; }
remove_task_state() {
  local issue="$1"
  state_mutate "$STATE_FILE" 'del(.tasks[$issue])' --arg issue "$issue"
}
state_mutate() {
  local state_path="$1" filter="$2"
  shift 2
  jq "$@" "$filter" "$state_path" > "$state_path.tmp"
  mv "$state_path.tmp" "$state_path"
}
get_task_meta() {
  jq -r --arg issue "$1" --arg field "$2" '.tasks[$issue][$field] // empty' "$STATE_FILE"
}
write_stage_result() {
  local feature_dir="$1" stage="$2" status="$3" agent="${4:-}" model="${5:-}" notes="${6:-}"
  mkdir -p "$feature_dir"
  jq -n \
    --arg stage "$stage" \
    --arg status "$status" \
    --arg agent "$agent" \
    --arg model "$model" \
    --arg notes "$notes" \
    '{stage:$stage,status:$status,agent:$agent,model:$model,notes:$notes}' \
    > "$feature_dir/.${stage}-result.json"
}
read_phase_config() {
  local feature_dir="$1" stage="$2" field="$3"
  jq -r --arg stage "$stage" --arg field "$field" '.[$stage][$field] // empty' "$feature_dir/.phase-config.json" 2>/dev/null || true
}

seed_state() {
  local stage="$1"
  cat > "$STATE_FILE" <<JSON
{
  "tasks": {
    "HOK-1": {
      "challengePairId": "HOK-1",
      "challengeRole": "primary",
      "challengeStage": "$stage",
      "challengeVariedModel": "bad-model"
    },
    "HOK-1_c": {
      "challengePairId": "HOK-1",
      "challengeRole": "challenger",
      "challengeStage": "$stage",
      "challengeVariedModel": "bad-model"
    }
  }
}
JSON
}

echo "=== Challenge Varied Model Abort ==="

seed_state "plan"
feature_dir="$TMP_ROOT/feature-plan"
if ! challenge_guard_varied_model_resolvable "HOK-1" "$feature_dir" "HOK-1-slug" "plan" "bad-model"; then
  if [[ "$(jq -r '.status' "$feature_dir/.planning-result.json")" == "failed" ]] \
    && [[ "$(jq -r '.model' "$feature_dir/.planning-result.json")" == "bad-model" ]] \
    && [[ -f "$feature_dir/.challenge-aborted.json" ]] \
    && [[ "$(jq -r '.tasks["HOK-1"].challengeAborted' "$STATE_FILE")" == "varied_model_unresolvable" ]] \
    && [[ "$(jq -r '.tasks["HOK-1_c"].challengeAborted' "$STATE_FILE")" == "varied_model_unresolvable" ]] \
    && grep -q 'HOK-1-slug=needs-user' "$ATTENTION_FILE"; then
    pass "unresolvable varied planning model aborts both arms"
  else
    fail "planning abort side effects were incomplete"
  fi
else
  fail "planning guard did not reject invalid varied model"
fi

seed_state "implementation"
feature_dir="$TMP_ROOT/feature-coding"
if ! challenge_guard_varied_model_resolvable "HOK-1" "$feature_dir" "HOK-1-slug" "coding" "bad-model"; then
  if [[ "$(jq -r '.status' "$feature_dir/.coding-result.json")" == "failed" ]] \
    && [[ "$(jq -r '.stage' "$feature_dir/.challenge-aborted.json")" == "implementation" ]]; then
    pass "unresolvable varied implementation model aborts coding"
  else
    fail "implementation abort side effects were incomplete"
  fi
else
  fail "coding guard did not reject invalid varied model"
fi

seed_state "implementation"
feature_dir="$TMP_ROOT/native-preflight"
mkdir -p "$feature_dir"
: > "$MILL_LOG_FILE"
AGENT_NATIVE_LAUNCH_LAST_JSON='{"ok":false,"model":"bad-model","wavemillAlias":"bad-model","code":"global-projection-missing","surface":"globalEffectiveModels.coding","reason":"coding projection rejected bad-model","remediation":"Choose a model present in the coding effective projection."}'
if ! handle_phase_launch_result "HOK-1" "$feature_dir" "coding" "planning" 1 "HOK-1-slug" "native-openrouter" "bad-model"; then
  if [[ "$(jq -r '.tasks["HOK-1"].challengeAborted' "$STATE_FILE")" == "varied_model_unresolvable" ]] \
    && [[ "$(jq -r '.tasks["HOK-1_c"].challengeAborted' "$STATE_FILE")" == "varied_model_unresolvable" ]] \
    && [[ "$(jq -r '.status' "$feature_dir/.coding-result.json")" == "failed" ]] \
    && [[ "$(jq -r '.tasks["HOK-1"].phase // empty' "$STATE_FILE")" == "" ]] \
    && grep -q 'global-projection-missing' "$MILL_LOG_FILE" \
    && grep -q 'globalEffectiveModels.coding' "$MILL_LOG_FILE" \
    && grep -q 'coding projection rejected bad-model' "$MILL_LOG_FILE" \
    && grep -q 'Choose a model present in the coding effective projection' "$MILL_LOG_FILE"; then
    pass "native preflight failure aborts varied model once and logs diagnostics"
  else
    fail "native preflight abort or diagnostics were incomplete" "$(cat "$MILL_LOG_FILE")"
  fi
else
  fail "native preflight launch failure was treated as success"
fi

seed_state "review"
feature_dir="$TMP_ROOT/non-varied"
mkdir -p "$feature_dir"
if challenge_guard_varied_model_resolvable "HOK-1" "$feature_dir" "HOK-1-slug" "coding" "bad-model" \
  && [[ ! -f "$feature_dir/.coding-result.json" ]]; then
  pass "non-varied stage guard is a no-op"
else
  fail "non-varied stage guard aborted unexpectedly"
fi

if [[ "$(resolve_phase_model "coding" "bad-model" "fallback-model")" == "fallback-model" ]]; then
  pass "ordinary invalid model fallback is preserved"
else
  fail "ordinary invalid model fallback changed"
fi

seed_state "implementation"
feature_dir="$TMP_ROOT/stage-result"
mkdir -p "$feature_dir"
printf '%s\n' '{"coding":{"model":"fallback-model"}}' > "$feature_dir/.phase-config.json"
ISSUE="HOK-1"
if [[ "$(resolve_stage_result_model "$feature_dir" "coding" "fallback-model")" == "bad-model" ]]; then
  pass "stage result model records varied model without substitution"
else
  fail "stage result model substituted the varied model"
fi

cat > "$STATE_FILE" <<JSON
{
  "tasks": {
    "HOK-2": {
      "challenge": true,
      "challengePairId": "HOK-2",
      "challengeRole": "primary",
      "challengeStage": "review",
      "challengeVariedModel": "claude-opus-4-7",
      "challengeVariedAgent": "claude",
      "challengeModel": "claude-opus-4-7"
    },
    "HOK-2_c": {
      "slug": "hok-2-challenger",
      "worktree": "$TMP_ROOT/worktrees/hok-2-challenger",
      "challenge": true,
      "challengePairId": "HOK-2",
      "challengeRole": "challenger",
      "challengeStage": "review",
      "challengeVariedModel": "claude-opus-4-7"
    }
  }
}
JSON
mkdir -p "$TMP_ROOT/worktrees/hok-2-challenger"
: > "$LIFECYCLE_FILE"
challenge_cancel_challenger_arm "HOK-2" "hok-2" "HOK-2_c" "$TMP_ROOT/feature-collapse" "review" "claude-opus-4-7" "identical-at-varied-stage" "collapsed reviewer"
if [[ "$(jq -r '.tasks["HOK-2_c"] // empty' "$STATE_FILE")" == "" ]] \
  && [[ "$(jq -r '.tasks["HOK-2"].challenge' "$STATE_FILE")" == "false" ]] \
  && [[ "$(jq -r '.tasks["HOK-2"].challengeCollapseReason' "$STATE_FILE")" == "identical-at-varied-stage" ]] \
  && [[ "$(jq -r 'has("challengeRole")' < <(jq '.tasks["HOK-2"]' "$STATE_FILE"))" == "false" ]] \
  && grep -q 'challenge_collapsed' "$LIFECYCLE_FILE"; then
  pass "collapsed identical challenge removes challenger and marks primary"
else
  fail "collapsed challenge cancellation side effects were incomplete"
fi

challenge_cancel_challenger_arm "HOK-2" "hok-2" "" "$TMP_ROOT/feature-collapse" "review" "claude-opus-4-7" "empty-key-noop" "no challenger key"
if [[ "$(jq -r '.tasks["HOK-2"].challengeCollapseReason' "$STATE_FILE")" == "empty-key-noop" ]]; then
  pass "challenge cancellation handles an empty challenger key"
else
  fail "challenge cancellation with empty challenger key failed"
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
if (( FAIL > 0 )); then
  exit 1
fi
