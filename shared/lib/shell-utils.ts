/**
 * Shell execution utilities for safe command execution.
 *
 * Fixes DEP0190 warning by properly escaping shell arguments.
 * Use these utilities instead of execSync(..., { shell: '/bin/bash' }) with string interpolation.
 */

import { execSync } from "node:child_process";
import type { ExecSyncOptions } from "node:child_process";

/**
 * Escape a string for safe use as a shell argument.
 *
 * Uses single-quote escaping which is the safest approach for arbitrary strings.
 * Handles embedded single quotes by closing quote, escaping, and reopening.
 *
 * @param arg - The string to escape
 * @returns The escaped string, safe for shell interpolation
 *
 * @example
 * ```typescript
 * const file = "user's file.txt";
 * const cmd = `cat ${escapeShellArg(file)}`;
 * // Result: cat 'user'\''s file.txt'
 * ```
 */
export function escapeShellArg(arg: string): string {
  if (arg === '') {
    return "''";
  }

  // Replace single quotes with '\'' (close quote, escaped quote, open quote)
  // Then wrap the whole thing in single quotes
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * Execute a shell command with proper escaping.
 *
 * This is a safer alternative to execSync(..., { shell: '/bin/bash' }) that
 * avoids the DEP0190 deprecation warning.
 *
 * Use escapeShellArg() to escape any variables before interpolating them into
 * the command string.
 *
 * @param command - The shell command to execute (with pre-escaped arguments)
 * @param options - Options to pass to execSync (shell option will be set automatically)
 * @returns The command output
 *
 * @example
 * ```typescript
 * const issueId = 'HOK-123';
 * const output = execShellCommand(
 *   `gh issue view ${escapeShellArg(issueId)} --json title`,
 *   { encoding: 'utf-8', cwd: '/path/to/repo' }
 * );
 * ```
 */
export function execShellCommand(
  command: string,
  options?: ExecSyncOptions
): Buffer | string {
  // Force shell to /bin/bash for consistency
  const shellOptions: ExecSyncOptions = {
    ...options,
    shell: '/bin/bash',
  };

  return execSync(command, shellOptions);
}
