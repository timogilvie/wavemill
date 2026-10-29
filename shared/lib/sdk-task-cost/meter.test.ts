/**
 * `meterWorkflowCost` over owned sessions (HOK-3328): the HOK-3237 replay and
 * the ownership edges — unowned sessions excluded, no owned session is
 * `no_sessions` (never `$0`), a stale SDK install is an `adapter_error`, and a
 * pending Codex ref is resolved from its rollout's launch nonce.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { NativeSessionUsageRecord } from '../session-adapters.ts';
import {
  appendOwnershipRow,
  launchNonceLine,
  pendingSessionRef,
  readOwnershipRows,
  type SessionOwnershipRow,
} from '../session-ownership.ts';
import { meterWorkflowCost } from './meter.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'meter-test-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const LAUNCHED_AT = '2026-10-27T13:00:00.000Z';
const NOW = () => new Date('2026-10-27T16:00:00.000Z');
const PRICING = { 'claude-opus-4-7': { inputCostPerMTok: 15, outputCostPerMTok: 75 } };
const silent = { log: () => {}, warn: () => {} };

function row(sessionRef: string, harness: SessionOwnershipRow['harness'], kind: SessionOwnershipRow['kind'], stage?: SessionOwnershipRow['stage']): SessionOwnershipRow {
  return { sessionRef, harness, kind, ...(stage ? { stage } : {}), model: '', launchedAt: LAUNCHED_AT, attemptId: `${kind}@nohead#1` };
}

/** A Claude Code transcript with one assistant turn of `outputTokens` output tokens. */
function writeClaudeSession(dir: string, sessionId: string, outputTokens: number, timestamp = '2026-10-27T14:00:00.000Z'): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), `${JSON.stringify({
    type: 'assistant',
    sessionId,
    uuid: `${sessionId}-u1`,
    timestamp,
    message: {
      id: `${sessionId}-m1`,
      model: 'claude-opus-4-7',
      usage: { input_tokens: 0, output_tokens: outputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  })}\n`);
}

function nativeSession(sessionId: string, costUsd: number): NativeSessionUsageRecord {
  return {
    sessionId,
    filePath: `/runs/${sessionId}.jsonl`,
    provider: 'openrouter',
    modelId: 'qwen-3-coder',
    turnCount: 1,
    responseIds: ['gen-1'],
    turns: [{ responseId: 'gen-1', inputTokens: 100_000, outputTokens: 20_000, cacheReadTokens: 0, cacheCreationTokens: 0, providerReportedCostUsd: costUsd, usageAvailable: true, invalidUsage: false }],
    usageAvailable: true,
    invalidUsage: false,
  };
}

/** HOK-3237 (2026-10-27): 7 Claude Code sessions ($43.71) + 1 native session ($4.93). */
function hok3237(claudeDir: string): SessionOwnershipRow[] {
  // $75/MTok output: 6 × 83,000 → $37.35, 1 × 84,800 → $6.36; total $43.71.
  const outputs = [83_000, 83_000, 83_000, 83_000, 83_000, 83_000, 84_800];
  const rows = outputs.map((output, index) => {
    const id = `3237c0de-0000-4000-8000-00000000000${index}`;
    writeClaudeSession(claudeDir, id, output);
    return row(id, 'claude-code', index === 6 ? 'review' : 'coding', index === 6 ? 'review' : 'coding');
  });
  return [...rows, row('wm-coding-HOK-3237', 'native', 'native-arm', 'coding')];
}

describe('meterWorkflowCost over owned sessions (HOK-3328)', () => {
  // protects: the HOK-3237 incident — workflowCost recorded $4.93 (native only) instead of $48.64
  it('HOK-3237 replay: workflowCost is the cross-harness @hokusai/costs total', async () => {
    const claudeDir = tempDir();
    const metered = await meterWorkflowCost({
      worktreePath: '/wt/hok-3237',
      branchName: 'task/hok-3237',
      issueId: 'HOK-3237',
      ownership: hok3237(claudeDir),
      nativeSessions: [nativeSession('wm-coding-HOK-3237', 4.93), nativeSession('wm-coding-HOK-9999', 99)],
      pricingTable: PRICING,
      roots: { claude: [claudeDir], codex: [] },
      label: 'test',
      now: NOW,
      logger: silent,
    });

    assert.equal(metered.reason, 'sdk_report');
    assert.equal(metered.outcome.status, 'success');
    if (metered.outcome.status !== 'success') return;
    assert.ok(Math.abs(metered.outcome.totalCostUsd - 48.64) < 1e-9, `total ${metered.outcome.totalCostUsd}`);
    assert.deepEqual(metered.outcome.byHarness, { 'claude-code': 43.71, native: 4.93 });
    assert.equal(metered.outcome.attribution?.source, 'multi');
    assert.equal(metered.outcome.sessionCount, 8);
    assert.deepEqual(metered.summaries?.map((summary) => summary.harness).sort(), ['claude-code', 'native']);
    // Per kind: the same SDK report over each kind's owned sessions.
    assert.deepEqual(
      Object.fromEntries(Object.entries(metered.outcome.byKind ?? {}).map(([kind, usd]) => [kind, usd === null ? null : Math.round(usd * 100) / 100])),
      { coding: 37.35, review: 6.36, 'native-arm': 4.93 },
    );
    // Per session: the SDK's figure for each owned session.
    assert.equal(metered.sessionCosts.get('3237c0de-0000-4000-8000-000000000006')?.totalUsd, 6.36);
    assert.equal(metered.sessionCosts.get('wm-coding-HOK-3237')?.actualUsd, 4.93);
    assert.equal(metered.sessionCosts.has('wm-coding-HOK-9999'), false, 'another task\'s native session is never charged');
  });

  // protects: an operator-typed session in the worktree silently added to task cost
  it('measures only owned session ids; an unowned transcript in the same dir is excluded', async () => {
    const claudeDir = tempDir();
    writeClaudeSession(claudeDir, 'owned-session', 10_000);
    writeClaudeSession(claudeDir, 'operator-session', 900_000);
    const metered = await meterWorkflowCost({
      worktreePath: '/wt',
      branchName: 'task/x',
      issueId: 'HOK-1',
      ownership: [row('owned-session', 'claude-code', 'coding', 'coding')],
      pricingTable: PRICING,
      roots: { claude: [claudeDir], codex: [] },
      label: 'test',
      now: NOW,
      logger: silent,
    });
    assert.equal(metered.outcome.status, 'success');
    if (metered.outcome.status === 'success') assert.equal(metered.outcome.totalCostUsd, 0.75);
  });

  // protects: "no ownership" being reported as a $0 task
  it('no owned session is no_sessions, never $0', async () => {
    const metered = await meterWorkflowCost({
      worktreePath: '/wt',
      branchName: 'task/x',
      issueId: 'HOK-1',
      ownership: [],
      label: 'test',
      logger: silent,
    });
    assert.equal(metered.reason, 'no_owned_sessions');
    assert.equal(metered.outcome.status, 'no_sessions');
    assert.equal('totalCostUsd' in metered.outcome, false);
  });

  // protects: owned sessions whose transcripts are gone reported as $0
  it('owned sessions with no usage on disk are no_sessions', async () => {
    const metered = await meterWorkflowCost({
      worktreePath: '/wt',
      branchName: 'task/x',
      issueId: 'HOK-1',
      ownership: [row('vanished', 'claude-code', 'coding', 'coding')],
      roots: { claude: [tempDir()], codex: [] },
      label: 'test',
      now: NOW,
      logger: silent,
    });
    assert.equal(metered.outcome.status, 'no_sessions');
    assert.match(metered.outcome.status === 'no_sessions' ? metered.outcome.reason : '', /1 owned session\(s\) left no usage/);
  });

  // protects: a stale @hokusai/costs install failing the whole eval
  it('a measurement load failure is an adapter_error outcome', async () => {
    const warnings: string[] = [];
    const metered = await meterWorkflowCost({
      worktreePath: '/wt',
      branchName: 'task/x',
      issueId: 'HOK-1',
      ownership: [row('s', 'claude-code', 'coding', 'coding')],
      label: 'test',
      loadMeasure: async () => { throw new SyntaxError("does not provide an export named 'measureTask'"); },
      logger: { log: () => {}, warn: (message: string) => warnings.push(message) },
    });
    assert.equal(metered.reason, 'collection_failed');
    assert.equal(metered.outcome.status, 'adapter_error');
    assert.ok(warnings.some((warning) => warning.includes('@hokusai/costs measurement failed')));
  });

  // protects: Codex TUI sessions staying uncosted although their rollout proves the launch
  it('resolves a pending Codex ref from the rollout carrying its launch nonce, once', async () => {
    const repo = tempDir();
    const stateDir = join(repo, 'features', 'slug');
    const codexRoot = join(tempDir(), 'sessions');
    const nonce = 'c0dec0de-0000-4000-8000-000000000001';
    appendOwnershipRow(stateDir, {
      sessionRef: pendingSessionRef(nonce),
      harness: 'codex',
      kind: 'coding',
      model: 'gpt-5.6-terra',
      launchedAt: new Date(Date.now() - 60_000),
      cwd: '/wt/slug',
    });
    const threadId = '019a1234-5678-7abc-8def-000000000001';
    mkdirSync(join(codexRoot, '2026', '10', '27'), { recursive: true });
    writeFileSync(join(codexRoot, '2026', '10', '27', `rollout-2026-10-27T13-00-00-${threadId}.jsonl`), [
      { type: 'session_meta', timestamp: new Date().toISOString(), payload: { id: threadId, cwd: '/wt/slug' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `${launchNonceLine(nonce)}\nImplement it.` }] } },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n');

    const metered = await meterWorkflowCost({
      worktreePath: join(repo),
      branchName: 'task/x',
      repoDir: repo,
      issueId: 'HOK-1',
      slug: 'slug',
      roots: { claude: [], codex: [codexRoot] },
      label: 'test',
      logger: silent,
    });
    assert.deepEqual(metered.owned.map((owned) => owned.sessionRef), [threadId]);
    assert.deepEqual(readOwnershipRows(stateDir).map((owned) => owned.sessionRef), [threadId], 'resolution recorded in the record');
  });
});
