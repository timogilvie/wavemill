/**
 * PR Route Provenance — HOK-2945
 *
 * Pure reconciler that reads stage-result execution evidence and produces a
 * public-safe route record for the wavemill-meta PR block. No I/O: file
 * reading is injected so the reconciler is testable with fixtures.
 *
 * @module pr-route-provenance
 */

import type { StageResult, StageName, ReviewArtifacts } from './stage-result.ts';
import type { ReviewExecutedIdentitySet, ExecutedIdentity } from './challenge-execution-contract.ts';

// ── Public wire types (HOK-2945 route_schema: 1) ───────────────────────────

export const ROUTE_SCHEMA_VERSION = '1';

export type RouteRoleStatus = 'executed' | 'inherited' | 'not_run' | 'unknown';

export interface RouteRoleIdentityPublic {
  model: string;
  pinned?: boolean;
  source?: string;
}

export interface ReviewerIdentitiesPublic {
  orchestrator?: RouteRoleIdentityPublic;
  substantive_analysis?: RouteRoleIdentityPublic;
  remediation?: RouteRoleIdentityPublic | null;
}

export interface RouteRolePublic {
  status: RouteRoleStatus;
  model: string | null;
  requested_selector?: string;
  adapter?: string;
  evidence_source?: string;
  inherited_from?: { issue: string; head_sha: string };
  fallback_chain?: Array<{ model: string; reason: string }>;
  identities?: ReviewerIdentitiesPublic;
}

export interface ExecutedRoutePublic {
  head_sha: string;
  planner: RouteRolePublic;
  coder: RouteRolePublic;
  reviewer: RouteRolePublic;
}

// ── Reconciliation input ────────────────────────────────────────────────────

export type ReconcilerStage = 'planning' | 'coding' | 'review';

export interface InheritedStageDescriptor {
  stage: ReconcilerStage;
  sourceIssue: string;
  sourceHeadSha: string;
}

export interface ReconcileInput {
  issueId: string;
  prHeadSha: string;
  stageResults: Partial<Record<StageName, StageResult>>;
  inheritedStages?: InheritedStageDescriptor[];
}

// ── Reconciliation output ───────────────────────────────────────────────────

export interface ReconcileResult {
  route: ExecutedRoutePublic;
  diagnostics: string[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const ROLE_STAGE_MAP: Record<'planner' | 'coder' | 'reviewer', StageName> = {
  planner: 'planning',
  coder: 'coding',
  reviewer: 'review',
};

function projectIdentity(identity: ExecutedIdentity): RouteRoleIdentityPublic {
  return {
    model: identity.resolvedModel,
    pinned: identity.pinned,
    source: identity.source,
  };
}

function reconcileRole(
  role: 'planner' | 'coder' | 'reviewer',
  input: ReconcileInput,
  diagnostics: string[],
): RouteRolePublic {
  const stageName = ROLE_STAGE_MAP[role];
  const inherited = input.inheritedStages?.find((s) => s.stage === (role === 'reviewer' ? 'review' : stageName as ReconcilerStage));

  if (inherited) {
    return {
      status: 'inherited',
      model: null,
      inherited_from: { issue: inherited.sourceIssue, head_sha: inherited.sourceHeadSha },
    };
  }

  const result = input.stageResults[stageName];
  if (!result) {
    diagnostics.push(`${role}: no stage result found`);
    return { status: 'unknown', model: null };
  }

  if (result.status !== 'completed') {
    if (result.status === 'aborted' || result.status === 'failed') {
      return { status: 'not_run', model: null, evidence_source: 'stage-result' };
    }
    diagnostics.push(`${role}: stage status is ${result.status}, not completed`);
    return { status: 'unknown', model: null };
  }

  if (result.executionEvidence?.status === 'contradicted') {
    diagnostics.push(`${role}: execution evidence contradicted`);
    return { status: 'unknown', model: null, evidence_source: 'stage-result' };
  }

  if (result.executionEvidence?.status === 'inherited') {
    return {
      status: 'inherited',
      model: result.executedModel ?? null,
      evidence_source: 'stage-result',
    };
  }

  const executedModel = result.executedModel ?? null;
  if (!executedModel && result.executionEvidence?.status !== 'direct') {
    diagnostics.push(`${role}: no executed model and no direct evidence`);
    return { status: 'unknown', model: null, evidence_source: 'stage-result' };
  }

  const entry: RouteRolePublic = {
    status: 'executed',
    model: executedModel,
    evidence_source: result.executionEvidence?.source ?? 'stage-result',
  };

  if (result.intendedModel && result.intendedModel !== executedModel) {
    entry.requested_selector = result.intendedModel;
  }

  entry.adapter = result.agent;

  if (role === 'reviewer') {
    const reviewArtifacts = result.artifacts as ReviewArtifacts | undefined;
    const reviewIdentity = reviewArtifacts?.reviewExecutedIdentity;
    if (reviewIdentity) {
      entry.identities = projectReviewerIdentities(reviewIdentity);
      entry.model = reviewIdentity.substantiveAnalysis.resolvedModel;
      entry.evidence_source = 'review-executed-identity';
    }
  }

  return entry;
}

function projectReviewerIdentities(identity: ReviewExecutedIdentitySet): ReviewerIdentitiesPublic {
  const result: ReviewerIdentitiesPublic = {
    orchestrator: projectIdentity(identity.orchestrator),
    substantive_analysis: projectIdentity(identity.substantiveAnalysis),
  };

  if (identity.remediation) {
    result.remediation = projectIdentity(identity.remediation);
  } else if (identity.remediation === null) {
    result.remediation = null;
  }

  return result;
}

// ── Public API ──────────────────────────────────────────────────────────────

export function reconcileRoute(input: ReconcileInput): ReconcileResult {
  const diagnostics: string[] = [];

  const route: ExecutedRoutePublic = {
    head_sha: input.prHeadSha,
    planner: reconcileRole('planner', input, diagnostics),
    coder: reconcileRole('coder', input, diagnostics),
    reviewer: reconcileRole('reviewer', input, diagnostics),
  };

  return { route, diagnostics };
}

export function renderExecutedRoute(route: ExecutedRoutePublic): string {
  return JSON.stringify(route);
}

export function isRouteReadyGateComplete(route: ExecutedRoutePublic): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const role of ['planner', 'coder', 'reviewer'] as const) {
    const entry = route[role];
    if (entry.status === 'unknown') {
      reasons.push(`${role}: status is unknown`);
    }
  }
  return { pass: reasons.length === 0, reasons };
}
