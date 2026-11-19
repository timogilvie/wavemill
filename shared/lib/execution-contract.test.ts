import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  readPersistedContract,
  readValidatedContract,
  serializeContract,
  writePersistedContract,
  type ExecutionContract,
} from './execution-contract.ts';

let testDir: string;

function contract(overrides: Partial<ExecutionContract> = {}): ExecutionContract {
  return {
    model: 'gpt-5',
    provider: 'openai',
    agent: 'codex',
    stageRole: 'coding',
    challengeSide: null,
    selectedAt: '2026-07-30T12:00:00.000Z',
    ...overrides,
  };
}

async function writeStage(overrides: Partial<ExecutionContract> = {}): Promise<ExecutionContract> {
  const expected = contract(overrides);
  const written = await writePersistedContract({
    featureDir: testDir,
    stages: [{
      stageRole: expected.stageRole,
      model: expected.model,
      ...(expected.challengeSide ? { challengeSide: expected.challengeSide } : {}),
      selectedAt: expected.selectedAt,
    }],
  });
  const outcome = written.stages[expected.stageRole];
  assert.ok(outcome);
  return { ...expected, agent: outcome.agent ?? '', provider: outcome.provider ?? '' };
}

describe('execution contract persistence', () => {
  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'execution-contract-'));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('derives the executor from the model and round-trips it', async () => {
    const expected = await writeStage({ stageRole: 'planning', model: 'claude-sonnet-5' });
    assert.equal(expected.agent, 'claude');
    assert.equal(expected.provider, 'anthropic');

    const read = readPersistedContract({ featureDir: testDir, stageRole: 'planning' });
    assert.equal(read.ok, true);
    assert.deepEqual(read.ok ? read.contract : null, expected);
  });

  it('round-trips a challenger persisted contract with side record', async () => {
    const expected = await writeStage({
      model: 'claude-sonnet-4-6',
      challengeSide: 'challenger',
    });
    assert.equal(expected.agent, 'claude');

    const read = readPersistedContract({ featureDir: testDir, stageRole: 'coding', challengeSide: 'challenger' });
    assert.equal(read.ok, true);
    assert.deepEqual(read.ok ? read.contract : null, expected);
    assert.equal(JSON.parse(await fs.readFile(path.join(testDir, '.challenge-side.json'), 'utf-8')).side, 'challenger');
  });

  it('writes the model without an executor when the model does not resolve', async () => {
    const written = await writePersistedContract({
      featureDir: testDir,
      stages: [{ stageRole: 'coding', model: 'no-such-model-xyz' }],
    });
    assert.ok(written.stages.coding?.refusal);
    const saved = JSON.parse(await fs.readFile(path.join(testDir, '.phase-config.json'), 'utf-8'));
    assert.equal(saved.coding.model, 'no-such-model-xyz');
    assert.equal('agent' in saved.coding, false);
    assert.equal('provider' in saved.coding, false);
  });

  it('a rewrite with a new model replaces a stale persisted executor', async () => {
    await fs.writeFile(path.join(testDir, '.phase-config.json'), JSON.stringify({
      coding: {
        model: 'claude-opus-5-5', provider: 'anthropic', agent: 'claude',
        stageRole: 'coding', challengeSide: null, depth: 'light',
        selectedAt: '2026-11-17T16:35:39Z',
      },
      resolvedAt: '2026-11-17T16:35:39Z',
    }));
    const written = await writePersistedContract({
      featureDir: testDir,
      stages: [{ stageRole: 'coding', model: 'claude-sonnet-4-6', selectedAt: 'keep' }],
    });
    assert.equal(written.stages.coding?.agent, 'claude');
    const saved = JSON.parse(await fs.readFile(path.join(testDir, '.phase-config.json'), 'utf-8'));
    assert.equal(saved.coding.model, 'claude-sonnet-4-6');
    // Merge semantics: the depth survives, the selectedAt was kept.
    assert.equal(saved.coding.depth, 'light');
    assert.equal(saved.coding.selectedAt, '2026-11-17T16:35:39Z');
  });

  it('replace mode writes a fresh config with resolvedAt and forceModel', async () => {
    await fs.writeFile(path.join(testDir, '.phase-config.json'), JSON.stringify({
      coding: { model: 'stale-model', agent: 'stale-agent' },
      resolvedAt: '2026-01-01T00:00:00Z',
    }));
    await writePersistedContract({
      featureDir: testDir,
      replace: true,
      forceModel: null,
      stages: [
        { stageRole: 'planning', model: 'claude-sonnet-5', extra: { depth: 'light' } },
        { stageRole: 'coding', model: 'claude-sonnet-4-6', extra: { depth: 'medium' } },
        { stageRole: 'review', model: 'claude-sonnet-5', extra: { mode: 'static' } },
      ],
    });
    const saved = JSON.parse(await fs.readFile(path.join(testDir, '.phase-config.json'), 'utf-8'));
    assert.equal(saved.coding.model, 'claude-sonnet-4-6');
    assert.equal(saved.coding.agent, 'claude');
    assert.equal(saved.coding.depth, 'medium');
    assert.equal(saved.review.mode, 'static');
    assert.equal(saved.forceModel, null);
    assert.notEqual(saved.resolvedAt, '2026-01-01T00:00:00Z');
    assert.equal('stale-agent' === saved.coding.agent, false);
  });

  it('returns contract_missing for absent phase config', () => {
    const read = readPersistedContract({ featureDir: testDir, stageRole: 'coding' });
    assert.equal(read.ok, false);
    assert.equal(read.ok ? '' : read.reason, 'contract_missing');
  });

  it('returns contract_malformed for invalid JSON', async () => {
    await fs.writeFile(path.join(testDir, '.phase-config.json'), '{bad json', 'utf-8');
    const read = readPersistedContract({ featureDir: testDir, stageRole: 'coding' });
    assert.equal(read.ok, false);
    assert.equal(read.ok ? '' : read.reason, 'contract_malformed');
  });

  it('reads a legacy phase config without provider or agent (HOK-3511)', async () => {
    await fs.writeFile(
      path.join(testDir, '.phase-config.json'),
      JSON.stringify({ coding: { model: 'gpt-5', depth: 'medium' }, resolvedAt: '2026-07-30T12:00:00.000Z' }),
      'utf-8',
    );
    const read = readPersistedContract({ featureDir: testDir, stageRole: 'coding' });
    assert.equal(read.ok, true);
    assert.equal(read.ok ? read.contract.model : '', 'gpt-5');
  });

  it('uses the requested challenger side even if sibling pair metadata drifts', async () => {
    await fs.writeFile(
      path.join(testDir, '.phase-config.json'),
      JSON.stringify({
        coding: {
          model: 'glm-5.2',
          provider: 'native-openrouter',
          agent: 'native-openrouter',
          stageRole: 'coding',
          challengeSide: 'primary',
          selectedAt: '2026-07-30T12:00:00.000Z',
        },
        challengePairId: 'wrong-pair',
      }),
      'utf-8',
    );
    const read = readPersistedContract({ featureDir: testDir, stageRole: 'coding', challengeSide: 'challenger' });
    assert.equal(read.ok, true);
    assert.equal(read.ok ? read.contract.challengeSide : null, 'challenger');
    assert.equal(read.ok ? read.contract.model : '', 'glm-5.2');
  });

  it('recovers the reviewer model for an implementation challenge from the intent', async () => {
    await fs.writeFile(path.join(testDir, '.phase-config.json'), JSON.stringify({
      review: {
        model: 'claude-haiku-4-5-20251001', provider: 'anthropic', agent: 'claude',
        stageRole: 'review', selectedAt: '2026-07-30T12:00:00.000Z',
      },
    }));
    await fs.writeFile(path.join(testDir, 'challenge-intent.json'), JSON.stringify({
      challengeStage: 'implementation', createdAt: '2026-07-30T12:00:00.000Z',
      challenger: {
        expectedStageModel: 'glm-5.3', expectedStageAgent: 'native-openrouter',
        reviewer: { model: 'claude-haiku-4-5-20251001', agent: 'claude' },
      },
    }));

    const read = readPersistedContract({ featureDir: testDir, stageRole: 'review', challengeSide: 'challenger' });
    assert.equal(read.ok, true);
    assert.equal(read.ok ? read.contract.model : '', 'claude-haiku-4-5-20251001');
    // HOK-3511: the intent supplies the model only; validation derives the agent.
    const validated = readValidatedContract({ featureDir: testDir, stageRole: 'review', challengeSide: 'challenger' });
    assert.equal(validated.ok, true);
    assert.equal(validated.ok ? validated.contract.agent : '', 'claude');
  });

  it('replays the complete coding contract without an arm-local intent', async () => {
    const expected = await writeStage({ model: 'claude-sonnet-4-6', challengeSide: 'challenger' });
    const result = readValidatedContract({ featureDir: testDir, stageRole: 'coding', challengeSide: 'challenger' });
    assert.deepEqual(result, { ok: true, contract: { ...expected, agent: 'claude', provider: 'anthropic' } });
  });

  it('re-derives the executor for a persisted agent that mismatches the model (HOK-3511)', async () => {
    // The HOK-3500 incident shape: a claude agent persisted beside a model
    // that resolves to another agent must validate with the derived executor
    // instead of refusing agent_unsupported_for_model.
    await fs.writeFile(path.join(testDir, '.phase-config.json'), JSON.stringify({
      coding: {
        model: 'claude-sonnet-4-6', provider: 'openai', agent: 'codex',
        stageRole: 'coding', challengeSide: null, selectedAt: '2026-11-17T16:35:39Z',
      },
    }));
    const result = readValidatedContract({ featureDir: testDir, stageRole: 'coding' });
    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.contract.agent : '', 'claude');
    assert.equal(result.ok ? result.contract.provider : '', 'anthropic');
  });

  it('fails closed when the persisted model is not launchable', async () => {
    await fs.writeFile(path.join(testDir, '.phase-config.json'), JSON.stringify({
      coding: contract({ model: 'no-such-model-xyz' }),
    }));
    const result = readValidatedContract({ featureDir: testDir, stageRole: 'coding' });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? '' : result.reason, 'model_not_launchable');
  });

  it('rejects a persisted contract naming another stage', async () => {
    await fs.writeFile(path.join(testDir, '.phase-config.json'), JSON.stringify({ coding: contract({ stageRole: 'planning' }) }));
    const result = readValidatedContract({ featureDir: testDir, stageRole: 'coding' });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? '' : result.reason, 'contract_malformed');
  });

  it('serializes as stable one-line JSON', () => {
    const serialized = serializeContract(contract());
    assert.equal(serialized.includes('\n'), false);
    assert.deepEqual(JSON.parse(serialized), contract());
  });
});
