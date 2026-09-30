/**
 * Unit tests for planComparisonPrActions (HOK-3102).
 *
 * The core acceptance check: `compare-prs` never calls `gh pr merge`. Two
 * layers verify that:
 *   1. Behavioral: every planned action list is asserted to contain no
 *      `merge`-kind action across the full outcome × autoMergeWinner grid.
 *   2. Static: a source-file scan of `tools/compare-prs.ts` and
 *      `shared/lib/pr-comparison.ts` for the tokens `pr merge` / `'merge'`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  planComparisonPrActions,
  type ChallengeOutcome,
  type PlannedComparisonAction,
} from './pr-comparison-actions.ts';

const primary = { number: '101', commentBody: 'primary-comment' };
const challenger = { number: '202', commentBody: 'challenger-comment' };

function hasNoMergeAction(actions: PlannedComparisonAction[]): boolean {
  // The type union is comment|close; guard against future kinds anyway.
  return actions.every((a) => a.kind === 'comment' || a.kind === 'close');
}

test('compared, autoMergeWinner=true, primary wins: closes challenger, no merge', () => {
  const actions = planComparisonPrActions({
    outcome: 'compared',
    winner: 'primary',
    primary,
    challenger,
    autoMergeWinner: true,
    comment: false,
    winnerModel: 'foo/bar',
  });
  assert.ok(hasNoMergeAction(actions), 'no merge action allowed');
  const closes = actions.filter((a) => a.kind === 'close');
  assert.equal(closes.length, 1);
  assert.equal(closes[0].pr, challenger.number);
  const comments = actions.filter((a) => a.kind === 'comment');
  assert.equal(comments.length, 2, 'autoMergeWinner implies pair comments');
});

test('compared, autoMergeWinner=true, challenger wins: closes primary, no merge', () => {
  const actions = planComparisonPrActions({
    outcome: 'compared',
    winner: 'challenger',
    primary,
    challenger,
    autoMergeWinner: true,
    comment: false,
    winnerModel: null,
  });
  assert.ok(hasNoMergeAction(actions));
  const closes = actions.filter((a) => a.kind === 'close');
  assert.equal(closes.length, 1);
  assert.equal(closes[0].pr, primary.number);
});

test('compared, autoMergeWinner=false, comment=true: only comments, no close', () => {
  const actions = planComparisonPrActions({
    outcome: 'compared',
    winner: 'primary',
    primary,
    challenger,
    autoMergeWinner: false,
    comment: true,
  });
  assert.ok(hasNoMergeAction(actions));
  assert.equal(actions.filter((a) => a.kind === 'close').length, 0);
  assert.equal(actions.filter((a) => a.kind === 'comment').length, 2);
});

test('compared, all off: empty action list', () => {
  const actions = planComparisonPrActions({
    outcome: 'compared',
    winner: 'primary',
    primary,
    challenger,
    autoMergeWinner: false,
    comment: false,
  });
  assert.equal(actions.length, 0);
});

test('skipped-identical, autoMergeWinner=true: closes challenger, no merge', () => {
  const actions = planComparisonPrActions({
    outcome: 'skipped-identical',
    primary,
    challenger,
    autoMergeWinner: true,
    comment: false,
  });
  assert.ok(hasNoMergeAction(actions));
  const closes = actions.filter((a) => a.kind === 'close');
  assert.equal(closes.length, 1);
  assert.equal(closes[0].pr, challenger.number);
});

test('skipped-identical, comment=true only: two comments, no close', () => {
  const actions = planComparisonPrActions({
    outcome: 'skipped-identical',
    primary,
    challenger,
    autoMergeWinner: false,
    comment: true,
  });
  assert.equal(actions.filter((a) => a.kind === 'close').length, 0);
  assert.equal(actions.filter((a) => a.kind === 'comment').length, 2);
});

test('invalid outcome: no actions regardless of flags', () => {
  for (const autoMergeWinner of [true, false]) {
    for (const comment of [true, false]) {
      const actions = planComparisonPrActions({
        outcome: 'invalid',
        primary,
        challenger,
        autoMergeWinner,
        comment,
      });
      assert.equal(actions.length, 0, `invalid with autoMerge=${autoMergeWinner} comment=${comment}`);
    }
  }
});

test('inconclusive outcome: no actions regardless of flags', () => {
  for (const autoMergeWinner of [true, false]) {
    const actions = planComparisonPrActions({
      outcome: 'inconclusive',
      primary,
      challenger,
      autoMergeWinner,
      comment: true,
    });
    assert.equal(actions.length, 0);
  }
});

test('grid: no combination emits a merge action', () => {
  const outcomes: ChallengeOutcome[] = ['compared', 'skipped-identical', 'invalid', 'inconclusive'];
  const winners: ('primary' | 'challenger' | null)[] = ['primary', 'challenger', null];
  for (const outcome of outcomes) {
    for (const winner of winners) {
      for (const autoMergeWinner of [true, false]) {
        for (const comment of [true, false]) {
          const actions = planComparisonPrActions({
            outcome,
            winner,
            primary,
            challenger,
            autoMergeWinner,
            comment,
          });
          assert.ok(hasNoMergeAction(actions),
            `merge action leaked for outcome=${outcome} winner=${winner} autoMergeWinner=${autoMergeWinner} comment=${comment}: ${JSON.stringify(actions)}`);
        }
      }
    }
  }
});

test('static guard: no gh pr merge tokens in compare-prs.ts or pr-comparison-actions.ts', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const targets = [
    join(here, 'pr-comparison-actions.ts'),
    join(here, '..', '..', 'tools', 'compare-prs.ts'),
  ];
  for (const p of targets) {
    const src = readFileSync(p, 'utf-8');
    // Split into lines, strip line/block comments crudely, and search only in
    // the remaining source for the offending tokens.
    const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, '');
    const stripped = noBlock
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');
    assert.ok(
      !/gh\s+pr\s+merge/.test(stripped),
      `${p} still contains 'gh pr merge' outside comments`,
    );
    assert.ok(
      !/['"]pr['"]\s*,\s*['"]merge['"]/.test(stripped),
      `${p} still contains a 'pr','merge' gh argument list outside comments`,
    );
  }
});
