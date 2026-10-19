/**
 * Tests for eval-summary-printer module.
 */

import { afterEach, beforeEach, describe, test as it } from 'node:test';
import { expect } from './test-assertions.ts';
import type { EvalRecord } from './eval-schema.ts';
import {
  formatScoreDisplay,
  formatCostDisplay,
  formatInterventionDisplay,
  formatDifficultyDisplay,
  formatTaskContextDisplay,
  formatRepoContextDisplay,
  formatRouteProvenanceDisplay,
  formatWorkflowCostAmount,
  formatWorkflowCostOutcome,
  isEstimatedWorkflowCost,
  printEvalSummary,
} from './eval-summary-printer.ts';
import type { WorkflowCostAttribution } from './eval-schema.ts';

function costAttribution(overrides: Partial<WorkflowCostAttribution> = {}): WorkflowCostAttribution {
  return {
    source: 'claude',
    coverage: 'complete',
    sessions: 1,
    turns: 1,
    pricedSessions: 1,
    unpricedSessions: 0,
    models: [{ provider: 'claude', modelId: 'claude-opus-4', priced: true, pricingSource: 'local_estimate' }],
    ...overrides,
  };
}

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

    it('labels CLI subscription cost as an estimate (HOK-3076)', () => {
      expect(formatCostDisplay(0.1234, costAttribution())).toBe(', workflow cost: ~$0.1234 (estimate)');
      expect(formatCostDisplay(0.1234, costAttribution({ source: 'codex' }))).toBe(', workflow cost: ~$0.1234 (estimate)');
    });

    it('shows unavailable instead of $0 when attribution priced nothing (HOK-3076)', () => {
      expect(formatCostDisplay(undefined, costAttribution({ coverage: 'partial', pricedSessions: 0 })))
        .toBe(', workflow cost: unavailable');
    });
  });

  describe('isEstimatedWorkflowCost', () => {
    it('treats CLI harness cost as an estimate', () => {
      expect(isEstimatedWorkflowCost(costAttribution())).toBe(true);
    });

    it('treats fully provider-reported native cost as exact', () => {
      const native = costAttribution({
        source: 'native',
        models: [{ provider: 'native', modelId: 'm', priced: true, pricingSource: 'openrouter_api' }],
      });
      expect(isEstimatedWorkflowCost(native)).toBe(false);
      expect(formatWorkflowCostAmount(0.5, native)).toBe('$0.5000');
    });

    it('treats native cost with any local estimate as an estimate', () => {
      const mixed = costAttribution({
        source: 'native',
        models: [
          { provider: 'native', modelId: 'a', priced: true, pricingSource: 'openrouter_api' },
          { provider: 'native', modelId: 'b', priced: true, pricingSource: 'local_estimate' },
        ],
      });
      expect(isEstimatedWorkflowCost(mixed)).toBe(true);
    });

    it('leaves unattributed (legacy) cost unlabelled', () => {
      expect(isEstimatedWorkflowCost(undefined)).toBe(false);
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

    it('labels estimates and unavailable cost', () => {
      expect(formatWorkflowCostOutcome(0.5678, 25, 3, costAttribution()))
        .toBe('workflow cost ~$0.5678 (estimate) (25 turns across 3 session(s))');
      expect(formatWorkflowCostOutcome(undefined, 2, 1)).toBe('workflow cost unavailable (2 turns across 1 session(s))');
    });
  });

  describe('formatRouteProvenanceDisplay', () => {
    it('should return empty string when route provenance is absent', () => {
      expect(formatRouteProvenanceDisplay({} as EvalRecord)).toBe('');
    });

    it('should format active route provenance compactly', () => {
      const record = {
        routeProvenance: {
          decisionSource: 'expanded',
          activeRoute: {
            coder: 'gpt-5.4',
            codeDepth: 'deep',
            reviewer: 'claude-sonnet-5',
            reviewMode: 'static',
          },
          routeChanged: true,
        },
      } as EvalRecord;

      expect(formatRouteProvenanceDisplay(record)).toBe(
        ', route: expanded gpt-5.4/deep/claude-sonnet-5/static changed=true'
      );
    });
  });

  describe('printEvalSummary', () => {
    let consoleLogs: unknown[][];
    let originalConsoleLog: typeof console.log;

    beforeEach(() => {
      consoleLogs = [];
      originalConsoleLog = console.log;
      console.log = (...args: unknown[]) => { consoleLogs.push(args); };
    });

    afterEach(() => {
      console.log = originalConsoleLog;
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

      expect(consoleLogs).toEqual([[
        'Post-completion eval: excellent (0.95), workflow cost: $0.1234 — saved to eval store',
      ]]);
    });

    it('should print summary with route provenance', () => {
      const record: EvalRecord = {
        id: 'test-id',
        timestamp: '2026-03-02T12:00:00Z',
        score: 0.95,
        scoreBand: 'excellent',
        reasoning: 'Test reasoning',
        taskPrompt: 'Test task',
        prReviewOutput: 'Test PR',
        schemaVersion: '1.18.0',
        routeProvenance: {
          decisionSource: 'expanded',
          activeRoute: {
            coder: 'gpt-5.4',
            codeDepth: 'deep',
            reviewer: 'claude-sonnet-5',
            reviewMode: 'static',
          },
          routeChanged: true,
        },
      } as EvalRecord;

      printEvalSummary(record);

      expect(consoleLogs).toEqual([[
        'Post-completion eval: excellent (0.95), route: expanded gpt-5.4/deep/claude-sonnet-5/static changed=true — saved to eval store',
      ]]);
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

      expect(consoleLogs).toEqual([['Post-completion eval: good (0.85) — saved to eval store']]);
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

      expect(consoleLogs).toEqual([['Custom prefix: fair (0.75) — saved to eval store']]);
    });
  });
});
