import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkGuardSource, formatGuardResult, runSourceGuard } from '../../tools/lib/source-guard.ts';
import { FAILURE_POLICY_GUARD } from './failure-policy-guard.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const patternsOf = (file: string, source: string) =>
  checkGuardSource(FAILURE_POLICY_GUARD, file, source).map((finding) => finding.pattern);

describe('failure-policy guard — parking producers', () => {
  it('flags a terminal decision literal in TS and jq', () => {
    assert.deepEqual(patternsOf('a.ts', "return { class: 'terminal', reason };\n"), ['terminal-decision-literal']);
    assert.deepEqual(patternsOf('a.sh', 'jq -n \'{"class": "terminal"}\'\n'), ['terminal-decision-literal']);
  });

  it('flags a private non-retryable classification', () => {
    assert.deepEqual(patternsOf('a.ts', "return { kind: 'auth', retryable: false };\n"), ['non-retryable-classification']);
  });

  it('flags private terminal signature tables', () => {
    assert.deepEqual(patternsOf('a.ts', 'const TERMINAL_ERROR_PATTERNS = [\n'), ['terminal-pattern-table']);
    assert.deepEqual(patternsOf('a.ts', 'export const NON_RETRYABLE_SIGNATURES: RegExp[] = [\n'), ['terminal-pattern-table']);
    assert.deepEqual(patternsOf('a.sh', 'FATAL_REVIEW_PATTERNS=(\n'), ['terminal-pattern-table']);
  });
});

describe('failure-policy guard — clean shapes', () => {
  it('ignores readers of a decision and unrelated terminal sets', () => {
    const source = [
      "if (decision.class === 'terminal') park();",
      'const decision = classifyFailure({ stage, detail });',
      "const TERMINAL_WORKFLOW_STATUSES = new Set(['merged']);",
      'const ok = { retryable: true };',
      '',
    ].join('\n');
    assert.deepEqual(patternsOf('a.ts', source), []);
    assert.deepEqual(patternsOf('a.sh', 'decision="$(failure_policy_decide "coding" "" "$detail")"\n'), []);
  });

  it('honours the allow-failure-policy suppression', () => {
    assert.deepEqual(patternsOf('a.ts', "// allow-failure-policy: provider taxonomy\nreturn { retryable: false };\n"), []);
  });
});

describe('failure-policy guard — repository', () => {
  it('passes at HEAD', () => {
    const result = runSourceGuard(FAILURE_POLICY_GUARD, repoRoot);
    assert.deepEqual(result.findings, [], formatGuardResult(FAILURE_POLICY_GUARD, result));
  });
});

// protects: retry-count-based eval forfeits cannot re-enter the pair resolver.
it('rejects eval exhaustion followed by a model forfeit', () => {
  assert.deepEqual(patternsOf('shared/lib/challenge-pair-resolver.ts',
    'if (task.evalFailed && task.evalHardFailureRetryCount >= max) {\n  return buildForfeitComparison({});\n}').sort(), ['eval-retry-forfeit', 'private-eval-retry-decision'].sort());
});

it('rejects the required retry-counter mock even without a nearby comparison writer', () => {
  assert.deepEqual(patternsOf('mock.sh', 'if [[ $retryCount -gt $MAX_RETRIES && $evalFailed == true ]]; then :; fi'), ['private-eval-retry-decision']);
});

describe('failure-policy guard — one budget-exhaustion outcome (HOK-3362)', () => {
  // protects: a stage re-growing its own budget→category switch (review's reviewFailureCategoryForStopReason)
  it('flags a private budget stop-reason switch', () => {
    assert.deepEqual(patternsOf('a.ts', "    case 'wall_clock_limit':\n"), ['private-budget-stop-switch']);
    assert.deepEqual(patternsOf('a.ts', "if (stopReason === 'turn_limit') return 'x';\n"), ['private-budget-stop-switch']);
    assert.deepEqual(patternsOf('a.ts', "if ('cost_limit' !== reason) return;\n"), ['private-budget-stop-switch']);
    assert.deepEqual(patternsOf('a.ts', "const B = new Set<LoopStopReason>(['turn_limit', 'token_limit']);\n"), ['private-budget-stop-switch']);
    assert.deepEqual(patternsOf('a.ts', 'const B = new Set<LoopStopReason>([\n'), ['private-budget-stop-switch']);
  });

  // protects: the four findFinalAssistantErrorMessage copies coming back
  it('flags a private final-assistant errorMessage scan', () => {
    assert.deepEqual(patternsOf('a.ts', 'const text = (message as AgentTurn).errorMessage?.trim();\n'), ['private-final-error-scan']);
    assert.deepEqual(patternsOf('a.ts', 'const text = (message as { errorMessage?: string }).errorMessage;\n'), ['private-final-error-scan']);
  });

  // protects: our own budget abort reaching classifyProviderError (HOK-3329 attempt 2)
  it('flags provider classification of a raw transcript without the budget rule', () => {
    const ungated = [
      'function onDone(result: LoopResult): never {',
      '  const last = result.messages.at(-1) as { errorMessage?: string };',
      '  throw new Error(classifyProviderError(last.errorMessage ?? "").kind);',
      '}',
      '',
    ].join('\n');
    assert.deepEqual(patternsOf('shared/lib/native-agent/launch-coding.ts', ungated), ['budget-stop-provider-classification']);
    // The same shape outside the native stage sources is not this check's concern.
    assert.deepEqual(patternsOf('shared/lib/other.ts', ungated), []);

    const gated = [
      'function onDone(result: LoopResult): void {',
      '  if (budgetExhaustionFromLoop(result, budget)) return;',
      '  const text = finalProviderErrorMessage(result);',
      '  if (text && result.messages.length > 0) console.log(classifyProviderError(text).kind);',
      '}',
      '',
    ].join('\n');
    assert.deepEqual(patternsOf('shared/lib/native-agent/launch-coding.ts', gated), []);
  });

  // protects: the guard flagging the one definition, readers of it, or unrelated vocabularies
  it('leaves the one definition, its readers and non-budget sets alone', () => {
    const source = [
      "if (isBudgetStopReason(result.stopReason)) return;",
      "const kind = budgetKindForStopReason(stopReason);",
      "if (budgetKindForStopReason(reason) === 'wall_clock') return 'timeout';",
      "const NON_STALL = new Set<LoopStopReason>(['aborted', 'error']);",
      "budgetStopReason = 'turn_limit';",
      '',
    ].join('\n');
    assert.deepEqual(patternsOf('a.ts', source), []);
  });

  // protects: the invariant module being scanned by its own guard
  it('treats budget-exhaustion.ts as invariant source', () => {
    assert.ok(FAILURE_POLICY_GUARD.invariantPaths.includes('shared/lib/native-agent/budget-exhaustion.ts'));
  });
});

describe('failure-policy guard — one native stage time share (HOK-3380)', () => {
  // protects: a second site re-deriving "whose time was this" with its own share arithmetic
  it('flags a private time-share division or accumulation', () => {
    assert.deepEqual(patternsOf('a.ts', 'const share = providerWaitMs / totalMs;\n'), ['private-stage-time-share']);
    assert.deepEqual(patternsOf('a.ts', 'const share = harnessToolMs / split.totalMs;\n'), ['private-stage-time-share']);
    assert.deepEqual(patternsOf('a.ts', 'const share = modelMs / wallClockMs;\n'), ['private-stage-time-share']);
    assert.deepEqual(patternsOf('a.ts', 'const toolShare = toolDurationMs / fact.progress.wallClockMs;\n'), ['private-stage-time-share']);
    assert.deepEqual(patternsOf('a.ts', 'providerWaitMs += Math.max(0, Date.now() - start);\n'), ['private-stage-time-share']);
  });

  it('leaves the split derivation and unrelated division alone', () => {
    const source = [
      'const split = nativeStageTimeSplit(events, window);',
      'const totalMs = window.toMs - window.fromMs;',
      'const average = totalCostUsd / turnsCompleted;',
      '',
    ].join('\n');
    assert.deepEqual(patternsOf('a.ts', source), []);
  });

  // protects: a second site re-pairing tool_started/tool_result by subtracting raw timestamps
  it('flags private tool-event timestamp arithmetic', () => {
    assert.deepEqual(patternsOf('a.ts', 'const duration = toolResult.timestamp - toolStarted.timestamp;\n'), ['private-tool-duration']);
    assert.deepEqual(patternsOf('a.ts', 'const ms = event.timestamp - toolStarted.timestamp;\n'), ['private-tool-duration']);
  });

  it('leaves unrelated elapsed-time arithmetic alone', () => {
    assert.deepEqual(patternsOf('a.ts', 'const elapsedMs = Date.now() - renderStartedAt;\n'), []);
  });

  // protects: the invariant module being scanned by its own guard
  it('treats stage-time-split.ts as invariant source', () => {
    assert.ok(FAILURE_POLICY_GUARD.invariantPaths.includes('shared/lib/native-agent/stage-time-split.ts'));
  });
});

describe('failure-policy guard — one escalation decision (HOK-3360)', () => {
  // protects: a raw .needs-attention writer outside the escalation step
  it('flags write_ready_attention_file / writeReadyAttention / _operator_attention_write', () => {
    assert.deepEqual(patternsOf('a.sh', 'write_ready_attention_file "$dir" "boom"\n'), ['attention-write-outside-escalation']);
    assert.deepEqual(patternsOf('a.ts', 'await writeReadyAttention(snapshot, detail);\n'), ['attention-write-outside-escalation']);
    assert.deepEqual(patternsOf('a.sh', '_operator_attention_write "$dir" "boom"\n'), ['attention-write-outside-escalation']);
  });

  // protects: a raw marker_write of .needs-attention bypassing the escalation step
  it('flags a raw marker_write / writeMarker of .needs-attention', () => {
    assert.deepEqual(patternsOf('a.sh', 'marker_write "$state_dir/.needs-attention" --kind ready-attention --head "$h"\n'), ['attention-write-outside-escalation']);
    assert.deepEqual(patternsOf('a.ts', "writeMarker({ path: '.needs-attention', kind: 'ready-attention' }, { headSha });\n"), ['attention-write-outside-escalation']);
  });

  // protects: the escalation step itself and readers/clearers of the marker are allowed
  it('leaves escalate_operator_attention and marker reads/clears alone', () => {
    const clean = [
      'escalate_operator_attention "$state_dir" exhausted stage-failure-ready "$reason"',
      'marker_clear "$state_dir/.needs-attention"',
      'if [[ -f "$state_dir/.needs-attention" ]]; then :; fi',
      '',
    ].join('\n');
    assert.deepEqual(patternsOf('a.sh', clean), []);
    assert.deepEqual(patternsOf('a.ts', "escalateOperatorAttention({ stateDir, headSha, basis, message });\nclearMarker({ path: join(d, '.needs-attention'), kind: 'ready-attention' });\n"), []);
  });

  // protects: the retired transient attention kind cannot return
  it('flags the retired .needs-attention-transient kind', () => {
    assert.deepEqual(patternsOf('a.sh', 'marker_write "$dir/.needs-attention-transient" --kind ready-attention-transient\n').sort(),
      ['attention-write-outside-escalation', 'retired-transient-attention'].sort());
    assert.deepEqual(patternsOf('a.ts', "const p = join(dir, '.needs-attention-transient');\n"), ['retired-transient-attention']);
  });

  // protects: the escalation modules are the invariant source, never scanned
  it('treats operator-escalation.{sh,ts} as invariant source', () => {
    assert.ok(FAILURE_POLICY_GUARD.invariantPaths.includes('shared/lib/operator-escalation.sh'));
    assert.ok(FAILURE_POLICY_GUARD.invariantPaths.includes('shared/lib/operator-escalation.ts'));
  });
});
