/**
 * Tests for deterministic replay + fidelity scoring.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCheckpoint, type CreateCheckpointInput } from './session-checkpoint.ts';
import {
  FIDELITY_WEIGHTS,
  calculateFidelity,
  replayCheckpointAgainstItself,
  replayFromCheckpoint,
} from './deterministic-replay.ts';

function mkRepo(): string {
  return mkdtempSync(join(tmpdir(), 'hok2081-replay-'));
}

function baseInput(): CreateCheckpointInput {
  return {
    sessionId: 'session-1',
    decisionId: 'decision-1',
    phase: 'coding',
    events: [
      { id: 'evt-1', kind: 'tool_call', payload: { name: 'read_file' }, tool: 'read_file' },
      { id: 'evt-2', kind: 'tool_result', payload: { text: 'file contents' }, tool: 'read_file' },
    ],
    toolResults: [{ callId: 'evt-1', tool: 'read_file', content: 'file contents' }],
    workingFiles: [{ path: 'a.ts', content: 'const x = 1;\n' }],
    runtimeEnv: {
      whitelistEnv: { WAVEMILL_MODE: 'test' },
      network_access: false,
      modelId: 'claude-opus-4-6',
    },
    gitState: { headSha: 'abc123', dirty: false },
    entropy: { mathRandomSeed: 42, dateNowSeedMs: 1_700_000_000_000, uuidSequence: ['uuid-a'] },
    toolMenu: { toolNames: ['read_file', 'write_file'], chosenTool: 'read_file' },
    now: () => new Date('2026-09-24T00:00:00Z'),
  };
}

describe('deterministic-replay: calculateFidelity', () => {
  it('returns 1.0 when there are no reasons', () => {
    assert.equal(calculateFidelity([]), 1);
  });

  it('applies known reason weights', () => {
    assert.equal(calculateFidelity(['ENV_MISMATCH']), 1 - FIDELITY_WEIGHTS.ENV_MISMATCH);
  });

  it('clamps to zero on network attempts', () => {
    assert.equal(calculateFidelity(['NETWORK_ATTEMPT']), 0);
  });

  it('is clamped to [0,1]', () => {
    const many = new Array(10).fill('WORKING_TREE_MISMATCH') as any;
    const value = calculateFidelity(many);
    assert.ok(value >= 0 && value <= 1);
  });
});

describe('deterministic-replay: replayFromCheckpoint', () => {
  it('reports fidelity 1.0 on unchanged inputs', () => {
    const repo = mkRepo();
    try {
      const handle = createCheckpoint(baseInput(), { repoDir: repo });
      const result = replayFromCheckpoint(handle.root);
      assert.equal(result.fidelity, 1);
      assert.equal(result.reasons.length, 0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('reports WORKING_TREE_MISMATCH when a tracked file diverges', () => {
    const repo = mkRepo();
    try {
      const handle = createCheckpoint(baseInput(), { repoDir: repo });
      const result = replayFromCheckpoint(handle.root, {
        workingFiles: { 'a.ts': 'const x = 2;\n' },
      });
      assert.ok(result.fidelity < 1);
      assert.ok(result.reasons.includes('WORKING_TREE_MISMATCH'));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('reports ENV_MISMATCH when the env whitelist changed', () => {
    const repo = mkRepo();
    try {
      const handle = createCheckpoint(baseInput(), { repoDir: repo });
      const result = replayFromCheckpoint(handle.root, {
        env: { WAVEMILL_MODE: 'production' },
      });
      assert.ok(result.reasons.includes('ENV_MISMATCH'));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('reports NONDETERMINISTIC_TIME_LEAK on entropy drift', () => {
    const repo = mkRepo();
    try {
      const handle = createCheckpoint(baseInput(), { repoDir: repo });
      const result = replayFromCheckpoint(handle.root, {
        entropy: { mathRandomSeed: 999 },
      });
      assert.ok(result.reasons.includes('NONDETERMINISTIC_TIME_LEAK'));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('reports NETWORK_ATTEMPT when the caller signals one', () => {
    const repo = mkRepo();
    try {
      const handle = createCheckpoint(baseInput(), { repoDir: repo });
      const result = replayFromCheckpoint(handle.root, { networkAttempted: true });
      assert.ok(result.reasons.includes('NETWORK_ATTEMPT'));
      assert.equal(result.fidelity, 0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('reports EVENT_STREAM_DIVERGENCE when replayed events differ', () => {
    const repo = mkRepo();
    try {
      const handle = createCheckpoint(baseInput(), { repoDir: repo });
      const result = replayFromCheckpoint(handle.root, {
        events: [
          { id: 'evt-1', kind: 'tool_call' },
          { id: 'evt-XX', kind: 'tool_result' },
        ],
      });
      assert.ok(result.reasons.includes('EVENT_STREAM_DIVERGENCE'));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('returns CHECKPOINT_CORRUPT on a corrupted manifest', () => {
    const repo = mkRepo();
    try {
      const handle = createCheckpoint(baseInput(), { repoDir: repo });
      writeFileSync(join(handle.root, 'checkpoint.json'), '{"schemaVersion":"1"}');
      const result = replayFromCheckpoint(handle.root);
      assert.equal(result.fidelity, 0);
      assert.ok(result.reasons.includes('CHECKPOINT_CORRUPT'));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('deterministic-replay: replayCheckpointAgainstItself', () => {
  it('produces fidelity 1.0 for a well-formed checkpoint', () => {
    const repo = mkRepo();
    try {
      const handle = createCheckpoint(baseInput(), { repoDir: repo });
      const result = replayCheckpointAgainstItself(handle.root);
      assert.equal(result.fidelity, 1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
