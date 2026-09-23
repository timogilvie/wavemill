import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, afterEach } from 'node:test';

import { buildPlanningWithToolCall } from './fixtures/tool-decision/build.ts';
import { captureToolDecisionsFromStream } from './tool-decision-capture.ts';
import { readToolDecisionCorpus, resolveToolDecisionCorpusPath } from './tool-decision-corpus.ts';

function tempDir(): string {
  const dir = join(tmpdir(), `tool-decision-capture-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function cleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch {
    // best-effort
  }
}

function writeStream(dir: string, events: unknown[]): string {
  const path = join(dir, 'stream.jsonl');
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return path;
}

describe('captureToolDecisionsFromStream', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) cleanup(d);
  });

  it('projects and appends when the stream is valid', () => {
    const dir = tempDir(); dirs.push(dir);
    const streamPath = writeStream(dir, buildPlanningWithToolCall());
    const res = captureToolDecisionsFromStream({
      eventStreamPath: streamPath,
      corpusDir: dir,
    });
    assert.equal(res.ok, true);
    assert.ok(res.corpusPath);
    assert.ok((res.appended ?? 0) >= 1);
    const rows = readToolDecisionCorpus(res.corpusPath!);
    assert.equal(rows.length, res.appended);
  });

  it('is a no-op when the stream file is missing', () => {
    const dir = tempDir(); dirs.push(dir);
    const res = captureToolDecisionsFromStream({
      eventStreamPath: join(dir, 'does-not-exist.jsonl'),
      corpusDir: dir,
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'stream_missing');
  });

  it('does not throw on malformed streams', () => {
    const dir = tempDir(); dirs.push(dir);
    const streamPath = join(dir, 'bad.jsonl');
    writeFileSync(streamPath, '{not json\n');
    const res = captureToolDecisionsFromStream({
      eventStreamPath: streamPath,
      corpusDir: dir,
    });
    assert.equal(res.ok, false);
    assert.match(res.reason ?? '', /parse_error/);
  });

  it('is idempotent for repeated captures against the same stream', () => {
    const dir = tempDir(); dirs.push(dir);
    const streamPath = writeStream(dir, buildPlanningWithToolCall());
    const first = captureToolDecisionsFromStream({
      eventStreamPath: streamPath,
      corpusDir: dir,
    });
    const second = captureToolDecisionsFromStream({
      eventStreamPath: streamPath,
      corpusDir: dir,
    });
    assert.equal(second.ok, true);
    assert.equal(second.appended, 0);
    assert.equal(second.skippedDuplicates, first.appended);

    // Corpus file is still valid.
    const corpusPath = resolveToolDecisionCorpusPath({ explicitDir: dir });
    const content = readFileSync(corpusPath, 'utf-8');
    assert.equal(content.trim().split('\n').length, first.appended);
  });
});
