import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutedIdentity, ReviewExecutedIdentitySet, StageResult } from './stage-result.ts';
import {
  PR_ROUTE_METADATA_SCHEMA_VERSION,
  type ExecutedPrRoute,
  type PrRouteEvidence,
  type PrRouteIdentity,
  type PrRouteReviewerRole,
  type PrRouteRole,
} from './pr-metadata.ts';

type RouteStage = 'planning' | 'coding' | 'review';
type RouteRole = 'planner' | 'coder' | 'reviewer';

export interface ReconcilePrRouteInput {
  issue: string;
  featureDir: string;
  currentHeadSha: string;
}

export interface ReconcilePrRouteDeps {
  readText(path: string): Promise<string | null>;
}

export interface ReconcilePrRouteResult {
  route: ExecutedPrRoute;
  diagnostics: string[];
  complete: boolean;
}

const DEFAULT_DEPS: ReconcilePrRouteDeps = {
  async readText(path: string): Promise<string | null> {
    try {
      return await readFile(path, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNestedString(value: unknown, path: readonly string[]): string | undefined {
  let cursor: unknown = value;
  for (const key of path) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[key];
  }
  return stringField(cursor);
}

function stageResultPath(featureDir: string, stage: RouteStage): string {
  return join(featureDir, `.${stage}-result.json`);
}

async function readStageResult(
  deps: ReconcilePrRouteDeps,
  featureDir: string,
  stage: RouteStage,
  diagnostics: string[],
): Promise<StageResult | null> {
  const text = await deps.readText(stageResultPath(featureDir, stage));
  if (text === null || !text.trim()) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed) || parsed.stage !== stage) {
      diagnostics.push(`${stage}: malformed stage result ignored`);
      return null;
    }
    return parsed as unknown as StageResult;
  } catch {
    diagnostics.push(`${stage}: malformed stage result ignored`);
    return null;
  }
}

async function readRoutingEvents(
  deps: ReconcilePrRouteDeps,
  featureDir: string,
  diagnostics: string[],
): Promise<Record<RouteRole, string | undefined>> {
  const text = await deps.readText(join(featureDir, 'routing.jsonl'));
  const requested: Record<RouteRole, string | undefined> = {
    planner: undefined,
    coder: undefined,
    reviewer: undefined,
  };
  if (text === null) return requested;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      diagnostics.push('routing: malformed jsonl line ignored');
      continue;
    }
    if (!isRecord(event)) continue;
    const route = isRecord(event.route) ? event.route : event;
    requested.planner = stringField(route.planner) ?? requested.planner;
    requested.coder = stringField(route.coder) ?? stringField(route.model) ?? requested.coder;
    requested.reviewer = stringField(route.reviewer) ?? requested.reviewer;
  }

  return requested;
}

function stageHeadSha(result: StageResult): string | undefined {
  const record = result as unknown as Record<string, unknown>;
  return stringField(record.headSha)
    ?? stringField(record.head_sha)
    ?? readNestedString(result.artifacts, ['headSha'])
    ?? readNestedString(result.artifacts, ['reviewHeadSha'])
    ?? readNestedString(result.artifacts, ['readyHeadSha'])
    ?? readNestedString(result.artifacts, ['launchHead'])
    ?? (() => {
      const iterations = isRecord(result.artifacts) && Array.isArray(result.artifacts.reviewIterations)
        ? result.artifacts.reviewIterations
        : [];
      const last = iterations.length > 0 ? iterations[iterations.length - 1] : undefined;
      return readNestedString(last, ['headSha']);
    })();
}

function evidenceFor(
  stage: RouteStage,
  result: StageResult | null,
  source: string,
  status: PrRouteEvidence['status'] | undefined,
  headSha: string | undefined,
  reason?: string,
): PrRouteEvidence {
  return {
    source: source || 'stage-result',
    ...(status ? { status } : {}),
    stage,
    ...(headSha ? { head_sha: headSha } : {}),
    ...(result?.source === 'inherited' ? { source_head_sha: headSha } : {}),
    ...(reason ? { reason } : {}),
  };
}

function unknownRole(
  role: RouteRole,
  stage: RouteStage,
  requestedSelector: string | undefined,
  result: StageResult | null,
  reason: string,
): PrRouteRole {
  return {
    status: 'unknown',
    ...(requestedSelector ? { requested_selector: requestedSelector } : {}),
    evidence: evidenceFor(
      stage,
      result,
      result?.executionEvidence?.source ?? 'stage-result',
      result?.executionEvidence?.status,
      result ? stageHeadSha(result) : undefined,
      reason,
    ),
  };
}

function notRunRole(role: RouteRole, stage: RouteStage, requestedSelector: string | undefined): PrRouteRole {
  return {
    status: 'not_run',
    ...(requestedSelector ? { requested_selector: requestedSelector } : {}),
    evidence: {
      source: 'stage-result',
      status: 'missing',
      stage,
      reason: `${role}_stage_result_missing`,
    },
  };
}

function reconcileSimpleRole(
  role: 'planner' | 'coder',
  stage: 'planning' | 'coding',
  result: StageResult | null,
  currentHeadSha: string,
  requestedFromRouting: string | undefined,
): PrRouteRole {
  const requestedSelector = result?.intendedModel ?? requestedFromRouting;
  if (!result) return notRunRole(role, stage, requestedSelector);

  const headSha = stageHeadSha(result);
  if (headSha && headSha !== currentHeadSha) {
    return unknownRole(role, stage, requestedSelector, result, 'stage_result_stale_head');
  }

  if (result.source === 'inherited' || result.executionEvidence?.status === 'inherited') {
    if (!result.executedModel) {
      return {
        status: 'inherited',
        ...(requestedSelector ? { requested_selector: requestedSelector } : {}),
        evidence: evidenceFor(stage, result, result.executionEvidence?.source ?? 'stage-result', 'inherited', headSha, 'inherited_without_executed_model'),
      };
    }
    return {
      status: 'inherited',
      requested_selector: requestedSelector ?? result.executedModel,
      resolved_model: result.executedModel,
      ...(result.agent ? { adapter: result.agent } : {}),
      source: 'inherited',
      pinned: false,
      evidence: evidenceFor(stage, result, result.executionEvidence?.source ?? 'stage-result', 'inherited', headSha),
    };
  }

  if (result.status !== 'completed') {
    return unknownRole(role, stage, requestedSelector, result, 'stage_not_completed');
  }
  if (!result.executedModel || result.executionEvidence?.status !== 'direct') {
    return unknownRole(role, stage, requestedSelector, result, result.executionEvidence?.status === 'contradicted' ? 'execution_contradicted' : 'missing_execution_evidence');
  }

  return {
    status: 'executed',
    requested_selector: requestedSelector ?? result.executedModel,
    resolved_model: result.executedModel,
    ...(result.agent ? { adapter: result.agent } : {}),
    source: 'artifact',
    pinned: requestedSelector === result.executedModel,
    ...(requestedSelector && requestedSelector !== result.executedModel ? { fallback_reason: 'runtime_fallback' } : {}),
    evidence: evidenceFor(stage, result, result.executionEvidence.source ?? 'stage-result', 'direct', headSha ?? currentHeadSha),
  };
}

function projectIdentity(identity: ExecutedIdentity | undefined): PrRouteIdentity | undefined {
  if (!identity) return undefined;
  const resolvedModel = stringField(identity.resolvedModel);
  if (!resolvedModel) return undefined;
  const requestedSelector = stringField(identity.requestedModel);
  return {
    ...(requestedSelector ? { requested_selector: requestedSelector } : {}),
    resolved_model: resolvedModel,
    ...(identity.agent ? { adapter: identity.agent } : {}),
    source: identity.source,
    pinned: identity.source === 'derived' ? false : identity.pinned,
    ...(identity.fallbackReason ? { fallback_reason: identity.fallbackReason } : {}),
    ...(identity.conflict ? {
      conflict: {
        other_source: identity.conflict.otherSource,
        other_resolved_model: identity.conflict.otherResolvedModel,
        detail: identity.conflict.detail,
      },
    } : {}),
  };
}

function reviewIdentitySet(result: StageResult): ReviewExecutedIdentitySet | undefined {
  const artifacts = result.artifacts;
  if (!isRecord(artifacts)) return undefined;
  const value = artifacts.reviewExecutedIdentity;
  if (!isRecord(value)) return undefined;
  return value as unknown as ReviewExecutedIdentitySet;
}

function reconcileReviewer(
  result: StageResult | null,
  currentHeadSha: string,
  requestedFromRouting: string | undefined,
): PrRouteReviewerRole {
  if (!result) {
    return {
      status: 'not_run',
      evidence: { source: 'stage-result', status: 'missing', stage: 'review', reason: 'review_stage_result_missing' },
      ...(requestedFromRouting ? { orchestrator: { requested_selector: requestedFromRouting } } : {}),
    };
  }

  const headSha = stageHeadSha(result);
  const evidence = evidenceFor('review', result, result.executionEvidence?.source ?? 'stage-result', result.executionEvidence?.status, headSha ?? currentHeadSha);
  if (headSha && headSha !== currentHeadSha) {
    return { status: 'unknown', evidence: { ...evidence, reason: 'stage_result_stale_head' } };
  }
  if (result.source === 'inherited' || result.executionEvidence?.status === 'inherited') {
    return { status: 'inherited', evidence: { ...evidence, status: 'inherited' } };
  }
  if (result.status !== 'completed') {
    return { status: 'unknown', evidence: { ...evidence, reason: 'stage_not_completed' } };
  }

  const identities = reviewIdentitySet(result);
  const orchestrator = projectIdentity(identities?.orchestrator);
  const substantiveAnalysis = projectIdentity(identities?.substantiveAnalysis);
  if (!orchestrator || !substantiveAnalysis) {
    return { status: 'unknown', evidence: { ...evidence, reason: 'missing_review_identity' } };
  }

  return {
    status: 'executed',
    evidence,
    orchestrator,
    substantiveAnalysis,
    ...(identities?.remediation ? { remediation: projectIdentity(identities.remediation) ?? null } : {}),
  };
}

function routeComplete(route: ExecutedPrRoute): boolean {
  const known = (status: string): boolean => status === 'executed' || status === 'inherited';
  return known(route.planner.status)
    && known(route.coder.status)
    && known(route.reviewer.status);
}

export async function reconcilePrRoute(
  input: ReconcilePrRouteInput,
  deps: ReconcilePrRouteDeps = DEFAULT_DEPS,
): Promise<ReconcilePrRouteResult> {
  const diagnostics: string[] = [];
  const [planning, coding, review, requested] = await Promise.all([
    readStageResult(deps, input.featureDir, 'planning', diagnostics),
    readStageResult(deps, input.featureDir, 'coding', diagnostics),
    readStageResult(deps, input.featureDir, 'review', diagnostics),
    readRoutingEvents(deps, input.featureDir, diagnostics),
  ]);

  const route: ExecutedPrRoute = {
    schema: PR_ROUTE_METADATA_SCHEMA_VERSION,
    issue: input.issue,
    head_sha: input.currentHeadSha,
    planner: reconcileSimpleRole('planner', 'planning', planning, input.currentHeadSha, requested.planner),
    coder: reconcileSimpleRole('coder', 'coding', coding, input.currentHeadSha, requested.coder),
    reviewer: reconcileReviewer(review, input.currentHeadSha, requested.reviewer),
  };

  if (route.planner.status !== 'executed' && route.planner.status !== 'inherited') {
    diagnostics.push(`planner: ${route.planner.evidence.reason ?? route.planner.status}`);
  }
  if (route.coder.status !== 'executed' && route.coder.status !== 'inherited') {
    diagnostics.push(`coder: ${route.coder.evidence.reason ?? route.coder.status}`);
  }
  if (route.reviewer.status !== 'executed' && route.reviewer.status !== 'inherited') {
    diagnostics.push(`reviewer: ${route.reviewer.evidence.reason ?? route.reviewer.status}`);
  }

  return {
    route,
    diagnostics,
    complete: routeComplete(route),
  };
}
