/**
 * HOK-3177 / HOK-3182 — unit tests for reliability-metrics.
 *
 * All IO happens under `mkdtemp` per HOK-3157; no tracked files are written.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  aggregateReliability,
  attachStallGates,
  buildEvalsIndex,
  buildReliabilityContext,
  collectPromptCacheHitRates,
  collectOperatorTouches,
  computeOffHoursMs,
  computeReliability,
  computeTaskReliability,
  computeTimeStuck,
  computeWaitedForPerson,
  dedupeTouches,
  deriveStallIntervals,
  ENDED_BY_PERSON_AFTER_MS,
  ENDED_BY_PERSON_BEFORE_MS,
  isWorkingMoment,
  parseWindow,
  percentile,
  readExternalMergeTouches,
  readLabelEditTouches,
  readManualPushTouches,
  renderReliabilityDashboardLine,
  renderReliabilitySummary,
  replayStallIntervals,
  sumStallMs,
  type MergedTaskRef,
  type ProgressEvidence,
  type ReliabilityContext,
  type StallInterval,
  type TaskReliability,
  type TouchEvent,
} from './reliability-metrics.ts';
import { indexMillLabelWrites } from './label-write-ledger.ts';
import { encodeProjectDir } from './wavemill-session-paths.ts';
import type { PrTimelineEvent } from './pr-timeline.ts';
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
        transitionInputs: [],
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
      classes?: Array<'O' | 'L' | 'S' | 'R'>;
      isMillTask?: boolean;
    }): TaskReliability {
      const task: MergedTaskRef = {
        issue: opts.issue,
        title: `[${opts.issue}] fake task`,
        mergedAt: opts.mergedAt,
      };
      const touches: TouchEvent[] = [];
      const classes = opts.classes ?? [];
      for (let i = 0; i < opts.touchCount; i++) {
        touches.push({ kind: 'operator-event', at: opts.mergedAt, class: classes[i] ?? 'R', bucket: `${i}` });
      }
      const touchClasses = { O: 0, L: 0, S: 0, R: 0 };
      for (const t of touches) touchClasses[t.class] += 1;
      return {
        task,
        touches,
        touchCount: opts.touchCount,
        touchClasses,
        stuckMs: opts.stuckMs,
        stuckCoverage: opts.coverage ?? 'full',
        stallIntervals: [],
        isMillTask: opts.isMillTask ?? true,
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

    it('reports mill-only rates alongside the all-PR rates (HOK-3245)', () => {
      const tasks = [
        fakeTask({ issue: 'HOK-1', mergedAt: '2026-10-05T00:00:00Z', touchCount: 0, stuckMs: 0 }),
        fakeTask({ issue: 'HOK-2', mergedAt: '2026-10-05T00:00:00Z', touchCount: 1, stuckMs: 20 * 60_000 }),
        fakeTask({ issue: 'fix', mergedAt: '2026-10-05T00:00:00Z', touchCount: 1, stuckMs: 0, coverage: 'none', isMillTask: false }),
        fakeTask({ issue: 'docs', mergedAt: '2026-10-05T00:00:00Z', touchCount: 1, stuckMs: 0, coverage: 'none', isMillTask: false }),
      ];
      const summary = aggregateReliability(tasks, {
        sinceIso: '2026-10-01T00:00:00Z', untilIso: '2026-10-08T00:00:00Z', bucket: 'rolling7d',
      });
      for (const b of [summary.overall, summary.buckets[0]]) {
        assert.equal(b.merged, 4);
        assert.equal(b.unattendedRate, 0.25);
        assert.equal(b.millMerged, 2);
        assert.equal(b.millUnattended, 1);
        assert.equal(b.millUnattendedRate, 0.5);
        assert.equal(b.millStuckP50Ms, 10 * 60_000);
        assert.equal(b.millStuckP90Ms, 18 * 60_000);
      }

      const text = renderReliabilitySummary(summary);
      assert.match(text, /Merged tasks \(all PRs\):\s+4/);
      assert.match(text, /Mill tasks:\s+2 · unattended 50\.0% \(1\/2\)/);
      assert.match(text, /Rolling 7-day:\s+all 25\.0% · mill 50\.0%/);
      assert.match(renderReliabilityDashboardLine(summary), /^7d unattended: mill 50\.0% · all 25\.0% .*\(2\/4 merged\)$/);
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
      assert.match(text, /Merged tasks \(all PRs\):\s+0/);
      assert.match(text, /Mill tasks:\s+0 · unattended N\/A/);
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
        // The 5-minute replay sees no progress from t=0 until the t=40 record:
        // stalled from the first tick past 30 min (t=35) to t=40. The 20 min
        // before the merge stay under the threshold.
        assert.equal(result.coverage, 'full');
        assert.equal(result.stuckMs, 5 * 60_000);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('parseWindow absolute start (HOK-3182)', () => {
    it('accepts a date or ISO timestamp through now', () => {
      const now = new Date('2026-10-10T12:00:00Z');
      assert.deepEqual(parseWindow('2026-09-25', now), { since: '2026-09-25T00:00:00.000Z', until: now.toISOString() });
      assert.equal(parseWindow('2026-09-25T06:00:00Z', now).since, '2026-09-25T06:00:00.000Z');
      assert.throws(() => parseWindow('2026-11-01', now));
    });
  });

  describe('replayStallIntervals (HOK-3182)', () => {
    const base = Date.parse('2026-10-08T10:00:00Z');
    const minute = 60_000;
    const hook = (atMs: number, writer: 'agent' | 'monitor', state: 'working' | 'idle' = 'working'): ProgressEvidence => ({
      atMs,
      kind: 'hook',
      hook: { state, event: writer === 'agent' ? 'PreToolUse' : 'pr_opened', writer, agent: 'claude', timestamp: Math.floor(atMs / 1000) },
    });

    it('counts time past the threshold until the merge closes the interval', () => {
      const intervals = replayStallIntervals([hook(base, 'agent')], { endMs: base + 90 * minute, stallMinutes: 30 });
      assert.equal(intervals.length, 1);
      assert.equal(intervals[0].from, new Date(base + 35 * minute).toISOString());
      assert.equal(intervals[0].durationMs, 55 * minute);
    });

    it('a monitor write is never progress and never erases the agent record', () => {
      const intervals = replayStallIntervals(
        [hook(base, 'agent'), hook(base + 60 * minute, 'monitor')],
        { endMs: base + 90 * minute, stallMinutes: 30 },
      );
      assert.equal(sumStallMs(intervals), 55 * minute);
    });

    it('commits are progress (HOK-3422: stage transitions no longer suppress stall)', () => {
      // Commits are agent evidence and keep the stall clock advancing. Stage
      // transitions (controller writes) stopped suppressing stall under
      // HOK-3422: lastTransitionAt is derived, but stalled fires anyway.
      const evidenceAgentFresh: ProgressEvidence[] = [
        hook(base, 'agent'),
        { atMs: base + 25 * minute, kind: 'commit' },
        // An agent hook keeps the clock moving past the 30m threshold.
        hook(base + 40 * minute, 'agent'),
      ];
      assert.equal(
        sumStallMs(replayStallIntervals(evidenceAgentFresh, { endMs: base + 70 * minute, stallMinutes: 30 })),
        0,
      );
      // A stage transition alone no longer counts as progress (HOK-3422).
      const evidenceTransitionOnly: ProgressEvidence[] = [
        hook(base, 'agent'),
        { atMs: base + 25 * minute, kind: 'commit' },
        { atMs: base + 50 * minute, kind: 'transition', detail: 'review:started' },
      ];
      assert.ok(
        sumStallMs(replayStallIntervals(evidenceTransitionOnly, { endMs: base + 70 * minute, stallMinutes: 30 })) > 0,
        'a controller transition after the last agent evidence must not suppress stall',
      );
    });

    it('returns no intervals without evidence', () => {
      assert.deepEqual(replayStallIntervals([], { endMs: base }), []);
    });
  });

  describe('archive fallback (HOK-3182)', () => {
    function archivedTask(tmp: string): MergedTaskRef {
      const archiveDir = join(tmp, '.wavemill', 'evals', 'artifacts', 'HOK-ARC');
      mkdirSync(archiveDir, { recursive: true });
      return { issue: 'HOK-ARC', title: 'HOK-ARC: x (#9)', prNumber: '9', mergedAt: '2026-10-08T12:00:00Z', archiveDir };
    }

    it('reads operator events and hook history from the reap archive when the feature dir is gone', () => {
      const tmp = makeTmpDir();
      try {
        const task = archivedTask(tmp);
        writeFixture(join(task.archiveDir!, '.operator-events.jsonl'), [
          { seq: 1, command: 'advance', issue: 'HOK-ARC', at: '2026-10-08T10:30:00Z' },
          { seq: 2, command: 'challenge-void', issue: 'HOK-ARC', at: '2026-10-08T11:30:00Z' },
        ]);
        const base = Math.floor(Date.parse('2026-10-08T10:00:00Z') / 1000);
        writeFixture(join(task.archiveDir!, '.terminal-history.jsonl'), [
          { payload: { state: 'working', event: 'PreToolUse', writer: 'agent', agent: 'claude', timestamp: base } },
          { payload: { state: 'idle', event: 'Stop', writer: 'agent', agent: 'claude', timestamp: base + 600 } },
        ]);

        const touches = collectOperatorTouches({ repoDir: tmp, task, evalsPath: join(tmp, 'none.jsonl') });
        assert.deepEqual(touches.map((t) => [t.kind, t.class]), [['operator-event', 'R'], ['operator-event', 'O']]);

        const stuck = computeTimeStuck({ task, stallMinutes: 30 });
        assert.equal(stuck.coverage, 'full');
        // Last progress 10:00 → stalled from 10:35 (first tick past 30m) to the 12:00 merge.
        assert.equal(stuck.stuckMs, 85 * 60_000);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('counts a resolved dirty-tree handoff as one R touch at resolution', () => {
      const tmp = makeTmpDir();
      try {
        const task = archivedTask(tmp);
        writeFixture(join(task.archiveDir!, '.coding-uncommitted-output.resolved.jsonl'), [
          { reason: 'coding_output_dirty_tree', detectedAt: '2026-10-08T09:47:09Z', resolvedAt: '2026-10-08T09:53:58Z', dirtyPaths: ['a.ts'] },
        ]);
        const touches = collectOperatorTouches({ repoDir: tmp, task, evalsPath: join(tmp, 'none.jsonl') });
        assert.deepEqual(touches.map((t) => [t.kind, t.class, t.at]), [['operator-intervention', 'R', '2026-10-08T09:53:58.000Z']]);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('reconstructs a partial timeline from archived stage results', () => {
      const tmp = makeTmpDir();
      try {
        const task = archivedTask(tmp);
        writeFileSync(join(task.archiveDir!, '.coding-result.json'), JSON.stringify({
          stage: 'coding', status: 'completed', startedAt: '2026-10-08T09:00:00Z', finishedAt: '2026-10-08T09:20:00Z',
        }));
        writeFileSync(join(task.archiveDir!, '.review-result.json'), JSON.stringify({
          stage: 'review', status: 'completed', startedAt: '2026-10-08T11:00:00Z', finishedAt: '2026-10-08T11:50:00Z',
        }));
        const stuck = computeTimeStuck({ task, stallMinutes: 30 });
        assert.equal(stuck.coverage, 'partial');
        // HOK-3422: stage transitions are controller writes and no longer
        // reset the stall clock. For a task with no archived agent transcripts
        // the stall anchors to the first `coding:started` transition (09:00);
        // with no later agent evidence, stall opens at 09:35 (first tick past
        // 30m) and closes at the 12:00 merge terminal frame. The old rule
        // let `coding:finished` at 09:20 and `review:started` at 11:00 reset
        // the clock — the exact bug family HOK-3422 fixes.
        assert.equal(stuck.stuckMs, 145 * 60_000);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('time-stuck window (HOK-3182)', () => {
    it('ignores evidence before the first stage launch (expansion, queue wait)', () => {
      const tmp = makeTmpDir();
      try {
        const archiveDir = join(tmp, '.wavemill', 'evals', 'artifacts', 'HOK-Q');
        mkdirSync(join(archiveDir, 'native-sessions'), { recursive: true });
        // Expansion session two days before launch.
        writeFixture(join(archiveDir, 'native-sessions', 'expansion.jsonl'), [
          { timestamp: Date.parse('2026-10-06T10:00:00Z'), type: 'session_started' },
        ]);
        writeFileSync(join(archiveDir, '.coding-result.json'), JSON.stringify({
          stage: 'coding', status: 'completed', startedAt: '2026-10-08T10:00:00Z', finishedAt: '2026-10-08T10:20:00Z',
        }));
        const task: MergedTaskRef = { issue: 'HOK-Q', title: 'HOK-Q (#3)', prNumber: '3', mergedAt: '2026-10-08T10:30:00Z', archiveDir };
        const stuck = computeTimeStuck({ task, stallMinutes: 30 });
        assert.equal(stuck.coverage, 'partial');
        assert.equal(stuck.stuckMs, 0);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('eval and touch-log sources (HOK-3182)', () => {
    it('drops automation noise and agent-side detectors, matches rows by PR, and classifies the rest', () => {
      const tmp = makeTmpDir();
      try {
        const evalsPath = join(tmp, 'evals.jsonl');
        writeFixture(evalsPath, [{
          issueId: 'HOK-OTHER',
          prUrl: 'https://github.com/acme/widgets/pull/1603',
          timestamp: '2026-10-08T13:00:00Z',
          interventionCount: 5,
          interventions: [
            { timestamp: '2026-10-08T10:00:00Z', type: 'scope_change', note: '[session_redirect] <task-notification>\n<task-id>b1</task-id>' },
            { timestamp: '2026-10-08T10:01:00Z', type: 'scope_change', note: '[session_redirect] # Issue Writer - Task Packet Template' },
            { timestamp: '2026-10-08T10:02:00Z', type: 'scope_change', note: '[session_redirect] You are remediating a ready-check failure for open PR #1.' },
            { timestamp: '2026-10-08T10:03:00Z', type: 'scope_change', note: '[session_redirect] Your last response was cut off by an API error (the' },
            { timestamp: '2026-10-08T10:10:00Z', type: 'scope_change', note: '[session_redirect] please rebase onto main' },
            { timestamp: '2026-10-08T10:20:00Z', type: 'bugfix', note: '[prior_failed_attempt] coding attempt 1 failed' },
            { timestamp: '2026-10-08T10:30:00Z', type: 'bugfix', note: '[review_comment] tim: nit' },
            { timestamp: '2026-10-08T10:40:00Z', type: 'bugfix', note: '[operator_recovery] severity=major' },
          ],
        }]);
        const task: MergedTaskRef = { title: 'Merge pull request #1603 from acme/task/x', prNumber: '1603', mergedAt: '2026-10-08T13:00:00Z' };
        const touches = collectOperatorTouches({ repoDir: tmp, task, evalsPath });
        // Automation noise is still collected but marked automation; human touches
        // are the three genuine operator signals.
        const human = touches.filter((t) => t.attribution === 'human');
        assert.deepEqual(human.map((t) => [t.kind, t.class]), [
          ['session-redirect', 'L'],
          ['eval-intervention', 'S'],
          ['operator-intervention', 'R'],
        ]);
        assert.ok(touches.some((t) => t.attribution === 'automation' && t.kind === 'eval-intervention'));

      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('folds interactive state edits from the repo touch log into the task', () => {
      const tmp = makeTmpDir();
      try {
        writeFixture(join(tmp, '.wavemill', 'operator-touches.jsonl'), [
          { at: '2026-10-08T10:00:00Z', kind: 'state-edit', issue: 'HOK-LOG', actor: 'tim', detail: 'state_mutate workflow-state.json' },
          { at: '2026-10-08T10:00:00Z', kind: 'state-edit', issue: 'HOK-ELSE' },
        ]);
        const task: MergedTaskRef = { issue: 'HOK-LOG', title: 'HOK-LOG: x (#5)', prNumber: '5', mergedAt: '2026-10-08T13:00:00Z' };
        const touches = collectOperatorTouches({ repoDir: tmp, task, evalsPath: join(tmp, 'none.jsonl') });
        assert.deepEqual(touches.map((t) => [t.kind, t.class, t.actor]), [['state-edit', 'R', 'tim']]);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('indexes eval rows with interventions by issue and PR only', () => {
      const tmp = makeTmpDir();
      try {
        const evalsPath = join(tmp, 'evals.jsonl');
        writeFixture(evalsPath, [
          { issueId: 'HOK-1', prUrl: 'https://github.com/a/b/pull/11', interventionCount: 1 },
          { issueId: 'HOK-2', interventionCount: 0 },
        ]);
        const index = buildEvalsIndex(evalsPath);
        assert.equal(index.byIssue.has('HOK-1'), true);
        assert.equal(index.byPr.has('11'), true);
        assert.equal(index.byIssue.has('HOK-2'), false);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('GitHub timeline sources (HOK-3182)', () => {
    const task: MergedTaskRef = { issue: 'HOK-9', title: 'HOK-9: x (#77)', prNumber: '77', branch: 'task/x', mergedAt: '2026-10-08T16:22:51Z' };
    const timeline: PrTimelineEvent[] = [
      { event: 'labeled', at: '2026-10-08T09:00:00Z', actor: 'tim', label: 'wm:ready' },
      { event: 'labeled', at: '2026-10-08T15:17:53Z', actor: 'tim', label: 'wm:blocked' },
      { event: 'unlabeled', at: '2026-10-08T15:21:25Z', actor: 'tim', label: 'wm:blocked' },
      { event: 'labeled', at: '2026-10-08T15:21:28Z', actor: 'tim', label: 'wm:ready' },
      { event: 'labeled', at: '2026-10-08T15:30:00Z', actor: 'tim', label: 'wavemill' },
      { event: 'labeled', at: '2026-10-08T15:40:00Z', actor: 'github-actions[bot]', label: 'wm:superseded' },
      { event: 'merged', at: '2026-10-08T16:22:51Z', actor: 'tim' },
    ];
    const ledger = indexMillLabelWrites([
      { at: '2026-10-08T12:00:00Z', prNumber: 1, label: 'wm:ready', action: 'labeled', writer: 'mill' },
      { at: '2026-10-08T15:17:52Z', prNumber: 77, label: 'wm:blocked', action: 'labeled', writer: 'mill' },
    ]);

    it('shared login: counts only wm:* edits after the ledger start with no matching mill write', () => {
      const ctx: ReliabilityContext = { repoDir: '/nonexistent', labelWrites: ledger, millActorLogins: new Set() };
      const touches = readLabelEditTouches(task, timeline, ctx);
      assert.deepEqual(touches.map((t) => t.detail), ['unlabeled:wm:blocked', 'labeled:wm:ready']);
      assert.equal(touches[0].actor, 'tim');
    });

    it('dedicated mill login: any other human actor is a touch even without the ledger', () => {
      const ctx: ReliabilityContext = { repoDir: '/nonexistent', millActorLogins: new Set(['wavemill-bot']) };
      const mixed: PrTimelineEvent[] = [
        { event: 'labeled', at: '2026-10-08T09:00:00Z', actor: 'wavemill-bot', label: 'wm:ready' },
        { event: 'unlabeled', at: '2026-10-08T09:05:00Z', actor: 'tim', label: 'wm:blocked' },
      ];
      assert.deepEqual(readLabelEditTouches(task, mixed, ctx).map((t) => t.detail), ['unlabeled:wm:blocked']);
    });

    it('external merge: tend receipt clears it, a missing receipt is a touch, pre-lane merges are not judged', () => {
      const tmp = makeTmpDir();
      try {
        const ctx: ReliabilityContext = { repoDir: tmp, mergeLaneSinceMs: Date.parse('2026-10-01T00:00:00Z') };
        const touches = readExternalMergeTouches(task, timeline, ctx);
        assert.equal(touches.length, 1);
        assert.equal(touches[0].kind, 'external-merge');
        assert.equal(touches[0].at, '2026-10-08T16:22:51Z');

        writeFixture(join(tmp, '.wavemill', 'merge-lane', '77', 'progress.json'), [
          { prNumber: 77, enteredLaneAt: '2026-10-08T16:22:44Z', lastEvent: 'merged' },
        ]);
        assert.deepEqual(readExternalMergeTouches(task, timeline, ctx), []);

        const early = { ...task, prNumber: '78' };
        assert.deepEqual(readExternalMergeTouches(early, null, { repoDir: tmp, mergeLaneSinceMs: Date.parse('2026-10-09T00:00:00Z') }), []);
        assert.deepEqual(readExternalMergeTouches({ ...early, merged: false }, null, ctx), []);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('manual push: commits outside the recorded agent windows are touches', () => {
      const tmp = makeTmpDir();
      try {
        const archiveDir = join(tmp, '.wavemill', 'evals', 'artifacts', 'HOK-9');
        mkdirSync(archiveDir, { recursive: true });
        writeFileSync(join(archiveDir, '.coding-result.json'), JSON.stringify({
          stage: 'coding', status: 'completed', startedAt: '2026-10-08T10:00:00Z', finishedAt: '2026-10-08T11:00:00Z',
        }));
        const commits: PrTimelineEvent[] = [
          { event: 'committed', at: '2026-10-08T10:30:00Z', sha: 'aaaaaaa1', message: 'feat: agent work', author: 'tim' },
          { event: 'committed', at: '2026-10-08T14:53:26Z', sha: 'bbbbbbb2', message: 'Operator review + fixes', author: 'tim' },
        ];
        const touches = readManualPushTouches({ ...task, archiveDir }, commits, { repoDir: tmp });
        assert.equal(touches.length, 1);
        assert.equal(touches[0].kind, 'manual-push');
        assert.match(touches[0].detail!, /^bbbbbbb: Operator review/);
        assert.equal(touches[0].at, '2026-10-08T14:53:26Z');
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('per-class aggregation and rendering (HOK-3182)', () => {
    it('sums class counts and touched tasks per class', () => {
      const mk = (issue: string, classes: Array<'O' | 'L' | 'S' | 'R'>): TaskReliability => {
        const touches: TouchEvent[] = classes.map((cls, i) => ({ kind: 'operator-event', at: '2026-10-05T00:00:00Z', class: cls, bucket: `${i}` }));
        const touchClasses = { O: 0, L: 0, S: 0, R: 0 };
        for (const t of touches) touchClasses[t.class] += 1;
        return {
          task: { issue, title: issue, mergedAt: '2026-10-05T00:00:00Z' },
          touches, touchCount: touches.length, touchClasses, approvals: 0, automationCount: 0, unattributedCommits: 0,
          stuckMs: 0, stuckCoverage: 'none', stallIntervals: [], isMillTask: true,
        };
      };
      const summary = aggregateReliability(
        [mk('HOK-1', ['O', 'S', 'S']), mk('HOK-2', ['L', 'R']), mk('HOK-3', [])],
        { sinceIso: '2026-10-01T00:00:00Z', untilIso: '2026-10-08T00:00:00Z', bucket: 'rolling7d' },
      );
      assert.deepEqual(summary.overall.touchClasses, { O: 1, L: 1, S: 2, R: 1 });
      assert.deepEqual(summary.overall.touchedTasksByClass, { O: 1, L: 1, S: 1, R: 1 });
      assert.deepEqual(summary.buckets[0].touchClasses, { O: 1, L: 1, S: 2, R: 1 });

      const text = renderReliabilitySummary(summary, { includeTaskTable: true, includeClasses: true });
      assert.match(text, /Touches by class:\s+O=1  L=1  S=2  R=1/);
      assert.match(text, /Tasks touched by class:\s+O=1  L=1  S=1  R=1/);
      assert.match(text, /HOK-1\s+touches=3  O=1  L=0  S=2  R=0/);
    });

    it('dedupe classifies touches that arrive without a class', () => {
      const touches = dedupeTouches([{ kind: 'label-edit', at: '2026-10-08T10:00:00Z', detail: 'labeled:wm:superseded' }]);
      assert.equal(touches[0].class, 'O');
    });

    it('spot-checks a closed-unmerged PR through the injected timeline', () => {
      const tmp = makeTmpDir();
      try {
        const gh = () => [
          { event: 'unlabeled', at: '2026-10-07T18:00:00Z', actor: 'tim', label: 'wm:blocked' },
          { event: 'closed', at: '2026-10-07T19:00:00Z', actor: 'tim' },
        ].map((e) => JSON.stringify(e)).join('\n');
        const context: ReliabilityContext = {
          repoDir: tmp,
          github: { enabled: true, gh, nwo: 'acme/widgets', cacheDir: null },
          labelWrites: indexMillLabelWrites([{ at: '2026-10-01T00:00:00Z', prNumber: 1, label: 'wm:ready', action: 'labeled', writer: 'mill' }]),
          millActorLogins: new Set(),
          mergeLaneSinceMs: Date.parse('2026-10-01T00:00:00Z'),
          stats: { githubTimelines: 0, githubUnavailable: 0 },
        };
        const summary = computeReliability({
          repoDir: tmp,
          sinceIso: '2026-10-01T00:00:00Z',
          untilIso: '2026-10-08T00:00:00Z',
          bucket: 'rolling7d',
          spotCheckPrs: ['1598'],
          context,
        });
        assert.equal(summary.overall.merged, 0);
        assert.equal(summary.spotChecks?.length, 1);
        const spot = summary.spotChecks![0];
        assert.equal(spot.task.merged, false);
        // label edit only — a closed PR is never an external merge
        assert.deepEqual(spot.touches.map((t) => [t.kind, t.class]), [['label-edit', 'S']]);
        assert.match(renderReliabilitySummary(summary), /#1598\s+touched/);
        assert.equal(summary.sources?.githubTimelines, 1);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('mill-only classification (HOK-3245)', () => {
    function gitCommit(repo: string, at: string, subject: string): void {
      execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', subject], {
        env: { ...process.env, GIT_COMMITTER_DATE: at, GIT_AUTHOR_DATE: at },
      });
    }

    it('splits mill tasks from operator PRs and keeps reaped mill tasks', () => {
      const tmp = makeTmpDir();
      try {
        execFileSync('git', ['-C', tmp, 'init', '-q', '-b', 'main']);
        gitCommit(tmp, '2026-10-02T00:00:00Z', 'base');
        gitCommit(tmp, '2026-10-05T10:00:00Z', 'HOK-999: mill task (#101)');
        gitCommit(tmp, '2026-10-05T11:00:00Z', 'fix: operator cleanup (#102)');
        gitCommit(tmp, '2026-10-05T12:00:00Z', 'HOK-998: reaped mill task (#103)');

        // HOK-999 still has its live feature dir with a stage result.
        const featureDir = join(tmp, 'features', 'hok-999-mill-task');
        mkdirSync(featureDir, { recursive: true });
        writeFileSync(join(featureDir, '.coding-result.json'), JSON.stringify({
          stage: 'coding', status: 'completed', startedAt: '2026-10-05T09:00:00Z', finishedAt: '2026-10-05T09:30:00Z',
        }));
        // HOK-998 was reaped: only its terminal record remains.
        const archiveDir = join(tmp, '.wavemill', 'evals', 'artifacts', 'HOK-998');
        mkdirSync(archiveDir, { recursive: true });
        writeFileSync(join(archiveDir, 'terminal-record.json'), JSON.stringify({ issue: 'HOK-998', prNumber: 103 }));

        const summary = computeReliability({
          repoDir: tmp,
          sinceIso: '2026-10-01T00:00:00Z',
          untilIso: '2026-10-08T00:00:00Z',
          bucket: 'rolling7d',
          branches: ['main'],
          github: false,
        });
        const byPr = new Map(summary.tasks.map((t) => [t.task.prNumber, t.isMillTask]));
        assert.deepEqual([...byPr.entries()].sort(), [['101', true], ['102', false], ['103', true]]);
        assert.equal(summary.overall.merged, 3);
        assert.equal(summary.overall.millMerged, 2);
        assert.equal(summary.buckets[0].millMerged, 2);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('cacheDir: null keeps the run read-only; a path redirects the PR timeline cache', () => {
      const tmp = makeTmpDir();
      try {
        execFileSync('git', ['-C', tmp, 'init', '-q', '-b', 'main']);
        gitCommit(tmp, '2026-10-05T10:00:00Z', 'fix: operator cleanup (#102)');
        const gh = () => JSON.stringify({ event: 'merged', at: '2026-10-05T10:00:00Z', actor: 'tim' });
        const run = (cacheDir: string | null) => {
          const context = buildReliabilityContext({ repoDir: tmp, github: true, gh, cacheDir });
          context.github!.nwo = 'acme/widgets';
          return computeReliability({
            repoDir: tmp, sinceIso: '2026-10-01T00:00:00Z', untilIso: '2026-10-08T00:00:00Z',
            bucket: 'rolling7d', branches: ['main'], context,
          });
        };

        assert.equal(run(null).sources?.githubTimelines, 1);
        assert.ok(!existsSync(join(tmp, '.wavemill', 'cache')), 'read-only run wrote the default cache');

        const cacheDir = join(tmp, 'pr-cache');
        run(cacheDir);
        assert.ok(existsSync(join(cacheDir, '102.json')));
        assert.ok(!existsSync(join(tmp, '.wavemill', 'cache')));
        assert.ok(!('cacheDir' in buildReliabilityContext({ repoDir: tmp, github: false }).github!));
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});

// HOK-3260: median native prompt-cache hit rate per (model, provider route).
describe('prompt-cache hit rate section', () => {
  function stageResult(stage: string, model: string, usage: Record<string, unknown> | undefined): string {
    return JSON.stringify({
      stage,
      status: 'completed',
      model,
      executedModel: model,
      artifacts: { type: stage, ...(usage ? { usage } : {}) },
    });
  }

  it('takes the median per (model, route) across live and archived stage results', () => {
    const root = makeTmpDir();
    try {
      const tasks: MergedTaskRef[] = [];
      const rates = [0.9, 0.2, 0.8, 0.7, 0.95];
      rates.forEach((rate, i) => {
        const featureDir = join(root, `task-${i}`);
        mkdirSync(featureDir, { recursive: true });
        writeFileSync(join(featureDir, '.coding-result.json'),
          stageResult('coding', 'claude-sonnet-5-5', { cacheHitRate: rate, providerRoute: 'anthropic' }));
        tasks.push({ issue: `HOK-${i}`, title: `t${i}`, mergedAt: '2026-10-05T00:00:00Z', featureDir });
      });
      // A reaped task: HOK-2891 keeps the dotted name in the archive.
      const archiveDir = join(root, 'archive');
      mkdirSync(archiveDir, { recursive: true });
      writeFileSync(join(archiveDir, '.planning-result.json'),
        stageResult('planning', 'gemini-3-pro', { cacheHitRate: 0.1, providerRoute: 'openrouter' }));
      writeFileSync(join(archiveDir, '.review-result.json'),
        stageResult('review', 'gemini-3-pro', { cacheHitRate: 0.3, providerRoute: 'openrouter' }));
      tasks.push({ issue: 'HOK-9', title: 'archived', mergedAt: '2026-10-05T00:00:00Z', archiveDir });

      assert.deepEqual(collectPromptCacheHitRates(tasks), [
        { model: 'claude-sonnet-5-5', providerRoute: 'anthropic', medianHitRate: 0.8, samples: 5 },
        { model: 'gemini-3-pro', providerRoute: 'openrouter', medianHitRate: 0.2, samples: 2 },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips stage results without a numeric hit rate', () => {
    const root = makeTmpDir();
    try {
      const featureDir = join(root, 'task');
      mkdirSync(featureDir, { recursive: true });
      writeFileSync(join(featureDir, '.planning-result.json'), stageResult('planning', 'm', { turnsCompleted: 1 }));
      writeFileSync(join(featureDir, '.coding-result.json'), stageResult('coding', 'm', { cacheHitRate: null }));
      writeFileSync(join(featureDir, '.review-result.json'), '{not json');
      const tasks: MergedTaskRef[] = [{ title: 't', mergedAt: '2026-10-05T00:00:00Z', featureDir }];
      assert.deepEqual(collectPromptCacheHitRates(tasks), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('renders the section only when there are rows', () => {
    const base = aggregateReliability([], {
      sinceIso: '2026-10-01T00:00:00Z',
      untilIso: '2026-10-08T00:00:00Z',
      bucket: 'rolling7d',
    });
    assert.doesNotMatch(renderReliabilitySummary(base), /Prompt-cache hit rate/);

    const text = renderReliabilitySummary({
      ...base,
      promptCache: [{ model: 'claude-sonnet-5-5', providerRoute: 'anthropic', medianHitRate: 0.8, samples: 5 }],
    });
    assert.match(text, /Prompt-cache hit rate \(median, turns 2\.\.n\):/);
    assert.match(text, /claude-sonnet-5-5\s+anthropic\s+80\.0%\s+\(5 runs\)/);
  });

  describe('gate report and operator touches (HOK-3468)', () => {
    const UTC_HOURS = { start: 8, end: 19, days: [1, 2, 3, 4, 5], timeZone: 'UTC' };
    const utc = (iso: string) => Date.parse(iso);

    it('counts the part of an interval outside configured working hours', () => {
      // protects: off-hours is calendar-derived (nights, weekends), not a
      // fixed offset from the interval length.
      assert.equal(isWorkingMoment(utc('2026-11-06T18:00:00Z'), UTC_HOURS), true);
      assert.equal(isWorkingMoment(utc('2026-11-06T19:00:00Z'), UTC_HOURS), false);
      assert.equal(isWorkingMoment(utc('2026-11-07T10:00:00Z'), UTC_HOURS), false);

      // A Thursday entirely inside working hours carries no off-hours time.
      assert.equal(computeOffHoursMs(utc('2026-11-05T09:00:00Z'), utc('2026-11-05T10:00:00Z'), UTC_HOURS), 0);
      // Friday evening crosses the 19:00 end: an hour off.
      assert.equal(computeOffHoursMs(utc('2026-11-06T18:00:00Z'), utc('2026-11-06T20:00:00Z'), UTC_HOURS), 3_600_000);
      // Overnight Friday → Saturday morning is all off-hours.
      assert.equal(computeOffHoursMs(utc('2026-11-06T22:00:00Z'), utc('2026-11-07T07:00:00Z'), UTC_HOURS), 9 * 3_600_000);
      // Saturday → Sunday is a whole weekend day.
      assert.equal(computeOffHoursMs(utc('2026-11-07T10:00:00Z'), utc('2026-11-08T10:00:00Z'), UTC_HOURS), 24 * 3_600_000);
      // Monday before the start: two hours off.
      assert.equal(computeOffHoursMs(utc('2026-11-02T06:00:00Z'), utc('2026-11-02T09:00:00Z'), UTC_HOURS), 2 * 3_600_000);
      // A misconfigured window (end <= start) is all off-hours, never zero.
      assert.equal(
        computeOffHoursMs(utc('2026-11-05T09:00:00Z'), utc('2026-11-05T10:00:00Z'), { ...UTC_HOURS, start: 19, end: 8 }),
        3_600_000,
      );
    });

    it('sums the off-hours stuck time that ended with an operator action', () => {
      // protects: "waited for a person" divides off-hours time on
      // person-ended stalls by total stuck time.
      const result = computeWaitedForPerson([
        { from: '2026-11-05T22:00:00Z', to: '2026-11-06T00:00:00Z', durationMs: 2 * 3_600_000, endedByPerson: true, offHoursMs: 3_600_000 },
        { from: '2026-11-06T00:00:00Z', to: '2026-11-06T02:00:00Z', durationMs: 2 * 3_600_000, endedByPerson: false, offHoursMs: 2 * 3_600_000 },
      ]);
      assert.equal(result.hours, 1);
      assert.equal(result.stuckHours, 4);
      assert.equal(result.share, 0.25);
      assert.equal(computeWaitedForPerson([]).share, null);
    });

    it('marks an interval ended by a person only inside the window around its end', () => {
      // protects: the ended-by-person window edges, and that an approval
      // counts as a person acting while mill automation does not.
      const T = utc('2026-11-05T10:00:00Z');
      const to = T + 3_600_000;
      const task = { title: 't', mergedAt: new Date(to + 3_600_000).toISOString() };
      const stuck = {
        stuckMs: 3_600_000,
        coverage: 'full' as const,
        stallIntervals: [{ from: new Date(T).toISOString(), to: new Date(to).toISOString(), durationMs: 3_600_000 }],
        gateEvidence: {
          launches: [{ kind: 'coding', stage: 'coding' as const, atMs: T - 3_600_000 }],
          mergedMs: to + 3_600_000,
        },
      };
      const touch = (atMs: number, attribution: 'human' | 'approval' | 'automation'): TouchEvent => ({
        kind: 'operator-event',
        at: new Date(atMs).toISOString(),
        attribution,
        class: 'R',
        bucket: `${atMs}`,
      });
      const ended = (touches: TouchEvent[]) =>
        attachStallGates(task, stuck, { repoDir: '/nonexistent' }, { touches, workingHours: UTC_HOURS })[0].endedByPerson;

      assert.equal(ended([touch(to - ENDED_BY_PERSON_BEFORE_MS, 'human')]), true);
      assert.equal(ended([touch(to - ENDED_BY_PERSON_BEFORE_MS - 1000, 'human')]), false);
      assert.equal(ended([touch(to + ENDED_BY_PERSON_AFTER_MS, 'human')]), true);
      assert.equal(ended([touch(to + ENDED_BY_PERSON_AFTER_MS + 1000, 'human')]), false);
      assert.equal(ended([touch(to - 10 * 60_000, 'approval')]), true);
      assert.equal(ended([touch(to, 'automation')]), false);
    });

    it('counts a plan approval as a person who acted, not as a human touch', () => {
      // protects: an approval does not make a task attended; the mill's
      // unattended rate counts people who had to act.
      const repo = makeTmpDir();
      try {
        const archiveDir = join(repo, '.wavemill', 'evals', 'artifacts', 'HOK-9001');
        mkdirSync(archiveDir, { recursive: true });
        writeFixture(join(archiveDir, '.operator-events.jsonl'), [
          { seq: 1, command: 'approve', issue: 'HOK-9001', at: '2026-11-05T10:00:00Z' },
          { seq: 2, command: 're-review', issue: 'HOK-9001', at: '2026-11-05T12:00:00Z', head: 'abc1234' },
        ]);
        const approvedOnlyDir = join(repo, '.wavemill', 'evals', 'artifacts', 'HOK-9002');
        mkdirSync(approvedOnlyDir, { recursive: true });
        writeFixture(join(approvedOnlyDir, '.operator-events.jsonl'), [
          { seq: 1, command: 'approve', issue: 'HOK-9002', at: '2026-11-05T10:00:00Z' },
        ]);

        const approvalOnly = computeTaskReliability(
          { issue: 'HOK-9002', title: 'HOK-9002', mergedAt: '2026-11-06T10:00:00Z', archiveDir: approvedOnlyDir },
          { repoDir: repo, github: { enabled: false } },
        );
        assert.equal(approvalOnly.approvals, 1);
        assert.equal(approvalOnly.touchCount, 0);
        assert.equal(approvalOnly.touchClasses.R, 0);

        const touched = computeTaskReliability(
          { issue: 'HOK-9001', title: 'HOK-9001', mergedAt: '2026-11-06T10:00:00Z', archiveDir },
          { repoDir: repo, github: { enabled: false } },
        );
        assert.equal(touched.approvals, 1);
        assert.equal(touched.touchCount, 1);
        assert.equal(touched.touchClasses.R, 1);

        const summary = aggregateReliability([approvalOnly, touched], {
          sinceIso: '2026-11-01T00:00:00Z',
          untilIso: '2026-11-08T00:00:00Z',
          bucket: 'rolling7d',
        });
        assert.equal(summary.overall.merged, 2);
        assert.equal(summary.overall.unattended, 1);
        assert.equal(summary.overall.unattendedRate, 0.5);
        assert.equal(summary.overall.approvals, 2);
        assert.equal(summary.overall.tasksWithApprovals, 2);
        assert.deepEqual(summary.overall.touchClasses, { O: 0, L: 0, S: 0, R: 1 });
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });

    it('drops eval session-redirect copies when the transcripts were readable', () => {
      // protects: the transcript (with its provenance) is the source of truth;
      // the eval copy would otherwise double-count the same message.
      const repo = makeTmpDir();
      try {
        const worktree = join(repo, 'wt');
        const branch = 'task/hok-9002';
        const encoded = encodeProjectDir(worktree);
        const projectsDir = join(
          worktree, '.wavemill', 'runs', 'r1', 'providers', 'deepseek', 'home', '.claude', 'projects', encoded,
        );
        mkdirSync(projectsDir, { recursive: true });
        writeFixture(join(projectsDir, 's1.jsonl'), [
          { type: 'user', gitBranch: branch, sessionId: 's1', timestamp: '2026-11-05T10:00:00Z', message: { role: 'user', content: 'You are working on: Thing (HOK-9002)' } },
          { type: 'user', gitBranch: branch, sessionId: 's1', timestamp: '2026-11-05T10:30:00Z', message: { role: 'user', content: 'change the title please' } },
        ]);
        const evalsPath = join(repo, '.wavemill', 'evals', 'evals.jsonl');
        writeFixture(evalsPath, [{
          issueId: 'HOK-9002',
          prUrl: 'https://github.com/o/r/pull/9002',
          timestamp: '2026-11-05T10:31:00Z',
          interventionCount: 1,
          interventions: [{ type: 'session_redirect', note: '[session_redirect] change the title please', timestamp: '2026-11-05T10:31:00Z' }],
        }]);
        const ctx: ReliabilityContext = { repoDir: repo, evals: buildEvalsIndex(evalsPath), github: { enabled: false } };
        const task: MergedTaskRef = { issue: 'HOK-9002', title: 't', mergedAt: '2026-11-06T00:00:00Z', branch, worktree };

        const withTranscripts = collectOperatorTouches({ repoDir: repo, task, context: ctx, timeline: null })
          .filter((t) => t.kind === 'session-redirect');
        assert.equal(withTranscripts.length, 1);
        assert.equal(withTranscripts[0].at, '2026-11-05T10:30:00Z');

        const fallback = collectOperatorTouches({ repoDir: repo, task: { ...task, worktree: undefined }, context: ctx, timeline: null })
          .filter((t) => t.kind === 'session-redirect');
        assert.equal(fallback.length, 1);
        assert.equal(fallback[0].at, '2026-11-05T10:31:00Z');
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });

    it('renders the gate table, stage split and waited-for-a-person line', () => {
      // protects: the CLI text carries the same gate data as the JSON.
      const interval = (
        gate: StallInterval['gate'],
        stage: StallInterval['stage'],
        hours: number,
        extra: { endedByPerson?: boolean; offHoursMs?: number } = {},
      ): StallInterval => ({
        from: '2026-11-05T22:00:00Z',
        to: '2026-11-06T00:00:00Z',
        durationMs: hours * 3_600_000,
        gate,
        stage,
        gateSplit: [{ gate: gate!, stage: stage!, ms: hours * 3_600_000 }],
        endedByPerson: extra.endedByPerson ?? false,
        offHoursMs: extra.offHoursMs ?? 0,
      });
      const task: TaskReliability = {
        task: { issue: 'HOK-7', title: 'HOK-7', mergedAt: '2026-11-06T10:00:00Z' },
        touches: [],
        touchCount: 0,
        touchClasses: { O: 0, L: 0, S: 0, R: 0 },
        approvals: 0,
        automationCount: 0,
        unattributedCommits: 0,
        stuckMs: 3 * 3_600_000,
        stuckCoverage: 'full',
        stallIntervals: [
          interval('review-park', 'review', 2, { endedByPerson: true, offHoursMs: 3_600_000 }),
          interval('ready-checks', 'ready', 1, { offHoursMs: 1_800_000 }),
        ],
        isMillTask: true,
      };
      const summary = aggregateReliability([task], {
        sinceIso: '2026-11-01T00:00:00Z',
        untilIso: '2026-11-08T00:00:00Z',
        bucket: 'rolling7d',
      });
      const text = renderReliabilitySummary(summary);
      assert.match(text, /Stuck time by gate \(all stalls; hours sum to total stuck\):/);
      assert.match(text, /review-park\s+1\s+1\s+2\.0\s+1\s+1\.0h/);
      assert.match(text, /ready-checks\s+1\s+1\s+1\.0\s+0\s+0\.5h/);
      assert.match(text, /By stage: planning 0\.0h · coding 0\.0h · review 2\.0h · ready 1\.0h · merge 0\.0h/);
      assert.match(text, /Waited for a person \(off-hours, ended by an operator action\): 1\.0h of 3\.0h \(33\.3%\)/);
      assert.match(text, /Unknown 0\.0% of stuck hours/);
    });
  });
});
