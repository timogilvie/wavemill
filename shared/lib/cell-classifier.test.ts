/**
 * Structural cell classifier coverage (HOK-3361).
 * protects: every layer/lens signal path, ambiguity-to-unknown, and the
 * no-substrate case must behave deterministically and never guess.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyCellStructural, extractCellSignals } from './cell-classifier.ts';
import type { ChangedPath } from './cell-label-contract.ts';

function changed(path: string, additions = 10, deletions = 2): ChangedPath {
  return { path, status: 'modified', additions, deletions };
}

describe('cell structural classifier', () => {
  it('protects: migration/schema substrate selects runtime x reversibility', () => {
    const outcome = classifyCellStructural([changed('shared/migrations/007-add-index.sql')]);
    assert.equal(outcome.decided, true);
    assert.equal(outcome.layer, 'runtime');
    assert.equal(outcome.lens, 'reversibility');
    assert.ok(outcome.signals.includes('migration_schema'));
  });

  it('protects: callers/config/entrypoint substrate selects wiring x correctness', () => {
    const outcome = classifyCellStructural([changed('shared/lib/routes.ts'), changed('tools/launch-coding.ts')]);
    assert.equal(outcome.decided, true);
    assert.equal(outcome.layer, 'wiring');
    assert.equal(outcome.lens, 'correctness');
  });

  it('protects: lifecycle/runtime substrate selects runtime x correctness', () => {
    const outcome = classifyCellStructural([changed('shared/lib/wavemill-monitor.sh'), changed('shared/lib/bounded-retry.sh')]);
    assert.equal(outcome.decided, true);
    assert.equal(outcome.layer, 'runtime');
    assert.equal(outcome.lens, 'correctness');
  });

  it('protects: documentation/use substrate selects use x correctness', () => {
    const outcome = classifyCellStructural([changed('docs/ready-stage.md'), changed('README.md')]);
    assert.equal(outcome.decided, true);
    assert.equal(outcome.layer, 'use');
    assert.equal(outcome.lens, 'correctness');
  });

  it('protects: an in-module edit with no structural anchor selects local_meaning x correctness', () => {
    const outcome = classifyCellStructural([changed('shared/lib/eval-formatter.ts')]);
    assert.equal(outcome.decided, true);
    assert.equal(outcome.layer, 'local_meaning');
    assert.equal(outcome.lens, 'correctness');
    assert.deepEqual(outcome.signals, ['local_code_edit']);
  });

  it('protects: security keywords in the substrate flip the lens to security', () => {
    const outcome = classifyCellStructural([changed('shared/lib/auth-token.ts')]);
    assert.equal(outcome.decided, true);
    assert.equal(outcome.lens, 'security');
  });

  it('protects: history keywords flip the lens to history', () => {
    const signals = extractCellSignals([changed('tools/szz-blame-helper.ts')]);
    assert.ok(signals.some((signal) => signal.lens === 'history'));
  });

  it('protects: reversibility keywords on a migration substrate keep reversibility', () => {
    const outcome = classifyCellStructural([changed('db/migrations/009-drop-table.sql')]);
    assert.equal(outcome.decided, true);
    assert.equal(outcome.layer, 'runtime');
    assert.equal(outcome.lens, 'reversibility');
  });

  it('protects: declarative shape-only changes (yaml/json without a structural rule) select form', () => {
    const outcome = classifyCellStructural([changed('deployment.yaml')]);
    assert.equal(outcome.decided, true);
    assert.equal(outcome.layer, 'form');
    assert.equal(outcome.lens, 'correctness');
  });

  it('protects: conflicting layer signals resolve to unknown, not a guess', () => {
    const outcome = classifyCellStructural([
      changed('docs/ready-stage.md'),
      changed('shared/lib/routes.ts'),
    ]);
    // documentation (2.5) vs config/wiring (2.5): a tie is ambiguous.
    assert.equal(outcome.decided, false);
    assert.deepEqual(outcome.reason_codes, ['ambiguous_signals']);
  });

  it('protects: an empty substrate is unknown with no_substrate, never a guessed cell', () => {
    const outcome = classifyCellStructural([]);
    assert.equal(outcome.decided, false);
    assert.deepEqual(outcome.reason_codes, ['no_substrate']);
  });

  it('protects: signal extraction is deterministic across runs', () => {
    const substrate = [changed('shared/migrations/007.sql'), changed('docs/x.md')];
    assert.deepEqual(extractCellSignals(substrate), extractCellSignals(substrate));
  });

  it('protects: a clear structural majority beats a minor counter-signal', () => {
    const outcome = classifyCellStructural([
      changed('shared/migrations/007-add-index.sql', 400, 100),
      changed('docs/ready-stage.md', 4, 1),
    ]);
    // migrations (3) vs docs (2.5): gap 0.5 > epsilon 0.25 → decided.
    assert.equal(outcome.decided, true);
    assert.equal(outcome.layer, 'runtime');
  });
});