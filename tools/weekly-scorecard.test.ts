import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { countExceptions, formatScorecard, scorecardDeps, type Scorecard } from './weekly-scorecard.ts';

afterEach(() => {
  mock.restoreAll();
});

describe('formatScorecard', () => {
  it('reports total production lines, monitor lines and the exceptions used', () => {
    // protects: the weekly report omits a required figure or lists no exception reasons.
    const scorecard: Scorecard = {
      date: '2026-11-11',
      totalProductionLines: 345768,
      monitorLines: 24790,
      exceptions: [{ pr: 12, reason: 'legacy support needs it' }],
    };
    const text = formatScorecard(scorecard);
    assert.match(text, /^=== Weekly Consolidation Scorecard \(2026-11-11\) ===$/m);
    assert.match(text, /Total production lines:\s+345,768/);
    assert.match(text, /shared\/lib\/wavemill-monitor\.sh:\s+24,790/);
    assert.match(text, /Exceptions used \(last 7 days\):\s+1/);
    assert.match(text, /- #12: legacy support needs it/);
  });

  it('reports an unavailable exception read as unavailable, never as zero', () => {
    // protects: a failed gh call reads as "no exceptions were used".
    const text = formatScorecard({
      date: '2026-11-11', totalProductionLines: 10, monitorLines: 1, exceptions: null,
    });
    assert.match(text, /Exceptions used \(last 7 days\):\s+\[Unavailable\]/);
  });
});

describe('countExceptions', () => {
  it('counts only merged PRs whose body records an exception', () => {
    // protects: ordinary consolidation PRs inflate the exception count.
    mock.method(scorecardDeps, 'execShellCommand', () => JSON.stringify([
      { number: 7, body: 'Notes.\nConsolidation Exception: legacy code path' },
      { number: 8, body: 'ordinary consolidation PR' },
      { number: 9, body: null },
    ]));
    assert.deepEqual(countExceptions('/repo', '2026-11-04'), [
      { pr: 7, reason: 'legacy code path' },
    ]);
  });

  it('returns null when the merged-PR read fails', () => {
    // protects: an unavailable `gh pr list` is reported as zero exceptions.
    mock.method(scorecardDeps, 'execShellCommand', () => {
      throw new Error('gh: not authenticated');
    });
    mock.method(scorecardDeps, 'warn', () => undefined);
    assert.equal(countExceptions('/repo', '2026-11-04'), null);
  });
});
