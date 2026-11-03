import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { processAlive, processHost, processStartTime } from './process-identity.ts';

export interface OwnerRecord { pid: number; processStartTime: string; host: string; acquiredAt: string; purpose: string }
export interface StateLockHandle { lockPath: string; owner: OwnerRecord }
export class StateLockTimeoutError extends Error {
  constructor(statePath: string, timeoutMs: number) { super(`Timed out acquiring state lock for ${statePath} after ${timeoutMs}ms`); this.name = 'StateLockTimeoutError'; }
}

export function isOwnerReclaimable(owner: OwnerRecord | null, thisHost = processHost(), aliveFn = processAlive): boolean {
  return owner !== null && Number.isSafeInteger(owner.pid) && owner.pid > 0 && owner.processStartTime.length > 0 && owner.host === thisHost && !aliveFn(owner.pid, owner.processStartTime);
}

function readOwner(lockPath: string): OwnerRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8')) as Partial<OwnerRecord>;
    return Number.isSafeInteger(parsed.pid) && (parsed.pid ?? 0) > 0 && typeof parsed.processStartTime === 'string' && parsed.processStartTime.length > 0 && typeof parsed.host === 'string' && parsed.host.length > 0 && typeof parsed.acquiredAt === 'string' && typeof parsed.purpose === 'string' ? parsed as OwnerRecord : null;
  } catch { return null; }
}

function attemptClaim(lockPath: string, purpose: string): StateLockHandle | null {
  // Never rename onto an existing path: POSIX permits replacing an empty dir,
  // which would turn a legacy ownerless lock into an unsafe runtime reclaim.
  if (existsSync(lockPath)) return null;
  mkdirSync(dirname(lockPath), { recursive: true });
  const temp = mkdtempSync(`${lockPath}.tmp-${process.pid}-${randomUUID()}-`);
  const owner: OwnerRecord = { pid: process.pid, processStartTime: processStartTime(process.pid), host: processHost(), acquiredAt: new Date().toISOString(), purpose };
  writeFileSync(join(temp, 'owner.json'), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  try { renameSync(temp, lockPath); return { lockPath, owner }; }
  catch (error) {
    rmSync(temp, { recursive: true, force: true });
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ENOTEMPTY') return null;
    throw error;
  }
}

function inspectAndReclaim(lockPath: string): boolean {
  if (!existsSync(lockPath)) return false;
  const owner = readOwner(lockPath);
  if (!isOwnerReclaimable(owner)) return false;
  // Only one waiter may inspect and remove this generation of the lock. A
  // waiter that read the old owner before a new claimant arrived must not
  // remove that claimant's directory.
  const reclaimPath = join(lockPath, '.reclaim');
  try { mkdirSync(reclaimPath); } catch { return false; }
  let removed = false;
  try {
    const current = readOwner(lockPath);
    if (!current || JSON.stringify(current) !== JSON.stringify(owner) || !isOwnerReclaimable(current)) return false;
    rmSync(lockPath, { recursive: true, force: true });
    removed = true;
    return true;
  } finally { if (!removed) rmSync(reclaimPath, { recursive: true, force: true }); }
}

function sleepSync(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function acquireStateLock(statePath: string, opts: { timeoutMs?: number; purpose?: string } = {}): Promise<StateLockHandle> {
  const timeoutMs = opts.timeoutMs ?? 5_000; const lockPath = `${statePath}.lock`; const started = Date.now(); let delay = 10;
  while (true) {
    const claimed = attemptClaim(lockPath, opts.purpose ?? 'state-mutation'); if (claimed) return claimed;
    const reclaimed = inspectAndReclaim(lockPath);
    if (reclaimed) continue;
    if (Date.now() - started >= timeoutMs) throw new StateLockTimeoutError(statePath, timeoutMs);
    await sleep(delay); delay = Math.min(Math.ceil(delay * 1.5), 100);
  }
}

export function acquireStateLockSync(statePath: string, opts: { timeoutMs?: number; purpose?: string } = {}): StateLockHandle {
  const timeoutMs = opts.timeoutMs ?? 5_000; const lockPath = `${statePath}.lock`; const started = Date.now(); let delay = 10;
  while (true) {
    const claimed = attemptClaim(lockPath, opts.purpose ?? 'state-mutation'); if (claimed) return claimed;
    const reclaimed = inspectAndReclaim(lockPath);
    if (reclaimed) continue;
    if (Date.now() - started >= timeoutMs) throw new StateLockTimeoutError(statePath, timeoutMs);
    sleepSync(delay); delay = Math.min(Math.ceil(delay * 1.5), 100);
  }
}

export function releaseStateLock(handle: StateLockHandle): void {
  const current = readOwner(handle.lockPath);
  if (current && current.pid === handle.owner.pid && current.processStartTime === handle.owner.processStartTime) rmSync(handle.lockPath, { recursive: true, force: true });
}

/** Startup-only migration of pre-owner lock forms. Runtime acquisition never calls this. */
export function reclaimLegacyStateLock(lockPath: string): boolean {
  if (!existsSync(lockPath)) return false;
  const stat = lstatSync(lockPath);
  const legacy = stat.isFile() ? stat.size === 0 : stat.isDirectory() && !existsSync(join(lockPath, 'owner.json'));
  if (!legacy) return false;
  rmSync(lockPath, { recursive: true, force: true });
  return true;
}
