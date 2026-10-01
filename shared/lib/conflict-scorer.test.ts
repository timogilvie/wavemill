import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CO_CHANGE_MIN_STRENGTH,
  buildCoChangeIndex,
  detectSeries,
  findCrossReference,
  isSweepTask,
  parseGitLogNameOnly,
  sameSeries,
  scorePair,
  scorePairConflicts,
  type CoChangeIndex,
} from './conflict-scorer.ts';
import type { TouchEntry, TouchSet } from './touch-set-predictor.ts';

function touch(taskId: string, ...entries: Array<string | TouchEntry>): TouchSet {
  return {
    taskId,
    entries: entries.map((entry) => (typeof entry === 'string' ? { path: entry, source: 'explicit' as const } : entry)),
  };
}

const NO_HOT = { hotFiles: [], coChange: null };

describe('scorePair — file overlap', () => {
  it('zero overlap scores 0 with no signals', () => {
    const pair = scorePair({ id: 'HOK-1' }, { id: 'HOK-2' }, touch('HOK-1', 'a.ts'), touch('HOK-2', 'b.ts'));
    assert.equal(pair.score, 0);
    assert.deepEqual(pair.signals, []);
    assert.deepEqual(pair.overlappingFiles, []);
  });

  it('full overlap scores 1', () => {
    const pair = scorePair({ id: 'HOK-1' }, { id: 'HOK-2' }, touch('HOK-1', 'a.ts', 'b.ts'), touch('HOK-2', 'b.ts', 'a.ts'));
    assert.equal(pair.score, 1);
    assert.deepEqual(pair.signals, ['file_overlap']);
    assert.deepEqual(pair.overlappingFiles, ['a.ts', 'b.ts']);
  });

  it('partial overlap is normalized by the smaller touch set', () => {
    const pair = scorePair(
      { id: 'HOK-1' },
      { id: 'HOK-2' },
      touch('HOK-1', 'a.ts', 'b.ts'),
      touch('HOK-2', 'a.ts', 'c.ts', 'd.ts', 'e.ts'),
    );
    assert.equal(pair.score, 0.5);
  });

  it('missing or empty touch sets score 0', () => {
    assert.equal(scorePair({ id: 'HOK-1' }, { id: 'HOK-2' }, undefined, touch('HOK-2', 'a.ts')).score, 0);
  });

  it('ignores low-conflict registry files', () => {
    const pair = scorePair(
      { id: 'HOK-1' },
      { id: 'HOK-2' },
      touch('HOK-1', 'tests/run-unit-tests.sh', 'a.ts'),
      touch('HOK-2', 'tests/run-unit-tests.sh', 'b.ts'),
    );
    assert.equal(pair.score, 0);
  });

  it('normalizes pair order so taskA has the lower ID', () => {
    const pair = scorePair({ id: 'HOK-10' }, { id: 'HOK-9' }, touch('HOK-10', 'a.ts'), touch('HOK-9', 'a.ts'));
    assert.equal(pair.taskA, 'HOK-9');
    assert.equal(pair.taskB, 'HOK-10');
  });
});

describe('scorePair — hot files and regions', () => {
  const monitor = 'shared/lib/wavemill-monitor.sh';

  it('flags overlap on a default hot file', () => {
    const pair = scorePair({ id: 'HOK-1' }, { id: 'HOK-2' }, touch('HOK-1', monitor), touch('HOK-2', monitor));
    assert.deepEqual(pair.signals, ['file_overlap', 'hot_file']);
    assert.equal(pair.score, 1);
  });

  it('halves the weight when both tasks name different functions in the hot file', () => {
    const pair = scorePair(
      { id: 'HOK-1' },
      { id: 'HOK-2' },
      touch('HOK-1', { path: monitor, source: 'resolved', symbols: ['poll_loop'] }),
      touch('HOK-2', { path: monitor, source: 'resolved', symbols: ['reap_tasks'] }),
    );
    assert.ok(pair.signals.includes('disjoint_regions'));
    assert.equal(pair.score, 0.5);
  });

  it('keeps full weight when both tasks name the same function', () => {
    const pair = scorePair(
      { id: 'HOK-1' },
      { id: 'HOK-2' },
      touch('HOK-1', { path: monitor, source: 'resolved', symbols: ['poll_loop'] }),
      touch('HOK-2', { path: monitor, source: 'resolved', symbols: ['poll_loop', 'other'] }),
    );
    assert.ok(pair.signals.includes('region_overlap'));
    assert.equal(pair.score, 1);
  });

  it('honors custom hot files', () => {
    const pair = scorePair({ id: 'HOK-1' }, { id: 'HOK-2' }, touch('HOK-1', 'x.ts'), touch('HOK-2', 'x.ts'), { hotFiles: ['x.ts'] });
    assert.ok(pair.signals.includes('hot_file'));
  });
});

describe('series detection', () => {
  it('detects n/m and part-n-of-m markers', () => {
    assert.deepEqual(detectSeries('Arbiter R6 (3/5): wire scorer'), { key: 'arbiter r6', index: 3, total: 5 });
    assert.deepEqual(detectSeries('Migration part 2 of 4'), { key: 'migration', index: 2, total: 4 });
    assert.equal(detectSeries('No series here'), null);
    assert.equal(detectSeries('Bad (6/5)'), null);
  });

  it('matches same-series titles and rejects different totals', () => {
    assert.ok(sameSeries('Arbiter R6 (3/5): wire scorer', 'Arbiter R6 (5/5): ship report'));
    assert.equal(sameSeries('Arbiter R6 (3/5): wire scorer', 'Arbiter R6 (5/6): ship report'), null);
    assert.equal(sameSeries('Foo (1/2) alpha', 'Bar (2/2) beta'), null);
  });

  it('adds the series signal and orders the lower index first', () => {
    const pair = scorePair(
      { id: 'HOK-3118', title: 'Arbiter R6 (5/5): ship report' },
      { id: 'HOK-3116', title: 'Arbiter R6 (3/5): wire scorer' },
      undefined,
      undefined,
      NO_HOT,
    );
    assert.deepEqual(pair.signals, ['series']);
    assert.equal(pair.score, 0.5);
    assert.deepEqual(pair.hint, { before: 'HOK-3116', after: 'HOK-3118', reason: 'series 3/5 before 5/5' });
  });
});

describe('cross references', () => {
  it('"builds on" puts the referenced task first', () => {
    const ref = findCrossReference({ id: 'HOK-3122', description: 'This builds on HOK-3120 by adding retries.' }, 'HOK-3120');
    assert.equal(ref.mentioned, true);
    assert.equal(ref.hint?.before, 'HOK-3120');
    assert.equal(ref.hint?.after, 'HOK-3122');
  });

  it('"before" puts the referencing task first', () => {
    const ref = findCrossReference({ id: 'HOK-1', description: 'Must land before HOK-2 starts.' }, 'HOK-2');
    assert.equal(ref.hint?.before, 'HOK-1');
  });

  it('a bare mention has no direction and does not match longer IDs', () => {
    assert.deepEqual(findCrossReference({ id: 'HOK-1', description: 'Related: HOK-2.' }, 'HOK-2'), { mentioned: true });
    assert.deepEqual(findCrossReference({ id: 'HOK-1', description: 'See HOK-20.' }, 'HOK-2'), { mentioned: false });
  });

  it('adds the cross_reference signal with the hint', () => {
    const pair = scorePair(
      { id: 'HOK-3120', title: 'Retry primitive' },
      { id: 'HOK-3122', title: 'Use retries', description: 'Follow-up to HOK-3120.' },
      undefined,
      undefined,
      NO_HOT,
    );
    assert.deepEqual(pair.signals, ['cross_reference']);
    assert.equal(pair.score, 0.4);
    assert.equal(pair.hint?.before, 'HOK-3120');
  });
});

describe('sweep detection', () => {
  it('detects sweep phrasing and oversized touch sets', () => {
    assert.equal(isSweepTask({ id: 'S', title: 'Migrate all users in user-schema.ts' }, undefined), true);
    assert.equal(isSweepTask({ id: 'S', title: 'Rename across the codebase' }, undefined), true);
    assert.equal(isSweepTask({ id: 'S', title: 'Small fix' }, touch('S', ...Array.from({ length: 11 }, (_, i) => `f${i}.ts`))), true);
    assert.equal(isSweepTask({ id: 'S', title: 'Small fix' }, touch('S', 'a.ts')), false);
  });

  it('a sweep conflicts with any task touching the same file', () => {
    const pair = scorePair(
      { id: 'HOK-1', title: 'Migrate all users in `user-schema.ts`' },
      { id: 'HOK-2', title: 'Add field' },
      touch('HOK-1', 'src/user-schema.ts'),
      touch('HOK-2', 'src/user-schema.ts', 'src/api.ts'),
      NO_HOT,
    );
    assert.deepEqual(pair.signals, ['file_overlap', 'sweep']);
    assert.equal(pair.score, 1);
  });

  it('a sweep without overlap does not fire', () => {
    const pair = scorePair({ id: 'HOK-1', title: 'Migrate all users' }, { id: 'HOK-2' }, touch('HOK-1', 'a.ts'), touch('HOK-2', 'b.ts'));
    assert.equal(pair.score, 0);
  });
});

describe('explicit dependencies', () => {
  it('Linear links score 1', () => {
    const pair = scorePair({ id: 'HOK-1', blocks: ['HOK-2'] }, { id: 'HOK-2' }, undefined, undefined);
    assert.deepEqual(pair.signals, ['explicit_dependency']);
    assert.equal(pair.score, 1);
    assert.equal(scorePair({ id: 'HOK-1' }, { id: 'HOK-2', dependsOn: ['HOK-1'] }, undefined, undefined).score, 1);
  });
});

describe('co-change history', () => {
  const commits = [
    ['a.ts', 'b.ts'],
    ['a.ts', 'b.ts'],
    ['a.ts', 'b.ts', 'c.ts'],
    ['a.ts'],
    ['c.ts'],
    ['tests/run-unit-tests.sh', 'a.ts', 'c.ts'],
  ];

  it('builds strength = shared / min(commits) above a support floor', () => {
    const index = buildCoChangeIndex(commits, { minSupport: 3, minHotCommits: 3, hotFileCount: 1 });
    assert.equal(index.strength.get('a.ts\u0000b.ts'), 1);
    assert.equal(index.strength.has('a.ts\u0000c.ts'), false); // only 2 shared commits
    assert.deepEqual([...index.hotFiles], ['a.ts']);
  });

  it('skips oversized commits for pair counts', () => {
    const index = buildCoChangeIndex([['a.ts', 'b.ts', 'c.ts']], { maxFilesPerCommit: 2, minSupport: 1 });
    assert.equal(index.strength.size, 0);
  });

  it('adds a co_change signal when files never overlap but co-change', () => {
    const coChange: CoChangeIndex = { strength: new Map([['a.ts\u0000b.ts', 0.8]]), hotFiles: new Set() };
    const pair = scorePair({ id: 'HOK-1' }, { id: 'HOK-2' }, touch('HOK-1', 'a.ts'), touch('HOK-2', 'b.ts'), { coChange });
    assert.deepEqual(pair.signals, ['co_change']);
    assert.equal(pair.score, 0.2);
    assert.deepEqual(pair.coChangedFiles, ['a.ts', 'b.ts']);
  });

  it('ignores weak co-change', () => {
    const coChange: CoChangeIndex = { strength: new Map([['a.ts\u0000b.ts', CO_CHANGE_MIN_STRENGTH - 0.1]]), hotFiles: new Set() };
    assert.equal(scorePair({ id: 'HOK-1' }, { id: 'HOK-2' }, touch('HOK-1', 'a.ts'), touch('HOK-2', 'b.ts'), { coChange }).score, 0);
  });

  it('parses git log --name-only output', () => {
    assert.deepEqual(parseGitLogNameOnly('\u0000\n\na.ts\nb.ts\n\u0000\n\nc.ts\n'), [['a.ts', 'b.ts'], ['c.ts']]);
  });
});

describe('scorePairConflicts', () => {
  it('returns only non-zero pairs sorted by score', () => {
    const tasks = [{ id: 'HOK-1' }, { id: 'HOK-2' }, { id: 'HOK-3' }, { id: 'HOK-4' }];
    const sets = [
      touch('HOK-1', 'a.ts', 'b.ts'),
      touch('HOK-2', 'a.ts', 'c.ts'),
      touch('HOK-3', 'a.ts', 'b.ts'),
      touch('HOK-4', 'z.ts'),
    ];
    const scores = scorePairConflicts(tasks, sets, NO_HOT);
    assert.deepEqual(
      scores.map((pair) => [pair.taskA, pair.taskB, pair.score]),
      [['HOK-1', 'HOK-3', 1], ['HOK-1', 'HOK-2', 0.5], ['HOK-2', 'HOK-3', 0.5]],
    );
  });

  it('handles empty and single-task backlogs', () => {
    assert.deepEqual(scorePairConflicts([], []), []);
    assert.deepEqual(scorePairConflicts([{ id: 'HOK-1' }], [touch('HOK-1', 'a.ts')]), []);
  });
});
