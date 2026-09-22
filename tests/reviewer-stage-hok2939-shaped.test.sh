#!/usr/bin/env bash
# HOK-2970 regression fixture — HOK-2939-shaped shape.
#
# HOK-2939 tightened CI sharding. Sharded harnessId drift left a challenger
# arm without a review artifact and its eval was written as
# `invalidChallenge: true` (missing_challenge_intent). The pair then hit the
# auto-resolve path via `sibling-challenge-aborted`. The resolver must emit
# `invalid_challenge`, not a phantom `forfeit` with a winner.
#
# This test drives that exact shape through the real resolver via a tiny
# tsx entry point that mirrors what tend-challenge-gate wires up.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

fixture_dir="$(mktemp -d "/tmp/wavemill-hok2939-shaped.XXXXXX")"
trap 'rm -rf "$fixture_dir"' EXIT

mkdir -p "$fixture_dir/.wavemill/evals"
cat > "$fixture_dir/.wavemill-config.json" <<'JSON'
{ "integration": { "integrationBranch": "auto/integration" } }
JSON

cat > "$fixture_dir/.wavemill/workflow-state.json" <<'JSON'
{
  "tasks": {
    "HOK-2939-shape": {
      "pr": 1700,
      "branch": "task/hok2939-shape-primary",
      "updated": "2026-09-16T10:00:00Z",
      "challengePairId": "HOK-2939-shape",
      "challengeRole": "primary",
      "challengeModel": "gpt-5.5",
      "evalCompleted": true,
      "challengeExecutionIntent": {
        "schemaVersion": 1,
        "pairId": "HOK-2939-shape",
        "issueId": "HOK-2939-shape",
        "challengeStage": "review",
        "forkStage": "review",
        "sharedPrefix": true,
        "primary": {"pairId":"HOK-2939-shape","side":"primary","challengeStage":"review","expectedStageModel":"gpt-5.5","expectedRoute":{"planner":"","coder":"","reviewer":"gpt-5.5","planDepth":"","codeDepth":"","reviewMode":""}},
        "challenger": {"pairId":"HOK-2939-shape","side":"challenger","challengeStage":"review","expectedStageModel":"kimi-k3","expectedRoute":{"planner":"","coder":"","reviewer":"kimi-k3","planDepth":"","codeDepth":"","reviewMode":""}}
      }
    },
    "HOK-2939-shape_c": {
      "pr": 1701,
      "branch": "task/hok2939-shape-challenger",
      "updated": "2026-09-16T10:00:00Z",
      "challengePairId": "HOK-2939-shape",
      "challengeRole": "challenger",
      "challengeModel": "kimi-k3",
      "challengeAborted": "invalid_challenge:missing_challenge_intent",
      "challengeAbortedStage": "review"
    }
  },
  "jobs": {}
}
JSON

cat > "$fixture_dir/.wavemill/evals/evals.jsonl" <<'JSONL'
{"id":"550e8400-e29b-41d4-a716-446655442939","schemaVersion":"1.50.0","originalPrompt":"x","modelId":"kimi-k3","modelVersion":"kimi-k3","score":0,"scoreBand":"Blocked","timeSeconds":0,"timestamp":"2026-09-16T10:00:00Z","interventionRequired":false,"interventionCount":0,"interventionDetails":[],"rationale":"invalid","challengePairId":"HOK-2939-shape","challengeSide":"challenger","invalidChallenge":true,"challengeDivergenceReason":"missing_challenge_intent","evaluatedPrHeadSha":"sha-2939"}
JSONL

driver="$(mktemp "/tmp/wavemill-hok2939-driver.XXXXXX.mts")"
trap 'rm -f "$driver"; rm -rf "$fixture_dir"' EXIT
cat > "$driver" <<PY
import { resolveUnresolvablePair } from '${REPO_ROOT}/shared/lib/challenge-pair-resolver.ts';
const result = await resolveUnresolvablePair({ pairId: 'HOK-2939-shape', repoDir: '${fixture_dir}' });
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
assert "winner" not in rec or rec.get("winner") is None
assert rec.get("forkStage") == "review"
assert rec.get("terminalReason") == "challenger_challenge_aborted"
with open(records_path) as fh:
    lines = [json.loads(l) for l in fh if l.strip()]
assert len(lines) == 1
assert lines[0]["comparisonOutcome"] == "invalid_challenge"
PY

echo "PASS reviewer-stage-hok2939-shaped"
