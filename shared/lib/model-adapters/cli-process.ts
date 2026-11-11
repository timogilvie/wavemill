/**
 * Shared CLI process runner for the CLI model transports (HOK-3460).
 *
 * Every `claude -p` / `codex exec` invocation runs through
 * {@link runCliProcess}, which owns the process facts: spawn, stdin, timeout,
 * activity timeout, abort and slow-call notifications. It returns one tuple —
 * `{stdout, stderr, exitCode, elapsedMs}` — for both `sync` and `stream`
 * modes, so the adapters have a single `parseResult` path.
 *
 * It throws only for failures with no output to interpret: spawn failure,
 * timeout, inactivity timeout and abort. A non-zero exit is returned; the
 * adapter classifies it from the tuple (or, in sync mode, from the actionable
 * diagnostics this module attaches as `failureMessage`).
 *
 * @module model-adapters/cli-process
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { escapeShellArg, execShellCommand } from '../shell-utils.ts';
import { classifyCliMessage, retryPolicyFor } from './cli-error-classifier.ts';

export const DEFAULT_CLI_TIMEOUT_MS = 120_000; // 2 minutes
export const DEFAULT_CLI_MAX_BUFFER = 10 * 1024 * 1024; // 10MB
export const SLOW_CALL_WARNING_MS = 30_000;
export const SLOW_CALL_REPEAT_MS = 15_000;

export type CliProcessMode = 'sync' | 'stream';

export interface CliProcessOptions {
  /**
   * Transport label used in user-facing diagnostics, e.g. `claude` or
   * `codex`. Produces the historic `<label> CLI <failure>` text.
   */
  label: string;
  /** Resolved CLI executable. */
  cmd: string;
  /** Full argv (without the executable). */
  args: string[];
  /** Prompt delivered on stdin (stream) or via a temp file (sync). */
  stdin: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** `sync` blocks on `execSync`; `stream` uses `spawn`. Default `stream`. */
  mode?: CliProcessMode;
  /** Hard wall-clock cap in ms. */
  timeout?: number;
  /** Inactivity cap in ms (stream only): resets whenever output arrives. */
  activityTimeout?: number;
  /** stdout/stderr buffer cap in bytes (sync only). */
  maxBuffer?: number;
  signal?: AbortSignal;
  /** Fired periodically once a call has run longer than the slow threshold. */
  onSlow?: (elapsedMs: number) => void;
}

export interface CliProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  elapsedMs: number;
  /**
   * Sync-mode actionable diagnostics for a non-zero exit (auth, quota,
   * buffer). Absent when the generic exit message should be used.
   */
  failureMessage?: string;
}

function syncFailureMessage(input: {
  label: string;
  command: string;
  cwd: string;
  cliCmd: string;
  timeout: number;
  maxBuffer: number;
  promptSize: number;
  errorMessage: string;
}): string | undefined {
  // The ladder policy, not the raw kind: historic sync diagnostics treated
  // `429 rate limit` as quota wording (HOK-3460).
  const policy = retryPolicyFor(classifyCliMessage(input.errorMessage));
  if (policy.kind === 'timeout') {
    return [
      `${input.label} CLI timed out after ${input.timeout}ms`,
      '',
      `Command: ${input.command}`,
      `Prompt size: ${input.promptSize} chars`,
      '',
      'Possible causes:',
      '  - Network connectivity issues',
      '  - Prompt too large for processing',
      '  - Model overloaded or rate limited',
      '',
      'Troubleshooting:',
      '  - Increase timeout: REVIEW_TIMEOUT=300000 (5 min)',
      '  - Check network: curl -I https://api.anthropic.com',
      '  - Reduce diff size: review in smaller PRs',
      '  - Try again in a few minutes',
      '',
    ].join('\n');
  }
  if (policy.kind === 'auth') {
    return [
      `${input.label} CLI authentication failed`,
      '',
      'Troubleshooting:',
      `  - Run: ${input.cliCmd} login`,
      `  - Verify auth: echo "test" | ${input.cliCmd} -p --model claude-haiku-4-5-20251001`,
      '  - Check API key: echo $ANTHROPIC_API_KEY',
      '  - Run health check: npm run check:review',
      '',
    ].join('\n');
  }
  if (policy.kind === 'quota') {
    return [
      `${input.label} CLI rate limit or quota exceeded`,
      '',
      'Troubleshooting:',
      '  - Wait a few minutes and try again',
      '  - Check usage at: https://console.anthropic.com/settings/usage',
      '  - Contact support if issue persists',
      '',
    ].join('\n');
  }
  if (input.errorMessage.includes('maxBuffer') || input.errorMessage.includes('stdout maxBuffer')) {
    return [
      `${input.label} CLI output exceeded buffer limit (${input.maxBuffer} bytes)`,
      '',
      'Possible causes:',
      '  - Diff is very large',
      '  - LLM returned excessive output',
      '',
      'Troubleshooting:',
      '  - Review diff in smaller PRs',
      `  - Increase buffer: REVIEW_MAX_BUFFER=${input.maxBuffer * 2}`,
      '',
    ].join('\n');
  }
  return undefined;
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf-8');
  return '';
}

function runSync(opts: CliProcessOptions, startedAt: number): CliProcessResult {
  const timeout = opts.timeout ?? DEFAULT_CLI_TIMEOUT_MS;
  const maxBuffer = opts.maxBuffer ?? DEFAULT_CLI_MAX_BUFFER;
  const tmpFile = join(tmpdir(), `wavemill-${opts.label}-${Date.now()}-${randomUUID()}.txt`);
  const command = `${escapeShellArg(opts.cmd)} ${opts.args.join(' ')} < ${escapeShellArg(tmpFile)}`;
  writeFileSync(tmpFile, opts.stdin, 'utf-8');

  try {
    const raw = execShellCommand(command, {
      encoding: 'utf-8',
      timeout,
      maxBuffer,
      cwd: opts.cwd,
      env: opts.env,
    });
    return { stdout: String(raw), stderr: '', exitCode: 0, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    const failure = error as {
      message?: string;
      status?: number | null;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      signal?: string | null;
      code?: string | number | null;
    };
    const errorMessage = failure.message ?? String(error);
    const promptSize = existsSync(tmpFile) ? readFileSync(tmpFile, 'utf-8').length : 0;

    if (errorMessage.includes('ENOENT') || errorMessage.includes('not found')) {
      throw new Error(
        `${opts.label} CLI command not found: ${opts.cmd}\n\n` +
        `Command attempted: ${command}\n` +
        `Working directory: ${opts.cwd}\n` +
        `PATH: ${process.env.PATH}\n\n` +
        `Troubleshooting:\n` +
        `  - Install Claude CLI: npm install -g @anthropic-ai/claude-cli\n` +
        `  - Verify installation: which ${opts.cmd}\n` +
        `  - Check PATH includes: $(npm bin -g)\n` +
        `  - Run health check: npm run check:review\n`,
      );
    }

    const timedOut =
      failure.signal === 'SIGTERM'
      || failure.code === 'ETIMEDOUT'
      || /\b(etimedout|timed out|timeout)\b/i.test(errorMessage);
    if (timedOut) {
      throw new Error(
        `${opts.label} CLI timed out after ${timeout}ms\n\n` +
        `Command: ${command}\n` +
        `Prompt size: ${promptSize} chars\n\n` +
        `Possible causes:\n` +
        `  - Network connectivity issues\n` +
        `  - Prompt too large for processing\n` +
        `  - Model overloaded or rate limited\n\n` +
        `Troubleshooting:\n` +
        `  - Increase timeout: REVIEW_TIMEOUT=300000 (5 min)\n` +
        `  - Check network: curl -I https://api.anthropic.com\n` +
        `  - Reduce diff size: review in smaller PRs\n` +
        `  - Try again in a few minutes\n`,
      );
    }

    const exitCode = typeof failure.status === 'number' ? failure.status : 1;
    return {
      stdout: asText(failure.stdout),
      stderr: asText(failure.stderr),
      exitCode,
      elapsedMs: Date.now() - startedAt,
      failureMessage: syncFailureMessage({
        label: opts.label,
        command,
        cwd: opts.cwd,
        cliCmd: opts.cmd,
        timeout,
        maxBuffer,
        promptSize,
        errorMessage,
      }),
    };
  } finally {
    if (existsSync(tmpFile)) {
      try {
        unlinkSync(tmpFile);
      } catch {
        // Best effort cleanup.
      }
    }
  }
}

function runStream(opts: CliProcessOptions, startedAt: number): Promise<CliProcessResult> {
  return new Promise((resolve, reject) => {
    const timeout = opts.timeout ?? DEFAULT_CLI_TIMEOUT_MS;

    if (opts.signal?.aborted) {
      reject(new Error('LLM call aborted'));
      return;
    }

    const process_ = spawn(opts.cmd, opts.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: opts.cwd,
      env: opts.env,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let lastActivityAt = startedAt;

    let timeoutId: NodeJS.Timeout | undefined;
    let slowInterval: NodeJS.Timeout | undefined;
    let activityTimeoutId: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (slowInterval) clearInterval(slowInterval);
      if (activityTimeoutId) clearTimeout(activityTimeoutId);
      if (abortListener) opts.signal?.removeEventListener('abort', abortListener);
    };

    const abortListener = () => {
      if (settled) return;
      settled = true;
      cleanup();
      process_.kill('SIGTERM');
      reject(new Error('LLM call aborted'));
    };

    slowInterval = setInterval(() => {
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs < SLOW_CALL_WARNING_MS) return;
      opts.onSlow?.(elapsedMs);
    }, SLOW_CALL_REPEAT_MS);

    timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      process_.kill('SIGTERM');
      const elapsedMs = Date.now() - startedAt;
      const timeSinceLastActivity = Date.now() - lastActivityAt;
      const stdoutBytes = Buffer.byteLength(stdout, 'utf-8');
      reject(new Error(
        `${opts.label} CLI timed out after ${timeout}ms (hard wall-clock cap)\n\n` +
        `Command: ${opts.cmd} ${opts.args.join(' ')}\n` +
        `Working directory: ${opts.cwd}\n` +
        `Elapsed: ${elapsedMs}ms\n` +
        `Stdout collected: ${stdoutBytes} bytes\n` +
        `Last CLI output: ${timeSinceLastActivity}ms ago\n` +
        `Output silence does not establish agent liveness; structured JSON may be buffered until completion.\n`,
      ));
    }, timeout);

    const resetActivityTimeout = () => {
      if (!opts.activityTimeout) return;
      if (activityTimeoutId) clearTimeout(activityTimeoutId);
      activityTimeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        process_.kill('SIGTERM');
        const elapsedMs = Date.now() - startedAt;
        const timeSinceLastActivity = Date.now() - lastActivityAt;
        const stdoutBytes = Buffer.byteLength(stdout, 'utf-8');
        reject(new Error(
          `${opts.label} CLI timed out due to inactivity (no output for ${opts.activityTimeout}ms)\n\n` +
          `Command: ${opts.cmd} ${opts.args.join(' ')}\n` +
          `Working directory: ${opts.cwd}\n` +
          `Elapsed: ${elapsedMs}ms\n` +
          `Stdout collected: ${stdoutBytes} bytes\n` +
          `Last activity: ${timeSinceLastActivity}ms ago\n` +
          `Hard timeout cap: ${timeout}ms\n`,
        ));
      }, opts.activityTimeout);
    };

    if (opts.activityTimeout) resetActivityTimeout();

    opts.signal?.addEventListener('abort', abortListener, { once: true });

    process_.stdout?.on('data', (data) => {
      stdout += data.toString();
      lastActivityAt = Date.now();
      resetActivityTimeout();
    });

    process_.stderr?.on('data', (data) => {
      stderr += data.toString();
      lastActivityAt = Date.now();
      resetActivityTimeout();
    });

    process_.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        stdout,
        stderr,
        exitCode: typeof code === 'number' ? code : 1,
        elapsedMs: Date.now() - startedAt,
      });
    });

    process_.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Failed to spawn ${opts.label} CLI: ${error.message}`));
    });

    try {
      process_.stdin?.write(opts.stdin);
      process_.stdin?.end();
    } catch (error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Failed to write prompt to ${opts.label} CLI: ${(error as Error).message}`));
    }
  });
}

/**
 * Run one CLI invocation. Sync mode feeds the prompt from a temp file
 * (`< tmpfile`), which keeps large prompts and test CLIs working; stream mode
 * writes it to stdin.
 */
export async function runCliProcess(opts: CliProcessOptions): Promise<CliProcessResult> {
  const startedAt = Date.now();
  if (opts.mode === 'sync') {
    return runSync(opts, startedAt);
  }
  return runStream(opts, startedAt);
}
