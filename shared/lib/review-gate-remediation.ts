/**
 * One review-gate remediation decision (HOK-2890): collapse the remediation
 * disposition onto the existing failure-policy and agent-delivery primitives.
 *
 * Typed review-gate findings flow through one `decideReviewGateRemediation`
 * function, which builds FailureEvidence and classifies as terminal / code-failure
 * / retryable through the shared failure-policy.
 *
 * Remediable scope violations and verification failures → code-failure → agent
 * correction delivery.
 * Transient infra failures → retryable → bounded-retry recovery.
 * Terminal configuration errors → terminal → operator attention.
 */

import type { FailureClass, FailureDecision } from './failure-policy.ts';
import { classifyFailure } from './failure-policy.ts';

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
  failureDecision?: FailureDecision;
}

/**
 * Decide the remediation disposition for a review-gate refusal.
 *
 * Maps typed review findings to the shared failure-policy classification
 * (terminal / code-failure / retryable) without introducing new terminal
 * causes or classifier branches.
 *
 * The disposition drives:
 * - `code-failure` → deliver remediation finding and suggestions to the agent
 * - `retryable` → infra recovery relaunch (temporary failure)
 * - `terminal` → operator attention (configuration error or policy limit)
 *
 * @param evidence Typed review-gate evidence with findings
 * @returns Disposition, delivery target, and optional remediation payload
 */
export function decideReviewGateRemediation(
  evidence: ReviewGateEvidence,
): ReviewGateRemediationDecision {
  // Classify directly by finding category rather than relying on failure-policy's
  // text-matching, since review-gate findings are typed and categorical.
  let disposition: FailureClass = 'retryable';
  let deliverTo: 'agent' | 'operator' | 'infra-recovery' = 'infra-recovery';
  let deliveryPayload: AgentRemediationPayload | undefined;

  // Scope violations and verification failures are remediable by the agent
  if (evidence.findings.some((f) => f.category === 'scope-violation' || f.category === 'verification-failed')) {
    disposition = 'code-failure';
    deliverTo = 'agent';
    const finding = evidence.findings.find((f) => f.category === 'scope-violation' || f.category === 'verification-failed');
    if (finding) {
      deliveryPayload = buildRemediationPayload(
        finding,
        evidence.planScopeAllowlist || [],
      );
    }
  }
  // Config errors are terminal
  else if (evidence.findings.some((f) => f.category === 'config-error')) {
    disposition = 'terminal';
    deliverTo = 'operator';
  }
  // Infra failures and transient errors are retryable
  else if (evidence.findings.some((f) => f.category === 'review-infra' || f.category === 'review-malformed')) {
    disposition = 'retryable';
    deliverTo = 'infra-recovery';
  }

  // Build FailureEvidence for the policy decision, matching the disposition we derived
  const detail = evidence.findings
    .map((f) => `${f.category}: ${f.message}`)
    .join('; ');

  const failureDecision = classifyFailure({
    stage: evidence.stage === 'review' ? 'review' : 'review',
    detail,
    failureKind: mapFindingsToBroadClass(evidence.findings),
  });

  return {
    disposition,
    deliverTo,
    deliveryPayload,
    failureDecision,
  };
}

function mapFindingsToBroadClass(
  findings: ReviewGateFinding[],
): string {
  if (findings.length === 0) return 'review-unknown';

  const categories = new Set(findings.map((f) => f.category));
  if (
    categories.has('scope-violation') ||
    categories.has('verification-failed')
  ) {
    return 'review-scope-violation';
  }
  if (
    categories.has('review-infra') ||
    categories.has('review-malformed')
  ) {
    return 'review-transient';
  }
  if (categories.has('config-error')) {
    return 'review-config-error';
  }

  return 'review-unknown';
}

function buildRemediationPayload(
  finding: ReviewGateFinding,
  planAllowlist: Array<{ path: string; reason: string; source: string }>,
): AgentRemediationPayload {
  const suggestions: AgentRemediationPayload['suggestions'] = [];

  if (
    finding.category === 'scope-violation' &&
    finding.offendingPath
  ) {
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
