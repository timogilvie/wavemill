import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { repairChallengePairing } from './challenge-pairing-repair.ts';

let tempRoot: string;
let statePath: string;
let evalsDir: string;
let evalsFile: string;

function writeState(state: unknown): void {
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

function readState(): any {
  return JSON.parse(readFileSync(statePath, 'utf-8'));
}

function writeEvals(lines: string[]): void {
  writeFileSync(evalsFile, lines.join('\n'), 'utf-8');
}

function readEvalLines(): string[] {
  return readFileSync(evalsFile, 'utf-8').split('\n').filter((l) => l.trim());
}

describe('repairChallengePairing', () => {
  beforeEach(() => {
    tempRoot = join(tmpdir(), `challenge-repair-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tempRoot, { recursive: true });
    statePath = join(tempRoot, 'workflow-state.json');
    evalsDir = join(tempRoot, 'evals');
    mkdirSync(evalsDir, { recursive: true });
    evalsFile = join(evalsDir, 'evals.jsonl');
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('re-anchors a drifted challenger task and relabels its eval record', async () => {
    writeState({
      tasks: {
        'HOK-1_c': { pr: '20', challengePairId: 'HOK-1_c', challengeRole: 'primary' },
      },
    });
    writeEvals([
      JSON.stringify({ challengePairId: 'HOK-1', prUrl: 'https://x/pull/10', score: 0.8 }),
      JSON.stringify({ challengePairId: 'HOK-1_c', prUrl: 'https://x/pull/20', score: 0.7 }),
    ]);

    const result = await repairChallengePairing({
      pairId: 'HOK-1',
      repoDir: tempRoot,
      statePath,
      evalsDir,
    });

    assert.equal(result.taskRepaired, true);
    assert.equal(result.recordsRelabeled, 1);
    const task = readState().tasks['HOK-1_c'];
    assert.equal(task.challengePairId, 'HOK-1');
    assert.equal(task.challengeRole, 'challenger');
    // Both records now share the canonical pair id so compare-prs can pair them.
    const pairIds = readEvalLines().map((l) => JSON.parse(l).challengePairId);
    assert.deepEqual(pairIds.sort(), ['HOK-1', 'HOK-1']);
  });

  it('is a no-op when pairing is already consistent', async () => {
    writeState({
      tasks: {
        'HOK-2_c': { pr: '22', challengePairId: 'HOK-2', challengeRole: 'challenger' },
      },
    });
    writeEvals([
      JSON.stringify({ challengePairId: 'HOK-2', prUrl: 'https://x/pull/21', score: 0.8 }),
      JSON.stringify({ challengePairId: 'HOK-2', prUrl: 'https://x/pull/22', score: 0.9 }),
    ]);

    const result = await repairChallengePairing({
      pairId: 'HOK-2',
      repoDir: tempRoot,
      statePath,
      evalsDir,
    });

    assert.equal(result.taskRepaired, false);
    assert.equal(result.recordsRelabeled, 0);
  });

  it('repairs a blank primary role and is idempotent', async () => {
    writeState({
      tasks: {
        'HOK-2870': { pr: '1226', challengePairId: 'HOK-2870', challengeRole: '' },
        'HOK-2870_c': { pr: '1225', challengePairId: 'HOK-2870', challengeRole: 'challenger' },
      },
    });
    writeEvals([]);

    const first = await repairChallengePairing({
      pairId: 'HOK-2870',
      repoDir: tempRoot,
      statePath,
      evalsDir,
    });
    const second = await repairChallengePairing({
      pairId: 'HOK-2870',
      repoDir: tempRoot,
      statePath,
      evalsDir,
    });

    assert.equal(first.taskRepaired, true);
    assert.equal(second.taskRepaired, false);
    assert.equal(readState().tasks['HOK-2870'].challengeRole, 'primary');
  });

  it('preserves malformed eval lines untouched', async () => {
    writeState({ tasks: {} });
    writeEvals([
      'not json at all',
      JSON.stringify({ challengePairId: 'HOK-3_c', prUrl: 'https://x/pull/30', score: 0.5 }),
    ]);

    const result = await repairChallengePairing({
      pairId: 'HOK-3',
      repoDir: tempRoot,
      statePath,
      evalsDir,
    });

    assert.equal(result.recordsRelabeled, 1);
    const lines = readEvalLines();
    assert.equal(lines[0], 'not json at all');
    assert.equal(JSON.parse(lines[1]).challengePairId, 'HOK-3');
  });

  it('does not touch unrelated challenge pairs', async () => {
    writeState({ tasks: {} });
    writeEvals([
      JSON.stringify({ challengePairId: 'HOK-9_c', prUrl: 'https://x/pull/90', score: 0.5 }),
      JSON.stringify({ challengePairId: 'HOK-4_c', prUrl: 'https://x/pull/40', score: 0.6 }),
    ]);

    const result = await repairChallengePairing({
      pairId: 'HOK-4',
      repoDir: tempRoot,
      statePath,
      evalsDir,
    });

    assert.equal(result.recordsRelabeled, 1);
    const pairIds = readEvalLines().map((l) => JSON.parse(l).challengePairId).sort();
    assert.deepEqual(pairIds, ['HOK-4', 'HOK-9_c']);
  });
  it('leaves a deferred pair with an awaiting_fork arm untouched (HOK-2813)', async () => {
    const tasks = {
      'HOK-7': {
        pr: '70',
        challengePairId: 'HOK-7_stale',
        challengeRole: '',
        challengeArms: [{
          key: 'HOK-7_c',
          role: 'challenger',
          variedStage: 'review',
          challengeArmState: 'awaiting_fork',
        }],
      },
    };
    writeState({ tasks });
    writeEvals([
      JSON.stringify({ challengePairId: 'HOK-7', prUrl: 'https://x/pull/70', score: 0.8 }),
    ]);

    const result = await repairChallengePairing({
      pairId: 'HOK-7',
      repoDir: tempRoot,
      statePath,
      evalsDir,
    });

    assert.equal(result.taskRepaired, false);
    assert.equal(result.recordsRelabeled, 0);
    assert.deepEqual(readState().tasks, tasks);
  });
});
