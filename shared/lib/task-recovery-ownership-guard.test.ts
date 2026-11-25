import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkGuardSource, formatGuardResult, runSourceGuard } from '../../tools/lib/source-guard.ts';
import { existsSync } from 'node:fs';
import { RECOVERY_WAKE_PRODUCERS, TASK_RECOVERY_OWNERSHIP_GUARD, TASK_RECOVERY_WAKE_GUARD } from './task-recovery-ownership-guard.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const patternsOf = (file: string, source: string) =>
  checkGuardSource(TASK_RECOVERY_OWNERSHIP_GUARD, file, source).map((finding) => finding.pattern);

describe('task-recovery-ownership guard — HOK-3406 Observer migration', () => {
  it('rejects the retired route-refusal boolean and private stop adapter', () => {
    for (const source of ['local contract_available=false', '_stop_task_recovery_contract_unavailable "$issue"']) {
      assert.deepEqual(patternsOf('shared/lib/wavemill-monitor.sh', `${source}\n`), ['private-route-refusal']);
    }
    assert.deepEqual(patternsOf('shared/lib/wavemill-monitor.sh', 'execution_contract="$(recovery_contract_json "$issue" "$fd" coding)"\n'), []);
  });
  it('rejects a direct coding restore that races the supervised retry', () => {
    assert.deepEqual(patternsOf('shared/lib/wavemill-monitor.sh',
      '_restore_inflight_task_window_if_missing() {\n  launch_coding_phase "$issue"\n}\n'), ['competing-coding-restore']);
    assert.deepEqual(patternsOf('shared/lib/wavemill-monitor.sh',
      '_restore_inflight_task_window_if_missing() {\n  _request_launch_recovery "$issue" coding\n}\n'), []);
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

describe('task-recovery-ownership guard — HOK-3512 one refusal outcome', () => {
  const CONTROLLER = 'shared/lib/task-recovery-controller.ts';
  const wakePatterns = (source: string) =>
    checkGuardSource(TASK_RECOVERY_WAKE_GUARD, CONTROLLER, source).map((finding) => finding.pattern);

  it('flags a controller wait whose wake has no producer (the deleted execution-contract-available hold)', () => {
    assert.deepEqual(wakePatterns("      wait: { owner: 'tool', wake: 'execution-contract-available' },\n"), ['recovery-wakeless-wait']);
  });

  it('accepts produced wakes, including ternary alternatives', () => {
    assert.deepEqual(wakePatterns("wait: { owner: 'backoff', wake: 'backoff-elapsed' },\n"), []);
    assert.deepEqual(wakePatterns("wake: waiting.kind === 'background' ? 'background-work-complete' : 'operator-release',\n"), []);
  });

  it('names a real producer file for every declared wake', () => {
    for (const [wake, producer] of Object.entries(RECOVERY_WAKE_PRODUCERS)) {
      const path = producer.split(' ')[0]!;
      assert.ok(existsSync(join(repoRoot, path)), `${wake} producer ${path} is missing`);
    }
  });

  it('flags a private stopped write or raw hook for a contract refusal', () => {
    assert.deepEqual(patternsOf('a.sh', '       | .tasks[$issue].stopReason = "recovery_contract_unavailable"\n'), ['contract-refusal-private-stop']);
    assert.deepEqual(patternsOf('a.sh', '    wavemill_hook_write "blocked" "recovery_contract_unavailable" "$detail"\n'), ['contract-refusal-private-stop']);
    assert.deepEqual(patternsOf('a.ts', "task.stopReason = 'recovery_contract_unavailable';\n"), ['contract-refusal-private-stop']);
  });

  it('passes at HEAD', () => {
    const result = runSourceGuard(TASK_RECOVERY_WAKE_GUARD, repoRoot);
    assert.deepEqual(result.findings, [], formatGuardResult(TASK_RECOVERY_WAKE_GUARD, result));
  });
});
