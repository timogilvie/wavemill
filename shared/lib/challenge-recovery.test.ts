import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { recoverSupersededPr, type RecoverSupersededPrOptions } from './challenge-recovery.ts';
import { WM_LABELS } from './pr-state-labels.ts';

describe('challenge-recovery', () => {
  describe('recoverSupersededPr', () => {
    it('recovers a closed superseded PR', async () => {
      const repoDir = mkdtempSync(join(tmpdir(), 'recovery-'));
      try {
        mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
        writeFileSync(
          join(repoDir, '.wavemill', 'workflow-state.json'),
          JSON.stringify({
            tasks: {
              HOK_1: {
                pr: 101,
                challengePairId: 'pair-1',
                slug: 'test-slug',
                worktree: '/test/worktree',
              },
            },
          }),
        );

        const operations: Array<{ op: string; args: unknown[] }> = [];
        const result = await recoverSupersededPr({
          prNumber: 101,
          repoDir,
          github: {
            getPullRequest: () => ({
              state: 'closed',
              labels: [{ name: WM_LABELS.superseded }],
            }),
            removeLabelFromPr: (prNumber, label) => {
              operations.push({ op: 'removeLabel', args: [prNumber, label] });
            },
            reopenPr: (prNumber) => {
              operations.push({ op: 'reopen', args: [prNumber] });
            },
            commentOnPr: (prNumber, comment) => {
              operations.push({ op: 'comment', args: [prNumber, comment.substring(0, 30)] });
            },
          },
        });

        assert.equal(result.status, 'recovered');
        assert.equal(result.prNumber, 101);
        assert.deepEqual(
          operations.map((op) => op.op),
          ['removeLabel', 'reopen', 'comment'],
        );

        // Check workflow state was updated
        const workflowState = JSON.parse(readFileSync(join(repoDir, '.wavemill', 'workflow-state.json'), 'utf-8'));
        assert.equal(workflowState.tasks.HOK_1.comparisonState, 'manual_comparison_needed');
      } finally {
        rmSync(repoDir, { recursive: true });
      }
    });

    it('skips reopening an already-open PR', async () => {
      const repoDir = mkdtempSync(join(tmpdir(), 'recovery-'));
      try {
        mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
        writeFileSync(
          join(repoDir, '.wavemill', 'workflow-state.json'),
          JSON.stringify({ tasks: { HOK_1: { pr: 101, challengePairId: 'pair-1', slug: 'test-slug', worktree: '/test/worktree' } } }),
        );

        const operations: Array<{ op: string }> = [];
        const result = await recoverSupersededPr({
          prNumber: 101,
          repoDir,
          github: {
            getPullRequest: () => ({
              state: 'open',
              labels: [{ name: WM_LABELS.superseded }],
            }),
            removeLabelFromPr: () => {
              operations.push({ op: 'removeLabel' });
            },
            reopenPr: () => {
              operations.push({ op: 'reopen' });
            },
            commentOnPr: () => {
              operations.push({ op: 'comment' });
            },
          },
        });

        assert.equal(result.status, 'recovered');
        // Should not include 'reopen' since PR is already open
        assert.deepEqual(
          operations.map((op) => op.op),
          ['removeLabel', 'comment'],
        );
      } finally {
        rmSync(repoDir, { recursive: true });
      }
    });

    it('returns not_superseded for PR without wm:superseded label', async () => {
      const repoDir = mkdtempSync(join(tmpdir(), 'recovery-'));
      try {
        const result = await recoverSupersededPr({
          prNumber: 101,
          repoDir,
          github: {
            getPullRequest: () => ({
              state: 'open',
              labels: [{ name: 'some-other-label' }],
            }),
          },
        });

        assert.equal(result.status, 'not_superseded');
      } finally {
        rmSync(repoDir, { recursive: true });
      }
    });

    it('returns not_found for non-existent PR', async () => {
      const repoDir = mkdtempSync(join(tmpdir(), 'recovery-'));
      try {
        const result = await recoverSupersededPr({
          prNumber: 999,
          repoDir,
          github: {
            getPullRequest: () => null,
          },
        });

        assert.equal(result.status, 'not_found');
      } finally {
        rmSync(repoDir, { recursive: true });
      }
    });

    it('rejects invalid PR numbers', async () => {
      const repoDir = mkdtempSync(join(tmpdir(), 'recovery-'));
      try {
        const result = await recoverSupersededPr({
          prNumber: -1,
          repoDir,
        });

        assert.equal(result.status, 'error');
        assert(result.message.includes('Invalid PR number'));
      } finally {
        rmSync(repoDir, { recursive: true });
      }
    });

    it('supports dry-run mode', async () => {
      const repoDir = mkdtempSync(join(tmpdir(), 'recovery-'));
      try {
        mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
        writeFileSync(
          join(repoDir, '.wavemill', 'workflow-state.json'),
          JSON.stringify({ tasks: { HOK_1: { pr: 101, challengePairId: 'pair-1', slug: 'test-slug', worktree: '/test/worktree' } } }),
        );

        const operations: string[] = [];
        const result = await recoverSupersededPr({
          prNumber: 101,
          repoDir,
          dryRun: true,
          github: {
            getPullRequest: () => ({
              state: 'closed',
              labels: [{ name: WM_LABELS.superseded }],
            }),
            removeLabelFromPr: () => operations.push('removeLabel'),
            reopenPr: () => operations.push('reopen'),
            commentOnPr: () => operations.push('comment'),
          },
        });

        assert.equal(result.status, 'recovered');
        assert(result.message.includes('[DRY RUN]'));
        // No operations should have been performed
        assert.deepEqual(operations, []);

        // Workflow state should not be modified
        const workflowState = JSON.parse(readFileSync(join(repoDir, '.wavemill', 'workflow-state.json'), 'utf-8'));
        assert.notEqual(workflowState.tasks.HOK_1.comparisonState, 'manual_comparison_needed');
      } finally {
        rmSync(repoDir, { recursive: true });
      }
    });

    it('handles missing workflow state gracefully', async () => {
      const repoDir = mkdtempSync(join(tmpdir(), 'recovery-'));
      try {
        mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
        // No workflow-state.json file

        const result = await recoverSupersededPr({
          prNumber: 101,
          repoDir,
          github: {
            getPullRequest: () => ({
              state: 'closed',
              labels: [{ name: WM_LABELS.superseded }],
            }),
            removeLabelFromPr: () => {},
            reopenPr: () => {},
            commentOnPr: () => {},
          },
        });

        assert.equal(result.status, 'recovered');
        // Should still recover even if workflow state update fails
      } finally {
        rmSync(repoDir, { recursive: true });
      }
    });
  });
});
