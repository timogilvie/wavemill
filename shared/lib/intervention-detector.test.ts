import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_PENALTIES,
  loadPenalties,
  toInterventionMeta,
  formatForJudge,
  detectSessionRedirects,
  isWorkflowAutomationMessage,
  isWavemillManagedBranch,
  agentCommitsAsUser,
  buildPostPrCommitEvent,
  deduplicatePostPrAndManualEdits,
  detectManualEdits,
  detectTestFixes,
  detectAllInterventions,
  detectOperatorInterventions,
  detectPriorFailedAttempts,
  resolveTaskArtifactDirs,
  toInterventionRecords,
  type InterventionSummary,
  type InterventionEvent,
  type InterventionPenalties,
  type PrCommit,
} from './intervention-detector.ts';
import { clearConfigCache } from './config.ts';
import { encodeProjectDir } from './wavemill-session-paths.ts';

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

function setupDeepSeekSessionDir(): { tmpHome: string; worktreePath: string; projectsDir: string; cleanup: () => void } {
  const tmpHome = mkdtempSync(join(tmpdir(), 'intervention-deepseek-test-'));
  const worktreePath = join(tmpHome, 'fake-worktree');
  const encoded = encodeProjectDir(worktreePath);
  const projectsDir = join(
    worktreePath,
    '.wavemill',
    'runs',
    'HOK-1488',
    'providers',
    'deepseek',
    'home',
    '.claude',
    'projects',
    encoded,
  );
  mkdirSync(projectsDir, { recursive: true });

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

    it('picks up a configured unknownAttribution penalty', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'penalties-unknown-attribution-'));
      try {
        writeFileSync(
          join(tmpDir, '.wavemill-config.json'),
          JSON.stringify({ eval: { interventionPenalties: { unknownAttribution: 0.33 } } }),
          'utf-8',
        );
        clearConfigCache(tmpDir);
        const penalties = loadPenalties(tmpDir);
        assert.equal(penalties.unknown_attribution, 0.33);
      } finally {
        clearConfigCache(tmpDir);
        rmSync(tmpDir, { recursive: true, force: true });
      }
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

    it('detects redirects from DeepSeek provider-home transcripts and ignores wrong branches', () => {
      const { worktreePath, projectsDir, cleanup } = setupDeepSeekSessionDir();
      try {
        const branch = 'task/my-feature';
        const wrongBranch = 'task/other-feature';
        const lines = [
          userEntry({ branch, content: 'You are working on: My Feature (HOK-100)' }),
          assistantEntry({ branch }),
          userEntry({ branch, content: toolResultContent('toolu_123', 'result') }),
          assistantEntry({ branch }),
          userEntry({ branch, content: 'Actually prioritize the quota handling path first' }),
          assistantEntry({ branch }),
          userEntry({ branch: wrongBranch, content: 'Wrong branch redirect should be ignored' }),
          assistantEntry({ branch: wrongBranch }),
        ];
        writeFileSync(join(projectsDir, 'session1.jsonl'), lines.join('\n'));

        const event = detectSessionRedirects(worktreePath, branch);
        assert.equal(event.count, 1);
        assert.match(event.details[0], /quota handling path first/);
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

  describe('isWorkflowAutomationMessage', () => {
    it('filters phase transition context injections', () => {
      assert.equal(isWorkflowAutomationMessage('You are working on: My Feature (HOK-100)\n\nRepo worktree: /path'), true);
    });

    it('filters review phase prompt injections', () => {
      assert.equal(isWorkflowAutomationMessage('# Code Review - JSON Output Required\n\n**CRITICAL INSTRUCTION**...'), true);
    });

    it('filters Claude Code system XML wrappers', () => {
      assert.equal(isWorkflowAutomationMessage('<local-command-caveat>Caveat: The messages below...</local-command-caveat>'), true);
      assert.equal(isWorkflowAutomationMessage('<local-command-stdout>Bye!</local-command-stdout>'), true);
      assert.equal(isWorkflowAutomationMessage('<command-name>/exit</command-name>\n<command-message>exit</command-message>'), true);
    });

    it('filters slash command error responses', () => {
      assert.equal(isWorkflowAutomationMessage('Unknown skill: exit'), true);
    });

    it('filters single-word permission responses', () => {
      assert.equal(isWorkflowAutomationMessage('approved'), true);
      assert.equal(isWorkflowAutomationMessage('yes'), true);
      assert.equal(isWorkflowAutomationMessage('test'), true);
    });

    it('does NOT filter genuine human redirections', () => {
      assert.equal(isWorkflowAutomationMessage('No, I want to change the title not the H1'), false);
      assert.equal(isWorkflowAutomationMessage('Actually change the meta title'), false);
      assert.equal(isWorkflowAutomationMessage('Also update the favicon while you are at it'), false);
      assert.equal(isWorkflowAutomationMessage('Stop. Use a different approach for the database migration.'), false);
    });
  });

  describe('detectSessionRedirects with workflow automation filtering', () => {
    it('filters out workflow automation messages from redirect count', () => {
      const { worktreePath, projectsDir, cleanup } = setupSessionDir();
      try {
        const branch = 'task/my-feature';
        const lines = [
          // Initial task prompt (always skipped)
          userEntry({ branch, content: 'You are working on: My Feature (HOK-100)' }),
          assistantEntry({ branch }),
          // Workflow automation messages (should be filtered)
          userEntry({ branch, content: 'approved' }),
          assistantEntry({ branch }),
          userEntry({ branch, content: '<local-command-caveat>Caveat: The messages below...</local-command-caveat>' }),
          assistantEntry({ branch }),
          userEntry({ branch, content: '<command-name>/exit</command-name>\n<command-message>exit</command-message>' }),
          assistantEntry({ branch }),
          userEntry({ branch, content: '<local-command-stdout>Bye!</local-command-stdout>' }),
          assistantEntry({ branch }),
          userEntry({ branch, content: '# Code Review - JSON Output Required\n\n**CRITICAL INSTRUCTION**...' }),
          assistantEntry({ branch }),
          userEntry({ branch, content: 'You are working on: My Feature (HOK-100)\n\nRepo worktree: /path' }),
          assistantEntry({ branch }),
          userEntry({ branch, content: 'Unknown skill: exit' }),
          assistantEntry({ branch }),
          userEntry({ branch, content: 'test' }),
          assistantEntry({ branch }),
        ];
        writeFileSync(join(projectsDir, 'session1.jsonl'), lines.join('\n'));

        const event = detectSessionRedirects(worktreePath, branch);
        assert.equal(event.count, 0, `Expected 0 redirects but got ${event.count}: ${JSON.stringify(event.details)}`);
      } finally {
        cleanup();
      }
    });

    it('still detects genuine human redirections among automation messages', () => {
      const { worktreePath, projectsDir, cleanup } = setupSessionDir();
      try {
        const branch = 'task/my-feature';
        const lines = [
          userEntry({ branch, content: 'You are working on: My Feature (HOK-100)' }),
          assistantEntry({ branch }),
          userEntry({ branch, content: 'approved' }),
          assistantEntry({ branch }),
          userEntry({ branch, content: 'No, use a different approach for the database migration' }),
          assistantEntry({ branch }),
          userEntry({ branch, content: '<local-command-stdout>Done</local-command-stdout>' }),
          assistantEntry({ branch }),
        ];
        writeFileSync(join(projectsDir, 'session1.jsonl'), lines.join('\n'));

        const event = detectSessionRedirects(worktreePath, branch);
        assert.equal(event.count, 1);
        assert.ok(event.details[0].includes('different approach'));
      } finally {
        cleanup();
      }
    });
  });

  describe('agentCommitsAsUser', () => {
    it('covers every agent that commits under the user git identity', () => {
      // These leave no marker for isAgentCommit to recognise, so attributing
      // authorship from git metadata would read their work as human edits.
      assert.equal(agentCommitsAsUser('codex'), true);
      assert.equal(agentCommitsAsUser('native'), true);
      assert.equal(agentCommitsAsUser('native-openrouter'), true);
    });

    it('does not cover Claude, whose commits carry a Co-Authored-By trailer', () => {
      assert.equal(agentCommitsAsUser('claude'), false);
      assert.equal(agentCommitsAsUser('claude-deepseek'), false);
      assert.equal(agentCommitsAsUser(undefined), false);
    });
  });

  describe('isWavemillManagedBranch', () => {
    it('returns true when features/<slug>/selected-task.json exists', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wavemill-branch-'));
      try {
        const taskDir = join(tmpDir, 'features', 'my-feature');
        mkdirSync(taskDir, { recursive: true });
        writeFileSync(join(taskDir, 'selected-task.json'), '{}');
        assert.equal(isWavemillManagedBranch('task/my-feature', tmpDir), true);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('returns true when features/<slug>/.coding-complete exists', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wavemill-branch-'));
      try {
        const taskDir = join(tmpDir, 'features', 'my-feature');
        mkdirSync(taskDir, { recursive: true });
        writeFileSync(join(taskDir, '.coding-complete'), '');
        assert.equal(isWavemillManagedBranch('task/my-feature', tmpDir), true);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('returns true when task metadata lives in a mill worktree', () => {
      // Mill mode writes task metadata into <repo>/worktrees/<slug>/features/
      // <slug>/, not the main repo. Checking only the main repo made this
      // return false for every mill task, letting an agent's own commits be
      // flagged as human manual edits.
      const tmpDir = mkdtempSync(join(tmpdir(), 'wavemill-branch-'));
      try {
        const taskDir = join(tmpDir, 'worktrees', 'my-feature', 'features', 'my-feature');
        mkdirSync(taskDir, { recursive: true });
        writeFileSync(join(taskDir, 'selected-task.json'), '{}');
        assert.equal(isWavemillManagedBranch('task/my-feature', tmpDir), true);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('returns true when task metadata lives under configured mill.worktreeRoot', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wavemill-branch-'));
      try {
        writeFileSync(
          join(tmpDir, '.wavemill-config.json'),
          JSON.stringify({ mill: { worktreeRoot: 'custom-worktrees' } }),
          'utf-8',
        );
        clearConfigCache(tmpDir);
        const taskDir = join(tmpDir, 'custom-worktrees', 'my-feature', 'features', 'my-feature');
        mkdirSync(taskDir, { recursive: true });
        writeFileSync(join(taskDir, 'selected-task.json'), '{}');
        assert.equal(isWavemillManagedBranch('task/my-feature', tmpDir), true);
      } finally {
        clearConfigCache(tmpDir);
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('does not treat a sibling repo\'s worktree as this repo\'s', () => {
      // Worktree roots resolve relative to the repo, so a same-named slug
      // under a sibling directory must not match: claiming it does would
      // suppress real manual-edit detection on the wrong branch.
      const parent = mkdtempSync(join(tmpdir(), 'wavemill-parent-'));
      try {
        const repoDir = join(parent, 'repo');
        mkdirSync(repoDir, { recursive: true });
        const taskDir = join(parent, 'worktrees', 'my-feature', 'features', 'my-feature');
        mkdirSync(taskDir, { recursive: true });
        writeFileSync(join(taskDir, '.coding-complete'), 'confidence=high\n');
        assert.equal(isWavemillManagedBranch('task/my-feature', repoDir), false);
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    });

    it('returns false for non-task branches', () => {
      assert.equal(isWavemillManagedBranch('main'), false);
      assert.equal(isWavemillManagedBranch('develop'), false);
    });

    it('returns false when no task metadata exists', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wavemill-branch-'));
      try {
        assert.equal(isWavemillManagedBranch('task/no-such-task', tmpDir), false);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('detectManualEdits attribution on wavemill-managed branches (HOK-2894)', () => {
    // HOK-2894: a wavemill-managed branch is no longer a blanket exemption —
    // every mill task branch satisfies isWavemillManagedBranch by construction,
    // so treating it as one disabled manual-edit detection for the entire
    // fleet. These pin the replacement: window/interval-based attribution.

    it('flags an operator handoff commit as manual_edit (high) but does not flag the agent\'s own in-window commit (HOK-2769 regression pin)', () => {
      // Mirrors the HOK-2888_c timeline: coding.finishedAt is stamped only
      // after the handoff guard clears, i.e. after the operator's commit —
      // so a naive [startedAt, finishedAt] window alone would swallow it.
      const tmpDir = mkdtempSync(join(tmpdir(), 'wavemill-attribution-handoff-'));
      try {
        const featureDir = join(tmpDir, 'features', 'devstral-demo');
        mkdirSync(featureDir, { recursive: true });
        writeFileSync(join(featureDir, '.coding-result.json'), JSON.stringify({
          stage: 'coding',
          status: 'completed',
          startedAt: '2026-08-27T10:00:00Z',
          finishedAt: '2026-08-27T10:55:00Z', // stamped after the operator's 10:45 commit
          agent: 'native-openrouter',
          model: 'devstral-small',
          notes: '',
        }));
        writeFileSync(join(featureDir, '.coding-uncommitted-output.resolved.jsonl'), JSON.stringify({
          detectedAt: '2026-08-27T10:30:00Z',
          resolvedAt: '2026-08-27T10:50:00Z',
          dirtyPaths: ['src/foo.ts'],
        }) + '\n');

        const prCommits: PrCommit[] = [
          {
            sha: 'aaaaaaa1111111111111',
            message: 'wip: partial implementation', // agent commit, under the user's git identity, no trailer
            author: 'timogilvie',
            date: '2026-08-27T10:15:00Z',
          },
          {
            sha: '192f095b22222222222',
            message: 'chore: commit agent output', // operator completes the handoff
            author: 'timogilvie',
            date: '2026-08-27T10:45:00Z',
          },
        ];

        const result = detectManualEdits({
          branchName: 'task/devstral-demo',
          baseBranch: 'main',
          repoDir: tmpDir,
          prNumber: '99',
          prCommits,
          agentType: 'native-openrouter',
        });

        assert.equal(result.manualEdit.count, 1, 'Only the operator commit should be flagged');
        assert.match(result.manualEdit.details[0], /192f095/);
        assert.match(result.manualEdit.details[0], /operator handoff commit/);
        assert.equal(result.manualEdit.severities?.[0], 'high');
        assert.equal(result.unknownAttribution.count, 0);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('flags a commit outside every recorded agent activity window as manual_edit (med)', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wavemill-attribution-outside-'));
      try {
        const featureDir = join(tmpDir, 'features', 'outside-demo');
        mkdirSync(featureDir, { recursive: true });
        writeFileSync(join(featureDir, '.coding-result.json'), JSON.stringify({
          stage: 'coding',
          status: 'completed',
          startedAt: '2026-08-27T10:00:00Z',
          finishedAt: '2026-08-27T10:30:00Z',
          agent: 'codex',
          model: 'gpt-5.5-codex',
          notes: '',
        }));

        const prCommits: PrCommit[] = [
          {
            sha: 'bbbbbbb3333333333333',
            message: 'fix: typo well after coding finished',
            author: 'timogilvie',
            date: '2026-08-27T12:00:00Z', // far outside [10:00, 10:30] + grace
          },
        ];

        const result = detectManualEdits({
          branchName: 'task/outside-demo',
          baseBranch: 'main',
          repoDir: tmpDir,
          prNumber: '100',
          prCommits,
          agentType: 'codex',
        });

        assert.equal(result.manualEdit.count, 1);
        assert.match(result.manualEdit.details[0], /outside all recorded agent activity windows/);
        assert.equal(result.manualEdit.severities?.[0], 'med');
        assert.equal(result.unknownAttribution.count, 0);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('emits unknown_attribution instead of a silent zero when no stage-result data exists at all', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wavemill-managed-'));
      try {
        const taskDir = join(tmpDir, 'features', 'extract-business-logic');
        mkdirSync(taskDir, { recursive: true });
        writeFileSync(join(taskDir, '.coding-complete'), '');

        const prCommits: PrCommit[] = [
          {
            sha: '3512d7c000000000000',
            message: 'refactor: extract shared tool business logic',
            author: 'timogilvie',
            date: '2026-04-04T10:00:00Z',
          },
        ];

        const result = detectManualEdits({
          branchName: 'task/extract-business-logic',
          baseBranch: 'main',
          repoDir: tmpDir,
          prNumber: '177',
          prCommits,
        });

        assert.equal(result.manualEdit.count, 0, 'No attribution evidence — must not be silently scored as manual edit');
        assert.equal(result.unknownAttribution.count, 1, 'Must fail loud instead of a silent zero');
        assert.equal(result.unknownAttribution.severities?.[0], 'low');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('honors the 120s grace margin around a window boundary', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wavemill-attribution-grace-'));
      try {
        const featureDir = join(tmpDir, 'features', 'grace-demo');
        mkdirSync(featureDir, { recursive: true });
        writeFileSync(join(featureDir, '.coding-result.json'), JSON.stringify({
          stage: 'coding',
          status: 'running',
          startedAt: '2026-08-27T10:00:00Z',
          finishedAt: null,
          agent: 'native',
          model: 'glm-5.2',
          notes: '',
        }));

        const prCommits: PrCommit[] = [
          {
            sha: 'ccccccc4444444444444',
            message: 'setup commit just before the recorded start',
            author: 'timogilvie',
            date: '2026-08-27T09:59:00Z', // 60s before startedAt — inside AGENT_WINDOW_GRACE_MS
          },
        ];

        const result = detectManualEdits({
          branchName: 'task/grace-demo',
          baseBranch: 'main',
          repoDir: tmpDir,
          prNumber: '101',
          prCommits,
          agentType: 'native',
        });

        assert.equal(result.manualEdit.count, 0, 'Commit within the grace margin should be treated as agent-authored');
        assert.equal(result.unknownAttribution.count, 0);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('honors windows recorded in a stage result\'s history[] entries', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wavemill-attribution-history-'));
      try {
        const featureDir = join(tmpDir, 'features', 'history-demo');
        mkdirSync(featureDir, { recursive: true });
        writeFileSync(join(featureDir, '.coding-result.json'), JSON.stringify({
          stage: 'coding',
          status: 'completed',
          startedAt: '2026-08-27T14:00:00Z',
          finishedAt: '2026-08-27T14:30:00Z',
          agent: 'native',
          model: 'glm-5.2',
          notes: '',
          history: [
            {
              status: 'failed',
              startedAt: '2026-08-27T10:00:00Z',
              finishedAt: '2026-08-27T10:20:00Z',
              agent: 'native',
              model: 'glm-5.2',
              notes: 'earlier attempt',
            },
          ],
        }));

        const prCommits: PrCommit[] = [
          {
            sha: 'ddddddd5555555555555',
            message: 'commit made during the earlier failed attempt',
            author: 'timogilvie',
            date: '2026-08-27T10:10:00Z', // inside the history[] window, outside the current one
          },
        ];

        const result = detectManualEdits({
          branchName: 'task/history-demo',
          baseBranch: 'main',
          repoDir: tmpDir,
          prNumber: '102',
          prCommits,
          agentType: 'native',
        });

        assert.equal(result.manualEdit.count, 0, 'Commit inside a history[] window should be treated as agent-authored');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('reads stage results from the archived (dotless) route-artifact dir when the worktree has been reaped', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wavemill-attribution-archive-'));
      try {
        const issueId = 'HOK-9999';
        const archiveDir = join(tmpDir, '.wavemill', 'evals', 'artifacts', issueId);
        mkdirSync(archiveDir, { recursive: true });
        writeFileSync(join(archiveDir, 'coding-result.json'), JSON.stringify({
          stage: 'coding',
          status: 'completed',
          startedAt: '2026-08-27T10:00:00Z',
          finishedAt: '2026-08-27T10:30:00Z',
          agent: 'native',
          model: 'glm-5.2',
          notes: '',
        }));

        const prCommits: PrCommit[] = [
          {
            sha: 'eeeeeee6666666666666',
            message: 'commit inside the archived window',
            author: 'timogilvie',
            date: '2026-08-27T10:10:00Z',
          },
        ];

        const result = detectManualEdits({
          branchName: 'task/reaped-demo', // no features/reaped-demo dir on disk — worktree is gone
          baseBranch: 'main',
          repoDir: tmpDir,
          issueId,
          prNumber: '103',
          prCommits,
          agentType: 'native',
        });

        assert.equal(result.manualEdit.count, 0, 'Archived (dotless) stage result should still classify the commit as agent-authored');
        assert.equal(result.unknownAttribution.count, 0);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('buildPostPrCommitEvent (HOK-3245)', () => {
    it('counts operator commits after PR creation and reports agent commits separately', () => {
      const commits: PrCommit[] = [
        { sha: 'aaaaaaa1111', message: 'initial work', author: 'Tim', date: '2026-10-08T09:00:00Z' },
        { sha: 'bbbbbbb2222', message: 'fix: review remediation\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>', author: 'Tim', date: '2026-10-08T11:00:00Z' },
        { sha: 'ccccccc3333', message: 'fix: hand patch', author: 'Tim', date: '2026-10-08T12:00:00Z' },
      ];
      const event = buildPostPrCommitEvent(commits, new Date('2026-10-08T10:00:00Z'));
      assert.equal(event.type, 'post_pr_commit');
      assert.equal(event.count, 1);
      assert.equal(event.agentCount, 1);
      assert.deepEqual(event.details, ['ccccccc: fix: hand patch']);
      assert.deepEqual(event.timestamps, ['2026-10-08T12:00:00Z']);
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

      const result = detectManualEdits({ branchName: 'task/test', baseBranch: 'main', prNumber: '42', prCommits });
      assert.equal(result.manualEdit.count, 1);
      assert.ok(result.manualEdit.details[0].includes('bbb2222'));
      assert.ok(result.manualEdit.details[0].includes('manual fix for styling'));
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

      const result = detectManualEdits({ branchName: 'task/test', baseBranch: 'main', prNumber: '42', prCommits });
      assert.equal(result.manualEdit.count, 0);
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

      const result = detectManualEdits({ branchName: 'task/test', baseBranch: 'main', prNumber: '137', prCommits });
      assert.equal(result.manualEdit.count, 0, 'Should not detect agent commit as manual edit');
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

  describe('claude-deepseek agentType is treated as Claude-like', () => {
    it('detectSessionRedirects runs for claude-deepseek agentType', () => {
      const { worktreePath, projectsDir, cleanup } = setupSessionDir();
      try {
        const branch = 'task/ds-feature';
        const lines = [
          userEntry({ branch, content: 'You are working on: DS Feature (HOK-200)' }),
          assistantEntry({ branch }),
          userEntry({ branch, content: 'Redirect: change the approach' }),
          assistantEntry({ branch }),
        ];
        writeFileSync(join(projectsDir, 'session1.jsonl'), lines.join('\n'));

        // detectSessionRedirects runs for claude-deepseek (same as claude)
        const event = detectSessionRedirects(worktreePath, branch);
        assert.equal(event.type, 'session_redirect');
        assert.equal(event.count, 1);
      } finally {
        cleanup();
      }
    });
  });

  describe('operator and failed-attempt artifacts', () => {
    it('loads operator interventions from feature dirs and archive dirs', () => {
      const repo = mkdtempSync(join(tmpdir(), 'intervention-artifacts-'));
      try {
        const featureDir = join(repo, 'features', 'demo');
        mkdirSync(featureDir, { recursive: true });
        writeFileSync(join(featureDir, '.operator-intervention.json'), JSON.stringify({
          severity: 'major',
          occurredAt: '2026-08-14T13:25:00Z',
          trigger: 'native_coding_failed_invalid_artifact',
          summary: 'Relaunched after invalid artifact',
          scoringNote: 'Score as failed first attempt.',
        }));

        const dirs = resolveTaskArtifactDirs({ repoDir: repo, branchName: 'task/demo', issueId: 'HOK-1' });
        const event = detectOperatorInterventions(dirs);
        assert.equal(event.count, 1);
        assert.equal(event.severities?.[0], 'high');
        assert.match(event.details[0], /scoringNote=Score as failed first attempt/);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });

    it('counts history and sidecar failed attempts without double-counting', () => {
      const repo = mkdtempSync(join(tmpdir(), 'intervention-failed-attempts-'));
      try {
        const featureDir = join(repo, 'features', 'demo');
        mkdirSync(featureDir, { recursive: true });
        const failed = {
          stage: 'coding',
          status: 'failed',
          startedAt: '2026-08-14T12:00:00Z',
          finishedAt: '2026-08-14T12:10:00Z',
          agent: 'native',
          model: 'glm-5.2',
          notes: 'invalid artifact',
          failureReason: 'malformed result',
        };
        writeFileSync(join(featureDir, '.coding-result.json'), JSON.stringify({
          stage: 'coding',
          status: 'completed',
          startedAt: '2026-08-14T12:30:00Z',
          finishedAt: '2026-08-14T13:00:00Z',
          agent: 'native',
          model: 'glm-5.2',
          notes: '',
          history: [failed],
        }));
        writeFileSync(join(featureDir, '.coding-result.attempt-1-failed.json'), JSON.stringify(failed));

        const event = detectPriorFailedAttempts({ featureDirs: [featureDir] });
        assert.equal(event.count, 1);
        assert.match(event.details[0], /coding attempt 1 failed/);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });

    it('detects native operator recovery and prior failure as interventions', () => {
      const repo = mkdtempSync(join(tmpdir(), 'intervention-native-'));
      const oldHome = process.env.HOME;
      process.env.HOME = mkdtempSync(join(tmpdir(), 'intervention-home-'));
      try {
        const featureDir = join(repo, 'features', 'demo');
        mkdirSync(featureDir, { recursive: true });
        writeFileSync(join(featureDir, '.operator-intervention.json'), JSON.stringify({
          severity: 'major',
          occurredAt: '2026-08-14T13:25:00Z',
          trigger: 'native_coding_failed_invalid_artifact',
          summary: 'Relaunched after invalid artifact',
        }));
        writeFileSync(join(featureDir, '.coding-result.json'), JSON.stringify({
          stage: 'coding',
          status: 'completed',
          startedAt: '2026-08-14T13:30:00Z',
          finishedAt: '2026-08-14T14:00:00Z',
          agent: 'native',
          model: 'glm-5.2',
          notes: '',
          history: [{
            status: 'failed',
            startedAt: '2026-08-14T12:00:00Z',
            finishedAt: '2026-08-14T12:10:00Z',
            agent: 'native',
            model: 'glm-5.2',
            notes: 'invalid artifact',
          }],
        }));

        const summary = detectAllInterventions({
          repoDir: repo,
          branchName: 'task/demo',
          baseBranch: 'main',
          agentType: 'native',
        }, DEFAULT_PENALTIES);

        assert.equal(summary.totalInterventionScore, 0.25);
        assert.equal(summary.interventions.some((event) => event.type === 'operator_recovery'), true);
        assert.equal(summary.interventions.some((event) => event.type === 'prior_failed_attempt'), true);
        const records = toInterventionRecords(summary);
        assert.equal(records.some((record) => record.type === 'recovery' && record.severity === 'high'), true);
        assert.equal(records.some((record) => record.type === 'rollback' && record.severity === 'med'), true);
      } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(process.env.HOME || '', { recursive: true, force: true });
        process.env.HOME = oldHome;
      }
    });
  });

  describe('detectAllInterventions manual-edit gate removal (HOK-2894)', () => {
    // Previously detectAllInterventions skipped manual-edit detection outright
    // for every agentCommitsAsUser agent (codex, native*), stacking with the
    // isWavemillManagedBranch short-circuit inside detectManualEdits so no
    // operator commit on a mill branch could ever be detected. This pins that
    // both an in-window agent commit and an out-of-window operator commit are
    // now classified correctly when routed through the full orchestrator.
    it('classifies commits for a native-openrouter agent instead of skipping manual-edit detection entirely', () => {
      // No prNumber here — detectAllInterventions always re-fetches PR commits
      // for itself via the real `gh` CLI, so a real git repo with real commit
      // dates (via the git-log fallback path) is the only way to exercise
      // this end-to-end without a network dependency.
      const repo = mkdtempSync(join(tmpdir(), 'intervention-gate-removal-'));
      try {
        execSync('git init', { cwd: repo, stdio: 'ignore' });
        execSync('git config user.name "timogilvie"', { cwd: repo, stdio: 'ignore' });
        execSync('git config user.email "tim@example.com"', { cwd: repo, stdio: 'ignore' });
        writeFileSync(join(repo, 'README.md'), 'init\n');
        execSync('git add README.md', { cwd: repo, stdio: 'ignore' });
        execSync('git commit -m "init"', { cwd: repo, stdio: 'ignore' });
        execSync('git branch -M main', { cwd: repo, stdio: 'ignore' });
        execSync('git checkout -b task/gate-removal-demo', { cwd: repo, stdio: 'ignore' });

        const featureDir = join(repo, 'features', 'gate-removal-demo');
        mkdirSync(featureDir, { recursive: true });
        writeFileSync(join(featureDir, '.coding-result.json'), JSON.stringify({
          stage: 'coding',
          status: 'completed',
          startedAt: '2026-08-27T10:00:00Z',
          finishedAt: '2026-08-27T10:30:00Z',
          agent: 'native-openrouter',
          model: 'devstral-small',
          notes: '',
        }));

        const commitAt = (file: string, message: string, iso: string) => {
          writeFileSync(join(repo, file), `${message}\n`);
          execSync(`git add ${file}`, { cwd: repo, stdio: 'ignore' });
          execSync(`git commit -m "${message}"`, {
            cwd: repo,
            stdio: 'ignore',
            env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
          });
        };

        commitAt('in-window.ts', 'in-window commit under the agent identity', '2026-08-27T10:10:00Z');
        commitAt('out-of-window.ts', 'out-of-window operator commit', '2026-08-27T14:00:00Z');

        const summary = detectAllInterventions({
          repoDir: repo,
          branchName: 'task/gate-removal-demo',
          baseBranch: 'main',
          agentType: 'native-openrouter',
        }, DEFAULT_PENALTIES);

        const manualEdit = summary.interventions.find((event) => event.type === 'manual_edit');
        assert.ok(manualEdit, 'manual_edit event should be present');
        assert.equal(manualEdit!.count, 1, 'Only the out-of-window commit should be flagged');
        assert.match(manualEdit!.details[0], /out-of-window operator commit/);
        assert.match(manualEdit!.details[0], /outside all recorded agent activity windows/);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });
  });
});
