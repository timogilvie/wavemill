// ---------------------------------------------------------------------------
// Launch-side helper: derive a `NativeCertificationSnapshot` for the per-turn
// menu resolver. HOK-3054.
//
// The exposure engine needs `maxCertifiedPhase` to decide whether an
// advanced-family tool is eligible. Ready native providers have already
// passed a phase-specific certification gate (see
// `NATIVE_AGENT_PHASE_TO_CERT_PHASE` in ../providers.ts), so we treat the
// gate's phase as a *lower bound* on what the provider is certified for. For
// `loopModelOverride` (e.g. smoke tests) with no certification data, we
// default to `'none'` so every advanced tool is denied.
//
// The certification store may carry a strictly higher `maxCertifiedPhase`
// than the phase gate; the resolver only uses this snapshot to short-circuit
// eligibility. Reading the store per turn is out of scope for this epic
// (HOK-2076 walks that door).
// ---------------------------------------------------------------------------

import type { NativeCertificationSnapshot } from './exposure.ts';
import type { NativeCertificationRequirement, ToolPhase } from './types.ts';

const PHASE_INFERRED_CERTIFICATION: Record<ToolPhase, NativeCertificationRequirement> = {
  planning: 'workflow',
  coding: 'patch',
  review: 'read-only',
};

export interface InferCertificationSnapshotInput {
  phase: ToolPhase;
  /** True when the launch has a ready native provider that passed the gate. */
  readyProviderPresent: boolean;
  /** True when the launch supplies a loopModelOverride bypassing certification. */
  loopModelOverridePresent: boolean;
  /** Optional explicit level (e.g. from the certification store). */
  explicit?: NativeCertificationRequirement;
}

/**
 * Deterministic mapping used by launch code when it does not have a richer
 * source of certification data. The plan's fallback rule:
 * - explicit level wins,
 * - else ready provider → the phase gate's minimum,
 * - else loop-model override → `'none'`.
 */
export function inferCertificationSnapshotForPhase(
  input: InferCertificationSnapshotInput,
): NativeCertificationSnapshot {
  if (input.explicit) {
    return { maxCertifiedPhase: input.explicit };
  }
  if (input.readyProviderPresent) {
    return { maxCertifiedPhase: PHASE_INFERRED_CERTIFICATION[input.phase] };
  }
  if (input.loopModelOverridePresent) {
    return { maxCertifiedPhase: 'none' };
  }
  return { maxCertifiedPhase: 'none' };
}
