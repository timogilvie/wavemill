import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, afterEach } from 'node:test';

import { isScriptedToolDecisionRow, purgeToolDecisionRows } from './tool-decision-corpus.ts';
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

describe('tool-decision-purge', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) cleanup(d);
  });

  describe('isScriptedToolDecisionRow', () => {
    it('identifies rows with scripted model prefix', () => {
      const scriptedRow = {
        model: 'scripted:claude-opus-4-1',
        timestamp: Date.now(),
      };
      assert.equal(isScriptedToolDecisionRow(scriptedRow), true);
    });

    it('identifies rows with scripted provider', () => {
      const scriptedRow = {
        model: 'claude-opus-4-1',
        provider: 'scripted',
        timestamp: Date.now(),
      };
      assert.equal(isScriptedToolDecisionRow(scriptedRow), true);
    });

    it('identifies rows without scripted markers as non-scripted', () => {
      const nonScriptedRow = {
        model: 'claude-opus-4-1',
        provider: 'openrouter',
        timestamp: Date.now(),
      };
      assert.equal(isScriptedToolDecisionRow(nonScriptedRow), false);
    });

    it('returns false for invalid input', () => {
      assert.equal(isScriptedToolDecisionRow(null), false);
      assert.equal(isScriptedToolDecisionRow(undefined), false);
      assert.equal(isScriptedToolDecisionRow('string'), false);
      assert.equal(isScriptedToolDecisionRow(123), false);
    });
  });

  describe('purgeToolDecisionRows', () => {
    it('removes scripted rows from corpus', () => {
      const dir = tempDir(); dirs.push(dir);

      const rows = [
        { model: 'scripted:claude-opus-4-1', timestamp: Date.now() },
        { model: 'claude-opus-4-1', provider: 'openrouter', timestamp: Date.now() },
        { model: 'gpt-4', provider: 'scripted', timestamp: Date.now() },
        { model: 'gpt-4', provider: 'openrouter', timestamp: Date.now() },
      ];

      const corpusPath = join(dir, 'corpus.jsonl');
      writeFileSync(corpusPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');

      const result = purgeToolDecisionRows(
        corpusPath,
        isScriptedToolDecisionRow,
        { dryRun: false, backupSuffix: 'test' }
      );

      assert.equal(result.total, 4);
      assert.equal(result.removed, 2);
      assert.equal(result.kept, 2);
      assert.ok(result.backupPath);

      // Verify the kept rows
      const kept = readFileSync(corpusPath, 'utf-8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line));

      assert.equal(kept.length, 2);
      assert.equal(kept.every(r => !isScriptedToolDecisionRow(r)), true);
    });

    it('preserves original file when dry-run is true', () => {
      const dir = tempDir(); dirs.push(dir);

      const rows = [
        { model: 'scripted:claude-opus-4-1', timestamp: Date.now() },
        { model: 'gpt-4', provider: 'openrouter', timestamp: Date.now() },
      ];

      const corpusPath = join(dir, 'corpus.jsonl');
      writeFileSync(corpusPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');

      const originalContent = readFileSync(corpusPath, 'utf-8');

      const result = purgeToolDecisionRows(
        corpusPath,
        isScriptedToolDecisionRow,
        { dryRun: true, backupSuffix: 'test' }
      );

      assert.equal(result.total, 2);
      assert.equal(result.removed, 1);

      // File should not be modified in dry-run mode
      const currentContent = readFileSync(corpusPath, 'utf-8');
      assert.equal(currentContent, originalContent);
    });

    it('handles empty corpus gracefully', () => {
      const dir = tempDir(); dirs.push(dir);

      const corpusPath = join(dir, 'empty.jsonl');
      writeFileSync(corpusPath, '');

      const result = purgeToolDecisionRows(
        corpusPath,
        isScriptedToolDecisionRow,
        { dryRun: false, backupSuffix: 'test' }
      );

      assert.equal(result.total, 0);
      assert.equal(result.removed, 0);
      assert.equal(result.kept, 0);
    });

    it('handles malformed JSON lines gracefully', () => {
      const dir = tempDir(); dirs.push(dir);

      const corpusPath = join(dir, 'malformed.jsonl');
      writeFileSync(corpusPath, '{malformed json\n{ "model": "claude-opus-4-1", "provider": "openrouter" }\n');

      const result = purgeToolDecisionRows(
        corpusPath,
        isScriptedToolDecisionRow,
        { dryRun: false, backupSuffix: 'test' }
      );

      // 2 lines total: 1 malformed (kept as-is) + 1 valid non-scripted (kept)
      assert.equal(result.total, 2);
      assert.equal(result.removed, 0);
      assert.equal(result.kept, 2);
    });

    it('returns empty result when corpus file does not exist', () => {
      const result = purgeToolDecisionRows(
        '/nonexistent/corpus.jsonl',
        isScriptedToolDecisionRow,
        { dryRun: false }
      );

      assert.equal(result.total, 0);
      assert.equal(result.removed, 0);
      assert.equal(result.kept, 0);
    });
  });

  describe('findScriptedSessionEventStreams', () => {
    it('finds scripted session event streams', () => {
      const dir = tempDir(); dirs.push(dir);

      // Create a scripted session stream
      const scriptedSession = [
        { type: 'session_started', initialConfigDigest: 'model:scripted:claude-opus-4-1', sessionId: 'session-1' },
        { type: 'model_request', modelId: 'claude-opus-4-1' },
      ];
      writeFileSync(
        join(dir, 'scripted-session.jsonl'),
        scriptedSession.map(e => JSON.stringify(e)).join('\n') + '\n'
      );

      // Create a non-scripted session stream
      const nonScriptedSession = [
        { type: 'session_started', initialConfigDigest: 'model:claude-opus-4-1', sessionId: 'session-2' },
        { type: 'model_request', modelId: 'claude-opus-4-1' },
      ];
      writeFileSync(
        join(dir, 'normal-session.jsonl'),
        nonScriptedSession.map(e => JSON.stringify(e)).join('\n') + '\n'
      );

      const streams = findScriptedSessionEventStreams(dir);

      assert.equal(streams.length, 1);
      assert.ok(streams[0].includes('scripted-session.jsonl'));
    });

    it('returns empty list when directory is empty', () => {
      const dir = tempDir(); dirs.push(dir);

      const streams = findScriptedSessionEventStreams(dir);

      assert.equal(streams.length, 0);
    });

    it('returns empty list when directory does not exist', () => {
      const dir = join(tmpdir(), 'nonexistent-' + Date.now());

      const streams = findScriptedSessionEventStreams(dir);

      assert.equal(streams.length, 0);
    });

    it('skips non-.jsonl files', () => {
      const dir = tempDir(); dirs.push(dir);

      // Create a non-.jsonl file
      writeFileSync(join(dir, 'README.md'), 'not a stream\n');

      // Create a .jsonl file with scripted session
      const scriptedSession = [
        { type: 'session_started', initialConfigDigest: 'model:scripted:claude-opus-4-1', sessionId: 'session-1' },
      ];
      writeFileSync(
        join(dir, 'session.jsonl'),
        scriptedSession.map(e => JSON.stringify(e)).join('\n') + '\n'
      );

      const streams = findScriptedSessionEventStreams(dir);

      assert.equal(streams.length, 1);
      assert.ok(streams[0].includes('session.jsonl'));
    });

    it('skips files with invalid JSON', () => {
      const dir = tempDir(); dirs.push(dir);

      // Create a .jsonl file with invalid JSON
      writeFileSync(join(dir, 'invalid.jsonl'), '{not valid json\n');

      // Create a valid scripted session
      const scriptedSession = [
        { type: 'session_started', initialConfigDigest: 'model:scripted:claude-opus-4-1', sessionId: 'session-1' },
      ];
      writeFileSync(
        join(dir, 'valid.jsonl'),
        scriptedSession.map(e => JSON.stringify(e)).join('\n') + '\n'
      );

      const streams = findScriptedSessionEventStreams(dir);

      assert.equal(streams.length, 1);
      assert.ok(streams[0].includes('valid.jsonl'));
    });

    it('requires initialConfigDigest to start with model:scripted:', () => {
      const dir = tempDir(); dirs.push(dir);

      // Create streams with different initialConfigDigest patterns
      const testCases = [
        { digest: 'model:scripted:claude', expected: true },
        { digest: 'model:claude', expected: false },
        { digest: 'scripted:claude', expected: false },
        { digest: 'other:prefix', expected: false },
      ];

      for (let i = 0; i < testCases.length; i++) {
        const tc = testCases[i];
        const session = [
          { type: 'session_started', initialConfigDigest: tc.digest, sessionId: `session-${i}` },
        ];
        writeFileSync(
          join(dir, `session-${i}.jsonl`),
          session.map(e => JSON.stringify(e)).join('\n') + '\n'
        );
      }

      const streams = findScriptedSessionEventStreams(dir);

      // Only the first one should match (model:scripted:claude)
      assert.equal(streams.length, 1);
      assert.ok(streams[0].includes('session-0.jsonl'));
    });
  });
});
