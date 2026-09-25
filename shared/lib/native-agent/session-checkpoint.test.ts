/**
 * Tests for the hermetic session-checkpoint module.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CheckpointRefusedError,
  createCheckpoint,
  loadCheckpoint,
  readCheckpointEventStream,
  readCheckpointToolResult,
  readCheckpointWorkingFile,
  resolveCheckpointRoot,
  verifyCheckpointIntegrity,
  type CreateCheckpointInput,
} from './session-checkpoint.ts';

function mkRepo(): string {
  return mkdtempSync(join(tmpdir(), 'hok2081-cp-'));
}

function baseInput(overrides: Partial<CreateCheckpointInput> = {}): CreateCheckpointInput {
  return {
    sessionId: 'session-1',
    decisionId: 'decision-1',
    phase: 'coding',
    events: [
      { id: 'evt-1', kind: 'tool_call', payload: { name: 'read_file', args: { path: 'a.ts' } }, tool: 'read_file' },
      { id: 'evt-2', kind: 'tool_result', payload: { text: 'file contents' }, tool: 'read_file' },
    ],
    toolResults: [
      { callId: 'evt-1', tool: 'read_file', content: 'file contents' },
    ],
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
    ...overrides,
  };
}

describe('session-checkpoint: create + load round-trip', () => {
  it('writes every artifact and loads back a hash-verified manifest', () => {
    const repo = mkRepo();
    try {
      const handle = createCheckpoint(baseInput(), { repoDir: repo });
      assert.ok(existsSync(join(handle.root, 'checkpoint.json')));
      assert.ok(existsSync(join(handle.root, 'event-stream.jsonl')));
      assert.ok(existsSync(join(handle.root, 'runtime-env.json')));
      assert.ok(existsSync(join(handle.root, 'working-tree', 'a.ts')));
      assert.ok(existsSync(join(handle.root, 'tool-results', 'evt-1.json')));
      assert.ok(existsSync(join(handle.root, 'git-state.txt')));

      const reloaded = loadCheckpoint(handle.root);
      assert.equal(reloaded.manifest.checkpointHash, handle.manifest.checkpointHash);
      assert.equal(reloaded.manifest.eventCount, 2);
      assert.equal(reloaded.manifest.toolMenu.length, 2);

      assert.equal(readCheckpointWorkingFile(handle.root, 'a.ts'), 'const x = 1;\n');
      const stream = readCheckpointEventStream(handle.root);
      assert.equal(stream.length, 2);
      const envelope = readCheckpointToolResult(handle.root, 'evt-1');
      assert.ok(envelope);
      assert.equal(envelope?.tool, 'read_file');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite an existing checkpoint by default', () => {
    const repo = mkRepo();
    try {
      createCheckpoint(baseInput(), { repoDir: repo });
      assert.throws(() => createCheckpoint(baseInput(), { repoDir: repo }), (err) => {
        return err instanceof CheckpointRefusedError && err.reason === 'ALREADY_EXISTS';
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('session-checkpoint: hermeticity refusal', () => {
  it('refuses when runtimeEnv.network_access is true', () => {
    const repo = mkRepo();
    try {
      const input = baseInput({
        runtimeEnv: {
          whitelistEnv: {},
          network_access: true,
          modelId: 'claude-opus-4-6',
        },
      });
      assert.throws(
        () => createCheckpoint(input, { repoDir: repo }),
        (err) => err instanceof CheckpointRefusedError && err.reason === 'HERMETICITY_VIOLATION',
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('refuses when the session used a networked tool', () => {
    const repo = mkRepo();
    try {
      const input = baseInput({
        events: [{ id: 'evt-1', kind: 'tool_call', payload: {}, tool: 'browser' }],
        toolResults: [{ callId: 'evt-1', tool: 'browser', content: 'ok', category: 'browser' }],
        toolMenu: { toolNames: ['browser', 'read_file'], chosenTool: 'browser' },
      });
      assert.throws(
        () => createCheckpoint(input, { repoDir: repo }),
        (err) => err instanceof CheckpointRefusedError && err.reason === 'HERMETICITY_VIOLATION',
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('refuses when a non-hermetic label is on the task', () => {
    const repo = mkRepo();
    try {
      const input = baseInput({ taskLabels: ['requires-network'] });
      assert.throws(
        () => createCheckpoint(input, { repoDir: repo }),
        (err) => err instanceof CheckpointRefusedError && err.reason === 'HERMETICITY_VIOLATION',
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('session-checkpoint: redaction', () => {
  it('scrubs secret patterns from event payloads', () => {
    const repo = mkRepo();
    try {
      const secret = 'sk-' + 'A'.repeat(48);
      const input = baseInput({
        events: [
          { id: 'evt-1', kind: 'message', payload: { text: `authorization: ${secret}` } },
        ],
        toolResults: [],
      });
      const handle = createCheckpoint(input, { repoDir: repo });
      const stream = readFileSync(join(handle.root, 'event-stream.jsonl'), 'utf-8');
      assert.ok(!stream.includes(secret), 'secret must not appear in event stream');
      const manifest = loadCheckpoint(handle.root).manifest;
      assert.ok(manifest.redactionAttestation.matchCount >= 1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('scrubs secret patterns from working-tree files', () => {
    const repo = mkRepo();
    try {
      const secret = 'sk-' + 'B'.repeat(48);
      const input = baseInput({
        workingFiles: [{ path: 'creds.env', content: `TOKEN=${secret}\n` }],
      });
      const handle = createCheckpoint(input, { repoDir: repo });
      const written = readFileSync(join(handle.root, 'working-tree', 'creds.env'), 'utf-8');
      assert.ok(!written.includes(secret), 'secret must not appear in working-tree');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('session-checkpoint: input validation', () => {
  it('refuses when chosenTool is not in the menu', () => {
    const repo = mkRepo();
    try {
      const input = baseInput({
        toolMenu: { toolNames: ['read_file'], chosenTool: 'write_file' },
      });
      assert.throws(
        () => createCheckpoint(input, { repoDir: repo }),
        (err) => err instanceof CheckpointRefusedError && err.reason === 'INVALID_INPUT',
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('session-checkpoint: integrity verification', () => {
  it('reports true on a well-formed checkpoint', () => {
    const repo = mkRepo();
    try {
      const handle = createCheckpoint(baseInput(), { repoDir: repo });
      assert.equal(verifyCheckpointIntegrity(handle.root), true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('reports false when the manifest hash was tampered with', () => {
    const repo = mkRepo();
    try {
      const handle = createCheckpoint(baseInput(), { repoDir: repo });
      const manifestPath = join(handle.root, 'checkpoint.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      manifest.phase = 'planning';
      writeFileSync(manifestPath, JSON.stringify(manifest));
      assert.equal(verifyCheckpointIntegrity(handle.root), false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('session-checkpoint: resolveCheckpointRoot', () => {
  it('produces a deterministic path from sessionId + decisionId', () => {
    const first = resolveCheckpointRoot('sess', 'dec', '/repo');
    const second = resolveCheckpointRoot('sess', 'dec', '/repo');
    assert.equal(first, second);
    assert.ok(first.endsWith('sess--dec'));
  });
});
