/**
 * The one per-stage route record (HOK-3363).
 *
 * Model selection belongs to Hokusai. For Hokusai to learn whether its
 * recommendation was right, every outcome must say what Hokusai recommended,
 * what actually ran, and who changed it and why. This module owns that answer:
 *
 * ```
 * stageRoutes.<planner|coder|reviewer> = {
 *   hokusai?:  { requestId, decisionId?, recommended },   // what Hokusai said
 *   executed:  string,                                    // what runs
 *   overrides: [{ source, from, to, reason, at, ... }],   // who changed it, why
 * }
 * ```
 *
 * The record is produced by the router's single exit (`finalizeDecision`) and
 * appended to by every later substitution: the challenge seal
 * (`applyChallengeOverride`), operator reroutes (`tools/reroute-task.ts`) and
 * the launch-refusal reroutes. It replaces the per-mechanism copies that used
 * to live in `provenance.escalation`, `preEscalationRoute`,
 * `launchabilitySubstitutions` and the eval record's `routeChanged`.
 *
 * Invariant: **a stage model is never replaced without appending an override.**
 * Inside the router the only way to change a decided stage model is
 * {@link overrideStageModel}; on disk the only way is
 * `appendRouteOverrideToFeatureDir` (route-artifact.ts). Enforced by
 * `tools/check-stage-launchability.ts` (`stage-substitution-without-override`,
 * `private-route-change-flag`).
 *
 * Everything here is pure; file I/O lives in route-artifact.ts.
 *
 * @module route-override-record
 */

import type { WorkflowRouteDecision } from './workflow-router.ts';

export type RouteStageRole = 'planner' | 'coder' | 'reviewer';
export const ROUTE_STAGE_ROLES: readonly RouteStageRole[] = ['planner', 'coder', 'reviewer'];

export type RouteOverrideSource = 'escalation' | 'launchability' | 'challenge' | 'operator';
export const ROUTE_OVERRIDE_SOURCES: readonly RouteOverrideSource[] = [
  'escalation',
  'launchability',
  'challenge',
  'operator',
];

export type RouteEscalationTriggerMetric = 'expectedSuccess' | 'confidence';

/** A floor Hokusai's own estimate fell below (e.g. confidence 0.334 < 0.4). */
export interface RouteEscalationTrigger {
  metric: RouteEscalationTriggerMetric;
  value: number;
  threshold: number;
}

interface RouteOverrideBase {
  from: string;
  to: string;
  /** Short machine-readable reason, e.g. `hokusai_reask_below_floor`. */
  reason: string;
  /** ISO 8601 time the override was applied. */
  at: string;
}

/**
 * Router escalation. `hokusai` is present when the replacement came from a
 * re-ask of Hokusai (the join key of the second request); local floors
 * (suspicious-zero, blast-radius) carry no Hokusai request.
 */
export interface EscalationRouteOverride extends RouteOverrideBase {
  source: 'escalation';
  triggers?: RouteEscalationTrigger[];
  hokusai?: { requestId?: string; decisionId?: string };
}

/** The launch gate refused the stage model (HOK-3142). */
export interface LaunchabilityRouteOverride extends RouteOverrideBase {
  source: 'launchability';
  certification?: string;
}

/** The challenge program's varied-stage model replaced the routed one. */
export interface ChallengeRouteOverride extends RouteOverrideBase {
  source: 'challenge';
  pairId: string;
  side: 'primary' | 'challenger';
}

/** An operator replaced the stage model (reroute-task, workspace selector). */
export interface OperatorRouteOverride extends RouteOverrideBase {
  source: 'operator';
  actor?: string;
}

export type RouteOverride =
  | EscalationRouteOverride
  | LaunchabilityRouteOverride
  | ChallengeRouteOverride
  | OperatorRouteOverride;

/** Override input: `from` is read from the record, `at` defaults to now. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type RouteOverrideInput = DistributiveOmit<RouteOverride, 'from' | 'to' | 'at'> & { at?: string };

export interface StageRouteHokusai {
  /**
   * Hokusai's join key for this prediction: the predict endpoint's
   * `inference_log_id` (equal to `metadata.request_id`).
   */
  requestId?: string;
  /** Wavemill route decision id (route-decision.ts), bound once minted. */
  decisionId?: string;
  /** The model Hokusai named for this stage. */
  recommended: string;
}

export interface StageRouteRecord {
  hokusai?: StageRouteHokusai;
  executed: string;
  overrides: RouteOverride[];
}

export type StageRoutes = Record<RouteStageRole, StageRouteRecord>;

/** A flattened override, tagged with its stage, as exported to evals and Hokusai. */
export type StageRouteOverride = RouteOverride & { stage: RouteStageRole };

/** The subset of a decision this module reads and writes. */
export type RouteRecordCarrier = Pick<
  WorkflowRouteDecision,
  'planner' | 'coder' | 'reviewer' | 'routingMode' | 'provenance' | 'routeDecision' | 'stageRoutes'
>;

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Hokusai's join key for a routed decision: `inferenceLogId`, falling back to
 * `requestId` (the predict endpoint returns the same UUID under both).
 */
export function hokusaiJoinKey(
  provenance: { inferenceLogId?: string; requestId?: string } | null | undefined,
): string | undefined {
  return nonEmpty(provenance?.inferenceLogId) ?? nonEmpty(provenance?.requestId);
}

/**
 * Seeds the record from a decision as the router decided it: `executed` is
 * the decided model, no overrides, and — for a Hokusai-sourced decision — the
 * Hokusai recommendation with its join key.
 */
export function seedStageRoutes(decision: RouteRecordCarrier): StageRoutes {
  const fromHokusai = decision.routingMode === 'hokusai';
  const requestId = hokusaiJoinKey(decision.provenance);
  const decisionId = nonEmpty(decision.routeDecision?.decision_id);
  const seed = (role: RouteStageRole): StageRouteRecord => {
    const model = decision[role] ?? '';
    return {
      ...(fromHokusai
        ? {
          hokusai: {
            ...(requestId ? { requestId } : {}),
            ...(decisionId ? { decisionId } : {}),
            recommended: model,
          },
        }
        : {}),
      executed: model,
      overrides: [],
    };
  };
  return { planner: seed('planner'), coder: seed('coder'), reviewer: seed('reviewer') };
}

/** The record carried by a decision, seeding it when absent. */
export function stageRoutesOf(decision: RouteRecordCarrier): StageRoutes {
  return decision.stageRoutes ?? seedStageRoutes(decision);
}

/**
 * Appends an override to one stage's record and moves `executed` to the
 * override's target. Pure. A no-op override (`from === to`) returns the record
 * unchanged — nothing changed, so nothing is recorded.
 */
export function appendOverride(record: StageRouteRecord, override: RouteOverride): StageRouteRecord {
  if (!override.to || override.from === override.to) {
    return record;
  }
  return {
    ...record,
    executed: override.to,
    overrides: [...record.overrides, override],
  };
}

function materializeOverride(from: string, to: string, input: RouteOverrideInput): RouteOverride {
  const { at, ...rest } = input;
  return { ...rest, from, to, at: at ?? new Date().toISOString() } as RouteOverride;
}

/**
 * Appends an override for `role` to a stage-routes map (seeding a bare record
 * from `fallbackFrom` when the map is absent). `from` is the record's current
 * executed model. Pure.
 */
export function appendStageOverride(
  stageRoutes: StageRoutes,
  role: RouteStageRole,
  to: string,
  input: RouteOverrideInput,
): StageRoutes {
  const current = stageRoutes[role];
  const override = materializeOverride(current.executed, to, input);
  const next = appendOverride(current, override);
  return next === current ? stageRoutes : { ...stageRoutes, [role]: next };
}

/**
 * The only way to replace a decided stage model inside the router: sets
 * `decision[role] = to` and appends the matching override to
 * `decision.stageRoutes[role]` in one step. Callers recompute costs.
 */
export function overrideStageModel<T extends RouteRecordCarrier>(
  decision: T,
  role: RouteStageRole,
  to: string,
  input: RouteOverrideInput,
): T {
  if (!to || decision[role] === to) {
    return decision;
  }
  const routes = stageRoutesOf(decision);
  // Align the record with the decision first so `from` is the model being replaced.
  const aligned = routes[role].executed === decision[role]
    ? routes
    : { ...routes, [role]: { ...routes[role], executed: decision[role] } };
  return {
    ...decision,
    [role]: to,
    stageRoutes: appendStageOverride(aligned, role, to, input),
  };
}

/**
 * Completes the record at the router's single exit: seeds it when no
 * override ran and pins `executed` to the models the launcher will see.
 */
export function finalizeStageRoutes<T extends RouteRecordCarrier>(decision: T): T {
  const routes = stageRoutesOf(decision);
  const next = { ...routes };
  for (const role of ROUTE_STAGE_ROLES) {
    const model = decision[role] ?? '';
    if (next[role].executed !== model) {
      next[role] = { ...next[role], executed: model };
    }
  }
  return { ...decision, stageRoutes: next };
}

/** Binds the minted route decision id onto every Hokusai stage record. */
export function bindRouteDecisionId(
  stageRoutes: StageRoutes | undefined,
  decisionId: string,
): StageRoutes | undefined {
  if (!stageRoutes || !nonEmpty(decisionId)) {
    return stageRoutes;
  }
  const next = { ...stageRoutes };
  for (const role of ROUTE_STAGE_ROLES) {
    const hokusai = next[role].hokusai;
    if (hokusai && !hokusai.decisionId) {
      next[role] = { ...next[role], hokusai: { ...hokusai, decisionId } };
    }
  }
  return next;
}

/**
 * The model the router decided for the stage, before any override: Hokusai's
 * recommendation, else the first override's `from`, else what executed.
 */
export function decidedStageModel(record: StageRouteRecord): string {
  return record.hokusai?.recommended ?? record.overrides[0]?.from ?? record.executed;
}

/** Every override across stages, tagged with its stage, in `at` order. */
export function flattenRouteOverrides(stageRoutes: StageRoutes | null | undefined): StageRouteOverride[] {
  if (!stageRoutes) {
    return [];
  }
  const flattened: StageRouteOverride[] = [];
  for (const role of ROUTE_STAGE_ROLES) {
    for (const override of stageRoutes[role]?.overrides ?? []) {
      flattened.push({ ...override, stage: role });
    }
  }
  // Stable sort: equal timestamps keep stage/append order.
  return flattened
    .map((override, index) => ({ override, index }))
    .sort((a, b) => a.override.at.localeCompare(b.override.at) || a.index - b.index)
    .map(({ override }) => override);
}

// ── Parsing (tolerant reader for route artifacts and eval records) ──────────

function parseTriggers(value: unknown): RouteEscalationTrigger[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const triggers = value.flatMap((entry): RouteEscalationTrigger[] => {
    if (!isRecord(entry)) return [];
    const metric = entry.metric;
    if (metric !== 'expectedSuccess' && metric !== 'confidence') return [];
    if (typeof entry.value !== 'number' || typeof entry.threshold !== 'number') return [];
    return [{ metric, value: entry.value, threshold: entry.threshold }];
  });
  return triggers.length > 0 ? triggers : undefined;
}

export function parseRouteOverride(value: unknown): RouteOverride | null {
  if (!isRecord(value)) return null;
  const source = value.source;
  const from = typeof value.from === 'string' ? value.from : undefined;
  const to = nonEmpty(value.to);
  const reason = nonEmpty(value.reason);
  const at = nonEmpty(value.at);
  if (from === undefined || !to || !reason || !at) return null;
  const base = { from, to, reason, at };
  switch (source) {
    case 'escalation': {
      const triggers = parseTriggers(value.triggers);
      const hokusai = isRecord(value.hokusai)
        ? {
          ...(nonEmpty(value.hokusai.requestId) ? { requestId: nonEmpty(value.hokusai.requestId) } : {}),
          ...(nonEmpty(value.hokusai.decisionId) ? { decisionId: nonEmpty(value.hokusai.decisionId) } : {}),
        }
        : undefined;
      return {
        source,
        ...base,
        ...(triggers ? { triggers } : {}),
        ...(hokusai && Object.keys(hokusai).length > 0 ? { hokusai } : {}),
      };
    }
    case 'launchability':
      return {
        source,
        ...base,
        ...(nonEmpty(value.certification) ? { certification: nonEmpty(value.certification) } : {}),
      };
    case 'challenge': {
      const pairId = nonEmpty(value.pairId);
      const side = value.side;
      if (!pairId || (side !== 'primary' && side !== 'challenger')) return null;
      return { source, ...base, pairId, side };
    }
    case 'operator':
      return { source, ...base, ...(nonEmpty(value.actor) ? { actor: nonEmpty(value.actor) } : {}) };
    default:
      return null;
  }
}

function parseStageRouteRecord(value: unknown): StageRouteRecord | null {
  if (!isRecord(value) || typeof value.executed !== 'string') return null;
  const hokusai = isRecord(value.hokusai) && typeof value.hokusai.recommended === 'string'
    ? {
      ...(nonEmpty(value.hokusai.requestId) ? { requestId: nonEmpty(value.hokusai.requestId) } : {}),
      ...(nonEmpty(value.hokusai.decisionId) ? { decisionId: nonEmpty(value.hokusai.decisionId) } : {}),
      recommended: value.hokusai.recommended,
    }
    : undefined;
  const overrides = Array.isArray(value.overrides)
    ? value.overrides.map(parseRouteOverride).filter((entry): entry is RouteOverride => entry !== null)
    : [];
  return { ...(hokusai ? { hokusai } : {}), executed: value.executed, overrides };
}

/** Parses a persisted `stageRoutes` map; null unless all three stages parse. */
export function parseStageRoutes(value: unknown): StageRoutes | null {
  if (!isRecord(value)) return null;
  const planner = parseStageRouteRecord(value.planner);
  const coder = parseStageRouteRecord(value.coder);
  const reviewer = parseStageRouteRecord(value.reviewer);
  return planner && coder && reviewer ? { planner, coder, reviewer } : null;
}

// ── Challenge seal ──────────────────────────────────────────────────────────

/** The fields of a sealed challenge decision the override needs. */
export interface ChallengeSealForOverride {
  pairId: string;
  selectedStage: 'plan' | 'implementation' | 'review';
  primaryVariedModel: string;
  challengerVariedModel: string;
}

const CHALLENGE_STAGE_ROLE: Record<ChallengeSealForOverride['selectedStage'], RouteStageRole> = {
  plan: 'planner',
  implementation: 'coder',
  review: 'reviewer',
};

/**
 * Appends the challenge program's substitution for one arm: the arm's sealed
 * varied-stage model replaces whatever the router decided for that stage. The
 * primary is overridden only when its incumbent is not the routed model (the
 * HOK-3315 shape); the challenger always runs the varied model. Idempotent: a
 * record that already carries this pair's override for the stage is returned
 * as is. A missing record is seeded with the sealed incumbent as the decided
 * model, so the override still reaches Hokusai.
 */
export function applyChallengeOverride(
  stageRoutes: StageRoutes | null | undefined,
  seal: ChallengeSealForOverride,
  side: 'primary' | 'challenger',
  at: string = new Date().toISOString(),
): StageRoutes | null {
  const role = CHALLENGE_STAGE_ROLE[seal.selectedStage];
  const armModel = side === 'challenger' ? seal.challengerVariedModel : seal.primaryVariedModel;
  if (!role || !nonEmpty(armModel)) {
    return stageRoutes ?? null;
  }
  const routes: StageRoutes = stageRoutes ?? {
    planner: { executed: '', overrides: [] },
    coder: { executed: '', overrides: [] },
    reviewer: { executed: '', overrides: [] },
    [role]: { executed: seal.primaryVariedModel, overrides: [] },
  };
  const already = routes[role].overrides.some((override) =>
    override.source === 'challenge' && override.pairId === seal.pairId && override.side === side);
  if (already) {
    return routes;
  }
  return appendStageOverride(routes, role, armModel, {
    source: 'challenge',
    reason: side === 'challenger' ? 'challenge_varied_stage' : 'challenge_primary_incumbent',
    pairId: seal.pairId,
    side,
    at,
  });
}

// ── Hokusai contribution export ─────────────────────────────────────────────

/** Version tag for the override encoding inside contribution-row `inputs`. */
export const ROUTE_OVERRIDES_CONTRIBUTION_SCHEMA = 'route_overrides/v1';

/**
 * Projects the record onto contribution-row `inputs` (HOK-3363): the join key
 * Hokusai logged the prediction under (`inference_log_id`) and the overrides,
 * as parallel scalar arrays (the redacted row only carries scalars and scalar
 * arrays). The recommendation itself is not copied — Hokusai already holds it
 * under `inference_log_id`. Empty when there is nothing to report.
 */
export function routeRecordContributionInputs(
  stageRoutes: StageRoutes | null | undefined,
  inferenceLogId: string | undefined,
): Record<string, string | string[]> {
  const overrides = flattenRouteOverrides(stageRoutes);
  const joinKey = nonEmpty(inferenceLogId);
  if (!joinKey && overrides.length === 0) {
    return {};
  }
  return {
    ...(joinKey ? { inference_log_id: joinKey } : {}),
    route_overrides_schema: ROUTE_OVERRIDES_CONTRIBUTION_SCHEMA,
    route_override_stages: overrides.map((override) => override.stage),
    route_override_sources: overrides.map((override) => override.source),
    route_override_from: overrides.map((override) => override.from),
    route_override_to: overrides.map((override) => override.to),
    route_override_reasons: overrides.map((override) => override.reason),
    route_override_at: overrides.map((override) => override.at),
  };
}
