/**
 * Preflight guard for the native harness deadline invariant (HOK-3382).
 *
 * The model-time budget (`maxModelTimeMs`, kind `model_time`) is the loop's
 * only clock; it charges model-attributable time and pauses while a harness
 * tool executes, so it cannot bound a wedged tool. A hung harness is the
 * recovery controller's: it reassesses a stalled native stage from the shared
 * progress clock and classifies an open tool call as `harness-fault`. This
 * guard fails on the two shapes that would re-create a private timer:
 *
 *   1. the retired `wall_clock` budget spellings, which misname what the
 *      budget measures (only the legacy normalizer and the identity-hashed
 *      certification artifacts may keep them);
 *   2. an elapsed-since-start comparison or an abort timer inside a native
 *      stage file.
 *
 * Per-call tool/process timeouts are explicitly allowed by the invariant;
 * occurrences that are genuinely per-call get a reasoned allowlist entry.
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

export const NATIVE_HARNESS_DEADLINE_GUARD: GuardSpec = {
  name: 'native-harness-deadlines',
  invariantDocs: ['docs/invariants/native-harness-deadlines.md'],
  findingNoun: 'private native harness deadline(s)',
  suppressionMarker: 'allow-native-harness-deadline',
  allowlistFile: 'tools/native-harness-deadline-allowlist.txt',
  invariantPaths: [
    'shared/lib/native-harness-deadline-guard.ts',
    'tools/check-native-harness-deadlines.ts',
  ],
  patterns: [
    {
      name: 'legacy-wall-clock-budget',
      description:
        'misleading wall-clock budget spelling — the budget measures model time (`maxModelTimeMs` / `model_time` / `model_time_limit`). Only the legacy normalizer and the certification artifact boundary may hold it (HOK-3382)',
      lang: 'both',
      re: /\bmaxWallClockMs\b|\bwall_clock_limit\b|['"]wall_clock['"]/,
      scopedPaths: ['shared/lib/native-agent/', 'shared/lib/native-expansion.ts', 'tools/native-'],
    },
    {
      name: 'elapsed-stage-deadline',
      description:
        'private elapsed-time stage deadline — the model-time budget is the loop clock and a stalled harness is reassessed by the recovery controller (`decideTaskRecovery` rule 4a). Per-call tool/process timeouts are allowed (HOK-3382)',
      lang: 'both',
      re: /Date\.now\(\)\s*-\s*\w+\s*[<>]=?|millClockNowMs\(\)\s*-\s*\w+\s*[<>]|AbortSignal\.timeout\(|setTimeout\([^;]*\babort/,
      scopedPaths: ['shared/lib/native-agent/', 'shared/lib/native-expansion.ts', 'tools/native-'],
    },
  ],
  remediation: [
    'A native stage must not carry a private deadline for harness time (HOK-3382).',
    'The model-time budget (`maxModelTimeMs`, kind `model_time`) bounds model time and',
    'pauses while a harness tool executes; a hung tool is detected by the recovery',
    'controller from the shared progress clock (`task-progress.ts`) and retried through',
    '`stage-failure-<stage>` as `harness-fault`. Per-call tool/process timeouts are',
    'allowed — record one with a reasoned allowlist entry, never a stage timer.',
  ],
};
