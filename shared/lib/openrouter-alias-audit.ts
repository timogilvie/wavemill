import {
  DEFAULT_MODEL_REGISTRY,
  explainModelSupportExclusion,
  type ModelLifecycleStatus,
  type ModelRegistry,
} from './model-registry.ts';
import {
  normalizeOpenRouterPricing,
  type NormalizedPricing,
  type OpenRouterEndpoint,
  type OpenRouterModel,
} from './openrouter-catalog.ts';
import { resolveOpenRouterModelId } from './openrouter-provider.ts';

export type AliasAuditReason =
  | 'unresolved-openrouter-id'
  | 'not-found-in-openrouter'
  | 'provider-native-id-mismatch'
  | 'context-window-overstated'
  | 'tool-support-mismatch'
  | 'invalid-pricing'
  | 'pricing-drift';

export interface AliasAuditFinding {
  alias: string;
  providerNativeId: string | null;
  wireModelId: string | null;
  reason: AliasAuditReason;
  lifecycle: ModelLifecycleStatus;
  selectable: boolean;
  detail: string;
  /** For `pricing-drift`: the provider whose pricing was the reference. */
  referenceProvider?: string;
  /** For `pricing-drift`: how the pricing reference was selected. */
  referenceSource?: PricingReferenceSource;
  /** For `pricing-drift`: the reference price the registry must not understate. */
  expected?: number;
  /** For `pricing-drift`: the registry price that understates the reference. */
  actual?: number | null;
}

export interface AliasAuditReport {
  schemaVersion: '2';
  generatedAt: string;
  catalogSource: 'live' | 'file' | 'fixture';
  checked: number;
  findings: AliasAuditFinding[];
  selectableFindings: number;
}

function resolveCatalogContextTokens(model: OpenRouterModel): number | null {
  if (typeof model.context_length === 'number' && Number.isFinite(model.context_length)) {
    return model.context_length;
  }
  const fromProvider = model.top_provider?.context_length;
  if (typeof fromProvider === 'number' && Number.isFinite(fromProvider)) {
    return fromProvider;
  }
  return null;
}

/**
 * Max context length across endpoints. Unlike pricing, context capacity is a
 * capability bound: the registry window is fine as long as *some* live route
 * can serve it.
 */
function maxEndpointContextLength(
  endpoints: readonly OpenRouterEndpoint[] | undefined,
): number | null {
  if (!endpoints) {
    return null;
  }
  let max: number | null = null;
  for (const endpoint of endpoints) {
    if (typeof endpoint.context_length === 'number' && Number.isFinite(endpoint.context_length)) {
      max = max === null ? endpoint.context_length : Math.max(max, endpoint.context_length);
    }
  }
  return max;
}

type RegistryPriceField = {
  dimension: keyof NormalizedPricing;
  registryField: string;
  actual: number | null;
};

/**
 * Relative tolerance for the pricing-drift check: the registry may sit up to
 * this fraction below the reference price before drift is reported.
 */
export const PRICING_DRIFT_TOLERANCE = 0.01;

export type PricingReferenceSource = 'first-party' | 'endpoint-median' | 'catalog-top-level';

/**
 * The stable pricing reference an alias's registry prices are compared
 * against. All dimensions come from a single endpoint (one provider), so
 * prompt and cache prices are never mixed across billing models.
 */
export interface PricingReference {
  source: PricingReferenceSource;
  /** Human-readable provider, e.g. 'Z.AI', or 'OpenRouter top-level' for the fallback. */
  provider: string;
  /** Endpoint tag, e.g. 'z-ai/fp8'; null for the top-level fallback. */
  tag: string | null;
  pricing: NormalizedPricing;
}

/**
 * Author prefix of the OpenRouter model id → provider tag slugs that are
 * first-party hosts for that author. Authors not listed here fall back to the
 * tag-slug-equals-author heuristic, then to the all-endpoints median.
 */
const FIRST_PARTY_PROVIDER_SLUGS: Readonly<Record<string, readonly string[]>> = {
  'z-ai': ['z-ai'],
  moonshotai: ['moonshotai'],
  mistralai: ['mistral'],
  google: ['google-ai-studio', 'google-vertex'],
  qwen: ['alibaba'],
  'x-ai': ['xai'],
  deepseek: ['deepseek'],
  minimax: ['minimax'],
  openai: ['openai'],
  anthropic: ['anthropic'],
};

function slugifyProviderName(providerName: string): string {
  return providerName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function endpointProviderSlug(endpoint: OpenRouterEndpoint): string | null {
  if (typeof endpoint.tag === 'string' && endpoint.tag.length > 0) {
    return endpoint.tag.split('/')[0];
  }
  if (typeof endpoint.provider_name === 'string' && endpoint.provider_name.length > 0) {
    return slugifyProviderName(endpoint.provider_name);
  }
  return null;
}

/**
 * True when the endpoint is hosted by the model author's own (first-party)
 * provider. The author is the model id's prefix before `/`; unknown authors
 * use the fallback heuristic tag-slug === author.
 */
export function isFirstPartyEndpoint(modelId: string, endpoint: OpenRouterEndpoint): boolean {
  const author = modelId.split('/')[0] ?? '';
  const slug = endpointProviderSlug(endpoint);
  if (!slug) {
    return false;
  }
  const firstPartySlugs = FIRST_PARTY_PROVIDER_SLUGS[author] ?? [author];
  return firstPartySlugs.includes(slug);
}

type EndpointCandidate = {
  endpoint: OpenRouterEndpoint;
  pricing: NormalizedPricing;
  inputPerMTok: number;
};

/**
 * Select the stable pricing reference for a model from its endpoint list
 * (HOK-3138). The OpenRouter top-level pricing block is just whichever
 * endpoint is currently cheapest on prompt price, so it flaps with provider
 * churn and mixes billing models across providers. Instead:
 *
 * 1. Keep only endpoints whose pricing normalizes without invalid dimensions
 *    and that advertise a numeric prompt price.
 * 2. Prefer first-party endpoints when any exist, otherwise use all valid
 *    endpoints.
 * 3. Take the lower-median endpoint by prompt price (deterministic
 *    tie-breaking on tag, then provider name). Within a multi-tier
 *    first-party set (e.g. Google flex/standard/priority) this picks the
 *    standard tier.
 * 4. Return that endpoint's full pricing so every dimension comes from one
 *    provider.
 *
 * Returns null when no endpoint qualifies; the caller falls back to the
 * top-level catalog pricing.
 */
export function selectPricingReference(
  modelId: string,
  endpoints: readonly OpenRouterEndpoint[],
): PricingReference | null {
  const valid: EndpointCandidate[] = [];
  for (const endpoint of endpoints) {
    const normalized = normalizeOpenRouterPricing(endpoint.pricing);
    if (normalized.invalid.length > 0 || normalized.pricing.inputPerMTok === null) {
      continue;
    }
    valid.push({ endpoint, pricing: normalized.pricing, inputPerMTok: normalized.pricing.inputPerMTok });
  }
  if (valid.length === 0) {
    return null;
  }

  const firstParty = valid.filter((candidate) => isFirstPartyEndpoint(modelId, candidate.endpoint));
  const candidates = firstParty.length > 0 ? firstParty : valid;
  candidates.sort((left, right) => {
    if (left.inputPerMTok !== right.inputPerMTok) {
      return left.inputPerMTok - right.inputPerMTok;
    }
    const leftTag = left.endpoint.tag ?? '';
    const rightTag = right.endpoint.tag ?? '';
    if (leftTag !== rightTag) {
      return leftTag < rightTag ? -1 : 1;
    }
    const leftProvider = left.endpoint.provider_name ?? '';
    const rightProvider = right.endpoint.provider_name ?? '';
    return leftProvider < rightProvider ? -1 : leftProvider > rightProvider ? 1 : 0;
  });
  const reference = candidates[Math.floor((candidates.length - 1) / 2)];

  return {
    source: firstParty.length > 0 ? 'first-party' : 'endpoint-median',
    provider: reference.endpoint.provider_name
      ?? reference.endpoint.tag
      ?? 'unknown',
    tag: reference.endpoint.tag ?? null,
    pricing: reference.pricing,
  };
}

function describeReference(reference: PricingReference): string {
  if (reference.source === 'catalog-top-level') {
    return 'OpenRouter top-level price';
  }
  const tagSuffix = reference.tag ? ` (${reference.tag})` : '';
  return `${reference.source} reference ${reference.provider}${tagSuffix}`;
}

/**
 * A registry price above the reference is conservative and must not halt the
 * integration lane; only a missing or lower registry value can understate
 * routing and budget cost. The relative tolerance absorbs rounding noise; the
 * 1e-12 floor keeps zero prices comparing cleanly.
 */
function understatesReferencePrice(actual: number | null, expected: number): boolean {
  if (actual === null || !Number.isFinite(actual)) {
    return true;
  }
  return actual * (1 + PRICING_DRIFT_TOLERANCE) + 1e-12 < expected;
}

function registryPriceFields(
  capabilities: ModelRegistry['models'][string],
): RegistryPriceField[] {
  return [
    {
      dimension: 'inputPerMTok',
      registryField: 'pricing.inputCostPerMTok',
      actual: capabilities.pricing?.inputCostPerMTok ?? null,
    },
    {
      dimension: 'inputPerMTok',
      registryField: 'costPerMillionInputTokensUsd',
      actual: capabilities.costPerMillionInputTokensUsd,
    },
    {
      dimension: 'outputPerMTok',
      registryField: 'pricing.outputCostPerMTok',
      actual: capabilities.pricing?.outputCostPerMTok ?? null,
    },
    {
      dimension: 'outputPerMTok',
      registryField: 'costPerMillionOutputTokensUsd',
      actual: capabilities.costPerMillionOutputTokensUsd,
    },
    {
      dimension: 'cacheReadPerMTok',
      registryField: 'pricing.cacheReadCostPerMTok',
      actual: capabilities.pricing?.cacheReadCostPerMTok ?? null,
    },
    {
      dimension: 'cacheWritePerMTok',
      registryField: 'pricing.cacheWriteCostPerMTok',
      actual: capabilities.pricing?.cacheWriteCostPerMTok ?? null,
    },
  ];
}

export function auditOpenRouterAliases(input: {
  registry?: ModelRegistry;
  openRouterModels: ReadonlyMap<string, OpenRouterModel>;
  /**
   * Per-endpoint listings keyed by wire model id. When present for a model,
   * pricing is compared against the stable reference endpoint
   * (`selectPricingReference`) and the context window against the max across
   * endpoints. Absent (file/fixture mode) the top-level catalog block is used.
   */
  openRouterEndpoints?: ReadonlyMap<string, readonly OpenRouterEndpoint[]>;
  now?: Date;
  catalogSource: AliasAuditReport['catalogSource'];
}): AliasAuditReport {
  const registry = input.registry ?? DEFAULT_MODEL_REGISTRY;
  const findings: AliasAuditFinding[] = [];
  const aliases = Object.entries(registry.models)
    .filter(([, capabilities]) => capabilities.agent === 'native-openrouter')
    .map(([alias]) => alias)
    .sort();

  for (const alias of aliases) {
    const capabilities = registry.models[alias];
    const lifecycle = capabilities.supportedModel?.lifecycle ?? 'supported';
    const selectable = explainModelSupportExclusion(alias, 'coding', registry) === undefined;
    const providerNativeId = capabilities.supportedModel?.providerNativeId ?? null;
    const wireModelId = resolveOpenRouterModelId(alias);

    if (!wireModelId) {
      findings.push({
        alias,
        providerNativeId,
        wireModelId: null,
        reason: 'unresolved-openrouter-id',
        lifecycle,
        selectable,
        detail: `${alias} does not resolve to a native OpenRouter wire model id.`,
      });
      continue;
    }

    const catalogModel = input.openRouterModels.get(wireModelId);
    if (!catalogModel) {
      findings.push({
        alias,
        providerNativeId,
        wireModelId,
        reason: 'not-found-in-openrouter',
        lifecycle,
        selectable,
        detail: `${wireModelId} is absent from the OpenRouter catalog.`,
      });
      continue;
    }

    if (providerNativeId && providerNativeId !== wireModelId) {
      findings.push({
        alias,
        providerNativeId,
        wireModelId,
        reason: 'provider-native-id-mismatch',
        lifecycle,
        selectable,
        detail: `Registry providerNativeId ${providerNativeId} does not match resolved wire id ${wireModelId}.`,
      });
    }

    const endpoints = input.openRouterEndpoints?.get(wireModelId);
    const maxEndpointContext = maxEndpointContextLength(endpoints);
    const catalogContextWindow = maxEndpointContext ?? resolveCatalogContextTokens(catalogModel);
    if (
      catalogContextWindow !== null
      && capabilities.contextWindowTokens > catalogContextWindow
    ) {
      const contextSource = maxEndpointContext !== null
        ? 'max OpenRouter endpoint context length'
        : 'OpenRouter catalog context length';
      findings.push({
        alias,
        providerNativeId,
        wireModelId,
        reason: 'context-window-overstated',
        lifecycle,
        selectable,
        detail: `Registry contextWindowTokens ${capabilities.contextWindowTokens} exceeds ${contextSource} ${catalogContextWindow}.`,
      });
    }

    if (
      capabilities.toolSupport !== 'none'
      && catalogModel.supported_parameters !== undefined
      && !catalogModel.supported_parameters.includes('tools')
    ) {
      findings.push({
        alias,
        providerNativeId,
        wireModelId,
        reason: 'tool-support-mismatch',
        lifecycle,
        selectable,
        detail: `Registry toolSupport ${capabilities.toolSupport} declares tool use, but OpenRouter supported_parameters omits tools.`,
      });
    }

    const normalizedPricing = normalizeOpenRouterPricing(catalogModel.pricing);
    for (const invalid of normalizedPricing.invalid) {
      findings.push({
        alias,
        providerNativeId,
        wireModelId,
        reason: 'invalid-pricing',
        lifecycle,
        selectable,
        detail: `OpenRouter pricing.${invalid.dimension} is invalid: ${String(invalid.raw)}.`,
      });
    }
    if (normalizedPricing.invalid.length > 0) {
      continue;
    }

    const reference: PricingReference = (endpoints && selectPricingReference(wireModelId, endpoints))
      || {
        source: 'catalog-top-level',
        provider: 'OpenRouter top-level',
        tag: null,
        pricing: normalizedPricing.pricing,
      };

    for (const field of registryPriceFields(capabilities)) {
      const expected = reference.pricing[field.dimension];
      if (expected === null) {
        continue;
      }
      if (understatesReferencePrice(field.actual, expected)) {
        findings.push({
          alias,
          providerNativeId,
          wireModelId,
          reason: 'pricing-drift',
          lifecycle,
          selectable,
          detail: `${field.dimension} drift for ${field.registryField}: registry ${String(field.actual)} understates ${describeReference(reference)} ${expected}.`,
          referenceProvider: reference.provider,
          referenceSource: reference.source,
          expected,
          actual: field.actual,
        });
      }
    }
  }

  return {
    schemaVersion: '2',
    generatedAt: (input.now ?? new Date()).toISOString(),
    catalogSource: input.catalogSource,
    checked: aliases.length,
    findings,
    selectableFindings: findings.filter((finding) => finding.selectable).length,
  };
}

export function hasSelectableAliasFindings(report: AliasAuditReport): boolean {
  return report.selectableFindings > 0;
}

/**
 * Collect the wire model ids of native-openrouter aliases present in the
 * catalog and fetch each one's endpoint listing with bounded concurrency.
 * Any single fetch failure rejects: silently falling back to the top-level
 * pricing block would quietly reintroduce the flapping HOK-3138 removes.
 */
export async function fetchEndpointsForAliases(
  registry: ModelRegistry,
  openRouterModels: ReadonlyMap<string, OpenRouterModel>,
  fetchEndpoints: (modelId: string) => Promise<OpenRouterEndpoint[]>,
  concurrency = 4,
): Promise<Map<string, readonly OpenRouterEndpoint[]>> {
  const wireIds = [...new Set(
    Object.entries(registry.models)
      .filter(([, capabilities]) => capabilities.agent === 'native-openrouter')
      .map(([alias]) => resolveOpenRouterModelId(alias))
      .filter((wireId): wireId is string => wireId !== null && openRouterModels.has(wireId)),
  )].sort();

  const result = new Map<string, readonly OpenRouterEndpoint[]>();
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, wireIds.length)) }, async () => {
    while (next < wireIds.length) {
      const wireId = wireIds[next];
      next += 1;
      result.set(wireId, await fetchEndpoints(wireId));
    }
  });
  await Promise.all(workers);
  return result;
}

/**
 * Parse an offline endpoints fixture (`--endpoints-json`): a JSON object
 * keyed by wire model id whose values are either the raw API response shape
 * `{ data: { endpoints: [...] } }` or a bare endpoint array.
 */
export function parseEndpointsFixture(raw: unknown): Map<string, readonly OpenRouterEndpoint[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Endpoints fixture must be a JSON object keyed by model id');
  }
  const result = new Map<string, readonly OpenRouterEndpoint[]>();
  for (const [modelId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      result.set(modelId, value as OpenRouterEndpoint[]);
      continue;
    }
    const endpoints = (value as { data?: { endpoints?: unknown } } | null)?.data?.endpoints;
    if (!Array.isArray(endpoints)) {
      throw new Error(`Endpoints fixture entry for ${modelId} has no endpoints array`);
    }
    result.set(modelId, endpoints as OpenRouterEndpoint[]);
  }
  return result;
}
