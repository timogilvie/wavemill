/**
 * Execution economics — normalize SDK per-session usage rows (@hokusai/costs)
 * for the task's owned Claude Code / Codex sessions into the versioned,
 * provider-independent `EvalExecutionEconomics` contract, joined to Wavemill
 * route intent (HOK-2958 / HOK-3407).
 *
 * Invariants:
 * - Session usage is read from the SDK's per-event rows (dedup'd on
 *   `eventKey`; Codex buckets disjoint via `normalizeCodexBuckets`), so
 *   session `usage` equals the SDK totals by construction.
 * - A missing or unpriced value is `null` + an availability marker, never `0`.
 * - Route intent and executed telemetry disagreements are surfaced as an
 *   explicit `conflict`, never coerced.
 * - A session's stage label and kind are read from the launch row in
 *   `.session-ownership.jsonl` that names it (`ownershipStageRole`); only
 *   sessions a launch owns ever appear as a session block (HOK-3328).
 * - Per-session cost is copied from the `@hokusai/costs` report for that
 *   session (`meterWorkflowCost` → `sessionCosts`); this module prices nothing.
 *
 * @module execution-economics
 */

import type { IngestUsageInput } from '@hokusai/costs';
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
  /** Per-session SDK usage rows, grouped by `sessionId` (HOK-3407). */
  sessionUsageRows: ReadonlyMap<string, readonly IngestUsageInput[]>;
  /** Harness tag per session, so we stamp the right provider contract version. */
  sessionHarness: ReadonlyMap<string, 'claude-code' | 'codex'>;
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
  /** Per-session SDK usage rows (HOK-3407). */
  sessionUsageRows: ReadonlyMap<string, readonly IngestUsageInput[]>;
  sessionHarness: ReadonlyMap<string, 'claude-code' | 'codex'>;
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

function usageAvailability(usage: ExecutionEconomicsTokenUsage): FieldAvailability {
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

function finiteNonNegativeOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Map one SDK row's partial token usage onto the null-preserving shape. */
function usageFromRow(row: IngestUsageInput): ExecutionEconomicsTokenUsage {
  const u = row.usage ?? {};
  return {
    inputTokens: finiteNonNegativeOrNull(u.input_tokens),
    outputTokens: finiteNonNegativeOrNull(u.output_tokens),
    cacheReadTokens: finiteNonNegativeOrNull(u.cache_read_tokens),
    cacheWriteTokens: finiteNonNegativeOrNull(u.cache_write_tokens),
    reasoningTokens: finiteNonNegativeOrNull(u.reasoning_tokens),
  };
}

function addObserved(total: number | null, value: number | null): number | null {
  if (value === null) return total;
  return (total ?? 0) + value;
}

function sumUsage(total: ExecutionEconomicsTokenUsage, turn: ExecutionEconomicsTokenUsage): void {
  total.inputTokens = addObserved(total.inputTokens, turn.inputTokens);
  total.outputTokens = addObserved(total.outputTokens, turn.outputTokens);
  total.cacheReadTokens = addObserved(total.cacheReadTokens, turn.cacheReadTokens);
  total.cacheWriteTokens = addObserved(total.cacheWriteTokens, turn.cacheWriteTokens);
  total.reasoningTokens = addObserved(total.reasoningTokens, turn.reasoningTokens);
}

function emptyUsage(): ExecutionEconomicsTokenUsage {
  return {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
  };
}

function toTurn(row: IngestUsageInput, usage: ExecutionEconomicsTokenUsage): ExecutionEconomicsTurn {
  return {
    turnId: row.turnId ?? null,
    parentId: row.parentEventId ?? null,
    isSubagent: typeof row.isSubagent === 'boolean' ? row.isSubagent : null,
    model: row.observedModel ?? null,
    timestamp: row.observedAt ?? null,
    usage,
    usageCoverage: usageAvailability(usage),
    actualCostUsd: finiteNonNegativeOrNull(row.actualCostUsd),
  };
}

/** Consecutive same-model turn runs, preserving model-switch structure. */
function computeModelSegments(turns: readonly ExecutionEconomicsTurn[]): Array<{ model: string; turnCount: number }> {
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

function dominantModel(turns: readonly ExecutionEconomicsTurn[]): string | null {
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
  turns: readonly ExecutionEconomicsTurn[],
  stageRole: ExecutionEconomicsSession['stageRole'],
  routing: EvalRouting | null | undefined,
  launchModel: string | null,
  repoDir: string | undefined,
): ExecutionEconomicsModelIdentity {
  const executed = dominantModel(turns);
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
      turns.map((turn) => turn.model).filter((m): m is string => !!m).map(canonical),
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

interface NormalizedSessionInput {
  sessionId: string;
  harness: 'claude-code' | 'codex';
  rows: readonly IngestUsageInput[];
}

function normalizeSession(
  session: NormalizedSessionInput,
  input: BuildExecutionEconomicsInput,
  owners: ReadonlyMap<string, SessionOwnershipRow>,
  nowIso: string,
  turnCap: number,
): ExecutionEconomicsSession {
  const diagnostics: string[] = [];
  const owner = owners.get(session.sessionId);
  const stageRole = ownershipStageRole(owner);

  // Rows come back from the SDK adapters in deduped, boundary-filtered form
  // and ordered by timestamp; render per-turn detail + session usage directly.
  const sortedRows = [...session.rows];
  const perTurn = sortedRows.map((row) => ({ row, usage: usageFromRow(row) }));
  const totalUsage = emptyUsage();
  let sessionActualCost: number | null = null;
  let harnessVersion: string | null = null;
  const triggerAvailability: FieldAvailability = 'unavailable';
  for (const { row, usage } of perTurn) {
    sumUsage(totalUsage, usage);
    if (harnessVersion === null && typeof row.harnessVersion === 'string' && row.harnessVersion.length > 0) {
      harnessVersion = row.harnessVersion;
    }
    const actual = finiteNonNegativeOrNull(row.actualCostUsd);
    if (actual !== null) sessionActualCost = addObserved(sessionActualCost, actual);
  }

  const turns: ExecutionEconomicsTurn[] = perTurn.map(({ row, usage }) => toTurn(row, usage));
  const turnsTruncated = turns.length > turnCap;
  const boundedTurns = turnsTruncated ? turns.slice(0, turnCap) : turns;
  if (turnsTruncated) {
    diagnostics.push(`per-turn detail truncated to ${turnCap} of ${turns.length} turns`);
  }

  const models = buildModelIdentity(turns, stageRole, input.routing, owner?.model || null, input.repoDir);
  const cost = input.sessionCosts?.get(session.sessionId);
  if (!cost) {
    diagnostics.push('no @hokusai/costs report for this owned session');
  }

  const actualCostUsd = cost?.actualUsd ?? sessionActualCost;
  const estimatedCostUsd = cost?.estimatedUsd ?? null;
  const costSource: ExecutionEconomicsSession['costSource'] = cost?.costSource ?? 'none';
  const coverage: WorkflowCostAttributionCoverage = cost?.coverage ?? 'unavailable';

  const fieldAvailability: Record<string, FieldAvailability> = {
    harnessVersion: harnessVersion !== null ? 'available' : 'unavailable',
    triggerSource: triggerAvailability,
    turnLineage: turns.length === 0
      ? 'unavailable'
      : turns.every((turn) => turn.turnId !== null)
        ? 'available'
        : turns.some((turn) => turn.turnId !== null)
          ? 'partial'
          : 'unavailable',
    perTurnUsage: turns.length === 0
      ? 'unavailable'
      : turns.every((turn) => turn.usage.inputTokens !== null || turn.usage.outputTokens !== null)
        ? 'available'
        : turns.some((turn) => turn.usage.inputTokens !== null || turn.usage.outputTokens !== null)
          ? 'partial'
          : 'unavailable',
    reasoningTokens: totalUsage.reasoningTokens !== null ? 'available' : 'unavailable',
    cacheWriteTokens: totalUsage.cacheWriteTokens !== null ? 'available' : 'unavailable',
    actualCost: actualCostUsd !== null
      ? actualCostUsd === 0 ? 'known_zero' : 'available'
      : 'unavailable',
  };

  return {
    sessionId: session.sessionId,
    rootSessionId: null,
    harnessVersion,
    triggerSource: {
      // Trigger source is not surfaced by the SDK adapters (HOK-3407); it is
      // not needed by any current reader beyond its availability flag.
      value: null,
      provenance: session.harness === 'codex'
        ? 'codex.session_meta.originator'
        : 'claude_code.promptSource',
      availability: triggerAvailability,
    },
    stageRole,
    models,
    turnCount: turns.length,
    turns: boundedTurns,
    turnsTruncated,
    modelSegments: computeModelSegments(turns),
    usage: totalUsage,
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
 * Build normalized execution-economics blocks (one per harness) from SDK
 * per-session usage rows, the task's ownership rows and the SDK's
 * per-session costs. Pure aside from registry loading; never throws on
 * missing evidence — degraded inputs become availability diagnostics.
 *
 * Only owned sessions become blocks — an unowned worktree session with no
 * launch row is dropped (HOK-3407). This drops the historical `stageRole:
 * null` session blocks entirely.
 */
export function buildExecutionEconomics(input: BuildExecutionEconomicsInput): EvalExecutionEconomics[] {
  const owners = indexBySessionRef(input.ownership ?? []);
  const nowIso = (input.now?.() ?? new Date()).toISOString();
  const turnCap = input.turnCap ?? DEFAULT_TURN_CAP;

  const grouped = new Map<ExecutionEconomicsHarness, NormalizedSessionInput[]>();
  for (const [sessionId, rows] of input.sessionUsageRows) {
    if (!owners.has(sessionId)) continue; // owned-only enumeration (HOK-3407)
    const harness = input.sessionHarness.get(sessionId);
    if (harness !== 'claude-code' && harness !== 'codex') continue;
    const bucket = grouped.get(harness) ?? [];
    bucket.push({ sessionId, harness, rows });
    grouped.set(harness, bucket);
  }

  const blocks: EvalExecutionEconomics[] = [];
  for (const [harness, group] of grouped) {
    if (group.length === 0) continue;
    const sessions = group.map((session) => normalizeSession(session, input, owners, nowIso, turnCap));
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
 * Collect execution-economics blocks for a completed workflow from the
 * meter's per-session SDK usage rows. Owned sessions only — the callers
 * (`post-completion-hook`, `eval-orchestrator`) pass in what
 * `meterWorkflowCost` already produced, so transcript bytes are parsed once
 * per task.
 */
export async function collectExecutionEconomics(
  input: CollectExecutionEconomicsInput,
): Promise<EvalExecutionEconomics[]> {
  return buildExecutionEconomics({
    sessionUsageRows: input.sessionUsageRows,
    sessionHarness: input.sessionHarness,
    issueId: input.issueId ?? null,
    branch: input.branchName ?? null,
    routing: input.routing,
    ownership: input.ownership,
    sessionCosts: input.sessionCosts,
    repoDir: input.repoDir,
  });
}
