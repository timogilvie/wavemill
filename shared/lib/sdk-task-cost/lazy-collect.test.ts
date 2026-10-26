import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectSdkTaskCostSummariesLazy } from './lazy-collect.ts';
import { meterWorkflowCost } from './meter.ts';

const libDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const input = { worktreePath: '/nonexistent', branchName: 'task/x' };
const staleSdk = async () => {
  throw new SyntaxError(
    "The requested module '@hokusai/core' does not provide an export named 'aggregateTaskCost'",
  );
};

function silentLogger(warnings: string[] = []) {
  return { log: () => {}, warn: (message: string) => warnings.push(String(message)) };
}

describe('collectSdkTaskCostSummariesLazy', () => {
  it('delegates to the loaded collector', async () => {
    const result = await collectSdkTaskCostSummariesLazy(input, async () => ({
      collectSdkTaskCostSummaries: (received) => {
        assert.deepEqual(received, input);
        return null;
      },
    }));
    assert.equal(result, null);
  });

  it('a stale-SDK load failure becomes an adapter_error cost, never a thrown eval', async () => {
    const warnings: string[] = [];
    const metered = await meterWorkflowCost({
      ...input,
      label: 'Eval',
      collect: (received) => collectSdkTaskCostSummariesLazy(received, staleSdk),
      logger: silentLogger(warnings),
    });
    assert.equal(metered.summaries, null);
    assert.equal(metered.outcome.status, 'adapter_error');
    assert.equal(metered.reason, 'collection_failed');
    assert.ok(warnings.some((warning) => warning.includes("export named 'aggregateTaskCost'")));
  });
});

describe('eval entrypoints load when the SDK task-cost exports are unavailable', () => {
  // protects: a value import of the SDK barrel/collector/contract from an eval
  // entrypoint (or the metering runner they share), which turns a stale
  // @hokusai/core install into a module-load SyntaxError for every eval.
  //
  // A loader hook fails `sdk-task-cost/contract.ts` (the one module that
  // imports the SDK's task-cost names) the way a stale install does, then a
  // child process imports the module under test.
  let hookDir = '';
  before(() => {
    hookDir = mkdtempSync(join(tmpdir(), 'sdk-cost-stale-'));
    writeFileSync(join(hookDir, 'hooks.mjs'), [
      'export async function load(url, context, next) {',
      "  if (url.endsWith('/sdk-task-cost/contract.ts')) {",
      "    throw new SyntaxError(\"The requested module '@hokusai/core' does not provide an export named 'aggregateTaskCost'\");",
      '  }',
      '  return next(url, context);',
      '}',
    ].join('\n'));
    writeFileSync(
      join(hookDir, 'register.mjs'),
      "import { register } from 'node:module';\nregister('./hooks.mjs', import.meta.url);\n",
    );
  });
  after(() => rmSync(hookDir, { recursive: true, force: true }));

  function importUnderStaleSdk(file: string) {
    const url = pathToFileURL(join(libDir, file)).href;
    return spawnSync(
      process.execPath,
      ['--import', join(hookDir, 'register.mjs'), '--input-type=module', '-e', `await import(${JSON.stringify(url)});`],
      { encoding: 'utf8', timeout: 60_000 },
    );
  }

  it('the stale-SDK hook does break the SDK barrel (oracle check)', () => {
    const result = importUnderStaleSdk('sdk-task-cost/index.ts');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /export named 'aggregateTaskCost'/);
  });

  for (const file of ['eval-orchestrator.ts', 'post-completion-hook.ts', 'sdk-task-cost/meter.ts']) {
    it(file, () => {
      const result = importUnderStaleSdk(file);
      assert.equal(result.status, 0, result.stderr);
    });
  }
});
