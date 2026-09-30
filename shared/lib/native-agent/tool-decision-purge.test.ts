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
    it('identifies rows with scripted models', () => {
      const scriptedRow = {
        modelId: 'claude-opus-4-1',
        isScripted: true,
        timestamp: Date.now(),
      };
      assert.equal(isScriptedToolDecisionRow(scriptedRow), true);
    });

    it('identifies rows without scripted flag as non-scripted', () => {
      const nonScriptedRow = {
        modelId: 'claude-opus-4-1',
        timestamp: Date.now(),
      };
      assert.equal(isScriptedToolDecisionRow(nonScriptedRow), false);
    });

    it('identifies rows with isScripted false', () => {
      const nonScriptedRow = {
        modelId: 'claude-opus-4-1',
        isScripted: false,
        timestamp: Date.now(),
      };
      assert.equal(isScriptedToolDecisionRow(nonScriptedRow), false);
    });
  });

  describe('purgeToolDecisionRows', () => {
    it('removes scripted rows from corpus', () => {
      const dir = tempDir(); dirs.push(dir);

      const rows = [
        { modelId: 'claude-opus-4-1', isScripted: true, timestamp: Date.now() },
        { modelId: 'claude-opus-4-1', isScripted: false, timestamp: Date.now() },
        { modelId: 'gpt-4', isScripted: true, timestamp: Date.now() },
        { modelId: 'gpt-4', isScripted: false, timestamp: Date.now() },
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
      assert.equal(kept.every(r => !r.isScripted), true);
    });

    it('preserves original file when dry-run is true', () => {
      const dir = tempDir(); dirs.push(dir);

      const rows = [
        { modelId: 'claude-opus-4-1', isScripted: true },
        { modelId: 'gpt-4', isScripted: false },
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
      writeFileSync(corpusPath, '{malformed json\n{ "modelId": "claude-opus-4-1", "isScripted": false }\n');

      const result = purgeToolDecisionRows(
        corpusPath,
        isScriptedToolDecisionRow,
        { dryRun: false, backupSuffix: 'test' }
      );

      assert.equal(result.total, 1);
      assert.equal(result.removed, 0);
      assert.equal(result.kept, 1);
    });
  });

  describe('findScriptedSessionEventStreams', () => {
    it('finds scripted session event stream files', () => {
      const dir = tempDir(); dirs.push(dir);

      // Create some stream files
      writeFileSync(join(dir, 'session-abc.jsonl'), '{"event": "test"}\n');
      writeFileSync(join(dir, 'session-def.jsonl'), '{"event": "test"}\n');
      writeFileSync(join(dir, 'README.md'), 'not a stream\n');

      const streams = findScriptedSessionEventStreams(dir);

      assert.ok(streams.length >= 2);
      assert.ok(streams.some(s => s.includes('session-abc.jsonl')));
      assert.ok(streams.some(s => s.includes('session-def.jsonl')));
    });

    it('returns empty list when directory is empty', () => {
      const dir = tempDir(); dirs.push(dir);

      const streams = findScriptedSessionEventStreams(dir);

      assert.equal(streams.length, 0);
    });

    it('returns empty list when directory does not exist', () => {
      const dir = join(tempdir(), 'nonexistent-' + Date.now());

      const streams = findScriptedSessionEventStreams(dir);

      assert.equal(streams.length, 0);
    });

    it('ignores backup directories', () => {
      const dir = tempDir(); dirs.push(dir);

      // Create backup directory
      const backupDir = join(dir, '.bak-hok-3121-2026-01-01T00-00-00-000Z');
      mkdirSync(backupDir, { recursive: true });
      writeFileSync(join(backupDir, 'session-backup.jsonl'), '{"event": "test"}\n');

      // Create normal stream
      writeFileSync(join(dir, 'session-current.jsonl'), '{"event": "test"}\n');

      const streams = findScriptedSessionEventStreams(dir);

      assert.ok(streams.length >= 1);
      assert.ok(streams.some(s => s.includes('session-current.jsonl')));
      assert.equal(streams.some(s => s.includes('.bak-')), false);
    });
  });
});
