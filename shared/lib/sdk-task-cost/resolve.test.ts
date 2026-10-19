import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { reportableWorkflowCostUsd, type WorkflowCostOutcome } from '../workflow-cost.ts';
import { buildSdkTaskCostSummaries } from './collect.ts';
import type { TaskCostSummaryV1 } from './contract.ts';
import { COST_METERING_LEGACY_ENV, SDK_TASK_COST_SHADOW_ENV } from './feature-switch.ts';
import { listSdkTaskCostFixtures, loadSdkTaskCostFixture } from './fixtures.ts';
import { resolveAuthoritativeWorkflowCost } from './resolve.ts';
import { runSdkTaskCostCollection } from './shadow.ts';

function summaries(name: string): TaskCostSummaryV1[] | null {
  const fixture = loadSdkTaskCostFixture(name);
  return buildSdkTaskCostSummaries({
    scanResults: fixture.scanResults,
    taskId: fixture.taskId,
    pricingTable: fixture.pricingTable,
    now: () => new Date(fixture.now),
  });
}

const legacySuccess: WorkflowCostOutcome = {
  status: 'success',
  totalCostUsd: 3.75,
  models: {},
  sessionCount: 1,
  turnCount: 1,
  pricingUsed: {},
};

const legacyNoSessions: WorkflowCostOutcome = {
  status: 'no_sessions',
  reason: 'No session files found in expected location',
  diagnostics: {},
};

describe('resolveAuthoritativeWorkflowCost', () => {
  it('projects the SDK summary by default', () => {
    const sdk = summaries('claude-success');
    const resolved = resolveAuthoritativeWorkflowCost({ engine: 'sdk', legacyOutcome: legacySuccess, summaries: sdk });
    assert.equal(resolved.engine, 'sdk');
    assert.equal(resolved.reason, 'sdk_summary');
    assert.equal(resolved.outcome?.status, 'success');
    assert.ok(Math.abs(reportableWorkflowCostUsd(resolved.outcome)! - sdk![0].total_cost_usd!) < 1e-9);
  });

  it('returns the legacy outcome untouched under the rollback', () => {
    const resolved = resolveAuthoritativeWorkflowCost({
      engine: 'legacy',
      legacyOutcome: legacySuccess,
      summaries: summaries('claude-success'),
    });
    assert.deepEqual(resolved, { outcome: legacySuccess, engine: 'legacy', reason: 'rollback' });
  });

  it('reads the rollback switch from the environment when no engine is given', () => {
    const saved = process.env[COST_METERING_LEGACY_ENV];
    try {
      process.env[COST_METERING_LEGACY_ENV] = '1';
      const resolved = resolveAuthoritativeWorkflowCost({ legacyOutcome: legacySuccess, summaries: summaries('claude-success') });
      assert.equal(resolved.reason, 'rollback');
    } finally {
      if (saved === undefined) delete process.env[COST_METERING_LEGACY_ENV];
      else process.env[COST_METERING_LEGACY_ENV] = saved;
    }
  });

  it('keeps the legacy failure when there is no SDK summary — absence is never a zero', () => {
    for (const absent of [null, [] as TaskCostSummaryV1[]]) {
      const resolved = resolveAuthoritativeWorkflowCost({ engine: 'sdk', legacyOutcome: legacyNoSessions, summaries: absent });
      assert.equal(resolved.reason, 'no_sdk_summary');
      assert.equal(resolved.outcome, legacyNoSessions);
      assert.equal(reportableWorkflowCostUsd(resolved.outcome), undefined);
    }
  });

  it('keeps legacy OpenRouter exact pricing the bridge cannot see', () => {
    const exactLegacy: WorkflowCostOutcome = {
      ...legacySuccess,
      attribution: {
        source: 'native',
        coverage: 'complete',
        sessions: 1,
        turns: 1,
        pricedSessions: 1,
        unpricedSessions: 0,
        models: [{ provider: 'openrouter', modelId: 'gpt-4o', priced: true, costUsd: 0.2, providerReportedCostUsd: 0.2 }],
      },
    };
    const resolved = resolveAuthoritativeWorkflowCost({
      engine: 'sdk',
      legacyOutcome: exactLegacy,
      summaries: summaries('native-unpriced-model'),
    });
    assert.equal(resolved.reason, 'legacy_exact_pricing');
    assert.equal(resolved.outcome, exactLegacy);
  });

  it('never turns a partial or unavailable summary into a complete or known-zero cost', () => {
    for (const name of listSdkTaskCostFixtures()) {
      const sdk = summaries(name);
      if (!sdk) continue;
      for (const summary of sdk) {
        const { outcome } = resolveAuthoritativeWorkflowCost({ engine: 'sdk', legacyOutcome: null, summaries: [summary] });
        assert.equal(outcome?.status, 'success', name);
        if (outcome?.status !== 'success') continue;
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

describe('runSdkTaskCostCollection', () => {
  const quiet = { log: () => {}, warn: () => {} };
  const collected = summaries('claude-success');

  it('collects under the default SDK engine', async () => {
    let calls = 0;
    const result = await runSdkTaskCostCollection(() => {
      calls++;
      return collected;
    }, { label: 'test', env: {}, logger: quiet });
    assert.equal(calls, 1);
    assert.equal(result, collected);
  });

  it('skips the collector under the rollback with the shadow off', async () => {
    const result = await runSdkTaskCostCollection(() => {
      throw new Error('must not be called');
    }, { label: 'test', env: { [COST_METERING_LEGACY_ENV]: '1' }, logger: quiet });
    assert.equal(result, null);
  });

  it('still collects diagnostics under the rollback with the shadow on', async () => {
    const result = await runSdkTaskCostCollection(() => collected, {
      label: 'test',
      env: { [COST_METERING_LEGACY_ENV]: '1', [SDK_TASK_COST_SHADOW_ENV]: '1' },
      logger: quiet,
    });
    assert.equal(result, collected);
  });

  it('swallows failures (caller falls back to legacy) unless strict', async () => {
    const warnings: string[] = [];
    const result = await runSdkTaskCostCollection(() => {
      throw new Error('boom');
    }, { label: 'test', env: {}, logger: { log: () => {}, warn: (message) => warnings.push(message) } });
    assert.equal(result, null);
    assert.match(warnings[0], /SDK task cost collection failed — boom/);

    await assert.rejects(
      runSdkTaskCostCollection(() => {
        throw new Error('boom');
      }, { label: 'test', env: { [SDK_TASK_COST_SHADOW_ENV]: 'strict' }, logger: quiet }),
      /boom/,
    );
  });
});
