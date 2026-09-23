import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyArmFault,
  isModelQualitySignal,
  parseAbortFailureKind,
} from './arm-failure-taxonomy.ts';

test('classifies the incident failure kinds into the intended fault classes', () => {
  assert.equal(classifyArmFault({
    failureKind: 'context-window-exceeded',
    detail: "400 maximum context length is 131072 tokens; you requested about 131182",
  }), 'harness-fault');

  assert.equal(classifyArmFault({
    failureKind: 'context-exhausted',
    detail: 'context-exhausted: compacted native coding context to the floor',
  }), 'harness-fault');

  assert.equal(classifyArmFault({
    failureKind: 'tool-use-unsupported',
    detail: '404 No endpoints found that support tool use',
  }), 'selection-fault');

  assert.equal(classifyArmFault({
    failureKind: 'native-provider-error',
    detail: 'Stream ended without finish_reason',
  }), 'model-fault');

  assert.equal(classifyArmFault({
    failureKind: 'empty-model-turn',
    detail: 'empty-model-turn: model returned reasoning-only turns',
  }), 'harness-fault');
});

test('classifies provider and ambiguous failures conservatively', () => {
  assert.equal(classifyArmFault({ failureKind: 'provider-rate-limited' }), 'provider-fault');
  assert.equal(classifyArmFault({ failureKind: 'provider-quota-exhausted' }), 'provider-fault');
  assert.equal(classifyArmFault({ failureKind: 'provider-transient-error' }), 'provider-fault');
  assert.equal(classifyArmFault({ failureKind: 'provider-credit-exhausted' }), 'harness-fault');
  assert.equal(classifyArmFault({ failureKind: 'provider-config-error' }), 'harness-fault');
  assert.equal(classifyArmFault({ failureKind: 'openrouter-credits-exhausted' }), 'harness-fault');
  assert.equal(classifyArmFault({ failureKind: 'native-provider-error', detail: '502 Bad Gateway' }), 'provider-fault');
  assert.equal(classifyArmFault({ failureKind: 'native-provider-error', detail: 'something else' }), 'unknown-fault');
  assert.equal(classifyArmFault({ failureKind: 'invalid-model-id' }), 'harness-fault');
});

test('classifies the HOK-2933 typed-handoff failure kinds', () => {
  // A completion-protocol violation is the model's fault: the provider
  // returned output, but the model never produced a valid completion artifact.
  assert.equal(classifyArmFault({
    failureKind: 'native-completion-protocol',
    detail: 'model emitted apply_patch as assistant text with zero structured tool calls',
  }), 'model-fault');
  assert.equal(isModelQualitySignal(classifyArmFault({ failureKind: 'native-completion-protocol' })), true);

  // Unclassified failures must stay out of the quality corpus, even when the
  // detail contains strings the native-provider-error refinement would match.
  assert.equal(classifyArmFault({ failureKind: 'native-unclassified' }), 'unknown-fault');
  assert.equal(classifyArmFault({
    failureKind: 'native-unclassified',
    detail: 'some novel agent failure mentioning upstream',
  }), 'unknown-fault');
  assert.equal(isModelQualitySignal(classifyArmFault({ failureKind: 'native-unclassified' })), false);

  assert.equal(parseAbortFailureKind('terminal_stage_failure:native-completion-protocol'), 'native-completion-protocol');
  assert.equal(parseAbortFailureKind('terminal_launch_failure:native-unclassified'), 'native-unclassified');
});

test('parses abort failure kinds and quality eligibility', () => {
  assert.equal(parseAbortFailureKind('terminal_stage_failure:tool-use-unsupported'), 'tool-use-unsupported');
  assert.equal(parseAbortFailureKind('terminal_stage_failure:empty-model-turn'), 'empty-model-turn');
  assert.equal(parseAbortFailureKind('terminal_stage_failure:context-exhausted'), 'context-exhausted');
  assert.equal(parseAbortFailureKind('terminal_launch_failure:context-window-exceeded'), 'context-window-exceeded');
  assert.equal(parseAbortFailureKind('varied_model_unresolvable'), 'varied_model_unresolvable');
  assert.equal(parseAbortFailureKind('other'), null);

  // HOK-2885: the transient-retry exhaustion reason must classify as a
  // provider fault instead of degrading to unknown-fault.
  assert.equal(parseAbortFailureKind('retry_exhausted:provider-transient-error'), 'provider-transient-error');
  assert.equal(
    classifyArmFault({ failureKind: parseAbortFailureKind('retry_exhausted:provider-transient-error') }),
    'provider-fault',
  );

  assert.equal(isModelQualitySignal('model-fault'), true);
  assert.equal(isModelQualitySignal('provider-fault'), true);
  assert.equal(isModelQualitySignal('harness-fault'), false);
  assert.equal(isModelQualitySignal('selection-fault'), false);
  assert.equal(isModelQualitySignal('unknown-fault'), false);
});

test('classifies typed native stage-failure kinds (HOK-3064)', () => {
  // A native stage timeout is recoverable provider/infrastructure failure
  // (HOK-3019). Circuits open only for provider-fault (HOK-2942), so both the
  // typed envelope kind and the review-stage category string must be eligible.
  assert.equal(classifyArmFault({ failureKind: 'native-stage-timeout' }), 'provider-fault');
  assert.equal(classifyArmFault({ failureKind: 'native-review-timeout' }), 'provider-fault');
  assert.equal(isModelQualitySignal(classifyArmFault({ failureKind: 'native-stage-timeout' })), true);
  assert.equal(isModelQualitySignal(classifyArmFault({ failureKind: 'native-review-timeout' })), true);

  // Policy denials and explicit cancellations are our own choice — never model
  // or provider quality evidence.
  assert.equal(classifyArmFault({ failureKind: 'policy-denied' }), 'harness-fault');
  assert.equal(classifyArmFault({ failureKind: 'cancelled' }), 'harness-fault');
  assert.equal(isModelQualitySignal(classifyArmFault({ failureKind: 'policy-denied' })), false);
  assert.equal(isModelQualitySignal(classifyArmFault({ failureKind: 'cancelled' })), false);
});

test('parses the typed and legacy review-timeout exhaustion reasons (HOK-3064)', () => {
  assert.equal(parseAbortFailureKind('retry_exhausted:native-review-timeout'), 'native-review-timeout');
  // Legacy literal recorded before the typed exhaustion reason existed.
  assert.equal(parseAbortFailureKind('review_timeout_exhausted'), 'native-review-timeout');
  assert.equal(
    classifyArmFault({ failureKind: parseAbortFailureKind('retry_exhausted:native-review-timeout') }),
    'provider-fault',
  );
  assert.equal(
    classifyArmFault({ failureKind: parseAbortFailureKind('review_timeout_exhausted') }),
    'provider-fault',
  );
});
