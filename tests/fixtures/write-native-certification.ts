#!/usr/bin/env -S npx tsx
/**
 * Write a valid native certification artifact (workflow phase + live coding
 * canary) for a registry model, using the *production* identity and canary
 * builders — a shell test must never hand-write a certification JSON, because
 * the storage identity (provider/model/suite/fingerprint) drifts with the
 * registry and a hand-written artifact silently stops matching.
 *
 * The artifact lands in WAVEMILL_NATIVE_CERTIFICATION_ROOT (export it to a
 * mkdtemp directory first so the test is hermetic on populated dev machines
 * and clean CI runners alike).
 *
 * Usage: node tests/fixtures/write-native-certification.ts <model-id> [more models...]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_MODEL_REGISTRY } from '../../shared/lib/model-registry.ts';
import { buildGlobalCertificationPath } from '../../shared/lib/native-agent/certification/loader.ts';
import { buildLiveCodingCanaryFixture } from '../../shared/lib/native-agent/certification/canary-fixtures.ts';
import { resolveCertificationSubject } from '../../shared/lib/native-agent/certification/identity.ts';
import { CERTIFICATION_SCHEMA_VERSION } from '../../shared/lib/native-agent/certification/schema.ts';

const models = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
if (models.length === 0) {
  console.error('usage: write-native-certification.ts <model-id> [more models...]');
  process.exit(2);
}

for (const modelId of models) {
  const capabilities = DEFAULT_MODEL_REGISTRY.models[modelId];
  const suiteVersion = capabilities?.nativeCapability?.certification?.certificationSuiteVersion;
  const provider = capabilities?.nativeCapability?.nativeProvider;
  if (!suiteVersion || !provider) {
    console.error(`model ${modelId} has no native certification metadata in the registry`);
    process.exit(2);
  }
  const identity = resolveCertificationSubject({ provider, model: modelId, registry: DEFAULT_MODEL_REGISTRY });
  const path = buildGlobalCertificationPath(
    identity.storageIdentity.provider,
    identity.storageIdentity.model,
    suiteVersion,
  );
  mkdirSync(dirname(path), { recursive: true });
  const now = Date.now();
  const artifact = {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    subject: identity.subject,
    provider: identity.storageIdentity.provider,
    model: identity.storageIdentity.model,
    phase: 'workflow',
    suiteVersion,
    certifiedAt: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    expiresAt: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString(),
    scenarios: [{ scenarioId: `${provider}-workflow-launch`, passed: true }],
    liveCanary: buildLiveCodingCanaryFixture(identity.subject, suiteVersion, {
      ranAt: new Date(now - 60 * 60 * 1000).toISOString(),
    }),
  };
  writeFileSync(path, JSON.stringify(artifact, null, 2), 'utf-8');
  console.log(path);
}
