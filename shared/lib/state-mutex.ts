import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname } from 'node:path';
import { errorMessage } from './error-utils.ts';
import { acquireStateLock, acquireStateLockSync, releaseStateLock, StateLockTimeoutError } from './state-lock.ts';
import { prepareTaskRecordWriteCheck } from './task-record-write-guard.ts';
import type { WorkflowStateIssue } from './workflow-state.ts';

export interface MutateJsonStateOptions<T> {
  timeoutMs?: number;
  createIfMissing?: boolean;
  initial?: T;
  /**
   * `workflow-state.json` only (HOK-3222): called with schema violations in
   * task records the write added or changed, instead of the default stderr
   * line. The violations are still shadow-logged.
   */
  onInvalid?: (statePath: string, issues: WorkflowStateIssue[]) => void;
  /**
   * `workflow-state.json` only (HOK-3373): `.tasks` key → the run id this
   * writer acted for. Control writes against a row now carrying another
   * `runId` are reverted before the write lands (`task-settlement.ts`).
   */
  expectedRunIds?: Record<string, string>;
}

export { StateLockTimeoutError } from './state-lock.ts';

export class StateParseError extends Error {
  constructor(statePath: string, cause: unknown) {
    super(`Failed to parse JSON state file ${statePath}: ${errorMessage(cause)}`);
    this.name = 'StateParseError';
    this.cause = cause;
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
 * HOK-3187: when the ledger authority flip is live, workflow-state.json is a
 * render view generated from the ledger. This helper is best-effort: it fires
 * only when the opt-in env flag `WAVEMILL_LEDGER_RENDER_WORKFLOW_STATE=1` is
 * set and the kill-switch `WAVEMILL_LEDGER_SURFACES_SHIM=1` is not. All errors
 * are swallowed so a render fault never trumps the primary write.
 */
function maybeRenderWorkflowStateFromLedger(statePath: string): void {
  if (process.env.WAVEMILL_LEDGER_SURFACES_SHIM === '1') return;
  if (process.env.WAVEMILL_LEDGER_RENDER_WORKFLOW_STATE !== '1') return;
  if (basename(statePath) !== 'workflow-state.json') return;
  try {
    // Lazy require to keep the hot path dependency-free when the flag is off.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const repoDir = dirname(dirname(statePath));
    const tool = `${repoDir}/tools/ledger.ts`;
    const args = [tool, 'view', 'workflow-state', '--repo-dir', repoDir, '--out', statePath];
    // HOK-3190 fast strip: prefer `node --experimental-strip-types` (~0.3s)
    // over `npx tsx` (4-7s cold). The shell helper does the same probe.
    if (process.env.WAVEMILL_SKIP_FAST_STRIP !== '1') {
      try {
        execFileSync('node', ['--experimental-strip-types', '--no-warnings', ...args], { stdio: 'ignore' });
        return;
      } catch {
        // fall through to npx tsx fallback (older Node)
      }
    }
    execFileSync('npx', ['tsx', ...args], { stdio: 'ignore' });
  } catch {
    // Best-effort: never surface renderer errors over the primary write.
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
  const lock = await acquireStateLock(statePath, { timeoutMs, purpose: 'mutate-json-state' });
  const tmpPath = `${statePath}.tmp.${process.pid}.${randomUUID()}`;

  try {
    const current = readJsonState(statePath, opts);
    // HOK-3222 / HOK-3373: for workflow-state.json, gate control writes on
    // settled / non-current runs (reverted in place) and shadow-validate the
    // task records this write adds or changes.
    const checkTaskRecords = prepareTaskRecordWriteCheck(statePath, current, 'ts', {
      onInvalid: opts.onInvalid,
      expectedRunIds: opts.expectedRunIds,
    });
    const next = transform(current);
    checkTaskRecords?.(next);

    mkdirSync(dirname(statePath), { recursive: true });
    // HOK-3190: compact JSON output. Pretty-printing a 15 MB state file costs
    // ~0.8 s to parse per read; compact gives ~40 % size back on every write.
    writeFileSync(tmpPath, `${JSON.stringify(next)}\n`, 'utf-8');
    renameSync(tmpPath, statePath);
    maybeRenderWorkflowStateFromLedger(statePath);

    return next;
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    } finally {
      releaseStateLock(lock);
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
  const lock = acquireStateLockSync(statePath, { timeoutMs, purpose: 'mutate-json-state' });
  const tmpPath = `${statePath}.tmp.${process.pid}.${randomUUID()}`;

  try {
    const current = readJsonState(statePath, opts);
    // HOK-3222 / HOK-3373: for workflow-state.json, gate control writes on
    // settled / non-current runs (reverted in place) and shadow-validate the
    // task records this write adds or changes.
    const checkTaskRecords = prepareTaskRecordWriteCheck(statePath, current, 'ts', {
      onInvalid: opts.onInvalid,
      expectedRunIds: opts.expectedRunIds,
    });
    const next = transform(current);
    checkTaskRecords?.(next);

    mkdirSync(dirname(statePath), { recursive: true });
    // HOK-3190: compact JSON output. See mutateJsonState for rationale.
    writeFileSync(tmpPath, `${JSON.stringify(next)}\n`, 'utf-8');
    renameSync(tmpPath, statePath);
    maybeRenderWorkflowStateFromLedger(statePath);

    return next;
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    } finally {
      releaseStateLock(lock);
    }
  }
}
