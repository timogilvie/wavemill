import type { BudgetExhaustedFact } from './native-agent/budget-exhaustion.ts';
import { canonicalFailureKind } from './failure-policy.ts';

/**
 * Attribution vocabulary for failed arms: which kinds the mill can name, so
 * reliability metrics can assign a fault class. Being in this union does NOT
 * make a kind terminal — whether a failure parks or retries is decided only by
 * `TERMINAL_ALLOWLIST` in `failure-policy.ts` (HOK-3176).
 */
export type ArmFailureKind =
  | 'context-exhausted'
  | 'context-window-exceeded'
  | 'invalid-model-id'
  | 'provider-rate-limited'
  | 'provider-quota-exhausted'
  | 'provider-transient-error'
  | 'provider-credit-exhausted'
  | 'provider-config-error'
  | 'tool-use-unsupported'
  | 'empty-model-turn'
  | 'native-provider-error'
  | 'native-completion-protocol'
  // Typed native stage-failure kinds (HOK-3064). `native-stage-timeout` is the
  // one budget-exhaustion kind for every native stage (HOK-3362); its fault
  // class is derived from the `budgetExhausted` fact, never fixed. Historical
  // spellings (`native-review-timeout`, `planning-turn-limit`) resolve to it
  // through `KIND_ALIASES`. An explicit abort or a policy denial is our own
  // choice and never model signal.
  | 'native-stage-timeout'
  | 'policy-denied'
  | 'cancelled'
  | 'native-unclassified'
  // HOK-3128: the coding agent wrote `.coding-complete` but exited leaving
  // uncommitted output, and the bounded dirty-handoff relaunch was exhausted.
  | 'coding-dirty-handoff'
  // HOK-3128: a tracked no-PR arm showed no agent progress past the stall
  // grace, so the tend gate / resolver retired it to release its sibling.
  | 'sibling-stalled'
  // HOK-3147: a challenge arm's Ready was terminally exhausted while its
  // sibling was green. `ready-exhausted` means real checks stayed red after
  // remediation/rechecks ran out (model-attributable); `ready-transition-failed`
  // means checks passed but a handoff transition (route-stamp, review identity,
  // label, GitHub API) failed; `ready-unattributed` means no typed cause was
  // recorded (update-from-base conflict, missing/unparseable ready result).
  | 'ready-exhausted'
  | 'ready-transition-failed'
  | 'ready-unattributed'
  // HOK-3154: a challenge arm's Ready launch was refused by the review gate
  // (`pending-ready-recheck`) while its sibling was green. The review artifact
  // can never pass the readiness gate, so retiring the arm releases the sibling
  // the same way HOK-3147's ready-exhausted kinds do. `review-malformed-response`
  // and `review-not-ready` are model-attributable (the reviewer delivered output
  // but failed to produce a usable verdict). `review-identity-mismatch` and
  // `review-unattributed` are harness/identity failures that retire the arm as
  // an invalid challenge (no winner; tend's `challenge-void` releases the
  // survivor once the retired PR is closed). `review-no-output` already exists
  // above.
  | 'review-malformed-response'
  | 'review-not-ready'
  | 'review-identity-mismatch'
  | 'review-unattributed'
  // HOK-3156: the arms' routes drifted after sealing (a non-varied role or
  // depth differs) and the one-variable preflight retired the pair before
  // comparison. The harness produced the drift, so no model is forfeited.
  | 'route-drift'
  // HOK-3156: the pre-review one-variable preflight found the arms' launch
  // routes differing beyond the varied stage and collapsed the pair before the
  // varied stage ran. Same harness-fault semantics as `route-drift`.
  | 'multiple-varied-roles'
  // HOK-3129: recurring native arm-failure signatures the classifier used to
  // default into `native-unclassified`. All are model-attributable (the
  // provider delivered output; the model failed to produce usable content).
  // The suffixed `planning-artifact-invalid:<reason>` form is emitted by the
  // shell classifier and matched via a startsWith guard — the taxonomy itself
  // only holds the base variant. (`planning-turn-limit` collapsed into
  // `native-stage-timeout`, HOK-3362.)
  | 'planning-artifact-invalid'
  | 'review-no-output'
  | 'coding-exited-without-result';

export type ArmFaultClass =
  | 'harness-fault'
  | 'selection-fault'
  | 'provider-fault'
  | 'model-fault'
  | 'unknown-fault';

export type ChallengeArmSide = 'primary' | 'challenger';

export interface ChallengeArmFailure {
  side: ChallengeArmSide;
  model: string;
  stage?: string;
  failureKind?: string;
  faultClass?: ArmFaultClass;
  detail?: string;
}

/**
 * Wait share at or above which a budget run that also hit provider errors is
 * charged to the provider: most of its budget went to a failing upstream.
 */
export const PROVIDER_DOMINATED_WAIT_SHARE = 0.5;

/**
 * Wait share at or above which a wall-clock run that never got past its first
 * turn is charged to the provider: it was stuck on one upstream request.
 */
export const STALLED_REQUEST_WAIT_SHARE = 0.9;

/**
 * The one budget-exhaustion fault rule (HOK-3362). The class is derived from
 * the fact's progress evidence, never stored as primary (HOK-3338 rule 3), so
 * every stage — planning, coding, review — gets the same answer for the same
 * evidence:
 *
 * | # | Evidence                                                              | Class          |
 * |---|-----------------------------------------------------------------------|----------------|
 * | 1 | provider-error retries > 0 and provider wait ≥ 50% of the wall clock  | provider-fault |
 * | 2 | wall-clock budget, ≤ 1 turn, provider wait ≥ 90% of the wall clock    | provider-fault |
 * | 3 | ≥ 1 turn and ≥ 1 tool call (the agent kept making progress)          | model-fault    |
 * | 4 | no fact (historical rows) or no progress                              | unknown-fault  |
 *
 * Generation time counts as provider wait (the loop cannot separate it), which
 * is why rule 1 also requires provider errors: a slow but healthy model that
 * runs out of budget is the model not finishing in time, not a provider fault.
 */
export function deriveBudgetExhaustionFaultClass(fact: BudgetExhaustedFact | null | undefined): ArmFaultClass {
  if (!fact?.progress) return 'unknown-fault';
  const progress = fact.progress;
  const wallClockMs = progress.wallClockMs > 0 ? progress.wallClockMs : 0;
  const waitShare = wallClockMs > 0 && typeof progress.providerWaitMs === 'number'
    ? progress.providerWaitMs / wallClockMs
    : 0;
  if ((progress.providerErrorRetries ?? 0) > 0 && waitShare >= PROVIDER_DOMINATED_WAIT_SHARE) {
    return 'provider-fault';
  }
  if (fact.kind === 'wall_clock' && progress.turnsCompleted <= 1 && waitShare >= STALLED_REQUEST_WAIT_SHARE) {
    return 'provider-fault';
  }
  if (progress.turnsCompleted >= 1 && progress.toolCallsExecuted >= 1) {
    return 'model-fault';
  }
  return 'unknown-fault';
}

/**
 * Classify terminal arm failures without feeding them into the quality corpus.
 *
 * Reliability is recorded for every failed arm. Model quality remains limited to
 * real EvalRecords; only future consumers that explicitly opt into
 * qualitySignalEligible should treat provider/model faults as model signal.
 * Harness, selection, and unknown faults are intentionally excluded so routing
 * does not learn to avoid a model because of our configuration or scheduling.
 */
export function classifyArmFault(input: {
  failureKind?: string | null;
  detail?: string | null;
  /** HOK-3362: the typed fact a budget-exhaustion failure carries. */
  budgetExhausted?: BudgetExhaustedFact | null;
}): ArmFaultClass {
  const failureKind = input.failureKind ?? '';
  const detail = (input.detail ?? '').toLowerCase();

  // HOK-3362: one budget-exhaustion kind. Historical spellings
  // (`native-review-timeout`, `planning-turn-limit`) canonicalise to it, and
  // the class is derived from the fact — a row without one stays unattributed.
  if (canonicalFailureKind(failureKind) === 'native-stage-timeout') {
    return deriveBudgetExhaustionFaultClass(input.budgetExhausted);
  }

  // HOK-3129: the shell classifier emits `planning-artifact-invalid:<reason>`
  // with the structural reason suffix preserved for selection-health. Match the
  // base variant without enumerating every suffix.
  if (failureKind.startsWith('planning-artifact-invalid')) {
    return 'model-fault';
  }

  switch (failureKind) {
    case 'context-exhausted':
    case 'context-window-exceeded':
    case 'invalid-model-id':
    case 'empty-model-turn':
    case 'provider-credit-exhausted':
    case 'provider-config-error':
    case 'openrouter-credits-exhausted':
      return 'harness-fault';
    // Our own policy stopped the run (mutation/network denial) or an operator/
    // orchestrator cancelled it — never model or provider quality evidence.
    case 'policy-denied':
    case 'cancelled':
    // A GitHub approval/branch-protection gate is repository policy (HOK-3176).
    case 'operator-gate':
      return 'harness-fault';
    case 'tool-use-unsupported':
    case 'varied_model_unresolvable':
      return 'selection-fault';
    case 'provider-rate-limited':
    case 'provider-quota-exhausted':
    case 'provider-transient-error':
      return 'provider-fault';
    case 'native-provider-error':
      if (/(finish_reason|malformed|truncated stream|stream ended without|invalid response|unusable result)/.test(detail)) {
        return 'model-fault';
      }
      if (/(5\d\d|server error|overloaded|bad gateway|unavailable|service unavailable|gateway timeout|upstream)/.test(detail)) {
        return 'provider-fault';
      }
      return 'unknown-fault';
    // The model violated the coding completion/tool protocol (typed
    // no_completion_artifact / invalid_completion_artifact handoff): the
    // provider delivered output, so this is model quality signal.
    case 'native-completion-protocol':
      return 'model-fault';
    // HOK-3128: the model finished coding but left its own output uncommitted
    // and did not repair it when relaunched with a targeted instruction — the
    // same completion-protocol failure, detected by the monitor instead.
    case 'coding-dirty-handoff':
      return 'model-fault';
    // HOK-3128: the mill lost track of a no-PR arm (no agent evidence past the
    // stall grace). Nothing proves the model was at fault, so keep it out of
    // quality signal.
    case 'sibling-stalled':
      return 'harness-fault';
    // HOK-3147: the arm's PR stayed red after Ready remediation and rechecks
    // were exhausted — the model's own output failed CI, the same precedent
    // as `coding-dirty-handoff`.
    case 'ready-exhausted':
      return 'model-fault';
    // HOK-3147: Ready's checks passed (or no typed red-check cause exists) but
    // the arm could not be handed off. These are retired as invalid challenges
    // and never become model signal.
    case 'ready-transition-failed':
    case 'ready-unattributed':
      return 'harness-fault';
    // HOK-3154: Ready launch was refused by the review gate while the sibling
    // was green. `review-malformed-response` and `review-not-ready` are
    // model-attributable (the reviewer delivered output but failed to produce a
    // usable verdict), parallel to `review-no-output`. `review-identity-mismatch`
    // and `review-unattributed` are harness/identity failures (the reviewer
    // identity could not be proven, so no winner can be forfeited).
    case 'review-malformed-response':
    case 'review-not-ready':
      return 'model-fault';
    case 'review-identity-mismatch':
    case 'review-unattributed':
      return 'harness-fault';
    // HOK-3156: route drift is produced by re-routing, never by the model.
    case 'route-drift':
    case 'multiple-varied-roles':
      return 'harness-fault';
    // HOK-3129: the reviewer finished without findings or a terminal verdict;
    // the coding agent exited leaving a durable-commit-preserved interruption.
    // Both are model-attributable (the provider delivered output; the model
    // failed to produce usable content).
    case 'review-no-output':
    case 'coding-exited-without-result':
      return 'model-fault';
    // HOK-3129: the planning artifact failed structural validation (both the
    // base variant and the pre-suffix startsWith branch above). Model-fault
    // only reaches this arm when the suffixed form was not emitted.
    case 'planning-artifact-invalid':
      return 'model-fault';
    // Unattributed failures stay excluded from quality signal so routing
    // never learns from evidence-free classifications.
    case 'native-unclassified':
      return 'unknown-fault';
    default:
      return 'unknown-fault';
  }
}

export function parseAbortFailureKind(abortReason?: string | null): string | null {
  if (!abortReason) {
    return null;
  }
  const trimmed = abortReason.trim();
  if (trimmed === 'varied_model_unresolvable') {
    return trimmed;
  }
  // Legacy literal emitted before HOK-3064 typed the exhaustion reason as
  // `retry_exhausted:native-review-timeout`. Keep it parseable so previously
  // recorded aborts classify correctly when reprocessed.
  if (trimmed === 'review_timeout_exhausted') {
    return 'native-review-timeout';
  }
  const match = /^(?:terminal_stage_failure|terminal_launch_failure|retry_exhausted|invalid_challenge):(.+)$/.exec(trimmed);
  return match?.[1]?.trim() || null;
}

/**
 * True when an arm's `challengeAborted` reason retires it as an invalid
 * challenge (`invalid_challenge:<kind>`, HOK-3147): an infrastructure/identity
 * failure that must resolve the pair without a winner or a model forfeit.
 */
export function isInvalidChallengeAbort(abortReason?: string | null): boolean {
  return (abortReason ?? '').trim().startsWith('invalid_challenge:');
}

export function isModelQualitySignal(faultClass: ArmFaultClass): boolean {
  return faultClass === 'model-fault' || faultClass === 'provider-fault';
}

export function faultClassReason(faultClass: ArmFaultClass): string {
  switch (faultClass) {
    case 'harness-fault':
      return 'the harness misconfigured or overfed a capable model';
    case 'selection-fault':
      return 'the model was never eligible for this stage';
    case 'provider-fault':
      return 'the upstream provider failed or throttled the request';
    case 'model-fault':
      return 'the model produced an unusable result';
    case 'unknown-fault':
      return 'the failure could not be attributed confidently';
  }
}

export function describeArmFailure(input: {
  role: ChallengeArmSide;
  model: string;
  stage?: string | null;
  failureKind?: string | null;
  faultClass?: ArmFaultClass | null;
  detail?: string | null;
}): string {
  const role = input.role === 'primary' ? 'Primary' : 'Challenger';
  const stage = input.stage ? ` at ${input.stage}` : '';
  const kind = input.failureKind || 'unknown failure';
  const fault = input.faultClass ? ` (${input.faultClass} - ${faultClassReason(input.faultClass)})` : '';
  return `${role} arm (${input.model || 'unknown'}) failed${stage}: ${kind}${fault}.`;
}
