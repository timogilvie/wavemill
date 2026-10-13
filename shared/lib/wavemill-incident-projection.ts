/**
 * Operator- and executor-facing projections of correlated incidents (HOK-2595).
 *
 * - `projectRemediationProposals`: the typed, validated proposal list an
 *   external recovery executor consumes from `wavemill observer --json`
 *   without parsing prose. A proposal is never authorization.
 * - `supersedeGenericFindings`: when a specific causal chain exists for an
 *   issue, the generic "stale active task" finding is grouped under the
 *   incident and its parked-pane advice is replaced with the incident's next
 *   safe action. Without a specific chain the generic finding is untouched.
 * - `incidentChainEvidenceLines`: concise causal-chain / next-action lines
 *   for the incident's finding.
 *
 * Pure functions; no I/O.
 *
 * @module wavemill-incident-projection
 */

import {
  validateRemediationProposal,
  type IncidentRecord,
  type IncidentRootCauseClass,
  type RemediationProposal,
} from './wavemill-incident-model.ts';

/** Schema id of the observer `--json` snapshot. Additive changes keep `/1`. */
export const OBSERVER_SNAPSHOT_SCHEMA_VERSION = 'observer-snapshot/1';

/** Root causes specific enough to supersede the generic stale-task advice. */
export const CORRELATED_ROOT_CAUSE_CLASSES: ReadonlySet<IncidentRootCauseClass> = new Set<IncidentRootCauseClass>([
  'review_context_overflow_stale_base',
  'provider_quota_exhaustion_blocking_review',
  'challenge_arm_review_failed_blocking_pair',
]);

/** Generic per-task stall findings that a correlated incident may supersede. */
const GENERIC_STALE_TASK_FINDING_RE = /^stale-active-task-(?:live-process|no-live-process)-/;

export interface RemediationProposalProjection {
  incidentFingerprint: string;
  issue: string | null;
  rootCauseClass: IncidentRootCauseClass;
  confidence: IncidentRecord['confidence'];
  lifecycle: IncidentRecord['lifecycle'];
  proposal: RemediationProposal;
}

/**
 * Project valid proposals from non-resolved incidents. Invalid proposals are
 * dropped and counted, never emitted half-formed.
 */
export function projectRemediationProposals(incidents: IncidentRecord[]): {
  proposals: RemediationProposalProjection[];
  errors: number;
} {
  const proposals: RemediationProposalProjection[] = [];
  let errors = 0;
  for (const incident of incidents) {
    if (incident.lifecycle === 'resolved' || incident.lifecycle === 'archived') continue;
    const raw = incident.metadata?.proposal;
    if (raw === undefined) continue;
    const validated = validateRemediationProposal(raw);
    if (validated.ok !== true) {
      errors += 1;
      continue;
    }
    proposals.push({
      incidentFingerprint: incident.fingerprint,
      issue: incident.taskId ?? null,
      rootCauseClass: incident.rootCauseClass,
      confidence: incident.confidence,
      lifecycle: incident.lifecycle,
      proposal: validated.value,
    });
  }
  return { proposals, errors };
}

/** Issue IDs a correlated incident speaks for (its task plus both pair arms). */
export function correlatedIncidentIssues(incident: IncidentRecord): string[] {
  const metadata = incident.metadata ?? {};
  const issues = [
    incident.taskId,
    metadata.failedIssueId,
    metadata.blockedIssueId,
  ].filter((issue): issue is string => typeof issue === 'string' && issue.length > 0);
  return [...new Set(issues)];
}

/** Minimal finding shape `supersedeGenericFindings` reads and rewrites. */
export interface SupersedableFinding {
  id: string;
  issue?: string;
  evidence: string[];
  recommendation: string;
  groupedUnder?: string;
}

/**
 * Group generic stale-task findings under the matching correlated incident's
 * finding (`incident-<fingerprint>`), record `supersededBy=<rootCause>`, and
 * replace the recommendation with the incident's next safe action. Returns
 * new finding objects; inputs are not mutated.
 */
export function supersedeGenericFindings<T extends SupersedableFinding>(findings: T[], incidents: IncidentRecord[]): T[] {
  const byIssue = new Map<string, IncidentRecord>();
  for (const incident of incidents) {
    if (incident.lifecycle === 'resolved' || incident.lifecycle === 'archived') continue;
    if (!CORRELATED_ROOT_CAUSE_CLASSES.has(incident.rootCauseClass)) continue;
    for (const issue of correlatedIncidentIssues(incident)) {
      if (!byIssue.has(issue)) byIssue.set(issue, incident);
    }
  }
  if (byIssue.size === 0) return findings;
  return findings.map((finding) => {
    if (!finding.issue || finding.groupedUnder || !GENERIC_STALE_TASK_FINDING_RE.test(finding.id)) return finding;
    const incident = byIssue.get(finding.issue);
    if (!incident) return finding;
    return {
      ...finding,
      groupedUnder: `incident-${incident.fingerprint}`,
      evidence: [...finding.evidence, `supersededBy=${incident.rootCauseClass}`],
      recommendation: incident.operatorAction,
    };
  });
}

/** Causal-chain / next-action / proposal evidence lines for an incident finding. */
export function incidentChainEvidenceLines(incident: IncidentRecord): string[] {
  const metadata = incident.metadata ?? {};
  const lines: string[] = [];
  const chain = Array.isArray(metadata.causalChain) ? metadata.causalChain : [];
  if (chain.length > 0) {
    lines.push(`causalChain=${chain.map((entry) => entry.cause).join(' → ')}`);
  }
  if (typeof metadata.pairState === 'string') lines.push(`pairState=${metadata.pairState}`);
  const proposal = metadata.proposal;
  if (proposal && typeof proposal === 'object') {
    if (proposal.recommendationId) lines.push(`nextAction=${proposal.recommendationId}`);
    lines.push(`proposal=${proposal.kind}@${proposal.schemaVersion}`);
  }
  if (Array.isArray(metadata.missingEvidence) && metadata.missingEvidence.length > 0) {
    lines.push(`missingEvidence=${metadata.missingEvidence.join(',')}`);
  }
  return lines;
}
