import {
  DEFAULT_MODEL_REGISTRY,
  explainModelSupportExclusion,
  type ModelLifecycleStatus,
  type ModelRegistry,
} from './model-registry.ts';
import {
  normalizeOpenRouterPricing,
  type NormalizedPricing,
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

type RegistryPriceField = {
  dimension: keyof NormalizedPricing;
  registryField: string;
  actual: number | null;
};

/**
 * The live OpenRouter catalog can expose temporary or provider-local discounts.
 * A registry price above the live value is conservative and must not halt the
 * integration lane; only a missing or lower registry value can understate
 * routing and budget cost.
 */
function understatesProviderPrice(actual: number | null, expected: number): boolean {
  if (actual === null || !Number.isFinite(actual)) {
    return true;
  }
  const tolerance = Math.max(1e-12, Math.abs(expected) * 1e-9);
  return actual + tolerance < expected;
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

    const catalogContextWindow = resolveCatalogContextTokens(catalogModel);
    if (
      catalogContextWindow !== null
      && capabilities.contextWindowTokens > catalogContextWindow
    ) {
      findings.push({
        alias,
        providerNativeId,
        wireModelId,
        reason: 'context-window-overstated',
        lifecycle,
        selectable,
        detail: `Registry contextWindowTokens ${capabilities.contextWindowTokens} exceeds OpenRouter catalog context length ${catalogContextWindow}.`,
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

    for (const field of registryPriceFields(capabilities)) {
      const expected = normalizedPricing.pricing[field.dimension];
      if (expected === null) {
        continue;
      }
      if (understatesProviderPrice(field.actual, expected)) {
        findings.push({
          alias,
          providerNativeId,
          wireModelId,
          reason: 'pricing-drift',
          lifecycle,
          selectable,
          detail: `${field.dimension} drift for ${field.registryField}: provider price ${expected} exceeds registry ${String(field.actual)}.`,
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
