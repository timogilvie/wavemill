import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildGlobalCertificationPath } from './native-agent/certification/loader.ts';
import { resolveCertificationSubject } from './native-agent/certification/identity.ts';
import { buildLiveCodingCanaryFixture } from './native-agent/certification/canary-fixtures.ts';
import {
  CERTIFICATION_BASE_PATH,
  CERTIFICATION_SCHEMA_VERSION,
  type CertificationPhase,
} from './native-agent/certification/schema.ts';
import {
  PATCH_CODING_CERTIFICATION_SCHEMA_VERSION,
  getPatchCodingCertificationPath,
} from './native-agent/coding-certification.ts';
import { PATCH_CODING_SMOKE_SUITE_REVISION } from './native-agent/smoke.ts';
import { DEFAULT_MODEL_REGISTRY } from './model-registry.ts';

export type ConsumerRepoName = 'wavemill' | 'gtm-backend' | 'gtm-frontend';
export type ParityArtifactMode = 'valid' | 'missing' | 'wrong-suite' | 'stale' | 'partial';

export interface ConsumerRepoFixture {
  name: ConsumerRepoName;
  repoDir: string;
  legacyConfig: Record<string, unknown>;
  emptyLocalCertDir: string;
}

export interface SharedGlobalRoot {
  root: string;
  artifacts: Array<{ provider: string; model: string; phase: CertificationPhase; suiteVersion: string; path: string }>;
}

export interface ParityFixture {
  global: SharedGlobalRoot;
  consumers: ConsumerRepoFixture[];
  cleanup: () => void;
}

const CERTIFIED_MODELS = [
  { provider: 'openrouter', model: 'qwen-3-coder', phase: 'patch' as const },
  { provider: 'openrouter', model: 'glm-5.2', phase: 'workflow' as const },
  { provider: 'openrouter', model: 'kimi-k2.7-code', phase: 'workflow' as const },
];

// Valid fixtures must stay fresh relative to the wall clock used by launch
// eligibility. A fixed certification date makes the suite expire every time
// the production freshness window advances.
const CERTIFIED_AT = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const STALE_CERTIFIED_AT = '2024-01-01T00:00:00.000Z';

function writeGlobalArtifact(
  root: string,
  provider: string,
  model: string,
  phase: CertificationPhase,
  opts: { suiteVersion?: string; certifiedAt?: string; scenarioPassed?: boolean } = {},
): string {
  const suiteVersion = opts.suiteVersion ?? 'v3';
  const identity = resolveCertificationSubject({
    provider,
    model,
    registry: DEFAULT_MODEL_REGISTRY,
  });
  const path = buildGlobalCertificationPath(
    identity.storageIdentity.provider,
    identity.storageIdentity.model,
    suiteVersion,
    { root },
  );
  mkdirSync(dirname(path), { recursive: true });
  const certifiedAt = opts.certifiedAt ?? CERTIFIED_AT;
  writeFileSync(path, JSON.stringify({
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    subject: identity.subject,
    provider: identity.storageIdentity.provider,
    model: identity.storageIdentity.model,
    phase,
    suiteVersion,
    certifiedAt,
    scenarios: [{ scenarioId: 'global-parity-smoke', passed: opts.scenarioPassed ?? true }],
    // HOK-2943: coder-stage parity requires live canary evidence alongside the
    // deterministic artifact. The canary uses a wall-clock-recent ranAt because
    // the challenge snapshot evaluates with real time while router/availability
    // snapshots pin `now`; freshness only bounds the upper edge, so a recent
    // ranAt satisfies both. Degraded modes still reject on their deterministic
    // reason, which the gate checks before the canary.
    ...(phase !== 'read-only'
      ? {
        liveCanary: buildLiveCodingCanaryFixture(identity.subject, suiteVersion, {
          ranAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        }),
      }
      : {}),
  }, null, 2), 'utf-8');
  return path;
}

function writePatchCodingCertification(repoDir: string): void {
  const path = getPatchCodingCertificationPath(repoDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    schemaVersion: PATCH_CODING_CERTIFICATION_SCHEMA_VERSION,
    certified: true,
    smokeSuiteRevision: PATCH_CODING_SMOKE_SUITE_REVISION,
    certifiedAt: CERTIFIED_AT,
    providers: [
      { provider: 'openrouter', model: 'qwen/qwen3-coder', passed: true },
      { provider: 'openrouter', model: 'z-ai/glm-5.2', passed: true },
      { provider: 'openrouter', model: 'moonshotai/kimi-k2.7-code', passed: true },
    ],
  }, null, 2), 'utf-8');
}

function legacyConfigFor(name: ConsumerRepoName): Record<string, unknown> {
  const base = {
    challenge: { enabled: true, rate: 1, recommendationRate: 1 },
    router: { defaultAgent: 'claude' },
    nativeAgent: { patchCoding: { enabled: true }, allowedPhases: ['planning', 'review'] },
    providers: { openrouter: { enabled: true, apiKeyEnv: 'TEST_PARITY_OPENROUTER_KEY' } },
  };
  if (name === 'wavemill') {
    return {
      ...base,
      router: {
        defaultAgent: 'claude',
        models: ['claude-sonnet-5', 'glm-5.2'],
        agentMap: { 'glm-5.2': 'claude' },
      },
      providers: { openrouter: { enabled: true, apiKeyEnv: 'TEST_PARITY_OPENROUTER_KEY', models: ['glm-5.2'] } },
    };
  }
  if (name === 'gtm-backend') {
    return {
      ...base,
      challenge: { enabled: true, rate: 1, recommendationRate: 1, models: ['claude-sonnet-5'] },
      maxParallelism: 3,
    };
  }
  return {
    ...base,
    nativeAgent: {
      patchCoding: { enabled: true },
      allowedPhases: ['planning', 'review'],
      providers: { openrouter: { models: [] } },
    },
    maxParallelism: 1,
  };
}

function makeConsumer(root: string, name: ConsumerRepoName): ConsumerRepoFixture {
  const repoDir = join(root, name);
  const emptyLocalCertDir = join(repoDir, CERTIFICATION_BASE_PATH);
  const legacyConfig = legacyConfigFor(name);
  mkdirSync(emptyLocalCertDir, { recursive: true });
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify(legacyConfig, null, 2), 'utf-8');
  writeFileSync(join(repoDir, '.env'), 'TEST_PARITY_OPENROUTER_KEY=test-key\n', 'utf-8');
  // Deliberately no tools/launch-native-coding.ts: consumer repos never carry
  // one. The launcher is resolved from the wavemill installation. Stubbing a
  // copy here previously made repo-relative launcher paths look valid in tests
  // while failing in every real consumer repo.
  writePatchCodingCertification(repoDir);
  return { name, repoDir, legacyConfig, emptyLocalCertDir };
}

function cleanConfigFor(name: ConsumerRepoName): Record<string, unknown> {
  return {
    challenge: { enabled: true, rate: 1, recommendationRate: 1 },
    router: { defaultAgent: 'claude' },
    nativeAgent: { patchCoding: { enabled: true }, allowedPhases: ['planning', 'review'] },
    providers: { openrouter: { enabled: true, apiKeyEnv: 'TEST_PARITY_OPENROUTER_KEY' } },
  };
}

export function buildParityFixture(opts: {
  globalArtifacts: ParityArtifactMode;
  writeForbiddenConfig?: boolean;
}): ParityFixture {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'global-model-parity-'));
  const globalRoot = join(fixtureRoot, 'global-certifications');
  mkdirSync(globalRoot, { recursive: true });
  const artifacts: SharedGlobalRoot['artifacts'] = [];

  if (opts.globalArtifacts !== 'missing') {
    const models = opts.globalArtifacts === 'partial'
      ? CERTIFIED_MODELS.slice(0, 1)
      : CERTIFIED_MODELS;
    for (const entry of models) {
      const path = writeGlobalArtifact(globalRoot, entry.provider, entry.model, entry.phase, {
        suiteVersion: opts.globalArtifacts === 'wrong-suite' ? 'v1' : 'v3',
        certifiedAt: opts.globalArtifacts === 'stale' ? STALE_CERTIFIED_AT : CERTIFIED_AT,
      });
      artifacts.push({ ...entry, suiteVersion: opts.globalArtifacts === 'wrong-suite' ? 'v1' : 'v3', path });
    }
  }

  const consumers = (['wavemill', 'gtm-backend', 'gtm-frontend'] as const)
    .map((name) => {
      const consumer = makeConsumer(fixtureRoot, name);
      if (opts.writeForbiddenConfig !== true) {
        writeFileSync(
          join(consumer.repoDir, '.wavemill-config.json'),
          JSON.stringify(cleanConfigFor(name), null, 2),
          'utf-8',
        );
      }
      return consumer;
    });

  return {
    global: { root: globalRoot, artifacts },
    consumers,
    cleanup: () => rmSync(fixtureRoot, { recursive: true, force: true }),
  };
}
