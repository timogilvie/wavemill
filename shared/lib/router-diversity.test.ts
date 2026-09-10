/**
 * Tests for router diversity reporting.
 */

import assert from 'node:assert/strict';
import type { EvalRecord } from './eval-schema.ts';
import {
  buildDiversityReport,
  formatDiversityReport,
  resolveCoverageConfig,
} from './router-diversity.ts';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(err as Error).message}`);
  }
}

function makeRecord(
  id: string,
  models: { planner?: string; coder: string; reviewer?: string },
  timestamp: string,
  routingMode?: string,
  overrides: Partial<EvalRecord> = {},
): EvalRecord {
  return {
    id,
    schemaVersion: '1.0.0',
    originalPrompt: 'Implement a feature',
    modelId: models.coder,
    modelVersion: models.coder,
    score: 0.8,
    scoreBand: 'good',
    timeSeconds: 100,
    timestamp,
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'ok',
    taskDescriptor: {
      schema_version: '1.0',
      signals: {
        heuristic: {
          task_type: 'feature',
          languages: ['typescript'],
          framework_tags: [],
          files_touched: 3,
          repo_size_loc: 10_000,
          description_tokens: 100,
          is_greenfield: false,
          has_migration: false,
          has_ui: false,
          has_tests: true,
          cross_service: false,
        },
        learned: { complexity: 3, domain: 'backend', risk_flags: [] },
      },
      constraints: { models_available: [], objective: 'balanced' },
      stages: {
        ...(models.planner ? { planner: { model: models.planner } } : {}),
        coder: { model: models.coder },
        ...(models.reviewer ? { reviewer: { model: models.reviewer } } : {}),
      },
    },
    ...(routingMode ? { routeProvenance: { routingMode } } : {}),
    ...overrides,
  } as EvalRecord;
}

console.log('\n--- router-diversity Tests ---\n');

test('resolveCoverageConfig applies defaults and rejects invalid values', () => {
  const defaults = resolveCoverageConfig();
  assert.equal(defaults.minRecordsPerModelStage, 15);
  assert.equal(defaults.maxStageShare, 0.7);
  assert.equal(defaults.window, 50);

  const custom = resolveCoverageConfig({ minRecordsPerModelStage: 5, maxStageShare: 0.5, window: 10 });
  assert.equal(custom.minRecordsPerModelStage, 5);
  assert.equal(custom.maxStageShare, 0.5);
  assert.equal(custom.window, 10);

  const invalid = resolveCoverageConfig({ minRecordsPerModelStage: 0, maxStageShare: 2, window: -1 });
  assert.equal(invalid.minRecordsPerModelStage, 15);
  assert.equal(invalid.maxStageShare, 0.7);
  assert.equal(invalid.window, 50);
});

test('stage shares are computed per stage with dominance warnings', () => {
  const records = [
    makeRecord('1', { planner: 'model-a', coder: 'model-a', reviewer: 'model-b' }, '2026-06-01T00:00:00Z'),
    makeRecord('2', { planner: 'model-a', coder: 'model-a', reviewer: 'model-b' }, '2026-06-02T00:00:00Z'),
    makeRecord('3', { planner: 'model-a', coder: 'model-a', reviewer: 'model-b' }, '2026-06-03T00:00:00Z'),
    makeRecord('4', { planner: 'model-b', coder: 'model-b', reviewer: 'model-a' }, '2026-06-04T00:00:00Z'),
  ];
  const report = buildDiversityReport(records, {
    coverage: resolveCoverageConfig({ window: 10, maxStageShare: 0.7, minRecordsPerModelStage: 2 }),
  });

  assert.equal(report.windowRecords.plan, 4);
  const planTop = report.stageShares.plan[0];
  assert.equal(planTop.model, 'model-a');
  assert.equal(planTop.count, 3);
  assert.ok(Math.abs(planTop.share - 0.75) < 1e-9);

  // model-a holds 75% of plan and implementation -> two warnings; review is 75% model-b
  assert.equal(report.dominanceWarnings.length, 3);
  assert.ok(report.dominanceWarnings.some((w) => w.stage === 'plan' && w.model === 'model-a'));
  assert.ok(report.dominanceWarnings.some((w) => w.stage === 'review' && w.model === 'model-b'));
});

test('the window restricts shares to the most recent records', () => {
  const records = [
    // Old records dominated by model-old
    ...Array.from({ length: 5 }, (_, index) => makeRecord(
      `old-${index}`,
      { planner: 'model-old', coder: 'model-old', reviewer: 'model-old' },
      `2026-05-0${index + 1}T00:00:00Z`,
    )),
    // Recent records use model-new
    ...Array.from({ length: 3 }, (_, index) => makeRecord(
      `new-${index}`,
      { planner: 'model-new', coder: 'model-new', reviewer: 'model-new' },
      `2026-06-0${index + 1}T00:00:00Z`,
    )),
  ];
  const report = buildDiversityReport(records, {
    coverage: resolveCoverageConfig({ window: 3, minRecordsPerModelStage: 1 }),
  });

  assert.equal(report.windowRecords.implementation, 3);
  assert.equal(report.stageShares.implementation.length, 1);
  assert.equal(report.stageShares.implementation[0].model, 'model-new');
  // Cumulative coverage still counts the old records
  const oldCell = report.coverageCells.find((cell) => cell.model === 'model-old' && cell.stage === 'implementation');
  assert.equal(oldCell?.count, 5);
});

test('coverage cells flag below-target counts and include configured zero-record models', () => {
  const records = [
    makeRecord('1', { planner: 'model-a', coder: 'model-a', reviewer: 'model-a' }, '2026-06-01T00:00:00Z'),
    makeRecord('2', { planner: 'model-a', coder: 'model-a', reviewer: 'model-a' }, '2026-06-02T00:00:00Z'),
  ];
  const report = buildDiversityReport(records, {
    coverage: resolveCoverageConfig({ minRecordsPerModelStage: 2, window: 10 }),
    configuredModels: { plan: ['model-a', 'model-fresh'] },
  });

  const covered = report.coverageCells.find((cell) => cell.model === 'model-a' && cell.stage === 'plan');
  assert.equal(covered?.count, 2);
  assert.equal(covered?.belowTarget, false);

  const fresh = report.coverageCells.find((cell) => cell.model === 'model-fresh' && cell.stage === 'plan');
  assert.ok(fresh, 'configured zero-record model should appear in coverage');
  assert.equal(fresh!.count, 0);
  assert.equal(fresh!.belowTarget, true);
});

test('records without per-stage attribution only count toward implementation', () => {
  const records = [
    makeRecord('1', { coder: 'model-a' }, '2026-06-01T00:00:00Z'),
  ];
  const report = buildDiversityReport(records, {
    coverage: resolveCoverageConfig({ window: 10, minRecordsPerModelStage: 1 }),
  });

  assert.equal(report.windowRecords.plan, 0);
  assert.equal(report.windowRecords.review, 0);
  assert.equal(report.windowRecords.implementation, 1);
});

test('inherited stages are excluded from window and cumulative coverage counts', () => {
  const records = [
    makeRecord(
      'forked',
      { planner: 'planner-model', coder: 'coder-model', reviewer: 'reviewer-model' },
      '2026-06-01T00:00:00Z',
      undefined,
      {
        challengePairId: 'pair-1',
        challengeSide: 'challenger',
        challengeIntent: {
          pairId: 'pair-1',
          challengeStage: 'review',
          primary: {
            pairId: 'pair-1',
            side: 'primary',
            challengeStage: 'review',
            expectedStageModel: 'reviewer-a',
            expectedRoute: { planner: 'planner-model', coder: 'coder-model', reviewer: 'reviewer-a', planDepth: 'light', codeDepth: 'light', reviewMode: 'static' },
            inheritedStages: [],
          },
          challenger: {
            pairId: 'pair-1',
            side: 'challenger',
            challengeStage: 'review',
            expectedStageModel: 'reviewer-model',
            expectedRoute: { planner: 'planner-model', coder: 'coder-model', reviewer: 'reviewer-model', planDepth: 'light', codeDepth: 'light', reviewMode: 'static' },
            inheritedStages: ['plan', 'implementation'],
          },
          forkStage: 'review',
          forkCommit: 'f'.repeat(40),
          sharedPrefix: true,
        },
      },
    ),
  ];
  const report = buildDiversityReport(records, {
    coverage: resolveCoverageConfig({ window: 10, minRecordsPerModelStage: 1 }),
  });

  assert.equal(report.windowRecords.plan, 0);
  assert.equal(report.windowRecords.implementation, 0);
  assert.equal(report.windowRecords.review, 1);
  assert.equal(report.coverageCells.find((cell) => cell.model === 'planner-model' && cell.stage === 'plan'), undefined);
  assert.equal(report.coverageCells.find((cell) => cell.model === 'coder-model' && cell.stage === 'implementation'), undefined);
  assert.equal(report.coverageCells.find((cell) => cell.model === 'reviewer-model' && cell.stage === 'review')?.count, 1);
});

test('routing modes are tallied over the window', () => {
  const records = [
    makeRecord('1', { coder: 'model-a' }, '2026-06-01T00:00:00Z', 'stage-aware'),
    makeRecord('2', { coder: 'model-a' }, '2026-06-02T00:00:00Z', 'heuristic-fallback'),
    makeRecord('3', { coder: 'model-a' }, '2026-06-03T00:00:00Z', 'heuristic-fallback'),
    makeRecord('4', { coder: 'model-a' }, '2026-06-04T00:00:00Z'),
  ];
  const report = buildDiversityReport(records, {
    coverage: resolveCoverageConfig({ window: 10, minRecordsPerModelStage: 1 }),
  });

  assert.equal(report.routingModes['heuristic-fallback'], 2);
  assert.equal(report.routingModes['stage-aware'], 1);
  assert.equal(report.routingModes.unknown, 1);
});

test('formatDiversityReport renders tables, target flags, and warnings', () => {
  const records = [
    makeRecord('1', { planner: 'model-a', coder: 'model-a', reviewer: 'model-a' }, '2026-06-01T00:00:00Z', 'stage-aware'),
  ];
  const report = buildDiversityReport(records, {
    coverage: resolveCoverageConfig({ window: 10, minRecordsPerModelStage: 5, maxStageShare: 0.7 }),
  });
  const text = formatDiversityReport(report);

  assert.ok(text.includes('Model share — plan'));
  assert.ok(text.includes('Coverage vs target (5 records per model per stage)'));
  assert.ok(text.includes('1*'), 'below-target counts are starred');
  assert.ok(text.includes('stage-aware'));
  assert.ok(text.includes('100.0%'));
  assert.ok(text.includes('Warnings'));
});

process.on('exit', () => {
  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);
  if (failed > 0) process.exitCode = 1;
});
