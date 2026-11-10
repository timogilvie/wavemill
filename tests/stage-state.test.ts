// wavemill-test-suite: lifecycle (run by tests/run-lifecycle-tests.sh)
/**
 * Tests for controller-owned stage state functions (HOK-1177)
 *
 * Verifies readStageResults() and controllerCheckReadiness() behavior
 * with controller-owned stage result files.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  readStageResults,
  controllerCheckReadiness,
} from '../shared/lib/ready-stage.ts';
import type { StageResult } from '../shared/lib/ready-stage.ts';

let testDir: string;

async function createTestDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stage-state-test-'));
  return dir;
}

function makeStageResult(overrides: Partial<StageResult> = {}): StageResult {
  return {
    stage: 'planning',
    status: 'completed',
    startedAt: '2026-04-08T22:00:00Z',
    finishedAt: '2026-04-08T22:30:00Z',
    agent: 'claude',
    model: 'claude-opus-4-6',
    notes: '',
    ...overrides,
  };
}

describe('readStageResults', () => {
  beforeEach(async () => {
    testDir = await createTestDir();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('returns empty map when no result files exist', async () => {
    const results = await readStageResults(testDir);
    assert.deepEqual(results, {});
  });

  it('reads a planning result file', async () => {
    const result = makeStageResult({ stage: 'planning', status: 'completed' });
    await fs.writeFile(path.join(testDir, '.planning-result.json'), JSON.stringify(result));

    const results = await readStageResults(testDir);
    assert.equal(results.planning?.status, 'completed');
    assert.equal(results.planning?.stage, 'planning');
  });

  it('reads multiple stage result files', async () => {
    await fs.writeFile(
      path.join(testDir, '.planning-result.json'),
      JSON.stringify(makeStageResult({ stage: 'planning', status: 'completed' })),
    );
    await fs.writeFile(
      path.join(testDir, '.coding-result.json'),
      JSON.stringify(makeStageResult({ stage: 'coding', status: 'running' })),
    );

    const results = await readStageResults(testDir);
    assert.equal(results.planning?.status, 'completed');
    assert.equal(results.coding?.status, 'running');
    assert.equal(results.review, undefined);
  });

  it('skips invalid JSON files', async () => {
    await fs.writeFile(path.join(testDir, '.planning-result.json'), 'not json');

    const results = await readStageResults(testDir);
    assert.equal(results.planning, undefined);
  });

  it('skips files with wrong stage field', async () => {
    const result = makeStageResult({ stage: 'coding', status: 'completed' });
    // Write a coding result to the planning file
    await fs.writeFile(path.join(testDir, '.planning-result.json'), JSON.stringify(result));

    const results = await readStageResults(testDir);
    assert.equal(results.planning, undefined);
  });
});

describe('controllerCheckReadiness with stage results', () => {
  beforeEach(async () => {
    testDir = await createTestDir();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('detects planning phase from stage result', async () => {
    await fs.writeFile(
      path.join(testDir, '.planning-result.json'),
      JSON.stringify(makeStageResult({ stage: 'planning', status: 'running' })),
    );

    const result = await controllerCheckReadiness(testDir);
    assert.equal(result.phase, 'planning');
    assert.match(result.summary, /from stage results/);
  });

  it('detects awaiting_user in planning phase', async () => {
    await fs.writeFile(
      path.join(testDir, '.planning-result.json'),
      JSON.stringify(makeStageResult({ stage: 'planning', status: 'awaiting_user' })),
    );

    const result = await controllerCheckReadiness(testDir);
    assert.equal(result.phase, 'planning');
    const stageCheck = result.checks.find(c => c.name === 'stage-planning');
    assert.equal(stageCheck?.status, 'warn');
  });

  it('detects coding phase after planning completed', async () => {
    await fs.writeFile(
      path.join(testDir, '.planning-result.json'),
      JSON.stringify(makeStageResult({ stage: 'planning', status: 'completed' })),
    );

    const result = await controllerCheckReadiness(testDir);
    assert.equal(result.phase, 'coding');
  });

  it('detects review phase from coding completed', async () => {
    await fs.writeFile(
      path.join(testDir, '.planning-result.json'),
      JSON.stringify(makeStageResult({ stage: 'planning', status: 'completed' })),
    );
    await fs.writeFile(
      path.join(testDir, '.coding-result.json'),
      JSON.stringify(makeStageResult({ stage: 'coding', status: 'completed' })),
    );

    const result = await controllerCheckReadiness(testDir);
    assert.equal(result.phase, 'review');
  });

  it('detects aborted from any stage result', async () => {
    await fs.writeFile(
      path.join(testDir, '.planning-result.json'),
      JSON.stringify(makeStageResult({ stage: 'planning', status: 'aborted' })),
    );

    const result = await controllerCheckReadiness(testDir);
    assert.equal(result.phase, 'aborted');
    assert.equal(result.ready, false);
  });

  it('ignores legacy markers when stage results exist', async () => {
    // Write a stage result showing planning running
    await fs.writeFile(
      path.join(testDir, '.planning-result.json'),
      JSON.stringify(makeStageResult({ stage: 'planning', status: 'running' })),
    );
    // Also write a legacy marker that would indicate coding
    await fs.writeFile(path.join(testDir, '.plan-approved'), '');

    const result = await controllerCheckReadiness(testDir);
    // Stage results take priority — planning is running, not coding
    assert.equal(result.phase, 'planning');
  });

  it('returns unknown when only legacy phase markers exist', async () => {
    await fs.writeFile(path.join(testDir, '.plan-approved'), '');

    const result = await controllerCheckReadiness(testDir);
    assert.equal(result.phase, 'unknown');
    assert.match(result.summary, /No stage results detected/);
  });

  it('returns unknown when only legacy abort marker exists', async () => {
    await fs.writeFile(path.join(testDir, '.workflow-aborted'), '');

    const result = await controllerCheckReadiness(testDir);
    assert.equal(result.phase, 'unknown');
  });

  it('returns unknown when directory is empty', async () => {
    const result = await controllerCheckReadiness(testDir);
    assert.equal(result.phase, 'unknown');
    assert.equal(result.ready, true); // no failures
  });

  it('returns fail for nonexistent directory', async () => {
    const result = await controllerCheckReadiness('/nonexistent/path');
    assert.equal(result.ready, false);
    assert.equal(result.phase, 'unknown');
  });

  it('awaiting_user with .plan-approved still shows planning phase (HOK-1193)', async () => {
    // Stage result is authoritative — awaiting_user overrides legacy marker
    await fs.writeFile(
      path.join(testDir, '.planning-result.json'),
      JSON.stringify(makeStageResult({ stage: 'planning', status: 'awaiting_user' })),
    );
    await fs.writeFile(path.join(testDir, '.plan-approved'), '');

    const result = await controllerCheckReadiness(testDir);
    assert.equal(result.phase, 'planning');
    // Should NOT be 'coding' even though .plan-approved exists
  });

  it('awaiting_user check message includes approval hint (HOK-1193)', async () => {
    await fs.writeFile(
      path.join(testDir, '.planning-result.json'),
      JSON.stringify(makeStageResult({ stage: 'planning', status: 'awaiting_user' })),
    );

    const result = await controllerCheckReadiness(testDir);
    const planningCheck = result.checks.find(c => c.name === 'stage-planning');
    assert.ok(planningCheck);
    assert.match(planningCheck!.message, /plan ready for approval/);
  });

  it('failed planning stage is detected correctly (HOK-1193)', async () => {
    await fs.writeFile(
      path.join(testDir, '.planning-result.json'),
      JSON.stringify(makeStageResult({ stage: 'planning', status: 'failed' })),
    );

    const result = await controllerCheckReadiness(testDir);
    const planningCheck = result.checks.find(c => c.name === 'stage-planning');
    assert.equal(planningCheck?.status, 'fail');
  });

  it('treats ready verdict pass as ready and merge-allowed', async () => {
    await fs.writeFile(
      path.join(testDir, '.ready-result.json'),
      JSON.stringify(makeStageResult({
        stage: 'ready',
        status: 'completed',
        artifacts: { type: 'ready', verdict: 'pass', checksRun: 4, checksPassed: 4, mergeConflict: 'CLEAN' },
      })),
    );

    const result = await controllerCheckReadiness(testDir);
    assert.equal(result.phase, 'ready');
    assert.equal(result.ready, true);
    assert.equal(result.checks.find(c => c.name === 'ready-outcome')?.status, 'pass');
  });

  it('treats ready verdict warn as ready with warning status', async () => {
    await fs.writeFile(
      path.join(testDir, '.ready-result.json'),
      JSON.stringify(makeStageResult({
        stage: 'ready',
        status: 'completed',
        artifacts: { type: 'ready', verdict: 'warn', checksRun: 4, checksPassed: 3, mergeConflict: 'CLEAN' },
      })),
    );

    const result = await controllerCheckReadiness(testDir);
    assert.equal(result.phase, 'ready');
    assert.equal(result.ready, true);
    assert.equal(result.checks.find(c => c.name === 'ready-outcome')?.status, 'warn');
  });

  it('treats ready verdict fail as blocked', async () => {
    await fs.writeFile(
      path.join(testDir, '.ready-result.json'),
      JSON.stringify(makeStageResult({
        stage: 'ready',
        status: 'completed',
        artifacts: { type: 'ready', verdict: 'fail', checksRun: 4, checksPassed: 2, mergeConflict: 'CLEAN' },
      })),
    );

    const result = await controllerCheckReadiness(testDir);
    assert.equal(result.phase, 'ready');
    assert.equal(result.ready, false);
    assert.equal(result.checks.find(c => c.name === 'ready-outcome')?.status, 'fail');
  });

  it('reports ready remediation in progress for running ready stage', async () => {
    await fs.writeFile(
      path.join(testDir, '.ready-result.json'),
      JSON.stringify(makeStageResult({ stage: 'ready', status: 'running' })),
    );

    const result = await controllerCheckReadiness(testDir);
    assert.equal(result.phase, 'ready');
    assert.equal(result.ready, true);
    assert.match(result.summary, /remediation in progress/);
    assert.equal(result.checks.find(c => c.name === 'ready-outcome')?.status, 'warn');
  });

  it('reports ready needs attention for failed ready stage', async () => {
    await fs.writeFile(
      path.join(testDir, '.ready-result.json'),
      JSON.stringify(makeStageResult({ stage: 'ready', status: 'failed' })),
    );

    const result = await controllerCheckReadiness(testDir);
    assert.equal(result.phase, 'ready');
    assert.equal(result.ready, false);
    assert.match(result.summary, /needs attention/);
    assert.equal(result.checks.find(c => c.name === 'ready-outcome')?.status, 'fail');
  });
});
