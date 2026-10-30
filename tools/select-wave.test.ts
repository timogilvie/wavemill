import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(__dirname, '..');
const toolPath = resolve(__dirname, 'select-wave.ts');

function runSelectWave(input: unknown) {
  return spawnSync(process.execPath, [toolPath], {
    cwd: repoDir,
    encoding: 'utf-8',
    env: { ...process.env },
    input: JSON.stringify(input),
  });
}

describe('select-wave CLI', () => {
  it('emits a dependency-safe wave ordered by priority', () => {
    const result = runSelectWave({
      plan: {
        availableNow: ['HOK-1', 'HOK-2', 'HOK-3'],
        queuedAfterDependencies: [{ taskId: 'HOK-4', ancestors: ['HOK-1'] }],
        avoidRunningTogether: [['HOK-2', 'HOK-3']],
        sharedSurfaceConflicts: [{ a: 'HOK-2', b: 'HOK-3', files: [] }],
        needsTriage: [],
      },
      tasks: [
        { id: 'HOK-1', score: 60 },
        { id: 'HOK-2', score: 95 },
        { id: 'HOK-3', score: 90 },
        { id: 'HOK-4', score: 100 },
      ],
      maxParallel: 2,
    });

    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      wave: ['HOK-2', 'HOK-1'],
      deferred: ['HOK-3'],
    });
  });

  it('emits a launch-set with structured hold reasons in launch-set mode', () => {
    const result = runSelectWave({
      mode: 'launch-set',
      plan: {
        availableNow: ['HOK-10', 'HOK-11', 'HOK-12'],
        queuedAfterDependencies: [],
        avoidRunningTogether: [],
        sharedSurfaceConflicts: [
          { a: 'HOK-10', b: 'HOK-11', files: ['src/a.ts'] },
        ],
        needsTriage: [],
      },
      tasks: [
        { id: 'HOK-10', score: 90 },
        { id: 'HOK-11', score: 80 },
        { id: 'HOK-12', score: 70 },
      ],
      freeSlots: 5,
    });

    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.ok(Array.isArray(parsed.launchNext));
    assert.ok(Array.isArray(parsed.held));
    assert.ok(Array.isArray(parsed.slotsFull));
    assert.deepEqual(parsed.launchNext, ['HOK-10', 'HOK-12']);
    assert.equal(parsed.held.length, 1);
    assert.equal(parsed.held[0].id, 'HOK-11');
    assert.equal(parsed.held[0].reason, 'conflicts_with_selected');
    assert.equal(parsed.held[0].detail.kind, 'conflicts_with_selected');
    assert.equal(parsed.held[0].detail.taskId, 'HOK-10');
    assert.deepEqual(parsed.held[0].detail.files, ['src/a.ts']);
  });

  it('fails clearly for invalid input', () => {
    const result = spawnSync(process.execPath, [toolPath], {
      cwd: repoDir,
      encoding: 'utf-8',
      env: { ...process.env },
      input: '{"plan":',
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /parse select-wave JSON/);
  });
});
