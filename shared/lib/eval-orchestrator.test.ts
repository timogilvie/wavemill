import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runEvaluation, evalOrchestratorDeps } from './eval-orchestrator.ts';
import { enrichPostCompletionRecord } from './post-completion-hook.ts';
import type { EvalRecord, InterventionRecord, RoutingDecision } from './eval-schema.ts';
import type { EvalContext } from './eval-context-gatherer.ts';
import type { WorkflowCostOutcome } from './workflow-cost.ts';
import { meterWorkflowCost } from './sdk-task-cost/meter.ts';
import { appendOwnershipRow } from './session-ownership.ts';

function makeJudgeRecord(): EvalRecord {
  return {
    id: 'eval-orchestrator-1',
    schemaVersion: '1.19.0',
    originalPrompt: 'Implement unified eval enrichment',
    modelId: '',
    modelVersion: '',
    score: 0.9,
    scoreBand: 'Minor Feedback',
    timeSeconds: 180,
    timestamp: '2026-05-03T12:00:00.000Z',
    interventionRequired: false,
    interventionCount: 1,
    interventionDetails: ['Asked for one clarification'],
    rationale: 'Strong implementation with minor operator involvement.',
    metadata: {
      stageScores: {
        plan: { score: 0.88, rationale: 'Clear plan.' },
        implementation: { score: 0.91, rationale: 'Solid implementation.' },
        review: { score: 0.86, rationale: 'Good review coverage.' },
      },
    },
  };
}

function writeRouteArtifacts(repoDir: string, slug: string, issueId: string): void {
  const featureDir = join(repoDir, 'features', slug);
  const archiveDir = join(repoDir, '.wavemill', 'evals', 'artifacts', issueId);
  mkdirSync(featureDir, { recursive: true });
  mkdirSync(archiveDir, { recursive: true });

  const routingComplete = {
    planner: 'claude-opus-4-6',
    coder: 'gpt-5.4',
    reviewer: 'claude-sonnet-4-5-20250929',
    codeDepth: 'deep',
    reviewMode: 'full',
    maxCostUsd: 6.5,
  };
  const bootstrapRoute = {
    planner: 'claude-opus-4-6',
    coder: 'gpt-5.4',
    codeDepth: 'deep',
    reviewer: 'claude-sonnet-4-5-20250929',
    reviewMode: 'full',
  };

  writeFileSync(join(featureDir, '.routing-complete'), JSON.stringify(routingComplete));
  writeFileSync(join(featureDir, '.initial-route.json'), JSON.stringify(bootstrapRoute));
  writeFileSync(join(featureDir, '.post-expansion-route.json'), JSON.stringify(bootstrapRoute));
  writeFileSync(join(archiveDir, '.routing-complete'), JSON.stringify(routingComplete));
  writeFileSync(join(archiveDir, '.initial-route.json'), JSON.stringify(bootstrapRoute));
}

describe('eval-orchestrator', () => {
  let repoDir: string;
  let routingDecision: RoutingDecision;
  let interventionRecords: InterventionRecord[];
  let costOutcome: WorkflowCostOutcome;
  let evaluateTaskInput: Record<string, unknown> | undefined;
  let detectAllInput: Record<string, unknown> | undefined;
  let gatherEvalContextOverride: EvalContext | undefined;

  beforeEach(() => {
    mock.restoreAll();
    repoDir = mkdtempSync(join(tmpdir(), 'eval-orchestrator-'));
    routingDecision = {
      candidates: [
        { agentType: 'claude', modelId: 'claude-opus-4-6' },
        { agentType: 'codex', modelId: 'gpt-5.4' },
      ],
      chosen: { agentType: 'codex', modelId: 'gpt-5.4' },
      decisionPolicyVersion: 'baseline',
      decisionRationale: 'Use the faster implementation model.',
    };
    interventionRecords = [
      {
        timestamp: '2026-05-03T12:10:00.000Z',
        type: 'clarification',
        severity: 'low',
        note: 'Clarified one requirement.',
      },
    ];
    costOutcome = {
      status: 'success',
      totalCostUsd: 3.75,
      models: {
        'gpt-5.4': {
          inputTokens: 1200,
          cacheCreationTokens: 100,
          cacheReadTokens: 0,
          outputTokens: 400,
          costUsd: 3.75,
        },
      },
      sessionCount: 1,
      turnCount: 4,
      pricingUsed: {},
    };
    gatherEvalContextOverride = undefined;
    evaluateTaskInput = undefined;
    detectAllInput = undefined;

    writeRouteArtifacts(repoDir, 'unified-eval', 'HOK-1495');

    mock.method(evalOrchestratorDeps, 'gatherEvalContext', () => (
      gatherEvalContextOverride ?? {
        taskPrompt: 'Implement unified eval enrichment',
        prDiff: '+++ shared/lib/eval-orchestrator.ts\n+++ shared/lib/eval-record-builder.ts',
        prUrl: 'https://example.test/pr/1495',
        prDiffAvailability: {
          available: true,
          source: 'gh-pr-diff',
          bytes: 80,
          attempts: ['gh pr diff: ok 80 bytes'],
        },
        issueData: null,
      }
    ));
    mock.method(evalOrchestratorDeps, 'gatherStageArtifacts', () => ({
      taskPacket: undefined,
      planContent: undefined,
      selfReviewSummary: undefined,
      routingDecision,
      phaseDurations: {
        planning: 120,
        coding: 480,
        review: 60,
        total: 660,
      },
      executedPlanning: {
        agent: 'codex',
        model: 'claude-opus-4-6',
        status: 'completed',
        source: '.planning-result.json',
      },
      executionModel: 'gpt-5.4',
    }));
    mock.method(evalOrchestratorDeps, 'execShellCommand', () => 'task/unified-eval');
    mock.method(evalOrchestratorDeps, 'computeWallClockSeconds', () => 180);
    mock.method(evalOrchestratorDeps, 'detectAllInterventions', (input) => {
      detectAllInput = input as Record<string, unknown>;
      return {
      interventions: [{ type: 'clarification', count: 1 }],
      totalInterventionScore: 0.1,
      };
    });
    mock.method(evalOrchestratorDeps, 'toInterventionMeta', () => [{ description: 'Clarified one requirement', severity: 'minor' }]);
    mock.method(evalOrchestratorDeps, 'toInterventionRecords', () => interventionRecords);
    mock.method(evalOrchestratorDeps, 'loadPenalties', () => ({}));
    mock.method(evalOrchestratorDeps, 'formatForJudge', () => 'No major interventions.');
    mock.method(evalOrchestratorDeps, 'runEvalAnalysis', async () => ({
      difficultyData: {
        difficultyBand: 'medium',
        difficultySignals: { locTouched: 80, filesTouched: 3 },
        stratum: 'ts_express_med',
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
        repoSize: { fileCount: 40, loc: 12000, dependencyCount: 8 },
      },
    }));
    mock.method(evalOrchestratorDeps, 'collectCiOutcome', () => ({ ran: true, passed: true }));
    mock.method(evalOrchestratorDeps, 'collectTestsOutcome', () => ({ added: true }));
    mock.method(evalOrchestratorDeps, 'collectStaticAnalysisOutcome', () => ({ issuesFound: 0 }));
    mock.method(evalOrchestratorDeps, 'collectReviewOutcome', () => ({
      humanReviewRequired: false,
      rounds: 0,
      approvals: 1,
      changeRequests: 0,
    }));
    mock.method(evalOrchestratorDeps, 'collectReworkOutcome', () => ({ agentIterations: 1 }));
    mock.method(evalOrchestratorDeps, 'collectDeliveryOutcome', () => ({ prCreated: true, merged: false }));
    mock.method(evalOrchestratorDeps, 'loadPricingTable', () => ({
      'gpt-5.4': {
        inputCostPerMTok: 1,
        outputCostPerMTok: 2,
      },
    }));
    // Metering is stubbed to a fixed outcome; the metering tests below
    // restore the real runner over an injected ownership record.
    mock.method(evalOrchestratorDeps, 'meterWorkflowCost', async () => ({
      outcome: costOutcome,
      summaries: null,
      reason: 'sdk_report' as const,
      owned: [],
      sessionCosts: new Map(),
    }));
    mock.method(evalOrchestratorDeps, 'appendEvalRecord', () => undefined);
    mock.method(evalOrchestratorDeps, 'triggerHokusaiSubmission', async () => ({
      status: 'disabled',
      source: 'repo_config',
      detail: 'test disabled',
    }));
    mock.method(evalOrchestratorDeps, 'evaluateTask', async (input, outcomes) => {
      evaluateTaskInput = input as Record<string, unknown>;
      const timeSeconds =
        Object.prototype.hasOwnProperty.call(input, 'timeSeconds')
          ? (input as { timeSeconds?: number | null }).timeSeconds
          : makeJudgeRecord().timeSeconds;
      return {
        ...makeJudgeRecord(),
        timeSeconds,
        outcomes,
        routingDecision,
      };
    });
  });

  afterEach(() => {
    mock.restoreAll();
    rmSync(repoDir, { recursive: true, force: true });
  });

  describe('@hokusai/costs metering over owned sessions (HOK-3328)', () => {
    const runInput = () => ({
      issueId: 'HOK-1495',
      prNumber: '1495',
      repoDir,
      worktreePath: repoDir,
      agentType: 'codex',
    });

    beforeEach(() => {
      mock.method(evalOrchestratorDeps, 'meterWorkflowCost', meterWorkflowCost);
    });

    // protects: the eval entrypoint metering anything but the task's ownership record
    it('meters the task\'s owned sessions located from the eval archive', async () => {
      let meterInput: Parameters<typeof meterWorkflowCost>[0] | undefined;
      mock.method(evalOrchestratorDeps, 'meterWorkflowCost', async (input: Parameters<typeof meterWorkflowCost>[0]) => {
        meterInput = input;
        return meterWorkflowCost({ ...input, exactPricing: { ...input.exactPricing, enabled: false } });
      });
      appendOwnershipRow(join(repoDir, '.wavemill', 'evals', 'artifacts', 'HOK-1495'), {
        sessionRef: 'never-written-session', harness: 'claude-code', kind: 'coding', model: 'gpt-5.4',
      });

      const record = await runEvaluation(runInput());

      assert.equal(meterInput?.worktreePath, repoDir);
      assert.equal(meterInput?.branchName, 'task/unified-eval');
      assert.equal(meterInput?.issueId, 'HOK-1495');
      // The meter prices with the eval's own rate table.
      assert.deepEqual(meterInput?.pricingTable, { 'gpt-5.4': { inputCostPerMTok: 1, outputCostPerMTok: 2 } });
      // The owned session left no transcript: no_sessions, never $0.
      assert.equal(record.workflowCostStatus, 'no_sessions');
      assert.equal(record.workflowCost, undefined);
      assert.match(record.workflowCostDiagnostics?.reason ?? '', /1 owned session\(s\) left no usage/);
    });

    // protects: exact OpenRouter charges silently dropped from native task cost
    it('opts in to OpenRouter exact pricing for native turns', async () => {
      let exactPricing: unknown;
      mock.method(evalOrchestratorDeps, 'meterWorkflowCost', async (input: Parameters<typeof meterWorkflowCost>[0]) => {
        exactPricing = input.exactPricing;
        return meterWorkflowCost({ ...input, exactPricing: { ...input.exactPricing, enabled: false } });
      });

      await runEvaluation(runInput());

      assert.ok(exactPricing && typeof exactPricing === 'object', 'eval orchestrator passes exactPricing options');
      assert.equal((exactPricing as { enabled?: boolean }).enabled, undefined, 'enabled defaults to OPENROUTER_API_KEY presence');
    });

    // protects: a task with no ownership record reported as costing $0
    it('records no_sessions — never a zero — when no launch row names a session', async () => {
      const record = await runEvaluation(runInput());

      assert.equal('taskCostSummary' in record, false);
      assert.equal(record.workflowCost, undefined);
      assert.equal(record.workflowCostStatus, 'no_sessions');
    });

    // protects: a measurement failure failing the eval instead of recording adapter_error
    it('records an adapter_error when measurement fails', async () => {
      mock.method(evalOrchestratorDeps, 'meterWorkflowCost', async (input: Parameters<typeof meterWorkflowCost>[0]) => meterWorkflowCost({
        ...input,
        ownership: [{ sessionRef: 's', harness: 'claude-code', kind: 'coding', stage: 'coding', model: '', launchedAt: '2026-10-27T00:00:00.000Z', attemptId: 'a' }],
        loadMeasure: async () => { throw new Error('sdk exploded'); },
      }));
      const warnings: string[] = [];
      mock.method(console, 'warn', (message: string) => warnings.push(String(message)));

      const record = await runEvaluation(runInput());

      assert.equal('taskCostSummary' in record, false);
      assert.equal(record.workflowCost, undefined);
      assert.equal(record.workflowCostStatus, 'adapter_error');
      assert.ok(warnings.some((warning) => warning.includes('@hokusai/costs measurement failed — sdk exploded')));
    });
  });

  it('computes workflow cost metadata before training enrichment', async () => {
    const record = await runEvaluation({
      issueId: 'HOK-1495',
      prNumber: '1495',
      repoDir,
      worktreePath: repoDir,
      agentType: 'codex',
    });

    assert.equal(record.workflowCost, 3.75);
    assert.equal(record.timeSeconds, 660);
    assert.deepEqual(record.phaseDurationsSeconds, {
      planning: 120,
      coding: 480,
      review: 60,
      total: 660,
    });
    assert.equal(evaluateTaskInput?.timeSeconds, 660);
    assert.deepEqual(record.workflowTokenUsage, costOutcome.status === 'success' ? costOutcome.models : undefined);
    assert.equal(record.workflowCostStatus, 'success');
    assert.equal(record.taskDescriptor?.outcome?.total_cost_usd, 3.75);
    assert.equal(record.constraints?.maxCostUsd, 6.5);
    assert.equal(record.enrichmentDiagnostics, undefined);
    assert.equal(detectAllInput?.worktreePath, repoDir);
    assert.equal(detectAllInput?.issueId, 'HOK-1495');
  });

  it('enriches eval records with native provider metadata for native runs', async () => {
    const nativeSessionsDir = join(repoDir, '.wavemill', 'runs', 'HOK-1495', 'native-sessions');
    mkdirSync(nativeSessionsDir, { recursive: true });
    writeFileSync(
      join(nativeSessionsDir, 'review.jsonl'),
      [
        JSON.stringify({
          seq: 1,
          sessionId: 'native-review',
          timestamp: 1,
          type: 'session_started',
          model: 'gpt-4o',
          api: 'openai-responses',
          provider: 'openai',
        }),
        JSON.stringify({
          seq: 2,
          sessionId: 'native-review',
          timestamp: 2,
          type: 'assistant_message',
          model: 'gpt-4o',
          stopReason: 'stop',
          usage: {
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 15,
          },
          rawContent: [],
          replayContent: [],
          redacted: false,
        }),
      ].join('\n'),
    );

    const record = await runEvaluation({
      issueId: 'HOK-1495',
      prNumber: '1495',
      repoDir,
      worktreePath: repoDir,
      agentType: 'native',
    });

    assert.equal(record.provider, 'openai');
    assert.equal(record.endpoint, 'openai-responses');
    assert.equal(record.modelId, 'gpt-5.4');
    assert.equal(record.workflowCost, 3.75);
  });

  it('preserves null duration when git history is indeterminate', async () => {
    mock.method(evalOrchestratorDeps, 'gatherStageArtifacts', () => ({
      taskPacket: undefined,
      planContent: undefined,
      selfReviewSummary: undefined,
      routingDecision,
      phaseDurations: undefined,
      executionModel: 'gpt-5.4',
    }));
    mock.method(evalOrchestratorDeps, 'computeWallClockSeconds', () => null);

    const record = await runEvaluation({
      issueId: 'HOK-1495',
      prNumber: '1495',
      repoDir,
      worktreePath: repoDir,
      agentType: 'codex',
    });

    assert.equal(evaluateTaskInput?.timeSeconds, null);
    assert.equal(record.timeSeconds, null);
  });

  it('persists an unscored record without invoking the judge when PR diff is unavailable', async () => {
    gatherEvalContextOverride = {
      taskPrompt: 'Implement unified eval enrichment',
      prDiff: '',
      prUrl: 'https://example.test/pr/1495',
      prDiffAvailability: {
        available: false,
        reason: 'gh_too_large',
        detail: 'HTTP 406: diff exceeded maximum number of files',
        attempts: ['gh pr diff: HTTP 406', 'local-git: fetch failed'],
      },
      issueData: null,
    };

    const record = await runEvaluation({
      issueId: 'HOK-1495',
      prNumber: '1495',
      repoDir,
      worktreePath: repoDir,
      agentType: 'codex',
    });

    assert.equal(evaluateTaskInput, undefined);
    assert.equal(record.score, 0);
    assert.equal(record.scoreBand, 'Failure');
    assert.equal(record.failureReason, 'pr_diff_unavailable');
    assert.equal(record.trainingEligible, false);
    assert.equal((record.metadata?.prDiffUnavailable as { reason?: string } | undefined)?.reason, 'gh_too_large');
    assert.match(record.rationale, /Judge not invoked/);
  });

  it('preserves null duration when no branch is available', async () => {
    mock.method(evalOrchestratorDeps, 'gatherStageArtifacts', () => ({
      taskPacket: undefined,
      planContent: undefined,
      selfReviewSummary: undefined,
      routingDecision,
      phaseDurations: undefined,
      executionModel: 'gpt-5.4',
    }));
    mock.method(evalOrchestratorDeps, 'execShellCommand', () => '');

    const record = await runEvaluation({
      issueId: 'HOK-1495',
      prNumber: '1495',
      repoDir,
      worktreePath: repoDir,
      agentType: 'codex',
    });

    assert.equal(evaluateTaskInput?.timeSeconds, null);
    assert.equal(record.timeSeconds, null);
  });

  it('preserves positive git-derived duration when phase totals are unavailable', async () => {
    mock.method(evalOrchestratorDeps, 'gatherStageArtifacts', () => ({
      taskPacket: undefined,
      planContent: undefined,
      selfReviewSummary: undefined,
      routingDecision,
      phaseDurations: undefined,
      executionModel: 'gpt-5.4',
    }));
    mock.method(evalOrchestratorDeps, 'computeWallClockSeconds', () => 180);

    const record = await runEvaluation({
      issueId: 'HOK-1495',
      prNumber: '1495',
      repoDir,
      worktreePath: repoDir,
      agentType: 'codex',
    });

    assert.equal(evaluateTaskInput?.timeSeconds, 180);
    assert.equal(record.timeSeconds, 180);
  });

  it('matches post-completion training fields for equivalent inputs', async () => {
    const orchestrated = await runEvaluation({
      issueId: 'HOK-1495',
      prNumber: '1495',
      repoDir,
      worktreePath: repoDir,
      agentType: 'codex',
    });

    const postCompletion = {
      ...makeJudgeRecord(),
      timeSeconds: 660,
      phaseDurationsSeconds: {
        planning: 120,
        coding: 480,
        review: 60,
        total: 660,
      },
      outcomes: {
        success: true,
        review: { humanReviewRequired: false, rounds: 0, approvals: 1, changeRequests: 0 },
        rework: { agentIterations: 1 },
        delivery: { prCreated: true, merged: false },
      },
      routingDecision,
      modelId: 'gpt-5.4',
      modelVersion: 'gpt-5.4',
    } as EvalRecord;

    enrichPostCompletionRecord(postCompletion, {
      repoDir,
      issueId: 'HOK-1495',
      branchName: 'task/unified-eval',
      worktreePath: repoDir,
      agentType: 'codex',
      originalPrompt: 'Implement unified eval enrichment',
      prDiff: '+++ shared/lib/eval-orchestrator.ts\n+++ shared/lib/eval-record-builder.ts',
      record: postCompletion,
      difficultyData: {
        difficultyBand: 'medium',
        difficultySignals: { locTouched: 80, filesTouched: 3 },
        stratum: 'ts_express_med',
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
        repoSize: { fileCount: 40, loc: 12000, dependencyCount: 8 },
      },
      costOutcome,
      interventionRecords,
      routingDecision,
      executedPlanning: {
        agent: 'codex',
        model: 'claude-opus-4-6',
        status: 'completed',
        source: '.planning-result.json',
      },
      phaseDurations: {
        planning: 120,
        coding: 480,
        review: 60,
        total: 660,
      },
    });

    assert.deepEqual(
      {
        workflowCost: orchestrated.workflowCost,
        workflowTokenUsage: orchestrated.workflowTokenUsage,
        workflowCostStatus: orchestrated.workflowCostStatus,
        constraints: orchestrated.constraints,
        routeProvenance: orchestrated.routeProvenance,
        executedPlanning: orchestrated.executedPlanning,
        phaseDurationsSeconds: orchestrated.phaseDurationsSeconds,
        trainingEligible: orchestrated.trainingEligible,
        budgetEvalEligible: orchestrated.budgetEvalEligible,
        eligibilityErrors: orchestrated.eligibilityErrors,
        enrichmentDiagnostics: orchestrated.enrichmentDiagnostics,
        taskDescriptor: orchestrated.taskDescriptor,
      },
      {
        workflowCost: postCompletion.workflowCost,
        workflowTokenUsage: postCompletion.workflowTokenUsage,
        workflowCostStatus: postCompletion.workflowCostStatus,
        constraints: postCompletion.constraints,
        routeProvenance: postCompletion.routeProvenance,
        executedPlanning: postCompletion.executedPlanning,
        phaseDurationsSeconds: postCompletion.phaseDurationsSeconds,
        trainingEligible: postCompletion.trainingEligible,
        budgetEvalEligible: postCompletion.budgetEvalEligible,
        eligibilityErrors: postCompletion.eligibilityErrors,
        enrichmentDiagnostics: postCompletion.enrichmentDiagnostics,
        taskDescriptor: postCompletion.taskDescriptor,
      },
    );
  });

  it('diagnoses skipped workflow cost instead of omitting it silently', async () => {
    mock.method(evalOrchestratorDeps, 'meterWorkflowCost', async () => {
      throw new Error('should not run without worktreePath');
    });
    const warn = mock.method(console, 'warn', () => undefined);

    const record = await runEvaluation({
      issueId: 'HOK-1495',
      prNumber: '1495',
      repoDir,
      agentType: 'codex',
    });

    assert.equal(record.workflowCost, undefined);
    assert.equal(record.workflowCostStatus, 'skipped');
    assert.ok(record.enrichmentDiagnostics?.includes('workflowCost'));
    assert.ok(warn.mock.calls.some((call) => String(call.arguments[0]).includes('workflowCost')));
  });

  it('triggers Hokusai submission after successful persistence', async () => {
    const order: string[] = [];
    let triggeredRecord: EvalRecord | undefined;
    let triggeredRepoDir: string | undefined;
    let persistedRepoDir: string | undefined;
    mock.method(evalOrchestratorDeps, 'appendEvalRecord', (_record, options) => {
      order.push('persist');
      persistedRepoDir = options?.repoDir;
    });
    mock.method(evalOrchestratorDeps, 'triggerHokusaiSubmission', async (record, options) => {
      order.push('trigger');
      triggeredRecord = record;
      triggeredRepoDir = options.repoDir;
      return { status: 'enqueued', drainStarted: true };
    });

    const record = await runEvaluation({
      issueId: 'HOK-1495',
      prNumber: '1495',
      repoDir,
      worktreePath: repoDir,
      agentType: 'codex',
    });

    assert.deepEqual(order, ['persist', 'trigger']);
    assert.equal(persistedRepoDir, repoDir);
    assert.equal(triggeredRepoDir, repoDir);
    assert.equal(triggeredRecord?.id, record.id);
    assert.equal(triggeredRecord?.workflowCost, 3.75);
    assert.equal(triggeredRecord?.constraints?.maxCostUsd, 6.5);
  });

  it('does not trigger Hokusai submission when persistence fails', async () => {
    const trigger = mock.method(evalOrchestratorDeps, 'triggerHokusaiSubmission', async () => ({
      status: 'disabled',
      source: 'repo_config',
      detail: 'test disabled',
    }));
    mock.method(evalOrchestratorDeps, 'appendEvalRecord', () => {
      throw new Error('disk full');
    });

    await runEvaluation({
      issueId: 'HOK-1495',
      prNumber: '1495',
      repoDir,
      worktreePath: repoDir,
      agentType: 'codex',
    });

    assert.equal(trigger.mock.calls.length, 0);
  });

  it('waits for the Hokusai trigger before returning', async () => {
    let resolveTrigger: (() => void) | undefined;
    mock.method(evalOrchestratorDeps, 'triggerHokusaiSubmission', () => new Promise((resolve) => {
      resolveTrigger = () => resolve({ status: 'enqueued', drainStarted: true });
    }));

    const run = runEvaluation({
      issueId: 'HOK-1495',
      prNumber: '1495',
      repoDir,
      worktreePath: repoDir,
      agentType: 'codex',
    }).then(() => 'resolved');

    const result = await Promise.race([
      run,
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 25)),
    ]);

    assert.equal(result, 'timeout');
    resolveTrigger?.();
    const completed = await Promise.race([
      run,
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 25)),
    ]);
    assert.equal(completed, 'resolved');
  });

  it('logs and swallows trigger rejections', async () => {
    const warn = mock.method(console, 'warn', () => undefined);
    mock.method(evalOrchestratorDeps, 'triggerHokusaiSubmission', async () => {
      throw new Error('trigger failed');
    });

    await runEvaluation({
      issueId: 'HOK-1495',
      prNumber: '1495',
      repoDir,
      worktreePath: repoDir,
      agentType: 'codex',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(warn.mock.calls.some((call) => String(call.arguments[0]).includes('[hokusai] failed to trigger submission: trigger failed')));
  });
});
