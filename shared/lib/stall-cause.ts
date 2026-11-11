/**
 * HOK-3455 / HOK-3468 — derive the cause of a stall interval from existing
 * records.
 *
 * Two decisions live here and nowhere else:
 *
 *  - `deriveGateTimeline(evidence)` names the gate that held a task at each
 *    point in time (plan approval, an agent, a review park, Ready checks, the
 *    merge lane, operator attention), from records the mill already writes.
 *  - `deriveStallGate(interval, spans)` splits one stall interval across those
 *    gates. The coarse `StallCause` is derived from the gate through
 *    {@link GATE_TO_CAUSE}, so the headline cause and the gate table can never
 *    disagree.
 *
 * Pure reporting helper: no markers, flags, or stored durations. No IO.
 */

import { isAgentWaitingState } from './attention.ts';

export type StallCause =
  | 'stage-agent'
  | 'ci'
  | 'merge-lane'
  | 'operator-attention'
  | 'host-down'
  | 'unknown';

export const STALL_CAUSES: readonly StallCause[] = [
  'stage-agent',
  'ci',
  'merge-lane',
  'operator-attention',
  'host-down',
  'unknown',
];

/** The gate that held a stuck task (HOK-3468). */
export type StallGate =
  | 'plan-approval'
  | 'planning-agent'
  | 'coding-agent'
  | 'review-agent'
  | 'review-park'
  | 'ready-checks'
  | 'ready-remediation'
  | 'merge-lane'
  | 'operator-attention'
  | 'unknown';

/** Fixed report order: coarse gates, then the two attention gates, then unknown. */
export const STALL_GATES: readonly StallGate[] = [
  'planning-agent',
  'plan-approval',
  'coding-agent',
  'review-agent',
  'review-park',
  'ready-checks',
  'ready-remediation',
  'merge-lane',
  'operator-attention',
  'unknown',
];

/** Precedence when two gates cover the same instant or tie on overlap. */
export const GATE_PRECEDENCE: readonly StallGate[] = [
  'operator-attention',
  'plan-approval',
  'merge-lane',
  'review-park',
  'ready-remediation',
  'ready-checks',
  'review-agent',
  'coding-agent',
  'planning-agent',
  'unknown',
];

/** The stage a gate belongs to. */
export type StallStage = 'planning' | 'coding' | 'review' | 'ready' | 'merge' | 'unknown';

export const STALL_STAGES: readonly StallStage[] = ['planning', 'coding', 'review', 'ready', 'merge', 'unknown'];

/**
 * Each gate maps onto exactly one coarse cause, so `stallCauses` (the >1h
 * headline line) and `stallGates` (the split table) never disagree.
 */
export const GATE_TO_CAUSE: Readonly<Record<StallGate, StallCause>> = Object.freeze({
  'plan-approval': 'operator-attention',
  'planning-agent': 'stage-agent',
  'coding-agent': 'stage-agent',
  'review-agent': 'stage-agent',
  'review-park': 'stage-agent',
  'ready-checks': 'ci',
  'ready-remediation': 'stage-agent',
  'merge-lane': 'merge-lane',
  'operator-attention': 'operator-attention',
  unknown: 'unknown',
});

/** A span of time with a known cause (legacy coarse model). */
export interface CauseSpan {
  cause: StallCause;
  fromMs: number;
  toMs: number;
  detail?: string;
}

/** A span of time attributed to one gate. */
export interface GateSpan {
  gate: StallGate;
  stage: StallStage;
  fromMs: number;
  toMs: number;
  detail?: string;
  /** For `unknown`: the records whose absence left the gap. */
  missing?: string[];
}

/** Canonical stage names carried by session-ownership rows and stage results. */
export type GateStageName = 'planning' | 'coding' | 'review' | 'ready';

/** One non-helper session-ownership launch. */
export interface GateLaunch {
  /** Session-ownership kind (e.g. `coding`, `ready-remediation`). */
  kind: string;
  /** A native arm's stage (its launch kind is `native-arm`). */
  stage?: GateStageName;
  atMs: number;
}

/** One stage result's window. */
export interface GateStageResult {
  stage: GateStageName;
  status: string;
  startedAtMs: number;
  finishedAtMs: number | null;
  /** Review verdict (`ready` / `not_ready` / `error`), when the stage records one. */
  verdict?: string;
}

/** One of the HOK-3101 primitive's agent-own hook records. */
export interface GateAgentRecord {
  atMs: number;
  state: string;
}

/**
 * An interval during which the task was waiting on a person. `gate` names the
 * specific wait when it is narrower than `operator-attention` (plan approval);
 * otherwise the span is operator attention.
 */
export interface GateAttentionSpan {
  fromMs: number;
  toMs: number;
  detail?: string;
  gate?: StallGate;
}

/**
 * Everything `deriveGateTimeline` needs, already read from records. The reader
 * (`readGateEvidence` in reliability-metrics.ts) does the IO; this module never
 * reads a file and never makes a liveness decision of its own.
 */
export interface GateEvidence {
  /** Non-helper ownership launches, in any order. */
  launches?: GateLaunch[];
  /** Helper launches (`helper:*`); their time ends a review agent's active work. */
  helperLaunches?: Array<{ atMs: number }>;
  stageResults?: GateStageResult[];
  /** The HOK-3101 primitive's agent-own records. */
  agentRecords?: GateAgentRecord[];
  /** When the plan was approved (`.plan-packet-hash.approvedAt` / completed planning result). */
  planApprovalMs?: number | null;
  /** When review completed (review result, head move, or `review_complete` hook). */
  reviewCompleteMs?: number | null;
  /** When Ready completed (`.ready-result.json`, head move, or `ready_complete` hook). */
  readyCompleteMs?: number | null;
  /** Tend's lane entry. */
  laneEnteredMs?: number | null;
  /** When the PR merged (the replay end). */
  mergedMs?: number | null;
  /** Escalation-marker and dirty-tree-handoff spans. */
  attentionSpans?: GateAttentionSpan[];
  /** Records that were looked for and not found, for `unknown` spans. */
  missingRecords?: string[];
}

/** One gate's share of a stall interval. */
export interface GateSplitEntry {
  gate: StallGate;
  stage: StallStage;
  ms: number;
  /** Present on `unknown` entries. */
  missing?: string[];
}

/** The gate decision for one stall interval. */
export interface StallGateDecision {
  gate: StallGate;
  stage: StallStage;
  cause: StallCause;
  causeDetail?: string;
  gateSplit: GateSplitEntry[];
}

function overlapMs(a: { fromMs: number; toMs: number }, b: { fromMs: number; toMs: number }): number {
  return Math.max(0, Math.min(a.toMs, b.toMs) - Math.max(a.fromMs, b.fromMs));
}

function finite(ms: number | null | undefined): ms is number {
  return typeof ms === 'number' && Number.isFinite(ms);
}

/**
 * Derive the coarse cause for a stall interval from concurrent spans.
 *
 * The cause with the most overlap wins if it covers at least 50% of the
 * interval. Ties use the precedence: operator-attention, ci, stage-agent,
 * merge-lane, host-down. If no cause reaches 50%, the cause is `unknown`.
 *
 * Kept for callers of the legacy coarse model; the gate decision below is the
 * one `report-reliability` uses.
 */
export function deriveStallCause(
  interval: { fromMs: number; toMs: number },
  spans: CauseSpan[],
): { cause: StallCause; causeDetail?: string } {
  const duration = Math.max(0, interval.toMs - interval.fromMs);
  if (duration === 0 || spans.length === 0) {
    return { cause: 'unknown' };
  }

  const precedence: StallCause[] = ['operator-attention', 'ci', 'stage-agent', 'merge-lane', 'host-down'];
  let best: { cause: StallCause; overlap: number; detail?: string } = { cause: 'unknown', overlap: 0 };

  for (const span of spans) {
    const overlap = overlapMs(interval, span);
    const better =
      overlap > best.overlap ||
      (overlap === best.overlap && overlap > 0 && precedence.indexOf(span.cause) < precedence.indexOf(best.cause));
    if (better) {
      best = { cause: span.cause, overlap, detail: span.detail };
    }
  }

  if (best.overlap >= duration * 0.5) {
    return { cause: best.cause, causeDetail: best.detail };
  }
  return { cause: 'unknown' };
}

/** Sum stalls over 1h by cause. */
export function aggregateStallCauses(
  intervals: Array<{ durationMs: number; cause?: StallCause; causeDetail?: string }>,
): Record<StallCause, { stalls: number; hours: number }> {
  const result = {} as Record<StallCause, { stalls: number; hours: number }>;
  for (const cause of STALL_CAUSES) {
    result[cause] = { stalls: 0, hours: 0 };
  }
  for (const interval of intervals) {
    if (interval.durationMs < 60 * 60 * 1000) continue;
    const cause = interval.cause ?? 'unknown';
    result[cause].stalls += 1;
    result[cause].hours += interval.durationMs / (60 * 60 * 1000);
  }
  return result;
}

// ── Gate timeline ────────────────────────────────────────────────────────────

/** The gate a launch holds, or `null` for a helper launch. */
function launchGate(launch: GateLaunch): { gate: StallGate; stage: StallStage } | null {
  if (launch.kind.startsWith('helper:')) return null;
  switch (launch.kind) {
    case 'planning':
      return { gate: 'planning-agent', stage: 'planning' };
    case 'coding':
      return { gate: 'coding-agent', stage: 'coding' };
    case 'review':
      return { gate: 'review-agent', stage: 'review' };
    case 'ready-remediation':
    case 'conflict-resolution':
    case 'ci-fix':
      return { gate: 'ready-remediation', stage: 'ready' };
    case 'native-arm':
      switch (launch.stage) {
        case 'planning':
          return { gate: 'planning-agent', stage: 'planning' };
        case 'coding':
          return { gate: 'coding-agent', stage: 'coding' };
        case 'review':
          return { gate: 'review-agent', stage: 'review' };
        default:
          return null;
      }
    default:
      return null;
  }
}

function stageGate(stage: GateStageName): { gate: StallGate; stage: StallStage } {
  switch (stage) {
    case 'planning':
      return { gate: 'planning-agent', stage: 'planning' };
    case 'coding':
      return { gate: 'coding-agent', stage: 'coding' };
    case 'review':
      return { gate: 'review-agent', stage: 'review' };
    case 'ready':
      return { gate: 'ready-remediation', stage: 'ready' };
  }
}

/** Stage results are matched to a launch when they started within this slack. */
const RESULT_MATCH_SLACK_MS = 2 * 60_000;

function matchStageResult(
  results: GateStageResult[],
  stage: GateStageName,
  launchMs: number,
  limitMs: number,
): GateStageResult | undefined {
  let best: GateStageResult | undefined;
  let bestDelta = Infinity;
  for (const result of results) {
    if (result.stage !== stage) continue;
    if (result.startedAtMs > limitMs) continue;
    if (result.startedAtMs < launchMs - RESULT_MATCH_SLACK_MS) continue;
    const delta = Math.abs(result.startedAtMs - launchMs);
    if (delta < bestDelta) {
      best = result;
      bestDelta = delta;
    }
  }
  return best;
}

/**
 * The latest review result written at or before `atMs`, when it is parked
 * (`running` / errored / not-ready). A re-review launch reuses the stage result
 * of the run it continues, so the park it describes spans the later windows
 * too. A completed or `ready` result is never inherited.
 */
function inheritedParkedReviewResult(results: GateStageResult[], atMs: number): GateStageResult | undefined {
  let latest: GateStageResult | undefined;
  for (const result of results) {
    if (result.stage !== 'review') continue;
    if (result.startedAtMs > atMs) continue;
    if (latest === undefined || result.startedAtMs > latest.startedAtMs) latest = result;
  }
  if (!latest) return undefined;
  const parked = latest.status !== 'completed' && latest.verdict !== 'ready';
  return parked ? latest : undefined;
}

/** Window boundaries derived from launches (live/archived ownership rows). */
interface RawWindow {
  gate: StallGate;
  stage: StallStage;
  fromMs: number;
  toMs: number;
  launch: GateLaunch;
  result?: GateStageResult;
}

function clampMs(ms: number, startMs: number, endMs: number): number {
  return Math.min(endMs, Math.max(startMs, ms));
}

/**
 * Build the labelled spans for one task from its evidence, from the first
 * launch (or stage result) to the merge.
 *
 * Precedence at any instant: an attention span, then the merge lane, then a
 * stage window, then Ready checks, then `unknown`. Spans are contiguous and
 * non-overlapping.
 */
export function deriveGateTimeline(evidence: GateEvidence, opts: { endMs: number }): GateSpan[] {
  const endMs = opts.endMs;
  if (!finite(endMs)) return [];

  const launches = [...(evidence.launches ?? [])]
    .filter((l) => finite(l.atMs))
    .sort((a, b) => a.atMs - b.atMs);
  const results = [...(evidence.stageResults ?? [])].filter((r) => finite(r.startedAtMs));

  const startCandidates = [
    ...launches.map((l) => l.atMs),
    ...results.map((r) => r.startedAtMs),
  ].filter((ms) => ms <= endMs);
  if (startCandidates.length === 0) return [];
  const startMs = Math.min(...startCandidates);

  const laneEnteredMs: number | null = finite(evidence.laneEnteredMs) ? evidence.laneEnteredMs : null;
  const laneEndMs = finite(evidence.mergedMs) ? evidence.mergedMs : endMs;
  const planApprovalMs: number | null = finite(evidence.planApprovalMs) ? evidence.planApprovalMs : null;
  const readyCompleteMs: number | null = finite(evidence.readyCompleteMs) ? evidence.readyCompleteMs : null;

  // ── Stage windows ──
  const windows: RawWindow[] = [];
  if (launches.length > 0) {
    for (let i = 0; i < launches.length; i++) {
      const launch = launches[i];
      const target = launchGate(launch);
      if (!target) continue;
      const nextStart = launches[i + 1]?.atMs ?? Infinity;
      const launchStage: GateStageName | undefined =
        launch.stage ?? (target.stage === 'unknown' || target.stage === 'merge' ? undefined : target.stage);
      const result = launchStage
        ? (matchStageResult(results, launchStage, launch.atMs, Math.min(nextStart, endMs)) ??
          (target.gate === 'review-agent' ? inheritedParkedReviewResult(results, launch.atMs) : undefined))
        : undefined;
      const finishedMs = result && finite(result.finishedAtMs) ? result.finishedAtMs : Infinity;
      let toMs = Math.min(endMs, nextStart, finishedMs);
      if (target.gate === 'planning-agent' && planApprovalMs !== null) {
        toMs = Math.min(toMs, planApprovalMs);
      }
      if (target.stage === 'ready') {
        // Only a completion *after* this launch ends its window: Ready re-runs
        // after a remediation, so an earlier completion says nothing about it.
        if (readyCompleteMs !== null && readyCompleteMs > launch.atMs) toMs = Math.min(toMs, readyCompleteMs);
        if (laneEnteredMs !== null && laneEnteredMs > launch.atMs) toMs = Math.min(toMs, laneEnteredMs);
      }
      if (toMs <= launch.atMs) continue;
      windows.push({ ...target, fromMs: launch.atMs, toMs, launch, result });
    }
  } else {
    // No ownership rows: fall back to stage-result windows so older tasks are
    // attributed where their results name a stage.
    for (const result of results) {
      const target = stageGate(result.stage);
      const fromMs = result.startedAtMs;
      let toMs = Math.min(endMs, finite(result.finishedAtMs) ? result.finishedAtMs : endMs);
      if (target.stage === 'planning' && planApprovalMs !== null) {
        toMs = Math.min(toMs, planApprovalMs);
      }
      if (target.stage === 'ready') {
        if (readyCompleteMs !== null && readyCompleteMs > fromMs) toMs = Math.min(toMs, readyCompleteMs);
        if (laneEnteredMs !== null && laneEnteredMs > fromMs) toMs = Math.min(toMs, laneEnteredMs);
      }
      if (toMs <= fromMs) continue;
      windows.push({ ...target, fromMs, toMs, launch: { kind: result.stage, atMs: fromMs }, result });
    }
  }

  // ── Agent-waiting attention spans (per window) ──
  const agentRecords = [...(evidence.agentRecords ?? [])]
    .filter((r) => finite(r.atMs))
    .sort((a, b) => a.atMs - b.atMs);
  const attention: GateAttentionSpan[] = [...(evidence.attentionSpans ?? [])]
    .filter((s) => finite(s.fromMs) && finite(s.toMs) && s.toMs > s.fromMs);

  for (let i = 0; i < windows.length; i++) {
    const window = windows[i];
    if (window.gate === 'merge-lane') continue;
    // The agent's last own record at or before the window end, from the
    // previous launch onward, is what the HOK-3101 primitive would report.
    const lowerBound = i > 0 ? windows[i - 1].fromMs : -Infinity;
    let last: GateAgentRecord | undefined;
    for (const record of agentRecords) {
      if (record.atMs <= lowerBound) continue;
      if (record.atMs > window.toMs) break;
      last = record;
    }
    if (!last || !isAgentWaitingState(last.state)) continue;
    // A planning window that ends at plan approval is that approval gate; the
    // dedicated span below carries the more specific reason.
    if (window.gate === 'planning-agent' && planApprovalMs !== null && planApprovalMs > window.fromMs) continue;
    const fromMs = Math.max(window.fromMs, last.atMs);
    if (window.toMs > fromMs) {
      attention.push({ fromMs, toMs: window.toMs, detail: `agent ${last.state}` });
    }
  }

  // ── Plan-approval span (inside a planning window) ──
  // The planning agent parks after presenting the plan; the wait for a person
  // is the approval gate, not the planner.
  if (planApprovalMs !== null) {
    for (const window of windows) {
      if (window.gate !== 'planning-agent') continue;
      if (planApprovalMs < window.fromMs || planApprovalMs > window.toMs) continue;
      let approvalStart = window.toMs;
      for (const record of agentRecords) {
        if (record.atMs < window.fromMs || record.atMs > window.toMs) continue;
        if (isAgentWaitingState(record.state) || record.state === 'idle') approvalStart = record.atMs;
      }
      if (planApprovalMs > approvalStart) {
        attention.push({
          fromMs: approvalStart,
          toMs: planApprovalMs,
          detail: 'plan approval',
          gate: 'plan-approval',
        });
      }
    }
  }

  // ── Merge lane ──
  const laneSpan: GateSpan | null = laneEnteredMs !== null && laneEndMs > laneEnteredMs
    ? { gate: 'merge-lane', stage: 'merge', fromMs: laneEnteredMs, toMs: Math.min(laneEndMs, endMs), detail: 'in merge lane' }
    : null;

  // ── Ready checks (after review, before Ready completes / the lane) ──
  const reviewCompleteMs: number | null = finite(evidence.reviewCompleteMs) ? evidence.reviewCompleteMs : null;
  let readyCheckSpan: GateSpan | null = null;
  if (reviewCompleteMs !== null) {
    const readyEndCandidates: number[] = [readyCompleteMs, laneEnteredMs, endMs].filter(
      (ms): ms is number => ms !== null && ms > reviewCompleteMs,
    );
    const readyEndMs = readyEndCandidates.length > 0 ? Math.min(...readyEndCandidates) : endMs;
    if (readyEndMs > reviewCompleteMs) {
      readyCheckSpan = { gate: 'ready-checks', stage: 'ready', fromMs: reviewCompleteMs, toMs: readyEndMs, detail: 'ready checks' };
    }
  }

  // ── Review park (the second part of a review window) ──
  const reviewParkSpans: GateSpan[] = [];
  const reviewWindows = windows.filter((w) => w.gate === 'review-agent');
  for (const window of reviewWindows) {
    if (window.result == null) continue;
    const verdict = window.result.verdict;
    const parked = window.result.status !== 'completed' && verdict !== 'ready';
    if (!parked) continue;
    let lastActivityMs = window.fromMs;
    for (const record of agentRecords) {
      if (record.atMs >= window.fromMs && record.atMs <= window.toMs) lastActivityMs = Math.max(lastActivityMs, record.atMs);
    }
    for (const helper of evidence.helperLaunches ?? []) {
      if (!finite(helper.atMs)) continue;
      if (helper.atMs >= window.fromMs && helper.atMs <= window.toMs) lastActivityMs = Math.max(lastActivityMs, helper.atMs);
    }
    if (lastActivityMs < window.toMs) {
      reviewParkSpans.push({
        gate: 'review-park',
        stage: 'review',
        fromMs: lastActivityMs,
        toMs: window.toMs,
        detail: 'review parked',
      });
    }
  }

  // ── Boundary walk with precedence ──
  const boundaries = new Set<number>([startMs, endMs]);
  const addBoundaries = (span: { fromMs: number; toMs: number }) => {
    const from = clampMs(span.fromMs, startMs, endMs);
    const to = clampMs(span.toMs, startMs, endMs);
    if (to <= from) return;
    boundaries.add(from);
    boundaries.add(to);
  };
  for (const span of attention) addBoundaries(span);
  for (const span of windows) addBoundaries(span);
  for (const span of reviewParkSpans) addBoundaries(span);
  if (laneSpan) addBoundaries(laneSpan);
  if (readyCheckSpan) addBoundaries(readyCheckSpan);

  const points = [...boundaries].sort((a, b) => a - b);
  const priority = (gate: StallGate): number => {
    const idx = GATE_PRECEDENCE.indexOf(gate);
    return idx === -1 ? GATE_PRECEDENCE.length : idx;
  };

  const picked: Array<{ gate: StallGate; stage: StallStage; fromMs: number; toMs: number; detail?: string }> = [];
  for (let i = 0; i < points.length - 1; i++) {
    const fromMs = points[i];
    const toMs = points[i + 1];
    if (toMs <= fromMs) continue;
    const probe = { fromMs, toMs };
    const candidates: Array<{ gate: StallGate; stage: StallStage; detail?: string; rank: number }> = [];
    const consider = (gate: StallGate, stage: StallStage, detail?: string) => {
      candidates.push({ gate, stage, detail, rank: priority(gate) });
    };
    for (const span of attention) {
      if (overlapMs(probe, span) > 0) {
        consider(span.gate ?? 'operator-attention', spanStageForAttention(span, windows), span.detail);
      }
    }
    if (laneSpan && overlapMs(probe, laneSpan) > 0) consider(laneSpan.gate, laneSpan.stage, laneSpan.detail);
    for (const span of reviewParkSpans) {
      if (overlapMs(probe, span) > 0) consider(span.gate, span.stage, span.detail);
    }
    for (const window of windows) {
      if (overlapMs(probe, window) > 0) consider(window.gate, window.stage);
    }
    if (readyCheckSpan && overlapMs(probe, readyCheckSpan) > 0) {
      consider(readyCheckSpan.gate, readyCheckSpan.stage, readyCheckSpan.detail);
    }
    if (candidates.length === 0) {
      picked.push({ gate: 'unknown', stage: 'unknown', fromMs, toMs });
      continue;
    }
    candidates.sort((a, b) => a.rank - b.rank);
    const winner = candidates[0];
    picked.push({
      gate: winner.gate,
      stage: winner.stage,
      fromMs,
      toMs,
      ...(winner.detail ? { detail: winner.detail } : {}),
    });
  }

  // Merge contiguous spans with the same gate.
  const merged: GateSpan[] = [];
  for (const span of picked) {
    const last = merged[merged.length - 1];
    if (last && last.gate === span.gate && last.stage === span.stage && last.toMs === span.fromMs) {
      last.toMs = span.toMs;
      continue;
    }
    merged.push({ ...span });
  }

  const missing = evidence.missingRecords ?? [];
  if (missing.length > 0) {
    for (const span of merged) {
      if (span.gate === 'unknown') span.missing = [...missing];
    }
  }
  return merged;
}

/** The stage an attention span belongs to, from the window it sits inside. */
function spanStageForAttention(span: { fromMs: number; toMs: number }, windows: RawWindow[]): StallStage {
  let best: RawWindow | null = null;
  let bestOverlap = 0;
  for (const window of windows) {
    const overlap = overlapMs(span, window);
    if (overlap > bestOverlap) {
      best = window;
      bestOverlap = overlap;
    }
  }
  return best ? best.stage : 'unknown';
}

// ── Per-interval gate decision ───────────────────────────────────────────────

/**
 * Split a stall interval across the gate timeline. The gate with the most
 * overlap is the interval's gate (ties follow {@link GATE_PRECEDENCE}); the
 * split divides the duration by overlap, so gate hours sum to total stuck
 * hours.
 */
export function deriveStallGate(
  interval: { fromMs: number; toMs: number },
  spans: GateSpan[],
): StallGateDecision {
  const duration = Math.max(0, interval.toMs - interval.fromMs);
  if (duration === 0) {
    return { gate: 'unknown', stage: 'unknown', cause: 'unknown', gateSplit: [] };
  }

  const byGate = new Map<StallGate, GateSplitEntry>();
  let primaryDetail: string | undefined;
  for (const span of spans) {
    const overlap = overlapMs(interval, span);
    if (overlap <= 0) continue;
    const existing = byGate.get(span.gate);
    if (existing) {
      existing.ms += overlap;
      if (span.missing) existing.missing = [...(existing.missing ?? []), ...span.missing];
    } else {
      byGate.set(span.gate, {
        gate: span.gate,
        stage: span.stage,
        ms: overlap,
        ...(span.missing ? { missing: [...span.missing] } : {}),
      });
    }
  }

  const entries = [...byGate.values()].sort((a, b) => {
    if (b.ms !== a.ms) return b.ms - a.ms;
    return GATE_PRECEDENCE.indexOf(a.gate) - GATE_PRECEDENCE.indexOf(b.gate);
  });
  if (entries.length === 0) {
    return { gate: 'unknown', stage: 'unknown', cause: 'unknown', gateSplit: [{ gate: 'unknown', stage: 'unknown', ms: duration }] };
  }

  const primary = entries[0];
  for (const span of spans) {
    if (span.gate !== primary.gate) continue;
    if (overlapMs(interval, span) > 0 && span.detail) {
      primaryDetail = span.detail;
      break;
    }
  }

  return {
    gate: primary.gate,
    stage: primary.stage,
    cause: GATE_TO_CAUSE[primary.gate],
    ...(primaryDetail ? { causeDetail: primaryDetail } : {}),
    gateSplit: entries,
  };
}

// ── Aggregation ──────────────────────────────────────────────────────────────

/** One interval as the gate aggregator sees it. */
export interface StallGateIntervalInput {
  issue?: string;
  durationMs: number;
  gateSplit?: GateSplitEntry[];
  endedByPerson?: boolean;
  /** The interval's off-hours duration. Allocated across gates by split share. */
  offHoursMs?: number;
}

/** Per-gate totals over a set of intervals. */
export interface StallGateAggregate {
  gate: StallGate;
  /** Distinct tasks with a share of stuck time under this gate. */
  tasks: number;
  /** Intervals with a share of stuck time under this gate. */
  intervals: number;
  hours: number;
  /** Intervals whose primary gate this is and which ended with a person acting. */
  endedByPerson: number;
  offHoursHours: number;
  /** Off-hours hours on intervals that ended with a person acting. */
  waitedForPersonHours: number;
  byStage: Partial<Record<StallStage, number>>;
}

/**
 * Aggregate gate splits. Per-gate hours sum to total stuck hours, per-gate
 * off-hours to total off-hours, and `waitedForPersonHours` to the global
 * waited-for-a-person hours.
 */
export function aggregateStallGates(intervals: StallGateIntervalInput[]): StallGateAggregate[] {
  const acc = new Map<StallGate, StallGateAggregate & { taskSet: Set<string> }>();
  for (const gate of STALL_GATES) {
    acc.set(gate, {
      gate,
      tasks: 0,
      intervals: 0,
      hours: 0,
      endedByPerson: 0,
      offHoursHours: 0,
      waitedForPersonHours: 0,
      byStage: {},
      taskSet: new Set<string>(),
    });
  }

  for (const interval of intervals) {
    const duration = Math.max(0, interval.durationMs);
    if (duration === 0) continue;
    const splits = interval.gateSplit ?? [];
    const offHours = interval.offHoursMs ?? 0;
    // The interval's gate is the split with the most time, ties by precedence —
    // the same rule `deriveStallGate` applies, for callers that did not sort.
    let primary: GateSplitEntry | null = null;
    for (const split of splits) {
      if (split.ms <= 0) continue;
      if (
        primary === null ||
        split.ms > primary.ms ||
        (split.ms === primary.ms && GATE_PRECEDENCE.indexOf(split.gate) < GATE_PRECEDENCE.indexOf(primary.gate))
      ) {
        primary = split;
      }
    }
    for (const split of splits) {
      if (split.ms <= 0) continue;
      const row = acc.get(split.gate);
      if (!row) continue;
      const share = split.ms / duration;
      row.hours += split.ms / (60 * 60 * 1000);
      row.intervals += 1;
      row.offHoursHours += (offHours * share) / (60 * 60 * 1000);
      if (interval.endedByPerson) row.waitedForPersonHours += (offHours * share) / (60 * 60 * 1000);
      if (split.stage !== 'unknown') {
        row.byStage[split.stage] = (row.byStage[split.stage] ?? 0) + split.ms / (60 * 60 * 1000);
      }
      if (interval.issue) row.taskSet.add(interval.issue);
    }
    if (primary !== null && interval.endedByPerson) {
      const row = acc.get(primary.gate);
      if (row) row.endedByPerson += 1;
    }
  }

  return STALL_GATES.map((gate) => {
    const row = acc.get(gate)!;
    const { taskSet, ...rest } = row;
    return { ...rest, tasks: taskSet.size > 0 ? taskSet.size : rest.intervals > 0 ? rest.intervals : 0 };
  });
}
