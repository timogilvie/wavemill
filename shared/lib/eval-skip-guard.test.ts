import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evalTaskStateKey, shouldSkipAbortedTaskEval } from './eval-skip-guard.ts';

function repoWithTasks(tasks: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'eval-skip-guard-'));
  mkdirSync(join(dir, '.wavemill'));
  writeFileSync(join(dir, '.wavemill', 'workflow-state.json'), JSON.stringify({ tasks }));
  return dir;
}

describe('evalTaskStateKey', () => {
  it('maps the challenger side to the _c state key', () => {
    assert.equal(evalTaskStateKey('HOK-1', 'challenger'), 'HOK-1_c');
    assert.equal(evalTaskStateKey('HOK-1_c', 'challenger'), 'HOK-1_c');
    assert.equal(evalTaskStateKey('HOK-1', 'primary'), 'HOK-1');
    assert.equal(evalTaskStateKey('HOK-1', undefined), 'HOK-1');
  });
});

describe('shouldSkipAbortedTaskEval', () => {
  const quarantined = {
    'HOK-1': { status: 'aborted', challengeAborted: 'terminal_stage_failure:native-stage-timeout' },
    'HOK-1_c': { status: 'active', pr: '1594', challengeAborted: 'terminal_stage_failure:native-stage-timeout' },
  };

  it('does not let an aborted primary veto the surviving challenger', () => {
    const repo = repoWithTasks(quarantined);
    assert.equal(shouldSkipAbortedTaskEval(repo, 'HOK-1', '1594', 'challenger'), undefined);
  });

  it('still skips the aborted arm itself', () => {
    const repo = repoWithTasks(quarantined);
    assert.equal(shouldSkipAbortedTaskEval(repo, 'HOK-1', undefined, 'primary'), 'task_aborted');
    assert.equal(shouldSkipAbortedTaskEval(repo, 'HOK-1', undefined, undefined), 'task_aborted');
  });

  it('skips an aborted challenger', () => {
    const repo = repoWithTasks({ 'HOK-1': { status: 'active' }, 'HOK-1_c': { status: 'aborted' } });
    assert.equal(shouldSkipAbortedTaskEval(repo, 'HOK-1', '9', 'challenger'), 'task_aborted');
  });

  it('skips a challenge-aborted arm with no PR', () => {
    const repo = repoWithTasks({ 'HOK-1_c': { status: 'active', challengeAborted: 'x' } });
    assert.equal(shouldSkipAbortedTaskEval(repo, 'HOK-1', undefined, 'challenger'), 'challenge_aborted_no_pr');
  });

  it('never blocks on missing state', () => {
    const repo = mkdtempSync(join(tmpdir(), 'eval-skip-guard-'));
    assert.equal(shouldSkipAbortedTaskEval(repo, 'HOK-1', '1', 'challenger'), undefined);
    assert.equal(shouldSkipAbortedTaskEval(repo, undefined, '1', 'challenger'), undefined);
  });
});
