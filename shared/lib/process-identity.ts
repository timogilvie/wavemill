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
  return Boolean(startTime) && processStartTime(pid) === startTime;
}

export function processHost(): string {
  return hostname();
}
