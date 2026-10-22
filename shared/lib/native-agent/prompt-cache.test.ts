/**
 * HOK-3260: prompt-cache projection math. Protects the hit-rate definition
 * (turns 2..n, cacheRead / (input + cacheRead + cacheWrite)) and the
 * eligibility rule (>=3 turns, defined rate) the detector relies on.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildStageExecutionUsage,
  evaluatePromptCache,
  summarizePromptCache,
} from './prompt-cache.ts';

describe('summarizePromptCache', () => {
  it('excludes turn 1 from the hit rate but counts its tokens in the totals', () => {
    const summary = summarizePromptCache([
      { input: 1000, cacheRead: 0, cacheWrite: 4000 },
      { input: 100, cacheRead: 4000, cacheWrite: 200 },
      { input: 100, cacheRead: 4200, cacheWrite: 300 },
    ]);
    assert.equal(summary.cacheReadTokens, 8200);
    assert.equal(summary.cacheWriteTokens, 4500);
    assert.equal(summary.turnsWithUsage, 3);
    // (4000 + 4200) / ((100 + 4000 + 200) + (100 + 4200 + 300))
    assert.equal(summary.cacheHitRate, 8200 / 8900);
  });

  it('is null for a single turn, which can only write the cache', () => {
    const summary = summarizePromptCache([{ input: 10, cacheRead: 500, cacheWrite: 0 }]);
    assert.equal(summary.cacheHitRate, null);
    assert.equal(summary.cacheReadTokens, 500);
  });

  it('is null when turns 2..n sent no prompt tokens', () => {
    const summary = summarizePromptCache([{ input: 10 }, {}, { input: 0, cacheRead: 0, cacheWrite: 0 }]);
    assert.equal(summary.cacheHitRate, null);
  });

  it('is 0 when later turns read nothing from cache', () => {
    const summary = summarizePromptCache([
      { input: 10, cacheWrite: 100 },
      { input: 120 },
      { input: 130 },
    ]);
    assert.equal(summary.cacheHitRate, 0);
  });

  it('treats missing, negative and non-finite counts as zero', () => {
    const summary = summarizePromptCache([
      { input: 5 },
      { input: Number.NaN, cacheRead: 50, cacheWrite: -3 },
      { input: 50, cacheRead: Number.POSITIVE_INFINITY },
    ]);
    assert.equal(summary.cacheReadTokens, 50);
    assert.equal(summary.cacheWriteTokens, 0);
    assert.equal(summary.cacheHitRate, 50 / 100);
  });

  it('returns an empty summary for a run with no usage', () => {
    assert.deepEqual(summarizePromptCache([]), {
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheHitRate: null,
      turnsWithUsage: 0,
    });
  });
});

describe('evaluatePromptCache', () => {
  it('flags a run with >=3 turns below the threshold', () => {
    assert.deepEqual(evaluatePromptCache({ turnsCompleted: 3, cacheHitRate: 0.2 }, 0.5), {
      eligible: true,
      belowThreshold: true,
      rate: 0.2,
      turns: 3,
    });
  });

  it('does not flag a rate at the threshold', () => {
    assert.equal(evaluatePromptCache({ turnsCompleted: 5, cacheHitRate: 0.5 }, 0.5).belowThreshold, false);
  });

  it('never judges a run with fewer than 3 turns', () => {
    const evaluation = evaluatePromptCache({ turnsCompleted: 2, cacheHitRate: 0 }, 0.5);
    assert.equal(evaluation.eligible, false);
    assert.equal(evaluation.belowThreshold, false);
  });

  it('never judges a run without a defined rate', () => {
    assert.equal(evaluatePromptCache({ turnsCompleted: 10, cacheHitRate: null }, 0.5).belowThreshold, false);
    assert.equal(evaluatePromptCache({ turnsCompleted: 10 }, 0.5).belowThreshold, false);
  });
});

describe('buildStageExecutionUsage', () => {
  const loop = {
    turnsCompleted: 4,
    toolCallsExecuted: 3,
    wallClockMs: 1200,
    totalInputTokens: 400,
    totalOutputTokens: 90,
    totalCostUsd: 0,
  };

  it('carries the loop prompt-cache summary and provider route', () => {
    const usage = buildStageExecutionUsage(
      { ...loop, promptCache: { cacheReadTokens: 700, cacheWriteTokens: 300, cacheHitRate: 0.7, turnsWithUsage: 4 } },
      'anthropic',
    );
    assert.deepEqual(usage, {
      turnsCompleted: 4,
      toolCallsExecuted: 3,
      wallClockMs: 1200,
      totalInputTokens: 400,
      totalOutputTokens: 90,
      cacheReadTokens: 700,
      cacheWriteTokens: 300,
      cacheHitRate: 0.7,
      providerRoute: 'anthropic',
    });
  });

  it('records zero cache tokens and a null rate when the loop reported none', () => {
    const usage = buildStageExecutionUsage(loop, 'openrouter', { totalCostUsd: 0.25 });
    assert.equal(usage.cacheReadTokens, 0);
    assert.equal(usage.cacheWriteTokens, 0);
    assert.equal(usage.cacheHitRate, null);
    assert.equal(usage.totalCostUsd, 0.25);
  });

  it('omits a non-finite caller cost rather than recording it', () => {
    assert.equal('totalCostUsd' in buildStageExecutionUsage(loop, 'openai', { totalCostUsd: Number.NaN }), false);
  });
});
