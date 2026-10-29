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
    'if (task.evalFailed && task.evalHardFailureRetryCount >= max) {\n  return buildForfeitComparison({});\n}'), ['eval-retry-forfeit']);
});
