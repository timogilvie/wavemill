/**
 * Preflight guard for the condition-keyed marker invariant (HOK-3172),
 * extended for the eval-failure decision record (HOK-3452).
 *
 * `.eval-failure-decision.json` is a reconciled marker: it may only be written
 * through `marker_write` (via `eval_failure_decision_record`) and only read
 * through `eval_failure_decision_current`, which applies the marker's head and
 * runId condition. A raw write bypasses `--expires-on`; a raw read bypasses the
 * condition, so a decision from an earlier head or attempt can be acted on
 * after its evidence is gone (the defect HOK-3452 fixes).
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

export const CONDITION_MARKERS_GUARD: GuardSpec = {
  name: 'condition-markers',
  invariantDocs: ['docs/invariants/condition-markers.md'],
  findingNoun: 'private eval-failure-decision marker access(es)',
  suppressionMarker: 'allow-condition-markers',
  allowlistFile: 'tools/condition-markers-allowlist.txt',
  invariantPaths: [
    'shared/lib/wavemill-common.sh',
    'shared/lib/condition-reconciler.sh',
    'shared/lib/condition-markers-guard.ts',
    'tools/check-condition-markers.ts', // install-paths: allow invariantPaths list, not an argv target
  ],
  patterns: [
    {
      name: 'raw-eval-failure-decision-write',
      description:
        'raw write of .eval-failure-decision.json — write it through eval_failure_decision_record / marker_write so it carries a head condition and expires',
      lang: 'both',
      re: /(?=.*\.eval-failure-decision\.json)(?=.*(?:\btee\b|writeFileSync|>>?|\bprintf\b|\becho\b))/,
    },
    {
      name: 'private-eval-failure-decision-read',
      description:
        'direct read of .eval-failure-decision.json — read it through eval_failure_decision_current so a stale head/runId decision is never applied',
      lang: 'both',
      re: /\.eval-failure-decision\.json/,
    },
  ],
  remediation: [
    'The eval-failure decision is a condition-keyed marker (HOK-3172/HOK-3452).',
    'Write it only through eval_failure_decision_record (which calls marker_write',
    'with --head and --expires-on head,operator-event), and read it only through',
    'eval_failure_decision_current, which returns it only while its head and',
    'runId still describe the current attempt.',
  ],
};
