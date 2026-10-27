#!/usr/bin/env bash
# Golden journey (HOK-3314): one queue-inference incident from first failure
# through cooldown, retry, success, and recurrence, with a parallel event-only
# incident ("host-sleep" shape) running alongside the whole time to prove the
# shared incident-store absence sweep still auto-resolves true absence after 5
# cycles.
#
# Protects against:
#   - the Oct-22 incident: lifetime occurrenceCount=157, recurrence=19 for one
#     unchanged inference failure (stable evidence.key / timestamp through the
#     projection) — now stays at occurrenceCount=1 across repeated polls;
#   - unchanged failed conditions auto-resolving after 5 cycles (sweep now
#     splits fresh vs observed);
#   - cache-only / cooldown planner polls clearing inferenceStatus (writer now
#     preserves it);
#   - shared-store regression: a parallel event-only incident must still
#     auto-resolve after 5 absent cycles.
#
# This journey does not use the mill harness (plan→code→review→ready chain)
# because queue inference is a planner-sidecar function, not a per-task phase.
# It drives the real queue-health.sh writer, the real queue-alert projection
# CLI, and the real wavemill-incident-store sweep over the same files an
# observer tick would read. The TS driver runs as a long-lived coprocess so
# we pay the tsx startup cost once instead of per cycle.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# shellcheck source=../../shared/lib/wavemill-common.sh
source "$REPO_ROOT/shared/lib/wavemill-common.sh"
# shellcheck source=../../shared/lib/queue-health.sh
source "$REPO_ROOT/shared/lib/queue-health.sh"

JOURNEY_TMP="$(mktemp -d "${TMPDIR:-/tmp}/journey-queue-inference-episode.XXXXXX")"
cleanup() {
  if [[ -n "${CYCLE_PID:-}" ]] && kill -0 "$CYCLE_PID" 2>/dev/null; then
    kill "$CYCLE_PID" 2>/dev/null || true
  fi
  rm -rf "$JOURNEY_TMP"
}
trap cleanup EXIT

# Lay out the directory tree the detector expects: $REPO/.wavemill/{queue-health.json,incidents/}
JOURNEY_REPO="$JOURNEY_TMP/repo"
export STATE_DIR="$JOURNEY_REPO/.wavemill"
export WAVEMILL_INSTALL_DIR="$REPO_ROOT"
mkdir -p "$STATE_DIR/incidents"
INCIDENTS_DIR="$STATE_DIR/incidents"
HEALTH_FILE="$STATE_DIR/queue-health.json"
printf '{}\n' > "$HEALTH_FILE"

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; echo "         $2"; FAIL=$((FAIL + 1)); }

assert_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass "$name"
  else
    fail "$name" "expected=[$expected] actual=[$actual]"
  fi
}

echo "=== HOK-3314 journey: queue-inference episode ==="

# ---- long-lived observer-cycle coprocess ------------------------------------
# One tsx process reads one JSON request per line from CYCLE_IN and writes one
# JSON response per line to CYCLE_OUT. The journey writes to CYCLE_IN and
# reads from CYCLE_OUT. 24 cycles cost ~2s instead of ~24s with per-cycle
# tsx spawn.
CYCLE_IN="$JOURNEY_TMP/cycle.in"
CYCLE_OUT="$JOURNEY_TMP/cycle.out"
mkfifo "$CYCLE_IN" "$CYCLE_OUT"

OBS_HEALTH="$HEALTH_FILE" OBS_INCIDENTS="$INCIDENTS_DIR" \
  npx tsx "$REPO_ROOT/tests/journeys/fixtures/queue-inference-cycle.ts" \
    < "$CYCLE_IN" > "$CYCLE_OUT" &
CYCLE_PID=$!

# Open both pipe ends; bash connects fds 3 (writer→driver) and 4 (reader←driver).
exec 3> "$CYCLE_IN"
exec 4< "$CYCLE_OUT"

cycle() {
  local observed_json="${1:-[]}"
  printf '{"cmd":"cycle","observed":%s}\n' "$observed_json" >&3
  local response
  IFS= read -r response <&4 || return 1
  printf '%s' "$response"
}

inference_report() {
  local status="$1" failures="$2" error="${3:-}" attempted="${4:-true}" skip="${5:-}"
  jq -cn \
    --arg status "$status" \
    --argjson failures "$failures" \
    --arg error "$error" \
    --argjson attempted "$attempted" \
    --arg skip "$skip" '
    {
      schemaVersion: 1,
      inferenceStatus: (if $status == "" then null else $status end),
      inferredEdgeCount: 49,
      attempted: $attempted,
      refreshKind: "partial",
      skipReason: (if $skip == "" then null else $skip end),
      model: "claude-haiku-4-5-20251001",
      lastAttemptAt: "2026-10-26T14:00:00.000Z",
      lastSuccessAt: "2026-10-26T13:59:00.000Z",
      consecutiveFailures: $failures,
      error: (if $error == "" then null else $error end)
    }'
}

count_rootcause() {
  local root="$1"
  if [[ ! -f "$INCIDENTS_DIR/index.json" ]]; then echo 0; return; fi
  jq --arg root "$root" '[ to_entries[] | select(.value.rootCauseClass == $root) ] | length' \
    < "$INCIDENTS_DIR/index.json"
}

queue_record_field() {
  local expr="$1"
  jq -r "[ to_entries[] | select(.value.rootCauseClass | startswith(\"queue_\")) | .value ][0] | $expr" \
    < "$INCIDENTS_DIR/index.json"
}

projection_field() {
  local expr="$1"
  jq -r ".currentAlertProjection | $expr" < "$HEALTH_FILE"
}

seed_parallel_incident() {
  cat > "$INCIDENTS_DIR/index.json" <<'EOF'
{
  "parallel-host-sleep-fingerprint": {
    "fingerprint": "parallel-host-sleep-fingerprint",
    "category": "configuration_operator_condition",
    "rootCauseClass": "host_sleep_observed",
    "severity": "low",
    "lifecycle": "active",
    "firstObservedAt": "2026-10-26T00:00:00.000Z",
    "createdAt": "2026-10-26T00:00:00.000Z",
    "lastObservedAt": "2026-10-26T00:00:00.000Z",
    "occurrenceCount": 1,
    "evidence": [{"type": "host-sleep", "source": "observer", "key": "parallel", "timestamp": "2026-10-26T00:00:00.000Z"}],
    "detectorIds": ["host-sleep-detector"],
    "sources": [],
    "metadata": {"missedCycles": 0},
    "taskId": null
  }
}
EOF
}

# ---- phase 1: first inference failure ---------------------------------------

queue_health_record_success "100" "100" "120" "planner cmd" \
  "$(inference_report failed 1 'LLM fallback deadline exhausted before claude-sonnet-5')"

assert_eq "projection emitted after inference failure" "degraded-inference" "$(projection_field '.status')"
assert_eq "severity is low at 1 failure" "low" "$(projection_field '.episode.severity')"
assert_eq "consecutive failed attempts = 1" "1" "$(projection_field '.episode.consecutiveFailedAttempts')"
assert_eq "nextAction names cached inferred edges" "use_cached_and_explicit_edges" "$(projection_field '.nextAction')"

seed_parallel_incident

RESP="$(cycle '[]')"
QUEUE_FP="$(printf '%s' "$RESP" | jq -r '.queueFingerprint')"

assert_eq "incident created at cycle 1" "1" "$(count_rootcause queue_planner_degraded)"
assert_eq "occurrenceCount=1 after first fresh event" "1" "$(queue_record_field '.occurrenceCount')"

# ---- phase 2: 12 identical polls (the Oct-22 shape) -------------------------

for cycle_i in 2 3 4 5 6 7 8 9 10 11 12 13; do
  queue_health_record_success "10$cycle_i" "10$cycle_i" "120" "planner cmd" \
    "$(inference_report failed "$cycle_i" 'LLM fallback deadline exhausted before claude-sonnet-5')"
  cycle "[\"$QUEUE_FP\"]" >/dev/null
done

assert_eq "still a single queue incident after 12 polls" "1" "$(count_rootcause queue_planner_degraded)"
assert_eq "occurrenceCount stayed 1 across repeated polls" "1" "$(queue_record_field '.occurrenceCount')"
LIFECYCLE="$(queue_record_field '.lifecycle')"
if [[ "$LIFECYCLE" == "observed" || "$LIFECYCLE" == "active" ]]; then
  pass "lifecycle still open ($LIFECYCLE)"
else
  fail "lifecycle still open" "actual=[$LIFECYCLE]"
fi
assert_eq "severity escalated to high at >= 5 consecutive failures" "high" "$(projection_field '.episode.severity')"

assert_eq "parallel event-only incident auto-resolved by absence" "resolved" \
  "$(jq -r '.["parallel-host-sleep-fingerprint"].lifecycle' < "$INCIDENTS_DIR/index.json")"

# ---- phase 3: cooldown-skipped poll preserves state -------------------------

queue_health_record_success "200" "200" "0" "planner cmd" \
  "$(inference_report '' 0 '' false cooldown)"

assert_eq "cooldown preserves degraded-inference status" "degraded-inference" "$(projection_field '.status')"
assert_eq "cooldown preserves consecutive failures" "13" "$(projection_field '.episode.consecutiveFailedAttempts')"

cycle "[\"$QUEUE_FP\"]" >/dev/null
assert_eq "still a single queue incident after cooldown cycle" "1" "$(count_rootcause queue_planner_degraded)"
assert_eq "occurrenceCount unchanged after cooldown" "1" "$(queue_record_field '.occurrenceCount')"

# ---- phase 4: inference recovers --------------------------------------------

queue_health_record_success "300" "300" "150" "planner cmd" "$(inference_report ok 0)"

assert_eq "projection healthy after inference ok" "healthy" "$(projection_field '.status')"
assert_eq "episode cleared on recovery" "null" "$(projection_field '.episode')"

for _ in 1 2 3 4 5 6; do
  cycle '[]' >/dev/null
done

assert_eq "queue incident auto-resolved by absence after recovery" "resolved" "$(queue_record_field '.lifecycle')"

# ---- phase 5: inference fails again (recurrence) ----------------------------

queue_health_record_success "400" "400" "120" "planner cmd" \
  "$(inference_report failed 1 'LLM fallback deadline exhausted (recurrence)')"

assert_eq "projection re-degraded on recurrence" "degraded-inference" "$(projection_field '.status')"
assert_eq "new episode has consecutive=1" "1" "$(projection_field '.episode.consecutiveFailedAttempts')"

cycle '[]' >/dev/null
RECURRENCE_COUNT="$(jq -r '[ to_entries[] | select(.value.rootCauseClass | startswith("queue_")) | .value.metadata.recurrence.count ][0] // 0' < "$INCIDENTS_DIR/index.json")"
if (( RECURRENCE_COUNT <= 1 )); then
  pass "recurrence count stayed <= 1 (observed=$RECURRENCE_COUNT)"
else
  fail "recurrence count stayed <= 1" "observed=$RECURRENCE_COUNT"
fi

# Close the pipes so the coprocess exits cleanly.
exec 3>&-
exec 4<&-

echo ""
echo "--- journey summary: $PASS passed, $FAIL failed ---"
if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
