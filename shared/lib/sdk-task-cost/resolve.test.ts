import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { reportableWorkflowCostUsd } from '../workflow-cost.ts';
import { buildSdkTaskCostSummaries } from './collect.ts';
import type { TaskCostSummaryV1 } from './contract.ts';
import { listSdkTaskCostFixtures, loadSdkTaskCostFixture } from './fixtures.ts';
import { resolveWorkflowCost } from './resolve.ts';

function summaries(name: string): TaskCostSummaryV1[] | null {
  const fixture = loadSdkTaskCostFixture(name);
  return buildSdkTaskCostSummaries({
    scanResults: fixture.scanResults,
    taskId: fixture.taskId,
    pricingTable: fixture.pricingTable,
    now: () => new Date(fixture.now),
  });
}

describe('resolveWorkflowCost', () => {
  it('projects the primary SDK summary', () => {
    const sdk = summaries('claude-success');
    const resolved = resolveWorkflowCost({ summaries: sdk });
    assert.equal(resolved.reason, 'sdk_summary');
    assert.equal(resolved.outcome.status, 'success');
    assert.ok(Math.abs(reportableWorkflowCostUsd(resolved.outcome)! - sdk![0].total_cost_usd!) < 1e-9);
  });

  it('reports no_sessions with diagnostics when there is no summary — absence is never a zero', () => {
    for (const absent of [null, undefined, [] as TaskCostSummaryV1[]]) {
      const resolved = resolveWorkflowCost({
        summaries: absent,
        agentType: 'codex',
        diagnostics: { worktreePath: '/w', branchName: 'task/x' },
      });
      assert.equal(resolved.reason, 'no_sdk_summary');
      assert.equal(resolved.outcome.status, 'no_sessions');
      assert.equal(reportableWorkflowCostUsd(resolved.outcome), undefined);
      assert.deepEqual(resolved.outcome.status !== 'success' && resolved.outcome.diagnostics, {
        worktreePath: '/w',
        branchName: 'task/x',
        agentType: 'codex',
        sessionFilesFound: 0,
        matchingTurns: 0,
      });
    }
  });

  it('reports adapter_error when the collector threw, even if stale summaries are passed', () => {
    const resolved = resolveWorkflowCost({
      summaries: summaries('claude-success'),
      collectionError: 'sdk exploded',
    });
    assert.equal(resolved.reason, 'collection_failed');
    assert.equal(resolved.outcome.status, 'adapter_error');
    assert.match(resolved.outcome.status !== 'success' ? resolved.outcome.reason : '', /SDK task-cost collection failed: sdk exploded/);
    assert.equal(reportableWorkflowCostUsd(resolved.outcome), undefined);
  });

  it('prefers the native summary over the agent-type harness', () => {
    const native = summaries('native-unpriced-model')!;
    const claude = summaries('claude-success')!;
    const resolved = resolveWorkflowCost({ summaries: [...claude, ...native], agentType: 'claude' });
    assert.equal(resolved.outcome.status === 'success' && resolved.outcome.attribution?.source, 'native');
  });

  it('never turns a partial or unavailable summary into a complete or known-zero cost', () => {
    for (const name of listSdkTaskCostFixtures()) {
      const sdk = summaries(name);
      if (!sdk) continue;
      for (const summary of sdk) {
        const { outcome } = resolveWorkflowCost({ summaries: [summary] });
        assert.equal(outcome.status, 'success', name);
        if (outcome.status !== 'success') continue;
        assert.equal(outcome.attribution?.coverage, summary.coverage, `${name}: coverage preserved`);
        if (summary.coverage === 'known_zero') {
          assert.equal(reportableWorkflowCostUsd(outcome), 0, `${name}: explicit zero is the only zero`);
        }
        if (summary.cost_source === 'none') {
          assert.equal(reportableWorkflowCostUsd(outcome), undefined, `${name}: nothing priced → no dollar figure`);
        }
      }
    }
  });
});
