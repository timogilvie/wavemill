import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { EvalRecord } from './eval-schema.ts';
import {
  POOLED_COST_MIN_SESSIONS,
  isPooledWorkflowCost,
  repairPooledWorkflowCost,
} from './workflow-cost-pool-repair.ts';

function pooledRecord(sessions: number, overrides: Partial<EvalRecord> = {}): EvalRecord {
  return {
    issueId: 'HOK-3220',
    agentType: 'claude',
    workflowCost: 44.9961,
    workflowCostStatus: 'success',
    workflowTokenUsage: {
      'gemini-2.5-pro': { inputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 1, costUsd: 44.9961 },
    },
    workflowCostAttribution: {
      source: 'native',
      coverage: 'complete',
      sessions,
      turns: 282,
      pricedSessions: sessions,
      unpricedSessions: 0,
      models: [],
    },
    ...overrides,
  } as EvalRecord;
}

describe('isPooledWorkflowCost', () => {
  it('flags a native cost spanning the cross-task pool', () => {
    assert.equal(isPooledWorkflowCost(pooledRecord(204)), true);
    assert.equal(isPooledWorkflowCost(pooledRecord(POOLED_COST_MIN_SESSIONS)), true);
  });

  it('leaves a single task\'s own native sessions alone', () => {
    assert.equal(isPooledWorkflowCost(pooledRecord(8)), false);
  });

  it('ignores non-native sources and already-repaired records', () => {
    const claude = pooledRecord(204);
    claude.workflowCostAttribution!.source = 'claude';
    assert.equal(isPooledWorkflowCost(claude), false);
    assert.equal(isPooledWorkflowCost(pooledRecord(204, { workflowCostStatus: 'unreliable' })), false);
    assert.equal(isPooledWorkflowCost(pooledRecord(204, { workflowCostAttribution: undefined })), false);
  });

  it('honours a custom threshold', () => {
    assert.equal(isPooledWorkflowCost(pooledRecord(30), 50), false);
  });
});

describe('repairPooledWorkflowCost', () => {
  it('marks an unrecoverable record unreliable and drops its cost fields', () => {
    const repaired = repairPooledWorkflowCost(pooledRecord(204), null, 'Missing worktreePath or branchName in metadata');
    assert.equal(repaired.workflowCostStatus, 'unreliable');
    assert.ok(!('workflowCost' in repaired));
    assert.ok(!('workflowTokenUsage' in repaired));
    assert.ok(!('workflowCostAttribution' in repaired));
    assert.equal(repaired.issueId, 'HOK-3220');
    assert.match(repaired.workflowCostDiagnostics!.reason, /\$44\.9961 across 204 native sessions/);
    assert.match(repaired.workflowCostDiagnostics!.reason, /Missing worktreePath/);
    assert.equal(repaired.workflowCostDiagnostics!.sessionFilesFound, 204);
    assert.equal(isPooledWorkflowCost(repaired), false);
  });

  it('replaces the pooled cost with a recomputation', () => {
    const attribution = { ...pooledRecord(3).workflowCostAttribution!, sessions: 3 };
    const repaired = repairPooledWorkflowCost(
      pooledRecord(204),
      { cost: 1.25, tokenUsage: {}, attribution },
      'unused',
    );
    assert.equal(repaired.workflowCostStatus, 'success');
    assert.equal(repaired.workflowCost, 1.25);
    assert.equal(repaired.workflowCostAttribution?.sessions, 3);
    assert.equal(isPooledWorkflowCost(repaired), false);
  });

  it('drops the stale pooled attribution when the recomputation has none', () => {
    const repaired = repairPooledWorkflowCost(pooledRecord(204), { cost: 1.25, tokenUsage: {} }, 'unused');
    assert.ok(!('workflowCostAttribution' in repaired));
  });
});
