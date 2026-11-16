// allow-queue-state: this file *is* the queue-state guard; its pattern names
// the forbidden shape. It is auto-excluded from its own scan (see
// invariantPaths); the marker above is defensive.
/**
 * Preflight guard for the queue-state vocabulary invariant (HOK-3453,
 * enforced by HOK-3236): every Ready `queueState` the monitor writes is one of
 * `MERGE_QUEUE_STATES` in `shared/lib/merge-queue.ts`.
 *
 * The monitor is the only writer and writes from jq. A value outside the
 * declared list is how `merge-needed` came to live outside both TypeScript
 * unions, so readers silently treated it as "not in the lane".
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';
import { MERGE_QUEUE_STATES } from './merge-queue.ts';

const declaredValues = MERGE_QUEUE_STATES.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

/**
 * A shell/jq literal assignment to `queueState` (`queueState: "x"`,
 * `queueState:"x"`, `"queueState":"x"`, optionally with escaped quotes) whose
 * value is not declared. `null` (removal) and computed values are not literals
 * and never match.
 */
export const UNDECLARED_QUEUE_STATE_WRITE = new RegExp(
  `\\bqueueState\\\\?"?\\s*:\\s*\\\\?"(?!(?:${declaredValues})\\\\?")`,
);

export const QUEUE_STATE_GUARD: GuardSpec = {
  name: 'queue-state',
  invariantDocs: ['docs/invariants/queue-state.md'],
  findingNoun: 'undeclared queueState write(s)',
  suppressionMarker: 'allow-queue-state',
  allowlistFile: 'tools/queue-state-allowlist.txt',
  invariantPaths: [
    'shared/lib/merge-queue.ts',
    'shared/lib/queue-state-guard.ts',
  ],
  patterns: [
    {
      name: 'sh-undeclared-queue-state-write',
      description: `shell/jq write of a queueState value outside MERGE_QUEUE_STATES (${MERGE_QUEUE_STATES.join(', ')})`,
      lang: 'sh',
      re: UNDECLARED_QUEUE_STATE_WRITE,
    },
  ],
  remediation: [
    'Ready queueState values are declared once, in shared/lib/merge-queue.ts (MERGE_QUEUE_STATES),',
    'and mirrored by the artifacts.queueState enum in shared/schemas/stage-result.schema.json.',
    'A new value is added to both, and every reader decides it by name through mergeLanePosition.',
    'Remove a value with `queueState: null`; never write an undeclared literal.',
  ],
};
