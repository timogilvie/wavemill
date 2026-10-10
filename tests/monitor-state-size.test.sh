#!/usr/bin/env bash
# HOK-3190: hot workflow-state.json stays under 500 KB after migration even
# with 500 synthetic terminal history / tombstone records. The migration
# tool sheds the overflow into .wavemill/state-archive/*.jsonl and rewrites
# the hot file in compact JSON.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP="$(mktemp -d -t wavemill-state-size-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

echo "=== Hot state size under 500 KB after migration (HOK-3190) ==="

STATE_FILE="$TMP/workflow-state.json"

# Build a 500-record terminal history + 500-record tombstones state file.
node --experimental-strip-types --no-warnings -e "
  import { writeFileSync } from 'node:fs';
  const state = { session: 'test', tasks: {}, terminalTaskHistory: { tasks: {}, challengePairs: {} }, terminalTaskTombstones: {} };
  for (let i = 0; i < 500; i++) {
    const issue = 'HOK-' + (1000 + i);
    const record = {
      issue, prNumber: String(2000 + i), branch: 'feat/' + i.toString(36),
      worktree: '/tmp/wt/' + i, runEpoch: 'ep-' + i, attempt: 'a' + i,
      createdAt: new Date(Date.now() - i * 86400000).toISOString(),
      slug: 'slug-' + i, deliveryEvidence: { prNumber: String(2000 + i), workflowOutcome: 'merged' },
      // Pad to realistic size (~2KB per record).
      padding: 'x'.repeat(1500),
    };
    state.terminalTaskHistory.tasks[issue] = record;
    state.terminalTaskTombstones[issue + '|' + (2000 + i) + '|ep-' + i + '|a' + i] = record;
  }
  writeFileSync('$STATE_FILE', JSON.stringify(state, null, 2));
"

initial_size=$(wc -c < "$STATE_FILE" | tr -d ' ')
echo "  initial state file: $((initial_size / 1024)) KB"

node --experimental-strip-types --no-warnings "$REPO_DIR/tools/migrate-state-archive.ts" \
  --state-file "$STATE_FILE" --keep 50 --max-age-days 14 --quiet

final_size=$(wc -c < "$STATE_FILE" | tr -d ' ')
echo "  trimmed state file: $((final_size / 1024)) KB"

if (( final_size < 500 * 1024 )); then
  pass "hot workflow-state.json is under 500 KB after migration"
else
  fail "hot workflow-state.json is $((final_size / 1024)) KB (expected < 500 KB)"
fi

# Hot history / tombstones are capped at the keep budget.
remaining_history=$(jq '(.terminalTaskHistory.tasks // {}) | length' "$STATE_FILE")
remaining_tombs=$(jq '(.terminalTaskTombstones // {}) | length' "$STATE_FILE")
if (( remaining_history <= 50 )); then
  pass "hot terminalTaskHistory.tasks count ($remaining_history) <= keep=50"
else
  fail "hot terminalTaskHistory.tasks count is $remaining_history (expected <= 50)"
fi
if (( remaining_tombs <= 50 )); then
  pass "hot terminalTaskTombstones count ($remaining_tombs) <= keep=50"
else
  fail "hot terminalTaskTombstones count is $remaining_tombs (expected <= 50)"
fi

# Archive contains the shed records.
archive_history=$(wc -l < "$TMP/.wavemill/state-archive/history.jsonl" 2>/dev/null | tr -d ' ' || echo 0)
archive_tombs=$(wc -l < "$TMP/.wavemill/state-archive/tombstones.jsonl" 2>/dev/null | tr -d ' ' || echo 0)
if (( archive_history + remaining_history == 500 )); then
  pass "history round-trip (hot + archive) = 500"
else
  fail "history round-trip hot=$remaining_history archive=$archive_history (expected sum 500)"
fi
if (( archive_tombs + remaining_tombs == 500 )); then
  pass "tombstones round-trip (hot + archive) = 500"
else
  fail "tombstones round-trip hot=$remaining_tombs archive=$archive_tombs (expected sum 500)"
fi

# Hot file is written compact (one line, no multi-indent).
first_line_len=$(head -n 1 "$STATE_FILE" | wc -c | tr -d ' ')
total_lines=$(wc -l < "$STATE_FILE" | tr -d ' ')
if (( total_lines <= 2 )) && (( first_line_len > 100 )); then
  pass "hot state file is written compact (single-line JSON)"
else
  fail "hot state file not compact ($total_lines lines, first line $first_line_len bytes)"
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
exit $(( FAIL > 0 ? 1 : 0 ))
