/** Reconstructed qualification replay, never evidence of a live endpoint passing. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { getEffectiveRegistry } from '../../../shared/lib/model-registry.ts';
import { resolveCertificationSubject, endpointRouting } from '../../../shared/lib/native-agent/certification/identity.ts';
import { buildOpenRouterModel } from '../../../shared/lib/native-agent/providers.ts';
import { buildLiveCodingCanaryFixture } from '../../../shared/lib/native-agent/certification/canary-fixtures.ts';
import { CERTIFICATION_SCHEMA_VERSION, type CertificationEndpoint, type NativeCertificationArtifact } from '../../../shared/lib/native-agent/certification/schema.ts';
import { writeGlobalCertification } from '../../../shared/lib/native-agent/certification/store.ts';
import { evaluateNativeProviderGate } from '../../../shared/lib/native-agent/certification/eligibility-gate.ts';
import { buildTechnicalTaskRouterRowV4 } from '../../../shared/lib/hokusai-contribution-builder.ts';

export function replayEndpointQualification(root: string) {
  const registry = getEffectiveRegistry();
  const endpoint: CertificationEndpoint = { tag: 'example/fp4', providerName: 'Example Host', quantization: 'fp4', deploymentRevision: null };
  const resolve = (target = endpoint) => resolveCertificationSubject({ provider: 'openrouter', model: 'kimi-k3', registry, endpoint: target });
  const resolved = resolve();
  const subject = resolved.subject;
  const contribution = buildTechnicalTaskRouterRowV4({ taskId: 'reconstructed-task', runId: 'reconstructed-run', harness: 'wavemill',
    observedAt: new Date().toISOString(), observedSuccess: true, budgetCompliant: true,
    taskDescriptor: { task_type: 'bugfix', language: 'typescript', complexity: 1 }, allowedModels: [subject.providerNativeId], selectedModels: { coder: subject.providerNativeId, reviewer: subject.providerNativeId },
    stageExecutions: [{ stage: 'coding', executedModel: subject.providerNativeId, modelEvidence: 'provider_response', harness: 'native', sessionIds: ['test-session'], cost: { summaries: [] },
      providerExecutions: [{ sessionRef: 'test-session', ownershipAttemptIds: ['test-attempt'], responseId: 'test-response', transport: 'openrouter', requestedModel: 'kimi-k3', responseModel: subject.providerNativeId,
        generation: { providerName: endpoint.providerName, totalCostUsd: 0.01 } }] }],
  });
  const canary = buildLiveCodingCanaryFixture(subject, 'v3', { endpoint, attemptEvidence: [{ attemptId: 'test-attempt', status: 'pass', contribution }] });
  const artifact: NativeCertificationArtifact = { schemaVersion: CERTIFICATION_SCHEMA_VERSION, subject, ...resolved.storageIdentity,
    suiteVersion: 'v3', phase: 'workflow', certifiedAt: new Date().toISOString(), scenarios: [{ scenarioId: 'endpoint-reconstructed-conformance', passed: true }], liveCanary: canary };
  const first = writeGlobalCertification(artifact, { root });
  const secondSubject = resolve({ ...endpoint, tag: 'example/fp8', quantization: 'fp8' }).subject;
  const second = writeGlobalCertification({ ...artifact, subject: secondSubject, liveCanary: undefined }, { root });
  assert.notEqual(first, second, 'independent endpoint artifacts cannot overwrite each other');
  const gate = (target?: CertificationEndpoint) => evaluateNativeProviderGate({ modelId: 'kimi-k3', mode: 'task', requiredPhase: 'patch', launchPhase: 'coding', registry,
    apiKeyPresent: true, apiKeyEnv: 'OPENROUTER_API_KEY', certificationRoot: root, endpoint: target });
  assert.equal(gate(endpoint).ok, true);
  assert.equal(gate(secondSubject.endpoint).ok, false, 'deterministic-only endpoint must not borrow another endpoint canary');
  assert.equal(gate().ok, false, 'endpoint qualifications must not relax production routing');
  const model = buildOpenRouterModel({ modelId: 'kimi-k3', routing: endpointRouting(endpoint) });
  assert.deepEqual(model.compat?.openRouterRouting, { only: ['example/fp4'], allow_fallbacks: false });
  assert.ok(first.startsWith(join(root, 'moonshotai', 'kimi-k3')));
  return { artifact, endpoint, registry, first, gate, contribution };
}

/** Replays the 2026-11-16 K3.1 false-ready incident with sanitized current-schema evidence. */
export async function replayCohortReadiness(root: string) {
  const { evaluateCanaryCohortHealth, resolveCanaryCohort } = await import('../../../shared/lib/native-agent/certification/canary-cohort.ts');
  const registry = getEffectiveRegistry();
  const model = 'kimi-k3.1-pro';
  const resolved = resolveCertificationSubject({ provider: 'openrouter', model, registry });
  const artifact: NativeCertificationArtifact = { schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    subject: resolved.subject, ...resolved.storageIdentity, suiteVersion: 'v3', phase: 'workflow',
    certifiedAt: new Date().toISOString(), scenarios: [{ scenarioId: 'sanitized-readiness-replay', passed: true }],
    liveCanary: buildLiveCodingCanaryFixture(resolved.subject, 'v3') };
  writeGlobalCertification(artifact, { root });
  const metadata = registry.models[model].nativeCapability!.certification;
  delete registry.models[model].nativeCapability!.certification;
  const cohort = resolveCanaryCohort({ repoDir: root, registry,
    config: { canaryCohort: [{ provider: 'openrouter', model }], minCodingReady: 1 } });
  const health = () => evaluateCanaryCohortHealth({ repoDir: root, registry, cohort, certificationRoot: root });
  const gate = () => evaluateNativeProviderGate({ modelId: model, mode: 'task', requiredPhase: 'patch',
    launchPhase: 'coding', registry, apiKeyPresent: true, apiKeyEnv: 'REPLAY_KEY', certificationRoot: root });
  assert.equal(gate().ok, false);
  assert.equal((await health()).codingReadyCount, 0, 'a stored canary cannot bypass missing registry suite metadata');
  registry.models[model].nativeCapability!.certification = metadata;
  assert.equal(gate().ok, true);
  assert.equal((await health()).codingReadyCount, 1, 'restoring the contract makes health and launcher agree');
}
