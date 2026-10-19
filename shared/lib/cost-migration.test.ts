import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildCostMigrationReport,
  compareCostOutcomes,
  compareCostParityCorpus,
  compareHistoricalEvalRecords,
  formatCostMigrationReport,
  type CostMigrationCaseReport,
  type CostMigrationReport,
} from './cost-migration.ts';
import { loadCostParityManifest } from './cost-parity.ts';
import type { EvalRecord } from './eval-schema.ts';
import { buildSdkTaskCostSummaries } from './sdk-task-cost/collect.ts';
import type { TaskCostSummaryV1 } from './sdk-task-cost/contract.ts';
import { loadSdkTaskCostFixture } from './sdk-task-cost/fixtures.ts';
import { projectTaskCostSummaryToWorkflowCost } from './sdk-task-cost/project.ts';
import type { WorkflowCostAttribution, WorkflowCostResult } from './workflow-cost.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(__dirname, '..', 'fixtures', 'cost-parity', 'manifest.json');

function summary(name: string): TaskCostSummaryV1 {
  const fixture = loadSdkTaskCostFixture(name);
  return buildSdkTaskCostSummaries({
    scanResults: fixture.scanResults,
    taskId: fixture.taskId,
    pricingTable: fixture.pricingTable,
    now: () => new Date(fixture.now),
  })![0];
}

function attribution(overrides: Partial<WorkflowCostAttribution> = {}): WorkflowCostAttribution {
  return {
    source: 'claude',
    coverage: 'complete',
    sessions: 1,
    turns: 1,
    pricedSessions: 1,
    unpricedSessions: 0,
    models: [{ provider: 'claude', modelId: 'm', priced: true, costUsd: 1, inputTokens: 10, outputTokens: 5 }],
    ...overrides,
  };
}

function success(overrides: Partial<WorkflowCostResult> = {}): WorkflowCostResult {
  return {
    status: 'success',
    totalCostUsd: 1,
    models: { m: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 1 } },
    sessionCount: 1,
    turnCount: 1,
    pricingUsed: {},
    attribution: attribution(),
    ...overrides,
  };
}

function compare(legacy: WorkflowCostResult, sdk: WorkflowCostResult, harness: TaskCostSummaryV1['harness'] = 'claude-code') {
  const base = summary('claude-success');
  return compareCostOutcomes({
    caseId: 'synthetic',
    source: 'history',
    legacy,
    sdk,
    summary: { ...base, harness, coverage: sdk.attribution?.coverage ?? base.coverage },
  });
}

describe('compareCostParityCorpus — release gate over the HOK-3074 corpus', () => {
  let report: CostMigrationReport;
  const byId = (id: string) => report.cases.find((caseReport) => caseReport.caseId === id)!;
  const classified = (id: string) => byId(id).differences.map((diff) => `${diff.classification}:${diff.ruleId}:${diff.path}`);

  before(async () => {
    const { manifest } = loadCostParityManifest(MANIFEST);
    report = await compareCostParityCorpus(manifest);
  });

  it('passes: every case matches or has a documented difference', () => {
    assert.equal(report.gate.passed, true, report.gate.reasons.join('\n'));
    assert.equal(report.gate.exitCode, 0);
    assert.equal(report.totals.fail, 0);
    assert.equal(report.totals.differences.unexplained, 0);
    assert.equal(report.totals.differences.sdk_bug, 0);
  });

  it('shows no dollar drift on any case', () => {
    for (const caseReport of report.cases) {
      assert.equal(
        caseReport.differences.some((diff) => diff.path === 'totalCostUsd' || diff.path.endsWith('.costUsd')),
        false,
        caseReport.caseId,
      );
    }
  });

  it('classifies all-unpriced work as unpriced data, not a zero cost (M-1)', () => {
    assert.deepEqual(classified('claude-all-unpriced'), ['unpriced_data:M-1:attribution.coverage']);
    assert.equal(byId('claude-all-unpriced').sdkSummary?.total_cost_usd, null);
  });

  it('classifies mixed priced/unpriced Claude work as an exact match with partial coverage', () => {
    assert.equal(byId('claude-mixed-one-unpriced').verdict, 'match');
    assert.equal(byId('claude-mixed-one-unpriced').sdk.attribution?.coverage, 'partial');
  });

  it('classifies replayed Claude Code lines as a legacy bug (M-3 / EF-2)', () => {
    assert.ok(classified('claude-duplicate-message-id').includes('legacy_bug:M-3:turnCount'));
  });

  it('classifies native missing usage via the manifest expected fix (EF-1)', () => {
    assert.ok(classified('native-missing-usage-partial').includes('legacy_bug:EF-1:attribution.coverage'));
  });

  it('keeps native explicit-zero and provider-reported coverage conservative (M-2, M-4)', () => {
    for (const id of ['native-explicit-zero', 'native-provider-reported-cost']) {
      assert.ok(classified(id).includes('intentional_contract_change:M-2:attribution.coverage'), id);
      assert.ok(classified(id).some((entry) => entry.startsWith('intentional_contract_change:M-4:')), id);
    }
  });

  it('matches Codex cache and reasoning accounting exactly', () => {
    assert.equal(byId('codex-cached-and-reasoning').verdict, 'match');
    assert.equal(byId('codex-cached-and-reasoning').sdk.attribution?.coverage, 'complete');
  });

  it('agrees on missing sessions', () => {
    assert.equal(byId('missing-sessions').verdict, 'match');
    assert.equal(byId('missing-sessions').sdk.status, 'no_sessions');
  });

  it('emits no transcript content, canary, or sandbox path', () => {
    const serialized = JSON.stringify(report) + formatCostMigrationReport(report);
    for (const forbidden of ['secret-token-should-not-persist', 'cost-parity-', '/var/folders', '/tmp/', 'rawContent']) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  });
});

describe('compareCostOutcomes — classification and invariants', () => {
  it('fails the gate on unexplained cost drift', () => {
    const caseReport = compare(success(), success({ totalCostUsd: 1.5 }));
    const drift = caseReport.differences.find((diff) => diff.path === 'totalCostUsd');
    assert.equal(drift?.classification, 'unexplained');
    assert.equal(caseReport.verdict, 'fail');
    const report = buildCostMigrationReport([caseReport]);
    assert.equal(report.gate.exitCode, 1);
    assert.match(report.gate.reasons.join(), /unexplained difference at totalCostUsd/);
  });

  it('tolerates sub-1e-9 USD rounding', () => {
    assert.equal(compare(success(), success({ totalCostUsd: 1 + 1e-12 })).verdict, 'match');
  });

  it('fails when a partial legacy cost becomes complete', () => {
    const caseReport = compare(
      success({ attribution: attribution({ coverage: 'partial' }) }),
      success({ attribution: attribution({ coverage: 'complete' }) }),
    );
    assert.equal(caseReport.verdict, 'fail');
    assert.ok(caseReport.invariantViolations.some((violation) => violation.includes('legacy partial cost became complete')));
  });

  it('fails when a projected known/complete coverage has no resolved SDK total', () => {
    const base = summary('claude-success');
    const caseReport = compareCostOutcomes({
      caseId: 'synthetic',
      source: 'history',
      legacy: success(),
      sdk: success(),
      summary: { ...base, total_cost_usd: null },
    });
    assert.equal(caseReport.verdict, 'fail');
    assert.ok(caseReport.invariantViolations.some((violation) => violation.includes('unresolved SDK total')));
  });

  it('blocks the gate on any sdk_bug classification', () => {
    const caseReport: CostMigrationCaseReport = {
      ...compare(success(), success()),
      differences: [{ path: 'turnCount', legacy: 1, sdk: 2, classification: 'sdk_bug', ruleId: 'X' }],
    };
    assert.equal(buildCostMigrationReport([caseReport]).gate.passed, false);
  });

  it('fails the gate when nothing was compared', () => {
    assert.deepEqual(buildCostMigrationReport([]).gate.reasons, ['no cases compared']);
  });

  it('classifies segment-count semantics as an intentional contract change (M-5)', () => {
    const caseReport = compare(success(), success({ attribution: attribution({ pricedSessions: 3 }) }));
    assert.equal(caseReport.differences[0].ruleId, 'M-5');
    assert.equal(caseReport.verdict, 'approved');
  });

  it('classifies the legacy native duplicate model entry as a legacy bug (M-6 / EF-13)', () => {
    const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 };
    const nativeAttribution = attribution({
      source: 'native',
      models: [{ provider: 'native', modelId: 'gpt-4o', priced: true, costUsd: 1, ...usage }],
    });
    const legacy = success({
      models: { 'openai/gpt-4o': { ...usage, costUsd: 0 }, 'gpt-4o': { ...usage, costUsd: 1 } },
      attribution: nativeAttribution,
    });
    const sdk = success({ models: { 'gpt-4o': { ...usage, costUsd: 1 } }, attribution: nativeAttribution });
    const caseReport = compare(legacy, sdk, 'native');
    assert.deepEqual(caseReport.differences.map((diff) => `${diff.classification}:${diff.ruleId}`), ['legacy_bug:M-6']);

    // Tokens that do not match legacy's own attribution stay unexplained.
    const short = success({ models: { 'gpt-4o': { ...usage, inputTokens: 1, costUsd: 1 } }, attribution: nativeAttribution });
    assert.equal(compare(legacy, short, 'native').verdict, 'fail');
  });

  it('classifies SDK model-id sanitization as an intentional contract change (M-7)', () => {
    const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 };
    const legacy = success({ models: { ...success().models, '<synthetic>': zero } });
    const sdk = success({ models: { ...success().models, 'synthetic-': zero } });
    const caseReport = compare(legacy, sdk);
    assert.deepEqual(caseReport.differences.map((diff) => diff.ruleId), ['M-7', 'M-7']);
    assert.equal(caseReport.verdict, 'approved');
  });
});

describe('compareHistoricalEvalRecords — bounded local sample', () => {
  function record(id: string, withSummary: boolean): EvalRecord {
    const sdk = summary('claude-success');
    const projected = projectTaskCostSummaryToWorkflowCost(sdk);
    return {
      id,
      agentType: 'claude',
      workflowCost: projected.totalCostUsd,
      workflowCostStatus: 'success',
      workflowTokenUsage: projected.models,
      workflowCostAttribution: projected.attribution,
      pricingSnapshot: projected.pricingUsed,
      ...(withSummary ? { taskCostSummary: [sdk] } : {}),
    } as unknown as EvalRecord;
  }

  it('compares the most recent comparable records up to the limit and skips the rest', () => {
    const records = [record('old', true), record('no-sdk', false), record('mid', true), record('new', true)];
    const { cases, skipped } = compareHistoricalEvalRecords(records, { limit: 2 });
    assert.deepEqual(cases.map((caseReport) => caseReport.caseId), ['new', 'mid']);
    assert.equal(skipped, 0);
    assert.ok(cases.every((caseReport) => caseReport.verdict === 'match'));

    const all = compareHistoricalEvalRecords(records, { limit: 10 });
    assert.equal(all.cases.length, 3);
    assert.equal(all.skipped, 1);
  });
});
