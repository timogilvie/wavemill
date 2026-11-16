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
