import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { resolveEffectiveTaskConfig, runtimeEnvSnapshotForTask } from './effective-task-config.ts';

function tempRepo(): string {
  const dir = join(tmpdir(), `wavemill-effective-config-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(join(dir, '.wavemill', 'runtime-env'), { recursive: true });
  return dir;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeRepoConfig(repoDir: string, mill: Record<string, unknown> = {}): void {
  writeJson(join(repoDir, '.wavemill-config.json'), {
    configVersion: '1.5.0',
    mill,
    integration: {
      mergeMethod: 'merge',
    },
  });
}

function writeState(repoDir: string, task: Record<string, unknown>): string {
  const path = join(repoDir, '.wavemill', 'workflow-state.json');
  writeJson(path, { tasks: { 'HOK-2956': task } });
  return path;
}

function isolateHome(repoDir: string): string | undefined {
  const prior = process.env.HOME;
  const home = join(repoDir, 'home');
  mkdirSync(join(home, '.wavemill'), { recursive: true });
  process.env.HOME = home;
  return prior;
}

function restoreHome(prior: string | undefined): void {
  if (prior === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = prior;
  }
}

test('launch contract wins over runtime and repo config with drift recorded', () => {
  const repoDir = tempRepo();
  const priorHome = isolateHome(repoDir);
  try {
    writeRepoConfig(repoDir, { baseBranch: 'main', requireConfirm: false });
    const stateFile = writeState(repoDir, {
      lifecycle: {
        schemaVersion: 1,
        workflowOutcome: 'active',
        resourceDisposition: 'allocated',
        launchContract: {
          baseBranch: 'auto/integration',
          requireConfirm: true,
          mergeMethod: 'squash',
          remoteBranchDeletionPolicy: { allowed: true, mode: 'merged-pr-task-branch' },
          provenance: {
            baseBranch: 'cli',
            requireConfirm: 'runtime-env',
            mergeMethod: 'repo-config',
            remoteBranchDeletionPolicy: 'launch-contract',
          },
        },
      },
    });

    const config = resolveEffectiveTaskConfig({
      repoDir,
      issue: 'HOK-2956',
      stateFile,
      runtimeEnvSnapshot: { baseBranch: 'release', requireConfirm: false },
    });

    assert.deepEqual(config.baseBranch, {
      value: 'auto/integration',
      source: 'cli',
      driftFromRepoConfig: 'main',
    });
    assert.deepEqual(config.requireConfirm, {
      value: true,
      source: 'runtime-env',
      driftFromRepoConfig: false,
    });
    assert.equal(config.mergeMethod?.value, 'squash');
    assert.equal(config.remoteBranchDeletionPolicy?.value.allowed, true);
  } finally {
    restoreHome(priorHome);
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('runtime snapshot is the legacy fallback before repo config', () => {
  const repoDir = tempRepo();
  const priorHome = isolateHome(repoDir);
  try {
    writeRepoConfig(repoDir, { baseBranch: 'main', requireConfirm: false });
    const stateFile = writeState(repoDir, { status: 'active' });
    writeJson(join(repoDir, '.wavemill', 'runtime-env', 'HOK-2956.json'), runtimeEnvSnapshotForTask({
      issue: 'HOK-2956',
      session: 'wm-test',
      runEpoch: '2026-09-08T20:45:26Z',
      baseBranch: 'auto/integration',
      requireConfirm: true,
      mergeMethod: 'rebase',
      capturedAt: '2026-09-08T20:46:00Z',
    }));

    const config = resolveEffectiveTaskConfig({ repoDir, issue: 'HOK-2956', stateFile });

    assert.equal(config.baseBranch.value, 'auto/integration');
    assert.equal(config.baseBranch.source, 'runtime-env');
    assert.equal(config.baseBranch.driftFromRepoConfig, 'main');
    assert.equal(config.requireConfirm.value, true);
    assert.equal(config.requireConfirm.source, 'runtime-env');
    assert.equal(config.mergeMethod?.value, 'rebase');
  } finally {
    restoreHome(priorHome);
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('repo config and defaults fill missing legacy fields', () => {
  const repoDir = tempRepo();
  const defaultRepo = tempRepo();
  const priorHome = isolateHome(repoDir);
  try {
    writeRepoConfig(repoDir, { baseBranch: 'develop', requireConfirm: false });
    const stateFile = writeState(repoDir, { status: 'active' });

    const repoConfig = resolveEffectiveTaskConfig({ repoDir, issue: 'HOK-2956', stateFile });
    assert.equal(repoConfig.baseBranch.value, 'develop');
    assert.equal(repoConfig.baseBranch.source, 'repo-config');
    assert.equal(repoConfig.requireConfirm.value, false);
    assert.equal(repoConfig.requireConfirm.source, 'repo-config');

    const defaultConfig = resolveEffectiveTaskConfig({
      repoDir: defaultRepo,
      issue: 'HOK-2956',
      stateFile: writeState(defaultRepo, { status: 'active' }),
      runtimeEnvSnapshot: null,
    });
    assert.equal(defaultConfig.baseBranch.value, 'main');
    assert.equal(defaultConfig.baseBranch.source, 'default');
    assert.equal(defaultConfig.requireConfirm.value, true);
    assert.equal(defaultConfig.requireConfirm.source, 'default');
  } finally {
    restoreHome(priorHome);
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(defaultRepo, { recursive: true, force: true });
  }
});

test('repo config falls back to integration branch when mill base is absent', () => {
  const repoDir = tempRepo();
  const priorHome = isolateHome(repoDir);
  try {
    writeJson(join(repoDir, '.wavemill-config.json'), {
      configVersion: '1.5.0',
      integration: {
        integrationBranch: 'auto/integration',
        mergeMethod: 'squash',
      },
      mill: {
        requireConfirm: true,
      },
    });
    const stateFile = writeState(repoDir, { status: 'active' });

    const config = resolveEffectiveTaskConfig({ repoDir, issue: 'HOK-2956', stateFile, runtimeEnvSnapshot: null });

    assert.equal(config.baseBranch.value, 'auto/integration');
    assert.equal(config.baseBranch.source, 'repo-config');
    assert.equal(config.requireConfirm.value, true);
    assert.equal(config.mergeMethod?.value, 'squash');
  } finally {
    restoreHome(priorHome);
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('legacy compatibility flag bypasses launch contract', () => {
  const repoDir = tempRepo();
  const prior = process.env.WAVEMILL_EFFECTIVE_CONFIG_LEGACY;
  const priorHome = isolateHome(repoDir);
  try {
    process.env.WAVEMILL_EFFECTIVE_CONFIG_LEGACY = '1';
    writeRepoConfig(repoDir, { baseBranch: 'main', requireConfirm: false });
    const stateFile = writeState(repoDir, {
      lifecycle: {
        schemaVersion: 1,
        workflowOutcome: 'active',
        resourceDisposition: 'allocated',
        launchContract: {
          baseBranch: 'auto/integration',
          requireConfirm: true,
          remoteBranchDeletionPolicy: { allowed: true, mode: 'merged-pr-task-branch' },
        },
      },
    });

    const config = resolveEffectiveTaskConfig({ repoDir, issue: 'HOK-2956', stateFile, runtimeEnvSnapshot: null });

    assert.equal(config.baseBranch.value, 'main');
    assert.equal(config.baseBranch.source, 'repo-config');
    assert.equal(config.requireConfirm.value, false);
    assert.equal(config.requireConfirm.source, 'repo-config');
  } finally {
    if (prior === undefined) {
      delete process.env.WAVEMILL_EFFECTIVE_CONFIG_LEGACY;
    } else {
      process.env.WAVEMILL_EFFECTIVE_CONFIG_LEGACY = prior;
    }
    restoreHome(priorHome);
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('runtime snapshots only include the config allowlist', () => {
  const snapshot = runtimeEnvSnapshotForTask({
    issue: 'HOK-2956',
    session: 'wm-test',
    runEpoch: 'epoch',
    baseBranch: 'auto/integration',
    requireConfirm: true,
  }) as Record<string, unknown>;

  assert.deepEqual(Object.keys(snapshot).sort(), [
    'baseBranch',
    'baseBranchSource',
    'capturedAt',
    'issue',
    'requireConfirm',
    'requireConfirmSource',
    'runEpoch',
    'session',
  ]);
});
