#!/usr/bin/env bash
# HOK-3203: hot state byte-cap enforcement with iterative halving.
# Synthesize 50 entries × 48 KB task payloads = ~2.4 MB hot state.
# Run migrate-state-archive.ts --byte-cap 500000 --compact-kept.
# Assert hot file < 500 KB.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP="$(mktemp -d -t wavemill-byte-cap-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

echo "=== Hot state byte-cap enforcement (HOK-3203) ==="

STATE_FILE="$TMP/workflow-state.json"

# Build a state file with 50 entries × 48 KB task fields = ~2.4 MB
node --experimental-strip-types --no-warnings -e "
  import { writeFileSync } from 'node:fs';
  const state = { session: 'test', tasks: {}, terminalTaskHistory: { tasks: {}, challengePairs: {} }, terminalTaskTombstones: {} };
  for (let i = 0; i < 50; i++) {
    const issue = 'HOK-' + (3000 + i);
    const record = {
      schemaVersion: 1,
      issue, prNumber: String(4000 + i), branch: 'feat/' + i.toString(36),
      worktree: '/tmp/wt/' + i, runEpoch: 'ep-' + i, attempt: 'a' + i,
      createdAt: new Date(Date.now() - i * 86400000).toISOString(),
      slug: 'slug-' + i,
      workflowOutcome: 'merged',
      resourceDisposition: 'reaped',
      actor: 'test',
      command: 'cleanup',
      decisionStatus: 'reaped',
      decisionReason: '',
      task: { issue, slug: 'slug-' + i, phase: 'done', padding: 'x'.repeat(48000) },
      cleanupDecision: { status: 'reaped', reason: 'merged' },
      deliveryEvidence: { prNumber: String(4000 + i), workflowOutcome: 'merged' },
    };
    state.terminalTaskHistory.tasks[issue] = record;
    state.terminalTaskTombstones[issue + '|' + (4000 + i) + '|ep-' + i + '|a' + i] = record;
  }
  writeFileSync('$STATE_FILE', JSON.stringify(state, null, 2));
"

initial_size=$(wc -c < "$STATE_FILE" | tr -d ' ')
echo "  initial state file: $((initial_size / 1024)) KB"

if (( initial_size < 2000 * 1024 )); then
  fail "initial state file should be ~2.4 MB (got $((initial_size / 1024)) KB)"
else
  pass "initial state file is large enough ($((initial_size / 1024)) KB)"
fi

node --experimental-strip-types --no-warnings "$REPO_DIR/tools/migrate-state-archive.ts" \
  --state-file "$STATE_FILE" --byte-cap 500000 --compact-kept --quiet

final_size=$(wc -c < "$STATE_FILE" | tr -d ' ')
echo "  final state file: $((final_size / 1024)) KB"

if (( final_size <= 500 * 1024 )); then
  pass "hot state file is under 500 KB after byte-cap enforcement"
else
  fail "hot state file is $((final_size / 1024)) KB (expected <= 500 KB)"
fi

# Kept records should be compact
has_task_field=$(jq '[(.terminalTaskHistory.tasks // {} | .[] | has("task"))] | any' "$STATE_FILE")
if [[ "$has_task_field" == "false" ]]; then
  pass "kept records are missing .task (compacted)"
else
  fail "kept records still contain .task field"
fi

# Archive should contain the full records
archive_history=$(wc -l < "$TMP/.wavemill/state-archive/history.jsonl" 2>/dev/null | tr -d ' ' || echo 0)
archive_tombs=$(wc -l < "$TMP/.wavemill/state-archive/tombstones.jsonl" 2>/dev/null | tr -d ' ' || echo 0)
if (( archive_history > 0 )); then
  pass "archive contains history records ($archive_history lines)"
else
  fail "archive should contain history records"
fi
if (( archive_tombs > 0 )); then
  pass "archive contains tombstone records ($archive_tombs lines)"
else
  fail "archive should contain tombstone records"
fi

# Archive records should have the full task field
archive_has_task=$(jq -s '[.[] | has("task")] | all' "$TMP/.wavemill/state-archive/history.jsonl" 2>/dev/null || echo false)
if [[ "$archive_has_task" == "true" ]]; then
  pass "archive records contain full .task field"
else
  fail "archive records should contain full .task field"
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
exit $(( FAIL > 0 ? 1 : 0 ))
