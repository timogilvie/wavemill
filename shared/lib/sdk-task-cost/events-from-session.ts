/**
 * Pure converter from Wavemill session-adapter scan output to SDK
 * `TaskCostEventV1` records (HOK-3075).
 *
 * The SDK reducer (`aggregateTaskCost`) never prices: prices arrive on the
 * events. During shadow rollout the price on each event is the *legacy*
 * local estimate (`computeModelCost` over the Wavemill pricing table), so the
 * SDK summary carries the same dollars the legacy engine already produces and
 * any shadow-compare difference is a semantics difference, not a pricing one.
 *
 * Event shape rules:
 * - External (Claude Code / Codex): one `delta` event per turn when the
 *   per-turn usage reconciles exactly with the session totals and every turn
 *   is priceable; otherwise one session-level event carrying the session
 *   totals, because the legacy engine treats session totals as authoritative
 *   (HOK-2958) and per-turn deltas that disagree would change the dollars.
 * - Native: one `delta` event per turn (session-level event when the
 *   transcript exposes no turns). A trustworthy provider-reported cost wins
 *   over the local estimate, with exactly the legacy trust rule from
 *   `computeNativeWorkflowCost`: a reported zero is only accepted when there is
 *   nothing better to price from.
 * - Missing values stay `null`; nothing is coerced to `0`.
 * - Identifiers are constrained by the SDK validators (no paths, no free
 *   text). Anything that does not already satisfy them is pseudonymized with
 *   a stable hash, so a native transcript path used as a session id can never
 *   leak into the ledger.
 *
 * @module sdk-task-cost/events-from-session
 */

import { createHash } from 'node:crypto';
import { PROVIDER_CONTRACT_VERSIONS as WAVEMILL_PROVIDER_CONTRACT_VERSIONS } from '../execution-economics.ts';
import type {
  ExternalSessionTurn,
  ExternalSessionUsageRecord,
  ExternalTurnUsage,
  NativeSessionUsageRecord,
  SessionUsageResult,
} from '../session-adapters.ts';
import { computeModelCost, type ModelPricing, type PricingTable } from '../workflow-cost.ts';
import {
  SDK_PROVIDER_CONTRACT_VERSIONS,
  TASK_COST_EVENT_SCHEMA_VERSION,
  TASK_COST_TOKEN_FIELDS,
  type TaskCostBasis,
  type TaskCostDiagnosticCode,
  type TaskCostEventV1,
  type TaskCostFieldAvailability,
  type TaskCostHarness,
  type TaskCostTokenUsage,
} from './contract.ts';

// Mirrors of the SDK validator patterns (validators.js). Kept local because
// the SDK does not export them; the converter tests prove every emitted event
// passes `validateTaskCostEventV1`, so a tightened SDK pattern fails loudly.
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

/** Model id used when telemetry did not name one. Never priced. */
export const UNKNOWN_TASK_COST_MODEL = 'unknown';

/**
 * Provider parsing contract per harness for bridge-emitted events.
 *
 * External harnesses keep Wavemill's own contract versions because the
 * events carry Wavemill's parse (Codex is still `codex/1`: reasoning billed
 * as output, cached input not subtracted). Claiming the SDK's `codex/2` would
 * misstate provenance. `native/1` is new in the SDK contract.
 */
export const BRIDGE_PROVIDER_CONTRACT_VERSIONS: Readonly<Record<'claude-code' | 'codex' | 'native', string>> = {
  'claude-code': WAVEMILL_PROVIDER_CONTRACT_VERSIONS['claude-code'],
  codex: WAVEMILL_PROVIDER_CONTRACT_VERSIONS.codex,
  native: SDK_PROVIDER_CONTRACT_VERSIONS.native,
};

/** Shared inputs for converting one task's sessions into events. */
export interface TaskCostEventContext {
  /** Wavemill task / issue id; pseudonymized when not SDK-safe. */
  taskId: string;
  pricingTable: PricingTable;
  /** Canonical registry key for a raw model id (identity when unknown). */
  registryLookup: (modelId: string) => string;
  /** Price-table revision label; attached only to priced events. */
  pricingRevision?: string | null;
  /** ISO-8601 timestamp for observations the source did not time-stamp. */
  observedAtFallback: string;
}

// ────────────────────────────────────────────────────────────────
// Identifier hygiene
// ────────────────────────────────────────────────────────────────

function shortHash(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32);
}

/**
 * Map a raw identifier to one the SDK accepts. Already-valid ids pass through
 * unchanged; ids with only cosmetic problems (e.g. `_`) are slugged; anything
 * path-like or unsalvageable becomes `h-<hash>` so it stays stable across
 * re-scans but reveals nothing.
 */
export function toTaskCostId(raw: string | null | undefined, fallback = 'unknown'): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') return fallback;
  if (ID_PATTERN.test(value)) return value;
  if (!/[\\/]/.test(value)) {
    const slug = value.replace(/[^A-Za-z0-9._:-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '');
    if (ID_PATTERN.test(slug)) return slug;
  }
  return `h-${shortHash(value)}`;
}

/** Map a raw model id to one the SDK accepts (`unknown` when absent). */
export function toTaskCostModel(raw: string | null | undefined): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') return UNKNOWN_TASK_COST_MODEL;
  const valid = (candidate: string) =>
    MODEL_PATTERN.test(candidate) && !candidate.includes('..') && !candidate.includes('//');
  if (valid(value)) return value;
  const slug = value
    .replace(/[^A-Za-z0-9._:/+-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/\/{2,}/g, '/')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 128);
  return valid(slug) ? slug : `h-${shortHash(value)}`;
}

/** Normalize a timestamp to strict ISO-8601 UTC, or use the fallback. */
export function toTaskCostTimestamp(raw: string | null | undefined, fallback: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') return fallback;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function optionalVersion(raw: string | null | undefined): string | undefined {
  return typeof raw === 'string' && VERSION_PATTERN.test(raw) ? raw : undefined;
}

function finiteNonNegative(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Integer token count or null (the SDK rejects fractional counts). */
function tokenCount(value: number | null | undefined): number | null {
  const finite = finiteNonNegative(value);
  return finite === null ? null : Math.round(finite);
}

// ────────────────────────────────────────────────────────────────
// Usage and pricing
// ────────────────────────────────────────────────────────────────

/** The SDK's `deriveUsageAvailability` rule (not part of its public API). */
export function usageCoverage(usage: TaskCostTokenUsage): TaskCostFieldAvailability {
  const values = TASK_COST_TOKEN_FIELDS.map((field) => usage[field]);
  if (values.every((value) => value === null)) return 'unavailable';
  if (values.some((value) => value === null)) return 'partial';
  return values.every((value) => value === 0) ? 'known_zero' : 'available';
}

function emptyUsage(): TaskCostTokenUsage {
  return {
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    reasoning_tokens: null,
  };
}

/**
 * Token dimensions a harness's wire format never reports as a separate,
 * additive category (HOK-3076). Claude Code bills thinking inside
 * `output_tokens` and Codex has no cache-write category, so once a turn
 * reports usage at all these are a structural zero, not a missing value.
 * Leaving them `null` made the SDK label every such run `partial`, which no
 * missing token could explain.
 */
const STRUCTURALLY_ABSENT_FIELDS: Record<ExternalSessionUsageRecord['harness'], readonly (keyof TaskCostTokenUsage)[]> = {
  'claude-code': ['reasoning_tokens'],
  codex: ['cache_write_tokens'],
};

function fromExternalUsage(
  usage: ExternalTurnUsage,
  harness: ExternalSessionUsageRecord['harness'],
): TaskCostTokenUsage {
  const converted: TaskCostTokenUsage = {
    input_tokens: tokenCount(usage.inputTokens),
    output_tokens: tokenCount(usage.outputTokens),
    cache_read_tokens: tokenCount(usage.cacheReadTokens),
    cache_write_tokens: tokenCount(usage.cacheWriteTokens),
    reasoning_tokens: tokenCount(usage.reasoningTokens),
  };
  if (usageCoverage(converted) === 'unavailable') return converted;
  for (const field of STRUCTURALLY_ABSENT_FIELDS[harness]) {
    converted[field] ??= 0;
  }
  return converted;
}

/**
 * Native transcripts report no reasoning dimension; it stays `null`. Unlike
 * the external harnesses ({@link STRUCTURALLY_ABSENT_FIELDS}) this is not a
 * provable structural zero: the Pi parser (`piUsageToSessionModelUsage`)
 * coerces every missing token field to `0`, so the bridge cannot tell a
 * complete native turn from one that dropped a count. `partial` is the
 * honest label until the adapter preserves missing fields (HOK-3076).
 */
function fromNativeUsage(usage: {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}): TaskCostTokenUsage {
  return {
    input_tokens: tokenCount(usage.inputTokens),
    output_tokens: tokenCount(usage.outputTokens),
    cache_read_tokens: tokenCount(usage.cacheReadTokens),
    cache_write_tokens: tokenCount(usage.cacheCreationTokens),
    reasoning_tokens: null,
  };
}

function isExplicitZeroPricing(pricing: ModelPricing): boolean {
  return pricing.inputCostPerMTok === 0
    && pricing.outputCostPerMTok === 0
    && (pricing.cacheWriteCostPerMTok ?? 0) === 0
    && (pricing.cacheReadCostPerMTok ?? 0) === 0;
}

function pricingFor(model: string | null, ctx: TaskCostEventContext): ModelPricing | undefined {
  if (!model || model === UNKNOWN_TASK_COST_MODEL) return undefined;
  return ctx.pricingTable[ctx.registryLookup(model)] ?? ctx.pricingTable[model];
}

interface CostEstimate {
  estimated: number | null;
  diagnostics: TaskCostDiagnosticCode[];
}

/**
 * Legacy local estimate for one external usage record. Codex bills reasoning
 * tokens as output; Claude Code's thinking tokens are already inside
 * `output_tokens` (same rule as `execution-economics.ts`).
 */
function estimateExternalCost(
  harness: 'claude-code' | 'codex',
  usage: TaskCostTokenUsage,
  model: string | null,
  ctx: TaskCostEventContext,
): CostEstimate {
  if (usage.input_tokens === null || usage.output_tokens === null) {
    return { estimated: null, diagnostics: ['missing_token_usage'] };
  }
  const pricing = pricingFor(model, ctx);
  if (!pricing) return { estimated: null, diagnostics: ['unpriced_model'] };
  const outputTokens = harness === 'codex'
    ? usage.output_tokens + (usage.reasoning_tokens ?? 0)
    : usage.output_tokens;
  return {
    estimated: computeModelCost({
      inputTokens: usage.input_tokens,
      cacheCreationTokens: usage.cache_write_tokens ?? 0,
      cacheReadTokens: usage.cache_read_tokens ?? 0,
      outputTokens,
    }, pricing),
    diagnostics: [],
  };
}

// ────────────────────────────────────────────────────────────────
// Event assembly
// ────────────────────────────────────────────────────────────────

interface EventFields {
  harness: Extract<TaskCostHarness, 'claude-code' | 'codex' | 'native'>;
  harnessVersion?: string | null;
  taskId: string;
  /** Raw session id (pseudonymized here). */
  sessionId: string;
  /** Discriminates records that share a session id (native per-model rows). */
  scope: string;
  turnId: string | null;
  index: number;
  sequence: number;
  model: string | null;
  usage: TaskCostTokenUsage;
  actualCostUsd: number | null;
  estimatedCostUsd: number | null;
  costBasis: TaskCostBasis;
  observedAt: string;
  isSubagent?: boolean | null;
  pricingRevision?: string | null;
  diagnostics: TaskCostDiagnosticCode[];
}

function buildEvent(fields: EventFields): TaskCostEventV1 {
  const actual = finiteNonNegative(fields.actualCostUsd);
  const estimated = finiteNonNegative(fields.estimatedCostUsd);
  const harnessVersion = optionalVersion(fields.harnessVersion);
  const pricingRevision = estimated !== null ? optionalVersion(fields.pricingRevision) : undefined;
  const diagnostics = [...new Set(fields.diagnostics)];
  return {
    schema_version: TASK_COST_EVENT_SCHEMA_VERSION,
    // Position-qualified so distinct turns never collapse into an SDK replay,
    // yet stable across re-scans of the same append-only session file.
    event_id: `tce-${shortHash(fields.harness, fields.sessionId, fields.scope, String(fields.index), fields.turnId ?? '')}`,
    task_id: fields.taskId,
    session_id: toTaskCostId(fields.sessionId),
    // `sequence` (not `index`) is unique per session even across the native
    // per-model records that share one session id, so id-less turns from
    // different models never collapse into one SDK turn (HOK-3076).
    turn_id: toTaskCostId(fields.turnId, `turn-${fields.sequence}`),
    sequence: fields.sequence,
    ...(typeof fields.isSubagent === 'boolean' ? { is_subagent: fields.isSubagent } : {}),
    harness: fields.harness,
    ...(harnessVersion ? { harness_version: harnessVersion } : {}),
    provider_contract_version: BRIDGE_PROVIDER_CONTRACT_VERSIONS[fields.harness],
    observed_model: toTaskCostModel(fields.model),
    usage_kind: 'delta',
    usage: fields.usage,
    usage_coverage: usageCoverage(fields.usage),
    actual_cost_usd: actual,
    estimated_cost_usd: estimated,
    cost_source: actual !== null ? 'provider_reported' : estimated !== null ? 'local_estimate' : 'none',
    cost_basis: fields.costBasis,
    pricing_source: estimated !== null ? 'local_estimate' : 'none',
    ...(pricingRevision ? { pricing_revision: pricingRevision } : {}),
    observed_at: fields.observedAt,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };
}

function sumObserved(values: Array<number | null>): number | null {
  return values.reduce<number | null>((total, value) => (value === null ? total : (total ?? 0) + value), null);
}

/**
 * True when the per-turn records can stand in for the session totals without
 * changing a single token: every turn names a model and reports input and
 * output, and every usage dimension sums exactly to the session total.
 */
export function turnsReconcileWithSession(session: ExternalSessionUsageRecord): boolean {
  if (session.turns.length === 0) return false;
  if (!session.turns.every((turn) =>
    !!turn.model && turn.usage.inputTokens !== null && turn.usage.outputTokens !== null)) {
    return false;
  }
  const dimensions: Array<keyof ExternalTurnUsage> = [
    'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens',
  ];
  return dimensions.every((dimension) =>
    sumObserved(session.turns.map((turn) => turn.usage[dimension])) === session.usage[dimension]);
}

function dominantModel(turns: readonly ExternalSessionTurn[]): string | null {
  const counts = new Map<string, number>();
  for (const turn of turns) {
    if (turn.model) counts.set(turn.model, (counts.get(turn.model) ?? 0) + 1);
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

/**
 * Convert one Claude Code / Codex session into events.
 *
 * @param fallbackModel - Model to attribute a turn-less session to (the scan's
 *   only model, when it has exactly one); `null` leaves it `unknown`.
 */
export function eventsFromExternalSession(
  session: ExternalSessionUsageRecord,
  ctx: TaskCostEventContext,
  fallbackModel: string | null = null,
): TaskCostEventV1[] {
  const harness = session.harness;
  const sessionObservedAt = toTaskCostTimestamp(session.endedAt ?? session.startedAt, ctx.observedAtFallback);
  const common = {
    harness,
    harnessVersion: session.harnessVersion,
    taskId: ctx.taskId,
    sessionId: session.sessionId,
    scope: harness,
    costBasis: 'unknown' as const,
    pricingRevision: ctx.pricingRevision,
  };

  if (turnsReconcileWithSession(session)) {
    return session.turns.map((turn, index) => {
      const usage = fromExternalUsage(turn.usage, harness);
      const cost = estimateExternalCost(harness, usage, turn.model, ctx);
      return buildEvent({
        ...common,
        turnId: turn.turnId,
        index,
        sequence: index,
        model: turn.model,
        usage,
        actualCostUsd: turn.actualCostUsd,
        estimatedCostUsd: cost.estimated,
        observedAt: toTaskCostTimestamp(turn.timestamp, sessionObservedAt),
        isSubagent: turn.isSubagent,
        diagnostics: cost.diagnostics,
      });
    });
  }

  // Session-level fallback: the session totals are authoritative.
  const models = [...new Set(session.turns.map((turn) => turn.model).filter((m): m is string => !!m))];
  const model = models.length === 0 ? fallbackModel : dominantModel(session.turns);
  const usage = fromExternalUsage(session.usage, harness);
  // A multi-model session cannot be priced from its totals: the legacy engine
  // reports its estimate unavailable rather than pricing everything at one rate.
  const cost: CostEstimate = models.length > 1
    ? { estimated: null, diagnostics: ['missing_token_usage'] }
    : estimateExternalCost(harness, usage, model, ctx);
  return [buildEvent({
    ...common,
    turnId: 'session-total',
    index: 0,
    sequence: 0,
    model,
    usage,
    actualCostUsd: session.actualCostUsd,
    estimatedCostUsd: cost.estimated,
    observedAt: sessionObservedAt,
    diagnostics: cost.diagnostics,
  })];
}

type NativeUsageFields = Pick<
  NativeSessionUsageRecord,
  'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens'
  | 'providerReportedCostUsd' | 'usageAvailable' | 'invalidUsage'
>;

/**
 * Price one native usage observation with the legacy precedence: a
 * trustworthy provider-reported cost, else a local estimate, else nothing
 * (with the reason the legacy engine would record).
 */
function priceNative(
  observation: NativeUsageFields,
  pricing: ModelPricing | undefined,
): { usage: TaskCostTokenUsage; actual: number | null; estimated: number | null; diagnostics: TaskCostDiagnosticCode[] } {
  const usage = observation.invalidUsage || !observation.usageAvailable
    ? emptyUsage()
    : fromNativeUsage(observation);
  const providerCost = finiteNonNegative(observation.providerReportedCostUsd);
  // A provider that omits cost reports 0; only trust a zero when there is
  // nothing better to price from (computeNativeWorkflowCost, workflow-cost.ts).
  const providerCostIsTrustworthy = providerCost !== null
    && (providerCost > 0
      || !observation.usageAvailable
      || pricing === undefined
      || isExplicitZeroPricing(pricing));
  if (providerCostIsTrustworthy) {
    return { usage, actual: providerCost, estimated: null, diagnostics: [] };
  }
  if (observation.invalidUsage) {
    return { usage, actual: null, estimated: null, diagnostics: ['invalid_token_usage'] };
  }
  if (!observation.usageAvailable) {
    return { usage, actual: null, estimated: null, diagnostics: ['missing_token_usage'] };
  }
  if (!pricing) {
    return { usage, actual: null, estimated: null, diagnostics: ['unpriced_model'] };
  }
  return {
    usage,
    actual: null,
    estimated: computeModelCost({
      inputTokens: usage.input_tokens ?? 0,
      cacheCreationTokens: usage.cache_write_tokens ?? 0,
      cacheReadTokens: usage.cache_read_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
    }, pricing),
    diagnostics: [],
  };
}

/**
 * Convert native (Pi) session records into events. Several records may share
 * one session id (one per provider/model); sequences stay monotonic per
 * session across them.
 */
export function eventsFromNativeSessions(
  sessions: readonly NativeSessionUsageRecord[],
  ctx: TaskCostEventContext,
): TaskCostEventV1[] {
  const events: TaskCostEventV1[] = [];
  const sequences = new Map<string, number>();
  const nextSequence = (sessionId: string) => {
    const sequence = sequences.get(sessionId) ?? 0;
    sequences.set(sessionId, sequence + 1);
    return sequence;
  };

  for (const session of sessions) {
    const canonicalModel = ctx.registryLookup(session.modelId);
    const pricing = pricingFor(session.modelId, ctx);
    const common = {
      harness: 'native' as const,
      taskId: ctx.taskId,
      sessionId: session.sessionId,
      scope: `${session.provider}\0${session.modelId}`,
      model: canonicalModel,
      costBasis: 'per_token_api' as const,
      observedAt: ctx.observedAtFallback,
      pricingRevision: ctx.pricingRevision,
    };
    const observations: Array<{ turnId: string | null; fields: NativeUsageFields }> = session.turns.length > 0
      ? session.turns.map((turn) => ({ turnId: turn.responseId ?? null, fields: turn }))
      : [{ turnId: 'session-total', fields: session }];

    observations.forEach(({ turnId, fields }, index) => {
      const priced = priceNative(fields, pricing);
      events.push(buildEvent({
        ...common,
        turnId,
        index,
        sequence: nextSequence(session.sessionId),
        usage: priced.usage,
        actualCostUsd: priced.actual,
        estimatedCostUsd: priced.estimated,
        diagnostics: priced.diagnostics,
      }));
    });
  }
  return events;
}

/** Harness a scan result's events belong to, or null when it has none. */
export function scanResultHarness(
  scan: SessionUsageResult,
): 'claude-code' | 'codex' | 'native' | null {
  if (scan.nativeSessions && scan.nativeSessions.length > 0) return 'native';
  return scan.externalSessions?.[0]?.harness ?? null;
}

/** Convert one adapter scan result into events (empty when it has no sessions). */
export function eventsFromScanResult(
  scan: SessionUsageResult,
  ctx: TaskCostEventContext,
): TaskCostEventV1[] {
  if (scan.nativeSessions && scan.nativeSessions.length > 0) {
    return eventsFromNativeSessions(scan.nativeSessions, ctx);
  }
  const scanModels = Object.keys(scan.models ?? {}).filter((model) => model !== UNKNOWN_TASK_COST_MODEL);
  const fallbackModel = scanModels.length === 1 ? scanModels[0] : null;
  return (scan.externalSessions ?? []).flatMap((session) =>
    eventsFromExternalSession(session, ctx, fallbackModel));
}
