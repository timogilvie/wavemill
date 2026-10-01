#!/usr/bin/env bash
# Regression coverage for HOK-2785: queue planner retry timestamps are UTC.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Keep the regression visible on machines whose default timezone is UTC.
export TZ='America/New_York'

# shellcheck source=../shared/lib/wavemill-common.sh
source "$REPO_ROOT/shared/lib/wavemill-common.sh"
# shellcheck source=../shared/lib/queue-health.sh
source "$REPO_ROOT/shared/lib/queue-health.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

check_equals() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass "$name"
  else
    echo "    expected: [$expected]"
    echo "    actual:   [$actual]"
    fail "$name"
  fi
}

check_skip_result() {
  local name="$1" expected="$2" actual
  if queue_health_should_skip_attempt; then
    actual="skip"
  else
    actual="proceed"
  fi
  check_equals "$name" "$expected" "$actual"
}

iso_from_epoch() {
  local epoch="$1"
  date -u -r "$epoch" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || \
    date -u -d "@$epoch" '+%Y-%m-%dT%H:%M:%SZ'
}

write_health() {
  local next_retry_at="$1"
  printf '{"nextRetryAt":%s}\n' "$next_retry_at" > "$STATE_DIR/queue-health.json"
}

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT
STATE_DIR="$TEST_TMP"
export STATE_DIR

echo "=== HOK-2785: queue health retry UTC parsing ==="

now_epoch="$(date +%s)"
past_retry_at="$(iso_from_epoch "$((now_epoch - 5))")"
future_retry_at="$(iso_from_epoch "$((now_epoch + 3600))")"
future_retry_at_fractional="${future_retry_at%Z}.123Z"

write_health "\"$past_retry_at\""
check_skip_result "past UTC nextRetryAt does not skip" "proceed"

write_health "\"$future_retry_at\""
check_skip_result "future UTC nextRetryAt skips" "skip"

printf '{}\n' > "$STATE_DIR/queue-health.json"
check_skip_result "missing nextRetryAt does not skip" "proceed"

write_health '"not-a-date"'
check_skip_result "malformed nextRetryAt does not skip" "proceed"

write_health "\"$future_retry_at_fractional\""
check_skip_result "fractional future nextRetryAt skips" "skip"

check_equals "UTC Z timestamp parses independent of local TZ" \
  "1787231067" "$(wavemill_iso8601_to_epoch '2026-08-20T13:04:27Z')"

printf '{}\n' > "$STATE_DIR/queue-health.json"
queue_health_record_failure "timeout" "plan_queue_failed" \
  "123" "123" "60" "143" "" "queue_plan_timeout" \
  "" "planner timeout" '{"taskCount":2,"explicitDependencyCount":1}' || fail "record failure before success"
queue_health_record_success "124" "124" "250" "planner command" || fail "record success after failure"

check_equals "success clears active status" "healthy" "$(jq -r '.status' "$STATE_DIR/queue-health.json")"
check_equals "success clears active failure count" "0" "$(jq -r '.failureCount' "$STATE_DIR/queue-health.json")"
check_equals "success preserves cumulative failures" "1" "$(jq -r '.totalFailureCount' "$STATE_DIR/queue-health.json")"
check_equals "success preserves last failure reason" "timeout" "$(jq -r '.lastFailureEvidence.degradationReason' "$STATE_DIR/queue-health.json")"
check_equals "success preserves last failure owner" "queue_plan_timeout" "$(jq -r '.lastFailureEvidence.planner.cancellationOwner' "$STATE_DIR/queue-health.json")"

echo ""
echo "=== HOK-3130: inference status in queue health ==="

health_field() {
  jq -r "$1" "$STATE_DIR/queue-health.json"
}

inference_report() {
  local status="$1" edges="$2" error="${3:-}"
  jq -cn --arg status "$status" --argjson edges "$edges" --arg error "$error" '{
    schemaVersion: 1,
    inferenceStatus: $status,
    inferredEdgeCount: $edges,
    attempted: true,
    refreshKind: "partial",
    skipReason: null,
    model: "claude-haiku-4-5-20251001",
    lastAttemptAt: "2026-09-30T12:00:00.000Z",
    lastSuccessAt: "2026-09-30T11:00:00.000Z",
    consecutiveFailures: (if $status == "failed" then 2 else 0 end),
    error: (if $error == "" then null else $error end)
  }'
}

printf '{}\n' > "$STATE_DIR/queue-health.json"
queue_health_record_success "200" "200" "120" "planner command" "$(inference_report ok 2)" \
  || fail "record success with ok inference report"
check_equals "ok inference stays healthy" "healthy" "$(health_field '.status')"
check_equals "ok inference records status" "ok" "$(health_field '.inferenceStatus')"
check_equals "ok inference records edge count" "2" "$(health_field '.inferredEdgeCount')"
check_equals "ok inference records model" "claude-haiku-4-5-20251001" "$(health_field '.inference.model')"
check_equals "ok inference keeps dependency queue action" "use_dependency_queue" "$(health_field '.nextAction')"

queue_health_record_success "201" "201" "120" "planner command" \
  "$(inference_report failed 0 'LLM fallback deadline exhausted before claude-sonnet-5')" \
  || fail "record success with failed inference report"
check_equals "failed inference degrades" "degraded" "$(health_field '.status')"
check_equals "failed inference reason" "inference_unavailable" "$(health_field '.degradationReason')"
check_equals "failed inference step" "queue_inference" "$(health_field '.failureStep')"
check_equals "failed inference next action" "use_explicit_edges_only" "$(health_field '.nextAction')"
check_equals "failed inference records status" "failed" "$(health_field '.inferenceStatus')"
check_equals "failed inference records zero edges" "0" "$(health_field '.inferredEdgeCount')"
check_equals "failed inference records error" "LLM fallback deadline exhausted before claude-sonnet-5" "$(health_field '.inference.error')"
check_equals "failed inference records consecutive failures" "2" "$(health_field '.inference.consecutiveFailures')"
check_equals "failed inference sets no planner backoff" "0" "$(health_field '.retryBackoffSeconds')"
check_equals "failed inference sets no retry time" "null" "$(health_field '.nextRetryAt')"
check_equals "failed inference leaves planner failure count at zero" "0" "$(health_field '.failureCount')"
check_equals "failed inference still advances last successful plan" "true" \
  "$(health_field '.lastSuccessfulPlanAt != null')"
check_skip_result "failed inference never backs off the planner" "proceed"
check_equals "status summary names inference status" "degraded (inference_unavailable: failed); use_explicit_edges_only" \
  "$(queue_health_status_summary)"

for degraded_status in stale never; do
  queue_health_record_success "202" "202" "120" "planner command" "$(inference_report "$degraded_status" 0)" \
    || fail "record success with $degraded_status inference report"
  check_equals "$degraded_status inference degrades" "degraded" "$(health_field '.status')"
  check_equals "$degraded_status inference reason" "inference_unavailable" "$(health_field '.degradationReason')"
done

queue_health_record_success "203" "203" "120" "planner command" || fail "record success without report"
check_equals "missing report stays healthy" "healthy" "$(health_field '.status')"
check_equals "missing report clears inference status" "null" "$(health_field '.inferenceStatus')"
check_equals "missing report clears reason" "null" "$(health_field '.degradationReason')"

queue_health_record_success "204" "204" "120" "planner command" '{"not":"a report"}' \
  || fail "record success with invalid report"
check_equals "invalid report stays healthy" "healthy" "$(health_field '.status')"
queue_health_record_success "205" "205" "120" "planner command" 'not json' \
  || fail "record success with non-JSON report"
check_equals "non-JSON report stays healthy" "healthy" "$(health_field '.status')"

# A planner failure after an inference degradation starts a normal episode.
queue_health_record_success "206" "206" "120" "planner command" "$(inference_report failed 0 boom)" \
  || fail "record inference degradation before planner failure"
queue_health_record_failure "timeout" "plan_queue_failed" \
  "207" "207" "60" "143" "" "queue_plan_timeout" "" "planner timeout" '{}' \
  || fail "record planner failure after inference degradation"
check_equals "planner failure overrides inference reason" "timeout" "$(health_field '.degradationReason')"
check_equals "planner failure starts a fresh episode" "1" "$(health_field '.failureCount')"
check_equals "planner failure first attempt has no backoff" "0" "$(health_field '.retryBackoffSeconds')"

echo ""
echo "=== HOK-3130: inference warning dedupe ==="
warn_log="$TEST_TMP/warn.log"
log_warn() { printf '%s\n' "$*" >> "$warn_log"; }
: > "$warn_log"
rm -f "$STATE_DIR/.queue-inference-warn"
queue_health_record_success "210" "210" "120" "planner command" "$(inference_report failed 0 boom)"
queue_health_warn_inference_transition
queue_health_warn_inference_transition
check_equals "inference degradation warns once per status" "1" "$(grep -c 'queue inference unavailable (failed)' "$warn_log")"
queue_health_record_success "211" "211" "120" "planner command" "$(inference_report stale 0)"
queue_health_warn_inference_transition
check_equals "inference status transition warns again" "1" "$(grep -c 'queue inference unavailable (stale)' "$warn_log")"
queue_health_record_success "212" "212" "120" "planner command" "$(inference_report ok 1)"
queue_health_warn_inference_transition
check_equals "recovery clears the warn marker" "false" "$([[ -e "$STATE_DIR/.queue-inference-warn" ]] && echo true || echo false)"
unset -f log_warn

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
if (( FAIL > 0 )); then
  exit 1
fi
