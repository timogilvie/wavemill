// wavemill-test-suite: custom
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { backfillRubricProvenance } from './eval-backfill.ts';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  PASS  ${name}`);
    })
    .catch((error) => {
      failed++;
      console.log(`  FAIL  ${name}`);
      console.log(`        ${(error as Error).message}`);
    });
}

function makeRepo(): { repoDir: string; evalsPath: string } {
  const repoDir = mkdtempSync(join(tmpdir(), 'eval-backfill-'));
  const evalsDir = join(repoDir, '.wavemill', 'evals');
  mkdirSync(evalsDir, { recursive: true });
  return { repoDir, evalsPath: join(evalsDir, 'evals.jsonl') };
}

function writeJsonl(path: string, rows: unknown[]): void {
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf-8');
}

console.log('\n--- eval-backfill tests ---\n');

test('marks unmarked records and preserves unknown fields', async () => {
  const { repoDir, evalsPath } = makeRepo();
  try {
    writeJsonl(evalsPath, [
      { id: 'a', extra: { keep: true } },
      { id: 'b', rubric_provenance: 'judge' },
    ]);

    const result = await backfillRubricProvenance({ repoDir });
    assert.deepEqual(result, { scanned: 2, marked: 1, alreadyMarked: 1 });

    const rows = readFileSync(evalsPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(rows[0].rubric_provenance, 'legacy_absent');
    assert.deepEqual(rows[0].extra, { keep: true });
    assert.equal(rows[1].rubric_provenance, 'judge');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('dry-run reports changes without writing', async () => {
  const { repoDir, evalsPath } = makeRepo();
  try {
    writeJsonl(evalsPath, [{ id: 'a' }]);
    const before = readFileSync(evalsPath, 'utf-8');

    const result = await backfillRubricProvenance({ repoDir, dryRun: true });
    const after = readFileSync(evalsPath, 'utf-8');

    assert.deepEqual(result, { scanned: 1, marked: 1, alreadyMarked: 0 });
    assert.equal(after, before);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('is idempotent when all records are already marked', async () => {
  const { repoDir, evalsPath } = makeRepo();
  try {
    writeJsonl(evalsPath, [{ id: 'a', rubric_provenance: 'legacy_absent' }]);

    const result = await backfillRubricProvenance({ repoDir });
    assert.deepEqual(result, { scanned: 1, marked: 0, alreadyMarked: 1 });
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('handles empty evals file', async () => {
  const { repoDir, evalsPath } = makeRepo();
  try {
    writeFileSync(evalsPath, '', 'utf-8');
    const result = await backfillRubricProvenance({ repoDir });
    assert.deepEqual(result, { scanned: 0, marked: 0, alreadyMarked: 0 });
    assert.equal(readFileSync(evalsPath, 'utf-8'), '');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('throws clear error when file is missing', async () => {
  const { repoDir } = makeRepo();
  try {
    rmSync(join(repoDir, '.wavemill', 'evals', 'evals.jsonl'), { force: true });
    await assert.rejects(
      backfillRubricProvenance({ repoDir }),
      /Eval records file not found:/,
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('aborts on malformed JSONL without partial write', async () => {
  const { repoDir, evalsPath } = makeRepo();
  try {
    writeFileSync(evalsPath, '{"id":"a"}\n{bad json}\n', 'utf-8');
    const before = readFileSync(evalsPath, 'utf-8');

    await assert.rejects(
      backfillRubricProvenance({ repoDir }),
      /line 2/,
    );

    assert.equal(readFileSync(evalsPath, 'utf-8'), before);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('rewrites via temp file and leaves no temp artifact behind', async () => {
  const { repoDir, evalsPath } = makeRepo();
  try {
    writeJsonl(evalsPath, [{ id: 'a' }]);
    const evalsDir = join(repoDir, '.wavemill', 'evals');

    await backfillRubricProvenance({ repoDir });

    const entries = readFileSync(evalsPath, 'utf-8');
    assert.match(entries, /legacy_absent/);
    assert.equal(
      readdirSync(evalsDir).some((entry) => entry.startsWith('.evals-rubric-backfill-')),
      false,
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

process.on('beforeExit', () => {
  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    process.exitCode = 1;
  }
});
