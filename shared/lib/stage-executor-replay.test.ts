/**
 * HOK-3511 replay of the HOK-3500 route-agent mismatch incident
 * (fixture: tests/fixtures/incident-replay/hok-3500-route-agent-mismatch/).
 *
 * 2026-11-17: the expanded route moved the primary coder from
 * claude-opus-5-5 (agent claude) to kimi-k2.7-code; the reseal persisted the
 * new model with the carried claude/anthropic executor, and the coding
 * retry was refused with `agent_unsupported_for_model` — a silent two-hour
 * stall. This suite proves the class is unrepresentable end to end:
 * enrichment carries models only, the one writer derives the executor, and
 * recovery re-derives it even from the incident's own already-written file.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANONICAL_CONFIG_TEMPLATE } from './config-sync.ts';
import { resolveSealedDecisionAgainstExpandedRoute, type ChallengeExecutionIntent } from './challenge-execution-contract.ts';
import { readValidatedContract, writePersistedContract } from './execution-contract.ts';
import { resolveStageExecutor } from './model-agent-resolution.ts';
import { DEFAULT_MODEL_REGISTRY } from './model-registry.ts';
import { buildGlobalCertificationPath } from './native-agent/certification/loader.ts';
import { buildLiveCodingCanaryFixture } from './native-agent/certification/canary-fixtures.ts';
import { resolveCertificationSubject } from './native-agent/certification/identity.ts';
import { CERTIFICATION_SCHEMA_VERSION } from './native-agent/certification/schema.ts';
import { GLOBAL_CERTIFICATION_ROOT_ENV } from './native-agent/certification/storage.ts';

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'tests', 'fixtures', 'incident-replay', 'hok-3500-route-agent-mismatch',
);
const INCIDENT_MODEL = 'kimi-k2.7-code';

const priorOpenRouterKey = process.env.OPENROUTER_API_KEY;
const priorCertRoot = process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
let scratch: string;
let repoDir: string;

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf-8'));
}

/** A fresh, identity-correct certification (workflow phase + live coding canary). */
function writeCertification(modelId: string): void {
  const capabilities = DEFAULT_MODEL_REGISTRY.models[modelId];
  const suiteVersion = capabilities?.nativeCapability?.certification?.certificationSuiteVersion;
  const provider = capabilities?.nativeCapability?.nativeProvider;
  assert.ok(suiteVersion && provider, `${modelId} must carry native certification metadata`);
  const identity = resolveCertificationSubject({ provider, model: modelId, registry: DEFAULT_MODEL_REGISTRY });
  const path = buildGlobalCertificationPath(
    identity.storageIdentity.provider,
    identity.storageIdentity.model,
    suiteVersion,
  );
  mkdirSync(dirname(path), { recursive: true });
  const now = Date.now();
  writeFileSync(path, JSON.stringify({
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    subject: identity.subject,
    provider: identity.storageIdentity.provider,
    model: identity.storageIdentity.model,
    phase: 'workflow',
    suiteVersion,
    certifiedAt: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    expiresAt: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString(),
    scenarios: [{ scenarioId: 'native-openrouter-workflow-launch', passed: true }],
    liveCanary: buildLiveCodingCanaryFixture(identity.subject, suiteVersion, {
      ranAt: new Date(now - 60 * 60 * 1000).toISOString(),
    }),
  }, null, 2), 'utf-8');
}

describe('HOK-3500 route-agent mismatch replay (HOK-3511)', () => {
  before(() => {
    scratch = mkdtempSync(join(tmpdir(), 'hok3500-replay-'));
    repoDir = join(scratch, 'repo');
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
      configVersion: CANONICAL_CONFIG_TEMPLATE.configVersion,
      providers: CANONICAL_CONFIG_TEMPLATE.providers,
      router: { availableModels: CANONICAL_CONFIG_TEMPLATE.router?.availableModels },
      nativeAgent: { enabled: true, allowedPhases: ['planning', 'coding', 'review'], providers: { openrouter: {} } },
    }), 'utf-8');
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = join(scratch, 'cert-root');
    writeCertification(INCIDENT_MODEL);
  });

  after(() => {
    if (priorOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = priorOpenRouterKey;
    if (priorCertRoot === undefined) delete process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
    else process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = priorCertRoot;
    rmSync(scratch, { recursive: true, force: true });
  });

  it('(a) enrichment moves the sealed coder to the expanded model with no agent', () => {
    const sealed = readFixture('challenge-intent.json') as ChallengeExecutionIntent;
    const route = readFixture('post-expansion-route.json') as Record<string, string>;
    const result = resolveSealedDecisionAgainstExpandedRoute({
      sealed,
      expandedRoute: route,
      executedStages: ['plan'],
    });
    assert.equal(result.status, 'materialize');
    if (result.status !== 'materialize') return;
    const primary = result.intent.primary as { coder?: { model?: string; agent?: string } };
    assert.equal(primary.coder?.model, INCIDENT_MODEL);
    // The carried agent is exactly what wrote the incident; it must be gone.
    assert.equal(primary.coder?.agent, undefined);
  });

  it('(b) the one writer persists the derived native-openrouter executor', async () => {
    const featureDir = join(scratch, 'feature-written');
    const written = await writePersistedContract({
      featureDir,
      repoDir,
      stages: [{ stageRole: 'coding', model: INCIDENT_MODEL, extra: { depth: 'light' } }],
    });
    assert.equal(written.stages.coding?.agent, 'native-openrouter');
    assert.equal(written.stages.coding?.provider, 'native-openrouter');
    const saved = JSON.parse(readFileSync(join(featureDir, '.phase-config.json'), 'utf-8'));
    assert.equal(saved.coding.model, INCIDENT_MODEL);
    assert.equal(saved.coding.agent, 'native-openrouter');
    assert.equal(saved.coding.provider, 'native-openrouter');
  });

  it('(c) the written contract validates and relaunches after a coding failure', () => {
    const featureDir = join(scratch, 'feature-written');
    const result = readValidatedContract({ featureDir, stageRole: 'coding', repoDir });
    assert.equal(result.ok, true, result.ok ? '' : result.detail);
    if (!result.ok) return;
    assert.equal(result.contract.agent, 'native-openrouter');
    assert.equal(result.contract.provider, 'native-openrouter');
  });

  it('launcher and validator agree on the executor through the effective registry', () => {
    // The launcher derives through resolveStageExecutor (resolve-model-agent's
    // library path); recovery derives inside readValidatedContract. Both use
    // the effective registry, so they can never disagree about this model.
    const launcher = resolveStageExecutor({ model: INCIDENT_MODEL, stage: 'coding', repoDir });
    assert.equal(launcher.ok, true, launcher.ok ? '' : launcher.diagnostic);
    const validated = readValidatedContract({ featureDir: join(scratch, 'feature-written'), stageRole: 'coding', repoDir });
    assert.equal(validated.ok, true);
    if (!launcher.ok || !validated.ok) return;
    assert.equal(validated.contract.agent, launcher.agent);
    assert.equal(validated.contract.provider, launcher.provider);
  });

  it('(d) the incident phase-config itself — stale claude executor — now validates with the derived agent', () => {
    // The exact on-disk shape the validator refused on 2026-11-17
    // (recovery-contract-validate.json in the fixture). Files written before
    // this change must recover without a reroute.
    const featureDir = join(scratch, 'feature-incident');
    mkdirSync(featureDir, { recursive: true });
    cpSync(join(FIXTURE_DIR, 'phase-config.json'), join(featureDir, '.phase-config.json'));
    const incident = readFixture('recovery-contract-validate.json') as {
      reason: string;
      contract: { model: string; agent: string; provider: string };
    };
    assert.equal(incident.reason, 'agent_unsupported_for_model');
    assert.equal(incident.contract.agent, 'claude');

    const result = readValidatedContract({ featureDir, stageRole: 'coding', repoDir });
    assert.equal(result.ok, true, result.ok ? '' : result.detail);
    if (!result.ok) return;
    assert.equal(result.contract.model, INCIDENT_MODEL);
    assert.equal(result.contract.agent, 'native-openrouter');
    assert.equal(result.contract.provider, 'native-openrouter');
  });
});
