import type { ProportionInterval } from '../stats-utils.ts';
import { wilsonInterval } from '../stats-utils.ts';

/**
 * Cell for arbitrary success/total buckets (e.g., agreement rate, disagreement rate).
 * Mirrors FlipCell shape but parametrized to avoid coupling with swap-test/report.ts.
 */
export interface SuccessCell {
  n: number;
  successes: number;
  rate: number | null;
  ci95: ProportionInterval;
  excludedFromStratifiedAnalysis?: boolean;
}

/**
 * Group pairs into cells by key function, aggregating successes into a rate.
 * Sorts output keys alphabetically to ensure deterministic ordering.
 *
 * @param pairs Array of items to group
 * @param key Function mapping each item to its stratum key
 * @param isSuccess Function determining if an item counts as a success
 * @returns Record mapping stratum keys to SuccessCell aggregates
 */
export function groupSuccessCells<T>(
  pairs: T[],
  key: (pair: T) => string,
  isSuccess: (pair: T) => boolean,
): Record<string, SuccessCell> {
  const grouped = new Map<string, T[]>();
  for (const pair of pairs) {
    const value = key(pair);
    grouped.set(value, [...(grouped.get(value) ?? []), pair]);
  }

  const result: Record<string, SuccessCell> = {};
  for (const [name, group] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const successes = group.filter(isSuccess).length;
    const interval = wilsonInterval(successes, group.length);
    result[name] = {
      n: group.length,
      successes,
      rate: interval.p,
      ci95: interval,
    };
  }
  return result;
}

/**
 * Create a cell from a pre-computed count and total.
 * Useful for aggregates where the grouping is done elsewhere.
 */
export function createCell(successes: number, n: number): SuccessCell {
  const interval = wilsonInterval(successes, n);
  return {
    n,
    successes,
    rate: interval.p,
    ci95: interval,
  };
}
