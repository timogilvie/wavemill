import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { invalidateCertificationIdentity } from './identity-invalidation.ts';
import { serializeCertification } from './store.ts';
import {
  CERTIFICATION_SCHEMA_VERSION,
  type NativeCertificationArtifact,
} from './schema.ts';

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'identity-invalidation-'));
}

function makeAliasArtifact(suiteVersion = 'wavemill-1.0'): NativeCertificationArtifact {
  return {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    subject: {
      registryKey: 'gemini-rolling',
      nativeProvider: 'openrouter',
      providerId: 'google',
      providerModelId: '~gemini-pro-latest',
      providerNativeId: '~google/gemini-pro-latest',
      identityRevision: 1,
      identityFingerprint: 'fp-1',
      catalogHash: 'hash-1',
    },
    provider: 'google',
    model: '~gemini-pro-latest',
    phase: 'workflow',
    suiteVersion,
    certifiedAt: '2026-01-01T00:00:00.000Z',
    scenarios: [{ scenarioId: 's1', passed: true }],
    resolvedTarget: {
      requestedWireId: '~google/gemini-pro-latest',
      model: 'google/gemini-3.1-pro-preview',
      observedAt: '2026-01-01T00:00:00.000Z',
      source: 'provider-response',
      responseId: 'gen-pin-1',
    },
  };
}

function writeArtifactAt(root: string, artifact: NativeCertificationArtifact): string {
  const dir = join(root, artifact.provider, artifact.model);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${artifact.suiteVersion}.json`);
  writeFileSync(path, serializeCertification(artifact));
  return path;
}

test('invalidateCertificationIdentity writes identityInvalidation and audit', () => {
  const root = makeTempRoot();
  try {
    const artifact = makeAliasArtifact();
    const path = writeArtifactAt(root, artifact);

    const result = invalidateCertificationIdentity({
      artifactPath: path,
      expectedModel: 'google/gemini-3.1-pro-preview',
      observedModel: 'google/gemini-3.2-pro-preview',
      requestedWireId: '~google/gemini-pro-latest',
      source: 'runtime',
      phase: 'coding',
      session: 'sess-1',
      issue: 'HOK-3143',
      now: () => new Date('2026-10-02T12:00:00.000Z'),
    });

    assert.equal(result.status, 'invalidated');
    assert.ok(result.auditPath && existsSync(result.auditPath));
    assert.match(result.recertCommand, /--live-coding-canary/);

    const rewritten = JSON.parse(readFileSync(path, 'utf-8'));
    assert.equal(rewritten.identityInvalidation.reason, 'identity_mismatch');
    assert.equal(rewritten.identityInvalidation.expectedModel, 'google/gemini-3.1-pro-preview');
    assert.equal(rewritten.identityInvalidation.observedModel, 'google/gemini-3.2-pro-preview');
    assert.equal(rewritten.identityInvalidation.source, 'runtime');
    assert.equal(rewritten.identityInvalidation.phase, 'coding');
    assert.equal(rewritten.identityInvalidation.session, 'sess-1');
    assert.equal(rewritten.identityInvalidation.issue, 'HOK-3143');
    assert.equal(rewritten.resolvedTarget.model, 'google/gemini-3.1-pro-preview');

    // Audit entry carries the recert command.
    const audit = JSON.parse(readFileSync(result.auditPath!, 'utf-8'));
    assert.equal(audit.operation, 'invalidate');
    assert.equal(audit.reason, 'identity_mismatch');
    assert.deepEqual(audit.recertificationCommands, [result.recertCommand]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalidateCertificationIdentity is idempotent (second call reports already-invalidated)', () => {
  const root = makeTempRoot();
  try {
    const path = writeArtifactAt(root, makeAliasArtifact());
    const now = () => new Date('2026-10-02T12:00:00.000Z');
    const common = {
      artifactPath: path,
      expectedModel: 'google/gemini-3.1-pro-preview',
      observedModel: 'google/gemini-3.2-pro-preview',
      requestedWireId: '~google/gemini-pro-latest',
      source: 'runtime' as const,
      now,
    };
    const first = invalidateCertificationIdentity(common);
    assert.equal(first.status, 'invalidated');

    const second = invalidateCertificationIdentity(common);
    assert.equal(second.status, 'already-invalidated');
    // First-writer-wins: on-disk record still from the first call.
    const rewritten = JSON.parse(readFileSync(path, 'utf-8'));
    assert.equal(rewritten.identityInvalidation.invalidatedAt, '2026-10-02T12:00:00.000Z');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalidateCertificationIdentity returns skipped for a missing artifact', () => {
  const root = makeTempRoot();
  try {
    const missing = join(root, 'openrouter', '~google', '~gemini-pro-latest', 'wavemill-1.0.json');
    const result = invalidateCertificationIdentity({
      artifactPath: missing,
      expectedModel: 'a',
      observedModel: 'b',
      requestedWireId: '~x/y',
      source: 'runtime',
    });
    assert.equal(result.status, 'skipped');
    assert.match(result.detail ?? '', /not-found|unreadable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalidation audit lives under .audits/ next to the storage root', () => {
  const root = makeTempRoot();
  try {
    const path = writeArtifactAt(root, makeAliasArtifact());
    const result = invalidateCertificationIdentity({
      artifactPath: path,
      expectedModel: 'google/gemini-3.1-pro-preview',
      observedModel: 'google/gemini-3.2-pro-preview',
      requestedWireId: '~google/gemini-pro-latest',
      source: 'certification',
    });
    assert.equal(result.status, 'invalidated');
    const auditsDir = join(root, '.audits');
    assert.ok(existsSync(auditsDir));
    const files = readdirSync(auditsDir);
    assert.equal(files.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
