/**
 * Projection of the `@hokusai/costs` report into the persisted workflow-cost
 * shape (HOK-3328): the total is the report's cross-harness total, never one
 * harness's summary.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTaskCostTracker } from '@hokusai/costs';
import { buildHostPriceOverrides } from './price-overrides.ts';
import { projectReportToWorkflowCost, reportByHarness } from './project.ts';
import { reportableWorkflowCostUsd } from '../workflow-cost.ts';

function report(records: Parameters<ReturnType<typeof createTaskCostTracker>['recordUsage']>[0][]) {
  const tracker = createTaskCostTracker({
    taskId: 'HOK-1',
    priceOverrides: buildHostPriceOverrides({ 'claude-opus-4-7': { inputCostPerMTok: 15, outputCostPerMTok: 75 } }),
    now: () => new Date('2026-10-27T00:00:00.000Z'),
  });
  for (const record of records) tracker.recordUsage(record);
  return tracker.summary();
}

const CLAUDE = {
  harness: 'claude-code' as const,
  model: 'claude-opus-4-7',
  usage: { inputTokens: 0, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
  sessionId: 'claude-1',
};
const NATIVE = {
  harness: 'native' as const,
  model: 'qwen-3-coder',
  usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
  providerCostUsd: 2,
  sessionId: 'native-1',
};

describe('projectReportToWorkflowCost (HOK-3328)', () => {
  // protects: the native-first rule — a native summary masking the Claude Code cost
  it('totals every harness and attributes the record to `multi`', () => {
    const projected = projectReportToWorkflowCost(report([CLAUDE, NATIVE]));
    assert.equal(projected.totalCostUsd, 9.5);
    assert.deepEqual(projected.byHarness, { 'claude-code': 7.5, native: 2 });
    assert.equal(projected.attribution?.source, 'multi');
    assert.equal(projected.sessionCount, 2);
    assert.deepEqual(Object.keys(projected.models).sort(), ['claude-opus-4-7', 'qwen-3-coder']);
    assert.equal(projected.models['claude-opus-4-7'].costUsd, 7.5);
    assert.equal(projected.attribution?.models.find((model) => model.provider === 'native')?.providerReportedCostUsd, 2);
  });

  // protects: single-harness records changing their persisted attribution source
  it('keeps the harness name when one harness contributed', () => {
    const projected = projectReportToWorkflowCost(report([CLAUDE]));
    assert.equal(projected.attribution?.source, 'claude');
    assert.equal(projected.attribution?.coverage, 'complete');
    assert.equal(projected.totalCostUsd, 7.5);
  });

  // protects: an unpriced model presented as a complete $0 cost
  it('keeps an unresolved harness as null in byHarness and marks the record partial', () => {
    const unpriced = { ...NATIVE, providerCostUsd: undefined, model: 'mystery-model' };
    const projected = projectReportToWorkflowCost(report([CLAUDE, unpriced]));
    assert.deepEqual(projected.byHarness, { 'claude-code': 7.5, native: null });
    assert.equal(projected.attribution?.coverage, 'partial');
    assert.equal(projected.attribution?.reason, 'unpriced_model');
    assert.equal(projected.attribution?.unpricedSessions, 1);
    assert.deepEqual(reportByHarness(report([unpriced])), { native: null });
  });

  // protects: the persisted pricing snapshot being recomputed instead of copied
  it('stores the caller-supplied pricing snapshot verbatim', () => {
    const snapshot = { 'claude-opus-4-7': { inputCostPerMTok: 15, outputCostPerMTok: 75 } };
    assert.deepEqual(projectReportToWorkflowCost(report([CLAUDE]), snapshot).pricingUsed, snapshot);
  });

  // protects: an unpriced run reported as $0, or a genuinely free run hidden
  it('reports a figure only for priced or known-zero outcomes', () => {
    const unpriced = projectReportToWorkflowCost(report([{ ...NATIVE, providerCostUsd: undefined, model: 'mystery-model' }]));
    assert.equal(reportableWorkflowCostUsd(unpriced), undefined);
    const tracker = createTaskCostTracker({
      taskId: 'HOK-1',
      priceOverrides: buildHostPriceOverrides({ 'free-model': { inputCostPerMTok: 0, outputCostPerMTok: 0, cacheReadCostPerMTok: 0, cacheWriteCostPerMTok: 0 } }),
    });
    tracker.recordUsage({ ...CLAUDE, model: 'free-model' });
    const free = projectReportToWorkflowCost(tracker.summary());
    assert.equal(reportableWorkflowCostUsd(free), 0);
    assert.equal(reportableWorkflowCostUsd(projectReportToWorkflowCost(report([CLAUDE]))), 7.5);
  });
});
