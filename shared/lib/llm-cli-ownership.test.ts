/**
 * `llm-cli` helper calls record their session in the task's ownership record
 * (HOK-3328): a helper that runs while review is open is `helper:<purpose>`,
 * never a review session, and its cost is the task's.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { callLLM, codexThreadIdFromJsonl } from './llm-cli.ts';
import { readOwnershipRows } from './session-ownership.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'llm-cli-ownership-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A fake CLI that logs its argv and answers like the real one. */
function fakeCli(dir: string, stdout: string): { cliPath: string; argvLog: string } {
  const cliPath = join(dir, 'fake-cli');
  const argvLog = join(dir, 'argv.log');
  writeFileSync(cliPath, `#!/usr/bin/env bash
cat >/dev/null
printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}
cat <<'OUT'
${stdout}
OUT
`, 'utf-8');
  chmodSync(cliPath, 0o755);
  return { cliPath, argvLog };
}

const CLAUDE_ENVELOPE = JSON.stringify({ type: 'result', is_error: false, result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } });

describe('llm-cli session ownership (HOK-3328)', () => {
  // protects: a helper inside the review window labelled `review` (858 helper sessions in Oct 2026)
  it('records a Claude helper as helper:<purpose> and pins its --session-id', async () => {
    const dir = tempDir();
    const featureDir = join(dir, 'features', 'slug');
    const { cliPath, argvLog } = fakeCli(dir, CLAUDE_ENVELOPE);

    await callLLM('review this packet', {
      provider: 'claude',
      cliCmd: cliPath,
      model: 'claude-haiku-4-5',
      featureDir,
      helperPurpose: 'task-packet-validation',
      cwd: dir,
    });

    const rows = readOwnershipRows(featureDir);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].harness, rows[0].kind, rows[0].stage, rows[0].model, rows[0].cwd], [
      'claude-code', 'helper:task-packet-validation', undefined, 'claude-haiku-4-5', dir,
    ]);
    assert.match(readFileSync(argvLog, 'utf-8'), new RegExp(`--session-id ${rows[0].sessionRef}`));
  });

  // protects: a Codex helper's cost lost because its thread id was never recorded
  it('resolves a Codex helper to the thread id its JSON stream reports', async () => {
    const dir = tempDir();
    const featureDir = join(dir, 'features', 'slug');
    const stream = [
      { type: 'thread.started', thread_id: '019a0000-0000-7000-8000-00000000abcd' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } },
      { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
    ].map((event) => JSON.stringify(event)).join('\n');
    const { cliPath } = fakeCli(dir, stream);

    await callLLM('judge this', { provider: 'codex', cliCmd: cliPath, featureDir, taskType: 'eval', cwd: dir });

    const rows = readOwnershipRows(featureDir);
    assert.deepEqual(rows.map((row) => [row.sessionRef, row.harness, row.kind]), [
      ['019a0000-0000-7000-8000-00000000abcd', 'codex', 'helper:eval'],
    ]);
  });

  // protects: operator/one-off calls outside a task writing rows into some task's record
  it('records nothing without a featureDir, or when the caller already selects a session', async () => {
    const dir = tempDir();
    const featureDir = join(dir, 'features', 'slug');
    const { cliPath, argvLog } = fakeCli(dir, CLAUDE_ENVELOPE);

    await callLLM('no task', { provider: 'claude', cliCmd: cliPath, cwd: dir });
    await callLLM('resumed', { provider: 'claude', cliCmd: cliPath, featureDir, cliFlags: ['--resume', 'abc'], cwd: dir });

    assert.deepEqual(readOwnershipRows(featureDir), []);
    assert.doesNotMatch(readFileSync(argvLog, 'utf-8'), /--session-id/);
  });

  // protects: a later sub-thread id being recorded as the helper's session
  it('reads the thread id from the first thread.started event only', () => {
    assert.equal(codexThreadIdFromJsonl('noise\n{"type":"thread.started","thread_id":"t1"}\n{"type":"thread.started","thread_id":"t2"}'), 't1');
    assert.equal(codexThreadIdFromJsonl('{"type":"turn.completed"}'), undefined);
  });
});
