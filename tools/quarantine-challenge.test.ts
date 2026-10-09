/**
 * HOK-3116 — quarantine-challenge matches records by the base pair ID.
 *
 * challengePairId is the pair's base Linear issue ID; the tool used to parse a
 * historical "A:A_c" format. These tests pin the current format end to end.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL = join(dirname(fileURLToPath(import.meta.url)), 'quarantine-challenge.ts');

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function seedRepo(records: Record<string, unknown>[]): { repoDir: string; recordsPath: string } {
  const repoDir = mkdtempSync(join(tmpdir(), 'quarantine-challenge-test-'));
  dirs.push(repoDir);
  const evalsDir = join(repoDir, '.wavemill', 'evals');
  mkdirSync(evalsDir, { recursive: true });
  const recordsPath = join(evalsDir, 'challenge-records.jsonl');
  writeFileSync(recordsPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  return { repoDir, recordsPath };
}

function runTool(repoDir: string, ...issues: string[]) {
  return spawnSync(process.execPath, [TOOL, '--repo-dir', repoDir, ...issues], { encoding: 'utf-8' });
}

function readRecords(recordsPath: string): Array<Record<string, unknown>> {
  return readFileSync(recordsPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
}

describe('quarantine-challenge', () => {
  it('quarantines records whose challengePairId is the base issue ID', () => {
    const { repoDir, recordsPath } = seedRepo([
      { challengePairId: 'HOK-888', comparisonOutcome: 'compared' },
      { challengePairId: 'HOK-889', comparisonOutcome: 'compared' },
    ]);

    const result = runTool(repoDir, 'HOK-888');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Quarantined 1 record\(s\)/);

    const [matched, other] = readRecords(recordsPath);
    assert.equal((matched.quarantined as { ticket: string }).ticket, 'HOK-3018');
    assert.equal(other.quarantined, undefined);
  });

  it('does not treat a challenger task ID as a pair ID', () => {
    const { repoDir, recordsPath } = seedRepo([{ challengePairId: 'HOK-888_c' }]);

    const result = runTool(repoDir, 'HOK-888');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Found 0 matching record\(s\)/);
    assert.equal(readRecords(recordsPath)[0].quarantined, undefined);
  });
});
