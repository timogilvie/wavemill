import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  computeMetrics,
  evaluatePairs,
  extractIssueId,
  findConcurrentPairs,
  groundTruthOverlap,
  parseGhPrList,
  renderBacktestReport,
  runPlannerBacktest,
  type BacktestIssue,
  type BacktestPr,
  type BacktestTask,
  type PairOutcome,
} from './planner-backtest.ts';
import type { GroundedPlanResult } from './grounded-planner.ts';

function btask(id: string, startedAt: string, mergedAt: string, files: string[], extra: Partial<BacktestTask> = {}): BacktestTask {
  return { id, title: id, description: '', blocks: [], dependsOn: [], pr: Number(id.split('-')[1]), startedAt, mergedAt, files, ...extra };
}

function groundedResult(partial: Partial<GroundedPlanResult>): GroundedPlanResult {
  return {
    edges: [],
    touchSets: [],
    scores: [],
    verdicts: [],
    waves: { waves: [], deferrals: [], dropped: [], keptOrdering: [] },
    cache: { touchSets: {}, groundedVerdicts: [] },
    llm: { touchSetAttempted: false, orderingAttempted: false, orderingOk: true, model: null, error: null },
    stats: { tasks: 0, touchSetCacheHits: 0, pairsScored: 0, pairsSentToLlm: 0, verdictCacheHits: 0, llmCallMs: 0, totalMs: 0 },
    ...partial,
  };
}

function outcome(truth: boolean, predicted: boolean): PairOutcome {
  return {
    a: 'A', b: 'B', prA: 1, prB: 2, truthFiles: truth ? ['x'] : [], truth,
    explicit: false, legacy: predicted, grounded: predicted, deterministic: predicted, score: 0,
  };
}

describe('extractIssueId', () => {
  it('prefers the title and falls back to the body', () => {
    assert.equal(extractIssueId({ title: 'HOK-3130: queue inference' }), 'HOK-3130');
    assert.equal(extractIssueId({ title: 'Fix monitor', body: 'Closes HOK-3109.' }), 'HOK-3109');
    assert.equal(extractIssueId({ title: 'chore: promote auto/promotion to main', body: '' }), null);
    assert.equal(extractIssueId({ title: 'ABC-1 thing' }), null);
  });
});

describe('findConcurrentPairs', () => {
  it('pairs tasks whose work windows overlap, and only those', () => {
    const tasks = [
      btask('HOK-1', '2026-09-01T00:00:00Z', '2026-09-01T10:00:00Z', []),
      btask('HOK-2', '2026-09-01T05:00:00Z', '2026-09-01T12:00:00Z', []),
      btask('HOK-3', '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z', []), // starts exactly when HOK-1 merges
      btask('HOK-4', '2026-09-02T00:00:00Z', '2026-09-02T01:00:00Z', []),
    ];
    assert.deepEqual(findConcurrentPairs(tasks).map(([a, b]) => `${a.id}/${b.id}`), ['HOK-1/HOK-2', 'HOK-2/HOK-3']);
  });
});

describe('groundTruthOverlap', () => {
  it('intersects diffs and ignores append-only registries', () => {
    assert.deepEqual(groundTruthOverlap(['a.ts', 'tests/run-unit-tests.sh', 'b.ts'], ['b.ts', 'tests/run-unit-tests.sh', 'a.ts']), ['a.ts', 'b.ts']);
    assert.deepEqual(groundTruthOverlap(['tests/run-unit-tests.sh'], ['tests/run-unit-tests.sh']), []);
  });
});

describe('computeMetrics', () => {
  it('computes the confusion matrix, precision, recall and F1', () => {
    const metrics = computeMetrics([outcome(true, true), outcome(true, false), outcome(false, true), outcome(false, false), outcome(false, false)], 'grounded');
    assert.deepEqual(
      { ...metrics, f1: Number(metrics.f1?.toFixed(3)) },
      { tp: 1, fp: 1, fn: 1, tn: 2, precision: 0.5, recall: 0.5, f1: 0.5, accuracy: 0.6 },
    );
  });

  it('reports n/a (null) when a ratio has no denominator', () => {
    const metrics = computeMetrics([outcome(false, false)], 'legacy');
    assert.equal(metrics.precision, null);
    assert.equal(metrics.recall, null);
    assert.equal(metrics.f1, null);
  });
});

describe('evaluatePairs', () => {
  const a = btask('HOK-1', 's', 'm', ['shared/lib/wavemill-monitor.sh']);
  const b = btask('HOK-2', 's', 'm', ['shared/lib/wavemill-monitor.sh', 'x.ts']);
  const c = btask('HOK-3', 's', 'm', ['y.ts'], { blocks: ['HOK-1'] });

  it('combines ground truth, legacy edges, verdicts, scores and explicit links', () => {
    const outcomes = evaluatePairs(
      [[a, b], [a, c], [b, c]],
      [{ type: 'shared_surface', from: 'HOK-3', to: 'HOK-2', source: 'inferred', reason: 'same area' }],
      {
        verdicts: [{ a: 'HOK-2', b: 'HOK-1', verdict: 'conflict', evidence: 'Both modify the monitor', source: 'llm' }],
        scores: [{ taskA: 'HOK-1', taskB: 'HOK-2', score: 1, signals: ['file_overlap'], overlappingFiles: [] }],
      },
    );
    assert.deepEqual(outcomes[0], {
      a: 'HOK-1', b: 'HOK-2', prA: 1, prB: 2, truthFiles: ['shared/lib/wavemill-monitor.sh'], truth: true, explicit: false,
      legacy: false, grounded: true, groundedVerdict: 'conflict', groundedEvidence: 'Both modify the monitor', deterministic: true, score: 1,
    });
    assert.equal(outcomes[1].explicit, true);
    assert.equal(outcomes[1].legacy, true);
    assert.equal(outcomes[1].grounded, true);
    assert.equal(outcomes[2].legacy, true);
    assert.equal(outcomes[2].legacyReason, 'shared_surface: same area');
    assert.equal(outcomes[2].grounded, false);
  });

  it('uses the score as the grounded prediction when no judge ran', () => {
    const [judged] = evaluatePairs([[a, b]], [], { verdicts: [], scores: [{ taskA: 'HOK-1', taskB: 'HOK-2', score: 0.2, signals: [], overlappingFiles: [] }] });
    const [unjudged] = evaluatePairs([[a, b]], [], { verdicts: [], scores: [{ taskA: 'HOK-1', taskB: 'HOK-2', score: 0.2, signals: [], overlappingFiles: [] }] }, { judged: false });
    assert.equal(judged.grounded, false);
    assert.equal(unjudged.grounded, true);
  });
});

describe('parseGhPrList', () => {
  it('derives the work window from the earliest commit and flattens files', () => {
    const prs = parseGhPrList(JSON.stringify([
      {
        number: 7,
        title: 'HOK-7: thing',
        body: 'b',
        createdAt: '2026-09-02T00:00:00Z',
        mergedAt: '2026-09-03T00:00:00Z',
        files: [{ path: 'a.ts' }, { path: 'b.ts' }],
        commits: [{ authoredDate: '2026-09-01T12:00:00Z' }, { authoredDate: '2026-09-01T06:00:00Z' }],
      },
      { number: 8, title: 'no commits', createdAt: '2026-09-02T00:00:00Z', mergedAt: '2026-09-03T00:00:00Z' },
      { title: 'malformed' },
    ]));
    assert.equal(prs.length, 2);
    assert.deepEqual(prs[0], {
      number: 7, title: 'HOK-7: thing', body: 'b', startedAt: '2026-09-01T06:00:00Z', mergedAt: '2026-09-03T00:00:00Z', files: ['a.ts', 'b.ts'],
    });
    assert.equal(prs[1].startedAt, '2026-09-02T00:00:00Z');
    assert.deepEqual(prs[1].files, []);
  });

  it('rejects non-array output', () => {
    assert.throws(() => parseGhPrList('{}'), /JSON array/);
  });
});

describe('runPlannerBacktest', () => {
  const prs: BacktestPr[] = [
    { number: 11, title: 'HOK-1: monitor reap', startedAt: '2026-09-01T00:00:00Z', mergedAt: '2026-09-01T10:00:00Z', files: ['shared/lib/wavemill-monitor.sh'] },
    { number: 12, title: 'HOK-2: monitor lane', startedAt: '2026-09-01T02:00:00Z', mergedAt: '2026-09-01T09:00:00Z', files: ['shared/lib/wavemill-monitor.sh'] },
    { number: 13, title: 'HOK-1: challenger arm', startedAt: '2026-09-01T00:00:00Z', mergedAt: '2026-09-01T11:00:00Z', files: ['z.ts'] },
    { number: 14, title: 'HOK-3: docs', startedAt: '2026-09-01T03:00:00Z', mergedAt: '2026-09-01T04:00:00Z', files: ['docs/x.md'] },
    { number: 15, title: 'chore: promote', startedAt: '2026-09-01T00:00:00Z', mergedAt: '2026-09-01T01:00:00Z', files: [] },
    { number: 16, title: 'HOK-9: missing issue', startedAt: '2026-09-01T00:00:00Z', mergedAt: '2026-09-01T01:00:00Z', files: [] },
  ];
  const issues: Record<string, BacktestIssue> = {
    'HOK-1': { id: 'HOK-1', title: 'Monitor reap', description: '`shared/lib/wavemill-monitor.sh`', blocks: [], dependsOn: [] },
    'HOK-2': { id: 'HOK-2', title: 'Monitor lane', description: '`shared/lib/wavemill-monitor.sh`', blocks: [], dependsOn: [] },
    'HOK-3': { id: 'HOK-3', title: 'Docs', description: 'docs', blocks: [], dependsOn: [] },
  };

  it('dedupes issues, skips unfetchable ones, judges only concurrent pairs, and scores both planners', async () => {
    let concurrentSeen: Array<[string, string, boolean]> = [];
    const result = await runPlannerBacktest(10, {
      fetchMergedPrs: async () => prs,
      fetchIssue: async (id) => {
        if (id === 'HOK-9') throw new Error('not found');
        return issues[id] ?? null;
      },
      legacyClassify: async () => {
        throw new Error('classifier down\nstack');
      },
      fingerprint: (task) => `fp-${task.id}`,
      groundedPlan: async (tasks, { earliestStart, isConcurrent }) => {
        assert.equal(earliestStart, '2026-09-01T00:00:00Z');
        assert.deepEqual(tasks.map((task) => [task.id, task.fingerprint]), [['HOK-1', 'fp-HOK-1'], ['HOK-2', 'fp-HOK-2'], ['HOK-3', 'fp-HOK-3']]);
        concurrentSeen = [['HOK-1', 'HOK-2', isConcurrent('HOK-2', 'HOK-1')], ['HOK-1', 'HOK-3', isConcurrent('HOK-1', 'HOK-3')]];
        return groundedResult({
          verdicts: [{ a: 'HOK-1', b: 'HOK-2', verdict: 'conflict', evidence: 'Both modify the monitor', source: 'llm' }],
          scores: [{ taskA: 'HOK-1', taskB: 'HOK-2', score: 1, signals: ['file_overlap'], overlappingFiles: [] }],
        });
      },
    });

    assert.deepEqual(result.tasks.map((task) => [task.id, task.pr]), [['HOK-1', 11], ['HOK-2', 12], ['HOK-3', 14]]);
    assert.deepEqual(concurrentSeen, [['HOK-1', 'HOK-2', true], ['HOK-1', 'HOK-3', true]]);
    assert.equal(result.outcomes.length, 3);
    const monitorPair = result.outcomes.find((o) => o.a === 'HOK-1' && o.b === 'HOK-2')!;
    assert.equal(monitorPair.truth, true);
    assert.equal(monitorPair.grounded, true);
    assert.equal(monitorPair.legacy, false);
    assert.deepEqual(result.notes, [
      '1 PR(s) skipped because their Linear issue could not be fetched.',
      'Legacy classifier failed (classifier down); legacy predictions use explicit relations only.',
    ]);

    const report = renderBacktestReport({
      generatedAt: '2026-10-01T00:00:00Z',
      repo: 'auto/integration',
      prsFetched: result.prsFetched,
      tasks: result.tasks,
      outcomes: result.outcomes,
      legacyMode: 'classifier',
      groundedMode: 'llm',
      probeRef: 'abc123',
      notes: result.notes,
      stats: result.grounded.stats,
    });
    assert.match(report, /^# Backtest: Grounded vs Legacy Planner/);
    assert.match(report, /\| Task Pair \| PRs \| Ground Truth Overlap \| Legacy Prediction \| Grounded Prediction \| Correct \|/);
    assert.match(report, /\| Legacy \| 0 \| 0 \| 1 \| 2 \| n\/a \| 0\.0% \| n\/a \| 66\.7% \|/);
    assert.match(report, /\| Grounded \| 1 \| 0 \| 0 \| 2 \| 100\.0% \| 100\.0% \| 100\.0% \| 100\.0% \|/);
    assert.match(report, /\| HOK-1 \/ HOK-2 \| #11 \/ #12 \| yes: `shared\/lib\/wavemill-monitor\.sh` \| ✗ independent \| ✓ conflict: Both modify the monitor \(score 1\) \| grounded \|/);
    assert.match(report, /2 pairs that every planner and the ground truth call independent are omitted/);
    assert.match(report, /`abc123`/);
  });
});
