#!/usr/bin/env bash
# protects: eval harness faults retry and escalate without manufacturing a model loss.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/shared/lib/wavemill-common.sh"
source "$ROOT/shared/lib/bounded-retry.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export LIB_DIR="$ROOT/shared/lib" TOOLS_DIR="$ROOT/tools"
for reason in no_result_file timed_out eval_not_persisted unknown_fault; do
  decision="$(eval_failure_disposition HOK-3076 "$reason" 1 'module load failed' true)"
  jq -e '.class == "retryable" and .attribution == "unattributed" and .attempt == true' <<<"$decision" >/dev/null
done
# The policy bridge must preserve whether this is a challenge arm.
single="$(eval_failure_disposition HOK-3076 ready-exhausted 1 '' false)"
pair="$(eval_failure_disposition HOK-3076 ready-exhausted 1 '' true)"
jq -e '.class == "retryable" and .attribution == "unattributed"' <<<"$single" >/dev/null
jq -e '.class == "terminal" and .attribution == "unattributed"' <<<"$pair" >/dev/null
# Real bounded retry state: one launch, exhaustion, quiet hold, new-head recovery.
[[ "$(bounded_retry_gate "$TMP" challenge-eval-hard head-a 1 0 0)" == proceed ]]
bounded_retry_increment "$TMP" challenge-eval-hard head-a >/dev/null
[[ "$(bounded_retry_gate "$TMP" challenge-eval-hard head-a 1 0 0)" == exhausted ]]
bounded_retry_mark_exhausted "$TMP" challenge-eval-hard 'unattributed eval harness failure'
[[ "$(bounded_retry_gate "$TMP" challenge-eval-hard head-a 1 0 0)" == exhausted-quiet ]]
[[ "$(bounded_retry_gate "$TMP" challenge-eval-hard head-b 1 0 0)" == proceed ]]
[[ "$(bounded_retry_count "$TMP" challenge-eval-hard)" == 0 ]]

# A terminal policy decision stops relaunching but must still escalate visibly
# and unattributed.  This exercises the challenged monitor caller, not merely
# the policy table, so an allowlisted cancellation cannot strand evalFailed.
extract_function() {
  awk -v name="$2" '
    function delta(line, text, opens, closes) {
      text = line
      gsub(/"([^"\\]|\\.)*"/, "\"\"", text)
      gsub(/\047([^\047\\]|\\.)*\047/, "\047\047", text)
      opens = gsub(/\{/, "{", text); closes = gsub(/\}/, "}", text)
      return opens - closes
    }
    $0 ~ "^" name "\\(\\)[[:space:]]*\\{" { capture = 1; depth = 0 }
    capture { print; depth += delta($0); if (depth == 0) exit }
  ' "$1"
}
FUNCTION_FILE="$TMP/maybe-run-challenge-eval.sh"
extract_function "$ROOT/shared/lib/wavemill-monitor.sh" maybe_run_challenge_eval > "$FUNCTION_FILE"
STATE_FILE="$TMP/state.json"
WORKTREE_ROOT="$TMP/worktrees"
mkdir -p "$WORKTREE_ROOT/hok-3076/features/hok-3076"
source "$ROOT/tests/fakes/lib.sh"
fakes_setup "$TMP/world"
source "$ROOT/tests/lib/state-fixtures.sh"
fixture_workflow_state "$STATE_FILE" HOK-3076 slug=hok-3076 evalCompleted:=false evalFailed:=true challengePairId=HOK-3076 challengeRole=primary
fixture_real_state_accessors
REPO_DIR="$FAKE_REPO_DIR"
cat > "$WORKTREE_ROOT/hok-3076/features/hok-3076/.eval-failure-decision.json" <<'JSON'
{"class":"terminal","failureKind":"cancelled","attribution":"unattributed","nextAction":"operator cancelled the run"}
JSON
pass_task_field() { get_task_meta "$1" "$2"; }
challenge_eval_hard_failure_max_retries() { printf '2\n'; }
challenge_pair_timed_out_sides_csv() { printf '\n'; }
challenge_pair_timeout_reason() { printf 'eval unavailable\n'; }
write_manual_challenge_comparison_artifact() { printf '%s/manual.json\n' "$TMP"; }
PAIR_STATE=""
write_challenge_pair_state() { PAIR_STATE="$2/$3/$4/$5/$7"; }
ATTENTION=""
set_window_attention_state() { ATTENTION="$2"; }
log() { :; }
log_warn() { :; }
source "$FUNCTION_FILE"
maybe_run_challenge_eval HOK-3076 101 task/hok-3076 hok-3076
[[ "$PAIR_STATE" == manual_comparison_needed/*/0/2/primary ]]
[[ "$ATTENTION" == needs-user ]]
[[ -f "$WORKTREE_ROOT/hok-3076/features/hok-3076/.retry-challenge-eval-hard-exhausted" ]]
echo 'challenge-eval-hard-failure: policy, attribution and bounded recovery passed'
