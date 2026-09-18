/**
 * Bounded scratch-worktree preparation and recovery for Tend (HOK-3039).
 *
 * The merge-lane's preparation phase (`git worktree remove/prune`,
 * `git fetch origin <branch>`, `git worktree add --detach`) used to run
 * sync-blocking with per-command timeouts only. `execSync`'s timeout kills
 * the direct child; git's descendants (ssh, git-remote-https, hooks) could
 * survive, and no shared end-to-end deadline was applied. The event loop
 * also stalled for the duration, so Backstage saw stale heartbeats and
 * respawned the loop, orphaning `wm:merging` on the PR.
 *
 * This module provides:
 *
 * - A persisted phase marker recording where a merge attempt was
 *   (`reap` → `fetch` → `add` → `ready` → `push` → `pushed` → `merge`),
 *   used by startup reconciliation to distinguish safe-to-retry from
 *   remote-mutation-uncertain interruptions.
 *
 * - `createProcessGroupPrepRunner()`: an async runner that spawns each prep
 *   command as its own process group, applies a shared deadline across the
 *   whole prep phase, and terminates the group (SIGTERM → grace → SIGKILL)
 *   on expiry — killing git descendants the parent never named.
 *
 * State lives under `mergeLaneStateDir(prNumber)/scratch-prep.json` and is
 * read/written via `mutateJsonState` (the State Mutation rule).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mergeLaneStateDir } from './merge-queue.ts';
import { mutateJsonState } from './state-mutex.ts';
import { errorMessage } from './error-utils.ts';

export type ScratchPrepPhase =
  | 'reap'
  | 'fetch'
  | 'add'
  | 'ready'
  | 'push'
  | 'pushed'
  | 'merge';

export interface ScratchPrepRetained {
  reason: string;
}

export interface ScratchPrepMarker {
  version: 1;
  prNumber: number;
  headBranch: string;
  /** The Ready-handoff head Tend claimed (candidate.headSha). */
  headSha?: string;
  /** Feature dir, for handoff cross-checks during recovery. */
  featureDir?: string;
  phase: ScratchPrepPhase;
  phaseStartedAt: string;
  updatedAt: string;
  /** Owning Tend process pid; recovery consults `process.kill(pid, 0)`. */
  pid: number;
  /** Process-group id of the currently running prep command. */
  prepPgid?: number;
  worktreePath?: string;
  /** origin/<branch> sha captured immediately before the push. */
  prePushSha?: string;
  /** The rebased sha we pushed (or intended to push). */
  rebasedHeadSha?: string;
  /** Set when the scratch dir was deliberately kept during recovery. */
  retained?: ScratchPrepRetained;
}

export function scratchPrepMarkerPath(prNumber: number, repoDir: string): string {
  return join(mergeLaneStateDir(prNumber, repoDir), 'scratch-prep.json');
}

const CURRENT_MARKER_VERSION: 1 = 1;

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Write or advance the scratch-prep marker for a PR. Best-effort by default:
 * marker write failures never abort a merge (the caller-supplied `bestEffort`
 * flag controls this; the caller uses `bestEffort: false` for the `push`
 * marker so a failure fails closed to the block path).
 */
export async function writeScratchPrepMarker(
  repoDir: string,
  args: {
    prNumber: number;
    headBranch: string;
    phase: ScratchPrepPhase;
    headSha?: string;
    featureDir?: string;
    pid?: number;
    prepPgid?: number;
    worktreePath?: string;
    prePushSha?: string;
    rebasedHeadSha?: string;
    retained?: ScratchPrepRetained;
    now?: () => string;
  },
): Promise<ScratchPrepMarker> {
  const now = (args.now ?? nowIso)();
  const path = scratchPrepMarkerPath(args.prNumber, repoDir);
  return mutateJsonState<ScratchPrepMarker>(
    path,
    (current) => {
      const base: ScratchPrepMarker = current && current.version === CURRENT_MARKER_VERSION
        ? current
        : {
            version: CURRENT_MARKER_VERSION,
            prNumber: args.prNumber,
            headBranch: args.headBranch,
            phase: args.phase,
            phaseStartedAt: now,
            updatedAt: now,
            pid: args.pid ?? process.pid,
          };
      const phaseChanged = base.phase !== args.phase;
      return {
        ...base,
        version: CURRENT_MARKER_VERSION,
        prNumber: args.prNumber,
        headBranch: args.headBranch,
        headSha: args.headSha ?? base.headSha,
        featureDir: args.featureDir ?? base.featureDir,
        phase: args.phase,
        phaseStartedAt: phaseChanged ? now : base.phaseStartedAt,
        updatedAt: now,
        pid: args.pid ?? base.pid ?? process.pid,
        prepPgid: args.prepPgid ?? base.prepPgid,
        worktreePath: args.worktreePath ?? base.worktreePath,
        prePushSha: args.prePushSha ?? base.prePushSha,
        rebasedHeadSha: args.rebasedHeadSha ?? base.rebasedHeadSha,
        retained: args.retained ?? base.retained,
      };
    },
    {
      createIfMissing: true,
      initial: {
        version: CURRENT_MARKER_VERSION,
        prNumber: args.prNumber,
        headBranch: args.headBranch,
        phase: args.phase,
        phaseStartedAt: now,
        updatedAt: now,
        pid: args.pid ?? process.pid,
      },
    },
  );
}

/**
 * Best-effort marker write. On failure, logs a warning and continues. The
 * caller uses this for every phase EXCEPT the `push` marker, which must
 * fail-closed rather than push untracked (see writeScratchPrepMarker).
 */
export async function writeScratchPrepMarkerBestEffort(
  repoDir: string,
  args: Parameters<typeof writeScratchPrepMarker>[1],
): Promise<ScratchPrepMarker | null> {
  try {
    return await writeScratchPrepMarker(repoDir, args);
  } catch (error) {
    console.warn(
      `tend: failed to write scratch-prep marker for PR #${args.prNumber} phase=${args.phase}: ${errorMessage(error)}`,
    );
    return null;
  }
}

/**
 * Read the marker for a PR, or null when absent/unreadable. Never throws —
 * an unreadable marker is treated as "no known interrupted run" by callers.
 */
export function readScratchPrepMarker(repoDir: string, prNumber: number): ScratchPrepMarker | null {
  const path = scratchPrepMarkerPath(prNumber, repoDir);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const marker = parsed as ScratchPrepMarker;
    if (marker.version !== CURRENT_MARKER_VERSION) return null;
    if (typeof marker.prNumber !== 'number' || typeof marker.phase !== 'string') return null;
    return marker;
  } catch {
    return null;
  }
}

/**
 * Best-effort marker deletion. Merges have many terminal exit paths — the
 * marker must be cleared on every one so its survival is unambiguous
 * evidence of an interrupted run.
 */
export function clearScratchPrepMarkerBestEffort(repoDir: string, prNumber: number): void {
  const path = scratchPrepMarkerPath(prNumber, repoDir);
  try {
    rmSync(path, { force: true });
  } catch (error) {
    console.warn(
      `tend: failed to clear scratch-prep marker for PR #${prNumber}: ${errorMessage(error)}`,
    );
  }
}

/**
 * Scan every per-PR merge-lane directory for a scratch-prep marker. Missing
 * directory returns an empty list.
 */
export function listScratchPrepMarkers(repoDir: string): ScratchPrepMarker[] {
  const dir = join(repoDir, '.wavemill', 'merge-lane');
  if (!existsSync(dir)) return [];
  const markers: ScratchPrepMarker[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      const prNumber = Number(entry);
      if (!Number.isFinite(prNumber)) continue;
      const marker = readScratchPrepMarker(repoDir, prNumber);
      if (marker) markers.push(marker);
    }
  } catch {
    // Ignore: an unreadable merge-lane directory yields no markers.
  }
  return markers;
}

/**
 * Typed error raised by the process-group prep runner when the shared
 * end-to-end deadline expires. Carries the phase name (which prep step was
 * in flight when the deadline hit) and a bounded stdout/stderr excerpt.
 */
export class WorktreePrepTimeoutError extends Error {
  readonly phase: ScratchPrepPhase;
  readonly elapsedMs: number;
  readonly output: string;
  readonly pgid?: number;

  constructor(args: { phase: ScratchPrepPhase; elapsedMs: number; output: string; pgid?: number }) {
    super(`worktree prep timed out during ${args.phase} after ${args.elapsedMs}ms`);
    this.name = 'WorktreePrepTimeoutError';
    this.phase = args.phase;
    this.elapsedMs = args.elapsedMs;
    this.output = args.output;
    this.pgid = args.pgid;
  }
}

export interface ScratchPrepRunOptions {
  cwd: string;
  phase: ScratchPrepPhase;
  /**
   * Optional per-command deadline (ms). The runner picks the *smaller* of
   * this and the remaining shared deadline, so a caller can enforce both a
   * per-command guard and an end-to-end budget.
   */
  perCommandDeadlineMs?: number;
  /**
   * Called with the OS process-group id (pgid) as soon as the child spawns,
   * so callers can persist it for cross-process cleanup after a crash.
   */
  onSpawn?: (info: { pid: number; pgid: number }) => void;
}

export interface ScratchPrepRunner {
  run(cmd: string, opts: ScratchPrepRunOptions): Promise<string>;
  /** Remaining shared deadline (ms). Reads a monotonic clock. */
  remainingDeadlineMs(): number;
}

export interface CreateProcessGroupPrepRunnerOptions {
  /** End-to-end deadline for the whole preparation phase (ms). */
  deadlineMs: number;
  /** Monotonic clock in ms; defaults to `Date.now()`. */
  now?: () => number;
  /** Grace before escalating SIGTERM → SIGKILL (ms). Defaults to 5000. */
  killGraceMs?: number;
  /** Heartbeat interval while a command runs (ms). Defaults to 30000. */
  heartbeatIntervalMs?: number;
  /**
   * Called periodically while a command runs, and on every phase change.
   * Used by Tend to keep `backstage-health.json` heartbeats fresh during
   * long-but-healthy prep steps so the watchdog does not false-positively
   * respawn the loop.
   */
  onHeartbeat?: (info: { phase: ScratchPrepPhase; elapsedMs: number }) => void;
  /**
   * Injected process signaller for tests. Defaults to `process.kill`.
   * Signature matches Node's `process.kill(pid, signal)`.
   */
  signal?: (pid: number, signal: NodeJS.Signals | number) => boolean;
  /**
   * Injected spawn function for tests. Defaults to Node's `child_process.spawn`.
   * Kept as an escape hatch so tests can inject a fake without patching
   * `node:child_process` globally.
   */
  spawn?: typeof spawn;
  /**
   * Shell path for the child process. Defaults to '/bin/bash'. Kept
   * configurable for portability testing; the real prep commands are the
   * same shell strings the sync path already used.
   */
  shellPath?: string;
}

/**
 * Send a signal to every process in `pgid`. `process.kill(-pgid, sig)` is
 * the POSIX idiom for group-directed signals. Never throws — a group that
 * already exited yields ESRCH which we intentionally swallow.
 */
function killGroup(
  pgid: number,
  signal: NodeJS.Signals | number,
  signaller: (pid: number, sig: NodeJS.Signals | number) => boolean,
): void {
  try {
    signaller(-pgid, signal);
  } catch {
    // ESRCH (no such process) — the group has already exited. Nothing to do.
  }
}

/**
 * Create a bounded, process-group-aware prep runner. Each `run()` invocation
 * spawns `/bin/bash -c <cmd>` detached (leading a new process group), applies
 * the shared deadline plus optional per-command guard, and on expiry sends
 * SIGTERM then SIGKILL to `-pgid` so git's descendants die with the parent.
 */
export function createProcessGroupPrepRunner(options: CreateProcessGroupPrepRunnerOptions): ScratchPrepRunner {
  const startedAt = (options.now ?? Date.now)();
  const now = options.now ?? Date.now;
  const killGraceMs = options.killGraceMs ?? 5_000;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
  const spawnFn = options.spawn ?? spawn;
  const signaller = options.signal ?? ((pid, sig) => process.kill(pid, sig));
  const shellPath = options.shellPath ?? '/bin/bash';

  const remainingDeadlineMs = (): number => Math.max(0, options.deadlineMs - (now() - startedAt));

  const run = (cmd: string, opts: ScratchPrepRunOptions): Promise<string> => {
    const remaining = remainingDeadlineMs();
    if (remaining <= 0) {
      return Promise.reject(new WorktreePrepTimeoutError({
        phase: opts.phase,
        elapsedMs: now() - startedAt,
        output: '',
      }));
    }
    const commandDeadlineMs = typeof opts.perCommandDeadlineMs === 'number'
      ? Math.min(opts.perCommandDeadlineMs, remaining)
      : remaining;

    return new Promise<string>((resolve, reject) => {
      const child: ChildProcess = spawnFn(shellPath, ['-c', cmd], {
        cwd: opts.cwd,
        detached: true, // detached: true makes the child the leader of a new process group.
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const pid = typeof child.pid === 'number' ? child.pid : -1;
      const pgid = pid > 0 ? pid : -1;
      if (pgid > 0 && opts.onSpawn) {
        try {
          opts.onSpawn({ pid, pgid });
        } catch {
          // A caller-supplied onSpawn must not derail command execution.
        }
      }

      const chunks: Buffer[] = [];
      let capturedBytes = 0;
      const MAX_CAPTURED_BYTES = 32 * 1024;
      const captureChunk = (buf: Buffer): void => {
        if (capturedBytes >= MAX_CAPTURED_BYTES) return;
        const room = MAX_CAPTURED_BYTES - capturedBytes;
        const slice = buf.length > room ? buf.subarray(0, room) : buf;
        chunks.push(slice);
        capturedBytes += slice.length;
      };
      child.stdout?.on('data', captureChunk);
      child.stderr?.on('data', captureChunk);

      let settled = false;
      const cleanupTimers = (): void => {
        if (deadlineTimer !== null) clearTimeout(deadlineTimer);
        if (killTimer !== null) clearTimeout(killTimer);
        if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
      };

      let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

      const cmdStartedAt = now();
      if (options.onHeartbeat) {
        heartbeatTimer = setInterval(() => {
          if (settled) return;
          try {
            options.onHeartbeat?.({ phase: opts.phase, elapsedMs: now() - startedAt });
          } catch {
            // Heartbeat callback errors are swallowed — never let telemetry break prep.
          }
        }, heartbeatIntervalMs);
      }

      deadlineTimer = setTimeout(() => {
        if (settled) return;
        if (pgid > 0) killGroup(pgid, 'SIGTERM', signaller);
        killTimer = setTimeout(() => {
          if (settled) return;
          if (pgid > 0) killGroup(pgid, 'SIGKILL', signaller);
        }, killGraceMs);
      }, commandDeadlineMs);

      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) return;
        settled = true;
        cleanupTimers();
        const output = Buffer.concat(chunks).toString('utf-8');
        const elapsedMs = now() - startedAt;
        const deadlineHit = commandDeadlineMs <= (now() - cmdStartedAt);
        if (signal === 'SIGKILL' || signal === 'SIGTERM' || deadlineHit) {
          reject(new WorktreePrepTimeoutError({
            phase: opts.phase,
            elapsedMs,
            output,
            pgid: pgid > 0 ? pgid : undefined,
          }));
          return;
        }
        if (code !== 0) {
          const err = new Error(`prep command failed with exit ${code}${signal ? ` (signal ${signal})` : ''}: ${output.trim()}`) as Error & {
            exitCode?: number | null;
            stdout?: string;
            stderr?: string;
            phase?: ScratchPrepPhase;
          };
          err.exitCode = code;
          err.stdout = output;
          err.stderr = '';
          err.phase = opts.phase;
          reject(err);
          return;
        }
        resolve(output);
      };

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        cleanupTimers();
        reject(error);
      });
      child.on('exit', onExit);
    });
  };

  return { run, remainingDeadlineMs };
}

/**
 * Recovery decision table result. Every recovery outcome from
 * `reconcileScratchPrepState` is one of these variants.
 */
export type ScratchPrepReconcileOutcome =
  | { kind: 'none' }
  | { kind: 'active-run'; prNumber: number; pid: number; phase: ScratchPrepPhase }
  | { kind: 'recovered-retryable'; prNumber: number; phase: ScratchPrepPhase }
  | { kind: 'recovered-pushed'; prNumber: number }
  | { kind: 'finalized-merge'; prNumber: number }
  | { kind: 'recovery-uncertain'; prNumber: number; phase: ScratchPrepPhase; detail: string }
  | { kind: 'exhausted'; prNumber: number };

/** Phases with no possible remote mutation yet (safe to clean + retry). */
export const SAFE_PREP_PHASES: ReadonlySet<ScratchPrepPhase> = new Set<ScratchPrepPhase>([
  'reap',
  'fetch',
  'add',
  'ready',
]);

/**
 * Test whether the owning process is still alive. `process.kill(pid, 0)`
 * probes without delivering a signal — throws on ESRCH (dead) or EPERM
 * (alive under another uid). We treat EPERM as "alive" (fail-safe: never
 * touch a marker owned by a live process).
 */
export function isOwnerAlive(
  pid: number,
  signaller: (pid: number, signal: NodeJS.Signals | number) => boolean = ((p, s) => process.kill(p, s)),
): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    signaller(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    return false;
  }
}
