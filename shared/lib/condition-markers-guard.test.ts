import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkGuardSource, formatGuardResult, runSourceGuard } from '../../tools/lib/source-guard.ts';
import { CONDITION_MARKERS_GUARD } from './condition-markers-guard.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const patternsOf = (file: string, source: string) =>
  checkGuardSource(CONDITION_MARKERS_GUARD, file, source).map((finding) => finding.pattern);

describe('condition-markers guard — forbidden shapes', () => {
  it('flags a raw shell write of the eval-failure decision record (HOK-3452)', () => {
    assert.ok(
      patternsOf('shared/lib/scratch.sh', 'printf \'%s\\n\' "$decision" > "$fd/.eval-failure-decision.json"\n')
        .includes('raw-eval-failure-decision-write'),
    );
  });

  it('flags a raw TypeScript write of the eval-failure decision record', () => {
    assert.ok(
      patternsOf('shared/lib/scratch.ts', "writeFileSync(join(dir, '.eval-failure-decision.json'), body);\n")
        .includes('raw-eval-failure-decision-write'),
    );
  });

  it('flags a direct read of the eval-failure decision record', () => {
    assert.deepEqual(
      patternsOf('shared/lib/scratch.sh', 'cat "$fd/.eval-failure-decision.json"\n'),
      ['private-eval-failure-decision-read'],
    );
  });
});

describe('condition-markers guard — clean shapes', () => {
  it('allows a marker_write call that uses the shared filename constant', () => {
    assert.deepEqual(
      patternsOf(
        'shared/lib/wavemill-common.sh',
        // Fixture source text: the ${...} sequences are literal shell
        // expansions in the snippet under test, not TS interpolation.
        // allow-template-curly: fixture source text, not a TS interpolation
        'marker_write "${wt_dir}/features/${slug}/${EVAL_FAILURE_DECISION_MARKER}" --head "$head"\n',
      ),
      [],
    );
  });

  it('ignores whole-line comments naming the file', () => {
    assert.deepEqual(
      patternsOf('shared/lib/scratch.sh', '# printf ... > .eval-failure-decision.json is the old defect\n'),
      [],
    );
  });

  it('honours the allow-condition-markers suppression on the line and above', () => {
    assert.deepEqual(
      patternsOf(
        'shared/lib/scratch.sh',
        'cat "$fd/.eval-failure-decision.json"  # allow-condition-markers: fixture replay reads the raw record\n',
      ),
      [],
    );
  });
});

describe('condition-markers guard — repository', () => {
  it('passes at HEAD', () => {
    const result = runSourceGuard(CONDITION_MARKERS_GUARD, repoRoot);
    assert.deepEqual(result.findings, [], formatGuardResult(CONDITION_MARKERS_GUARD, result));
  });
});
