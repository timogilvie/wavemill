#!/usr/bin/env bash
# HOK-3179: smoke test for queue_inference_degraded_banner.
# When queue-health.json reports degraded / inference_unavailable, the picker
# banner is a one-line string; otherwise it is empty.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

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

check_matches() {
  local name="$1" pattern="$2" actual="$3"
  if [[ "$actual" =~ $pattern ]]; then
    pass "$name"
  else
    echo "    pattern: [$pattern]"
    echo "    actual:  [$actual]"
    fail "$name"
  fi
}

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT
STATE_DIR="$TEST_TMP"
export STATE_DIR

echo "=== HOK-3179: queue_inference_degraded_banner ==="

# No queue-health.json yet: banner is empty.
banner="$(queue_inference_degraded_banner)"
check_equals "missing queue-health → empty banner" "" "$banner"

# Healthy status: banner is empty.
cat > "$STATE_DIR/queue-health.json" <<'JSON'
{"schemaVersion":1,"status":"healthy","degradationReason":null}
JSON
banner="$(queue_inference_degraded_banner)"
check_equals "healthy status → empty banner" "" "$banner"

# Degraded with another reason: banner is empty.
cat > "$STATE_DIR/queue-health.json" <<'JSON'
{"schemaVersion":1,"status":"degraded","degradationReason":"timeout"}
JSON
banner="$(queue_inference_degraded_banner)"
check_equals "non-inference degradation → empty banner" "" "$banner"

# HOK-3314: the banner now reads from the stamped `.currentAlertProjection`
# summary. A fresh queue-health.json without a projection block falls back
# through the on-demand deriver inside queue_alert_projection_read; both
# paths use the same projection wording.
cat > "$STATE_DIR/queue-health.json" <<'JSON'
{
  "schemaVersion": 1,
  "status": "degraded",
  "degradationReason": "inference_unavailable",
  "inferenceStatus": "failed",
  "inferredEdgeCount": 49,
  "episodeStartedAt": "2026-10-08T12:43:00Z",
  "inference": {"consecutiveFailures": 1, "lastSuccessAt": "2026-10-07T22:00:00Z", "lastAttemptAt": "2026-10-08T12:43:00Z"},
  "currentAlertProjection": {
    "schemaVersion": 1,
    "status": "degraded-inference",
    "episode": {
      "id": "queue-alert:inference:2026-10-08T12:43:00Z",
      "kind": "inference",
      "startedAt": "2026-10-08T12:43:00Z",
      "consecutiveFailedAttempts": 1,
      "latestFailureAt": "2026-10-08T12:43:00Z",
      "latestSuccessAt": "2026-10-07T22:00:00Z",
      "severity": "low"
    },
    "summary": "Queue inference unavailable · 1 consecutive failed attempt · last success 2026-10-07T22:00:00Z · last failure 2026-10-08T12:43:00Z · cached inferred edges still in use",
    "nextAction": "use_cached_and_explicit_edges",
    "evidenceWarnings": []
  }
}
JSON
banner="$(queue_inference_degraded_banner)"
check_matches "inference_unavailable → projection summary banner" \
  'Queue inference unavailable · 1 consecutive failed attempt' \
  "$banner"
check_matches "banner names cached inferred edges when > 0" 'cached inferred edges still in use' "$banner"

# Legacy queue-health.json without a stamped projection: on-demand deriver
# fills in from top-level + inference fields and the banner still fires.
cat > "$STATE_DIR/queue-health.json" <<'JSON'
{
  "schemaVersion": 1,
  "status": "degraded",
  "degradationReason": "inference_unavailable",
  "inferenceStatus": "failed",
  "inferredEdgeCount": 0,
  "episodeStartedAt": "2026-10-08T12:43:00Z",
  "inference": {"consecutiveFailures": 2, "lastAttemptAt": "2026-10-08T12:43:00Z"}
}
JSON
banner="$(queue_inference_degraded_banner)"
check_matches "legacy health file → derived banner" \
  'Queue inference unavailable' \
  "$banner"
check_matches "legacy health file → includes explicit relations wording" 'explicit relations only' "$banner"

if (( FAIL > 0 )); then
  echo "FAIL  $FAIL failed, $PASS passed"
  exit 1
fi
echo "PASS  $PASS passed"
