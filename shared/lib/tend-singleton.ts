import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { acquireStateLockSync, releaseStateLock, type StateLockHandle } from './state-lock.ts';

export type TendLockOutcome = 'started' | 'skipped' | 'recovered-stale';

export type TendLockResult = {
  outcome: TendLockOutcome;
  holderPid?: number;
  release: () => void;
};

export type ServiceLockResult = TendLockResult;

type AcquireTendLockOptions = {
  repoDir: string;
  session?: string;
  logger?: (message: string) => void;
};

type AcquireServiceLockOptions = AcquireTendLockOptions & {
  service: string;
};

const DEFAULT_SESSION = 'default';
const SESSION_PATTERN = /^[A-Za-z0-9_.-]+$/;
const SERVICE_PATTERN = /^[a-z][a-z0-9-]*$/;

function noop(): void {}

export function computeLockKey(repoDir: string, session?: string): string {
  const resolvedRepoDir = path.resolve(repoDir);
  const sessionKey = session ?? DEFAULT_SESSION;
  const repoHash = createHash('sha256').update(resolvedRepoDir).digest('hex').slice(0, 12);
  return `${repoHash}-${sessionKey}`;
}

export function getServiceLockPath(repoDir: string, service: string, lockKey: string): string {
  return path.join(repoDir, '.wavemill', 'locks', `${service}-${lockKey}.lock`);
}

export function getLockPath(repoDir: string, lockKey: string): string {
  return getServiceLockPath(repoDir, 'tend', lockKey);
}

function validateOptions(service: string, repoDir: string, session?: string): void {
  if (!SERVICE_PATTERN.test(service)) {
    throw new Error(`${service || 'service'}-singleton: invalid service "${service}"`);
  }
  if (!repoDir || !repoDir.trim()) {
    throw new Error(`${service}-singleton: repoDir is required`);
  }
  if (session !== undefined && !SESSION_PATTERN.test(session)) {
    throw new Error(`${service}-singleton: invalid session "${session}"`);
  }
}

function registerCleanup(handle: StateLockHandle): () => void {
  let released = false;

  const release = () => {
    if (released) {
      return;
    }
    released = true;
    process.removeListener('exit', onExit);
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    releaseStateLock(handle);
  };

  const onExit = () => {
    release();
  };
  const onSigint = () => {
    release();
  };
  const onSigterm = () => {
    release();
  };

  process.once('exit', onExit);
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  return release;
}

function logOutcome(
  logger: (message: string) => void,
  service: string,
  repoDir: string,
  session: string,
  outcome: TendLockOutcome,
  holderPid?: number,
): void {
  const details = [`repo=${path.resolve(repoDir)}`, `session=${session}`];
  if (holderPid !== undefined) {
    details.push(`pid=${holderPid}`);
  }
  logger(`[${service}-singleton] ${outcome} ${details.join(' ')}`);
}

/**
 * Acquires a singleton lock scoped by service, repository, and tmux session.
 * The session remains part of the key so separate mill sessions for one repo do
 * not starve each other, while duplicate loops in the same session are refused.
 */
export function acquireServiceLock({ service, repoDir, session, logger = console.error }: AcquireServiceLockOptions): ServiceLockResult {
  validateOptions(service, repoDir, session);

  const envName = `WAVEMILL_${service.toUpperCase().replace(/-/g, '_')}_SINGLETON_DISABLE`;
  if (process.env[envName] === '1') {
    return { outcome: 'started', release: noop };
  }

  const resolvedRepoDir = path.resolve(repoDir);
  const sessionKey = session ?? DEFAULT_SESSION;
  const lockKey = computeLockKey(resolvedRepoDir, sessionKey);
  const lockPath = getServiceLockPath(resolvedRepoDir, service, lockKey);
  mkdirSync(path.dirname(lockPath), { recursive: true });

  let holderPid: number | undefined;
  const existed = existsSync(lockPath);
  if (existed) {
    try { const owner = JSON.parse(readFileSync(path.join(lockPath, 'owner.json'), 'utf8')) as { pid?: number }; holderPid = owner.pid; } catch { /* legacy locks are busy */ }
  }
  try {
    const handle = acquireStateLockSync(lockPath.slice(0, -5), { timeoutMs: 0, purpose: `${service}-singleton` });
    const release = registerCleanup(handle);
    const outcome: TendLockOutcome = existed ? 'recovered-stale' : 'started';
    logOutcome(logger, service, resolvedRepoDir, sessionKey, outcome, existed ? holderPid : process.pid);
    return { outcome, ...(existed && holderPid !== undefined ? { holderPid } : {}), release };
  } catch {
    logOutcome(logger, service, resolvedRepoDir, sessionKey, 'skipped', holderPid);
    return { outcome: 'skipped', ...(holderPid !== undefined ? { holderPid } : {}), release: noop };
  }
}

export function acquireTendLock(options: AcquireTendLockOptions): TendLockResult {
  return acquireServiceLock({ service: 'tend', ...options });
}

export function acquireObserverLock(options: AcquireTendLockOptions): ServiceLockResult {
  return acquireServiceLock({ service: 'observer', ...options });
}
