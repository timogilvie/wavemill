/**
 * Preflight runner and guard-fire record.
 *
 * `npm run test:preflight` used to be one `&&` chain: it stopped at the first
 * failing guard and left no trace of which one it was. This module runs every
 * guard in `tools/preflight-guards.txt`, prints each guard's output in list
 * order, and can write one record per run. `aggregateGuardFires` turns a set of
 * those records into per-guard counts, so retiring or merging a guard is
 * decided from how often it fires rather than from how many guards exist.
 *
 * @module preflight-runner
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { basename, join } from 'node:path';

export const PREFLIGHT_GUARD_LIST = 'tools/preflight-guards.txt';
export const PREFLIGHT_RUN_SCHEMA = 'wavemill.preflight-run/v1';

export interface GuardRunResult {
  /** Guard name: the tool's file name without `.ts`. */
  guard: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  /** First non-empty output line of a failing guard; empty when it passed. */
  summary: string;
}

export interface PreflightRunRecord {
  schema: typeof PREFLIGHT_RUN_SCHEMA;
  startedAt: string;
  durationMs: number;
  ok: boolean;
  guards: GuardRunResult[];
}

/** One guard path per line; blank lines and `#` comments are ignored. */
export function parseGuardList(text: string): string[] {
  const guards = text
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean);
  const duplicate = guards.find((guard, index) => guards.indexOf(guard) !== index);
  if (duplicate) throw new Error(`${PREFLIGHT_GUARD_LIST}: ${duplicate} is listed more than once`);
  return guards;
}

export function loadGuardList(repoDir: string): string[] {
  return parseGuardList(readFileSync(join(repoDir, PREFLIGHT_GUARD_LIST), 'utf-8'));
}

export interface GuardProcessResult {
  exitCode: number | null;
  output: string;
}

/** Runs one guard file and resolves with its exit code and combined output. */
export type GuardExecutor = (guardPath: string, repoDir: string) => Promise<GuardProcessResult>;

/** Spawn the guard with this process's own loader flags, so it runs under tsx when the runner does. */
export const spawnGuard: GuardExecutor = (guardPath, repoDir) => new Promise((resolve) => {
  const child = spawn(process.execPath, [...process.execArgv, join(repoDir, guardPath)], {
    cwd: repoDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.on('error', (error) => resolve({ exitCode: null, output: `${output}${error.message}\n` }));
  child.on('close', (exitCode) => resolve({ exitCode, output }));
});

export interface RunPreflightOptions {
  repoDir: string;
  guards: readonly string[];
  execute?: GuardExecutor;
  concurrency?: number;
  now?: () => number;
  /** Called once per guard, in list order, as soon as it and every earlier guard have finished. */
  onResult?: (result: GuardRunResult, output: string) => void;
}

/**
 * Run every guard, never stopping at a failure. Guards only read the tree, so
 * they run concurrently; results are reported in list order.
 */
export async function runPreflight(options: RunPreflightOptions): Promise<PreflightRunRecord> {
  const now = options.now ?? Date.now;
  const execute = options.execute ?? spawnGuard;
  const limit = Math.max(1, options.concurrency ?? Math.min(4, availableParallelism()));
  const started = now();
  const finished: Array<{ result: GuardRunResult; output: string } | undefined> = [];
  let next = 0;
  let reported = 0;

  const worker = async (): Promise<void> => {
    while (next < options.guards.length) {
      const index = next;
      next += 1;
      const guardPath = options.guards[index];
      const guardStarted = now();
      const { exitCode, output } = await execute(guardPath, options.repoDir);
      const ok = exitCode === 0;
      finished[index] = {
        output,
        result: {
          guard: basename(guardPath).replace(/\.ts$/, ''),
          ok,
          exitCode,
          durationMs: now() - guardStarted,
          summary: ok ? '' : (output.split('\n').find((line) => line.trim()) ?? '').trim().slice(0, 240),
        },
      };
      while (finished[reported]) {
        const done = finished[reported]!;
        options.onResult?.(done.result, done.output);
        reported += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, options.guards.length) }, worker));

  const guards = finished.map((entry) => entry!.result);
  return {
    schema: PREFLIGHT_RUN_SCHEMA,
    startedAt: new Date(started).toISOString(),
    durationMs: now() - started,
    ok: guards.every((guard) => guard.ok),
    guards,
  };
}

/** A Markdown block for the GitHub step summary: which guards failed, and their first line. */
export function formatStepSummary(record: PreflightRunRecord): string {
  const failed = record.guards.filter((guard) => !guard.ok);
  if (failed.length === 0) return `### Preflight: ${record.guards.length} guards passed\n`;
  return [
    `### Preflight: ${failed.length} of ${record.guards.length} guards failed`,
    '',
    '| Guard | First line |',
    '| -- | -- |',
    ...failed.map((guard) => `| \`${guard.guard}\` | ${guard.summary.replace(/\|/g, '\\|')} |`),
    '',
  ].join('\n');
}

/** A record plus where it came from, for aggregation across CI runs. */
export interface SourcedPreflightRun {
  record: PreflightRunRecord;
  /** Branch (or any grouping label) the run belongs to. */
  branch: string;
}

export interface GuardFireStats {
  guard: string;
  runs: number;
  failures: number;
  /** Distinct branches on which the guard failed at least once. */
  branchesFailed: number;
  /** Failures that were the only failing guard in their run. */
  soleFailures: number;
  medianDurationMs: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.floor((sorted.length - 1) / 2)];
}

export function isPreflightRunRecord(value: unknown): value is PreflightRunRecord {
  const record = value as Partial<PreflightRunRecord> | null;
  return record?.schema === PREFLIGHT_RUN_SCHEMA && Array.isArray(record.guards);
}

/** Per-guard counts across runs, most-fired first; guards that never fired sort last by name. */
export function aggregateGuardFires(runs: readonly SourcedPreflightRun[]): GuardFireStats[] {
  const byGuard = new Map<string, { durations: number[]; failures: number; sole: number; branches: Set<string> }>();
  for (const { record, branch } of runs) {
    const failedInRun = record.guards.filter((guard) => !guard.ok).length;
    for (const guard of record.guards) {
      const stats = byGuard.get(guard.guard) ?? { durations: [], failures: 0, sole: 0, branches: new Set<string>() };
      stats.durations.push(guard.durationMs);
      if (!guard.ok) {
        stats.failures += 1;
        stats.branches.add(branch);
        if (failedInRun === 1) stats.sole += 1;
      }
      byGuard.set(guard.guard, stats);
    }
  }
  return [...byGuard]
    .map(([guard, stats]) => ({
      guard,
      runs: stats.durations.length,
      failures: stats.failures,
      branchesFailed: stats.branches.size,
      soleFailures: stats.sole,
      medianDurationMs: median(stats.durations),
    }))
    .sort((a, b) => b.failures - a.failures || a.guard.localeCompare(b.guard));
}

export function formatGuardFireReport(stats: readonly GuardFireStats[], runCount: number): string {
  const fired = stats.filter((row) => row.failures > 0);
  const quiet = stats.filter((row) => row.failures === 0);
  const lines = [`Guard fires across ${runCount} preflight run(s): ${fired.length} guard(s) fired, ${quiet.length} never fired.`, ''];
  if (fired.length > 0) {
    lines.push('guard\tfailures\truns\tbranches\tsole-failure\tmedian-ms');
    for (const row of fired) {
      lines.push(`${row.guard}\t${row.failures}\t${row.runs}\t${row.branchesFailed}\t${row.soleFailures}\t${row.medianDurationMs}`);
    }
    lines.push('');
  }
  if (quiet.length > 0) lines.push(`Never fired: ${quiet.map((row) => row.guard).join(', ')}`);
  return lines.join('\n');
}
