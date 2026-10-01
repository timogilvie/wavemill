import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  commandToolsAfterToolCall,
  createCommandTools,
  createRunFormatTool,
  createRunTestsTool,
  CommandRunHistory,
  MAX_FORMAT_TIMEOUT_MS,
  runScopedCommand,
  type RunCommandDetails,
} from './command-tools.ts';

const tempDirs = new Set<string>();

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('native-agent command tool registry and substrate facade', () => {
  it('registers run_tests and run_format with the expected metadata', () => {
    const repo = makeTempDir('command-tool-metadata-');
    const tools = createCommandTools(repo);

    assert.equal(tools.length, 2);
    assert.equal(tools[0]?.metadata.name, 'run_tests');
    assert.equal(tools[1]?.metadata.name, 'run_format');
    assert.deepEqual(
      tools.map((tool) => tool.metadata),
      [
        {
          name: 'run_tests',
          description: tools[0]!.metadata.description,
          class: 'read-only',
          allowedPhases: ['coding'],
          executionMode: 'sequential',
          outputCapPolicy: { strategy: 'truncate', maxBytes: 64 * 1024 },
        },
        {
          name: 'run_format',
          description: tools[1]!.metadata.description,
          class: 'mutation',
          allowedPhases: ['coding'],
          executionMode: 'sequential',
          outputCapPolicy: { strategy: 'truncate', maxBytes: 64 * 1024 },
        },
      ],
    );
  });

  it('propagates the default timeout by tool kind and honors overrides', async () => {
    const repo = makeTempDir('command-tool-timeout-');
    const delays: number[] = [];
    const restore = recordTimeoutDelays(delays);

    try {
      const runTests = createRunTestsTool(repo);
      const runFormat = createRunFormatTool(repo);

      const testResult = await runTests.execute('call-tests-default-timeout', { command: `node -e ""` });
      const formatResult = await runFormat.execute('call-format-default-timeout', { command: `node -e ""` });
      const overrideResult = await Promise.race([
        runScopedCommand({
          tool: 'run_format',
          kind: 'format',
          command: `node -e "setTimeout(function(){},90000)"`,
          worktreePath: repo,
          defaultTimeoutMs: 60_000,
          maxTimeoutMs: MAX_FORMAT_TIMEOUT_MS,
          timeoutMs: 200,
          allowFullSuite: true,
          history: new CommandRunHistory(),
          fingerprintFn: () => 'fixed',
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('override timeout test hung')), 10_000);
        }),
      ]);

      assert.equal((testResult.details as RunCommandDetails).ok, true);
      assert.equal((formatResult.details as RunCommandDetails).ok, true);

      const timeoutDelays = delays.filter((delay) => delay >= 200);
      assert.ok(timeoutDelays.includes(300_000));
      assert.ok(timeoutDelays.includes(60_000));
      assert.ok(timeoutDelays.includes(200));

      const overrideDetails = overrideResult.details as RunCommandDetails;
      assert.equal(overrideDetails.ok, true);
      if (overrideDetails.ok) {
        assert.equal(overrideDetails.status, 'timed_out');
        assert.equal(overrideDetails.timedOut, true);
      }
    } finally {
      restore();
    }
  });

  it('treats unknown tool names as no-ops in afterToolCall', async () => {
    const result = await commandToolsAfterToolCall({
      toolCall: { name: 'read_file' },
      result: { details: { ok: false } },
    });

    assert.equal(result, undefined);
  });

  it('propagates abort signals to the shared command substrate', async () => {
    const repo = makeTempDir('command-tool-abort-');
    const controller = new AbortController();
    controller.abort();

    const runTests = createRunTestsTool(repo);
    const result = await Promise.race([
      runTests.execute(
        'call-tests-abort',
        { command: `node -e "setTimeout(function(){},5000)"` },
        controller.signal,
      ),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('abort test hung')), 10_000);
      }),
    ]);

    const details = result.details as RunCommandDetails;
    assert.equal(details.ok, true);
    if (details.ok) {
      assert.equal(details.status, 'timed_out');
      assert.equal(details.timedOut, true);
      assert.equal(details.exitCode, null);
      assert.ok(details.durationMs < 4_000);
    }
  });

  it('rejects invalid maxOutputBytes without spawning and matches direct calls', async () => {
    const repo = makeTempDir('command-tool-invalid-max-');
    const runTests = createRunTestsTool(repo);

    const viaTool = await runTests.execute('call-tests-invalid-max', {
      command: `node -e process.stdout.write('ok')`,
      maxOutputBytes: 0,
    });
    const direct = await runScopedCommand({
      tool: 'run_tests',
      kind: 'tests',
      worktreePath: repo,
      defaultTimeoutMs: 300_000,
      command: `node -e process.stdout.write('ok')`,
      maxOutputBytes: 0,
    });

    const toolDetails = viaTool.details as RunCommandDetails;
    const directDetails = direct.details as RunCommandDetails;
    assert.equal(toolDetails.ok, false);
    assert.equal(directDetails.ok, false);
    if (!toolDetails.ok && !directDetails.ok) {
      assert.equal(toolDetails.error, 'invalid_input');
      assert.equal(toolDetails.reason, 'invalid-max-output-bytes');
      assert.deepEqual(
        { ...toolDetails, durationMs: 0 },
        { ...directDetails, durationMs: 0 },
      );
    }
  });

  it('stays on the shared substrate path without direct child_process usage', () => {
    const source = readFileSync(new URL('./command-tools.ts', import.meta.url), 'utf8');
    assert.ok(!source.includes('node:child_process'));
    assert.ok(!source.includes("require('child_process')"));
  });
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

function recordTimeoutDelays(bucket: number[]): () => void {
  const originalSetTimeout = globalThis.setTimeout;
  const patched: typeof setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    if (typeof timeout === 'number') {
      bucket.push(timeout);
    }
    return originalSetTimeout(handler, timeout, ...args);
  }) as typeof setTimeout;

  globalThis.setTimeout = patched;
  return () => {
    globalThis.setTimeout = originalSetTimeout;
  };
}
