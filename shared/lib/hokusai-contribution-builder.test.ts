import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildTechnicalTaskRouterRowV4,
  deriveOutcomeLabels,
} from './hokusai-contribution-builder.ts';
import type {
  RedactedEvalContributionProjectionV4,
  StageExecutionProjection,
} from './hokusai-contribution-builder.ts';

// The v4 builder internally runs the v3 shape check, which requires
// taskDescriptor/allowedModels/selectedModels. These are the minimum shape
// each builder call needs; tests override individual fields.
const BASE_DESCRIPTOR = {
  language: 'typescript',
  framework: 'none',
  task_family: 'feature',
  reasoning_depth: 'medium',
  repository_scale: 'small',
} as const;

const BASE_SELECTED = {
  coder: 'claude-sonnet-5.5',
  reviewer: 'claude-sonnet-5.5',
};

function makeStageExecution(
  overrides: Partial<StageExecutionProjection> = {},
): StageExecutionProjection {
  return {
    stage: 'coding',
    executedModel: BASE_SELECTED.coder,
    modelEvidence: 'provider_response',
    harness: 'claude-code',
    // Empty summaries → the builder auto-fills an `unavailable` task_cost
    // summary whose `task_id` matches the row's taskId. That satisfies the v4
    // validator's `task_cost.task_id === row.task_id` rule without wiring up a
    // full event ledger inside a unit test.
    cost: { summaries: [] },
    ...overrides,
  };
}

function makeProjection(
  overrides: Partial<RedactedEvalContributionProjectionV4> = {},
): RedactedEvalContributionProjectionV4 {
  return {
    taskId: 'redacted-task',
    runId: 'redacted-run',
    harness: 'wavemill',
    observedAt: '2026-10-31T12:00:00.000Z',
    observedSuccess: true,
    budgetCompliant: true,
    actualCostUsd: 0.42,
    wallClockSeconds: 30,
    taskDescriptor: { ...BASE_DESCRIPTOR },
    allowedModels: [BASE_SELECTED.coder, BASE_SELECTED.reviewer],
    selectedModels: { ...BASE_SELECTED },
    stageExecutions: [makeStageExecution()],
    ...overrides,
  };
}

describe('hokusai-contribution-builder (v4)', () => {
  it('builds a minimal v4 row from one stage execution', () => {
    const row = buildTechnicalTaskRouterRowV4(makeProjection());
    assert.equal(row.schema_version, 'technical_task_router_row/v4');
    assert.equal(row.stage_executions.length, 1);
    assert.equal(row.stage_executions[0].stage, 'coding');
    assert.equal(row.stage_executions[0].executed_model, BASE_SELECTED.coder);
    assert.equal(row.stage_executions[0].model_evidence, 'provider_response');
    assert.equal(row.stage_executions[0].harness, 'claude-code');
    // Every stage carries a task_cost — the builder auto-fills an unavailable
    // summary when no events were measured.
    assert.equal(row.stage_executions[0].task_cost.task_id, 'redacted-task');
    assert.equal(row.stage_executions[0].task_cost.coverage, 'unavailable');
  });

  it('refuses a projection without any stage executions', () => {
    assert.throws(
      () => buildTechnicalTaskRouterRowV4(makeProjection({ stageExecutions: [] })),
      /stageExecutions must list at least one stage/,
    );
  });

  it('refuses a projection without taskId', () => {
    assert.throws(
      () =>
        buildTechnicalTaskRouterRowV4(
          makeProjection({ taskId: '' as unknown as string }),
        ),
      /taskId is required/,
    );
  });

  it('[REQ-F1] builds a challenge pair with matching comparison_group', () => {
    const pairId = '01a1a6d0-0000-7000-8000-000000000001';
    const primary = buildTechnicalTaskRouterRowV4(
      makeProjection({
        taskId: 'redacted-primary',
        stageExecutions: [
          makeStageExecution({ stage: 'coding', executedModel: 'claude-opus-4-7' }),
        ],
        selectedModels: { coder: 'claude-opus-4-7', reviewer: BASE_SELECTED.reviewer },
        allowedModels: ['claude-opus-4-7', BASE_SELECTED.reviewer],
        comparisonGroup: { id: pairId, roleVaried: 'coder' },
      }),
    );
    const challenger = buildTechnicalTaskRouterRowV4(
      makeProjection({
        taskId: 'redacted-primary_c',
        stageExecutions: [
          makeStageExecution({ stage: 'coding', executedModel: 'claude-haiku-4-5' }),
        ],
        selectedModels: { coder: 'claude-haiku-4-5', reviewer: BASE_SELECTED.reviewer },
        allowedModels: ['claude-haiku-4-5', BASE_SELECTED.reviewer],
        comparisonGroup: { id: pairId, roleVaried: 'coder' },
      }),
    );
    assert.equal(primary.comparison_group?.id, pairId);
    assert.equal(challenger.comparison_group?.id, pairId);
    assert.equal(primary.comparison_group?.role_varied, 'coder');
    assert.equal(challenger.comparison_group?.role_varied, 'coder');
    assert.notEqual(
      primary.stage_executions[0].executed_model,
      challenger.stage_executions[0].executed_model,
    );
  });

  it('[REQ-F2] ci-fix is a separate stage execution from coding', () => {
    const row = buildTechnicalTaskRouterRowV4(
      makeProjection({
        stageExecutions: [
          makeStageExecution({ stage: 'coding', harness: 'claude-code' }),
          makeStageExecution({
            stage: 'ci-fix',
            harness: 'codex',
            executedModel: 'codex-mini',
            modelEvidence: 'requested_only',
            sessionIds: ['sess-ci-1'],
          }),
        ],
      }),
    );

    assert.equal(row.stage_executions.length, 2);
    const coding = row.stage_executions.find((entry) => entry.stage === 'coding');
    const ciFix = row.stage_executions.find((entry) => entry.stage === 'ci-fix');
    assert.ok(coding, 'coding stage present');
    assert.ok(ciFix, 'ci-fix stage present');
    assert.equal(ciFix!.harness, 'codex');
    assert.equal(ciFix!.executed_model, 'codex-mini');
    // The two stages are independent: the ci-fix harness/model does not leak
    // into the coding stage entry.
    assert.equal(coding!.harness, 'claude-code');
    assert.notEqual(coding!.executed_model, ciFix!.executed_model);
  });

  it('[REQ-F2] a stage that reaches the builder pre-aggregated produces one entry', () => {
    // The v4 builder itself takes one summary per (stage, harness). Multiple
    // sessions for the same ci-fix invocation reach it already aggregated
    // upstream (groupByKind in the meter), so the builder emits one entry,
    // never a third.
    const row = buildTechnicalTaskRouterRowV4(
      makeProjection({
        stageExecutions: [
          makeStageExecution({ stage: 'coding', harness: 'claude-code' }),
          makeStageExecution({
            stage: 'ci-fix',
            harness: 'codex',
            executedModel: 'codex-mini',
            modelEvidence: 'requested_only',
          }),
        ],
      }),
    );
    const ciFixEntries = row.stage_executions.filter((entry) => entry.stage === 'ci-fix');
    assert.equal(ciFixEntries.length, 1);
  });

  it('carries requested_only evidence through for repair stages', () => {
    const row = buildTechnicalTaskRouterRowV4(
      makeProjection({
        stageExecutions: [
          makeStageExecution({ stage: 'coding' }),
          makeStageExecution({
            stage: 'ready-remediation',
            harness: 'claude-code',
            modelEvidence: 'requested_only',
          }),
        ],
      }),
    );
    const remediation = row.stage_executions.find(
      (entry) => entry.stage === 'ready-remediation',
    );
    assert.ok(remediation);
    assert.equal(remediation!.model_evidence, 'requested_only');
  });

  it('derives outcome labels from observed cost and time', () => {
    const labels = deriveOutcomeLabels({
      observedAt: '2026-10-31T12:00:00.000Z',
      observedSuccess: false,
      budgetCompliant: false,
      actualCostUsd: 6,
      wallClockSeconds: 3600,
      budgetUsd: 2,
    });

    assert.equal(labels.budget_label, 'over_budget');
    assert.equal(labels.cost_label, 'high');
    assert.equal(labels.time_label, 'slow');
    assert.equal(labels.success_label, 'failure');
  });
});
