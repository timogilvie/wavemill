import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after, describe, it } from 'node:test';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

function makeTempRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'resolve-primary-merged-cli-'));
  tempDirs.push(repoDir);
  mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
  writeFileSync(join(repoDir, '.wavemill-config.json'), '{}\n', 'utf-8');
  writeFileSync(join(repoDir, '.wavemill', 'workflow-state.json'), JSON.stringify({
    tasks: {
      HOK_1: {
        pr: 1230,
        branch: 'task/primary',
        challengePairId: 'pair-primary-merged',
        challengeRole: 'primary',
        challengeModel: 'gpt-5',
        evalCompleted: true,
      },
      HOK_1_c: {
        branch: 'task/primary-challenger',
        challengePairId: 'pair-primary-merged',
        challengeRole: 'challenger',
        challengeModel: 'claude-sonnet-4',
        phase: 'review',
        status: 'active',
      },
    },
  }), 'utf-8');
  return repoDir;
}

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolve-primary-merged-pair CLI', () => {
  it('emits a JSON envelope and supersedes the challenger', async () => {
    const repoDir = makeTempRepo();
    const { stdout } = await execFileAsync(process.execPath, [
      'tools/resolve-primary-merged-pair.ts',
      '--pair-id',
      'pair-primary-merged',
      '--primary-pr',
      '1230',
      '--repo-dir',
      repoDir,
    ], { cwd: process.cwd() });

    const parsed = JSON.parse(stdout) as { status: string; reason?: string; record?: { winner?: string } };
    assert.equal(parsed.status, 'resolved');
    assert.equal(parsed.reason, 'primary_merged');
    assert.equal(parsed.record?.winner, 'primary');

    const state = JSON.parse(readFileSync(join(repoDir, '.wavemill', 'workflow-state.json'), 'utf-8'));
    assert.equal(state.tasks.HOK_1_c.phase, 'superseded');
    assert.equal(state.tasks.HOK_1_c.status, 'superseded');
    assert.equal(state.tasks.HOK_1_c.supersededReason, 'Primary already merged as PR #1230');
    assert.equal(state.tasks.HOK_1_c.challengeAborted, 'Primary already merged as PR #1230');
  });

  it('rejects invalid primary PR values', async () => {
    const repoDir = makeTempRepo();
    await assert.rejects(
      execFileAsync(process.execPath, [
        'tools/resolve-primary-merged-pair.ts',
        '--pair-id',
        'pair-primary-merged',
        '--primary-pr',
        'nope',
        '--repo-dir',
        repoDir,
      ], { cwd: process.cwd() }),
      (error: unknown) => {
        const stderr = String((error as { stderr?: string }).stderr ?? '');
        assert.match(stderr, /--primary-pr must be a positive integer/);
        return true;
      },
    );
  });
});
