import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EvalRecord } from '../eval-schema.ts';
import { repairPooledWorkflowCost } from '../workflow-cost-pool-repair.ts';
import { buildSdkTaskCostSummaries, type CollectSdkTaskCostSummariesInput } from './collect.ts';
import { loadSdkTaskCostFixture } from './fixtures.ts';
import { recomputeRecordWorkflowCost } from './recompute.ts';

function fixtureSummaries(name: string) {
  const fixture = loadSdkTaskCostFixture(name);
  return buildSdkTaskCostSummaries({
    scanResults: fixture.scanResults,
    taskId: fixture.taskId,
    pricingTable: fixture.pricingTable,
    now: () => new Date(fixture.now),
  });
}

function record(metadata?: Record<string, unknown>): EvalRecord {
  return {
    issueId: 'HOK-42',
    agentType: 'claude',
    ...(metadata ? { metadata } : {}),
  } as unknown as EvalRecord;
}

const JOINED = { worktreePath: '/w/task', branchName: 'task/x' };

describe('recomputeRecordWorkflowCost', () => {
  it('needs the worktree/branch join from the record metadata', () => {
    const collect = () => {
      throw new Error('must not collect without a join');
    };
    assert.deepEqual(recomputeRecordWorkflowCost(record(), { repoDir: '/r', collect }), {
      recomputed: null,
      reason: 'No metadata available for recovery',
    });
    assert.deepEqual(recomputeRecordWorkflowCost(record({ worktreePath: '/w' }), { repoDir: '/r', collect }), {
      recomputed: null,
      reason: 'Missing worktreePath or branchName in metadata',
    });
  });

  it('recomputes with the SDK engine from the joined sessions', () => {
    const summaries = fixtureSummaries('claude-success')!;
    let received: CollectSdkTaskCostSummariesInput | undefined;
    const pricingTable = { 'claude-opus-4': { inputCostPerMTok: 15, outputCostPerMTok: 75 } };
    const recovery = recomputeRecordWorkflowCost(record(JOINED), {
      repoDir: '/r',
      pricingTable,
      collect: (input) => {
        received = input;
        return summaries;
      },
    });
    assert.deepEqual(received, { ...JOINED, repoDir: '/r', issueId: 'HOK-42', pricingTable });
    assert.ok(recovery.recomputed);
    assert.ok(Math.abs(recovery.recomputed.cost - summaries[0].total_cost_usd!) < 1e-9);
    assert.equal(recovery.recomputed.attribution?.source, 'claude');
    assert.ok(recovery.recomputed.tokenUsage && Object.keys(recovery.recomputed.tokenUsage).length > 0);
  });

  it('never recovers an unpriced run as $0', () => {
    const recovery = recomputeRecordWorkflowCost(record(JOINED), {
      repoDir: '/r',
      collect: () => fixtureSummaries('native-unpriced-model'),
    });
    assert.equal(recovery.recomputed, null);
    assert.match(recovery.reason ?? '', /No priced sessions \(coverage partial\)/);
  });

  it('reports no-session and collector failures as reasons the backfill maps to a status', () => {
    const none = recomputeRecordWorkflowCost(record(JOINED), { repoDir: '/r', collect: () => null });
    assert.equal(none.recomputed, null);
    // tools/backfill-workflow-cost-status.ts maps "No session" → no_sessions.
    assert.match(none.reason ?? '', /No session/);

    const failed = recomputeRecordWorkflowCost(record(JOINED), {
      repoDir: '/r',
      collect: () => {
        throw new Error('unreadable transcript');
      },
    });
    assert.equal(failed.recomputed, null);
    assert.match(failed.reason ?? '', /SDK task-cost collection failed: unreadable transcript/);
  });

  it('feeds the HOK-3256 pooled-cost repair', () => {
    const pooled = {
      ...record(JOINED),
      workflowCost: 99,
      workflowCostStatus: 'success',
      workflowCostAttribution: { source: 'native', coverage: 'complete', sessions: 200, turns: 400, pricedSessions: 200, unpricedSessions: 0, models: [] },
    } as unknown as EvalRecord;
    const recovery = recomputeRecordWorkflowCost(pooled, { repoDir: '/r', collect: () => fixtureSummaries('claude-success') });
    const repaired = repairPooledWorkflowCost(pooled, recovery.recomputed, recovery.reason ?? 'unknown');
    assert.equal(repaired.workflowCostStatus, 'success');
    assert.notEqual(repaired.workflowCost, 99);
    assert.equal(repaired.workflowCostAttribution?.source, 'claude');
  });
});
