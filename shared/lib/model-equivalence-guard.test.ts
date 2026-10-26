import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkGuardSource, formatGuardResult, runSourceGuard } from '../../tools/lib/source-guard.ts';
import { MODEL_EQUIVALENCE_GUARD } from './model-equivalence-guard.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTRACT = 'shared/lib/challenge-execution-contract.ts';

const patternsOf = (file: string, source: string) =>
  checkGuardSource(MODEL_EQUIVALENCE_GUARD, file, source).map((finding) => finding.pattern);

describe('model-equivalence guard — forbidden shapes', () => {
  it('flags a model-named identifier on the left of === / !== (HOK-3321)', () => {
    assert.deepEqual(patternsOf(CONTRACT, '  if (expectedModel !== routeModel) {\n'), [
      'raw-model-equality-operand-left',
      'raw-model-equality-operand-right',
    ]);
    assert.deepEqual(patternsOf(CONTRACT, 'const same = actualModel === expectedModel;\n'), [
      'raw-model-equality-operand-left',
      'raw-model-equality-operand-right',
    ]);
    assert.deepEqual(patternsOf(CONTRACT, 'if (requestedModel === expected) return;\n'), [
      'raw-model-equality-operand-left',
    ]);
  });

  it('flags a model-named identifier on the right of === / !==', () => {
    assert.deepEqual(patternsOf(CONTRACT, 'if (expected !== routeModel) {\n'), [
      'raw-model-equality-operand-right',
    ]);
    assert.deepEqual(patternsOf(CONTRACT, 'const ok = input.stageModel === challengerArm.stageModel;\n'), [
      'raw-model-equality-operand-left',
      'raw-model-equality-operand-right',
    ]);
  });

  it('only fires in the scoped challenge decision files', () => {
    assert.deepEqual(patternsOf('shared/lib/unrelated.ts', 'if (expectedModel !== routeModel) {\n'), []);
  });
});

describe('model-equivalence guard — clean shapes', () => {
  it('ignores the equivalence helper, typeof probes, and ternary field presence', () => {
    const source = [
      '  if (!challengeModelIdsEquivalent(expected, routeModel, repoDir)) {',
      "  && typeof side.expectedStageModel === 'string'",
      "...(outcome === 'primary' && primaryModel ? { winningStageModel: primaryModel } : {}),",
      '  if (expected && routeModel && !challengeModelIdsEquivalent(expected, routeModel, repoDir)) {',
      '',
    ].join('\n');
    assert.deepEqual(patternsOf(CONTRACT, source), []);
  });

  it('ignores whole-line comments naming the shape', () => {
    assert.deepEqual(patternsOf(CONTRACT, '// expectedModel !== routeModel would be the old defect\n'), []);
  });

  it('honours the allow-model-equivalence suppression on the line and above', () => {
    assert.deepEqual(
      patternsOf(CONTRACT, 'if (candidateSeal.challengerVariedModel !== sealed.challengerVariedModel) { // allow-model-equivalence: seal-identity invariance\n'),
      [],
    );
    assert.deepEqual(
      patternsOf(
        CONTRACT,
        '// allow-model-equivalence: message wording only\n  primaryArm.stageModel === challengerArm.stageModel\n',
      ),
      [],
    );
  });
});

describe('model-equivalence guard — repository', () => {
  it('passes at HEAD', () => {
    const result = runSourceGuard(MODEL_EQUIVALENCE_GUARD, repoRoot);
    assert.deepEqual(result.findings, [], formatGuardResult(MODEL_EQUIVALENCE_GUARD, result));
  });
});
