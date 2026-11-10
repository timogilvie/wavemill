/**
 * HOK-3455 — derive the cause of a stall interval from existing records.
 *
 * Pure reporting helper: no markers, flags, or stored durations.
 */

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

/** A span of time with a known cause. */
export interface CauseSpan {
  cause: StallCause;
  fromMs: number;
  toMs: number;
  detail?: string;
}

function overlapMs(a: { fromMs: number; toMs: number }, b: { fromMs: number; toMs: number }): number {
  return Math.max(0, Math.min(a.toMs, b.toMs) - Math.max(a.fromMs, b.fromMs));
}

/**
 * Derive the cause for a stall interval from concurrent spans.
 *
 * The cause with the most overlap wins if it covers at least 50% of the
 * interval. Ties use the precedence: operator-attention, ci, stage-agent,
 * merge-lane, host-down. If no cause reaches 50%, the cause is `unknown`.
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