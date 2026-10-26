import { realpathSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import type { CommandClass } from './command-classifier.ts';
import { classifyCommand } from './command-classifier.ts';
import { parseCommandArgv } from './command-argv.ts';
import {
  FOREGROUND_WAIT_GUARD,
  classifyForegroundWait,
  describeWaitGuardRefusal,
} from './command-wait-guard.ts';
import { buildCommandTranscript } from './command-transcript.ts';
import type { TranscriptWriter } from './transcript.ts';
import type { ApprovalGateFn } from './workflow-tools/approval-gate.ts';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const KILL_GRACE_MS = 2_000;
const DEFAULT_ENV_KEYS = ['PATH', 'HOME', 'LANG'] as const;

export type ApprovalOutcome = 'approved' | 'rejected' | 'approval_needed';

export type RejectionReason =
  | 'empty-command'
  | 'unsupported-shell-syntax'
  | 'dangerous-command-pattern'
  | 'cwd-outside-allowed-roots'
  | 'approval-denied'
  | 'approval-expired'
  | 'foreground-wait-refused';

export interface CommandApprovalNeededMetadata {
  requestId: string;
  riskReason: string;
  argSummary: string;
  expiresAt: number;
}

export interface RunCommandOptions {
  command: string | readonly string[];
  cwd: string;
  allowedRoots: readonly string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  allowedEnvKeys?: readonly string[];
  redactValues?: readonly string[];
  shell?: boolean;
  spawnFn?: typeof spawn;
  signal?: AbortSignal;
  toolName?: string;
  transcriptWriter?: Pick<TranscriptWriter, 'writeCommandEvent'>;
  /**
   * Optional human-approval gate (HOK-2364).
   *
   * Evaluated after command safety checks pass, before spawning the process.
   * When the gate returns a non-proceeding decision the command is paused or
   * blocked. Risk classification is caller-provided.
   */
  approvalGate?: ApprovalGateFn;
  /** Session identifier forwarded to the approval gate. */
  sessionId?: string;
  /** Sanitized argument summary forwarded to the gate (no secrets). */
  argSummary?: string;
  onSpawn?: (child: ChildProcess) => void;
}

export interface CommandResult {
  commandClass: CommandClass;
  approval: ApprovalOutcome;
  rejectionReason?: RejectionReason | string;
  rejectionDetail?: string;
  /** Named guard that refused the command (e.g. 'foreground-wait'). */
  guard?: string;
  /** Present when approval === 'approval_needed'. */
  approvalNeeded?: CommandApprovalNeededMetadata;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

export function resolveAllowedCwd(
  cwd: string,
  allowedRoots: readonly string[],
): { kind: 'inside'; resolved: string } | { kind: 'outside' } {
  try {
    const resolvedCwd = realpathSync(cwd);
    for (const root of allowedRoots) {
      const resolvedRoot = realpathSync(root);
      if (resolvedCwd === resolvedRoot) {
        return { kind: 'inside', resolved: resolvedCwd };
      }
      const relative = path.relative(resolvedRoot, resolvedCwd);
      if (relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        return { kind: 'inside', resolved: resolvedCwd };
      }
    }
  } catch {
    return { kind: 'outside' };
  }

  return { kind: 'outside' };
}

export function buildChildEnv(
  allowedEnvKeys: readonly string[] | undefined,
  parentEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const allowlist = new Set<string>(DEFAULT_ENV_KEYS);
  for (const key of allowedEnvKeys ?? []) {
    if (key.trim().length > 0) {
      allowlist.add(key);
    }
  }
  for (const key of allowlist) {
    const value = parentEnv[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Run a command through the shared native-agent command substrate.
 */
export async function runCommand(options: RunCommandOptions): Promise<CommandResult> {
  const timeoutMs = validatePositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');
  const maxOutputBytes = validatePositiveInteger(
    options.maxOutputBytes,
    DEFAULT_MAX_OUTPUT_BYTES,
    'maxOutputBytes',
  );

  if (typeof options.cwd !== 'string' || options.cwd.trim().length === 0) {
    throw new Error('cwd is required.');
  }
  if (!Array.isArray(options.allowedRoots) || options.allowedRoots.length === 0) {
    throw new Error('allowedRoots must contain at least one root.');
  }

  const startedAt = Date.now();
  const classification = classifyCommand(options.command);
  if (classification.commandClass === 'dangerous') {
    return rejectionResult(
      options,
      classification.commandClass,
      classification.rejectionReason ?? 'dangerous-command-pattern',
      startedAt,
      classification.normalizedCommand,
    );
  }

  let commandClass = classification.commandClass;
  let spawnCommand: readonly string[] | string = options.command;
  if (typeof options.command === 'string' && options.shell !== true) {
    const parsed = parseCommandArgv(options.command);
    if (!parsed.ok) {
      return rejectionResult(
        options,
        commandClass,
        parsed.reason,
        startedAt,
        classification.normalizedCommand,
        parsed.detail,
      );
    }
    const argvClassification = classifyCommand(parsed.argv);
    if (argvClassification.commandClass === 'dangerous') {
      return rejectionResult(
        options,
        argvClassification.commandClass,
        argvClassification.rejectionReason ?? 'dangerous-command-pattern',
        startedAt,
        classification.normalizedCommand,
      );
    }
    commandClass = argvClassification.commandClass;
    spawnCommand = parsed.argv;
  }

  // HOK-3262: refuse foreground waits (sleep/watch/timeout tail -f) on the
  // exec argv. Shell-mode strings are not tokenized and are not guarded.
  if (typeof spawnCommand !== 'string') {
    const waitDecision = classifyForegroundWait(spawnCommand);
    if (waitDecision.refused) {
      return rejectionResult(
        options,
        commandClass,
        'foreground-wait-refused',
        startedAt,
        classification.normalizedCommand,
        describeWaitGuardRefusal(waitDecision),
        FOREGROUND_WAIT_GUARD,
      );
    }
  }

  const cwdResolution = resolveAllowedCwd(options.cwd, options.allowedRoots);
  if (cwdResolution.kind === 'outside') {
    return rejectionResult(
      options,
      commandClass,
      'cwd-outside-allowed-roots',
      startedAt,
      classification.normalizedCommand,
    );
  }

  // Check approval gate before spawning (HOK-2364).
  if (options.approvalGate) {
    const sessionId = options.sessionId ?? '';
    const argSummary = options.argSummary ?? `${options.toolName ?? 'command'}:${commandClass}`;
    const decision = await options.approvalGate({
      sessionId,
      tool: options.toolName ?? 'command',
      action: commandClass,
      argSummary,
    });

    if (!decision.proceed) {
      const durationMs = Date.now() - startedAt;
      if (decision.outcome === 'approval_needed') {
        return {
          commandClass,
          approval: 'approval_needed',
          approvalNeeded: {
            requestId: decision.requestId,
            riskReason: decision.riskReason,
            argSummary: decision.argSummary,
            expiresAt: decision.expiresAt,
          },
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: '',
          truncated: false,
          timedOut: false,
          durationMs,
        };
      }
      // denied or expired — treat as rejection
      return rejectionResult(
        options,
        commandClass,
        decision.outcome === 'denied' ? 'approval-denied' : 'approval-expired',
        startedAt,
        classification.normalizedCommand,
      );
    }
  }

  const env = buildChildEnv(options.allowedEnvKeys, process.env);
  const spawnFn = options.spawnFn ?? spawn;
  const spawnSpec = buildSpawnSpec(spawnCommand, options.shell === true);
  const spawnOptions: SpawnOptions = {
    cwd: cwdResolution.resolved,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  };

  const child = spawnFn(spawnSpec.file, spawnSpec.args, spawnOptions);
  options.onSpawn?.(child);
  return await waitForProcess({
    child,
    command: classification.normalizedCommand,
    commandClass,
    maxOutputBytes,
    timeoutMs,
    cwd: cwdResolution.resolved,
    env,
    redactValues: options.redactValues,
    signal: options.signal,
    startedAt,
    toolName: options.toolName,
    transcriptWriter: options.transcriptWriter,
  });
}

function validatePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function rejectionResult(
  options: RunCommandOptions,
  commandClass: CommandClass,
  rejectionReason: RejectionReason,
  startedAt: number,
  normalizedCommand: string,
  rejectionDetail?: string,
  guard?: string,
): CommandResult {
  const durationMs = Date.now() - startedAt;
  const built = buildCommandTranscript({
    toolName: options.toolName,
    command: normalizedCommand,
    commandClass,
    approval: 'rejected',
    cwd: options.cwd,
    env: {},
    redactValues: options.redactValues,
    durationMs,
    exitCode: null,
    signal: null,
    timedOut: false,
    rejectionReason,
    guard,
    stdout: '',
    stderr: '',
    maxOutputBytes: validatePositiveInteger(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 'maxOutputBytes'),
  });
  options.transcriptWriter?.writeCommandEvent(built.event);
  return {
    commandClass,
    approval: 'rejected',
    rejectionReason,
    rejectionDetail,
    ...(guard ? { guard } : {}),
    exitCode: null,
    signal: null,
    stdout: built.stdout,
    stderr: built.stderr,
    truncated: built.truncated,
    timedOut: false,
    durationMs,
  };
}

function buildSpawnSpec(command: string | readonly string[], shell: boolean): { file: string; args: string[] } {
  if (typeof command === 'string') {
    if (shell) {
      return {
        file: '/bin/sh',
        args: ['-c', command],
      };
    }
    throw new Error('string commands must be tokenized before exec-form spawn.');
  }

  if (command.length === 0) {
    throw new Error('command must not be empty.');
  }
  return {
    file: command[0]!,
    args: command.slice(1) as string[],
  };
}

function waitForProcess(input: {
  child: ChildProcess;
  command: string;
  commandClass: CommandClass;
  maxOutputBytes: number;
  timeoutMs: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
  redactValues?: readonly string[];
  signal?: AbortSignal;
  startedAt: number;
  toolName?: string;
  transcriptWriter?: Pick<TranscriptWriter, 'writeCommandEvent'>;
}): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      input.child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        input.child.kill('SIGKILL');
      }, KILL_GRACE_MS);
    }, input.timeoutMs);

    const abortHandler = () => {
      timedOut = true;
      input.child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        input.child.kill('SIGKILL');
      }, KILL_GRACE_MS);
    };

    if (input.signal) {
      if (input.signal.aborted) {
        abortHandler();
      } else {
        input.signal.addEventListener('abort', abortHandler, { once: true });
      }
    }

    input.child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunkToString(chunk);
    });

    input.child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunkToString(chunk);
    });

    input.child.on('error', (error) => {
      stderr += error.message;
    });

    input.child.on('close', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      finalize();
    });

    function finalize(): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      if (input.signal) {
        input.signal.removeEventListener('abort', abortHandler);
      }

      const built = buildCommandTranscript({
        toolName: input.toolName,
        command: input.command,
        commandClass: input.commandClass,
        approval: 'approved',
        cwd: input.cwd,
        env: input.env,
        redactValues: input.redactValues,
        durationMs: Date.now() - input.startedAt,
        exitCode,
        signal: exitSignal,
        timedOut,
        stdout,
        stderr,
        maxOutputBytes: input.maxOutputBytes,
      });
      input.transcriptWriter?.writeCommandEvent(built.event);
      const result: CommandResult = {
        commandClass: input.commandClass,
        approval: 'approved',
        exitCode,
        signal: exitSignal,
        stdout: built.stdout,
        stderr: built.stderr,
        truncated: built.truncated,
        timedOut,
        durationMs: built.event.durationMs,
      };

      resolve(result);
    }
  });
}

function chunkToString(chunk: Buffer | string): string {
  return typeof chunk === 'string' ? chunk : chunk.toString('utf8');
}
