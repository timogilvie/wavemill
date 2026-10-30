import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { clearConfigCache } from '../shared/lib/config.ts';
import {
  PATCH_CODING_CERTIFICATION_SCHEMA_VERSION,
  getPatchCodingCertificationPath,
} from '../shared/lib/native-agent/coding-certification.ts';
import {
  GLOBAL_CERTIFICATION_ROOT_ENV,
  CERTIFICATION_SCHEMA_VERSION,
  DEFAULT_CERTIFICATION_SUITE_VERSION,
  buildGlobalCertificationPath,
  resolveCertificationSubject,
} from '../shared/lib/native-agent/certification/index.ts';
import { DEFAULT_MODEL_REGISTRY } from '../shared/lib/model-registry.ts';
import { buildLiveCodingCanaryFixture } from '../shared/lib/native-agent/certification/canary-fixtures.ts';
import { PATCH_CODING_SMOKE_SUITE_REVISION } from '../shared/lib/native-agent/smoke.ts';
import { checkNativeAgentLaunch } from './check-native-agent-launch.ts';

const repos: string[] = [];
const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function makeRepo(config: Record<string, unknown>): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'check-native-agent-launch-'));
  repos.push(repoDir);
  process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = join(repoDir, 'global-certifications');
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify(config, null, 2), 'utf-8');
  clearConfigCache(repoDir);
  return repoDir;
}

function writeOpenRouterCert(repoDir: string, provider: string, model: string, phase = 'workflow'): void {
  const providerNativeId = `${provider}/${model}`;
  const identity = resolveCertificationSubject({
    provider: 'openrouter',
    model: providerNativeId,
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
    certifiedAt: '2099-01-01T00:00:00.000Z',
    scenarios: [{ scenarioId: 's1', passed: true }],
    ...(phase !== 'read-only'
      ? {
        liveCanary: buildLiveCodingCanaryFixture(identity.subject, DEFAULT_CERTIFICATION_SUITE_VERSION, {
          ranAt: '2099-01-01T00:00:00.000Z',
        }),
      }
      : {}),
  }, null, 2), 'utf-8');
}

function writePatchCodingCertification(repoDir: string): void {
  const path = getPatchCodingCertificationPath(repoDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    schemaVersion: PATCH_CODING_CERTIFICATION_SCHEMA_VERSION,
    certified: true,
    smokeSuiteRevision: PATCH_CODING_SMOKE_SUITE_REVISION,
    certifiedAt: '2099-01-01T00:00:00.000Z',
    providers: [
      { provider: 'openai', model: 'gpt-4o', passed: true },
      { provider: 'openrouter', model: 'qwen/qwen3-coder', passed: true },
    ],
  }, null, 2), 'utf-8');
}

function runCliFailure(repoDir: string, args: string[]): Record<string, unknown> {
  try {
    execFileSync(process.execPath, [
      join(REPO_DIR, 'tools', 'check-native-agent-launch.ts'),
      '--repo-dir',
      repoDir,
      ...args,
    ], {
      cwd: REPO_DIR,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.fail('expected preflight CLI to fail');
  } catch (error) {
    const err = error as Error & { stdout?: Buffer | string };
    const stdout = Buffer.isBuffer(err.stdout) ? err.stdout.toString('utf-8') : String(err.stdout ?? '');
    return JSON.parse(stdout) as Record<string, unknown>;
  }
}

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providers: {
      openrouter: {
        enabled: true,
        apiKeyEnv: 'TEST_OPENROUTER_KEY',
      },
    },
    nativeAgent: {
      enabled: true,
      allowedPhases: ['planning', 'review'],
      providers: {
        openrouter: {
          enabled: true,
          apiKeyEnv: 'TEST_OPENROUTER_KEY',
        },
      },
    },
    ...overrides,
  };
}

afterEach(() => {
  delete process.env.TEST_OPENROUTER_KEY;
  delete process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
  for (const repoDir of repos.splice(0)) {
    clearConfigCache(repoDir);
    rmSync(repoDir, { recursive: true, force: true });
  }
});

describe('checkNativeAgentLaunch', () => {
  it('rejects direct native launches of OpenAI models before provider setup', () => {
    const repoDir = makeRepo(baseConfig());

    const result = checkNativeAgentLaunch({
      repoDir,
      phase: 'planning',
      agent: 'native-openai',
      model: 'gpt-5.6-sol',
    });

    assert.equal(result.ok, false);
    if (result.ok) assert.fail('expected hosted OpenAI model rejection');
    assert.equal(result.code, 'hosted-openai-model');
    assert.match(result.reason, /ChatGPT Codex harness/);
  });

  it('accepts equivalent native OpenRouter aliases and provider ids before launch', () => {
    const repoDir = makeRepo(baseConfig());
    writeOpenRouterCert(repoDir, 'z-ai', 'glm-5.2');
    process.env.TEST_OPENROUTER_KEY = 'sk-test';

    const result = checkNativeAgentLaunch({
      repoDir,
      phase: 'planning',
      agent: 'native-openrouter',
      model: 'glm-5.2',
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.command?.wavemillAlias : undefined, 'glm-5.2');
    assert.equal(result.ok ? result.command?.openrouterId : undefined, 'z-ai/glm-5.2');
    assert.equal(result.ok ? result.command?.apiBaseUrl : undefined, 'https://openrouter.ai/api/v1');
  });

  it('accepts qwen-3-coder planning only with a workflow certification artifact', () => {
    const repoDir = makeRepo(baseConfig());
    writeOpenRouterCert(repoDir, 'qwen', 'qwen3-coder', 'workflow');
    process.env.TEST_OPENROUTER_KEY = 'sk-test';

    for (const model of ['qwen-3-coder', 'qwen/qwen3-coder']) {
      const result = checkNativeAgentLaunch({
        repoDir,
        phase: 'planning',
        agent: 'native-openrouter',
        model,
      });

      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.ok ? result.launcher : undefined, 'native-planning');
      assert.equal(result.ok ? result.command?.wavemillAlias : undefined, 'qwen-3-coder');
      assert.equal(result.ok ? result.command?.openrouterId : undefined, 'qwen/qwen3-coder');
    }
  });

  it('rejects qwen-3-coder planning for missing or phase-insufficient artifacts', () => {
    const missingRepo = makeRepo(baseConfig());
    process.env.TEST_OPENROUTER_KEY = 'sk-test';
    const missing = checkNativeAgentLaunch({
      repoDir: missingRepo,
      phase: 'planning',
      agent: 'native-openrouter',
      model: 'qwen-3-coder',
    });
    assert.equal(missing.ok, false);
    assert.match(missing.ok ? '' : missing.reason, /missing_artifact/);

    const patchOnlyRepo = makeRepo(baseConfig());
    writeOpenRouterCert(patchOnlyRepo, 'qwen', 'qwen3-coder', 'patch');
    const patchOnly = checkNativeAgentLaunch({
      repoDir: patchOnlyRepo,
      phase: 'planning',
      agent: 'native-openrouter',
      model: 'qwen-3-coder',
    });
    assert.equal(patchOnly.ok, false);
    assert.match(patchOnly.ok ? '' : patchOnly.reason, /insufficient_phase/);
  });

  // Removed: 'rejects provider-stage mismatches ...'. Repo-local
  // providers.openrouter.stages no longer exists, so checkNativeAgentLaunch has
  // no provider-stage-mismatch path. Stage eligibility is now decided by the
  // global effective-model projection and covered by its own tests.

  it('rejects unknown native OpenRouter aliases before launch', () => {
    const repoDir = makeRepo(baseConfig());
    process.env.TEST_OPENROUTER_KEY = 'sk-test';

    const result = checkNativeAgentLaunch({
      repoDir,
      phase: 'planning',
      agent: 'native-openrouter',
      model: 'not-a-native-model',
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.code, 'unknown-openrouter-model');
    assert.equal(result.ok ? undefined : result.surface, 'launch.model');
    assert.match(result.ok ? '' : result.reason, /Unknown native OpenRouter model/);
  });

  it('rejects unsupported native stages before provider validation', () => {
    const repoDir = makeRepo(baseConfig());
    process.env.TEST_OPENROUTER_KEY = 'sk-test';

    const result = checkNativeAgentLaunch({
      repoDir,
      phase: 'deploy',
      agent: 'native-openrouter',
      model: 'glm-5.2',
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.code, 'unsupported-native-stage');
    assert.match(result.ok ? '' : result.reason, /unsupported native launch phase 'deploy'/);
  });

  it('rejects missing native provider env before launch', () => {
    const repoDir = makeRepo(baseConfig());
    writeOpenRouterCert(repoDir, 'z-ai', 'glm-5.2');

    const result = checkNativeAgentLaunch({
      repoDir,
      phase: 'planning',
      agent: 'native-openrouter',
      model: 'glm-5.2',
    });

    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /TEST_OPENROUTER_KEY is not set/);
  });

  it('rejects empty native commands and models before launch', () => {
    const repoDir = makeRepo(baseConfig());
    process.env.TEST_OPENROUTER_KEY = 'sk-test';

    const emptyAgent = checkNativeAgentLaunch({
      repoDir,
      phase: 'planning',
      agent: '',
      model: 'glm-5.2',
    });
    assert.equal(emptyAgent.ok, false);
    assert.equal(emptyAgent.ok ? undefined : emptyAgent.code, 'unsupported-native-agent');

    const emptyModel = checkNativeAgentLaunch({
      repoDir,
      phase: 'planning',
      agent: 'native-openrouter',
      model: '   ',
    });
    assert.equal(emptyModel.ok, false);
    assert.equal(emptyModel.ok ? undefined : emptyModel.code, 'missing-model');
  });

  it('preserves structured validation codes through the CLI entrypoint', () => {
    const repoDir = makeRepo(baseConfig());

    const unsupportedStage = runCliFailure(repoDir, [
      '--agent',
      'native-openrouter',
      '--phase',
      'deploy',
      '--model',
      'glm-5.2',
    ]);
    assert.equal(unsupportedStage.ok, false);
    assert.equal(unsupportedStage.code, 'unsupported-native-stage');

    const missingModel = runCliFailure(repoDir, [
      '--agent',
      'native-openrouter',
      '--phase',
      'planning',
      '--model',
      '   ',
    ]);
    assert.equal(missingModel.ok, false);
    assert.equal(missingModel.code, 'missing-model');
  });

  it('allows native OpenRouter coding when patch coding and certification are configured', () => {
    const repoDir = makeRepo(baseConfig({
      providers: {
        openrouter: {
          enabled: true,
          apiKeyEnv: 'TEST_OPENROUTER_KEY',
        },
      },
      nativeAgent: {
        enabled: true,
        allowedPhases: ['coding'],
        patchCoding: {
          enabled: true,
        },
        providers: {
          openrouter: {
            enabled: true,
            apiKeyEnv: 'TEST_OPENROUTER_KEY',
          },
        },
      },
    }));
    // No repo-local launcher: it is resolved from the wavemill installation.
    writeOpenRouterCert(repoDir, 'qwen', 'qwen3-coder', 'patch');
    writePatchCodingCertification(repoDir);
    process.env.TEST_OPENROUTER_KEY = 'sk-test';

    const result = checkNativeAgentLaunch({
      repoDir,
      phase: 'coding',
      agent: 'native-openrouter',
      model: 'qwen/qwen3-coder',
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.ok ? result.launcher : undefined, 'native-coding');
    assert.equal(result.ok ? result.command?.wavemillAlias : undefined, 'qwen-3-coder');
    assert.equal(result.ok ? result.command?.openrouterId : undefined, 'qwen/qwen3-coder');
  });
});
