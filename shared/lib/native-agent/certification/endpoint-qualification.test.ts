import { getEndpointQualificationScenarios } from './scenarios.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { replayEndpointQualification } from '../../../../tests/fixtures/endpoint-qualification/replay.ts';
import { subjectsEqual, resolveCertificationSubject } from './identity.ts';
import { evaluateEligibility } from './loader.ts';
import { writeGlobalCertification } from './store.ts';

test('endpoint subjects isolate certificates, requests, live evidence, TTL and production eligibility', () => {
  const root = mkdtempSync(join(tmpdir(), 'endpoint-qualification-'));
  try {
    const { artifact, endpoint, registry, gate } = replayEndpointQualification(root);
    assert.equal(evaluateEligibility(artifact, 'wrong-suite', 'patch', new Date(), artifact.subject).eligible, false);
    assert.equal(evaluateEligibility({ ...artifact, phase: 'read-only' }, 'v3', 'patch', new Date(), artifact.subject).eligible, false);
    assert.equal(evaluateEligibility({ ...artifact, certifiedAt: '2024-01-01T00:00:00Z' }, 'v3', 'patch', new Date(), artifact.subject).eligible, false);
    const cheaperRegistry = structuredClone(registry);
    cheaperRegistry.models['kimi-k3'].costPerMillionInputTokensUsd = 0.01;
    assert.equal(subjectsEqual(artifact.subject, resolveCertificationSubject({ provider: 'openrouter', model: 'kimi-k3', registry: cheaperRegistry, endpoint }).subject), true, 'price changes alone must not invalidate compatibility');
    const changed = resolveCertificationSubject({ provider: 'openrouter', model: 'kimi-k3', registry, endpoint: { ...endpoint, deploymentRevision: 'new-deployment' } }).subject;
    assert.equal(subjectsEqual(artifact.subject, changed), false);
    const missingProof = structuredClone(artifact);
    delete missingProof.liveCanary;
    assert.equal(evaluateEligibility({ ...missingProof, phase: 'read-only' }, 'v3', 'read-only', new Date(), artifact.subject).eligible, false, 'read-only cannot bypass endpoint host proof');
    const invalidEvidence = structuredClone(artifact);
    invalidEvidence.liveCanary!.attemptEvidence![0].contribution!.stage_executions[0].task_cost = {} as never;
    assert.throws(() => writeGlobalCertification(invalidEvidence, { root }), /contribution|evidence|schema|valid/i);
    const wrongHost = structuredClone(artifact);
    wrongHost.liveCanary!.attemptEvidence![0].contribution!.stage_executions[0].provider_executions![0].generation!.providerName = 'Different Host';
    writeGlobalCertification(wrongHost, { root });
    assert.equal(gate(endpoint).ok, false, 'wrong observed host cannot grant qualification');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('reconstructed malformed nested tool arguments are rejected while escaped multi-operation patches retain exact bytes', async () => {
  const scenario = getEndpointQualificationScenarios()[0];
  assert.deepEqual(await scenario.assertion!({ provider: 'openrouter', model: 'kimi-k3', transport: 'openai-completions' }), { kind: 'pass' });
});

test('explicit workload budgets propagate through configuration, cohort health and the canonical launch gate', async () => {
  const { writeFileSync } = await import('node:fs');
  const { qualificationContract } = await import('./qualification-contract.ts');
  const { buildLiveCodingCanaryFixture } = await import('./canary-fixtures.ts');
  const { evaluateNativeProviderGate } = await import('./eligibility-gate.ts');
  const { resolveCanaryCohort, evaluateCanaryCohortHealth } = await import('./canary-cohort.ts');
  const { getNativeAgentConfig } = await import('../../config.ts');
  const root = mkdtempSync(join(tmpdir(), 'explicit-qualification-contract-'));
  try {
    const { artifact, endpoint, registry } = replayEndpointQualification(root);
    const contract = qualificationContract({ ...artifact.liveCanary!.limits, maxTurns: 200 });
    const subject = resolveCertificationSubject({ provider: 'openrouter', model: 'kimi-k3', registry, endpoint, qualificationContract: contract }).subject;
    const liveCanary = buildLiveCodingCanaryFixture(subject, 'v3', { endpoint, attemptEvidence: artifact.liveCanary!.attemptEvidence });
    writeGlobalCertification({ ...artifact, subject, liveCanary }, { root });
    writeFileSync(join(root, '.wavemill-config.json'), JSON.stringify({ nativeAgent: { certification: {
      canaryCohort: [{ provider: 'openrouter', model: 'kimi-k3', endpoint, qualificationContract: contract }], minCodingReady: 1,
    } } }));
    const cohort = resolveCanaryCohort({ repoDir: root, registry, config: getNativeAgentConfig(root).certification });
    assert.equal(cohort.members.length, 1);
    const gate = () => evaluateNativeProviderGate({ modelId: 'kimi-k3', mode: 'task', requiredPhase: 'patch', launchPhase: 'coding', registry,
      apiKeyPresent: true, apiKeyEnv: 'TEST_KEY', certificationRoot: root, endpoint, qualificationContract: contract });
    const health = () => evaluateCanaryCohortHealth({ repoDir: root, registry, cohort, certificationRoot: root });
    assert.equal(gate().ok, true);
    assert.equal((await health()).codingReadyCount, 1);
    delete registry.models['kimi-k3'].nativeCapability!.certification;
    assert.equal(gate().ok, false);
    assert.equal((await health()).codingReadyCount, 0, 'stored evidence cannot bypass missing registry suite metadata');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
