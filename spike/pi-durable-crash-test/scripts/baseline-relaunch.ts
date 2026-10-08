// HOK-3150 §3.4: baseline — today's recovery semantics (fresh conversation,
// new storage, same task). Measures the ratio of (crash+resume) to
// (crash+fresh-relaunch) tokens and wall-clock for gate 4.
//
// This spike runs the baseline with the faux provider (no real tokens),
// so the baseline's "cost" is the faux usage counter output and wall-clock
// only. For real-provider measurements, swap the faux provider for the
// openrouter/openai provider and run the same scenarios with a single
// cheap certified model.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFixtureTask } from '../src/fixture-task.ts';
import os from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SPIKE_ROOT = path.resolve(__dirname, '..');

const PATCH_FILES = [
  { path: 'src/a.ts', text: 'export function greet(n:string){return `Hello, ${n}!`;}\n' },
  { path: 'src/index.ts', text: "export const SEED=true;\nexport { greet } from './a.ts';\n" },
];
const COMPLETION_JSON = JSON.stringify({ stage: 'coding', confidence: 'high' });

const SCRIPT = [
  { kind: 'tool', name: 'list_files', args: { path: 'src' } },
  { kind: 'tool', name: 'read_file', args: { path: 'src/index.ts' } },
  { kind: 'tool', name: 'apply_patch', args: { files: PATCH_FILES } },
  { kind: 'tool', name: 'write_artifact', args: { path: 'features/spike-multi-file/.coding-complete', text: COMPLETION_JSON } },
  { kind: 'text', text: 'done' },
];

type Point = 'A' | 'C1';

interface BaselineResult {
  readonly point: Point;
  readonly trial: number;
  readonly resumeWallMs: number;
  readonly relaunchWallMs: number;
  readonly resumeReached: boolean;
  readonly relaunchReached: boolean;
}

async function runPointBoth(point: Point, trial: number): Promise<BaselineResult> {
  // --- Resume path (identical to crash-harness) ---
  const r = await runWithPolicy(point, trial, { mode: 'resume' });
  // --- Relaunch path: new SQLite file, no recovery; a FRESH conversation ---
  const l = await runWithPolicy(point, trial, { mode: 'relaunch' });

  return {
    point,
    trial,
    resumeWallMs: r.wallMs,
    relaunchWallMs: l.wallMs,
    resumeReached: r.reached,
    relaunchReached: l.reached,
  };
}

async function runWithPolicy(
  point: Point,
  trial: number,
  mode: { mode: 'resume' | 'relaunch' },
): Promise<{ wallMs: number; reached: boolean }> {
  const fixture = await createFixtureTask();
  const dbPath = path.join(fixture.scratch, 'session.sqlite');
  const readyFile = path.join(fixture.scratch, '.crash-ready');
  const execLog = path.join(fixture.scratch, 'execlog.jsonl');
  const scriptFile = path.join(fixture.scratch, 'faux-script.json');
  await writeFile(scriptFile, JSON.stringify(SCRIPT), 'utf8');

  const t0 = Date.now();
  // Launch 1: fresh, with crash
  const c1 = spawn('node', [
    '--import', path.join(SPIKE_ROOT, 'node_modules/tsx/dist/loader.mjs'),
    path.join(SPIKE_ROOT, 'scripts/run-arm.ts'),
  ], {
    cwd: SPIKE_ROOT,
    env: {
      ...process.env,
      HOK3150_DB_PATH: dbPath,
      HOK3150_WORKTREE: fixture.worktree,
      HOK3150_FEATURE_DIR: fixture.featureDir,
      HOK3150_READY_FILE: readyFile,
      HOK3150_EXEC_LOG: execLog,
      HOK3150_FAUX_SCRIPT: scriptFile,
      HOK3150_REQUEST_ID: `baseline:${mode.mode}:${point}:${trial}`,
      HOK3150_CRASH_POINT: point,
      HOK3150_MODE: 'fresh',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const killStart = Date.now();
  while (Date.now() - killStart < 30_000) {
    if (existsSync(readyFile)) { try { c1.kill('SIGKILL'); } catch {} ; break; }
    await delay(50);
  }
  await new Promise<void>((resolve) => {
    if (c1.exitCode !== null || c1.signalCode !== null) {
      resolve();
    } else {
      c1.once('exit', () => resolve());
    }
  });

  // Launch 2 — resume vs relaunch differ only here.
  const dbForLaunch2 = mode.mode === 'resume' ? dbPath : path.join(fixture.scratch, 'relaunch.sqlite');
  const c2 = spawn('node', [
    '--import', path.join(SPIKE_ROOT, 'node_modules/tsx/dist/loader.mjs'),
    path.join(SPIKE_ROOT, 'scripts/run-arm.ts'),
  ], {
    cwd: SPIKE_ROOT,
    env: {
      ...process.env,
      HOK3150_DB_PATH: dbForLaunch2,
      HOK3150_WORKTREE: fixture.worktree,
      HOK3150_FEATURE_DIR: fixture.featureDir,
      HOK3150_READY_FILE: path.join(fixture.scratch, '.ignored'),
      HOK3150_EXEC_LOG: execLog,
      HOK3150_FAUX_SCRIPT: scriptFile,
      HOK3150_REQUEST_ID: mode.mode === 'resume'
        ? `baseline:${mode.mode}:${point}:${trial}`
        : `baseline:${mode.mode}:${point}:${trial}:fresh`,
      HOK3150_CRASH_POINT: 'none',
      HOK3150_MODE: mode.mode,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((resolve) => c2.once('exit', () => resolve()));

  const wallMs = Date.now() - t0;
  const reached = existsSync(path.join(fixture.worktree, 'features/spike-multi-file/.coding-complete'));
  await rm(fixture.scratch, { recursive: true, force: true }).catch(() => {});
  return { wallMs, reached };
}

function delay(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

async function readHistoricalRelaunchData(): Promise<{ avgRelaunchMs: number | null; count: number; notes: string[] }> {
  const notes: string[] = [];
  try {
    const wavemillDir = path.join(os.homedir(), '.wavemill', 'native-sessions');
    if (!existsSync(wavemillDir)) {
      notes.push('No .wavemill/native-sessions directory found');
      return { avgRelaunchMs: null, count: 0, notes };
    }

    // Read all .json files in the sessions dir looking for relaunch entries
    const files = await readdir(wavemillDir);
    const relaunchDurations: number[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const sessionPath = path.join(wavemillDir, file);
        const data = JSON.parse(await readFile(sessionPath, 'utf8'));

        // Look for session records with relaunch timing info
        // Format varies, but typically has createdAt, relaunches[], or similar
        if (data.relaunches && Array.isArray(data.relaunches)) {
          for (const relaunch of data.relaunches) {
            if (relaunch.durationMs) {
              relaunchDurations.push(relaunch.durationMs);
            }
          }
        }
        // Also check for top-level timestamps indicating relaunch scenarios
        if (data.createdAt && data.relaunched && data.durationMs) {
          relaunchDurations.push(data.durationMs);
        }
      } catch (e) {
        // Skip malformed files
      }
    }

    if (relaunchDurations.length === 0) {
      notes.push('No historical relaunch data found in .wavemill/native-sessions');
      return { avgRelaunchMs: null, count: 0, notes };
    }

    const avgRelaunchMs = Math.round(
      relaunchDurations.reduce((a, b) => a + b, 0) / relaunchDurations.length
    );
    notes.push(`Found ${relaunchDurations.length} historical relaunch(es), avg ${avgRelaunchMs}ms`);

    return { avgRelaunchMs, count: relaunchDurations.length, notes };
  } catch (e) {
    notes.push(`Error reading historical data: ${(e as Error).message}`);
    return { avgRelaunchMs: null, count: 0, notes };
  }
}

async function main() {
  const points: Point[] = ['A', 'C1'];
  const trials = 3;
  const outDir = path.join(SPIKE_ROOT, 'results');
  await mkdir(outDir, { recursive: true });

  const all: BaselineResult[] = [];
  for (const point of points) {
    for (let i = 1; i <= trials; i += 1) {
      process.stderr.write(`[baseline] ${point} trial ${i}/${trials}...\n`);
      const r = await runPointBoth(point, i);
      all.push(r);
      process.stderr.write(`  → resume ${r.resumeWallMs}ms (reached=${r.resumeReached}) relaunch ${r.relaunchWallMs}ms (reached=${r.relaunchReached})\n`);
    }
  }

  // Aggregate
  const summary: Record<string, { trials: number; resumeMsP50: number; relaunchMsP50: number; ratio: number; resumeReachedAll: boolean; relaunchReachedAll: boolean }> = {};
  for (const point of points) {
    const forPoint = all.filter((r) => r.point === point);
    const r50 = median(forPoint.map((r) => r.resumeWallMs));
    const l50 = median(forPoint.map((r) => r.relaunchWallMs));
    summary[point] = {
      trials: forPoint.length,
      resumeMsP50: r50,
      relaunchMsP50: l50,
      ratio: r50 / l50,
      resumeReachedAll: forPoint.every((r) => r.resumeReached),
      relaunchReachedAll: forPoint.every((r) => r.relaunchReached),
    };
  }

  // Read historical relaunch data for sanity check
  const historicalData = await readHistoricalRelaunchData();

  const output = {
    summary,
    trials: all,
    historicalBaseline: historicalData,
  };

  await writeFile(
    path.join(outDir, 'baseline-summary.json'),
    JSON.stringify(output, null, 2) + '\n',
    'utf8',
  );
  console.log(JSON.stringify(summary, null, 2));
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

main().catch((err) => {
  console.error('baseline failed:', err);
  process.exit(2);
});
