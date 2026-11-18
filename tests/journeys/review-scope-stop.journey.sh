#!/usr/bin/env bash
# Golden journey (HOK-3457): a review scope stop is recorded as a typed
# marker, routed through `decideReviewGateRemediation` as `code-failure`
# delivered to the agent, and the task returns to coding with no operator
# touch.
#
# Protects against the HOK-3358 / HOK-3231 / HOK-3422 silent-stall class:
# the pre-HOK-3457 outcome had the review scope guard refuse the diff, the
# prompt told the agent to "stop review-fix committing", and the monitor
# never saw the scope stop as a code failure. The task sat idle until an
# operator made the coding correction by hand.
#
# After HOK-3457, `tools/check-review-scope.ts` writes `.review-scope-stop.json`
# through `writeMarker` with `--expires-on head,operator-event`, and
# `decideReviewGateRemediation` routes the typed finding to coding. The
# journey asserts the typed disposition (agent / code-failure) and that the
# offending path is carried forward to the coding prompt.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP review-scope-stop journey: $reason"
  exit 0
fi

journey_init review-scope-stop
journey_set_tick_budget 1

FIXTURE_DIR="$JOURNEY_INSTALL_DIR/tests/fixtures/incident-replay/real/hok3358-scope-stall"
RESULT="$JOURNEY_TMP/review-scope-stop.json"

(cd "$JOURNEY_INSTALL_DIR" && node --import tsx --input-type=module -e "
  import { readFileSync } from 'node:fs';
  import { decideReviewGateRemediation } from './shared/lib/review-gate-remediation.ts';
  const marker = JSON.parse(readFileSync('$FIXTURE_DIR/scope-stop-marker.json', 'utf-8'));
  const decision = decideReviewGateRemediation({
    stage: 'review',
    stateDir: '/tmp/review-scope-stop-journey',
    headSha: marker.headSha,
    findings: marker.detail.findings,
    artifact: { kind: 'review-result', identity: 'hok3358-journey' },
  });
  console.log(JSON.stringify({
    disposition: decision.disposition,
    deliverTo: decision.deliverTo,
    offendingPath: decision.deliveryPayload?.finding.offendingPath,
    operatorTouches: decision.deliverTo === 'operator' ? 1 : 0,
  }));
" > "$RESULT")

journey_assert "scope stop routes back to coding (code-failure, delivered to agent)" \
  jq -e '.disposition == "code-failure" and .deliverTo == "agent"' "$RESULT"
journey_assert "the offending path is carried forward to the coding prompt" \
  jq -e '.offendingPath == "shared/lib/wavemill-monitor.sh"' "$RESULT"
journey_assert "zero operator touches to recover from the scope stop" \
  jq -e '.operatorTouches == 0' "$RESULT"
journey_finish
