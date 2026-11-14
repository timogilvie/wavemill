import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, type TestContext } from 'node:test';
import { zstdCompressSync } from 'node:zlib';
import { archiveTaskEvidence } from './task-evidence-archive.ts';
import { appendOwnershipRow, pendingSessionRef, launchNonceLine } from './session-ownership.ts';
import { archivedSessionRoots, TASK_EVIDENCE_MANIFEST } from './task-artifact-lookup.ts';
import { encodeProjectDir } from './wavemill-session-paths.ts';
import { meterWorkflowCost } from './sdk-task-cost/meter.ts';
import { resolveStageExecutedModel } from './executed-model-resolver.ts';
import { detectSessionRedirects } from './intervention-detector.ts';
import { getNativeProviderMetadata } from './session-adapters.ts';

function touchFacts(result: ReturnType<typeof detectSessionRedirects>) {
  const { ownedSessionFiles, messages, ...facts } = result;
  return { ...facts, messages: messages.map(({ sessionFile, ...message }) => message) };
}
const silent = { log() {}, warn() {} };
function fixture(t: TestContext) {
  const repoDir = mkdtempSync(join(tmpdir(), 'evidence-'));
  t.after(() => rmSync(repoDir, { recursive: true, force: true }));
  const worktreeDir = join(repoDir, 'worktrees', 'demo');
  const featureDir = join(worktreeDir, 'features', 'demo');
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(repoDir, '.wavemill-config.json'), '{}');
  return { repoDir, worktreeDir, featureDir, issueId: 'HOK-9001', slug: 'demo',
    archive: join(repoDir, '.wavemill', 'evals', 'artifacts', 'HOK-9001') };
}
function jsonl(file: string, rows: unknown[]) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

it('HOK-3451 replay: Ready time and owned SDK/model/intervention evidence survive source deletion', async t => {
  const f = fixture(t);
  const sessionRef = 'owned-retention-replay';
  appendOwnershipRow(f.featureDir, { sessionRef, harness: 'claude-code', kind: 'coding', model: 'claude-opus-4-7',
    launchedAt: new Date('2026-11-11T20:00:00Z'), cwd: f.worktreeDir });
  const source = join(f.repoDir, '.wavemill', 'runs', 'run', 'providers', 'deepseek', 'home', '.claude', 'projects', encodeProjectDir(f.worktreeDir), `${sessionRef}.jsonl`);
  jsonl(source, [
    { type: 'user', sessionId: sessionRef, uuid: 'u1', timestamp: '2026-11-11T20:00:00Z', gitBranch: 'task/demo', message: { role: 'user', content: 'Implement the task.' } },
    { type: 'assistant', sessionId: sessionRef, uuid: 'a1', timestamp: '2026-11-11T20:01:00Z', gitBranch: 'task/demo', message: { id: 'm1', model: 'claude-opus-4-7', usage: { input_tokens: 0, output_tokens: 10000 } } },
    { type: 'user', sessionId: sessionRef, uuid: 'u2', timestamp: '2026-11-11T20:02:00Z', gitBranch: 'task/demo', message: { role: 'user', content: 'Stop and fix the failing test before proceeding.' } },
  ]);
  // allow-source-text-assertion: sanitized incident JSON is a behavioral oracle, not production source.
  const incident = JSON.parse(readFileSync(new URL('../../tests/fixtures/incidents/hok3475-evidence-retention.json', import.meta.url), 'utf8'));
  const ready = { stage: 'ready', status: 'completed', agent: 'claude', model: '', notes: '', startedAt: incident.headPublishedAt, finishedAt: incident.readyFinishedAt };
  writeFileSync(join(f.featureDir, '.ready-result.json'), JSON.stringify(ready));
  const input = { repoDir: f.repoDir, worktreePath: f.worktreeDir, branchName: 'task/demo', issueId: f.issueId, slug: f.slug,
    pricingTable: { 'claude-opus-4-7': { inputCostPerMTok: 15, outputCostPerMTok: 75 } }, label: 'retention', logger: silent };
  const before = await meterWorkflowCost(input);
  const touch = detectSessionRedirects(f.worktreeDir, 'task/demo', f.issueId, f.repoDir);
  assert.equal(before.outcome.status, 'success');
  assert.equal(touch.transcriptsRead, true);
  const manifest = archiveTaskEvidence(f, silent);
  assert.equal(manifest.sessions[0].status, 'archived');
  assert.deepEqual(touchFacts(detectSessionRedirects(f.worktreeDir, 'task/demo', f.issueId, f.repoDir)), touchFacts(touch), 'live plus archive does not duplicate messages');
  rmSync(f.worktreeDir, { recursive: true });
  rmSync(join(f.repoDir, '.wavemill', 'runs'), { recursive: true });
  assert.deepEqual((await meterWorkflowCost(input)).outcome, before.outcome);
  assert.deepEqual(touchFacts(detectSessionRedirects(f.worktreeDir, 'task/demo', f.issueId, f.repoDir)), touchFacts(touch));
  const identity = resolveStageExecutedModel({ ...input, featureDir: f.archive, stage: 'coding', existing: null });
  assert.equal(identity.executedModel, 'claude-opus-4-7');
  assert.equal(identity.evidenceStatus, 'direct');
  assert.equal(JSON.parse(readFileSync(join(f.archive, '.ready-result.json'), 'utf8')).finishedAt, incident.readyFinishedAt);
  assert.notEqual(incident.readyFinishedAt, incident.headPublishedAt);
  const retained = manifest.sessions[0].files[0];
  writeFileSync(join(f.archive, retained.path), 'corrupt');
  assert.deepEqual(archivedSessionRoots(f.archive, 'claude-code'), [], 'corrupt retained bytes are never evidence');
});

it('preserves compressed Codex bytes and publishes decoded SDK-readable evidence after nonce resolution', async t => {
  const f = fixture(t);
  const old = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(f.repoDir, 'codex');
  t.after(() => { if (old === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = old; });
  const nonce = 'c0dec0de-0000-4000-8000-000000000001';
  const ref = '019a1234-5678-7abc-8def-000000000001';
  appendOwnershipRow(f.featureDir, { sessionRef: pendingSessionRef(nonce), harness: 'codex', kind: 'coding', model: 'gpt-5.6-terra', launchedAt: new Date('2026-11-11T20:00:00Z'), cwd: f.worktreeDir });
  const bytes = Buffer.from([
    { type: 'session_meta', timestamp: '2026-11-11T20:00:00Z', payload: { id: ref, cwd: f.worktreeDir } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: launchNonceLine(nonce) }] } },
    { type: 'turn_context', payload: { turn_id: 'turn-1', model: 'gpt-5.6-terra' } },
    { type: 'event_msg', timestamp: '2026-11-11T20:01:00Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 0, reasoning_output_tokens: 0 } } } },
  ].map(r => JSON.stringify(r)).join('\n') + '\n');
  const file = join(process.env.CODEX_HOME, 'archived_sessions', `rollout-${ref}.jsonl.zst`);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, zstdCompressSync(bytes));
  const manifest = archiveTaskEvidence(f, silent);
  assert.equal(manifest.sessions[0].sessionRef, ref);
  assert.equal(manifest.sessions[0].status, 'archived');
  assert.equal(manifest.sessions[0].files.length, 2);
  rmSync(process.env.CODEX_HOME, { recursive: true });
  const [root] = archivedSessionRoots(f.archive, 'codex');
  assert.ok(root);
  assert.deepEqual(readFileSync(join(root, `rollout-${ref}.jsonl`)), bytes);
  rmSync(f.worktreeDir, { recursive: true });
  const metered = await meterWorkflowCost({ repoDir: f.repoDir, worktreePath: f.worktreeDir, branchName: 'task/demo', issueId: f.issueId,
    pricingTable: { 'gpt-5.6-terra': { inputCostPerMTok: 10, outputCostPerMTok: 50 } }, label: 'compressed', logger: silent });
  assert.equal(metered.outcome.status, 'success');
  assert.equal(metered.outcome.status === 'success' && metered.outcome.totalCostUsd, 0.002);
  const identity = resolveStageExecutedModel({ repoDir: f.repoDir, worktreePath: f.worktreeDir, branchName: 'task/demo', featureDir: f.archive, stage: 'coding', existing: null });
  assert.equal(identity.executedModel, 'gpt-5.6-terra');
  assert.equal(identity.evidenceStatus, 'direct');
});

it('records missing/pending/foreign evidence and preserves failed/aborted artifacts without reviving stale Ready', t => {
  const f = fixture(t);
  for (const [sessionRef, cwd] of [['missing', f.worktreeDir], [pendingSessionRef('unknown'), f.worktreeDir], ['foreign', '/other/worktree']]) {
    appendOwnershipRow(f.featureDir, { sessionRef, cwd, harness: 'claude-code', kind: 'coding', model: '', launchedAt: new Date() });
  }
  mkdirSync(f.archive, { recursive: true });
  writeFileSync(join(f.archive, '.ready-result.json'), '{"old":true}');
  for (const name of ['.coding-result.attempt-1-failed.json', '.challenge-aborted.json', '.coding-failure-handoff.json']) writeFileSync(join(f.featureDir, name), '{"reason":"fixture"}');
  const inventory = archiveTaskEvidence(f, silent);
  assert.deepEqual(inventory.sessions.map(s => s.status), ['missing', 'pending', 'foreign-cwd']);
  assert.equal(existsSync(join(f.archive, '.ready-result.json')), false);
  for (const name of ['.coding-result.attempt-1-failed.json', '.challenge-aborted.json', '.coding-failure-handoff.json']) assert.ok(existsSync(join(f.archive, name)));
  assert.ok(inventory.absentArtifacts.includes('.ready-result.json'));
});

it('a real archive write failure throws before publishing success or removing sources', t => {
  const f = fixture(t);
  mkdirSync(join(f.repoDir, '.wavemill', 'evals'), { recursive: true });
  writeFileSync(join(f.repoDir, '.wavemill', 'evals', 'artifacts'), 'blocked');
  writeFileSync(join(f.featureDir, 'plan.md'), 'keep me');
  assert.throws(() => archiveTaskEvidence(f, silent), /ENOTDIR|EEXIST/);
  assert.equal(readFileSync(join(f.featureDir, 'plan.md'), 'utf8'), 'keep me');
  assert.equal(existsSync(join(f.archive, TASK_EVIDENCE_MANIFEST)), false);
});

it('native owned response usage and identity survive removal of native run storage', async t => {
  const f = fixture(t);
  const ref = 'wm-coding-HOK-9001';
  appendOwnershipRow(f.featureDir, { sessionRef: ref, harness: 'native', kind: 'coding', model: 'deepseek/deepseek-v4-pro',
    launchedAt: new Date('2026-11-11T20:00:00Z'), cwd: f.worktreeDir });
  jsonl(join(f.repoDir, '.wavemill', 'runs', 'HOK-9001', 'native-sessions', `${ref}.jsonl`), [
    { type: 'session_started', sessionId: ref, timestamp: Date.parse('2026-11-11T20:00:00Z'), seq: 0, provider: 'openrouter', model: 'deepseek/deepseek-v4-pro' },
    { type: 'assistant_message', sessionId: ref, timestamp: Date.parse('2026-11-11T20:01:00Z'), seq: 1, model: 'deepseek/deepseek-v4-pro', responseModel: 'deepseek/deepseek-v4-pro', responseId: 'gen-retention', usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { total: 0.25 } } },
  ]);
  const input = { repoDir: f.repoDir, worktreePath: f.worktreeDir, branchName: 'task/demo', issueId: f.issueId, slug: f.slug, label: 'native-retention', logger: silent };
  const before = await meterWorkflowCost(input);
  assert.equal(before.outcome.status, 'success');
  const identity = resolveStageExecutedModel({ ...input, featureDir: f.featureDir, stage: 'coding', existing: null });
  assert.equal(identity.evidenceStatus, 'direct');
  archiveTaskEvidence(f, silent);
  rmSync(f.worktreeDir, { recursive: true });
  rmSync(join(f.repoDir, '.wavemill', 'runs'), { recursive: true });
  assert.deepEqual((await meterWorkflowCost(input)).outcome, before.outcome);
  const after = resolveStageExecutedModel({ ...input, featureDir: f.archive, stage: 'coding', existing: null });
  assert.equal(after.executedModel, identity.executedModel);
  assert.equal(after.evidenceStatus, 'direct');
  assert.equal(getNativeProviderMetadata(f.worktreeDir, f.repoDir, f.issueId)?.provider, 'openrouter');
});
