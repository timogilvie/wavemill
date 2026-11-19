#!/usr/bin/env bash
# wavemill-test-suite: none
# Contract adapter: real monitor admission/dispatch + retry storage + reconciler.
# Only the controller CLI is projected to its retry verdict here; the golden
# journey exercises the actual controller, claims, worker and agent launch.
set -euo pipefail
REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
ROOT="$1"; STAGE="$2"; EVENTS="$3"
MONITOR_SOURCE="${4:-$REPO_DIR/shared/lib/wavemill-monitor.sh}"
STATE_FILE="$ROOT/state.json"
BASE_BRANCH=main
SESSION="contract-$$"
source "$REPO_DIR/shared/lib/wavemill-common.sh"
source "$REPO_DIR/shared/lib/transient-marker.sh"
source "$REPO_DIR/shared/lib/condition-reconciler.sh"
source "$REPO_DIR/tests/lib/state-fixtures.sh"
fixture_real_state_accessors
for fn in phase_launch_head phase_launch_base stage_failure_retry_key \
  _monitor_claim_failed_stage_action _dispatch_failed_stage_recovery read_stage_result; do
  eval "$(_state_fixtures_extract_function "$MONITOR_SOURCE" "$fn")"
done
wt="$ROOT/worktree"; fd="$wt/features/contract"
mkdir -p "$fd"
git init -q "$wt"
git -C "$wt" -c user.name=contract -c user.email=contract@example.invalid commit -q --allow-empty -m input
git -C "$wt" update-ref refs/remotes/origin/main HEAD
export WAVEMILL_RETRY_BACKOFF_BASE_SECONDS=0
export WAVEMILL_STAGE_FAILURE_MAX_ATTEMPTS=3
bucket="stage-failure-$STAGE"
input_serial=0

# These replace agent execution and UI only, not retry admission or accounting.
stage_result_field() { printf 'claude\n'; }
stage_failure_owned_by_bucket() { return 1; }
stage_failure_decision() { printf '%s\n' '{"class":"retryable","failureKind":"native-unclassified","detail":"contract failure","nextAction":"retry"}'; }
recovery_contract_json() { printf '%s\n' '{"ok":true}'; }
read_stage_result() { printf 'null\n'; }
_stage_failure_coding_relaunch() { return 0; }
_stage_failure_ready_relaunch() { return 0; }
set_task_phase() { :; }
set_window_attention_state() { :; }
clear_stage_result() { :; }
log() { :; }; log_warn() { :; }
# Admission builds the REAL snapshot. Inspect its retry verdict without
# starting a controller process for every generated step.
wavemill_run_tool() {
  while (( $# )); do
    if [[ "$1" == --snapshot ]]; then jq '{retry:.failure.retry}' "$2"; return; fi
    shift
  done
  return 1
}

while IFS= read -r event; do
  verdict=""
  case "$event" in
    output)
      git -C "$wt" -c user.name=contract -c user.email=contract@example.invalid commit -q --allow-empty -m output
      ;;
    input)
      input_serial=$((input_serial + 1))
      lifecycle="$(jq --arg input "$(printf '%040d' "$input_serial")" '.tasks["HOK-3491"].lifecycle | .launchContract.baseSha = $input' "$STATE_FILE")"
      fixture_workflow_state "$STATE_FILE" HOK-3491 "phase=$STAGE" runId=contract-run "lifecycle:=$lifecycle"
      ;;
    reconcile) condition_reconcile_task HOK-3491 "$wt" "$fd" >/dev/null ;;
    unavailable) cp "$STATE_FILE" "$ROOT/saved-state.json"; : > "$STATE_FILE" ;;
    available) mv "$ROOT/saved-state.json" "$STATE_FILE" ;;
    failure)
      result="$(_monitor_claim_failed_stage_action HOK-3491 "$fd" "$STAGE")"
      verdict="$(jq -r .retry <<<"$result")"
      case "$verdict" in
        proceed) _dispatch_failed_stage_recovery HOK-3491 "$fd" "$STAGE" contract-window "$(stage_failure_decision)" ;;
        exhausted) bounded_retry_mark_exhausted "$fd" "$bucket" 'contract exhausted' || true ;;
      esac
      ;;
    *) echo "unknown event: $event" >&2; exit 1 ;;
  esac
  jq -cn --arg event "$event" --arg verdict "$verdict" \
    --argjson count "$(bounded_retry_count "$fd" "$bucket")" \
    --arg exhausted "$(bounded_retry_is_exhausted "$fd" "$bucket" && echo true || echo false)" \
    '{event:$event,verdict:$verdict,count:$count,exhausted:($exhausted == "true")}'
done < <(jq -r '.[]' "$EVENTS")
