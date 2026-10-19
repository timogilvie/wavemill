import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
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

describe('eval entrypoints keep the SDK off their static import graph', () => {
  // A value import of the barrel, the collector, or the contract pulls
  // `@hokusai/core`'s task-cost exports in at module load, so a stale install
  // fails every eval even with the shadow switch off.
  const forbidden = /^import\s+(?!type\b)[^;]*from\s+'\.\/sdk-task-cost\/(index|collect|contract)\.ts'/m;

  for (const file of ['eval-orchestrator.ts', 'post-completion-hook.ts']) {
    it(file, () => {
      const source = readFileSync(join(libDir, file), 'utf8');
      assert.doesNotMatch(source, forbidden);
    });
  }
});
