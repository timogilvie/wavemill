import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const TOOL = join(ROOT, 'tools', 'sync-config.ts');

function makeTempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'sync-config-cli-'));
}

function runSyncConfig(repoDir: string, args: string[] = []) {
  // Run the tool with the current node binary (native TypeScript stripping):
  // `npx tsx` from a temp dir outside the repo cannot see node_modules and
  // falls back to the npx cache/registry, which made this test flaky in CI.
  return spawnSync(process.execPath, [TOOL, ...args], {
    cwd: repoDir,
    encoding: 'utf-8',
    env: process.env,
  });
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

test('dry-run names .wavemill-config.json target and omits local notice without local file', () => {
  const repoDir = makeTempRepo();
  try {
    const result = runSyncConfig(repoDir, ['--dry-run']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /writes shared defaults to \.wavemill-config\.json only/i);
    assert.doesNotMatch(result.stdout, /\.wavemill-config\.local\.json/);
  } finally {
    cleanup(repoDir);
  }
});

test('dry-run with local file shows not modified notice', () => {
  const repoDir = makeTempRepo();
  try {
    writeFileSync(join(repoDir, '.wavemill-config.local.json'), JSON.stringify({ custom: { x: 1 } }), 'utf-8');
    const result = runSyncConfig(repoDir, ['--dry-run']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /\.wavemill-config\.local\.json/);
    assert.match(result.stdout, /never modified by sync/i);
  } finally {
    cleanup(repoDir);
  }
});

test('dry-run local classification includes all labels', () => {
  const repoDir = makeTempRepo();
  try {
    writeFileSync(
      join(repoDir, '.wavemill-config.local.json'),
      JSON.stringify(
        {
          router: { defaultAgent: 'claude', apiKey: 'secret-token' },
          custom: { devOnly: true },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const result = runSyncConfig(repoDir, ['--dry-run']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /will add to repo default/);
    assert.match(result.stdout, /already local-only/);
    assert.match(result.stdout, /requires decision/);
  } finally {
    cleanup(repoDir);
  }
});

test('write mode aborts on requires-decision conflict before writes/backup', () => {
  const repoDir = makeTempRepo();
  try {
    const basePath = join(repoDir, '.wavemill-config.json');
    const backupPath = join(repoDir, '.wavemill-config.json.backup');
    writeFileSync(basePath, JSON.stringify({ configVersion: '1.0.0', router: {} }, null, 2) + '\n', 'utf-8');
    writeFileSync(join(repoDir, '.wavemill-config.local.json'), JSON.stringify({ router: { llmModel: '/tmp/private/model' } }), 'utf-8');

    const before = readFileSync(basePath, 'utf-8');
    const result = runSyncConfig(repoDir, ['--yes']);

    assert.notEqual(result.status, 0, 'expected guard failure');
    assert.match(result.stderr + result.stdout, /require explicit decision/i);
    assert.equal(readFileSync(basePath, 'utf-8'), before);
    assert.equal(existsSync(backupPath), false);
  } finally {
    cleanup(repoDir);
  }
});

test('malformed local override fails and mentions .wavemill-config.local.json', () => {
  const repoDir = makeTempRepo();
  try {
    writeFileSync(join(repoDir, '.wavemill-config.local.json'), '{ not-valid-json', 'utf-8');
    const result = runSyncConfig(repoDir, ['--dry-run']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /\.wavemill-config\.local\.json/);
  } finally {
    cleanup(repoDir);
  }
});
