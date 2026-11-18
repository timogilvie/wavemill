import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  loopCostLimitUsd,
  resolveTaskBudget,
  resolveTaskSpendRemainder,
  type TaskSpendRemainder,
} from './task-spend.ts';
import type { meterWorkflowCost } from './sdk-task-cost/meter.ts';

const repos: string[] = [];

function makeRepo(config?: Record<string, unknown>): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'task-spend-'));
  repos.push(repoDir);
  if (config) writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify(config), 'utf-8');
  return repoDir;
}

function featureDir(repoDir: string, slug = 'demo'): string {
  const dir = join(repoDir, 'features', slug);
  mkdirSync(dir, { recursive: true });
  return dir;
}

afterEach(() => {
  while (repos.length > 0) rmSync(repos.pop()!, { recursive: true, force: true });
});

function metered(totalUsd: number) {
  return {
    reason: 'sdk_report',
    outcome: {
      status: 'success',
      totalCostUsd: totalUsd,
      attribution: { coverage: 'complete', pricedSessions: 1 },
    },
    summaries: null,
    owned: [],
    sessionCosts: new Map(),
    sessionUsageRows: new Map(),
    sessionHarness: new Map(),
    summariesByStage: new Map(),
  } as unknown as Awaited<ReturnType<typeof meterWorkflowCost>>;
}

describe('resolveTaskBudget', () => {
  it('carries the recorded route constraint and its provenance', () => {
    const repoDir = makeRepo();
    const dir = featureDir(repoDir);
    writeFileSync(join(dir, '.initial-route.json'), JSON.stringify({
      coder: 'm', codeDepth: 'light', reviewer: 'm', reviewMode: 'standard',
      constraints: { maxCostUsd: 40, budgetSource: 'request' },
    }), 'utf-8');
    assert.deepEqual(resolveTaskBudget({ repoDir, featureDir: dir }), { maxCostUsd: 40, budgetSource: 'request' });
  });

  it('falls back to the repo default when no route carries a budget', () => {
    const repoDir = makeRepo({ mill: { defaultMaxCostUsd: 25 } });
    const dir = featureDir(repoDir);
    assert.deepEqual(resolveTaskBudget({ repoDir, featureDir: dir }), { maxCostUsd: 25, budgetSource: 'repo-config' });
  });

  it('returns null when nothing records a budget', () => {
    const repoDir = makeRepo();
    assert.equal(resolveTaskBudget({ repoDir, featureDir: featureDir(repoDir) }), null);
  });
});

describe('resolveTaskSpendRemainder', () => {
  it('subtracts measured spend from the recorded budget', async () => {
    const repoDir = makeRepo({ mill: { defaultMaxCostUsd: 25 } });
    const spend = await resolveTaskSpendRemainder({
      repoDir,
      featureDir: featureDir(repoDir),
      meter: async () => metered(20),
    });
    assert.ok(spend);
    assert.equal(spend.metering, 'measured');
    assert.equal(spend.spentUsd, 20);
    assert.equal(spend.remainingUsd, 5);
  });

  it('takes spend from the one meter over all owned rows, never a second sum', async () => {
    const repoDir = makeRepo({ mill: { defaultMaxCostUsd: 25 } });
    const rows = [
      { sessionRef: 'a', harness: 'native', kind: 'planning', model: 'm', launchedAt: '2026-11-15T12:00:00.000Z', attemptId: 'planning@abc#1' },
      { sessionRef: 'b', harness: 'native', kind: 'native-arm', stage: 'coding', model: 'm', launchedAt: '2026-11-15T13:00:00.000Z', attemptId: 'coding@abc#2' },
    ] as const;
    let seenOwnership = 0;
    const spend = await resolveTaskSpendRemainder({
      repoDir,
      featureDir: featureDir(repoDir),
      ownership: rows,
      meter: async (input) => {
        seenOwnership = input.ownership?.length ?? 0;
        return metered(12);
      },
    });
    assert.equal(seenOwnership, 2, 'both owned launch rows reach the one meter');
    assert.equal(spend?.remainingUsd, 13);
  });

  it('floors an overspent task at zero remaining rather than going negative', async () => {
    const repoDir = makeRepo({ mill: { defaultMaxCostUsd: 25 } });
    const spend = await resolveTaskSpendRemainder({
      repoDir,
      featureDir: featureDir(repoDir),
      meter: async () => metered(75),
    });
    assert.equal(spend?.remainingUsd, 0);
  });

  it('treats a first launch with no owned sessions as a measured zero', async () => {
    const repoDir = makeRepo({ mill: { defaultMaxCostUsd: 25 } });
    const spend = await resolveTaskSpendRemainder({
      repoDir,
      featureDir: featureDir(repoDir),
      meter: async () => ({ ...metered(0), reason: 'no_owned_sessions' }) as never,
    });
    assert.equal(spend?.metering, 'measured');
    assert.equal(spend?.spentUsd, 0);
    assert.equal(spend?.remainingUsd, 25);
  });

  it('an unavailable meter is unknown spend, never zero', async () => {
    const repoDir = makeRepo({ mill: { defaultMaxCostUsd: 25 } });
    const spend = await resolveTaskSpendRemainder({
      repoDir,
      featureDir: featureDir(repoDir),
      meter: async () => ({ ...metered(0), reason: 'collection_failed', outcome: { status: 'adapter_error', reason: 'boom', diagnostics: {} } }) as never,
    });
    assert.ok(spend);
    assert.equal(spend.metering, 'unavailable');
    assert.equal(spend.spentUsd, null);
    assert.equal(spend.remainingUsd, null);
  });

  it('an unpriced sdk report is unknown spend, not a free session', async () => {
    const repoDir = makeRepo({ mill: { defaultMaxCostUsd: 25 } });
    const spend = await resolveTaskSpendRemainder({
      repoDir,
      featureDir: featureDir(repoDir),
      meter: async () => ({
        ...metered(0),
        outcome: { status: 'success', totalCostUsd: 0, attribution: { coverage: 'unavailable', pricedSessions: 0 } },
      }) as never,
    });
    assert.equal(spend?.metering, 'unavailable');
    assert.equal(spend?.remainingUsd, null);
  });

  it('returns null when the task recorded no budget', async () => {
    const repoDir = makeRepo();
    assert.equal(await resolveTaskSpendRemainder({ repoDir, featureDir: featureDir(repoDir), meter: async () => metered(1) }), null);
  });

  it('passes the caller model rates through as the loop pricing', async () => {
    const repoDir = makeRepo({ mill: { defaultMaxCostUsd: 25 } });
    const spend = await resolveTaskSpendRemainder({
      repoDir,
      featureDir: featureDir(repoDir),
      modelPricing: { inputCostPerMTok: 3, outputCostPerMTok: 6 },
      meter: async () => metered(0),
    });
    assert.deepEqual(spend?.pricing, { inputCostPerMTok: 3, outputCostPerMTok: 6 });
  });
});

describe('loopCostLimitUsd', () => {
  const measured = (remainingUsd: number): TaskSpendRemainder => ({
    budget: { maxCostUsd: 25, budgetSource: 'repo-config' },
    spentUsd: 25 - remainingUsd,
    remainingUsd,
    metering: 'measured',
    pricing: null,
  });

  it('is the remainder when spend is measured', () => {
    assert.equal(loopCostLimitUsd(measured(5)), 5);
    assert.equal(loopCostLimitUsd(measured(0)), 0);
  });

  it('bounds an unknown-spend launch by the recorded ceiling, never unbounded', () => {
    assert.equal(loopCostLimitUsd({
      budget: { maxCostUsd: 25, budgetSource: 'repo-config' },
      spentUsd: null,
      remainingUsd: null,
      metering: 'unavailable',
      pricing: null,
    }), 25);
  });

  it('is undefined when no budget is recorded', () => {
    assert.equal(loopCostLimitUsd(null), undefined);
  });
});
