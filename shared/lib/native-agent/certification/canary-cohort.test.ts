import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { ModelRegistry } from '../../model-registry.ts';
import { buildLiveCodingCanaryFixture } from './canary-fixtures.ts';
import { resolveCertificationSubject } from './identity.ts';
import { DEFAULT_CERTIFICATION_SUITE_VERSION } from './scenarios.ts';
import {
  CERTIFICATION_SCHEMA_VERSION,
  LIVE_CODING_CANARY_TTL_DAYS,
  type NativeCertificationArtifact,
} from './schema.ts';
import { writeGlobalCertification } from './store.ts';
import {
  evaluateCanaryCohortHealth,
  refreshCanaryCohort,
  renderCanaryCohortHealth,
  resolveCanaryCohort,
  type CohortCertifyFn,
} from './canary-cohort.ts';

const API_KEY_ENV = 'COHORT_TEST_OPENAI_KEY';
const SUITE = DEFAULT_CERTIFICATION_SUITE_VERSION;
const DAY_MS = 24 * 60 * 60 * 1000;

const STUB_REGISTRY: ModelRegistry = {
  models: {
    'gpt-4o': {
      vendor: 'openai',
      class: 'strong_generalist',
      strengths: [],
      weaknesses: [],
      qualityScores: { routing: 70, planning: 75, coding: 80, review: 75, classify: 70 },
      contextWindowTokens: 128_000,
      toolSupport: { functionCalling: true, streamingTools: true },
      multimodal: { text: true, image: false },
      latencyTier: 'standard',
      reasoningTier: 'standard',
      costPerMillionInputTokensUsd: 3,
      costPerMillionOutputTokensUsd: 15,
      nativeCapability: {
        nativeProvider: 'openai',
        piTransportKind: 'openai-responses',
        readOnlyNative: 'certified',
        certification: {
          maxCertifiedPhase: 'workflow',
          certifiedAt: new Date().toISOString(),
          certificationSuiteVersion: SUITE,
        },
      },
    },
  },
  ladders: {},
} as unknown as ModelRegistry;

const SUBJECT = resolveCertificationSubject({
  provider: 'openai',
  model: 'gpt-4o',
  registry: STUB_REGISTRY,
});

interface Workspace {
  repoDir: string;
  root: string;
  attemptCachePath: string;
  cleanup: () => void;
}

function makeWorkspace(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), 'canary-cohort-'));
  const repoDir = join(dir, 'repo');
  const root = join(dir, 'store');
  // Give the temp repo a config so the provider apiKeyEnv is deterministic
  // regardless of the developer/CI environment.
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
    nativeAgent: {
      providers: {
        openai: { apiKeyEnv: API_KEY_ENV },
      },
    },
  }));
  return {
    repoDir,
    root,
    attemptCachePath: join(dir, 'attempts.json'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function cohortConfig(overrides: Record<string, unknown> = {}) {
  return {
    canaryCohort: [{ provider: 'openai' as const, model: 'gpt-4o' }],
    minCodingReady: 1,
    ...overrides,
  };
}

function writeArtifact(
  root: string,
  canaryOverrides: Record<string, unknown> | null = {},
): NativeCertificationArtifact {
  const artifact: NativeCertificationArtifact = {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    subject: SUBJECT.subject,
    provider: SUBJECT.storageIdentity.provider,
    model: SUBJECT.storageIdentity.model,
    phase: 'workflow',
    suiteVersion: SUITE,
    certifiedAt: new Date(Date.now() - DAY_MS).toISOString(),
    scenarios: [{ scenarioId: 'wf1', passed: true }],
    ...(canaryOverrides !== null
      ? {
        liveCanary: buildLiveCodingCanaryFixture(SUBJECT.subject, SUITE, {
          ranAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          ...canaryOverrides,
        }),
      }
      : {}),
  };
  writeGlobalCertification(artifact, { root });
  return artifact;
}

function certifyStub(result: { codingEligible: boolean; status?: string; reason?: string }): {
  fn: CohortCertifyFn;
  calls: Array<Parameters<CohortCertifyFn>[0]>;
} {
  const calls: Array<Parameters<CohortCertifyFn>[0]> = [];
  const fn: CohortCertifyFn = async (opts) => {
    calls.push(opts);
    return {
      harnessPassed: true,
      codingEligible: result.codingEligible,
      liveCanary: {
        status: (result.status ?? (result.codingEligible ? 'pass' : 'fail')) as never,
        ...(result.reason ? { reason: result.reason } : {}),
      },
    };
  };
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// resolveCanaryCohort
// ---------------------------------------------------------------------------

describe('resolveCanaryCohort', () => {
  it('accepts valid entries and rejects unknown, mismatched, and duplicate ones', () => {
    const ws = makeWorkspace();
    try {
      const cohort = resolveCanaryCohort({
        repoDir: ws.repoDir,
        registry: STUB_REGISTRY,
        config: {
          canaryCohort: [
            { provider: 'openai', model: 'gpt-4o' },
            { provider: 'openai', model: 'gpt-4o' },
            { provider: 'openrouter', model: 'gpt-4o' },
            { provider: 'openai', model: 'no-such-model' },
          ],
        },
      });
      assert.deepEqual(cohort.members, [{ provider: 'openai', model: 'gpt-4o' }]);
      assert.equal(cohort.invalid.length, 3);
      assert.match(cohort.invalid[0]!.reason, /duplicate/);
      assert.match(cohort.invalid[1]!.reason, /registered with provider/);
      assert.match(cohort.invalid[2]!.reason, /not a registered/);
    } finally {
      ws.cleanup();
    }
  });

  it('rejects disabled models', () => {
    const ws = makeWorkspace();
    try {
      const registry = {
        models: {
          'gpt-4o': { ...(STUB_REGISTRY.models['gpt-4o'] as object), disabled: true },
        },
        ladders: {},
      } as unknown as ModelRegistry;
      const cohort = resolveCanaryCohort({
        repoDir: ws.repoDir,
        registry,
        config: cohortConfig(),
      });
      assert.equal(cohort.members.length, 0);
      assert.match(cohort.invalid[0]!.reason, /disabled/);
    } finally {
      ws.cleanup();
    }
  });

  it('applies bounded defaults for minimum and renewal window', () => {
    const ws = makeWorkspace();
    try {
      const cohort = resolveCanaryCohort({
        repoDir: ws.repoDir,
        registry: STUB_REGISTRY,
        config: cohortConfig({ minCodingReady: undefined, canaryRenewalWindowDays: 99 }),
      });
      assert.equal(cohort.minCodingReady, 2);
      assert.equal(cohort.renewalWindowDays, LIVE_CODING_CANARY_TTL_DAYS - 1);
    } finally {
      ws.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// evaluateCanaryCohortHealth
// ---------------------------------------------------------------------------

describe('evaluateCanaryCohortHealth', () => {
  it('reports missing evidence and the below-minimum alert on an empty store', async () => {
    const ws = makeWorkspace();
    try {
      const cohort = resolveCanaryCohort({
        repoDir: ws.repoDir, registry: STUB_REGISTRY, config: cohortConfig(),
      });
      const health = await evaluateCanaryCohortHealth({
        repoDir: ws.repoDir,
        cohort,
        registry: STUB_REGISTRY,
        certificationRoot: ws.root,
        attemptCachePath: ws.attemptCachePath,
      });
      assert.equal(health.configuredCount, 1);
      assert.equal(health.codingReadyCount, 0);
      assert.equal(health.belowMinimum, true);
      assert.equal(health.members[0]!.state, 'missing');
      assert.match(renderCanaryCohortHealth(health), /ALERT: coding-ready cohort \(0\)/);
      assert.match(renderCanaryCohortHealth(health), /--refresh-canary-cohort/);
    } finally {
      ws.cleanup();
    }
  });

  it('reports a fresh live pass as ready with an expiry horizon', async () => {
    const ws = makeWorkspace();
    try {
      writeArtifact(ws.root);
      const cohort = resolveCanaryCohort({
        repoDir: ws.repoDir, registry: STUB_REGISTRY, config: cohortConfig(),
      });
      const health = await evaluateCanaryCohortHealth({
        repoDir: ws.repoDir,
        cohort,
        registry: STUB_REGISTRY,
        certificationRoot: ws.root,
        attemptCachePath: ws.attemptCachePath,
      });
      assert.equal(health.codingReadyCount, 1);
      assert.equal(health.belowMinimum, false);
      assert.equal(health.members[0]!.state, 'ready');
      assert.equal(health.members[0]!.codingEligible, true);
      assert.ok(health.nearestExpiryAt, 'nearest expiry must be surfaced');
    } finally {
      ws.cleanup();
    }
  });

  it('marks a pass inside the renewal window as renewal-due but still eligible', async () => {
    const ws = makeWorkspace();
    try {
      // Expires in 2 days (< default 3-day renewal window).
      writeArtifact(ws.root, {
        ranAt: new Date(Date.now() - (LIVE_CODING_CANARY_TTL_DAYS - 2) * DAY_MS).toISOString(),
      });
      const cohort = resolveCanaryCohort({
        repoDir: ws.repoDir, registry: STUB_REGISTRY, config: cohortConfig(),
      });
      const health = await evaluateCanaryCohortHealth({
        repoDir: ws.repoDir,
        cohort,
        registry: STUB_REGISTRY,
        certificationRoot: ws.root,
        attemptCachePath: ws.attemptCachePath,
      });
      assert.equal(health.members[0]!.state, 'renewal-due');
      assert.equal(health.members[0]!.codingEligible, true);
      assert.equal(health.codingReadyCount, 1);
    } finally {
      ws.cleanup();
    }
  });

  it('classifies a definitive failure as failed and ineligible', async () => {
    const ws = makeWorkspace();
    try {
      writeArtifact(ws.root, { status: 'fail', reason: 'protocol_failure' });
      const cohort = resolveCanaryCohort({
        repoDir: ws.repoDir, registry: STUB_REGISTRY, config: cohortConfig(),
      });
      const health = await evaluateCanaryCohortHealth({
        repoDir: ws.repoDir,
        cohort,
        registry: STUB_REGISTRY,
        certificationRoot: ws.root,
        attemptCachePath: ws.attemptCachePath,
      });
      assert.equal(health.members[0]!.state, 'failed');
      assert.equal(health.members[0]!.codingEligible, false);
      assert.equal(health.members[0]!.failureReason, 'protocol_failure');
    } finally {
      ws.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// refreshCanaryCohort
// ---------------------------------------------------------------------------

describe('refreshCanaryCohort', () => {
  it('refreshes a missing member once with the live canary enabled', async () => {
    const ws = makeWorkspace();
    try {
      const stub = certifyStub({ codingEligible: true });
      const result = await refreshCanaryCohort({
        repoDir: ws.repoDir,
        certifyFn: stub.fn,
        registry: STUB_REGISTRY,
        certificationRoot: ws.root,
        env: { [API_KEY_ENV]: 'test-key' },
        attemptCachePath: ws.attemptCachePath,
        config: cohortConfig(),
      });
      assert.equal(result.attempted, 1);
      assert.equal(stub.calls.length, 1);
      assert.equal(stub.calls[0]!.liveCodingCanary, true);
      assert.equal(stub.calls[0]!.phase, 'workflow');
      assert.equal(result.outcomes[0]!.action, 'refreshed');
      assert.equal(result.outcomes[0]!.result, 'pass');
    } finally {
      ws.cleanup();
    }
  });

  it('skips a member without credentials and never calls the certify pipeline', async () => {
    const ws = makeWorkspace();
    try {
      const stub = certifyStub({ codingEligible: true });
      const result = await refreshCanaryCohort({
        repoDir: ws.repoDir,
        certifyFn: stub.fn,
        registry: STUB_REGISTRY,
        certificationRoot: ws.root,
        env: {},
        attemptCachePath: ws.attemptCachePath,
        config: cohortConfig(),
      });
      assert.equal(result.attempted, 0);
      assert.equal(stub.calls.length, 0);
      assert.equal(result.outcomes[0]!.action, 'skipped');
      assert.match(result.outcomes[0]!.reason!, new RegExp(API_KEY_ENV));
    } finally {
      ws.cleanup();
    }
  });

  it('honors the one-attempt-per-episode guard and lets the manual path bypass it', async () => {
    const ws = makeWorkspace();
    try {
      const failing = certifyStub({ codingEligible: false, status: 'inconclusive', reason: 'provider_transient_error' });
      const base = {
        repoDir: ws.repoDir,
        registry: STUB_REGISTRY,
        certificationRoot: ws.root,
        env: { [API_KEY_ENV]: 'test-key' },
        attemptCachePath: ws.attemptCachePath,
        config: cohortConfig(),
      };

      const first = await refreshCanaryCohort({ ...base, certifyFn: failing.fn });
      assert.equal(first.attempted, 1);

      // Same episode: the automatic path must not spend another provider call.
      const second = await refreshCanaryCohort({ ...base, certifyFn: failing.fn });
      assert.equal(second.attempted, 0);
      assert.equal(failing.calls.length, 1);
      assert.equal(second.outcomes[0]!.action, 'skipped');
      assert.match(second.outcomes[0]!.reason!, /already attempted this episode/);
      assert.match(second.outcomes[0]!.reason!, /--refresh-canary-cohort/);

      // The manual CLI path bypasses the guard.
      const manual = await refreshCanaryCohort({
        ...base,
        certifyFn: failing.fn,
        respectAttemptGuard: false,
      });
      assert.equal(manual.attempted, 1);
      assert.equal(failing.calls.length, 2);
    } finally {
      ws.cleanup();
    }
  });

  it('clears the attempt record after a successful refresh', async () => {
    const ws = makeWorkspace();
    try {
      const base = {
        repoDir: ws.repoDir,
        registry: STUB_REGISTRY,
        certificationRoot: ws.root,
        env: { [API_KEY_ENV]: 'test-key' },
        attemptCachePath: ws.attemptCachePath,
        config: cohortConfig(),
      };
      const failing = certifyStub({ codingEligible: false, status: 'inconclusive' });
      await refreshCanaryCohort({ ...base, certifyFn: failing.fn });

      // A success (which also writes a valid pass) resets the guard.
      const succeeding: CohortCertifyFn = async () => {
        writeArtifact(ws.root);
        return { harnessPassed: true, codingEligible: true, liveCanary: { status: 'pass' } };
      };
      const result = await refreshCanaryCohort({
        ...base,
        certifyFn: succeeding,
        respectAttemptGuard: false,
      });
      assert.equal(result.health.codingReadyCount, 1);
      assert.equal(result.health.members[0]!.lastAttempt, undefined);
    } finally {
      ws.cleanup();
    }
  });

  it('never auto-retries a definitive failure and never expands beyond the cohort', async () => {
    const ws = makeWorkspace();
    try {
      writeArtifact(ws.root, { status: 'fail', reason: 'wrong_mutation' });
      const stub = certifyStub({ codingEligible: true });
      const result = await refreshCanaryCohort({
        repoDir: ws.repoDir,
        certifyFn: stub.fn,
        registry: STUB_REGISTRY,
        certificationRoot: ws.root,
        env: { [API_KEY_ENV]: 'test-key' },
        attemptCachePath: ws.attemptCachePath,
        config: cohortConfig(),
      });
      assert.equal(result.attempted, 0);
      assert.equal(stub.calls.length, 0);
      assert.equal(result.outcomes.length, 1, 'only configured cohort members are considered');
      assert.equal(result.outcomes[0]!.action, 'not-due');
      assert.match(result.outcomes[0]!.reason!, /operator review/);
    } finally {
      ws.cleanup();
    }
  });

  it('does not refresh a fresh eligible pass outside the renewal window', async () => {
    const ws = makeWorkspace();
    try {
      writeArtifact(ws.root);
      const stub = certifyStub({ codingEligible: true });
      const result = await refreshCanaryCohort({
        repoDir: ws.repoDir,
        certifyFn: stub.fn,
        registry: STUB_REGISTRY,
        certificationRoot: ws.root,
        env: { [API_KEY_ENV]: 'test-key' },
        attemptCachePath: ws.attemptCachePath,
        config: cohortConfig(),
      });
      assert.equal(result.attempted, 0);
      assert.equal(stub.calls.length, 0);
      assert.equal(result.outcomes[0]!.action, 'not-due');
      assert.equal(result.health.codingReadyCount, 1);
    } finally {
      ws.cleanup();
    }
  });
});
