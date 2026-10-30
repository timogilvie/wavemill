import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkGuardSource, formatGuardResult, runSourceGuard } from '../../tools/lib/source-guard.ts';
import { READY_REMEDIATION_DISPOSITION_GUARD } from './ready-remediation-disposition-guard.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const patternsOf = (file: string, source: string) =>
  checkGuardSource(READY_REMEDIATION_DISPOSITION_GUARD, file, source).map((finding) => finding.pattern);

describe('ready-remediation-disposition guard — retired holds', () => {
  // protects: the HOK-3322 incident hold (running + same head → unconditional return) coming back.
  it('flags the monitor same-head running hold and its private helpers', () => {
    assert.deepEqual(
      patternsOf('a.sh', 'if [[ "$ready_status" == "running" ]] && [[ -n "$launch_head" ]] && [[ "$launch_head" == "$current_head" ]]; then\n'),
      ['same-head-hold'],
    );
    assert.deepEqual(patternsOf('a.sh', '[[ "$current_head" != "${remediation_launch_head}" ]]\n'), ['same-head-hold']);
    assert.deepEqual(patternsOf('a.sh', 'launch_head=$(ready_remediation_launch_head "$dir")\n'), ['retired-shell-predicate']);
    assert.deepEqual(patternsOf('a.sh', 'if conflict_remediation_in_flight "$dir" "$head"; then\n'), ['retired-shell-predicate']);
  });

  // protects: a new private copy reading launch identity around the canonical reader.
  it('flags private launch-identity reads', () => {
    assert.deepEqual(patternsOf('a.sh', "h=$(jq -r '.detail.launchHead // empty' \"$marker\")\n"), ['private-launch-identity']);
    assert.deepEqual(patternsOf('a.sh', 'h=$(bounded_retry_head "$dir" "ready-remediation")\n'), ['private-launch-identity']);
    assert.deepEqual(patternsOf('a.ts', "const bucket = createStateDirRetry('ready-remediation', { maxAttempts: 3 });\n"), ['private-launch-bucket']);
  });

  // protects: the watchdog's retired private predicates (head equality, pane activity) returning.
  it('flags the watchdog head-equality and pane-activity predicates', () => {
    assert.deepEqual(patternsOf('a.ts', '  && snapshot.remediationLaunchHead === snapshot.currentHead;\n'), ['launch-head-equality']);
    assert.deepEqual(patternsOf('a.ts', 'if (snapshot.currentHead !== artifacts.launchHead) {\n'), ['launch-head-equality']);
    assert.deepEqual(patternsOf('a.ts', 'remediationPaneActive: paneActive,\n'), ['pane-activity-in-flight']);
  });
});

describe('ready-remediation-disposition guard — clean shapes', () => {
  // protects: the guard firing on readers of the shared decision, mirror writes or prose.
  it('ignores consumers of the decision, mirror writes, comments and suppressions', () => {
    assert.deepEqual(patternsOf('a.ts', "if (snapshot.remediationDisposition.kind === 'in-flight') hold();\n"), []);
    assert.deepEqual(patternsOf('a.ts', 'delete nextArtifacts.remediationLaunchHead;\n'), []);
    assert.deepEqual(patternsOf('a.sh', '        remediationLaunchHead: $launch_head,\n'), []);
    assert.deepEqual(patternsOf('a.sh', '# the old launch_head == current_head hold is gone\n'), []);
    assert.deepEqual(patternsOf('a.sh', 'read -r disposition _ < <(ready_remediation_disposition "$i" "$d" "$w" "$h")\n'), []);
    assert.deepEqual(
      patternsOf('a.sh', '# allow-ready-remediation-disposition: existence pre-filter\nh="$(bounded_retry_head "$d" "ready-remediation")"\n'),
      [],
    );
  });
});

describe('ready-remediation-disposition guard — repository', () => {
  // protects: a private in-flight decision landing anywhere in tracked source.
  it('passes at HEAD', () => {
    const result = runSourceGuard(READY_REMEDIATION_DISPOSITION_GUARD, repoRoot);
    assert.deepEqual(result.findings, [], formatGuardResult(READY_REMEDIATION_DISPOSITION_GUARD, result));
  });
});
