#!/usr/bin/env bash
# protects: eval harness faults retry and escalate without manufacturing a model loss.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/shared/lib/wavemill-common.sh"
source "$ROOT/shared/lib/bounded-retry.sh"
source "$ROOT/shared/lib/transient-marker.sh"
source "$ROOT/shared/lib/condition-reconciler.sh"
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

# The existing condition reconciler consumes an operator event and releases
# the same exhausted bucket; no private recovery marker is introduced.
bounded_retry_increment "$TMP" challenge-eval-hard head-b >/dev/null
bounded_retry_mark_exhausted "$TMP" challenge-eval-hard 'captured module-load failure' --expires-on operator-event
STATE_FILE="$TMP/workflow-state.json"
source "$ROOT/tests/lib/state-fixtures.sh"
fixture_workflow_state "$STATE_FILE" HOK-3076_c phase=ready
operator_event_record "$TMP" advance HOK-3076_c 'operator repaired node_modules'
condition_reconcile_task HOK-3076_c "$TMP" "$TMP"
[[ "$(bounded_retry_gate "$TMP" challenge-eval-hard head-b 1 0 0)" == proceed ]]

# Challenge monitor settlement and recovery are exercised only through the
# real loop in challenge-pair-eval.journey.sh; this unit test deliberately
# remains a policy/bounded-retry contract rather than sourcing monitor code.
echo 'challenge-eval-hard-failure: policy, attribution and bounded recovery passed'
