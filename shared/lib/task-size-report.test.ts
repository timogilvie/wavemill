import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSizeReport,
  issueIdsInPullRequest,
  latestEstimateByIssue,
  parseSizeEstimateRows,
  renderSizeReport,
  type MergedPrSize,
  type SizeEstimateRow,
} from './task-size-report.ts';
import type { TaskSizeLimits } from './task-size.ts';

const now = new Date('2026-11-11T00:00:00Z');
const LIMITS: TaskSizeLimits = {
  enabled: true,
  maxAddedLines: 800,
  maxFiles: 12,
  coreFiles: ['shared/lib/wavemill-monitor.sh'],
  anchorCoreFile: 'shared/lib/wavemill-monitor.sh',
  maxCoreCompanions: 2,
};

function estimate(overrides: Partial<SizeEstimateRow> = {}): SizeEstimateRow {
  return {
    issueId: 'HOK-1',
    at: '2026-11-01T00:00:00.000Z',
    addedLines: 500,
    files: 4,
    coreFiles: [],
    oversized: false,
    reasons: [],
    slices: 0,
    ...overrides,
  };
}

function pr(overrides: Partial<MergedPrSize> = {}): MergedPrSize {
  return {
    number: 100,
    title: 'HOK-1: do the thing',
    headRefName: 'task/hok-1-do-the-thing',
    additions: 600,
    changedFiles: 5,
    mergedAt: '2026-11-05T00:00:00.000Z',
    ...overrides,
  };
}

describe('parseSizeEstimateRows', () => {
  // protects: a corrupt audit log line must not take down the report
  it('skips malformed rows and keeps usable ones', () => {
    const rows = parseSizeEstimateRows(
      [
        JSON.stringify(estimate()),
        'not json',
        JSON.stringify({ at: '2026-11-01T00:00:00Z', addedLines: 10 }),
        JSON.stringify({ issueId: 'HOK-2', at: 'not-a-date' }),
        '',
        JSON.stringify(estimate({ issueId: 'HOK-3', addedLines: null, oversized: true, reasons: ['files'] })),
      ].join('\n'),
    );
    assert.deepEqual(rows.map((row) => row.issueId), ['HOK-1', 'HOK-3']);
    assert.equal(rows[1].addedLines, null);
    assert.deepEqual(rows[1].reasons, ['files']);
  });
});

describe('latestEstimateByIssue', () => {
  // protects: re-expansion replaces the old estimate instead of double-counting
  it('keeps the newest estimate per issue', () => {
    const latest = latestEstimateByIssue([
      estimate({ at: '2026-10-01T00:00:00Z', addedLines: 100 }),
      estimate({ at: '2026-11-01T00:00:00Z', addedLines: 200 }),
    ]);
    assert.equal(latest.get('HOK-1')!.addedLines, 200);
  });
});

describe('issueIdsInPullRequest', () => {
  // protects: a task PR is matched to its issue through the branch, title or body
  it('finds issue IDs in the branch, title and body', () => {
    assert.deepEqual(
      issueIdsInPullRequest({ title: 'fix HOK-12', body: 'closes HOK-13', headRefName: 'task/hok-14-x' }),
      ['HOK-12', 'HOK-13'],
    );
  });
});

describe('buildSizeReport', () => {
  // protects: the report compares estimate to merged additions and never invents actuals
  it('compares estimates with merged PR additions', () => {
    const report = buildSizeReport({
      estimates: [estimate()],
      pullRequests: [pr()],
      days: 30,
      now,
    });
    assert.equal(report.rows.length, 1);
    const row = report.rows[0];
    assert.equal(row.estimatedLines, 500);
    assert.equal(row.actualLines, 600);
    assert.equal(row.actualFiles, 5);
    assert.equal(row.deltaLines, 100);
    assert.equal(row.ratio, 1.2);
    assert.deepEqual(row.prNumbers, [100]);
    assert.equal(report.totals.withActual, 1);
    assert.equal(report.totals.meanRatio, 1.2);
  });

  // protects: an unmerged estimate is reported without a fabricated actual
  it('reports an estimate with no merged PR as having no actual', () => {
    const report = buildSizeReport({ estimates: [estimate()], pullRequests: [], days: 30, now });
    assert.equal(report.rows[0].actualLines, null);
    assert.equal(report.rows[0].ratio, null);
    assert.equal(report.totals.withActual, 0);
    assert.equal(report.totals.meanRatio, null);
  });

  // protects: the window excludes old estimates and old merges
  it('ignores estimates and merges outside the window', () => {
    const report = buildSizeReport({
      estimates: [
        estimate({ issueId: 'HOK-OLD', at: '2026-01-01T00:00:00Z' }),
        estimate({ issueId: 'HOK-NEW', at: '2026-11-02T00:00:00Z' }),
      ],
      pullRequests: [
        pr({ title: 'HOK-NEW', mergedAt: '2026-01-01T00:00:00Z' }),
        pr({ number: 101, title: 'HOK-OLD', mergedAt: '2026-11-03T00:00:00Z' }),
      ],
      days: 30,
      now,
    });
    assert.deepEqual(report.rows.map((row) => row.issueId), ['HOK-NEW']);
    assert.equal(report.rows[0].actualLines, null);
  });

  // protects: a merged PR with no estimate is not a data point
  it('ignores merged PRs whose issue has no estimate', () => {
    const report = buildSizeReport({ estimates: [], pullRequests: [pr()], days: 30, now });
    assert.equal(report.rows.length, 0);
  });

  // protects: several PRs for one issue sum into one actual size
  it('sums multiple merged PRs attributed to the same issue', () => {
    const report = buildSizeReport({
      estimates: [estimate()],
      pullRequests: [
        pr({ number: 100, additions: 100, changedFiles: 1 }),
        pr({ number: 101, title: 'follow-up HOK-1', additions: 150, changedFiles: 2 }),
      ],
      days: 30,
      now,
    });
    assert.equal(report.rows[0].actualLines, 250);
    assert.equal(report.rows[0].actualFiles, 3);
    assert.deepEqual(report.rows[0].prNumbers, [100, 101]);
  });

  // protects: the median is skewed by a single runaway PR, hiding a systematic
  // underestimate that the mean would show.
  it('reports the median ratio alongside the mean', () => {
    const report = buildSizeReport({
      estimates: [
        estimate({ issueId: 'HOK-1', addedLines: 100 }),
        estimate({ issueId: 'HOK-2', addedLines: 100 }),
        estimate({ issueId: 'HOK-3', addedLines: 100 }),
      ],
      pullRequests: [
        pr({ number: 1, title: 'HOK-1', additions: 100 }),
        pr({ number: 2, title: 'HOK-2', additions: 200 }),
        pr({ number: 3, title: 'HOK-3', additions: 3_000 }),
      ],
      days: 30,
      now,
    });
    assert.equal(report.totals.medianRatio, 2);
    assert.ok(report.totals.meanRatio !== null && report.totals.meanRatio > 10);
  });

  // protects: the confusion table counts held tasks that merged small as false
  // positives and launched tasks that merged large as misses.
  it('classifies held vs actually over the limit under the current limits', () => {
    const report = buildSizeReport({
      estimates: [
        estimate({ issueId: 'HOK-901', addedLines: 900, oversized: true, reasons: ['lines'] }),
        estimate({ issueId: 'HOK-902', addedLines: 900, oversized: true, reasons: ['lines'] }),
        estimate({ issueId: 'HOK-903', addedLines: 500 }),
        estimate({ issueId: 'HOK-904', addedLines: 500 }),
      ],
      pullRequests: [
        pr({ number: 1, title: 'HOK-901: held, merged big', additions: 1_000, changedFiles: 3 }),
        pr({ number: 2, title: 'HOK-902: held, merged small', additions: 200, changedFiles: 2 }),
        pr({ number: 3, title: 'HOK-903: launched, merged big', additions: 900, changedFiles: 4 }),
        pr({ number: 4, title: 'HOK-904: launched, merged small', additions: 100, changedFiles: 1 }),
      ],
      days: 30,
      now,
      limits: LIMITS,
    });
    assert.deepEqual(report.confusion, {
      heldOverLimit: 1,
      heldWithinLimit: 1,
      launchedOverLimit: 1,
      launchedWithinLimit: 1,
    });
    assert.deepEqual(report.limits, { maxAddedLines: 800, maxFiles: 12 });
  });

  // protects: merged PRs with no estimate vanish from the report instead of
  // showing how much work the estimate never covered.
  it('counts merged PRs without an estimate without inventing a row', () => {
    const report = buildSizeReport({
      estimates: [estimate()],
      pullRequests: [
        pr({ number: 1 }),
        pr({ number: 2, title: 'HOK-777: unrelated', headRefName: 'task/hok-777', body: '' }),
        pr({ number: 3, title: 'no issue id here', headRefName: 'chore/x', body: '' }),
      ],
      days: 30,
      now,
    });
    assert.equal(report.totals.mergedPullRequests, 3);
    assert.equal(report.totals.pullRequestsWithoutEstimate, 2);
    assert.equal(report.rows.length, 1);
  });

  // protects: an unknown estimate still reports the actual merged size
  it('keeps the actual size when the estimate is unknown', () => {
    const report = buildSizeReport({
      estimates: [estimate({ addedLines: null })],
      pullRequests: [pr()],
      days: 30,
      now,
    });
    assert.equal(report.rows[0].estimatedLines, null);
    assert.equal(report.rows[0].actualLines, 600);
    assert.equal(report.rows[0].ratio, null);
  });
});

describe('renderSizeReport', () => {
  // protects: the operator-facing report states the window and the ratio
  it('renders the window and each estimate', () => {
    const report = buildSizeReport({ estimates: [estimate()], pullRequests: [pr()], days: 30, now });
    const text = renderSizeReport(report);
    assert.match(text, /last 30 days/);
    assert.match(text, /HOK-1/);
    assert.match(text, /1\.20x/);
    assert.match(text, /within limits/);
  });

  // protects: the operator cannot judge the limits without seeing how often
  // the hold was right, so the report omits the confusion table.
  it('renders the median and the confusion table when limits are known', () => {
    const report = buildSizeReport({
      estimates: [estimate({ addedLines: 900, oversized: true, reasons: ['lines'] })],
      pullRequests: [pr({ additions: 1_000 })],
      days: 30,
      now,
      limits: LIMITS,
    });
    const text = renderSizeReport(report);
    assert.match(text, /median 1\.11x/);
    assert.match(text, /Confusion under current limits \(800 lines, 12 files\)/);
    assert.match(text, /held, actually over:\s+1/);
  });

  // protects: an empty window says so instead of printing an empty table
  it('says when there are no estimates', () => {
    const text = renderSizeReport(
      buildSizeReport({ estimates: [], pullRequests: [], days: 30, now }),
    );
    assert.match(text, /No size estimates recorded/);
  });
});
