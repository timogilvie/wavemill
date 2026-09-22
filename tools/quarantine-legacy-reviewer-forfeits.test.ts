/**
 * HOK-2970 legacy reviewer-forfeit quarantine sweep — unit test.
 *
 * Drives the tool as a child process so it exercises the real argv/CLI
 * surface. Seeds a HOK-2958-shaped fixture, runs --dry-run then --apply,
 * then a second --apply to prove idempotency. Restore-from-backup is also
 * verified.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOL_PATH = resolvePath(__dirname, 'quarantine-legacy-reviewer-forfeits.ts');
const REPO_ROOT = resolvePath(__dirname, '..');

function setupRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'quarantine-hok2970-'));
  mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
  writeFileSync(
    join(repoDir, '.wavemill-config.json'),
    JSON.stringify({ integration: { integrationBranch: 'auto/integration' } }),
  );
  return repoDir;
}

function seedFixture(repoDir: string): void {
  const evalsDir = join(repoDir, '.wavemill', 'evals');
  // Phantom-win row that HOK-2958 shipped.
  const forfeitRow = {
    challengePairId: 'HOK-2958',
    primaryModel: 'gpt-5.5',
    challengerModel: 'kimi-k3',
    primaryPrUrl: 'https://github.com/org/repo/pull/100',
    challengerPrUrl: 'https://github.com/org/repo/pull/101',
    primaryEvalScore: null,
    challengerEvalScore: null,
    winner: 'primary',
    winnerModel: 'gpt-5.5',
    rationale: 'legacy forfeit',
    dimensions: {
      completeness: { primary: 0, challenger: 0 },
      correctness: { primary: 0, challenger: 0 },
      code_quality: { primary: 0, challenger: 0 },
      intervention_impact: { primary: 0, challenger: 0 },
      autonomy: { primary: 0, challenger: 0 },
    },
    timestamp: '2026-09-14T00:00:00Z',
    comparisonOutcome: 'forfeit',
    terminalReason: 'challenger_challenge_aborted',
    forkStage: 'review',
  };
  // A pristine forfeit row that MUST NOT be touched (no invalid eval).
  const cleanForfeitRow = {
    ...forfeitRow,
    challengePairId: 'HOK-CLEAN',
    winner: 'primary',
    winnerModel: 'gpt-5.5',
    timestamp: '2026-09-13T00:00:00Z',
  };
  writeFileSync(
    join(evalsDir, 'challenge-records.jsonl'),
    JSON.stringify(forfeitRow) + '\n' + JSON.stringify(cleanForfeitRow) + '\n',
    'utf-8',
  );

  // Eval record marking the challenger as invalidChallenge.
  const invalidEval = {
    id: '550e8400-e29b-41d4-a716-446655440801',
    schemaVersion: '1.50.0',
    originalPrompt: 'x',
    modelId: 'kimi-k3',
    modelVersion: 'kimi-k3',
    score: 0,
    scoreBand: 'Blocked',
    timeSeconds: 0,
    timestamp: '2026-09-14T00:00:00Z',
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'invalid',
    challengePairId: 'HOK-2958',
    challengeSide: 'challenger',
    invalidChallenge: true,
    challengeDivergenceReason: 'missing_challenge_intent',
    evaluatedPrHeadSha: 'deadbeef',
  };
  // For the clean row, both arms have valid evals.
  const cleanChallengerEval = {
    ...invalidEval,
    id: '550e8400-e29b-41d4-a716-446655440802',
    challengePairId: 'HOK-CLEAN',
    invalidChallenge: false,
    challengeDivergenceReason: undefined,
  };
  delete (cleanChallengerEval as Record<string, unknown>).challengeDivergenceReason;
  writeFileSync(
    join(evalsDir, 'evals.jsonl'),
    JSON.stringify(invalidEval) + '\n' + JSON.stringify(cleanChallengerEval) + '\n',
    'utf-8',
  );
}

function runTool(repoDir: string, ...args: string[]): { stdout: string; status: number } {
  // Capture stdout+stderr regardless of exit status; the tool writes usage
  // and "No challenge records" to stderr with exit(0).
  try {
    const stdout = execFileSync('npx', ['tsx', TOOL_PATH, '--repo-dir', repoDir, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env: { ...process.env, WAVEMILL_MILL_RUNNING: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, status: 0 };
  } catch (err) {
    const errAny = err as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    const combined = `${errAny.stdout ?? ''}${errAny.stderr ?? ''}`;
    return { stdout: combined, status: errAny.status ?? 1 };
  }
}

function runToolCombined(repoDir: string, ...args: string[]): { combined: string; status: number } {
  // Alternate runner: uses the shell so stderr can be redirected to stdout.
  try {
    const combined = execFileSync('bash', ['-c', `npx tsx ${JSON.stringify(TOOL_PATH)} --repo-dir ${JSON.stringify(repoDir)} ${args.map((a) => JSON.stringify(a)).join(' ')} 2>&1`], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env: { ...process.env, WAVEMILL_MILL_RUNNING: '0' },
    });
    return { combined, status: 0 };
  } catch (err) {
    const errAny = err as { stdout?: Buffer | string; status?: number };
    return { combined: (errAny.stdout?.toString() ?? ''), status: errAny.status ?? 1 };
  }
}

function readRecords(repoDir: string): Array<Record<string, unknown>> {
  const path = join(repoDir, '.wavemill', 'evals', 'challenge-records.jsonl');
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('dry-run leaves records unchanged and reports match', () => {
  const repoDir = setupRepo();
  try {
    seedFixture(repoDir);
    const before = readFileSync(join(repoDir, '.wavemill', 'evals', 'challenge-records.jsonl'), 'utf-8');
    const result = runTool(repoDir, '--dry-run');
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /matched 1/);
    assert.match(result.stdout, /rewrote 1/);
    const after = readFileSync(join(repoDir, '.wavemill', 'evals', 'challenge-records.jsonl'), 'utf-8');
    assert.equal(after, before, 'dry-run must not modify the file');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('apply rewrites HOK-2958-shaped rows, leaves clean forfeit rows, and creates .bak', () => {
  const repoDir = setupRepo();
  try {
    seedFixture(repoDir);
    const result = runTool(repoDir, '--apply');
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /rewrote 1/);
    assert.match(result.stdout, /backup: /);

    const records = readRecords(repoDir);
    assert.equal(records.length, 2);

    const hok2958 = records.find((r) => r.challengePairId === 'HOK-2958');
    assert.ok(hok2958);
    assert.equal(hok2958.comparisonOutcome, 'invalid_challenge');
    assert.equal(hok2958.invalidChallenge, true);
    assert.equal(hok2958.winner, undefined);
    assert.equal(hok2958.winnerModel, undefined);
    assert.equal(hok2958.forkStage, 'review');
    const q = hok2958.quarantined as { reason: string; ticket: string; evidence?: { abortedSide: string } };
    assert.equal(q.reason, 'aborted-arm-was-invalid');
    assert.equal(q.ticket, 'HOK-2970');
    assert.equal(q.evidence?.abortedSide, 'challenger');

    const clean = records.find((r) => r.challengePairId === 'HOK-CLEAN');
    assert.ok(clean);
    assert.equal(clean.comparisonOutcome, 'forfeit');
    assert.equal(clean.winner, 'primary');
    assert.equal(clean.quarantined, undefined);

    // Backup exists and is equal to the pre-rewrite content.
    const evalsDir = join(repoDir, '.wavemill', 'evals');
    const backups = readdirSync(evalsDir).filter((name) => name.startsWith('challenge-records.jsonl.bak.'));
    assert.equal(backups.length, 1, 'exactly one backup should be created');
    const backup = readFileSync(join(evalsDir, backups[0]), 'utf-8');
    assert.match(backup, /"HOK-2958"/);
    assert.match(backup, /"comparisonOutcome":"forfeit"/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('second --apply is a no-op (idempotent)', () => {
  const repoDir = setupRepo();
  try {
    seedFixture(repoDir);
    runTool(repoDir, '--apply');
    const firstPass = readFileSync(join(repoDir, '.wavemill', 'evals', 'challenge-records.jsonl'), 'utf-8');
    const evalsDir = join(repoDir, '.wavemill', 'evals');
    const backupsBefore = readdirSync(evalsDir).filter((n) => n.startsWith('challenge-records.jsonl.bak.'));

    const result = runTool(repoDir, '--apply');
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /rewrote 0/);

    const secondPass = readFileSync(join(repoDir, '.wavemill', 'evals', 'challenge-records.jsonl'), 'utf-8');
    assert.equal(secondPass, firstPass, 'second run must not modify the file');
    const backupsAfter = readdirSync(evalsDir).filter((n) => n.startsWith('challenge-records.jsonl.bak.'));
    assert.equal(backupsAfter.length, backupsBefore.length, 'second run must not create a new backup');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('refuses to run without --dry-run or --apply', () => {
  const repoDir = setupRepo();
  try {
    seedFixture(repoDir);
    const result = runToolCombined(repoDir);
    assert.notEqual(result.status, 0);
    assert.match(result.combined, /Usage:/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('gracefully skips a repo with no challenge-records.jsonl', () => {
  const repoDir = setupRepo();
  try {
    // Do not seed. File is missing.
    const result = runToolCombined(repoDir, '--apply');
    assert.equal(result.status, 0);
    assert.match(result.combined, /No challenge records/);
    assert.equal(existsSync(join(repoDir, '.wavemill', 'evals', 'challenge-records.jsonl')), false);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});
