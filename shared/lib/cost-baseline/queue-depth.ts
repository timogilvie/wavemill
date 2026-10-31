/**
 * Merge-queue depth and arrival burstiness for the MQ-0.1 baseline (HOK-3336).
 *
 * Primary source: the label ledger (`.wavemill/label-writes.jsonl`, from
 * 2026-10-13). A PR is **queued** while it holds `wm:ready` or `wm:merging`,
 * and **waiting** while it holds `wm:ready` only (enqueued, not yet being
 * merged). Depth is time-weighted over the part of the window the ledger
 * covers, and also sampled at each arrival ("how many PRs were ahead").
 *
 * Secondary source: merge-lane `progress.json` (`enteredLaneAt` →
 * `lastProgressAt`), which covers the whole window but only measures time the
 * executor held a PR, not time it waited.
 *
 * @module cost-baseline/queue-depth
 */

import type { BaselineWindow, LabelEvent, LaneProgress, PrState } from './types.ts';

export interface Interval {
  prNumber: number;
  start: number;
  end: number;
}

export interface DepthDistribution {
  /** Boundaries of the measured span (ISO). */
  from: string;
  to: string;
  totalSeconds: number;
  /** Seconds spent at each depth (index = depth). */
  secondsByDepth: number[];
  shareDepthGt0: number;
  shareDepthGt1: number;
  shareDepthGt2: number;
  maxDepth: number;
  /** Mean depth over time when at least one PR was present. */
  meanDepthWhenNonEmpty: number;
}

export interface ArrivalStats {
  arrivals: number;
  /** Share of arrivals that found ≥1 / ≥2 PRs already queued. */
  shareFoundAhead1: number;
  shareFoundAhead2: number;
  medianInterArrivalSeconds: number | null;
  /** Coefficient of variation of inter-arrival times (1 = Poisson, >1 = bursty). */
  interArrivalCv: number | null;
  /** Variance / mean of hourly arrival counts (1 = Poisson, >1 = bursty). */
  hourlyFano: number | null;
  peakArrivalsPerHour: number;
}

export interface QueueDepthResult {
  ledger: {
    coverageFrom: string | null;
    coverageTo: string;
    /** PRs dropped because their label never came off and no merge/close time was known. */
    unterminatedPrs: number[];
    prStatesFetched: boolean;
    queued: DepthDistribution | null;
    waiting: DepthDistribution | null;
    arrivals: ArrivalStats | null;
  };
  lane: DepthDistribution | null;
}

/**
 * When each PR left the queue for good, in epoch ms: a merged lane's
 * `lastProgressAt`, the last `wm:merged` write, or GitHub merge/close time.
 * A PR GitHub reports OPEN maps to +Infinity (still queued at window end).
 */
export function prCloseTimes(events: LabelEvent[], laneRows: LaneProgress[], prStates: Map<number, PrState>): Map<number, number> {
  const close = new Map<number, number>();
  const earliest = (pr: number, at: number) => {
    if (Number.isFinite(at) && at < (close.get(pr) ?? Infinity)) close.set(pr, at);
  };
  for (const [pr, state] of prStates) {
    if (state.state === 'OPEN') close.set(pr, Infinity);
    else earliest(pr, Date.parse(state.mergedAt ?? state.closedAt ?? ''));
  }
  for (const row of laneRows) {
    if (row.lastEvent === 'merged') earliest(row.prNumber, Date.parse(row.lastProgressAt ?? ''));
  }
  for (const event of events) {
    if (event.label === 'wm:merged' && event.action === 'labeled') earliest(event.prNumber, Date.parse(event.at));
  }
  return close;
}

/**
 * The mill removes `wm:ready` a second or two before it applies `wm:merging`;
 * a PR re-queued within this gap never left the queue.
 */
export const HANDOFF_GAP_MS = 10_000;

/** Merge one PR's chronologically ordered intervals separated by at most `gapMs`. */
function bridge(intervals: Interval[], gapMs: number): Interval[] {
  const merged: Interval[] = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (last && interval.start - last.end <= gapMs) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

export interface LedgerIntervals {
  queued: Interval[];
  waiting: Interval[];
  /** PRs whose label was still on at the end with no known merge/close — excluded. */
  unterminated: number[];
}

/**
 * Per-PR intervals from the label ledger. `queued` holds `wm:ready` ∪
 * `wm:merging` (gaps up to HANDOFF_GAP_MS bridged); `waiting` holds
 * `wm:ready` alone. Labels persist on merged
 * and closed PRs, so every interval is clipped at the PR's close time; an
 * interval still open at the end closes there (or at `windowEnd` for a PR
 * known to be open) and is dropped — and reported — when neither is known.
 */
export function ledgerIntervals(events: LabelEvent[], windowEnd: number, closeTimes: Map<number, number> = new Map()): LedgerIntervals {
  const byPr = new Map<number, LabelEvent[]>();
  for (const event of events) {
    if (event.label !== 'wm:ready' && event.label !== 'wm:merging') continue;
    const list = byPr.get(event.prNumber) ?? [];
    list.push(event);
    byPr.set(event.prNumber, list);
  }
  const queuedAll: Interval[] = [];
  const waiting: Interval[] = [];
  const unterminated: number[] = [];
  for (const [prNumber, prEvents] of byPr) {
    const queued: Interval[] = [];
    const closeAt = closeTimes.get(prNumber);
    const limit = Math.min(windowEnd, closeAt ?? Infinity);
    const push = (list: Interval[], start: number, end: number) => {
      const clipped = Math.min(end, limit);
      if (clipped > start) list.push({ prNumber, start, end: clipped });
    };
    let ready = false;
    let merging = false;
    let queuedSince: number | null = null;
    let waitingSince: number | null = null;
    const sorted = [...prEvents].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    for (const event of sorted) {
      const at = Date.parse(event.at);
      const on = event.action === 'labeled';
      if (event.label === 'wm:ready') ready = on;
      else merging = on;
      if ((ready || merging) && queuedSince === null) queuedSince = at;
      if (!(ready || merging) && queuedSince !== null) {
        push(queued, queuedSince, at);
        queuedSince = null;
      }
      if (ready && waitingSince === null) waitingSince = at;
      if (!ready && waitingSince !== null) {
        push(waiting, waitingSince, at);
        waitingSince = null;
      }
    }
    if (queuedSince !== null || waitingSince !== null) {
      if (closeAt === undefined) {
        unterminated.push(prNumber);
      } else {
        if (queuedSince !== null) push(queued, queuedSince, limit);
        if (waitingSince !== null) push(waiting, waitingSince, limit);
      }
    }
    queuedAll.push(...bridge(queued, HANDOFF_GAP_MS));
  }
  return { queued: queuedAll, waiting, unterminated: unterminated.sort((a, b) => a - b) };
}

/** Lane occupancy intervals (`enteredLaneAt` → `lastProgressAt`). */
export function laneIntervals(rows: LaneProgress[]): Interval[] {
  const intervals: Interval[] = [];
  for (const row of rows) {
    const start = Date.parse(row.enteredLaneAt ?? '');
    const end = Date.parse(row.lastProgressAt ?? '');
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) intervals.push({ prNumber: row.prNumber, start, end });
  }
  return intervals;
}

/** Time-weighted depth distribution of `intervals` clipped to [from, to]. */
export function depthDistribution(intervals: Interval[], from: number, to: number): DepthDistribution | null {
  if (!(to > from)) return null;
  const steps: Array<[number, number]> = [];
  for (const interval of intervals) {
    const start = Math.max(interval.start, from);
    const end = Math.min(interval.end, to);
    if (end <= start) continue;
    steps.push([start, +1], [end, -1]);
  }
  // Exits before entries at the same instant: a hand-off is not depth 2.
  steps.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const secondsByDepth: number[] = [0];
  let depth = 0;
  let cursor = from;
  for (const [at, delta] of steps) {
    secondsByDepth[depth] = (secondsByDepth[depth] ?? 0) + (at - cursor) / 1000;
    cursor = at;
    depth += delta;
  }
  secondsByDepth[depth] = (secondsByDepth[depth] ?? 0) + (to - cursor) / 1000;
  for (let i = 0; i < secondsByDepth.length; i++) secondsByDepth[i] ??= 0;
  const totalSeconds = (to - from) / 1000;
  const share = (minDepth: number) => secondsByDepth.slice(minDepth).reduce((a, b) => a + b, 0) / totalSeconds;
  const nonEmpty = secondsByDepth.slice(1).reduce((a, b) => a + b, 0);
  const weighted = secondsByDepth.reduce((sum, secs, d) => sum + secs * d, 0);
  let maxDepth = 0;
  secondsByDepth.forEach((secs, d) => {
    if (secs > 0) maxDepth = d;
  });
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    totalSeconds,
    secondsByDepth,
    shareDepthGt0: share(1),
    shareDepthGt1: share(2),
    shareDepthGt2: share(3),
    maxDepth,
    meanDepthWhenNonEmpty: nonEmpty > 0 ? weighted / nonEmpty : 0,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Arrival statistics inside [from, to]. An arrival is a PR's **first**
 * enqueue: re-entries after a block, and the reconciler's `wm:ready`
 * flapping, are the same PR and are not new work arriving.
 */
export function arrivalStats(queued: Interval[], from: number, to: number): ArrivalStats | null {
  const firstByPr = new Map<number, Interval>();
  for (const interval of queued) {
    const known = firstByPr.get(interval.prNumber);
    if (!known || interval.start < known.start) firstByPr.set(interval.prNumber, interval);
  }
  const arrivals = [...firstByPr.values()].filter((i) => i.start >= from && i.start <= to).sort((a, b) => a.start - b.start);
  if (arrivals.length === 0 || !(to > from)) return null;
  let ahead1 = 0;
  let ahead2 = 0;
  for (const arrival of arrivals) {
    const ahead = new Set(
      queued.filter((o) => o.prNumber !== arrival.prNumber && o.start < arrival.start && o.end > arrival.start).map((o) => o.prNumber),
    ).size;
    if (ahead >= 1) ahead1++;
    if (ahead >= 2) ahead2++;
  }
  const gaps = arrivals.slice(1).map((a, i) => (a.start - arrivals[i].start) / 1000);
  let cv: number | null = null;
  if (gaps.length >= 2) {
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const variance = gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length;
    cv = mean > 0 ? Math.sqrt(variance) / mean : null;
  }
  const hours = Math.max(1, Math.ceil((to - from) / 3_600_000));
  const bins = new Array<number>(hours).fill(0);
  for (const arrival of arrivals) bins[Math.min(hours - 1, Math.floor((arrival.start - from) / 3_600_000))]++;
  const binMean = bins.reduce((a, b) => a + b, 0) / hours;
  const binVariance = bins.reduce((s, b) => s + (b - binMean) ** 2, 0) / hours;
  return {
    arrivals: arrivals.length,
    shareFoundAhead1: ahead1 / arrivals.length,
    shareFoundAhead2: ahead2 / arrivals.length,
    medianInterArrivalSeconds: median(gaps),
    interArrivalCv: cv,
    hourlyFano: binMean > 0 ? binVariance / binMean : null,
    peakArrivalsPerHour: Math.max(...bins),
  };
}

/** Queue depth from both sources over the window. */
export function computeQueueDepth(
  events: LabelEvent[],
  laneRows: LaneProgress[],
  window: BaselineWindow,
  prStates: Map<number, PrState> = new Map(),
): QueueDepthResult {
  const since = Date.parse(window.since);
  const until = Date.parse(window.until);
  const inWindow = events.filter((e) => Date.parse(e.at) <= until);
  const times = events.map((e) => Date.parse(e.at));
  const firstLedger = inWindow.length > 0 ? Math.min(...times) : null;
  // The ledger covers the window only from its first row, and only if it was
  // still being written once the window opened (no rows since = no evidence).
  const ledgerAlive = times.length > 0 && Math.max(...times) >= since;
  const ledgerFrom = firstLedger === null || firstLedger >= until || !ledgerAlive ? null : Math.max(since, firstLedger);
  const { queued, waiting, unterminated } = ledgerIntervals(inWindow, until, prCloseTimes(events, laneRows, prStates));
  return {
    ledger: {
      coverageFrom: ledgerFrom === null ? null : new Date(ledgerFrom).toISOString(),
      coverageTo: new Date(until).toISOString(),
      unterminatedPrs: unterminated,
      prStatesFetched: prStates.size > 0,
      queued: ledgerFrom === null ? null : depthDistribution(queued, ledgerFrom, until),
      waiting: ledgerFrom === null ? null : depthDistribution(waiting, ledgerFrom, until),
      arrivals: ledgerFrom === null ? null : arrivalStats(queued, ledgerFrom, until),
    },
    lane: depthDistribution(laneIntervals(laneRows), since, until),
  };
}
