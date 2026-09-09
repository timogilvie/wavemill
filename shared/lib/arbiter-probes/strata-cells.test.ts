import { describe, it } from 'node:test';
import assert from 'node:assert';
import { groupSuccessCells, createCell } from './strata-cells.ts';

describe('strata-cells', () => {
  describe('groupSuccessCells', () => {
    it('groups and aggregates by key function', () => {
      const items = [
        { id: 'a', category: 'cat1', success: true },
        { id: 'b', category: 'cat1', success: false },
        { id: 'c', category: 'cat2', success: true },
        { id: 'd', category: 'cat2', success: true },
      ];

      const result = groupSuccessCells(
        items,
        (item) => item.category,
        (item) => item.success,
      );

      assert.strictEqual(Object.keys(result).length, 2);
      assert.strictEqual(result.cat1.n, 2);
      assert.strictEqual(result.cat1.successes, 1);
      assert.strictEqual(result.cat2.n, 2);
      assert.strictEqual(result.cat2.successes, 2);
    });

    it('sorts output keys alphabetically', () => {
      const items = [
        { stratum: 'zebra', success: true },
        { stratum: 'apple', success: false },
        { stratum: 'banana', success: true },
      ];

      const result = groupSuccessCells(
        items,
        (item) => item.stratum,
        () => true,
      );

      const keys = Object.keys(result);
      assert.deepStrictEqual(keys, ['apple', 'banana', 'zebra']);
    });

    it('computes rate and CI for each cell', () => {
      const items = [
        { id: '1', success: true },
        { id: '2', success: true },
        { id: '3', success: false },
      ];

      const result = groupSuccessCells(
        items,
        () => 'all',
        (item) => item.success,
      );

      const cell = result.all;
      assert.strictEqual(cell.n, 3);
      assert.strictEqual(cell.successes, 2);
      assert(cell.rate !== null);
      assert(cell.rate > 0.5 && cell.rate < 1.0); // Roughly 2/3
      assert(cell.ci95.lo !== null && cell.ci95.hi !== null);
      assert(cell.ci95.lo < cell.rate!);
      assert(cell.ci95.hi > cell.rate!);
    });

    it('handles empty input', () => {
      const result = groupSuccessCells([], () => 'key', () => true);
      assert.deepStrictEqual(result, {});
    });
  });

  describe('createCell', () => {
    it('creates a cell from counts', () => {
      const cell = createCell(7, 10);
      assert.strictEqual(cell.n, 10);
      assert.strictEqual(cell.successes, 7);
      assert(cell.rate !== null);
      assert(cell.rate > 0.6 && cell.rate < 0.8);
      assert(cell.ci95.lo !== null && cell.ci95.hi !== null);
    });

    it('handles perfect agreement', () => {
      const cell = createCell(5, 5);
      assert.strictEqual(cell.successes, 5);
      assert.strictEqual(cell.n, 5);
      assert(cell.rate === 1.0);
    });

    it('handles zero successes', () => {
      const cell = createCell(0, 5);
      assert.strictEqual(cell.successes, 0);
      assert(cell.rate === 0.0);
    });
  });
});
