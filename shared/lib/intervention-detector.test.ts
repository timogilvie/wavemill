import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PENALTIES,
  loadPenalties,
  toInterventionMeta,
  formatForJudge,
  type InterventionSummary,
  type InterventionEvent,
  type InterventionPenalties,
} from './intervention-detector.ts';

describe('intervention-detector', () => {
  describe('DEFAULT_PENALTIES', () => {
    it('has expected default values', () => {
      assert.equal(DEFAULT_PENALTIES.review_comment, 0.05);
      assert.equal(DEFAULT_PENALTIES.post_pr_commit, 0.08);
      assert.equal(DEFAULT_PENALTIES.manual_edit, 0.10);
      assert.equal(DEFAULT_PENALTIES.test_fix, 0.06);
    });
  });

  describe('loadPenalties', () => {
    it('returns defaults when no config file exists', () => {
      const penalties = loadPenalties('/nonexistent/path');
      assert.deepEqual(penalties, DEFAULT_PENALTIES);
    });
  });

  describe('toInterventionMeta', () => {
    it('returns empty array for zero interventions', () => {
      const summary: InterventionSummary = {
        interventions: [
          { type: 'review_comment', count: 0, details: [] },
          { type: 'post_pr_commit', count: 0, details: [] },
          { type: 'manual_edit', count: 0, details: [] },
          { type: 'test_fix', count: 0, details: [] },
        ],
        totalInterventionScore: 0,
      };

      const meta = toInterventionMeta(summary);
      assert.equal(meta.length, 0);
    });

    it('converts interventions to InterventionMeta with correct severity', () => {
      const summary: InterventionSummary = {
        interventions: [
          {
            type: 'review_comment',
            count: 2,
            details: ['[CHANGES_REQUESTED] alice: Fix error handling', '[INLINE] bob: Missing null check'],
          },
          {
            type: 'post_pr_commit',
            count: 1,
            details: ['abc1234: fix: address review comments'],
          },
          {
            type: 'manual_edit',
            count: 1,
            details: ['def5678: manual fix (by tim)'],
          },
          { type: 'test_fix', count: 0, details: [] },
        ],
        totalInterventionScore: 0.28,
      };

      const meta = toInterventionMeta(summary);
      assert.equal(meta.length, 4);

      // review_comment events should be minor severity
      assert.equal(meta[0].severity, 'minor');
      assert.ok(meta[0].description.includes('[review_comment]'));

      // post_pr_commit events should be major severity
      assert.equal(meta[2].severity, 'major');
      assert.ok(meta[2].description.includes('[post_pr_commit]'));

      // manual_edit events should be major severity
      assert.equal(meta[3].severity, 'major');
      assert.ok(meta[3].description.includes('[manual_edit]'));
    });
  });

  describe('formatForJudge', () => {
    it('produces valid JSON with all expected fields', () => {
      const summary: InterventionSummary = {
        interventions: [
          {
            type: 'review_comment',
            count: 3,
            details: ['comment 1', 'comment 2', 'comment 3'],
          },
          {
            type: 'post_pr_commit',
            count: 2,
            details: ['commit A', 'commit B'],
          },
          { type: 'manual_edit', count: 0, details: [] },
          { type: 'test_fix', count: 0, details: [] },
        ],
        totalInterventionScore: 0.31,
      };

      const penalties = DEFAULT_PENALTIES;
      const text = formatForJudge(summary, penalties);
      const parsed = JSON.parse(text);

      assert.ok(Array.isArray(parsed.interventions));
      assert.equal(parsed.interventions.length, 4);
      assert.equal(parsed.totalInterventionScore, 0.31);
      assert.ok(parsed.penaltyWeights);
      assert.equal(parsed.penaltyWeights.review_comment, 0.05);

      // Verify count and penaltyPerOccurrence are present
      const reviewItem = parsed.interventions.find((i: any) => i.type === 'review_comment');
      assert.equal(reviewItem.count, 3);
      assert.equal(reviewItem.penaltyPerOccurrence, 0.05);
    });

    it('produces zero-intervention output correctly', () => {
      const summary: InterventionSummary = {
        interventions: [
          { type: 'review_comment', count: 0, details: [] },
          { type: 'post_pr_commit', count: 0, details: [] },
          { type: 'manual_edit', count: 0, details: [] },
          { type: 'test_fix', count: 0, details: [] },
        ],
        totalInterventionScore: 0,
      };

      const text = formatForJudge(summary, DEFAULT_PENALTIES);
      const parsed = JSON.parse(text);

      assert.equal(parsed.totalInterventionScore, 0);
      for (const item of parsed.interventions) {
        assert.equal(item.count, 0);
        assert.equal(item.details.length, 0);
      }
    });
  });

  describe('score differentiation validation', () => {
    it('multi-intervention summary produces meaningfully higher penalty than zero', () => {
      // Scenario: 3 review comments + 2 post-PR commits = should produce >10% penalty
      const penalties = DEFAULT_PENALTIES;

      const zeroSummary: InterventionSummary = {
        interventions: [
          { type: 'review_comment', count: 0, details: [] },
          { type: 'post_pr_commit', count: 0, details: [] },
          { type: 'manual_edit', count: 0, details: [] },
          { type: 'test_fix', count: 0, details: [] },
        ],
        totalInterventionScore: 0,
      };

      // 3 review comments (0.05 each) + 2 post-PR commits (0.08 each) = 0.31
      const heavySummary: InterventionSummary = {
        interventions: [
          {
            type: 'review_comment',
            count: 3,
            details: ['comment 1', 'comment 2', 'comment 3'],
          },
          {
            type: 'post_pr_commit',
            count: 2,
            details: ['commit A', 'commit B'],
          },
          { type: 'manual_edit', count: 0, details: [] },
          { type: 'test_fix', count: 0, details: [] },
        ],
        totalInterventionScore: 3 * penalties.review_comment + 2 * penalties.post_pr_commit,
      };

      // Verify the weighted score difference is > 10% (0.10)
      const scoreDiff = heavySummary.totalInterventionScore - zeroSummary.totalInterventionScore;
      assert.ok(
        scoreDiff > 0.10,
        `Expected >10% penalty difference, got ${(scoreDiff * 100).toFixed(1)}% (${scoreDiff})`
      );

      // The actual value should be ~0.31 (floating point)
      assert.ok(
        Math.abs(heavySummary.totalInterventionScore - 0.31) < 0.001,
        `Expected ~0.31, got ${heavySummary.totalInterventionScore}`
      );

      // Verify the judge gets different input
      const zeroText = formatForJudge(zeroSummary, penalties);
      const heavyText = formatForJudge(heavySummary, penalties);
      assert.notEqual(zeroText, heavyText);

      const zeroParsed = JSON.parse(zeroText);
      const heavyParsed = JSON.parse(heavyText);
      assert.equal(zeroParsed.totalInterventionScore, 0);
      assert.ok(
        Math.abs(heavyParsed.totalInterventionScore - 0.31) < 0.001,
        `Expected ~0.31 in JSON, got ${heavyParsed.totalInterventionScore}`
      );
    });
  });
});
