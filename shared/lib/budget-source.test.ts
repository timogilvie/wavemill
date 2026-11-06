import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCliBudget, resolveCarriedBudget } from './budget-source.ts';

// protects: HOK-3390 — eval-time budget resolution must inherit the source
// recorded on the record / route rather than relabel it.
test('resolveCarriedBudget inherits the first carrier\'s recorded source', () => {
  assert.deepEqual(
    resolveCarriedBudget([
      { constraints: { maxCostUsd: 25, budgetSource: 'default' } },
      { maxCostUsd: 9, constraints: { maxCostUsd: 9, budgetSource: 'request' } },
    ], 30),
    { maxCostUsd: 25, budgetSource: 'default' },
  );
  assert.deepEqual(
    resolveCarriedBudget([null, { maxCostUsd: 9 }], 30),
    { maxCostUsd: 9, budgetSource: 'request' },
  );
  assert.deepEqual(
    resolveCarriedBudget([{ constraints: { maxCostUsd: 0, budgetSource: 'repo-config' } }], undefined),
    { maxCostUsd: 0, budgetSource: 'repo-config' },
  );
});

// protects: HOK-3390 — with nothing carried, a configured default is repo-config
// only when the caller says so (else 'default'), and an absent one is missing.
test('resolveCarriedBudget falls back to repo-config, then null', () => {
  assert.deepEqual(resolveCarriedBudget([{ maxCostUsd: null }], 12, 'repo-config'), { maxCostUsd: 12, budgetSource: 'repo-config' });
  assert.deepEqual(resolveCarriedBudget([{ maxCostUsd: null }], 12), { maxCostUsd: 12, budgetSource: 'default' });
  assert.equal(resolveCarriedBudget([undefined, { constraints: null }], undefined), null);
  assert.deepEqual(
    resolveCarriedBudget([{ constraints: { maxCostUsd: 5, budgetSource: 'bogus' } }], undefined),
    { maxCostUsd: 5, budgetSource: 'request' },
  );
});

// protects: HOK-3390 — the mill passes --budget-source repo-config with its
// configured default; a typo must fail loudly instead of recording `request`.
test('parseCliBudget validates --max-cost and --budget-source', () => {
  assert.deepEqual(parseCliBudget({}), {});
  assert.deepEqual(parseCliBudget({ 'max-cost': '7.5' }), { maxCostUsd: 7.5 });
  assert.deepEqual(
    parseCliBudget({ 'max-cost': '25', 'budget-source': 'repo-config' }),
    { maxCostUsd: 25, budgetSource: 'repo-config' },
  );
  assert.deepEqual(parseCliBudget({ 'budget-source': 'repo-config' }), {});
  assert.throws(() => parseCliBudget({ 'max-cost': '-1' }), /non-negative/);
  assert.throws(() => parseCliBudget({ 'max-cost': '5', 'budget-source': 'config' }), /must be one of/);
});
