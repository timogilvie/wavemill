import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  reconcileRoute,
  renderExecutedRoute,
  isRouteReadyGateComplete,
  ROUTE_SCHEMA_VERSION,
  type ReconcileInput,
  type ExecutedRoutePublic,
} from './pr-route-provenance.ts';
import type { StageResult } from './stage-result.ts';

function makeStageResult(overrides: Partial<StageResult> = {}): StageResult {
  return {
    stage: 'planning',
    status: 'completed',
    startedAt: '2026-09-15T00:00:00Z',
    finishedAt: '2026-09-15T00:01:00Z',
    agent: 'claude',
    model: 'claude-opus-5',
    executedModel: 'claude-opus-5',
    executionEvidence: { status: 'direct', source: 'native-runtime' },
    ...overrides,
  } as StageResult;
}

describe('reconcileRoute', () => {
  it('produces executed entries for three successful stage results', () => {
    const input: ReconcileInput = {
      issueId: 'HOK-1234',
      prHeadSha: 'abc123',
      stageResults: {
        planning: makeStageResult({ stage: 'planning', executedModel: 'claude-opus-5', agent: 'claude' }),
        coding: makeStageResult({ stage: 'coding', executedModel: 'claude-fable-5', agent: 'claude' }),
        review: makeStageResult({ stage: 'review', executedModel: 'gpt-5.5', agent: 'native' }),
      },
    };

    const { route, diagnostics } = reconcileRoute(input);

    assert.equal(route.head_sha, 'abc123');
    assert.equal(route.planner.status, 'executed');
    assert.equal(route.planner.model, 'claude-opus-5');
    assert.equal(route.coder.status, 'executed');
    assert.equal(route.coder.model, 'claude-fable-5');
    assert.equal(route.reviewer.status, 'executed');
    assert.equal(route.reviewer.model, 'gpt-5.5');
    assert.equal(diagnostics.length, 0);
  });

  it('marks missing stage results as unknown with diagnostic', () => {
    const input: ReconcileInput = {
      issueId: 'HOK-1234',
      prHeadSha: 'abc123',
      stageResults: {
        planning: makeStageResult({ stage: 'planning' }),
      },
    };

    const { route, diagnostics } = reconcileRoute(input);

    assert.equal(route.planner.status, 'executed');
    assert.equal(route.coder.status, 'unknown');
    assert.equal(route.reviewer.status, 'unknown');
    assert.ok(diagnostics.some((d) => d.includes('coder')));
    assert.ok(diagnostics.some((d) => d.includes('reviewer')));
  });

  it('marks failed/aborted stages as not_run', () => {
    const input: ReconcileInput = {
      issueId: 'HOK-1234',
      prHeadSha: 'abc123',
      stageResults: {
        planning: makeStageResult({ stage: 'planning', status: 'failed' }),
        coding: makeStageResult({ stage: 'coding', status: 'aborted' }),
        review: makeStageResult({ stage: 'review' }),
      },
    };

    const { route } = reconcileRoute(input);

    assert.equal(route.planner.status, 'not_run');
    assert.equal(route.coder.status, 'not_run');
    assert.equal(route.reviewer.status, 'executed');
  });

  it('marks inherited stages', () => {
    const input: ReconcileInput = {
      issueId: 'HOK-1234',
      prHeadSha: 'abc123',
      stageResults: {
        review: makeStageResult({ stage: 'review' }),
      },
      inheritedStages: [
        { stage: 'planning', sourceIssue: 'HOK-1000', sourceHeadSha: 'def456' },
        { stage: 'coding', sourceIssue: 'HOK-1000', sourceHeadSha: 'def456' },
      ],
    };

    const { route } = reconcileRoute(input);

    assert.equal(route.planner.status, 'inherited');
    assert.deepEqual(route.planner.inherited_from, { issue: 'HOK-1000', head_sha: 'def456' });
    assert.equal(route.coder.status, 'inherited');
    assert.equal(route.reviewer.status, 'executed');
  });

  it('marks contradicted evidence as unknown', () => {
    const input: ReconcileInput = {
      issueId: 'HOK-1234',
      prHeadSha: 'abc123',
      stageResults: {
        planning: makeStageResult({
          stage: 'planning',
          executionEvidence: { status: 'contradicted', source: 'test' },
        }),
        coding: makeStageResult({ stage: 'coding' }),
        review: makeStageResult({ stage: 'review' }),
      },
    };

    const { route, diagnostics } = reconcileRoute(input);

    assert.equal(route.planner.status, 'unknown');
    assert.ok(diagnostics.some((d) => d.includes('contradicted')));
  });

  it('includes reviewer identities from review executed identity set', () => {
    const input: ReconcileInput = {
      issueId: 'HOK-1234',
      prHeadSha: 'abc123',
      stageResults: {
        planning: makeStageResult({ stage: 'planning' }),
        coding: makeStageResult({ stage: 'coding' }),
        review: makeStageResult({
          stage: 'review',
          executedModel: 'claude-haiku-4-5-20251001',
          artifacts: {
            type: 'review',
            reviewExecutedIdentity: {
              orchestrator: {
                role: 'review_orchestrator',
                requestedModel: 'claude-haiku-4-5-20251001',
                resolvedModel: 'claude-haiku-4-5-20251001',
                source: 'route',
                pinned: true,
              },
              substantiveAnalysis: {
                role: 'substantive_analysis',
                requestedModel: 'gemini-2.5-pro',
                resolvedModel: 'gemini-2.5-pro',
                source: 'derived',
                pinned: false,
              },
            },
          },
        }),
      },
    };

    const { route } = reconcileRoute(input);

    assert.equal(route.reviewer.status, 'executed');
    assert.equal(route.reviewer.model, 'gemini-2.5-pro');
    assert.ok(route.reviewer.identities);
    assert.equal(route.reviewer.identities!.orchestrator!.model, 'claude-haiku-4-5-20251001');
    assert.equal(route.reviewer.identities!.orchestrator!.pinned, true);
    assert.equal(route.reviewer.identities!.substantive_analysis!.model, 'gemini-2.5-pro');
    assert.equal(route.reviewer.identities!.substantive_analysis!.pinned, false);
  });

  it('includes requested_selector when intended differs from executed', () => {
    const input: ReconcileInput = {
      issueId: 'HOK-1234',
      prHeadSha: 'abc123',
      stageResults: {
        planning: makeStageResult({
          stage: 'planning',
          intendedModel: 'model-a',
          executedModel: 'model-b',
        }),
        coding: makeStageResult({ stage: 'coding' }),
        review: makeStageResult({ stage: 'review' }),
      },
    };

    const { route } = reconcileRoute(input);

    assert.equal(route.planner.model, 'model-b');
    assert.equal(route.planner.requested_selector, 'model-a');
  });
});

describe('renderExecutedRoute', () => {
  it('produces deterministic single-line JSON', () => {
    const route: ExecutedRoutePublic = {
      head_sha: 'abc123',
      planner: { status: 'executed', model: 'claude-opus-5' },
      coder: { status: 'executed', model: 'claude-fable-5' },
      reviewer: { status: 'executed', model: 'gpt-5.5' },
    };
    const json = renderExecutedRoute(route);
    assert.ok(!json.includes('\n'));
    const parsed = JSON.parse(json) as ExecutedRoutePublic;
    assert.equal(parsed.head_sha, 'abc123');
    assert.equal(parsed.planner.model, 'claude-opus-5');
  });
});

describe('isRouteReadyGateComplete', () => {
  it('passes when all roles are non-unknown', () => {
    const route: ExecutedRoutePublic = {
      head_sha: 'abc123',
      planner: { status: 'executed', model: 'claude-opus-5' },
      coder: { status: 'executed', model: 'claude-fable-5' },
      reviewer: { status: 'inherited', model: null },
    };
    const { pass, reasons } = isRouteReadyGateComplete(route);
    assert.equal(pass, true);
    assert.equal(reasons.length, 0);
  });

  it('fails when any role is unknown', () => {
    const route: ExecutedRoutePublic = {
      head_sha: 'abc123',
      planner: { status: 'executed', model: 'claude-opus-5' },
      coder: { status: 'unknown', model: null },
      reviewer: { status: 'executed', model: 'gpt-5.5' },
    };
    const { pass, reasons } = isRouteReadyGateComplete(route);
    assert.equal(pass, false);
    assert.ok(reasons.some((r) => r.includes('coder')));
  });
});

describe('ROUTE_SCHEMA_VERSION', () => {
  it('is the string "1"', () => {
    assert.equal(ROUTE_SCHEMA_VERSION, '1');
  });
});
