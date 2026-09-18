import assert from 'node:assert/strict';
import type {
  EvalExecutionEconomics,
  EvalRecord,
  ResolvedModelRoutingDecision,
  RoutingRole,
} from './eval-schema.ts';
import {
  buildSubagentEconomicsReport,
  buildSubagentEconomicsWorkflowReport,
  runSubagentEconomicsShadowPolicy,
} from './subagent-economics-policy.ts';
import type { WorkflowRouteDecision } from './workflow-router.ts';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(err as Error).message}`);
  }
}

async function testAsync(name: string, fn: () => Promise<void>) {
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

function routeDecision(overrides: Partial<WorkflowRouteDecision> = {}): WorkflowRouteDecision {
  return {
    planner: 'planner-a',
    coder: 'coder-a',
    reviewer: 'reviewer-a',
    planDepth: 'medium',
    codeDepth: 'medium',
    reviewRecommended: 'llm',
    expectedSuccess: 0.84,
    expectedCostPlan: 1,
    expectedCostCode: 3,
    expectedCostReview: 1,
    confidence: 0.72,
    reasoning: ['fixture'],
    signals: {
      taskType: 'feature',
      promptLength: 'medium',
      complexityScore: 3,
      fileTypes: ['ts'],
      riskScore: 0.2,
    },
    routingMode: 'stage-aware',
    ...(overrides as WorkflowRouteDecision),
  };
}

function routingDecision(role: RoutingRole, model: string): ResolvedModelRoutingDecision {
  return {
    role,
    requestedSelector: { kind: 'pinned', modelId: model },
    resolvedModelId: model,
    sourceLayer: 'fixture',
    resolutionSource: 'routing',
  };
}

function evalRecord(overrides: Partial<EvalRecord> = {}): EvalRecord {
  return {
    id: 'eval-1',
    schemaVersion: '1.49.0',
    originalPrompt: 'Implement a feature',
    modelId: 'coder-a',
    modelVersion: 'coder-a',
    score: 1,
    scoreBand: 'Full Success',
    timeSeconds: 12,
    timestamp: '2026-09-01T00:00:00.000Z',
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'ok',
    issueId: 'HOK-1',
    workflowCost: 4,
    workflowCostAttribution: {
      source: 'native',
      coverage: 'complete',
      sessions: 3,
      turns: 12,
      pricedSessions: 3,
      unpricedSessions: 0,
      models: [],
    },
    constraints: { maxCostUsd: 10 },
    routing: {
      planner: routingDecision('planner', 'planner-a'),
      coder: routingDecision('coder', 'coder-a'),
      reviewer: routingDecision('reviewer', 'reviewer-a'),
    },
    outcomes: {
      success: true,
      review: {
        humanReviewRequired: false,
        rounds: 0,
        approvals: 0,
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
    ...overrides,
  };
}

function executionEconomics(executed: {
  planner?: string;
  coder?: string;
  reviewer?: string;
}): EvalExecutionEconomics {
  return {
    schemaVersion: '1.0.0',
    providerContractVersion: 'claude-code/1',
    harness: 'claude-code',
    joinEvidence: { issueId: 'HOK-1', branch: 'task/hok-1' },
    sessionCount: Object.values(executed).filter(Boolean).length,
    turnCount: 3,
    coverage: 'complete',
    collectedAt: '2026-09-01T00:00:00.000Z',
    sessions: Object.entries(executed).map(([role, model]) => ({
      sessionId: `session-${role}`,
      rootSessionId: null,
      harnessVersion: '1.0.0',
      triggerSource: { value: 'fixture', provenance: 'test', availability: 'available' },
      stageRole: {
        value: role === 'planner' ? 'planning' : role === 'coder' ? 'coding' : 'review',
        confidence: 'branch_worktree',
        evidence: 'fixture',
      },
      models: {
        requested: model,
        forced: null,
        resolved: model,
        executed: model,
        provenance: { resolved: 'routing', executed: 'telemetry' },
      },
      turnCount: 1,
      turns: [],
      turnsTruncated: false,
      modelSegments: [{ model: model as string, turnCount: 1 }],
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: null,
      },
      actualCostUsd: 1,
      estimatedCostUsd: 1,
      costSource: 'provider_reported',
      pricingRevision: null,
      pricingTimestamp: null,
      coverage: 'complete',
      fieldAvailability: {},
      diagnostics: [],
    })),
  };
}

test('reports eligible agreement without mutating actual route', () => {
  const decision = routeDecision({
    neighborCount: 12,
    neighborSimilarityRange: [0.7, 0.96],
  } as Partial<WorkflowRouteDecision>);
  const report = buildSubagentEconomicsWorkflowReport({
    record: evalRecord(),
    proposedDecision: decision,
    modelsAvailable: ['planner-a', 'coder-a', 'reviewer-a'],
  });

  assert.equal(report.agreement, true);
  assert.deepEqual(report.abstentionReasons, []);
  assert.equal(report.coverage.executedModelIdentity, 'exact');
  assert.equal(report.coverage.cost, 'complete');
  assert.equal(report.observationalDelta?.label, 'non_causal_observational');
  assert.equal(report.recommendation.gate, 'collect_more_data');
});

test('reports observational disagreement without a savings claim', () => {
  const report = buildSubagentEconomicsWorkflowReport({
    record: evalRecord({
      routing: {
        planner: routingDecision('planner', 'planner-b'),
        coder: routingDecision('coder', 'coder-b'),
        reviewer: routingDecision('reviewer', 'reviewer-b'),
      },
    }),
    proposedDecision: routeDecision({
      neighborCount: 8,
      neighborSimilarityRange: [0.65, 0.91],
    } as Partial<WorkflowRouteDecision>),
  });

  assert.equal(report.agreement, false);
  assert.equal(report.evidenceKind, 'observational');
  assert.equal(report.observationalDelta?.label, 'non_causal_observational');
  assert.equal(JSON.stringify(report).includes('saved'), false);
});

test('abstains when exact executed-role identity is missing', () => {
  const report = buildSubagentEconomicsWorkflowReport({
    record: evalRecord({ routing: undefined }),
    proposedDecision: routeDecision({
      neighborCount: 8,
      neighborSimilarityRange: [0.65, 0.91],
    } as Partial<WorkflowRouteDecision>),
  });

  assert.equal(report.actual.assignment, null);
  assert.equal(report.coverage.executedModelIdentity, 'missing');
  assert.ok(report.abstentionReasons.includes('missing_executed_model_identity'));
});

test('abstains on routing versus execution-economics identity conflict', () => {
  const report = buildSubagentEconomicsWorkflowReport({
    record: evalRecord({
      executionEconomics: [
        executionEconomics({
          planner: 'planner-a',
          coder: 'coder-conflict',
          reviewer: 'reviewer-a',
        }),
      ],
    }),
    proposedDecision: routeDecision({
      neighborCount: 8,
      neighborSimilarityRange: [0.65, 0.91],
    } as Partial<WorkflowRouteDecision>),
  });

  assert.equal(report.coverage.executedModelIdentity, 'conflict');
  assert.ok(report.abstentionReasons.includes('executed_model_identity_conflict'));
  assert.equal(report.recommendation.gate, 'stop');
});

test('abstains when cost coverage or budget is missing', () => {
  const report = buildSubagentEconomicsWorkflowReport({
    record: evalRecord({
      workflowCost: undefined,
      estimatedCost: undefined,
      workflowCostAttribution: {
        source: 'native',
        coverage: 'partial',
        sessions: 2,
        turns: 4,
        pricedSessions: 1,
        unpricedSessions: 1,
        models: [],
      },
      constraints: undefined,
    }),
    proposedDecision: routeDecision({
      neighborCount: 8,
      neighborSimilarityRange: [0.65, 0.91],
    } as Partial<WorkflowRouteDecision>),
  });

  assert.ok(report.abstentionReasons.includes('missing_cost_coverage'));
  assert.ok(report.abstentionReasons.includes('partial_cost_coverage'));
  assert.ok(report.abstentionReasons.includes('missing_budget'));
});

test('abstains when numeric cost lacks comparable coverage', () => {
  const report = buildSubagentEconomicsWorkflowReport({
    record: evalRecord({
      workflowCost: 4,
      workflowCostAttribution: undefined,
      executionEconomics: undefined,
    }),
    proposedDecision: routeDecision({
      neighborCount: 8,
      neighborSimilarityRange: [0.65, 0.91],
    } as Partial<WorkflowRouteDecision>),
  });

  assert.equal(report.coverage.cost, 'unknown');
  assert.ok(report.abstentionReasons.includes('missing_cost_coverage'));
});

test('abstains when execution economics cannot attribute a role', () => {
  const economics = executionEconomics({
    planner: 'planner-a',
    coder: 'coder-a',
    reviewer: 'reviewer-a',
  });
  economics.sessions[1].stageRole.confidence = 'unattributed';

  const report = buildSubagentEconomicsWorkflowReport({
    record: evalRecord({ executionEconomics: [economics] }),
    proposedDecision: routeDecision({
      neighborCount: 8,
      neighborSimilarityRange: [0.65, 0.91],
    } as Partial<WorkflowRouteDecision>),
  });

  assert.equal(report.coverage.executedModelIdentity, 'missing');
  assert.ok(report.abstentionReasons.includes('missing_executed_model_identity'));
});

test('suppresses sparse and low-confidence cells', () => {
  const report = buildSubagentEconomicsWorkflowReport({
    record: evalRecord(),
    proposedDecision: routeDecision({
      confidence: 0.4,
      neighborCount: 1,
      neighborSimilarityRange: [0.1, 0.2],
    } as Partial<WorkflowRouteDecision>),
  });

  assert.ok(report.abstentionReasons.includes('low_confidence'));
  assert.ok(report.abstentionReasons.includes('sparse_strata'));
  assert.equal(report.proposed.uncertainty.lowConfidence, true);
  assert.equal(report.proposed.uncertainty.sparse, true);
});

test('includes paired replay evidence only when both arms are covered', () => {
  const primary = evalRecord({
    id: 'primary',
    challengePairId: 'pair-1',
    challengeSide: 'primary',
  });
  const challenger = evalRecord({
    id: 'challenger',
    challengePairId: 'pair-1',
    challengeSide: 'challenger',
    workflowCost: 6,
    score: 0,
    scoreBand: 'Failure',
    outcomes: {
      success: false,
      review: { humanReviewRequired: true, rounds: 1, approvals: 0, changeRequests: 1 },
      rework: { agentIterations: 2 },
      delivery: { prCreated: false, merged: false },
    },
    routing: {
      planner: routingDecision('planner', 'planner-b'),
      coder: routingDecision('coder', 'coder-b'),
      reviewer: routingDecision('reviewer', 'reviewer-b'),
    },
  });
  const report = buildSubagentEconomicsWorkflowReport({
    record: primary,
    proposedDecision: routeDecision({
      neighborCount: 8,
      neighborSimilarityRange: [0.65, 0.91],
    } as Partial<WorkflowRouteDecision>),
    pairedRecords: [challenger],
  });

  assert.equal(report.evidenceKind, 'paired_replay');
  assert.equal(report.pairedEvidence?.pairId, 'pair-1');
  assert.equal(report.pairedEvidence?.actualArms.length, 2);
  assert.equal(report.recommendation.gate, 'proceed');
});

test('summary recommends collecting data without paired evidence', () => {
  const report = buildSubagentEconomicsReport([
    buildSubagentEconomicsWorkflowReport({
      record: evalRecord(),
      proposedDecision: routeDecision({
        neighborCount: 8,
        neighborSimilarityRange: [0.65, 0.91],
      } as Partial<WorkflowRouteDecision>),
    }),
  ], '2026-09-01T00:00:00.000Z');

  assert.equal(report.summary.totalWorkflows, 1);
  assert.equal(report.summary.eligibleWorkflows, 1);
  assert.equal(report.summary.recommendation.gate, 'collect_more_data');
  assert.equal(report.summary.pairedEvidenceCount, 0);
});

testAsync('runSubagentEconomicsShadowPolicy can use an injected route decision function', async () => {
  const report = await runSubagentEconomicsShadowPolicy({
    repoDir: process.cwd(),
    record: evalRecord(),
    prompt: 'Implement a fixture feature',
    routeBatchImpl: async () => [{
      task: { issueId: 'HOK-1', prompt: 'Implement a fixture feature' },
      decision: routeDecision({
        neighborCount: 8,
        neighborSimilarityRange: [0.65, 0.91],
      } as Partial<WorkflowRouteDecision>),
    }],
  });

  assert.equal(report.proposed.assignment?.coder, 'coder-a');
  assert.equal(report.abstentionReasons.length, 0);
});

process.on('exit', () => {
  console.log(`\nSubagent economics policy tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
});
