/**
 * Route decision records (HOK-3098).
 *
 * `executed_route` (HOK-2945) records what ran. A route decision records what
 * the router *decided*: a stable `decision_id`, whether the decision came from
 * Hokusai Model 30, local routing, or a local fallback after Hokusai was
 * rejected, the policy version that made it, and the recommended
 * planner/coder/reviewer before any later escalation or override.
 *
 * Decisions are minted at routing time, appended to
 * `features/<slug>/routing.jsonl` as `kind: "route_decision"` lines (additive:
 * the per-phase readers ignore them), and surfaced on the PR as the
 * `route_decision` field of the `wavemill-meta` block (`route_schema: 2`).
 *
 * Everything here is best-effort: minting or persisting a decision never
 * blocks routing, the PR, or the ready stage.
 *
 * @module route-decision
 */

import { randomUUID } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  validateRouteDecision,
  type PrRouteDecision,
  type RouteDecisionSource,
  type RouteFallbackReason,
} from './pr-metadata.ts';
import { POLICY_RESOLVER_VERSION } from './route-artifact.ts';
import { loadTraceContext } from './trace-event.ts';
import type { WorkflowRouteDecision } from './workflow-router.ts';

export type { RouteDecisionSource, RouteFallbackReason } from './pr-metadata.ts';

/** Discriminator for decision lines in `routing.jsonl`. */
export const ROUTE_DECISION_KIND = 'route_decision';
/** Version of the routing.jsonl line shape (independent of PR `route_schema`). */
export const ROUTE_DECISION_RECORD_SCHEMA = 1;
/** `policy_version` recorded for decisions made by wavemill's local router. */
export const LOCAL_ROUTER_POLICY_VERSION = `wavemill-router@${POLICY_RESOLVER_VERSION}`;

const ROUTING_JSONL = 'routing.jsonl';

/** A decision as persisted in `routing.jsonl`. */
export interface RouteDecisionRecord extends PrRouteDecision {
  kind: typeof ROUTE_DECISION_KIND;
  schema: typeof ROUTE_DECISION_RECORD_SCHEMA;
}

/** The three stage models a decision recommends. */
export type RecommendedRoute = PrRouteDecision['recommended'];

export interface BuildRouteDecisionContext {
  /** Task traceId (HOK-2259), when the trace context exists at routing time. */
  traceId?: string;
  /**
   * Decision ids already recorded for this task, oldest first. The newest
   * becomes `supersedes`, and a traceId already used as a decision id is not
   * reused (each re-route gets its own id).
   */
  priorDecisionIds?: readonly string[];
  now?: () => Date;
  mintId?: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** routingMode of the decision as decided, before escalation replaced it. */
function decidedRoutingMode(
  decision: Pick<WorkflowRouteDecision, 'routingMode' | 'preEscalationRoute'>,
): string | undefined {
  return decision.preEscalationRoute?.routingMode ?? decision.routingMode;
}

/**
 * Classifies where a routed decision came from.
 *
 * - `hokusai`: Model 30 answered and its route was accepted.
 * - `fallback`: Hokusai was attempted and rejected (typed `fallback_reason`).
 * - `local`: wavemill's own router decided without consulting Hokusai.
 */
export function classifyRouteDecisionSource(
  decision: Pick<WorkflowRouteDecision, 'routingMode' | 'fallbackReason' | 'preEscalationRoute'>,
): { source: RouteDecisionSource; fallback_reason?: RouteFallbackReason } {
  if (decidedRoutingMode(decision) === 'hokusai') {
    return { source: 'hokusai' };
  }
  if (decision.fallbackReason) {
    return { source: 'fallback', fallback_reason: decision.fallbackReason };
  }
  return { source: 'local' };
}

/**
 * Policy version: the Model 30 version when exposed, else the local router's.
 * Read from the pre-escalation snapshot first: an escalation retry replaces
 * the decision (and its provenance) with a locally routed one.
 */
export function resolvePolicyVersion(
  decision: Pick<WorkflowRouteDecision, 'routingMode' | 'provenance' | 'preEscalationRoute'>,
): string {
  if (decidedRoutingMode(decision) === 'hokusai') {
    const modelVersion = nonEmpty(decision.preEscalationRoute?.hokusaiModelVersion)
      ?? nonEmpty(decision.provenance?.hokusai?.modelVersion);
    if (modelVersion) return modelVersion;
  }
  return LOCAL_ROUTER_POLICY_VERSION;
}

/** The route as the router decided it, before escalation or overrides. */
export function recommendedRouteOf(
  decision: Pick<WorkflowRouteDecision, 'planner' | 'coder' | 'reviewer' | 'preEscalationRoute'>,
): RecommendedRoute {
  const route = decision.preEscalationRoute ?? decision;
  return {
    planner: route.planner ?? '',
    coder: route.coder ?? '',
    reviewer: route.reviewer ?? '',
  };
}

/**
 * Mints a decision record for a routed decision.
 *
 * `decision_id` reuses the task traceId when it is available and not already
 * a recorded decision id; otherwise a UUID is minted and the traceId (when
 * known) is recorded alongside as `trace_id`.
 */
export function buildRouteDecision(
  decision: WorkflowRouteDecision,
  ctx: BuildRouteDecisionContext = {},
): RouteDecisionRecord {
  const prior = ctx.priorDecisionIds ?? [];
  const traceId = nonEmpty(ctx.traceId);
  const decisionId = traceId && !prior.includes(traceId)
    ? traceId
    : (ctx.mintId ?? randomUUID)();
  const { source, fallback_reason: fallbackReason } = classifyRouteDecisionSource(decision);
  const supersedes = prior.length > 0 ? prior[prior.length - 1] : undefined;

  return {
    kind: ROUTE_DECISION_KIND,
    schema: ROUTE_DECISION_RECORD_SCHEMA,
    decision_id: decisionId,
    ...(traceId && traceId !== decisionId ? { trace_id: traceId } : {}),
    source,
    ...(fallbackReason ? { fallback_reason: fallbackReason } : {}),
    policy_version: resolvePolicyVersion(decision),
    recommended: recommendedRouteOf(decision),
    decided_at: (ctx.now ?? (() => new Date()))().toISOString(),
    ...(supersedes && supersedes !== decisionId ? { supersedes } : {}),
  };
}

/** Projects a persisted record onto the PR `route_decision` payload. */
export function toPrRouteDecision(record: PrRouteDecision): PrRouteDecision {
  return {
    decision_id: record.decision_id,
    ...(record.trace_id ? { trace_id: record.trace_id } : {}),
    source: record.source,
    ...(record.fallback_reason ? { fallback_reason: record.fallback_reason } : {}),
    policy_version: record.policy_version,
    recommended: {
      planner: record.recommended.planner,
      coder: record.recommended.coder,
      reviewer: record.recommended.reviewer,
    },
    decided_at: record.decided_at,
    ...(record.supersedes ? { supersedes: record.supersedes } : {}),
  };
}

/**
 * Parses one routing.jsonl value as a decision record. Returns null for
 * per-phase routing lines, other kinds, and records that fail the PR payload
 * validator (so a malformed line can never reach a PR body).
 */
export function parseRouteDecisionRecord(value: unknown): RouteDecisionRecord | null {
  if (!isRecord(value) || value.kind !== ROUTE_DECISION_KIND) return null;
  const { kind: _kind, schema: _schema, ...payload } = value;
  if (validateRouteDecision(payload).length > 0) return null;
  const projected = toPrRouteDecision(payload as unknown as PrRouteDecision);
  return { kind: ROUTE_DECISION_KIND, schema: ROUTE_DECISION_RECORD_SCHEMA, ...projected };
}

/** Parses routing.jsonl text into its decision records, in file order. */
export function parseRouteDecisions(text: string): RouteDecisionRecord[] {
  const records: RouteDecisionRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = parseRouteDecisionRecord(parsed);
    if (record) records.push(record);
  }
  return records;
}

/**
 * The decision the PR should carry: the last one appended. Records are
 * appended in decision order, so file order is authoritative even when clocks
 * disagree.
 */
export function latestRouteDecision(records: readonly RouteDecisionRecord[]): RouteDecisionRecord | null {
  return records.length > 0 ? records[records.length - 1] : null;
}

/** Reads all decision records from `<featureDir>/routing.jsonl`. Never throws. */
export async function readRouteDecisions(featureDir: string): Promise<RouteDecisionRecord[]> {
  try {
    return parseRouteDecisions(await readFile(join(featureDir, ROUTING_JSONL), 'utf-8'));
  } catch {
    return [];
  }
}

export type AppendRouteDecisionOutcome = 'appended' | 'duplicate' | 'invalid' | 'failed';

/**
 * Appends a decision to `<featureDir>/routing.jsonl`.
 *
 * Idempotent on `decision_id`: a decision already recorded (e.g. a cached
 * route replayed at launch) is not appended twice. A pre-minted record with no
 * `supersedes` is linked to the newest prior decision on its first write.
 * Never throws.
 */
export async function appendRouteDecision(
  featureDir: string,
  record: RouteDecisionRecord,
): Promise<AppendRouteDecisionOutcome> {
  try {
    const existing = await readRouteDecisions(featureDir);
    if (existing.some((item) => item.decision_id === record.decision_id)) {
      return 'duplicate';
    }
    const latest = latestRouteDecision(existing);
    const linked: RouteDecisionRecord = !record.supersedes && latest
      ? { ...record, supersedes: latest.decision_id }
      : record;
    const normalized = parseRouteDecisionRecord(linked);
    if (!normalized) return 'invalid';
    await appendFile(join(featureDir, ROUTING_JSONL), `${JSON.stringify(normalized)}\n`, 'utf-8');
    return 'appended';
  } catch {
    return 'failed';
  }
}

/**
 * Mints a decision for a routed task and persists it to its feature dir.
 * Reads the task traceId from `.trace-context.json` and prior decisions from
 * routing.jsonl. Returns the minted record even when persistence fails, so the
 * caller can still embed it in the route artifact. Never throws.
 */
export async function recordRouteDecision(
  featureDir: string,
  decision: WorkflowRouteDecision,
  ctx: Pick<BuildRouteDecisionContext, 'now' | 'mintId'> = {},
): Promise<RouteDecisionRecord | null> {
  try {
    const prior = await readRouteDecisions(featureDir);
    const record = buildRouteDecision(decision, {
      ...ctx,
      traceId: loadTraceContext(featureDir)?.traceId,
      priorDecisionIds: prior.map((item) => item.decision_id),
    });
    await appendRouteDecision(featureDir, record);
    return record;
  } catch {
    return null;
  }
}

/**
 * Persists the decision carried by a route artifact (route.json /
 * .post-expansion-route.json). Used where a route was decided earlier than the
 * feature dir existed (batch or startup routing caches): the embedded record
 * keeps its original `decision_id` and `decided_at`. Artifacts written before
 * HOK-3098 carry no record, so one is minted from the artifact's route.
 * Never throws.
 */
export async function recordRouteDecisionFromArtifact(
  featureDir: string,
  artifact: unknown,
): Promise<AppendRouteDecisionOutcome> {
  if (!isRecord(artifact)) return 'invalid';
  const embedded = parseRouteDecisionRecord(artifact.routeDecision);
  if (embedded) {
    return appendRouteDecision(featureDir, embedded);
  }
  if (!nonEmpty(artifact.planner) || !nonEmpty(artifact.coder) || !nonEmpty(artifact.reviewer)) {
    return 'invalid';
  }
  const record = await recordRouteDecision(featureDir, artifact as unknown as WorkflowRouteDecision);
  return record ? 'appended' : 'failed';
}

/**
 * Infers the feature dir from a task file path when the file lives directly
 * under `features/<slug>/` or `bugs/<slug>/` (the packet layout).
 */
export function inferFeatureDirFromTaskFile(file: string | undefined): string | undefined {
  if (!file) return undefined;
  const parent = dirname(file);
  const bucket = basename(dirname(parent));
  return bucket === 'features' || bucket === 'bugs' ? parent : undefined;
}
