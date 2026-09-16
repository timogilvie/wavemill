import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { analyzePacketSignal } from './task-packet-signal-analysis.ts';

describe('task-packet-signal-analysis', () => {
  it('returns the required no-data message for missing evals', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'packet-signal-empty-'));
    try {
      const result = await analyzePacketSignal({ evalsDir: dir });
      assert.equal(result.report, 'No evaluation data found.');
      assert.equal(result.joinedCount, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warns and continues when artifacts are missing', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'packet-signal-missing-'));
    try {
      mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
      writeFileSync(
        path.join(dir, 'evals.jsonl'),
        `${JSON.stringify({ id: 'run-1', issueId: 'HOK-1', interventionRequired: false })}\n`,
        'utf-8',
      );
      const result = await analyzePacketSignal({ evalsDir: dir });
      assert.equal(result.joinedCount, 0);
      assert.match(result.warnings[0], /\[warn\].*missing packet artifact/);
      assert.match(result.report, /RECOMMENDATION: NO-GO/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
