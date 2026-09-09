import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StoredChallengeComparison } from '../challenge-comparison.ts';
import type { EvalRecord } from '../eval-schema.ts';
import { loadPairContext } from './pair-context.ts';

describe('pair-context', () => {
  describe('loadPairContext', () => {
    it('loads and indexes pairs with eval records', async () => {
      const tmpdir = mkdtempSync('/tmp/pair-context-test-');
      const recordsPath = join(tmpdir, 'challenge-records.jsonl');
      const evalsPath = join(tmpdir, 'evals.jsonl');

      const record: StoredChallengeComparison = {
        challengePairId: 'pair-1',
        primaryPrUrl: 'https://github.com/owner/repo/pull/100',
        challengerPrUrl: 'https://github.com/owner/repo/pull/101',
        winner: 'primary',
        timestamp: '2026-01-01T00:00:00Z',
        dimensions: { planning: { primary: 0.8, challenger: 0.6 } },
        rationale: 'Primary is better',
        variedDimensions: {},
        challengeType: undefined,
      };

      const evalPrimary: EvalRecord = {
        prUrl: 'https://github.com/owner/repo/pull/100',
        score: 0.8,
        timestamp: '2026-01-01T00:00:00Z',
      };

      const evalChallenger: EvalRecord = {
        prUrl: 'https://github.com/owner/repo/pull/101',
        score: 0.6,
        timestamp: '2026-01-01T00:00:00Z',
      };

      writeFileSync(recordsPath, JSON.stringify(record) + '\n');
      writeFileSync(evalsPath, JSON.stringify(evalPrimary) + '\n' + JSON.stringify(evalChallenger) + '\n');

      const context = await loadPairContext(recordsPath, tmpdir);

      assert.strictEqual(context.pairs.length, 1);
      assert.strictEqual(context.pairs[0].pairId, 'pair-1');
      assert.strictEqual(context.pairs[0].record.winner, 'primary');

      // Check ledger
      assert.strictEqual(context.ledger.inputRecords, 1);
      assert.strictEqual(context.ledger.selectedPairs, 1);

      // Check that eval index is initialized (content depends on file presence)
      assert(context.evalIndex instanceof Map);
    });

    it('handles empty records', async () => {
      const tmpdir = mkdtempSync('/tmp/pair-context-test-');
      const recordsPath = join(tmpdir, 'challenge-records.jsonl');
      const evalsPath = join(tmpdir, 'evals.jsonl');

      writeFileSync(recordsPath, '');
      writeFileSync(evalsPath, '');

      const context = await loadPairContext(recordsPath, tmpdir);

      assert.strictEqual(context.pairs.length, 0);
      assert.strictEqual(context.ledger.inputRecords, 0);
      assert.strictEqual(context.ledger.selectedPairs, 0);
    });

    it('excludes non-verdict records', async () => {
      const tmpdir = mkdtempSync('/tmp/pair-context-test-');
      const recordsPath = join(tmpdir, 'challenge-records.jsonl');
      const evalsPath = join(tmpdir, 'evals.jsonl');

      const validRecord: StoredChallengeComparison = {
        challengePairId: 'pair-1',
        primaryPrUrl: 'https://github.com/owner/repo/pull/100',
        challengerPrUrl: 'https://github.com/owner/repo/pull/101',
        winner: 'primary',
        timestamp: '2026-01-01T00:00:00Z',
        dimensions: { planning: { primary: 0.8, challenger: 0.6 } },
        rationale: 'Primary is better',
        variedDimensions: {},
        challengeType: undefined,
      };

      const forfeitRecord: StoredChallengeComparison = {
        ...validRecord,
        challengePairId: 'pair-2',
        comparisonOutcome: 'forfeit',
        winner: undefined as unknown as 'primary' | 'challenger',
      };

      writeFileSync(recordsPath, JSON.stringify(validRecord) + '\n');
      writeFileSync(recordsPath, JSON.stringify(forfeitRecord) + '\n', { flag: 'a' });
      writeFileSync(evalsPath, '');

      const context = await loadPairContext(recordsPath, tmpdir);

      assert.strictEqual(context.pairs.length, 1);
      assert.strictEqual(context.ledger.inputRecords, 2);
      assert.strictEqual(context.ledger.selectedPairs, 1);
      assert.strictEqual(context.ledger.nonVerdictExcluded, 1);
    });
  });
});
