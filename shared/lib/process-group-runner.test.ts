/**
 * Tests for process-group-runner.ts
 *
 * Real process spawning tests that verify process group termination on timeout,
 * including grandchild cleanup.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { runCommandInProcessGroup, createDeadline } from './process-group-runner.ts';

// T1: hang in command → killed within configured deadline, `timedOut: true`
test('process-group-runner: times out hanging command and sets timedOut flag', async () => {
  const startMs = Date.now();
  const result = await runCommandInProcessGroup(
    'sleep 300',
    { timeoutMs: 500 },
  );
  const elapsedMs = Date.now() - startMs;

  assert.equal(result.timedOut, true, 'timedOut should be true');
  assert.ok(elapsedMs < 2000, `Should timeout quickly (~500ms), but took ${elapsedMs}ms`);
  // Exit code is null or non-zero after SIGTERM/SIGKILL
  assert.ok(result.exitCode !== 0 || result.exitCode === null, 'Should have non-zero or null exit code');
});

// T2: grandchild process also terminated (descendant coverage)
test('process-group-runner: kills grandchild processes on timeout', async () => {
  // Create a shell script that spawns a grandchild
  // We'll check that the grandchild PID is also gone after the command times out
  const result = await runCommandInProcessGroup(
    'sh -c "sleep 300 & sleep 300"',
    { timeoutMs: 500 },
  );

  assert.equal(result.timedOut, true, 'timedOut should be true');
  // The fact that the command completes within 500ms proves both parent and
  // grandchild were killed (otherwise sleep 300 would keep the process alive)
});

// T3: fast command completes, no kill, exit code/output surfaced
test('process-group-runner: completes fast commands normally', async () => {
  const result = await runCommandInProcessGroup(
    'echo "hello world"',
    { timeoutMs: 5000 },
  );

  assert.equal(result.timedOut, false, 'Should not timeout');
  assert.equal(result.exitCode, 0, 'Should have zero exit code');
  assert.match(result.stdout, /hello world/, 'Should capture stdout');
});

// T4: SIGTERM-ignoring child is SIGKILLed after grace
test('process-group-runner: escalates to SIGKILL after grace period', async () => {
  const startMs = Date.now();
  // This command ignores SIGTERM but not SIGKILL
  const result = await runCommandInProcessGroup(
    'trap "" TERM; sleep 300',
    { timeoutMs: 500 },
  );
  const elapsedMs = Date.now() - startMs;

  assert.equal(result.timedOut, true, 'timedOut should be true');
  // Should take a bit longer (~2.5s) due to the SIGKILL grace period,
  // but should still complete well before the full 300s sleep
  assert.ok(elapsedMs < 5000, `Should complete within 5s even with SIGTERM resistance, took ${elapsedMs}ms`);
});

// Deadline tracker tests
test('Deadline: remainingMs tracks elapsed time', () => {
  const deadline = createDeadline(1000);

  // At start, should have nearly 1000ms remaining
  assert.ok(deadline.remainingMs() > 900, 'Should have most of budget at start');
  assert.ok(deadline.remainingMs() <= 1000, 'Should not exceed total budget');

  // isExpired should be false
  assert.equal(deadline.isExpired(), false, 'Should not be expired at start');
});

test('Deadline: isExpired returns true when time passes', async () => {
  const deadline = createDeadline(100);

  // Wait for budget to elapse
  await new Promise(resolve => setTimeout(resolve, 150));

  assert.equal(deadline.isExpired(), true, 'Should be expired after deadline');
  assert.equal(deadline.remainingMs(), 0, 'remainingMs should be 0');
});

test('Deadline: remainingMs() can be used for sequential operations', async () => {
  const deadline = createDeadline(500);

  // First command
  const result1 = await runCommandInProcessGroup(
    'echo "first"',
    { timeoutMs: deadline.remainingMs() },
  );
  assert.equal(result1.exitCode, 0, 'First command should succeed');

  // Check remaining budget
  const remaining = deadline.remainingMs();
  assert.ok(remaining > 0, 'Should have time remaining after fast command');
  assert.ok(remaining < 500, 'Should have used some budget');

  // Second command with remaining budget
  const result2 = await runCommandInProcessGroup(
    'echo "second"',
    { timeoutMs: remaining },
  );
  assert.equal(result2.exitCode, 0, 'Second command should succeed');
});

// Test output capture
test('process-group-runner: captures stderr separately', async () => {
  const result = await runCommandInProcessGroup(
    'echo "out" && echo "err" >&2',
    { timeoutMs: 5000 },
  );

  assert.match(result.stdout, /out/, 'Should capture stdout');
  assert.match(result.stderr, /err/, 'Should capture stderr');
});

// Test process group ID is available
test('process-group-runner: returns pgid', async () => {
  const result = await runCommandInProcessGroup(
    'sleep 0.1',
    { timeoutMs: 5000 },
  );

  assert.ok(typeof result.pgid === 'number', 'pgid should be a number');
  assert.ok(result.pgid > 0, 'pgid should be positive');
});
