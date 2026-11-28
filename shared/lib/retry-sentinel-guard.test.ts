import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkGuardSource, formatGuardResult, runSourceGuard } from '../../tools/lib/source-guard.ts';
import { RETRY_SENTINEL_GUARD } from './retry-sentinel-guard.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Build `${…}` fragments by concatenation so the template-curly guard does not
// flag these fixtures (plain strings must never contain `${…}`).
const dollarOpen = '$' + '{';

const patternsOf = (file: string, source: string) =>
  checkGuardSource(RETRY_SENTINEL_GUARD, file, source).map((finding) => finding.pattern);

describe('retry-sentinel guard — forbidden shapes', () => {
  it('flags hand-built bounded-retry storage paths in shell', () => {
    assert.deepEqual(patternsOf('a.sh', 'echo 1 > "$state_dir/.retry-' + dollarOpen + 'bucket}-count"\n'), ['retry-state-file']);
    assert.deepEqual(patternsOf('a.sh', 'cat "$dir/.retry-$bucket-head"\n'), ['retry-state-file']);
    assert.deepEqual(patternsOf('a.sh', 'touch "$dir/.retry-coding-dirty-handoff-exhausted"\n'), ['retry-state-file']);
    assert.deepEqual(patternsOf('a.sh', 'rm -f "$dir/.failed-ready-recheck-last-at"\n'), ['retry-state-file']);
  });

  it('flags hand-built storage paths and bare prefixes in TS', () => {
    assert.deepEqual(patternsOf('a.ts', 'const p = join(dir, `.retry-' + dollarOpen + 'bucket}-exhausted`);\n'), ['retry-state-file']);
    assert.deepEqual(patternsOf('a.ts', 'const prefix = `.retry-' + dollarOpen + 'bucket}-`;\n'), ['retry-state-file']);
  });

  it('flags a new private attempt-counter state file', () => {
    assert.deepEqual(patternsOf('a.ts', "const f = join(dir, '.relaunch-attempts.json');\n"), ['private-attempt-counter-file']);
    assert.deepEqual(patternsOf('a.sh', 'echo "$n" > "$feature_dir/.review-retries"\n'), ['private-attempt-counter-file']);
    assert.deepEqual(patternsOf('a.sh', 'echo "$n" > "$feature_dir/.push-retry-count"\n'), ['private-attempt-counter-file']);
  });

  it('flags legacy retry files and generic count files', () => {
    assert.deepEqual(patternsOf('a.sh', 'retry_file="/tmp/wavemill-$session-$issue.retry"\n'), ['legacy-private-retry-file']);
    assert.deepEqual(patternsOf('a.sh', 'count_file="/tmp/wavemill-456-count"\n'), ['private-count-file']);
    assert.deepEqual(patternsOf('a.sh', 'count_file="$state_dir/.transient-mergeability-count"\n'), ['private-count-file']);
  });
});

describe('retry-sentinel guard — clean shapes', () => {
  it('ignores the helper API, unrelated dotfiles, and prose', () => {
    const source = [
      'bounded_retry_increment "$state_dir" "coding-dirty-handoff"',
      'if bounded_retry_is_exhausted "$state_dir" "$bucket"; then',
      'cat "$state_dir/.retry-policy.json"',
      'max_attempts=3',
      '# a private .retry-foo-count file would be wrong here',
      '',
    ].join('\n');
    assert.deepEqual(patternsOf('a.sh', source), []);
    assert.deepEqual(patternsOf('a.ts', 'const retry = createStateDirRetry({ stateDir, bucket });\nconst attempts = 3;\n'), []);
  });

  it('honours the allow-retry-sentinel suppression', () => {
    assert.deepEqual(patternsOf('a.sh', '# allow-retry-sentinel: detection only\ncat "$d/.retry-x-count"\n'), []);
  });
});

describe('stage retry input ownership', () => {
  it('rejects output-keyed admission and accounting', () => {
    for (const name of ['_monitor_claim_failed_stage_action', '_dispatch_failed_stage_recovery']) {
      const source = `${name}() {\n  bounded_retry_gate "$feature_dir" "$bucket" "$head" 3\n}\n`;
      assert.deepEqual(patternsOf('shared/lib/wavemill-monitor.sh', source), ['stage-retry-input']);
    }
  });

  it('accepts both callers consuming the declared input key', () => {
    const source = '_monitor_claim_failed_stage_action() {\n'
      + '  retry_identity="$(stage_failure_retry_key "$issue" "$feature_dir" "$stage")"\n'
      + '  bounded_retry_gate "$feature_dir" "$bucket" "$retry_key" 3\n}\n';
    assert.deepEqual(patternsOf('shared/lib/wavemill-monitor.sh', source), []);
  });
});

describe('retry-sentinel guard — repository', () => {
  it('passes at HEAD with the seeded allowlist', () => {
    const result = runSourceGuard(RETRY_SENTINEL_GUARD, repoRoot);
    assert.deepEqual(result.findings, [], formatGuardResult(RETRY_SENTINEL_GUARD, result));
    assert.ok(result.scannedFiles > 0);
  });
});
