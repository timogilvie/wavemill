import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const toolPath = path.join(repoRoot, 'tools', 'check-drift.ts');

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeRepo(): string {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'check-drift-tool-'));
  tempDirs.push(repoDir);
  mkdirSync(path.join(repoDir, '.wavemill', 'context'), { recursive: true });
  mkdirSync(path.join(repoDir, 'shared', 'lib'), { recursive: true });
  return repoDir;
}

function writeSpec(repoDir: string, subsystemId: string, name: string, keyFile: string): string {
  const specPath = path.join(repoDir, '.wavemill', 'context', `${subsystemId}.md`);
  writeFileSync(
    specPath,
    `# Subsystem: ${name}

## Key Files
| File | Purpose |
| --- | --- |
| \`${keyFile}\` | Test file |
`
  );
  return specPath;
}

function writeSpecWithoutKeyFiles(repoDir: string, subsystemId: string, name: string): string {
  const specPath = path.join(repoDir, '.wavemill', 'context', `${subsystemId}.md`);
  writeFileSync(
    specPath,
    `# Subsystem: ${name}

## Purpose
Manual subsystem spec without tracked key files.
`
  );
  return specPath;
}

function runCheckDrift(repoDir: string) {
  const env = { ...process.env };
  delete env.npm_config_verify_deps_before_run;
  delete env.npm_config__jsr_registry;
  delete env.npm_config_prefix;

  return spawnSync(process.execPath, [toolPath, repoDir], {
    cwd: repoRoot,
    encoding: 'utf-8',
    env,
  });
}

describe('check-drift tool', () => {
  it('prints stale subsystem ids and exits 0 when drift is detected', () => {
    const repoDir = makeRepo();
    const keyFile = path.join(repoDir, 'shared', 'lib', 'linear.ts');
    writeFileSync(keyFile, 'export const value = 1;\n');

    const specPath = writeSpec(repoDir, 'linear-api', 'Linear API', 'shared/lib/linear.ts');
    const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const newTime = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    utimesSync(specPath, oldTime, oldTime);
    utimesSync(keyFile, newTime, newTime);

    const result = runCheckDrift(repoDir);

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout.trim(), 'linear-api');
    assert.strictEqual(result.stderr.trim(), '');
  });

  it('exits 1 with no output when subsystem docs are current', () => {
    const repoDir = makeRepo();
    const keyFile = path.join(repoDir, 'shared', 'lib', 'linear.ts');
    writeFileSync(keyFile, 'export const value = 1;\n');

    const specPath = writeSpec(repoDir, 'linear-api', 'Linear API', 'shared/lib/linear.ts');
    const recentTime = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    const olderTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    utimesSync(specPath, recentTime, recentTime);
    utimesSync(keyFile, olderTime, olderTime);

    const result = runCheckDrift(repoDir);

    assert.strictEqual(result.status, 1);
    assert.strictEqual(result.stdout.trim(), '');
  });

  it('exits 1 with no output when a spec has no tracked key files', () => {
    const repoDir = makeRepo();
    const specPath = writeSpecWithoutKeyFiles(repoDir, 'quota-tracking', 'Quota Tracking');
    const oldTime = new Date(Date.now() - 16 * 24 * 60 * 60 * 1000);
    utimesSync(specPath, oldTime, oldTime);

    const result = runCheckDrift(repoDir);

    assert.strictEqual(result.status, 1);
    assert.strictEqual(result.stdout.trim(), '');
    assert.strictEqual(result.stderr.trim(), '');
  });

  it('exits 1 with no output when no context directory exists', () => {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'check-drift-tool-empty-'));
    tempDirs.push(repoDir);

    const result = runCheckDrift(repoDir);

    assert.strictEqual(result.status, 1);
    assert.strictEqual(result.stdout.trim(), '');
  });
});
