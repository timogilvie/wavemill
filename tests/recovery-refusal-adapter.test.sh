#!/usr/bin/env bash
# The real missing-launch adapter retains validator evidence for every stage.
# The journey checks the controller/claim/escalation and actual agent effects.
set -euo pipefail
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
source "$REPO_DIR/shared/lib/wavemill-common.sh"
source "$REPO_DIR/shared/lib/transient-marker.sh"
source "$REPO_DIR/tests/lib/state-fixtures.sh"
for fn in _request_launch_recovery _monitor_claim_failed_stage_action; do
  eval "$(_state_fixtures_extract_function "$REPO_DIR/shared/lib/wavemill-monitor.sh" "$fn")"
done
STATE_FILE="$ROOT/state.json"
WIN=window
# Only adapter boundaries are replaced: classification still uses the actual
# policy CLI. Capturing the snapshot is intentionally not a controller proof.
maybe_retry_failed_stage() { printf '%s\n' "$5" > "$ROOT/context.json"; return 2; }
phase_launch_head() { echo output-head; }
phase_launch_base() { echo input-base; }
stage_failure_retry_key() { echo '{"head":"input:run:base","base":""}'; }
bounded_retry_gate() { echo proceed; }
task_run_id() { echo run; }
read_stage_result() { echo null; }
stage_agent_disposition() { echo '{"kind":"settled","reason":"agent-exited"}'; }
recovery_contract_json() { printf '%s\n' "$CONTRACT_NOW"; }
wavemill_run_tool() {
  local tool="$1"; shift
  if [[ "$tool" != task-recovery-controller.ts ]]; then
    node "$REPO_DIR/tools/$tool" "$@"; return
  fi
  local evidence=''
  while (( $# )); do
    case "$1" in
      --snapshot) cp "$2" "$ROOT/snapshot.json"; shift ;;
      --evidence-id) evidence="$2"; shift ;;
    esac
    shift
  done
  jq -cn --arg evidence "$evidence" '{evidence:$evidence}'
}
refusal='{"ok":false,"reason":"agent_unsupported_for_model","detail":"wrong saved executor"}'
for stage in planning coding review; do
  _request_launch_recovery HOK-3512 "$stage" "$ROOT" agent_unsupported_for_model 'wrong saved executor' "$refusal"
  [[ "$_RESTORE_STATE" == pending ]]
  context="$(cat "$ROOT/context.json")"
  CONTRACT_NOW="$refusal"
  jq -e --argjson expected "$refusal" '.executionContract == $expected and .launchRecovery and .failure.class == "retryable"' <<<"$context" >/dev/null
  before="$(_monitor_claim_failed_stage_action HOK-3512 "$ROOT" "$stage" "$context")"
  jq -e --argjson expected "$refusal" '.executionContract == $expected and .disposition.kind == "settled" and (has("contractAvailable") | not)' "$ROOT/snapshot.json" >/dev/null
  # Repair changes claim evidence even when the failed result and HEAD do not.
  repaired="$(jq '.executionContract = {ok:true,contract:{model:"saved-model",agent:"claude"}}' <<<"$context")"
  CONTRACT_NOW="$(jq -c .executionContract <<<"$repaired")"
  after="$(_monitor_claim_failed_stage_action HOK-3512 "$ROOT" "$stage" "$repaired")"
  [[ "$(jq -r .evidence <<<"$before")" != "$(jq -r .evidence <<<"$after")" ]]
  # An old queued notification must use the operator's latest persisted route.
  _monitor_claim_failed_stage_action HOK-3512 "$ROOT" "$stage" "$context" >/dev/null
  jq -e '.executionContract.ok == true' "$ROOT/snapshot.json" >/dev/null
  operator_event_record "$ROOT" retry HOK-3512 'explicit release without changing the saved route'
  released="$(_monitor_claim_failed_stage_action HOK-3512 "$ROOT" "$stage" "$repaired")"
  [[ "$(jq -r .evidence <<<"$released")" != "$(jq -r .evidence <<<"$after")" ]]
  echo "PASS $stage preserves refusal and distinguishes repaired-route evidence"
done
_request_launch_recovery HOK-3512 coding "$ROOT" state_transition_failed 'trace write failed'
jq -e '.executionContract == null and .failure.class == "retryable"' "$ROOT/context.json" >/dev/null
echo 'PASS a write failure is not a positive route refusal'
terminal="$(failure_policy_decide coding task-budget-exhausted 'recorded task spend exhausted')"
_request_launch_recovery HOK-3512 coding "$ROOT" stage_failed 'failed before window loss' null "$terminal"
jq -e '.failure.class == "terminal" and .failure.failureKind == "task-budget-exhausted"' "$ROOT/context.json" >/dev/null
echo 'PASS missing-window notification preserves an existing terminal failure'
[[ ! -f "$ROOT/.coding-result.json" && ! -f "$STATE_FILE" ]]
echo 'PASS adapter does not fabricate results or private stopped task state'
