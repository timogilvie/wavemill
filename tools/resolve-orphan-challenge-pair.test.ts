import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after, describe, it } from 'node:test';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

function makeTempRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'resolve-orphan-cli-'));
  tempDirs.push(repoDir);
  mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
  writeFileSync(join(repoDir, '.wavemill-config.json'), '{}\n', 'utf-8');
  writeFileSync(join(repoDir, '.wavemill', 'workflow-state.json'), JSON.stringify({
    tasks: {
      HOK_1: {
        pr: 101,
        branch: 'task/primary',
        challengePairId: 'pair-abort',
        challengeRole: 'primary',
        challengeModel: 'gpt-5.5',
        evalCompleted: true,
        challengeAborted: 'Native coding failed: quarantined peer',
      },
      HOK_1_c: {
        branch: 'task/primary-challenger',
        challengePairId: 'pair-abort',
        challengeRole: 'challenger',
        challengeModel: 'qwen-2.5-coder-32b',
        challengeAborted: 'Native coding failed: no endpoints support tool use',
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

describe('resolve-orphan-challenge-pair CLI', () => {
  it('accepts challenge-aborted unresolvable reasons', async () => {
    const repoDir = makeTempRepo();
    const { stdout } = await execFileAsync(process.execPath, [
      'tools/resolve-orphan-challenge-pair.ts',
      '--pair-id',
      'pair-abort',
      '--reason',
      'both-challenge-aborted',
      '--repo-dir',
      repoDir,
      '--dry-run',
    ], { cwd: process.cwd() });

    const parsed = JSON.parse(stdout) as { status: string; reason?: string };
    assert.equal(parsed.status, 'resolved');
    assert.equal(parsed.reason, 'both-challenge-aborted');
  });

  it('rejects unsupported reasons and lists every supported value', async () => {
    const repoDir = makeTempRepo();
    await assert.rejects(
      execFileAsync(process.execPath, [
        'tools/resolve-orphan-challenge-pair.ts',
        '--pair-id',
        'pair-abort',
        '--reason',
        'foo-bar',
        '--repo-dir',
        repoDir,
        '--dry-run',
      ], { cwd: process.cwd() }),
      (error: unknown) => {
        const stderr = String((error as { stderr?: string }).stderr ?? '');
        assert.match(stderr, /Unsupported --reason value: foo-bar/);
        assert.match(stderr, /both-challenge-aborted/);
        assert.match(stderr, /sibling-challenge-aborted/);
        return true;
      },
    );
  });
});
