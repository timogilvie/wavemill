import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const tool = join(dirname(fileURLToPath(import.meta.url)), 'ready-tend-handoff.ts');

function run(featureDir: string, action: string): { status: number | null; outcome: string } {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', tool, action, '42', '--feature-dir', featureDir, '--head', 'head-a'],
    { encoding: 'utf8' },
  );
  const lastLine = result.stdout.trim().split('\n').pop() ?? '';
  return { status: result.status, outcome: lastLine ? JSON.parse(lastLine).outcome : '' };
}

test('HOK-3450: a rejected handoff transition exits non-zero and keeps its JSON evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-tend-handoff-tool-'));
  try {
    // Nothing published yet: the claim is rejected.
    assert.deepEqual(run(dir, 'claim'), { status: 1, outcome: 'rejected' });
    // A checked record is still not published.
    assert.deepEqual(run(dir, 'checked'), { status: 0, outcome: 'checked' });
    assert.deepEqual(run(dir, 'claim'), { status: 1, outcome: 'rejected' });
    // Accepted transitions exit zero, including idempotent replays.
    assert.deepEqual(run(dir, 'publish'), { status: 0, outcome: 'published' });
    assert.deepEqual(run(dir, 'publish'), { status: 0, outcome: 'already-published' });
    assert.deepEqual(run(dir, 'claim'), { status: 0, outcome: 'claimed' });
    assert.deepEqual(run(dir, 'claim'), { status: 0, outcome: 'already-claimed' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
