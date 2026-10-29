import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  SESSION_OWNERSHIP_FILE,
  appendOwnershipRow,
  appendSessionRefResolution,
  buildAttemptId,
  exactRows,
  extractLaunchNonce,
  groupByHarness,
  groupByKind,
  helperKind,
  launchNonceLine,
  locateOwnershipRows,
  nativeLaunchKind,
  ownershipStageRole,
  pendingSessionRef,
  readOwnershipRows,
  recordLaunch,
  rowsForStage,
} from './session-ownership.ts';

const SHELL_TWIN = join(dirname(fileURLToPath(import.meta.url)), 'session-ownership.sh');
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDir(prefix = 'session-ownership-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function shell(script: string, env: Record<string, string> = {}): string {
  return execFileSync('bash', ['-c', `source ${JSON.stringify(SHELL_TWIN)}\n${script}`], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

describe('session-ownership record (HOK-3328)', () => {
  // protects: a launch row that readers cannot read back (cost and labels silently empty)
  it('round-trips a launch row and derives the stage from the kind', () => {
    const dir = tempDir();
    appendOwnershipRow(dir, {
      sessionRef: '0b9c6a52-0000-4000-8000-000000000001',
      harness: 'claude-code',
      kind: 'coding',
      model: 'claude-opus-4-7',
      launchedAt: '2026-10-27T13:25:39.000Z',
      head: 'abcdef0123',
      cwd: '/wt',
    });
    assert.deepEqual(readOwnershipRows(dir), [{
      sessionRef: '0b9c6a52-0000-4000-8000-000000000001',
      harness: 'claude-code',
      kind: 'coding',
      stage: 'coding',
      model: 'claude-opus-4-7',
      launchedAt: '2026-10-27T13:25:39.000Z',
      attemptId: 'coding@abcdef0#1793107539',
      cwd: '/wt',
    }]);
  });

  // protects: a helper or remediation row being mistaken for stage work
  it('gives non-stage kinds no stage and requires a native arm to name one', () => {
    const dir = tempDir();
    appendOwnershipRow(dir, { sessionRef: 'r1', harness: 'claude-code', kind: 'ready-remediation', model: 'm' });
    appendOwnershipRow(dir, { sessionRef: 'r2', harness: 'claude-code', kind: helperKind('Task Packet Validation'), model: 'm' });
    const rows = readOwnershipRows(dir);
    assert.deepEqual(rows.map((row) => [row.kind, row.stage]), [
      ['ready-remediation', undefined],
      ['helper:task-packet-validation', undefined],
    ]);
    assert.throws(() => appendOwnershipRow(dir, { sessionRef: 'n', harness: 'native', kind: 'native-arm', model: 'm' }), /native-arm/);
    assert.throws(() => appendOwnershipRow(dir, { sessionRef: 'x', harness: 'claude-code', kind: 'reviewing' as never, model: 'm' }), /unknown kind/);
  });

  // protects: one torn/garbage line hiding every other session of the task
  it('skips malformed lines and keeps the earliest launch of a reused sessionRef', () => {
    const dir = tempDir();
    appendOwnershipRow(dir, { sessionRef: 'wm-coding-HOK-1', harness: 'native', kind: 'native-arm', stage: 'coding', model: 'a', launchedAt: '2026-10-27T10:00:00.000Z' });
    appendFileSync(join(dir, SESSION_OWNERSHIP_FILE), '{"type":"launch","sessionRef":\nnot json\n');
    appendOwnershipRow(dir, { sessionRef: 'wm-coding-HOK-1', harness: 'native', kind: 'native-arm', stage: 'coding', model: 'b', launchedAt: '2026-10-27T11:00:00.000Z' });
    const result = locateOwnershipRows({ slug: 's', worktreePath: dirname(dirname(dir)) });
    assert.equal(result.rows.length, 0, 'a dir outside features/<slug> is not a candidate');
    const rows = readOwnershipRows(dir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].model, 'a');
  });

  // protects: a Codex session staying pending (uncosted) after its thread id is known
  it('applies a pending-ref resolution to the launch row', () => {
    const dir = tempDir();
    const pending = pendingSessionRef('11111111-2222-4333-8444-555555555555');
    appendOwnershipRow(dir, { sessionRef: pending, harness: 'codex', kind: 'coding', model: 'gpt-5.6-terra' });
    assert.equal(exactRows(readOwnershipRows(dir)).length, 0);
    appendSessionRefResolution(dir, pending, '019a0000-thread');
    const rows = readOwnershipRows(dir);
    assert.equal(rows[0].sessionRef, '019a0000-thread');
    assert.equal(exactRows(rows).length, 1);
  });

  // protects: post-reap evals finding no ownership (the HOK-3114 "no stage results" shape)
  it('locates the record live or in the eval archive under the same file name', () => {
    const repo = tempDir();
    const archive = join(repo, '.wavemill', 'evals', 'artifacts', 'HOK-3114');
    mkdirSync(archive, { recursive: true });
    appendOwnershipRow(archive, { sessionRef: 'archived', harness: 'claude-code', kind: 'coding', model: 'm' });
    const located = locateOwnershipRows({ repoDir: repo, issueId: 'HOK-3114', slug: 'gone', worktreePath: join(repo, 'wt') });
    assert.deepEqual(located.rows.map((row) => row.sessionRef), ['archived']);
    assert.deepEqual(located.files, [join(archive, SESSION_OWNERSHIP_FILE)]);
  });

  // protects: stage label drift between the writer's kind and the reader's label
  it('labels owned sessions from their row and unowned ones as operator', () => {
    assert.deepEqual(ownershipStageRole(undefined), {
      value: null,
      kind: 'operator',
      confidence: 'unowned',
      evidence: 'no launch row in .session-ownership.jsonl names this session',
    });
    const row = { sessionRef: 's', harness: 'claude-code' as const, kind: 'review' as const, stage: 'review' as const, model: 'm', launchedAt: '2026-10-27T00:00:00.000Z', attemptId: 'review@nohead#1' };
    assert.deepEqual(ownershipStageRole(row), {
      value: 'review',
      kind: 'review',
      confidence: 'launch_record',
      evidence: 'launch review@nohead#1 at 2026-10-27T00:00:00.000Z',
    });
  });

  // protects: per-kind and per-harness cost groups mixing sessions
  it('groups rows by kind, harness and stage', () => {
    const base = { model: 'm', launchedAt: '2026-10-27T00:00:00.000Z', attemptId: 'a' };
    const rows = [
      { ...base, sessionRef: 'a', harness: 'claude-code' as const, kind: 'coding' as const, stage: 'coding' as const },
      { ...base, sessionRef: 'b', harness: 'native' as const, kind: 'native-arm' as const, stage: 'coding' as const },
      { ...base, sessionRef: 'c', harness: 'claude-code' as const, kind: 'helper:judge' as const },
    ];
    assert.deepEqual([...groupByKind(rows).keys()], ['coding', 'native-arm', 'helper:judge']);
    assert.deepEqual(groupByHarness(rows).get('claude-code')?.map((row) => row.sessionRef), ['a', 'c']);
    assert.deepEqual(rowsForStage(rows, 'coding').map((row) => row.sessionRef), ['a', 'b']);
  });

  // protects: a launch failing because its ownership row could not be written
  it('recordLaunch never throws and records nothing outside a task', () => {
    const warnings: string[] = [];
    assert.equal(recordLaunch(null, { sessionRef: 's', harness: 'claude-code', kind: 'coding', model: 'm' }), null);
    const blocker = join(tempDir(), 'file');
    appendFileSync(blocker, 'x');
    assert.equal(recordLaunch(join(blocker, 'sub'), { sessionRef: 's', harness: 'claude-code', kind: 'coding', model: 'm' }, { warn: (m) => warnings.push(m) }), null);
    assert.equal(warnings.length, 1);
  });

  // protects: a native remediation launch recorded as stage work
  it('native launch kind honours the remediation kind the launcher exported', () => {
    assert.equal(nativeLaunchKind({}), 'native-arm');
    assert.equal(nativeLaunchKind({ WAVEMILL_SESSION_KIND: 'ready-remediation' }), 'ready-remediation');
    assert.equal(nativeLaunchKind({ WAVEMILL_SESSION_KIND: 'bogus' }), 'native-arm');
  });

  // protects: the Codex rollout match failing because writer and reader disagree on the marker
  it('extracts the launch nonce it writes', () => {
    const nonce = 'a1b2c3d4-0000-4000-8000-0000000000ff';
    assert.equal(extractLaunchNonce(`${launchNonceLine(nonce)}\nDo the work`), nonce);
    assert.equal(extractLaunchNonce('no marker'), null);
    assert.equal(buildAttemptId('helper:judge', null, new Date('2026-10-27T00:00:00Z')), 'helper:judge@nohead#1793059200');
  });
});

describe('session-ownership.sh shell twin (HOK-3328)', () => {
  // protects: shell launchers writing rows the TS reader rejects or mislabels
  it('writes rows the TS reader parses identically', () => {
    const dir = tempDir();
    shell(`session_ownership_append "$DIR" "sess-1" claude-code coding claude-opus-4-7 "" "$PWD"
session_ownership_append "$DIR" "sess-2" codex ready-remediation gpt-5.6-terra "ready-remediation@abc1234#1" ""
session_ownership_append "$DIR" "sess-3" claude-code "helper:judge" m "" ""
session_ownership_append "$DIR" "sess-4" claude-code bogus m "" "" || echo rejected`, { DIR: dir });
    const rows = readOwnershipRows(dir);
    assert.deepEqual(rows.map((row) => [row.sessionRef, row.harness, row.kind, row.stage]), [
      ['sess-1', 'claude-code', 'coding', 'coding'],
      ['sess-2', 'codex', 'ready-remediation', undefined],
      ['sess-3', 'claude-code', 'helper:judge', undefined],
    ]);
    assert.equal(rows[1].attemptId, 'ready-remediation@abc1234#1');
    assert.match(rows[0].attemptId, /^coding@(nohead|[0-9a-f]{7})#\d+$/);
    assert.ok(Number.isFinite(Date.parse(rows[0].launchedAt)));
  });

  // protects: remediation launches labelled as coding because the kind never reached the launcher
  it('derives the launch kind from WAVEMILL_SESSION_KIND, else the phase', () => {
    assert.equal(shell('session_ownership_kind_for_launch review').trim(), 'review');
    assert.equal(shell('session_ownership_kind_for_launch coding', { WAVEMILL_SESSION_KIND: 'conflict-resolution' }).trim(), 'conflict-resolution');
    assert.equal(shell('session_ownership_kind_for_launch ""').trim(), 'coding');
  });

  // protects: a generated launcher reusing a Claude --session-id or never recording its row
  it('launch snippet mints a fresh ref per run and records it before the harness starts', () => {
    const dir = tempDir();
    const snippet = shell(`session_ownership_launch_snippet "$DIR" claude-code coding claude-opus-4-7`, { DIR: dir });
    const refs = [1, 2].map(() => execFileSync('bash', ['-c', `${snippet}\nprintf '%s' "$WM_SESSION_REF"`], { encoding: 'utf8' }));
    assert.notEqual(refs[0], refs[1]);
    for (const ref of refs) assert.match(ref, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.deepEqual(readOwnershipRows(dir).map((row) => row.sessionRef).sort(), [...refs].sort());

    const codexDir = tempDir();
    const codexSnippet = shell(`session_ownership_launch_snippet "$DIR" codex coding gpt-5.6-terra`, { DIR: codexDir });
    const out = execFileSync('bash', ['-c', `${codexSnippet}\nprintf '%s\\n%s' "$WM_SESSION_REF" "$WM_LAUNCH_NONCE_LINE"`], { encoding: 'utf8' });
    const [ref, nonceLine] = out.split('\n');
    assert.match(ref, /^pending:/);
    assert.equal(extractLaunchNonce(nonceLine), ref.slice('pending:'.length));
    assert.equal(readFileSync(join(codexDir, SESSION_OWNERSHIP_FILE), 'utf8').includes(ref), true);
  });
});
