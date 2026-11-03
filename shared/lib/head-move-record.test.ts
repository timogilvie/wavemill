/**
 * Tests for the head-move record (HOK-3370).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import os from 'node:os';

import {
  appendHeadMove,
  headMoveContributionInputs,
  lastRecordedHead,
  readHeadMoves,
  summarizeHeadMovesByStage,
  HEAD_MOVES_FILE,
} from './head-move-record.ts';

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function tmpStateDir(): string {
  const dir = mkdtempSync(join(os.tmpdir(), 'head-move-record-'));
  tempDirs.push(dir);
  return dir;
}

describe('head-move record', () => {
  it('appends and reads rows round-trip', () => {
    // protects: a recorded publication must be readable back with the same
    // identity fields (authorship summaries depend on it).
    const stateDir = tmpStateDir();
    appendHeadMove(stateDir, {
      issue: 'HOK-1',
      from: null,
      to: 'a'.repeat(40),
      stage: 'coding',
      actor: 'mill',
      kind: 'coding',
      commits: 3,
    });
    appendHeadMove(stateDir, {
      issue: 'HOK-1',
      from: 'a'.repeat(40),
      to: 'b'.repeat(40),
      stage: 'review',
      actor: 'mill',
      kind: 'review-fix',
      commits: 1,
    });

    const rows = readHeadMoves(stateDir);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].from, null);
    assert.equal(rows[0].commits, 3);
    assert.equal(rows[1].kind, 'review-fix');
    assert.equal(lastRecordedHead(stateDir), 'b'.repeat(40));
  });

  it('tolerates an absent file', () => {
    const stateDir = tmpStateDir();
    assert.deepEqual(readHeadMoves(join(stateDir, 'does-not-exist')), []);
    assert.equal(lastRecordedHead(join(stateDir, 'does-not-exist')), null);
  });

  it('skips torn and foreign lines instead of throwing', () => {
    // protects: a torn trailing line (killed writer) must never break a
    // consumer reading the record.
    const stateDir = tmpStateDir();
    appendHeadMove(stateDir, {
      issue: 'HOK-1',
      from: null,
      to: 'a'.repeat(40),
      stage: 'coding',
      actor: 'mill',
      kind: 'coding',
    });
    appendFileSync(join(stateDir, HEAD_MOVES_FILE), '{"schema":"other/v9"}\n{"torn', 'utf-8');

    const rows = readHeadMoves(stateDir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].to, 'a'.repeat(40));
  });

  it('summarizes per-stage kinds, commit counts and shas', () => {
    // protects: the comparison's authorship summary — a reviewer commit on
    // one arm must show up under the review stage with its count.
    const stateDir = tmpStateDir();
    appendHeadMove(stateDir, { issue: 'HOK-1', from: null, to: 'a'.repeat(40), stage: 'coding', actor: 'mill', kind: 'coding', commits: 2 });
    appendHeadMove(stateDir, { issue: 'HOK-1', from: 'a'.repeat(40), to: 'b'.repeat(40), stage: 'review', actor: 'mill', kind: 'review-fix', commits: 1 });
    appendHeadMove(stateDir, { issue: 'HOK-1', from: 'b'.repeat(40), to: 'c'.repeat(40), stage: 'ready', actor: 'mill', kind: 'base-merge' }); // absent count → 1

    const summary = summarizeHeadMovesByStage(readHeadMoves(stateDir));
    assert.deepEqual(summary.map((s) => s.stage), ['coding', 'review', 'ready']);
    assert.deepEqual(summary[0], { stage: 'coding', kinds: ['coding'], commits: 2, shas: ['a'.repeat(40)] });
    assert.equal(summary[1].commits, 1);
    assert.deepEqual(summary[2].kinds, ['base-merge']);
    assert.equal(summary[2].commits, 1);
  });

  it('projects authorship onto contribution-row inputs as parallel scalar arrays', () => {
    // protects: the head_moves/v1 encoding Hokusai joins on — stages, kinds
    // and counts must stay index-aligned (route_overrides/v1 pattern).
    const inputs = headMoveContributionInputs([
      { stage: 'coding', kinds: ['coding'], commits: 2, shas: ['a'.repeat(40)] },
      { stage: 'review', kinds: ['review-fix'], commits: 1, shas: ['b'.repeat(40)] },
    ]);
    assert.deepEqual(inputs, {
      head_moves_schema: 'head_moves/v1',
      head_move_stages: ['coding', 'review'],
      head_move_kinds: ['coding', 'review-fix'],
      head_move_counts: ['2', '1'],
    });
    assert.deepEqual(headMoveContributionInputs([]), {});
    assert.deepEqual(headMoveContributionInputs(undefined), {});
  });
});
