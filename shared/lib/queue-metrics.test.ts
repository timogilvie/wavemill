import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveQueueMetrics,
  deriveQueueMetricsForPr,
  QUEUE_METRICS_VERSION,
  type QueueLifecycleEvent,
  type QueueMetricsResult,
} from './queue-metrics.ts';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(THIS_DIR, 'fixtures', 'queue-metrics');

function loadFixtureEvents(name: string): QueueLifecycleEvent[] {
  const content = readFileSync(join(FIXTURES_DIR, `${name}.jsonl`), 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim());
  // Pure-function fixtures bypass `readQueueEvents` dedup; the
  // duplicate-replay scenario uses the I/O wrapper so that dedup is
  // exercised end to end.
  return lines.map((l) => JSON.parse(l) as QueueLifecycleEvent);
}

function loadExpected(name: string): QueueMetricsResult {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.expected.json`), 'utf-8'));
}

interface Scenario {
  readonly name: string;
  readonly description: string;
}

const PURE_SCENARIOS: readonly Scenario[] = [
  { name: 'clean-single-pass', description: 'enqueued → candidate → check → merged yields one pass of every metric' },
  { name: 'rebase-and-rerun', description: 'rebase + rerun within one attempt still counts as one attempt and sums reruns' },
  { name: 'one-ejection-then-merge', description: 'ejected then re-enqueued yields a repair cycle and two attempts' },
  { name: 'abandoned-then-merge', description: 'abandoned (not ejected) still opens a repair cycle (union semantics)' },
  { name: 'multiple-reruns', description: 'reruns within one attempt window are counted individually' },
  { name: 'never-merged', description: 'open attempt yields unknown timeToLand and unknown ciRun seconds' },
  { name: 'empty-log', description: 'empty log makes every metric unknown, never 0 (HOK-2895 regression)' },
];

for (const scenario of PURE_SCENARIOS) {
  // protects: the pure derivation agrees with the hand-authored expected
  // result for each boundary scenario (clean / rebase+rerun / ejection /
  // abandon / multi-rerun / never-merged / empty-log).
  test(`queue-metrics: ${scenario.name} — ${scenario.description}`, () => {
    const events = loadFixtureEvents(scenario.name);
    const expected = loadExpected(scenario.name);
    const actual = deriveQueueMetrics(events);
    assert.deepStrictEqual(actual, expected);
  });
}

// protects: result is stamped with the version constant so a schema
// consumer can gate on it (`queue-metrics/v1`).
test('queue-metrics: result carries QUEUE_METRICS_VERSION', () => {
  const result = deriveQueueMetrics([]);
  assert.strictEqual(result.version, 'queue-metrics/v1');
  assert.strictEqual(result.version, QUEUE_METRICS_VERSION);
});

// protects: deriveQueueMetricsForPr composes readQueueEvents dedup with
// the pure derivation — a replayed stream (every line duplicated) still
// yields the clean-single-pass result.
test('queue-metrics: deriveQueueMetricsForPr deduplicates replayed events', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'queue-metrics-'));
  try {
    const prNumber = 100;
    const stateDir = join(tmp, '.wavemill', 'merge-lane', String(prNumber));
    mkdirSync(stateDir, { recursive: true });
    copyFileSync(
      join(FIXTURES_DIR, 'duplicate-replay.jsonl'),
      join(stateDir, '.queue-events.jsonl'),
    );
    const result = await deriveQueueMetricsForPr(prNumber, tmp);
    const expected = loadExpected('clean-single-pass');
    assert.deepStrictEqual(result, expected);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// protects: deriveQueueMetricsForPr returns the empty-log result when no
// log exists at all (not just when the file is empty).
test('queue-metrics: deriveQueueMetricsForPr with missing log yields empty-log result', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'queue-metrics-'));
  try {
    const result = await deriveQueueMetricsForPr(999, tmp);
    const expected = loadExpected('empty-log');
    assert.deepStrictEqual(result, expected);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// protects: out-of-order timestamps are sorted; the derivation yields the
// same result regardless of how the file was appended to.
test('queue-metrics: reorders events by timestamp before deriving', () => {
  const inOrder = loadFixtureEvents('clean-single-pass');
  const shuffled = [inOrder[3], inOrder[0], inOrder[2], inOrder[1]];
  const expected = loadExpected('clean-single-pass');
  const actual = deriveQueueMetrics(shuffled);
  assert.deepStrictEqual(actual, expected);
});

// protects: a check_run_completed that predates its candidate_prepared
// (clock skew across hosts) does not produce a negative duration. The
// sorter places the check first, so it is not paired with the later
// attempt, and that attempt ends up with checkRunCount: 0 /
// seconds: 'unknown' — not a negative number.
test('queue-metrics: clock-skewed check does not produce negative duration', () => {
  const unordered: QueueLifecycleEvent[] = [
    {
      eventId: 'y-cp',
      eventType: 'candidate_prepared',
      timestamp: '2026-01-10T00:10:00.000Z',
      prNumber: 7,
      headSha: 'zzz',
    },
    {
      eventId: 'y-chk',
      eventType: 'check_run_completed',
      timestamp: '2026-01-10T00:09:00.000Z',
      prNumber: 7,
      headSha: 'zzz',
    },
  ];
  const result = deriveQueueMetrics(unordered);
  assert.strictEqual(result.ciRun.attempts.length, 1);
  assert.strictEqual(result.ciRun.attempts[0].checkRunCount, 0);
  assert.strictEqual(result.ciRun.attempts[0].seconds, 'unknown');
});

// protects: optional ci-check-duration join sums overlap into
// ciComputeMinutes; absence of the option leaves it 'unknown'.
test('queue-metrics: ciComputeMinutes join sums overlapping check durations', () => {
  const events = loadFixtureEvents('clean-single-pass');
  const withJoin = deriveQueueMetrics(events, {
    ciCheckDurations: [
      {
        name: 'test',
        startedAt: '2026-01-01T00:05:30.000Z',
        completedAt: '2026-01-01T00:08:30.000Z',
        durationSeconds: 180,
      },
      {
        // Entirely outside the attempt window: should contribute 0.
        name: 'unrelated',
        startedAt: '2026-01-01T01:00:00.000Z',
        completedAt: '2026-01-01T01:30:00.000Z',
        durationSeconds: 1800,
      },
    ],
  });
  // Window is 00:05:00 → 00:10:00; 'test' overlap is 3 minutes.
  assert.strictEqual(withJoin.ciComputeMinutes, 3);

  const withoutJoin = deriveQueueMetrics(events);
  assert.strictEqual(withoutJoin.ciComputeMinutes, 'unknown');
});

// protects: optional repair-cost join sums tokens/cost for entries
// overlapping any repair cycle; absence of the option leaves them
// 'unknown'. Non-overlapping entries contribute 0.
test('queue-metrics: repair-cost join sums overlapping entries', () => {
  const events = loadFixtureEvents('one-ejection-then-merge');
  // Repair cycle runs 00:04:00 → 00:09:00.
  const withJoin = deriveQueueMetrics(events, {
    repairCostEntries: [
      {
        sessionRef: 's-1',
        kind: 'ready-remediation',
        startedAt: '2026-01-03T00:05:00.000Z',
        endedAt: '2026-01-03T00:08:00.000Z',
        costUsd: 1.5,
        tokens: 1000,
      },
      {
        // outside the cycle
        sessionRef: 's-2',
        kind: 'coding',
        startedAt: '2026-01-03T00:20:00.000Z',
        endedAt: '2026-01-03T00:25:00.000Z',
        costUsd: 2.0,
        tokens: 2000,
      },
    ],
  });
  assert.strictEqual(withJoin.repairTokens, 1000);
  assert.strictEqual(withJoin.repairCostUsd, 1.5);

  const withoutJoin = deriveQueueMetrics(events);
  assert.strictEqual(withoutJoin.repairTokens, 'unknown');
  assert.strictEqual(withoutJoin.repairCostUsd, 'unknown');
});

// protects: a populated log with no ejections reports ejections:0, not
// 'unknown' — the explicit missing-vs-zero rule, counter-regression for
// HOK-2895's inverse (reporting 0 when the fact is unknown).
test('queue-metrics: populated log with no ejections reports ejections:0', () => {
  const events = loadFixtureEvents('clean-single-pass');
  const result = deriveQueueMetrics(events);
  assert.strictEqual(result.ejections, 0);
  assert.strictEqual(result.reruns, 0);
  // repair cycles empty but log is populated → totalSeconds is 0
  assert.strictEqual(result.repairLoop.totalSeconds, 0);
});
