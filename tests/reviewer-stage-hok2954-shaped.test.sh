#!/usr/bin/env bash
# HOK-2970 regression fixture — HOK-2954-shaped shape.
#
# HOK-2954 concerns startup rehydration reconciling terminal PR state. When
# rehydration finds a terminal PR whose challenger arm was reaped mid-review
# and its eval marked `invalidChallenge: true`, the auto-resolve path is the
# same one HOK-2970 fixes: it must emit `invalid_challenge` (no winner),
# not `both-forfeit` with a phantom winner from the surviving arm.
#
# The differentiator vs the HOK-2939 shape: here BOTH arms carry a
# challengeAborted stamp (the startup rehydrator quarantined both), and
# only one has a persisted valid eval; the surviving arm should NOT win.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

fixture_dir="$(mktemp -d "/tmp/wavemill-hok2954-shaped.XXXXXX")"
driver=""
cleanup() {
  rm -rf "$fixture_dir"
  [[ -n "$driver" ]] && rm -f "$driver"
}
trap cleanup EXIT

mkdir -p "$fixture_dir/.wavemill/evals"
cat > "$fixture_dir/.wavemill-config.json" <<'JSON'
{ "integration": { "integrationBranch": "auto/integration" } }
JSON

cat > "$fixture_dir/.wavemill/workflow-state.json" <<'JSON'
{
  "tasks": {
    "HOK-2954-shape": {
      "pr": 1800,
      "branch": "task/hok2954-shape-primary",
      "updated": "2026-09-16T11:00:00Z",
      "challengePairId": "HOK-2954-shape",
      "challengeRole": "primary",
      "challengeModel": "gpt-5.5",
      "evalCompleted": true,
      "challengeAborted": "startup_rehydration:review_reaped",
      "challengeAbortedStage": "review",
      "challengeExecutionIntent": {
        "schemaVersion": 1,
        "pairId": "HOK-2954-shape",
        "issueId": "HOK-2954-shape",
        "challengeStage": "review",
        "forkStage": "review",
        "sharedPrefix": true,
        "primary": {"pairId":"HOK-2954-shape","side":"primary","challengeStage":"review","expectedStageModel":"gpt-5.5","expectedRoute":{"planner":"","coder":"","reviewer":"gpt-5.5","planDepth":"","codeDepth":"","reviewMode":""}},
        "challenger": {"pairId":"HOK-2954-shape","side":"challenger","challengeStage":"review","expectedStageModel":"kimi-k3","expectedRoute":{"planner":"","coder":"","reviewer":"kimi-k3","planDepth":"","codeDepth":"","reviewMode":""}}
      }
    },
    "HOK-2954-shape_c": {
      "pr": 1801,
      "branch": "task/hok2954-shape-challenger",
      "updated": "2026-09-16T11:00:00Z",
      "challengePairId": "HOK-2954-shape",
      "challengeRole": "challenger",
      "challengeModel": "kimi-k3",
      "challengeAborted": "startup_rehydration:review_reaped",
      "challengeAbortedStage": "review"
    }
  },
  "jobs": {}
}
JSON

cat > "$fixture_dir/.wavemill/evals/evals.jsonl" <<'JSONL'
{"id":"550e8400-e29b-41d4-a716-446655442954","schemaVersion":"1.50.0","originalPrompt":"x","modelId":"kimi-k3","modelVersion":"kimi-k3","score":0,"scoreBand":"Blocked","timeSeconds":0,"timestamp":"2026-09-16T11:00:00Z","interventionRequired":false,"interventionCount":0,"interventionDetails":[],"rationale":"invalid","challengePairId":"HOK-2954-shape","challengeSide":"challenger","invalidChallenge":true,"challengeDivergenceReason":"missing_challenge_intent","evaluatedPrHeadSha":"sha-2954"}
JSONL

driver="$(mktemp "/tmp/wavemill-hok2954-driver.XXXXXX.mts")"
cat > "$driver" <<PY
import { resolveUnresolvablePair } from '${REPO_ROOT}/shared/lib/challenge-pair-resolver.ts';
const result = await resolveUnresolvablePair({ pairId: 'HOK-2954-shape', repoDir: '${fixture_dir}' });
process.stdout.write(JSON.stringify(result));
PY

cd "$REPO_ROOT"
output="$(npx tsx "$driver")"

python3 - "$output" "$fixture_dir/.wavemill/evals/challenge-records.jsonl" <<'PY'
import json, sys
result = json.loads(sys.argv[1])
records_path = sys.argv[2]
assert result["status"] == "resolved", result
assert result["outcome"] == "invalid_challenge", result
rec = result["record"]
assert rec["comparisonOutcome"] == "invalid_challenge"
assert rec["invalidChallenge"] is True
assert "winner" not in rec or rec.get("winner") is None, rec
assert rec.get("forkStage") == "review"
with open(records_path) as fh:
    lines = [json.loads(l) for l in fh if l.strip()]
assert len(lines) == 1
PY

echo "PASS reviewer-stage-hok2954-shaped"
