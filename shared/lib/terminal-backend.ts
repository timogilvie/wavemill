/**
 * Terminal backend seam (HOK-3293).
 *
 * The one TypeScript module that talks to the terminal host. Shell twin:
 * `shared/lib/terminal-backend.sh`; contract: `docs/terminal-backends.md`.
 *
 * The seam is shaped around what wavemill needs from a terminal host, grouped
 * into capabilities. A backend declares the capabilities it supports and
 * callers check `termHas()` / `termRequireCapability()` before relying on one:
 *
 * - `host`        run a process in a named slot that outlives the controller
 * - `exit`        learn whether that process exited, and with what code
 * - `inspect`     process facts: pid, foreground command, cwd, start command, title, tty
 * - `capture`     read recent output (screen or log tail)
 * - `input`       type literal text or keys into an interactive program
 * - `attach`      let a human view or attach
 * - `session-env` session-scoped key/value visible to later launches
 *
 * Handles ({@link TerminalHandle}) are opaque: pass back what an operation
 * returned and never parse or build one.
 *
 * The only backend today is tmux, invoked by command name (never an absolute
 * path) so PATH-level test fakes keep intercepting. There is deliberately no
 * backend selector and no "run arbitrary tmux" escape hatch.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { execArgvCommand } from './shell-utils.ts';

const execFileAsync = promisify(execFile);

/** Opaque reference to a terminal slot (session, window or pane). Never parse it. */
export type TerminalHandle = string;

/** Capability tokens a backend may declare. */
export type TerminalCapability =
  | 'host'
  | 'exit'
  | 'inspect'
  | 'capture'
  | 'input'
  | 'attach'
  | 'session-env';

/** Backend ids. tmux is the only implementation. */
export type TerminalBackendId = 'tmux';

/** Process facts readable through the `inspect` capability. */
export type PaneField =
  | 'pid'
  | 'current_command'
  | 'current_path'
  | 'start_command'
  | 'title'
  | 'tty'
  | 'dead';

/** One pane as reported by {@link termListPanes}. */
export interface PaneRow {
  /** Opaque handle accepted by every other operation. */
  handle: TerminalHandle;
  session: string;
  windowIndex: string;
  paneIndex: string;
  windowName: string;
  active: boolean;
  pid: number;
  currentCommand: string;
  title: string;
}

/** Thrown when a caller needs a capability the active backend does not declare. */
export class TerminalCapabilityError extends Error {
  readonly capability: TerminalCapability;
  readonly reason: string;
  readonly backend: TerminalBackendId;

  constructor(capability: TerminalCapability, reason: string, backend: TerminalBackendId) {
    super(`terminal-backend: missing capability=${capability} backend=${backend} reason=${reason}`);
    this.name = 'TerminalCapabilityError';
    this.capability = capability;
    this.reason = reason;
    this.backend = backend;
  }
}

const TMUX_CAPABILITIES: readonly TerminalCapability[] = Object.freeze([
  'host',
  'exit',
  'inspect',
  'capture',
  'input',
  'attach',
  'session-env',
]);

const PANE_FIELD_FORMATS: Readonly<Record<PaneField, string>> = Object.freeze({
  pid: '#{pane_pid}',
  current_command: '#{pane_current_command}',
  current_path: '#{pane_current_path}',
  start_command: '#{pane_start_command}',
  title: '#{pane_title}',
  tty: '#{pane_tty}',
  dead: '#{pane_dead}',
});

// Field order is the parsing contract for PaneRow; keep it in step with parsePaneRow.
const PANE_ROW_FORMAT = [
  '#{session_name}',
  '#{window_index}',
  '#{pane_index}',
  '#{window_name}',
  '#{pane_active}',
  '#{pane_pid}',
  '#{pane_current_command}',
  '#{pane_title}',
].join('\t');

/**
 * Every operation the seam can issue, as data. {@link tmuxArgv} turns one into
 * the exact tmux argv, so tests can pin it without spawning anything.
 */
export type TerminalOperation =
  | { op: 'new-session'; session: string; window?: string; cwd?: string; command?: readonly string[] }
  | { op: 'new-window'; session: string; name: string; cwd?: string; printHandle?: boolean; command?: readonly string[] }
  | {
      op: 'split';
      target: TerminalHandle;
      direction?: 'horizontal' | 'vertical';
      full?: boolean;
      percent?: number;
      cwd?: string;
      printHandle?: boolean;
      command?: readonly string[];
    }
  | { op: 'list-sessions' }
  | { op: 'list-windows'; session: string }
  | { op: 'list-panes'; target?: TerminalHandle }
  | { op: 'kill-session'; session: string }
  | { op: 'kill-window'; target: TerminalHandle }
  | { op: 'kill-pane'; target: TerminalHandle }
  | { op: 'respawn'; target: TerminalHandle; kill?: boolean; cwd?: string; command?: readonly string[] }
  | { op: 'is-dead'; target: TerminalHandle }
  | { op: 'exit-code'; target: TerminalHandle }
  | { op: 'pane-fields'; target: TerminalHandle; fields: readonly PaneField[] }
  | { op: 'capture'; target: TerminalHandle; lines?: number }
  | { op: 'send-text'; target: TerminalHandle; text: string }
  | { op: 'send-key'; target: TerminalHandle; keys: readonly string[] }
  | { op: 'attach'; session: string }
  | { op: 'refresh-client' }
  | { op: 'set-title'; target: TerminalHandle; title: string }
  | { op: 'session-env-get'; session: string; name?: string }
  | { op: 'session-env-set'; session: string; name: string; value: string };

const OPERATION_CAPABILITY: Readonly<Record<TerminalOperation['op'], TerminalCapability>> = Object.freeze({
  'new-session': 'host',
  'new-window': 'host',
  split: 'host',
  'list-sessions': 'host',
  'list-windows': 'host',
  'list-panes': 'host',
  'kill-session': 'host',
  'kill-window': 'host',
  'kill-pane': 'host',
  respawn: 'host',
  'is-dead': 'exit',
  'exit-code': 'exit',
  'pane-fields': 'inspect',
  capture: 'capture',
  'send-text': 'input',
  'send-key': 'input',
  attach: 'attach',
  'refresh-client': 'attach',
  'set-title': 'attach',
  'session-env-get': 'session-env',
  'session-env-set': 'session-env',
});

/** Exact tmux argv (without the leading `tmux`) for one operation. Pure. */
export function tmuxArgv(operation: TerminalOperation): string[] {
  switch (operation.op) {
    case 'new-session':
      return [
        'new-session', '-d', '-s', operation.session,
        ...(operation.window ? ['-n', operation.window] : []),
        ...(operation.cwd ? ['-c', operation.cwd] : []),
        ...(operation.command ?? []),
      ];
    case 'new-window':
      return [
        'new-window', '-d', '-t', operation.session, '-n', operation.name,
        ...(operation.cwd ? ['-c', operation.cwd] : []),
        ...(operation.printHandle ? ['-P', '-F', '#{window_id}'] : []),
        ...(operation.command ?? []),
      ];
    case 'split':
      return [
        'split-window', '-t', operation.target,
        ...(operation.direction === 'horizontal' ? ['-h'] : operation.direction === 'vertical' ? ['-v'] : []),
        ...(operation.full ? ['-f'] : []),
        ...(operation.percent !== undefined ? ['-p', String(operation.percent)] : []),
        ...(operation.cwd ? ['-c', operation.cwd] : []),
        ...(operation.printHandle ? ['-P', '-F', '#{pane_id}'] : []),
        ...(operation.command ?? []),
      ];
    case 'list-sessions':
      return ['list-sessions', '-F', '#{session_name}'];
    case 'list-windows':
      return ['list-windows', '-t', operation.session, '-F', '#{window_id}|#{window_name}'];
    case 'list-panes':
      return operation.target
        ? ['list-panes', '-t', operation.target, '-F', PANE_ROW_FORMAT]
        : ['list-panes', '-a', '-F', PANE_ROW_FORMAT];
    case 'kill-session':
      return ['kill-session', '-t', operation.session];
    case 'kill-window':
      return ['kill-window', '-t', operation.target];
    case 'kill-pane':
      return ['kill-pane', '-t', operation.target];
    case 'respawn':
      return [
        'respawn-pane',
        ...(operation.kill ? ['-k'] : []),
        '-t', operation.target,
        ...(operation.cwd ? ['-c', operation.cwd] : []),
        ...(operation.command ?? []),
      ];
    case 'is-dead':
      return ['list-panes', '-t', operation.target, '-F', '#{pane_dead}'];
    case 'exit-code':
      return ['list-panes', '-t', operation.target, '-F', '#{pane_dead}:#{pane_dead_status}'];
    case 'pane-fields':
      if (operation.fields.length === 0) throw new Error('terminal-backend: pane fields required');
      return [
        'display-message', '-p', '-t', operation.target,
        operation.fields.map((field) => PANE_FIELD_FORMATS[field]).join('|'),
      ];
    case 'capture':
      return operation.lines !== undefined
        ? ['capture-pane', '-p', '-t', operation.target, '-S', `-${operation.lines}`]
        : ['capture-pane', '-p', '-t', operation.target];
    case 'send-text':
      return ['send-keys', '-t', operation.target, '-l', '--', operation.text];
    case 'send-key':
      if (operation.keys.length === 0) throw new Error('terminal-backend: key required');
      return ['send-keys', '-t', operation.target, ...operation.keys];
    case 'attach':
      return ['attach', '-t', operation.session];
    case 'refresh-client':
      return ['refresh-client', '-S'];
    case 'set-title':
      return ['select-pane', '-t', operation.target, '-T', operation.title];
    case 'session-env-get':
      return operation.name
        ? ['show-environment', '-t', operation.session, operation.name]
        : ['show-environment', '-t', operation.session];
    case 'session-env-set':
      return ['set-environment', '-t', operation.session, operation.name, operation.value];
  }
}

// ── Execution ────────────────────────────────────────────────────────────────

/** Result of one backend invocation. */
export interface TerminalExecResult {
  ok: boolean;
  stdout: string;
}

/** How the backend runs its command. Replaced in tests via {@link setTerminalExecForTest}. */
export interface TerminalExec {
  sync(args: readonly string[], timeoutMs?: number): TerminalExecResult;
  async(args: readonly string[], timeoutMs?: number): Promise<TerminalExecResult>;
}

const TMUX_EXEC: TerminalExec = {
  sync(args, timeoutMs) {
    const result = execArgvCommand('tmux', args, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { ok: result.exitCode === 0, stdout: result.stdout };
  },
  async async(args, timeoutMs) {
    try {
      const { stdout } = await execFileAsync('tmux', [...args], {
        encoding: 'utf-8',
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
      });
      return { ok: true, stdout };
    } catch {
      return { ok: false, stdout: '' };
    }
  },
};

let activeExec: TerminalExec = TMUX_EXEC;
let capabilityOverride: readonly TerminalCapability[] | null = null;

/** Test seam: record or fake backend invocations. Pass `null` to restore. */
export function setTerminalExecForTest(exec: TerminalExec | null): void {
  activeExec = exec ?? TMUX_EXEC;
}

/** Test seam: pretend the backend declares only `capabilities`. Pass `null` to restore. */
export function setTerminalCapabilitiesForTest(capabilities: readonly TerminalCapability[] | null): void {
  capabilityOverride = capabilities;
}

/** Shared per-call options. */
export interface TerminalCallOptions {
  /** Kill the backend command after this many milliseconds. */
  timeoutMs?: number;
}

function runSync(operation: TerminalOperation, options: TerminalCallOptions = {}): TerminalExecResult {
  termRequireCapability(OPERATION_CAPABILITY[operation.op], operation.op);
  return activeExec.sync(tmuxArgv(operation), options.timeoutMs);
}

async function runAsync(operation: TerminalOperation, options: TerminalCallOptions = {}): Promise<TerminalExecResult> {
  termRequireCapability(OPERATION_CAPABILITY[operation.op], operation.op);
  return activeExec.async(tmuxArgv(operation), options.timeoutMs);
}

function nonEmptyLines(stdout: string): string[] {
  return stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

function firstLine(stdout: string): string {
  return stdout.split('\n')[0]?.trim() ?? '';
}

function parsePaneFields(fields: readonly PaneField[], stdout: string): Record<PaneField, string> {
  const values = stdout.replace(/\n$/, '').split('|');
  const record = {} as Record<PaneField, string>;
  fields.forEach((field, index) => {
    record[field] = values[index] ?? '';
  });
  return record;
}

function parsePaneRow(line: string): PaneRow {
  const [session = '', windowIndex = '', paneIndex = '', windowName = '', active, pid = '', command, title] = line.split('\t');
  return {
    handle: termPaneHandle(session, windowIndex, paneIndex),
    session,
    windowIndex,
    paneIndex,
    windowName,
    active: active === '1',
    pid: Number.parseInt(pid, 10) || 0,
    currentCommand: command || '',
    title: title || '',
  };
}

// ── Capability metadata ──────────────────────────────────────────────────────

/** The active backend id. */
export function termBackend(): TerminalBackendId {
  return 'tmux';
}

/** Capabilities the active backend declares. */
export function termCapabilities(): readonly TerminalCapability[] {
  return capabilityOverride ?? TMUX_CAPABILITIES;
}

/** Whether the active backend declares `capability`. */
export function termHas(capability: TerminalCapability): boolean {
  return termCapabilities().includes(capability);
}

/**
 * Throw {@link TerminalCapabilityError} unless the backend declares
 * `capability`. Callers that need `input` (prompt delivery, pane messages)
 * check here instead of silently doing nothing.
 */
export function termRequireCapability(capability: TerminalCapability, reason: string): void {
  if (!termHas(capability)) {
    throw new TerminalCapabilityError(capability, reason, termBackend());
  }
}

// ── host ─────────────────────────────────────────────────────────────────────

/** Create a detached session whose first slot runs `command` (default: a shell). */
export function termNewSession(
  session: string,
  options: TerminalCallOptions & { window?: string; cwd?: string; command?: readonly string[] } = {},
): boolean {
  return runSync({ op: 'new-session', session, window: options.window, cwd: options.cwd, command: options.command }, options).ok;
}

/** Create a background slot in `session`; returns its handle, or null on failure. */
export function termNewWindow(
  session: string,
  name: string,
  options: TerminalCallOptions & { cwd?: string; command?: readonly string[] } = {},
): TerminalHandle | null {
  const result = runSync({ op: 'new-window', session, name, cwd: options.cwd, printHandle: true, command: options.command }, options);
  return result.ok ? firstLine(result.stdout) || null : null;
}

/** Split the slot at `target`; returns the new pane's handle, or null on failure. */
export function termSplit(
  target: TerminalHandle,
  options: TerminalCallOptions & {
    direction?: 'horizontal' | 'vertical';
    full?: boolean;
    percent?: number;
    cwd?: string;
    command?: readonly string[];
  } = {},
): TerminalHandle | null {
  const result = runSync({
    op: 'split',
    target,
    direction: options.direction,
    full: options.full,
    percent: options.percent,
    cwd: options.cwd,
    printHandle: true,
    command: options.command,
  }, options);
  return result.ok ? firstLine(result.stdout) || null : null;
}

/** Session names; empty when the host is unreachable. */
export function termListSessions(options: TerminalCallOptions = {}): string[] {
  const result = runSync({ op: 'list-sessions' }, options);
  return result.ok ? nonEmptyLines(result.stdout) : [];
}

/** Windows of `session` as `{ handle, name }`; empty when unreadable. */
export function termListWindows(session: string, options: TerminalCallOptions = {}): Array<{ handle: TerminalHandle; name: string }> {
  const result = runSync({ op: 'list-windows', session }, options);
  if (!result.ok) return [];
  return nonEmptyLines(result.stdout).map((line) => {
    const index = line.indexOf('|');
    return index === -1 ? { handle: line, name: '' } : { handle: line.slice(0, index), name: line.slice(index + 1) };
  });
}

/** Panes under `target`, or every pane on the host when `target` is omitted. */
export function termListPanes(options: TerminalCallOptions & { target?: TerminalHandle } = {}): PaneRow[] {
  const result = runSync({ op: 'list-panes', target: options.target }, options);
  if (!result.ok) return [];
  return result.stdout.split('\n').filter(Boolean).map(parsePaneRow);
}

/** Kill a whole session. */
export function termKillSession(session: string, options: TerminalCallOptions = {}): boolean {
  return runSync({ op: 'kill-session', session }, options).ok;
}

/** Kill the window at `target` and every pane in it. */
export function termKillWindow(target: TerminalHandle, options: TerminalCallOptions = {}): boolean {
  return runSync({ op: 'kill-window', target }, options).ok;
}

/** Kill the pane at `target`. */
export function termKillPane(target: TerminalHandle, options: TerminalCallOptions = {}): boolean {
  return runSync({ op: 'kill-pane', target }, options).ok;
}

/** Restart the slot's process in place; `kill` replaces a still-live process. */
export function termRespawn(
  target: TerminalHandle,
  options: TerminalCallOptions & { kill?: boolean; cwd?: string; command?: readonly string[] } = {},
): boolean {
  return runSync({ op: 'respawn', target, kill: options.kill, cwd: options.cwd, command: options.command }, options).ok;
}

/** Handle for a window of `session` named `window`; handles pass through unchanged. */
export function termWindowHandle(session: string, window: string): TerminalHandle | null {
  if (!window) return null;
  return window.startsWith('@') || window.includes(':') ? window : `${session}:${window}`;
}

/**
 * Handle for the pane identified by the coordinates a {@link PaneRow} reports.
 * Lets callers that kept only those coordinates address the pane again
 * without building a target string themselves.
 */
export function termPaneHandle(session: string, windowIndex: string, paneIndex: string): TerminalHandle {
  return `${session}:${windowIndex}.${paneIndex}`;
}

// ── exit ─────────────────────────────────────────────────────────────────────

/** True when the process exited, false while running, null when unreadable. */
export function termIsDead(target: TerminalHandle, options: TerminalCallOptions = {}): boolean | null {
  const result = runSync({ op: 'is-dead', target }, options);
  if (!result.ok) return null;
  const dead = firstLine(result.stdout);
  return dead === '1' ? true : dead === '0' ? false : null;
}

/** Exit status of an exited process; null while running or unreadable. */
export function termExitCode(target: TerminalHandle, options: TerminalCallOptions = {}): number | null {
  const result = runSync({ op: 'exit-code', target }, options);
  if (!result.ok) return null;
  const match = /^1:(-?\d+)$/.exec(firstLine(result.stdout));
  return match ? Number.parseInt(match[1], 10) : null;
}

// ── inspect ──────────────────────────────────────────────────────────────────

/** One process fact for `target`; null when unreadable. */
export function termPaneField(target: TerminalHandle, field: PaneField, options: TerminalCallOptions = {}): string | null {
  const result = runSync({ op: 'pane-fields', target, fields: [field] }, options);
  return result.ok ? result.stdout.replace(/\n$/, '') : null;
}

/** Several process facts for `target` read in one snapshot; null when unreadable. */
export function termPaneFields(
  target: TerminalHandle,
  fields: readonly PaneField[],
  options: TerminalCallOptions = {},
): Record<PaneField, string> | null {
  const result = runSync({ op: 'pane-fields', target, fields }, options);
  return result.ok ? parsePaneFields(fields, result.stdout) : null;
}

/** Async {@link termPaneFields} for callers that must not block the event loop. */
export async function termPaneFieldsAsync(
  target: TerminalHandle,
  fields: readonly PaneField[],
  options: TerminalCallOptions = {},
): Promise<Record<PaneField, string> | null> {
  const result = await runAsync({ op: 'pane-fields', target, fields }, options);
  return result.ok ? parsePaneFields(fields, result.stdout) : null;
}

// ── capture ──────────────────────────────────────────────────────────────────

/**
 * Recent output of `target`; `lines` extends the read that far back into
 * history. Null when unreadable. A backend may serve this from a log tail.
 */
export function termCapture(
  target: TerminalHandle,
  options: TerminalCallOptions & { lines?: number } = {},
): string | null {
  const result = runSync({ op: 'capture', target, lines: options.lines }, options);
  return result.ok ? result.stdout : null;
}

// ── input ────────────────────────────────────────────────────────────────────

/** Type `text` literally into `target` (no key-name parsing). */
export function termSendText(target: TerminalHandle, text: string, options: TerminalCallOptions = {}): boolean {
  return runSync({ op: 'send-text', target, text }, options).ok;
}

/** Press named keys (`Enter`, `C-m`, `C-c`, `Escape`) in `target`. */
export function termSendKey(target: TerminalHandle, keys: readonly string[], options: TerminalCallOptions = {}): boolean {
  return runSync({ op: 'send-key', target, keys }, options).ok;
}

// ── attach ───────────────────────────────────────────────────────────────────

/** Redraw attached viewers (status line included). */
export function termRefreshClient(options: TerminalCallOptions = {}): boolean {
  return runSync({ op: 'refresh-client' }, options).ok;
}

/** Label the slot at `target` for human viewers. */
export function termSetTitle(target: TerminalHandle, title: string, options: TerminalCallOptions = {}): boolean {
  return runSync({ op: 'set-title', target, title }, options).ok;
}

// ── session-env ──────────────────────────────────────────────────────────────

/** Every session-scoped variable of `session`; empty when unreadable. */
export function termSessionEnv(session: string, options: TerminalCallOptions = {}): Record<string, string> {
  const result = runSync({ op: 'session-env-get', session }, options);
  const env: Record<string, string> = {};
  if (!result.ok) return env;
  for (const line of result.stdout.split('\n')) {
    if (!line || line.startsWith('-')) continue;
    const index = line.indexOf('=');
    if (index === -1) continue;
    env[line.slice(0, index)] = line.slice(index + 1);
  }
  return env;
}

/** Value of one session-scoped variable; null when unset or unreadable. */
export function termSessionEnvGet(session: string, name: string, options: TerminalCallOptions = {}): string | null {
  const result = runSync({ op: 'session-env-get', session, name }, options);
  const line = result.stdout.split('\n')[0] ?? '';
  return result.ok && line.startsWith(`${name}=`) ? line.slice(name.length + 1) : null;
}

/** Set a session-scoped variable that later launches in `session` inherit. */
export function termSessionEnvSet(session: string, name: string, value: string, options: TerminalCallOptions = {}): boolean {
  return runSync({ op: 'session-env-set', session, name, value }, options).ok;
}
