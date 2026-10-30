import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

describe('promote-provisional-model CLI', () => {
  it('prints help with the dry-run, activation, and rollback operator contract', () => {
    const result = spawnSync(process.execPath, ['tools/promote-provisional-model.ts', '--help'], {
      encoding: 'utf-8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Dry run is the default/);
    assert.match(result.stdout, /--activate/);
    assert.match(result.stdout, /post-certification half/);
    assert.match(result.stdout, /Rollback validates/);
  });

  it('refuses combined modes: --activate with --apply or --rollback', () => {
    for (const extra of ['--apply', '--rollback']) {
      const result = spawnSync(process.execPath, ['tools/promote-provisional-model.ts', '--spec', 'spec.json', '--activate', extra], {
        encoding: 'utf-8',
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /mutually exclusive/);
    }
  });

  it('dry-run invocation writes no files and emits JSON manifest', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'model-promotion-cli-'));
    const repoDir = join(baseDir, 'repo');
    try {
      mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
      const evalPath = join(repoDir, '.wavemill', 'evals', 'evals.jsonl');
      writeFileSync(evalPath, '{"id":"eval-1","schemaVersion":"1","modelId":"old-model","score":1}\n');
      const specPath = join(baseDir, 'spec.json');
      writeFileSync(specPath, JSON.stringify({
        schemaVersion: '1',
        promotionId: 'cli-test',
        provisional: {
          alias: 'old-model',
          identityRevision: 1,
        },
        final: {
          alias: 'new-model',
          provider: 'openrouter',
          providerNativeId: 'provider/new-model',
          identityRevision: 2,
          displayName: 'New Model',
          family: 'gpt',
          pricing: {
            inputCostPerMTok: 1,
            outputCostPerMTok: 2,
            cacheWriteCostPerMTok: 1.25,
            cacheReadCostPerMTok: 0.1,
          },
          verification: {
            source: 'fixture',
            observedAt: '2026-08-24T00:00:00.000Z',
            catalogHash: 'hash',
          },
        },
        disclosure: {
          disclosedAt: '2026-08-24T00:00:00.000Z',
          source: 'fixture',
        },
      }));
      const before = readFileSync(evalPath, 'utf-8');
      const result = spawnSync(process.execPath, ['tools/promote-provisional-model.ts', '--spec', specPath, '--repo-dir', repoDir], {
        encoding: 'utf-8',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(evalPath, 'utf-8'), before);
      const manifest = JSON.parse(result.stdout);
      assert.equal(manifest.status, 'planned');
      assert.equal(manifest.conservation.oldReferencesBefore, 1);

      // Activation of a never-promoted model refuses without touching anything.
      const activation = spawnSync(process.execPath, ['tools/promote-provisional-model.ts', '--spec', specPath, '--repo-dir', repoDir, '--activate'], {
        encoding: 'utf-8',
      });
      assert.notEqual(activation.status, 0);
      assert.match(activation.stderr, /No model registry catalog found/);
      assert.equal(readFileSync(evalPath, 'utf-8'), before);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
