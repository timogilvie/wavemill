import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EvalRecord } from './eval-schema.ts';
import { clearConfigCache } from './config.ts';
import { finalizeEvalSuccess } from './eval-success-policy.ts';
import {
  collectPostCompletionOutcomes,
  enrichPostCompletionRecord,
  postCompletionHookDeps,
  runPostCompletionEval,
} from './post-completion-hook.ts';
import { evaluateTask, JudgeResponseRecoveryError } from './eval.ts';
import { buildChallengeExecutionIntent } from './challenge-execution-contract.ts';

let passed = 0;
let failed = 0;
const defaultPostCompletionHookDeps = { ...postCompletionHookDeps };

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(err as Error).message}`);
  }
}

function makeRecord(): EvalRecord {
  return {
    id: 'eval-hook-1',
    schemaVersion: '1.4.0',
    originalPrompt: 'placeholder',
    modelId: 'claude-sonnet-4-5-20250929',
    modelVersion: 'claude-sonnet-4-5-20250929',
    score: 0.9,
    scoreBand: 'Minor Feedback',
    timeSeconds: 240,
    timestamp: '2026-04-06T12:00:00.000Z',
    interventionRequired: false,
    interventionCount: 1,
    interventionDetails: ['Asked for clarification'],
    rationale: 'Strong result.',
    metadata: {
      stageScores: {
        plan: { score: 0.91, rationale: 'clear plan' },
        implementation: { score: 0.87, rationale: 'solid implementation' },
        review: { score: 0.9, rationale: 'good review' },
      },
    },
  };
}

function makeInterventionSummary(reviewComments = 0) {
  return {
    interventions: reviewComments > 0
      ? [{ type: 'review_comment', count: reviewComments, details: ['requested change'] }]
      : [],
    totalInterventionScore: reviewComments > 0 ? 0.1 : 0,
  };
}

function makeEligibleRepo(repoDir: string, slug: string, issueId: string): void {
  const featureDir = join(repoDir, 'features', slug);
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(
    join(repoDir, '.wavemill-config.json'),
    JSON.stringify({}),
  );
  writeFileSync(
    join(featureDir, '.routing-complete'),
    JSON.stringify({
      planner: 'gpt-5.5',
      coder: 'gpt-5.4',
      reviewer: 'claude-sonnet-4-6',
      codeDepth: 'deep',
      reviewMode: 'full',
      maxCostUsd: 6.5,
    }),
  );
  writeFileSync(
    join(featureDir, '.initial-route.json'),
    JSON.stringify({
      planner: 'gpt-5.5',
      coder: 'gpt-5.4',
      reviewer: 'claude-sonnet-4-6',
      codeDepth: 'deep',
      reviewMode: 'full',
    }),
  );
  mkdirSync(join(repoDir, '.wavemill', 'evals', 'artifacts', issueId), { recursive: true });
}

function makeChallengeIntent(pairId: string) {
  return buildChallengeExecutionIntent({
    pairId,
    challengeStage: 'implementation',
    primary: {
      model: 'claude-sonnet-4-5-20250929',
      planner: 'gpt-5.5',
      reviewer: 'claude-sonnet-4-6',
      planDepth: 'standard',
      codeDepth: 'standard',
      reviewMode: 'standard',
    },
    challenger: {
      model: 'gpt-5.4',
      planner: 'gpt-5.5',
      reviewer: 'claude-sonnet-4-6',
      planDepth: 'standard',
      codeDepth: 'deep',
      reviewMode: 'standard',
    },
  });
}

function writeWorkflowState(repoDir: string, tasks: Record<string, unknown>): void {
  mkdirSync(join(repoDir, '.wavemill', 'state'), { recursive: true });
  writeFileSync(
    join(repoDir, '.wavemill', 'state', 'workflow-state.json'),
    JSON.stringify({ tasks }),
  );
}

function enrichChallengeRecord(input: {
  repoDir: string;
  issueId: string;
  branchName: string;
  challengePairId: string;
}): EvalRecord {
  const record = makeRecord();
  if (input.branchName.endsWith('-challenger')) {
    record.modelId = 'gpt-5.4';
    record.modelVersion = 'gpt-5.4';
  }
  enrichPostCompletionRecord(record, {
    repoDir: input.repoDir,
    issueId: input.issueId,
    branchName: input.branchName,
    challengePairId: input.challengePairId,
    worktreePath: input.repoDir,
    agentType: 'codex',
    originalPrompt: 'Challenge eval',
    prDiff: 'diff',
    record,
    interventionRecords: [],
  });
  return record;
}

function makeContextUpdateRepo(repoDir: string, slug: string, issueId: string): void {
  makeEligibleRepo(repoDir, slug, issueId);
  writeFileSync(join(repoDir, '.wavemill', 'project-context.md'), '# Project Context\n');
  mkdirSync(join(repoDir, '.wavemill', 'context'), { recursive: true });
}

function readWarningLines(repoDir: string): Array<Record<string, unknown>> {
  const warningPath = join(repoDir, '.wavemill', 'evals', 'eval-context-update-warnings.jsonl');
  if (!existsSync(warningPath)) {
    return [];
  }
  return readFileSync(warningPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function listJudgeFailureArtifacts(repoDir: string, issueId: string): string[] {
  const artifactDir = join(repoDir, '.wavemill', 'evals', 'artifacts', issueId);
  if (!existsSync(artifactDir)) {
    return [];
  }
  return readdirSync(artifactDir)
    .filter((name) => name.startsWith('judge-json-failure-'))
    .map((name) => join(artifactDir, name));
}

function timeoutError(message: string): Error {
  const error = new Error(message);
  error.name = 'TimeoutError';
  return error;
}

function stubBaseEvalDeps(executionModel = 'gpt-5.4'): void {
  postCompletionHookDeps.gatherEvalContext = () => ({
    taskPrompt: 'Persist outcomes in post-completion evals',
    prDiff: '+++ shared/lib/post-completion-hook.ts',
    prUrl: 'https://example.test/pr/1550',
    issueData: null,
  });
  postCompletionHookDeps.gatherStageArtifacts = () => ({
    taskPacket: undefined,
    planContent: undefined,
    selfReviewSummary: undefined,
    routingDecision: undefined,
    phaseDurations: {
      planning: 120,
      coding: 480,
      review: 60,
      total: 660,
    },
    executionModel,
  });
  postCompletionHookDeps.detectAndFormatInterventions = () => ({
    meta: [],
    records: [],
    text: 'No interventions.',
    totalCount: 0,
    summary: makeInterventionSummary(0),
  });
  postCompletionHookDeps.runEvalAnalysis = async () => ({
    difficultyData: null,
    taskContextData: null,
    repoContextData: null,
  });
  postCompletionHookDeps.collectCiOutcome = () => ({ ran: true, passed: true, checks: [] });
  postCompletionHookDeps.collectTestsOutcome = () => ({ added: false });
  postCompletionHookDeps.collectStaticAnalysisOutcome = () => ({});
  postCompletionHookDeps.collectReviewOutcome = () => ({
    humanReviewRequired: false,
    rounds: 1,
    approvals: 1,
    changeRequests: 0,
  });
  postCompletionHookDeps.collectReworkOutcome = () => ({ agentIterations: 0 });
  postCompletionHookDeps.collectDeliveryOutcome = () => ({ prCreated: true, merged: false });
  postCompletionHookDeps.evaluateTask = async (input, outcomes) => ({
    ...(() => {
      const timeSeconds =
        Object.prototype.hasOwnProperty.call(input, 'timeSeconds')
          ? (input as { timeSeconds?: number | null }).timeSeconds
          : makeRecord().timeSeconds;
      return {
        ...makeRecord(),
        timeSeconds,
        modelId: '',
        modelVersion: '',
        issueId: input.issueId,
        workflowCost: 1.5,
        workflowTokenUsage: {},
        constraints: { maxCostUsd: 6.5 },
        routingDecision: undefined,
        outcomes,
      };
    })(),
  });
  postCompletionHookDeps.getCurrentOperatingMode = () => 'normal';
  postCompletionHookDeps.getEvalContextUpdatesConfig = () => ({
    enabled: true,
    timeoutSeconds: 60,
    maxRetries: 0,
  });
}

async function withMockedPostCompletionDeps(fn: () => Promise<void> | void): Promise<void> {
  const evalContextGatherer = await import('./eval-context-gatherer.ts');
  const shellUtils = await import('./shell-utils.ts');
  const interventionDetector = await import('./intervention-detector.ts');
  const evalAnalysis = await import('./eval-analysis.ts');
  const evalModule = await import('./eval.ts');
  const evalPersistence = await import('./eval-persistence.ts');
  const outcomeCollectors = await import('./outcome-collectors.ts');

  try {
    await fn();
  } finally {
    postCompletionHookDeps.gatherEvalContext = evalContextGatherer.gatherEvalContext;
    postCompletionHookDeps.gatherStageArtifacts = evalContextGatherer.gatherStageArtifacts;
    postCompletionHookDeps.execShellCommand = shellUtils.execShellCommand;
    postCompletionHookDeps.detectAndFormatInterventions = interventionDetector.detectAndFormatInterventions;
    postCompletionHookDeps.runEvalAnalysis = evalAnalysis.runEvalAnalysis;
    postCompletionHookDeps.evaluateTask = evalModule.evaluateTask;
    postCompletionHookDeps.buildUnscoredEvalRecord = evalModule.buildUnscoredEvalRecord;
    postCompletionHookDeps.appendEvalRecord = evalPersistence.appendEvalRecord;
    postCompletionHookDeps.collectCiOutcome = outcomeCollectors.collectCiOutcome;
    postCompletionHookDeps.collectTestsOutcome = outcomeCollectors.collectTestsOutcome;
    postCompletionHookDeps.collectStaticAnalysisOutcome = outcomeCollectors.collectStaticAnalysisOutcome;
    postCompletionHookDeps.collectReviewOutcome = outcomeCollectors.collectReviewOutcome;
    postCompletionHookDeps.collectReworkOutcome = outcomeCollectors.collectReworkOutcome;
    postCompletionHookDeps.collectDeliveryOutcome = outcomeCollectors.collectDeliveryOutcome;
    postCompletionHookDeps.getEvalContextUpdatesConfig = defaultPostCompletionHookDeps.getEvalContextUpdatesConfig;
    postCompletionHookDeps.getCurrentOperatingMode = defaultPostCompletionHookDeps.getCurrentOperatingMode;
    postCompletionHookDeps.triggerHokusaiSubmission = defaultPostCompletionHookDeps.triggerHokusaiSubmission;
    postCompletionHookDeps.runHarnessRetentionReplay = defaultPostCompletionHookDeps.runHarnessRetentionReplay;
    postCompletionHookDeps.runContextUpdateWork = defaultPostCompletionHookDeps.runContextUpdateWork;
    postCompletionHookDeps.appendContextUpdateWarning = defaultPostCompletionHookDeps.appendContextUpdateWarning;
  }
}

console.log('\n--- post-completion-hook Tests ---\n');

await test('enrichPostCompletionRecord attaches taskDescriptor for persisted records', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-hook-'));
  const featureDir = join(repoDir, 'features', 'enrich-task');
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(
    join(repoDir, '.wavemill-config.json'),
    JSON.stringify({}),
  );
  clearConfigCache(repoDir);
  writeFileSync(
    join(featureDir, '.routing-complete'),
    JSON.stringify({
      planner: 'claude-opus-4-6',
      coder: 'gpt-5.3-codex',
      reviewer: 'claude-sonnet-4-5-20250929',
      codeDepth: 'deep',
      reviewMode: 'full',
      maxCostUsd: 6.5,
    }),
  );
  writeFileSync(
    join(featureDir, '.initial-route.json'),
    JSON.stringify({
      planner: 'claude-opus-4-6',
      coder: 'gpt-5.3-codex',
      reviewer: 'claude-sonnet-4-5-20250929',
      codeDepth: 'deep',
      reviewMode: 'full',
    }),
  );

  try {
    const record = makeRecord();
    enrichPostCompletionRecord(record, {
      repoDir,
      issueId: 'HOK-1123',
      branchName: 'task/enrich-task',
      worktreePath: repoDir,
      agentType: 'codex',
      challengePairId: 'pair-1',
      originalPrompt: 'Add backend tests for auth and tighten review coverage',
      prDiff: '+++ tests/auth.test.ts\n+++ src/auth.ts',
      record,
      difficultyData: {
        difficultyBand: 'medium',
        difficultySignals: {
          locTouched: 140,
          filesTouched: 3,
        },
        stratum: 'ts_express_med',
      },
      taskContextData: {
        taskType: 'test',
        changeKind: 'modify_existing',
        complexity: 'm',
      },
      repoContextData: {
        repoId: 'repo',
        repoVisibility: 'private',
        primaryLanguage: 'TypeScript',
        languages: { TypeScript: 100 },
        frameworks: ['Express'],
        repoSize: { fileCount: 50, loc: 25_000, dependencyCount: 12 },
      },
      costOutcome: {
        status: 'success',
        totalCostUsd: 4.25,
        models: {
          'gpt-5.3-codex': {
            inputTokens: 1000,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            outputTokens: 500,
            costUsd: 4.25,
          },
        },
        sessionCount: 1,
        turnCount: 2,
        pricingUsed: {},
      },
      interventionRecords: [
        {
          timestamp: '2026-04-06T12:05:00.000Z',
          type: 'clarification',
          severity: 'low',
          note: 'Asked for one clarification',
        },
      ],
      routingDecision: {
        candidates: [
          { agentType: 'claude', modelId: 'claude-opus-4-6' },
          { agentType: 'codex', modelId: 'gpt-5.3-codex' },
        ],
        chosen: { agentType: 'codex', modelId: 'gpt-5.3-codex' },
        decisionPolicyVersion: 'baseline',
        decisionRationale: 'Selected coder model for implementation.',
      },
    });

    assert.ok(record.taskDescriptor);
    assert.equal(record.taskDescriptor?.stages.planner?.model, 'claude-opus-4-6');
    assert.equal(record.taskDescriptor?.stages.coder?.model, 'gpt-5.3-codex');
    assert.equal(record.taskDescriptor?.outcome?.total_cost_usd, 4.25);
    assert.equal(record.taskDescriptor?.outcome?.interventions, 1);
    assert.ok((record.taskDescriptor?.constraints.models_available.length || 0) > 0);
    assert.ok(record.taskDescriptor?.constraints.models_available.includes('gpt-5.5'));
    assert.ok(!record.taskDescriptor?.constraints.models_available.includes('gpt-5.3-codex'));
    assert.equal(record.workflowCostStatus, 'success');
    assert.equal(record.enrichmentDiagnostics, undefined);
  } finally {
    clearConfigCache(repoDir);
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('enrichPostCompletionRecord attaches direct planner challenge stage evidence', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-plan-stage-'));
  const featureDir = join(repoDir, 'features', 'planner-stage');
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, 'plan.md'), '# Plan\n- Update auth flow\n- Add tests\n');
  writeFileSync(
    join(featureDir, '.planning-result.json'),
    JSON.stringify({
      stage: 'planning',
      status: 'completed',
      startedAt: '2026-04-06T12:00:00.000Z',
      finishedAt: '2026-04-06T12:02:00.000Z',
      agent: 'codex',
      model: 'gpt-5.5',
      notes: 'Plan approved cleanly.',
    }),
  );

  try {
    const record = makeRecord();
    record.metadata = {
      ...record.metadata,
      planCritique: {
        component_boundaries: { score: 0.9, rationale: 'good' },
        invariant_coverage: { score: 0.8, rationale: 'good' },
        approach_soundness: { score: 0.85, rationale: 'good' },
        missed_patches: { score: 0.75, rationale: 'good' },
        overall: { score: 0.84, rationale: 'good' },
      },
    };
    enrichPostCompletionRecord(record, {
      repoDir,
      issueId: 'HOK-2374',
      branchName: 'task/planner-stage',
      worktreePath: repoDir,
      agentType: 'codex',
      challengePairId: 'pair-plan',
      challengeStage: 'plan',
      originalPrompt: 'Implement planner challenge evidence',
      prDiff: '+++ shared/lib/post-completion-hook.ts',
      record,
      difficultyData: null,
      taskContextData: null,
      repoContextData: null,
      costOutcome: null,
      interventionRecords: [],
      routingDecision: undefined,
      routing: undefined,
      routePrediction: undefined,
      executedPlanning: { agent: 'codex', model: 'gpt-5.5', status: 'completed', source: '.planning-result.json' },
      phaseDurations: { planning: 120, total: 120 },
      planContent: '# Plan\n- Update auth flow\n- Add tests\n',
      selfReviewSummary: undefined,
    });

    assert.equal(record.challengeStageEval?.stage, 'plan');
    assert.equal(record.challengeStageEval?.provenance, 'direct');
    assert.match(record.challengeStageEval?.summary || '', /Direct planning evidence/);
    assert.ok(record.challengeStageEval?.evidence.some((item) => item.label === 'plan_text'));
    assert.ok(record.challengeStageEval?.evidence.some((item) => item.label === 'planning_result'));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('runPostCompletionEval passes and persists phase durations', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-hook-phase-'));
  let capturedEvalInput: Record<string, unknown> | undefined;
  let capturedInterventionInput: Record<string, unknown> | undefined;
  let persistedRecord: EvalRecord | undefined;

  try {
    await withMockedPostCompletionDeps(async () => {
      stubBaseEvalDeps();
      postCompletionHookDeps.detectAndFormatInterventions = (input) => {
        capturedInterventionInput = input as Record<string, unknown>;
        return {
          meta: [],
          records: [],
          text: 'No interventions.',
          totalCount: 0,
          summary: makeInterventionSummary(0),
        };
      };
      postCompletionHookDeps.evaluateTask = async (input, outcomes) => {
        capturedEvalInput = input as Record<string, unknown>;
        const timeSeconds =
          Object.prototype.hasOwnProperty.call(input, 'timeSeconds')
            ? (input as { timeSeconds?: number | null }).timeSeconds
            : makeRecord().timeSeconds;
        return {
          ...makeRecord(),
          timeSeconds,
          outcomes,
        };
      };
      postCompletionHookDeps.appendEvalRecord = (record) => {
        persistedRecord = record;
      };
      postCompletionHookDeps.runContextUpdateWork = async () => {};

      const ok = await runPostCompletionEval({
        issueId: 'HOK-1930',
        prNumber: '1930',
        prUrl: 'https://example.test/pr/1930',
        workflowType: 'mill',
        repoDir,
        branchName: 'task/accurate-wall-clock',
        worktreePath: repoDir,
        agentType: 'codex',
      });

      assert.equal(ok, true);
    });

    assert.equal(capturedEvalInput?.timeSeconds, 660);
    assert.equal(capturedInterventionInput?.issueId, 'HOK-1930');
    assert.equal(capturedInterventionInput?.worktreePath, repoDir);
    assert.deepEqual(persistedRecord?.phaseDurationsSeconds, {
      planning: 120,
      coding: 480,
      review: 60,
      total: 660,
    });
    assert.equal(persistedRecord?.timeSeconds, 660);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('runPostCompletionEval persists unscored record when PR diff is unavailable', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-hook-diff-'));
  let persistedRecord: EvalRecord | undefined;
  let judgeCalled = false;

  try {
    await withMockedPostCompletionDeps(async () => {
      stubBaseEvalDeps();
      postCompletionHookDeps.gatherEvalContext = () => ({
        taskPrompt: 'Persist outcomes in post-completion evals',
        prDiff: '',
        prUrl: 'https://example.test/pr/1550',
        prDiffAvailability: {
          available: false,
          reason: 'gh_too_large',
          detail: 'HTTP 406: diff exceeded maximum number of files',
          attempts: ['gh pr diff: HTTP 406', 'local-git: fetch failed'],
        },
        issueData: null,
      });
      postCompletionHookDeps.evaluateTask = async () => {
        judgeCalled = true;
        return makeRecord();
      };
      postCompletionHookDeps.appendEvalRecord = (record) => {
        persistedRecord = record;
      };
      postCompletionHookDeps.runContextUpdateWork = async () => {};

      const ok = await runPostCompletionEval({
        issueId: 'HOK-1550',
        prNumber: '1550',
        prUrl: 'https://example.test/pr/1550',
        workflowType: 'mill',
        repoDir,
        branchName: 'task/diff-unavailable',
        worktreePath: repoDir,
        agentType: 'codex',
      });

      assert.equal(ok, true);
    });

    assert.equal(judgeCalled, false);
    assert.equal(persistedRecord?.failureReason, 'pr_diff_unavailable');
    assert.equal(persistedRecord?.score, 0);
    assert.equal(persistedRecord?.trainingEligible, false);
    assert.equal((persistedRecord?.metadata?.prDiffUnavailable as { reason?: string } | undefined)?.reason, 'gh_too_large');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('runPostCompletionEval persists direct reviewer challenge stage evidence', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-review-stage-'));
  const featureDir = join(repoDir, 'features', 'review-stage');
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(
    join(featureDir, '.review-result.json'),
    JSON.stringify({
      stage: 'review',
      status: 'completed',
      startedAt: '2026-04-06T12:03:00.000Z',
      finishedAt: '2026-04-06T12:05:00.000Z',
      agent: 'codex',
      model: 'gpt-5.5',
      notes: 'Review blocked one issue and cleared the rest.',
      artifacts: {
        type: 'review',
        findingsCount: 3,
        blockingIssues: 1,
        // Complete per-iteration evidence and a fully pinned executed
        // identity are required for direct provenance (HOK-2969); a
        // review-result artifact alone is no longer sufficient.
        reviewIterations: [
          {
            iteration: 1,
            recordedAt: '2026-04-06T12:04:00.000Z',
            verdict: 'not_ready',
            findings: [
              {
                location: 'src/api/users.ts:45',
                category: 'security',
                severity: 'blocker',
                description: 'Unsanitized input reaches the query builder.',
                disposition: 'open',
              },
            ],
          },
        ],
        reviewExecutedIdentity: {
          orchestrator: {
            role: 'review_orchestrator',
            requestedModel: 'gpt-5.5',
            resolvedModel: 'gpt-5.5',
            agent: 'codex',
            source: 'route',
            pinned: true,
          },
          substantiveAnalysis: {
            role: 'substantive_analysis',
            requestedModel: 'gpt-5.5',
            resolvedModel: 'gpt-5.5',
            agent: 'native-openai',
            source: 'artifact',
            pinned: true,
          },
          remediation: null,
        },
      },
    }),
  );
  let persistedRecord: EvalRecord | undefined;

  try {
    await withMockedPostCompletionDeps(async () => {
      stubBaseEvalDeps();
      postCompletionHookDeps.gatherStageArtifacts = () => ({
        taskPacket: undefined,
        planContent: undefined,
        selfReviewSummary: 'Self-Review Summary (resolved)\n- Iterations: 1\n  - Iteration 1: not_ready (1 blockers, 2 warnings)',
        routingDecision: undefined,
        phaseDurations: {
          planning: 120,
          coding: 480,
          review: 120,
          total: 720,
        },
        executionModel: 'gpt-5.5',
      });
      postCompletionHookDeps.appendEvalRecord = (record) => {
        persistedRecord = record;
      };
      postCompletionHookDeps.runContextUpdateWork = async () => {};

      const ok = await runPostCompletionEval({
        issueId: 'HOK-2374',
        prNumber: '2374',
        prUrl: 'https://example.test/pr/2374',
        workflowType: 'mill',
        repoDir,
        branchName: 'task/review-stage',
        worktreePath: repoDir,
        agentType: 'codex',
        challengePairId: 'pair-review',
        challengeStage: 'review',
      });

      assert.equal(ok, true);
    });

    assert.equal(persistedRecord?.challengeStageEval?.stage, 'review');
    assert.equal(persistedRecord?.challengeStageEval?.provenance, 'direct');
    assert.ok(persistedRecord?.challengeStageEval?.evidence.some((item) => item.label === 'self_review_summary'));
    assert.ok(persistedRecord?.challengeStageEval?.evidence.some((item) => item.label === 'review_result'));
    assert.equal(persistedRecord?.reviewExecutedIdentity?.orchestrator.pinned, true);
    assert.equal(persistedRecord?.reviewExecutedIdentity?.substantiveAnalysis.resolvedModel, 'gpt-5.5');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('runPostCompletionEval falls back to inferred reviewer evidence when direct artifacts are missing', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-review-fallback-'));
  let persistedRecord: EvalRecord | undefined;

  try {
    await withMockedPostCompletionDeps(async () => {
      stubBaseEvalDeps();
      postCompletionHookDeps.gatherStageArtifacts = () => ({
        taskPacket: undefined,
        planContent: undefined,
        selfReviewSummary: undefined,
        routingDecision: undefined,
        phaseDurations: {
          planning: 120,
          coding: 480,
          review: 60,
          total: 660,
        },
        executionModel: 'gpt-5.5',
      });
      postCompletionHookDeps.appendEvalRecord = (record) => {
        persistedRecord = record;
      };
      postCompletionHookDeps.runContextUpdateWork = async () => {};

      const ok = await runPostCompletionEval({
        issueId: 'HOK-2374',
        prNumber: '2375',
        prUrl: 'https://example.test/pr/2375',
        workflowType: 'mill',
        repoDir,
        branchName: 'task/review-fallback',
        worktreePath: repoDir,
        agentType: 'codex',
        challengePairId: 'pair-review-fallback',
        challengeStage: 'review',
      });

      assert.equal(ok, true);
    });

    assert.equal(persistedRecord?.challengeStageEval?.stage, 'review');
    assert.equal(persistedRecord?.challengeStageEval?.provenance, 'inferred');
    assert.match(persistedRecord?.challengeStageEval?.fallbackReason || '', /self-review summary/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('runPostCompletionEval leaves challenge stage evidence unset for non-challenge runs', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-no-stage-evidence-'));
  let persistedRecord: EvalRecord | undefined;

  try {
    await withMockedPostCompletionDeps(async () => {
      stubBaseEvalDeps();
      postCompletionHookDeps.appendEvalRecord = (record) => {
        persistedRecord = record;
      };
      postCompletionHookDeps.runContextUpdateWork = async () => {};

      const ok = await runPostCompletionEval({
        issueId: 'HOK-2374',
        prNumber: '2376',
        prUrl: 'https://example.test/pr/2376',
        workflowType: 'mill',
        repoDir,
        branchName: 'task/non-challenge',
        worktreePath: repoDir,
        agentType: 'codex',
      });

      assert.equal(ok, true);
    });

    assert.equal(persistedRecord?.challengeStageEval, undefined);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('enrichPostCompletionRecord uses canonical challengeRole and challengeExecutionIntent', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-canonical-challenge-'));
  const intent = makeChallengeIntent('pair-2598');
  try {
    writeWorkflowState(repoDir, {
      'HOK-2598': {
        challengeRole: 'primary',
        challengeExecutionIntent: intent,
      },
    });

    const record = enrichChallengeRecord({
      repoDir,
      issueId: 'HOK-2598',
      branchName: 'task/restore-challenge-eval-persistence-challenger',
      challengePairId: 'pair-2598',
    });

    assert.equal(record.challengeSide, 'primary');
    assert.equal(record.challengeIntent?.pairId, 'pair-2598');
    assert.equal(record.challengeExecutionRoute?.coder, 'claude-sonnet-4-5-20250929');
    assert.equal(record.invalidChallenge, true);
    assert.equal(record.challengeDivergenceReason, 'state_vs_derived_side_mismatch');
    assert.equal(record.trainingEligible, false);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('enrichPostCompletionRecord recognizes -challenger branch fallback when state is absent', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-dash-challenger-'));
  try {
    const record = enrichChallengeRecord({
      repoDir,
      issueId: 'HOK-2598-challenger',
      branchName: 'task/restore-challenge-eval-persistence-challenger',
      challengePairId: 'HOK-2598',
    });

    // Side derivation still works from the branch name alone...
    assert.equal(record.challengeSide, 'challenger');
    assert.equal(record.challengeDivergenceReason, 'missing_challenge_intent');
    // ...but with no persisted intent there is nothing to attest the varied
    // stage against, so the record must not count as training evidence.
    // Absence used to read as success, which let an arm whose model had been
    // replaced by rerouting pass as clean data.
    assert.equal(record.invalidChallenge, true);
    assert.equal(record.trainingEligible, false);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('enrichPostCompletionRecord persists challenger side from canonical state on -challenger branch', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-canonical-dash-challenger-'));
  const intent = makeChallengeIntent('pair-2598');
  try {
    writeWorkflowState(repoDir, {
      'HOK-2598-challenger': {
        challengeRole: 'challenger',
        challengeExecutionIntent: intent,
      },
    });

    const record = enrichChallengeRecord({
      repoDir,
      issueId: 'HOK-2598-challenger',
      branchName: 'task/restore-challenge-eval-persistence-challenger',
      challengePairId: 'pair-2598',
    });

    assert.equal(record.challengeSide, 'challenger');
    assert.equal(record.challengeIntent?.pairId, 'pair-2598');
    assert.equal(record.challengeExecutionRoute?.coder, 'gpt-5.4');
    assert.equal(record.invalidChallenge, undefined);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('enrichPostCompletionRecord recognizes legacy _c fallback when state is absent', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-legacy-challenger-'));
  try {
    const record = enrichChallengeRecord({
      repoDir,
      issueId: 'HOK-2598_c',
      branchName: 'task/restore-challenge-eval-persistence_c',
      challengePairId: 'HOK-2598',
    });

    assert.equal(record.challengeSide, 'challenger');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('enrichPostCompletionRecord falls back safely when workflow state is malformed', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-malformed-state-'));
  try {
    mkdirSync(join(repoDir, '.wavemill', 'state'), { recursive: true });
    writeFileSync(join(repoDir, '.wavemill', 'state', 'workflow-state.json'), '{bad json');

    const record = enrichChallengeRecord({
      repoDir,
      issueId: 'HOK-2598-challenger',
      branchName: 'task/restore-challenge-eval-persistence-challenger',
      challengePairId: 'HOK-2598',
    });

    assert.equal(record.challengeSide, 'challenger');
    assert.equal(record.challengeIntent, undefined);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('runPostCompletionEval preserves null duration when phase totals are unavailable', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-hook-null-'));
  let capturedEvalInput: Record<string, unknown> | undefined;
  let persistedRecord: EvalRecord | undefined;

  try {
    await withMockedPostCompletionDeps(async () => {
      stubBaseEvalDeps();
      postCompletionHookDeps.gatherStageArtifacts = () => ({
        taskPacket: undefined,
        planContent: undefined,
        selfReviewSummary: undefined,
        routingDecision: undefined,
        executionModel: 'gpt-5.4',
      });
      postCompletionHookDeps.evaluateTask = async (input, outcomes) => {
        capturedEvalInput = input as Record<string, unknown>;
        const timeSeconds =
          Object.prototype.hasOwnProperty.call(input, 'timeSeconds')
            ? (input as { timeSeconds?: number | null }).timeSeconds
            : makeRecord().timeSeconds;
        return {
          ...makeRecord(),
          timeSeconds,
          outcomes,
        };
      };
      postCompletionHookDeps.appendEvalRecord = (record) => {
        persistedRecord = record;
      };
      postCompletionHookDeps.runContextUpdateWork = async () => {};

      const ok = await runPostCompletionEval({
        issueId: 'HOK-1930',
        prNumber: '1930',
        prUrl: 'https://example.test/pr/1930',
        workflowType: 'mill',
        repoDir,
        branchName: 'task/accurate-wall-clock',
        worktreePath: repoDir,
        agentType: 'codex',
      });

      assert.equal(ok, true);
    });

    assert.equal(capturedEvalInput?.timeSeconds, null);
    assert.equal(persistedRecord?.timeSeconds, null);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('runPostCompletionEval returns false when no issue or PR is provided', async () => {
  const persisted = await runPostCompletionEval({
    workflowType: 'mill',
    repoDir: process.cwd(),
  });

  assert.equal(persisted, false);
});

await test('collectPostCompletionOutcomes returns stable defaults without PR or branch', () => {
  const outcomes = collectPostCompletionOutcomes({
    repoDir: process.cwd(),
    interventionSummary: makeInterventionSummary(1),
  });

  assert.equal(outcomes.success, false);
  assert.equal(outcomes.ci, undefined);
  assert.equal(outcomes.tests, undefined);
  assert.equal(outcomes.staticAnalysis, undefined);
  assert.deepEqual(outcomes.review, {
    humanReviewRequired: true,
    rounds: 0,
    approvals: 0,
    changeRequests: 0,
  });
  assert.deepEqual(outcomes.rework, { agentIterations: 0 });
  assert.deepEqual(outcomes.delivery, { prCreated: false, merged: false });
});

await test('runPostCompletionEval persists outcomes and clears missing_outcome eligibility failure', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-persist-'));
  makeEligibleRepo(repoDir, 'persist-outcomes', 'HOK-1550');
  clearConfigCache(repoDir);

  try {
    await withMockedPostCompletionDeps(async () => {
      postCompletionHookDeps.gatherEvalContext = () => ({
        taskPrompt: 'Persist outcomes in post-completion evals',
        prDiff: '+++ shared/lib/post-completion-hook.ts',
        prUrl: 'https://example.test/pr/1550',
        issueData: null,
      });
      postCompletionHookDeps.gatherStageArtifacts = () => ({
        taskPacket: undefined,
        planContent: undefined,
        selfReviewSummary: undefined,
        routingDecision: {
          candidates: [{ agentType: 'codex', modelId: 'gpt-5.4' }],
          chosen: { agentType: 'codex', modelId: 'gpt-5.4' },
          decisionPolicyVersion: 'baseline',
          decisionRationale: 'selected coder',
        },
        executionModel: 'gpt-5.4',
      });
      postCompletionHookDeps.detectAndFormatInterventions = () => ({
        meta: [],
        records: [],
        text: 'No interventions.',
        totalCount: 0,
        summary: makeInterventionSummary(0),
      });
      postCompletionHookDeps.runEvalAnalysis = async () => ({
        difficultyData: {
          difficultyBand: 'medium',
          difficultySignals: { locTouched: 20, filesTouched: 1 },
          stratum: 'ts_node_med',
        },
        taskContextData: {
          taskType: 'feature',
          changeKind: 'modify_existing',
          complexity: 'm',
        },
        repoContextData: {
          repoId: 'repo',
          repoVisibility: 'private',
          primaryLanguage: 'TypeScript',
          languages: { TypeScript: 100 },
          frameworks: ['Node'],
          repoSize: { fileCount: 10, loc: 1000, dependencyCount: 3 },
        },
      });
      postCompletionHookDeps.collectCiOutcome = () => ({ ran: true, passed: true, checks: [] });
      postCompletionHookDeps.collectTestsOutcome = () => ({ added: true, passRate: 1 });
      postCompletionHookDeps.collectStaticAnalysisOutcome = () => ({ lintDelta: 0, typecheckPassed: true });
      postCompletionHookDeps.collectReviewOutcome = () => ({
        humanReviewRequired: false,
        rounds: 1,
        approvals: 1,
        changeRequests: 0,
      });
      postCompletionHookDeps.collectReworkOutcome = () => ({ agentIterations: 2 });
      postCompletionHookDeps.collectDeliveryOutcome = () => ({ prCreated: true, merged: false });
      postCompletionHookDeps.evaluateTask = async (_input, outcomes) => ({
        ...makeRecord(),
        modelId: '',
        modelVersion: '',
        workflowCost: 2.25,
        workflowTokenUsage: {},
        constraints: { maxCostUsd: 6.5 },
        routingDecision: {
          candidates: [{ agentType: 'codex', modelId: 'gpt-5.4' }],
          chosen: { agentType: 'codex', modelId: 'gpt-5.4' },
          decisionPolicyVersion: 'baseline',
          decisionRationale: 'selected coder',
        },
        outcomes,
      });

      const persisted = await runPostCompletionEval({
        issueId: 'HOK-1550',
        prNumber: '1550',
        workflowType: 'mill',
        repoDir,
        branchName: 'task/persist-outcomes',
        worktreePath: repoDir,
        agentType: 'codex',
      });

      assert.equal(persisted, true);
    });

    const evalsPath = join(repoDir, '.wavemill', 'evals', 'evals.jsonl');
    const persistedLines = readFileSync(evalsPath, 'utf8').trim().split('\n');
    const record = JSON.parse(persistedLines.at(-1) || '{}');

    assert.ok(record.outcomes);
    assert.equal(record.outcomes.success, finalizeEvalSuccess(record));
    assert.deepEqual(record.outcomes.ci, { ran: true, passed: true, checks: [] });
    assert.deepEqual(record.outcomes.tests, { added: true, passRate: 1 });
    assert.ok(!record.eligibilityErrors.includes('missing_outcome'));
  } finally {
    clearConfigCache(repoDir);
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('runPostCompletionEval degrades to default outcomes when a collector throws', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-fallback-'));
  makeEligibleRepo(repoDir, 'collector-fallback', 'HOK-1551');
  clearConfigCache(repoDir);

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown, ...args: unknown[]) => {
    warnings.push([message, ...args].map(String).join(' '));
  };

  try {
    await withMockedPostCompletionDeps(async () => {
      postCompletionHookDeps.gatherEvalContext = () => ({
        taskPrompt: 'Persist outcomes in post-completion evals',
        prDiff: '+++ shared/lib/post-completion-hook.ts',
        prUrl: 'https://example.test/pr/1551',
        issueData: null,
      });
      postCompletionHookDeps.gatherStageArtifacts = () => ({
        taskPacket: undefined,
        planContent: undefined,
        selfReviewSummary: undefined,
        routingDecision: undefined,
        executionModel: 'gpt-5.4',
      });
      postCompletionHookDeps.detectAndFormatInterventions = () => ({
        meta: [],
        records: [],
        text: 'No interventions.',
        totalCount: 0,
        summary: makeInterventionSummary(1),
      });
      postCompletionHookDeps.runEvalAnalysis = async () => ({
        difficultyData: null,
        taskContextData: null,
        repoContextData: null,
      });
      postCompletionHookDeps.collectCiOutcome = () => {
        throw new Error('ci exploded');
      };
      postCompletionHookDeps.collectTestsOutcome = () => ({ added: false });
      postCompletionHookDeps.collectStaticAnalysisOutcome = () => ({});
      postCompletionHookDeps.collectReviewOutcome = () => ({
        humanReviewRequired: true,
        rounds: 0,
        approvals: 0,
        changeRequests: 0,
      });
      postCompletionHookDeps.collectReworkOutcome = () => ({ agentIterations: 0 });
      postCompletionHookDeps.collectDeliveryOutcome = () => ({ prCreated: true, merged: false });
      postCompletionHookDeps.evaluateTask = async (_input, outcomes) => ({
        ...makeRecord(),
        workflowCost: 1.5,
        workflowTokenUsage: {},
        constraints: { maxCostUsd: 6.5 },
        routingDecision: undefined,
        outcomes,
      });

      const persisted = await runPostCompletionEval({
        issueId: 'HOK-1551',
        prNumber: '1551',
        workflowType: 'mill',
        repoDir,
        branchName: 'task/collector-fallback',
        worktreePath: repoDir,
        agentType: 'codex',
      });

      assert.equal(persisted, true);
    });

    const evalsPath = join(repoDir, '.wavemill', 'evals', 'evals.jsonl');
    const persistedLines = readFileSync(evalsPath, 'utf8').trim().split('\n');
    const record = JSON.parse(persistedLines.at(-1) || '{}');

    assert.deepEqual(record.outcomes.ci, { ran: false, passed: true, checks: [] });
    assert.ok(warnings.some((entry) => entry.includes('failed to collect ci outcome - ci exploded')));
  } finally {
    console.warn = originalWarn;
    clearConfigCache(repoDir);
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('runPostCompletionEval keeps eval persisted when context updates time out', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-timeout-'));
  makeContextUpdateRepo(repoDir, 'context-timeout', 'HOK-1577');
  clearConfigCache(repoDir);

  try {
    await withMockedPostCompletionDeps(async () => {
      stubBaseEvalDeps();
      postCompletionHookDeps.getEvalContextUpdatesConfig = () => ({
        enabled: true,
        timeoutSeconds: 0.01,
        maxRetries: 0,
      });
      postCompletionHookDeps.runContextUpdateWork = async (_ctx, _prDiff, _issueContext, executionOptions) =>
        await new Promise<void>((_resolve, reject) => {
          executionOptions.signal?.addEventListener('abort', () => {
            reject(executionOptions.signal?.reason ?? timeoutError('aborted'));
          }, { once: true });
        });

      const persisted = await runPostCompletionEval({
        issueId: 'HOK-1577',
        prNumber: '1577',
        workflowType: 'mill',
        repoDir,
        branchName: 'task/context-timeout',
        worktreePath: repoDir,
        agentType: 'codex',
      });

      assert.equal(persisted, true);
    });

    const evalsPath = join(repoDir, '.wavemill', 'evals', 'evals.jsonl');
    assert.ok(existsSync(evalsPath));

    const warnings = readWarningLines(repoDir);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].reason, 'timeout');
    assert.equal(warnings[0].evalId, 'eval-hook-1');
    assert.equal(warnings[0].issueId, 'HOK-1577');
    assert.equal(warnings[0].retryCount, 0);
    assert.equal(typeof warnings[0].durationMs, 'number');
  } finally {
    clearConfigCache(repoDir);
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('runPostCompletionEval fires onPersisted before optional context updates begin timing out', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-on-persisted-'));
  makeContextUpdateRepo(repoDir, 'on-persisted', 'HOK-2048');
  clearConfigCache(repoDir);
  const events: string[] = [];

  try {
    await withMockedPostCompletionDeps(async () => {
      stubBaseEvalDeps();
      postCompletionHookDeps.getEvalContextUpdatesConfig = () => ({
        enabled: true,
        timeoutSeconds: 0.01,
        maxRetries: 0,
      });
      postCompletionHookDeps.appendEvalRecord = (record, options) => {
        events.push('persist');
        defaultPostCompletionHookDeps.appendEvalRecord(record, options);
      };
      postCompletionHookDeps.runContextUpdateWork = async (_ctx, _prDiff, _issueContext, executionOptions) => {
        events.push('context-start');
        return await new Promise<void>((_resolve, reject) => {
          executionOptions.signal?.addEventListener('abort', () => {
            events.push('context-abort');
            reject(executionOptions.signal?.reason ?? timeoutError('aborted'));
          }, { once: true });
        });
      };

      const persisted = await runPostCompletionEval({
        issueId: 'HOK-2048',
        prNumber: '2048',
        workflowType: 'mill',
        repoDir,
        branchName: 'task/on-persisted',
        worktreePath: repoDir,
        agentType: 'codex',
        onPersisted: () => {
          events.push('callback');
        },
      });

      assert.equal(persisted, true);
    });

    assert.deepEqual(events.slice(0, 3), ['persist', 'callback', 'context-start']);
    assert.ok(events.includes('context-abort'));
    assert.equal(readWarningLines(repoDir)[0]?.reason, 'timeout');
  } finally {
    clearConfigCache(repoDir);
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('runPostCompletionEval returns false when judge times out before persistence', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-judge-timeout-'));
  makeContextUpdateRepo(repoDir, 'judge-timeout', 'HOK-2028');
  clearConfigCache(repoDir);

  try {
    await withMockedPostCompletionDeps(async () => {
      stubBaseEvalDeps();
      postCompletionHookDeps.evaluateTask = async () => {
        throw timeoutError('judge timed out before persistence');
      };
      postCompletionHookDeps.runContextUpdateWork = async () => {
        throw new Error('should not reach context updates');
      };

      const persisted = await runPostCompletionEval({
        issueId: 'HOK-2028',
        prNumber: '2028',
        workflowType: 'mill',
        repoDir,
        branchName: 'task/judge-timeout',
        worktreePath: repoDir,
        agentType: 'codex',
      });

      assert.equal(persisted, false);
    });

    assert.equal(existsSync(join(repoDir, '.wavemill', 'evals', 'evals.jsonl')), false);
    assert.deepEqual(readWarningLines(repoDir), []);
  } finally {
    clearConfigCache(repoDir);
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('runPostCompletionEval persists locally recovered judge JSON', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-judge-json-recovered-'));
  makeContextUpdateRepo(repoDir, 'judge-json-recovered', 'HOK-2320');
  clearConfigCache(repoDir);

  try {
    await withMockedPostCompletionDeps(async () => {
      stubBaseEvalDeps();
      postCompletionHookDeps.evaluateTask = async (input, outcomes) =>
        evaluateTask(input, outcomes, {
          _callFn: async () => ({
            text: '{"score":0.6,"rationale":"Line one\nHe said "ship it" yesterday.","interventionFlags":[]}',
          }),
        });
      postCompletionHookDeps.runContextUpdateWork = async () => {};

      const persisted = await runPostCompletionEval({
        issueId: 'HOK-2320',
        prNumber: '2320',
        workflowType: 'mill',
        repoDir,
        branchName: 'task/judge-json-recovered',
        worktreePath: repoDir,
        agentType: 'codex',
      });

      assert.equal(persisted, true);
    });

    const evalsPath = join(repoDir, '.wavemill', 'evals', 'evals.jsonl');
    const persistedLines = readFileSync(evalsPath, 'utf8').trim().split('\n');
    const record = JSON.parse(persistedLines.at(-1) || '{}');

    assert.equal(record.score, 0.6);
    assert.equal(record.rationale, 'Line one\nHe said "ship it" yesterday.');
    assert.equal(record.metadata.judgeJsonRecovered, true);
  } finally {
    clearConfigCache(repoDir);
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('runPostCompletionEval writes durable artifact for unrecoverable judge JSON', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-judge-json-artifact-'));
  makeContextUpdateRepo(repoDir, 'judge-json-artifact', 'HOK-2320');
  clearConfigCache(repoDir);
  const warnings: string[] = [];
  const originalWarn = console.warn;

  try {
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    await withMockedPostCompletionDeps(async () => {
      stubBaseEvalDeps();
      postCompletionHookDeps.evaluateTask = async () => {
        throw new JudgeResponseRecoveryError(
          'Judge returned malformed JSON after bounded recovery attempts.',
          {
            rawText: '{"score":0.6,"rationale":"broken',
            parseError: 'Failed to parse JSON from LLM output',
            repairError: 'Unexpected end of JSON input',
          },
          {
            rawText: 'still not json',
            parseError: 'Failed to parse JSON from LLM output',
            repairError: 'No JSON object found in LLM output.',
          },
          'still not json',
        );
      };

      const persisted = await runPostCompletionEval({
        issueId: 'HOK-2320',
        prNumber: '2320',
        workflowType: 'mill',
        repoDir,
        branchName: 'task/judge-json-artifact',
        worktreePath: repoDir,
        agentType: 'codex',
      });

      assert.equal(persisted, false);
    });

    assert.equal(existsSync(join(repoDir, '.wavemill', 'evals', 'evals.jsonl')), false);
    const artifacts = listJudgeFailureArtifacts(repoDir, 'HOK-2320');
    assert.equal(artifacts.length, 1);
    const artifactBody = readFileSync(artifacts[0], 'utf8');
    assert.match(artifactBody, /first-attempt-raw/);
    assert.match(artifactBody, /still not json/);
    assert.ok(warnings.some((line) => line.includes('raw judge output saved to')));
  } finally {
    console.warn = originalWarn;
    clearConfigCache(repoDir);
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('runPostCompletionEval aborts underlying context update work when timeout elapses', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-abort-'));
  makeContextUpdateRepo(repoDir, 'context-abort', 'HOK-2033');
  clearConfigCache(repoDir);
  let abortObserved = false;
  let abortReason = '';

  try {
    await withMockedPostCompletionDeps(async () => {
      stubBaseEvalDeps();
      postCompletionHookDeps.getEvalContextUpdatesConfig = () => ({
        enabled: true,
        timeoutSeconds: 0.01,
        maxRetries: 0,
      });
      postCompletionHookDeps.runContextUpdateWork = async (_ctx, _prDiff, _issueContext, executionOptions) => {
        return await new Promise<void>((_resolve, reject) => {
          executionOptions.signal?.addEventListener('abort', () => {
            abortObserved = executionOptions.signal?.aborted === true;
            abortReason = String(executionOptions.signal?.reason instanceof Error
              ? executionOptions.signal.reason.message
              : executionOptions.signal?.reason ?? '');
            reject(executionOptions.signal?.reason ?? timeoutError('aborted'));
          }, { once: true });
        });
      };

      const persisted = await runPostCompletionEval({
        issueId: 'HOK-2033',
        prNumber: '2033',
        workflowType: 'mill',
        repoDir,
        branchName: 'task/context-abort',
        worktreePath: repoDir,
        agentType: 'codex',
      });

      assert.equal(persisted, true);
    });

    assert.equal(abortObserved, true);
    assert.match(abortReason, /timed out/);
    assert.equal(readWarningLines(repoDir)[0]?.reason, 'timeout');
  } finally {
    clearConfigCache(repoDir);
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('runPostCompletionEval enqueues Hokusai after persistence before context updates', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-hokusai-enqueue-'));
  makeContextUpdateRepo(repoDir, 'hokusai-enqueue', 'HOK-1583');
  clearConfigCache(repoDir);
  const calls: string[] = [];
  const logs: string[] = [];
  const originalLog = console.log;

  try {
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
    await withMockedPostCompletionDeps(async () => {
      stubBaseEvalDeps();
      postCompletionHookDeps.appendEvalRecord = (record, options) => {
        calls.push('persist');
        defaultPostCompletionHookDeps.appendEvalRecord(record, options);
      };
      postCompletionHookDeps.triggerHokusaiSubmission = async (record, options) => {
        calls.push(`hokusai:${record.issueId}:${options.repoDir}`);
        return { status: 'enqueued', entryId: 'entry-1', drainStarted: true };
      };
      postCompletionHookDeps.runContextUpdateWork = async () => {
        calls.push('context');
      };

      const persisted = await runPostCompletionEval({
        issueId: 'HOK-1583',
        prNumber: '1583',
        workflowType: 'mill',
        repoDir,
        branchName: 'task/hokusai-enqueue',
        worktreePath: repoDir,
        agentType: 'codex',
      });

      assert.equal(persisted, true);
    });

    assert.deepEqual(calls, [
      'persist',
      `hokusai:HOK-1583:${repoDir}`,
      'context',
    ]);
    assert.ok(logs.some((line) => line.includes('Post-completion eval: Hokusai submission enqueued entry=entry-1 drain=started')));
  } finally {
    console.log = originalLog;
    clearConfigCache(repoDir);
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('runPostCompletionEval skips context updates when enforced harness retention fails', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-harness-retention-'));
  makeContextUpdateRepo(repoDir, 'harness-retention', 'HOK-2844');
  clearConfigCache(repoDir);
  const calls: string[] = [];

  try {
    await withMockedPostCompletionDeps(async () => {
      stubBaseEvalDeps();
      postCompletionHookDeps.appendEvalRecord = (record, options) => {
        calls.push('persist');
        defaultPostCompletionHookDeps.appendEvalRecord(record, options);
      };
      postCompletionHookDeps.triggerHokusaiSubmission = async () => {
        calls.push('hokusai');
        return { status: 'skipped', reason: 'disabled' };
      };
      postCompletionHookDeps.runHarnessRetentionReplay = async () => ({
        schemaVersion: 1,
        reportId: 'retention-report',
        suiteVersion: 'harness-retention-v1',
        generatedAt: '2026-08-21T00:00:00.000Z',
        mode: 'enforce',
        tolerance: 1,
        verdict: 'fail',
        baselineHarnessId: 'baseline',
        candidateHarnessId: 'candidate',
        D: 2,
        totals: { cases: 2, excluded: 0, malformed: 0, errors: 0 },
        perSurface: {
          routing: { cases: 2, D: 2, baselineFailures: 0, candidateFailures: 2 },
          review: { cases: 0, D: 0, baselineFailures: 0, candidateFailures: 0 },
          eval_judging: { cases: 0, D: 0, baselineFailures: 0, candidateFailures: 0 },
          issue_expansion: { cases: 0, D: 0, baselineFailures: 0, candidateFailures: 0 },
        },
        exclusions: [],
        cases: [],
        reportPath: join(repoDir, '.wavemill/harness-replay/reports/report.json'),
      });
      postCompletionHookDeps.runContextUpdateWork = async () => {
        calls.push('context');
      };

      const persisted = await runPostCompletionEval({
        issueId: 'HOK-2844',
        prNumber: '2844',
        workflowType: 'mill',
        repoDir,
        branchName: 'task/harness-retention',
        worktreePath: repoDir,
        agentType: 'codex',
      });

      assert.equal(persisted, true);
    });

    assert.deepEqual(calls, ['persist', 'hokusai']);
  } finally {
    clearConfigCache(repoDir);
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('runPostCompletionEval keeps eval persisted when Hokusai enqueue fails', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-hokusai-fails-'));
  makeContextUpdateRepo(repoDir, 'hokusai-fails', 'HOK-1584');
  clearConfigCache(repoDir);
  const warnings: string[] = [];
  let contextCalls = 0;
  const originalWarn = console.warn;

  try {
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    await withMockedPostCompletionDeps(async () => {
      stubBaseEvalDeps();
      postCompletionHookDeps.triggerHokusaiSubmission = async () => {
        throw new Error('queue unavailable');
      };
      postCompletionHookDeps.runContextUpdateWork = async () => {
        contextCalls += 1;
      };

      const persisted = await runPostCompletionEval({
        issueId: 'HOK-1584',
        prNumber: '1584',
        workflowType: 'mill',
        repoDir,
        branchName: 'task/hokusai-fails',
        worktreePath: repoDir,
        agentType: 'codex',
      });

      assert.equal(persisted, true);
    });

    assert.equal(contextCalls, 1);
    assert.ok(warnings.some((line) => line.includes('Post-completion eval: Hokusai submission failed (queue unavailable)')));
    assert.ok(existsSync(join(repoDir, '.wavemill', 'evals', 'evals.jsonl')));
  } finally {
    console.warn = originalWarn;
    clearConfigCache(repoDir);
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('runPostCompletionEval records warning when context updates throw', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-context-error-'));
  makeContextUpdateRepo(repoDir, 'context-error', 'HOK-1578');
  clearConfigCache(repoDir);

  try {
    await withMockedPostCompletionDeps(async () => {
      stubBaseEvalDeps();
      postCompletionHookDeps.runContextUpdateWork = async () => {
        throw new Error('context exploded');
      };

      const persisted = await runPostCompletionEval({
        issueId: 'HOK-1578',
        prNumber: '1578',
        workflowType: 'mill',
        repoDir,
        branchName: 'task/context-error',
        worktreePath: repoDir,
        agentType: 'codex',
      });

      assert.equal(persisted, true);
    });

    const warnings = readWarningLines(repoDir);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].reason, 'error');
    assert.equal(warnings[0].errorMessage, 'context exploded');
  } finally {
    clearConfigCache(repoDir);
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('runPostCompletionEval skips optional updates via env override', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-skip-env-'));
  makeContextUpdateRepo(repoDir, 'skip-env', 'HOK-1579');
  clearConfigCache(repoDir);
  const previous = process.env.WAVEMILL_SKIP_POST_EVAL_CONTEXT_UPDATES;
  let calls = 0;

  try {
    process.env.WAVEMILL_SKIP_POST_EVAL_CONTEXT_UPDATES = '1';
    await withMockedPostCompletionDeps(async () => {
      stubBaseEvalDeps();
      postCompletionHookDeps.runContextUpdateWork = async () => {
        calls += 1;
      };

      const persisted = await runPostCompletionEval({
        issueId: 'HOK-1579',
        prNumber: '1579',
        workflowType: 'mill',
        repoDir,
        branchName: 'task/skip-env',
        worktreePath: repoDir,
        agentType: 'codex',
      });

      assert.equal(persisted, true);
    });

    assert.equal(calls, 0);
    const warnings = readWarningLines(repoDir);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].reason, 'skipped-env');
  } finally {
    if (previous === undefined) {
      delete process.env.WAVEMILL_SKIP_POST_EVAL_CONTEXT_UPDATES;
    } else {
      process.env.WAVEMILL_SKIP_POST_EVAL_CONTEXT_UPDATES = previous;
    }
    clearConfigCache(repoDir);
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('runPostCompletionEval skips optional updates via config', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-skip-config-'));
  makeContextUpdateRepo(repoDir, 'skip-config', 'HOK-1580');
  clearConfigCache(repoDir);
  let calls = 0;

  try {
    await withMockedPostCompletionDeps(async () => {
      stubBaseEvalDeps();
      postCompletionHookDeps.getEvalContextUpdatesConfig = () => ({
        enabled: false,
        timeoutSeconds: 60,
        maxRetries: 0,
      });
      postCompletionHookDeps.runContextUpdateWork = async () => {
        calls += 1;
      };

      const persisted = await runPostCompletionEval({
        issueId: 'HOK-1580',
        prNumber: '1580',
        workflowType: 'mill',
        repoDir,
        branchName: 'task/skip-config',
        worktreePath: repoDir,
        agentType: 'codex',
      });

      assert.equal(persisted, true);
    });

    assert.equal(calls, 0);
    const warnings = readWarningLines(repoDir);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].reason, 'skipped-config');
  } finally {
    clearConfigCache(repoDir);
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('runPostCompletionEval skips optional updates in constrained mode', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-skip-mode-'));
  makeContextUpdateRepo(repoDir, 'skip-mode', 'HOK-1581');
  clearConfigCache(repoDir);
  let calls = 0;

  try {
    await withMockedPostCompletionDeps(async () => {
      stubBaseEvalDeps();
      postCompletionHookDeps.getCurrentOperatingMode = () => 'constrained';
      postCompletionHookDeps.runContextUpdateWork = async () => {
        calls += 1;
      };

      const persisted = await runPostCompletionEval({
        issueId: 'HOK-1581',
        prNumber: '1581',
        workflowType: 'mill',
        repoDir,
        branchName: 'task/skip-mode',
        worktreePath: repoDir,
        agentType: 'codex',
      });

      assert.equal(persisted, true);
    });

    assert.equal(calls, 0);
    const warnings = readWarningLines(repoDir);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].reason, 'skipped-operating-mode');
    assert.equal(warnings[0].operatingMode, 'constrained');
  } finally {
    clearConfigCache(repoDir);
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('runPostCompletionEval leaves no warning file on context update success', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-context-success-'));
  makeContextUpdateRepo(repoDir, 'context-success', 'HOK-1582');
  clearConfigCache(repoDir);
  let calls = 0;

  try {
    await withMockedPostCompletionDeps(async () => {
      stubBaseEvalDeps();
      postCompletionHookDeps.runContextUpdateWork = async () => {
        calls += 1;
      };

      const persisted = await runPostCompletionEval({
        issueId: 'HOK-1582',
        prNumber: '1582',
        workflowType: 'mill',
        repoDir,
        branchName: 'task/context-success',
        worktreePath: repoDir,
        agentType: 'codex',
      });

      assert.equal(persisted, true);
    });

    assert.equal(calls, 1);
    assert.equal(readWarningLines(repoDir).length, 0);
  } finally {
    clearConfigCache(repoDir);
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('enrichPostCompletionRecord falls back to archived routing-complete data', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-archive-'));
  const archiveDir = join(repoDir, '.wavemill', 'evals', 'artifacts', 'HOK-1123');
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(
    join(archiveDir, 'routing-complete.json'),
    JSON.stringify({
      planner: 'claude-opus-4-6',
      coder: 'gpt-5.3-codex',
      reviewer: 'claude-sonnet-4-5-20250929',
      maxCostUsd: 6.5,
    }),
  );

  try {
    const record = makeRecord();
    enrichPostCompletionRecord(record, {
      repoDir,
      issueId: 'HOK-1123',
      branchName: 'task/enrich-task',
      worktreePath: join(repoDir, 'missing-worktree'),
      originalPrompt: 'Re-run post-completion eval after cleanup',
      prDiff: '+++ src/auth.ts',
      record,
      difficultyData: null,
      taskContextData: null,
      repoContextData: null,
      costOutcome: null,
      interventionRecords: [],
    });

    assert.equal(record.taskDescriptor?.stages.planner?.model, 'claude-opus-4-6');
    assert.equal(record.taskDescriptor?.stages.coder?.model, 'gpt-5.3-codex');
    assert.equal(record.constraints?.maxCostUsd, 6.5);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('enrichPostCompletionRecord preserves DeepSeek model identity before eligibility is computed', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-deepseek-'));
  const featureDir = join(repoDir, 'features', 'deepseek-task');
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(
    join(featureDir, '.coding-result.json'),
    JSON.stringify({
      stage: 'coding',
      status: 'completed',
      startedAt: '2026-04-06T11:00:00.000Z',
      finishedAt: '2026-04-06T11:30:00.000Z',
      agent: 'claude',
      model: 'deepseek-v4-pro',
      notes: '',
    }),
  );

  try {
    const record = { ...makeRecord(), modelId: '', modelVersion: '' } as EvalRecord;
    record.routingDecision = {
      candidates: [{ agentType: 'claude', modelId: 'claude-sonnet-4-6' }],
      chosen: { agentType: 'claude', modelId: 'claude-sonnet-4-6' },
      decisionPolicyVersion: 'baseline',
      decisionRationale: 'fallback',
    };
    record.constraints = { maxCostUsd: 5 };
    record.workflowCost = 1.2;
    record.workflowTokenUsage = {};
    record.outcomes = {
      success: true,
      review: { humanReviewRequired: false, rounds: 0, approvals: 1, changeRequests: 0 },
      rework: { agentIterations: 1 },
      delivery: { prCreated: true, merged: false },
    };
    record.modelId = 'deepseek-v4-pro';
    record.modelVersion = 'deepseek-v4-pro';

    enrichPostCompletionRecord(record, {
      repoDir,
      issueId: 'HOK-1488',
      branchName: 'task/deepseek-task',
      worktreePath: repoDir,
      originalPrompt: 'Evaluate deepseek-backed run',
      prDiff: '+++ src/session.ts',
      record,
      difficultyData: null,
      taskContextData: null,
      repoContextData: null,
      costOutcome: null,
      interventionRecords: [],
    });

    assert.equal(record.modelId, 'deepseek-v4-pro');
    assert.equal(record.provider, 'deepseek');
    assert.equal(record.trainingEligible, true);
    assert.ok(!record.eligibilityErrors?.includes('missing_model_identity'));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('enrichPostCompletionRecord marks complete records with outcomes as training eligible', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-eligible-'));
  const featureDir = join(repoDir, 'features', 'eligible-task');
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(
    join(repoDir, '.wavemill-config.json'),
    JSON.stringify({}),
  );
  writeFileSync(
    join(featureDir, '.routing-complete'),
    JSON.stringify({
      planner: 'gpt-5.5',
      coder: 'gpt-5.4',
      reviewer: 'claude-sonnet-4-6',
      codeDepth: 'deep',
      reviewMode: 'full',
      maxCostUsd: 6.5,
    }),
  );
  writeFileSync(
    join(featureDir, '.initial-route.json'),
    JSON.stringify({
      planner: 'gpt-5.5',
      coder: 'gpt-5.4',
      reviewer: 'claude-sonnet-4-6',
      codeDepth: 'deep',
      reviewMode: 'full',
    }),
  );

  try {
    const record = makeRecord();
    record.modelId = 'gpt-5.4';
    record.modelVersion = 'gpt-5.4';
    record.routingDecision = {
      candidates: [{ agentType: 'codex', modelId: 'gpt-5.4' }],
      chosen: { agentType: 'codex', modelId: 'gpt-5.4' },
      decisionPolicyVersion: 'baseline',
      decisionRationale: 'selected coder',
    };
    record.workflowCost = 2.1;
    record.workflowTokenUsage = {};
    record.outcomes = {
      success: true,
      ci: { ran: true, passed: true, checks: [] },
      tests: { added: true, passRate: 1 },
      staticAnalysis: { lintDelta: 0, typecheckPassed: true },
      review: { humanReviewRequired: false, rounds: 1, approvals: 1, changeRequests: 0 },
      rework: { agentIterations: 1 },
      delivery: { prCreated: true, merged: false },
    };

    enrichPostCompletionRecord(record, {
      repoDir,
      issueId: 'HOK-1550',
      branchName: 'task/eligible-task',
      worktreePath: repoDir,
      agentType: 'codex',
      originalPrompt: 'Persist outcomes in post-completion evals',
      prDiff: '+++ shared/lib/post-completion-hook.ts',
      record,
      difficultyData: {
        difficultyBand: 'medium',
        difficultySignals: { locTouched: 20, filesTouched: 1 },
        stratum: 'ts_node_med',
      },
      taskContextData: {
        taskType: 'feature',
        changeKind: 'modify_existing',
        complexity: 'm',
      },
      repoContextData: {
        repoId: 'repo',
        repoVisibility: 'private',
        primaryLanguage: 'TypeScript',
        languages: { TypeScript: 100 },
        frameworks: ['Node'],
        repoSize: { fileCount: 10, loc: 1000, dependencyCount: 3 },
      },
      costOutcome: {
        status: 'success',
        totalCostUsd: 2.1,
        models: {},
        sessionCount: 1,
        turnCount: 2,
        pricingUsed: {},
      },
      interventionRecords: [],
      routingDecision: record.routingDecision,
    });

    assert.equal(record.trainingEligible, true);
    assert.ok(!record.eligibilityErrors?.includes('missing_outcome'));
  } finally {
    clearConfigCache(repoDir);
    rmSync(repoDir, { recursive: true, force: true });
  }
});

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);

if (failed > 0) {
  process.exit(1);
}
