import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveStageExecutionEvidence } from './stage-execution-evidence.ts';

const created: string[] = [];
async function temp(): Promise<string> { const path = await mkdtemp(join(tmpdir(), 'stage-evidence-')); created.push(path); return path; }
afterEach(async () => { await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const timestamp = '2026-09-14T19:45:00.000Z';
const base = { worktreePath: '/deleted/worktree', branchName: 'task/example', windowStart: '2026-09-14T19:40:00.000Z', windowEnd: '2026-09-14T19:50:00.000Z', repoDir: process.cwd() };
function claudeLine(model: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'assistant', gitBranch: base.branchName, timestamp, message: { model, usage: { input_tokens: 1, output_tokens: 1 } }, ...extra });
}

describe('resolveStageExecutionEvidence', () => {
  it('canonicalizes clean Claude telemetry from an explicitly supplied project directory', async () => {
    const projects = await temp();
    await writeFile(join(projects, 'session.jsonl'), `${claudeLine('claude-haiku-4-5-20251001')}\n`);
    const result = await resolveStageExecutionEvidence({ ...base, agentType: 'claude', claudeProjectsDirs: [projects] });
    assert.equal(result.executedModel, 'claude-haiku-4-5');
    assert.equal(result.evidenceStatus, 'direct');
    assert.equal(result.evidenceSource, 'claude-session');
  });

  it('uses Codex turn_context model evidence', async () => {
    const root = await temp();
    const day = join(root, '2026', '09', '14'); await mkdir(day, { recursive: true });
    await writeFile(join(day, 'rollout.jsonl'), [
      JSON.stringify({ type: 'session_meta', timestamp, payload: { cwd: base.worktreePath, git: { branch: base.branchName } } }),
      JSON.stringify({ type: 'turn_context', timestamp, payload: { turn_id: 'turn', model: 'gpt-5.5' } }),
      JSON.stringify({ type: 'event_msg', timestamp, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1, output_tokens: 1 } } } }),
    ].join('\n'));
    const result = await resolveStageExecutionEvidence({ ...base, agentType: 'codex', codexSessionsRoot: root });
    assert.equal(result.executedModel, 'gpt-5.5');
    assert.equal(result.evidenceStatus, 'direct');
  });

  it('uses a strictly dominant model from one switched session', async () => {
    const projects = await temp();
    await writeFile(join(projects, 'session.jsonl'), [claudeLine('claude-haiku-4-5-20251001'), claudeLine('claude-haiku-4-5-20251001'), claudeLine('claude-sonnet-5')].join('\n'));
    const result = await resolveStageExecutionEvidence({ ...base, agentType: 'claude', claudeProjectsDirs: [projects] });
    assert.equal(result.executedModel, 'claude-haiku-4-5');
    assert.match(result.detail, /dominant_session_model/);
    assert.deepEqual(result.observedModels, ['claude-haiku-4-5', 'claude-sonnet-5']);
  });

  it('fails closed when overlapping sessions have different models', async () => {
    const projects = await temp();
    await writeFile(join(projects, 'one.jsonl'), `${claudeLine('claude-haiku-4-5-20251001')}\n`);
    await writeFile(join(projects, 'two.jsonl'), `${claudeLine('claude-sonnet-5')}\n`);
    const result = await resolveStageExecutionEvidence({ ...base, agentType: 'claude', claudeProjectsDirs: [projects] });
    assert.equal(result.executedModel, null);
    assert.match(result.detail, /ambiguous_models/);
  });

  it('ignores synthetic, sidechain, and out-of-window turns', async () => {
    const projects = await temp();
    await writeFile(join(projects, 'session.jsonl'), [
      claudeLine('<synthetic>'), claudeLine('claude-sonnet-5', { isSidechain: true }),
      claudeLine('claude-sonnet-5', { timestamp: '2026-09-14T20:00:00.000Z' }),
    ].join('\n'));
    const result = await resolveStageExecutionEvidence({ ...base, agentType: 'claude', claudeProjectsDirs: [projects] });
    assert.equal(result.executedModel, null);
    assert.equal(result.detail, 'no_session_turns_in_window');
  });

  it('does not let a session that starts after a completed stage pollute slack', async () => {
    const projects = await temp();
    await writeFile(join(projects, 'stage.jsonl'), `${claudeLine('claude-haiku-4-5-20251001')}\n`);
    await writeFile(join(projects, 'next-stage.jsonl'), `${claudeLine('claude-opus-4-7', { timestamp: '2026-09-14T19:51:00.000Z' })}\n`);
    const result = await resolveStageExecutionEvidence({ ...base, agentType: 'claude', claudeProjectsDirs: [projects] });
    assert.equal(result.executedModel, 'claude-haiku-4-5');
  });
});
