import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyArmFault } from './arm-failure-taxonomy.ts';
import {
  DEFAULT_RETRY_ATTEMPTS,
  TERMINAL_ALLOWLIST,
  TERMINAL_CODES_BEFORE_HOK_3176,
  canonicalFailureKind,
  classifyFailure,
  detectFailureKind,
  isTerminalKind,
  nextActionFor,
  retryBucketFor,
  terminalCauseFor,
} from './failure-policy.ts';

test('terminal-allowlist-is-explicit: every entry has a code, reason, and pinned test', () => {
  const codes = new Set<string>();
  for (const cause of TERMINAL_ALLOWLIST) {
    assert.match(cause.code, /^[a-z_-]+$/, `bad code ${cause.code}`);
    assert.ok(cause.reason.length > 20, `${cause.code} needs a real reason`);
    assert.match(cause.testRef, /^failure-policy\.test\.ts:terminal:/, `${cause.code} testRef`);
    assert.ok(!codes.has(cause.code), `duplicate allowlist code ${cause.code}`);
    codes.add(cause.code);
  }
  assert.ok(Object.isFrozen(TERMINAL_ALLOWLIST));
});

test('terminal-count-shrinks: fewer distinct terminal codes than before HOK-3176', () => {
  assert.ok(
    TERMINAL_ALLOWLIST.length < TERMINAL_CODES_BEFORE_HOK_3176,
    `allowlist grew to ${TERMINAL_ALLOWLIST.length} (was ${TERMINAL_CODES_BEFORE_HOK_3176})`,
  );
  const allStage = TERMINAL_ALLOWLIST.filter((cause) => !cause.challengeOnly);
  assert.equal(allStage.length, 8, 'all-stage terminals changed — update this pin deliberately');
});

test('allowlist fault classes agree with classifyArmFault attribution', () => {
  for (const cause of TERMINAL_ALLOWLIST) {
    assert.equal(
      classifyArmFault({ failureKind: cause.code }),
      cause.faultClass,
      `${cause.code} faultClass drifted from arm-failure-taxonomy`,
    );
  }
});

for (const code of [
  'policy-denied',
  'cancelled',
  'provider-config-error',
  'context-window-exceeded',
  'tool-use-unsupported',
  'varied_model_unresolvable',
  'operator-gate',
  'coding-dirty-handoff',
]) {
  test(`terminal:${code}`, () => {
    for (const challengeArm of [false, true]) {
      const decision = classifyFailure({ stage: 'coding', failureKind: code, challengeArm });
      assert.equal(decision.class, 'terminal');
      assert.equal(decision.cause?.code, code);
      assert.equal(decision.retryBucket, undefined);
    }
  });
}

test('terminal:challenge-only causes park challenge arms and retry everything else', () => {
  const challengeOnly = TERMINAL_ALLOWLIST.filter((cause) => cause.challengeOnly);
  assert.ok(challengeOnly.length > 0);
  for (const cause of challengeOnly) {
    assert.equal(classifyFailure({ stage: 'ready', failureKind: cause.code, challengeArm: true }).class, 'terminal');
    const solo = classifyFailure({ stage: 'ready', failureKind: cause.code, challengeArm: false });
    assert.equal(solo.class, 'retryable', `${cause.code} must not park a non-challenge task`);
    assert.equal(solo.retryBucket, 'stage-failure-ready');
  }
});

test('legacy aliases resolve to their canonical kind before the allowlist lookup', () => {
  assert.equal(canonicalFailureKind('invalid-model-id'), 'provider-config-error');
  assert.equal(canonicalFailureKind('openrouter-credits-exhausted'), 'provider-credit-exhausted');
  assert.equal(canonicalFailureKind('planning-artifact-invalid:missing_sections'), 'planning-artifact-invalid');
  assert.ok(isTerminalKind('invalid-model-id'));
  assert.ok(!isTerminalKind('openrouter-credits-exhausted'));
  assert.ok(!isTerminalKind(''));
  assert.equal(terminalCauseFor('ready-exhausted'), undefined);
  assert.equal(terminalCauseFor('ready-exhausted', true)?.code, 'ready-exhausted');
});

test('formerly terminal kinds now retry (HOK-3176 removals)', () => {
  for (const kind of [
    'native-unclassified',
    'provider-unknown-error',
    'provider-transient-error',
    'provider-rate-limited',
    'provider-quota-exhausted',
    'provider-credit-exhausted',
    'openrouter-credits-exhausted',
    'native-stage-timeout',
    'native-review-timeout',
    'empty-model-turn',
    'native-provider-error',
    'native-completion-protocol',
    'planning-turn-limit',
    'planning-artifact-invalid:missing_sections',
    'review-no-output',
    'coding-exited-without-result',
    'context-exhausted',
  ]) {
    const decision = classifyFailure({ stage: 'coding', failureKind: kind, challengeArm: true });
    assert.equal(decision.class, 'retryable', kind);
    assert.equal(decision.retryBucket, 'stage-failure-coding', kind);
  }
});

test('detectFailureKind keeps the monitor ladder precedence', () => {
  assert.equal(detectFailureKind('Provider finish_reason: error', 'no_completion_artifact'), 'native-completion-protocol');
  assert.equal(detectFailureKind('anything', 'invalid_completion_artifact'), 'native-completion-protocol');
  assert.equal(detectFailureKind('who knows', 'provider_error'), 'native-provider-error');
  assert.equal(detectFailureKind('who knows'), 'native-unclassified');
  assert.equal(detectFailureKind(''), 'native-unclassified');
  assert.equal(detectFailureKind(null), 'native-unclassified');
  // A stacked provider fault wins over the HOK-3129 model-output shape.
  assert.equal(
    detectFailureKind('Native planning final artifact rejected: missing_plan (402 Payment Required)'),
    'provider-credit-exhausted',
  );
  assert.equal(
    detectFailureKind('Native planning final artifact rejected: missing_plan_sections after repair'),
    'planning-artifact-invalid:missing_plan_sections',
  );
  assert.equal(detectFailureKind('Native planning final artifact rejected:'), 'planning-artifact-invalid');
});

test('code failures are recognised and carry their excerpt', () => {
  const conflict = 'Auto-merging a.ts\nCONFLICT (content): Merge conflict in a.ts\nerror: could not apply 1a2b3c4... HOK-1';
  const decision = classifyFailure({ stage: 'tend', detail: conflict });
  assert.equal(decision.class, 'code-failure');
  assert.equal(decision.codeFailureExcerpt, conflict);
  assert.match(decision.rationale, /CONFLICT/);

  assert.equal(classifyFailure({ stage: 'ready', ciCategory: 'deterministic-local', detail: 'lint' }).class, 'code-failure');
  assert.equal(classifyFailure({ stage: 'tend', failureKind: 'checks-failed', detail: 'unit: fail' }).class, 'code-failure');
});

test('transient signatures override code-failure kinds', () => {
  const decision = classifyFailure({
    stage: 'tend',
    failureKind: 'checks-failed',
    detail: 'unit: fail — The hosted runner encountered an error while running your job',
  });
  assert.equal(decision.class, 'retryable');
  assert.equal(decision.retryBucket, 'tend-transient-recovery');
  assert.equal(
    classifyFailure({ stage: 'tend', failureKind: 'checks-failed', ciCategory: 'transient-infra' }).class,
    'retryable',
  );
});

test('next actions: known kinds keep their hint, unknown kinds get the default', () => {
  assert.match(nextActionFor('context-window-exceeded'), /compressed context/);
  assert.match(nextActionFor('context-exhausted'), /larger-context model/);
  assert.match(nextActionFor('provider-credit-exhausted'), /top up OpenRouter credits/);
  assert.match(nextActionFor('openrouter-credits-exhausted'), /top up OpenRouter credits/);
  assert.match(nextActionFor('empty-model-turn'), /bounded continuation/);
  assert.match(nextActionFor('planning-artifact-invalid:missing_plan'), /structural validation/);
  assert.match(nextActionFor('native-unclassified'), /retries it with backoff/);
  assert.equal(nextActionFor('never-seen'), 'inspect the native provider error, then relaunch the phase');
});

test('retry buckets and attempts are shared constants', () => {
  assert.equal(retryBucketFor('coding'), 'stage-failure-coding');
  assert.equal(retryBucketFor('tend'), 'tend-transient-recovery');
  assert.equal(DEFAULT_RETRY_ATTEMPTS, 3);
});
