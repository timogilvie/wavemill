import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  readPersistedContract,
  serializeContract,
  writePersistedContract,
  providerForModel,
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

describe('execution contract persistence', () => {
  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'execution-contract-'));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('round-trips a primary persisted contract', async () => {
    const expected = contract({ stageRole: 'planning', model: 'claude-sonnet-5', provider: 'anthropic', agent: 'claude' });
    await writePersistedContract({ featureDir: testDir, contract: expected });

    const read = readPersistedContract({ featureDir: testDir, stageRole: 'planning' });
    assert.equal(read.ok, true);
    assert.deepEqual(read.ok ? read.contract : null, expected);
  });

  it('round-trips a challenger persisted contract with side record', async () => {
    const expected = contract({
      model: 'kimi-k2.7-code',
      provider: 'native-openrouter',
      agent: 'native-openrouter',
      challengeSide: 'challenger',
      certificationRef: 'global/openrouter/kimi-k2.7-code/v2',
    });
    await writePersistedContract({ featureDir: testDir, contract: expected });

    const read = readPersistedContract({ featureDir: testDir, stageRole: 'coding', challengeSide: 'challenger' });
    assert.equal(read.ok, true);
    assert.deepEqual(read.ok ? read.contract : null, expected);
    assert.equal(JSON.parse(await fs.readFile(path.join(testDir, '.challenge-side.json'), 'utf-8')).side, 'challenger');
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

  it('treats legacy phase config without provider as missing contract', async () => {
    await fs.writeFile(
      path.join(testDir, '.phase-config.json'),
      JSON.stringify({ coding: { model: 'gpt-5', agent: 'codex', depth: 'medium' }, resolvedAt: '2026-07-30T12:00:00.000Z' }),
      'utf-8',
    );
    const read = readPersistedContract({ featureDir: testDir, stageRole: 'coding' });
    assert.equal(read.ok, false);
    assert.equal(read.ok ? '' : read.reason, 'contract_missing');
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

  it('recovers the reviewer for an implementation challenge', async () => {
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
    assert.equal(read.ok ? read.contract.agent : '', 'claude');
  });

  it('serializes as stable one-line JSON', () => {
    const serialized = serializeContract(contract());
    assert.equal(serialized.includes('\n'), false);
    assert.deepEqual(JSON.parse(serialized), contract());
  });

  it('maps native providers from the registry without resolving a route', () => {
    assert.equal(providerForModel('kimi-k2.7-code'), 'native-openrouter');
  });
});
