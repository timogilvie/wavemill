import type {
  EvalExecutionEconomics,
  EvalRecord,
  EvalRouting,
  RoutingRole,
  WorkflowCostAttributionCoverage,
} from './eval-schema.ts';
import { isEvalSuccess } from './eval-success-policy.ts';
import { routeBatch, type RouteBatchOptions, type RouteBatchResult } from './route-batch.ts';
import type { WorkflowRouteDecision } from './workflow-router.ts';

export const SUBAGENT_MODEL_ECONOMICS_POLICY_VERSION = '1.0.0';

const ROUTING_ROLES = ['planner', 'coder', 'reviewer'] as const satisfies readonly RoutingRole[];
const MIN_RECOMMENDATION_COVERAGE = 0.6;
const MIN_RECOMMENDATION_CONFIDENCE = 0.55;
const MIN_RECOMMENDATION_NEIGHBORS = 3;

export type SubagentEconomicsAbstentionReason =
  | 'missing_proposed_route'
  | 'missing_executed_model_identity'
  | 'executed_model_identity_conflict'
  | 'missing_cost_coverage'
  | 'partial_cost_coverage'
  | 'missing_budget'
  | 'missing_outcome'
  | 'low_confidence'
  | 'sparse_strata'
  | 'paired_evidence_incomplete';

export type SubagentEconomicsEvidenceKind = 'observational' | 'paired_replay';
export type SubagentEconomicsRecommendation = 'proceed' | 'collect_more_data' | 'stop';

export interface SubagentEconomicsAssignment {
  planner: string;
  coder: string;
  reviewer: string;
}

export interface SubagentEconomicsExpectedEconomics {
  success: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  confidence: number | null;
}

export interface SubagentEconomicsUncertainty {
  confidence: number | null;
  neighborCount: number | null;
  neighborSimilarityRange: [number, number] | null;
  sparse: boolean;
  lowConfidence: boolean;
}

export interface SubagentEconomicsCoverage {
  executedModelIdentity: 'exact' | 'missing' | 'conflict';
  cost: WorkflowCostAttributionCoverage | 'missing' | 'unknown';
  outcome: 'available' | 'missing';
  budget: 'available' | 'missing';
}

export interface SubagentEconomicsActualOutcome {
  costUsd: number | null;
  success: boolean | null;
  latencyMs: number | null;
  maxCostUsd: number | null;
}

export interface SubagentEconomicsObservationalDelta {
  expectedSuccessDelta: number | null;
  expectedCostDeltaUsd: number | null;
  label: 'non_causal_observational';
}

export interface SubagentEconomicsPairedEvidence {
  pairId: string;
  actualArms: Array<{
    recordId: string;
    side: string | null;
    assignment: SubagentEconomicsAssignment;
    costUsd: number;
    success: boolean;
  }>;
  costDeltaUsd: number | null;
  successDelta: number | null;
  label: 'paired_replay_causal';
}

export interface SubagentEconomicsWorkflowReport {
  schemaVersion: typeof SUBAGENT_MODEL_ECONOMICS_POLICY_VERSION;
  policy: 'subagent_model_economics_shadow';
  evidenceKind: SubagentEconomicsEvidenceKind;
  task: {
    recordId?: string;
    issueId?: string;
    challengePairId?: string;
    taskType?: string;
    roleStrata: RoutingRole[];
    modelsAvailable: string[];
  };
  proposed: {
    assignment: SubagentEconomicsAssignment | null;
    expected: SubagentEconomicsExpectedEconomics;
    uncertainty: SubagentEconomicsUncertainty;
  };
  actual: {
    assignment: SubagentEconomicsAssignment | null;
    provenance: Partial<Record<RoutingRole, string>>;
    outcome: SubagentEconomicsActualOutcome;
  };
  coverage: SubagentEconomicsCoverage;
  agreement: boolean | null;
  abstentionReasons: SubagentEconomicsAbstentionReason[];
  observationalDelta: SubagentEconomicsObservationalDelta | null;
  pairedEvidence?: SubagentEconomicsPairedEvidence | null;
  recommendation: {
    gate: SubagentEconomicsRecommendation;
    reasons: string[];
  };
}

export interface SubagentEconomicsSummary {
  schemaVersion: typeof SUBAGENT_MODEL_ECONOMICS_POLICY_VERSION;
  policy: 'subagent_model_economics_shadow';
  totalWorkflows: number;
  eligibleWorkflows: number;
  abstainedWorkflows: number;
  agreementRate: number | null;
  disagreementRate: number | null;
  pairedEvidenceCount: number;
  coverage: {
    executedModelIdentity: number;
    cost: number;
    outcome: number;
    budget: number;
  };
  recommendation: {
    gate: SubagentEconomicsRecommendation;
    reasons: string[];
  };
}

export interface SubagentEconomicsReport {
  schemaVersion: typeof SUBAGENT_MODEL_ECONOMICS_POLICY_VERSION;
  policy: 'subagent_model_economics_shadow';
  generatedAt: string;
  summary: SubagentEconomicsSummary;
  workflows: SubagentEconomicsWorkflowReport[];
}

export interface BuildSubagentEconomicsPolicyReportInput {
  record?: EvalRecord;
  prompt?: string;
  issueId?: string;
  proposedDecision?: WorkflowRouteDecision | null;
  actualRoute?: Partial<SubagentEconomicsAssignment> | null;
  modelsAvailable?: string[];
  maxCostUsd?: number | null;
  pairedRecords?: EvalRecord[];
}

export interface BuildSubagentEconomicsPolicyReportOptions {
  minConfidence?: number;
  minNeighborCount?: number;
}

export interface RunSubagentEconomicsShadowPolicyInput extends BuildSubagentEconomicsPolicyReportInput {
  repoDir: string;
  routeOptions?: RouteBatchOptions;
  routeBatchImpl?: typeof routeBatch;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function finiteNonNegative(value: unknown): value is number {
  return finiteNumber(value) && value >= 0;
}

function roundMetric(value: number): number {
  return Number(value.toFixed(6));
}

function assignmentFromDecision(decision: WorkflowRouteDecision | null | undefined): SubagentEconomicsAssignment | null {
  if (!decision?.planner || !decision.coder || !decision.reviewer) {
    return null;
  }
  return {
    planner: decision.planner,
    coder: decision.coder,
    reviewer: decision.reviewer,
  };
}

function assignmentFromPartial(
  value: Partial<SubagentEconomicsAssignment> | null | undefined,
): SubagentEconomicsAssignment | null {
  if (!value?.planner || !value.coder || !value.reviewer) {
    return null;
  }
  return {
    planner: value.planner,
    coder: value.coder,
    reviewer: value.reviewer,
  };
}

function routingAssignment(routing: EvalRouting | undefined): {
  assignment: SubagentEconomicsAssignment | null;
  provenance: Partial<Record<RoutingRole, string>>;
} {
  const provenance: Partial<Record<RoutingRole, string>> = {};
  const assignment: Partial<SubagentEconomicsAssignment> = {};

  for (const role of ROUTING_ROLES) {
    const decision = routing?.[role];
    if (!decision?.resolvedModelId) {
      continue;
    }
    assignment[role] = decision.resolvedModelId;
    provenance[role] = decision.resolutionSource || decision.sourceLayer || 'EvalRecord.routing';
  }

  return {
    assignment: assignmentFromPartial(assignment),
    provenance,
  };
}

function executionEconomicsAssignment(economics: EvalExecutionEconomics[] | undefined): {
  assignment: Partial<SubagentEconomicsAssignment>;
  conflicts: string[];
  incompleteRoleAttribution: boolean;
  provenance: Partial<Record<RoutingRole, string>>;
} {
  const byRole: Record<RoutingRole, Set<string>> = {
    planner: new Set(),
    coder: new Set(),
    reviewer: new Set(),
  };
  const conflicts: string[] = [];
  let incompleteRoleAttribution = false;
  const provenance: Partial<Record<RoutingRole, string>> = {};

  for (const block of economics ?? []) {
    for (const session of block.sessions) {
      if (session.stageRole.confidence === 'unattributed') {
        incompleteRoleAttribution = true;
        continue;
      }
      const stageRole = session.stageRole.value;
      const role: RoutingRole | null = stageRole === 'planning'
        ? 'planner'
        : stageRole === 'coding'
          ? 'coder'
          : stageRole === 'review'
            ? 'reviewer'
            : null;
      if (!role) {
        incompleteRoleAttribution = true;
        continue;
      }
      const model = session.models.executed ?? session.models.resolved;
      if (!model) {
        continue;
      }
      byRole[role].add(model);
      provenance[role] = `executionEconomics:${block.harness}`;
      if (session.models.conflict) {
        conflicts.push(`${role}:${session.models.conflict.detail}`);
      }
    }
  }

  const assignment: Partial<SubagentEconomicsAssignment> = {};
  for (const role of ROUTING_ROLES) {
    if (byRole[role].size === 1) {
      assignment[role] = [...byRole[role]][0];
    } else if (byRole[role].size > 1) {
      conflicts.push(`${role}:multiple_executed_models`);
    }
  }

  return { assignment, conflicts, incompleteRoleAttribution, provenance };
}

function resolveExecutedAssignment(input: BuildSubagentEconomicsPolicyReportInput): {
  assignment: SubagentEconomicsAssignment | null;
  provenance: Partial<Record<RoutingRole, string>>;
  identityCoverage: SubagentEconomicsCoverage['executedModelIdentity'];
} {
  const explicit = assignmentFromPartial(input.actualRoute);
  const fromRouting = routingAssignment(input.record?.routing);
  const fromEconomics = executionEconomicsAssignment(input.record?.executionEconomics);
  const provenance: Partial<Record<RoutingRole, string>> = {
    ...fromRouting.provenance,
    ...fromEconomics.provenance,
  };

  if (explicit) {
    for (const role of ROUTING_ROLES) {
      provenance[role] = provenance[role] || 'route-artifact';
    }
  }

  const base = explicit ?? fromRouting.assignment;
  const economicsComplete = assignmentFromPartial(fromEconomics.assignment);

  if (fromEconomics.conflicts.length > 0) {
    return { assignment: base ?? economicsComplete, provenance, identityCoverage: 'conflict' };
  }

  if (fromEconomics.incompleteRoleAttribution) {
    return { assignment: base ?? economicsComplete, provenance, identityCoverage: 'missing' };
  }

  if (base && economicsComplete) {
    const hasConflict = ROUTING_ROLES.some((role) => base[role] !== economicsComplete[role]);
    if (hasConflict) {
      return { assignment: base, provenance, identityCoverage: 'conflict' };
    }
  }

  const assignment = economicsComplete ?? base;
  return {
    assignment,
    provenance,
    identityCoverage: assignment ? 'exact' : 'missing',
  };
}

function costCoverage(record: EvalRecord | undefined): SubagentEconomicsCoverage['cost'] {
  if (record?.workflowCostAttribution?.coverage) {
    return record.workflowCostAttribution.coverage;
  }
  const economicsCoverage = record?.executionEconomics?.map((block) => block.coverage) ?? [];
  if (economicsCoverage.includes('partial')) return 'partial';
  if (economicsCoverage.includes('unavailable')) return 'unavailable';
  if (economicsCoverage.length > 0 && economicsCoverage.every((coverage) => coverage === 'known_zero')) {
    return 'known_zero';
  }
  if (economicsCoverage.length > 0 && economicsCoverage.every((coverage) => coverage === 'complete' || coverage === 'known_zero')) {
    return 'complete';
  }
  if (record && finiteNonNegative(record.workflowCost ?? record.estimatedCost)) {
    return 'unknown';
  }
  return 'missing';
}

function actualCost(record: EvalRecord | undefined): number | null {
  const value = record?.workflowCost ?? record?.estimatedCost;
  return finiteNonNegative(value) ? value : null;
}

function outcomeCoverage(record: EvalRecord | undefined): SubagentEconomicsCoverage['outcome'] {
  if (!record) return 'missing';
  if (typeof record.outcomes?.success === 'boolean') return 'available';
  if (finiteNumber(record.score)) return 'available';
  return 'missing';
}

function actualSuccess(record: EvalRecord | undefined): boolean | null {
  return outcomeCoverage(record) === 'available' ? isEvalSuccess(record) : null;
}

function budgetFrom(input: BuildSubagentEconomicsPolicyReportInput): number | null {
  const value = input.maxCostUsd ?? input.record?.constraints?.maxCostUsd ?? input.proposedDecision?.constraints?.maxCostUsd ?? input.proposedDecision?.maxCostUsd;
  return finiteNonNegative(value) ? value : null;
}

function expectedCost(decision: WorkflowRouteDecision | null | undefined): number | null {
  if (!decision) return null;
  const explicit = (decision as WorkflowRouteDecision & { expectedCost?: unknown }).expectedCost;
  if (finiteNonNegative(explicit)) return explicit;
  const summed = decision.expectedCostPlan + decision.expectedCostCode + decision.expectedCostReview;
  return finiteNonNegative(summed) ? summed : null;
}

function neighborCount(decision: WorkflowRouteDecision | null | undefined): number | null {
  const value = (decision as WorkflowRouteDecision & { neighborCount?: unknown } | null | undefined)?.neighborCount;
  return finiteNonNegative(value) ? value : null;
}

function neighborSimilarityRange(decision: WorkflowRouteDecision | null | undefined): [number, number] | null {
  const value = (decision as WorkflowRouteDecision & { neighborSimilarityRange?: unknown } | null | undefined)?.neighborSimilarityRange;
  if (
    Array.isArray(value)
    && value.length === 2
    && finiteNumber(value[0])
    && finiteNumber(value[1])
  ) {
    return [value[0], value[1]];
  }
  return null;
}

function taskTypeFrom(record: EvalRecord | undefined, decision: WorkflowRouteDecision | null | undefined): string | undefined {
  return record?.taskContext?.taskType
    ?? record?.taskDescriptor?.signals?.heuristic?.task_type
    ?? decision?.signals?.taskType;
}

function uniqueModels(
  modelsAvailable: string[] | undefined,
  proposed: SubagentEconomicsAssignment | null,
  actual: SubagentEconomicsAssignment | null,
): string[] {
  const models = new Set<string>();
  for (const model of modelsAvailable ?? []) models.add(model);
  for (const assignment of [proposed, actual]) {
    if (!assignment) continue;
    for (const role of ROUTING_ROLES) models.add(assignment[role]);
  }
  return [...models].sort();
}

function addReason(reasons: SubagentEconomicsAbstentionReason[], reason: SubagentEconomicsAbstentionReason): void {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
}

function coverageKnownEnough(coverage: SubagentEconomicsCoverage['cost']): boolean {
  return coverage === 'complete' || coverage === 'known_zero';
}

function buildPairedEvidence(
  input: BuildSubagentEconomicsPolicyReportInput,
): SubagentEconomicsPairedEvidence | null {
  const record = input.record;
  if (!record?.challengePairId || !input.pairedRecords || input.pairedRecords.length === 0) {
    return null;
  }

  const arms = [record, ...input.pairedRecords]
    .filter((candidate, index, all) => candidate.challengePairId === record.challengePairId
      && all.findIndex((item) => item.id === candidate.id) === index)
    .map((candidate) => {
      const assignment = resolveExecutedAssignment({ record: candidate }).assignment;
      const cost = actualCost(candidate);
      const success = actualSuccess(candidate);
      const coverage = costCoverage(candidate);
      if (!assignment || cost === null || success === null || !coverageKnownEnough(coverage)) {
        return null;
      }
      return {
        recordId: candidate.id,
        side: candidate.challengeSide ?? null,
        assignment,
        costUsd: cost,
        success,
      };
    })
    .filter((arm): arm is NonNullable<typeof arm> => Boolean(arm));

  if (arms.length < 2) {
    return null;
  }

  const primary = arms[0];
  const challenger = arms.find((arm) => arm.recordId !== primary.recordId) ?? arms[1];

  return {
    pairId: record.challengePairId,
    actualArms: arms,
    costDeltaUsd: roundMetric(challenger.costUsd - primary.costUsd),
    successDelta: Number((Number(challenger.success) - Number(primary.success)).toFixed(6)),
    label: 'paired_replay_causal',
  };
}

export function buildSubagentEconomicsWorkflowReport(
  input: BuildSubagentEconomicsPolicyReportInput,
  options: BuildSubagentEconomicsPolicyReportOptions = {},
): SubagentEconomicsWorkflowReport {
  const proposedAssignment = assignmentFromDecision(input.proposedDecision);
  const executed = resolveExecutedAssignment(input);
  const cost = actualCost(input.record);
  const success = actualSuccess(input.record);
  const maxCostUsd = budgetFrom(input);
  const costStatus = costCoverage(input.record);
  const outcomeStatus = outcomeCoverage(input.record);
  const confidence = finiteNumber(input.proposedDecision?.confidence) ? input.proposedDecision.confidence : null;
  const neighbors = neighborCount(input.proposedDecision);
  const minConfidence = options.minConfidence ?? MIN_RECOMMENDATION_CONFIDENCE;
  const minNeighborCount = options.minNeighborCount ?? MIN_RECOMMENDATION_NEIGHBORS;
  const sparse = neighbors !== null && neighbors < minNeighborCount;
  const lowConfidence = confidence !== null && confidence < minConfidence;
  const abstentionReasons: SubagentEconomicsAbstentionReason[] = [];

  if (!proposedAssignment) addReason(abstentionReasons, 'missing_proposed_route');
  if (executed.identityCoverage === 'missing') addReason(abstentionReasons, 'missing_executed_model_identity');
  if (executed.identityCoverage === 'conflict') addReason(abstentionReasons, 'executed_model_identity_conflict');
  if (costStatus === 'missing' || costStatus === 'unknown' || cost === null) addReason(abstentionReasons, 'missing_cost_coverage');
  if (costStatus === 'partial' || costStatus === 'unavailable') addReason(abstentionReasons, 'partial_cost_coverage');
  if (maxCostUsd === null) addReason(abstentionReasons, 'missing_budget');
  if (outcomeStatus === 'missing' || success === null) addReason(abstentionReasons, 'missing_outcome');
  if (lowConfidence) addReason(abstentionReasons, 'low_confidence');
  if (sparse) addReason(abstentionReasons, 'sparse_strata');

  const agreement = proposedAssignment && executed.assignment
    ? ROUTING_ROLES.every((role) => proposedAssignment[role] === executed.assignment?.[role])
    : null;
  const expected = expectedCost(input.proposedDecision);
  const actualLatencyMs = finiteNumber(input.record?.timeSeconds)
    ? Math.max(0, input.record.timeSeconds * 1000)
    : null;
  const observationalDelta = proposedAssignment && executed.assignment
    ? {
        expectedSuccessDelta: finiteNumber(input.proposedDecision?.expectedSuccess) && success !== null
          ? roundMetric(input.proposedDecision.expectedSuccess - Number(success))
          : null,
        expectedCostDeltaUsd: expected !== null && cost !== null ? roundMetric(expected - cost) : null,
        label: 'non_causal_observational' as const,
      }
    : null;
  const pairedEvidence = buildPairedEvidence(input);

  if (input.record?.challengePairId && !pairedEvidence) {
    addReason(abstentionReasons, 'paired_evidence_incomplete');
  }

  const eligible = abstentionReasons.length === 0;
  const recommendationGate: SubagentEconomicsRecommendation = eligible
    ? pairedEvidence
      ? 'proceed'
      : 'collect_more_data'
    : abstentionReasons.includes('executed_model_identity_conflict')
      ? 'stop'
      : 'collect_more_data';

  return {
    schemaVersion: SUBAGENT_MODEL_ECONOMICS_POLICY_VERSION,
    policy: 'subagent_model_economics_shadow',
    evidenceKind: pairedEvidence ? 'paired_replay' : 'observational',
    task: {
      recordId: input.record?.id,
      issueId: input.issueId ?? input.record?.issueId,
      challengePairId: input.record?.challengePairId,
      taskType: taskTypeFrom(input.record, input.proposedDecision),
      roleStrata: [...ROUTING_ROLES],
      modelsAvailable: uniqueModels(input.modelsAvailable, proposedAssignment, executed.assignment),
    },
    proposed: {
      assignment: proposedAssignment,
      expected: {
        success: finiteNumber(input.proposedDecision?.expectedSuccess) ? input.proposedDecision.expectedSuccess : null,
        costUsd: expected,
        latencyMs: null,
        confidence,
      },
      uncertainty: {
        confidence,
        neighborCount: neighbors,
        neighborSimilarityRange: neighborSimilarityRange(input.proposedDecision),
        sparse,
        lowConfidence,
      },
    },
    actual: {
      assignment: executed.assignment,
      provenance: executed.provenance,
      outcome: {
        costUsd: cost,
        success,
        latencyMs: actualLatencyMs,
        maxCostUsd,
      },
    },
    coverage: {
      executedModelIdentity: executed.identityCoverage,
      cost: costStatus,
      outcome: outcomeStatus,
      budget: maxCostUsd === null ? 'missing' : 'available',
    },
    agreement,
    abstentionReasons,
    observationalDelta,
    pairedEvidence,
    recommendation: {
      gate: recommendationGate,
      reasons: eligible
        ? [
            pairedEvidence
              ? 'Eligible paired replay evidence is available.'
              : 'Eligible one-arm historical evidence is observational only.',
          ]
        : abstentionReasons,
    },
  };
}

export function summarizeSubagentEconomicsReports(
  workflows: SubagentEconomicsWorkflowReport[],
): SubagentEconomicsSummary {
  const total = workflows.length;
  const eligible = workflows.filter((workflow) => workflow.abstentionReasons.length === 0);
  const agreements = eligible.filter((workflow) => workflow.agreement === true).length;
  const disagreements = eligible.filter((workflow) => workflow.agreement === false).length;
  const pairedEvidenceCount = workflows.filter((workflow) => workflow.pairedEvidence).length;
  const coverage = {
    executedModelIdentity: total > 0
      ? roundMetric(workflows.filter((workflow) => workflow.coverage.executedModelIdentity === 'exact').length / total)
      : 0,
    cost: total > 0
      ? roundMetric(workflows.filter((workflow) => coverageKnownEnough(workflow.coverage.cost)).length / total)
      : 0,
    outcome: total > 0
      ? roundMetric(workflows.filter((workflow) => workflow.coverage.outcome === 'available').length / total)
      : 0,
    budget: total > 0
      ? roundMetric(workflows.filter((workflow) => workflow.coverage.budget === 'available').length / total)
      : 0,
  };
  const eligibleCoverage = total > 0 ? eligible.length / total : 0;
  const conflictCount = workflows.filter((workflow) => workflow.abstentionReasons.includes('executed_model_identity_conflict')).length;
  const gate: SubagentEconomicsRecommendation = conflictCount > 0
    ? 'stop'
    : eligibleCoverage >= MIN_RECOMMENDATION_COVERAGE && pairedEvidenceCount > 0
      ? 'proceed'
      : 'collect_more_data';
  const reasons: string[] = [];

  if (conflictCount > 0) {
    reasons.push(`${conflictCount} workflow(s) have conflicting executed-model identity.`);
  }
  if (eligibleCoverage < MIN_RECOMMENDATION_COVERAGE) {
    reasons.push(`Eligible coverage ${roundMetric(eligibleCoverage)} is below ${MIN_RECOMMENDATION_COVERAGE}.`);
  }
  if (pairedEvidenceCount === 0) {
    reasons.push('No paired replay evidence is available; disagreements are observational only.');
  }
  if (reasons.length === 0) {
    reasons.push('Coverage and paired replay evidence are sufficient for a later enforcement review.');
  }

  return {
    schemaVersion: SUBAGENT_MODEL_ECONOMICS_POLICY_VERSION,
    policy: 'subagent_model_economics_shadow',
    totalWorkflows: total,
    eligibleWorkflows: eligible.length,
    abstainedWorkflows: total - eligible.length,
    agreementRate: eligible.length > 0 ? roundMetric(agreements / eligible.length) : null,
    disagreementRate: eligible.length > 0 ? roundMetric(disagreements / eligible.length) : null,
    pairedEvidenceCount,
    coverage,
    recommendation: {
      gate,
      reasons,
    },
  };
}

export function buildSubagentEconomicsReport(
  workflows: SubagentEconomicsWorkflowReport[],
  generatedAt = new Date().toISOString(),
): SubagentEconomicsReport {
  return {
    schemaVersion: SUBAGENT_MODEL_ECONOMICS_POLICY_VERSION,
    policy: 'subagent_model_economics_shadow',
    generatedAt,
    summary: summarizeSubagentEconomicsReports(workflows),
    workflows,
  };
}

export async function runSubagentEconomicsShadowPolicy(
  input: RunSubagentEconomicsShadowPolicyInput,
): Promise<SubagentEconomicsWorkflowReport> {
  let decision = input.proposedDecision ?? null;

  if (!decision && input.prompt) {
    const routeBatchImpl = input.routeBatchImpl ?? routeBatch;
    const results: RouteBatchResult[] = await routeBatchImpl(
      [{ issueId: input.issueId ?? input.record?.issueId, prompt: input.prompt }],
      {
        repoDir: input.repoDir,
        modelsAvailable: input.modelsAvailable,
        maxCostUsd: input.maxCostUsd ?? input.record?.constraints?.maxCostUsd,
        mode: 'stage-aware',
        ...input.routeOptions,
      },
    );
    decision = results[0]?.decision ?? null;
  }

  return buildSubagentEconomicsWorkflowReport({
    ...input,
    proposedDecision: decision,
  });
}
