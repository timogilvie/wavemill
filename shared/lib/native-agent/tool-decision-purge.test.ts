import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, afterEach } from 'node:test';

import {
  isScriptedToolDecisionRow,
  purgeToolDecisionRows,
} from './tool-decision-corpus.ts';
import { findScriptedSessionEventStreams } from './session-stream.ts';

function tempDir(): string {
  const dir = join(tmpdir(), `tool-decision-purge-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch {
    // best-effort
  }
}

function writeJsonl(path: string, lines: string[]): void {
  writeFileSync(path, lines.join('\n') + '\n');
}

describe('purgeToolDecisionRows', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) cleanup(d);
  });

  it('removes only predicate-matching rows, keeps corrupt lines, writes .bak with original bytes', () => {
    const dir = tempDir(); dirs.push(dir);
    const path = join(dir, 'corpus.jsonl');
    const scripted = JSON.stringify({ decisionId: 'a1', model: 'scripted:x', provider: 'scripted' });
    const corrupt = '{not valid json';
    const real = JSON.stringify({ decisionId: 'a2', model: 'gpt-5', provider: 'openai' });
    writeJsonl(path, [scripted, corrupt, real]);
    const originalBytes = readFileSync(path);

    const res = purgeToolDecisionRows(path, isScriptedToolDecisionRow);

    assert.equal(res.total, 3);
    assert.equal(res.removed, 1);
    assert.equal(res.kept, 2);
    assert.ok(res.backupPath, 'expected backup path when rows were removed');
    assert.deepEqual(readFileSync(res.backupPath!), originalBytes);
    const after = readFileSync(path, 'utf-8').split('\n').filter((l) => l !== '');
    assert.deepEqual(after, [corrupt, real]);
  });

  it('dryRun leaves the file byte-identical and writes no .bak', () => {
    const dir = tempDir(); dirs.push(dir);
    const path = join(dir, 'corpus.jsonl');
    const scripted = JSON.stringify({ decisionId: 'a1', model: 'scripted:x', provider: 'scripted' });
    const real = JSON.stringify({ decisionId: 'a2', model: 'gpt-5', provider: 'openai' });
    writeJsonl(path, [scripted, real]);
    const originalBytes = readFileSync(path);

    const res = purgeToolDecisionRows(path, isScriptedToolDecisionRow, { dryRun: true });

    assert.equal(res.removed, 1);
    assert.equal(res.backupPath, undefined);
    assert.deepEqual(readFileSync(path), originalBytes);
    assert.equal(existsSync(`${path}.bak`), false);
  });

  it('no-op (0 removed) writes no .bak and leaves the file byte-identical', () => {
    const dir = tempDir(); dirs.push(dir);
    const path = join(dir, 'corpus.jsonl');
    const real = JSON.stringify({ decisionId: 'a2', model: 'gpt-5', provider: 'openai' });
    writeJsonl(path, [real]);
    const originalBytes = readFileSync(path);

    const res = purgeToolDecisionRows(path, isScriptedToolDecisionRow);

    assert.equal(res.total, 1);
    assert.equal(res.removed, 0);
    assert.equal(res.backupPath, undefined);
    assert.deepEqual(readFileSync(path), originalBytes);
    assert.equal(existsSync(`${path}.bak`), false);
  });

  it('does not overwrite an existing .bak', () => {
    const dir = tempDir(); dirs.push(dir);
    const path = join(dir, 'corpus.jsonl');
    const scripted = JSON.stringify({ decisionId: 'a1', model: 'scripted:x', provider: 'scripted' });
    const real = JSON.stringify({ decisionId: 'a2', model: 'gpt-5', provider: 'openai' });
    writeJsonl(path, [scripted, real]);

    const existingBackup = `${path}.bak`;
    const sentinel = 'earlier-backup\n';
    writeFileSync(existingBackup, sentinel);

    const res = purgeToolDecisionRows(path, isScriptedToolDecisionRow);

    assert.equal(res.removed, 1);
    assert.ok(res.backupPath);
    assert.notEqual(res.backupPath, existingBackup);
    // The previous .bak was preserved.
    assert.equal(readFileSync(existingBackup, 'utf-8'), sentinel);
    // The new backup contains the original corpus bytes.
    assert.match(readFileSync(res.backupPath!, 'utf-8'), /"decisionId":"a1"/);
  });

  it('is a no-op when the file does not exist', () => {
    const dir = tempDir(); dirs.push(dir);
    const path = join(dir, 'corpus.jsonl');
    const res = purgeToolDecisionRows(path, isScriptedToolDecisionRow);
    assert.equal(res.total, 0);
    assert.equal(res.removed, 0);
    assert.equal(res.kept, 0);
    assert.equal(res.backupPath, undefined);
    assert.equal(existsSync(path), false);
  });

  it('waits for a held corpus.jsonl.lock and then succeeds', async () => {
    const dir = tempDir(); dirs.push(dir);
    const path = join(dir, 'corpus.jsonl');
    const scripted = JSON.stringify({ decisionId: 'a1', model: 'scripted:x', provider: 'scripted' });
    const real = JSON.stringify({ decisionId: 'a2', model: 'gpt-5', provider: 'openai' });
    writeJsonl(path, [scripted, real]);

    // Hold the lock from a subprocess so the purge's Atomics.wait spin
    // (which blocks the main event loop) cannot release it itself.
    const lockPath = `${path}.lock`;
    writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    const holder = spawn(
      process.execPath,
      ['-e', `setTimeout(() => { try { require('fs').rmSync(process.argv[1], { force: true }); } catch {} }, 150);`, lockPath],
      { stdio: 'ignore', detached: false },
    );

    let purgeError: unknown;
    let purgeResult: ReturnType<typeof purgeToolDecisionRows> | undefined;
    try {
      purgeResult = purgeToolDecisionRows(path, isScriptedToolDecisionRow);
    } catch (err) {
      purgeError = err;
    }
    await new Promise<void>((resolve) => holder.on('exit', () => resolve()));

    assert.equal(purgeError, undefined, `purge should not error: ${String(purgeError)}`);
    assert.ok(purgeResult);
    assert.equal(purgeResult!.removed, 1);
  });
});

describe('findScriptedSessionEventStreams', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) cleanup(d);
  });

  it('returns [] for a missing directory', () => {
    const dir = tempDir(); dirs.push(dir);
    const nested = join(dir, 'session-events');
    assert.deepEqual(findScriptedSessionEventStreams(nested), []);
  });

  it('selects only streams with a scripted-model session_started digest', () => {
    const dir = tempDir(); dirs.push(dir);
    const scriptedPath = join(dir, 'sess-planning-HOK-3121.jsonl');
    const scriptedStart = JSON.stringify({
      eventId: 'e1',
      seq: 0,
      timestamp: 1,
      sessionId: 'sess-planning-HOK-3121',
      traceId: 'trace',
      phase: 'planning',
      schemaVersion: '1',
      type: 'session_started',
      initialConfigDigest: 'model:scripted:scripted:launch-planning-x',
    });
    writeFileSync(scriptedPath, `${scriptedStart}\n`);

    const realPath = join(dir, 'sess-planning-real.jsonl');
    const realStart = JSON.stringify({
      eventId: 'e2',
      seq: 0,
      timestamp: 1,
      sessionId: 'sess-planning-real',
      traceId: 'trace',
      phase: 'planning',
      schemaVersion: '1',
      type: 'session_started',
      initialConfigDigest: 'model:openai:gpt-5',
    });
    writeFileSync(realPath, `${realStart}\n`);

    // Non-JSON first line — should be skipped, not thrown.
    writeFileSync(join(dir, 'garbage.jsonl'), 'not json at all\n');

    // Non-jsonl file — ignored.
    writeFileSync(join(dir, 'notes.txt'), 'ignored\n');

    const matches = findScriptedSessionEventStreams(dir);
    assert.deepEqual(matches.sort(), [scriptedPath].sort());
    // Sanity check the file it selected is actually a file.
    assert.ok(statSync(matches[0]).isFile());
  });
});
