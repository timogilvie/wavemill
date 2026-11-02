/**
 * One review-gate remediation decision (HOK-2890): collapse the remediation
 * disposition onto one typed decision function and the shared failure-policy /
 * agent-delivery primitives.
 *
 * The categorical switch is the translation layer per plan D1: typed
 * review-gate findings → FailureClass. The disposition module itself does not
 * add a new terminal cause (that stays in failure-policy's TERMINAL_ALLOWLIST)
 * — it only decides which existing branch of the shared policy a typed
 * review-gate finding belongs to.
 *
 * Remediable scope violations and verification failures → code-failure → agent
 * correction delivery via agent-remediation-delivery.sh.
 * Transient infra / malformed-response failures → retryable → bounded-retry
 * recovery (shared `stage-failure-review` bucket).
 * Terminal configuration errors → terminal → operator attention.
 *
 * When typed findings are not yet available (pre-D7a production shape), the
 * CLI (tools/review-gate-remediation-cli.ts) falls back to the same
 * failureCategory / verdict signals review_result_infra_failure uses, so the
 * module never pretends an un-typed failing verdict is retryable.
 */

import type { FailureClass } from './failure-policy.ts';

export type ReviewGateFindingCategory =
  | 'scope-violation'
  | 'verification-failed'
  | 'review-blocking'
  | 'review-infra'
  | 'review-malformed'
  | 'config-error';

export interface ReviewGateFinding {
  category: ReviewGateFindingCategory;
  offendingPath?: string;
  message: string;
}

export interface ReviewGateEvidence {
  stage: 'review' | 'pre-pr-verification';
  stateDir: string;
  headSha: string;
  reviewerModel?: string;
  verdict?: string;
  findings: ReviewGateFinding[];
  artifact: { kind: 'review-result' | 'pre-pr-gate'; identity: string };
  /** Plan-declared out-of-scope paths that may be explicitly refreshed into the baseline. */
  planScopeAllowlist?: Array<{ path: string; reason: string; source: string }>;
}

export interface AgentRemediationPayload {
  /** The finding that triggered this delivery. */
  finding: ReviewGateFinding;
  /** Suggested corrective action(s) for the agent. */
  suggestions: Array<{
    action: 'revert' | 'refresh-baseline';
    path: string;
    command?: string;
    reason: string;
  }>;
}

export interface ReviewGateRemediationDecision {
  disposition: FailureClass;
  deliverTo: 'agent' | 'operator' | 'infra-recovery';
  deliveryPayload?: AgentRemediationPayload;
}

/**
 * Decide the remediation disposition for a review-gate refusal from typed findings.
 *
 * The disposition drives:
 * - `code-failure` → deliver remediation finding and suggestions to the agent
 * - `retryable` → infra recovery relaunch (temporary failure)
 * - `terminal` → operator attention (configuration error or policy limit)
 *
 * An empty findings[] is a programming error — callers that lack typed
 * findings must route through the CLI's artifact-signal fallback instead.
 */
export function decideReviewGateRemediation(
  evidence: ReviewGateEvidence,
): ReviewGateRemediationDecision {
  if (evidence.findings.length === 0) {
    throw new Error(
      'decideReviewGateRemediation requires at least one typed finding; callers without typed findings must use the artifact-signal fallback',
    );
  }

  const agentFinding = evidence.findings.find(
    (f) => f.category === 'scope-violation' || f.category === 'verification-failed',
  );
  if (agentFinding) {
    return {
      disposition: 'code-failure',
      deliverTo: 'agent',
      deliveryPayload: buildRemediationPayload(
        agentFinding,
        evidence.planScopeAllowlist || [],
      ),
    };
  }

  if (evidence.findings.some((f) => f.category === 'config-error')) {
    return {
      disposition: 'terminal',
      deliverTo: 'operator',
    };
  }

  if (
    evidence.findings.some(
      (f) => f.category === 'review-infra' || f.category === 'review-malformed',
    )
  ) {
    return {
      disposition: 'retryable',
      deliverTo: 'infra-recovery',
    };
  }

  // Review-blocking (undismissed blockers) with no infra/config/scope evidence
  // is a genuine refusal that must reach the operator — the pre-HOK-2890
  // park-via-attention-file branch.
  return {
    disposition: 'terminal',
    deliverTo: 'operator',
  };
}

/**
 * Shape of the subset of `.review-result.json` the artifact-signal fallback
 * reads. The review artifact may unwrap one level — see
 * review_result_failure_category in wavemill-monitor.sh for the same shape.
 */
export interface ReviewArtifactSignals {
  verdict?: string;
  reviewToolError?: string;
  failureCategory?: string;
  artifacts?: {
    type?: string;
    failureCategory?: string;
    verdict?: string;
    reviewToolError?: string;
    review?: {
      failureCategory?: string;
      verdict?: string;
      reviewToolError?: string;
    };
  };
}

/**
 * The infra failureCategory set used by `review_result_infra_failure` in
 * wavemill-monitor.sh. Keep in sync with INFRA_REVIEW_FAILURE_CATEGORIES in
 * shared/lib/stage-result.ts.
 */
export const INFRA_REVIEW_FAILURE_CATEGORIES: ReadonlySet<string> = new Set([
  'native-runtime-unavailable',
  'native-review-prompt-missing',
  'review-scope-unverifiable',
  'review-scope-mismatch',
  'review-scope-empty',
  'native-context-window-exceeded',
  'provider-credit-exhausted',
  'native-review-timeout',
  'native-review-malformed-response',
]);

function unwrapArtifactField(
  review: ReviewArtifactSignals,
  key: 'failureCategory' | 'verdict' | 'reviewToolError',
): string {
  const artifacts = review.artifacts ?? {};
  if (artifacts.type === 'review') {
    return (artifacts[key] ?? review[key] ?? '') as string;
  }
  return (
    (artifacts.review?.[key] ?? artifacts[key] ?? review[key] ?? '') as string
  );
}

/**
 * The pre-HOK-2890 pre-Ready split, preserved for review artifacts that do
 * not yet carry typed findings. Infra failures → `retryable`; any other
 * refusing verdict → `terminal`.
 *
 * This mirrors `review_result_infra_failure` in shared/lib/wavemill-monitor.sh.
 * The CLI uses it when `.review-result.json` has no typed `findings[]`.
 */
export function dispositionFromReviewArtifactSignals(
  review: ReviewArtifactSignals,
): 'terminal' | 'retryable' {
  const failureCategory = unwrapArtifactField(review, 'failureCategory');
  const verdict = unwrapArtifactField(review, 'verdict');
  const reviewToolError = unwrapArtifactField(review, 'reviewToolError');

  if (INFRA_REVIEW_FAILURE_CATEGORIES.has(failureCategory)) {
    return 'retryable';
  }
  // HOK-3247: a routed reviewer that cannot run is retryable infra; the
  // challenge-pinned shape (verdict not_ready) is a harness fault instead.
  if (failureCategory === 'review-model-unlaunchable' && verdict !== 'not_ready') {
    return 'retryable';
  }
  if (verdict === 'error' && reviewToolError.length > 0) {
    return 'retryable';
  }
  return 'terminal';
}

function buildRemediationPayload(
  finding: ReviewGateFinding,
  planAllowlist: Array<{ path: string; reason: string; source: string }>,
): AgentRemediationPayload {
  const suggestions: AgentRemediationPayload['suggestions'] = [];

  if (finding.category === 'scope-violation' && finding.offendingPath) {
    const isInPlanScope = planAllowlist.some(
      (entry) => entry.path === finding.offendingPath,
    );

    if (isInPlanScope) {
      suggestions.push({
        action: 'refresh-baseline',
        path: finding.offendingPath,
        command: `npx tsx tools/write-review-scope-baseline.ts --refresh --repo-dir . --reason "..."`,
        reason: `This path is declared in the plan's Scope allow-list; refresh the baseline with the reason.`,
      });
    } else {
      suggestions.push({
        action: 'revert',
        path: finding.offendingPath,
        reason: 'This path is not in the plan scope; revert the change.',
      });
    }
  }

  return {
    finding,
    suggestions,
  };
}
