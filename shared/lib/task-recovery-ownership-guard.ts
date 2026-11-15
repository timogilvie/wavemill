// allow-task-recovery-ownership: this file *is* the task-recovery-ownership
// guard; its pattern table names every forbidden shape. It is auto-excluded
// from its own scan (see invariantPaths); the marker above is defensive.
/**
 * Preflight guard for the one-task-recovery-controller invariant (HOK-3277).
 *
 * "This attempt is stuck / its stage exited / its result is waiting — what
 * happens next, and who claims it?" has one answer: the canonical controller
 * `task-recovery-controller.ts` (`decideTaskRecovery` for the decision,
 * `claimRecoveryAction` for the atomic claim). The failure authority
 * (`failure-policy.ts`), the retry budget (`bounded-retry.*`), the in-flight/
 * settled read (`stage-agent-disposition.ts`), the execution-contract replay
 * (`execution-contract.ts`), settlement (`task-settlement.ts`) and the one
 * escalation step (`operator-escalation.*`) remain the controller's delegates.
 * The monitor's shell seams (`maybe_retry_failed_stage`, `_stage_disposition_act`,
 * `ready_failure_classify_and_act`) are the controller's first adapters and
 * compose those same authorities; they are not a second policy.
 *
 * This guard fails on the two shapes that would answer it a second way:
 *
 * 1. `recovery-decider` — a new TypeScript recovery decider declared outside
 *    the controller (`function`/`const` named `decide<...>Recovery`). Author
 *    the decision in `decideTaskRecovery`, never a parallel ranker.
 * 2. `recovery-claim-writer` — writing the `.recovery-claim.json` seam outside
 *    the controller. Claim through `claimRecoveryAction`, whose atomic
 *    compare-and-set makes concurrent notifications collapse to one dispatch.
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

export const TASK_RECOVERY_OWNERSHIP_GUARD: GuardSpec = {
  name: 'task-recovery-ownership',
  invariantDocs: ['docs/invariants/task-recovery-ownership.md'],
  findingNoun: 'task-recovery ownership bypass(es)',
  suppressionMarker: 'allow-task-recovery-ownership',
  allowlistFile: 'tools/task-recovery-ownership-allowlist.txt',
  invariantPaths: [
    'shared/lib/task-recovery-controller.ts',
    'shared/lib/task-recovery-ownership-guard.ts',
  ],
  patterns: [
    {
      name: 'recovery-decider',
      description:
        'a recovery decider declared outside the controller — author task recovery decisions in task-recovery-controller.ts (decideTaskRecovery), not a parallel ranker',
      lang: 'ts',
      re: /\b(?:export\s+)?(?:async\s+)?(?:function|const|let|var)\s+decide[A-Za-z0-9_]*Recovery\b/,
    },
    {
      name: 'recovery-claim-writer',
      description:
        'the .recovery-claim.json seam written outside the controller — claim through claimRecoveryAction so concurrent notifications collapse to one dispatch',
      lang: 'both',
      re: /\.recovery-claim\.json/,
    },
  ],
  remediation: [
    'Task recovery is one control path (HOK-3277): decide through decideTaskRecovery',
    'and claim through claimRecoveryAction in shared/lib/task-recovery-controller.ts.',
    'Delegate classification to failure-policy.ts, the retry budget to bounded-retry,',
    'liveness to stage-agent-disposition.ts, and escalation to operator-escalation.',
  ],
};
