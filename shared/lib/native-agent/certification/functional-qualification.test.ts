import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replayFunctionalQualification, assertFunctionalQualificationJourney } from '../../../../tests/fixtures/endpoint-qualification/functional-replay.ts';
import { qualificationContract, qualificationOutcome, qualificationHistory } from './qualification-contract.ts';
import { buildLiveCodingCanaryFixture } from './canary-fixtures.ts';
import { replayEndpointQualification } from '../../../../tests/fixtures/endpoint-qualification/replay.ts';
import { evaluateLiveCodingCanaryEligibility } from './schema.ts';

test('captured StreamLake patch retains its historical literal failure and passes prospective functional verification', async () => {
  const root = mkdtempSync(join(tmpdir(), 'functional-replay-'));
  try {
    const old = await replayFunctionalQualification(root, 'formatting', true);
    const result = await replayFunctionalQualification(root);
    assert.equal(old.reason, 'wrong_mutation');
    assert.equal(result.status, 'pass', result.detail);
    assert.equal(result.evidence?.formattingDifference, true);
    assert.equal(result.evidence?.actualSentinelHash, old.evidence?.actualSentinelHash);
    assert.deepEqual(result.evidence?.finalTest, { status: 'completed', exitCode: 0 });
    await assertFunctionalQualificationJourney(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('final verification rejects corruption, stale test passes, invalid completion, oracle tampering and malformed patches', async () => {
  const root = mkdtempSync(join(tmpdir(), 'functional-failures-'));
  try {
    for (const mode of ['wrong-value', 'wrong-escaping', 'after-test', 'tampered-oracle', 'extra-file', 'invalid-marker', 'malformed']) {
      const result = await replayFunctionalQualification(root, mode);
      assert.equal(result.status, 'fail', `${mode}: ${result.detail}`);
      assert.equal(qualificationOutcome(result).hardFailure, true);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resource failures reduce completion without hiding functional failures; missing or stale contract evidence refuses launch', () => {
  const root = mkdtempSync(join(tmpdir(), 'qualification-contract-'));
  try {
    const { artifact } = replayEndpointQualification(root);
    const subject = artifact.subject!;
    const budget = buildLiveCodingCanaryFixture(subject, 'v3', { status: 'fail', reason: 'budget_exceeded' });
    const broken = { ...budget, reason: 'wrong_mutation' as const };
    assert.equal(qualificationOutcome(budget).hardFailure, false);
    assert.equal(qualificationOutcome({ ...budget, qualificationContract: undefined }).hardFailure, true, 'historical interpretation unchanged');
    assert.equal(qualificationHistory([budget, broken, artifact.liveCanary!]).authoritative, broken);
    assert.equal(evaluateLiveCodingCanaryEligibility(artifact, 'v3', new Date(), subject).eligible, true);
    for (const change of [ { qualificationContract: undefined }, { qualificationContract: { ...qualificationContract(), version: 'old' } }, { evidence: undefined }, { limits: { ...budget.limits, maxTurns: 100 } } ]) {
      assert.equal(evaluateLiveCodingCanaryEligibility({ ...artifact, liveCanary: { ...artifact.liveCanary!, ...change } as never }, 'v3', new Date(), subject).eligible, false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
