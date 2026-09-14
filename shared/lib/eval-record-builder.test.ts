/**
 * Tests for eval-record-builder module.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import type { EvalRecord } from './eval-schema.ts';
import {
  attachEligibility,
  attachAgentType,
  attachEvaluatedPrHeadSha,
  attachAttemptedModel,
  attachBudgetMetadata,
  attachChallengeExecutionMetadata,
  attachRouteCalibration,
  attachRoutePrediction,
  attachChallengeRouteContext,
  attachConstraints,
  attachDifficultyMetadata,
  attachExecutedPlanning,
  attachFallbackEvent,
  attachPhaseDurations,
  attachRouteProvenance,
  attachRouterPolicyMetadata,
  attachManifestRef,
  attachProviderMetadata,
  attachNonRewardReason,
  attachRubricEval,
  attachStageOutcomes,
  attachTaskContextMetadata,
  attachRepoContextMetadata,
  attachWorkflowCostMetadata,
  attachExecutionEconomics,
  attachFeatureOutcomeDiagnostics,
  attachPlanningExecutionOutcome,
  attachVerificationTelemetry,
  attachModelIdentityAttribution,
  buildVerificationTelemetryFromArtifact,
  computeRouteCalibration,
  computeEligibility,
  enrichEvalRecord,
  enrichTrainingMetadata,
} from './eval-record-builder.ts';
import { getEffectiveRegistry } from './model-registry.ts';
import type { RubricEval } from './eval-schema.ts';
import type { ChallengeExecutionIntent } from './challenge-execution-contract.ts';
import { closeManifest, getHarnessId, openManifest, recordUse } from './resource-manifest.ts';
import { registerResource, toResourceRef } from './resource-registry.ts';

function expect(actual: unknown) {
  return {
    toBe(expected: unknown) {
      assert.equal(actual, expected);
    },
    toEqual(expected: unknown) {
      assert.deepEqual(actual, expected);
    },
    toBeUndefined() {
      assert.equal(actual, undefined);
    },
    toContain(expected: unknown) {
      if (Array.isArray(actual)) {
        assert.ok(actual.includes(expected));
        return;
      }
      if (typeof actual === 'string') {
        assert.ok(actual.includes(String(expected)));
        return;
      }
      assert.fail('expected value to be an array or string');
    },
    not: {
      toThrow() {
        assert.equal(typeof actual, 'function');
        assert.doesNotThrow(actual as () => void);
      },
      toHaveProperty(property: string) {
        assert.equal(actual !== null && typeof actual === 'object', true);
        assert.equal(Object.prototype.hasOwnProperty.call(actual, property), false);
      },
    },
  };
}

describe('eval-record-builder', () => {
  let baseRecord: EvalRecord;
  const tempDirs: string[] = [];

  beforeEach(() => {
    // Create a minimal eval record
    baseRecord = {
      id: 'test-id',
      timestamp: '2026-03-02T12:00:00Z',
      score: 0.85,
      scoreBand: 'good',
      reasoning: 'Test reasoning',
      taskPrompt: 'Test task',
      prReviewOutput: 'Test PR',
      schemaVersion: '1.0.0',
    } as EvalRecord;
  });

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  describe('attachAgentType', () => {
    it('should set agent type when provided', () => {
      attachAgentType(baseRecord, 'codex');
      expect(baseRecord.agentType).toBe('codex');
    });

    it('should default to "claude" when not provided', () => {
      attachAgentType(baseRecord, undefined);
      expect(baseRecord.agentType).toBe('claude');
    });

    it('should default to "claude" when empty string', () => {
      attachAgentType(baseRecord, '');
      expect(baseRecord.agentType).toBe('claude');
    });
  });

  describe('attachEvaluatedPrHeadSha', () => {
    it('persists only a sanitized non-empty evaluated head', () => {
      attachEvaluatedPrHeadSha(baseRecord, '  abc123  ');
      expect(baseRecord.evaluatedPrHeadSha).toBe('abc123');

      const blank = { ...baseRecord, evaluatedPrHeadSha: undefined };
      attachEvaluatedPrHeadSha(blank, '  ');
      expect(blank.evaluatedPrHeadSha).toBeUndefined();
    });
  });

  describe('attachManifestRef', () => {
    it('sets harnessId before close and manifestRef only after close', () => {
      const repoDir = mkdtempSync(join(tmpdir(), 'eval-manifest-'));
      tempDirs.push(repoDir);
      openManifest('eval-session', { workflowType: 'feature', repoDir });
      const resource = registerResource({
        type: 'prompt',
        name: 'eval-harness',
        content: 'prompt body',
      }, { repoDir });
      const ref = toResourceRef(resource);
      assert.ok(ref);
      recordUse('eval-session', 'eval', ref, repoDir);

      attachManifestRef(baseRecord, 'eval-session', repoDir);
      expect(baseRecord.harnessId).toBe(getHarnessId('eval-session', repoDir));
      expect(baseRecord.manifestRef).toBeUndefined();

      closeManifest('eval-session', { status: 'completed', repoDir });
      attachManifestRef(baseRecord, 'eval-session', repoDir);
      expect(baseRecord.harnessId).toBe(getHarnessId('eval-session', repoDir));
      assert.equal(baseRecord.manifestRef?.sessionId, 'eval-session');
      assert.ok(baseRecord.manifestRef?.manifestDigest);
    });
  });

  describe('attachDifficultyMetadata', () => {
    it('should attach difficulty data when provided', () => {
      const difficultyData = {
        difficultyBand: 'medium' as const,
        difficultySignals: {
          locTouched: 150,
          filesTouched: 5,
          diffUncertain: false,
        },
        stratum: 'stratum-2' as const,
      };

      attachDifficultyMetadata(baseRecord, difficultyData);

      expect(baseRecord.difficultyBand).toBe('medium');
      expect(baseRecord.difficultySignals).toEqual(difficultyData.difficultySignals);
      expect(baseRecord.stratum).toBe('stratum-2');
    });

    it('should not modify record when difficultyData is null', () => {
      const before = { ...baseRecord };
      attachDifficultyMetadata(baseRecord, null);
      expect(baseRecord).toEqual(before);
    });
  });

  describe('attachProviderMetadata', () => {
    it('should attach provider metadata when present', () => {
      attachProviderMetadata(baseRecord, 'deepseek', 'https://api.deepseek.com/anthropic');
      expect(baseRecord.provider).toBe('deepseek');
      expect(baseRecord.endpoint).toBe('https://api.deepseek.com/anthropic');
    });

    it('should attach native provider metadata', () => {
      attachProviderMetadata(baseRecord, 'pi', 'responses');
      expect(baseRecord.provider).toBe('pi');
      expect(baseRecord.endpoint).toBe('responses');
    });

    it('should no-op when provider metadata is absent', () => {
      attachProviderMetadata(baseRecord, undefined, undefined);
      expect(baseRecord.provider).toBeUndefined();
      expect(baseRecord.endpoint).toBeUndefined();
    });
  });

  describe('verification telemetry', () => {
    it('attaches telemetry only when present', () => {
      attachVerificationTelemetry(baseRecord, null);
      expect(baseRecord.verificationTelemetry).toBeUndefined();

      attachVerificationTelemetry(baseRecord, {
        schema_version: '1.0',
        local_verification: {
          ran: true,
          passed: true,
        },
      });

      expect(baseRecord.verificationTelemetry?.local_verification?.passed).toBe(true);
    });

    it('builds bounded local failure telemetry from a verification artifact', () => {
      const dir = mkdtempSync(join(tmpdir(), 'verification-telemetry-'));
      tempDirs.push(dir);
      const logPath = join(dir, 'cmd-0.log');
      writeFileSync(
        logPath,
        'Command failed for user@example.com in /Users/tim/private/repo\n',
        'utf-8',
      );

      const telemetry = buildVerificationTelemetryFromArtifact(
        {
          version: '1.0',
          timestamp: '2026-08-03T12:00:00.000Z',
          workingBranch: 'task/hok-2607',
          headSha: 'a'.repeat(40),
          baseSha: 'b'.repeat(40),
          overriddenBy: null,
          commands: [
            {
              index: 0,
              command: 'npm run lint',
              status: 'fail',
              exitCode: 1,
              durationMs: 123,
              logPath,
            },
          ],
          overallStatus: 'fail',
        },
        {
          enabled: true,
          required: true,
          source: 'explicit',
          recipe: {
            commands: ['npm run lint'],
          },
        },
      );

      assert.deepEqual(telemetry.contract, { source: 'explicit', version: '1.0' });
      assert.equal(telemetry.local_verification?.passed, false);
      assert.equal(telemetry.local_verification?.command_count, 1);
      assert.equal(telemetry.local_verification?.first_failure_category, 'lint');
      assert.match(telemetry.local_verification?.first_failure_fingerprint ?? '', /^[a-f0-9]{64}$/);
      assert.equal(telemetry.timeline?.local_start, '2026-08-03T12:00:00.000Z');
    });
  });

  describe('attachAttemptedModel', () => {
    it('sets both attempted_model and model_alias when provided', () => {
      attachAttemptedModel(baseRecord, {
        attemptedModel: 'qwen/qwen3-coder',
        modelAlias: 'qwen-3-coder',
      });

      expect(baseRecord.attempted_model).toBe('qwen/qwen3-coder');
      expect(baseRecord.model_alias).toBe('qwen-3-coder');
    });

    it('sets only the provided field when one is missing', () => {
      attachAttemptedModel(baseRecord, {
        attemptedModel: 'qwen/qwen3-coder',
      });

      expect(baseRecord.attempted_model).toBe('qwen/qwen3-coder');
      expect(baseRecord.model_alias).toBeUndefined();
    });

    it('treats null and empty strings as no-ops', () => {
      attachAttemptedModel(baseRecord, {
        attemptedModel: '',
        modelAlias: null,
      });

      expect('attempted_model' in baseRecord).toBe(false);
      expect('model_alias' in baseRecord).toBe(false);
    });
  });

  describe('attachTaskContextMetadata', () => {
    it('should attach task context when provided', () => {
      const taskContext = {
        taskType: 'feature' as const,
        changeKind: 'create_new' as const,
        complexity: 'm' as const,
      };

      attachTaskContextMetadata(baseRecord, taskContext);

      expect(baseRecord.taskContext).toEqual(taskContext);
    });

    it('should not modify record when taskContextData is null', () => {
      const before = { ...baseRecord };
      attachTaskContextMetadata(baseRecord, null);
      expect(baseRecord).toEqual(before);
    });
  });

  describe('attachRepoContextMetadata', () => {
    it('should attach repo context when provided', () => {
      const repoContext = {
        repoId: 'test-repo',
        primaryLanguage: 'TypeScript',
        repoVisibility: 'private' as const,
        repoSize: {
          fileCount: 100,
          locCount: 10000,
        },
      };

      attachRepoContextMetadata(baseRecord, repoContext);

      expect(baseRecord.repoContext).toEqual(repoContext);
    });

    it('should not modify record when repoContextData is null', () => {
      const before = { ...baseRecord };
      attachRepoContextMetadata(baseRecord, null);
      expect(baseRecord).toEqual(before);
    });
  });

  describe('attachExecutionEconomics', () => {
    const block = {
      schemaVersion: '1.0.0',
      providerContractVersion: 'claude-code/1',
      harness: 'claude-code' as const,
      joinEvidence: { issueId: 'HOK-2958', branch: 'task/slug' },
      sessions: [],
      sessionCount: 0,
      turnCount: 0,
      coverage: 'unavailable' as const,
      collectedAt: '2026-09-01T10:00:00Z',
    };

    it('attaches execution economics blocks when provided', () => {
      attachExecutionEconomics(baseRecord, [block]);
      expect(baseRecord.executionEconomics).toEqual([block]);
    });

    it('is a no-op for null, undefined, and empty input', () => {
      const before = { ...baseRecord };
      attachExecutionEconomics(baseRecord, null);
      attachExecutionEconomics(baseRecord, undefined);
      attachExecutionEconomics(baseRecord, []);
      expect(baseRecord).toEqual(before);
    });

    it('is wired into enrichTrainingMetadata via the metadata bag', () => {
      enrichTrainingMetadata(baseRecord, { executionEconomics: [block] });
      expect(baseRecord.executionEconomics).toEqual([block]);
    });

    it('leaves the record without the field when metadata omits it', () => {
      enrichTrainingMetadata(baseRecord, {});
      expect(baseRecord.executionEconomics).toBeUndefined();
    });
  });

  describe('attachWorkflowCostMetadata', () => {
    it('should attach workflow cost on success', () => {
      const costOutcome = {
        status: 'success' as const,
        totalCostUsd: 0.1234,
        models: {
          'claude-sonnet-4-5': {
            inputTokens: 1000,
            cacheCreationTokens: 500,
            cacheReadTokens: 2000,
            outputTokens: 500,
            costUsd: 0.1234,
          },
        },
        sessionCount: 2,
        turnCount: 10,
        pricingUsed: {},
      };

      attachWorkflowCostMetadata(baseRecord, costOutcome);

      expect(baseRecord.workflowCost).toBe(0.1234);
      expect(baseRecord.workflowTokenUsage).toEqual(costOutcome.models);
      expect(baseRecord.workflowCostStatus).toBe('success');
    });

    it('should attach native workflow cost attribution on success', () => {
      const costOutcome = {
        status: 'success' as const,
        totalCostUsd: 0,
        models: {},
        sessionCount: 1,
        turnCount: 1,
        pricingUsed: {},
        attribution: {
          source: 'native' as const,
          coverage: 'unavailable' as const,
          reason: 'missing_token_usage' as const,
          sessions: 1,
          turns: 1,
          pricedSessions: 0,
          unpricedSessions: 1,
          models: [{
            provider: 'pi',
            modelId: 'native-model',
            priced: false,
            reason: 'missing_token_usage' as const,
          }],
        },
      };

      attachWorkflowCostMetadata(baseRecord, costOutcome);

      expect(baseRecord.workflowCostAttribution).toEqual(costOutcome.attribution);
    });

    it('should attach diagnostics on failure', () => {
      const costOutcome = {
        status: 'no_sessions' as const,
        reason: 'No session files found',
        diagnostics: {
          worktreePath: '/path/to/worktree',
          branchName: 'feature-branch',
          agentType: 'claude',
          sessionFilesFound: 0,
        },
      };

      attachWorkflowCostMetadata(baseRecord, costOutcome);

      expect(baseRecord.workflowCostStatus).toBe('no_sessions');
      expect(baseRecord.workflowCostDiagnostics).toEqual({
        reason: 'No session files found',
        worktreePath: '/path/to/worktree',
        branchName: 'feature-branch',
        agentType: 'claude',
        sessionFilesFound: 0,
      });
      expect(baseRecord.workflowCost).toBeUndefined();
    });

    it('should not modify record when costOutcome is null', () => {
      const before = { ...baseRecord };
      attachWorkflowCostMetadata(baseRecord, null);
      expect(baseRecord).toEqual(before);
    });
  });

  describe('enrichTrainingMetadata', () => {
    it('attaches training metadata without warnings when all expected fields are present', () => {
      const warn = mock.method(console, 'warn', () => undefined);
      const routingDecision = {
        candidates: [{ agentType: 'codex', modelId: 'gpt-5.4' }],
        chosen: 0,
      };
      const descriptor = {
        schema_version: '1.0',
        signals: {
          heuristic: {
            task_type: 'feature',
            languages: ['typescript'],
            framework_tags: ['react'],
            files_touched: 2,
            repo_size_loc: 5000,
            description_tokens: 40,
            is_greenfield: false,
            has_migration: false,
            has_ui: false,
            has_tests: true,
            cross_service: false,
          },
          learned: {
            complexity: 0.4,
            domain: 'backend',
            risk_flags: [],
          },
        },
      };

      baseRecord.modelId = 'gpt-5.4';
      baseRecord.modelVersion = 'gpt-5.4';
      baseRecord.routingDecision = routingDecision as EvalRecord['routingDecision'];
      baseRecord.outcomes = {
        success: true,
        review: { humanReviewRequired: false, rounds: 0, approvals: 1, changeRequests: 0 },
        rework: { agentIterations: 1 },
        delivery: { prCreated: true, merged: false },
      };

      enrichTrainingMetadata(baseRecord, {
        agentType: 'codex',
        workflowCost: {
          status: 'success',
          totalCostUsd: 1.25,
          models: {
            'gpt-5.4': {
              inputTokens: 10,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
              outputTokens: 5,
              costUsd: 1.25,
            },
          },
          sessionCount: 1,
          turnCount: 2,
          pricingUsed: {},
        },
        taskDescriptor: descriptor as EvalRecord['taskDescriptor'],
        constraints: { maxCostUsd: 5 },
        difficulty: {
          difficultyBand: 'medium',
          difficultySignals: { locTouched: 10, filesTouched: 2 },
          stratum: 'ts_express_med',
        },
        taskContext: {
          taskType: 'feature',
          changeKind: 'modify_existing',
          complexity: 'm',
        },
        repoContext: {
          repoId: 'repo',
          repoVisibility: 'private',
          primaryLanguage: 'TypeScript',
          languages: { TypeScript: 100 },
          frameworks: ['React'],
          repoSize: { fileCount: 10, loc: 5000, dependencyCount: 4 },
        },
        routeProvenance: {
          activeRoute: {
            coder: 'codex',
            codeDepth: 'deep',
            reviewer: 'codex',
            reviewMode: 'full',
            source: 'expanded',
            routingMode: 'stage-aware',
            routerMode: 'normal',
          },
          routeChanged: false,
          decisionSource: 'bootstrap',
          routingMode: 'stage-aware',
          routerMode: 'normal',
        },
      });

      expect(baseRecord.workflowCost).toBe(1.25);
      expect(baseRecord.trainingEligible).toBe(true);
      expect(baseRecord.routingDecision).toEqual({
        candidates: [{ agentType: 'codex', modelId: 'gpt-5.4' }],
        chosen: 0,
        decisionPolicyVersion: 'stage-aware',
        routeArtifactSchemaVersion: '1.1',
        policyResolverVersion: '1.0.0',
        routeMode: 'stage-aware',
        operatingModeDependency: 'normal',
      });
      expect(baseRecord.enrichmentDiagnostics).toBeUndefined();
      expect(warn.mock.calls.length).toBe(0);
    });

    it('warns when workflow cost remains missing after enrichment', () => {
      const warn = mock.method(console, 'warn', () => undefined);

      enrichTrainingMetadata(baseRecord, {
        workflowCost: {
          status: 'skipped',
          reason: 'Required parameters missing: worktreePath',
          diagnostics: {
            branchName: 'task/example',
            agentType: 'codex',
          },
        },
        taskDescriptor: {
          schema_version: '1.0',
          signals: {
            heuristic: {
              task_type: 'feature',
              languages: ['typescript'],
              framework_tags: [],
              files_touched: 1,
              repo_size_loc: 100,
              description_tokens: 4,
              is_greenfield: false,
              has_migration: false,
              has_ui: false,
              has_tests: false,
              cross_service: false,
            },
          },
        } as EvalRecord['taskDescriptor'],
        constraints: { maxCostUsd: 2 },
        routeProvenance: {
          activeRoute: {
            coder: 'codex',
            codeDepth: 'deep',
            reviewer: 'codex',
            reviewMode: 'full',
          },
        },
      });

      expect(baseRecord.workflowCostStatus).toBe('skipped');
      expect(baseRecord.enrichmentDiagnostics).toContain('workflowCost');
      expect(warn.mock.calls.length).toBe(1);
      expect(String(warn.mock.calls[0].arguments[0])).toContain('workflowCost');
    });

    it('warns when task descriptor is missing and does not crash on null inputs', () => {
      const warn = mock.method(console, 'warn', () => undefined);

      expect(() =>
        enrichTrainingMetadata(baseRecord, {
          workflowCost: null,
          taskDescriptor: null,
          constraints: null,
          difficulty: null,
          taskContext: null,
          repoContext: null,
          routeProvenance: null,
        })
      ).not.toThrow();

      expect(baseRecord.taskDescriptor).toBeUndefined();
      expect(baseRecord.enrichmentDiagnostics).toContain('taskDescriptor');
      expect(warn.mock.calls.length).toBe(1);
      expect(String(warn.mock.calls[0].arguments[0])).toContain('taskDescriptor');
    });
  });

  describe('eligibility', () => {
    function makeEligibleRecord(): EvalRecord {
      return {
        ...baseRecord,
        modelId: 'gpt-5.4',
        routingDecision: {
          candidates: [{ agentType: 'codex', modelId: 'gpt-5.4' }],
          chosen: 0,
        },
        taskDescriptor: {
          schema_version: '1.0',
          signals: {
            heuristic: {
              task_type: 'feature',
              languages: ['typescript'],
              framework_tags: ['react'],
              files_touched: 2,
              repo_size_loc: 10_000,
              description_tokens: 50,
              is_greenfield: false,
              has_migration: false,
              has_ui: true,
              has_tests: true,
              cross_service: false,
            },
            learned: {
              complexity: 3,
              domain: 'frontend',
              risk_flags: [],
            },
          },
          constraints: {
            max_cost_usd: 5,
            models_available: ['gpt-5.4'],
            objective: 'balanced',
          },
          stages: {
            planner: { model: 'gpt-5.4' },
          },
        },
        workflowCost: 1.25,
        outcomes: {
          success: true,
          review: {
            humanReviewRequired: false,
            rounds: 0,
            approvals: 1,
            changeRequests: 0,
          },
          rework: {
            agentIterations: 1,
          },
          delivery: {
            prCreated: true,
            merged: false,
          },
        },
        constraints: {
          maxCostUsd: 5,
        },
      } as EvalRecord;
    }

    it('computes eligible flags for a complete record', () => {
      expect(computeEligibility(makeEligibleRecord())).toEqual({
        trainingEligible: true,
        budgetEvalEligible: true,
        eligibilityErrors: [],
      });
    });

    it('holds records that executed a provisional model identity', () => {
      const record = makeEligibleRecord();
      record.taskDescriptor!.stages!.coder = { model: 'ox-alpha' };

      // The live catalog no longer carries a provisional identity (ox-alpha
      // was disclosed as glm-5.3-flash), so pin the pre-disclosure shape in a
      // registry override to keep exercising the provisional-hold path.
      const registry = structuredClone(getEffectiveRegistry());
      const provisionalOx = registry.models['ox-alpha'];
      provisionalOx.identity = {
        ...provisionalOx.identity!,
        status: 'provisional',
        family: 'unknown',
        lineage: undefined,
      };
      attachModelIdentityAttribution(record, registry, '2026-08-22T16:00:00.000Z');
      attachEligibility(record);

      assert.equal(record.modelIdentityAttribution?.roles.coder?.alias, 'ox-alpha');
      assert.equal(record.modelIdentityAttribution?.roles.coder?.identityStatus, 'provisional');
      assert.deepEqual(record.modelIdentityAttribution?.provisionalRoles, ['coder']);
      expect(record.trainingEligible).toBe(false);
      expect(record.budgetEvalEligible).toBe(false);
      expect(record.eligibilityErrors).toContain('provisional_model_identity');
    });

    it('snapshots candidate-only provisional models without changing eligibility', () => {
      const record = makeEligibleRecord();
      record.routingDecision!.candidates!.push({ agentType: 'codex', modelId: 'ox-alpha' });
      record.taskDescriptor!.constraints!.models_available!.push('ox-alpha');

      attachModelIdentityAttribution(record, undefined, '2026-08-22T16:00:00.000Z');
      attachEligibility(record);

      assert.deepEqual(record.modelIdentityAttribution?.provisionalRoles, []);
      assert.deepEqual(record.modelIdentityAttribution?.candidateOnlyProvisional, ['ox-alpha']);
      expect(record.trainingEligible).toBe(true);
      expect(record.budgetEvalEligible).toBe(true);
      expect(record.eligibilityErrors).toEqual([]);
    });

    it('marks missing routing as a shared ineligibility reason', () => {
      const result = computeEligibility({
        ...makeEligibleRecord(),
        routingDecision: undefined,
      });

      expect(result.trainingEligible).toBe(false);
      expect(result.budgetEvalEligible).toBe(false);
      expect(result.eligibilityErrors).toContain('missing_routing');
    });

    it('marks missing workflowCost as budget eval ineligible', () => {
      const result = computeEligibility({
        ...makeEligibleRecord(),
        workflowCost: undefined,
      });

      expect(result.trainingEligible).toBe(true);
      expect(result.budgetEvalEligible).toBe(false);
      expect(result.eligibilityErrors).toContain('missing_cost');
    });

    it('sorts and deduplicates eligibility errors', () => {
      const record = {
        ...baseRecord,
        modelId: '',
      } as EvalRecord;

      expect(computeEligibility(record).eligibilityErrors).toEqual([
        'missing_budget',
        'missing_budget_snapshot',
        'missing_cost',
        'missing_model_identity',
        'missing_outcome',
        'missing_routing',
        'missing_task_descriptor',
      ]);
    });

    it('is a no-op for null records', () => {
      expect(() => attachEligibility(null)).not.toThrow();
    });

    it('is idempotent when attaching computed eligibility', () => {
      const record = makeEligibleRecord();

      attachEligibility(record);
      const once = {
        trainingEligible: record.trainingEligible,
        budgetEvalEligible: record.budgetEvalEligible,
        eligibilityErrors: record.eligibilityErrors,
      };

      attachEligibility(record);

      expect({
        trainingEligible: record.trainingEligible,
        budgetEvalEligible: record.budgetEvalEligible,
        eligibilityErrors: record.eligibilityErrors,
      }).toEqual(once);
    });

    it('clears stale validation nonRewardReason once the record validates', () => {
      const record = {
        ...makeEligibleRecord(),
        originalPrompt: 'Implement structured tweet generation.',
        modelVersion: 'gpt-5.4',
        scoreBand: 'Full Success',
        timeSeconds: 120,
        interventionRequired: false,
        interventionCount: 0,
        interventionDetails: [],
        rationale: 'Task completed successfully.',
        nonRewardReason: {
          code: 'EVAL_MISSING_TASK_DESCRIPTOR',
          message: 'Eval record is missing a valid taskDescriptor object.',
        },
      } as EvalRecord;
      delete (record as EvalRecord & { reasoning?: string }).reasoning;
      delete (record as EvalRecord & { taskPrompt?: string }).taskPrompt;
      delete (record as EvalRecord & { prReviewOutput?: string }).prReviewOutput;

      attachEligibility(record);

      expect(record.trainingEligible).toBe(true);
      expect(record.nonRewardReason).toBeUndefined();
    });

    it('preserves INVALID_CHALLENGE and ineligibility across a clean eligibility pass', () => {
      const record = {
        ...makeEligibleRecord(),
        originalPrompt: 'Implement structured tweet generation.',
        modelVersion: 'gpt-5.4',
        scoreBand: 'Full Success',
        timeSeconds: 120,
        interventionRequired: false,
        interventionCount: 0,
        interventionDetails: [],
        rationale: 'Task completed successfully.',
        invalidChallenge: true,
        trainingEligible: true,
        nonRewardReason: {
          code: 'INVALID_CHALLENGE',
          message: 'Invalid challenge: native_launch_fallback',
        },
      } as EvalRecord;
      delete (record as EvalRecord & { reasoning?: string }).reasoning;
      delete (record as EvalRecord & { taskPrompt?: string }).taskPrompt;
      delete (record as EvalRecord & { prReviewOutput?: string }).prReviewOutput;

      attachEligibility(record);

      expect(record.trainingEligible).toBe(false);
      expect(record.nonRewardReason).toEqual({
        code: 'INVALID_CHALLENGE',
        message: 'Invalid challenge: native_launch_fallback',
      });
    });

    it('does not mark valid full routeProvenance as a schema violation', () => {
      const record = makeEligibleRecord();
      record.routeProvenance = {
        decisionSource: 'expanded',
        bootstrapRoute: {
          coder: 'claude-sonnet-5',
          codeDepth: 'medium',
          reviewer: 'claude-opus-4-6',
          reviewMode: 'llm',
          planner: 'claude-sonnet-5',
          planDepth: 'deep',
          artifactPath: 'features/HOK-2071/.initial-route.json',
          artifactHash: 'a'.repeat(64),
          inputHash: 'b'.repeat(64),
          source: 'bootstrap',
          cacheHit: false,
          routeSource: 'batch',
          routerMode: 'normal',
          routingMode: 'stage-aware',
          expectedMetrics: { expectedSuccess: 0.9 },
        },
        expandedRoute: {
          coder: 'gpt-5.4',
          codeDepth: 'deep',
          reviewer: 'claude-sonnet-5',
          reviewMode: 'static',
          planner: 'gpt-5.4',
          planDepth: 'deep',
          artifactPath: 'features/HOK-2071/.post-expansion-route.json',
          artifactHash: 'c'.repeat(64),
          inputHash: 'd'.repeat(64),
          source: 'expanded',
          cacheHit: true,
          routeSource: 'cache',
          routerMode: 'survival',
          routingMode: 'stage-aware',
          expectedMetrics: { expectedSuccess: 0.95 },
        },
        activeRoute: {
          coder: 'gpt-5.4',
          codeDepth: 'deep',
          reviewer: 'claude-sonnet-5',
          reviewMode: 'static',
          planner: 'gpt-5.4',
          planDepth: 'deep',
          artifactPath: 'features/HOK-2071/.routing-complete.json',
          artifactHash: 'e'.repeat(64),
          inputHash: 'f'.repeat(64),
          source: 'active',
          cacheHit: true,
          routeSource: 'single',
          routerMode: 'constrained',
          routingMode: 'stage-aware',
          expectedMetrics: { expectedSuccess: 0.94 },
        },
        routeChanged: true,
        expandedCacheHit: true,
        packetHash: '1'.repeat(64),
        routeSource: 'cache',
        routerMode: 'survival',
        routingMode: 'stage-aware',
        artifactPath: 'features/HOK-2071',
        artifactHash: '2'.repeat(64),
      };

      attachEligibility(record);

      assert.notEqual(record.nonRewardReason?.code, 'SCHEMA_VIOLATION');
    });
  });

  describe('attachConstraints', () => {
    it('should attach maxCostUsd when provided', () => {
      attachConstraints(baseRecord, { maxCostUsd: 7.5 });
      expect(baseRecord.constraints).toEqual({ maxCostUsd: 7.5 });
    });

    it('should not attach empty constraints', () => {
      attachConstraints(baseRecord, {});
      expect(baseRecord.constraints).toBeUndefined();
    });

    it('enrichEvalRecord attaches maxCostUsd from metadata constraints', () => {
      enrichEvalRecord(baseRecord, {
        constraints: { maxCostUsd: 10 },
        provider: 'deepseek',
        endpoint: 'https://api.deepseek.com/anthropic',
      });
      expect(baseRecord.constraints).toEqual({ maxCostUsd: 10 });
      expect(baseRecord.provider).toBe('deepseek');
      expect(baseRecord.endpoint).toBe('https://api.deepseek.com/anthropic');
    });

    it('attaches budget metadata to eval and descriptor constraints', () => {
      baseRecord.taskDescriptor = {
        schema_version: '1.0',
        signals: {
          heuristic: {
            task_type: 'feature',
            languages: ['typescript'],
            framework_tags: [],
            files_touched: 1,
            repo_size_loc: 100,
            description_tokens: 10,
            is_greenfield: false,
            has_migration: false,
            has_ui: false,
            has_tests: true,
            cross_service: false,
          },
          learned: {
            complexity: 1,
            domain: 'core',
            risk_flags: [],
          },
        },
        constraints: {
          objective: 'balanced',
        },
        stages: {},
      };

      attachBudgetMetadata(baseRecord, 0);

      expect(baseRecord.constraints).toEqual({ maxCostUsd: 0 });
      expect(baseRecord.taskDescriptor.constraints.max_cost_usd).toBe(0);
      expect(baseRecord.budgetEvalEligibilityError).toBe(undefined);
    });

    it('marks missing budget without writing constraints', () => {
      baseRecord.constraints = { maxCostUsd: 4 };
      baseRecord.taskDescriptor = {
        schema_version: '1.0',
        signals: {
          heuristic: {
            task_type: 'feature',
            languages: ['typescript'],
            framework_tags: [],
            files_touched: 1,
            repo_size_loc: 100,
            description_tokens: 10,
            is_greenfield: false,
            has_migration: false,
            has_ui: false,
            has_tests: true,
            cross_service: false,
          },
          learned: {
            complexity: 1,
            domain: 'core',
            risk_flags: [],
          },
        },
        constraints: {
          max_cost_usd: 4,
          objective: 'balanced',
        },
        stages: {},
      };

      attachBudgetMetadata(baseRecord, null);

      expect(baseRecord.constraints).toBe(undefined);
      expect(baseRecord.taskDescriptor.constraints.max_cost_usd).toBe(undefined);
      expect(baseRecord.budgetEvalEligible).toBe(false);
      expect(baseRecord.budgetEvalEligibilityError).toBe('missing_budget');
      expect(baseRecord.eligibilityErrors).toContain('missing_budget');
    });
  });

  describe('attachFallbackEvent', () => {
    it('should attach fallback telemetry when provided', () => {
      const fallbackEvent = {
        schema_version: '1.0' as const,
        preferred_model: 'model-a',
        fallback_model: 'model-b',
        task_type: 'coding' as const,
        difficulty: 'hard' as const,
        quota_snapshot: {
          snapshotAt: '2026-04-18T12:00:00Z',
          models: {
            'model-a': {
              status: 'exhausted' as const,
              resetAt: null,
              remainingEstimate: null,
              confidence: 0.9,
            },
          },
        },
        human_intervention: false,
        outcome: 'success' as const,
        latency_ms: 1234,
        cost_usd: 0.42,
        fallback_chain: [{ model: 'model-a', reason: 'quota' }],
      };

      attachFallbackEvent(baseRecord, fallbackEvent);
      expect(baseRecord.fallbackEvent).toEqual(fallbackEvent);
    });

    it('should not modify record when fallback event is null', () => {
      const before = { ...baseRecord };
      attachFallbackEvent(baseRecord, null);
      expect(baseRecord).toEqual(before);
    });
  });

  describe('enrichEvalRecord', () => {
    it('attaches planCritique to the normalized plan stage outcome', () => {
      baseRecord.metadata = {
        stageScores: {
          plan: {
            score: 0.81,
            rationale: 'The plan covered the right implementation areas.',
          },
        },
        planCritique: {
          component_boundaries: {
            score: 0.9,
            rationale: 'The plan identified the correct component boundary.',
          },
          invariant_coverage: {
            score: 0.7,
            rationale: 'It captured the main compatibility invariant.',
          },
          approach_soundness: {
            score: 0.8,
            rationale: 'The proposed approach was viable.',
          },
          missed_patches: {
            score: 0.78,
            rationale: 'Implementation needed only minor follow-up fixes.',
          },
          overall: {
            score: 0.8,
            rationale: 'Overall the plan was a useful guide.',
          },
        },
      };

      enrichEvalRecord(baseRecord, {});

      expect(baseRecord.stageOutcomes?.plan).toEqual({
        score: 0.81,
        rationale: 'The plan covered the right implementation areas.',
        planCritique: baseRecord.metadata.planCritique,
      });
    });

    it('should attach all metadata when provided', () => {
      const metadata = {
        agentType: 'codex',
        difficulty: {
          difficultyBand: 'medium' as const,
          difficultySignals: {
            locTouched: 150,
            filesTouched: 5,
            diffUncertain: false,
          },
          stratum: 'stratum-2' as const,
        },
        taskContext: {
          taskType: 'feature' as const,
          changeKind: 'create_new' as const,
          complexity: 'm' as const,
        },
        repoContext: {
          repoId: 'test-repo',
          primaryLanguage: 'TypeScript',
          repoVisibility: 'private' as const,
        },
        workflowCost: {
          status: 'success' as const,
          totalCostUsd: 0.1234,
          models: {},
          sessionCount: 1,
          turnCount: 5,
        },
        fallbackEvent: {
          schema_version: '1.0' as const,
          preferred_model: 'model-a',
          fallback_model: 'model-b',
          task_type: 'coding' as const,
          difficulty: 'medium' as const,
          quota_snapshot: {
            snapshotAt: '2026-04-18T12:00:00Z',
            models: {},
          },
          human_intervention: false,
          outcome: 'success' as const,
          latency_ms: 900,
          cost_usd: 0.1234,
          fallback_chain: [{ model: 'model-a', reason: 'quota' }],
        },
        constraints: {
          maxCostUsd: 5,
        },
      };

      enrichEvalRecord(baseRecord, metadata);

      expect(baseRecord.agentType).toBe('codex');
      expect(baseRecord.difficultyBand).toBe('medium');
      expect(baseRecord.taskContext).toEqual(metadata.taskContext);
      expect(baseRecord.repoContext).toEqual(metadata.repoContext);
      expect(baseRecord.workflowCost).toBe(0.1234);
      expect(baseRecord.workflowCostStatus).toBe('success');
      expect(baseRecord.fallbackEvent).toEqual(metadata.fallbackEvent);
      expect(baseRecord.constraints).toEqual({ maxCostUsd: 5 });
    });

    it('attaches resolved-model routing decisions when provided', () => {
      enrichEvalRecord(baseRecord, {
        routing: {
          reviewer: {
            role: 'reviewer',
            requestedSelector: { kind: 'pinned', modelId: 'claude-sonnet-5' },
            resolvedModelId: 'claude-sonnet-5',
            sourceLayer: 'user',
          },
        },
      });

      expect(baseRecord.routing?.reviewer?.resolvedModelId).toBe('claude-sonnet-5');
    });

    it('should handle partial metadata gracefully', () => {
      const metadata = {
        agentType: 'claude',
        difficulty: null,
        taskContext: null,
        repoContext: null,
        workflowCost: null,
      };

      enrichEvalRecord(baseRecord, metadata);

      expect(baseRecord.agentType).toBe('claude');
      expect(baseRecord.difficultyBand).toBeUndefined();
      expect(baseRecord.taskContext).toBeUndefined();
      expect(baseRecord.repoContext).toBeUndefined();
      expect(baseRecord.workflowCost).toBeUndefined();
    });

    it('should handle empty metadata object', () => {
      const before = { ...baseRecord };
      enrichEvalRecord(baseRecord, {});

      // Only agentType gets set (defaults to 'claude')
      expect(baseRecord.agentType).toBe('claude');
      // Everything else unchanged
      expect(baseRecord.difficultyBand).toBeUndefined();
      expect(baseRecord.taskContext).toBeUndefined();
    });
  });

  describe('attachStageOutcomes rubricCriteria', () => {
    it('propagates rubricCriteria to stageOutcomes', () => {
      attachStageOutcomes(baseRecord, {
        expansion: {
          score: 0.88,
          rationale: 'Expansion was strong.',
          rubricCriteria: [
            {
              criterion: 'requirement_coverage',
              score: 0.9,
              notes: 'Requirements were covered.',
            },
          ],
        },
      });

      expect(baseRecord.stageOutcomes?.expansion?.rubricCriteria).toEqual([
        {
          criterion: 'requirement_coverage',
          score: 0.9,
          notes: 'Requirements were covered.',
        },
      ]);
    });

    it('treats undefined, null, and empty rubricCriteria as no-op', () => {
      attachStageOutcomes(baseRecord, {
        expansion: {
          score: 0.8,
          rationale: 'Undefined criteria.',
          rubricCriteria: undefined,
        },
        plan: {
          score: 0.79,
          rationale: 'Null criteria.',
          rubricCriteria: null,
        },
        implementation: {
          score: 0.82,
          rationale: 'Empty criteria.',
          rubricCriteria: [],
        },
      });

      expect(baseRecord.stageOutcomes?.expansion).not.toHaveProperty('rubricCriteria');
      expect(baseRecord.stageOutcomes?.plan).not.toHaveProperty('rubricCriteria');
      expect(baseRecord.stageOutcomes?.implementation).not.toHaveProperty('rubricCriteria');
    });

    it('enrichEvalRecord propagates rubricCriteria from metadata stageScores', () => {
      baseRecord.metadata = {
        stageScores: {
          review: {
            score: 0.84,
            rationale: 'Review checked the important risks.',
            rubricCriteria: [
              {
                criterion: 'issue_detection',
                score: 0.86,
                notes: 'Review found the relevant issue class.',
              },
            ],
          },
        },
      };

      enrichEvalRecord(baseRecord, {});

      expect(baseRecord.stageOutcomes?.review?.rubricCriteria).toEqual([
        {
          criterion: 'issue_detection',
          score: 0.86,
          notes: 'Review found the relevant issue class.',
        },
      ]);
    });
  });

  describe('attachRubricEval (HOK-1406)', () => {
    const validRubricEval: RubricEval = {
      schema_version: '1.0',
      rubric_version: '1.0',
      criteria: {
        completeness: { score: 0.9, rationale: 'All requirements met.' },
        correctness: { score: 0.95, rationale: 'No bugs found.' },
        code_quality: { score: 0.85, rationale: 'Clean code.' },
        intervention_impact: { score: 0.7, rationale: 'One fix needed.' },
        autonomy: { score: 0.75, rationale: 'Mostly autonomous.' },
      },
      determinative_boundary: 'functional_bug',
    };

    it('is a no-op when rubricEval is undefined', () => {
      const before = { ...baseRecord };
      attachRubricEval(baseRecord, undefined);
      expect(baseRecord.rubricEval).toBeUndefined();
      expect(baseRecord).toEqual(before);
    });

    it('sets record.rubricEval when provided', () => {
      attachRubricEval(baseRecord, validRubricEval);
      expect(baseRecord.rubricEval).toEqual(validRubricEval);
      expect(baseRecord.rubric_provenance).toBe('judge');
    });

    it('drops a non-string determinative_boundary before persistence (HOK-2844)', () => {
      // A judge emitting `null` (or any non-string) used to slip past the
      // string-only guard and fail write-time schema validation, discarding
      // the entire eval record.
      for (const invalid of [null, 42, ['a'], { x: 1 }]) {
        const record = { ...baseRecord } as EvalRecord;
        attachRubricEval(record, {
          ...validRubricEval,
          determinative_boundary: invalid as unknown as RubricEval['determinative_boundary'],
        });
        assert.equal(record.rubricEval?.determinative_boundary, undefined);
        assert.equal(
          Object.prototype.hasOwnProperty.call(record.rubricEval ?? {}, 'determinative_boundary'),
          false,
        );
      }
    });

    it('drops an invalid optional determinative_boundary before persistence', () => {
      attachRubricEval(baseRecord, {
        ...validRubricEval,
        determinative_boundary: 'invalid_boundary' as unknown as RubricEval['determinative_boundary'],
      });

      expect(baseRecord.rubricEval).toEqual({
        schema_version: validRubricEval.schema_version,
        rubric_version: validRubricEval.rubric_version,
        criteria: validRubricEval.criteria,
      });
      expect(baseRecord.rubricEval).not.toHaveProperty('determinative_boundary');
      expect(baseRecord.rubric_provenance).toBe('judge');
    });

    it('enrichEvalRecord leaves rubricEval undefined when not in metadata', () => {
      enrichEvalRecord(baseRecord, {});
      expect(baseRecord.rubricEval).toBeUndefined();
    });

    it('enrichEvalRecord attaches rubricEval when passed in metadata', () => {
      enrichEvalRecord(baseRecord, { rubricEval: validRubricEval });
      expect(baseRecord.rubricEval).toEqual(validRubricEval);
      expect(baseRecord.rubric_provenance).toBe('judge');
    });
  });

  describe('attachNonRewardReason', () => {
    it('is a no-op when reason is undefined or null', () => {
      attachNonRewardReason(baseRecord, undefined);
      expect(baseRecord.nonRewardReason).toBeUndefined();

      attachNonRewardReason(baseRecord, null);
      expect(baseRecord.nonRewardReason).toBeUndefined();
    });

    it('sets the nonRewardReason field when provided', () => {
      attachNonRewardReason(baseRecord, {
        code: 'INELIGIBLE_REWARD_NO_JUDGE',
        message: 'Reward not paid: record has no judge evaluation result.',
      });

      expect(baseRecord.nonRewardReason).toEqual({
        code: 'INELIGIBLE_REWARD_NO_JUDGE',
        message: 'Reward not paid: record has no judge evaluation result.',
      });
    });
  });

  describe('attachChallengeRouteContext (HOK-1515)', () => {
    const routeContext = {
      decisionSource: 'expanded' as const,
      bootstrapRoute: {
        coder: 'claude-sonnet-5',
        codeDepth: 'medium',
        reviewer: 'claude-opus-4-6',
        reviewMode: 'llm',
        planner: 'gpt-5.4',
      },
      expandedRoute: {
        coder: 'gpt-5.4',
        codeDepth: 'deep',
        reviewer: 'claude-opus-4-6',
        reviewMode: 'static',
      },
      refreshRationale: 'coder class changed',
    };

    it('is a no-op when context is undefined', () => {
      const before = { ...baseRecord };
      attachChallengeRouteContext(baseRecord, undefined);
      expect(baseRecord.challengeRouteContext).toBeUndefined();
      expect(baseRecord).toEqual(before);
    });

    it('is a no-op when context is null', () => {
      const before = { ...baseRecord };
      attachChallengeRouteContext(baseRecord, null);
      expect(baseRecord.challengeRouteContext).toBeUndefined();
      expect(baseRecord).toEqual(before);
    });

    it('attaches normalized challenge route context when provided', () => {
      attachChallengeRouteContext(baseRecord, routeContext);
      expect(baseRecord.challengeRouteContext).toEqual({
        decisionSource: 'expanded',
        bootstrapRoute: {
          coder: 'claude-sonnet-5',
          codeDepth: 'medium',
          reviewer: 'claude-opus-4-6',
          reviewMode: 'llm',
        },
        expandedRoute: {
          coder: 'gpt-5.4',
          codeDepth: 'deep',
          reviewer: 'claude-opus-4-6',
          reviewMode: 'static',
        },
        refreshRationale: 'coder class changed',
      });
    });

    it('attaches partial context when only bootstrap route is available', () => {
      attachChallengeRouteContext(baseRecord, {
        decisionSource: 'bootstrap',
        bootstrapRoute: routeContext.bootstrapRoute,
      });
      expect(baseRecord.challengeRouteContext).toEqual({
        decisionSource: 'bootstrap',
        bootstrapRoute: {
          coder: 'claude-sonnet-5',
          codeDepth: 'medium',
          reviewer: 'claude-opus-4-6',
          reviewMode: 'llm',
        },
      });
    });
  });

  describe('attachChallengeExecutionMetadata challengeStage', () => {
    function challengeIntent(overrides: Partial<ChallengeExecutionIntent> = {}): ChallengeExecutionIntent {
      return {
        pairId: 'pair-stage',
        primary: {
          key: 'HOK-2797',
          role: 'primary',
          planner: { model: 'claude-opus-4-6' },
          coder: { model: 'claude-opus-4-6' },
          reviewer: { model: 'claude-opus-4-6' },
        },
        challenger: {
          key: 'HOK-2797_c',
          role: 'challenger',
          planner: { model: 'gpt-5.4' },
          coder: { model: 'claude-opus-4-6' },
          reviewer: { model: 'claude-opus-4-6' },
        },
        ...overrides,
      };
    }

    it('hoists selectedStage to top-level challengeStage', () => {
      attachChallengeExecutionMetadata(baseRecord, {
        side: 'challenger',
        intent: challengeIntent({ selectedStage: 'plan' }),
      });

      expect(baseRecord.challengeStage).toBe('plan');
    });

    it('leaves challengeStage absent when the incoming intent has no explicit stage', () => {
      attachChallengeExecutionMetadata(baseRecord, {
        side: 'challenger',
        intent: challengeIntent(),
      });

      expect(baseRecord.challengeIntent?.challengeStage).toBe('implementation');
      expect(baseRecord.challengeStage).toBeUndefined();
    });

    it('hoists challengeStage when selectedStage is absent', () => {
      attachChallengeExecutionMetadata(baseRecord, {
        side: 'primary',
        intent: challengeIntent({ challengeStage: 'review' }),
      });

      expect(baseRecord.challengeStage).toBe('review');
    });

    it('falls back to the opposite side stage when the selected side lacks one', () => {
      attachChallengeExecutionMetadata(baseRecord, {
        side: 'primary',
        intent: challengeIntent({
          challenger: {
            key: 'HOK-2797_c',
            role: 'challenger',
            challengeStage: 'review',
            planner: { model: 'gpt-5.4' },
            coder: { model: 'claude-opus-4-6' },
            reviewer: { model: 'claude-opus-4-6' },
          },
        }),
      });

      expect(baseRecord.challengeStage).toBe('review');
    });
  });

  describe('attachRouteProvenance (HOK-1517)', () => {
    const routeProvenance = {
      decisionSource: 'expanded' as const,
      bootstrapRoute: {
        coder: 'claude-sonnet-5',
        codeDepth: 'medium',
        reviewer: 'claude-opus-4-6',
        reviewMode: 'llm',
      },
      expandedRoute: {
        coder: 'gpt-5.4',
        codeDepth: 'deep',
        reviewer: 'claude-sonnet-5',
        reviewMode: 'static',
        source: 'expanded' as const,
        routerMode: 'survival' as const,
        routingMode: 'stage-aware',
      },
      activeRoute: {
        coder: 'gpt-5.4',
        codeDepth: 'deep',
        reviewer: 'claude-sonnet-5',
        reviewMode: 'static',
        source: 'expanded' as const,
        routerMode: 'survival' as const,
        routingMode: 'stage-aware',
      },
      routeChanged: true,
      expandedCacheHit: true,
      packetHash: 'a'.repeat(64),
      routeSource: 'cache' as const,
      routerMode: 'survival' as const,
      routingMode: 'stage-aware',
    };

    it('is a no-op when provenance is undefined', () => {
      const before = { ...baseRecord };
      attachRouteProvenance(baseRecord, undefined);
      expect(baseRecord.routeProvenance).toBeUndefined();
      expect(baseRecord).toEqual(before);
    });

    it('attaches route provenance when provided', () => {
      attachRouteProvenance(baseRecord, routeProvenance);
      expect(baseRecord.routeProvenance).toEqual(routeProvenance);
    });

    it('attaches route provenance through enrichEvalRecord', () => {
      enrichEvalRecord(baseRecord, { routeProvenance });
      expect(baseRecord.routeProvenance).toEqual(routeProvenance);
    });

    it('derives routingDecision policy metadata from route provenance', () => {
      baseRecord.routingDecision = {
        candidates: [{ agentType: 'codex', modelId: 'gpt-5.4' }],
        chosen: 0,
        decisionPolicyVersion: 'baseline',
      };

      attachRouterPolicyMetadata(baseRecord, routeProvenance);

      expect(baseRecord.routingDecision).toEqual({
        candidates: [{ agentType: 'codex', modelId: 'gpt-5.4' }],
        chosen: 0,
        decisionPolicyVersion: 'stage-aware',
        routeArtifactSchemaVersion: '1.1',
        policyResolverVersion: '1.0.0',
        routeMode: 'stage-aware',
        operatingModeDependency: 'survival',
      });
    });
  });

  describe('attachExecutedPlanning (HOK-1728)', () => {
    const executedPlanning = {
      agent: 'codex',
      model: 'claude-sonnet-5',
      status: 'completed' as const,
      source: '.planning-result.json' as const,
    };

    it('is a no-op when execution provenance is undefined', () => {
      const before = { ...baseRecord };
      attachExecutedPlanning(baseRecord, undefined);
      expect(baseRecord.executedPlanning).toBeUndefined();
      expect(baseRecord).toEqual(before);
    });

    it('attaches executed planning provenance when provided', () => {
      attachExecutedPlanning(baseRecord, executedPlanning);
      expect(baseRecord.executedPlanning).toEqual(executedPlanning);
    });

    it('attaches executed planning through enrichEvalRecord', () => {
      enrichEvalRecord(baseRecord, { executedPlanning });
      expect(baseRecord.executedPlanning).toEqual(executedPlanning);
    });
  });

  describe('attachPlanningExecutionOutcome (HOK-2593)', () => {
    const planningExecutionOutcome = {
      agent: 'native',
      model: 'moonshotai/kimi-k2.7-code',
      status: 'failed' as const,
      failureReason: 'turn_limit' as const,
      planArtifactValid: false,
      approvalReady: false,
      bounds: {
        maxTurns: 40,
        maxToolCalls: 120,
        maxWallClockMs: 1200000,
      },
      usage: {
        turnsCompleted: 40,
        toolCallsExecuted: 72,
        wallClockMs: 900000,
        totalInputTokens: 1000,
        totalOutputTokens: 200,
        totalCostUsd: 0.01,
      },
      promptRef: {
        id: 'native-planning',
        version: 'sha256:test',
      },
      source: '.planning-result.json' as const,
    };

    it('is a no-op when planning outcome is undefined or null', () => {
      const before = { ...baseRecord };
      attachPlanningExecutionOutcome(baseRecord, undefined);
      attachPlanningExecutionOutcome(baseRecord, null);
      expect(baseRecord.planningExecutionOutcome).toBeUndefined();
      expect(baseRecord).toEqual(before);
    });

    it('attaches structured planning outcome when provided', () => {
      attachPlanningExecutionOutcome(baseRecord, planningExecutionOutcome);
      expect(baseRecord.planningExecutionOutcome).toEqual(planningExecutionOutcome);
    });

    it('sanitizes malformed nested fields', () => {
      attachPlanningExecutionOutcome(baseRecord, {
        agent: '',
        model: 'model-a',
        status: 'failed',
        failureReason: 'turn_limit',
        bounds: { maxTurns: -1, maxToolCalls: 12 },
        usage: { turnsCompleted: 3, totalCostUsd: Number.NaN },
        promptRef: { id: 'prompt', version: '' },
        source: '.planning-result.json',
      });

      expect(baseRecord.planningExecutionOutcome).toEqual({
        model: 'model-a',
        status: 'failed',
        failureReason: 'turn_limit',
        bounds: { maxToolCalls: 12 },
        usage: { turnsCompleted: 3 },
        source: '.planning-result.json',
      });
    });

    it('attaches planning outcome through both enrichment paths', () => {
      enrichEvalRecord(baseRecord, { planningExecutionOutcome });
      expect(baseRecord.planningExecutionOutcome).toEqual(planningExecutionOutcome);

      baseRecord = { id: 'test-id' } as EvalRecord;
      enrichTrainingMetadata(baseRecord, { planningExecutionOutcome });
      expect(baseRecord.planningExecutionOutcome).toEqual(planningExecutionOutcome);
    });
  });

  describe('attachPhaseDurations', () => {
    it('is a no-op when durations are undefined', () => {
      const before = { ...baseRecord };
      attachPhaseDurations(baseRecord, undefined);
      expect(baseRecord.phaseDurationsSeconds).toBeUndefined();
      expect(baseRecord).toEqual(before);
    });

    it('attaches per-phase durations when provided', () => {
      attachPhaseDurations(baseRecord, {
        planning: 120,
        coding: 480,
        review: 60,
        total: 660,
      });

      expect(baseRecord.phaseDurationsSeconds).toEqual({
        planning: 120,
        coding: 480,
        review: 60,
        total: 660,
      });
    });
  });

  describe('route prediction and calibration', () => {
    it('attaches route prediction and calibration helpers', () => {
      attachRoutePrediction(baseRecord, {
        expectedSuccess: 0.8,
        expectedCostUsd: 4.25,
        confidence: 0.7,
        riskScore: 1.5,
        taskType: 'feature',
        taskDifficulty: 'medium',
        topFeatures: ['risk', 'cost'],
        rationaleSummary: 'balanced route',
      });

      const calibration = computeRouteCalibration({
        workflowCost: 3.5,
        outcomes: { success: true },
        timeSeconds: 12,
        interventionCount: 1,
      } as EvalRecord, baseRecord.routePrediction);
      attachRouteCalibration(baseRecord, calibration);

      expect(baseRecord.routePrediction).toEqual({
        expectedSuccess: 0.8,
        expectedCostUsd: 4.25,
        confidence: 0.7,
        riskScore: 1.5,
        taskType: 'feature',
        taskDifficulty: 'medium',
        topFeatures: ['risk', 'cost'],
        rationaleSummary: 'balanced route',
      });
      expect(baseRecord.routeCalibration).toEqual({
        predictedSuccess: 0.8,
        actualSuccess: true,
        predictedCostUsd: 4.25,
        actualCostUsd: 3.5,
        interventionCount: 1,
        durationMs: 12000,
        successDelta: 0.2,
        costErrorUsd: 0.75,
      });
    });

    it('leaves existing prediction unchanged on empty helper input', () => {
      baseRecord.routePrediction = { expectedSuccess: 0.5 };
      attachRoutePrediction(baseRecord, undefined);
      expect(baseRecord.routePrediction).toEqual({ expectedSuccess: 0.5 });
    });
  });

  describe('attachFeatureOutcomeDiagnostics (HOK-2262)', () => {
    it('attaches valid diagnostics to the record', () => {
      const diag = {
        present: true,
        valid: true,
        used: true,
        sourceFile: 'feature-state.json',
        sourceHash: 'a'.repeat(64),
        reason: 'loaded' as const,
        eligibilityDiagnostic: 'eligible' as const,
        missingFields: [],
        invalidFields: [],
        conflictsWithReconstruction: false,
      };
      attachFeatureOutcomeDiagnostics(baseRecord, diag);
      assert.deepEqual(baseRecord.featureOutcomeDiagnostics, diag);
    });

    it('does nothing when diagnostics is null', () => {
      delete baseRecord.featureOutcomeDiagnostics;
      attachFeatureOutcomeDiagnostics(baseRecord, null);
      assert.equal(baseRecord.featureOutcomeDiagnostics, undefined);
    });

    it('does nothing when diagnostics is undefined', () => {
      delete baseRecord.featureOutcomeDiagnostics;
      attachFeatureOutcomeDiagnostics(baseRecord, undefined);
      assert.equal(baseRecord.featureOutcomeDiagnostics, undefined);
    });

    it('overwrites existing diagnostics when called again', () => {
      const first = {
        present: false,
        valid: false,
        used: false,
        reason: 'artifact_absent' as const,
        eligibilityDiagnostic: 'unknown' as const,
      };
      const second = {
        present: true,
        valid: true,
        used: true,
        sourceFile: 'feature-state.json',
        sourceHash: 'b'.repeat(64),
        reason: 'loaded' as const,
        eligibilityDiagnostic: 'eligible' as const,
      };
      attachFeatureOutcomeDiagnostics(baseRecord, first);
      attachFeatureOutcomeDiagnostics(baseRecord, second);
      assert.equal(baseRecord.featureOutcomeDiagnostics?.present, true);
      assert.equal(baseRecord.featureOutcomeDiagnostics?.sourceHash, 'b'.repeat(64));
    });

    it('enrichTrainingMetadata threads featureOutcomeDiagnostics onto record', () => {
      const diag = {
        present: true,
        valid: true,
        used: true,
        sourceFile: 'feature-state.json',
        sourceHash: 'c'.repeat(64),
        reason: 'loaded' as const,
        eligibilityDiagnostic: 'eligible' as const,
        missingFields: [],
        invalidFields: [],
      };
      enrichTrainingMetadata(baseRecord, { featureOutcomeDiagnostics: diag });
      assert.equal(baseRecord.featureOutcomeDiagnostics?.present, true);
      assert.equal(baseRecord.featureOutcomeDiagnostics?.sourceHash, 'c'.repeat(64));
    });
  });
});
