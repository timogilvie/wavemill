import { readFileSync } from 'node:fs';
import type { SelectedAdjudicatedPair, PairSelectionLedger } from '../swap-test/pair-selection.ts';
import { selectAdjudicatedPairs } from '../swap-test/pair-selection.ts';
import { readEvalRowsForPairs } from '../swap-test/strata.ts';
import { readJsonlFile } from '../jsonl-utils.ts';
import type { StoredChallengeComparison } from '../challenge-comparison.ts';

/**
 * Encapsulates the pair context used by both Probe B and Probe C.
 * Wraps swap-test helpers to ensure pair selection and eval lookup are identical.
 */
export interface PairContext {
  pairs: SelectedAdjudicatedPair[];
  evalIndex: Map<string, { record: any; provenance: string }>;
  ledger: PairSelectionLedger;
}

/**
 * Load pair context by reading challenge records, selecting adjudicated pairs,
 * and building the eval index.
 *
 * @param recordsPath Path to challenge-records.jsonl
 * @param evalsDir Directory containing evals.jsonl
 * @returns PairContext with pairs, eval index, and selection ledger
 */
export async function loadPairContext(
  recordsPath: string,
  evalsDir: string,
): Promise<PairContext> {
  // Read challenge records and select adjudicated pairs.
  const records = await readJsonlFile<StoredChallengeComparison>(recordsPath);
  const { pairs, ledger } = selectAdjudicatedPairs(records);

  // Read eval rows and build index.
  const evalIndex = readEvalRowsForPairs(evalsDir);

  return { pairs, evalIndex, ledger };
}
