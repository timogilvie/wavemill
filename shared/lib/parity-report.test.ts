import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { buildParityFixture } from './cross-repo-parity.ts';
import { buildGlobalModelParityReport } from './parity-report.ts';
import { GLOBAL_CERTIFICATION_ROOT_ENV } from './native-agent/certification/storage.ts';

function withGlobalRoot<T>(root: string, fn: () => T): T {
  const previousRoot = process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
  process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = root;
  try {
    return fn();
  } finally {
    if (previousRoot === undefined) {
      delete process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
    } else {
      process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = previousRoot;
    }
  }
}

function writeCleanConfig(repoDir: string): void {
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
    challenge: { enabled: true, rate: 1 },
    router: { defaultAgent: 'claude' },
    nativeAgent: { patchCoding: { enabled: true }, allowedPhases: ['planning', 'review'] },
    providers: { openrouter: { enabled: true, apiKeyEnv: 'TEST_PARITY_OPENROUTER_KEY' } },
  }, null, 2), 'utf-8');
}

describe('buildGlobalModelParityReport', () => {
  it('reports certified counts, runtime readiness, challenge pairs, and forbidden config', () => {
    const fixture = buildParityFixture({ globalArtifacts: 'valid', writeForbiddenConfig: true });
    try {
      writeCleanConfig(fixture.consumers[0].repoDir);
      const report = withGlobalRoot(fixture.global.root, () => buildGlobalModelParityReport({
        repoDir: fixture.consumers[0].repoDir,
        now: new Date(),
      }));

      assert.equal(report.globalCatalogVersion, 'v3');
      assert.equal(report.requiredSuiteVersion, 'v3');
      assert.ok(report.publishedArtifactCountForRequiredSuite >= 3);
      assert.equal(report.certificationSuiteCoverageStatus, 'ok');
      assert.ok(report.certifiedModelCountByStage.coding >= 3);
      assert.ok(report.runtimeReadyCountByStage.coding >= 3);
      assert.equal(report.challengePairAvailability.coding, true);
      assert.ok(report.runtimeReadyByProvider.some((provider) =>
        provider.provider === 'openrouter' && provider.ready >= 3 && provider.apiKeySet,
      ));
      assert.deepEqual(report.forbiddenLocalConfig, []);
      assert.ok(report.forbiddenPathCatalog.includes('challenge.models'));
    } finally {
      fixture.cleanup();
    }
  });

  it('marks challenge pair unavailable when the global root has only one usable artifact', () => {
    const fixture = buildParityFixture({ globalArtifacts: 'partial' });
    try {
      writeCleanConfig(fixture.consumers[0].repoDir);
      const report = withGlobalRoot(fixture.global.root, () => buildGlobalModelParityReport({
        repoDir: fixture.consumers[0].repoDir,
        now: new Date(),
      }));

      assert.equal(report.challengePairAvailability.coding, false);
      assert.equal(report.runtimeReadyCountByStage.coding, 1);
    } finally {
      fixture.cleanup();
    }
  });

  it('reports forbidden config instead of throwing before output', () => {
    const fixture = buildParityFixture({ globalArtifacts: 'valid', writeForbiddenConfig: true });
    try {
      const report = withGlobalRoot(fixture.global.root, () => buildGlobalModelParityReport({
        repoDir: fixture.consumers[0].repoDir,
        now: new Date(),
      }));
      assert.ok(report.forbiddenLocalConfig.some((entry) => entry.path === 'router.models'));
    } finally {
      fixture.cleanup();
    }
  });
});
