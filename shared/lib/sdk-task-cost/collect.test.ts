import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  cleanupMaterialization,
  legacyEngine,
  loadCostParityManifest,
  materializeCase,
} from '../cost-parity.ts';
import { buildExecutionEconomics } from '../execution-economics.ts';
import { validateEvalRecord } from '../eval-validator.ts';
import { SCHEMA_VERSION, type EvalRecord } from '../eval-schema.ts';
import { buildSdkTaskCostSummaries, collectSdkTaskCostSummaries } from './collect.ts';
import { validateTaskCostSummaryV1, type TaskCostSummaryV1 } from './contract.ts';
import { listSdkTaskCostFixtures, loadSdkTaskCostFixture, type SdkTaskCostFixture } from './fixtures.ts';
import { projectTaskCostSummaryToWorkflowCost, selectPrimaryTaskCostSummary } from './project.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COST_PARITY_MANIFEST = join(__dirname, '..', '..', 'fixtures', 'cost-parity', 'manifest.json');
const USD_TOLERANCE = 1e-9;

function summariesFor(fixture: SdkTaskCostFixture): TaskCostSummaryV1[] | null {
  return buildSdkTaskCostSummaries({
    scanResults: fixture.scanResults,
    taskId: fixture.taskId,
    pricingTable: fixture.pricingTable,
    now: () => new Date(fixture.now),
  });
}

/** Deep-match `expected` as a subset of `actual`, with a USD tolerance for numbers. */
function assertSubset(actual: unknown, expected: unknown, path: string): void {
  if (typeof expected === 'number' && typeof actual === 'number') {
    assert.ok(Math.abs(actual - expected) <= USD_TOLERANCE, `${path}: ${actual} != ${expected}`);
    return;
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${path}: expected an array`);
    assert.equal(actual.length, expected.length, `${path}: length`);
    expected.forEach((item, index) => assertSubset((actual as unknown[])[index], item, `${path}[${index}]`));
    return;
  }
  if (expected && typeof expected === 'object') {
    assert.ok(actual && typeof actual === 'object', `${path}: expected an object`);
    for (const [key, value] of Object.entries(expected)) {
      assertSubset((actual as Record<string, unknown>)[key], value, `${path}.${key}`);
    }
    return;
  }
  assert.deepEqual(actual, expected, path);
}

function makeEvalRecord(overrides: Partial<EvalRecord> = {}): EvalRecord {
  return {
    id: 'eval-sdk-bridge',
    schemaVersion: SCHEMA_VERSION,
    originalPrompt: 'Implement the change',
    modelId: 'claude-opus-4',
    modelVersion: 'claude-opus-4',
    score: 0.9,
    scoreBand: 'Minor Feedback',
    timeSeconds: 60,
    timestamp: '2026-10-01T00:00:00.000Z',
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'ok',
    ...overrides,
  } as EvalRecord;
}

describe('buildSdkTaskCostSummaries — F fixtures', () => {
  for (const name of listSdkTaskCostFixtures()) {
    it(`${name}: produces SDK-valid summaries matching the fixture`, () => {
      const fixture = loadSdkTaskCostFixture(name);
      const summaries = summariesFor(fixture);
      if (fixture.expected === null) {
        assert.equal(summaries, null);
        return;
      }
      assert.ok(summaries, 'expected summaries');
      for (const summary of summaries) validateTaskCostSummaryV1(summary);
      assertSubset(summaries, fixture.expected, name);
    });

    it(`${name}: is deterministic for a fixed clock`, () => {
      const fixture = loadSdkTaskCostFixture(name);
      assert.deepEqual(summariesFor(fixture), summariesFor(fixture));
    });

    it(`${name}: carries no Wavemill join or path data`, () => {
      const fixture = loadSdkTaskCostFixture(name);
      const serialized = JSON.stringify(summariesFor(fixture));
      // `branch_worktree` is the SDK join-confidence enum, not join data.
      for (const forbidden of ['/repo/', '.wavemill', 'native-sessions', '.jsonl', '"branch"', '"worktree"']) {
        assert.equal(serialized.includes(forbidden), false, `${name} leaked ${forbidden}`);
      }
    });

    it(`${name}: attaches to an eval record that passes write-time validation`, () => {
      const fixture = loadSdkTaskCostFixture(name);
      const summaries = summariesFor(fixture);
      if (!summaries) return;
      const issues = validateEvalRecord(makeEvalRecord({ taskCostSummary: summaries }), { file: 'test', line: 1 })
        .filter((issue) => issue.code === 'SCHEMA_VIOLATION');
      assert.deepEqual(issues, []);
    });
  }

  it('matches execution-economics session estimates for every fully priced external fixture', () => {
    for (const name of ['claude-success', 'codex-reasoning-and-cache', 'multi-harness']) {
      const fixture = loadSdkTaskCostFixture(name);
      const legacyBlocks = buildExecutionEconomics({
        scanResults: fixture.scanResults,
        pricingTable: fixture.pricingTable,
        now: () => new Date(fixture.now),
      });
      const summaries = summariesFor(fixture)!;
      for (const block of legacyBlocks) {
        const summary = summaries.find((candidate) => candidate.harness === block.harness);
        assert.ok(summary, `${name}: missing ${block.harness} summary`);
        const legacyEstimate = block.sessions.reduce((sum, session) => sum + (session.estimatedCostUsd ?? 0), 0);
        assert.ok(
          Math.abs((summary.estimated_cost_usd ?? 0) - legacyEstimate) <= USD_TOLERANCE,
          `${name}/${block.harness}: sdk ${summary.estimated_cost_usd} vs legacy ${legacyEstimate}`,
        );
      }
    }
  });

  it('pseudonymizes an unsafe task id and falls back when none is given', () => {
    const fixture = loadSdkTaskCostFixture('claude-success');
    const withPath = buildSdkTaskCostSummaries({ ...fixture, taskId: '/tmp/HOK-1', now: () => new Date(fixture.now) })!;
    assert.match(withPath[0].task_id, /^h-/);
    const anonymous = buildSdkTaskCostSummaries({ ...fixture, taskId: undefined, now: () => new Date(fixture.now) })!;
    assert.equal(anonymous[0].task_id, 'unknown-task');
  });

  it('orders summaries native → claude-code → codex regardless of scan order', () => {
    const summaries = summariesFor(loadSdkTaskCostFixture('multi-harness'))!;
    assert.deepEqual(summaries.map((summary) => summary.harness), ['claude-code', 'codex']);
  });
});

describe('collectSdkTaskCostSummaries — HOK-3074 cost-parity corpus', () => {
  const { manifest } = loadCostParityManifest(COST_PARITY_MANIFEST);

  for (const caseItem of manifest.cases) {
    it(`${caseItem.id}: bridge runs, validates, and keeps the legacy dollars`, async () => {
      const ctx = materializeCase(caseItem);
      const originalWarn = console.warn;
      console.warn = () => {};
      try {
        const args = {
          worktreePath: ctx.worktree,
          branchName: caseItem.branch || 'task/parity',
          repoDir: ctx.repoDir,
          pricingTable: caseItem.pricingTable,
          agentType: caseItem.agentType,
          issueId: caseItem.issueId,
        };
        const { outcome: legacy } = await legacyEngine(args);
        const summaries = collectSdkTaskCostSummaries(args);

        if (legacy.status !== 'success') {
          assert.equal(summaries, null, 'no legacy sessions → no SDK summary');
          return;
        }
        assert.ok(summaries, 'legacy found sessions, so the bridge must too');
        for (const summary of summaries) validateTaskCostSummaryV1(summary);

        // The legacy numeric view (unpriced contributes 0) must equal the
        // projected SDK lower bound: same events, same prices.
        const primary = selectPrimaryTaskCostSummary(summaries, caseItem.agentType)!;
        const projected = projectTaskCostSummaryToWorkflowCost(primary);
        assert.ok(
          Math.abs(projected.totalCostUsd - legacy.totalCostUsd) <= USD_TOLERANCE,
          `sdk ${projected.totalCostUsd} vs legacy ${legacy.totalCostUsd}`,
        );
        // Where the legacy engine claims a complete total, the SDK resolves one too.
        if (legacy.attribution?.coverage === 'complete') {
          assert.notEqual(primary.total_cost_usd, null);
        }
      } finally {
        console.warn = originalWarn;
        cleanupMaterialization(ctx);
      }
    });
  }
});
