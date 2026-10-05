import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyArmFault,
  isModelQualitySignal,
  parseAbortFailureKind,
  isInvalidChallengeAbort,
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

test('classifies the HOK-3129 recurring native arm-failure kinds', () => {
  // All four shapes are model-attributable: the provider delivered output but
  // the model failed to produce usable content. They used to default into
  // native-unclassified before HOK-3129 made them typed.
  assert.equal(classifyArmFault({ failureKind: 'planning-turn-limit' }), 'model-fault');
  assert.equal(classifyArmFault({ failureKind: 'planning-artifact-invalid' }), 'model-fault');
  assert.equal(classifyArmFault({ failureKind: 'review-no-output' }), 'model-fault');
  assert.equal(classifyArmFault({ failureKind: 'coding-exited-without-result' }), 'model-fault');
  for (const kind of [
    'planning-turn-limit',
    'planning-artifact-invalid',
    'review-no-output',
    'coding-exited-without-result',
  ]) {
    assert.equal(
      isModelQualitySignal(classifyArmFault({ failureKind: kind })),
      true,
      `expected ${kind} to be a model quality signal`,
    );
  }

  // The shell classifier emits a suffixed `planning-artifact-invalid:<reason>`
  // string so selection-health can attribute the structural reason without
  // enumerating every variant in the taxonomy.
  assert.equal(classifyArmFault({ failureKind: 'planning-artifact-invalid:missing_title' }), 'model-fault');
  assert.equal(classifyArmFault({ failureKind: 'planning-artifact-invalid:missing_release_readiness_env_changes' }), 'model-fault');

  // Parsed from the typical terminal_stage_failure prefix (post-HOK-3064).
  assert.equal(parseAbortFailureKind('terminal_stage_failure:planning-turn-limit'), 'planning-turn-limit');
  assert.equal(parseAbortFailureKind('terminal_stage_failure:review-no-output'), 'review-no-output');
  assert.equal(parseAbortFailureKind('terminal_stage_failure:planning-artifact-invalid:missing_title'), 'planning-artifact-invalid:missing_title');
});

test('classifies the HOK-3128 dirty-handoff and sibling-stalled kinds', () => {
  // The model finished coding but left its own output uncommitted and did not
  // repair it when relaunched: completion-protocol failure, model quality.
  assert.equal(parseAbortFailureKind('terminal_stage_failure:coding-dirty-handoff'), 'coding-dirty-handoff');
  assert.equal(classifyArmFault({ failureKind: 'coding-dirty-handoff' }), 'model-fault');
  assert.equal(isModelQualitySignal(classifyArmFault({ failureKind: 'coding-dirty-handoff' })), true);

  // The mill lost track of a no-PR arm; never proof of model quality.
  assert.equal(parseAbortFailureKind('terminal_stage_failure:sibling-stalled'), 'sibling-stalled');
  assert.equal(classifyArmFault({ failureKind: 'sibling-stalled' }), 'harness-fault');
  assert.equal(isModelQualitySignal(classifyArmFault({ failureKind: 'sibling-stalled' })), false);
});

test('classifies the HOK-3154 review-gate refusal kinds and prefixes', () => {
  // A malformed-response and genuine not_ready that cannot pass the readiness
  // gate are model-attributable (the reviewer delivered output but the model
  // failed to produce a usable verdict), parallel to review-no-output.
  assert.equal(parseAbortFailureKind('terminal_stage_failure:review-malformed-response'), 'review-malformed-response');
  assert.equal(parseAbortFailureKind('terminal_stage_failure:review-not-ready'), 'review-not-ready');
  assert.equal(classifyArmFault({ failureKind: 'review-malformed-response' }), 'model-fault');
  assert.equal(classifyArmFault({ failureKind: 'review-not-ready' }), 'model-fault');
  assert.equal(isModelQualitySignal(classifyArmFault({ failureKind: 'review-malformed-response' })), true);
  assert.equal(isModelQualitySignal(classifyArmFault({ failureKind: 'review-not-ready' })), true);
  // These are terminal forfeits, not invalid-challenge voids.
  assert.equal(isInvalidChallengeAbort('terminal_stage_failure:review-malformed-response'), false);

  // Identity mismatch and missing attribution are harness/identity failures:
  // retire as invalid_challenge, no winner, never model signal.
  assert.equal(parseAbortFailureKind('invalid_challenge:review-identity-mismatch'), 'review-identity-mismatch');
  assert.equal(parseAbortFailureKind('invalid_challenge:review-unattributed'), 'review-unattributed');
  assert.equal(classifyArmFault({ failureKind: 'review-identity-mismatch' }), 'harness-fault');
  assert.equal(classifyArmFault({ failureKind: 'review-unattributed' }), 'harness-fault');
  assert.equal(isModelQualitySignal(classifyArmFault({ failureKind: 'review-identity-mismatch' })), false);
  assert.equal(isInvalidChallengeAbort('invalid_challenge:review-identity-mismatch'), true);
  assert.equal(isInvalidChallengeAbort(' invalid_challenge:review-unattributed '), true);
});

test('classifies the HOK-3147 ready-exhausted kinds and the invalid_challenge prefix', () => {
  // Real checks stayed red after remediation: model-attributable forfeit.
  assert.equal(parseAbortFailureKind('terminal_stage_failure:ready-exhausted'), 'ready-exhausted');
  assert.equal(classifyArmFault({ failureKind: 'ready-exhausted' }), 'model-fault');
  assert.equal(isModelQualitySignal(classifyArmFault({ failureKind: 'ready-exhausted' })), true);
  assert.equal(isInvalidChallengeAbort('terminal_stage_failure:ready-exhausted'), false);

  // Checks passed but a transition (route-stamp/identity) failed: invalid
  // challenge, never model signal.
  assert.equal(parseAbortFailureKind('invalid_challenge:ready-transition-failed'), 'ready-transition-failed');
  assert.equal(classifyArmFault({ failureKind: 'ready-transition-failed' }), 'harness-fault');
  assert.equal(isModelQualitySignal(classifyArmFault({ failureKind: 'ready-transition-failed' })), false);
  assert.equal(isInvalidChallengeAbort('invalid_challenge:ready-transition-failed'), true);

  // No typed cause (conflict / missing result): invalid challenge too.
  assert.equal(parseAbortFailureKind('invalid_challenge:ready-unattributed'), 'ready-unattributed');
  assert.equal(classifyArmFault({ failureKind: 'ready-unattributed' }), 'harness-fault');
  assert.equal(isInvalidChallengeAbort('  invalid_challenge:ready-unattributed '), true);

  assert.equal(isInvalidChallengeAbort(null), false);
  assert.equal(isInvalidChallengeAbort(undefined), false);
  assert.equal(isInvalidChallengeAbort('operator_abort'), false);
});
