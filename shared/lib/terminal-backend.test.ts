/**
 * HOK-3293: pin the TS terminal backend seam — the declared capability set,
 * the exact tmux argv for every operation, output parsing, and the typed
 * refusal when a capability is missing.
 */

import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TerminalCapabilityError,
  setTerminalCapabilitiesForTest,
  setTerminalExecForTest,
  termBackend,
  termCapabilities,
  termCapture,
  termExitCode,
  termHas,
  termIsDead,
  termKillPane,
  termKillSession,
  termKillWindow,
  termListPanes,
  termListSessions,
  termListWindows,
  termNewSession,
  termNewWindow,
  termPaneField,
  termPaneFields,
  termPaneFieldsAsync,
  termPaneHandle,
  termRefreshClient,
  termRequireCapability,
  termRespawn,
  termSendKey,
  termSendText,
  termSessionEnv,
  termSessionEnvGet,
  termSessionEnvSet,
  termSetTitle,
  termSplit,
  termWindowHandle,
  tmuxArgv,
  type TerminalExecResult,
} from './terminal-backend.ts';

const PANE_ROW_FORMAT =
  '#{session_name}\t#{window_index}\t#{pane_index}\t#{window_name}\t#{pane_active}\t#{pane_pid}\t#{pane_current_command}\t#{pane_title}';

/** Install a recording exec that answers every call with `result`. */
function record(result: TerminalExecResult = { ok: true, stdout: '' }): string[][] {
  const calls: string[][] = [];
  setTerminalExecForTest({
    sync(args) {
      calls.push([...args]);
      return result;
    },
    async async(args) {
      calls.push([...args]);
      return result;
    },
  });
  return calls;
}

afterEach(() => {
  setTerminalExecForTest(null);
  setTerminalCapabilitiesForTest(null);
});

describe('capabilities', () => {
  test('tmux backend declares exactly the seven capabilities', () => {
    assert.equal(termBackend(), 'tmux');
    assert.deepEqual(
      [...termCapabilities()].sort(),
      ['attach', 'capture', 'exit', 'host', 'input', 'inspect', 'session-env'],
    );
    assert.equal(termHas('input'), true);
  });

  test('a missing capability throws a typed error and never runs the backend', () => {
    const calls = record();
    setTerminalCapabilitiesForTest(['host', 'exit', 'inspect', 'capture', 'attach', 'session-env']);
    assert.equal(termHas('input'), false);
    assert.throws(
      () => termSendText('@3', 'hi'),
      (error: unknown) =>
        error instanceof TerminalCapabilityError
        && error.capability === 'input'
        && error.reason === 'send-text'
        && error.backend === 'tmux',
    );
    assert.throws(() => termRequireCapability('input', 'prompt-delivery'), TerminalCapabilityError);
    assert.deepEqual(calls, []);
  });
});

describe('tmuxArgv', () => {
  const cases: Array<[string, Parameters<typeof tmuxArgv>[0], string[]]> = [
    ['new-session', { op: 'new-session', session: 'wm', window: 'control', cwd: '/repo', command: ['bash', '-l'] },
      ['new-session', '-d', '-s', 'wm', '-n', 'control', '-c', '/repo', 'bash', '-l']],
    ['new-window', { op: 'new-window', session: 'wm', name: 'HOK-1-x', cwd: '/wt', printHandle: true, command: ['claude'] },
      ['new-window', '-d', '-t', 'wm', '-n', 'HOK-1-x', '-c', '/wt', '-P', '-F', '#{window_id}', 'claude']],
    ['split', { op: 'split', target: 'wm:0', direction: 'horizontal', full: true, percent: 30, cwd: '/wt', printHandle: true, command: ['bash'] },
      ['split-window', '-t', 'wm:0', '-h', '-f', '-p', '30', '-c', '/wt', '-P', '-F', '#{pane_id}', 'bash']],
    ['list-sessions', { op: 'list-sessions' }, ['list-sessions', '-F', '#{session_name}']],
    ['list-windows', { op: 'list-windows', session: 'wm' }, ['list-windows', '-t', 'wm', '-F', '#{window_id}|#{window_name}']],
    ['list-panes all', { op: 'list-panes' }, ['list-panes', '-a', '-F', PANE_ROW_FORMAT]],
    ['list-panes target', { op: 'list-panes', target: '@3' }, ['list-panes', '-t', '@3', '-F', PANE_ROW_FORMAT]],
    ['kill-session', { op: 'kill-session', session: 'wm' }, ['kill-session', '-t', 'wm']],
    ['kill-window', { op: 'kill-window', target: '@3' }, ['kill-window', '-t', '@3']],
    ['kill-pane', { op: 'kill-pane', target: '%7' }, ['kill-pane', '-t', '%7']],
    ['respawn', { op: 'respawn', target: '@3', kill: true, cwd: '/wt', command: ['claude'] },
      ['respawn-pane', '-k', '-t', '@3', '-c', '/wt', 'claude']],
    ['is-dead', { op: 'is-dead', target: '@3' }, ['list-panes', '-t', '@3', '-F', '#{pane_dead}']],
    ['exit-code', { op: 'exit-code', target: '@3' }, ['list-panes', '-t', '@3', '-F', '#{pane_dead}:#{pane_dead_status}']],
    ['pane-fields', { op: 'pane-fields', target: '@3', fields: ['dead', 'current_command', 'pid'] },
      ['display-message', '-p', '-t', '@3', '#{pane_dead}|#{pane_current_command}|#{pane_pid}']],
    ['capture screen', { op: 'capture', target: '@3' }, ['capture-pane', '-p', '-t', '@3']],
    ['capture history', { op: 'capture', target: '@3', lines: 200 }, ['capture-pane', '-p', '-t', '@3', '-S', '-200']],
    ['send-text', { op: 'send-text', target: '@3', text: 'echo hi' }, ['send-keys', '-t', '@3', '-l', '--', 'echo hi']],
    ['send-key', { op: 'send-key', target: '@3', keys: ['C-c', 'Enter'] }, ['send-keys', '-t', '@3', 'C-c', 'Enter']],
    ['attach', { op: 'attach', session: 'wm' }, ['attach', '-t', 'wm']],
    ['refresh-client', { op: 'refresh-client' }, ['refresh-client', '-S']],
    ['set-title', { op: 'set-title', target: '@3', title: 'HOK-1' }, ['select-pane', '-t', '@3', '-T', 'HOK-1']],
    ['session-env-get all', { op: 'session-env-get', session: 'wm' }, ['show-environment', '-t', 'wm']],
    ['session-env-get name', { op: 'session-env-get', session: 'wm', name: 'X' }, ['show-environment', '-t', 'wm', 'X']],
    ['session-env-set', { op: 'session-env-set', session: 'wm', name: 'X', value: '1' }, ['set-environment', '-t', 'wm', 'X', '1']],
  ];
  for (const [name, operation, expected] of cases) {
    test(name, () => assert.deepEqual(tmuxArgv(operation), expected));
  }

  test('every inspect field maps to its tmux format token', () => {
    const tokens = {
      pid: '#{pane_pid}',
      current_command: '#{pane_current_command}',
      current_path: '#{pane_current_path}',
      start_command: '#{pane_start_command}',
      title: '#{pane_title}',
      tty: '#{pane_tty}',
      dead: '#{pane_dead}',
    } as const;
    for (const [field, token] of Object.entries(tokens)) {
      assert.deepEqual(
        tmuxArgv({ op: 'pane-fields', target: '@3', fields: [field as keyof typeof tokens] }),
        ['display-message', '-p', '-t', '@3', token],
      );
    }
  });

  test('empty field and key lists are rejected', () => {
    assert.throws(() => tmuxArgv({ op: 'pane-fields', target: '@3', fields: [] }));
    assert.throws(() => tmuxArgv({ op: 'send-key', target: '@3', keys: [] }));
  });
});

describe('operations issue the pinned argv and parse output', () => {
  test('host operations', () => {
    let calls = record({ ok: true, stdout: '@12\n' });
    assert.equal(termNewWindow('wm', 'HOK-1-x', { cwd: '/wt' }), '@12');
    assert.deepEqual(calls, [['new-window', '-d', '-t', 'wm', '-n', 'HOK-1-x', '-c', '/wt', '-P', '-F', '#{window_id}']]);

    calls = record({ ok: true, stdout: '%4\n' });
    assert.equal(termSplit('wm:0', { direction: 'vertical' }), '%4');
    assert.deepEqual(calls, [['split-window', '-t', 'wm:0', '-v', '-P', '-F', '#{pane_id}']]);

    calls = record();
    assert.equal(termNewSession('wm'), true);
    assert.equal(termKillSession('wm'), true);
    assert.equal(termKillWindow('@3'), true);
    assert.equal(termKillPane('%7'), true);
    assert.equal(termRespawn('@3', { kill: true }), true);
    assert.deepEqual(calls, [
      ['new-session', '-d', '-s', 'wm'],
      ['kill-session', '-t', 'wm'],
      ['kill-window', '-t', '@3'],
      ['kill-pane', '-t', '%7'],
      ['respawn-pane', '-k', '-t', '@3'],
    ]);

    record({ ok: true, stdout: 'wm\n\n other \n' });
    assert.deepEqual(termListSessions(), ['wm', 'other']);

    record({ ok: true, stdout: '@1|control\n@2|HOK-1 · slug\n' });
    assert.deepEqual(termListWindows('wm'), [
      { handle: '@1', name: 'control' },
      { handle: '@2', name: 'HOK-1 · slug' },
    ]);

    calls = record({ ok: true, stdout: 'wm\t1\t0\tHOK-1\t1\t4242\tclaude\tcoding\n' });
    assert.deepEqual(termListPanes(), [{
      handle: 'wm:1.0',
      session: 'wm',
      windowIndex: '1',
      paneIndex: '0',
      windowName: 'HOK-1',
      active: true,
      pid: 4242,
      currentCommand: 'claude',
      title: 'coding',
    }]);
    assert.deepEqual(calls, [['list-panes', '-a', '-F', PANE_ROW_FORMAT]]);

    record({ ok: false, stdout: '' });
    assert.deepEqual(termListSessions(), []);
    assert.deepEqual(termListPanes(), []);
    assert.equal(termNewWindow('wm', 'x'), null);
  });

  test('handles are built by the seam, never by callers', () => {
    assert.equal(termPaneHandle('wm', '1', '0'), 'wm:1.0');
    assert.equal(termWindowHandle('wm', '1'), 'wm:1');
    assert.equal(termWindowHandle('wm', '@42'), '@42');
    assert.equal(termWindowHandle('wm', 'other:2'), 'other:2');
    assert.equal(termWindowHandle('wm', ''), null);
  });

  test('exit operations', () => {
    record({ ok: true, stdout: '1\n' });
    assert.equal(termIsDead('@3'), true);
    record({ ok: true, stdout: '0\n' });
    assert.equal(termIsDead('@3'), false);
    record({ ok: false, stdout: '' });
    assert.equal(termIsDead('@3'), null);

    record({ ok: true, stdout: '1:42\n' });
    assert.equal(termExitCode('@3'), 42);
    record({ ok: true, stdout: '0:\n' });
    assert.equal(termExitCode('@3'), null);
  });

  test('inspect operations', async () => {
    let calls = record({ ok: true, stdout: '4242\n' });
    assert.equal(termPaneField('@3', 'pid'), '4242');
    assert.deepEqual(calls, [['display-message', '-p', '-t', '@3', '#{pane_pid}']]);

    calls = record({ ok: true, stdout: '0|claude|4242\n' });
    assert.deepEqual(termPaneFields('@3', ['dead', 'current_command', 'pid']), {
      dead: '0',
      current_command: 'claude',
      pid: '4242',
    });
    assert.deepEqual(await termPaneFieldsAsync('@3', ['dead', 'current_command', 'pid']), {
      dead: '0',
      current_command: 'claude',
      pid: '4242',
    });
    assert.deepEqual(calls, [
      ['display-message', '-p', '-t', '@3', '#{pane_dead}|#{pane_current_command}|#{pane_pid}'],
      ['display-message', '-p', '-t', '@3', '#{pane_dead}|#{pane_current_command}|#{pane_pid}'],
    ]);

    record({ ok: false, stdout: '' });
    assert.equal(termPaneField('@3', 'pid'), null);
    assert.equal(await termPaneFieldsAsync('@3', ['dead']), null);
  });

  test('capture', () => {
    const calls = record({ ok: true, stdout: 'line 1\nline 2\n' });
    assert.equal(termCapture('wm:1.0', { lines: 200 }), 'line 1\nline 2\n');
    assert.deepEqual(calls, [['capture-pane', '-p', '-t', 'wm:1.0', '-S', '-200']]);
    record({ ok: false, stdout: '' });
    assert.equal(termCapture('wm:1.0'), null);
  });

  test('input and attach', () => {
    const calls = record();
    assert.equal(termSendText('@3', 'echo hi'), true);
    assert.equal(termSendKey('@3', ['Enter']), true);
    assert.equal(termSetTitle('@3', 'HOK-1'), true);
    assert.equal(termRefreshClient(), true);
    assert.deepEqual(calls, [
      ['send-keys', '-t', '@3', '-l', '--', 'echo hi'],
      ['send-keys', '-t', '@3', 'Enter'],
      ['select-pane', '-t', '@3', '-T', 'HOK-1'],
      ['refresh-client', '-S'],
    ]);
  });

  test('session-env', () => {
    let calls = record({ ok: true, stdout: 'A=1\n-B\nC=x=y\nnoise\n' });
    assert.deepEqual(termSessionEnv('wm'), { A: '1', C: 'x=y' });
    assert.deepEqual(calls, [['show-environment', '-t', 'wm']]);

    record({ ok: true, stdout: 'WAVEMILL_DASHBOARD_PID=123\n' });
    assert.equal(termSessionEnvGet('wm', 'WAVEMILL_DASHBOARD_PID'), '123');
    record({ ok: true, stdout: '-WAVEMILL_DASHBOARD_PID\n' });
    assert.equal(termSessionEnvGet('wm', 'WAVEMILL_DASHBOARD_PID'), null);

    calls = record();
    assert.equal(termSessionEnvSet('wm', 'WAVEMILL_DASHBOARD_PID', '123'), true);
    assert.deepEqual(calls, [['set-environment', '-t', 'wm', 'WAVEMILL_DASHBOARD_PID', '123']]);
  });

  test('timeouts are forwarded to the backend', () => {
    const timeouts: Array<number | undefined> = [];
    setTerminalExecForTest({
      sync(_args, timeoutMs) {
        timeouts.push(timeoutMs);
        return { ok: true, stdout: '' };
      },
      async async(_args, timeoutMs) {
        timeouts.push(timeoutMs);
        return { ok: true, stdout: '' };
      },
    });
    termListSessions({ timeoutMs: 5_000 });
    termCapture('@3', { timeoutMs: 3_000 });
    assert.deepEqual(timeouts, [5_000, 3_000]);
  });
});
