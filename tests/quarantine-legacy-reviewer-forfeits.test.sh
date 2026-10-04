#!/usr/bin/env bash
# HOK-2970: end-to-end shell smoke test for the legacy reviewer-forfeit
# quarantine sweep. Seeds a HOK-2958-shaped fixture, runs --apply, then a
# second --apply (which must be a no-op).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TOOL="$REPO_ROOT/tools/quarantine-legacy-reviewer-forfeits.ts"

fixture_dir="$(mktemp -d "/tmp/wavemill-hok2970-shelltest.XXXXXX")"
trap 'rm -rf "$fixture_dir"' EXIT

mkdir -p "$fixture_dir/.wavemill/evals"
cat > "$fixture_dir/.wavemill-config.json" <<'JSON'
{ "integration": { "integrationBranch": "auto/integration" } }
JSON

cat > "$fixture_dir/.wavemill/evals/challenge-records.jsonl" <<'JSONL'
{"challengePairId":"HOK-2958","primaryModel":"gpt-5.5","challengerModel":"kimi-k3","primaryPrUrl":"https://github.com/org/repo/pull/1015","challengerPrUrl":"https://github.com/org/repo/pull/1016","primaryEvalScore":null,"challengerEvalScore":null,"winner":"primary","winnerModel":"gpt-5.5","rationale":"legacy forfeit","dimensions":{"completeness":{"primary":0,"challenger":0},"correctness":{"primary":0,"challenger":0},"code_quality":{"primary":0,"challenger":0},"intervention_impact":{"primary":0,"challenger":0},"autonomy":{"primary":0,"challenger":0}},"timestamp":"2026-09-14T00:00:00Z","comparisonOutcome":"forfeit","terminalReason":"challenger_challenge_aborted","forkStage":"review"}
JSONL

cat > "$fixture_dir/.wavemill/evals/evals.jsonl" <<'JSONL'
{"id":"550e8400-e29b-41d4-a716-446655440901","schemaVersion":"1.50.0","originalPrompt":"x","modelId":"kimi-k3","modelVersion":"kimi-k3","score":0,"scoreBand":"Blocked","timeSeconds":0,"timestamp":"2026-09-14T00:00:00Z","interventionRequired":false,"interventionCount":0,"interventionDetails":[],"rationale":"invalid","challengePairId":"HOK-2958","challengeSide":"challenger","invalidChallenge":true,"challengeDivergenceReason":"missing_challenge_intent","evaluatedPrHeadSha":"deadbeef"}
JSONL

cd "$REPO_ROOT"

# First apply: rewrites the row and creates a backup.
output1="$(WAVEMILL_MILL_RUNNING=0 npx tsx "$TOOL" --repo-dir "$fixture_dir" --apply)"
if ! grep -q "rewrote 1" <<<"$output1"; then
  echo "FAIL: expected 'rewrote 1' in first-apply output; got:" >&2
  echo "$output1" >&2
  exit 1
fi
if ! grep -q "backup:" <<<"$output1"; then
  echo "FAIL: expected backup path in first-apply output; got:" >&2
  echo "$output1" >&2
  exit 1
fi

# Row must now be invalid_challenge with no winner and preserved forkStage.
python3 - "$fixture_dir/.wavemill/evals/challenge-records.jsonl" <<'PY'
import json, sys
path = sys.argv[1]
lines = [json.loads(l) for l in open(path) if l.strip()]
assert len(lines) == 1, f"expected 1 line, got {len(lines)}"
row = lines[0]
assert row["challengePairId"] == "HOK-2958"
assert row["comparisonOutcome"] == "invalid_challenge", row
assert row["invalidChallenge"] is True
assert "winner" not in row, f"winner should be stripped: {row}"
assert "winnerModel" not in row
assert row.get("forkStage") == "review"
q = row["quarantined"]
assert q["reason"] == "aborted-arm-was-invalid"
assert q["ticket"] == "HOK-2970"
assert q["evidence"]["abortedSide"] == "challenger"
PY

# A .bak file exists.
bak_count="$(ls "$fixture_dir/.wavemill/evals" | grep -c "challenge-records.jsonl.bak.")"
if [[ "$bak_count" != "1" ]]; then
  echo "FAIL: expected 1 backup file, found $bak_count" >&2
  exit 1
fi

# Second apply: no-op.
output2="$(WAVEMILL_MILL_RUNNING=0 npx tsx "$TOOL" --repo-dir "$fixture_dir" --apply)"
if ! grep -q "rewrote 0" <<<"$output2"; then
  echo "FAIL: expected 'rewrote 0' on second apply; got:" >&2
  echo "$output2" >&2
  exit 1
fi
bak_count_after="$(ls "$fixture_dir/.wavemill/evals" | grep -c "challenge-records.jsonl.bak.")"
if [[ "$bak_count_after" != "1" ]]; then
  echo "FAIL: idempotent run must not create a new backup; found $bak_count_after" >&2
  exit 1
fi

echo "PASS quarantine-legacy-reviewer-forfeits"
