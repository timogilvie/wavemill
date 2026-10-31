import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const cli = 'tools/seam-artifact-cli.ts';

function run(args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: process.cwd(),
    encoding: 'utf-8',
  });
}

test('validate exits 0 for valid artifacts and emits structured JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seam-cli-'));
  try {
    const artifact = join(dir, '.coding-complete');
    writeFileSync(artifact, '{"stage":"coding","confidence":"high"}\n');
    const result = run(['validate', 'coding-complete', artifact]);
    assert.equal(result.status, 0);
    const payload = JSON.parse(result.stdout) as { ok: boolean; value?: { confidence?: string } };
    assert.equal(payload.ok, true);
    assert.equal(payload.value?.confidence, 'high');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validate exits 1 for invalid artifacts and reports shared error paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seam-cli-'));
  try {
    const artifact = join(dir, '.coding-blocked-completion.json');
    writeFileSync(artifact, JSON.stringify({
      stage: 'coding',
      implementationComplete: true,
      committed: true,
      passingChecks: ['ok'],
      blockingChecks: ['npm test'],
      blockingReason: 'environmental_and_baseline_collection_failures',
      evidence: 'bad enum',
      recommendedAction: 'advance_to_review',
    }));
    const result = run(['validate', 'blocked-completion', artifact]);
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout) as { ok: boolean; errors?: Array<{ code: string; path: string }> };
    assert.equal(payload.ok, false);
    assert.deepEqual(payload.errors?.map((error) => ({ code: error.code, path: error.path })), [
      { code: 'INVALID_ENUM_VALUE', path: '$.blockingReason' },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validate --canonicalize rewrites legacy coding-complete markers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seam-cli-'));
  try {
    const artifact = join(dir, '.coding-complete');
    writeFileSync(artifact, 'confidence=medium\ncommit=abc1234\n');
    const result = run(['validate', 'coding-complete', artifact, '--canonicalize']);
    assert.equal(result.status, 0);
    assert.equal(readFileSync(artifact, 'utf-8'), '{\n  "stage": "coding",\n  "confidence": "medium",\n  "commit": "abc1234"\n}\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('usage errors exit 2', () => {
  const result = run(['validate', 'unknown-artifact', '/tmp/nope']);
  assert.equal(result.status, 2);
});
