import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  mutateJsonState,
  mutateJsonStateSync,
  StateLockTimeoutError,
} from './state-mutex.ts';

let tempRoot: string;
let statePath: string;

function readState(): Record<string, unknown> {
  return JSON.parse(readFileSync(statePath, 'utf-8')) as Record<string, unknown>;
}

describe('state-mutex', () => {
  beforeEach(() => {
    tempRoot = join(tmpdir(), `state-mutex-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tempRoot, { recursive: true });
    statePath = join(tempRoot, 'state.json');
    writeFileSync(statePath, '{"counter":0,"nested":{"value":"old"}}\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('writes a single mutation and returns the next state', async () => {
    const next = await mutateJsonState<Record<string, unknown>>(statePath, (current) => ({
      ...current,
      counter: 1,
      nested: { value: 'new' },
    }));

    assert.equal(next.counter, 1);
    assert.deepEqual(readState(), next);
  });

  it('serializes concurrent mutations', async () => {
    await Promise.all(
      Array.from({ length: 50 }, () => mutateJsonState<Record<string, number>>(statePath, (current) => ({
        ...current,
        counter: current.counter + 1,
      }))),
    );

    assert.equal(readState().counter, 50);
  });

  it('leaves the original file and no lock on transformer failure', async () => {
    const before = readFileSync(statePath, 'utf-8');

    await assert.rejects(
      mutateJsonState<Record<string, unknown>>(statePath, () => {
        throw new Error('boom');
      }),
      /boom/,
    );

    assert.equal(readFileSync(statePath, 'utf-8'), before);
    assert.equal(existsSync(`${statePath}.lock`), false);
    assert.deepEqual(readdirSync(tempRoot).filter((entry) => entry.includes('.tmp.')), []);
  });

  it('times out when the lock is already held', async () => {
    writeFileSync(`${statePath}.lock`, '', { flag: 'wx' });

    await assert.rejects(
      mutateJsonState<Record<string, unknown>>(statePath, (current) => current, { timeoutMs: 20 }),
      StateLockTimeoutError,
    );
  });

  describe('mutateJsonStateSync', () => {
    it('writes a single mutation and returns the next state', () => {
      const next = mutateJsonStateSync<Record<string, unknown>>(statePath, (current) => ({
        ...current,
        counter: 1,
        nested: { value: 'new' },
      }));

      assert.equal(next.counter, 1);
      assert.deepEqual(readState(), next);
    });

    it('leaves the original file and no lock on transformer failure', () => {
      const before = readFileSync(statePath, 'utf-8');

      assert.throws(
        () => mutateJsonStateSync<Record<string, unknown>>(statePath, () => {
          throw new Error('boom');
        }),
        /boom/,
      );

      assert.equal(readFileSync(statePath, 'utf-8'), before);
      assert.equal(existsSync(`${statePath}.lock`), false);
      assert.deepEqual(readdirSync(tempRoot).filter((entry) => entry.includes('.tmp.')), []);
    });

    it('times out when the lock is already held', () => {
      writeFileSync(`${statePath}.lock`, '', { flag: 'wx' });

      assert.throws(
        () => mutateJsonStateSync<Record<string, unknown>>(statePath, (current) => current, { timeoutMs: 20 }),
        StateLockTimeoutError,
      );
    });

    it('creates the file when missing and createIfMissing is set', () => {
      const freshPath = join(tempRoot, 'fresh.json');
      const next = mutateJsonStateSync<Record<string, unknown>>(
        freshPath,
        (current) => ({ ...current, seeded: true }),
        { createIfMissing: true, initial: {} },
      );

      assert.deepEqual(next, { seeded: true });
      assert.equal(existsSync(freshPath), true);
    });
  });
});
