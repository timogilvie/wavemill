/**
 * Native certification filter for workflow router candidate pools.
 *
 * Applies per-role phase requirements to native model candidates before
 * final pool selection. Non-native models pass through unchanged.
 *
 * Phase requirements by router role:
 * - reviewer: read-only operations → requires at least `read-only` cert
 * - coder: patch operations → requires at least `patch` cert
 * - planner: workflow orchestration → requires at least `workflow` cert
 *
 * All native models without a valid, fresh, phase-satisfying artifact are
 * rejected fail-closed. Non-native models are never affected.
 *
 * @module native-agent/certification/router-filter
 */

import {
  evaluateNativeProviderGate,
  type NativeGateRejectReason,
} from './eligibility-gate.ts';
import type { CertificationPhase } from './schema.ts';
import { getNativeAgentConfig, type NativeAgentAllowedPhase } from '../../config.ts';
import type { ModelRegistry, NativeProviderName } from '../../model-registry.ts';
import { resolveLaunchPriorityModel, type RoleEligibility } from '../../openrouter-catalog.ts';

/** Router role names as used in workflow-router.ts */
export type RouterRole = 'planner' | 'coder' | 'reviewer';

/**
 * Required certification phase for each router role.
 *
 * reviewer → read-only: reviewer reads diffs and outputs comments only.
 * coder → patch: coder produces patch-level file edits.
 * planner → workflow: planner orchestrates the full multi-phase workflow.
 */
export const STAGE_PHASE_REQUIREMENT: Record<RouterRole, CertificationPhase> = {
  reviewer: 'read-only',
  coder: 'patch',
  planner: 'workflow',
};

export const ROUTER_ROLE_LAUNCH_PHASE: Record<RouterRole, RoleEligibility> = {
  reviewer: 'review',
  coder: 'coding',
  planner: 'planning',
};

/**
 * Normalized router-facing certification rejection reasons.
 *
 * - `missing-api-key`   — native provider API key is absent
 * - `missing-artifact`  — artifact file is absent or unreadable
 * - `malformed`         — artifact cannot be parsed or fails schema validation
 * - `wrong-suite`       — schemaVersion or suiteVersion mismatch
 * - `stale`             — TTL or explicit expiresAt exceeded
 * - `insufficient-phase`— certified phase does not satisfy the required phase,
 *                         or a required scenario failed
 * - `identity-reidentified` — artifact subject does not match current registry identity
 * - `role-ineligible`   — launch-priority metadata excludes this router role
 * - `phase-not-allowed` — nativeAgent.allowedPhases excludes this launch phase
 * - `missing-live-canary`        — coder role requires a live coding canary; none recorded
 * - `stale-live-canary`          — recorded canary pass is past its freshness boundary
 * - `failed-live-canary`         — canary definitively failed (protocol/mutation/artifact)
 * - `inconclusive-live-canary`   — canary ended in a transient provider error
 * - `non-live-canary`            — canary evidence was not produced by a live provider run
 * - `live-canary-identity-mismatch` — canary identity does not match the current subject
 */
export type RouterCertificationRejectionReason =
  | 'no-native-capability'
  | 'missing-api-key'
  | 'missing-artifact'
  | 'malformed'
  | 'wrong-suite'
  | 'stale'
  | 'insufficient-phase'
  | 'identity-reidentified'
  | 'identity-mismatch'
  | 'role-ineligible'
  | 'phase-not-allowed'
  | 'missing-live-canary'
  | 'stale-live-canary'
  | 'failed-live-canary'
  | 'inconclusive-live-canary'
  | 'non-live-canary'
  | 'live-canary-identity-mismatch';

/**
 * Diagnostic record for a native model rejected during router pool filtering.
 *
 * Structured so test assertions can verify: model, role, phase, capability,
 * required suite version, and the exact rejection reason.
 */
export interface RouterCertificationRejection {
  /** Model identifier that was rejected */
  modelId: string;
  /** Router role this filter was applied for */
  role: RouterRole;
  /** Launch phase corresponding to the router role */
  requestedLaunchPhase: RoleEligibility;
  /** Certification phase required by this role */
  requestedPhase: CertificationPhase;
  /** Phase found in the artifact, if it was readable */
  certifiedPhase?: CertificationPhase;
  /** `readOnlyNative` value from the model registry */
  nativeCapability: string;
  /** Native provider from the model registry, when known */
  nativeProvider?: NativeProviderName;
  /** Launch-priority roles for this model, when the model is known there */
  eligibleRoles?: readonly RoleEligibility[];
  /** Configured nativeAgent phases, when that config gate rejected the model */
  allowedNativeAgentPhases?: readonly NativeAgentAllowedPhase[];
  /** Suite version used for the artifact lookup */
  requiredSuiteVersion: string;
  /** Normalized rejection reason */
  reason: RouterCertificationRejectionReason;
  /** Global certification artifact path checked by the gate, when known */
  artifactPath?: string;
  /** API key environment variable checked by the gate, when relevant */
  apiKeyEnv?: string;
}

export interface FilterNativeModelsOptions {
  now?: Date;
  apiKeyPresent?: boolean;
  apiKeyEnv?: string;
  certificationRoot?: string;
}

function mapGateReason(reason: NativeGateRejectReason): RouterCertificationRejectionReason {
  switch (reason) {
    case 'missing_api_key':
      return 'missing-api-key';
    case 'missing_artifact':
      return 'missing-artifact';
    case 'malformed_artifact':
      return 'malformed';
    case 'unregistered_model':
      return 'no-native-capability';
    case 'wrong_suite':
      return 'wrong-suite';
    case 'identity_reidentified':
      return 'identity-reidentified';
    case 'identity_mismatch':
      return 'identity-mismatch';
    case 'stale_artifact':
      return 'stale';
    case 'insufficient_phase':
      return 'insufficient-phase';
    case 'missing_live_canary':
      return 'missing-live-canary';
    case 'stale_live_canary':
      return 'stale-live-canary';
    case 'failed_live_canary':
      return 'failed-live-canary';
    case 'inconclusive_live_canary':
      return 'inconclusive-live-canary';
    case 'non_live_canary':
      return 'non-live-canary';
    case 'live_canary_identity_mismatch':
      return 'live-canary-identity-mismatch';
  }
}

function launchPriorityRoleEligibility(modelId: string, phase: RoleEligibility): {
  eligible: boolean;
  eligibleRoles?: readonly RoleEligibility[];
} {
  const launchPriorityModel = resolveLaunchPriorityModel(modelId);
  if (!launchPriorityModel) {
    return { eligible: true };
  }
  return {
    eligible: launchPriorityModel.roleEligibility.includes(phase),
    eligibleRoles: launchPriorityModel.roleEligibility,
  };
}

function nativeAgentPhaseEligibility(role: RouterRole, repoDir: string): {
  eligible: boolean;
  allowedNativeAgentPhases?: readonly NativeAgentAllowedPhase[];
} {
  const requestedLaunchPhase = ROUTER_ROLE_LAUNCH_PHASE[role];
  if (requestedLaunchPhase === 'coding') {
    return { eligible: true };
  }

  const config = getNativeAgentConfig(repoDir);
  if (config.enabled !== true) {
    return { eligible: true };
  }

  const allowedNativeAgentPhases = config.allowedPhases ?? [];
  return {
    eligible: allowedNativeAgentPhases.includes(requestedLaunchPhase as NativeAgentAllowedPhase),
    allowedNativeAgentPhases,
  };
}

/**
 * Filter native model candidates for a given router role.
 *
 * For each model in `models`:
 * - If the model has no `nativeCapability` in the registry: pass through for
 *   hosted models, but reject legacy OpenRouter/deepseek launcher entries.
 * - If the model has `nativeCapability` but no registry certification metadata or
 *   no `nativeProvider`: reject as `missing` fail-closed.
 * - Otherwise: load the on-disk certification artifact and evaluate it against
 *   the required phase. Accept if eligible; reject with structured diagnostics if not.
 *
 * @param models - Candidate model IDs to filter
 * @param role - Router role determining the required certification phase
 * @param registry - Model registry for native capability metadata
 * @param repoDir - Repository root for loading on-disk certification artifacts
 * @param now - Optional override for deterministic TTL evaluation in tests
 */
export function filterNativeModels(
  models: string[],
  role: RouterRole,
  registry: ModelRegistry,
  repoDir: string,
  nowOrOptions?: Date | FilterNativeModelsOptions,
): { eligible: string[]; rejected: RouterCertificationRejection[] } {
  const options = nowOrOptions instanceof Date ? { now: nowOrOptions } : nowOrOptions;
  const requiredPhase = STAGE_PHASE_REQUIREMENT[role];
  const requestedLaunchPhase = ROUTER_ROLE_LAUNCH_PHASE[role];
  const eligible: string[] = [];
  const rejected: RouterCertificationRejection[] = [];

  for (const modelId of models) {
    const capabilities = registry.models[modelId];
    const nativeCapability = capabilities?.nativeCapability;

    // Hosted model without native metadata — pass through unchanged.
    // OpenRouter/deepseek shim entries must fail closed until they carry
    // native capability metadata and certification.
    if (!nativeCapability) {
      const registeredAgent = capabilities?.agent as string | undefined;
      if (registeredAgent === 'claude-openrouter' || registeredAgent === 'claude-deepseek') {
        rejected.push({
          modelId,
          role,
          requestedLaunchPhase,
          requestedPhase: requiredPhase,
          nativeCapability: 'unregistered',
          requiredSuiteVersion: '',
          reason: 'no-native-capability',
        });
        continue;
      }
      eligible.push(modelId);
      continue;
    }

    const readOnlyNative = nativeCapability.readOnlyNative;
    const certMeta = nativeCapability.certification;
    const nativeProvider = nativeCapability.nativeProvider;

    const roleEligibility = launchPriorityRoleEligibility(modelId, requestedLaunchPhase);
    if (!roleEligibility.eligible) {
      rejected.push({
        modelId,
        role,
        requestedLaunchPhase,
        requestedPhase: requiredPhase,
        nativeCapability: readOnlyNative,
        ...(nativeProvider ? { nativeProvider } : {}),
        ...(roleEligibility.eligibleRoles ? { eligibleRoles: roleEligibility.eligibleRoles } : {}),
        requiredSuiteVersion: certMeta?.certificationSuiteVersion ?? '',
        reason: 'role-ineligible',
      });
      continue;
    }

    const nativeAgentPhase = nativeAgentPhaseEligibility(role, repoDir);
    if (!nativeAgentPhase.eligible) {
      rejected.push({
        modelId,
        role,
        requestedLaunchPhase,
        requestedPhase: requiredPhase,
        nativeCapability: readOnlyNative,
        ...(nativeProvider ? { nativeProvider } : {}),
        ...(nativeAgentPhase.allowedNativeAgentPhases
          ? { allowedNativeAgentPhases: nativeAgentPhase.allowedNativeAgentPhases }
          : {}),
        requiredSuiteVersion: certMeta?.certificationSuiteVersion ?? '',
        reason: 'phase-not-allowed',
      });
      continue;
    }

    // Missing registry metadata or provider — fail closed as missing artifact/config.
    if (!certMeta || !nativeProvider) {
      rejected.push({
        modelId,
        role,
        requestedLaunchPhase,
        requestedPhase: requiredPhase,
        nativeCapability: readOnlyNative,
        ...(nativeProvider ? { nativeProvider } : {}),
        requiredSuiteVersion: certMeta?.certificationSuiteVersion ?? '',
        reason: 'missing-artifact',
      });
      continue;
    }

    const decision = evaluateNativeProviderGate({
      modelId,
      mode: 'task',
      requiredPhase,
      launchPhase: requestedLaunchPhase === 'coding'
        ? 'coding'
        : requestedLaunchPhase === 'review'
          ? 'review'
          : 'planning',
      registry,
      repoDir,
      apiKeyPresent: options?.apiKeyPresent ?? true,
      apiKeyEnv: options?.apiKeyEnv ?? 'ROUTER_FILTER_UNUSED',
      now: options?.now,
      certificationRoot: options?.certificationRoot,
    });

    if (decision.ok) {
      eligible.push(modelId);
    } else {
      rejected.push({
        modelId,
        role,
        requestedLaunchPhase,
        requestedPhase: requiredPhase,
        certifiedPhase: decision.foundPhase,
        nativeCapability: readOnlyNative,
        nativeProvider,
        requiredSuiteVersion: certMeta.certificationSuiteVersion,
        reason: mapGateReason(decision.reason),
        ...(decision.artifactPath ? { artifactPath: decision.artifactPath } : {}),
        ...(decision.apiKeyEnv ? { apiKeyEnv: decision.apiKeyEnv } : {}),
      });
    }
  }

  return { eligible, rejected };
}
