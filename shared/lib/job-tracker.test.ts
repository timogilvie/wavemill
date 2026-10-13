import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import {
  buildJobId,
  isCheckJobKind,
  launchJob,
  markJobSettled,
  normalizeJobs,
  pollJobs,
  type MillJob,
} from './job-tracker.ts';

function makeTempState(): { root: string; statePath: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'job-tracker-test-'));
  const statePath = join(root, 'workflow-state.json');
  writeFileSync(statePath, JSON.stringify({ tasks: {} }, null, 2));
  return {
    root,
    statePath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function makeJob(overrides: Partial<MillJob> = {}): MillJob {
  return {
    id: 'eval-HOK-1-primary-101',
    kind: 'eval',
    issueId: 'HOK-1',
    side: 'primary',
    pairId: 'HOK-1',
    prNumbers: [101],
    pid: process.pid,
    startedAt: new Date().toISOString(),
    timeoutSeconds: 30,
    logPath: '/tmp/eval.log',
    resultPath: '/tmp/eval.result.json',
    status: 'running',
    exitCode: null,
    finishedAt: null,
    reason: null,
    excerpt: null,
    settled: false,
    ...overrides,
  };
}

test('normalizeJobs tolerates missing jobs', () => {
  assert.deepEqual(normalizeJobs({ tasks: {} }), {});
});

test('launchJob deduplicates active jobs', async () => {
  const { statePath, cleanup } = makeTempState();
  try {
    const job = makeJob();
    const first = await launchJob({ statePath, job });
    const second = await launchJob({ statePath, job: { ...job, pid: 999999 } });
    assert.equal(first.pid, second.pid);
  } finally {
    cleanup();
  }
});

test('pollJobs marks finished jobs as succeeded from result files', async () => {
  const { root, statePath, cleanup } = makeTempState();
  try {
    const logPath = join(root, 'eval.log');
    const resultPath = join(root, 'eval.result.json');
    writeFileSync(logPath, 'done\n');

    const child = spawn('sh', ['-c', 'exit 0']);
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));
    writeFileSync(resultPath, JSON.stringify({ ok: true, exitCode: 0 }, null, 2));

    const job = makeJob({ pid: child.pid ?? 0, logPath, resultPath });
    await launchJob({ statePath, job });

    const polled = await pollJobs({ statePath });
    assert.equal(polled.jobs[job.id].status, 'succeeded');
    assert.equal(polled.changed[0]?.id, job.id);
  } finally {
    cleanup();
  }
});

test('pollJobs marks missing result files as failed with excerpts', async () => {
  const { root, statePath, cleanup } = makeTempState();
  try {
    const logPath = join(root, 'compare.log');
    writeFileSync(logPath, 'line one\nline two\n');

    const child = spawn('sh', ['-c', 'exit 1']);
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));

    const job = makeJob({
      id: buildJobId({ kind: 'comparison', pairId: 'PAIR-1', prNumbers: [101, 102] }),
      kind: 'comparison',
      issueId: undefined,
      side: undefined,
      pairId: 'PAIR-1',
      prNumbers: [101, 102],
      pid: child.pid ?? 0,
      logPath,
      resultPath: join(root, 'missing.result.json'),
    });
    await launchJob({ statePath, job });

    const polled = await pollJobs({ statePath });
    assert.equal(polled.jobs[job.id].status, 'failed');
    assert.match(polled.jobs[job.id].excerpt || '', /line two/);
  } finally {
    cleanup();
  }
});

test('pollJobs settles running comparison jobs from terminal failed results before pid exit', async () => {
  const { root, statePath, cleanup } = makeTempState();
  const child = spawn('sh', ['-c', 'sleep 10']);
  try {
    const logPath = join(root, 'comparison.log');
    const resultPath = join(root, 'comparison.result.json');
    writeFileSync(logPath, 'comparison failed\n');
    writeFileSync(resultPath, JSON.stringify({
      ok: false,
      exitCode: 1,
      reason: 'Challenge comparison has no varied routing dimensions',
    }, null, 2));

    const job = makeJob({
      id: buildJobId({ kind: 'comparison', pairId: 'PAIR-1', prNumbers: [101, 102] }),
      kind: 'comparison',
      issueId: undefined,
      side: undefined,
      pairId: 'PAIR-1',
      prNumbers: [101, 102],
      pid: child.pid ?? 0,
      logPath,
      resultPath,
    });
    await launchJob({ statePath, job });

    const polled = await pollJobs({ statePath });
    assert.equal(polled.jobs[job.id].status, 'failed');
    assert.equal(polled.jobs[job.id].reason, 'Challenge comparison has no varied routing dimensions');
    assert.equal(polled.jobs[job.id].settled, false);
    assert.deepEqual(polled.unsettled.map((item) => item.id), [job.id]);
  } finally {
    child.kill('SIGKILL');
    cleanup();
  }
});

test('pollJobs settles running comparison jobs from terminal success results before pid exit', async () => {
  const { root, statePath, cleanup } = makeTempState();
  const child = spawn('sh', ['-c', 'sleep 10']);
  try {
    const logPath = join(root, 'comparison.log');
    const resultPath = join(root, 'comparison.result.json');
    writeFileSync(logPath, 'comparison done\n');
    writeFileSync(resultPath, JSON.stringify({ ok: true, exitCode: 0 }, null, 2));

    const job = makeJob({
      id: buildJobId({ kind: 'comparison', pairId: 'PAIR-1', prNumbers: [101, 102] }),
      kind: 'comparison',
      issueId: undefined,
      side: undefined,
      pairId: 'PAIR-1',
      prNumbers: [101, 102],
      pid: child.pid ?? 0,
      logPath,
      resultPath,
    });
    await launchJob({ statePath, job });

    const polled = await pollJobs({ statePath });
    assert.equal(polled.jobs[job.id].status, 'succeeded');
    assert.equal(polled.jobs[job.id].exitCode, 0);
    assert.equal(polled.jobs[job.id].settled, false);
    assert.deepEqual(polled.unsettled.map((item) => item.id), [job.id]);
  } finally {
    child.kill('SIGKILL');
    cleanup();
  }
});

test('pollJobs keeps running comparison jobs active when live pid only has partial result', async () => {
  const { root, statePath, cleanup } = makeTempState();
  const child = spawn('sh', ['-c', 'sleep 10']);
  try {
    const logPath = join(root, 'comparison.log');
    const resultPath = join(root, 'comparison.result.json');
    writeFileSync(logPath, 'comparison still running\n');
    writeFileSync(resultPath, JSON.stringify({ exitCode: 1 }, null, 2));

    const job = makeJob({
      id: buildJobId({ kind: 'comparison', pairId: 'PAIR-1', prNumbers: [101, 102] }),
      kind: 'comparison',
      issueId: undefined,
      side: undefined,
      pairId: 'PAIR-1',
      prNumbers: [101, 102],
      pid: child.pid ?? 0,
      logPath,
      resultPath,
    });
    await launchJob({ statePath, job });

    const polled = await pollJobs({ statePath });
    assert.equal(polled.jobs[job.id].status, 'running');
    assert.deepEqual(polled.unsettled, []);
  } finally {
    child.kill('SIGKILL');
    cleanup();
  }
});

test('pollJobs times out long-running jobs', async () => {
  const { root, statePath, cleanup } = makeTempState();
  const child = spawn('sh', ['-c', 'sleep 10']);
  try {
    const logPath = join(root, 'sleep.log');
    writeFileSync(logPath, 'still running\n');
    const job = makeJob({
      pid: child.pid ?? 0,
      logPath,
      resultPath: join(root, 'sleep.result.json'),
      startedAt: new Date(Date.now() - 5_000).toISOString(),
      timeoutSeconds: 1,
    });
    await launchJob({ statePath, job });

    const polled = await pollJobs({ statePath, timeoutGraceMs: 100 });
    assert.equal(polled.jobs[job.id].status, 'timeout');
  } finally {
    child.kill('SIGKILL');
    cleanup();
  }
});

test('pollJobs treats timed-out jobs with persisted results as succeeded', async () => {
  const { root, statePath, cleanup } = makeTempState();
  const child = spawn('sh', ['-c', 'sleep 10']);
  try {
    const logPath = join(root, 'eval.log');
    const resultPath = join(root, 'eval.result.json');
    writeFileSync(logPath, 'persisted before timeout\n');
    writeFileSync(resultPath, JSON.stringify({ ok: true, persisted: true, exitCode: 143 }, null, 2));
    const job = makeJob({
      pid: child.pid ?? 0,
      logPath,
      resultPath,
      startedAt: new Date(Date.now() - 5_000).toISOString(),
      timeoutSeconds: 1,
    });
    await launchJob({ statePath, job });

    const polled = await pollJobs({ statePath, timeoutGraceMs: 100 });
    assert.equal(polled.jobs[job.id].status, 'succeeded');
    assert.equal(polled.jobs[job.id].exitCode, 143);
  } finally {
    child.kill('SIGKILL');
    cleanup();
  }
});

test('markJobSettled updates eval completion state', async () => {
  const { statePath, cleanup } = makeTempState();
  try {
    writeFileSync(statePath, JSON.stringify({
      tasks: {
        'HOK-1': {
          evalCompleted: false,
          evalFailed: true,
          evalHardFailureRetryCount: 2,
          evalRunning: {
            startedAt: new Date().toISOString(),
          },
        },
      },
      jobs: {
        'eval-HOK-1-primary-101': {
          ...makeJob(),
          status: 'succeeded',
        },
      },
    }, null, 2));

    await markJobSettled({ statePath, jobId: 'eval-HOK-1-primary-101' });
    const next = JSON.parse(readFileSync(statePath, 'utf-8'));
    assert.equal(next.tasks['HOK-1'].evalCompleted, true);
    assert.equal(next.tasks['HOK-1'].evalFailed, false);
    assert.equal(next.tasks['HOK-1'].evalHardFailureRetryCount, 0);
    assert.equal('evalRunning' in next.tasks['HOK-1'], false);
    assert.equal(next.jobs['eval-HOK-1-primary-101'].settled, true);
  } finally {
    cleanup();
  }
});

test('markJobSettled marks failed eval jobs as evalFailed', async () => {
  const { statePath, cleanup } = makeTempState();
  try {
    writeFileSync(statePath, JSON.stringify({
      tasks: {
        'HOK-1': {
          evalCompleted: false,
          evalFailed: false,
          evalRunning: {
            startedAt: new Date().toISOString(),
          },
        },
      },
      jobs: {
        'eval-HOK-1-primary-101': {
          ...makeJob(),
          status: 'failed',
          reason: 'job_failed',
        },
      },
    }, null, 2));

    await markJobSettled({ statePath, jobId: 'eval-HOK-1-primary-101' });
    const next = JSON.parse(readFileSync(statePath, 'utf-8'));
    assert.equal(next.tasks['HOK-1'].evalCompleted, false);
    assert.equal(next.tasks['HOK-1'].evalFailed, true);
    assert.equal('evalRunning' in next.tasks['HOK-1'], false);
    assert.equal(next.jobs['eval-HOK-1-primary-101'].settled, true);
  } finally {
    cleanup();
  }
});

test('markJobSettled clears comparison running state on success', async () => {
  const { statePath, cleanup } = makeTempState();
  try {
    writeFileSync(statePath, JSON.stringify({
      tasks: {
        'PAIR-1': {
          challengePairId: 'PAIR-1',
          challengeCompared: false,
          comparisonRunning: {
            startedAt: new Date().toISOString(),
          },
        },
        'PAIR-1_c': {
          challengePairId: 'PAIR-1',
          challengeCompared: false,
          comparisonRunning: {
            startedAt: new Date().toISOString(),
          },
        },
      },
      jobs: {
        'comparison-PAIR-1-101-102': {
          ...makeJob({
            id: 'comparison-PAIR-1-101-102',
            kind: 'comparison',
            issueId: undefined,
            side: undefined,
            pairId: 'PAIR-1',
            prNumbers: [101, 102],
          }),
          status: 'succeeded',
        },
      },
    }, null, 2));

    await markJobSettled({ statePath, jobId: 'comparison-PAIR-1-101-102' });
    const next = JSON.parse(readFileSync(statePath, 'utf-8'));
    assert.equal(next.tasks['PAIR-1'].challengeCompared, true);
    assert.equal(next.tasks['PAIR-1_c'].challengeCompared, true);
    assert.equal('comparisonRunning' in next.tasks['PAIR-1'], false);
    assert.equal('comparisonRunning' in next.tasks['PAIR-1_c'], false);
  } finally {
    cleanup();
  }
});

test('markJobSettled clears comparison running state on failure', async () => {
  const { statePath, cleanup } = makeTempState();
  try {
    writeFileSync(statePath, JSON.stringify({
      tasks: {
        'PAIR-1': {
          challengePairId: 'PAIR-1',
          challengeCompared: false,
          comparisonState: 'comparison_running',
          comparisonRunning: {
            startedAt: new Date().toISOString(),
          },
          comparisonRetryCount: 2,
          comparisonRetryMaxAttempts: 3,
          comparisonRetryTargetIssue: 'PAIR-1',
          comparisonTimedOutSides: ['challenger'],
          manualComparisonArtifact: 'ready/challenge-comparison-needed.md',
        },
        'PAIR-1_c': {
          challengePairId: 'PAIR-1',
          challengeCompared: false,
          comparisonState: 'comparison_running',
          comparisonRunning: {
            startedAt: new Date().toISOString(),
          },
          comparisonRetryCount: 2,
          comparisonRetryMaxAttempts: 3,
          comparisonRetryTargetIssue: 'PAIR-1',
          comparisonTimedOutSides: ['challenger'],
          manualComparisonArtifact: 'ready/challenge-comparison-needed.md',
        },
      },
      jobs: {
        'comparison-PAIR-1-101-102': {
          ...makeJob({
            id: 'comparison-PAIR-1-101-102',
            kind: 'comparison',
            issueId: undefined,
            side: undefined,
            pairId: 'PAIR-1',
            prNumbers: [101, 102],
          }),
          status: 'failed',
          reason: 'Challenge comparison has no varied routing dimensions',
        },
      },
    }, null, 2));

    await markJobSettled({ statePath, jobId: 'comparison-PAIR-1-101-102' });
    const next = JSON.parse(readFileSync(statePath, 'utf-8'));
    assert.equal(next.tasks['PAIR-1'].challengeCompared, false);
    assert.equal(next.tasks['PAIR-1_c'].challengeCompared, false);
    assert.equal('comparisonRunning' in next.tasks['PAIR-1'], false);
    assert.equal('comparisonRunning' in next.tasks['PAIR-1_c'], false);
    assert.equal(next.tasks['PAIR-1'].comparisonState, 'manual_comparison_needed');
    assert.equal(next.tasks['PAIR-1_c'].comparisonState, 'manual_comparison_needed');
    assert.equal(next.tasks['PAIR-1'].comparisonBlockedReason, 'Challenge comparison has no varied routing dimensions');
    assert.equal(next.tasks['PAIR-1_c'].comparisonBlockedReason, 'Challenge comparison has no varied routing dimensions');
    assert.equal(next.tasks['PAIR-1'].challengeCompared, false);
    assert.equal(next.tasks['PAIR-1_c'].challengeCompared, false);
    assert.equal('comparisonRetryCount' in next.tasks['PAIR-1'], false);
    assert.equal('comparisonRetryMaxAttempts' in next.tasks['PAIR-1'], false);
    assert.equal('comparisonRetryTargetIssue' in next.tasks['PAIR-1'], false);
    assert.equal('comparisonTimedOutSides' in next.tasks['PAIR-1'], false);
    assert.equal('manualComparisonArtifact' in next.tasks['PAIR-1'], false);
    assert.equal('comparisonRetryCount' in next.tasks['PAIR-1_c'], false);
    assert.equal('comparisonRetryMaxAttempts' in next.tasks['PAIR-1_c'], false);
    assert.equal('comparisonRetryTargetIssue' in next.tasks['PAIR-1_c'], false);
    assert.equal('comparisonTimedOutSides' in next.tasks['PAIR-1_c'], false);
    assert.equal('manualComparisonArtifact' in next.tasks['PAIR-1_c'], false);
  } finally {
    cleanup();
  }
});

// ── HOK-3206: check job kinds ──────────────────────────────────────────────

test('buildJobId gives check kinds one stable id per subject', () => {
  assert.equal(buildJobId({ kind: 'cross-pr-guard', issueId: 'HOK-7', prNumbers: [12] }), 'cross-pr-guard-HOK-7');
  assert.equal(buildJobId({ kind: 'pr-ci-status', issueId: 'HOK-7_c', prNumbers: [13] }), 'pr-ci-status-HOK-7_c');
  assert.equal(buildJobId({ kind: 'ready-watchdog', prNumbers: [] }), 'ready-watchdog');
  assert.equal(isCheckJobKind('route-task'), true);
  assert.equal(isCheckJobKind('eval'), false);
});

test('pollJobs auto-settles a succeeded check job and leaves a failed one unsettled', async () => {
  const { root, statePath, cleanup } = makeTempState();
  try {
    const okResult = join(root, 'ok.result.json');
    const badResult = join(root, 'bad.result.json');
    writeFileSync(okResult, JSON.stringify({ ok: true, exitCode: 0 }));
    writeFileSync(badResult, JSON.stringify({ ok: false, exitCode: 3, reason: 'tool_crashed' }));
    await launchJob({ statePath, job: makeJob({ id: 'cross-pr-guard-HOK-1', kind: 'cross-pr-guard', pid: 999_999_9, resultPath: okResult }) });
    await launchJob({ statePath, job: makeJob({ id: 'pr-ci-status-HOK-2', kind: 'pr-ci-status', issueId: 'HOK-2', pid: 999_999_8, resultPath: badResult }) });

    const result = await pollJobs({ statePath });
    const ok = result.jobs['cross-pr-guard-HOK-1'];
    const bad = result.jobs['pr-ci-status-HOK-2'];
    assert.equal(ok.status, 'succeeded');
    assert.equal(ok.settled, true);
    assert.equal(bad.status, 'failed');
    assert.equal(bad.settled, false);
    assert.deepEqual(result.unsettled.map((job) => job.id), ['pr-ci-status-HOK-2']);
  } finally {
    cleanup();
  }
});

test('pollJobs prunes settled check jobs past retention but keeps eval jobs', async () => {
  const { statePath, cleanup } = makeTempState();
  try {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    writeFileSync(statePath, JSON.stringify({
      tasks: {},
      jobs: {
        'ready-watchdog': makeJob({ id: 'ready-watchdog', kind: 'ready-watchdog', status: 'succeeded', settled: true, finishedAt: old }),
        'eval-HOK-1-primary-101': makeJob({ status: 'succeeded', settled: true, finishedAt: old }),
      },
    }));
    const result = await pollJobs({ statePath });
    assert.equal(result.jobs['ready-watchdog'], undefined);
    assert.ok(result.jobs['eval-HOK-1-primary-101']);
  } finally {
    cleanup();
  }
});

test('launchJob overwrites a settled check job with the same stable id', async () => {
  const { statePath, cleanup } = makeTempState();
  try {
    await launchJob({ statePath, job: makeJob({ id: 'route-task-HOK-3', kind: 'route-task', status: 'failed', settled: true }) });
    const relaunched = await launchJob({ statePath, job: makeJob({ id: 'route-task-HOK-3', kind: 'route-task', pid: 4242 }) });
    assert.equal(relaunched.status, 'running');
    assert.equal(relaunched.pid, 4242);
    const state = JSON.parse(readFileSync(statePath, 'utf-8')) as { jobs: Record<string, MillJob> };
    assert.equal(Object.keys(state.jobs).length, 1);
  } finally {
    cleanup();
  }
});
