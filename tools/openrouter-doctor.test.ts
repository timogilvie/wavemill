import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import {
  CERTIFICATION_SCHEMA_VERSION,
  DEFAULT_CERTIFICATION_SUITE_VERSION,
  buildGlobalCertificationPath,
  resolveCertificationStorageIdentity,
} from '../shared/lib/native-agent/certification/index.ts';

function makeRepoDir(): string {
  return mkdtempSync(join(tmpdir(), 'openrouter-doctor-tool-'));
}

function cleanup(repoDir: string): void {
  rmSync(repoDir, { recursive: true, force: true });
}

function writeConfig(repoDir: string): void {
  process.env.WAVEMILL_NATIVE_CERTIFICATION_ROOT = join(repoDir, 'global-certifications');
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
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
  }, null, 2));
}

function writeCert(repoDir: string): void {
  const path = buildGlobalCertificationPath('openrouter', 'z-ai/glm-5.2', DEFAULT_CERTIFICATION_SUITE_VERSION);
  mkdirSync(dirname(path), { recursive: true });
  const identity = resolveCertificationStorageIdentity('openrouter', 'z-ai/glm-5.2');
  writeFileSync(path, JSON.stringify({
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    provider: identity.provider,
    model: identity.model,
    phase: 'workflow',
    suiteVersion: DEFAULT_CERTIFICATION_SUITE_VERSION,
    certifiedAt: '2026-07-10T00:00:00.000Z',
    scenarios: [{ scenarioId: 's1', passed: true }],
  }));
}

function runTool(args: string[], repoDir: string, env: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, ['tools/openrouter-doctor.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    env: {
      ...process.env,
      TEST_OPENROUTER_KEY: '',
      OPENROUTER_DIRECT_AGENTS_ENABLED: '',
      ...env,
    },
    maxBuffer: 10 * 1024 * 1024,
  });
}

describe('openrouter-doctor tool', () => {
  it('emits a single JSON object', () => {
    const repoDir = makeRepoDir();
    try {
      writeConfig(repoDir);
      writeCert(repoDir);
      const result = runTool(['--json', '--repo-dir', repoDir], repoDir, { TEST_OPENROUTER_KEY: 'sk-test' });
      assert.ok(result.status === 0 || result.status === 1, result.stderr || result.stdout);
      assert.match(result.stdout, /"repoDir"/);
      assert.match(result.stdout, /"models"/);
    } finally {
      cleanup(repoDir);
    }
  });

  it('human output includes alias and native provider ID', () => {
    const repoDir = makeRepoDir();
    try {
      writeConfig(repoDir);
      writeCert(repoDir);
      const result = runTool(['--repo-dir', repoDir], repoDir, { TEST_OPENROUTER_KEY: 'sk-test' });
      assert.ok(result.status === 0 || result.status === 1, result.stderr || result.stdout);
      assert.match(result.stdout, /alias=glm-5\.2 raw=z-ai\/glm-5\.2/);
    } finally {
      cleanup(repoDir);
    }
  });

  it('exits 1 when globally projected OpenRouter models still have blockers', () => {
    const repoDir = makeRepoDir();
    try {
      writeConfig(repoDir);
      writeCert(repoDir);
      const result = runTool(['--repo-dir', repoDir], repoDir, { TEST_OPENROUTER_KEY: 'sk-test' });
      assert.equal(result.status, 1);
    } finally {
      cleanup(repoDir);
    }
  });

  it('exits 1 when a configured model is fully blocked', () => {
    const repoDir = makeRepoDir();
    try {
      writeConfig(repoDir);
      const result = runTool(['--repo-dir', repoDir], repoDir, { TEST_OPENROUTER_KEY: '' });
      assert.equal(result.status, 1);
    } finally {
      cleanup(repoDir);
    }
  });

  it('exits 2 on unreadable config', () => {
    const repoDir = makeRepoDir();
    try {
      writeFileSync(join(repoDir, '.wavemill-config.json'), '{');
      const result = runTool(['--repo-dir', repoDir], repoDir);
      assert.equal(result.status, 2);
    } finally {
      cleanup(repoDir);
    }
  });
});
