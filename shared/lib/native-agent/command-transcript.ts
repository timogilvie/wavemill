import type { CommandClass } from './command-classifier.ts';
import { redactSecrets } from './tools/redaction.ts';

export const COMMAND_TRANSCRIPT_REDACTION_MARKER = '«redacted»';
const OUTPUT_TRUNCATION_MARKER = '[output truncated]';
const SECRET_ENV_KEY_PATTERN = /(auth|bearer|credential|key|pass|secret|token)/i;

export type CommandApprovalOutcome = 'approved' | 'rejected';

export interface CommandTranscriptRedactionSummary {
  marker: string;
  command: boolean;
  env: boolean;
  stdout: boolean;
  stderr: boolean;
}

export interface CommandTranscriptStream {
  text: string;
  originalBytes: number;
  retainedBytes: number;
  truncated: boolean;
  redacted: boolean;
}

export interface CommandTranscriptEventData {
  type: 'command_result';
  toolName: string;
  commandClass: CommandClass;
  approval: CommandApprovalOutcome;
  command: string;
  cwd: string;
  env: Record<string, string>;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  rejectionReason?: string;
  /** Named guard that refused the command (e.g. 'foreground-wait'). */
  guard?: string;
  stdout: string;
  stderr: string;
  truncation: {
    stdout: CommandTranscriptStream;
    stderr: CommandTranscriptStream;
  };
  redaction: CommandTranscriptRedactionSummary;
}

export interface BuildCommandTranscriptInput {
  toolName?: string;
  command: string | readonly string[];
  commandClass: CommandClass;
  approval: CommandApprovalOutcome;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  redactValues?: readonly string[];
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  rejectionReason?: string;
  guard?: string;
  stdout?: string;
  stderr?: string;
  maxOutputBytes: number;
}

export interface BuiltCommandTranscript {
  event: CommandTranscriptEventData;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export function buildCommandTranscript(input: BuildCommandTranscriptInput): BuiltCommandTranscript {
  const commandResult = redactCommandText(normalizeCommand(input.command), input.redactValues);
  const envResult = redactEnvSnapshot(input.env, input.redactValues);
  const stdoutResult = buildStream(input.stdout ?? '', input.maxOutputBytes, input.redactValues);
  const stderrResult = buildStream(input.stderr ?? '', input.maxOutputBytes, input.redactValues);

  const event: CommandTranscriptEventData = {
    type: 'command_result',
    toolName: input.toolName ?? 'command',
    commandClass: input.commandClass,
    approval: input.approval,
    command: commandResult.text,
    cwd: input.cwd,
    env: envResult.env,
    durationMs: input.durationMs,
    exitCode: input.exitCode,
    signal: input.signal,
    timedOut: input.timedOut,
    stdout: stdoutResult.text,
    stderr: stderrResult.text,
    truncation: {
      stdout: stdoutResult,
      stderr: stderrResult,
    },
    redaction: {
      marker: COMMAND_TRANSCRIPT_REDACTION_MARKER,
      command: commandResult.redacted,
      env: envResult.redacted,
      stdout: stdoutResult.redacted,
      stderr: stderrResult.redacted,
    },
  };
  if (input.rejectionReason !== undefined) {
    event.rejectionReason = input.rejectionReason;
  }
  if (input.guard !== undefined) {
    event.guard = input.guard;
  }

  return {
    event,
    stdout: stdoutResult.text,
    stderr: stderrResult.text,
    truncated: stdoutResult.truncated || stderrResult.truncated,
  };
}

function normalizeCommand(command: string | readonly string[]): string {
  return typeof command === 'string' ? command.trim() : command.join(' ').trim();
}

function redactCommandText(text: string, redactValues?: readonly string[]): { text: string; redacted: boolean } {
  const withLiterals = applyLiteralRedactions(text, redactValues);
  const secrets = redactSecrets(withLiterals.text, { placeholder: COMMAND_TRANSCRIPT_REDACTION_MARKER });
  return {
    text: secrets.text,
    redacted: withLiterals.redacted || secrets.redacted,
  };
}

function redactEnvSnapshot(
  env: NodeJS.ProcessEnv | undefined,
  redactValues?: readonly string[],
): { env: Record<string, string>; redacted: boolean } {
  const redactedEnv: Record<string, string> = {};
  let anyRedacted = false;
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value === undefined) {
      continue;
    }
    if (SECRET_ENV_KEY_PATTERN.test(key)) {
      redactedEnv[key] = COMMAND_TRANSCRIPT_REDACTION_MARKER;
      anyRedacted = true;
      continue;
    }
    const redactedValue = redactCommandText(value, redactValues);
    redactedEnv[key] = redactedValue.text;
    anyRedacted = anyRedacted || redactedValue.redacted;
  }
  return { env: redactedEnv, redacted: anyRedacted };
}

function buildStream(
  text: string,
  maxOutputBytes: number,
  redactValues?: readonly string[],
): CommandTranscriptStream {
  const originalBytes = Buffer.byteLength(text, 'utf8');
  const redacted = redactCommandText(text, redactValues);
  const { text: retainedText, truncated } = truncateOutput(redacted.text, maxOutputBytes);
  return {
    text: retainedText,
    originalBytes,
    retainedBytes: Buffer.byteLength(retainedText, 'utf8'),
    truncated,
    redacted: redacted.redacted,
  };
}

function truncateOutput(text: string, maxOutputBytes: number): { text: string; truncated: boolean } {
  const originalBytes = Buffer.byteLength(text, 'utf8');
  if (originalBytes <= maxOutputBytes) {
    return { text, truncated: false };
  }

  const retained = truncateUtf8(text, maxOutputBytes);
  const withMarker = retained.endsWith(OUTPUT_TRUNCATION_MARKER)
    ? retained
    : `${retained}${retained.length > 0 ? '\n' : ''}${OUTPUT_TRUNCATION_MARKER}`;
  return { text: withMarker, truncated: true };
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return '';
  }
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength <= maxBytes) {
    return text;
  }
  return buffer.subarray(0, maxBytes).toString('utf8');
}

function applyLiteralRedactions(
  text: string,
  redactValues?: readonly string[],
): { text: string; redacted: boolean } {
  let next = text;
  let redacted = false;
  for (const value of redactValues ?? []) {
    if (value.trim().length === 0) {
      continue;
    }
    if (next.includes(value)) {
      redacted = true;
      next = next.split(value).join(COMMAND_TRANSCRIPT_REDACTION_MARKER);
    }
  }
  return { text: next, redacted };
}
