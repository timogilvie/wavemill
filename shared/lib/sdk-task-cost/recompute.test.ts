/**
 * Backfill recomputation from stored per-harness summaries (HOK-3328): the
 * `@hokusai/costs` total over every stored summary, passed through verbatim.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTaskCostTracker } from '@hokusai/costs';
import type { EvalRecord } from '../eval-schema.ts';
import { fixtureTaskCostSummaries } from './fixtures.ts';
import { isUnrecomputableNativeFirstCost, recomputeRecordWorkflowCost } from './recompute.ts';

/** HOK-3237's stored summaries: claude-code $43.71 (complete), native $4.93 (provider-reported). */
function hok3237Summaries() {
  const tracker = createTaskCostTracker({
    taskId: 'HOK-3237',
    priceOverrides: [{ model: 'claude-opus-4-7', inputPerMTokUsd: 15, outputPerMTokUsd: 75, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 }],
    now: () => new Date('2026-10-27T14:43:00.000Z'),
  });
  tracker.recordUsage({
    harness: 'claude-code',
    model: 'claude-opus-4-7',
    usage: { inputTokens: 0, outputTokens: 582_800, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
    sessionId: 'claude-1',
  });
  tracker.recordUsage({
    harness: 'native',
    model: 'qwen-3-coder',
    usage: { inputTokens: 100_000, outputTokens: 20_000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: null },
    providerCostUsd: 4.93,
    sessionId: 'wm-coding-HOK-3237',
  });
  return [...tracker.summary().summaries];
}

function record(overrides: Partial<EvalRecord>): EvalRecord {
  return {
    id: 'eval-1',
    schemaVersion: '1.55.0',
    originalPrompt: 'p',
    modelId: 'm',
    modelVersion: 'm',
    score: 1,
    scoreBand: 'Full Success',
    timeSeconds: 1,
    timestamp: '2026-10-27T14:43:00.000Z',
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'r',
    issueId: 'HOK-3237',
    ...overrides,
  } as EvalRecord;
}

describe('recomputeRecordWorkflowCost (HOK-3328)', () => {
  // protects: HOK-3237's stored $4.93 (native-first) never being corrected to the $48.64 total
  it('recomputes the native-first cost as the SDK total over every stored summary', () => {
    const recovery = recomputeRecordWorkflowCost(record({ workflowCost: 4.93, taskCostSummary: hok3237Summaries() }));
    assert.ok(recovery.recomputed, recovery.reason);
    assert.ok(Math.abs(recovery.recomputed.cost - 48.64) < 1e-9, String(recovery.recomputed.cost));
    assert.deepEqual(recovery.recomputed.byHarness, { 'claude-code': 43.71, native: 4.93 });
    assert.equal(recovery.recomputed.attribution?.source, 'multi');
  });

  // protects: the backfill re-pricing stored figures (a second engine) instead of passing them through
  it('passes stored charges and estimates through verbatim', () => {
    const summaries = fixtureTaskCostSummaries('multi-harness')!;
    const recovery = recomputeRecordWorkflowCost(record({ taskCostSummary: summaries }));
    assert.ok(recovery.recomputed);
    const stored = Object.fromEntries(summaries.map((summary) => [summary.harness, summary.total_cost_usd]));
    assert.deepEqual(recovery.recomputed.byHarness, stored);
  });

  // protects: a record with nothing to recompute from being rewritten to $0
  it('reports records without stored summaries or without a priced total', () => {
    assert.match(recomputeRecordWorkflowCost(record({ workflowCost: 3 })).reason ?? '', /No stored taskCostSummary/);
    const unpriced = recomputeRecordWorkflowCost(record({ taskCostSummary: fixtureTaskCostSummaries('native-missing-usage')! }));
    assert.equal(unpriced.recomputed, null);
    assert.match(unpriced.reason ?? '', /No priced sessions/);
  });

  // protects: pre-August costs (before native-first turned destructive) being flagged, or later ones missed
  it('flags costed records since 2026-08 that cannot be recomputed', () => {
    assert.equal(isUnrecomputableNativeFirstCost(record({ workflowCost: 4, timestamp: '2026-09-01T00:00:00.000Z' })), true);
    assert.equal(isUnrecomputableNativeFirstCost(record({ workflowCost: 4, timestamp: '2026-07-31T23:59:59.000Z' })), false);
    assert.equal(isUnrecomputableNativeFirstCost(record({ timestamp: '2026-09-01T00:00:00.000Z' })), false);
    assert.equal(isUnrecomputableNativeFirstCost(record({ workflowCost: 4, taskCostSummary: hok3237Summaries() })), false);
    assert.equal(isUnrecomputableNativeFirstCost(record({
      workflowCost: 4,
      timestamp: '2026-09-01T00:00:00.000Z',
      workflowCostUnreliable: { reason: 'native_first_harness_selection', markedAt: '2026-10-28T00:00:00.000Z' },
    })), false);
  });
});
