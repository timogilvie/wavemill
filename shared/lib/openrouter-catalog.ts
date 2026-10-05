/**
 * OpenRouter Catalog Sync
 *
 * Fetches model metadata from OpenRouter's public model API and joins it
 * against the static launch-priority model list (HOK-2211). Produces a
 * normalized catalog with deterministic snapshot output and an explicit
 * blocker list for missing/deprecated models.
 *
 * Pure functions are used wherever possible to keep the library testable
 * without live HTTP. `fetchOpenRouterModels` accepts an injectable
 * `fetchFn` for unit tests.
 *
 * @module openrouter-catalog
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getFamilyCapabilities,
  type FamilyCapabilities,
} from './openrouter-capabilities.ts';
import { loadModelRegistryCatalog } from './model-registry-loader.ts';

// ── Types ────────────────────────────────────────────────────────────────────

export const CATALOG_SCHEMA_VERSION = '1';
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

export type ModelFamily =
  | 'claude'
  | 'gpt'
  | 'deepseek'
  | 'glm'
  | 'qwen'
  | 'kimi'
  | 'gemini'
  | 'llama'
  | 'mistral'
  | 'grok'
  | 'unknown';

export type ModelStatus = 'active' | 'watchlist' | 'deprecated' | 'provisional';
export type RoleEligibility = 'planning' | 'coding' | 'review';

export interface LaunchPriorityModel {
  wavemillAlias: string;
  openrouterId: string;
  family: ModelFamily;
  status: ModelStatus;
  priorityTier: number;
  roleEligibility: RoleEligibility[];
}

export interface OpenRouterModelIdentity {
  input: string;
  wavemillAlias: string;
  openrouterId: string;
  provider: string;
  providerModel: string;
  family: ModelFamily;
  status: ModelStatus;
  priorityTier: number;
  roleEligibility: RoleEligibility[];
  /**
   * True for third-party OpenRouter-native models that wavemill can route
   * through native-openrouter. Anthropic/OpenAI/DeepSeek catalog rows are
   * launch-priority entries but still use their hosted/specialized agents.
   */
  nativeOpenRouter: boolean;
  equivalentIds: readonly string[];
}

export interface LaunchPriorityFixture {
  schemaVersion: string;
  description?: string;
  models: LaunchPriorityModel[];
}

/** Raw OpenRouter API model record (subset of fields we consume). */
export interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  supported_parameters?: string[];
  pricing?: {
    prompt?: string | number;
    completion?: string | number;
    input_cache_read?: string | number;
    input_cache_write?: string | number;
  };
  top_provider?: {
    context_length?: number;
  };
}

/**
 * Raw per-endpoint record from `/api/v1/models/<id>/endpoints` (subset of
 * fields we consume). One model is typically served by many endpoints with
 * independent pricing; the top-level catalog `pricing` block mirrors only
 * whichever endpoint OpenRouter currently ranks first.
 */
export interface OpenRouterEndpoint {
  name?: string;
  provider_name?: string;
  /** `<provider-slug>[/<variant>]`, e.g. `z-ai/fp8`, `google-ai-studio/flex`. */
  tag?: string;
  context_length?: number;
  pricing?: {
    prompt?: string | number;
    completion?: string | number;
    input_cache_read?: string | number;
    input_cache_write?: string | number;
  };
  status?: number | string;
  quantization?: string | null;
}

export interface NormalizedPricing {
  inputPerMTok: number | null;
  outputPerMTok: number | null;
  cacheReadPerMTok: number | null;
  cacheWritePerMTok: number | null;
}

export interface NormalizedCatalogEntry {
  wavemillAlias: string;
  openrouterId: string;
  family: ModelFamily;
  contextTokens: number | null;
  pricing: NormalizedPricing;
  capabilities?: FamilyCapabilities;
  roleEligibility: RoleEligibility[];
  status: ModelStatus;
  priorityTier: number;
  resolvedAt: string;
}

export type BlockerReason =
  | 'not_found_in_openrouter'
  | 'deprecated'
  | 'invalid_pricing';

export interface CatalogBlocker {
  wavemillAlias: string;
  openrouterId: string;
  family: ModelFamily;
  status: ModelStatus;
  priorityTier: number;
  reason: BlockerReason;
  detail: string;
}

export interface NormalizedCatalog {
  schemaVersion: string;
  generatedAt: string;
  sourceHash: string;
  entries: NormalizedCatalogEntry[];
  blockers: CatalogBlocker[];
}

export interface PromotionPricingSpec {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number | null;
  cacheWritePerMTok: number | null;
}

export interface PromotionPricingValidationResult {
  ok: boolean;
  errors: string[];
}

// ── Fixture loading ──────────────────────────────────────────────────────────

const moduleDir = dirname(fileURLToPath(import.meta.url));

/** Default fixture path resolved relative to this module's location. */
export function defaultLaunchPriorityFixturePath(): string {
  return join(moduleDir, '..', 'fixtures', 'model_30_launch_priority_models.v1.json');
}

/**
 * Read and parse the launch-priority model fixture.
 *
 * @param fixturePath Optional override; defaults to the bundled fixture.
 * @returns Parsed fixture contents.
 */
export function loadLaunchPriorityFixture(fixturePath?: string): LaunchPriorityFixture {
  if (!fixturePath) {
    const catalog = loadModelRegistryCatalog();
    const models = catalog.openrouterMappings;
    if (!Array.isArray(models)) {
      throw new Error('Invalid model registry catalog: missing "openrouterMappings" array');
    }
    return {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      description: 'OpenRouter launch-priority projection from model-registry.v1 catalog.',
      models: models.map((entry) => validateLaunchPriorityModel(entry)),
    };
  }

  const path = fixturePath ?? defaultLaunchPriorityFixturePath();
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw) as LaunchPriorityFixture;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.models)) {
    throw new Error(`Invalid launch-priority fixture at ${path}: missing "models" array`);
  }
  parsed.models.forEach(validateLaunchPriorityModel);
  return parsed;
}

/**
 * Convenience wrapper that returns just the model list.
 */
export function loadLaunchPriorityList(fixturePath?: string): LaunchPriorityModel[] {
  return loadLaunchPriorityFixture(fixturePath).models;
}

function validateLaunchPriorityModel(entry: unknown): LaunchPriorityModel {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('Invalid launch-priority model entry: expected object');
  }
  const candidate = entry as Partial<LaunchPriorityModel>;
  if (
    typeof candidate.wavemillAlias !== 'string'
    || typeof candidate.openrouterId !== 'string'
    || typeof candidate.family !== 'string'
    || typeof candidate.status !== 'string'
    || typeof candidate.priorityTier !== 'number'
    || !Array.isArray(candidate.roleEligibility)
  ) {
    throw new Error('Invalid launch-priority model entry: missing required identity fields');
  }
  return {
    wavemillAlias: candidate.wavemillAlias,
    openrouterId: candidate.openrouterId,
    family: candidate.family as ModelFamily,
    status: candidate.status as ModelStatus,
    priorityTier: candidate.priorityTier,
    roleEligibility: [...candidate.roleEligibility] as RoleEligibility[],
  };
}

function splitOpenRouterId(openrouterId: string): { provider: string; providerModel: string } | null {
  const parts = openrouterId.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  return { provider: parts[0], providerModel: parts[1] };
}

function isNativeOpenRouterProviderId(openrouterId: string): boolean {
  return !(
    openrouterId.startsWith('anthropic/')
    || openrouterId.startsWith('openai/')
    || openrouterId.startsWith('deepseek/')
  );
}

export function resolveOpenRouterModelIdentity(
  modelIdOrAlias: string | null | undefined,
  fixturePath?: string,
): OpenRouterModelIdentity | null {
  if (typeof modelIdOrAlias !== 'string' || modelIdOrAlias.trim().length === 0) {
    return null;
  }

  const input = modelIdOrAlias.trim();
  const model = loadLaunchPriorityList(fixturePath)
    .find((entry) => entry.wavemillAlias === input || entry.openrouterId === input);
  if (!model) {
    return null;
  }

  const parts = splitOpenRouterId(model.openrouterId);
  if (!parts) {
    return null;
  }

  return {
    input,
    wavemillAlias: model.wavemillAlias,
    openrouterId: model.openrouterId,
    provider: parts.provider,
    providerModel: parts.providerModel,
    family: model.family,
    status: model.status,
    priorityTier: model.priorityTier,
    roleEligibility: [...model.roleEligibility],
    nativeOpenRouter: isNativeOpenRouterProviderId(model.openrouterId),
    equivalentIds: Object.freeze([model.wavemillAlias, model.openrouterId]),
  };
}

export function equivalentOpenRouterModelIds(
  modelIdOrAlias: string | null | undefined,
  fixturePath?: string,
): readonly string[] {
  const identity = resolveOpenRouterModelIdentity(modelIdOrAlias, fixturePath);
  if (identity) {
    return identity.equivalentIds;
  }

  const trimmed = typeof modelIdOrAlias === 'string' ? modelIdOrAlias.trim() : '';
  return trimmed ? [trimmed] : [];
}

export function resolveWavemillAliasFromOpenRouterId(
  openrouterId: string | null | undefined,
  fixturePath?: string,
): string | null {
  return resolveOpenRouterModelIdentity(openrouterId, fixturePath)?.wavemillAlias ?? null;
}

export function resolveOpenRouterIdFromWavemillAlias(
  wavemillAlias: string | null | undefined,
  fixturePath?: string,
): string | null {
  const identity = resolveOpenRouterModelIdentity(wavemillAlias, fixturePath);
  return identity && identity.input === identity.wavemillAlias ? identity.openrouterId : null;
}

/**
 * Look up a launch-priority model by either its wavemill alias
 * (e.g. "qwen-3-coder") or its OpenRouter slug (e.g. "qwen/qwen3-coder").
 * Returns null when the identifier is not present in the launch-priority list.
 */
export function resolveLaunchPriorityModel(
  modelIdOrAlias: string | null | undefined,
  fixturePath?: string,
): LaunchPriorityModel | null {
  const identity = resolveOpenRouterModelIdentity(modelIdOrAlias, fixturePath);
  if (!identity) {
    return null;
  }
  return {
    wavemillAlias: identity.wavemillAlias,
    openrouterId: identity.openrouterId,
    family: identity.family,
    status: identity.status,
    priorityTier: identity.priorityTier,
    roleEligibility: [...identity.roleEligibility],
  };
}

/**
 * Produce a canonical, formatting-independent serialization of a parsed JSON
 * value: object keys sorted, no insignificant whitespace. Array order is
 * preserved because fixture ordering is meaningful (priority tiers).
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Hash the launch-priority fixture for snapshot auditability and certification
 * identity (`CertificationSubject.catalogHash`).
 *
 * Hashes a *canonical* serialization rather than the raw bytes. Re-indenting the
 * fixture — which a JSON round-trip does routinely, and which has silently
 * uncertified the entire native fleet on every machine more than once — must not
 * change the hash. Only a real catalog change (an added/removed/edited model)
 * does. Falls back to raw bytes only if the file is not parseable JSON, so a
 * corrupt fixture still produces a distinct hash rather than throwing here.
 */
export function hashLaunchPriorityFixture(fixturePath?: string): string {
  const path = fixturePath ?? defaultLaunchPriorityFixturePath();
  const raw = readFileSync(path);
  let canonical: string;
  try {
    canonical = canonicalJson(JSON.parse(raw.toString('utf-8')));
  } catch {
    return createHash('sha256').update(raw).digest('hex');
  }
  return createHash('sha256').update(canonical, 'utf-8').digest('hex');
}

/**
 * Hash one model's identity-bearing launch-priority row for certification
 * identity (`CertificationSubject.catalogHash`, HOK-3159).
 *
 * The whole-file `hashLaunchPriorityFixture` moved for every OpenRouter model
 * whenever *any* row changed, which re-identified the whole fleet and wiped
 * every live coding canary at the next mill start. This hash covers only the
 * model's own row, and only the fields that define what the model *is*:
 *
 * - `wavemillAlias`, `openrouterId` — registry key and wire id
 * - `family` — the OpenRouter capability family
 * - `roleEligibility` — which stages it may serve (sorted; order is not identity)
 *
 * Deliberately excluded: other models' rows, the fixture `description`,
 * `priorityTier` (routing order) and `status` (lifecycle, gated elsewhere).
 *
 * Looks the row up by wavemill alias or OpenRouter id, like
 * `resolveOpenRouterModelIdentity`. Returns null when no row matches.
 */
export function hashLaunchPriorityModelRow(
  modelIdOrAlias: string | null | undefined,
  fixturePath?: string,
): string | null {
  if (typeof modelIdOrAlias !== 'string' || modelIdOrAlias.trim().length === 0) {
    return null;
  }
  const input = modelIdOrAlias.trim();
  const row = loadLaunchPriorityList(fixturePath)
    .find((entry) => entry.wavemillAlias === input || entry.openrouterId === input);
  if (!row) {
    return null;
  }
  const identityFields = {
    wavemillAlias: row.wavemillAlias,
    openrouterId: row.openrouterId,
    family: row.family,
    roleEligibility: [...new Set(row.roleEligibility)].sort(),
  };
  return createHash('sha256').update(canonicalJson(identityFields), 'utf-8').digest('hex');
}

// ── OpenRouter HTTP fetcher ──────────────────────────────────────────────────

export interface OpenRouterApiResponse {
  data: OpenRouterModel[];
}

export type FetchLike = typeof fetch;

/**
 * Fetch the live OpenRouter model catalog and return it as a Map keyed by
 * model id.
 *
 * Accepts an injectable `fetchFn` so unit tests can supply canned responses
 * without making network calls.
 */
export async function fetchOpenRouterModels(
  fetchFn: FetchLike = fetch,
  url: string = OPENROUTER_MODELS_URL,
): Promise<Map<string, OpenRouterModel>> {
  const response = await fetchFn(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(
      `OpenRouter model fetch failed: HTTP ${response.status} ${response.statusText}`,
    );
  }
  const body = (await response.json()) as OpenRouterApiResponse;
  if (!body || !Array.isArray(body.data)) {
    throw new Error('OpenRouter response missing "data" array');
  }
  const map = new Map<string, OpenRouterModel>();
  for (const model of body.data) {
    if (model && typeof model.id === 'string' && model.id.length > 0) {
      map.set(model.id, model);
    }
  }
  return map;
}

/** URL of the per-endpoint listing for one model. The model id contains a `/`
 * which the endpoint path takes literally (e.g. `…/models/z-ai/glm-5.2/endpoints`). */
export function openRouterEndpointsUrl(modelId: string): string {
  return `${OPENROUTER_MODELS_URL}/${modelId}/endpoints`;
}

export interface OpenRouterEndpointsApiResponse {
  data?: {
    endpoints?: OpenRouterEndpoint[];
  };
}

/**
 * Fetch the per-endpoint listing for one OpenRouter model.
 *
 * Accepts an injectable `fetchFn` so unit tests can supply canned responses
 * without making network calls. Throws on non-OK HTTP or a malformed body,
 * matching `fetchOpenRouterModels` semantics.
 */
export async function fetchOpenRouterModelEndpoints(
  modelId: string,
  fetchFn: FetchLike = fetch,
): Promise<OpenRouterEndpoint[]> {
  const response = await fetchFn(openRouterEndpointsUrl(modelId), {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(
      `OpenRouter endpoints fetch for ${modelId} failed: HTTP ${response.status} ${response.statusText}`,
    );
  }
  const body = (await response.json()) as OpenRouterEndpointsApiResponse;
  if (!body || typeof body !== 'object' || !body.data || !Array.isArray(body.data.endpoints)) {
    throw new Error(`OpenRouter endpoints response for ${modelId} missing "data.endpoints" array`);
  }
  return body.data.endpoints;
}

// ── Normalization ────────────────────────────────────────────────────────────

const TOKENS_PER_MILLION = 1_000_000;

type ParsedPricingValue =
  | { kind: 'absent' }
  | { kind: 'value'; perMTok: number }
  | { kind: 'invalid'; raw: unknown };

function parsePricingValue(value: unknown): ParsedPricingValue {
  if (value === undefined || value === null) {
    return { kind: 'absent' };
  }
  if (typeof value === 'string' && value.trim().length === 0) {
    return { kind: 'invalid', raw: value };
  }
  if (typeof value !== 'number' && typeof value !== 'string') {
    return { kind: 'invalid', raw: value };
  }
  const asNumber = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(asNumber) || asNumber < 0) {
    return { kind: 'invalid', raw: value };
  }
  return { kind: 'value', perMTok: asNumber * TOKENS_PER_MILLION };
}

function pricingValueOrNull(value: ParsedPricingValue): number | null {
  return value.kind === 'value' ? value.perMTok : null;
}

function resolveContextTokens(model: OpenRouterModel): number | null {
  if (typeof model.context_length === 'number' && Number.isFinite(model.context_length)) {
    return model.context_length;
  }
  const fromProvider = model.top_provider?.context_length;
  if (typeof fromProvider === 'number' && Number.isFinite(fromProvider)) {
    return fromProvider;
  }
  return null;
}

export interface NormalizedOpenRouterPricingResult {
  pricing: NormalizedPricing;
  invalid: Array<{ dimension: keyof NormalizedPricing; raw: unknown }>;
}

export function normalizeOpenRouterPricing(
  pricing: OpenRouterModel['pricing'] | undefined,
): NormalizedOpenRouterPricingResult {
  const parsedPricing = {
    inputPerMTok: parsePricingValue(pricing?.prompt),
    outputPerMTok: parsePricingValue(pricing?.completion),
    cacheReadPerMTok: parsePricingValue(pricing?.input_cache_read),
    cacheWritePerMTok: parsePricingValue(pricing?.input_cache_write),
  } satisfies Record<keyof NormalizedPricing, ParsedPricingValue>;

  const invalid = (Object.entries(parsedPricing) as Array<[keyof NormalizedPricing, ParsedPricingValue]>)
    .filter(([, parsed]) => parsed.kind === 'invalid')
    .map(([dimension, parsed]) => ({
      dimension,
      raw: (parsed as Extract<ParsedPricingValue, { kind: 'invalid' }>).raw,
    }));

  return {
    pricing: {
      inputPerMTok: pricingValueOrNull(parsedPricing.inputPerMTok),
      outputPerMTok: pricingValueOrNull(parsedPricing.outputPerMTok),
      cacheReadPerMTok: pricingValueOrNull(parsedPricing.cacheReadPerMTok),
      cacheWritePerMTok: pricingValueOrNull(parsedPricing.cacheWritePerMTok),
    },
    invalid,
  };
}

export interface NormalizeOptions {
  /** Override the resolution timestamp (used by snapshot tests for determinism). */
  resolvedAt?: string;
}

export interface NormalizeResult {
  entries: NormalizedCatalogEntry[];
  blockers: CatalogBlocker[];
}

/**
 * Pure join/normalize function. Given the launch-priority list and the
 * OpenRouter model map, produce normalized entries and a blocker list.
 *
 * - Active and watchlist models: look up by openrouterId. If found,
 *   normalize pricing (per-token → per-MTok) and produce an entry. If
 *   not found, produce a `not_found_in_openrouter` blocker.
 * - Deprecated models: skipped from entries but reported as `deprecated`
 *   blockers for audit completeness.
 */
export function normalizeCatalog(
  launchPriorityList: LaunchPriorityModel[],
  openRouterModels: Map<string, OpenRouterModel>,
  options: NormalizeOptions = {},
): NormalizeResult {
  const resolvedAt = options.resolvedAt ?? new Date().toISOString();
  const entries: NormalizedCatalogEntry[] = [];
  const blockers: CatalogBlocker[] = [];

  for (const lp of launchPriorityList) {
    if (lp.status === 'deprecated') {
      blockers.push({
        wavemillAlias: lp.wavemillAlias,
        openrouterId: lp.openrouterId,
        family: lp.family,
        status: lp.status,
        priorityTier: lp.priorityTier,
        reason: 'deprecated',
        detail: `Model ${lp.wavemillAlias} is marked deprecated and skipped from active catalog`,
      });
      continue;
    }

    const orModel = openRouterModels.get(lp.openrouterId);
    if (!orModel) {
      blockers.push({
        wavemillAlias: lp.wavemillAlias,
        openrouterId: lp.openrouterId,
        family: lp.family,
        status: lp.status,
        priorityTier: lp.priorityTier,
        reason: 'not_found_in_openrouter',
        detail: `OpenRouter id "${lp.openrouterId}" not present in fetched model list`,
      });
      continue;
    }

    const normalizedPricing = normalizeOpenRouterPricing(orModel.pricing);
    const invalidPricing = normalizedPricing.invalid[0];
    if (invalidPricing) {
      blockers.push({
        wavemillAlias: lp.wavemillAlias,
        openrouterId: lp.openrouterId,
        family: lp.family,
        status: lp.status,
        priorityTier: lp.priorityTier,
        reason: 'invalid_pricing',
        detail: `OpenRouter id "${lp.openrouterId}" has invalid pricing.${invalidPricing.dimension}: ${String(invalidPricing.raw)}`,
      });
      continue;
    }
    const contextTokens = resolveContextTokens(orModel);

    entries.push({
      wavemillAlias: lp.wavemillAlias,
      openrouterId: lp.openrouterId,
      family: lp.family,
      contextTokens,
      pricing: normalizedPricing.pricing,
      capabilities: getFamilyCapabilities(lp.family),
      roleEligibility: [...lp.roleEligibility],
      status: lp.status,
      priorityTier: lp.priorityTier,
      resolvedAt,
    });
  }

  return { entries, blockers };
}

// ── Snapshot building ────────────────────────────────────────────────────────

export interface BuildSnapshotOptions {
  /** Override generatedAt (used by tests for determinism). */
  generatedAt?: string;
  schemaVersion?: string;
}

/**
 * Build a deterministic snapshot artifact suitable for writing to disk.
 *
 * Entries and blockers are sorted by (priorityTier, wavemillAlias) so the
 * output is stable across runs as long as the inputs match.
 */
export function buildCatalogSnapshot(
  entries: NormalizedCatalogEntry[],
  blockers: CatalogBlocker[],
  sourceHash: string,
  options: BuildSnapshotOptions = {},
): NormalizedCatalog {
  const sortedEntries = [...entries].sort(compareByTierAndAlias);
  const sortedBlockers = [...blockers].sort(compareByTierAndAlias);
  return {
    schemaVersion: options.schemaVersion ?? CATALOG_SCHEMA_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    sourceHash,
    entries: sortedEntries,
    blockers: sortedBlockers,
  };
}

function samePrice(left: number | null, right: number | null): boolean {
  return left === right;
}

function isFiniteNonNegativePrice(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

export function validatePromotionPricing(
  spec: PromotionPricingSpec,
  catalogEntry: Pick<NormalizedCatalogEntry, 'pricing'>,
): PromotionPricingValidationResult {
  const errors: string[] = [];
  const pricing = catalogEntry.pricing;
  const checks: Array<[keyof PromotionPricingSpec, number | null, number | null]> = [
    ['inputPerMTok', spec.inputPerMTok, pricing.inputPerMTok],
    ['outputPerMTok', spec.outputPerMTok, pricing.outputPerMTok],
    ['cacheReadPerMTok', spec.cacheReadPerMTok, pricing.cacheReadPerMTok],
    ['cacheWritePerMTok', spec.cacheWritePerMTok, pricing.cacheWritePerMTok],
  ];

  for (const [dimension, actual, expected] of checks) {
    const required = dimension === 'inputPerMTok' || dimension === 'outputPerMTok' || expected !== null;
    if (required && expected === null) {
      errors.push(`${dimension} must be advertised by the catalog for promotion`);
      continue;
    }
    if (required && actual === null) {
      errors.push(`${dimension} must be provided for promotion`);
      continue;
    }
    if (typeof actual === 'number' && !isFiniteNonNegativePrice(actual)) {
      errors.push(`${dimension} must be finite and non-negative`);
      continue;
    }
    if (!samePrice(actual, expected)) {
      errors.push(`${dimension} mismatch: spec=${String(actual)} catalog=${String(expected)}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function compareByTierAndAlias(
  left: { priorityTier: number; wavemillAlias: string },
  right: { priorityTier: number; wavemillAlias: string },
): number {
  if (left.priorityTier !== right.priorityTier) {
    return left.priorityTier - right.priorityTier;
  }
  return left.wavemillAlias.localeCompare(right.wavemillAlias);
}

/**
 * Serialize a snapshot with deterministic key ordering. Top-level keys are
 * emitted in fixed order and nested objects use sorted keys.
 */
export function serializeSnapshot(snapshot: NormalizedCatalog): string {
  return JSON.stringify(snapshot, sortKeysReplacer, 2) + '\n';
}

function sortKeysReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}

/**
 * Convenience: returns true if any tier-1 active model is blocked.
 * Used by the CLI to decide its exit code.
 */
export function hasTier1ActiveBlockers(blockers: CatalogBlocker[]): boolean {
  return blockers.some(
    (b) => b.priorityTier === 1 && b.status === 'active' && b.reason !== 'deprecated',
  );
}
