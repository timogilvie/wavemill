import {
  hashLaunchPriorityFixture,
  resolveOpenRouterModelIdentity,
} from '../../openrouter-catalog.ts';
import {
  getModel,
  resolveModelIdentity,
  resolveModelRegistryKey,
  type ModelRegistry,
  type NativeProviderName,
} from '../../model-registry.ts';
import type {
  CertificationSubject,
  LiveSmokeEvidence,
  ResolvedCertificationTarget,
} from './schema.ts';

export interface CertificationStorageIdentity {
  provider: string;
  model: string;
}

export interface ResolvedCertificationSubject {
  subject: CertificationSubject;
  storageIdentity: CertificationStorageIdentity;
}

const UNSAFE_SEGMENT = /[/\\\0]/;

/**
 * OpenRouter's documented convention: a rolling alias id begins with `~`
 * (e.g. `~google/gemini-pro-latest`). Centralized here so a future
 * registry flag can replace it in exactly one spot. See HOK-3143 Plan D1.
 */
export function isRollingProviderAlias(providerNativeId: string): boolean {
  return providerNativeId.startsWith('~');
}

const PROVIDER_ALIASES = new Map<string, string>([
  ['qwen', 'qwen'],
  ['alibaba', 'qwen'],
  ['alibaba-cloud', 'qwen'],
  ['zai', 'z-ai'],
  ['z-ai', 'z-ai'],
  ['z.ai', 'z-ai'],
  ['glm', 'z-ai'],
  ['moonshot', 'moonshotai'],
  ['moonshot-ai', 'moonshotai'],
  ['moonshotai', 'moonshotai'],
]);

export function isValidCertificationPathSegment(segment: string): boolean {
  if (segment.length === 0) return false;
  if (segment === '.' || segment === '..') return false;
  if (UNSAFE_SEGMENT.test(segment)) return false;
  return true;
}

export function resolveCertificationStorageIdentity(
  provider: string,
  model: string,
): CertificationStorageIdentity {
  const normalizedProvider = normalizeStorageSegment(provider);
  const normalizedModel = normalizeStorageSegment(model);

  if (normalizedProvider !== 'openrouter') {
    return {
      provider: canonicalProviderSegment(normalizedProvider),
      model: normalizedModel,
    };
  }

  const openrouterModelId = resolveOpenRouterModelIdentity(model)?.openrouterId ?? normalizedModel;

  const parts = openrouterModelId.toLowerCase().split('/');
  if (
    parts.length === 2
    && isValidCertificationPathSegment(parts[0]!)
    && isValidCertificationPathSegment(parts[1]!)
  ) {
    return {
      provider: canonicalProviderSegment(parts[0]!),
      model: parts[1]!,
    };
  }

  return { provider: normalizedProvider, model: normalizedModel };
}

export function resolveCertificationSubject(input: {
  provider: NativeProviderName | string;
  model: string;
  registry: ModelRegistry;
  launchPriorityFixturePath?: string;
}): ResolvedCertificationSubject {
  const nativeProvider = normalizeStorageSegment(input.provider);
  const registryKey = resolveModelRegistryKey(input.registry, input.model);
  const capabilities = getModel(input.registry, registryKey);
  if (!capabilities) {
    throw new Error(`No registry entry found for native certification model "${input.model}"`);
  }

  const registeredProvider = capabilities.nativeCapability?.nativeProvider
    ?? capabilities.supportedModel?.provider;
  if (registeredProvider !== nativeProvider) {
    throw new Error(
      `Model "${input.model}" is registered with native provider "${registeredProvider ?? 'unknown'}", not "${nativeProvider}".`,
    );
  }

  const identity = resolveModelIdentity(input.registry, registryKey);
  const catalogIdentity = nativeProvider === 'openrouter'
    ? resolveOpenRouterModelIdentity(input.model, input.launchPriorityFixturePath)
      ?? resolveOpenRouterModelIdentity(registryKey, input.launchPriorityFixturePath)
    : null;
  const registryProviderNativeId = capabilities.supportedModel?.providerNativeId;
  const providerNativeId = registryProviderNativeId
    ?? catalogIdentity?.openrouterId
    ?? registryKey;
  const split = splitProviderNativeId(providerNativeId, nativeProvider);

  if (nativeProvider === 'openrouter' && registryProviderNativeId) {
    const corroboratingCatalogIdentity = catalogIdentity
      ?? resolveOpenRouterModelIdentity(providerNativeId, input.launchPriorityFixturePath);
    if (corroboratingCatalogIdentity && corroboratingCatalogIdentity.openrouterId !== providerNativeId) {
      throw new Error(
        `OpenRouter catalog disagreement for "${input.model}": catalog=${corroboratingCatalogIdentity.openrouterId} registry=${providerNativeId}`,
      );
    }
  }

  const catalogHash = identity.verification?.catalogHash
    ?? (nativeProvider === 'openrouter' ? hashLaunchPriorityFixture(input.launchPriorityFixturePath) : 'registry');
  const storageIdentity = resolveCertificationStorageIdentity(nativeProvider, providerNativeId);

  return {
    storageIdentity,
    subject: {
      registryKey,
      nativeProvider,
      providerId: split.providerId,
      providerModelId: split.providerModelId,
      providerNativeId,
      identityRevision: identity.revision,
      identityFingerprint: identity.fingerprint,
      catalogHash,
    },
  };
}

export function subjectsEqual(a: CertificationSubject, b: CertificationSubject): boolean {
  return a.registryKey === b.registryKey
    && a.nativeProvider === b.nativeProvider
    && a.providerId === b.providerId
    && a.providerModelId === b.providerModelId
    && a.providerNativeId === b.providerNativeId
    && a.identityRevision === b.identityRevision
    && a.identityFingerprint === b.identityFingerprint
    && a.catalogHash === b.catalogHash;
}

function splitProviderNativeId(
  providerNativeId: string,
  nativeProvider: string,
): { providerId: string; providerModelId: string } {
  const parts = providerNativeId.split('/');
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { providerId: canonicalProviderSegment(parts[0].toLowerCase()), providerModelId: parts[1].toLowerCase() };
  }
  return {
    providerId: canonicalProviderSegment(nativeProvider),
    providerModelId: providerNativeId.trim().toLowerCase(),
  };
}

function normalizeStorageSegment(value: string): string {
  return value.trim().toLowerCase();
}

function canonicalProviderSegment(provider: string): string {
  return PROVIDER_ALIASES.get(provider) ?? provider;
}

/**
 * Pin a rolling alias to the concrete model the provider returned on live
 * smoke (HOK-3143). The returned `resolvedTarget` is written into the
 * certification artifact; the runtime verifies every assistant turn against
 * `resolvedTarget.model`.
 *
 * Fails closed:
 * - Smoke evidence missing a `providerReturnedModel` cannot pin a target.
 * - If OpenRouter returned another `~` alias as the pinned target (unexpected
 *   but defensive), we refuse — pinning to an alias would just re-hoist the
 *   same problem.
 */
export function resolveAliasTargetFromSmoke(input: {
  requestedWireId: string;
  evidence: LiveSmokeEvidence;
  now: () => Date;
}): ResolvedCertificationTarget | undefined {
  const reported = input.evidence.providerReturnedModel?.trim();
  if (!reported) return undefined;
  if (isRollingProviderAlias(reported)) return undefined;
  return {
    requestedWireId: input.requestedWireId,
    model: reported,
    observedAt: input.now().toISOString(),
    source: 'provider-response',
  };
}
