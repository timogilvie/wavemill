import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { codexSessionsRoot, resolveCodexLaunchNonces } from './codex-rollout-resolver.ts';
import { launchNonceLine, pendingSessionRef, type SessionOwnershipRow } from './session-ownership.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function writeRollout(root: string, threadId: string, cwd: string, prompt: string): string {
  const dir = join(root, '2026', '10', '27');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-2026-10-27T13-00-00-${threadId}.jsonl`);
  writeFileSync(file, [
    { type: 'session_meta', payload: { id: threadId, cwd } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n');
  return file;
}

function pendingRow(nonce: string, cwd?: string): SessionOwnershipRow {
  return {
    sessionRef: pendingSessionRef(nonce),
    harness: 'codex',
    kind: 'coding',
    stage: 'coding',
    model: 'gpt-5.6-terra',
    launchedAt: new Date(Date.now() - 5_000).toISOString(),
    attemptId: 'coding@nohead#1',
    ...(cwd ? { cwd } : {}),
  };
}

describe('resolveCodexLaunchNonces (HOK-3328)', () => {
  // protects: a Codex launch being matched by time or cwd alone (a guess) instead of its nonce
  it('matches only the rollout whose prompt carries the exact launch nonce and cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-sessions-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const nonce = 'aaaaaaaa-0000-4000-8000-000000000001';
    writeRollout(root, 'thread-other-nonce', '/wt/a', `${launchNonceLine('bbbbbbbb-0000-4000-8000-000000000002')}\nwork`);
    writeRollout(root, 'thread-other-cwd', '/wt/b', `${launchNonceLine(nonce)}\nwork`);
    writeRollout(root, 'thread-match', '/wt/a', `${launchNonceLine(nonce)}\nwork`);

    const resolved = resolveCodexLaunchNonces([pendingRow(nonce, '/wt/a')], [root]);
    assert.deepEqual([...resolved], [[pendingSessionRef(nonce), 'thread-match']]);
  });

  // protects: an old rollout that happens to quote a nonce being claimed by a later launch
  it('ignores rollouts older than the launch and rows that are already exact', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-sessions-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const nonce = 'cccccccc-0000-4000-8000-000000000003';
    const old = writeRollout(root, 'thread-old', '/wt', `${launchNonceLine(nonce)}`);
    const longAgo = new Date(Date.now() - 3_600_000);
    utimesSync(old, longAgo, longAgo);
    assert.equal(resolveCodexLaunchNonces([pendingRow(nonce)], [root]).size, 0);
    assert.equal(resolveCodexLaunchNonces([{ ...pendingRow(nonce), sessionRef: 'exact' }], [root]).size, 0);
    assert.equal(resolveCodexLaunchNonces([pendingRow(nonce)], [join(root, 'missing')]).size, 0);
  });

  // protects: CODEX_HOME users never having their rollouts found
  it('honours CODEX_HOME for the sessions root', () => {
    assert.equal(codexSessionsRoot({ CODEX_HOME: '/opt/codex' }), '/opt/codex/sessions');
  });
});
