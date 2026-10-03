import { getEffectiveRegistry, type ModelRegistry } from '../../model-registry.ts';
import { resolveCertificationStorage } from './storage.ts';
import {
  listGlobalCertificationSuiteVersions,
  listGlobalCertifications,
  parseCertificationArtifactPath,
} from './store.ts';
import { resolveCertificationSubject } from './identity.ts';
import { checkGlobalCertificationEligibility, type IneligibilityReason } from './loader.ts';
import { CERTIFICATION_TTL_DAYS } from './schema.ts';

export type SuiteCoverageStatus =
  | 'ok'
  | 'bump-without-publish'
  | 'empty-store'
  | 'identity-drift'
  | 'stale';

/** A native model whose stored artifact exists but does not grant eligibility. */
export interface IneligibleModel {
  registryKey: string;
  reason: IneligibilityReason;
}

export interface SuiteCoverageResult {
  requiredSuiteVersion: string;
  nativeModelCount: number;
  artifactCountForRequiredSuite: number;
  artifactCountByOtherSuite: Record<string, number>;
  status: SuiteCoverageStatus;
  remediationCommand: string;
  root: string;
  /**
   * Native models whose artifact is present at the required suite version but
   * still fails `evaluateEligibility` — overwhelmingly `identity-reidentified`
   * after the launch-priority fixture changed. Counting artifacts alone cannot
   * see this: the count and suite version are unchanged, only the subjects are
   * stale, so the guard reported `ok` through a total reviewer outage.
   */
  ineligibleModels: IneligibleModel[];
  eligibleModelCount: number;
  /** Subset of `ineligibleModels` rejected specifically for subject mismatch. */
  identityDriftCount: number;
  /** Subset of `ineligibleModels` rejected because the artifact has expired. */
  staleCount: number;
  staleModels: Array<{ registryKey: string }>;
  renewalDueCount: number;
  modelsInRenewalWindow: Array<{ registryKey: string; expiresAt: string }>;
  orphanArtifacts: Array<{ provider: string; model: string; suiteVersion: string; path: string }>;
}

export interface SuiteCoverageOptions {
  registry?: ModelRegistry;
  repoDir?: string;
  root?: string;
  now?: Date;
  renewalWindowDays?: number;
}

const REMEDIATION_COMMAND = 'wavemill native-agent certify --all --phase workflow';

export function evaluateSuiteCoverage(options: SuiteCoverageOptions = {}): SuiteCoverageResult {
  const registry = options.registry ?? getEffectiveRegistry(options.repoDir ?? process.cwd());
  const storage = resolveCertificationStorage({ scope: 'global', root: options.root });
  const requiredSuiteVersions = nativeCertificationSuiteVersions(registry);
  const requiredSuiteVersion = requiredSuiteVersions.join(',');
  const suiteCounts = listGlobalCertificationSuiteVersions({ root: options.root });
  const requiredSet = new Set(requiredSuiteVersions);
  const artifactCountForRequiredSuite = requiredSuiteVersions.reduce(
    (sum, suiteVersion) => sum + (suiteCounts[suiteVersion] ?? 0),
    0,
  );
  const artifactCountByOtherSuite: Record<string, number> = {};
  for (const [suiteVersion, count] of Object.entries(suiteCounts).sort(([a], [b]) => a.localeCompare(b))) {
    if (!requiredSet.has(suiteVersion)) {
      artifactCountByOtherSuite[suiteVersion] = count;
    }
  }

  const nativeModelCount = Object.values(registry.models).filter((model) => (
    Boolean(model.nativeCapability?.certification?.certificationSuiteVersion?.trim())
  )).length;
  const otherArtifactCount = Object.values(artifactCountByOtherSuite).reduce((sum, count) => sum + count, 0);
  const totalArtifactCount = artifactCountForRequiredSuite + otherArtifactCount;
  const now = options.now ?? new Date();
  const renewalWindowDays = normalizeRenewalWindowDays(options.renewalWindowDays);
  const {
    ineligibleModels,
    eligibleModelCount,
    modelsInRenewalWindow,
  } = evaluateIdentityCoverage(
    registry,
    requiredSuiteVersions,
    options.root,
    now,
    renewalWindowDays,
  );

  // HOK-3143: a durable identity invalidation counts as drift so the mill's
  // preflight auto-remediation re-certifies and re-pins the alias target.
  const identityDriftCount = ineligibleModels
    .filter((entry) => (
      entry.reason === 'identity-reidentified'
      || entry.reason === 'identity-invalidated'
    )).length;
  const staleModels = ineligibleModels
    .filter((entry) => entry.reason === 'stale')
    .map(({ registryKey }) => ({ registryKey }));
  const staleCount = staleModels.length;
  const certifiableCount = eligibleModelCount + ineligibleModels.length;
  const threshold = Math.ceil(certifiableCount / 2);
  const orphanArtifacts = evaluateOrphanArtifacts(registry, storage.root);

  let status: SuiteCoverageStatus;
  if (nativeModelCount === 0) {
    status = 'ok';
  } else if (artifactCountForRequiredSuite === 0) {
    status = totalArtifactCount === 0 ? 'empty-store' : 'bump-without-publish';
  } else if (identityDriftCount > 0 && (eligibleModelCount === 0 || identityDriftCount >= threshold)) {
    status = 'identity-drift';
  } else if (staleCount > 0 && (eligibleModelCount === 0 || staleCount >= threshold)) {
    status = 'stale';
  } else {
    status = 'ok';
  }

  return {
    ineligibleModels,
    eligibleModelCount,
    identityDriftCount,
    staleCount,
    staleModels,
    renewalDueCount: modelsInRenewalWindow.length,
    modelsInRenewalWindow,
    orphanArtifacts,
    requiredSuiteVersion,
    nativeModelCount,
    artifactCountForRequiredSuite,
    artifactCountByOtherSuite,
    status,
    remediationCommand: REMEDIATION_COMMAND,
    root: storage.root,
  };
}

/**
 * Resolve each native model's expected subject and ask the same loader the
 * launch gate uses whether the stored artifact grants eligibility.
 *
 * Phase is checked at `read-only`, the lowest rung of PHASE_ORDER, so this
 * reports identity/version/staleness drift without flagging a model that is
 * merely certified below the phase a particular launch wants.
 */
function evaluateIdentityCoverage(
  registry: ModelRegistry,
  requiredSuiteVersions: string[],
  root?: string,
  now: Date = new Date(),
  renewalWindowDays = 7,
): {
  ineligibleModels: IneligibleModel[];
  eligibleModelCount: number;
  modelsInRenewalWindow: Array<{ registryKey: string; expiresAt: string }>;
} {
  const ineligibleModels: IneligibleModel[] = [];
  const modelsInRenewalWindow: Array<{ registryKey: string; expiresAt: string }> = [];
  let eligibleModelCount = 0;

  for (const [registryKey, model] of Object.entries(registry.models)) {
    const suiteVersion = model.nativeCapability?.certification?.certificationSuiteVersion?.trim();
    if (!suiteVersion || !requiredSuiteVersions.includes(suiteVersion)) {
      continue;
    }
    const nativeProvider = model.nativeCapability?.nativeProvider ?? model.supportedModel?.provider;
    if (!nativeProvider) {
      continue;
    }

    let subject;
    try {
      subject = resolveCertificationSubject({ provider: nativeProvider, model: registryKey, registry });
    } catch {
      // A model the registry cannot even resolve an identity for is a registry
      // problem, not certification drift; leave it out of both tallies.
      continue;
    }

    const eligibility = checkGlobalCertificationEligibility(
      subject.storageIdentity.provider,
      subject.storageIdentity.model,
      suiteVersion,
      'read-only',
      now,
      { root },
      subject.subject,
    );

    if (eligibility.eligible) {
      eligibleModelCount += 1;
      const expiresAt = certificationExpiresAt(eligibility.artifact);
      if (
        renewalWindowDays > 0
        && expiresAt.getTime() > now.getTime()
        && expiresAt.getTime() < now.getTime() + renewalWindowDays * 24 * 60 * 60 * 1000
      ) {
        modelsInRenewalWindow.push({ registryKey, expiresAt: expiresAt.toISOString() });
      }
    } else {
      ineligibleModels.push({ registryKey, reason: eligibility.reason });
    }
  }

  return { ineligibleModels, eligibleModelCount, modelsInRenewalWindow };
}

function evaluateOrphanArtifacts(
  registry: ModelRegistry,
  root: string,
): Array<{ provider: string; model: string; suiteVersion: string; path: string }> {
  const expectedIdentities = new Set<string>();
  for (const [registryKey, model] of Object.entries(registry.models)) {
    const suiteVersion = model.nativeCapability?.certification?.certificationSuiteVersion?.trim();
    const nativeProvider = model.nativeCapability?.nativeProvider ?? model.supportedModel?.provider;
    if (!suiteVersion || !nativeProvider) continue;
    try {
      const subject = resolveCertificationSubject({ provider: nativeProvider, model: registryKey, registry });
      expectedIdentities.add(`${subject.storageIdentity.provider}/${subject.storageIdentity.model}`);
    } catch {
      continue;
    }
  }

  return listGlobalCertifications({ root })
    .map((path) => parseCertificationArtifactPath(root, path))
    .filter((artifact): artifact is { provider: string; model: string; suiteVersion: string; path: string } => Boolean(artifact))
    .filter((artifact) => !expectedIdentities.has(`${artifact.provider}/${artifact.model}`))
    .sort((a, b) => a.provider.localeCompare(b.provider)
      || a.model.localeCompare(b.model)
      || a.suiteVersion.localeCompare(b.suiteVersion));
}

function certificationExpiresAt(artifact: { certifiedAt: string; expiresAt?: string }): Date {
  if (artifact.expiresAt) {
    return new Date(artifact.expiresAt);
  }
  return new Date(new Date(artifact.certifiedAt).getTime() + CERTIFICATION_TTL_DAYS * 24 * 60 * 60 * 1000);
}

function normalizeRenewalWindowDays(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 7;
  }
  return Math.max(0, Math.min(30, Math.trunc(value)));
}

function nativeCertificationSuiteVersions(registry: ModelRegistry): string[] {
  return [...new Set(Object.values(registry.models)
    .map((model) => model.nativeCapability?.certification?.certificationSuiteVersion?.trim())
    .filter((suiteVersion): suiteVersion is string => Boolean(suiteVersion)))]
    .sort();
}
