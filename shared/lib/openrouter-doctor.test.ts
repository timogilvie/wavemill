import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { clearConfigCache } from './config.ts';
import { diagnoseOpenRouter } from './openrouter-doctor.ts';
import {
  CERTIFICATION_SCHEMA_VERSION,
  DEFAULT_CERTIFICATION_SUITE_VERSION,
  buildGlobalCertificationPath,
  resolveCertificationSubject,
} from './native-agent/certification/index.ts';
import { DEFAULT_MODEL_REGISTRY } from './model-registry.ts';
import { buildLiveCodingCanaryFixture } from './native-agent/certification/canary-fixtures.ts';

function makeRepoDir(): string {
  return mkdtempSync(join(tmpdir(), 'openrouter-doctor-'));
}

function cleanup(repoDir: string): void {
  clearConfigCache();
  rmSync(repoDir, { recursive: true, force: true });
}

function baseConfig() {
  return {
    providers: {
      openrouter: {
        enabled: true,
        apiKeyEnv: 'TEST_OPENROUTER_KEY',
      },
    },
    nativeAgent: {
      providers: {
        openrouter: {
          enabled: true,
          apiKeyEnv: 'TEST_OPENROUTER_KEY',
        },
      },
    },
    router: {
      defaultAgent: 'claude',
    },
    challenge: {
      enabled: true,
    },
  };
}

function deepMerge<T extends Record<string, any>>(base: T, overrides: Record<string, any>): T {
  const output: Record<string, any> = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && output[key]
      && typeof output[key] === 'object'
      && !Array.isArray(output[key])
    ) {
      output[key] = deepMerge(output[key], value);
    } else {
      output[key] = value;
    }
  }
  return output as T;
}

function writeConfig(repoDir: string, overrides: Record<string, unknown> = {}): void {
  process.env.WAVEMILL_NATIVE_CERTIFICATION_ROOT = join(repoDir, 'global-certifications');
  const config = deepMerge(baseConfig(), overrides as Record<string, any>);
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify(config, null, 2));
  clearConfigCache();
}

function writeOpenRouterCert(
  repoDir: string,
  modelId: string,
  phase: 'read-only' | 'patch' | 'workflow' = 'workflow',
): string {
  const identity = resolveCertificationSubject({
    provider: 'openrouter',
    model: modelId,
    registry: DEFAULT_MODEL_REGISTRY,
  });
  const path = buildGlobalCertificationPath(
    identity.storageIdentity.provider,
    identity.storageIdentity.model,
    DEFAULT_CERTIFICATION_SUITE_VERSION,
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    subject: identity.subject,
    provider: identity.storageIdentity.provider,
    model: identity.storageIdentity.model,
    phase,
    suiteVersion: DEFAULT_CERTIFICATION_SUITE_VERSION,
    certifiedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    scenarios: [{ scenarioId: 's1', passed: true }],
    ...(phase !== 'read-only'
      ? {
        liveCanary: buildLiveCodingCanaryFixture(identity.subject, DEFAULT_CERTIFICATION_SUITE_VERSION, {
          ranAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        }),
      }
      : {}),
  }));
  return path;
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(env)) {
    previous.set(key, process.env[key]);
    const value = env[key];
    if (typeof value === 'undefined') {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (typeof value === 'undefined') {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe('openrouter-doctor', () => {
  it('reports missing API keys without leaking the key value', () => {
    const repoDir = makeRepoDir();
    try {
      writeConfig(repoDir);
      const report = withEnv({ TEST_OPENROUTER_KEY: undefined }, () => diagnoseOpenRouter({ repoDir }));
      const glm = report.models.find((model) => model.id === 'glm-5.3');
      assert.ok(glm);
      for (const cell of glm.cells) {
        assert.equal(cell.primaryReason?.reason, 'MISSING_API_KEY');
        const certificationReason = cell.secondaryReasons.find((reason) => reason.reason === 'CERTIFICATION_REJECTED');
        assert.ok(certificationReason);
        assert.match(certificationReason.detail, /reason=missing-api-key/);
        assert.match(certificationReason.detail, /apiKeyEnv=TEST_OPENROUTER_KEY/);
        assert.equal(certificationReason.configSurface, 'nativeAgent.providers.openrouter.apiKeyEnv');
      }
      assert.doesNotMatch(JSON.stringify(report), /sk-test|test-openrouter-key/i);
    } finally {
      cleanup(repoDir);
    }
  });

  it('surfaces direct-agent-disabled as a secondary reason', () => {
    const repoDir = makeRepoDir();
    try {
      writeConfig(repoDir);
      writeOpenRouterCert(repoDir, 'z-ai/glm-5.3');
      const report = withEnv({
        TEST_OPENROUTER_KEY: 'sk-test',
        OPENROUTER_DIRECT_AGENTS_ENABLED: undefined,
      }, () => diagnoseOpenRouter({ repoDir }));
      const glm = report.models.find((model) => model.id === 'glm-5.3');
      assert.ok(glm);
      assert.equal(glm.cells.every((cell) => cell.eligible), true);
      assert.equal(
        glm.cells.some((cell) => cell.secondaryReasons.some((reason) => reason.reason === 'DIRECT_AGENTS_DISABLED')),
        true,
      );
    } finally {
      cleanup(repoDir);
    }
  });

  it('uses the global registry stage pools', () => {
    const repoDir = makeRepoDir();
    try {
      writeConfig(repoDir);
      writeOpenRouterCert(repoDir, 'z-ai/glm-5.3');
      const report = withEnv({ TEST_OPENROUTER_KEY: 'sk-test' }, () => diagnoseOpenRouter({ repoDir }));
      const glm = report.models.find((model) => model.id === 'glm-5.3');
      assert.ok(glm);
      assert.equal(glm.cells.every((cell) => cell.eligible), true);
    } finally {
      cleanup(repoDir);
    }
  });

  it('distinguishes raw provider IDs from aliases', () => {
    const repoDir = makeRepoDir();
    try {
      writeConfig(repoDir);
      const report = withEnv({ TEST_OPENROUTER_KEY: 'sk-test' }, () => diagnoseOpenRouter({ repoDir }));
      const glm = report.models.find((model) => model.nativeProviderId === 'z-ai/glm-5.3');
      assert.ok(glm);
      assert.equal(glm.alias, 'glm-5.3');
      assert.equal(glm.registryModelId, 'glm-5.3');
    } finally {
      cleanup(repoDir);
    }
  });

  it('reports native certification rejection', () => {
    const repoDir = makeRepoDir();
    try {
      writeConfig(repoDir);
      const report = withEnv({ TEST_OPENROUTER_KEY: 'sk-test' }, () => diagnoseOpenRouter({ repoDir }));
      const glm = report.models.find((model) => model.id === 'glm-5.3');
      assert.ok(glm);
      assert.equal(glm.cells.every((cell) => cell.primaryReason?.reason === 'CERTIFICATION_REJECTED'), true);
      for (const cell of glm.cells) {
        assert.match(cell.primaryReason?.detail ?? '', /reason=missing-artifact/);
        assert.match(cell.primaryReason?.detail ?? '', /artifactPath=.*global-certifications/);
      }
    } finally {
      cleanup(repoDir);
    }
  });

  it('does not derive agent fallback from repo-local maps', () => {
    const repoDir = makeRepoDir();
    try {
      writeConfig(repoDir);
      writeOpenRouterCert(repoDir, 'z-ai/glm-5.3');
      const report = withEnv({ TEST_OPENROUTER_KEY: 'sk-test' }, () => diagnoseOpenRouter({ repoDir }));
      assert.equal(
        report.models.some((model) =>
          model.cells.some((cell) => cell.primaryReason?.reason === 'AGENT_FALLBACK_TO_CODEX')
        ),
        false,
      );
    } finally {
      cleanup(repoDir);
    }
  });

  it('links aliases, raw IDs, and certification storage paths', () => {
    const repoDir = makeRepoDir();
    try {
      writeConfig(repoDir);
      const storagePath = writeOpenRouterCert(repoDir, 'z-ai/glm-5.3');
      const report = withEnv({ TEST_OPENROUTER_KEY: 'sk-test' }, () => diagnoseOpenRouter({ repoDir }));
      const glm = report.models.find((model) => model.id === 'glm-5.3');
      assert.ok(glm);
      assert.equal(glm.alias, 'glm-5.3');
      assert.equal(glm.nativeProviderId, 'z-ai/glm-5.3');
      assert.equal(glm.storagePath, storagePath);
    } finally {
      cleanup(repoDir);
    }
  });

  it('reports the current repo shape when OPENROUTER_API_KEY is missing', () => {
    const repoDir = makeRepoDir();
    try {
      writeFileSync(
        join(repoDir, '.wavemill-config.json'),
        readFileSync(join(process.cwd(), '.wavemill-config.json'), 'utf-8'),
      );
      clearConfigCache();
      const report = withEnv({ OPENROUTER_API_KEY: undefined }, () => diagnoseOpenRouter({ repoDir }));
      assert.ok(report.models.length > 0);
      assert.equal(
        report.models.some((model) => model.cells.some((cell) => cell.primaryReason?.reason === 'MISSING_API_KEY')),
        true,
      );
    } finally {
      cleanup(repoDir);
    }
  });

  it('captures zero-traffic cells for eligible models', () => {
    const repoDir = makeRepoDir();
    try {
      writeConfig(repoDir);
      writeOpenRouterCert(repoDir, 'z-ai/glm-5.3');
      const evalsDir = join(repoDir, '.wavemill', 'evals');
      mkdirSync(evalsDir, { recursive: true });
      writeFileSync(join(evalsDir, 'evals.jsonl'), `${JSON.stringify({
        id: 'eval-1',
        schemaVersion: '1.0.0',
        timestamp: '2026-07-11T00:00:00.000Z',
        modelId: 'claude-sonnet-5',
        score: 0.9,
        scoreBand: 'good',
        timeSeconds: 1,
        interventionRequired: false,
        interventionCount: 0,
        interventionDetails: [],
        originalPrompt: 'Implement feature',
        rationale: 'ok',
        routing: {
          planner: { role: 'planner', requestedSelector: 'auto', resolvedModelId: 'claude-sonnet-5', sourceLayer: 'test' },
          coder: { role: 'coder', requestedSelector: 'auto', resolvedModelId: 'claude-sonnet-5', sourceLayer: 'test' },
          reviewer: { role: 'reviewer', requestedSelector: 'auto', resolvedModelId: 'claude-sonnet-5', sourceLayer: 'test' },
        },
      })}\n`);
      const report = withEnv({ TEST_OPENROUTER_KEY: 'sk-test' }, () => diagnoseOpenRouter({ repoDir, lookback: 5 }));
      assert.ok(report.zeroTrafficCells.some((cell) => cell.modelId === 'glm-5.3' && cell.stage === 'coder'));
    } finally {
      cleanup(repoDir);
    }
  });
});
