import type { CanaryCohortConfig, CanaryCohortIdentity } from '../../config.ts';
import type { ModelRegistry, NativeProviderName } from '../../model-registry.ts';
import { resolveCertificationSubject } from './identity.ts';
import { loadGlobalCertification } from './loader.ts';
import {
  evaluateLiveCodingCanaryEligibility,
  LIVE_CODING_CANARY_TTL_DAYS,
  type LiveCodingCanaryIneligibilityReason,
} from './schema.ts';

export const DEFAULT_MINIMUM_READY = 2;

export interface CohortIdentityHealth {
  provider: string;
  model: string;
  codingReady: boolean;
  reason?: LiveCodingCanaryIneligibilityReason;
  expiresAt?: string;
  lastRanAt?: string;
  failureReason?: string;
}

export interface CohortHealthSummary {
  identities: CohortIdentityHealth[];
  codingReadyCount: number;
  minimumReady: number;
  belowMinimum: boolean;
  nearestExpiry?: string;
}

export function evaluateCohortHealth(
  cohort: CanaryCohortConfig,
  registry: ModelRegistry,
  opts: { root?: string; now?: Date } = {},
): CohortHealthSummary {
  const now = opts.now ?? new Date();
  const minimumReady = cohort.minimumReady ?? DEFAULT_MINIMUM_READY;
  const identities: CohortIdentityHealth[] = [];

  for (const id of cohort.identities) {
    identities.push(evaluateIdentityHealth(id, registry, now, opts.root));
  }

  const codingReadyCount = identities.filter((i) => i.codingReady).length;
  const expiryDates = identities
    .filter((i) => i.codingReady && i.expiresAt)
    .map((i) => i.expiresAt!);
  expiryDates.sort();

  return {
    identities,
    codingReadyCount,
    minimumReady,
    belowMinimum: codingReadyCount < minimumReady,
    ...(expiryDates[0] ? { nearestExpiry: expiryDates[0] } : {}),
  };
}

function evaluateIdentityHealth(
  id: CanaryCohortIdentity,
  registry: ModelRegistry,
  now: Date,
  root?: string,
): CohortIdentityHealth {
  const base: CohortIdentityHealth = {
    provider: id.provider,
    model: id.model,
    codingReady: false,
  };

  let subject;
  try {
    subject = resolveCertificationSubject({
      provider: id.provider,
      model: id.model,
      registry,
    });
  } catch {
    return { ...base, reason: 'missing' };
  }

  const suiteVersion = registry.models[id.model]?.nativeCapability
    ?.certification?.certificationSuiteVersion;
  if (!suiteVersion) {
    return { ...base, reason: 'missing' };
  }

  const loaded = loadGlobalCertification(
    subject.storageIdentity.provider,
    subject.storageIdentity.model,
    suiteVersion,
    { root },
  );
  if (!loaded.ok) {
    return { ...base, reason: 'missing' };
  }

  const eligibility = evaluateLiveCodingCanaryEligibility(
    loaded.artifact,
    suiteVersion,
    now,
    subject.subject,
  );

  const canary = loaded.artifact.liveCanary;
  const expiresAt = canary?.ranAt
    ? new Date(Date.parse(canary.ranAt) + LIVE_CODING_CANARY_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString()
    : undefined;

  return {
    ...base,
    codingReady: eligibility.eligible,
    ...(!eligibility.eligible ? { reason: eligibility.reason } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(canary?.ranAt ? { lastRanAt: canary.ranAt } : {}),
    ...(canary?.reason ? { failureReason: canary.reason } : {}),
  };
}

export function selectCohortRefreshTargets(
  cohort: CanaryCohortConfig,
  registry: ModelRegistry,
  opts: { root?: string; now?: Date } = {},
): CanaryCohortIdentity[] {
  const health = evaluateCohortHealth(cohort, registry, opts);
  return health.identities
    .filter((i) => !i.codingReady)
    .map((i) => ({ provider: i.provider, model: i.model }));
}

export function validateCohortConfig(
  cohort: CanaryCohortConfig,
  registry: ModelRegistry,
): string[] {
  const errors: string[] = [];
  for (const id of cohort.identities) {
    const model = registry.models[id.model];
    if (!model?.nativeCapability) {
      errors.push(`${id.provider}/${id.model}: not in registry or not native-capable`);
      continue;
    }
    if (model.nativeCapability.nativeProvider !== id.provider) {
      errors.push(`${id.provider}/${id.model}: provider mismatch (registry says ${model.nativeCapability.nativeProvider})`);
    }
    if (model.nativeCapability.readOnlyNative === 'unsupported') {
      errors.push(`${id.provider}/${id.model}: unsupported for native certification`);
    }
  }
  return errors;
}
