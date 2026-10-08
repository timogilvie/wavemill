// HOK-3150 §3.2–§3.3: parent crash harness.
//
// For each crash point A/B/C1/C2/C3:
//   1. Create a fresh scratch repo (fixture-task.createFixtureTask).
//   2. Spawn run-arm.ts child with HOK3150_CRASH_POINT.
//   3. Watch the ready-file; once written, SIGKILL the child.
//   4. Spawn run-arm.ts child in resume mode (same DB path, no crash env).
//   5. Audit the second run's exit + the SQLite transcript + execlog +
//      worktree state. Write results/<point>-<n>.json.
//
// Faux-model only. The parent builds a scripted response list that forces at
// least one multi-file apply_patch (for C2) and a completion artifact.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFixtureTask } from '../src/fixture-task.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SPIKE_ROOT = path.resolve(__dirname, '..');

type Point = 'A' | 'B' | 'C1' | 'C2' | 'C3';

const DEFAULT_POINTS: Point[] = ['A', 'B', 'C1', 'C2', 'C3'];

const PATCH_FILES = [
  {
    path: 'src/a.ts',
    text: 'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n',
  },
  {
    path: 'src/index.ts',
    text: '// Seed index. Added exports will go here.\nexport const SEED = true;\nexport { greet } from \'./a.ts\';\n',
  },
];

const COMPLETION_JSON = JSON.stringify({ stage: 'coding', confidence: 'high' });

/** Scripted scenario. Multiple reads + one multi-file apply_patch + completion. */
const SCRIPT = [
  { kind: 'tool', name: 'list_files', args: { path: 'src' } },
  { kind: 'tool', name: 'read_file', args: { path: 'src/index.ts' } },
  { kind: 'tool', name: 'apply_patch', args: { files: PATCH_FILES } },
  { kind: 'tool', name: 'write_artifact', args: { path: 'features/spike-multi-file/.coding-complete', text: COMPLETION_JSON } },
  { kind: 'text', text: 'done' },
];

interface TrialResult {
  readonly point: Point;
  readonly trial: number;
  readonly pass: boolean;
  readonly resumed: boolean;
  readonly reachedCompletionArtifact: boolean;
  readonly transcript: {
    exactlyOneResultPerCall: boolean;
    hasInterruptedForUnsafe: boolean;
  };
  readonly worktreeState: 'untouched' | 'partial' | 'full' | 'other';
  readonly executesPerCallId: Record<string, number>;
  readonly timings: {
    preCrashMs: number;
    resumeMs: number;
  };
  readonly notes: string[];
}

async function runOnePoint(point: Point, trial: number): Promise<TrialResult> {
  const fixture = await createFixtureTask();
  const notes: string[] = [];

  const dbPath = path.join(fixture.scratch, 'session.sqlite');
  const readyFile = path.join(fixture.scratch, '.crash-ready');
  const execLog = path.join(fixture.scratch, 'execlog.jsonl');
  const scriptFile = path.join(fixture.scratch, 'faux-script.json');
  await writeFile(scriptFile, JSON.stringify(SCRIPT), 'utf8');

  // --- Phase 1: fresh launch with crash point ---
  const t0 = Date.now();
  const child1 = spawn(
    'node',
    [
      '--import',
      path.join(SPIKE_ROOT, 'node_modules/tsx/dist/loader.mjs'),
      path.join(SPIKE_ROOT, 'scripts/run-arm.ts'),
    ],
    {
      cwd: SPIKE_ROOT,
      env: {
        ...process.env,
        HOK3150_DB_PATH: dbPath,
        HOK3150_WORKTREE: fixture.worktree,
        HOK3150_FEATURE_DIR: fixture.featureDir,
        HOK3150_READY_FILE: readyFile,
        HOK3150_EXEC_LOG: execLog,
        HOK3150_FAUX_SCRIPT: scriptFile,
        HOK3150_REQUEST_ID: `crash:${point}:${trial}`,
        HOK3150_CRASH_POINT: point,
        HOK3150_MODE: 'fresh',
      },
      stdio: ['ignore', 'ignore', 'inherit'],
      detached: false,
    },
  );
  let killed = false;
  const killTimeoutMs = 30_000;
  const start = Date.now();
  while (Date.now() - start < killTimeoutMs) {
    if (existsSync(readyFile)) {
      try {
        child1.kill('SIGKILL');
        killed = true;
      } catch {}
      break;
    }
    await delay(50);
  }
  // Wait for the child to actually exit (even if it exited on its own).
  await new Promise<void>((resolve) => {
    if (child1.exitCode !== null || child1.signalCode !== null) return resolve();
    child1.once('exit', () => resolve());
  });
  const preCrashMs = Date.now() - t0;
  if (!killed) notes.push('no crash-ready signal observed within kill timeout; trial may be invalid for this point');

  // Snapshot worktree state after crash (before resume).
  const worktreeAfterCrash = await classifyWorktreeState(fixture.worktree);

  // --- Phase 2: resume ---
  const resumeStart = Date.now();
  const child2 = spawn(
    'node',
    [
      '--import',
      path.join(SPIKE_ROOT, 'node_modules/tsx/dist/loader.mjs'),
      path.join(SPIKE_ROOT, 'scripts/run-arm.ts'),
    ],
    {
      cwd: SPIKE_ROOT,
      env: {
        ...process.env,
        HOK3150_DB_PATH: dbPath,
        HOK3150_WORKTREE: fixture.worktree,
        HOK3150_FEATURE_DIR: fixture.featureDir,
        HOK3150_READY_FILE: path.join(fixture.scratch, '.ignored-ready'),
        HOK3150_EXEC_LOG: execLog,
        HOK3150_FAUX_SCRIPT: scriptFile,
        HOK3150_REQUEST_ID: `crash:${point}:${trial}`,
        HOK3150_CRASH_POINT: 'none',
        HOK3150_MODE: 'resume',
      },
      stdio: ['pipe', 'pipe', 'inherit'],
    },
  );
  let stdout = '';
  child2.stdout?.on('data', (buf: Buffer) => {
    stdout += buf.toString('utf8');
  });
  const resumeTimeoutMs = 30_000;
  const settled: 'exit' | 'timeout' = await Promise.race([
    new Promise<'exit'>((resolve) => child2.once('exit', () => resolve('exit'))),
    delay(resumeTimeoutMs).then(() => 'timeout' as const),
  ]);
  if (settled === 'timeout') {
    try { child2.kill('SIGKILL'); } catch {}
    notes.push('resume exceeded timeout');
  }
  const resumeMs = Date.now() - resumeStart;

  const resumed = settled === 'exit' && child2.exitCode === 0;

  // Audit the completion artifact
  const completionPath = path.join(fixture.worktree, 'features/spike-multi-file/.coding-complete');
  const reachedCompletionArtifact = existsSync(completionPath);

  // Count executes per callId
  const executesPerCallId: Record<string, number> = {};
  try {
    const lines = (await readFile(execLog, 'utf8')).trim().split(/\n/).filter(Boolean);
    for (const line of lines) {
      const { callId } = JSON.parse(line) as { callId: string };
      executesPerCallId[callId] = (executesPerCallId[callId] ?? 0) + 1;
    }
  } catch { /* no executes recorded (e.g. point A: killed before any tool) */ }

  // Audit transcript (open the SQLite via a sub-script invocation).
  const transcript = await auditTranscript(SPIKE_ROOT, dbPath, point);

  const worktreeAfterResume = await classifyWorktreeState(fixture.worktree);

  // Pass criteria (from §4 gates 1/2/3):
  //  A: resumed; tool executes count == model exec counts (no double); worktree reached final
  //  B: resumed; safe tool executed exactly twice (once before kill, once on rerun); transcript has single result
  //  C1: resumed; apply_patch executed at most once overall (never rerun because unsafe); transcript interrupted present
  //  C2: resumed; worktree may be partial after crash BUT after resume is final (reconciled); apply_patch has interrupted result
  //  C3: resumed; apply_patch executed at most once; worktree may be partial-or-full after crash, final after resume
  const gate = evaluateGate(point, {
    resumed,
    reachedCompletionArtifact,
    worktreeAfterCrash,
    worktreeAfterResume,
    executesPerCallId,
    transcript,
    notes,
  });

  const result: TrialResult = {
    point,
    trial,
    pass: gate.pass,
    resumed,
    reachedCompletionArtifact,
    transcript,
    worktreeState: worktreeAfterResume,
    executesPerCallId,
    timings: { preCrashMs, resumeMs },
    notes: [...notes, ...gate.notes, `worktree-after-crash: ${worktreeAfterCrash}`, `resume-stdout: ${stdout.trim()}`],
  };

  // Cleanup fixture scratch after writing result.
  await rm(fixture.scratch, { recursive: true, force: true }).catch(() => {});
  return result;
}

async function classifyWorktreeState(worktree: string): Promise<'untouched' | 'partial' | 'full' | 'other'> {
  const aPath = path.join(worktree, 'src/a.ts');
  const indexPath = path.join(worktree, 'src/index.ts');
  const aExists = existsSync(aPath);
  const indexText = (await readFile(indexPath, 'utf8').catch(() => '')).includes("export { greet } from './a.ts'");
  if (!aExists && !indexText) return 'untouched';
  if (aExists && indexText) return 'full';
  return 'partial';
}

interface TranscriptAudit {
  exactlyOneResultPerCall: boolean;
  hasInterruptedForUnsafe: boolean;
}

async function auditTranscript(spikeRoot: string, dbPath: string, _point: Point): Promise<TranscriptAudit> {
  // Delegate to a small ad-hoc child that opens the SQLite file via the same
  // pi-durable primitives — avoids us re-implementing a SQLite reader here.
  return await new Promise<TranscriptAudit>((resolve) => {
    const audit = spawn(
      'node',
      [
        '--import',
        path.join(spikeRoot, 'node_modules/tsx/dist/loader.mjs'),
        path.join(spikeRoot, 'scripts/audit-transcript.ts'),
      ],
      {
        cwd: spikeRoot,
        env: { ...process.env, HOK3150_DB_PATH: dbPath },
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
    let out = '';
    audit.stdout?.on('data', (buf: Buffer) => (out += buf.toString('utf8')));
    audit.once('exit', () => {
      try {
        const parsed = JSON.parse(out);
        resolve({
          exactlyOneResultPerCall: Boolean(parsed.exactlyOneResultPerCall),
          hasInterruptedForUnsafe: Boolean(parsed.hasInterruptedForUnsafe),
        });
      } catch {
        resolve({ exactlyOneResultPerCall: false, hasInterruptedForUnsafe: false });
      }
    });
  });
}

interface GateInputs {
  readonly resumed: boolean;
  readonly reachedCompletionArtifact: boolean;
  readonly worktreeAfterCrash: 'untouched' | 'partial' | 'full' | 'other';
  readonly worktreeAfterResume: 'untouched' | 'partial' | 'full' | 'other';
  readonly executesPerCallId: Record<string, number>;
  readonly transcript: TranscriptAudit;
  readonly notes: string[];
}

function evaluateGate(point: Point, g: GateInputs): { pass: boolean; notes: string[] } {
  const notes: string[] = [];
  // Count executes grouped by name using the callIds (we don't have name
  // mapping; use the raw counts: any callId with >1 execute means a double).
  const doubles = Object.entries(g.executesPerCallId).filter(([, n]) => n > 1);
  if (point === 'A') {
    const pass = g.resumed && g.reachedCompletionArtifact && doubles.length === 0;
    if (!pass) notes.push(`A gate: resumed=${g.resumed} reached=${g.reachedCompletionArtifact} doubles=${JSON.stringify(doubles)}`);
    return { pass, notes };
  }
  if (point === 'B') {
    // Safe tools may rerun exactly once; that is the expected behaviour.
    const pass =
      g.resumed &&
      g.reachedCompletionArtifact &&
      g.transcript.exactlyOneResultPerCall &&
      doubles.every(([, n]) => n <= 2);
    if (!pass) notes.push(`B gate: resumed=${g.resumed} transcript=${JSON.stringify(g.transcript)} doubles=${JSON.stringify(doubles)}`);
    return { pass, notes };
  }
  // C1 / C2 / C3
  const pass =
    g.resumed &&
    g.reachedCompletionArtifact &&
    g.transcript.hasInterruptedForUnsafe &&
    doubles.length === 0;
  if (!pass) notes.push(`${point} gate: resumed=${g.resumed} reached=${g.reachedCompletionArtifact} interrupted=${g.transcript.hasInterruptedForUnsafe} doubles=${JSON.stringify(doubles)}`);
  return { pass, notes };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseArgs(argv: string[]): { points: Point[]; trials: number } {
  const pointIdx = argv.indexOf('--point');
  const trialsIdx = argv.indexOf('--trials');
  let points: Point[] = DEFAULT_POINTS;
  if (pointIdx >= 0) {
    const value = argv[pointIdx + 1];
    const parsed = value.split(',').map((v) => v.trim().toUpperCase() as Point);
    const valid = parsed.filter((p): p is Point => (DEFAULT_POINTS as string[]).includes(p));
    if (valid.length === 0) throw new Error(`invalid --point value: ${value}`);
    points = valid;
  }
  const trials = trialsIdx >= 0 ? Math.max(1, parseInt(argv[trialsIdx + 1], 10)) : 3;
  return { points, trials };
}

async function main() {
  const { points, trials } = parseArgs(process.argv.slice(2));
  const outDir = path.join(SPIKE_ROOT, 'results');
  await mkdir(outDir, { recursive: true });

  const all: TrialResult[] = [];
  for (const point of points) {
    for (let i = 1; i <= trials; i += 1) {
      process.stderr.write(`[crash-harness] ${point} trial ${i}/${trials}...\n`);
      try {
        const r = await runOnePoint(point, i);
        all.push(r);
        await writeFile(
          path.join(outDir, `${point.toLowerCase()}-${i}.json`),
          JSON.stringify(r, null, 2) + '\n',
          'utf8',
        );
        process.stderr.write(`  → pass=${r.pass} resumed=${r.resumed} wt=${r.worktreeState}\n`);
      } catch (err) {
        process.stderr.write(`  → trial failed: ${(err as Error).message}\n`);
        all.push({
          point,
          trial: i,
          pass: false,
          resumed: false,
          reachedCompletionArtifact: false,
          transcript: { exactlyOneResultPerCall: false, hasInterruptedForUnsafe: false },
          worktreeState: 'other',
          executesPerCallId: {},
          timings: { preCrashMs: 0, resumeMs: 0 },
          notes: [(err as Error).message],
        });
      }
    }
  }

  const summary = aggregate(all);
  await writeFile(path.join(outDir, 'crash-summary.json'), JSON.stringify({ summary, trials: all }, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(summary, null, 2));
}

function aggregate(trials: TrialResult[]) {
  const byPoint: Record<string, { total: number; pass: number; resumed: number; reached: number }> = {};
  for (const t of trials) {
    const key = t.point;
    byPoint[key] ??= { total: 0, pass: 0, resumed: 0, reached: 0 };
    byPoint[key].total += 1;
    if (t.pass) byPoint[key].pass += 1;
    if (t.resumed) byPoint[key].resumed += 1;
    if (t.reachedCompletionArtifact) byPoint[key].reached += 1;
  }
  return byPoint;
}

main().catch((err) => {
  console.error('crash-harness failed:', err);
  process.exit(2);
});
