import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_PENALTIES,
  loadPenalties,
  toInterventionMeta,
  formatForJudge,
  detectSessionRedirects,
  deduplicatePostPrAndManualEdits,
  detectManualEdits,
  detectTestFixes,
  type InterventionSummary,
  type InterventionEvent,
  type InterventionPenalties,
  type PrCommit,
} from './intervention-detector.ts';
import { encodeProjectDir } from './workflow-cost.ts';

// ── Helpers for session JSONL fixtures ──────────────────────────

function userEntry(opts: { branch: string; content: string | unknown[]; sessionId?: string }): string {
  return JSON.stringify({
    type: 'user',
    userType: 'external',
    gitBranch: opts.branch,
    sessionId: opts.sessionId || 'test-session',
    message: { role: 'user', content: opts.content },
  });
}

function assistantEntry(opts: { branch: string }): string {
  return JSON.stringify({
    type: 'assistant',
    gitBranch: opts.branch,
    message: {
      role: 'assistant',
      model: 'claude-opus-4-6',
      content: [{ type: 'text', text: 'response' }],
      usage: { input_tokens: 100, output_tokens: 30 },
    },
  });
}

function toolResultContent(toolUseId: string, result: string): unknown[] {
  return [{ type: 'tool_result', tool_use_id: toolUseId, content: result }];
}

/**
 * Set up a fake ~/.claude/projects/<encoded>/ directory structure.
 * Returns the worktreePath that resolves to the temp projects dir.
 *
 * We create a temp dir that acts as ~/.claude/projects/<encoded>/
 * and use a worktree path whose encoding matches.
 */
function setupSessionDir(): { tmpHome: string; worktreePath: string; projectsDir: string; cleanup: () => void } {
  const tmpHome = mkdtempSync(join(tmpdir(), 'intervention-test-'));
  // Use a fake worktree path; we'll create the matching projects dir
  const worktreePath = join(tmpHome, 'fake-worktree');
  const encoded = encodeProjectDir(worktreePath);
  const projectsDir = join(tmpHome, '.claude', 'projects', encoded);
  mkdirSync(projectsDir, { recursive: true });

  // Patch HOME so resolveProjectsDir resolves to our temp dir
  const origHome = process.env.HOME;
  process.env.HOME = tmpHome;

  return {
    tmpHome,
    worktreePath,
    projectsDir,
    cleanup: () => {
      process.env.HOME = origHome;
      rmSync(tmpHome, { recursive: true, force: true });
    },
  };
}

describe('intervention-detector', () => {
  describe('DEFAULT_PENALTIES', () => {
    it('has expected default values', () => {
      assert.equal(DEFAULT_PENALTIES.review_comment, 0.05);
      assert.equal(DEFAULT_PENALTIES.post_pr_commit, 0.08);
      assert.equal(DEFAULT_PENALTIES.manual_edit, 0.10);
      assert.equal(DEFAULT_PENALTIES.test_fix, 0.06);
      assert.equal(DEFAULT_PENALTIES.session_redirect, 0.12);
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
          { type: 'session_redirect', count: 0, details: [] },
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
          {
            type: 'session_redirect',
            count: 1,
            details: ['I want to change the meta title instead'],
          },
        ],
        totalInterventionScore: 0.40,
      };

      const meta = toInterventionMeta(summary);
      assert.equal(meta.length, 5);

      // review_comment events should be minor severity
      assert.equal(meta[0].severity, 'minor');
      assert.ok(meta[0].description.includes('[review_comment]'));

      // post_pr_commit events should be major severity
      assert.equal(meta[2].severity, 'major');
      assert.ok(meta[2].description.includes('[post_pr_commit]'));

      // manual_edit events should be major severity
      assert.equal(meta[3].severity, 'major');
      assert.ok(meta[3].description.includes('[manual_edit]'));

      // session_redirect events should be major severity
      assert.equal(meta[4].severity, 'major');
      assert.ok(meta[4].description.includes('[session_redirect]'));
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
          { type: 'session_redirect', count: 0, details: [] },
        ],
        totalInterventionScore: 0.31,
      };

      const penalties = DEFAULT_PENALTIES;
      const text = formatForJudge(summary, penalties);
      const parsed = JSON.parse(text);

      assert.ok(Array.isArray(parsed.interventions));
      assert.equal(parsed.interventions.length, 5);
      assert.equal(parsed.totalInterventionScore, 0.31);
      assert.ok(parsed.penaltyWeights);
      assert.equal(parsed.penaltyWeights.review_comment, 0.05);
      assert.equal(parsed.penaltyWeights.session_redirect, 0.12);

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
          { type: 'session_redirect', count: 0, details: [] },
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

  describe('detectSessionRedirects', () => {
    it('returns count 0 when projects dir does not exist', () => {
      const event = detectSessionRedirects('/nonexistent/worktree', 'task/foo');
      assert.equal(event.type, 'session_redirect');
      assert.equal(event.count, 0);
      assert.equal(event.details.length, 0);
    });

    it('returns count 0 when session has only the initial task prompt', () => {
      const { worktreePath, projectsDir, cleanup } = setupSessionDir();
      try {
        const branch = 'task/my-feature';
        const lines = [
          userEntry({ branch, content: 'You are working on: My Feature (HOK-100)\n\nTask details...' }),
          assistantEntry({ branch }),
        ];
        writeFileSync(join(projectsDir, 'session1.jsonl'), lines.join('\n'));

        const event = detectSessionRedirects(worktreePath, branch);
        assert.equal(event.count, 0);
        assert.equal(event.details.length, 0);
      } finally {
        cleanup();
      }
    });

    it('returns count 0 when user messages are only tool results (array content)', () => {
      const { worktreePath, projectsDir, cleanup } = setupSessionDir();
      try {
        const branch = 'task/my-feature';
        const lines = [
          userEntry({ branch, content: 'You are working on: My Feature (HOK-100)' }),
          assistantEntry({ branch }),
          userEntry({ branch, content: toolResultContent('toolu_123', 'No matches found') }),
          assistantEntry({ branch }),
          userEntry({ branch, content: toolResultContent('toolu_456', 'file.ts:10: hello') }),
          assistantEntry({ branch }),
        ];
        writeFileSync(join(projectsDir, 'session1.jsonl'), lines.join('\n'));

        const event = detectSessionRedirects(worktreePath, branch);
        assert.equal(event.count, 0);
      } finally {
        cleanup();
      }
    });

    it('detects 1 redirect when user sends a correction after the task prompt', () => {
      const { worktreePath, projectsDir, cleanup } = setupSessionDir();
      try {
        const branch = 'task/my-feature';
        const lines = [
          userEntry({ branch, content: 'You are working on: My Feature (HOK-100)' }),
          assistantEntry({ branch }),
          userEntry({ branch, content: toolResultContent('toolu_123', 'result') }),
          assistantEntry({ branch }),
          userEntry({ branch, content: 'No, I want to change the title not the H1' }),
          assistantEntry({ branch }),
        ];
        writeFileSync(join(projectsDir, 'session1.jsonl'), lines.join('\n'));

        const event = detectSessionRedirects(worktreePath, branch);
        assert.equal(event.count, 1);
        assert.equal(event.details.length, 1);
        assert.ok(event.details[0].includes('change the title'));
      } finally {
        cleanup();
      }
    });

    it('detects multiple redirects', () => {
      const { worktreePath, projectsDir, cleanup } = setupSessionDir();
      try {
        const branch = 'task/my-feature';
        const lines = [
          userEntry({ branch, content: 'You are working on: My Feature (HOK-100)' }),
          assistantEntry({ branch }),
          userEntry({ branch, content: 'Actually change the meta title' }),
          assistantEntry({ branch }),
          userEntry({ branch, content: 'Also update the favicon while you are at it' }),
          assistantEntry({ branch }),
        ];
        writeFileSync(join(projectsDir, 'session1.jsonl'), lines.join('\n'));

        const event = detectSessionRedirects(worktreePath, branch);
        assert.equal(event.count, 2);
        assert.ok(event.details[0].includes('meta title'));
        assert.ok(event.details[1].includes('favicon'));
      } finally {
        cleanup();
      }
    });

    it('filters by branch name', () => {
      const { worktreePath, projectsDir, cleanup } = setupSessionDir();
      try {
        const targetBranch = 'task/my-feature';
        const otherBranch = 'task/other-feature';
        const lines = [
          userEntry({ branch: targetBranch, content: 'Task prompt for my-feature' }),
          assistantEntry({ branch: targetBranch }),
          userEntry({ branch: otherBranch, content: 'Task prompt for other-feature' }),
          assistantEntry({ branch: otherBranch }),
          userEntry({ branch: otherBranch, content: 'Redirect on other branch' }),
          assistantEntry({ branch: otherBranch }),
          userEntry({ branch: targetBranch, content: 'Redirect on target branch' }),
          assistantEntry({ branch: targetBranch }),
        ];
        writeFileSync(join(projectsDir, 'session1.jsonl'), lines.join('\n'));

        const event = detectSessionRedirects(worktreePath, targetBranch);
        assert.equal(event.count, 1);
        assert.ok(event.details[0].includes('Redirect on target branch'));
      } finally {
        cleanup();
      }
    });

    it('truncates long user messages to 200 chars', () => {
      const { worktreePath, projectsDir, cleanup } = setupSessionDir();
      try {
        const branch = 'task/my-feature';
        const longMessage = 'x'.repeat(500);
        const lines = [
          userEntry({ branch, content: 'Task prompt' }),
          assistantEntry({ branch }),
          userEntry({ branch, content: longMessage }),
          assistantEntry({ branch }),
        ];
        writeFileSync(join(projectsDir, 'session1.jsonl'), lines.join('\n'));

        const event = detectSessionRedirects(worktreePath, branch);
        assert.equal(event.count, 1);
        assert.equal(event.details[0].length, 200);
      } finally {
        cleanup();
      }
    });

    it('reads across multiple session files', () => {
      const { worktreePath, projectsDir, cleanup } = setupSessionDir();
      try {
        const branch = 'task/my-feature';

        // Session 1: task prompt + redirect
        const session1 = [
          userEntry({ branch, content: 'Task prompt session 1' }),
          assistantEntry({ branch }),
          userEntry({ branch, content: 'First redirect' }),
          assistantEntry({ branch }),
        ];
        writeFileSync(join(projectsDir, 'session1.jsonl'), session1.join('\n'));

        // Session 2: continuation with another redirect (no new task prompt)
        const session2 = [
          userEntry({ branch, content: 'Second redirect in session 2' }),
          assistantEntry({ branch }),
        ];
        writeFileSync(join(projectsDir, 'session2.jsonl'), session2.join('\n'));

        const event = detectSessionRedirects(worktreePath, branch);
        // First string message across all files is skipped (task prompt).
        // "First redirect" and "Second redirect in session 2" are counted.
        assert.equal(event.count, 2);
      } finally {
        cleanup();
      }
    });

    it('handles empty session files gracefully', () => {
      const { worktreePath, projectsDir, cleanup } = setupSessionDir();
      try {
        writeFileSync(join(projectsDir, 'empty.jsonl'), '');

        const event = detectSessionRedirects(worktreePath, 'task/foo');
        assert.equal(event.count, 0);
      } finally {
        cleanup();
      }
    });
  });

  describe('deduplicatePostPrAndManualEdits', () => {
    it('removes post_pr entries whose SHA also appears in manual_edit', () => {
      const postPr: InterventionEvent = {
        type: 'post_pr_commit',
        count: 2,
        details: [
          '4009eb9: fix: query compatibility',
          '320afe6: fix: csrf fallback',
        ],
      };
      const manualEdit: InterventionEvent = {
        type: 'manual_edit',
        count: 2,
        details: [
          '4009eb9: fix: query compatibility (by tim)',
          '320afe6: fix: csrf fallback (by tim)',
        ],
      };

      deduplicatePostPrAndManualEdits(postPr, manualEdit);

      assert.equal(postPr.count, 0);
      assert.equal(postPr.details.length, 0);
      // manual_edit is unchanged
      assert.equal(manualEdit.count, 2);
    });

    it('keeps post_pr entries that are NOT in manual_edit', () => {
      const postPr: InterventionEvent = {
        type: 'post_pr_commit',
        count: 2,
        details: [
          'abc1234: fix: agent post-PR fix',
          'def5678: fix: another fix',
        ],
      };
      const manualEdit: InterventionEvent = {
        type: 'manual_edit',
        count: 1,
        details: [
          'def5678: fix: another fix (by tim)',
        ],
      };

      deduplicatePostPrAndManualEdits(postPr, manualEdit);

      assert.equal(postPr.count, 1);
      assert.equal(postPr.details[0], 'abc1234: fix: agent post-PR fix');
    });

    it('is a no-op when either event has zero count', () => {
      const postPr: InterventionEvent = { type: 'post_pr_commit', count: 0, details: [] };
      const manualEdit: InterventionEvent = {
        type: 'manual_edit',
        count: 1,
        details: ['abc1234: manual fix (by tim)'],
      };

      deduplicatePostPrAndManualEdits(postPr, manualEdit);

      assert.equal(postPr.count, 0);
      assert.equal(manualEdit.count, 1);
    });

    it('is a no-op when there is no SHA overlap', () => {
      const postPr: InterventionEvent = {
        type: 'post_pr_commit',
        count: 1,
        details: ['aaa1111: agent fix'],
      };
      const manualEdit: InterventionEvent = {
        type: 'manual_edit',
        count: 1,
        details: ['bbb2222: manual fix (by tim)'],
      };

      deduplicatePostPrAndManualEdits(postPr, manualEdit);

      assert.equal(postPr.count, 1);
      assert.equal(manualEdit.count, 1);
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
          { type: 'session_redirect', count: 0, details: [] },
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
          { type: 'session_redirect', count: 0, details: [] },
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

  describe('detectManualEdits with PR commits', () => {
    it('detects non-agent commits from PR commit data', () => {
      const prCommits: PrCommit[] = [
        {
          sha: 'aaa1111222233334444',
          message: 'feat: add component\n\nCo-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>',
          author: 'timogilvie',
          date: '2026-02-20T10:00:00Z',
        },
        {
          sha: 'bbb2222333344445555',
          message: 'manual fix for styling',
          author: 'timogilvie',
          date: '2026-02-20T11:00:00Z',
        },
      ];

      const event = detectManualEdits('task/test', 'main', undefined, '42', prCommits);
      assert.equal(event.count, 1);
      assert.ok(event.details[0].includes('bbb2222'));
      assert.ok(event.details[0].includes('manual fix for styling'));
    });

    it('returns zero when all PR commits are agent commits', () => {
      const prCommits: PrCommit[] = [
        {
          sha: 'aaa1111222233334444',
          message: 'feat: add feature\n\nCo-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>',
          author: 'timogilvie',
          date: '2026-02-20T10:00:00Z',
        },
        {
          sha: 'bbb2222333344445555',
          message: 'fix: address review\n\nCo-authored-by: Claude Opus 4.6 <noreply@anthropic.com>',
          author: 'timogilvie',
          date: '2026-02-20T11:00:00Z',
        },
      ];

      const event = detectManualEdits('task/test', 'main', undefined, '42', prCommits);
      assert.equal(event.count, 0);
    });

    it('does not pick up commits from other PRs (the HOK-740 bug)', () => {
      // Only the actual PR commits are checked — no git log leakage
      const prCommits: PrCommit[] = [
        {
          sha: '6c68bc1000000000000',
          message: 'feat(web): add ProposalCard\n\nCo-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>',
          author: 'timogilvie',
          date: '2026-02-20T12:00:00Z',
        },
      ];
      // Commits from PR #135 and #136 would NOT be in prCommits — that's the fix

      const event = detectManualEdits('task/test', 'main', undefined, '137', prCommits);
      assert.equal(event.count, 0, 'Should not detect agent commit as manual edit');
    });
  });

  describe('detectTestFixes with PR commits', () => {
    it('detects test fix commits from PR commit data', () => {
      const prCommits: PrCommit[] = [
        {
          sha: 'aaa1111222233334444',
          message: 'feat: add component',
          author: 'timogilvie',
          date: '2026-02-20T10:00:00Z',
        },
        {
          sha: 'bbb2222333344445555',
          message: 'fix failing test for component',
          author: 'timogilvie',
          date: '2026-02-20T11:00:00Z',
        },
      ];

      const event = detectTestFixes('task/test', 'main', undefined, '42', prCommits);
      assert.equal(event.count, 1);
      assert.ok(event.details[0].includes('bbb2222'));
      assert.ok(event.details[0].includes('fix failing test'));
    });

    it('returns zero when no test fix patterns match', () => {
      const prCommits: PrCommit[] = [
        {
          sha: 'aaa1111222233334444',
          message: 'feat: add new feature',
          author: 'timogilvie',
          date: '2026-02-20T10:00:00Z',
        },
      ];

      const event = detectTestFixes('task/test', 'main', undefined, '42', prCommits);
      assert.equal(event.count, 0);
    });
  });
});
