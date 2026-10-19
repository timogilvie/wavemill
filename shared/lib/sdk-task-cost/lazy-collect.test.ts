import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SDK_TASK_COST_SHADOW_ENV } from './feature-switch.ts';
import { collectSdkTaskCostSummariesLazy } from './lazy-collect.ts';
import { runSdkTaskCostShadow } from './shadow.ts';

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

  it('never loads the SDK when the shadow switch is off', async () => {
    let loads = 0;
    const result = await runSdkTaskCostShadow(
      () => collectSdkTaskCostSummariesLazy(input, async () => {
        loads += 1;
        return staleSdk();
      }),
      { label: 'Eval', env: {}, logger: silentLogger() },
    );
    assert.equal(result, null);
    assert.equal(loads, 0);
  });

  it('swallows a stale-SDK load failure when on', async () => {
    const warnings: string[] = [];
    const result = await runSdkTaskCostShadow(
      () => collectSdkTaskCostSummariesLazy(input, staleSdk),
      { label: 'Eval', env: { [SDK_TASK_COST_SHADOW_ENV]: 'on' }, logger: silentLogger(warnings) },
    );
    assert.equal(result, null);
    assert.ok(warnings.some((warning) => warning.includes("export named 'aggregateTaskCost'")));
  });

  it('rethrows a stale-SDK load failure in strict mode', async () => {
    await assert.rejects(
      runSdkTaskCostShadow(
        () => collectSdkTaskCostSummariesLazy(input, staleSdk),
        { label: 'Eval', env: { [SDK_TASK_COST_SHADOW_ENV]: 'strict' }, logger: silentLogger() },
      ),
      SyntaxError,
    );
  });
});

describe('eval entrypoints load when the SDK task-cost exports are unavailable', () => {
  // protects: a value import of the SDK barrel/collector/contract from an eval
  // entrypoint, which turns a stale @hokusai/core install into a module-load
  // SyntaxError for every eval even with the shadow switch off.
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

  for (const file of ['eval-orchestrator.ts', 'post-completion-hook.ts']) {
    it(file, () => {
      const result = importUnderStaleSdk(file);
      assert.equal(result.status, 0, result.stderr);
    });
  }
});
