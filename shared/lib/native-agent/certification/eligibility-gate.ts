import type { NativeProviderName } from '../../config.ts';
import { getModel, type ModelRegistry, type ReadOnlyNativeCapability } from '../../model-registry.ts';
import {
  buildGlobalCertificationPath,
  checkGlobalCertificationEligibility,
} from './loader.ts';
import { resolveCertificationSubject } from './identity.ts';
import {
  evaluateLiveCodingCanaryEligibility,
  type CertificationPhase,
  type LiveCodingCanaryIneligibilityReason,
  type LiveCodingCanaryStatus,
  type NativeCertificationArtifact,
} from './schema.ts';

export type NativeGateRejectReason =
  | 'missing_api_key'
  | 'unregistered_model'
  | 'missing_artifact'
  | 'malformed_artifact'
  | 'stale_artifact'
  | 'wrong_suite'
  | 'identity_reidentified'
  | 'identity_mismatch'
  | 'insufficient_phase'
  | 'missing_live_canary'
  | 'stale_live_canary'
  | 'failed_live_canary'
  | 'inconclusive_live_canary'
  | 'non_live_canary'
  | 'live_canary_identity_mismatch';

export type NativeGateMode = 'task' | 'certification';

/** Launch phases a caller may declare when evaluating the gate. */
export type NativeGateLaunchPhase = 'task-expansion' | 'planning' | 'coding' | 'review';

export interface NativeGateInput {
  modelId: string;
  mode: NativeGateMode;
  requiredPhase?: CertificationPhase;
  /**
   * Explicit launch phase being gated. When omitted, a coding launch is
   * inferred fail-closed from `requiredPhase === 'patch'` (the certification
   * phase used exclusively by coding launches). Coding launches additionally
   * require a fresh, live, identity-matching coding canary pass.
   */
  launchPhase?: NativeGateLaunchPhase;
  registry: ModelRegistry;
  repoDir?: string;
  apiKeyPresent: boolean;
  apiKeyEnv: string;
  now?: Date;
  certificationRoot?: string;
}

export interface NativeGateReady {
  ok: true;
  modelId: string;
  nativeProvider: NativeProviderName;
  storagePath?: string;
  artifact?: NativeCertificationArtifact;
  certified: boolean;
}

export interface NativeGateReject {
  ok: false;
  modelId: string;
  reason: NativeGateRejectReason;
  message: string;
  apiKeyEnv?: string;
  nativeCapability?: ReadOnlyNativeCapability | 'unregistered';
  requiredPhase?: CertificationPhase;
  foundPhase?: CertificationPhase;
  requiredSuiteVersion?: string;
  foundSuiteVersion?: string;
  certifiedAt?: string;
  artifactPath?: string;
  artifactScope?: 'global' | 'legacy-repo';
  subject?: unknown;
  /** Status of the live coding canary, when a canary-specific reason rejected the model. */
  liveCanaryStatus?: LiveCodingCanaryStatus;
  /** ISO 8601 timestamp of the live coding canary run, when one was found. */
  liveCanaryRanAt?: string;
  /** Pinned alias target (if any), for identity_mismatch diagnostics (HOK-3143). */
  expectedModel?: string;
  /** Provider-reported model id recorded at invalidation time (HOK-3143). */
  observedModel?: string;
}

export type NativeGateDecision = NativeGateReady | NativeGateReject;

export function evaluateNativeProviderGate(input: NativeGateInput): NativeGateDecision {
  if (!input.apiKeyPresent) {
    return rejectDecision({
      modelId: input.modelId,
      reason: 'missing_api_key',
      apiKeyEnv: input.apiKeyEnv,
    });
  }

  const nativeCapability = getModel(input.registry, input.modelId)?.nativeCapability;
  const nativeProvider = nativeCapability?.nativeProvider;
  const capability = nativeCapability?.readOnlyNative ?? 'unregistered';

  if (!nativeProvider) {
    return rejectDecision({
      modelId: input.modelId,
      reason: 'unregistered_model',
      nativeCapability: capability,
    });
  }

  if (input.mode === 'certification') {
    return {
      ok: true,
      modelId: input.modelId,
      nativeProvider,
      certified: false,
    };
  }

  if (!input.requiredPhase) {
    throw new Error('evaluateNativeProviderGate: requiredPhase is required in task mode');
  }

  const requiredSuiteVersion = nativeCapability?.certification?.certificationSuiteVersion?.trim();
  if (!requiredSuiteVersion) {
    return rejectDecision({
      modelId: input.modelId,
      reason: 'wrong_suite',
      nativeCapability: capability,
    });
  }

  const subject = resolveCertificationSubject({
    provider: nativeProvider,
    model: input.modelId,
    registry: input.registry,
  });
  const artifactPath = buildGlobalCertificationPath(
    subject.storageIdentity.provider,
    subject.storageIdentity.model,
    requiredSuiteVersion,
    { root: input.certificationRoot },
  );
  const eligibility = checkGlobalCertificationEligibility(
    subject.storageIdentity.provider,
    subject.storageIdentity.model,
    requiredSuiteVersion,
    input.requiredPhase,
    input.now,
    { root: input.certificationRoot },
    subject.subject,
  );

  if (!eligibility.eligible) {
    const artifact = eligibility.artifact;
    const invalidation = artifact && 'identityInvalidation' in artifact
      ? artifact.identityInvalidation
      : undefined;
    return rejectDecision({
      modelId: input.modelId,
      reason: mapEligibilityReason(eligibility.reason),
      nativeCapability: capability,
      requiredPhase: input.requiredPhase,
      foundPhase: artifact?.phase,
      requiredSuiteVersion,
      foundSuiteVersion: artifact?.suiteVersion,
      certifiedAt: artifact?.certifiedAt,
      artifactPath: eligibility.artifactPath ?? artifactPath,
      artifactScope: eligibility.storageScope,
      subject: eligibility.reason === 'identity-reidentified' ? subject.subject : undefined,
      ...(invalidation ? { expectedModel: invalidation.expectedModel, observedModel: invalidation.observedModel } : {}),
    });
  }

  // Deterministic certification alone is necessary but not sufficient for
  // coding: a coding launch additionally requires a fresh, live,
  // identity-matching structured-mutation canary pass (HOK-2943).
  if (isCodingLaunch(input)) {
    const canaryEligibility = evaluateLiveCodingCanaryEligibility(
      eligibility.artifact,
      requiredSuiteVersion,
      input.now ?? new Date(),
      subject.subject,
    );
    if (!canaryEligibility.eligible) {
      const canary = canaryEligibility.canary;
      return rejectDecision({
        modelId: input.modelId,
        reason: mapCanaryReason(canaryEligibility.reason),
        nativeCapability: capability,
        requiredPhase: input.requiredPhase,
        foundPhase: eligibility.artifact.phase,
        requiredSuiteVersion,
        foundSuiteVersion: eligibility.artifact.suiteVersion,
        certifiedAt: eligibility.artifact.certifiedAt,
        artifactPath: eligibility.artifactPath ?? artifactPath,
        artifactScope: eligibility.storageScope,
        ...(canary ? { liveCanaryStatus: canary.status, liveCanaryRanAt: canary.ranAt } : {}),
      });
    }
  }

  return {
    ok: true,
    modelId: input.modelId,
    nativeProvider,
    storagePath: eligibility.artifactPath ?? artifactPath,
    artifact: eligibility.artifact,
    certified: true,
  };
}

/**
 * A coding launch is declared explicitly via `launchPhase: 'coding'` or,
 * fail-closed, inferred from the `patch` certification phase that only coding
 * launches require.
 */
function isCodingLaunch(input: NativeGateInput): boolean {
  if (input.launchPhase !== undefined) {
    return input.launchPhase === 'coding';
  }
  return input.requiredPhase === 'patch';
}

function mapCanaryReason(reason: LiveCodingCanaryIneligibilityReason): NativeGateRejectReason {
  switch (reason) {
    case 'missing':
      return 'missing_live_canary';
    case 'stale':
      return 'stale_live_canary';
    case 'failed':
      return 'failed_live_canary';
    case 'inconclusive':
      return 'inconclusive_live_canary';
    case 'not-live':
      return 'non_live_canary';
    case 'identity-mismatch':
      return 'live_canary_identity_mismatch';
  }
}

function mapEligibilityReason(reason: 'missing' | 'malformed' | 'identity-reidentified' | 'identity-invalidated' | 'wrong-version' | 'stale' | 'phase-insufficient' | 'scenario-failure'): NativeGateRejectReason {
  switch (reason) {
    case 'missing':
      return 'missing_artifact';
    case 'malformed':
      return 'malformed_artifact';
    case 'wrong-version':
      return 'wrong_suite';
    case 'identity-reidentified':
      return 'identity_reidentified';
    case 'identity-invalidated':
      return 'identity_mismatch';
    case 'stale':
      return 'stale_artifact';
    case 'phase-insufficient':
    case 'scenario-failure':
      return 'insufficient_phase';
  }
}

function rejectDecision(input: Omit<NativeGateReject, 'ok' | 'message'>): NativeGateReject {
  return {
    ok: false,
    ...input,
    message: formatRejectMessage(input),
  };
}

function formatRejectMessage(input: Omit<NativeGateReject, 'ok' | 'message'>): string {
  const parts = [
    `reason=${input.reason}`,
    `modelId=${input.modelId}`,
  ];

  if (input.apiKeyEnv) parts.push(`apiKeyEnv=${input.apiKeyEnv}`);
  if (input.nativeCapability) parts.push(`nativeCapability=${input.nativeCapability}`);
  if (input.requiredPhase) parts.push(`requiredPhase=${input.requiredPhase}`);
  if (input.foundPhase) parts.push(`foundPhase=${input.foundPhase}`);
  if (input.requiredSuiteVersion) parts.push(`requiredSuiteVersion=${input.requiredSuiteVersion}`);
  if (input.foundSuiteVersion) parts.push(`foundSuiteVersion=${input.foundSuiteVersion}`);
  if (input.certifiedAt) parts.push(`certifiedAt=${input.certifiedAt}`);
  if (input.artifactPath) parts.push(`artifactPath=${input.artifactPath}`);
  if (input.artifactScope) parts.push(`artifactScope=${input.artifactScope}`);
  if (input.subject) parts.push('subject=current-registry');
  if (input.liveCanaryStatus) parts.push(`liveCanaryStatus=${input.liveCanaryStatus}`);
  if (input.liveCanaryRanAt) parts.push(`liveCanaryRanAt=${input.liveCanaryRanAt}`);
  if (input.expectedModel) parts.push(`expectedModel=${input.expectedModel}`);
  if (input.observedModel) parts.push(`observedModel=${input.observedModel}`);

  return parts.join('; ');
}
