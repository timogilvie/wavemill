/**
 * Tests for eval-summary-printer module.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EvalRecord } from './eval-schema.ts';
import {
  formatScoreDisplay,
  formatCostDisplay,
  formatInterventionDisplay,
  formatDifficultyDisplay,
  formatTaskContextDisplay,
  formatRepoContextDisplay,
  formatWorkflowCostOutcome,
  printEvalSummary,
} from './eval-summary-printer.ts';

describe('eval-summary-printer', () => {
  describe('formatScoreDisplay', () => {
    it('should format score with band', () => {
      expect(formatScoreDisplay(0.95, 'excellent')).toBe('excellent (0.95)');
    });

    it('should round to 2 decimal places', () => {
      expect(formatScoreDisplay(0.8567, 'good')).toBe('good (0.86)');
    });

    it('should handle zero score', () => {
      expect(formatScoreDisplay(0, 'poor')).toBe('poor (0.00)');
    });
  });

  describe('formatCostDisplay', () => {
    it('should format cost with 4 decimal places', () => {
      expect(formatCostDisplay(0.1234)).toBe(', workflow cost: $0.1234');
    });

    it('should handle small costs', () => {
      expect(formatCostDisplay(0.0001)).toBe(', workflow cost: $0.0001');
    });

    it('should return empty string when cost is undefined', () => {
      expect(formatCostDisplay(undefined)).toBe('');
    });

    it('should handle zero cost', () => {
      expect(formatCostDisplay(0)).toBe(', workflow cost: $0.0000');
    });
  });

  describe('formatInterventionDisplay', () => {
    it('should format single intervention', () => {
      expect(formatInterventionDisplay(1)).toBe('1 intervention(s) detected');
    });

    it('should format multiple interventions', () => {
      expect(formatInterventionDisplay(5)).toBe('5 intervention(s) detected');
    });

    it('should handle no interventions', () => {
      expect(formatInterventionDisplay(0)).toBe('no interventions detected');
    });
  });

  describe('formatDifficultyDisplay', () => {
    it('should format difficulty info', () => {
      const result = formatDifficultyDisplay('medium', 150, 5, 'stratum-2', false);
      expect(result).toBe('difficulty medium (150 LOC, 5 files, stratum: stratum-2)');
    });

    it('should include uncertain warning when diff is uncertain', () => {
      const result = formatDifficultyDisplay('hard', 300, 10, 'stratum-3', true);
      expect(result).toContain('⚠ UNCERTAIN — diff may be incomplete');
    });
  });

  describe('formatTaskContextDisplay', () => {
    it('should format task context info', () => {
      const result = formatTaskContextDisplay('feature', 'new-feature', 'medium');
      expect(result).toBe('task context feature / new-feature / complexity medium');
    });

    it('should handle bug type', () => {
      const result = formatTaskContextDisplay('bug', 'bugfix', 'low');
      expect(result).toBe('task context bug / bugfix / complexity low');
    });
  });

  describe('formatRepoContextDisplay', () => {
    it('should format repo context info', () => {
      const result = formatRepoContextDisplay('TypeScript', 'private', 100);
      expect(result).toBe('repo context TypeScript / private / 100 files');
    });

    it('should handle public repos', () => {
      const result = formatRepoContextDisplay('JavaScript', 'public', 50);
      expect(result).toBe('repo context JavaScript / public / 50 files');
    });
  });

  describe('formatWorkflowCostOutcome', () => {
    it('should format cost outcome with single session', () => {
      const result = formatWorkflowCostOutcome(0.1234, 10, 1);
      expect(result).toBe('workflow cost $0.1234 (10 turns across 1 session(s))');
    });

    it('should format cost outcome with multiple sessions', () => {
      const result = formatWorkflowCostOutcome(0.5678, 25, 3);
      expect(result).toBe('workflow cost $0.5678 (25 turns across 3 session(s))');
    });
  });

  describe('printEvalSummary', () => {
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleLogSpy.mockRestore();
    });

    it('should print summary with cost', () => {
      const record: EvalRecord = {
        id: 'test-id',
        timestamp: '2026-03-02T12:00:00Z',
        score: 0.95,
        scoreBand: 'excellent',
        reasoning: 'Test reasoning',
        taskPrompt: 'Test task',
        prReviewOutput: 'Test PR',
        schemaVersion: '1.0.0',
        workflowCost: 0.1234,
      } as EvalRecord;

      printEvalSummary(record);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        'Post-completion eval: excellent (0.95), workflow cost: $0.1234 — saved to eval store'
      );
    });

    it('should print summary without cost', () => {
      const record: EvalRecord = {
        id: 'test-id',
        timestamp: '2026-03-02T12:00:00Z',
        score: 0.85,
        scoreBand: 'good',
        reasoning: 'Test reasoning',
        taskPrompt: 'Test task',
        prReviewOutput: 'Test PR',
        schemaVersion: '1.0.0',
      } as EvalRecord;

      printEvalSummary(record);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        'Post-completion eval: good (0.85) — saved to eval store'
      );
    });

    it('should use custom prefix', () => {
      const record: EvalRecord = {
        id: 'test-id',
        timestamp: '2026-03-02T12:00:00Z',
        score: 0.75,
        scoreBand: 'fair',
        reasoning: 'Test reasoning',
        taskPrompt: 'Test task',
        prReviewOutput: 'Test PR',
        schemaVersion: '1.0.0',
      } as EvalRecord;

      printEvalSummary(record, 'Custom prefix');

      expect(consoleLogSpy).toHaveBeenCalledWith(
        'Custom prefix: fair (0.75) — saved to eval store'
      );
    });
  });
});
