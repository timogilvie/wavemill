import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkGuardSource, formatGuardResult, runSourceGuard } from '../../tools/lib/source-guard.ts';
import { TASK_RECOVERY_OWNERSHIP_GUARD } from './task-recovery-ownership-guard.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const patternsOf = (file: string, source: string) =>
  checkGuardSource(TASK_RECOVERY_OWNERSHIP_GUARD, file, source).map((finding) => finding.pattern);

describe('task-recovery-ownership guard — HOK-3406 Observer migration', () => {
  it('flags the wakeless saved-route wait and private stopped-state writer', () => {
    assert.deepEqual(patternsOf('shared/lib/task-recovery-controller.ts', "wake: 'execution-contract-available'\n"), ['unproduced-contract-wait']);
    assert.deepEqual(patternsOf('shared/lib/wavemill-monitor.sh', 'stopReason = "recovery_contract_unavailable"\n'), ['private-contract-refusal-stop']);
  });

  it('flags a re-import of the deleted observer auto-fix engine', () => {
    assert.deepEqual(
      patternsOf('tools/observer.ts', "import { runObserverAutoFixes } from '../shared/lib/observer-auto-fix.ts';\n"),
      ['observer-auto-fix-import'],
    );
  });

  it('flags the retired Observer repair bucket names in TS and shell', () => {
    assert.deepEqual(patternsOf('a.ts', "createStateDirRetry('observer-update-branch');\n"), ['observer-repair-bucket']);
    assert.deepEqual(patternsOf('a.sh', 'bucket="observer-ready-budget-reset"\n'), ['observer-repair-bucket']);
    assert.deepEqual(patternsOf('a.sh', 'rm -f "$dir/.retry-observer-forfeit-arm-exhausted"\n'), ['observer-repair-bucket']);
  });

  it('flags a repair executor called directly from tools/observer.ts', () => {
    for (const call of [
      'await updateBranchWithBase(branch, base, wt);',
      'await abortTaskInState(stateFile, issue, reason);',
      'recordArmTermination({});',
      "const retry = createStateDirRetry('bucket');",
      'await runObserverAutoFixes(deps);',
    ]) {
      assert.deepEqual(patternsOf('tools/observer.ts', `${call}\n`), ['observer-executor-call'], call);
    }
  });

  it('does not flag repair executors outside tools/observer.ts', () => {
    assert.deepEqual(patternsOf('shared/lib/promotion-controller.ts', 'await updateBranchWithBase(a, b, c);\n'), []);
  });

  it('flags the removed auto-fix configuration and flag surface in tools/observer.ts', () => {
    assert.deepEqual(patternsOf('tools/observer.ts', 'options.autoFixDryRun = true;\n'), ['observer-autofix-surface']);
    assert.deepEqual(patternsOf('tools/observer.ts', 'getObserverAutoFixConfig(repoDir);\n'), ['observer-autofix-surface']);
    assert.deepEqual(patternsOf('tools/observer.ts', 'let config: ObserverAutoFixConfig;\n'), ['observer-autofix-surface']);
  });

  it('honours the suppression marker', () => {
    assert.deepEqual(
      patternsOf('tools/observer.ts', "// allow-task-recovery-ownership: replay fixture\nawait abortTaskInState(s, i, r);\n"),
      [],
    );
  });

  it('passes at HEAD', () => {
    const result = runSourceGuard(TASK_RECOVERY_OWNERSHIP_GUARD, repoRoot);
    assert.deepEqual(result.findings, [], formatGuardResult(TASK_RECOVERY_OWNERSHIP_GUARD, result));
  });
});
