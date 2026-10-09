/**
 * HOK-3177 — unit tests for reliability-metrics.
 *
 * All IO happens under `mkdtemp` per HOK-3157; no tracked files are written.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  aggregateReliability,
  collectOperatorTouches,
  computeTimeStuck,
  dedupeTouches,
  deriveStallIntervals,
  parseWindow,
  percentile,
  renderReliabilityDashboardLine,
  renderReliabilitySummary,
  sumStallMs,
  type MergedTaskRef,
  type TaskReliability,
  type TouchEvent,
} from './reliability-metrics.ts';
import type { TaskProgressInputs } from './task-progress.ts';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'wm-reliability-'));
}

function writeFixture(path: string, lines: unknown[]): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

describe('reliability-metrics', () => {
  describe('percentile', () => {
    it('returns null for empty input', () => {
      assert.equal(percentile([], 50), null);
      assert.equal(percentile([], 90), null);
    });

    it('returns the single value for one-element input', () => {
      assert.equal(percentile([42], 50), 42);
      assert.equal(percentile([42], 99), 42);
    });

    it('computes p50 and p90 by linear interpolation', () => {
      const series = [10, 20, 30, 40, 50]; // 5 values
      assert.equal(percentile(series, 50), 30);
      assert.equal(percentile(series, 0), 10);
      assert.equal(percentile(series, 100), 50);
    });

    it('p90 on 10 values returns the 90th-percentile linear interp', () => {
      const series = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      // rank = 0.9 * 9 = 8.1 → interp between 9 and 10 → 9.1
      assert.equal(percentile(series, 90), 9.1);
    });
  });

  describe('parseWindow', () => {
    it('parses 14d, 7d, 48h windows', () => {
      const now = new Date('2026-10-08T12:00:00Z');
      const w14 = parseWindow('14d', now);
      assert.equal(w14.until, '2026-10-08T12:00:00.000Z');
      assert.equal(w14.since, '2026-09-24T12:00:00.000Z');
      const w48h = parseWindow('48h', now);
      assert.equal(w48h.since, '2026-10-06T12:00:00.000Z');
    });

    it('rejects unknown spec', () => {
      assert.throws(() => parseWindow('whenever'));
      assert.throws(() => parseWindow('14x'));
    });
  });

  describe('dedupeTouches', () => {
    it('collapses two near-coincident touches of the same kind to one', () => {
      const touches: TouchEvent[] = [
        { kind: 'operator-event', at: '2026-10-08T10:00:05Z', bucket: '' },
        { kind: 'operator-event', at: '2026-10-08T10:00:35Z', bucket: '' },
      ];
      const result = dedupeTouches(touches);
      assert.equal(result.length, 1);
      assert.equal(result[0].at, '2026-10-08T10:00:05Z');
    });

    it('keeps touches of different kinds in the same minute', () => {
      const touches: TouchEvent[] = [
        { kind: 'operator-event', at: '2026-10-08T10:00:05Z', bucket: '' },
        { kind: 'eval-intervention', at: '2026-10-08T10:00:05Z', bucket: '' },
      ];
      const result = dedupeTouches(touches);
      assert.equal(result.length, 2);
    });

    it('keeps touches more than 60s apart', () => {
      const touches: TouchEvent[] = [
        { kind: 'operator-event', at: '2026-10-08T10:00:05Z', bucket: '' },
        { kind: 'operator-event', at: '2026-10-08T10:01:30Z', bucket: '' },
      ];
      const result = dedupeTouches(touches);
      assert.equal(result.length, 2);
    });
  });

  describe('deriveStallIntervals', () => {
    function stalledInputs(nowMs: number, agentWorkingAt: number | null): TaskProgressInputs {
      return {
        issue: 'HOK-TEST',
        hookFile: agentWorkingAt
          ? {
              top: { state: 'working', event: 'PreToolUse', agent: 'claude', timestamp: Math.floor(agentWorkingAt / 1000) },
              writer: 'agent',
              agentRecord: { state: 'working', event: 'PreToolUse', agent: 'claude', timestamp: Math.floor(agentWorkingAt / 1000) },
              topTimestamp: Math.floor(agentWorkingAt / 1000),
            }
          : null,
        terminalHistoryIdleAt: null,
        latestCommitAt: null,
        launchAt: null,
        worktreeMtimeAt: null,
        statusFileMtimeAt: null,
        transitionSources: [],
        terminal: { prState: null, prNumber: null, lifecycleOutcome: null, at: null },
        agentProcessLive: null,
        backgroundWork: null,
        blockingPrompt: null,
      };
    }

    it('derives one interval across stalled frames', () => {
      const base = new Date('2026-10-08T10:00:00Z').getTime();
      const minute = 60_000;
      // frame 1: fresh work; frame 2 (30 min later): no new work → stalled;
      // frame 3 (50 min later): still stalled; frame 4: fresh work → resolved.
      const snapshots = [
        { atMs: base + 0, inputs: stalledInputs(base, base) },
        { atMs: base + 35 * minute, inputs: stalledInputs(base + 35 * minute, base) },
        { atMs: base + 50 * minute, inputs: stalledInputs(base + 50 * minute, base) },
        { atMs: base + 60 * minute, inputs: stalledInputs(base + 60 * minute, base + 60 * minute) },
      ];
      const intervals = deriveStallIntervals(snapshots, { stallMinutes: 30 });
      assert.equal(intervals.length, 1);
      assert.equal(intervals[0].from, new Date(base + 35 * minute).toISOString());
      assert.equal(intervals[0].to, new Date(base + 60 * minute).toISOString());
      assert.equal(intervals[0].durationMs, 25 * minute);
    });

    it('closes an open interval at the last snapshot if still stalled', () => {
      const base = new Date('2026-10-08T10:00:00Z').getTime();
      const minute = 60_000;
      // Need at least two frames with stalled=true to measure duration;
      // one frame alone has 0 observed duration and emits nothing.
      const snapshots = [
        { atMs: base + 0, inputs: stalledInputs(base, base) },
        { atMs: base + 40 * minute, inputs: stalledInputs(base + 40 * minute, base) },
        { atMs: base + 50 * minute, inputs: stalledInputs(base + 50 * minute, base) },
      ];
      const intervals = deriveStallIntervals(snapshots, { stallMinutes: 30 });
      assert.equal(intervals.length, 1);
      assert.equal(intervals[0].durationMs, 10 * minute);
    });

    it('sumStallMs sums intervals', () => {
      const total = sumStallMs([
        { from: 'a', to: 'b', durationMs: 20 * 60_000 },
        { from: 'c', to: 'd', durationMs: 10 * 60_000 },
      ]);
      assert.equal(total, 30 * 60_000);
    });
  });

  describe('aggregateReliability', () => {
    function fakeTask(opts: {
      issue: string;
      mergedAt: string;
      touchCount: number;
      stuckMs: number;
      coverage?: 'full' | 'partial' | 'none';
    }): TaskReliability {
      const task: MergedTaskRef = {
        issue: opts.issue,
        title: `[${opts.issue}] fake task`,
        mergedAt: opts.mergedAt,
      };
      const touches: TouchEvent[] = [];
      for (let i = 0; i < opts.touchCount; i++) {
        touches.push({ kind: 'operator-event', at: opts.mergedAt, bucket: `${i}` });
      }
      return {
        task,
        touches,
        touchCount: opts.touchCount,
        stuckMs: opts.stuckMs,
        stuckCoverage: opts.coverage ?? 'full',
        stallIntervals: [],
      };
    }

    it('3 merged tasks (0/1/1) → 33% unattended', () => {
      const since = '2026-10-01T00:00:00Z';
      const until = '2026-10-08T00:00:00Z';
      const tasks = [
        fakeTask({ issue: 'HOK-1', mergedAt: '2026-10-05T00:00:00Z', touchCount: 0, stuckMs: 0 }),
        fakeTask({ issue: 'HOK-2', mergedAt: '2026-10-05T00:00:00Z', touchCount: 1, stuckMs: 20 * 60_000 }),
        fakeTask({ issue: 'HOK-3', mergedAt: '2026-10-05T00:00:00Z', touchCount: 1, stuckMs: 10 * 60_000 }),
      ];
      const summary = aggregateReliability(tasks, { sinceIso: since, untilIso: until, bucket: 'rolling7d' });
      assert.equal(summary.overall.merged, 3);
      assert.equal(summary.overall.unattended, 1);
      assert.ok(summary.overall.unattendedRate !== null);
      assert.ok(summary.overall.unattendedRate! > 0.33 && summary.overall.unattendedRate! < 0.34);
      // p50 of [0, 10m, 20m] = 10m
      assert.equal(summary.overall.stuckP50Ms, 10 * 60_000);
    });

    it('zero merged tasks → rate is null, no NaN', () => {
      const summary = aggregateReliability([], {
        sinceIso: '2026-10-01T00:00:00Z',
        untilIso: '2026-10-08T00:00:00Z',
        bucket: 'rolling7d',
      });
      assert.equal(summary.overall.merged, 0);
      assert.equal(summary.overall.unattended, 0);
      assert.equal(summary.overall.unattendedRate, null);
      assert.equal(summary.overall.stuckP50Ms, null);
      assert.equal(summary.overall.stuckP90Ms, null);
    });

    it('coverage=none tasks are excluded from the stuck series', () => {
      const since = '2026-10-01T00:00:00Z';
      const until = '2026-10-08T00:00:00Z';
      const tasks = [
        fakeTask({ issue: 'HOK-1', mergedAt: '2026-10-05T00:00:00Z', touchCount: 0, stuckMs: 0, coverage: 'none' }),
        fakeTask({ issue: 'HOK-2', mergedAt: '2026-10-05T00:00:00Z', touchCount: 0, stuckMs: 10 * 60_000, coverage: 'full' }),
      ];
      const summary = aggregateReliability(tasks, { sinceIso: since, untilIso: until, bucket: 'rolling7d' });
      assert.equal(summary.overall.coverage.none, 1);
      assert.equal(summary.overall.coverage.full, 1);
      assert.equal(summary.overall.stuckP50Ms, 10 * 60_000);
    });

    it('daily buckets segment tasks by merged-day', () => {
      const since = '2026-10-01T00:00:00Z';
      const until = '2026-10-04T00:00:00Z';
      const tasks = [
        fakeTask({ issue: 'HOK-A', mergedAt: '2026-10-01T12:00:00Z', touchCount: 0, stuckMs: 0 }),
        fakeTask({ issue: 'HOK-B', mergedAt: '2026-10-02T12:00:00Z', touchCount: 1, stuckMs: 0 }),
        fakeTask({ issue: 'HOK-C', mergedAt: '2026-10-03T12:00:00Z', touchCount: 1, stuckMs: 0 }),
      ];
      const summary = aggregateReliability(tasks, { sinceIso: since, untilIso: until, bucket: 'daily' });
      assert.equal(summary.buckets.length, 3);
      assert.equal(summary.buckets[0].merged, 1);
      assert.equal(summary.buckets[0].unattendedRate, 1);
      assert.equal(summary.buckets[1].merged, 1);
      assert.equal(summary.buckets[1].unattendedRate, 0);
    });
  });

  describe('rendering', () => {
    it('renders a plain-text summary without throwing on zero tasks', () => {
      const summary = aggregateReliability([], {
        sinceIso: '2026-10-01T00:00:00Z',
        untilIso: '2026-10-08T00:00:00Z',
        bucket: 'rolling7d',
      });
      const text = renderReliabilitySummary(summary);
      assert.match(text, /Merged tasks:\s+0/);
      assert.match(text, /Unattended rate:\s+N\/A/);
    });

    it('renderReliabilityDashboardLine is empty when no merged tasks', () => {
      const summary = aggregateReliability([], {
        sinceIso: '2026-10-01T00:00:00Z',
        untilIso: '2026-10-08T00:00:00Z',
        bucket: 'rolling7d',
      });
      assert.equal(renderReliabilityDashboardLine(summary), '');
    });
  });

  describe('collectOperatorTouches', () => {
    it('dedup: 1 operator-event + 1 eval-intervention within 60s → still 2 touches (different kinds)', () => {
      const tmp = makeTmpDir();
      try {
        const featureDir = join(tmp, 'features', 'test');
        mkdirSync(featureDir, { recursive: true });
        writeFixture(join(featureDir, '.operator-events.jsonl'), [
          { seq: 1, command: 're-review', issue: 'HOK-TEST', at: '2026-10-08T10:00:05Z' },
        ]);

        const evalsDir = join(tmp, '.wavemill', 'evals');
        mkdirSync(evalsDir, { recursive: true });
        writeFileSync(join(evalsDir, 'evals.jsonl'), JSON.stringify({
          issueId: 'HOK-TEST',
          timestamp: '2026-10-08T10:00:30Z',
          interventionCount: 1,
          interventions: [{ timestamp: '2026-10-08T10:00:30Z', type: 'review_comment' }],
        }) + '\n');

        const task: MergedTaskRef = {
          issue: 'HOK-TEST',
          title: '[HOK-TEST] fake',
          mergedAt: '2026-10-08T11:00:00Z',
          featureDir,
        };
        const touches = collectOperatorTouches({
          repoDir: tmp,
          task,
          evalsPath: join(evalsDir, 'evals.jsonl'),
        });
        // Different kinds, same minute → both kept
        assert.equal(touches.length, 2);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('dedup: two operator-event records in the same minute → 1 touch', () => {
      const tmp = makeTmpDir();
      try {
        const featureDir = join(tmp, 'features', 'test');
        mkdirSync(featureDir, { recursive: true });
        writeFixture(join(featureDir, '.operator-events.jsonl'), [
          { seq: 1, command: 're-review', issue: 'HOK-TEST', at: '2026-10-08T10:00:05Z' },
          { seq: 2, command: 'advance', issue: 'HOK-TEST', at: '2026-10-08T10:00:40Z' },
        ]);
        const task: MergedTaskRef = {
          issue: 'HOK-TEST',
          title: 'fake',
          mergedAt: '2026-10-08T11:00:00Z',
          featureDir,
        };
        const touches = collectOperatorTouches({
          repoDir: tmp,
          task,
          evalsPath: join(tmp, 'no-evals.jsonl'),
        });
        assert.equal(touches.length, 1);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('promotes writer=user hook archives to pane-message touches', () => {
      const tmp = makeTmpDir();
      try {
        const featureDir = join(tmp, 'features', 'test');
        mkdirSync(featureDir, { recursive: true });
        writeFixture(join(featureDir, '.terminal-history.jsonl'), [
          {
            archivedAt: '2026-10-08T09:30:00Z',
            payload: {
              state: 'working',
              event: 'UserPromptSubmit',
              writer: 'user',
              agent: 'claude',
              timestamp: Math.floor(Date.parse('2026-10-08T09:30:00Z') / 1000),
            },
          },
          {
            archivedAt: '2026-10-08T09:31:00Z',
            payload: {
              state: 'working',
              event: 'PreToolUse',
              writer: 'agent',
              agent: 'claude',
              timestamp: Math.floor(Date.parse('2026-10-08T09:31:00Z') / 1000),
            },
          },
        ]);
        const task: MergedTaskRef = {
          issue: 'HOK-TEST',
          title: 'fake',
          mergedAt: '2026-10-08T11:00:00Z',
          featureDir,
        };
        const touches = collectOperatorTouches({
          repoDir: tmp,
          task,
          evalsPath: join(tmp, 'no-evals.jsonl'),
        });
        assert.equal(touches.length, 1);
        assert.equal(touches[0].kind, 'pane-message');
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('computeTimeStuck', () => {
    it('reports coverage=none when no history and no live hook', () => {
      const tmp = makeTmpDir();
      try {
        const featureDir = join(tmp, 'features', 'test');
        mkdirSync(featureDir, { recursive: true });
        const task: MergedTaskRef = {
          issue: 'HOK-TEST',
          title: 'fake',
          mergedAt: '2026-10-08T11:00:00Z',
          featureDir,
        };
        const result = computeTimeStuck({ task });
        assert.equal(result.coverage, 'none');
        assert.equal(result.stuckMs, 0);
        assert.equal(result.stallIntervals.length, 0);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('replays hook history to find stall intervals', () => {
      const tmp = makeTmpDir();
      try {
        const featureDir = join(tmp, 'features', 'test');
        mkdirSync(featureDir, { recursive: true });
        const base = Math.floor(Date.parse('2026-10-08T10:00:00Z') / 1000);
        const min = 60;
        writeFixture(join(featureDir, '.terminal-history.jsonl'), [
          // Fresh agent work at t=0
          { payload: { state: 'working', event: 'PreToolUse', writer: 'agent', agent: 'claude', timestamp: base } },
          // 40 min later, still looks like t=0 to the derivation: stalled
          { payload: { state: 'working', event: 'PreToolUse', writer: 'agent', agent: 'claude', timestamp: base + 40 * min } },
        ]);
        const task: MergedTaskRef = {
          issue: 'HOK-TEST',
          title: 'fake',
          mergedAt: '2026-10-08T11:00:00Z',
          featureDir,
        };
        const result = computeTimeStuck({ task, stallMinutes: 30 });
        // With just 2 snapshots and both agent-working (fresh at each tick),
        // the pure derivation sees fresh hook each frame → neither is stalled.
        // coverage is still 'full' because we had 2+ snapshots.
        assert.equal(result.coverage, 'full');
        assert.equal(result.stuckMs, 0);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});
