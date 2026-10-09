/**
 * The single failure policy (HOK-3176): every stage gate — planning, coding,
 * review, Ready, tend rebase/checks/merge, eval — asks this module what to do
 * with a failure.
 *
 * | Class          | Decided by                                   | Action                                    |
 * | -------------- | -------------------------------------------- | ----------------------------------------- |
 * | `terminal`     | {@link TERMINAL_ALLOWLIST} only              | park / retire                             |
 * | `code-failure` | recognised test/guard/conflict signatures    | send to remediation with the excerpt      |
 * | `retryable`    | DEFAULT — including unknown / novel strings  | bounded retry → one fresh relaunch →      |
 * |                |                                              | escalate to needs-user with full evidence |
 *
 * The inversion is the point: before HOK-3176 a failure the mill did not
 * recognise parked the task (`native-unclassified` → needs-user, first tend
 * rebase failure → `wm:blocked`), so every new error string became a new
 * classifier patch (HOK-3129, 3155, 3163, 3169, 3170). Now an unrecognised
 * string retries, and only an explicit, tested allowlist entry can park.
 *
 * Retries go through `bounded-retry.sh` (never a private counter), keyed on
 * (head, base) per HOK-3103, and exhaustion writes the HOK-3172 condition
 * companion so an escalation never latches: a new head or an operator event
 * expires it.
 *
 * Kind *detection* (turning raw detail text into a stable kind such as
 * `provider-credit-exhausted`) also lives here so the shell monitor and the
 * TS gates share one ladder; the shell reaches it through
 * `tools/failure-policy-cli.ts` (`failure_policy_decide` in
 * `wavemill-common.sh`). Fault-class *attribution* for reliability metrics
 * stays in `arm-failure-taxonomy.ts` — attribution is not a terminal decision.
 */
import type { ArmFaultClass } from './arm-failure-taxonomy.ts';
import type { CiFailureCategory } from './ci-failure-classifier.ts';
import { classifyProviderError } from './native-agent/provider-error-classifier.ts';

export type FailureClass = 'terminal' | 'code-failure' | 'retryable';

export type FailureStage = 'planning' | 'coding' | 'review' | 'ready' | 'tend' | 'eval';

/** An allowlisted cause. Only entries in {@link TERMINAL_ALLOWLIST} may map to `terminal`. */
export interface TerminalCause {
  /** Stable failure kind, as recorded in abort reasons and stage results. */
  code: string;
  /** Why retrying cannot change the outcome (one sentence). */
  reason: string;
  /** Reliability attribution, mirrored from `classifyArmFault`. */
  faultClass: ArmFaultClass;
  /** `failure-policy.test.ts` case that pins this entry. Enforced by the suite. */
  testRef: string;
  /**
   * Terminal for tracked challenge arms only. These preserve existing pair
   * forfeit / void semantics (HOK-3147/3154/3128) without parking a
   * non-challenge task on the same cause.
   */
  challengeOnly?: boolean;
}

export interface FailureEvidence {
  stage: FailureStage;
  /** Typed kind when the stage emitted one (envelope, handoff, abort reason). */
  failureKind?: string | null;
  /** Raw error text / stage note; used for kind detection when no typed kind exists. */
  detail?: string | null;
  /** Typed coding handoff reason (`.coding-failure-handoff.json`). */
  handoffReason?: string | null;
  /** CI classification from `ci-failure-classifier.ts`, when the failure is a red check. */
  ciCategory?: CiFailureCategory | null;
  /** The failing task is a tracked challenge arm. */
  challengeArm?: boolean;
}

export interface FailureDecision {
  class: FailureClass;
  /** Detected or supplied failure kind (`native-unclassified` when nothing matched). */
  failureKind: string;
  /** Only when `class === 'terminal'`. */
  cause?: TerminalCause;
  /** Only when `class === 'retryable'`: the bounded-retry bucket that owns the budget. */
  retryBucket?: string;
  /** Only when `class === 'code-failure'`: the evidence remediation should start from. */
  codeFailureExcerpt?: string;
  rationale: string;
  /** Operator hint recorded with the failure and on escalation. */
  nextAction: string;
}

/**
 * Count of distinct failure kinds that parked a task before HOK-3176 — every
 * member of the old `TerminalFailureKind` union (29) took the needs-user /
 * `terminal_launch_failure:` path. Frozen: the acceptance criterion is that
 * {@link TERMINAL_ALLOWLIST} stays strictly below it.
 */
export const TERMINAL_CODES_BEFORE_HOK_3176 = 29;

/**
 * Explicit allowlist — the ONLY causes that may park a task. Every other kind,
 * including empty, unknown, and never-seen-before strings, is retryable.
 * Adding an entry requires a reason and a pinned test (`testRef`).
 */
export const TERMINAL_ALLOWLIST: readonly TerminalCause[] = Object.freeze([
  {
    code: 'policy-denied',
    reason: 'a mutation/network policy rejected the action; only an operator can widen the policy',
    faultClass: 'harness-fault',
    testRef: 'failure-policy.test.ts:terminal:policy-denied',
  },
  {
    code: 'cancelled',
    reason: 'an operator or the orchestrator cancelled the run; relaunching would override that decision',
    faultClass: 'harness-fault',
    testRef: 'failure-policy.test.ts:terminal:cancelled',
  },
  {
    code: 'provider-config-error',
    reason: 'the provider rejected auth or the model id; the same request fails until configuration changes',
    faultClass: 'harness-fault',
    testRef: 'failure-policy.test.ts:terminal:provider-config-error',
  },
  {
    code: 'context-window-exceeded',
    reason: 'the prompt exceeds the model context window; the identical relaunch overflows again',
    faultClass: 'harness-fault',
    testRef: 'failure-policy.test.ts:terminal:context-window-exceeded',
  },
  {
    code: 'tool-use-unsupported',
    reason: 'no provider endpoint serves tool use for this model; a selection fault no retry can fix',
    faultClass: 'selection-fault',
    testRef: 'failure-policy.test.ts:terminal:tool-use-unsupported',
  },
  {
    code: 'varied_model_unresolvable',
    reason: 'the varied challenge model can never pass launch preflight (HOK-2920)',
    faultClass: 'selection-fault',
    testRef: 'failure-policy.test.ts:terminal:varied_model_unresolvable',
  },
  {
    code: 'operator-gate',
    reason: 'GitHub requires an approval, security, or branch-protection gate that only an operator can satisfy',
    faultClass: 'harness-fault',
    testRef: 'failure-policy.test.ts:terminal:operator-gate',
  },
  {
    code: 'coding-dirty-handoff',
    reason: 'the HOK-3128 dirty-handoff relaunch budget is already spent; the agent will not commit its own output',
    faultClass: 'model-fault',
    testRef: 'failure-policy.test.ts:terminal:coding-dirty-handoff',
  },
  // Challenge-only: existing pair-resolution semantics. Each is emitted only
  // after its own bounded-retry bucket is exhausted, so the retry already
  // happened upstream; re-retrying here would wedge the green sibling.
  {
    code: 'sibling-stalled',
    reason: 'a no-PR arm showed no agent progress past the stall grace; retiring it releases its sibling (HOK-3128)',
    faultClass: 'harness-fault',
    testRef: 'failure-policy.test.ts:terminal:challenge-only',
    challengeOnly: true,
  },
  {
    code: 'ready-exhausted',
    reason: "the arm's checks stayed red after Ready remediation and rechecks were exhausted (HOK-3147)",
    faultClass: 'model-fault',
    testRef: 'failure-policy.test.ts:terminal:challenge-only',
    challengeOnly: true,
  },
  {
    code: 'ready-transition-failed',
    reason: 'Ready passed but the handoff transition kept failing; the arm is void, not forfeit (HOK-3147)',
    faultClass: 'harness-fault',
    testRef: 'failure-policy.test.ts:terminal:challenge-only',
    challengeOnly: true,
  },
  {
    code: 'ready-unattributed',
    reason: 'Ready was exhausted without a typed cause; the arm is void, not forfeit (HOK-3147)',
    faultClass: 'harness-fault',
    testRef: 'failure-policy.test.ts:terminal:challenge-only',
    challengeOnly: true,
  },
  {
    code: 'review-malformed-response',
    reason: 'the reviewer kept emitting a malformed verdict while Ready refused to launch (HOK-3154)',
    faultClass: 'model-fault',
    testRef: 'failure-policy.test.ts:terminal:challenge-only',
    challengeOnly: true,
  },
  {
    code: 'review-not-ready',
    reason: 'the reviewer returned a genuine not_ready verdict while Ready refused to launch (HOK-3154)',
    faultClass: 'model-fault',
    testRef: 'failure-policy.test.ts:terminal:challenge-only',
    challengeOnly: true,
  },
  {
    code: 'review-identity-mismatch',
    reason: 'the review artifact names a different reviewer than the arm was assigned (HOK-3154)',
    faultClass: 'harness-fault',
    testRef: 'failure-policy.test.ts:terminal:challenge-only',
    challengeOnly: true,
  },
  {
    code: 'review-unattributed',
    reason: 'the reviewer identity behind a refused Ready launch could not be proven (HOK-3154)',
    faultClass: 'harness-fault',
    testRef: 'failure-policy.test.ts:terminal:challenge-only',
    challengeOnly: true,
  },
] satisfies TerminalCause[]);

/** Legacy spellings that resolve to one canonical kind before policy lookup. */
const KIND_ALIASES: Readonly<Record<string, string>> = {
  'invalid-model-id': 'provider-config-error',
  'openrouter-credits-exhausted': 'provider-credit-exhausted',
  'provider-quota-exhausted': 'provider-credit-exhausted',
  'provider-rate-limited': 'provider-transient-error',
  'native-review-timeout': 'native-stage-timeout',
  operator_abort: 'cancelled',
  'operator-cancelled': 'cancelled',
};

export function canonicalFailureKind(kind: string | null | undefined): string {
  const trimmed = (kind ?? '').trim();
  if (!trimmed) return '';
  // `planning-artifact-invalid:<reason>` keeps its suffix for selection
  // health; policy only cares about the base kind.
  const base = trimmed.startsWith('planning-artifact-invalid') ? 'planning-artifact-invalid' : trimmed;
  return KIND_ALIASES[base] ?? base;
}

const TERMINAL_BY_CODE: ReadonlyMap<string, TerminalCause> = new Map(
  TERMINAL_ALLOWLIST.map((cause) => [cause.code, cause]),
);

/** The allowlist entry for a kind, honouring challenge-only scope. */
export function terminalCauseFor(kind: string | null | undefined, challengeArm = false): TerminalCause | undefined {
  const cause = TERMINAL_BY_CODE.get(canonicalFailureKind(kind));
  if (!cause) return undefined;
  if (cause.challengeOnly && !challengeArm) return undefined;
  return cause;
}

export function isTerminalKind(kind: string | null | undefined, challengeArm = false): boolean {
  return terminalCauseFor(kind, challengeArm) !== undefined;
}

// ── Kind detection ──────────────────────────────────────────────────────────

/** Typed coding handoff reasons that prove a completion-protocol violation. */
const COMPLETION_PROTOCOL_HANDOFF_REASONS = new Set(['no_completion_artifact', 'invalid_completion_artifact']);

/**
 * Native-loop signatures the provider classifier does not know, checked
 * BEFORE provider detection. Order matters: the most specific shapes first.
 */
const NATIVE_PRE_PROVIDER_SIGNATURES: ReadonlyArray<readonly [RegExp, string]> = [
  [/context-exhausted|contextexhaustederror/, 'context-exhausted'],
  [/context-window|context_length_exceeded/, 'context-window-exceeded'],
  [/no endpoints found.*tool use|supports? tool use|tool use.*not supported/, 'tool-use-unsupported'],
  [/empty-model-turn|reasoning-only.*turn|internal reasoning only/, 'empty-model-turn'],
  [/(?:^|\D)402 this request would|exceed your available credits|insufficient.*credit|quota/, 'provider-credit-exhausted'],
];

/**
 * HOK-3129 model-output signatures, checked AFTER provider detection so a
 * stacked message like "Native planning final artifact rejected: … (402
 * Payment Required)" still classifies as the provider fault.
 */
const NATIVE_POST_PROVIDER_SIGNATURES: ReadonlyArray<readonly [RegExp, string]> = [
  [/interrupted: coding agent exited without recording a result/, 'coding-exited-without-result'],
  [/native review flow failed after.*findings/, 'review-no-output'],
  [/native planning rejected before approval: turn_limit/, 'planning-turn-limit'],
];

const PLANNING_ARTIFACT_REJECTED = /native planning final artifact rejected:\s*([A-Za-z0-9_:-]+)?/i;

/**
 * Turn raw failure text into a stable kind. Precedence:
 *   1. typed completion-protocol handoff (never substring-matched);
 *   2. native-specific signatures, then the provider-error classifier, then
 *      HOK-3129 model-output signatures;
 *   3. `native-provider-error` when the handoff typed `provider_error`,
 *      otherwise `native-unclassified` — which is retryable, not terminal.
 */
export function detectFailureKind(detail: string | null | undefined, handoffReason?: string | null): string {
  if (handoffReason && COMPLETION_PROTOCOL_HANDOFF_REASONS.has(handoffReason)) {
    return 'native-completion-protocol';
  }
  const text = detail ?? '';
  const lower = text.toLowerCase();

  for (const [pattern, kind] of NATIVE_PRE_PROVIDER_SIGNATURES) {
    if (pattern.test(lower)) return kind;
  }
  const providerKind = text ? classifyProviderError(text).kind : 'provider-unknown-error';
  if (providerKind !== 'provider-unknown-error' && providerKind !== 'provider-response-incomplete') {
    return providerKind;
  }
  for (const [pattern, kind] of NATIVE_POST_PROVIDER_SIGNATURES) {
    if (pattern.test(lower)) return kind;
  }
  const planning = PLANNING_ARTIFACT_REJECTED.exec(text);
  if (planning) {
    return planning[1] ? `planning-artifact-invalid:${planning[1]}` : 'planning-artifact-invalid';
  }
  if (providerKind === 'provider-response-incomplete') return providerKind;
  return handoffReason === 'provider_error' ? 'native-provider-error' : 'native-unclassified';
}

// ── Code-failure signatures ─────────────────────────────────────────────────

/**
 * Recognised code failures: the change itself is wrong, so the evidence goes
 * to remediation. Retrying the identical input would fail identically, but
 * this is not terminal either — a remediation commit is new information.
 */
const CODE_FAILURE_SIGNATURES: ReadonlyArray<RegExp> = [
  /\bCONFLICT\b.*(?:merge conflict|content|add\/add|modify\/delete|rename)/,
  /could not apply [0-9a-f]{7,}/i,
  /resolve all conflicts manually/i,
  /\bERR_TEST_FAILURE\b/,
  /^not ok \d+/m,
  /\b\d+\s*passed,\s*[1-9]\d*\s*failed\b/i,
  /\bdrift found\b/i,
  /\bconfig validation failed\b/i,
];

/** Kinds a stage emits for red checks it already proved are the change's fault. */
const CODE_FAILURE_KINDS = new Set(['checks-failed', 'rebase-conflict']);

/**
 * Transient signatures that override a code-failure kind: a red check whose
 * log is a runner/network failure is infrastructure, not the change.
 */
const TRANSIENT_OVERRIDES: ReadonlyArray<RegExp> = [
  /\bECONNRESET\b|\bETIMEDOUT\b|\bEAI_AGAIN\b|socket hang up/,
  /connection (?:reset|refused|closed)/i,
  /not acquired by Runner|hosted runner encountered an error|runner (?:lost|has lost|was lost|disconnected)/i,
  /(?:^|\D)(?:502|503|504)(?:\D|$)|bad gateway|service unavailable|gateway timeout/i,
];

function firstMatchingLine(text: string, patterns: ReadonlyArray<RegExp>): string | null {
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      const line = text.split('\n').find((candidate) => pattern.test(candidate));
      return (line ?? text).trim().slice(0, 400);
    }
  }
  return null;
}

function excerpt(text: string, maxChars = 4000): string {
  return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

// ── Next actions ────────────────────────────────────────────────────────────

const NEXT_ACTIONS: Readonly<Record<string, string>> = {
  'context-exhausted': 'session compacted to the floor and still overflowed; re-launch on a larger-context model or split the task',
  'context-window-exceeded': 'relaunch with compressed context or a larger-context model; the prompt exceeded the model context window',
  'provider-config-error': 'check provider auth/model configuration, then rerun. The provider rejected the request',
  'provider-credit-exhausted': 'top up OpenRouter credits at https://openrouter.ai/credits',
  'provider-transient-error': 'transient upstream failure. Start the phase again',
  'native-stage-timeout': 'the native stage exhausted its wall-clock/turn/tool-call budget (recoverable infrastructure). Relaunch the same pinned reviewer with an escalated timeout',
  'policy-denied': 'a mutation/network policy rejected the run (harness fault, not a model/provider signal). Review the policy decision before relaunching',
  cancelled: 'the run was cancelled by an operator or the orchestrator (not a model/provider signal). Relaunch the phase when ready',
  'empty-model-turn': 'relaunch native coding; the runtime exhausted bounded continuation after empty model turns',
  'native-completion-protocol': "model ended the phase without a valid completion artifact (protocol violation, not a provider fault) - check the model's structured tool-call compatibility before relaunching",
  'ready-exhausted': 'the arm stayed red after Ready remediation and re-checks were exhausted; it was retired (forfeit) so its green sibling proceeds. Inspect the failed checks on the closed PR',
  'ready-transition-failed': "Ready's checks passed but a handoff transition (route-stamp, review identity, label, GitHub API) kept failing; the arm was retired as an invalid challenge (no model forfeit) so its green sibling proceeds. Inspect .ready-result.json transitionFailure",
  'ready-unattributed': 'Ready was exhausted without a typed red-check or transition cause (base conflict, missing ready result); the arm was retired as an invalid challenge so its green sibling proceeds. Inspect the ready attention file',
  'review-malformed-response': 'the reviewer emitted a malformed response and Ready kept refusing to launch; the arm was retired (forfeit) so its green sibling proceeds. Inspect the review-result.json failureCategory on the closed PR',
  'review-not-ready': 'the reviewer returned a genuine not_ready verdict with undismissed blockers and Ready kept refusing to launch; the arm was retired (forfeit) so its green sibling proceeds. Inspect the review-result.json blockers on the closed PR',
  'review-identity-mismatch': "the review artifact's reviewer identity disagreed with the arm's assignment (or execution evidence was contradicted); the arm was retired as an invalid challenge (no model forfeit) so its green sibling proceeds. Inspect the review-result.json intendedModel/executedModel on the closed PR",
  'review-unattributed': 'Ready was refused by the review gate but the reviewer identity could not be proven; the arm was retired as an invalid challenge (no model forfeit) so its green sibling proceeds. Inspect the review-result.json executionEvidence on the closed PR',
  'coding-dirty-handoff': 'the coding agent exited after writing .coding-complete with uncommitted output and did not repair it when relaunched (completion-protocol failure); the challenger is forfeited so the primary proceeds',
  'planning-turn-limit': 'the model exhausted its planning turn budget without emitting a final plan. Relaunch the phase on a stronger planner or increase maxTurns',
  'planning-artifact-invalid': 'the plan artifact failed structural validation after one repair turn. Inspect the recorded validationError and relaunch on a stronger planner',
  'review-no-output': 'the review model finished without emitting findings or a terminal verdict. Relaunch the review phase on a stronger reviewer',
  'coding-exited-without-result': 'the coding agent exited without recording a terminal result (durable commits preserved). Relaunch coding to resume from the last durable commit',
  'native-unclassified': 'unrecognised failure signature: the mill retries it with backoff and one fresh relaunch before escalating. Inspect the recorded detail if it escalates',
};

const DEFAULT_NEXT_ACTION = 'inspect the native provider error, then relaunch the phase';

export function nextActionFor(kind: string | null | undefined): string {
  const raw = (kind ?? '').trim();
  const base = raw.startsWith('planning-artifact-invalid') ? 'planning-artifact-invalid' : raw;
  return NEXT_ACTIONS[base] ?? NEXT_ACTIONS[canonicalFailureKind(raw)] ?? DEFAULT_NEXT_ACTION;
}

// ── Decision ────────────────────────────────────────────────────────────────

/** The bounded-retry bucket that owns a stage's default retry budget. */
export function retryBucketFor(stage: FailureStage): string {
  return stage === 'tend' ? 'tend-transient-recovery' : `stage-failure-${stage}`;
}

/**
 * Attempts the default retry path allows before escalating: two backoff
 * retries plus one fresh relaunch. Env-overridable per call site; kept here so
 * the shell and TS sides agree.
 */
export const DEFAULT_RETRY_ATTEMPTS = 3;

/**
 * Decide what to do with one failure. Total: never throws, and anything not
 * explicitly allowlisted or recognised as a code failure is retryable.
 */
export function classifyFailure(evidence: FailureEvidence): FailureDecision {
  const detail = evidence.detail ?? '';
  const failureKind = evidence.failureKind?.trim()
    ? evidence.failureKind.trim()
    : detectFailureKind(detail, evidence.handoffReason);
  const challengeArm = evidence.challengeArm === true;

  const cause = terminalCauseFor(failureKind, challengeArm);
  if (cause) {
    return {
      class: 'terminal',
      failureKind,
      cause,
      rationale: `allowlisted terminal cause ${cause.code}: ${cause.reason}`,
      nextAction: nextActionFor(failureKind),
    };
  }

  const transient = firstMatchingLine(detail, TRANSIENT_OVERRIDES);
  if (!transient) {
    const ciDeterministic = evidence.ciCategory === 'deterministic-local';
    const codeKind = CODE_FAILURE_KINDS.has(canonicalFailureKind(failureKind));
    const signature = firstMatchingLine(detail, CODE_FAILURE_SIGNATURES);
    if (ciDeterministic || signature || (codeKind && evidence.ciCategory !== 'transient-infra')) {
      return {
        class: 'code-failure',
        failureKind,
        codeFailureExcerpt: excerpt(detail),
        rationale: signature
          ? `recognised code-failure signature: ${signature}`
          : ciDeterministic
            ? 'CI classified the failure as locally replayable'
            : `${failureKind} is a recognised code failure`,
        nextAction: 'remediate the failing change from the recorded excerpt, then push a new head',
      };
    }
  }

  return {
    class: 'retryable',
    failureKind,
    retryBucket: retryBucketFor(evidence.stage),
    rationale: transient
      ? `transient signature overrides: ${transient}`
      : failureKind === 'native-unclassified'
        ? 'unrecognised failure: retry by default (HOK-3176)'
        : `${failureKind} is not on the terminal allowlist: retry by default (HOK-3176)`,
    nextAction: nextActionFor(failureKind),
  };
}
