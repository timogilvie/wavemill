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
 * 7. `contract-refusal-private-stop` — a private `stopped` /
 *    `stopReason = recovery_contract_unavailable` write or raw `blocked` hook
 *    for a refused saved route (HOK-3512). A refusal reaches the controller,
 *    which escalates through failure-policy and the one escalation step.
 * 8. `recovery-wakeless-wait` (TASK_RECOVERY_WAKE_GUARD) — a controller
 *    `wait` whose wake names no producer in {@link RECOVERY_WAKE_PRODUCERS}
 *    (HOK-3512: `execution-contract-available` had none, so the hold was
 *    silent and permanent).
 */
import type { GuardSpec, StructuralMatch } from '../../tools/lib/source-guard.ts';

/**
 * Every wake a controller `wait` may name, and what produces it. A wait whose
 * wake nothing produces never resolves, so adding a wake means naming the
 * producer here (HOK-3512).
 */
export const RECOVERY_WAKE_PRODUCERS: Readonly<Record<string, string>> = Object.freeze({
  'attempt-identity-resolved': 'shared/lib/task-recovery-controller.ts — reconcileAndRecover re-reads the task run on every notification',
  'stage-identity-resolved': 'shared/lib/task-recovery-controller.ts — reconcileAndRecover re-reads the stage result run identity on every notification',
  'background-work-complete': 'shared/lib/stage-agent-disposition.ts — waitingOn clears when the background job settles',
  'operator-release': 'shared/lib/attention.ts — the operator answers the attention item (plan approval / release)',
  'failure-classified': 'shared/lib/wavemill-monitor.sh — stage_failure_decision classifies the failed stage on the next pass',
  'backoff-elapsed': 'shared/lib/bounded-retry.sh — the bounded-retry backoff window elapses',
});

/** `wake: '<x>'` literals (including ternary alternatives, never a compared operand) on one line. */
export function findUnproducedWakes(source: string): StructuralMatch[] {
  const matches: StructuralMatch[] = [];
  source.split('\n').forEach((line, index) => {
    const at = line.search(/\bwake\s*:/);
    if (at < 0) return;
    const tail = line.slice(at).replace(/^wake\s*:/, '').split(/[,}]/)[0] ?? '';
    for (const literal of tail.matchAll(/(?<![=!]=\s*|[=!]==\s*)['"]([a-z][a-z0-9-]*)['"]/g)) {
      const wake = literal[1]!;
      if (!Object.hasOwn(RECOVERY_WAKE_PRODUCERS, wake)) {
        matches.push({ line: index + 1, detail: `wake '${wake}' has no producer` });
      }
    }
  });
  return matches;
}

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
    {
      name: 'contract-refusal-private-stop',
      description:
        'a private stop for a refused saved route (HOK-3512) — hand the validator result to the recovery controller (_recovery_contract_refused), which escalates through failure-policy and escalate_operator_attention',
      lang: 'both',
      re: /stopReason["']?\s*[:=]\s*["']recovery_contract_unavailable|wavemill_hook_write\s+["']?blocked["']?\s+["']?recovery_contract_unavailable/,
    },
  ],
  remediation: [
    'Task recovery is one control path (HOK-3277): decide through decideTaskRecovery',
    'and claim through claimRecoveryAction in shared/lib/task-recovery-controller.ts.',
    'Delegate classification to failure-policy.ts, the retry budget to bounded-retry,',
    'liveness to stage-agent-disposition.ts, and escalation to operator-escalation.',
  ],
};

/**
 * HOK-3512: the controller is the invariant source of the ownership guard (so
 * never scanned there); this companion spec scans it for wakes with no
 * producer.
 */
export const TASK_RECOVERY_WAKE_GUARD: GuardSpec = {
  name: 'task-recovery-wake',
  invariantDocs: ['docs/invariants/task-recovery-ownership.md'],
  findingNoun: 'recovery wait(s) on a wake nothing produces',
  suppressionMarker: 'allow-task-recovery-wake',
  allowlistFile: 'tools/task-recovery-ownership-allowlist.txt',
  invariantPaths: ['shared/lib/task-recovery-ownership-guard.ts'],
  patterns: [],
  structuralChecks: [{
    name: 'recovery-wakeless-wait',
    description: 'a controller wait on a wake nothing produces — name its producer in RECOVERY_WAKE_PRODUCERS, or return a control-bearing action (escalate) instead',
    paths: ['shared/lib/task-recovery-controller.ts'],
    find: findUnproducedWakes,
  }],
  remediation: [
    'A recovery wait must name a wake something produces (HOK-3512). A condition',
    'only a human or Hokusai can change (a refused saved route) escalates through',
    'failure-policy and escalate_operator_attention instead of waiting.',
  ],
};
