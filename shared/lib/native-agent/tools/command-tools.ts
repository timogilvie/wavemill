import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import type { CommandClass } from '../command-classifier.ts';
import { classifyCommand } from '../command-classifier.ts';
import { parseCommandArgv } from '../command-argv.ts';
import { buildTrustMetadata } from '../provenance.ts';
import {
  runCommand,
  type ApprovalOutcome,
  type RejectionReason,
  type RunCommandOptions,
} from '../command-substrate.ts';
import {
  classifyTestCommandScope,
  formatScriptExpansion,
  readScriptExpansion,
  resolvePackageScriptInvocation,
  FOCUSED_TEST_GUIDANCE,
  type ScriptExpansion,
} from '../test-command-scope.ts';
import { defaultWorktreeFingerprint } from '../worktree-fingerprint.ts';
import type { CleanupTracker } from '../cleanup.ts';
import type { ToolDescriptor, WavemillToolResult } from './types.ts';

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TEST_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_FORMAT_TIMEOUT_MS = 60_000;
export const MAX_TEST_TIMEOUT_MS = 10 * 60_000;
export const MAX_FORMAT_TIMEOUT_MS = 2 * 60_000;
const INTERNAL_CAP_MULTIPLIER = 16;
const INTERNAL_CAP_FLOOR_BYTES = 1024 * 1024;
const SUBSTRATE_TRUNCATION_MARKER = '[output truncated]';

export type RunCommandKind = 'tests' | 'format';
export type RunCommandStatus = 'completed' | 'timed_out' | 'rejected';
export type RunCommandToolName = 'run_tests' | 'run_format';

export interface RunCommandParams {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface RunCommandOutputMeta {
  originalByteLength: number;
  truncated: boolean;
}

export interface PreviousTimeoutRecord {
  durationMs: number;
  timeoutMs: number;
  at: string;
}

export interface RunCommandSuccessDetails {
  ok: true;
  tool: RunCommandToolName;
  kind: RunCommandKind;
  status: 'completed' | 'timed_out';
  commandClass: CommandClass;
  approval: ApprovalOutcome;
  command: string;
  cwd: string;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutMeta: RunCommandOutputMeta;
  stderrMeta: RunCommandOutputMeta;
  truncated: boolean;
  requestedTimeoutMs?: number;
  effectiveTimeoutMs: number;
  scriptExpansion?: ScriptExpansion;
}

export interface RunCommandRejectedDetails {
  ok: false;
  tool: RunCommandToolName;
  kind: RunCommandKind;
  status: 'rejected';
  error:
    | 'unsafe_command'
    | 'cwd_outside_allowed_roots'
    | 'unsupported_shell_syntax'
    | 'invalid_input'
    | 'full_suite_refused'
    | 'repeat_after_timeout';
  commandClass: CommandClass;
  reason: string;
  command: string;
  cwd: string;
  durationMs: number;
  message: string;
  retryHint?: string;
  scriptExpansion?: ScriptExpansion;
  previousTimeout?: PreviousTimeoutRecord;
}

export type RunCommandDetails = RunCommandSuccessDetails | RunCommandRejectedDetails;

export interface CommandToolFactoryOptions {
  allowedEnvKeys?: readonly string[];
  spawnFn?: RunCommandOptions['spawnFn'];
  cleanupTracker?: CleanupTracker;
  /**
   * HOK-3145: when true, a bare `npm test` / `pnpm test` / `yarn test`
   * invocation is executed instead of being refused. CI (which runs the full
   * suite) sets this; coding agents inside the mill do not.
   */
  allowFullSuite?: boolean;
  /**
   * In-session history keyed on `(tool, argv, cwd, fingerprint)` so an
   * identical repeat of a just-timed-out command is refused without executing.
   * `createCommandTools` creates one history shared across the pair.
   */
  history?: CommandRunHistory;
  /** Test seam: override the worktree fingerprint used by the repeat guard. */
  fingerprintFn?: (worktreePath: string) => string;
}

interface RunScopedCommandInput extends RunCommandParams {
  tool: RunCommandToolName;
  kind: RunCommandKind;
  worktreePath: string;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  allowedEnvKeys?: readonly string[];
  spawnFn?: RunCommandOptions['spawnFn'];
  signal?: AbortSignal;
  cleanupTracker?: CleanupTracker;
  allowFullSuite: boolean;
  history: CommandRunHistory;
  fingerprintFn: (worktreePath: string) => string;
}

interface AfterToolCallContext {
  toolCall: { name: string };
  result: { details: unknown };
}

/**
 * In-session timeout record keyed on `(tool, argv, cwd, fingerprint)`. A
 * single history is shared across `run_tests` and `run_format` so a dirty
 * repeat is refused even across the pair. The fingerprint allows a legitimate
 * "I changed the hanging test, re-run the same focused command" through: a
 * new tree → a new fingerprint → the record no longer matches.
 */
export class CommandRunHistory {
  private readonly records = new Map<string, PreviousTimeoutRecord & { fingerprint: string }>();

  recordTimeout(
    key: string,
    record: PreviousTimeoutRecord & { fingerprint: string },
  ): void {
    this.records.set(key, record);
  }

  findTimeout(key: string, fingerprint: string): PreviousTimeoutRecord | undefined {
    const record = this.records.get(key);
    if (!record) return undefined;
    if (record.fingerprint !== fingerprint) return undefined;
    return { durationMs: record.durationMs, timeoutMs: record.timeoutMs, at: record.at };
  }

  clear(key: string): void {
    this.records.delete(key);
  }
}

const runCommandParameters = {
  type: 'object',
  properties: {
    command: { type: 'string', minLength: 1 },
    cwd: { type: 'string' },
    timeoutMs: { type: 'integer', minimum: 1 },
    maxOutputBytes: { type: 'integer', minimum: 1 },
  },
  required: ['command'],
  additionalProperties: false,
};

/**
 * Create the structured `run_tests` tool for the coding phase.
 *
 * Commands execute inside `worktreePath` or one of its subdirectories and return
 * capped stdout/stderr plus execution metadata. Output is middle-truncated per
 * stream so both the leading setup and trailing failure summary are retained when
 * the captured output exceeds the requested byte budget.
 */
export function createRunTestsTool(
  worktreePath: string,
  options: CommandToolFactoryOptions = {},
): ToolDescriptor<RunCommandParams, RunCommandDetails> {
  const history = options.history ?? new CommandRunHistory();
  const fingerprintFn = options.fingerprintFn ?? defaultWorktreeFingerprint;
  const allowFullSuite = options.allowFullSuite === true;
  return {
    metadata: {
      name: 'run_tests',
      description:
        'Run focused test commands inside the active worktree, returning capped output and structured execution metadata. Commands run without a shell: shell operators, redirects and $-expansion are rejected; quoting follows POSIX rules; use cwd to change directory. Full-suite commands (npm test, pnpm test, yarn test, and unsharded tests/run-*.sh) are refused — use a focused selection such as `node --test <files>` or `bash tests/run-unit-tests.sh --shard i/n`. An identical command is refused on the next attempt if the previous run timed out, until the worktree changes.',
      class: 'read-only',
      allowedPhases: ['coding'],
      executionMode: 'sequential',
      outputCapPolicy: { strategy: 'truncate', maxBytes: DEFAULT_MAX_OUTPUT_BYTES },
    },
    parameters: runCommandParameters,
    async execute(_toolCallId, params, signal) {
      return runScopedCommand({
        ...params,
        tool: 'run_tests',
        kind: 'tests',
        worktreePath,
        defaultTimeoutMs: DEFAULT_TEST_TIMEOUT_MS,
        maxTimeoutMs: MAX_TEST_TIMEOUT_MS,
        allowedEnvKeys: options.allowedEnvKeys,
        spawnFn: options.spawnFn,
        signal,
        cleanupTracker: options.cleanupTracker,
        allowFullSuite,
        history,
        fingerprintFn,
      });
    },
  };
}

/**
 * Create the structured `run_format` tool for the coding phase.
 *
 * This tool uses the same command substrate as `run_tests` but is marked as a
 * mutation tool because formatters are expected to rewrite files under the
 * worktree.
 */
export function createRunFormatTool(
  worktreePath: string,
  options: CommandToolFactoryOptions = {},
): ToolDescriptor<RunCommandParams, RunCommandDetails> {
  const history = options.history ?? new CommandRunHistory();
  const fingerprintFn = options.fingerprintFn ?? defaultWorktreeFingerprint;
  return {
    metadata: {
      name: 'run_format',
      description:
        'Run a formatter or other scoped code-style command inside the active worktree, returning capped output and structured execution metadata. Commands are executed directly without a shell: shell operators, redirects and $-expansion are rejected; quoting follows POSIX rules; use cwd to change directory.',
      class: 'mutation',
      allowedPhases: ['coding'],
      executionMode: 'sequential',
      outputCapPolicy: { strategy: 'truncate', maxBytes: DEFAULT_MAX_OUTPUT_BYTES },
    },
    parameters: runCommandParameters,
    async execute(_toolCallId, params, signal) {
      return runScopedCommand({
        ...params,
        tool: 'run_format',
        kind: 'format',
        worktreePath,
        defaultTimeoutMs: DEFAULT_FORMAT_TIMEOUT_MS,
        maxTimeoutMs: MAX_FORMAT_TIMEOUT_MS,
        allowedEnvKeys: options.allowedEnvKeys,
        spawnFn: options.spawnFn,
        signal,
        cleanupTracker: options.cleanupTracker,
        allowFullSuite: true, // run_format never classifies as "full suite"; this is a no-op for format.
        history,
        fingerprintFn,
      });
    },
  };
}

/**
 * Create both structured command tools for a worktree. A shared
 * CommandRunHistory survives for the life of the descriptors so the repeat
 * guard sees timeouts across both tools (and the no-completion recovery turn).
 */
export function createCommandTools(
  worktreePath: string,
  options: CommandToolFactoryOptions = {},
): readonly ToolDescriptor<RunCommandParams, RunCommandDetails>[] {
  const sharedHistory = options.history ?? new CommandRunHistory();
  const sharedOptions: CommandToolFactoryOptions = { ...options, history: sharedHistory };
  return [createRunTestsTool(worktreePath, sharedOptions), createRunFormatTool(worktreePath, sharedOptions)];
}

/**
 * Treat rejected command-tool calls as loop errors while allowing failing test
 * exits and timeouts to remain usable results.
 */
export async function commandToolsAfterToolCall(
  context: AfterToolCallContext,
): Promise<{ isError?: boolean } | undefined> {
  if (context.toolCall.name !== 'run_tests' && context.toolCall.name !== 'run_format') {
    return undefined;
  }

  const details = context.result.details as RunCommandDetails | undefined;
  if (!details || typeof details !== 'object' || !('ok' in details)) {
    return undefined;
  }
  return details.ok ? undefined : { isError: true };
}

/**
 * Execute a scoped command through the native command substrate.
 *
 * `stdoutMeta.originalByteLength` and `stderrMeta.originalByteLength` describe
 * the bytes captured by the substrate before this wrapper's middle-truncation
 * pass. For extremely large output, the substrate may already have dropped the
 * true tail before this function sees it.
 */
export async function runScopedCommand(
  input: RunScopedCommandInput,
): Promise<WavemillToolResult<RunCommandDetails>> {
  const startedAt = Date.now();
  const normalizedCommand = typeof input.command === 'string' ? input.command.trim() : '';
  const commandClass = classifyCommand(normalizedCommand).commandClass;
  const effectiveCwd = input.cwd ?? input.worktreePath;

  if (typeof input.command !== 'string' || normalizedCommand.length === 0) {
    return rejectedResult({
      ok: false,
      tool: input.tool,
      kind: input.kind,
      status: 'rejected',
      error: 'invalid_input',
      commandClass,
      reason: 'empty-command',
      command: normalizedCommand,
      cwd: effectiveCwd,
      durationMs: Date.now() - startedAt,
      message: 'command must be a non-empty string.',
      retryHint: 'Provide a concrete test or format command and retry.',
    });
  }

  if (input.cwd !== undefined && (typeof input.cwd !== 'string' || input.cwd.trim().length === 0)) {
    return rejectedResult({
      ok: false,
      tool: input.tool,
      kind: input.kind,
      status: 'rejected',
      error: 'invalid_input',
      commandClass,
      reason: 'invalid-cwd',
      command: normalizedCommand,
      cwd: typeof input.cwd === 'string' ? input.cwd : input.worktreePath,
      durationMs: Date.now() - startedAt,
      message: 'cwd must be a non-empty string when provided.',
      retryHint: 'Use the worktree root or a subdirectory inside it.',
    });
  }

  if (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs <= 0)) {
    return rejectedResult({
      ok: false,
      tool: input.tool,
      kind: input.kind,
      status: 'rejected',
      error: 'invalid_input',
      commandClass,
      reason: 'invalid-timeout',
      command: normalizedCommand,
      cwd: effectiveCwd,
      durationMs: Date.now() - startedAt,
      message: 'timeoutMs must be a positive integer.',
      retryHint: 'Use a positive integer timeout in milliseconds.',
    });
  }

  if (input.maxOutputBytes !== undefined && (!Number.isInteger(input.maxOutputBytes) || input.maxOutputBytes <= 0)) {
    return rejectedResult({
      ok: false,
      tool: input.tool,
      kind: input.kind,
      status: 'rejected',
      error: 'invalid_input',
      commandClass,
      reason: 'invalid-max-output-bytes',
      command: normalizedCommand,
      cwd: effectiveCwd,
      durationMs: Date.now() - startedAt,
      message: 'maxOutputBytes must be a positive integer.',
      retryHint: 'Use a positive integer byte limit.',
    });
  }

  // Parse argv so the full-suite classifier and script expansion can look at
  // structured tokens. A parse failure falls through; the substrate will
  // reject with the existing `unsupported_shell_syntax` details.
  const parsed = parseCommandArgv(normalizedCommand);
  let scriptExpansion: ScriptExpansion | undefined;
  let repeatKeyArgv: string[] | null = null;
  if (parsed.ok) {
    repeatKeyArgv = parsed.argv;
    const invocation = resolvePackageScriptInvocation(parsed.argv);
    if (invocation) {
      scriptExpansion = readScriptExpansion({
        manager: invocation.manager,
        script: invocation.script,
        extraArgs: invocation.extraArgs,
        cwd: effectiveCwd,
        worktreePath: input.worktreePath,
        ...(invocation.prefix ? { prefix: invocation.prefix } : {}),
      });
    }

    if (input.kind === 'tests') {
      const scope = classifyTestCommandScope(parsed.argv, {
        cwd: effectiveCwd,
        worktreePath: input.worktreePath,
      });
      if (scope.scope === 'full-suite' && !input.allowFullSuite) {
        const expansion = scope.expansion ?? scriptExpansion;
        const expansionText = expansion ? formatScriptExpansion(expansion) : null;
        const summary = expansionText ? ` (${expansionText.split('\n')[0]})` : '';
        const parts = [
          `Refused: \`${normalizedCommand}\` runs the full repository suite${summary}, which exceeds the run_tests time limit. Run focused tests instead.`,
        ];
        if (expansionText) parts.push(expansionText);
        return rejectedResult({
          ok: false,
          tool: input.tool,
          kind: input.kind,
          status: 'rejected',
          error: 'full_suite_refused',
          commandClass,
          reason: scope.reason === 'package-test-script' ? 'full-suite-command' : 'full-suite-repo-runner',
          command: normalizedCommand,
          cwd: effectiveCwd,
          durationMs: Date.now() - startedAt,
          message: parts.join('\n'),
          retryHint: FOCUSED_TEST_GUIDANCE,
          ...(expansion ? { scriptExpansion: expansion } : {}),
        });
      }
    }
  }

  // Repeat-after-timeout guard. Key excludes timeoutMs/maxOutputBytes so the
  // agent cannot bypass the refusal by raising its own timeout.
  const fingerprint = parsed.ok && repeatKeyArgv ? input.fingerprintFn(input.worktreePath) : '';
  const repeatKey = parsed.ok && repeatKeyArgv ? makeRepeatKey(input.tool, repeatKeyArgv, effectiveCwd) : null;
  if (repeatKey) {
    const previousTimeout = input.history.findTimeout(repeatKey, fingerprint);
    if (previousTimeout) {
      const seconds = Math.round(previousTimeout.durationMs / 1000);
      return rejectedResult({
        ok: false,
        tool: input.tool,
        kind: input.kind,
        status: 'rejected',
        error: 'repeat_after_timeout',
        commandClass,
        reason: 'identical-command-timed-out',
        command: normalizedCommand,
        cwd: effectiveCwd,
        durationMs: Date.now() - startedAt,
        message: `Refused: the previous identical run timed out after ${seconds}s; narrow the selection (run fewer files or a single test) or change the code before re-running.`,
        retryHint: FOCUSED_TEST_GUIDANCE,
        previousTimeout,
        ...(scriptExpansion ? { scriptExpansion } : {}),
      });
    }
  }

  // Clamp the timeout. Agents can supply any `timeoutMs`, so without a
  // ceiling the full-suite guard can be stretched past 10 min.
  const requestedTimeoutMs = input.timeoutMs;
  const effectiveTimeoutMs = Math.min(requestedTimeoutMs ?? input.defaultTimeoutMs, input.maxTimeoutMs);
  const clamped = requestedTimeoutMs !== undefined && requestedTimeoutMs > input.maxTimeoutMs;

  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const result = await runCommand({
    command: normalizedCommand,
    cwd: effectiveCwd,
    allowedRoots: [input.worktreePath],
    timeoutMs: effectiveTimeoutMs,
    maxOutputBytes: internalCap(maxOutputBytes),
    allowedEnvKeys: input.allowedEnvKeys,
    spawnFn: input.spawnFn,
    signal: input.signal,
    onSpawn: (child) => input.cleanupTracker?.registerProcess(child),
  });

  if (result.approval === 'rejected') {
    const details: RunCommandRejectedDetails = {
      ok: false,
      tool: input.tool,
      kind: input.kind,
      status: 'rejected',
      error: mapRejectionToError(result.rejectionReason),
      commandClass: result.commandClass,
      reason: result.rejectionReason ?? 'command-rejected',
      command: normalizedCommand,
      cwd: effectiveCwd,
      durationMs: result.durationMs,
      message: rejectionMessage(result.rejectionReason, result.rejectionDetail),
      retryHint: rejectionRetryHint(result.rejectionReason),
    };
    return rejectedResult(details);
  }

  const stdoutStripped = stripSubstrateTruncationMarker(result.stdout);
  const stderrStripped = stripSubstrateTruncationMarker(result.stderr);
  const stdout = middleTruncateUtf8(stdoutStripped.text, maxOutputBytes);
  const stderr = middleTruncateUtf8(stderrStripped.text, maxOutputBytes);
  const details: RunCommandSuccessDetails = {
    ok: true,
    tool: input.tool,
    kind: input.kind,
    status: result.timedOut ? 'timed_out' : 'completed',
    commandClass: result.commandClass,
    approval: result.approval,
    command: normalizedCommand,
    cwd: effectiveCwd,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutMeta: {
      originalByteLength: stdout.originalByteLength,
      truncated: stdoutStripped.substrateTruncated || stdout.truncated,
    },
    stderrMeta: {
      originalByteLength: stderr.originalByteLength,
      truncated: stderrStripped.substrateTruncated || stderr.truncated,
    },
    truncated: result.truncated || stdout.truncated || stderr.truncated,
    effectiveTimeoutMs,
    ...(requestedTimeoutMs !== undefined ? { requestedTimeoutMs } : {}),
    ...(scriptExpansion ? { scriptExpansion } : {}),
  };

  // History bookkeeping — record timeouts, clear completed runs.
  if (repeatKey) {
    if (result.timedOut) {
      input.history.recordTimeout(repeatKey, {
        durationMs: result.durationMs,
        timeoutMs: effectiveTimeoutMs,
        at: new Date().toISOString(),
        fingerprint,
      });
    } else {
      input.history.clear(repeatKey);
    }
  }

  return {
    content: [{ type: 'text', text: summarizeResult(details, { clamped }) }],
    details,
    metadata: { trust: buildTrustMetadata({ sourceKind: 'command_output', details }) },
  };
}

function makeRepeatKey(tool: RunCommandToolName, argv: readonly string[], cwd: string): string {
  const canonicalArgv = argv.join('\u0000');
  return createHash('sha256').update(`${tool}\u0001${canonicalArgv}\u0001${cwd}`).digest('hex');
}

function rejectedResult(details: RunCommandRejectedDetails): WavemillToolResult<RunCommandDetails> {
  return {
    content: [{ type: 'text', text: details.message }],
    details,
    metadata: {
      trust: buildTrustMetadata({
        sourceKind: 'command_output',
        content: [{ type: 'text', text: details.message }],
        details,
      }),
    },
  };
}

function summarizeResult(details: RunCommandSuccessDetails, extras: { clamped: boolean }): string {
  const lines: string[] = [];
  if (details.status === 'timed_out') {
    lines.push(`${details.tool} timed out after ${details.durationMs}ms in ${details.cwd}.`);
    lines.push('An identical command will be refused until the worktree changes; narrow the selection or change the code before re-running.');
  } else {
    const exitCodeText = details.exitCode === null ? 'null' : String(details.exitCode);
    lines.push(`${details.tool} completed in ${details.durationMs}ms with exit code ${exitCodeText} in ${details.cwd}.`);
  }
  if (details.scriptExpansion) {
    lines.push(formatScriptExpansion(details.scriptExpansion));
  }
  if (extras.clamped && details.requestedTimeoutMs !== undefined) {
    lines.push(`(timeoutMs clamped from ${details.requestedTimeoutMs} to ${details.effectiveTimeoutMs})`);
  }
  return lines.join('\n');
}

function mapRejectionToError(
  rejectionReason: RejectionReason | string | undefined,
): RunCommandRejectedDetails['error'] {
  if (rejectionReason === 'cwd-outside-allowed-roots') {
    return 'cwd_outside_allowed_roots';
  }
  if (rejectionReason === 'dangerous-command-pattern') {
    return 'unsafe_command';
  }
  if (rejectionReason === 'unsupported-shell-syntax') {
    return 'unsupported_shell_syntax';
  }
  if (rejectionReason === 'empty-command') {
    return 'invalid_input';
  }
  return 'invalid_input';
}

function rejectionMessage(rejectionReason: RejectionReason | string | undefined, detail?: string): string {
  if (rejectionReason === 'cwd-outside-allowed-roots') {
    return 'Command cwd must stay inside the active worktree.';
  }
  if (rejectionReason === 'dangerous-command-pattern') {
    return 'Command was rejected by the native safety classifier.';
  }
  if (rejectionReason === 'empty-command') {
    return 'command must be a non-empty string.';
  }
  if (rejectionReason === 'unsupported-shell-syntax') {
    const suffix = detail ? ` (offending token: "${detail}").` : '.';
    return `Command rejected: shell operators and expansions are not supported because commands run without a shell${suffix}`;
  }
  return 'Command could not be executed due to invalid input.';
}

function rejectionRetryHint(rejectionReason: RejectionReason | string | undefined): string | undefined {
  if (rejectionReason === 'cwd-outside-allowed-roots') {
    return 'Retry with the worktree root or a subdirectory inside it.';
  }
  if (rejectionReason === 'dangerous-command-pattern') {
    return 'Retry with a safer scoped test or formatter command.';
  }
  if (rejectionReason === 'empty-command') {
    return 'Provide a concrete command and retry.';
  }
  if (rejectionReason === 'unsupported-shell-syntax') {
    return 'Run one program per call, pass the cwd parameter instead of "cd ... &&", and quote arguments as for a POSIX shell. Pipes, redirects, &&, ||, ;, $VAR and backticks are not supported.';
  }
  return undefined;
}

function internalCap(callerMaxBytes: number): number {
  return Math.max(callerMaxBytes * INTERNAL_CAP_MULTIPLIER, INTERNAL_CAP_FLOOR_BYTES);
}

function stripSubstrateTruncationMarker(text: string): { text: string; substrateTruncated: boolean } {
  if (text.endsWith(`\n${SUBSTRATE_TRUNCATION_MARKER}`)) {
    return {
      text: text.slice(0, -(`\n${SUBSTRATE_TRUNCATION_MARKER}`.length)),
      substrateTruncated: true,
    };
  }
  if (text.endsWith(SUBSTRATE_TRUNCATION_MARKER)) {
    return {
      text: text.slice(0, -SUBSTRATE_TRUNCATION_MARKER.length).trimEnd(),
      substrateTruncated: true,
    };
  }
  return { text, substrateTruncated: false };
}

function middleTruncateUtf8(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean; originalByteLength: number } {
  const originalByteLength = Buffer.byteLength(text, 'utf8');
  if (originalByteLength <= maxBytes) {
    return { text, truncated: false, originalByteLength };
  }
  if (maxBytes <= 0) {
    return { text: '', truncated: true, originalByteLength };
  }

  const fallback = truncateUtf8(text, maxBytes);
  const minimumMarker = makeMiddleTruncationMarker(0);
  if (Buffer.byteLength(minimumMarker, 'utf8') >= maxBytes) {
    return { text: fallback, truncated: true, originalByteLength };
  }

  let headBudget = Math.floor((maxBytes - Buffer.byteLength(minimumMarker, 'utf8')) / 2);
  let tailBudget = maxBytes - Buffer.byteLength(minimumMarker, 'utf8') - headBudget;

  for (let iteration = 0; iteration < 4; iteration += 1) {
    const head = truncateUtf8(text, headBudget);
    const tail = sliceUtf8Tail(text, tailBudget);
    const retainedBytes = Buffer.byteLength(head, 'utf8') + Buffer.byteLength(tail, 'utf8');
    const marker = makeMiddleTruncationMarker(Math.max(originalByteLength - retainedBytes, 0));
    const markerBytes = Buffer.byteLength(marker, 'utf8');
    if (retainedBytes + markerBytes <= maxBytes) {
      return { text: `${head}${marker}${tail}`, truncated: true, originalByteLength };
    }

    const remaining = Math.max(maxBytes - markerBytes, 0);
    headBudget = Math.floor(remaining / 2);
    tailBudget = remaining - headBudget;
  }

  return { text: fallback, truncated: true, originalByteLength };
}

function sliceUtf8Tail(text: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return '';
  }
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return text;
  }

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (Buffer.byteLength(text.slice(mid), 'utf8') <= maxBytes) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }
  return text.slice(low);
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return '';
  }
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return text;
  }

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return text.slice(0, low);
}

function makeMiddleTruncationMarker(droppedBytes: number): string {
  return `\n...[truncated ${droppedBytes} bytes from the middle]...\n`;
}
