import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { backfillStageExecutionEvidence } from './stage-execution-backfill.ts';

let directory = '';
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = ''; });

const stage = { stage: 'coding', status: 'completed', startedAt: '2026-09-14T19:40:00.000Z', finishedAt: '2026-09-14T19:50:00.000Z', agent: 'claude', model: 'claude-haiku-4-5', intendedModel: 'claude-haiku-4-5', executedModel: null, executionEvidence: { status: 'missing', source: 'unknown' }, modelAttributionEligible: false, modelAttributionIneligibleReason: 'missing_execution_evidence', notes: '' };

describe('backfillStageExecutionEvidence', () => {
  it('recovers archived evidence, honors dry run, and leaves direct stages alone', async () => {
    directory = await mkdtemp(join(tmpdir(), 'stage-backfill-'));
    const projects = join(directory, 'projects');
    await mkdir(projects);
    await writeFile(join(directory, 'coding-result.json'), `${JSON.stringify(stage)}\n`);
    await writeFile(join(projects, 'session.jsonl'), JSON.stringify({ type: 'assistant', gitBranch: 'task/backfill', timestamp: '2026-09-14T19:45:00.000Z', message: { model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 1, output_tokens: 1 } } }) + '\n');
    const options = { directory, archived: true, worktreePath: '/deleted/worktree', branchName: 'task/backfill', repoDir: process.cwd(), stages: ['coding'] as const, claudeProjectsDirs: [projects] };
    const dry = await backfillStageExecutionEvidence({ ...options, dryRun: true });
    assert.equal(dry[0].outcome, 'updated');
    assert.equal(JSON.parse(await readFile(join(directory, 'coding-result.json'), 'utf8')).executedModel, null);
    const written = await backfillStageExecutionEvidence(options);
    assert.equal(written[0].executedModel, 'claude-haiku-4-5');
    const direct = await backfillStageExecutionEvidence(options);
    assert.equal(direct[0].outcome, 'unchanged');
  });
});
