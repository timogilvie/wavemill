/**
 * Fork-aware comparison and inherited-stage attribution (HOK-2812_c).
 *
 * Covers:
 *  - buildComparisonPrompt: byte-identical output when there is no shared
 *    context; shared prefix injected as neutral context otherwise.
 *  - inheritedStagesForRecord / stageInherited: side-aware inheritance
 *    detection from the P0.5 challengeIntent fields.
 *  - buildEvalSummary: per-model-per-stage coverage excludes inherited
 *    stages while still counting the varied stage.
 *  - buildDiversityReport: cumulative and windowed stage shares exclude
 *    inherited stages.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildComparisonPrompt } from '../shared/lib/pr-comparison.ts';
import {
  inheritedStagesForRecord,
  stageInherited,
} from '../shared/lib/challenge-execution-contract.ts';
import { buildEvalSummary, clearChallengeSchedulerCache } from '../shared/lib/challenge-scheduler.ts';
import { buildDiversityReport, resolveCoverageConfig } from '../shared/lib/router-diversity.ts';
import { clearConfigCache } from '../shared/lib/config.ts';
import type { EvalRecord } from '../shared/lib/eval-schema.ts';

describe('buildComparisonPrompt shared context', () => {
  const baseInput = {
    issuePrompt: 'HOK-2812_c: Fork-aware comparison',
    primaryDiff: 'diff --git a/a b/a\n@@ -1 +1 @@\n-old\n+new-primary',
    challengerDiff: 'diff --git a/a b/a\n@@ -1 +1 @@\n-old\n+new-challenger',
    presentationOrder: 'primary-first' as const,
  };

  it('is byte-identical when sharedContext is omitted', () => {
    const baseline = buildComparisonPrompt(baseInput);
    const withEmpty = buildComparisonPrompt({ ...baseInput, sharedContext: '' });
    const withWhitespace = buildComparisonPrompt({ ...baseInput, sharedContext: '   \n\n' });
    assert.equal(withEmpty, baseline);
    assert.equal(withWhitespace, baseline);
  });

  it('adds shared prefix once outside Candidate A/B when provided', () => {
    const sharedPrefix = 'diff --git a/shared b/shared\n@@ -1 +1 @@\n-x\n+y-shared';
    const prompt = buildComparisonPrompt({ ...baseInput, sharedContext: sharedPrefix });
    const sharedMatches = prompt.match(/Shared Pre-Fork Context/g) ?? [];
    assert.equal(sharedMatches.length, 1, 'shared prefix header appears exactly once');
    assert.ok(prompt.includes(sharedPrefix), 'shared prefix content included');
    assert.ok(prompt.includes(baseInput.primaryDiff), 'primary delta still present');
    assert.ok(prompt.includes(baseInput.challengerDiff), 'challenger delta still present');
    // The neutral context must precede the candidate blocks.
    const sharedIdx = prompt.indexOf('Shared Pre-Fork Context');
    const candidateAIdx = prompt.indexOf('Candidate A diff:');
    assert.ok(sharedIdx > 0 && candidateAIdx > sharedIdx, 'shared context appears before candidates');
  });
});

describe('inherited-stage predicate', () => {
  it('returns [] for records without a challenge side or intent', () => {
    const record = { modelId: 'x' } as unknown as EvalRecord;
    assert.deepEqual(inheritedStagesForRecord(record), []);
    assert.equal(stageInherited(record, 'plan'), false);
  });

  it('reads inheritedStages from the challenger side of the projection', () => {
    const record = {
      challengeSide: 'challenger',
      challengeIntent: {
        pairId: 'p1',
        challengeStage: 'review',
        primary: { pairId: 'p1', side: 'primary', challengeStage: 'review', expectedStageModel: 'A', expectedRoute: {} },
        challenger: {
          pairId: 'p1',
          side: 'challenger',
          challengeStage: 'review',
          expectedStageModel: 'B',
          expectedRoute: {},
          inheritedStages: ['plan', 'implementation'],
        },
      },
    } as unknown as EvalRecord;
    assert.deepEqual(inheritedStagesForRecord(record).sort(), ['implementation', 'plan']);
    assert.equal(stageInherited(record, 'plan'), true);
    assert.equal(stageInherited(record, 'implementation'), true);
    assert.equal(stageInherited(record, 'review'), false);
  });

  it('ignores non-array or unknown-stage entries', () => {
    const record = {
      challengeSide: 'primary',
      challengeIntent: {
        primary: { inheritedStages: ['plan', 'bogus', 42] },
        challenger: { inheritedStages: 'nope' },
      },
    } as unknown as EvalRecord;
    assert.deepEqual(inheritedStagesForRecord(record), ['plan']);
  });
});

describe('coverage counting excludes inherited stages', () => {
  let repoDir = '';

  before(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'fork-aware-cov-'));
    mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
    writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({}));
    clearConfigCache(repoDir);
    clearChallengeSchedulerCache(repoDir);

    // Two forked challenger records: both inherit plan+implementation from the
    // primary arm; only review was varied and truly executed on this side.
    const records = [
      {
        id: 'r-1',
        modelId: 'model-x',
        timestamp: '2026-09-08T00:00:00Z',
        challengeSide: 'challenger',
        challengeIntent: {
          pairId: 'pair-1',
          challengeStage: 'review',
          primary: { pairId: 'pair-1', side: 'primary', challengeStage: 'review', expectedStageModel: 'model-shared-planner', expectedRoute: {} },
          challenger: {
            pairId: 'pair-1',
            side: 'challenger',
            challengeStage: 'review',
            expectedStageModel: 'model-x-reviewer',
            expectedRoute: {},
            inheritedStages: ['plan', 'implementation'],
          },
        },
        taskDescriptor: {
          stages: {
            planner: { model: 'model-shared-planner' },
            coder: { model: 'model-shared-coder' },
            reviewer: { model: 'model-x-reviewer' },
          },
        },
      },
      {
        id: 'r-2',
        modelId: 'model-independent',
        timestamp: '2026-09-08T01:00:00Z',
        // Independent (non-forked) record: everything counts.
        taskDescriptor: {
          stages: {
            planner: { model: 'model-independent-planner' },
            coder: { model: 'model-independent' },
            reviewer: { model: 'model-independent-reviewer' },
          },
        },
      },
    ];
    writeFileSync(
      join(repoDir, '.wavemill', 'evals', 'eval.jsonl'),
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
  });

  after(() => {
    clearConfigCache(repoDir);
    clearChallengeSchedulerCache(repoDir);
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('buildEvalSummary skips inherited planner/coder stages for the challenger', () => {
    const summary = buildEvalSummary(repoDir);
    // Inherited planner/coder must NOT credit the shared planner/coder models.
    assert.equal(summary.recordsByModelStage?.['model-shared-planner']?.plan ?? 0, 0);
    assert.equal(summary.recordsByModelStage?.['model-shared-coder']?.implementation ?? 0, 0);
    // The varied stage (review) on the challenger MUST still count.
    assert.equal(summary.recordsByModelStage?.['model-x-reviewer']?.review ?? 0, 1);
    // The independent record counts on all three stages normally.
    assert.equal(summary.recordsByModelStage?.['model-independent-planner']?.plan ?? 0, 1);
    assert.equal(summary.recordsByModelStage?.['model-independent']?.implementation ?? 0, 1);
    assert.equal(summary.recordsByModelStage?.['model-independent-reviewer']?.review ?? 0, 1);
  });

  it('buildDiversityReport excludes inherited stages from windowed and cumulative shares', () => {
    // Read the same records that buildEvalSummary consumed.
    const records: EvalRecord[] = readFileSync(join(repoDir, '.wavemill', 'evals', 'eval.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const report = buildDiversityReport(records, {
      coverage: resolveCoverageConfig({ minRecordsPerModelStage: 5, window: 50 }),
    });
    // No plan/impl coverage for the shared prefix models — those are inherited.
    const planShareShared = report.stageShares.plan.find((entry) => entry.model === 'model-shared-planner');
    const implShareShared = report.stageShares.implementation.find((entry) => entry.model === 'model-shared-coder');
    assert.equal(planShareShared, undefined);
    assert.equal(implShareShared, undefined);
    // The varied reviewer stage still counts.
    const reviewShareVaried = report.stageShares.review.find((entry) => entry.model === 'model-x-reviewer');
    assert.ok(reviewShareVaried && reviewShareVaried.count === 1, 'varied reviewer counts once');
    // The independent record shows up in every stage.
    assert.ok(report.stageShares.plan.some((entry) => entry.model === 'model-independent-planner'));
    assert.ok(report.stageShares.implementation.some((entry) => entry.model === 'model-independent'));
    assert.ok(report.stageShares.review.some((entry) => entry.model === 'model-independent-reviewer'));
    // Cumulative coverage cells must reflect the same exclusion.
    const sharedPlannerCell = report.coverageCells.find(
      (cell) => cell.model === 'model-shared-planner' && cell.stage === 'plan',
    );
    assert.equal(sharedPlannerCell, undefined);
  });
});
