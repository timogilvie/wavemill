// protects: HOK-3371 — the Ready-failure-policy guard fires on a Ready-failure
// branch that never names the failure policy, on the retired github-api stage
// default, and on any live reference to the retired failed-ready-recheck
// bucket; a compliant branch and comment-only mentions stay clean.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { checkGuardSource } from '../../tools/lib/source-guard.ts';
import { READY_FAILURE_POLICY_GUARD } from './ready-failure-policy-guard.ts';

const compliantFailedBlock = [
  'run_failed_ready_block() {',
  '  if [[ "$ready_status" == "failed" ]]; then',
  '    if ready_failure_classify_and_act "$ISSUE" "$SLUG" "$state_dir" "$wt" "$branch" "$base" "$PR" "$WIN" "$head"; then',
  '      ready_disposition=0',
  '    else',
  '      ready_disposition=$?',
  '    fi',
  '  fi',
  '}',
].join('\n');

test('a Ready-failure branch that dispatches through the policy is clean', () => {
  const findings = checkGuardSource(READY_FAILURE_POLICY_GUARD, 'shared/lib/wavemill-monitor.sh', compliantFailedBlock);
  assert.deepEqual(findings, []);
});

test('a Ready-failure branch without a policy call is a finding', () => {
  const bogus = [
    'run_failed_ready_block() {',
    '  if [[ "$ready_status" == "failed" ]]; then',
    '    echo "Bypassing policy"',
    '    marker_write "$state_dir/.ready-failed"',
    '  fi',
    '}',
  ].join('\n');
  const findings = checkGuardSource(READY_FAILURE_POLICY_GUARD, 'shared/lib/wavemill-monitor.sh', bogus);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pattern, 'ready-failure-branch-without-policy');
  assert.equal(findings[0].line, 2);
});

test('a policy call beyond the branch does not satisfy the anchor', () => {
  // The policy call sits further out than the branch window, so the
  // hand-inserted branch still fires.
  const distant = [
    'run_failed_ready_block() {',
    '  if [[ "$ready_status" == "failed" ]]; then',
    '    echo "Bypassing policy"',
    '  fi',
    ...Array.from({ length: 70 }, (_, i) => `  log "filler ${i}"`),
    '  ready_failure_classify_and_act "$ISSUE" "$SLUG" "$state_dir" "$wt" "$b" "$base" "$PR" "$WIN" "$head"',
    '}',
  ].join('\n');
  const findings = checkGuardSource(READY_FAILURE_POLICY_GUARD, 'shared/lib/wavemill-monitor.sh', distant);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pattern, 'ready-failure-branch-without-policy');
});

test('the github-api stage default is forbidden', () => {
  const findings = checkGuardSource(READY_FAILURE_POLICY_GUARD, 'shared/lib/wavemill-monitor.sh', 'transition_stage="github-api"');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pattern, 'github-api-fallback-stage-default');
});

test('the retired failed-ready-recheck bucket is forbidden in code but not in prose', () => {
  const code = checkGuardSource(READY_FAILURE_POLICY_GUARD, 'shared/lib/wavemill-monitor.sh', 'increment_failed_ready_recheck_count "$dir" "$head"');
  assert.equal(code.length, 1);
  assert.equal(code[0].pattern, 'legacy-failed-ready-recheck-bucket');
  const prose = checkGuardSource(READY_FAILURE_POLICY_GUARD, 'shared/lib/wavemill-monitor.sh', '# The failed-ready-recheck bucket is retired (HOK-3371).');
  assert.deepEqual(prose, []);
});

test('the suppression marker exempts one line', () => {
  const suppressed = [
    '# allow-ready-failure-policy: upgrade-compatibility shim kept for in-flight sessions',
    // allow-template-curly: fixture quotes the shim line verbatim; "${bucket}" is literal text under test, not an interpolation.
    "const name = bucket === 'failed-ready-recheck' ? '.failed-ready-recheck-exhausted' : `.retry-${bucket}-exhausted`;",
  ].join('\n');
  const findings = checkGuardSource(READY_FAILURE_POLICY_GUARD, 'tools/observer.ts', suppressed);
  assert.deepEqual(findings, []);
});