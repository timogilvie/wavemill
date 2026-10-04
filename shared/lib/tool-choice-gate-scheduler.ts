/**
 * Daily scheduler for the tool-choice gate (HOK-3123).
 *
 * `runTendLoop` calls `maybeRunToolChoiceGate` alongside its poll heartbeat.
 * Once every `TOOL_CHOICE_GATE_INTERVAL_MS` (24h) the scheduler spawns
 * `tools/publish-tool-choice-gate.ts` as a detached child, redirecting
 * stdout/stderr to `.wavemill/tool-decisions/last-run.log`, then updates
 * `.wavemill/backstage-health.json → services.toolChoiceGate` with the
 * progress line for the dashboard/status pane.
 *
 * Failures never fail the tend poll: the scheduler catches every error and
 * records it in the health entry so the loop keeps running (mirrors the
 * pattern used by `reconcileScratchPrepState`).
 */

import { spawn, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mutateJsonState } from './state-mutex.ts';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** 24 hours. Overridable in tests via env `TOOL_CHOICE_GATE_INTERVAL_MS`. */
export const TOOL_CHOICE_GATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** How often the scheduler checks staleness inside `runTendLoop`. */
export const TOOL_CHOICE_GATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** Hard timeout for the child publish process. The analyzer itself is fast. */
export const TOOL_CHOICE_GATE_CHILD_TIMEOUT_MS = 10 * 60 * 1000;

export type ToolChoiceGateRunStatus = 'ok' | 'artifacts-only' | 'error';

export interface ToolChoiceGateSchedulerDeps {
  now: () => Date;
  spawn: typeof spawn;
  log: (line: string) => void;
}

export interface MaybeRunToolChoiceGateOptions {
  repoDir: string;
  /** In-process cache: only check staleness once per interval. */
  lastCheckedMs?: number;
  intervalMs?: number;
  checkIntervalMs?: number;
  deps?: Partial<ToolChoiceGateSchedulerDeps>;
}

export interface MaybeRunToolChoiceGateResult {
  ran: boolean;
  skipped?: 'fresh' | 'locked' | 'checked-recently' | 'no-key';
  status?: ToolChoiceGateRunStatus;
  detail?: string;
  progressLine?: string;
  computedRecommendation?: 'go' | 'no-go' | 'inconclusive';
  /** Updated `lastCheckedMs` for the caller to remember. */
  nextLastCheckedMs: number;
}

function defaultDeps(): ToolChoiceGateSchedulerDeps {
  return {
    now: () => new Date(),
    spawn,
    log: (line) => console.error(line),
  };
}

function resolveIntervalMs(override?: number): number {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) return override;
  const envValue = Number(process.env.TOOL_CHOICE_GATE_INTERVAL_MS);
  if (Number.isFinite(envValue) && envValue > 0) return envValue;
  return TOOL_CHOICE_GATE_INTERVAL_MS;
}

function resolveCheckIntervalMs(override?: number): number {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) return override;
  return TOOL_CHOICE_GATE_CHECK_INTERVAL_MS;
}

function readSnapshotUpdatedAtMs(repoDir: string): number | null {
  const jsonPath = join(repoDir, '.wavemill', 'tool-decisions', 'latest-gate.json');
  if (!existsSync(jsonPath)) return null;
  try {
    const raw = readFileSync(jsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as { updatedAt?: string };
    if (typeof parsed.updatedAt !== 'string') return null;
    const parsedMs = Date.parse(parsed.updatedAt);
    return Number.isFinite(parsedMs) ? parsedMs : null;
  } catch {
    return null;
  }
}

interface HealthWriteOptions {
  status: ToolChoiceGateRunStatus | 'skipped';
  detail?: string;
  progressLine?: string;
  computedRecommendation?: string;
  lastRunAt?: string;
}

async function writeHealth(repoDir: string, now: string, opts: HealthWriteOptions): Promise<void> {
  const healthPath = join(repoDir, '.wavemill', 'backstage-health.json');
  await mutateJsonState<{
    updatedAt?: string;
    services?: Record<string, Record<string, unknown>>;
    [key: string]: unknown;
  }>(
    healthPath,
    (current) => {
      const next = { ...(current ?? {}) };
      const services = { ...(next.services ?? {}) };
      const existing = { ...(services.toolChoiceGate ?? {}) };
      services.toolChoiceGate = {
        ...existing,
        updatedAt: now,
        lastRunStatus: opts.status,
        ...(opts.detail !== undefined ? { lastRunDetail: opts.detail } : {}),
        ...(opts.progressLine !== undefined ? { progressLine: opts.progressLine } : {}),
        ...(opts.computedRecommendation !== undefined
          ? { computedRecommendation: opts.computedRecommendation }
          : {}),
        ...(opts.lastRunAt !== undefined ? { lastRunAt: opts.lastRunAt } : {}),
      };
      next.services = services;
      return next;
    },
    { createIfMissing: true, initial: {} },
  );
}

interface RunPublishArgs {
  repoDir: string;
  logPath: string;
  timeoutMs: number;
  deps: ToolChoiceGateSchedulerDeps;
}

interface RunPublishResult {
  exitCode: number | null;
  timedOut: boolean;
  errorMessage?: string;
}

async function runPublishChild(args: RunPublishArgs): Promise<RunPublishResult> {
  const { logPath, timeoutMs, deps, repoDir } = args;
  mkdirSync(join(repoDir, '.wavemill', 'tool-decisions'), { recursive: true });
  let logFd: number;
  try {
    logFd = openSync(logPath, 'a');
  } catch (error) {
    return {
      exitCode: null,
      timedOut: false,
      errorMessage: `unable to open log ${logPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const toolPath = resolve(MODULE_DIR, '..', '..', 'tools', 'publish-tool-choice-gate.ts');
  const spawnOptions: SpawnOptions = {
    cwd: repoDir,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  };

  return await new Promise<RunPublishResult>((resolvePromise) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = deps.spawn('npx', ['tsx', toolPath, '--repo-dir', repoDir], spawnOptions);
    } catch (error) {
      resolvePromise({
        exitCode: null,
        timedOut: false,
        errorMessage: `spawn failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    let settled = false;
    const finalize = (result: RunPublishResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      finalize({
        exitCode: null,
        timedOut: true,
        errorMessage: `child timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);
    child.once('error', (error) => {
      finalize({
        exitCode: null,
        timedOut: false,
        errorMessage: `child error: ${error.message}`,
      });
    });
    child.once('exit', (code) => {
      finalize({ exitCode: code, timedOut: false });
    });
  });
}

/**
 * Called from `runTendLoop` after the poll heartbeat. Cheap when nothing
 * needs doing: an in-memory `lastCheckedMs` gates staleness checks to at
 * most once per hour, and the file-based check reads a single small JSON.
 */
export async function maybeRunToolChoiceGate(
  options: MaybeRunToolChoiceGateOptions,
): Promise<MaybeRunToolChoiceGateResult> {
  const deps = { ...defaultDeps(), ...(options.deps ?? {}) };
  const intervalMs = resolveIntervalMs(options.intervalMs);
  const checkIntervalMs = resolveCheckIntervalMs(options.checkIntervalMs);
  const nowMs = deps.now().getTime();
  const nowIso = deps.now().toISOString();

  if (
    typeof options.lastCheckedMs === 'number' &&
    nowMs - options.lastCheckedMs < checkIntervalMs
  ) {
    return {
      ran: false,
      skipped: 'checked-recently',
      nextLastCheckedMs: options.lastCheckedMs,
    };
  }

  const updatedAtMs = readSnapshotUpdatedAtMs(options.repoDir);
  if (updatedAtMs !== null && nowMs - updatedAtMs < intervalMs) {
    return { ran: false, skipped: 'fresh', nextLastCheckedMs: nowMs };
  }

  const hasKey =
    typeof process.env.LINEAR_API_KEY === 'string' && process.env.LINEAR_API_KEY !== '';
  const logPath = join(options.repoDir, '.wavemill', 'tool-decisions', 'last-run.log');
  const runResult = await runPublishChild({
    repoDir: options.repoDir,
    logPath,
    timeoutMs: TOOL_CHOICE_GATE_CHILD_TIMEOUT_MS,
    deps,
  });

  let status: ToolChoiceGateRunStatus;
  let detail: string;
  if (runResult.timedOut) {
    status = 'error';
    detail = runResult.errorMessage ?? 'child timed out';
  } else if (runResult.exitCode === 0) {
    status = hasKey ? 'ok' : 'artifacts-only';
    detail = hasKey ? 'artifacts refreshed and Linear document updated' : 'LINEAR_API_KEY unset';
  } else if (runResult.exitCode === 2) {
    status = 'artifacts-only';
    detail = runResult.errorMessage ?? 'Linear publish failed; local artifacts refreshed';
  } else {
    status = 'error';
    detail =
      runResult.errorMessage ??
      `child exited with code ${runResult.exitCode ?? 'null'} (see ${logPath})`;
  }

  const snapshotMsAfter = readSnapshotUpdatedAtMs(options.repoDir);
  let progressLine: string | undefined;
  let computedRecommendation: 'go' | 'no-go' | 'inconclusive' | undefined;
  if (snapshotMsAfter !== null) {
    try {
      const raw = readFileSync(
        join(options.repoDir, '.wavemill', 'tool-decisions', 'latest-gate.json'),
        'utf-8',
      );
      const parsed = JSON.parse(raw) as {
        progressLine?: string;
        computedRecommendation?: 'go' | 'no-go' | 'inconclusive';
      };
      progressLine = parsed.progressLine;
      computedRecommendation = parsed.computedRecommendation;
    } catch {
      // ignore — health entry survives without them
    }
  }

  try {
    await writeHealth(options.repoDir, nowIso, {
      status,
      detail,
      progressLine,
      computedRecommendation,
      lastRunAt: nowIso,
    });
  } catch (error) {
    deps.log(
      `tool-choice-gate: failed to write health entry: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return {
    ran: true,
    status,
    detail,
    ...(progressLine !== undefined ? { progressLine } : {}),
    ...(computedRecommendation !== undefined ? { computedRecommendation } : {}),
    nextLastCheckedMs: nowMs,
  };
}
