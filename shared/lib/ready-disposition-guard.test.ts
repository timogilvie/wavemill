import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkGuardSource, formatGuardResult, runSourceGuard } from '../../tools/lib/source-guard.ts';
import { READY_DISPOSITION_GUARD } from './ready-disposition-guard.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const patternsOf = (file: string, source: string) =>
  checkGuardSource(READY_DISPOSITION_GUARD, file, source).map((finding) => finding.pattern);

describe('ready-disposition guard — forbidden shapes', () => {
  // protects: the deleted monitor hold (HOK-3316) coming back in shell
  it('flags the old running + same-head shell hold', () => {
    assert.deepEqual(
      patternsOf('shared/lib/wavemill-monitor.sh', '    if [[ "$ready_status" == "running" ]] && [[ -n "$launch_head" ]] && [[ "$launch_head" == "$current_head" ]]; then\n'),
      ['shell-launch-head-equality'],
    );
    assert.deepEqual(
      patternsOf('shared/lib/wavemill-monitor.sh', '  [[ "$remediation_launch_head" != "$current_head" ]] && return 0\n'),
      ['shell-launch-head-equality'],
    );
    assert.deepEqual(
      // allow-template-curly: literal shell `${...}` source under test
      patternsOf('shared/lib/x.sh', '  [[ "$current_head" == "${conflict_launch_head}" ]]\n'),
      ['shell-launch-head-equality'],
    );
  });

  // protects: a private same-head in-flight predicate in the watchdog (or anywhere in TS)
  it('flags a TS launch-head comparison on either side', () => {
    assert.deepEqual(
      patternsOf('shared/lib/ready-watchdog.ts', "if (status === 'running' && launchHead === currentHead) {\n"),
      ['launch-head-equality'],
    );
    assert.deepEqual(
      patternsOf('shared/lib/ready-watchdog.ts', '  && snapshot.currentHead === snapshot.remediationLaunchHead;\n'),
      ['launch-head-equality'],
    );
  });

  // protects: the retired agentIdle → pane ownership override (a second owner rule)
  it('flags an agentIdle override of pane ownership', () => {
    assert.deepEqual(
      patternsOf('shared/lib/ready-watchdog.ts', '  if (paneActive === true && taskProgress?.agentIdle) {\n'),
      ['pane-idle-override'],
    );
  });
});

describe('ready-disposition guard — clean shapes', () => {
  // protects: false positives on the migrated call sites
  it('ignores disposition consumers, comments and unrelated heads', () => {
    const ts = [
      "  } else if (snapshot.remediationDisposition.kind === 'in-flight') {",
      '  launchHead: remediationLaunchHead,',
      '// if (status === \'running\' && launchHead === currentHead) would be the old defect',
      '',
    ].join('\n');
    assert.deepEqual(patternsOf('shared/lib/ready-watchdog.ts', ts), []);
    const sh = [
      '  if [[ "$(ready_remediation_disposition "$issue" "$state_dir" "$remediation_launch_head" "$current_head")" == "in-flight" ]]; then',
      '  # [[ "$launch_head" == "$current_head" ]] was the old hold',
      '  [[ "$head" == "$current_head" ]]',
      '',
    ].join('\n');
    assert.deepEqual(patternsOf('shared/lib/wavemill-monitor.sh', sh), []);
  });

  // protects: a justified exception being impossible to record
  it('honours the allow-ready-disposition suppression', () => {
    assert.deepEqual(
      patternsOf('shared/lib/x.ts', 'const moved = launchHead !== head; // allow-ready-disposition: verification artifact naming\n'),
      [],
    );
  });
});

describe('ready-disposition guard — repository', () => {
  // protects: a private in-flight predicate landing anywhere in tracked
  // production code (the canonical module and its shell twin are excluded)
  it('passes at HEAD', () => {
    const result = runSourceGuard(READY_DISPOSITION_GUARD, repoRoot);
    assert.deepEqual(result.findings, [], formatGuardResult(READY_DISPOSITION_GUARD, result));
  });
});
