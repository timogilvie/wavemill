/**
 * Execution economics — normalize external harness (Claude Code / Codex)
 * session telemetry into the versioned, provider-independent
 * `EvalExecutionEconomics` contract and join it to Wavemill route intent
 * (HOK-2958).
 *
 * Invariants:
 * - A missing or unpriced value is `null` + an availability marker, never `0`.
 * - Route intent and executed telemetry disagreements are surfaced as an
 *   explicit `conflict`, never coerced.
 * - A session's stage label and kind are read from the launch row in
 *   `.session-ownership.jsonl` that names it (`ownershipStageRole`); a worktree
 *   session no launch recorded is `operator` / `unowned` and carries no cost
 *   (HOK-3328). No timestamp window decides ownership.
 * - Per-session cost is copied from the `@hokusai/costs` report for that
 *   session (`meterWorkflowCost` → `sessionCosts`); this module prices nothing.
 * - Raw source entries are never spread into records; the adapters copy only
 *   allowlisted fields, and this module only consumes those.
 *
 * @module execution-economics
 */

import {
  EXECUTION_ECONOMICS_SCHEMA_VERSION,
  type EvalExecutionEconomics,
  type EvalRouting,
  type ExecutionEconomicsHarness,
  type ExecutionEconomicsModelIdentity,
  type ExecutionEconomicsSession,
  type ExecutionEconomicsTokenUsage,
  type ExecutionEconomicsTurn,
  type FieldAvailability,
  type RoutingRole,
  type WorkflowCostAttributionCoverage,
} from './eval-schema.ts';
import {
  ClaudeSessionAdapter,
  CodexSessionAdapter,
  type ExternalSessionTurn,
  type ExternalSessionUsageRecord,
  type ExternalTurnUsage,
  type SessionUsageResult,
} from './session-adapters.ts';
import { indexBySessionRef, ownershipStageRole, type SessionOwnershipRow } from './session-ownership.ts';
import type { OwnedSessionCost } from './sdk-task-cost/meter.ts';
import { getEffectiveRegistry, resolveModelRegistryKey, type ModelSelector } from './model-registry.ts';

/** Contract version implemented per harness parser. */
export const PROVIDER_CONTRACT_VERSIONS: Record<ExecutionEconomicsHarness, string> = {
  'claude-code': 'claude-code/1',
  codex: 'codex/1',
};

/** Default cap on persisted per-turn rows per session (D3). */
export const DEFAULT_TURN_CAP = 400;

const STAGE_TO_ROUTING_ROLE: Record<'planning' | 'coding' | 'review', RoutingRole> = {
  planning: 'planner',
  coding: 'coder',
  review: 'reviewer',
};

export interface BuildExecutionEconomicsInput {
  /** Adapter scan results whose `externalSessions` should be normalized. */
  scanResults: Array<SessionUsageResult | null | undefined>;
  issueId?: string | null;
  branch?: string | null;
  /** Resolved per-role route intent from routing.jsonl. */
  routing?: EvalRouting | null;
  /** The task's launch rows (`.session-ownership.jsonl`). */
  ownership?: readonly SessionOwnershipRow[] | null;
  /** `@hokusai/costs` figures per owned sessionRef (`meterWorkflowCost`). */
  sessionCosts?: ReadonlyMap<string, OwnedSessionCost> | null;
  repoDir?: string;
  turnCap?: number;
  now?: () => Date;
}

export interface CollectExecutionEconomicsInput {
  worktreePath: string;
  branchName: string;
  repoDir?: string;
  issueId?: string;
  routing?: EvalRouting | null;
  ownership?: readonly SessionOwnershipRow[] | null;
  sessionCosts?: ReadonlyMap<string, OwnedSessionCost> | null;
}

function renderModelSelector(selector: ModelSelector | undefined): string | null {
  if (!selector || typeof selector !== 'object') return null;
  switch (selector.kind) {
    case 'alias':
      return selector.channel ? `alias:${selector.family}@${selector.channel}` : `alias:${selector.family}`;
    case 'pinned':
      return `pinned:${selector.modelId}`;
    case 'inherit':
      return 'inherit';
    default:
      return null;
  }
}

function usageAvailability(usage: ExternalTurnUsage): FieldAvailability {
  const values = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    usage.reasoningTokens,
  ];
  if (values.every((value) => value === null)) return 'unavailable';
  if (usage.inputTokens === null || usage.outputTokens === null) return 'partial';
  return values.some((value) => value === null) ? 'partial' : 'available';
}

function toTokenUsage(usage: ExternalTurnUsage): ExecutionEconomicsTokenUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    reasoningTokens: usage.reasoningTokens,
  };
}

function toTurn(turn: ExternalSessionTurn): ExecutionEconomicsTurn {
  return {
    turnId: turn.turnId,
    parentId: turn.parentId,
    isSubagent: turn.isSubagent,
    model: turn.model,
    timestamp: turn.timestamp,
    usage: toTokenUsage(turn.usage),
    usageCoverage: usageAvailability(turn.usage),
    actualCostUsd: turn.actualCostUsd,
  };
}

/** Consecutive same-model turn runs, preserving model-switch structure. */
function computeModelSegments(turns: readonly ExternalSessionTurn[]): Array<{ model: string; turnCount: number }> {
  const segments: Array<{ model: string; turnCount: number }> = [];
  for (const turn of turns) {
    if (!turn.model) continue;
    const last = segments[segments.length - 1];
    if (last && last.model === turn.model) {
      last.turnCount++;
    } else {
      segments.push({ model: turn.model, turnCount: 1 });
    }
  }
  return segments;
}

function dominantModel(turns: readonly ExternalSessionTurn[]): string | null {
  const counts = new Map<string, number>();
  for (const turn of turns) {
    if (!turn.model) continue;
    counts.set(turn.model, (counts.get(turn.model) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [model, count] of counts) {
    if (count > bestCount) {
      best = model;
      bestCount = count;
    }
  }
  return best;
}

function buildModelIdentity(
  session: ExternalSessionUsageRecord,
  stageRole: ExecutionEconomicsSession['stageRole'],
  routing: EvalRouting | null | undefined,
  launchModel: string | null,
  repoDir: string | undefined,
): ExecutionEconomicsModelIdentity {
  const executed = dominantModel(session.turns);
  const provenance: ExecutionEconomicsModelIdentity['provenance'] = {};
  if (executed) {
    provenance.executed = 'session_telemetry';
  }

  const identity: ExecutionEconomicsModelIdentity = {
    requested: null,
    forced: null,
    resolved: null,
    executed,
    provenance,
  };

  // Route intent joins only apply when the session is attributed to a stage;
  // without a stage there is no role whose route this session should match.
  if (stageRole.value === null || !routing) {
    return identity;
  }

  const decision = routing[STAGE_TO_ROUTING_ROLE[stageRole.value]];
  if (!decision) {
    return identity;
  }

  identity.requested = renderModelSelector(decision.requestedSelector);
  identity.resolved = decision.resolvedModelId ?? null;
  if (identity.requested) provenance.requested = 'routing.jsonl';
  if (identity.resolved) provenance.resolved = 'routing.jsonl';

  // Conflict: the resolved route model was never observed executing in this
  // session's telemetry. When the launch row asked for the model the session
  // observed, record the disagreement against the route, not the telemetry.
  if (identity.resolved) {
    const registry = getEffectiveRegistry(repoDir);
    const canonical = (modelId: string) => resolveModelRegistryKey(registry, modelId);
    const executedModels = new Set(
      session.turns.map((turn) => turn.model).filter((m): m is string => !!m).map(canonical),
    );
    if (executedModels.size > 0 && !executedModels.has(canonical(identity.resolved))) {
      const stageModelAgrees = launchModel ? executedModels.has(canonical(launchModel)) : false;
      identity.conflict = {
        otherSource: 'session_telemetry',
        ...(executed ? { otherResolvedModel: executed } : {}),
        detail: stageModelAgrees
          ? `resolved route model ${identity.resolved} never observed in session telemetry; launch row agrees with telemetry`
          : `resolved route model ${identity.resolved} never observed in session telemetry`,
      };
    }
  }

  return identity;
}

function aggregateCoverage(
  coverages: readonly WorkflowCostAttributionCoverage[],
): WorkflowCostAttributionCoverage {
  if (coverages.length === 0) return 'unavailable';
  if (coverages.every((coverage) => coverage === 'complete')) return 'complete';
  if (coverages.every((coverage) => coverage === 'unavailable')) return 'unavailable';
  if (coverages.every((coverage) => coverage === 'known_zero')) return 'known_zero';
  return 'partial';
}

function normalizeSession(
  session: ExternalSessionUsageRecord,
  input: BuildExecutionEconomicsInput,
  owners: ReadonlyMap<string, SessionOwnershipRow>,
  nowIso: string,
  turnCap: number,
): ExecutionEconomicsSession {
  const diagnostics = [...session.diagnostics];
  const owner = owners.get(session.sessionId);
  const stageRole = ownershipStageRole(owner);
  const models = buildModelIdentity(session, stageRole, input.routing, owner?.model || null, input.repoDir);
  // Unowned sessions are reported, never charged to the task.
  const cost = owner ? input.sessionCosts?.get(session.sessionId) : undefined;
  if (!owner) {
    diagnostics.push('unowned session: excluded from task cost');
  } else if (!cost) {
    diagnostics.push('no @hokusai/costs report for this owned session');
  }

  const turnsTruncated = session.turns.length > turnCap;
  if (turnsTruncated) {
    diagnostics.push(`per-turn detail truncated to ${turnCap} of ${session.turns.length} turns`);
  }

  const actualCostUsd = cost?.actualUsd ?? null;
  const estimatedCostUsd = cost?.estimatedUsd ?? null;
  const costSource: ExecutionEconomicsSession['costSource'] = cost?.costSource ?? 'none';
  const coverage: WorkflowCostAttributionCoverage = cost?.coverage ?? 'unavailable';

  const fieldAvailability: Record<string, FieldAvailability> = {
    harnessVersion: session.harnessVersion !== null ? 'available' : 'unavailable',
    triggerSource: session.triggerSource !== null ? 'available' : 'unavailable',
    turnLineage: session.turns.length === 0
      ? 'unavailable'
      : session.turns.every((turn) => turn.turnId !== null)
        ? 'available'
        : session.turns.some((turn) => turn.turnId !== null)
          ? 'partial'
          : 'unavailable',
    perTurnUsage: session.turns.length === 0
      ? 'unavailable'
      : session.turns.every((turn) => turn.usageAvailable)
        ? 'available'
        : session.turns.some((turn) => turn.usageAvailable)
          ? 'partial'
          : 'unavailable',
    reasoningTokens: session.usage.reasoningTokens !== null ? 'available' : 'unavailable',
    cacheWriteTokens: session.usage.cacheWriteTokens !== null ? 'available' : 'unavailable',
    actualCost: actualCostUsd !== null
      ? actualCostUsd === 0 ? 'known_zero' : 'available'
      : 'unavailable',
  };

  return {
    sessionId: session.sessionId,
    rootSessionId: null,
    harnessVersion: session.harnessVersion,
    triggerSource: {
      value: session.triggerSource,
      provenance: session.triggerProvenance
        ?? (session.harness === 'codex' ? 'codex.session_meta.originator' : 'claude_code.promptSource'),
      availability: session.triggerSource !== null ? 'available' : 'unavailable',
    },
    stageRole,
    models,
    turnCount: session.turnCount,
    turns: session.turns.slice(0, turnCap).map(toTurn),
    turnsTruncated,
    modelSegments: computeModelSegments(session.turns),
    usage: toTokenUsage(session.usage),
    actualCostUsd,
    estimatedCostUsd,
    costSource,
    pricingRevision: estimatedCostUsd !== null ? cost?.pricingRevision ?? null : null,
    pricingTimestamp: estimatedCostUsd !== null ? nowIso : null,
    coverage,
    fieldAvailability,
    diagnostics,
  };
}

/**
 * Build normalized execution-economics blocks (one per harness) from adapter
 * scan results, the task's ownership rows and the SDK's per-session costs.
 * Pure aside from registry loading; never throws on missing evidence —
 * degraded inputs become availability diagnostics.
 */
export function buildExecutionEconomics(input: BuildExecutionEconomicsInput): EvalExecutionEconomics[] {
  const owners = indexBySessionRef(input.ownership ?? []);
  const nowIso = (input.now?.() ?? new Date()).toISOString();
  const turnCap = input.turnCap ?? DEFAULT_TURN_CAP;

  const blocks: EvalExecutionEconomics[] = [];
  for (const scanResult of input.scanResults) {
    const externalSessions = scanResult?.externalSessions;
    if (!externalSessions || externalSessions.length === 0) continue;

    const harness = externalSessions[0].harness;
    const sessions = externalSessions.map((session) => normalizeSession(session, input, owners, nowIso, turnCap));

    blocks.push({
      schemaVersion: EXECUTION_ECONOMICS_SCHEMA_VERSION,
      providerContractVersion: PROVIDER_CONTRACT_VERSIONS[harness],
      harness,
      joinEvidence: {
        issueId: input.issueId ?? null,
        branch: input.branch ?? null,
      },
      sessions,
      sessionCount: sessions.length,
      turnCount: sessions.reduce((sum, session) => sum + session.turnCount, 0),
      coverage: aggregateCoverage(sessions.map((session) => session.coverage)),
      collectedAt: nowIso,
    });
  }
  return blocks;
}

/**
 * Collect execution-economics blocks for a completed workflow: scans Claude
 * Code and Codex sessions for the branch/worktree and labels each from the
 * task's ownership rows. Fail-soft by design — callers wrap it, and every
 * missing input degrades to diagnostics.
 */
export async function collectExecutionEconomics(
  input: CollectExecutionEconomicsInput,
): Promise<EvalExecutionEconomics[]> {
  const scanOpts = {
    worktreePath: input.worktreePath,
    branchName: input.branchName,
    repoDir: input.repoDir,
    issueId: input.issueId,
  };
  return buildExecutionEconomics({
    scanResults: [
      new ClaudeSessionAdapter().scan(scanOpts),
      new CodexSessionAdapter().scan(scanOpts),
    ],
    issueId: input.issueId ?? null,
    branch: input.branchName ?? null,
    routing: input.routing,
    ownership: input.ownership,
    sessionCosts: input.sessionCosts,
    repoDir: input.repoDir,
  });
}
