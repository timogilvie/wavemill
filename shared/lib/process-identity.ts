import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';

/** A PID is only an identity together with its process start time. */
export function processStartTime(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) return '';
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trimStart().trimEnd();
  } catch {
    return '';
  }
}

export function processAlive(pid: number, startTime: string): boolean {
  if (!startTime || !Number.isInteger(pid) || pid <= 0) return false;
  const current = processStartTime(pid);
  if (current) return current === startTime;
  // An empty ps result can mean a missing PID or a failed ps invocation.
  // Only ESRCH proves absence; all other failures keep the lock busy.
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

export function processHost(): string {
  return hostname();
}
