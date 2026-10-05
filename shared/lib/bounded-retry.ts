/**
 * TypeScript bridge to `shared/lib/bounded-retry.sh` (HOK-2924, HOK-3097).
 *
 * Every mill relaunch path must count attempts against a shared bounded-retry
 * bucket. In shell, callers source `bounded-retry.sh` directly. In TypeScript
 * there is one existing caller (`tend-controller.ts`, via a private
 * `runBoundedRetryHelper`); this module exposes the same pattern as a typed,
 * reusable surface so new TS callers never add a private counter.
 *
 * Callers construct an ops object with {@link createStateDirRetry}: it is
 * keyed by a `stateDir` on each call (not by a PR number like the tend ops),
 * which fits per-task state directories such as `features/<slug>/`. Each op
 * shells out through `execArgvCommand`, so secrets never leak into argv and
 * SHAs are validated to hex before being passed through.
 *
 * The current observer HOK-3097 fixes are the first TS consumers. The tend
 * controller's private shell-out can be migrated to {@link createMergeLaneRetry}
 * in a follow-up; this module keeps that option open without changing tend
 * behaviour today.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeShellArg, execArgvCommand } from './shell-utils.ts';

const BOUNDED_RETRY_HELPER_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'bounded-retry.sh',
);
const BOUNDED_RETRY_HELPER_TIMEOUT_MS = 30_000;

export type BoundedRetryDecision = 'proceed' | 'backoff' | 'exhausted' | 'exhausted-quiet';

const DECISIONS: ReadonlySet<string> = new Set<BoundedRetryDecision>([
  'proceed',
  'backoff',
  'exhausted',
  'exhausted-quiet',
]);

export interface BoundedRetryBackoff {
  baseSeconds?: number;
  capSeconds?: number;
}

export interface BoundedRetryOptions {
  maxAttempts: number;
  backoff?: BoundedRetryBackoff;
  /** Override the resolved helper path (tests). */
  helperPath?: string;
}

export interface BoundedRetryStoredKey {
  head: string;
  base: string;
}

export interface StateDirRetry {
  readonly bucket: string;
  /**
   * Decide whether to launch, back off, or terminalize. Caller must still
   * invoke {@link increment} once it has decided to proceed.
   */
  gate(stateDir: string, head: string, base?: string): BoundedRetryDecision;
  /** Bump the attempt counter and stamp the key file. */
  increment(stateDir: string, head: string, base?: string): void;
  /** One-shot terminalization with a greppable recorded reason. */
  markExhausted(stateDir: string, reason: string): void;
  /** Reset the bucket (clears every `.retry-<bucket>-*` file). */
  clear(stateDir: string): void;
  /** True when the bucket is terminalized. */
  isExhausted(stateDir: string): boolean;
  /** Current attempt counter (0 when unset). */
  count(stateDir: string): number;
  /** Current stored key (head/base), both empty strings when unset. */
  readKey(stateDir: string): BoundedRetryStoredKey;
  /** Recorded terminalization reason, or empty when not exhausted. */
  exhaustionReason(stateDir: string): string;
}

/** Hex SHA sanitizer matching bounded-retry.sh's gate rules. */
function sanitizeShaForRetryKey(value: string | undefined): string {
  if (!value) return '';
  return /^[0-9a-fA-F]{4,64}$/.test(value) ? value : '';
}

function runHelper(invocation: string, helperPath: string): string {
  const result = execArgvCommand(
    'bash',
    ['-c', `source ${escapeShellArg(helperPath)} && ${invocation}`],
    { encoding: 'utf-8', timeout: BOUNDED_RETRY_HELPER_TIMEOUT_MS },
  );
  if (result.failed) {
    throw new Error(`bounded-retry helper unavailable: ${result.stderr || 'bash not found'}`);
  }
  return result.stdout.replace(/\n+$/, '');
}

/**
 * Build a reusable ops object for one bucket, keyed on a state directory per
 * call. Bucket names must not be prefixes of one another in the same state
 * directory (the shell helper's clear() uses prefix glob).
 */
export function createStateDirRetry(
  bucket: string,
  options: BoundedRetryOptions,
): StateDirRetry {
  if (!bucket || !/^[a-z][a-z0-9-]*$/.test(bucket)) {
    throw new Error(`bounded-retry bucket must be kebab-case: got '${bucket}'`);
  }
  const helperPath = options.helperPath ?? BOUNDED_RETRY_HELPER_PATH;
  const maxAttempts = options.maxAttempts;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`bounded-retry maxAttempts must be a positive integer: got ${maxAttempts}`);
  }
  const backoffBase = options.backoff?.baseSeconds;
  const backoffCap = options.backoff?.capSeconds;
  const backoffSuffix = backoffBase !== undefined || backoffCap !== undefined
    ? ` ${escapeShellArg(String(backoffBase ?? ''))} ${escapeShellArg(String(backoffCap ?? ''))}`
    : '';

  const bucketArg = escapeShellArg(bucket);

  return {
    bucket,
    gate(stateDir, head, base) {
      const decision = runHelper(
        `bounded_retry_gate ${escapeShellArg(stateDir)} ${bucketArg} ${escapeShellArg(sanitizeShaForRetryKey(head))} ${maxAttempts}${backoffSuffix} ${escapeShellArg(sanitizeShaForRetryKey(base))}`,
        helperPath,
      );
      if (!DECISIONS.has(decision)) {
        throw new Error(`bounded_retry_gate returned unexpected decision for ${bucket}: ${decision || '(empty)'}`);
      }
      return decision as BoundedRetryDecision;
    },
    increment(stateDir, head, base) {
      runHelper(
        `bounded_retry_increment ${escapeShellArg(stateDir)} ${bucketArg} ${escapeShellArg(sanitizeShaForRetryKey(head))} ${escapeShellArg(sanitizeShaForRetryKey(base))} > /dev/null`,
        helperPath,
      );
    },
    markExhausted(stateDir, reason) {
      runHelper(
        `bounded_retry_mark_exhausted ${escapeShellArg(stateDir)} ${bucketArg} ${escapeShellArg(reason)} || true`,
        helperPath,
      );
    },
    clear(stateDir) {
      runHelper(
        `bounded_retry_clear ${escapeShellArg(stateDir)} ${bucketArg}`,
        helperPath,
      );
    },
    isExhausted(stateDir) {
      const value = runHelper(
        `if bounded_retry_is_exhausted ${escapeShellArg(stateDir)} ${bucketArg}; then printf yes; else printf no; fi`,
        helperPath,
      );
      return value === 'yes';
    },
    count(stateDir) {
      const value = runHelper(
        `bounded_retry_count ${escapeShellArg(stateDir)} ${bucketArg}`,
        helperPath,
      );
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    },
    readKey(stateDir) {
      const head = runHelper(
        `bounded_retry_head ${escapeShellArg(stateDir)} ${bucketArg}`,
        helperPath,
      );
      const base = runHelper(
        `bounded_retry_base ${escapeShellArg(stateDir)} ${bucketArg}`,
        helperPath,
      );
      return { head: head.trim(), base: base.trim() };
    },
    exhaustionReason(stateDir) {
      return runHelper(
        `bounded_retry_exhaustion_reason ${escapeShellArg(stateDir)} ${bucketArg}`,
        helperPath,
      ).trim();
    },
  };
}
