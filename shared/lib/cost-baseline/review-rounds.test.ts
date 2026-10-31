import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { computeReviewLoop, countLaunches, findingFile, orderedLaunches } from './review-rounds.ts';
import { session } from './cost-baseline.fixtures.ts';

const REVIEW_1 = 'launch review@aaaaaaa#1793000100 at 2026-10-20T09:00:00.000Z';
const REVIEW_2 = 'launch review@bbbbbbb#1793007300 at 2026-10-20T11:00:00.000Z';

// protects: HOK-2969 iterations ignored in favour of a coarser source, or findings mis-attributed
test('computeReviewLoop prefers reviewIterations and attributes findings at file level', () => {
  const metrics = computeReviewLoop({
    sessions: [session({ kind: 'helper:json-code-review' })],
    review: {
      iterations: 1,
      reviewIterations: [
        {
          iteration: 1,
          recordedAt: '2026-10-20T09:10:00.000Z',
          verdict: 'not_ready',
          findings: [
            { location: 'shared/lib/a.ts:12', severity: 'blocker' },
            { location: 'tools/b.ts:3-5', severity: 'warning' },
            { location: 'module.foo()', severity: 'warning' },
          ],
          filesChanged: ['shared/lib/a.ts'],
        },
        { iteration: 2, recordedAt: null, verdict: 'not_ready', findings: [{ location: './shared/lib/a.ts:40', severity: 'blocker' }], filesChanged: ['shared/lib/a.ts'] },
        { iteration: 3, recordedAt: null, verdict: 'ready', findings: [{ location: 'tools/b.ts:9', severity: 'warning' }], filesChanged: null },
      ],
    },
  });
  assert.equal(metrics.rounds, 3);
  assert.equal(metrics.roundsSource, 'review-iterations');
  assert.deepEqual(metrics.findings, { total: 5, onChangedFiles: 2, onUnchangedFiles: 1, unresolvable: 2 });
});

// protects: the fallback order when reviewIterations is absent (pre-HOK-2969 archives)
test('computeReviewLoop falls back to helper sessions, then artifact iterations, then launches', () => {
  const helpers = [session({ kind: 'helper:json-code-review' }), session({ kind: 'helper:json-code-review' })];
  const archived = { iterations: 4, reviewIterations: null };
  assert.deepEqual(
    [computeReviewLoop({ sessions: helpers, review: archived }).rounds, computeReviewLoop({ sessions: helpers, review: archived }).roundsSource],
    [2, 'review-helper-sessions'],
  );
  const viaArtifact = computeReviewLoop({ sessions: [], review: archived });
  assert.deepEqual([viaArtifact.rounds, viaArtifact.roundsSource], [4, 'artifact-iterations']);
  const viaLaunches = computeReviewLoop({
    sessions: [session({ kind: 'review', launchEvidence: REVIEW_1 }), session({ kind: 'review', launchEvidence: REVIEW_2 })],
    review: null,
  });
  assert.deepEqual([viaLaunches.rounds, viaLaunches.roundsSource, viaLaunches.reviewLaunches], [2, 'review-launches', 2]);
  const legacy = computeReviewLoop({ sessions: [session({ kind: 'review' }), session({ kind: 'review' })], review: null });
  assert.deepEqual([legacy.rounds, legacy.roundsSource, legacy.reviewLaunches], [null, 'none', null]);
  const none = computeReviewLoop({ sessions: [], review: null });
  assert.deepEqual([none.rounds, none.roundsSource, none.findings], [null, 'none', null]);
});

// protects: two sessions of one coding launch (e.g. Codex threads) read as a recode round
test('recodeRounds counts coding launches, not coding sessions', () => {
  const a = 'launch coding@aaaaaaa#1793000000 at x';
  const b = 'launch coding@bbbbbbb#1793005000 at y';
  assert.equal(computeReviewLoop({ sessions: [session({ launchEvidence: a }), session({ launchEvidence: a }), session({ launchEvidence: null })], review: null }).recodeRounds, 0);
  assert.equal(computeReviewLoop({ sessions: [session({ launchEvidence: a }), session({ launchEvidence: b })], review: null }).recodeRounds, 1);
  // Sessions with no launch evidence cannot be counted — null, not zero.
  assert.equal(computeReviewLoop({ sessions: [session({ launchEvidence: null }), session({ launchEvidence: null })], review: null }).recodeRounds, null);
  // A legacy task whose sessions are all unattributed has unknown launches, not zero.
  const legacy = computeReviewLoop({ sessions: [session({ kind: 'unattributed' })], review: null });
  assert.deepEqual([legacy.recodeRounds, legacy.reviewLaunches], [null, null]);
  // On a launch-record task, a stage with no sessions really had zero launches.
  assert.equal(computeReviewLoop({ sessions: [session({ launchEvidence: a })], review: null }).reviewLaunches, 0);
});

// protects: launch ordering by string instead of launch epoch (the first launch is authoring)
test('orderedLaunches orders by launch epoch and countLaunches distinguishes zero from unknown', () => {
  const late = 'launch coding@zzzzzzz#1793009999 at late';
  const early = 'launch coding@aaaaaaa#1793000001 at early';
  assert.deepEqual(orderedLaunches([session({ launchEvidence: late }), session({ launchEvidence: early })], 'coding'), [early, late]);
  assert.equal(countLaunches([], 'review'), 0);
  assert.equal(countLaunches([session({ kind: 'review', launchEvidence: null })], 'review'), null);
});

// protects: symbol or prose locations treated as files (false "pre-existing" findings)
test('findingFile extracts file paths and rejects non-file locations', () => {
  assert.equal(findingFile('shared/lib/a.ts:12'), 'shared/lib/a.ts');
  assert.equal(findingFile('./tools/b.sh:3-5'), 'tools/b.sh');
  assert.equal(findingFile('README.md (Section 4)'), 'README.md');
  assert.equal(findingFile('module.foo()'), null);
  assert.equal(findingFile('general architecture'), null);
});
