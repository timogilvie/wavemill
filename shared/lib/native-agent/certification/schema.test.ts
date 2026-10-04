import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import Ajv from 'ajv';
import {
  CERTIFICATION_BASE_PATH,
  CERTIFICATION_SCHEMA_VERSION,
  CERTIFICATION_TTL_DAYS,
  LIVE_CODING_CANARY_SCENARIO_ID,
  LIVE_CODING_CANARY_TTL_DAYS,
  PHASE_ORDER,
  allScenariosPassed,
  evaluateLiveCodingCanaryEligibility,
  isCertificationFresh,
  isLiveCodingCanaryFresh,
  liveCodingCanaryMatchesSubject,
  phaseSatisfies,
  type CertificationSubject,
  type LiveCodingCanaryResult,
  type NativeCertificationArtifact,
} from './schema.ts';
import {
  buildCertificationPath,
  checkCertificationEligibility,
  evaluateEligibility,
  isValidPathSegment,
  loadCertification,
  parseCertificationPath,
} from './loader.ts';

const FIXTURE_DIR = new URL('./fixtures', import.meta.url).pathname;
const CERTIFICATION_JSON_SCHEMA = JSON.parse(readFileSync(new URL('./schema.json', import.meta.url), 'utf-8'));
const validateCertificationSchema = new Ajv({ allErrors: true, strict: false, validateFormats: false }).compile(
  CERTIFICATION_JSON_SCHEMA,
);
const VALID_SUBJECT: CertificationSubject = {
  registryKey: 'claude-sonnet-4-6',
  nativeProvider: 'anthropic',
  providerId: 'anthropic',
  providerModelId: 'claude-sonnet-4-6',
  providerNativeId: 'claude-sonnet-4-6',
  identityRevision: 1,
  identityFingerprint: 'test-fingerprint',
  catalogHash: 'registry',
};

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf-8'));
}

function makeValidArtifact(overrides: Partial<NativeCertificationArtifact> = {}): NativeCertificationArtifact {
  return {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    subject: VALID_SUBJECT,
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    phase: 'read-only',
    suiteVersion: 'v1',
    certifiedAt: new Date().toISOString(),
    scenarios: [{ scenarioId: 'list-files', passed: true }],
    ...overrides,
  };
}

function makeTempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'native-cert-test-'));
}

function cleanupRepo(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function writeArtifact(repoDir: string, provider: string, model: string, suiteVersion: string, artifact: unknown): string {
  const p = buildCertificationPath(repoDir, provider, model, suiteVersion);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(artifact, null, 2), 'utf-8');
  return p;
}

// ─── Schema constants ──────────────────────────────────────────────────────

describe('schema constants', () => {
  it('exports CERTIFICATION_SCHEMA_VERSION as 3', () => {
    assert.equal(CERTIFICATION_SCHEMA_VERSION, 3);
  });

  it('exports TTL as 60 days', () => {
    assert.equal(CERTIFICATION_TTL_DAYS, 60);
  });

  it('exports PHASE_ORDER with correct ordering', () => {
    assert.deepEqual(PHASE_ORDER, ['read-only', 'patch', 'workflow']);
  });

  it('exports CERTIFICATION_BASE_PATH', () => {
    assert.equal(CERTIFICATION_BASE_PATH, '.wavemill/native-agent-certifications');
  });
});

// ─── JSON Schema contract ─────────────────────────────────────────────────

describe('schema.json', () => {
  it('validates an artifact constructed from TypeScript types', () => {
    const artifact = makeValidArtifact({
      expiresAt: '2099-12-31T23:59:59.999Z',
      knownLimitations: ['does not support workflow tools'],
      totalRetryCount: 1,
      scenarios: [{
        scenarioId: 'list-files',
        passed: true,
        retryCount: 1,
        attempts: 2,
        finalAttemptStatus: 'pass',
      }],
    });

    assert.equal(validateCertificationSchema(artifact), true, JSON.stringify(validateCertificationSchema.errors));
  });

  it('accepts new retry-accounting fields on a scenario result', () => {
    const artifact = makeValidArtifact({
      scenarios: [{
        scenarioId: 'list-files',
        passed: true,
        retryCount: 2,
        attempts: 3,
        finalAttemptStatus: 'pass',
      }],
    });

    assert.equal(validateCertificationSchema(artifact), true, JSON.stringify(validateCertificationSchema.errors));
  });

  it('rejects invalid failureClass values', () => {
    const artifact = makeValidArtifact({
      scenarios: [{
        scenarioId: 'list-files',
        passed: false,
        failureMessage: 'transient',
        attempts: 3,
        finalAttemptStatus: 'provider-flake',
        failureClass: 'flaky' as never,
      }],
    });

    assert.equal(validateCertificationSchema(artifact), false);
    assert.ok(validateCertificationSchema.errors?.some(error => `${error.instancePath}`.includes('/failureClass')));
  });

  it('rejects attempts below the minimum', () => {
    for (const attempts of [0, -1]) {
      const artifact = makeValidArtifact({
        scenarios: [{
          scenarioId: 'list-files',
          passed: false,
          failureMessage: 'bad attempts',
          attempts,
        }],
      });

      assert.equal(validateCertificationSchema(artifact), false);
      assert.ok(validateCertificationSchema.errors?.some(error => `${error.instancePath}`.includes('/attempts')));
    }
  });

  it('valid-read-only fixture remains schema-valid', () => {
    assert.equal(validateCertificationSchema(loadFixture('valid-read-only.json')), true, JSON.stringify(validateCertificationSchema.errors));
  });

  for (const field of CERTIFICATION_JSON_SCHEMA.$defs.CurrentArtifact.required as string[]) {
    it(`rejects an artifact missing required field ${field}`, () => {
      const artifact = { ...makeValidArtifact() } as Record<string, unknown>;
      delete artifact[field];

      assert.equal(validateCertificationSchema(artifact), false);
      assert.ok(
        validateCertificationSchema.errors?.some(error => error.keyword === 'required' && error.params.missingProperty === field),
      );
    });
  }
});

// ─── phaseSatisfies ────────────────────────────────────────────────────────

describe('phaseSatisfies', () => {
  it('read-only satisfies read-only', () => {
    assert.ok(phaseSatisfies('read-only', 'read-only'));
  });

  it('patch satisfies read-only', () => {
    assert.ok(phaseSatisfies('patch', 'read-only'));
  });

  it('patch satisfies patch', () => {
    assert.ok(phaseSatisfies('patch', 'patch'));
  });

  it('workflow satisfies read-only', () => {
    assert.ok(phaseSatisfies('workflow', 'read-only'));
  });

  it('workflow satisfies patch', () => {
    assert.ok(phaseSatisfies('workflow', 'patch'));
  });

  it('workflow satisfies workflow', () => {
    assert.ok(phaseSatisfies('workflow', 'workflow'));
  });

  it('read-only does not satisfy patch', () => {
    assert.ok(!phaseSatisfies('read-only', 'patch'));
  });

  it('read-only does not satisfy workflow', () => {
    assert.ok(!phaseSatisfies('read-only', 'workflow'));
  });

  it('patch does not satisfy workflow', () => {
    assert.ok(!phaseSatisfies('patch', 'workflow'));
  });
});

// ─── isCertificationFresh ─────────────────────────────────────────────────

describe('isCertificationFresh', () => {
  it('returns true when within TTL window', () => {
    const artifact = makeValidArtifact({ certifiedAt: new Date().toISOString() });
    assert.ok(isCertificationFresh(artifact, new Date()));
  });

  it('returns false when past derived TTL', () => {
    const old = new Date(Date.now() - (CERTIFICATION_TTL_DAYS + 1) * 24 * 60 * 60 * 1000);
    const artifact = makeValidArtifact({ certifiedAt: old.toISOString() });
    assert.ok(!isCertificationFresh(artifact, new Date()));
  });

  it('returns true exactly at TTL boundary minus 1ms', () => {
    const now = new Date();
    const certifiedAt = new Date(now.getTime() - (CERTIFICATION_TTL_DAYS * 24 * 60 * 60 * 1000 - 1));
    const artifact = makeValidArtifact({ certifiedAt: certifiedAt.toISOString() });
    assert.ok(isCertificationFresh(artifact, now));
  });

  it('expiresAt takes precedence over derived TTL — future expiresAt on old certifiedAt', () => {
    const old = '2020-01-01T00:00:00.000Z';
    const future = '2099-12-31T23:59:59.999Z';
    const artifact = makeValidArtifact({ certifiedAt: old, expiresAt: future });
    assert.ok(isCertificationFresh(artifact, new Date()));
  });

  it('expiresAt takes precedence — past expiresAt blocks even if certifiedAt is recent', () => {
    const artifact = makeValidArtifact({
      certifiedAt: new Date().toISOString(),
      expiresAt: '2020-01-01T00:00:00.000Z',
    });
    assert.ok(!isCertificationFresh(artifact, new Date()));
  });

  it('returns false when now equals expiresAt (boundary is exclusive)', () => {
    const ts = '2026-06-15T12:00:00.000Z';
    const artifact = makeValidArtifact({ expiresAt: ts });
    assert.ok(!isCertificationFresh(artifact, new Date(ts)));
  });
});

// ─── allScenariosPassed ───────────────────────────────────────────────────

describe('allScenariosPassed', () => {
  it('returns true when all scenarios pass', () => {
    const artifact = makeValidArtifact({
      scenarios: [
        { scenarioId: 'a', passed: true },
        { scenarioId: 'b', passed: true },
      ],
    });
    assert.ok(allScenariosPassed(artifact));
  });

  it('returns false when any scenario fails', () => {
    const artifact = makeValidArtifact({
      scenarios: [
        { scenarioId: 'a', passed: true },
        { scenarioId: 'b', passed: false, failureMessage: 'timeout' },
      ],
    });
    assert.ok(!allScenariosPassed(artifact));
  });

  it('returns false when scenarios array is empty', () => {
    const artifact = makeValidArtifact({ scenarios: [] });
    assert.ok(!allScenariosPassed(artifact));
  });
});

// ─── isValidPathSegment ───────────────────────────────────────────────────

describe('isValidPathSegment', () => {
  it('accepts simple alphanumeric identifiers', () => {
    assert.ok(isValidPathSegment('anthropic'));
    assert.ok(isValidPathSegment('claude-sonnet-4-6'));
    assert.ok(isValidPathSegment('v1'));
  });

  it('accepts model IDs that contain interior dots', () => {
    assert.ok(isValidPathSegment('gpt-5.5'));
    assert.ok(isValidPathSegment('gemini-2.5-pro'));
    assert.ok(isValidPathSegment('qwen-2.5-coder-32b'));
  });

  it('rejects empty string', () => {
    assert.ok(!isValidPathSegment(''));
  });

  it('rejects segments containing forward slash', () => {
    assert.ok(!isValidPathSegment('a/b'));
  });

  it('rejects segments containing backslash', () => {
    assert.ok(!isValidPathSegment('a\\b'));
  });

  it('rejects single dot', () => {
    assert.ok(!isValidPathSegment('.'));
  });

  it('rejects double dot', () => {
    assert.ok(!isValidPathSegment('..'));
  });

  it('rejects segments containing NUL', () => {
    assert.ok(!isValidPathSegment('a\0b'));
  });
});

// ─── buildCertificationPath ───────────────────────────────────────────────

describe('buildCertificationPath', () => {
  it('builds the expected path', () => {
    const p = buildCertificationPath('/repo', 'anthropic', 'claude-sonnet-4-6', 'v1');
    assert.ok(p.endsWith('/.wavemill/native-agent-certifications/anthropic/claude-sonnet-4-6/v1.json'));
  });

  it('maps raw OpenRouter ids into provider/model storage segments', () => {
    const p = buildCertificationPath('/repo', 'openrouter', 'qwen/qwen3-coder', 'v1');
    assert.ok(p.endsWith('/.wavemill/native-agent-certifications/qwen/qwen3-coder/v1.json'));
  });

  it('maps known OpenRouter aliases into provider/model storage segments', () => {
    const p = buildCertificationPath('/repo', 'openrouter', 'qwen-3-coder', 'v1');
    assert.ok(p.endsWith('/.wavemill/native-agent-certifications/qwen/qwen3-coder/v1.json'));
  });

  it('throws on empty provider', () => {
    assert.throws(() => buildCertificationPath('/repo', '', 'model', 'v1'), /provider/);
  });

  it('throws on path traversal in model', () => {
    assert.throws(() => buildCertificationPath('/repo', 'anthropic', '../etc', 'v1'), /model/);
  });

  it('throws on slash in suiteVersion', () => {
    assert.throws(() => buildCertificationPath('/repo', 'anthropic', 'model', 'v1/evil'), /suiteVersion/);
  });
});

// ─── parseCertificationPath ───────────────────────────────────────────────

describe('parseCertificationPath', () => {
  it('round-trips with buildCertificationPath', () => {
    const p = buildCertificationPath('/repo', 'anthropic', 'claude-sonnet-4-6', 'v1');
    const parsed = parseCertificationPath(p);
    assert.deepEqual(parsed, { provider: 'anthropic', model: 'claude-sonnet-4-6', suiteVersion: 'v1' });
  });

  it('returns undefined for paths without the base marker', () => {
    assert.equal(parseCertificationPath('/some/random/path/file.json'), undefined);
  });

  it('returns undefined for paths with wrong segment count', () => {
    const p = '/repo/.wavemill/native-agent-certifications/anthropic/v1.json';
    assert.equal(parseCertificationPath(p), undefined);
  });

  it('returns undefined for paths without .json extension', () => {
    const p = '/repo/.wavemill/native-agent-certifications/anthropic/model/v1';
    assert.equal(parseCertificationPath(p), undefined);
  });
});

// ─── loadCertification ────────────────────────────────────────────────────

describe('loadCertification', () => {
  it('returns missing when file does not exist', () => {
    const repoDir = makeTempRepo();
    try {
      const result = loadCertification(repoDir, 'anthropic', 'claude-sonnet-4-6', 'v1');
      assert.deepEqual(result, { ok: false, reason: 'missing' });
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('returns malformed when file contains invalid JSON', () => {
    const repoDir = makeTempRepo();
    try {
      const p = buildCertificationPath(repoDir, 'anthropic', 'model', 'v1');
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, '{ broken json', 'utf-8');
      const result = loadCertification(repoDir, 'anthropic', 'model', 'v1');
      assert.deepEqual(result, { ok: false, reason: 'malformed' });
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('returns malformed for structurally invalid artifact', () => {
    const repoDir = makeTempRepo();
    try {
      writeArtifact(repoDir, 'anthropic', 'model', 'v1', { schemaVersion: 1, provider: 'anthropic' });
      const result = loadCertification(repoDir, 'anthropic', 'model', 'v1');
      assert.deepEqual(result, { ok: false, reason: 'malformed' });
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('returns ok for a valid artifact', () => {
    const repoDir = makeTempRepo();
    try {
      const artifact = makeValidArtifact();
      writeArtifact(repoDir, artifact.provider, artifact.model, artifact.suiteVersion, artifact);
      const result = loadCertification(repoDir, artifact.provider, artifact.model, artifact.suiteVersion);
      assert.ok(result.ok);
      if (result.ok) {
        assert.equal(result.artifact.provider, 'anthropic');
        assert.equal(result.artifact.phase, 'read-only');
      }
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('returns malformed for invalid path segments', () => {
    const repoDir = makeTempRepo();
    try {
      const result = loadCertification(repoDir, '', 'model', 'v1');
      assert.deepEqual(result, { ok: false, reason: 'malformed' });
    } finally {
      cleanupRepo(repoDir);
    }
  });
});

// ─── evaluateEligibility ──────────────────────────────────────────────────

describe('evaluateEligibility', () => {
  it('returns eligible for a valid artifact matching required suite and phase', () => {
    const artifact = makeValidArtifact({ phase: 'patch' });
    const result = evaluateEligibility(artifact, 'v1', 'patch');
    assert.ok(result.eligible);
  });

  it('returns wrong-version when suiteVersion does not match', () => {
    const artifact = makeValidArtifact({ suiteVersion: 'v0' });
    const result = evaluateEligibility(artifact, 'v1', 'read-only');
    assert.equal(result.eligible, false);
    if (!result.eligible) assert.equal(result.reason, 'wrong-version');
  });

  it('returns stale when artifact is past TTL', () => {
    const old = new Date(Date.now() - (CERTIFICATION_TTL_DAYS + 1) * 24 * 60 * 60 * 1000);
    const artifact = makeValidArtifact({ certifiedAt: old.toISOString() });
    const result = evaluateEligibility(artifact, 'v1', 'read-only');
    assert.equal(result.eligible, false);
    if (!result.eligible) assert.equal(result.reason, 'stale');
  });

  it('returns stale when expiresAt is in the past', () => {
    const artifact = makeValidArtifact({ expiresAt: '2020-01-01T00:00:00.000Z' });
    const result = evaluateEligibility(artifact, 'v1', 'read-only');
    assert.equal(result.eligible, false);
    if (!result.eligible) assert.equal(result.reason, 'stale');
  });

  it('returns phase-insufficient when phase is lower than required', () => {
    const artifact = makeValidArtifact({ phase: 'read-only' });
    const result = evaluateEligibility(artifact, 'v1', 'patch');
    assert.equal(result.eligible, false);
    if (!result.eligible) assert.equal(result.reason, 'phase-insufficient');
  });

  it('returns scenario-failure when a scenario failed', () => {
    const artifact = makeValidArtifact({
      scenarios: [
        { scenarioId: 'a', passed: true },
        { scenarioId: 'b', passed: false, failureMessage: 'error' },
      ],
    });
    const result = evaluateEligibility(artifact, 'v1', 'read-only');
    assert.equal(result.eligible, false);
    if (!result.eligible) assert.equal(result.reason, 'scenario-failure');
  });

  it('returns scenario-failure when scenarios array is empty', () => {
    const artifact = makeValidArtifact({ scenarios: [] });
    const result = evaluateEligibility(artifact, 'v1', 'read-only');
    assert.equal(result.eligible, false);
    if (!result.eligible) assert.equal(result.reason, 'scenario-failure');
  });

  it('returns identity-reidentified before schema-version mismatch when a subject is expected', () => {
    const artifact = {
      ...makeValidArtifact(),
      schemaVersion: 2,
    } as unknown as NativeCertificationArtifact;
    delete (artifact as Record<string, unknown>).subject;
    const result = evaluateEligibility(artifact, 'v1', 'read-only', new Date(), VALID_SUBJECT);
    assert.equal(result.eligible, false);
    if (!result.eligible) assert.equal(result.reason, 'identity-reidentified');
  });

  it('patch certification satisfies read-only requirement', () => {
    const artifact = makeValidArtifact({ phase: 'patch' });
    const result = evaluateEligibility(artifact, 'v1', 'read-only');
    assert.ok(result.eligible);
  });

  it('workflow certification satisfies patch requirement', () => {
    const artifact = makeValidArtifact({ phase: 'workflow' });
    const result = evaluateEligibility(artifact, 'v1', 'patch');
    assert.ok(result.eligible);
  });

  it('checks wrong-version before stale', () => {
    const old = new Date(Date.now() - (CERTIFICATION_TTL_DAYS + 1) * 24 * 60 * 60 * 1000);
    const artifact = makeValidArtifact({ certifiedAt: old.toISOString(), suiteVersion: 'v0' });
    const result = evaluateEligibility(artifact, 'v1', 'read-only');
    assert.equal(result.eligible, false);
    if (!result.eligible) assert.equal(result.reason, 'wrong-version');
  });

  it('injectable now parameter controls TTL evaluation', () => {
    const ancient = '1970-01-01T00:00:00.000Z';
    const artifact = makeValidArtifact({ certifiedAt: ancient });
    // Provide a "now" just 1 day after certifiedAt — should be fresh
    const now = new Date('1970-01-02T00:00:00.000Z');
    const result = evaluateEligibility(artifact, 'v1', 'read-only', now);
    assert.ok(result.eligible);
  });
});

// ─── checkCertificationEligibility (combined) ─────────────────────────────

describe('checkCertificationEligibility', () => {
  it('returns missing when artifact file does not exist', () => {
    const repoDir = makeTempRepo();
    try {
      const result = checkCertificationEligibility(repoDir, 'anthropic', 'claude-sonnet-4-6', 'v1', 'read-only');
      assert.equal(result.eligible, false);
      if (!result.eligible) assert.equal(result.reason, 'missing');
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('returns eligible end-to-end for valid file on disk', () => {
    const repoDir = makeTempRepo();
    try {
      const artifact = makeValidArtifact({ phase: 'patch' });
      writeArtifact(repoDir, artifact.provider, artifact.model, artifact.suiteVersion, artifact);
      const result = checkCertificationEligibility(
        repoDir,
        artifact.provider,
        artifact.model,
        artifact.suiteVersion,
        'read-only',
      );
      assert.ok(result.eligible);
    } finally {
      cleanupRepo(repoDir);
    }
  });
});

// ─── Fixture-based validation ─────────────────────────────────────────────

describe('fixtures', () => {
  it('valid-read-only.json remains readable but ineligible as historical v2', () => {
    const repoDir = makeTempRepo();
    try {
      const raw = loadFixture('valid-read-only.json') as NativeCertificationArtifact;
      writeArtifact(repoDir, raw.provider, raw.model, raw.suiteVersion, raw);
      const loaded = loadCertification(repoDir, raw.provider, raw.model, raw.suiteVersion);
      assert.ok(loaded.ok);
      if (loaded.ok) {
        const result = evaluateEligibility(loaded.artifact, 'v1', 'read-only', new Date('2026-06-30T00:00:00Z'));
        assert.equal(result.eligible, false);
        if (!result.eligible) assert.equal(result.reason, 'wrong-version');
      }
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('valid-patch.json remains readable but ineligible as historical v2', () => {
    const repoDir = makeTempRepo();
    try {
      const raw = loadFixture('valid-patch.json') as NativeCertificationArtifact;
      writeArtifact(repoDir, raw.provider, raw.model, raw.suiteVersion, raw);
      const loaded = loadCertification(repoDir, raw.provider, raw.model, raw.suiteVersion);
      assert.ok(loaded.ok);
      if (loaded.ok) {
        const result = evaluateEligibility(loaded.artifact, 'v1', 'read-only', new Date('2026-06-30T00:00:00Z'));
        assert.equal(result.eligible, false);
        if (!result.eligible) assert.equal(result.reason, 'wrong-version');
      }
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('valid-expires-at.json remains readable but ineligible as historical v2', () => {
    const repoDir = makeTempRepo();
    try {
      const raw = loadFixture('valid-expires-at.json') as NativeCertificationArtifact;
      writeArtifact(repoDir, raw.provider, raw.model, raw.suiteVersion, raw);
      const loaded = loadCertification(repoDir, raw.provider, raw.model, raw.suiteVersion);
      assert.ok(loaded.ok);
      if (loaded.ok) {
        const result = evaluateEligibility(loaded.artifact, 'v1', 'read-only', new Date('2026-06-30T00:00:00Z'));
        assert.equal(result.eligible, false);
        if (!result.eligible) assert.equal(result.reason, 'wrong-version');
      }
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('stale-artifact.json remains readable but ineligible as historical v2', () => {
    const repoDir = makeTempRepo();
    try {
      const raw = loadFixture('stale-artifact.json') as NativeCertificationArtifact;
      writeArtifact(repoDir, raw.provider, raw.model, raw.suiteVersion, raw);
      const loaded = loadCertification(repoDir, raw.provider, raw.model, raw.suiteVersion);
      assert.ok(loaded.ok);
      if (loaded.ok) {
        const result = evaluateEligibility(loaded.artifact, 'v1', 'read-only', new Date('2026-06-30T00:00:00Z'));
        assert.equal(result.eligible, false);
        if (!result.eligible) assert.equal(result.reason, 'wrong-version');
      }
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('stale-expires-at.json remains readable but ineligible as historical v2', () => {
    const repoDir = makeTempRepo();
    try {
      const raw = loadFixture('stale-expires-at.json') as NativeCertificationArtifact;
      writeArtifact(repoDir, raw.provider, raw.model, raw.suiteVersion, raw);
      const loaded = loadCertification(repoDir, raw.provider, raw.model, raw.suiteVersion);
      assert.ok(loaded.ok);
      if (loaded.ok) {
        const result = evaluateEligibility(loaded.artifact, 'v1', 'read-only', new Date('2026-06-30T00:00:00Z'));
        assert.equal(result.eligible, false);
        if (!result.eligible) assert.equal(result.reason, 'wrong-version');
      }
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('wrong-suite-version.json returns wrong-version', () => {
    const repoDir = makeTempRepo();
    try {
      const raw = loadFixture('wrong-suite-version.json') as NativeCertificationArtifact;
      writeArtifact(repoDir, raw.provider, raw.model, 'v1', raw);
      const loaded = loadCertification(repoDir, raw.provider, raw.model, 'v1');
      assert.ok(loaded.ok);
      if (loaded.ok) {
        const result = evaluateEligibility(loaded.artifact, 'v1', 'read-only', new Date('2026-06-30T00:00:00Z'));
        assert.equal(result.eligible, false);
        if (!result.eligible) assert.equal(result.reason, 'wrong-version');
      }
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('phase-insufficient.json remains readable but ineligible as historical v2', () => {
    const repoDir = makeTempRepo();
    try {
      const raw = loadFixture('phase-insufficient.json') as NativeCertificationArtifact;
      writeArtifact(repoDir, raw.provider, raw.model, raw.suiteVersion, raw);
      const loaded = loadCertification(repoDir, raw.provider, raw.model, raw.suiteVersion);
      assert.ok(loaded.ok);
      if (loaded.ok) {
        const result = evaluateEligibility(loaded.artifact, 'v1', 'patch', new Date('2026-06-30T00:00:00Z'));
        assert.equal(result.eligible, false);
        if (!result.eligible) assert.equal(result.reason, 'wrong-version');
      }
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('scenario-failure.json remains readable but ineligible as historical v2', () => {
    const repoDir = makeTempRepo();
    try {
      const raw = loadFixture('scenario-failure.json') as NativeCertificationArtifact;
      writeArtifact(repoDir, raw.provider, raw.model, raw.suiteVersion, raw);
      const loaded = loadCertification(repoDir, raw.provider, raw.model, raw.suiteVersion);
      assert.ok(loaded.ok);
      if (loaded.ok) {
        const result = evaluateEligibility(loaded.artifact, 'v1', 'read-only', new Date('2026-06-30T00:00:00Z'));
        assert.equal(result.eligible, false);
        if (!result.eligible) assert.equal(result.reason, 'wrong-version');
      }
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('malformed-artifact.json returns malformed', () => {
    const repoDir = makeTempRepo();
    try {
      const raw = loadFixture('malformed-artifact.json');
      const p = buildCertificationPath(repoDir, 'anthropic', 'model', 'v1');
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify(raw), 'utf-8');
      const result = loadCertification(repoDir, 'anthropic', 'model', 'v1');
      assert.deepEqual(result, { ok: false, reason: 'malformed' });
    } finally {
      cleanupRepo(repoDir);
    }
  });
});

// ─── Live coding canary schema (HOK-2943) ──────────────────────────────────

describe('live coding canary schema', () => {
  const NOW = new Date('2026-09-01T00:00:00.000Z');
  const RAN_AT = new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString();

  function makeCanary(overrides: Partial<LiveCodingCanaryResult> = {}): LiveCodingCanaryResult {
    return {
      scenarioId: LIVE_CODING_CANARY_SCENARIO_ID,
      status: 'pass',
      isLive: true,
      phase: 'coding',
      provider: VALID_SUBJECT.providerId,
      model: VALID_SUBJECT.providerModelId,
      providerNativeId: VALID_SUBJECT.providerNativeId,
      identityFingerprint: VALID_SUBJECT.identityFingerprint,
      catalogHash: VALID_SUBJECT.catalogHash,
      suiteVersion: 'v1',
      ranAt: RAN_AT,
      limits: { maxWallClockMs: 240_000, maxTurns: 6, maxToolCalls: 10, maxTotalTokens: 60_000, maxCostUsd: 0.5 },
      ...overrides,
    };
  }

  it('artifact with liveCanary validates against schema.json', () => {
    const artifact = makeValidArtifact({
      liveCanary: makeCanary({
        usage: { turns: 2, toolCalls: 2, inputTokens: 1000, outputTokens: 100, wallClockMs: 1500, costUsd: 0.01 },
        evidence: {
          structuredMutationToolCalls: 2,
          mutationToolNames: ['apply_patch', 'create_marker'],
          expectedSentinelHash: 'a'.repeat(64),
          actualSentinelHash: 'a'.repeat(64),
          changedPaths: ['src/canary.ts', 'features/live-canary/.coding-complete'],
          completionArtifactPresent: true,
          completionArtifactHash: 'b'.repeat(64),
        },
        attempts: 1,
      }),
    });
    assert.equal(validateCertificationSchema(artifact), true, JSON.stringify(validateCertificationSchema.errors));
  });

  it('schema.json rejects unknown liveCanary properties and invalid statuses', () => {
    const withUnknown = makeValidArtifact({
      liveCanary: { ...makeCanary(), rogueField: true } as unknown as LiveCodingCanaryResult,
    });
    assert.equal(validateCertificationSchema(withUnknown), false);

    const withBadStatus = makeValidArtifact({
      liveCanary: { ...makeCanary(), status: 'maybe' } as unknown as LiveCodingCanaryResult,
    });
    assert.equal(validateCertificationSchema(withBadStatus), false);
  });

  it('parses artifacts with and without liveCanary (backward compatible)', () => {
    const repoDir = makeTempRepo();
    try {
      writeArtifact(repoDir, 'anthropic', 'legacy', 'v1', makeValidArtifact({ model: 'legacy' }));
      const legacy = loadCertification(repoDir, 'anthropic', 'legacy', 'v1');
      assert.equal(legacy.ok, true);
      assert.equal((legacy as { artifact: NativeCertificationArtifact }).artifact.liveCanary, undefined);

      writeArtifact(repoDir, 'anthropic', 'canaryful', 'v1', makeValidArtifact({
        model: 'canaryful',
        liveCanary: makeCanary(),
      }));
      const canaryful = loadCertification(repoDir, 'anthropic', 'canaryful', 'v1');
      assert.equal(canaryful.ok, true);
      const parsed = (canaryful as { artifact: NativeCertificationArtifact }).artifact.liveCanary;
      assert.ok(parsed, 'liveCanary must round-trip through the parser');
      assert.equal(parsed!.status, 'pass');
      assert.equal(parsed!.isLive, true);
      assert.deepEqual(parsed!.limits, makeCanary().limits);
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('accepts and round-trips canaryCarriedForwardFrom (HOK-3159)', () => {
    const carried = makeValidArtifact({ liveCanary: makeCanary({ canaryCarriedForwardFrom: 'c'.repeat(64) }) });
    assert.equal(validateCertificationSchema(carried), true, JSON.stringify(validateCertificationSchema.errors));

    for (const bad of [42, '']) {
      const invalid = makeValidArtifact({
        liveCanary: { ...makeCanary(), canaryCarriedForwardFrom: bad } as unknown as LiveCodingCanaryResult,
      });
      assert.equal(validateCertificationSchema(invalid), false, `rejects ${JSON.stringify(bad)}`);
    }

    const repoDir = makeTempRepo();
    try {
      writeArtifact(repoDir, 'anthropic', 'carried', 'v1', makeValidArtifact({ model: 'carried', liveCanary: carried.liveCanary }));
      const loaded = loadCertification(repoDir, 'anthropic', 'carried', 'v1');
      assert.equal(loaded.ok, true);
      assert.equal(
        (loaded as { artifact: NativeCertificationArtifact }).artifact.liveCanary?.canaryCarriedForwardFrom,
        'c'.repeat(64),
      );
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('treats a present-but-invalid liveCanary as a malformed artifact (fail closed)', () => {
    const repoDir = makeTempRepo();
    try {
      writeArtifact(repoDir, 'anthropic', 'broken', 'v1', makeValidArtifact({
        model: 'broken',
        liveCanary: { status: 'pass' } as unknown as LiveCodingCanaryResult,
      }));
      const result = loadCertification(repoDir, 'anthropic', 'broken', 'v1');
      assert.deepEqual(result, { ok: false, reason: 'malformed' });
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('isLiveCodingCanaryFresh honors the derived TTL and explicit expiry boundary', () => {
    const ttlMs = LIVE_CODING_CANARY_TTL_DAYS * 24 * 60 * 60 * 1000;
    const canary = makeCanary();
    const ranAtMs = Date.parse(canary.ranAt);
    assert.equal(isLiveCodingCanaryFresh(canary, new Date(ranAtMs + ttlMs - 1)), true, 'valid just before TTL');
    assert.equal(isLiveCodingCanaryFresh(canary, new Date(ranAtMs + ttlMs)), false, 'invalid at TTL');

    const explicit = makeCanary({ expiresAt: NOW.toISOString() });
    assert.equal(isLiveCodingCanaryFresh(explicit, new Date(NOW.getTime() - 1)), true, 'valid just before expiresAt');
    assert.equal(isLiveCodingCanaryFresh(explicit, NOW), false, 'invalid at expiresAt');
    assert.equal(isLiveCodingCanaryFresh(explicit, new Date(NOW.getTime() + 1)), false, 'invalid after expiresAt');
  });

  it('liveCodingCanaryMatchesSubject rejects each identity field mismatch', () => {
    const canary = makeCanary();
    assert.equal(liveCodingCanaryMatchesSubject(canary, VALID_SUBJECT, 'v1'), true);
    assert.equal(liveCodingCanaryMatchesSubject(canary, VALID_SUBJECT, 'v2'), false);
    assert.equal(liveCodingCanaryMatchesSubject({ ...canary, provider: 'x' }, VALID_SUBJECT, 'v1'), false);
    assert.equal(liveCodingCanaryMatchesSubject({ ...canary, model: 'x' }, VALID_SUBJECT, 'v1'), false);
    assert.equal(liveCodingCanaryMatchesSubject({ ...canary, providerNativeId: 'x' }, VALID_SUBJECT, 'v1'), false);
    assert.equal(liveCodingCanaryMatchesSubject({ ...canary, identityFingerprint: 'x' }, VALID_SUBJECT, 'v1'), false);
    assert.equal(liveCodingCanaryMatchesSubject({ ...canary, catalogHash: 'x' }, VALID_SUBJECT, 'v1'), false);
  });

  it('evaluateLiveCodingCanaryEligibility fails closed for every non-pass shape', () => {
    const base = makeValidArtifact();

    assert.deepEqual(
      evaluateLiveCodingCanaryEligibility(base, 'v1', NOW),
      { eligible: false, reason: 'missing' },
    );

    const skipped = makeValidArtifact({ liveCanary: makeCanary({ status: 'skipped', reason: 'provider_config_error' }) });
    assert.equal((evaluateLiveCodingCanaryEligibility(skipped, 'v1', NOW) as { reason: string }).reason, 'missing');

    const failed = makeValidArtifact({ liveCanary: makeCanary({ status: 'fail', reason: 'wrong_mutation' }) });
    assert.equal((evaluateLiveCodingCanaryEligibility(failed, 'v1', NOW) as { reason: string }).reason, 'failed');

    const inconclusive = makeValidArtifact({ liveCanary: makeCanary({ status: 'inconclusive', reason: 'provider_transient_error' }) });
    assert.equal((evaluateLiveCodingCanaryEligibility(inconclusive, 'v1', NOW) as { reason: string }).reason, 'inconclusive');

    const nonLive = makeValidArtifact({ liveCanary: makeCanary({ isLive: false }) });
    assert.equal((evaluateLiveCodingCanaryEligibility(nonLive, 'v1', NOW) as { reason: string }).reason, 'not-live');

    const stale = makeValidArtifact({
      liveCanary: makeCanary({ ranAt: new Date(NOW.getTime() - (LIVE_CODING_CANARY_TTL_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString() }),
    });
    assert.equal((evaluateLiveCodingCanaryEligibility(stale, 'v1', NOW) as { reason: string }).reason, 'stale');

    const mismatch = makeValidArtifact({ liveCanary: makeCanary({ providerNativeId: 'someone-else' }) });
    assert.equal((evaluateLiveCodingCanaryEligibility(mismatch, 'v1', NOW) as { reason: string }).reason, 'identity-mismatch');

    const good = makeValidArtifact({ liveCanary: makeCanary() });
    assert.equal(evaluateLiveCodingCanaryEligibility(good, 'v1', NOW).eligible, true);
  });

  it('historical v2 artifacts never satisfy the live canary requirement', () => {
    const v2 = {
      schemaVersion: 2,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      phase: 'workflow',
      suiteVersion: 'v1',
      certifiedAt: RAN_AT,
      scenarios: [{ scenarioId: 's1', passed: true }],
    } as unknown as NativeCertificationArtifact;
    assert.deepEqual(evaluateLiveCodingCanaryEligibility(v2, 'v1', NOW), { eligible: false, reason: 'missing' });
  });
});
