import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/**
 * Short fingerprint of the worktree state (HEAD sha + porcelain status + diff).
 * Used by the command-tools repeat-after-timeout guard so a legitimate
 * "fixed the hanging test, re-run the same focused command" still goes
 * through: a new tree → a new fingerprint → the record no longer matches.
 *
 * Any git failure returns an empty string, which the guard treats
 * conservatively (the refusal persists until the agent changes the command).
 */
export function defaultWorktreeFingerprint(worktreePath: string): string {
  const parts: string[] = [];
  for (const args of [['rev-parse', 'HEAD'], ['status', '--porcelain'], ['diff', 'HEAD']] as const) {
    try {
      const output = execFileSync('git', [...args], {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      parts.push(output);
    } catch {
      return '';
    }
  }
  return createHash('sha256').update(parts.join('\u0001')).digest('hex').slice(0, 32);
}
