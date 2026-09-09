import type { ArbiterSurvivalLabelV1, HorizonDays } from '../arbiter-survival-label.ts';
import { readJsonlFile } from '../jsonl-utils.ts';

/**
 * Load survival labels from JSONL, deduplicated by (prUrl, horizon_days) with
 * latest computed_at winning (per the contract's dedup rule).
 *
 * Returns a nested map: prUrl -> horizon -> label.
 * Missing horizons or missing labels entirely are not stored (caller checks for undefined).
 */
export async function loadSurvivalLabelsByPrUrl(
  path: string,
): Promise<Map<string, Map<HorizonDays, ArbiterSurvivalLabelV1>>> {
  const result = new Map<string, Map<HorizonDays, ArbiterSurvivalLabelV1>>();

  const rows = await readJsonlFile<ArbiterSurvivalLabelV1>(path);
  for (const label of rows) {
    if (!label.prUrl || !label.horizon_days) {
      continue;
    }

    // Deduplicate by (prUrl, horizon_days) keeping latest computed_at.
    if (!result.has(label.prUrl)) {
      result.set(label.prUrl, new Map());
    }
    const horizonMap = result.get(label.prUrl)!;
    const existing = horizonMap.get(label.horizon_days);

    // Newest computed_at wins.
    if (!existing || (label.envelope.computed_at && existing.envelope.computed_at && label.envelope.computed_at > existing.envelope.computed_at)) {
      horizonMap.set(label.horizon_days, label);
    }
  }

  return result;
}

/**
 * Look up a specific survival label for a PR at a given horizon.
 * Returns undefined if the label is not present or if the horizon is missing.
 */
export function getSurvivalLabel(
  map: Map<string, Map<HorizonDays, ArbiterSurvivalLabelV1>>,
  prUrl: string,
  horizon: HorizonDays,
): ArbiterSurvivalLabelV1 | undefined {
  return map.get(prUrl)?.get(horizon);
}
