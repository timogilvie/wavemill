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

# Degraded / inference_unavailable with a lastSuccessAt timestamp.
cat > "$STATE_DIR/queue-health.json" <<'JSON'
{
  "schemaVersion": 1,
  "status": "degraded",
  "degradationReason": "inference_unavailable",
  "episodeStartedAt": "2026-10-08T12:43:00Z",
  "inference": {"lastSuccessAt": "2026-10-07T22:00:00Z"}
}
JSON
banner="$(queue_inference_degraded_banner)"
check_matches "inference_unavailable → single-line banner" \
  '^dependency inference degraded since 2026-10-07T22:00:00Z — showing explicit \+ cached edges$' \
  "$banner"

# Falls back to episodeStartedAt when inference.lastSuccessAt is null.
cat > "$STATE_DIR/queue-health.json" <<'JSON'
{
  "schemaVersion": 1,
  "status": "degraded",
  "degradationReason": "inference_unavailable",
  "episodeStartedAt": "2026-10-08T12:43:00Z",
  "inference": null
}
JSON
banner="$(queue_inference_degraded_banner)"
check_matches "no lastSuccessAt → episodeStartedAt in banner" \
  '^dependency inference degraded since 2026-10-08T12:43:00Z — showing explicit \+ cached edges$' \
  "$banner"

if (( FAIL > 0 )); then
  echo "FAIL  $FAIL failed, $PASS passed"
  exit 1
fi
echo "PASS  $PASS passed"
