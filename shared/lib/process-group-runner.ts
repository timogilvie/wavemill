/**
 * Process group runner for bounded-deadline command execution with child-process
 * cleanup on timeout. Used for long-running operations like git worktree preparation.
 *
 * - Spawns commands in their own process group (detached: true) so signals reach
 *   grandchildren, not just immediate children
 * - On timeout, sends SIGTERM to the whole group, escalates to SIGKILL after grace
 * - Deadline tracking for end-to-end budgets across multiple commands
 */

import { spawn, type SpawnOptions } from 'node:child_process';

/**
 * Result of running a command in a process group.
 */
export interface ProcessGroupResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** True if the deadline expired and the process was killed. */
  timedOut: boolean;
  /** Process group ID if the process was spawned. */
  pgid?: number;
}

/**
 * Options for running a command in a process group.
 */
export interface RunCommandInProcessGroupOptions {
  cwd?: string;
  timeoutMs: number;
  /** Maximum bytes to collect from stdout/stderr (default 64KB). */
  outputLimit?: number;
}

/**
 * Deadline tracker for end-to-end operation budgets.
 *
 * Tracks a total time budget and allows multiple commands to share it.
 * Provides `remainingMs()` so a sequence of operations can each respect
 * the overall deadline.
 */
export class Deadline {
  private readonly startedAt: number;
  private readonly totalMs: number;

  constructor(totalMs: number) {
    this.startedAt = Date.now();
    this.totalMs = totalMs;
  }

  /**
   * Returns milliseconds remaining before the deadline expires.
   * Returns 0 if the deadline has already passed.
   */
  remainingMs(): number {
    const elapsed = Date.now() - this.startedAt;
    return Math.max(0, this.totalMs - elapsed);
  }

  /**
   * Returns true if the deadline has expired.
   */
  isExpired(): boolean {
    return this.remainingMs() === 0;
  }
}

/**
 * Run a command in its own process group with a deadline.
 *
 * The command is spawned with `detached: true`, giving it its own process group.
 * This ensures that signals sent to the process group reach all descendants
 * (e.g., git's ssh child, credential helpers).
 *
 * On timeout, SIGTERM is sent to the process group (- pgid). If the process
 * group is still alive after a grace period (2s), SIGKILL is sent.
 *
 * @param cmd Shell command to run (passed to /bin/sh -c)
 * @param options Timeout and working directory
 * @returns Result with stdout, stderr, exit code, and timeout flag
 */
export async function runCommandInProcessGroup(
  cmd: string,
  options: RunCommandInProcessGroupOptions,
): Promise<ProcessGroupResult> {
  const {
    cwd = process.cwd(),
    timeoutMs,
    outputLimit = 65536,
  } = options;

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let pgid: number | undefined;
    let killTimeout: NodeJS.Timeout | undefined;
    let timeoutHandle: NodeJS.Timeout | undefined;

    const spawnOpts: SpawnOptions = {
      cwd,
      detached: true, // Create new process group
      stdio: ['ignore', 'pipe', 'pipe'],
    };

    const child = spawn('/bin/sh', ['-c', cmd], spawnOpts);

    // Get the process group ID (same as child pid when detached).
    // Note: pgid might not be immediately available; it is set shortly after spawn.
    pgid = child.pid;

    // Collect output with limit.
    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        if (stdout.length < outputLimit) {
          stdout += chunk.toString();
          if (stdout.length > outputLimit) {
            stdout = stdout.slice(0, outputLimit);
          }
        }
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        if (stderr.length < outputLimit) {
          stderr += chunk.toString();
          if (stderr.length > outputLimit) {
            stderr = stderr.slice(0, outputLimit);
          }
        }
      });
    }

    // Handle process exit.
    const handleExit = (exitCode: number | null) => {
      if (killTimeout) clearTimeout(killTimeout);
      if (timeoutHandle) clearTimeout(timeoutHandle);

      const truncationLimit = outputLimit;
      resolve({
        stdout: stdout.length > truncationLimit ? stdout.slice(0, truncationLimit) + '... (truncated)' : stdout,
        stderr: stderr.length > truncationLimit ? stderr.slice(0, truncationLimit) + '... (truncated)' : stderr,
        exitCode,
        timedOut,
        pgid,
      });
    };

    child.on('exit', (code) => handleExit(code));
    child.on('error', () => handleExit(1));

    // Set up timeout.
    timeoutHandle = setTimeout(() => {
      if (!timedOut && pgid) {
        timedOut = true;

        // Try SIGTERM first.
        try {
          process.kill(-pgid, 'SIGTERM');
        } catch {
          // Process group may already be dead.
        }

        // Escalate to SIGKILL after grace period.
        killTimeout = setTimeout(() => {
          try {
            process.kill(-pgid!, 'SIGKILL');
          } catch {
            // Already dead.
          }
        }, 2000);
      }
    }, timeoutMs);
  });
}

/**
 * Create a deadline with the given total budget in milliseconds.
 *
 * Use `deadline.remainingMs()` to check budget before each command,
 * and pass the remaining time as the timeout for the next command.
 */
export function createDeadline(totalMs: number): Deadline {
  return new Deadline(totalMs);
}
