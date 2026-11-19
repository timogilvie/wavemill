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
 * This guard fails on the shapes that would answer it a second way:
 *
 * 1. `recovery-decider` — a new TypeScript recovery decider declared outside
 *    the controller (`function`/`const` named `decide<...>Recovery`). Author
 *    the decision in `decideTaskRecovery`, never a parallel ranker.
 * 2. `recovery-claim-writer` — writing the `.recovery-claim.json` seam outside
 *    the controller. Claim through `claimRecoveryAction`, whose atomic
 *    compare-and-set makes concurrent notifications collapse to one dispatch.
 * 3. `observer-auto-fix-import` — re-importing the deleted Observer repair
 *    engine (HOK-3406). Observer is evidence-only.
 * 4. `observer-repair-bucket` — recreating Observer's private retry buckets
 *    (`observer-update-branch`, `observer-ready-budget-reset`,
 *    `observer-forfeit-arm`). Retries belong to `bounded-retry`; repairs to the
 *    controller.
 * 5. `observer-executor-call` — `tools/observer.ts` calling a repair executor
 *    directly instead of emitting evidence for the controller.
 * 6. `observer-autofix-surface` — the removed auto-fix configuration/flag
 *    surface returning to `tools/observer.ts`.
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
    { name: 'unproduced-contract-wait', lang: 'both', re: /execution-contract-available/,
      description: 'saved-route refusals cannot wait for an unproduced contract wake' },
    { name: 'private-contract-refusal-stop', lang: 'both', re: /stopReason\s*[:=]\s*["']recovery_contract_unavailable["']/,
      description: 'saved-route refusals must use the claimed escalation, not a stopped-state write' },
    {
      name: 'observer-auto-fix-import',
      description:
        'the deleted Observer auto-fix engine (HOK-3406) cannot be re-imported — Observer is evidence-only; repair belongs to the recovery controller',
      lang: 'ts',
      re: /\bobserver-auto-fix\b/,
    },
    {
      name: 'observer-repair-bucket',
      description:
        'Observer private repair buckets are deleted (HOK-3406) — count retries through bounded-retry and decide repairs in the recovery controller',
      lang: 'both',
      re: /\bobserver-(?:update-branch|ready-budget-reset|forfeit-arm)\b/,
    },
    {
      name: 'observer-executor-call',
      description:
        'tools/observer.ts may not call a repair executor directly (HOK-3406) — emit evidence / request reconciliation and let the recovery controller execute',
      lang: 'ts',
      re: /\b(?:updateBranchWithBase|abortTaskInState|recordArmTermination|createStateDirRetry|runObserverAutoFixes)\s*\(/,
      scopedPaths: ['tools/observer.ts'], // install-paths: allow guard scope, not an argv target
    },
    {
      name: 'observer-autofix-surface',
      description:
        'the removed observer.autoFix configuration and --autofix-dry-run flag surface cannot return (HOK-3406)',
      lang: 'ts',
      re: /autoFixDryRun|getObserverAutoFixConfig|ObserverAutoFixConfig/,
      scopedPaths: ['tools/observer.ts'], // install-paths: allow guard scope, not an argv target
    },
  ],
  remediation: [
    'Task recovery is one control path (HOK-3277): decide through decideTaskRecovery',
    'and claim through claimRecoveryAction in shared/lib/task-recovery-controller.ts.',
    'Delegate classification to failure-policy.ts, the retry budget to bounded-retry,',
    'liveness to stage-agent-disposition.ts, and escalation to operator-escalation.',
  ],
};
