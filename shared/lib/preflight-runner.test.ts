import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateGuardFires,
  formatGuardFireReport,
  formatStepSummary,
  isPreflightRunRecord,
  parseGuardList,
  runPreflight,
  type GuardExecutor,
  type PreflightRunRecord,
} from './preflight-runner.ts';

test('parseGuardList ignores comments and blank lines and rejects duplicates', () => {
  assert.deepEqual(parseGuardList('# header\n\ntools/check-a.ts\ntools/check-b.ts  # why\n'), ['tools/check-a.ts', 'tools/check-b.ts']);
  assert.throws(() => parseGuardList('tools/check-a.ts\ntools/check-a.ts\n'), /listed more than once/);
});

test('runPreflight runs every guard after a failure and reports in list order', async () => {
  const guards = ['tools/check-slow.ts', 'tools/check-bad.ts', 'tools/check-fast.ts'];
  const started: string[] = [];
  const execute: GuardExecutor = async (guardPath) => {
    started.push(guardPath);
    // The first guard finishes last, so ordered reporting has to wait for it.
    await new Promise((resolve) => setTimeout(resolve, guardPath.includes('slow') ? 30 : 1));
    return guardPath.includes('bad')
      ? { exitCode: 1, output: '\nbad: found 2 offenders\n  file.ts:1\n' }
      : { exitCode: 0, output: 'ok\n' };
  };
  const reported: string[] = [];
  const record = await runPreflight({ repoDir: '/repo', guards, execute, concurrency: 3, onResult: (result) => reported.push(result.guard) });

  assert.deepEqual(started.sort(), [...guards].sort());
  assert.deepEqual(reported, ['check-slow', 'check-bad', 'check-fast']);
  assert.equal(record.ok, false);
  assert.deepEqual(record.guards.map((guard) => [guard.guard, guard.ok, guard.summary]), [
    ['check-slow', true, ''],
    ['check-bad', false, 'bad: found 2 offenders'],
    ['check-fast', true, ''],
  ]);
  assert.equal(isPreflightRunRecord(JSON.parse(JSON.stringify(record))), true);
  assert.match(formatStepSummary(record), /1 of 3 guards failed[\s\S]*`check-bad` \| bad: found 2 offenders/);
});

test('a guard that cannot start counts as a failure', async () => {
  const record = await runPreflight({ repoDir: '/repo', guards: ['tools/check-x.ts'], execute: async () => ({ exitCode: null, output: 'spawn ENOENT\n' }) });
  assert.equal(record.ok, false);
  assert.equal(record.guards[0].exitCode, null);
});

function run(branch: string, failing: string[]): { record: PreflightRunRecord; branch: string } {
  const guards = ['check-a', 'check-b', 'check-c'].map((guard, index) => ({
    guard, ok: !failing.includes(guard), exitCode: failing.includes(guard) ? 1 : 0, durationMs: 100 * (index + 1), summary: '',
  }));
  return { branch, record: { schema: 'wavemill.preflight-run/v1', startedAt: '2026-11-19T00:00:00.000Z', durationMs: 600, ok: failing.length === 0, guards } };
}

test('aggregateGuardFires counts failures, branches and sole failures per guard', () => {
  const stats = aggregateGuardFires([
    run('task/one', ['check-b']),
    run('task/one', ['check-b']),
    run('task/two', ['check-a', 'check-b']),
    run('main', []),
  ]);

  assert.deepEqual(stats, [
    { guard: 'check-b', runs: 4, failures: 3, branchesFailed: 2, soleFailures: 2, medianDurationMs: 200 },
    { guard: 'check-a', runs: 4, failures: 1, branchesFailed: 1, soleFailures: 0, medianDurationMs: 100 },
    { guard: 'check-c', runs: 4, failures: 0, branchesFailed: 0, soleFailures: 0, medianDurationMs: 300 },
  ]);
  const report = formatGuardFireReport(stats, 4);
  assert.match(report, /2 guard\(s\) fired, 1 never fired/);
  assert.match(report, /Never fired: check-c/);
});

test('isPreflightRunRecord rejects other JSON', () => {
  assert.equal(isPreflightRunRecord({ schema: 'something-else', guards: [] }), false);
  assert.equal(isPreflightRunRecord(null), false);
});
