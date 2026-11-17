/**
 * Live coding canary fixture builder for tests and tooling.
 *
 * Produces schema-valid {@link LiveCodingCanaryResult} shapes only — it does
 * not bypass any gate: persisted artifacts still go through write-side
 * validation, and eligibility still requires status/liveness/identity/freshness
 * to line up with the evaluating subject.
 *
 * @module native-agent/certification/canary-fixtures
 */

import {
  LIVE_CODING_CANARY_SCENARIO_ID,
  type CertificationSubject,
  type LiveCodingCanaryLimits,
  type LiveCodingCanaryResult,
} from './schema.ts';

const FIXTURE_LIMITS: LiveCodingCanaryLimits = {
  maxWallClockMs: 240_000,
  maxTurns: 6,
  maxToolCalls: 10,
  maxTotalTokens: 60_000,
  maxCostUsd: 0.5,
};

/**
 * Build a live canary result matching `subject` and `suiteVersion`.
 * Defaults to a fresh live pass; use `overrides` for negative cases.
 */
export function buildLiveCodingCanaryFixture(
  subject: CertificationSubject,
  suiteVersion: string,
  overrides: Partial<LiveCodingCanaryResult> = {},
): LiveCodingCanaryResult {
  return {
    ...(subject.qualificationContract ? { qualificationContract: subject.qualificationContract, evidence: { structuredMutationToolCalls: 2, mutationToolNames: ['apply_patch', 'create_marker'], expectedSentinelHash: 'fixture', changedPaths: [], completionArtifactPresent: true, finalTest: { status: 'completed', exitCode: 0 } } } : {}),
    scenarioId: LIVE_CODING_CANARY_SCENARIO_ID,
    status: 'pass',
    isLive: true,
    phase: 'coding',
    provider: subject.providerId,
    model: subject.providerModelId,
    providerNativeId: subject.providerNativeId,
    identityFingerprint: subject.identityFingerprint,
    catalogHash: subject.catalogHash,
    suiteVersion,
    ranAt: new Date().toISOString(),
    limits: { ...(subject.qualificationContract?.limits ?? FIXTURE_LIMITS) },
    ...overrides,
  };
}
