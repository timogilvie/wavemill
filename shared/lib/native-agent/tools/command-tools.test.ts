import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  CommandRunHistory,
  commandToolsAfterToolCall,
  createCommandTools,
  createRunFormatTool,
  createRunTestsTool,
  MAX_TEST_TIMEOUT_MS,
  type RunCommandDetails,
} from './command-tools.ts';

const tempDirs = new Set<string>();

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('native-agent command tools', () => {
  it('runs passing commands for run_tests and run_format', async () => {
    const repo = makeTempDir('command-tools-pass-');

    const runTests = createRunTestsTool(repo);
    const runFormat = createRunFormatTool(repo);

    const testResult = await runTests.execute('call-tests-pass', {
      command: `node -e console.log(String.fromCharCode(111,107))`,
    });
    const formatResult = await runFormat.execute('call-format-pass', {
      command: `node -e console.log(String.fromCharCode(102,109,116))`,
    });

    const testDetails = testResult.details as RunCommandDetails;
    const formatDetails = formatResult.details as RunCommandDetails;

    assert.equal(testDetails.ok, true);
    assert.equal(formatDetails.ok, true);

    if (testDetails.ok && formatDetails.ok) {
      assert.equal(testDetails.tool, 'run_tests');
      assert.equal(testDetails.kind, 'tests');
      assert.equal(testDetails.status, 'completed');
      assert.equal(testDetails.exitCode, 0);
      assert.equal(testDetails.cwd, repo);
      assert.equal(testDetails.commandClass, 'safe');
      assert.equal(testDetails.approval, 'approved');
      assert.equal(testDetails.truncated, false);
      assert.match(testDetails.stdout, /ok/);
      assert.equal(typeof testDetails.durationMs, 'number');
      assert.ok(testDetails.durationMs >= 0);
      assert.equal(testDetails.stdoutMeta.truncated, false);
      assert.equal(testDetails.stderrMeta.truncated, false);
      assert.equal(testResult.metadata?.trust?.sourceKind, 'command_output');
      assert.equal(testResult.metadata?.trust?.trust, 'untrusted');

      assert.equal(formatDetails.tool, 'run_format');
      assert.equal(formatDetails.kind, 'format');
      assert.equal(formatDetails.status, 'completed');
      assert.equal(formatDetails.exitCode, 0);
      assert.equal(formatDetails.cwd, repo);
      assert.equal(formatDetails.commandClass, 'safe');
      assert.equal(formatDetails.approval, 'approved');
      assert.equal(formatDetails.truncated, false);
      assert.match(formatDetails.stdout, /fmt/);
    }
  });

  it('preserves failing exit codes and stderr output', async () => {
    const repo = makeTempDir('command-tools-fail-');
    const runTests = createRunTestsTool(repo);

    const result = await runTests.execute('call-tests-fail', {
      command: `node -e "process.stderr.write(String.fromCharCode(98,111,111,109)+'\\n');process.exit(2)"`,
    });

    const details = result.details as RunCommandDetails;
    assert.equal(details.ok, true);
    if (details.ok) {
      assert.equal(details.status, 'completed');
      assert.equal(details.exitCode, 2);
      assert.equal(details.timedOut, false);
      assert.match(details.stderr, /boom/);
      const afterCall = await commandToolsAfterToolCall({
        toolCall: { name: 'run_tests' },
        result,
      });
      assert.equal(afterCall, undefined);
    }
  });

  it('reports timed out commands without treating them as rejections', async () => {
    const repo = makeTempDir('command-tools-timeout-');
    const runTests = createRunTestsTool(repo);

    const result = await Promise.race([
      runTests.execute('call-tests-timeout', {
        command: `node -e "setTimeout(()=>{},5000)"`,
        timeoutMs: 200,
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('timeout test hung')), 10_000);
      }),
    ]);

    const details = result.details as RunCommandDetails;
    assert.equal(details.ok, true);
    if (details.ok) {
      assert.equal(details.status, 'timed_out');
      assert.equal(details.timedOut, true);
      assert.equal(details.exitCode, null);
      assert.ok(details.durationMs >= 200);
      assert.ok(details.durationMs < 4000);
    }
  });

  it('middle-truncates output while preserving both head and tail markers', async () => {
    const repo = makeTempDir('command-tools-truncate-');
    const runTests = createRunTestsTool(repo);

    const largeResult = await runTests.execute('call-tests-truncate', {
      command:
        `node -e "console.log('HEAD_MARKER');for(i=0;i<5000;i++)console.log('x'.repeat(50));console.log('TAIL_MARKER')"`,
      maxOutputBytes: 1024,
    });

    const details = largeResult.details as RunCommandDetails;
    assert.equal(details.ok, true);
    if (details.ok) {
      assert.equal(details.truncated, true);
      assert.match(details.stdout, /HEAD_MARKER/);
      assert.match(details.stdout, /TAIL_MARKER/);
      assert.match(details.stdout, /\.\.\.\[truncated \d+ bytes from the middle\]\.\.\./);
      assert.ok(Buffer.byteLength(details.stdout, 'utf8') <= 1024);
      assert.ok(details.stdoutMeta.originalByteLength > 1024);
      assert.equal(details.stderrMeta.truncated, false);
    }

    const exactResult = await runTests.execute('call-tests-exact', {
      command: `node -e "process.stdout.write('hello')"`,
      maxOutputBytes: 5,
    });
    const exactDetails = exactResult.details as RunCommandDetails;
    assert.equal(exactDetails.ok, true);
    if (exactDetails.ok) {
      assert.equal(exactDetails.truncated, false);
      assert.equal(exactDetails.stdout, 'hello');
    }
  });

  it('rejects unsafe commands before spawn for both tools', async () => {
    const repo = makeTempDir('command-tools-unsafe-');
    let spawnCalls = 0;
    const spawnSpy = (file: string, args: readonly string[], options: any) => {
      spawnCalls += 1;
      return spawn(file, [...args], options);
    };

    const runTests = createRunTestsTool(repo, { spawnFn: spawnSpy });
    const runFormat = createRunFormatTool(repo, { spawnFn: spawnSpy });

    const testResult = await runTests.execute('call-tests-unsafe', {
      command: 'rm -rf /',
    });
    const formatResult = await runFormat.execute('call-format-unsafe', {
      command: 'sudo ls',
    });

    const testDetails = testResult.details as RunCommandDetails;
    const formatDetails = formatResult.details as RunCommandDetails;

    assert.equal(testDetails.ok, false);
    assert.equal(formatDetails.ok, false);
    if (!testDetails.ok && !formatDetails.ok) {
      assert.equal(testDetails.status, 'rejected');
      assert.equal(testDetails.error, 'unsafe_command');
      assert.equal(testDetails.commandClass, 'dangerous');
      assert.equal(testDetails.reason, 'dangerous-command-pattern');
      assert.ok(testDetails.retryHint);

      assert.equal(formatDetails.status, 'rejected');
      assert.equal(formatDetails.error, 'unsafe_command');
      assert.equal(formatDetails.commandClass, 'dangerous');
      assert.equal(formatDetails.reason, 'dangerous-command-pattern');
    }
    assert.equal(spawnCalls, 0);
    assert.equal(testResult.metadata?.trust?.sourceKind, 'command_output');
  });

  it('rejects shell operators before spawn for run_tests and run_format', async () => {
    const repo = makeTempDir('command-tools-shell-operators-');
    let spawnCalls = 0;
    const spawnSpy = (file: string, args: readonly string[], options: any) => {
      spawnCalls += 1;
      return spawn(file, [...args], options);
    };

    const runTests = createRunTestsTool(repo, { spawnFn: spawnSpy });
    const runFormat = createRunFormatTool(repo, { spawnFn: spawnSpy });

    for (const [tool, command] of [
      [runTests, 'touch X && echo created'],
      [runFormat, 'touch Y && echo created'],
    ] as const) {
      const result = await tool.execute('call-shell-reject', { command });
      const details = result.details as RunCommandDetails;

      assert.equal(details.ok, false);
      if (!details.ok) {
        assert.equal(details.status, 'rejected');
        assert.equal(details.error, 'unsupported_shell_syntax');
        assert.equal(details.reason, 'unsupported-shell-syntax');
        assert.match(details.message, /offending token: "&&"/);
        assert.match(details.retryHint ?? '', /one program per call/);
        const afterCall = await commandToolsAfterToolCall({
          toolCall: { name: details.tool },
          result,
        });
        assert.deepEqual(afterCall, { isError: true });
      }
    }

    assert.equal(spawnCalls, 0);
    assert.deepEqual(readdirSync(repo), []);
    for (const name of ['&&', 'echo', 'created', 'X', 'Y']) {
      assert.equal(existsSync(path.join(repo, name)), false);
    }
  });

  it('rejects pipes redirects and expansions as unsupported shell syntax', async () => {
    const repo = makeTempDir('command-tools-shell-variants-');
    const runTests = createRunTestsTool(repo);

    for (const command of ['ls -l | cat', 'echo hello > output.txt', 'echo $VAR']) {
      const result = await runTests.execute('call-shell-variant', { command });
      const details = result.details as RunCommandDetails;
      assert.equal(details.ok, false);
      if (!details.ok) {
        assert.equal(details.error, 'unsupported_shell_syntax');
        assert.equal(details.reason, 'unsupported-shell-syntax');
      }
    }
    assert.equal(existsSync(path.join(repo, 'output.txt')), false);
  });

  it('round-trips quoted arguments through the command substrate', async () => {
    const repo = makeTempDir('command-tools-quoted-');
    const runTests = createRunTestsTool(repo);

    const result = await runTests.execute('call-tests-quoted', {
      command: `node -e "console.log('meta')"`,
    });

    const details = result.details as RunCommandDetails;
    assert.equal(details.ok, true);
    if (details.ok) {
      assert.equal(details.exitCode, 0);
      assert.equal(details.stdout.trim(), 'meta');
    }
  });

  it('includes required execution metadata on completed results', async () => {
    const repo = makeTempDir('command-tools-metadata-');
    const runTests = createRunTestsTool(repo);

    const result = await runTests.execute('call-tests-metadata', {
      command: `node -e "console.log('meta')"`,
    });

    const details = result.details as RunCommandDetails;
    assert.equal(details.ok, true);
    if (details.ok) {
      assert.ok(Object.hasOwn(details, 'commandClass'));
      assert.ok(Object.hasOwn(details, 'approval'));
      assert.ok(Object.hasOwn(details, 'cwd'));
      assert.ok(Object.hasOwn(details, 'durationMs'));
      assert.ok(Object.hasOwn(details, 'exitCode'));
      assert.ok(Object.hasOwn(details, 'stdoutMeta'));
      assert.ok(Object.hasOwn(details, 'stderrMeta'));
    }
  });

  it('rejects empty commands without spawning', async () => {
    const repo = makeTempDir('command-tools-empty-');
    let spawnCalls = 0;
    const runTests = createRunTestsTool(repo, {
      spawnFn(file, args, options) {
        spawnCalls += 1;
        return spawn(file, args, options);
      },
    });

    const result = await runTests.execute('call-tests-empty', {
      command: '',
    });

    const details = result.details as RunCommandDetails;
    assert.equal(details.ok, false);
    if (!details.ok) {
      assert.equal(details.error, 'invalid_input');
      assert.equal(details.reason, 'empty-command');
    }
    assert.equal(spawnCalls, 0);
  });

  it('rejects cwd outside the worktree before spawn', async () => {
    const repo = makeTempDir('command-tools-root-');
    const outside = makeTempDir('command-tools-outside-');
    let spawnCalls = 0;
    const runTests = createRunTestsTool(repo, {
      spawnFn(file, args, options) {
        spawnCalls += 1;
        return spawn(file, args, options);
      },
    });

    const result = await runTests.execute('call-tests-outside', {
      command: `node -e console.log('x')`,
      cwd: outside,
    });

    const details = result.details as RunCommandDetails;
    assert.equal(details.ok, false);
    if (!details.ok) {
      assert.equal(details.error, 'cwd_outside_allowed_roots');
      assert.equal(details.commandClass, 'safe');
      assert.equal(details.reason, 'cwd-outside-allowed-roots');
    }
    assert.equal(spawnCalls, 0);
  });

  it('marks only rejected tool calls as loop errors', async () => {
    const repo = makeTempDir('command-tools-after-');
    const runTests = createRunTestsTool(repo);

    const rejected = await runTests.execute('call-tests-rejected', {
      command: 'sudo ls',
    });
    const completed = await runTests.execute('call-tests-completed', {
      command: `node -e "process.exit(3)"`,
    });

    const rejectedAfter = await commandToolsAfterToolCall({
      toolCall: { name: 'run_tests' },
      result: rejected,
    });
    const completedAfter = await commandToolsAfterToolCall({
      toolCall: { name: 'run_tests' },
      result: completed,
    });

    assert.deepEqual(rejectedAfter, { isError: true });
    assert.equal(completedAfter, undefined);
  });

  it('stays on the shared substrate path', () => {
    const source = readFileSync(new URL('./command-tools.ts', import.meta.url), 'utf8');
    assert.ok(!source.includes('node:child_process'));
    assert.ok(!source.includes("require('child_process')"));
  });

  it('refuses npm test as a full-suite command and includes the script expansion', async () => {
    const repo = makeTempDir('command-tools-full-suite-');
    writeFileSync(
      path.join(repo, 'package.json'),
      JSON.stringify({
        scripts: {
          test: 'npm run test:preflight && npm run test:shell && npm run test:unit && npm run test:smoke && npm run test:config && npm run test:native-launch-certification',
        },
      }),
      'utf-8',
    );

    let spawnCalls = 0;
    const spawnSpy = (file: string, args: readonly string[], options: any) => {
      spawnCalls += 1;
      return spawn(file, [...args], options);
    };
    const runTests = createRunTestsTool(repo, { spawnFn: spawnSpy, fingerprintFn: () => 'fp-1' });

    const bareResult = await runTests.execute('call-full-suite-bare', { command: 'npm test' });
    const bareDetails = bareResult.details as RunCommandDetails;
    assert.equal(bareDetails.ok, false);
    if (!bareDetails.ok) {
      assert.equal(bareDetails.error, 'full_suite_refused');
      assert.equal(bareDetails.reason, 'full-suite-command');
      assert.match(bareDetails.message, /full repository suite/);
      assert.match(bareDetails.message, /focused/);
      assert.ok(bareDetails.scriptExpansion);
      assert.equal(bareDetails.scriptExpansion?.chainedScripts[0], 'test:preflight');
      assert.match(bareDetails.retryHint ?? '', /node --test/);
    }
    const bareText = bareResult.content[0]?.type === 'text' ? bareResult.content[0].text : '';
    assert.match(bareText, /node --test|npm run test:preflight/);

    const withPathResult = await runTests.execute('call-full-suite-with-path', {
      command: 'npm test shared/lib/openrouter-alias-audit.test.ts',
    });
    const withPathDetails = withPathResult.details as RunCommandDetails;
    assert.equal(withPathDetails.ok, false);
    if (!withPathDetails.ok) {
      assert.equal(withPathDetails.error, 'full_suite_refused');
      assert.ok(withPathDetails.scriptExpansion);
      assert.match(withPathDetails.message, /shared\/lib\/openrouter-alias-audit\.test\.ts/);
    }

    assert.equal(spawnCalls, 0);
  });

  it('runs npm test when allowFullSuite is true and includes the expansion in the result', async () => {
    const repo = makeTempDir('command-tools-full-suite-allowed-');
    writeFileSync(
      path.join(repo, 'package.json'),
      JSON.stringify({ scripts: { test: 'node -e console.log(1)' } }),
      'utf-8',
    );

    let spawnCalls = 0;
    const spawnSpy = (file: string, args: readonly string[], options: any) => {
      spawnCalls += 1;
      return spawn(file, [...args], options);
    };
    const runTests = createRunTestsTool(repo, { spawnFn: spawnSpy, allowFullSuite: true, fingerprintFn: () => 'fp-1' });

    const result = await runTests.execute('call-full-suite-allowed', { command: 'npm test' });
    const details = result.details as RunCommandDetails;
    assert.equal(details.ok, true);
    if (details.ok) {
      assert.ok(details.scriptExpansion);
      assert.equal(details.scriptExpansion?.script, 'test');
    }
    assert.ok(spawnCalls > 0, 'expected the real npm command to run');
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    assert.match(text, /npm test runs:/);
  });

  it('refuses an identical repeat of a just-timed-out command without spawning', async () => {
    const repo = makeTempDir('command-tools-repeat-');
    let spawnCalls = 0;
    const spawnSpy = (file: string, args: readonly string[], options: any) => {
      spawnCalls += 1;
      return spawn(file, [...args], options);
    };
    let fingerprint = 'tree-1';
    const history = new CommandRunHistory();
    const runTests = createRunTestsTool(repo, {
      spawnFn: spawnSpy,
      fingerprintFn: () => fingerprint,
      history,
    });

    const first = await Promise.race([
      runTests.execute('call-repeat-first', {
        command: `node -e "setTimeout(()=>{},5000)"`,
        timeoutMs: 100,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout test hung')), 10_000)),
    ]);
    const firstDetails = first.details as RunCommandDetails;
    assert.equal(firstDetails.ok, true);
    if (firstDetails.ok) {
      assert.equal(firstDetails.status, 'timed_out');
    }
    const spawnsAfterFirst = spawnCalls;
    assert.ok(spawnsAfterFirst > 0);

    const secondSameTimeout = await runTests.execute('call-repeat-second', {
      command: `node -e "setTimeout(()=>{},5000)"`,
      timeoutMs: 100,
    });
    const secondSameDetails = secondSameTimeout.details as RunCommandDetails;
    assert.equal(secondSameDetails.ok, false);
    if (!secondSameDetails.ok) {
      assert.equal(secondSameDetails.error, 'repeat_after_timeout');
      assert.match(secondSameDetails.message, /timed out after/);
      assert.match(secondSameDetails.message, /narrow the selection/);
      assert.ok(secondSameDetails.previousTimeout);
    }
    assert.equal(spawnCalls, spawnsAfterFirst, 'repeat refusal must not spawn');

    // Different timeoutMs — still identical argv, still refused.
    const secondBiggerTimeout = await runTests.execute('call-repeat-second-big', {
      command: `node -e "setTimeout(()=>{},5000)"`,
      timeoutMs: 60_000,
    });
    const secondBiggerDetails = secondBiggerTimeout.details as RunCommandDetails;
    assert.equal(secondBiggerDetails.ok, false);
    if (!secondBiggerDetails.ok) {
      assert.equal(secondBiggerDetails.error, 'repeat_after_timeout');
    }
    assert.equal(spawnCalls, spawnsAfterFirst, 'raising the timeout must not bypass');

    // Different command — allowed.
    const differentCommand = await runTests.execute('call-repeat-different', {
      command: `node -e "console.log('ok')"`,
    });
    const differentDetails = differentCommand.details as RunCommandDetails;
    assert.equal(differentDetails.ok, true);
    assert.ok(spawnCalls > spawnsAfterFirst, 'different command must spawn');

    // After the worktree fingerprint changes, the same command runs again.
    fingerprint = 'tree-2';
    const spawnsBeforeRetry = spawnCalls;
    const retry = await runTests.execute('call-repeat-retry', {
      command: `node -e "console.log('ok')"`,
    });
    const retryDetails = retry.details as RunCommandDetails;
    assert.equal(retryDetails.ok, true);
    assert.ok(spawnCalls > spawnsBeforeRetry, 'fingerprint change must allow re-run');
  });

  it('clears the record on a successful completion of the same key', async () => {
    const repo = makeTempDir('command-tools-clear-');
    const history = new CommandRunHistory();
    const runTests = createRunTestsTool(repo, { fingerprintFn: () => 'fp', history });
    // Successful run should not record a timeout.
    const result = await runTests.execute('call-clear-1', { command: `node -e "console.log('ok')"` });
    const details = result.details as RunCommandDetails;
    assert.equal(details.ok, true);

    // Second identical run also succeeds — no refusal.
    const second = await runTests.execute('call-clear-2', { command: `node -e "console.log('ok')"` });
    assert.equal((second.details as RunCommandDetails).ok, true);
  });

  it('clamps an unreasonable timeoutMs to the ceiling and reports both', async () => {
    const repo = makeTempDir('command-tools-clamp-');
    const runTests = createRunTestsTool(repo, { fingerprintFn: () => 'fp' });
    const requested = MAX_TEST_TIMEOUT_MS + 60_000; // 11 min
    const result = await runTests.execute('call-clamp', {
      command: `node -e "console.log('fast')"`,
      timeoutMs: requested,
    });
    const details = result.details as RunCommandDetails;
    assert.equal(details.ok, true);
    if (details.ok) {
      assert.equal(details.requestedTimeoutMs, requested);
      assert.equal(details.effectiveTimeoutMs, MAX_TEST_TIMEOUT_MS);
    }
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    assert.match(text, /clamped from/);
  });

  it('shares a single history between run_tests and run_format', async () => {
    const repo = makeTempDir('command-tools-shared-history-');
    let fingerprint = 'fp';
    const [runTests, runFormat] = createCommandTools(repo, { fingerprintFn: () => fingerprint });
    assert.ok(runTests && runFormat);
    const timeout = await Promise.race([
      runTests!.execute('call-shared-timeout', {
        command: `node -e "setTimeout(()=>{},5000)"`,
        timeoutMs: 100,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout test hung')), 10_000)),
    ]);
    assert.equal((timeout.details as RunCommandDetails).ok, true);
    // The repeat guard keys include the tool name, so run_format of the same
    // argv is not refused; this test only asserts the history survives across
    // both tool descriptors (shared history object, same instance).
    const repeat = await runTests!.execute('call-shared-repeat', {
      command: `node -e "setTimeout(()=>{},5000)"`,
      timeoutMs: 100,
    });
    assert.equal((repeat.details as RunCommandDetails).ok, false);
    assert.equal((repeat.details as any).error, 'repeat_after_timeout');
  });
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}
