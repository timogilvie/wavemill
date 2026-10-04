#!/usr/bin/env -S npx tsx

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import {
  buildGlobalCertificationPath,
  buildModelCertificationReport,
  CERTIFICATION_SCHEMA_VERSION,
  DEFAULT_CERTIFICATION_SUITE_VERSION,
  GLOBAL_CERTIFICATION_ROOT_ENV,
  resolveCertificationSubject,
  type CertificationPhase,
  type NativeCertificationArtifact,
} from '../shared/lib/native-agent/certification/index.ts';
import { buildLiveCodingCanaryFixture } from '../shared/lib/native-agent/certification/canary-fixtures.ts';
import { resolveNativeAgentProviders } from '../shared/lib/native-agent/providers.ts';
import type { ModelRegistry, NativeProviderName } from '../shared/lib/model-registry.ts';

type ReportRole = 'reviewer' | 'coder' | 'planner';

interface FixtureCase {
  caseId: string;
  provider: NativeProviderName;
  modelId: string;
  artifact?: Partial<NativeCertificationArtifact>;
}

export interface ProviderGatePhaseCheck {
  requiredPhase: CertificationPhase;
  reportRole: ReportRole;
  reportEligible: boolean;
  resolverStatus: string;
  resolverReady: boolean;
  matches: boolean;
}

export interface ProviderGateCaseResult {
  caseId: string;
  provider: NativeProviderName;
  modelId: string;
  reportState: string;
  reportEligibleStages: ReportRole[];
  certificationModeStatus: string;
  phaseChecks: ProviderGatePhaseCheck[];
  passed: boolean;
}

export interface ProviderGateVerificationSummary {
  generatedAt: string;
  passed: boolean;
  cases: ProviderGateCaseResult[];
}

const DEFAULT_NOW = new Date('2026-07-12T12:00:00.000Z');

const PHASE_TO_ROLE: Record<CertificationPhase, ReportRole> = {
  'read-only': 'reviewer',
  patch: 'coder',
  workflow: 'planner',
};

const PROVIDER_ENV: Record<NativeProviderName, string> = {
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

const FIXTURE_CASES: readonly FixtureCase[] = [
  {
    caseId: 'openai-workflow-ready',
    provider: 'openai',
    modelId: 'gpt-4o',
    artifact: {
      phase: 'workflow',
    },
  },
  {
    caseId: 'openrouter-patch-ready',
    provider: 'openrouter',
    modelId: 'qwen-3-coder',
    artifact: {
      phase: 'patch',
    },
  },
  {
    caseId: 'missing-artifact',
    provider: 'openai',
    modelId: 'missing-artifact-model',
  },
  {
    caseId: 'stale-artifact',
    provider: 'openai',
    modelId: 'stale-artifact-model',
    artifact: {
      certifiedAt: new Date(DEFAULT_NOW.getTime() - 61 * 24 * 60 * 60 * 1000).toISOString(),
    },
  },
  {
    caseId: 'wrong-suite-artifact',
    provider: 'openrouter',
    modelId: 'kimi-k2',
    artifact: {
      suiteVersion: 'v0',
    },
  },
  {
    caseId: 'wrong-identity-artifact',
    provider: 'openai',
    modelId: 'wrong-identity-model',
    artifact: {
      provider: 'openrouter',
      model: 'other-model',
    },
  },
] as const;

export function verifyNativeProviderGateAgreement(
  now: Date = DEFAULT_NOW,
): ProviderGateVerificationSummary {
  const tempRoot = mkdtempSync(join(tmpdir(), 'hok2423-provider-gate-'));
  const previousGlobalRoot = process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
  process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = join(tempRoot, 'global-certifications');

  try {
    const cases = FIXTURE_CASES.map((fixture) => runFixtureCase(tempRoot, fixture, now));
    return {
      generatedAt: now.toISOString(),
      passed: cases.every((entry) => entry.passed),
      cases,
    };
  } finally {
    if (previousGlobalRoot === undefined) {
      delete process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
    } else {
      process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = previousGlobalRoot;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function runFixtureCase(
  tempRoot: string,
  fixture: FixtureCase,
  now: Date,
): ProviderGateCaseResult {
  const repoDir = mkdtempSync(join(tempRoot, `${fixture.caseId}-`));
  const registry = makeRegistry(fixture.provider, fixture.modelId, now);

  if (fixture.artifact) {
    writeArtifact(repoDir, fixture.provider, fixture.modelId, registry, now, fixture.artifact);
  }

  const reportRow = buildModelCertificationReport({ repoDir, registry, now })
    .find((row) => row.provider === fixture.provider && row.model === fixture.modelId);
  if (!reportRow) {
    throw new Error(`Report row missing for ${fixture.caseId}`);
  }

  const envKey = PROVIDER_ENV[fixture.provider];
  const providerConfig = {
    providers: {
      [fixture.provider]: {
        models: [fixture.modelId],
      },
    },
  };

  const phaseChecks = (Object.keys(PHASE_TO_ROLE) as CertificationPhase[]).map((requiredPhase) => {
    const [entry] = resolveNativeAgentProviders(providerConfig, {
      repoDir,
      env: { [envKey]: `sk-${fixture.provider}-test` },
      registry,
      phase: 'review',
      requiredCertificationPhase: requiredPhase,
      now,
    });
    const reportRole = PHASE_TO_ROLE[requiredPhase];
    const reportEligible = reportRow.eligibleStages.includes(reportRole);
    const resolverReady = entry?.status === 'ready';
    return {
      requiredPhase,
      reportRole,
      reportEligible,
      resolverStatus: entry?.status ?? 'missing',
      resolverReady,
      matches: reportEligible === resolverReady,
    };
  });

  const [certificationEntry] = resolveNativeAgentProviders(providerConfig, {
    repoDir,
    env: { [envKey]: `sk-${fixture.provider}-test` },
    registry,
    phase: 'review',
    certificationMode: true,
    now,
  });

  return {
    caseId: fixture.caseId,
    provider: fixture.provider,
    modelId: fixture.modelId,
    reportState: reportRow.state,
    reportEligibleStages: [...reportRow.eligibleStages],
    certificationModeStatus: certificationEntry?.status ?? 'missing',
    phaseChecks,
    passed: phaseChecks.every((entry) => entry.matches),
  };
}

function makeRegistry(
  provider: NativeProviderName,
  modelId: string,
  now: Date,
): ModelRegistry {
  return {
    models: {
      [modelId]: {
        vendor: 'test',
        class: 'strong_generalist',
        strengths: ['testing'],
        weaknesses: [],
        qualityScores: { routing: 0, planning: 0, coding: 0, review: 0, classify: 0 },
        contextWindowTokens: 128_000,
        toolSupport: 'full',
        multimodal: { text: true, image: false },
        latencyTier: 'standard',
        reasoningTier: 'standard',
        costPerMillionInputTokensUsd: 1,
        costPerMillionOutputTokensUsd: 2,
        supportedModel: {
          stages: ['planning', 'coding', 'review'],
          lifecycle: 'supported',
          launchEligible: true,
          routingEligible: true,
        },
        nativeCapability: {
          nativeProvider: provider,
          piTransportKind: provider === 'openai' ? 'openai-responses' : 'openai-completions',
          ...(provider === 'openrouter' ? { compatFlags: { thinkingFormat: 'openrouter' as const } } : {}),
          readOnlyNative: 'certified',
          certification: {
            maxCertifiedPhase: 'workflow',
            certifiedAt: now.toISOString(),
            certificationSuiteVersion: DEFAULT_CERTIFICATION_SUITE_VERSION,
          },
        },
      },
    },
    ladders: {},
  };
}

function writeArtifact(
  _repoDir: string,
  provider: NativeProviderName,
  modelId: string,
  registry: ModelRegistry,
  now: Date,
  overrides: Partial<NativeCertificationArtifact>,
): void {
  const identity = resolveCertificationSubject({ provider, model: modelId, registry });
  const path = buildGlobalCertificationPath(
    identity.storageIdentity.provider,
    identity.storageIdentity.model,
    DEFAULT_CERTIFICATION_SUITE_VERSION,
  );
  mkdirSync(dirname(path), { recursive: true });
  const artifact: NativeCertificationArtifact = {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    subject: identity.subject,
    provider: identity.storageIdentity.provider,
    model: identity.storageIdentity.model,
    phase: 'workflow',
    suiteVersion: DEFAULT_CERTIFICATION_SUITE_VERSION,
    certifiedAt: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    scenarios: [{ scenarioId: 's1', passed: true }],
    // HOK-2943: coder resolver readiness and report coder eligibility both
    // require live canary evidence; the fixture keeps them aligned.
    ...((overrides.phase ?? 'workflow') !== 'read-only'
      ? {
        liveCanary: buildLiveCodingCanaryFixture(identity.subject, DEFAULT_CERTIFICATION_SUITE_VERSION, {
          ranAt: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
        }),
      }
      : {}),
    ...overrides,
  };
  writeFileSync(path, JSON.stringify(artifact, null, 2), 'utf-8');
}

function renderSummary(summary: ProviderGateVerificationSummary): string {
  const lines = [
    `generatedAt=${summary.generatedAt}`,
    `passed=${summary.passed}`,
  ];

  for (const entry of summary.cases) {
    lines.push(
      `${entry.caseId}: report=${entry.reportState} eligible=${entry.reportEligibleStages.join(',') || '-'} certificationMode=${entry.certificationModeStatus}`,
    );
    for (const phaseCheck of entry.phaseChecks) {
      lines.push(
        `  ${phaseCheck.requiredPhase}: reportEligible=${phaseCheck.reportEligible} resolver=${phaseCheck.resolverStatus} matches=${phaseCheck.matches}`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

if (import.meta.main) {
  runTool({
    name: 'hok2423-verify-native-provider-gate',
    description: 'Verify native provider resolver/report agreement for certification gating fixtures.',
    options: {
      json: {
        type: 'boolean',
        description: 'Emit machine-readable JSON.',
      },
    },
    examples: [
      'npx tsx tools/hok2423-verify-native-provider-gate.ts',
      'npx tsx tools/hok2423-verify-native-provider-gate.ts --json',
    ],
    async run({ args }) {
      const summary = verifyNativeProviderGateAgreement();
      if (args.json === true) {
        console.log(JSON.stringify(summary, null, 2));
        return;
      }
      process.stdout.write(renderSummary(summary));
      if (!summary.passed) {
        throw Object.assign(new Error('Resolver/report agreement failed for one or more fixture cases.'), { exitCode: 1 });
      }
    },
  });
}
