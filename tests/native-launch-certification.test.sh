#!/usr/bin/env bash
# wavemill-test-suite: standalone (run by its own npm script in package.json)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_DIR"

run_check() {
  local name="$1"
  shift
  echo
  echo "=== $name ==="
  "$@"
}

echo "Native agent launch certification suite"
echo "Repository: $REPO_DIR"

run_check "Native planning, coding, review, and PR handoff units" \
  node --test --test-concurrency=1 \
    shared/lib/native-agent/launch-planning.test.ts \
    shared/lib/native-agent/launch-coding.test.ts \
    shared/lib/native-agent/review.test.ts \
    tools/launch-native-review.test.ts \
    shared/lib/native-agent/workflow-tools/review-flow.test.ts \
    shared/lib/native-agent/workflow-tools/review-integration.test.ts

run_check "Native launch preflight and certification scenario matrix" \
  node --test --test-concurrency=1 \
    tools/check-native-agent-launch.test.ts \
    shared/lib/native-agent/certification/scenarios.test.ts

run_check "Router native Kimi/Qwen/GLM stage eligibility matrix" \
  node --import tsx shared/lib/native-agent/certification/router-filter.test.ts

run_check "Shell launchers, unsupported-stage fail-closed guards, and challenger routing" \
  bash tests/launch-native-planning-phase.test.sh

run_check "Monitor native launch recovery lifecycle fixtures" \
  bash tests/lifecycle-scenarios.test.sh

run_check "Approval gates, missing markers, blocked-completion, and review handoff lifecycle" \
  bash tests/lifecycle-harness.test.sh

run_check "Dashboard and status rendering for native launch failures" \
  bash tests/wavemill-status.test.sh

echo
echo "PASS: native agent launch certification suite completed"
