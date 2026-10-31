import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { arrivalStats, computeQueueDepth, depthDistribution, ledgerIntervals, prCloseTimes } from './queue-depth.ts';
import { label, lane } from './cost-baseline.fixtures.ts';

const T0 = Date.parse('2026-10-20T00:00:00.000Z');
const s = (seconds: number) => T0 + seconds * 1000;
const iso = (seconds: number) => new Date(s(seconds)).toISOString();

// protects: time-weighting of depth (hand-computed: 50s at 0, 100s at 1, 50s at 2 over 200s)
test('depthDistribution time-weights overlapping intervals', () => {
  const d = depthDistribution([
    { prNumber: 1, start: s(0), end: s(100) },
    { prNumber: 2, start: s(50), end: s(150) },
  ], s(0), s(200));
  assert.ok(d);
  assert.deepEqual(d.secondsByDepth, [50, 100, 50]);
  assert.equal(d.shareDepthGt0, 0.75);
  assert.equal(d.shareDepthGt1, 0.25);
  assert.equal(d.shareDepthGt2, 0);
  assert.equal(d.maxDepth, 2);
  assert.ok(Math.abs(d.meanDepthWhenNonEmpty - 200 / 150) < 1e-12);
});

// protects: a hand-off at the same instant counted as two PRs queued
test('depthDistribution treats an exit and entry at one instant as a hand-off', () => {
  const d = depthDistribution([
    { prNumber: 1, start: s(0), end: s(100) },
    { prNumber: 2, start: s(100), end: s(200) },
  ], s(0), s(200));
  assert.equal(d?.maxDepth, 1);
});

// protects: an empty stream crashing or reporting depth
test('depthDistribution of an empty stream is all depth 0', () => {
  const d = depthDistribution([], s(0), s(60));
  assert.deepEqual(d?.secondsByDepth, [60]);
  assert.equal(d?.maxDepth, 0);
  assert.equal(depthDistribution([], s(60), s(0)), null);
});

// protects: labels persisting on merged/closed PRs inflating depth for weeks (the observed 66% >1-deep artefact)
test('ledgerIntervals clips at close time and drops PRs with an unknown close', () => {
  const events = [
    label(iso(0), 'wm:ready', 'labeled', 1),
    label(iso(10), 'wm:ready', 'labeled', 2),
    label(iso(20), 'wm:ready', 'labeled', 3),
    label(iso(30), 'wm:ready', 'labeled', 4),
    label(iso(40), 'wm:ready', 'unlabeled', 4),
    label(iso(41), 'wm:merging', 'labeled', 4),
    label(iso(50), 'wm:merging', 'unlabeled', 4),
  ];
  const close = new Map([[1, s(100)], [2, Infinity]]);
  const { queued, waiting, unterminated } = ledgerIntervals(events, s(1000), close);
  const byPr = (list: typeof queued) => Object.fromEntries(list.map((i) => [i.prNumber, [(i.start - T0) / 1000, (i.end - T0) / 1000]]));
  assert.deepEqual(byPr(queued), { 1: [0, 100], 2: [10, 1000], 4: [30, 50] });
  assert.deepEqual(byPr(waiting), { 1: [0, 100], 2: [10, 1000], 4: [30, 40] });
  assert.deepEqual(unterminated, [3]);
});

// protects: close-time sources ignored (GitHub open PR, merged lane, wm:merged write)
test('prCloseTimes takes the earliest known close and marks open PRs as Infinity', () => {
  const close = prCloseTimes(
    [label(iso(300), 'wm:merged', 'labeled', 7)],
    [lane({ prNumber: 7, lastEvent: 'merged', lastProgressAt: iso(200) }), lane({ prNumber: 8, lastEvent: 'ci-restart', lastProgressAt: iso(5) })],
    new Map([
      [9, { prNumber: 9, state: 'OPEN' as const, mergedAt: null, closedAt: null }],
      [10, { prNumber: 10, state: 'CLOSED' as const, mergedAt: null, closedAt: iso(400) }],
    ]),
  );
  assert.equal(close.get(7), s(200));
  assert.equal(close.has(8), false);
  assert.equal(close.get(9), Infinity);
  assert.equal(close.get(10), s(400));
});

// protects: reconciler wm:ready flapping counted as new arrivals (observed 639 → 54)
test('arrivalStats counts one arrival per PR and how many were ahead', () => {
  const stats = arrivalStats([
    { prNumber: 1, start: s(0), end: s(3600) },
    { prNumber: 1, start: s(3700), end: s(3800) },
    { prNumber: 1, start: s(3900), end: s(4000) },
    { prNumber: 2, start: s(600), end: s(700) },
    { prNumber: 3, start: s(650), end: s(5000) },
  ], s(0), s(7200));
  assert.ok(stats);
  assert.equal(stats.arrivals, 3);
  // PR 2 finds PR 1 ahead; PR 3 finds PRs 1 and 2 ahead.
  assert.equal(stats.shareFoundAhead1, 2 / 3);
  assert.equal(stats.shareFoundAhead2, 1 / 3);
  assert.equal(stats.medianInterArrivalSeconds, 325);
  assert.equal(stats.peakArrivalsPerHour, 3);
  // Two hourly bins [3, 0]: mean 1.5, variance 2.25 → Fano 1.5.
  assert.equal(stats.hourlyFano, 1.5);
});

// protects: a window with no live ledger reading as "queue empty" and firing R1
test('computeQueueDepth reports no ledger coverage when the ledger stopped before the window', () => {
  const result = computeQueueDepth(
    [label('2026-10-13T00:00:00.000Z', 'wm:ready', 'labeled', 1), label('2026-10-13T00:01:00.000Z', 'wm:ready', 'unlabeled', 1)],
    [],
    { since: '2027-01-01T00:00:00.000Z', until: '2027-01-02T00:00:00.000Z' },
  );
  assert.equal(result.ledger.coverageFrom, null);
  assert.equal(result.ledger.queued, null);
  assert.equal(result.ledger.arrivals, null);
});

// protects: ledger coverage starting at the window start instead of the ledger's first row
test('computeQueueDepth starts ledger coverage at the first ledger row', () => {
  const result = computeQueueDepth(
    [label('2026-10-13T00:00:00.000Z', 'wm:ready', 'labeled', 1), label('2026-10-13T01:00:00.000Z', 'wm:ready', 'unlabeled', 1)],
    [lane({ prNumber: 5, enteredLaneAt: '2026-10-05T00:00:00.000Z', lastProgressAt: '2026-10-05T00:10:00.000Z' })],
    { since: '2026-10-01T00:00:00.000Z', until: '2026-10-14T00:00:00.000Z' },
  );
  assert.equal(result.ledger.coverageFrom, '2026-10-13T00:00:00.000Z');
  assert.equal(result.ledger.queued?.secondsByDepth[1], 3600);
  assert.equal(result.lane?.secondsByDepth[1], 600);
  assert.deepEqual(result.ledger.unterminatedPrs, []);
});
