import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { buildParityFixture } from '../shared/lib/cross-repo-parity.ts';
import { GLOBAL_CERTIFICATION_ROOT_ENV } from '../shared/lib/native-agent/certification/storage.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tool = resolve(__dirname, 'parity-report.ts');

function cleanConfig(repoDir: string): void {
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
    challenge: { enabled: true, rate: 1 },
    router: { defaultAgent: 'claude' },
    nativeAgent: { patchCoding: { enabled: true }, allowedPhases: ['planning', 'review'] },
    providers: { openrouter: { enabled: true, apiKeyEnv: 'TEST_PARITY_OPENROUTER_KEY' } },
  }, null, 2), 'utf-8');
}

function runTool(repoDir: string, globalRoot: string, args: string[] = []) {
  return execFileSync(process.execPath, [tool, '--json', '--repo-dir', repoDir, ...args], {
    cwd: resolve(__dirname, '..'),
    encoding: 'utf-8',
    env: { ...process.env, [GLOBAL_CERTIFICATION_ROOT_ENV]: globalRoot },
  });
}

describe('parity-report CLI', () => {
  it('emits JSON and exits 0 for a clean repo with a global challenge pair', () => {
    const fixture = buildParityFixture({ globalArtifacts: 'valid', writeForbiddenConfig: true });
    try {
      const repoDir = fixture.consumers[0].repoDir;
      cleanConfig(repoDir);
      const report = JSON.parse(runTool(repoDir, fixture.global.root, ['--strict-challenge'])) as Record<string, unknown>;
      assert.equal(report.globalCatalogVersion, 'v3');
      assert.deepEqual(report.forbiddenLocalConfig, []);
      assert.equal((report.challengePairAvailability as Record<string, unknown>).coding, true);
    } finally {
      fixture.cleanup();
    }
  });

  it('exits 2 when forbidden local model configuration remains', () => {
    const fixture = buildParityFixture({ globalArtifacts: 'valid', writeForbiddenConfig: true });
    try {
      assert.throws(
        () => runTool(fixture.consumers[0].repoDir, fixture.global.root),
        (error: unknown) => typeof error === 'object'
          && error !== null
          && 'status' in error
          && (error as { status?: number }).status === 2,
      );
    } finally {
      fixture.cleanup();
    }
  });

  it('exits 3 under --strict-challenge when no pair is globally ready', () => {
    const fixture = buildParityFixture({ globalArtifacts: 'partial' });
    try {
      const repoDir = fixture.consumers[0].repoDir;
      cleanConfig(repoDir);
      assert.throws(
        () => runTool(repoDir, fixture.global.root, ['--strict-challenge']),
        (error: unknown) => typeof error === 'object'
          && error !== null
          && 'status' in error
          && (error as { status?: number }).status === 3,
      );
    } finally {
      fixture.cleanup();
    }
  });
});
