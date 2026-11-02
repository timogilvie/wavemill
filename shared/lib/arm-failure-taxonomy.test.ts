import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROVIDER_DOMINATED_WAIT_SHARE,
  STALLED_REQUEST_WAIT_SHARE,
  classifyArmFault,
  deriveBudgetExhaustionFaultClass,
  isModelQualitySignal,
  parseAbortFailureKind,
  isInvalidChallengeAbort,
} from './arm-failure-taxonomy.ts';
import type { BudgetExhaustedFact } from './native-agent/budget-exhaustion.ts';

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
  // HOK-3362: a native stage timeout's class is derived from its
  // budgetExhausted fact. Without one (historical rows) it stays unattributed,
  // so neither spelling feeds quality signal on no evidence.
  assert.equal(classifyArmFault({ failureKind: 'native-stage-timeout' }), 'unknown-fault');
  assert.equal(classifyArmFault({ failureKind: 'native-review-timeout' }), 'unknown-fault');
  assert.equal(isModelQualitySignal(classifyArmFault({ failureKind: 'native-stage-timeout' })), false);

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
  // HOK-3362: historical rows carry no budget fact, so they stay unattributed.
  assert.equal(
    classifyArmFault({ failureKind: parseAbortFailureKind('retry_exhausted:native-review-timeout') }),
    'unknown-fault',
  );
  assert.equal(
    classifyArmFault({ failureKind: parseAbortFailureKind('review_timeout_exhausted') }),
    'unknown-fault',
  );
});

test('classifies the HOK-3129 recurring native arm-failure kinds', () => {
  // These shapes are model-attributable: the provider delivered output but
  // the model failed to produce usable content. They used to default into
  // native-unclassified before HOK-3129 made them typed. (`planning-turn-limit`
  // collapsed into the one budget kind in HOK-3362; see the derivation tests.)
  assert.equal(classifyArmFault({ failureKind: 'planning-artifact-invalid' }), 'model-fault');
  assert.equal(classifyArmFault({ failureKind: 'review-no-output' }), 'model-fault');
  assert.equal(classifyArmFault({ failureKind: 'coding-exited-without-result' }), 'model-fault');
  for (const kind of [
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

test('classifies the HOK-3156 route-drift kind as a harness fault', () => {
  // Route drift is produced by re-routing after sealing, never by the model:
  // the pair voids as an invalid challenge with no winner and no forfeit.
  assert.equal(parseAbortFailureKind('invalid_challenge:route-drift'), 'route-drift');
  assert.equal(classifyArmFault({ failureKind: 'route-drift' }), 'harness-fault');
  assert.equal(isModelQualitySignal(classifyArmFault({ failureKind: 'route-drift' })), false);
  assert.equal(isInvalidChallengeAbort('invalid_challenge:route-drift'), true);
});

test('classifies the HOK-3156 multiple-varied-roles preflight collapse as a harness fault', () => {
  assert.equal(parseAbortFailureKind('invalid_challenge:multiple-varied-roles'), 'multiple-varied-roles');
  assert.equal(classifyArmFault({ failureKind: 'multiple-varied-roles' }), 'harness-fault');
  assert.equal(isModelQualitySignal(classifyArmFault({ failureKind: 'multiple-varied-roles' })), false);
  assert.equal(isInvalidChallengeAbort('invalid_challenge:multiple-varied-roles'), true);
});

// ── HOK-3362: one budget-exhaustion fault rule ─────────────────────────────

function budgetFact(
  kind: 'wall_clock' | 'turn' | 'tool_call' | 'token' | 'cost',
  progress: Partial<BudgetExhaustedFact['progress']>,
): BudgetExhaustedFact {
  const stopReason = ({
    wall_clock: 'wall_clock_limit',
    turn: 'turn_limit',
    tool_call: 'tool_call_limit',
    token: 'token_limit',
    cost: 'cost_limit',
  } as const)[kind];
  return {
    kind,
    stopReason,
    limit: 100,
    used: 100,
    progress: { turnsCompleted: 0, toolCallsExecuted: 0, wallClockMs: 1000, ...progress },
  };
}

// protects: the HOK-3329 attempts deriving different classes from the same kind of evidence
test('HOK-3329: all three attempts derive the same class from progress evidence', () => {
  const attempt1 = budgetFact('turn', { turnsCompleted: 200, toolCallsExecuted: 88, wallClockMs: 2_160_000, mutationFailures: 44 });
  const attempt2 = budgetFact('wall_clock', {
    turnsCompleted: 145,
    toolCallsExecuted: 230,
    wallClockMs: 3_600_000,
    providerWaitMs: 1_500_000,
    providerErrorRetries: 0,
    interruptedRequest: true,
  });
  const attempt3 = budgetFact('turn', { turnsCompleted: 200, toolCallsExecuted: 150, wallClockMs: 2_880_000 });
  const classes = [attempt1, attempt2, attempt3].map((fact) =>
    classifyArmFault({ failureKind: 'native-stage-timeout', budgetExhausted: fact }));
  assert.deepEqual(classes, ['model-fault', 'model-fault', 'model-fault']);
});

// protects: the derivation table drifting (provider wait vs progress rules)
test('deriveBudgetExhaustionFaultClass follows the documented table', () => {
  const rows: Array<[string, BudgetExhaustedFact | undefined, string]> = [
    [
      'rule 1: provider errors and most of the budget spent waiting',
      budgetFact('turn', { turnsCompleted: 30, toolCallsExecuted: 40, wallClockMs: 1000, providerWaitMs: 600, providerErrorRetries: 2 }),
      'provider-fault',
    ],
    [
      'rule 1 needs errors: a slow but healthy provider is the model not finishing',
      budgetFact('turn', { turnsCompleted: 30, toolCallsExecuted: 40, wallClockMs: 1000, providerWaitMs: 950, providerErrorRetries: 0 }),
      'model-fault',
    ],
    [
      'rule 2: wall clock stuck on the first request',
      budgetFact('wall_clock', { turnsCompleted: 0, toolCallsExecuted: 0, wallClockMs: 1000, providerWaitMs: 990 }),
      'provider-fault',
    ],
    [
      'rule 2 is wall-clock only',
      budgetFact('token', { turnsCompleted: 1, toolCallsExecuted: 0, wallClockMs: 1000, providerWaitMs: 990 }),
      'unknown-fault',
    ],
    [
      'rule 3: progress without provider trouble',
      budgetFact('tool_call', { turnsCompleted: 12, toolCallsExecuted: 120, wallClockMs: 1000, providerWaitMs: 100 }),
      'model-fault',
    ],
    ['rule 4: no progress, no provider evidence', budgetFact('cost', { turnsCompleted: 0, toolCallsExecuted: 0 }), 'unknown-fault'],
    ['rule 4: no fact (historical row)', undefined, 'unknown-fault'],
  ];
  for (const [name, fact, expected] of rows) {
    assert.equal(deriveBudgetExhaustionFaultClass(fact), expected, name);
    assert.equal(classifyArmFault({ failureKind: 'native-stage-timeout', budgetExhausted: fact }), expected, name);
  }
  assert.equal(PROVIDER_DOMINATED_WAIT_SHARE, 0.5);
  assert.equal(STALLED_REQUEST_WAIT_SHARE, 0.9);
});

// protects: historical spellings bypassing the one derivation
test('historical budget spellings canonicalise to the one kind and derive from the fact', () => {
  const progressing = budgetFact('turn', { turnsCompleted: 40, toolCallsExecuted: 60 });
  for (const kind of [
    'planning-turn-limit',
    'native-review-timeout',
    parseAbortFailureKind('retry_exhausted:native-review-timeout'),
    parseAbortFailureKind('terminal_stage_failure:planning-turn-limit'),
  ]) {
    assert.equal(classifyArmFault({ failureKind: kind }), 'unknown-fault', `${kind} without fact`);
    assert.equal(classifyArmFault({ failureKind: kind, budgetExhausted: progressing }), 'model-fault', `${kind} with fact`);
  }
});

// protects: a genuine provider failure being reclassified by the budget rule
test('a genuine upstream 5xx still classifies as provider-fault', () => {
  assert.equal(classifyArmFault({ failureKind: 'provider-transient-error', detail: '502 Bad Gateway' }), 'provider-fault');
  assert.equal(
    classifyArmFault({ failureKind: 'native-provider-error', detail: 'provider-transient-error: 503 service unavailable' }),
    'provider-fault',
  );
});
