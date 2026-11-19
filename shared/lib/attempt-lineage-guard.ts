// allow-attempt-lineage: this file *is* the attempt-lineage guard; its
// pattern table names every forbidden shape. It is auto-excluded from its own
// scan (see invariantPaths); the marker above is defensive.
/**
 * Preflight guard for the attempt-lineage invariant (HOK-3476).
 *
 * "Which SDK `task_attempt/v1` run/stage-attempt is this?" has exactly one
 * answer: a record minted and validated by `shared/lib/attempt-identity.ts`
 * (`projectRunAttempt` / `projectStageAttempt` / `taskAttemptRef`). This
 * guard fails on the shapes that used to answer it a second way:
 *
 * 1. A hand-built `TaskAttemptRef`-shaped object literal (`task_id` + `run_id`
 *    keys) outside the canonical module — a bypass writer constructing the
 *    identity itself instead of calling the projector.
 * 2. A bare `retry_of`/`retryOf` assignment outside the canonical module —
 *    retry edges are never inferred from a timestamp, head or session; only
 *    `attempt-identity.ts` may decide one, from a caller-supplied sibling id.
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

export const ATTEMPT_LINEAGE_GUARD: GuardSpec = {
  name: 'attempt-lineage',
  invariantDocs: ['docs/invariants/attempt-lineage.md'],
  findingNoun: 'attempt-lineage violation(s)',
  suppressionMarker: 'allow-attempt-lineage',
  allowlistFile: 'tools/attempt-lineage-allowlist.txt',
  invariantPaths: [
    'shared/lib/attempt-identity.ts',
    'shared/lib/attempt-identity.sh',
    'shared/lib/attempt-lineage-guard.ts',
    'shared/lib/sdk-task-cost/contract.ts',
  ],
  patterns: [
    {
      name: 'hand-built-attempt-ref',
      description: 'TaskAttemptRef-shaped object literal built by hand — use taskAttemptRef()/projectRunAttempt()/projectStageAttempt() in attempt-identity.ts',
      lang: 'ts',
      re: /\{\s*task_id\s*:[^}]*\brun_id\s*:/,
    },
    {
      name: 'retry-of-literal',
      description: 'retry_of/retryOf assigned outside attempt-identity.ts — a retry edge is never inferred; only the projector may set it, from a caller-supplied sibling id. (The projector\'s own retryOfRunId/retryOfStageAttemptId call-site parameters are not this shape.)',
      lang: 'ts',
      re: /\bretry_of\s*:|\bretryOf\s*[:=]/,
    },
  ],
  remediation: [
    'Build and validate SDK task_attempt/v1 identity only through',
    'shared/lib/attempt-identity.ts: projectRunAttempt() mints a run, projectStageAttempt()',
    'mints a stage attempt inside it, and taskAttemptRef() builds a TaskAttemptRef from',
    'already-minted ids. Never construct the {task_id, run_id, ...} shape by hand, and',
    'never set retry_of/retryOf outside this module (HOK-3476).',
  ],
};
