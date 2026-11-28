#!/usr/bin/env bash
# Golden journey: a stale launch-state retry never reopens a completed issue.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then echo "SKIP linear-retry-stale-state journey: $reason"; exit 0; fi

journey_init linear-retry-stale-state
journey_set_tick_budget 1
fakes_linear_add_issue JRN-3520 "Completed retry replay" Done

node --import tsx "$JOURNEY_INSTALL_DIR/tests/journeys/fixtures/linear-retry-stale-state/replay.ts" "$REPO_DIR" JRN-3520
journey_assert "completed issue remains Done" test "$(fakes_linear_state_of JRN-3520)" = Done
journey_assert "no retry transition was written" test "$(jq '[.transitions[]? | select(.identifier == "JRN-3520")] | length' "$FAKE_LINEAR_STATE")" = 0
journey_finish
