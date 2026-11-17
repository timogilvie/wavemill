/** Prospective endpoint contract. Legacy model-only canaries keep their literal contract. */
import { createHash } from 'node:crypto';
import type { LiveCodingCanaryLimits, LiveCodingCanaryResult } from './schema.ts';
export type CanaryProfile = 'standard' | 'workflow' | 'cache-heavy';
export const CANARY_SENTINEL_PATH = 'src/canary.ts';
export const CANARY_SENTINEL_INITIAL = "export const CANARY_STATE = 'pending';\n";
export const CANARY_SENTINEL_EXPECTED = "export const CANARY_STATE = 'mutated';\n";
export const CANARY_PAYLOAD = 'quote " slash \\ newline\nUnicode Ω';
export const CANARY_COMPLETION_PATH = 'features/live-canary/.coding-complete';
export const CANARY_TEST_PATH = 'tests/canary.test.ts';
export const CANARY_TEST_COMMAND = `node --test ${CANARY_TEST_PATH}`;
export const DEFAULT_CANARY_MAX_ATTEMPTS = 2;
export const DEFAULT_CANARY_LIMITS: LiveCodingCanaryLimits = {
  // allow-native-harness-deadline: Certification artifact boundary retains the historical identity-hashed spelling; runner maps it to model time.
  maxWallClockMs: 240_000, maxTurns: 6, maxToolCalls: 10, maxTotalTokens: 60_000, maxCostUsd: .5,
};
export function canaryOracle(profile: CanaryProfile): string {
  return `import assert from 'node:assert/strict';\nimport { CANARY_STATE } from '../src/canary.ts';\n${profile === 'standard' ? '' : "import { payload } from '../src/payload.ts';\n"}assert.equal(CANARY_STATE, 'mutated');\n${profile === 'standard' ? '' : `assert.equal(payload, ${JSON.stringify(CANARY_PAYLOAD)});\n`}`;
}
export interface QualificationContract {
  version: 'endpoint-functional/v1';
  oracleHash: string;
  toolContract: 'native-patch-and-command-tools/v1';
  limits: LiveCodingCanaryLimits;
  maxAttempts: number;
}
export function qualificationContract(limits = DEFAULT_CANARY_LIMITS, maxAttempts = DEFAULT_CANARY_MAX_ATTEMPTS): QualificationContract {
  for (const key of Object.keys(DEFAULT_CANARY_LIMITS) as Array<keyof LiveCodingCanaryLimits>) {
    const value = limits[key];
    if (key !== 'maxCostUsd' && !Number.isSafeInteger(value)) throw new Error('Qualification counters must be integers');
    if (!(typeof value === 'number' && Number.isFinite(value) && value > 0)) throw new Error('Incomplete qualification limits');
  }
  for (const value of Object.values(limits)) if (!(Number.isFinite(value) && value > 0)) throw new Error('Invalid qualification limits');
  if (!limits.maxCostUsd || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error('Qualification requires bounded spend and attempts');
  return { version: 'endpoint-functional/v1', oracleHash: createHash('sha256').update(JSON.stringify(['standard', 'workflow', 'cache-heavy'].map(p => canaryOracle(p as CanaryProfile)))).digest('hex'),
    toolContract: 'native-patch-and-command-tools/v1', limits: { ...limits }, maxAttempts };
}
export function sameQualificationContract(a: unknown, b: QualificationContract): boolean {
  if (!a || typeof a !== 'object') return false;
  const value = a as QualificationContract;
  return value.version === b.version && value.oracleHash === b.oracleHash && value.toolContract === b.toolContract
    && value.maxAttempts === b.maxAttempts && Object.entries(b.limits).every(([key, limit]) => value.limits?.[key as keyof LiveCodingCanaryLimits] === limit);
}
/** One preregistered interpretation used by admission, persistence and promotion.
 * Resource/availability outcomes reduce completion; protocol/functional corruption disqualifies.
 * Literal historical results retain the historical any-fail policy.
 */
export function qualificationOutcome(result: LiveCodingCanaryResult) {
  const hardFailure = result.qualificationContract
    ? result.status === 'fail' && result.reason !== 'budget_exceeded'
    : result.status === 'fail';
  return { completed: result.status === 'pass', hardFailure,
    category: hardFailure ? 'functional-or-protocol-failure' : result.status === 'pass' ? 'completed' : 'resource-or-availability' };
}
export function qualificationHistory(results: LiveCodingCanaryResult[]) {
  const failure = results.find(result => qualificationOutcome(result).hardFailure);
  return { hardFailure: !!failure, authoritative: failure ?? results.find(result => !qualificationOutcome(result).completed) ?? results.at(-1) };
}
