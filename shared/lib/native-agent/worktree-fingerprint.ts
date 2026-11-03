import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/**
 * Fingerprint of the worktree's *content* for the shared HOK-3381 progress
 * rule (`ToolCallProgressTracker` in shared/lib/task-progress.ts): HEAD sha,
 * porcelain status, and the tracked-file diff — never mtimes. `.wavemill/`
 * (test logs, telemetry, run artifacts) is excluded from every component so a
 * verification run that only appended logs does not read as progress.
 *
 * Any git failure returns an empty string, which the rule compares like any
 * other value (two consecutive failures look unchanged — conservative).
 */
export function trackedContentFingerprint(worktreePath: string): string {
  const exclude = ':(exclude).wavemill';
  const parts: string[] = [];
  for (const args of [
    ['rev-parse', 'HEAD'],
    ['status', '--porcelain', '--', '.', exclude],
    ['diff', 'HEAD', '--', '.', exclude],
  ] as const) {
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
