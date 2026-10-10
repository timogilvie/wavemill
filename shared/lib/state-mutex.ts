import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { errorMessage } from './error-utils.ts';

function blockingSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface MutateJsonStateOptions<T> {
  timeoutMs?: number;
  createIfMissing?: boolean;
  initial?: T;
}

export class StateLockTimeoutError extends Error {
  constructor(statePath: string, timeoutMs: number) {
    super(`Timed out acquiring state lock for ${statePath} after ${timeoutMs}ms`);
    this.name = 'StateLockTimeoutError';
  }
}

export class StateParseError extends Error {
  constructor(statePath: string, cause: unknown) {
    super(`Failed to parse JSON state file ${statePath}: ${errorMessage(cause)}`);
    this.name = 'StateParseError';
    this.cause = cause;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(statePath: string, timeoutMs: number): Promise<{ fd: number; lockPath: string }> {
  const lockPath = `${statePath}.lock`;
  const startedAt = Date.now();
  let delayMs = 10;

  while (true) {
    try {
      const fd = openSync(lockPath, 'wx');
      return { fd, lockPath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        throw new StateLockTimeoutError(statePath, timeoutMs);
      }

      await sleep(delayMs);
      delayMs = Math.min(Math.ceil(delayMs * 1.5), 100);
    }
  }
}

function readJsonState<T>(
  statePath: string,
  opts: MutateJsonStateOptions<T>,
): T {
  if (!existsSync(statePath)) {
    if (opts.createIfMissing) {
      if (opts.initial === undefined) {
        throw new Error('initial is required when createIfMissing is true');
      }
      return opts.initial;
    }
    throw new Error(`State file not found: ${statePath}`);
  }

  try {
    return JSON.parse(readFileSync(statePath, 'utf-8')) as T;
  } catch (error) {
    throw new StateParseError(statePath, error);
  }
}

/**
 * Run a JSON state read-modify-write cycle under an atomic file lock.
 */
export async function mutateJsonState<T>(
  statePath: string,
  transform: (current: T) => T,
  opts: MutateJsonStateOptions<T> = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  if (opts.createIfMissing) {
    mkdirSync(dirname(statePath), { recursive: true });
  }
  const lock = await acquireLock(statePath, timeoutMs);
  const tmpPath = `${statePath}.tmp.${process.pid}.${randomUUID()}`;

  try {
    const current = readJsonState(statePath, opts);
    const next = transform(current);

    mkdirSync(dirname(statePath), { recursive: true });
    // HOK-3190: compact JSON output. Pretty-printing a 15 MB state file costs
    // ~0.8 s to parse per read; compact gives ~40 % size back on every write.
    writeFileSync(tmpPath, `${JSON.stringify(next)}\n`, 'utf-8');
    renameSync(tmpPath, statePath);

    return next;
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    } finally {
      closeSync(lock.fd);
      unlinkSync(lock.lockPath);
    }
  }
}

function acquireLockSync(statePath: string, timeoutMs: number): { fd: number; lockPath: string } {
  const lockPath = `${statePath}.lock`;
  const startedAt = Date.now();
  let delayMs = 10;

  while (true) {
    try {
      const fd = openSync(lockPath, 'wx');
      return { fd, lockPath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        throw new StateLockTimeoutError(statePath, timeoutMs);
      }

      blockingSleep(delayMs);
      delayMs = Math.min(Math.ceil(delayMs * 1.5), 100);
    }
  }
}

/**
 * Synchronous counterpart to {@link mutateJsonState}, for callers that
 * cannot be async (e.g. `buildFindings` in `tools/observer.ts`, which has
 * hundreds of synchronous call sites). Uses the same lock-file + temp-file +
 * atomic-rename protocol; lock-wait backoff blocks via `Atomics.wait` instead
 * of `setTimeout`, which is safe on Node's main thread and keeps contention
 * windows short for callers that only hold the lock for a JSON read + write.
 */
export function mutateJsonStateSync<T>(
  statePath: string,
  transform: (current: T) => T,
  opts: MutateJsonStateOptions<T> = {},
): T {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  if (opts.createIfMissing) {
    mkdirSync(dirname(statePath), { recursive: true });
  }
  const lock = acquireLockSync(statePath, timeoutMs);
  const tmpPath = `${statePath}.tmp.${process.pid}.${randomUUID()}`;

  try {
    const current = readJsonState(statePath, opts);
    const next = transform(current);

    mkdirSync(dirname(statePath), { recursive: true });
    // HOK-3190: compact JSON output. See mutateJsonState for rationale.
    writeFileSync(tmpPath, `${JSON.stringify(next)}\n`, 'utf-8');
    renameSync(tmpPath, statePath);

    return next;
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    } finally {
      closeSync(lock.fd);
      unlinkSync(lock.lockPath);
    }
  }
}
