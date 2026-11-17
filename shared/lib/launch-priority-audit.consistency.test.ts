import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { pickChallengeModelsWithReason } from './challenge-mode.ts';
import { clearConfigCache } from './config.ts';
import { explainEffectiveModelAvailability } from './effective-models.ts';
import { auditLaunchPriorityCoverage, type LaunchPriorityRole } from './launch-priority-audit.ts';
import { getEffectiveRegistry } from './model-registry.ts';
import { filterNativeModels, type RouterRole } from './native-agent/certification/router-filter.ts';
import { GLOBAL_CERTIFICATION_ROOT_ENV } from './native-agent/certification/storage.ts';
import { diagnoseOpenRouter, type OpenRouterDoctorStage } from './openrouter-doctor.ts';

const tempDirs: string[] = [];
const previousCertificationRoot = process.env[GLOBAL_CERTIFICATION_ROOT_ENV];

const ROLE_TO_ROUTER_ROLE: Record<LaunchPriorityRole, RouterRole> = {
  planning: 'planner',
  coding: 'coder',
  review: 'reviewer',
};

const ROLE_TO_DOCTOR_STAGE: Record<LaunchPriorityRole, OpenRouterDoctorStage> = {
  planning: 'planner',
  coding: 'coder',
  review: 'reviewer',
};

const ROLE_TO_EFFECTIVE_STAGE = {
  planning: 'planning',
  coding: 'coding',
  review: 'review',
} as const;

function makeRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'launch-priority-consistency-'));
  tempDirs.push(repoDir);
  process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = join(repoDir, 'global-certifications');
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
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
    router: {
      defaultAgent: 'claude',
    },
  }));
  clearConfigCache(repoDir);
  return repoDir;
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function auditReasonForRole(
  repoDir: string,
  role: LaunchPriorityRole,
  options: { apiKeyPresent?: boolean; apiKeyEnv?: string } = {},
): string {
  const audit = auditLaunchPriorityCoverage({
    repoDir,
    catalog: [{
      wavemillAlias: 'glm-5.3',
      openrouterId: 'z-ai/glm-5.3',
      family: 'glm',
      status: 'active',
      priorityTier: 1,
      roleEligibility: [role],
    }],
    evalRecords: [],
    now: new Date('2026-07-13T14:00:00.000Z'),
    nativeCertificationApiKeyPresent: options.apiKeyPresent,
    nativeCertificationApiKeyEnv: options.apiKeyEnv,
  });
  const blocker = audit.models[0]?.blockers.find((entry) => entry.reason === 'missing-native-certification');
  assert.ok(blocker?.detail);
  const match = blocker.detail.match(/reason=([a-z_]+)/);
  assert.ok(match);
  return match[1]!;
}

function doctorGateReasonForRole(repoDir: string, role: LaunchPriorityRole, apiKey: string | undefined): string {
  const report = withEnv({ TEST_OPENROUTER_KEY: apiKey }, () =>
    diagnoseOpenRouter({ repoDir, stage: ROLE_TO_DOCTOR_STAGE[role] })
  );
  const cell = report.models.find((model) => model.id === 'glm-5.3')?.cells[0];
  assert.ok(cell);
  const certificationReason = [
    cell.primaryReason,
    ...cell.secondaryReasons,
  ].find((reason) => reason?.reason === 'CERTIFICATION_REJECTED');
  assert.ok(certificationReason);
  const match = certificationReason.detail.match(/reason=([a-z-]+)/);
  assert.ok(match);
  return match[1]!.replaceAll('-', '_');
}

afterEach(() => {
  clearConfigCache();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (previousCertificationRoot === undefined) {
    delete process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
  } else {
    process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = previousCertificationRoot;
  }
});

describe('launch-priority native eligibility consistency', () => {
  it('fail-closes missing artifacts with matching audit, doctor, router, projection, and challenge reasons', () => {
    const repoDir = makeRepo();
    const registry = getEffectiveRegistry(repoDir);

    for (const role of ['planning', 'coding', 'review'] as const) {
      const router = filterNativeModels(['glm-5.3'], ROLE_TO_ROUTER_ROLE[role], registry, repoDir);
      assert.equal(router.eligible.length, 0);
      assert.equal(router.rejected[0]?.reason, 'missing-artifact');

      const projection = explainEffectiveModelAvailability('glm-5.3', ROLE_TO_EFFECTIVE_STAGE[role], {
        repoDir,
        registry,
        requireRuntimeReady: true,
      });
      assert.equal(projection.available, false);
      assert.equal(projection.nativeGate?.ok, false);

      assert.equal(auditReasonForRole(repoDir, role), projection.nativeGate?.ok === false ? projection.nativeGate.reason : '');
      assert.equal(doctorGateReasonForRole(repoDir, role, 'sk-test'), projection.nativeGate?.ok === false ? projection.nativeGate.reason : '');
    }

    const challenge = pickChallengeModelsWithReason(['claude-sonnet-5', 'glm-5.3'], {
      pairId: 'pair-1',
      issueId: 'HOK-2585',
      slug: 'consistency',
      primaryModel: 'claude-sonnet-5',
      forcedChallengerModel: 'glm-5.3',
      repoDir,
      randomFn: () => 0,
    });
    const challengeRejection = challenge.nativeCertificationRejections.find((entry) => entry.modelId === 'glm-5.3');
    assert.equal(challengeRejection?.reason, 'missing-artifact');
  });

  it('fail-closes missing API keys with matching audit, doctor, router, projection, and challenge reasons', () => {
    const repoDir = makeRepo();
    const registry = getEffectiveRegistry(repoDir);
    const apiKeyEnv = 'TEST_OPENROUTER_KEY';

    const router = filterNativeModels(['glm-5.3'], 'coder', registry, repoDir, {
      apiKeyPresent: false,
      apiKeyEnv,
    });
    assert.equal(router.eligible.length, 0);
    assert.equal(router.rejected[0]?.reason, 'missing-api-key');
    assert.equal(router.rejected[0]?.apiKeyEnv, apiKeyEnv);

    const projection = explainEffectiveModelAvailability('glm-5.3', 'coding', {
      repoDir,
      registry,
      requireRuntimeReady: true,
      apiKeyPresent: false,
      apiKeyEnv,
    });
    assert.equal(projection.available, false);
    assert.equal(projection.nativeGate?.ok, false);
    assert.equal(projection.nativeGate?.ok === false ? projection.nativeGate.reason : '', 'missing_api_key');

    assert.equal(auditReasonForRole(repoDir, 'coding', { apiKeyPresent: false, apiKeyEnv }), 'missing_api_key');
    assert.equal(doctorGateReasonForRole(repoDir, 'coding', undefined), 'missing_api_key');

    const challenge = pickChallengeModelsWithReason(['claude-sonnet-5', 'glm-5.3'], {
      pairId: 'pair-2',
      issueId: 'HOK-2585',
      slug: 'consistency',
      primaryModel: 'claude-sonnet-5',
      forcedChallengerModel: 'glm-5.3',
      repoDir,
      randomFn: () => 0,
      nativeCertificationApiKeyPresent: false,
      nativeCertificationApiKeyEnv: apiKeyEnv,
    });
    const challengeRejection = challenge.nativeCertificationRejections.find((entry) => entry.modelId === 'glm-5.3');
    assert.equal(challengeRejection?.reason, 'missing-api-key');
    assert.equal(challengeRejection?.apiKeyEnv, apiKeyEnv);
  });
});
