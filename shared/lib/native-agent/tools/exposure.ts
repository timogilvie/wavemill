// ---------------------------------------------------------------------------
// Advanced-tool exposure engine (HOK-3053 — Epic 10 gate)
//
// Pure, synchronous, side-effect-free eligibility calculation. Inputs are all
// Wavemill-controlled: the requested phase, the resolved wavemill config, the
// native-certification snapshot, and the fully-inflated tool registry
// metadata. No tool output, no prompt content, no environment lookup.
//
// Runs once per phase launch. The returned `eligibleNames` list becomes the
// registry query used to materialise the provider-facing tool schema; the
// returned `denials` are deterministic diagnostics for logs, dashboards, and
// config linters.
// ---------------------------------------------------------------------------

import type {
  NativeAgentAdvancedConfig,
  NativeAgentAdvancedFamilyConfig,
  NativeAgentAllowedPhase,
  WavemillConfig,
} from '../../config.ts';
import {
  ADVANCED_TOOL_FAMILIES,
  CERTIFICATION_LEVEL_ORDER,
  isAdvancedFamily,
  type NativeCertificationRequirement,
  type RegisteredToolMetadata,
  type ToolFamilyId,
  type ToolPhase,
} from './types.ts';

/** Snapshot of the caller's native certification state used by exposure. */
export interface NativeCertificationSnapshot {
  /** Highest phase the model is currently certified for, or `none`. */
  maxCertifiedPhase: NativeCertificationRequirement;
}

export interface EligibilityInput {
  phase: ToolPhase | string;
  config: WavemillConfig;
  certification: NativeCertificationSnapshot;
  /**
   * Fully-inflated registry metadata (as returned by
   * `ToolRegistry.list()`). Order is preserved in `eligibleNames`.
   */
  registry: readonly RegisteredToolMetadata[];
}

export type EligibilityDenial =
  | {
      reason: 'family_not_enabled';
      family: ToolFamilyId;
      toolName: string;
      logicalId: string;
    }
  | {
      reason: 'phase_not_allowed';
      family: ToolFamilyId;
      toolName: string;
      logicalId: string;
      phase: ToolPhase;
    }
  | {
      reason: 'certification_missing';
      family: ToolFamilyId;
      toolName: string;
      logicalId: string;
      requirement: NativeCertificationRequirement;
      actual: NativeCertificationRequirement;
    }
  | {
      reason: 'logical_id_not_allowlisted';
      family: ToolFamilyId;
      toolName: string;
      logicalId: string;
    }
  | { reason: 'unknown_family'; family: string }
  | {
      reason: 'unknown_logical_id';
      family: ToolFamilyId;
      logicalId: string;
    }
  | { reason: 'invalid_phase'; phase: string };

export interface EligibilityResult {
  eligibleNames: readonly string[];
  eligibleFamilies: readonly ToolFamilyId[];
  denials: readonly EligibilityDenial[];
}

const VALID_PHASES: readonly ToolPhase[] = Object.freeze(['planning', 'coding', 'review']);
const KNOWN_FAMILIES: ReadonlySet<ToolFamilyId> = new Set<ToolFamilyId>([
  'core',
  ...ADVANCED_TOOL_FAMILIES,
]);
const DENIAL_REASON_ORDER = [
  'family_not_enabled',
  'phase_not_allowed',
  'certification_missing',
  'logical_id_not_allowlisted',
  'unknown_family',
  'unknown_logical_id',
  'invalid_phase',
] as const;
const DENIAL_REASON_INDEX = new Map<string, number>(
  DENIAL_REASON_ORDER.map((reason, index) => [reason, index]),
);

/**
 * Compute the eligible tool set for a phase launch.
 *
 * Rules:
 * - `exposure: 'always'` tools appear when the requested phase is in the
 *   descriptor's `allowedPhases`.
 * - `exposure: 'opt-in'` tools appear only when the family is enabled for the
 *   phase in config, the descriptor allows the phase, the model's
 *   certification satisfies the descriptor's requirement, and (if the config
 *   supplies a `logicalIds` allowlist) the logical id appears in it.
 * - Every denial is emitted deterministically for logging.
 *
 * The function never reads tool output, prompt content, disk, or process env.
 */
export function computeEligibility(input: EligibilityInput): EligibilityResult {
  const phaseInput = input.phase;
  const validPhase = isValidPhase(phaseInput);
  const denials: EligibilityDenial[] = [];
  const eligibleNames: string[] = [];
  const eligibleFamilies = new Set<ToolFamilyId>();

  if (!validPhase) {
    denials.push({ reason: 'invalid_phase', phase: String(phaseInput) });
  }

  const advancedConfig = normalizeAdvancedConfig(input.config);
  denials.push(...collectUnknownFamilyDenials(advancedConfig));
  denials.push(...collectUnknownLogicalIdDenials(advancedConfig, input.registry));

  for (const metadata of input.registry) {
    const family = metadata.family;
    const logicalId = metadata.logicalId;

    // Advanced-family tools: consult config first, then certification, then
    // logical-id allowlist. If any check fails we record a denial and skip.
    if (isAdvancedFamily(family)) {
      const familyConfig = advancedConfig[family];
      const enabled = familyConfig?.enabled === true;
      if (!enabled) {
        denials.push({ reason: 'family_not_enabled', family, toolName: metadata.name, logicalId });
        continue;
      }

      if (!validPhase) {
        // Invalid phase makes advanced tools ineligible without spamming a
        // per-tool `phase_not_allowed`; the `invalid_phase` denial covers it.
        continue;
      }

      const phase = phaseInput as ToolPhase;
      const familyPhases = familyConfig?.allowedPhases ?? [];
      const configAllowsPhase = familyPhases.includes(phase as NativeAgentAllowedPhase);
      const descriptorAllowsPhase = metadata.allowedPhases.includes(phase);
      if (!configAllowsPhase || !descriptorAllowsPhase) {
        denials.push({
          reason: 'phase_not_allowed',
          family,
          toolName: metadata.name,
          logicalId,
          phase,
        });
        continue;
      }

      const actual = input.certification.maxCertifiedPhase;
      const requirement = metadata.certificationRequirement;
      if (!certificationSatisfies(actual, requirement)) {
        denials.push({
          reason: 'certification_missing',
          family,
          toolName: metadata.name,
          logicalId,
          requirement,
          actual,
        });
        continue;
      }

      const allowlist = familyConfig?.logicalIds;
      if (allowlist !== undefined && allowlist.length > 0 && !allowlist.includes(logicalId)) {
        denials.push({
          reason: 'logical_id_not_allowlisted',
          family,
          toolName: metadata.name,
          logicalId,
        });
        continue;
      }

      eligibleNames.push(metadata.name);
      eligibleFamilies.add(family);
      continue;
    }

    // Core / `always` tools.
    if (!validPhase) {
      continue;
    }
    const phase = phaseInput as ToolPhase;
    if (metadata.allowedPhases.includes(phase)) {
      eligibleNames.push(metadata.name);
      eligibleFamilies.add(family);
    }
  }

  return {
    eligibleNames,
    eligibleFamilies: orderedFamilies(input.registry, eligibleFamilies),
    denials: sortDenials(denials),
  };
}

function normalizeAdvancedConfig(config: WavemillConfig): NativeAgentAdvancedConfig {
  return config.nativeAgent?.advanced ?? {};
}

function collectUnknownFamilyDenials(
  advanced: NativeAgentAdvancedConfig,
): EligibilityDenial[] {
  const denials: EligibilityDenial[] = [];
  for (const key of Object.keys(advanced)) {
    if (!KNOWN_FAMILIES.has(key as ToolFamilyId) || key === 'core') {
      denials.push({ reason: 'unknown_family', family: key });
    }
  }
  return denials;
}

function collectUnknownLogicalIdDenials(
  advanced: NativeAgentAdvancedConfig,
  registry: readonly RegisteredToolMetadata[],
): EligibilityDenial[] {
  const knownByFamily = new Map<ToolFamilyId, Set<string>>();
  for (const meta of registry) {
    let set = knownByFamily.get(meta.family);
    if (!set) {
      set = new Set();
      knownByFamily.set(meta.family, set);
    }
    set.add(meta.logicalId);
  }

  const denials: EligibilityDenial[] = [];
  for (const [family, cfg] of Object.entries(advanced) as Array<
    [string, NativeAgentAdvancedFamilyConfig | undefined]
  >) {
    if (!KNOWN_FAMILIES.has(family as ToolFamilyId)) continue;
    const known = knownByFamily.get(family as ToolFamilyId) ?? new Set();
    for (const logicalId of cfg?.logicalIds ?? []) {
      if (!known.has(logicalId)) {
        denials.push({
          reason: 'unknown_logical_id',
          family: family as ToolFamilyId,
          logicalId,
        });
      }
    }
  }
  return denials;
}

function orderedFamilies(
  registry: readonly RegisteredToolMetadata[],
  eligible: ReadonlySet<ToolFamilyId>,
): readonly ToolFamilyId[] {
  const seen = new Set<ToolFamilyId>();
  const out: ToolFamilyId[] = [];
  for (const meta of registry) {
    if (!eligible.has(meta.family) || seen.has(meta.family)) continue;
    seen.add(meta.family);
    out.push(meta.family);
  }
  return out;
}

function isValidPhase(phase: unknown): phase is ToolPhase {
  return typeof phase === 'string' && VALID_PHASES.includes(phase as ToolPhase);
}

/** True iff `actual` is at or above `required` on the certification ladder. */
export function certificationSatisfies(
  actual: NativeCertificationRequirement,
  required: NativeCertificationRequirement,
): boolean {
  const actualIndex = CERTIFICATION_LEVEL_ORDER.indexOf(actual);
  const requiredIndex = CERTIFICATION_LEVEL_ORDER.indexOf(required);
  if (actualIndex < 0 || requiredIndex < 0) return false;
  return actualIndex >= requiredIndex;
}

function sortDenials(denials: EligibilityDenial[]): EligibilityDenial[] {
  return [...denials].sort((a, b) => {
    const familyA = 'family' in a ? String(a.family) : '';
    const familyB = 'family' in b ? String(b.family) : '';
    if (familyA !== familyB) return familyA < familyB ? -1 : 1;

    const logicalA = 'logicalId' in a ? String(a.logicalId) : '';
    const logicalB = 'logicalId' in b ? String(b.logicalId) : '';
    if (logicalA !== logicalB) return logicalA < logicalB ? -1 : 1;

    const toolA = 'toolName' in a ? String((a as { toolName?: string }).toolName ?? '') : '';
    const toolB = 'toolName' in b ? String((b as { toolName?: string }).toolName ?? '') : '';
    if (toolA !== toolB) return toolA < toolB ? -1 : 1;

    const reasonA = DENIAL_REASON_INDEX.get(a.reason) ?? DENIAL_REASON_ORDER.length;
    const reasonB = DENIAL_REASON_INDEX.get(b.reason) ?? DENIAL_REASON_ORDER.length;
    return reasonA - reasonB;
  });
}
