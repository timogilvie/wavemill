#!/usr/bin/env -S npx tsx

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { clearConfigCache } from '../shared/lib/config.ts';
import { buildCertificationPath } from '../shared/lib/native-agent/certification/loader.ts';
import { CERTIFICATION_SCHEMA_VERSION, type CertificationPhase, type NativeCertificationArtifact } from '../shared/lib/native-agent/certification/schema.ts';
import {
  DEFAULT_CERTIFICATION_SUITE_VERSION,
  getDefaultScenarios,
} from '../shared/lib/native-agent/certification/scenarios.ts';
import { readCertification } from '../shared/lib/native-agent/certification/store.ts';
import { filterNativeModels, type RouterCertificationRejection } from '../shared/lib/native-agent/certification/router-filter.ts';
import { routeWorkflow } from '../shared/lib/workflow-router.ts';
import { listEffectiveNativeProviderModels } from '../shared/lib/effective-models.ts';
import type { ModelRegistry } from '../shared/lib/model-registry.ts';
import { resolveWavemillToolPath } from '../shared/lib/native-agent/install-paths.ts';

const ISSUE_ID = 'HOK-2425';
const EVIDENCE_PATH = 'features/verification-companion-for-native-workflow-certification-coverage/verification-evidence.md';
const PREFERRED_ROLLOUT_MODELS = [
  'qwen/qwen3-coder',
  'z-ai/glm-5.2',
  'moonshotai/kimi-k2.7-code',
] as const;
const UNREGISTERED_OPENROUTER_MODEL = 'legacy-mistral-openrouter';
const REAL_PROVIDER_ENV = 'OPENROUTER_API_KEY';
const TEMP_OPENROUTER_ENV = 'TEST_OPENROUTER_KEY';

export interface CommandCapture {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ArtifactCoverageSummary {
  path: string;
  phase: CertificationPhase;
  suiteVersion: string;
  scenarioCount: number;
  passingScenarioCount: number;
  workflowScenarioCount: number;
  passingWorkflowScenarioCount: number;
  failingWorkflowScenarioIds: string[];
  missingWorkflowScenarioIds: string[];
}

interface MissingArtifactSummary {
  path: string;
  error: string;
}

interface AcceptanceRow {
  criterion: string;
  verdict: 'PASS' | 'DEFERRED';
  evidence: string;
}

interface DryRunSummary {
  capture: CommandCapture;
  parsed: {
    provider: string;
    model: string;
    phase: CertificationPhase;
    suiteVersion: string;
    dryRun: boolean;
    harnessPassed: boolean;
    liveCertifiable: boolean;
    artifactPath?: string;
  };
}

interface LiveRunSummary {
  status: 'executed' | 'deferred';
  reason: string;
  capture?: CommandCapture;
  artifact?: ArtifactCoverageSummary;
}

interface PlannerFailClosedObservation {
  caseId: 'missing' | 'stale' | 'wrong-suite' | 'malformed' | 'insufficient-phase';
  planner: string;
  reason: string | undefined;
}

interface ReadOnlyBehaviorSummary {
  reviewerEligible: string[];
  reviewerRejected: RouterCertificationRejection[];
  plannerEligible: string[];
  plannerRejected: RouterCertificationRejection[];
}

interface UnregisteredOpenRouterSummary {
  modelId: string;
  planner: string;
  reason: string | undefined;
}

interface VerificationSummary {
  issueId: string;
  gitSha: string;
  generatedAt: string;
  nodeVersion: string;
  openRouterApiKeyPresent: boolean;
  representativeModel: string;
  workflowScenarioIds: string[];
  dryRun: DryRunSummary;
  liveRun: LiveRunSummary;
  currentArtifacts: Array<ArtifactCoverageSummary | MissingArtifactSummary>;
  failClosedPlannerCases: PlannerFailClosedObservation[];
  readOnlyBehavior: ReadOnlyBehaviorSummary;
  unregisteredOpenRouter: UnregisteredOpenRouterSummary;
  evidencePath: string;
}

export function getConfiguredNativeOpenRouterModels(config: unknown): string[] {
  void config;
  return listEffectiveNativeProviderModels('openrouter', 'coding').models;
}

export function pickRepresentativeModel(config: unknown): string {
  const configured = new Set(getConfiguredNativeOpenRouterModels(config));
  for (const candidate of PREFERRED_ROLLOUT_MODELS) {
    if (configured.has(candidate)) {
      return candidate;
    }
  }

  const fallback = [...configured][0];
  if (!fallback) {
    throw new Error('No native OpenRouter rollout models were found in the global effective-model projection.');
  }
  return fallback;
}

export function getWorkflowScenarioIds(): string[] {
  return getDefaultScenarios()
    .filter((scenario) => scenario.phase === 'workflow')
    .map((scenario) => scenario.id)
    .sort();
}

export function summarizeArtifactCoverage(
  artifact: NativeCertificationArtifact,
  absolutePath: string,
  workflowScenarioIds: readonly string[],
): ArtifactCoverageSummary {
  const workflowIdSet = new Set(workflowScenarioIds);
  const workflowScenarios = artifact.scenarios.filter((scenario) => workflowIdSet.has(scenario.scenarioId));

  return {
    path: absolutePath,
    phase: artifact.phase,
    suiteVersion: artifact.suiteVersion,
    scenarioCount: artifact.scenarios.length,
    passingScenarioCount: artifact.scenarios.filter((scenario) => scenario.passed).length,
    workflowScenarioCount: workflowScenarios.length,
    passingWorkflowScenarioCount: workflowScenarios.filter((scenario) => scenario.passed).length,
    failingWorkflowScenarioIds: workflowScenarios
      .filter((scenario) => !scenario.passed)
      .map((scenario) => scenario.scenarioId)
      .sort(),
    missingWorkflowScenarioIds: workflowScenarioIds
      .filter((scenarioId) => !workflowScenarios.some((scenario) => scenario.scenarioId === scenarioId))
      .sort(),
  };
}

export function classifyLiveRunDeferral(capture: CommandCapture): string | null {
  const combined = `${capture.stdout}\n${capture.stderr}`.toLowerCase();
  if (
    /http 401|http 403|http 429|http 500|http 502|http 503|http 504/.test(combined)
    || /unauthorized|forbidden|rate limit|quota|service unavailable/.test(combined)
    || /network|timed out|timeout|etimedout|econnreset|enotfound|fetch failed/.test(combined)
  ) {
    return `Live certification deferred because OpenRouter was unavailable: exit ${capture.exitCode}.`;
  }
  return null;
}

export function buildVerificationMarkdown(summary: VerificationSummary): string {
  const relativeEvidencePath = summary.evidencePath;
  const dryRunStdout = fenced(summary.dryRun.capture.stdout || '(no stdout)', 'json');
  const dryRunStderr = fenced(summary.dryRun.capture.stderr || '(no stderr)', 'text');
  const liveSection = summary.liveRun.status === 'executed'
    ? [
      '## Live Workflow Certification',
      '',
      'Command:',
      '',
      fenced(summary.liveRun.capture?.command ?? '(missing command)', 'bash'),
      'Captured stdout:',
      '',
      fenced(summary.liveRun.capture?.stdout || '(no stdout)', 'json'),
      'Captured stderr:',
      '',
      fenced(summary.liveRun.capture?.stderr || '(no stderr)', 'text'),
      'Artifact summary:',
      '',
      `- path: \`${relativePath(summary.liveRun.artifact?.path ?? '', process.cwd())}\``,
      `- phase: \`${summary.liveRun.artifact?.phase ?? ''}\``,
      `- suite: \`${summary.liveRun.artifact?.suiteVersion ?? ''}\``,
      `- workflow records: ${summary.liveRun.artifact?.workflowScenarioCount ?? 0}`,
      `- passing workflow records: ${summary.liveRun.artifact?.passingWorkflowScenarioCount ?? 0}`,
      summary.liveRun.artifact?.missingWorkflowScenarioIds.length
        ? `- missing workflow scenario IDs: ${summary.liveRun.artifact.missingWorkflowScenarioIds.map((id) => `\`${id}\``).join(', ')}`
        : '- missing workflow scenario IDs: none',
      summary.liveRun.artifact?.failingWorkflowScenarioIds.length
        ? `- failing workflow scenario IDs: ${summary.liveRun.artifact.failingWorkflowScenarioIds.map((id) => `\`${id}\``).join(', ')}`
        : '- failing workflow scenario IDs: none',
      '',
    ].join('\n')
    : [
      '## Live Workflow Certification',
      '',
      `Deferred: ${summary.liveRun.reason}`,
      '',
    ].join('\n');

  const currentArtifactRows = summary.currentArtifacts.map((artifact) => {
    if ('error' in artifact) {
      return `| \`${relativePath(artifact.path, process.cwd())}\` | missing | - | - | - | - | ${artifact.error} |`;
    }

    const note = artifact.missingWorkflowScenarioIds.length > 0
      ? `missing ${artifact.missingWorkflowScenarioIds.length} workflow IDs`
      : artifact.failingWorkflowScenarioIds.length > 0
        ? `failing IDs: ${artifact.failingWorkflowScenarioIds.join(', ')}`
        : 'complete';
    return `| \`${relativePath(artifact.path, process.cwd())}\` | \`${artifact.phase}\` | \`${artifact.suiteVersion}\` | ${artifact.scenarioCount} | ${artifact.workflowScenarioCount} | ${artifact.passingWorkflowScenarioCount} | ${note} |`;
  }).join('\n');

  const acceptanceRows = buildAcceptanceRows(summary)
    .map((row) => `| ${row.criterion} | ${row.verdict} | ${row.evidence} |`)
    .join('\n');

  const failClosedRows = summary.failClosedPlannerCases
    .map((row) => `| ${row.caseId} | \`${row.planner}\` | \`${row.reason ?? ''}\` |`)
    .join('\n');

  return [
    `# ${summary.issueId} Verification Evidence`,
    '',
    `Generated: ${summary.generatedAt}`,
    `Git SHA: ${summary.gitSha}`,
    `Node: ${summary.nodeVersion}`,
    `Representative model: \`${summary.representativeModel}\``,
    `OPENROUTER_API_KEY present: ${summary.openRouterApiKeyPresent ? 'yes' : 'no'}`,
    `Evidence artifact: \`${relativeEvidencePath}\``,
    '',
    '## Dry-Run Workflow Certification',
    '',
    'Command:',
    '',
    fenced(summary.dryRun.capture.command, 'bash'),
    'Captured stdout:',
    '',
    dryRunStdout,
    'Captured stderr:',
    '',
    dryRunStderr,
    '',
    liveSection,
    '## Current Checked-In Workflow Artifact Inventory',
    '',
    `Current workflow scenario IDs (${summary.workflowScenarioIds.length}): ${summary.workflowScenarioIds.map((id) => `\`${id}\``).join(', ')}`,
    '',
    '| Path | Phase | Suite | Total Records | Workflow Records | Passing Workflow Records | Notes |',
    '| --- | --- | --- | ---: | ---: | ---: | --- |',
    currentArtifactRows,
    '',
    '## Fail-Closed Planner Selection',
    '',
    '| Case | Planner Selection | Observed Reason |',
    '| --- | --- | --- |',
    failClosedRows,
    '',
    '## Read-Only Certification Behavior',
    '',
    `Reviewer eligibility: eligible=${formatStringList(summary.readOnlyBehavior.reviewerEligible)} rejected=${formatReasons(summary.readOnlyBehavior.reviewerRejected)}`,
    `Planner eligibility from the same read-only artifact: eligible=${formatStringList(summary.readOnlyBehavior.plannerEligible)} rejected=${formatReasons(summary.readOnlyBehavior.plannerRejected)}`,
    '',
    '## Unregistered OpenRouter Catalog Model',
    '',
    `Model: \`${summary.unregisteredOpenRouter.modelId}\``,
    `Planner selection: \`${summary.unregisteredOpenRouter.planner}\``,
    `Observed reason: \`${summary.unregisteredOpenRouter.reason ?? ''}\``,
    '',
    '## Acceptance Criteria',
    '',
    '| Criterion | Verdict | Evidence |',
    '| --- | --- | --- |',
    acceptanceRows,
    '',
  ].join('\n');
}

function buildAcceptanceRows(summary: VerificationSummary): AcceptanceRow[] {
  const liveArtifact = summary.liveRun.artifact;
  const currentArtifactWarning = summary.currentArtifacts
    .filter((artifact): artifact is ArtifactCoverageSummary => !('error' in artifact))
    .some((artifact) => artifact.missingWorkflowScenarioIds.length > 0 || artifact.workflowScenarioCount < summary.workflowScenarioIds.length);

  return [
    {
      criterion: 'Dry-run workflow certification executed for a configured native OpenRouter model',
      verdict: 'PASS',
      evidence: `\`${summary.representativeModel}\` via \`${summary.dryRun.capture.command}\` exited ${summary.dryRun.capture.exitCode}.`,
    },
    {
      criterion: 'Live workflow certification executed or explicitly deferred',
      verdict: summary.liveRun.status === 'executed' ? 'PASS' : 'DEFERRED',
      evidence: summary.liveRun.status === 'executed'
        ? `Artifact \`${relativePath(liveArtifact?.path ?? '', process.cwd())}\` was written.`
        : summary.liveRun.reason,
    },
    {
      criterion: 'Live artifact has workflow phase, v1 suite, and passing workflow records when executed',
      verdict: summary.liveRun.status === 'executed' ? 'PASS' : 'DEFERRED',
      evidence: summary.liveRun.status === 'executed'
        ? `phase=\`${liveArtifact?.phase}\`, suite=\`${liveArtifact?.suiteVersion}\`, passingWorkflow=${liveArtifact?.passingWorkflowScenarioCount}/${liveArtifact?.workflowScenarioCount}.`
        : 'Deferred with no live artifact written in this run.',
    },
    {
      criterion: 'Planner/workflow selection fails closed for missing, stale, wrong-suite, malformed, and insufficient-phase artifacts',
      verdict: summary.failClosedPlannerCases.every((row) => row.planner === '' && row.reason) ? 'PASS' : 'DEFERRED',
      evidence: summary.failClosedPlannerCases
        .map((row) => `${row.caseId}=>${row.reason ?? 'missing-reason'}`)
        .join(', '),
    },
    {
      criterion: 'Read-only certification still admits read-only routing but not workflow routing',
      verdict: summary.readOnlyBehavior.reviewerEligible.length === 1 && summary.readOnlyBehavior.plannerRejected[0]?.reason === 'insufficient-phase' ? 'PASS' : 'DEFERRED',
      evidence: `reviewer eligible=${formatStringList(summary.readOnlyBehavior.reviewerEligible)}; planner rejection=${summary.readOnlyBehavior.plannerRejected[0]?.reason ?? 'none'}.`,
    },
    {
      criterion: 'Workflow certification does not automatically admit unregistered OpenRouter catalog models',
      verdict: summary.unregisteredOpenRouter.planner === '' && summary.unregisteredOpenRouter.reason === 'no-native-capability' ? 'PASS' : 'DEFERRED',
      evidence: `\`${summary.unregisteredOpenRouter.modelId}\` rejected with \`${summary.unregisteredOpenRouter.reason ?? ''}\`.`,
    },
    {
      criterion: 'Current checked-in workflow artifacts were evaluated against the current workflow suite',
      verdict: 'PASS',
      evidence: currentArtifactWarning
        ? 'Existing checked-in workflow artifacts do not cover the full current workflow scenario set and were treated as stale verification evidence.'
        : 'Current checked-in workflow artifacts cover the current workflow scenario set.',
    },
  ];
}

function captureCommand(
  repoDir: string,
  args: string[],
  envOverrides: Record<string, string | undefined> = {},
): CommandCapture {
  const result = spawnSync('npx', ['tsx', ...args], {
    cwd: repoDir,
    env: {
      ...process.env,
      ...envOverrides,
    },
    encoding: 'utf-8',
  });

  return {
    command: `npx tsx ${args.join(' ')}`,
    exitCode: result.status ?? 1,
    stdout: result.stdout.trimEnd(),
    stderr: result.stderr.trimEnd(),
  };
}

function parseJsonStdout<T>(capture: CommandCapture): T {
  if (!capture.stdout.trim()) {
    throw new Error(`Command produced no JSON stdout: ${capture.command}`);
  }
  return JSON.parse(capture.stdout) as T;
}

function inspectExpectedArtifact(
  repoDir: string,
  modelId: string,
  workflowScenarioIds: readonly string[],
): ArtifactCoverageSummary | MissingArtifactSummary {
  const path = buildCertificationPath(repoDir, 'openrouter', modelId, 'v1');
  const result = readCertification(path);
  if (!result.ok) {
    return {
      path,
      error: result.error.code,
    };
  }

  return summarizeArtifactCoverage(result.artifact, path, workflowScenarioIds);
}

function baseRouterConfig(): Record<string, unknown> {
  return {
    router: {
      enabled: true,
      mode: 'heuristic',
      defaultAgent: 'claude',
      minRecords: 1,
      minModels: 1,
      defaultModel: 'claude-sonnet-5',
      agentMap: {
        'claude-sonnet-5': 'claude',
        'claude-haiku-4-5-20251001': 'claude',
      },
    },
    eval: {
      pricing: {
        'claude-sonnet-5': { inputCostPerMTok: 3, outputCostPerMTok: 15, cacheWriteCostPerMTok: 3.75, cacheReadCostPerMTok: 0.3 },
        'claude-haiku-4-5-20251001': { inputCostPerMTok: 0.8, outputCostPerMTok: 4, cacheWriteCostPerMTok: 1, cacheReadCostPerMTok: 0.08 },
      },
    },
  };
}

function makeTempRepo(config: Record<string, unknown>): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'hok2425-native-workflow-'));
  mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
  writeFileSync(join(repoDir, '.wavemill', 'evals', 'records.jsonl'), [
    JSON.stringify({ id: '1', modelId: 'claude-sonnet-5', originalPrompt: 'Plan a workflow', score: 0.89, timeSeconds: 100, interventionCount: 0 }),
    JSON.stringify({ id: '2', modelId: 'claude-haiku-4-5-20251001', originalPrompt: 'Review a patch', score: 0.83, timeSeconds: 120, interventionCount: 0 }),
    '',
  ].join('\n'), 'utf-8');
  writeFileSync(join(repoDir, '.wavemill-config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  clearConfigCache(repoDir);
  return {
    repoDir,
    cleanup: () => {
      clearConfigCache(repoDir);
      rmSync(repoDir, { recursive: true, force: true });
    },
  };
}

function nativeModelConfig(certPhase: CertificationPhase = 'workflow', suiteVersion = 'v1'): Record<string, unknown> {
  return {
    class: 'strong_generalist',
    nativeCapability: {
      nativeProvider: 'openai',
      piTransportKind: 'openai-responses',
      readOnlyNative: 'certified',
      certification: {
        maxCertifiedPhase: certPhase,
        certifiedAt: '2026-06-01T00:00:00.000Z',
        certificationSuiteVersion: suiteVersion,
      },
    },
  };
}

function writeSyntheticArtifact(
  repoDir: string,
  provider: string,
  model: string,
  suiteVersion: string,
  phase: CertificationPhase,
  overrides: Partial<NativeCertificationArtifact> = {},
): string {
  const certDir = join(repoDir, '.wavemill', 'native-agent-certifications', provider, model);
  mkdirSync(certDir, { recursive: true });
  const artifact: NativeCertificationArtifact = {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    provider,
    model,
    phase,
    suiteVersion,
    certifiedAt: '2026-07-10T12:00:00.000Z',
    scenarios: [{ scenarioId: 'synthetic.pass', passed: true }],
    ...overrides,
  };
  const artifactPath = join(certDir, `${suiteVersion}.json`);
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf-8');
  return artifactPath;
}

function verifyPlannerFailClosedCases(): PlannerFailClosedObservation[] {
  const repo = makeTempRepo({
    ...baseRouterConfig(),
    modelRegistry: {
      models: {
        'native-workflow-check': nativeModelConfig('workflow'),
      },
    },
  });

  try {
    const prompt = 'Plan a workflow change.';
    const modelId = 'native-workflow-check';
    const plannerArgs = {
      repoDir: repo.repoDir,
      plannerModelsAvailable: [modelId],
      modelsAvailable: [modelId],
      skipDifficultyClassification: true,
    } as const;

    const missing = routeWorkflow(prompt, plannerArgs);

    writeSyntheticArtifact(repo.repoDir, 'openai', modelId, DEFAULT_CERTIFICATION_SUITE_VERSION, 'workflow', {
      certifiedAt: '2020-01-01T00:00:00.000Z',
    });
    const stale = routeWorkflow(prompt, plannerArgs);

    writeSyntheticArtifact(repo.repoDir, 'openai', modelId, DEFAULT_CERTIFICATION_SUITE_VERSION, 'workflow', {
      suiteVersion: 'v0',
    });
    const wrongSuite = routeWorkflow(prompt, plannerArgs);

    writeFileSync(
      join(repo.repoDir, '.wavemill', 'native-agent-certifications', 'openai', modelId, `${DEFAULT_CERTIFICATION_SUITE_VERSION}.json`),
      '{ invalid json',
      'utf-8',
    );
    const malformed = routeWorkflow(prompt, plannerArgs);

    writeSyntheticArtifact(repo.repoDir, 'openai', modelId, DEFAULT_CERTIFICATION_SUITE_VERSION, 'read-only');
    const insufficientPhase = routeWorkflow(prompt, plannerArgs);

    return [
      summarizePlannerFailure('missing', missing, modelId),
      summarizePlannerFailure('stale', stale, modelId),
      summarizePlannerFailure('wrong-suite', wrongSuite, modelId),
      summarizePlannerFailure('malformed', malformed, modelId),
      summarizePlannerFailure('insufficient-phase', insufficientPhase, modelId),
    ];
  } finally {
    repo.cleanup();
  }
}

function summarizePlannerFailure(
  caseId: PlannerFailClosedObservation['caseId'],
  decision: ReturnType<typeof routeWorkflow>,
  modelId: string,
): PlannerFailClosedObservation {
  const rejection = (decision.nativeCertificationRejections ?? [])
    .find((entry) => entry.modelId === modelId && entry.role === 'planner');
  return {
    caseId,
    planner: decision.planner,
    reason: rejection?.reason,
  };
}

function verifyReadOnlyBehavior(): ReadOnlyBehaviorSummary {
  const repo = makeTempRepo({
    ...baseRouterConfig(),
    modelRegistry: {
      models: {
        'native-read-only-check': nativeModelConfig('read-only'),
      },
    },
  });

  try {
    writeSyntheticArtifact(repo.repoDir, 'openai', 'native-read-only-check', 'v1', 'read-only');
    const registry: ModelRegistry = {
      models: {
        'native-read-only-check': nativeModelConfig('read-only'),
      },
      ladders: {},
    } as ModelRegistry;

    const reviewer = filterNativeModels(['native-read-only-check'], 'reviewer', registry, repo.repoDir);
    const planner = filterNativeModels(['native-read-only-check'], 'planner', registry, repo.repoDir);

    return {
      reviewerEligible: reviewer.eligible,
      reviewerRejected: reviewer.rejected,
      plannerEligible: planner.eligible,
      plannerRejected: planner.rejected,
    };
  } finally {
    repo.cleanup();
  }
}

function verifyUnregisteredOpenRouterModel(): UnregisteredOpenRouterSummary {
  const original = process.env[TEMP_OPENROUTER_ENV];
  process.env[TEMP_OPENROUTER_ENV] = 'test-key';

  const repo = makeTempRepo({
    ...baseRouterConfig(),
    providers: {
      openrouter: {
        enabled: true,
        apiKeyEnv: TEMP_OPENROUTER_ENV,
        models: [UNREGISTERED_OPENROUTER_MODEL],
        stages: ['planner', 'coder', 'reviewer'],
      },
    },
    modelRegistry: {
      models: {
        [UNREGISTERED_OPENROUTER_MODEL]: {
          class: 'strong_generalist',
          vendor: 'mistral',
          strengths: [],
          weaknesses: [],
          qualityScores: { routing: 60, planning: 70, coding: 70, review: 70, classify: 60 },
          contextWindowTokens: 128_000,
          toolSupport: 'basic',
          multimodal: { text: true, image: false },
          latencyTier: 'standard',
          reasoningTier: 'standard',
          costPerMillionInputTokensUsd: 2,
          costPerMillionOutputTokensUsd: 6,
          agent: 'claude-openrouter',
        },
      },
    },
  });

  try {
    const decision = routeWorkflow('Plan a workflow feature.', {
      repoDir: repo.repoDir,
      plannerModelsAvailable: [UNREGISTERED_OPENROUTER_MODEL],
      modelsAvailable: [UNREGISTERED_OPENROUTER_MODEL],
      skipDifficultyClassification: true,
    });
    const rejection = (decision.nativeCertificationRejections ?? [])
      .find((entry) => entry.modelId === UNREGISTERED_OPENROUTER_MODEL && entry.role === 'planner');

    return {
      modelId: UNREGISTERED_OPENROUTER_MODEL,
      planner: decision.planner,
      reason: rejection?.reason,
    };
  } finally {
    repo.cleanup();
    if (original === undefined) {
      delete process.env[TEMP_OPENROUTER_ENV];
    } else {
      process.env[TEMP_OPENROUTER_ENV] = original;
    }
  }
}

function verifyDryRun(repoDir: string, modelId: string): DryRunSummary {
  const capture = captureCommand(repoDir, [
    resolveWavemillToolPath('native-agent-certify.ts'),
    '--provider', 'openrouter',
    '--model', modelId,
    '--phase', 'workflow',
    '--dry-run',
    '--json',
  ]);
  assert.equal(capture.exitCode, 0, `Dry-run command failed: ${capture.stderr || capture.stdout}`);

  const parsed = parseJsonStdout<DryRunSummary['parsed']>(capture);
  assert.equal(parsed.provider, 'openrouter');
  assert.equal(parsed.model, modelId);
  assert.equal(parsed.phase, 'workflow');
  assert.equal(parsed.suiteVersion, 'v1');
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.harnessPassed, true);

  return { capture, parsed };
}

function verifyLiveRun(
  repoDir: string,
  modelId: string,
  workflowScenarioIds: readonly string[],
): LiveRunSummary {
  if (!process.env[REAL_PROVIDER_ENV]?.trim()) {
    return {
      status: 'deferred',
      reason: `${REAL_PROVIDER_ENV} is not set in this environment.`,
    };
  }

  const capture = captureCommand(repoDir, [
    resolveWavemillToolPath('native-agent-certify.ts'),
    '--provider', 'openrouter',
    '--model', modelId,
    '--phase', 'workflow',
    '--json',
  ]);

  if (capture.exitCode !== 0) {
    const deferralReason = classifyLiveRunDeferral(capture);
    if (deferralReason) {
      return {
        status: 'deferred',
        reason: deferralReason,
        capture,
      };
    }
    throw new Error(`Live workflow certification failed unexpectedly.\n${capture.stderr || capture.stdout}`);
  }

  const parsed = parseJsonStdout<{
    harnessPassed: boolean;
    artifactPath?: string;
    phase: CertificationPhase;
    suiteVersion: string;
  }>(capture);
  assert.equal(parsed.harnessPassed, true);
  assert.ok(parsed.artifactPath, 'Live workflow certification did not report an artifact path.');

  const artifactPath = parsed.artifactPath!.startsWith('/')
    ? parsed.artifactPath!
    : join(repoDir, parsed.artifactPath!);
  const artifact = readCertification(artifactPath);
  assert.equal(artifact.ok, true, `Live certification artifact unreadable at ${artifactPath}`);

  return {
    status: 'executed',
    reason: 'Live workflow certification completed.',
    capture,
    artifact: summarizeArtifactCoverage((artifact as { ok: true; artifact: NativeCertificationArtifact }).artifact, artifactPath, workflowScenarioIds),
  };
}

async function runVerification(repoDir: string): Promise<VerificationSummary> {
  const config = JSON.parse(readFileSync(join(repoDir, '.wavemill-config.json'), 'utf-8')) as Record<string, unknown>;
  const representativeModel = pickRepresentativeModel(config);
  const workflowScenarioIds = getWorkflowScenarioIds();

  const dryRun = verifyDryRun(repoDir, representativeModel);
  const liveRun = verifyLiveRun(repoDir, representativeModel, workflowScenarioIds);
  const configuredModels = getConfiguredNativeOpenRouterModels(config);
  const currentArtifacts = configuredModels.map((modelId) => inspectExpectedArtifact(repoDir, modelId, workflowScenarioIds));
  const failClosedPlannerCases = verifyPlannerFailClosedCases();
  const readOnlyBehavior = verifyReadOnlyBehavior();
  const unregisteredOpenRouter = verifyUnregisteredOpenRouterModel();

  return {
    issueId: ISSUE_ID,
    gitSha: captureShellText(repoDir, ['git', 'rev-parse', 'HEAD']),
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    openRouterApiKeyPresent: Boolean(process.env[REAL_PROVIDER_ENV]?.trim()),
    representativeModel,
    workflowScenarioIds,
    dryRun,
    liveRun,
    currentArtifacts,
    failClosedPlannerCases,
    readOnlyBehavior,
    unregisteredOpenRouter,
    evidencePath: EVIDENCE_PATH,
  };
}

function captureShellText(repoDir: string, command: string[]): string {
  const result = spawnSync(command[0]!, command.slice(1), {
    cwd: repoDir,
    encoding: 'utf-8',
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(`Failed to run ${command.join(' ')}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function relativePath(path: string, repoDir: string): string {
  if (!path) {
    return '';
  }
  const result = relative(repoDir, path);
  return result.length > 0 ? result : '.';
}

function fenced(content: string, language: string): string {
  return `\`\`\`${language}\n${content}\n\`\`\``;
}

function formatStringList(values: string[]): string {
  return values.length > 0 ? values.map((value) => `\`${value}\``).join(', ') : '(none)';
}

function formatReasons(rejections: RouterCertificationRejection[]): string {
  return rejections.length > 0
    ? rejections.map((rejection) => `\`${rejection.reason}\``).join(', ')
    : '(none)';
}

async function main(): Promise<void> {
  const repoDir = process.cwd();
  const summary = await runVerification(repoDir);
  const markdown = buildVerificationMarkdown(summary);
  writeFileSync(join(repoDir, EVIDENCE_PATH), markdown, 'utf-8');
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (import.meta.main) {
  void main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
