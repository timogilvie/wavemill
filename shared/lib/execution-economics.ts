/**
 * Execution economics — normalize external harness (Claude Code / Codex)
 * session telemetry into the versioned, provider-independent
 * `EvalExecutionEconomics` contract and join it to Wavemill route intent
 * and executed-stage evidence (HOK-2958).
 *
 * Invariants:
 * - A missing or unpriced value is `null` + an availability marker, never `0`.
 *   A literal zero requires `known_zero` evidence (explicit zero pricing).
 * - Route intent and executed telemetry disagreements are surfaced as an
 *   explicit `conflict`, never coerced.
 * - First-party stage evidence (stage-result windows) is joined with explicit
 *   confidence; unattributable sessions are still persisted.
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
import {
  computeModelCost,
  loadPricingTable,
  type ModelPricing,
  type PricingTable,
} from './workflow-cost.ts';
import { readAllStageResults, type StageResultMap } from './stage-result.ts';
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
  /** Stage results providing executed-stage windows and identity. */
  stageResults?: StageResultMap | null;
  pricingTable?: PricingTable;
  repoDir?: string;
  /** Pricing table provenance label, when the caller has one. */
  pricingRevision?: string | null;
  turnCap?: number;
  now?: () => Date;
}

export interface CollectExecutionEconomicsInput {
  worktreePath: string;
  branchName: string;
  repoDir?: string;
  issueId?: string;
  routing?: EvalRouting | null;
  /** Directory holding `.{stage}-result.json` files, when known. */
  stageResultsDir?: string | null;
  pricingTable?: PricingTable;
}

function isExplicitZeroPricing(pricing: ModelPricing): boolean {
  return pricing.inputCostPerMTok === 0
    && pricing.outputCostPerMTok === 0
    && (pricing.cacheWriteCostPerMTok ?? 0) === 0
    && (pricing.cacheReadCostPerMTok ?? 0) === 0;
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

interface StageWindow {
  stage: 'planning' | 'coding' | 'review';
  startedAt: number;
  finishedAt: number | null;
  model: string | null;
}

function buildStageWindows(stageResults: StageResultMap | null | undefined): StageWindow[] {
  if (!stageResults) return [];
  const windows: StageWindow[] = [];
  for (const stage of ['planning', 'coding', 'review'] as const) {
    const result = stageResults[stage];
    if (!result) continue;
    const startedAt = Date.parse(result.startedAt);
    if (!Number.isFinite(startedAt)) continue;
    const finishedAt = result.finishedAt ? Date.parse(result.finishedAt) : NaN;
    windows.push({
      stage,
      startedAt,
      finishedAt: Number.isFinite(finishedAt) ? finishedAt : null,
      model: typeof result.model === 'string' && result.model.trim() !== '' ? result.model : null,
    });
  }
  return windows;
}

function attributeStage(
  session: ExternalSessionUsageRecord,
  windows: readonly StageWindow[],
): ExecutionEconomicsSession['stageRole'] {
  const start = session.startedAt ? Date.parse(session.startedAt) : NaN;
  const end = session.endedAt ? Date.parse(session.endedAt) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || windows.length === 0) {
    return { value: null, confidence: 'unattributed', evidence: null };
  }

  const overlapping = windows.filter((window) => {
    const windowEnd = window.finishedAt ?? Number.POSITIVE_INFINITY;
    return start <= windowEnd && end >= window.startedAt;
  });
  if (overlapping.length === 1) {
    return {
      value: overlapping[0].stage,
      confidence: 'timestamp_window',
      evidence: `session window overlaps .${overlapping[0].stage}-result.json window`,
    };
  }
  if (overlapping.length > 1) {
    return {
      value: null,
      confidence: 'unattributed',
      evidence: `ambiguous overlap with stage windows: ${overlapping.map((w) => w.stage).join(', ')}`,
    };
  }
  return { value: null, confidence: 'unattributed', evidence: null };
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
  stageWindows: readonly StageWindow[],
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
  // session's telemetry. First-party stage evidence outranks the heuristic:
  // when the stage result names the same model the session observed, record
  // the disagreement against the route, not the telemetry.
  if (identity.resolved) {
    const registry = getEffectiveRegistry(repoDir);
    const canonical = (modelId: string) => resolveModelRegistryKey(registry, modelId);
    const executedModels = new Set(
      session.turns.map((turn) => turn.model).filter((m): m is string => !!m).map(canonical),
    );
    if (executedModels.size > 0 && !executedModels.has(canonical(identity.resolved))) {
      const stageWindow = stageWindows.find((window) => window.stage === stageRole.value);
      const stageModelAgrees = stageWindow?.model
        ? executedModels.has(canonical(stageWindow.model))
        : false;
      identity.conflict = {
        otherSource: 'session_telemetry',
        ...(executed ? { otherResolvedModel: executed } : {}),
        detail: stageModelAgrees
          ? `resolved route model ${identity.resolved} never observed in session telemetry; stage result agrees with telemetry`
          : `resolved route model ${identity.resolved} never observed in session telemetry`,
      };
    }
  }

  return identity;
}

interface SessionCostEstimate {
  estimatedCostUsd: number | null;
  knownZero: boolean;
  pricingTimestamp: string | null;
  diagnostics: string[];
}

/**
 * Estimate a session's cost from its usage and the pricing table.
 *
 * Never fabricates zero: an unpriced model or unavailable usage yields
 * `null` plus a diagnostic. A zero estimate is only produced from explicit
 * zero pricing (`knownZero`).
 */
function estimateSessionCost(
  session: ExternalSessionUsageRecord,
  pricingTable: PricingTable,
  registryLookup: (modelId: string) => string,
  nowIso: string,
): SessionCostEstimate {
  const diagnostics: string[] = [];
  const models = [...new Set(
    session.turns.map((turn) => turn.model).filter((m): m is string => !!m),
  )];

  // Codex bills reasoning tokens as output; Claude Code's thinking tokens are
  // already included in output_tokens (output_tokens_details is a breakdown).
  const effectiveOutput = (usage: ExternalTurnUsage): number | null => {
    if (usage.outputTokens === null) return null;
    return session.harness === 'codex'
      ? usage.outputTokens + (usage.reasoningTokens ?? 0)
      : usage.outputTokens;
  };

  const pricingFor = (modelId: string): ModelPricing | undefined =>
    pricingTable[registryLookup(modelId)] ?? pricingTable[modelId];

  const priceUsage = (usage: ExternalTurnUsage, pricing: ModelPricing): number | null => {
    const outputTokens = effectiveOutput(usage);
    if (usage.inputTokens === null || outputTokens === null) return null;
    return computeModelCost({
      inputTokens: usage.inputTokens,
      cacheCreationTokens: usage.cacheWriteTokens ?? 0,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      outputTokens,
    }, pricing);
  };

  if (models.length === 0) {
    diagnostics.push('no executed model observed; cost cannot be estimated');
    return { estimatedCostUsd: null, knownZero: false, pricingTimestamp: null, diagnostics };
  }

  const unpriced = models.filter((model) => !pricingFor(model));
  if (unpriced.length > 0) {
    diagnostics.push(`unpriced model(s): ${unpriced.join(', ')}; estimated cost unavailable`);
    return { estimatedCostUsd: null, knownZero: false, pricingTimestamp: null, diagnostics };
  }

  let estimate: number | null = null;
  if (models.length === 1) {
    // Single-model session: price the authoritative session totals.
    estimate = priceUsage(session.usage, pricingFor(models[0])!);
    if (estimate === null) {
      diagnostics.push('session usage totals unavailable; estimated cost unavailable');
    }
  } else {
    // Multi-model session: price per turn; incomplete turn usage makes the
    // whole estimate unavailable rather than silently undercounting.
    let sum = 0;
    for (const turn of session.turns) {
      if (!turn.model) continue;
      const turnCost = priceUsage(turn.usage, pricingFor(turn.model)!);
      if (turnCost === null) {
        diagnostics.push('per-turn usage incomplete for multi-model session; estimated cost unavailable');
        return { estimatedCostUsd: null, knownZero: false, pricingTimestamp: null, diagnostics };
      }
      sum += turnCost;
    }
    estimate = sum;
  }

  if (estimate === null) {
    return { estimatedCostUsd: null, knownZero: false, pricingTimestamp: null, diagnostics };
  }

  // known_zero requires explicit zero-price evidence; a zero computed from
  // non-zero rates (zero usage) stays a plain estimate.
  const knownZero = estimate === 0
    && models.every((model) => isExplicitZeroPricing(pricingFor(model)!));
  return { estimatedCostUsd: estimate, knownZero, pricingTimestamp: nowIso, diagnostics };
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
  stageWindows: readonly StageWindow[],
  pricingTable: PricingTable,
  registryLookup: (modelId: string) => string,
  nowIso: string,
  turnCap: number,
): ExecutionEconomicsSession {
  const diagnostics = [...session.diagnostics];
  const stageRole = attributeStage(session, stageWindows);
  if (stageRole.confidence === 'unattributed' && stageRole.evidence) {
    diagnostics.push(stageRole.evidence);
  }
  const models = buildModelIdentity(session, stageRole, input.routing, stageWindows, input.repoDir);
  const cost = estimateSessionCost(session, pricingTable, registryLookup, nowIso);
  diagnostics.push(...cost.diagnostics);

  const turnsTruncated = session.turns.length > turnCap;
  if (turnsTruncated) {
    diagnostics.push(`per-turn detail truncated to ${turnCap} of ${session.turns.length} turns`);
  }

  const actualCostUsd = session.actualCostUsd;
  const estimatedCostUsd = cost.estimatedCostUsd;
  const costSource: ExecutionEconomicsSession['costSource'] = actualCostUsd !== null
    ? 'provider_reported'
    : estimatedCostUsd !== null
      ? 'local_estimate'
      : 'none';

  const sessionUsageAvailability = usageAvailability(session.usage);
  const hasCost = actualCostUsd !== null || estimatedCostUsd !== null;
  const coverage: WorkflowCostAttributionCoverage = !hasCost
    ? sessionUsageAvailability === 'unavailable' ? 'unavailable' : 'partial'
    : cost.knownZero && actualCostUsd === null
      ? 'known_zero'
      : sessionUsageAvailability === 'available'
        ? 'complete'
        : 'partial';

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
    pricingRevision: estimatedCostUsd !== null ? input.pricingRevision ?? null : null,
    pricingTimestamp: estimatedCostUsd !== null ? cost.pricingTimestamp : null,
    coverage,
    fieldAvailability,
    diagnostics,
  };
}

/**
 * Build normalized execution-economics blocks (one per harness) from adapter
 * scan results plus route/stage join evidence. Pure aside from registry and
 * pricing-table loading; never throws on missing evidence — degraded inputs
 * become availability diagnostics.
 */
export function buildExecutionEconomics(input: BuildExecutionEconomicsInput): EvalExecutionEconomics[] {
  const pricingTable = input.pricingTable ?? loadPricingTable(input.repoDir);
  const registry = getEffectiveRegistry(input.repoDir);
  const registryLookup = (modelId: string) => resolveModelRegistryKey(registry, modelId);
  const stageWindows = buildStageWindows(input.stageResults);
  const nowIso = (input.now?.() ?? new Date()).toISOString();
  const turnCap = input.turnCap ?? DEFAULT_TURN_CAP;

  const blocks: EvalExecutionEconomics[] = [];
  for (const scanResult of input.scanResults) {
    const externalSessions = scanResult?.externalSessions;
    if (!externalSessions || externalSessions.length === 0) continue;

    const harness = externalSessions[0].harness;
    const sessions = externalSessions.map((session) =>
      normalizeSession(session, input, stageWindows, pricingTable, registryLookup, nowIso, turnCap));

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
 * Code and Codex sessions for the branch/worktree, reads stage-result windows
 * through the stage-result readers, and joins route intent. Fail-soft by
 * design — callers wrap it, and every missing input degrades to diagnostics.
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
  const scanResults = [
    new ClaudeSessionAdapter().scan(scanOpts),
    new CodexSessionAdapter().scan(scanOpts),
  ];

  const stageResults = input.stageResultsDir
    ? await readAllStageResults(input.stageResultsDir)
    : null;

  return buildExecutionEconomics({
    scanResults,
    issueId: input.issueId ?? null,
    branch: input.branchName ?? null,
    routing: input.routing,
    stageResults,
    pricingTable: input.pricingTable,
    repoDir: input.repoDir,
  });
}
